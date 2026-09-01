// ── 管理端配置加载（config.json 位于 DATA_DIR；基础设施 env 覆写磁盘，
//    令牌 env 仅在磁盘无值时初始化填充——磁盘凭证优先，防改密后被 env 回滚） ─────
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
    quotaRefreshGapMs: 2000,      // 全量刷新时相邻 Key 的探测间隔（上游风控：禁止并发打 API）
    zeroOutputCountsAs429: true,  // 零输出是否计入 429
    historyRetentionDays: 7       // 历史记录保留天数（1-31）
  }
};

let cfg = null;

export function loadConfig() {
  mkdirSync(DATA_DIR, { recursive: true });
  const path = resolve(DATA_DIR, "config.json");
  const data = JSON.parse(JSON.stringify(DEFAULTS));
  // P2-1：解析失败先把损坏文件备份为 config.json.corrupt-<ts> 再落默认值，
  // 防止结尾 saveConfig() 用默认/新生成凭证原子覆盖磁盘导致旧凭证永久丢失（锁死）。
  let configCorrupt = false;
  if (existsSync(path)) {
    try {
      const user = JSON.parse(readFileSync(path, "utf-8"));
      for (const k of Object.keys(user)) {
        if (k === "pool") Object.assign(data.pool, user.pool || {});
        else data[k] = user[k];
      }
    } catch (e) {
      console.error("[config] failed to parse config.json:", e.message);
      configCorrupt = true;
    }
    if (configCorrupt) {
      const backup = path + ".corrupt-" + Date.now();
      try {
        renameSync(path, backup);
        console.warn("[config] config.json 解析失败，已备份为 " + backup.split("/").pop() + "，本次以默认值启动");
      } catch (be) {
        // 备份失败也不能崩：继续用默认值启动，但明确警告凭证可能丢失
        console.error("[config] 损坏的 config.json 备份失败: " + be.message + " —— 旧配置未能备份，凭证可能丢失");
      }
    }
  }
  // 环境变量覆写（基础设施配置）
  if (process.env.PORT) data.port = parseInt(process.env.PORT, 10) || data.port;
  if (process.env.HOST) data.host = process.env.HOST;
  if (process.env.UPSTREAM_PORT) data.upstreamPort = parseInt(process.env.UPSTREAM_PORT, 10) || data.upstreamPort;
  if (process.env.UPSTREAM_HOST) data.upstreamHost = process.env.UPSTREAM_HOST;
  // P2-2：令牌 env 仅在磁盘无值时填充（初始化语义）。此前无条件覆写会让
  // UI 经 /admin/api/security 改密后、带遗留 env 重启时把令牌静默回滚为旧 env 值。
  if (process.env.ADMIN_TOKEN) {
    if (!data.adminToken) data.adminToken = process.env.ADMIN_TOKEN;
    else if (data.adminToken !== process.env.ADMIN_TOKEN) {
      console.warn("[config] 忽略环境变量 ADMIN_TOKEN（磁盘 config.json 已有值，如需以 env 为准请先清空磁盘令牌）");
    }
  }
  if (process.env.CLIENT_TOKEN) {
    if (!data.clientToken) data.clientToken = process.env.CLIENT_TOKEN;
    else if (data.clientToken !== process.env.CLIENT_TOKEN) {
      console.warn("[config] 忽略环境变量 CLIENT_TOKEN（磁盘 config.json 已有值，如需以 env 为准请先清空磁盘令牌）");
    }
  }

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
