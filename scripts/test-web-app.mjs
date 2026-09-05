import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const APP_SOURCE = readFileSync(new URL("../web/app.mjs", import.meta.url), "utf8");

class Deferred {
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class TimerHarness {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  setTimeout = (fn, delay = 0) => {
    const timer = { id: this.nextId++, kind: "timeout", at: this.now + Number(delay), delay: Number(delay), fn };
    this.timers.set(timer.id, timer);
    return timer;
  };

  clearTimeout = (timer) => {
    if (timer) this.timers.delete(timer.id);
  };

  setInterval = (fn, delay = 0) => {
    const timer = { id: this.nextId++, kind: "interval", at: this.now + Number(delay), delay: Number(delay), fn,
      unref() {} };
    this.timers.set(timer.id, timer);
    return timer;
  };

  clearInterval = (timer) => {
    if (timer) this.timers.delete(timer.id);
  };

  pendingTimeouts() {
    return [...this.timers.values()].filter((timer) => timer.kind === "timeout");
  }

  async advance(ms) {
    const target = this.now + ms;
    while (true) {
      const due = [...this.timers.values()]
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.now = due.at;
      if (due.kind === "timeout") this.timers.delete(due.id);
      else due.at += due.delay;
      due.fn();
      await flush();
    }
    this.now = target;
    await flush();
  }
}

class FakeElement {
  constructor(document, tagName, id) {
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.id = id || "";
    this.value = "";
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.innerHTML = "";
    this.textContent = "";
    this.className = "";
    this.title = "";
    this.dataset = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.listeners = new Map();
    this.classList = {
      toggle: (name, enabled) => {
        const parts = new Set(this.className.split(/\s+/).filter(Boolean));
        if (enabled) parts.add(name); else parts.delete(name);
        this.className = [...parts].join(" ");
      }
    };
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatchEvent(event) {
    const next = event || {};
    if (!next.type) throw new Error("event type is required");
    if (!next.target) next.target = this;
    for (const listener of this.listeners.get(next.type) || []) listener(next);
    this.ownerDocument.dispatchEvent(next);
    return true;
  }

  click() {
    return this.dispatchEvent({ type: "click", target: this });
  }

  closest(selector) {
    if (selector === "[data-act]" && this.dataset.act) return this;
    if (selector === "details[data-usage]" && this.dataset.usage) return this;
    return null;
  }
}

class FakeDocument {
  constructor() {
    this.hidden = false;
    this.listeners = new Map();
    this.elements = new Map();
    this.dynamicIds = new Set();
    this.app = this.addElement("main", "app");
    Object.defineProperty(this.app, "innerHTML", {
      configurable: true,
      get: () => this.app._innerHTML || "",
      set: (html) => this.setAppHtml(html)
    });
    this.addElement("header", "topbar");
    this.addElement("span", "tick");
    this.addElement("span", "sse-status");
    this.addElement("button", "btn-sse-reconnect");
    this.addElement("button", "btn-logout");
    this.navButtons = ["dashboard", "keys", "history", "settings", "logs"].map((view) => {
      const button = new FakeElement(this, "button", "");
      button.dataset.view = view;
      return button;
    });
  }

  addElement(tagName, id, dynamic = false) {
    const element = new FakeElement(this, tagName, id);
    this.elements.set(id, element);
    if (dynamic) this.dynamicIds.add(id);
    return element;
  }

  getElementById(id) {
    return this.elements.get(id) || null;
  }

  querySelectorAll(selector) {
    if (selector === "nav button") return this.navButtons;
    return [];
  }

  createElement(tagName) {
    return new FakeElement(this, tagName, "");
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    return true;
  }

  setAppHtml(html) {
    for (const id of this.dynamicIds) this.elements.delete(id);
    this.dynamicIds.clear();
    this.app._innerHTML = String(html);
    // 捕获 id、type、checked 等属性：savePool 按 el.type === "number" 分支，
    // 复选框按 checked 状态提交，都需要元素自带属性（真实 DOM 语义）。
    const idPattern = /<([a-zA-Z][\w-]*)\b([^>]*?)\bid=["']([^"']+)["']([^>]*)>/g;
    let match;
    while ((match = idPattern.exec(this.app._innerHTML))) {
      const [, tagName, prefixAttrs, id, suffixAttrs] = match;
      const attrs = prefixAttrs + " " + suffixAttrs;
      const element = this.addElement(tagName, id, true);
      const typeMatch = /type=["']([^"']+)["']/.exec(attrs);
      if (typeMatch) element.type = typeMatch[1];
      element.checked = /\bchecked(?:\s|["'=]|$)/.test(attrs);
    }
  }
}

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.closed = false;
    this.closeCount = 0;
    this.listeners = new Map();
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close() {
    this.closed = true;
    this.closeCount++;
  }

  emit(type, data, extra = {}) {
    const event = { type, data: typeof data === "string" ? data : JSON.stringify(data), ...extra };
    if (type === "open") {
      if (this.onopen) this.onopen(event);
      return;
    }
    if (type === "error") {
      if (this.onerror) this.onerror(event);
      return;
    }
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  listenerCount(type) {
    return (this.listeners.get(type) || []).length;
  }
}

function response(status, body = {}) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function historyItem(model, overrides = {}) {
  return { ts: 1725400000000, keyId: "key-1", model, stream: false, ok: true, status: 200,
    inputTokens: 1, outputTokens: 2, cachedTokens: 0, retries: 0, latencyMs: 4,
    eventType: "request", requestId: model + "-request", ...overrides };
}

// 慢响应注入：fetch 命中队列条目后挂起，直到测试调用 entry.resolve() 才落地。
// 用于 B-9（在途 refresh 被 SSE 作废）等时序断言。
function makeSlow(factory) {
  const entry = { factory };
  entry.promise = new Promise((resolve) => { entry.resolve = resolve; });
  return entry;
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function createHarness({ token = "token-a", hash = "#/history", keys = [], pool = null, sessionEntries = [] } = {}) {
  const document = new FakeDocument();
  const timers = new TimerHarness();
  const session = new Map(token ? [["ccpm_token", token]] : []);
  for (const [k, v] of sessionEntries) session.set(k, v);
  const location = {
    hash,
    reloaded: false,
    reload() { this.reloaded = true; }
  };
  const historyRequests = [];
  const poolProbeResponses = [];
  const fetchCalls = [];
  const csvBlobs = [];
  const alerts = [];
  let poolData = pool || { counts: {}, stats: {}, poolCfg: {} };
  const slowQueues = { keys: [], pool: [] };
  let keysGetOverride = null; // 401 等 keys GET 响应覆写（走 api()，触发会话过期路径）
  const overrideKeysGet = (status, body) => { keysGetOverride = { status, body }; };
  // 动态池配置：savePool 成功回读 poolCfg 后，后续 /admin/api/pool GET 返回新值
  const setPoolData = (data) => { poolData = data; };
  // Key 变更类请求（POST /keys、PUT/DELETE /keys/:id）的响应队列（shift 取用）；
  // 空队列时按成功语义回 200。B-7/B-10 用失败/延迟语义驱动。
  const mutationResponses = [];
  const enqueueMutation = (status, body) => { mutationResponses.push({ status, body }); };
  class CaptureBlob extends Blob {
    static instances = [];
    constructor(parts, options) {
      super(parts, options);
      csvBlobs.push(this);
      CaptureBlob.instances.push(this);
    }
  }
  const slowFactory = (queue) => {
    const entry = queue.shift();
    if (!entry) return null;
    // 挂起直到测试主动落地；落地结果为 entry.factory() 产物
    return entry.promise.then(() => Promise.resolve(entry.factory()));
  };
  const fetch = (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (String(url).startsWith("/admin/api/keys")) {
      // 形如 /admin/api/keys/<id> 的写操作（PUT/DELETE）与 /admin/api/keys 的 POST
      const isWrite = options.method === "POST" || options.method === "PUT" || options.method === "DELETE";
      const slow = slowFactory(slowQueues.keys);
      if (slow) return slow;
      if (isWrite && mutationResponses.length) {
        const mr = mutationResponses.shift();
        return Promise.resolve(mr.status === 204 ? { status: 204, ok: true, json: async () => null }
          : response(mr.status, mr.body || { error: { message: "mock error" } }));
      }
      if (isWrite) return Promise.resolve(response(200, { ok: true }));
      if (keysGetOverride) return Promise.resolve(response(keysGetOverride.status, keysGetOverride.body));
      return Promise.resolve(response(200, { keys }));
    }
    if (String(url).startsWith("/admin/api/pool")) {
      if (options.cache === "no-store") {
        const result = poolProbeResponses.shift() || response(200, {});
        return Promise.resolve(result);
      }
      const slow = slowFactory(slowQueues.pool);
      if (slow) return slow;
      return Promise.resolve(response(200, poolData));
    }
    if (String(url).startsWith("/admin/api/history")) {
      const deferred = new Deferred();
      const request = { url: String(url), options, deferred };
      historyRequests.push(request);
      if (historyRequests.length === 4 && options.signal) {
        options.signal.addEventListener("abort", () => {
          const error = new Error("request aborted");
          error.name = "AbortError";
          deferred.reject(error);
        }, { once: true });
      }
      return deferred.promise;
    }
    if (String(url).startsWith("/admin/api/logs")) {
      return Promise.resolve(response(200, { logs: [] }));
    }
    if (String(url) === "/admin/api/login") {
      return Promise.resolve(response(200, { ok: true }));
    }
    if (String(url) === "/admin/api/logout") {
      return Promise.resolve(response(204));
    }
    throw new Error("unexpected fetch: " + url);
  };
  const windowListeners = new Map();

  const sandbox = {
    window: null,
    document,
    location,
    sessionStorage: {
      getItem(key) { return session.has(key) ? session.get(key) : null; },
      setItem(key, value) { session.set(key, String(value)); },
      removeItem(key) { session.delete(key); }
    },
    fetch,
    EventSource: FakeEventSource,
    URLSearchParams,
    AbortController,
    Blob: CaptureBlob,
    URL,
    Date,
    JSON,
    console: { error() {}, log() {} },
    alert(message) { alerts.push(String(message == null ? "" : message)); },
    confirm() { return true; },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (type, listener) => {
    const list = windowListeners.get(type) || [];
    list.push(listener);
    windowListeners.set(type, list);
  };
  sandbox.dispatchEvent = (event) => {
    for (const listener of windowListeners.get(event.type) || []) listener(event);
    return true;
  };
  FakeEventSource.instances = [];
  vm.runInNewContext(APP_SOURCE, sandbox, { filename: "web/app.mjs" });

  return {
    sandbox,
    document,
    location,
    timers,
    historyRequests,
    poolProbeResponses,
    fetchCalls,
    csvBlobs,
    session,
    alerts,
    setPoolData,
    enqueueMutation,
    overrideKeysGet,
    slowQueues,
    async ready() { await flush(); await flush(); },
    async resolveHistory(index, model, page = 1, total = 100, overrides = {}) {
      historyRequests[index].deferred.resolve(response(200, { items: [historyItem(model, overrides)], total, page }));
      await flush();
    },
    async rejectHistory(index, error) {
      historyRequests[index].deferred.reject(error);
      await flush();
    },
    async emitNetworkFailure(source) {
      poolProbeResponses.push(response(200, {}));
      source.emit("error");
      await flush();
    },
    async emitAuthFailure(source) {
      poolProbeResponses.push(response(401, { error: "unauthorized" }));
      source.emit("error");
      await flush();
    }
  };
}

async function testHistoryRequestSequence() {
  const harness = createHarness();
  await harness.ready();
  assert.equal(harness.historyRequests.length, 1, "initial history request starts once");
  await harness.resolveHistory(0, "initial-page-1");

  const status = harness.document.getElementById("h-status");
  const search = harness.document.getElementById("h-search");
  status.value = "200";
  search.click();
  await flush();
  assert.equal(harness.historyRequests.length, 2, "filter change starts a new history request");

  harness.document.getElementById("h-status").value = "429";
  harness.document.getElementById("h-search").click();
  await flush();
  assert.equal(harness.historyRequests.length, 3, "rapid second filter change starts a third request");
  assert.equal(harness.historyRequests[1].options.signal.aborted, true, "intermediate request is aborted");

  await harness.resolveHistory(1, "stale-filter-response", 1, 100);
  assert.equal(harness.document.app.innerHTML.includes("stale-filter-response"), false, "late stale response cannot overwrite current filter");
  await harness.resolveHistory(2, "current-filter-response", 1, 100);
  assert.equal(harness.document.app.innerHTML.includes("current-filter-response"), true, "latest filter response is rendered");
  assert.equal(harness.document.getElementById("h-status").value, "429", "latest filter remains selected");

  harness.document.getElementById("h-next").click();
  await flush();
  assert.equal(harness.historyRequests.length, 4, "pagination starts a new request");
  harness.location.hash = "#/dashboard";
  harness.sandbox.window.dispatchEvent({ type: "hashchange" });
  await harness.resolveHistory(3, "stale-after-hash-change", 2, 100);
  assert.equal(harness.document.app.innerHTML.includes("stale-after-hash-change"), false, "hash change invalidates in-flight history response");
  assert.equal(harness.document.app.innerHTML.includes("总览"), true, "hash change renders the current view");

  harness.location.hash = "#/history";
  harness.sandbox.window.dispatchEvent({ type: "hashchange" });
  await flush();
  assert.equal(harness.historyRequests.length, 5, "returning to history starts a fresh request");
  await harness.rejectHistory(4, new Error("history unavailable"));
  assert.equal(harness.document.app.innerHTML.includes("历史记录加载失败：history unavailable"), true, "current history errors are observable");
}

async function testHistoryCacheRateFormatting() {
  const cases = [
    { inputTokens: 5, outputTokens: 7, cachedTokens: 1, expected: "5 / 7 / 1 / 20.00%" },
    { inputTokens: 3, outputTokens: 4, cachedTokens: 2, expected: "3 / 4 / 2 / 66.67%" },
    { inputTokens: 0, outputTokens: 0, cachedTokens: 0, expected: "0 / 0 / 0 / 0.00%" },
    { inputTokens: 1, outputTokens: 0, cachedTokens: 2, expected: "1 / 0 / 2 / 200.00%" }
  ];
  for (const [index, fixture] of cases.entries()) {
    const harness = createHarness();
    await harness.ready();
    await harness.resolveHistory(0, "cache-rate-" + index, 1, 1, fixture);
    const html = harness.document.app.innerHTML;
    assert.equal(html.includes("<th>入/出/缓存/缓存率</th>"), true, "history header includes cache rate");
    assert.equal(html.includes(fixture.expected), true, "history row formats cache rate " + fixture.expected);
  }

  for (const [index, fixture] of [
    { inputTokens: undefined, cachedTokens: undefined },
    { inputTokens: NaN, cachedTokens: Infinity }
  ].entries()) {
    const harness = createHarness();
    await harness.ready();
    await harness.resolveHistory(0, "missing-cache-rate-" + index, 1, 1, fixture);
    const html = harness.document.app.innerHTML;
    assert.equal(html.includes(" / 2 / - / -"), true, "missing or non-finite cache data displays dashes");
    assert.equal(/(?:NaN|Infinity|undefined)%/.test(html), false, "invalid cache rates never reach history HTML");
  }
}

async function testCsvUsesExternalRequestRows() {
  const harness = createHarness();
  await harness.ready();
  await harness.resolveHistory(0, "initial-page-1");
  harness.document.getElementById("h-csv").click();
  await flush();
  assert.equal(harness.historyRequests.length, 2, "CSV export fetches the filtered history source");
  await harness.resolveHistory(1, "csv-request-row", 1, 1, { inputTokens: 5, outputTokens: 7, cachedTokens: 1 });
  assert.equal(harness.csvBlobs.length, 1, "CSV export creates one document");
  const csv = await harness.csvBlobs[0].text();
  const [header, row] = csv.split("\n");
  const expectedHeader = ["时间", "Key", "模型", "流式", "状态", "错误", "入tok", "出tok", "缓存tok", "缓存率", "重试", "延迟ms"];
  assert.deepEqual(header.split(","), expectedHeader, "CSV header preserves order and adds cache rate");
  assert.equal(csv.split("\n").length, 2, "one external request produces one CSV data row");
  assert.equal(row.split(",").length, expectedHeader.length, "CSV row has the same column count as its header");
  assert.equal(csv.includes("csv-request-row"), true, "CSV contains the returned request row");
  assert.equal(row.split(",")[9], '"20.00%"', "CSV uses the same cache rate formatting as history HTML");
}

function dashboardKey(totals = {}) {
  return {
    id: "dashboard-key",
    alias: "主账号",
    maskedKey: "user_5***XYoU",
    priority: 0,
    enabled: true,
    health: {},
    quota: {
      updatedAt: 1725400000000,
      totals: { runs: 8, tokens: 64, ...totals }
    },
    usage: {
      h5: { requests: 0, input: 0, output: 0 },
      d7: { requests: 0, input: 0, output: 0, err429: 0, errOther: 0 },
      d30: { requests: 0 },
      d30Valid: true
    }
  };
}

async function dashboardHtml(totals = {}) {
  const harness = createHarness({
    hash: "#/dashboard",
    keys: [dashboardKey(totals)],
    pool: { counts: { enabled: 1 }, stats: { requests: 81, success: 80 }, poolCfg: {} }
  });
  await harness.ready();
  return harness.document.app.innerHTML;
}

async function testDashboardSuccessRateFormatting() {
  for (const [value, expected] of [[98.765, "98.77%"], [100, "100.00%"], [0, "0.00%"]]) {
    const html = await dashboardHtml({ successRate: value });
    assert.equal(html.includes('<div class="ms-v mono">' + expected + "</div>"), true, "Key card renders success rate " + expected);
    assert.equal(html.includes('<div class="stat"><div class="v">99%</div><div class="k">成功率</div></div>'), true, "top overview success rate remains an integer");
  }

  const missingHtml = await dashboardHtml();
  assert.equal(missingHtml.includes('<div class="ms-k">成功率</div>'), false, "missing Key success rate is not rendered");
  assert.equal(/(?:NaN|Infinity|undefined)%/.test(missingHtml), false, "missing success rate never reaches dashboard HTML");

  for (const value of [NaN, Infinity, "not-a-number"]) {
    const html = await dashboardHtml({ successRate: value });
    assert.equal(html.includes('<div class="ms-k">成功率</div>'), false, "invalid Key success rate is not rendered");
    assert.equal(/(?:NaN|Infinity|undefined)%/.test(html), false, "invalid success rate never reaches dashboard HTML");
  }
}

async function testSseStateMachine() {
  const harness = createHarness({ hash: "#/dashboard" });
  await harness.ready();
  assert.equal(FakeEventSource.instances.length, 1, "one EventSource is created initially");
  let source = FakeEventSource.instances[0];
  assert.equal(source.listenerCount("log"), 1, "log listener is registered once");
  assert.equal(source.listenerCount("quota"), 1, "quota listener is registered once");
  assert.equal(source.listenerCount("stats"), 1, "stats listener is registered once");
  assert.equal(source.listenerCount("quota-status"), 1, "quota-status listener is registered once");
  source.emit("open");
  assert.equal(harness.document.getElementById("sse-status").textContent, "实时已连接", "open reports connected");

  const delays = [];
  for (const expected of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    await harness.emitNetworkFailure(source);
    const retryTimer = harness.timers.pendingTimeouts().find((timer) => timer.delay >= 1000);
    assert.ok(retryTimer, "network failure schedules one retry timer");
    delays.push(retryTimer.delay);
    assert.equal(retryTimer.delay, expected, "retry delay follows bounded exponential backoff");
    await harness.timers.advance(expected);
    assert.equal(FakeEventSource.instances.length, delays.length + 1, "one new EventSource is created per retry");
    source = FakeEventSource.instances.at(-1);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000], "backoff is capped at 30 seconds");
  source.emit("open");
  await harness.emitNetworkFailure(source);
  const resetTimer = harness.timers.pendingTimeouts().find((timer) => timer.delay >= 1000);
  assert.equal(resetTimer.delay, 1000, "successful recovery resets the retry sequence");
  await harness.timers.advance(1000);
  source = FakeEventSource.instances.at(-1);
  source.emit("open");

  await harness.emitAuthFailure(source);
  assert.equal(source.closed, true, "401 closes the failed EventSource");
  assert.equal(harness.timers.pendingTimeouts().some((timer) => timer.delay >= 1000), false, "401 does not schedule network retries");
  assert.equal(harness.document.getElementById("sse-status").textContent, "实时连接已停止：鉴权失败", "401 is observable as permanent auth failure");
  const reconnect = harness.document.getElementById("btn-sse-reconnect");
  assert.equal(reconnect.hidden, false, "permanent failure exposes a manual recovery button");
  assert.equal(reconnect.textContent, "重新登录", "auth-failed button reads 重新登录 (cookie 通道再重连必然 401，C-16)");
  const beforeRecovery = FakeEventSource.instances.length;
  reconnect.click();
  assert.equal(FakeEventSource.instances.length, beforeRecovery, "auth-failed recovery does not create a doomed EventSource");
  assert.equal(harness.session.has("ccpm_token"), false, "auth-failed recovery clears the session token");
  assert.equal(harness.document.getElementById("login-token") !== null, true, "auth-failed recovery returns to the login page");
  assert.equal(harness.location.reloaded, false, "auth-failed recovery clears in-memory session without a full page reload");

  // 重新登录后可恢复实时连接（登录后会话 cookie 已重建，重连才可能成功）
  harness.document.getElementById("login-token").value = "token-a";
  harness.document.getElementById("btn-login").click();
  await harness.ready();
  const reloginSource = FakeEventSource.instances.at(-1);
  assert.equal(reloginSource.listenerCount("log"), 1, "relogin source has one log listener");
  reloginSource.emit("open");
  assert.equal(harness.document.getElementById("sse-status").textContent, "实时已连接", "manual recovery can reconnect");

  const beforeHidden = FakeEventSource.instances.length;
  harness.document.hidden = true;
  harness.document.dispatchEvent({ type: "visibilitychange" });
  assert.equal(reloginSource.closed, true, "hidden page closes the active EventSource");
  assert.equal(harness.timers.pendingTimeouts().length, 0, "hidden page leaves no retry timer");
  assert.equal(harness.document.getElementById("sse-status").textContent, "实时连接已暂停（页面隐藏）", "hidden state is observable");
  reloginSource.emit("log", { ts: 2, msg: "stale event" });
  assert.equal(harness.document.app.innerHTML.includes("stale event"), false, "closed source cannot write stale UI state");

  harness.document.hidden = false;
  harness.document.dispatchEvent({ type: "visibilitychange" });
  assert.equal(FakeEventSource.instances.length, beforeHidden + 1, "visible recovery creates one source");
  harness.document.dispatchEvent({ type: "visibilitychange" });
  assert.equal(FakeEventSource.instances.length, beforeHidden + 1, "repeated visibility events do not duplicate sources");
  const visibleSource = FakeEventSource.instances.at(-1);
  assert.equal(visibleSource.listenerCount("log"), 1, "visibility recovery keeps one listener set");
  visibleSource.emit("open");
}

async function testSessionCleanup() {
  const harness = createHarness({ hash: "#/dashboard" });
  await harness.ready();
  const source = FakeEventSource.instances[0];
  source.emit("open");
  harness.document.getElementById("btn-logout").click();
  await flush();
  assert.equal(source.closed, true, "logout closes the old EventSource");
  assert.equal(harness.timers.pendingTimeouts().length, 0, "logout clears retry timers");
  assert.equal(harness.session.has("ccpm_token"), false, "logout clears the session token");
  assert.equal(harness.location.reloaded, true, "logout requests a clean page reload");
}

async function testLoginStartsSingleton() {
  const harness = createHarness({ token: "", hash: "#/dashboard" });
  await harness.ready();
  assert.equal(FakeEventSource.instances.length, 0, "anonymous page does not open SSE");
  const input = harness.document.getElementById("login-token");
  input.value = "token-b";
  harness.document.getElementById("btn-login").click();
  await harness.ready();
  assert.equal(harness.session.get("ccpm_token"), "token-b", "login stores the new token");
  assert.equal(FakeEventSource.instances.length, 1, "login opens exactly one SSE source");
  const source = FakeEventSource.instances[0];
  assert.equal(source.listenerCount("log"), 1, "login source has no duplicate log listeners");
  source.emit("open");
  assert.equal(harness.document.getElementById("sse-status").textContent, "实时已连接", "logged-in source becomes connected");
}

// ── B-7：toggle/删除/移动失败必须可见（alert）且不留 unhandled rejection ──
function keysHarness(keys) {
  const harness = createHarness({
    hash: "#/keys",
    keys: keys.map((k) => ({
      id: k.id, alias: k.alias || "主账号", maskedKey: "user_****", priority: k.priority ?? 0,
      enabled: k.enabled !== false, note: "", health: {}, quota: null, usage: {}
    }))
  });
  return harness;
}
async function testKeyMutationFailureFeedback() {
  // 通过事件委托点击：构造带 data-act 的按钮并派发 click（document 捕获委托）
  const clickAct = (doc, act, id) => {
    const synthetic = new FakeElement(doc, "button", "");
    synthetic.dataset.act = act;
    synthetic.dataset.id = id;
    synthetic.click();
  };
  {
    const harness = keysHarness([{ id: "k_alpha" }, { id: "k_beta", priority: 1 }]);
    await harness.ready();
    harness.enqueueMutation(400, { error: { message: "Key 不存在" } });
    const beforeAlerts = harness.alerts.length;
    clickAct(harness.document, "toggle", "k_alpha");
    await harness.ready();
    assert.equal(harness.alerts.length, beforeAlerts + 1, "toggle failure surfaces an alert");
    assert.ok(String(harness.alerts.at(-1)).includes("Key 不存在"), "alert carries the backend error message");
  }
  {
    const harness = keysHarness([{ id: "k_alpha" }]);
    await harness.ready();
    harness.enqueueMutation(400, { error: { message: "Key 不存在" } });
    const beforeAlerts = harness.alerts.length;
    clickAct(harness.document, "delete", "k_alpha");
    await harness.ready();
    assert.equal(harness.alerts.length, beforeAlerts + 1, "delete failure surfaces an alert");
  }
  {
    const harness = keysHarness([{ id: "k_alpha" }, { id: "k_beta", priority: 1 }]);
    await harness.ready();
    harness.enqueueMutation(503, { error: { message: "健康状态未完成 durable flush" } });
    const beforeAlerts = harness.alerts.length;
    clickAct(harness.document, "move-down", "k_alpha");
    await harness.ready();
    assert.equal(harness.alerts.length, beforeAlerts + 1, "move failure surfaces an alert");
    assert.ok(String(harness.alerts.at(-1)).includes("durable flush"), "alert carries the persistence error message");
  }
  // 成功路径行为不变：无 alert，有 PUT 请求
  {
    const harness = keysHarness([{ id: "k_alpha" }]);
    await harness.ready();
    const putsBefore = harness.fetchCalls.filter((c) => String(c.url).startsWith("/admin/api/keys/") && c.options.method === "PUT").length;
    clickAct(harness.document, "toggle", "k_alpha");
    await harness.ready();
    const putsAfter = harness.fetchCalls.filter((c) => String(c.url).startsWith("/admin/api/keys/") && c.options.method === "PUT").length;
    assert.equal(putsAfter, putsBefore + 1, "successful toggle still issues one PUT");
    assert.equal(harness.alerts.length, 0, "successful toggle raises no alert");
  }
}

// ── B-10：addKey 双击/连点只发一次 POST ──
async function testAddKeyInFlightGuard() {
  const harness = keysHarness([]);
  await harness.ready();
  const addBtn = harness.document.getElementById("btn-add-key");
  assert.ok(addBtn, "keys page renders the add button");
  harness.document.getElementById("k-alias").value = "双发";
  harness.document.getElementById("k-key").value = "user_double";
  const posts = () => harness.fetchCalls.filter((c) => String(c.url) === "/admin/api/keys" && c.options.method === "POST").length;
  addBtn.click();  // 第一次：POST 在途（fetch 即返回，微任务内完成）
  addBtn.click();  // 连点第二次：in-flight 锁应吞掉
  await harness.ready();
  assert.equal(posts(), 1, "double click issues exactly one POST");
  const postBody = JSON.parse(harness.fetchCalls.find((c) => String(c.url) === "/admin/api/keys" && c.options.method === "POST").options.body);
  assert.equal(postBody.key, "user_double", "POST carries the entered key");
  // 成功后按钮可复用（锁释放）：再次点击可再发
  harness.document.getElementById("k-key").value = "user_second";
  addBtn.click();
  await harness.ready();
  assert.equal(posts(), 2, "lock is released after completion and a later click issues another POST");
}

// ── B-8：SSE stats 自动刷新不得覆盖未提交的筛选 ──
async function testStatsAutoReloadSkipsDirtyFilters() {
  const harness = createHarness({ hash: "#/history", keys: [{ id: "key-1", alias: "A", maskedKey: "user_a***", enabled: true, priority: 0 }] });
  await harness.ready();
  await harness.resolveHistory(0, "initial-page-1");
  assert.equal(harness.document.getElementById("h-status").value, "", "initial filter is empty");
  const source = FakeEventSource.instances[0];
  source.emit("open");

  // 用户改筛选（select 触发 change）但未点查询
  harness.document.getElementById("h-status").value = "429";
  harness.document.getElementById("h-status").dispatchEvent({ type: "change" });
  await flush();
  const requestsBefore = harness.historyRequests.length;

  // 后台流量（SSE stats）→ 2s debounce 到点：不应触发自动 history 请求
  source.emit("stats", { type: "request" });
  await harness.timers.advance(2000);
  await flush();
  assert.equal(harness.historyRequests.length, requestsBefore, "stats auto-reload is skipped while filters are dirty");
  assert.equal(harness.document.getElementById("h-status").value, "429", "unsubmitted filter value survives the stats event");
  assert.equal(harness.document.getElementById("h-status").disabled, false, "filter control stays interactive");

  // 用户点查询 → 正常按 filters 请求（status=429）
  harness.document.getElementById("h-search").click();
  await flush();
  assert.equal(harness.historyRequests.length, requestsBefore + 1, "clicking search issues the pending query");
  assert.ok(harness.historyRequests.at(-1).url.includes("status=429"), "query carries the pending filter");
  await harness.resolveHistory(harness.historyRequests.length - 1, "filtered-result", 1, 3);
  assert.equal(harness.document.getElementById("h-status").value, "429", "render back-fills the submitted filter");
  assert.equal(harness.document.app.innerHTML.includes("filtered-result"), true, "filtered rows are rendered");
}

// ── B-8 变体：自动刷新请求在途期间用户开始编辑筛选 → 响应落地不得重绘/回填 ──
async function testHistoryResponseLandingDuringDirtyEdit() {
  const harness = createHarness({ hash: "#/history", keys: [{ id: "key-1", alias: "A", maskedKey: "user_a***", enabled: true, priority: 0 }] });
  await harness.ready();
  await harness.resolveHistory(0, "initial-page-1");
  const source = FakeEventSource.instances[0];
  source.emit("open");

  // 触发一次自动 loadHistory（stats → debounce 2s），请求在途（Deferred 未落地）
  source.emit("stats", { type: "request" });
  await harness.timers.advance(2000);
  await flush();
  const autoRequests = harness.historyRequests.length;
  assert.equal(autoRequests, 2, "stats auto-reload started a request (not dirty yet)");

  // 用户此刻开始编辑筛选（在途请求按旧筛选发出，用户不点查询）
  harness.document.getElementById("h-status").value = "502";
  harness.document.getElementById("h-status").dispatchEvent({ type: "change" });
  await flush();
  const beforeHtml = harness.document.app.innerHTML;

  // 在途自动请求落地
  await harness.resolveHistory(autoRequests - 1, "stale-auto-row", 1, 5);
  await flush();
  assert.equal(harness.document.app.innerHTML, beforeHtml, "landing auto-refresh response does not repaint while filters are dirty");
  assert.equal(harness.document.getElementById("h-status").value, "502", "in-progress filter edit survives the landing response");
  assert.equal(harness.document.getElementById("h-status").disabled, false, "filter control stays interactive");

  // 用户点查询 → 表格按新筛选刷新（在途旧数据被新查询替换）
  harness.document.getElementById("h-search").click();
  await flush();
  assert.ok(harness.historyRequests.at(-1).url.includes("status=502"), "query uses the edited filter");
  await harness.resolveHistory(harness.historyRequests.length - 1, "fresh-filtered-row", 1, 2);
  assert.equal(harness.document.app.innerHTML.includes("fresh-filtered-row"), true, "table repaints with the submitted filter results");
}

// ── B-9：refresh 序号守卫——SSE quota 后的慢响应不得回退新额度 ──
function quotaKey(id, alias, updatedAt) {
  return { id, alias, maskedKey: "user_" + id + "***", enabled: true, priority: 0, note: "",
    health: {}, quota: { updatedAt, stale: false, fiveHour: { cap: 14, used: 1 }, weekly: null }, usage: {} };
}
function poolWithCounts() {
  return { counts: { enabled: 1, backingOff: 0, quotaLimited: 0, authError: 0 }, stats: { requests: 1, success: 1 },
    poolCfg: { strategy: "active-standby", fiveHourHardStop: 90 } };
}
function fmtTimeLike(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
async function testRefreshSeqGuardRejectsStaleLanding() {
  const T_A = 1700000000000; // 初始（boot 渲染）
  const T_B = 1700000002000; // 慢 refresh 快照携带的旧额度
  const T_C = 1700000001000; // SSE quota 事件送达的新额度
  const harness = createHarness({
    hash: "#/dashboard",
    keys: [quotaKey("k_q", "主账号", T_A)],
    pool: poolWithCounts()
  });
  await harness.ready();
  const source = FakeEventSource.instances[0];
  source.emit("open");
  assert.ok(harness.document.app.innerHTML.includes(fmtTimeLike(T_A)), "boot render shows the initial quota timestamp");

  // 慢 refresh 在途：tick（10s）触发 keys/pool GET，两响应都挂起
  const slowKeys = makeSlow(() => response(200, { keys: [quotaKey("k_q", "主账号", T_B)] }));
  const slowPool = makeSlow(() => response(200, poolWithCounts()));
  harness.slowQueues.keys.push(slowKeys);
  harness.slowQueues.pool.push(slowPool);
  await harness.timers.advance(10000);
  await flush();
  assert.equal(harness.slowQueues.keys.length, 0, "tick consumed the slow keys response queue");

  // SSE quota 事件送达新额度（T_C）
  source.emit("quota", { keyId: "k_q", report: { updatedAt: T_C, stale: false } });
  await harness.timers.advance(500);
  await flush();
  assert.ok(harness.document.app.innerHTML.includes(fmtTimeLike(T_C)), "SSE quota value is rendered");

  // 慢响应现在落地：序号已过时（SSE 作废了在途 refresh）→ 不得覆盖新额度
  slowKeys.resolve();
  slowPool.resolve();
  await flush(); await flush(); await flush();
  const renderedAfter = harness.document.app.innerHTML;
  assert.ok(renderedAfter.includes(fmtTimeLike(T_C)), "stale refresh snapshot cannot roll back the SSE quota value");
  assert.equal(renderedAfter.includes(fmtTimeLike(T_B)), false, "old snapshot timestamp never surfaces");
  assert.equal(renderedAfter.includes(fmtTimeLike(T_A)), false, "initial pre-SSE timestamp is not restored either");
}

// ── C-15：清空数字字段提交 → PUT body 不含该字段 ──
function settingsHarness(poolCfg) {
  const harness = createHarness({ hash: "#/settings", pool: { counts: {}, stats: {}, poolCfg } });
  return harness;
}
const DEFAULT_CFG = {
  strategy: "active-standby", maxRetries: 2, sameKeyRetryCount: 1, sameKeyRetryDelayMs: 1000,
  sameKeyRetryMaxWaitMs: 10000, backoffBaseMs: 2000, backoffMaxMs: 60000, connectTimeoutMs: 120000,
  failoverCooldownMs: 5000, fiveHourHardStop: 90, weeklyHardStop: 90, softStop: 80,
  quotaRefreshMs: 60000, quotaRefreshGapMs: 2000, historyRetentionDays: 7, zeroOutputCountsAs429: true
};
async function testEmptyNumericFieldsNotSubmitted() {
  const harness = settingsHarness({ ...DEFAULT_CFG });
  await harness.ready();
  const putBody = () => {
    const call = harness.fetchCalls.find((c) => String(c.url) === "/admin/api/pool" && c.options.method === "PUT");
    return call ? JSON.parse(call.options.body) : null;
  };
  // 清空 hardStop/softStop/retention + 两个 min:0 的 MS 秒字段
  for (const id of ["f-fiveHourHardStop", "f-softStop", "f-historyRetentionDays", "f-failoverCooldownMs", "f-quotaRefreshGapMs"]) {
    harness.document.getElementById(id).value = "";
  }
  harness.document.getElementById("btn-save-pool").click();
  await flush();
  const body = putBody();
  assert.ok(body, "save issues a PUT");
  for (const key of ["fiveHourHardStop", "softStop", "historyRetentionDays", "failoverCooldownMs", "quotaRefreshGapMs"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(body, key), false, "empty field " + key + " is not submitted");
  }
  assert.equal(body.softStop === 0 || body.fiveHourHardStop === 0, false, "no zero reaches the backend");
  assert.ok(body.zeroOutputCountsAs429 !== undefined, "unchanged checkbox is still submitted");
}

// ── C-19：越界值保存 → 回读 clamp 结果并提示「已按范围调整」──
async function testSavePoolClampReadback() {
  {
    const harness = settingsHarness({ ...DEFAULT_CFG });
    await harness.ready();
    harness.document.getElementById("f-fiveHourHardStop").value = "999";
    harness.setPoolData({ counts: {}, stats: {}, poolCfg: { ...DEFAULT_CFG, fiveHourHardStop: 100 } });
    harness.document.getElementById("btn-save-pool").click();
    await flush();
    const msg = harness.document.getElementById("pool-msg").innerHTML;
    assert.ok(msg.includes("已保存"), "clamped save still reports success");
    assert.ok(msg.includes("调整为 100"), "message discloses the clamp from 999 to 100");
    assert.ok(msg.includes("5h 硬阈值"), "message names the adjusted field");
  }
  {
    const harness = settingsHarness({ ...DEFAULT_CFG });
    await harness.ready();
    harness.document.getElementById("f-fiveHourHardStop").value = "80";
    harness.setPoolData({ counts: {}, stats: {}, poolCfg: { ...DEFAULT_CFG, fiveHourHardStop: 80 } });
    harness.document.getElementById("btn-save-pool").click();
    await flush();
    const msg = harness.document.getElementById("pool-msg").innerHTML;
    assert.equal(msg.includes("调整为"), false, "in-range save has no adjustment note");
    assert.equal(msg.includes("已保存"), true, "in-range save reports 已保存");
  }
}

// ── C-16：401 → 会话过期标记 + reload；登录页显示提示条 ──
async function testSessionExpiredNotice() {
  // api() 收到 401 → 置 sessionStorage 标记并 resetSession(true) reload。
  // 用 boot 后的下一次 refresh（keys GET）触发：先作废一次（切视图无碍），
  // 再让 10s tick 的 refresh 吃到 401。
  const harness = createHarness({ hash: "#/dashboard", keys: [quotaKey("k_q", "主账号", 1700000000000)], pool: poolWithCounts() });
  await harness.ready();
  const source = FakeEventSource.instances[0];
  source.emit("open");
  harness.overrideKeysGet(401, { error: { message: "Unauthorized" } });
  await harness.timers.advance(10000); // tick → refresh → api() 401
  await flush();
  assert.equal(harness.session.get("ccpm_session_expired"), "1", "401 sets the session-expired storage flag");
  assert.equal(harness.location.reloaded, true, "401 requests a reload");
  void source;
}
async function testLoginShowsSessionExpiredBanner() {
  // 模拟 reload 后的登录页：sessionStorage 残留标记 → showLogin 渲染提示条并消费标记
  const harness = createHarness({ token: "", hash: "#/dashboard", sessionEntries: [["ccpm_session_expired", "1"]] });
  await harness.ready();
  const html = harness.document.app.innerHTML;
  assert.ok(html.includes("会话已过期或已被其他页面刷新，请重新登录"), "login page shows the session-expired banner");
  assert.equal(harness.session.has("ccpm_session_expired"), false, "banner flag is consumed after display");
}

// ── C-18：导出 CSV 反映控件当前筛选（未点查询的编辑）──
async function testCsvUsesLiveFilterInputs() {
  const harness = createHarness({ hash: "#/history", keys: [{ id: "key-1", alias: "A", maskedKey: "user_a***", enabled: true, priority: 0 }] });
  await harness.ready();
  await harness.resolveHistory(0, "initial-page-1");
  harness.document.getElementById("h-status").value = "502";
  harness.document.getElementById("h-status").dispatchEvent({ type: "change" });
  await flush();
  harness.document.getElementById("h-csv").click();
  await flush();
  const csvReq = harness.historyRequests.at(-1);
  assert.ok(csvReq && csvReq.url.includes("status=502"), "CSV export queries with the live (unsubmitted) filter value");
  await harness.resolveHistory(harness.historyRequests.length - 1, "csv-live-row", 1, 1);
  assert.equal(harness.csvBlobs.length, 1, "CSV export creates one document");
  const csv = await harness.csvBlobs[0].text();
  assert.ok(csv.includes("csv-live-row"), "CSV contains the filtered row");
}

async function main() {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await testHistoryRequestSequence();
    await testHistoryCacheRateFormatting();
    await testCsvUsesExternalRequestRows();
    await testDashboardSuccessRateFormatting();
    await testSseStateMachine();
    await testSessionCleanup();
    await testLoginStartsSingleton();
    await testKeyMutationFailureFeedback();
    await testAddKeyInFlightGuard();
    await testStatsAutoReloadSkipsDirtyFilters();
    await testHistoryResponseLandingDuringDirtyEdit();
    await testRefreshSeqGuardRejectsStaleLanding();
    await testEmptyNumericFieldsNotSubmitted();
    await testSavePoolClampReadback();
    await testSessionExpiredNotice();
    await testLoginShowsSessionExpiredBanner();
    await testCsvUsesLiveFilterInputs();
    assert.deepEqual(unhandled, [], "frontend request/event transitions do not leave unhandled rejections");
    console.log("web app behavior tests passed");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

await main();
