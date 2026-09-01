# commandcode-proxy-manager 代码审查报告（2026-09-01）

## 审查方法（结论均基于实测，非猜测）

| 手段 | 内容 |
|---|---|
| 静态通读 | src/ 全部 8 个模块、web/ 前端、upstream/proxy.mjs 关键路径、scripts、Docker/CI，共 ~3000 行 |
| 项目自带 e2e | `node scripts/e2e.mjs` 实际运行 |
| 自建 harness | 按 Authorization 区分 Key 的可脚本化 mock，67 项网关行为断言 |
| 单元验证 | quota（stub 网络）9 项、keyPool 9 项、stats 8 项 |
| 真实上游 E2E | 嵌入模式启动，假 Key 打通 manager→proxy→api.commandcode.ai 全链路 |
| Node 语义探针 | 验证 `req` 流 `close` 事件触发时机（影响断连检测结论） |
| 部署验证 | docker build（107MB / 压缩 27.6MB）、容器运行 + healthcheck |

## 总体结论

核心链路（鉴权 → 选 Key → 转发 → 统计 → 透传）**功能正常**：主备切换、429/零输出同 Key 重试、退避持久化、额度感知限制、历史/设置/日志管理 API 共 83 项断言通过；README 十大功能里 8 项可实证成立。但存在 2 个 P1 级缺陷（非流式 15s 超时误杀、自带 e2e 整套失效），以及断连检测失效、5xx 状态码误映射等 P2 问题。前端因审查环境无浏览器运行时未做可视化验证，改为代码级验证（P3-5/P3-6 结论已注明证据局限）。

## 缺陷清单

### P1-1 非流式慢生成被 15s 超时误杀，且错误惩罚 Key（实测复现）

`src/gateway.mjs` 对 fetch 响应头设 15s 超时（`Math.min(15000, remainingMs)`），但真实上游非流式路径要等 CC 完整生成结束（预算 90s）才写 200 头（`upstream/proxy.mjs` handleChatCompletions）。实测：18s 响应 → 客户端 15.0s 收到 502 `upstream connect timeout`，主 Key 被 `recordTimeout` 退避。后果：长回复/推理模型场景必然失败，还污染 Key 池健康；超时后 30s 总预算已尽，单 Key 池直接 502。
**修复方向**：头等待超时改为可配置 `connectTimeoutMs`（默认放宽至 120s，与上游自身 90s/30s 保护对齐），e2e 可设小值测切换。

### P1-2 自带 e2e 测试完全失效（实测运行）

`scripts/e2e.mjs` 通过 `X-Test-Mode` 请求头传递故障模式，但 mock 只认 body 的 `testMode` 字段，而网关只转发 5 个头（content-type/accept/authorization/x-session-id/x-claude-code-session-id）。结果 T3/T4/T5/T7/T10 等失败路径测试全部实际打到 mock 的正常分支（mock 日志证实全为 `mode=ok`），7 FAIL、其余多为假阳性。退避/切换/流式/超时路径无任何测试保护。
**修复方向**：mock 改按 Authorization 头识别 Key、支持 per-key 脚本队列 + `/__control`/`/__reset`/`/__calls` 管理端点，e2e 重写。

### P2-1 客户端断连不会中断上游拉取，且被记为成功（实测复现）

`src/gateway.mjs` 依赖 `req.on("close", ...)` 检测断连。Node 语义实测：POST body 被消费完后 req 流即 destroy，`close` 在注册监听之前就已发射，监听器永不触发；且流式写入失败时 `res.write` 不抛同步异常。实测：客户端首帧后断开，mock 上游完整发完全部帧（`aborted=false`），事件仍记 `ok:true`。代码注释宣称的"断开时立即中断上游拉取"未生效。
**修复方向**：改用 `res.on("close")`（响应流事件，语义正确）+ 检测 `res.destroyed`。

### P2-2 持续 5xx 最终返回 429 给客户端，且永不切换备 Key（实测）

① 出口映射 `lastStatus === 502 ? 502 : 429`——上游 503 时客户端收到 429（body 是 `proxy_error`），误导 SDK 退避；② 5xx 分支 break 后重新 `selectKey()`，5xx 不进退避 → 4 次尝试全部砸同一主 Key，备 Key 从未被尝试。
**修复方向**：出口保留真实状态码（≥500 归一 502）；换 Key 时排除本轮已试过的 Key。

### P3（低危/设计-实现落差）

1. **softStop 软降级完全未实现**——DESIGN §5.2B"≥80% 降到备位之后"无任何消费者，设置项是摆设。
2. **额度阈值改了不即时生效**——`quota.mjs` 在 `initQuota` 一次性快照 poolCfg；PUT `/admin/api/pool` 改 `fiveHourHardStop/weeklyHardStop` 只更新 keyPool 侧，quota 要到重启才生效。
3. **美元耗尽 + `currentPeriodEnd` 缺失 = 直接放行**——`setQuotaLimited(key, toMs(undefined)=0)` 等价于"解除"，且打"额度限制解除"日志（实测 Q8 复现）。
4. **`zeroOutputCountsAs429=false` 无效**——上游零输出本来就是 429 状态，开关条件 `status===429 ||` 短路，永不改变结果。
5. **前端 Key 管理页表单被 10s 自动刷新清空**——`app.mjs` tick 对 keys 视图无条件 `refresh().then(render)`，renderKeys 重建 innerHTML（代码确定性结论，未能截图复现）。
6. **DESIGN 承诺的前端 SSE 消费/迷你趋势图未做**——`/admin/api/events` 端点正常（实测收到 stats 事件），但前端无 `EventSource`，日志页 3s 轮询。

### P4（信息性）

- 最终响应 `Retry-After` 头被 stale 的 body `retry_after` 覆盖（`sendJson` 中 body 优先级更高）。
- `stats.jsonl` 权限 644（`appendFileSync` 无 mode），DESIGN §9.4 称全部 600。
- `upstream-sync.yml` cron `0 4 * * *` 为 UTC（北京 12:00），README 称北京时间凌晨 4 点。
- CSV 导出上限 500 条无提示；日志环 500 条 vs DESIGN 2000；DESIGN 日志页"按 Key 过滤"未实现。
- CORS `Access-Control-Allow-Origin: *` 对管理端点同样开放（需 token，风险有限）。

## 验证通过的功能（正面证据摘要）

- **鉴权体系**：无/错 token 401；clientToken 未配置时 AdminToken 回退（实测双向）；AdminToken 配置后不能用于 /v1（隔离正确）；池 Key 永不下发客户端、客户端 token 永不透传上游（mock 侧零泄漏）；管理端只认 X-Admin-Token；API 只回显掩码、日志无明文；keys.json/state.json 权限 600。
- **主备池**：默认选主、退避/额度受限/authError 跳过、解除回主、round-robin 双 Key 均摊、冷却期排后（9 项单测全过）。
- **重试/退避**：RA=1 同 Key 重试成功不切换；RA=30>5s 不傻等直接切换（10ms）；零输出同 Key 2s 后重试成功不留退避；总尝试=maxRetries+1（实测 keyA→A→A→B 恰 4 次）；401 只打一次不重试；退避持久化跨重启生效。
- **额度感知**：5h 95%→quota_limited(fiveHour)、weekly 92%→weekly、美元 remaining=0→credits、全 0 视为耗尽（陷阱 3）、无周期起点不展示 creditsUsd（陷阱 1）、resetAt 缺失保守不限制、网络失败→stale 保留旧值旧时间戳且不触发限制（软失败）、testKey 状态回传。
- **统计/历史**：非流式+流式 SSE usage 解析（含 cached_tokens）精确；启动回放剔除过期、prune 重写、retention 即时生效并 clamp 1-31、筛选/分页/pageSize 上限正确。
- **管理面**：login/CRUD/移动/启停/删除、重复与非 user_ 前缀拒绝、设置白名单+clamp+非法 strategy 拒绝、security 校验即时生效、SSE 推送、静态资源 content-type、404 兜底。
- **部署**：嵌入模式单进程正常；真实上游假 Key 全链路走通（CC 401→markAuthError→authError 徽章；/v1/models 上游失败自动回退硬编码 26 模型）；Docker 镜像构建成功、容器 healthy、非 root、压缩 27.6MB 与 README 相符；vendored 上游"无 process.exit/无写盘"前提复核成立（proxy.mjs:50"写回 config.json"为误导注释，无对应代码）。

## 修复计划（逐项串行，每项 e2e 回归后提交）

1. [ ] P1-2 e2e/mock 测试基建重写（KNOWN-ISSUE 用例如实暴露 P1-1/P2-1/P2-2）
2. [ ] P1-1 connectTimeoutMs 可配置 + 超时不误杀慢生成
3. [ ] P2-1 断连检测改 res 流事件
4. [ ] P2-2 5xx 状态码 + 排除已试 Key
5. [ ] P3-4 零输出开关语义
6. [ ] P3-1/2/3 softStop 软降级 + 阈值热更新 + credits 到期缺失
7. [ ] P3-5/6 前端表单丢输入 + SSE 消费
8. [ ] P4 杂项（权限/cron/Retry-After 头/日志环/CSV 上限）+ 文档
