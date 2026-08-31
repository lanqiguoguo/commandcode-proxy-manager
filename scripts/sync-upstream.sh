#!/usr/bin/env bash
# 上游同步：拉取 commandcode-proxy master → vendored 到 upstream/ → 记录版本
# 用法：npm run sync:upstream
set -euo pipefail
cd "$(dirname "$0")/.."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "==> Fetching upstream master..."
git clone --depth 1 https://github.com/MAXeaglet/commandcode-proxy.git "$TMP/upstream" >/dev/null 2>&1

COMMIT=$(git -C "$TMP/upstream" rev-parse HEAD)
TAG=$(git -C "$TMP/upstream" describe --tags --abbrev=0 2>/dev/null || echo master)

mkdir -p upstream
cp "$TMP/upstream/proxy.mjs" upstream/proxy.mjs
cp "$TMP/upstream/config.json" upstream/config.json
cp "$TMP/upstream/package.json" upstream/package.json
# 上游只监听 127.0.0.1（由管理网关内部转发），避免内部端口暴露
sed -i 's/"host": "0.0.0.0"/"host": "127.0.0.1"/' upstream/config.json

echo "$TAG@$COMMIT" > UPSTREAM_VERSION
echo "==> Synced upstream $TAG@$COMMIT"
if git diff --stat -- upstream UPSTREAM_VERSION | grep -q .; then
  echo "==> Changes:"
  git diff --stat -- upstream UPSTREAM_VERSION
else
  echo "==> No changes since last sync."
fi
