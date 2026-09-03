#!/usr/bin/env bash
set -Eeuo pipefail

# Exercise both container contracts against a locally built image. The hosted
# case uses the image's raw upstream/proxy.mjs; the external case uses only the
# local fixture below and must not create an upstream child.

IMAGE=${1:-}
if [[ -z "$IMAGE" ]]; then
  printf 'usage: %s IMAGE\n' "$0" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  printf 'container smoke not run: docker is unavailable\n' >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  printf 'container smoke not run: curl is unavailable\n' >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  printf 'container smoke not run: node is unavailable\n' >&2
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  printf 'container smoke not run: Docker daemon is unavailable\n' >&2
  exit 2
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  printf 'container smoke not run: image does not exist: %s\n' "$IMAGE" >&2
  exit 2
fi

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ccpm-container-smoke.XXXXXX")
MOCK_LOG="$TMP_DIR/external-upstream.log"
MOCK_PID=""
MOCK_PORT=""
ACTIVE_CONTAINER=""
ACTIVE_VOLUME=""
ACTIVE_PIDS=()
BASE_URL=""
CURRENT_HEALTH_FILE=""
CURRENT_TOP_FILE=""
PASS=0

ok() {
  PASS=$((PASS + 1))
  printf 'ok: %s\n' "$*"
}

fail() {
  printf 'container smoke FAILED: %s\n' "$*" >&2
  if [[ -n "$ACTIVE_CONTAINER" ]]; then
    docker logs "$ACTIVE_CONTAINER" >&2 || true
    docker top "$ACTIVE_CONTAINER" >&2 || true
  fi
  if [[ -f "$MOCK_LOG" ]]; then
    printf '%s\n' '--- external fixture log ---' >&2
    sed -n '1,160p' "$MOCK_LOG" >&2 || true
  fi
  exit 1
}

cleanup() {
  local status=$?
  set +e
  if [[ -n "$ACTIVE_CONTAINER" ]]; then
    docker rm -f "$ACTIVE_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ -n "$ACTIVE_VOLUME" ]]; then
    docker volume rm "$ACTIVE_VOLUME" >/dev/null 2>&1 || true
  fi
  if [[ -n "$MOCK_PID" ]]; then
    if kill -0 "$MOCK_PID" >/dev/null 2>&1; then
      kill "$MOCK_PID" >/dev/null 2>&1 || true
    fi
    wait "$MOCK_PID" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$TMP_DIR"
  exit "$status"
}
trap cleanup EXIT

allocate_port() {
  node --input-type=module -e '
    import net from "node:net";
    const server = net.createServer();
    server.once("error", (error) => { console.error(error.message); process.exit(1); });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      process.stdout.write(String(typeof address === "object" && address ? address.port : 0));
      server.close(() => process.exit(0));
    });
  '
}

start_external_fixture() {
  node "$ROOT_DIR/scripts/container-smoke-upstream.mjs" >"$MOCK_LOG" 2>&1 &
  MOCK_PID=$!
  for _ in $(seq 1 100); do
    if [[ -s "$MOCK_LOG" ]]; then
      MOCK_PORT=$(sed -n 's/^SMOKE_UPSTREAM_PORT=\([0-9][0-9]*\)$/\1/p' "$MOCK_LOG" | head -n 1)
      [[ -n "$MOCK_PORT" ]] && break
    fi
    if ! kill -0 "$MOCK_PID" >/dev/null 2>&1; then
      fail 'external fixture exited before listening'
    fi
    sleep 0.05
  done
  [[ "$MOCK_PORT" =~ ^[0-9]+$ ]] || fail 'external fixture did not publish a port'
  local status
  status=$(curl --silent --show-error --connect-timeout 1 --max-time 3 \
    -o "$TMP_DIR/fixture-health.body" -w '%{http_code}' \
    "http://127.0.0.1:$MOCK_PORT/health" || true)
  [[ "$status" == 200 && $(<"$TMP_DIR/fixture-health.body") == OK ]] || fail 'external fixture health check failed'
  ok "local external fixture ready on port $MOCK_PORT"
}

start_container() {
  local mode=$1
  local upstream_port=$2
  ACTIVE_CONTAINER="ccpm-smoke-${mode}-${BASHPID}-${RANDOM}"
  ACTIVE_VOLUME="ccpm-smoke-${mode}-${BASHPID}-${RANDOM}"
  if docker container inspect "$ACTIVE_CONTAINER" >/dev/null 2>&1; then
    fail "generated Docker container name already exists: $ACTIVE_CONTAINER"
  fi
  if docker volume inspect "$ACTIVE_VOLUME" >/dev/null 2>&1; then
    fail "generated Docker volume name already exists: $ACTIVE_VOLUME"
  fi
  docker volume create "$ACTIVE_VOLUME" >/dev/null || fail "cannot create isolated volume for $mode"

  local quota_base="http://host.docker.internal:$MOCK_PORT"
  local -a args=(
    run -d
    --name "$ACTIVE_CONTAINER"
    --publish 127.0.0.1::3080/tcp
    --add-host host.docker.internal:host-gateway
    --mount "type=volume,source=$ACTIVE_VOLUME,target=/data"
    --env ADMIN_TOKEN=smoke-admin-token
    --env CLIENT_TOKEN=smoke-client-token
    --env HOST=0.0.0.0
    --env UPSTREAM_PORT="$upstream_port"
    --env CC_API_BASE="$quota_base"
    --env CC_QUOTA_BASE="$quota_base"
    --env CC_USE_PROVIDER_MODELS=false
  )
  if [[ "$mode" == hosted ]]; then
    args+=(
      --env EMBED_UPSTREAM=1
      --env UPSTREAM_HOST=127.0.0.1
    )
  else
    args+=(
      --env EMBED_UPSTREAM=0
      --env UPSTREAM_HOST=host.docker.internal
    )
  fi
  args+=("$IMAGE")
  if ! docker "${args[@]}" >"$TMP_DIR/$mode.container-id"; then
    fail "$mode container did not start"
  fi
}

wait_for_manager() {
  local mode=$1
  BASE_URL=""
  CURRENT_HEALTH_FILE="$TMP_DIR/$mode.manager-health.body"
  : >"$CURRENT_HEALTH_FILE"
  for _ in $(seq 1 80); do
    local mapping host_port status state
    mapping=$(docker port "$ACTIVE_CONTAINER" 3080/tcp 2>/dev/null | head -n 1 || true)
    if [[ "$mapping" =~ :([0-9]+)$ ]]; then
      host_port=${BASH_REMATCH[1]}
      BASE_URL="http://127.0.0.1:$host_port"
      status=$(curl --silent --show-error --connect-timeout 1 --max-time 3 \
        -o "$CURRENT_HEALTH_FILE" -w '%{http_code}' "$BASE_URL/health" || true)
      if [[ "$status" == 200 && $(<"$CURRENT_HEALTH_FILE") == OK ]]; then
        ok "$mode manager /health"
        return
      fi
    fi
    state=$(docker inspect --format '{{.State.Status}}' "$ACTIVE_CONTAINER" 2>/dev/null || true)
    if [[ "$state" == exited || "$state" == dead ]]; then
      fail "$mode manager stopped before /health became ready"
    fi
    sleep 0.25
  done
  fail "$mode manager /health did not become ready"
}

assert_only_manager_port() {
  local mode=$1
  local upstream_port=$2
  local ports_json
  ports_json=$(docker inspect --format '{{json .NetworkSettings.Ports}}' "$ACTIVE_CONTAINER") || \
    fail "$mode could not inspect published ports"
  if ! node - "$ports_json" "$upstream_port" <<'NODE'
const [rawPorts, rawUpstreamPort] = process.argv.slice(2);
const ports = JSON.parse(rawPorts);
const upstreamKey = `${Number(rawUpstreamPort)}/tcp`;
if (Array.isArray(ports?.[upstreamKey]) && ports[upstreamKey].length > 0) {
  throw new Error(`upstream port is published: ${upstreamKey}`);
}
for (const [key, bindings] of Object.entries(ports || {})) {
  if (Array.isArray(bindings) && bindings.length > 0 && key !== "3080/tcp") {
    throw new Error(`unexpected published container port: ${key}`);
  }
}
NODE
  then
    fail "$mode published an upstream or unexpected port"
  fi
  ok "$mode publishes manager only; upstream port stays private"
}

capture_top() {
  local mode=$1
  CURRENT_TOP_FILE="$TMP_DIR/$mode.top"
  if ! docker top "$ACTIVE_CONTAINER" -eo pid,ppid,args >"$CURRENT_TOP_FILE" 2>"$TMP_DIR/$mode.top.err"; then
    fail "$mode could not inspect container processes"
  fi
  mapfile -t ACTIVE_PIDS < <(awk '$1 ~ /^[0-9]+$/ { print $1 }' "$CURRENT_TOP_FILE")
  [[ "${#ACTIVE_PIDS[@]}" -gt 0 ]] || fail "$mode process inspection returned no PIDs"
}

assert_hosted_process() {
  local upstream_port=$1
  if ! docker exec "$ACTIVE_CONTAINER" node --input-type=module - "$upstream_port" <<'NODE'
import fs from "node:fs";
import http from "node:http";

const expectedPort = Number(process.argv[2]);
const fail = (message) => { throw new Error(message); };
const childText = fs.readFileSync("/proc/1/task/1/children", "utf8").trim();
const childPids = childText ? childText.split(/\s+/).filter(Boolean).map(Number) : [];
const children = childPids.map((pid) => {
  const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  return { pid, command };
});
const upstream = children.find(({ command }) => command.some((part) => part === "proxy.mjs" || part.endsWith("/proxy.mjs")));
if (!upstream) fail(`raw upstream child not found; children=${JSON.stringify(children)}`);
const env = fs.readFileSync(`/proc/${upstream.pid}/environ`, "utf8").split("\0");
if (!env.includes("HOST=127.0.0.1")) fail(`raw upstream HOST is not loopback: ${env.filter((entry) => entry.startsWith("HOST=")).join(",")}`);
if (!env.includes(`PORT=${expectedPort}`)) fail(`raw upstream PORT is not ${expectedPort}`);
const stat = fs.readFileSync(`/proc/${upstream.pid}/stat`, "utf8");
const statEnd = stat.lastIndexOf(")");
const parentPid = Number(stat.slice(statEnd + 2).trim().split(/\s+/)[1]);
if (parentPid !== 1) fail(`raw upstream parent is ${parentPid}, expected manager PID 1`);
if (fs.realpathSync(`/proc/${upstream.pid}/cwd`) !== "/app/upstream") fail(`raw upstream cwd is not /app/upstream`);

const health = await new Promise((resolve, reject) => {
  const request = http.get({ host: "127.0.0.1", port: expectedPort, path: "/health" }, (response) => {
    const chunks = [];
    response.setEncoding("utf8");
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => resolve({ status: response.statusCode, body: chunks.join("") }));
  });
  request.setTimeout(3000, () => request.destroy(new Error("raw upstream health timeout")));
  request.on("error", reject);
});
if (health.status !== 200 || health.body !== "OK") fail(`raw upstream health failed: ${JSON.stringify(health)}`);
console.log(`raw upstream pid=${upstream.pid} cwd=/app/upstream HOST=127.0.0.1 PORT=${expectedPort}`);
NODE
  then
    fail 'hosted raw upstream process contract failed'
  fi
  ok 'hosted raw upstream child uses loopback, private port, and raw cwd'
}

assert_external_process() {
  if grep -Fq 'proxy.mjs' "$CURRENT_TOP_FILE"; then
    fail 'external manager unexpectedly spawned upstream/proxy.mjs'
  fi
  ok 'external manager has no upstream child process'
}

request() {
  local name=$1
  local expected=$2
  local method=$3
  local path=$4
  local body=$5
  local auth_header=$6
  local body_file="$TMP_DIR/$name.body"
  local header_file="$TMP_DIR/$name.headers"
  local status
  local -a args=(--silent --show-error --connect-timeout 3 --max-time 15
    -X "$method" -D "$header_file" -o "$body_file")
  [[ -n "$auth_header" ]] && args+=(--header "$auth_header")
  [[ -n "$body" ]] && args+=(--header 'Content-Type: application/json' --data "$body")
  status=$(curl "${args[@]}" -w '%{http_code}' "$BASE_URL$path" || true)
  if [[ "$status" != "$expected" ]]; then
    fail "$name expected HTTP $expected, got $status: $(sed -n '1,3p' "$body_file" 2>/dev/null || true)"
  fi
  printf '%s\n' "$body_file"
}

assert_json() {
  local name=$1
  local file=$2
  local check=$3
  if ! node --input-type=module - "$file" "$check" <<'NODE'
import { readFileSync } from "node:fs";

const [file, check] = process.argv.slice(2);
let value;
try {
  value = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  console.error(`${check}: invalid JSON: ${error.message}`);
  process.exit(1);
}

function requireCondition(condition, message) {
  if (!condition) {
    console.error(`${check}: ${message}`);
    process.exit(1);
  }
}

if (check === "unauth-admin") {
  requireCondition(value?.error?.type === "auth_error", "missing auth_error response");
} else if (check === "empty-keys") {
  requireCondition(Array.isArray(value?.keys) && value.keys.length === 0, "expected an empty keys array");
} else if (check === "added-key") {
  requireCondition(typeof value?.id === "string" && value.id.length > 0, "missing key id");
  requireCondition(value?.alias === "smoke", "unexpected key alias");
  requireCondition(typeof value?.maskedKey === "string" && !value.maskedKey.includes("user_smoke_key"), "key was not masked");
} else if (check === "unauth-v1") {
  requireCondition(value?.error?.type === "authentication_error", "missing authentication_error response");
} else if (check === "external-models") {
  requireCondition(value?.object === "list" && Array.isArray(value.data) && value.data.length > 0, "invalid external models list");
  requireCondition(value.data.some((model) => model?.id === "smoke-model" && model?.owned_by === "local-fixture"), "external fixture model missing");
} else if (check === "hosted-models") {
  requireCondition(value?.object === "list" && Array.isArray(value.data) && value.data.length > 0, "invalid hosted models list");
  requireCondition(value.data.every((model) => model?.owned_by === "command-code"), "hosted response is not from raw upstream");
  requireCondition(!value.data.some((model) => model?.id === "smoke-model"), "hosted response came from external fixture");
} else if (check === "chat") {
  requireCondition(value?.object === "chat.completion", "wrong chat object");
  requireCondition(typeof value?.id === "string" && value.id.length > 0, "missing chat id");
  requireCondition(Array.isArray(value.choices) && value.choices[0]?.message?.role === "assistant", "missing assistant choice");
  requireCondition(typeof value.choices[0]?.message?.content === "string" && value.choices[0].message.content.length > 0, "missing chat content");
} else if (check === "messages") {
  requireCondition(value?.type === "message" && value?.role === "assistant", "wrong messages response type/role");
  requireCondition(typeof value?.id === "string" && value.id.length > 0, "missing message id");
  requireCondition(Array.isArray(value.content) && value.content[0]?.type === "text", "missing message content block");
  requireCondition(typeof value.content[0]?.text === "string" && value.content[0].text.length > 0, "missing message text");
} else {
  console.error(`unknown JSON assertion: ${check}`);
  process.exit(1);
}
NODE
  then
    fail "$name response structure failed"
  fi
  ok "$name"
}

wait_for_healthcheck() {
  local mode=$1
  local health_state=""
  for _ in $(seq 1 90); do
    health_state=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$ACTIVE_CONTAINER" 2>/dev/null || true)
    if [[ "$health_state" == healthy ]]; then
      ok "$mode Docker healthcheck"
      return
    fi
    [[ "$health_state" == unhealthy ]] && fail "$mode Docker healthcheck reported unhealthy"
    sleep 0.5
  done
  fail "$mode Docker healthcheck did not become healthy"
}

assert_host_pids_gone() {
  local mode=$1
  local deadline=$((SECONDS + 8))
  while (( SECONDS < deadline )); do
    local live=0
    local pid
    for pid in "${ACTIVE_PIDS[@]}"; do
      if [[ -e "/proc/$pid" ]]; then
        live=1
        break
      fi
    done
    if (( live == 0 )); then
      return
    fi
    sleep 0.1
  done
  fail "$mode left a host process behind after container stop: ${ACTIVE_PIDS[*]}"
}

stop_container() {
  local mode=$1
  local container=$ACTIVE_CONTAINER
  local volume=$ACTIVE_VOLUME
  local stop_output="$TMP_DIR/$mode.stop.output"
  local log_output="$TMP_DIR/$mode.container.log"
  if ! docker stop --time 15 "$container" >"$stop_output" 2>&1; then
    fail "$mode did not stop gracefully"
  fi
  local state exit_code
  state=$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)
  exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$container" 2>/dev/null || true)
  [[ "$state" == exited ]] || fail "$mode container state after stop is $state"
  [[ "$exit_code" == 0 ]] || fail "$mode manager exited with code $exit_code after SIGTERM"
  docker logs "$container" >"$log_output" 2>&1 || true
  grep -Fq '[manager] shutdown started' "$log_output" || fail "$mode did not log manager shutdown"
  assert_host_pids_gone "$mode"
  if ! docker rm "$container" >/dev/null; then
    fail "$mode stopped container could not be removed"
  fi
  [[ -z "$(docker ps -aq --filter "name=^/${container}$")" ]] || fail "$mode container remains after cleanup"
  if ! docker volume rm "$volume" >/dev/null; then
    fail "$mode isolated volume could not be removed"
  fi
  ACTIVE_CONTAINER=""
  ACTIVE_VOLUME=""
  ACTIVE_PIDS=()
  ok "$mode stop leaves no manager/upstream process, container, or volume"
}

run_hosted() {
  local upstream_port
  upstream_port=$(allocate_port) || fail 'could not allocate hosted upstream port'
  start_container hosted "$upstream_port"
  wait_for_manager hosted
  assert_only_manager_port hosted "$upstream_port"
  capture_top hosted
  assert_hosted_process "$upstream_port"

  local body
  body=$(request hosted_add_key 201 POST /admin/api/keys '{"alias":"smoke","key":"user_smoke_key"}' 'X-Admin-Token: smoke-admin-token')
  assert_json hosted-add-key "$body" added-key
  body=$(request hosted_models 200 GET /v1/models '' 'Authorization: Bearer smoke-client-token')
  assert_json hosted-models "$body" hosted-models
  wait_for_healthcheck hosted
  stop_container hosted
}

run_external() {
  start_container external "$MOCK_PORT"
  wait_for_manager external
  assert_only_manager_port external "$MOCK_PORT"
  capture_top external
  assert_external_process

  local body
  body=$(request external_unauth_admin 401 GET /admin/api/keys '' '')
  assert_json unauthenticated-admin "$body" unauth-admin
  body=$(request external_admin_empty 200 GET /admin/api/keys '' 'X-Admin-Token: smoke-admin-token')
  assert_json authenticated-admin "$body" empty-keys
  body=$(request external_add_key 201 POST /admin/api/keys '{"alias":"smoke","key":"user_smoke_key"}' 'X-Admin-Token: smoke-admin-token')
  assert_json external-add-key "$body" added-key
  body=$(request external_unauth_models 401 GET /v1/models '' '')
  assert_json unauthenticated-v1 "$body" unauth-v1
  body=$(request external_models 200 GET /v1/models '' 'Authorization: Bearer smoke-client-token')
  assert_json external-models "$body" external-models
  body=$(request external_chat 200 POST /v1/chat/completions '{"model":"smoke-model","messages":[{"role":"user","content":"ping"}]}' 'Authorization: Bearer smoke-client-token')
  assert_json external-chat "$body" chat
  body=$(request external_messages 200 POST /v1/messages '{"model":"smoke-model","max_tokens":8,"messages":[{"role":"user","content":"ping"}]}' 'x-api-key: smoke-client-token')
  assert_json external-messages "$body" messages
  wait_for_healthcheck external
  stop_container external
}

start_external_fixture
run_hosted
run_external

printf 'container smoke passed (%s checks)\n' "$PASS"
