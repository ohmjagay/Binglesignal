import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker, { verifyRazorpay, verifyStandardWebhook, mapRazorpay, mapGlobal } from '../src/index.js';
import { betaTestReport, handleEmailRequest, isValidBetaSchedule } from '../src/email-beta.js';

const env = {
  SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service',
  RAZORPAY_KEY_ID: 'rzp_test_1', RAZORPAY_KEY_SECRET: 'secret', RAZORPAY_WEBHOOK_SECRET: 'hooksecret',
  RAZORPAY_PLAN_PRO_MONTHLY: 'plan_pro_m', RAZORPAY_PLAN_LITE_MONTHLY: 'plan_lite_m',
  GLOBAL_WEBHOOK_SECRET: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', GLOBAL_LINK_PRO_MONTH: 'https://pay.example.com/pro',
};
const USER = { id: 'aaaaaaaa-0000-0000-0000-000000000001', email: 'Ria@Example.com' };
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
const post = (path, body, headers = {}) =>
  new Request('https://binglesignal.com' + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const rzpSig = (raw) => createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
const rzpEvent = (event, extra = {}) => ({ event, created_at: 1793000000, payload: { subscription: { entity: {
  id: 'sub_123', customer_id: 'cust_1', current_end: 1795600000, notes: { user_id: USER.id, plan: 'pro' }, ...extra } } } });

test('Standard Webhooks: the official test vector verifies, tampering and old messages fail', async () => {
  const h = new Headers({ 'webhook-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek', 'webhook-timestamp': '1614265330',
    'webhook-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=' });
  const now = 1614265330 * 1000;
  assert.equal(await verifyStandardWebhook('{"test": 2432232314}', h, env.GLOBAL_WEBHOOK_SECRET, now), true);
  assert.equal(await verifyStandardWebhook('{"test": 2432232315}', h, env.GLOBAL_WEBHOOK_SECRET, now), false);
  assert.equal(await verifyStandardWebhook('{"test": 2432232314}', h, env.GLOBAL_WEBHOOK_SECRET, now + 3600e3), false);
});

test('Razorpay signature: good passes, bad fails', async () => {
  assert.equal(await verifyRazorpay('{"a":1}', rzpSig('{"a":1}'), env.RAZORPAY_WEBHOOK_SECRET), true);
  assert.equal(await verifyRazorpay('{"a":2}', rzpSig('{"a":1}'), env.RAZORPAY_WEBHOOK_SECRET), false);
});

test('Razorpay webhook: a successful charge activates the plan and sets the period end', async () => {
  const calls = fakeNetwork();
  const raw = JSON.stringify(rzpEvent('subscription.charged'));
  const res = await worker.fetch(post('/api/webhooks/razorpay', raw, { 'x-razorpay-signature': rzpSig(raw), 'x-razorpay-event-id': 'evt_1' }), env);
  assert.equal(res.status, 200);
  const patch = calls.find((c) => c.init.method === 'PATCH');
  assert.match(patch.url, /subscriptions\?user_id=eq\.aaaaaaaa/);
  assert.match(decodeURIComponent(patch.url), /last_event_at\.is\.null/);   // stale-event guard present
  assert.equal(patch.body.status, 'active');
  assert.equal(patch.body.plan, 'pro');
  assert.equal(patch.body.current_period_end, new Date(1795600000 * 1000).toISOString());
  assert.ok(calls.some((c) => c.url.includes('/webhook_events')), 'event id recorded');
});

test('Razorpay webhook: wrong signature is rejected and nothing is written', async () => {
  const calls = fakeNetwork();
  const raw = JSON.stringify(rzpEvent('subscription.charged'));
  const res = await worker.fetch(post('/api/webhooks/razorpay', raw, { 'x-razorpay-signature': 'nope' }), env);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('Razorpay mapping: pending -> past_due, halted -> expired, cancelled -> canceled, unknown -> ignored', () => {
  assert.equal(mapRazorpay(rzpEvent('subscription.pending')).patch.status, 'past_due');
  assert.equal(mapRazorpay(rzpEvent('subscription.halted')).patch.status, 'expired');
  assert.equal(mapRazorpay(rzpEvent('subscription.cancelled')).patch.status, 'canceled');
  assert.equal(mapRazorpay(rzpEvent('subscription.authenticated')).patch.status, undefined);
  assert.equal(mapRazorpay(rzpEvent('payment.captured')), null);
});

test('Checkout without login -> 401', async () => {
  fakeNetwork();
  assert.equal((await worker.fetch(post('/api/checkout', { plan: 'pro' }), env)).status, 401);
});

test('Checkout (India): Razorpay subscription is created and the unused trial is preserved via start_at', async () => {
  const trialEnd = Date.now() + 3 * 86400e3;
  const calls = fakeNetwork({
    '/auth/v1/user': () => Response.json(USER),
    'select=status,trial_ends_at': () => Response.json([{ status: 'trialing', trial_ends_at: new Date(trialEnd).toISOString() }]),
    'api.razorpay.com': () => Response.json({ id: 'sub_new', short_url: 'https://rzp.io/i/abc' }),
  });
  const res = await worker.fetch(post('/api/checkout', { plan: 'pro' }, { authorization: 'Bearer jwt', 'cf-ipcountry': 'IN' }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { provider: 'razorpay', key_id: 'rzp_test_1', subscription_id: 'sub_new', short_url: 'https://rzp.io/i/abc' });
  const rz = calls.find((c) => c.url.includes('api.razorpay.com'));
  assert.equal(rz.body.plan_id, 'plan_pro_m');
  assert.equal(rz.body.notes.user_id, USER.id);
  assert.equal(rz.body.start_at, Math.floor(trialEnd / 1000));
  assert.equal(rz.init.headers.authorization, 'Basic ' + btoa('rzp_test_1:secret'));
});

test('Checkout (outside India): returns the hosted payment link carrying email + user id', async () => {
  fakeNetwork({ '/auth/v1/user': () => Response.json(USER) });
  const res = await worker.fetch(post('/api/checkout', { plan: 'pro' }, { authorization: 'Bearer jwt', 'cf-ipcountry': 'DE' }), env);
  const out = await res.json();
  assert.equal(out.provider, 'global');
  assert.match(out.url, /^https:\/\/pay\.example\.com\/pro\?email=Ria%40Example\.com&metadata_user_id=aaaaaaaa-0000/);
});

test('Global webhook: signed subscription.active activates the user named in metadata', async () => {
  const calls = fakeNetwork();
  const raw = JSON.stringify({ type: 'subscription.active', timestamp: '2026-11-02T10:00:00Z',
    data: { subscription_id: 'sub_g1', next_billing_date: '2026-12-02T10:00:00Z', metadata: { user_id: USER.id, plan: 'lite' }, customer: { email: USER.email } } });
  const id = 'msg_1', ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', Buffer.from(env.GLOBAL_WEBHOOK_SECRET.slice(6), 'base64')).update(`${id}.${ts}.${raw}`).digest('base64');
  const res = await worker.fetch(post('/api/webhooks/global', raw, { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': 'v1,' + sig }), env);
  assert.equal(res.status, 200);
  const patch = calls.find((c) => c.init.method === 'PATCH');
  assert.equal(patch.body.status, 'active');
  assert.equal(patch.body.plan, 'lite');
  assert.equal(patch.body.currency, 'USD');
});

test('Global mapping: on_hold -> past_due, unknown -> ignored, email fallback when no user id', () => {
  const ev = (type) => ({ type, data: { customer: { email: 'x@y.com' } } });
  assert.equal(mapGlobal(ev('subscription.on_hold')).patch.status, 'past_due');
  assert.deepEqual(mapGlobal(ev('subscription.on_hold')).who, { email: 'x@y.com' });
  assert.equal(mapGlobal(ev('payment.succeeded')), null);
});

test('Health endpoint reports the visitor country (pricing page uses it to show INR or USD)', async () => {
  const res = await worker.fetch(new Request('https://binglesignal.com/api/health', { headers: { 'cf-ipcountry': 'IN' } }), env);
  assert.equal((await res.json()).country, 'IN');
});

test('Health says which payment rails are configured and never exposes a secret', async () => {
  const full = await (await worker.fetch(new Request('https://binglesignal.com/api/health'), { ...env, RAZORPAY_PLAN_PRO_MONTHLY: 'p', RAZORPAY_PLAN_LITE_MONTHLY: 'l', GLOBAL_LINK_LITE_MONTH: 'x' })).json();
  assert.deepEqual(full.rails, { razorpay: true, global: true });
  const empty = await (await worker.fetch(new Request('https://binglesignal.com/api/health'), {})).json();
  assert.deepEqual(empty.rails, { razorpay: false, global: false });
});

test('Cancel (Razorpay) cancels at cycle end and marks the row; no login -> 401; international -> manual path', async () => {
  const calls = fakeNetwork({
    '/auth/v1/user': () => Response.json(USER),
    'select=provider,provider_subscription_id': () => Response.json([{ provider: 'razorpay', provider_subscription_id: 'sub_9', status: 'active', current_period_end: '2026-12-01T00:00:00Z' }]),
    'api.razorpay.com': () => Response.json({ id: 'sub_9' }),
  });

  const res = await worker.fetch(post('/api/cancel', {}, { authorization: 'Bearer jwt' }), env);
  assert.equal(res.status, 200);
  assert.equal(calls.find((c) => c.url.includes('/sub_9/cancel')).body.cancel_at_cycle_end, 1);
  assert.equal(calls.find((c) => c.init.method === 'PATCH').body.cancel_at_period_end, true);
  fakeNetwork();
  assert.equal((await worker.fetch(post('/api/cancel', {}), env)).status, 401);
  fakeNetwork({ '/auth/v1/user': () => Response.json(USER), 'select=provider,provider_subscription_id': () => Response.json([{ provider: 'global', provider_subscription_id: 'sub_g', status: 'active' }]) });
  assert.equal((await (await worker.fetch(post('/api/cancel', {}, { authorization: 'Bearer jwt' }), env)).json()).manual, true);
});
