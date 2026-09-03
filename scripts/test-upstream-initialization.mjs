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
const MOCK_ENTRY = resolve(ROOT, "scripts/mock-upstream.mjs");
const MANAGER_ENTRY = resolve(ROOT, "src/server.mjs");
const HOST = "127.0.0.1";
const ADMIN_TOKEN = "upstream-init-admin";
const CLIENT_TOKEN = "upstream-init-client";
const KEY_A = "user_init_key_a";
const KEY_B = "user_init_key_b";
const STARTUP_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 5000;

const children = new Set();

function errorText(error) {
  return error instanceof Error ? `${error.code ? `${error.code}: ` : ""}${error.message}` : String(error);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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

function waitForExit(child, timeoutMs, label) {
  if (!child || child.exitCode !== null || child.signalCode) {
    return Promise.resolve();
  }
  return new Promise((resolvePromise, reject) => {
    let timer;
    const onClose = () => {
      clearTimeout(timer);
      child.off("close", onClose);
      child.off("error", onError);
      resolvePromise();
    };
    const onError = (error) => {
      clearTimeout(timer);
      child.off("close", onClose);
      child.off("error", onError);
      reject(new Error(`${label} 子进程错误：${errorText(error)}`));
    };
    child.once("close", onClose);
    child.once("error", onError);
    timer = setTimeout(() => {
      child.off("close", onClose);
      child.off("error", onError);
      reject(new Error(`${label} 未在 ${timeoutMs}ms 内退出\n${child.output}`));
    }, timeoutMs);
    timer.unref?.();
  });
}

async function stopChild(child, label) {
  if (!child || (child.exitCode !== null && child.exitCode !== undefined) || child.signalCode) return;
  try { child.kill("SIGTERM"); } catch {}
  try {
    await waitForExit(child, 3000, label);
  } catch {
    try { child.kill("SIGKILL"); } catch {}
    await waitForExit(child, 1000, `${label} SIGKILL`).catch(() => {});
  }
}

function listenServer(server, port = 0) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const onError = (error) => {
      if (settled) return;
      settled = true;
      server.off("listening", onListening);
      reject(new Error(`真实网络 socket 测试不可用：${errorText(error)}`));
    };
    const onListening = () => {
      if (settled) return;
      settled = true;
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("动态端口获取失败"));
        return;
      }
      resolvePromise({ server, port: address.port });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try { server.listen({ host: HOST, port }); } catch (error) { onError(error); }
  });
}

async function reservePort() {
  const result = await listenServer(net.createServer(), 0);
  await new Promise((resolvePromise, reject) => result.server.close((error) => error ? reject(error) : resolvePromise()));
  return result.port;
}

function requestOnce({ port, path, method = "GET", headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolvePromise, reject) => {
    let response;
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
      response = res;
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
      try { response?.destroy(); } catch {}
      try { req.destroy(); } catch {}
      finish(reject, new Error(`HTTP ${method} ${path} 超时`));
    }, timeoutMs);
    timer.unref?.();
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function openAbortableGatewayRequest(port) {
  let resolveDone;
  let settled = false;
  const done = new Promise((resolvePromise) => { resolveDone = resolvePromise; });
  const finish = (outcome, detail = "") => {
    if (settled) return;
    settled = true;
    resolveDone({ outcome, detail });
  };
  const req = http.request({
    host: HOST,
    port,
    path: "/v1/chat/completions",
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CLIENT_TOKEN}` },
    agent: false,
  }, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => finish("end", Buffer.concat(chunks).toString("utf8")));
    res.on("aborted", () => finish("aborted", Buffer.concat(chunks).toString("utf8")));
    res.on("error", (error) => finish("response-error", errorText(error)));
  });
  req.on("error", (error) => finish("request-error", errorText(error)));
  req.on("close", () => finish("closed"));
  req.end(JSON.stringify({ model: "m-init-abort", messages: [] }));
  return { request: req, done };
}

async function waitUntil(predicate, label, timeoutMs = STARTUP_TIMEOUT_MS) {
  const startedAt = performance.now();
  let lastError = "";
  while (performance.now() - startedAt < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = errorText(error);
    }
    await sleep(25);
  }
  throw new Error(`${label} 超时${lastError ? `：${lastError}` : ""}`);
}

async function waitForHttp(port, path, predicate, label) {
  await waitUntil(async () => {
    try {
      const response = await requestOnce({ port, path, timeoutMs: 1000 });
      return predicate(response);
    } catch {
      return false;
    }
  }, label);
}

async function startMock(port) {
  const child = spawnNode([MOCK_ENTRY], { MOCK_HOST: HOST, MOCK_PORT: String(port) });
  await waitForHttp(port, "/health", (response) => response.status === 200 && response.body === "OK", "mock upstream");
  return child;
}

function makeDataDir({ managerPort, upstreamPort, keys, strategy }) {
  const dataDir = mkdtempSync(join(tmpdir(), "ccpm-upstream-init-"));
  chmodSync(dataDir, 0o700);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    port: managerPort,
    host: HOST,
    upstreamPort,
    upstreamHost: HOST,
    adminToken: ADMIN_TOKEN,
    clientToken: CLIENT_TOKEN,
    pool: {
      strategy,
      maxRetries: 0,
      sameKeyRetryCount: 0,
      quotaRefreshMs: 3600000,
    },
  }));
  writeFileSync(join(dataDir, "keys.json"), JSON.stringify({
    keys: keys.map((key, index) => ({
      id: `init-key-${index}`,
      key,
      alias: key === KEY_A ? "keyA" : "keyB",
      enabled: true,
      priority: index,
      createdAt: Date.now() + index,
    })),
  }));
  writeFileSync(join(dataDir, "state.json"), JSON.stringify({ keys: {} }));
  return dataDir;
}

async function controlInit(mockPort, auth, init) {
  const response = await requestOnce({
    port: mockPort,
    path: "/__control",
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify({ auth, responses: [], init }),
  });
  if (response.status !== 200) throw new Error(`mock control failed: ${response.status} ${response.body}`);
}

async function resetMock(mockPort) {
  const response = await requestOnce({
    port: mockPort,
    path: "/__reset",
    method: "POST",
    headers: { Connection: "close" },
    body: "",
  });
  if (response.status !== 200) throw new Error(`mock reset failed: ${response.status}`);
}

async function initCalls(mockPort) {
  const response = await requestOnce({ port: mockPort, path: "/__init-calls", headers: { Connection: "close" } });
  if (response.status !== 200) throw new Error(`mock init calls failed: ${response.status}`);
  const payload = JSON.parse(response.body);
  return { calls: Array.isArray(payload.calls) ? payload.calls : [], maxActive: payload.maxActive };
}

async function chatCalls(mockPort) {
  const response = await requestOnce({ port: mockPort, path: "/__calls", headers: { Connection: "close" } });
  if (response.status !== 200) throw new Error(`mock calls failed: ${response.status}`);
  const payload = JSON.parse(response.body);
  return Array.isArray(payload.calls) ? payload.calls : [];
}

async function gateway(port, model) {
  return requestOnce({
    port,
    path: "/v1/chat/completions",
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CLIENT_TOKEN}` },
    body: JSON.stringify({ model, messages: [] }),
  });
}

async function withManager({ mockPort, keys, strategy = "active-standby", initTimeoutMs = 1000 }, callback) {
  const managerPort = await reservePort();
  const upstreamPort = await reservePort();
  const dataDir = makeDataDir({ managerPort, upstreamPort, keys, strategy });
  const manager = spawnNode([MANAGER_ENTRY], {
    DATA_DIR: dataDir,
    PORT: String(managerPort),
    HOST,
    UPSTREAM_HOST: HOST,
    UPSTREAM_PORT: String(upstreamPort),
    EMBED_UPSTREAM: "1",
    ADMIN_TOKEN,
    CLIENT_TOKEN,
    CC_API_BASE: `http://${HOST}:${mockPort}`,
    CC_QUOTA_BASE: `http://${HOST}:${mockPort}`,
    CC_INIT_TIMEOUT_MS: String(initTimeoutMs),
  });
  try {
    await waitForHttp(managerPort, "/health", (response) => response.status === 200 && response.body === "OK", "embedded manager");
    return await callback({ managerPort, manager });
  } finally {
    await stopChild(manager, "embedded manager");
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNoUnhandled(manager, label) {
  assert(!/UnhandledPromiseRejection|unhandledRejection/i.test(manager.output), `${label} 出现 unhandled rejection：${manager.output}`);
}

async function testSameKeyConcurrent(mockPort) {
  await resetMock(mockPort);
  await controlInit(mockPort, KEY_A, {
    fingerprint: [{ mode: "delay", delayMs: 180 }],
    lifecycle: [{ mode: "delay", delayMs: 180 }],
  });
  await withManager({ mockPort, keys: [KEY_A] }, async ({ managerPort, manager }) => {
    const startedAt = performance.now();
    const [one, two] = await Promise.all([gateway(managerPort, "same-key-1"), gateway(managerPort, "same-key-2")]);
    const elapsed = Math.round(performance.now() - startedAt);
    const init = await initCalls(mockPort);
    const chats = await chatCalls(mockPort);
    if (!(one.status === 200 && two.status === 200)) {
      const keyState = await requestOnce({ port: managerPort, path: "/admin/api/keys", headers: { "X-Admin-Token": ADMIN_TOKEN, Connection: "close" } });
      throw new Error(`同 Key 并发主请求失败：${one.status}/${two.status}\nkeys=${keyState.body}\n${manager.output}`);
    }
    assert(init.calls.length === 2, `同 Key 并发应只有 1 对初始化请求，实际 ${init.calls.length}`);
    assert(init.calls.every((call) => call.auth === KEY_A), "同 Key 初始化混入了其他 API Key");
    assert(init.maxActive >= 2, `同 Key 的 fingerprint/lifecycle 未并发：maxActive=${init.maxActive}`);
    assert(chats.length === 2 && chats.every((call) => call.auth === KEY_A), "同 Key 并发主请求未完整完成");
    assert(elapsed >= 150 && elapsed < 800, `同 Key 并发耗时不符合一对请求共享：${elapsed}ms`);
    assertNoUnhandled(manager, "同 Key 并发");
    console.log(`  PASS 同 Key 并发 single-flight（2 init calls, ${elapsed}ms）`);
  });
}

async function testDifferentKeyConcurrent(mockPort) {
  await resetMock(mockPort);
  await controlInit(mockPort, KEY_A, {
    fingerprint: [{ mode: "delay", delayMs: 220 }],
    lifecycle: [{ mode: "delay", delayMs: 220 }],
  });
  await controlInit(mockPort, KEY_B, {
    fingerprint: [{ mode: "delay", delayMs: 220 }],
    lifecycle: [{ mode: "delay", delayMs: 220 }],
  });
  await withManager({ mockPort, keys: [KEY_A, KEY_B], strategy: "round-robin" }, async ({ managerPort, manager }) => {
    const [one, two] = await Promise.all([gateway(managerPort, "different-key-1"), gateway(managerPort, "different-key-2")]);
    const init = await initCalls(mockPort);
    const chats = await chatCalls(mockPort);
    const auths = new Set(init.calls.map((call) => call.auth));
    assert(one.status === 200 && two.status === 200, `不同 Key 并发主请求失败：${one.status}/${two.status}`);
    assert(init.calls.length === 4, `不同 Key 并发应有两对初始化请求，实际 ${init.calls.length}`);
    assert(auths.size === 2 && auths.has(KEY_A) && auths.has(KEY_B), `不同 Key 初始化 Key 集合异常：${[...auths]}`);
    assert(init.calls.filter((call) => call.auth === KEY_A).length === 2 && init.calls.filter((call) => call.auth === KEY_B).length === 2, "不同 Key 初始化请求数量异常");
    assert(init.maxActive >= 4, `不同 Key 初始化未并行执行：maxActive=${init.maxActive}`);
    assert(chats.length === 2 && new Set(chats.map((call) => call.auth)).size === 2, "不同 Key 主请求未分别使用两个 Key");
    assertNoUnhandled(manager, "不同 Key 并发");
    console.log("  PASS 不同 Key 并发保持独立并行（4 init calls, maxActive>=4）");
  });
}

async function testFailureRetry(mockPort, { name, fingerprint, lifecycle }) {
  await resetMock(mockPort);
  await controlInit(mockPort, KEY_A, { fingerprint, lifecycle });
  await withManager({ mockPort, keys: [KEY_A] }, async ({ managerPort, manager }) => {
    const first = await gateway(managerPort, `${name}-first`);
    const firstCalls = await initCalls(mockPort);
    assert(first.status === 200, `${name} 后主请求不应被预请求失败阻断：${first.status}`);
    assert(firstCalls.calls.length === 2, `${name} 首次应发一对初始化请求，实际 ${firstCalls.calls.length}`);
    await waitUntil(async () => (await initCalls(mockPort)).calls.every((call) => call.end !== undefined), `${name} 初始化请求收尾`);

    const second = await gateway(managerPort, `${name}-retry`);
    const secondCalls = await initCalls(mockPort);
    assert(second.status === 200, `${name} 重试主请求失败：${second.status}`);
    assert(secondCalls.calls.length === 4, `${name} 失败后应立即重新发一对初始化请求，实际 ${secondCalls.calls.length}`);
    assertNoUnhandled(manager, name);
    console.log(`  PASS ${name} 严格失败语义与后续重试（${secondCalls.calls.length} init calls）`);
  });
}

async function testTimeoutRetry(mockPort) {
  await resetMock(mockPort);
  await controlInit(mockPort, KEY_A, {
    fingerprint: [{ mode: "delay", delayMs: 500 }],
    lifecycle: [{ mode: "delay", delayMs: 500 }],
  });
  await withManager({ mockPort, keys: [KEY_A], initTimeoutMs: 120 }, async ({ managerPort, manager }) => {
    const startedAt = performance.now();
    const first = await gateway(managerPort, "timeout-first");
    const elapsed = Math.round(performance.now() - startedAt);
    const firstCalls = await initCalls(mockPort);
    assert(first.status === 200, `初始化超时不应阻断主请求：${first.status}`);
    assert(elapsed >= 80 && elapsed < 800, `初始化超时未按有界策略结束：${elapsed}ms`);
    assert(firstCalls.calls.length === 2, `超时首次应有一对初始化请求，实际 ${firstCalls.calls.length}`);
    await waitUntil(async () => (await initCalls(mockPort)).calls.every((call) => call.end !== undefined), "超时初始化请求收尾", 2000);
    const completed = await initCalls(mockPort);
    assert(completed.calls.every((call) => call.aborted), "初始化超时后底层请求未收到 abort");

    const second = await gateway(managerPort, "timeout-retry");
    const secondCalls = await initCalls(mockPort);
    assert(second.status === 200, `超时后重试主请求失败：${second.status}`);
    assert(secondCalls.calls.length === 4, `超时后不能保留长节流窗口，实际 ${secondCalls.calls.length} 次初始化请求`);
    assertNoUnhandled(manager, "初始化超时");
    console.log(`  PASS 初始化超时有界收尾并重试（${elapsed}ms）`);
  });
}

async function testBodyTimeoutRetry(mockPort) {
  await resetMock(mockPort);
  await controlInit(mockPort, KEY_A, {
    fingerprint: [{ mode: "bodyhang" }],
    lifecycle: [{ mode: "bodyhang" }],
  });
  await withManager({ mockPort, keys: [KEY_A], initTimeoutMs: 120 }, async ({ managerPort, manager }) => {
    const startedAt = performance.now();
    const first = await gateway(managerPort, "body-timeout-first");
    const elapsed = Math.round(performance.now() - startedAt);
    const firstCalls = await initCalls(mockPort);
    assert(first.status === 200, `初始化 body 超时不应阻断主请求：${first.status}`);
    assert(elapsed >= 80 && elapsed < 800, `初始化 body 超时未按有界策略结束：${elapsed}ms`);
    assert(firstCalls.calls.length === 2, `body 超时首次应有一对初始化请求，实际 ${firstCalls.calls.length}`);
    await waitUntil(async () => (await initCalls(mockPort)).calls.every((call) => call.end !== undefined), "初始化 body 超时请求收尾", 2000);
    const completed = await initCalls(mockPort);
    assert(completed.calls.every((call) => call.aborted), "初始化 body 超时后底层请求未收到 abort");

    const second = await gateway(managerPort, "body-timeout-retry");
    const secondCalls = await initCalls(mockPort);
    assert(second.status === 200, `初始化 body 超时后重试主请求失败：${second.status}`);
    assert(secondCalls.calls.length === 4, `body 超时后不能保留长节流窗口，实际 ${secondCalls.calls.length} 次初始化请求`);
    assertNoUnhandled(manager, "初始化 body 超时");
    console.log(`  PASS 初始化 body 未结束时有界 abort 并重试（${elapsed}ms）`);
  });
}

async function testAbortCleanup(mockPort) {
  await resetMock(mockPort);
  await controlInit(mockPort, KEY_A, {
    fingerprint: [{ mode: "hang" }],
    lifecycle: [{ mode: "hang" }],
  });
  await withManager({ mockPort, keys: [KEY_A], initTimeoutMs: 2000 }, async ({ managerPort, manager }) => {
    const pending = openAbortableGatewayRequest(managerPort);
    await waitUntil(async () => (await initCalls(mockPort)).calls.length === 2, "abort 场景初始化启动");
    pending.request.destroy();
    const outcome = await Promise.race([
      pending.done,
      sleep(1500).then(() => ({ outcome: "test-timeout" })),
    ]);
    assert(outcome.outcome !== "test-timeout", "客户端 abort 后请求未及时收尾");
    await waitUntil(async () => {
      const calls = await initCalls(mockPort);
      return calls.calls.length === 2 && calls.calls.every((call) => call.end !== undefined);
    }, "客户端 abort 初始化请求收尾", 2000);
    const abortedCalls = await initCalls(mockPort);
    assert(abortedCalls.calls.every((call) => call.aborted), "客户端 abort 后底层初始化请求未全部 abort");

    const retry = await gateway(managerPort, "abort-retry");
    const calls = await initCalls(mockPort);
    assert(retry.status === 200, `abort 后新的主请求未成功：${retry.status}`);
    assert(calls.calls.length === 4, `abort 后 flight 未清理，新的请求未重新初始化：${calls.calls.length}`);
    assertNoUnhandled(manager, "初始化 abort");
    console.log(`  PASS 客户端 abort 传播、flight 清理且无 unhandled rejection（${outcome.outcome}）`);
  });
}

async function main() {
  let mock;
  try {
    const mockPort = await reservePort();
    mock = await startMock(mockPort);
    await testSameKeyConcurrent(mockPort);
    await testDifferentKeyConcurrent(mockPort);
    await testFailureRetry(mockPort, {
      name: "半成功",
      fingerprint: [{ mode: "status", status: 503 }],
      lifecycle: [{ mode: "ok" }],
    });
    await testFailureRetry(mockPort, {
      name: "全失败",
      fingerprint: [{ mode: "status", status: 503 }],
      lifecycle: [{ mode: "status", status: 503 }],
    });
    await testFailureRetry(mockPort, {
      name: "网络异常",
      fingerprint: [{ mode: "drop" }],
      lifecycle: [{ mode: "ok" }],
    });
    await testTimeoutRetry(mockPort);
    await testBodyTimeoutRetry(mockPort);
    await testAbortCleanup(mockPort);
    console.log("upstream initialization tests passed.");
  } finally {
    await stopChild(mock, "mock upstream");
    for (const child of children) await stopChild(child, "残留子进程");
  }
}

main().catch((error) => {
  console.error("upstream initialization tests failed:", errorText(error));
  process.exitCode = 1;
});
