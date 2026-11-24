// BingleSignal news-quality rules. ONE file, used by the robot that collects stories (scripts/ingest.mjs)
// and by the Worker that serves them (the homepage teaser and the READ list), so both always agree.
//
// What it does:
//   1. Trusted publishers      - big, known outlets rank first; unknown or junk sites cannot lead the page.
//   2. Business-relevance      - shopping deals, coupons, gift guides, zoo animals, horoscopes... are removed (or kept only for readers who chose that interest).
//   3. The real country        - a story is only marked India when it is about India, not because it came through the Indian edition of Google News.
//   4. Direct links            - Google News links are turned into the publisher's own link.
//   5. One story, one card     - near-identical stories are merged.
// To trust or block a website, edit the lists in section 1. Nothing else needs to change.
import { cleanHeadline, dropRepeats } from '../../public/textfmt.js';

// ---------- 1. publishers ----------
// [tier, website, pattern matched against the lower-cased publisher name]
// tier 1 = wire services and official sources, 2 = major newspapers and broadcasters, 3 = respected specialist outlets, anything else = tier 4 (unknown).
const PUBLISHERS = [
  [1, 'reuters.com', 'reuters'], [1, 'apnews.com', '^ap$|\\bap news\\b|associated press'], [1, 'bloomberg.com', 'bloomberg'],
  [1, 'ptinews.com', '^pti$|press trust of india'], [1, 'sec.gov', 'u\\.?s\\.? sec\\b|securities and exchange commission'],
  [1, 'sebi.gov.in', '\\bsebi\\b'], [1, 'rbi.org.in', '\\brbi\\b|reserve bank of india'], [1, 'pib.gov.in', '\\bpib\\b|press information bureau'],
  [1, 'ec.europa.eu', 'european commission'], [1, 'federalregister.gov', 'federal register'],
  [2, 'bbc.com', '\\bbbc\\b'], [2, 'nytimes.com', 'new york times|^nyt$'], [2, 'wsj.com', 'wall street journal|^wsj$'], [2, 'ft.com', 'financial times|^ft$'],
  [2, 'theguardian.com', '^the guardian|^guardian'], [2, 'aljazeera.com', 'al jazeera'], [2, 'cnbc.com', 'cnbc'], [2, 'npr.org', '^npr$'],
  [2, 'economist.com', 'the economist'], [2, 'washingtonpost.com', 'washington post'], [2, 'cnn.com', '^cnn'], [2, 'forbes.com', 'forbes'],
  [2, 'fortune.com', '^fortune'], [2, 'axios.com', 'axios'], [2, 'politico.com', 'politico'], [2, 'time.com', '^time(\\s+magazine)?$'],
  [2, 'dw.com', '^dw\\b|deutsche welle'], [2, 'france24.com', 'france 24'], [2, 'news.sky.com', 'sky news'], [2, 'abcnews.go.com', 'abc news'],
  [2, 'cbsnews.com', 'cbs news'], [2, 'nbcnews.com', 'nbc news'], [2, 'asia.nikkei.com', 'nikkei'], [2, 'scmp.com', 'south china morning post|^scmp'],
  [2, 'thehindu.com', 'the hindu|businessline'], [2, 'indianexpress.com', 'indian express|financial express'], [2, 'hindustantimes.com', 'hindustan times'],
  [2, 'timesofindia.indiatimes.com', 'times of india|^toi$'], [2, 'economictimes.indiatimes.com', 'economic times|^et(\\s|$)'],
  [2, 'livemint.com', '\\bmint\\b|livemint'], [2, 'business-standard.com', 'business standard'], [2, 'ndtv.com', 'ndtv'], [2, 'moneycontrol.com', 'moneycontrol'],
  [2, 'indiatoday.in', 'india today'], [2, 'theprint.in', '^the ?print'], [2, 'deccanherald.com', 'deccan herald'],
  [3, 'techcrunch.com', 'techcrunch'], [3, 'theverge.com', 'the verge'], [3, 'arstechnica.com', 'ars technica'], [3, 'wired.com', '^wired'],
  [3, 'technologyreview.com', 'technology review'], [3, 'venturebeat.com', 'venturebeat'], [3, 'engadget.com', 'engadget'], [3, 'cnet.com', '^cnet'],
  [3, 'zdnet.com', 'zdnet'], [3, 'inc42.com', 'inc42'], [3, 'yourstory.com', 'yourstory'], [3, 'entrackr.com', 'entrackr'], [3, 'the-ken.com', '^the ken$'],
  [3, 'variety.com', 'variety'], [3, 'deadline.com', 'deadline'], [3, 'hollywoodreporter.com', 'hollywood reporter'], [3, 'espncricinfo.com', 'cricinfo'],
  [3, 'espn.com', '^espn'], [3, 'nature.com', '^nature'], [3, 'sciencedaily.com', 'sciencedaily'], [3, 'electrek.co', 'electrek'], [3, 'motor1.com', 'motor1'],
  [3, 'carscoops.com', 'carscoops'], [3, 'autocarindia.com', 'autocar'], [3, 'scroll.in', '^scroll'], [3, 'thewire.in', '^the wire'], [3, 'firstpost.com', 'firstpost'],
  [3, 'news18.com', 'news18'], [3, 'zeebiz.com', 'zee (business|news)'], [3, 'abplive.com', 'abp'], [3, 'thenewsminute.com', 'news minute'],
  [3, 'financialexpress.com', 'financial express'], [3, 'cnbctv18.com', 'cnbc-?tv18'], [3, 'bollywoodhungama.com', 'bollywood hungama'], [3, 'tribuneindia.com', 'tribune'],
  [3, 'finance.yahoo.com', 'yahoo'], [3, 'investing.com', 'investing\\.com'], [3, 'benzinga.com', 'benzinga'], [3, 'thehill.com', '^the hill$'],
];
// Content farms and re-write sites: never shown.
const BLOCKED = /devdiscourse|the news mill|newsbreak|dailyhunt|mirage news|big news network|newsable|scoopnest|lokmat times|msn india/i;
const COMPILED = PUBLISHERS.map(([tier, domain, pattern]) => [tier, domain, new RegExp(pattern, 'i')]);
const lookup = (name) => COMPILED.find(([, , re]) => re.test(String(name || '').trim()));

export const isBlockedPublisher = (name) => BLOCKED.test(String(name || ''));
// 1..4 (the database allows exactly 1 to 4).
export const publisherTier = (name) => lookup(name)?.[0] ?? 4;
export const publisherTrust = (name) => ({ 1: 0.95, 2: 0.88, 3: 0.75, 4: 0.45 })[publisherTier(name)];
// Website of a known publisher, for the small logo when the story link is still a Google link.
export const publisherDomain = (name) => lookup(name)?.[1] || '';

// ---------- 2. relevance ----------
// Removed for everyone: this is a briefing, not a coupon site.
const SHOPPING = new RegExp([
  '\\b\\d{1,3}\\s?%\\s+off\\b', '\\bup to\\s+\\d{1,3}\\s?%\\s+(off|discount)', '\\bflat\\s+\\d{1,3}\\s?%',
  '\\b(coupon|promo)\\s*codes?\\b', '\\bcoupons?\\b', '\\bdiscount codes?\\b',
  '\\bbest\\s+(\\w+\\s+){0,4}deals?\\b', '\\bdeals?\\s+(of the day|of the week|alert|roundup|round-up)\\b', '\\b(top|best)\\s+\\d+\\s+(\\w+\\s+){0,3}deals\\b',
  '\\b(black friday|cyber monday|prime day|big billion days|great indian festival|diwali sale|festive sale|end of season sale)\\b',
  '\\bdeals?\\s+on\\s+(phones?|laptops?|tvs?|headphones?|earbuds|smartwatch(es)?|iphones?|gadgets?|appliances?|tablets?|speakers?|cameras?)\\b',
  '\\b(buying guide|gift guide|gift ideas|where to buy|should you buy|worth buying|is it worth buying)\\b',
  '\\bbest\\s+(\\w+\\s+){0,3}(under|below)\\s+(₹|rs\\.?\\s?|\\$|usd\\s?)\\s?[\\d,]+', '\\b(sponsored|advertorial|partner content|paid post)\\b',
].join('|'), 'i');

// Not for a business reader: kept ONLY for people who picked a lifestyle, entertainment or sports interest.
const FLUFF = new RegExp([
  '\\b(zoo|zookeepers?|hippos?|hippopotam\\w+|giraffes?|koalas?|baby (elephant|tiger|lion|giraffe|panda|monkey|animal)s?|puppy|puppies|kittens?)\\b',
  '\\bpandas?\\b(?!\\s+bonds?)', '\\bviral (video|clip|post|photo|moment|reel|tweet)s?\\b', '\\b(goes|went|going) viral\\b',
  '\\b(horoscope|zodiac|rashifal)\\b', '\\blottery (results?|winners?|numbers?)\\b', '\\b(powerball|mega millions)\\b',
  '\\b(wordle|crossword|sudoku|nyt connections|nyt strands)\\b', '\\bquiz\\b', '\\brecipes?\\b', '\\b(red carpet|met gala|wardrobe malfunction)\\b',
  '\\b(dating|relationship) (tips|advice)\\b', '\\bspotted (at|in|with|outside)\\b',
].join('|'), 'i');

export const isShoppingNoise = (title = '', excerpt = '') => SHOPPING.test(`${title} ${String(excerpt).slice(0, 160)}`);
export const isFluff = (title = '', excerpt = '') => FLUFF.test(`${title} ${String(excerpt).slice(0, 160)}`);
// Interests a reader has to choose on purpose (taxonomy groups life, ent and spt). A test keeps this list in step with public/taxonomy.js.
export const OPT_IN_CATEGORIES = new Set(('travel food fashion beauty parenting pets spirit books vlog memes media bollywood hollywood korean music gaming anime ott ' +
  'sports cricket football f1 basket tennis').split(' '));

// ---------- 3. the real country of a story ----------
const INDIA_WORDS = /\b(india|indian|indians|new delhi|delhi|mumbai|bengaluru|bangalore|hyderabad|chennai|kolkata|pune|ahmedabad|jaipur|lucknow|gurugram|gurgaon|noida|kerala|tamil nadu|karnataka|maharashtra|gujarat|rajasthan|uttar pradesh|punjab|bihar|odisha|west bengal|modi|lok sabha|rajya sabha|bjp|niti aayog|sensex|nifty|rupee|rupees|crore|crores|lakh|lakhs|bollywood|tata|reliance|adani|infosys|wipro|hdfc|icici|flipkart|zomato|swiggy|paytm|phonepe|byju'?s|ola electric|mahindra|maruti|bajaj|ambani|hindustan|indigo|air india|nykaa|policybazaar|razorpay|zerodha|kotak|airtel|vodafone idea|jio)\b|₹/i;
const INDIA_CAPS = /\b(RBI|SEBI|BSE|NSE|IPL|BCCI|IIT|IIM|UPI|NPCI|GST|TCS|LIC|AAP|ISRO|NTPC|ONGC)\b/;
const US_WORDS = /\b(trump|biden|harris|vance|white house|pentagon|capitol hill|u\.s\.|american|americans|us senate|us house|wall street|federal reserve|the fed|nasdaq|s&p 500|dow jones|california|texas|new york|florida|washington|silicon valley|united states|america|fbi|cia)\b/i;
const EU_WORDS = /\b(european union|eu|eurozone|ecb|brussels|bundestag|macron|scholz|merz|von der leyen|nato|germany|german|france|french|italy|italian|spain|spanish|netherlands|dutch|poland|polish|sweden|norway|denmark|finland|switzerland|swiss|brexit|uk|u\.k\.|britain|british|england|london|starmer|sunak|downing street|ukraine|ukrainian|russia|russian|putin|kremlin|zelensky)\b/i;
const US_CAPS = /\b(US|USA)\b/;    // capitals only, so the word "us" in a sentence is not mistaken for the country
const OTHER_WORDS = /\b(china|chinese|beijing|xi jinping|taiwan|japan|japanese|tokyo|korea|korean|seoul|gaza|israel|israeli|hamas|iran|iranian|tehran|saudi|dubai|uae|qatar|turkey|erdogan|brazil|mexico|canada|canadian|australia|australian|africa|nigeria|kenya|egypt|argentina|paraguay|venezuela)\b/i;

export const mentionsIndia = (text = '') => INDIA_WORDS.test(text) || INDIA_CAPS.test(text);
export const isGoogleNewsUrl = (url) => { try { return new URL(url).hostname === 'news.google.com'; } catch { return false; } };

// Returns the story's countries as a list: ['IN'], ['US'], ['EU'] or [] (global).
//   * It is India only when the story mentions India (or came from an Indian publisher's own feed and has no sign of being foreign).
//   * A story that mentions both India and another country is global, so every reader can see it.
//   * A story that only came through a country edition of Google News is global unless it says otherwise.
//     (The local top-stories feed is the exception: its whole point is the country, so it keeps it.)
export function inferRegion({ t = '', x = '', u = '', g = [], gn = false, local = false } = {}) {
  const text = `${t} ${String(x).slice(0, 160)}`;
  const india = mentionsIndia(text), us = US_WORDS.test(text) || US_CAPS.test(text), eu = EU_WORDS.test(text), other = OTHER_WORDS.test(text);
  const foreign = us || eu || other;
  if (india) return foreign ? [] : ['IN'];
  if (foreign) return us && !eu && !other ? ['US'] : eu && !us && !other ? ['EU'] : [];
  const viaGoogle = gn || isGoogleNewsUrl(u);
  if (viaGoogle && !local) return [];
  return Array.isArray(g) && g[0] ? [g[0]] : [];
}

// ---------- 4. direct links ----------
const UA = 'Mozilla/5.0 (compatible; BingleSignalBot/5.0; +https://binglesignal.com)';
const googleArticleId = (url) => {
  try {
    const u = new URL(url);
    if (u.hostname !== 'news.google.com') return '';
    const parts = u.pathname.split('/').filter(Boolean);
    return ['articles', 'read'].includes(parts[parts.length - 2]) ? parts[parts.length - 1] : '';
  } catch { return ''; }
};
const fromB64Url = (value) => {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

// Older Google News links carry the publisher address inside the link itself: no network call needed.
export function decodeGoogleNewsUrl(url) {
  const id = googleArticleId(url);
  if (!id) return null;
  try {
    let bytes = fromB64Url(id);
    if (bytes[0] === 0x08 && bytes[1] === 0x13 && bytes[2] === 0x22) bytes = bytes.slice(3);
    const n = bytes.length;
    if (n >= 3 && bytes[n - 3] === 0xd2 && bytes[n - 2] === 0x01 && bytes[n - 1] === 0x00) bytes = bytes.slice(0, n - 3);
    let offset = 0, length = 0, shift = 0;
    while (offset < bytes.length) { const b = bytes[offset++]; length |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
    const decoded = new TextDecoder().decode(bytes.slice(offset, offset + length));
    return /^https?:\/\//.test(decoded) ? decoded : null;     // newer links ("AU_yqL...") hold an opaque code instead: they need the online step
  } catch { return null; }
}

// Newer links must be looked up on Google: one page request for a signature, one request for the address. Never throws: null means "keep the Google link".
export async function resolveGoogleNewsUrl(url, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const direct = decodeGoogleNewsUrl(url);
  if (direct) return direct;
  const id = googleArticleId(url);
  if (!id) return null;
  try {
    let signature = '', timestamp = '';
    for (const path of [`/rss/articles/${id}`, `/articles/${id}`]) {
      const page = await fetchImpl(`https://news.google.com${path}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
      if (!page.ok) continue;
      const html = await page.text();
      signature = html.match(/data-n-a-sg="([^"]+)"/)?.[1] || '';
      timestamp = html.match(/data-n-a-ts="([^"]+)"/)?.[1] || '';
      if (signature && timestamp) break;
    }
    if (!signature || !timestamp) return null;
    const request = ['Fbv4je', `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${timestamp},"${signature}"]`];
    const reply = await fetchImpl('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'user-agent': UA },
      body: 'f.req=' + encodeURIComponent(JSON.stringify([[request]])), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!reply.ok) return null;
    const text = await reply.text();
    let found = '';
    try { found = JSON.parse(JSON.parse(text.split('\n\n')[1])[0][2])[1]; } catch { /* fall through to the pattern below */ }
    if (!found) found = (text.match(/garturlres\\+",\\+"(https?:[^"\\]+)/) || [])[1] || '';
    return /^https?:\/\//.test(found) && !isGoogleNewsUrl(found) ? found : null;
  } catch { return null; }
}

// ---------- 5. one story, one card ----------
// Joins the stories already saved for a cluster with new ones: the same article is never listed twice, a direct link beats a Google link, newest first.
// `gu` remembers the original Google link of an article whose real link we have found, so it is recognised on the next run and never looked up again.
export function mergeStories(existing = [], incoming = [], max = 12) {
  const out = [];
  const same = (a, b) => a.u === b.u || (a.gu && a.gu === b.u) || (b.gu && b.gu === a.u) || (a.gu && a.gu === b.gu);
  for (const story of [...existing, ...incoming]) {
    if (!story?.u) continue;
    const i = out.findIndex((o) => same(o, story));
    if (i < 0) { out.push(story); continue; }
    const o = out[i], oGoogle = isGoogleNewsUrl(o.u), sGoogle = isGoogleNewsUrl(story.u);
    const better = oGoogle && !sGoogle ? story : !oGoogle && sGoogle ? o : story;   // a direct link wins; otherwise the newer copy
    const gu = o.gu || story.gu || (oGoogle ? o.u : sGoogle ? story.u : undefined);
    out[i] = gu && !isGoogleNewsUrl(better.u) ? { ...better, gu } : better;
  }
  return out.sort((a, b) => new Date(b.d) - new Date(a.d)).slice(0, max);
}

// The cluster's best representative: a direct link first, then the most trusted publisher, then the most recent.
export function pickRepresentative(stories = []) {
  const pool = stories.filter((s) => s && !s.v && s.t && /^https?:\/\//.test(s.u || ''));
  const order = (s) => (isGoogleNewsUrl(s.u) ? 10 : 0) + publisherTier(s.s);
  return pool.map((s, i) => [s, i]).sort((a, b) => order(a[0]) - order(b[0]) || a[1] - b[1])[0]?.[0] || null;
}

// ---------- everything above, applied to one saved story when it is read back ----------
// Returns null for a story that must not be shown. Old rows saved before these rules existed are corrected here, so the fix works at once.
export function sanitizeStory(story) {
  if (!story || !story.t) return null;
  if (isBlockedPublisher(story.s)) return null;
  if (isShoppingNoise(story.t, story.x)) return null;
  let k = Array.isArray(story.k) ? story.k : [];
  if (isFluff(story.t, story.x)) {
    k = k.filter((id) => OPT_IN_CATEGORIES.has(id));
    if (!k.length) return null;
  }
  const g = inferRegion({ t: story.t, x: story.x, u: story.u, g: story.g, gn: !!(story.gn || story.gu), local: k.includes('local') });
  if (!g.includes('IN') && !mentionsIndia(`${story.t} ${story.x || ''}`)) k = k.filter((id) => id !== 'india');   // "India" only when the story is about India
  const { g: _old, ...rest } = story;
  return { ...rest, t: story.v ? story.t : cleanHeadline(story.t, story.s), k, ...(g.length ? { g } : {}) };   // video titles keep the channel's own style
}

export { dropRepeats };
