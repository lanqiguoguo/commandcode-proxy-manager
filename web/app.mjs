// ── 零构建管理 SPA：登录 / 总览 / Key 管理 / 历史 / 设置 / 日志 ──
const app = document.getElementById("app");

const state = {
  token: sessionStorage.getItem("ccpm_token") || "",
  view: location.hash.slice(2) || "dashboard",
  keys: [],
  pool: null,
  history: { items: [], total: 0, page: 1 },
  filters: { keyId: "", status: "", errorKind: "", from: "", to: "" },
  page: 1,
  logs: [],
  lastLogTs: 0,
  timer: null
};

function setView(v) {
  state.view = v;
  location.hash = "#/" + v;
  if (v === "history") loadHistory().catch(() => {});
  if (v === "logs") loadLogs().catch(() => {});
  render();
}

function render() {
  document.getElementById("topbar").hidden = false;
  document.querySelectorAll("nav button").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === state.view);
  });
  if (state.view === "dashboard") renderDashboard();
  else if (state.view === "keys") renderKeys();
  else if (state.view === "history") renderHistory();
  else if (state.view === "settings") renderSettings();
  else if (state.view === "logs") renderLogs();
}

async function api(path, opts) {
  opts = opts || {};
  const headers = { "Content-Type": "application/json" };
  if (opts.headers) Object.assign(headers, opts.headers);
  if (state.token) headers["X-Admin-Token"] = state.token;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401 && path !== "/admin/api/login") {
    state.token = "";
    sessionStorage.removeItem("ccpm_token");
    location.reload();
    throw new Error("unauthorized");
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && (data.error.message || data.error)) || ("HTTP " + res.status);
    throw new Error(msg);
  }
  return data;
}

async function refresh() {
  try {
    const [keysData, poolData] = await Promise.all([api("/admin/api/keys"), api("/admin/api/pool")]);
    state.keys = keysData.keys || [];
    state.pool = poolData;
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

// 自动刷新前保存/恢复“添加 Key”表单未提交内容，避免 10s tick 清空正在输入的值（P3-5）
const KEY_FORM_IDS = ["k-alias", "k-key", "k-note", "k-bulk"];
function withFormPreserved(fn) {
  const saved = {};
  for (const id of KEY_FORM_IDS) {
    const el = document.getElementById(id);
    if (el) saved[id] = el.value;
  }
  fn();
  for (const id of Object.keys(saved)) {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = saved[id];
  }
}

function tick() {
  const el = document.getElementById("tick");
  if (el) el.textContent = new Date().toLocaleTimeString();
  if (state.view === "dashboard") {
    refresh().then(() => render());
  } else if (state.view === "keys") {
    refresh().then(() => withFormPreserved(render));
  }
}

function startTicker() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(tick, 10000);
}

// ── 登录 ──
function showLogin() {
  document.getElementById("topbar").hidden = true;
  app.innerHTML =
    '<div class="login-wrap"><div class="card">' +
    "<h2>CommandCode Proxy Manager</h2>" +
    "<p class=\"muted small\">管理端令牌在首次启动时生成并打印到容器日志 / data/config.json</p>" +
    "<label>Admin Token</label>" +
    '<input id="login-token" type="password" placeholder="输入管理端令牌" autocomplete="current-password">' +
    '<div class="mt"></div><button id="btn-login">登录</button>' +
    '<div id="login-msg"></div>' +
    "</div></div>";
  document.getElementById("btn-login").addEventListener("click", doLogin);
  document.getElementById("login-token").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
}

async function doLogin() {
  const token = document.getElementById("login-token").value.trim();
  if (!token) return;
  try {
    await api("/admin/api/login", { method: "POST", body: JSON.stringify({ token }) });
    state.token = token;
    sessionStorage.setItem("ccpm_token", token);
    await refresh();
    startTicker();
    startEventStream();
    render();
  } catch (e) {
    document.getElementById("login-msg").innerHTML = '<div class="alert err">' + esc(e.message) + "</div>";
  }
}

// ── 工具 ──
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmtTime(ts) { return ts ? new Date(ts).toLocaleString() : "-"; }
function fmtNum(n) { return (n == null ? 0 : n).toLocaleString(); }
function barClass(p) { return p >= 90 ? "q2" : p >= 70 ? "q1" : "q0"; }
function barHtml(label, p, sub) {
  p = Math.max(0, Math.min(100, p || 0));
  return '<div class="bar-label"><span>' + esc(label) + '</span><span class="mono">' + esc(sub || "") + "</span></div>" +
    '<div class="bar"><div class="bar-fill ' + barClass(p) + '" style="width:' + p + '%"></div></div>';
}
function healthOf(k) {
  const h = k.health || {};
  const now = Date.now();
  if (h.authError) return { cls: "bad", label: "认证异常" };
  if (h.quotaLimitedUntil && now < h.quotaLimitedUntil) return { cls: "bad", label: "额度受限" };
  if (h.backoffUntilMs && now < h.backoffUntilMs) return { cls: "warn", label: "退避中" };
  if (k.quota && k.quota.stale) return { cls: "warn", label: "额度数据过期" };
  return { cls: "ok", label: "健康" };
}

async function refreshKeyQuota(id) {
  try {
    await api("/admin/api/keys/" + id + "/refresh-quota", { method: "POST" });
    await refresh(); render();
  } catch (e) { alert(e.message); }
}
async function testKey(id) {
  try {
    const r = await api("/admin/api/keys/" + id + "/test", { method: "POST" });
    alert(r.ok ? "Key 有效 (HTTP " + r.status + ")" : "Key 无效 (HTTP " + (r.status || "timeout") + ")");
    if (r.ok) await api("/admin/api/keys/" + id + "/clear-auth", { method: "POST" });
    await refresh(); render();
  } catch (e) { alert(e.message); }
}
async function toggleKey(k) {
  await api("/admin/api/keys/" + k.id, { method: "PUT", body: JSON.stringify({ enabled: !k.enabled }) });
  await refresh(); render();
}
async function delKey(id) {
  if (!confirm("确定删除该 Key？")) return;
  await api("/admin/api/keys/" + id, { method: "DELETE" });
  await refresh(); render();
}
async function moveKey(id, dir) {
  const idx = state.keys.findIndex((k) => k.id === id);
  const target = idx + dir;
  if (target < 0 || target >= state.keys.length) return;
  await api("/admin/api/keys/" + id, { method: "PUT", body: JSON.stringify({ priority: target }) });
  await refresh(); render();
}

// ── 总览 ──
function renderDashboard() {
  const pool = state.pool || {};
  const counts = pool.counts || {};
  const st = pool.stats || {};
  const successRate = st.requests ? Math.round((st.success / st.requests) * 100) : 100;
  let html =
    "<h2>总览</h2>" +
    '<div class="grid stats mb">' +
    statCard("启用 Key", counts.enabled || 0) +
    statCard("退避中", counts.backingOff || 0) +
    statCard("额度受限", counts.quotaLimited || 0) +
    statCard("认证异常", counts.authError || 0) +
    statCard("7 天请求", st.requests || 0) +
    statCard("成功率", successRate + "%") +
    statCard("7 天 429", st.err429 || 0) +
    statCard("7 天 tokens", fmtNum((st.input || 0) + (st.output || 0))) +
    "</div>";
  if (!state.keys.length) {
    html += '<div class="card empty">尚未配置 Key，请前往 Key 管理添加</div>';
  } else {
    html += '<div class="grid cards">';
    for (const k of state.keys) html += keyCard(k);
    html += "</div>";
  }
  app.innerHTML = html;
}

function statCard(k, v) {
  return '<div class="stat"><div class="v">' + esc(String(v)) + '</div><div class="k">' + esc(k) + "</div></div>";
}

function keyCard(k) {
  const h = healthOf(k);
  const q = k.quota;
  const u = k.usage || {};
  const five = q && q.fiveHour;
  const weekly = q && q.weekly;
  const usd = q && q.creditsUsd;
  let quotaHtml = "";
  if (q && q.stale) {
    quotaHtml += '<div class="muted small">额度数据：' + (q.updatedAt ? "已过期（上次 " + fmtTime(q.updatedAt) + "）" : "获取失败") + (q.error ? ' · 原因: <span class="mono">' + esc(q.error) + "</span>" : "") + "</div>";
  } else if (q) {
    quotaHtml += '<div class="muted small">额度数据：更新于 ' + fmtTime(q.updatedAt) + "</div>";
  } else {
    quotaHtml += '<div class="muted small">额度数据：未获取</div>';
  }
  if (five) quotaHtml += barHtml("5h 窗口", five.percent, five.used + " / " + five.cap + (five.resetAt ? " · 重置 " + fmtTime(Date.parse(five.resetAt)) : ""));
  else quotaHtml += '<div class="muted small">5h 窗口：无数据</div>';
  if (weekly) quotaHtml += barHtml("每周窗口", weekly.percent, weekly.used + " / " + weekly.cap + (weekly.resetAt ? " · 重置 " + fmtTime(Date.parse(weekly.resetAt)) : ""));
  else quotaHtml += '<div class="muted small">每周窗口：无数据</div>';
  if (usd) quotaHtml += barHtml("订阅美元", usd.percent, "$" + usd.used + " / $" + usd.limit + " · 余 $" + usd.remaining);
  else quotaHtml += '<div class="muted small">订阅美元：无数据</div>';
  const w5 = u.h5 || {}, w7 = u.d7 || {}, w30 = u.d30 || {};
  const d30Label = u.d30Valid ? "30d" : "保留期";
  const usageHtml =
    '<div class="muted small">实测用量</div>' +
    '<div class="row small muted">' +
    "<span>5h: " + w5.requests + " 请求 / " + fmtNum((w5.input || 0) + (w5.output || 0)) + " tok</span>" +
    "<span>7d: " + w7.requests + " 请求</span>" +
    "<span>" + d30Label + ": " + w30.requests + " 请求" + (u.d30Valid ? "" : "（保留期内）") + "</span>" +
    "</div>" +
    '<div class="row small muted">429: ' + (w7.err429 || 0) + " · 其他错误: " + (w7.errOther || 0) + " · 切换次数: " + ((k.health && k.health.failoverCount) || 0) + "</div>";
  return '<div class="card">' +
    '<div class="row spread mb">' +
    '<div class="row">' +
    '<span class="badge pri">' + (k.priority === 0 ? "主" : "备" + k.priority) + "</span>" +
    "<strong>" + esc(k.alias || "未命名") + "</strong>" +
    '<span class="mono muted">' + esc(k.maskedKey) + "</span>" +
    '<span class="badge ' + h.cls + '">' + h.label + "</span>" +
    "</div>" +
    '<div class="row">' +
    '<button class="small ghost" onclick="ccpmRefreshQuota(\'' + k.id + '\')">刷新额度</button>' +
    '<button class="small ghost" onclick="ccpmToggle(\'' + k.id + '\')">' + (k.enabled ? "停用" : "启用") + "</button>" +
    '<button class="small danger" onclick="ccpmDelete(\'' + k.id + '\')">删除</button>' +
    "</div>" +
    "</div>" +
    '<div class="mb">' + quotaHtml + "</div>" +
    usageHtml +
    "</div>";
}

// ── Key 管理 ──
function renderKeys() {
  let html = "<h2>Key 管理</h2>";
  html += '<div class="card mb">' +
    "<h3>添加 Key</h3>" +
    '<div class="row">' +
    '<input id="k-alias" placeholder="别名（如 主账号）">' +
    '<input id="k-key" placeholder="user_xxxx" style="min-width:260px">' +
    '<input id="k-note" placeholder="备注（可选）">' +
    '<button id="btn-add-key">添加</button>' +
    "</div>" +
    '<div class="row mt">' +
    '<textarea id="k-bulk" placeholder="批量导入：每行一个 Key，支持 别名,Key 或 仅 Key" style="flex:1;min-height:70px"></textarea>' +
    '<button id="btn-bulk" class="ghost">批量导入</button>' +
    "</div>" +
    '<div id="key-msg"></div>' +
    "</div>";
  html += '<div class="card">' +
    "<h3>Key 列表（第 1 位 = 主 Key，其余按序为备 Key）</h3>" +
    "<table><thead><tr><th>优先级</th><th>别名</th><th>Key</th><th>状态</th><th>备注</th><th>操作</th></tr></thead><tbody>";
  for (const k of state.keys) {
    const h = healthOf(k);
    html += "<tr>" +
      "<td>" +
      '<button class="small ghost" onclick="ccpmMove(\'' + k.id + '\',' + (-1) + ')" ' + (k.priority === 0 ? "disabled" : "") + ">↑</button> " +
      '<button class="small ghost" onclick="ccpmMove(\'' + k.id + '\',' + 1 + ')" ' + (k.priority === state.keys.length - 1 ? "disabled" : "") + ">↓</button> " +
      '<span class="badge pri">' + (k.priority === 0 ? "主" : "备" + k.priority) + "</span></td>" +
      "<td>" + esc(k.alias || "未命名") + "</td>" +
      '<td class="mono">' + esc(k.maskedKey) + "</td>" +
      '<td><span class="badge ' + h.cls + '">' + h.label + "</span> " + (k.enabled ? "" : '<span class="badge">已停用</span>') + "</td>" +
      '<td class="muted small">' + esc(k.note || "") + "</td>" +
      "<td>" +
      '<button class="small ghost" onclick="ccpmTest(\'' + k.id + '\')">测试</button> ' +
      '<button class="small ghost" onclick="ccpmToggle(\'' + k.id + '\')">' + (k.enabled ? "停用" : "启用") + "</button> " +
      '<button class="small danger" onclick="ccpmDelete(\'' + k.id + '\')">删除</button>' +
      "</td></tr>";
  }
  html += "</tbody></table></div>";
  app.innerHTML = html;
  document.getElementById("btn-add-key").addEventListener("click", addKey);
  document.getElementById("btn-bulk").addEventListener("click", bulkImport);
}

async function addKey() {
  const alias = document.getElementById("k-alias").value.trim();
  const key = document.getElementById("k-key").value.trim();
  const note = document.getElementById("k-note").value.trim();
  try {
    await api("/admin/api/keys", { method: "POST", body: JSON.stringify({ alias, key, note }) });
    document.getElementById("k-key").value = "";
    await refresh(); render();
  } catch (e) {
    document.getElementById("key-msg").innerHTML = '<div class="alert err">' + esc(e.message) + "</div>";
  }
}

async function bulkImport() {
  const text = document.getElementById("k-bulk").value;
  const rawLines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  // 去重（按 key 去重，保留首个别名）
  const seen = new Set();
  const lines = [];
  for (const line of rawLines) {
    const key = line.includes(",") ? line.split(",")[1].trim() : line.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  let okCount = 0, failCount = 0;
  const errors = [];
  // 限制并发 5，避免批量导入打爆后端
  const concurrency = 5;
  let idx = 0;
  async function worker() {
    while (idx < lines.length) {
      const i = idx++;
      const line = lines[i];
      let alias = "", key = line;
      if (line.includes(",")) {
        const parts = line.split(",");
        alias = parts[0].trim();
        key = parts[1].trim();
      }
      try {
        await api("/admin/api/keys", { method: "POST", body: JSON.stringify({ alias, key }) });
        okCount++;
      } catch (e) {
        failCount++;
        if (errors.length < 3) errors.push(e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, lines.length) }, () => worker()));
  document.getElementById("key-msg").innerHTML = '<div class="alert ' + (failCount ? "err" : "ok") + '">成功 ' + okCount + " 个，失败 " + failCount + " 个" + (errors.length ? "：" + esc(errors.join("；")) : "") + "</div>";
  document.getElementById("k-bulk").value = "";
  await refresh(); render();
}

// ── 历史记录 ──
function renderHistory() {
  let html = "<h2>历史记录</h2>";
  html += '<div class="card mb"><div class="filters">' +
    '<div><label>Key</label><select id="h-key">' + '<option value="">全部</option>' + state.keys.map((k) => '<option value="' + k.id + '">' + esc(k.alias || k.maskedKey) + "</option>").join("") + "</select></div>" +
    '<div><label>状态</label><select id="h-status"><option value="">全部</option><option>200</option><option>401</option><option>429</option><option>502</option></select></div>' +
    '<div><label>错误类型</label><select id="h-err"><option value="">全部</option><option value="rate_limit">rate_limit</option><option value="auth">auth</option><option value="upstream">upstream</option><option value="client">client</option><option value="timeout">timeout</option></select></div>' +
    '<div><label>开始</label><input type="datetime-local" id="h-from"></div>' +
    '<div><label>结束</label><input type="datetime-local" id="h-to"></div>' +
    '<div><label>&nbsp;</label><button id="h-search">查询</button> <button id="h-csv" class="ghost">导出 CSV</button></div>' +
    "</div></div>";
  html += '<div class="card"><table><thead><tr><th>时间</th><th>Key</th><th>模型</th><th>流式</th><th>状态</th><th>错误</th><th>入/出/缓存 tok</th><th>重试</th><th>延迟</th></tr></thead><tbody>';
  for (const it of state.history.items || []) {
    const keyName = (state.keys.find((k) => k.id === it.keyId) || {}).alias || it.keyId;
    html += "<tr>" +
      "<td>" + fmtTime(it.ts) + "</td>" +
      "<td>" + esc(keyName) + "</td>" +
      '<td class="mono">' + esc(it.model || "-") + "</td>" +
      "<td>" + (it.stream ? "是" : "否") + "</td>" +
      '<td><span class="badge ' + (it.ok ? "ok" : "bad") + '">' + it.status + "</span></td>" +
      '<td class="muted small">' + esc(it.errorKind || "") + "</td>" +
      '<td class="mono small">' + (it.inputTokens ?? "-") + " / " + (it.outputTokens ?? "-") + " / " + (it.cachedTokens ?? "-") + "</td>" +
      "<td>" + (it.retries || 0) + "</td>" +
      "<td>" + (it.latencyMs != null ? Math.round(it.latencyMs) + "ms" : "-") + "</td>" +
      "</tr>";
  }
  html += "</tbody></table>";
  html += '<div class="row spread mt">' +
    '<span class="muted">共 ' + state.history.total + " 条</span>" +
    "<span>" +
    '<button class="small ghost" id="h-prev">上一页</button> ' +
    '<span class="muted">第 ' + (state.history.page || 1) + " 页</span> " +
    '<button class="small ghost" id="h-next">下一页</button>' +
    "</span></div></div>";
  app.innerHTML = html;
  document.getElementById("h-search").addEventListener("click", () => {
    state.filters = readFilters();
    state.page = 1;
    loadHistory();
  });
  document.getElementById("h-csv").addEventListener("click", exportCsv);
  document.getElementById("h-prev").addEventListener("click", () => { if (state.page > 1) { state.page--; loadHistory(); } });
  document.getElementById("h-next").addEventListener("click", () => { if (state.page * 50 < state.history.total) { state.page++; loadHistory(); } });
  document.getElementById("h-key").value = state.filters.keyId || "";
  document.getElementById("h-status").value = state.filters.status || "";
  document.getElementById("h-err").value = state.filters.errorKind || "";
  document.getElementById("h-from").value = state.filters.from || "";
  document.getElementById("h-to").value = state.filters.to || "";
}

function readFilters() {
  return {
    keyId: document.getElementById("h-key").value,
    status: document.getElementById("h-status").value,
    errorKind: document.getElementById("h-err").value,
    from: document.getElementById("h-from").value,
    to: document.getElementById("h-to").value
  };
}

function toTs(dtLocal) {
  if (!dtLocal) return "";
  const d = new Date(dtLocal);
  return Number.isFinite(d.getTime()) ? String(d.getTime()) : "";
}

async function loadHistory() {
  const f = state.filters;
  const params = new URLSearchParams();
  if (f.keyId) params.set("keyId", f.keyId);
  if (f.status) params.set("status", f.status);
  if (f.errorKind) params.set("errorKind", f.errorKind);
  const from = toTs(f.from), to = toTs(f.to);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  params.set("page", String(state.page));
  params.set("pageSize", "50");
  const data = await api("/admin/api/history?" + params.toString());
  state.history = data;
  if (state.view === "history") renderHistory();
}

async function exportCsv() {
  const f = state.filters;
  const params = new URLSearchParams();
  if (f.keyId) params.set("keyId", f.keyId);
  if (f.status) params.set("status", f.status);
  if (f.errorKind) params.set("errorKind", f.errorKind);
  const from = toTs(f.from), to = toTs(f.to);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  params.set("pageSize", "500");
  const data = await api("/admin/api/history?" + params.toString());
  const head = ["时间", "Key", "模型", "流式", "状态", "错误", "入tok", "出tok", "缓存tok", "重试", "延迟ms"];
  const rows = [head.join(",")];
  for (const it of data.items || []) {
    const keyName = (state.keys.find((k) => k.id === it.keyId) || {}).alias || it.keyId;
    rows.push([new Date(it.ts).toISOString(), keyName, it.model || "", it.stream ? "yes" : "no", it.status, it.errorKind || "", it.inputTokens ?? "", it.outputTokens ?? "", it.cachedTokens ?? "", it.retries || 0, it.latencyMs ?? ""].map(csvCell).join(","));
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ccpm-history-" + new Date().toISOString().slice(0, 10) + ".csv";
  a.click();
  URL.revokeObjectURL(a.href);
  if (data.total > (data.items || []).length) {
    alert("已导出 " + data.items.length + " 条（上限 500/次），共匹配 " + data.total + " 条；请用时间/Key 筛选缩小范围后分批导出");
  }
}
function csvCell(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

// ── 设置 ──
function renderSettings() {
  const p = (state.pool && state.pool.poolCfg) || {};
  let html = "<h2>设置</h2>";
  html += '<div class="card mb">' +
    "<h3>池与退避</h3>" +
    '<div class="filters">' +
    field("strategy", "选 Key 策略", "select", ["active-standby", "round-robin", "least-usage"], p.strategy) +
    field("maxRetries", "最大重试次数", "number", null, p.maxRetries) +
    field("sameKeyRetryCount", "同 Key 重试次数", "number", null, p.sameKeyRetryCount) +
    field("sameKeyRetryDelayMs", "同 Key 重试间隔 ms", "number", null, p.sameKeyRetryDelayMs) +
    field("sameKeyRetryMaxWaitMs", "同 Key 重试最大等待 ms", "number", null, p.sameKeyRetryMaxWaitMs) +
    field("backoffBaseMs", "退避基数 ms", "number", null, p.backoffBaseMs) +
    field("backoffMaxMs", "退避上限 ms", "number", null, p.backoffMaxMs) +
    field("connectTimeoutMs", "上游响应头超时 ms", "number", null, p.connectTimeoutMs) +
    field("failoverCooldownMs", "切换冷却 ms", "number", null, p.failoverCooldownMs) +
    field("fiveHourHardStop", "5h 硬阈值 %", "number", null, p.fiveHourHardStop) +
    field("weeklyHardStop", "每周硬阈值 %", "number", null, p.weeklyHardStop) +
    field("softStop", "软限制阈值 %", "number", null, p.softStop) +
    field("quotaRefreshMs", "额度刷新间隔 ms", "number", null, p.quotaRefreshMs) +
    field("historyRetentionDays", "历史保留天数", "number", null, p.historyRetentionDays) +
    "</div>" +
    '<div class="row mt"><label style="margin:0"><input type="checkbox" id="f-zeroOutputCountsAs429" ' + (p.zeroOutputCountsAs429 ? "checked" : "") + '> 零输出计入 429</label></div>' +
    '<div class="mt"><button id="btn-save-pool">保存池配置</button> <span id="pool-msg"></span></div>' +
    "</div>";
  html += '<div class="card">' +
    "<h3>令牌</h3>" +
    '<div class="muted small mb">clientToken 用于 /v1/* 客户端访问；未配置时自动回退使用 AdminToken。管理界面仍只认 AdminToken。</div>' +
    "<label>clientToken（留空 = 回退 AdminToken）</label>" +
    '<input id="sec-client" type="password" placeholder="' + (state.pool && state.pool.clientTokenConfigured ? "已配置" : "未配置（将回退 AdminToken）") + '">' +
    "<label>AdminToken（留空 = 不修改）</label>" +
    '<input id="sec-admin" type="password" placeholder="至少 8 位">' +
    '<div class="mt"><button id="btn-save-sec">保存令牌</button> <span id="sec-msg"></span></div>' +
    "</div>";
  app.innerHTML = html;
  document.getElementById("btn-save-pool").addEventListener("click", savePool);
  document.getElementById("btn-save-sec").addEventListener("click", saveSecurity);
}

function field(id, label, type, options, value) {
  let input;
  if (type === "select") {
    input = '<select id="f-' + id + '">' + options.map((o) => '<option value="' + o + '"' + (o === value ? " selected" : "") + ">" + o + "</option>").join("") + "</select>";
  } else {
    input = '<input id="f-' + id + '" type="' + type + '" value="' + esc(value ?? "") + '">';
  }
  return '<div><label>' + esc(label) + "</label>" + input + "</div>";
}

async function savePool() {
  const ids = ["strategy", "maxRetries", "sameKeyRetryCount", "sameKeyRetryDelayMs", "sameKeyRetryMaxWaitMs", "backoffBaseMs", "backoffMaxMs", "connectTimeoutMs", "failoverCooldownMs", "fiveHourHardStop", "weeklyHardStop", "softStop", "quotaRefreshMs", "historyRetentionDays"];
  const body = {};
  for (const id of ids) {
    const el = document.getElementById("f-" + id);
    if (!el) continue;
    body[id] = el.type === "number" ? Number(el.value) : el.value;
  }
  body.zeroOutputCountsAs429 = document.getElementById("f-zeroOutputCountsAs429").checked;
  try {
    await api("/admin/api/pool", { method: "PUT", body: JSON.stringify(body) });
    document.getElementById("pool-msg").innerHTML = '<span class="badge ok">已保存</span>';
    await refresh();
  } catch (e) {
    document.getElementById("pool-msg").innerHTML = '<span class="badge bad">' + esc(e.message) + "</span>";
  }
}

async function saveSecurity() {
  const client = document.getElementById("sec-client").value;
  const admin = document.getElementById("sec-admin").value;
  const body = {};
  if (client !== "") body.clientToken = client;
  if (admin !== "") body.adminToken = admin;
  if (!Object.keys(body).length) return;
  try {
    await api("/admin/api/security", { method: "POST", body: JSON.stringify(body) });
    document.getElementById("sec-msg").innerHTML = '<span class="badge ok">已保存（若修改了 AdminToken，请重新登录）</span>';
  } catch (e) {
    document.getElementById("sec-msg").innerHTML = '<span class="badge bad">' + esc(e.message) + "</span>";
  }
}

// ── 日志 ──（DESIGN §6：按 Key 过滤；SSE log 事件与轮询共用同一渲染）
function renderLogs() {
  const sel = state.logFilterKeyId || "";
  const filtered = sel ? state.logs.filter((l) => l.msg.includes(sel)) : state.logs;
  app.innerHTML = "<h2>日志</h2>" +
    '<div class="card mb"><label>按 Key 过滤：</label>' +
    '<select id="log-filter"><option value="">全部</option>' +
    state.keys.map((k) => '<option value="' + esc(k.id) + '"' + (k.id === sel ? " selected" : "") + ">" + esc(k.alias || k.maskedKey) + "</option>").join("") +
    "</select></div>" +
    '<div class="card"><div class="log-list" id="log-list">' +
    filtered.map((l) => "<div>[" + fmtTime(l.ts) + "] " + esc(l.msg) + "</div>").join("") +
    "</div></div>";
  document.getElementById("log-filter").addEventListener("change", (e) => {
    state.logFilterKeyId = e.target.value;
    renderLogs();
  });
}

async function loadLogs() {
  const data = await api("/admin/api/logs?since=" + state.lastLogTs);
  for (const l of data.logs) state.logs.push(l);
  if (state.logs.length > 500) state.logs = state.logs.slice(-500);
  if (state.logs.length) state.lastLogTs = state.logs[state.logs.length - 1].ts;
  if (state.view === "logs") {
    renderLogs();
    const el = document.getElementById("log-list");
    if (el) el.scrollTop = el.scrollHeight;
  }
}

// ── 全局 onclick 绑定 ──
window.ccpmRefreshQuota = refreshKeyQuota;
window.ccpmToggle = toggleKey;
window.ccpmDelete = delKey;
window.ccpmTest = testKey;
window.ccpmMove = moveKey;

// ── 启动 ──
window.addEventListener("hashchange", () => {
  state.view = location.hash.slice(2) || "dashboard";
  if (state.view === "history") loadHistory().catch(() => {});
  if (state.view === "logs") { loadLogs().catch(() => {}); startLogPoller(); }
  else stopLogPoller();
  render();
});

document.getElementById("btn-logout").addEventListener("click", () => {
  state.token = "";
  sessionStorage.removeItem("ccpm_token");
  location.reload();
});

document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

state.logTimer = null;
function startLogPoller() {
  if (state.logTimer) clearInterval(state.logTimer);
  state.logTimer = setInterval(() => { if (state.view === "logs") loadLogs().catch(() => {}); }, 3000);
  if (state.logTimer.unref) state.logTimer.unref?.();
}
function stopLogPoller() {
  if (state.logTimer) { clearInterval(state.logTimer); state.logTimer = null; }
}

// ── SSE 实时事件（DESIGN §6：quota/health/usage/切换事件推送）──
// 后端 /admin/api/events 接受 ?token= 查询参数（EventSource 无法带 header）。
// 10s tick 与日志轮询保留为断线兜底。
let eventSource = null;
let statsDebounce = null;
let quotaRenderTimer = null;
function startEventStream() {
  if (eventSource) { try { eventSource.close(); } catch {} }
  try {
    eventSource = new EventSource("/admin/api/events?token=" + encodeURIComponent(state.token));
  } catch { return; }
  eventSource.addEventListener("log", (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (!d || d.ts <= state.lastLogTs) return; // 与 loadLogs 共用 lastLogTs 去重，防 SSE+轮询双写
    state.lastLogTs = d.ts;
    state.logs.push(d);
    if (state.logs.length > 500) state.logs = state.logs.slice(-500);
    if (state.view === "logs") {
      renderLogs();
      const el = document.getElementById("log-list");
      if (el) el.scrollTop = el.scrollHeight;
    }
  });
  eventSource.addEventListener("quota", (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    const k = state.keys.find((x) => x.id === d.keyId);
    if (k) k.quota = d.report;
    if (state.view === "dashboard" || state.view === "keys") {
      if (!quotaRenderTimer) quotaRenderTimer = setTimeout(() => { quotaRenderTimer = null; render(); }, 500);
    }
  });
  eventSource.addEventListener("stats", () => {
    if (state.view !== "history") return;
    clearTimeout(statsDebounce);
    statsDebounce = setTimeout(() => loadHistory().catch(() => {}), 2000);
  });
}
function stopEventStream() {
  if (eventSource) { try { eventSource.close(); } catch {} eventSource = null; }
}

if (!state.token) {
  showLogin();
} else {
  (async () => {
    const ok = await refresh();
    if (!ok) { showLogin(); return; }
    startTicker();
    startEventStream();
    startLogPoller();
    if (state.view === "history") loadHistory().catch(() => {});
    render();
  })();
}
