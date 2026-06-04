/* ===========================================================
   FiTrack — application logic (dependency-free)
   Talks to Supabase (Auth + PostgREST) over plain fetch.
   =========================================================== */
"use strict";

const CFG = window.FITRACK_CONFIG;
const AUTH_URL = CFG.SUPABASE_URL + "/auth/v1";
const REST_URL = CFG.SUPABASE_URL + "/rest/v1";
const SKEY = "fitrack.session.v1";

/* ---------- tiny DOM helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const el = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function toast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2400);
}

/* ===========================================================
   Auth (GoTrue)
   =========================================================== */
let session = null;

function saveSession(s) {
  session = s;
  if (s) localStorage.setItem(SKEY, JSON.stringify(s));
  else localStorage.removeItem(SKEY);
}
function readStoredSession() {
  try { return JSON.parse(localStorage.getItem(SKEY)); } catch { return null; }
}
function setSessionFromToken(d) {
  saveSession({
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: Date.now() + (d.expires_in || 3600) * 1000,
    user: d.user,
  });
}

async function authFetch(path, body, method = "POST") {
  const res = await fetch(AUTH_URL + path, {
    method,
    headers: { apikey: CFG.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(data.error_description || data.msg || data.message || "Authentication failed");
  return data;
}

async function signUp(email, password) {
  // Create an already-confirmed account via the FiTrack sign-up function
  // (no confirmation-email round trip), then sign in immediately.
  const res = await fetch(`${CFG.SUPABASE_URL}/functions/v1/fitrack-signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: CFG.SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Could not create the account.");
  await signIn(email, password);
  return { confirmed: true };
}
async function signIn(email, password) {
  const data = await authFetch("/token?grant_type=password", { email, password });
  setSessionFromToken(data);
  return data;
}
async function refreshSession() {
  if (!session?.refresh_token) throw new Error("no session");
  const d = await authFetch("/token?grant_type=refresh_token", {
    refresh_token: session.refresh_token,
  });
  setSessionFromToken(d);
  return session;
}
async function ensureValidToken() {
  if (!session) return null;
  if (Date.now() > session.expires_at - 60000) {
    try { await refreshSession(); }
    catch { saveSession(null); return null; }
  }
  return session;
}
async function signOut() {
  try {
    await fetch(AUTH_URL + "/logout", { method: "POST", headers: restHeaders() });
  } catch {}
  saveSession(null);
  location.reload();
}

/* ===========================================================
   Data layer (PostgREST against the `fitrack` schema)
   =========================================================== */
function restHeaders(extra = {}) {
  return Object.assign(
    {
      apikey: CFG.SUPABASE_ANON_KEY,
      Authorization: "Bearer " + (session?.access_token || CFG.SUPABASE_ANON_KEY),
    },
    extra
  );
}
async function db(method, path, { body, prefer } = {}) {
  await ensureValidToken();
  const headers = restHeaders({ "Content-Type": "application/json" });
  const profileHeader = method === "GET" || method === "HEAD" ? "Accept-Profile" : "Content-Profile";
  headers[profileHeader] = CFG.SCHEMA;
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(REST_URL + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && (data.message || data.hint)) || `Request failed (${res.status})`);
  return data;
}
const api = {
  select: (t, q = "") => db("GET", `/${t}?${q}`),
  insert: (t, row) => db("POST", `/${t}`, { body: row, prefer: "return=representation" }),
  update: (t, q, patch) => db("PATCH", `/${t}?${q}`, { body: patch, prefer: "return=representation" }),
  remove: (t, q) => db("DELETE", `/${t}?${q}`),
  rpc: async (fn, args) => {
    const r = await db("POST", `/rpc/${fn}`, { body: args, prefer: "return=representation" });
    return Array.isArray(r) ? r[0] : r;
  },
};

/* ===========================================================
   App state
   =========================================================== */
const state = {
  household: null,
  members: [],
  accounts: [],
  categories: [],
  transactions: [],
  goals: [],
  recurring: [],
  me: null,
  scope: "month", // 'month' | 'year'
  cursor: new Date(),
  memberFilter: "all",
};

async function loadAll() {
  const hh = await api.select("households", "select=*&limit=1");
  if (!hh.length) { state.household = null; return false; }
  state.household = hh[0];
  const id = hh[0].id;
  const [members, accounts, categories, goals, transactions, recurring] = await Promise.all([
    api.select("members", `household_id=eq.${id}&order=created_at`),
    api.select("accounts", `household_id=eq.${id}&order=sort,created_at`),
    api.select("categories", `household_id=eq.${id}&order=kind.desc,sort`),
    api.select("goals", `household_id=eq.${id}&order=sort,created_at`),
    api.select("transactions", `household_id=eq.${id}&order=occurred_on.desc,created_at.desc`),
    api.select("recurring", `household_id=eq.${id}&order=next_date`),
  ]);
  state.members = members;
  state.accounts = accounts;
  state.categories = categories;
  state.goals = goals;
  state.transactions = transactions;
  state.recurring = recurring;
  state.me = members.find((m) => m.user_id === session.user.id) || null;
  return true;
}
async function reload() {
  await loadAll();
  render();
}

/* ===========================================================
   Formatting & period maths
   =========================================================== */
function fmt(n, short = false) {
  const cur = state.household?.currency || "USD";
  const abs = Math.abs(n || 0);
  const opts = short && abs >= 10000
    ? { maximumFractionDigits: 0 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, ...opts }).format(n || 0);
  } catch {
    return (cur + " ") + (n || 0).toFixed(2);
  }
}
const pad = (n) => String(n).padStart(2, "0");
const dateStr = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTHS_LONG = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function periodBounds() {
  const y = state.cursor.getFullYear(), m = state.cursor.getMonth() + 1;
  if (state.scope === "month")
    return { from: dateStr(y, m, 1), to: dateStr(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) };
  return { from: dateStr(y, 1, 1), to: dateStr(y + 1, 1, 1) };
}
function periodLabel() {
  const y = state.cursor.getFullYear();
  return state.scope === "month" ? `${MONTHS_LONG[state.cursor.getMonth()]} ${y}` : `${y}`;
}
function shiftPeriod(dir) {
  const d = new Date(state.cursor);
  if (state.scope === "month") d.setMonth(d.getMonth() + dir);
  else d.setFullYear(d.getFullYear() + dir);
  state.cursor = d;
}
function matchesMember(t) {
  return state.memberFilter === "all" || t.member_id === state.memberFilter;
}
function periodTx() {
  const { from, to } = periodBounds();
  return state.transactions.filter(
    (t) => t.occurred_on >= from && t.occurred_on < to && matchesMember(t)
  );
}

/* ----- derived figures ----- */
function accountBalances() {
  const map = {};
  for (const a of state.accounts) map[a.id] = Number(a.opening_balance) || 0;
  for (const t of state.transactions) {
    const amt = Number(t.amount) || 0;
    if (t.kind === "income" && t.account_id != null && map[t.account_id] != null) map[t.account_id] += amt;
    else if (t.kind === "expense" && t.account_id != null && map[t.account_id] != null) map[t.account_id] -= amt;
    else if (t.kind === "transfer") {
      if (t.account_id != null && map[t.account_id] != null) map[t.account_id] -= amt;
      if (t.transfer_account_id != null && map[t.transfer_account_id] != null) map[t.transfer_account_id] += amt;
    }
  }
  return map;
}
function periodTotals() {
  let income = 0, expense = 0;
  for (const t of periodTx()) {
    if (t.kind === "income") income += Number(t.amount) || 0;
    else if (t.kind === "expense") expense += Number(t.amount) || 0;
  }
  return { income, expense, net: income - expense };
}
function monthlySeries(year) {
  const out = Array.from({ length: 12 }, (_, m) => ({ m, income: 0, expense: 0 }));
  for (const t of state.transactions) {
    if (!matchesMember(t)) continue;
    if (t.occurred_on.slice(0, 4) !== String(year)) continue;
    const mi = parseInt(t.occurred_on.slice(5, 7), 10) - 1;
    if (t.kind === "income") out[mi].income += Number(t.amount) || 0;
    else if (t.kind === "expense") out[mi].expense += Number(t.amount) || 0;
  }
  return out;
}
function spendingByCategory() {
  const totals = {};
  for (const t of periodTx()) {
    if (t.kind !== "expense") continue;
    const k = t.category_id || "none";
    totals[k] = (totals[k] || 0) + (Number(t.amount) || 0);
  }
  return totals;
}

/* ===========================================================
   Lookups
   =========================================================== */
const catById = (id) => state.categories.find((c) => c.id === id);
const accById = (id) => state.accounts.find((a) => a.id === id);
const memById = (id) => state.members.find((m) => m.id === id);

/* ===========================================================
   Screen switching
   =========================================================== */
function show(screen) {
  el("auth").hidden = screen !== "auth";
  el("onboard").hidden = screen !== "onboard";
  el("app").hidden = screen !== "app";
}

/* ===========================================================
   Dashboard rendering
   =========================================================== */
function render() {
  if (!state.household) { show("onboard"); return; }
  show("app");
  renderTopbar();
  el("dash").innerHTML =
    kpiRow() +
    trendCard() +
    accountsCard() +
    spendingCard() +
    transactionsCard() +
    recurringCard() +
    goalsCard();
}

function renderTopbar() {
  el("period-label").textContent = periodLabel();
  $$("#app .scope-toggle button").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.scope === state.scope)
  );
  // member filter chips
  const chips = [`<button class="chip ${state.memberFilter === "all" ? "is-active" : ""}" data-action="filter-member" data-id="all">Everyone</button>`]
    .concat(
      state.members.map(
        (m) =>
          `<button class="chip ${state.memberFilter === m.id ? "is-active" : ""}" data-action="filter-member" data-id="${m.id}"><span class="dot" style="background:${esc(m.color)}"></span>${esc(m.display_name)}</button>`
      )
    );
  el("member-filter").innerHTML = state.members.length > 1 ? chips.join("") : "";
}

function kpiRow() {
  const { income, expense, net } = periodTotals();
  const balances = accountBalances();
  const worth = state.accounts.filter((a) => !a.archived).reduce((s, a) => s + (balances[a.id] || 0), 0);
  const rate = income > 0 ? Math.round((net / income) * 100) : 0;
  const card = (label, value, cls, meta, dot) => `
    <section class="card col-3">
      <div class="kpi">
        <div class="kpi-label">${dot ? `<span class="kpi-accent" style="background:${dot}"></span>` : ""}${label}</div>
        <div class="kpi-value num ${cls || ""}">${value}</div>
        <div class="kpi-meta">${meta}</div>
      </div>
    </section>`;
  const scopeWord = state.scope === "month" ? "this month" : "this year";
  return (
    card("Income", fmt(income, true), "pos", scopeWord, "var(--pos)") +
    card("Spending", fmt(expense, true), "neg", scopeWord, "var(--neg)") +
    card("Saved", fmt(net, true), net >= 0 ? "pos" : "neg", income > 0 ? `${rate}% of income kept` : scopeWord, "var(--accent)") +
    card("Net worth", fmt(worth, true), "", "across all accounts", "var(--ink-2)")
  );
}

function trendCard() {
  const year = state.cursor.getFullYear();
  const series = monthlySeries(year);
  const max = Math.max(1, ...series.map((s) => Math.max(s.income, s.expense)));
  const W = 720, H = 210, pad = 22, bw = 9, gap = 4;
  const slot = (W - pad * 2) / 12;
  const curMonth = state.scope === "month" ? state.cursor.getMonth() : -1;
  let bars = "";
  series.forEach((s, i) => {
    const cx = pad + slot * i + slot / 2;
    const ih = (s.income / max) * (H - 50);
    const eh = (s.expense / max) * (H - 50);
    const base = H - 26;
    const active = i === curMonth;
    bars += `
      <g opacity="${active || curMonth < 0 ? 1 : 0.5}">
        <rect x="${cx - bw - gap / 2}" y="${base - ih}" width="${bw}" height="${Math.max(0, ih)}" rx="3" fill="var(--pos)"></rect>
        <rect x="${cx + gap / 2}" y="${base - eh}" width="${bw}" height="${Math.max(0, eh)}" rx="3" fill="var(--neg)"></rect>
        <text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="11" fill="${active ? "var(--ink)" : "var(--ink-3)"}" font-weight="${active ? 600 : 400}">${MONTHS[i]}</text>
      </g>`;
  });
  return `
    <section class="card col-8">
      <div class="card-head">
        <span class="card-title">Cashflow · ${year}</span>
        <span class="legend"><span><i style="background:var(--pos)"></i>In</span><span><i style="background:var(--neg)"></i>Out</span></span>
      </div>
      <div class="chart-wrap">
        <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Monthly cashflow">
          ${bars}
        </svg>
      </div>
    </section>`;
}

function donutSvg(segments, total, centerSmall) {
  const r = 54, c = 2 * Math.PI * r, size = 130;
  let off = 0;
  let arcs = "";
  if (total <= 0) {
    arcs = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="16"></circle>`;
  } else {
    for (const s of segments) {
      const frac = s.value / total;
      const len = frac * c;
      arcs += `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${s.color}" stroke-width="16"
        stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${size / 2} ${size / 2})"></circle>`;
      off += len;
    }
  }
  return `
    <div class="donut" style="width:${size}px;height:${size}px">
      <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${arcs}</svg>
      <div class="donut-center"><div class="big num">${fmt(total, true)}</div><div class="small">${centerSmall}</div></div>
    </div>`;
}

function spendingCard() {
  const totals = spendingByCategory();
  const expCats = state.categories
    .filter((c) => c.kind === "expense")
    .map((c) => ({ cat: c, spent: totals[c.id] || 0 }))
    .filter((x) => x.spent > 0 || (x.cat.monthly_budget && state.scope === "month"))
    .sort((a, b) => b.spent - a.spent);
  const grandTotal = Object.values(totals).reduce((s, v) => s + v, 0);

  const segs = expCats.filter((x) => x.spent > 0).slice(0, 8).map((x) => ({ value: x.spent, color: x.cat.color }));
  const budgetMult = state.scope === "year" ? 12 : 1;

  const rows = expCats
    .map((x) => {
      const budget = x.cat.monthly_budget ? Number(x.cat.monthly_budget) * budgetMult : null;
      const pct = budget ? Math.min(100, (x.spent / budget) * 100) : grandTotal ? (x.spent / grandTotal) * 100 : 0;
      const over = budget && x.spent > budget;
      return `
        <div class="catrow">
          <div class="name"><span class="dot" style="background:${esc(x.cat.color)}"></span>${esc(x.cat.name)}</div>
          <div class="amt num ${over ? "neg" : ""}">${fmt(x.spent)}</div>
          <div class="bar ${over ? "over" : ""}"><span style="width:${pct}%;background:${esc(x.cat.color)}"></span></div>
          ${budget ? `<div class="cat-budget">${over ? "Over by " + fmt(x.spent - budget) : fmt(budget - x.spent) + " left"} · budget ${fmt(budget)}</div>` : ""}
        </div>`;
    })
    .join("");

  const body = expCats.length
    ? `<div class="donut-wrap">${donutSvg(segs, grandTotal, "spent")}<div style="flex:1;min-width:0">${
        segs.slice(0, 4).map((s, i) => {
          const x = expCats.filter((e) => e.spent > 0)[i];
          return `<div class="catrow" style="grid-template-columns:1fr auto;margin-bottom:8px"><div class="name"><span class="dot" style="background:${esc(x.cat.color)}"></span>${esc(x.cat.name)}</div><div class="amt num">${grandTotal ? Math.round((x.spent / grandTotal) * 100) : 0}%</div></div>`;
        }).join("")
      }</div></div><div class="catlist" style="margin-top:18px">${rows}</div>`
    : `<div class="empty"><div class="big">○</div>No spending recorded yet.<br/>Tap <b>+ Add</b> to log one.</div>`;

  return `
    <section class="card col-5">
      <div class="card-head"><span class="card-title">Spending & budgets</span><span class="card-sub">${periodLabel()}</span></div>
      ${body}
    </section>`;
}

function accountsCard() {
  const balances = accountBalances();
  const accs = state.accounts.filter((a) => !a.archived);
  const icon = { checking: "🏦", savings: "🐖", cash: "💵", credit: "💳", investment: "📈", other: "◈" };
  const rows = accs.length
    ? accs
        .map((a) => {
          const b = balances[a.id] || 0;
          return `
          <div class="line-row">
            <div class="lr-name"><span class="acct-icon">${icon[a.type] || "◈"}</span><div><div>${esc(a.name)}</div><div class="lr-sub">${esc(a.type)}</div></div></div>
            <div class="num ${b < 0 ? "neg" : ""}" style="font-weight:560">${fmt(b)}</div>
          </div>`;
        })
        .join("")
    : `<div class="empty">No accounts yet.</div>`;
  return `
    <section class="card col-4">
      <div class="card-head"><span class="card-title">Accounts</span><button class="btn btn-ghost btn-sm" data-action="open-settings-tab" data-tab="accounts">Manage</button></div>
      ${rows}
    </section>`;
}

function freqLabel(r) {
  const unit = r.frequency === "weekly" ? "week" : r.frequency === "yearly" ? "year" : "month";
  return r.every_n === 1 ? `Every ${unit}` : `Every ${r.every_n} ${unit}s`;
}
function monthlyEquivalent(r) {
  const a = Number(r.amount) || 0;
  if (r.frequency === "weekly") return (a * 52) / 12 / r.every_n;
  if (r.frequency === "yearly") return a / 12 / r.every_n;
  return a / r.every_n;
}
function recurringCard() {
  const rules = state.recurring.filter((r) => state.memberFilter === "all" || r.member_id === state.memberFilter);
  if (!rules.length) {
    return `
      <section class="card col-6">
        <div class="card-head"><span class="card-title">Recurring</span><button class="btn btn-ghost btn-sm" data-action="open-settings-tab" data-tab="recurring">+ Add</button></div>
        <div class="empty">Rent, subscriptions, salary — set them once and FiTrack logs them automatically. <a href="#" data-action="open-settings-tab" data-tab="recurring">Add a recurring item.</a></div>
      </section>`;
  }
  const active = rules.filter((r) => r.active);
  const monthlyOut = active.filter((r) => r.kind === "expense").reduce((s, r) => s + monthlyEquivalent(r), 0);
  const monthlyIn = active.filter((r) => r.kind === "income").reduce((s, r) => s + monthlyEquivalent(r), 0);
  const rows = rules
    .slice()
    .sort((a, b) => (a.next_date < b.next_date ? -1 : 1))
    .map((r) => {
      const cat = catById(r.category_id);
      const sign = r.kind === "income" ? "+" : r.kind === "expense" ? "−" : "";
      const cls = r.kind === "income" ? "pos" : r.kind === "expense" ? "neg" : "";
      const color = cat ? cat.color : "var(--ink-3)";
      const title = r.note || (cat ? cat.name : r.kind === "income" ? "Income" : r.kind === "transfer" ? "Transfer" : "Expense");
      return `
        <div class="line-row" data-action="edit-recurring" data-id="${r.id}" style="cursor:pointer;${r.active ? "" : "opacity:.5"}">
          <div class="lr-name"><span style="width:9px;height:9px;border-radius:3px;background:${esc(color)};flex:none"></span>
            <div><div>${esc(title)}</div><div class="lr-sub">${freqLabel(r)} · next ${fmtDay(r.next_date)}${r.active ? "" : " · paused"}</div></div></div>
          <div class="num ${cls}" style="font-weight:560">${sign}${fmt(r.amount)}</div>
        </div>`;
    })
    .join("");
  const foot = [monthlyOut ? `~${fmt(monthlyOut)} / mo out` : "", monthlyIn ? `~${fmt(monthlyIn)} / mo in` : ""].filter(Boolean).join(" · ");
  return `
    <section class="card col-6">
      <div class="card-head"><span class="card-title">Recurring</span><button class="btn btn-ghost btn-sm" data-action="open-settings-tab" data-tab="recurring">Manage</button></div>
      ${rows}
      ${foot ? `<div class="cat-budget" style="margin-top:12px;border-top:1px solid var(--line);padding-top:12px">${foot}</div>` : ""}
    </section>`;
}

function goalsCard() {
  if (!state.goals.length) {
    return `
      <section class="card col-6">
        <div class="card-head"><span class="card-title">Savings goals</span><button class="btn btn-ghost btn-sm" data-action="open-settings-tab" data-tab="goals">+ Add a goal</button></div>
        <div class="empty">Set aside for a holiday, a home, a rainy day. <a href="#" data-action="open-settings-tab" data-tab="goals">Create your first goal.</a></div>
      </section>`;
  }
  const items = state.goals
    .map((g) => {
      const pct = g.target_amount > 0 ? Math.min(100, (g.current_amount / g.target_amount) * 100) : 0;
      return `
      <div class="goal" style="${state.goals.length > 1 ? "flex:1;min-width:220px" : ""}">
        <div class="goal-head"><span>${esc(g.name)}</span><span class="num">${fmt(g.current_amount, true)} <span style="color:var(--ink-3)">/ ${fmt(g.target_amount, true)}</span></span></div>
        <div class="bar"><span style="width:${pct}%;background:${esc(g.color)}"></span></div>
        ${g.target_date ? `<div class="cat-budget" style="margin-top:6px">Target ${esc(g.target_date)} · ${Math.round(pct)}% there</div>` : `<div class="cat-budget" style="margin-top:6px">${Math.round(pct)}% there</div>`}
      </div>`;
    })
    .join("");
  return `
    <section class="card col-6">
      <div class="card-head"><span class="card-title">Savings goals</span><button class="btn btn-ghost btn-sm" data-action="open-settings-tab" data-tab="goals">Manage</button></div>
      <div style="display:flex;gap:24px;flex-wrap:wrap">${items}</div>
    </section>`;
}

function txGlyph(t) {
  if (t.kind === "income") return { ch: "↑", bg: "color-mix(in srgb, var(--pos) 16%, transparent)", fg: "var(--pos)" };
  if (t.kind === "transfer") return { ch: "⇄", bg: "var(--surface-2)", fg: "var(--ink-2)" };
  const c = catById(t.category_id);
  return { ch: "↓", bg: c ? `color-mix(in srgb, ${c.color} 16%, transparent)` : "var(--surface-2)", fg: c ? c.color : "var(--neg)" };
}
function txTitle(t) {
  if (t.note) return t.note;
  if (t.kind === "transfer") return `${accById(t.account_id)?.name || "?"} → ${accById(t.transfer_account_id)?.name || "?"}`;
  return catById(t.category_id)?.name || (t.kind === "income" ? "Income" : "Expense");
}
function fmtDay(s) {
  const [y, m, d] = s.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}
function transactionsCard() {
  const list = periodTx();
  const rows = list.length
    ? list
        .slice(0, 60)
        .map((t) => {
          const g = txGlyph(t);
          const m = memById(t.member_id);
          const acc = accById(t.account_id);
          const sign = t.kind === "income" ? "+" : t.kind === "expense" ? "−" : "";
          const amtCls = t.kind === "income" ? "pos" : t.kind === "expense" ? "neg" : "";
          return `
          <div class="tx" data-action="edit-tx" data-id="${t.id}">
            <div class="tx-ic" style="background:${g.bg};color:${g.fg}">${g.ch}</div>
            <div class="tx-main">
              <div class="tx-title">${esc(txTitle(t))}</div>
              <div class="tx-meta">
                <span>${fmtDay(t.occurred_on)}</span>
                ${acc ? `<span>· ${esc(acc.name)}</span>` : ""}
                ${m && state.members.length > 1 ? `<span class="mtag">· <span class="dot" style="background:${esc(m.color)}"></span>${esc(m.display_name)}</span>` : ""}
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:6px">
              <div class="tx-amt num ${amtCls}">${sign}${fmt(t.amount)}</div>
              <div class="tx-actions">
                <button class="icon-btn" data-action="del-tx" data-id="${t.id}" title="Delete">✕</button>
              </div>
            </div>
          </div>`;
        })
        .join("")
    : `<div class="empty"><div class="big">✦</div>Nothing logged for ${esc(periodLabel())}.<br/>Add your first entry with <b>+ Add</b>.</div>`;
  return `
    <section class="card col-7">
      <div class="card-head"><span class="card-title">Transactions</span><span class="card-sub">${list.length} in ${esc(periodLabel())}</span></div>
      <div class="tx-list">${rows}</div>
    </section>`;
}

/* ===========================================================
   Modals
   =========================================================== */
function openModal(html, opts = {}) {
  const root = el("modal-root");
  root.innerHTML = `<div class="overlay" data-close="1"><div class="modal ${opts.lg ? "modal-lg" : ""}">${html}</div></div>`;
  root.querySelector(".overlay").addEventListener("mousedown", (e) => {
    if (e.target.dataset.close) closeModal();
  });
  document.addEventListener("keydown", escClose);
  if (opts.onMount) opts.onMount(root.querySelector(".modal"));
}
function closeModal() {
  el("modal-root").innerHTML = "";
  document.removeEventListener("keydown", escClose);
}
function escClose(e) { if (e.key === "Escape") closeModal(); }

/* ---------- Add / edit transaction ---------- */
function advanceDate(ymdStr, freq, n) {
  const [y, m, d] = ymdStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (freq === "weekly") dt.setDate(dt.getDate() + 7 * n);
  else if (freq === "yearly") dt.setFullYear(dt.getFullYear() + n);
  else dt.setMonth(dt.getMonth() + n);
  return dateStr(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}
function openTxModal(existing) {
  const t = existing || {
    kind: "expense",
    amount: "",
    occurred_on: dateStr(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate()),
    account_id: state.accounts.find((a) => !a.archived)?.id || null,
    transfer_account_id: null,
    category_id: null,
    member_id: state.me?.id || null,
    note: "",
  };
  let kind = t.kind;

  const accOpts = (sel) =>
    state.accounts.filter((a) => !a.archived).map((a) => `<option value="${a.id}" ${a.id === sel ? "selected" : ""}>${esc(a.name)}</option>`).join("");
  const catOpts = (k, sel) =>
    state.categories.filter((c) => c.kind === k && !c.archived).map((c) => `<option value="${c.id}" ${c.id === sel ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const memOpts = (sel) =>
    state.members.map((m) => `<option value="${m.id}" ${m.id === sel ? "selected" : ""}>${esc(m.display_name)}</option>`).join("");

  const repeatBlock = (existing && existing.recurring_id)
    ? `<div class="mini-row" style="background:var(--accent-soft);border-radius:11px;padding:10px 12px;margin-bottom:14px">
         <span class="grow" style="font-size:13.5px">🔁 Part of a recurring series</span>
         <button type="button" class="btn btn-sm" data-action="edit-recurring" data-id="${existing.recurring_id}">Manage series</button>
       </div>`
    : `<div class="modal-row">
         <label class="field"><span>Repeat</span><select id="tx-repeat">
           <option value="none">One-time</option>
           <option value="weekly">Weekly</option>
           <option value="monthly">Monthly</option>
           <option value="yearly">Yearly</option>
         </select></label>
         <label class="field" id="tx-every-wrap" hidden><span>Every</span><input id="tx-every" type="number" min="1" max="99" step="1" value="1" /></label>
       </div>`;

  const html = `
    <div class="modal-head">
      <h2>${existing ? "Edit entry" : "New entry"}</h2>
      <button class="icon-btn" data-close="1">✕</button>
    </div>
    <div class="type-seg">
      <button type="button" class="exp ${kind === "expense" ? "is-active" : ""}" data-kind="expense">Expense</button>
      <button type="button" class="inc ${kind === "income" ? "is-active" : ""}" data-kind="income">Income</button>
      <button type="button" class="tr ${kind === "transfer" ? "is-active" : ""}" data-kind="transfer">Transfer</button>
    </div>
    <form id="tx-form">
      <div class="amt-input"><span>${(state.household?.currency || "USD")}</span><input id="tx-amount" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="${t.amount || ""}" required /></div>
      <div class="modal-row">
        <label class="field"><span>Date</span><input id="tx-date" type="date" value="${t.occurred_on}" required /></label>
        <label class="field" id="tx-member-wrap"><span>Who</span><select id="tx-member">${memOpts(t.member_id)}</select></label>
      </div>
      <div id="tx-cat-wrap"></div>
      <div id="tx-acc-wrap"></div>
      <label class="field"><span>Note (optional)</span><input id="tx-note" type="text" maxlength="120" value="${esc(t.note || "")}" placeholder="e.g. Weekly groceries" /></label>
      ${repeatBlock}
      <div class="modal-actions">
        ${existing ? `<button type="button" class="btn btn-danger" data-action="del-tx-modal" data-id="${existing.id}">Delete</button>` : ""}
        <button type="submit" class="btn btn-primary">${existing ? "Save" : "Add"}</button>
      </div>
    </form>`;

  openModal(html, {
    onMount(m) {
      function paintFields() {
        const catWrap = $("#tx-cat-wrap", m);
        const accWrap = $("#tx-acc-wrap", m);
        if (kind === "transfer") {
          catWrap.innerHTML = "";
          accWrap.innerHTML = `<div class="modal-row">
            <label class="field"><span>From</span><select id="tx-acc">${accOpts(t.account_id)}</select></label>
            <label class="field"><span>To</span><select id="tx-acc2">${accOpts(t.transfer_account_id)}</select></label></div>`;
        } else {
          catWrap.innerHTML = `<label class="field"><span>Category</span><select id="tx-cat">${catOpts(kind, t.category_id)}</select></label>`;
          accWrap.innerHTML = `<label class="field"><span>Account</span><select id="tx-acc">${accOpts(t.account_id)}</select></label>`;
        }
      }
      paintFields();
      $$(".type-seg button", m).forEach((b) =>
        b.addEventListener("click", () => {
          kind = b.dataset.kind;
          $$(".type-seg button", m).forEach((x) => x.classList.toggle("is-active", x === b));
          paintFields();
        })
      );
      const repSel = $("#tx-repeat", m);
      if (repSel) repSel.addEventListener("change", () => {
        $("#tx-every-wrap", m).hidden = repSel.value === "none";
      });
      $("#tx-amount", m).focus();
      $("#tx-form", m).addEventListener("submit", async (e) => {
        e.preventDefault();
        const amount = parseFloat($("#tx-amount", m).value);
        if (!(amount >= 0)) return toast("Enter an amount");
        const row = {
          household_id: state.household.id,
          kind,
          amount,
          occurred_on: $("#tx-date", m).value,
          member_id: $("#tx-member", m).value || null,
          note: $("#tx-note", m).value.trim() || null,
          account_id: $("#tx-acc", m)?.value || null,
          transfer_account_id: kind === "transfer" ? $("#tx-acc2", m)?.value || null : null,
          category_id: kind === "transfer" ? null : $("#tx-cat", m)?.value || null,
        };
        if (kind === "transfer" && row.account_id === row.transfer_account_id)
          return toast("Pick two different accounts");
        const rep = repSel ? (repSel.value || "none") : "none";
        const everyN = Math.max(1, parseInt($("#tx-every", m)?.value, 10) || 1);
        try {
          e.submitter.disabled = true;
          let ruleId = null;
          if (rep !== "none") {
            // schedule the rule from the next date forward; this entry is occurrence #1
            const rule = await api.insert("recurring", {
              household_id: state.household.id,
              kind: row.kind, amount: row.amount,
              account_id: row.account_id, transfer_account_id: row.transfer_account_id,
              category_id: row.category_id, member_id: row.member_id, note: row.note,
              frequency: rep, every_n: everyN,
              next_date: advanceDate(row.occurred_on, rep, everyN),
              active: true,
            });
            ruleId = Array.isArray(rule) ? rule[0]?.id : rule?.id;
          }
          const payload = ruleId ? { ...row, recurring_id: ruleId } : row;
          if (existing) await api.update("transactions", `id=eq.${existing.id}`, payload);
          else await api.insert("transactions", payload);
          closeModal();
          await reload();
          toast(rep !== "none" ? (existing ? "Saved & scheduled to repeat" : "Added & scheduled to repeat") : (existing ? "Updated" : "Added"));
        } catch (err) { toast(err.message); }
      });
    },
  });
}

async function deleteTx(id) {
  try {
    await api.remove("transactions", `id=eq.${id}`);
    closeModal();
    await reload();
    toast("Deleted");
  } catch (e) { toast(e.message); }
}

/* ---------- Add / edit recurring rule ---------- */
function openRecurringModal(existing) {
  const today = dateStr(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
  const r = existing || {
    kind: "expense",
    amount: "",
    frequency: "monthly",
    every_n: 1,
    next_date: today,
    account_id: state.accounts.find((a) => !a.archived)?.id || null,
    transfer_account_id: null,
    category_id: null,
    member_id: state.me?.id || null,
    note: "",
    active: true,
  };
  let kind = r.kind;

  const accOpts = (sel) =>
    state.accounts.filter((a) => !a.archived).map((a) => `<option value="${a.id}" ${a.id === sel ? "selected" : ""}>${esc(a.name)}</option>`).join("");
  const catOpts = (k, sel) =>
    state.categories.filter((c) => c.kind === k && !c.archived).map((c) => `<option value="${c.id}" ${c.id === sel ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const memOpts = (sel) =>
    state.members.map((m) => `<option value="${m.id}" ${m.id === sel ? "selected" : ""}>${esc(m.display_name)}</option>`).join("");
  const freqOpt = (v, l, sel) => `<option value="${v}" ${v === sel ? "selected" : ""}>${l}</option>`;

  const html = `
    <div class="modal-head">
      <h2>${existing ? "Edit recurring" : "New recurring"}</h2>
      <button class="icon-btn" data-close="1">✕</button>
    </div>
    <div class="type-seg">
      <button type="button" class="exp ${kind === "expense" ? "is-active" : ""}" data-kind="expense">Expense</button>
      <button type="button" class="inc ${kind === "income" ? "is-active" : ""}" data-kind="income">Income</button>
      <button type="button" class="tr ${kind === "transfer" ? "is-active" : ""}" data-kind="transfer">Transfer</button>
    </div>
    <form id="rec-form">
      <div class="amt-input"><span>${state.household?.currency || "USD"}</span><input id="rec-amount" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="${r.amount || ""}" required /></div>
      <div class="modal-row">
        <label class="field"><span>Repeat</span><select id="rec-freq">
          ${freqOpt("weekly", "Weekly", r.frequency)}${freqOpt("monthly", "Monthly", r.frequency)}${freqOpt("yearly", "Yearly", r.frequency)}
        </select></label>
        <label class="field"><span>Every</span><input id="rec-every" type="number" min="1" max="99" step="1" value="${r.every_n || 1}" required /></label>
      </div>
      <div class="modal-row">
        <label class="field"><span>Next on</span><input id="rec-date" type="date" value="${r.next_date}" required /></label>
        <label class="field"><span>Who</span><select id="rec-member">${memOpts(r.member_id)}</select></label>
      </div>
      <div id="rec-cat-wrap"></div>
      <div id="rec-acc-wrap"></div>
      <label class="field"><span>Name (optional)</span><input id="rec-note" type="text" maxlength="120" value="${esc(r.note || "")}" placeholder="e.g. Rent, Netflix, Salary" /></label>
      <label class="mini-row" style="gap:8px"><input id="rec-active" type="checkbox" ${r.active ? "checked" : ""} style="width:auto" /> <span>Active (auto-logs on schedule)</span></label>
      <div class="modal-actions">
        ${existing ? `<button type="button" class="btn btn-danger" data-action="del-recurring-modal" data-id="${existing.id}">Delete</button>` : ""}
        <button type="submit" class="btn btn-primary">${existing ? "Save" : "Add"}</button>
      </div>
    </form>`;

  openModal(html, {
    onMount(m) {
      function paintFields() {
        const catWrap = $("#rec-cat-wrap", m);
        const accWrap = $("#rec-acc-wrap", m);
        if (kind === "transfer") {
          catWrap.innerHTML = "";
          accWrap.innerHTML = `<div class="modal-row">
            <label class="field"><span>From</span><select id="rec-acc">${accOpts(r.account_id)}</select></label>
            <label class="field"><span>To</span><select id="rec-acc2">${accOpts(r.transfer_account_id)}</select></label></div>`;
        } else {
          catWrap.innerHTML = `<label class="field"><span>Category</span><select id="rec-cat">${catOpts(kind, r.category_id)}</select></label>`;
          accWrap.innerHTML = `<label class="field"><span>Account</span><select id="rec-acc">${accOpts(r.account_id)}</select></label>`;
        }
      }
      paintFields();
      $$(".type-seg button", m).forEach((b) =>
        b.addEventListener("click", () => {
          kind = b.dataset.kind;
          $$(".type-seg button", m).forEach((x) => x.classList.toggle("is-active", x === b));
          paintFields();
        })
      );
      $("#rec-amount", m).focus();
      $("#rec-form", m).addEventListener("submit", async (e) => {
        e.preventDefault();
        const amount = parseFloat($("#rec-amount", m).value);
        if (!(amount >= 0)) return toast("Enter an amount");
        const row = {
          household_id: state.household.id,
          kind,
          amount,
          frequency: $("#rec-freq", m).value,
          every_n: Math.max(1, parseInt($("#rec-every", m).value, 10) || 1),
          next_date: $("#rec-date", m).value,
          member_id: $("#rec-member", m).value || null,
          note: $("#rec-note", m).value.trim() || null,
          active: $("#rec-active", m).checked,
          account_id: $("#rec-acc", m)?.value || null,
          transfer_account_id: kind === "transfer" ? $("#rec-acc2", m)?.value || null : null,
          category_id: kind === "transfer" ? null : $("#rec-cat", m)?.value || null,
        };
        if (kind === "transfer" && row.account_id === row.transfer_account_id)
          return toast("Pick two different accounts");
        try {
          e.submitter.disabled = true;
          if (existing) await api.update("recurring", `id=eq.${existing.id}`, row);
          else await api.insert("recurring", row);
          // catch up immediately if it's already due
          try { await api.rpc("run_recurring"); } catch {}
          closeModal();
          await reload();
          toast(existing ? "Saved" : "Recurring added");
        } catch (err) { toast(err.message); }
      });
    },
  });
}

async function deleteRecurring(id) {
  try {
    await api.remove("recurring", `id=eq.${id}`);
    closeModal();
    await reload();
    toast("Deleted");
  } catch (e) { toast(e.message); }
}

/* ---------- Settings ---------- */
const CURRENCIES = ["USD","EUR","GBP","CAD","AUD","JPY","CHF","CNY","INR","BRL","MXN","ZAR","SEK","NOK","DKK","PLN","SGD","HKD","NZD","AED"];
const SWATCHES = ["#6366f1","#10b981","#f59e0b","#ef4444","#0ea5e9","#8b5cf6","#ec4899","#14b8a6","#f97316","#22c55e","#64748b","#94a3b8"];

function openSettings(tab = "household") {
  const html = `
    <div class="modal-head"><h2>Settings</h2><button class="icon-btn" data-close="1">✕</button></div>
    <div id="settings-body"></div>
    <div class="settings-sec"><button class="btn btn-block" data-action="signout">Sign out</button></div>`;
  openModal(html, { lg: true, onMount: () => renderSettings(tab) });
}

function renderSettings(scrollTo) {
  const body = $("#settings-body");
  if (!body) return;
  const hh = state.household;

  const memberRows = state.members
    .map(
      (m) => `
    <div class="mini-row" data-mid="${m.id}">
      <input class="swatch" type="color" value="${esc(m.color)}" data-action="member-color" data-id="${m.id}" />
      <input class="grow" value="${esc(m.display_name)}" data-action="member-name" data-id="${m.id}" />
      <span class="lr-sub">${m.user_id === session.user.id ? "you" : m.role}</span>
    </div>`
    )
    .join("");

  const acctRows = state.accounts
    .map(
      (a) => `
    <div class="mini-row" data-aid="${a.id}">
      <input class="grow" value="${esc(a.name)}" data-action="acct-name" data-id="${a.id}" />
      <select data-action="acct-type" data-id="${a.id}">
        ${["checking","savings","cash","credit","investment","other"].map((tp) => `<option value="${tp}" ${a.type === tp ? "selected" : ""}>${tp}</option>`).join("")}
      </select>
      <input class="num" style="width:96px" type="number" step="0.01" value="${Number(a.opening_balance)}" data-action="acct-open" data-id="${a.id}" title="Opening balance" />
      <button class="icon-btn" data-action="acct-del" data-id="${a.id}" title="Delete">✕</button>
    </div>`
    )
    .join("");

  const catSection = (kind) =>
    state.categories
      .filter((c) => c.kind === kind)
      .map(
        (c) => `
      <div class="mini-row" data-cid="${c.id}">
        <input class="swatch" type="color" value="${esc(c.color)}" data-action="cat-color" data-id="${c.id}" />
        <input class="grow" value="${esc(c.name)}" data-action="cat-name" data-id="${c.id}" />
        ${kind === "expense" ? `<input class="num" style="width:96px" type="number" step="0.01" min="0" placeholder="budget" value="${c.monthly_budget != null ? Number(c.monthly_budget) : ""}" data-action="cat-budget" data-id="${c.id}" title="Monthly budget" />` : ""}
        <button class="icon-btn" data-action="cat-del" data-id="${c.id}" title="Delete">✕</button>
      </div>`
      )
      .join("");

  const recurringRows = state.recurring
    .map((r) => {
      const cat = catById(r.category_id);
      const title = r.note || (cat ? cat.name : r.kind === "income" ? "Income" : r.kind === "transfer" ? "Transfer" : "Expense");
      const sign = r.kind === "income" ? "+" : r.kind === "expense" ? "−" : "";
      return `
    <div class="mini-row" data-rid="${r.id}">
      <button type="button" class="btn btn-sm grow" style="justify-content:flex-start;text-align:left;font-weight:480" data-action="edit-recurring" data-id="${r.id}">
        ${esc(title)} · ${sign}${fmt(r.amount)} · ${freqLabel(r).toLowerCase()} · next ${fmtDay(r.next_date)}${r.active ? "" : " · paused"}
      </button>
      <button class="icon-btn" data-action="rec-del" data-id="${r.id}" title="Delete">✕</button>
    </div>`;
    })
    .join("");

  const goalRows = state.goals
    .map(
      (g) => `
    <div class="mini-row" data-gid="${g.id}">
      <input class="swatch" type="color" value="${esc(g.color)}" data-action="goal-color" data-id="${g.id}" />
      <input class="grow" value="${esc(g.name)}" data-action="goal-name" data-id="${g.id}" />
      <input class="num" style="width:84px" type="number" step="0.01" value="${Number(g.current_amount)}" data-action="goal-current" data-id="${g.id}" title="Saved" />
      <span class="lr-sub">/</span>
      <input class="num" style="width:84px" type="number" step="0.01" value="${Number(g.target_amount)}" data-action="goal-target" data-id="${g.id}" title="Target" />
      <button class="icon-btn" data-action="goal-del" data-id="${g.id}" title="Delete">✕</button>
    </div>`
    )
    .join("");

  body.innerHTML = `
    <div class="settings-sec" data-sec="household">
      <h3>Household</h3>
      <div class="mini-row"><input class="grow" value="${esc(hh.name)}" data-action="hh-name" />
        <select data-action="hh-currency">${CURRENCIES.map((c) => `<option ${hh.currency === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
      <div class="invite-box" style="margin-top:12px">
        <div><div class="lr-sub">Invite code — share with your partner</div><div class="invite-code">${esc(hh.invite_code)}</div></div>
        <button class="btn btn-sm" data-action="copy-invite">Copy</button>
      </div>
    </div>

    <div class="settings-sec" data-sec="members">
      <h3>People</h3>${memberRows}
      <p class="hint">Your partner installs FiTrack, signs up, chooses “Join a partner”, and enters the code above.</p>
    </div>

    <div class="settings-sec" data-sec="accounts">
      <h3>Accounts</h3>${acctRows}
      <div class="mini-row"><button class="btn btn-sm" data-action="acct-add">+ Add account</button></div>
    </div>

    <div class="settings-sec" data-sec="categories">
      <h3>Income categories</h3>${catSection("income")}
      <div class="mini-row"><button class="btn btn-sm" data-action="cat-add" data-kind="income">+ Add income category</button></div>
      <h3 style="margin-top:18px">Expense categories &amp; budgets</h3>${catSection("expense")}
      <div class="mini-row"><button class="btn btn-sm" data-action="cat-add" data-kind="expense">+ Add expense category</button></div>
    </div>

    <div class="settings-sec" data-sec="recurring">
      <h3>Recurring</h3>${recurringRows || '<p class="hint">No recurring items yet.</p>'}
      <div class="mini-row"><button class="btn btn-sm" data-action="rec-add">+ Add recurring</button></div>
      <p class="hint">Due items log automatically whenever FiTrack is opened — any missed dates are backfilled.</p>
    </div>

    <div class="settings-sec" data-sec="goals">
      <h3>Savings goals</h3>${goalRows || '<p class="hint">No goals yet.</p>'}
      <div class="mini-row"><button class="btn btn-sm" data-action="goal-add">+ Add goal</button></div>
    </div>

    <div class="settings-sec" data-sec="data">
      <h3>Your data</h3>
      <div class="mini-row"><button class="btn btn-sm" data-action="export">Export everything (JSON)</button></div>
      <p class="hint">A private backup of this household’s accounts, categories and transactions.</p>
    </div>`;

  if (scrollTo && scrollTo !== "household") {
    const sec = body.querySelector(`[data-sec="${scrollTo}"]`);
    if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

/* ---------- settings persistence helpers ---------- */
async function patchAndRefresh(table, id, patch, { quiet } = {}) {
  try {
    await api.update(table, `id=eq.${id}`, patch);
    await loadAll();
    render();
    if (!quiet) toast("Saved");
  } catch (e) { toast(e.message); }
}

function exportData() {
  const data = {
    exported_at: new Date().toISOString(),
    household: state.household,
    members: state.members.map((m) => ({ ...m, user_id: undefined })),
    accounts: state.accounts,
    categories: state.categories,
    goals: state.goals,
    recurring: state.recurring,
    transactions: state.transactions,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `fitrack-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Exported");
}

/* ===========================================================
   Global event handling (delegation)
   =========================================================== */
document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (!a) return;
  const act = a.dataset.action;
  const id = a.dataset.id;

  switch (act) {
    case "filter-member":
      state.memberFilter = id;
      render();
      break;
    case "edit-tx": {
      if (e.target.closest('[data-action="del-tx"]')) break;
      const t = state.transactions.find((x) => x.id === id);
      if (t) openTxModal(t);
      break;
    }
    case "del-tx":
      e.stopPropagation();
      if (confirm("Delete this entry?")) deleteTx(id);
      break;
    case "del-tx-modal":
      if (confirm("Delete this entry?")) deleteTx(id);
      break;
    case "open-settings-tab":
      openSettings(a.dataset.tab);
      break;
    case "signout":
      signOut();
      break;
    case "copy-invite":
      navigator.clipboard?.writeText(state.household.invite_code).then(() => toast("Copied"));
      break;
    case "export":
      exportData();
      break;

    /* accounts */
    case "acct-add":
      await api.insert("accounts", { household_id: state.household.id, name: "New account", type: "checking", sort: state.accounts.length });
      await loadAll(); renderSettings("accounts"); render();
      break;
    case "acct-del":
      if (confirm("Delete this account? Its transactions stay but lose their account link.")) {
        await api.remove("accounts", `id=eq.${id}`);
        await loadAll(); renderSettings("accounts"); render();
      }
      break;

    /* categories */
    case "cat-add":
      await api.insert("categories", { household_id: state.household.id, name: a.dataset.kind === "income" ? "New income" : "New category", kind: a.dataset.kind, color: SWATCHES[Math.floor(Math.random() * SWATCHES.length)], sort: state.categories.length });
      await loadAll(); renderSettings("categories"); render();
      break;
    case "cat-del":
      if (confirm("Delete this category?")) {
        await api.remove("categories", `id=eq.${id}`);
        await loadAll(); renderSettings("categories"); render();
      }
      break;

    /* goals */
    case "goal-add":
      await api.insert("goals", { household_id: state.household.id, name: "New goal", target_amount: 1000, current_amount: 0, color: "#10b981", sort: state.goals.length });
      await loadAll(); renderSettings("goals"); render();
      break;
    case "goal-del":
      if (confirm("Delete this goal?")) {
        await api.remove("goals", `id=eq.${id}`);
        await loadAll(); renderSettings("goals"); render();
      }
      break;

    /* recurring */
    case "edit-recurring": {
      if (e.target.closest('[data-action="rec-del"]')) break;
      const r = state.recurring.find((x) => x.id === id);
      if (r) openRecurringModal(r);
      break;
    }
    case "rec-add":
      openRecurringModal(null);
      break;
    case "rec-del":
      e.stopPropagation();
      if (confirm("Delete this recurring item? Already-logged transactions stay.")) {
        await api.remove("recurring", `id=eq.${id}`);
        await loadAll();
        if ($("#settings-body")) renderSettings("recurring");
        render();
      }
      break;
    case "del-recurring-modal":
      if (confirm("Delete this recurring item? Already-logged transactions stay.")) deleteRecurring(id);
      break;
  }
});

/* change/blur persistence for settings inputs */
document.addEventListener("change", async (e) => {
  const a = e.target.closest("[data-action]");
  if (!a) return;
  const id = a.dataset.id;
  const v = e.target.value;
  const map = {
    "hh-name": () => patchAndRefresh("households", state.household.id, { name: v.trim() || "Household" }, { quiet: true }),
    "hh-currency": () => patchAndRefresh("households", state.household.id, { currency: v }, { quiet: true }),
    "member-name": () => patchAndRefresh("members", id, { display_name: v.trim() || "Member" }, { quiet: true }),
    "member-color": () => patchAndRefresh("members", id, { color: v }, { quiet: true }),
    "acct-name": () => patchAndRefresh("accounts", id, { name: v.trim() || "Account" }, { quiet: true }),
    "acct-type": () => patchAndRefresh("accounts", id, { type: v }, { quiet: true }),
    "acct-open": () => patchAndRefresh("accounts", id, { opening_balance: parseFloat(v) || 0 }, { quiet: true }),
    "cat-name": () => patchAndRefresh("categories", id, { name: v.trim() || "Category" }, { quiet: true }),
    "cat-color": () => patchAndRefresh("categories", id, { color: v }, { quiet: true }),
    "cat-budget": () => patchAndRefresh("categories", id, { monthly_budget: v === "" ? null : parseFloat(v) }, { quiet: true }),
    "goal-name": () => patchAndRefresh("goals", id, { name: v.trim() || "Goal" }, { quiet: true }),
    "goal-color": () => patchAndRefresh("goals", id, { color: v }, { quiet: true }),
    "goal-current": () => patchAndRefresh("goals", id, { current_amount: parseFloat(v) || 0 }, { quiet: true }),
    "goal-target": () => patchAndRefresh("goals", id, { target_amount: parseFloat(v) || 0 }, { quiet: true }),
  };
  if (map[a.dataset.action]) map[a.dataset.action]();
});

/* ===========================================================
   Topbar wiring
   =========================================================== */
function wireTopbar() {
  el("period-prev").onclick = () => { shiftPeriod(-1); render(); };
  el("period-next").onclick = () => { shiftPeriod(1); render(); };
  el("period-label").onclick = () => { state.cursor = new Date(); render(); };
  el("add-tx").onclick = () => openTxModal(null);
  el("open-settings").onclick = () => openSettings("household");
  $$("#app .scope-toggle button").forEach((b) =>
    (b.onclick = () => { state.scope = b.dataset.scope; render(); })
  );
}

/* ===========================================================
   Auth screen wiring
   =========================================================== */
let authMode = "signin";
function wireAuth() {
  const form = el("auth-form");
  const toggleLink = el("auth-toggle-link");
  const showErr = (m) => { const b = el("auth-error"); b.textContent = m; b.hidden = !m; };
  const showOk = (m) => { const b = el("auth-notice"); b.textContent = m; b.hidden = !m; };

  toggleLink.onclick = (e) => {
    e.preventDefault();
    authMode = authMode === "signin" ? "signup" : "signin";
    el("auth-submit").textContent = authMode === "signin" ? "Sign in" : "Create account";
    el("auth-toggle-text").textContent = authMode === "signin" ? "New here?" : "Already have an account?";
    toggleLink.textContent = authMode === "signin" ? "Create an account" : "Sign in";
    el("auth-password").setAttribute("autocomplete", authMode === "signin" ? "current-password" : "new-password");
    showErr(""); showOk("");
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    showErr(""); showOk("");
    const email = el("auth-email").value.trim();
    const password = el("auth-password").value;
    const btn = el("auth-submit");
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "…";
    try {
      if (authMode === "signup") {
        const r = await signUp(email, password);
        if (!r.confirmed) {
          showOk("Check your inbox to confirm your email, then sign in.");
          authMode = "signin";
          el("auth-submit").textContent = "Sign in";
          btn.disabled = false;
          return;
        }
      } else {
        await signIn(email, password);
      }
      await boot();
    } catch (err) {
      showErr(err.message);
      btn.disabled = false;
      btn.textContent = original;
    }
  };
}

/* ===========================================================
   Onboarding wiring
   =========================================================== */
function wireOnboard() {
  const currency = el("ob-currency");
  currency.innerHTML = CURRENCIES.map((c) => `<option ${c === "USD" ? "selected" : ""}>${c}</option>`).join("");
  let mode = "create";
  $$("#onboard .seg-btn").forEach((b) =>
    (b.onclick = () => {
      mode = b.dataset.mode;
      $$("#onboard .seg-btn").forEach((x) => x.classList.toggle("is-active", x === b));
      $$("#onboard [data-when]").forEach((d) => (d.hidden = d.dataset.when !== mode));
    })
  );
  el("onboard-form").onsubmit = async (e) => {
    e.preventDefault();
    const errB = el("onboard-error"); errB.hidden = true;
    const name = el("ob-name").value.trim() || "Me";
    const btn = el("ob-submit"); btn.disabled = true;
    try {
      if (mode === "create") {
        await api.rpc("create_household", {
          p_name: el("ob-household").value.trim() || "Household",
          p_display_name: name,
          p_color: "#6366f1",
          p_currency: el("ob-currency").value,
        });
      } else {
        const code = el("ob-code").value.trim();
        if (!code) throw new Error("Enter the invite code your partner shared.");
        await api.rpc("join_household", { p_code: code, p_display_name: name, p_color: "#10b981" });
      }
      await boot();
    } catch (err) {
      errB.textContent = err.message; errB.hidden = false; btn.disabled = false;
    }
  };
}

/* ===========================================================
   Boot
   =========================================================== */
async function boot() {
  // first pass to know whether a household exists
  let ok = await loadAll();
  if (!ok) { show("onboard"); return; }
  // materialize any due recurring transactions, then refresh if new ones were created
  try {
    const created = await api.rpc("run_recurring");
    if (created && created > 0) {
      await loadAll();
      toast(`Added ${created} recurring ${created === 1 ? "entry" : "entries"}`);
    }
  } catch (e) { /* non-fatal */ }
  render();
}

async function init() {
  wireAuth();
  wireOnboard();
  wireTopbar();
  session = readStoredSession();
  if (session) {
    const valid = await ensureValidToken();
    if (valid) {
      try { await boot(); return; }
      catch { saveSession(null); }
    }
  }
  show("auth");
}

init();
