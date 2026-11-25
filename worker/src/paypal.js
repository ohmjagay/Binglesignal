// PayPal Subscriptions for BingleSignal: $5 a month in US dollars. Razorpay is untouched and stays the second option.
//
// How it works (the same shape as the Razorpay flow):
//   1. POST /api/checkout {provider:'paypal'}  -> we create a PayPal subscription for the logged-in user and return PayPal's approval URL.
//   2. The browser goes to PayPal, the customer approves, PayPal sends them back to /pricing?paypal=return.
//   3. PayPal calls POST /api/webhooks/paypal. We check the call is really from PayPal, then READ the subscription back from PayPal
//      (so we never trust the webhook body for status or dates) and update the same `subscriptions` row Razorpay uses.
//
// Secrets (Cloudflare -> Settings -> Variables and Secrets): PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID, PAYPAL_PLAN_LITE_MONTHLY.
// Optional: PAYPAL_ENV = sandbox (for testing; anything else means live), SITE_URL (defaults to https://binglesignal.com).

const LIVE = 'https://api-m.paypal.com';
const SANDBOX = 'https://api-m.sandbox.paypal.com';

export const paypalBase = (env = {}) => (String(env.PAYPAL_ENV || '').toLowerCase() === 'sandbox' ? SANDBOX : LIVE);
export const paypalMode = (env = {}) => (!env.PAYPAL_CLIENT_ID ? 'unset' : String(env.PAYPAL_ENV || '').toLowerCase() === 'sandbox' ? 'sandbox' : 'live');
export const paypalConfigured = (env = {}) => !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET && env.PAYPAL_PLAN_LITE_MONTHLY);
const siteUrl = (env = {}) => String(env.SITE_URL || 'https://binglesignal.com').replace(/\/+$/, '');

export class PaypalError extends Error {
  constructor(message, status = 502, detail = null) { super(message); this.name = 'PaypalError'; this.status = status; this.detail = detail; }
}

// OAuth token, kept for the life of the Worker instance (PayPal tokens last about 9 hours; we refresh 5 minutes early).
let tokenCache = { key: '', value: '', until: 0 };
async function accessToken(env) {
  const key = `${paypalBase(env)}|${env.PAYPAL_CLIENT_ID}`;
  if (tokenCache.key === key && tokenCache.until > Date.now() + 300000) return tokenCache.value;
  const r = await fetch(`${paypalBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: 'Basic ' + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`), 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) throw new PaypalError('PayPal sign-in failed', r.status || 502, data?.error || null);
  tokenCache = { key, value: data.access_token, until: Date.now() + Number(data.expires_in || 3000) * 1000 };
  return tokenCache.value;
}

async function paypalFetch(env, path, init = {}) {
  const token = await accessToken(env);
  const r = await fetch(`${paypalBase(env)}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const text = await r.text();
  let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { /* PayPal answered with something that is not JSON */ }
  return { ok: r.ok, status: r.status, data };
}

// Creates the subscription and returns where to send the customer. `startAtMs` (optional) is the day the free trial ends:
// PayPal then takes the first payment on that day, exactly like start_at does for Razorpay.
export async function createPaypalSubscription(env, { userId, email, startAtMs = 0 }) {
  const site = siteUrl(env);
  const body = {
    plan_id: env.PAYPAL_PLAN_LITE_MONTHLY,
    custom_id: userId,
    ...(startAtMs ? { start_time: new Date(startAtMs).toISOString().replace(/\.\d{3}Z$/, 'Z') } : {}),
    ...(email ? { subscriber: { email_address: email } } : {}),
    application_context: {
      brand_name: 'BingleSignal',
      locale: 'en-US',
      shipping_preference: 'NO_SHIPPING',
      user_action: 'SUBSCRIBE_NOW',
      payment_method: { payer_selected: 'PAYPAL', payee_preferred: 'IMMEDIATE_PAYMENT_REQUIRED' },
      return_url: `${site}/pricing?paypal=return`,
      cancel_url: `${site}/pricing?paypal=cancel`,
    },
  };
  const r = await paypalFetch(env, '/v1/billing/subscriptions', {
    method: 'POST',
    headers: { 'PayPal-Request-Id': `bs-${userId}-${startAtMs || 'now'}-${Math.floor(Date.now() / 60000)}`, prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  const approve = (r.data?.links || []).find((l) => l.rel === 'approve')?.href;
  if (!r.ok || !r.data?.id || !approve) {
    throw new PaypalError(r.data?.message || 'PayPal refused to create the subscription', r.status, { name: r.data?.name || null, details: (r.data?.details || []).map((d) => d.issue || d.description).slice(0, 3) });
  }
  return { id: r.data.id, approveUrl: approve };
}

export async function getPaypalSubscription(env, id) {
  const r = await paypalFetch(env, `/v1/billing/subscriptions/${encodeURIComponent(id)}`);
  if (!r.ok) throw new PaypalError(`PayPal could not read the subscription (${r.status})`, r.status, r.data?.name || null);
  return r.data;
}

export async function cancelPaypalSubscription(env, id, reason = 'Cancelled by the customer on binglesignal.com') {
  const r = await paypalFetch(env, `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
  // 204 = cancelled. 422 = it was already cancelled, which is the state we wanted anyway.
  if (!r.ok && !(r.status === 422 && /SUBSCRIPTION_STATUS_INVALID/.test(r.data?.name || r.data?.details?.[0]?.issue || ''))) {
    throw new PaypalError(r.data?.message || 'PayPal could not cancel the subscription', r.status, r.data?.name || null);
  }
  return true;
}

// Asks PayPal itself whether this webhook is genuine. The raw text is placed into the request untouched,
// because re-writing the JSON could change a character and make PayPal's check fail.
export async function verifyPaypalWebhook(env, headers, raw) {
  if (!env.PAYPAL_WEBHOOK_ID) return false;
  const h = (n) => headers.get(n);
  const parts = { auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time') };
  if (Object.values(parts).some((v) => !v)) return false;
  // Only ever fetch PayPal's certificate from PayPal.
  try { if (!/(^|\.)paypal\.com$/.test(new URL(parts.cert_url).hostname)) return false; } catch { return false; }
  const body = `{${Object.entries(parts).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',')},"webhook_id":${JSON.stringify(env.PAYPAL_WEBHOOK_ID)},"webhook_event":${raw}}`;
  const r = await paypalFetch(env, '/v1/notifications/verify-webhook-signature', { method: 'POST', body });
  return r.ok && r.data?.verification_status === 'SUCCESS';
}

// ---------- PayPal events -> the same subscription fields Razorpay writes ----------
const SUB_EVENTS = new Set(['BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.RE-ACTIVATED', 'BILLING.SUBSCRIPTION.UPDATED',
  'BILLING.SUBSCRIPTION.SUSPENDED', 'BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.EXPIRED', 'BILLING.SUBSCRIPTION.PAYMENT.FAILED']);
const SALE_EVENTS = new Set(['PAYMENT.SALE.COMPLETED', 'PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED']);

// Which PayPal subscription does this event belong to? (null = an event we do not act on)
export function paypalSubscriptionId(evt) {
  const r = evt?.resource || {};
  if (SUB_EVENTS.has(evt?.event_type)) return r.id || r.subscription_id || r.billing_agreement_id || null;
  if (SALE_EVENTS.has(evt?.event_type)) return r.billing_agreement_id || null;
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `sub` is the subscription as PayPal reports it right now (GET /v1/billing/subscriptions/{id}); that, not the webhook body, decides the status.
export function mapPaypal(evt, sub, now = new Date()) {
  if (!sub || !paypalSubscriptionId(evt)) return null;
  const userId = String(sub.custom_id || '');
  if (!UUID.test(userId)) return null;
  const info = sub.billing_info || {};
  const type = evt.event_type;
  // The end of the paid period is PayPal's next billing time. A time that is not in the future is stale (PayPal had not moved it on yet): never use it,
  // or a customer who just paid could lose access. For a payment event we then fall back to 31 days; the next genuine event corrects it.
  const nextMs = Date.parse(info.next_billing_time || '');
  let endMs = Number.isFinite(nextMs) && nextMs > now.getTime() ? nextMs : 0;
  if (!endMs && type === 'PAYMENT.SALE.COMPLETED') endMs = now.getTime() + 31 * 86400000;
  const next = endMs ? { current_period_end: new Date(endMs).toISOString() } : {};
  const paid = type === 'PAYMENT.SALE.COMPLETED' || !!(info.last_payment?.time || Number(info.cycle_executions?.find((c) => c.tenure_type === 'REGULAR')?.cycles_completed) > 0);
  const base = {
    provider: 'paypal', currency: 'USD', plan: 'lite', billing_interval: 'month',
    provider_subscription_id: sub.id,
    ...(sub.subscriber?.payer_id ? { provider_customer_id: sub.subscriber.payer_id } : {}),
    last_event_at: now.toISOString(),
  };
  const who = { user_id: userId };
  if (type === 'PAYMENT.SALE.REFUNDED' || type === 'PAYMENT.SALE.REVERSED') return { who, patch: { ...base, status: 'expired' } };
  // A failed payment is shown as "payment problem" and starts the same reminder emails Razorpay failures do.
  if (type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') return { who, type: 'payment.failed', patch: { ...base, ...next, status: 'past_due' } };
  switch (String(sub.status || '').toUpperCase()) {
    case 'ACTIVE':
      // Approved but nothing charged yet (free trial still running): remember the subscription, keep the trial, like Razorpay's "authenticated".
      if (!paid) return { who, patch: base };
      return { who, patch: { ...base, ...next, status: 'active', cancel_at_period_end: false } };
    case 'SUSPENDED': return { who, type: 'payment.failed', patch: { ...base, ...next, status: 'past_due' } };
    case 'CANCELLED': return { who, patch: { ...base, status: 'canceled' } };
    case 'EXPIRED': return { who, patch: { ...base, status: 'expired' } };
    default: return null;   // APPROVAL_PENDING / APPROVED: nothing to do yet
  }
}
