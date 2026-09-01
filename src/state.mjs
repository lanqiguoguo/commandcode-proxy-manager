// ── /data 持久化小工具（原子写 + 防抖） ─────────────────────
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { resolve } from "path";
import { DATA_DIR } from "./config.mjs";

export function readJson(name, fallback) {
  try {
    const p = resolve(DATA_DIR, name);
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  } catch (e) {
    console.error("[state] read " + name + " failed:", e.message);
  }
  return fallback;
}

export function writeJson(name, data) {
  try {
    const p = resolve(DATA_DIR, name);
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(p + ".tmp", JSON.stringify(data), { mode: 0o600 });
    renameSync(p + ".tmp", p);
  } catch (e) {
    console.error("[state] write " + name + " failed:", e.message);
  }
}

// P2-4：模块级待写注册表。每个 debouncedWriter 创建时自注册，进程收到
// SIGTERM/SIGINT 时由 flushAllPending() 在退出前同步落盘，防止恰好处于
// 防抖窗口的退避/健康/额度数据丢失。quota.mjs/keyPool.mjs 无需改动。
const pending = new Set();

export function debouncedWriter(name, getData, delayMs = 1000) {
  let timer = null;
  const schedule = function () {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      writeJson(name, getData());
    }, delayMs);
  };
  // 附带 .flush()：有未决 timer 时取消并立即同步写盘；无 timer（从未调度/
  // 已写）幂等 no-op。writeJson 为同步 writeFileSync+renameSync，信号回调
  // （事件循环 tick 边界）里调用安全。
  schedule.flush = function () {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    writeJson(name, getData());
  };
  pending.add(schedule);
  return schedule;
}

export function flushAllPending() {
  for (const fn of pending) {
    try { fn.flush && fn.flush(); } catch (e) { console.error("[state] flush failed:", e.message); }
  }
}
