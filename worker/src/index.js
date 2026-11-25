// BingleSignal API: runs on Cloudflare Workers inside the same deploy as the website.
// Only /api/* and the homepage (/) reach this file; every other URL is served straight from /public.
//   GET  /              the homepage with today's top headlines written into its HTML (so Google and WhatsApp can read them)
//   GET  /api/markets    Sensex, Nifty, Nasdaq... for the homepage side panel (cached 5 minutes)
//   GET  /api/logo?d=    the small icon of a news website, through our own server (cached 30 days)
//   GET  /api/health
//   GET  /api/teaser             public teaser of today's top stories: headline plus a short AI summary for the hover box (cached 5 minutes)
//   GET  /api/quote              live $5 -> INR quote (+GST) shown on the checkout step in India
//   POST /api/checkout           logged-in user subscribes to the single Briefing plan -> Razorpay subscription (INR or USD)
//   POST /api/webhooks/razorpay  Razorpay tells us a payment happened
//   POST /api/webhooks/paypal    PayPal tells us a subscription or payment changed (worker/src/paypal.js)
//   POST /api/webhooks/global    LEGACY: kept only so subscribers who paid through the old global provider keep working
// Secrets needed: see wrangler.example.toml
import { handleDeleteEmailData, handleEmailRequest, handleEmailSchedule } from './email-beta.js';
import { handleForwardEmail } from './forward.js';
import { handleBriefingRequest, handleEditionSchedule } from './briefing.js';
import { handleDeliveryRequest } from './delivery.js';
import { handleLifecycleSchedule } from './lifecycle.js';
import { checkApiRateLimit } from './rate-limit.js';
import { missingSupabaseConfig, supabaseKeyHeaders } from './supabase.js';
import { sanitizeStory, pickRepresentative, publisherTier, publisherTrust, publisherDomain, isGoogleNewsUrl, dropRepeats } from './story-quality.js';
import { handleMarkets } from './markets.js';
import { handleLogo } from './logo.js';
import { handleHome } from './home.js';
import { notFound } from './notfound.js';
import { hostOf } from '../../public/textfmt.js';
import { handleQuote, getInrQuote, assertInrUnitPlan, gstPercent, QuoteUnavailable, PlanMisconfigured } from './pricing.js';
import { paypalConfigured, paypalMode, createPaypalSubscription, getPaypalSubscription, cancelPaypalSubscription, verifyPaypalWebhook, paypalSubscriptionId, mapPaypal, PaypalError } from './paypal.js';
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
  fetch(`${env.SUPABASE_URL}${path}`, { ...init, headers: { ...supabaseKeyHeaders(env.SUPABASE_SERVICE_ROLE_KEY),
    'content-type': 'application/json', ...init.headers } });

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
async function handlePaypal(req, env) {
  const raw = await req.text();
  if (!(await verifyPaypalWebhook(env, req.headers, raw))) return json({ error: 'bad signature' }, 401);
  let evt; try { evt = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }
  const subscriptionId = paypalSubscriptionId(evt);
  if (!subscriptionId) return json({ ok: true, ignored: evt?.event_type || null });
  if (!evt.id) return json({ error: 'missing event id' }, 400);
  // The webhook only says "something changed". What changed is read back from PayPal, so a replayed or out-of-order message can never set a wrong state.
  const sub = await getPaypalSubscription(env, subscriptionId);
  const m = mapPaypal(evt, sub);
  if (!m) return json({ ok: true, ignored: evt.event_type });
  await applyPatch(env, m, evt.id, 'paypal', m.type || evt.event_type);
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
  // One plan: BingleSignal Briefing, monthly. It is stored as plan "lite" so existing subscribers, webhooks and database rows keep working.
  const plan = 'lite';
  const interval = 'month';
  if (body.interval && body.interval !== 'month') return json({ error: 'Only monthly billing is available.' }, 400);
  const wantsPaypal = body.provider === 'paypal';   // PayPal is always US dollars; every other request is Razorpay exactly as before
  const currency = wantsPaypal ? 'USD' : (body.currency || (req.headers.get('cf-ipcountry') === 'IN' ? 'INR' : 'USD'));
  const gstin = typeof body.gstin === 'string' ? body.gstin.trim().toUpperCase() : '';
  if (!['INR', 'USD'].includes(currency)) return json({ error: 'currency must be INR or USD' }, 400);
  if (gstin && (currency !== 'INR' || !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin))) {
    return json({ error: 'Enter a valid 15-character GSTIN for an INR purchase.' }, 400);
  }
  const razorpayPlanId = env[currency === 'USD' ? 'RAZORPAY_PLAN_LITE_MONTHLY_USD' : 'RAZORPAY_PLAN_LITE_MONTHLY'];
  const provider = wantsPaypal ? 'paypal' : 'razorpay';
  if (wantsPaypal) {
    if (!paypalConfigured(env)) return json({ error: 'PayPal is not set up yet. Please choose another option.' }, 503);
  } else if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !razorpayPlanId) {
    return json({ error: 'Razorpay plan is not configured for this currency.' }, 503);
  }

  // India / INR: $5 is converted at today's rate, GST is added, and the total (whole rupees) becomes the subscription quantity (total / 5) of the 5-rupee INR plan.
  let quote = null;
  if (currency === 'INR') {
    try {
      quote = await getInrQuote(env);
      await assertInrUnitPlan(env, razorpayPlanId);
    } catch (error) {
      if (error instanceof QuoteUnavailable) return json({ error: 'The live rupee price is unavailable right now. Please try again in a minute, or pay in US dollars.' }, 503);
      if (error instanceof PlanMisconfigured) { console.error(error.message); return json({ error: 'Rupee billing is not set up correctly yet. Please pay in US dollars or contact support.' }, 503); }
      throw error;
    }
    const expected = Number(body.expected_total_inr);
    if (Number.isFinite(expected) && expected > 0 && expected !== quote.total_inr) {
      return json({ error: 'The exchange rate just changed. Please review the new price and confirm.', code: 'rate_changed', quote }, 409);
    }
  }

  const attemptId = crypto.randomUUID();
  // ONE moment, 20 minutes ahead, used for BOTH the database reservation and Razorpay's expire_by, so the two can never disagree.
  // (Razorpay needs expire_by at least 15 minutes ahead; 20 leaves room for network delay.)
  const checkoutExpiresAtMs = Date.now() + 20 * 60 * 1000;
  const expiresAt = new Date(checkoutExpiresAtMs).toISOString();
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
    if (reservation.state === 'open' && reservation.checkout_url && (reservation.provider === 'paypal') !== wantsPaypal) {
      // A checkout with the other payment method is still open (they last 20 minutes). Never create a second one: that could bill them twice.
      return json({ error: 'You started a payment a moment ago with another payment method. Please finish it, or try again in about 20 minutes.', code: 'other_checkout_open' }, 409);
    }
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
    const subscriptionRows = await sb(env, `/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(user.id)}&select=status,trial_ends_at,provider_subscription_id`);
    if (!subscriptionRows.ok) throw new Error(`Subscription lookup failed: ${subscriptionRows.status}`);
    const subscriptions = await subscriptionRows.json();
    if (subscriptions?.[0]?.status === 'trialing' && subscriptions[0].provider_subscription_id) {
      // They already subscribed during the trial and the first charge is still to come: a second checkout would bill them twice.
      const released = await sb(env, '/rest/v1/rpc/release_payment_checkout', {
        method: 'POST', body: JSON.stringify({ p_user_id: user.id, p_attempt_id: attemptId }),
      });
      if (!released.ok) throw new Error(`Checkout reservation cleanup failed: ${released.status}`);
      return json({ error: 'You have already subscribed. Your first payment is taken when your free trial ends.' }, 409);
    }
    const trialEnd = subscriptions?.[0]?.status === 'trialing' ? Date.parse(subscriptions[0].trial_ends_at) : 0;
    // Every new sign-up gets a 7-day free trial (supabase/014_free_trial_returns.sql). Subscribing during it does NOT use the days up:
    // the first charge waits until the trial would have ended, so the days left are added to the plan (subscribe on day 3 of 7 and the
    // 4 unused days come on top of the paid month). A trial that has run out, or an account that never had one, is billed at once.
    const startAt = trialEnd - Date.now() > 15 * 60 * 1000 ? Math.floor(trialEnd / 1000) : undefined;
    if (wantsPaypal) {
      let created;
      try {
        created = await createPaypalSubscription(env, { userId: user.id, email: user.email, startAtMs: startAt ? startAt * 1000 : 0 });
      } catch (error) {
        if (!(error instanceof PaypalError)) throw error;
        // Shows in Cloudflare Logs. Only PayPal's own status and error name: never keys, emails or secrets.
        console.error('PayPal refused to create the subscription', { status_code: error.status, paypal_error: error.detail, plan_id: env.PAYPAL_PLAN_LITE_MONTHLY });
        const released = await sb(env, '/rest/v1/rpc/release_payment_checkout', {
          method: 'POST', body: JSON.stringify({ p_user_id: user.id, p_attempt_id: attemptId }),
        });
        if (!released.ok) throw new Error(`PayPal failed and checkout reservation cleanup failed: ${released.status}`);
        return json({ error: 'PayPal could not start the checkout. Please try again, or choose another option.' }, 502);
      }
      externalCheckoutCreated = true;
      const savedPaypal = await sb(env, '/rest/v1/rpc/finish_payment_checkout', {
        method: 'POST',
        body: JSON.stringify({ p_user_id: user.id, p_attempt_id: attemptId, p_provider_subscription_id: created.id, p_checkout_url: created.approveUrl }),
      });
      if (!savedPaypal.ok) throw new Error(`PayPal checkout could not be saved: ${savedPaypal.status}`);
      return json({ provider: 'paypal', subscription_id: created.id, url: created.approveUrl });
    }
    const r = await fetch('https://api.razorpay.com/v1/subscriptions', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`) },
      body: JSON.stringify({ plan_id: razorpayPlanId, total_count: interval === 'year' ? 10 : 120, quantity: quote ? quote.quantity : 1,
        customer_notify: 1, expire_by: Math.floor(checkoutExpiresAtMs / 1000),
        notes: { user_id: user.id, plan, interval, currency, ...(gstin ? { gstin } : {}),
          ...(quote ? { usd_price: String(quote.usd), fx_usd_inr: String(quote.rate), base_inr: String(quote.base_inr), gst_percent: String(quote.gst_percent), gst_inr: String(quote.gst_inr), rounding_inr: String(quote.rounding_inr), unit_inr: String(quote.unit_inr), total_inr: String(quote.total_inr) } : {}) },
        ...(startAt ? { start_at: startAt } : {}) }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Shows in Cloudflare Logs. Only Razorpay's own status, code and description: never keys, emails or secrets.
      console.error('Razorpay refused to create the subscription', {
        status_code: r.status, razorpay_code: data?.error?.code || null,
        razorpay_description: String(data?.error?.description || '').slice(0, 200) || null, currency, plan_id: razorpayPlanId,
      });
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
  if (s.provider === 'paypal') {
    // PayPal stops billing at once; the customer keeps access until the end of the period they already paid for (current_period_end is kept).
    try { await cancelPaypalSubscription(env, s.provider_subscription_id); } catch (error) {
      if (!(error instanceof PaypalError)) throw error;
      console.error('PayPal could not cancel the subscription', { status_code: error.status, paypal_error: error.detail });
      return json({ error: 'PayPal could not cancel this subscription' }, 502);
    }
    await sb(env, `/rest/v1/subscriptions?user_id=eq.${user.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ cancel_at_period_end: true, updated_at: new Date().toISOString() }) });
    return json({ ok: true, ends_at: s.current_period_end });
  }
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

// Which Razorpay plans are configured (the pricing page greys the button out when its currency is not ready).
export function razorpayRails(env) {
  const keys = !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
  const razorpay_inr = keys && !!env.RAZORPAY_PLAN_LITE_MONTHLY;
  const razorpay_usd = keys && !!env.RAZORPAY_PLAN_LITE_MONTHLY_USD;
  return { razorpay: razorpay_inr || razorpay_usd, razorpay_inr, razorpay_usd };
}

// 'live' or 'test', read from the start of the Razorpay Key ID (rzp_live_ / rzp_test_). 'unset' = missing or not recognised. The key itself is never shown.
export function razorpayMode(env) {
  const id = String(env?.RAZORPAY_KEY_ID || '');
  if (id.startsWith('rzp_live_')) return 'live';
  if (id.startsWith('rzp_test_')) return 'test';
  return 'unset';
}

// ---------- public teaser: headlines only, cached for 5 minutes ----------
// Replaces the static public/feed.json file as the homepage source, so it can never go stale or break on a Git merge.
export function teaserItems(clusters, limit = 30) {
  const items = [];
  for (const cluster of Array.isArray(clusters) ? clusters : []) {
    // Every saved story is cleaned first: junk removed, the real country worked out, one headline style (see story-quality.js).
    const stories = (Array.isArray(cluster.stories) ? cluster.stories : []).map(sanitizeStory).filter(Boolean);
    const rep = pickRepresentative(stories);
    if (!rep) continue;
    const count = cluster.source_count || 1;
    if (publisherTier(rep.s) === 4 && count < 2) continue;      // an unknown website on its own is never put on the front page
    const ms = Number(rep.d) > 1e12 ? Number(rep.d) : Number(rep.d) * 1000;
    if (!Number.isFinite(ms)) continue;
    const q = Math.max(...stories.filter((x) => !x.v).map((x) => Number(x.q) || 0));
    const trust = Math.min(1.2, Math.max(0.4, publisherTrust(rep.s) / (Number(rep.tr) || 0.75)));   // known outlets first, unknown ones sink
    const logo = isGoogleNewsUrl(rep.u) ? publisherDomain(rep.s) : hostOf(rep.u);
    items.push({
      score: q * trust,
      item: {
        id: rep.id, t: rep.t, u: rep.u, s: rep.s, d: new Date(ms).toISOString(),
        r: ['IN', 'US', 'EU'].includes(rep.g?.[0]) ? rep.g[0] : 'GL',
        k: Array.isArray(rep.k) ? rep.k.slice(0, 5) : [], c: cluster.story_id, n: count, q: Number(rep.q) || 0,
        ...(logo ? { lg: logo } : {}),
      },
    });
  }
  const best = items.sort((a, b) => b.score - a.score).map((x) => x.item);
  return dropRepeats(best).slice(0, limit);      // the same story from two clusters appears once
}

// Plain text only, at most `max` characters, cut at the end of a sentence where possible. Empty when there is nothing worth showing.
export function cleanSummary(text, max = 460) {
  const clean = String(text || '').replace(/<[^>]*>/g, ' ').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length < 40) return '';
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > max * 0.5 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
}

// One short line ("why it matters"). Shorter than a summary, so it has its own minimum length.
export function cleanWhy(text, max = 240) {
  const clean = String(text || '').replace(/<[^>]*>/g, ' ').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length < 12) return '';
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > max * 0.5 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
}

// The teaser stays a list of headlines; each one also gets its short AI summary (`y`) and its "why it matters" line (`w`) when there is one.
// The summary feeds the hover box and the free "top story" card on the homepage.
export function addTeaserSummaries(items, notes) {
  const byStory = new Map((Array.isArray(notes) ? notes : []).map((note) => [note.story_id, { y: cleanSummary(note.summary), w: cleanWhy(note.why_it_matters) }]));
  return items.map((item) => {
    const note = byStory.get(item.c);
    return note && (note.y || note.w) ? { ...item, ...(note.y ? { y: note.y } : {}), ...(note.w ? { w: note.w } : {}) } : item;
  });
}

async function handleTeaser(req, env, ctx) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(new URL('/api/teaser', req.url).toString());
  const hit = cache ? await cache.match(key) : null;
  if (hit) return hit;
  const missing = missingSupabaseConfig(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (missing.length) {
    console.error(`teaser: Worker setup problem: missing or invalid ${missing.join(', ')}`); // fix: docs/FIX-2026-11-11.md
    return json({ error: 'teaser unavailable' }, 503);
  }
  let response;
  try {
    response = await sb(env, `/rest/v1/story_clusters?select=story_id,stories,source_count,published_at&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&order=published_at.desc&limit=400`);
  } catch (error) {
    console.error('teaser: could not reach Supabase:', error?.message || error);
    return json({ error: 'teaser unavailable' }, 503);
  }
  if (!response.ok) return json({ error: 'teaser unavailable' }, 503);
  let items = teaserItems(await response.json());
  if (!items.length) return json({ error: 'teaser unavailable' }, 503);
  try { // one small extra lookup for the hover summaries; if it fails, the teaser is simply headlines, as before
    const notes = await sb(env, `/rest/v1/story_notes?select=story_id,summary,why_it_matters&story_id=in.(${items.map((item) => encodeURIComponent(item.c)).join(',')})`);
    if (notes.ok) items = addTeaserSummaries(items, await notes.json());
  } catch (error) {
    console.error('teaser: summaries unavailable:', error?.message || error);
  }
  const out = new Response(JSON.stringify({ v: 5, gen: new Date().toISOString(), n: items.length, items }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300, stale-while-revalidate=600' },
  });
  if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}

export default {
  async email(message, env) {
    await handleForwardEmail(message, env);
  },
  async fetch(req, env, ctx) {
    const p = new URL(req.url).pathname;
    try {
      // The homepage goes through here only to get its headlines written into the HTML. Any problem returns the plain page.
      if (p === '/' && env.ASSETS) {
        return await handleHome(req, env, async () => {
          const res = await handleTeaser(req, env, ctx);
          return res.ok ? (await res.json()).items : null;
        });
      }
      if (p === '/api/health') {
        const missing = missingSupabaseConfig(env);
        return json({ ok: true, time: new Date().toISOString(), country: req.headers.get('cf-ipcountry') || null,
          rails: { ...razorpayRails(env), paypal: paypalConfigured(env) },
          paypal_mode: paypalMode(env),
          // Launch-day check: razorpay_mode must say "live", and gst_percent must be 0 if you have no GSTIN. Shows no key and no secret.
          razorpay_mode: razorpayMode(env), gst_percent: gstPercent(env),
          // true = this Worker can see the setting. Names only, never values. All three must be true for READ/WATCH to work.
          supabase: { url: !missing.includes('SUPABASE_URL'), anon_key: !missing.includes('SUPABASE_ANON_KEY'), service_key: !missing.includes('SUPABASE_SERVICE_ROLE_KEY') } });
      }
      if (p === '/api/teaser' && req.method === 'GET') return await handleTeaser(req, env, ctx);
      if (p === '/api/markets' && req.method === 'GET') return await handleMarkets(req, env, ctx);
      if (p === '/api/logo' && req.method === 'GET') return await handleLogo(req, env, ctx);
      if (['/api/telegram/webhook', '/api/telegram/link-code', '/api/unsubscribe'].includes(p)) {
        return await handleDeliveryRequest(req, env);
      }
      if (['/api/pool', '/api/edition/latest', '/api/edition/event', '/api/metrics',
        '/api/feedback', '/api/profile', '/api/watchlist'].includes(p)) {
        return await handleBriefingRequest(req, env);
      }
      if (p === '/api/privacy/delete-email-data') return await handleDeleteEmailData(req, env);
      if (p.startsWith('/api/email/')) return await handleEmailRequest(req, env);
      if (p === '/api/quote' && req.method === 'GET') return await handleQuote(req, env);
      if (req.method !== 'POST') return await notFound(req, env);
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
      if (p === '/api/webhooks/paypal') return await handlePaypal(req, env);
      if (p === '/api/webhooks/global') return await handleGlobal(req, env);
      return await notFound(req, env);
    } catch (e) {
      console.error(`Unhandled error on ${p}: ${e?.message || e}`, e);
      return json({ error: 'server error' }, 500);   // provider will retry
    }
  },
  scheduled(controller, env, ctx) {
    const jobs = [handleEmailSchedule(controller.cron, env)];
    if (controller.cron === '*/15 * * * *') jobs.push(handleEditionSchedule(env), handleLifecycleSchedule(env));
    ctx.waitUntil(Promise.all(jobs));
  },
};
