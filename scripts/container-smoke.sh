#!/usr/bin/env bash
set -Eeuo pipefail

# Start a built image against a local fixture and exercise the externally
# visible contract. This script never uses the production API.

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
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  printf 'container smoke cannot run: image does not exist: %s\n' "$IMAGE" >&2
  exit 2
}

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ccpm-container-smoke.XXXXXX")
CONTAINER=""
VOLUME=""
VOLUME_CREATED=0
MOCK_PID=""
BASE_URL=""
CONTAINER_STARTED=0
PASS=0

fail() {
  printf 'container smoke FAILED: %s\n' "$*" >&2
  if [[ "$CONTAINER_STARTED" == "1" ]]; then
    docker logs "$CONTAINER" >&2 || true
  fi
  if [[ -f "$TMP_DIR/mock.log" ]]; then
    printf '%s\n' '--- local upstream fixture log ---' >&2
    sed -n '1,120p' "$TMP_DIR/mock.log" >&2 || true
  fi
  exit 1
}

cleanup() {
  local status=$?
  set +e
  if [[ "$CONTAINER_STARTED" == "1" ]]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1
  fi
  if [[ "$VOLUME_CREATED" == "1" ]]; then
    docker volume rm "$VOLUME" >/dev/null 2>&1
  fi
  if [[ -n "$MOCK_PID" ]]; then
    kill "$MOCK_PID" >/dev/null 2>&1
    wait "$MOCK_PID" >/dev/null 2>&1
  fi
  rm -rf -- "$TMP_DIR"
  exit "$status"
}
trap cleanup EXIT

VOLUME="ccpm-smoke-${BASHPID}-${RANDOM}"
CONTAINER="ccpm-smoke-${BASHPID}-${RANDOM}"
if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  fail "generated Docker volume name already exists: $VOLUME"
fi
docker volume create "$VOLUME" >/dev/null || fail "cannot create isolated Docker volume"
VOLUME_CREATED=1

node "$ROOT_DIR/scripts/container-smoke-upstream.mjs" >"$TMP_DIR/mock.log" 2>&1 &
MOCK_PID=$!
MOCK_PORT=""
for _ in $(seq 1 50); do
  if [[ -s "$TMP_DIR/mock.log" ]]; then
    MOCK_PORT=$(sed -n 's/^SMOKE_UPSTREAM_PORT=\([0-9][0-9]*\)$/\1/p' "$TMP_DIR/mock.log" | head -n 1)
    [[ -n "$MOCK_PORT" ]] && break
  fi
  if ! kill -0 "$MOCK_PID" >/dev/null 2>&1; then
    fail "local upstream fixture exited before listening"
  fi
  sleep 0.1
done
[[ "$MOCK_PORT" =~ ^[0-9]+$ ]] || fail "local upstream fixture did not publish a port"

# host-gateway keeps the fixture local while working on the Linux GitHub
# runner. The image listens on its default internal PORT=3080; Docker assigns
# an isolated host port so an unrelated local service cannot be mistaken for
# this test.
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  fail "generated Docker container name already exists: $CONTAINER"
fi
if ! docker run -d --rm \
  --name "$CONTAINER" \
  --publish 127.0.0.1::3080/tcp \
  --add-host host.docker.internal:host-gateway \
  --mount "type=volume,source=$VOLUME,target=/data" \
  --env ADMIN_TOKEN=smoke-admin-token \
  --env CLIENT_TOKEN=smoke-client-token \
  --env EMBED_UPSTREAM=0 \
  --env UPSTREAM_HOST=host.docker.internal \
  --env UPSTREAM_PORT="$MOCK_PORT" \
  --env CC_QUOTA_BASE="http://host.docker.internal:$MOCK_PORT" \
  "$IMAGE" >"$TMP_DIR/container-id"; then
  fail "container did not start"
fi
CONTAINER_STARTED=1

for _ in $(seq 1 60); do
  mapping=$(docker port "$CONTAINER" 3080/tcp 2>/dev/null | head -n 1 || true)
  if [[ "$mapping" =~ :([0-9]+)$ ]]; then
    host_port=${BASH_REMATCH[1]}
    BASE_URL="http://127.0.0.1:$host_port"
    health_status=$(curl -sS --connect-timeout 1 --max-time 3 -o "$TMP_DIR/health.body" -w '%{http_code}' "$BASE_URL/health" || true)
    if [[ "$health_status" == "200" ]] && [[ $(<"$TMP_DIR/health.body") == "OK" ]]; then
      break
    fi
  fi
  state=$(docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null || true)
  [[ "$state" == "exited" || "$state" == "dead" ]] && fail "manager container stopped during startup"
  sleep 0.5
done
[[ -n "$BASE_URL" ]] || fail "Docker did not publish the manager port"
[[ -s "$TMP_DIR/health.body" && $(<"$TMP_DIR/health.body") == "OK" ]] || fail "default PORT /health contract failed"
PASS=$((PASS + 1))
printf 'ok: default PORT /health\n'

request() {
  local name=$1 expected=$2 method=$3 path=$4 body=$5 auth_header=$6
  local body_file="$TMP_DIR/$name.body" header_file="$TMP_DIR/$name.headers" status
  local -a args=(--silent --show-error --connect-timeout 3 --max-time 15
    -X "$method" -D "$header_file" -o "$body_file")
  [[ -n "$auth_header" ]] && args+=( -H "$auth_header" )
  [[ -n "$body" ]] && args+=( -H 'Content-Type: application/json' --data "$body" )
  status=$(curl "${args[@]}" -w '%{http_code}' "$BASE_URL$path" || true)
  if [[ "$status" != "$expected" ]]; then
    fail "$name expected HTTP $expected, got $status: $(sed -n '1,2p' "$body_file" 2>/dev/null || true)"
  fi
  printf '%s\n' "$body_file"
}

assert_json() {
  local name=$1 file=$2 check=$3
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
} else if (check === "models") {
  requireCondition(value?.object === "list" && Array.isArray(value.data) && value.data.length > 0, "invalid models list");
  requireCondition(value.data.some((model) => model?.id === "smoke-model" && model?.object === "model"), "smoke model missing");
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
  PASS=$((PASS + 1))
  printf 'ok: %s\n' "$name"
}

admin_header='X-Admin-Token: smoke-admin-token'
client_header='Authorization: Bearer smoke-client-token'

body=$(request unauth_admin 401 GET /admin/api/keys "" "")
assert_json unauthenticated-admin "$body" unauth-admin

body=$(request admin_empty 200 GET /admin/api/keys "" "$admin_header")
assert_json authenticated-admin "$body" empty-keys

body=$(request add_key 201 POST /admin/api/keys '{"alias":"smoke","key":"user_smoke_key"}' "$admin_header")
assert_json add-test-key "$body" added-key

body=$(request unauth_models 401 GET /v1/models "" "")
assert_json unauthenticated-v1 "$body" unauth-v1

body=$(request models 200 GET /v1/models "" "$client_header")
assert_json v1-models "$body" models

body=$(request chat 200 POST /v1/chat/completions '{"model":"smoke-model","messages":[{"role":"user","content":"ping"}]}' "$client_header")
assert_json chat-completions "$body" chat

body=$(request messages 200 POST /v1/messages '{"model":"smoke-model","max_tokens":8,"messages":[{"role":"user","content":"ping"}]}' 'x-api-key: smoke-client-token')
assert_json messages "$body" messages

health_state=""
for _ in $(seq 1 50); do
  health_state=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$CONTAINER" 2>/dev/null || true)
  [[ "$health_state" == "healthy" ]] && break
  [[ "$health_state" == "unhealthy" ]] && fail "Docker healthcheck reported unhealthy"
  sleep 0.5
done
[[ "$health_state" == "healthy" ]] || fail "Docker healthcheck did not become healthy"
PASS=$((PASS + 1))
printf 'ok: Docker healthcheck\n'

printf 'container smoke passed (%s checks)\n' "$PASS"
