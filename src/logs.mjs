// 系统日志持久化：events.jsonl 追加 + 启动回放 + 按保留天数清理
// 磁盘日志与内存环都受限，容器重启仍可回放保留期内的日志。
import fs from "fs";
import { resolve } from "path";
import { DATA_DIR } from "./config.mjs";

const FILE = "events.jsonl";
export const MEM_CAP = 5000;
export const MAX_DISK_LINES = MEM_CAP; // physical rows never exceed the memory contract
export const MAX_DISK_BYTES = 16 * 1024 * 1024; // bounds unusually large log payloads
export const MIN_FREE_BYTES = 16 * 1024 * 1024; // reserve space for the temp-file rename
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_COMPACT_RETRIES = 3;
const COMPACT_DELAY_MS = envMs("CCPM_COMPACT_DELAY_MS", 5000, 0, 10 * 60 * 1000);
const COMPACT_RETRY_DELAY_MS = envMs("CCPM_COMPACT_RETRY_DELAY_MS", 30000, 1, 10 * 60 * 1000);

let lines = [];           // 升序
let retentionDays = 7;
let pruneTimer = null;
let bus = null;           // 事件总线（initLogs 注入）
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

function clampDays(d) {
  const n = Number(d);
  if (!Number.isFinite(n)) return 7;
  return Math.max(1, Math.min(31, Math.round(n)));
}

function cutoffMs() { return Date.now() - retentionDays * 864e5; }

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidLog(value) {
  return isRecord(value) && typeof value.ts === "number" && Number.isFinite(value.ts) &&
    typeof value.msg === "string" && (value.level === undefined || typeof value.level === "string") &&
    (value.src === undefined || typeof value.src === "string");
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
  console.error(`[logs] ${message}${error ? `: ${errorText(error)}` : ""}`);
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
  // Node 20 supports statfsSync. The line/byte caps remain a bounded fallback
  // on filesystems where free-space statistics are unavailable.
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
  for (const entry of source) {
    let line;
    try {
      line = JSON.stringify(entry) + "\n";
    } catch {
      dropped++;
      continue;
    }
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > MAX_RECORD_BYTES) {
      dropped++;
      continue;
    }
    rows.push({ entry, line, bytes });
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
  if (dropped > 0) warn(`compact discarded ${dropped} oversized or over-cap log row(s)`);
  return {
    entries: selected.map((row) => row.entry),
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
  const packed = buildCompactBody(lines);
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
    lines = packed.entries;
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
    needsCompact = lines.length > 0;
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
  let dirty = !physicalCanonical;
  const seen = new Set(lines.map((entry) => entry.ts + "|" + (entry.src || "manager") + "|" + entry.msg));
  const rawLines = body.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    if (!raw.trim()) {
      if (i < rawLines.length - 1) dirty = true;
      continue;
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
      dirty = true;
      continue;
    }
    try {
      const entry = JSON.parse(raw);
      if (!isValidLog(entry)) {
        dirty = true;
        continue;
      }
      if (entry.ts < cutoff) {
        dirty = true;
        continue;
      }
      const key = entry.ts + "|" + (entry.src || "manager") + "|" + entry.msg;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(entry);
    } catch {
      dirty = true;
    }
  }
  if (lines.length > MEM_CAP) {
    lines = lines.slice(-MEM_CAP);
    dirty = true;
  }
  if (overPhysicalLimit()) dirty = true;
  needsCompact = dirty;
}

// 两阶段启动：attachConsoleCapture() 必须在托管上游子进程启动之前调用，
// 否则上游启动日志发生在捕获挂钩之前会丢失；initLogs 再回放磁盘历史并接上总线。
export function initLogs(emitter, retentionDaysArg = 7) {
  if (pruneTimer) clearInterval(pruneTimer);
  if (compactTimer) clearTimeout(compactTimer);
  pruneTimer = null;
  compactTimer = null;
  compactFailures = 0;
  compactExhaustedWarned = false;
  diskWarning = "";
  bus = emitter;
  retentionDays = clampDays(retentionDaysArg);
  physicalKnown = false;
  physicalCanonical = true;
  needsCompact = false;
  load();
  // Startup cleanup is synchronous so malformed/expired disk rows are removed
  // before the first log query can observe a merely in-memory cleanup.
  prune();
  attachConsoleCapture();
  pruneTimer = setInterval(() => prune(), 6 * 3600e3);
  if (pruneTimer.unref) pruneTimer.unref();
  emitter.on("log", (entry) => {
    // ts 单一来源：本订阅先于 adminApi 的 SSE onLog 注册，若 entry 无 ts 在此补一次。
    if (entry.ts === undefined) entry.ts = Date.now();
    append({ ts: entry.ts, level: entry.level || "info", msg: String(entry.msg || ""), src: entry.src || "manager" });
  });
}

// 上游日志捕获：拦截后原样透传 stdout，docker logs 不受影响。
const PROXY_LINE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s+\[(info|warn|error)\]\s+([\s\S]*)$/;
let consoleCaptureOn = false;
export function attachConsoleCapture() {
  if (consoleCaptureOn) return;
  consoleCaptureOn = true;
  for (const meth of ["log", "error", "warn", "info"]) {
    const orig = console[meth].bind(console);
    console[meth] = (...args) => {
      orig(...args);
      try {
        const first = args[0];
        if (typeof first !== "string" || first.length > 2000) return;
        const m = PROXY_LINE.exec(first);
        if (!m) return;
        let msg = m[3];
        for (let i = 1; i < args.length; i++) {
          const a = args[i];
          msg += " " + (typeof a === "string" ? a : safeJson(a));
        }
        if (msg.startsWith("Aborted request cleaned up")) {
          const now = Date.now();
          if (now - lastAbortTs < 30000) return;
          lastAbortTs = now;
        }
        msg = redact(msg);
        const entry = { ts: Date.parse(m[1]) || Date.now(), level: m[2], msg, src: "proxy" };
        if (bus) bus.emit("log", entry);
        else append(entry);
      } catch {}
    };
  }
}
let lastAbortTs = 0;

// 上游 vendored 零改动，捕获侧脱敏：keyPrefix 打印了池内 Key 前 8 字符。
function redact(msg) {
  if (msg.indexOf("keyPrefix") < 0) return msg;
  return msg.replace(/("keyPrefix":")user_[A-Za-z0-9_-]+(")/g, "$1user_***$2");
}
function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function setRetention(days) {
  retentionDays = clampDays(days);
  prune();
}

function append(e) {
  lines.push(e);
  if (lines.length > MEM_CAP) {
    lines = lines.slice(-MEM_CAP);
    needsCompact = true;
    warnGuard("MEM_CAP");
  }
  let line = null;
  try { line = JSON.stringify(e) + "\n"; } catch (err) { warn("log serialization failed", err); }
  const lineBytes = line ? Buffer.byteLength(line, "utf8") : MAX_RECORD_BYTES + 1;
  if (!physicalKnown) refreshPhysicalState();
  const blocked = !line || lineBytes > MAX_RECORD_BYTES || !physicalKnown || needsCompact || !physicalCanonical ||
    overPhysicalLimit(1, lineBytes) || !hasHeadroom(lineBytes);
  if (blocked) {
    if (!needsCompact) warnGuard(lineBytes > MAX_RECORD_BYTES ? "record-bytes" : "disk-space-or-size");
    needsCompact = true;
    scheduleCompact();
    return;
  }
  const p = filePath();
  try {
    if (!tightenFile(p)) throw new Error("cannot chmod existing file to 0600");
    fs.appendFileSync(p, line, { mode: 0o600 });
    if (!tightenFile(p)) throw new Error("cannot verify file mode 0600");
    physicalLines++;
    physicalBytes += lineBytes;
    physicalCanonical = true;
  } catch (err) {
    needsCompact = true;
    warn("append failed; compact scheduled", err);
    scheduleCompact();
  }
}

export function prune() {
  const cutoff = cutoffMs();
  const before = lines.length;
  lines = lines.filter((entry) => entry.ts >= cutoff);
  if (lines.length > MEM_CAP) lines = lines.slice(-MEM_CAP);
  if (lines.length !== before) needsCompact = true;
  if (physicalKnown && overPhysicalLimit()) needsCompact = true;
  if (!needsCompact) return;
  // A maintenance pass starts a fresh bounded retry budget after one exhausted
  // three-attempt episode; continuous append never creates an unbounded retry loop.
  if (compactFailures >= MAX_COMPACT_RETRIES) {
    compactFailures = 0;
    compactExhaustedWarned = false;
  }
  compactNow();
}

export function getLogs({ since = 0, limit = 2000, src = "" } = {}) {
  let out = since > 0 ? lines.filter((l) => l.ts > since) : lines.slice();
  if (src) out = out.filter((l) => (l.src || "manager") === src);
  const cap = Math.max(1, Math.min(5000, Number(limit) || 2000));
  if (out.length > cap) out = out.slice(-cap);
  return out;
}
