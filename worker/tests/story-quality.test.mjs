import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanHeadline, titleCase, plural, sameStory, dropRepeats } from '../../public/textfmt.js';
import { CATS } from '../../public/taxonomy.js';
import {
  isBlockedPublisher, publisherTier, publisherTrust, publisherDomain, isShoppingNoise, isFluff, OPT_IN_CATEGORIES, inferRegion, mentionsIndia,
  isGoogleNewsUrl, decodeGoogleNewsUrl, resolveGoogleNewsUrl, mergeStories, pickRepresentative, sanitizeStory,
} from '../src/story-quality.js';

// ---------- headline style ----------
test('Every headline gets the same style: Title Case, names and acronyms kept, no source suffix', () => {
  assert.equal(cleanHeadline("Judge blocks construction of Trump's massive arch after federal agency approval", 'BBC News'),
    'Judge Blocks Construction of Trump’s Massive Arch After Federal Agency Approval');
  assert.equal(cleanHeadline('Meta, Google, and TikTok sue California AG over teen social media law'), 'Meta, Google, and TikTok Sue California AG Over Teen Social Media Law');
  assert.equal(cleanHeadline('SENSEX JUMPS 400 POINTS AS RBI HOLDS REPO RATE; IT STOCKS LEAD'), 'Sensex Jumps 400 Points as RBI Holds Repo Rate; IT Stocks Lead');
  assert.equal(cleanHeadline('why the iPhone 17 is selling out in India - Mint', 'Mint'), 'Why the iPhone 17 Is Selling Out in India');
  assert.equal(cleanHeadline('Zomato shares fall 5% after Q2 results | The Economic Times', 'Economic Times'), 'Zomato Shares Fall 5% After Q2 Results');
  assert.equal(cleanHeadline('a look at macOS 26 and the new MacBook Pro'), 'A Look at macOS 26 and the New MacBook Pro');
  assert.equal(cleanHeadline('Cost-cutting wave: ex-CEO blames US-China trade war'), 'Cost-Cutting Wave: Ex-CEO Blames US-China Trade War');
  assert.equal(cleanHeadline("'We will not back down,' says minister after talks collapse"), '‘We Will Not Back Down,’ Says Minister After Talks Collapse');
  assert.equal(cleanHeadline('Elon Musk’s xAI raises $6bn - sources say - '), 'Elon Musk’s xAI Raises $6bn — Sources Say');
  assert.equal(cleanHeadline('U.S. inflation cools to 2.9% as the Fed weighs rate cut'), 'U.S. Inflation Cools to 2.9% as the Fed Weighs Rate Cut');
  assert.equal(titleCase(''), '');
  assert.equal(cleanHeadline(null), '');
});

test('A source name is removed from the end of a headline only when it really is that source', () => {
  assert.equal(cleanHeadline('Apple unveils new iPhone - what is new this year', 'Reuters'), 'Apple Unveils New iPhone — What Is New This Year');
  assert.equal(cleanHeadline('Markets rally on rate cut hopes - Reuters', 'Reuters'), 'Markets Rally on Rate Cut Hopes');
});

test('Counts read correctly: 1 story, 2 stories', () => {
  assert.equal(plural(1, 'story', 'stories'), '1 story');
  assert.equal(plural(0, 'story', 'stories'), '0 stories');
  assert.equal(plural(2, 'story', 'stories'), '2 stories');
  assert.equal(plural(1, 'video'), '1 video');
  assert.equal(plural(5, 'video'), '5 videos');
});

test('The same story told twice is spotted; two different stories about one company are not', () => {
  assert.equal(sameStory("Judge blocks construction of Trump's massive arch", "A judge blocks construction of Trump's arch moments after approval"), true);
  assert.equal(sameStory('Tata Motors Q2 profit jumps', 'Tata Motors launches new EV'), false);
  const kept = dropRepeats([{ t: 'Judge blocks Trump arch construction after federal approval' }, { t: 'Trump arch construction blocked by judge after federal approval' }, { t: 'Fed weighs rate cut as inflation cools' }]);
  assert.deepEqual(kept.map((x) => x.t), ['Judge blocks Trump arch construction after federal approval', 'Fed weighs rate cut as inflation cools']);
});

// ---------- trusted publishers ----------
test('Big known outlets rank above unknown ones, and content farms are blocked', () => {
  assert.equal(publisherTier('Reuters'), 1);
  assert.equal(publisherTier('BBC News'), 2);
  assert.equal(publisherTier('The Times of India'), 2);
  assert.equal(publisherTier('Economic Times'), 2);
  assert.equal(publisherTier('TechCrunch AI'), 3);
  assert.equal(publisherTier('Some Random Blog'), 4);
  assert.ok(publisherTrust('Reuters') > publisherTrust('Mint') && publisherTrust('Mint') > publisherTrust('TechCrunch') && publisherTrust('TechCrunch') > publisherTrust('Some Random Blog'));
  assert.equal(publisherDomain('Mint Markets'), 'livemint.com');
  assert.equal(publisherDomain('Unknown Site'), '');
  assert.equal(isBlockedPublisher('Devdiscourse'), true);
  assert.equal(isBlockedPublisher('The News Mill'), true);
  assert.equal(isBlockedPublisher('Reuters'), false);
  for (const name of ['Reuters', 'x', '', undefined]) assert.ok(publisherTier(name) >= 1 && publisherTier(name) <= 4, 'the database only accepts tiers 1 to 4');
});

// ---------- business relevance ----------
test('Shopping deals and coupons are removed; real business deals are kept', () => {
  for (const title of ['Best laptop deals this week: 40% off top brands', 'Amazon Prime Day: best phone deals under ₹20,000', 'Use this coupon code to save on your next order',
    'Gift guide: 12 things to buy for your boss', 'Black Friday deals on TVs start early']) assert.equal(isShoppingNoise(title), true, title);
  for (const title of ['Microsoft agrees $5bn deal to buy cybersecurity firm', 'Tata Motors signs big deal with Tata Steel for EV supply', 'India and US close in on trade deal',
    'Sensex falls 400 points as discount houses sell', 'Retailers brace for Black Friday sales slump']) assert.equal(isShoppingNoise(title) && !/black friday/i.test(title), false, title);
});

test('Zoo animals and horoscopes are fluff, but panda bonds and zoom are not', () => {
  for (const title of ['Hippo at city zoo gives birth to rare calf', 'Today’s horoscope: what the stars say', 'Cute puppy video goes viral']) assert.equal(isFluff(title), true, title);
  for (const title of ['China sells panda bonds to raise yuan funding', 'Zoom reports record quarterly revenue', 'Sensex ends higher']) assert.equal(isFluff(title), false, title);
});

test('The list of interests a reader must choose on purpose matches the taxonomy', () => {
  const fromTaxonomy = CATS.filter((c) => ['life', 'ent', 'spt'].includes(c[2])).map((c) => c[0]).sort();
  assert.deepEqual([...OPT_IN_CATEGORIES].sort(), fromTaxonomy);
});

// ---------- the real country of a story ----------
test('A story is only marked India when it is about India', () => {
  // the bug the tester saw: a US story from The Times of India (or the Indian edition of Google News) was marked India
  assert.deepEqual(inferRegion({ t: 'Trump’s 250-foot triumphal arch in Washington halted by federal judge', s: 'The Times of India', u: 'https://timesofindia.indiatimes.com/x', g: ['IN'] }), ['US']);
  assert.deepEqual(inferRegion({ t: 'Judge blocks construction of Donald Trump’s massive arch', u: 'https://news.google.com/rss/articles/abc?oc=5', g: ['IN'] }), ['US']);
  assert.deepEqual(inferRegion({ t: 'Apple unveils new iPhone with faster chip', u: 'https://news.google.com/rss/articles/abc?oc=5', g: ['IN'] }), [], 'a neutral global story from the Indian edition is global');
  assert.deepEqual(inferRegion({ t: 'Heavy rain lashes city, schools shut', u: 'https://news.google.com/rss/articles/abc?oc=5', g: ['IN'], local: true }), ['IN'], 'the local top-stories feed keeps its country');
  assert.deepEqual(inferRegion({ t: 'Sensex jumps 400 points as RBI holds repo rate', u: 'https://news.google.com/rss/articles/abc?oc=5', g: ['US'] }), ['IN']);
  assert.deepEqual(inferRegion({ t: 'US tariffs hit Indian exporters', g: ['IN'] }), [], 'mentions both: global, so every reader can see it');
  assert.deepEqual(inferRegion({ t: 'Heavy rain lashes city, schools shut', u: 'https://ndtv.com/x', g: ['IN'] }), ['IN'], 'an Indian publisher with no sign of a foreign story stays India');
  assert.deepEqual(inferRegion({ t: 'Headline high', u: 'https://news.example/high', g: ['IN'] }), ['IN']);
  assert.deepEqual(inferRegion({ t: 'Bundesliga title race heats up in Germany', g: [] }), ['EU']);
  assert.equal(mentionsIndia('Baseball: Judge drives in 3 runs'), false);
  assert.equal(mentionsIndia('RBI keeps repo rate unchanged'), true);
});

// ---------- direct links ----------
const b64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const makeId = (payload) => {
  const body = new TextEncoder().encode(payload), len = [];
  let n = body.length;
  while (n >= 0x80) { len.push((n & 0x7f) | 0x80); n >>= 7; }
  len.push(n);
  return b64url([0x08, 0x13, 0x22, ...len, ...body, 0xd2, 0x01, 0x00]);
};
const gnUrl = (id) => `https://news.google.com/rss/articles/${id}?oc=5`;

test('Older Google News links are turned into the publisher link without any network call', () => {
  assert.equal(isGoogleNewsUrl(gnUrl('abc')), true);
  assert.equal(isGoogleNewsUrl('https://www.bbc.com/news/1'), false);
  assert.equal(decodeGoogleNewsUrl(gnUrl(makeId('https://www.example.com/news/story-1'))), 'https://www.example.com/news/story-1');
  const long = 'https://www.example.com/' + 'a-very-long-path/'.repeat(12) + 'story';
  assert.ok(long.length > 130);
  assert.equal(decodeGoogleNewsUrl(gnUrl(makeId(long))), long, 'links longer than 127 characters use a two-byte length');
  assert.equal(decodeGoogleNewsUrl(gnUrl(makeId('AU_yqLopaquecode123'))), null, 'newer links hold a code, not an address');
  assert.equal(decodeGoogleNewsUrl('https://www.bbc.com/news/1'), null);
  assert.equal(decodeGoogleNewsUrl('not a url'), null);
});

test('Newer Google News links are looked up on Google; any failure keeps the Google link', async () => {
  const id = makeId('AU_yqLopaquecode123');
  const seen = [];
  const good = async (url, init = {}) => {
    url = String(url);
    seen.push(url);
    if (url.includes('/rss/articles/')) return new Response('<c-wiz><div jscontroller="x" data-n-a-sg="SIG123" data-n-a-ts="1700000000"></div></c-wiz>');
    return new Response(`)]}'\n\n${JSON.stringify([['wrb.fr', 'Fbv4je', JSON.stringify(['garturlres', 'https://www.bbc.com/news/articles/abc', 1]), null, null, null, 'generic'], ['di', 5], ['af.httprm', 5, '-1', 1]])}`);
  };
  assert.equal(await resolveGoogleNewsUrl(gnUrl(id), { fetchImpl: good }), 'https://www.bbc.com/news/articles/abc');
  const post = seen.find((u) => u.includes('batchexecute'));
  assert.ok(post, 'the second request goes to the batchexecute address');
  assert.equal(await resolveGoogleNewsUrl(gnUrl(id), { fetchImpl: async () => new Response('blocked', { status: 429 }) }), null);
  assert.equal(await resolveGoogleNewsUrl(gnUrl(id), { fetchImpl: async () => { throw new Error('offline'); } }), null);
  assert.equal(await resolveGoogleNewsUrl(gnUrl(id), { fetchImpl: async () => new Response('<html>no signature here</html>') }), null);
  assert.equal(await resolveGoogleNewsUrl('https://www.bbc.com/news/1', { fetchImpl: good }), null);
  const offline = makeId('https://www.example.com/a');
  assert.equal(await resolveGoogleNewsUrl(gnUrl(offline), { fetchImpl: async () => { throw new Error('must not be called'); } }), 'https://www.example.com/a');
});

// ---------- one story, one card ----------
test('The same article is never listed twice, and a direct link beats a Google link', () => {
  const google = { id: 'g1', t: 'Story', u: gnUrl('abc'), s: 'BBC', d: 100 };
  const direct = { id: 'd1', t: 'Story', u: 'https://www.bbc.com/news/1', s: 'BBC', d: 90 };
  const resolved = { ...google, u: 'https://www.bbc.com/news/1', gu: gnUrl('abc') };
  assert.deepEqual(mergeStories([google], [resolved]).map((s) => s.u), ['https://www.bbc.com/news/1'], 'old Google row + its resolved copy = one story');
  assert.equal(mergeStories([google], [resolved])[0].gu, gnUrl('abc'), 'the Google link is remembered so it is never looked up again');
  assert.equal(mergeStories([resolved], [direct]).length, 1, 'a direct feed copy of the same article is the same story');
  assert.equal(mergeStories([google], [direct]).length, 2, 'an unresolved Google link cannot be matched to a direct link; the headline check removes such repeats on the page');
  assert.equal(mergeStories([google], [{ ...google, q: 2 }])[0].q, 2, 'the newer copy of the same link wins');
  assert.equal(mergeStories([direct], [{ id: 'x', t: 'Other', u: 'https://www.nytimes.com/2', s: 'NYT', d: 95 }]).length, 2);
  assert.equal(mergeStories(Array.from({ length: 20 }, (_, i) => ({ u: `https://a.example/${i}`, d: i })), [], 12).length, 12);
});

test('The homepage story is shown with its direct link and best publisher', () => {
  const google = { t: 'Story', u: gnUrl('abc'), s: 'BBC', d: 100 };
  const direct = { t: 'Story', u: 'https://example-blog.com/1', s: 'Some Random Blog', d: 90 };
  assert.equal(pickRepresentative([google, direct]).u, 'https://example-blog.com/1', 'direct beats Google');
  assert.equal(pickRepresentative([direct, { t: 'Story', u: 'https://www.reuters.com/1', s: 'Reuters', d: 80 }]).s, 'Reuters', 'then the most trusted publisher');
  assert.equal(pickRepresentative([{ t: 'Video', u: 'https://youtube.com/watch?v=1', v: 1 }]), null);
  assert.equal(pickRepresentative([]), null);
});

// ---------- a saved story, corrected when it is read back ----------
test('Old saved stories are cleaned when read: junk removed, India label fixed, headline restyled', () => {
  assert.equal(sanitizeStory({ t: 'Best phone deals: 30% off today', s: 'Gadget Site', k: ['tech'] }), null);
  assert.equal(sanitizeStory({ t: 'A story', s: 'Devdiscourse', k: ['business'] }), null);
  assert.equal(sanitizeStory({ t: 'Hippo at zoo steals the show', s: 'BBC News', k: ['world', 'trending'] }), null, 'fluff with no opt-in interest is dropped');
  const pet = sanitizeStory({ t: 'Hippo at zoo steals the show', s: 'BBC News', k: ['world', 'pets'] });
  assert.deepEqual(pet.k, ['pets'], 'but a reader who chose Pets & Animals still gets it');
  const arch = sanitizeStory({ t: 'Judge blocks construction of Trump’s massive arch', s: 'The Times of India', u: gnUrl('abc'), k: ['law', 'india', 'trending'], g: ['IN'] });
  assert.deepEqual(arch.g, ['US']);
  assert.deepEqual(arch.k, ['law', 'trending'], 'no India label on a US story');
  assert.equal(arch.t, 'Judge Blocks Construction of Trump’s Massive Arch');
  const indian = sanitizeStory({ t: 'RBI keeps repo rate unchanged', s: 'Mint', k: ['markets', 'india'], g: ['IN'] });
  assert.deepEqual(indian.g, ['IN']);
  assert.ok(indian.k.includes('india'));
  const plain = sanitizeStory({ t: 'Quarterly results beat estimates', s: 'Mint', k: ['business'] });
  assert.equal('g' in plain, false, 'no country means no g at all');
  assert.equal(sanitizeStory(null), null);
});
