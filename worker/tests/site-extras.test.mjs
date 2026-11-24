import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { teaserItems, addTeaserSummaries, cleanWhy } from '../src/index.js';
import { parseQuote, MARKETS } from '../src/markets.js';
import { renderSeoNews } from '../src/home.js';
import { leanPool } from '../src/briefing.js';

const env = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' };
const get = (path, headers = {}) => new Request('https://binglesignal.com' + path, { headers });
const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

// ---------- markets ----------
const yahoo = (price, previous) => ({ chart: { result: [{ meta: { regularMarketPrice: price, chartPreviousClose: previous } }], error: null } });

test('A market quote is read from the feed, and a broken reply is never shown', () => {
  const q = parseQuote({ id: 'sensex', name: 'Sensex', region: 'IN' }, yahoo(84000, 83500));
  assert.equal(q.name, 'Sensex');
  assert.equal(q.price, 84000);
  assert.ok(Math.abs(q.pct - 0.5988) < 0.001);
  assert.equal(parseQuote({ id: 'x', name: 'X' }, { chart: { result: null } }), null);
  assert.equal(parseQuote({ id: 'x', name: 'X' }, yahoo(0, 10)), null);
  assert.equal(parseQuote({ id: 'x', name: 'X' }, yahoo('abc', 10)), null);
  assert.equal(parseQuote({ id: 'x', name: 'X' }, null), null);
  assert.ok(MARKETS.some((m) => m.name === 'Sensex') && MARKETS.some((m) => m.name === 'Nifty 50') && MARKETS.some((m) => m.name === 'Nasdaq'));
});

test('GET /api/markets returns the index numbers, and 503 (so the page hides the panel) when the feed is down', async () => {
  globalThis.fetch = async (url) => Response.json(yahoo(100 + String(url).length, 99));
  const res = await worker.fetch(get('/api/markets'), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /max-age=300/);
  const body = await res.json();
  assert.equal(body.items.length, MARKETS.length);
  assert.equal(body.source, 'Yahoo Finance');
  globalThis.fetch = async () => new Response('blocked', { status: 429 });
  assert.equal((await worker.fetch(get('/api/markets'), env)).status, 503);
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal((await worker.fetch(get('/api/markets'), env)).status, 503);
});

// ---------- logos ----------
test('GET /api/logo passes on a real picture, and nothing else', async () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(String(url)); return new Response(png, { headers: { 'content-type': 'image/png' } }); };
  const ok = await worker.fetch(get('/api/logo?d=www.Reuters.com'), env);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.match(ok.headers.get('cache-control'), /max-age=2592000/);
  assert.equal(seen[0], 'https://icons.duckduckgo.com/ip3/reuters.com.ico', 'www. is dropped and only the icon service is contacted');
  for (const bad of ['', 'localhost', '../etc/passwd', 'a b.com', 'x'.repeat(90) + '.com', 'https://evil.com']) {
    assert.equal((await worker.fetch(get('/api/logo?d=' + encodeURIComponent(bad)), env)).status, 400, bad);
  }
  globalThis.fetch = async () => new Response('<svg onload="alert(1)"/>', { headers: { 'content-type': 'image/svg+xml' } });
  assert.equal((await worker.fetch(get('/api/logo?d=evil.com'), env)).status, 404, 'SVG can carry scripts: never passed on');
  globalThis.fetch = async () => new Response('nope', { status: 404 });
  assert.equal((await worker.fetch(get('/api/logo?d=nothing.com'), env)).status, 404);
  globalThis.fetch = async () => new Response(new Uint8Array(70000), { headers: { 'content-type': 'image/png' } });
  assert.equal((await worker.fetch(get('/api/logo?d=huge.com'), env)).status, 404, 'huge files are refused');
});

// ---------- pre-rendered homepage ----------
const PAGE = '<!doctype html><html><body><main><!--SEO-NEWS--></main></body></html>';
const cluster = (id, title, source, url, extra = {}) => ({
  story_id: id, source_count: extra.count ?? 3,
  stories: [{ id: 'story-' + id, t: title, u: url, s: source, d: 1793000000, k: ['business'], g: extra.g || [], q: extra.q ?? 0.8, ...(extra.story || {}) }],
});

test('The homepage is served with the top headlines already in its HTML, and is never broken by a failure', async () => {
  const assets = { fetch: async () => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }) };
  globalThis.fetch = async (url) => (String(url).includes('story_clusters') ? Response.json([cluster('a', 'Fed holds rates as inflation cools', 'Reuters', 'https://www.reuters.com/a'),
    cluster('b', 'Pay <script>alert(1)</script> now', 'Mint', 'https://www.livemint.com/b', { q: 0.5 })]) : new Response('[]'));
  const res = await worker.fetch(get('/'), { ...env, ASSETS: assets });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /id="seo-news"/);
  assert.match(html, /Fed Holds Rates as Inflation Cools/);
  assert.match(html, /href="https:\/\/www\.reuters\.com\/a"/);
  assert.doesNotMatch(html, /<script>alert/, 'headline text is escaped');
  assert.match(html, /application\/ld\+json/);
  assert.doesNotMatch(html, /<!--SEO-NEWS-->/);
  // the data is down: the plain page comes back untouched
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  const plain = await worker.fetch(get('/'), { ...env, ASSETS: assets });
  assert.equal(plain.status, 200);
  assert.equal(await plain.text(), PAGE);
  // not HTML, or a failed asset: passed through
  const notFound = await worker.fetch(get('/'), { ...env, ASSETS: { fetch: async () => new Response('missing', { status: 404 }) } });
  assert.equal(notFound.status, 404);
  assert.equal(renderSeoNews([]), '');
  assert.equal(renderSeoNews([{ t: 'No link', u: 'javascript:alert(1)', s: 'X' }]), '', 'unsafe links are never written into the page');
});

// ---------- friendly "not found" ----------
test('A wrong link shows a friendly page to people and {"error":"not found"} only to programs', async () => {
  const browser = await worker.fetch(get('/api/nothing-here', { accept: 'text/html,application/xhtml+xml' }), env);
  assert.equal(browser.status, 404);
  assert.match(browser.headers.get('content-type'), /text\/html/);
  assert.match(await browser.text(), /We could not find that page/);
  const program = await worker.fetch(get('/api/nothing-here', { accept: 'application/json' }), env);
  assert.equal(program.status, 404);
  assert.deepEqual(await program.json(), { error: 'not found' });
  const withPage = await worker.fetch(get('/api/nothing-here', { accept: 'text/html' }), { ...env, ASSETS: { fetch: async () => new Response('<h1>Our 404</h1>', { status: 200 }) } });
  assert.equal(withPage.status, 404, 'the real 404.html is shown but still with a 404 status');
  assert.equal(await withPage.text(), '<h1>Our 404</h1>');
});

// ---------- the teaser ----------
test('The teaser puts trusted outlets first, keeps direct links, fixes the country and hides repeats and unknown one-off sites', () => {
  const google = 'https://news.google.com/rss/articles/CBMiabc?oc=5';
  const items = teaserItems([
    cluster('arch', 'Judge blocks construction of Trump’s massive arch', 'The Times of India', 'https://timesofindia.indiatimes.com/arch', { g: ['IN'], q: 0.9, story: { k: ['law', 'india'], tr: 0.75 } }),
    cluster('rbi', 'RBI keeps repo rate unchanged', 'Mint', 'https://www.livemint.com/rbi', { g: ['IN'], q: 0.8, story: { k: ['markets', 'india'], tr: 0.85 } }),
    cluster('junk', 'Cabinet approves a plan', 'Some Random Blog', 'https://random-blog.example/cabinet', { count: 1, q: 0.95 }),
    cluster('farm', 'Big news from a content farm', 'Devdiscourse', 'https://devdiscourse.example/news', { q: 0.99 }),
    cluster('deal', 'Best phone deals: 40% off today', 'Gadget Site', 'https://gadgets.example/deals', { q: 0.97 }),
    cluster('rbi-copy', 'RBI keeps the repo rate unchanged', 'Mint Markets', 'https://www.livemint.com/rbi-2', { g: ['IN'], q: 0.7, story: { k: ['markets', 'india'] } }),
    { story_id: 'two', source_count: 4, stories: [
      { id: 'g', t: 'Tesla recalls cars over software fault', u: google, s: 'Reuters', d: 1793000000, k: ['auto'], q: 0.6 },
      { id: 'd', t: 'Tesla recalls cars over software fault', u: 'https://www.bbc.com/news/tesla', s: 'BBC News', d: 1792999000, k: ['auto'], q: 0.6 },
    ] },
  ]);
  const ids = items.map((i) => i.c);
  assert.deepEqual(ids.slice(0, 2), ['arch', 'rbi'].sort((a, b) => ids.indexOf(a) - ids.indexOf(b)));
  assert.ok(!ids.includes('junk'), 'an unknown website on its own is never put on the front page');
  assert.ok(!ids.includes('farm'), 'content farms are blocked');
  assert.ok(!ids.includes('deal'), 'shopping deals are removed');
  assert.ok(!ids.includes('rbi-copy'), 'the same story from a second cluster is shown once');
  assert.equal(items.find((i) => i.c === 'two').u, 'https://www.bbc.com/news/tesla', 'a direct link is chosen over a Google link');
  const arch = items.find((i) => i.c === 'arch');
  assert.equal(arch.r, 'US', 'a US story from an Indian outlet is not marked India');
  assert.equal(arch.t, 'Judge Blocks Construction of Trump’s Massive Arch');
  assert.equal(items.find((i) => i.c === 'rbi').r, 'IN');
  assert.equal(arch.lg, 'timesofindia.indiatimes.com');
});

test('The free top story gets its "why it matters" line from the AI note', () => {
  const items = [{ c: 'a', t: 'A' }, { c: 'b', t: 'B' }, { c: 'c', t: 'C' }];
  const out = addTeaserSummaries(items, [
    { story_id: 'a', summary: 'The central bank held rates steady on Friday. Inflation eased to 4.2 percent. Markets rose.', why_it_matters: 'Cheaper loans stay a few months away for borrowers.' },
    { story_id: 'b', summary: '', why_it_matters: 'Short but useful line for readers.' },
    { story_id: 'c', summary: '', why_it_matters: '' },
  ]);
  assert.match(out[0].y, /central bank held rates/);
  assert.equal(out[0].w, 'Cheaper loans stay a few months away for borrowers.');
  assert.equal(out[1].w, 'Short but useful line for readers.');
  assert.equal('y' in out[1], false);
  assert.deepEqual(out[2], { c: 'c', t: 'C' });
  assert.equal(cleanWhy('too short'), '');
  assert.ok(cleanWhy('x'.repeat(400)).length <= 240);
});

// ---------- the paid READ list ----------
test('The READ list is cleaned too: junk removed, country fixed, one headline style', () => {
  const row = (id, stories) => ({ story_id: id, source_count: 2, source_tier: 2, stories, embedding: [0.1, 0.2] });
  const { items } = leanPool([
    row('c1', [{ id: 'a', t: 'Best laptop deals: 40% off', u: 'https://x.example/a', s: 'Shop', d: 1, k: ['tech'] }]),
    row('c2', [{ id: 'b', t: 'judge blocks trump arch', u: 'https://timesofindia.indiatimes.com/b', s: 'The Times of India', d: 1, k: ['law', 'india'], g: ['IN'] }]),
    row('c3', [{ id: 'v', t: 'channel video title in its OWN style', u: 'https://youtube.com/watch?v=1', s: 'Channel', d: 1, k: ['tech'], v: 1, vid: '1' }]),
  ], new Map());
  assert.equal(items.length, 2);
  const arch = items.find((i) => i.id === 'b');
  assert.equal(arch.t, 'Judge Blocks Trump Arch');
  assert.deepEqual(arch.g, ['US']);
  assert.deepEqual(arch.k, ['law']);
  assert.equal(items.find((i) => i.id === 'v').t, 'channel video title in its OWN style', 'video titles keep the channel’s own style');
});
