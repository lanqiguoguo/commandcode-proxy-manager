import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { refreshQuotaWithTimeout } from "../src/adminApi.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const MANAGER_ENTRY = resolve(ROOT, "src/server.mjs");
const ADMIN_TOKEN = "admin-boundary-test-token";
const CLIENT_TOKEN = "client-boundary-test-token";
const TEST_KEY = "user_boundary_key";
const STARTUP_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 3000;

const realSetTimeout = globalThis.setTimeout;

function sleep(ms) {
  return new Promise((resolvePromise) => realSetTimeout(resolvePromise, ms));
}

function errorText(error) {
  return error instanceof Error ? `${error.code ? `${error.code}: ` : ""}${error.message}` : String(error);
}

function json(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
  res.end(JSON.stringify(data));
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
        reject(new Error("server did not expose a TCP address"));
        return;
      }
      resolvePromise(address.port);
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

async function closeServer(server) {
  if (!server || !server.listening) return;
  await new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}

async function allocatePort() {
  const server = net.createServer();
  const port = await listenServer(server);
  await closeServer(server);
  return port;
}

function request({ port, path, method = "GET", headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let timer;
    const chunks = [];
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      fn(value);
    };
    const req = http.request({ host: HOST, port, path, method, headers, agent: false }, (res) => {
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => finish(resolvePromise, {
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      res.on("aborted", () => finish(reject, new Error(`response aborted: ${method} ${path}`)));
      res.on("error", (error) => finish(reject, error));
    });
    req.on("error", (error) => finish(reject, error));
    timer = globalThis.setTimeout(() => {
      req.destroy();
      finish(reject, new Error(`request timeout: ${method} ${path}`));
    }, timeoutMs);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function waitForHealth(port) {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    try {
      const result = await request({ port, path: "/health", timeoutMs: 500 });
      if (result.status === 200 && result.body === "OK") return;
      lastError = `${result.status} ${result.body}`;
    } catch (error) {
      lastError = errorText(error);
    }
    await sleep(50);
  }
  throw new Error(`manager did not become healthy: ${lastError}`);
}

function waitForChild(child, timeoutMs = 3000) {
  if (child.exitCode !== null || child.signalCode) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, reject) => {
    let timer;
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      child.off("close", onClose);
      child.off("error", onError);
    };
    const onClose = (code, signal) => {
      cleanup();
      resolvePromise({ code, signal });
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    child.once("close", onClose);
    child.once("error", onError);
    timer = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error(`child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

async function stopChild(child) {
  if (!child || (child.exitCode !== null && child.exitCode !== undefined) || child.signalCode) return;
  try { child.kill("SIGTERM"); } catch {}
  try {
    await waitForChild(child, 3000);
  } catch {
    try { child.kill("SIGKILL"); } catch {}
    await waitForChild(child, 1000).catch(() => {});
  }
}

function spawnManager(dataDir, managerPort, upstreamPort, quotaPort) {
  const child = spawn(process.execPath, [MANAGER_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(managerPort),
      HOST,
      UPSTREAM_HOST: HOST,
      UPSTREAM_PORT: String(upstreamPort),
      EMBED_UPSTREAM: "0",
      ADMIN_TOKEN,
      CLIENT_TOKEN,
      CC_QUOTA_BASE: `http://${HOST}:${quotaPort}`,
      CC_ADMIN_REFRESH_QUOTA_TIMEOUT_MS: "150",
      CC_SHUTDOWN_GRACE_MS: "500",
      CC_SHUTDOWN_FORCE_WAIT_MS: "200",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdoutText = "";
  child.stderrText = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { child.stdoutText += chunk; });
  child.stderr.on("data", (chunk) => { child.stderrText += chunk; });
  child.outputText = () => `${child.stdoutText}\n${child.stderrText}`;
  return child;
}

function makeDataDir(managerPort, upstreamPort) {
  const dataDir = mkdtempSync(join(tmpdir(), "ccpm-admin-boundaries-"));
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
      quotaRefreshMs: 3600000,
      quotaRefreshGapMs: 0,
    },
  }));
  writeFileSync(join(dataDir, "keys.json"), JSON.stringify({
    keys: [{
      id: "boundary-key",
      key: TEST_KEY,
      alias: "boundary",
      enabled: true,
      priority: 0,
      createdAt: Date.now(),
    }],
  }));
  return dataDir;
}

function createQuotaMock() {
  const state = {
    mode: "success",
    delayMs: 0,
    calls: [],
    aborted: 0,
  };
  const server = http.createServer((req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    const pathname = new URL(req.url, `http://${HOST}`).pathname;
    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain", Connection: "close" });
      res.end("OK");
      return;
    }
    if (!pathname.startsWith("/alpha/")) {
      req.resume();
      json(res, 404, { error: "not found" });
      return;
    }

    const mode = state.mode;
    const delayMs = state.delayMs;
    state.calls.push({ pathname, mode });
    let completed = false;
    req.once("close", () => {
      if (!completed) state.aborted++;
    });
    req.resume();

    if (mode === "hang") return;
    (async () => {
      if (delayMs > 0) await sleep(delayMs);
      if (res.destroyed) return;
      if (mode === "failure") {
        completed = true;
        json(res, 503, { error: { code: "QUOTA_UNAVAILABLE" } });
        return;
      }
      completed = true;
      if (pathname === "/alpha/whoami") {
        json(res, 200, { success: true, data: { org: { id: "boundary-org" } } });
      } else if (pathname === "/alpha/billing/credits") {
        json(res, 200, {
          credits: { monthlyCredits: 10, purchasedCredits: 0, freeCredits: 0 },
          windowLimits: {
            fiveHour: { cap: 100, used: 1, resetAt: Date.now() + 3600000 },
            weekly: { cap: 100, used: 2, resetAt: Date.now() + 2 * 86400000 },
          },
        });
      } else if (pathname === "/alpha/billing/subscriptions") {
        json(res, 200, {
          success: true,
          data: {
            currentPeriodStart: "2026-08-25T23:33:28.000Z",
            currentPeriodEnd: "2026-09-25T23:33:28.000Z",
          },
        });
      } else {
        json(res, 200, {
          totalCount: 4,
          completedCount: 4,
          failedCount: 0,
          successRate: 100,
          totalTokensIn: 10,
          totalTokensOut: 20,
          totalTokens: 30,
          totalCost: 1,
        });
      }
    })().catch((error) => {
      if (!res.destroyed) json(res, 500, { error: error.message });
    });
  });
  return { server, state };
}

function parseJson(response, label) {
  try {
    return JSON.parse(response.body);
  } catch (error) {
    throw new Error(`${label} is not JSON: ${error.message}; body=${response.body}`);
  }
}

function openSse(port, headers) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let timer;
    let req;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      fn(value);
    };
    req = http.request({ host: HOST, port, path: "/admin/api/events", headers, agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
        if (body.includes(": connected")) finish(resolvePromise, { req, res, status: res.statusCode, body });
      });
      res.on("end", () => finish(reject, new Error("SSE ended before readiness")));
      res.on("aborted", () => finish(reject, new Error("SSE aborted before readiness")));
      res.on("error", (error) => finish(reject, error));
    });
    req.on("error", (error) => finish(reject, error));
    req.end();
    timer = globalThis.setTimeout(() => {
      req.destroy();
      finish(reject, new Error("SSE readiness timeout"));
    }, REQUEST_TIMEOUT_MS);
  });
}

function makeFakeTimers() {
  const active = new Set();
  let clearCount = 0;
  let serial = 0;
  return {
    setTimeout(callback, ms) {
      const timer = { callback, ms, serial: ++serial };
      active.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (active.delete(timer)) clearCount++;
    },
    fireAll() {
      for (const timer of [...active]) timer.callback();
    },
    get activeCount() { return active.size; },
    get clearCount() { return clearCount; },
  };
}

async function testHelperLifecycle() {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const successTimers = makeFakeTimers();
    const success = await refreshQuotaWithTimeout("success", {
      timeoutMs: 1000,
      setTimeout: successTimers.setTimeout,
      clearTimeout: successTimers.clearTimeout,
      refresh: async (key, { signal }) => ({ key, cancelled: signal.aborted, stale: false }),
    });
    assert.equal(success.stale, false);
    assert.equal(successTimers.activeCount, 0);
    assert.equal(successTimers.clearCount, 1);

    const failureTimers = makeFakeTimers();
    const failure = await refreshQuotaWithTimeout("failure", {
      timeoutMs: 1000,
      setTimeout: failureTimers.setTimeout,
      clearTimeout: failureTimers.clearTimeout,
      refresh: async () => ({ stale: true, error: "network" }),
    });
    assert.equal(failure.stale, true);
    assert.equal(failureTimers.activeCount, 0);
    assert.equal(failureTimers.clearCount, 1);

    const exceptionTimers = makeFakeTimers();
    await assert.rejects(refreshQuotaWithTimeout("exception", {
      timeoutMs: 1000,
      setTimeout: exceptionTimers.setTimeout,
      clearTimeout: exceptionTimers.clearTimeout,
      refresh: async () => { throw new Error("probe exception"); },
    }), /probe exception/);
    assert.equal(exceptionTimers.activeCount, 0);
    assert.equal(exceptionTimers.clearCount, 1);

    const timeoutTimers = makeFakeTimers();
    let timeoutSignal;
    const timeoutPromise = refreshQuotaWithTimeout("timeout", {
      timeoutMs: 25,
      setTimeout: timeoutTimers.setTimeout,
      clearTimeout: timeoutTimers.clearTimeout,
      refresh: (key, { signal }) => {
        timeoutSignal = signal;
        return new Promise((_, reject) => realSetTimeout(() => reject(new Error("late probe rejection")), 20));
      },
    });
    timeoutTimers.fireAll();
    await assert.rejects(timeoutPromise, /probe timeout/);
    await sleep(40);
    assert.equal(timeoutSignal.aborted, true);
    assert.equal(timeoutTimers.activeCount, 0);
    assert.equal(timeoutTimers.clearCount, 1);

    for (let i = 0; i < 20; i++) {
      const timers = makeFakeTimers();
      await refreshQuotaWithTimeout(`repeat-${i}`, {
        timeoutMs: 1000,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        refresh: async () => ({ stale: false }),
      });
      assert.equal(timers.activeCount, 0, `repeat ${i} left an active timer`);
      assert.equal(timers.clearCount, 1, `repeat ${i} did not clear its timer`);
    }
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.equal(unhandled.length, 0, `late probe rejection was unhandled: ${unhandled.map(errorText).join("; ")}`);
  console.log("  PASS in-memory refresh success/failure/exception/timeout and 20 repeated timer lifecycles");
}

async function testHttpBoundaries() {
  const quotaMock = createQuotaMock();
  const quotaPort = await listenServer(quotaMock.server);
  const managerPort = await allocatePort();
  const dataDir = makeDataDir(managerPort, quotaPort);
  const manager = spawnManager(dataDir, managerPort, quotaPort, quotaPort);
  try {
    await waitForHealth(managerPort);

    const malformed = await request({
      port: managerPort,
      path: "/admin/api/events",
      headers: { Cookie: "ccpm_sse=%ZZ", Connection: "close" },
    });
    const malformedBody = parseJson(malformed, "malformed cookie response");
    assert.equal(malformed.status, 401);
    assert.equal(malformedBody.error?.type, "auth_error");
    assert.notEqual(malformed.status, 500);
    console.log("  PASS malformed percent-encoded Cookie -> 401 auth_error");

    const cookie = crypto.createHash("sha256").update(ADMIN_TOKEN).digest("hex");
    const sse = await openSse(managerPort, {
      Cookie: `bad=%ZZ; ccpm_sse=${cookie}`,
      Connection: "keep-alive",
    });
    assert.equal(sse.status, 200);
    assert.match(sse.body, /: connected/);
    sse.req.destroy();
    sse.res.destroy();
    console.log("  PASS valid Cookie remains accepted when a separate Cookie value is malformed");

    const keys = await request({
      port: managerPort,
      path: "/admin/api/keys",
      headers: { "X-Admin-Token": ADMIN_TOKEN, Connection: "close" },
    });
    assert.equal(keys.status, 200);
    assert.equal(parseJson(keys, "admin keys response").keys.length, 1);

    quotaMock.state.mode = "success";
    quotaMock.state.delayMs = 5;
    const success = await request({
      port: managerPort,
      path: "/admin/api/keys/boundary-key/refresh-quota",
      method: "POST",
      headers: { "X-Admin-Token": ADMIN_TOKEN, Connection: "close" },
    });
    const successBody = parseJson(success, "refresh success response");
    assert.equal(success.status, 200);
    assert.equal(successBody.quota?.stale, false);
    console.log("  PASS refresh-quota early success -> 200 with fresh report");

    quotaMock.state.mode = "failure";
    quotaMock.state.delayMs = 0;
    const failure = await request({
      port: managerPort,
      path: "/admin/api/keys/boundary-key/refresh-quota",
      method: "POST",
      headers: { "X-Admin-Token": ADMIN_TOKEN, Connection: "close" },
    });
    const failureBody = parseJson(failure, "refresh failure response");
    assert.equal(failure.status, 200);
    assert.equal(failureBody.quota?.stale, true);
    console.log("  PASS refresh-quota probe failure -> existing 200 stale protocol");

    quotaMock.state.mode = "hang";
    const timeoutStarted = Date.now();
    const timeout = await request({
      port: managerPort,
      path: "/admin/api/keys/boundary-key/refresh-quota",
      method: "POST",
      headers: { "X-Admin-Token": ADMIN_TOKEN, Connection: "close" },
      timeoutMs: 2000,
    });
    const timeoutBody = parseJson(timeout, "refresh timeout response");
    assert.equal(timeout.status, 400);
    assert.equal(timeoutBody.error?.message, "probe timeout");
    assert.ok(Date.now() - timeoutStarted < 1200, `timeout response was too slow: ${Date.now() - timeoutStarted}ms`);
    const abortedStarted = Date.now();
    while (quotaMock.state.aborted < 1 && Date.now() - abortedStarted < 1000) await sleep(20);
    assert.ok(quotaMock.state.aborted >= 1, "timed out quota request was not aborted at the mock");
    console.log("  PASS refresh-quota timeout -> bounded 400 and underlying HTTP probe aborted");

    quotaMock.state.mode = "success";
    const repeats = [];
    for (let i = 0; i < 5; i++) {
      repeats.push(await request({
        port: managerPort,
        path: "/admin/api/keys/boundary-key/refresh-quota",
        method: "POST",
        headers: { "X-Admin-Token": ADMIN_TOKEN, Connection: "close" },
      }));
    }
    assert.ok(repeats.every((response) => response.status === 200 && parseJson(response, "repeated refresh response").quota?.stale === false));
    await waitForHealth(managerPort);
    assert.doesNotMatch(manager.outputText(), /unhandledRejection/);
    console.log("  PASS five consecutive refresh-quota calls recover after timeout without rejection or stuck queue");
  } finally {
    await stopChild(manager);
    await closeServer(quotaMock.server).catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
}

try {
  await testHelperLifecycle();
  await testHttpBoundaries();
  console.log("Admin boundary and refresh timer tests: PASS");
} catch (error) {
  console.error(`Admin boundary and refresh timer tests: FAIL\n${error.stack || errorText(error)}`);
  process.exitCode = 1;
}
