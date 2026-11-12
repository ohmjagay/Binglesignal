// BingleSignal premium layer: plan access, trial banner, pricing, paused and account screens.
// It FAILS OPEN: if the access check is unavailable (SQL not applied yet, outage) nobody is blocked.
const BS = window.BS || (window.BS = {}), $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SB = BS.supabaseUrl, KEY = BS.supabaseKey, ENFORCE = BS.paywall !== false;
// Everything the pricing page says (name, bullets, heading, price) lives in public/config.js, so you edit it there.
const PLAN = Object.assign({ heading: 'One plan. The whole briefing.', note: 'Every account starts with a 7-day free trial. No card needed. Cancel any time.',
  name: 'BingleSignal Briefing', label: 'Daily briefing', tagline: "The signal from today's news, summarised for you, with videos picked for how you watch.", features: [], soon: [] }, BS.plan || {});
const PLAN_NAME = PLAN.name;
// [text, live?]  live = works today, otherwise shown as "soon" (we never sell what is not built)
const FEATS = [...(PLAN.features || []).map((t) => [t, 1]), ...(PLAN.soon || []).map((t) => [t, 0])];
const USD = Number(BS.price?.usd ?? 5);   // one price worldwide
const money = (n) => Number(n).toLocaleString('en-IN');
let ACC = null, ENVI = null, INT = 'month', QUOTE = null, NOTICE = '', busy = false, pendingMfaEnrollment = null;
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
    // One plan means one set of limits: READ and WATCH sizes come from config.js (readCap / watchCap) for everyone.
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
  if (a?.status === 'trialing') m = `<span><b>Free trial</b> · ${a.days_left} day${a.days_left === 1 ? '' : 's'} left · no card needed</span><a class="btn sm" href="#/pricing">Subscribe</a>`;
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

// India only: the "how would you like to pay" step. The rupee figure is the live quote from /api/quote (the server recomputes it at checkout).
function payBox(e) {
  const q = QUOTE?.inr, rails = e.rails || {}, out = [];
  if (NOTICE) out.push(`<p class="err" role="status">${esc(NOTICE)}</p>`);
  if (q && rails.razorpay_inr) {
    const gst = q.gst_percent > 0 ? ` + ${esc(q.gst_percent)}% GST ₹${money(q.gst_inr)}` : '';
    out.push(`<button class="btn fill wide" data-pay="INR">Pay ₹${money(q.total_inr)} a month in rupees</button>`
      + `<small class="mu">$${USD.toFixed(2)} at today's rate (₹${esc(q.rate)} per $1) = ₹${money(q.base_inr)}${gst}. Your rupee amount is fixed when you subscribe and stays the same every month.</small>`);
  } else if (rails.razorpay_inr) {
    out.push('<small class="mu">The live rupee price is unavailable right now. Please try again in a minute.</small>');
  }
  if (rails.razorpay_usd) out.push(`<button class="btn wide" data-pay="USD">Pay $${USD.toFixed(2)} a month in US dollars</button><small class="mu">International card. Some Indian cards block dollar payments.</small>`);
  out.push('<button class="btn sm" data-pay-cancel>Back</button>');
  return `<div class="paybox" role="group" aria-label="Choose how to pay"><p class="mu">How would you like to pay?</p>${out.join('')}</div>`;
}

async function pricing() {
  const e = await env(), india = region(e) === 'IN', rails = e.rails || {};
  const ready = india ? !!(rails.razorpay_inr || rails.razorpay_usd) : !!rails.razorpay_usd;
  const active = ACC?.status === 'active';
  let cta;
  if (!authed()) cta = `<a class="btn fill wide" href="#/me/read">Start 7-day free trial</a><small class="mu">No card needed. Then $${USD} a month.</small>`;
  else if (active) cta = '<button class="btn wide" disabled>Your current plan</button>';
  else if (!ready) cta = '<button class="btn wide" disabled>Payments opening soon</button><small class="mu">Your trial keeps running.</small>';
  else if (QUOTE && india) cta = payBox(e);
  else cta = `<button class="btn fill wide" data-plan="lite">Subscribe · $${USD}/month</button>`;
  const card = `<article class="card plan hot"><div class="eyebrow">${esc(PLAN.label)}</div><h2 class="serif">${esc(PLAN_NAME)}</h2><p class="mu">${esc(PLAN.tagline)}</p><div class="price"><span>$</span><b>${esc(USD)}</b><small>/mo</small></div><ul>${FEATS.map(([t, live]) => `<li class="${live ? '' : 'soon'}">${esc(t)}${live ? '' : ' <i>soon</i>'}</li>`).join('')}</ul>${cta}</article>`;
  frame(`<section class="pxh"><h1 class="serif">${esc(PLAN.heading)}</h1><p class="tag">${esc(PLAN.note)}</p></section><div class="plans">${card}</div><p id="pxmsg" class="err" role="status"></p><p class="mu fine">One price worldwide: $${USD} a month. In India you can pay the same price in rupees at the live exchange rate plus applicable GST, and you see the exact total before you pay. Payments are processed by Razorpay. <a href="/refund">Refunds &amp; cancellation</a> · <a href="/terms">Terms</a></p>`);
}

// Step 1 of paying. Outside India there is nothing to choose, so go straight to the dollar checkout.
async function startPay() {
  if (busy) return;
  const e = await env();
  if (region(e) !== 'IN' || !e.rails?.razorpay_inr) return checkout('USD');
  busy = true; NOTICE = '';
  try {
    const r = await fetch('/api/quote', { cache: 'no-store' });
    const j = r.ok ? await r.json() : {};
    QUOTE = { inr: j.inr || null };
  } catch { QUOTE = { inr: null }; }
  finally { busy = false; }
  pricing();
}

async function checkout(currency) {
  if (busy) return; busy = true; let opened = false;
  const msg = (t) => { const m = $('#pxmsg'); if (m) m.textContent = t; };
  try {
    const t = await window.BSAuth.token();
    const body = { interval: 'month', currency };
    if (currency === 'INR' && QUOTE?.inr) body.expected_total_inr = QUOTE.inr.total_inr;   // the price the customer just saw: the server refuses if the rate moved since
    const r = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 409 && j.code === 'rate_changed' && j.quote) { QUOTE = { inr: j.quote }; NOTICE = j.error; await pricing(); return; }
    if (!r.ok) throw new Error(j.error || 'checkout failed');
    if (j.provider === 'global') { opened = true; location.href = j.url; return; } // an old, still-open checkout from the previous provider
    await loadScript('https://checkout.razorpay.com/v1/checkout.js');
    new window.Razorpay({ key: j.key_id, subscription_id: j.subscription_id, name: 'BingleSignal', description: PLAN_NAME, prefill: { email: window.BSAuth.user()?.email || '' }, theme: { color: '#D4B46A' }, handler: () => { activating(); }, modal: { ondismiss: () => { busy = false; } } }).open();
    opened = true;
  } catch (err) { msg('Could not start checkout: ' + err.message + '. Please try again, or email us and we will set it up.'); }
  finally { if (!opened) busy = false; }
}

async function activating() {
  frame('<section class="pxh"><h1 class="serif">Payment received</h1><p class="tag" id="pxmsg">Activating your plan…</p></section>');
  for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 3000)); await loadAccess(); if (ACC?.status === 'active') break; }
  busy = false; location.hash = '#/account';
}

// Public headlines: live from the Worker first, the static file as a backup. Never throws.
async function loadTeaser() {
  for (const url of ['/api/teaser', 'feed.json']) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = await r.json();
      if (Array.isArray(j.items) && j.items.length) return j;
    } catch { /* try the next source */ }
  }
  return { items: [] };
}

async function paused() {
  if (!authed()) { location.hash = '#/'; return; }
  await acc.ready;
  if (!ACC || ACC.has_access) { location.hash = '#/me/read'; return; }
  const tease = ((await loadTeaser()).items || []).slice(0, 3).map((a) => `<li>${esc(a.t)}</li>`).join('');
  frame(`<section class="pxh"><h1 class="serif">Your briefing is paused</h1><p class="tag">Your 7-day trial has ended. Your settings are saved. Choose a plan to pick up where you left off.</p></section><div class="card paused"><h3 class="serif">Today's top stories</h3><ul>${tease}</ul><a class="btn fill" href="#/pricing">Choose a plan</a> <a class="btn" href="/contact">Talk to us</a></div>`);
}

async function loadUsageMetrics() {
  const output = $('#time-saved');
  if (!output) return;
  try {
    const token = await window.BSAuth.token();
    const response = await fetch('/api/metrics', { headers: { authorization: 'Bearer ' + token } });
    if (!response.ok) throw Object.assign(new Error(), { statusCode: response.status });
    const metrics = (await response.json()).metrics || {};
    output.textContent = `You've completed ${Number(metrics.completed_editions) || 0} briefings and saved about ${Number(metrics.time_saved_minutes) || 0} minutes. Estimate: 3 minutes per completed briefing.`;
  } catch (error) {
    output.textContent = 'Your usage estimate is unavailable right now.';
    console.warn('Usage metrics could not be loaded', { status_code: error.statusCode || 0 });
  }
}

async function account() {
  if (!authed()) { location.hash = '#/me/read'; return; }
  await acc.ready; const a = ACC;
  const label = { trialing: 'Free trial', active: 'Active', past_due: 'Payment problem', canceled: 'Cancelled', expired: 'Trial ended', none: 'No plan' };
  let body = '<p class="mu">Plan details are unavailable right now. Please try again shortly.</p>';
  if (a) {
    const line = a.status === 'trialing' ? `Trial ends on <b>${fd(a.trial_ends_at)}</b> (${a.days_left} day${a.days_left === 1 ? '' : 's'} left).`
      : a.status === 'active' ? `Briefing plan.${a.current_period_end ? ' Renews on <b>' + fd(a.current_period_end) + '</b>.' : ''}`
      : a.status === 'canceled' ? `Access until <b>${fd(a.current_period_end)}</b>.` : '';
    body = `<p><b>${label[a.status] || esc(a.status)}</b></p><p class="mu">${line}</p><p>${a.status === 'active' ? '' : '<a class="btn" href="#/pricing">Subscribe</a>'} ${a.status === 'active' ? '<button class="btn" id="cx">Cancel subscription</button>' : ''}</p><p id="pxmsg" class="mu" role="status"></p>`;
  }
  frame(`<section class="pxh"><h1 class="serif">Your account</h1><p class="tag">${esc(window.BSAuth.user()?.email || '')}</p></section><div class="card">${body}</div><section class="card"><h2 class="serif">Time saved</h2><p id="time-saved" class="mu">Loading your estimate…</p></section><section class="card"><h2 class="serif">Account security</h2><p id="mfa-status" class="mu" role="status">Checking your authenticator settings…</p><button class="btn" id="mfa-start">Set up authenticator</button><div id="mfa-enrollment" hidden><p>In your authenticator app choose “add account” and enter this setup key:</p><p><code id="mfa-secret"></code></p><form id="mfa-enrollment-form"><label>6-digit code<input id="mfa-enrollment-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></label><button class="btn fill" type="submit">Verify authenticator</button></form></div><p id="mfa-message" class="mu" role="status"></p></section><section class="card"><h2 class="serif">Privacy</h2><p class="mu">Delete your connected mailboxes, summaries, email reports, and encryption keys. This cannot be undone.</p><button class="btn" id="delete-email-data">Delete email data</button><p id="privacy-msg" class="mu" role="status"></p></section><p class="mu fine">Invoices, data export or deletion: <a href="mailto:${esc(BS.email || '')}">${esc(BS.email || 'contact us')}</a>${BS.portalUrl ? ` · <a href="${esc(BS.portalUrl)}" target="_blank" rel="noopener noreferrer">Manage billing</a>` : ''}</p>`);
  await refreshMfaStatus();
  await loadUsageMetrics();
  $('#mfa-enrollment-form').onsubmit = verifyMfaEnrollment;
}

async function refreshMfaStatus() {
  const status = $('#mfa-status');
  const setup = $('#mfa-start');
  try {
    const factors = await window.BSAuth.factors();
    const verified = factors.some((factor) => factor.factor_type === 'totp' && factor.status === 'verified');
    status.textContent = verified
      ? window.BSAuth.assurance() === 'aal2'
        ? 'Authenticator is verified for this session.'
        : 'Authenticator is active. Enter its code when you sign in.'
      : 'Add an authenticator app for stronger account security.';
    setup.hidden = verified;
    setup.disabled = false;
  } catch (error) {
    status.textContent = `Could not check authenticator settings: ${error.message}`;
    setup.disabled = true;
  }
}

async function startMfaEnrollment() {
  const button = $('#mfa-start');
  const message = $('#mfa-message');
  button.disabled = true;
  message.textContent = '';
  try {
    const factor = await window.BSAuth.enrollTotp();
    if (!factor.id || !factor.totp?.secret) throw new Error('Supabase did not return an authenticator setup key.');
    pendingMfaEnrollment = factor.id;
    $('#mfa-secret').textContent = factor.totp.secret;
    $('#mfa-enrollment').hidden = false;
    $('#mfa-enrollment-code').focus();
    message.textContent = 'Save this key in your authenticator app, then enter its current 6-digit code.';
  } catch (error) {
    message.textContent = `Could not start authenticator setup: ${error.message}`;
    button.disabled = false;
  }
}

async function verifyMfaEnrollment(event) {
  event.preventDefault();
  const button = event.submitter;
  const message = $('#mfa-message');
  const code = $('#mfa-enrollment-code').value.trim();
  if (!pendingMfaEnrollment) {
    message.textContent = 'Could not find the pending authenticator setup. Start setup again.';
    return;
  }
  button.disabled = true;
  try {
    await window.BSAuth.verifyTotp(pendingMfaEnrollment, code);
    pendingMfaEnrollment = null;
    $('#mfa-enrollment').hidden = true;
    $('#mfa-start').hidden = true;
    $('#mfa-secret').textContent = '';
    message.textContent = 'Authenticator verified. Your account is now better protected.';
    await refreshMfaStatus();
  } catch (error) {
    message.textContent = `Could not verify the authenticator code: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function deleteEmailData() {
  if (!confirm('Permanently delete your connected mailboxes, email summaries, reports, and encryption keys?')) return;
  const message = $('#privacy-msg');
  const button = $('#delete-email-data');
  button.disabled = true;
  message.textContent = 'Deleting your email data…';
  try {
    const token = await window.BSAuth.token();
    const response = await fetch('/api/privacy/delete-email-data', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Could not delete email data');
    message.textContent = result.warnings?.length
      ? `Email data was deleted. ${result.warnings.join(' ')}`
      : 'Email data was deleted.';
  } catch (error) {
    message.textContent = `Could not delete email data: ${error.message}`;
  } finally {
    button.disabled = false;
  }
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
  const t = e.target.closest?.('[data-plan],[data-pay],[data-pay-cancel],#cx,#delete-email-data,#mfa-start'); if (!t) return;
  if (t.dataset.payCancel !== undefined) { QUOTE = null; NOTICE = ''; pricing(); }
  else if (t.dataset.pay) checkout(t.dataset.pay);
  else if (t.dataset.plan) startPay();
  else if (t.id === 'delete-email-data') deleteEmailData();
  else if (t.id === 'mfa-start') startMfaEnrollment();
  else cancel();
});
document.addEventListener('bs:auth', onAuth);
addEventListener('hashchange', page);
setInterval(() => { if (authed()) loadAccess(); }, 10 * 60 * 1000);
onAuth();
