// ── 官方额度探测（whoami / billing / usage，软失败 + TTL 缓存） ──
import { readJson, debouncedWriter } from "./state.mjs";

const API_BASE = "https://api.commandcode.ai";
const PATH_WHOAMI = "/alpha/whoami";
const PATH_CREDITS = "/alpha/billing/credits";
const PATH_SUBSCRIPTIONS = "/alpha/billing/subscriptions";
const PATH_USAGE = "/alpha/usage/summary";
const PROBE_TIMEOUT = 8000;

let cache = new Map();
let pool = null;
let cfg = { quotaRefreshMs: 60000, fiveHourHardStop: 90, weeklyHardStop: 90, softStop: 80 };
let persistCache = null;
let timer = null;
let emitter = null;

export function initQuota(poolRef, poolCfg, opts = {}) {
  pool = poolRef;
  cfg = { ...cfg, ...poolCfg };
  emitter = opts.emitter || null;
  const saved = readJson("quota-cache.json", null);
  if (saved && saved.reports) {
    for (const [id, r] of Object.entries(saved.reports)) cache.set(id, r);
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
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", Authorization: "Bearer " + key },
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT)
    });
  } catch (e) {
    return { err: "network: " + (e.cause?.code || e.message), status: 0 };
  }
  if (!res.ok) {
    let code = "";
    try { const j = await res.json(); code = (j.error && (j.error.code || j.error.message)) || ""; } catch {}
    return { err: "HTTP " + res.status + (code ? " " + code : ""), status: res.status };
  }
  let j;
  try { j = await res.json(); } catch { return { err: "bad JSON", status: res.status }; }
  if (j && j.success === false && j.error) {
    // HTTP 200 但业务层报错：按失败处理（真实额度数据不会带 success:false 封装）
    return { err: "api " + (j.error.code || j.error.status || "error"), status: j.error.status || res.status };
  }
  return { data: j };
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function parseWindow(w) {
  if (!w || typeof w !== "object") return null;
  const cap = num(w.cap);
  const used = num(w.used);
  if (cap === undefined || used === undefined || cap <= 0 || used < 0) return null;
  return {
    cap,
    used,
    percent: Math.round((used / cap) * 1000) / 10,
    resetAt: typeof w.resetAt === "string" ? w.resetAt : null
  };
}

function toMs(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}

export async function probeKey(keyId) {
  const rec = pool.getKeyRecord(keyId);
  if (!rec || !rec.key) return null;
  const prev = cache.get(keyId) || null;
  const report = { fiveHour: null, weekly: null, creditsUsd: null, updatedAt: Date.now(), stale: true };
  let ok = false;
  let probeErr = "";
  try {
    const whoamiR = await fetchJson(API_BASE + PATH_WHOAMI, rec.key);
    if (whoamiR.err) probeErr = "whoami: " + whoamiR.err;
    const w = (whoamiR.data && (whoamiR.data.data || whoamiR.data)) || {};
    const orgId = w.org && typeof w.org.id === "string" && w.org.id ? w.org.id : null;
    const orgQuery = orgId ? "?orgId=" + encodeURIComponent(orgId) : "";

    const creditsR = await fetchJson(API_BASE + PATH_CREDITS + orgQuery, rec.key);
    if (creditsR.err) probeErr = "credits: " + creditsR.err;
    const body = creditsR.data ? (creditsR.data.data || creditsR.data) : null;
    const creditsObj = body ? (body.credits || null) : null;
    const limits = body ? (body.windowLimits || null) : null;
    if (creditsObj || limits) {
      if (limits) {
        report.fiveHour = parseWindow(limits.fiveHour);
        report.weekly = parseWindow(limits.weekly);
      }

      // 订阅周期内美元额度（软失败，无周期起点时不展示）
      const subsR = await fetchJson(API_BASE + PATH_SUBSCRIPTIONS + orgQuery, rec.key);
      const sub = subsR.data ? (subsR.data.data || subsR.data) : null;
      const periodStart = sub && typeof sub.currentPeriodStart === "string" ? sub.currentPeriodStart : "";
      if (periodStart && creditsObj) {
        const usageR = await fetchJson(API_BASE + PATH_USAGE + orgQuery + "&since=" + encodeURIComponent(periodStart), rec.key);
        const u = usageR.data ? (usageR.data.data || usageR.data) : null;
        const used = u && u.totalCost !== undefined ? num(u.totalCost) : num(u && u.totalMonthlyCredits);
        const pools = ["monthlyCredits", "purchasedCredits", "freeCredits"]
          .map((k) => num(creditsObj[k]))
          .filter((v) => v !== undefined)
          .map((v) => Math.max(0, v));
        if (used !== undefined && pools.length > 0) {
          const remaining = pools.reduce((s, v) => s + v, 0);
          const limit = used + remaining;
          report.creditsUsd = {
            used,
            remaining,
            limit,
            percent: limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0,
            expiresAt: sub.currentPeriodEnd || undefined
          };
        }
      }
      ok = true;
      probeErr = "";
    } else if (!probeErr) {
      probeErr = "credits: no quota fields in response";
    }
  } catch (e) {
    probeErr = probeErr || ("exception: " + e.message);
    // 探测失败：走下方统一失败路径
  }
  // 决策 3：失败时保留上次成功值并标记 stale，绝不丢数据
  // updatedAt：保留上次成功时间戳；从未成功过时为 null（前端显示"获取失败"而非"过期"）
  const final = ok ? { ...report, stale: false } : {
    fiveHour: prev && prev.fiveHour ? prev.fiveHour : null,
    weekly: prev && prev.weekly ? prev.weekly : null,
    creditsUsd: prev && prev.creditsUsd ? prev.creditsUsd : null,
    updatedAt: prev && prev.updatedAt ? prev.updatedAt : null,
    error: probeErr || "probe failed",
    stale: true
  };
  cache.set(keyId, final);
  persistCache();
  applyLimits(keyId, final);
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

export async function refreshKey(keyId) {
  return probeKey(keyId);
}

export async function refreshAll() {
  const recs = pool.listKeys().filter((k) => k.enabled);
  await Promise.allSettled(recs.map((r) => probeKey(r.id)));
}

export function getReport(keyId) {
  return cache.get(keyId) || null;
}

export async function testKey(keyId) {
  const rec = pool.getKeyRecord(keyId);
  if (!rec) throw new Error("Key 不存在");
  try {
    const r = await fetchJson(API_BASE + PATH_WHOAMI, rec.key);
    // fetchJson 已识别 HTTP 4xx 与 200+success:false 两种失败形态
    return { ok: !r.err, status: r.err ? (r.status || 0) : 200 };
  } catch {
    return { ok: false, status: 0 };
  }
}
