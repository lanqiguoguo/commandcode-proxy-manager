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
const KEY_FORM_IDS = ["k-alias", "k-key", "k-note"];
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
  sweepBusy(); // busy TTL 到期清理（dashboard/keys 视图随后本就会重绘）
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
// P2-7：补转义单引号（&#39;）——重构后 id 等值以属性形式输出，防止属性上下文逃逸
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// P1-6：token 数值渲染兜底——历史事件可能含修复前落盘的脏数据（字符串/对象），
// 非有限数一律显示 "-"，绝不经未转义通道进 HTML（双保险：源头 stats 已净化）
function fmtTok(v) {
  if (v == null || !Number.isFinite(Number(v))) return "-";
  return esc(String(v));
}
// 统一时间格式：2026/09/02 00:45:38（24 小时制，不随浏览器 locale 变化）
function fmtTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
function fmtNum(n) { return (n == null ? 0 : n).toLocaleString(); }
function fmtCountdown(targetMs) {
  const s = Math.round((targetMs - Date.now()) / 1000);
  if (!Number.isFinite(s) || s <= 0) return "";
  if (s < 60) return s + " 秒后重置";
  if (s < 3600) return Math.round(s / 60) + " 分钟后重置";
  if (s < 86400) return (s / 3600).toFixed(1) + " 小时后重置";
  return Math.round(s / 86400) + " 天后重置";
}
function fmtUsd(n) { return "$" + (Number(n) || 0).toFixed(2); }
function windowBar(label, w) {
  if (!w) return barHtml(label, null, "无数据");
  const cd = w.resetAt ? fmtCountdown(Date.parse(w.resetAt)) : "";
  const sub = fmtUsd(w.used) + " / " + fmtUsd(w.cap) + " · " + round2(w.percent) + "%" + (cd ? " · " + cd : "");
  return barHtml(label, w.percent, sub);
}
function round2(n) { return Math.round((n || 0) * 100) / 100; }
function barClass(p) { return p >= 90 ? "q2" : p >= 70 ? "q1" : "q0"; }
// 数值/百分比拆分着色：sub 形如 "$5.60 / $14.00 · 40% · 3 小时后重置"
// 金额段提为正文色，百分比按绿/黄/红着色，倒计时保持灰色小字
function barSubHtml(p, sub) {
  if (!sub) return "";
  const parts = String(sub).split(" · ");
  if (parts.length === 1 && parts[0] === "无数据") return '<span class="muted">' + esc(sub) + "</span>";
  const money = parts[0] == null ? "" : parts[0];
  const pct = parts[1] != null && parts[1].endsWith("%") ? parts[1] : "";
  const cd = parts.slice(pct ? 2 : 1).join(" ·");
  let out = '<span class="mono kc-money">' + esc(money) + "</span>";
  if (pct) out += '<span class="mono pct ' + barClass(p) + '">' + esc(pct) + "</span>";
  if (cd) out += '<span class="kc-cd">' + esc(cd) + "</span>";
  return out;
}
function barHtml(label, p, sub) {
  const noData = p == null;
  const v = noData ? 0 : Math.max(0, Math.min(100, p || 0));
  return '<div class="kc-bar"><div class="bar-label"><span>' + esc(label) + "</span><span>" + barSubHtml(v, sub) + "</span></div>" +
    '<div class="bar"><div class="bar-fill ' + barClass(v) + '" style="width:' + v + '%"></div></div></div>';
}
// 每 Key 的即时状态（updating/testing）：本地操作置位 + SSE quota-status 事件
// 同步（他人触发的自动刷新/测试也能看到"更新中"），done/error/idle 清除；
// 30s TTL 兜底：SSE 恰好断开错过 done 时不致徽标永久挂死
const busy = {};
const BUSY_LABEL = { updating: "额度更新中…", testing: "测试中…" };
const BUSY_TTL_MS = 30000;
function setBusy(id, phase) { busy[id] = { phase, at: Date.now() }; }
function clearBusy(id) { delete busy[id]; }
function busyPhase(id) {
  const b = busy[id];
  if (!b) return "";
  if (Date.now() - b.at > BUSY_TTL_MS) { delete busy[id]; return ""; }
  return b.phase;
}
function sweepBusy() {
  let changed = false;
  for (const id of Object.keys(busy)) {
    if (Date.now() - busy[id].at > BUSY_TTL_MS) { delete busy[id]; changed = true; }
  }
  return changed;
}
// 实测用量折叠状态：dashboard 每 10s 全量重渲染，<details> 的 open 状态须持久化，
// 否则用户刚展开就被自动刷新折回去（P2-7 后：展开态由顶层 toggle 捕获委托写入，
// 见文件末尾事件委托区；渲染时通过 <details data-usage> + open 属性恢复）
const usageOpen = {};
function healthOf(k) {
  const h = k.health || {};
  const now = Date.now();
  if (h.authError) return { cls: "bad", label: "认证异常" };
  if (h.quotaLimitedUntil && now < h.quotaLimitedUntil) return { cls: "bad", label: "额度受限" };
  if (h.backoffUntilMs && now < h.backoffUntilMs) return { cls: "warn", label: "退避中" };
  if (k.quota && k.quota.stale) return { cls: "warn", label: k.quota.updatedAt ? "额度自动刷新失败" : "额度获取失败" };
  return { cls: "ok", label: "健康" };
}

async function refreshKeyQuota(id) {
  setBusy(id, "updating"); render();
  try {
    await api("/admin/api/keys/" + id + "/refresh-quota", { method: "POST" });
    await refresh();
  } catch (e) { alert(e.message); }
  clearBusy(id); render();
}
async function testKey(id) {
  setBusy(id, "testing"); render();
  try {
    const r = await api("/admin/api/keys/" + id + "/test", { method: "POST" });
    clearBusy(id); render();
    alert(r.ok ? "Key 有效 (HTTP " + r.status + ")" : "Key 无效 (HTTP " + (r.status || "timeout") + ")");
    if (r.ok) await api("/admin/api/keys/" + id + "/clear-auth", { method: "POST" });
    await refresh(); render();
  } catch (e) { clearBusy(id); render(); alert(e.message); }
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
  // ── 额度分组 ──
  let quotaHtml = "";
  if (q && q.stale) {
    quotaHtml += '<div class="muted small kc-updated">额度数据：' + (q.updatedAt ? "自动刷新失败（以下仍为上次成功数据，" + fmtTime(q.updatedAt) + "）" : "获取失败") + (q.error ? ' · 原因: <span class="mono">' + esc(q.error) + "</span>" : "") + "</div>";
  } else if (q) {
    quotaHtml += '<div class="muted small kc-updated">额度数据：更新于 ' + fmtTime(q.updatedAt) + "</div>";
  } else {
    quotaHtml += '<div class="muted small kc-updated">额度数据：未获取</div>';
  }
  // 上游三窗口均为美元限额（官方口径：5h/weekly/monthly limit = $ of usage）
  quotaHtml += windowBar("5 小时限额", five);
  quotaHtml += windowBar("每周限额", weekly);
  if (usd) {
    const cd = usd.expiresAt ? fmtCountdown(Date.parse(usd.expiresAt)) : "";
    quotaHtml += barHtml("每月限额（账期）", usd.percent, fmtUsd(usd.used) + " / " + fmtUsd(usd.limit) + " · " + round2(usd.percent) + "%" + (cd ? " · " + cd : ""));
  } else {
    quotaHtml += barHtml("每月限额（账期）", null, "无数据");
  }
  // totals/窗口数据在探测失败时保留上次成功值，stale 期间仍展示（顶部已注明数据时点）
  let totalsHtml = '<div class="muted small">暂无账期汇总数据</div>';
  if (q && q.totals) {
    const t = q.totals;
    totalsHtml = '<div class="mini-stats">' +
      '<div class="ms"><div class="ms-v mono">' + fmtNum(t.runs) + '</div><div class="ms-k">本账期调用（次）</div></div>' +
      (t.successRate != null ? '<div class="ms"><div class="ms-v mono">' + t.successRate + "%</div><div class=\"ms-k\">成功率</div></div>" : "") +
      '<div class="ms"><div class="ms-v mono">' + fmtNum(t.tokens) + '</div><div class="ms-k">总 Token</div></div>' +
      "</div>";
  }
  // 实测用量：默认折叠，summary 给出关键摘要数字
  const w5 = u.h5 || {}, w7 = u.d7 || {}, w30 = u.d30 || {};
  const d30Label = u.d30Valid ? "30d" : "保留期";
  // 摘要与详情共用同一 chip 构造：数字亮色 + 单位灰小字，标签用 .kc-unit 与数字区分
  const chip = (v, unit, label) => "<b>" + v + "</b><span class='kc-unit'>" + unit + (label ? " · " + label : "") + "</span>";
  const usageChips = [
    chip(w5.requests, "请求", "5h"),
    chip(fmtNum((w5.input || 0) + (w5.output || 0)), "tok", "5h"),
    chip(w7.requests, "请求", "7d"),
    chip(w30.requests, "请求", d30Label + (u.d30Valid ? "" : "（保留期内）")),
    chip(w7.err429 || 0, "× 429", "7d"),
    chip(w7.errOther || 0, "其他错误", "7d"),
    chip((k.health && k.health.failoverCount) || 0, "次切换", ""),
  ];
  const usageDetail = '<div class="kc-chips">' + usageChips.map((c) => "<span>" + c + "</span>").join("") + "</div>";
  return '<div class="card key-card">' +
    '<div class="row spread kc-head">' +
    '<div class="row">' +
    '<span class="badge pri">' + (k.priority === 0 ? "主" : "备" + k.priority) + "</span>" +
    "<strong>" + esc(k.alias || "未命名") + "</strong>" +
    '<span class="mono muted">' + esc(k.maskedKey) + "</span>" +
    (busyPhase(k.id) ? '<span class="badge accent busy-badge">' + BUSY_LABEL[busyPhase(k.id)] + "</span>" : '<span class="badge ' + h.cls + '">' + h.label + "</span>") +
    "</div>" +
    '<div class="row key-actions">' +
    '<button class="small ghost" data-act="refresh-quota" data-id="' + esc(k.id) + '" ' + (busyPhase(k.id) ? "disabled" : "") + '>' + (busyPhase(k.id) === "updating" ? "更新中…" : "刷新额度") + "</button>" +
    '<button class="small ghost" data-act="toggle" data-id="' + esc(k.id) + '">' + (k.enabled ? "停用" : "启用") + "</button>" +
    '<button class="small danger" data-act="delete" data-id="' + esc(k.id) + '">删除</button>' +
    "</div>" +
    "</div>" +
    '<div class="kc-sec">' + quotaHtml + "</div>" +
    '<div class="kc-sec"><div class="kc-sec-t">本账期</div>' + totalsHtml + "</div>" +
    '<details class="kc-sec kc-usage" data-usage="' + esc(k.id) + '"' + (usageOpen[k.id] ? " open" : "") + '><summary class="kc-sec-t">实测用量<span class="kc-chips kc-chips-sum">' + [usageChips[2], usageChips[4]].map((c) => "<span>" + c + "</span>").join("") + "</span></summary>" + usageDetail + "</details>" +
    "</div>";
}

// ── Key 管理 ──
function renderKeys() {
  let html = "<h2>Key 管理</h2>";
  html += '<div class="card mb">' +
    "<h3>添加 Key</h3>" +
    '<div class="row kadd-row">' +
    '<input id="k-alias" placeholder="别名（如 主账号）">' +
    '<input id="k-key" class="kadd-key" placeholder="user_xxxx">' +
    '<input id="k-note" placeholder="备注（可选）">' +
    '<button id="btn-add-key">添加</button>' +
    "</div>" +
    '<div id="key-msg"></div>' +
    "</div>";
  html += '<div class="card">' +
    "<h3>Key 列表（第 1 位 = 主 Key，其余按序为备 Key）</h3>" +
    '<div class="table-scroll"><table><thead><tr><th>优先级</th><th>别名</th><th>Key</th><th>状态</th><th>备注</th><th>操作</th></tr></thead><tbody>';
  for (const k of state.keys) {
    const h = healthOf(k);
    html += "<tr>" +
      "<td>" +
      '<button class="small ghost" data-act="move-up" data-id="' + esc(k.id) + '" ' + (k.priority === 0 ? "disabled" : "") + ">↑</button> " +
      '<button class="small ghost" data-act="move-down" data-id="' + esc(k.id) + '" ' + (k.priority === state.keys.length - 1 ? "disabled" : "") + ">↓</button> " +
      '<span class="badge pri">' + (k.priority === 0 ? "主" : "备" + k.priority) + "</span></td>" +
      "<td>" + esc(k.alias || "未命名") + "</td>" +
      '<td class="mono">' + esc(k.maskedKey) + "</td>" +
      '<td>' + (busyPhase(k.id) ? '<span class="badge accent busy-badge">' + BUSY_LABEL[busyPhase(k.id)] + "</span>" : '<span class="badge ' + h.cls + '">' + h.label + "</span>") + " " + (k.enabled ? "" : '<span class="badge">已停用</span>') + "</td>" +
      '<td class="muted small">' + esc(k.note || "") + "</td>" +
      "<td>" +
      '<button class="small ghost" data-act="test" data-id="' + esc(k.id) + '" ' + (busyPhase(k.id) ? "disabled" : "") + ">" + (busyPhase(k.id) === "testing" ? "测试中…" : "测试") + "</button> " +
      '<button class="small ghost" data-act="toggle" data-id="' + esc(k.id) + '">' + (k.enabled ? "停用" : "启用") + "</button> " +
      '<button class="small danger" data-act="delete" data-id="' + esc(k.id) + '">删除</button>' +
      "</td></tr>";
  }
  html += "</tbody></table></div></div>";
  app.innerHTML = html;
  document.getElementById("btn-add-key").addEventListener("click", addKey);
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

// ── 历史记录 ──
function renderHistory() {
  let html = "<h2>历史记录</h2>";
  html += '<div class="alert info" style="margin-bottom:12px">本页是<b>本网关自身的代理日志</b>（经本 manager 转发的每一次请求：时间/Key/模型/状态/token/延迟/重试），' +
    "不是 commandcode.ai 官网 settings/usage 的账号级账单明细——上游 API 不向第三方暴露逐条调用记录（仅汇总统计，已在本账期卡片展示）。" +
    "未走本网关的 CLI 直连调用不会出现在这里。</div>";
  html += '<div class="card mb"><div class="filters">' +
    '<div><label>Key</label><select id="h-key">' + '<option value="">全部</option>' + state.keys.map((k) => '<option value="' + esc(k.id) + '">' + esc(k.alias || k.maskedKey) + "</option>").join("") + "</select></div>" +
    '<div><label>状态</label><select id="h-status"><option value="">全部</option><option>200</option><option>401</option><option>429</option><option>502</option></select></div>' +
    '<div><label>错误类型</label><select id="h-err"><option value="">全部</option><option value="rate_limit">rate_limit</option><option value="auth">auth</option><option value="upstream">upstream</option><option value="client">client</option><option value="timeout">timeout</option></select></div>' +
    '<div><label>开始</label><input type="datetime-local" id="h-from"></div>' +
    '<div><label>结束</label><input type="datetime-local" id="h-to"></div>' +
    '<div><label>&nbsp;</label><button id="h-search">查询</button> <button id="h-csv" class="ghost">导出 CSV</button></div>' +
    "</div></div>";
  html += '<div class="card"><div class="table-scroll"><table><thead><tr><th>时间</th><th>Key</th><th>模型</th><th>流式</th><th>状态</th><th>错误</th><th>入/出/缓存 tok</th><th>重试</th><th>延迟</th></tr></thead><tbody>';
  for (const it of state.history.items || []) {
    const keyName = (state.keys.find((k) => k.id === it.keyId) || {}).alias || it.keyId;
    html += "<tr>" +
      "<td>" + fmtTime(it.ts) + "</td>" +
      "<td>" + esc(keyName) + "</td>" +
      '<td class="mono">' + esc(it.model || "-") + "</td>" +
      "<td>" + (it.stream ? "是" : "否") + "</td>" +
      '<td><span class="badge ' + (it.ok ? "ok" : "bad") + '">' + it.status + "</span></td>" +
      '<td class="muted small">' + esc(it.errorKind || "") + "</td>" +
      '<td class="mono small">' + fmtTok(it.inputTokens) + " / " + fmtTok(it.outputTokens) + " / " + fmtTok(it.cachedTokens) + "</td>" +
      "<td>" + (it.retries || 0) + "</td>" +
      "<td>" + (it.latencyMs != null ? Math.round(it.latencyMs) + "ms" : "-") + "</td>" +
      "</tr>";
  }
  html += "</tbody></table></div>";
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
// CSV 公式注入防护（P1-4）：以 = + - @ \t \r 开头的值在 Excel/WPS 中会被当作公式
// 执行（历史 model 名来自不可信客户端）。在引号转义之前对原始值加 ' 前缀中和。
function csvCell(s) {
  let v = String(s);
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  return '"' + v.replace(/"/g, '""') + '"';
}

// ── 设置 ──
const STRATEGY_INFO = {
  "active-standby": { label: "主备模式（默认）", desc: "任一时刻只使用优先级最高的可用 Key（列表第 1 位=主 Key），主 Key 限流退避或额度受限才切换到备 Key，恢复后自动回主。对外始终呈现单一账号特征，最不容易触发上游风控。绝大多数场景推荐保持此策略。" },
  "round-robin": { label: "轮询", desc: "在全部可用 Key 之间依次轮流分配请求，均摊使用量。多账号同时活跃会改变账号行为特征，风控风险相对更高；仅在确需均摊额度时使用。" },
  "least-usage": { label: "最少用量优先", desc: "每次选择最近 5 小时 token 消耗最少的可用 Key，自动向空闲账号倾斜。同样属于多账号并发模式，风控特征与轮询类似。" },
};
const MS_FIELDS = ["sameKeyRetryDelayMs", "sameKeyRetryMaxWaitMs", "backoffBaseMs", "backoffMaxMs", "connectTimeoutMs", "failoverCooldownMs", "quotaRefreshMs", "quotaRefreshGapMs"];
function renderSettings() {
  const p = (state.pool && state.pool.poolCfg) || {};
  let html = "<h2>设置</h2>";
  html += '<div class="card mb">' +
    "<h3>池与退避</h3>" +
    '<div class="filters">' +
    field("strategy", "选 Key 策略", "select", Object.keys(STRATEGY_INFO), p.strategy) +
    field("maxRetries", "最大重试次数", "number", null, p.maxRetries) +
    field("sameKeyRetryCount", "同 Key 重试次数", "number", null, p.sameKeyRetryCount) +
    fieldSec("sameKeyRetryDelayMs", "同 Key 重试间隔（秒）", p.sameKeyRetryDelayMs) +
    fieldSec("sameKeyRetryMaxWaitMs", "同 Key 重试最大等待（秒）", p.sameKeyRetryMaxWaitMs) +
    fieldSec("backoffBaseMs", "退避基数（秒）", p.backoffBaseMs) +
    fieldSec("backoffMaxMs", "退避上限（秒）", p.backoffMaxMs) +
    fieldSec("connectTimeoutMs", "上游响应头超时（秒）", p.connectTimeoutMs) +
    fieldSec("failoverCooldownMs", "切换冷却（秒）", p.failoverCooldownMs) +
    field("fiveHourHardStop", "5h 硬阈值 %", "number", null, p.fiveHourHardStop) +
    field("weeklyHardStop", "每周硬阈值 %", "number", null, p.weeklyHardStop) +
    field("softStop", "软限制阈值 %", "number", null, p.softStop) +
    fieldSec("quotaRefreshMs", "额度自动刷新间隔（秒）", p.quotaRefreshMs) +
    fieldSec("quotaRefreshGapMs", "多 Key 刷新间隔（秒）", p.quotaRefreshGapMs) +
    field("historyRetentionDays", "历史保留天数", "number", null, p.historyRetentionDays) +
    "</div>" +
    '<div class="row mt"><label style="margin:0"><input type="checkbox" id="f-zeroOutputCountsAs429" ' + (p.zeroOutputCountsAs429 ? "checked" : "") + '> 零输出计入 429</label></div>' +
    '<div class="mt"><button id="btn-save-pool">保存池配置</button> <span id="pool-msg"></span></div>' +
    "</div>";
  html += '<div class="card mb"><h3>选 Key 策略说明</h3><table class="strategy-table"><thead><tr><th>策略</th><th>说明</th></tr></thead><tbody>' +
    Object.entries(STRATEGY_INFO).map(([k, v]) =>
      "<tr><td><b>" + esc(v.label) + "</b><div class='muted small mono'>" + esc(k) + "</div></td><td class='small'>" + esc(v.desc) + "</td></tr>"
    ).join("") +
    "</tbody></table></div>";
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

function fieldSec(id, label, msValue) {
  const sec = msValue != null ? Math.round(Number(msValue) / 100) / 10 : "";
  return '<div><label>' + esc(label) + '</label><input id="f-' + id + '" type="number" step="any" min="0" value="' + esc(sec) + '"></div>';
}

function field(id, label, type, options, value) {
  let input;
  if (type === "select") {
    input = '<select id="f-' + id + '">' + options.map((o) => {
      const text = (id === "strategy" && STRATEGY_INFO[o]) ? STRATEGY_INFO[o].label : o;
      return '<option value="' + o + '"' + (o === value ? " selected" : "") + ">" + esc(text) + "</option>";
    }).join("") + "</select>";
  } else {
    input = '<input id="f-' + id + '" type="' + type + '" value="' + esc(value ?? "") + '">';
  }
  return '<div><label>' + esc(label) + "</label>" + input + "</div>";
}

async function savePool() {
  const ids = ["strategy", "maxRetries", "sameKeyRetryCount", "fiveHourHardStop", "weeklyHardStop", "softStop", "historyRetentionDays"];
  const body = {};
  for (const id of ids) {
    const el = document.getElementById("f-" + id);
    if (!el) continue;
    body[id] = el.type === "number" ? Number(el.value) : el.value;
  }
  // 秒显示字段换算回毫秒
  for (const id of MS_FIELDS) {
    const el = document.getElementById("f-" + id);
    if (!el) continue;
    const sec = Number(el.value);
    if (Number.isFinite(sec) && sec >= 0) body[id] = Math.round(sec * 1000);
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

// ── 日志 ──（DESIGN §6：按 Key 过滤；SSE log 事件与轮询共用同一渲染；
// 来源含 manager 自身事件与上游 proxy.mjs 捕获日志）
function renderLogs() {
  const sel = state.logFilterKeyId || "";
  const src = state.logFilterSrc || "";
  let filtered = src ? state.logs.filter((l) => (l.src || "manager") === src) : state.logs;
  filtered = sel ? filtered.filter((l) => l.msg.includes(sel)) : filtered;
  app.innerHTML = "<h2>日志</h2>" +
    '<div class="card mb"><div class="row">' +
    '<div><label>来源</label><select id="log-src-filter"><option value="">全部</option>' +
    '<option value="manager"' + (src === "manager" ? " selected" : "") + ">管理网关</option>" +
    '<option value="proxy"' + (src === "proxy" ? " selected" : "") + ">上游代理</option></select></div>" +
    '<div><label>按 Key 过滤</label><select id="log-filter"><option value="">全部</option>' +
    state.keys.map((k) => '<option value="' + esc(k.id) + '"' + (k.id === sel ? " selected" : "") + ">" + esc(k.alias || k.maskedKey) + "</option>").join("") +
    "</select></div></div></div>" +
    '<div class="card"><div class="log-list" id="log-list">' +
    filtered.map((l) => {
      const lvl = l.level || "info";
      const lvCls = lvl === "error" ? "lv-error" : lvl === "warn" ? "lv-warn" : "";
      return '<div class="' + lvCls + '"><span class="badge log-src">' + (l.src === "proxy" ? "上游" : "网关") + "</span>[" + fmtTime(l.ts) + "] " + esc(l.msg) + "</div>";
    }).join("") +
    "</div></div>";
  document.getElementById("log-src-filter").addEventListener("change", (e) => {
    state.logFilterSrc = e.target.value;
    renderLogs();
  });
  document.getElementById("log-filter").addEventListener("change", (e) => {
    state.logFilterKeyId = e.target.value;
    renderLogs();
  });
}

function logKey(l) { return l.ts + "|" + (l.src || "manager") + "|" + l.msg; }
function pushLogs(incoming) {
  // SSE 与轮询双通道写入，按 ts+msg 去重合并（同毫秒竞态下时间游标不可靠）
  const seen = new Set(state.logs.map(logKey));
  for (const l of incoming) {
    const k = logKey(l);
    if (seen.has(k)) continue;
    seen.add(k);
    state.logs.push(l);
  }
  state.logs.sort((a, b) => a.ts - b.ts);
  if (state.logs.length > 500) state.logs = state.logs.slice(-500);
  if (state.logs.length) state.lastLogTs = state.logs[state.logs.length - 1].ts;
}

async function loadLogs() {
  const data = await api("/admin/api/logs?since=" + (state.lastLogTs ? state.lastLogTs - 2000 : 0));
  pushLogs(data.logs);
  if (state.view === "logs") {
    renderLogs();
    const el = document.getElementById("log-list");
    if (el) el.scrollTop = el.scrollHeight;
  }
}

// ── 事件委托（P2-7：替代内联 onclick/ontoggle，配合 CSP script-src 'self'）──
// 动作名 → 既有函数一一映射；监听注册在 document 上（模块顶层一次），
// 渲染以 innerHTML 替换 #app 不影响委托。toggleKey 原签名接收 Key 对象，按 id 查找回等。
const KEY_ACTIONS = {
  "refresh-quota": (id) => refreshKeyQuota(id),
  "toggle": (id) => { const k = state.keys.find((x) => x.id === id); if (k) toggleKey(k); },
  "delete": (id) => delKey(id),
  "test": (id) => testKey(id),
  "move-up": (id) => moveKey(id, -1),
  "move-down": (id) => moveKey(id, 1)
};
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const fn = KEY_ACTIONS[el.dataset.act];
  if (fn) fn(el.dataset.id);
});
// toggle 事件不冒泡，必须捕获阶段监听；details 由 data-usage 携带 key id。
// 维持 usageOpen 跨渲染展开态（与原内联 ccpmUsageToggle(id, this.open) 行为等价）。
document.addEventListener("toggle", (e) => {
  const el = e.target.closest && e.target.closest("details[data-usage]");
  if (!el) return;
  const id = el.dataset.usage;
  if (el.open) usageOpen[id] = true; else delete usageOpen[id];
}, true);

// ── 启动 ──
window.addEventListener("hashchange", () => {
  state.view = location.hash.slice(2) || "dashboard";
  if (state.view === "history") loadHistory().catch(() => {});
  if (state.view === "logs") { loadLogs().catch(() => {}); startLogPoller(); }
  else stopLogPoller();
  render();
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  try { await fetch("/admin/api/logout", { method: "POST" }); } catch {} // 撤销 HttpOnly SSE cookie
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
// 鉴权走登录时下发的 HttpOnly 专用 cookie（同源请求自动携带，URL 不含令牌）。
// 10s tick 与日志轮询保留为断线兜底。
let eventSource = null;
let statsDebounce = null;
let quotaRenderTimer = null;
function startEventStream() {
  if (eventSource) { try { eventSource.close(); } catch {} }
  try {
    eventSource = new EventSource("/admin/api/events");
  } catch { return; }
  // cookie 缺失/过期（如服务端换过令牌）时持续 401：关掉重试，轮询通道兜底
  let sseErrors = 0;
  eventSource.onerror = () => {
    if (++sseErrors >= 3) { try { eventSource.close(); } catch {} eventSource = null; }
  };
  eventSource.onopen = () => { sseErrors = 0; };
  eventSource.addEventListener("log", (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (!d) return;
    pushLogs([d]); // 与轮询共用去重合并（防双通道竞态产生重复两条）
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
  // 后端探测串行队列的即时状态：updating/testing 显示徽标，done/error/idle 清除
  eventSource.addEventListener("quota-status", (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (!d || !d.keyId) return;
    if (d.phase === "updating" || d.phase === "testing") setBusy(d.keyId, d.phase);
    else clearBusy(d.keyId);
    if (state.view === "dashboard" || state.view === "keys") render();
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
    // 直接刷新进日志页时立即拉一次，否则要等 3s 轮询首跳才见内容
    if (state.view === "logs") loadLogs().catch(() => {});
    render();
  })();
}
