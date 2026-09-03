import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANAGER_ENTRY = resolve(ROOT, "src/server.mjs");
const HOST = "127.0.0.1";
const ADMIN_TOKEN = "admin-body-test-token";
const CLIENT_TOKEN = "client-body-test-token";
const LIMIT = 256 * 1024;
const STARTUP_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 2500;

let manager;
let upstream;
let dataDir;
const rawSockets = new Set();

function errorText(error) {
  return error instanceof Error ? `${error.code ? `${error.code}: ` : ""}${error.message}` : String(error);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("未取得真实监听端口"));
        return;
      }
      resolvePromise(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: HOST, port: 0 });
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function request({ port, path, method = "GET", headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let timer;
    const chunks = [];
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = http.request({ host: HOST, port, path, method, headers, agent: false }, (res) => {
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => finish(resolvePromise, {
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      res.on("aborted", () => finish(reject, new Error(`响应被中止：${method} ${path}`)));
      res.on("error", (error) => finish(reject, error));
    });
    req.on("error", (error) => finish(reject, error));
    timer = setTimeout(() => {
      req.destroy();
      finish(reject, new Error(`请求超时：${method} ${path}`));
    }, timeoutMs);
    timer.unref?.();
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

async function waitForHealth(port) {
  const startedAt = performance.now();
  let lastError = "";
  while (performance.now() - startedAt < STARTUP_TIMEOUT_MS) {
    try {
      const result = await request({ port, path: "/health", timeoutMs: 500 });
      if (result.status === 200 && result.body === "OK") return;
      lastError = `${result.status} ${result.body}`;
    } catch (error) {
      lastError = errorText(error);
    }
    await sleep(50);
  }
  throw new Error(`manager 未启动：${lastError}`);
}

function childExit(child, timeoutMs = 3000) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.off("close", onClose);
      child.off("error", onError);
    };
    const onClose = (code, signal) => {
      cleanup();
      if (code !== 0 || signal) reject(new Error(`manager 退出异常：code=${code} signal=${signal}`));
      else resolvePromise();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    child.once("close", onClose);
    child.once("error", onError);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`manager 未在 ${timeoutMs}ms 内退出`));
    }, timeoutMs);
    timer.unref?.();
  });
}

function startManager(managerPort, upstreamPort, dataPath) {
  const child = spawn(process.execPath, [MANAGER_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataPath,
      PORT: String(managerPort),
      HOST,
      UPSTREAM_HOST: HOST,
      UPSTREAM_PORT: String(upstreamPort),
      EMBED_UPSTREAM: "0",
      ADMIN_TOKEN,
      CLIENT_TOKEN,
      CC_ADMIN_BODY_TIMEOUT_MS: "700",
      CC_ADMIN_BODY_IDLE_TIMEOUT_MS: "150",
      CC_ADMIN_BODY_DRAIN_LIMIT: "8192",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.outputText = () => `${stdout}\n${stderr}`;
  return child;
}

function parseBody(response, label) {
  try {
    return JSON.parse(response.body);
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function rawRequest({ port, head, onConnect }) {
  const startedAt = performance.now();
  let raw = Buffer.alloc(0);
  let headerResult;
  let resolveHeaders;
  let resolveClosed;
  let rejectHeaders;
  const headers = new Promise((resolvePromise, reject) => {
    resolveHeaders = resolvePromise;
    rejectHeaders = reject;
  });
  const closed = new Promise((resolvePromise) => {
    resolveClosed = resolvePromise;
  });
  const socket = net.createConnection({ host: HOST, port });
  rawSockets.add(socket);
  socket.setNoDelay(true);
  socket.on("connect", () => {
    socket.write(head);
    onConnect?.(socket);
  });
  socket.on("data", (chunk) => {
    raw = Buffer.concat([raw, chunk]);
    if (headerResult) return;
    const marker = raw.indexOf("\r\n\r\n");
    if (marker < 0) return;
    const text = raw.subarray(0, marker).toString("latin1");
    const firstLine = text.split("\r\n", 1)[0];
    const match = firstLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/);
    if (!match) {
      rejectHeaders(new Error(`无法解析 HTTP 状态：${firstLine}`));
      return;
    }
    const responseHeaders = {};
    for (const line of text.split("\r\n").slice(1)) {
      const index = line.indexOf(":");
      if (index > 0) responseHeaders[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
    }
    headerResult = { status: Number(match[1]), headers: responseHeaders, ms: Math.round(performance.now() - startedAt) };
    resolveHeaders(headerResult);
  });
  socket.on("error", (error) => {
    if (!headerResult) rejectHeaders(error);
  });
  socket.on("close", () => {
    rawSockets.delete(socket);
    resolveClosed({ ms: Math.round(performance.now() - startedAt), header: headerResult });
  });
  return { socket, headers, closed };
}

async function bounded(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超过 ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function assertHealthy(managerPort, label) {
  await waitForHealth(managerPort);
  console.log(`  PASS ${label} 后 manager 仍健康`);
}

async function main() {
  upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(req.url === "/health" ? 200 : 404, { "Content-Type": "text/plain", Connection: "close" });
    res.end(req.url === "/health" ? "OK" : "not found");
  });
  const upstreamPort = await listen(upstream);
  const managerPortServer = http.createServer();
  const managerPort = await listen(managerPortServer);
  await closeServer(managerPortServer);
  dataDir = mkdtempSync(join(tmpdir(), "ccpm-admin-body-"));
  chmodSync(dataDir, 0o700);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    port: managerPort,
    host: HOST,
    upstreamPort,
    upstreamHost: HOST,
    adminToken: ADMIN_TOKEN,
    clientToken: CLIENT_TOKEN,
    pool: { maxRetries: 0, sameKeyRetryCount: 0, quotaRefreshMs: 3600000 },
  }));
  writeFileSync(join(dataDir, "keys.json"), JSON.stringify({ keys: [] }));
  manager = startManager(managerPort, upstreamPort, dataDir);
  await waitForHealth(managerPort);
  console.log("  PASS manager 真实进程启动");

  const validLogin = await request({
    port: managerPort,
    path: "/admin/api/login",
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify({ token: ADMIN_TOKEN }),
  });
  assert(validLogin.status === 200 && parseBody(validLogin, "正常 login").ok === true, `正常 login 失败：${JSON.stringify(validLogin)}`);
  console.log("  PASS 正常 login 仍为 200");

  const invalidJson = await request({
    port: managerPort,
    path: "/admin/api/keys",
    method: "POST",
    headers: { "X-Admin-Token": ADMIN_TOKEN, "Content-Type": "application/json", Connection: "close" },
    body: "{invalid",
  });
  const invalidPayload = parseBody(invalidJson, "非法 JSON");
  assert(invalidJson.status === 400 && invalidPayload.error?.type === "invalid_request_error" && /合法 JSON/.test(invalidPayload.error.message), `非法 JSON 协议错误异常：${JSON.stringify(invalidJson)}`);
  console.log("  PASS 非法 JSON -> 400 invalid_request_error");

  const oversizedBody = JSON.stringify({ token: ADMIN_TOKEN, padding: "x".repeat(LIMIT) });
  const oversizedLogin = await request({
    port: managerPort,
    path: "/admin/api/login",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(oversizedBody)), Connection: "close" },
    body: oversizedBody,
  });
  const oversizedLoginPayload = parseBody(oversizedLogin, "超大 login");
  assert(oversizedLogin.status === 413 && oversizedLoginPayload.error?.type === "request_too_large" && oversizedLogin.headers.connection === "close", `超大 login 未保留 413：${JSON.stringify(oversizedLogin)}`);
  console.log("  PASS 超大 login -> 413 且 Connection: close");

  const oversizedAdminBody = JSON.stringify({ key: "user_admin_body_test", note: "x".repeat(LIMIT) });
  const oversizedAdmin = await request({
    port: managerPort,
    path: "/admin/api/keys",
    method: "POST",
    headers: { "X-Admin-Token": ADMIN_TOKEN, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(oversizedAdminBody)), Connection: "close" },
    body: oversizedAdminBody,
  });
  const oversizedAdminPayload = parseBody(oversizedAdmin, "超大普通管理 body");
  assert(oversizedAdmin.status === 413 && oversizedAdminPayload.error?.type === "request_too_large" && oversizedAdmin.headers.connection === "close", `超大普通管理 body 未保留 413：${JSON.stringify(oversizedAdmin)}`);
  console.log("  PASS 超大普通管理 body -> 413 且无持久化写入");
  await assertHealthy(managerPort, "超大请求");

  const chunked = rawRequest({
    port: managerPort,
    head: "POST /admin/api/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
    onConnect: (socket) => {
      const chunk = "x".repeat(16384);
      for (let i = 0; i < 18; i++) socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
    },
  });
  const chunkedHeader = await bounded(chunked.headers, 1500, "永不结束 chunked 响应");
  const chunkedClosed = await bounded(chunked.closed, 1800, "永不结束 chunked 断连");
  assert(chunkedHeader.status === 413 && chunkedHeader.headers.connection === "close", `永不结束 chunked 未得到 413/close：${JSON.stringify(chunkedHeader)}`);
  assert(chunkedClosed.ms < 1500, `永不结束 chunked 断连过慢：${JSON.stringify(chunkedClosed)}`);
  console.log(`  PASS 永不结束 chunked -> 413，${chunkedClosed.ms}ms 内断连`);
  await assertHealthy(managerPort, "chunked 超限");

  const slow = rawRequest({
    port: managerPort,
    head: "POST /admin/api/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
    onConnect: (socket) => {
      const interval = setInterval(() => {
        try { socket.write("1\r\nx\r\n"); } catch {}
      }, 60);
      slow.closed.finally(() => clearInterval(interval));
    },
  });
  const slowHeader = await bounded(slow.headers, 1500, "慢速 body 响应");
  const slowClosed = await bounded(slow.closed, 1800, "慢速 body 断连");
  assert(slowHeader.status === 408 && slowHeader.headers.connection === "close", `慢速 body 未得到 408/close：${JSON.stringify(slowHeader)}`);
  assert(slowClosed.ms < 1500, `慢速 body 断连过慢：${JSON.stringify(slowClosed)}`);
  console.log(`  PASS 慢速 body -> 408，${slowClosed.ms}ms 内断连`);
  await assertHealthy(managerPort, "慢速 body");

  const aborted = rawRequest({
    port: managerPort,
    head: "POST /admin/api/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100000\r\nConnection: close\r\n\r\n",
    onConnect: (socket) => {
      socket.write("{");
      setTimeout(() => socket.destroy(), 25).unref?.();
    },
  });
  const abortedClosed = await bounded(aborted.closed, 1200, "客户端中断清理");
  assert(abortedClosed.ms < 1000, `客户端中断清理过慢：${JSON.stringify(abortedClosed)}`);
  console.log(`  PASS 客户端中断在 ${abortedClosed.ms}ms 内清理`);
  await assertHealthy(managerPort, "客户端中断");

  manager.kill("SIGTERM");
  await childExit(manager);
  assert(!manager.outputText().includes("unhandledRejection"), `出现未处理 rejection：${manager.outputText()}`);
  console.log("  PASS manager 正常退出且无 unhandledRejection");
}

try {
  await main();
  console.log("Admin body lifecycle tests: PASS");
} catch (error) {
  console.error(`Admin body lifecycle tests: FAIL\n${error.stack || errorText(error)}`);
  process.exitCode = 1;
} finally {
  for (const socket of [...rawSockets]) {
    try { socket.destroy(); } catch {}
  }
  if (manager && manager.exitCode === null && !manager.signalCode) {
    try { manager.kill("SIGTERM"); } catch {}
    await childExit(manager).catch(() => {
      try { manager.kill("SIGKILL"); } catch {}
    });
  }
  await closeServer(upstream).catch(() => {});
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}
