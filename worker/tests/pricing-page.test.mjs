// Runs the real public/premium.js inside a fake browser to prove the pricing page sells ONE plan through Razorpay only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const premium = await readFile(new URL('../../public/premium.js', import.meta.url), 'utf8');
const config = await readFile(new URL('../../public/config.js', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

async function boot({ country = 'IN', rails = {}, quote, signedIn = true, access = { status: 'trialing', days_left: 5, has_access: true, plan: 'pro' }, plan = {}, auth = {}, bs = {}, hash = '#/pricing', checkoutStatus = 200 } = {}) {
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
    if (url.endsWith('/api/checkout')) return Response.json({ provider: 'razorpay', key_id: 'rzp_test', subscription_id: 'sub_1', short_url: 'https://rzp.io/i/1' });
    return new Response('{}');
  };
  const loc = { hash, href: '' };
  runInNewContext(premium, {
    window, document, fetch: fakeFetch, location: loc, setTimeout, setInterval: () => 0,
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

test('Signed-out visitors are invited to start the 7-day free trial; subscribers see "Your current plan"', async () => {
  const visitor = await boot({ signedIn: false, rails: { razorpay_inr: true } });
  assert.match(visitor.page, /Start 7-day free trial/);
  assert.match(visitor.page, /days you have left are added to your plan/, 'the carry-over of unused trial days is advertised');
  assert.doesNotMatch(visitor.page, /data-plan=/);
  const subscriber = await boot({ rails: { razorpay_inr: true }, access: { status: 'active', plan: 'lite', has_access: true } });
  assert.match(subscriber.page, /Your current plan/);
  assert.doesNotMatch(subscriber.page, /data-plan=/);
});

test('Everything you would want to reword comes from config.js: edit it there and the pricing page follows', async () => {
  const app = await boot({ rails: { razorpay_usd: true }, plan: {
    heading: 'HEADING-X', note: 'NOTE-X', name: 'NAME-X', label: 'LABEL-X', tagline: 'TAGLINE-X',
    features: ['FEATURE-ONE', 'FEATURE-TWO'], soon: ['SOON-ONE'],
    fine: 'FINE-X: {usd} a month.', faqHeading: 'FAQ-HEAD-X', faq: [['QUESTION-X?', 'ANSWER-X costs {usd}.']],
  } });
  for (const text of ['HEADING-X', 'NOTE-X', 'NAME-X', 'LABEL-X', 'TAGLINE-X', 'FEATURE-ONE', 'FEATURE-TWO', 'FAQ-HEAD-X', 'QUESTION-X?']) {
    assert.ok(app.page.includes(text), `${text} should be on the page`);
  }
  assert.match(app.page, /<li class="soon">SOON-ONE <i>soon<\/i><\/li>/);
  assert.match(app.page, /FINE-X: \$5 a month\./);
  assert.match(app.page, /ANSWER-X costs \$5\./);
  assert.doesNotMatch(app.page, /READ: a clear summary|One price worldwide|Can I cancel any time/, 'the old wording is gone once config.js changes');
});

test('The shipped config.js puts the small print (naming Razorpay), the questions and the dollar-card note on the pricing page', async () => {
  const app = await boot({ rails: { razorpay_inr: true, razorpay_usd: true } });
  assert.match(app.page, /One price worldwide: \$5 a month\./);
  assert.match(app.page, /Payments are processed by PayPal and Razorpay\./);
  assert.match(app.page, /href="\/refund"/);
  assert.match(app.page, /href="\/terms"/);
  assert.match(app.page, /Can I cancel any time\?/);
  assert.doesNotMatch(app.page, /\{usd\}/, 'the {usd} placeholder is always replaced');
  await app.subscribe();
  assert.match(app.page, /Your bank may add its own exchange rate and fees/);
});

test('An empty small print, dollar note or question list hides that text instead of breaking the page', async () => {
  const app = await boot({ rails: { razorpay_inr: true, razorpay_usd: true }, plan: { fine: '', usdNote: '', faq: [] } });
  assert.doesNotMatch(app.page, /One price worldwide|Questions/);
  assert.match(app.page, /href="\/terms"/, 'the Refunds and Terms links always stay');
  await app.subscribe();
  assert.match(app.page, /data-pay="USD">Pay \$5\.00 a month in US dollars/);
  assert.doesNotMatch(app.page, /<small class="mu"><\/small>/);
});

// ===== Sign out, Manage account, measured time saved, and what happens after paying =====
const until = async (condition) => { for (let i = 0; i < 100 && !condition(); i++) await settle(); };
const ACTIVE = { status: 'active', has_access: true, current_period_end: '2026-12-15T00:00:00Z' };

test('Every signed-in page has a Sign out button that works, and signed-out visitors do not see one', async () => {
  let signedOut = 0;
  const app = await boot({ rails: { razorpay_inr: true }, auth: { out: () => { signedOut++; } } });
  assert.match(app.page, /<button class="link" data-so>Sign out<\/button>/);
  await app.click({ so: '' });
  assert.equal(signedOut, 1);
  assert.doesNotMatch((await boot({ signedIn: false })).page, /Sign out/);
});

test('The account page shows the measured time saved with its formula, a Manage account card with Sign out, and no authenticator card', async () => {
  const app = await boot({ hash: '#/account', access: ACTIVE, auth: { stats: () => ({ stories: 40, seconds: 1200 }) } });
  assert.match(app.page, /You have saved about <b>1 h 40 min<\/b>/);
  assert.match(app.page, /You read <b>40<\/b> story summaries in about 20 min; the originals would have taken about 2 h 0 min \(40 × 3 min\)/);
  assert.match(app.page, /the stories you read × 3 minutes/);
  assert.match(app.page, /href="#\/manage">Manage account<\/a>/);
  assert.match(app.page, /data-so>Sign out/);
  assert.doesNotMatch(app.page, /Account security|Set up authenticator/);
  const fresh = await boot({ hash: '#/account', access: ACTIVE, auth: { stats: () => ({ stories: 0, seconds: 0 }) } });
  assert.match(fresh.page, /Nothing measured yet/);
  const tuned = await boot({ hash: '#/account', access: ACTIVE, bs: { articleMinutes: 5 }, auth: { stats: () => ({ stories: 10, seconds: 600 }) } });
  assert.match(tuned.page, /about <b>40 min<\/b>/, 'articleMinutes in config.js changes the formula: 10 × 5 − 10');
});

test('Manage account lists liked, saved and not-interested stories, takes each one back, and shows the plan and security', async () => {
  const forgotten = [];
  const lists = { liked: [{ id: 'a1', t: 'Kenya <b>patient</b> leaves hospital', u: 'https://dw.example/a', s: 'DW' }], saved: [], hidden: [{ id: 'h1', t: '', u: '', s: '' }] };
  const app = await boot({ hash: '#/manage', access: ACTIVE, auth: { lists: async () => lists, forget: (kind, id) => forgotten.push([kind, id]) } });
  assert.match(app.page, /Liked 1/);
  assert.match(app.page, /Saved 0/);
  assert.match(app.page, /Not interested 1/);
  assert.match(app.page, /Kenya &lt;b&gt;patient&lt;\/b&gt; leaves hospital/, 'story text is shown as text, never as markup');
  assert.match(app.page, /href="https:\/\/dw\.example\/a"/);
  await app.click({ um: 'liked', id: 'a1' });
  assert.deepEqual(forgotten, [['liked', 'a1']]);
  await app.click({ mt: 'saved' });
  assert.match(app.page, /Stories you save will be listed here/);
  await app.click({ mt: 'hidden' });
  assert.match(app.page, /A story that has left your feed/);
  assert.match(app.page, /data-um="hidden" data-id="h1">Show again/);
  await app.click({ mt: 'plan' });
  assert.match(app.page, /<b>Active<\/b>/);
  assert.match(app.page, /Renews on/);
  assert.match(app.page, /id="cx">Cancel subscription/);
  await app.click({ mt: 'security' });
  assert.match(app.page, /Set up authenticator/);
  assert.equal((await boot({ hash: '#/manage', signedIn: false })).loc.hash, '#/me/read', 'signed-out visitors are sent to sign in');
});

test('After paying: the page waits for the plan to switch on, then welcomes the customer with two next steps', async () => {
  let asked = 0;
  const app = await boot({ rails: { razorpay_inr: true, razorpay_usd: true }, bs: { pollMs: 1 }, access: () => (++asked < 4 ? { status: 'expired', has_access: false } : ACTIVE) });
  await app.subscribe(); await app.pay('USD');
  app.razorpay[0].handler({ razorpay_payment_id: 'pay_123' });
  assert.match(app.page, /Payment received/);
  await until(() => /Welcome to BingleSignal/.test(app.page));
  assert.match(app.page, /You are in\. Welcome to BingleSignal\./);
  assert.match(app.page, /href="#\/me\/read">Start my briefing/);
  assert.match(app.page, /data-personalize>Personalize my priorities/);
  await app.click({ personalize: '' });
  assert.equal(app.loc.hash, '#/', 'the home page holds the Tune my briefing panel');
});

test('If switching the plan on takes long, the customer is reassured, given a reference, and can check again', async () => {
  let active = false;
  const app = await boot({ rails: { razorpay_inr: true, razorpay_usd: true }, bs: { pollMs: 1 }, access: () => (active ? ACTIVE : { status: 'expired', has_access: false }) });
  await app.subscribe(); await app.pay('USD');
  app.razorpay[0].handler({ razorpay_payment_id: 'pay_slow1' });
  await until(() => /Reference/.test(app.page));
  assert.match(app.page, /do not need to pay again/);
  assert.match(app.page, /Reference: pay_slow1\./);
  assert.match(app.page, /data-recheck>Check again/);
  active = true;
  await app.click({ recheck: '' });
  await until(() => /Welcome to BingleSignal/.test(app.page));
  assert.match(app.page, /Welcome to BingleSignal/);
});

test('If the saved sign-in is no longer valid, checkout signs the person out and asks them to sign in again', async () => {
  let expired = 0;
  const app = await boot({ rails: { razorpay_inr: true, razorpay_usd: true }, checkoutStatus: 401, auth: { expired: () => { expired++; } } });
  await app.subscribe(); await app.pay('USD');
  assert.equal(expired, 1);
  assert.equal(app.razorpay.length, 0, 'no payment window is opened for an invalid session');
});

test('Free trial: a trialing user who has not subscribed is told nothing is charged today and that the first payment is on the trial end date', async () => {
  const trialEnd = '2026-11-20T12:00:00.000Z';
  const app = await boot({ country: 'DE', rails: { razorpay_usd: true }, access: { status: 'trialing', days_left: 3, has_access: true, plan: 'pro', trial_ends_at: trialEnd } });
  assert.match(app.page, /data-plan="lite"/, 'they can still subscribe');
  assert.match(app.page, /Nothing is charged today/);
  assert.match(app.page, /Your 3 days of free trial are added to your plan/);
  const expected = new Date(trialEnd).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  assert.ok(app.page.includes(`first payment is on <b>${expected}</b>`), 'the first payment is on the day the trial ends, not later');
  assert.match(app.banner, /days you have left are added to your plan/);
});

test('Free trial: someone who already subscribed during the trial cannot subscribe again and sees when the first payment is taken', async () => {
  const app = await boot({ country: 'DE', rails: { razorpay_usd: true }, access: { status: 'trialing', days_left: 5, has_access: true, plan: 'pro', trial_ends_at: '2026-11-23T12:00:00.000Z', trial_subscribed: true } });
  assert.doesNotMatch(app.page, /data-plan=/);
  assert.match(app.page, /<button class="btn wide" disabled>Subscribed<\/button>/);
  assert.match(app.page, /first payment of \$5 is taken then/);
  assert.match(app.banner, /you are subscribed, first payment on/);
  assert.doesNotMatch(app.banner, /Subscribe any time/);
});
