// ── 管理端配置加载（config.json 位于 DATA_DIR，环境变量优先） ─────
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { resolve } from "path";
import crypto from "crypto";

export const DATA_DIR = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : resolve(process.cwd(), "data");

const DEFAULTS = {
  port: 3080,
  host: "0.0.0.0",
  clientToken: "",          // 客户端访问令牌（未配置时回退 adminToken）
  adminToken: "",           // 管理端令牌（首次启动自动生成并持久化）
  upstreamPort: 3050,       // 上游代理内部端口（不对外）
  upstreamHost: "127.0.0.1",
  pool: {
    strategy: "active-standby",   // active-standby | round-robin | least-usage
    maxRetries: 3,                // 单请求总重试上限（含同 Key 与换 Key）
    sameKeyRetryCount: 2,         // 429/零输出先同 Key 重试次数
    sameKeyRetryDelayMs: 2000,    // 同 Key 重试间隔上限
    sameKeyRetryMaxWaitMs: 5000,  // 上游 Retry-After 超过该值则视为真实限流直接切换
    backoffBaseMs: 5000,          // 退避基数（指数退避）
    backoffMaxMs: 120000,
    connectTimeoutMs: 120000,     // 单尝试等待上游响应头的上限（需 > 上游自身 90s 非流式/30s 流式超时，纯兜底）
    failoverCooldownMs: 600000,   // 切换冷却，防止抖动
    fiveHourHardStop: 90,         // 5h 窗口硬阈值（%）
    weeklyHardStop: 90,           // 每周窗口硬阈值（%）
    softStop: 80,                 // 软限制阈值（%）：保留但降级
    quotaRefreshMs: 60000,        // 额度探测刷新间隔
    zeroOutputCountsAs429: true,  // 零输出是否计入 429
    historyRetentionDays: 7       // 历史记录保留天数（1-31）
  }
};

let cfg = null;

export function loadConfig() {
  mkdirSync(DATA_DIR, { recursive: true });
  const path = resolve(DATA_DIR, "config.json");
  const data = JSON.parse(JSON.stringify(DEFAULTS));
  if (existsSync(path)) {
    try {
      const user = JSON.parse(readFileSync(path, "utf-8"));
      for (const k of Object.keys(user)) {
        if (k === "pool") Object.assign(data.pool, user.pool || {});
        else data[k] = user[k];
      }
    } catch (e) {
      console.error("[config] failed to parse config.json:", e.message);
    }
  }
  // 环境变量覆写
  if (process.env.PORT) data.port = parseInt(process.env.PORT, 10) || data.port;
  if (process.env.HOST) data.host = process.env.HOST;
  if (process.env.ADMIN_TOKEN) data.adminToken = process.env.ADMIN_TOKEN;
  if (process.env.CLIENT_TOKEN) data.clientToken = process.env.CLIENT_TOKEN;
  if (process.env.UPSTREAM_PORT) data.upstreamPort = parseInt(process.env.UPSTREAM_PORT, 10) || data.upstreamPort;
  if (process.env.UPSTREAM_HOST) data.upstreamHost = process.env.UPSTREAM_HOST;

  if (!data.adminToken) {
    data.adminToken = crypto.randomBytes(24).toString("hex");
    console.log("============================================================");
    console.log("  Generated AdminToken (also the fallback client token):");
    console.log("  " + data.adminToken);
    console.log("  Persisted to " + resolve(DATA_DIR, "config.json"));
    console.log("============================================================");
  }
  cfg = data;
  saveConfig();
  return cfg;
}

export function getConfig() { return cfg; }

export function saveConfig() {
  if (!cfg) return;
  try {
    const path = resolve(DATA_DIR, "config.json");
    writeFileSync(path + ".tmp", JSON.stringify(cfg, null, 2), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  } catch (e) {
    console.error("[config] save failed:", e.message);
  }
}
