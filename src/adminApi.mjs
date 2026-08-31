// ── 管理 REST API + SSE + 日志环形缓冲 ─────────────────
import { getConfig, saveConfig } from "./config.mjs";
import * as pool from "./keyPool.mjs";
import * as quota from "./quota.mjs";
import * as stats from "./stats.mjs";

const logRing = [];
let emitter = null;

export function initAdminApi(emitterRef) {
  emitter = emitterRef;
  emitter.on("log", (entry) => {
    logRing.push({ ts: Date.now(), level: entry.level || "info", msg: entry.msg });
    if (logRing.length > 500) logRing.shift();
  });
}

function sendJson(res, status, data, extraHeaders) {
  const headers = { "Content-Type": "application/json" };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  if (data && data.retry_after !== undefined) headers["Retry-After"] = String(data.retry_after);
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
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
  "backoffBaseMs", "backoffMaxMs", "failoverCooldownMs", "fiveHourHardStop", "weeklyHardStop",
  "softStop", "quotaRefreshMs", "zeroOutputCountsAs429", "historyRetentionDays"
];
const INT_FIELDS = ["maxRetries", "sameKeyRetryCount", "sameKeyRetryDelayMs", "sameKeyRetryMaxWaitMs",
  "backoffBaseMs", "backoffMaxMs", "failoverCooldownMs", "fiveHourHardStop", "weeklyHardStop",
  "softStop", "quotaRefreshMs", "historyRetentionDays"];

function sanitizePoolPatch(body) {
  const patch = {};
  for (const k of POOL_FIELDS) {
    if (body[k] === undefined) continue;
    if (INT_FIELDS.includes(k)) {
      let v = Number(body[k]);
      if (!Number.isFinite(v)) continue;
      if (k === "maxRetries") v = Math.max(0, Math.min(10, Math.round(v)));
      if (k === "sameKeyRetryCount") v = Math.max(0, Math.min(5, Math.round(v)));
      if (k === "quotaRefreshMs") v = Math.max(5000, Math.round(v));
      if (k === "historyRetentionDays") v = Math.max(1, Math.min(31, Math.round(v)));
      patch[k] = v;
    } else if (k === "strategy") {
      if (["active-standby", "round-robin", "least-usage"].includes(body[k])) patch[k] = body[k];
    } else {
      patch[k] = !!body[k];
    }
  }
  return patch;
}

export async function handleAdmin(req, res, url) {
  const cfg = getConfig();
  const p = url.pathname;

  if (p === "/admin/api/login") {
    if (req.method !== "POST") { sendJson(res, 405, { error: { message: "Method not allowed" } }); return true; }
    const body = await readJsonBody(req);
    if (!body || body.token !== cfg.adminToken) {
      sendJson(res, 401, { error: { message: "Invalid admin token", type: "auth_error" } });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (!p.startsWith("/admin/api/")) return false;

  const token = req.headers["x-admin-token"];
  if (!token || token !== cfg.adminToken) {
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
      if (patch.historyRetentionDays !== undefined) stats.setRetention(patch.historyRetentionDays);
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

    // ── logs ──
    if (p === "/admin/api/logs" && req.method === "GET") {
      const since = Number(url.searchParams.get("since")) || 0;
      sendJson(res, 200, { logs: logRing.filter((l) => l.ts > since) });
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
      const onLog = (d) => send("log", d);
      emitter.on("quota", onQuota);
      emitter.on("stats", onStats);
      emitter.on("log", onLog);
      const keep = setInterval(() => { try { res.write(": keepalive\n\n"); } catch {} }, 15000);
      req.on("close", () => {
        clearInterval(keep);
        emitter.off("quota", onQuota);
        emitter.off("stats", onStats);
        emitter.off("log", onLog);
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
