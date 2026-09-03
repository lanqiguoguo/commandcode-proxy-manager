import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_ENTRY = resolve(ROOT, "upstream/proxy.mjs");
const FETCH_HOOK = resolve(ROOT, "scripts/test-upstream-version-fetch-hook.mjs");
const HOST = "127.0.0.1";
const API_KEY = "user_f18_test_key";
const STARTUP_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 2500;
const REFRESH_TIMEOUT_MS = 120;
const TEST_REFRESH_INTERVAL_MS = 100;

const children = new Set();

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function errorText(error) {
  return error instanceof Error
    ? (error.code ? error.code + ": " : "") + error.message
    : String(error);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function spawnNode(args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.output = "";
  child.stdout.on("data", (chunk) => { child.output += chunk; });
  child.stderr.on("data", (chunk) => { child.output += chunk; });
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

function listenServer(server) {
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
        reject(new Error("dynamic port allocation failed"));
        return;
      }
      resolvePromise({ server, port: address.port });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: HOST, port: 0 });
  });
}

async function reservePort() {
  const result = await listenServer(net.createServer());
  await new Promise((resolvePromise, reject) => result.server.close((error) => error ? reject(error) : resolvePromise()));
  return result.port;
}

function requestOnce({ port, path, method = "GET", headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS }) {
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
      res.on("aborted", () => finish(resolvePromise, {
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        aborted: true,
      }));
      res.on("error", (error) => finish(reject, error));
    });
    req.on("error", (error) => finish(reject, error));
    timer = setTimeout(() => {
      try { req.destroy(); } catch {}
      finish(reject, new Error("HTTP " + method + " " + path + " timed out"));
    }, timeoutMs);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function waitUntil(predicate, label, timeoutMs = STARTUP_TIMEOUT_MS) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {}
    await sleep(20);
  }
  throw new Error(label + " timed out");
}

function closeServer(server) {
  return new Promise((resolvePromise) => {
    if (!server.listening) {
      resolvePromise();
      return;
    }
    server.close(() => resolvePromise());
  });
}

function createRegistryServer() {
  const state = { responses: [], requests: 0, active: 0, maxActive: 0 };
  const server = http.createServer(async (req, res) => {
    res.on("error", () => {});
    if (req.url !== "/registry") {
      res.writeHead(404);
      res.end();
      return;
    }
    state.requests++;
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    const spec = state.responses.length
      ? state.responses.shift()
      : { type: "json", body: '{"version":"0.32.4"}' };
    try {
      if (spec.type === "timeout") {
        await sleep(spec.delayMs ?? REFRESH_TIMEOUT_MS * 4);
        if (res.writableEnded || res.destroyed) return;
      }
      if (spec.type === "status") {
        res.writeHead(spec.status, { "Content-Type": "application/json" });
        res.end(spec.body ?? '{"error":"failure"}');
        return;
      }
      const body = spec.body ?? '{"version":"0.32.4"}';
      const headers = {
        "Content-Type": spec.contentType ?? "application/json",
        ...(spec.chunked ? {} : { "Content-Length": Buffer.byteLength(body).toString() }),
      };
      res.writeHead(spec.status ?? 200, headers);
      if (spec.chunked) {
        const split = Math.max(1, Math.floor(body.length / 2));
        res.write(body.slice(0, split));
        await sleep(spec.delayMs ?? 10);
        if (!res.destroyed) res.end(body.slice(split));
      } else {
        res.end(body);
      }
    } catch {}
    finally {
      state.active--;
    }
  });
  return { server, state };
}

function createApiServer() {
  const state = { requests: [], versions: [] };
  const server = http.createServer((req, res) => {
    res.on("error", () => {});
    const chunks = [];
    req.on("error", () => {});
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const path = req.url.split("?")[0];
      const version = req.headers["x-command-code-version"] || "";
      state.requests.push({ path, version });
      if (path === "/alpha/fingerprint/record" || path === "/alpha/lifecycle-events") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (path === "/alpha/generate") {
        state.versions.push(version);
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.end([
          JSON.stringify({ type: "text-delta", text: "f18" }),
          JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1 } }),
        ].join("\n") + "\n");
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  return { server, state };
}

async function stopChild(child, label) {
  if (!child || (child.exitCode !== null && child.exitCode !== undefined) || child.signalCode) return;
  try { child.kill("SIGTERM"); } catch {}
  await new Promise((resolvePromise) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise();
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish();
    }, 1500);
    child.once("close", finish);
  });
  if (child.exitCode === null && child.signalCode === null) throw new Error(label + " did not stop");
}

async function startFixture({ apiPort, registryPort, refreshEnabled, refreshIntervalMs }) {
  const port = await reservePort();
  const child = spawnNode(["--import", FETCH_HOOK, UPSTREAM_ENTRY], {
    PORT: String(port),
    HOST,
    CC_API_BASE: "http://" + HOST + ":" + apiPort,
    CC_USE_PROVIDER_MODELS: "false",
    CC_EMBEDDED_UPSTREAM: "0",
    CC_VERSION_TEST_REGISTRY_TARGET: "http://" + HOST + ":" + registryPort + "/registry",
    ...(refreshEnabled ? {
      CC_ENABLE_VERSION_REFRESH: "1",
      CC_VERSION_REFRESH_INTERVAL_MS: String(refreshIntervalMs ?? TEST_REFRESH_INTERVAL_MS),
      CC_VERSION_REFRESH_TIMEOUT_MS: String(REFRESH_TIMEOUT_MS),
    } : {}),
  });
  await waitUntil(async () => {
    try {
      const response = await requestOnce({ port, path: "/health", timeoutMs: 500 });
      return response.status === 200 && response.body === "OK";
    } catch {
      return false;
    }
  }, "upstream health");
  return { child, port };
}

async function runScenario({
  name,
  refreshEnabled,
  responses,
  expectedVersion = "0.32.3",
  expectedRegistryRequests = refreshEnabled ? 1 : 0,
  settleMs = 0,
  refreshIntervalMs,
}) {
  const registry = createRegistryServer();
  const api = createApiServer();
  const [{ port: registryPort }, { port: apiPort }] = await Promise.all([
    listenServer(registry.server),
    listenServer(api.server),
  ]);
  registry.state.responses = [...responses];
  let fixture;
  try {
    fixture = await startFixture({ apiPort, registryPort, refreshEnabled, refreshIntervalMs });
    if (expectedRegistryRequests > 0) {
      await waitUntil(
        () => registry.state.requests >= expectedRegistryRequests,
        name + " registry request",
        STARTUP_TIMEOUT_MS
      );
    }
    if (settleMs > 0) await sleep(settleMs);
    const response = await requestOnce({
      port: fixture.port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + API_KEY,
      },
      body: JSON.stringify({ model: "f18-model", messages: [] }),
    });
    assert(response.status === 200, name + " service request failed: " + response.status + " " + response.body);
    assert(api.state.versions.length > 0, name + " did not reach generate");
    assert(api.state.versions.at(-1) === expectedVersion,
      name + " polluted protocol version: " + api.state.versions.at(-1) + " (expected " + expectedVersion + ")");
    assert(!/UnhandledPromiseRejection|unhandledRejection/i.test(fixture.child.output),
      name + " emitted an unhandled rejection: " + fixture.child.output);
    assert(!fixture.child.killed && fixture.child.exitCode === null,
      name + " process stopped before the service assertion");
    console.log("  PASS " + name + " (registry=" + registry.state.requests + ", version=" + api.state.versions.at(-1) + ")");
  } finally {
    if (fixture) await stopChild(fixture.child, name);
    await closeServer(registry.server);
    await closeServer(api.server);
  }
}

async function testDefaultOffline() {
  await runScenario({
    name: "default offline startup",
    refreshEnabled: false,
    responses: [{ type: "status", status: 503 }],
    expectedRegistryRequests: 0,
    settleMs: 180,
  });
}

async function testValidRefresh() {
  await runScenario({
    name: "explicit valid registry refresh",
    refreshEnabled: true,
    responses: [{ type: "json", body: '{"version":"0.32.4"}' }],
    expectedVersion: "0.32.4",
  });
}

async function testRejectedResponses() {
  const cases = [
    ["malformed semver", '{"version":"0.32"}'],
    ["major out of range", '{"version":"1.0.0"}'],
    ["minor out of range", '{"version":"0.33.0"}'],
    ["older patch", '{"version":"0.32.2"}'],
    ["wrong JSON shape", '{"name":"command-code"}'],
    ["invalid JSON", "not-json"],
  ];
  for (const [name, body] of cases) {
    await runScenario({
      name: "reject " + name,
      refreshEnabled: true,
      responses: [{ type: "json", body }],
      expectedRegistryRequests: 1,
      refreshIntervalMs: 10000,
      settleMs: 180,
    });
  }
  await runScenario({
    name: "reject oversized response",
    refreshEnabled: true,
    responses: [{ type: "json", body: '{"version":"0.32.4","padding":"' + "x".repeat(20 * 1024) + '"}' }],
    refreshIntervalMs: 10000,
    settleMs: 180,
  });
  await runScenario({
    name: "reject registry 5xx",
    refreshEnabled: true,
    responses: [{ type: "status", status: 503 }],
    refreshIntervalMs: 10000,
    settleMs: 180,
  });
  await runScenario({
    name: "reject registry timeout",
    refreshEnabled: true,
    responses: [{ type: "timeout", delayMs: REFRESH_TIMEOUT_MS * 4 }],
    refreshIntervalMs: 10000,
    settleMs: REFRESH_TIMEOUT_MS * 2,
  });
}

async function testRefreshBoundary() {
  await runScenario({
    name: "24h refresh boundary",
    refreshEnabled: true,
    refreshIntervalMs: TEST_REFRESH_INTERVAL_MS,
    responses: [
      { type: "json", body: '{"version":"0.32.4"}' },
      { type: "json", body: '{"version":"0.32.5"}' },
      { type: "json", body: '{"version":"0.32.5"}' },
    ],
    expectedVersion: "0.32.5",
    expectedRegistryRequests: 2,
  });
}

async function main() {
  await testDefaultOffline();
  await testValidRefresh();
  await testRejectedResponses();
  await testRefreshBoundary();
  for (const child of children) await stopChild(child, "residual upstream");
  console.log("upstream version tests passed.");
}

main().catch(async (error) => {
  for (const child of children) await stopChild(child, "residual upstream").catch(() => {});
  console.error(error.stack || error);
  process.exitCode = 1;
});
