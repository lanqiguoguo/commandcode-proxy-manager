import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/patch-upstream-lifecycle.mjs <proxy.mjs>");
  process.exit(2);
}

const PATCH_MARKER = "// CCPM_LIFECYCLE_PATCH_V1";
const GUARD_MARKER = "// CCPM_LIFECYCLE_GUARD_V1";
const SHARED_IMPORT = 'import { createServerLifecycle } from "../src/serverLifecycle.mjs";';

function fail(message) {
  throw new Error("upstream lifecycle patch failed: " + message);
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

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function findMatchingParen(source, callStart) {
  const open = source.indexOf("(", callStart);
  if (open < 0) fail("找不到调用的左括号");
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
    if (c === "(") depth++;
    if (c === ")") {
      depth--;
      if (depth === 0) {
        let end = i + 1;
        if (source[end] === ";") end++;
        return end;
      }
    }
  }
  fail("调用缺少匹配的右括号");
}

function findUnique(source, regex, label) {
  const matches = [...source.matchAll(regex)];
  if (matches.length !== 1) fail(label + " 应恰好出现一次，实际 " + matches.length + " 次");
  return matches[0];
}

function removeUnrefLines(source, name) {
  const line = new RegExp(
    "^[\\t ]*" + escapeRegExp(name) + "\\.unref(?:\\?\\.)?\\(\\);[\\t ]*(?://[^\\r\\n]*)?(?:\\r?\\n|$)",
    "gm"
  );
  return source.replace(line, "");
}

function normalizeUnref(source, callStart, name) {
  source = removeUnrefLines(source, name);
  const callEnd = findMatchingParen(source, callStart);
  return source.slice(0, callEnd) + "\n" + name + ".unref?.();" + source.slice(callEnd);
}

function patchInterval(source, { name, expression, searchStart = 0, searchEnd = source.length, label }) {
  const segment = source.slice(searchStart, searchEnd);
  const declarationRe = new RegExp("const\\s+" + escapeRegExp(name) + "\\s*=\\s*setInterval\\s*\\(", "g");
  const declarations = [...segment.matchAll(declarationRe)];
  if (declarations.length > 1) fail(label + " 声明重复，拒绝猜测删除范围");

  if (declarations.length === 1) {
    const callStart = searchStart + declarations[0].index + declarations[0][0].indexOf("setInterval");
    return normalizeUnref(source, callStart, name);
  }

  const matches = [...segment.matchAll(expression)];
  if (matches.length !== 1) fail(label + " 锚点应恰好出现一次，实际 " + matches.length + " 次");
  const callStart = searchStart + matches[0].index;
  const callEnd = findMatchingParen(source, callStart);
  const callText = source.slice(callStart, callEnd);
  source = source.slice(0, callStart) + "const " + name + " = " + callText + source.slice(callEnd);
  return normalizeUnref(source, callStart + "const ".length + name.length + 3, name);
}

function patchTimers(source) {
  source = patchInterval(source, {
    name: "ccVersionRefreshTimer",
    expression: /setInterval\s*\(\s*refreshCCVersion\s*,\s*CC_VERSION_REFRESH_MS\s*\)/g,
    label: "CC version refresh timer",
  });

  const cleanupStart = source.indexOf("// 定期清理过期 session");
  const cleanupEnd = source.indexOf("function getSessionId", cleanupStart);
  if (cleanupStart < 0 || cleanupEnd < 0) fail("找不到 session cleanup 区段");
  return patchInterval(source, {
    name: "sessionCleanupTimer",
    expression: /setInterval\s*\(\s*\(\)\s*=>\s*\{/g,
    searchStart: cleanupStart,
    searchEnd: cleanupEnd,
    label: "session cleanup timer",
  });
}

function addSharedImport(source) {
  if (source.includes(SHARED_IMPORT)) fail("共享生命周期 import 已存在但补丁标记缺失");
  const lines = source.split("\n");
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) if (/^import\s/.test(lines[i])) lastImport = i;
  if (lastImport < 0) fail("找不到 import 区段");
  lines.splice(lastImport + 1, 0, SHARED_IMPORT);
  return lines.join("\n");
}

function addRequestGuard(source) {
  if (source.includes(GUARD_MARKER)) fail("shutdown request guard 标记已存在但补丁标记缺失");
  const serverMatch = findUnique(
    source,
    /const server\s*=\s*http\.createServer\s*\(\s*async\s*\(\s*req\s*,\s*res\s*\)\s*=>\s*\{/g,
    "async HTTP server 声明"
  );
  const guard = "\n  " + GUARD_MARKER + "\n" +
    "  if (upstreamLifecycle.isClosing()) {\n" +
    "    res.setHeader('Connection', 'close');\n" +
    "    sendJSON(res, 503, { error: { message: 'Server is shutting down', type: 'server_shutdown' } });\n" +
    "    return;\n" +
    "  }\n";
  return source.slice(0, serverMatch.index + serverMatch[0].length) + guard + source.slice(serverMatch.index + serverMatch[0].length);
}

function assertPatched(source) {
  if (count(source, PATCH_MARKER) !== 1) fail("生命周期标记不是唯一一处");
  if (count(source, GUARD_MARKER) !== 1) fail("shutdown request guard 标记不是唯一一处");
  if (count(source, SHARED_IMPORT) !== 1) fail("共享生命周期 import 不是唯一一处");
  if (count(source, "const upstreamLifecycle = createServerLifecycle(server") !== 1) fail("upstreamLifecycle 声明不是唯一一处");
  if (count(source, "export async function shutdownUpstream()") !== 1) fail("shutdownUpstream 声明不是唯一一处");
  if (count(source, "export const ready = upstreamLifecycle.listen(") !== 1) fail("ready listen 声明不是唯一一处");
  if (count(source, "ready.catch(() => clearBackgroundTimers());") !== 1) fail("ready rejection cleanup 不是唯一一处");
  if (count(source, "await ready;") !== 1) fail("await ready 不是唯一一处");
  if (count(source, "let standaloneShutdown = null;") !== 1) fail("standalone shutdown 状态不是唯一一处");
  if (count(source, "const ccVersionRefreshTimer = setInterval") !== 1) fail("CC refresh timer 声明不是唯一一处");
  if (count(source, "ccVersionRefreshTimer.unref?.();") !== 1) fail("CC refresh timer unref 不是唯一一处");
  if (count(source, "const sessionCleanupTimer = setInterval") !== 1) fail("session cleanup timer 声明不是唯一一处");
  if (count(source, "sessionCleanupTimer.unref?.();") !== 1) fail("session cleanup timer unref 不是唯一一处");
  if (/\bcreateProxyLifecycle\s*\(/.test(source)) fail("仍残留旧 inline lifecycle 实现");
  if (/server\.listen\s*\(\s*CFG\.port\s*,\s*CFG\.host\s*,/.test(source)) fail("仍残留未受控制的 server.listen 调用");
  if (count(source, "upstreamLifecycle.isClosing()") !== 1) fail("shutdown request guard 不是唯一一处");
}

function rejectIncompletePatch(source) {
  if (/\bcreateProxyLifecycle\s*\(/.test(source)) fail("检测到旧 inline lifecycle patch，拒绝叠加新补丁");
  if (source.includes(SHARED_IMPORT) || source.includes("upstreamLifecycle") || source.includes("shutdownUpstream")) {
    fail("检测到不完整的生命周期 patch，拒绝猜测清理范围");
  }
}

const original = readFileSync(target, "utf8");
const markerCount = count(original, PATCH_MARKER);
if (markerCount > 0) {
  if (markerCount !== 1) fail("生命周期标记重复，拒绝写入");
  assertPatched(original);
  process.stdout.write("upstream lifecycle patch already present: " + target + "\n");
  process.exit(0);
}

rejectIncompletePatch(original);
let source = patchTimers(original);
source = addSharedImport(source);
source = addRequestGuard(source);

const listenMatch = findUnique(
  source,
  /server\.listen\s*\(\s*CFG\.port\s*,\s*CFG\.host\s*,/g,
  "server.listen(CFG.port, CFG.host)"
);
const lifecycleBlock = [
  PATCH_MARKER,
  'const upstreamLifecycle = createServerLifecycle(server, { label: "embedded upstream" });',
  "",
  "function clearBackgroundTimers() {",
  "  clearInterval(ccVersionRefreshTimer);",
  "  clearInterval(sessionCleanupTimer);",
  "}",
  "",
  "export async function shutdownUpstream() {",
  "  clearBackgroundTimers();",
  "  return upstreamLifecycle.close();",
  "}",
  "",
].join("\n");
source = source.slice(0, listenMatch.index) + lifecycleBlock + source.slice(listenMatch.index);
const patchedListenIndex = listenMatch.index + lifecycleBlock.length;
source = source.slice(0, patchedListenIndex) + "export const ready = upstreamLifecycle.listen" + source.slice(patchedListenIndex + "server.listen".length);

const readyStart = source.indexOf("export const ready = upstreamLifecycle.listen");
const readyEnd = findMatchingParen(source, readyStart);
const tail = [
  "ready.catch(() => clearBackgroundTimers());",
  "await ready;",
  "",
  "if (process.env.CC_EMBEDDED_UPSTREAM !== '1') {",
  "  let standaloneShutdown = null;",
  "  for (const sig of ['SIGTERM', 'SIGINT']) {",
  "    process.on(sig, () => {",
  "      if (standaloneShutdown) return;",
  "      standaloneShutdown = shutdownUpstream()",
  "        .then(() => process.exit(0))",
  "        .catch((error) => {",
  "          console.error('[embedded upstream] shutdown failed: ' + error.message);",
  "          process.exit(1);",
  "        });",
  "    });",
  "  }",
  "}",
  "",
].join("\n");
source = source.slice(0, readyEnd) + "\n" + tail + source.slice(readyEnd);
assertPatched(source);

if (original === source) {
  process.stdout.write("upstream lifecycle patch already present: " + target + "\n");
} else {
  writeFileSync(target, source);
  process.stdout.write("upstream lifecycle patch applied: " + target + "\n");
}
