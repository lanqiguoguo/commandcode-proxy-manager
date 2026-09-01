// ── 单元测试（无网络，quota 用 stub fetch）：
//   quota 额度感知（硬阈值/软限制/stale/credits 到期兜底/陷阱规则）
//   keyPool 选 Key（主备/退避/authError/软限制降级/排除已试/冷却）
//   stats 保留清理（回放/prune/retention clamp/权限）
//   logs 持久化 + 上游 proxy 日志捕获（时序/去重/脱敏/src 过滤）
// 用法：node scripts/unit.mjs [quota|pool|stats|logs]   （缺省依次全部跑，每场景独立子进程）
import { mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const SC = process.argv[2];

if (!SC) {
  // runner 模式：逐场景子进程执行（DATA_DIR 在各子进程 import 前注入，互不污染）
  let failed = false;
  for (const s of ["quota", "pool", "stats", "logs", "tokens"]) {
    const code = await new Promise((resolveP) => {
      const p = spawn(process.execPath, [fileURLToPath(import.meta.url), s], { stdio: "inherit" });
      p.on("exit", (c) => resolveP(c));
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
  const { initKeyPool, addKey, selectKey, setQuotaLimited, setSoftLimited, recordRateLimit, markAuthError, clearAuthError, recordFailover, nextRetryAfterMs, setPoolCfg, getPoolStats, recordSuccess } =
    await import("../src/keyPool.mjs");
  initKeyPool({ strategy: "active-standby", failoverCooldownMs: 0, backoffBaseMs: 5000, backoffMaxMs: 120000 }, {});
  const k1 = addKey({ alias: "A", key: "user_aaa111" });
  const k2 = addKey({ alias: "B", key: "user_bbb222" });
  check(selectKey().id === k1.id, "默认选主 Key");
  setQuotaLimited(k1.id, Date.now() + 60000, "fiveHour");
  check(selectKey().id === k2.id, "quota_limited 跳过主→备");
  setQuotaLimited(k1.id, 0, "");
  check(selectKey().id === k1.id, "解除→回主");
  recordRateLimit(k1.id, 30000);
  check(selectKey().id === k2.id, "退避跳过主→备");
  const ra = nextRetryAfterMs();
  check(ra > 25000 && ra <= 30000, "nextRetryAfterMs≈剩余退避", String(ra));
  markAuthError(k2.id);
  check(selectKey() === null, "authError+退避 → null 全不可用");
  check(getPoolStats().authError === 1, "poolStats.authError 计数");
  // 软限制降级（P3-1）
  clearAuthError(k2.id);
  recordSuccess(k1.id);
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
  check(true, "setRetention 越界 clamp 不抛错");
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
  await new Promise((r) => setTimeout(r, 50));
  check(true, "捕获挂接 + 重入防护不抛错");

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

console.log(`\n=== unit(${SC}) summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
