// $5 worldwide; in India the same price in rupees at the live rate + GST, charged as quantity x a 1-rupee Razorpay plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { buildInrQuote, gstPercent, usdInrRate, getInrQuote, USD_PRICE, QuoteUnavailable } from '../src/pricing.js';

const env = {
  SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service',
  RAZORPAY_KEY_ID: 'rzp_test_1', RAZORPAY_KEY_SECRET: 'secret',
  RAZORPAY_PLAN_LITE_MONTHLY: 'plan_inr_unit', RAZORPAY_PLAN_LITE_MONTHLY_USD: 'plan_usd_5',
  API_RATE_LIMITS: { idFromName: (name) => name, get: () => ({ fetch: async () => Response.json({ allowed: true }) }) },
};
const USER = { id: 'aaaaaaaa-0000-0000-0000-000000000001', email: 'ria@example.com' };
const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

function fakeNetwork(routes = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    let body; try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    calls.push({ url, init, body });
    for (const [needle, reply] of Object.entries(routes)) if (url.includes(needle)) return reply();
    return new Response('[]', { status: 200 });
  };
  return calls;
}
const checkoutRoutes = ({ rate = 88.4, planAmount = 500, fx = 'ok' } = {}) => ({
  '/auth/v1/user': () => Response.json(USER),
  '/rpc/reserve_payment_checkout': () => Response.json({ state: 'reserved' }),
  '/rpc/release_payment_checkout': () => Response.json(true),
  '/rpc/finish_payment_checkout': () => Response.json(true),
  'select=status,trial_ends_at': () => Response.json([]),
  'api.frankfurter.dev': () => (fx === 'ok' ? Response.json({ rates: { INR: rate } }) : new Response('down', { status: 500 })),
  'open.er-api.com': () => (fx === 'ok' ? Response.json({ rates: { INR: rate } }) : new Response('down', { status: 500 })),
  'api.razorpay.com/v1/plans/': () => Response.json({ item: { currency: 'INR', amount: planAmount } }),
  'api.razorpay.com': () => Response.json({ id: 'sub_new', short_url: 'https://rzp.io/i/abc' }),
});
const checkout = (body, headers = {}, extraEnv = {}) => worker.fetch(new Request('https://binglesignal.com/api/checkout', {
  method: 'POST', headers: { authorization: 'Bearer jwt', 'cf-ipcountry': 'IN', 'cf-connecting-ip': '203.0.113.1', ...headers }, body: JSON.stringify(body),
}), { ...env, ...extraEnv });
const subscription = (calls) => calls.find((c) => c.url.endsWith('/v1/subscriptions'));
const reserved = (calls) => calls.some((c) => c.url.includes('/rpc/reserve_payment_checkout'));

test('The price is $5 and the rupee quote is $5 x the live rate, then GST, in whole rupees', () => {
  assert.equal(USD_PRICE, 5);
  assert.deepEqual(
    (({ base_inr, gst_percent, gst_inr, rounding_inr, total_inr, quantity }) => ({ base_inr, gst_percent, gst_inr, rounding_inr, total_inr, quantity }))(buildInrQuote(88.4)),
    { base_inr: 442, gst_percent: 18, gst_inr: 80, rounding_inr: 3, total_inr: 525, quantity: 105 });
  assert.equal(buildInrQuote(83.333).total_inr, 495);                   // 416.665 -> 417, GST 75.06 -> 75, 492 rounded up to the next 5
  assert.equal(buildInrQuote(88.4, { GST_PERCENT: '0' }).total_inr, 445); // not registered for GST: no GST is added (442 rounded up to the next 5)
  assert.equal(buildInrQuote(88.4, { GST_PERCENT: '5' }).gst_inr, 22);
});

test('GST_PERCENT defaults to 18 and ignores nonsense', () => {
  assert.equal(gstPercent({}), 18);
  assert.equal(gstPercent({ GST_PERCENT: '' }), 18);
  assert.equal(gstPercent({ GST_PERCENT: '0' }), 0);
  assert.equal(gstPercent({ GST_PERCENT: 'abc' }), 18);
  assert.equal(gstPercent({ GST_PERCENT: '90' }), 18);
});

test('Exchange rate: falls through to the second source, rejects absurd rates, then uses your own fallback, then refuses', async () => {
  fakeNetwork({ 'api.frankfurter.dev': () => new Response('x', { status: 503 }), 'open.er-api.com': () => Response.json({ rates: { INR: 89.1 } }) });
  assert.equal((await usdInrRate({})).rate, 89.1);

  fakeNetwork({ 'api.frankfurter.dev': () => Response.json({ rates: { INR: 1 } }), 'open.er-api.com': () => Response.json({ rates: { INR: 88.9 } }) });
  assert.equal((await usdInrRate({})).source, 'ExchangeRate-API', 'a rate of 1 is a broken feed, never a price');

  fakeNetwork({ 'api.frankfurter.dev': () => new Response('x', { status: 500 }), 'open.er-api.com': () => new Response('x', { status: 500 }) });
  assert.deepEqual((await usdInrRate({ FX_FALLBACK_USD_INR: '88.5' })).rate, 88.5);
  await assert.rejects(() => getInrQuote({}), QuoteUnavailable);
});

test('GET /api/quote: Indian visitors get the rupee quote, everyone else only the dollar price', async () => {
  const calls = fakeNetwork(checkoutRoutes());
  const india = await worker.fetch(new Request('https://binglesignal.com/api/quote', { headers: { 'cf-ipcountry': 'IN' } }), env);
  const body = await india.json();
  assert.equal(india.status, 200);
  assert.equal(body.usd, 5);
  assert.equal(body.inr.total_inr, 525);
  assert.equal(body.inr.rate, 88.4);
  const before = calls.length;
  const germany = await (await worker.fetch(new Request('https://binglesignal.com/api/quote', { headers: { 'cf-ipcountry': 'DE' } }), env)).json();
  assert.deepEqual({ usd: germany.usd, inr: germany.inr }, { usd: 5, inr: null });
  assert.equal(calls.length, before, 'no rate lookup for visitors outside India');
});

test('Checkout in India charges the quote the customer saw: quantity x the 5-rupee plan, with the maths kept in the notes', async () => {
  const calls = fakeNetwork(checkoutRoutes());
  const res = await checkout({ interval: 'month', currency: 'INR', expected_total_inr: 525 });
  assert.equal(res.status, 200);
  const sub = subscription(calls);
  assert.equal(sub.body.plan_id, 'plan_inr_unit');
  assert.equal(sub.body.quantity, 105, 'INR 525 = 105 units of the INR 5 plan (Razorpay allows at most 500 units)');
  assert.deepEqual(
    (({ usd_price, fx_usd_inr, base_inr, gst_percent, gst_inr, rounding_inr, unit_inr, total_inr }) => ({ usd_price, fx_usd_inr, base_inr, gst_percent, gst_inr, rounding_inr, unit_inr, total_inr }))(sub.body.notes),
    { usd_price: '5', fx_usd_inr: '88.4', base_inr: '442', gst_percent: '18', gst_inr: '80', rounding_inr: '3', unit_inr: '5', total_inr: '525' });
});

test('If the rate moved since the customer saw the price, nothing is reserved or charged and they are shown the new price', async () => {
  const calls = fakeNetwork(checkoutRoutes({ rate: 90 }));
  const res = await checkout({ interval: 'month', currency: 'INR', expected_total_inr: 525 });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'rate_changed');
  assert.equal(body.quote.total_inr, 535);   // 450 + 81 GST = 531, rounded up to the next 5
  assert.equal(reserved(calls), false);
  assert.equal(Boolean(subscription(calls)), false);
});

test('GST_PERCENT=0 (no GSTIN yet) charges the bare converted price', async () => {
  const calls = fakeNetwork(checkoutRoutes());
  const res = await checkout({ interval: 'month', currency: 'INR' }, {}, { GST_PERCENT: '0' });
  assert.equal(res.status, 200);
  assert.equal(subscription(calls).body.quantity, 89);   // INR 445 / 5
});

test('SAFETY: an INR plan that is not exactly 5 rupees is refused, so an old 299-rupee plan can never be multiplied', async () => {
  const calls = fakeNetwork(checkoutRoutes({ planAmount: 29900 }));
  const res = await checkout({ interval: 'month', currency: 'INR' }, {}, { RAZORPAY_PLAN_LITE_MONTHLY: 'plan_old_299' });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /not set up correctly/);
  assert.equal(reserved(calls), false);
  assert.equal(Boolean(subscription(calls)), false);
});

test('If no live rate can be fetched, checkout says so and offers dollars instead of guessing a price', async () => {
  const calls = fakeNetwork(checkoutRoutes({ fx: 'down' }));
  const res = await checkout({ interval: 'month', currency: 'INR' });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /US dollars/);
  assert.equal(reserved(calls), false);
});

test('Checkout outside India is $5 straight from the USD plan with no exchange-rate lookup', async () => {
  const calls = fakeNetwork(checkoutRoutes());
  const res = await checkout({ interval: 'month', currency: 'USD' }, { 'cf-ipcountry': 'US' });
  assert.equal(res.status, 200);
  const sub = subscription(calls);
  assert.equal(sub.body.plan_id, 'plan_usd_5');
  assert.equal(sub.body.quantity, 1);
  assert.equal(calls.some((c) => c.url.includes('frankfurter') || c.url.includes('er-api')), false);
});

test('A rupee total never needs more than the 500 units Razorpay allows, even at an absurd exchange rate', () => {
  assert.ok(buildInrQuote(300).quantity <= 500);
  assert.ok(buildInrQuote(93.69).quantity < 150, 'today the INR 552 that failed with a quantity of 552 is now 111 units');
  assert.throws(() => buildInrQuote(1000000), QuoteUnavailable);
});

test('SAFETY: the old 1-rupee plan is refused now that the INR plan must be exactly INR 5', async () => {
  const calls = fakeNetwork(checkoutRoutes({ planAmount: 100 }));
  const res = await checkout({ interval: 'month', currency: 'INR' }, {}, { RAZORPAY_PLAN_LITE_MONTHLY: 'plan_old_1' });
  assert.equal(res.status, 503);
  assert.equal(Boolean(subscription(calls)), false);
});
