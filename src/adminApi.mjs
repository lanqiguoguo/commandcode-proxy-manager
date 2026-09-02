// ── 管理 REST API + SSE + 系统日志（logs.mjs 持久化） ─────
import crypto from "crypto";
import { getConfig, saveConfig } from "./config.mjs";
import * as pool from "./keyPool.mjs";
import * as quota from "./quota.mjs";
import * as stats from "./stats.mjs";
import { getLogs, setRetention as logsSetRetention } from "./logs.mjs";
import { safeEqual } from "./tokens.mjs";

let emitter = null;

// P1-5：条件性 Secure cookie。默认部署为明文 HTTP 容器（docker-compose 直发 3080），
// 默认开 Secure 会让无 TLS 场景下 cookie 完全不回传、SSE 全挂；故仅当
// SECURE_COOKIES=1/true（置于 TLS 反代之后）时附加 Secure 属性。
// login 下发与 logout 撤销必须用同一属性组合，否则撤销可能失效。
function secureCookieAttr() {
  const v = String(process.env.SECURE_COOKIES || "").toLowerCase();
  return v === "1" || v === "true" ? "; Secure" : "";
}

// P1-3：login 按 IP 的内存级失败计数（滑动窗口）。15 分钟内失败 ≥10 次锁定 15 分钟。
// 仅计 /admin/api/login 的 401（错误 x-admin-token 的 API 请求不计，避免拖死管理 UI 轮询）；
// 成功登录清零该 IP 计数。进程内状态：重启即复位（可接受，重启本身即成本）。
// 条目惰性清理：每次 login 顺手删除已过期条目，Map 不随时间无限增长。
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginFails = new Map(); // ip -> { fails, firstAt, lockedUntil }
function loginLocked(ip, now) {
  // 惰性清理：窗口已过且未处于锁定期的条目直接删除（锁定条目过期后同样落入此分支）
  for (const [k, e] of loginFails) {
    if (k !== ip && e.lockedUntil <= now && now - e.firstAt > LOGIN_WINDOW_MS) loginFails.delete(k);
  }
  const e = loginFails.get(ip);
  if (!e) return false;
  if (e.lockedUntil > now) return true;
  if (now - e.firstAt > LOGIN_WINDOW_MS) { loginFails.delete(ip); return false; }
  return false;
}
function loginFailRecord(ip, now) {
  const e = loginFails.get(ip);
  if (!e || now - e.firstAt > LOGIN_WINDOW_MS) {
    loginFails.set(ip, { fails: 1, firstAt: now, lockedUntil: 0 });
  } else {
    e.fails++;
    if (e.fails >= LOGIN_MAX_FAILS) e.lockedUntil = now + LOGIN_LOCK_MS;
  }
}

// SSE 专用 cookie：EventSource 无法带自定义 header，token 走 query 会泄漏到
// URL（DevTools 连接面板/代理访问日志/Referer）。改用 HttpOnly cookie：
// 值为 adminToken 的 SHA-256 摘要（cookie 中不出现明文），Path 限定仅 events
// 端点会回传，SameSite=Strict 阻断跨站页面借用户会话偷连事件流。
const SSE_COOKIE = "ccpm_sse";
function sseCookieValue() {
  return crypto.createHash("sha256").update(getConfig().adminToken).digest("hex");
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function initAdminApi(emitterRef) {
  emitter = emitterRef;
  // log 事件的落盘/环缓在 logs.mjs initLogs 中统一订阅处理
}

function sendJson(res, status, data, extraHeaders) {
  const headers = { "Content-Type": "application/json" };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  if (data && data.retry_after !== undefined) headers["Retry-After"] = String(data.retry_after);
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function readJsonBody(req, opts = {}) {
  const limit = opts.limit ?? 256 * 1024; // admin JSON 默认 256KB 上限
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        overflow = true;
        // 丢弃后续数据，等待 end 再拒绝，避免破坏连接
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (overflow) {
        reject(Object.assign(new Error("请求体过大"), { statusCode: 413 }));
        return;
      }
      try {
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : {});
      } catch {
        resolveBody(null);
      }
    });
    req.on("error", reject);
  });
}

const POOL_FIELDS = [
  "strategy", "maxRetries", "sameKeyRetryCount", "sameKeyRetryDelayMs", "sameKeyRetryMaxWaitMs",
  "backoffBaseMs", "backoffMaxMs", "connectTimeoutMs", "failoverCooldownMs", "fiveHourHardStop", "weeklyHardStop",
  "softStop", "quotaRefreshMs", "quotaRefreshGapMs", "zeroOutputCountsAs429", "historyRetentionDays"
];
const INT_FIELDS = ["maxRetries", "sameKeyRetryCount", "sameKeyRetryDelayMs", "sameKeyRetryMaxWaitMs",
  "backoffBaseMs", "backoffMaxMs", "connectTimeoutMs", "failoverCooldownMs", "fiveHourHardStop", "weeklyHardStop",
  "softStop", "quotaRefreshMs", "quotaRefreshGapMs", "historyRetentionDays"];

function sanitizePoolPatch(body) {
  const patch = {};
  for (const k of POOL_FIELDS) {
    if (body[k] === undefined) continue;
    if (INT_FIELDS.includes(k)) {
      let v = Number(body[k]);
      if (!Number.isFinite(v)) continue;
      if (k === "maxRetries") v = Math.max(0, Math.min(10, Math.round(v)));
      else if (k === "sameKeyRetryCount") v = Math.max(0, Math.min(5, Math.round(v)));
      else if (k === "sameKeyRetryDelayMs") v = Math.max(100, Math.min(10000, Math.round(v)));
      else if (k === "sameKeyRetryMaxWaitMs") v = Math.max(500, Math.min(30000, Math.round(v)));
      else if (k === "backoffBaseMs") v = Math.max(1000, Math.min(30000, Math.round(v)));
      else if (k === "backoffMaxMs") v = Math.max(5000, Math.min(600000, Math.round(v)));
      else if (k === "connectTimeoutMs") v = Math.max(1000, Math.min(300000, Math.round(v)));
      else if (k === "failoverCooldownMs") v = Math.max(0, Math.min(3600000, Math.round(v)));
      else if (k === "fiveHourHardStop") v = Math.max(50, Math.min(100, Math.round(v)));
      else if (k === "weeklyHardStop") v = Math.max(50, Math.min(100, Math.round(v)));
      else if (k === "softStop") v = Math.max(50, Math.min(100, Math.round(v)));
      else if (k === "quotaRefreshMs") v = Math.max(5000, Math.min(3600000, Math.round(v)));
      else if (k === "quotaRefreshGapMs") v = Math.max(0, Math.min(60000, Math.round(v)));
      else if (k === "historyRetentionDays") v = Math.max(1, Math.min(31, Math.round(v)));
      else v = Math.round(v);
      // 语义约束：backoffMax 必须 >= backoffBase，阈值需 softStop <= hardStop 在调用方处理
      patch[k] = v;
    } else if (k === "strategy") {
      if (["active-standby", "round-robin", "least-usage"].includes(body[k])) patch[k] = body[k];
    } else {
      patch[k] = !!body[k];
    }
  }
  // 交叉约束：backoffMaxMs 必须 >= backoffBaseMs
  if (patch.backoffMaxMs !== undefined && patch.backoffBaseMs !== undefined) {
    if (patch.backoffMaxMs < patch.backoffBaseMs) patch.backoffMaxMs = patch.backoffBaseMs;
  }
  return patch;
}

export async function handleAdmin(req, res, url) {
  const cfg = getConfig();
  const p = url.pathname;

  if (p === "/admin/api/logout") {
    if (req.method !== "POST") { sendJson(res, 405, { error: { message: "Method not allowed" } }); return true; }
    // 退出登录时撤销 SSE cookie（HttpOnly cookie 前端 JS 删不掉）；
    // 此端点无需鉴权：撤销凭证本身是幂等安全操作
    // 属性组合（含条件 Secure）必须与 login 下发一致，否则撤销失效
    res.setHeader("Set-Cookie", SSE_COOKIE + "=; HttpOnly; Path=/admin/api/events; SameSite=Strict; Max-Age=0" + secureCookieAttr());
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (p === "/admin/api/login") {
    if (req.method !== "POST") { sendJson(res, 405, { error: { message: "Method not allowed" } }); return true; }
    const ip = req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const locked = loginLocked(ip, now);
    const body = await readJsonBody(req);
    if (!body || !safeEqual(body.token, cfg.adminToken)) {
      // 锁定期内的失败尝试直接 429（不再回 401，掐断爆破反馈）；
      // 持正确令牌者即使在锁定期仍可登录并清零计数——限速防的是猜，不是合法管理员
      if (locked) {
        sendJson(res, 429, { error: "too many failed attempts" });
        return true;
      }
      loginFailRecord(ip, Date.now());
      sendJson(res, 401, { error: { message: "Invalid admin token", type: "auth_error" } });
      return true;
    }
    loginFails.delete(ip); // 成功登录清零该 IP 失败计数（含解除锁定）
    // HttpOnly：JS 读不到；Path 限定 events 端点：其余请求浏览器不回传，
    // 缩小泄漏面；SameSite=Strict：跨站页面无法携带此 cookie 建 SSE；
    // Secure：仅 SECURE_COOKIES=1（TLS 反代部署）时附加，见 secureCookieAttr()
    res.setHeader("Set-Cookie", SSE_COOKIE + "=" + sseCookieValue() +
      "; HttpOnly; Path=/admin/api/events; SameSite=Strict; Max-Age=86400" + secureCookieAttr());
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (!p.startsWith("/admin/api/")) return false;

  // 鉴权：X-Admin-Token header（管理 API 主通道）；仅 SSE 端点额外接受
  // 登录时下发的 HttpOnly 专用 cookie（EventSource 带不了 header，且 token
  // 已不再出现在 URL 中）。query ?token= 通道已移除——URL 会被 DevTools
  // 连接面板、反代 access log、Referer 等记录，明文令牌不应暴露。
  // !!cfg.adminToken：保留原 "空 header 不得匹配空令牌" 守卫（safeEqual("","") 为 true）
  let authed = !!cfg.adminToken && safeEqual(req.headers["x-admin-token"], cfg.adminToken);
  if (!authed && p === "/admin/api/events" && req.method === "GET") {
    authed = safeEqual(parseCookies(req)[SSE_COOKIE], sseCookieValue());
  }
  if (!authed) {
    sendJson(res, 401, { error: { message: "Unauthorized", type: "auth_error" } });
    return true;
  }

  try {
    // ── keys ──
    if (p === "/admin/api/keys" && req.method === "GET") {
      const keys = pool.listKeys().map((k) => {
        const h = pool.getHealth(k.id);
        return {
          id: k.id,
          alias: k.alias,
          maskedKey: pool.maskKey(k.key),
          enabled: k.enabled,
          note: k.note,
          priority: k.priority,
          createdAt: k.createdAt,
          health: h,
          quota: quota.getReport(k.id),
          usage: stats.usageByKey(k.id)
        };
      });
      sendJson(res, 200, { keys });
      return true;
    }

    if (p === "/admin/api/keys" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body || !body.key) throw new Error("缺少 key 字段");
      const rec = pool.addKey({ alias: body.alias, key: String(body.key).trim(), note: body.note });
      quota.refreshKey(rec.id).catch(() => {});
      sendJson(res, 201, { id: rec.id, maskedKey: pool.maskKey(rec.key), alias: rec.alias, priority: rec.priority });
      return true;
    }

    const parts = p.split("/").filter(Boolean); // ["admin","api","keys", id?, action?]

    if (parts.length === 4 && parts[2] === "keys" && req.method === "PUT") {
      const body = await readJsonBody(req);
      pool.updateKey(parts[3], body || {});
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (parts.length === 4 && parts[2] === "keys" && req.method === "DELETE") {
      pool.removeKey(parts[3]);
      res.writeHead(204);
      res.end();
      return true;
    }

    if (parts.length === 5 && parts[2] === "keys" && parts[4] === "refresh-quota" && req.method === "POST") {
      const report = await Promise.race([
        quota.refreshKey(parts[3]),
        new Promise((_, rej) => setTimeout(() => rej(new Error("probe timeout")), 35000))
      ]);
      sendJson(res, 200, { quota: report });
      return true;
    }

    if (parts.length === 5 && parts[2] === "keys" && parts[4] === "test" && req.method === "POST") {
      const r = await quota.testKey(parts[3]);
      if (r.ok) pool.clearAuthError(parts[3]);
      sendJson(res, 200, r);
      return true;
    }

    if (parts.length === 5 && parts[2] === "keys" && parts[4] === "clear-auth" && req.method === "POST") {
      pool.clearAuthError(parts[3]);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (parts.length === 5 && parts[2] === "keys" && parts[4] === "clear-backoff" && req.method === "POST") {
      pool.clearBackoff(parts[3]);
      sendJson(res, 200, { ok: true });
      return true;
    }

    // ── history ──
    if (p === "/admin/api/history" && req.method === "GET") {
      const q = url.searchParams;
      const result = stats.queryEvents({
        keyId: q.get("keyId") || undefined,
        from: q.get("from") || undefined,
        to: q.get("to") || undefined,
        status: q.get("status") || undefined,
        errorKind: q.get("errorKind") || undefined,
        page: q.get("page") || 1,
        pageSize: q.get("pageSize") || 50
      });
      sendJson(res, 200, result);
      return true;
    }

    // ── pool / settings ──
    if (p === "/admin/api/pool" && req.method === "GET") {
      sendJson(res, 200, {
        poolCfg: pool.getPoolCfg(),
        clientTokenConfigured: !!cfg.clientToken,
        adminTokenConfigured: !!cfg.adminToken,
        retentionDays: cfg.pool.historyRetentionDays,
        stats: stats.poolStats(),
        counts: pool.getPoolStats()
      });
      return true;
    }

    if (p === "/admin/api/pool" && req.method === "PUT") {
      const body = await readJsonBody(req);
      const patch = sanitizePoolPatch(body || {});
      if (!Object.keys(patch).length) throw new Error("无有效配置项");
      cfg.pool = { ...cfg.pool, ...patch };
      pool.setPoolCfg(patch);
      saveConfig();
      if (patch.quotaRefreshMs !== undefined) quota.setRefreshMs(patch.quotaRefreshMs);
      if (patch.historyRetentionDays !== undefined) {
        stats.setRetention(patch.historyRetentionDays);
        logsSetRetention(patch.historyRetentionDays); // 系统日志同保留策略
      }
      sendJson(res, 200, { ok: true, poolCfg: pool.getPoolCfg() });
      return true;
    }

    if (p === "/admin/api/security" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (body.clientToken !== undefined) {
        cfg.clientToken = String(body.clientToken).slice(0, 128);
      }
      if (body.adminToken !== undefined) {
        const t = String(body.adminToken).trim();
        if (t.length < 8) throw new Error("AdminToken 至少 8 位");
        cfg.adminToken = t;
      }
      saveConfig();
      sendJson(res, 200, { ok: true });
      return true;
    }

    // ── logs ──（logs.mjs 持久化环：启动回放 + 按保留天数清理，跨重启不丢；src=manager|proxy 过滤）
    if (p === "/admin/api/logs" && req.method === "GET") {
      const since = Number(url.searchParams.get("since")) || 0;
      const limit = Number(url.searchParams.get("limit")) || 2000;
      const src = url.searchParams.get("src") || "";
      sendJson(res, 200, { logs: getLogs({ since, limit, src }) });
      return true;
    }

    // ── SSE ──
    if (p === "/admin/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });
      res.write(": connected\n\n");
      const send = (event, data) => {
        try { res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"); } catch {}
      };
      const onQuota = (d) => send("quota", d);
      const onStats = (d) => send("stats", d);
      const onLog = (d) => send("log", { ts: d.ts || Date.now(), level: d.level || "info", msg: d.msg, src: d.src || "manager" });
      const onQuotaStatus = (d) => send("quota-status", d);
      emitter.on("quota", onQuota);
      emitter.on("stats", onStats);
      emitter.on("log", onLog);
      emitter.on("quotaStatus", onQuotaStatus);
      const keep = setInterval(() => { try { res.write(": keepalive\n\n"); } catch {} }, 15000);
      req.on("close", () => {
        clearInterval(keep);
        emitter.off("quota", onQuota);
        emitter.off("stats", onStats);
        emitter.off("log", onLog);
        emitter.off("quotaStatus", onQuotaStatus);
      });
      return true;
    }

    sendJson(res, 404, { error: { message: "Not found", type: "not_found" } });
    return true;
  } catch (e) {
    sendJson(res, 400, { error: { message: e.message, type: "invalid_request_error" } });
    return true;
  }
}
