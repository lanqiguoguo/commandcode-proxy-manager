#!/usr/bin/env bash
# Local fixture tests for sync-upstream.sh. No real upstream or registry is used.
# The fixture proves that synchronization preserves release bytes and protects
# the installed directory until every stage check has passed.
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
API_PID=""

cleanup() {
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
  fi
  if [[ -n "$API_PID" ]]; then
    wait "$API_PID" 2>/dev/null || true
  fi
  rm -rf -- "$T"
}
trap cleanup EXIT INT TERM

PASS=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; PASS=$((PASS + 1)); }

assert_static_contract() {
  local sync="$ROOT_DIR/scripts/sync-upstream.sh"
  local old_name='patch'
  old_name+='-'
  old_name+='upstream'
  local marker_re='CCPM_'
  marker_re+='.*'
  marker_re+='PATCH_V1'

  if grep -Fq "$old_name" "$sync"; then
    fail "同步脚本仍引用旧源码改写脚本"
  fi
  if rg -n "$marker_re" "$ROOT_DIR/scripts" "$ROOT_DIR/upstream"; then
    fail "scripts/upstream 仍含本地补丁标记"
  fi
  if rg -n 'sed[[:space:]]+-i.*config\.json|config\.json.*sed[[:space:]]+-i' "$sync"; then
    fail "同步脚本仍对上游 config.json 做 sed 重写"
  fi
  for suffix in lifecycle initialization version; do
    local candidate='patch'
    candidate+='-'
    candidate+='upstream'
    candidate+='-'
    candidate+="$suffix"
    candidate+=".mjs"
    [[ ! -e "$ROOT_DIR/scripts/$candidate" ]] || fail "旧脚本仍存在：$candidate"
  done

  ok "静态门禁：无旧源码改写引用、标记、sed 重写或旧脚本"
}

assert_clean_output() {
  local output=$1
  if printf '%s\n' "$output" | grep -Eiq 'patch|CCPM_'; then
    printf '%s\n' "$output" >&2
    fail "同步输出含源码补丁信息"
  fi
}

assert_same_target() {
  local label=$1
  local snapshot="$T/snapshot-$label"
  for name in proxy.mjs config.json package.json; do
    cmp -- "$snapshot/upstream/$name" "$FAKE/upstream/$name" || fail "$label 修改了 upstream/$name"
  done
  cmp -- "$snapshot/UPSTREAM_VERSION" "$FAKE/UPSTREAM_VERSION" || fail "$label 修改了 UPSTREAM_VERSION"
}

snapshot_target() {
  local label=$1
  local snapshot="$T/snapshot-$label"
  rm -rf -- "$snapshot"
  mkdir -p "$snapshot"
  cp -p "$FAKE/UPSTREAM_VERSION" "$snapshot/UPSTREAM_VERSION"
  mkdir -p "$snapshot/upstream"
  for name in proxy.mjs config.json package.json; do
    cp -p "$FAKE/upstream/$name" "$snapshot/upstream/$name"
  done
}

assert_expected_target() {
  local label=$1
  local expected_dir=$2
  for name in proxy.mjs config.json package.json; do
    cmp -- "$expected_dir/$name" "$FAKE/upstream/$name" || fail "$label 的 upstream/$name 与原始 fixture 不一致"
  done
}

expect_failure() {
  local label=$1
  local route=$2
  local expected_error=$3
  local upstream_url=${4:-file://$UP}
  local output="$T/$label.out"

  snapshot_target "$label"
  if run_sync_url "$upstream_url" "$API_BASE/$route" > "$output" 2>&1; then
    sed -n '1,120p' "$output" >&2
    fail "$label 应失败"
  fi
  assert_same_target "$label"
  grep -Fq "$expected_error" "$output" || {
    sed -n '1,120p' "$output" >&2
    fail "$label 未报告 $expected_error"
  }
  ok "$label 失败且正式目录和版本标记不变"
}

assert_static_contract

# ---------- Build a local Git upstream fixture ----------
UP="$T/upstream-src"
mkdir -p "$UP"
git init -q -b master "$UP"
git -C "$UP" config user.email fixture@test.local
git -C "$UP" config user.name fixture

write_fixture_proxy() {
  local marker=$1
  cat > "$UP/proxy.mjs" <<EOF
import http from "node:http";

const port = Number(process.env.PORT || 0);
const host = process.env.HOST || "0.0.0.0";
export const fixtureMarker = "$marker";

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("OK");
    return;
  }
  response.writeHead(200, { "content-type": "text/plain" });
  response.end(fixtureMarker);
});

server.listen(port, host);
EOF
}

write_fixture_config() {
  cat > "$UP/config.json" <<'EOF'
{
  "port": 3050,
  "host": "0.0.0.0",
  "apiKey": "",
  "apiBase": "https://api.commandcode.ai",
  "projectSlug": "cc-proxy",
  "logFile": "",
  "logLevel": "info"
}
EOF
}

write_fixture_package() {
  cat > "$UP/package.json" <<'EOF'
{
  "name": "commandcode-proxy",
  "version": "9.9.9",
  "type": "module"
}
EOF
}

commit_fixture() {
  git -C "$UP" add -A
  git -C "$UP" commit -qm "$1"
}

write_fixture_proxy release-build
write_fixture_config
write_fixture_package
commit_fixture "release content"
git -C "$UP" tag v9.9.9
RELEASE_COMMIT=$(git -C "$UP" rev-parse 'v9.9.9^{commit}')

EXPECTED_RELEASE="$T/expected-release"
mkdir -p "$EXPECTED_RELEASE"
for name in proxy.mjs config.json package.json; do
  git -C "$UP" show "$RELEASE_COMMIT:$name" > "$EXPECTED_RELEASE/$name"
done

write_fixture_proxy master-build
commit_fixture "master content"

printf '%s\n' 'export const = ;' > "$UP/proxy.mjs"
commit_fixture "invalid syntax content"
git -C "$UP" tag v9.9.10

write_fixture_proxy master-build
commit_fixture "restore valid master"

rm -f "$UP/proxy.mjs"
ln -s config.json "$UP/proxy.mjs"
commit_fixture "symlink proxy content"
git -C "$UP" tag v9.9.11

rm "$UP/proxy.mjs"
write_fixture_proxy master-build
commit_fixture "restore after symlink"

rm "$UP/proxy.mjs"
mkdir "$UP/proxy.mjs"
printf '%s\n' 'fixture directory' > "$UP/proxy.mjs/entry"
commit_fixture "directory proxy content"
git -C "$UP" tag v9.9.12

rm -rf "$UP/proxy.mjs"
write_fixture_proxy master-build
commit_fixture "restore valid master again"
FIXTURE_MARKER_RE='CCPM_'
FIXTURE_MARKER_RE+='.*'
FIXTURE_MARKER_RE+='PATCH_V1'
if rg -n "$FIXTURE_MARKER_RE" "$UP"; then
  fail "上游 fixture 不得包含本地补丁标记"
fi
MASTER_HEAD=$(git -C "$UP" rev-parse HEAD)
EXPECTED_MASTER="$T/expected-master"
mkdir -p "$EXPECTED_MASTER"
for name in proxy.mjs config.json package.json; do
  git -C "$UP" show "$MASTER_HEAD:$name" > "$EXPECTED_MASTER/$name"
done

# ---------- Local release API fixture ----------
cat > "$T/api-server.mjs" <<'EOF'
import http from "node:http";

const responses = new Map([
  ["/release", [200, '{"tag_name":"v9.9.9"}']],
  ["/empty-404", [404, '{"message":"Not Found"}']],
  ["/empty-null", [200, '{"tag_name":null}']],
  ["/missing-tag", [200, '{"message":"unexpected response"}']],
  ["/malformed", [200, '{"tag_name":']],
  ["/invalid-tag", [200, '{"tag_name":"master"}']],
  ["/missing-release-tag", [200, '{"tag_name":"v9.9.13"}']],
  ["/invalid-syntax", [200, '{"tag_name":"v9.9.10"}']],
  ["/symlink-release", [200, '{"tag_name":"v9.9.11"}']],
  ["/directory-release", [200, '{"tag_name":"v9.9.12"}']],
  ["/forbidden", [403, '{"message":"Forbidden"}']],
  ["/rate-limit", [429, '{"message":"rate limit exceeded"}']],
  ["/server-error", [500, '{"message":"server error"}']],
  ["/bad-not-found", [404, '{"message":"Forbidden"}']],
]);

const server = http.createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/drop") {
    request.socket.destroy();
    return;
  }
  const [status, body] = responses.get(path) ?? [404, '{"message":"Not Found"}'];
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(body);
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`${address.port}\n`);
});
EOF
node "$T/api-server.mjs" > "$T/api-port" 2> "$T/api-server.err" &
API_PID=$!
for _ in {1..100}; do
  if [[ -s "$T/api-port" ]]; then break; fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    sed -n '1,80p' "$T/api-server.err" >&2 || true
    fail "HTTP API fixture 启动失败"
  fi
  sleep 0.01
done
[[ -s "$T/api-port" ]] || fail "HTTP API fixture 未发布端口"
API_PORT=$(head -n 1 "$T/api-port")
API_BASE="http://127.0.0.1:$API_PORT"

# ---------- Fake target repository ----------
FAKE="$T/fake-repo"
mkdir -p "$FAKE/scripts" "$FAKE/upstream"
cp "$ROOT_DIR/scripts/sync-upstream.sh" "$FAKE/scripts/sync-upstream.sh"
printf '%s\n' 'old-proxy' > "$FAKE/upstream/proxy.mjs"
printf '%s\n' 'old-config' > "$FAKE/upstream/config.json"
printf '%s\n' 'old-package' > "$FAKE/upstream/package.json"
printf '%s\n' 'old-version' > "$FAKE/UPSTREAM_VERSION"
( cd "$FAKE" && git init -q -b main . && git config user.email fixture@test.local && git config user.name fixture && git add -A && git commit -qm base )

run_sync_url() {
  local upstream_url=$1
  local api_url=$2
  ( cd "$FAKE" && UPSTREAM_URL="$upstream_url" UPSTREAM_API="$api_url" bash scripts/sync-upstream.sh )
}

run_sync() { run_sync_url "file://$UP" "$1"; }

OUT_RELEASE=$(run_sync "$API_BASE/release" 2>&1)
assert_clean_output "$OUT_RELEASE"
assert_expected_target "release" "$EXPECTED_RELEASE"
[[ "$(<"$FAKE/UPSTREAM_VERSION")" == "v9.9.9@$RELEASE_COMMIT" ]] || fail "release UPSTREAM_VERSION 不正确"
grep -Fq "Fetching upstream release v9.9.9" <<< "$OUT_RELEASE" || fail "release 没有走 release 路径"
ok "release proxy/config/package 与原始 fixture 逐字节一致"

snapshot_target repeated-sync
OUT_REPEAT=$(run_sync "$API_BASE/release" 2>&1)
assert_clean_output "$OUT_REPEAT"
assert_same_target repeated-sync
ok "重复同步结果逐字节稳定"

OUT_MASTER=$(run_sync "$API_BASE/empty-404" 2>&1)
assert_clean_output "$OUT_MASTER"
assert_expected_target "master fallback" "$EXPECTED_MASTER"
[[ "$(<"$FAKE/UPSTREAM_VERSION")" == "master@$MASTER_HEAD" ]] || fail "master fallback UPSTREAM_VERSION 不正确"
grep -Fq "No upstream release found" <<< "$OUT_MASTER" || fail "明确无 release 时没有打印 fallback 提示"
ok "明确无 release 时同步 master 原始 fixture"

snapshot_target empty-null
OUT_NULL=$(run_sync "$API_BASE/empty-null" 2>&1)
assert_clean_output "$OUT_NULL"
assert_same_target empty-null
ok "tag_name:null fallback 不改变已安装字节"

# ---------- API and checkout failures are fail-closed ----------
expect_failure api-403 forbidden "状态不可接受：403"
expect_failure api-429 rate-limit "状态不可接受：429"
expect_failure api-500 server-error "状态不可接受：500"
expect_failure api-network-error drop "release API 请求失败"
expect_failure api-malformed malformed "release API JSON"
expect_failure api-missing-tag missing-tag "响应结构"
expect_failure api-invalid-tag invalid-tag "release tag 格式无效"
expect_failure api-bad-not-found bad-not-found "404 不是明确的无 release 响应"
expect_failure missing-release-tag missing-release-tag "上游不存在 release tag"
expect_failure invalid-syntax invalid-syntax "语法校验失败"
expect_failure upstream-symlink symlink-release "拒绝符号链接"
expect_failure upstream-directory directory-release "regular file"

# ---------- A copy failure happens before the directory exchange ----------
CP_REAL=$(command -v cp)
mkdir -p "$T/fail-cp-bin"
cat > "$T/fail-cp-bin/cp" <<'EOF'
#!/usr/bin/env bash
if [[ "${CP_MODE:-}" == "fail-stage" && "$*" == *".upstream-sync."* ]]; then
  echo "fixture: refusing stage copy" >&2
  exit 91
fi
exec "$REAL_CP" "$@"
EOF
chmod +x "$T/fail-cp-bin/cp"
snapshot_target copy-failure
COPY_FAILURE_OUT="$T/copy-failure.out"
if ( cd "$FAKE" && REAL_CP="$CP_REAL" CP_MODE=fail-stage PATH="$T/fail-cp-bin:$PATH" \
  UPSTREAM_URL="file://$UP" UPSTREAM_API="$API_BASE/release" bash scripts/sync-upstream.sh ) \
  > "$COPY_FAILURE_OUT" 2>&1; then
  sed -n '1,120p' "$COPY_FAILURE_OUT" >&2
  fail "复制失败用例应失败"
fi
assert_same_target copy-failure
grep -Fq "无法复制上游 proxy.mjs" "$COPY_FAILURE_OUT" || fail "复制失败没有明确诊断"
ok "stage 复制失败时正式目录不变"

# ---------- Rename and interrupt failures rollback the directory ----------
MV_REAL=$(command -v mv)
mkdir -p "$T/fail-mv-bin"
cat > "$T/fail-mv-bin/mv" <<'EOF'
#!/usr/bin/env bash
if [[ "${MV_MODE:-}" == "fail-version" && "${!#}" == */UPSTREAM_VERSION ]]; then
  echo "fixture: refusing UPSTREAM_VERSION rename" >&2
  exit 91
fi
if [[ "${MV_MODE:-}" == "interrupt-after-swap" && "${!#}" == */upstream && ! -e "${INTERRUPT_MARKER:?}" ]]; then
  "$REAL_MV" "$@"
  : > "$INTERRUPT_MARKER"
  kill -TERM "$PPID"
  exit 0
fi
exec "$REAL_MV" "$@"
EOF
chmod +x "$T/fail-mv-bin/mv"

snapshot_target version-rename-failure
VERSION_FAILURE_OUT="$T/version-rename-failure.out"
if ( cd "$FAKE" && REAL_MV="$MV_REAL" MV_MODE=fail-version PATH="$T/fail-mv-bin:$PATH" \
  UPSTREAM_URL="file://$UP" UPSTREAM_API="$API_BASE/release" bash scripts/sync-upstream.sh ) \
  > "$VERSION_FAILURE_OUT" 2>&1; then
  sed -n '1,120p' "$VERSION_FAILURE_OUT" >&2
  fail "版本 rename 失败用例应失败"
fi
assert_same_target version-rename-failure
ok "UPSTREAM_VERSION rename 失败后 rollback 保持旧目录"

INTERRUPT_MARKER="$T/interrupt-sent"
snapshot_target interrupt-after-swap
INTERRUPT_OUT="$T/interrupt-after-swap.out"
if ( cd "$FAKE" && REAL_MV="$MV_REAL" MV_MODE=interrupt-after-swap INTERRUPT_MARKER="$INTERRUPT_MARKER" \
  PATH="$T/fail-mv-bin:$PATH" UPSTREAM_URL="file://$UP" UPSTREAM_API="$API_BASE/release" \
  bash scripts/sync-upstream.sh ) > "$INTERRUPT_OUT" 2>&1; then
  sed -n '1,120p' "$INTERRUPT_OUT" >&2
  fail "目录交换中断用例应失败"
fi
assert_same_target interrupt-after-swap
ok "目录交换后中断 rollback 保持旧目录"

echo
echo "sync-upstream fixture tests passed ($PASS checks)."
