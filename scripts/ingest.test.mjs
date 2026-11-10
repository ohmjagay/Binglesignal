// End-to-end check of the ingest pipeline with every network call faked.
// The scenario that matters most: DeepSeek is unavailable (empty balance, no key) and the feed must STILL be published.
import test from 'node:test';
import assert from 'node:assert/strict';

const SUPABASE = 'https://proj.supabase.co';
const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'DEEPSEEK_API_KEY',
  'MAX_NEW_NOTES', 'DEEP_SUMMARY_TOP', 'MAX_VIDEO_NOTES', 'YOUTUBE_API_KEY'];

const article = `<html><body><article>${[1, 2, 3].map((n) => `<p>Paragraph ${n} of the full article text, long enough to count as real reporting for the summary step.</p>`).join('')}</article></body></html>`;

async function runIngest(label, { deepseek, key = 'test-key' }) {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((name) => [name, process.env[name]]));
  const savedFetch = globalThis.fetch, savedLog = console.log, savedError = console.error;
  Object.assign(process.env, {
    SUPABASE_URL: SUPABASE, SUPABASE_SERVICE_ROLE_KEY: 'service', CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'cf',
    MAX_NEW_NOTES: '10', DEEP_SUMMARY_TOP: '3', MAX_VIDEO_NOTES: '2',
  });
  delete process.env.YOUTUBE_API_KEY;
  if (key) process.env.DEEPSEEK_API_KEY = key; else delete process.env.DEEPSEEK_API_KEY;

  const posts = [], deepseekRequests = [], errors = [];
  let counter = 0;
  const now = new Date();
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('https://api.deepseek.com/')) {
      const body = JSON.parse(init.body);
      deepseekRequests.push(body);
      return deepseek(body);
    }
    if (url.includes('hn.algolia.com')) return Response.json({ hits: [] });
    if (url.includes('api.cloudflare.com')) {
      const { text } = JSON.parse(init.body);
      return Response.json({ success: true, result: { data: text.map((_, i) => Array.from({ length: 8 }, (__, j) => ((i + j) % 5) / 10 + 0.1)) } });
    }
    if (url.startsWith(SUPABASE)) {
      const method = init.method || 'GET';
      if (method === 'GET') return new Response('[]', { status: 200 });
      posts.push({ method, path: url.slice(SUPABASE.length), body: init.body ? JSON.parse(init.body) : null });
      return new Response('', { status: 201 });
    }
    if (url.startsWith('https://news.example/')) return new Response(article, { headers: { 'content-type': 'text/html' } });
    counter++;
    if (url.includes('youtube.com/feeds')) {
      return new Response(`<feed><entry><title>Video ${counter}vid explained</title><link href="https://www.youtube.com/watch?v=VID${counter}"/><published>${now.toISOString()}</published><yt:videoId>VID${counter}</yt:videoId><media:group><media:description>A long description of video ${counter}vid that explains what it covers in some detail.</media:description><media:statistics views="12345"/></media:group></entry></feed>`);
    }
    const items = [0, 1].map((n) => `<item><title>story${counter}x${n}alpha story${counter}x${n}beta story${counter}x${n}gamma</title><link>https://news.example/${counter}-${n}</link><pubDate>${now.toUTCString()}</pubDate><description>Excerpt for story ${counter}x${n} with enough length to be kept as the excerpt text.</description></item>`);
    return new Response(`<?xml version="1.0"?><rss><channel>${items.join('')}</channel></rss>`);
  };
  console.log = () => {};
  console.error = (...args) => errors.push(args.join(' '));
  process.exitCode = 0;
  try {
    await import(`./ingest.mjs?scenario=${label}`);
    return { posts, deepseekRequests, errors, exitCode: process.exitCode };
  } finally {
    process.exitCode = 0;
    globalThis.fetch = savedFetch; console.log = savedLog; console.error = savedError;
    for (const name of ENV_KEYS) { if (savedEnv[name] === undefined) delete process.env[name]; else process.env[name] = savedEnv[name]; }
  }
}

const notePosts = (run) => run.posts.filter((post) => post.path.startsWith('/rest/v1/story_notes?'));
const clusterPosts = (run) => run.posts.filter((post) => post.path.startsWith('/rest/v1/story_clusters?on_conflict'));

test('Empty DeepSeek balance (402): the feed is still published, the AI stops after one batch, and the run turns red', async () => {
  const run = await runIngest('empty-balance', { deepseek: () => Response.json({ error: { message: 'Insufficient Balance' } }, { status: 402 }) });
  assert.ok(clusterPosts(run).length > 0, 'story clusters must still be published');
  assert.ok(clusterPosts(run)[0].body.length > 50);
  assert.equal(notePosts(run).length, 0);
  assert.ok(run.deepseekRequests.length >= 1 && run.deepseekRequests.length <= 8, `AI calls stopped early (made ${run.deepseekRequests.length})`);
  assert.equal(run.exitCode, 1);
  assert.ok(run.errors.some((line) => /AI notes stopped: DeepSeek balance is empty/.test(line)));
});

test('No DeepSeek key: nothing is sent to DeepSeek, the feed is still published, and the run turns red', async () => {
  const run = await runIngest('no-key', { key: '', deepseek: () => { throw new Error('must not be called'); } });
  assert.ok(clusterPosts(run).length > 0);
  assert.equal(run.deepseekRequests.length, 0);
  assert.equal(notePosts(run).length, 0);
  assert.equal(run.exitCode, 1);
  assert.ok(run.errors.some((line) => /DEEPSEEK_API_KEY is not set/.test(line)));
});

test('Working DeepSeek: top stories are summarized from article text, others from excerpts, videos get watch notes', async () => {
  const run = await runIngest('working', {
    deepseek: (body) => {
      const sources = JSON.parse(body.messages[1].content);
      const video = /watch notes/.test(body.messages[0].content);
      return Response.json({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
          headline: video ? 'A video' : 'A story', summary: video ? 'It explains the topic.' : 'What happened and who is involved.',
          why_it_matters: video ? 'Watch if you follow the topic.' : 'It moves markets.', category: 'tech', entities: ['Example'],
          confidence: 0.8, source_ids: [sources[0].id],
        }) } }],
        usage: { prompt_tokens: 300, completion_tokens: 60 },
      });
    },
  });
  assert.equal(run.exitCode, 0);
  const notes = notePosts(run).flatMap((post) => post.body);
  assert.equal(notes.length, 12, 'ten read notes plus two video notes');
  for (const note of notes) {
    assert.ok(note.story_id && note.headline && note.summary && note.why_it_matters);
    assert.ok(Array.isArray(note.sources) && note.sources.length >= 1);
  }
  assert.equal(notes.filter((note) => /^Watch if/.test(note.why_it_matters)).length, 2);
  const read = run.deepseekRequests.filter((body) => !/watch notes/.test(body.messages[0].content));
  assert.equal(read.filter((body) => JSON.parse(body.messages[1].content).some((source) => source.text)).length, 3, 'only the top 3 get article text');
  assert.ok(read.every((body) => body.thinking.type === 'disabled' && body.model === 'deepseek-flash'));
  assert.ok(clusterPosts(run).length > 0);
});
