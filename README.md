# commandcode-proxy-manager

独立的多 Key 管理网关，为 [commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy)
提供主备 Key 池、有限重试与退避、额度看板、持久化统计和管理界面。上游文件以 vendored
方式原样放在 `upstream/`，管理器不改写这些文件。

> 仅供学习研究。请遵守 Command Code 服务条款，并保持与正常 CLI 一致的使用频率。

## 核心架构

本项目使用单容器、两个独立 Node 进程的拓扑：manager 负责公共 HTTP 网关和管理功能，raw
upstream 负责原始协议转换和对 Command Code API 的访问。

```text
OpenAI / Anthropic SDK ──► manager :3080
                              │ /v1/*、/admin、/health
                              │
                    ┌─────────┴──────────────────────────────┐
                    │ container                                │
                    │ manager: node src/server.mjs             │
                    │    │                                     │
                    │    └─ process.execPath proxy.mjs         │
                    │       raw upstream: 127.0.0.1:3050       │
                    │       （仅容器内部，不能从宿主机直接访问） │
                    └──────────────────────────────────────────┘
                              │
                              └── api.commandcode.ai
```

### 托管模式

`EMBED_UPSTREAM=1` 或未设置时为托管模式，也是默认模式。manager 使用
`process.execPath` 在 `upstream/` 工作目录启动 `proxy.mjs`，并强制给子进程设置
`HOST=127.0.0.1`、`PORT=UPSTREAM_PORT`。manager 等待 raw upstream 的 `GET /health`
返回 2xx 后，才开始监听自己的 `HOST:PORT`。

托管模式的上游端口默认是 `3050`，只供容器内部使用。宿主机只需要映射 manager 的
`PORT`，不要发布 `3050`。

### 外置模式

`EMBED_UPSTREAM=0` 时 manager 完全不创建上游子进程，直接连接
`UPSTREAM_HOST:UPSTREAM_PORT`。外置服务需要由用户单独启动并保证容器可达。manager
仍会先监听自己的端口；如果外置上游不可达，`/health` 返回 502 `UPSTREAM_DOWN`，网关请求
返回上游连接错误。

### 责任边界

- manager 负责 client/admin 鉴权、Key 池、重试和退避、额度探测、统计、管理 API 以及子进程生命周期。
- raw upstream 负责 OpenAI/Anthropic 协议转换、请求格式、初始化并发、指纹、会话、版本刷新和对官方 API 的访问。
- `upstream/proxy.mjs`、`upstream/config.json` 和 `upstream/package.json` 是同步得到的原始文件；本项目不在运行时覆盖其实现。

## 快速开始

先按 `EMBED_UPSTREAM` 判断部署模式：

| 设置 | 模式 | 必须准备的上游 |
|---|---|---|
| 未设置或 `1` | manager 托管 raw upstream | 不需要单独启动上游 |
| `0` | 外置上游 | 先启动可从容器访问的上游服务 |

### Docker 托管模式

```bash
docker run -d --name cc-proxy-manager -p 3080:3080 \
  -v ccpm-data:/data \
  ghcr.io/lanqiguoguo/commandcode-proxy-manager:latest
```

上面的命令没有设置 `EMBED_UPSTREAM`，因此 manager 会在容器内启动 raw upstream。它只映射
`3080`，不会把 `3050` 暴露到宿主机。

### Docker Compose 托管模式

```bash
docker compose up -d
```

当前 `docker-compose.yml` 只有 manager 服务，只映射 manager 端口和 `/data` 卷，不映射
`3050`。使用其它公共端口时，Compose 会将 `PORT` 同时用于容器端口和宿主机映射：

```bash
PORT=8080 docker compose up -d
```

### Docker 外置模式

外置服务已经运行且容器可通过 `10.0.0.10:3050` 访问时：

```bash
docker run -d --name cc-proxy-manager -p 3080:3080 \
  -e EMBED_UPSTREAM=0 \
  -e UPSTREAM_HOST=10.0.0.10 \
  -e UPSTREAM_PORT=3050 \
  -v ccpm-data:/data \
  ghcr.io/lanqiguoguo/commandcode-proxy-manager:latest
```

此模式下仍然只映射 `3080`；`UPSTREAM_HOST` 必须替换成实际可达的主机地址。

启动后检查：

```bash
curl -i http://127.0.0.1:3080/health
docker logs -f cc-proxy-manager
```

托管模式只有在 raw upstream ready 后才会开放 manager 端口。成功后 `/health` 返回 `200`
和 `OK`。首次启动没有磁盘令牌时，manager 会生成 `AdminToken`，并写入 `/data/config.json`
和启动日志；管理界面地址为 `http://127.0.0.1:3080/admin`。

## 配置

基础设施变量覆盖 `data/config.json` 中的对应基础配置。`ADMIN_TOKEN` 和 `CLIENT_TOKEN`
只在磁盘中没有值时用于初始化；磁盘已经有值时不会被旧环境变量覆盖。

### manager 变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DATA_DIR` | `./data`（容器为 `/data`） | manager 持久化目录 |
| `PORT` | `3080` | manager 公共监听端口 |
| `HOST` | `0.0.0.0` | manager 监听地址 |
| `UPSTREAM_HOST` | `127.0.0.1` | 外置模式连接的上游主机；托管模式运行时固定为 `127.0.0.1` |
| `UPSTREAM_PORT` | `3050` | 外置模式目标端口；托管模式为 raw upstream 子进程端口 |
| `EMBED_UPSTREAM` | 未设置，按托管处理 | 只有值为 `0` 时关闭子进程托管；设为 `1` 表示托管 |
| `CC_UPSTREAM_STARTUP_TIMEOUT_MS` | `10000` | 托管模式等待 `/health` ready 的超时，允许 `0..120000` 毫秒 |
| `CC_UPSTREAM_SHUTDOWN_TIMEOUT_MS` | `5000` | 发送 `SIGTERM` 后等待 raw upstream 退出的时间，允许 `0..120000` 毫秒 |
| `CC_SHUTDOWN_GRACE_MS` | `10000` | manager 停止接收后等待活动请求和连接排空的时间，允许 `100..120000` 毫秒 |
| `CC_SHUTDOWN_FORCE_WAIT_MS` | `1000` | manager 强制销毁活动连接后的额外等待时间，允许 `100..120000` 毫秒 |
| `ADMIN_TOKEN` | 自动生成 | `/admin` 和 `/admin/api/*` 的管理令牌 |
| `CLIENT_TOKEN` | 空，回退 `ADMIN_TOKEN` | `/v1/*` 客户端令牌 |
| `CC_QUOTA_BASE` | `https://api.commandcode.ai` | manager 额度探测使用的 API 基址；探测失败只保留 stale 快照 |
| `SECURE_COOKIES` | 空 | 设为 `1` 或 `true` 时给管理 SSE cookie 添加 `Secure`，只用于 HTTPS 反向代理 |

### 传给 raw upstream 的变量

下面的变量由 `upstream/proxy.mjs` 读取。在托管模式中，supervisor 允许这些变量从 manager
环境传给 raw upstream；外置模式需要在外置 upstream 自己的进程环境中设置。

| 变量 | raw upstream 默认值 | 说明 |
|---|---|---|
| `CC_API_BASE` | `https://api.commandcode.ai` | raw upstream 请求 Command Code API 的基址 |
| `PROJECT_SLUG` | `cc-proxy` | raw upstream 配置读取的项目 slug |
| `LOG_FILE` | 空 | raw upstream 可选的追加日志文件；为空时只写 stdout/stderr |
| `CC_USE_PROVIDER_MODELS` | `true` | raw upstream 读取；值为 `false` 时关闭 provider model 列表路径 |
| `CC_MAX_BODY_MB` | `100` | raw upstream 请求体大小上限，正整数，单位 MB |

托管子进程的 `HOST` 和 `PORT` 由 manager supervisor 强制设置，不使用外部值覆盖
`127.0.0.1` 和 `UPSTREAM_PORT`。`CC_QUOTA_BASE` 是 manager 的额度探测变量，不是 raw
upstream 的 API 基址。

池策略、重试、退避和历史保留天数在管理界面的设置页修改，并持久化到
`config.json`；它们不是独立的环境变量。

## 客户端和管理界面

OpenAI SDK：

```python
client = OpenAI(
    api_key="你的 CLIENT_TOKEN（未设置时使用 ADMIN_TOKEN）",
    base_url="http://127.0.0.1:3080/v1",
)
client.chat.completions.create(
    model="deepseek/deepseek-v4-flash",
    messages=[{"role": "user", "content": "Hello"}],
)
```

Anthropic SDK 的 `base_url` 指向 `http://127.0.0.1:3080`，`x-api-key` 使用
`CLIENT_TOKEN`。`GET /v1/models` 也需要相同的客户端令牌。

管理界面提供：

- Key 的新增、编辑、启停、删除、主备顺序和有效性测试；
- 5 小时、每周和美元额度状态，以及退避、切换和实测用量；
- 请求历史筛选和 CSV 导出；
- 池策略、重试、退避、额度阈值、历史保留和令牌设置；
- manager 日志和 raw upstream 日志的实时查看。

管理 API 除登录和退出登录外需要 `X-Admin-Token`。主要端点包括
`/admin/api/keys`、`/admin/api/pool`、`/admin/api/history`、`/admin/api/logs` 和
`/admin/api/events`。

## 启动、关闭和日志

### 启动

托管模式的顺序固定为：加载配置和持久化状态，安装日志捕获，启动 raw upstream，轮询
`http://127.0.0.1:UPSTREAM_PORT/health`，收到 2xx 后监听 manager 的 `HOST:PORT`。

如果 raw upstream 端口冲突、进程提前退出、健康检查超时，或者 manager 公共端口冲突，启动
会以退出码 `1` 结束，并回收已创建的 raw upstream。诊断中包含命令、端口、退出状态和最近
的 stdout/stderr 行。

### 正常关闭

manager 作为容器入口进程接收 `SIGTERM` 或 `SIGINT`：

1. 停止接收新连接，并在 `CC_SHUTDOWN_GRACE_MS` 内排空活动请求和连接；
2. 超时后销毁剩余 manager 请求和连接，并等待 `CC_SHUTDOWN_FORCE_WAIT_MS`；
3. 托管模式再向 raw upstream 发送 `SIGTERM`，等待 `CC_UPSTREAM_SHUTDOWN_TIMEOUT_MS`；
4. 仍未退出时发送 `SIGKILL`，完成有界回收。

正常关闭退出码为 `0`。重复信号不会重复执行关闭流程；清理失败或 unexpected upstream
exit 使用非零退出码，当前 manager 路径为 `1`。外置模式没有本地子进程，关闭时不会停止
外置服务。

raw upstream 的 stdout/stderr 会被 manager 接收并逐行转发到 manager 的 stdout/stderr。
因此可以直接查看：

```bash
docker logs -f cc-proxy-manager
```

管理界面的日志页也能看到持久化的 manager 和 raw upstream 记录；管理员可以使用
`GET /admin/api/logs?src=proxy` 筛选 raw upstream 来源。

## 数据和同步

`/data` 中的主要文件：

| 文件 | 内容 |
|---|---|
| `config.json` | manager 端口、上游地址、令牌和池配置 |
| `keys.json` | Key、别名、启用状态和主备顺序，权限为 600 |
| `state.json` | 每 Key 的健康、退避、额度限制和切换状态 |
| `quota-cache.json` | 最近一次额度探测快照 |
| `stats.jsonl` | 请求统计事件 |
| `events.jsonl` | manager 和 raw upstream 系统日志 |

初始化并发、指纹、会话和版本刷新由 raw upstream 的原始版本负责，manager 不复制或
覆盖这些行为。同步脚本只获取上游来源、复制原始文件并写入 `UPSTREAM_VERSION`，不会
在同步阶段改写上游源码。

## 开发

```bash
npm start
npm run dev
```

`npm run dev` 只监视 `src/server.mjs` 及其 manager 代码路径。修改 `upstream/` 后必须
手动停止并重新启动 manager：

```bash
# 修改 upstream/ 后
npm run dev
```

也可以在开发时自行运行 raw upstream，并用 `EMBED_UPSTREAM=0` 让 manager 连接外置服务。
当前没有 upstream 文件变化后的自动重启功能。

## 故障排查

| 现象 | 检查和处理 |
|---|---|
| raw upstream port occupied | 托管模式确认 `UPSTREAM_PORT` 没有被其它进程占用；释放端口后重启。该启动失败会退出码 `1`，不会留下 manager 或 raw upstream。 |
| startup timeout | 查看 `docker logs` 中的最近 stdout/stderr 和 `/health` 诊断；确认 raw upstream 可启动、`CC_API_BASE` 可达，必要时在允许范围内增加 `CC_UPSTREAM_STARTUP_TIMEOUT_MS`。 |
| upstream crash 或非零退出 | 检查 raw upstream 日志和退出状态。运行期间的 unexpected exit 会触发 manager 排空并以退出码 `1` 退出；容器编排可据此重启。 |
| external upstream unreachable | 确认 `EMBED_UPSTREAM=0`、`UPSTREAM_HOST`、`UPSTREAM_PORT` 以及容器网络；manager 可启动，但 `/health` 会是 502 `UPSTREAM_DOWN`。 |
| `/health` 不通过 | 先查看 manager `/health`，再在容器内检查 `127.0.0.1:UPSTREAM_PORT/health`；托管模式必须先看到 raw upstream 的 2xx ready。 |
| 需要查看原始输出 | 使用 `docker logs -f cc-proxy-manager`，或在已鉴权的管理 API 请求中使用 `src=proxy`。 |

不要将 `3050` 添加到 `docker run -p` 或 Compose `ports`。它是托管 raw upstream 的容器内部
端口；需要对外暴露的只有 manager 的 `PORT`。

## 维护者检查

更新上游后运行：

```bash
npm run sync:upstream
bash scripts/test-sync-upstream.sh
```

同步完成后，`upstream/proxy.mjs`、`upstream/config.json`、`upstream/package.json` 应与
同步来源对应文件逐字节一致，`UPSTREAM_VERSION` 记录来源版本。发布前运行完整验证：

```bash
node scripts/test-upstream-process.mjs
node scripts/test-server-lifecycle.mjs
npm test
docker build -t ccpm-container-smoke:local .
bash scripts/container-smoke.sh ccpm-container-smoke:local
```

其中 container smoke 需要可用的 Docker daemon；无法启动 Docker 时应记录为未执行，不应
伪造通过。静态门禁命中任何结果都应停止发布：

```bash
if rg -n \
  -e 'patch-upstream' \
  -e 'CCPM_.*PATCH_V1' \
  -e 'import\(.*upstream/proxy\.mjs' \
  scripts src upstream; then
  exit 1
fi
```

最后确认 `git diff --check` 和 `git status --short`，确保同步提交只包含预期的上游文件、
版本记录和文档。

## 安全说明

- `keys.json` 只在本地持久化明文 Key，管理 API 只返回掩码，日志不记录 Key 明文。
- 客户端令牌不会转发给 raw upstream；raw upstream 只接收 manager 选出的池内 Key。
- `/v1/*` 和管理 API 使用分离的鉴权入口；额度探测失败会标记 stale，不阻塞推理请求。
- 如果 manager 放在 HTTPS 反向代理后，设置 `SECURE_COOKIES=1`，使管理 SSE cookie 只在加密连接中传输。
