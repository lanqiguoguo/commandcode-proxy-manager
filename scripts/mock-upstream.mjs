// ── 测试用 mock 上游：按 Authorization 头区分 Key，支持 per-key 脚本化响应。
// 行为通道：
//   1) 请求 body 的 testMode 字段（经网关原样转发的 body 传递）
//   2) POST /__control {auth, responses:[{mode,...}]} 设置该 Key 的响应队列（优先）
// 模式 mode：ok | sse | slowsse | rate_limit(retryAfter秒) | zeroout | auth | server5xx | hang | delay(delayMs)
// 管理端点：GET /__calls 调用记录；GET /__slow slowsse 断流观测；POST /__reset 清空
import http from "http";
import { setTimeout as sleep } from "timers/promises";

const PORT = Number(process.env.MOCK_PORT || 3051);
const HOST = process.env.MOCK_HOST || "127.0.0.1";
const scripts = new Map(); // authKey → [spec...]
const calls = [];
const slowLog = [];

function json(res, status, data, headers) {
  res.writeHead(status, Object.assign({ "Content-Type": "application/json" }, headers || {}));
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
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
      json(res, 200, { ok: true }); return;
    }
    if (p === "/__calls") { json(res, 200, { calls }); return; }
    if (p === "/__slow") { json(res, 200, { slowLog }); return; }
    if (p === "/__reset") { scripts.clear(); calls.length = 0; slowLog.length = 0; json(res, 200, { ok: true }); return; }

    let parsed = {};
    try { parsed = JSON.parse(body || "{}"); } catch {}
    const q = scripts.get(auth);
    const spec = (q && q.length) ? q.shift() : { mode: parsed.testMode || "ok", retryAfter: parsed.retryAfter };
    calls.push({ t: Date.now(), auth, path: p, mode: spec.mode });
    console.log(`[mock] ${p} auth=${auth.slice(0, 12)} mode=${spec.mode} call#${calls.length}`);

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
