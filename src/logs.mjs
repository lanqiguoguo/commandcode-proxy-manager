// ── 系统日志持久化：events.jsonl 追加 + 启动回放 + 按保留天数清理 ──
// 此前日志环只存内存（DESIGN §6 的 2000 条），容器重启即清空——用户视角
// "新增 Key / 额度受限 / 退避切换"等记录无故丢失。落盘语义与 stats.jsonl 一致。
import { existsSync, readFileSync, appendFileSync, writeFileSync, renameSync } from "fs";
import { resolve } from "path";
import { DATA_DIR } from "./config.mjs";

const FILE = "events.jsonl";
const MEM_CAP = 5000;     // 内存环上限（查询用）；磁盘按保留天数清理
let lines = [];           // 升序
let retentionDays = 7;
let pruneTimer = null;
let bus = null;           // 事件总线（initLogs 注入）

function clampDays(d) {
  const n = Number(d);
  if (!Number.isFinite(n)) return 7;
  return Math.max(1, Math.min(31, Math.round(n)));
}
function cutoffMs() { return Date.now() - retentionDays * 864e5; }

// 两阶段启动：attachConsoleCapture() 必须在上游 proxy.mjs import 之前调用，
// 否则上游启动日志（CC Proxy started / 配置错误等）发生在捕获挂钩之前会丢失
//（此时 bus 为 null，捕获行走直写 append 缓冲）；initLogs 再回放磁盘历史并
// 接上事件总线（SSE 转发），此后捕获行走 emit 与 adminApi 联动。
export function initLogs(emitter, retentionDaysArg = 7) {
  bus = emitter;
  retentionDays = clampDays(retentionDaysArg);
  const p = resolve(DATA_DIR, FILE);
  const cutoff = cutoffMs();
  if (existsSync(p)) {
    let dirty = false;
    // 捕获挂钩可能在 initLogs 之前已直写缓冲+文件（启动早期 proxy 行），
    // 回放时按 ts+msg+src 去重，避免重复条目
    const seen = new Set(lines.map((l) => l.ts + "|" + (l.src || "manager") + "|" + l.msg));
    try {
      for (const raw of readFileSync(p, "utf-8").split("\n")) {
        if (!raw.trim()) continue;
        try {
          const e = JSON.parse(raw);
          if (e && typeof e.ts === "number" && typeof e.msg === "string") {
            if (e.ts < cutoff) { dirty = true; continue; }
            const k = e.ts + "|" + (e.src || "manager") + "|" + e.msg;
            if (seen.has(k)) continue;
            seen.add(k);
            lines.push(e);
          }
        } catch { dirty = true; } // 坏行丢弃
      }
    } catch {}
    if (dirty) persist();
  }
  emitter.on("log", (entry) => {
    append({ ts: entry.ts || Date.now(), level: entry.level || "info", msg: String(entry.msg || ""), src: entry.src || "manager" });
  });
  attachConsoleCapture();
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = setInterval(() => prune(), 6 * 3600e3);
  if (pruneTimer.unref) pruneTimer.unref();
}

// ── 上游 proxy.mjs 日志捕获 ──
// 上游日志固定格式 `[ISO] [level] Message {"json":...}`（vendored 零改动，唯一出口
// 是 console.log），经此拦截进同一日志环/落盘，日志页即可看到 CC API 错误、
// 流超时、指纹/会话、unhandledRejection 等。拦截后原样透传 stdout，docker logs
// 不受影响。
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
        // 后续参数（若有）拼进消息保留上下文
        let msg = m[3];
        for (let i = 1; i < args.length; i++) {
          const a = args[i];
          msg += " " + (typeof a === "string" ? a : safeJson(a));
        }
        // 流式 keepalive/abort 等高频噪音：去重
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
// 上游 vendored 零改动，捕获侧脱敏：keyPrefix 打印了池内 Key 前 8 字符
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
  if (lines.length > MEM_CAP * 2) lines = lines.slice(-MEM_CAP);
  try {
    appendFileSync(resolve(DATA_DIR, FILE), JSON.stringify(e) + "\n", { mode: 0o600 });
  } catch {}
}

function persist() {
  try {
    const p = resolve(DATA_DIR, FILE);
    const body = lines.map((e) => JSON.stringify(e)).join("\n") + (lines.length ? "\n" : "");
    writeFileSync(p + ".tmp", body, { mode: 0o600 });
    renameSync(p + ".tmp", p);
  } catch {}
}

export function prune() {
  const cutoff = cutoffMs();
  const before = lines.length;
  lines = lines.filter((e) => e.ts >= cutoff);
  if (lines.length > MEM_CAP) lines = lines.slice(-MEM_CAP);
  if (lines.length !== before || existsSync(resolve(DATA_DIR, FILE))) persist();
}

export function getLogs({ since = 0, limit = 2000, src = "" } = {}) {
  let out = since > 0 ? lines.filter((l) => l.ts > since) : lines.slice();
  if (src) out = out.filter((l) => (l.src || "manager") === src);
  const cap = Math.max(1, Math.min(5000, Number(limit) || 2000));
  if (out.length > cap) out = out.slice(-cap);
  return out;
}
