// Runs the real public/premium.js inside a fake browser to prove PayPal is the first choice and Razorpay sits behind "Choose another option".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const premium = await readFile(new URL('../../public/premium.js', import.meta.url), 'utf8');
const config = await readFile(new URL('../../public/config.js', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

async function boot({ country = 'IN', rails = {}, quote, signedIn = true, access = { status: 'trialing', days_left: 5, has_access: true, plan: 'pro' }, plan = {}, auth = {}, bs = {}, hash = '#/pricing', checkoutStatus = 200, search = '', pathname = '/pricing', paypalCheckout } = {}) {
  const elements = new Map(), listeners = {}, fetches = [], razorpay = [];
  const el = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: '', hidden: false, textContent: '', value: '', setAttribute() {}, scrollIntoView() {}, dataset: {} });
    return elements.get(selector);
  };
  const window = { scrollTo() {}, dispatchEvent() {}, Razorpay: class { constructor(options) { razorpay.push(options); } open() { razorpay.opened = true; } } };
  runInNewContext(config, { window });
  Object.assign(window.BS.plan, plan);   // a test can pretend the owner edited config.js
  Object.assign(window.BS, bs);
  window.BSAuth = { has: () => signedIn, token: async () => 'jwt', user: () => ({ email: 'ria@example.com' }), ...auth };
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
    if (url.includes('/rpc/my_access')) return Response.json(typeof access === 'function' ? access() : access);
    if (url.endsWith('/api/quote')) return Response.json(quote === undefined ? { usd: 5, country, inr: { usd: 5, rate: 88.4, base_inr: 442, gst_percent: 18, gst_inr: 80, rounding_inr: 3, total_inr: 525, quantity: 105 } } : quote);
    if (url.endsWith('/api/checkout') && checkoutStatus !== 200) return Response.json({ error: 'invalid session' }, { status: checkoutStatus });
    if (url.endsWith('/api/checkout') && JSON.parse(init.body || '{}').provider === 'paypal') return paypalCheckout ? paypalCheckout() : Response.json({ provider: 'paypal', subscription_id: 'I-1', url: 'https://www.paypal.com/approve/1' });
    if (url.endsWith('/api/checkout')) return Response.json({ provider: 'razorpay', key_id: 'rzp_test', subscription_id: 'sub_1', short_url: 'https://rzp.io/i/1' });
    return new Response('{}');
  };
  const loc = { hash, href: '', search, pathname };
  runInNewContext(premium, {
    URLSearchParams, window, document, fetch: fakeFetch, location: loc, history: { replaceState: (a, b, url) => { loc.search = ''; loc.replaced = url; } }, setTimeout, setInterval: () => 0,
    addEventListener: (type, handler) => { listeners[`window:${type}`] = handler; },
  });
  await settle();
  const click = async (dataset) => { listeners.click({ target: { closest: () => ({ dataset }) } }); await settle(); };
  return {
    get page() { return el('#px').innerHTML; }, get banner() { return el('#bn').innerHTML; }, fetches, razorpay, loc, click,
    subscribe: () => click({ plan: 'lite' }),
    pay: (currency) => click({ pay: currency }),
    back: () => click({ payCancel: '' }),
  };
}

const rails = { paypal: true, razorpay_inr: true, razorpay_usd: true };

test('With PayPal on, Subscribe shows PayPal first and "Choose another option", and nothing is charged yet', async () => {
  const app = await boot({ rails });
  await app.subscribe();
  assert.match(app.page, /data-pay-paypal>Pay \$5\.00 a month via PayPal/);
  assert.match(app.page, /data-pay-other>Choose another option/);
  assert.ok(app.page.indexOf('data-pay-paypal') < app.page.indexOf('data-pay-other'), 'PayPal comes first');
  assert.doesNotMatch(app.page, /data-pay="INR"|data-pay="USD"/, 'the Razorpay buttons are hidden until the customer asks for another option');
  assert.equal(app.fetches.some((f) => f.url.endsWith('/api/checkout')), false);
  assert.equal(app.razorpay.length, 0);
});

test('Pay via PayPal asks the server for a PayPal checkout and sends the customer to PayPal', async () => {
  for (const country of ['IN', 'DE']) {
    const app = await boot({ country, rails });
    await app.subscribe();
    await app.click({ payPaypal: '' });
    const call = app.fetches.find((f) => f.url.endsWith('/api/checkout'));
    assert.deepEqual(call.body, { interval: 'month', currency: 'USD', provider: 'paypal' });
    assert.equal(app.loc.href, 'https://www.paypal.com/approve/1');
    assert.equal(app.razorpay.length, 0);
  }
});

test('Choose another option opens the unchanged Razorpay screens (India: rupees and dollars; elsewhere: the dollar checkout)', async () => {
  const india = await boot({ rails });
  await india.subscribe();
  await india.click({ payOther: '' });
  assert.match(india.page, /data-pay="INR">Pay ₹525 a month in rupees/);
  assert.match(india.page, /data-pay="USD">Pay \$5\.00 a month in US dollars/);
  await india.pay('INR');
  assert.equal(india.razorpay.length, 1);
  assert.equal(india.razorpay[0].subscription_id, 'sub_1');
  assert.equal(india.fetches.find((f) => f.url.endsWith('/api/checkout')).body.provider, undefined, 'Razorpay requests are exactly what they were');
  await india.back();
  assert.match(india.page, /data-pay-paypal/, 'Back from the Razorpay screen returns to the PayPal choice');
  const germany = await boot({ country: 'DE', rails });
  await germany.subscribe();
  await germany.click({ payOther: '' });
  assert.equal(germany.razorpay.length, 1);
  assert.equal(germany.fetches.find((f) => f.url.endsWith('/api/checkout')).body.currency, 'USD');
});

test('If Razorpay is not ready, only PayPal is offered; if PayPal is off, nothing changes', async () => {
  const only = await boot({ country: 'DE', rails: { paypal: true } });
  await only.subscribe();
  assert.match(only.page, /data-pay-paypal/);
  assert.doesNotMatch(only.page, /data-pay-other/);
  const off = await boot({ rails: { razorpay_inr: true, razorpay_usd: true } });
  await off.subscribe();
  assert.doesNotMatch(off.page, /data-pay-paypal/);
  assert.match(off.page, /data-pay="INR"/);
});

test('A PayPal error is shown to the customer and they stay on the choice screen', async () => {
  const app = await boot({ rails, paypalCheckout: () => Response.json({ error: 'PayPal could not start the checkout. Please try again, or choose another option.' }, { status: 502 }) });
  await app.subscribe();
  await app.click({ payPaypal: '' });
  assert.match(app.page, /Could not start PayPal: PayPal could not start the checkout/);
  assert.match(app.page, /data-pay-paypal/);
  assert.equal(app.loc.href, '');
});

test('Coming back from PayPal waits for the plan to switch on; cancelling there shows a calm message', async () => {
  let asked = 0;
  const ACTIVE = { status: 'active', plan: 'lite', has_access: true };
  const back = await boot({ rails, search: '?paypal=return&subscription_id=I-1', bs: { pollMs: 1 }, access: () => (++asked < 3 ? { status: 'expired', has_access: false } : ACTIVE) });
  await new Promise((r) => setTimeout(r, 200));
  assert.match(back.page, /You are in\. Welcome to BingleSignal\./);
  assert.equal(back.loc.replaced, '/pricing', 'the ?paypal=return part is removed so a refresh does not repeat it');
  const cancelled = await boot({ rails, search: '?paypal=cancel' });
  assert.match(cancelled.page, /PayPal checkout was cancelled\. You have not been charged\./);
  assert.match(cancelled.page, /data-pay-paypal/);
});

test('Subscribing through PayPal during the free trial shows the first payment date instead of waiting forever', async () => {
  const app = await boot({ rails, search: '?paypal=return', bs: { pollMs: 1 }, access: { status: 'trialing', has_access: true, days_left: 4, trial_subscribed: true, trial_ends_at: '2026-12-01T00:00:00Z' } });
  await new Promise((r) => setTimeout(r, 100));
  assert.match(app.page, /You are subscribed/);
  assert.match(app.page, /first payment of \$5 is taken then/);
});
