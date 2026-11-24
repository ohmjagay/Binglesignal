// End-to-end check of the news-quality rules inside the ingest robot, with every network call faked.
// Feed: stories as Google News delivers them (a Google link plus the real publisher's name), one of each kind the tester complained about.
import test from 'node:test';
import assert from 'node:assert/strict';

const SUPABASE = 'https://proj.supabase.co';
const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'DEEPSEEK_API_KEY', 'MAX_NEW_NOTES', 'YOUTUBE_API_KEY'];

const b64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// A Google News link in the older format: it carries the publisher's address inside itself.
const gnLink = (url) => {
  const body = new TextEncoder().encode(url);
  return `https://news.google.com/rss/articles/${b64url([0x08, 0x13, 0x22, body.length, ...body, 0xd2, 0x01, 0x00])}?oc=5`;
};
// A newer-format link: only Google can say where it points.
const opaqueLink = (code) => {
  const body = new TextEncoder().encode(code);
  return `https://news.google.com/rss/articles/${b64url([0x08, 0x13, 0x22, body.length, ...body, 0xd2, 0x01, 0x00])}?oc=5`;
};

const ARCH = gnLink('https://timesofindia.indiatimes.com/world/us/trump-arch-blocked/articleshow/1.cms');
const SENSEX = opaqueLink('AU_yqLsensexcode0001');
const now = new Date().toUTCString();
const item = (title, link, source, minutesAgo = 30) =>
  `<item><title>${title} - ${source}</title><link>${link}</link><pubDate>${new Date(Date.now() - minutesAgo * 60e3).toUTCString()}</pubDate><description></description><source url="https://example.com">${source}</source></item>`;
const GOOGLE_XML = `<?xml version="1.0"?><rss><channel>${[
  item('Judge blocks construction of Donald Trump&apos;s massive arch', ARCH, 'The Times of India'),
  item('Sensex jumps 400 points as RBI holds repo rate', SENSEX, 'Mint', 20),
  item('Best laptop deals this week: 40% off top brands', gnLink('https://deals.example.com/laptops'), 'Gadget Deals', 25),
  item('Hippo at city zoo gives birth to rare calf', gnLink('https://www.bbc.com/news/hippo'), 'BBC News', 15),
  item('Cabinet approves new defence procurement plan', gnLink('https://devdiscourse.example.com/cabinet'), 'Devdiscourse', 10),
].join('')}</channel></rss>`;

async function runIngest() {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((name) => [name, process.env[name]]));
  const savedFetch = globalThis.fetch, savedLog = console.log, savedError = console.error;
  Object.assign(process.env, { SUPABASE_URL: SUPABASE, SUPABASE_SERVICE_ROLE_KEY: 'service', CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'cf', MAX_NEW_NOTES: '5' });
  delete process.env.DEEPSEEK_API_KEY; delete process.env.YOUTUBE_API_KEY;
  const posts = [], lookups = [], logs = [];
  let vector = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('hn.algolia.com')) return Response.json({ hits: [] });
    if (url.includes('api.cloudflare.com')) {
      const { text } = JSON.parse(init.body);
      return Response.json({ success: true, result: { data: text.map(() => Array.from({ length: 512 }, (_, j) => (j === vector++ % 512 ? 1 : 0))) } });
    }
    if (url.startsWith(SUPABASE)) {
      const method = init.method || 'GET';
      if (method === 'GET') return new Response('[]', { status: 200 });
      posts.push({ path: url.slice(SUPABASE.length), body: init.body ? JSON.parse(init.body) : null });
      return new Response('', { status: 201 });
    }
    // Google answers the lookup for the newer-format link.
    if (url.startsWith('https://news.google.com/rss/articles/')) {
      lookups.push(url);
      return new Response('<c-wiz><div jscontroller="x" data-n-a-sg="SIG" data-n-a-ts="1700000000"></div></c-wiz>');
    }
    if (url.includes('batchexecute')) {
      lookups.push(url);
      return new Response(`)]}'\n\n${JSON.stringify([['wrb.fr', 'Fbv4je', JSON.stringify(['garturlres', 'https://www.livemint.com/market/sensex-jumps-11.html', 1]), null, null, null, 'generic'], ['di', 5]])}`);
    }
    if (url.startsWith('https://news.google.com/rss')) return new Response(GOOGLE_XML);
    return new Response('<?xml version="1.0"?><rss><channel></channel></rss>');
  };
  console.log = (...args) => logs.push(args.join(' '));
  console.error = () => {};
  process.exitCode = 0;
  try {
    await import(`./ingest.mjs?quality=${Date.now()}`);
    return { posts, lookups, logs };
  } finally {
    process.exitCode = 0;
    globalThis.fetch = savedFetch; console.log = savedLog; console.error = savedError;
    for (const name of ENV_KEYS) { if (savedEnv[name] === undefined) delete process.env[name]; else process.env[name] = savedEnv[name]; }
  }
}

test('The robot drops shopping deals, zoo stories and content-farm sites, fixes the country, and swaps Google links for the real ones', async () => {
  const run = await runIngest();
  const rows = run.posts.filter((post) => post.path.startsWith('/rest/v1/story_clusters?on_conflict')).flatMap((post) => post.body);
  const stories = rows.flatMap((row) => row.stories);
  const titles = stories.map((story) => story.t);
  const byTitle = (needle) => stories.find((story) => story.t.includes(needle));

  assert.ok(byTitle('Arch'), `the US story is kept: ${titles.join(' | ')}`);
  assert.ok(byTitle('Sensex'), 'the India story is kept');
  assert.equal(byTitle('Laptop Deals'), undefined, 'shopping deal removed');
  assert.equal(byTitle('Hippo'), undefined, 'zoo story removed');
  assert.equal(byTitle('Defence Procurement'), undefined, 'story from a content-farm site removed');

  const arch = byTitle('Arch');
  assert.equal(arch.t, 'Judge Blocks Construction of Donald Trump’s Massive Arch', 'one headline style, source name removed from the end');
  assert.deepEqual(arch.g, ['US'], 'a US story is not marked India just because it came through the Indian edition');
  assert.ok(!arch.k.includes('india'), 'and it gets no India label');
  assert.equal(arch.u, 'https://timesofindia.indiatimes.com/world/us/trump-arch-blocked/articleshow/1.cms', 'direct link, read from the Google link itself');
  assert.ok(arch.gu.startsWith('https://news.google.com/'), 'the Google link is remembered');

  const sensex = byTitle('Sensex');
  assert.deepEqual(sensex.g, ['IN'], 'a story that is about India is marked India');
  assert.equal(sensex.u, 'https://livemint.com/market/sensex-jumps-11.html', 'a newer-format link is looked up once and replaced (the robot always stores links without "www.", so one article = one link)');
  assert.ok(run.lookups.some((url) => url.includes('batchexecute')));
  assert.ok(run.logs.some((line) => /direct links: looked up 1 found 1/.test(line)), run.logs.filter((l) => /direct links/.test(l)).join(' / '));
  assert.ok(stories.every((story) => !story.u.startsWith('https://news.google.com/')), 'no Google links are left on the page');
  assert.ok(stories.every((story) => story.source_tier >= 1 && story.source_tier <= 4), 'tiers stay inside the 1-4 the database accepts');
  assert.ok(rows.every((row) => row.source_tier >= 1 && row.source_tier <= 4));
});
