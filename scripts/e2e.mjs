// ── 端到端测试：起 mock 上游 (3051) + manager (3088, EMBED_UPSTREAM=0)，
// 覆盖鉴权/主备切换/同Key重试/退避持久化/额度感知/统计/管理 API/流式/断连。
// KNOWN-ISSUE 用例如实断言当前缺陷行为，修复对应项后应翻正（见 docs/CODE_REVIEW_2026-09-01.md）。
import http from "http";
import { performance } from "perf_hooks";
import { spawn } from "child_process";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
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

function http1(url, method, headers, body) {
  return new Promise((resP, rejP) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resP({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf-8") }));
    });
    r.on("error", rejP);
    if (body) r.write(body);
    r.end();
  });
}
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
async function startMgr(env = {}) {
  mgr = spawn("node", [resolve(ROOT, "src/server.mjs")], {
    env: { ...process.env, DATA_DIR: DATA, PORT: "3088", HOST, UPSTREAM_HOST: HOST, UPSTREAM_PORT: "3051", EMBED_UPSTREAM: "0", ADMIN_TOKEN: ADMIN, CLIENT_TOKEN: CLIENT, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (process.env.E2E_VERBOSE) {
    mgr.stdout.on("data", (d) => process.stdout.write("[mgr] " + d));
    mgr.stderr.on("data", (d) => process.stderr.write("[mgr!] " + d));
  }
  if (!await waitUp(MG + "/health")) throw new Error("manager not up");
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
  r = await http1(MG + "/admin/app.mjs", "GET", {});
  r.status === 200 && (r.headers["content-type"] || "").includes("javascript") ? ok("app.mjs content-type") : bad("app.mjs", "status=" + r.status);
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

  // ── T19 /v1/models + /v1/messages 路由 ──
  console.log("\n=== T19 routes ===");
  await restartClean();
  await mock("/__control", { auth: "user_keyA", responses: [{ mode: "ok" }] });
  r = await http1(MG + "/v1/models", "GET", { Authorization: "Bearer " + CLIENT });
  r.status === 200 ? ok("/v1/models 透传") : bad("/v1/models", "status=" + r.status + " " + r.body.slice(0, 120));
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
