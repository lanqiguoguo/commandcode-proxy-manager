import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_UPSTREAM_STARTUP_TIMEOUT_MS = 10_000;
export const DEFAULT_UPSTREAM_SHUTDOWN_TIMEOUT_MS = 5_000;

const DEFAULT_HEALTH_INTERVAL_MS = 100;
const DEFAULT_HEALTH_REQUEST_TIMEOUT_MS = 1_000;
const MAX_DIAGNOSTIC_LINES = 50;
const MAX_DIAGNOSTIC_LINE_CHARS = 4_096;
const MAX_ERROR_LOG_CHARS = 16 * 1024;
const MAX_PENDING_LINE_CHARS = 1024 * 1024;
const MAX_TIMER_MS = 2_147_483_647;
const EXIT_OUTPUT_GRACE_MS = 50;

// Only the runtime values below are inherited. Application-specific values may
// be supplied explicitly through env; the manager's ambient environment is not
// copied wholesale into the vendored process.
const INHERITED_ENV_KEYS = [
  "PATH", "Path", "SystemRoot", "WINDIR",
  "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ",
  "CC_API_BASE", "PROJECT_SLUG", "LOG_FILE", "CC_USE_PROVIDER_MODELS", "CC_MAX_BODY_MB",
];

const BLOCKED_ENV_NAMES = new Set([
  "CC_EMBEDDED_UPSTREAM",
  "CC_INIT_TIMEOUT_MS",
  "CC_ENABLE_VERSION_REFRESH",
  "CC_VERSION_REFRESH_INTERVAL_MS",
  "CC_VERSION_REFRESH_TIMEOUT_MS",
]);

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function boundedInteger(value, fallback, name, { min = 0, max = MAX_TIMER_MS } = {}) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < min || number > max) {
    throw new TypeError(`${name} must be an integer in ${min}..${max}`);
  }
  return number;
}

function validateOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("startUpstream options must be an object");
  }

  const command = options.command;
  if (typeof command !== "string" || command.length === 0) {
    throw new TypeError("startUpstream command must be a non-empty string");
  }

  const args = options.args === undefined ? [] : options.args;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("startUpstream args must be an array of strings");
  }

  if (typeof options.cwd !== "string" || options.cwd.length === 0) {
    throw new TypeError("startUpstream cwd must be the upstream directory");
  }

  // The supervisor is intentionally scoped to the loopback-hosted mode. It
  // never consults a manager config host or silently substitutes one.
  const host = options.host === undefined ? "127.0.0.1" : options.host;
  if (host !== "127.0.0.1") {
    throw new TypeError("startUpstream host must be exactly 127.0.0.1");
  }

  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("startUpstream port must be an integer in 1..65535");
  }

  if (options.env !== undefined && (options.env === null || typeof options.env !== "object" || Array.isArray(options.env))) {
    throw new TypeError("startUpstream env must be an object");
  }

  return {
    command,
    args: args.slice(),
    cwd: options.cwd,
    host,
    port,
    startupTimeoutMs: boundedInteger(
      options.startupTimeoutMs,
      DEFAULT_UPSTREAM_STARTUP_TIMEOUT_MS,
      "startupTimeoutMs",
    ),
    shutdownTimeoutMs: boundedInteger(
      options.shutdownTimeoutMs,
      DEFAULT_UPSTREAM_SHUTDOWN_TIMEOUT_MS,
      "shutdownTimeoutMs",
    ),
    healthIntervalMs: boundedInteger(
      options.healthIntervalMs,
      DEFAULT_HEALTH_INTERVAL_MS,
      "healthIntervalMs",
      { min: 1, max: MAX_TIMER_MS },
    ),
    healthRequestTimeoutMs: boundedInteger(
      options.healthRequestTimeoutMs,
      DEFAULT_HEALTH_REQUEST_TIMEOUT_MS,
      "healthRequestTimeoutMs",
    ),
    env: options.env || {},
    onUnexpectedExit: typeof options.onUnexpectedExit === "function" ? options.onUnexpectedExit : null,
    onOutput: typeof options.onOutput === "function" ? options.onOutput : null,
  };
}

function isBlockedEnvName(name) {
  if (BLOCKED_ENV_NAMES.has(name)) return true;
  if (/^CCPM_/i.test(name)) return true;
  // Keep both the versioned marker form and future patch-style names out of
  // the child without maintaining a second copy of the patch implementation.
  return /^CC_.*PATCH(?:_|$)/i.test(name);
}

function buildChildEnv(overrides, host, port) {
  const childEnv = Object.create(null);
  for (const key of INHERITED_ENV_KEYS) {
    if (own(process.env, key) && !isBlockedEnvName(key)) childEnv[key] = process.env[key];
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (isBlockedEnvName(key)) continue;
    if (value === undefined || value === null) {
      delete childEnv[key];
      continue;
    }
    childEnv[key] = String(value);
  }

  // These are supervisor-owned and cannot be overridden by an arbitrary env
  // object. The caller must pass the loopback host explicitly or use the safe
  // default above; no config host is consulted here.
  childEnv.HOST = host;
  childEnv.PORT = String(port);
  delete childEnv.CC_EMBEDDED_UPSTREAM;
  return childEnv;
}

function describeCommand(command, args) {
  return [command, ...args].map((part) => JSON.stringify(String(part))).join(" ");
}

function errorText(error) {
  if (error && typeof error.message === "string") return error.message;
  return String(error || "unknown error");
}

function safeErrorCode(error) {
  return error && typeof error.code === "string" ? error.code : "ERROR";
}

function copyLines(lines) {
  return lines.slice();
}

function boundedLogText(lines) {
  if (!lines.length) return "<none>";
  const body = lines.join("");
  return body.length > MAX_ERROR_LOG_CHARS ? body.slice(-MAX_ERROR_LOG_CHARS) : body;
}

/**
 * Error raised for an upstream process lifecycle or readiness failure.
 * It carries the command, port, exit status, and bounded recent diagnostics.
 */
export class UpstreamProcessError extends Error {
  constructor(message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = "UpstreamProcessError";
    this.code = "UPSTREAM_PROCESS_ERROR";
    Object.assign(this, details);
  }
}

function rememberLine(lines, line) {
  let value = String(line);
  if (value.length > MAX_DIAGNOSTIC_LINE_CHARS) {
    value = `${value.slice(0, MAX_DIAGNOSTIC_LINE_CHARS)}...[line truncated]\n`;
  }
  lines.push(value);
  if (lines.length > MAX_DIAGNOSTIC_LINES) lines.splice(0, lines.length - MAX_DIAGNOSTIC_LINES);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exitLabel(exitCode, exitSignal, childError, forcedStop) {
  if (exitCode !== null || exitSignal !== null) {
    return `code=${exitCode === null ? "null" : exitCode},signal=${exitSignal || "none"}`;
  }
  if (forcedStop) return "forced-kill-timeout";
  if (childError) return `process-error=${safeErrorCode(childError)}`;
  return "not-exited";
}

/**
 * Start the raw upstream entry as an independent child process.
 *
 * `ready` resolves only after GET /health returns 2xx. `stop()` is idempotent,
 * sends SIGTERM before SIGKILL, and resolves after the child exits (or after a
 * bounded forced-stop fallback). `getStatus()` reports the current lifecycle;
 * no source file or module state from the upstream process is imported.
 */
export function startUpstream(options = {}) {
  const config = validateOptions(options);
  const commandLine = describeCommand(config.command, config.args);
  const childEnv = buildChildEnv(config.env, config.host, config.port);
  const stdoutDiagnostics = [];
  const stderrDiagnostics = [];

  let child = null;
  let phase = "starting";
  let spawnObserved = false;
  let exitObserved = false;
  let closeObserved = false;
  let exitCode = null;
  let exitSignal = null;
  let childError = null;
  let readyFulfilled = false;
  let readySettled = false;
  let readyAt = null;
  let stopRequested = false;
  let stopReason = "stop requested";
  let forcedStop = false;
  let killSent = false;
  let termTimer = null;
  let killTimer = null;
  let exitDrainTimer = null;
  let healthController = null;
  let lastHealthFailure = null;
  let pendingReadyErrorFactory = null;
  let stopFinished = false;
  let unexpectedNotified = false;
  let resolveStop = null;
  let resolveExit = null;
  let readyResolve;
  let readyReject;
  let stopPromise = null;
  let runtime;

  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // A caller may intentionally stop a runtime without ever awaiting ready.
  // Marking the rejection handled internally prevents that valid lifecycle
  // path from becoming an unhandledRejection while preserving the rejection
  // for callers that do await it.
  ready.catch(() => {});

  const exit = new Promise((resolve) => {
    resolveExit = resolve;
  });

  function clearTimer(timer) {
    if (timer) clearTimeout(timer);
    return null;
  }

  function currentPid() {
    return child && Number.isInteger(child.pid) ? child.pid : null;
  }

  function diagnostics() {
    return {
      stdout: copyLines(stdoutDiagnostics),
      stderr: copyLines(stderrDiagnostics),
    };
  }

  function currentExitLabel() {
    return exitLabel(exitCode, exitSignal, childError, forcedStop);
  }

  function buildLifecycleError(reason, cause) {
    const health = lastHealthFailure
      ? `; last health=${lastHealthFailure.text}`
      : "";
    const causePart = cause ? `; cause=${errorText(cause)}` : "";
    const recentStdout = boundedLogText(stdoutDiagnostics);
    const recentStderr = boundedLogText(stderrDiagnostics);
    const message = [
      `${reason}: command=${commandLine}`,
      `port=${config.port}`,
      `exit=${currentExitLabel()}`,
      `recent stdout=${JSON.stringify(recentStdout)}`,
      `recent stderr=${JSON.stringify(recentStderr)}`,
      health,
      causePart,
    ].join(";");
    return new UpstreamProcessError(message, {
      cause,
      command: config.command,
      args: config.args.slice(),
      cwd: config.cwd,
      host: config.host,
      port: config.port,
      pid: currentPid(),
      exitCode,
      signal: exitSignal,
      exitStatus: currentExitLabel(),
      recentLogs: diagnostics(),
      reason,
    });
  }

  function statusSnapshot() {
    const running = Boolean(child && !exitObserved && !forcedStop);
    return {
      phase,
      running,
      ready: readyFulfilled && running && phase === "running",
      everReady: readyFulfilled,
      pid: currentPid(),
      exitCode,
      signal: exitSignal,
      forcedKill: killSent,
      forcedStop,
      stopRequested,
      stopReason,
      command: config.command,
      args: config.args.slice(),
      cwd: config.cwd,
      host: config.host,
      port: config.port,
      lastHealthFailure,
      diagnostics: diagnostics(),
    };
  }

  function settleReady(error) {
    if (readySettled) return;
    readySettled = true;
    if (error) {
      readyReject(error);
      return;
    }
    readyFulfilled = true;
    readyAt = Date.now();
    readyResolve(runtime);
  }

  function safeOutputCallback(stream, text, partial = false) {
    if (!config.onOutput) return;
    try {
      const result = config.onOutput({ stream, text, partial });
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch((error) => {
          try { console.error(`[upstream] output callback failed: ${errorText(error)}`); } catch {}
        });
      }
    } catch (error) {
      try { console.error(`[upstream] output callback failed: ${errorText(error)}`); } catch {}
    }
  }

  function rawWrite(stream, text) {
    try {
      (stream === "stderr" ? process.stderr : process.stdout).write(text);
    } catch {}
  }

  function forwardLine(stream, line) {
    rememberLine(stream === "stderr" ? stderrDiagnostics : stdoutDiagnostics, line);
    safeOutputCallback(stream, line, false);

    // console forwarding keeps the existing parent log capture usable. Remove
    // only the LF separator; a CRLF retains its CR and ordinary LF output is
    // reproduced byte-for-byte by console's single newline.
    const body = line.endsWith("\n") ? line.slice(0, -1) : line;
    try {
      (stream === "stderr" ? console.error : console.log)(body);
    } catch {
      rawWrite(stream, line);
    }
  }

  function forwardPartial(stream, text) {
    rememberLine(stream === "stderr" ? stderrDiagnostics : stdoutDiagnostics, text);
    safeOutputCallback(stream, text, true);
    rawWrite(stream, text);
  }

  function attachLineForwarder(stream, name) {
    if (!stream) return;
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let finished = false;

    const flush = () => {
      if (finished) return;
      finished = true;
      try { pending += decoder.end(); } catch {}
      if (pending) {
        // There is no separator to reproduce at EOF. Write the tail directly
        // so a partial final line remains exactly the child's original text.
        rememberLine(name === "stderr" ? stderrDiagnostics : stdoutDiagnostics, pending);
        safeOutputCallback(name, pending, false);
        rawWrite(name, pending);
      }
      pending = "";
    };

    const push = (text) => {
      if (!text) return;
      pending += text;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        forwardLine(name, line);
      }

      // A malicious or broken child can write an unbounded line without a
      // newline. Preserve its bytes while bounding supervisor memory; the
      // normal line path still handles all complete lines atomically.
      while (pending.length > MAX_PENDING_LINE_CHARS) {
        const prefix = pending.slice(0, MAX_PENDING_LINE_CHARS);
        pending = pending.slice(MAX_PENDING_LINE_CHARS);
        forwardPartial(name, prefix);
      }
    };

    stream.on("data", (chunk) => {
      try {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        push(decoder.write(bytes));
      } catch (error) {
        rememberLine(name === "stderr" ? stderrDiagnostics : stdoutDiagnostics, `[decoder error] ${errorText(error)}\n`);
      }
    });
    stream.once("end", flush);
    stream.once("close", flush);
    stream.once("error", (error) => {
      rememberLine(name === "stderr" ? stderrDiagnostics : stdoutDiagnostics, `[stream error] ${errorText(error)}\n`);
      flush();
    });
  }

  function abortHealthCheck() {
    if (!healthController) return;
    try { healthController.abort(); } catch {}
    healthController = null;
  }

  function settleExit() {
    if (!resolveExit) return;
    const resolver = resolveExit;
    resolveExit = null;
    resolver(statusSnapshot());
  }

  function reportUnexpectedExit() {
    if (unexpectedNotified || stopRequested || !config.onUnexpectedExit) return;
    if (!spawnObserved && childError) return;
    unexpectedNotified = true;
    const error = buildLifecycleError("upstream exited unexpectedly", childError || undefined);
    const info = {
      ...statusSnapshot(),
      unexpected: true,
      error,
      recentLogs: diagnostics(),
      readyAt,
    };
    try {
      const result = config.onUnexpectedExit(info);
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch((callbackError) => {
          try { console.error(`[upstream] unexpected-exit callback failed: ${errorText(callbackError)}`); } catch {}
        });
      }
    } catch (callbackError) {
      try { console.error(`[upstream] unexpected-exit callback failed: ${errorText(callbackError)}`); } catch {}
    }
  }

  function settleNaturalFailure() {
    if (stopRequested) return;
    phase = "failed";
    if (!readySettled) {
      settleReady(buildLifecycleError(
        readyFulfilled ? "upstream exited after becoming ready" : "upstream exited before becoming ready",
        childError || undefined,
      ));
    }
    reportUnexpectedExit();
  }

  function finishStop() {
    if (stopFinished) return;
    stopFinished = true;
    termTimer = clearTimer(termTimer);
    killTimer = clearTimer(killTimer);
    exitDrainTimer = clearTimer(exitDrainTimer);
    phase = "stopped";
    if (!readySettled && !readyFulfilled) {
      const error = pendingReadyErrorFactory
        ? pendingReadyErrorFactory()
        : buildLifecycleError("upstream stopped before becoming ready");
      settleReady(error);
    }
    if (resolveStop) {
      const resolver = resolveStop;
      resolveStop = null;
      resolver(statusSnapshot());
    }
  }

  function observeExit(code, signal) {
    if (exitObserved) return;
    exitObserved = true;
    exitCode = code === undefined ? null : code;
    exitSignal = signal || null;
    abortHealthCheck();

    if (stopRequested) {
      phase = "stopped";
      finishStop();
      settleExit();
    } else {
      phase = "failed";
      if (exitDrainTimer) clearTimeout(exitDrainTimer);
      exitDrainTimer = setTimeout(() => {
        exitDrainTimer = null;
        settleNaturalFailure();
      }, EXIT_OUTPUT_GRACE_MS);
      settleExit();
    }
  }

  function observeClose(code, signal) {
    if (closeObserved) return;
    closeObserved = true;
    if (!exitObserved) observeExit(code, signal);
    if (exitDrainTimer) {
      clearTimeout(exitDrainTimer);
      exitDrainTimer = null;
      if (!stopRequested) settleNaturalFailure();
    }
    if (stopRequested) finishStop();
  }

  function safeKill(signal) {
    if (!child || exitObserved || forcedStop) return false;
    try {
      return child.kill(signal);
    } catch (error) {
      if (error && error.code !== "ESRCH") childError = error;
      return false;
    }
  }

  function forceStopAfterKillWait() {
    if (exitObserved || stopFinished) return;
    killSent = true;
    safeKill("SIGKILL");
    forcedStop = true;
    try { child?.stdout?.destroy(); } catch {}
    try { child?.stderr?.destroy(); } catch {}
    finishStop();
    settleExit();
  }

  function requestStop({ reason = "stop requested", failureFactory = null } = {}) {
    if (stopPromise) return stopPromise;
    stopRequested = true;
    stopReason = reason;
    abortHealthCheck();
    if (!readySettled && !readyFulfilled) {
      pendingReadyErrorFactory = failureFactory || (() => buildLifecycleError("upstream stopped before becoming ready"));
    }

    stopPromise = new Promise((resolve) => {
      resolveStop = resolve;
    });
    stopPromise.catch(() => {});

    if (!child || exitObserved || forcedStop) {
      finishStop();
      if (!exitObserved) settleExit();
      return stopPromise;
    }

    phase = "stopping";
    safeKill("SIGTERM");
    termTimer = setTimeout(() => {
      termTimer = null;
      if (exitObserved || stopFinished) return;
      killSent = true;
      safeKill("SIGKILL");
      const killWaitMs = Math.max(50, Math.min(1_000, config.shutdownTimeoutMs || 1_000));
      killTimer = setTimeout(() => {
        killTimer = null;
        forceStopAfterKillWait();
      }, killWaitMs);
    }, config.shutdownTimeoutMs);
    return stopPromise;
  }

  async function healthRequest(timeoutMs) {
    const controller = new AbortController();
    healthController = controller;
    let timeoutTimer = null;
    let request;
    try {
      const url = `http://${config.host}:${config.port}/health`;
      request = fetch(url, { method: "GET", signal: controller.signal }).then(async (response) => {
        try { await response.body?.cancel(); } catch {}
        return {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          text: `HTTP ${response.status}`,
        };
      });
      // A runtime or test double that ignores AbortController must not hold the
      // readiness loop forever. The detached request still has a rejection
      // handler, so it cannot create an unhandled Promise rejection later.
      request.catch(() => {});
      const timeout = new Promise((resolve) => {
        timeoutTimer = setTimeout(() => resolve({ ok: false, timedOut: true, text: "request timeout" }), timeoutMs);
      });
      return await Promise.race([request, timeout]);
    } catch (error) {
      return { ok: false, text: `${safeErrorCode(error)} ${errorText(error)}` };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (healthController === controller) healthController = null;
      try { controller.abort(); } catch {}
    }
  }

  async function monitorReadiness() {
    const deadline = Date.now() + config.startupTimeoutMs;
    while (!readySettled && !stopRequested && !exitObserved) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const failure = () => buildLifecycleError(
          `upstream /health did not become ready within ${config.startupTimeoutMs}ms`,
        );
        await requestStop({ reason: "startup timeout", failureFactory: failure });
        return;
      }

      const result = await healthRequest(Math.max(1, Math.min(config.healthRequestTimeoutMs, remaining)));
      if (readySettled || stopRequested || exitObserved) return;
      if (result.ok) {
        phase = "running";
        settleReady(null);
        return;
      }
      lastHealthFailure = {
        status: result.status ?? null,
        timedOut: Boolean(result.timedOut),
        text: result.text,
        at: Date.now(),
      };

      const waitMs = Math.min(config.healthIntervalMs, Math.max(0, deadline - Date.now()));
      if (waitMs <= 0) continue;
      await sleep(waitMs);
    }
  }

  runtime = {
    ready,
    exit,
    stop: (options = {}) => {
      const reason = typeof options?.reason === "string" && options.reason.length
        ? options.reason
        : "stop requested";
      return requestStop({ reason });
    },
    getStatus: statusSnapshot,
    getState: statusSnapshot,
    getDiagnostics: diagnostics,
    isRunning: () => Boolean(child && !exitObserved && !forcedStop),
    isReady: () => Boolean(readyFulfilled && child && !exitObserved && phase === "running"),
    get phase() { return phase; },
    get pid() { return currentPid(); },
    get child() { return child; },
    get status() { return statusSnapshot(); },
    get state() { return statusSnapshot(); },
  };

  try {
    child = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: childEnv,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    childError = error;
    phase = "failed";
    settleReady(buildLifecycleError("failed to spawn upstream", error));
    settleExit();
    return runtime;
  }

  attachLineForwarder(child.stdout, "stdout");
  attachLineForwarder(child.stderr, "stderr");
  child.once("spawn", () => { spawnObserved = true; });
  child.on("error", (error) => {
    childError = error;
  });
  child.once("exit", observeExit);
  child.once("close", observeClose);

  // Keep the async monitor attached to an explicit rejection handler. All
  // lifecycle failure paths terminate through requestStop and ready, so there
  // is no floating Promise that can outlive a failed startup silently.
  monitorReadiness().catch((error) => {
    if (readySettled || stopRequested || exitObserved) return;
    void requestStop({
      reason: "upstream readiness check failed",
      failureFactory: () => buildLifecycleError("upstream readiness check failed", error),
    });
  });

  return runtime;
}
