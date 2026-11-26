// BingleSignal premium layer: plan access, trial banner, pricing, paused and account screens.
// It FAILS OPEN: if the access check is unavailable (SQL not applied yet, outage) nobody is blocked.
const BS = window.BS || (window.BS = {}), $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SB = BS.supabaseUrl, KEY = BS.supabaseKey, ENFORCE = BS.paywall !== false;
// Everything the pricing page says (name, bullets, heading, price) lives in public/config.js, so you edit it there.
const PLAN = Object.assign({ heading: 'One plan. The whole briefing.', note: 'Free for 7 days, no card needed. Subscribe during your trial and the days you have left are added to your plan. Cancel any time.',
  name: 'BingleSignal Briefing', label: 'Daily briefing', tagline: "The signal from today's news, summarised for you, with videos picked for how you watch.", features: [], soon: [],
  fine: 'One price worldwide: {usd} a month. In India you can pay the same price in rupees at the live exchange rate, and you see the exact total before you pay. If you pay in US dollars your bank may add its own exchange rate and fees. Payments are processed by Razorpay.',
  usdNote: 'International card. Your bank may add its own exchange rate and fees, and some Indian cards block dollar payments.',
  faqHeading: 'Questions', faq: [] }, BS.plan || {});
const PLAN_NAME = PLAN.name;
// [text, live?]  live = works today, otherwise shown as "soon" (we never sell what is not built)
const FEATS = [...(PLAN.features || []).map((t) => [t, 1]), ...(PLAN.soon || []).map((t) => [t, 0])];
const USD = Number(BS.price?.usd ?? 5);   // one price worldwide
// Free trial: 7 days for every new account. Subscribing during it keeps the days left: the worker takes the first payment on the day the
// trial ends, so those days are added to the plan. This file only words it; what is charged is decided in worker/src/index.js.
const fill = (s) => esc(s).replace(/\{usd\}/g, () => '$' + USD);   // text typed in config.js: {usd} becomes the price, e.g. $5
const money = (n) => Number(n).toLocaleString('en-IN');
let ACC = null, ENVI = null, INT = 'month', QUOTE = null, NOTICE = '', busy = false, pendingMfaEnrollment = null;
let PAYSTEP = null, PAYER = 'Razorpay';   // PAYSTEP 'choose' = PayPal first / "Choose another option"; 'other' = the Razorpay screens below
const acc = { get now() { return ACC; }, ready: Promise.resolve() };
window.BSAccess = acc;
const authed = () => !!window.BSAuth?.has?.();
const fd = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const dayWord = (n) => `${n} day${n === 1 ? '' : 's'}`;
// The one sentence about the trial, used on the Account and Manage screens.
const trialLine = (a) => a.trial_subscribed
  ? `You have subscribed. Your free trial runs until <b>${fd(a.trial_ends_at)}</b> (${dayWord(a.days_left)} left) and your first payment is taken then.`
  : `Trial ends on <b>${fd(a.trial_ends_at)}</b> (${dayWord(a.days_left)} left). Subscribe before then and the ${a.days_left === 1 ? 'day' : 'days'} you have left ${a.days_left === 1 ? 'is' : 'are'} added to your plan: your first payment is taken on <b>${fd(a.trial_ends_at)}</b>.`;
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
  if (a?.status === 'trialing' && a.trial_subscribed) m = `<span><b>Free trial</b> · ${dayWord(a.days_left)} left · you are subscribed, first payment on <b>${fd(a.trial_ends_at)}</b></span><a class="btn sm" href="#/account">Manage plan</a>`;
  else if (a?.status === 'trialing') m = `<span><b>Free trial</b> · ${dayWord(a.days_left)} left · no card needed. Subscribe any time and the days you have left are added to your plan.</span><a class="btn sm" href="/pricing">Subscribe</a>`;
  else if (a?.status === 'past_due') m = '<span><b>Payment problem.</b> Please update your payment method to keep your plan.</span><a class="btn sm" href="#/account">Manage plan</a>';
  else if (a?.status === 'canceled' && a.has_access) m = `<span>Your plan ends on <b>${fd(a.current_period_end)}</b>.</span><a class="btn sm" href="/pricing">Renew</a>`;
  b.innerHTML = m; b.hidden = !m;
}

const brandHTML = () => '<a class="brand serif" href="/" aria-label="BingleSignal home">' + (window.BSChrome?.brandInner ? window.BSChrome.brandInner('g3') : '<span>Bingle<em>Signal</em></span>') + '</a>';
function frame(inner) {
  const p = $('#px');
  const light = document.documentElement?.getAttribute?.('data-theme') === 'light';
  p.innerHTML = `<header class="top"><div class="wrap bar">${brandHTML()}<nav class="hdr-r" aria-label="Main"><a class="link nv" href="/pricing">Pricing</a>${authed() ? '<a class="link" href="#/account">Account</a><a class="btn fill sm" href="#/me/read">My briefing</a><button class="link" data-so>Sign out</button>' : '<button class="link" type="button" data-signin>Sign in</button><button class="btn fill sm" type="button" data-start>Start free</button>'}</nav><button class="tgl" id="tgl" type="button" aria-label="${light ? 'Switch to dark mode' : 'Switch to light mode'}" title="Light or dark">${light ? '☾' : '☀'}</button></div></header><main class="pxw">${inner}</main>`;
  p.hidden = false; $('#home').hidden = true; $('#app').hidden = true; window.scrollTo(0, 0);
}

// India only: the "how would you like to pay" step. The rupee figure is the live quote from /api/quote (the server recomputes it at checkout).
function payBox(e) {
  const q = QUOTE?.inr, rails = e.rails || {}, out = [];
  if (NOTICE) out.push(`<p class="err" role="status">${esc(NOTICE)}</p>`);
  if (q && rails.razorpay_inr) {
    const gst = q.gst_percent > 0 ? ` + ${esc(q.gst_percent)}% GST ₹${money(q.gst_inr)}` : '';
    const rounding = q.rounding_inr > 0 ? ` + ₹${money(q.rounding_inr)} rounding` : '';
    out.push(`<button class="btn fill wide" data-pay="INR">Pay ₹${money(q.total_inr)} a month in rupees</button>`
      + `<small class="mu">$${USD.toFixed(2)} at today's rate (₹${esc(q.rate)} per $1) = ₹${money(q.base_inr)}${gst}${rounding}. Your rupee amount is fixed when you subscribe and stays the same every month.</small>`);
  } else if (rails.razorpay_inr) {
    out.push('<small class="mu">The live rupee price is unavailable right now. Please try again in a minute.</small>');
  }
  if (rails.razorpay_usd) out.push(`<button class="btn wide" data-pay="USD">Pay $${USD.toFixed(2)} a month in US dollars</button>${PLAN.usdNote ? `<small class="mu">${esc(PLAN.usdNote)}</small>` : ''}`);
  out.push('<button class="btn sm" data-pay-cancel>Back</button>');
  return `<div class="paybox" role="group" aria-label="Choose how to pay"><p class="mu">How would you like to pay?</p>${out.join('')}</div>`;
}

// PayPal is the first choice. Everything Razorpay does (rupees, dollars, cards, UPI) is behind "Choose another option" and is unchanged.
function chooseBox(e) {
  const rails = e.rails || {}, india = region(e) === 'IN';
  const otherReady = india ? !!(rails.razorpay_inr || rails.razorpay_usd) : !!rails.razorpay_usd;
  const out = [];
  if (NOTICE) out.push(`<p class="err" role="status">${esc(NOTICE)}</p>`);
  out.push(`<button class="btn fill wide" data-pay-paypal>Pay $${USD.toFixed(2)} a month via PayPal</button><small class="mu">You pay in US dollars. PayPal may add its own currency conversion if your account uses another currency.</small>`);
  if (otherReady) out.push('<button class="btn wide" data-pay-other>Choose another option</button>');
  out.push('<button class="btn sm" data-pay-back>Back</button>');
  return `<div class="paybox" role="group" aria-label="Choose how to pay"><p class="mu">How would you like to pay?</p>${out.join('')}</div>`;
}

async function pricing() {
  const e = await env(), india = region(e) === 'IN', rails = e.rails || {};
  const ready = !!rails.paypal || (india ? !!(rails.razorpay_inr || rails.razorpay_usd) : !!rails.razorpay_usd);
  const active = ACC?.status === 'active';
  const trialing = ACC?.status === 'trialing', trialSubscribed = trialing && !!ACC.trial_subscribed;
  let cta;
  if (!authed()) cta = `<button class="btn fill wide" type="button" data-start>Start 7-day free trial</button><small class="mu">No card needed. Subscribe during the trial and the days you have left are added to your plan, then $${USD} a month.</small>`;
  else if (active) cta = '<button class="btn wide" disabled>Your current plan</button>';
  else if (trialSubscribed) cta = `<button class="btn wide" disabled>Subscribed</button><small class="mu">Your free trial runs until <b>${fd(ACC.trial_ends_at)}</b>. Your first payment of $${USD} is taken then.</small>`;
  else if (!ready) cta = '<button class="btn wide" disabled>Payments opening soon</button><small class="mu">Please check back shortly.</small>';
  else if (PAYSTEP === 'choose' && rails.paypal) cta = chooseBox(e);
  else if (QUOTE && india) cta = payBox(e);
  else cta = `<button class="btn fill wide" data-plan="lite">Subscribe · $${USD}/month</button>`;
  // Still in the free trial: say what subscribing now does. Nothing is charged until the trial is over, so the days left are added to the plan.
  if (trialing && !trialSubscribed && ready) cta += `<small class="mu"><b>Nothing is charged today.</b> Your ${dayWord(ACC.days_left)} of free trial are added to your plan${fd(ACC.trial_ends_at) ? `: your first payment is on <b>${fd(ACC.trial_ends_at)}</b>` : ''}.</small>`;
  const card = `<article class="card plan hot"><div class="eyebrow">${esc(PLAN.label)}</div><h2 class="serif">${esc(PLAN_NAME)}</h2><p class="mu">${esc(PLAN.tagline)}</p><div class="price"><span>$</span><b>${esc(USD)}</b><small>/mo</small></div><ul>${FEATS.map(([t, live]) => `<li class="${live ? '' : 'soon'}">${esc(t)}${live ? '' : ' <i>soon</i>'}</li>`).join('')}</ul>${cta}</article>`;
  const faq = (PLAN.faq || []).filter((x) => Array.isArray(x) && x[0] && x[1]);
  const faqCard = faq.length ? `<div class="plans faq"><section class="card"><h2 class="serif">${esc(PLAN.faqHeading)}</h2>${faq.map(([q, a]) => `<h3 class="serif">${esc(q)}</h3><p class="mu">${fill(a)}</p>`).join('')}</section></div>` : '';
  // What is free and what is paid: the rows come from config.js (BS.compare).
  const CMP = BS.compare || {}, rows = (CMP.rows || []).filter((r) => Array.isArray(r) && r[0]), heads = CMP.headings || ['Free, no sign-up', 'With the plan'];
  const cellText = (t) => fill(t).replace(/\{readCap\}/g, () => String(BS.readCap || 200)).replace(/\{watchCap\}/g, () => String(BS.watchCap || 200));
  const mark = (yes) => (yes ? '<span class="y" aria-label="Included">✓</span>' : '<span class="n" aria-label="Not included">—</span>');
  const compareCard = rows.length ? `<div class="plans cmpw"><section class="card cmp"><h2 class="serif">${esc(CMP.title || 'What is free and what is paid')}</h2><table><thead><tr><th scope="col">What you get</th><th scope="col">${esc(heads[0])}</th><th scope="col">${esc(heads[1])}</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${cellText(r[0])}</td><td>${mark(r[1])}</td><td>${mark(r[2])}</td></tr>`).join('')}</tbody></table></section></div>` : '';
  // Reader quotes and the proof line are shown ONLY when they are filled in (config.js: BS.reviews, BS.proof). Nothing is ever invented.
  const reviews = (BS.reviews || []).filter((r) => r && r.quote);
  const reviewCard = reviews.length ? `<div class="plans cmpw"><section class="card"><h2 class="serif">What readers say</h2><div class="rev">${reviews.slice(0, 3).map((r) => `<blockquote><p>“${esc(r.quote)}”</p><cite>${esc([r.name, r.role].filter(Boolean).join(', '))}</cite></blockquote>`).join('')}</div></section></div>` : '';
  const proofLine = BS.proof ? `<p class="proof">${esc(BS.proof)}</p>` : '';
  frame(`<section class="pxh"><h1 class="serif">${esc(PLAN.heading)}</h1><p class="tag">${esc(PLAN.note)}</p>${proofLine}</section><div class="plans">${card}</div><p id="pxmsg" class="err" role="status"></p>${compareCard}${reviewCard}${faqCard}<p class="mu fine">${fill(PLAN.fine)} <a href="/refund">Refunds &amp; cancellation</a> · <a href="/terms">Terms</a></p>`);
}

// Step 1 of paying. With PayPal switched on, everybody first sees "Pay via PayPal" and "Choose another option".
async function startPay() {
  if (busy) return;
  const e = await env();
  if (e.rails?.paypal) { PAYSTEP = 'choose'; NOTICE = ''; return pricing(); }
  return payOtherWay(e);
}

// The Razorpay path, exactly as it was. Outside India there is nothing to choose, so go straight to the dollar checkout.
async function payOtherWay(e) {
  if (busy) return;
  e = e || await env();
  PAYSTEP = 'other';
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

// PayPal: the server creates the subscription and gives us PayPal's approval page; we send the customer there.
async function checkoutPaypal() {
  if (busy) return; busy = true; let left = false;
  try {
    const t = await window.BSAuth.token();
    const r = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify({ interval: 'month', currency: 'USD', provider: 'paypal' }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { window.BSAuth.expired(); NOTICE = 'Your session ended. Please sign in again, then press Subscribe once more.'; return; }
    if (!r.ok) throw new Error(j.error || 'checkout failed');
    if (j.provider !== 'paypal' || !j.url) throw new Error('PayPal did not return a checkout page');
    left = true; location.href = j.url;
  } catch (err) { NOTICE = 'Could not start PayPal: ' + err.message; }
  finally { if (!left) { busy = false; pricing(); } }
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
    if (r.status === 401) { window.BSAuth.expired(); msg('Your session ended. Please sign in again, then press Subscribe once more.'); return; }
    if (r.status === 409 && j.code === 'rate_changed' && j.quote) { QUOTE = { inr: j.quote }; NOTICE = j.error; await pricing(); return; }
    if (!r.ok) throw new Error(j.error || 'checkout failed');
    if (j.provider === 'global') { opened = true; location.href = j.url; return; } // an old, still-open checkout from the previous provider
    await loadScript('https://checkout.razorpay.com/v1/checkout.js');
    new window.Razorpay({ key: j.key_id, subscription_id: j.subscription_id, name: 'BingleSignal', description: PLAN_NAME, prefill: { email: window.BSAuth.user()?.email || '' }, theme: { color: '#D4B46A' }, handler: (response) => { activating(response?.razorpay_payment_id); }, modal: { ondismiss: () => { busy = false; } } }).open();
    opened = true;
  } catch (err) { msg('Could not start checkout: ' + err.message + '. Please try again, or email us and we will set it up.'); }
  finally { if (!opened) busy = false; }
}

const POLL_MS = Number(BS.pollMs) > 0 ? Number(BS.pollMs) : 3000;   // how often we ask "is the plan active yet?"
async function activating(paymentId, who) {
  if (who) PAYER = who;
  frame(`<section class="pxh"><h1 class="serif">Payment received</h1><p class="tag" id="pxmsg">Confirming your payment with ${PAYER}. This usually takes a few seconds, so please stay on this page…</p></section>`);
  for (let i = 0; i < 60; i++) {   // about three minutes
    await new Promise((r) => setTimeout(r, POLL_MS));
    await loadAccess();
    if (ACC?.status === 'active') { busy = false; return welcome(); }
    if (PAYER === 'PayPal' && ACC?.trial_subscribed) { busy = false; return subscribedInTrial(); }   // approved during the free trial: the first charge is still to come
  }
  busy = false; stillWaiting(paymentId);
}

function welcome() {
  frame('<section class="pxh"><h1 class="serif">You are in. Welcome to BingleSignal.</h1><p class="tag">Your plan is active. Start reading now, or tell us what matters to you first so your briefing is ranked for you from the very first story.</p></section><div class="plans"><article class="card plan hot"><a class="btn fill wide" href="#/me/read">Start my briefing</a><button class="btn wide" data-personalize>Personalize my priorities</button></article></div>');
}

function subscribedInTrial() {
  frame(`<section class="pxh"><h1 class="serif">You are subscribed</h1><p class="tag">PayPal has confirmed your subscription. Your free trial runs until <b>${fd(ACC.trial_ends_at)}</b> and your first payment of $${USD} is taken then.</p></section><div class="plans"><article class="card plan hot"><a class="btn fill wide" href="#/me/read">Back to my briefing</a></article></div>`);
}

function stillWaiting(paymentId) {
  frame(`<section class="pxh"><h1 class="serif">Payment received</h1><p class="tag">Your bank has confirmed the payment, but switching your plan on is taking longer than usual. You do not need to pay again: your plan unlocks by itself as soon as ${PAYER} confirms it.${paymentId ? ' Reference: ' + esc(paymentId) + '.' : ''}</p></section><div class="plans"><article class="card"><button class="btn fill wide" data-recheck>Check again</button><a class="btn wide" href="/contact">Contact us</a></article></div>`);
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
  frame(`<section class="pxh"><h1 class="serif">Subscribe to read your briefing</h1><p class="tag">Your settings are saved. Choose a plan and your briefing starts straight away.</p></section><div class="card paused"><h3 class="serif">Today's top stories</h3><ul>${tease}</ul><a class="btn fill" href="/pricing">Choose a plan</a> <a class="btn" href="/contact">Talk to us</a></div>`);
}

async function account() {
  if (!authed()) { location.hash = '#/me/read'; return; }
  await acc.ready; const a = ACC;
  const label = { trialing: 'Free trial', active: 'Active', past_due: 'Payment problem', canceled: 'Cancelled', expired: 'Not subscribed', none: 'Not subscribed' };
  let body = '<p class="mu">Plan details are unavailable right now. Please try again shortly.</p>';
  if (a) {
    const line = a.status === 'trialing' ? trialLine(a)
      : a.status === 'active' ? `Briefing plan.${a.current_period_end ? ' Renews on <b>' + fd(a.current_period_end) + '</b>.' : ''}`
      : a.status === 'canceled' ? `Access until <b>${fd(a.current_period_end)}</b>.` : '';
    body = `<p><b>${label[a.status] || esc(a.status)}</b></p><p class="mu">${line}</p><p>${a.status === 'active' || a.trial_subscribed ? '' : '<a class="btn" href="/pricing">Subscribe</a>'} ${a.status === 'active' ? '<button class="btn" id="cx">Cancel subscription</button>' : ''}</p><p id="pxmsg" class="mu" role="status"></p>`;
  }
  frame(`<section class="pxh"><h1 class="serif">Your account</h1><p class="tag">${esc(window.BSAuth.user()?.email || '')}</p></section><div class="card">${body}</div><section class="card"><h2 class="serif">Time saved</h2><p id="time-saved" class="mu">${timeSavedHTML()}</p><p class="mu fine">How it is measured: the stories you read × ${ART_MIN} minutes (about how long an original article takes) minus the time you actually spent on their summaries.</p></section><section class="card"><h2 class="serif">Manage account</h2><p class="mu">See the stories you liked, saved or marked not interested, and your subscription plan.</p><p><a class="btn fill" href="#/manage">Manage account</a> <button class="btn" data-so>Sign out</button></p></section><section class="card"><h2 class="serif">Privacy</h2><p class="mu">Delete your connected mailboxes, summaries, email reports, and encryption keys. This cannot be undone.</p><button class="btn" id="delete-email-data">Delete email data</button><p id="privacy-msg" class="mu" role="status"></p></section><p class="mu fine">Invoices, data export or deletion: <a href="mailto:${esc(BS.email || '')}">${esc(BS.email || 'contact us')}</a>${BS.portalUrl ? ` · <a href="${esc(BS.portalUrl)}" target="_blank" rel="noopener noreferrer">Manage billing</a>` : ''}</p>`);
}

// ---------- time saved: measured, not guessed ----------
const ART_MIN = Number(BS.articleMinutes) > 0 ? Number(BS.articleMinutes) : 3;   // minutes an original article takes to read; change it in config.js (articleMinutes)
const hm = (m) => { m = Math.max(0, Math.round(m)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
function timeSavedHTML() {
  const s = window.BSAuth.stats?.() || { stories: 0, seconds: 0 };
  if (!s.stories) return 'Nothing measured yet. Read a few stories in your briefing: we time how long each summary takes you and compare that with reading the originals.';
  const spent = s.seconds / 60, would = s.stories * ART_MIN, saved = Math.max(0, would - spent);
  return `You have saved about <b>${hm(saved)}</b>. You read <b>${s.stories}</b> story summar${s.stories === 1 ? 'y' : 'ies'} in about ${hm(spent)}; the originals would have taken about ${hm(would)} (${s.stories} × ${ART_MIN} min).`;
}

// ---------- Manage account: liked, saved, not interested, subscription, security ----------
const KINDS = [['liked', 'Liked', 'Unlike'], ['saved', 'Saved', 'Remove'], ['hidden', 'Not interested', 'Show again']];
const EMPTY = { liked: 'Stories you like will be listed here.', saved: 'Stories you save will be listed here.', hidden: 'Stories you mark not interested will be listed here, so you can bring them back.' };
const SECURITY_HTML = `<h2 class="serif">Security</h2><p id="mfa-status" class="mu" role="status">Checking your authenticator settings…</p><button class="btn" id="mfa-start">Set up authenticator</button><div id="mfa-enrollment" hidden><p>In your authenticator app choose “add account” and enter this setup key:</p><p><code id="mfa-secret"></code></p><form id="mfa-enrollment-form"><label>6-digit code<input id="mfa-enrollment-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></label><button class="btn fill" type="submit">Verify authenticator</button></form></div><p id="mfa-message" class="mu" role="status"></p>`;
let MTAB = 'liked';
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? esc(u) : '#');

function planHTML(a) {
  if (!a) return '<p class="mu">Plan details are unavailable right now. Please try again shortly.</p>';
  const label = { trialing: 'Free trial', active: 'Active', past_due: 'Payment problem', canceled: 'Cancelled', expired: 'Not subscribed', none: 'Not subscribed' };
  const line = a.status === 'trialing' ? trialLine(a)
    : a.status === 'active' ? `Briefing plan, $${USD} a month.${a.current_period_end ? ' Renews on <b>' + fd(a.current_period_end) + '</b>.' : ''}`
    : a.status === 'canceled' ? `Access until <b>${fd(a.current_period_end)}</b>.` : 'You are not subscribed yet.';
  return `<p><b>${label[a.status] || esc(a.status)}</b></p><p class="mu">${line}</p><p>${a.status === 'active' ? '<button class="btn" id="cx">Cancel subscription</button>' : a.trial_subscribed ? '' : '<a class="btn fill" href="/pricing">Subscribe</a>'}</p><p id="pxmsg" class="mu" role="status"></p>`;
}

async function manage() {
  if (!authed()) { location.hash = '#/me/read'; return; }
  await acc.ready;
  let lists = { liked: [], saved: [], hidden: [] };
  try { lists = await window.BSAuth.lists(); } catch { /* an empty list is better than a broken page */ }
  const tab = (k, name, n) => `<button class="chip${MTAB === k ? ' on' : ''}" data-mt="${k}" aria-pressed="${MTAB === k}">${name}${n === undefined ? '' : ' ' + n}</button>`;
  const tabs = KINDS.map(([k, name]) => tab(k, name, lists[k].length)).join('') + tab('plan', 'Subscription') + tab('security', 'Security');
  let inner;
  if (MTAB === 'plan') inner = planHTML(ACC);
  else if (MTAB === 'security') inner = SECURITY_HTML;
  else {
    const undo = KINDS.find(([k]) => k === MTAB)[2], rows = lists[MTAB] || [];
    inner = rows.length ? rows.map((r) => `<div class="mrow"><div>${r.t ? `<a href="${safeUrl(r.u)}" target="_blank" rel="noopener noreferrer">${esc(r.t)}</a>` : '<span class="mu">A story that has left your feed</span>'}${r.s ? `<small class="mu">${esc(r.s)}</small>` : ''}</div><button class="btn sm" data-um="${MTAB}" data-id="${esc(r.id)}">${undo}</button></div>`).join('')
      : `<p class="mu">${EMPTY[MTAB]}</p>`;
  }
  frame(`<section class="pxh"><h1 class="serif">Manage account</h1><p class="tag">${esc(window.BSAuth.user()?.email || '')}</p></section><div class="chips mtabs" role="group" aria-label="Manage account sections">${tabs}</div><section class="card">${inner}</section><p class="mu fine"><a href="#/account">Back to your account</a></p>`);
  if (MTAB === 'security') { refreshMfaStatus(); const f = $('#mfa-enrollment-form'); if (f) f.onsubmit = verifyMfaEnrollment; }
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
const onPricingPath = () => String(location.pathname || '').replace(/\/+$/, '') === '/pricing';
const paypalQuery = () => { try { return new URLSearchParams(location.search || '').get('paypal'); } catch { return null; } };
async function page() {
  const h = location.hash;
  const pp = paypalQuery();
  if (pp && onPricingPath() && authed()) {   // the customer is back from PayPal (?paypal=return) or pressed "cancel" there (?paypal=cancel)
    try { history.replaceState(null, '', '/pricing'); } catch { /* the page still shows */ }
    if (pp === 'return') return activating(null, 'PayPal');
    NOTICE = 'PayPal checkout was cancelled. You have not been charged.'; PAYSTEP = 'choose';
    return pricing();
  }
  if (/^#\/pricing/.test(h)) { try { history.replaceState(null, '', '/pricing'); } catch { /* the page still shows */ } return pricing(); }
  if (/^#\/paused/.test(h)) return paused();
  if (/^#\/account/.test(h)) return account();
  if (/^#\/manage/.test(h)) return manage();
  if (onPricingPath() && !/^#\/(me|onboarding|email)/.test(h)) return pricing();
  $('#px')?.setAttribute('hidden', ''); gate();
}
// `ready` must depend ONLY on the access check (pages and the feed wait on it, so it must never wait on a page)
function pageFailed(err) {
  try { console.error('BingleSignal page error', err); } catch {}
  const p = $('#px'); if (!p || !onPricingPath()) return;
  p.hidden = false;
  p.innerHTML = `<main class="legal"><h1 class="serif">This page could not load</h1><p>${esc(err?.message || String(err))}</p><p><a class="btn fill" href="/pricing">Try again</a></p></main>`;
}
const FEATS = [...(PLAN.features || []).filter(Boolean).map((t) => [t, 1]), ...(PLAN.soon || []).filter(Boolean).map((t) => [t, 0])];

document.addEventListener('click', (e) => {
  const t = e.target.closest?.('[data-plan],[data-pay],[data-pay-cancel],[data-pay-paypal],[data-pay-other],[data-pay-back],#cx,#delete-email-data,#mfa-start,[data-so],[data-mt],[data-um],[data-personalize],[data-recheck]'); if (!t) return;
  if (t.dataset.payPaypal !== undefined) checkoutPaypal();
  else if (t.dataset.payOther !== undefined) payOtherWay();
  else if (t.dataset.payBack !== undefined) { PAYSTEP = null; NOTICE = ''; pricing(); }
  else if (t.dataset.payCancel !== undefined) { QUOTE = null; NOTICE = ''; PAYSTEP = ENVI?.rails?.paypal ? 'choose' : null; pricing(); }
  else if (t.dataset.pay) checkout(t.dataset.pay);
  else if (t.dataset.plan) startPay();
  else if (t.id === 'delete-email-data') deleteEmailData();
  else if (t.id === 'mfa-start') startMfaEnrollment();
  else if (t.dataset.so !== undefined) window.BSAuth.out();
  else if (t.dataset.mt) { MTAB = t.dataset.mt; manage(); }
  else if (t.dataset.um) { window.BSAuth.forget(t.dataset.um, t.dataset.id); manage(); }
  else if (t.dataset.personalize !== undefined) { location.hash = '#/'; setTimeout(() => $('#tune')?.scrollIntoView({ behavior: 'smooth' }), 120); }
  else if (t.dataset.recheck !== undefined) activating();
  else cancel();
});
document.addEventListener('bs:auth', onAuth);
addEventListener('hashchange', page);
setInterval(() => { if (authed()) loadAccess(); }, 10 * 60 * 1000);
onAuth();
