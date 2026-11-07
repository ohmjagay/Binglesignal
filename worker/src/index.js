// BingleSignal API: runs on Cloudflare Workers inside the same deploy as the website.
// Only /api/* reaches this file; every other URL is served straight from /public.
//   GET  /api/health
//   POST /api/checkout           logged-in user picks a plan -> Razorpay subscription (India) or payment link (global)
//   POST /api/webhooks/razorpay  Razorpay tells us a payment happened
//   POST /api/webhooks/global    international provider (Standard Webhooks format, e.g. Dodo Payments)
// Secrets needed: see wrangler.example.toml
import { handleDeleteEmailData, handleEmailRequest, handleEmailSchedule } from './email-beta.js';
import { handleForwardEmail } from './forward.js';
import { handleBriefingRequest, handleEditionSchedule } from './briefing.js';
import { handleDeliveryRequest } from './delivery.js';
import { handleLifecycleSchedule } from './lifecycle.js';
import { checkApiRateLimit } from './rate-limit.js';
export { EmailAiBudget } from './llm.js';
export { ApiRateLimits } from './rate-limit.js';

const enc = new TextEncoder();
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, enc.encode(message));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- signature checks (proof the message really came from the payment provider) ----------
export async function verifyRazorpay(raw, signature, secret) {
  if (!signature || !secret) return false;
  return safeEqual(toHex(await hmac(enc.encode(secret), raw)), signature);
}
export async function verifyStandardWebhook(raw, headers, secret, now = Date.now(), toleranceSec = 300) {
  const id = headers.get('webhook-id'), ts = headers.get('webhook-timestamp'), sigs = headers.get('webhook-signature');
  if (!id || !ts || !sigs || !secret) return false;
  if (toleranceSec && Math.abs(now / 1000 - Number(ts)) > toleranceSec) return false;
  const expected = toB64(await hmac(fromB64(secret.replace(/^whsec_/, '')), `${id}.${ts}.${raw}`));
  return sigs.split(' ').some((s) => { const [v, sig] = s.split(','); return v === 'v1' && safeEqual(sig, expected); });
}

// ---------- payment events -> subscription changes ----------
const RAZORPAY_PLAN_CONFIGS = [
  ['RAZORPAY_PLAN_LITE_MONTHLY', 'lite', 'month', 'INR'],
  ['RAZORPAY_PLAN_PRO_MONTHLY', 'pro', 'month', 'INR'],
  ['RAZORPAY_PLAN_LITE_YEARLY', 'lite', 'year', 'INR'],
  ['RAZORPAY_PLAN_PRO_YEARLY', 'pro', 'year', 'INR'],
  ['RAZORPAY_PLAN_LITE_MONTHLY_USD', 'lite', 'month', 'USD'],
  ['RAZORPAY_PLAN_PRO_MONTHLY_USD', 'pro', 'month', 'USD'],
  ['RAZORPAY_PLAN_LITE_YEARLY_USD', 'lite', 'year', 'USD'],
  ['RAZORPAY_PLAN_PRO_YEARLY_USD', 'pro', 'year', 'USD'],
];

function razorpayPlan(planId, env) {
  if (!planId) return null;
  for (const [key, plan, interval, currency] of RAZORPAY_PLAN_CONFIGS) {
    if (env[key] && env[key] === planId) return { plan, interval, currency };
  }
  return null;
}

export function mapRazorpay(evt, env = {}) {
  const subscription = evt?.payload?.subscription?.entity;
  const payment = evt?.payload?.payment?.entity;
  const e = subscription || payment;
  if (!e) return null;
  const notes = e.notes || {};
  const at = evt.created_at ? new Date(evt.created_at * 1000).toISOString() : new Date().toISOString();
  const plan = razorpayPlan(subscription?.plan_id || payment?.plan_id, env);
  const subscriptionId = subscription?.id || payment?.subscription_id;
  const base = {
    provider: 'razorpay',
    ...(subscriptionId ? { provider_subscription_id: subscriptionId } : {}),
    ...(e.customer_id ? { provider_customer_id: e.customer_id } : {}),
    ...(plan ? { plan: plan.plan, billing_interval: plan.interval, currency: plan.currency } : {}),
    ...(notes.gstin ? { gstin: notes.gstin } : {}),
    last_event_at: at,
  };
  const end = subscription?.current_end ? { current_period_end: new Date(subscription.current_end * 1000).toISOString() } : {};
  const who = notes.user_id ? { user_id: notes.user_id } : null;
  if (!who) return null;
  const planEvents = ['subscription.authenticated', 'subscription.activated', 'subscription.charged',
    'subscription.resumed', 'subscription.updated', 'subscription.pending', 'subscription.paused',
    'subscription.halted', 'subscription.completed', 'subscription.cancelled'];
  if (subscription && planEvents.includes(evt.event) && !plan) {
    return { error: 'unknown_plan', planId: subscription.plan_id || null };
  }
  switch (evt.event) {
    case 'subscription.authenticated': return { who, patch: base };
    case 'subscription.activated':
    case 'subscription.charged':
    case 'subscription.resumed':
    case 'subscription.updated':
      return { who, patch: { ...base, ...end, status: 'active', cancel_at_period_end: false } };
    case 'subscription.pending':
    case 'payment.failed': return { who, patch: { ...base, ...end, status: 'past_due' } };
    case 'subscription.paused': return { who, patch: { ...base, ...end, status: 'canceled', cancel_at_period_end: true } };
    case 'subscription.halted':
    case 'subscription.completed':
    case 'payment.refunded':
    case 'refund.created': return { who, patch: { ...base, ...end, status: 'expired' } };
    case 'subscription.cancelled': return { who, patch: { ...base, ...end, status: 'canceled' } };
    default: return null;
  }
}
export function mapGlobal(evt, env = {}) {
  const d = evt?.data || {}, md = d.metadata || {};
  const knownTypes = new Set([
    'subscription.active', 'subscription.renewed', 'subscription.updated', 'subscription.paused',
    'subscription.on_hold', 'subscription.failed', 'subscription.cancelled', 'subscription.expired',
    'payment.failed', 'payment.refunded',
  ]);
  if (!knownTypes.has(evt?.type)) return null;
  const who = md.user_id ? { user_id: md.user_id } : null;
  if (!who) return null;
  const products = [
    ['GLOBAL_PRODUCT_LITE_MONTH', 'lite', 'month'],
    ['GLOBAL_PRODUCT_PRO_MONTH', 'pro', 'month'],
    ['GLOBAL_PRODUCT_LITE_YEAR', 'lite', 'year'],
    ['GLOBAL_PRODUCT_PRO_YEAR', 'pro', 'year'],
  ];
  const product = products.find(([key]) => env[key] && d.product_id === env[key]);
  const plan = product?.[1] || null;
  if (!plan) return { error: 'unknown_plan', productId: d.product_id || null };
  const base = { provider: 'global', currency: 'USD', provider_subscription_id: d.subscription_id || null,
    provider_customer_id: d.customer?.customer_id || null, last_event_at: evt.timestamp ? new Date(evt.timestamp).toISOString() : new Date().toISOString(),
    plan, billing_interval: product[2] };
  const end = d.next_billing_date ? { current_period_end: new Date(d.next_billing_date).toISOString() } : {};
  switch (evt.type) {
    case 'subscription.active':
    case 'subscription.renewed': return { who, patch: { ...base, ...end, status: 'active', cancel_at_period_end: false } };
    case 'subscription.updated': return { who, patch: { ...base, ...end, status: 'active' } };
    case 'subscription.paused': return { who, patch: { ...base, ...end, status: 'canceled', cancel_at_period_end: true } };
    case 'subscription.on_hold':
    case 'subscription.failed':
    case 'payment.failed': return { who, patch: { ...base, status: 'past_due' } };
    case 'subscription.cancelled': return { who, patch: { ...base, status: 'canceled' } };
    case 'subscription.expired': return { who, patch: { ...base, status: 'expired' } };
    case 'payment.refunded': return { who, patch: { ...base, status: 'expired' } };
    default: return null;
  }
}

// ---------- Supabase (server-side, service key) ----------
const sb = (env, path, init = {}) =>
  fetch(`${env.SUPABASE_URL}${path}`, { ...init, headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json', ...init.headers } });

async function recordBillingEvent(env, userId, name, props = {}) {
  try {
    const response = await sb(env, '/rest/v1/events', {
      method: 'POST',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: userId, name, props }),
    });
    if (!response.ok) console.warn('Billing event could not be recorded', { name, status_code: response.status });
  } catch {
    console.warn('Billing event could not be recorded', { name, status_code: 0 });
  }
}

async function applyPatch(env, m, eventId, provider, type) {
  if (!m.who.user_id || !eventId) throw new Error('Payment webhook is missing its user or event ID.');
  const r = await sb(env, '/rest/v1/rpc/apply_payment_webhook', {
    method: 'POST',
    body: JSON.stringify({
      p_event_key: `${provider}:${eventId}`,
      p_provider: provider,
      p_type: type,
      p_user_id: m.who.user_id,
      p_patch: m.patch,
    }),
  });
  if (!r.ok) throw new Error(`Payment webhook transaction failed: ${r.status}`);
  return r.json();
}

async function handleRazorpay(req, env) {
  const raw = await req.text();
  if (!(await verifyRazorpay(raw, req.headers.get('x-razorpay-signature'), env.RAZORPAY_WEBHOOK_SECRET))) return json({ error: 'bad signature' }, 401);
  let evt; try { evt = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }
  const m = mapRazorpay(evt, env);
  if (m?.error === 'unknown_plan') {
    console.error('Razorpay event references an unconfigured plan', {
      subscription_id: evt?.payload?.subscription?.entity?.id || null,
      plan_id: m.planId,
    });
    return json({ error: 'unknown plan' }, 422);
  }
  if (!m) return json({ ok: true, ignored: evt.event });
  const eventId = req.headers.get('x-razorpay-event-id');
  if (!eventId) return json({ error: 'missing event id' }, 400);
  await applyPatch(env, m, eventId, 'razorpay', evt.event);
  return json({ ok: true });
}
async function handleGlobal(req, env) {
  const raw = await req.text();
  if (!(await verifyStandardWebhook(raw, req.headers, env.GLOBAL_WEBHOOK_SECRET))) return json({ error: 'bad signature' }, 401);
  let evt; try { evt = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }
  const m = mapGlobal(evt, env);
  if (m?.error === 'unknown_plan') {
    console.error('Global payment event references an unconfigured product', {
      product_id: m.productId,
    });
    return json({ error: 'unknown plan' }, 422);
  }
  if (!m) return json({ ok: true, ignored: evt.type });
  const eventId = req.headers.get('webhook-id');
  if (!eventId) return json({ error: 'missing event id' }, 400);
  await applyPatch(env, m, eventId, 'global', evt.type);
  return json({ ok: true });
}

// ---------- checkout ----------
async function handleCheckout(req, env) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'login required' }, 401);
  const u = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}` } });
  if (!u.ok) return json({ error: 'invalid session' }, 401);
  const user = await u.json();
  let body = {}; try { body = await req.json(); } catch {}
  const plan = body.plan === 'lite' || body.plan === 'pro' ? body.plan : null;
  const interval = body.interval;
  const currency = body.currency || (req.headers.get('cf-ipcountry') === 'IN' ? 'INR' : 'USD');
  const gstin = typeof body.gstin === 'string' ? body.gstin.trim().toUpperCase() : '';
  if (!plan) return json({ error: 'plan must be lite or pro' }, 400);
  if (!['month', 'year'].includes(interval)) return json({ error: 'interval must be month or year' }, 400);
  if (!['INR', 'USD'].includes(currency)) return json({ error: 'currency must be INR or USD' }, 400);
  if (gstin && (currency !== 'INR' || !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin))) {
    return json({ error: 'Enter a valid 15-character GSTIN for an INR purchase.' }, 400);
  }
  const suffix = interval === 'year' ? 'YEARLY' : 'MONTHLY';
  const razorpayPlanId = env[`RAZORPAY_PLAN_${plan.toUpperCase()}_${suffix}${currency === 'USD' ? '_USD' : ''}`];
  const provider = currency === 'INR' || (body.provider === 'razorpay' && razorpayPlanId) ? 'razorpay' : 'global';
  if (provider === 'razorpay' && (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !razorpayPlanId)) {
    return json({ error: 'Razorpay plan is not configured for this currency and billing period.' }, 503);
  }
  if (provider === 'global' && !env[`GLOBAL_LINK_${plan.toUpperCase()}_${interval.toUpperCase()}`]) {
    return json({ error: 'Global checkout is not configured for this plan.' }, 503);
  }

  const attemptId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const reservationResponse = await sb(env, '/rest/v1/rpc/reserve_payment_checkout', {
    method: 'POST',
    body: JSON.stringify({
      p_user_id: user.id,
      p_attempt_id: attemptId,
      p_provider: provider,
      p_plan: plan,
      p_currency: currency,
      p_billing_interval: interval,
      p_gstin: gstin || null,
      p_expires_at: expiresAt,
    }),
  });
  if (!reservationResponse.ok) throw new Error(`Checkout reservation failed: ${reservationResponse.status}`);
  const reservation = await reservationResponse.json();
  if (reservation.state !== 'reserved') {
    if (reservation.state === 'open' && reservation.checkout_url) {
      return reservation.provider === 'razorpay'
        ? json({ provider: 'razorpay', key_id: env.RAZORPAY_KEY_ID,
          subscription_id: reservation.provider_subscription_id, short_url: reservation.checkout_url, existing: true })
        : json({ provider: reservation.provider, url: reservation.checkout_url, existing: true });
    }
    return json({ error: reservation.state === 'already_subscribed'
      ? 'An active or pending subscription already exists for this account.'
      : 'A checkout is already being created or is still open. Please return to that checkout or try again later.' }, 409);
  }

  await recordBillingEvent(env, user.id, 'checkout_started', { plan, interval, currency });
  let externalCheckoutCreated = false;
  try {
    if (provider === 'global') {
      const base = env[`GLOBAL_LINK_${plan.toUpperCase()}_${interval.toUpperCase()}`];
      const tpl = env.GLOBAL_LINK_PARAMS || 'email={email}&metadata_user_id={user_id}&metadata_plan={plan}&metadata_interval={interval}';
      const q = tpl.replace('{email}', encodeURIComponent(user.email || ''))
        .replace('{user_id}', encodeURIComponent(user.id)).replace('{plan}', plan).replace('{interval}', interval);
      const url = base + (base.includes('?') ? '&' : '?') + q;
      externalCheckoutCreated = true;
      const saved = await sb(env, '/rest/v1/rpc/finish_payment_checkout', {
        method: 'POST',
        body: JSON.stringify({ p_user_id: user.id, p_attempt_id: attemptId, p_provider_subscription_id: null, p_checkout_url: url }),
      });
      if (!saved.ok) throw new Error(`Checkout link could not be saved: ${saved.status}`);
      return json({ provider: 'global', url });
    }

    const subscriptionRows = await sb(env, `/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(user.id)}&select=status,trial_ends_at`);
    if (!subscriptionRows.ok) throw new Error(`Subscription lookup failed: ${subscriptionRows.status}`);
    const subscriptions = await subscriptionRows.json();
    const trialEnd = subscriptions?.[0]?.status === 'trialing' ? Date.parse(subscriptions[0].trial_ends_at) : 0;
    const startAt = trialEnd - Date.now() > 15 * 60 * 1000 ? Math.floor(trialEnd / 1000) : undefined;
    const r = await fetch('https://api.razorpay.com/v1/subscriptions', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`) },
      body: JSON.stringify({ plan_id: razorpayPlanId, total_count: interval === 'year' ? 10 : 120, quantity: 1,
        customer_notify: 1, expire_by: Math.floor(Date.now() / 1000) + 15 * 60,
        notes: { user_id: user.id, plan, interval, currency, ...(gstin ? { gstin } : {}) },
        ...(startAt ? { start_at: startAt } : {}) }) });
    const data = await r.json();
    if (!r.ok) {
      const released = await sb(env, '/rest/v1/rpc/release_payment_checkout', {
        method: 'POST', body: JSON.stringify({ p_user_id: user.id, p_attempt_id: attemptId }),
      });
      if (!released.ok) throw new Error(`Razorpay failed and checkout reservation cleanup failed: ${released.status}`);
      return json({ error: data?.error?.description || 'razorpay error' }, 502);
    }
    externalCheckoutCreated = true;
    const saved = await sb(env, '/rest/v1/rpc/finish_payment_checkout', {
      method: 'POST',
      body: JSON.stringify({ p_user_id: user.id, p_attempt_id: attemptId,
        p_provider_subscription_id: data.id, p_checkout_url: data.short_url }),
    });
    if (!saved.ok) throw new Error(`Razorpay checkout could not be saved: ${saved.status}`);
    return json({ provider: 'razorpay', key_id: env.RAZORPAY_KEY_ID, subscription_id: data.id, short_url: data.short_url });
  } catch (error) {
    if (!externalCheckoutCreated) {
      const released = await sb(env, '/rest/v1/rpc/release_payment_checkout', {
        method: 'POST', body: JSON.stringify({ p_user_id: user.id, p_attempt_id: attemptId }),
      });
      if (!released.ok) throw new Error(`Checkout creation failed and reservation cleanup failed: ${released.status}`);
    }
    throw error;
  }
}

// ---------- cancel (Razorpay: at cycle end. International: manual until a portal link is configured) ----------
async function authUser(req, env) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const u = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}` } });
  return u.ok ? u.json() : null;
}
async function handleCancel(req, env) {
  const user = await authUser(req, env);
  if (!user) return json({ error: 'login required' }, 401);
  const rows = await (await sb(env, `/rest/v1/subscriptions?user_id=eq.${user.id}&select=provider,provider_subscription_id,status,current_period_end`)).json();
  const s = rows?.[0];
  if (!s || s.status !== 'active' || !s.provider_subscription_id) return json({ error: 'no active subscription to cancel' }, 404);
  if (s.provider !== 'razorpay') return json({ ok: true, manual: true });
  const r = await fetch(`https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(s.provider_subscription_id)}/cancel`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`) },
    body: JSON.stringify({ cancel_at_cycle_end: 1 }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: data?.error?.description || 'razorpay error' }, 502);
  await sb(env, `/rest/v1/subscriptions?user_id=eq.${user.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' },
    body: JSON.stringify({ cancel_at_period_end: true, updated_at: new Date().toISOString() }) });
  return json({ ok: true, ends_at: s.current_period_end });
}

async function handlePlanSwitch(req, env) {
  const user = await authUser(req, env);
  if (!user) return json({ error: 'login required' }, 401);
  let body = {};
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
  if (!['lite', 'pro'].includes(body.plan)) return json({ error: 'plan must be lite or pro' }, 400);
  const rowsResponse = await sb(env, `/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(user.id)}&select=provider,provider_subscription_id,status,plan,currency,billing_interval`);
  if (!rowsResponse.ok) throw new Error(`Subscription lookup failed: ${rowsResponse.status}`);
  const subscription = (await rowsResponse.json())?.[0];
  if (!subscription || subscription.status !== 'active' || !subscription.provider_subscription_id) {
    return json({ error: 'An active subscription is required to switch plans.' }, 409);
  }
  if (subscription.provider !== 'razorpay') return json({ error: 'Use your payment provider portal to switch this plan.' }, 409);
  if (subscription.plan === body.plan) return json({ error: 'That is already your current plan.' }, 400);
  if (subscription.plan === 'lite' && body.plan === 'pro') {
    await recordBillingEvent(env, user.id, 'upgrade_clicked', { from_plan: subscription.plan, to_plan: body.plan });
  }
  const interval = subscription.billing_interval;
  const suffix = interval === 'year' ? 'YEARLY' : 'MONTHLY';
  const currencySuffix = subscription.currency === 'USD' ? '_USD' : '';
  const planId = interval && env[`RAZORPAY_PLAN_${body.plan.toUpperCase()}_${suffix}${currencySuffix}`];
  if (!planId) return json({ error: 'The requested plan is not configured for this subscription.' }, 503);
  const upgrading = subscription.plan === 'lite' && body.plan === 'pro';
  const scheduleChangeAt = body.apply_at === 'now' && upgrading ? 'now' : 'cycle_end';
  const response = await fetch(`https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(subscription.provider_subscription_id)}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      authorization: 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`),
    },
    body: JSON.stringify({ plan_id: planId, quantity: 1, schedule_change_at: scheduleChangeAt, customer_notify: true }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return json({ error: result?.error?.description || 'Razorpay could not switch this subscription.' }, 502);
  return json({ ok: true, plan: body.plan, scheduled_for: scheduleChangeAt });
}

export default {
  async email(message, env) {
    await handleForwardEmail(message, env);
  },
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    try {
      if (p === '/api/health') return json({ ok: true, time: new Date().toISOString(), country: req.headers.get('cf-ipcountry') || null,
        rails: { razorpay: !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_PLAN_LITE_MONTHLY && env.RAZORPAY_PLAN_PRO_MONTHLY),
                 global: !!(env.GLOBAL_LINK_LITE_MONTH && env.GLOBAL_LINK_PRO_MONTH) } });
      if (['/api/telegram/webhook', '/api/telegram/link-code', '/api/unsubscribe'].includes(p)) {
        return await handleDeliveryRequest(req, env);
      }
      if (['/api/pool', '/api/edition/latest', '/api/edition/event', '/api/metrics',
        '/api/feedback', '/api/profile', '/api/watchlist'].includes(p)) {
        return await handleBriefingRequest(req, env);
      }
      if (p === '/api/privacy/delete-email-data') return await handleDeleteEmailData(req, env);
      if (p.startsWith('/api/email/')) return await handleEmailRequest(req, env);
      if (req.method !== 'POST') return json({ error: 'not found' }, 404);
      if (p === '/api/checkout' || p === '/api/cancel' || p === '/api/plan/switch') {
        const action = p === '/api/checkout' ? 'checkout' : p === '/api/cancel' ? 'cancel' : 'plan_switch';
        const limit = await checkApiRateLimit(req, env, action);
        if (!limit.available) return json({ error: 'Rate limiting is temporarily unavailable; please try again shortly' }, 503);
        if (!limit.allowed) return new Response(JSON.stringify({ error: 'Too many requests; please try again later' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': action === 'checkout' ? '600' : '3600' },
        });
        if (action === 'checkout') return await handleCheckout(req, env);
        if (action === 'cancel') return await handleCancel(req, env);
        return await handlePlanSwitch(req, env);
      }
      if (p === '/api/webhooks/razorpay') return await handleRazorpay(req, env);
      if (p === '/api/webhooks/global') return await handleGlobal(req, env);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: 'server error' }, 500);   // provider will retry
    }
  },
  scheduled(controller, env, ctx) {
    const jobs = [handleEmailSchedule(controller.cron, env)];
    if (controller.cron === '*/15 * * * *') jobs.push(handleEditionSchedule(env), handleLifecycleSchedule(env));
    ctx.waitUntil(Promise.all(jobs));
  },
};
