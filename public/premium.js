// BingleSignal premium layer: plan access, trial banner, pricing, paused and account screens.
// It FAILS OPEN: if the access check is unavailable (SQL not applied yet, outage) nobody is blocked.
const BS = window.BS || (window.BS = {}), $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SB = BS.supabaseUrl, KEY = BS.supabaseKey, ENFORCE = BS.paywall !== false;
const PRICE = BS.prices;
// [text, live?]  live = works today, otherwise shown as "soon" (we never sell what is not built)
const FEATS = {
  lite: [['Finite daily edition, all topics and regions', 1], ['READ list of 40 stories and WATCH list of 8 videos', 1], ['Original source and source count on stories', 1], ['"Why it matters" line on top stories', 0], ['30-day archive search', 0]],
  pro: [['Everything in Lite', 1], ['Endless mix: READ list of 200 and WATCH list of 30', 1], ['Watchlist alerts', 0], ['Meeting prep packs', 0], ['3 Deep Dives a month', 0], ['365-day archive search', 0]],
};
let ACC = null, ENVI = null, INT = 'month', CUR = null, busy = false, pendingMfaEnrollment = null;
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
  const e = await env(), localRegion = region(e), R = CUR || localRegion;
  const rail = R === 'IN' ? e.rails.razorpay : e.rails.global, P = PRICE[R];
  const mine = ACC?.status === 'active' ? ACC.plan : null;
  const card = (id, name, blurb, tag) => {
    const per = INT === 'year' ? '/yr' : '/mo'; let cta;
    const switching = ACC?.status === 'active' && mine && mine !== id;
    if (!authed()) cta = '<a class="btn fill wide" href="#/me/read">Start 7-day free trial</a><small class="mu">No card needed. Pro features for 7 days, then choose a plan.</small>';
    else if (mine === id) cta = '<button class="btn wide" disabled>Your current plan</button>';
    else if (!rail) cta = '<button class="btn wide" disabled>Payments opening soon</button><small class="mu">Your trial keeps running. We will email you before it ends.</small>';
    else cta = `<button class="btn fill wide" data-plan="${id}">${switching ? `Switch to ${name}` : `Choose ${name}`}</button>`;
    return `<article class="card plan${id === 'pro' ? ' hot' : ''}"><div class="eyebrow">${tag}</div><h2 class="serif">${name}</h2><p class="mu">${blurb}</p><div class="price"><span>${P.c}</span><b>${P[id][INT]}</b><small>${per}</small></div><ul>${FEATS[id].map(([t, live]) => `<li class="${live ? '' : 'soon'}">${esc(t)}${live ? '' : ' <i>soon</i>'}</li>`).join('')}</ul>${R === 'IN' && authed() ? '<label class="gstin-field">GSTIN for an Indian business invoice (optional)<input id="gstin" maxlength="15" autocomplete="off" placeholder="15-character GSTIN"></label>' : ''}${cta}</article>`;
  };
  const currencyToggle = localRegion === 'IN'
    ? `<div class="tog" role="group" aria-label="Billing currency"><button data-currency="IN" class="${R === 'IN' ? 'on' : ''}">INR</button><button data-currency="GL" class="${R === 'GL' ? 'on' : ''}">USD</button></div>`
    : '';
  frame(`<section class="pxh"><h1 class="serif">Pick the depth that fits your day</h1><p class="tag">Every plan starts with a 7-day Pro trial. No card needed. Cancel any time.</p>${currencyToggle}<div class="tog" role="group" aria-label="Billing period"><button data-int="month" class="${INT === 'month' ? 'on' : ''}">Monthly</button><button data-int="year" class="${INT === 'year' ? 'on' : ''}">Yearly · 2 months free</button></div></section><div class="plans">${card('lite', 'Lite', 'The finite daily briefing for professionals.', 'Signal Desk')}${card('pro', 'Pro', 'The endless mix, plus tools for people who act on news.', 'Daily Mix')}</div><p id="pxmsg" class="err" role="status"></p><p class="mu fine">Prices in ${R === 'IN' ? 'Indian rupees' : 'US dollars'}; applicable taxes are shown at checkout. Features marked <i>soon</i> are being built and join your plan at no extra cost. <a href="/refund">Refunds &amp; cancellation</a> · <a href="/terms">Terms</a></p>`);
}

async function checkout(plan) {
  if (busy) return; busy = true; let opened = false;
  const msg = (t) => { const m = $('#pxmsg'); if (m) m.textContent = t; };
  try {
    const e = await env(), R = CUR || region(e), t = await window.BSAuth.token();
    const gstin = R === 'IN' ? $('#gstin')?.value?.trim() || '' : '';
    const switching = ACC?.status === 'active' && ACC.plan && ACC.plan !== plan;
    const endpoint = switching ? '/api/plan/switch' : '/api/checkout';
    const payload = switching
      ? { plan, apply_at: plan === 'pro' ? 'now' : 'cycle_end' }
      : { plan, interval: INT, currency: R === 'IN' ? 'INR' : 'USD', gstin };
    const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'checkout failed');
    if (switching) {
      msg(j.scheduled_for === 'now' ? 'Your Pro upgrade is being applied now.' : 'Your plan change is scheduled for the end of this billing period.');
      await loadAccess();
      busy = false;
      return;
    }
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
  const label = { trialing: 'Free trial (Pro)', active: 'Active', past_due: 'Payment problem', canceled: 'Cancelled', expired: 'Trial ended', none: 'No plan' };
  let body = '<p class="mu">Plan details are unavailable right now. Please try again shortly.</p>';
  if (a) {
    const line = a.status === 'trialing' ? `Trial ends on <b>${fd(a.trial_ends_at)}</b> (${a.days_left} day${a.days_left === 1 ? '' : 's'} left).`
      : a.status === 'active' ? `${a.plan === 'pro' ? 'Pro' : 'Lite'} plan.${a.current_period_end ? ' Renews on <b>' + fd(a.current_period_end) + '</b>.' : ''}`
      : a.status === 'canceled' ? `Access until <b>${fd(a.current_period_end)}</b>.` : '';
    body = `<p><b>${label[a.status] || esc(a.status)}</b></p><p class="mu">${line}</p><p><a class="btn" href="#/pricing">${a.status === 'active' ? 'Change plan' : 'Choose a plan'}</a> ${a.status === 'active' ? '<button class="btn" id="cx">Cancel subscription</button>' : ''}</p><p id="pxmsg" class="mu" role="status"></p>`;
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
        ? 'TOTP is verified for this session. Mailbox connections are enabled.'
        : 'TOTP is active. Enter an authenticator code when signing in before connecting a mailbox.'
      : 'Mailbox connections require a verified authenticator app (TOTP).';
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
    message.textContent = 'Authenticator verified. Mailbox connections are now enabled for this session.';
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
  const t = e.target.closest?.('[data-plan],[data-int],[data-currency],#cx,#delete-email-data,#mfa-start'); if (!t) return;
  if (t.dataset.int) { INT = t.dataset.int; pricing(); }
  else if (t.dataset.currency) { CUR = t.dataset.currency; pricing(); }
  else if (t.dataset.plan) checkout(t.dataset.plan);
  else if (t.id === 'delete-email-data') deleteEmailData();
  else if (t.id === 'mfa-start') startMfaEnrollment();
  else cancel();
});
document.addEventListener('bs:auth', onAuth);
addEventListener('hashchange', page);
setInterval(() => { if (authed()) loadAccess(); }, 10 * 60 * 1000);
onAuth();
