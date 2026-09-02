#!/usr/bin/env bash
# 上游同步：优先拉取 commandcode-proxy 最新 release tag（没有 release 时回退 master）
# -> vendored 到 upstream/ -> 记录版本
# 用法：npm run sync:upstream
# 可测性环境变量（生产默认即下方值，行为不变）：
#   UPSTREAM_URL   上游 git 仓库 URL（本地测试可用 file:// fixture）
#   UPSTREAM_API   releases/latest 的 API URL（本地测试使用 HTTP fixture）
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT_DIR=$PWD
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/MAXeaglet/commandcode-proxy.git}"
UPSTREAM_API="${UPSTREAM_API:-https://api.github.com/repos/MAXeaglet/commandcode-proxy/releases/latest}"
UPSTREAM_DIR="$ROOT_DIR/upstream"
VERSION_FILE="$ROOT_DIR/UPSTREAM_VERSION"

has_path() {
  [[ -e "$1" || -L "$1" ]]
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_regular_file() {
  local path=$1
  local label=${2:-$path}
  if [[ -L "$path" ]]; then
    die "$label 必须是 regular file；拒绝符号链接"
  fi
  if [[ ! -f "$path" ]]; then
    die "$label 必须是 regular file；拒绝目录、缺失路径和其他非普通文件"
  fi
}

require_git_object_id() {
  local object_id=$1
  if [[ ! "$object_id" =~ ^[0-9a-fA-F]{40}$ && ! "$object_id" =~ ^[0-9a-fA-F]{64}$ ]]; then
    die "上游 tag 对应的 commit id 格式无效：$object_id"
  fi
}

TMP=$(mktemp -d)
STAGE=""
BACKUP=""
VERSION_STAGE=""
OLD_MOVED=0
NEW_INSTALLED=0
SYNC_COMMITTED=0

# 事务状态在 EXIT trap 中恢复。SIGKILL 无法捕获，但普通错误和可捕获中断
# 都不会把新旧 upstream 文件混在一起。
finish() {
  local status=$?
  local rollback_failed=0
  trap - EXIT INT TERM HUP

  if (( status != 0 && SYNC_COMMITTED == 0 )); then
    if (( NEW_INSTALLED == 1 )) && has_path "$UPSTREAM_DIR"; then
      if ! rm -rf -- "$UPSTREAM_DIR"; then
        printf 'ERROR: rollback 无法移除新的 upstream/\n' >&2
        rollback_failed=1
      fi
    fi
    if (( OLD_MOVED == 1 )) && has_path "$BACKUP"; then
      if has_path "$UPSTREAM_DIR"; then
        printf 'ERROR: rollback 拒绝把旧的 upstream/ 嵌套恢复到现有目标\n' >&2
        rollback_failed=1
      elif ! mv -- "$BACKUP" "$UPSTREAM_DIR"; then
        printf 'ERROR: rollback 无法恢复旧的 upstream/\n' >&2
        rollback_failed=1
      fi
    fi
  fi

  if (( SYNC_COMMITTED == 1 )) && [[ -n "$BACKUP" ]] && has_path "$BACKUP"; then
    rm -rf -- "$BACKUP" || printf 'WARNING: 无法清理旧的 upstream 备份：%s\n' "$BACKUP" >&2
  elif (( SYNC_COMMITTED == 0 && OLD_MOVED == 0 )) && [[ -n "$BACKUP" ]] && has_path "$BACKUP"; then
    rm -rf -- "$BACKUP" || printf 'WARNING: 无法清理未使用的 upstream 备份目录：%s\n' "$BACKUP" >&2
  fi
  if [[ -n "$STAGE" ]] && has_path "$STAGE"; then
    rm -rf -- "$STAGE" || printf 'WARNING: 无法清理同步暂存目录：%s\n' "$STAGE" >&2
  fi
  if [[ -n "$VERSION_STAGE" ]] && has_path "$VERSION_STAGE"; then
    rm -f -- "$VERSION_STAGE" || printf 'WARNING: 无法清理版本暂存文件：%s\n' "$VERSION_STAGE" >&2
  fi
  rm -rf -- "$TMP" || printf 'WARNING: 无法清理临时目录：%s\n' "$TMP" >&2

  if (( rollback_failed == 1 )); then
    status=1
  fi
  exit "$status"
}
restore_signal_traps() {
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}
trap finish EXIT
restore_signal_traps

# 目标路径本身也不能是会把 rename 导向工作区外的链接或非目录。
if has_path "$UPSTREAM_DIR" && { [[ -L "$UPSTREAM_DIR" ]] || [[ ! -d "$UPSTREAM_DIR" ]]; }; then
  die "目标 upstream/ 必须是目录；拒绝符号链接和其他非目录"
fi
if has_path "$VERSION_FILE" && [[ -L "$VERSION_FILE" || ! -f "$VERSION_FILE" ]]; then
  die "目标 UPSTREAM_VERSION 必须是 regular file；拒绝符号链接和其他非普通文件"
fi

if ! command -v curl >/dev/null 2>&1; then
  die "找不到 curl，无法读取 release API"
fi
if ! command -v git >/dev/null 2>&1; then
  die "找不到 git，无法同步上游"
fi
if ! command -v node >/dev/null 2>&1; then
  die "找不到 node，无法严格解析 release API JSON"
fi

API_BODY="$TMP/release-api.json"
API_STATUS_FILE="$TMP/release-api.status"
if ! curl -sS --connect-timeout 10 --max-time 30 -L \
  --output "$API_BODY" --write-out '%{http_code}' "$UPSTREAM_API" > "$API_STATUS_FILE"; then
  die "release API 请求失败（网络错误或响应不完整）：$UPSTREAM_API"
fi

HTTP_STATUS=$(<"$API_STATUS_FILE")
# curl 对 file:// 没有 HTTP 状态码；保留该本地 fixture 入口，但仍要求 curl
# 成功并对响应体执行同样的 JSON/shape 校验。真实 HTTP(S) 请求必须有明确状态。
if [[ "$UPSTREAM_API" == file://* && "$HTTP_STATUS" == 000 ]]; then
  HTTP_STATUS=200
fi
if [[ ! "$HTTP_STATUS" =~ ^[0-9]{3}$ ]]; then
  die "release API 返回了无效 HTTP 状态：$HTTP_STATUS"
fi
case "$HTTP_STATUS" in
  200|404) ;;
  *) die "release API HTTP 状态不可接受：$HTTP_STATUS（不会回退 master）" ;;
esac

# 404 只有在 JSON 明确表示 GitHub 的 Not Found（无 published release）时
# 才是允许的 fallback；200 的 tag_name:null 是 fixture/API 对“空 release”
# 的明确表示。其它合法 JSON 也不能因为没有 tag_name 而默默走 master。
if ! API_RESULT=$(node - "$API_BODY" "$HTTP_STATUS" <<'NODE'
const fs = require("node:fs");

const bodyPath = process.argv[2];
const status = Number(process.argv[3]);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (message) => {
  console.error(`release API JSON 无效：${message}`);
  process.exit(1);
};

let payload;
try {
  payload = JSON.parse(fs.readFileSync(bodyPath, "utf8"));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (!isObject(payload)) fail("顶层必须是 JSON object");

if (status === 404) {
  if (payload.message === "Not Found" && (!hasOwn(payload, "tag_name") || payload.tag_name === null)) {
    console.log("NO_RELEASE");
    process.exit(0);
  }
  fail("404 不是明确的无 release 响应");
}

if (hasOwn(payload, "tag_name") && payload.tag_name === null) {
  console.log("NO_RELEASE");
  process.exit(0);
}
if (!hasOwn(payload, "tag_name") || typeof payload.tag_name !== "string" || payload.tag_name === "") {
  fail("200 响应必须包含非空字符串 tag_name，或明确的 tag_name:null");
}
console.log(payload.tag_name);
NODE
); then
  die "release API JSON/响应结构校验失败（不会回退 master）"
fi

if [[ "$API_RESULT" == "NO_RELEASE" ]]; then
  REF=master
  TAG=master
  echo "==> No upstream release found; fetching upstream master..."
else
  LATEST_RELEASE=$API_RESULT
  TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?(\+[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$'
  if [[ ! "$LATEST_RELEASE" =~ $TAG_PATTERN ]]; then
    die "release tag 格式无效：$LATEST_RELEASE"
  fi
  REF=$LATEST_RELEASE
  TAG=$LATEST_RELEASE
  echo "==> Fetching upstream release $REF..."

  # 先确认远端确实存在同名 tag，并取 annotated/lightweight tag 的 commit
  # 目标；不能只相信 API 返回的字符串或 git describe 的偶然结果。
  if ! REMOTE_TAGS=$(git ls-remote "$UPSTREAM_URL" \
    "refs/tags/$LATEST_RELEASE" "refs/tags/$LATEST_RELEASE^{}"); then
    die "无法读取上游 release tag：$LATEST_RELEASE（不会回退 master）"
  fi
  REMOTE_TAG_REF="refs/tags/$LATEST_RELEASE"
  REMOTE_PEELED_REF="${REMOTE_TAG_REF}^{}"
  REMOTE_TAG_HASH=$(awk -v ref="$REMOTE_TAG_REF" '$2 == ref { print $1; exit }' <<< "$REMOTE_TAGS")
  REMOTE_PEELED_HASH=$(awk -v ref="$REMOTE_PEELED_REF" '$2 == ref { print $1; exit }' <<< "$REMOTE_TAGS")
  if [[ -n "$REMOTE_PEELED_HASH" ]]; then
    REMOTE_TAG_COMMIT=$REMOTE_PEELED_HASH
  else
    REMOTE_TAG_COMMIT=$REMOTE_TAG_HASH
  fi
  if [[ -z "$REMOTE_TAG_COMMIT" ]]; then
    die "上游不存在 release tag：$LATEST_RELEASE（不会回退 master）"
  fi
  require_git_object_id "$REMOTE_TAG_COMMIT"
fi

if ! git clone --quiet --depth 1 --branch "$REF" "$UPSTREAM_URL" "$TMP/upstream"; then
  die "无法 checkout 上游 ref：$REF"
fi
if ! COMMIT=$(git -C "$TMP/upstream" rev-parse --verify HEAD^{commit}); then
  die "无法解析上游 checkout 的 HEAD commit"
fi
require_git_object_id "$COMMIT"

if [[ "$REF" != master ]]; then
  if ! LOCAL_TAG_COMMIT=$(git -C "$TMP/upstream" rev-parse --verify "$TAG^{commit}"); then
    die "checkout 中找不到 release tag：$TAG"
  fi
  require_git_object_id "$LOCAL_TAG_COMMIT"
  if [[ "$COMMIT" != "$LOCAL_TAG_COMMIT" || "$COMMIT" != "$REMOTE_TAG_COMMIT" ]]; then
    die "release tag 与 checkout HEAD commit 不一致：tag=$REMOTE_TAG_COMMIT local=$LOCAL_TAG_COMMIT head=$COMMIT"
  fi
fi

# 在任何目标文件发生变化前，拒绝 checkout 中的符号链接、目录、FIFO、设备
# 和其它非普通文件。所有这些检查都发生在 mkdir/mv 之前。
for name in proxy.mjs config.json package.json; do
  require_regular_file "$TMP/upstream/$name" "上游 $name"
done

STAGE=$(mktemp -d "$ROOT_DIR/.upstream-sync.XXXXXX")
for name in proxy.mjs config.json package.json; do
  if ! cp -P -- "$TMP/upstream/$name" "$STAGE/$name"; then
    die "无法复制上游 $name 到暂存目录"
  fi
  require_regular_file "$STAGE/$name" "暂存 $name"
done

# 上游只监听 127.0.0.1（由管理网关内部转发），避免内部端口暴露。
if ! sed -i 's/"host": "0.0.0.0"/"host": "127.0.0.1"/' "$STAGE/config.json"; then
  die "无法改写暂存 config.json"
fi
if ! node --input-type=module --check < "$STAGE/proxy.mjs"; then
  die "vendored proxy.mjs 语法校验失败，放弃本次同步（upstream/ 未改动）"
fi

# 版本文件与其目标在同一目录，保证后续 rename 是单文件原子替换；先准备好
# 内容，避免版本写入失败发生在目录交换之后。
VERSION_STAGE=$(mktemp "$ROOT_DIR/.UPSTREAM_VERSION.XXXXXX")
if ! printf '%s\n' "$TAG@$COMMIT" > "$VERSION_STAGE"; then
  die "无法写入版本暂存文件（upstream/ 未改动）"
fi
if ! chmod 0644 "$VERSION_STAGE"; then
  die "无法设置版本暂存文件权限（upstream/ 未改动）"
fi

# 目录级交换：旧目录先移到同级备份，新目录再一次 rename 到 upstream/。
# 任何后续失败都由 EXIT trap 删除新目录并恢复旧目录。
if has_path "$UPSTREAM_DIR"; then
  BACKUP=$(mktemp -d "$ROOT_DIR/.upstream-backup.XXXXXX")
  if ! rmdir "$BACKUP"; then
    die "无法准备 upstream/ 回滚备份目录"
  fi
  # 先置位以覆盖 rename 成功后、命令返回前的中断窗口；失败分支再按路径
  # 校正，避免把仍在原位的旧目录误判为已移动并嵌套恢复。
  OLD_MOVED=1
  if ! mv -- "$UPSTREAM_DIR" "$BACKUP"; then
    if has_path "$UPSTREAM_DIR" || ! has_path "$BACKUP"; then
      OLD_MOVED=0
    fi
    die "无法暂存旧的 upstream/"
  fi
fi

# 在 rename 前设置状态，避免 mv 成功后恰好收到可捕获信号时 rollback 误把
# 已安装目录当作旧目录；若 mv 失败，upstream/ 此时应仍为空或不存在。
NEW_INSTALLED=1
if ! mv -- "$STAGE" "$UPSTREAM_DIR"; then
  if ! has_path "$UPSTREAM_DIR"; then
    NEW_INSTALLED=0
  fi
  die "无法安装新的 upstream/"
fi

# 版本标记与目录交换共同构成一次提交。屏蔽可捕获信号，覆盖版本 rename
# 成功到 SYNC_COMMITTED 置位的窗口；否则 EXIT trap 可能回滚目录却保留新标记。
trap '' HUP INT TERM
if ! mv -- "$VERSION_STAGE" "$VERSION_FILE"; then
  restore_signal_traps
  die "无法原子安装 UPSTREAM_VERSION；正在恢复旧 upstream/"
fi
SYNC_COMMITTED=1
restore_signal_traps

echo "==> Synced upstream $TAG@$COMMIT"
if git diff --stat -- upstream UPSTREAM_VERSION | grep -q .; then
  echo "==> Changes:"
  git diff --stat -- upstream UPSTREAM_VERSION
else
  echo "==> No changes since last sync."
fi
