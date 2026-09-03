import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANAGER_ENTRY = resolve(ROOT, "src/server.mjs");
const MOCK_ENTRY = resolve(ROOT, "scripts/mock-upstream.mjs");
const HOST = "127.0.0.1";
const ADMIN_TOKEN = "lifecycle-admin-token";
const CLIENT_TOKEN = "lifecycle-client-token";
const TEST_KEY = "user_lifecycle_key";
const STARTUP_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 15000;
const EXIT_MARGIN_MS = 3000;

const children = new Set();
const clients = new Set();

function errorText(error) {
  return error instanceof Error ? `${error.code ? `${error.code}: ` : ""}${error.message}` : String(error);
}

function isExpectedForceDisconnect(error) {
  const code = error?.code;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return code === "ECONNRESET"
    || code === "ECONNABORTED"
    || /\b(?:ECONNRESET|ECONNABORTED)\b/.test(message)
    || /socket hang up/i.test(message);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function rememberClient(client) {
  clients.add(client);
  const forget = () => clients.delete(client);
  client.once("close", forget);
  client.once("error", forget);
  return client;
}

function spawnNode(args, env = {}) {
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`环境不支持启动真实 Node 子进程：${errorText(error)}`);
  }
  children.add(child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdoutText = "";
  child.stderrText = "";
  child.stdout.on("data", (chunk) => { child.stdoutText += chunk; });
  child.stderr.on("data", (chunk) => { child.stderrText += chunk; });
  child.once("close", () => children.delete(child));
  return child;
}

function childOutput(child) {
  return `${child.stdoutText || ""}\n${child.stderrText || ""}`;
}

function waitForClose(child, timeoutMs, label) {
  if (child.exitCode !== null || child.signalCode) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, reject) => {
    let timer;
    const finish = (result) => {
      clearTimeout(timer);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      resolvePromise(result);
    };
    const onClose = (code, signal) => finish({ code, signal });
    const onError = (error) => {
      clearTimeout(timer);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      reject(new Error(`${label} 子进程错误：${errorText(error)}`));
    };
    child.once("close", onClose);
    child.once("error", onError);
    timer = setTimeout(() => {
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      reject(new Error(`${label} 未在 ${timeoutMs}ms 内退出\n${childOutput(child)}`));
    }, timeoutMs);
    timer.unref?.();
  });
}

async function stopChild(child, label) {
  if (!child || (child.exitCode !== null && child.exitCode !== undefined) || child.signalCode) return;
  try { child.kill("SIGTERM"); } catch {}
  try {
    await waitForClose(child, 2000, label);
  } catch {
    try { child.kill("SIGKILL"); } catch {}
    await waitForClose(child, 1000, `${label} SIGKILL`).catch(() => {});
  }
}

function listenServer(server, port = 0) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      server.removeListener("listening", onListening);
      reject(new Error(`环境不支持真实网络 socket 测试：${errorText(error)}`));
    };
    const onListening = () => {
      if (settled) return;
      settled = true;
      server.removeListener("error", fail);
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("真实网络 socket 测试未取得动态端口"));
        return;
      }
      resolvePromise({ server, port: address.port });
    };
    server.once("error", fail);
    server.once("listening", onListening);
    try {
      server.listen({ host: HOST, port });
    } catch (error) {
      fail(error);
    }
  });
}

async function reservePort() {
  const result = await listenServer(net.createServer(), 0);
  await new Promise((resolvePromise, reject) => result.server.close((error) => error ? reject(error) : resolvePromise()));
  return result.port;
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  await new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function requestOnce({ port, path, method = "GET", headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolvePromise, reject) => {
    const startedAt = performance.now();
    let settled = false;
    let timer;
    let response;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = rememberClient(http.request({
      host: HOST,
      port,
      path,
      method,
      headers,
      agent: false,
    }, (res) => {
      response = res;
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => finish(resolvePromise, {
        outcome: "end",
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        ms: Math.round(performance.now() - startedAt),
      }));
      res.on("aborted", () => finish(resolvePromise, {
        outcome: "aborted",
        status: res.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
        ms: Math.round(performance.now() - startedAt),
      }));
      res.on("error", (error) => finish(resolvePromise, {
        outcome: `response-error:${error.code || error.message}`,
        status: res.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
        ms: Math.round(performance.now() - startedAt),
      }));
    }));
    req.on("error", (error) => finish(resolvePromise, {
      outcome: `request-error:${error.code || error.message}`,
      ms: Math.round(performance.now() - startedAt),
    }));
    timer = setTimeout(() => {
      try { response?.destroy(); } catch {}
      try { req.destroy(); } catch {}
      finish(reject, new Error(`HTTP ${method} ${path} 超时 ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function openActiveRequest({ port, path, method = "GET", headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const startedAt = performance.now();
  let response;
  let responseBody = [];
  let settled = false;
  let timer;
  let resolveReady;
  let rejectReady;
  let resolveDone;
  const ready = new Promise((resolvePromise, reject) => {
    resolveReady = resolvePromise;
    rejectReady = reject;
  });
  const done = new Promise((resolvePromise) => { resolveDone = resolvePromise; });
  const result = {
    ready,
    done,
    request: null,
    response: null,
    get body() { return Buffer.concat(responseBody).toString("utf8"); },
  };
  const finish = (outcome, error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) rejectReady(error);
    resolveDone({
      outcome,
      status: response?.statusCode,
      body: Buffer.concat(responseBody).toString("utf8"),
      ms: Math.round(performance.now() - startedAt),
      error: error ? errorText(error) : undefined,
    });
  };
  const req = rememberClient(http.request({
    host: HOST,
    port,
    path,
    method,
    headers,
    agent: false,
  }, (res) => {
    response = res;
    result.response = res;
    res.on("data", (chunk) => responseBody.push(chunk));
    res.on("end", () => finish("end"));
    res.on("aborted", () => finish("aborted"));
    res.on("error", (error) => finish(`response-error:${error.code || error.message}`, error));
    resolveReady(res);
  }));
  result.request = req;
  req.on("error", (error) => finish(`request-error:${error.code || error.message}`, error));
  req.on("close", () => {
    if (!settled && !response) finish("request-close");
  });
  timer = setTimeout(() => {
    try { response?.destroy(); } catch {}
    try { req.destroy(); } catch {}
    finish("timeout", new Error(`HTTP ${method} ${path} 超时 ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  if (body !== undefined) req.write(body);
  req.end();
  return result;
}

function waitForResponseText(active, text, label, timeoutMs = 3000) {
  if (active.body.includes(text)) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} 未收到 ${JSON.stringify(text)}`));
    }, timeoutMs);
    const onData = () => {
      if (!active.body.includes(text)) return;
      cleanup();
      resolvePromise();
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`${label} 在收到 ${JSON.stringify(text)} 前连接关闭`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      active.response?.off("data", onData);
      active.response?.off("close", onClose);
    };
    active.response?.on("data", onData);
    active.response?.once("close", onClose);
  });
}

async function waitForHttp(port, path, predicate, label) {
  const startedAt = performance.now();
  let lastError = "";
  while (performance.now() - startedAt < STARTUP_TIMEOUT_MS) {
    try {
      const response = await requestOnce({ port, path, timeoutMs: 1000 });
      if (predicate(response)) return response;
      lastError = `${response.status} ${response.body}`;
    } catch (error) {
      lastError = errorText(error);
    }
    await sleep(75);
  }
  throw new Error(`${label} 未在 ${STARTUP_TIMEOUT_MS}ms 内可用：${lastError}`);
}

async function waitForMockCall(mockPort, mode, label) {
  return waitForHttp(mockPort, "/__calls", (response) => {
    if (response.status !== 200) return false;
    try {
      const calls = JSON.parse(response.body).calls;
      return Array.isArray(calls) && calls.some((call) => call.mode === mode && call.auth === TEST_KEY);
    } catch {
      return false;
    }
  }, label);
}

async function configureMock(mockPort, response) {
  const result = await requestOnce({
    port: mockPort,
    path: "/__control",
    method: "POST",
    headers: { "Content-Type": "application/json", "Connection": "close" },
    body: JSON.stringify({ auth: TEST_KEY, responses: [response] }),
  });
  if (result.outcome !== "end" || result.status !== 200) {
    throw new Error(`mock 配置失败：${JSON.stringify(result)}`);
  }
}

function makeDataDir(port, upstreamPort) {
  const dataDir = mkdtempSync(join(tmpdir(), "ccpm-lifecycle-data-"));
  chmodSync(dataDir, 0o700);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    port,
    host: HOST,
    upstreamPort,
    upstreamHost: HOST,
    adminToken: ADMIN_TOKEN,
    clientToken: CLIENT_TOKEN,
    pool: {
      maxRetries: 0,
      sameKeyRetryCount: 0,
      quotaRefreshMs: 3600000,
    },
  }));
  writeFileSync(join(dataDir, "keys.json"), JSON.stringify({
    keys: [{
      id: "lifecycle-key",
      key: TEST_KEY,
      alias: "lifecycle",
      enabled: true,
      priority: 0,
      createdAt: Date.now(),
    }],
  }));
  return dataDir;
}

function managerEnv(dataDir, managerPort, upstreamPort, embedded, graceMs, forceWaitMs, mockPort) {
  return {
    DATA_DIR: dataDir,
    PORT: String(managerPort),
    HOST,
    UPSTREAM_HOST: HOST,
    UPSTREAM_PORT: String(upstreamPort),
    EMBED_UPSTREAM: embedded ? "1" : "0",
    ADMIN_TOKEN,
    CLIENT_TOKEN,
    CC_QUOTA_BASE: `http://${HOST}:${mockPort}`,
    CC_SHUTDOWN_GRACE_MS: String(graceMs),
    CC_SHUTDOWN_FORCE_WAIT_MS: String(forceWaitMs),
  };
}

async function startMock(mockPort) {
  const child = spawnNode([MOCK_ENTRY], {
    MOCK_HOST: HOST,
    MOCK_PORT: String(mockPort),
    MOCK_QUOTA_LATENCY: "10",
  });
  await waitForHttp(mockPort, "/health", (response) => response.status === 200 && response.body === "OK", "mock upstream");
  return child;
}

async function assertPortsFree(ports, label) {
  for (const port of ports) {
    const result = await listenServer(net.createServer(), port).catch((error) => {
      throw new Error(`${label} 后端口 ${port} 仍被占用：${errorText(error)}`);
    });
    await closeServer(result.server);
  }
}

async function expectStartupConflict({ kind, managerPort, blockedPort, mockPort, embedded }) {
  const blocker = await listenServer(net.createServer(), blockedPort);
  const dataDir = makeDataDir(managerPort, blockedPort);
  let child;
  try {
    child = spawnNode([MANAGER_ENTRY], managerEnv(
      dataDir,
      managerPort,
      blockedPort,
      embedded,
      250,
      250,
      mockPort,
    ));
    const result = await waitForClose(child, 5000, `${kind} 冲突`);
    const output = childOutput(child);
    if (result.code === 0 || result.signal) throw new Error(`${kind} 冲突未以非零退出：${JSON.stringify(result)}\n${output}`);
    if (!output.includes("EADDRINUSE")) throw new Error(`${kind} 冲突缺少 EADDRINUSE 诊断：\n${output}`);
    const diagnostic = embedded ? "embedded upstream startup failed" : "startup failed";
    if (!output.includes(diagnostic)) throw new Error(`${kind} 冲突缺少启动诊断 ${diagnostic}：\n${output}`);
    console.log(`  PASS ${kind} 真实端口冲突 -> code=${result.code}, EADDRINUSE/startup diagnostic`);
  } finally {
    await stopChild(child, `${kind} 冲突清理`);
    await closeServer(blocker.server);
    rmSync(dataDir, { recursive: true, force: true });
  }
  await assertPortsFree([managerPort, blockedPort], `${kind} 冲突清理`);
}

async function runGracefulNormal(mockPort) {
  const managerPort = await reservePort();
  const upstreamPort = await reservePort();
  const dataDir = makeDataDir(managerPort, mockPort);
  const graceMs = 1200;
  const forceWaitMs = 250;
  let manager;
  let active;
  try {
    manager = spawnNode([MANAGER_ENTRY], managerEnv(dataDir, managerPort, mockPort, false, graceMs, forceWaitMs, mockPort));
    await waitForHttp(managerPort, "/health", (response) => response.status === 200 && response.body === "OK", "manager normal startup");
    await configureMock(mockPort, { mode: "delay", delayMs: 250 });
    active = openActiveRequest({
      port: managerPort,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CLIENT_TOKEN}`,
        Connection: "close",
      },
      body: JSON.stringify({ model: "lifecycle-normal", stream: false }),
    });
    await waitForMockCall(mockPort, "delay", "普通活动请求到达 mock");
    const signalAt = performance.now();
    manager.kill("SIGTERM");
    const [response, exit] = await Promise.all([
      active.done,
      waitForClose(manager, graceMs + forceWaitMs + EXIT_MARGIN_MS, "普通活动请求 manager"),
    ]);
    if (response.outcome !== "end" || response.status !== 200 || !response.body.includes("slow-ok")) {
      throw new Error(`SIGTERM 未完成普通活动请求：${JSON.stringify(response)}\n${childOutput(manager)}`);
    }
    if (exit.code !== 0 || exit.signal) throw new Error(`普通活动请求退出异常：${JSON.stringify(exit)}\n${childOutput(manager)}`);
    if (response.ms < 150) throw new Error(`普通活动请求疑似未等待上游完成：${JSON.stringify(response)}`);
    console.log(`  PASS SIGTERM 普通请求完整返回 (${response.ms}ms; child ${Math.round(performance.now() - signalAt)}ms)`);
  } finally {
    try { active?.request?.destroy(); } catch {}
    await stopChild(manager, "普通活动请求清理");
    rmSync(dataDir, { recursive: true, force: true });
  }
  await assertPortsFree([managerPort, upstreamPort], "普通活动请求清理");
}

async function runGracefulStream(mockPort) {
  const managerPort = await reservePort();
  const upstreamPort = await reservePort();
  const dataDir = makeDataDir(managerPort, mockPort);
  const graceMs = 1500;
  const forceWaitMs = 250;
  let manager;
  let active;
  try {
    manager = spawnNode([MANAGER_ENTRY], managerEnv(dataDir, managerPort, mockPort, false, graceMs, forceWaitMs, mockPort));
    await waitForHttp(managerPort, "/health", (response) => response.status === 200 && response.body === "OK", "manager stream startup");
    await configureMock(mockPort, { mode: "slowsse", frameDelayMs: 25 });
    active = openActiveRequest({
      port: managerPort,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CLIENT_TOKEN}`,
        Connection: "close",
      },
      body: JSON.stringify({ model: "lifecycle-stream", stream: true }),
    });
    const response = await active.ready;
    if (response.statusCode !== 200 || !String(response.headers["content-type"]).includes("text/event-stream")) {
      throw new Error(`流式响应头异常：${response.statusCode} ${JSON.stringify(response.headers)}`);
    }
    await waitForResponseText(active, "data:", "流式响应");
    const signalAt = performance.now();
    manager.kill("SIGTERM");
    const [result, exit] = await Promise.all([
      active.done,
      waitForClose(manager, graceMs + forceWaitMs + EXIT_MARGIN_MS, "流式活动请求 manager"),
    ]);
    try { active.response?.socket?.destroy(); } catch {}
    if (result.outcome !== "end" || !result.body.includes("data: [DONE]")) {
      throw new Error(`SIGTERM 未完整结束流式响应：${JSON.stringify(result)}\n${childOutput(manager)}`);
    }
    if (exit.code !== 0 || exit.signal) throw new Error(`流式活动请求退出异常：${JSON.stringify(exit)}\n${childOutput(manager)}`);
    console.log(`  PASS SIGTERM 流式响应完整结束 (${result.ms}ms; child ${Math.round(performance.now() - signalAt)}ms)`);
  } finally {
    try { active?.request?.destroy(); } catch {}
    try { active?.response?.socket?.destroy(); } catch {}
    await stopChild(manager, "流式活动请求清理");
    rmSync(dataDir, { recursive: true, force: true });
  }
  await assertPortsFree([managerPort, upstreamPort], "流式活动请求清理");
}

async function runSseForceClose(mockPort) {
  const managerPort = await reservePort();
  const upstreamPort = await reservePort();
  const dataDir = makeDataDir(managerPort, mockPort);
  const graceMs = 180;
  const forceWaitMs = 220;
  let manager;
  let active;
  try {
    manager = spawnNode([MANAGER_ENTRY], managerEnv(dataDir, managerPort, mockPort, false, graceMs, forceWaitMs, mockPort));
    await waitForHttp(managerPort, "/health", (response) => response.status === 200 && response.body === "OK", "manager SSE startup");
    active = openActiveRequest({
      port: managerPort,
      path: "/admin/api/events",
      headers: {
        "X-Admin-Token": ADMIN_TOKEN,
        Accept: "text/event-stream",
        Connection: "keep-alive",
      },
    });
    const response = await active.ready;
    if (response.statusCode !== 200 || !String(response.headers["content-type"]).includes("text/event-stream")) {
      throw new Error(`SSE 响应头异常：${response.statusCode} ${JSON.stringify(response.headers)}`);
    }
    await waitForResponseText(active, ": connected", "SSE");
    const signalAt = performance.now();
    manager.kill("SIGTERM");
    const [result, exit] = await Promise.all([
      active.done,
      waitForClose(manager, graceMs + forceWaitMs + EXIT_MARGIN_MS, "SSE manager"),
    ]);
    if (result.outcome === "end") throw new Error(`SSE 在 SIGTERM 后正常 end，未验证强制关闭：${JSON.stringify(result)}`);
    if (exit.code !== 0 || exit.signal) throw new Error(`SSE 关闭退出异常：${JSON.stringify(exit)}\n${childOutput(manager)}`);
    if (result.ms > graceMs + forceWaitMs + EXIT_MARGIN_MS) throw new Error(`SSE 强制关闭超出有界时间：${JSON.stringify(result)}`);
    console.log(`  PASS SIGTERM SSE/保持连接被强制关闭 (${result.outcome}, ${result.ms}ms; child ${Math.round(performance.now() - signalAt)}ms)`);
  } finally {
    try { active?.request?.destroy(); } catch {}
    try { active?.response?.socket?.destroy(); } catch {}
    await stopChild(manager, "SSE 清理");
    rmSync(dataDir, { recursive: true, force: true });
  }
  await assertPortsFree([managerPort, upstreamPort], "SSE 清理");
}

async function runForceDestroy(mockPort) {
  const managerPort = await reservePort();
  const upstreamPort = await reservePort();
  const dataDir = makeDataDir(managerPort, mockPort);
  const graceMs = 180;
  const forceWaitMs = 220;
  let manager;
  let active;
  try {
    manager = spawnNode([MANAGER_ENTRY], managerEnv(dataDir, managerPort, mockPort, false, graceMs, forceWaitMs, mockPort));
    await waitForHttp(managerPort, "/health", (response) => response.status === 200 && response.body === "OK", "manager force startup");
    await configureMock(mockPort, { mode: "hang" });
    active = openActiveRequest({
      port: managerPort,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CLIENT_TOKEN}`,
        Connection: "close",
      },
      body: JSON.stringify({ model: "lifecycle-force", stream: false }),
    });
    // A force-destroy can reject readiness before response headers exist. Consume it
    // here so the expected transport reset is checked below instead of becoming an
    // unhandled rejection.
    const readiness = active.ready.then(
      (response) => ({ kind: "response", response }),
      (error) => ({ kind: "error", error }),
    );
    await waitForMockCall(mockPort, "hang", "强制关闭活动请求到达 mock");
    const signalAt = performance.now();
    manager.kill("SIGTERM");
    const [result, exit, readyState] = await Promise.all([
      active.done,
      waitForClose(manager, graceMs + forceWaitMs + EXIT_MARGIN_MS, "强制关闭 manager"),
      readiness,
    ]);
    if (result.outcome === "end") throw new Error(`挂起普通请求未被强制关闭：${JSON.stringify(result)}`);
    if (exit.code !== 0 || exit.signal) throw new Error(`强制关闭退出异常：${JSON.stringify(exit)}\n${childOutput(manager)}`);
    if (result.ms > graceMs + forceWaitMs + EXIT_MARGIN_MS) throw new Error(`强制关闭超出有界时间：${JSON.stringify(result)}`);
    if (readyState.kind === "error" && !isExpectedForceDisconnect(readyState.error)) {
      throw new Error(`强制关闭收到非预期 readiness 错误：${errorText(readyState.error)}\n${childOutput(manager)}`);
    }
    if (result.error && !isExpectedForceDisconnect(result.error)) {
      throw new Error(`强制关闭收到非预期连接错误：${result.error}\n${childOutput(manager)}`);
    }
    const disconnectedOutcomes = new Set(["aborted", "request-close"]);
    const erroredOutcome = result.outcome.startsWith("request-error:")
      || result.outcome.startsWith("response-error:");
    if (!disconnectedOutcomes.has(result.outcome) && !erroredOutcome) {
      throw new Error(`强制关闭未得到可验证的断连结果：${JSON.stringify(result)}\n${childOutput(manager)}`);
    }
    if (!active.request?.destroyed || (active.response && !active.response.socket?.destroyed)) {
      throw new Error(`强制关闭后客户端连接仍未销毁：${JSON.stringify({
        outcome: result.outcome,
        requestDestroyed: active.request?.destroyed,
        responseSocketDestroyed: active.response?.socket?.destroyed,
      })}`);
    }
    console.log(`  PASS grace 超时强制销毁普通活动请求 (${result.outcome}, ${result.ms}ms; child ${Math.round(performance.now() - signalAt)}ms)`);
  } finally {
    try { active?.request?.destroy(); } catch {}
    try { active?.response?.socket?.destroy(); } catch {}
    await stopChild(manager, "强制关闭清理");
    rmSync(dataDir, { recursive: true, force: true });
  }
  await assertPortsFree([managerPort, upstreamPort], "强制关闭清理");
}

async function main() {
  const mockPort = await reservePort();
  let mock;
  let managerConflictPort;
  let embeddedConflictManagerPort;
  let embeddedConflictUpstreamPort;
  try {
    mock = await startMock(mockPort);

    managerConflictPort = await reservePort();
    await expectStartupConflict({
      kind: "manager",
      managerPort: managerConflictPort,
      blockedPort: managerConflictPort,
      mockPort,
      embedded: false,
    });

    embeddedConflictManagerPort = await reservePort();
    embeddedConflictUpstreamPort = await reservePort();
    await expectStartupConflict({
      kind: "embedded upstream",
      managerPort: embeddedConflictManagerPort,
      blockedPort: embeddedConflictUpstreamPort,
      mockPort,
      embedded: true,
    });

    await runGracefulNormal(mockPort);
    await runGracefulStream(mockPort);
    await runSseForceClose(mockPort);
    await runForceDestroy(mockPort);
    console.log("Lifecycle process tests: PASS");
  } finally {
    for (const client of [...clients]) {
      try { client.destroy(); } catch {}
    }
    for (const child of [...children]) await stopChild(child, "未清理子进程");
    await stopChild(mock, "mock upstream");
    for (const p of [mockPort, managerConflictPort, embeddedConflictManagerPort, embeddedConflictUpstreamPort]) {
      if (p) await assertPortsFree([p], "最终清理").catch((error) => {
        console.error(`最终清理端口检查失败：${errorText(error)}`);
      });
    }
  }
}

main().catch((error) => {
  console.error(`Lifecycle process tests: FAIL\n${error.stack || errorText(error)}`);
  process.exitCode = 1;
});
