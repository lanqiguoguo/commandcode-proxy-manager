import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
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
const STARTUP_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 8_000;
const CHILD_EXIT_TIMEOUT_MS = 8_000;
const SERVER_CLOSE_TIMEOUT_MS = 3_000;
const OUTPUT_LIMIT = 48 * 1024;

const liveChildren = new Set();
const knownChildren = new Set();
const clients = new Set();

function errorText(error) {
  if (error instanceof Error) return `${error.code ? `${error.code}: ` : ""}${error.message}`;
  return String(error);
}

function assertCondition(condition, message) {
  assert.equal(Boolean(condition), true, message);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function bounded(promise, timeoutMs, label) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    Promise.resolve(promise).then(
      (value) => finish(resolvePromise, value),
      (error) => finish(reject, error),
    );
  });
}

function appendOutput(child, stream, chunk) {
  const text = String(chunk);
  const key = stream === "stderr" ? "stderrText" : "stdoutText";
  child[key] = `${child[key] || ""}${text}`.slice(-OUTPUT_LIMIT);
  child.outputEvents.push({ stream, text, at: performance.now() });
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
    throw new Error(`real child process is unavailable: ${errorText(error)}`);
  }
  child.stdoutText = "";
  child.stderrText = "";
  child.outputEvents = [];
  child.spawnError = null;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => appendOutput(child, "stdout", chunk));
  child.stderr.on("data", (chunk) => appendOutput(child, "stderr", chunk));
  child.on("error", (error) => { child.spawnError = error; });
  child.once("close", () => liveChildren.delete(child));
  liveChildren.add(child);
  knownChildren.add(child);
  return child;
}

function childOutput(child) {
  if (!child) return "<child unavailable>";
  return [
    "manager stdout (including forwarded upstream stdout):",
    child.stdoutText || "<none>",
    "manager stderr (including forwarded upstream stderr):",
    child.stderrText || "<none>",
  ].join("\n");
}

function allChildDiagnostics() {
  return [...knownChildren].map((child, index) => `\n--- child ${index + 1} ---\n${childOutput(child)}`).join("");
}

function waitForClose(child, timeoutMs, label) {
  if (!child) return Promise.reject(new Error(`${label}: child is missing`));
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.off("close", onClose);
      child.off("error", onError);
      reject(new Error(`${label} did not exit within ${timeoutMs}ms\n${childOutput(child)}`));
    }, timeoutMs);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      child.off("error", onError);
      fn(value);
    };
    const onClose = (code, signal) => finish(resolvePromise, { code, signal });
    const onError = (error) => finish(reject, new Error(`${label} child error: ${errorText(error)}`));
    child.once("close", onClose);
    child.once("error", onError);
  });
}

async function stopChild(child, label) {
  if (!child) return null;
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  try { child.kill("SIGTERM"); } catch {}
  try {
    return await waitForClose(child, 2_000, label);
  } catch (termError) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch {}
    }
    try {
      return await waitForClose(child, 2_000, `${label} SIGKILL`);
    } catch (killError) {
      throw new Error(`${label} cleanup failed: ${errorText(termError)}; ${errorText(killError)}`);
    }
  }
}

function listenServer(server, port = 0) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const onError = (error) => {
      if (settled) return;
      settled = true;
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      if (settled) return;
      settled = true;
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("dynamic listener returned no address"));
        return;
      }
      resolvePromise({ server, port: address.port });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen({ host: HOST, port });
    } catch (error) {
      onError(error);
    }
  });
}

async function closeServer(server, sockets = new Set(), label = "server") {
  for (const socket of sockets) {
    try { socket.destroy(); } catch {}
  }
  sockets.clear();
  if (!server || !server.listening) return;
  const closePromise = new Promise((resolvePromise, reject) => {
    try {
      server.close((error) => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolvePromise();
      });
    } catch (error) {
      if (error?.code === "ERR_SERVER_NOT_RUNNING") resolvePromise();
      else reject(error);
    }
  });
  await bounded(closePromise, SERVER_CLOSE_TIMEOUT_MS, `${label} close`);
}

async function reservePort() {
  const result = await listenServer(net.createServer());
  try {
    return result.port;
  } finally {
    await closeServer(result.server, new Set(), "reserved port");
  }
}

async function createBlocker(port = 0) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    // Keep accepted sockets open until cleanup so server.close cannot hide a leak.
  });
  const bound = await listenServer(server, port);
  return { ...bound, sockets };
}

function requestOnce({ port, path, method = "GET", headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolvePromise, reject) => {
    const startedAt = performance.now();
    let settled = false;
    let timer;
    let response;
    const chunks = [];
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = http.request({
      host: HOST,
      port,
      path,
      method,
      headers,
      agent: false,
    }, (res) => {
      response = res;
      res.on("data", (chunk) => chunks.push(chunk));
      res.once("end", () => finish(resolvePromise, {
        outcome: "end",
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        ms: Math.round(performance.now() - startedAt),
      }));
      res.once("aborted", () => finish(resolvePromise, {
        outcome: "aborted",
        status: res.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
        ms: Math.round(performance.now() - startedAt),
      }));
      res.once("error", (error) => finish(resolvePromise, {
        outcome: `response-error:${error.code || error.message}`,
        status: res.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
        error: errorText(error),
        ms: Math.round(performance.now() - startedAt),
      }));
      res.once("close", () => {
        if (!settled) finish(resolvePromise, {
          outcome: "response-close",
          status: res.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
          ms: Math.round(performance.now() - startedAt),
        });
      });
    });
    clients.add(req);
    const forget = () => clients.delete(req);
    req.once("close", forget);
    req.once("error", forget);
    req.once("error", (error) => finish(resolvePromise, {
      outcome: `request-error:${error.code || error.message}`,
      error: errorText(error),
      ms: Math.round(performance.now() - startedAt),
    }));
    timer = setTimeout(() => {
      try { response?.destroy(); } catch {}
      try { req.destroy(); } catch {}
      finish(reject, new Error(`HTTP ${method} ${path} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
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
  ready.catch(() => {});
  const done = new Promise((resolvePromise) => { resolveDone = resolvePromise; });
  const active = {
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
  const req = http.request({
    host: HOST,
    port,
    path,
    method,
    headers,
    agent: false,
  }, (res) => {
    response = res;
    active.response = res;
    res.on("data", (chunk) => responseBody.push(chunk));
    res.once("end", () => finish("end"));
    res.once("aborted", () => finish("aborted"));
    res.once("error", (error) => finish(`response-error:${error.code || error.message}`, error));
    res.once("close", () => {
      if (!settled) finish("response-close", new Error("response closed before end"));
    });
    resolveReady(res);
  });
  active.request = req;
  clients.add(req);
  const forget = () => clients.delete(req);
  req.once("close", forget);
  req.once("error", forget);
  req.once("error", (error) => finish(`request-error:${error.code || error.message}`, error));
  req.once("close", () => {
    if (!settled && !response) finish("request-close", new Error("request closed before response"));
  });
  timer = setTimeout(() => {
    try { response?.destroy(); } catch {}
    try { req.destroy(); } catch {}
    finish("timeout", new Error(`HTTP ${method} ${path} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  if (body !== undefined) req.write(body);
  req.end();
  return active;
}

async function closeActiveRequest(active, label) {
  if (!active) return;
  try { active.request?.destroy(); } catch {}
  try { active.response?.destroy(); } catch {}
  await bounded(active.done, 2_000, `${label} request cleanup`).catch(() => {});
}

async function waitForResponseText(active, text, label, timeoutMs = 3_000) {
  if (active.body.includes(text)) return;
  if (!active.response) await bounded(active.ready, timeoutMs, `${label} headers`);
  if (active.body.includes(text)) return;
  await bounded(new Promise((resolvePromise, reject) => {
    const finish = (fn, value) => {
      clearTimeout(timer);
      active.response?.off("data", onData);
      active.response?.off("close", onClose);
      fn(value);
    };
    const onData = () => {
      if (active.body.includes(text)) finish(resolvePromise);
    };
    const onClose = () => finish(reject, new Error(`${label} closed before ${JSON.stringify(text)}`));
    const timer = setTimeout(() => finish(reject, new Error(`${label} did not receive ${JSON.stringify(text)}`)), timeoutMs);
    active.response?.on("data", onData);
    active.response?.once("close", onClose);
  }), timeoutMs + 100, `${label} wait`);
}

async function waitForHttp(port, path, predicate, label, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs;
  let lastError = "";
  while (performance.now() < deadline) {
    const remaining = Math.max(1, Math.floor(deadline - performance.now()));
    try {
      const result = await requestOnce({ port, path, timeoutMs: Math.min(700, remaining) });
      if (predicate(result)) return result;
      lastError = `${result.outcome || "response"} ${result.status ?? ""} ${result.body || result.error || ""}`;
    } catch (error) {
      lastError = errorText(error);
    }
    await sleep(Math.min(60, Math.max(1, Math.floor(deadline - performance.now()))));
  }
  throw new Error(`${label} unavailable within ${timeoutMs}ms: ${lastError}`);
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
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify({ auth: TEST_KEY, responses: [response] }),
  });
  assert.equal(result.outcome, "end", `mock configuration did not finish: ${JSON.stringify(result)}`);
  assert.equal(result.status, 200, `mock configuration failed: ${JSON.stringify(result)}`);
}

function makeDataDir(managerPort, upstreamPort) {
  const dataDir = mkdtempSync(join(tmpdir(), "ccpm-lifecycle-data-"));
  chmodSync(dataDir, 0o700);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    port: managerPort,
    host: HOST,
    upstreamPort,
    upstreamHost: HOST,
    adminToken: ADMIN_TOKEN,
    clientToken: CLIENT_TOKEN,
    pool: {
      maxRetries: 0,
      sameKeyRetryCount: 0,
      quotaRefreshMs: 3_600_000,
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

function managerEnv(dataDir, managerPort, upstreamPort, embedded, graceMs, forceWaitMs, mockPort, options = {}) {
  return {
    DATA_DIR: dataDir,
    PORT: String(managerPort),
    HOST,
    UPSTREAM_HOST: HOST,
    UPSTREAM_PORT: String(upstreamPort),
    EMBED_UPSTREAM: embedded ? "1" : "0",
    ADMIN_TOKEN,
    CLIENT_TOKEN,
    CC_API_BASE: `http://${HOST}:${mockPort}`,
    CC_QUOTA_BASE: `http://${HOST}:${mockPort}`,
    CC_SHUTDOWN_GRACE_MS: String(graceMs),
    CC_SHUTDOWN_FORCE_WAIT_MS: String(forceWaitMs),
    CC_UPSTREAM_STARTUP_TIMEOUT_MS: String(options.startupTimeoutMs ?? 2_000),
    CC_UPSTREAM_SHUTDOWN_TIMEOUT_MS: String(options.shutdownTimeoutMs ?? 250),
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

async function assertPortReusable(port, label) {
  let result;
  try {
    result = await listenServer(net.createServer(), port);
  } catch (error) {
    throw new Error(`${label}: port ${port} is still occupied: ${errorText(error)}`);
  }
  await closeServer(result.server, new Set(), `${label} reusable check`);
}

function directChildPids(pid) {
  if (!Number.isInteger(pid)) return [];
  try {
    const text = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    return text ? text.split(/\s+/).filter(Boolean).map(Number) : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error(`cannot inspect direct children of ${pid}: ${errorText(error)}`);
  }
}

async function waitForDirectChild(pid, label, timeoutMs = 3_000) {
  const deadline = performance.now() + timeoutMs;
  let last = [];
  while (performance.now() < deadline) {
    last = directChildPids(pid);
    if (last.length) return last[0];
    await sleep(25);
  }
  throw new Error(`${label}: no direct child found within ${timeoutMs}ms; last=${last.join(",") || "none"}`);
}

async function assertPidGone(pid, label, timeoutMs = 2_000) {
  if (!Number.isInteger(pid)) return;
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await sleep(25);
  }
  throw new Error(`${label}: pid ${pid} is still present`);
}

function assertNonZeroExit(result, label) {
  assertCondition(result.code !== 0 && result.signal === null, `${label} should exit with a non-zero code: ${JSON.stringify(result)}`);
}

function outputEventIndex(child, needle) {
  let output = "";
  for (let index = 0; index < child.outputEvents.length; index += 1) {
    output += child.outputEvents[index].text;
    if (output.includes(needle)) return index;
  }
  return -1;
}

function assertHostedReadyBeforeManagerListen(manager) {
  const upstreamIndex = outputEventIndex(manager, "CC Proxy started");
  const managerIndex = outputEventIndex(manager, "[manager] CC Proxy Manager started");
  assertCondition(upstreamIndex >= 0, `hosted upstream ready log missing\n${childOutput(manager)}`);
  assertCondition(managerIndex >= 0, `manager listen log missing\n${childOutput(manager)}`);
  assertCondition(upstreamIndex < managerIndex, `manager listen was logged before upstream ready\n${childOutput(manager)}`);
}

function assertHostedReadyBeforeManagerFailure(manager) {
  const upstreamIndex = outputEventIndex(manager, "CC Proxy started");
  const failureIndex = outputEventIndex(manager, "[manager] listen failed");
  assertCondition(upstreamIndex >= 0, `hosted upstream ready log missing\n${childOutput(manager)}`);
  assertCondition(failureIndex >= 0, `manager listen failure log missing\n${childOutput(manager)}`);
  assertCondition(upstreamIndex < failureIndex, `manager listen failed before upstream ready\n${childOutput(manager)}`);
}

async function cleanupCase({ manager, active, blocker, dataDir, label }) {
  let cleanupError;
  try {
    await closeActiveRequest(active, label);
  } catch (error) {
    cleanupError ||= error;
  }
  try {
    await stopChild(manager, `${label} manager`);
  } catch (error) {
    cleanupError ||= error;
  }
  try {
    await closeServer(blocker?.server, blocker?.sockets || new Set(), `${label} blocker`);
  } catch (error) {
    cleanupError ||= error;
  }
  if (dataDir) {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { cleanupError ||= error; }
  }
  if (cleanupError) throw cleanupError;
}

async function runGracefulNormal(mockPort) {
  const managerPort = await reservePort();
  const dataDir = makeDataDir(managerPort, mockPort);
  const graceMs = 1_200;
  const forceWaitMs = 250;
  let manager;
  let active;
  try {
    manager = spawnNode([MANAGER_ENTRY], managerEnv(dataDir, managerPort, mockPort, false, graceMs, forceWaitMs, mockPort));
    await waitForHttp(managerPort, "/health", (response) => response.status === 200 && response.body === "OK", "external manager startup");
    assert.deepEqual(directChildPids(manager.pid), [], "EMBED_UPSTREAM=0 must not spawn a child");
    await configureMock(mockPort, { mode: "delay", delayMs: 250 });
    active = openActiveRequest({
      port: managerPort,
      path: "/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${CLIENT_TOKEN}`, Connection: "close" },
      body: JSON.stringify({ model: "lifecycle-normal", stream: false }),
    });
    await waitForMockCall(mockPort, "delay", "normal request reaches mock");
    const signalAt = performance.now();
    manager.kill("SIGTERM");
    const [response, exit] = await Promise.all([
      active.done,
      waitForClose(manager, graceMs + forceWaitMs + 3_000, "normal manager"),
    ]);
    assert.equal(response.outcome, "end", `normal request did not finish: ${JSON.stringify(response)}\n${childOutput(manager)}`);
    assert.equal(response.status, 200);
    assert.match(response.body, /slow-ok/);
    assert.equal(exit.code, 0, `normal manager exit: ${JSON.stringify(exit)}\n${childOutput(manager)}`);
    assert.equal(exit.signal, null);
    assertCondition(response.ms >= 150, `normal request was not drained: ${JSON.stringify(response)}`);
    console.log(`PASS external non-stream drain (${response.ms}ms; exit ${Math.round(performance.now() - signalAt)}ms)`);
  } finally {
    await cleanupCase({ manager, active, dataDir, label: "external non-stream" });
  }
  await assertPortReusable(managerPort, "external non-stream cleanup");
}

async function runGracefulStream(mockPort) {
  const managerPort = await reservePort();
  const dataDir = makeDataDir(managerPort, mockPort);
  const graceMs = 1_500;
  const forceWaitMs = 250;
  let manager;
  let active;
  try {
    manager = spawnNode([MANAGER_ENTRY], managerEnv(dataDir, managerPort, mockPort, false, graceMs, forceWaitMs, mockPort));
    await waitForHttp(managerPort, "/health", (response) => response.status === 200 && response.body === "OK", "external stream startup");
    assert.deepEqual(directChildPids(manager.pid), [], "external stream manager must not spawn a child");
    await configureMock(mockPort, { mode: "slowsse", frameDelayMs: 25 });
    active = openActiveRequest({
      port: managerPort,
      path: "/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${CLIENT_TOKEN}`, Connection: "close" },
      body: JSON.stringify({ model: "lifecycle-stream", stream: true }),
    });
    const response = await bounded(active.ready, REQUEST_TIMEOUT_MS, "stream response headers");
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["content-type"]), /text\/event-stream/);
    await waitForResponseText(active, "data:", "stream response");
    const signalAt = performance.now();
    manager.kill("SIGTERM");
    const [result, exit] = await Promise.all([
      active.done,
      waitForClose(manager, graceMs + forceWaitMs + 3_000, "stream manager"),
    ]);
    assert.equal(result.outcome, "end", `stream did not finish: ${JSON.stringify(result)}\n${childOutput(manager)}`);
    assert.match(result.body, /data: \[DONE\]/);
    assert.equal(exit.code, 0, `stream manager exit: ${JSON.stringify(exit)}\n${childOutput(manager)}`);
    assert.equal(exit.signal, null);
    console.log(`PASS external stream drain (${result.ms}ms; exit ${Math.round(performance.now() - signalAt)}ms)`);
  } finally {
    await cleanupCase({ manager, active, dataDir, label: "external stream" });
  }
  await assertPortReusable(managerPort, "external stream cleanup");
}

async function runSseForceClose(mockPort) {
  const managerPort = await reservePort();
  const dataDir = makeDataDir(managerPort, mockPort);
  const graceMs = 180;
  const forceWaitMs = 220;
  let manager;
  let active;
  try {
    manager = spawnNode([MANAGER_ENTRY], managerEnv(dataDir, managerPort, mockPort, false, graceMs, forceWaitMs, mockPort));
    await waitForHttp(managerPort, "/health", (response) => response.status === 200 && response.body === "OK", "SSE manager startup");
    active = openActiveRequest({
      port: managerPort,
      path: "/admin/api/events",
      headers: { "X-Admin-Token": ADMIN_TOKEN, Accept: "text/event-stream", Connection: "keep-alive" },
    });
    const response = await bounded(active.ready, REQUEST_TIMEOUT_MS, "SSE response headers");
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["content-type"]), /text\/event-stream/);
    await waitForResponseText(active, ": connected", "SSE response");
    const signalAt = performance.now();
    manager.kill("SIGTERM");
    const [result, exit] = await Promise.all([
      active.done,
      waitForClose(manager, graceMs + forceWaitMs + 3_000, "SSE manager"),
    ]);
    assert.notEqual(result.outcome, "end", `SSE unexpectedly ended gracefully: ${JSON.stringify(result)}`);
    assert.equal(exit.code, 0, `SSE manager exit: ${JSON.stringify(exit)}\n${childOutput(manager)}`);
    assert.equal(exit.signal, null);
    assertCondition(result.ms <= graceMs + forceWaitMs + 2_000, `SSE force close exceeded bound: ${JSON.stringify(result)}`);
    console.log(`PASS SSE force close (${result.outcome}, ${result.ms}ms; exit ${Math.round(performance.now() - signalAt)}ms)`);
  } finally {
    await cleanupCase({ manager, active, dataDir, label: "external SSE" });
  }
  await assertPortReusable(managerPort, "external SSE cleanup");
}

async function runForceDestroy(mockPort) {
  const managerPort = await reservePort();
  const dataDir = makeDataDir(managerPort, mockPort);
  const graceMs = 180;
  const forceWaitMs = 220;
  let manager;
  let active;
  try {
    manager = spawnNode([MANAGER_ENTRY], managerEnv(dataDir, managerPort, mockPort, false, graceMs, forceWaitMs, mockPort));
    await waitForHttp(managerPort, "/health", (response) => response.status === 200 && response.body === "OK", "force-close manager startup");
    await configureMock(mockPort, { mode: "hang" });
    active = openActiveRequest({
      port: managerPort,
      path: "/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${CLIENT_TOKEN}`, Connection: "close" },
      body: JSON.stringify({ model: "lifecycle-force", stream: false }),
    });
    const readiness = active.ready.then(
      (response) => ({ kind: "response", response }),
      (error) => ({ kind: "error", error }),
    );
    await waitForMockCall(mockPort, "hang", "force-close request reaches mock");
    const signalAt = performance.now();
    manager.kill("SIGTERM");
    const [result, exit, readyState] = await Promise.all([
      active.done,
      waitForClose(manager, graceMs + forceWaitMs + 3_000, "force-close manager"),
      readiness,
    ]);
    assert.notEqual(result.outcome, "end", `hanging request ended unexpectedly: ${JSON.stringify(result)}`);
    assert.equal(exit.code, 0, `force-close manager exit: ${JSON.stringify(exit)}\n${childOutput(manager)}`);
    assert.equal(exit.signal, null);
    assertCondition(result.ms <= graceMs + forceWaitMs + 2_000, `force close exceeded bound: ${JSON.stringify(result)}`);
    if (readyState.kind === "error") assertCondition(isExpectedDisconnect(readyState.error), `unexpected readiness error: ${errorText(readyState.error)}`);
    if (result.error) assertCondition(isExpectedDisconnect(result.error), `unexpected request error: ${result.error}`);
    const disconnected = result.outcome === "aborted" || result.outcome === "request-close" || result.outcome === "response-close";
    assertCondition(disconnected || result.outcome.startsWith("request-error:") || result.outcome.startsWith("response-error:"), `force close was not observable: ${JSON.stringify(result)}`);
    console.log(`PASS ordinary request force destroy (${result.outcome}, ${result.ms}ms; exit ${Math.round(performance.now() - signalAt)}ms)`);
  } finally {
    await cleanupCase({ manager, active, dataDir, label: "external force close" });
  }
  await assertPortReusable(managerPort, "external force close cleanup");
}

function isExpectedDisconnect(error) {
  const code = error?.code;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return code === "ECONNRESET"
    || code === "ECONNABORTED"
    || /ECONNRESET|ECONNABORTED/.test(message)
    || /socket hang up|request closed|response closed/i.test(message);
}

async function runHostedReadyAndShutdown(mockPort) {
  const managerPort = await reservePort();
  const upstreamPort = await reservePort();
  const dataDir = makeDataDir(managerPort, upstreamPort);
  let manager;
  let upstreamPid;
  try {
    manager = spawnNode([MANAGER_ENTRY], managerEnv(dataDir, managerPort, upstreamPort, true, 1_000, 250, mockPort));
    upstreamPid = await waitForDirectChild(manager.pid, "hosted upstream child");
    const response = await waitForHttp(managerPort, "/health", (result) => result.status === 200 && result.body === "OK", "hosted manager startup");
    assert.equal(response.body, "OK");
    assertHostedReadyBeforeManagerListen(manager);
    const upstreamHealth = await requestOnce({ port: upstreamPort, path: "/health" });
    assert.equal(upstreamHealth.status, 200, `hosted upstream health failed: ${JSON.stringify(upstreamHealth)}`);
    manager.kill("SIGTERM");
    const exit = await waitForClose(manager, CHILD_EXIT_TIMEOUT_MS, "hosted normal manager");
    assert.equal(exit.code, 0, `hosted manager exit: ${JSON.stringify(exit)}\n${childOutput(manager)}`);
    assert.equal(exit.signal, null);
    await assertPidGone(upstreamPid, "hosted normal upstream");
    console.log("PASS hosted manager waits for real upstream health and shuts down both processes");
  } finally {
    await cleanupCase({ manager, dataDir, label: "hosted normal" });
  }
  await assertPortReusable(managerPort, "hosted normal manager cleanup");
  await assertPortReusable(upstreamPort, "hosted normal upstream cleanup");
}

async function runHostedUpstreamPortConflict(mockPort) {
  const managerPort = await reservePort();
  let blocker;
  let upstreamPort;
  let dataDir;
  let manager;
  try {
    blocker = await createBlocker();
    upstreamPort = blocker.port;
    dataDir = makeDataDir(managerPort, upstreamPort);
    manager = spawnNode([MANAGER_ENTRY], managerEnv(dataDir, managerPort, upstreamPort, true, 250, 100, mockPort, { startupTimeoutMs: 700, shutdownTimeoutMs: 100 }));
    const result = await waitForClose(manager, CHILD_EXIT_TIMEOUT_MS, "hosted upstream conflict manager");
    assertNonZeroExit(result, "hosted upstream conflict");
    const output = childOutput(manager);
    assert.match(output, /EADDRINUSE/);
    assert.match(output, /upstream (?:startup failed|exited unexpectedly)/);
    console.log(`PASS hosted upstream port conflict (${JSON.stringify(result)})`);
  } finally {
    await cleanupCase({ manager, blocker, dataDir, label: "hosted upstream conflict" });
  }
  await assertPortReusable(managerPort, "hosted upstream conflict manager cleanup");
  await assertPortReusable(upstreamPort, "hosted upstream conflict blocker cleanup");
}

async function runHostedManagerPortConflict(mockPort) {
  let blocker;
  let managerPort;
  let upstreamPort;
  let dataDir;
  let manager;
  let upstreamPid;
  try {
    blocker = await createBlocker();
    managerPort = blocker.port;
    upstreamPort = await reservePort();
    dataDir = makeDataDir(managerPort, upstreamPort);
    manager = spawnNode([MANAGER_ENTRY], managerEnv(dataDir, managerPort, upstreamPort, true, 250, 100, mockPort, { startupTimeoutMs: 2_000, shutdownTimeoutMs: 100 }));
    upstreamPid = await waitForDirectChild(manager.pid, "upstream before manager conflict");
    const result = await waitForClose(manager, CHILD_EXIT_TIMEOUT_MS, "hosted manager conflict");
    assertNonZeroExit(result, "hosted manager port conflict");
    const output = childOutput(manager);
    assert.match(output, /EADDRINUSE/);
    assert.match(output, /manager startup failed/);
    assertHostedReadyBeforeManagerFailure(manager);
    console.log(`PASS manager port conflict reaps ready upstream (${JSON.stringify(result)})`);
  } finally {
    await cleanupCase({ manager, blocker, dataDir, label: "hosted manager conflict" });
  }
  await assertPidGone(upstreamPid, "upstream after manager listen failure");
  await assertPortReusable(managerPort, "hosted manager conflict blocker cleanup");
  await assertPortReusable(upstreamPort, "upstream after manager listen failure");
}

async function runHostedUnexpectedExit(mockPort) {
  const managerPort = await reservePort();
  const upstreamPort = await reservePort();
  const dataDir = makeDataDir(managerPort, upstreamPort);
  let manager;
  let upstreamPid;
  try {
    manager = spawnNode([MANAGER_ENTRY], managerEnv(dataDir, managerPort, upstreamPort, true, 1_000, 100, mockPort));
    await waitForHttp(managerPort, "/health", (response) => response.status === 200 && response.body === "OK", "unexpected-exit hosted startup");
    upstreamPid = await waitForDirectChild(manager.pid, "unexpected-exit upstream child");
    process.kill(upstreamPid, "SIGKILL");
    const result = await waitForClose(manager, CHILD_EXIT_TIMEOUT_MS, "unexpected-exit manager");
    assertNonZeroExit(result, "unexpected upstream exit manager");
    assert.match(childOutput(manager), /upstream exited unexpectedly/);
    await assertPidGone(upstreamPid, "unexpected-exit upstream");
    console.log(`PASS unexpected upstream exit closes manager non-zero (${JSON.stringify(result)})`);
  } finally {
    await cleanupCase({ manager, dataDir, label: "hosted unexpected exit" });
  }
  await assertPortReusable(managerPort, "unexpected-exit manager cleanup");
  await assertPortReusable(upstreamPort, "unexpected-exit upstream cleanup");
}

async function runCase(label, test) {
  try {
    await test();
  } catch (error) {
    throw new Error(`${label} failed: ${errorText(error)}\n${allChildDiagnostics()}`, { cause: error });
  }
}

async function main() {
  const mockPort = await reservePort();
  let mock;
  try {
    mock = await startMock(mockPort);
    await runCase("external non-stream drain", () => runGracefulNormal(mockPort));
    await runCase("external stream drain", () => runGracefulStream(mockPort));
    await runCase("external SSE force close", () => runSseForceClose(mockPort));
    await runCase("external ordinary force close", () => runForceDestroy(mockPort));
    await runCase("hosted ready and shutdown", () => runHostedReadyAndShutdown(mockPort));
    await runCase("hosted upstream port conflict", () => runHostedUpstreamPortConflict(mockPort));
    await runCase("hosted manager port conflict", () => runHostedManagerPortConflict(mockPort));
    await runCase("hosted unexpected upstream exit", () => runHostedUnexpectedExit(mockPort));
    console.log("Server lifecycle tests: PASS");
  } finally {
    for (const client of [...clients]) {
      try { client.destroy(); } catch {}
    }
    for (const child of [...liveChildren]) {
      try { await stopChild(child, "final child cleanup"); } catch (error) { console.error(errorText(error)); }
    }
    try { await stopChild(mock, "mock upstream cleanup"); } catch (error) { console.error(errorText(error)); }
    await assertPortReusable(mockPort, "mock cleanup").catch((error) => console.error(errorText(error)));
  }
}

main().catch((error) => {
  console.error(`Server lifecycle tests: FAIL\n${error.stack || errorText(error)}`);
  process.exitCode = 1;
});
