import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import {
  startUpstream,
  UpstreamProcessError,
} from "../src/upstreamProcess.mjs";

const HOST = "127.0.0.1";
const TEST_TIMEOUT_MS = 5_000;
const PORT_CLOSE_TIMEOUT_MS = 2_000;

const FIXTURE_SOURCE = String.raw`
import http from "node:http";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT);
const mode = process.env.FIXTURE_MODE || "normal";

function write(stream, text) {
  process[stream].write(text);
}

if (mode === "immediate-exit") {
  write("stdout", "fixture immediate stdout\n");
  write("stderr", "fixture immediate diagnostic\n");
  process.exit(23);
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    if (mode === "unhealthy") {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("not ready");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.on("error", (error) => {
  write("stderr", "fixture server error " + (error.code || error.message) + "\n");
});

function stopGracefully() {
  write("stdout", "fixture received SIGTERM\n");
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => {
  if (mode === "ignore-term") {
    write("stderr", "fixture ignored SIGTERM\n");
    return;
  }
  stopGracefully();
});

server.listen(port, host, () => {
  write("stdout", "fixture listening\n");
  if (mode === "chunk-output") {
    setTimeout(() => write("stdout", "stdout-frag"), 0);
    setTimeout(() => write("stdout", "ment\n"), 5);
    setTimeout(() => write("stderr", "stderr-frag"), 10);
    setTimeout(() => write("stderr", "ment\n"), 15);
  }
  if (mode === "exit-after-ready") {
    setTimeout(() => {
      write("stderr", "fixture unexpected exit\n");
      process.exit(17);
    }, 80);
  }
});
`;

function assertCondition(condition, message) {
  assert.equal(Boolean(condition), true, message);
}

function errorText(error) {
  if (error instanceof Error) return `${error.code ? `${error.code}: ` : ""}${error.message}`;
  return String(error);
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
        reject(new Error("dynamic port allocation returned no address"));
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
  await bounded(closePromise, PORT_CLOSE_TIMEOUT_MS, `${label} close`);
}

async function reservePort() {
  const result = await listenServer(net.createServer());
  try {
    return result.port;
  } finally {
    await closeServer(result.server, new Set(), "reserved port");
  }
}

function requestText(port, path, timeoutMs = 1_000) {
  return new Promise((resolvePromise, reject) => {
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
    const req = http.request({ host: HOST, port, path, method: "GET", agent: false }, (res) => {
      response = res;
      res.on("data", (chunk) => chunks.push(chunk));
      res.once("end", () => finish(resolvePromise, {
        status: res.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      res.once("aborted", () => finish(reject, new Error(`HTTP ${path} response aborted`)));
      res.once("error", (error) => finish(reject, error));
      res.once("close", () => {
        if (!settled && !res.complete) finish(reject, new Error(`HTTP ${path} response closed`));
      });
    });
    req.once("error", (error) => finish(reject, error));
    timer = setTimeout(() => {
      try { response?.destroy(); } catch {}
      try { req.destroy(); } catch {}
      finish(reject, new Error(`HTTP GET ${path} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    req.end();
  });
}

async function assertPortReusable(port, label) {
  let result;
  try {
    result = await listenServer(net.createServer(), port);
  } catch (error) {
    throw new Error(`${label}: port ${port} is not reusable: ${errorText(error)}`);
  }
  await closeServer(result.server, new Set(), `${label} reusable check`);
}

function diagnostics(runtime) {
  if (!runtime) return "<runtime unavailable>";
  let status;
  try { status = runtime.getStatus(); } catch (error) { status = { statusError: errorText(error) }; }
  let logs;
  try { logs = runtime.getDiagnostics(); } catch (error) { logs = { diagnosticsError: errorText(error) }; }
  return `${JSON.stringify(status)}\nrecent logs=${JSON.stringify(logs)}`;
}

function startFixture(fixturePath, port, mode, options = {}) {
  return startUpstream({
    command: process.execPath,
    args: [fixturePath],
    cwd: dirname(fixturePath),
    host: HOST,
    port,
    startupTimeoutMs: options.startupTimeoutMs ?? 1_000,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 150,
    healthIntervalMs: options.healthIntervalMs ?? 20,
    healthRequestTimeoutMs: options.healthRequestTimeoutMs ?? 100,
    env: { FIXTURE_MODE: mode },
    onOutput: options.onOutput,
    onUnexpectedExit: options.onUnexpectedExit,
  });
}

async function stopRuntime(runtime, label) {
  if (!runtime) return;
  let stopError;
  try {
    await bounded(runtime.stop({ reason: `${label} cleanup` }), TEST_TIMEOUT_MS, `${label} stop`);
  } catch (error) {
    stopError = error;
  }
  try {
    await bounded(runtime.exit, TEST_TIMEOUT_MS, `${label} exit`);
  } catch (error) {
    if (!stopError) stopError = error;
  }
  if (stopError) throw stopError;
}

async function withRuntime(fixturePath, mode, test, options = {}) {
  const port = await reservePort();
  let runtime;
  let testError;
  let cleanupError;
  try {
    runtime = startFixture(fixturePath, port, mode, options);
    await test(runtime, port);
  } catch (error) {
    testError = error;
    if (runtime) {
      testError = new Error(`${errorText(error)}\n${diagnostics(runtime)}`, { cause: error });
    }
  } finally {
    try {
      await stopRuntime(runtime, `${mode} runtime`);
    } catch (error) {
      cleanupError = error;
    }
    try {
      await assertPortReusable(port, `${mode} cleanup`);
    } catch (error) {
      cleanupError ||= error;
    }
  }
  if (testError) throw testError;
  if (cleanupError) throw cleanupError;
}

async function testNormalHealth(fixturePath) {
  await withRuntime(fixturePath, "normal", async (runtime, port) => {
    const ready = await bounded(runtime.ready, TEST_TIMEOUT_MS, "normal ready");
    assertCondition(ready === runtime, "ready should resolve with the runtime");
    const response = await requestText(port, "/health");
    assert.equal(response.status, 200);
    assert.equal(response.body, "OK");
    assert.equal(runtime.isReady(), true);
  });
}

async function testImmediateExitAndDiagnostics(fixturePath) {
  await withRuntime(fixturePath, "immediate-exit", async (runtime) => {
    const error = await bounded(
      runtime.ready.then(
        () => { throw new Error("immediate-exit ready unexpectedly resolved"); },
        (readyError) => readyError,
      ),
      TEST_TIMEOUT_MS,
      "immediate-exit readiness failure",
    );
    assert(error instanceof UpstreamProcessError, "immediate exit should produce UpstreamProcessError");
    assert.equal(error.exitCode, 23);
    assert.match(error.message, /fixture immediate diagnostic/);
    assert.match(error.message, /fixture immediate stdout/);
    assert.equal(error.recentLogs.stderr.some((line) => line.includes("fixture immediate diagnostic")), true);
    assert.equal(runtime.isRunning(), false);
  });
}

async function testUnhealthyTimeoutAndReap(fixturePath) {
  await withRuntime(fixturePath, "unhealthy", async (runtime) => {
    const startedAt = performance.now();
    const error = await bounded(
      runtime.ready.then(
        () => { throw new Error("unhealthy ready unexpectedly resolved"); },
        (readyError) => readyError,
      ),
      TEST_TIMEOUT_MS,
      "unhealthy readiness timeout",
    );
    const elapsed = performance.now() - startedAt;
    assert(error instanceof UpstreamProcessError, "unhealthy startup should produce UpstreamProcessError");
    assert.match(error.message, /did not become ready within/);
    assert.equal(elapsed >= 150, true, `timeout completed too early: ${elapsed}ms`);
    assert.equal(runtime.isRunning(), false);
    const exit = await bounded(runtime.exit, TEST_TIMEOUT_MS, "unhealthy exit");
    assert.equal(exit.phase, "stopped");
  }, { startupTimeoutMs: 250, shutdownTimeoutMs: 100 });
}

async function testOutputChunkForwarding(fixturePath) {
  const output = [];
  await withRuntime(fixturePath, "chunk-output", async (runtime) => {
    await bounded(runtime.ready, TEST_TIMEOUT_MS, "chunk-output ready");
    await sleep(80);
    const stdout = output.filter((entry) => entry.stream === "stdout").map((entry) => entry.text).join("");
    const stderr = output.filter((entry) => entry.stream === "stderr").map((entry) => entry.text).join("");
    assert.match(stdout, /stdout-fragment\n/);
    assert.match(stderr, /stderr-fragment\n/);
    assert.equal(output.some((entry) => entry.stream === "stdout" && entry.partial), false);
    assert.equal(output.some((entry) => entry.stream === "stderr" && entry.partial), false);
    assert.match(runtime.getDiagnostics().stdout.join(""), /stdout-fragment/);
    assert.match(runtime.getDiagnostics().stderr.join(""), /stderr-fragment/);
  }, {
    onOutput: (entry) => output.push(entry),
  });
}

async function testGracefulSigterm(fixturePath) {
  await withRuntime(fixturePath, "normal", async (runtime) => {
    await bounded(runtime.ready, TEST_TIMEOUT_MS, "SIGTERM ready");
    const stopResult = await bounded(runtime.stop({ reason: "graceful test" }), TEST_TIMEOUT_MS, "SIGTERM stop");
    const exit = await bounded(runtime.exit, TEST_TIMEOUT_MS, "SIGTERM exit");
    assert.equal(exit.exitCode, 0);
    assert.equal(exit.signal, null);
    assert.equal(stopResult.phase, "stopped");
    assert.equal(runtime.isRunning(), false);
  });
}

async function testSigkillFallback(fixturePath) {
  await withRuntime(fixturePath, "ignore-term", async (runtime) => {
    await bounded(runtime.ready, TEST_TIMEOUT_MS, "SIGKILL fallback ready");
    const stopResult = await bounded(runtime.stop({ reason: "fallback test" }), TEST_TIMEOUT_MS, "SIGKILL fallback stop");
    const exit = await bounded(runtime.exit, TEST_TIMEOUT_MS, "SIGKILL fallback exit");
    assert.equal(exit.signal, "SIGKILL");
    assert.equal(stopResult.forcedKill, true);
    assert.equal(runtime.getStatus().forcedKill, true);
  }, { shutdownTimeoutMs: 100 });
}

async function testMultipleStop(fixturePath) {
  await withRuntime(fixturePath, "normal", async (runtime) => {
    await bounded(runtime.ready, TEST_TIMEOUT_MS, "multiple stop ready");
    const first = runtime.stop({ reason: "first stop" });
    const second = runtime.stop({ reason: "second stop" });
    const third = runtime.stop({ reason: "third stop" });
    assert.equal(first, second);
    assert.equal(second, third);
    const results = await Promise.all([
      bounded(first, TEST_TIMEOUT_MS, "first stop"),
      bounded(second, TEST_TIMEOUT_MS, "second stop"),
      bounded(third, TEST_TIMEOUT_MS, "third stop"),
    ]);
    assert.equal(results[0].phase, "stopped");
    assert.equal((await bounded(runtime.exit, TEST_TIMEOUT_MS, "multiple stop exit")).phase, "stopped");
  });
}

async function testUnexpectedExitOnce(fixturePath) {
  let callbackCount = 0;
  let callbackInfo;
  let resolveCallback;
  const callbackSeen = new Promise((resolve) => { resolveCallback = resolve; });
  await withRuntime(fixturePath, "exit-after-ready", async (runtime) => {
    await bounded(runtime.ready, TEST_TIMEOUT_MS, "unexpected exit ready");
    const exit = await bounded(runtime.exit, TEST_TIMEOUT_MS, "unexpected exit");
    assert.equal(exit.exitCode, 17);
    assert.equal(exit.signal, null);
    callbackInfo = await bounded(callbackSeen, TEST_TIMEOUT_MS, "unexpected exit callback");
    assert.equal(callbackCount, 1);
    assert.equal(callbackInfo.unexpected, true);
    assert.match(callbackInfo.error.message, /upstream exited unexpectedly/);
    await bounded(runtime.stop({ reason: "post-exit stop" }), TEST_TIMEOUT_MS, "post-exit stop");
    await bounded(runtime.stop({ reason: "post-exit second stop" }), TEST_TIMEOUT_MS, "post-exit second stop");
    assert.equal(callbackCount, 1);
  }, {
    onUnexpectedExit: (info) => {
      callbackCount += 1;
      callbackInfo = info;
      resolveCallback(info);
    },
  });
}

async function main() {
  const fixtureDir = mkdtempSync(join(tmpdir(), `ccpm-upstream-process-${process.pid}-`));
  const fixturePath = join(fixtureDir, "fixture.mjs");
  writeFileSync(fixturePath, FIXTURE_SOURCE, { mode: 0o600 });
  const cases = [
    ["normal startup and health", testNormalHealth],
    ["immediate exit diagnostics", testImmediateExitAndDiagnostics],
    ["unhealthy timeout and reap", testUnhealthyTimeoutAndReap],
    ["stdout/stderr chunk forwarding", testOutputChunkForwarding],
    ["graceful SIGTERM", testGracefulSigterm],
    ["SIGKILL fallback", testSigkillFallback],
    ["multiple stop", testMultipleStop],
    ["unexpected exit callback once", testUnexpectedExitOnce],
  ];
  try {
    for (const [label, test] of cases) {
      await test(fixturePath);
      console.log(`PASS ${label}`);
    }
    console.log("Upstream process tests: PASS");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Upstream process tests: FAIL\n${error.stack || errorText(error)}`);
  process.exitCode = 1;
});
