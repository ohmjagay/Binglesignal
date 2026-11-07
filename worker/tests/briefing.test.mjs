import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';
import worker from '../src/index.js';
import { rankEdition } from '../src/briefing.js';
import { calculateWeights } from '../../scripts/learn-weights.mjs';

const userId = 'aaaaaaaa-0000-0000-0000-000000000001';
const session = `header.${Buffer.from(JSON.stringify({ sub: userId, aal: 'aal1' })).toString('base64url')}.signature`;
const baseEnv = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
};
const json = (body, status = 200) => Response.json(body, { status });
const get = (path) => new Request(`https://binglesignal.com${path}`, { headers: { authorization: `Bearer ${session}` } });
const post = (path, body) => new Request(`https://binglesignal.com${path}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function installFetch(context, responder) {
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  globalThis.fetch = responder;
}

test('edition ranking prioritizes a watchlist hit, scores explainably, and limits Lite length', () => {
  const stories = Array.from({ length: 14 }, (_, index) => ({
    story_id: `story${index}`,
    stories: [{
      id: `item${index}`, t: `Story title ${index}`, u: `https://news.example/${index}`,
      s: 'Source', k: ['business'], g: ['IN'], embedding: [index === 0 ? 1 : 0, index === 1 ? 1 : 0],
    }],
    embedding: [index === 0 ? 1 : 0, index === 1 ? 1 : 0],
    source_tier: index === 2 ? 1 : 3,
    source_count: index === 2 ? 4 : 1,
    published_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 864e5).toISOString(),
  }));
  const notes = new Map(stories.map((story, index) => [story.story_id, {
    headline: `Story title ${index}`,
    summary: index === 0 ? 'Acme announces a new product.' : 'Business update.',
    why_it_matters: 'A grounded generic note.',
    category: 'business',
  }]));
  const ranked = rankEdition(stories, notes, { interests: ['business'], region: 'IN' },
    [{ kind: 'company', term: 'Acme' }], [], 'lite');
  assert.equal(ranked.items.length, 10);
  assert.equal(ranked.items[0].c, 'story0');
  assert.match(ranked.items[0].why_ranked_here, /Watchlist match/);
  assert.equal(ranked.safely_ignore.length, 3);
});

test('weekly preference learning weights recent feedback without exposing user content', () => {
  const now = Date.parse('2026-01-15T00:00:00Z');
  const categories = new Map([['liked-story', 'business'], ['skipped-story', 'business'], ['stale-story', 'markets']]);
  const weights = calculateWeights([
    { story_id: 'liked-story', signal: 'like', created_at: new Date(now).toISOString() },
    { story_id: 'skipped-story', signal: 'skip', created_at: new Date(now).toISOString() },
    { story_id: 'stale-story', signal: 'like', created_at: new Date(now - 31 * 864e5).toISOString() },
  ], categories, { policy: 0.4 }, now);
  assert.equal(weights.business, 0.075);
  assert.equal(weights.markets, undefined);
  assert.equal(weights.policy, 0.4);
});

test('pool is only served to an active account and filters subscription by user_id', async (context) => {
  const calls = [];
  installFetch(context, async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname === '/auth/v1/user') return json({ id: userId });
    if (url.pathname.endsWith('/subscriptions')) return json([{ plan: 'lite', status: 'active' }]);
    if (url.pathname.endsWith('/story_clusters')) return json([{
      story_id: 'story-1',
      stories: [{ id: 'item-1', t: 'Headline', u: 'https://news.example/item', k: ['business'] }],
      embedding: [1, 0], source_tier: 1, source_count: 2,
      published_at: new Date().toISOString(), expires_at: new Date(Date.now() + 864e5).toISOString(),
    }]);
    if (url.pathname.endsWith('/story_notes')) return json([{ story_id: 'story-1', headline: 'Headline', summary: 'Short summary.' }]);
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const response = await worker.fetch(get('/api/pool'), baseEnv);
  const pool = await response.json();
  assert.equal(response.status, 200);
  assert.equal(pool.items[0].summary, 'Short summary.');
  assert.ok(calls.find((url) => url.pathname.endsWith('/subscriptions')).searchParams.get('user_id') === `eq.${userId}`);
});

test('latest edition and feedback only read/write data for the signed-in user', async (context) => {
  const calls = [];
  installFetch(context, async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url.pathname === '/auth/v1/user') return json({ id: userId });
    if (url.pathname.endsWith('/subscriptions')) return json([{ plan: 'pro', status: 'active' }]);
    if (url.pathname.endsWith('/editions')) return json([]);
    if (url.pathname.endsWith('/feedback')) return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/events')) return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const latest = await worker.fetch(get('/api/edition/latest'), baseEnv);
  assert.deepEqual(await latest.json(), { edition: null });
  const feedback = await worker.fetch(post('/api/feedback', { story_id: 'story123', signal: 'like' }), baseEnv);
  assert.equal(feedback.status, 200);
  const editionRead = calls.find(({ url }) => url.pathname.endsWith('/editions'));
  const feedbackWrite = calls.find(({ url }) => url.pathname.endsWith('/feedback'));
  assert.equal(editionRead.url.searchParams.get('user_id'), `eq.${userId}`);
  assert.equal(feedbackWrite.body.user_id, userId);
  assert.equal(feedbackWrite.url.searchParams.get('on_conflict'), 'user_id,story_id,signal');
  const feedbackEvent = calls.find(({ url }) => url.pathname.endsWith('/events'));
  assert.equal(feedbackEvent.body.user_id, userId);
  assert.deepEqual(feedbackEvent.body.props, { signal: 'like' });
});

test('edition open and completion metrics call a user-scoped idempotent database function', async (context) => {
  const calls = [];
  installFetch(context, async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url.pathname === '/auth/v1/user') return json({ id: userId });
    if (url.pathname.endsWith('/subscriptions')) return json([{ plan: 'pro', status: 'active' }]);
    if (url.pathname.endsWith('/editions')) return json([{
      slot_key: `${userId}:2026-11-02:0700`, user_id: userId, opened_at: null,
    }]);
    if (url.pathname.endsWith('/record_edition_event')) return json(true);
    if (url.pathname.endsWith('/user_metrics')) return json([{ completed_editions: 2, time_saved_minutes: 6 }]);
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const latest = await worker.fetch(get('/api/edition/latest'), baseEnv);
  assert.ok((await latest.json()).edition.opened_at);
  const opened = calls.find(({ url }) => url.pathname.endsWith('/record_edition_event'));
  assert.equal(opened.body.p_user_id, userId);
  assert.equal(opened.body.p_event_name, 'edition_opened');

  const completed = await worker.fetch(post('/api/edition/event', {
    slot_key: `${userId}:2026-11-02:0700`, event_name: 'edition_completed',
  }), baseEnv);
  assert.equal(completed.status, 200);
  const metrics = await worker.fetch(get('/api/metrics'), baseEnv);
  assert.deepEqual(await metrics.json(), { metrics: { completed_editions: 2, time_saved_minutes: 6 } });
  const metricsRead = calls.find(({ url }) => url.pathname.endsWith('/user_metrics'));
  assert.equal(metricsRead.url.searchParams.get('user_id'), `eq.${userId}`);
});

test('invalid feedback does not write, and unauthenticated pool access is rejected', async (context) => {
  let writes = 0;
  installFetch(context, async (input) => {
    const url = new URL(input);
    if (url.pathname === '/auth/v1/user') return json({ id: userId });
    if (url.pathname.endsWith('/subscriptions')) return json([{ plan: 'lite', status: 'active' }]);
    writes++;
    return new Response(null, { status: 204 });
  });
  assert.equal((await worker.fetch(post('/api/feedback', { story_id: 'not valid', signal: 'like' }), baseEnv)).status, 400);
  assert.equal(writes, 0);
  const privateResponse = await worker.fetch(new Request('https://binglesignal.com/api/pool'), baseEnv);
  assert.equal(privateResponse.status, 401);
});

test('profile and watchlist endpoints validate writes and scope user-owned records', async (context) => {
  const calls = [];
  installFetch(context, async (input, init = {}) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    if (url.pathname === '/auth/v1/user') return json({ id: userId });
    if (url.pathname.endsWith('/subscriptions')) return json([{ plan: 'lite', status: 'active' }]);
    if (url.pathname.endsWith('/user_profile_v2')) return json(body ? [body] : []);
    if (url.pathname.endsWith('/watchlists')) {
      if (init.method === 'POST') return json([{ id: 21, ...body }]);
      return json([{ id: 21, kind: 'company', term: 'Acme' }]);
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const profile = {
    role: 'product', industry: 'software', region: 'US', timezone: 'America/New_York',
    delivery_time: '07:15', delivery_channel: 'app', brief_length: 10,
    interests: ['ai'], blocked_topics: [], muted_sources: [],
  };
  const profileRead = await worker.fetch(get('/api/profile'), baseEnv);
  const profileResult = await profileRead.json();
  assert.equal(profileResult.profile?.role, 'other', JSON.stringify(profileResult));
  const invalidProfile = { ...profile, timezone: 'not/a-timezone' };
  assert.equal((await worker.fetch(new Request(post('/api/profile', invalidProfile), { method: 'PUT' }), baseEnv)).status, 400);
  const profileWriteRequest = new Request(post('/api/profile', profile), { method: 'PUT' });
  assert.equal((await worker.fetch(profileWriteRequest, baseEnv)).status, 200);
  const watchlistRead = await worker.fetch(get('/api/watchlist'), baseEnv);
  assert.equal((await watchlistRead.json()).limit, 10);
  assert.equal((await worker.fetch(post('/api/watchlist', { kind: 'company', term: 'A' }), baseEnv)).status, 400);
  assert.equal((await worker.fetch(post('/api/watchlist', { kind: 'company', term: 'Northstar' }), baseEnv)).status, 200);
  const deleteWatch = await worker.fetch(new Request(get('/api/watchlist?id=21'), { method: 'DELETE' }), baseEnv);
  assert.equal(deleteWatch.status, 200);
  const ownedReads = calls.filter(({ url, init }) =>
    ['GET', 'DELETE'].includes(init.method || 'GET') &&
    (url.pathname.endsWith('/user_profile_v2') || url.pathname.endsWith('/watchlists') || url.pathname.endsWith('/subscriptions')));
  assert.ok(ownedReads.length >= 4);
  assert.ok(ownedReads.every(({ url }) => url.searchParams.get('user_id') === `eq.${userId}`));
  assert.equal(calls.find(({ url, init }) =>
    url.pathname.endsWith('/user_profile_v2') && init.method === 'POST').body.user_id, userId);
  assert.equal(calls.find(({ url, init }) =>
    url.pathname.endsWith('/watchlists') && init.method === 'POST').body.user_id, userId);
  assert.equal(calls.find(({ url, init }) =>
    url.pathname.endsWith('/watchlists') && init.method === 'DELETE').url.searchParams.get('user_id'), `eq.${userId}`);
});

test('briefing migration keeps all new story and user tables RLS-enabled and server-only', async () => {
  const migration = await readFile(new URL('../../supabase/007_briefing_v2.sql', import.meta.url), 'utf8');
  for (const table of ['story_clusters', 'user_profile_v2', 'editions', 'feedback']) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, 'i'));
  }
  assert.match(migration, /where e\.slot_key = d\.user_id::text/i);
  const workflow = await readFile(new URL('../../.github/workflows/refresh-briefing.yml', import.meta.url), 'utf8');
  assert.match(workflow, /SUPABASE_SERVICE_ROLE_KEY:\s+\$\{\{\s*secrets\.SUPABASE_SERVICE_ROLE_KEY\s*\}\}/);
  assert.doesNotMatch(workflow, /git add public\/pool\.json/);
  await assert.rejects(access(new URL('../../public/pool.json', import.meta.url)));
});
