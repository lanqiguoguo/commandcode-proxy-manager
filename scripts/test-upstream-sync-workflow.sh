#!/usr/bin/env bash
# upstream-sync.yml 的静态和本地 fixture 测试。
# 测试直接提取 workflow 的 Check latest upstream shell，避免复制一份
# 决策逻辑后测试到漂移的实现。
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
WORKFLOW="$ROOT_DIR/.github/workflows/upstream-sync.yml"
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

[[ -f "$WORKFLOW" ]] || fail "workflow 不存在"

# ---------- workflow 静态边界 ----------
ACTION_COUNT=0
while IFS= read -r action_ref; do
  [[ "$action_ref" =~ ^[0-9a-fA-F]{40}$ || "$action_ref" =~ ^[0-9a-fA-F]{64}$ ]] || \
    fail "action 未固定到完整 commit SHA：$action_ref"
  ACTION_COUNT=$((ACTION_COUNT + 1))
done < <(sed -nE 's/^[[:space:]]*uses:[[:space:]]+[^@]+@([^[:space:]#]+).*/\1/p' "$WORKFLOW")
[[ "$ACTION_COUNT" -gt 0 ]] || fail "未找到 action 引用"
ok "所有 $ACTION_COUNT 个 action 引用均为完整 commit SHA"

grep -Fqx 'permissions: {}' "$WORKFLOW" || fail "缺少默认 deny permissions"
grep -Fq '    permissions:' "$WORKFLOW" || fail "缺少 job-level permissions"
grep -Fq '      contents: read' "$WORKFLOW" || fail "check job 缺少 contents: read"
grep -Fq '      contents: write' "$WORKFLOW" || fail "sync job 缺少 contents: write"
grep -Fq '      pull-requests: write' "$WORKFLOW" || fail "sync job 缺少 pull-requests: write"
ok "权限按 check/sync job 收窄"

[[ $(rg -c '^[[:space:]]+GH_TOKEN:' "$WORKFLOW") -eq 1 ]] || fail "GITHUB_TOKEN 不应暴露到多个 workflow step"
[[ $(rg -c 'persist-credentials: false' "$WORKFLOW") -eq 2 ]] || fail "两个 checkout 都必须关闭持久化凭证"
grep -Fq 'git checkout -b "$BRANCH"' "$WORKFLOW" || fail "同步没有创建候选分支"
grep -Fq 'gh pr create' "$WORKFLOW" || fail "同步没有创建 PR"
grep -Fq -- '--base "$BASE_BRANCH"' "$WORKFLOW" || fail "PR 没有固定到默认分支"
ok "同步只推候选分支并创建人工审阅 PR"

# ---------- 从 YAML 提取生产检查脚本 ----------
CHECK_SCRIPT="$T/check.sh"
awk '
  /^      - name: Check latest upstream$/ { in_step = 1; next }
  in_step && /^      - name:/ { exit }
  in_step && /^        run: \|$/ { in_run = 1; next }
  in_run && /^          / { sub(/^          /, ""); print; next }
  in_run && /^[[:space:]]*$/ { print ""; next }
  in_run { exit }
' "$WORKFLOW" > "$CHECK_SCRIPT"
[[ -s "$CHECK_SCRIPT" ]] || fail "无法从 workflow 提取检查脚本"
bash -n "$CHECK_SCRIPT" || fail "提取的 workflow 检查脚本语法错误"
ok "提取并检查 workflow 的真实检查脚本"

# ---------- 构造本地 Git 上游 fixture ----------
UP="$T/upstream-src"
mkdir -p "$UP"
git init -q -b master "$UP"
git -C "$UP" config user.email fixture@test.local
git -C "$UP" config user.name fixture
printf '%s\n' 'export const MARKER = "release-build";' > "$UP/proxy.mjs"
git -C "$UP" add proxy.mjs
git -C "$UP" commit -qm 'release content'
git -C "$UP" tag v9.9.9
RELEASE_COMMIT=$(git -C "$UP" rev-parse 'v9.9.9^{commit}')
printf '%s\n' 'export const MARKER = "master-build";' > "$UP/proxy.mjs"
git -C "$UP" commit -qam 'master-only change'
MASTER_HEAD=$(git -C "$UP" rev-parse HEAD)
UPSTREAM_URL="file://$UP"

# ---------- 构造 HTTP release API fixture ----------
cat > "$T/api-server.mjs" <<'EOF'
import http from "node:http";

const responses = new Map([
  ["/release", [200, '{"tag_name":"v9.9.9"}']],
  ["/empty-404", [404, '{"message":"Not Found"}']],
  ["/empty-null", [200, '{"tag_name":null}']],
  ["/missing-tag", [200, '{"message":"unexpected response"}']],
  ["/malformed", [200, '{"tag_name":']],
  ["/invalid-tag", [200, '{"tag_name":"master"}']],
  ["/missing-release-tag", [200, '{"tag_name":"v9.9.10"}']],
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
    fail 'HTTP API fixture 启动失败'
  fi
  sleep 0.01
done
[[ -s "$T/api-port" ]] || fail 'HTTP API fixture 未发布端口'
API_PORT=$(head -n 1 "$T/api-port")
API_BASE="http://127.0.0.1:$API_PORT"

FAKE="$T/fake-repo"
mkdir -p "$FAKE"

run_check() {
  local label=$1
  local current=$2
  local route=$3
  local expected=$4
  local upstream=${5:-$UPSTREAM_URL}
  local output="$T/$label.output"
  local log="$T/$label.log"
  printf '%s\n' "$current" > "$FAKE/UPSTREAM_VERSION"
  : > "$output"
  if ! ( cd "$FAKE" && GITHUB_OUTPUT="$output" UPSTREAM_URL="$upstream" \
    UPSTREAM_API="$API_BASE/$route" bash "$CHECK_SCRIPT" > "$log" 2>&1 ); then
    sed -n '1,120p' "$log" >&2
    fail "$label 应成功"
  fi
  grep -Fqx "need_sync=$expected" "$output" || {
    sed -n '1,120p' "$log" >&2
    cat "$output" >&2
    fail "$label 的 need_sync 应为 $expected"
  }
  ok "$label -> need_sync=$expected"
}

expect_failure() {
  local label=$1
  local current=$2
  local route=$3
  local expected_error=$4
  local upstream=${5:-$UPSTREAM_URL}
  local output="$T/$label.output"
  local log="$T/$label.log"
  printf '%s\n' "$current" > "$FAKE/UPSTREAM_VERSION"
  rm -f -- "$output"
  if ( cd "$FAKE" && GITHUB_OUTPUT="$output" UPSTREAM_URL="$upstream" \
    UPSTREAM_API="$API_BASE/$route" bash "$CHECK_SCRIPT" > "$log" 2>&1 ); then
    sed -n '1,120p' "$log" >&2
    fail "$label 应失败"
  fi
  [[ ! -s "$output" ]] || fail "$label 失败时不应输出 need_sync"
  grep -Fq "$expected_error" "$log" || {
    sed -n '1,120p' "$log" >&2
    fail "$label 未报告 $expected_error"
  }
  ok "$label 失败且保持 fail-closed"
}

OLD_RELEASE='v1.0.0@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
OLD_MASTER="master@$RELEASE_COMMIT"
CURRENT_RELEASE="v9.9.9@$RELEASE_COMMIT"
CURRENT_MASTER="master@$MASTER_HEAD"

# release：新 tag 需要同步，同 tag + 同 commit 不需要同步；tag 变化也必须
# 比较 commit，避免同名 tag 被移动后静默跳过。
run_check release-new-tag "$OLD_RELEASE" release 1
run_check release-same-tag "$CURRENT_RELEASE" release 0
run_check no-release-404 "$OLD_MASTER" empty-404 1
run_check no-release-404-current "$CURRENT_MASTER" empty-404 0
run_check no-release-null "$OLD_MASTER" empty-null 1
run_check no-release-preserves-release "$CURRENT_RELEASE" empty-404 0

# HTTP/API 错误、畸形 JSON、无效 tag、错误的 404 和缺失 tag 均不得变成
# 空 release，也不得输出 need_sync=1 去触发同步。
for spec in forbidden:403 rate-limit:429 server-error:500; do
  route=${spec%%:*}
  status=${spec##*:}
  expect_failure "api-$status" "$OLD_MASTER" "$route" "HTTP $status"
done
expect_failure api-network-error "$OLD_MASTER" drop 'release API 请求失败'
expect_failure api-malformed "$OLD_MASTER" malformed '畸形 JSON'
expect_failure api-missing-tag "$OLD_MASTER" missing-tag '响应结构错误'
expect_failure api-invalid-tag "$OLD_MASTER" invalid-tag 'release tag 格式无效'
expect_failure api-bad-not-found "$OLD_MASTER" bad-not-found '404 不是明确的无 release 响应'
expect_failure missing-release-tag "$OLD_MASTER" missing-release-tag '未返回 release tag'

# release/no-release 两条路径的 ls-remote 失败都必须终止检查。
MISSING_UPSTREAM="file://$T/no-such-upstream"
expect_failure release-ls-remote-error "$OLD_MASTER" release 'ls-remote 查询 release tag 失败' "$MISSING_UPSTREAM"
expect_failure master-ls-remote-error "$OLD_MASTER" empty-404 'ls-remote 查询 master 失败' "$MISSING_UPSTREAM"

echo
echo "upstream-sync workflow fixture tests passed ($PASS checks)."
