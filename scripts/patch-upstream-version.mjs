import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/patch-upstream-version.mjs <proxy.mjs>");
  process.exit(2);
}

const PATCH_MARKER = "// CCPM_VERSION_PATCH_V1";
const LIFECYCLE_MARKER = "// CCPM_LIFECYCLE_PATCH_V1";
const INITIALIZATION_MARKER = "// CCPM_INITIALIZATION_PATCH_V1";
const VERSION_START = "let CC_VERSION";
const VERSION_END = "const MAX_BODY_SIZE";
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message) {
  throw new Error("upstream version patch failed: " + message);
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

function findUniqueIndex(source, needle, label) {
  const first = source.indexOf(needle);
  const second = first < 0 ? -1 : source.indexOf(needle, first + needle.length);
  if (first < 0 || second >= 0) {
    fail(label + " 应恰好出现一次（first=" + first + ", second=" + second + "）");
  }
  return first;
}

function parseStableSemver(value) {
  if (typeof value !== "string") return null;
  const match = value.match(STABLE_SEMVER);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) return null;
  return { value, major: parts[0], minor: parts[1], patch: parts[2] };
}

function extractFallback(region) {
  const matches = [...region.matchAll(/const\s+CC_VERSION_FALLBACK\s*=\s*(['"])([^'"]+)\1\s*;/g)];
  if (matches.length !== 1) fail("CC_VERSION_FALLBACK 应恰好出现一次");
  const fallback = parseStableSemver(matches[0][2]);
  if (!fallback) fail("CC_VERSION_FALLBACK 必须是稳定 semver x.y.z");
  return fallback.value;
}

function versionBlock(fallback) {
  const literal = JSON.stringify(fallback);
  return [
    PATCH_MARKER,
    "// Keep the protocol version fixed at sync/build time by default.",
    `const CC_VERSION_FALLBACK = ${literal};`,
    "const CC_VERSION_BUILD = CC_VERSION_FALLBACK;",
    "let CC_VERSION = CC_VERSION_BUILD;",
    "const CC_VERSION_REFRESH_MS = 24 * 60 * 60 * 1000; // Fixed 24h refresh boundary",
    "const CC_VERSION_REGISTRY_URL = 'https://registry.npmjs.org/command-code/latest';",
    "const CC_VERSION_REFRESH_TIMEOUT_DEFAULT_MS = 5000;",
    "const CC_VERSION_RESPONSE_MAX_BYTES = 16 * 1024;",
    "const CC_VERSION_MAX_PATCH_AHEAD = 100;",
    "const CC_VERSION_REFRESH_ENABLED = process.env.CC_ENABLE_VERSION_REFRESH === '1';",
    "",
    "function configuredCCVersionRefreshIntervalMs() {",
    "  const value = Number(process.env.CC_VERSION_REFRESH_INTERVAL_MS);",
    "  return Number.isSafeInteger(value) && value >= 50 && value <= CC_VERSION_REFRESH_MS",
    "    ? value",
    "    : CC_VERSION_REFRESH_MS;",
    "}",
    "",
    "const CC_VERSION_REFRESH_INTERVAL_MS = configuredCCVersionRefreshIntervalMs();",
    "",
    "function configuredCCVersionRefreshTimeoutMs() {",
    "  const value = Number(process.env.CC_VERSION_REFRESH_TIMEOUT_MS);",
    "  return Number.isSafeInteger(value) && value >= 50 && value <= 10000",
    "    ? value",
    "    : CC_VERSION_REFRESH_TIMEOUT_DEFAULT_MS;",
    "}",
    "",
    "const CC_VERSION_REFRESH_TIMEOUT_MS = configuredCCVersionRefreshTimeoutMs();",
    "",
    "function parseStableSemver(value) {",
    "  if (typeof value !== 'string') return null;",
    "  const match = value.match(/^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$/);",
    "  if (!match) return null;",
    "  const parts = match.slice(1).map(Number);",
    "  if (!parts.every(Number.isSafeInteger)) return null;",
    "  return { value, major: parts[0], minor: parts[1], patch: parts[2] };",
    "}",
    "",
    "const CC_VERSION_FALLBACK_SEMVER = parseStableSemver(CC_VERSION_FALLBACK);",
    "if (!CC_VERSION_FALLBACK_SEMVER) throw new Error('Invalid fixed CC_VERSION_FALLBACK');",
    "",
    "function isAllowedCCVersion(candidate) {",
    "  const version = parseStableSemver(candidate);",
    "  const current = parseStableSemver(CC_VERSION) || CC_VERSION_FALLBACK_SEMVER;",
    "  return version &&",
    "    version.major === CC_VERSION_FALLBACK_SEMVER.major &&",
    "    version.minor === CC_VERSION_FALLBACK_SEMVER.minor &&",
    "    version.patch >= CC_VERSION_FALLBACK_SEMVER.patch &&",
    "    version.patch >= current.patch &&",
    "    version.patch <= CC_VERSION_FALLBACK_SEMVER.patch + CC_VERSION_MAX_PATCH_AHEAD",
    "    ? version",
    "    : null;",
    "}",
    "",
    "async function readCCVersionResponseBody(response) {",
    "  const contentLength = response.headers.get('content-length');",
    "  if (contentLength !== null) {",
    "    if (!/^(0|[1-9]\\d*)$/.test(contentLength.trim())) {",
    "      throw new Error('registry response content-length is invalid');",
    "    }",
    "    const declaredLength = Number(contentLength);",
    "    if (!Number.isSafeInteger(declaredLength) || declaredLength > CC_VERSION_RESPONSE_MAX_BYTES) {",
    "      throw new Error('registry response is too large');",
    "    }",
    "  }",
    "  if (!response.body) return '';",
    "  const reader = response.body.getReader();",
    "  const chunks = [];",
    "  let totalBytes = 0;",
    "  try {",
    "    while (true) {",
    "      const { done, value } = await reader.read();",
    "      if (done) break;",
    "      if (!value) continue;",
    "      totalBytes += value.byteLength;",
    "      if (totalBytes > CC_VERSION_RESPONSE_MAX_BYTES) {",
    "        try { await reader.cancel(); } catch {}",
    "        throw new Error('registry response is too large');",
    "      }",
    "      chunks.push(Buffer.from(value));",
    "    }",
    "  } finally {",
    "    reader.releaseLock();",
    "  }",
    "  return Buffer.concat(chunks).toString('utf8');",
    "}",
    "",
    "async function refreshCCVersion() {",
    "  const controller = new AbortController();",
    "  const timeout = setTimeout(() => controller.abort(), CC_VERSION_REFRESH_TIMEOUT_MS);",
    "  timeout.unref?.();",
    "  try {",
    "    const response = await fetch(CC_VERSION_REGISTRY_URL, {",
    "      headers: { Accept: 'application/json' },",
    "      signal: controller.signal,",
    "    });",
    "    if (!response.ok) throw new Error('registry responded with HTTP ' + response.status);",
    "    const contentType = response.headers.get('content-type') || '';",
    "    if (contentType && !/json/i.test(contentType)) throw new Error('registry response is not JSON');",
    "    let payload;",
    "    try { payload = JSON.parse(await readCCVersionResponseBody(response)); }",
    "    catch (error) { throw new Error('registry response JSON is invalid: ' + (error?.message || String(error))); }",
    "    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.version !== 'string') {",
    "      throw new Error('registry response must contain a string version');",
    "    }",
    "    const accepted = isAllowedCCVersion(payload.version);",
    "    if (!accepted) throw new Error('registry version is outside the allowed stable range');",
    "    CC_VERSION = accepted.value;",
    "    log('info', 'CC Version refreshed from allowlisted registry', { version: CC_VERSION });",
    "    return true;",
    "  } catch (error) {",
    "    try { controller.abort(); } catch {}",
    "    const message = error instanceof Error ? error.message : String(error);",
    "    log('warn', 'CC Version registry refresh ignored; fixed version retained', { version: CC_VERSION, error: message });",
    "    return false;",
    "  } finally {",
    "    clearTimeout(timeout);",
    "  }",
    "}",
    "",
    "let ccVersionRefreshFlight = null;",
    "function scheduleCCVersionRefresh() {",
    "  if (ccVersionRefreshFlight) return ccVersionRefreshFlight;",
    "  ccVersionRefreshFlight = refreshCCVersion()",
    "    .catch((error) => {",
    "      log('warn', 'CC Version refresh task failed; fixed version retained', { version: CC_VERSION, error: error?.message || String(error) });",
    "      return false;",
    "    })",
    "    .finally(() => { ccVersionRefreshFlight = null; });",
    "  ccVersionRefreshFlight.catch(() => {});",
    "  return ccVersionRefreshFlight;",
    "}",
    "",
    "// Registry access is opt-in. A failed attempt leaves the fixed version untouched;",
    "// the next 24h boundary retries when refresh is enabled.",
    "const ccVersionRefreshTimer = setInterval(() => {",
    "  if (CC_VERSION_REFRESH_ENABLED) void scheduleCCVersionRefresh();",
    "}, CC_VERSION_REFRESH_INTERVAL_MS);",
    "ccVersionRefreshTimer.unref?.();",
    "if (CC_VERSION_REFRESH_ENABLED) void scheduleCCVersionRefresh();",
    "",
    "// Request body size limit.",
    "",
  ].join("\n");
}

function assertPatched(source) {
  if (count(source, PATCH_MARKER) !== 1) fail("version patch marker is not unique");
  if (count(source, LIFECYCLE_MARKER) !== 1) fail("lifecycle patch must remain present");
  if (count(source, INITIALIZATION_MARKER) !== 1) fail("initialization patch must remain present");
  for (const [needle, label] of [
    ["const CC_VERSION_FALLBACK =", "fixed fallback"],
    ["const CC_VERSION_BUILD = CC_VERSION_FALLBACK;", "build version"],
    ["const CC_VERSION_REGISTRY_URL = 'https://registry.npmjs.org/command-code/latest';", "allowlisted registry URL"],
    ["const CC_VERSION_REFRESH_ENABLED = process.env.CC_ENABLE_VERSION_REFRESH === '1';", "opt-in switch"],
    ["const CC_VERSION_REFRESH_TIMEOUT_DEFAULT_MS = 5000;", "refresh timeout default"],
    ["function configuredCCVersionRefreshTimeoutMs", "refresh timeout configuration"],
    ["function parseStableSemver", "strict semver parser"],
    ["function readCCVersionResponseBody", "bounded response reader"],
    ["async function refreshCCVersion", "refresh function"],
    ["function scheduleCCVersionRefresh", "refresh single-flight"],
    ["const ccVersionRefreshTimer = setInterval", "refresh timer"],
    ["ccVersionRefreshTimer.unref?.();", "refresh timer unref"],
    ["const CC_VERSION_MAX_PATCH_AHEAD = 100;", "version range bound"],
  ]) {
    if (count(source, needle) !== 1) fail(label + " is not unique");
  }
  if (count(source, "void scheduleCCVersionRefresh();") !== 2) fail("refresh scheduling calls are incomplete");
  if (source.includes("refreshCCVersion(); // 启动时立即拉取")) fail("unconditional startup refresh remains");
  if (source.includes("pkg.version && typeof pkg.version === 'string'")) fail("unvalidated version assignment remains");
}

function rejectIncompletePatch(source) {
  for (const needle of [
    "CC_VERSION_BUILD",
    "CC_VERSION_REGISTRY_URL",
    "CC_VERSION_REFRESH_ENABLED",
    "function parseStableSemver",
    "function scheduleCCVersionRefresh",
  ]) {
    if (source.includes(needle)) fail("detected incomplete version patch; refusing to guess cleanup range");
  }
}

const original = readFileSync(target, "utf8");
const markerCount = count(original, PATCH_MARKER);
if (markerCount > 0) {
  if (markerCount !== 1) fail("version patch marker is duplicated");
  assertPatched(original);
  process.stdout.write("upstream version patch already present: " + target + "\n");
  process.exit(0);
}

rejectIncompletePatch(original);
if (!original.includes(LIFECYCLE_MARKER)) fail("lifecycle patch is required before version patch");
if (!original.includes(INITIALIZATION_MARKER)) fail("initialization patch is required before version patch");

const versionStart = findUniqueIndex(original, VERSION_START, "CC_VERSION section start");
const versionEnd = findUniqueIndex(original, VERSION_END, "CC_VERSION section end");
if (versionEnd <= versionStart) fail("CC_VERSION section order is invalid");
const region = original.slice(versionStart, versionEnd);
const fallback = extractFallback(region);
for (const [needle, label] of [
  ["async function refreshCCVersion", "refresh function"],
  ["registry.npmjs.org/command-code/latest", "registry URL"],
  ["ccVersionRefreshTimer", "refresh timer"],
]) {
  if (count(region, needle) < 1) fail("missing clean upstream " + label);
}

const source = original.slice(0, versionStart) + versionBlock(fallback) + original.slice(versionEnd);
assertPatched(source);
if (source !== original) {
  writeFileSync(target, source);
  process.stdout.write("upstream version patch applied: " + target + "\n");
} else {
  process.stdout.write("upstream version patch already present: " + target + "\n");
}
