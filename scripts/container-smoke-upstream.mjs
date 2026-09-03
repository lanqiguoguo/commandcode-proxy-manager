// Local-only upstream fixture for scripts/container-smoke.sh. It deliberately
// implements the public paths needed by the manager without contacting a
// production API.
import http from "node:http";

const port = Number(process.env.SMOKE_UPSTREAM_PORT || 0);
const host = process.env.SMOKE_UPSTREAM_HOST || "0.0.0.0";
const expectedKey = "user_smoke_key";

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function authorized(req) {
  return req.headers.authorization === "Bearer " + expectedKey;
}

function quotaResponse(pathname) {
  if (pathname === "/alpha/whoami") {
    return { success: true, data: { org: { id: "smoke-org" } } };
  }
  if (pathname === "/alpha/billing/credits") {
    return {
      credits: { monthlyCredits: 10, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: {
        fiveHour: { cap: 100, used: 1, resetAt: Date.now() + 3600000 },
        weekly: { cap: 100, used: 1, resetAt: Date.now() + 2 * 86400000 }
      }
    };
  }
  if (pathname === "/alpha/billing/subscriptions") {
    return {
      success: true,
      data: {
        currentPeriodStart: "2026-09-01T00:00:00.000Z",
        currentPeriodEnd: "2026-10-01T00:00:00.000Z",
        planId: "smoke-plan"
      }
    };
  }
  return {
    totalCount: 1,
    completedCount: 1,
    failedCount: 0,
    successRate: 100,
    totalTokensIn: 2,
    totalTokensOut: 3,
    totalTokens: 5,
    totalCost: 0
  };
}

const server = http.createServer(async (req, res) => {
  res.on("error", () => {});
  const pathname = new URL(req.url || "/", "http://smoke.local").pathname;
  let body = "";
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { error: { message: "fixture request read failed", type: "invalid_request_error" } });
    return;
  }

  if (pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  if (pathname === "/v1/models" && req.method === "GET") {
    if (!authorized(req)) {
      json(res, 401, { error: { message: "fixture key required", type: "authentication_error" } });
      return;
    }
    json(res, 200, {
      object: "list",
      data: [{ id: "smoke-model", object: "model", owned_by: "local-fixture" }]
    });
    return;
  }

  if (pathname === "/v1/chat/completions" && req.method === "POST") {
    if (!authorized(req)) {
      json(res, 401, { error: { message: "fixture key required", type: "authentication_error" } });
      return;
    }
    let request;
    try { request = JSON.parse(body); } catch { request = null; }
    if (!request || typeof request.model !== "string" || !Array.isArray(request.messages)) {
      json(res, 400, { error: { message: "invalid chat request", type: "invalid_request_error" } });
      return;
    }
    json(res, 200, {
      id: "chatcmpl-smoke",
      object: "chat.completion",
      model: request.model,
      choices: [{ index: 0, message: { role: "assistant", content: "local chat ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
    });
    return;
  }

  if (pathname === "/v1/messages" && req.method === "POST") {
    if (!authorized(req)) {
      json(res, 401, { error: { message: "fixture key required", type: "authentication_error" } });
      return;
    }
    let request;
    try { request = JSON.parse(body); } catch { request = null; }
    if (!request || typeof request.model !== "string" || !Array.isArray(request.messages)) {
      json(res, 400, { error: { message: "invalid messages request", type: "invalid_request_error" } });
      return;
    }
    json(res, 200, {
      id: "msg_smoke",
      type: "message",
      role: "assistant",
      model: request.model,
      content: [{ type: "text", text: "local messages ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2 }
    });
    return;
  }

  if (pathname === "/alpha/whoami" || pathname.startsWith("/alpha/billing/") || pathname.startsWith("/alpha/usage")) {
    if (!authorized(req)) {
      json(res, 401, { error: { message: "fixture key required", type: "authentication_error" } });
      return;
    }
    json(res, 200, quotaResponse(pathname));
    return;
  }

  json(res, 404, { error: { message: "fixture path not found", type: "not_found" } });
});

server.on("error", (error) => {
  console.error("smoke upstream failed:", error.message);
  process.exitCode = 1;
});

function close() {
  server.close(() => process.exit(0));
}
process.once("SIGTERM", close);
process.once("SIGINT", close);

server.listen(port, host, () => {
  const address = server.address();
  console.log("SMOKE_UPSTREAM_PORT=" + (typeof address === "object" && address ? address.port : port));
});
