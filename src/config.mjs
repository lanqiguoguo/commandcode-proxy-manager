// ── 管理端配置加载（config.json 位于 DATA_DIR；基础设施 env 覆写磁盘，
//    令牌 env 仅在磁盘无值时初始化填充——磁盘凭证优先，防改密后被 env 回滚） ─────
import fs from "fs";
import { isIP } from "net";
import { resolve } from "path";
import crypto from "crypto";
import { markPersistenceFailure, markPersistenceSuccess, persistenceError } from "./persistence.mjs";

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

const STRATEGIES = ["active-standby", "round-robin", "least-usage"];
const POOL_INTEGER_RULES = {
  maxRetries: { min: 0, max: 10 },
  sameKeyRetryCount: { min: 0, max: 5 },
  sameKeyRetryDelayMs: { min: 100, max: 10000 },
  sameKeyRetryMaxWaitMs: { min: 500, max: 30000 },
  backoffBaseMs: { min: 1000, max: 30000 },
  backoffMaxMs: { min: 5000, max: 600000 },
  connectTimeoutMs: { min: 1000, max: 300000 },
  failoverCooldownMs: { min: 0, max: 3600000 },
  fiveHourHardStop: { min: 50, max: 100 },
  weeklyHardStop: { min: 50, max: 100 },
  softStop: { min: 50, max: 100 },
  quotaRefreshMs: { min: 5000, max: 3600000 },
  quotaRefreshGapMs: { min: 0, max: 60000 },
  historyRetentionDays: { min: 1, max: 31 }
};
const POOL_BOOLEAN_FIELDS = ["zeroOutputCountsAs429"];
const POOL_FIELDS = ["strategy", ...Object.keys(POOL_INTEGER_RULES), ...POOL_BOOLEAN_FIELDS];
const CONFIG_SCALAR_FIELDS = ["port", "host", "clientToken", "adminToken", "upstreamPort", "upstreamHost"];

let cfg = null;
let persistedCfg = null;
let runtimeUpstreamHost = null;

export class ConfigValidationError extends Error {
  constructor(source, fields) {
    const cleanFields = fields.map((field) => ({ field: String(field.field), message: String(field.message) }));
    super(`${source || "配置"} 校验失败：${cleanFields.map((field) => `${field.field} ${field.message}`).join("；")}`);
    this.name = "ConfigValidationError";
    this.code = "CONFIG_VALIDATION_ERROR";
    this.statusCode = 400;
    this.fields = cleanFields;
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function defaultConfig() {
  return { ...DEFAULTS, pool: { ...DEFAULTS.pool } };
}

function hostIsValid(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 253 || value.trim() !== value || /\s/.test(value)) return false;
  if (isIP(value)) return true;
  const hostname = value.endsWith(".") ? value.slice(0, -1) : value;
  if (!hostname || hostname.length > 253) return false;
  return hostname.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

function addFieldError(fields, field, message) {
  fields.push({ field, message });
}

function validateInteger(value, field, rule, fields) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    addFieldError(fields, field, "必须是有限整数");
    return false;
  }
  if (value < rule.min || value > rule.max) {
    addFieldError(fields, field, `必须在 ${rule.min}..${rule.max} 范围内`);
    return false;
  }
  return true;
}

function validatePoolValues(pool, fields, prefix = "pool") {
  if (!isPlainObject(pool)) {
    addFieldError(fields, prefix, "必须是对象");
    return;
  }
  if (hasOwn(pool, "strategy") && (typeof pool.strategy !== "string" || !STRATEGIES.includes(pool.strategy))) {
    addFieldError(fields, `${prefix}.strategy`, `必须是 ${STRATEGIES.join("、")} 之一`);
  }
  for (const [key, rule] of Object.entries(POOL_INTEGER_RULES)) {
    if (hasOwn(pool, key)) validateInteger(pool[key], `${prefix}.${key}`, rule, fields);
  }
  for (const key of POOL_BOOLEAN_FIELDS) {
    if (hasOwn(pool, key) && typeof pool[key] !== "boolean") addFieldError(fields, `${prefix}.${key}`, "必须是布尔值（true/false）");
  }
  if (typeof pool.backoffBaseMs === "number" && Number.isFinite(pool.backoffBaseMs) &&
      typeof pool.backoffMaxMs === "number" && Number.isFinite(pool.backoffMaxMs) &&
      pool.backoffMaxMs < pool.backoffBaseMs) {
    addFieldError(fields, `${prefix}.backoffMaxMs`, `必须不小于 ${prefix}.backoffBaseMs`);
  }
  if (typeof pool.softStop === "number" && Number.isFinite(pool.softStop)) {
    for (const hardStop of ["fiveHourHardStop", "weeklyHardStop"]) {
      if (typeof pool[hardStop] === "number" && Number.isFinite(pool[hardStop]) && pool.softStop > pool[hardStop]) {
        addFieldError(fields, `${prefix}.softStop`, `必须不大于 ${prefix}.${hardStop}`);
      }
    }
  }
}

function configValidationError(source, fields) {
  return new ConfigValidationError(source, fields.length ? fields : [{ field: "$", message: "值无效" }]);
}

export function validateConfig(input, options = {}) {
  const source = options.source || "配置";
  const fields = [];
  if (!isPlainObject(input)) throw configValidationError(source, [{ field: "$", message: "顶层必须是对象，不能是数组或空值" }]);

  const out = defaultConfig();
  if (hasOwn(input, "port")) {
    if (validateInteger(input.port, "port", { min: 1, max: 65535 }, fields)) out.port = input.port;
  }
  if (hasOwn(input, "upstreamPort")) {
    if (validateInteger(input.upstreamPort, "upstreamPort", { min: 1, max: 65535 }, fields)) out.upstreamPort = input.upstreamPort;
  }
  for (const field of ["host", "upstreamHost"]) {
    if (hasOwn(input, field)) {
      if (hostIsValid(input[field])) out[field] = input[field];
      else addFieldError(fields, field, "必须是非空、无空白的主机名、IPv4 或 IPv6 地址");
    }
  }
  for (const field of ["clientToken", "adminToken"]) {
    if (!hasOwn(input, field)) continue;
    const value = input[field];
    if (typeof value !== "string") addFieldError(fields, field, "必须是字符串");
    else if (value.length > 1024) addFieldError(fields, field, "长度不能超过 1024");
    else if (value.trim() === "" && value !== "") addFieldError(fields, field, "不能只包含空白字符");
    else out[field] = value;
  }
  if (hasOwn(input, "pool")) {
    if (!isPlainObject(input.pool)) {
      addFieldError(fields, "pool", "必须是对象，不能是数组或空值");
    } else {
      for (const key of POOL_FIELDS) if (hasOwn(input.pool, key)) out.pool[key] = input.pool[key];
    }
  }
  validatePoolValues(out.pool, fields);
  if (fields.length) throw configValidationError(source, fields);
  return out;
}

function clampInteger(value, rule) {
  return Math.max(rule.min, Math.min(rule.max, value));
}

export function normalizePoolPatch(input, currentPool = DEFAULTS.pool) {
  const source = "管理端 pool 配置";
  if (!isPlainObject(input)) throw configValidationError(source, [{ field: "pool", message: "请求体必须是对象" }]);
  const fields = [];
  const patch = {};
  if (hasOwn(input, "strategy")) {
    if (typeof input.strategy !== "string" || !STRATEGIES.includes(input.strategy)) {
      addFieldError(fields, "pool.strategy", `必须是 ${STRATEGIES.join("、")} 之一`);
    } else patch.strategy = input.strategy;
  }
  for (const [key, rule] of Object.entries(POOL_INTEGER_RULES)) {
    if (!hasOwn(input, key)) continue;
    if (typeof input[key] !== "number" || !Number.isFinite(input[key]) || !Number.isInteger(input[key])) {
      addFieldError(fields, `pool.${key}`, "必须是有限整数");
    } else {
      // Keep the existing admin API contract: numeric values outside the range are clamped.
      patch[key] = clampInteger(input[key], rule);
    }
  }
  for (const key of POOL_BOOLEAN_FIELDS) {
    if (!hasOwn(input, key)) continue;
    if (typeof input[key] !== "boolean") addFieldError(fields, `pool.${key}`, "必须是布尔值（true/false）");
    else patch[key] = input[key];
  }
  if (fields.length) throw configValidationError(source, fields);

  const merged = { ...DEFAULTS.pool, ...(isPlainObject(currentPool) ? currentPool : {}), ...patch };
  const relationFields = [];
  if (merged.backoffMaxMs < merged.backoffBaseMs) addFieldError(relationFields, "pool.backoffMaxMs", "必须不小于 pool.backoffBaseMs");
  if (merged.softStop > merged.fiveHourHardStop) addFieldError(relationFields, "pool.softStop", "必须不大于 pool.fiveHourHardStop");
  if (merged.softStop > merged.weeklyHardStop) addFieldError(relationFields, "pool.softStop", "必须不大于 pool.weeklyHardStop");
  if (relationFields.length) throw configValidationError(source, relationFields);
  return patch;
}

function logConfigValidation(error) {
  console.error(`[config] ${error.message}`);
  for (const field of error.fields || []) console.error(`[config] 字段 ${field.field}：${field.message}`);
}

function quarantineConfig(path) {
  let backup = `${path}.corrupt-${Date.now()}`;
  while (fs.existsSync(backup)) backup = `${path}.corrupt-${Date.now() + 1}`;
  fs.renameSync(path, backup);
  return backup;
}

function envInteger(name, value, fields) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    addFieldError(fields, `env.${name}`, "必须是十进制整数");
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
    addFieldError(fields, `env.${name}`, "必须在 1..65535 范围内");
    return null;
  }
  return parsed;
}

function applyEnvironment(data) {
  const fields = [];
  if (process.env.PORT !== undefined && process.env.PORT !== "") {
    const value = envInteger("PORT", process.env.PORT, fields);
    if (value !== null) data.port = value;
  }
  if (process.env.UPSTREAM_PORT !== undefined && process.env.UPSTREAM_PORT !== "") {
    const value = envInteger("UPSTREAM_PORT", process.env.UPSTREAM_PORT, fields);
    if (value !== null) data.upstreamPort = value;
  }
  for (const [name, field] of [["HOST", "host"], ["UPSTREAM_HOST", "upstreamHost"]]) {
    if (process.env[name] === undefined || process.env[name] === "") continue;
    if (hostIsValid(process.env[name])) data[field] = process.env[name];
    else addFieldError(fields, `env.${name}`, "必须是非空、无空白的主机名、IPv4 或 IPv6 地址");
  }
  if (fields.length) {
    const error = configValidationError("环境变量", fields);
    logConfigValidation(error);
    throw error;
  }
}

function applyTokenEnvironment(data) {
  for (const [name, field] of [["ADMIN_TOKEN", "adminToken"], ["CLIENT_TOKEN", "clientToken"]]) {
    const value = process.env[name];
    if (!value) continue;
    if (data[field]) {
      if (data[field] !== value) console.warn(`[config] 忽略环境变量 ${name}（磁盘 config.json 已有值）`);
    } else {
      data[field] = value;
    }
  }
}

function checkDataDirWritable() {
  const probe = resolve(DATA_DIR, ".ccpm-write-check-" + process.pid + "-" + Date.now() + "-" + crypto.randomBytes(6).toString("hex"));
  const tmp = probe + ".tmp";
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(tmp, "ok", { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, probe);
    fs.unlinkSync(probe);
    markPersistenceSuccess("data-dir");
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    try { fs.unlinkSync(probe); } catch {}
    const failure = persistenceError("[config] DATA_DIR is not writable", e);
    markPersistenceFailure(failure, "data-dir");
    console.error(failure.message);
    return false;
  }
}

export function loadConfig() {
  runtimeUpstreamHost = null;
  persistedCfg = null;
  checkDataDirWritable();
  const path = resolve(DATA_DIR, "config.json");
  // P2-1：解析失败先把损坏文件备份为 config.json.corrupt-<ts> 再落默认值，
  // 防止结尾 saveConfig() 用默认/新生成凭证原子覆盖磁盘导致旧凭证永久丢失（锁死）。
  let data = defaultConfig();
  if (fs.existsSync(path)) {
    let user;
    try {
      user = JSON.parse(fs.readFileSync(path, "utf-8"));
    } catch (e) {
      console.error("[config] failed to parse config.json:", e.message);
      try {
        const backup = quarantineConfig(path);
        console.warn("[config] config.json 解析失败，已备份为 " + backup.split("/").pop() + "，本次以默认值启动");
      } catch (be) {
        // 备份失败也不能崩：继续用默认值启动，但明确警告凭证可能丢失
        console.error("[config] 损坏的 config.json 备份失败: " + be.message + " —— 旧配置未能备份，凭证可能丢失");
      }
    }
    if (user !== undefined) {
      try {
        data = validateConfig(user, { source: "磁盘 config.json" });
      } catch (e) {
        if (!(e instanceof ConfigValidationError)) throw e;
        logConfigValidation(e);
        try {
          const backup = quarantineConfig(path);
          console.error(`[config] 语义损坏的 config.json 已隔离为 ${backup.split("/").pop()}，拒绝启动`);
        } catch (be) {
          console.error(`[config] 语义损坏的 config.json 隔离失败：${be.message}，拒绝启动且保留原文件`);
        }
        throw e;
      }
    }
  }
  // 环境变量覆写（基础设施配置）
  applyEnvironment(data);
  // P2-2：令牌 env 仅在磁盘无值时填充（初始化语义）。此前无条件覆写会让
  // UI 经 /admin/api/security 改密后、带遗留 env 重启时把令牌静默回滚为旧 env 值。
  applyTokenEnvironment(data);

  if (!data.adminToken) {
    data.adminToken = crypto.randomBytes(24).toString("hex");
    console.log("============================================================");
    console.log("  Generated AdminToken (also the fallback client token):");
    console.log("  " + data.adminToken);
    console.log("  Persisted to " + resolve(DATA_DIR, "config.json"));
    console.log("============================================================");
  }
  try {
    data = validateConfig(data, { source: "生效配置" });
  } catch (e) {
    if (e instanceof ConfigValidationError) logConfigValidation(e);
    throw e;
  }
  cfg = data;
  persistedCfg = { ...data, pool: { ...data.pool } };
  try {
    saveConfig();
  } catch (e) {
    // Keep the in-memory config available so the server can expose a degraded
    // health response and reject mutating admin calls with 503.
    console.error("[config] initial save unavailable:", e.message);
  }
  return cfg;
}

export function getConfig() { return cfg; }

// Hosted mode uses loopback at runtime without rewriting the configured host.
export function setRuntimeUpstreamHost(host) {
  if (!cfg) throw new Error("配置尚未加载");
  if (!hostIsValid(host)) throw new TypeError("运行时上游主机无效");
  runtimeUpstreamHost = host;
  cfg = { ...cfg, upstreamHost: host };
  return cfg;
}

export function saveConfig(nextCfg = cfg) {
  if (!nextCfg || typeof nextCfg !== "object") throw new Error("配置尚未加载");
  const normalized = validateConfig(nextCfg, { source: "待保存配置" });
  const persisted = runtimeUpstreamHost === null
    ? normalized
    : { ...normalized, upstreamHost: persistedCfg?.upstreamHost || normalized.upstreamHost };
  const path = resolve(DATA_DIR, "config.json");
  const tmp = path + ".tmp";
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, path);
    persistedCfg = { ...persisted, pool: { ...persisted.pool } };
    cfg = runtimeUpstreamHost === null ? normalized : { ...normalized, upstreamHost: runtimeUpstreamHost };
    markPersistenceSuccess("config");
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    const failure = persistenceError("[config] save failed", e);
    markPersistenceFailure(failure, "config");
    console.error(failure.message);
    throw failure;
  }
}
