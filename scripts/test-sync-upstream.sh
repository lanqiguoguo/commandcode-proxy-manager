#!/usr/bin/env bash
# sync-upstream.sh 的本地 fixture 测试（不触碰真实上游）。
# 在 /tmp 构造 file:// 上游 git 仓库和 HTTP release API，验证：
#   1) release 的 HTTP 状态、JSON、tag 格式和 tag -> commit 关系独立校验；
#   2) 只有明确的无 release 响应才回退 master；
#   3) symlink/目录输入、API 错误、畸形 JSON 和同步中断都保持旧目标不变；
#   4) 目录级交换和 UPSTREAM_VERSION rename 失败时可 rollback。
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
ok()   { echo "ok: $*"; PASS=$((PASS + 1)); }

# ---------- 构造上游 fixture 仓库 ----------
UP="$T/upstream-src"
mkdir -p "$UP"
cd "$UP"
git init -q -b master .
git config user.email fixture@test.local
git config user.name fixture
write_fixture_proxy() {
  local marker=$1
  cat > proxy.mjs <<EOF
import http from 'http';

const CFG = { port: Number(process.env.PORT || 0), host: process.env.HOST || '127.0.0.1' };
export const MARKER = "$marker";
async function refreshCCVersion() {}
const CC_VERSION_REFRESH_MS = 86400000;
refreshCCVersion();
setInterval(refreshCCVersion, CC_VERSION_REFRESH_MS);

const sessionStore = new Map();
const keyStateStore = new Map();
// 定期清理过期 session
setInterval(() => {
  for (const [key, entry] of sessionStore) {
    if (Date.now() >= entry.expiresAt) {
      sessionStore.delete(key);
      keyStateStore.delete(key);
    }
  }
}, 60 * 60 * 1000);
function getSessionId() { return 'fixture'; }

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }
  sendJSON(res, 200, { marker: MARKER });
});

server.listen(CFG.port, CFG.host, () => {
  const address = server.address();
  console.log('FIXTURE_READY ' + (typeof address === 'object' && address ? address.port : CFG.port));
});
EOF
}
write_fixture_proxy release-build
printf '{\n  "host": "0.0.0.0",\n  "port": 3050\n}\n' > config.json
printf '{\n  "name": "commandcode-proxy",\n  "version": "9.9.9"\n}\n' > package.json
git add .
git commit -qm "release content"
git tag v9.9.9

# tag 之后再推 master-only commit，用于证明 release 路径不是 mutable master。
write_fixture_proxy master-build
git commit -qam "master-only change"

# Git tree 能表达的非普通输入包括 symlink 和目录；其它非普通文件仍由
# sync-upstream.sh 的 regular-file 检查覆盖。
SECRET="$T/outside-secret.txt"
printf '%s\n' 'must-not-be-copied' > "$SECRET"
rm proxy.mjs
ln -s "$SECRET" proxy.mjs
git add -A
git commit -qm "symlink payload"
git tag v9.9.10
rm proxy.mjs
write_fixture_proxy master-restored
git commit -qam "restore regular proxy"

rm config.json
mkdir config.json
printf '%s\n' 'directory payload' > config.json/marker
git add -A
git commit -qm "directory payload"
git tag v9.9.11
rm -rf config.json
printf '{\n  "host": "0.0.0.0",\n  "port": 3050\n}\n' > config.json
git add config.json
git commit -qm "restore regular config"

MASTER_HEAD=$(git rev-parse HEAD)
TAG_COMMIT=$(git rev-parse v9.9.9^{commit})
cd "$ROOT_DIR"

# ---------- 构造 HTTP release API fixture ----------
cat > "$T/api-server.mjs" <<'EOF'
import http from "node:http";

const responses = new Map([
  ["/release", [200, '{"tag_name":"v9.9.9","name":"v9.9.9"}']],
  ["/empty-404", [404, '{"message":"Not Found","documentation_url":"https://docs.github.com"}']],
  ["/empty-null", [200, '{"tag_name":null}']],
  ["/missing-tag", [200, '{"message":"unexpected response"}']],
  ["/malformed", [200, '{"tag_name":']],
  ["/invalid-tag", [200, '{"tag_name":"master"}']],
  ["/symlink-release", [200, '{"tag_name":"v9.9.10"}']],
  ["/directory-release", [200, '{"tag_name":"v9.9.11"}']],
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
    fail "HTTP API fixture failed to start"
  fi
  sleep 0.01
done
[[ -s "$T/api-port" ]] || fail "HTTP API fixture did not publish a port"
API_PORT=$(head -n 1 "$T/api-port")
API_BASE="http://127.0.0.1:$API_PORT"

# ---------- 构造假目标仓库（跑 sync 脚本的地方） ----------
FAKE="$T/fake-repo"
mkdir -p "$FAKE/scripts" "$FAKE/src" "$FAKE/upstream"
cp "$ROOT_DIR/scripts/sync-upstream.sh" "$FAKE/scripts/"
cp "$ROOT_DIR/scripts/patch-upstream-lifecycle.mjs" "$FAKE/scripts/"
cp "$ROOT_DIR/src/serverLifecycle.mjs" "$FAKE/src/"
printf 'old-proxy\n' > "$FAKE/upstream/proxy.mjs"
printf 'old-config\n' > "$FAKE/upstream/config.json"
printf 'old-package\n' > "$FAKE/upstream/package.json"
printf 'old-version\n' > "$FAKE/UPSTREAM_VERSION"
( cd "$FAKE" && git init -q -b main . && git config user.email f@f.local && git config user.name f \
  && git add -A && git commit -qm base )

run_sync_url() {
  local upstream=$1
  local api=$2
  ( cd "$FAKE" && UPSTREAM_URL="file://$upstream" UPSTREAM_API="$api" bash scripts/sync-upstream.sh )
}
run_sync() { run_sync_url "$UP" "$1"; }

snapshot_target() {
  local name=$1
  SNAPSHOT="$T/snapshot-$name"
  rm -rf -- "$SNAPSHOT"
  mkdir -p "$SNAPSHOT"
  cp -a "$FAKE/upstream" "$SNAPSHOT/upstream"
  cp -p "$FAKE/UPSTREAM_VERSION" "$SNAPSHOT/UPSTREAM_VERSION"
}

assert_target_unchanged() {
  local label=$1
  diff -ruN "$SNAPSHOT/upstream" "$FAKE/upstream" >/dev/null || fail "$label 修改了 upstream/"
  cmp -- "$SNAPSHOT/UPSTREAM_VERSION" "$FAKE/UPSTREAM_VERSION" || fail "$label 修改了 UPSTREAM_VERSION"
}

expect_failure() {
  local label=$1
  local api=$2
  local upstream=${3:-$UP}
  local output="$T/$label.out"
  snapshot_target "$label"
  if run_sync_url "$upstream" "$api" > "$output" 2>&1; then
    sed -n '1,120p' "$output"
    fail "$label 应失败"
  fi
  echo "--- $label output ---"
  sed -n '1,120p' "$output"
  assert_target_unchanged "$label"
  ok "$label 失败且旧 upstream/ 与版本标记保持不变"
}

# ---------- 用例 1：release 的状态、JSON、tag 和 commit ----------
OUT1=$(run_sync "$API_BASE/release" 2>&1)
echo "--- case release output ---"; echo "$OUT1"
V1=$(cat "$FAKE/UPSTREAM_VERSION")
[ "$V1" = "v9.9.9@$TAG_COMMIT" ] || fail "release UPSTREAM_VERSION 应为 v9.9.9@$TAG_COMMIT，实际: $V1"
ok "release UPSTREAM_VERSION = $V1"
grep -Fq 'release-build' "$FAKE/upstream/proxy.mjs" || fail "release proxy.mjs 应来自 tag 内容"
ok "release 内容来自 tag（非 master）"
grep -Fq '"host": "127.0.0.1"' "$FAKE/upstream/config.json" || fail "release sed host 改写未生效"
if grep -Fq '"host": "0.0.0.0"' "$FAKE/upstream/config.json"; then fail "release config.json 残留 0.0.0.0"; fi
ok "release sed host 改写生效"
echo "$OUT1" | grep -Fq 'Fetching upstream release v9.9.9' || fail "release 应走 release 路径"
ok "release HTTP/JSON/tag/commit 校验后同步"

# ---------- 用例 1b：生命周期补丁只应用一次且重复输入字节不变 ----------
assert_patch_applies_once() {
  local label=$1
  local target=$2
  local first second before after
  first=$(node "$ROOT_DIR/scripts/patch-upstream-lifecycle.mjs" "$target" 2>&1)
  echo "--- $label first patch ---"; echo "$first"
  echo "$first" | grep -Fq "upstream lifecycle patch applied" || fail "$label 首次应应用补丁"
  cp -p "$target" "$target.before-second"
  second=$(node "$ROOT_DIR/scripts/patch-upstream-lifecycle.mjs" "$target" 2>&1)
  echo "--- $label second patch ---"; echo "$second"
  echo "$second" | grep -Fq "upstream lifecycle patch already present" || fail "$label 重复执行应报告 already present"
  cmp -- "$target.before-second" "$target" || fail "$label 重复执行改变了字节"
  ok "$label clean input 应用一次，重复输入字节不变"
}

assert_patch_rejection() {
  local label=$1
  local target=$2
  local message=$3
  local output
  cp -p "$target" "$target.before-rejection"
  if output=$(node "$ROOT_DIR/scripts/patch-upstream-lifecycle.mjs" "$target" 2>&1); then
    echo "$output"
    fail "$label 应拒绝"
  fi
  echo "--- $label rejection ---"; echo "$output"
  echo "$output" | grep -Fq "$message" || fail "$label 缺少明确诊断"
  cmp -- "$target.before-rejection" "$target" || fail "$label 拒绝时修改了字节"
  ok "$label 拒绝且输入字节保持不变"
}

CURRENT_CLEAN="$T/current-upstream-clean.mjs"
git -C "$UP" show "$TAG_COMMIT:proxy.mjs" > "$CURRENT_CLEAN"
assert_patch_applies_once "当前上游 fixture" "$CURRENT_CLEAN"

RELEASE_CLEAN="$T/release-upstream-clean.mjs"
git -C "$UP" show "$TAG_COMMIT:proxy.mjs" > "$RELEASE_CLEAN"
assert_patch_applies_once "release test fixture" "$RELEASE_CLEAN"

PATCHED_RELEASE="$T/release-upstream-patched.mjs"
cp -p "$FAKE/upstream/proxy.mjs" "$PATCHED_RELEASE"
PATCHED_RELEASE_BEFORE="$T/release-upstream-patched.before"
cp -p "$PATCHED_RELEASE" "$PATCHED_RELEASE_BEFORE"
PATCHED_RELEASE_OUT=$(node "$ROOT_DIR/scripts/patch-upstream-lifecycle.mjs" "$PATCHED_RELEASE" 2>&1)
echo "--- already patched byte check ---"; echo "$PATCHED_RELEASE_OUT"
echo "$PATCHED_RELEASE_OUT" | grep -Fq "upstream lifecycle patch already present" || fail "已补丁输入应报告 already present"
cmp -- "$PATCHED_RELEASE_BEFORE" "$PATCHED_RELEASE" || fail "已补丁输入重复执行改变了字节"
ok "已补丁 upstream/proxy.mjs 重复执行字节完全不变"

DUP_MARKER="$T/duplicate-marker.mjs"
cp -p "$PATCHED_RELEASE" "$DUP_MARKER"
printf '\n// CCPM_LIFECYCLE_PATCH_V1\n' >> "$DUP_MARKER"
assert_patch_rejection "重复 lifecycle marker" "$DUP_MARKER" "生命周期标记重复"

DUP_UNREF="$T/duplicate-unref.mjs"
cp -p "$PATCHED_RELEASE" "$DUP_UNREF"
sed -i '/^ccVersionRefreshTimer\.unref?\.();$/a ccVersionRefreshTimer.unref?.();' "$DUP_UNREF"
assert_patch_rejection "重复 timer unref" "$DUP_UNREF" "CC refresh timer unref 不是唯一一处"

OLD_INLINE="$T/old-inline-patch.mjs"
cp -p "$RELEASE_CLEAN" "$OLD_INLINE"
printf '\nfunction createProxyLifecycle() {}\n' >> "$OLD_INLINE"
assert_patch_rejection "旧 inline lifecycle patch" "$OLD_INLINE" "仍残留旧 inline lifecycle 实现"

# ---------- 用例 2：只有明确的空 release 才允许 fallback ----------
OUT2=$(run_sync "$API_BASE/empty-404" 2>&1)
echo "--- case empty 404 output ---"; echo "$OUT2"
V2=$(cat "$FAKE/UPSTREAM_VERSION")
[ "$V2" = "master@$MASTER_HEAD" ] || fail "empty 404 应为 master@$MASTER_HEAD，实际: $V2"
grep -Fq 'master-restored' "$FAKE/upstream/proxy.mjs" || fail "empty 404 应同步 master"
echo "$OUT2" | grep -Fq 'No upstream release found' || fail "empty 404 应打印回退提示"
ok "明确 404 Not Found 回退 master"

OUT_EMPTY_NULL=$(run_sync "$API_BASE/empty-null" 2>&1)
echo "--- case empty null output ---"; echo "$OUT_EMPTY_NULL"
[ "$(cat "$FAKE/UPSTREAM_VERSION")" = "master@$MASTER_HEAD" ] || fail "empty null 应保持 master@$MASTER_HEAD"
ok "明确 tag_name:null 空 release 回退 master"

# ---------- 用例 3：API 错误不能伪装成无 release ----------
for spec in forbidden:403 rate-limit:429 server-error:500; do
  route=${spec%%:*}
  status=${spec##*:}
  expect_failure "api-$status" "$API_BASE/$route"
done
expect_failure api-malformed "$API_BASE/malformed"
expect_failure api-missing-tag "$API_BASE/missing-tag"
expect_failure api-invalid-tag "$API_BASE/invalid-tag"
expect_failure api-bad-not-found "$API_BASE/bad-not-found"
expect_failure api-network-error "$API_BASE/drop"

# ---------- 用例 4：上游预期文件必须是 regular file ----------
expect_failure upstream-symlink "$API_BASE/symlink-release"
grep -Fq '拒绝符号链接' "$T/upstream-symlink.out" || fail "symlink 用例未明确报告符号链接"
ok "symlink 输入被明确拒绝"
expect_failure upstream-directory "$API_BASE/directory-release"
grep -Fq 'regular file' "$T/upstream-directory.out" || fail "directory 用例未明确报告 regular file 边界"
ok "目录输入被明确拒绝"

# ---------- 用例 5：版本 rename 失败时目录 rollback ----------
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
  sed -n '1,120p' "$VERSION_FAILURE_OUT"
  fail "版本 rename 失败用例应失败"
fi
echo "--- version rename failure output ---"
sed -n '1,120p' "$VERSION_FAILURE_OUT"
assert_target_unchanged version-rename-failure
ok "版本 rename 失败后 rollback 保持旧目录和旧版本"

# ---------- 用例 6：目录交换后收到可捕获中断时 rollback ----------
INTERRUPT_MARKER="$T/interrupt-sent"
snapshot_target interrupt-after-swap
INTERRUPT_OUT="$T/interrupt-after-swap.out"
if ( cd "$FAKE" && REAL_MV="$MV_REAL" MV_MODE=interrupt-after-swap INTERRUPT_MARKER="$INTERRUPT_MARKER" \
  PATH="$T/fail-mv-bin:$PATH" UPSTREAM_URL="file://$UP" UPSTREAM_API="$API_BASE/release" \
  bash scripts/sync-upstream.sh ) > "$INTERRUPT_OUT" 2>&1; then
  sed -n '1,120p' "$INTERRUPT_OUT"
  fail "目录交换中断用例应失败"
fi
echo "--- interrupt after swap output ---"
sed -n '1,120p' "$INTERRUPT_OUT"
assert_target_unchanged interrupt-after-swap
ok "目录交换中断后 rollback 保持旧目录和旧版本"

echo
echo "sync-upstream fixture tests passed ($PASS checks)."
