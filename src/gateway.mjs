// ── 网关：clientToken 鉴权 + 主备选 Key + 429 退避/同 Key 重试 + 流式透传 ──
// 转发目标 = 同进程嵌入的上游代理（127.0.0.1:3050），协议转换全部交给上游
import { getConfig } from "./config.mjs";
import * as pool from "./keyPool.mjs";
import * as stats from "./stats.mjs";

function upstreamBase() {
  const c = getConfig();
  return "http://" + c.upstreamHost + ":" + c.upstreamPort;
}

function sendJson(res, status, data, extraHeaders) {
  const headers = { "Content-Type": "application/json" };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  if (data && data.retry_after !== undefined) headers["Retry-After"] = String(data.retry_after);
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("请求体过大"), { statusCode: 413 }));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function bearerToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const x = req.headers["x-api-key"];
  if (x) return String(x).trim();
  return null;
}

function parseRetryAfter(res, text) {
  const ra = res.headers.get("retry-after");
  if (ra) {
    const n = parseInt(ra, 10);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
  }
  if (text) {
    try {
      const j = JSON.parse(text);
      if (j && typeof j.retry_after === "number") return j.retry_after * 1000;
    } catch {}
  }
  return null;
}

function isZeroOutput(text) {
  return typeof text === "string" && /zero output|Empty response/i.test(text);
}

function mapError(status, text) {
  let message = "";
  try {
    const j = JSON.parse(text);
    message = (j.error && j.error.message) || j.message || "";
  } catch {
    message = (text || "").slice(0, 200);
  }
  if (status === 402 || status === 429) {
    return { status: 429, body: { error: { message: message || "Rate limited", type: "rate_limit_error" }, retry_after: 30 } };
  }
  if (status >= 500) {
    return { status: 502, body: { error: { message: message || "Upstream error", type: "proxy_error" } } };
  }
  return { status, body: { error: { message: message || "Upstream error (" + status + ")", type: "proxy_error" } } };
}

function parseUsageFromJson(text) {
  try {
    const j = JSON.parse(text);
    const u = j.usage;
    if (!u) return null;
    return {
      inputTokens: u.prompt_tokens ?? u.input_tokens ?? 0,
      outputTokens: u.completion_tokens ?? u.output_tokens ?? 0,
      cachedTokens: u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0
    };
  } catch {
    return null;
  }
}

function parseUsageFromSseLine(line) {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const j = JSON.parse(payload);
    if (j.usage && (j.object === "chat.completion.chunk" || j.usage.prompt_tokens !== undefined)) {
      const u = j.usage;
      return {
        inputTokens: u.prompt_tokens ?? 0,
        outputTokens: u.completion_tokens ?? 0,
        cachedTokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0
      };
    }
    if (j.type === "message_start" && j.message && j.message.usage) {
      return { inputTokens: j.message.usage.input_tokens ?? 0, outputTokens: 0, cachedTokens: j.message.usage.cache_read_input_tokens ?? 0 };
    }
    if (j.type === "message_delta" && j.usage) {
      return { inputTokens: 0, outputTokens: j.usage.output_tokens ?? 0, cachedTokens: j.usage.cache_read_input_tokens ?? 0 };
    }
  } catch {}
  return null;
}

async function pipeBody(upRes, res, isStream) {
  if (!isStream) {
    const text = await upRes.text();
    res.end(text);
    return parseUsageFromJson(text);
  }
  const reader = upRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = null;
  const merge = (u) => {
    if (!u) return;
    if (!usage) usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    usage.inputTokens += u.inputTokens || 0;
    usage.outputTokens += u.outputTokens || 0;
    usage.cachedTokens += u.cachedTokens || 0;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        merge(parseUsageFromSseLine(line));
        try { res.write(line + "\n"); } catch { try { reader.cancel(); } catch {} return usage; }
      }
    }
    if (buffer.trim()) {
      merge(parseUsageFromSseLine(buffer.trim()));
      try { res.write(buffer); } catch {}
    }
  } catch {
    // 客户端断开或上游中止
  }
  return usage;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function handleGateway(req, res, url) {
  const cfg = getConfig();
  // 决策 1：/v1/* 一律要求 token —— clientToken 未配置时回退 AdminToken
  const expect = cfg.clientToken || cfg.adminToken;
  const token = bearerToken(req);
  if (!token || token !== expect) {
    sendJson(res, 401, { error: { message: "Invalid or missing client token", type: "authentication_error" } });
    return;
  }
  const upstreamPath = url.pathname;
  let body = Buffer.alloc(0);
  let model = "";
  let stream = false;
  if (req.method === "POST") {
    try {
      body = await readBody(req, 100 * 1024 * 1024);
    } catch (e) {
      sendJson(res, e.statusCode === 413 ? 413 : 400, { error: { message: e.message, type: "invalid_request_error" } });
      return;
    }
    try {
      const j = JSON.parse(body.toString("utf-8"));
      model = j.model || "";
      stream = j.stream === true;
    } catch {}
  }

  const poolCfg = pool.getPoolCfg();
  const maxAttempts = Math.max(1, 1 + (poolCfg.maxRetries ?? 3));
  const sameKeyMax = Math.max(0, poolCfg.sameKeyRetryCount ?? 2);
  let attempts = 0;
  let lastStatus = 429;
  let lastBody = null;
  const startedAt = Date.now();

  while (attempts < maxAttempts) {
    const chosen = pool.selectKey();
    if (!chosen) {
      if (attempts === 0) {
        const wait = Math.max(1, Math.ceil(pool.nextRetryAfterMs() / 1000));
        sendJson(res, 429, {
          error: { message: "No usable API key in pool (all backed off / quota limited)", type: "rate_limit_error" },
          retry_after: wait
        });
        return;
      }
      break;
    }
    let sameKeyTries = 0;
    let retriedOnce5xx = false;
    while (true) {
      attempts++;
      const ac = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) { try { ac.abort(); } catch {} }
      };
      req.on("close", onClose);
      let upRes = null;
      try {
        const url2 = upstreamBase() + upstreamPath;
        const headers = {
          "content-type": req.headers["content-type"] || "application/json",
          accept: req.headers["accept"] || "application/json",
          authorization: "Bearer " + chosen.key
        };
        if (req.headers["x-session-id"]) headers["x-session-id"] = req.headers["x-session-id"];
        if (req.headers["x-claude-code-session-id"]) headers["x-claude-code-session-id"] = req.headers["x-claude-code-session-id"];
        let t;
        const timeoutP = new Promise((_, rej) => {
          t = setTimeout(() => {
            try { ac.abort(); } catch {}
            rej(Object.assign(new Error("upstream connect timeout"), { code: "CONNECT_TIMEOUT" }));
          }, 15000);
        });
        try {
          upRes = await Promise.race([
            fetch(url2, { method: req.method, headers, body: req.method === "POST" ? body : undefined, signal: ac.signal }),
            timeoutP
          ]);
        } finally {
          clearTimeout(t);
        }
      } catch (e) {
        req.removeListener("close", onClose);
        lastStatus = 502;
        lastBody = { error: { message: "Upstream unreachable: " + e.message, type: "proxy_error" } };
        stats.appendEvent({ keyId: chosen.id, model, stream, ok: false, status: 502, errorKind: "upstream", retries: attempts - 1, latencyMs: Date.now() - startedAt });
        break;
      }

      if (upRes.status === 200) {
        req.removeListener("close", onClose);
        const ct = upRes.headers.get("content-type") || "";
        const isStream = stream && ct.includes("text/event-stream");
        const headers = { "content-type": ct || (isStream ? "text/event-stream" : "application/json") };
        if (isStream) {
          headers["cache-control"] = "no-cache";
          headers["connection"] = "keep-alive";
        }
        res.writeHead(200, headers);
        const usage = await pipeBody(upRes, res, isStream);
        pool.recordSuccess(chosen.id);
        stats.appendEvent({
          keyId: chosen.id, model, stream: isStream, ok: true, status: 200,
          inputTokens: usage ? usage.inputTokens : undefined,
          outputTokens: usage ? usage.outputTokens : undefined,
          cachedTokens: usage ? usage.cachedTokens : undefined,
          retries: attempts - 1,
          latencyMs: Date.now() - startedAt
        });
        return;
      }

      const text = await upRes.text().catch(() => "");
      const retryAfterMs = parseRetryAfter(upRes, text);

      if (upRes.status === 401 || upRes.status === 403) {
        pool.markAuthError(chosen.id);
        req.removeListener("close", onClose);
        stats.appendEvent({ keyId: chosen.id, model, stream, ok: false, status: upRes.status, errorKind: "auth", retries: attempts - 1, latencyMs: Date.now() - startedAt });
        const mapped = mapError(upRes.status, text);
        sendJson(res, mapped.status, mapped.body);
        return;
      }

      const isRateLimit = upRes.status === 429 || upRes.status === 402 || (poolCfg.zeroOutputCountsAs429 && isZeroOutput(text));
      if (isRateLimit) {
        lastStatus = 429;
        const mapped = mapError(429, text);
        mapped.body.retry_after = retryAfterMs ? Math.ceil(retryAfterMs / 1000) : (mapped.body.retry_after ?? 30);
        lastBody = mapped.body;
        const zeroOut = isZeroOutput(text);
        // 决策 8：429/402/零输出先同 Key 重试；确属持续限流才退避 + 切换备 Key
        const retryable = sameKeyTries < sameKeyMax && attempts < maxAttempts &&
          (zeroOut || (retryAfterMs !== null && retryAfterMs <= (poolCfg.sameKeyRetryMaxWaitMs ?? 5000)));
        sameKeyTries++;
        if (retryable) {
          const delay = Math.min(retryAfterMs ?? 2000, poolCfg.sameKeyRetryDelayMs ?? 2000);
          await sleep(delay);
          continue;
        }
        pool.recordRateLimit(chosen.id, retryAfterMs);
        pool.recordFailover(chosen.id);
        req.removeListener("close", onClose);
        stats.appendEvent({ keyId: chosen.id, model, stream, ok: false, status: 429, errorKind: "rate_limit", retries: attempts - 1, latencyMs: Date.now() - startedAt });
        break;
      }

      if (upRes.status >= 500 && upRes.status < 600) {
        lastStatus = upRes.status;
        lastBody = mapError(upRes.status, text).body;
        if (!retriedOnce5xx && attempts < maxAttempts) {
          retriedOnce5xx = true;
          await sleep(500);
          continue;
        }
        req.removeListener("close", onClose);
        stats.appendEvent({ keyId: chosen.id, model, stream, ok: false, status: upRes.status, errorKind: "upstream", retries: attempts - 1, latencyMs: Date.now() - startedAt });
        break;
      }

      // 其余状态（400/404/422...）：透传，不重试
      req.removeListener("close", onClose);
      stats.appendEvent({ keyId: chosen.id, model, stream, ok: false, status: upRes.status, errorKind: "client", retries: attempts - 1, latencyMs: Date.now() - startedAt });
      const mapped = mapError(upRes.status, text);
      sendJson(res, mapped.status, mapped.body);
      return;
    }
  }

  const wait = Math.max(1, Math.ceil((pool.nextRetryAfterMs() || 5000) / 1000));
  const finalBody = lastBody || { error: { message: "All API keys unavailable", type: "rate_limit_error" }, retry_after: wait };
  sendJson(res, lastStatus === 502 ? 502 : 429, finalBody, { "Retry-After": String(wait) });
}
