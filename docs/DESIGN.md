# commandcode-proxy-manager —— 独立多 Key 管理项目（上游 commandcode-proxy 打包进 Docker 镜像）

> 上游项目：[MAXeaglet/commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy)（master, f7b81af，单文件零依赖 Node 反代）
> 版本：v3.1（10 项决策，本仓库已按此实施）

## 0. 决策记录（需求方已确认）

| # | 决策 | 落实位置 |
|---|---|---|
| 1 | **clientToken 必须开启**；未配置时回退使用 **AdminToken** 作为客户端访问令牌 | §4.2、§6 设置 |
| 2 | **退避结合 5h/每周/美元额度**：额度接近上限/耗尽时提前限制该 Key 出流量（额度感知退避） | §5.2 |
| 3 | 上游采用 **vendored 方案**（同步进仓库，随镜像打包，构建期零网络） | §7.1 |
| 4 | **上游发布正式版（v* tag）自动触发**重新同步并发布镜像；说明 repository_dispatch 的现实约束与等效方案 | §7.2 |
| 5 | **主备模式**规避多 Key 轮换风控：主 Key 额度用完/退避才切换备用 Key，任一时刻单一活跃 Key | §5.1 |
| 6 | **退避状态/用量统计重启不清零**：持久化到 /data；统计按 5h/每周/每月窗口 | §5.3 |
| 7 | **每 Key 历史记录展示**（请求明细/失败/用量，可筛选） | §5.4、§6 历史页 |
| 8 | **429/402/零输出先同 Key 多试几次**，确属持续限流才退避/切换，避免瞬时异常误判 | §5.2-A |
| 9 | **历史记录默认保留 7 天**，可配置 1 天～1 月 | §5.3、§6 设置 |
| 10 | **每天轮询上游正式版**即可（替代高频轮询） | §7.2 |

---

## 1. 为什么采用“独立项目 + 镜像打包上游”

| 方案 | 说明 | 结论 |
|---|---|---|
| A. 直接改上游 proxy.mjs | 在 2056 行单文件里加 Key 池/退避/管理 API/前端托管 | 破坏上游“单文件、零依赖、随上游走”的哲学；每次上游更新都要合代码，维护成本高 |
| **B. 独立管理项目，镜像内打包上游（已采用）** | 管理项目 = 网关（主备 Key + 429/额度退避）+ 额度采集 + 管理 API + 前端；上游 proxy.mjs 原样作为内部组件被同进程加载，**零改动、零 fork** | 上游更新只需重新同步打包发镜像；管理逻辑与上游完全解耦；镜像单进程、单容器，部署简单 |

**已验证的关键前提**：上游 proxy.mjs 无 process.exit、无磁盘写入（只读 config.json）、顶层仅 server.listen()（L2045）+ 一个 unhandledRejection 监听——因此管理进程可 `await import("./upstream/proxy.mjs")` **同进程嵌入**，天然共享生命周期与信号处理，无需 supervisord。

---

## 2. 上游项目现状要点（与需求相关）

| 能力 | 位置 | 与本项目的关系 |
|---|---|---|
| 鉴权 = 每请求 header 透传 Key | getApiKey() L809 | 管理网关替客户端注入池内 Key，直接复用 |
| 429 原样转发给客户端（带 Retry-After），代理自身不重试 | mapCcError() L716 | 管理网关负责拦截 429 并换 Key 重试 |
| 会话/指纹已按 Key 隔离（per-key fingerprint + 12h session） | sessionStore/keyStateStore L170-294 | 换 Key 无需重做协议握手；主备回切 12h 内零成本 |
| 流式延迟写 200 头（started 标志） | L944 | 零输出/限流时上游返回**非 200 JSON** 而非半截流，管理网关可在“未写头前”安全换 Key 重试 |
| 零输出防护（outputTokens=0 → 429） | L1005/1151 等 | 零输出 429 也作为“退避/切换”信号 |
| 动态模型列表 /provider/v1/models | fetchModels() L1943 | 网关 /v1/models 直接透传上游即可 |
| 日志隐私（不含 Key 明文） | log() L156 | 管理侧沿用同一原则 |

---

## 3. 关键情报：Command Code 官方额度 API（已实测存活）

管理项目直接以池内 Key 探测（仅需 `Authorization: Bearer <user_key>` 头，参照 [opencodex quota 实现](https://github.com/lidge-jun/opencodex/commit/e6354c2090e7c35af0663529af0b7ea69ce12e6c)）：

| 端点 | 用途 | 响应要点 |
|---|---|---|
| GET /alpha/whoami | 组织信息 | { org: { id } }（团队订阅需 orgId 作用域） |
| GET /alpha/billing/credits?orgId=… | 滚动窗口 + 信用池 | data.credits: { monthlyCredits, purchasedCredits, freeCredits }；data.windowLimits: { fiveHour: {cap,used,resetAt}, weekly: {cap,used,resetAt}, exceeded, limited } |
| GET /alpha/billing/subscriptions?orgId=… | 订阅周期 | data: { currentPeriodStart, currentPeriodEnd, planId } |
| GET /alpha/usage/summary?orgId=…&since=<periodStart> | 周期花费 | data: { totalCost | totalMonthlyCredits } |

**计算规则（沿用 opencodex 归一化，避免踩坑）**：

- fiveHourPercent = used/cap*100；weeklyPercent 同理；缺 cap/used 则不展示。
- creditsUsd：remaining = Σmax(0, monthly+purchased+free)；used = totalCost；limit = used+remaining；percent = used/limit*100。
- 陷阱 1：无 currentPeriodStart 时不展示 creditsUsd（裸 usage/summary 是终身累计）。
- 陷阱 2：存在可滚动 purchasedCredits 时不展示订阅到期时间。
- 陷阱 3：区分“字段缺失”与“值为 0”——全 0 也要显示 remaining=0。
- 端点非文档化，采集必须软失败：失败保留上次成功值并标记 stale，绝不阻塞推理主链路。

---

## 4. 新项目架构（独立仓库 + 单容器单进程）

### 4.1 仓库结构（新仓库：commandcode-proxy-manager）

```
commandcode-proxy-manager/
├── package.json            # start / dev / sync:upstream / docker:build
├── src/
│   ├── server.mjs          # 入口：设置上游 env → import 上游 → 启动管理 HTTP 服务
│   ├── gateway.mjs         # /v1/chat/completions · /v1/messages · /v1/models 透传 + 主备切换/重试
│   ├── keyPool.mjs         # Key 池：keys.json 持久化、主备顺序、退避状态机（含额度感知）
│   ├── quota.mjs           # 官方额度探测（whoami/billing/usage）+ TTL 缓存 + 定时刷新
│   ├── stats.mjs           # 用量统计：stats.jsonl 追加日志 + 5h/周/月窗口聚合 + 历史查询
│   ├── state.mjs           # 持久化：keys.json / state.json / quota-cache.json 原子读写
│   ├── adminApi.mjs        # 管理 REST API + SSE 事件流
│   └── config.mjs          # 管理端配置（config.json + 环境变量）
├── web/                    # 零构建 SPA：index.html · app.mjs · style.css
├── upstream/               # 上游 vendored 副本（sync 脚本维护，随仓库提交）
│   └── proxy.mjs / config.json / package.json
├── scripts/
│   └── sync-upstream.sh    # 拉上游 master → 拷贝到 upstream/ → 记录 tag+commit 到 UPSTREAM_VERSION
├── UPSTREAM_VERSION        # 当前捆绑的上游 tag + commit
├── Dockerfile              # 构建期零网络，最终 node:22-alpine 单进程
├── docker-compose.yml      # 端口 + /data 卷（全部持久化数据）
└── README.md
```

### 4.2 运行时拓扑与鉴权（单容器、单 Node 进程）

```
                    ┌────────────── container (node:22-alpine, 单进程) ──────────────┐
 OpenAI SDK ─────► │  管理网关 :3080 (EXPOSE)                                       │
 Anthropic SDK ──► │   /v1/chat/completions · /v1/messages · /v1/models · /health   │
 Browser ────────► │   /admin (SPA) · /admin/api/* (REST + SSE)                     │
                   │        │                                                       │
                   │        ▼ http://127.0.0.1:3050（内部端口，不对外）              │
                   │  上游 proxy.mjs（动态 import 嵌入，零改动）                     │
                   │        │ Bearer <池内 Key>                                     │
                   │        ▼                                                     │
                   │   api.commandcode.ai  /alpha/generate（推理主链路）              │
                   │   api.commandcode.ai  /alpha/whoami·billing·usage（额度探测）    │
                   └────────────────────────────────────────────────────────────────┘
```

1. **入口 server.mjs**：先 `process.env.PORT=3050; process.env.HOST=127.0.0.1`，再 `await import("./upstream/proxy.mjs")` 启动上游（内部端口仅本容器可达），随后启动管理 HTTP 服务（公共端口 3080，env 可改）。单进程 → 信号/日志/健康检查统一。
2. **网关零协议转换**：管理网关只做“鉴权 + 选 Key + 转发 + 退避/重试 + 透传”，OpenAI/Anthropic 协议转换、指纹、会话全部交给上游完成，**上游零改动、零 fork**。
3. **客户端鉴权（决策 1）**：/v1/* 一律要求 `Authorization: Bearer <token>`——token 取值优先级：`clientToken`（必须配置）→ 未配置时回退 `AdminToken`。网关校验通过后**剥离客户端 token**，替换为池内 Key 再转发上游，客户端永远接触不到 user_ Key。管理端 /admin/api/* 仍只认 AdminToken。
4. **持久化（决策 6）**：/data 卷存放 keys.json、state.json（退避/健康）、quota-cache.json（额度快照）、stats.jsonl（请求历史，见 §5.3），重启全部保留。

---

## 5. 核心机制设计

### 5.1 主备 Key 池（决策 5，替代轮询式轮换）

- **排序**：keys.json 中维护显式优先级列表（前端可拖拽排序），第 1 位 = 主 Key，其余按序为备 Key。
- **选 Key 规则**：总是选择“优先级最高且可用”的 Key；任一时刻对外只呈现**单一活跃 Key**（单账号特征，规避多账号并发风控）。
- **切换触发**（满足其一即降级到下一备 Key）：
  1. 主 Key 触发 429/402/零输出 → 进入退避（§5.2）；
  2. 主 Key 额度窗口触达硬阈值（5h ≥90% / 周 ≥90% / 美元 remaining ≤0，阈值可配，§5.2）；
  3. 主 Key 认证失败（401/403）→ 标记异常，停止自动切换（需人工处理）。
- **回切**：主 Key 退避到期或额度窗口重置（resetAt）后自动恢复主位；回切 12h 内复用上游已缓存的会话/指纹，零协议成本。
- **切换冷却**：failoverCooldownMs（默认 10min）内不重复切换（防止抖动）；前端展示每 Key 切换/回切次数与时间。
- 保留 round-robin / least-usage 作为可选策略（高级设置），默认主备。

### 5.2 429 退避 + 额度感知限制（决策 2）

```
                     ┌──────────┐   429/402/零输出/超时        ┌──────────────┐
   成功/窗口重置 ────►│  healthy  │ ──────────────────────────► │  backing_off  │
                     └──────────┘                              └──────────────┘
                        ▲                                            │
                        │              退避到期 / 额度窗口 resetAt       │
                        └────────────────────────────────────────────┘
                    额度硬阈值触发时直接进入 quota_limited（视同退避至 resetAt）
```

**A. 429/超时退避**：

- 退避时长：优先上游 Retry-After（429 默认 30s / 零输出 10s / 超时 5s），否则 min(backoffMaxMs, backoffBaseMs × 2^failCount) 指数退避 + ±20% 抖动。
- **同 Key 重试（决策 8）**：RATE_LIMIT 先同 Key 重试，最多 sameKeyRetryCount 次（默认 2，可配）：
  - 零输出（retry_after=10）：直接同 Key 重试（多为瞬时异常）；
  - 429/402：仅当上游 Retry-After ≤ sameKeyRetryMaxWaitMs（默认 5s）时同 Key 重试，否则判定为真实限流 → 直接退避切换；
  - 重试间隔 = min(Retry-After, sameKeyRetryDelayMs 默认 2s)；连续失败超出阈值才进入退避并切换备 Key。
- 失败分类：RATE_LIMIT → 同 Key 重试（见上）→ 仍失败则退避 + 切换；TIMEOUT（30s/90s 空闲超时）→ 默认切换（可配）；AUTH（401/403）→ 不重试不切换，标记异常；UPSTREAM（5xx）→ 可选同 Key 重试一次。
- 总尝试上限：单请求最多 maxRetries 次（含同 Key 重试与换 Key），超出后按最后错误返回客户端。
- 重试窗口：仅“上游 body 未输出前”（fetch 返回非 200 JSON 时）允许换 Key；200 流一旦开始只透传。

**B. 额度感知限制（在 429 之前就主动限制）**：

- 每 Key 维护额度状态（来自 §3 探测，非 stale 时生效）：
  - fiveHourPercent ≥ fiveHourHardStop（默认 90%）→ 状态 quota_limited，**跳过选择**直至该窗口 resetAt；
  - weeklyPercent ≥ weeklyHardStop（默认 90%）→ 同上，直至周窗口 resetAt；
  - creditsUsd：remaining ≤ 0（或 percent ≥ 100%）→ 视同额度耗尽，直至订阅周期结束；
  - 软限制档（≥80%，可配）：该 Key 保留但优先级降到备位之后（“额度将尽”提示）。
- 探测数据 stale 时**不启用**额度限制（避免误伤），仅展示。
- 主备模式下：主 Key 因额度耗尽切备 → 备 Key 耗尽再切下一备 → 全部耗尽返回 429 + Retry-After=min(各 Key 剩余退避/窗口时间)。

### 5.3 用量统计与持久化（决策 6：重启不清零）

**数据文件（全部在 /data 卷）**：

```
/data/keys.json          # Key 池（含主备顺序、启用状态）——已设计
/data/state.json         # 每 Key 退避/健康状态：backoffUntilMs、failCount、quota_limited、
                         #   切换统计（failover 次数/时间）、认证异常标记；变更后 1s 防抖落盘
/data/quota-cache.json   # 每 Key 最近成功额度快照（含 fetchedAt），重启避免探测风暴，仍按 TTL 刷新
/data/stats.jsonl        # 请求事件追加日志（每请求一行 JSON），启动回放最近 31 天重建统计
```

**事件行字段**：{ ts, keyId, model, stream, ok, status, errorKind, inputTokens, outputTokens, cachedTokens, latencyMs, retries }。

**窗口统计（内存聚合 + 事件回放）**：

- 官方窗口（展示口径）：5h/weekly 以 CC resetAt 对齐，月度 = 订阅周期（currentPeriodStart/End）；
- 实测用量窗口（统计口径）：滚动 5 小时 / 7 天 / 30 天 的请求数、token、失败数——与 CC 限制粒度一致，重启后由 stats.jsonl 回放重建；
- **保留策略（决策 9）**：historyRetentionDays 默认 **7 天**（可选 **1～31 天**）；启动时 + 每日定时清理过期事件；过期明细可选聚合为日汇总行，供长期趋势图使用并控制文件体积。

### 5.4 每 Key 历史记录（决策 7）

- 数据源：stats.jsonl（天然是完整历史）。
- 管理 API：`GET /admin/api/history?keyId=&from=&to=&status=&errorKind=&page=&pageSize=` → { items, total, page }（明细按 historyRetentionDays 保留，默认 7 天）。
- 展示：历史记录页——按 Key/时间/状态筛选表格（时间、Key 别名、模型、流式、状态、errorKind、input/output/cached tokens、延迟、重试次数），附失败率与 token 迷你趋势图；支持导出 CSV。

---

## 6. 管理前端设计（web/，零构建 SPA，由管理网关在 /admin 托管）

| 页面 | 功能 |
|---|---|
| 登录 | AdminToken 登录；首次启动无 AdminToken 时引导设置（或环境变量注入） |
| 总览看板 | 池状态卡片（活跃 Key/退避中/额度受限/今日 token/今日请求/429 率/切换次数）+ **每 Key 卡片**：别名+掩码+健康徽章（健康/退避中/额度受限/认证异常/数据过期）、**5h/每周/美元额度富余度进度条**（颜色分级 + 重置倒计时）、实测用量窗口、主备序号、操作（立即刷新/启用停用/删除/设为主 Key） |
| Key 管理 | 优先级拖拽排序（主备顺序）、新增/编辑抽屉（别名/Key 明文/备注/启用）、批量粘贴导入、有效性即时验证（调 whoami） |
| 历史记录 | §5.4 表格 + 筛选 + 迷你图 + CSV 导出 |
| 设置 | clientToken（必填提示，未配置回退 AdminToken）、AdminToken 修改、池策略（默认主备）、maxRetries、**同 Key 重试次数**、退避基数/上限、切换冷却、额度硬阈值（5h/周/美元）、零输出是否计入 429、**历史保留天数（1–31，默认 7）**、额度刷新间隔、QPS 上限（可选） |
| 日志 | 内存环形缓冲 2000 条 + SSE 实时追加 + 按 Key 过滤；日志永不含 Key 明文 |

**管理 API 契约（/admin/api/*，除 login 外均需 X-Admin-Token）**：

```
GET    /admin/api/keys                     → { keys: [{ id, alias, maskedKey, enabled, note, priority,
                                                health:{status,backoffUntilMs?,failCount,failoverCount?},
                                                quota:{fiveHour?,weekly?,creditsUsd?,updatedAt,stale}|null,
                                                usage:{requests5h,requests7d,requests30d,tokens…,errors…} }] }
POST   /admin/api/keys                     { alias, key, note? }       → 201 { id, maskedKey }
PUT    /admin/api/keys/:id                 { alias?, enabled?, note?, priority? } → 200
DELETE /admin/api/keys/:id                                           → 204
POST   /admin/api/keys/:id/refresh-quota                              → 200 { quota }
POST   /admin/api/keys/:id/test            验证 Key 有效性             → 200 { ok, status? }
GET    /admin/api/history                  ?keyId&from&to&status&errorKind&page&pageSize → { items,total }  # 明细保留 historyRetentionDays（默认 7 天）
GET    /admin/api/pool                     → { poolCfg, stats }
PUT    /admin/api/pool                     → 200
POST   /admin/api/login                    { token }                 → 200 { ok }
GET    /admin/api/events                   SSE：quota/health/usage/切换事件推送
```

---

## 7. Docker 镜像与“上游发布 → 自动重发镜像”

### 7.1 Dockerfile（决策 3：vendored，构建期零网络依赖）

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
COPY web/ ./web/
COPY upstream/ ./upstream/     # 上游零改动随镜像打包（vendored）
COPY UPSTREAM_VERSION ./
EXPOSE 3080
VOLUME /data                  # keys.json / state.json / quota-cache.json / stats.jsonl
CMD ["node", "src/server.mjs"]
```

### 7.2 上游正式版自动触发（决策 4：repository_dispatch 的现实约束与方案）

**约束说明**：GitHub `repository_dispatch` 事件需要**外部方向本仓库** POST `/repos/<owner>/<repo>/dispatches`（需本仓库令牌）。上游仓库不受我们控制、无法为其配置 webhook，因此“上游发布 → 直接 dispatch 到本仓库”无法直接实现。

**等效自动方案（采用）**：

```yaml
# .github/workflows/upstream-sync.yml
on:
  schedule:                 # 每天轮询上游正式版（决策 10，北京时间凌晨 4 点）
    - cron: "0 4 * * *"
  workflow_dispatch: {}     # 手动立即同步
  repository_dispatch:      # 预留：未来如有外部事件源（webhook 中转等）可直接触发
    types: [upstream-release]
jobs:
  sync-and-publish:
    steps:
      - 读取 UPSTREAM_VERSION（当前捆绑的上游 tag）
      - GET api.github.com/repos/MAXeaglet/commandcode-proxy/releases/latest
      - 若 tag 更新 → 运行 scripts/sync-upstream.sh → 提交 upstream/ + UPSTREAM_VERSION
      - docker buildx → 推送 ghcr.io/<org>/commandcode-proxy-manager:latest
        # 双 tag：latest + <上游tag>，便于按上游版本精确回滚
```

### 7.3 上游更新流程（本地手动/CI 同源）

```bash
npm run sync:upstream   # 拉上游最新正式版 tag 对应代码 → 拷贝 proxy.mjs/config.json/package.json
                        # → 写入 UPSTREAM_VERSION=<tag>@<commit> → 打印 diff 摘要
git add upstream UPSTREAM_VERSION && git commit -m "chore: sync upstream @ <tag>"
git push                # 或等 cron 自动完成；push 后镜像自动发布
```

---

## 8. 实施路线图

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| P0 骨架 | 新仓库脚手架 + sync-upstream 脚本 + 上游嵌入（import）+ 单 Key 透传网关 + clientToken/AdminToken 回退鉴权 + Dockerfile/docker-compose | docker run 后带 token 请求 /v1/chat/completions 可用，无 token 401，/admin 返回页面 |
| P1 主备池 + 退避 | keyPool 主备顺序 + 429 同 Key 重试/额度感知退避 + state.json 持久化 + /admin/api/keys CRUD | 瞬时 429/零输出同 Key 重试成功则不切换；持续受限自动切备 Key；重启后退避状态保留；全部受限时按 Retry-After 返回 |
| P2 额度/用量/历史 | quota.mjs 四端点探测 + quota-cache.json + stats.jsonl + 窗口统计 + 历史 API + 保留策略（默认 7 天，可配 1–31） | /admin/api/keys 含富余度；/admin/api/history 可查明细；重启后统计不丢；过期历史自动清理 |
| P3 前端 | 登录/看板/Key 管理/历史记录/设置/日志 | 浏览器完成全流程操作（含主备排序、额度进度条、历史筛选） |
| P4 发布 | upstream-sync.yml（**每日 cron** + dispatch 预留）+ 镜像双 tag 发布 + 文档 + 压测 | 上游发正式版后次日自动出镜像；手动 workflow_dispatch 可用 |

关键落点对照（管理侧新代码，上游零改动）：gateway 转发用 fetch 直连 http://127.0.0.1:3050；429 判定依赖上游非 200 JSON 响应（上游 L1005/1151 零输出 429、L716 映射 429）——无需感知上游内部实现细节。

---

## 9. 风险与注意事项

1. **风控（决策 5 的边界）**：主备模式把并发多账号特征降为“单一活跃账号 + 低频切换”，显著降低风控概率，但不能 100% 消除——切换瞬间指纹/会话变化不可避免（上游按 Key 绑定指纹，会话缓存 12h）；建议前端展示切换统计，控制 failoverCooldownMs，并保持与正常 CLI 使用频率一致。
2. **重试语义边界**：仅“上游 body 未输出前”换 Key；流式开始后绝不重试；401/403 不切换不重试（避免放大风控特征）。
3. **额度端点非文档化**：字段随官方 CLI 漂移 → 采集软失败 + stale 展示；**stale 时禁用额度感知限制**，避免误伤。
4. **密钥安全**：/data 卷文件权限 600；API 只回显掩码；日志脱敏；/v1/* 强制 clientToken（回退 AdminToken）防止池 Key 被匿名盗用；客户端 token 绝不下发上游。
5. **上游嵌入耦合**：import 方案要求上游“无 process.exit / 无全局冲突”，已核验通过；若上游未来破坏此前提，退路是容器内双进程（entrypoint 启上游 + 管理），架构不变。
6. **持久化一致性**：stats.jsonl 追加写 + 防抖写 state.json；崩溃最多丢最近 1s 状态与少量统计，可接受；定期压缩日志控制体积。
7. **版本可溯性**：UPSTREAM_VERSION（tag@commit）随仓库提交；镜像双 tag（latest + 上游 tag）精确回滚。
8. **同 Key 重试必须有界**：sameKeyRetryCount 默认 2、间隔 ≤2s、Retry-After >5s 不等待直接切换——防止瞬时重试放大限流或拖慢响应；重试次数计入前端 429 率统计。

---

## 10. 结论

- 采用**独立管理项目**：主备 Key 池（规避风控）+ 429/额度感知退避 + 额度采集 + 持久化统计 + 历史记录 + 零构建前端，全部新代码与上游解耦；
- 上游**零改动** vendored 随镜像打包（同进程 import，已核验可行）；
- 上游发布正式版 → CI cron 轮询自动同步并发镜像（repository_dispatch 预留）；
- 退避/用量持久化，按 5h/周/月窗口统计，重启不清零；
- 已按 P0→P4 实施完成（见 README 与 src/ 实现）。
