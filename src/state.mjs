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

export function debouncedWriter(name, getData, delayMs = 1000) {
  let timer = null;
  return function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      writeJson(name, getData());
    }, delayMs);
  };
}
