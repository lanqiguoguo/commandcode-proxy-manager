import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/patch-upstream-initialization.mjs <proxy.mjs>");
  process.exit(2);
}

const PATCH_MARKER = "// CCPM_INITIALIZATION_PATCH_V1";
const ABORT_GUARD_MARKER = "// CCPM_INITIALIZATION_ABORT_GUARD_V1";
const STATE_COMMENT = "// ── 每 Key 独立状态（fingerprint + 初始化节流） ──";
const MODELS_COMMENT = "// ── 模型列表 ───────────────────────────────────────";
const INIT_CALL = "  try {\n    // 首次初始化（fingerprint + lifecycle）\n    await ensureInitialized(apiKey, abortController.signal);";
const KEY_STATE_CLEANUP_RE = /^([\t ]*)keyStateStore\.delete\(key\);([^\r\n]*)(\r?\n|$)/gm;

function fail(message) {
  throw new Error("upstream initialization patch failed: " + message);
}

function count(source, needle) {
  let total = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) >= 0) {
    total++;
    offset += needle.length;
  }
  return total;
}

function findMatchingBrace(source, functionStart) {
  const open = source.indexOf("{", functionStart);
  if (open < 0) fail("找不到函数左大括号");
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = open; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (c === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === "*" && next === "/") { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && next === "/") { lineComment = true; i++; continue; }
    if (c === "/" && next === "*") { blockComment = true; i++; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  fail("函数缺少匹配的右大括号");
}

function findUnique(source, needle, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    fail(label + " 应恰好出现一次");
  }
  return first;
}

function initializationBlock() {
  return [
    PATCH_MARKER,
    "// 每个 API Key 的初始化使用独立 flight；失败只清理 flight，不推进节流窗口。",
    "const keyStateStore = new Map(); // apiKey → { fingerprint, nextInitAt, initFlight, evictWhenIdle }",
    "",
    "function getOrCreateKeyState(apiKey) {",
    "  let state = keyStateStore.get(apiKey);",
    "  if (!state) {",
    "    state = {",
    "      fingerprint: generateFingerprint(),",
    "      nextInitAt: 0,",
    "      initFlight: null,",
    "      evictWhenIdle: false,",
    "    };",
    "    keyStateStore.set(apiKey, state);",
    "    log('info', 'Fingerprint generated for key', { keyPrefix: apiKey.slice(0, 8) });",
    "  }",
    "  return state;",
    "}",
    "",
    "function evictExpiredKeyState(apiKey) {",
    "  const state = keyStateStore.get(apiKey);",
    "  if (!state) return;",
    "  const flight = state.initFlight;",
    "  if (flight && !flight.settled) {",
    "    state.evictWhenIdle = true;",
    "    if (!flight.controller.signal.aborted) flight.controller.abort();",
    "    return;",
    "  }",
    "  keyStateStore.delete(apiKey);",
    "}",
    "",
    "// ── 初始化预请求（fingerprint + lifecycle，首次 + 每 8h+2h 抖动） ────",
    "const INIT_REFRESH_MS = 8 * 60 * 60 * 1000;    // 8h",
    "const INIT_JITTER_MS  = 2 * 60 * 60 * 1000;    // 2h 抖动",
    "const INIT_TIMEOUT_DEFAULT_MS = 10000;",
    "const INIT_TIMEOUT_MIN_MS = 50;",
    "const INIT_TIMEOUT_MAX_MS = 120000;",
    "const INIT_RESPONSE_MAX_BYTES = 64 * 1024;",
    "",
    "function initializationTimeoutMs() {",
    "  const value = Number(process.env.CC_INIT_TIMEOUT_MS);",
    "  return Number.isFinite(value) && value >= INIT_TIMEOUT_MIN_MS && value <= INIT_TIMEOUT_MAX_MS",
    "    ? Math.floor(value)",
    "    : INIT_TIMEOUT_DEFAULT_MS;",
    "}",
    "",
    "function initializationAbortError(signal) {",
    "  const reason = signal?.reason;",
    "  if (reason && reason.name === 'AbortError') return reason;",
    "  const error = new Error('The operation was aborted');",
    "  error.name = 'AbortError';",
    "  if (reason !== undefined) error.cause = reason;",
    "  return error;",
    "}",
    "",
    "function throwIfInitializationAborted(signal) {",
    "  if (signal?.aborted) throw initializationAbortError(signal);",
    "}",
    "",
    "async function consumeInitializationResponse(response, label) {",
    "  if (!response.ok) {",
    "    try { await response.body?.cancel(); } catch {}",
    "    throw new Error(`${label} responded with HTTP ${response.status}`);",
    "  }",
    "  if (!response.body) return response;",
    "  const reader = response.body.getReader();",
    "  let totalBytes = 0;",
    "  try {",
    "    while (true) {",
    "      const { done, value } = await reader.read();",
    "      if (done) break;",
    "      totalBytes += value.byteLength;",
    "      if (totalBytes > INIT_RESPONSE_MAX_BYTES) {",
    "        try { await reader.cancel(); } catch {}",
    "        throw new Error(`${label} response body exceeds ${INIT_RESPONSE_MAX_BYTES} bytes`);",
    "      }",
    "    }",
    "  } finally {",
    "    reader.releaseLock();",
    "  }",
    "  return response;",
    "}",
    "",
    "async function performInitialization(apiKey, state, signal) {",
    "  const timeoutController = new AbortController();",
    "  const timeoutTimer = setTimeout(() => timeoutController.abort(), initializationTimeoutMs());",
    "  timeoutTimer.unref?.();",
    "  const requestSignal = AbortSignal.any([signal, timeoutController.signal]);",
    "",
    "  try {",
    "    const headers = {",
    "      'Content-Type': 'application/json',",
    "      'x-cli-environment': 'production',",
    "      'Authorization': `Bearer ${apiKey}`,",
    "      'x-command-code-version': CC_VERSION,",
    "    };",
    "    const fingerprint = state.fingerprint || {};",
    "    const request = (url, body, label) => fetch(url, {",
    "      method: 'POST', headers, signal: requestSignal, body: JSON.stringify(body),",
    "    }).then((response) => consumeInitializationResponse(response, label));",
    "",
    "    // allSettled 确保另一条预请求也已收尾，避免失败后留下旧 flight 的网络活动。",
    "    const results = await Promise.allSettled([",
    "      request(`${CFG.apiBase}/alpha/fingerprint/record`, fingerprint, 'Fingerprint record'),",
    "      request(`${CFG.apiBase}/alpha/lifecycle-events`, {",
    "        eventType: 'cli_session_exists',",
    "        metadata: {",
    "          sessionId: `sess_${crypto.randomBytes(8).toString('hex')}`,",
    "          cliVersion: CC_VERSION,",
    "          mode: 'interactive',",
    "          os: `${fingerprint.components.platform}-${fingerprint.components.arch}`,",
    "        },",
    "      }, 'Lifecycle event'),",
    "    ]);",
    "    const failure = results.find((result) => result.status === 'rejected');",
    "    if (failure || requestSignal.aborted) {",
    "      const error = failure?.reason instanceof Error",
    "        ? failure.reason",
    "        : new Error('Initialization request aborted');",
    "      const reason = timeoutController.signal.aborted ? 'timeout' : signal.aborted ? 'abort' : 'failure';",
    "      log('warn', 'Fingerprint/lifecycle initialization failed; will retry', { reason, error: error.message });",
    "      return false;",
    "    }",
    "",
    "    // 只有两条请求都拿到 2xx，才开始 8h+2h 节流窗口。",
    "    const jitter = Math.floor(Math.random() * INIT_JITTER_MS);",
    "    state.nextInitAt = Date.now() + INIT_REFRESH_MS + jitter;",
    "    log('info', 'Fingerprint/lifecycle next refresh', { nextIn: `${(INIT_REFRESH_MS + jitter) / 3600000}h` });",
    "    return true;",
    "  } catch (error) {",
    "    // 保护 flight 的最终收尾；调用方的 abort 由 waitForInitialization 单独传播。",
    "    const message = error instanceof Error ? error.message : String(error);",
    "    log('warn', 'Fingerprint/lifecycle initialization exception; will retry', { error: message });",
    "    return false;",
    "  } finally {",
    "    clearTimeout(timeoutTimer);",
    "  }",
    "}",
    "",
    "function finishInitialization(apiKey, state, flight) {",
    "  flight.settled = true;",
    "  if (state.initFlight !== flight) return;",
    "  state.initFlight = null;",
    "  if (state.evictWhenIdle && !sessionStore.has(apiKey)) keyStateStore.delete(apiKey);",
    "}",
    "",
    "function startInitialization(apiKey, state) {",
    "  const flight = { controller: new AbortController(), waiters: 0, settled: false, promise: null };",
    "  const operation = performInitialization(apiKey, state, flight.controller.signal);",
    "  flight.promise = operation.then((result) => {",
    "    finishInitialization(apiKey, state, flight);",
    "    return result;",
    "  }, (error) => {",
    "    finishInitialization(apiKey, state, flight);",
    "    throw error;",
    "  });",
    "  // 即使所有调用方都在 abort 后离开，也要显式消费异常 flight。",
    "  flight.promise.catch(() => {});",
    "  state.initFlight = flight;",
    "  return flight;",
    "}",
    "",
    "async function waitForInitialization(flight, signal) {",
    "  flight.waiters++;",
    "  let onAbort = null;",
    "  try {",
    "    if (!signal) return await flight.promise;",
    "    const abortPromise = new Promise((resolve, reject) => {",
    "      onAbort = () => reject(initializationAbortError(signal));",
    "      if (signal.aborted) onAbort();",
    "      else signal.addEventListener('abort', onAbort, { once: true });",
    "    });",
    "    const result = await Promise.race([flight.promise, abortPromise]);",
    "    throwIfInitializationAborted(signal);",
    "    return result;",
    "  } finally {",
    "    if (onAbort) signal.removeEventListener('abort', onAbort);",
    "    flight.waiters--;",
    "    if (flight.waiters === 0 && !flight.settled && !flight.controller.signal.aborted) {",
    "      flight.controller.abort();",
    "    }",
    "  }",
    "}",
    "",
    "async function ensureInitialized(apiKey, signal) {",
    "  const state = getOrCreateKeyState(apiKey);",
    "  throwIfInitializationAborted(signal);",
    "  if (Date.now() < state.nextInitAt) return;",
    "",
    "  const flight = state.initFlight || startInitialization(apiKey, state);",
    "  await waitForInitialization(flight, signal);",
    "}",
  ].join("\n");
}

function patchInitializationCallSites(source) {
  const guard = [
    "  " + ABORT_GUARD_MARKER,
    "  let initializationComplete = false;",
    "  const abortInitialization = () => {",
    "    if (initializationComplete || res.writableEnded) return;",
    "    if (!abortController.signal.aborted) abortController.abort();",
    "  };",
    "  req.once('aborted', abortInitialization);",
    "  res.once('close', abortInitialization);",
    "",
  ].join("\n");
  const replacement = guard + INIT_CALL + "\n" +
    "    initializationComplete = true;\n" +
    "    req.off('aborted', abortInitialization);\n" +
    "    res.off('close', abortInitialization);";
  if (count(source, INIT_CALL) !== 2) fail("初始化调用点应恰好出现两处");
  return source.replaceAll(INIT_CALL, replacement);
}

function assertPatched(source) {
  if (count(source, PATCH_MARKER) !== 1) fail("初始化补丁标记不是唯一一处");
  if (count(source, ABORT_GUARD_MARKER) !== 2) fail("初始化 abort guard 标记应有两处");
  for (const [needle, label] of [
    ["const keyStateStore = new Map();", "key state store"],
    ["initFlight: null", "init flight state"],
    ["evictWhenIdle: false", "idle eviction state"],
    ["function evictExpiredKeyState", "expired key cleanup"],
    ["async function performInitialization", "initialization operation"],
    ["async function consumeInitializationResponse", "initialization response drain"],
    ["function startInitialization", "single-flight creator"],
    ["function finishInitialization", "single-flight finalizer"],
    ["async function waitForInitialization", "abort-aware waiter"],
    ["async function ensureInitialized", "ensureInitialized"],
    ["Promise.allSettled([", "strict all-settled requests"],
    ["const timeoutController = new AbortController();", "initialization timeout controller"],
    ["const INIT_RESPONSE_MAX_BYTES = 64 * 1024;", "initialization response bound"],
  ]) {
    if (count(source, needle) !== 1) fail(label + " 不是唯一一处");
  }
  if (count(source, "req.once('aborted', abortInitialization);") !== 2) fail("request abort guard 应有两处");
  if (count(source, "res.once('close', abortInitialization);") !== 2) fail("response abort guard 应有两处");
  if (count(source, "initializationComplete = true;") !== 2) fail("初始化完成清理应有两处");
  if (count(source, "evictExpiredKeyState(key);") !== 1) fail("过期 Key 状态清理调用应有一处");
}

function rejectIncompletePatch(source) {
  if (source.includes("initFlight") || source.includes("startInitialization") || source.includes("abortInitialization") || source.includes("evictExpiredKeyState")) {
    fail("检测到不完整的初始化补丁，拒绝猜测清理范围");
  }
}

function patchExpiredKeyStateCleanup(source) {
  const matches = [...source.matchAll(KEY_STATE_CLEANUP_RE)];
  if (matches.length !== 1) fail("过期 Key 状态清理锚点应恰好出现一次，实际 " + matches.length + " 次");
  const match = matches[0];
  const replacement = `${match[1]}evictExpiredKeyState(key);${match[2]}${match[3]}`;
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

const original = readFileSync(target, "utf8");
const markerCount = count(original, PATCH_MARKER);
if (markerCount > 0) {
  if (markerCount !== 1) fail("初始化补丁标记重复");
  assertPatched(original);
  process.stdout.write("upstream initialization patch already present: " + target + "\n");
  process.exit(0);
}

rejectIncompletePatch(original);
let source = patchExpiredKeyStateCleanup(original);
const sectionStart = findUnique(source, STATE_COMMENT, "每 Key 状态区段");
const sectionEnd = findUnique(source, MODELS_COMMENT, "模型列表区段");
if (sectionEnd <= sectionStart) fail("模型列表区段位置无效");
const ensureStart = source.indexOf("async function ensureInitialized", sectionStart);
if (ensureStart < 0 || ensureStart >= sectionEnd) fail("找不到 ensureInitialized 函数");
const ensureEnd = findMatchingBrace(source, ensureStart);
if (ensureEnd > sectionEnd) fail("ensureInitialized 超出预期区段");

source = source.slice(0, sectionStart) + initializationBlock() + "\n\n" + source.slice(sectionEnd);
source = patchInitializationCallSites(source);
assertPatched(source);

if (source === original) {
  process.stdout.write("upstream initialization patch already present: " + target + "\n");
} else {
  writeFileSync(target, source);
  process.stdout.write("upstream initialization patch applied: " + target + "\n");
}
