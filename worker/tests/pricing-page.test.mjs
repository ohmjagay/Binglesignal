// Runs the real public/premium.js inside a fake browser to prove the pricing page sells ONE plan through Razorpay only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const premium = await readFile(new URL('../../public/premium.js', import.meta.url), 'utf8');
const config = await readFile(new URL('../../public/config.js', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

async function boot({ country = 'IN', rails = {}, quote, signedIn = true, access = { status: 'trialing', days_left: 5, has_access: true, plan: 'pro' } } = {}) {
  const elements = new Map(), listeners = {}, fetches = [], razorpay = [];
  const el = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: '', hidden: false, textContent: '', value: '', setAttribute() {}, dataset: {} });
    return elements.get(selector);
  };
  const window = { scrollTo() {}, dispatchEvent() {}, Razorpay: class { constructor(options) { razorpay.push(options); } open() { razorpay.opened = true; } } };
  runInNewContext(config, { window });
  window.BSAuth = { has: () => signedIn, token: async () => 'jwt', user: () => ({ email: 'ria@example.com' }) };
  const document = {
    querySelector: (selector) => (selector.startsWith('script[') || selector === '#home .brand' ? null : el(selector)),
    addEventListener: (type, handler) => { listeners[type] = handler; },
    createElement: () => ({}),
    head: { appendChild: (node) => queueMicrotask(() => node.onload?.()) },
  };
  const fakeFetch = async (url, init = {}) => {
    url = String(url);
    fetches.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith('/api/health')) return Response.json({ ok: true, country, rails });
    if (url.includes('/rpc/my_access')) return Response.json(access);
    if (url.endsWith('/api/quote')) return Response.json(quote === undefined ? { usd: 5, country, inr: { usd: 5, rate: 88.4, base_inr: 442, gst_percent: 18, gst_inr: 80, rounding_inr: 3, total_inr: 525, quantity: 105 } } : quote);
    if (url.endsWith('/api/checkout')) return Response.json({ provider: 'razorpay', key_id: 'rzp_test', subscription_id: 'sub_1', short_url: 'https://rzp.io/i/1' });
    return new Response('{}');
  };
  runInNewContext(premium, {
    window, document, fetch: fakeFetch, location: { hash: '#/pricing', href: '' }, setTimeout, setInterval: () => 0,
    addEventListener: (type, handler) => { listeners[`window:${type}`] = handler; },
  });
  await settle();
  const click = async (dataset) => { listeners.click({ target: { closest: () => ({ dataset }) } }); await settle(); };
  return {
    get page() { return el('#px').innerHTML; }, get banner() { return el('#bn').innerHTML; }, fetches, razorpay,
    subscribe: () => click({ plan: 'lite' }),
    pay: (currency) => click({ pay: currency }),
    back: () => click({ payCancel: '' }),
  };
}

test('Everyone sees $5 a month, the plan text from config.js, and no GSTIN box or currency toggle', async () => {
  const app = await boot({ rails: { razorpay: true, razorpay_inr: true, razorpay_usd: true } });
  assert.equal((app.page.match(/<article/g) || []).length, 1);
  assert.match(app.page, /BingleSignal Briefing/);
  assert.match(app.page, /\$<\/span><b>5<\/b>/);
  assert.doesNotMatch(app.page, /₹<\/span><b>/);
  assert.match(app.page, /data-plan="lite"/);
  assert.match(app.page, /Subscribe · \$5\/month/);
  assert.match(app.page, /READ: a clear summary of every story/);
  assert.doesNotMatch(app.page, /gstin|GSTIN|data-currency|Yearly|Choose Pro|Choose Lite|data-int=/);
  assert.match(app.banner, /Free trial/);
  const germany = await boot({ country: 'DE', rails: { razorpay_inr: true, razorpay_usd: true } });
  assert.match(germany.page, /\$<\/span><b>5<\/b>/, 'the same price is shown outside India');
});

test('India: Subscribe first shows the live rupee total (rate + GST) next to the dollar option, and the customer picks', async () => {
  const app = await boot({ rails: { razorpay_inr: true, razorpay_usd: true } });
  await app.subscribe();
  assert.equal(app.fetches.some((entry) => entry.url.endsWith('/api/checkout')), false, 'nothing is charged until they choose');
  assert.match(app.page, /data-pay="INR">Pay ₹525 a month in rupees/);
  assert.match(app.page, /₹88\.4 per \$1/);
  assert.match(app.page, /₹442 \+ 18% GST ₹80 \+ ₹3 rounding/);
  assert.match(app.page, /data-pay="USD">Pay \$5\.00 a month in US dollars/);
  await app.back();
  assert.match(app.page, /data-plan="lite"/);
  assert.doesNotMatch(app.page, /data-pay=/);
});

test('India: choosing rupees sends the price they saw, and opens Razorpay', async () => {
  const app = await boot({ rails: { razorpay_inr: true, razorpay_usd: true } });
  await app.subscribe();
  await app.pay('INR');
  const request = app.fetches.find((entry) => entry.url.endsWith('/api/checkout'));
  assert.deepEqual(request.body, { interval: 'month', currency: 'INR', expected_total_inr: 525 });
  assert.equal(app.razorpay.length, 1);
  assert.equal(app.razorpay[0].key, 'rzp_test');
  assert.equal(app.razorpay[0].subscription_id, 'sub_1');
  assert.equal(app.razorpay[0].description, 'BingleSignal Briefing');
  assert.equal(app.razorpay.opened, true);
});

test('India: choosing dollars starts the USD checkout', async () => {
  const app = await boot({ rails: { razorpay_inr: true, razorpay_usd: true } });
  await app.subscribe();
  await app.pay('USD');
  assert.deepEqual(app.fetches.find((entry) => entry.url.endsWith('/api/checkout')).body, { interval: 'month', currency: 'USD' });
  assert.equal(app.razorpay.length, 1);
});

test('India with only the rupee plan configured, and no live rate available: the customer is told, not charged a guess', async () => {
  const app = await boot({ rails: { razorpay_inr: true }, quote: { usd: 5, inr: null } });
  await app.subscribe();
  assert.match(app.page, /live rupee price is unavailable/);
  assert.doesNotMatch(app.page, /data-pay="INR"/);
});

test('Outside India there is nothing to choose: $5 in dollars, once the USD plan is configured', async () => {
  const waiting = await boot({ country: 'DE', rails: { razorpay_inr: true, razorpay_usd: false } });
  assert.match(waiting.page, /Payments opening soon/);
  assert.doesNotMatch(waiting.page, /data-plan=/);

  const ready = await boot({ country: 'DE', rails: { razorpay_inr: true, razorpay_usd: true } });
  await ready.subscribe();
  assert.equal(ready.fetches.some((entry) => entry.url.endsWith('/api/quote')), false);
  assert.deepEqual(ready.fetches.find((entry) => entry.url.endsWith('/api/checkout')).body, { interval: 'month', currency: 'USD' });
  assert.equal(ready.razorpay.length, 1);
});

test('Signed-out visitors see the free trial; subscribers see "Your current plan"', async () => {
  const visitor = await boot({ signedIn: false, rails: { razorpay_inr: true } });
  assert.match(visitor.page, /Start 7-day free trial/);
  assert.doesNotMatch(visitor.page, /data-plan=/);
  const subscriber = await boot({ rails: { razorpay_inr: true }, access: { status: 'active', plan: 'lite', has_access: true } });
  assert.match(subscriber.page, /Your current plan/);
  assert.doesNotMatch(subscriber.page, /data-plan=/);
});
