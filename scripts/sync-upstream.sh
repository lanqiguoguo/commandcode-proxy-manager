#!/usr/bin/env bash
# 上游同步：优先拉取 commandcode-proxy 最新 release tag（无 release 时回退 master）
# → vendored 到 upstream/ → 记录版本
# 用法：npm run sync:upstream
# 可测性环境变量（生产默认即下方值，行为不变）：
#   UPSTREAM_URL   上游 git 仓库 URL（本地测试可用 file:// fixture）
#   UPSTREAM_API   releases/latest 的 API URL（本地测试可用 file:// JSON）
set -euo pipefail
cd "$(dirname "$0")/.."

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/MAXeaglet/commandcode-proxy.git}"
UPSTREAM_API="${UPSTREAM_API:-https://api.github.com/repos/MAXeaglet/commandcode-proxy/releases/latest}"

TMP=$(mktemp -d)
# STAGE 在此后定义；trap 执行时若已赋值则一并清理（原子同步的暂存目录）
trap 'rm -rf "$TMP" ${STAGE:-}' EXIT

# 查询最新 release tag；API 不可达 / 无 release / 响应无 tag_name 均视为「无 release」（返回空）
if ! API_RESPONSE=$(curl -s --connect-timeout 10 --max-time 30 -L "$UPSTREAM_API" 2>/dev/null); then
  echo "WARNING: upstream release API unreachable ($UPSTREAM_API); treating as no release." >&2
  API_RESPONSE=""
fi
LATEST_RELEASE=$(printf '%s' "$API_RESPONSE" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)

if [ -n "$LATEST_RELEASE" ]; then
  REF="$LATEST_RELEASE"
  echo "==> Fetching upstream release $REF..."
else
  REF="master"
  echo "==> No upstream release found; fetching upstream master..."
fi

git clone --depth 1 --branch "$REF" "$UPSTREAM_URL" "$TMP/upstream" >/dev/null 2>&1

COMMIT=$(git -C "$TMP/upstream" rev-parse HEAD)
if [ "$REF" = "master" ]; then
  # 无 release：行为与现状一致，恒记 master
  TAG="master"
else
  # release 路径下浅克隆单 tag 检出中 `git describe --tags --abbrev=0` 即返回该 tag（已实测）；
  # 若异常回退或与预期不符，直接使用 LATEST_RELEASE，避免静默错标。
  TAG=$(git -C "$TMP/upstream" describe --tags --abbrev=0 2>/dev/null || echo "$LATEST_RELEASE")
  if [ "$TAG" != "$LATEST_RELEASE" ]; then
    echo "WARNING: git describe returned '$TAG' instead of release tag '$LATEST_RELEASE'; using '$LATEST_RELEASE'." >&2
    TAG="$LATEST_RELEASE"
  fi
fi

mkdir -p upstream
# L-f：原子同步——先在 upstream/.sync-tmp/ 完成全部拷贝与改写（含语法校验），
# 全部成功后才逐个 mv 原子替换；中途失败（磁盘满/中断/校验不过）由 set -e 退出，
# EXIT trap 清理 .sync-tmp，upstream/ 保持旧状态，不留"新 proxy + 旧 config"混合态
# （此前逐文件 cp + sed -i 分步写，CI 会带半成品开 PR）。
STAGE="upstream/.sync-tmp"
mkdir -p "$STAGE"
cp "$TMP/upstream/proxy.mjs" "$STAGE/proxy.mjs"
cp "$TMP/upstream/config.json" "$STAGE/config.json"
cp "$TMP/upstream/package.json" "$STAGE/package.json"
# 上游只监听 127.0.0.1（由管理网关内部转发），避免内部端口暴露
sed -i 's/"host": "0.0.0.0"/"host": "127.0.0.1"/' "$STAGE/config.json"
# 语法冒烟：stdin 校验需 --input-type=module 才会按 ESM（import/export）解析
if command -v node >/dev/null 2>&1; then
  if ! node --input-type=module --check < "$STAGE/proxy.mjs" 2>/dev/null; then
    echo "ERROR: vendored proxy.mjs 语法校验失败，放弃本次同步（upstream/ 未改动）" >&2
    exit 1
  fi
fi
# 全部就绪后逐个原子替换（同目录 rename）；版本号最后写（同步完成的标记）
mv "$STAGE/proxy.mjs" upstream/proxy.mjs
mv "$STAGE/config.json" upstream/config.json
mv "$STAGE/package.json" upstream/package.json
rmdir "$STAGE" 2>/dev/null || true

echo "$TAG@$COMMIT" > UPSTREAM_VERSION
echo "==> Synced upstream $TAG@$COMMIT"
if git diff --stat -- upstream UPSTREAM_VERSION | grep -q .; then
  echo "==> Changes:"
  git diff --stat -- upstream UPSTREAM_VERSION
else
  echo "==> No changes since last sync."
fi
