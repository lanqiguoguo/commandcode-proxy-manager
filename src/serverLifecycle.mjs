const MIN_DELAY_MS = 100;
const MAX_DELAY_MS = 120000;

export const DEFAULT_GRACE_MS = 10000;
export const DEFAULT_FORCE_WAIT_MS = 1000;

function boundedMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= MIN_DELAY_MS && n <= MAX_DELAY_MS
    ? Math.floor(n)
    : fallback;
}

export function shutdownGraceMs(value = process.env.CC_SHUTDOWN_GRACE_MS) {
  return boundedMs(value, DEFAULT_GRACE_MS);
}

export function shutdownForceWaitMs(value = process.env.CC_SHUTDOWN_FORCE_WAIT_MS) {
  return boundedMs(value, DEFAULT_FORCE_WAIT_MS);
}

function listenAddress(args) {
  const first = args[0];
  if (first && typeof first === "object") {
    return `${first.host || "*"}:${first.port ?? "?"}`;
  }
  if (typeof first === "string" && args.length === 1) return first;
  return `${typeof args[1] === "string" ? args[1] : "*"}:${first ?? "?"}`;
}

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// Both listeners use this controller. Closing the server stops new
// connections, then active responses get a finite grace period before the
// remaining requests and sockets are destroyed.
export function createServerLifecycle(server, {
  label = "server",
  graceMs = shutdownGraceMs(),
  forceWaitMs = shutdownForceWaitMs(),
} = {}) {
  if (!server || typeof server.listen !== "function" || typeof server.close !== "function") {
    throw new TypeError("createServerLifecycle requires an HTTP server");
  }

  let phase = "idle";
  let listening = Boolean(server.listening);
  let serverClosed = !server.listening;
  let listenPromise = null;
  let pendingListen = null;
  let closePromise = null;

  const activeRequests = new Set();
  const activeSockets = new Set();
  const drainWaiters = new Set();

  const logError = (message, error) => {
    const e = asError(error);
    console.error(`[${label}] ${message}: ${e.code || "ERROR"} ${e.message}`);
  };

  const notifyDrained = () => {
    if (activeRequests.size || activeSockets.size || !serverClosed) return;
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  };

  const trackSocket = (socket) => {
    activeSockets.add(socket);
    socket.once("close", () => {
      activeSockets.delete(socket);
      notifyDrained();
    });
    // An unhandled socket error is process-fatal in Node.
    socket.on("error", () => {});
  };

  server.on("connection", trackSocket);
  server.on("request", (req, res) => {
    const entry = { req, res };
    activeRequests.add(entry);
    const done = () => {
      if (activeRequests.delete(entry)) notifyDrained();
    };
    res.once("finish", done);
    res.once("close", done);
    req.on("error", () => {});
    res.on("error", () => {});
  });

  // Install this before any call to server.listen(). It both settles startup
  // failures and prevents a later server error from becoming unhandled.
  server.on("error", (error) => {
    const e = asError(error);
    if (phase === "starting" && pendingListen) {
      logError(`listen failed on ${pendingListen.address}`, e);
      pendingListen.reject(e);
      return;
    }
    logError("server error", e);
  });

  const listen = (...args) => {
    if (listenPromise) return listenPromise;
    if (phase !== "idle") return Promise.reject(new Error(`${label} cannot listen in phase ${phase}`));

    phase = "starting";
    const last = args.length - 1;
    const callback = typeof args[last] === "function" ? args[last] : null;
    const listenArgs = callback ? args.slice(0, -1) : args;
    const address = listenAddress(listenArgs);

    listenPromise = new Promise((resolve, reject) => {
      const pending = {
        address,
        settled: false,
        resolve,
        reject: (error) => {
          if (pending.settled) return;
          pending.settled = true;
          pendingListen = null;
          server.removeListener("listening", onListening);
          listening = false;
          serverClosed = !server.listening;
          phase = "failed";
          reject(asError(error));
        },
      };
      const onListening = () => {
        if (pending.settled || pendingListen !== pending) return;
        pending.settled = true;
        pendingListen = null;
        listening = true;
        serverClosed = false;
        phase = "listening";
        try { callback?.(); } catch (error) { logError("listening callback failed", error); }
        resolve();
      };

      pending.onListening = onListening;
      pendingListen = pending;
      server.once("listening", onListening);
      try {
        server.listen(...listenArgs);
      } catch (error) {
        logError(`listen failed on ${address}`, error);
        pending.reject(error);
      }
    });
    return listenPromise;
  };

  const waitForDrain = () => {
    if (!activeRequests.size && !activeSockets.size && serverClosed) return Promise.resolve();
    return new Promise((resolve) => drainWaiters.add(resolve));
  };

  const closeServer = () => new Promise((resolve) => {
    if (!server.listening) {
      listening = false;
      serverClosed = true;
      notifyDrained();
      resolve();
      return;
    }
    try {
      server.close((error) => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") logError("close failed", error);
        listening = false;
        serverClosed = true;
        notifyDrained();
        resolve();
      });
    } catch (error) {
      if (error.code !== "ERR_SERVER_NOT_RUNNING") logError("close failed", error);
      listening = false;
      serverClosed = true;
      notifyDrained();
      resolve();
    }
  });

  const destroyActive = () => {
    for (const { req, res } of activeRequests) {
      try { req.destroy(); } catch {}
      try { res.destroy(); } catch {}
    }
    for (const socket of activeSockets) {
      try { socket.destroy(); } catch {}
    }
  };

  const close = ({ graceMs: requestedGraceMs, forceWaitMs: requestedForceWaitMs } = {}) => {
    if (closePromise) return closePromise;

    phase = "closing";
    const gracefulMs = boundedMs(requestedGraceMs, boundedMs(graceMs, DEFAULT_GRACE_MS));
    const forcedWaitMs = boundedMs(requestedForceWaitMs, boundedMs(forceWaitMs, DEFAULT_FORCE_WAIT_MS));

    closePromise = (async () => {
      // server.close() is the first shutdown action: no new connections are
      // accepted while existing work drains. Node also closes idle keep-alive
      // sockets here; closeIdleConnections covers older/alternate runtimes.
      const serverClosePromise = closeServer();
      try { server.closeIdleConnections?.(); } catch {}

      const graceful = Promise.all([serverClosePromise, waitForDrain()]);
      const completedGracefully = await Promise.race([
        graceful.then(() => true),
        delay(gracefulMs).then(() => false),
      ]);

      if (!completedGracefully) {
        destroyActive();
        try { server.closeAllConnections?.(); } catch {}
        await Promise.race([graceful, delay(forcedWaitMs)]);
        destroyActive();
        try { server.closeAllConnections?.(); } catch {}
      }

      phase = "closed";
      notifyDrained();
      return {
        forced: !completedGracefully,
        activeRequests: activeRequests.size,
        activeSockets: activeSockets.size,
      };
    })();
    return closePromise;
  };

  return {
    listen,
    close,
    isClosing: () => phase === "closing" || phase === "closed",
    isListening: () => listening,
    activeCounts: () => ({ requests: activeRequests.size, sockets: activeSockets.size }),
  };
}
