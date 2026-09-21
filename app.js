"use strict";
/* Family ledger page. Runs entirely in the browser and talks only to api.github.com with the token each person
   was given. Nothing here decides money: payments count only when a lender confirms them. */

const ORG = window.LEDGER_CONFIG.organisation;
const API = "https://api.github.com";
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const TARGET = { Needs: 0.5, Wants: 0.3, Savings: 0.2 };
const SECTION_NAMES = { ledger: "Loan and inheritance", budget: "Budget" };
const MAX_PROOF = 10 * 1024 * 1024;

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const R = c => { const n = Math.round((Number(c) || 0) / 100); return (n < 0 ? "−" : "") + "R " + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " "); };
const pct = x => (isFinite(x) ? (x * 100).toFixed(1) : "0.0") + "%";
const ymLabel = ym => { if (!ym) return ""; const [y, m] = ym.split("-").map(Number); return MONTHS[m - 1] + " " + y; };
const dLabel = iso => { if (!iso) return ""; const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return d + " " + MONTHS[m - 1] + " " + y; };
const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const newId = p => p + "-" + Date.now().toString(36) + "-" + Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, "0")).join("");

const store = {
  get tokens() { try { return JSON.parse(localStorage.getItem("ledger.tokens") || "[]"); } catch (e) { return []; } },
  set tokens(v) { try { localStorage.setItem("ledger.tokens", JSON.stringify(v)); } catch (e) {} },
  get me() { try { return localStorage.getItem("ledger.me") || ""; } catch (e) { return ""; } },
  set me(v) { try { localStorage.setItem("ledger.me", v); } catch (e) {} }
};

const S = { own: null, shared: [], lender: null, tab: "statement", flash: null, data: {}, showVersion: false };
const ADMIN = "ledger-admin";
const VERSIONS = window.LEDGER_VERSION || [];
let PUBLISHED = null;   // when version.js was last uploaded, from GitHub's public record of this page

async function loadPublished() {
  try {
    const res = await fetch(`${API}/repos/${ORG}/ledger-app/commits?path=version.js&per_page=1`, { headers: { "Accept": "application/vnd.github+json" } });
    if (!res.ok) return;
    const list = JSON.parse(await res.text());
    const when = list && list[0] && list[0].commit && list[0].commit.committer && list[0].commit.committer.date;
    if (when) { PUBLISHED = new Date(when); render(); }
  } catch (e) { /* keep showing the date from version.js */ }
}
const stamp = d => d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear() + ", " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");

/* ---------- GitHub API ---------- */
async function gh(token, method, path, body, accept) {
  const res = await fetch(API + path, {
    method, headers: { "Authorization": "Bearer " + token, "Accept": accept || "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                       ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) throw new Error("This token was not accepted. It may have expired: ask Howard for a new one.");
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("GitHub said no (" + res.status + "). Try again, or ask Howard.");
  if (accept === "raw-bytes") return new Uint8Array(await res.arrayBuffer());
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const readJSON = async (token, repo, path) => { const r = await gh(token, "GET", `/repos/${ORG}/${repo}/contents/${path}`); return r && r.content ? JSON.parse(decodeURIComponent(escape(atob(r.content.replace(/\n/g, ""))))) : null; };
async function readBytes(token, repo, path) {
  const meta = await gh(token, "GET", `/repos/${ORG}/${repo}/contents/${path}`);
  if (!meta) return null;
  if (meta.content) return Uint8Array.from(atob(meta.content.replace(/\n/g, "")), c => c.charCodeAt(0));
  const res = await fetch(API + `/repos/${ORG}/${repo}/contents/${path}`, { headers: { "Authorization": "Bearer " + token, "Accept": "application/vnd.github.raw+json" } });
  return new Uint8Array(await res.arrayBuffer());
}
async function writeFile(token, repo, path, base64, message) {
  const existing = await gh(token, "GET", `/repos/${ORG}/${repo}/contents/${path}`);
  const body = { message, content: base64 };
  if (existing && existing.sha) body.sha = existing.sha;
  return gh(token, "PUT", `/repos/${ORG}/${repo}/contents/${path}`, body);
}
const jsonB64 = obj => btoa(unescape(encodeURIComponent(JSON.stringify(obj, null, 2))));
const fileB64 = file => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = fail; r.readAsDataURL(file); });

async function reposFor(token) {
  let list = await gh(token, "GET", "/user/repos?per_page=100&sort=full_name");
  let names = (list || []).filter(r => r.owner && r.owner.login.toLowerCase() === ORG.toLowerCase()).map(r => r.name);
  if (!names.length) { list = await gh(token, "GET", `/orgs/${ORG}/repos?per_page=100&type=all`); names = (list || []).map(r => r.name); }
  return names;
}
function classify(token, names) {
  if (names.includes(ADMIN)) return { kind: "lender", token };   // a read-only lender view key opens every repository
  const pay = names.find(n => n.endsWith("-payments"));
  if (pay) { const slug = pay.slice(0, -9); return { kind: "own", token, slug, ledger: slug + "-ledger", budget: slug + "-budget", payments: pay }; }
  const slugs = [...new Set(names.filter(n => /-(ledger|budget)$/.test(n)).map(n => n.replace(/-(ledger|budget)$/, "")))];
  return slugs.map(slug => ({ kind: "shared", token, slug, ledger: names.includes(slug + "-ledger") ? slug + "-ledger" : null, budget: names.includes(slug + "-budget") ? slug + "-budget" : null }));
}

/* ---------- loading ---------- */
async function boot() {
  S.own = null; S.shared = []; S.lender = null; S.data = {};
  const tokens = store.tokens;
  if (!tokens.length) { S.tab = "settings"; return render(); }
  for (const t of tokens) {
    try {
      const c = classify(t.token, await reposFor(t.token));
      if (Array.isArray(c)) S.shared.push(...c); else if (c.kind === "lender") S.lender = S.lender || c; else if (!S.own) S.own = c;
      t.problem = null;
    } catch (e) { t.problem = e.message; }
  }
  store.tokens = tokens;
  if (S.lender) { S.own = null; S.shared = []; if (!S.tab.startsWith("l-")) S.tab = "l-overview"; }
  if (!S.own && !S.shared.length && !S.lender) S.tab = "settings";
  await load();
}

async function load() {
  const main = document.getElementById("main");
  try {
    if (S.lender) {
      const t = S.lender.token;
      const [family, intake, access] = await Promise.all([readJSON(t, ADMIN, "config/family.json"), readJSON(t, ADMIN, "data/intake.json"), readJSON(t, ADMIN, "data/access.json")]);
      const entities = (family && family.entities) || [];
      const per = await Promise.all(entities.map(async e => {
        const [statement, summary, ledger] = await Promise.all([readJSON(t, e.slug + "-ledger", "statement.json"), readJSON(t, e.slug + "-budget", "summary.json"), readJSON(t, ADMIN, `data/ledgers/${e.slug}.json`)]);
        return { slug: e.slug, name: e.name, statement, summary, ledger };
      }));
      S.data.lender = { entities: per, intake: intake || {}, access: access || [], lenders: ((family && family.lenders) || []).map(l => l.name).join(" or ") || "Howard" };
    }
    if (S.own) {
      const o = S.own;
      [S.data.statement, S.data.status, S.data.summary] = await Promise.all([
        readJSON(o.token, o.ledger, "statement.json"), readJSON(o.token, o.payments, "status.json"), readJSON(o.token, o.budget, "summary.json")]);
      const members = (S.data.status && S.data.status.members) || [];
      if (store.me && !members.includes(store.me)) store.me = "";
    }
    for (const s of S.shared) {
      s.statement = s.ledger ? await readJSON(s.token, s.ledger, "statement.json") : null;
      s.summary = s.budget ? await readJSON(s.token, s.budget, "summary.json") : null;
    }
  } catch (e) { flash(e.message, true); }
  render();
}

/* ---------- rendering ---------- */
const flash = (text, err) => { S.flash = { text, err, until: Date.now() + 8000 }; };
const flashHtml = () => (!S.flash || Date.now() > S.flash.until) ? "" : `<div class="flash ${S.flash.err ? "err" : ""}" role="status">${esc(S.flash.text)}</div>`;
const pill = (cls, t) => `<span class="pill ${cls}">${esc(t)}</span>`;

function render() {
  const tabs = [];
  if (S.lender) { tabs.push(["l-overview", "Overview"]); ((S.data.lender && S.data.lender.entities) || []).forEach(e => tabs.push(["l-" + e.slug, e.name])); }
  if (S.own) tabs.push(["statement", "Statement"], ["payments", "Payments"], ["budget", "Budget"], ["access", "Access"]);
  S.shared.forEach((s, i) => tabs.push(["shared-" + i, (s.statement && s.statement.entity) || (s.summary && s.summary.entity) || "Shared"]));
  tabs.push(["settings", "Settings"]);
  if (!tabs.some(t => t[0] === S.tab)) S.tab = tabs[0][0];
  document.getElementById("tabs").innerHTML = tabs.map(([k, v]) => `<button type="button" role="tab" aria-selected="${S.tab === k}" data-act="tab" data-tab="${k}">${esc(v)}</button>`).join("");
  const entity = S.data.status && S.data.status.entity;
  document.getElementById("who").textContent = S.lender ? "Lender view, read only" : S.own ? (store.me ? store.me + ", " : "") + (entity || "") : "";
  let body = "";
  if (S.tab === "l-overview") body = viewLenderOverview();
  else if (S.tab.startsWith("l-")) body = viewLenderEntity(S.tab.slice(2));
  else if (S.tab === "statement") body = viewStatement(S.data.statement);
  else if (S.tab === "payments") body = viewPayments();
  else if (S.tab === "budget") body = viewBudget(S.data.summary, true);
  else if (S.tab === "access") body = viewAccess();
  else if (S.tab.startsWith("shared-")) { const s = S.shared[Number(S.tab.slice(7))]; body = `<p class="note">Shared with you, read only.</p>` + (s.statement ? viewStatement(s.statement) : "") + (s.summary ? viewBudget(s.summary, false) : ""); }
  else body = viewSettings();
  const v = VERSIONS[0], vb = document.getElementById("version");
  if (v && vb) {
    vb.textContent = `Version ${v.version}, ${PUBLISHED ? stamp(PUBLISHED) : dLabel(v.date)}`;
    vb.title = PUBLISHED ? "Published " + PUBLISHED.toString() : "";
    vb.setAttribute("aria-expanded", String(S.showVersion));
  }
  document.getElementById("main").innerHTML = flashHtml() + versionHtml() + whoAmI() + body;
}

function versionHtml() {
  if (!S.showVersion || !VERSIONS.length) return "";
  return `<div class="panel changes"><h3 style="margin-top:0">What's changed</h3>${VERSIONS.map((v, i) => `<h3>Version ${esc(v.version)}, ${i === 0 && PUBLISHED ? stamp(PUBLISHED) : dLabel(v.date)}</h3><ul>${v.changes.map(c => `<li>${esc(c)}</li>`).join("")}</ul>`).join("")}
    <p style="margin:12px 0 0"><button type="button" class="btn ghost sm" data-act="version">Close</button></p></div>`;
}

/* ---------- lender view (read only) ---------- */
const PROOF_TYPES = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };
const proofButton = path => path ? `<button type="button" class="btn ghost sm" data-act="proof" data-path="${esc(path)}">Download proof</button>` : "";

function viewLenderOverview() {
  const L = S.data.lender;
  if (!L) return `<div class="panel"><p class="empty">Loading…</p></div>`;
  const rows = L.entities.map(e => {
    const st = e.statement && e.statement.loan && e.statement.loan.state;
    const inh = ((e.statement && e.statement.inheritances) || []).reduce((s, i) => s + i.amount_cents, 0);
    return { e, st, inh };
  });
  const sum = f => rows.reduce((s, r) => s + (f(r) || 0), 0);
  const waiting = Object.values(L.intake).filter(r => r.status === "pending").sort((a, b) => a.sid.localeCompare(b.sid));
  const shared = L.access.filter(g => g.status === "approved" || g.status === "awaiting-token");
  const nameOf = slug => (L.entities.find(e => e.slug === slug) || {}).name || slug;
  return `<div class="pagehead"><h2>Family overview</h2><span class="meta">Read only. ${esc(L.lenders)} confirms payments on GitHub.</span></div>
  <div class="stats">
    <div class="stat"><div class="k">Outstanding across all loans</div><div class="v">${R(sum(r => r.st && r.st.outstanding_cents))}</div><div class="s">All loans are interest-free</div></div>
    <div class="stat"><div class="k">Inheritance given to date</div><div class="v">${R(sum(r => r.inh))}</div></div>
    <div class="stat"><div class="k">Payments waiting to be confirmed</div><div class="v ${waiting.length ? "bad" : "good"}">${waiting.length}</div></div>
  </div>
  <div class="panel"><h3>Payments waiting to be confirmed</h3>${waiting.length ? `<div class="scroll"><table class="t"><thead><tr><th>Entity</th><th>Month</th><th class="n">Amount</th><th>Date on proof</th><th>Sent by</th><th></th></tr></thead><tbody>
    ${waiting.map(r => `<tr><td>${esc(nameOf(r.slug))}</td><td>${ymLabel(r.month)}</td><td class="n">${R(r.amount_cents)}</td><td>${dLabel(r.paid_on)}</td><td>${esc(r.sent_by)}</td><td>${proofButton(r.proof)}</td></tr>`).join("")}
  </tbody></table></div>` : `<p class="empty">Nothing waiting.</p>`}</div>
  <div class="panel"><h3>What each entity has received</h3><div class="scroll"><table class="t"><thead><tr><th>Entity</th><th class="n">Inheritance</th><th class="n">Loan advanced</th><th class="n">Written off</th><th class="n">Repaid</th><th class="n">Outstanding</th><th>Status</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td><button type="button" class="btn ghost sm" data-act="tab" data-tab="l-${esc(r.e.slug)}">${esc(r.e.name)}</button></td><td class="n">${R(r.inh)}</td>
      <td class="n">${r.st ? R(r.st.advanced_cents) : "—"}</td><td class="n">${r.st ? R(r.st.writeoffs_cents) : "—"}</td><td class="n">${r.st ? R(r.st.repaid_cents) : "—"}</td><td class="n">${r.st ? R(r.st.outstanding_cents) : "—"}</td>
      <td>${!r.st ? '<span class="note">No loan</span>' : r.st.arrears_cents > 0 ? pill("bad", "Behind " + R(r.st.arrears_cents)) : pill("ok", "Up to date")}</td></tr>`).join("")}
  </tbody><tfoot><tr><td>Family</td><td class="n">${R(sum(r => r.inh))}</td><td class="n">${R(sum(r => r.st && r.st.advanced_cents))}</td><td class="n">${R(sum(r => r.st && r.st.writeoffs_cents))}</td><td class="n">${R(sum(r => r.st && r.st.repaid_cents))}</td><td class="n">${R(sum(r => r.st && r.st.outstanding_cents))}</td><td></td></tr></tfoot></table></div></div>
  <div class="panel"><h3>Access between entities</h3>${shared.length ? `<table class="t"><thead><tr><th>Who</th><th>Can see</th><th>What</th><th>Until</th></tr></thead><tbody>${shared.map(g => `<tr><td>${esc(nameOf(g.from))}</td><td>${esc(nameOf(g.to))}</td><td>${esc(g.sections.map(s => SECTION_NAMES[s]).join(", "))}</td><td>${g.status === "awaiting-token" ? "Waiting for the key" : dLabel(g.expires_at)}</td></tr>`).join("")}</tbody></table>` : `<p class="empty">Nobody has access to another entity.</p>`}</div>`;
}

function viewLenderEntity(slug) {
  const L = S.data.lender, e = L && L.entities.find(x => x.slug === slug);
  if (!e) return `<div class="panel"><p class="empty">Not found.</p></div>`;
  const pays = ((e.ledger && e.ledger.payments) || []).slice().sort((a, b) => (b.month + b.paid_on).localeCompare(a.month + a.paid_on));
  const waiting = Object.values(L.intake).filter(r => r.slug === slug && r.status === "pending");
  const proofs = `<div class="panel"><h3>Payments and proofs</h3>${pays.length || waiting.length ? `<div class="scroll"><table class="t"><thead><tr><th>Month</th><th class="n">Amount</th><th>Date on proof</th><th>Sent by</th><th>Status</th><th></th></tr></thead><tbody>
    ${waiting.map(r => `<tr><td>${ymLabel(r.month)}</td><td class="n">${R(r.amount_cents)}</td><td>${dLabel(r.paid_on)}</td><td>${esc(r.sent_by)}</td><td>${pill("pending", "Waiting")}</td><td>${proofButton(r.proof)}</td></tr>`).join("")}
    ${pays.map(p => `<tr class="${p.reversed ? "reversed" : ""}"><td>${ymLabel(p.month)}</td><td class="n amt">${R(p.amount_cents)}</td><td>${dLabel(p.paid_on)}</td><td>${esc(p.sent_by || "")}</td>
      <td>${p.reversed ? pill("off", "Reversed") + `<div class="note">${esc(p.reversed.reason)}</div>` : p.status === "confirmed" ? pill("ok", "Confirmed") + `<div class="note">${esc(p.decided_by || "")}</div>` : pill("bad", "Rejected")}</td><td>${proofButton(p.proof)}</td></tr>`).join("")}
  </tbody></table></div>` : `<p class="empty">No payments yet.</p>`}</div>`;
  return (e.statement ? viewStatement(e.statement) : `<div class="panel"><p class="empty">No statement yet.</p></div>`) + proofs + (e.summary ? viewBudget(e.summary, false) : "");
}

function whoAmI() {
  if (!S.own || store.me || !S.data.status) return "";
  return `<div class="panel"><h3>Who are you?</h3><p class="help">Choose your name. It's kept on this device and shown with what you send.</p>
    <div class="row">${S.data.status.members.map(m => `<button type="button" class="btn ghost" data-act="me" data-name="${esc(m)}">${esc(m)}</button>`).join("")}</div></div>`;
}

function viewStatement(d) {
  if (!d) return `<div class="panel"><p class="empty">The statement isn't ready yet. It appears within the hour after setup.</p></div>`;
  let h = `<div class="pagehead"><h2>${esc(d.entity)}</h2><span class="meta">Updated ${dLabel(d.updated)}</span></div>`;
  if (d.loan) {
    const s = d.loan.state, t = d.loan.terms, ym = d.updated.slice(0, 7);
    h += `<div class="stats">
      <div class="stat"><div class="k">Outstanding</div><div class="v">${R(s.outstanding_cents)}</div><div class="s">Interest-free, owed jointly by ${esc(d.entity)}</div></div>
      <div class="stat"><div class="k">${ym < t.first_due ? "First repayment, " + ymLabel(t.first_due) : ymLabel(ym) + " repayment"}</div><div class="v">${R(s.due_now_cents)}</div><div class="s">${t.esc_pct ? `Steps up ${t.esc_pct}% each January from ${t.esc_from}` : "No yearly step-up"}</div></div>
      <div class="stat"><div class="k">Missed or short monthly payments</div><div class="v ${s.arrears_cents > 0 ? "bad" : "good"}">${s.arrears_cents > 0 ? "Behind by " + R(s.arrears_cents) : "Up to date"}</div><div class="s">Extra payments don't cover missed months</div></div>
      <div class="stat"><div class="k">Projected to settle</div><div class="v">${s.outstanding_cents <= 50 ? "Settled" : s.settle_month ? ymLabel(s.settle_month) : "—"}</div><div class="s">${s.months_left} more payments${s.months_saved ? `; ${s.months_saved} fewer because of ${R(s.extra_cents)} paid extra` : ""}</div></div>
    </div>
    <div class="panel"><h3>Portions</h3><div class="bars">${s.portions.map(p => { const orig = p.principal_cents + p.topups_cents, left = p.balance_cents;
      return `<div class="barrow"><span>${esc(p.name)}</span><span class="track" role="img" aria-label="${esc(p.name)}: ${R(orig - left)} of ${R(orig)} repaid"><i style="width:${orig ? ((orig - left) / orig * 100).toFixed(2) : 0}%"></i></span><span class="n">${R(left)} left</span></div>`; }).join("")}</div></div>
    <div class="panel"><h3>Payments</h3>${d.loan.payments.length ? `<div class="scroll"><table class="t"><thead><tr><th>Month</th><th class="n">Due</th><th class="n">Paid</th><th>Paid on</th><th>Status</th></tr></thead><tbody>
      ${d.loan.payments.map(p => `<tr class="${p.reversed ? "reversed" : ""}"><td>${ymLabel(p.month)}</td><td class="n">${R(p.due_cents)}</td><td class="n amt">${R(p.amount_cents)}</td><td>${dLabel(p.paid_on)}</td>
        <td>${p.reversed ? pill("off", "Reversed") + `<div class="note">${esc(p.reversed.reason)}</div>` : p.status === "confirmed" ? pill("ok", "Confirmed") : pill("bad", "Rejected")}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="empty">No payments yet. The first is due in ${ymLabel(t.first_due)}.</p>`}</div>
    <div class="panel"><h3>Repayment by year</h3><div class="scroll"><table class="t"><thead><tr>${d.loan.by_year.map(y => `<th class="n">${y.year}</th>`).join("")}</tr></thead><tbody><tr>${d.loan.by_year.map(y => `<td class="n">${R(y.cents)}</td>`).join("")}</tr></tbody></table></div></div>
    ${d.loan.adjustments.length ? `<div class="panel"><h3>Changes to the loan</h3><div class="scroll"><table class="t"><thead><tr><th>Date</th><th>Change</th><th class="n">Amount</th><th>Reason</th></tr></thead><tbody>
      ${d.loan.adjustments.map(a => `<tr><td>${dLabel(a.at)}</td><td>${a.type === "instalment" ? "Monthly repayment from " + ymLabel(a.from_month) : (a.type === "topup" ? "Top-up to " : "Write-off from ") + esc(a.portion)}</td><td class="n">${R(a.amount_cents)}</td><td>${esc(a.reason)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}`;
  } else h += `<div class="panel"><p class="empty">No loan has been made to ${esc(d.entity)}.</p></div>`;
  h += `<div class="panel"><h3>Inheritance</h3>${d.inheritances.length ? `<table class="t"><thead><tr><th>Paid on</th><th>To</th><th class="n">Amount</th></tr></thead><tbody>${d.inheritances.map(i => `<tr><td>${dLabel(i.paid_on)}</td><td>${esc(i.person)}</td><td class="n">${R(i.amount_cents)}</td></tr>`).join("")}</tbody></table>` : `<p class="empty">No inheritance given yet.</p>`}</div>`;
  if (d.shared_with && d.shared_with.length) h += `<div class="panel"><h3>Who else can see this</h3><ul>${d.shared_with.map(g => `<li>${esc(g.from_name)} (${esc(g.sections.join(", "))}), until ${dLabel(g.expires_at)}</li>`).join("")}</ul></div>`;
  if (d.events && d.events.length) h += `<div class="panel"><h3>Recent activity</h3><table class="t"><tbody>${d.events.map(e => `<tr><td style="white-space:nowrap">${dLabel(e.at)}</td><td>${esc(e.by)}</td><td>${esc(e.text)}</td></tr>`).join("")}</tbody></table></div>`;
  return h;
}

function viewPayments() {
  const st = S.data.status || { submissions: {} };
  const subs = Object.entries(st.submissions || {}).sort((a, b) => b[0].localeCompare(a[0]));
  const loan = S.data.statement && S.data.statement.loan;
  const due = loan ? loan.state.due_now_cents / 100 : "";
  const month = loan ? (today().slice(0, 7) < loan.terms.first_due ? loan.terms.first_due : today().slice(0, 7)) : today().slice(0, 7);
  return `<div class="panel"><h3>Send a payment</h3>
    <p class="help">Attach the bank's proof of payment. It counts once ${esc(st.lenders || "Howard")} confirms it, usually within a day. You can pay more than the monthly amount: the extra shortens the loan.</p>
    ${loan ? `<form class="f" data-form="payment">
      <label>For month<input type="month" name="month" required value="${month}"></label>
      <label>Amount paid (R)<input type="number" name="amount" min="1" step="0.01" required value="${due}"></label>
      <label>Date on the proof<input type="date" name="paid_on" required max="${today()}" value="${today()}"></label>
      <label>Proof of payment (PDF or photo)<input type="file" name="proof" accept="application/pdf,image/jpeg,image/png" required></label>
      <label class="wide">Note (optional)<input type="text" name="note" maxlength="200"></label>
      <div class="wide"><button class="btn" type="submit" ${store.me ? "" : "disabled"}>Send</button>${store.me ? "" : ' <span class="note">Choose your name first.</span>'}</div></form>` : `<p class="empty">There is no loan to pay.</p>`}</div>
  <div class="panel"><h3>What you've sent</h3>${subs.length ? `<div class="scroll"><table class="t"><thead><tr><th>Month</th><th class="n">Amount</th><th>Sent by</th><th>Status</th></tr></thead><tbody>
    ${subs.map(([id, s]) => `<tr><td>${ymLabel(s.month) || "—"}</td><td class="n">${s.amount_cents ? R(s.amount_cents) : "—"}</td><td>${esc(s.sent_by || "")}</td>
      <td>${pill({ pending: "pending", confirmed: "ok", rejected: "bad", reversed: "off", problem: "bad" }[s.status] || "pending", { pending: "Waiting", confirmed: "Confirmed", rejected: "Rejected", reversed: "Reversed", problem: "Needs fixing" }[s.status] || s.status)}<div class="note">${esc(s.message)}</div></td></tr>`).join("")}
  </tbody></table></div>` : `<p class="empty">Nothing sent yet.</p>`}<p class="note">This list updates within the hour.</p></div>`;
}

function viewBudget(sm, editable) {
  let h = "";
  if (editable) h += `<div class="panel"><h3>Your budget workbook</h3><p class="help">Keep <b>Budget.xlsx</b> on your phone or computer in Excel. When you change it, upload it here. The summary updates within the hour.</p>
    <div class="row"><button type="button" class="btn ghost" data-act="download-budget">Download the current workbook</button></div>
    <form class="f" data-form="budget" style="margin-top:10px"><label>Upload the updated workbook (.xlsx)<input type="file" name="book" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required></label><div><button class="btn" type="submit">Upload</button></div></form></div>`;
  if (!sm) return h + `<div class="panel"><p class="empty">No budget summary yet.</p></div>`;
  if (sm.problem) return h + `<div class="panel"><h3>Budget summary</h3><p>${esc(sm.problem)}</p></div>`;
  const f = sm.figures, pay = f.pay || 0;
  h += `<div class="panel"><h3>Budget summary: ${esc(f.month)}</h3><div class="stats"><div class="stat"><div class="k">Take-home pay</div><div class="v">${R(pay)}</div></div></div>
    <div class="bars">${["Needs", "Wants", "Savings"].map(c => { const x = f.categories[c], share = pay ? x.actual / pay : 0;
      return `<div class="barrow"><span>${c}</span><span class="track" role="img" aria-label="${c}: actual ${pct(share)}, guide ${pct(TARGET[c])}"><i style="width:${Math.min(100, share * 100).toFixed(1)}%;${c !== "Savings" && share > TARGET[c] ? "background:var(--red)" : ""}"></i><b style="left:${TARGET[c] * 100}%"></b></span><span class="n">planned ${pay ? pct(x.planned / pay) : "—"}</span></div>`; }).join("")}</div>
    <div class="scroll" style="margin-top:12px"><table class="t"><thead><tr><th>Category</th><th class="n">Planned</th><th class="n">Actual</th><th class="n">Guide</th></tr></thead><tbody>
      ${["Needs", "Wants", "Savings"].map(c => `<tr><td>${c}</td><td class="n">${R(f.categories[c].planned)}</td><td class="n">${R(f.categories[c].actual)}</td><td class="n">${TARGET[c] * 100}%</td></tr>`).join("")}</tbody></table></div>
    ${f.who_pays && f.who_pays.length ? `<h3 style="margin-top:14px">Who pays</h3><table class="t"><thead><tr><th>Person</th><th class="n">Pay</th><th class="n">Planned share</th><th class="n">Left over</th></tr></thead><tbody>${f.who_pays.map(w => `<tr><td>${esc(w.name)}</td><td class="n">${R(w.pay)}</td><td class="n">${R(w.share)}</td><td class="n">${R(w.left)}</td></tr>`).join("")}</tbody></table>` : ""}</div>`;
  return h;
}

function viewAccess() {
  const st = S.data.status || {};
  const inbox = st.inbox || [], mine = st.requests || [];
  const label = { pending: "Waiting for them", "awaiting-token": "Approved; waiting for Howard", approved: "Approved", declined: "Declined", expired: "Ended after 30 days", revoked: "Ended", refused: "Not sent" };
  return `<div class="panel"><h3>Asked to see ${esc(st.entity || "your ledger")}</h3>
    ${inbox.length ? inbox.map(g => `<div class="row" style="justify-content:space-between;border-top:1px solid var(--rule-soft);padding:8px 0"><span><b>${esc(g.from)}</b> (${esc(g.requested_by || "")}) would like to see your ${esc(g.sections.map(s => SECTION_NAMES[s].toLowerCase()).join(" and "))} for 30 days.</span>
      <span class="row"><button type="button" class="btn sm" data-act="decide" data-id="${esc(g.id)}" data-decision="approve" ${store.me ? "" : "disabled"}>Approve</button><button type="button" class="btn danger sm" data-act="decide" data-id="${esc(g.id)}" data-decision="decline" ${store.me ? "" : "disabled"}>Decline</button></span></div>`).join("")
      : `<p class="empty">Nobody is asking.</p>`}
    <p class="note">If you approve, Howard creates a read-only key for them that stops working after 30 days. Proofs of payment are never shared.</p></div>
  <div class="panel"><h3>Ask to see another part of the family</h3>
    <form class="f" data-form="request">
      <label>Who<select name="to">${(st.entities || []).map(e => `<option value="${esc(e.slug)}">${esc(e.name)}</option>`).join("")}</select></label>
      <fieldset class="wide"><legend>What</legend>${Object.entries(SECTION_NAMES).map(([k, v]) => `<label><input type="checkbox" name="sections" value="${k}" ${k === "budget" ? "checked" : ""}> ${v}</label>`).join("")}</fieldset>
      <div class="wide"><button class="btn" type="submit" ${store.me ? "" : "disabled"}>Send request</button></div></form>
    ${mine.length ? `<table class="t" style="margin-top:12px"><thead><tr><th>To see</th><th>What</th><th>Status</th></tr></thead><tbody>${mine.map(g => `<tr><td>${esc(g.to || "—")}</td><td>${esc(g.sections.map(s => SECTION_NAMES[s]).join(", "))}</td><td>${esc(label[g.status] || g.status)}${g.problem ? `<div class="note">${esc(g.problem)}</div>` : ""}${g.expires_at && g.status === "approved" ? `<div class="note">Until ${dLabel(g.expires_at)}. Howard will send you a key; add it under Settings.</div>` : ""}</td></tr>`).join("")}</tbody></table>` : ""}
  </div>`;
}

function viewSettings() {
  const tokens = store.tokens;
  return `<div class="panel"><h3>Your key</h3>
    <p class="help">Howard gives each person a private key (a GitHub token). Paste it here once. It's kept only in this browser on this device.</p>
    <div class="warn">Anyone who has your key can see your family's ledger and send things in your name. Don't share it, and don't add it on a shared or public computer. If your phone is lost, tell Howard so he can cancel it.</div>
    ${tokens.length ? `<table class="t"><thead><tr><th>Key</th><th>Opens</th><th></th></tr></thead><tbody>${tokens.map((t, i) => `<tr><td>…${esc(t.token.slice(-4))}</td><td>${t.problem ? `<span class="note">${esc(t.problem)}</span>` : esc(t.label || "")}</td><td><button type="button" class="btn danger sm" data-act="remove-token" data-i="${i}">Remove from this device</button></td></tr>`).join("")}</tbody></table>` : ""}
    <form class="f" data-form="token" style="margin-top:12px"><label class="wide">Paste a key<textarea class="token" name="token" required autocomplete="off" spellcheck="false"></textarea></label><div><button class="btn" type="submit">Add key</button></div></form></div>
  ${S.own && S.data.status ? `<div class="panel"><h3>You are</h3><div class="row">${S.data.status.members.map(m => `<button type="button" class="btn ${store.me === m ? "" : "ghost"}" data-act="me" data-name="${esc(m)}">${esc(m)}</button>`).join("")}</div></div>` : ""}`;
}

/* ---------- actions ---------- */
document.addEventListener("click", async ev => {
  const b = ev.target.closest("[data-act]"); if (!b || b.disabled) return;
  const a = b.dataset.act;
  if (a === "tab") { S.tab = b.dataset.tab; return render(); }
  if (a === "proof" && S.lender) {
    const path = b.dataset.path, ext = (path.split(".").pop() || "").toLowerCase();
    if (!/^proofs\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.(pdf|jpg|jpeg|png)$/.test(path)) return;
    b.disabled = true;
    try {
      const bytes = await readBytes(S.lender.token, ADMIN, path);
      if (!bytes) throw new Error("That proof could not be found.");
      const url = URL.createObjectURL(new Blob([bytes], { type: PROOF_TYPES[ext] || "application/octet-stream" }));
      const link = document.createElement("a"); link.href = url; link.download = path.split("/").pop(); document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { flash(e.message, true); render(); }
    b.disabled = false;
    return;
  }
  if (a === "version") { S.showVersion = !S.showVersion; return render(); }
  if (a === "me") { store.me = b.dataset.name; flash("Thanks, " + store.me + "."); return render(); }
  if (a === "remove-token") { const t = store.tokens; t.splice(Number(b.dataset.i), 1); store.tokens = t; flash("Key removed from this device."); return boot(); }
  if (a === "download-budget") {
    try { const bytes = await readBytes(S.own.token, S.own.budget, "Budget.xlsx"); if (!bytes) throw new Error("No workbook yet.");
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const link = document.createElement("a"); link.href = url; link.download = "Budget.xlsx"; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { flash(e.message, true); render(); }
    return;
  }
  if (a === "decide") {
    b.disabled = true;
    try { await writeFile(S.own.token, S.own.payments, `decisions/${b.dataset.id}.json`, jsonB64({ decision: b.dataset.decision, decided_by: store.me, at: new Date().toISOString() }), "Decision on access request");
      flash(b.dataset.decision === "approve" ? "Approved. Howard will set it up within a day." : "Declined."); }
    catch (e) { flash(e.message, true); }
    return load();
  }
});

document.addEventListener("submit", async ev => {
  const f = ev.target.closest("form[data-form]"); if (!f) return;
  ev.preventDefault();
  const btn = f.querySelector('button[type="submit"]'); if (btn) btn.disabled = true;
  const fd = new FormData(f), k = f.dataset.form;
  try {
    if (k === "token") {
      const token = String(fd.get("token") || "").trim();
      if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(token)) throw new Error("That doesn't look like a GitHub key. It starts with github_pat_.");
      const names = await reposFor(token);
      if (!names.length) throw new Error("This key doesn't open anything in the family ledger. Ask Howard to check it.");
      const c = classify(token, names);
      const label = Array.isArray(c) ? "Shared: " + c.map(x => x.slug).join(", ") : c.kind === "lender" ? "Lender view (read only)" : "Your ledger";
      store.tokens = store.tokens.filter(t => t.token !== token).concat([{ token, label, added: today() }]);
      flash("Key added.");
      S.tab = Array.isArray(c) ? "settings" : c.kind === "lender" ? "l-overview" : "statement";
      return boot();
    }
    if (!S.own) throw new Error("Add your key first.");
    if (k === "payment") {
      const file = fd.get("proof");
      if (!file || !file.size) throw new Error("Attach the proof of payment.");
      if (file.size > MAX_PROOF) throw new Error("The proof must be under 10 MB.");
      const ext = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" }[file.type];
      if (!ext) throw new Error("The proof must be a PDF, JPEG or PNG.");
      if (String(fd.get("paid_on")) > today()) throw new Error("The date can't be in the future.");
      const sid = newId("pay");
      await writeFile(S.own.token, S.own.payments, `proofs/${sid}.${ext}`, await fileB64(file), "Proof of payment");
      await writeFile(S.own.token, S.own.payments, `submissions/${sid}.json`, jsonB64({ month: fd.get("month"), amount: fd.get("amount"), paid_on: fd.get("paid_on"),
        note: fd.get("note") || "", sent_by: store.me, proof: `${sid}.${ext}`, submitted_at: new Date().toISOString() }), "Payment");
      flash("Sent. " + ((S.data.status && S.data.status.lenders) || "Howard") + " will see it within the hour; the status shows below.");
      S.data.status = S.data.status || { submissions: {} };
      S.data.status.submissions[sid] = { status: "pending", message: "Sent. Waiting to be picked up.", month: fd.get("month"), amount_cents: Math.round(Number(fd.get("amount")) * 100), sent_by: store.me };
      return render();
    }
    if (k === "budget") {
      const file = fd.get("book");
      if (!file || !file.size || !/\.xlsx$/i.test(file.name)) throw new Error("Choose the .xlsx workbook.");
      await writeFile(S.own.token, S.own.budget, "Budget.xlsx", await fileB64(file), "Update budget workbook");
      flash("Uploaded. The summary updates within the hour.");
    }
    if (k === "request") {
      const sections = fd.getAll("sections");
      if (!sections.length) throw new Error("Tick at least one thing to see.");
      await writeFile(S.own.token, S.own.payments, `requests/${newId("req")}.json`, jsonB64({ to: fd.get("to"), sections, sent_by: store.me, at: new Date().toISOString() }), "Access request");
      flash("Request sent. They'll see it within the hour.");
    }
  } catch (e) { flash(e.message, true); }
  finally { if (btn) btn.disabled = false; }
  await load();
});

boot();
loadPublished();
