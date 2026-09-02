// ── 端到端测试：起 mock 上游 (3051) + manager (3088, EMBED_UPSTREAM=0)，
// 覆盖鉴权/主备切换/同Key重试/退避持久化/额度感知/统计/管理 API/流式/断连。
// KNOWN-ISSUE 用例如实断言当前缺陷行为，修复对应项后应翻正（见 docs/CODE_REVIEW_2026-09-01.md）。
import http from "http";
import net from "net";
import { performance } from "perf_hooks";
import { spawn } from "child_process";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env.E2E_DATA || "/tmp/ccpm-e2e";
const HOST = "127.0.0.1";
const UP = `http://${HOST}:3051`;
const MG = `http://${HOST}:3088`;
const ADMIN = "e2e-admin-token-1234";
const CLIENT = "e2e-client-token-5678";

let pass = 0, fail = 0, known = 0;
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ok(name, extra) { pass++; console.log(`  ✅ ${name}${extra ? " — " + extra : ""}`); }
function bad(name, detail) { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}\n     ${detail}`); }
// 当前缺陷行为如实断言；修复后应改为断言正确行为
function knownIssue(cond, name, detail) {
  if (cond) { known++; console.log(`  ⚠️  KNOWN-ISSUE ${name}`); }
  else bad(name + "（缺陷行为未复现，请更新用例）", detail);
}

// ── 排他预检（M6）：本测试独占 3088(manager)/3051(mock)/3089(T5d)/3090(T5e)/3087(T23)。
// 并行跑两份 e2e 或与开发实例共存时，后起进程 spawn 会失败但 waitUp 轮询到先起实例
// → 断言打在别人实例上假绿。此处先探测端口占用，任一冲突立即 fail-fast，
// DATA 目录清理维持原逻辑（rmSync 兜底崩溃残留）。注意 3089/3090/3087 在单次运行内
// 是顺序子用例端口（不并行），但同样要防外部实例。
const E2E_PORTS = [3088, 3051, 3089, 3090, 3087]; // manager/mock/T5d/T5e/T23(嵌入,3052 为内嵌上游)
const PROBE_TIMEOUT_MS = 300;
function portBusy(port) {
  return new Promise((resolveP) => {
    const sock = net.createConnection({ host: HOST, port }, () => { sock.destroy(); resolveP(true); });
    sock.on("error", () => resolveP(false));
    sock.setTimeout(PROBE_TIMEOUT_MS, () => { sock.destroy(); resolveP(false); });
  });
}
async function preflightPorts() {
  const busy = [];
  for (const p of E2E_PORTS) if (await portBusy(p)) busy.push(p);
  if (busy.length) {
    console.error(`\n[preflight] 端口被占用：${busy.join(", ")}`);
    console.error("[preflight] 已有 e2e 在跑？还是有开发实例占用这些端口？");
    console.error(`[preflight] 请先停掉占用进程后重跑（本测试固定使用 ${E2E_PORTS.join("/")}，DATA=${DATA}）`);
    process.exit(1);
  }
}

function http1(url, method, headers, body, timeoutMs = HTTP1_TIMEOUT_MS) {
  return new Promise((resP, rejP) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { clearTimeout(timer); resP({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf-8") }); });
    });
    r.on("error", (e) => { clearTimeout(timer); rejP(e); });
    // 总超时护栏（L-h）：被测 server 回归挂起（如等待上游）时，http1 不得无限期等
    // 响应挂死整个 job。60s 高于任何设计内长用例（T11 真实等 18s），低于 CI 全局超时。
    const timer = setTimeout(() => {
      try { r.destroy(); } catch {}
      rejP(Object.assign(new Error(`http1 超时：${timeoutMs}ms 内未完成（${method} ${url}），被测服务疑似挂起`), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    if (body) r.write(body);
    r.end();
  });
}
// L-h：http1 总超时上限（env 可调；恒高于 T11 18s / rawGwOnce 8s race 等设计内长用例）
const HTTP1_TIMEOUT_MS = Number(process.env.E2E_HTTP_TIMEOUT_MS || 60000);
const mock = (path, body) => http1(UP + path, "POST", { "Content-Type": "application/json" }, body ? JSON.stringify(body) : "");
const mockGet = (path) => http1(UP + path, "GET", {});
const admin = (path, method = "GET", body) => http1(MG + path, method, { "X-Admin-Token": ADMIN, ...(body ? { "Content-Type": "application/json" } : {}) }, body ? JSON.stringify(body) : undefined);
const gw = (body, token = CLIENT) => http1(MG + "/v1/chat/completions", "POST", { "Content-Type": "application/json", Authorization: "Bearer " + token }, JSON.stringify(body));
const keysList = async () => JSON.parse((await admin("/admin/api/keys")).body).keys;

async function waitUp(url, timeout = 20000) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) { try { const r = await http1(url, "GET", {}); if (r.status < 500) return true; } catch {} await sleep(150); }
  return false;
}

let mgr;
let mgrStderr = ""; // 始终捕获：供 P1-1 用例断言无 unhandledRejection 噪音
async function startMgr(env = {}) {
  mgr = spawn("node", [resolve(ROOT, "src/server.mjs")], {
    env: { ...process.env, DATA_DIR: DATA, PORT: "3088", HOST, UPSTREAM_HOST: HOST, UPSTREAM_PORT: "3051", EMBED_UPSTREAM: "0", ADMIN_TOKEN: ADMIN, CLIENT_TOKEN: CLIENT, CC_QUOTA_BASE: UP, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  mgrStderr = "";
  mgr.stderr.on("data", (d) => { mgrStderr += d; if (process.env.E2E_VERBOSE) process.stderr.write("[mgr!] " + d); });
  if (process.env.E2E_VERBOSE) {
    mgr.stdout.on("data", (d) => process.stdout.write("[mgr] " + d));
  }
  if (!await waitUp(MG + "/health")) throw new Error("manager not up");
}
// 原始 HTTP 请求 + 超时 race：验证连接被有限时间内终止（end/aborted/ECONNRESET），
// 而非挂死到 race 超时（HANG）。resolve 永不 reject。
function rawGwOnce(bodyObj, timeoutMs = 8000) {
  const t0 = performance.now();
  return Promise.race([
    new Promise((resolveP) => {
      const req = http.request(MG + "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + CLIENT }
      }, (res) => {
        let txt = "";
        res.on("data", (c) => (txt += c));
        res.on("end", () => resolveP({ outcome: "end", ms: Math.round(performance.now() - t0), txt }));
        res.on("aborted", () => resolveP({ outcome: "aborted", ms: Math.round(performance.now() - t0), txt }));
      });
      req.on("error", (e) => resolveP({ outcome: "error:" + (e.code || e.message), ms: Math.round(performance.now() - t0), txt: "" }));
      req.end(JSON.stringify(bodyObj));
    }),
    sleep(timeoutMs).then(() => ({ outcome: "HANG", ms: timeoutMs, txt: "" }))
  ]);
}
function stopMgr() { return new Promise((r) => { if (!mgr) return r(); mgr.on("exit", r); try { mgr.kill("SIGTERM"); } catch { return r(); } setTimeout(r, 3000); }); }
async function restartClean() {
  await sleep(1300); // 等 state.json 1s 防抖落盘
  await stopMgr();
  const p = resolve(DATA, "state.json");
  if (existsSync(p)) {
    const st = JSON.parse(readFileSync(p, "utf-8"));
    for (const h of Object.values(st.keys || {})) { h.backoffUntilMs = 0; h.failCount = 0; h.quotaLimitedUntil = 0; h.authError = false; }
    writeFileSync(p, JSON.stringify(st));
  }
  await startMgr();
  await mock("/__reset");
}

async function main() {
  // M6 排他预检：在任何 spawn / rmSync 之前。端口被占 → 快速失败，
  // 避免后起进程断言打到先起实例上假绿（DATA 崩溃残留清理维持 rmSync 原逻辑）。
  await preflightPorts();
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  const mockProc = spawn("node", [resolve(ROOT, "scripts/mock-upstream.mjs")], { env: { ...process.env, MOCK_PORT: "3051", MOCK_HOST: HOST }, stdio: ["ignore", "pipe", "pipe"] });
  if (process.env.E2E_VERBOSE) mockProc.stdout.on("data", (d) => process.stdout.write("[mock] " + d));
  else mockProc.stdout.resume();
  mockProc.stderr.on("data", (d) => process.stderr.write("[mock!] " + d));
  let e2eDone = false;
  mockProc.on("exit", (code, sig) => { if (!e2eDone) { console.error("mock died code=" + code + " sig=" + sig); process.exitCode = 2; } });
  if (!await waitUp(UP + "/health")) { console.error("mock not up"); process.exit(2); }
  await startMgr();

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
  let rr = await admin("/admin/api/keys", "POST", { alias: "keyA", key: "user_keyA" });
  ok("添加 keyA", "201=" + rr.status);
  rr = await admin("/admin/api/keys", "POST", { alias: "keyB", key: "user_keyB" });
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
  r = await admin("/admin/api/history?errorKind=rate_limit");
  JSON.parse(r.body).total === 0 ? ok("重试成功不留 rate_limit 失败事件") : bad("重试事件", r.body.slice(0, 150));

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
  await new Promise((re) => { mgr.on("exit", re); mgr.kill("SIGTERM"); setTimeout(re, 4000); });
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
    for (const h of Object.values(st.keys || {})) { h.backoffUntilMs = 0; h.failCount = 0; h.quotaLimitedUntil = 0; h.authError = false; }
    writeFileSync(stPath, JSON.stringify(st));
  }
  await startMgr();
  await mock("/__reset");

  // ── T5d 损坏 config.json 备份（P2-1：不再静默覆盖致凭证永久丢失）──
  // 独立 DATA/端口，手工 spawn，不触碰主流程 DATA 与全局 mgr。
  console.log("\n=== T5d corrupt config backup (P2-1) ===");
  {
    const D5d = "/tmp/ccpm-e2e-corrupt";
    rmSync(D5d, { recursive: true, force: true });
    mkdirSync(D5d, { recursive: true });
    writeFileSync(resolve(D5d, "config.json"), "{ not json");
    const TOK5d = "e2e-fixed-admin-tok-9f8e";
    const U5d = "http://" + HOST + ":3089";
    const p5d = spawn("node", [resolve(ROOT, "src/server.mjs")], {
      env: { ...process.env, DATA_DIR: D5d, PORT: "3089", HOST, UPSTREAM_HOST: HOST, UPSTREAM_PORT: "3051", EMBED_UPSTREAM: "0", ADMIN_TOKEN: TOK5d, CLIENT_TOKEN: TOK5d, CC_QUOTA_BASE: UP },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out5d = "";
    p5d.stdout.on("data", (d) => { out5d += d; });
    p5d.stderr.on("data", (d) => { out5d += d; });
    (await waitUp(U5d + "/health")) ? ok("T5d 损坏 config 下服务正常启动（默认值+env）") : bad("T5d 启动", out5d.slice(0, 300));
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
    p5d.kill("SIGTERM");
    await new Promise((re) => { p5d.on("exit", re); setTimeout(re, 3000); });
    rmSync(D5d, { recursive: true, force: true });
  }

  // ── T5e env 令牌不再回滚磁盘凭证（P2-2）──
  // 独立 DATA：首启用 env A 建立磁盘令牌 → 保留 DATA 换 env B 重启 → A 仍可登录、B 被拒。
  // 修复前：B 启动即把磁盘覆写回 B → A 登录 401（红）。不用 restartClean/主 DATA，避免清理干扰。
  console.log("\n=== T5e env token no-rollback (P2-2) ===");
  {
    const D5e = "/tmp/ccpm-e2e-tokenkeep";
    const TOK5eA = "e2e-disk-token-A-aaaa";
    const TOK5eB = "e2e-env-token-B-bbbb";
    const U5e = "http://" + HOST + ":3090";
    const spawn5e = (tok) => spawn("node", [resolve(ROOT, "src/server.mjs")], {
      env: { ...process.env, DATA_DIR: D5e, PORT: "3090", HOST, UPSTREAM_HOST: HOST, UPSTREAM_PORT: "3051", EMBED_UPSTREAM: "0", ADMIN_TOKEN: tok, CLIENT_TOKEN: tok, CC_QUOTA_BASE: UP },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const kill5e = (p) => new Promise((re) => { p.on("exit", re); p.kill("SIGTERM"); setTimeout(re, 3000); });
    rmSync(D5e, { recursive: true, force: true });
    mkdirSync(D5e, { recursive: true });
    let p5e = spawn5e(TOK5eA);
    const upA5e = await waitUp(U5e + "/health");
    upA5e ? ok("T5e 首次启动（env=A）正常") : bad("T5e 首次启动", D5e);
    let cfg5e = null;
    try { cfg5e = JSON.parse(readFileSync(resolve(D5e, "config.json"), "utf-8")); } catch {}
    cfg5e && cfg5e.adminToken === TOK5eA ? ok("T5e 磁盘 config.json 已建立 token=A") : bad("T5e 首启落盘", JSON.stringify(cfg5e && cfg5e.adminToken));
    await kill5e(p5e);
    p5e = spawn5e(TOK5eB);
    const upB5e = await waitUp(U5e + "/health");
    if (!upB5e) bad("T5e 二次启动（env=B）", D5e);
    r = await http1(U5e + "/admin/api/login", "POST", { "Content-Type": "application/json" }, JSON.stringify({ token: TOK5eA }));
    const okA = r.status === 200;
    okA ? ok("T5e env=B 重启后磁盘 token=A 仍有效（未回滚）") : bad("T5e A 登录", "status=" + r.status);
    r = await http1(U5e + "/admin/api/login", "POST", { "Content-Type": "application/json" }, JSON.stringify({ token: TOK5eB }));
    const okB = r.status === 401;
    okB ? ok("T5e env=B 未获得登录权（env 不覆写非空磁盘值）") : bad("T5e B 登录应 401", "status=" + r.status);
    upB5e && okA && okB ? ok("T5e 综合：P2-2 语义正确") : bad("T5e 综合", "up=" + upB5e + " A=" + okA + " B=" + okB);
    await kill5e(p5e);
    rmSync(D5e, { recursive: true, force: true });
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
  await admin("/admin/api/keys/" + kA.id + "/clear-auth", "POST");
  ks = await keysList();
  !ks.find((k) => k.alias === "keyA").health.authError ? ok("clear-auth 恢复") : bad("clear-auth", "");

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
  upstreamEv.total === 1 && upstreamEv.items[0].ok === false && upstreamEv.items[0].model === "m-cut"
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
  JSON.parse(r.body).total === 2
    ? ok("cutbody 也记 ok:false upstream 事件（累计 2 条）") : bad("cutbody 事件", r.body.slice(0, 200));
  mgrStderr.slice(stderrMark2).includes("unhandledRejection")
    ? bad("cutbody 拒绝噪音", mgrStderr.slice(stderrMark2).trim().split("\n").slice(0, 3).join(" | "))
    : ok("非流式断连无 unhandledRejection 噪音");

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

  // ── T10 客户端断连（KNOWN: P2-1）──
  console.log("\n=== T10 client disconnect ===");
  await restartClean();
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "slowsse" }] });
  await new Promise((resolveP) => {
    const req = http.request(MG + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + CLIENT }
    }, (res) => { res.once("data", () => setTimeout(() => { try { req.destroy(); } catch {} }, 30)); });
    req.on("error", () => {});
    req.end(JSON.stringify({ model: "m-disc", messages: [], stream: true }));
    setTimeout(resolveP, 5500); // slowsse 15帧×300ms
  });
  await sleep(1000);
  const slow = JSON.parse((await mockGet("/__slow")).body).slowLog;
  // P2-1 修复后：断连应中断上游拉取（aborted=true，frames<15）
  slow.length === 1 && slow[0].aborted === true && slow[0].frames < 15
    ? ok("客户端断开中断上游拉取（P2-1 已修复）", "frames=" + slow[0].frames) : bad("P2-1 断连中断", JSON.stringify(slow));
  r = await http1(MG + "/health", "GET", {});
  r.status === 200 ? ok("断连场景后 manager 存活") : bad("断连存活", "health=" + r.status);

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
  r = await admin("/admin/api/history?errorKind=timeout");
  JSON.parse(r.body).total >= 1 ? ok("timeout 事件记录") : bad("timeout 事件", r.body.slice(0, 120));
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
  await admin("/admin/api/pool", "PUT", { strategy: "round-robin", maxRetries: 3 });
  await mock("/__reset");
  for (let i = 0; i < 4; i++) await gw({ model: "rr-" + i, messages: [] });
  calls = JSON.parse((await mockGet("/__calls")).body).calls;
  new Set(calls.map((c) => c.auth)).size === 2 ? ok("round-robin 双 Key 均摊", calls.map((c) => c.auth.replace("user_", "")).join(",")) : bad("round-robin", JSON.stringify(calls.map((c) => c.auth)));
  await admin("/admin/api/pool", "PUT", { strategy: "active-standby" });
  const cfgJ = JSON.parse(readFileSync(resolve(DATA, "config.json"), "utf-8"));
  cfgJ.pool.maxRetries === 3 && cfgJ.pool.strategy === "active-standby" ? ok("设置持久化 config.json") : bad("设置持久化", JSON.stringify(cfgJ.pool));

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
    const req = http.request(MG + "/admin/api/events", { headers: { "X-Admin-Token": ADMIN } }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; if (text.includes("event: stats")) { try { req.destroy(); } catch {} resolveP(text); } });
      setTimeout(() => { try { req.destroy(); } catch {} resolveP(text); }, 5000);
    });
    req.on("error", () => {});
    req.end();
    setTimeout(() => { gw({ model: "sse-probe", messages: [] }); }, 300);
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
      const req = http.request(MG + "/admin/api/events", { headers: { Cookie: "ccpm_sse=" + m[1] } }, (res) => {
        let text = "";
        res.on("data", (c) => { text += c; if (text.includes(": connected")) { try { req.destroy(); } catch {} resolveP(res.statusCode); } });
        setTimeout(() => { try { req.destroy(); } catch {} resolveP(res.statusCode); }, 2000);
      });
      req.on("error", () => resolveP(0));
      req.end();
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
    const req = http.request(MG + "/admin/api/events", { headers: { Cookie: mSec ? "ccpm_sse=" + mSec[1] : "" } }, (res) => {
      let text = "";
      const finish = () => { try { req.destroy(); } catch {} resolveP(res.statusCode); };
      res.on("data", (c) => { text += c; if (text.includes(": connected")) finish(); });
      setTimeout(finish, 2000);
    });
    req.on("error", () => resolveP(0));
    req.end();
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
  r.status === 200 ? ok("/v1/models 透传") : bad("/v1/models", "status=" + r.status + " " + r.body.slice(0, 120));
  r.headers["content-security-policy"] === undefined ? ok("/v1/models 无 CSP（网关面不加）") : bad("/v1 CSP 越界", JSON.stringify(r.headers["content-security-policy"]));
  r = await http1(MG + "/v1/models", "GET", {});
  r.status === 401 ? ok("/v1/models 鉴权") : bad("/v1/models auth", "status=" + r.status);
  r = await http1(MG + "/v1/messages", "POST", { "Content-Type": "application/json", Authorization: "Bearer " + CLIENT }, JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "x" }] }));
  r.status === 200 ? ok("/v1/messages 路由到上游") : bad("/v1/messages", "status=" + r.status + " " + r.body.slice(0, 120));

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
  const rC = await admin("/admin/api/keys", "POST", { alias: "keyC", key: "user_keyC" });
  ok("添加 keyC", String(rC.status));
  ks = await keysList();
  const idA22 = ks.find((k) => k.alias === "keyA").id, idC22 = ks.find((k) => k.alias === "keyC").id;
  await mock("/__reset");
  // SSE 收集 quota-status
  const sseEvents = [];
  const sseConn = await new Promise((resolveP) => {
    const req = http.request(MG + "/admin/api/events", { headers: { "X-Admin-Token": ADMIN } }, (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        for (const m of buf.matchAll(/event: ([\w-]+)\ndata: (.*)\n/g)) sseEvents.push([m[1], m[2]]);
        buf = buf.slice(-4000);
      });
      resolveP(req);
    });
    req.on("error", () => {});
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
  // 同 Key 连续探测时间线不得重叠（串行队列核心不变式）。
  // 容忍 20ms：mock 的 start/end 时间戳记在 handler 两端，事件循环在高负载下
  // 的调度抖动会让相邻探测的记录区间产生 <20ms 的表观重叠（真实并发在
  // maxActive=1 主断言即被捕获；即便主断言因时序缝隙漏过，真并发的重叠时长
  // ≈ MOCK_QUOTA_LATENCY(120ms) 也远超容差）。
  let overlap = 0;
  const sorted = [...ql.quotaLog].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].start < sorted[i - 1].end - 20) overlap++;
  overlap === 0 ? ok("探测时间线零重叠（严格串行）") : bad("时间线重叠", overlap + " 处");
  const qEvents = sseEvents.filter(([n]) => n === "quota-status");
  const phases = qEvents.map(([, d]) => { try { return JSON.parse(d).phase; } catch { return ""; } });
  phases.includes("updating") && phases.includes("done")
    ? ok("SSE quota-status 事件流（updating→done）", phases.slice(0, 6).join(">")) : bad("quota-status", JSON.stringify(phases.slice(0, 8)));
  try { sseConn.destroy(); } catch {}
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

  // ── T23 上游 proxy.mjs 日志捕获（嵌入模式）──
  console.log("\n=== T23 proxy log capture ===");
  await stopMgr();
  // 独立起嵌入模式进程并捕获 stdout：验证 ①docker logs 通道原样透传 ②proxy 行进日志环/落盘
  const embOut = await new Promise(async (resolveP) => {
    const proc = spawn("node", [resolve(ROOT, "src/server.mjs")], {
      env: { ...process.env, DATA_DIR: DATA, PORT: "3087", HOST, UPSTREAM_HOST: HOST, UPSTREAM_PORT: "3052", EMBED_UPSTREAM: "1", ADMIN_TOKEN: ADMIN, CLIENT_TOKEN: CLIENT, CC_QUOTA_BASE: UP },
      stdio: ["ignore", "pipe", "pipe"]
    }); // 嵌入上游监听 3052（避开 mock 的 3051）；quota 探测仍指 mock
    let txt = "";
    proc.stdout.on("data", (c) => { txt += c; });
    proc.stderr.on("data", (c) => { txt += c; });
    let logTxt = "";
    for (let i = 0; i < 80; i++) {
      try {
        const rr = await http1("http://" + HOST + ":3087/admin/api/logs?since=0&src=proxy", "GET", { "X-Admin-Token": ADMIN });
        if (rr.status === 200) { logTxt = rr.body; if (JSON.parse(logTxt).logs.length) break; }
      } catch {}
      await sleep(250);
    }
    const proxyLogs = JSON.parse(logTxt || "{\"logs\":[]}").logs;
    resolveP({ txt, proxyLogs, proc });
  });
  const plogs = embOut.proxyLogs;
  const pTxt = JSON.stringify(plogs);
  plogs.length >= 1 && plogs.some((l) => l.msg.includes("CC Proxy started") && l.src === "proxy")
    ? ok("T23a 上游启动日志入日志页（src=proxy，含捕获前于挂钩的启动行）", plogs.length + " 条") : bad("T23a", pTxt.slice(0, 250));
  embOut.txt.includes("CC Proxy started") && embOut.txt.includes("[manager] CC Proxy Manager started")
    ? ok("T23b stdout 原样透传不受捕获影响（docker logs 通道完好）") : bad("T23b", embOut.txt.slice(0, 250));
  const diskHas = existsSync(resolve(DATA, "events.jsonl")) && readFileSync(resolve(DATA, "events.jsonl"), "utf-8").includes("\"src\":\"proxy\"");
  diskHas ? ok("T23c proxy 行已落盘 events.jsonl") : bad("T23c", "file missing/no proxy lines");
  // API 层 src 过滤 + level 字段存在
  plogs.every((l) => ["info", "warn", "error"].includes(l.level)) ? ok("T23d level 字段规范化") : bad("T23d", pTxt.slice(0, 200));
  embOut.proc.kill("SIGTERM");
  await new Promise((r) => { embOut.proc.on("exit", r); setTimeout(r, 2000); });
  await startMgr();

  // ── 汇总 ──
  console.log(`\n=== summary: ${pass} passed, ${fail} failed, ${known} known-issue ===`);
  if (failures.length) { console.log("Failures:"); for (const f of failures) console.log(" - " + f.name + ": " + f.detail); }
  await stopMgr();
  e2eDone = true;
  try { mockProc.kill("SIGTERM"); } catch {}
  await sleep(300);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error("HARNESS ERROR", e); try { await stopMgr(); } catch {} process.exit(2); });
