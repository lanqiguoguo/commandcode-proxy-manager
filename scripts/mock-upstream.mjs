// ── 测试用 mock 上游：按 Authorization 头区分 Key，支持 per-key 脚本化响应。
// 行为通道：
//   1) 请求 body 的 testMode 字段（经网关原样转发的 body 传递）
//   2) POST /__control {auth, responses:[{mode,...}]} 设置该 Key 的响应队列（优先）
// 模式 mode：ok | sse | slowsse | rate_limit(retryAfter秒) | zeroout | auth | server5xx | hang | bodyhang | delay(delayMs)
//          | empty | malformed | truncated | missingstructure | empty_sse | malformed_sse | missingdone | unterminateddone | split_sse
//          | cutstream（200 SSE 写数帧后 destroy，模拟上游流中途断连）| cutbody（200 JSON 写半身后 destroy）
//          | badusage（200 JSON，usage 字段为字符串/对象/null 恶意值，P1-6 净化验证）
// 初始化控制：POST /__control {auth, init:{fingerprint:[spec], lifecycle:[spec]}}
// 管理端点：GET /__calls 调用记录；GET /__init-calls 初始化调用记录；GET /__slow slowsse 断流观测；POST /__reset 清空
import http from "http";
import { setTimeout as sleep } from "timers/promises";
import { performance } from "node:perf_hooks";

const PORT = Number(process.env.MOCK_PORT || 3051);
const HOST = process.env.MOCK_HOST || "127.0.0.1";
const scripts = new Map(); // authKey → [spec...]
const initScripts = new Map(); // authKey → { fingerprint: [spec...], lifecycle: [spec...] }
const calls = [];
const initCalls = [];
const slowLog = [];
// 额度探测时间线（串行/间隔断言用）
const quotaLog = [];
let quotaActive = 0;
let quotaMaxActive = 0;
const quotaLatency = Number(process.env.MOCK_QUOTA_LATENCY || 120);
let initActive = 0;
let initMaxActive = 0;

function json(res, status, data, headers) {
  res.writeHead(status, Object.assign({ "Content-Type": "application/json" }, headers || {}));
  res.end(JSON.stringify(data));
}

function observeClientAbort(req, res, entry) {
  let settled = false;
  let resolveDisconnected;
  const disconnected = new Promise((resolve) => { resolveDisconnected = resolve; });
  const finish = () => {
    if (settled) return;
    settled = true;
    if (!res.writableEnded) entry.aborted = true;
    resolveDisconnected();
  };
  const onRequestAborted = () => finish();
  const onRequestError = () => finish();
  const onResponseClose = () => {
    if (!res.writableEnded) finish();
  };
  req.once("aborted", onRequestAborted);
  req.once("error", onRequestError);
  res.once("close", onResponseClose);
  if (req.destroyed || res.destroyed) finish();
  return {
    disconnected,
    cleanup() {
      req.off("aborted", onRequestAborted);
      req.off("error", onRequestError);
      res.off("close", onResponseClose);
    },
  };
}

const server = http.createServer((req, res) => {
  res.on("error", () => {}); // 客户端（网关）abort 后写响应以异步 error 失败，静默
  req.on("error", () => {});
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const p = req.url.split("?")[0];
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (p === "/health") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("OK"); return; }
    if (p === "/__control") {
      let j = {};
      try { j = JSON.parse(body || "{}"); } catch {}
      scripts.set(j.auth, Array.isArray(j.responses) ? j.responses : []);
      if (j.init && typeof j.init === "object" && !Array.isArray(j.init)) {
        initScripts.set(j.auth, {
          fingerprint: Array.isArray(j.init.fingerprint) ? [...j.init.fingerprint] : [],
          lifecycle: Array.isArray(j.init.lifecycle) ? [...j.init.lifecycle] : [],
        });
      }
      json(res, 200, { ok: true }); return;
    }
    if (p === "/__calls") { json(res, 200, { calls }); return; }
    if (p === "/__init-calls") { json(res, 200, { calls: initCalls, maxActive: initMaxActive }); return; }
    if (p === "/__quota") { json(res, 200, { quotaLog, maxActive: quotaMaxActive }); return; }
    if (p === "/__slow") { json(res, 200, { slowLog }); return; }
    if (p === "/__reset") {
      scripts.clear();
      initScripts.clear();
      calls.length = 0;
      initCalls.length = 0;
      slowLog.length = 0;
      quotaLog.length = 0;
      quotaMaxActive = quotaActive;
      initMaxActive = 0;
      json(res, 200, { ok: true }); return;
    }

    let parsed = {};
    try { parsed = JSON.parse(body || "{}"); } catch {}
    // ── 额度探测端点（quota.mjs 经 CC_QUOTA_BASE 指向本 mock；记录时间线用于
    //    串行/间隔断言，但不进 /__calls 计数，避免干扰 chat 路径断言）。
    //    resetAt 故意用 epoch 毫秒——与真实 API 一致，回归 parseWindow 数字形态。
    if (p === "/alpha/whoami" || p.startsWith("/alpha/billing") || p.startsWith("/alpha/usage")) {
      // quotaLog 只用于区间/耗时断言，必须使用单调时钟；API 返回的 resetAt
      // 仍使用 Date.now()，保持真实 wall-clock 时间语义。
      const now = performance.now();
      // 持有自身条目引用：/__reset 清空数组不影响在途探测的回填（防 undefined 崩溃）
      const e = { p, auth, start: now, active: ++quotaActive };
      quotaLog.push(e);
      if (quotaActive > quotaMaxActive) quotaMaxActive = quotaActive;
      await sleep(quotaLatency); // 轻微延迟，让并发/串行可测
      e.end = performance.now(); e.active = --quotaActive;
      if (p === "/alpha/whoami") return json(res, 200, { success: true, data: { org: { id: "o_test" } } });
      if (p === "/alpha/billing/credits") return json(res, 200, {
        credits: { monthlyCredits: 10, purchasedCredits: 0, freeCredits: 0 },
        windowLimits: {
          fiveHour: { cap: 14, used: 1, resetAt: Date.now() + 3600e3 },
          weekly: { cap: 35, used: 5, resetAt: Date.now() + 2 * 864e5 }
        }
      });
      if (p === "/alpha/billing/subscriptions") return json(res, 200, { success: true, data: { currentPeriodStart: "2026-08-25T23:33:28.000Z", currentPeriodEnd: "2026-09-25T23:33:28.000Z", planId: "individual-goat" } });
      return json(res, 200, { totalCount: 42, completedCount: 42, failedCount: 0, successRate: 100, totalTokensIn: 1000, totalTokensOut: 234, totalTokens: 1234, totalCost: 5.5 });
    }
    if (p === "/alpha/fingerprint/record" || p === "/alpha/lifecycle-events") {
      const endpoint = p === "/alpha/fingerprint/record" ? "fingerprint" : "lifecycle";
      const configured = initScripts.get(auth);
      const queue = configured?.[endpoint];
      const spec = queue && queue.length ? queue.shift() : { mode: "ok" };
      const entry = { t: Date.now(), auth, path: p, endpoint, mode: spec.mode, aborted: false };
      initCalls.push(entry);
      initActive++;
      if (initActive > initMaxActive) initMaxActive = initActive;
      const abortWatcher = observeClientAbort(req, res, entry);
      try {
        if (spec.mode === "hang") {
          await abortWatcher.disconnected;
          return;
        }
        if (spec.mode === "bodyhang") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.write(JSON.stringify({ ok: true, endpoint }));
          await abortWatcher.disconnected;
          return;
        }
        if (spec.mode === "drop") {
          req.socket.destroy();
          await abortWatcher.disconnected;
          return;
        }
        if (spec.mode === "delay") {
          await Promise.race([sleep(spec.delayMs || 180), abortWatcher.disconnected]);
          if (entry.aborted) return;
        }
        if (spec.mode === "status" || spec.mode === "server5xx") {
          json(res, spec.status || 503, { error: { message: "initialization failure (mock)", type: "server_error" } });
          return;
        }
        json(res, 200, { ok: true, endpoint });
      } finally {
        abortWatcher.cleanup();
        entry.end = Date.now();
        initActive--;
      }
      return;
    }
    const q = scripts.get(auth);
    const spec = (q && q.length) ? q.shift() : { mode: parsed.testMode || "ok", retryAfter: parsed.retryAfter };
    calls.push({ t: Date.now(), auth, path: p, mode: spec.mode, model: typeof parsed.model === "string" ? parsed.model : "" });
    console.log(`[mock] ${p} auth=${auth.slice(0, 12)} mode=${spec.mode} call#${calls.length}`);

    // Embedded upstream sends its native CC NDJSON request here rather than
    // the OpenAI-compatible JSON used by the manager-only e2e scenarios.
    if (p === "/alpha/generate") {
      if (spec.mode === "hang") return;
      if (spec.mode === "delay") await sleep(spec.delayMs || 180);
      if (spec.mode === "status" || spec.mode === "server5xx") {
        json(res, spec.status || 503, { error: { message: "generate failure (mock)", type: "server_error" } });
        return;
      }
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end([
        JSON.stringify({ type: "text-delta", text: "hello from embedded mock" }),
        JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 5, outputTokens: 7, cachedInputTokens: 1 } }),
      ].join("\n") + "\n");
      return;
    }

    if (spec.mode === "hang") return; // 永不响应
    if (spec.mode === "delay") {
      await sleep(spec.delayMs || 18000);
      json(res, 200, {
        id: "chatcmpl-delay", object: "chat.completion", model: parsed.model || "mock",
        choices: [{ index: 0, message: { role: "assistant", content: "slow-ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
      });
      return;
    }
    if (spec.mode === "rate_limit") {
      const ra = spec.retryAfter ?? 30;
      json(res, 429, { error: { message: "rate limited (mock)", type: "rate_limit_error" } }, { "Retry-After": String(ra) });
      return;
    }
    if (spec.mode === "zeroout") {
      // 与真实上游一致：状态 429，retry_after 只在 JSON body 中，无 Retry-After 头
      json(res, 429, { error: { message: "Empty response from upstream (zero output tokens)", type: "rate_limit_error" }, retry_after: 10 });
      return;
    }
    if (spec.mode === "auth") {
      json(res, 401, { error: { message: "invalid api key (mock)", type: "auth_error" } });
      return;
    }
    if (spec.mode === "server5xx") {
      json(res, spec.status || 503, { error: { message: "upstream down (mock)", type: "server_error" } });
      return;
    }
    if (spec.mode === "client4xx") {
      json(res, spec.status || 400, { error: { message: "bad request (mock)", type: "invalid_request_error" } });
      return;
    }
    if (spec.mode === "slowsse") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      let frames = 0; let aborted = false;
      res.on("close", () => { if (!res.writableEnded) aborted = true; });
      for (let i = 0; i < 15 && !aborted; i++) {
        try {
          res.write('data: {"id":"s","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"t' + i + '"}}]}\n\n');
        } catch { aborted = true; break; }
        frames++;
        await sleep(spec.frameDelayMs || 300);
      }
      if (!aborted) { res.write("data: [DONE]\n\n"); res.end(); }
      slowLog.push({ frames, aborted, auth });
      console.log(`[mock] slowsse finished frames=${frames} abortedEarly=${aborted}`);
      return;
    }
    if (spec.mode === "cutstream") {
      // 上游在 200 SSE 吐出若干帧后 socket 死亡（客户端仍在）：P1-1 复现用
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      res.write('data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"to"},"finish_reason":null}]}\n\n');
      await sleep(30);
      res.write('data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"ken"},"finish_reason":null}]}\n\n');
      await sleep(50);
      try { res.destroy(); } catch {}
      return;
    }
    if (spec.mode === "cutbody") {
      // 非流式：200 头 + 半个 JSON body 后 socket 死亡：P1-1 复现用
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"id":"chatcmpl-cut","object":"chat.completion","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"half');
      await sleep(30); // 确保头+部分内容已递交网关（真实场景为上游生成中途断流）
      try { res.destroy(); } catch {}
      return;
    }
    if (spec.mode === "badusage") {
      // P1-6 复现用：usage 字段为恶意非数值类型（字符串带 HTML/对象/null），
      // 验证网关数值净化——落盘与 /admin/api/history 中不得出现原始脏值
      json(res, 200, {
        id: "chatcmpl-badusage", object: "chat.completion", model: parsed.model || "mock",
        choices: [{ index: 0, message: { role: "assistant", content: "bad-usage" }, finish_reason: "stop" }],
        usage: { prompt_tokens: "1\"/><img src=x onerror=alert(1)>", completion_tokens: { evil: 1 }, total_tokens: null }
      });
      return;
    }
    if (spec.mode === "empty") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end();
      return;
    }
    if (spec.mode === "malformed") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("not-json");
      return;
    }
    if (spec.mode === "truncated") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"id":"chatcmpl-truncated","object":"chat.completion","choices":[{"message":');
      return;
    }
    if (spec.mode === "missingstructure") {
      json(res, 200, { id: "chatcmpl-missingstructure", object: "chat.completion", choices: [] });
      return;
    }
    if (p === "/v1/models") {
      json(res, 200, {
        object: "list",
        data: [{ id: "mock-model", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "mock" }]
      });
      return;
    }
    if (p === "/v1/messages") {
      if (spec.mode === "empty_sse") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.end();
        return;
      }
      if (spec.mode === "malformed_sse") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.end("event: message_start\ndata: {bad-json}\n\n");
        return;
      }
      if (spec.mode === "missingdone") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.end("event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { type: "message", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }) + "\n\n");
        return;
      }
      if (spec.mode === "sse") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
        res.write("event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { id: "msg-mock", type: "message", role: "assistant", content: [], model: parsed.model || "mock", usage: { input_tokens: 3, output_tokens: 0 } } }) + "\n\n");
        await sleep(10);
        res.write("event: content_block_start\ndata: " + JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) + "\n\n");
        res.write("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello from messages mock" } }) + "\n\n");
        res.write("event: content_block_stop\ndata: " + JSON.stringify({ type: "content_block_stop", index: 0 }) + "\n\n");
        res.write("event: message_delta\ndata: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 3, output_tokens: 4 } }) + "\n\n");
        res.write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
        res.end();
        return;
      }
      json(res, 200, {
        id: "msg-mock", type: "message", role: "assistant", model: parsed.model || "mock",
        content: [{ type: "text", text: "hello from messages mock" }],
        stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 1 }
      });
      return;
    }
    if (spec.mode === "empty_sse") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      res.end();
      return;
    }
    if (spec.mode === "missingdone") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      res.end('data: {"id":"c-missingdone","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":"stop"}]}\n\n');
      return;
    }
    if (spec.mode === "unterminateddone") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      res.end('data: {"id":"c-unterminated","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":"stop"}]}\n\ndata: [DONE]');
      return;
    }
    if (spec.mode === "malformed_sse") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      res.end('data: {"id":"c-malformed","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\ndata: {bad-json}\n\n');
      return;
    }
    if (spec.mode === "split_sse") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      const first = 'data: {"id":"c-split","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"split"},"finish_reason":"stop"}]}\n\n';
      const done = "data: [DONE]\n\n";
      for (const part of [first.slice(0, 19), first.slice(19), done.slice(0, 8), done.slice(8)]) {
        res.write(part);
        await sleep(5);
      }
      res.end();
      return;
    }
    if (spec.mode === "sse") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      res.write('data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"to"},"finish_reason":null}]}\n\n');
      await sleep(30);
      res.write('data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"k"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7,"prompt_tokens_details":{"cached_tokens":2}}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    // default ok
    json(res, 200, {
      id: "chatcmpl-mock", object: "chat.completion", model: parsed.model || "mock",
      choices: [{ index: 0, message: { role: "assistant", content: "hello from mock" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, prompt_tokens_details: { cached_tokens: 1 } }
    });
  });
});

server.listen(PORT, HOST, () => console.log(`[mock-upstream] listening on http://${HOST}:${PORT}`));
