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
import { initLogs, attachConsoleCapture } from "./logs.mjs";
import { handleGateway } from "./gateway.mjs";
import { initAdminApi, handleAdmin, isAdminRequestAuthed } from "./adminApi.mjs";
import { flushAllPending } from "./state.mjs";
import { getPersistenceStatus } from "./persistence.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 客户端断连 abort 会让 undici 以 AbortError 拒绝内部 promise；无此守卫时（EMBED_UPSTREAM=0
// 或上游先于守卫注册前的启动窗口）进程会被未处理拒绝打崩。与上游 proxy.mjs 同款兜底。
process.on("unhandledRejection", (reason) => {
  if (reason && (reason.name === "AbortError" || reason.code === "ABORT_ERR")) return;
  console.error("[manager] unhandledRejection:", (reason && reason.message) || String(reason));
});

const cfg = loadConfig();

// 0) 先挂上游日志捕获（早于上游 import：其启动/配置错误日志即刻入环），
//    再回放磁盘历史并接事件总线
attachConsoleCapture();

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
initLogs(emitter, cfg.pool.historyRetentionDays); // 系统日志持久化（events.jsonl），先于其他子系统以捕获启动期日志
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
  const host = req.headers.host || "localhost";
  let url;
  try {
    url = new URL(req.url, "http://" + host);
  } catch {
    sendJson(res, 400, { error: { message: "Bad request" } });
    return;
  }
  const p = url.pathname;
  // M4：CORS 仅放开 /v1/* 代理面（OpenAI/Anthropic SDK 跨域调用场景）；
  // /admin 管理面鉴权走 X-Admin-Token header，无跨域消费方——不再回
  // Access-Control-Allow-Origin: *，防止任意网站跨域读取管理 API 响应
  //（令牌泄露场景下的二次放大）。
  if (p.startsWith("/v1/")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-api-key, x-session-id, x-claude-code-session-id");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
  }
  // P2-7：CSP 仅作用于管理面（/admin 页面、静态资源、/admin/api/*——含 SSE，
  // writeHead 会与 setHeader 初始状态合并故统一在此挂头）。app.mjs 重构为事件委托后
  // 已无内联脚本，script-src 收紧到 'self'；L-j：进度条动态宽度已由内联 style 改为
  // 5% 档位 class，且渲染路径已无任何 style 属性，style-src 随之收紧为 'self'（CSP3
  // 下 style-src 无 'unsafe-inline' 时 style 属性/内联样式一律被浏览器禁止）。
  // connect-src 'self' 覆盖同源 fetch 与 EventSource。
  // /v1/* 为网关代理上游响应，不加（保守：只加 admin 面）。
  if (p === "/admin" || p.startsWith("/admin/")) {
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
  try {
    if (p === "/health") {
      let ok = false;
      try {
        const r = await fetch("http://" + cfg.upstreamHost + ":" + cfg.upstreamPort + "/health", {
          signal: AbortSignal.timeout(3000)
        });
        ok = r.ok;
      } catch {}
      const persistence = getPersistenceStatus();
      if (!persistence.available) {
        res.writeHead(503, {
          "Content-Type": "application/json",
          "X-Persistence-Status": "unavailable"
        });
        res.end(JSON.stringify({
          ok: false,
          upstream: ok,
          persistence: { available: false, error: persistence.error }
        }));
        return;
      }
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
      // L-e：非 API 的 /admin/* 未知路径（handleAdmin 返回 false）也须先鉴权再 404，
      // 否则匿名者可探测管理端路由形状。静态文件（app.mjs/style.css）已在上方精确匹配。
      if (!isAdminRequestAuthed(req, p)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unauthorized", type: "auth_error" } }));
        return;
      }
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

// P2-4：进入即先同步 flush 防抖待写数据（state.json/quota-cache.json），再走优雅
// 关闭。SSE 常连接会让 server.close 回调永不触发——2s 兜底硬退出前数据已落盘。
// 重复信号（连按 Ctrl-C）安全：flushAllPending 对已 flush 的 writer 幂等 no-op。
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log("[manager] received " + sig + ", shutting down");
    flushAllPending();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
