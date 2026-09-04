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
    const idPattern = /<([a-zA-Z][\w-]*)\b[^>]*\bid=["']([^"']+)["'][^>]*>/g;
    let match;
    while ((match = idPattern.exec(this.app._innerHTML))) {
      const [, tagName, id] = match;
      this.addElement(tagName, id, true);
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

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function createHarness({ token = "token-a", hash = "#/history" } = {}) {
  const document = new FakeDocument();
  const timers = new TimerHarness();
  const session = new Map(token ? [["ccpm_token", token]] : []);
  const location = {
    hash,
    reloaded: false,
    reload() { this.reloaded = true; }
  };
  const historyRequests = [];
  const poolProbeResponses = [];
  const fetchCalls = [];
  const csvBlobs = [];
  class CaptureBlob extends Blob {
    constructor(parts, options) {
      super(parts, options);
      csvBlobs.push(this);
    }
  }
  const fetch = (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (String(url).startsWith("/admin/api/keys")) {
      return Promise.resolve(response(200, { keys: [] }));
    }
    if (String(url).startsWith("/admin/api/pool")) {
      if (options.cache === "no-store") {
        const result = poolProbeResponses.shift() || response(200, {});
        return Promise.resolve(result);
      }
      return Promise.resolve(response(200, { counts: {}, stats: {}, poolCfg: {} }));
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
    console: { error() {}, log() {} },
    alert() {},
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
  const beforeRecovery = FakeEventSource.instances.length;
  reconnect.click();
  assert.equal(FakeEventSource.instances.length, beforeRecovery + 1, "manual recovery creates one new EventSource");
  const recovered = FakeEventSource.instances.at(-1);
  assert.equal(recovered.listenerCount("log"), 1, "recovered source has one log listener");
  recovered.emit("open");
  assert.equal(harness.document.getElementById("sse-status").textContent, "实时已连接", "manual recovery can reconnect");

  const beforeHidden = FakeEventSource.instances.length;
  harness.document.hidden = true;
  harness.document.dispatchEvent({ type: "visibilitychange" });
  assert.equal(recovered.closed, true, "hidden page closes the active EventSource");
  assert.equal(harness.timers.pendingTimeouts().length, 0, "hidden page leaves no retry timer");
  assert.equal(harness.document.getElementById("sse-status").textContent, "实时连接已暂停（页面隐藏）", "hidden state is observable");
  recovered.emit("log", { ts: 2, msg: "stale event" });
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

async function main() {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await testHistoryRequestSequence();
    await testHistoryCacheRateFormatting();
    await testCsvUsesExternalRequestRows();
    await testSseStateMachine();
    await testSessionCleanup();
    await testLoginStartsSingleton();
    assert.deepEqual(unhandled, [], "frontend request/event transitions do not leave unhandled rejections");
    console.log("web app behavior tests passed");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

await main();
