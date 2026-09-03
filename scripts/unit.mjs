// ── 单元测试（无网络，quota 用 stub fetch）：
//   quota 额度感知（硬阈值/软限制/stale/credits 到期兜底/陷阱规则）
//   keyPool 选 Key（主备/退避/authError/软限制降级/排除已试/冷却）
//   stats 保留清理（回放/prune/retention clamp/权限）
//   logs 持久化 + 上游 proxy 日志捕获（时序/去重/脱敏/src 过滤）
//   state 防抖写盘 flush 语义（P2-4：立即落盘/幂等/清 timer/未调度 no-op）
//   durable 持久化提交/失败回滚语义（F04）
// 用法：node scripts/unit.mjs [quota|pool|stats|logs|state|durable]   （缺省依次全部跑，每场景独立子进程）
import fs, { mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const SC = process.argv[2];
const SCENARIOS = ["quota", "pool", "stats", "logs", "tokens", "state", "durable"];

if (SC && !SCENARIOS.includes(SC)) {
  console.error(`未知 unit 场景：${SC}。可选值：${SCENARIOS.join(", ")}`);
  process.exit(1);
}

// ── 单场景超时护栏（L-h）：场景子进程挂起（如回归导致的死循环/永不 resolve 的
// await）不得拖死整个 unit job。30s 远超任何场景实际耗时（毫秒级单测），
// 超时则 SIGKILL + 计 fail + 输出清晰错误。──
const SCENARIO_TIMEOUT_MS = Number(process.env.UNIT_SCENARIO_TIMEOUT_MS || 30000);

if (!SC) {
  // runner 模式：逐场景子进程执行（DATA_DIR 在各子进程 import 前注入，互不污染）
  let failed = false;
  for (const s of SCENARIOS) {
    const code = await new Promise((resolveP) => {
      const p = spawn(process.execPath, [fileURLToPath(import.meta.url), s], { stdio: "inherit" });
      let done = false;
      const timer = setTimeout(() => {
        done = true;
        console.error(`\n  ❌ unit(${s}) 超时：${SCENARIO_TIMEOUT_MS}ms 未结束，已 SIGKILL（疑似回归挂起）`);
        try { p.kill("SIGKILL"); } catch {}
      }, SCENARIO_TIMEOUT_MS);
      p.on("exit", (c) => { clearTimeout(timer); if (done) resolveP(1); else resolveP(c); });
    });
    if (code !== 0) failed = true;
  }
  console.log(`\n=== unit all: ${failed ? "FAILED" : "OK"} ===`);
  process.exit(failed ? 1 : 0);
}

let pass = 0, fail = 0;
function ok(name) { pass++; console.log("  ✅ " + name); }
function bad(name, detail) { fail++; console.log("  ❌ " + name + "\n     " + detail); }
function check(cond, name, detail) { cond ? ok(name) : bad(name, detail || ""); }

const DATA = "/tmp/ccpm-unit-" + SC;
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA;

// ════ quota ════
if (SC === "quota") {
  console.log("=== quota 额度感知 ===");
  const responses = {
    whoami: { org: { id: "o1" } },
    credits: { data: {
      credits: { monthlyCredits: 10, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: {
        fiveHour: { cap: 100, used: 95, resetAt: new Date(Date.now() + 3600e3).toISOString() },
        weekly: { cap: 100, used: 10, resetAt: new Date(Date.now() + 3 * 864e5).toISOString() }
      } } },
    subs: { data: { currentPeriodStart: "2026-09-01T00:00:00Z", currentPeriodEnd: new Date(Date.now() + 10 * 864e5).toISOString(), planId: "pro" } },
    usage: { data: { totalCost: 4.5 } },
  };
  let netDown = false;
  globalThis.fetch = async (url) => {
    if (netDown) throw new Error("network down");
    const u = String(url);
    let j = null;
    if (u.includes("/alpha/whoami")) j = responses.whoami;
    else if (u.includes("/billing/credits")) j = responses.credits;
    else if (u.includes("/billing/subscriptions")) j = responses.subs;
    else if (u.includes("/usage/summary")) j = responses.usage;
    if (!j) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => j };
  };
  const quotaCalls = [];
  const softCalls = [];
  const liveCfg = { fiveHourHardStop: 90, weeklyHardStop: 90, softStop: 80, quotaRefreshMs: 60000000 };
  const fakePool = {
    getKeyRecord: (id) => ({ id, key: "user_testkey" }),
    listKeys: () => [{ id: "k1", key: "user_testkey", enabled: true }],
    getPoolCfg: () => ({ ...liveCfg }),
    setQuotaLimited: (id, until, reason) => quotaCalls.push(["set", reason, until]),
    clearQuotaLimited: () => quotaCalls.push(["clear"]),
    setSoftLimited: (id, v) => softCalls.push(v),
  };
  const { initQuota, probeKey, testKey } = await import("../src/quota.mjs");
  initQuota(fakePool, liveCfg, {});

  let r = await probeKey("k1");
  check(r.fiveHour.percent === 95 && !r.stale && quotaCalls[0]?.[0] === "set" && quotaCalls[0]?.[1] === "fiveHour", "5h 95%≥90 → quota_limited(fiveHour)", JSON.stringify(quotaCalls));
  check(softCalls[softCalls.length - 1] === true, "5h 95% 同时置软限制标记", JSON.stringify(softCalls));

  quotaCalls.length = 0;
  responses.credits.data.windowLimits.fiveHour.used = 50;
  responses.credits.data.windowLimits.weekly = { cap: 100, used: 92, resetAt: new Date(Date.now() + 2 * 864e5).toISOString() };
  await probeKey("k1");
  check(quotaCalls[0]?.[0] === "set" && quotaCalls[0]?.[1] === "weekly", "weekly 92% → quota_limited(weekly)", JSON.stringify(quotaCalls));

  // 阈值热更新（P3-2）：getPoolCfg 实时读取
  quotaCalls.length = 0;
  responses.credits.data.windowLimits.fiveHour.used = 85; // 85% < 硬 90 但 ≥ soft 80
  responses.credits.data.windowLimits.weekly.used = 10;   // weekly 降回，排除干扰
  await probeKey("k1");
  check(quotaCalls.some((c) => c[0] === "clear") && softCalls[softCalls.length - 1] === true, "85%：硬阈值不触发（clear）+ 软限制命中", JSON.stringify(quotaCalls));
  liveCfg.fiveHourHardStop = 80; // 85% 应触发限制，无需重启
  quotaCalls.length = 0;
  await probeKey("k1");
  check(quotaCalls[0]?.[0] === "set" && quotaCalls[0]?.[1] === "fiveHour", "阈值热更新生效（P3-2）", JSON.stringify(quotaCalls));
  liveCfg.fiveHourHardStop = 90;

  // credits 耗尽
  quotaCalls.length = 0;
  responses.credits.data.windowLimits.fiveHour.used = 50;
  responses.credits.data.windowLimits.weekly = { cap: 100, used: 10, resetAt: new Date(Date.now() + 3 * 864e5).toISOString() };
  responses.credits.data.credits = { monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0 };
  responses.usage.data = { totalCost: 12 };
  r = await probeKey("k1");
  check(r.creditsUsd && r.creditsUsd.remaining === 0 && quotaCalls[0]?.[1] === "credits", "美元 remaining=0 → credits 限制", JSON.stringify(quotaCalls));

  // 全 0（陷阱3）
  quotaCalls.length = 0;
  responses.usage.data = { totalCost: 0 };
  r = await probeKey("k1");
  check(r.creditsUsd && r.creditsUsd.remaining === 0 && quotaCalls[0]?.[1] === "credits", "全 0 视为耗尽→限制（陷阱3）", JSON.stringify(r.creditsUsd));

  // 陷阱1：无周期起点 → 不展示 creditsUsd
  quotaCalls.length = 0;
  responses.subs = { data: { planId: "pro" } };
  r = await probeKey("k1");
  check(r.creditsUsd === null, "无 currentPeriodStart → creditsUsd 不展示（陷阱1）", JSON.stringify(r.creditsUsd));

  // P3-3: credits 耗尽 + expiresAt 缺失 → 退到窗口 resetAt
  quotaCalls.length = 0;
  const weeklyReset = Date.parse(responses.credits.data.windowLimits.weekly.resetAt);
  responses.subs = { data: { currentPeriodStart: "2026-09-01T00:00:00Z", planId: "pro" } };
  responses.credits.data.credits = { monthlyCredits: 0 };
  responses.usage.data = { totalCost: 5 };
  await probeKey("k1");
  check(quotaCalls[0]?.[0] === "set" && quotaCalls[0]?.[1] === "credits" && quotaCalls[0]?.[2] === weeklyReset, "credits 无 expiresAt → 退到窗口 resetAt（P3-3）", JSON.stringify(quotaCalls));

  // 全缺 → 限制一个刷新周期
  quotaCalls.length = 0;
  responses.credits.data.windowLimits.fiveHour.resetAt = null;
  responses.credits.data.windowLimits.weekly.resetAt = null;
  liveCfg.quotaRefreshMs = 60000;
  await probeKey("k1");
  check(quotaCalls[0]?.[0] === "set" && quotaCalls[0]?.[1] === "credits" && quotaCalls[0]?.[2] > Date.now(), "resetAt 全缺 → 限制一个探测周期（P3-3）", JSON.stringify(quotaCalls));
  responses.credits.data.windowLimits.fiveHour = { cap: 100, used: 50, resetAt: new Date(Date.now() + 3600e3).toISOString() };
  responses.credits.data.windowLimits.weekly = { cap: 100, used: 10, resetAt: new Date(weeklyReset).toISOString() };
  responses.subs = { data: { currentPeriodStart: "2026-09-01T00:00:00Z", currentPeriodEnd: new Date(Date.now() + 10 * 864e5).toISOString(), planId: "pro" } };
  responses.credits.data.credits = { monthlyCredits: 10 };
  responses.usage.data = { totalCost: 4.5 };

  // fiveHour resetAt 缺失 → 保守不限制（但 credits 正常路径不受影响）
  quotaCalls.length = 0;
  responses.credits.data.windowLimits.fiveHour.used = 99;
  responses.credits.data.windowLimits.fiveHour.resetAt = null;
  await probeKey("k1");
  check(!quotaCalls.some((c) => c[1] === "fiveHour"), "fiveHour resetAt 缺失 → 不做硬限制（保守）", JSON.stringify(quotaCalls));
  responses.credits.data.windowLimits.fiveHour = { cap: 100, used: 50, resetAt: new Date(Date.now() + 3600e3).toISOString() };

  // stale 降级
  r = await probeKey("k1"); // 建立 prev
  const prevUpdatedAt = r.updatedAt;
  quotaCalls.length = 0; softCalls.length = 0;
  netDown = true;
  const r2 = await probeKey("k1");
  netDown = false;
  check(r2.stale && r2.fiveHour && quotaCalls.length === 0 && softCalls.length === 0, "网络失败 → stale 保留旧值、不触发任何限制", JSON.stringify(quotaCalls));
  check(r2.updatedAt === prevUpdatedAt, "stale 保留上次成功 updatedAt");

  globalThis.fetch = async () => ({ ok: false, status: 401 });
  const t = await testKey("k1");
  check(t.ok === false && t.status === 401, "testKey → {ok:false,status:401}", JSON.stringify(t));

  // ══ 真实 API 形态回归：totals / epoch-ms resetAt / 无 orgId URL 拼接 ══
  const urls = [];
  const msReset = Date.now() + 2 * 864e5;
  globalThis.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("/alpha/whoami")) return { ok: true, status: 200, json: async () => ({ success: true, data: { user: { id: "u1" } } }) }; // 无 org
    if (u.includes("/billing/credits")) return { ok: true, status: 200, json: async () => ({
      credits: { monthlyCredits: 20, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: {
        limited: true, exceeded: "weekly",
        fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 },
        weekly: { used: 35, cap: 35, exceeded: true, resetAt: msReset }
      } }) };
    if (u.includes("/billing/subscriptions")) return { ok: true, status: 200, json: async () => ({ success: true, data: { currentPeriodStart: "2026-08-25T23:33:28.000Z", currentPeriodEnd: "2026-09-25T23:33:28.000Z", planId: "individual-goat" } }) };
    if (u.includes("/usage/summary")) return { ok: true, status: 200, json: async () => ({ totalCount: 12489, completedCount: 12489, failedCount: 0, successRate: 100, totalTokensIn: 1871710189, totalTokensOut: 7638220, totalTokens: 1879348409, totalCost: 35.0096, periodBasis: "billing-period" }) };
    return { ok: false, status: 404 };
  };
  quotaCalls.length = 0; softCalls.length = 0;
  const rt = await probeKey("k1");
  const usageUrl = urls.find((u) => u.includes("/usage/summary")) || "";
  check(usageUrl.includes("?since=") && !usageUrl.includes("&since="), "无 orgId 时 usage URL 以 ?since 起始（真实 API 回归）", usageUrl.slice(0, 120));
  check(rt.fiveHour && rt.fiveHour.resetAt === null, "resetAt=0（epoch 数字 0）解析为 null", JSON.stringify(rt.fiveHour));
  check(rt.weekly && rt.weekly.resetAt === new Date(msReset).toISOString(), "epoch-ms resetAt 转 ISO 保留", JSON.stringify(rt.weekly));
  check(rt.totals && rt.totals.runs === 12489 && rt.totals.tokens === 1879348409 && rt.totals.tokensIn === 1871710189 && rt.totals.successRate === 100, "totals 采集 Total Runs/Tokens/成功率", JSON.stringify(rt.totals));
  check(rt.creditsUsd && rt.creditsUsd.periodStart === "2026-08-25T23:33:28.000Z", "creditsUsd 附 periodStart", JSON.stringify(rt.creditsUsd).slice(0, 150));
  check(quotaCalls[0]?.[1] === "weekly" && quotaCalls[0]?.[2] === msReset, "weekly 100%+epoch-ms resetAt → 硬限制到正确时刻", JSON.stringify(quotaCalls));

  // ══ 真实 API 错误封装：HTTP 200 + success:false（实测 whoami 边缘节点抖动）══
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ success: false, error: { code: "UNAUTHORIZED", status: 401, message: "x" } })
  });
  const t2 = await testKey("k1");
  check(t2.ok === false, "testKey 识别 200+success:false 封装为失败（不再误报有效）", JSON.stringify(t2));

  // 新 Key（无 prev）首次探测即失败 → updatedAt=null + error（前端据此显示"获取失败"而非"过期"）
  quotaCalls.length = 0;
  const r9 = await probeKey("k9"); // t2 桩：所有请求 200+success:false(UNAUTHORIZED)
  check(r9 && r9.stale === true && r9.updatedAt === null && typeof r9.error === "string" && r9.error.includes("UNAUTHORIZED"), "首次探测失败 → stale 且 updatedAt=null + error", JSON.stringify(r9));
  // 用 credits 200 封装验证 stale 报告带 error：
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/alpha/whoami")) return { ok: true, status: 200, json: async () => ({ success: true, data: { org: { id: "o1" } } }) };
    return { ok: true, status: 200, json: async () => ({ success: false, error: { code: "RATE_UNAVAILABLE", status: 503 } }) };
  };
  quotaCalls.length = 0;
  const r10 = await probeKey("k1");
  check(r10.stale === true && typeof r10.error === "string" && r10.error.includes("RATE_UNAVAILABLE"), "stale 报告附带失败原因 error 字段", JSON.stringify(r10).slice(0, 200));
  check(quotaCalls.length === 0, "stale 不触发额度限制", JSON.stringify(quotaCalls));
  check(r10.fiveHour !== null && r10.fiveHour.cap === 14 && r10.fiveHour.percent === 0, "stale 保留上次成功的 fiveHour", JSON.stringify(r10.fiveHour));
}

// ════ keyPool ════
if (SC === "pool") {
  console.log("=== keyPool 选 Key ===");
  const { initKeyPool, addKey, selectKey, setQuotaLimited, setSoftLimited, recordRateLimit, recordTimeout, markAuthError, clearAuthError, clearBackoff, recordFailover, nextRetryAfterMs, setPoolCfg, getPoolStats, getHealth, beginAttempt, recordSuccess } =
    await import("../src/keyPool.mjs");
  initKeyPool({ strategy: "active-standby", failoverCooldownMs: 0, backoffBaseMs: 5000, backoffMaxMs: 120000 }, {});
  const k1 = addKey({ alias: "A", key: "user_aaa111" });
  const k2 = addKey({ alias: "B", key: "user_bbb222" });
  check(selectKey().id === k1.id, "默认选主 Key");
  setQuotaLimited(k1.id, Date.now() + 60000, "fiveHour");
  check(selectKey().id === k2.id, "quota_limited 跳过主→备");
  const quotaWait = nextRetryAfterMs();
  check(quotaWait > 55000 && quotaWait <= 60000, "普通 quota window 仍作为 Retry-After 候选", String(quotaWait));
  setQuotaLimited(k1.id, 0, "");
  check(selectKey().id === k1.id, "解除→回主");
  recordRateLimit(k1.id, 30000);
  check(selectKey().id === k2.id, "退避跳过主→备");
  check(getHealth(k1.id).lastErrorKind === "rate_limit", "429 退避保留 rate_limit 错误类别", JSON.stringify(getHealth(k1.id)));
  const ra = nextRetryAfterMs();
  check(ra > 25000 && ra <= 30000, "nextRetryAfterMs≈剩余退避", String(ra));
  markAuthError(k2.id);
  check(selectKey() === null, "authError+退避 → null 全不可用");
  check(getPoolStats().authError === 1, "poolStats.authError 计数");
  check(getHealth(k2.id).lastErrorKind === "auth", "401 认证错误类别独立保留", JSON.stringify(getHealth(k2.id)));

  // 真实异步交错：旧请求 A 在等待上游时，B 对同一 Key 先写入新的 429 状态。
  // A 的成功 token 过期后必须跳过清理，不能只靠连续同步调用验证。
  const staleAttempt = beginAttempt(k1.id);
  const delayedSuccess = new Promise((resolveP) => setTimeout(() => resolveP(recordSuccess(k1.id, staleAttempt)), 25));
  await new Promise((resolveP) => setTimeout(resolveP, 5));
  recordRateLimit(k1.id, 60000);
  const staleResult = await delayedSuccess;
  const staleHealth = getHealth(k1.id);
  check(staleResult && staleResult.applied === false && staleResult.reason === "health_changed", "并发旧成功被条件更新拒绝", JSON.stringify(staleResult));
  check(staleHealth.failCount === 2 && staleHealth.backoffUntilMs > Date.now() && staleHealth.lastErrorKind === "rate_limit",
    "并发交错保留最新 failCount/backoff/errorKind", JSON.stringify(staleHealth));
  clearBackoff(k1.id);

  // auth-only 池没有可恢复的自动等待；人工修复的一小时标记不得冒充 Retry-After。
  markAuthError(k1.id);
  check(nextRetryAfterMs() === 0, "auth-only pool Retry-After 不返回人工修复的一小时", String(nextRetryAfterMs()));
  clearAuthError(k1.id);
  clearAuthError(k2.id);

  // 软限制降级（P3-1）
  recordSuccess(k1.id, beginAttempt(k1.id));
  check(selectKey().id === k1.id, "恢复后选主");
  setSoftLimited(k1.id, true);
  check(selectKey().id === k2.id, "主 Key 软限制 → 降级选备（P3-1）");
  setSoftLimited(k2.id, true);
  check(selectKey() !== null, "全软限制仍可选出 Key（兜底不中断）");
  setSoftLimited(k1.id, false); setSoftLimited(k2.id, false);
  // 排除已试 Key（P2-2 语义）
  check(selectKey(new Set([k1.id])).id === k2.id, "excludeIds 排除主 Key");
  check(selectKey(new Set([k1.id, k2.id])) === null, "全部排除 → null");
  // 冷却期
  setPoolCfg({ strategy: "active-standby", failoverCooldownMs: 600000 });
  recordFailover(selectKey().id);
  check(selectKey() !== null, "冷却期内仍可选 Key（服务不中断）");
  // round-robin 不受软限制影响（均摊语义保留）
  setPoolCfg({ strategy: "round-robin", failoverCooldownMs: 0 });
  setSoftLimited(k1.id, true);
  const seen = new Set();
  for (let i = 0; i < 4; i++) seen.add(selectKey().id);
  check(seen.has(k1.id) && seen.has(k2.id), "round-robin 软限制 Key 仍参与均摊", [...seen].join(","));
}

// ════ stats ════
if (SC === "stats") {
  console.log("=== stats 保留清理 ===");
  const now = Date.now();
  const seed = [
    { ts: now - 8 * 864e5, keyId: "k1", ok: true, status: 200, model: "old" },
    { ts: now - 3 * 864e5, keyId: "k1", ok: false, status: 429, errorKind: "rate_limit", model: "mid" },
    { ts: now - 60e3, keyId: "k1", ok: true, status: 200, model: "new", inputTokens: 100, outputTokens: 50 },
  ];
  writeFileSync(DATA + "/stats.jsonl", seed.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
  const { initStats, queryEvents, usageByKey, setRetention, appendEvent, poolStats } = await import("../src/stats.mjs");
  initStats({ emit: () => {} }, 7);
  const q = queryEvents({});
  check(q.total === 2, "启动回放剔除超保留期事件", "total=" + q.total);
  check(q.items[0].model === "new", "时间倒序");
  const u = usageByKey("k1");
  check(u.h5.requests === 1 && u.d7.requests === 2 && u.d30Valid === false, "窗口统计 + d30 回退标记");
  const ps = poolStats();
  check(ps.requests === 2 && ps.err429 === 1 && ps.success === 1, "poolStats 聚合", JSON.stringify(ps));
  setRetention(1);
  check(queryEvents({}).total === 1, "retention 调整即时 prune", String(queryEvents({}).total));
  const fileLines = readFileSync(DATA + "/stats.jsonl", "utf8").trim().split("\n").length;
  check(fileLines === 1, "prune 重写文件", "file=" + fileLines);
  appendEvent({ keyId: "k1", ok: true, status: 200, model: "app" });
  check(queryEvents({}).total === 2, "appendEvent 落盘");
  // P1-6：appendEvent 入口数值净化——脏类型不落盘，有限数（含数字字符串）归一为 number
  appendEvent({
    keyId: "k1", ok: true, status: "200", model: "dirty",
    inputTokens: "12/><img src=x>", outputTokens: { evil: 1 }, cachedTokens: null,
    latencyMs: 42.5, retries: Infinity
  });
  const dirty = queryEvents({}).items.find((e) => e.model === "dirty");
  check(dirty.model === "dirty", "净化用例事件已入库");
  check(dirty.inputTokens === undefined, "字符串 usage → 字段删除", JSON.stringify(dirty.inputTokens));
  check(dirty.outputTokens === undefined, "对象 usage → 字段删除", JSON.stringify(dirty.outputTokens));
  check(dirty.cachedTokens === undefined, "null usage → 字段删除（保持缺省语义）", JSON.stringify(dirty.cachedTokens));
  check(dirty.retries === undefined, "Infinity retries → 字段删除", JSON.stringify(dirty.retries));
  check(dirty.latencyMs === 42.5 && typeof dirty.latencyMs === "number", "合法 latencyMs 原样保留");
  check(dirty.status === 200 && typeof dirty.status === "number", "数字字符串 status → 归一 number（429 判定不回退）", JSON.stringify(dirty.status));
  appendEvent({ keyId: "k1", ok: false, status: 429, errorKind: "rate_limit", model: "keep" });
  const kept = queryEvents({}).items.find((e) => e.model === "keep");
  check(kept.status === 429 && kept.ok === false, "正常 status/ok 语义不回退");
  // 聚合不被脏事件污染：dirty 事件 token 字段删除后窗口聚合仍只计合法事件
  const u2 = usageByKey("k1");
  check(u2.h5.input === 100, "脏数据不进 token 聚合", "input=" + u2.h5.input);
  const mode = (statSync(DATA + "/stats.jsonl").mode & 0o777).toString(8);
  check(mode === "600", "stats.jsonl 权限 600", mode);
  setRetention(999); // clamp 31
  check(usageByKey("k1").d30Valid === true, "setRetention 越界后仍按 31 天上限启用 d30", JSON.stringify(usageByKey("k1")));
  // ── 终检加固：读侧净化——修复前已落盘的脏 usage 重启回放后不得进聚合（用 ?fresh
  //    查询串绕过模块缓存拿独立实例；DATA_DIR 经 config.mjs 缓存仍指向同一临时目录）──
  const now2 = Date.now();
  writeFileSync(DATA + "/stats.jsonl", [
    { ts: now2 - 10e3, keyId: "kx", ok: true, status: 200, model: "clean", inputTokens: 10, outputTokens: 5 },
    { ts: now2 - 5e3, keyId: "kx", ok: true, status: 200, model: "dirtyload", inputTokens: "12/><img>", outputTokens: { evil: 1 }, cachedTokens: null, retries: "x" }
  ].map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
  const S2 = await import("../src/stats.mjs?freshload");
  S2.initStats({ emit: () => {} }, 7);
  const u3 = S2.usageByKey("kx");
  check(u3.d7.input === 10 && u3.d7.output === 5, "load() 读侧净化：历史脏 usage 不进窗口聚合", JSON.stringify(u3.d7));
  const dl = S2.queryEvents({}).items.find((e) => e.model === "dirtyload");
  check(dl && dl.inputTokens === undefined && dl.outputTokens === undefined && dl.cachedTokens === undefined && dl.retries === undefined,
    "load() 读侧净化：脏字段从回放事件删除（保持缺省语义）", JSON.stringify(dl));
  const cl = S2.queryEvents({}).items.find((e) => e.model === "clean");
  check(cl && cl.inputTokens === 10 && cl.status === 200, "load() 读侧净化不误伤合法数值字段");
}

// ════ logs（持久化 + proxy 捕获）════
if (SC === "logs") {
  console.log("=== logs 持久化与上游捕获 ===");
  const { EventEmitter } = await import("events");
  const L = await import("../src/logs.mjs");
  const { attachConsoleCapture, initLogs, getLogs, setRetention } = L;
  const bus = new EventEmitter();
  const realLog = console.log;

  // 1) 捕获早于回放（两阶段启动）：先挂捕获。
  //    上游 log() 是单参数预格式化字符串（模板字面量），测试保持一致形态
  attachConsoleCapture();
  const oldIso = new Date(Date.now() - 10 * 864e5).toISOString().replace(/\.\d{3}Z$/, "Z");
  const tsA = Date.now() - 5000;
  console.log(`[${oldIso}] [info] CC Proxy started {"url":"http://127.0.0.1:3050"}`);
  console.log(`[${new Date(tsA).toISOString().replace(/\.\d{3}Z$/, "Z")}] [warn] Stream idle timeout {"model":"m1"}`);
  console.log(`[${new Date(tsA + 1000).toISOString().replace(/\.\d{3}Z$/, "Z")}] [error] Upstream error {"message":"boom"}`);
  // keyPrefix 脱敏
  console.log(`[${oldIso}] [info] Fingerprint generated for key {"keyPrefix":"user_ABCDEF123456"}`);
  // abort 噪音去重（30s 内第二条吞掉）
  const abortIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  console.log(`[${abortIso}] [info] Aborted request cleaned up`);
  console.log(`[${abortIso}] [info] Aborted request cleaned up`);
  // 非 proxy 格式不捕获
  console.log("random manager output");
  // 重入防护：再 attach 一次不应重复挂钩
  attachConsoleCapture();
  const reentryMarker = "reentry-check-" + Date.now();
  const beforeReentry = readFileSync(DATA + "/events.jsonl", "utf8").split("\n").filter((line) => line.includes(reentryMarker)).length;
  console.log(`[${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}] [info] ${reentryMarker}`);
  const afterReentry = readFileSync(DATA + "/events.jsonl", "utf8").split("\n").filter((line) => line.includes(reentryMarker)).length;
  check(afterReentry === beforeReentry + 1, "捕获挂接 + 重入防护只写入一条日志", `before=${beforeReentry} after=${afterReentry}`);

  // 2) initLogs 回放：文件里已有上面捕获的行，回放去重（不应翻倍）
  initLogs(bus, 7);
  const after = getLogs({});
  const proxyRows = after.filter((l) => l.src === "proxy");
  const dup = proxyRows.length - new Set(proxyRows.map((l) => l.ts + "|" + l.msg)).size;
  check(dup === 0, "捕获期直写 + 回放合并无重复", "proxyRows=" + proxyRows.length + " dup=" + dup);
  check(after.some((l) => l.msg.includes("CC Proxy started") && l.level === "info" && Date.now() - l.ts > 9 * 864e5), "proxy 行按日志内 ISO 时间戳入库（非当前时间）", JSON.stringify(after.find((l) => l.msg.includes("CC Proxy started"))));
  check(after.some((l) => l.msg.includes("boom") && l.level === "error"), "error 级捕获 + 附加参数拼接");
  const fp = after.find((l) => l.msg.includes("Fingerprint"));
  check(fp && fp.msg.includes("user_***") && !fp.msg.includes("ABCDEF"), "keyPrefix 脱敏", JSON.stringify(fp && fp.msg));
  const aborts = after.filter((l) => l.msg.startsWith("Aborted request"));
  check(aborts.length === 1, "abort 噪音 30s 去重（2→1）", "got=" + aborts.length);
  check(!after.some((l) => l.msg.includes("random manager output")), "非 proxy 格式行不入环");

  // 3) manager emit 通路（bus emit log → listener append，src 默认 manager）
  bus.emit("log", { level: "info", msg: "新增 Key: user_x***yz" });
  const mgrRows = getLogs({ src: "manager" });
  check(mgrRows.some((l) => l.msg.includes("新增 Key") && l.src === "manager"), "manager emit 入环 src=manager");
  const onlyProxy = getLogs({ src: "proxy" });
  check(onlyProxy.every((l) => l.src === "proxy"), "src=proxy 过滤纯净");
  check(getLogs({}).length >= mgrRows.length + onlyProxy.length, "src 过滤不影响全量查询");

  // 4) 落盘权限 + retention 清理
  const mode = (statSync(DATA + "/events.jsonl").mode & 0o777).toString(8);
  check(mode === "600", "events.jsonl 权限 600", mode);
  // 未来时间戳行：setRetention 缩小窗口后仍保留；旧行被清理
  const beforeN = getLogs({}).length;
  setRetention(1); // 1 天：ISO 2026-09-01T00:00 的行相对当前(09-01 中午后)可能仍在 1 天内；用远古 ts 行验证
  bus.emit("log", { ts: 1500000000000, level: "info", msg: "ancient" }); // 2017 年
  setRetention(1);
  check(!getLogs({}).some((l) => l.msg === "ancient"), "retention 清理过期行");
  void beforeN;
}

// ════ tokens（P1-3 常量时间比较）════
if (SC === "tokens") {
  console.log("=== tokens 常量时间比较 ===");
  const { safeEqual } = await import("../src/tokens.mjs");
  check(safeEqual("abc123", "abc123") === true, "等值 → true");
  check(safeEqual("", "") === true, "双空串 → true");
  check(safeEqual("abc123", "abc124") === false, "不等值 → false");
  check(safeEqual("short", "much-longer-string-value") === false, "长度不等 → false（无长度侧信道）");
  check(safeEqual(undefined, "tok") === false, "undefined 左 → false（header 缺失场景）");
  check(safeEqual("tok", undefined) === false, "undefined 右 → false");
  check(safeEqual(undefined, undefined) === false, "undefined×2 → false（必须显式字符串）");
  check(safeEqual(null, null) === false, "null×2 → false");
  check(safeEqual(123, "123") === false, "非字符串数字 → false");
  check(safeEqual({}, {}) === false, "对象入参 → false");
}

// ════ state（P2-4 防抖 flush 语义）════
if (SC === "state") {
  console.log("=== state 防抖写盘 flush（P2-4） ===");
  // DATA_DIR 在本进程 import state.mjs 前已设（见文件头），config.mjs 冻结的就是临时目录
  const { debouncedWriter, flushAllPending, readJson } = await import("../src/state.mjs");
  const delayMs = 2000; // 远大于用例内等待 → 落盘只可能来自 flush，而非 timer 触发

  // 1) schedule() 后不等 delayMs，flush 立即落盘且内容 = flush 时刻的 getData()
  let payload = { v: 1 };
  const w1 = debouncedWriter("t1.json", () => payload, delayMs);
  w1();
  payload = { v: 2 }; // getData 在 flush 时才取值 → 应写入 2
  const t0 = Date.now();
  flushAllPending();
  const dt = Date.now() - t0;
  check(dt < 500, "flush 即时返回（未等 2000ms 防抖）", "dt=" + dt + "ms");
  check(readJson("t1.json", null) && readJson("t1.json", null).v === 2, "flush 立即落盘且取 flush 时刻数据", JSON.stringify(readJson("t1.json", null)));

  // 2) 同一 writer 重复 flush 幂等：不报错、不重复写（第二次不得用新数据再写）
  w1.flush();
  payload = { v: 3 };
  flushAllPending(); // w1 已无 timer → no-op；内容必须仍是 2
  check(readJson("t1.json", null).v === 2, "重复 flush 幂等 no-op（数据不变不报错）", JSON.stringify(readJson("t1.json", null)));

  // 3) flush 必须 clear旧 timer：payload 已改为 v=3，若 2000ms 后文件仍是 2，
  //    证明 flush 调用了 clearTimeout（否则残留 timer 会用 getData()=3 回写）
  payload = { v: 3 };
  await new Promise((r) => setTimeout(r, delayMs + 500));
  check(readJson("t1.json", null).v === 2, "flush 后残留 timer 已清除（超时后不回写新数据）", JSON.stringify(readJson("t1.json", null)));
  const w3 = debouncedWriter("t3.json", () => ({ v: "auto" }), 200);
  w3(); // 未 flush 的短延迟 writer：验证 timer 仍照常自动落盘（原语义不回归）
  await new Promise((r) => setTimeout(r, 400));
  check(readJson("t3.json", null) && readJson("t3.json", null).v === "auto", "未 flush 时防抖 timer 自动落盘（旧行为保留）");
  // flush 后可再 schedule/flush；全量 flushAllPending 对混合状态 writer 均不抛错
  w1();
  w1.flush();
  flushAllPending();
  check(readJson("t1.json", null).v === 3, "flush 后可再 schedule，数据更新可再次落盘", JSON.stringify(readJson("t1.json", null)));

  // 4) 从未 schedule 的 writer：flush 是 no-op，不产生文件
  const w4 = debouncedWriter("t4.json", () => ({ x: 1 }), delayMs);
  w4.flush();
  check(readJson("t4.json", "MISSING") === "MISSING", "未调度的 writer flush 不写盘", String(readJson("t4.json", "MISSING")));

  // 5) 信号路径模拟：schedule 后进程"退出前"flushAllPending → 数据不丢
  let live = { backoff: 42 };
  const w5 = debouncedWriter("t5.json", () => live, delayMs);
  w5();
  live = { backoff: 43 };
  flushAllPending();
  const saved = readJson("t5.json", null);
  check(saved && saved.backoff === 43, "防抖窗口内 flushAllPending 不丢待写数据（信号路径前提）", JSON.stringify(saved));
}

// ════ durable（F04 持久化提交边界）════
if (SC === "durable") {
  console.log("=== durable write 提交边界 ===");
  process.env.ADMIN_TOKEN = "unit-admin-token-1234";
  process.env.CLIENT_TOKEN = "unit-client-token-5678";
  const { loadConfig, getConfig, saveConfig } = await import("../src/config.mjs");
  const { writeJson, readJson, debouncedWriter, flushAllPending } = await import("../src/state.mjs");
  const pool = await import("../src/keyPool.mjs");
  const { getPersistenceStatus } = await import("../src/persistence.mjs");

  loadConfig();
  const configPath = DATA + "/config.json";
  const readConfig = () => JSON.parse(readFileSync(configPath, "utf-8"));
  const originalWrite = fs.writeFileSync;
  const originalRename = fs.renameSync;
  const failOn = (method, suffix, message) => {
    if (method === "write") {
      fs.writeFileSync = (...args) => String(args[0]).endsWith(suffix)
        ? (() => { throw new Error(message); })()
        : originalWrite(...args);
    } else {
      fs.renameSync = (...args) => String(args[0]).endsWith(suffix)
        ? (() => { throw new Error(message); })()
        : originalRename(...args);
    }
  };
  const restoreFs = () => {
    fs.writeFileSync = originalWrite;
    fs.renameSync = originalRename;
  };
  const expectFailure = (fn) => {
    try { fn(); return null; } catch (e) { return e; }
  };

  try {
    check(writeJson("direct.json", { version: 1 }) === true, "writeJson 成功返回 true");
    check(readJson("direct.json", null).version === 1, "writeJson 成功内容落盘");

    failOn("write", "write-fail.json.tmp", "simulated write failure");
    const writeFailure = expectFailure(() => writeJson("write-fail.json", { version: 2 }));
    check(writeFailure && writeFailure.code === "PERSISTENCE_ERROR" && writeFailure.statusCode === 503,
      "writeFileSync 失败抛出明确 503 持久化错误", String(writeFailure && writeFailure.message));
    check(!fs.existsSync(DATA + "/write-fail.json") && !fs.existsSync(DATA + "/write-fail.json.tmp"),
      "writeFileSync 失败不留下目标/临时文件");
    restoreFs();
    writeJson("write-fail.json", { version: 2 });

    writeJson("rename-fail.json", { version: 1 });
    failOn("rename", "rename-fail.json.tmp", "simulated rename failure");
    const renameFailure = expectFailure(() => writeJson("rename-fail.json", { version: 2 }));
    check(renameFailure && renameFailure.code === "PERSISTENCE_ERROR" && renameFailure.statusCode === 503,
      "renameSync 失败抛出明确 503 持久化错误", String(renameFailure && renameFailure.message));
    check(readJson("rename-fail.json", null).version === 1 && !fs.existsSync(DATA + "/rename-fail.json.tmp"),
      "renameSync 失败保留旧磁盘内容并清理临时文件");
    restoreFs();
    writeJson("rename-fail.json", { version: 2 });

    const diskBeforeConfig = readConfig();
    const configCandidate = { ...getConfig(), clientToken: "unit-client-token-new" };
    failOn("write", "config.json.tmp", "simulated config write failure");
    const configWriteFailure = expectFailure(() => saveConfig(configCandidate));
    check(configWriteFailure && configWriteFailure.statusCode === 503,
      "saveConfig writeFileSync 失败返回持久化错误", String(configWriteFailure && configWriteFailure.message));
    check(getConfig().clientToken === diskBeforeConfig.clientToken && readConfig().clientToken === diskBeforeConfig.clientToken,
      "saveConfig 失败时内存与磁盘均保持旧配置");
    restoreFs();
    saveConfig(getConfig());

    failOn("rename", "config.json.tmp", "simulated config rename failure");
    const configRenameFailure = expectFailure(() => saveConfig(configCandidate));
    check(configRenameFailure && configRenameFailure.statusCode === 503,
      "saveConfig renameSync 失败返回持久化错误", String(configRenameFailure && configRenameFailure.message));
    check(getConfig().clientToken === diskBeforeConfig.clientToken && readConfig().clientToken === diskBeforeConfig.clientToken && !fs.existsSync(configPath + ".tmp"),
      "saveConfig rename 失败不切换内存且保留旧磁盘内容");
    restoreFs();
    saveConfig(getConfig());

    pool.initKeyPool(getConfig().pool);
    const first = pool.addKey({ alias: "first", key: "user_unit_first" });
    const keysBeforeFailure = pool.listKeys();
    const diskKeysBeforeFailure = JSON.parse(readFileSync(DATA + "/keys.json", "utf-8"));
    failOn("write", "keys.json.tmp", "simulated keys write failure");
    const addFailure = expectFailure(() => pool.addKey({ alias: "second", key: "user_unit_second" }));
    check(addFailure && addFailure.statusCode === 503, "Key 添加失败返回持久化错误", String(addFailure && addFailure.message));
    check(JSON.stringify(pool.listKeys()) === JSON.stringify(keysBeforeFailure) &&
      JSON.stringify(JSON.parse(readFileSync(DATA + "/keys.json", "utf-8"))) === JSON.stringify(diskKeysBeforeFailure),
      "Key 添加失败回滚内存和磁盘快照");
    restoreFs();
    writeJson("keys.json", diskKeysBeforeFailure);

    failOn("rename", "keys.json.tmp", "simulated keys rename failure");
    const updateFailure = expectFailure(() => pool.updateKey(first.id, { alias: "changed" }));
    check(updateFailure && updateFailure.statusCode === 503, "Key 更新失败返回持久化错误", String(updateFailure && updateFailure.message));
    check(pool.listKeys().find((k) => k.id === first.id).alias === "first" &&
      JSON.parse(readFileSync(DATA + "/keys.json", "utf-8")).keys[0].alias === "first",
      "Key 更新失败回滚内存和磁盘快照");
    restoreFs();
    writeJson("keys.json", diskKeysBeforeFailure);

    const readStateHealth = () => (readJson("state.json", { keys: {} }).keys || {})[first.id] || {};

    // Explicit health clears must commit immediately, including when the
    // preceding health mutation is still inside the debounce window.
    pool.markAuthError(first.id);
    const clearAuthResult = pool.clearAuthError(first.id);
    const authAfterClear = readStateHealth();
    check(clearAuthResult && clearAuthResult.durable === true, "clear-auth 返回 durable=true");
    check(authAfterClear.authError === false && authAfterClear.backoffUntilMs === 0,
      "clear-auth 强制 flush 后 state.json 即时更新", JSON.stringify(authAfterClear));
    await new Promise((resolveP) => setTimeout(resolveP, 1100));
    check(readStateHealth().authError === false && readStateHealth().backoffUntilMs === 0,
      "clear-auth 取消已有 timer 后不回写旧 health", JSON.stringify(readStateHealth()));

    // A failed forced flush restores the clear operation and keeps the prior
    // pending health snapshot queued for a later successful write.
    pool.markAuthError(first.id);
    const authBeforeWriteFailure = pool.getHealth(first.id);
    failOn("write", "state.json.tmp", "simulated state write failure");
    const clearAuthWriteFailure = expectFailure(() => pool.clearAuthError(first.id));
    restoreFs();
    check(clearAuthWriteFailure && clearAuthWriteFailure.code === "PERSISTENCE_ERROR" && clearAuthWriteFailure.statusCode === 503,
      "clear-auth write 失败抛出 503 持久化错误", String(clearAuthWriteFailure && clearAuthWriteFailure.message));
    check(JSON.stringify(pool.getHealth(first.id)) === JSON.stringify(authBeforeWriteFailure),
      "clear-auth write 失败回滚内存 health", JSON.stringify(pool.getHealth(first.id)));
    flushAllPending();
    check(readStateHealth().authError === true && readStateHealth().backoffUntilMs > Date.now(),
      "clear-auth write 失败后原 pending health 重新排队并可落盘", JSON.stringify(readStateHealth()));
    pool.clearAuthError(first.id);

    pool.recordTimeout(first.id);
    flushAllPending();
    const backoffBeforeRenameFailure = pool.getHealth(first.id);
    failOn("rename", "state.json.tmp", "simulated state rename failure");
    const clearBackoffRenameFailure = expectFailure(() => pool.clearBackoff(first.id));
    restoreFs();
    check(clearBackoffRenameFailure && clearBackoffRenameFailure.code === "PERSISTENCE_ERROR" && clearBackoffRenameFailure.statusCode === 503,
      "clear-backoff rename 失败抛出 503 持久化错误", String(clearBackoffRenameFailure && clearBackoffRenameFailure.message));
    check(JSON.stringify(pool.getHealth(first.id)) === JSON.stringify(backoffBeforeRenameFailure),
      "clear-backoff rename 失败回滚内存 health", JSON.stringify(pool.getHealth(first.id)));
    flushAllPending();
    check(readStateHealth().failCount === backoffBeforeRenameFailure.failCount && readStateHealth().backoffUntilMs === backoffBeforeRenameFailure.backoffUntilMs,
      "clear-backoff rename 失败后原 pending health 重新排队并可落盘", JSON.stringify(readStateHealth()));
    const clearBackoffResult = pool.clearBackoff(first.id);
    check(clearBackoffResult && clearBackoffResult.durable === true && readStateHealth().failCount === 0 && readStateHealth().backoffUntilMs === 0,
      "clear-backoff 成功后 state.json 即时更新", JSON.stringify(readStateHealth()));

    // The priority update keeps moveKey's success log, but a failed durable
    // commit must not announce a reorder that was rolled back.
    const logEvents = [];
    pool.initKeyPool(getConfig().pool, { emitter: { emit: (type, event) => { if (type === "log") logEvents.push(event); } } });
    const second = pool.addKey({ alias: "second", key: "user_unit_second" });
    logEvents.length = 0;
    pool.updateKey(first.id, { priority: 1 });
    check(logEvents.some((event) => String(event.msg || "").includes("调整主备顺序")),
      "priority update durable 成功后记录主备调整日志", JSON.stringify(logEvents));
    const orderBeforePriorityFailure = pool.listKeys().map((key) => key.id);
    logEvents.length = 0;
    failOn("rename", "keys.json.tmp", "simulated priority rename failure");
    const priorityFailure = expectFailure(() => pool.updateKey(first.id, { priority: 0 }));
    restoreFs();
    check(priorityFailure && priorityFailure.statusCode === 503, "priority durable 失败抛出 503", String(priorityFailure && priorityFailure.message));
    check(JSON.stringify(pool.listKeys().map((key) => key.id)) === JSON.stringify(orderBeforePriorityFailure) &&
      !logEvents.some((event) => String(event.msg || "").includes("调整主备顺序")),
      "priority durable 失败回滚顺序且不记录成功日志", JSON.stringify({ order: pool.listKeys().map((key) => key.id), logs: logEvents }));
    check(second && pool.getKeyRecord(second.id), "priority 日志回归保留 Key 记录");
    writeJson("keys.json", { keys: pool.listKeys() });

    const writer = debouncedWriter("async.json", () => ({ version: 3 }), 25);
    const scheduleResult = writer();
    check(scheduleResult && scheduleResult.scheduled === true && scheduleResult.durable === false,
      "防抖 schedule 明确标记 scheduled 且未 durable");
    check(!fs.existsSync(DATA + "/async.json"), "schedule 返回时尚未误报为已落盘");
    await new Promise((resolveP) => setTimeout(resolveP, 60));
    check(readJson("async.json", null).version === 3, "防抖 timer 最终真实落盘");
    check(getPersistenceStatus().available === true, "成功写入恢复持久化健康状态");
  } finally {
    restoreFs();
  }
}

console.log(`\n=== unit(${SC}) summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
