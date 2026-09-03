// 用量统计与历史记录：stats.jsonl 追加日志 + 5h/周/月窗口（决策 6/7/9）
import fs from "fs";
import { resolve } from "path";
import { DATA_DIR } from "./config.mjs";

const FILE = "stats.jsonl";
export const MAX_EVENTS = 200000;
export const MAX_DISK_LINES = MAX_EVENTS; // physical rows never exceed the memory contract
export const MAX_DISK_BYTES = 64 * 1024 * 1024; // bounds unusually large event payloads
export const MIN_FREE_BYTES = 16 * 1024 * 1024; // reserve space for the temp-file rename
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_COMPACT_RETRIES = 3;
const COMPACT_DELAY_MS = envMs("CCPM_COMPACT_DELAY_MS", 5000, 0, 10 * 60 * 1000);
const COMPACT_RETRY_DELAY_MS = envMs("CCPM_COMPACT_RETRY_DELAY_MS", 30000, 1, 10 * 60 * 1000);

let retentionDays = 7;
let events = [];
let emitter = null;
let pruneTimer = null;
let compactTimer = null;
let compactFailures = 0;
let compactExhaustedWarned = false;
let physicalLines = 0;
let physicalBytes = 0;
let physicalKnown = false;
let physicalCanonical = true;
let needsCompact = false;
let diskWarning = "";

function envMs(name, fallback, min, max) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

export function initStats(emitterRef, retentionDaysArg = 7) {
  if (pruneTimer) clearInterval(pruneTimer);
  if (compactTimer) clearTimeout(compactTimer);
  pruneTimer = null;
  compactTimer = null;
  compactFailures = 0;
  compactExhaustedWarned = false;
  diskWarning = "";
  events = [];
  physicalKnown = false;
  physicalCanonical = true;
  needsCompact = false;
  emitter = emitterRef;
  retentionDays = clampDays(retentionDaysArg);
  load();
  // Startup cleanup is synchronous: a dirty file must not remain dirty for the
  // lifetime of the process merely because the delayed append scheduler did not run.
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidEvent(value) {
  return isRecord(value) && typeof value.ts === "number" && Number.isFinite(value.ts);
}

function lineCount(body) {
  if (!body) return 0;
  let count = 0;
  for (const ch of body) if (ch === "\n") count++;
  return body.endsWith("\n") ? count : count + 1;
}

function setPhysicalState(body) {
  physicalLines = lineCount(body);
  physicalBytes = Buffer.byteLength(body, "utf8");
  physicalKnown = true;
  physicalCanonical = body.length === 0 || body.endsWith("\n");
}

function filePath() { return resolve(DATA_DIR, FILE); }
function tempPath() { return filePath() + ".tmp"; }

function errorText(error) {
  return error && error.message ? error.message : String(error || "unknown error");
}

function warn(message, error) {
  console.error(`[stats] ${message}${error ? `: ${errorText(error)}` : ""}`);
}

function tightenFile(path) {
  try {
    if (!fs.existsSync(path)) return true;
    fs.chmodSync(path, 0o600);
    return true;
  } catch (e) {
    warn(`chmod 0600 failed for ${FILE}`, e);
    return false;
  }
}

function refreshPhysicalState() {
  const p = filePath();
  try {
    if (!fs.existsSync(p)) {
      setPhysicalState("");
      return true;
    }
    const body = fs.readFileSync(p, "utf8");
    setPhysicalState(body);
    return true;
  } catch (e) {
    physicalKnown = false;
    warn("physical state read failed", e);
    return false;
  }
}

function availableBytes() {
  try {
    const stat = fs.statfsSync(DATA_DIR);
    const available = Number(stat.bavail) * Number(stat.bsize);
    return Number.isFinite(available) && available >= 0 ? available : null;
  } catch (e) {
    if (diskWarning !== "statfs") {
      diskWarning = "statfs";
      warn("disk free-space check unavailable; line/byte guards remain active", e);
    }
    return null;
  }
}

function hasHeadroom(requiredBytes) {
  const available = availableBytes();
  // Node 20 supports statfsSync. If a restricted filesystem does not, the
  // physical line/byte caps still provide a bounded fallback.
  return available === null || available >= MIN_FREE_BYTES + requiredBytes;
}

function overPhysicalLimit(extraLines = 0, extraBytes = 0) {
  return physicalLines + extraLines > MAX_DISK_LINES || physicalBytes + extraBytes > MAX_DISK_BYTES;
}

function warnGuard(reason) {
  if (diskWarning === reason) return;
  diskWarning = reason;
  warn(`persistence guard active (${reason}); compact scheduled`);
}

function clearTemp() {
  try {
    if (fs.existsSync(tempPath())) fs.unlinkSync(tempPath());
  } catch (e) {
    warn("compact temp cleanup failed", e);
  }
}

function scheduleCompact(delay = COMPACT_DELAY_MS) {
  if (compactTimer || compactFailures >= MAX_COMPACT_RETRIES) {
    if (compactFailures >= MAX_COMPACT_RETRIES && !compactExhaustedWarned) {
      compactExhaustedWarned = true;
      warn(`compact retries exhausted (${MAX_COMPACT_RETRIES}); retaining old file and dropping only new disk appends until the next maintenance pass`);
    }
    return;
  }
  compactTimer = setTimeout(() => {
    compactTimer = null;
    compactNow();
  }, delay);
  if (compactTimer.unref) compactTimer.unref();
}

function compactFailed(error) {
  needsCompact = true;
  compactFailures++;
  warn(`compact failed (attempt ${compactFailures}/${MAX_COMPACT_RETRIES}); old file retained`, error);
  clearTemp();
  if (compactFailures < MAX_COMPACT_RETRIES) scheduleCompact(COMPACT_RETRY_DELAY_MS);
}

function buildCompactBody(source) {
  const rows = [];
  let dropped = 0;
  for (const event of source) {
    let line;
    try {
      line = JSON.stringify(event) + "\n";
    } catch {
      dropped++;
      continue;
    }
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > MAX_RECORD_BYTES) {
      dropped++;
      continue;
    }
    rows.push({ event, line, bytes });
  }

  const selected = [];
  let bytes = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (selected.length >= MAX_DISK_LINES || bytes + row.bytes > MAX_DISK_BYTES) break;
    selected.push(row);
    bytes += row.bytes;
  }
  selected.reverse();
  if (selected.length !== rows.length) dropped += rows.length - selected.length;
  if (dropped > 0) warn(`compact discarded ${dropped} oversized or over-cap event(s)`);
  return {
    events: selected.map((row) => row.event),
    body: selected.map((row) => row.line).join(""),
    bytes
  };
}

function compactNow() {
  if (!needsCompact) return true;
  if (!physicalKnown && !refreshPhysicalState()) {
    compactFailed(new Error("cannot inspect existing file"));
    return false;
  }
  const packed = buildCompactBody(events);
  if (!hasHeadroom(packed.bytes)) {
    compactFailed(new Error(`free space below ${MIN_FREE_BYTES} bytes reserve`));
    return false;
  }
  const p = filePath();
  const tmp = tempPath();
  try {
    fs.writeFileSync(tmp, packed.body, { mode: 0o600, flag: "w" });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, p);
    events = packed.events;
    setPhysicalState(packed.body);
    needsCompact = false;
    compactFailures = 0;
    compactExhaustedWarned = false;
    diskWarning = "";
    return true;
  } catch (e) {
    compactFailed(e);
    return false;
  }
}

function load() {
  const p = filePath();
  if (!fs.existsSync(p)) {
    setPhysicalState("");
    return;
  }
  tightenFile(p);
  let body;
  try {
    body = fs.readFileSync(p, "utf8");
    setPhysicalState(body);
  } catch (e) {
    warn("load failed", e);
    return;
  }

  const cutoff = cutoffMs();
  const loaded = [];
  let dirty = !physicalCanonical;
  const rawLines = body.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line.trim()) {
      if (i < rawLines.length - 1) dirty = true;
      continue;
    }
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
      dirty = true;
      continue;
    }
    try {
      const event = JSON.parse(line);
      if (!isValidEvent(event)) {
        dirty = true;
        continue;
      }
      if (event.ts < cutoff) {
        dirty = true;
        continue;
      }
      if (sanitizeNumeric(event, ["inputTokens", "outputTokens", "cachedTokens", "latencyMs", "retries", "status"])) dirty = true;
      loaded.push(event);
    } catch {
      dirty = true;
    }
  }
  if (loaded.length > MAX_EVENTS) {
    loaded.splice(0, loaded.length - MAX_EVENTS);
    dirty = true;
  }
  events = loaded;
  if (overPhysicalLimit()) dirty = true;
  needsCompact = dirty;
}

// P1-6：数值字段入口净化——调用方（或经上游数据间接）可能带出字符串/对象/null，
// 落盘后无法回收且污染窗口聚合与前端渲染。有限数（含可无损转换的数字字符串）归一为
// number；其余（NaN/Infinity/null/undefined/布尔/对象/空串）删除字段——与既有
// “无 usage 数据 = 字段缺省”的语义一致（聚合侧 `|| 0`、渲染侧 `?? "-"` 均有兜底）。
// ok/status 判定语义不回退：status 为有限数时原样保留（429 等状态判定依赖它）。
function sanitizeNumeric(event, fields) {
  let changed = false;
  for (const f of fields) {
    const v = event[f];
    if (v === undefined) continue;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) {
        delete event[f];
        changed = true;
      }
      continue;
    }
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (Number.isFinite(n)) {
      event[f] = n;
      changed = true;
    } else {
      delete event[f];
      changed = true;
    }
  }
  return changed;
}

export function appendEvent(ev) {
  const event = { ts: Date.now(), ...ev };
  sanitizeNumeric(event, ["inputTokens", "outputTokens", "cachedTokens", "latencyMs", "retries", "status"]);
  events.push(event);
  if (events.length > MAX_EVENTS) {
    events = events.slice(-MAX_EVENTS);
    needsCompact = true;
    warnGuard("MAX_EVENTS");
  }

  let line = null;
  try { line = JSON.stringify(event) + "\n"; } catch (e) { warn("event serialization failed", e); }
  const lineBytes = line ? Buffer.byteLength(line, "utf8") : MAX_RECORD_BYTES + 1;
  if (!physicalKnown) refreshPhysicalState();
  const blocked = !line || lineBytes > MAX_RECORD_BYTES || !physicalKnown || needsCompact || !physicalCanonical ||
    overPhysicalLimit(1, lineBytes) || !hasHeadroom(lineBytes);
  if (blocked) {
    if (!needsCompact) warnGuard(lineBytes > MAX_RECORD_BYTES ? "record-bytes" : "disk-space-or-size");
    needsCompact = true;
    scheduleCompact();
  } else {
    const p = filePath();
    try {
      if (!tightenFile(p)) throw new Error("cannot chmod existing file to 0600");
      fs.appendFileSync(p, line, { mode: 0o600 });
      if (!tightenFile(p)) throw new Error("cannot verify file mode 0600");
      physicalLines++;
      physicalBytes += lineBytes;
      physicalCanonical = true;
    } catch (e) {
      needsCompact = true;
      warn("append failed; compact scheduled", e);
      scheduleCompact();
    }
  }
  if (emitter) emitter.emit("stats", event);
}

export function prune() {
  const cutoff = cutoffMs();
  const before = events.length;
  events = events.filter((e) => e.ts >= cutoff);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  if (events.length !== before) needsCompact = true;
  if (physicalKnown && overPhysicalLimit()) needsCompact = true;
  if (!needsCompact) return;
  // A manual/periodic maintenance pass starts a fresh bounded retry budget after
  // a previous three-attempt episode has been exhausted.
  if (compactFailures >= MAX_COMPACT_RETRIES) {
    compactFailures = 0;
    compactExhaustedWarned = false;
  }
  compactNow();
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
