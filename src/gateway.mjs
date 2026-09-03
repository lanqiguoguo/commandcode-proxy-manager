// ── 网关：clientToken 鉴权 + 主备选 Key + 429 退避/同 Key 重试 + 流式透传 ──
// 转发目标 = 同进程嵌入的上游代理（127.0.0.1:3050），协议转换全部交给上游
import { getConfig } from "./config.mjs";
import * as pool from "./keyPool.mjs";
import * as stats from "./stats.mjs";
import { safeEqual } from "./tokens.mjs";
import { randomUUID } from "crypto";

// 非流式响应体读取上限：LLM 非流式 JSON 响应远小于此，纯防内存放大（M3）。
// 请求体侧已有 100MB 上限（readBody），响应体原无上限——upRes.text() 被 undici
// 整包缓冲在内存，多并发大响应可放大为内存耗尽。64MB 为防御性护栏，只作用于
// pipeBody 非流式路径的 200 响应；非 200 错误体（429/5xx 等）体量小，仍在原路径处理。
const MAX_NONSTREAM_BODY = 64 * 1024 * 1024;
// readBody 413 拒绝后仍要消费（丢弃）的请求体上限：防恶意客户端以永不结束的
// body 占死连接；超过该量强制断开（最后手段，连接已不可救）。
const MAX_DRAIN = 32 * 1024 * 1024;

function upstreamBase() {
  const c = getConfig();
  return "http://" + c.upstreamHost + ":" + c.upstreamPort;
}

function sendJson(res, status, data, extraHeaders) {
  // 客户端已断开：不再写入（避免 destroyed 响应上的 end 触发异步 error）
  if (res.writableEnded || res.destroyed) return;
  const headers = { "Content-Type": "application/json" };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  // 显式传入的 Retry-After（出口按最新池状态计算）优先于 body 中可能过期的 retry_after
  if (data && data.retry_after !== undefined && headers["Retry-After"] === undefined)
    headers["Retry-After"] = String(data.retry_after);
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false; // Promise 只 settle 一次：end / error / drain 超限三条路径先到者生效
    let overflow = false;
    let drained = 0;
    req.on("data", (c) => {
      if (overflow) {
        // 超限后转 drain：继续读并丢弃剩余请求体直到 end——保住连接，
        // 让 413 沿完整连接送达（直接 destroy 会让客户端收到 ECONNRESET 而非明确 413）
        drained += c.length;
        if (drained > MAX_DRAIN) {
          // 恶意客户端可发永不结束的 body 占死连接：drain 超上限即强制断开，
          // 最后手段（连接已不可救，413 已无法送达）。destroy 无错时不再有
          // end/error 事件，故此处同时 settle——否则 promise 永挂。
          settled = true;
          try { req.destroy(); } catch {}
          reject(Object.assign(new Error("请求体过大"), { statusCode: 413 }));
        }
        return;
      }
      size += c.length;
      if (size > limit) {
        overflow = true;
        chunks.length = 0; // 释放已累积的超限数据，防内存放大
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (overflow) {
        // 完整吞掉超限请求体后才在此拒绝：此刻连接干净，413 可送达且连接可复用
        reject(Object.assign(new Error("请求体过大"), { statusCode: 413 }));
      } else {
        resolveBody(Buffer.concat(chunks));
      }
    });
    req.on("error", (e) => {
      // 客户端中途断开等：连接已不可用，直接失败
      if (settled) return;
      settled = true;
      reject(e);
    });
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

// P1-6：上游 usage 字段数值强转——上游应答方给什么收什么（EMBED_UPSTREAM=0 时
// UPSTREAM_HOST 可控），字符串/对象/null 若不净化会经 merge 拼接、落盘污染统计与前端渲染。
// 语义与 quota.mjs 的 num() 相同（本地实现避免跨模块耦合）：非有限数 → 0。
function num(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function usageFromPayload(payload) {
  if (!isRecord(payload)) return null;
  const usage = isRecord(payload.usage)
    ? payload.usage
    : (payload.type === "message_start" && isRecord(payload.message?.usage) ? payload.message.usage : null);
  if (!usage) return null;
  return {
    inputTokens: num(usage.prompt_tokens ?? usage.input_tokens ?? 0),
    outputTokens: num(usage.completion_tokens ?? usage.output_tokens ?? 0),
    cachedTokens: num(usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0)
  };
}

function responseProtocol(pathname) {
  if (pathname === "/v1/messages") return "anthropic";
  if (pathname === "/v1/models") return "models";
  return "openai";
}

function validateJsonResponse(text, protocol) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, reason: "upstream 200 response is not valid JSON" };
  }
  if (!isRecord(payload)) return { ok: false, reason: "upstream JSON response must be an object" };

  if (protocol === "models") {
    if (payload.object !== "list" || !Array.isArray(payload.data) ||
        payload.data.some((model) => !isRecord(model) || typeof model.id !== "string" || !model.id)) {
      return { ok: false, reason: "upstream model list is incomplete" };
    }
    return { ok: true, payload, usage: null };
  }

  if (protocol === "anthropic") {
    if (payload.type !== "message" || payload.role !== "assistant" || !Array.isArray(payload.content)) {
      return { ok: false, reason: "upstream Anthropic message is incomplete" };
    }
    return { ok: true, payload, usage: usageFromPayload(payload) };
  }

  if (payload.object !== "chat.completion" || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    return { ok: false, reason: "upstream OpenAI chat completion is incomplete" };
  }
  if (payload.choices.some((choice) => !isRecord(choice) || !isRecord(choice.message))) {
    return { ok: false, reason: "upstream OpenAI chat completion choices are incomplete" };
  }
  return { ok: true, payload, usage: usageFromPayload(payload) };
}

function newSseState(protocol) {
  return {
    protocol,
    frameLines: [],
    sawDone: false,
    sawChunk: false,
    messageStarted: false,
    messageStopped: false,
    sawContent: false,
    usage: null,
  };
}

function mergeUsage(current, next) {
  if (!next) return current;
  if (!current) return { ...next };
  current.inputTokens += next.inputTokens;
  current.outputTokens += next.outputTokens;
  current.cachedTokens += next.cachedTokens;
  return current;
}

function validateSsePayload(payload, state) {
  if (payload.trim() === "[DONE]") {
    if (state.protocol !== "openai" || state.sawDone || !state.sawChunk) {
      return "invalid or premature SSE [DONE] termination";
    }
    state.sawDone = true;
    return null;
  }
  if (state.sawDone) return "SSE data appeared after [DONE]";
  if (!payload.trim()) return "empty SSE data event";

  let event;
  try { event = JSON.parse(payload); } catch { return "SSE data event is not valid JSON"; }
  if (!isRecord(event)) return "SSE data event must be an object";

  if (state.protocol === "openai") {
    if (event.object !== "chat.completion.chunk" || !Array.isArray(event.choices)) {
      return "upstream OpenAI SSE chunk is incomplete";
    }
    if (event.choices.length === 0 && !isRecord(event.usage)) {
      return "upstream OpenAI SSE chunk has no choices or usage";
    }
    if (event.choices.some((choice) => !isRecord(choice) || !isRecord(choice.delta))) {
      return "upstream OpenAI SSE choices are incomplete";
    }
    if (event.choices.length > 0) state.sawChunk = true;
    state.usage = mergeUsage(state.usage, usageFromPayload(event));
    return null;
  }

  switch (event.type) {
    case "ping":
      return null;
    case "message_start":
      if (state.messageStarted || !isRecord(event.message) || event.message.type !== "message" ||
          event.message.role !== "assistant" || !Array.isArray(event.message.content)) {
        return "upstream Anthropic message_start is incomplete";
      }
      state.messageStarted = true;
      state.usage = mergeUsage(state.usage, usageFromPayload(event));
      return null;
    case "content_block_start":
      if (!state.messageStarted || !Number.isInteger(event.index) || !isRecord(event.content_block)) {
        return "upstream Anthropic content_block_start is incomplete";
      }
      state.sawContent = true;
      return null;
    case "content_block_delta":
      if (!state.messageStarted || !Number.isInteger(event.index) || !isRecord(event.delta)) {
        return "upstream Anthropic content_block_delta is incomplete";
      }
      state.sawContent = true;
      return null;
    case "content_block_stop":
      if (!state.messageStarted || !Number.isInteger(event.index)) return "upstream Anthropic content_block_stop is incomplete";
      return null;
    case "message_delta":
      if (!state.messageStarted || !isRecord(event.delta)) return "upstream Anthropic message_delta is incomplete";
      state.sawContent = true;
      state.usage = mergeUsage(state.usage, usageFromPayload(event));
      return null;
    case "message_stop":
      if (!state.messageStarted || state.messageStopped) return "upstream Anthropic message_stop is invalid";
      state.messageStopped = true;
      return null;
    case "error":
      return "upstream Anthropic SSE reported an error";
    default:
      return "unknown or unsupported Anthropic SSE event";
  }
}

function finishSseValidation(state) {
  if (state.frameLines.length > 0) return "upstream SSE ended with an incomplete event frame";
  if (state.protocol === "openai") {
    if (!state.sawChunk || !state.sawDone) return "upstream OpenAI SSE is missing a valid [DONE] termination";
  } else if (!state.messageStarted || !state.sawContent || !state.messageStopped) {
    return "upstream Anthropic SSE is missing a complete message termination";
  }
  return null;
}

// 等待可写（背压）：res.write() 返回 false 后挂 drain 等待缓冲排空再继续写。
// 慢客户端断连时 drain 永不触发——close 双事件唤醒（Node 保证连接销毁必发 close），
// 由调用方随后用 isClientGone() 判定分类。res 的 'error' 已由 handleGateway 挂 noop，
// 此处仅需 drain+close，两事件都必然在连接生命周期内触达其一，无死锁。
// 边角：若 close 在我们挂监听之前已发射（res.destroyed 已置位），drain/close 不会再
// 来——立即返回，由调用方 isClientGone() 判定走 client 收尾，避免永久挂起。
async function waitDrain(res) {
  if (res.destroyed) return;
  await new Promise((resolve) => {
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      res.off("drain", onDrain);
      res.off("close", onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); resolve(); };
    res.on("drain", onDrain);
    res.on("close", onClose);
  });
}

// 返回 { body, usage, err }：err = null（正常完成）| "client"（客户端断开）|
// "upstream"（上游中途断连）| "invalid"（200 响应协议不完整）。非流式在完整校验
// 前不写客户端，流式则保留已写出的前缀并由调用方销毁连接，避免切 Key 重放。
// isClientGone(): 调用方闭包，判定客户端是否已断开（断开检测优先于分类，避免误判上游故障）。
async function pipeBody(upRes, res, isStream, isClientGone, protocol) {
  // 已 broken 的流上 cancel() 返回 rejected promise（undici "terminated"），同步 try/catch 接不住，
  // 会成为 unhandledRejection —— 统一挂 noop catch 消除次生拒绝噪音。
  const safeCancel = (reader) => {
    try { const p = reader.cancel(); if (p && typeof p.catch === "function") p.catch(() => {}); } catch {}
  };
  if (!isStream) {
    // 非流式响应体上限（M3）：逐块读取，先完整校验，避免把截断/畸形 200 透传为成功。
    if (!upRes.body) return { body: Buffer.alloc(0), usage: null, err: "invalid", reason: "upstream 200 response has an empty body" };
    const reader = upRes.body.getReader();
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_NONSTREAM_BODY) { tooLarge = true; safeCancel(reader); break; }
        chunks.push(value);
      }
    } catch {
      // body 读取中断：客户端断开（abort 致 read 拒绝）或上游 socket 死亡
      safeCancel(reader);
      return { body: Buffer.concat(chunks), usage: null, err: isClientGone() ? "client" : "upstream" };
    }
    if (tooLarge) {
      return { body: Buffer.concat(chunks), usage: null, err: "invalid", reason: "upstream 200 response exceeds the size limit" };
    }
    const body = Buffer.concat(chunks);
    const validation = validateJsonResponse(body.toString("utf-8"), protocol);
    if (!validation.ok) return { body, usage: null, err: "invalid", reason: validation.reason };
    return { body, usage: validation.usage, err: null };
  }
  if (!upRes.body) return { usage: null, err: "invalid", reason: "upstream 200 SSE response has an empty body" };
  const reader = upRes.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  const state = newSseState(protocol);

  const writeChunk = async (chunk) => {
    let ok;
    try { ok = res.write(chunk); } catch { return "client"; }
    if (!ok) {
      // 写缓冲满（背压）：暂停读上游，等 drain 再继续——慢客户端时防止 Node 写队列无限堆积。
      // 断连时 drain 永不触发，靠 close 唤醒（Node 保证连接销毁必发 close），由 isClientGone 判定分类。
      await waitDrain(res);
      if (isClientGone()) return "client";
    }
    return null;
  };

  const processFrame = () => {
    if (!state.frameLines.length) return null;
    const dataLines = [];
    for (const line of state.frameLines) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("data:")) {
        let value = line.slice(5);
        if (value.startsWith(" ")) value = value.slice(1);
        dataLines.push(value);
        continue;
      }
      if (/^(?:event|id|retry)(?::.*)?$/.test(line)) continue;
      return "SSE frame contains an invalid field";
    }
    state.frameLines = [];
    if (!dataLines.length) return null;
    return validateSsePayload(dataLines.join("\n"), state);
  };

  const processLine = (rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") return processFrame();
    state.frameLines.push(line);
    return null;
  };

  const invalid = (reason) => {
    safeCancel(reader);
    return { usage: state.usage, err: "invalid", reason };
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const reason = processLine(line);
        const writeErr = await writeChunk(line + "\n");
        if (writeErr) { safeCancel(reader); return { usage: state.usage, err: writeErr }; }
        if (reason) return invalid(reason);
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      const reason = processLine(buffer);
      const writeErr = await writeChunk(buffer);
      if (writeErr) { safeCancel(reader); return { usage: state.usage, err: writeErr }; }
      if (reason) return invalid(reason);
    }
  } catch {
    // read() 拒绝：客户端断开（abort 致 read 拒绝）或上游 socket 死亡
    safeCancel(reader);
    return { usage: state.usage, err: isClientGone() ? "client" : "upstream" };
  }
  const reason = finishSseValidation(state);
  if (reason) return invalid(reason);
  try { res.end(); } catch {}
  return { usage: state.usage, err: null };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function retryAfterSeconds(ms) {
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

export async function handleGateway(req, res, url) {
  const cfg = getConfig();
  // 决策 1：/v1/* 一律要求 token —— clientToken 未配置时回退 AdminToken
  const expect = cfg.clientToken || cfg.adminToken;
  const token = bearerToken(req);
  if (!token || !safeEqual(token, expect)) {
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
      // P1-4：model 仅接受字符串并截断 128 字符（防 CSV 公式注入放大 + 磁盘放大 P2-8）
      model = typeof j.model === "string" ? j.model.slice(0, 128) : "";
      stream = j.stream === true;
    } catch {}
  }

  // 客户端断开检测绑在 res 上：req 可读流被 readBody 消费完后即 destroy，其 'close'
  // 事件往往在后文注册监听之前就已发射（监听永不触发）；res 随连接结束才关闭，事件可靠。
  // 注意 res 'close' 在正常 end 之后同样会发射，必须用 writableEnded 区分“已完成”与“被掐断”。
  let clientGone = false;
  let activeAc = null;
  // 断开后对 res 的写入会以异步 error 事件失败（EPIPE 等）；无 listener 的 'error' 会抛穿进程，
  // 这里静默吞掉（连接已死，无法也无需再报告给客户端）。
  res.on("error", () => {});
  res.on("close", () => {
    if (res.writableEnded) return;
    clientGone = true;
    if (activeAc) { try { activeAc.abort(); } catch {} }
  });

  const poolCfg = pool.getPoolCfg();
  // 文档语义：maxRetries = 额外重试次数（总尝试 = maxRetries + 1）
  const maxAttempts = Math.max(1, (poolCfg.maxRetries ?? 3) + 1);
  const sameKeyMax = Math.max(0, poolCfg.sameKeyRetryCount ?? 2);
  let attempts = 0;
  let lastStatus = 429;
  let lastBody = null;
  let lastErrorKind = "rate_limit";
  let lastKeyId = null;
  const startedAt = Date.now();
  const requestId = randomUUID();
  const attemptedKeyIds = [];
  let requestEventRecorded = false;
  // Statistics are external-request rows. Attempts remain local so a retry
  // episode is represented once, with retries/attempts and its key path.
  const recordRequestEvent = ({
    keyId = lastKeyId,
    stream: eventStream = stream,
    ok = false,
    status = lastStatus,
    errorKind = lastErrorKind,
    inputTokens,
    outputTokens,
    cachedTokens,
  } = {}) => {
    if (requestEventRecorded) return;
    requestEventRecorded = true;
    stats.appendEvent({
      eventType: stats.EVENT_TYPE_REQUEST,
      requestId,
      keyId: keyId || undefined,
      model,
      stream: eventStream,
      ok,
      status,
      errorKind: ok ? undefined : errorKind,
      inputTokens,
      outputTokens,
      cachedTokens,
      attempts,
      retries: Math.max(0, attempts - 1),
      attemptedKeyIds: attemptedKeyIds.length ? [...attemptedKeyIds] : undefined,
      latencyMs: Date.now() - startedAt,
    });
  };
  const recordClientAbort = ({ keyId = lastKeyId, stream: eventStream = stream } = {}) => {
    recordRequestEvent({ keyId, stream: eventStream, status: 499, ok: false, errorKind: "client" });
  };
  const requestBudgetMs = 30000; // 同Key重试/退避等待的总预算（不限制单次等待上游响应头，见 connectTimeoutMs）
  const deadlineAt = startedAt + requestBudgetMs;
  // 本请求内已尝试过的 Key：5xx/网络错误不记退避（非 per-key 限流信号），若不排除，
  // 换 Key 时 selectKey 会再次选中同一主 Key，备 Key 永不被尝试（P2-2）
  const triedKeys = new Set();

  // 预算只约束"重试/退避/换 Key"，单次尝试的 connectTimeoutMs（默认 120s）不受 30s 约束：
  // 头等待超时按设计从预算中豁免（见下方 perAttemptMs 注释），防止合法慢生成被误杀（T11）。
  while (attempts < maxAttempts && Date.now() < deadlineAt) {
    const chosen = pool.selectKey(triedKeys);
    if (!chosen) {
      if (clientGone || res.writableEnded || res.destroyed) {
        if (clientGone) recordClientAbort({ keyId: lastKeyId });
        return;
      }
      if (attempts === 0) {
        const wait = retryAfterSeconds(pool.nextRetryAfterMs());
        sendJson(res, 429, {
          error: { message: "No usable API key in pool (all backed off / quota limited)", type: "rate_limit_error" },
          retry_after: wait
        });
        recordRequestEvent({ status: 429, ok: false, errorKind: "rate_limit" });
        return;
      }
      break;
    }
    if (Date.now() >= deadlineAt) break; // 预算耗尽不再发起新尝试（含选中 Key 后、发起请求前）
    // L-b：上一尝试错误体排空/收尾（activeAc 已置 null，见各 break 分支）之后、本尝试
    // fetch 发出之前，客户端可能断开——res 'close' 触发时 abort 落空，仅置位 clientGone，
    // 而外层 while 条件不含 clientGone，若无此复查，新 fetch 将无中断源地完整执行
    // （浪费一次完整生成与上游计费）。所有"换 Key 后发起新尝试"的路径都汇聚于此
    // （selectKey 同步执行，本行与 fetch 发出之间无 await，close 不可能漏检），一处覆盖。
    if (clientGone || res.writableEnded || res.destroyed) {
      if (clientGone) recordClientAbort({ keyId: lastKeyId });
      return;
    }
    triedKeys.add(chosen.id);
    let sameKeyTries = 0;
    let retriedOnce5xx = false;
    while (true) {
      const attempt = pool.beginAttempt(chosen.id);
      if (!attempt) break;
      attempts++;
      lastKeyId = chosen.id;
      attemptedKeyIds.push(chosen.id);
      const ac = new AbortController();
      activeAc = ac;
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
        // 等待上游响应头的超时：connectTimeoutMs 默认 120s（上游非流式 90s / 流式 30s 自身超时
        // 会先返回 JSON，网关侧纯兜底），不能用 30s 总预算压缩单次等待——否则合法的慢生成会被误杀
        const perAttemptMs = poolCfg.connectTimeoutMs ?? 120000;
        const timeoutP = new Promise((_, rej) => {
          t = setTimeout(() => {
            try { ac.abort(); } catch {}
            rej(Object.assign(new Error("upstream connect timeout"), { code: "CONNECT_TIMEOUT" }));
          }, perAttemptMs);
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
        if (clientGone || res.writableEnded || res.destroyed) {
          // 客户端已断开：停止一切重试与响应写入
          activeAc = null;
          if (clientGone) recordClientAbort({ keyId: chosen.id });
          return;
        }
        const isTimeout = e && (e.code === "CONNECT_TIMEOUT" || /timeout/i.test(e.message || ""));
        if (isTimeout) {
          try { pool.recordTimeout(chosen.id); } catch {}
          lastStatus = 502;
          lastErrorKind = "timeout";
          lastBody = { error: { message: "Upstream unreachable: " + e.message, type: "proxy_error" } };
          // 超时退避后换 Key：外层 while 顶部的截止检查会决定是否继续发起新尝试，
          // 预算耗尽时此处 break 即进入最终响应路径（502）。
          break;
        }
        lastStatus = 502;
        lastErrorKind = "upstream";
        lastBody = { error: { message: "Upstream unreachable: " + e.message, type: "proxy_error" } };
        break;
      }

      if (upRes.status === 200) {
        const ct = upRes.headers.get("content-type") || "";
        const protocol = responseProtocol(upstreamPath);
        const isStream = stream && protocol !== "models" && ct.toLowerCase().includes("text/event-stream");
        const headers = { "content-type": ct || (isStream ? "text/event-stream" : "application/json") };
        if (isStream) {
          headers["cache-control"] = "no-cache";
          headers["connection"] = "keep-alive";
        }
        // 客户端断开检测复用 res 'close'（activeAc 已指向本尝试的 controller）：
        // 断开即 abort 上游拉取，pipeBody 走中断路径；不记成功事件。
        const isClientGone = () => clientGone || ac.signal.aborted;
        if (stream && protocol !== "models" && !isStream) {
          // stream 请求收到非 SSE 200 时不能把完整 JSON 当作成功，更不能切 Key
          // 重放（上游已经接受了本次请求）；先取消未消费的 body，再返回明确 502。
          try { await upRes.body?.cancel(); } catch {}
          activeAc = null;
          lastStatus = 502;
          lastErrorKind = "upstream";
          if (clientGone) {
            recordClientAbort({ keyId: chosen.id, stream: true });
            return;
          }
          recordRequestEvent({ keyId: chosen.id, stream: true, status: 502, errorKind: "upstream" });
          if (clientGone || res.writableEnded || res.destroyed) return;
          sendJson(res, 502, { error: { message: "Upstream returned a non-SSE response for a stream request", type: "proxy_error" } });
          return;
        }
        if (isStream) res.writeHead(200, headers);
        let usage = null;
        let pipeErr = null;
        let pipeReason = "";
        let responseBody = null;
        try {
          const result = await pipeBody(upRes, res, isStream, isClientGone, protocol);
          usage = result.usage;
          pipeErr = result.err;
          pipeReason = result.reason || "";
          responseBody = result.body || null;
        } catch {
          // pipeBody 已不抛出；此处纯兜底（如 writeHead/end 意外抛错）
          pipeErr = isClientGone() ? "client" : "upstream";
        }
        activeAc = null;
        if (clientGone) {
          // 客户端已断开：不计成功；记录一次可审计的客户端取消终态，不再重试。
          recordClientAbort({ keyId: chosen.id, stream: isStream });
          return;
        }
        if (pipeErr === "client") {
          recordClientAbort({ keyId: chosen.id, stream: isStream });
          return;
        }
        if (pipeErr) {
          // 流式路径可能已经写出 200 头或部分内容，协议错误与上游断流一样只能
          // 终止当前连接，绝不能换 Key 重放；非流式尚未写头，返回可解析的 502。
          lastStatus = 502;
          lastErrorKind = "upstream";
          recordRequestEvent({ keyId: chosen.id, stream: isStream, status: 502, errorKind: "upstream" });
          if (isStream) {
            try { res.destroy(); } catch {}
          } else if (!clientGone && !res.writableEnded && !res.destroyed) {
            sendJson(res, 502, { error: { message: pipeReason || "Invalid response from upstream", type: "proxy_error" } });
          }
          return;
        }
        if (!isStream) {
          if (!responseBody || clientGone || res.writableEnded || res.destroyed) {
            if (clientGone) recordClientAbort({ keyId: chosen.id });
            return;
          }
          res.writeHead(200, headers);
          res.end(responseBody);
        }
        pool.recordSuccess(chosen.id, attempt);
        recordRequestEvent({
          keyId: chosen.id, stream: isStream, ok: true, status: 200,
          inputTokens: usage ? usage.inputTokens : undefined,
          outputTokens: usage ? usage.outputTokens : undefined,
          cachedTokens: usage ? usage.cachedTokens : undefined,
        });
        return;
      }

      const text = await upRes.text().catch(() => "");
      const retryAfterMs = parseRetryAfter(upRes, text);

      if (upRes.status === 401 || upRes.status === 403) {
        if (clientGone) {
          activeAc = null;
          recordClientAbort({ keyId: chosen.id });
          return;
        }
        pool.markAuthError(chosen.id);
        activeAc = null;
        lastStatus = upRes.status;
        lastErrorKind = "auth";
        // 错误体排空后客户端可能断开：sendJson 自带判空守卫，此处提前返回保持一致
        if (clientGone || res.writableEnded || res.destroyed) {
          if (clientGone) recordClientAbort({ keyId: chosen.id });
          return;
        }
        recordRequestEvent({ keyId: chosen.id, status: upRes.status, errorKind: "auth" });
        const mapped = mapError(upRes.status, text);
        sendJson(res, mapped.status, mapped.body);
        return;
      }

      const zeroOut = isZeroOutput(text);
      // 零输出上游返回的就是 429 状态，若先判 status===429 则开关永远短路（原缺陷）。
      // 语义：zeroOutputCountsAs429=true → 零输出按限流处理（重试/退避）；false → 不惩罚 Key，
      // 走下方透传分支原样返回上游响应。
      const isRateLimit = zeroOut
        ? !!poolCfg.zeroOutputCountsAs429
        : (upRes.status === 429 || upRes.status === 402);
      if (isRateLimit) {
        lastStatus = 429;
        lastErrorKind = "rate_limit";
        const mapped = mapError(429, text);
        // Retry-After 为 0 表示“立即重试”，必须保留 0（不能回退成 30）。
        // 注意：mapped.body.retry_after 已是 mapError 默认填的 30，下面的回退只在
        // parseRetryAfter 既没解析到 header 也没解析到 body 时使用。
        mapped.body.retry_after = retryAfterMs !== null
          ? Math.ceil(retryAfterMs / 1000)
          : (mapped.body.retry_after !== undefined ? mapped.body.retry_after : 30);
        lastBody = mapped.body;
        // 决策 8：429/402/零输出先同 Key 重试；确属持续限流才退避 + 切换备 Key
        const retryable = sameKeyTries < sameKeyMax && attempts < maxAttempts &&
          (zeroOut || (retryAfterMs !== null && retryAfterMs <= (poolCfg.sameKeyRetryMaxWaitMs ?? 5000)));
        sameKeyTries++;
        if (retryable) {
          const delay = Math.min(retryAfterMs ?? 2000, poolCfg.sameKeyRetryDelayMs ?? 2000, Math.max(0, deadlineAt - Date.now()));
          if (delay > 0) await sleep(delay);
          activeAc = null;
          if (Date.now() >= deadlineAt) break;
          // 等待期间客户端可能断开：中断重试
          if (clientGone || res.writableEnded || res.destroyed) {
            if (clientGone) recordClientAbort({ keyId: chosen.id });
            return;
          }
          // L-a：睡眠期间本 Key 可能已被并发请求标退避 / 额度探测标 quotaLimited /
          // 401 标 authError——醒来复检不可用即放弃它，不再多发一次请求（break 后
          // 外层 selectKey 会排除它：triedKeys 已含 chosen，且退避/限额已使其不可选）。
          // 该 Key 的状态是并发方标的，此处只做"取消"，不重复 recordRateLimit /
          // recordFailover / 统计事件（避免重复计数）；池中无其他 Key 时最终收尾 429。
          if (!pool.isKeyUsable(chosen.id)) break;
          continue;
        }
        pool.recordRateLimit(chosen.id, retryAfterMs);
        pool.recordFailover(chosen.id);
        activeAc = null;
        // L-b：错误体已排空、不再重试（将走外层 while 换 Key 或最终 429）。此时客户端若
        // 断开，'close' 只置位 clientGone（activeAc 已 null，abort 落空）——外层 while 条件
        // 不含 clientGone，唯一的闸门是 while 顶部的 L-b 复检，故需在此提前返回。
        if (clientGone || res.writableEnded || res.destroyed) {
          if (clientGone) recordClientAbort({ keyId: chosen.id });
          return;
        }
        break;
      }

      if (upRes.status >= 500 && upRes.status < 600) {
        lastStatus = upRes.status;
        lastErrorKind = "upstream";
        lastBody = mapError(upRes.status, text).body;
        if (!retriedOnce5xx && attempts < maxAttempts && Date.now() < deadlineAt) {
          retriedOnce5xx = true;
          await sleep(Math.min(500, Math.max(0, deadlineAt - Date.now())));
          activeAc = null;
          if (clientGone || res.writableEnded || res.destroyed) {
            if (clientGone) recordClientAbort({ keyId: chosen.id });
            return;
          }
          continue;
        }
        activeAc = null;
        // L-b：错误体已排空、不再重试（将走外层 while 换 Key 或最终 502）——同 429
        // 持续限流分支，客户端若在排空后断开，需在此提前返回（外层唯一闸门在 while 顶部）。
        if (clientGone || res.writableEnded || res.destroyed) {
          if (clientGone) recordClientAbort({ keyId: chosen.id });
          return;
        }
        break;
      }

      // 其余状态（400/404/422...）：透传，不重试
      activeAc = null;
      lastStatus = upRes.status;
      lastErrorKind = "client";
      // L-b：错误体已排空、即将透传响应——sendJson 自带判空守卫，此处提前返回保持一致
      if (clientGone || res.writableEnded || res.destroyed) {
        if (clientGone) recordClientAbort({ keyId: chosen.id });
        return;
      }
      recordRequestEvent({ keyId: chosen.id, status: upRes.status, errorKind: "client" });
      const mapped = mapError(upRes.status, text);
      sendJson(res, mapped.status, mapped.body);
      return;
    }
  }

  if (clientGone || res.writableEnded || res.destroyed) {
    if (clientGone) recordClientAbort({ keyId: lastKeyId });
    return;
  }
  const wait = retryAfterSeconds(pool.nextRetryAfterMs());
  // 最终状态码如实反映失败类型：上游 5xx/网络错误 → 502（客户端 SDK 不应按限流退避），
  // 限流/池不可用 → 429（P2-2）
  const finalStatus = lastStatus >= 500 ? 502 : 429;
  const finalBody = lastBody
    ? (finalStatus === 429 ? { ...lastBody, retry_after: wait } : lastBody)
    : { error: { message: "All API keys unavailable", type: "rate_limit_error" }, retry_after: wait };
  recordRequestEvent({
    status: finalStatus,
    ok: false,
    errorKind: finalStatus === 429 ? "rate_limit" : (lastErrorKind || "upstream"),
  });
  sendJson(res, finalStatus, finalBody, { "Retry-After": String(wait) });
}
