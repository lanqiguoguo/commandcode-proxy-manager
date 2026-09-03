// ── 官方额度探测（whoami / billing / usage，软失败 + TTL 缓存） ──
import { readValidatedJson, debouncedWriter } from "./state.mjs";
import { validateQuotaCacheDocument } from "./persistenceSchema.mjs";

// 真实端点；e2e 通过 CC_QUOTA_BASE 指向 mock（与 config 的 host/port 覆写同风格）。
// 默认生产地址，未知环境变量不会产生任何行为差异。
const API_BASE = process.env.CC_QUOTA_BASE || "https://api.commandcode.ai";
const PATH_WHOAMI = "/alpha/whoami";
const PATH_CREDITS = "/alpha/billing/credits";
const PATH_SUBSCRIPTIONS = "/alpha/billing/subscriptions";
const PATH_USAGE = "/alpha/usage/summary";
const PROBE_TIMEOUT = 8000;

let cache = new Map();
let pool = null;
let cfg = { quotaRefreshMs: 60000, quotaRefreshGapMs: 2000, fiveHourHardStop: 90, weeklyHardStop: 90, softStop: 80 };
let persistCache = null;
let timer = null;
let emitter = null;

// 上游风控要求：多 Key 不得并发打官方 API。所有探测经串行队列，
// 自动全量刷新时 Key 之间再额外间隔 quotaRefreshGapMs。
let chain = Promise.resolve();
function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}
let sweeping = null; // 当前扫描的完成 promise（测试/调用方可 await，避免竞态）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function emitStatus(keyId, phase) {
  if (emitter) emitter.emit("quotaStatus", { keyId, phase, ts: Date.now() });
}

export function initQuota(poolRef, poolCfg, opts = {}) {
  pool = poolRef;
  cfg = { ...cfg, ...poolCfg };
  emitter = opts.emitter || null;
  const knownIds = new Set(pool.listKeys().map((key) => key.id));
  cache.clear();
  const saved = readValidatedJson("quota-cache.json", { reports: {} }, (value) =>
    validateQuotaCacheDocument(value, { knownIds })
  );
  if (saved && saved.reports) {
    for (const [id, r] of Object.entries(saved.reports)) {
      if (knownIds.has(id)) cache.set(id, r);
      else console.warn(`[quota] quota-cache.json reports.${id}: unknown key ignored`);
    }
  }
  persistCache = debouncedWriter("quota-cache.json", () => ({ reports: Object.fromEntries(cache) }), 2000);
  startTimer();
}

export function setRefreshMs(ms) {
  cfg.quotaRefreshMs = Math.max(5000, Number(ms) || 60000);
  startTimer();
  // 参数变更后立即探测一次，避免等待整周期
  refreshAll().catch(() => {});
}

function startTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => { refreshAll(); }, cfg.quotaRefreshMs || 60000);
  if (timer.unref) timer.unref();
}

// 探测结果：{ data } 成功，{ err, status } 失败（err 供上层记入 stale 报告展示）。
// 官方 API 存在两种失败形态：① HTTP 4xx/5xx；② HTTP 200 但 body 是
// {"success":false,"error":{code,status,message}} 业务封装（实测 whoami 偶发，
// 边缘节点/鉴权抖动）。fetchJson 只看 res.ok 会把后者当成功解析，导致
// 下游读不到 credits/windowLimits 而误标 stale 却无原因可查。
async function fetchJson(url, key) {
  return fetchJsonWithSignal(url, key);
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("probe aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

async function fetchJsonWithSignal(url, key, signal) {
  throwIfAborted(signal);
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", Authorization: "Bearer " + key },
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT)])
        : AbortSignal.timeout(PROBE_TIMEOUT)
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    return { err: "network: " + (e.cause?.code || e.message), status: 0 };
  }
  if (!res.ok) {
    let code = "";
    try { const j = await res.json(); code = (j.error && (j.error.code || j.error.message)) || ""; } catch {}
    return { err: "HTTP " + res.status + (code ? " " + code : ""), status: res.status };
  }
  let j;
  try { j = await res.json(); } catch { return { err: "bad JSON", status: res.status }; }
  if (j && j.success === false) {
    // HTTP 200 但业务层报错：任何 success:false 都按失败处理。
    const detail = j.error && (j.error.code || j.error.status || j.error.message);
    return { err: "api " + (detail || "error"), status: j.error?.status || res.status };
  }
  return { data: j };
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function isRecord(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function unwrapData(v) {
  if (!isRecord(v)) return null;
  return Object.prototype.hasOwnProperty.call(v, "data") ? v.data : v;
}

function requirePayload(label, result) {
  if (result.err) throw new Error(label + ": " + result.err);
  const payload = unwrapData(result.data);
  if (!isRecord(payload) || Object.keys(payload).length === 0) {
    throw new Error(label + ": empty or invalid response");
  }
  return payload;
}

function parseCredits(v) {
  if (!isRecord(v)) return null;
  const fields = ["monthlyCredits", "purchasedCredits", "freeCredits"];
  let present = 0;
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(v, field)) continue;
    const value = num(v[field]);
    if (value === undefined || value < 0) return null;
    present++;
  }
  return present > 0 ? v : null;
}

function optionalTime(label, value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new Error(label + ": invalid time");
  }
  return value;
}

function nonNegativeNumber(label, field, value) {
  const parsed = num(value);
  if (parsed === undefined || parsed < 0) throw new Error(label + ": invalid " + field);
  return parsed;
}

function validateUsageNumbers(usage) {
  const fields = [
    "totalCost", "totalMonthlyCredits", "totalCredits", "totalCount",
    "completedCount", "failedCount", "totalTokensIn", "totalTokensOut", "totalTokens",
    "successRate"
  ];
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(usage, field)) continue;
    const value = nonNegativeNumber("usage", field, usage[field]);
    if (field === "successRate" && value > 100) throw new Error("usage: invalid successRate");
  }
}

// 真实 API 中 resetAt 有两种形态：ISO 字符串 或 epoch 毫秒数字（0=无值），均可能出现
function parseWindow(w) {
  if (!isRecord(w)) return null;
  const cap = num(w.cap);
  const used = num(w.used);
  if (cap === undefined || used === undefined || cap <= 0 || used < 0) return null;
  let resetAt = null;
  if (w.resetAt !== undefined && w.resetAt !== null && w.resetAt !== "") {
    if (typeof w.resetAt === "number") {
      if (!Number.isFinite(w.resetAt) || w.resetAt < 0) return null;
      if (w.resetAt > 0) {
        const date = new Date(w.resetAt);
        if (!Number.isFinite(date.getTime())) return null;
        resetAt = date.toISOString();
      }
    } else if (typeof w.resetAt === "string" && Number.isFinite(Date.parse(w.resetAt))) {
      resetAt = w.resetAt;
    } else {
      return null;
    }
  }
  return {
    cap,
    used,
    percent: Math.round((used / cap) * 1000) / 10,
    resetAt
  };
}

function toMs(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}

export function probeKey(keyId, options = {}) {
  const signal = options?.signal;
  return enqueue(async () => {
    throwIfAborted(signal);
    emitStatus(keyId, "updating");
    try {
      const out = await doProbe(keyId, signal);
      emitStatus(keyId, out && out.stale ? "error" : "done");
      return out;
    } catch (e) {
      emitStatus(keyId, "error");
      throw e;
    }
  });
}

async function doProbe(keyId, signal) {
  throwIfAborted(signal);
  const rec = pool.getKeyRecord(keyId);
  if (!rec || !rec.key) return null;
  const prev = cache.get(keyId) || null;
  const report = { fiveHour: null, weekly: null, creditsUsd: null, totals: null, updatedAt: Date.now(), stale: true };
  let ok = false;
  let probeErr = "";
  try {
    const whoami = requirePayload("whoami", await fetchJsonWithSignal(API_BASE + PATH_WHOAMI, rec.key, signal));
    if (whoami.org !== undefined && (!isRecord(whoami.org) || typeof whoami.org.id !== "string" || !whoami.org.id)) {
      throw new Error("whoami: invalid org structure");
    }
    if (whoami.user !== undefined && (!isRecord(whoami.user) || typeof whoami.user.id !== "string" || !whoami.user.id)) {
      throw new Error("whoami: invalid user structure");
    }
    if (whoami.org === undefined && whoami.user === undefined) {
      throw new Error("whoami: missing org or user structure");
    }
    const orgId = whoami.org ? whoami.org.id : null;
    const orgQuery = orgId ? "?orgId=" + encodeURIComponent(orgId) : "";

    const credits = requirePayload("credits", await fetchJsonWithSignal(API_BASE + PATH_CREDITS + orgQuery, rec.key, signal));
    const creditsObj = parseCredits(credits.credits);
    if (!creditsObj) throw new Error("credits: invalid or empty credits");
    if (!isRecord(credits.windowLimits)) throw new Error("credits: missing windowLimits");
    const fiveHour = parseWindow(credits.windowLimits.fiveHour);
    const weekly = parseWindow(credits.windowLimits.weekly);
    if (!fiveHour || !weekly) throw new Error("credits: invalid fiveHour or weekly window");
    report.fiveHour = fiveHour;
    report.weekly = weekly;

    // 订阅周期内美元额度：没有周期起点是合法的无账期数据，不请求裸 usage。
    const sub = requirePayload("subscriptions", await fetchJsonWithSignal(API_BASE + PATH_SUBSCRIPTIONS + orgQuery, rec.key, signal));
    const rawPeriodStart = sub.currentPeriodStart;
    const periodEnd = optionalTime("subscriptions.currentPeriodEnd", sub.currentPeriodEnd);
    let periodStart = "";
    if (rawPeriodStart !== undefined && rawPeriodStart !== null && rawPeriodStart !== "") {
      if (typeof rawPeriodStart !== "string" || !rawPeriodStart.trim() || !Number.isFinite(Date.parse(rawPeriodStart))) {
        throw new Error("subscriptions: invalid currentPeriodStart");
      }
      periodStart = rawPeriodStart;
    }
    if (periodStart) {
      // 无 orgId 时 orgQuery 为空串，必须用 ? 起始，否则 "&since=" 拼出非法 URL（真实 API 实测 404）
      const usageSep = orgQuery ? "&" : "?";
      const usage = requirePayload("usage", await fetchJsonWithSignal(API_BASE + PATH_USAGE + orgQuery + usageSep + "since=" + encodeURIComponent(periodStart), rec.key, signal));
      validateUsageNumbers(usage);
      const used = Object.prototype.hasOwnProperty.call(usage, "totalCost")
        ? nonNegativeNumber("usage", "totalCost", usage.totalCost)
        : Object.prototype.hasOwnProperty.call(usage, "totalMonthlyCredits")
          ? nonNegativeNumber("usage", "totalMonthlyCredits", usage.totalMonthlyCredits)
          : undefined;
      if (used === undefined) throw new Error("usage: missing valid totalCost or totalMonthlyCredits");
      const pools = ["monthlyCredits", "purchasedCredits", "freeCredits"]
        .map((k) => num(creditsObj[k]))
        .filter((v) => v !== undefined)
        .map((v) => Math.max(0, v));
      const remaining = pools.reduce((s, v) => s + v, 0);
      const limit = used + remaining;
      if (!Number.isFinite(remaining) || !Number.isFinite(limit)) throw new Error("usage: numeric result overflow");
      report.creditsUsd = {
        used,
        remaining,
        limit,
        percent: limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0,
        expiresAt: periodEnd,
        periodStart
      };
      // 账期总用量（对应官网 settings/usage 页的 Total 卡片）：调用次数/Token/成功率
      if (num(usage.totalCount) !== undefined || num(usage.totalTokens) !== undefined) {
        report.totals = {
          runs: num(usage.totalCount) ?? 0,
          completed: num(usage.completedCount) ?? 0,
          failed: num(usage.failedCount) ?? 0,
          successRate: num(usage.successRate),
          tokensIn: num(usage.totalTokensIn) ?? 0,
          tokensOut: num(usage.totalTokensOut) ?? 0,
          tokens: num(usage.totalTokens) ?? 0,
          cost: num(usage.totalCost) ?? num(usage.totalCredits) ?? 0
        };
      }
    }
    ok = true;
    probeErr = "";
    report.updatedAt = Date.now();
  } catch (e) {
    if (signal?.aborted) throw e;
    probeErr = e && e.message ? e.message : ("exception: " + String(e));
    // 探测失败：走下方统一失败路径
  }
  throwIfAborted(signal);
  // 决策 3：失败时保留上次成功值并标记 stale，绝不丢数据
  // updatedAt：保留上次成功时间戳；从未成功过时为 null（前端显示"获取失败"而非"过期"）
  const final = ok ? { ...report, stale: false } : {
    fiveHour: prev && prev.fiveHour ? prev.fiveHour : null,
    weekly: prev && prev.weekly ? prev.weekly : null,
    creditsUsd: prev && prev.creditsUsd ? prev.creditsUsd : null,
    totals: prev && prev.totals ? prev.totals : null,
    updatedAt: prev && prev.updatedAt ? prev.updatedAt : null,
    error: probeErr || "probe failed",
    stale: true
  };
  cache.set(keyId, final);
  persistCache();
  if (!final.stale) applyLimits(keyId, final);
  if (emitter) emitter.emit("quota", { keyId, report: final });
  return final;
}

// 决策 2：额度感知限制——5h/每周硬阈值、美元耗尽 → quota_limited；≥softStop → 软限制降级
// 阈值实时读 keyPool 当前配置（admin PUT 即生效），stale 报告不参与限制
function applyLimits(keyId, report) {
  if (!pool || report.stale) return;   // stale 不启用额度限制，避免误伤
  const now = Date.now();
  const live = typeof pool.getPoolCfg === "function" ? pool.getPoolCfg() : cfg;
  const five = report.fiveHour;
  const weekly = report.weekly;
  const usd = report.creditsUsd;
  const fiveHot = five && five.percent >= (live.fiveHourHardStop ?? 90) && toMs(five.resetAt) > now;
  const weeklyHot = weekly && weekly.percent >= (live.weeklyHardStop ?? 90) && toMs(weekly.resetAt) > now;
  const usdExhausted = usd && usd.remaining <= 0;
  if (fiveHot) {
    pool.setQuotaLimited(keyId, toMs(five.resetAt), "fiveHour");
  } else if (weeklyHot) {
    pool.setQuotaLimited(keyId, toMs(weekly.resetAt), "weekly");
  } else if (usdExhausted) {
    // 美元耗尽：优先订阅周期结束；缺失/已过期时退到最近的窗口 resetAt；
    // 再不行限制一个探测周期（下个周期重新评估），绝不因字段缺失而直接放行（P3-3）
    let until = toMs(usd.expiresAt);
    if (until <= now) until = Math.max(toMs(weekly && weekly.resetAt), toMs(five && five.resetAt));
    if (until <= now) until = now + Math.max(60000, live.quotaRefreshMs || 60000);
    pool.setQuotaLimited(keyId, until, "credits");
  } else {
    pool.clearQuotaLimited(keyId);
  }
  // 软限制档（DESIGN §5.2B）：任一窗口 ≥softStop 或美元耗尽但未触硬停 → 保留可用、排到最后
  const soft = live.softStop ?? 80;
  const softHit = (five && five.percent >= soft) || (weekly && weekly.percent >= soft) || usdExhausted;
  pool.setSoftLimited(keyId, !!softHit);
}

export async function refreshKey(keyId, options = {}) {
  return probeKey(keyId, options);
}

export async function refreshAll() {
  if (sweeping) return sweeping; // 上一轮还没跑完（Key 多/网络慢）时跳过本次，避免探测排队叠加
  const recs = pool.listKeys().filter((k) => k.enabled);
  if (!recs.length) return;
  const done = (async () => {
    // 间隔实时读池配置（admin PUT 即生效，stale 快照仅兜底）
    const live = typeof pool.getPoolCfg === "function" ? pool.getPoolCfg() : cfg;
    const gap = Math.max(0, live.quotaRefreshGapMs ?? 2000);
    for (const r of recs) {
      try { await probeKey(r.id); } catch {}
      if (gap > 0) await sleep(gap);
    }
  })();
  sweeping = done.then(() => { sweeping = null; }, () => { sweeping = null; });
  return sweeping;
}

export function getReport(keyId) {
  return cache.get(keyId) || null;
}

export function testKey(keyId) {
  return enqueue(async () => { // 与其他探测串行，避免并发打 whoami 触发风控
    const rec = pool.getKeyRecord(keyId);
    if (!rec) throw new Error("Key 不存在");
    emitStatus(keyId, "testing");
    try {
      const r = await fetchJson(API_BASE + PATH_WHOAMI, rec.key);
      // fetchJson 已识别 HTTP 4xx 与 200+success:false 两种失败形态
      return { ok: !r.err, status: r.err ? (r.status || 0) : 200 };
    } catch {
      return { ok: false, status: 0 };
    } finally {
      emitStatus(keyId, "idle");
    }
  });
}
