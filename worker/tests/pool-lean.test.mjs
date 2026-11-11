// Covers the READ/WATCH "server error" fix: missing Worker settings now give a clear 503 (never a crash),
// and /api/pool is small, cached and fail-soft.
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';
import { leanPool, POOL_LIMITS } from '../src/briefing.js';
import { missingSupabaseConfig, supabaseKeyHeaders } from '../src/supabase.js';

const userId = 'aaaaaaaa-0000-0000-0000-000000000001';
const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' };
const json = (body, status = 200) => Response.json(body, { status });
const get = (path) => new Request(`https://binglesignal.com${path}`, { headers: { authorization: 'Bearer user-token' } });
const vec = (n = 384) => Array.from({ length: n }, (_, i) => Math.sin(i + 1) * 0.0912345678901234);
const now = () => new Date().toISOString(), later = () => new Date(Date.now() + 864e5).toISOString();

function useFetch(context, responder) {
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  globalThis.fetch = responder;
}
function useCache(context) {
  const original = globalThis.caches, store = new Map();
  context.after(() => { globalThis.caches = original; });
  globalThis.caches = { default: {
    match: async (key) => { const hit = store.get(key.url); return hit ? hit.clone() : undefined; },
    put: async (key, response) => { store.set(key.url, response); },
  } };
  return store;
}

test('missingSupabaseConfig names what is missing and catches a badly typed URL', () => {
  assert.deepEqual(missingSupabaseConfig({}), ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
  assert.deepEqual(missingSupabaseConfig(env), []);
  assert.deepEqual(missingSupabaseConfig({ ...env, SUPABASE_URL: 'project.supabase.co' }), ['SUPABASE_URL']);   // no https://
  assert.deepEqual(missingSupabaseConfig({ ...env, SUPABASE_URL: 'https://project.supabase.co/' }), ['SUPABASE_URL']); // trailing slash
});

test('READ/WATCH with missing Worker settings answers 503 with a clear log, not a 500 crash', async (context) => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  context.after(() => { console.error = originalError; });
  useFetch(context, async () => { throw new Error('must not call Supabase when it is not configured'); });
  const response = await worker.fetch(get('/api/pool'), { SUPABASE_ANON_KEY: 'anon' });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /being set up/);
  assert.match(errors.join('\n'), /missing or invalid SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/);
});

test('teaser without SUPABASE_URL, or when Supabase cannot be reached, answers 503 (the page then uses feed.json)', async (context) => {
  const originalError = console.error;
  console.error = () => {};
  context.after(() => { console.error = originalError; });
  assert.equal((await worker.fetch(new Request('https://binglesignal.com/api/teaser'), { SUPABASE_SERVICE_ROLE_KEY: 'service' })).status, 503);
  useFetch(context, async () => { throw new TypeError('network down'); });
  assert.equal((await worker.fetch(new Request('https://binglesignal.com/api/teaser'), env)).status, 503);
});

test('health tells you which Supabase settings the Worker can see, as true/false only', async () => {
  const ok = await (await worker.fetch(new Request('https://binglesignal.com/api/health'), env)).json();
  assert.deepEqual(ok.supabase, { url: true, anon_key: true, service_key: true });
  const partial = await (await worker.fetch(new Request('https://binglesignal.com/api/health'), { SUPABASE_URL: 'https://project.supabase.co' })).json();
  assert.deepEqual(partial.supabase, { url: true, anon_key: false, service_key: false });
  assert.equal(JSON.stringify(ok).includes('service'), true);       // the flag name is fine...
  assert.equal(JSON.stringify(ok).includes('SUPABASE'), false);     // ...and no value or setting name is echoed back
});

test('leanPool sends each meaning-vector once, rounded, never inside the articles, and respects the caps', () => {
  const clusters = [
    { story_id: 'a', source_count: 2, source_tier: 2, embedding: vec(), stories: [
      { id: 'a1', t: 'First', u: 'https://x/1', embedding: vec() }, { id: 'a2', t: 'Second', u: 'https://x/2', embedding: vec() }] },
    { story_id: 'v', source_count: 1, source_tier: 4, embedding: null, stories: [{ id: 'v1', t: 'Video', u: 'https://y/1', v: 1, vid: 'abc' }] },
  ];
  const { items, vectors } = leanPool(clusters, new Map([['a', { headline: 'Noted', summary: 'Sum', why_it_matters: 'Why' }]]));
  assert.equal(items.length, 3);
  assert.equal(items.every((item) => !('embedding' in item)), true);
  assert.deepEqual(Object.keys(vectors), ['a']);
  assert.equal(vectors.a.length, 384);
  assert.equal(vectors.a.every((x) => Math.abs(x * 1000 - Math.round(x * 1000)) < 1e-9), true); // 3 decimals
  assert.equal(items[0].summary, 'Sum');
  assert.equal(items[2].headline, 'Video');                                                       // no note: falls back to the title

  const many = Array.from({ length: POOL_LIMITS.articles + 50 }, (_, i) => ({ story_id: `r${i}`, source_count: 1, source_tier: 3, embedding: [0.5], stories: [{ id: `r${i}`, t: 'T', u: 'https://x' }] }))
    .concat(Array.from({ length: POOL_LIMITS.videos + 50 }, (_, i) => ({ story_id: `w${i}`, source_count: 1, source_tier: 4, stories: [{ id: `w${i}`, t: 'V', u: 'https://y', v: 1, vid: 'q' }] })));
  const capped = leanPool(many, new Map()).items;
  assert.equal(capped.filter((item) => !item.v).length, POOL_LIMITS.articles);
  assert.equal(capped.filter((item) => item.v).length, POOL_LIMITS.videos);
});

test('/api/pool asks for videos separately, merges without duplicates, and is cached for the next reader', async (context) => {
  const store = useCache(context);
  const calls = { clusters: [], upstream: 0 };
  const article = { story_id: 'a', source_tier: 2, source_count: 1, embedding: vec(), published_at: now(), expires_at: later(), stories: [{ id: 'a1', t: 'Article', u: 'https://x/1', embedding: vec() }] };
  const video = { story_id: 'v', source_tier: 4, source_count: 1, embedding: null, published_at: new Date(Date.now() - 36e5).toISOString(), expires_at: later(), stories: [{ id: 'v1', t: 'Video', u: 'https://y/1', v: 1, vid: 'abc' }] };
  useFetch(context, async (input) => {
    const url = new URL(input);
    if (url.pathname === '/auth/v1/user') return json({ id: userId });
    calls.upstream++;
    if (url.pathname.endsWith('/subscriptions')) return json([{ plan: 'pro', status: 'active' }]);
    if (url.pathname.endsWith('/story_clusters')) {
      calls.clusters.push(url);
      return json(url.searchParams.get('stories->0->>v') === 'eq.1' ? [video] : [article, video]);   // the video also appears in the newest rows
    }
    if (url.pathname.endsWith('/story_notes')) return json([{ story_id: 'a', headline: 'Article', summary: 'Summary.' }]);
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const first = await worker.fetch(get('/api/pool'), env);
  const pool = await first.json();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(pool.items.map((item) => item.id).sort(), ['a1', 'v1']);       // video not duplicated
  assert.equal(pool.items.find((item) => item.id === 'a1').summary, 'Summary.');
  assert.deepEqual(Object.keys(pool.vectors), ['a']);
  assert.equal(calls.clusters.length, 2);
  assert.equal(store.size, 1);

  const before = calls.upstream;
  const second = await worker.fetch(get('/api/pool'), env);                       // served from the edge cache
  assert.equal((await second.json()).items.length, 2);
  assert.equal(calls.upstream - before, 1);                                       // only the plan check (sign-in is not counted here); no story queries
});

test('/api/pool keeps working if the separate video query is rejected, and never caches an empty pool', async (context) => {
  const store = useCache(context);
  const originalWarn = console.warn;
  console.warn = () => {};
  context.after(() => { console.warn = originalWarn; });
  useFetch(context, async (input) => {
    const url = new URL(input);
    if (url.pathname === '/auth/v1/user') return json({ id: userId });
    if (url.pathname.endsWith('/subscriptions')) return json([{ plan: 'lite', status: 'active' }]);
    if (url.pathname.endsWith('/story_clusters')) return url.searchParams.has('stories->0->>v') ? json({ message: 'bad filter' }, 400) : json([]);
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const response = await worker.fetch(get('/api/pool'), env);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).items, []);
  assert.equal(store.size, 0);
});

test('/api/pool answers 503 with a friendly message when Supabase fails', async (context) => {
  const originalError = console.error;
  console.error = () => {};
  context.after(() => { console.error = originalError; });
  useFetch(context, async (input) => {
    const url = new URL(input);
    if (url.pathname === '/auth/v1/user') return json({ id: userId });
    if (url.pathname.endsWith('/subscriptions')) return json([{ plan: 'pro', status: 'active' }]);
    return json({ message: 'down' }, 500);
  });
  const response = await worker.fetch(get('/api/pool'), env);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /refreshing/);
});

test('Supabase keys: legacy JWT keys keep the Bearer header, new sb_secret_ keys are sent in apikey only', () => {
  assert.deepEqual(supabaseKeyHeaders('eyJhbGciOi.payload.sig'), { apikey: 'eyJhbGciOi.payload.sig', authorization: 'Bearer eyJhbGciOi.payload.sig' });
  assert.deepEqual(supabaseKeyHeaders('sb_secret_abc123'), { apikey: 'sb_secret_abc123' });
  assert.deepEqual(supabaseKeyHeaders('sb_publishable_abc123'), { apikey: 'sb_publishable_abc123' });
});
