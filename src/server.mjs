// NP-00 架构契约：
// - upstream/proxy.mjs 始终是上游原始发布文件。托管模式由 manager 以独立 Node 子进程
//   启动原始入口（cwd=upstream，直接 server.listen），不得 import、注入 loader 或改写源码。
// - EMBED_UPSTREAM=1 或未设置表示托管模式：先捕获上游 stdout/stderr，再以
//   HOST=127.0.0.1、PORT=cfg.upstreamPort 启动子进程；等待上游 GET /health 返回 2xx
//   后，manager 才监听 cfg.host:cfg.port。上游 /health 的原始响应为 200 text/plain OK。
// - EMBED_UPSTREAM=0 表示外置模式：绝不创建上游子进程，manager/gateway 继续连接
//   cfg.upstreamHost:cfg.upstreamPort；manager /health 保持现有 OK、UPSTREAM_DOWN 和
//   持久化不可用响应语义。托管模式的 manager /health 仍只在上游就绪后对外可用。
// - 启动超时、上游提前退出或 manager 监听失败均为启动失败：保留近期上游诊断日志，
//   回收已启动的子进程并以非零状态退出。manager 运行期间上游异常退出只触发一次
//   manager 关闭，同样以非零状态退出；不得留下孤儿进程。
// - SIGTERM/SIGINT 由 manager（容器 PID 1）处理：先停止接收请求并排空 manager，
//   再停止托管上游；停止动作幂等，SIGTERM 超时后对仍存活的子进程使用 SIGKILL。
//   外置模式不执行子进程停止，重复信号不得产生未处理 rejection。
// - 初始化并发/重试和版本刷新由上游原始版本负责；manager 不复制这些补丁语义，
//   同步阶段也不应把本地逻辑写回 upstream/proxy.mjs。
// ── 入口：加载配置 → 初始化日志和管理状态 → 启动/监管上游 → 启动管理网关 ──
import http from "http";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";
import { loadConfig, getConfig, setRuntimeUpstreamHost, DATA_DIR } from "./config.mjs";
import * as pool from "./keyPool.mjs";
import * as quota from "./quota.mjs";
import { initStats, usageProviderForPool } from "./stats.mjs";
import { initLogs, attachConsoleCapture } from "./logs.mjs";
import { handleGateway } from "./gateway.mjs";
import { initAdminApi, handleAdmin, isAdminRequestAuthed } from "./adminApi.mjs";
import { flushAllPending } from "./state.mjs";
import { getPersistenceStatus } from "./persistence.mjs";
import { createServerLifecycle } from "./serverLifecycle.mjs";
import {
  startUpstream,
  DEFAULT_UPSTREAM_STARTUP_TIMEOUT_MS,
  DEFAULT_UPSTREAM_SHUTDOWN_TIMEOUT_MS,
} from "./upstreamProcess.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 客户端断连 abort 会让 undici 以 AbortError 拒绝内部 promise；无此守卫时（EMBED_UPSTREAM=0
// 或上游先于守卫注册前的启动窗口）进程会被未处理拒绝打崩。与上游 proxy.mjs 同款兜底。
process.on("unhandledRejection", (reason) => {
  if (reason && (reason.name === "AbortError" || reason.code === "ABORT_ERR")) return;
  console.error("[manager] unhandledRejection:", (reason && reason.message) || String(reason));
});

const hostedUpstream = process.env.EMBED_UPSTREAM !== "0";
const LOOPBACK_HOST = "127.0.0.1";
const UPSTREAM_TIMEOUT_MIN_MS = 0;
const UPSTREAM_TIMEOUT_MAX_MS = 120_000;

function readUpstreamTimeout(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`[manager] ${name} must be an integer in ${UPSTREAM_TIMEOUT_MIN_MS}..${UPSTREAM_TIMEOUT_MAX_MS}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < UPSTREAM_TIMEOUT_MIN_MS || value > UPSTREAM_TIMEOUT_MAX_MS) {
    throw new Error(`[manager] ${name} must be an integer in ${UPSTREAM_TIMEOUT_MIN_MS}..${UPSTREAM_TIMEOUT_MAX_MS}`);
  }
  return value;
}

const upstreamStartupTimeoutMs = readUpstreamTimeout(
  "CC_UPSTREAM_STARTUP_TIMEOUT_MS",
  DEFAULT_UPSTREAM_STARTUP_TIMEOUT_MS,
);
const upstreamShutdownTimeoutMs = readUpstreamTimeout(
  "CC_UPSTREAM_SHUTDOWN_TIMEOUT_MS",
  DEFAULT_UPSTREAM_SHUTDOWN_TIMEOUT_MS,
);

loadConfig();
if (hostedUpstream) setRuntimeUpstreamHost(LOOPBACK_HOST);
const cfg = getConfig();

// 0) 先挂上游日志捕获（早于托管子进程启动），再回放磁盘历史并接事件总线。
attachConsoleCapture();

// 1) 子系统必须在托管上游启动前完成，确保其启动输出可以立即持久化。
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

function sendJson(res, status, data, extraHeaders) {
  if (res.writableEnded || res.destroyed) return false;
  const headers = { "Content-Type": "application/json" };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
  return true;
}

function closeRequestAfterError(res, error) {
  if (typeof error?.closeRequest !== "function") return;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    res.off("finish", close);
    res.off("close", close);
    error.closeRequest();
  };
  if (res.writableEnded || res.destroyed) close();
  else {
    res.once("finish", close);
    res.once("close", close);
  }
}

function sendError(res, error) {
  const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
    ? error.statusCode
    : 500;
  const type = error?.errorType || (status >= 500 ? "internal_error" : "invalid_request_error");
  closeRequestAfterError(res, error);
  sendJson(res, status, {
    error: { message: error?.message || "请求处理失败", type }
  }, error?.closeRequest ? { Connection: "close" } : undefined);
}

const server = http.createServer(async (req, res) => {
  if (managerLifecycle.isClosing()) {
    res.setHeader("Connection", "close");
    sendJson(res, 503, { error: { message: "Server is shutting down", type: "server_shutdown" } });
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
    sendError(res, e);
  }
});

const managerLifecycle = createServerLifecycle(server, { label: "manager" });

let upstreamRuntime = null;
let shutdownPromise = null;
let shutdownRequested = false;

function upstreamUnexpectedExit(info) {
  const error = info?.error;
  console.error(`[manager] upstream exited unexpectedly: ${error?.message || "unknown upstream exit"}`);
  return shutdown(1, "upstream exited unexpectedly");
}

function shutdown(exitCode = 0, reason = "signal") {
  if (shutdownPromise) return shutdownPromise;
  shutdownRequested = true;
  shutdownPromise = (async () => {
    let finalExitCode = exitCode;
    console.log(`[manager] shutdown started (${reason})`);
    // Flush before closing listeners so writes triggered by the signal are
    // durable before the process can be forced out.
    flushAllPending();
    try {
      // Close the public gateway first. Active gateway requests may still be
      // using the hosted upstream, so the child is stopped only after the
      // manager has drained or force-terminated those requests.
      await managerLifecycle.close();
      if (upstreamRuntime) await upstreamRuntime.stop({ reason });
    } catch (e) {
      finalExitCode = 1;
      console.error(`[manager] shutdown cleanup failed: ${e.message}`);
    }
    flushAllPending();
    process.exitCode = finalExitCode;
    process.exit(finalExitCode);
  })();
  shutdownPromise.catch(() => {});
  return shutdownPromise;
}

function onManagerListening() {
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
}

// Stop accepting requests first, then let active work finish within the
// lifecycle controller's finite grace period. A second signal is harmless.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    if (shutdownPromise) {
      console.log(`[manager] received ${sig}; shutdown already in progress`);
      return;
    }
    console.log("[manager] received " + sig + ", shutting down");
    shutdown(0, sig).catch((e) => {
      console.error(`[manager] shutdown failed: ${e.message}`);
      process.exit(1);
    });
  });
}

async function bootstrap() {
  if (hostedUpstream) {
    upstreamRuntime = startUpstream({
      command: process.execPath,
      args: ["proxy.mjs"],
      cwd: resolve(__dirname, "..", "upstream"),
      host: LOOPBACK_HOST,
      port: cfg.upstreamPort,
      startupTimeoutMs: upstreamStartupTimeoutMs,
      shutdownTimeoutMs: upstreamShutdownTimeoutMs,
      onUnexpectedExit: upstreamUnexpectedExit,
    });
    await upstreamRuntime.ready;
  }
  if (shutdownRequested) return;

  await managerLifecycle.listen(cfg.port, cfg.host, onManagerListening);
}

// Keep startup asynchronous without leaving a top-level await window in which
// a signal or an early child exit can observe uninitialized shutdown state.
void bootstrap().catch((error) => {
  if (shutdownRequested) return;
  const phase = error?.code === "UPSTREAM_PROCESS_ERROR" ? "upstream" : "manager";
  console.error(`[manager] ${phase} startup failed: ${error?.code || "ERROR"} ${error?.message || String(error)}`);
  shutdown(1, `${phase} startup failure`).catch(() => process.exit(1));
});
