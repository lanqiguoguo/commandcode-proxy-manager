// ── 用量统计与历史记录：stats.jsonl 追加日志 + 5h/周/月窗口（决策 6/7/9） ──
import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync } from "fs";
import { resolve } from "path";
import { DATA_DIR } from "./config.mjs";

const FILE = "stats.jsonl";
const MAX_EVENTS = 200000;   // 内存事件硬上限：超出即截断最旧事件（含保留期内），防无界增长
let retentionDays = 7;
let events = [];
let emitter = null;
let pruneTimer = null;

export function initStats(emitterRef, retentionDaysArg = 7) {
  emitter = emitterRef;
  retentionDays = clampDays(retentionDaysArg);
  load();
  prune();
  pruneTimer = setInterval(() => prune(), 6 * 3600 * 1000);
  if (pruneTimer.unref) pruneTimer.unref();
}

export function setRetention(days) {
  retentionDays = clampDays(days);
  prune();
}

function clampDays(d) {
  const n = Number(d);
  if (!Number.isFinite(n)) return 7;
  return Math.max(1, Math.min(31, Math.round(n)));
}

function cutoffMs() { return Date.now() - retentionDays * 864e5; }

function load() {
  const p = resolve(DATA_DIR, FILE);
  if (!existsSync(p)) return;
  const cutoff = cutoffMs();
  try {
    const lines = readFileSync(p, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.ts >= cutoff) events.push(ev);
      } catch {}
    }
  } catch (e) {
    console.error("[stats] load failed:", e.message);
  }
}

let compactTimer = null;
function scheduleCompact() {
  if (compactTimer) return;
  compactTimer = setTimeout(() => {
    compactTimer = null;
    prune();
  }, 5000);
  if (compactTimer.unref) compactTimer.unref();
}

// P1-6：数值字段入口净化——调用方（或经上游数据间接）可能带出字符串/对象/null，
// 落盘后无法回收且污染窗口聚合与前端渲染。有限数（含可无损转换的数字字符串）归一为
// number；其余（NaN/Infinity/null/undefined/布尔/对象/空串）删除字段——与既有
// “无 usage 数据 = 字段缺省”的语义一致（聚合侧 `|| 0`、渲染侧 `?? "-"` 均有兜底）。
// ok/status 判定语义不回退：status 为有限数时原样保留（429 等状态判定依赖它）。
function sanitizeNumeric(event, fields) {
  for (const f of fields) {
    const v = event[f];
    if (v === undefined) continue;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) delete event[f];
      continue;
    }
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (Number.isFinite(n)) event[f] = n;
    else delete event[f];
  }
}

export function appendEvent(ev) {
  const event = { ts: Date.now(), ...ev };
  sanitizeNumeric(event, ["inputTokens", "outputTokens", "cachedTokens", "latencyMs", "retries", "status"]);
  events.push(event);
  try {
    // mode 0o600：文件已存在时忽略，仅创建时生效（DESIGN §9.4 全部数据文件 600）
    appendFileSync(resolve(DATA_DIR, FILE), JSON.stringify(event) + "\n", { mode: 0o600 });
  } catch (e) {
    console.error("[stats] append failed:", e.message);
  }
  if (events.length > MAX_EVENTS) {
    events = events.slice(-MAX_EVENTS);
    scheduleCompact();
  }
  if (emitter) emitter.emit("stats", event);
}

export function prune() {
  const cutoff = cutoffMs();
  const before = events.length;
  events = events.filter((e) => e.ts >= cutoff);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  if (events.length === before) return;
  try {
    const p = resolve(DATA_DIR, FILE);
    const body = events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
    writeFileSync(p + ".tmp", body, { mode: 0o600 });
    renameSync(p + ".tmp", p);
  } catch (e) {
    console.error("[stats] prune failed:", e.message);
  }
}

export function queryEvents({ keyId, from, to, status, errorKind, page = 1, pageSize = 50 } = {}) {
  let list = events;
  if (keyId) list = list.filter((e) => e.keyId === keyId);
  if (from) list = list.filter((e) => e.ts >= Number(from));
  if (to) list = list.filter((e) => e.ts <= Number(to));
  if (status !== undefined && status !== "") list = list.filter((e) => String(e.status) === String(status));
  if (errorKind) list = list.filter((e) => e.errorKind === errorKind);
  list = [...list].sort((a, b) => b.ts - a.ts);
  const total = list.length;
  page = Math.max(1, Number(page) || 1);
  pageSize = Math.max(1, Math.min(500, Number(pageSize) || 50));
  const start = (page - 1) * pageSize;
  return { items: list.slice(start, start + pageSize), total, page, pageSize };
}

function windowCounts(keyId, msWindow) {
  const cutoff = Date.now() - msWindow;
  let requests = 0, success = 0, input = 0, output = 0, cached = 0, err429 = 0, errOther = 0;
  for (const e of events) {
    if (e.keyId !== keyId || e.ts < cutoff) continue;
    requests++;
    if (e.ok) success++;
    input += e.inputTokens || 0;
    output += e.outputTokens || 0;
    cached += e.cachedTokens || 0;
    if (!e.ok) {
      if (e.errorKind === "rate_limit" || e.status === 429) err429++;
      else errOther++;
    }
  }
  return { requests, success, input, output, cached, err429, errOther };
}

export function usageByKey(keyId) {
  const h5 = windowCounts(keyId, 5 * 3600e3);
  const d7 = windowCounts(keyId, 7 * 864e5);
  // 30 天窗口仅在保留天数 >= 30 时才有完整数据；
  // 否则退化为保留窗口（默认 7 天）并显式标记，前端不再误读为“30d 完整统计”
  const d30 = retentionDays >= 30 ? windowCounts(keyId, 30 * 864e5) : d7;
  return { h5, d7, d30, d30Valid: retentionDays >= 30 };
}

export function poolStats() {
  const agg = { requests: 0, success: 0, err429: 0, errOther: 0, input: 0, output: 0, cached: 0 };
  const cutoff = Date.now() - 7 * 864e5;
  for (const e of events) {
    if (e.ts < cutoff) continue;
    agg.requests++;
    if (e.ok) agg.success++;
    else if (e.errorKind === "rate_limit" || e.status === 429) agg.err429++;
    else agg.errOther++;
    agg.input += e.inputTokens || 0;
    agg.output += e.outputTokens || 0;
    agg.cached += e.cachedTokens || 0;
  }
  return agg;
}

export function usageProviderForPool() {
  return (keyId) => {
    const w = windowCounts(keyId, 5 * 3600e3);
    return w.input + w.output;
  };
}
