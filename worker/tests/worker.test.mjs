import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import worker, { verifyRazorpay, verifyStandardWebhook, mapRazorpay, mapGlobal } from '../src/index.js';
import { betaTestReport, handleEmailRequest, isValidBetaSchedule } from '../src/email-beta.js';

const env = {
  SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service',
  RAZORPAY_KEY_ID: 'rzp_test_1', RAZORPAY_KEY_SECRET: 'secret', RAZORPAY_WEBHOOK_SECRET: 'hooksecret',
  RAZORPAY_PLAN_PRO_MONTHLY: 'plan_pro_m', RAZORPAY_PLAN_LITE_MONTHLY: 'plan_lite_m',
  RAZORPAY_PLAN_PRO_YEARLY: 'plan_pro_y', RAZORPAY_PLAN_LITE_YEARLY: 'plan_lite_y',
  RAZORPAY_PLAN_PRO_MONTHLY_USD: 'plan_pro_usd_m', RAZORPAY_PLAN_LITE_MONTHLY_USD: 'plan_lite_usd_m',
  RAZORPAY_PLAN_PRO_YEARLY_USD: 'plan_pro_usd_y', RAZORPAY_PLAN_LITE_YEARLY_USD: 'plan_lite_usd_y',
  GLOBAL_WEBHOOK_SECRET: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', GLOBAL_LINK_PRO_MONTH: 'https://pay.example.com/pro',
  GLOBAL_PRODUCT_LITE_MONTH: 'product_lite_m', GLOBAL_PRODUCT_PRO_MONTH: 'product_pro_m',
  GLOBAL_PRODUCT_LITE_YEAR: 'product_lite_y', GLOBAL_PRODUCT_PRO_YEAR: 'product_pro_y',
  API_RATE_LIMITS: {
    idFromName: (name) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
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
  new Request('https://binglesignal.com' + path, {
    method: 'POST',
    headers: { 'cf-connecting-ip': '203.0.113.1', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const rzpSig = (raw) => createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
const rzpEvent = (event, extra = {}) => ({ event, created_at: 1793000000, payload: { subscription: { entity: {
  id: 'sub_123', plan_id: 'plan_pro_m', customer_id: 'cust_1', current_end: 1795600000,
  notes: { user_id: USER.id, plan: 'lite' }, ...extra } } } });

test('Public pricing is centralized and uses the current INR and USD plan amounts', async () => {
  const config = await readFile(new URL('../../public/config.js', import.meta.url), 'utf8');
  const context = { window: {} };
  runInNewContext(config, context);
  const prices = JSON.parse(JSON.stringify(context.window.BS.prices));
  assert.deepEqual(prices, {
    IN: { c: '₹', lite: { month: '299', year: '2,999' }, pro: { month: '799', year: '7,999' } },
    GL: { c: '$', lite: { month: '5', year: '50' }, pro: { month: '11', year: '110' } },
  });
  const premium = await readFile(new URL('../../public/premium.js', import.meta.url), 'utf8');
  assert.match(premium, /const PRICE = BS\.prices;/);
  assert.doesNotMatch(premium, /\$2\.99|\$5\.99|month: '99'/);
  const vars = await readFile(new URL('../../.dev.vars.example', import.meta.url), 'utf8');
  for (const variable of [
    'RAZORPAY_PLAN_LITE_MONTHLY_USD',
    'RAZORPAY_PLAN_PRO_MONTHLY_USD',
    'RAZORPAY_PLAN_LITE_YEARLY_USD',
    'RAZORPAY_PLAN_PRO_YEARLY_USD',
  ]) assert.match(vars, new RegExp(`^${variable}=`, 'm'));
  const index = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(index, /pagead2\.googlesyndication\.com|adsbygoogle/i);
});

test('Trust page, security contact, and Google Limited Use wording are published', async () => {
  const trust = await readFile(new URL('../../public/trust.html', import.meta.url), 'utf8');
  const security = await readFile(new URL('../../.well-known/security.txt', import.meta.url), 'utf8');
  const privacy = await readFile(new URL('../../public/privacy.html', import.meta.url), 'utf8');
  const contact = await readFile(new URL('../../public/contact.html', import.meta.url), 'utf8');
  assert.match(trust, /Email data lifecycle/);
  assert.match(trust, /configured AI provider/);
  assert.match(trust, /Raw message text is not stored/);
  assert.match(security, /Contact: mailto:security@binglesignal\.com/);
  assert.match(privacy, /Google API Services User Data Policy, including the Limited Use requirements/);
  assert.match(contact, /Name: OHM JAGAY/);
  assert.doesNotMatch(contact, /to be published here/);
});

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

test('Razorpay webhook: a successful charge applies the configured plan in one idempotent database call', async () => {
  const calls = fakeNetwork();
  const raw = JSON.stringify(rzpEvent('subscription.charged'));
  const res = await worker.fetch(post('/api/webhooks/razorpay', raw, { 'x-razorpay-signature': rzpSig(raw), 'x-razorpay-event-id': 'evt_1' }), env);
  assert.equal(res.status, 200);
  const rpc = calls.find((c) => c.url.includes('/rpc/apply_payment_webhook'));
  assert.ok(rpc, 'event processing and de-duplication use one transaction');
  assert.equal(rpc.body.p_event_key, 'razorpay:evt_1');
  assert.equal(rpc.body.p_user_id, USER.id);
  assert.equal(rpc.body.p_patch.status, 'active');
  assert.equal(rpc.body.p_patch.plan, 'pro');
  assert.equal(rpc.body.p_patch.billing_interval, 'month');
  assert.equal(rpc.body.p_patch.currency, 'INR');
  assert.equal(rpc.body.p_patch.current_period_end, new Date(1795600000 * 1000).toISOString());
  assert.equal(calls.some((c) => c.init.method === 'PATCH' && c.url.includes('/subscriptions?')), false);
});

test('Razorpay webhook: wrong signature is rejected and nothing is written', async () => {
  const calls = fakeNetwork();
  const raw = JSON.stringify(rzpEvent('subscription.charged'));
  const res = await worker.fetch(post('/api/webhooks/razorpay', raw, { 'x-razorpay-signature': 'nope' }), env);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('Razorpay mapping: pending -> past_due, halted -> expired, cancelled -> canceled, unknown -> ignored', () => {
  assert.equal(mapRazorpay(rzpEvent('subscription.pending'), env).patch.status, 'past_due');
  assert.equal(mapRazorpay(rzpEvent('subscription.halted'), env).patch.status, 'expired');
  assert.equal(mapRazorpay(rzpEvent('subscription.cancelled'), env).patch.status, 'canceled');
  assert.equal(mapRazorpay(rzpEvent('subscription.authenticated'), env).patch.status, undefined);
  assert.equal(mapRazorpay(rzpEvent('payment.captured'), env), null);
  assert.equal(mapRazorpay(rzpEvent('subscription.charged', { plan_id: 'unconfigured' }), env).error, 'unknown_plan');
  assert.equal(mapRazorpay(rzpEvent('subscription.updated', { plan_id: 'plan_pro_usd_y' }), env).patch.currency, 'USD');
  assert.equal(mapRazorpay(rzpEvent('payment.failed'), env).patch.status, 'past_due');
});

test('Payment hardening migration makes checkout reservations private and webhook apply atomic', async () => {
  const migration = await readFile(new URL('../../supabase/009_payment_hardening.sql', import.meta.url), 'utf8');
  assert.match(migration, /create table if not exists public\.payment_checkout_sessions/);
  assert.match(migration, /alter table public\.payment_checkout_sessions enable row level security/);
  assert.match(migration, /revoke all on table public\.payment_checkout_sessions from public, anon, authenticated/);
  assert.match(migration, /on conflict \(id\) do nothing/);
  assert.match(migration, /get diagnostics inserted_count = row_count/);
  assert.match(migration, /if inserted_count = 0 then return false/);
  assert.match(migration, /update public\.subscriptions s set/);
});

test('Checkout without login -> 401', async () => {
  fakeNetwork();
  assert.equal((await worker.fetch(post('/api/checkout', { plan: 'pro' }), env)).status, 401);
});

test('Checkout rate limiting fails closed and returns 429 when the address is over quota', async () => {
  fakeNetwork();
  const limited = {
    ...env,
    API_RATE_LIMITS: {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => Response.json({ allowed: false }) }),
    },
  };
  const response = await worker.fetch(post('/api/checkout', { plan: 'pro' }), limited);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '600');
});

test('Payment-changing routes fail closed when rate-limit storage is unavailable', async () => {
  fakeNetwork();
  const noLimiter = { ...env, API_RATE_LIMITS: undefined };
  const response = await worker.fetch(post('/api/cancel', {}, { 'cf-connecting-ip': '203.0.113.8' }), noLimiter);
  assert.equal(response.status, 503);
});

test('Browser authentication requires a Turnstile token and the site sends no inline script', async () => {
  const app = await readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
  const config = await readFile(new URL('../../public/config.js', import.meta.url), 'utf8');
  const premium = await readFile(new URL('../../public/premium.js', import.meta.url), 'utf8');
  const auth = await readFile(new URL('../src/supabase.js', import.meta.url), 'utf8');
  const index = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
  const headers = await readFile(new URL('../../public/_headers', import.meta.url), 'utf8');
  assert.match(app, /captcha_token:captchaToken/);
  assert.match(app, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/);
  assert.match(app, /auth\/v1\/factors/);
  assert.match(premium, /Set up authenticator/);
  assert.match(auth, /payload\.aal === 'aal2'/);
  assert.match(config, /turnstileSiteKey/);
  assert.doesNotMatch(index, /<script type="module">\s*[\r\n]/);
  assert.match(headers, /Strict-Transport-Security:/);
  assert.match(headers, /X-Frame-Options: DENY/);
  assert.match(headers, /Content-Security-Policy-Report-Only:.*frame-ancestors 'none'/);
});

test('Checkout (India): Razorpay subscription is created and the unused trial is preserved via start_at', async () => {
  const trialEnd = Date.now() + 3 * 86400e3;
  const calls = fakeNetwork({
    '/auth/v1/user': () => Response.json(USER),
    '/rpc/reserve_payment_checkout': () => Response.json({ state: 'reserved' }),
    '/rpc/finish_payment_checkout': () => Response.json(true),
    'select=status,trial_ends_at': () => Response.json([{ status: 'trialing', trial_ends_at: new Date(trialEnd).toISOString() }]),
    'api.razorpay.com': () => Response.json({ id: 'sub_new', short_url: 'https://rzp.io/i/abc' }),
  });
  const res = await worker.fetch(post('/api/checkout', { plan: 'pro', interval: 'month', currency: 'INR' }, { authorization: 'Bearer jwt', 'cf-ipcountry': 'IN' }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { provider: 'razorpay', key_id: 'rzp_test_1', subscription_id: 'sub_new', short_url: 'https://rzp.io/i/abc' });
  const rz = calls.find((c) => c.url.includes('api.razorpay.com'));
  assert.equal(rz.body.plan_id, 'plan_pro_m');
  assert.equal(rz.body.notes.user_id, USER.id);
  assert.equal(rz.body.start_at, Math.floor(trialEnd / 1000));
  assert.ok(rz.body.expire_by > Math.floor(Date.now() / 1000));
  assert.ok(calls.some((call) => call.url.includes('/rpc/reserve_payment_checkout')));
  assert.equal(rz.init.headers.authorization, 'Basic ' + btoa('rzp_test_1:secret'));
});

test('Checkout (outside India): returns the hosted payment link carrying email + user id', async () => {
  fakeNetwork({
    '/auth/v1/user': () => Response.json(USER),
    '/rpc/reserve_payment_checkout': () => Response.json({ state: 'reserved' }),
    '/rpc/finish_payment_checkout': () => Response.json(true),
  });
  const res = await worker.fetch(post('/api/checkout', { plan: 'pro', interval: 'month', currency: 'USD' }, { authorization: 'Bearer jwt', 'cf-ipcountry': 'DE' }), env);
  const out = await res.json();
  assert.equal(out.provider, 'global');
  assert.match(out.url, /^https:\/\/pay\.example\.com\/pro\?email=Ria%40Example\.com&metadata_user_id=aaaaaaaa-0000/);
});

test('Checkout returns the reserved URL instead of creating a second provider checkout', async () => {
  const calls = fakeNetwork({
    '/auth/v1/user': () => Response.json(USER),
    '/rpc/reserve_payment_checkout': () => Response.json({
      state: 'open', provider: 'global', checkout_url: 'https://pay.example.com/existing',
    }),
  });
  const res = await worker.fetch(post('/api/checkout', { plan: 'pro', interval: 'month', currency: 'USD' },
    { authorization: 'Bearer test-token', 'cf-ipcountry': 'DE' }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { provider: 'global', url: 'https://pay.example.com/existing', existing: true });
  assert.equal(calls.some((call) => call.url.includes('api.razorpay.com')), false);
});

test('Checkout rejects malformed GSTIN before reserving or contacting a payment provider', async () => {
  const calls = fakeNetwork({ '/auth/v1/user': () => Response.json(USER) });
  const res = await worker.fetch(post('/api/checkout', {
    plan: 'pro', interval: 'month', currency: 'INR', gstin: 'not-a-gstin',
  }, { authorization: 'Bearer test-token', 'cf-ipcountry': 'IN' }), env);
  assert.equal(res.status, 400);
  assert.equal(calls.some((call) => call.url.includes('/rpc/reserve_payment_checkout')), false);
});

test('Plan switch uses the verified Razorpay update parameters and upgrades immediately', async () => {
  const calls = fakeNetwork({
    '/auth/v1/user': () => Response.json(USER),
    'select=provider,provider_subscription_id,status,plan,currency,billing_interval': () =>
      Response.json([{ provider: 'razorpay', provider_subscription_id: 'sub_9', status: 'active',
        plan: 'lite', currency: 'INR', billing_interval: 'month' }]),
    'api.razorpay.com': () => Response.json({ id: 'sub_9', status: 'active' }),
  });
  const res = await worker.fetch(post('/api/plan/switch', { plan: 'pro', apply_at: 'now' },
    { authorization: 'Bearer test-token' }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, plan: 'pro', scheduled_for: 'now' });
  const update = calls.find((call) => call.url.includes('api.razorpay.com'));
  assert.equal(update.init.method, 'PATCH');
  assert.equal(update.body.plan_id, 'plan_pro_m');
  assert.equal(update.body.schedule_change_at, 'now');
});

test('Global webhook: signed subscription.active activates the user named in metadata', async () => {
  const calls = fakeNetwork();
  const raw = JSON.stringify({ type: 'subscription.active', timestamp: '2026-11-02T10:00:00Z',
    data: { subscription_id: 'sub_g1', product_id: 'product_lite_m', next_billing_date: '2026-12-02T10:00:00Z',
      metadata: { user_id: USER.id, plan: 'pro' }, customer: { email: USER.email } } });
  const id = 'msg_1', ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', Buffer.from(env.GLOBAL_WEBHOOK_SECRET.slice(6), 'base64')).update(`${id}.${ts}.${raw}`).digest('base64');
  const res = await worker.fetch(post('/api/webhooks/global', raw, { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': 'v1,' + sig }), env);
  assert.equal(res.status, 200);
  const transaction = calls.find((c) => c.url.includes('/rpc/apply_payment_webhook'));
  assert.equal(transaction.body.p_patch.status, 'active');
  assert.equal(transaction.body.p_patch.plan, 'lite');
  assert.equal(transaction.body.p_patch.billing_interval, 'month');
  assert.equal(transaction.body.p_patch.currency, 'USD');
});

test('Global mapping: on_hold -> past_due; email-only webhooks are ignored', () => {
  const ev = (type) => ({ type, data: { customer: { email: 'x@y.com' } } });
  assert.equal(mapGlobal({ type: 'subscription.on_hold', data: {
    metadata: { user_id: USER.id }, product_id: 'product_pro_y',
  } }, env).patch.status, 'past_due');
  assert.equal(mapGlobal(ev('subscription.on_hold')), null);
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
