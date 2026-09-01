#!/usr/bin/env bash
# sync-upstream.sh 的本地 fixture 测试（不触碰真实上游）。
# 在 /tmp 构造 file:// 上游 git 仓库 + 假目标仓库，验证：
#   1) 有 release：clone --branch tag，UPSTREAM_VERSION = <tag>@<tag-commit>，vendored 文件来自 tag 内容；
#   2) 无 release（API 返回无 tag_name）：回退 master，UPSTREAM_VERSION = master@<master-head>；
#   3) API 不可达：打 warning 后同样回退 master，不中断；
#   4) sed host 改写在两条路径下均生效（config.json 的 0.0.0.0 → 127.0.0.1）。
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

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
cat > proxy.mjs <<'EOF'
export const MARKER = "release-build";
EOF
printf '{\n  "host": "0.0.0.0",\n  "port": 3050\n}\n' > config.json
printf '{\n  "name": "commandcode-proxy",\n  "version": "9.9.9"\n}\n' > package.json
git add . && git commit -qm "release content"
git tag v9.9.9
# tag 之后再推一个 master-only commit，用于证明两条路径拉到的内容不同
printf '%s\n' 'export const MARKER = "master-build";' > proxy.mjs
git commit -qam "master-only change"
MASTER_HEAD=$(git rev-parse HEAD)
TAG_COMMIT=$(git rev-parse v9.9.9^{commit})
cd "$ROOT_DIR"

# ---------- 构造假目标仓库（跑 sync 脚本的地方） ----------
FAKE="$T/fake-repo"
mkdir -p "$FAKE/scripts" "$FAKE/upstream"
cp "$ROOT_DIR/scripts/sync-upstream.sh" "$FAKE/scripts/"
printf 'old\n' > "$FAKE/upstream/proxy.mjs"
printf 'old\n' > "$FAKE/upstream/config.json"
printf 'old\n' > "$FAKE/upstream/package.json"
printf 'placeholder\n' > "$FAKE/UPSTREAM_VERSION"
( cd "$FAKE" && git init -q -b main . && git config user.email f@f.local && git config user.name f \
  && git add -A && git commit -qm base )

run_sync() { # $1=UPSTREAM_API 值
  ( cd "$FAKE" && UPSTREAM_URL="file://$UP" UPSTREAM_API="$1" bash scripts/sync-upstream.sh )
}

# ---------- 用例 1：有 release ----------
API1="$T/api-release.json"
printf '{"tag_name": "v9.9.9", "name": "v9.9.9"}\n' > "$API1"
OUT1=$(run_sync "file://$API1" 2>&1)
echo "--- case 1 output ---"; echo "$OUT1"
V1=$(cat "$FAKE/UPSTREAM_VERSION")
[ "$V1" = "v9.9.9@$TAG_COMMIT" ] || fail "case1 UPSTREAM_VERSION 应为 v9.9.9@$TAG_COMMIT，实际: $V1"
ok "case1 UPSTREAM_VERSION = $V1"
grep -q 'release-build' "$FAKE/upstream/proxy.mjs" || fail "case1 vendored proxy.mjs 应来自 tag 内容"
ok "case1 vendored 内容来自 release tag（非 master）"
grep -q '"host": "127.0.0.1"' "$FAKE/upstream/config.json" || fail "case1 sed host 改写未生效"
if grep -q '"host": "0.0.0.0"' "$FAKE/upstream/config.json"; then fail "case1 config.json 残留 0.0.0.0"; fi
ok "case1 sed host 改写生效"
echo "$OUT1" | grep -q 'Fetching upstream release v9.9.9' || fail "case1 应走 release 路径"
ok "case1 走 release 路径"

# ---------- 用例 2：无 release（API 有响应但无 tag_name） ----------
API2="$T/api-empty.json"
printf '{"message": "Not Found"}\n' > "$API2"
OUT2=$(run_sync "file://$API2" 2>&1)
echo "--- case 2 output ---"; echo "$OUT2"
V2=$(cat "$FAKE/UPSTREAM_VERSION")
[ "$V2" = "master@$MASTER_HEAD" ] || fail "case2 UPSTREAM_VERSION 应为 master@$MASTER_HEAD，实际: $V2"
ok "case2 UPSTREAM_VERSION = $V2"
grep -q 'master-build' "$FAKE/upstream/proxy.mjs" || fail "case2 vendored proxy.mjs 应来自 master"
grep -q '"host": "127.0.0.1"' "$FAKE/upstream/config.json" || fail "case2 sed host 改写未生效"
ok "case2 回退 master：内容与 sed 改写均正确"
echo "$OUT2" | grep -q 'No upstream release found' || fail "case2 应打印回退提示"
ok "case2 打印无 release 回退提示"

# ---------- 用例 3：API 不可达 ----------
OUT3=$(run_sync "file://$T/definitely-missing.json" 2>&1)
echo "--- case 3 output ---"; echo "$OUT3"
V3=$(cat "$FAKE/UPSTREAM_VERSION")
[ "$V3" = "master@$MASTER_HEAD" ] || fail "case3 API 不可达应回退 master，实际: $V3"
echo "$OUT3" | grep -q "WARNING: upstream release API unreachable" || fail "case3 应打印 API 不可达 warning"
ok "case3 API 不可达：打印 warning、未中断且回退 master@$MASTER_HEAD"

echo
echo "sync-upstream fixture tests passed ($PASS checks)."
