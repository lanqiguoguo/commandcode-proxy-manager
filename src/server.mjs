// ── 入口：加载配置 → 同进程嵌入上游代理 → 启动管理网关 ──
import http from "http";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";
import { loadConfig, getConfig, DATA_DIR } from "./config.mjs";
import * as pool from "./keyPool.mjs";
import * as quota from "./quota.mjs";
import { initStats, usageProviderForPool } from "./stats.mjs";
import { handleGateway } from "./gateway.mjs";
import { initAdminApi, handleAdmin } from "./adminApi.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();

// 1) 启动上游（vendored，同进程动态 import，零改动）
//    EMBED_UPSTREAM=0 时不嵌入（便于独立部署上游/测试，转发仍走 UPSTREAM_HOST:UPSTREAM_PORT）
if (process.env.EMBED_UPSTREAM !== "0") {
  process.env.PORT = String(cfg.upstreamPort);
  process.env.HOST = cfg.upstreamHost;
  await import(resolve(__dirname, "..", "upstream", "proxy.mjs"));
}

// 2) 子系统
const emitter = new EventEmitter();
initStats(emitter, cfg.pool.historyRetentionDays);
pool.initKeyPool(cfg.pool, { emitter });
pool.setUsageProvider(usageProviderForPool());
quota.initQuota(pool, cfg.pool, { emitter });
initAdminApi(emitter);

// 3) 静态前端（web/，启动时缓存）
const webDir = resolve(__dirname, "..", "web");
const staticFiles = {};
for (const n of ["index.html", "app.mjs", "style.css"]) {
  const p = resolve(webDir, n);
  if (existsSync(p)) staticFiles[n] = readFileSync(p);
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const host = req.headers.host || "localhost";
  let url;
  try {
    url = new URL(req.url, "http://" + host);
  } catch {
    sendJson(res, 400, { error: { message: "Bad request" } });
    return;
  }
  const p = url.pathname;
  try {
    if (p === "/health") {
      let ok = false;
      try {
        const r = await fetch("http://" + cfg.upstreamHost + ":" + cfg.upstreamPort + "/health", {
          signal: AbortSignal.timeout(3000)
        });
        ok = r.ok;
      } catch {}
      res.writeHead(ok ? 200 : 502, { "Content-Type": "text/plain" });
      res.end(ok ? "OK" : "UPSTREAM_DOWN");
      return;
    }
    if (p === "/") {
      res.writeHead(302, { Location: "/admin" });
      res.end();
      return;
    }
    if (p === "/admin" || p === "/admin/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(staticFiles["index.html"] || "admin ui missing");
      return;
    }
    if (p === "/admin/app.mjs") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      res.end(staticFiles["app.mjs"]);
      return;
    }
    if (p === "/admin/style.css") {
      res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
      res.end(staticFiles["style.css"]);
      return;
    }
    if (p.startsWith("/admin/")) {
      if (await handleAdmin(req, res, url)) return;
      sendJson(res, 404, { error: { message: "Not found", type: "not_found" } });
      return;
    }
    if (p === "/v1/chat/completions" || p === "/v1/messages" || p === "/v1/models") {
      await handleGateway(req, res, url);
      return;
    }
    sendJson(res, 404, { error: { message: "Not found", type: "not_found" } });
  } catch (e) {
    sendJson(res, 500, { error: { message: e.message, type: "internal_error" } });
  }
});

server.listen(cfg.port, cfg.host, () => {
  console.log("[manager] CC Proxy Manager started: http://" + cfg.host + ":" + cfg.port);
  console.log("[manager] admin UI: http://" + cfg.host + ":" + cfg.port + "/admin");
  console.log("[manager] data dir: " + DATA_DIR);
  let upstreamVer = "unknown";
  try {
    const p = resolve(__dirname, "..", "UPSTREAM_VERSION");
    if (existsSync(p)) upstreamVer = readFileSync(p, "utf-8").trim();
  } catch {}
  console.log("[manager] bundled upstream: " + upstreamVer);
  console.log("[manager] keys in pool: " + pool.listKeys().length);
  if (pool.listKeys().length) {
    quota.refreshAll().catch(() => {});
  }
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log("[manager] received " + sig + ", shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
