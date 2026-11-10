// Runs the real public/premium.js inside a fake browser to prove the pricing page sells ONE plan through Razorpay only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const premium = await readFile(new URL('../../public/premium.js', import.meta.url), 'utf8');
const config = await readFile(new URL('../../public/config.js', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

async function boot({ country = 'IN', rails = {}, signedIn = true, access = { status: 'trialing', days_left: 5, has_access: true, plan: 'pro' } } = {}) {
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
    if (url.endsWith('/api/checkout')) return Response.json({ provider: 'razorpay', key_id: 'rzp_test', subscription_id: 'sub_1', short_url: 'https://rzp.io/i/1' });
    return new Response('{}');
  };
  runInNewContext(premium, {
    window, document, fetch: fakeFetch, location: { hash: '#/pricing', href: '' }, setTimeout, setInterval: () => 0,
    addEventListener: (type, handler) => { listeners[`window:${type}`] = handler; },
  });
  await settle();
  return {
    page: el('#px').innerHTML, banner: el('#bn').innerHTML, fetches, razorpay,
    subscribe: async () => { listeners.click({ target: { closest: () => ({ dataset: { plan: 'lite' } }) } }); await settle(); },
  };
}

test('India: one Briefing plan in rupees, a Subscribe button, no Pro or yearly choice, and the trial banner says "Free trial"', async () => {
  const app = await boot({ rails: { razorpay: true, razorpay_inr: true, razorpay_usd: false } });
  assert.equal((app.page.match(/<article/g) || []).length, 1);
  assert.match(app.page, /BingleSignal Briefing/);
  assert.match(app.page, /₹<\/span><b>299<\/b>/);
  assert.match(app.page, /data-plan="lite"/);
  assert.match(app.page, /id="gstin"/);
  assert.doesNotMatch(app.page, /Yearly|Choose Pro|Choose Lite|data-int=/);
  assert.match(app.banner, /Free trial/);
});

test('Subscribing in India starts a monthly INR Razorpay checkout titled BingleSignal Briefing', async () => {
  const app = await boot({ rails: { razorpay_inr: true } });
  await app.subscribe();
  const request = app.fetches.find((entry) => entry.url.endsWith('/api/checkout'));
  assert.deepEqual(request.body, { interval: 'month', currency: 'INR', gstin: '' });
  assert.equal(app.razorpay.length, 1);
  assert.equal(app.razorpay[0].key, 'rzp_test');
  assert.equal(app.razorpay[0].subscription_id, 'sub_1');
  assert.equal(app.razorpay[0].description, 'BingleSignal Briefing');
  assert.equal(app.razorpay.opened, true);
});

test('Outside India the same plan is $5 through Razorpay, and the button waits until the USD plan is configured', async () => {
  const waiting = await boot({ country: 'DE', rails: { razorpay_inr: true, razorpay_usd: false } });
  assert.match(waiting.page, /\$<\/span><b>5<\/b>/);
  assert.match(waiting.page, /Payments opening soon/);
  assert.doesNotMatch(waiting.page, /data-plan=/);

  const ready = await boot({ country: 'DE', rails: { razorpay_inr: true, razorpay_usd: true } });
  assert.match(ready.page, /Subscribe · \$5\/month/);
  await ready.subscribe();
  assert.deepEqual(ready.fetches.find((entry) => entry.url.endsWith('/api/checkout')).body, { interval: 'month', currency: 'USD', gstin: '' });
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
