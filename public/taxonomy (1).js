// BingleSignal premium layer: plan access, trial banner, pricing, paused and account screens.
// It FAILS OPEN: if the access check is unavailable (SQL not applied yet, outage) nobody is blocked.
const BS = window.BS || (window.BS = {}), $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SB = BS.supabaseUrl, KEY = BS.supabaseKey, ENFORCE = BS.paywall !== false;
const PRICE = {
  IN: { c: '₹', lite: { month: '99', year: '999' }, pro: { month: '299', year: '2,999' } },
  GL: { c: '$', lite: { month: '2.99', year: '29' }, pro: { month: '5.99', year: '59' } },
};
// [text, live?]  live = works today, otherwise shown as "soon" (we never sell what is not built)
const FEATS = {
  lite: [['Finite daily edition, all topics and regions', 1], ['READ list of 40 stories and WATCH list of 8 videos', 1], ['Original source and source count on stories', 1], ['"Why it matters" line on top stories', 0], ['30-day archive search', 0]],
  pro: [['Everything in Lite', 1], ['Endless mix: READ list of 200 and WATCH list of 30', 1], ['Watchlist alerts', 0], ['Meeting prep packs', 0], ['3 Deep Dives a month', 0], ['365-day archive search', 0]],
};
let ACC = null, ENVI = null, INT = 'month', busy = false;
const acc = { get now() { return ACC; }, ready: Promise.resolve() };
window.BSAccess = acc;
const authed = () => !!window.BSAuth?.has?.();
const fd = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const tzIN = () => /Kolkata|Calcutta/.test(Intl.DateTimeFormat().resolvedOptions().timeZone || '');
const loadScript = (src) => new Promise((ok, no) => {
  if (document.querySelector(`script[src="${src}"]`)) return ok();
  const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('Could not load the payment window')); document.head.appendChild(s);
});

async function env() {
  if (ENVI) return ENVI;
  try { const r = await fetch('/api/health', { cache: 'no-store' }); ENVI = r.ok ? await r.json() : {}; } catch { ENVI = {}; }
  ENVI.rails = ENVI.rails || {};
  return ENVI;
}
const region = (e) => ((e.country ? e.country === 'IN' : tzIN()) ? 'IN' : 'GL');

async function loadAccessNow() {
  if (!authed()) { ACC = null; paintBanner(); return null; }
  const before = BS.readCap;
  try {
    const t = await window.BSAuth.token();
    const r = await fetch(SB + '/rest/v1/rpc/my_access', { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: '{}' });
    if (!r.ok) throw new Error(String(r.status));
    ACC = await r.json();
    if (ACC.features) { BS.readCap = ACC.features.read_cap; BS.watchCap = ACC.features.watch_cap; }
  } catch { ACC = null; }
  paintBanner();
  // the feed may already be on screen with the old caps: draw it again once
  if (BS.readCap !== before && !$('#app')?.hidden && /^#\/me/.test(location.hash)) window.dispatchEvent(new Event('hashchange'));
  return ACC;
}

// simultaneous callers (login + token refresh + page) share ONE request
let inflight = null;
const loadAccess = () => { if (!inflight) inflight = loadAccessNow().finally(() => { inflight = null; }); return inflight; };

function paintBanner() {
  const b = $('#bn'); if (!b) return;
  const a = ACC; let m = '';
  if (a?.status === 'trialing') m = `<span><b>Pro trial</b> · ${a.days_left} day${a.days_left === 1 ? '' : 's'} left · no card needed</span><a class="btn sm" href="#/pricing">Choose a plan</a>`;
  else if (a?.status === 'past_due') m = '<span><b>Payment problem.</b> Please update your payment method to keep your plan.</span><a class="btn sm" href="#/account">Manage plan</a>';
  else if (a?.status === 'canceled' && a.has_access) m = `<span>Your plan ends on <b>${fd(a.current_period_end)}</b>.</span><a class="btn sm" href="#/pricing">Renew</a>`;
  b.innerHTML = m; b.hidden = !m;
}

const brandHTML = () => { const a = document.querySelector('#home .brand'); return a ? '<a class="brand serif" href="#/">' + a.innerHTML.replace('id="g"', 'id="g3"').replace('url(#g)', 'url(#g3)') + '</a>' : '<a class="brand serif" href="#/"><span>Bingle<em>Signal</em></span></a>'; };
function frame(inner) {
  const p = $('#px');
  p.innerHTML = `<header class="top"><div class="wrap bar">${brandHTML()}<nav class="hdr-r"><a class="link" href="#/pricing">Pricing</a>${authed() ? '<a class="link" href="#/account">Account</a><a class="btn fill sm" href="#/me/read">My briefing</a>' : '<a class="btn fill sm" href="#/me/read">Sign in</a>'}</nav></div></header><main class="pxw">${inner}</main>`;
  p.hidden = false; $('#home').hidden = true; $('#app').hidden = true; window.scrollTo(0, 0);
}

async function pricing() {
  const e = await env(), R = region(e), rail = R === 'IN' ? e.rails.razorpay : e.rails.global, P = PRICE[R];
  const mine = ACC?.status === 'active' ? ACC.plan : null;
  const card = (id, name, blurb, tag) => {
    const per = INT === 'year' ? '/yr' : '/mo'; let cta;
    if (!authed()) cta = '<a class="btn fill wide" href="#/me/read">Start 7-day free trial</a><small class="mu">No card needed. Pro features for 7 days, then choose a plan.</small>';
    else if (mine === id) cta = '<button class="btn wide" disabled>Your current plan</button>';
    else if (!rail) cta = '<button class="btn wide" disabled>Payments opening soon</button><small class="mu">Your trial keeps running. We will email you before it ends.</small>';
    else cta = `<button class="btn fill wide" data-plan="${id}">Choose ${name}</button>`;
    return `<article class="card plan${id === 'pro' ? ' hot' : ''}"><div class="eyebrow">${tag}</div><h2 class="serif">${name}</h2><p class="mu">${blurb}</p><div class="price"><span>${P.c}</span><b>${P[id][INT]}</b><small>${per}</small></div><ul>${FEATS[id].map(([t, live]) => `<li class="${live ? '' : 'soon'}">${esc(t)}${live ? '' : ' <i>soon</i>'}</li>`).join('')}</ul>${cta}</article>`;
  };
  frame(`<section class="pxh"><h1 class="serif">Pick the depth that fits your day</h1><p class="tag">Every plan starts with a 7-day Pro trial. No card needed. Cancel any time.</p><div class="tog" role="group" aria-label="Billing period"><button data-int="month" class="${INT === 'month' ? 'on' : ''}">Monthly</button><button data-int="year" class="${INT === 'year' ? 'on' : ''}">Yearly · 2 months free</button></div></section><div class="plans">${card('lite', 'Lite', 'The finite daily briefing for professionals.', 'Signal Desk')}${card('pro', 'Pro', 'The endless mix, plus tools for people who act on news.', 'Daily Mix')}</div><p id="pxmsg" class="err" role="status"></p><p class="mu fine">Prices in ${R === 'IN' ? 'Indian rupees' : 'US dollars'}; applicable taxes are shown at checkout. Features marked <i>soon</i> are being built and join your plan at no extra cost. <a href="/refund">Refunds &amp; cancellation</a> · <a href="/terms">Terms</a></p>`);
}

async function checkout(plan) {
  if (busy) return; busy = true; let opened = false;
  const msg = (t) => { const m = $('#pxmsg'); if (m) m.textContent = t; };
  try {
    const e = await env(), R = region(e), t = await window.BSAuth.token();
    const r = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify({ plan, interval: INT, region: R === 'IN' ? 'IN' : 'GLOBAL' }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'checkout failed');
    if (j.provider === 'global') { opened = true; location.href = j.url; return; }
    await loadScript('https://checkout.razorpay.com/v1/checkout.js');
    new window.Razorpay({ key: j.key_id, subscription_id: j.subscription_id, name: 'BingleSignal', description: (plan === 'pro' ? 'Pro' : 'Lite') + ' plan', prefill: { email: window.BSAuth.user()?.email || '' }, theme: { color: '#D4B46A' }, handler: () => { activating(); }, modal: { ondismiss: () => { busy = false; } } }).open();
    opened = true;
  } catch (err) { msg('Could not start checkout: ' + err.message + '. Please try again, or email us and we will set it up.'); }
  finally { if (!opened) busy = false; }
}

async function activating() {
  frame('<section class="pxh"><h1 class="serif">Payment received</h1><p class="tag" id="pxmsg">Activating your plan…</p></section>');
  for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 3000)); await loadAccess(); if (ACC?.status === 'active') break; }
  busy = false; location.hash = '#/account';
}

async function paused() {
  if (!authed()) { location.hash = '#/'; return; }
  await acc.ready;
  if (!ACC || ACC.has_access) { location.hash = '#/me/read'; return; }
  let tease = ''; try { const j = await (await fetch('feed.json')).json(); tease = (j.items || []).slice(0, 3).map((a) => `<li>${esc(a.t)}</li>`).join(''); } catch {}
  frame(`<section class="pxh"><h1 class="serif">Your briefing is paused</h1><p class="tag">Your 7-day trial has ended. Your settings are saved. Choose a plan to pick up where you left off.</p></section><div class="card paused"><h3 class="serif">Today's top stories</h3><ul>${tease}</ul><a class="btn fill" href="#/pricing">Choose a plan</a> <a class="btn" href="/contact">Talk to us</a></div>`);
}

async function account() {
  if (!authed()) { location.hash = '#/me/read'; return; }
  await acc.ready; const a = ACC;
  const label = { trialing: 'Free trial (Pro)', active: 'Active', past_due: 'Payment problem', canceled: 'Cancelled', expired: 'Trial ended', none: 'No plan' };
  let body = '<p class="mu">Plan details are unavailable right now. Please try again shortly.</p>';
  if (a) {
    const line = a.status === 'trialing' ? `Trial ends on <b>${fd(a.trial_ends_at)}</b> (${a.days_left} day${a.days_left === 1 ? '' : 's'} left).`
      : a.status === 'active' ? `${a.plan === 'pro' ? 'Pro' : 'Lite'} plan.${a.current_period_end ? ' Renews on <b>' + fd(a.current_period_end) + '</b>.' : ''}`
      : a.status === 'canceled' ? `Access until <b>${fd(a.current_period_end)}</b>.` : '';
    body = `<p><b>${label[a.status] || esc(a.status)}</b></p><p class="mu">${line}</p><p><a class="btn" href="#/pricing">${a.status === 'active' ? 'Change plan' : 'Choose a plan'}</a> ${a.status === 'active' ? '<button class="btn" id="cx">Cancel subscription</button>' : ''}</p><p id="pxmsg" class="mu" role="status"></p>`;
  }
  frame(`<section class="pxh"><h1 class="serif">Your account</h1><p class="tag">${esc(window.BSAuth.user()?.email || '')}</p></section><div class="card">${body}</div><p class="mu fine">Invoices, data export or deletion: <a href="mailto:${esc(BS.email || '')}">${esc(BS.email || 'contact us')}</a>${BS.portalUrl ? ` · <a href="${esc(BS.portalUrl)}" target="_blank" rel="noopener noreferrer">Manage billing</a>` : ''}</p>`);
}

async function cancel() {
  if (!confirm('Cancel your subscription? You keep access until the end of the paid period.')) return;
  const m = $('#pxmsg');
  try {
    const t = await window.BSAuth.token();
    const r = await fetch('/api/cancel', { method: 'POST', headers: { Authorization: 'Bearer ' + t } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'failed');
    m.textContent = j.manual ? `To cancel, email ${BS.email || 'us'} from your account address and we will do it within 24 hours.` : 'Cancelled. You keep access until the end of the paid period.';
    await loadAccess();
  } catch (e) { m.textContent = 'Could not cancel: ' + e.message + '. Please email us and we will do it for you.'; }
}

function gate() { if (ENFORCE && ACC && !ACC.has_access && /^#\/me/.test(location.hash)) location.hash = '#/paused'; }
async function page() {
  const h = location.hash;
  if (/^#\/pricing/.test(h)) return pricing();
  if (/^#\/paused/.test(h)) return paused();
  if (/^#\/account/.test(h)) return account();
  $('#px')?.setAttribute('hidden', ''); gate();
}
// `ready` must depend ONLY on the access check (pages and the feed wait on it, so it must never wait on a page)
const onAuth = () => { const p = loadAccess(); acc.ready = p; p.then(page); };

document.addEventListener('click', (e) => {
  const t = e.target.closest?.('[data-plan],[data-int],#cx'); if (!t) return;
  if (t.dataset.int) { INT = t.dataset.int; pricing(); }
  else if (t.dataset.plan) checkout(t.dataset.plan);
  else cancel();
});
document.addEventListener('bs:auth', onAuth);
addEventListener('hashchange', page);
setInterval(() => { if (authed()) loadAccess(); }, 10 * 60 * 1000);
onAuth();
