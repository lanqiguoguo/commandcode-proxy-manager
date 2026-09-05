// ── 网关：clientToken 鉴权 + 主备选 Key + 429 退避/同 Key 重试 + 流式透传 ──
// 转发目标 = 管理器通过 HTTP 连接的上游代理：托管模式由管理器启动本地子进程，
// 外置模式连接 UPSTREAM_HOST:UPSTREAM_PORT；协议转换全部交给上游。
import { getConfig } from "./config.mjs";
import * as pool from "./keyPool.mjs";
import * as stats from "./stats.mjs";
import { safeEqual } from "./tokens.mjs";
import { randomUUID } from "crypto";
import { performance } from "node:perf_hooks";

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

// Upstream can use HTTP 401/403 for model entitlement failures as well as
// invalid credentials. Keep this list deliberately explicit: an unknown
// 401/403 remains an auth failure and still protects the key pool.
const MODEL_PLAN_ERROR_CODES = new Set([
  "MODEL_NOT_IN_PLAN",
  "MODEL_NOT_INCLUDED_IN_PLAN",
  "MODEL_NOT_SUPPORTED_BY_PLAN",
  "MODEL_NOT_AVAILABLE_ON_PLAN",
  "MODEL_NOT_IN_SUBSCRIPTION",
  "MODEL_NOT_INCLUDED_IN_SUBSCRIPTION",
  "MODEL_REQUIRES_SUBSCRIPTION",
  "MODEL_NOT_ENTITLED",
  "MODEL_ENTITLEMENT_REQUIRED",
  "MODEL_REQUIRES_UPGRADE",
  "MODEL_PLAN_REQUIRED",
  "PLAN_REQUIRED",
  "PLAN_REQUIRED_FOR_MODEL",
  "SUBSCRIPTION_REQUIRED_FOR_MODEL",
  "ENTITLEMENT_REQUIRED_FOR_MODEL",
]);

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

function normalizeErrorCode(value) {
  return typeof value === "string"
    ? value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")
    : "";
}

function parseUpstreamError(text) {
  let payload = null;
  try {
    const parsed = JSON.parse(typeof text === "string" ? text : "");
    if (isRecord(parsed)) payload = parsed;
  } catch {}
  const nested = isRecord(payload?.error) ? payload.error : null;
  const errorText = typeof payload?.error === "string" ? payload.error : "";
  return {
    payload,
    code: firstString(nested?.code, nested?.error_code, nested?.errorCode, payload?.code, payload?.error_code, payload?.errorCode),
    type: firstString(nested?.type, payload?.type),
    message: firstString(nested?.message, payload?.message, errorText),
  };
}

function hasModelPlanMarker(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const normalized = normalizeErrorCode(value);
  if (MODEL_PLAN_ERROR_CODES.has(normalized)) return true;
  if (/(?:^|[^A-Z0-9])MODEL(?:[_\s-]+)NOT(?:[_\s-]+)IN(?:[_\s-]+)PLAN(?:$|[^A-Z0-9])/i.test(value)) return true;
  return false;
}

// 纯凭证失败文本（manager 收到上游 401/403 时可能附带）。B-11 放宽只服务于
// plan/entitlement 语义明确的拒绝——若凭证标记且无任何套餐/授权语义词，直接按
// auth 处理（反例护栏优先于一切命中）。
const CREDENTIAL_FAILURE_PATTERN = /(?:invalid|incorrect|wrong|expired|revoked|missing|bad)\s+(?:api[ -]?key|key|token|credential|credentials)|invalid credentials|authentication failed|authentication error|unauthorized|not authorized|forbidden|access denied/i;
const PLAN_SEMANTIC_WORDS = /\b(?:plan|subscription|entitlement|upgrade|capability|tier)\b|\bnot entitled\b/i;

// 放行宽化的形态（无 model 宾语也命中）：entitlement 语义本身即授权拒绝信号。
// "not entitled" 措辞自带否定拒绝语义，单独成规；带 entitlement 词的句子需
// 匹配拒绝/失败动词（同 capability 组风格）。
const NOT_ENTITLED_PATTERN = /\bnot entitled\b/i;
const ENTITLEMENT_REJECTION_PATTERN = /\bentitlement\b/i;
const ENTITLEMENT_REJECTION_WORDS = /\b(?:denied|forbidden|failed|not enabled|not allowed|insufficient|check failed|error|required)\b/i;
const CAPABILITY_REJECTION_PATTERN = /\bcapability\b/i;
const CAPABILITY_REJECTION_WORDS = /\b(?:not enabled|not available|not included|not entitled|not allowed|not supported|requires?|upgrade)\b/i;
const TIER_REJECTION_PATTERN = /\btier\b/i;
const TIER_REJECTION_NEGATION = /\b(?:does not|doesn't|is not|isn't|cannot|can't|not)\b/i;
const TIER_REJECTION_WORDS = /\b(?:include|allow|support|entitle|enable|available|cover)\b/i;
const UPGRADE_REJECTION_PATTERN = /\bupgrade\b/i;
const UPGRADE_REJECTION_WORDS = /\b(?:required|requires?|needed|your plan|subscription)\b/i;

function isModelPlanMessage(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const text = value;

  // 反例护栏（B-11，优先）：凭证失败文本必须保持 auth。真正的凭证错误不带套餐/
  // 授权语义，而放宽各形态全部要求至少一个 plan/entitlement/capability/tier 语义词，
  // 因此"凭证标记 + 无套餐语义"在此直接短路。
  if (CREDENTIAL_FAILURE_PATTERN.test(text) && !PLAN_SEMANTIC_WORDS.test(text)) return false;

  // 语义二元：plan/subscription/entitlement/tier + 否定 + 拒绝/覆盖动词。
  // B-11 核心放宽：不再要求 model 宾语——"Your plan does not include this
  // capability"（折叠后 code 丢失、message 是唯一甄别字段）此前因此漏网误摘。
  if (PLAN_SEMANTIC_WORDS.test(text) &&
    /\b(?:does not|doesn't|is not|isn't|are not|aren't|cannot|can't|not|no longer)\b/i.test(text) &&
    /\b(?:include|allow|support|authorize|entitle|enable|available|cover|permit)\b/i.test(text)) return true;

  // capability / account-tier / entitlement / upgrade 无 model 宾语形态。
  if (NOT_ENTITLED_PATTERN.test(text)) return true;
  if (ENTITLEMENT_REJECTION_PATTERN.test(text) && ENTITLEMENT_REJECTION_WORDS.test(text)) return true;
  if (CAPABILITY_REJECTION_PATTERN.test(text) && CAPABILITY_REJECTION_WORDS.test(text)) return true;
  if (TIER_REJECTION_PATTERN.test(text) && TIER_REJECTION_NEGATION.test(text) && TIER_REJECTION_WORDS.test(text)) return true;
  if (UPGRADE_REJECTION_PATTERN.test(text) && UPGRADE_REJECTION_WORDS.test(text)) return true;

  // 既有结构形态兜底（历史命中不可回退）。
  return [
    /\bmodel\b[\s\S]{0,100}\b(?:not included|not available|not supported|not allowed|requires?)\b[\s\S]{0,100}\b(?:plan|subscription|entitlement|upgrade)\b/i,
    /\bmodel\b[\s\S]{0,80}\b(?:access|permission)\b[\s\S]{0,80}\b(?:denied|forbidden|not allowed|not authorized)\b[\s\S]{0,80}\b(?:plan|subscription|entitlement|upgrade)\b/i,
    /\b(?:plan|subscription|entitlement)\b[\s\S]{0,100}\b(?:does not|doesn't|cannot|can't|not)\b[\s\S]{0,100}\b(?:include|allow|support|authorize)\b[\s\S]{0,40}\bmodel\b/i,
  ].some((pattern) => pattern.test(text));
}

function redactUpstreamMessage(value) {
  return String(value || "")
    .slice(0, 200)
    .replace(/Bearer\s+[^\s,;)]+/gi, "Bearer [REDACTED]")
    .replace(/\buser_[A-Za-z0-9_-]+\b/g, "user_***")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");
}

function safeErrorToken(value) {
  if (typeof value !== "string") return "";
  const token = value.trim().slice(0, 128);
  return /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(token) ? token : "";
}

function preservedUpstreamError(parsed, text, status) {
  const body = { error: {} };
  const code = safeErrorToken(parsed.code);
  const type = safeErrorToken(parsed.type);
  const message = redactUpstreamMessage(parsed.message || (text || "").slice(0, 200));
  if (code) body.error.code = code;
  if (type) body.error.type = type;
  body.error.message = message || "Upstream error (" + status + ")";
  return body;
}

// B-2：上游（含 vendored proxy 的 CC_STATUS_MAP 映射层）已给出标准 OpenAI/Anthropic
// error type 时，出口保留该 type，避免真实语义（401 凭证失效/404 不存在等）被归一成
// 中性的 proxy_error 而让客户端 SDK 误判为"代理故障"。集合是白名单：上游可控文本
// 不得把任意 type 注入前端/SDK 语义。proxy_error 未列入（它是 manager 自己合成的
// 出口型），5xx 走下方分支维持 502/proxy_error，客户端 SDK 兼容不回退。
const KNOWN_UPSTREAM_TYPES = new Set([
  "authentication_error",
  "invalid_request_error",
  "not_found",
  "rate_limit_error",
  "upstream_error",
  "temporarily_unavailable",
  "auth_error",
  "invalid_api_key",
  "permission_error",
  "server_error",
  "overloaded_error",
  "api_error",
  "request_too_large",
]);

// Return a category after parsing only the structured error fields that the
// upstream contract uses. Model-plan errors are checked before status-only
// handling so a future 429/402 response cannot poison key health either.
export function classifyUpstreamError(status, text) {
  const parsed = parseUpstreamError(text);
  const modelPlan = [parsed.code, parsed.type, parsed.message].some(hasModelPlanMarker) || isModelPlanMessage(parsed.message);
  if (modelPlan) return { kind: "model_plan", parsed };
  if (status === 401 || status === 403) return { kind: "auth", parsed };
  if (status === 402 || status === 429) return { kind: "rate_limit", parsed };
  if (status >= 500) return { kind: "upstream", parsed };
  return { kind: "client", parsed };
}

// 下游出口的 retry_after（秒）：透传分支（第四表）要求把上游解析到的值原样带出，
// 不再回退到硬编码 30；调用方已按 parseRetryAfter 覆写 body，此处只保留显式入参
// 的默认值（429 分支 mapError 内建 30 秒默认，调用方无解析值时兜底）。
export function mapError(status, text, options = {}) {
  const parsed = options.parsed || parseUpstreamError(text);
  const message = redactUpstreamMessage(parsed.message || (text || "").slice(0, 200));
  const whitelistedType = safeErrorToken(parsed.type);
  if (options.preserveUpstream) {
    return { status, body: preservedUpstreamError(parsed, text, status) };
  }
  if (status === 402 || status === 429) {
    return { status: 429, body: { error: { message: message || "Rate limited", type: "rate_limit_error" }, retry_after: 30 } };
  }
  if (status >= 500) {
    return { status: 502, body: { error: { message: message || "Upstream error", type: "proxy_error" } } };
  }
  if (KNOWN_UPSTREAM_TYPES.has(whitelistedType)) {
    // 上游已给出标准 type（CC_STATUS_MAP/OpenAI/Anthropic 白名单内）→ 保留，message 已净化
    return { status, body: { error: { message: message || "Upstream error (" + status + ")", type: whitelistedType } } };
  }
  return { status, body: { error: { message: message || "Upstream error (" + status + ")", type: "proxy_error" } } };
}

// B-1：把上游流内错误终止帧解析为可记录的净化错误对象。入参是 SSE data 载荷解析后的
// 对象（openai 形态 `{error:{message,type},retry_after}` 或 anthropic 形态
// `{type:"error",error:{type,message},retry_after}`）。调用方保证 event.error 是 record；
// 仅允许字符串/有限数字字段，全部字段必须经 safeErrorToken/redactUpstreamMessage
// 白名单净化后方可落盘或透传。
function extractStreamUpstreamError(event) {
  const nested = event.error;
  const type = safeErrorToken(firstString(nested?.type));
  const message = redactUpstreamMessage(firstString(nested?.message, event.message));
  const rawRetry = nested?.retry_after ?? event.retry_after;
  const retryAfter = typeof rawRetry === "number" && Number.isFinite(rawRetry) && rawRetry >= 0 ? Math.floor(rawRetry) : undefined;
  const error = {};
  if (type) error.type = type;
  error.message = message || "Upstream stream error";
  if (retryAfter !== undefined) error.retry_after = retryAfter;
  if (retryAfter !== undefined) error.retryAfter = retryAfter;
  return error;
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
    upstreamError: null, // B-1：错误终止帧到达后置位；此后流只能结束
  };
}
// B-1 纯函数仅导出供 unit 级直接校验（不改任何生产路径）
export { newSseState, validateSsePayload, finishSseValidation };

function mergeUsage(current, next) {
  if (!next) return current;
  if (!current) return { ...next };
  current.inputTokens += next.inputTokens;
  current.outputTokens += next.outputTokens;
  current.cachedTokens += next.cachedTokens;
  return current;
}

function validateSsePayload(payload, state) {
  if (state.upstreamError) {
    // 错误终止帧之后的帧：只有结束帧允许到达（与 sawDone 同语义的流尾闸门）。
    // 真实上游在错误帧后最多补一条 [DONE]（个别收尾形态），其余 data 均为协议外内容。
    return payload.trim() === "[DONE]" && !state.sawDone && state.protocol === "openai"
      ? (state.sawDone = true, null)
      : "SSE data appeared after upstream error frame";
  }
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
    // B-1：OpenAI 错误终止帧——真实上游出口形态（upstream/proxy.mjs）为
    // data: {"error":{"message","type"},"retry_after"}（无 [DONE]）。判为合法终止帧：
    // 置位 state.upstreamError 并放行（帧内容随后经 writeChunk 自然到达客户端），
    // 连接以 res.end() 收尾而非 destroy。只有终态记录能区分"流内错误"与正常完成。
    if (isRecord(event.error)) {
      if (!state.sawChunk) return "upstream OpenAI SSE error frame before any chunk"; // 200 SSE 却从未开始 → 仍判损坏
      state.upstreamError = extractStreamUpstreamError(event);
      return null;
    }
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
      // B-1：Anthropic 错误终止帧（upstream/proxy.mjs case 'error' 后不再有
      // message_delta/message_stop）。真实错误（message_start 已到、帧含 error 对象）→
      // 置位并放行（内容已写出）；错误帧出现在 message_start 之前则仍判损坏——
      // 那属于"200 SSE 却从未开始"的异常形态（上游正常路径会先发 message_start）。
      if (state.messageStarted && isRecord(event.error)) {
        state.upstreamError = extractStreamUpstreamError(event);
        return null;
      }
      return "upstream Anthropic SSE reported an error";
    default:
      return "unknown or unsupported Anthropic SSE event";
  }
}

function finishSseValidation(state) {
  if (state.frameLines.length > 0) return "upstream SSE ended with an incomplete event frame";
  if (state.upstreamError) return null; // B-1：错误终止帧 = 合法结束（无需 [DONE]/message_stop）
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

// 返回 { body, usage, err, reason?, upstreamError }：err = null（正常完成，可能带
// upstreamError 表示流以错误终止帧合法结束）| "client"（客户端断开）|
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
  // B-1：finish 校验通过时若流以错误终止帧收尾（客户端已收到该帧内容与干净 EOF），
  // 错误摘要随返回值带回给 handleGateway，用于区分"流内错误"与纯成功的记录端语义。
  return { usage: state.usage, err: null, upstreamError: state.upstreamError || null };
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
  const startedMono = performance.now();
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
    reason,          // B-1：错误终止帧的净化摘要（仅 stream_error 终态携带）
    inputTokens,
    outputTokens,
    cachedTokens,
  } = {}) => {
    if (requestEventRecorded) return;
    requestEventRecorded = true;
    const elapsedMs = performance.now() - startedMono;
    stats.appendEvent({
      eventType: stats.EVENT_TYPE_REQUEST,
      requestId,
      keyId: keyId || undefined,
      model,
      stream: eventStream,
      ok,
      status,
      errorKind: ok ? undefined : errorKind,
      reason,
      inputTokens,
      outputTokens,
      cachedTokens,
      attempts,
      retries: Math.max(0, attempts - 1),
      attemptedKeyIds: attemptedKeyIds.length ? [...attemptedKeyIds] : undefined,
      latencyMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : 0,
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
        // B-3：按池状态分类文案与 Retry-After——空池/全 disabled/全 authError 都不是
        // "all backed off / quota limited"，且 authError 需人工 clear-auth（≥1h），
        // Retry-After:0 的"立即可重试"承诺失实。这三类无自动恢复路径：不发
        // retry_after/Retry-After（sendJson 仅在 body 携带 retry_after 时才补头），
        // 客户端按普通 429 处理且不会被 0 诱导立即重试。真退避/限额混合保持
        // 原文案并返回真实等待（全部立即恢复时为 0，语义不变）。
        const reason = pool.poolUnavailableReason();
        const noRetry = reason && (reason.kind === "empty" || reason.kind === "disabled" || reason.kind === "auth");
        let body = null;
        if (noRetry) {
          const message = reason.kind === "empty"
            ? "No API keys configured in pool (add keys via admin UI)"
            : reason.kind === "disabled"
              ? "All API keys are disabled (enable via admin UI)"
              : "All API keys require manual auth recovery (clear auth via admin UI)";
          body = { error: { message, type: "rate_limit_error" } };
        } else {
          const wait = reason && reason.kind === "backoff" ? reason.waitMs : pool.nextRetryAfterMs();
          body = {
            error: { message: "No usable API key in pool (all backed off / quota limited)", type: "rate_limit_error" },
            retry_after: retryAfterSeconds(wait)
          };
        }
        sendJson(res, 429, body);
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
      // 等待上游响应头的超时：connectTimeoutMs 默认 120s（上游非流式 90s / 流式 30s 自身超时
      // 会先返回 JSON，网关侧纯兜底），不能用 30s 总预算压缩单次等待——否则合法的慢生成会被误杀。
      // 声明在 try 之外：catch 分支（超时文案）也需要读取该阈值（const 块级作用域不跨 try/catch）。
      const perAttemptMs = poolCfg.connectTimeoutMs ?? 120000;
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
          // B-2（第四表）：附真实等待阈值（perAttemptMs = connectTimeoutMs 配置值），
          // 不再笼统说 "connect timeout"——慢生成/CC 长尾与网络不可达可被运维区分。
          lastBody = { error: { message: "Upstream did not respond within " + Math.round(perAttemptMs / 1000) + "s", type: "proxy_error" } };
          // 超时退避后换 Key：外层 while 顶部的截止检查会决定是否继续发起新尝试，
          // 预算耗尽时此处 break 即进入最终响应路径（502）。
          break;
        }
        lastStatus = 502;
        lastErrorKind = "upstream";
        // B-2（第四表）：fetch 抛错时附底层网络码（quota.mjs 同型读取 e.cause.code）；
        // e.cause 可能缺 code（TLS/undici 包装错），兜底 "network"。
        lastBody = { error: { message: "Upstream unreachable: fetch failed (" + (e.cause?.code || "network") + ")", type: "proxy_error" } };
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
        let pipeUpstreamError = null;
        let responseBody = null;
        try {
          const result = await pipeBody(upRes, res, isStream, isClientGone, protocol);
          usage = result.usage;
          pipeErr = result.err;
          pipeReason = result.reason || "";
          pipeUpstreamError = result.upstreamError || null;
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
            // B-2（第四表）：读体中途 socket 死亡（err=upstream）与格式损坏（err=invalid）
            // 分离文案——invalid 路径 pipeReason 恒非空，可精确区分，不会误伤格式错误。
            const broken = pipeErr === "upstream" && pipeReason === "";
            sendJson(res, 502, {
              error: { message: broken ? "Upstream connection lost while reading response" : (pipeReason || "Invalid response from upstream"), type: "proxy_error" }
            });
          }
          return;
        }
        if (pipeUpstreamError) {
          // B-1：连接层成功（客户端已收到 200 + 错误尾帧 + 干净 EOF），不按 502 记。
          // 记录端 status 保持 200 且 ok:false，用独立 errorKind 区分"流内上游错误"与
          // 纯成功/断流——history 页 UI 对该组合渲染不变（badge/筛选按 status 工作）。
          recordRequestEvent({
            keyId: chosen.id, stream: isStream, ok: false, status: 200,
            errorKind: "stream_error",
            reason: (pipeUpstreamError.message || "upstream stream error").slice(0, 200),
            inputTokens: usage ? usage.inputTokens : undefined,
            outputTokens: usage ? usage.outputTokens : undefined,
            cachedTokens: usage ? usage.cachedTokens : undefined,
          });
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
      const classification = classifyUpstreamError(upRes.status, text);

      if (classification.kind === "model_plan") {
        if (clientGone) {
          activeAc = null;
          recordClientAbort({ keyId: chosen.id });
          return;
        }
        activeAc = null;
        lastStatus = upRes.status;
        lastErrorKind = "client";
        // Model entitlement is a request-level failure. Do not clear a
        // concurrent health state or add an auth/rate-limit penalty.
        if (clientGone || res.writableEnded || res.destroyed) {
          if (clientGone) recordClientAbort({ keyId: chosen.id });
          return;
        }
        recordRequestEvent({ keyId: chosen.id, status: upRes.status, errorKind: "client" });
        const mapped = mapError(upRes.status, text, { parsed: classification.parsed, preserveUpstream: true });
        sendJson(res, mapped.status, mapped.body);
        return;
      }

      if (classification.kind === "auth") {
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
        // B-2（第四表）：Retry-After 原样透传——parseRetryAfter 同时解析响应头与
        // body.retry_after（parseRetryAfter 的 header 优先，mock/真实上游 429 均以
        // body.retry_after 下发），不再落入 mapError 内建的 30 硬编码。
        // Retry-After 为 0 表示"立即重试"，必须保留 0。
        // 注意：mapped.body.retry_after 仍是 mapError 默认的 30，下面的覆写仅在
        // parseRetryAfter 既没解析到 header 也没解析到 body 时兜底使用（行为不变）。
        mapped.body.retry_after = retryAfterMs !== null
          ? Math.ceil(retryAfterMs / 1000)
          : (mapped.body.retry_after !== undefined ? mapped.body.retry_after : 30);
        lastBody = mapped.body;
        // B-4：零输出不再同 Key 重试——确定性零输出对同一 Key 连打多次是纯成本放大
        // （DESIGN 原"零输出触发有界同 Key 重试"设计废弃，见 DESIGN.md §7.1）。
        // 零输出立即退避（zeroOutputCountsAs429=true 时）并换 Key：有备 Key 则下一次
        // 尝试走外层 while 的新 Key，无备 Key 则收尾出口 body.retry_after 保持上游
        // 的 10s 语义。同 Key 重试仅保留给带真实短 retry_after（≤sameKeyRetryMaxWaitMs）
        // 的 429——此时上游明确要求客户端稍后重试同 Key。
        const retryable = !zeroOut && sameKeyTries < sameKeyMax && attempts < maxAttempts &&
          (retryAfterMs !== null && retryAfterMs <= (poolCfg.sameKeyRetryMaxWaitMs ?? 5000));
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
