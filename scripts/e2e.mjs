// ── 端到端测试：external manager + hosted manager/upstream。
// 覆盖鉴权/主备切换/同Key重试/退避持久化/额度感知/统计/管理 API/流式/断连。
// 初始化并发和版本刷新由上游原始版本负责；本仓库只负责进程托管和网关行为。
import http from "http";
import net from "net";
import { performance } from "perf_hooks";
import { spawn } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, lstatSync, realpathSync, statSync } from "fs";
import { resolve, dirname, isAbsolute, join, relative, parse, sep } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const ADMIN = "e2e-admin-token-1234";
const CLIENT = "e2e-client-token-5678";
const SCENARIO = process.argv[2] || "";

let DATA;
let ownedData = false;
let dataLock = null;
let TEST_PORTS = null;
let UP;
let MG;

const activeRequests = new Set();
const activeSockets = new Set();
const activeTimers = new Set();
const children = new Set();

function trackedTimeout(fn, ms) {
  const timer = setTimeout(() => {
    activeTimers.delete(timer);
    fn();
  }, ms);
  activeTimers.add(timer);
  return timer;
}
function clearTrackedTimeout(timer) {
  if (!timer) return;
  clearTimeout(timer);
  activeTimers.delete(timer);
}
function trackedRequest(...args) {
  const req = http.request(...args);
  activeRequests.add(req);
  const release = () => activeRequests.delete(req);
  req.once("close", release);
  req.once("error", release);
  return req;
}
function trackedSocket(socket) {
  activeSockets.add(socket);
  const release = () => activeSockets.delete(socket);
  socket.once("close", release);
  socket.once("error", release);
  return socket;
}
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function canonicalPath(p) {
  try { return realpathSync(p); } catch { return resolve(p); }
}
function safeDataPath(input) {
  if (typeof input !== "string" || input.trim() === "") throw new Error("E2E_DATA 必须是非空路径");
  const target = resolve(input);
  const tmpRoot = canonicalPath(tmpdir());
  const targetReal = canonicalPath(target);
  const root = parse(target).root;
  if (target === root || target === tmpRoot || target === ROOT || isInside(target, ROOT) || isInside(ROOT, target)) {
    throw new Error(`拒绝危险 E2E_DATA：${input}（不得为根目录、临时根目录或仓库目录及其上下级）`);
  }
  // E2E 数据只能位于系统临时目录，避免误删生产挂载、工作区或用户数据。
  if (!(targetReal === tmpRoot || isInside(tmpRoot, targetReal))) {
    throw new Error(`拒绝危险 E2E_DATA：${input}（必须位于 ${tmpRoot} 下）`);
  }
  if (existsSync(target)) {
    const st = lstatSync(target);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`拒绝 E2E_DATA：${input}（必须是普通目录，不接受符号链接/文件）`);
  }
  return target;
}
function validateE2EData() {
  return process.env.E2E_DATA === undefined ? null : safeDataPath(process.env.E2E_DATA);
}
function prepareDataDir() {
  const requested = validateE2EData();
  if (requested === null) {
    DATA = mkdtempSync(join(tmpdir(), "ccpm-e2e-"));
    chmodSync(DATA, 0o700);
    ownedData = true;
    return DATA;
  }
  DATA = requested;
  // 同一路径并发运行时，先拿不可伪造的 mkdir 锁，再允许任何清理动作。
  dataLock = DATA + ".lock";
  try {
    mkdirSync(dirname(dataLock), { recursive: true, mode: 0o700 });
    mkdirSync(dataLock, { mode: 0o700 });
  } catch (e) {
    if (e.code === "EEXIST") throw new Error(`E2E_DATA 正在被另一份 e2e 使用：${DATA}`);
    throw e;
  }
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true, mode: 0o700 });
  chmodSync(DATA, 0o700);
  return DATA;
}
function privateTempDir(prefix) {
  const p = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(p, 0o700);
  return p;
}
function testUrl(port) { return `http://${HOST}:${port}`; }
function reservePort() {
  return new Promise((resolveP, rejectP) => {
    const server = net.createServer();
    const onError = (e) => { server.removeListener("listening", onListening); rejectP(e); };
    const onListening = () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((e) => e ? rejectP(e) : resolveP(port));
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: HOST, port: 0 });
  });
}
async function allocatePorts() {
  const names = ["manager", "mock", "corrupt", "semanticCorrupt", "badEnv", "tokenKeep", "readonly", "embedded", "embeddedUpstream"];
  const used = new Set();
  const ports = {};
  for (const name of names) {
    let port;
    do { port = await reservePort(); } while (used.has(port));
    used.add(port);
    ports[name] = port;
  }
  TEST_PORTS = ports;
  UP = testUrl(ports.mock);
  MG = testUrl(ports.manager);
  return ports;
}

let pass = 0, fail = 0;
const failures = [];
const sleep = (ms) => new Promise((r) => trackedTimeout(r, ms));
function ok(name, extra) { pass++; console.log(`  ✅ ${name}${extra ? " — " + extra : ""}`); }
function bad(name, detail) { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}\n     ${detail}`); }

function http1(url, method, headers, body, timeoutMs = HTTP1_TIMEOUT_MS) {
  return new Promise((resP, rejP) => {
    const u = new URL(url);
    let settled = false;
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTrackedTimeout(timer);
      fn(value);
    };
    const r = trackedRequest({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => finish(resP, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf-8") }));
      res.on("aborted", () => finish(rejP, Object.assign(new Error(`HTTP 响应被中止（${method} ${url}）`), { code: "ECONNRESET" })));
      res.on("error", (e) => finish(rejP, e));
    });
    r.on("error", (e) => finish(rejP, e));
    // 总超时护栏（L-h）：被测 server 回归挂起（如等待上游）时，http1 不得无限期等
    // 响应挂死整个 job。60s 高于任何设计内长用例（T11 真实等 18s），低于 CI 全局超时。
    timer = trackedTimeout(() => {
      try { r.destroy(); } catch {}
      finish(rejP, Object.assign(new Error(`http1 超时：${timeoutMs}ms 内未完成（${method} ${url}），被测服务疑似挂起`), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    if (body) r.write(body);
    r.end();
  });
}
// L-h：http1 总超时上限（env 可调；恒高于 T11 18s / rawGwOnce 8s race 等设计内长用例）
const HTTP1_TIMEOUT_MS = Number(process.env.E2E_HTTP_TIMEOUT_MS || 60000);
const mock = async (path, body) => {
  const response = await http1(UP + path, "POST", { "Content-Type": "application/json" }, body ? JSON.stringify(body) : "");
  if (["/__reset", "/__control"].includes(path)) {
    if (response.status !== 200) throw new Error(`mock ${path} 状态异常：${response.status}`);
    const data = parseJsonResponse(response, `mock ${path}`);
    if (data.ok !== true) throw new Error(`mock ${path} 响应缺少 ok=true：${response.body}`);
  }
  return response;
};
const mockGet = (path) => http1(UP + path, "GET", {});
const admin = (path, method = "GET", body) => http1(MG + path, method, { "X-Admin-Token": ADMIN, ...(body ? { "Content-Type": "application/json" } : {}) }, body ? JSON.stringify(body) : undefined);
const gw = (body, token = CLIENT) => http1(MG + "/v1/chat/completions", "POST", { "Content-Type": "application/json", Authorization: "Bearer " + token }, JSON.stringify(body));
function parseJsonResponse(response, label) {
  if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new Error(`${label} 缺少有效 HTTP status`);
  }
  try {
    const data = JSON.parse(response.body);
    if (data === null || typeof data !== "object") throw new Error("JSON 顶层必须是对象");
    return data;
  } catch (e) {
    throw new Error(`${label} 不是合法 JSON：${e.message}`);
  }
}
async function adminJson(path, method = "GET", body, expectedStatus = 200, validate) {
  const response = await admin(path, method, body);
  if (!Number.isInteger(response.status) || response.status !== expectedStatus) {
    throw new Error(`${method} ${path} 状态异常：期望 ${expectedStatus}，实际 ${response.status}，body=${response.body.slice(0, 300)}`);
  }
  const data = parseJsonResponse(response, `${method} ${path}`);
  if (validate) validate(data);
  return { response, data };
}
function validateKeysPayload(data) {
  if (!Array.isArray(data.keys)) throw new Error("keys API 缺少 keys 数组");
  for (const key of data.keys) {
    if (!key || typeof key.id !== "string" || !key.id || typeof key.alias !== "string" || typeof key.enabled !== "boolean" || !key.health || typeof key.health !== "object") {
      throw new Error(`keys API 条目结构异常：${JSON.stringify(key)}`);
    }
  }
}
async function addKey(alias, key) {
  return adminJson("/admin/api/keys", "POST", { alias, key }, 201, (data) => {
    if (typeof data.id !== "string" || !data.id || data.alias !== alias || typeof data.maskedKey !== "string" || typeof data.priority !== "number") {
      throw new Error(`添加 Key 响应结构异常：${JSON.stringify(data)}`);
    }
  });
}
const keysList = async () => (await adminJson("/admin/api/keys", "GET", undefined, 200, validateKeysPayload)).data.keys;
const historyForModel = async (model, path = "/admin/api/history?pageSize=500") => {
  const result = parseJsonResponse(await admin(path), "history for " + model);
  return result.items.filter((event) => event.model === model);
};

async function waitUp(url, timeout = 20000, child, predicate = (response) => response.status < 500) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) {
    if (child && (child.exitCode !== null || child.signalCode)) throw new Error(`${url} 对应进程提前退出`);
    try {
      const r = await http1(url, "GET", {});
      if (predicate(r)) return true;
    } catch {}
    await sleep(150);
  }
  if (child && (child.exitCode !== null || child.signalCode)) throw new Error(`${url} 对应进程提前退出`);
  return false;
}

function directChildPids(pid) {
  if (!Number.isInteger(pid)) return [];
  try {
    const text = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    return text ? text.split(/\s+/).filter(Boolean).map(Number) : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error(`无法检查进程 ${pid} 的直接子进程：${error.message}`);
  }
}

async function waitForDirectChild(pid, label, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  let last = [];
  while (performance.now() < deadline) {
    last = directChildPids(pid);
    if (last.length) return last[0];
    await sleep(25);
  }
  throw new Error(`${label} 在 ${timeoutMs}ms 内没有直接子进程：${last.join(",") || "none"}`);
}

async function assertPidGone(pid, label, timeoutMs = 2000) {
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
  throw new Error(`${label} 进程仍存在：${pid}`);
}

function listenAt(port) {
  return new Promise((resolveP, rejectP) => {
    const server = net.createServer((socket) => socket.destroy());
    const onError = (error) => {
      server.removeListener("listening", onListening);
      rejectP(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolveP(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: HOST, port });
  });
}

function closeNetServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolveP, rejectP) => {
    server.close((error) => error ? rejectP(error) : resolveP());
  });
}

function waitForChildExit(child, timeoutMs, label) {
  if (!child || child.exitCode !== null || child.signalCode) {
    return Promise.resolve({ code: child?.exitCode ?? null, signal: child?.signalCode ?? null });
  }
  return new Promise((resolveP, rejectP) => {
    let timer;
    const finish = (fn, value) => {
      clearTrackedTimeout(timer);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      fn(value);
    };
    const onClose = (code, signal) => finish(resolveP, { code, signal });
    const onError = (error) => finish(rejectP, error);
    child.once("close", onClose);
    child.once("error", onError);
    timer = trackedTimeout(() => finish(rejectP, new Error(`${label} 在 ${timeoutMs}ms 内未退出`)), timeoutMs);
  });
}

let mgr;
let mgrStderr = ""; // 始终捕获：供 P1-1 用例断言无 unhandledRejection 噪音
function spawnNode(args, env, stdio = ["ignore", "pipe", "pipe"]) {
  const child = spawn(process.execPath, args, { env, stdio });
  children.add(child);
  return child;
}
async function startMgr(env = {}) {
  mgr = spawnNode([resolve(ROOT, "src/server.mjs")], {
    ...process.env, DATA_DIR: DATA, PORT: String(TEST_PORTS.manager), HOST,
    UPSTREAM_HOST: HOST, UPSTREAM_PORT: String(TEST_PORTS.mock), EMBED_UPSTREAM: "0",
    ADMIN_TOKEN: ADMIN, CLIENT_TOKEN: CLIENT, CC_QUOTA_BASE: UP, ...env
  });
  mgrStderr = "";
  mgr.stderr.on("data", (d) => { mgrStderr += d; if (process.env.E2E_VERBOSE) process.stderr.write("[mgr!] " + d); });
  if (process.env.E2E_VERBOSE) {
    mgr.stdout.on("data", (d) => process.stdout.write("[mgr] " + d));
  }
  if (!await waitUp(MG + "/health", 20000, mgr)) throw new Error("manager not up");
}
// 原始 HTTP 请求 + 超时 race：验证连接被有限时间内终止（end/aborted/ECONNRESET），
// 而非挂死到 race 超时。超时分支必须销毁底层请求，避免 socket 泄漏。
function rawGwOnce(bodyObj, timeoutMs = 8000) {
  const t0 = performance.now();
  return new Promise((resolveP) => {
    let req;
    let res;
    let timer;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTrackedTimeout(timer);
      resolveP(result);
    };
    req = trackedRequest(MG + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + CLIENT }
    }, (response) => {
      res = response;
      let txt = "";
      response.on("data", (c) => (txt += c));
      response.on("end", () => finish({ outcome: "end", status: response.statusCode, ms: Math.round(performance.now() - t0), txt }));
      response.on("aborted", () => finish({ outcome: "aborted", status: response.statusCode, ms: Math.round(performance.now() - t0), txt }));
      response.on("error", (e) => finish({ outcome: "error:" + (e.code || e.message), status: response.statusCode, ms: Math.round(performance.now() - t0), txt }));
    });
    req.on("error", (e) => finish({ outcome: "error:" + (e.code || e.message), status: res?.statusCode, ms: Math.round(performance.now() - t0), txt: "" }));
    timer = trackedTimeout(() => {
      try { res?.destroy(); } catch {}
      try { req.destroy(); } catch {}
      finish({ outcome: "timeout", status: res?.statusCode, ms: Math.round(performance.now() - t0), txt: "" });
    }, timeoutMs);
    req.end(JSON.stringify(bodyObj));
  });
}
async function stopChild(child, name = "child") {
  if (!child) return;
  const waitExit = (timeoutMs) => new Promise((resolveP) => {
    if (child.exitCode !== null || child.signalCode) { resolveP(); return; }
    let done = false;
    let timer;
    const finish = () => {
      if (done) return;
      done = true;
      clearTrackedTimeout(timer);
      child.removeListener("exit", finish);
      child.removeListener("error", finish);
      resolveP();
    };
    child.once("exit", finish);
    child.once("error", finish);
    timer = trackedTimeout(finish, timeoutMs);
  });
  try {
    if (child.exitCode === null && !child.signalCode) child.kill("SIGTERM");
  } catch {}
  await waitExit(3000);
  if (child.exitCode === null && !child.signalCode) {
    try { child.kill("SIGKILL"); } catch {}
    await waitExit(1000);
    console.error(`[cleanup] ${name} 未在 SIGTERM 后退出，已 SIGKILL`);
  }
  children.delete(child);
}
async function stopMgr() {
  const child = mgr;
  mgr = null;
  await stopChild(child, "manager");
}
async function restartClean() {
  await sleep(1300); // 等 state.json 1s 防抖落盘
  await stopMgr();
  const p = resolve(DATA, "state.json");
  if (existsSync(p)) {
    const st = JSON.parse(readFileSync(p, "utf-8"));
    for (const h of Object.values(st.keys || {})) {
      h.backoffUntilMs = 0; h.failCount = 0; h.lastErrorKind = "";
      h.quotaLimitedUntil = 0; h.authError = false;
      h.failoverCount = 0; h.lastFailoverAt = 0;
    }
    writeFileSync(p, JSON.stringify(st));
  }
  await startMgr();
  await mock("/__reset");
}

function runChildForTest(args, env = {}) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    let timer;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTrackedTimeout(timer);
      resolveP(result);
    };
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.once("error", (e) => finish({ code: 2, signal: null, stdout, stderr: stderr + e.message }));
    // close 在 exit 之后触发，并保证 stdout/stderr 已经关闭，避免提前读取造成假失败。
    child.once("close", (code, signal) => finish({ code, signal, stdout, stderr }));
    timer = trackedTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish({ code: 124, signal: "SIGKILL", stdout, stderr: stderr + "子进程测试超时" });
    }, 10000);
  });
}

async function harnessProbe() {
  let probeData = null;
  try {
    validateE2EData();
    await allocatePorts();
    probeData = prepareDataDir();
    console.log(JSON.stringify({ data: probeData, ports: TEST_PORTS }));
  } finally {
    for (const req of [...activeRequests]) { try { req.destroy(); } catch {} }
    for (const socket of [...activeSockets]) { try { socket.destroy(); } catch {} }
    for (const timer of [...activeTimers]) clearTrackedTimeout(timer);
    if (ownedData && probeData) { try { rmSync(probeData, { recursive: true, force: true }); } catch {} }
    if (dataLock) { try { rmSync(dataLock, { recursive: true, force: true }); } catch {} }
  }
}

async function harnessRegression() {
  const packageFile = resolve(ROOT, "package.json");
  if (!existsSync(packageFile)) throw new Error("回归前置条件失败：仓库文件不存在");

  const dangerTargets = [".", ROOT, parse(ROOT).root, tmpdir()];
  for (const target of dangerTargets) {
    const result = await runChildForTest([fileURLToPath(import.meta.url), "--harness-probe"], { E2E_DATA: target });
    if (result.code === 0) {
      throw new Error(`危险 E2E_DATA 未拒绝：${target}`);
    }
  }
  if (!existsSync(packageFile)) throw new Error("危险 E2E_DATA 回归疑似删除仓库文件");
  console.log("  ✅ 危险 E2E_DATA 均非零拒绝，仓库文件仍存在");

  const probeEnv = { ...process.env };
  delete probeEnv.E2E_DATA;
  const [one, two] = await Promise.all([
    runChildForTest([fileURLToPath(import.meta.url), "--harness-probe"], probeEnv),
    runChildForTest([fileURLToPath(import.meta.url), "--harness-probe"], probeEnv)
  ]);
  if (one.code !== 0 || two.code !== 0) throw new Error(`并发 harness probe 失败：${one.stderr}${two.stderr}`);
  let oneInfo, twoInfo;
  try {
    oneInfo = JSON.parse(one.stdout.trim());
    twoInfo = JSON.parse(two.stdout.trim());
  } catch (e) {
    throw new Error(`并发 harness probe 输出不是单一 JSON：${e.message}\n${one.stdout}\n${two.stdout}`);
  }
  const onePorts = Object.values(oneInfo.ports || {});
  const twoPorts = Object.values(twoInfo.ports || {});
  if (!oneInfo.data || !twoInfo.data || oneInfo.data === twoInfo.data || !onePorts.length || !twoPorts.length || onePorts.some((p) => twoPorts.includes(p))) {
    throw new Error(`并发隔离失败：${JSON.stringify({ one: oneInfo, two: twoInfo })}`);
  }
  console.log("  ✅ 并发 harness probe 使用独立临时目录和不重叠随机端口");

  const typo = await runChildForTest([resolve(ROOT, "scripts/unit.mjs"), "not-a-real-scenario"]);
  if (typo.code === 0) {
    throw new Error(`拼错 unit 场景未非零退出：code=${typo.code}`);
  }
  console.log("  ✅ 拼错 unit 场景明确非零退出");
}

async function main() {
  let mockProc = null;
  let cleanupStarted = false;
  // 先验证 E2E_DATA（无任何删除动作），再分配随机端口，最后才清理/创建数据。
  // 这样危险路径不会触碰已有数据；端口冲突由实际子进程 bind 失败判定。
  try {
    validateE2EData();
    await allocatePorts();
    prepareDataDir();
    mockProc = spawnNode([resolve(ROOT, "scripts/mock-upstream.mjs")], { ...process.env, MOCK_PORT: String(TEST_PORTS.mock), MOCK_HOST: HOST });
    if (process.env.E2E_VERBOSE) mockProc.stdout.on("data", (d) => process.stdout.write("[mock] " + d));
    else mockProc.stdout.resume();
    mockProc.stderr.on("data", (d) => process.stderr.write("[mock!] " + d));
    mockProc.on("exit", (code, sig) => { if (!cleanupStarted) console.error("mock died code=" + code + " sig=" + sig); });
    if (!await waitUp(UP + "/health", 20000, mockProc)) throw new Error("mock not up");
    await startMgr();
    const externalChildren = directChildPids(mgr.pid);
    externalChildren.length === 0
      ? ok("external manager 不创建 upstream 子进程")
      : bad("external manager 子进程边界", JSON.stringify(externalChildren));

  // ── T1 鉴权 ──
  console.log("\n=== T1 auth ===");
  let r = await http1(MG + "/v1/chat/completions", "POST", { "Content-Type": "application/json" }, JSON.stringify({ model: "x", messages: [] }));
  r.status === 401 ? ok("无 token → 401") : bad("无 token → 401", "got " + r.status);
  r = await gw({ model: "x", messages: [] }, "wrong-token");
  r.status === 401 ? ok("错 token → 401") : bad("错 token → 401", "got " + r.status);
  r = await gw({ model: "x", messages: [] }, ADMIN);
  r.status === 401 ? ok("clientToken 已配置时 AdminToken 不可用 /v1") : bad("AdminToken 隔离", "got " + r.status);
  r = await http1(MG + "/v1/chat/completions", "POST", { "Content-Type": "application/json", "x-api-key": CLIENT }, JSON.stringify({ model: "x", messages: [] }));
  r.status === 429 ? ok("x-api-key 鉴权通过（空池 429）") : bad("x-api-key", "got " + r.status);
  r = await gw({ model: "x", messages: [] });
  r.status === 429 && r.body.includes("No usable API key") ? ok("空池 → 429 No usable API key") : bad("空池 429", "status=" + r.status + " " + r.body.slice(0, 120));

  // ── 播种 keyA(主)/keyB(备) ──
  let rr = (await addKey("keyA", "user_keyA")).response;
  ok("添加 keyA", "201=" + rr.status);
  rr = (await addKey("keyB", "user_keyB")).response;
  ok("添加 keyB", "201=" + rr.status);
  rr = await admin("/admin/api/keys", "POST", { alias: "bad", key: "notuser_x" });
  rr.status === 400 ? ok("非 user_ 前缀 → 400") : bad("非 user_ 前缀", "got " + rr.status);
  rr = await admin("/admin/api/keys", "POST", { alias: "dup", key: "user_keyA" });
  rr.status === 400 && rr.body.includes("已存在") ? ok("重复 Key → 400") : bad("重复 Key", "got " + rr.status);

  // ── T2 happy path + 统计 ──
  console.log("\n=== T2 happy path ===");
  r = await gw({ model: "m-ok", messages: [{ role: "user", content: "hi" }] });
  r.status === 200 && r.body.includes("hello from mock") ? ok("200 透传") : bad("200 透传", "status=" + r.status + " " + r.body.slice(0, 150));
  await sleep(200);
  r = await admin("/admin/api/history?pageSize=5");
  let ev = JSON.parse(r.body).items[0];
  ev && ev.ok && ev.inputTokens === 5 && ev.outputTokens === 7 && ev.cachedTokens === 1 && ev.model === "m-ok"
    ? ok("stats 事件 usage=5/7/1") : bad("stats usage", JSON.stringify(ev));
  let calls = JSON.parse((await mockGet("/__calls")).body).calls;
  calls.every((c) => c.auth === "user_keyA") ? ok("流量走主 Key") : bad("主 Key 选择", JSON.stringify(calls.map((c) => c.auth)));
  !JSON.stringify(calls).includes("client-tok") ? ok("客户端 token 未透传上游") : bad("token 泄漏", JSON.stringify(calls.map((c) => c.auth)));

  // ── T3 同 Key 重试（RA=1 ≤ sameKeyRetryMaxWaitMs）──
  console.log("\n=== T3 same-key retry ===");
  await mock("/__reset");
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "rate_limit", retryAfter: 1 }, { mode: "ok" }] });
  let t0 = performance.now();
  r = await gw({ model: "m-retry", messages: [] });
  calls = JSON.parse((await mockGet("/__calls")).body).calls;
  r.status === 200 && calls.length === 2 && calls.every((c) => c.auth === "user_keyA")
    ? ok("429(RA=1) 同 Key 重试成功未切换", Math.round(performance.now() - t0) + "ms") : bad("同 Key 重试", "status=" + r.status + " calls=" + JSON.stringify(calls.map((c) => c.auth)));
  const retryFailureRows = await historyForModel("m-retry", "/admin/api/history?errorKind=rate_limit&pageSize=500");
  retryFailureRows.length === 0 ? ok("重试成功不留 rate_limit 失败事件") : bad("重试事件", JSON.stringify(retryFailureRows));

  // ── T3b 并发健康回写：A 慢生成期间 B 同 Key 429，A 的旧成功不得清掉 B 的退避 ──
  // ── F17 外部请求统计契约：A→A→B 只产生一条 request 行 ──
  console.log("\n=== F17 external request event semantics ===");
  const keysF17 = await keysList();
  const keyAF17 = keysF17.find((key) => key.alias === "keyA");
  const keyBF17 = keysF17.find((key) => key.alias === "keyB");
  const poolStatsF17 = async () => parseJsonResponse(await admin("/admin/api/pool"), "F17 pool").stats;

  await restartClean();
  await mock("/__control", { auth: "user_keyA", responses: [
    { mode: "rate_limit", retryAfter: 1 },
    { mode: "rate_limit", retryAfter: 30 }
  ] });
  await mock("/__control", { auth: "user_keyB", responses: [{ mode: "ok" }] });
  const retryUsageBefore = await keysList();
  const retryUsageBeforeA = retryUsageBefore.find((key) => key.id === keyAF17.id)?.usage?.h5;
  const retryUsageBeforeB = retryUsageBefore.find((key) => key.id === keyBF17.id)?.usage?.h5;
  const retryPoolBefore = await poolStatsF17();
  r = await gw({ model: "m-f17-retry-success", messages: [] });
  calls = JSON.parse((await mockGet("/__calls")).body).calls;
  const retryRows = await historyForModel("m-f17-retry-success");
  const retryPoolAfter = await poolStatsF17();
  const retryEvent = retryRows[0];
  const keysAfterRetry = await keysList();
  const usageAAfterRetry = keysAfterRetry.find((key) => key.id === keyAF17.id)?.usage?.h5;
  const usageBAfterRetry = keysAfterRetry.find((key) => key.id === keyBF17.id)?.usage?.h5;
  r.status === 200 && calls.length === 3 && calls.map((call) => call.auth).join("→") === "user_keyA→user_keyA→user_keyB" &&
    retryRows.length === 1 && retryEvent.eventType === "request" && typeof retryEvent.requestId === "string" &&
    retryEvent.ok === true && retryEvent.status === 200 && retryEvent.attempts === 3 && retryEvent.retries === 2 &&
    Number.isFinite(retryEvent.latencyMs) && retryEvent.latencyMs >= 0 && retryEvent.keyId === keyBF17.id &&
    JSON.stringify(retryEvent.attemptedKeyIds) === JSON.stringify([keyAF17.id, keyAF17.id, keyBF17.id])
    ? ok("A→A→B 成功只写一条外部 request 行，retries/attempts/Key 路径稳定")
    : bad("F17 A→A→B 成功统计", JSON.stringify({ status: r.status, calls, rows: retryRows }));
  retryPoolAfter.requests - retryPoolBefore.requests === 1 && retryPoolAfter.success - retryPoolBefore.success === 1 &&
    retryPoolAfter.input - retryPoolBefore.input === 5 && retryPoolAfter.output - retryPoolBefore.output === 7 &&
    usageAAfterRetry?.requests - retryUsageBeforeA.requests === 0 &&
    usageBAfterRetry?.requests - retryUsageBeforeB.requests === 1 &&
    usageBAfterRetry.input - retryUsageBeforeB.input === 5 && usageBAfterRetry.output - retryUsageBeforeB.output === 7
    ? ok("重试不放大 poolStats/token，窗口按终态 Key 归属")
    : bad("F17 成功聚合", JSON.stringify({ before: retryPoolBefore, after: retryPoolAfter, a: usageAAfterRetry, b: usageBAfterRetry }));
  const retryRequestRows = parseJsonResponse(await admin("/admin/api/history?eventType=request&keyId=" + keyBF17.id + "&pageSize=500"), "F17 request query").items
    .filter((event) => event.model === "m-f17-retry-success");
  const retryAttemptRows = parseJsonResponse(await admin("/admin/api/history?eventType=attempt&keyId=" + keyBF17.id + "&pageSize=500"), "F17 attempt query").items
    .filter((event) => event.model === "m-f17-retry-success");
  retryRequestRows.length === 1 && retryRequestRows[0].requestId && retryAttemptRows.length === 0 &&
    new Set(retryRequestRows.map((event) => event.requestId)).size === retryRequestRows.length
    ? ok("history/CSV 默认数据源按外部 request 行查询")
    : bad("F17 history/CSV 行数", JSON.stringify({ requests: retryRequestRows, attempts: retryAttemptRows }));

  await restartClean();
  await mock("/__control", { auth: "user_keyA", responses: [
    { mode: "rate_limit", retryAfter: 1 },
    { mode: "rate_limit", retryAfter: 30 }
  ] });
  await mock("/__control", { auth: "user_keyB", responses: [{ mode: "rate_limit", retryAfter: 30 }] });
  const failedUsageBefore = await keysList();
  const failedUsageBeforeA = failedUsageBefore.find((key) => key.id === keyAF17.id)?.usage?.h5;
  const failedUsageBeforeB = failedUsageBefore.find((key) => key.id === keyBF17.id)?.usage?.h5;
  const failedPoolBefore = await poolStatsF17();
  r = await gw({ model: "m-f17-retry-failure", messages: [] });
  calls = JSON.parse((await mockGet("/__calls")).body).calls;
  const failedRows = await historyForModel("m-f17-retry-failure");
  const failedPoolAfter = await poolStatsF17();
  const failedEvent = failedRows[0];
  r.status === 429 && calls.length === 3 && calls.map((call) => call.auth).join("→") === "user_keyA→user_keyA→user_keyB" &&
    failedRows.length === 1 && failedEvent.ok === false && failedEvent.status === 429 && failedEvent.errorKind === "rate_limit" &&
    failedEvent.attempts === 3 && failedEvent.retries === 2 && Number.isFinite(failedEvent.latencyMs) && failedEvent.latencyMs >= 0 &&
    failedEvent.keyId === keyBF17.id &&
    JSON.stringify(failedEvent.attemptedKeyIds) === JSON.stringify([keyAF17.id, keyAF17.id, keyBF17.id])
    ? ok("A→A→B 最终限流只写一条失败 request 行，status/ok/retries 稳定")
    : bad("F17 A→A→B 最终失败统计", JSON.stringify({ status: r.status, calls, rows: failedRows }));
  failedPoolAfter.requests - failedPoolBefore.requests === 1 && failedPoolAfter.err429 - failedPoolBefore.err429 === 1 &&
    failedPoolAfter.success - failedPoolBefore.success === 0
    ? ok("所有限流 attempts 不重复计请求/失败率")
    : bad("F17 限流聚合", JSON.stringify({ before: failedPoolBefore, after: failedPoolAfter }));
  const failedKeysAfter = await keysList();
  const failedUsageAfterA = failedKeysAfter.find((key) => key.id === keyAF17.id)?.usage?.h5;
  const failedUsageAfterB = failedKeysAfter.find((key) => key.id === keyBF17.id)?.usage?.h5;
  failedUsageAfterA?.requests - failedUsageBeforeA.requests === 0 && failedUsageAfterB?.requests - failedUsageBeforeB.requests === 1 &&
    failedUsageAfterB.err429 - failedUsageBeforeB.err429 === 1
    ? ok("失败重试按最终 Key 计一次每 Key 窗口")
    : bad("F17 失败每 Key 窗口", JSON.stringify({ beforeA: failedUsageBeforeA, afterA: failedUsageAfterA, beforeB: failedUsageBeforeB, afterB: failedUsageAfterB }));

  await restartClean();
  await mock("/__control", { auth: "user_keyA", responses: [
    { mode: "server5xx", status: 503 },
    { mode: "server5xx", status: 503 }
  ] });
  await mock("/__control", { auth: "user_keyB", responses: [
    { mode: "server5xx", status: 503 },
    { mode: "server5xx", status: 503 }
  ] });
  r = await gw({ model: "m-f17-final-upstream-failure", messages: [] });
  calls = JSON.parse((await mockGet("/__calls")).body).calls;
  const finalUpstreamRows = await historyForModel("m-f17-final-upstream-failure");
  const finalUpstreamEvent = finalUpstreamRows[0];
  r.status === 502 && calls.length === 4 && finalUpstreamRows.length === 1 && finalUpstreamEvent.ok === false &&
    finalUpstreamEvent.status === 502 && finalUpstreamEvent.errorKind === "upstream" && finalUpstreamEvent.attempts === 4 &&
    finalUpstreamEvent.retries === 3 && finalUpstreamEvent.keyId === keyBF17.id
    ? ok("最终上游失败只写一条 502/upstream request 终态")
    : bad("F17 最终上游失败统计", JSON.stringify({ status: r.status, calls, rows: finalUpstreamRows }));

  await restartClean();
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "cutbody" }] });
  r = await gw({ model: "m-f17-partial-json", messages: [] });
  const partialJsonRows = await historyForModel("m-f17-partial-json");
  partialJsonRows.length === 1 && partialJsonRows[0].ok === false && partialJsonRows[0].status === 502 &&
    partialJsonRows[0].errorKind === "upstream" && partialJsonRows[0].attempts === 1 && partialJsonRows[0].retries === 0
    ? ok("非流式部分响应按单条 502/upstream 终态记录")
    : bad("F17 非流式部分失败统计", JSON.stringify({ status: r.status, rows: partialJsonRows }));

  await restartClean();
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "cutstream" }] });
  const partialStreamResult = await rawGwOnce({ model: "m-f17-partial-stream", messages: [], stream: true });
  await sleep(100);
  const partialStreamRows = await historyForModel("m-f17-partial-stream");
  partialStreamRows.length === 1 && partialStreamRows[0].ok === false && partialStreamRows[0].status === 502 &&
    partialStreamRows[0].errorKind === "upstream" && partialStreamRows[0].attempts === 1 && partialStreamRows[0].retries === 0 &&
    partialStreamResult.outcome !== "timeout"
    ? ok("流式部分断流按单条 502/upstream 终态记录")
    : bad("F17 流式部分失败统计", JSON.stringify({ result: partialStreamResult, rows: partialStreamRows }));

  // F17 场景会主动制造 Key 退避；清理健康状态后再进入后续既有用例。
  await restartClean();

  console.log("\n=== T3b concurrent health generation ===");
  await mock("/__reset");
  await mock("/__control", { auth: "user_keyA", responses: [
    { mode: "delay", delayMs: 700 },
    { mode: "rate_limit", retryAfter: 30 }
  ] });
  await mock("/__control", { auth: "user_keyB", responses: [{ mode: "ok" }] });
  const concurrentStart = performance.now();
  const requestA = gw({ model: "m-concurrent-a", messages: [] });
  await sleep(60);
  const requestB = gw({ model: "m-concurrent-b", messages: [] });
  const resultB = await requestB;
  const finishedB = performance.now();
  const resultA = await requestA;
  const finishedA = performance.now();
  calls = JSON.parse((await mockGet("/__calls")).body).calls;
  const concurrentKeyA = (await keysList()).find((k) => k.alias === "keyA");
  resultA.status === 200 && resultB.status === 200 && finishedB < finishedA && finishedA - concurrentStart >= 600
    ? ok("真实延迟交错：B 先完成，A 仍在生成后成功")
    : bad("真实延迟交错", JSON.stringify({ a: resultA.status, b: resultB.status, elapsedA: Math.round(finishedA - concurrentStart), elapsedB: Math.round(finishedB - concurrentStart) }));
  calls.length === 3 && calls[0].model === "m-concurrent-a" && calls[0].mode === "delay" &&
    calls[1].model === "m-concurrent-b" && calls[1].mode === "rate_limit" && calls[2].auth === "user_keyB"
    ? ok("并发 B 与 A 复用 keyA 后按退避切换 keyB")
    : bad("并发调用序列", JSON.stringify(calls));
  concurrentKeyA && concurrentKeyA.health.failCount === 1 && concurrentKeyA.health.backoffUntilMs > Date.now() && concurrentKeyA.health.lastErrorKind === "rate_limit"
    ? ok("A 旧成功未清除 B 的 failCount/backoff/errorKind", JSON.stringify(concurrentKeyA.health))
    : bad("并发健康状态被旧成功覆盖", JSON.stringify(concurrentKeyA && concurrentKeyA.health));
  await sleep(1100);
  const concurrentDisk = JSON.parse(readFileSync(resolve(DATA, "state.json"), "utf-8"));
  const concurrentDiskHealth = concurrentDisk.keys[concurrentKeyA.id] || {};
  concurrentDiskHealth.failCount === 1 && concurrentDiskHealth.lastErrorKind === "rate_limit" && concurrentDiskHealth.backoffUntilMs > Date.now()
    ? ok("并发最新退避也已 durable 落盘")
    : bad("并发退避落盘", JSON.stringify(concurrentDiskHealth));

  // auth-only pool 只表示需要人工修复，不应让客户端等待 markAuthError 的一小时标记。
  await restartClean();
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "auth" }] });
  await mock("/__control", { auth: "user_keyB", responses: [{ mode: "auth" }] });
  const authA = await gw({ model: "m-auth-only-a", messages: [] });
  const authB = await gw({ model: "m-auth-only-b", messages: [] });
  r = await gw({ model: "m-auth-only-c", messages: [] });
  const authOnlyBody = JSON.parse(r.body);
  authA.status === 401 && authB.status === 401 && r.status === 429 && r.headers["retry-after"] === "0" && authOnlyBody.retry_after === 0
    ? ok("auth-only pool Retry-After=0，不伪装一小时人工等待")
    : bad("auth-only Retry-After", JSON.stringify({ a: authA.status, b: authB.status, c: r.status, header: r.headers["retry-after"], body: authOnlyBody }));
  // auth-only 是负向场景；正向断言完成后恢复 Key 健康状态，避免污染后续 T4。
  await restartClean();

  // ── T4 持续限流 RA=30 → 不等待、退避、切换、最终 429 ──
  console.log("\n=== T4 failover on sustained 429 ===");
  await mock("/__reset");
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "rate_limit", retryAfter: 30 }] });
  await mock("/__control", { auth: "user_keyB", responses: [{ mode: "rate_limit", retryAfter: 30 }] });
  t0 = performance.now();
  r = await gw({ model: "m-fail", messages: [] });
  const dt4 = performance.now() - t0;
  calls = JSON.parse((await mockGet("/__calls")).body).calls;
  r.status === 429 && dt4 < 3000 ? ok("两 Key 全限流 → 快速 429", dt4 + "ms RA=" + r.headers["retry-after"]) : bad("failover 429", "status=" + r.status + " dt=" + dt4);
  calls.length === 2 && calls[0].auth === "user_keyA" && calls[1].auth === "user_keyB"
    ? ok("切换序列 keyA→keyB") : bad("切换序列", JSON.stringify(calls.map((c) => c.auth)));
  let ks = await keysList();
  let kA = ks.find((k) => k.alias === "keyA"), kB = ks.find((k) => k.alias === "keyB");
  kA.health.backoffUntilMs > Date.now() && kB.health.backoffUntilMs > Date.now()
    ? ok("两 Key 均进入退避") : bad("退避标记", JSON.stringify({ a: kA.health.backoffUntilMs, b: kB.health.backoffUntilMs }));
  kA.health.failoverCount === 1 && kB.health.failoverCount === 1 ? ok("failoverCount 计数") : bad("failoverCount", kA.health.failoverCount + "/" + kB.health.failoverCount);

  // ── T5 全退避时新请求快速 429 + state.json 持久化 + 重启保留 ──
  console.log("\n=== T5 backoff fast-429 & persistence ===");
  t0 = performance.now();
  r = await gw({ model: "m-blocked", messages: [] });
  r.status === 429 && performance.now() - t0 < 1500 && Number(r.headers["retry-after"]) > 20
    ? ok("全退避 → 快速 429 + Retry-After") : bad("全退避 429", "status=" + r.status + " RA=" + r.headers["retry-after"]);
  await sleep(1300);
  const stFile = JSON.parse(readFileSync(resolve(DATA, "state.json"), "utf-8"));
  Object.values(stFile.keys).every((h) => h.backoffUntilMs > 0) ? ok("state.json 落盘含退避") : bad("state.json", JSON.stringify(stFile).slice(0, 200));
  await stopMgr(); await startMgr();
  t0 = performance.now();
  r = await gw({ model: "m-restart", messages: [] });
  r.status === 429 && performance.now() - t0 < 2000 ? ok("重启后退避状态保留") : bad("重启保留", "status=" + r.status + " dt=" + Math.round(performance.now() - t0));
  await restartClean();
  r = await gw({ model: "m-recover", messages: [] });
  r.status === 200 ? ok("退避清除后恢复服务") : bad("恢复", "status=" + r.status);

  // ── T5c SIGTERM 退出前 flush 防抖待写（P2-4 端到端，真实信号验证）──
  // 修复前的竞争窗口：markAuthError 仅 schedule()（1000ms 防抖），SIGTERM 后
  // server.close() 回调（Node ≥18.4 立即销毁空闲 keep-alive 连接，已实测）几乎瞬时
  // process.exit(0) —— 防抖 timer 从未触发 → authError 丢失。修复后信号处理进入即
  // flushAllPending() 同步写盘 → 磁盘含 authError。本用例修复前必红、修复后必绿，
  // 且 killLag<950ms 断言证明落盘来自 flush 而非 timer（timer 在 1000ms 后才可能触发）。
  console.log("\n=== T5c SIGTERM flush (P2-4) ===");
  await mock("/__reset");
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "auth" }] });
  r = await gw({ model: "m-flush", messages: [] });
  r.status === 401 ? ok("T5c 预置 401（markAuthError 已 schedule 1s 防抖待写）") : bad("T5c 预置 401", "status=" + r.status);
  ks = await keysList(); // 一次进程内快速 HTTP（≪100ms），不破坏防抖窗口
  const idA5c = ks.find((k) => k.alias === "keyA").id;
  const t5cKill0 = performance.now();
  await stopMgr();
  const killLag = Math.round(performance.now() - t5cKill0);
  killLag < 950 ? ok("T5c 进程在防抖窗口(<1000ms)内退出，timer 不可能已触发", killLag + "ms") : bad("T5c 退出时序", killLag + "ms ≥ 防抖窗口，无法证明 flush 价值");
  const st5c = JSON.parse(readFileSync(resolve(DATA, "state.json"), "utf-8"));
  const h5c = (st5c.keys || {})[idA5c] || {};
  h5c.authError === true && h5c.backoffUntilMs > Date.now()
    ? ok("T5c SIGTERM flush 已落盘 authError（修复前此处必为旧值/缺失）", JSON.stringify(h5c))
    : bad("T5c flush 落盘", JSON.stringify(h5c));
  // 手工清理 authError（不 restartClean：mgr 已退出，其 stopMgr 会白等 3s 兜底）
  {
    const stPath = resolve(DATA, "state.json");
    const st = JSON.parse(readFileSync(stPath, "utf-8"));
    for (const h of Object.values(st.keys || {})) { h.backoffUntilMs = 0; h.failCount = 0; h.lastErrorKind = ""; h.quotaLimitedUntil = 0; h.authError = false; }
    writeFileSync(stPath, JSON.stringify(st));
  }
  await startMgr();
  await mock("/__reset");

  // ── T5d 损坏 config.json 备份（P2-1：不再静默覆盖致凭证永久丢失）──
  // 独立 DATA/端口，手工 spawn，不触碰主流程 DATA 与全局 mgr。
  console.log("\n=== T5d corrupt config backup (P2-1) ===");
  {
    const D5d = privateTempDir("ccpm-e2e-corrupt-");
    writeFileSync(resolve(D5d, "config.json"), "{ not json");
    const TOK5d = "e2e-fixed-admin-tok-9f8e";
    const U5d = testUrl(TEST_PORTS.corrupt);
    const p5d = spawnNode([resolve(ROOT, "src/server.mjs")], {
      ...process.env, DATA_DIR: D5d, PORT: String(TEST_PORTS.corrupt), HOST,
      UPSTREAM_HOST: HOST, UPSTREAM_PORT: String(TEST_PORTS.mock), EMBED_UPSTREAM: "0",
      ADMIN_TOKEN: TOK5d, CLIENT_TOKEN: TOK5d, CC_QUOTA_BASE: UP
    });
    try {
      let out5d = "";
      p5d.stdout.on("data", (d) => { out5d += d; });
      p5d.stderr.on("data", (d) => { out5d += d; });
      (await waitUp(U5d + "/health", 20000, p5d)) ? ok("T5d 损坏 config 下服务正常启动（默认值+env）") : bad("T5d 启动", out5d.slice(0, 300));
      const corruptFiles = readdirSync(D5d).filter((f) => /^config\.json\.corrupt-\d+$/.test(f));
      const backupRaw = corruptFiles.length === 1 ? readFileSync(resolve(D5d, corruptFiles[0]), "utf-8") : null;
      corruptFiles.length === 1 && backupRaw === "{ not json"
        ? ok("T5d 损坏文件备份为 config.json.corrupt-<ts> 且原内容逐字保留", corruptFiles[0])
        : bad("T5d 备份", "files=" + corruptFiles.join(",") + " content=" + JSON.stringify(backupRaw));
      out5d.includes("解析失败，已备份为") ? ok("T5d 启动日志含明确备份警告") : bad("T5d 日志", out5d.slice(0, 300));
      r = await http1(U5d + "/admin/api/login", "POST", { "Content-Type": "application/json" }, JSON.stringify({ token: TOK5d }));
      r.status === 200 ? ok("T5d 磁盘无 token → env 填充（衔接 P2-2），FIXED 令牌登录成功") : bad("T5d login", "status=" + r.status);
      let cfg5d = null;
      try { cfg5d = JSON.parse(readFileSync(resolve(D5d, "config.json"), "utf-8")); } catch {}
      cfg5d && cfg5d.adminToken === TOK5d ? ok("T5d 新 config.json 为合法 JSON 且已持久化 token") : bad("T5d 新 config", JSON.stringify(cfg5d).slice(0, 150));
    } finally {
      await stopChild(p5d, "T5d manager");
      try { rmSync(D5d, { recursive: true, force: true }); } catch {}
    }
  }

  // ── T5d2 语义损坏 config：隔离原文件并拒绝启动（F12）──
  console.log("\n=== T5d2 semantic config validation ===");
  {
    const D5d2 = privateTempDir("ccpm-e2e-semantic-corrupt-");
    const semanticRaw = JSON.stringify({ pool: { zeroOutputCountsAs429: "false" } });
    writeFileSync(resolve(D5d2, "config.json"), semanticRaw);
    try {
      const result = await runChildForTest([resolve(ROOT, "src/server.mjs")], {
        ...process.env, DATA_DIR: D5d2, PORT: String(TEST_PORTS.semanticCorrupt), HOST,
        UPSTREAM_HOST: HOST, UPSTREAM_PORT: String(TEST_PORTS.mock), EMBED_UPSTREAM: "0",
        ADMIN_TOKEN: "e2e-semantic-admin-1234", CLIENT_TOKEN: "e2e-semantic-client-1234", CC_QUOTA_BASE: UP
      });
      const corruptFiles = readdirSync(D5d2).filter((f) => /^config\.json\.corrupt-\d+$/.test(f));
      const backupRaw = corruptFiles.length === 1 ? readFileSync(resolve(D5d2, corruptFiles[0]), "utf-8") : "";
      const output = result.stdout + result.stderr;
      result.code !== 0 && output.includes("pool.zeroOutputCountsAs429")
        ? ok("T5d2 语义损坏按字段诊断并拒绝启动", output.match(/pool\.zeroOutputCountsAs429/g)?.length + " 次")
        : bad("T5d2 语义损坏启动门禁", JSON.stringify({ code: result.code, output: output.slice(0, 500) }));
      corruptFiles.length === 1 && backupRaw === semanticRaw
        ? ok("T5d2 语义损坏原文件隔离保留", corruptFiles[0])
        : bad("T5d2 语义备份", JSON.stringify({ files: corruptFiles, backupRaw }));
    } finally {
      try { rmSync(D5d2, { recursive: true, force: true }); } catch {}
    }
  }

  // ── T5d3 非法基础设施 env：拒绝启动并指出具体变量（F12）──
  console.log("\n=== T5d3 environment config validation ===");
  {
    const D5d3 = privateTempDir("ccpm-e2e-bad-env-");
    try {
      const result = await runChildForTest([resolve(ROOT, "src/server.mjs")], {
        ...process.env, DATA_DIR: D5d3, PORT: "NaN", HOST,
        UPSTREAM_HOST: HOST, UPSTREAM_PORT: String(TEST_PORTS.mock), EMBED_UPSTREAM: "0",
        ADMIN_TOKEN: "e2e-env-admin-1234", CLIENT_TOKEN: "e2e-env-client-1234", CC_QUOTA_BASE: UP
      });
      const output = result.stdout + result.stderr;
      result.code !== 0 && output.includes("env.PORT")
        ? ok("T5d3 非法 PORT env 按字段诊断并拒绝启动")
        : bad("T5d3 env 启动门禁", JSON.stringify({ code: result.code, output: output.slice(0, 500) }));
    } finally {
      try { rmSync(D5d3, { recursive: true, force: true }); } catch {}
    }
  }

  // ── T5e env 令牌不再回滚磁盘凭证（P2-2）──
  // 独立 DATA：首启用 env A 建立磁盘令牌 → 保留 DATA 换 env B 重启 → A 仍可登录、B 被拒。
  // 修复前：B 启动即把磁盘覆写回 B → A 登录 401（红）。不用 restartClean/主 DATA，避免清理干扰。
  console.log("\n=== T5e env token no-rollback (P2-2) ===");
  {
    const D5e = privateTempDir("ccpm-e2e-tokenkeep-");
    const TOK5eA = "e2e-disk-token-A-aaaa";
    const TOK5eB = "e2e-env-token-B-bbbb";
    const U5e = testUrl(TEST_PORTS.tokenKeep);
    const spawn5e = (tok) => spawnNode([resolve(ROOT, "src/server.mjs")], {
      ...process.env, DATA_DIR: D5e, PORT: String(TEST_PORTS.tokenKeep), HOST,
      UPSTREAM_HOST: HOST, UPSTREAM_PORT: String(TEST_PORTS.mock), EMBED_UPSTREAM: "0",
      ADMIN_TOKEN: tok, CLIENT_TOKEN: tok, CC_QUOTA_BASE: UP
    });
    let p5e = null;
    try {
      p5e = spawn5e(TOK5eA);
      const upA5e = await waitUp(U5e + "/health", 20000, p5e);
      upA5e ? ok("T5e 首次启动（env=A）正常") : bad("T5e 首次启动", D5e);
      let cfg5e = null;
      try { cfg5e = JSON.parse(readFileSync(resolve(D5e, "config.json"), "utf-8")); } catch {}
      cfg5e && cfg5e.adminToken === TOK5eA ? ok("T5e 磁盘 config.json 已建立 token=A") : bad("T5e 首启落盘", JSON.stringify(cfg5e && cfg5e.adminToken));
      await stopChild(p5e, "T5e manager A");
      p5e = spawn5e(TOK5eB);
      const upB5e = await waitUp(U5e + "/health", 20000, p5e);
      if (!upB5e) bad("T5e 二次启动（env=B）", D5e);
      r = await http1(U5e + "/admin/api/login", "POST", { "Content-Type": "application/json" }, JSON.stringify({ token: TOK5eA }));
      const okA = r.status === 200;
      okA ? ok("T5e env=B 重启后磁盘 token=A 仍有效（未回滚）") : bad("T5e A 登录", "status=" + r.status);
      r = await http1(U5e + "/admin/api/login", "POST", { "Content-Type": "application/json" }, JSON.stringify({ token: TOK5eB }));
      const okB = r.status === 401;
      okB ? ok("T5e env=B 未获得登录权（env 不覆写非空磁盘值）") : bad("T5e B 登录应 401", "status=" + r.status);
      upB5e && okA && okB ? ok("T5e 综合：P2-2 语义正确") : bad("T5e 综合", "up=" + upB5e + " A=" + okA + " B=" + okB);
    } finally {
      await stopChild(p5e, "T5e manager");
      try { rmSync(D5e, { recursive: true, force: true }); } catch {}
    }
  }

  // ── T6 上游 401 → authError、不重试不切换、透传 401 ──
  console.log("\n=== T6 auth error ===");
  await mock("/__reset");
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "auth" }] });
  r = await gw({ model: "m-auth", messages: [] });
  calls = JSON.parse((await mockGet("/__calls")).body).calls;
  r.status === 401 ? ok("401 透传") : bad("401 透传", "status=" + r.status);
  calls.length === 1 ? ok("401 不重试不切换") : bad("401 不重试", JSON.stringify(calls.map((c) => c.auth)));
  ks = await keysList(); kA = ks.find((k) => k.alias === "keyA");
  kA.health.authError ? ok("keyA 标记 authError") : bad("authError", JSON.stringify(kA.health));
  await mock("/__reset");
  r = await gw({ model: "m-fallback", messages: [] });
  r.status === 200 ? ok("authError Key 被跳过，流量走 keyB") : bad("authError 跳过", "status=" + r.status);
  const clearAuthResponse = await admin("/admin/api/keys/" + kA.id + "/clear-auth", "POST");
  ks = await keysList();
  const clearAuthKey = ks.find((k) => k.alias === "keyA");
  const clearAuthState = JSON.parse(readFileSync(resolve(DATA, "state.json"), "utf-8")).keys[clearAuthKey.id] || {};
  clearAuthResponse.status === 200 && JSON.parse(clearAuthResponse.body).durable === true && !clearAuthKey.health.authError
    ? ok("clear-auth 恢复且响应声明 durable") : bad("clear-auth", JSON.stringify({ response: clearAuthResponse, health: clearAuthKey.health }));
  clearAuthState.authError === false && clearAuthState.backoffUntilMs === 0
    ? ok("clear-auth 成功后 state.json 即时更新") : bad("clear-auth state", JSON.stringify(clearAuthState));

  const clearBackoffResponse = await admin("/admin/api/keys/" + kA.id + "/clear-backoff", "POST");
  const clearBackoffState = JSON.parse(readFileSync(resolve(DATA, "state.json"), "utf-8")).keys[clearAuthKey.id] || {};
  clearBackoffResponse.status === 200 && JSON.parse(clearBackoffResponse.body).durable === true && clearBackoffState.failCount === 0 && clearBackoffState.backoffUntilMs === 0
    ? ok("clear-backoff 成功后 state.json 即时更新") : bad("clear-backoff state", JSON.stringify({ response: clearBackoffResponse, state: clearBackoffState }));

  // ── T7 零输出 → 同 Key 重试（决策 8）──
  console.log("\n=== T7 zero output ===");
  await restartClean();
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "zeroout" }, { mode: "ok" }] });
  r = await gw({ model: "m-zero", messages: [] });
  calls = JSON.parse((await mockGet("/__calls")).body).calls;
  r.status === 200 && calls.length === 2 && calls.every((c) => c.auth === "user_keyA")
    ? ok("零输出同 Key 重试成功") : bad("零输出重试", "status=" + r.status + " calls=" + calls.length);
  ks = await keysList();
  ks.find((k) => k.alias === "keyA").health.backoffUntilMs <= Date.now() ? ok("重试成功不留退避") : bad("零输出退避", "");

  // ── T7b zeroOutputCountsAs429=false → 零输出不计 429、不惩罚 Key ──
  await restartClean();
  await admin("/admin/api/pool", "PUT", { zeroOutputCountsAs429: false });
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "zeroout" }] });
  r = await gw({ model: "m-zero-off", messages: [] });
  calls = JSON.parse((await mockGet("/__calls")).body).calls;
  ks = await keysList();
  r.status === 429 && calls.length === 1 && ks.find((k) => k.alias === "keyA").health.backoffUntilMs <= Date.now()
    ? ok("开关关闭：零输出透传、不重试不退避（P3-4 已修复）") : bad("零输出开关", "status=" + r.status + " calls=" + calls.length + " health=" + JSON.stringify(ks.find((k) => k.alias === "keyA").health));
  await admin("/admin/api/pool", "PUT", { zeroOutputCountsAs429: true });
  await mock("/__reset");

  // ── T8 持续 5xx：同 Key 重试一次后切换备 Key（P2-2 修复后）──
  console.log("\n=== T8 upstream 5xx ===");
  await restartClean();
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "server5xx" }, { mode: "server5xx" }, { mode: "server5xx" }, { mode: "server5xx" }] });
  await mock("/__control", { auth: "user_keyB", responses: [{ mode: "ok" }] });
  r = await gw({ model: "m-5xx", messages: [] });
  calls = JSON.parse((await mockGet("/__calls")).body).calls;
  const seq8 = calls.map((c) => c.auth.replace("user_", "")).join("→");
  r.status === 200 && seq8 === "keyA→keyA→keyB"
    ? ok("5xx 同Key重试1次后切换 keyB 成功（P2-2 已修复）") : bad("P2-2 5xx 切换", "status=" + r.status + " seq=" + seq8);
  ks = await keysList();
  ks.find((k) => k.alias === "keyA").health.backoffUntilMs <= Date.now()
    ? ok("5xx 不进退避（主 Key 保持可用）") : bad("5xx 退避", "");
  // T8b 全 Key 5xx → 客户端 502（不再误报 429）
  await restartClean();
  await mock("/__control", { auth: "user_keyA", responses: Array(4).fill({ mode: "server5xx" }) });
  await mock("/__control", { auth: "user_keyB", responses: Array(4).fill({ mode: "server5xx" }) });
  r = await gw({ model: "m-5xx-all", messages: [] });
  calls = JSON.parse((await mockGet("/__calls")).body).calls;
  r.status === 502 && calls.length === 4
    ? ok("全 Key 5xx → 502 + 预算内尝试（P2-2 状态码已修复）") : bad("5xx 终态", "status=" + r.status + " calls=" + calls.length);

  // ── T9 流式透传 + usage ──
  console.log("\n=== T9 stream ===");
  await restartClean();
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "sse" }] });
  r = await gw({ model: "m-sse", messages: [], stream: true });
  r.status === 200 && (r.headers["content-type"] || "").includes("text/event-stream") && r.body.includes("[DONE]")
    ? ok("SSE 透传完整") : bad("SSE", "status=" + r.status + " ct=" + r.headers["content-type"]);
  await sleep(200);
  r = await admin("/admin/api/history?pageSize=3");
  ev = JSON.parse(r.body).items[0];
  ev && ev.stream && ev.ok && ev.inputTokens === 3 && ev.outputTokens === 4 && ev.cachedTokens === 2
    ? ok("流式 usage 3/4/2") : bad("流式 usage", JSON.stringify(ev));

  // ── T9b 上游流中途断连（P1-1 修复后：客户端不挂起、不误记成功、记 upstream 失败）──
  console.log("\n=== T9b upstream mid-stream cut (P1-1) ===");
  await restartClean();
  // 预置 failCount=1：hang → connectTimeout(1.2s) → recordTimeout。
  // 修复后若误走 recordSuccess 会被清零——用非零基线才能区分“未误清”与“误清后再次退避”。
  await admin("/admin/api/pool", "PUT", { connectTimeoutMs: 1200, backoffBaseMs: 1000 });
  await mock("/__reset");
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "hang" }] });
  await gw({ model: "m-seed-fail", messages: [] }).catch(() => {});
  await sleep(300);
  ks = await keysList();
  const hSeed = ks.find((k) => k.alias === "keyA").health;
  const idA9b = ks.find((k) => k.alias === "keyA").id;
  hSeed.failCount === 1 ? ok("基线：keyA failCount=1（timeout 退避）") : bad("基线 failCount", JSON.stringify(hSeed));
  await admin("/admin/api/pool", "PUT", { connectTimeoutMs: 120000, backoffBaseMs: 5000 });
  // 轮询门控：等 keyA 的 1s 退避真正到期再放行（固定 sleep(1300) 与 1000ms 窗口仅
  // 300ms 裕量，负载下 API 延迟叠加会让 keyA 仍在 inBackoff → cutstream 被路由到
  // keyB（default ok）→ 本用例断言偶发翻红，集成终检实锤）。门控超时则原样继续，
  // 由后续断言暴露。同时校验 failCount=1 保留——保证“误清”检测有意义（非真空通过）。
  {
    const tGate = performance.now();
    while (performance.now() - tGate < 5000) {
      const hs = (await keysList()).find((k) => k.alias === "keyA");
      if (hs && hs.health.failCount === 1 && Date.now() >= hs.health.backoffUntilMs) break;
      await sleep(100);
    }
    await sleep(80); // Date.now 粒度余量
  }
  await mock("/__reset");
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "cutstream" }] });
  const stderrMark = mgrStderr.length;
  t0 = performance.now();
  const cutRes = await rawGwOnce({ model: "m-cut", messages: [], stream: true });
  const cutDt = Math.round(performance.now() - t0);
  cutRes.outcome !== "HANG" && cutDt < 6000 && cutRes.txt.includes("chat.completion.chunk")
    ? ok("上游断流：客户端有限时间终止（" + cutRes.outcome + " " + cutDt + "ms，已收到部分内容）")
    : bad("P1-1 流式挂起", "outcome=" + cutRes.outcome + " dt=" + cutDt + " txt=" + JSON.stringify(cutRes.txt.slice(0, 60)));
  await sleep(250);
  r = await admin("/admin/api/history?keyId=" + idA9b + "&errorKind=upstream&status=502");
  let upstreamEv = JSON.parse(r.body);
  const cutEvents = upstreamEv.items.filter((event) => event.model === "m-cut");
  cutEvents.length === 1 && cutEvents[0].ok === false && cutEvents[0].model === "m-cut" && cutEvents[0].attempts === 1 && cutEvents[0].retries === 0
    ? ok("恰 1 条 ok:false errorKind=upstream status:502 事件") : bad("upstream 事件", JSON.stringify(upstreamEv).slice(0, 200));
  r = await admin("/admin/api/history?keyId=" + idA9b + "&status=200");
  JSON.parse(r.body).items.every((e) => e.model !== "m-cut")
    ? ok("无 m-cut 成功事件（未误走 recordSuccess 分支）") : bad("误记成功", r.body.slice(0, 200));
  ks = await keysList();
  ks.find((k) => k.alias === "keyA").health.failCount === 1
    ? ok("failCount 未被 recordSuccess 误清（仍=1）") : bad("误清退避", JSON.stringify(ks.find((k) => k.alias === "keyA").health));
  mgrStderr.slice(stderrMark).includes("unhandledRejection")
    ? bad("P1-1 拒绝噪音", mgrStderr.slice(stderrMark).trim().split("\n").slice(0, 3).join(" | "))
    : ok("上游断流无 unhandledRejection 噪音");
  r = await http1(MG + "/health", "GET", {});
  r.status === 200 ? ok("断流场景后 manager 存活") : bad("断流存活", "health=" + r.status);

  // ── T9c 非流式 body 中途断连（P1-1：pipeFailed 路径收尾 res）──
  await mock("/__reset");
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "cutbody" }] });
  const stderrMark2 = mgrStderr.length;
  const cutbRes = await rawGwOnce({ model: "m-cutb", messages: [] });
  cutbRes.outcome !== "HANG" && cutbRes.ms < 6000
    ? ok("非流式半身断连：客户端有限时间终止（" + cutbRes.outcome + " " + cutbRes.ms + "ms）")
    : bad("P1-1 非流式挂起", "outcome=" + cutbRes.outcome + " ms=" + cutbRes.ms);
  await sleep(250);
  r = await admin("/admin/api/history?keyId=" + idA9b + "&errorKind=upstream&status=502");
  const cutbodyEvents = JSON.parse(r.body).items.filter((event) => event.model === "m-cutb");
  cutbodyEvents.length === 1 && cutbodyEvents[0].attempts === 1 && cutbodyEvents[0].retries === 0
    ? ok("cutbody 也记单条 ok:false upstream 终态事件") : bad("cutbody 事件", r.body.slice(0, 200));
  mgrStderr.slice(stderrMark2).includes("unhandledRejection")
    ? bad("cutbody 拒绝噪音", mgrStderr.slice(stderrMark2).trim().split("\n").slice(0, 3).join(" | "))
    : ok("非流式断连无 unhandledRejection 噪音");

  // ── T9e HTTP 200 响应完整性与成功统计门禁（F08）──
  console.log("\n=== T9e HTTP 200 response completeness (F08) ===");
  await restartClean();
  const protocolEvent = async (model) => {
    await sleep(120);
    const history = JSON.parse((await admin("/admin/api/history?keyId=" + idA9b + "&pageSize=500")).body).items;
    return history.find((event) => event.model === model) || null;
  };
  const assertInvalidJson200 = async (mode, label) => {
    const model = "m-f08-" + mode;
    await mock("/__reset");
    await mock("/__control", { auth: "user_keyA", responses: [{ mode }] });
    const result = await gw({ model, messages: [] });
    const callsF08 = JSON.parse((await mockGet("/__calls")).body).calls;
    const event = await protocolEvent(model);
    const keyHealth = (await keysList()).find((key) => key.alias === "keyA").health;
    result.status === 502 && callsF08.length === 1 && event && event.ok === false && event.status === 502 &&
      event.errorKind === "upstream" && keyHealth.failCount === 0 && keyHealth.backoffUntilMs <= Date.now()
      ? ok(label + " → 502、单次调用、失败事件且不退避")
      : bad(label + " 门禁", JSON.stringify({ result, calls: callsF08, event, health: keyHealth }));
    const successEvents = JSON.parse((await admin("/admin/api/history?keyId=" + idA9b + "&status=200&pageSize=500")).body).items;
    successEvents.some((event200) => event200.model === model)
      ? bad(label + " 被误记为成功", JSON.stringify(successEvents.find((event200) => event200.model === model)))
      : ok(label + " 无 ok:true/status:200 成功事件");
  };
  await assertInvalidJson200("empty", "clean EOF 空 JSON body");
  await assertInvalidJson200("truncated", "clean EOF 截断 JSON");
  await assertInvalidJson200("malformed", "clean EOF 畸形 JSON");
  await assertInvalidJson200("missingstructure", "JSON 缺少必要 choices 结构");

  const assertInvalidSse200 = async (mode, label) => {
    const model = "m-f08-" + mode;
    await mock("/__reset");
    await mock("/__control", { auth: "user_keyA", responses: [{ mode }] });
    const result = await rawGwOnce({ model, messages: [], stream: true });
    const callsF08 = JSON.parse((await mockGet("/__calls")).body).calls;
    const event = await protocolEvent(model);
    const keyHealth = (await keysList()).find((key) => key.alias === "keyA").health;
    result.outcome !== "timeout" && result.outcome !== "end" && (result.status === 200 || result.status === undefined) && callsF08.length === 1 &&
      event && event.ok === false && event.status === 502 && event.errorKind === "upstream" &&
      keyHealth.failCount === 0 && keyHealth.backoffUntilMs <= Date.now()
      ? ok(label + " → 200 头后有限终止、单次调用、失败事件且不退避")
      : bad(label + " 门禁", JSON.stringify({ result, calls: callsF08, event, health: keyHealth }));
    const successEvents = JSON.parse((await admin("/admin/api/history?keyId=" + idA9b + "&status=200&pageSize=500")).body).items;
    successEvents.some((event200) => event200.model === model)
      ? bad(label + " 被误记为成功", JSON.stringify(successEvents.find((event200) => event200.model === model)))
      : ok(label + " 无 ok:true/status:200 成功事件");
  };
  await assertInvalidSse200("empty_sse", "SSE clean EOF 空 body");
  await assertInvalidSse200("missingdone", "SSE clean EOF 缺少 [DONE]");
  await assertInvalidSse200("unterminateddone", "SSE 最终 [DONE] 缓冲区未闭合");
  await assertInvalidSse200("malformed_sse", "SSE 畸形事件");

  await mock("/__reset");
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "ok" }] });
  r = await gw({ model: "m-f08-non-sse", messages: [], stream: true });
  const nonSseCalls = JSON.parse((await mockGet("/__calls")).body).calls;
  const nonSseEvent = await protocolEvent("m-f08-non-sse");
  r.status === 502 && nonSseCalls.length === 1 && nonSseEvent && nonSseEvent.ok === false && nonSseEvent.status === 502
    ? ok("stream 请求收到 JSON 200 → 明确 502 且不重放")
    : bad("stream 非 SSE 200 门禁", JSON.stringify({ result: r, calls: nonSseCalls, event: nonSseEvent }));

  await mock("/__reset");
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "split_sse" }] });
  r = await gw({ model: "m-f08-split", messages: [], stream: true });
  const splitEvent = await protocolEvent("m-f08-split");
  r.status === 200 && r.body.includes("[DONE]") && splitEvent && splitEvent.ok === true && splitEvent.status === 200
    ? ok("SSE 跨 chunk 拆分后仍按完整帧解析并成功")
    : bad("SSE 跨 chunk 正常路径", JSON.stringify({ result: r, event: splitEvent }));

  // ── T9d 上游脏 usage 净化（P1-6：字符串/对象/null usage 不得入 stats/历史）──
  console.log("\n=== T9d bad usage sanitization (P1-6) ===");
  await restartClean();
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "badusage" }] });
  r = await gw({ model: "m-badusage", messages: [] });
  r.status === 200 ? ok("badusage 请求仍 200") : bad("badusage status", "got " + r.status);
  await sleep(200);
  r = await admin("/admin/api/history?pageSize=1");
  ev = JSON.parse(r.body).items[0];
  ev && ev.model === "m-badusage" && typeof ev.inputTokens === "number" && typeof ev.outputTokens === "number" && typeof ev.cachedTokens === "number" &&
    ev.inputTokens === 0 && ev.outputTokens === 0 && ev.cachedTokens === 0
    ? ok("history usage 净化为数值 0（非字符串/对象/null）", JSON.stringify([ev.inputTokens, ev.outputTokens, ev.cachedTokens]))
    : bad("badusage 净化", JSON.stringify(ev));
  !r.body.includes("onerror") && !r.body.includes("<img") ? ok("history 响应体无原始脏串残留") : bad("badusage 泄漏", r.body.slice(0, 200));

  // ── T10 客户端断连 ──
  console.log("\n=== T10 client disconnect ===");
  await restartClean();
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "slowsse" }] });
  await new Promise((resolveP) => {
    let req;
    let finishTimer;
    let guardTimer;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTrackedTimeout(finishTimer);
      clearTrackedTimeout(guardTimer);
      resolveP();
    };
    req = trackedRequest(MG + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + CLIENT }
    }, (res) => {
      res.once("data", () => {
        finishTimer = trackedTimeout(() => { try { req.destroy(); } catch {} finish(); }, 30);
      });
    });
    req.on("error", finish);
    req.end(JSON.stringify({ model: "m-disc", messages: [], stream: true }));
    guardTimer = trackedTimeout(finish, 5500); // slowsse 15帧×300ms
  });
  await sleep(1000);
  const slow = JSON.parse((await mockGet("/__slow")).body).slowLog;
  // P2-1 修复后：断连应中断上游拉取（aborted=true，frames<15）
  slow.length === 1 && slow[0].aborted === true && slow[0].frames < 15
    ? ok("客户端断开中断上游拉取（P2-1 已修复）", "frames=" + slow[0].frames) : bad("P2-1 断连中断", JSON.stringify(slow));
  r = await http1(MG + "/health", "GET", {});
  r.status === 200 ? ok("断连场景后 manager 存活") : bad("断连存活", "health=" + r.status);
  const clientDisconnectRows = await historyForModel("m-disc");
  clientDisconnectRows.length === 1 && clientDisconnectRows[0].ok === false && clientDisconnectRows[0].status === 499 &&
    clientDisconnectRows[0].errorKind === "client" && clientDisconnectRows[0].attempts === 1 && clientDisconnectRows[0].retries === 0 &&
    Number.isFinite(clientDisconnectRows[0].latencyMs) && clientDisconnectRows[0].latencyMs >= 0
    ? ok("客户端断连记为单条 499/client 终态且不重试")
    : bad("客户端断连统计语义", JSON.stringify(clientDisconnectRows));

  // ── T11 慢非流式（P1-1 修复后：合法慢生成不再被误杀）──
  console.log("\n=== T11 slow non-stream ===");
  await restartClean();
  ks = await keysList();
  const idB11 = ks.find((k) => k.alias === "keyB").id;
  await admin("/admin/api/keys/" + idB11, "PUT", { enabled: false }); // 单 Key 池场景
  await mock("/__reset");
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "delay", delayMs: 18000 }] });
  t0 = performance.now();
  r = await gw({ model: "m-slow", messages: [] });
  const dt11 = performance.now() - t0;
  r.status === 200 && r.body.includes("slow-ok") && dt11 >= 17000
    ? ok("18s 慢生成完整返回 200（P1-1 已修复）", Math.round(dt11) + "ms") : bad("P1-1 慢生成", "status=" + r.status + " dt=" + dt11 + " body=" + r.body.slice(0, 120));
  ks = await keysList();
  ks.find((k) => k.alias === "keyA").health.failCount === 0
    ? ok("慢生成成功不误伤 Key 健康") : bad("慢生成健康", JSON.stringify(ks.find((k) => k.alias === "keyA").health));
  await admin("/admin/api/keys/" + idB11, "PUT", { enabled: true });

  // ── T11b 真超时：connectTimeoutMs=3000 时挂死上游 → 超时退避 + 切换备 Key ──
  await admin("/admin/api/pool", "PUT", { connectTimeoutMs: 3000 });
  await mock("/__reset");
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "hang" }] });
  await mock("/__control", { auth: "user_keyB", responses: [{ mode: "ok" }] });
  t0 = performance.now();
  r = await gw({ model: "m-timeout", messages: [] });
  const dt11b = performance.now() - t0;
  calls = JSON.parse((await mockGet("/__calls")).body).calls;
  r.status === 200 && calls.length === 2 && dt11b >= 2500 && dt11b < 8000
    ? ok("connectTimeout=3s：挂死 → 超时退避 → 切 keyB 成功", Math.round(dt11b) + "ms")
    : bad("超时切换", "status=" + r.status + " dt=" + dt11b + " calls=" + JSON.stringify(calls.map((c) => [c.auth, c.mode])));
  const timeoutRows = await historyForModel("m-timeout");
  const timeoutAttemptRows = await historyForModel("m-timeout", "/admin/api/history?errorKind=timeout&pageSize=500");
  timeoutRows.length === 1 && timeoutRows[0].ok === true && timeoutRows[0].status === 200 && timeoutRows[0].attempts === 2 &&
    timeoutRows[0].retries === 1 && timeoutRows[0].keyId === ks.find((k) => k.alias === "keyB")?.id && timeoutAttemptRows.length === 0
    ? ok("超时 attempt 收敛到最终成功 request 终态")
    : bad("timeout 事件", JSON.stringify({ rows: timeoutRows, timeoutAttemptRows }));
  ks = await keysList();
  ks.find((k) => k.alias === "keyA").health.backoffUntilMs > Date.now()
    ? ok("超时 Key 进入退避") : bad("超时退避", "");
  await admin("/admin/api/pool", "PUT", { connectTimeoutMs: 120000 });

  // ── T12 maxRetries 预算 ──
  console.log("\n=== T12 retry budget ===");
  await restartClean();
  const zz = Array(20).fill({ mode: "zeroout" });
  await mock("/__control", { auth: "user_keyA", responses: [...zz] });
  await mock("/__control", { auth: "user_keyB", responses: [...zz] });
  r = await gw({ model: "m-budget", messages: [] });
  calls = JSON.parse((await mockGet("/__calls")).body).calls;
  r.status === 429 && calls.length === 4 ? ok("总尝试=maxRetries+1=4", calls.map((c) => c.auth.replace("user_", "")).join("→")) : bad("预算", "status=" + r.status + " calls=" + calls.length);

  // ── T13 历史筛选 / 分页 ──
  console.log("\n=== T13 history ===");
  await restartClean(); // 清 T12 退避残留
  r = await admin("/admin/api/history?status=200&pageSize=2");
  let pr = JSON.parse(r.body);
  pr.items.length <= 2 && pr.items.every((i) => i.status === 200) && pr.page === 1
    ? ok("status 筛选 + 分页", "total=" + pr.total) : bad("history 筛选", r.body.slice(0, 200));
  r = await admin("/admin/api/history?errorKind=rate_limit");
  JSON.parse(r.body).total >= 1 ? ok("errorKind 筛选") : bad("errorKind", r.body.slice(0, 120));
  r = await admin("/admin/api/history?pageSize=9999");
  JSON.parse(r.body).pageSize === 500 ? ok("pageSize clamp 500") : bad("pageSize clamp", "");
  r = await admin("/admin/api/history?keyId=k_none");
  JSON.parse(r.body).total === 0 ? ok("未知 keyId 空结果") : bad("未知 keyId", "");

  // ── T14 管理 API：移动 / 启停 / 删除 / 掩码 ──
  console.log("\n=== T14 key mgmt ===");
  ks = await keysList();
  const idA = ks.find((k) => k.alias === "keyA").id, idB = ks.find((k) => k.alias === "keyB").id;
  await admin("/admin/api/keys/" + idB, "PUT", { priority: 0 });
  ks = await keysList();
  ks[0].alias === "keyB" ? ok("主备顺序调整") : bad("移动", JSON.stringify(ks.map((k) => k.alias)));
  await mock("/__reset");
  r = await gw({ model: "m-order", messages: [] });
  calls = JSON.parse((await mockGet("/__calls")).body).calls;
  calls[0] && calls[0].auth === "user_keyB" ? ok("顺序调整后走新主 Key") : bad("新主 Key", JSON.stringify(calls.map((c) => c.auth)));
  await admin("/admin/api/keys/" + idB, "PUT", { priority: 1 }); // 还原
  await admin("/admin/api/keys/" + idA, "PUT", { enabled: false });
  await mock("/__reset");
  r = await gw({ model: "m-disable", messages: [] });
  calls = JSON.parse((await mockGet("/__calls")).body).calls;
  calls.every((c) => c.auth === "user_keyB") ? ok("停用 Key 不接流量") : bad("停用", JSON.stringify(calls.map((c) => c.auth)));
  await admin("/admin/api/keys/" + idA, "PUT", { enabled: true });
  r = await admin("/admin/api/keys");
  r.body.includes("***") && !r.body.includes("user_keyA") ? ok("API 仅回显掩码") : bad("掩码", r.body.slice(0, 200));
  r = await admin("/admin/api/logs");
  let lg = JSON.parse(r.body).logs;
  lg.length > 0 && !JSON.stringify(lg).includes("user_keyA") ? ok("logs 有事件且无 Key 明文", lg.length + " 条") : bad("logs", "");

  // ── T15 设置 PUT：白名单 / clamp / 非法值 ──
  console.log("\n=== T15 settings ===");
  r = await admin("/admin/api/pool", "PUT", { maxRetries: 5, bogus: "x" });
  let pj = JSON.parse(r.body).poolCfg;
  r.status === 200 && pj.maxRetries === 5 && pj.bogus === undefined ? ok("pool 保存 + 未知字段过滤") : bad("pool PUT", r.body.slice(0, 200));
  r = await admin("/admin/api/pool", "PUT", { maxRetries: 999 });
  JSON.parse(r.body).poolCfg.maxRetries === 10 ? ok("越界 clamp 999→10") : bad("clamp", r.body.slice(0, 150));
  r = await admin("/admin/api/pool", "PUT", { strategy: "bogus" });
  const strat = JSON.parse((await admin("/admin/api/pool")).body).poolCfg.strategy;
  r.status === 400 && strat === "active-standby" ? ok("非法 strategy 被拒（保持原值）") : bad("非法 strategy", "status=" + r.status + " now=" + strat);
  r = await admin("/admin/api/pool", "PUT", { zeroOutputCountsAs429: "false" });
  let invalidPool = null;
  try { invalidPool = parseJsonResponse(r, "字符串布尔 pool"); } catch {}
  r.status === 400 && invalidPool?.error?.fields?.some((f) => f.field === "pool.zeroOutputCountsAs429")
    ? ok("字符串布尔值被管理 API 拒绝并返回字段诊断") : bad("字符串布尔 pool", JSON.stringify({ status: r.status, body: r.body }));
  r = await admin("/admin/api/pool", "PUT", { maxRetries: [1] });
  invalidPool = null;
  try { invalidPool = parseJsonResponse(r, "数组数字 pool"); } catch {}
  r.status === 400 && invalidPool?.error?.fields?.some((f) => f.field === "pool.maxRetries")
    ? ok("数组数字被管理 API 拒绝并返回字段诊断") : bad("数组数字 pool", JSON.stringify({ status: r.status, body: r.body }));
  r = await admin("/admin/api/pool", "PUT", { backoffBaseMs: 30000, backoffMaxMs: 5000 });
  invalidPool = null;
  try { invalidPool = parseJsonResponse(r, "反向 backoff pool"); } catch {}
  r.status === 400 && invalidPool?.error?.fields?.some((f) => f.field === "pool.backoffMaxMs")
    ? ok("反向 backoff 时间关系被拒绝") : bad("反向 backoff pool", JSON.stringify({ status: r.status, body: r.body }));
  r = await admin("/admin/api/pool", "PUT", { softStop: 100, fiveHourHardStop: 90 });
  invalidPool = null;
  try { invalidPool = parseJsonResponse(r, "反向阈值 pool"); } catch {}
  r.status === 400 && invalidPool?.error?.fields?.some((f) => f.field === "pool.softStop")
    ? ok("反向额度阈值关系被拒绝") : bad("反向阈值 pool", JSON.stringify({ status: r.status, body: r.body }));
  r = await admin("/admin/api/pool", "PUT", { quotaRefreshMs: "NaN" });
  invalidPool = null;
  try { invalidPool = parseJsonResponse(r, "NaN 时间 pool"); } catch {}
  r.status === 400 && invalidPool?.error?.fields?.some((f) => f.field === "pool.quotaRefreshMs")
    ? ok("NaN 时间参数被拒绝") : bad("NaN 时间 pool", JSON.stringify({ status: r.status, body: r.body }));
  r = await admin("/admin/api/security", "POST", { clientToken: false });
  let invalidSecurity = null;
  try { invalidSecurity = parseJsonResponse(r, "布尔 token"); } catch {}
  r.status === 400 && invalidSecurity?.error?.fields?.some((f) => f.field === "clientToken")
    ? ok("布尔 token 被 security API 拒绝") : bad("布尔 token", JSON.stringify({ status: r.status, body: r.body }));
  await admin("/admin/api/pool", "PUT", { strategy: "round-robin", maxRetries: 3 });
  await mock("/__reset");
  for (let i = 0; i < 4; i++) await gw({ model: "rr-" + i, messages: [] });
  calls = JSON.parse((await mockGet("/__calls")).body).calls;
  new Set(calls.map((c) => c.auth)).size === 2 ? ok("round-robin 双 Key 均摊", calls.map((c) => c.auth.replace("user_", "")).join(",")) : bad("round-robin", JSON.stringify(calls.map((c) => c.auth)));
  await admin("/admin/api/pool", "PUT", { strategy: "active-standby" });
  const cfgJ = JSON.parse(readFileSync(resolve(DATA, "config.json"), "utf-8"));
  cfgJ.pool.maxRetries === 3 && cfgJ.pool.strategy === "active-standby" ? ok("设置持久化 config.json") : bad("设置持久化", JSON.stringify(cfgJ.pool));
  await restartClean();
  r = await admin("/admin/api/pool");
  const poolAfterRestart = parseJsonResponse(r, "T15 restart pool").poolCfg || {};
  r.status === 200 && poolAfterRestart.maxRetries === 3 && poolAfterRestart.strategy === "active-standby"
    ? ok("T15 重启后 pool 配置从磁盘恢复") : bad("T15 pool 重启", JSON.stringify({ status: r.status, pool: poolAfterRestart }));

  // ── T16 security：clientToken 修改即时生效 / AdminToken 回退 / 长度校验 ──
  console.log("\n=== T16 security ===");
  await restartClean();
  r = await admin("/admin/api/security", "POST", { adminToken: "short" });
  r.status === 400 && r.body.includes("至少 8 位") ? ok("adminToken 长度校验") : bad("adminToken 校验", "status=" + r.status);
  await admin("/admin/api/security", "POST", { clientToken: "" });
  r = await gw({ model: "m-fallback-tok", messages: [] }, ADMIN);
  r.status === 200 ? ok("clientToken 空 → AdminToken 回退可用（决策1）") : bad("回退", "status=" + r.status);
  r = await admin("/admin/api/security", "POST", { clientToken: "new-cli-tok" });
  r = await gw({ model: "m-x", messages: [] });
  r.status === 401 ? ok("旧 clientToken 立即失效") : bad("旧 token", "status=" + r.status);
  r = await gw({ model: "m-x", messages: [] }, "new-cli-tok");
  r.status === 200 ? ok("新 clientToken 立即生效") : bad("新 token", "status=" + r.status);
  await restartClean();
  r = await gw({ model: "m-client-restart", messages: [] }, "new-cli-tok");
  r.status === 200 ? ok("T16 clientToken 重启后仍有效（已从磁盘提交）") : bad("clientToken 重启", "status=" + r.status);
  r = await gw({ model: "m-client-old", messages: [] }, CLIENT);
  r.status === 401 ? ok("T16 重启后旧 clientToken 仍失效") : bad("旧 clientToken 重启", "status=" + r.status);
  const ADMIN_F04 = "e2e-f04-admin-token-9x";
  r = await admin("/admin/api/security", "POST", { adminToken: ADMIN_F04 });
  r.status === 200 ? ok("T16 AdminToken 更新返回 200") : bad("AdminToken 更新", "status=" + r.status);
  await restartClean();
  r = await http1(MG + "/admin/api/login", "POST", { "Content-Type": "application/json" }, JSON.stringify({ token: ADMIN_F04 }));
  r.status === 200 ? ok("T16 AdminToken 重启后新令牌有效") : bad("AdminToken 重启", "status=" + r.status);
  r = await http1(MG + "/admin/api/login", "POST", { "Content-Type": "application/json" }, JSON.stringify({ token: ADMIN }));
  r.status === 401 ? ok("T16 AdminToken 重启后旧令牌失效") : bad("旧 AdminToken 重启", "status=" + r.status);
  r = await http1(MG + "/admin/api/security", "POST", { "X-Admin-Token": ADMIN_F04, "Content-Type": "application/json" }, JSON.stringify({ adminToken: ADMIN }));
  r.status === 200 ? ok("T16 恢复测试 AdminToken") : bad("恢复 AdminToken", "status=" + r.status);
  await restartClean();
  await admin("/admin/api/security", "POST", { clientToken: CLIENT });

  // ── T17 管理 API 鉴权隔离 ──
  console.log("\n=== T17 admin auth ===");
  r = await http1(MG + "/admin/api/keys", "GET", { Authorization: "Bearer " + ADMIN });
  r.status === 401 ? ok("admin API 不认 Bearer") : bad("admin Bearer", "status=" + r.status);
  r = await http1(MG + "/admin/api/keys", "GET", {});
  r.status === 401 ? ok("admin API 无 token 401") : bad("admin 无 token", "status=" + r.status);
  r = await http1(MG + "/admin/api/login", "POST", { "Content-Type": "application/json" }, JSON.stringify({ token: ADMIN }));
  r.status === 200 ? ok("login 正确") : bad("login", "status=" + r.status);
  r = await http1(MG + "/admin/api/login", "POST", { "Content-Type": "application/json" }, JSON.stringify({ token: "wrong-long-enough" }));
  r.status === 401 ? ok("login 错 token 401") : bad("login 401", "status=" + r.status);
  r = await http1(MG + "/admin", "GET", {});
  r.status === 200 && r.body.includes("<html") ? ok("/admin 页面") : bad("/admin", "status=" + r.status);
  // ── P2-7 CSP + nosniff：仅管理面（含 /admin/api/*），/v1/* 不加 ──
  r.headers["content-security-policy"] && /script-src 'self'/.test(r.headers["content-security-policy"])
    ? ok("/admin CSP（script-src 'self'）") : bad("/admin CSP", JSON.stringify(r.headers["content-security-policy"]));
  r.headers["x-content-type-options"] === "nosniff" ? ok("/admin nosniff") : bad("/admin nosniff", JSON.stringify(r.headers["x-content-type-options"]));
  r = await http1(MG + "/admin/app.mjs", "GET", {});
  r.status === 200 && (r.headers["content-type"] || "").includes("javascript") ? ok("app.mjs content-type") : bad("app.mjs", "status=" + r.status);
  r.headers["content-security-policy"] && r.headers["x-content-type-options"] === "nosniff"
    ? ok("/admin/app.mjs CSP+nosniff") : bad("app.mjs CSP", JSON.stringify([r.headers["content-security-policy"], r.headers["x-content-type-options"]]));
  r = await http1(MG + "/admin/style.css", "GET", {});
  !!r.headers["content-security-policy"] ? ok("/admin/style.css CSP") : bad("style.css CSP", "");
  r = await http1(MG + "/admin/api/keys", "GET", { "X-Admin-Token": ADMIN });
  !!r.headers["content-security-policy"] ? ok("/admin/api/* CSP") : bad("api CSP", "");
  r = await http1(MG + "/health", "GET", {});
  r.headers["content-security-policy"] === undefined ? ok("/health 不加 CSP（仅 /admin 面）") : bad("/health CSP 越界", JSON.stringify(r.headers["content-security-policy"]));
  r = await http1(MG + "/nope", "GET", {});
  r.status === 404 ? ok("未知路径 404") : bad("404", "status=" + r.status);
  r = await http1(MG + "/", "GET", {});
  r.status === 302 && (r.headers.location || "").includes("/admin") ? ok("/ → 302 /admin") : bad("重定向", "status=" + r.status);

  // ── T18 SSE events ──
  console.log("\n=== T18 SSE ===");
  await restartClean();
  const sse = await new Promise((resolveP) => {
    let req;
    let timeoutTimer;
    let triggerTimer;
    let text = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTrackedTimeout(timeoutTimer);
      clearTrackedTimeout(triggerTimer);
      try { req.destroy(); } catch {}
      resolveP(text);
    };
    req = trackedRequest(MG + "/admin/api/events", { headers: { "X-Admin-Token": ADMIN } }, (res) => {
      res.on("data", (c) => { text += c; if (text.includes("event: stats")) finish(); });
      res.on("error", finish);
    });
    req.on("error", finish);
    req.end();
    timeoutTimer = trackedTimeout(finish, 5000);
    triggerTimer = trackedTimeout(() => { void gw({ model: "sse-probe", messages: [] }).catch(() => {}); }, 300);
  });
  sse.includes(": connected") && sse.includes("event: stats") ? ok("SSE 推送 stats 事件") : bad("SSE", JSON.stringify(sse.slice(0, 200)));
  r = await http1(MG + "/admin/api/events", "GET", {});
  r.status === 401 ? ok("SSE 未鉴权 401") : bad("SSE 401", "status=" + r.status);
  // ── SSE HttpOnly cookie 鉴权（query token 已因泄漏风险移除）──
  const loginRes = await http1(MG + "/admin/api/login", "POST", { "Content-Type": "application/json" }, JSON.stringify({ token: ADMIN }));
  const setCookie = loginRes.headers["set-cookie"] || "";
  const m = String(setCookie).match(/ccpm_sse=([a-f0-9]{64})/);
  loginRes.status === 200 && m ? ok("login 下发 ccpm_sse cookie") : bad("login cookie", "status=" + loginRes.status + " sc=" + JSON.stringify(setCookie));
  if (m) {
    const attrs = String(setCookie);
    /HttpOnly/.test(attrs) && /Path=\/admin\/api\/events/.test(attrs) && /SameSite=Strict/.test(attrs)
      ? ok("cookie 属性 HttpOnly+Path限定+SameSite=Strict") : bad("cookie 属性", attrs);
    !attrs.includes(ADMIN) ? ok("cookie 值不含明文令牌（SHA-256 摘要）") : bad("cookie 明文泄漏", attrs);
    const sseCookie = await new Promise((resolveP) => {
      let req;
      let timer;
      let done = false;
      const finish = (status) => {
        if (done) return;
        done = true;
        clearTrackedTimeout(timer);
        try { req.destroy(); } catch {}
        resolveP(status);
      };
      req = trackedRequest(MG + "/admin/api/events", { headers: { Cookie: "ccpm_sse=" + m[1] } }, (res) => {
        let text = "";
        res.on("data", (c) => { text += c; if (text.includes(": connected")) finish(res.statusCode); });
        res.on("error", () => finish(res.statusCode || 0));
      });
      req.on("error", () => finish(0));
      req.end();
      timer = trackedTimeout(() => finish(0), 2000);
    });
    sseCookie === 200 ? ok("SSE cookie 鉴权通过") : bad("SSE cookie", "status=" + sseCookie);
    const wrong = await http1(MG + "/admin/api/events", "GET", { Cookie: "ccpm_sse=" + "0".repeat(64) });
    wrong.status === 401 ? ok("错误 cookie → 401") : bad("cookie 负例", "status=" + wrong.status);
    // query token 通道已移除（令牌不得出现在 URL）
    const sseQ = await http1(MG + "/admin/api/events?token=" + encodeURIComponent(ADMIN), "GET", {});
    sseQ.status === 401 ? ok("query ?token= 已拒绝（安全修复）") : bad("query token 未移除", "status=" + sseQ.status);
    // logout 撤销 cookie
    await http1(MG + "/admin/api/logout", "POST", {});
    const afterLogout = String((await http1(MG + "/admin/api/logout", "POST", {})).headers["set-cookie"] || "");
    /Max-Age=0/.test(afterLogout) ? ok("logout 撤销 cookie") : bad("logout 撤销", afterLogout);
  }
  // 空 header 不能通过（x-admin-token: "" 不得被当成匹配空值）
  r = await http1(MG + "/admin/api/keys", "GET", { "x-admin-token": "" });
  r.status === 401 ? ok("空 header 值被拒") : bad("空 header", "status=" + r.status);

  // ── T18b login 速率限制（P1-3）：15min 窗口内失败 ≥10 → 429，成功登录清零 ──
  console.log("\n=== T18b login rate limit (P1-3) ===");
  await restartClean(); // 清空进程内计数（Map 为内存态），本用例独占窗口
  let lr = null;
  for (let i = 0; i < 12; i++) {
    lr = await http1(MG + "/admin/api/login", "POST", { "Content-Type": "application/json" }, JSON.stringify({ token: "wrong-long-enough" }));
    if (i < 9 && lr.status !== 401) break;
  }
  lr.status === 429 && lr.body.includes("too many failed attempts")
    ? ok("失败 ≥10 次 → 429 too many failed attempts") : bad("login 限速", "status=" + lr.status + " body=" + lr.body.slice(0, 120));
  // 锁定期间再次尝试仍 429
  lr = await http1(MG + "/admin/api/login", "POST", { "Content-Type": "application/json" }, JSON.stringify({ token: "wrong-long-enough" }));
  lr.status === 429 ? ok("锁定期内继续 429") : bad("锁定期", "status=" + lr.status);
  // 合法令牌登录成功 → 计数复位（推荐语义：成功清零）
  lr = await http1(MG + "/admin/api/login", "POST", { "Content-Type": "application/json" }, JSON.stringify({ token: ADMIN }));
  lr.status === 200 ? ok("锁定期后正确 token → 200（计数复位）") : bad("复位", "status=" + lr.status);
  let again401 = true;
  for (let i = 0; i < 9; i++) {
    const q = await http1(MG + "/admin/api/login", "POST", { "Content-Type": "application/json" }, JSON.stringify({ token: "wrong-long-enough" }));
    if (q.status !== 401) { again401 = false; break; }
  }
  again401 ? ok("复位后再错 9 次仍 401（非 429）") : bad("复位后再计数", "期望 401 提前出现非 401");
  await restartClean(); // 复位计数，避免污染后续用例

  // ── T18c SECURE_COOKIES（P1-5）：默认不下发 Secure，启用后下发 Secure ──
  console.log("\n=== T18c SECURE_COOKIES (P1-5) ===");
  r = await http1(MG + "/admin/api/login", "POST", { "Content-Type": "application/json" }, JSON.stringify({ token: ADMIN }));
  let sc = String(r.headers["set-cookie"] || "");
  r.status === 200 && !/Secure/i.test(sc)
    ? ok("默认（明文 HTTP 部署）cookie 不含 Secure") : bad("默认 Secure 缺省", sc);
  sc = String((await http1(MG + "/admin/api/logout", "POST", {})).headers["set-cookie"] || "");
  /Max-Age=0/.test(sc) && !/Secure/i.test(sc) ? ok("默认 logout 撤销 cookie 属性一致（无 Secure）") : bad("默认撤销", sc);
  await stopMgr();
  await startMgr({ SECURE_COOKIES: "1" });
  r = await http1(MG + "/admin/api/login", "POST", { "Content-Type": "application/json" }, JSON.stringify({ token: ADMIN }));
  sc = String(r.headers["set-cookie"] || "");
  r.status === 200 && /Secure/.test(sc) && /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc)
    ? ok("SECURE_COOKIES=1 → Set-Cookie 含 Secure") : bad("SECURE_COOKIES=1", "status=" + r.status + " sc=" + sc);
  const mSec = sc.match(/ccpm_sse=([a-f0-9]{64})/);
  const sseSec = await new Promise((resolveP) => {
    let req;
    let timer;
    let done = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      clearTrackedTimeout(timer);
      try { req.destroy(); } catch {}
      resolveP(status);
    };
    req = trackedRequest(MG + "/admin/api/events", { headers: { Cookie: mSec ? "ccpm_sse=" + mSec[1] : "" } }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; if (text.includes(": connected")) finish(res.statusCode); });
      res.on("error", () => finish(res.statusCode || 0));
    });
    req.on("error", () => finish(0));
    req.end();
    timer = trackedTimeout(() => finish(0), 2000);
  });
  sseSec === 200 ? ok("Secure 模式下 SSE cookie 鉴权仍通过（curl 手工回传等价）") : bad("Secure SSE", "status=" + sseSec);
  sc = String((await http1(MG + "/admin/api/logout", "POST", {})).headers["set-cookie"] || "");
  /Max-Age=0/.test(sc) && /Secure/.test(sc) ? ok("Secure 模式 logout 撤销同样带 Secure") : bad("Secure 撤销", sc);
  await stopMgr();
  await startMgr(); // 恢复默认 env，后续用例在明文模式跑

  // ── T18d model 类型/长度校验（P1-4 源头）──
  console.log("\n=== T18d model validation (P1-4) ===");
  await restartClean();
  // 注意：gateway 在 res.end() 之后才 appendEvent，且同毫秒事件排序并列——
  // 取 items[0] + 固定 sleep 在负载下有竞态，改为按谓词轮询（ts 下限排除历史事件）。
  const waitForEvent = async (pred, timeoutMs = 6000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const rr = await admin("/admin/api/history?pageSize=20");
      const hit = JSON.parse(rr.body).items.find(pred);
      if (hit) return hit;
      await sleep(100);
    }
    return null;
  };
  const longModel = "m-" + "x".repeat(200);
  let tMark = Date.now();
  r = await gw({ model: longModel, messages: [] });
  ev = await waitForEvent((e) => e.model === longModel.slice(0, 128) && e.ts >= tMark);
  r.status === 200 && ev && ev.model.length === 128
    ? ok("超长 model → 历史记录截断为 128 字符", "len=" + (ev && ev.model.length)) : bad("model 截断", "status=" + r.status + " ev=" + JSON.stringify(ev && ev.model.slice(0, 40)));
  tMark = Date.now();
  r = await gw({ model: { evil: true }, messages: [] });
  ev = await waitForEvent((e) => e.model === "" && e.ts >= tMark);
  r.status === 200 && ev && ev.ok === true ? ok("非字符串 model → 记录空串且请求正常代理") : bad("model 非字符串", "status=" + r.status + " ev=" + JSON.stringify(ev));

  // ── T19 /v1/models + /v1/messages 路由 ──
  console.log("\n=== T19 routes ===");
  await restartClean();
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "ok" }] });
  r = await http1(MG + "/v1/models", "GET", { Authorization: "Bearer " + CLIENT });
  let modelsBody = null;
  try { modelsBody = JSON.parse(r.body); } catch {}
  r.status === 200 && modelsBody?.object === "list" && Array.isArray(modelsBody?.data)
    ? ok("/v1/models 透传且通过模型列表完整性门禁")
    : bad("/v1/models", "status=" + r.status + " " + r.body.slice(0, 120));
  r.headers["content-security-policy"] === undefined ? ok("/v1/models 无 CSP（网关面不加）") : bad("/v1 CSP 越界", JSON.stringify(r.headers["content-security-policy"]));
  r = await http1(MG + "/v1/models", "GET", {});
  r.status === 401 ? ok("/v1/models 鉴权") : bad("/v1/models auth", "status=" + r.status);
  r = await http1(MG + "/v1/messages", "POST", { "Content-Type": "application/json", Authorization: "Bearer " + CLIENT }, JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "x" }] }));
  let messagesBody = null;
  try { messagesBody = JSON.parse(r.body); } catch {}
  r.status === 200 && messagesBody?.type === "message" && messagesBody?.role === "assistant" && Array.isArray(messagesBody?.content)
    ? ok("/v1/messages 路由到上游且通过 Anthropic JSON 完整性门禁")
    : bad("/v1/messages", "status=" + r.status + " " + r.body.slice(0, 120));

  // ── T20 删除 Key ──
  console.log("\n=== T20 delete ===");
  ks = await keysList();
  r = await admin("/admin/api/keys/" + ks[1].id, "DELETE");
  r.status === 204 ? ok("删除 Key → 204") : bad("删除", "status=" + r.status);
  ks = await keysList();
  ks.length === 1 ? ok("池剩 1 Key") : bad("池大小", ks.length);
  r = await admin("/admin/api/keys/" + ks[0].id, "DELETE");
  r = await admin("/admin/api/keys/" + ks[0].id, "PUT", { alias: "ghost" });
  r.status === 400 ? ok("不存在 Key 更新 → 400") : bad("ghost update", "status=" + r.status);

  // ── T21 4xx 透传 ──
  console.log("\n=== T21 client error passthrough ===");
  await mock("/__reset");
  await admin("/admin/api/keys", "POST", { alias: "keyA", key: "user_keyA" });
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "client4xx", status: 400 }] });
  r = await gw({ model: "m-400", messages: [] });
  calls = JSON.parse((await mockGet("/__calls")).body).calls;
  r.status === 400 && calls.length === 1 ? ok("上游 400 透传不重试") : bad("4xx", "status=" + r.status + " calls=" + calls.length);

  // ── T22 串行额度探测 / SSE 状态事件 / 系统日志持久化 ──
  console.log("\n=== T22 serial probes & status events & log persistence ===");
  await restartClean();
  const rC = (await addKey("keyC", "user_keyC")).response;
  ok("添加 keyC", String(rC.status));
  ks = await keysList();
  const idA22 = ks.find((k) => k.alias === "keyA").id, idC22 = ks.find((k) => k.alias === "keyC").id;
  await mock("/__reset");
  // SSE 收集 quota-status
  const sseEvents = [];
  const sseConn = await new Promise((resolveP) => {
    const req = trackedRequest(MG + "/admin/api/events", { headers: { "X-Admin-Token": ADMIN } }, (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        for (const m of buf.matchAll(/event: ([\w-]+)\ndata: (.*)\n/g)) sseEvents.push([m[1], m[2]]);
        buf = buf.slice(-4000);
      });
      resolveP(req);
    });
    req.on("error", () => resolveP(null));
    req.end();
  });
  await sleep(200);
  // 并发发起两个不同 Key 的刷新 → 后端必须串行（maxActive=1）
  const [fA, fC] = await Promise.all([
    admin("/admin/api/keys/" + idA22 + "/refresh-quota", "POST"),
    admin("/admin/api/keys/" + idC22 + "/refresh-quota", "POST")
  ]);
  let qA = null;
  try { qA = JSON.parse(fA.body).quota; } catch {}
  qA && qA.stale === false && qA.fiveHour && qA.fiveHour.cap === 14 && typeof qA.fiveHour.resetAt === "string"
    ? ok("探测成功：epoch-ms resetAt → ISO，fiveHour cap=14") : bad("探测结果", JSON.stringify(qA));
  qA && qA.totals && qA.totals.runs === 42 ? ok("totals 采集（mock summary）") : bad("totals", JSON.stringify(qA && qA.totals));
  const ql = JSON.parse((await mockGet("/__quota")).body);
  ql.maxActive === 1 && ql.quotaLog.length >= 8
    ? ok("并发刷新被串行化（探测 maxActive=1，共 " + ql.quotaLog.length + " 次）") : bad("串行化", "maxActive=" + ql.maxActive);
  // 同 Key 连续探测时间线不得重叠（串行队列核心不变式）。quotaLog 使用
  // mock 进程的 performance.now()，因此这里比较的是单调时间，不受 wall clock 调整影响。
  let overlap = 0;
  const sorted = [...ql.quotaLog].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].start < sorted[i - 1].end) overlap++;
  overlap === 0 ? ok("探测时间线零重叠（严格串行）") : bad("时间线重叠", overlap + " 处");
  const qEvents = sseEvents.filter(([n]) => n === "quota-status");
  const phases = qEvents.map(([, d]) => { try { return JSON.parse(d).phase; } catch { return ""; } });
  phases.includes("updating") && phases.includes("done")
    ? ok("SSE quota-status 事件流（updating→done）", phases.slice(0, 6).join(">")) : bad("quota-status", JSON.stringify(phases.slice(0, 8)));
  try { sseConn?.destroy(); } catch {}
  // 日志持久化：重启后 events.jsonl 回放，历史日志不丢
  const logsBefore = JSON.parse((await admin("/admin/api/logs?since=0")).body).logs;
  const addLine = logsBefore.filter((l) => l.msg.includes("新增 Key"));
  r = await admin("/admin/api/keys/" + idC22, "DELETE");
  await sleep(1300); // 防抖落盘窗口（logs 为同步 append，此处等 SSE/磁盘一致）
  const fileHas = existsSync(resolve(DATA, "events.jsonl"));
  fileHas ? ok("events.jsonl 已落盘") : bad("events.jsonl", "missing");
  await stopMgr(); await startMgr();
  const logsAfter = JSON.parse((await admin("/admin/api/logs?since=0")).body).logs;
  logsAfter.length >= logsBefore.length && JSON.stringify(logsAfter).includes(addLine[0] ? addLine[0].msg.slice(0, 8) : "新增 Key")
    ? ok("重启后系统日志保留（" + logsBefore.length + " → " + logsAfter.length + " 条）") : bad("日志持久化", logsBefore.length + " → " + logsAfter.length);
  if (!JSON.stringify(logsAfter).includes("user_keyA")) ok("持久化日志无 Key 明文"); else bad("日志明文", "");

  // ── T22b F10 dirty JSONL + existing permissions through a real restart ──
  console.log("\n=== T22b stats/logs physical cleanup on restart (F10) ===");
  await stopMgr();
  const injectDirtyJsonl = (path, rows) => {
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    const separator = current && !current.endsWith("\n") ? "\n" : "";
    writeFileSync(path, current + separator + rows.join("\n") + "\n", { mode: 0o644 });
    chmodSync(path, 0o644);
  };
  const expiredF10 = JSON.stringify({ ts: Date.now() - 40 * 864e5, keyId: idA22, ok: true, model: "f10-expired" });
  injectDirtyJsonl(resolve(DATA, "stats.jsonl"), [expiredF10, "{f10-invalid-stats-json", JSON.stringify({ model: "f10-missing-ts" })]);
  injectDirtyJsonl(resolve(DATA, "events.jsonl"), [
    JSON.stringify({ ts: Date.now() - 40 * 864e5, level: "info", msg: "f10-expired-log" }),
    "{f10-invalid-log-json",
    JSON.stringify({ ts: "bad", msg: "f10-invalid-ts" })
  ]);
  await startMgr();
  const parseJsonl = (path) => {
    if (!existsSync(path)) return { valid: false, rows: [], text: "" };
    const text = readFileSync(path, "utf8");
    const rows = [];
    let valid = true;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { valid = false; }
    }
    return { valid, rows, text };
  };
  const f10StatsDisk = parseJsonl(resolve(DATA, "stats.jsonl"));
  const f10LogsDisk = parseJsonl(resolve(DATA, "events.jsonl"));
  const f10StatsMode = (statSync(resolve(DATA, "stats.jsonl")).mode & 0o777).toString(8);
  const f10LogsMode = (statSync(resolve(DATA, "events.jsonl")).mode & 0o777).toString(8);
  f10StatsDisk.valid && !f10StatsDisk.text.includes("f10-invalid") && !f10StatsDisk.text.includes("f10-expired") && f10StatsMode === "600"
    ? ok("真实重启后 stats 坏/过期行物理清除且权限 0600")
    : bad("F10 stats 重启清理", JSON.stringify({ mode: f10StatsMode, disk: f10StatsDisk }));
  f10LogsDisk.valid && !f10LogsDisk.text.includes("f10-invalid") && !f10LogsDisk.text.includes("f10-expired") && f10LogsMode === "600"
    ? ok("真实重启后 logs 坏/过期行物理清除且权限 0600")
    : bad("F10 logs 重启清理", JSON.stringify({ mode: f10LogsMode, disk: f10LogsDisk }));
  const f10History = JSON.parse((await admin("/admin/api/history?keyId=" + idA22 + "&pageSize=500")).body).items;
  const f10LogsApi = JSON.parse((await admin("/admin/api/logs?since=0")).body).logs;
  !f10History.some((entry) => entry.model === "f10-expired") && !f10LogsApi.some((entry) => entry.msg.includes("f10-expired"))
    ? ok("重启后 history/logs API 不暴露已清除脏数据")
    : bad("F10 API 脏数据", JSON.stringify({ history: f10History.find((entry) => entry.model === "f10-expired"), logs: f10LogsApi.find((entry) => entry.msg.includes("f10-expired")) }));

  // ── T23 hosted supervisor：raw upstream readiness/logs/reaping ──
  console.log("\n=== T23 hosted upstream supervision ===");
  await stopMgr();
  // manager 通过 supervisor 启动原始 upstream；父进程 stdout/stderr 是唯一日志入口。
  const embProc = spawnNode([resolve(ROOT, "src/server.mjs")], {
    ...process.env, DATA_DIR: DATA, PORT: String(TEST_PORTS.embedded), HOST,
    UPSTREAM_HOST: HOST, UPSTREAM_PORT: String(TEST_PORTS.embeddedUpstream), EMBED_UPSTREAM: "1",
    ADMIN_TOKEN: ADMIN, CLIENT_TOKEN: CLIENT, CC_QUOTA_BASE: UP
  });
  let embStdout = "";
  let embStderr = "";
  let upstreamPid = null;
  embProc.stdout.on("data", (c) => { embStdout += c; });
  embProc.stderr.on("data", (c) => { embStderr += c; });
  try {
    upstreamPid = await waitForDirectChild(embProc.pid, "hosted raw upstream child");
    const rawCommand = readFileSync(`/proc/${upstreamPid}/cmdline`, "utf8").split("\0").filter(Boolean);
    const rawCwd = realpathSync(`/proc/${upstreamPid}/cwd`);
    rawCommand.some((part) => part === "proxy.mjs" || part.endsWith("/proxy.mjs")) && rawCwd === resolve(ROOT, "upstream")
      ? ok("hosted supervisor 启动 upstream/proxy.mjs 原始入口", `${rawCommand.join(" ")} cwd=${rawCwd}`)
      : bad("hosted raw upstream 入口", JSON.stringify({ command: rawCommand, cwd: rawCwd }));
    const rawReady = await waitUp(
      testUrl(TEST_PORTS.embeddedUpstream) + "/health",
      20000,
      embProc,
      (response) => response.status === 200 && response.body === "OK",
    );
    rawReady
      ? ok("hosted supervisor 等待真实 upstream /health=200 OK")
      : bad("hosted upstream readiness", "raw upstream /health 未返回 200 OK");
    const managerReady = await waitUp(
      testUrl(TEST_PORTS.embedded) + "/health",
      20000,
      embProc,
      (response) => response.status === 200 && response.body === "OK",
    );
    managerReady
      ? ok("hosted manager 在 upstream ready 后开放 /health")
      : bad("hosted manager readiness", "manager /health 未返回 200 OK");
    let logTxt = "";
    for (let i = 0; i < 80; i++) {
      try {
        const rr = await http1(testUrl(TEST_PORTS.embedded) + "/admin/api/logs?since=0&src=proxy", "GET", { "X-Admin-Token": ADMIN });
        if (rr.status === 200) { logTxt = rr.body; if (parseJsonResponse(rr, "T23 logs").logs.length) break; }
      } catch {}
      await sleep(250);
    }
    const proxyPayload = logTxt ? parseJsonResponse({ status: 200, body: logTxt }, "T23 logs") : { logs: [] };
    const plogs = Array.isArray(proxyPayload.logs) ? proxyPayload.logs : [];
    const pTxt = JSON.stringify(plogs);
    plogs.length >= 1 && plogs.some((l) => l.msg.includes("CC Proxy started") && l.src === "proxy")
      ? ok("T23a 父进程捕获的 upstream 启动日志进入日志页（src=proxy）", plogs.length + " 条") : bad("T23a", pTxt.slice(0, 250));
    embStdout.includes("CC Proxy started") && embStdout.includes("[manager] CC Proxy Manager started")
      ? ok("T23b 父进程 stdout 转发 upstream/manager 日志") : bad("T23b stdout", embStdout.slice(0, 250));
    const diskHas = existsSync(resolve(DATA, "events.jsonl")) && readFileSync(resolve(DATA, "events.jsonl"), "utf-8").includes("\"src\":\"proxy\"");
    diskHas ? ok("T23c proxy 行已落盘 events.jsonl") : bad("T23c", "file missing/no proxy lines");
    // API 层 src 过滤 + level 字段存在
    plogs.every((l) => ["info", "warn", "error"].includes(l.level)) ? ok("T23d level 字段规范化") : bad("T23d", pTxt.slice(0, 200));
  } finally {
    await stopChild(embProc, "embedded manager");
    await assertPidGone(upstreamPid, "hosted upstream after manager exit");
  }

  // raw upstream 正常日志走 stdout；端口冲突时的真实诊断走 stderr，均应由父进程收到。
  let conflictBlocker;
  let conflictProc;
  try {
    conflictBlocker = await listenAt(TEST_PORTS.embeddedUpstream);
    let conflictStdout = "";
    let conflictStderr = "";
    conflictProc = spawnNode([resolve(ROOT, "src/server.mjs")], {
      ...process.env, DATA_DIR: DATA, PORT: String(TEST_PORTS.embedded), HOST,
      UPSTREAM_HOST: HOST, UPSTREAM_PORT: String(TEST_PORTS.embeddedUpstream), EMBED_UPSTREAM: "1",
      ADMIN_TOKEN: ADMIN, CLIENT_TOKEN: CLIENT, CC_QUOTA_BASE: UP
    });
    conflictProc.stdout.on("data", (c) => { conflictStdout += c; });
    conflictProc.stderr.on("data", (c) => { conflictStderr += c; });
    const conflictExit = await waitForChildExit(conflictProc, 10000, "hosted upstream conflict manager");
    conflictExit.code !== 0 && conflictStderr.includes("EADDRINUSE")
      ? ok("T23e 父进程 stderr 转发 raw upstream 端口冲突诊断")
      : bad("T23e stderr 转发", JSON.stringify({ exit: conflictExit, stdout: conflictStdout.slice(0, 250), stderr: conflictStderr.slice(0, 500) }));
  } finally {
    await stopChild(conflictProc, "hosted upstream conflict manager");
    await closeNetServer(conflictBlocker);
  }
  await startMgr();

  // ── T24 F04 只读数据目录：服务明确降级，管理写入不得假成功 ──
  console.log("\n=== T24 durable persistence unavailable ===");
  const readOnlyUrl = testUrl(TEST_PORTS.readonly);
  const readOnlyAdmin = "e2e-readonly-admin-1234";
  const readOnlyProc = spawnNode([resolve(ROOT, "src/server.mjs")], {
    ...process.env, DATA_DIR: "/proc", PORT: String(TEST_PORTS.readonly), HOST,
    UPSTREAM_HOST: HOST, UPSTREAM_PORT: String(TEST_PORTS.mock), EMBED_UPSTREAM: "0",
    ADMIN_TOKEN: readOnlyAdmin, CLIENT_TOKEN: "e2e-readonly-client-1234", CC_QUOTA_BASE: UP
  });
  try {
    let readOnlyHealth = null;
    for (let i = 0; i < 80; i++) {
      try {
        const rr = await http1(readOnlyUrl + "/health", "GET", {});
        if (rr.status === 503) { readOnlyHealth = rr; break; }
      } catch {}
      await sleep(100);
    }
    const healthPayload = readOnlyHealth ? parseJsonResponse(readOnlyHealth, "T24 health") : null;
    readOnlyHealth && healthPayload && healthPayload.ok === false && healthPayload.persistence && healthPayload.persistence.available === false
      ? ok("T24 只读 DATA_DIR health=503 且明确 persistence unavailable")
      : bad("T24 只读 health", JSON.stringify({ response: readOnlyHealth, payload: healthPayload }));

    const readOnlyHeaders = { "X-Admin-Token": readOnlyAdmin, "Content-Type": "application/json" };
    r = await http1(readOnlyUrl + "/admin/api/keys", "POST", readOnlyHeaders, JSON.stringify({ alias: "readonly", key: "user_readonly" }));
    let roKeys = null;
    try { roKeys = parseJsonResponse(r, "T24 keys"); } catch {}
    r.status === 503 && roKeys && roKeys.error && roKeys.error.type === "persistence_error"
      ? ok("T24 Key 写入失败返回 503 persistence_error")
      : bad("T24 Key 写入", JSON.stringify({ status: r.status, body: r.body }));

    r = await http1(readOnlyUrl + "/admin/api/pool", "PUT", readOnlyHeaders, JSON.stringify({ maxRetries: 4 }));
    let roPool = null;
    try { roPool = parseJsonResponse(r, "T24 pool"); } catch {}
    r.status === 503 && roPool && roPool.error && roPool.error.type === "persistence_error"
      ? ok("T24 pool 写入失败返回 503 persistence_error")
      : bad("T24 pool 写入", JSON.stringify({ status: r.status, body: r.body }));

    r = await http1(readOnlyUrl + "/admin/api/security", "POST", readOnlyHeaders, JSON.stringify({ clientToken: "readonly-new" }));
    let roSecurity = null;
    try { roSecurity = parseJsonResponse(r, "T24 security"); } catch {}
    r.status === 503 && roSecurity && roSecurity.error && roSecurity.error.type === "persistence_error"
      ? ok("T24 token 写入失败返回 503 persistence_error")
      : bad("T24 token 写入", JSON.stringify({ status: r.status, body: r.body }));
  } finally {
    await stopChild(readOnlyProc, "read-only manager");
  }

  // ── 汇总 ──
  console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
  if (failures.length) { console.log("Failures:"); for (const f of failures) console.log(" - " + f.name + ": " + f.detail); }
    process.exitCode = fail ? 1 : 0;
  } finally {
    cleanupStarted = true;
    try { await stopMgr(); } catch (e) { console.error("[cleanup] manager：" + e.message); }
    for (const child of [...children]) {
      try { await stopChild(child, "child"); } catch (e) { console.error("[cleanup] child：" + e.message); }
    }
    for (const req of [...activeRequests]) {
      try { req.destroy(); } catch {}
    }
    for (const socket of [...activeSockets]) {
      try { socket.destroy(); } catch {}
    }
    for (const timer of [...activeTimers]) clearTrackedTimeout(timer);
    if (ownedData && DATA) {
      try { rmSync(DATA, { recursive: true, force: true }); } catch (e) { console.error("[cleanup] 临时数据目录：" + e.message); }
    }
    if (dataLock) {
      try { rmSync(dataLock, { recursive: true, force: true }); } catch (e) { console.error("[cleanup] E2E_DATA 锁：" + e.message); }
    }
  }
}

if (SCENARIO === "--harness-probe") {
  harnessProbe().catch((e) => { console.error("HARNESS PROBE ERROR", e.message); process.exitCode = 2; });
} else if (SCENARIO === "--harness-test") {
  harnessRegression().catch((e) => { console.error("HARNESS REGRESSION ERROR", e.message); process.exitCode = 1; });
} else {
  main().catch((e) => { console.error("HARNESS ERROR", e); process.exitCode = 2; });
}
