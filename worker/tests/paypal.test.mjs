import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../src/index.js';
import { mapPaypal, paypalSubscriptionId, verifyPaypalWebhook, paypalConfigured } from '../src/paypal.js';

const USER = { id: 'aaaaaaaa-0000-0000-0000-000000000001', email: 'ria@example.com' };
const base = {
  SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service',
  RAZORPAY_KEY_ID: 'rzp_test_1', RAZORPAY_KEY_SECRET: 'secret', RAZORPAY_PLAN_LITE_MONTHLY: 'plan_lite_m', RAZORPAY_PLAN_LITE_MONTHLY_USD: 'plan_lite_usd_m',
  API_RATE_LIMITS: { idFromName: (n) => n, get: () => ({ fetch: async () => Response.json({ allowed: true }) }) },
};
const env = { ...base, PAYPAL_CLIENT_ID: 'AaClient', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'WH-ID-1', PAYPAL_PLAN_LITE_MONTHLY: 'P-LITE-USD' };
const parse = (s) => { try { return JSON.parse(s); } catch { return s; } };
function fakeNetwork(routes = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, init, body: init.body ? parse(init.body) : undefined });
    for (const [needle, reply] of Object.entries(routes)) if (url.includes(needle)) return reply();
    return new Response('[]', { status: 200 });
  };
  return calls;
}
const post = (path, body, headers = {}) => new Request('https://binglesignal.com' + path, {
  method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.1', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const token = () => Response.json({ access_token: 'tok', expires_in: 32000 });
const checkoutRoutes = (extra = {}) => ({
  '/auth/v1/user': () => Response.json(USER),
  '/rpc/reserve_payment_checkout': () => Response.json({ state: 'reserved' }),
  '/rpc/finish_payment_checkout': () => Response.json(true),
  'select=status,trial_ends_at': () => Response.json([]),
  '/v1/oauth2/token': token,
  '/v1/billing/subscriptions': () => Response.json({ id: 'I-SUB1', status: 'APPROVAL_PENDING', links: [{ rel: 'approve', href: 'https://www.paypal.com/webapps/billing/subscriptions?ba_token=BA-1' }] }),
  ...extra,
});
const headers = { authorization: 'Bearer jwt', 'cf-ipcountry': 'DE' };

test('PayPal checkout creates a $5 subscription for the logged-in user and returns the PayPal approval page', async () => {
  const calls = fakeNetwork(checkoutRoutes());
  const res = await worker.fetch(post('/api/checkout', { interval: 'month', currency: 'USD', provider: 'paypal' }, headers), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { provider: 'paypal', subscription_id: 'I-SUB1', url: 'https://www.paypal.com/webapps/billing/subscriptions?ba_token=BA-1' });
  const created = calls.find((c) => c.url.endsWith('/v1/billing/subscriptions'));
  assert.equal(created.url.startsWith('https://api-m.paypal.com/'), true, 'live PayPal unless PAYPAL_ENV=sandbox');
  assert.equal(created.body.plan_id, 'P-LITE-USD');
  assert.equal(created.body.custom_id, USER.id, 'the user is tied to the subscription so the webhook knows whose it is');
  assert.equal(created.body.start_time, undefined, 'no trial: PayPal bills straight away');
  assert.equal(created.body.application_context.return_url, 'https://binglesignal.com/pricing?paypal=return');
  assert.equal(created.body.application_context.cancel_url, 'https://binglesignal.com/pricing?paypal=cancel');
  const reserved = calls.find((c) => c.url.includes('/rpc/reserve_payment_checkout')).body;
  assert.equal(reserved.p_provider, 'paypal');
  assert.equal(reserved.p_currency, 'USD');
  const saved = calls.find((c) => c.url.includes('/rpc/finish_payment_checkout')).body;
  assert.equal(saved.p_provider_subscription_id, 'I-SUB1');
  assert.equal(calls.some((c) => c.url.includes('api.razorpay.com')), false, 'Razorpay is not called for a PayPal checkout');
});

test('PayPal ignores a rupee request from the browser: it is always dollars', async () => {
  const calls = fakeNetwork(checkoutRoutes());
  const res = await worker.fetch(post('/api/checkout', { interval: 'month', currency: 'INR', provider: 'paypal' }, { authorization: 'Bearer jwt', 'cf-ipcountry': 'IN' }), env);
  assert.equal(res.status, 200);
  assert.equal(calls.find((c) => c.url.includes('/rpc/reserve_payment_checkout')).body.p_currency, 'USD');
  assert.equal(calls.some((c) => c.url.includes('frankfurter')), false);
});

test('A customer still in the free trial is billed by PayPal on the day the trial ends', async () => {
  const trialEnd = new Date(Date.now() + 4 * 86400000).toISOString();
  const calls = fakeNetwork(checkoutRoutes({ 'select=status,trial_ends_at': () => Response.json([{ status: 'trialing', trial_ends_at: trialEnd, provider_subscription_id: null }]) }));
  const res = await worker.fetch(post('/api/checkout', { interval: 'month', currency: 'USD', provider: 'paypal' }, headers), env);
  assert.equal(res.status, 200);
  const created = calls.find((c) => c.url.endsWith('/v1/billing/subscriptions'));
  assert.equal(Date.parse(created.body.start_time), Math.floor(Date.parse(trialEnd) / 1000) * 1000);
});

test('PayPal checkout says so plainly when PayPal is not configured, and Razorpay checkout still works', async () => {
  fakeNetwork(checkoutRoutes());
  const off = await worker.fetch(post('/api/checkout', { interval: 'month', currency: 'USD', provider: 'paypal' }, headers), base);
  assert.equal(off.status, 503);
  const calls = fakeNetwork(checkoutRoutes({ 'api.razorpay.com': () => Response.json({ id: 'sub_x', short_url: 'https://rzp.io/i/x' }) }));
  const razorpay = await worker.fetch(post('/api/checkout', { interval: 'month', currency: 'USD' }, headers), env);
  assert.equal(razorpay.status, 200);
  assert.equal((await razorpay.json()).provider, 'razorpay', 'no provider field = Razorpay, exactly as before');
  assert.equal(calls.some((c) => c.url.includes('paypal.com')), false);
});

test('If PayPal refuses, the checkout reservation is released and the customer gets a calm message', async () => {
  const calls = fakeNetwork(checkoutRoutes({ '/v1/billing/subscriptions': () => Response.json({ name: 'INVALID_REQUEST', message: 'x' }, { status: 422 }), '/rpc/release_payment_checkout': () => new Response(null, { status: 204 }) }));
  const res = await worker.fetch(post('/api/checkout', { interval: 'month', currency: 'USD', provider: 'paypal' }, headers), env);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /PayPal could not start the checkout/);
  assert.equal(calls.some((c) => c.url.includes('/rpc/release_payment_checkout')), true);
});

test('A still-open checkout with the other payment method is never doubled up', async () => {
  fakeNetwork(checkoutRoutes({ '/rpc/reserve_payment_checkout': () => Response.json({ state: 'open', provider: 'razorpay', checkout_url: 'https://rzp.io/i/1', provider_subscription_id: 'sub_1' }) }));
  const res = await worker.fetch(post('/api/checkout', { interval: 'month', currency: 'USD', provider: 'paypal' }, headers), env);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'other_checkout_open');
  fakeNetwork(checkoutRoutes({ '/rpc/reserve_payment_checkout': () => Response.json({ state: 'open', provider: 'paypal', checkout_url: 'https://www.paypal.com/x', provider_subscription_id: 'I-1' }) }));
  const again = await worker.fetch(post('/api/checkout', { interval: 'month', currency: 'USD', provider: 'paypal' }, headers), env);
  assert.deepEqual(await again.json(), { provider: 'paypal', url: 'https://www.paypal.com/x', existing: true });
});

// ---------- webhook ----------
const hookHeaders = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.paypal.com/v1/notifications/certs/CERT-1', 'paypal-transmission-id': 'T-1',
  'paypal-transmission-sig': 'sig', 'paypal-transmission-time': '2026-11-23T10:00:00Z' };
const sale = { id: 'WH-1', event_type: 'PAYMENT.SALE.COMPLETED', resource: { billing_agreement_id: 'I-SUB1', id: 'SALE-1' } };
const activeSub = (extra = {}) => ({ id: 'I-SUB1', status: 'ACTIVE', custom_id: USER.id, subscriber: { payer_id: 'PAYER1' },
  billing_info: { last_payment: { time: '2026-11-23T10:00:00Z' }, next_billing_time: new Date(Date.now() + 30 * 86400000).toISOString() }, ...extra });
const hookRoutes = (sub, extra = {}) => ({
  '/v1/oauth2/token': token,
  '/verify-webhook-signature': () => Response.json({ verification_status: 'SUCCESS' }),
  '/v1/billing/subscriptions/I-SUB1': () => Response.json(sub),
  '/rpc/apply_payment_webhook': () => Response.json(true),
  ...extra,
});

test('A genuine PayPal payment webhook switches the plan on, using what PayPal itself reports', async () => {
  const calls = fakeNetwork(hookRoutes(activeSub()));
  const raw = JSON.stringify(sale);
  const res = await worker.fetch(post('/api/webhooks/paypal', raw, hookHeaders), env);
  assert.equal(res.status, 200);
  const verify = calls.find((c) => c.url.includes('/verify-webhook-signature'));
  assert.equal(verify.body.webhook_id, 'WH-ID-1');
  assert.deepEqual(verify.body.webhook_event, sale, 'the event is passed on untouched');
  assert.match(verify.init.body, /"webhook_event":\{"id":"WH-1"/);
  const applied = calls.find((c) => c.url.includes('/rpc/apply_payment_webhook')).body;
  assert.equal(applied.p_event_key, 'paypal:WH-1');
  assert.equal(applied.p_provider, 'paypal');
  assert.equal(applied.p_user_id, USER.id);
  assert.equal(applied.p_patch.status, 'active');
  assert.equal(applied.p_patch.provider_subscription_id, 'I-SUB1');
  assert.equal(applied.p_patch.currency, 'USD');
  assert.ok(Date.parse(applied.p_patch.current_period_end) > Date.now());
});

test('A forged PayPal webhook is refused and changes nothing', async () => {
  const calls = fakeNetwork(hookRoutes(activeSub(), { '/verify-webhook-signature': () => Response.json({ verification_status: 'FAILURE' }) }));
  const res = await worker.fetch(post('/api/webhooks/paypal', JSON.stringify(sale), hookHeaders), env);
  assert.equal(res.status, 401);
  assert.equal(calls.some((c) => c.url.includes('/rpc/apply_payment_webhook')), false);
  const missing = await worker.fetch(post('/api/webhooks/paypal', JSON.stringify(sale), {}), env);
  assert.equal(missing.status, 401);
  const evil = await worker.fetch(post('/api/webhooks/paypal', JSON.stringify(sale), { ...hookHeaders, 'paypal-cert-url': 'https://evil.example.com/cert' }), env);
  assert.equal(evil.status, 401);
});

test('PayPal events we do not act on are acknowledged, not retried', async () => {
  const calls = fakeNetwork(hookRoutes(activeSub()));
  const res = await worker.fetch(post('/api/webhooks/paypal', JSON.stringify({ id: 'WH-2', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { id: 'D-1' } }), hookHeaders), env);
  assert.equal(res.status, 200);
  assert.equal(calls.some((c) => c.url.includes('/rpc/apply_payment_webhook')), false);
});

test('mapPaypal: trial approved, paid, failed, cancelled and refunded', () => {
  const sub = (status, bi = {}) => ({ id: 'I-1', status, custom_id: USER.id, billing_info: bi });
  const future = new Date(Date.now() + 5 * 86400000).toISOString();
  const trial = mapPaypal({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-1' } }, sub('ACTIVE', { next_billing_time: future }));
  assert.equal(trial.patch.status, undefined, 'approved but nothing charged yet: the trial stays a trial');
  assert.equal(trial.patch.provider_subscription_id, 'I-1');
  const paid = mapPaypal({ event_type: 'PAYMENT.SALE.COMPLETED', resource: { billing_agreement_id: 'I-1' } }, sub('ACTIVE', { next_billing_time: future }));
  assert.equal(paid.patch.status, 'active');
  assert.equal(paid.patch.cancel_at_period_end, false);
  assert.equal(paid.patch.current_period_end, future);
  const stale = mapPaypal({ event_type: 'PAYMENT.SALE.COMPLETED', resource: { billing_agreement_id: 'I-1' } }, sub('ACTIVE', { next_billing_time: '2020-01-01T00:00:00Z' }));
  assert.ok(Date.parse(stale.patch.current_period_end) > Date.now() + 30 * 86400000, 'a stale next-billing time can never cut a paying customer off');
  const failed = mapPaypal({ event_type: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED', resource: { id: 'I-1' } }, sub('ACTIVE', { last_payment: { time: 'x' } }));
  assert.equal(failed.patch.status, 'past_due');
  assert.equal(failed.type, 'payment.failed', 'starts the same reminder emails Razorpay failures start');
  const cancelled = mapPaypal({ event_type: 'BILLING.SUBSCRIPTION.CANCELLED', resource: { id: 'I-1' } }, sub('CANCELLED'));
  assert.equal(cancelled.patch.status, 'canceled');
  assert.equal(cancelled.patch.current_period_end, undefined, 'the paid-until date already stored is kept');
  assert.equal(mapPaypal({ event_type: 'PAYMENT.SALE.REFUNDED', resource: { billing_agreement_id: 'I-1' } }, sub('ACTIVE')).patch.status, 'expired');
  assert.equal(mapPaypal({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-1' } }, sub('APPROVAL_PENDING')), null);
  assert.equal(mapPaypal({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-1' } }, { id: 'I-1', status: 'ACTIVE', custom_id: 'not-a-uuid' }), null);
  assert.equal(paypalSubscriptionId({ event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { id: 'D' } }), null);
  assert.equal(paypalConfigured(env), true);
  assert.equal(paypalConfigured(base), false);
});

test('verifyPaypalWebhook needs every PayPal header and the webhook ID', async () => {
  fakeNetwork(hookRoutes(activeSub()));
  const h = (o) => new Headers(o);
  assert.equal(await verifyPaypalWebhook(env, h(hookHeaders), '{"id":"x"}'), true);
  assert.equal(await verifyPaypalWebhook({ ...env, PAYPAL_WEBHOOK_ID: '' }, h(hookHeaders), '{"id":"x"}'), false);
  assert.equal(await verifyPaypalWebhook(env, h({ ...hookHeaders, 'paypal-transmission-sig': '' }), '{"id":"x"}'), false);
});

// ---------- cancel ----------
test('Cancelling a PayPal subscription stops PayPal billing and keeps access until the paid period ends', async () => {
  const calls = fakeNetwork({
    '/auth/v1/user': () => Response.json(USER),
    'select=provider,provider_subscription_id': () => Response.json([{ provider: 'paypal', provider_subscription_id: 'I-SUB1', status: 'active', current_period_end: '2026-12-23T00:00:00Z' }]),
    '/v1/oauth2/token': token,
    '/cancel': () => new Response(null, { status: 204 }),
  });
  const res = await worker.fetch(post('/api/cancel', {}, { authorization: 'Bearer jwt' }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, ends_at: '2026-12-23T00:00:00Z' });
  assert.equal(calls.some((c) => c.url.endsWith('/v1/billing/subscriptions/I-SUB1/cancel')), true);
  assert.equal(calls.some((c) => c.url.includes('api.razorpay.com')), false);
  assert.equal(calls.find((c) => c.init.method === 'PATCH').body.cancel_at_period_end, true);
});

// ---------- health, pages, database ----------
test('/api/health tells the pricing page whether PayPal is ready', async () => {
  fakeNetwork();
  const on = await (await worker.fetch(new Request('https://binglesignal.com/api/health'), env)).json();
  assert.equal(on.rails.paypal, true);
  assert.equal(on.paypal_mode, 'live');
  const off = await (await worker.fetch(new Request('https://binglesignal.com/api/health'), base)).json();
  assert.equal(off.rails.paypal, false);
  assert.equal(off.rails.razorpay, true, 'Razorpay rails are reported exactly as before');
  assert.equal((await (await worker.fetch(new Request('https://binglesignal.com/api/health'), { ...env, PAYPAL_ENV: 'sandbox' })).json()).paypal_mode, 'sandbox');
});

test('Migration 015 lets the database store PayPal subscriptions', async () => {
  const sql = await readFile(new URL('../../supabase/015_paypal.sql', import.meta.url), 'utf8');
  assert.match(sql, /subscriptions_provider_check check \(provider in \('razorpay', 'global', 'manual', 'paypal'\)\)/);
  assert.match(sql, /payment_checkout_sessions_provider_check check \(provider in \('razorpay', 'global', 'paypal'\)\)/);
});
