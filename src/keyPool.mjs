// ── Key 池：主备顺序、健康状态、429/额度退避（持久化到 /data） ──
import { randomUUID } from "crypto";
import { readJson, writeJson, debouncedWriter } from "./state.mjs";

let keys = [];        // 数组顺序即主备优先级（index 0 = 主 Key）
let health = new Map();
let poolCfg = {};
let persistState = null;
let usageProvider = null;   // (keyId) => 近 5h token 数（least-usage 策略用）
let roundRobinIndex = 0; // 内存态，重启重置；仅 round-robin 策略使用
let emitter = null;

export function initKeyPool(cfgPool, opts = {}) {
  poolCfg = { ...cfgPool };
  emitter = opts.emitter || null;
  const data = readJson("keys.json", null) || { keys: [] };
  keys = Array.isArray(data.keys) ? data.keys : [];
  keys.forEach((k) => {
    if (!k.id) k.id = "k_" + randomUUID().replace(/-/g, "").slice(0, 14);
    if (typeof k.priority !== "number") k.priority = 0;
    if (typeof k.enabled !== "boolean") k.enabled = true;
  });
  keys.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const saved = readJson("state.json", null) || { keys: {} };
  keys.forEach((k) => {
    const h = saved.keys[k.id] || {};
    health.set(k.id, {
      backoffUntilMs: Number(h.backoffUntilMs) || 0,
      failCount: Number(h.failCount) || 0,
      authError: !!h.authError,
      quotaLimitedUntil: Number(h.quotaLimitedUntil) || 0,
      quotaLimitedReason: h.quotaLimitedReason || "",
      softLimited: !!h.softLimited,
      failoverCount: Number(h.failoverCount) || 0,
      lastFailoverAt: Number(h.lastFailoverAt) || 0,
      lastUsedAt: Number(h.lastUsedAt) || 0
    });
  });
  persistState = debouncedWriter("state.json", () => ({
    keys: Object.fromEntries([...health.entries()].map(([id, h]) => [id, { ...h }]))
  }));
}

function emitLog(msg) {
  if (emitter) emitter.emit("log", { level: "info", msg });
}

function persistKeys() { writeJson("keys.json", { keys }); }

export function getPoolCfg() { return { ...poolCfg }; }
export function setPoolCfg(c) { poolCfg = { ...poolCfg, ...c }; }
export function setUsageProvider(fn) { usageProvider = fn; }

export function listKeys() { return keys.map((k) => ({ ...k })); }
export function getKeyRecord(id) { return keys.find((k) => k.id === id); }
export function getHealth(id) {
  const h = health.get(id);
  return h ? { ...h } : null;
}

export function addKey({ alias = "", key = "", note = "" }) {
  if (!/^user_[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error("Key 必须以 user_ 开头，且只含字母数字_-");
  }
  if (keys.some((k) => k.key === key)) throw new Error("Key 已存在");
  const rec = {
    id: "k_" + randomUUID().replace(/-/g, "").slice(0, 14),
    alias: (alias || key.slice(0, 10)).slice(0, 64),
    key,
    note: String(note || "").slice(0, 256),
    enabled: true,
    createdAt: Date.now(),
    priority: keys.length
  };
  keys.push(rec);
  persistKeys();
  health.set(rec.id, {
    backoffUntilMs: 0, failCount: 0, authError: false,
    quotaLimitedUntil: 0, quotaLimitedReason: "", softLimited: false,
    failoverCount: 0, lastFailoverAt: 0, lastUsedAt: 0
  });
  emitLog("新增 Key: " + maskKey(rec.key));
  return rec;
}

export function updateKey(id, patch) {
  const rec = keys.find((k) => k.id === id);
  if (!rec) throw new Error("Key 不存在");
  if (patch.alias !== undefined) rec.alias = String(patch.alias).slice(0, 64);
  if (patch.note !== undefined) rec.note = String(patch.note).slice(0, 256);
  if (patch.enabled !== undefined) rec.enabled = !!patch.enabled;
  if (patch.priority !== undefined) moveKey(id, Number(patch.priority));
  persistKeys();
  return rec;
}

export function moveKey(id, targetIndex) {
  const i = keys.findIndex((k) => k.id === id);
  if (i < 0) throw new Error("Key 不存在");
  targetIndex = Math.max(0, Math.min(keys.length - 1, targetIndex));
  const [rec] = keys.splice(i, 1);
  keys.splice(targetIndex, 0, rec);
  keys.forEach((k, idx) => { k.priority = idx; });
  persistKeys();
  emitLog("调整主备顺序: " + (rec.alias || maskKey(rec.key)) + " -> 第 " + (targetIndex + 1) + " 位");
}

export function removeKey(id) {
  const i = keys.findIndex((k) => k.id === id);
  if (i < 0) throw new Error("Key 不存在");
  const [rec] = keys.splice(i, 1);
  keys.forEach((k, idx) => { k.priority = idx; });
  health.delete(id);
  persistKeys();
  if (persistState) persistState();
  emitLog("删除 Key: " + maskKey(rec.key));
}

// ── 健康状态（退避状态机，决策 5/6/8） ──────────
function nowMs() { return Date.now(); }

export function recordRateLimit(id, retryAfterMs) {
  const h = health.get(id);
  if (!h) return;
  h.failCount = (h.failCount || 0) + 1;
  const base = poolCfg.backoffBaseMs || 5000;
  const cap = poolCfg.backoffMaxMs || 120000;
  const exp = Math.min(cap, base * Math.pow(2, h.failCount - 1));
  // retryAfterMs 仅对 >0 的真实等待封顶（0/null 表示"立即重试"，走指数分支）；
  // 上游异常大值（如 Retry-After: 604800）不排除 Key 数天~数年（H2）
  const wait = retryAfterMs && retryAfterMs > 0 ? Math.min(cap, retryAfterMs) : exp;
  h.backoffUntilMs = nowMs() + wait;
  persistState();
  emitLog("Key " + id + " 限流退避 " + Math.round((h.backoffUntilMs - nowMs()) / 1000) + "s（第 " + h.failCount + " 次）");
}

export function recordTimeout(id) {
  const h = health.get(id);
  if (!h) return;
  h.failCount = (h.failCount || 0) + 1;
  const base = poolCfg.backoffBaseMs || 5000;
  h.backoffUntilMs = nowMs() + Math.min(poolCfg.backoffMaxMs || 120000, base * Math.pow(2, h.failCount - 1));
  persistState();
  emitLog("Key " + id + " 超时退避 " + Math.round((h.backoffUntilMs - nowMs()) / 1000) + "s");
}

export function recordSuccess(id) {
  const h = health.get(id);
  if (!h) return;
  h.failCount = 0;
  h.backoffUntilMs = 0;
  persistState();
}

export function markAuthError(id) {
  const h = health.get(id);
  if (!h) return;
  h.authError = true;
  h.backoffUntilMs = nowMs() + 3600 * 1000;
  persistState();
  emitLog("Key " + id + " 认证失败（401/403），已标记异常并停止自动使用");
}

export function clearAuthError(id) {
  const h = health.get(id);
  if (!h) return;
  h.authError = false;
  h.backoffUntilMs = 0;
  persistState();
  emitLog("Key " + id + " 认证异常已清除");
}

// 管理端手动清除 429/超时退避（H2）：只清 backoffUntilMs 与 failCount，
// 不动 authError/quotaLimited 等其他状态（401 标记与额度限制是另一类状态，不应被误清）。
// 与 clearAuthError 不同：id 不存在时抛错（同 updateKey 风格），由 adminApi 统一转 400
export function clearBackoff(id) {
  const h = health.get(id);
  if (!h) throw new Error("Key 不存在");
  h.backoffUntilMs = 0;
  h.failCount = 0;
  persistState();
  emitLog("Key " + id + " 退避已手动清除");
}

export function setQuotaLimited(id, untilMs, reason) {
  const h = health.get(id);
  if (!h) return;
  const now = nowMs();
  const wasLimited = now < h.quotaLimitedUntil;
  const prevReason = h.quotaLimitedReason;
  h.quotaLimitedUntil = untilMs || 0;
  h.quotaLimitedReason = reason || "";
  persistState();
  const isLimited = now < h.quotaLimitedUntil;
  // 探测每周期都会重设限制（credits 自延长场景），仅在状态翻转/原因变化时记日志防刷屏
  if (isLimited && (!wasLimited || prevReason !== reason)) emitLog("Key " + id + " 额度受限（" + reason + "），暂停使用至窗口重置");
  else if (!isLimited && wasLimited) emitLog("Key " + id + " 额度限制解除");
}

// 软限制（决策 2 / DESIGN §5.2B）：额度 ≥softStop 时该 Key 保留可用，但优先级降到
// 所有非软限制 Key 之后；池内无健康 Key 可用时仍会兜底使用。仅在状态翻转时记日志（探测高频）。
export function setSoftLimited(id, val) {
  const h = health.get(id);
  if (!h) return;
  const next = !!val;
  if (h.softLimited === next) return;
  h.softLimited = next;
  persistState();
  emitLog("Key " + id + (next ? " 额度将尽（软限制），降级为后备" : " 软限制解除"));
}

export function clearQuotaLimited(id) { setQuotaLimited(id, 0, ""); }

export function recordFailover(id) {
  const h = health.get(id);
  if (!h) return;
  h.failoverCount = (h.failoverCount || 0) + 1;
  h.lastFailoverAt = nowMs();
  persistState();
  emitLog("Key " + id + " 发生主备切换（累计 " + h.failoverCount + " 次）");
}

// ── 选 Key（决策 5：主备模式，任一时刻单一活跃 Key） ──
function inBackoff(id) {
  const h = health.get(id);
  return h ? nowMs() < h.backoffUntilMs : false;
}
function quotaLimited(id) {
  const h = health.get(id);
  return h ? nowMs() < h.quotaLimitedUntil : false;
}

export function selectKey(excludeIds = null) {
  const cooldownMs = poolCfg.failoverCooldownMs ?? 600000;
  const now = nowMs();
  const avail = keys.filter((k) => {
    if (!k.enabled) return false;
    if (excludeIds && excludeIds.has(k.id)) return false;
    if (inBackoff(k.id)) return false;
    if (quotaLimited(k.id)) return false;
    const h = health.get(k.id);
    if (h && h.authError) return false;
    // failoverCooldown：刚发生过切换的 key 在冷却期内降低优先级（仅 active-standby 场景有效）
    // 实现为：冷却期内该 key 仍可用，但当存在非冷却可用 key 时会被排后
    return true;
  });
  if (!avail.length) return null;
  let chosen = null;
  if (poolCfg.strategy === "round-robin") {
    chosen = avail[roundRobinIndex % avail.length];
    roundRobinIndex++;
  } else if (poolCfg.strategy === "least-usage" && typeof usageProvider === "function") {
    chosen = [...avail].sort((a, b) => (usageProvider(a.id) ?? 0) - (usageProvider(b.id) ?? 0))[0];
  } else {
    // active-standby：软限制（额度≥softStop）Key 降到最后，仅在无正常 Key 时兜底
    let candidates = avail;
    const notSoft = avail.filter((k) => !(health.get(k.id) || {}).softLimited);
    if (notSoft.length) candidates = notSoft;
    // 冷却期内非主 key 优先选择未冷却的
    if (cooldownMs > 0) {
      const outsideCooldown = candidates.filter((k) => {
        const h = health.get(k.id);
        return !h || !h.lastFailoverAt || (now - h.lastFailoverAt) >= cooldownMs;
      });
      if (outsideCooldown.length) {
        // 保持主备顺序，选冷却期外优先级最高的
        chosen = outsideCooldown[0];
      } else {
        chosen = candidates[0];
      }
    } else {
      chosen = candidates[0];
    }
  }
  const h = health.get(chosen.id);
  if (h) h.lastUsedAt = now;
  return { id: chosen.id, key: chosen.key, alias: chosen.alias };
}

export function nextRetryAfterMs() {
  let min = null;
  for (const k of keys) {
    if (k.enabled) {
      const h = health.get(k.id);
      if (h) {
        const until = Math.max(h.backoffUntilMs, h.quotaLimitedUntil);
        if (until > nowMs()) min = min === null ? until : Math.min(min, until);
      }
    }
  }
  return min ? min - nowMs() : 0;
}

export function getPoolStats() {
  const counts = { total: keys.length, enabled: 0, backingOff: 0, quotaLimited: 0, authError: 0 };
  for (const k of keys) {
    if (!k.enabled) continue;
    counts.enabled++;
    const h = health.get(k.id);
    if (!h) continue;
    if (nowMs() < h.backoffUntilMs) counts.backingOff++;
    if (nowMs() < h.quotaLimitedUntil) counts.quotaLimited++;
    if (h.authError) counts.authError++;
  }
  return counts;
}

export function maskKey(key) {
  if (!key) return "";
  if (key.length <= 10) return key.slice(0, 3) + "***";
  return key.slice(0, 6) + "***" + key.slice(-4);
}
