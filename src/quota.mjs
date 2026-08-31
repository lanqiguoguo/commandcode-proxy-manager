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
}

function startTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => { refreshAll(); }, cfg.quotaRefreshMs || 60000);
  if (timer.unref) timer.unref();
}

async function fetchJson(url, key) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", Authorization: "Bearer " + key },
    redirect: "error",
    signal: AbortSignal.timeout(PROBE_TIMEOUT)
  });
  if (!res.ok) return null;
  return res.json();
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
  const report = { fiveHour: null, weekly: null, creditsUsd: null, updatedAt: Date.now(), stale: true };
  try {
    const whoami = await fetchJson(API_BASE + PATH_WHOAMI, rec.key);
    const w = (whoami && (whoami.data || whoami)) || {};
    const orgId = w.org && typeof w.org.id === "string" && w.org.id ? w.org.id : null;
    const orgQuery = orgId ? "?orgId=" + encodeURIComponent(orgId) : "";

    const credits = await fetchJson(API_BASE + PATH_CREDITS + orgQuery, rec.key);
    if (!credits) return report;
    const body = credits.data || credits;
    const creditsObj = body.credits || null;
    const limits = body.windowLimits || null;
    if (!creditsObj && !limits) return report;

    if (limits) {
      report.fiveHour = parseWindow(limits.fiveHour);
      report.weekly = parseWindow(limits.weekly);
    }

    // 订阅周期内美元额度（软失败，无周期起点时不展示）
    const subs = await fetchJson(API_BASE + PATH_SUBSCRIPTIONS + orgQuery, rec.key);
    const sub = subs ? (subs.data || subs) : null;
    const periodStart = sub && typeof sub.currentPeriodStart === "string" ? sub.currentPeriodStart : "";
    if (periodStart && creditsObj) {
      const usage = await fetchJson(API_BASE + PATH_USAGE + orgQuery + "&since=" + encodeURIComponent(periodStart), rec.key);
      const u = usage ? (usage.data || usage) : null;
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
    report.stale = false;
  } catch (e) {
    // 探测失败：保留上次成功值并标记 stale
  }
  cache.set(keyId, report);
  persistCache();
  applyLimits(keyId, report);
  if (emitter) emitter.emit("quota", { keyId, report });
  return report;
}

// 决策 2：额度感知限制——5h/每周硬阈值、美元耗尽 → quota_limited
function applyLimits(keyId, report) {
  if (!pool || report.stale) return;   // stale 不启用额度限制，避免误伤
  const five = report.fiveHour;
  const weekly = report.weekly;
  const usd = report.creditsUsd;
  if (five && five.percent >= (cfg.fiveHourHardStop ?? 90) && toMs(five.resetAt) > Date.now()) {
    pool.setQuotaLimited(keyId, toMs(five.resetAt), "fiveHour");
    return;
  }
  if (weekly && weekly.percent >= (cfg.weeklyHardStop ?? 90) && toMs(weekly.resetAt) > Date.now()) {
    pool.setQuotaLimited(keyId, toMs(weekly.resetAt), "weekly");
    return;
  }
  if (usd && usd.remaining <= 0) {
    pool.setQuotaLimited(keyId, toMs(usd.expiresAt), "credits");
    return;
  }
  pool.clearQuotaLimited(keyId);
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
    const res = await fetch(API_BASE + PATH_WHOAMI, {
      headers: { Accept: "application/json", Authorization: "Bearer " + rec.key },
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT)
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}
