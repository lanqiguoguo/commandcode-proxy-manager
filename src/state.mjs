// ── /data 持久化小工具（原子写 + 防抖） ─────────────────────
import fs from "fs";
import { resolve } from "path";
import { DATA_DIR } from "./config.mjs";
import { markPersistenceFailure, markPersistenceSuccess, persistenceError } from "./persistence.mjs";

export function readJson(name, fallback) {
  try {
    const p = resolve(DATA_DIR, name);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    console.error("[state] read " + name + " failed:", e.message);
  }
  return fallback;
}

export function writeJson(name, data) {
  const p = resolve(DATA_DIR, name);
  const tmp = p + ".tmp";
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, p);
    markPersistenceSuccess("file:" + name);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    const failure = persistenceError("[state] write " + name + " failed", e);
    markPersistenceFailure(failure, "file:" + name);
    console.error(failure.message);
    throw failure;
  }
}

// P2-4：模块级待写注册表。每个 debouncedWriter 创建时自注册，进程收到
// SIGTERM/SIGINT 时由 flushAllPending() 在退出前同步落盘，防止恰好处于
// 防抖窗口的退避/健康/额度数据丢失。quota.mjs/keyPool.mjs 无需改动。
const pending = new Set();

export function debouncedWriter(name, getData, delayMs = 1000) {
  let timer = null;
  const armTimer = (unref = false) => {
    if (timer) return false;
    timer = setTimeout(() => {
      timer = null;
      try {
        writeJson(name, getData());
      } catch (e) {
        // Keep the latest in-memory state queued when an asynchronous write fails.
        // A later successful write clears the shared persistence failure status.
        console.error("[state] async write " + name + " failed:", e.message);
        armTimer(unref);
      }
    }, delayMs);
    if (unref) timer.unref();
    return true;
  };
  const schedule = function () {
    return { scheduled: armTimer(), durable: false };
  };
  // 附带 .flush()：有未决 timer 时取消并立即同步写盘；无 timer（从未调度/
  // 已写）幂等 no-op；force 用于显式管理变更，保证当前状态确实已写盘。
  // writeJson 为同步 writeFileSync+renameSync，信号回调（事件循环 tick 边界）里调用安全。
  schedule.flush = function ({ force = false } = {}) {
    const hadPending = !!timer;
    if (hadPending) {
      clearTimeout(timer);
      timer = null;
    }
    if (!hadPending && !force) return { scheduled: false, durable: false };
    try {
      writeJson(name, getData());
      return { scheduled: false, durable: true };
    } catch (e) {
      // A failed flush must not erase state that was already waiting for the
      // debounce timer. The caller may roll back its in-memory mutation before
      // this re-queued timer gets a chance to run.
      if (hadPending) armTimer(true);
      throw e;
    }
  };
  pending.add(schedule);
  return schedule;
}

export function flushAllPending() {
  for (const fn of pending) {
    try { fn.flush && fn.flush(); } catch (e) { console.error("[state] flush failed:", e.message); }
  }
}
