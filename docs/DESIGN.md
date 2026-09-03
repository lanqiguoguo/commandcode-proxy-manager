# commandcode-proxy-manager 设计

本文记录当前实现的边界和运行契约。项目把原始 `commandcode-proxy` 文件 vendored 到
`upstream/`，用 manager 提供多 Key 管理能力；两部分通过 HTTP 和进程边界协作。

## 1. 目标和边界

manager 的职责是：

- 提供 `/v1/chat/completions`、`/v1/messages`、`/v1/models`、`/health` 和管理面；
- 校验客户端令牌，选择池内 Key，并在响应头或 body 尚未向客户端输出前执行有界重试；
- 管理 429/402/零输出/超时退避、额度限制、统计和持久化；
- 在托管模式中启动、等待、监控和停止 raw upstream 子进程。

raw upstream 的职责是：

- 将 OpenAI/Anthropic 请求转换为 Command Code API 请求并转换响应；
- 维护原始版本的初始化并发、指纹、会话和版本刷新行为；
- 处理其自身的请求体上限、模型列表、超时和原始 API 日志。

manager 不把这些上游行为复制到自己的状态机，也不在同步时改写
`upstream/proxy.mjs`。

## 2. 代码和发布物

```text
commandcode-proxy-manager/
├── src/server.mjs             manager 入口、托管模式 bootstrap 和信号处理
├── src/upstreamProcess.mjs    raw upstream spawn、health、日志和停止控制
├── src/serverLifecycle.mjs    manager 监听、排空和强制关闭
├── src/gateway.mjs            鉴权后转发、流式校验、重试和统计
├── src/config.mjs             manager config.json 和基础设施环境变量
├── src/keyPool.mjs            Key 顺序、退避、额度限制和健康状态
├── src/quota.mjs              whoami/billing/usage 额度探测
├── src/adminApi.mjs           管理 REST API、SSE 和安全 cookie
├── src/logs.mjs               manager/raw upstream 日志捕获和持久化
├── web/                       零构建管理界面
├── upstream/                  原始 vendored 文件
├── scripts/sync-upstream.sh   同步和逐字节校验
├── Dockerfile                 manager 容器入口
└── docker-compose.yml         manager 端口和 /data 卷
```

`UPSTREAM_VERSION` 记录当前来源版本。镜像构建时复制 raw upstream 文件，构建期不需要
访问上游网络。

## 3. 运行时拓扑

```text
                         container
┌────────────────────────────────────────────────────────────────┐
│  manager: node src/server.mjs                                  │
│  HOST:PORT                                                     │
│      │                                                         │
│      │ HTTP: /v1/*、/admin、/health                            │
│      ▼                                                         │
│  raw upstream: process.execPath proxy.mjs                      │
│  cwd=upstream, HOST=127.0.0.1, PORT=UPSTREAM_PORT              │
│      │                                                         │
│      ▼                                                         │
│  api.commandcode.ai                                             │
└────────────────────────────────────────────────────────────────┘
```

这是单容器内的两个独立进程。`3050` 是默认的 raw upstream 内部端口，Dockerfile 和
Compose 都不会把它映射到宿主机；公共入口是 manager 的 `PORT`，默认 `3080`。

### 3.1 托管模式

当 `EMBED_UPSTREAM` 未设置或为 `1` 时，`src/server.mjs`：

1. 加载 manager 配置，并保留磁盘中的上游地址配置；
2. 在 raw upstream 子进程启动前安装 stdout/stderr 捕获和 manager 日志链路；
3. 调用 `startUpstream({ command: process.execPath, args: ["proxy.mjs"], cwd: "upstream" })`；
4. supervisor 强制向子进程传入 `HOST=127.0.0.1` 和 `PORT=cfg.upstreamPort`；
5. 轮询 `http://127.0.0.1:cfg.upstreamPort/health`，收到 2xx 后才监听 manager 的 `cfg.host:cfg.port`。

托管模式下，manager 的运行时上游主机始终是 `127.0.0.1`。即使 `config.json` 或
`UPSTREAM_HOST` 有其它值，也不会让本地 raw upstream 绑定非 loopback 地址；保存配置时
保留原磁盘值，避免运行时地址覆盖持久化配置。

### 3.2 外置模式

当 `EMBED_UPSTREAM=0` 时：

- manager 不调用 raw upstream supervisor，也不创建任何上游子进程；
- manager/gateway 使用 `UPSTREAM_HOST:UPSTREAM_PORT`；
- manager 可以在外置服务尚未可达时监听；
- `/health` 会探测外置服务，外置不可达时返回 502 `UPSTREAM_DOWN`；
- 不存在 manager 对外置进程的停止、回收或 unexpected exit 处理。

代码按“只有字符串 `0` 表示外置”判断，因此生产部署应明确使用 `1` 或 `0`，不要依赖
其它值表达模式。

## 4. 进程生命周期契约

### 4.1 启动成功路径

```text
加载配置和持久化状态
        │
        ├─ 外置模式 ───────────────► manager listen
        │
        └─ 托管模式
             │ spawn raw upstream
             ▼
        raw GET /health = 2xx
             │
             ▼
        manager listen
```

raw `/health` 的原始响应是 `200 text/plain OK`。manager 只有在托管 ready 后才对外监听，
所以托管启动窗口不会出现一个已经开放但还没有本地上游的公共入口。

### 4.2 启动失败

`CC_UPSTREAM_STARTUP_TIMEOUT_MS` 默认 `10000` 毫秒，允许范围为 `0..120000`。在超时前，
supervisor 以有界请求和间隔轮询 `/health`；健康检查失败会被记录，不能无限等待。

以下任一情况都会走失败清理并以退出码 `1` 结束：

| 情况 | 行为 |
|---|---|
| raw upstream 端口已占用 | raw 子进程监听失败；manager 启动失败并回收子进程 |
| raw upstream 立即退出或未 ready | `ready` 拒绝；manager 输出退出状态和最近诊断并退出 |
| raw `/health` 在启动超时内未返回 2xx | 发送停止请求、回收 raw 子进程、manager 退出 |
| manager 公共端口已占用 | manager 监听失败；已 ready 的 raw 子进程也会被停止 |
| 配置或初始化导致 manager 无法启动 | 输出错误；不会把未完成的托管流程留在后台 |

诊断包含启动命令、工作目录、端口、退出码或信号，以及有界的最近 stdout/stderr 行。

### 4.3 正常关闭

manager 作为容器 PID 1 接收 `SIGTERM`/`SIGINT`。`shutdown()` 是幂等的，重复信号只
记录“已经关闭”并复用已有关闭流程。顺序如下：

1. `serverLifecycle.close()` 调用 `server.close()`，停止接受新连接；
2. 在 `CC_SHUTDOWN_GRACE_MS` 默认 `10000` 毫秒内等待活动请求和 socket 排空；
3. 排空超时后销毁活动请求和连接，等待 `CC_SHUTDOWN_FORCE_WAIT_MS` 默认 `1000` 毫秒；
4. 托管模式调用 raw supervisor 的 `stop()`；外置模式跳过此步；
5. raw supervisor 先发送 `SIGTERM`，等待 `CC_UPSTREAM_SHUTDOWN_TIMEOUT_MS` 默认 `5000` 毫秒；
6. raw 仍存活时发送 `SIGKILL`，再完成有界强制回收。

manager 排空两个变量的有效范围为 `100..120000` 毫秒；raw 启动和停止变量的有效范围为
`0..120000` 毫秒。正常信号关闭退出码为 `0`；关闭清理失败时改为 `1`。

### 4.4 运行期间 raw 异常退出

raw 子进程已经运行后，如果没有 manager 主动停止而退出，supervisor 只通知一次
`onUnexpectedExit`。manager 打印退出诊断，停止接收新请求、排空现有请求，然后以退出码
`1` 退出。这样容器编排可以根据非零状态重启整个服务，并且不会留下 manager 继续对外
提供不可用的入口。

## 5. 日志和健康检查

### 5.1 stdout/stderr 链路

`src/server.mjs` 在托管 child 启动前调用日志捕获。`upstreamProcess.mjs`：

- 分别读取 raw child 的 stdout 和 stderr；
- 按 UTF-8 行边界转发，保留未完成的尾行；
- 将 stdout 写入 manager stdout，将 stderr 写入 manager stderr；
- 保存有界的最近诊断，异常信息不会无限增长。

`src/logs.mjs` 捕获 manager 的 console 输出，也识别 raw upstream 的时间戳日志并标记
`src=proxy`。运行时可用：

```bash
docker logs -f cc-proxy-manager
```

管理员也可以通过带 `X-Admin-Token` 的
`GET /admin/api/logs?src=proxy` 查看 raw upstream 日志，或在 `/admin` 日志页查看。
`events.jsonl` 保存受保留策略约束的系统日志。

### 5.2 `/health` 语义

| 条件 | manager 响应 |
|---|---|
| 持久化可用且上游 2xx | `200 text/plain OK` |
| 持久化可用但上游不可达或非 2xx | `502 text/plain UPSTREAM_DOWN` |
| DATA_DIR 不可用 | `503 application/json`，包含 `persistence.available=false` |

托管模式中，manager `/health` 在 raw ready 前不会对外可请求；外置模式中，manager 可以
先监听，直到外置服务可达前保持 `UPSTREAM_DOWN`。

## 6. 请求路径和职责划分

1. manager 对 `/v1/*` 校验 `CLIENT_TOKEN`；未设置时回退 `ADMIN_TOKEN`。
2. manager 从 Key 池选择当前可用 Key，不把客户端令牌传给上游。
3. gateway 按当前运行配置构造 `http://UPSTREAM_HOST:UPSTREAM_PORT`，托管模式实际为 loopback。
4. raw upstream 从请求头取得池内 Key，负责协议转换、初始化请求、指纹、会话和 Command Code API 调用。
5. 对未开始输出的非 2xx 或完整无输出响应，manager 可按池配置执行同 Key 重试或切换 Key；流式响应开始后不切换 Key。
6. manager 记录外部请求、状态、错误类别、token 和延迟；Key 健康和额度状态写入 `/data`。

raw upstream 当前原始行为包括：每个 API Key 的 fingerprint/session 状态、初始化预请求、
流式和非流式空闲超时、请求体大小限制，以及自身的版本刷新定时器。这些行为不属于
manager 配置表中的功能开关。

## 7. Key 池、额度和持久化

### 7.1 Key 池

- 默认策略为 `active-standby`：最高优先级的可用 Key 为主 Key，其余为备用。
- 429、402、零输出和可切换超时会触发有界同 Key 重试、退避和必要的切换。
- 401/403 标记认证异常，不通过自动切换掩盖凭证问题。
- 流式内容开始后只透传当前尝试，不能为了换 Key 重放已经发送的内容。
- 管理界面可以配置 `round-robin` 和 `least-usage`，以及重试、退避、额度阈值和历史保留。

### 7.2 额度探测

`src/quota.mjs` 使用 `CC_QUOTA_BASE` 探测：

- `/alpha/whoami`；
- `/alpha/billing/credits`；
- `/alpha/billing/subscriptions`；
- `/alpha/usage/summary`。

探测经过串行队列和 Key 间隔，失败保留最近成功快照并标记 `stale`。stale 数据不启用
额度限制，避免一次网络故障误伤推理请求。成功数据可按 5 小时、每周和美元额度阈值
进入 `quota_limited`。

### 7.3 文件

| 文件 | 用途 |
|---|---|
| `config.json` | 端口、地址、令牌和 pool 配置 |
| `keys.json` | Key 明文、别名、启用状态、优先级，权限 600 |
| `state.json` | 退避、健康、认证异常、额度限制和切换状态 |
| `quota-cache.json` | 最近额度报告和更新时间 |
| `stats.jsonl` | 请求事件，支持历史查询和窗口统计 |
| `events.jsonl` | manager/raw upstream 系统日志，受保留天数和容量约束 |

历史明细默认保留 7 天，可在管理界面调整为 1 到 31 天。文件采用受限大小、原子写入
或追加和启动回放策略，持久化失败会反映到 `/health` 和管理 API。

## 8. 配置参考

### 8.1 manager 变量

| 变量 | 默认值 | 生效范围 |
|---|---|---|
| `DATA_DIR` | `./data`，容器为 `/data` | manager 持久化目录 |
| `PORT` | `3080` | manager 监听端口 |
| `HOST` | `0.0.0.0` | manager 监听地址 |
| `UPSTREAM_HOST` | `127.0.0.1` | 外置模式目标；托管运行时强制 loopback |
| `UPSTREAM_PORT` | `3050` | 外置目标或托管 child 端口 |
| `EMBED_UPSTREAM` | 未设置时托管 | `0` 外置，`1` 托管 |
| `CC_UPSTREAM_STARTUP_TIMEOUT_MS` | `10000` | 托管 ready 超时，`0..120000` 毫秒 |
| `CC_UPSTREAM_SHUTDOWN_TIMEOUT_MS` | `5000` | raw `SIGTERM` 等待，`0..120000` 毫秒 |
| `CC_SHUTDOWN_GRACE_MS` | `10000` | manager 排空等待，`100..120000` 毫秒 |
| `CC_SHUTDOWN_FORCE_WAIT_MS` | `1000` | manager 强制关闭后的等待，`100..120000` 毫秒 |
| `ADMIN_TOKEN` | 首次自动生成 | 管理鉴权；磁盘已有值时优先 |
| `CLIENT_TOKEN` | 空，回退 `ADMIN_TOKEN` | `/v1/*` 鉴权；磁盘已有值时优先 |
| `CC_QUOTA_BASE` | `https://api.commandcode.ai` | manager 额度 API 基址 |
| `SECURE_COOKIES` | 空 | `1`/`true` 时为 SSE cookie 添加 `Secure` |

### 8.2 raw upstream 变量

`upstream/proxy.mjs` 明确读取下列变量。托管模式由 supervisor 从 manager 环境的允许
列表传入；外置模式由外置服务自行配置：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CC_API_BASE` | `https://api.commandcode.ai` | raw upstream 的 Command Code API 基址 |
| `PROJECT_SLUG` | `cc-proxy` | raw upstream 配置中的项目 slug |
| `LOG_FILE` | 空 | raw upstream 可选的文件日志路径 |
| `CC_USE_PROVIDER_MODELS` | `true` | raw upstream provider model 列表开关，字符串 `false` 时关闭 |
| `CC_MAX_BODY_MB` | `100` | raw upstream 请求体上限，正整数 MB |

raw child 的 `HOST`、`PORT` 不是用户可任意注入的值，而是 manager 为本地进程设置的
`127.0.0.1` 和 `UPSTREAM_PORT`。`CC_QUOTA_BASE` 只控制 manager 额度探测。

## 9. 管理 API 面

除登录和退出登录外，管理 API 需要 `X-Admin-Token`。当前主要面如下：

| 路径 | 作用 |
|---|---|
| `POST /admin/api/login` | 校验 AdminToken，并下发 SSE 专用 HttpOnly cookie |
| `GET/POST/PUT/DELETE /admin/api/keys` | 查询和维护 Key 池 |
| `POST /admin/api/keys/:id/refresh-quota` | 刷新指定 Key 额度 |
| `POST /admin/api/keys/:id/test` | 测试指定 Key |
| `GET /admin/api/history` | 分页查询请求历史 |
| `GET/PUT /admin/api/pool` | 查询或修改池配置 |
| `POST /admin/api/security` | 修改 client/admin token |
| `GET /admin/api/logs` | 查询持久化 manager/raw 日志，可按 `src=proxy` 过滤 |
| `GET /admin/api/events` | SSE 推送 quota、stats 和 log 事件 |

`SECURE_COOKIES=1` 或 `true` 只应在 HTTPS 反向代理后使用。默认明文 HTTP 部署不设置
`Secure`，否则浏览器不会回传 SSE cookie。

## 10. 容器和部署

Dockerfile 的入口是 `node src/server.mjs`。镜像包含 `src/`、`web/`、`upstream/` 和
`UPSTREAM_VERSION`，使用 `/data` 保存运行数据。manager 是容器入口进程，因此负责接收
容器信号并按第 4.3 节顺序关闭。

当前 Compose 部署只有 manager 服务：

```yaml
ports:
  - "${PORT:-3080}:${PORT:-3080}"
volumes:
  - ccpm-data:/data
```

托管部署只映射 manager 端口。外置部署可以把 `EMBED_UPSTREAM=0`、`UPSTREAM_HOST` 和
`UPSTREAM_PORT` 传给 manager，但也不应因此发布容器内部的 `3050`。

## 11. 同步和发布

同步脚本的责任只有三件事：获取来源、复制原始文件、记录来源版本并做一致性检查。
同步后必须核对：

- `upstream/proxy.mjs` 与来源的 `proxy.mjs` 逐字节一致；
- `upstream/config.json` 与来源的 `config.json` 逐字节一致；
- `upstream/package.json` 与来源的 `package.json` 逐字节一致；
- `UPSTREAM_VERSION` 能追溯到上游 tag/commit。

维护者使用：

```bash
npm run sync:upstream
bash scripts/test-sync-upstream.sh
```

上游更新后先审阅 diff，再提交上游文件和版本记录。发布前必须执行 raw supervisor、
server lifecycle、完整测试和容器 smoke；Docker daemon 不可用时，container smoke 只能
记录为未执行。

## 12. 开发和验证

```bash
npm start
npm run dev
node scripts/test-upstream-process.mjs
node scripts/test-server-lifecycle.mjs
npm test
docker build -t ccpm-container-smoke:local .
bash scripts/container-smoke.sh ccpm-container-smoke:local
```

`npm run dev` 的 watch 入口是 manager；它不会因为 `upstream/proxy.mjs` 改动而自动重启
raw child。修改 `upstream/` 后手动停止并重新运行 manager，或单独运行 raw upstream 并
使用外置模式。

维护者还应执行静态门禁，命中任何结果都不能发布：

```bash
if rg -n \
  -e 'patch-upstream' \
  -e 'CCPM_.*PATCH_V1' \
  -e 'import\(.*upstream/proxy\.mjs' \
  scripts src upstream; then
  exit 1
fi
```

最后运行 `git diff --check`，并确认工作区没有修改 `docs/CODE_REVIEW_2026-09-03.md`、
计划文档或代码文件。

## 13. 故障排查和可观测性

### raw upstream port occupied

托管模式中，raw child 需要绑定 loopback 的 `UPSTREAM_PORT`。如果端口已被占用，查看
manager 日志中的 listen 错误和最近 raw stderr，释放占用后重启。manager 会以退出码 `1`
结束并回收已创建的 child。

### startup timeout

确认 raw child 能读取 `upstream/config.json`、能启动 HTTP listener，并且它的 `/health`
能在 `CC_UPSTREAM_STARTUP_TIMEOUT_MS` 内返回 2xx。检查：

```bash
docker logs cc-proxy-manager
curl -i http://127.0.0.1:3080/health
```

托管模式在 ready 前不会开放 manager 公共端口；需要更多启动时间时只在允许范围内调高
启动超时。

### upstream crash 或非零退出

检查 raw stdout/stderr 中最后的异常和 manager 的 `upstream exited unexpectedly` 记录。
运行期间 raw 意外退出会让 manager 排空并退出码 `1`，避免继续接受不可用请求。启动阶段
提前退出则直接按启动失败处理。

### external upstream unreachable

确认 `EMBED_UPSTREAM=0`，并从 manager 容器网络验证 `UPSTREAM_HOST:UPSTREAM_PORT`。外置
模式不会创建本地 child；manager 可以监听，但 `/health` 将返回 `502 UPSTREAM_DOWN`，网关
请求会记录上游连接错误。

### 日志和内部健康检查

raw 日志通过 manager stdout/stderr 原样转发，因此优先使用：

```bash
docker logs -f cc-proxy-manager
```

管理员可以通过 `GET /admin/api/logs?src=proxy` 筛选 raw 日志，并通过 manager
`/health` 判断持久化和上游的组合状态。不要把 `3050` 发布到宿主机；托管模式只需检查
manager 的公共 `PORT`，容器内的 loopback 端口由 manager supervisor 管理。

## 14. 不变量

1. `EMBED_UPSTREAM=0` 时没有本地 raw upstream 子进程。
2. 托管模式的 manager 监听发生在 raw `/health` ready 之后。
3. raw child 只绑定 `127.0.0.1:UPSTREAM_PORT`，不通过 Compose 或 Dockerfile 发布。
4. manager 关闭时先停止接收和排空，再停止托管 raw child。
5. raw child 意外退出后 manager 以非零状态退出，不能留下孤儿 child。
6. 同步后原始上游文件逐字节一致，manager 功能只位于 `src/` 和管理边界。
7. 初始化并发、指纹、会话和版本刷新以 raw upstream 当前原始行为为准。
