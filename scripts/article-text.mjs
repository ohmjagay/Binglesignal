// Fetches a public article page and returns its readable paragraphs (no dependencies).
// Used only for the top stories of each run and never for paywalled publishers. Only the short AI summary is stored,
// never the article text itself. The summary always links back to the original source.
const BLOCKED = ['nytimes.com', 'ft.com', 'wsj.com', 'bloomberg.com', 'economist.com', 'washingtonpost.com', 'theinformation.com',
  'barrons.com', 'hbr.org', 'thetimes.co.uk', 'telegraph.co.uk', 'newyorker.com', 'wired.com', 'technologyreview.com', 'thehindu.com',
  'economictimes.indiatimes.com', 'livemint.com', 'business-standard.com', 'medium.com', 'news.google.com', 'youtube.com', 'youtu.be',
  'reddit.com', 'x.com', 'twitter.com', 'linkedin.com', 'facebook.com', 'instagram.com'];
const UA = 'Mozilla/5.0 (compatible; BingleSignalBot/5.0; +https://binglesignal.com)';
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };
const BOILERPLATE = /(cookie|subscribe|sign up|newsletter|all rights reserved|advertisement|follow us|click here|privacy policy|terms of use|copyright ©)/i;

export const isBlockedHost = (host) => {
  const name = String(host || '').toLowerCase().replace(/^www\./, '');
  return BLOCKED.some((domain) => name === domain || name.endsWith(`.${domain}`));
};

const decode = (text) => text.replace(/&(#x?[\da-f]+|\w+);/gi, (match, entity) => {
  const key = entity.toLowerCase();
  try {
    if (key[0] === '#') return String.fromCodePoint(key[1] === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1)));
  } catch { return match; }
  return ENTITIES[key] ?? match;
});
const plain = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Pure function (easy to test): HTML in, article paragraphs out. Returns '' when there is not enough real text.
export function extractArticleText(html, maxChars = 6000) {
  const page = String(html || '').slice(0, 800_000);
  if (/<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*(noai|noarchive|nosnippet)/i.test(page)) return '';
  const body = page.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|form|nav|header|footer|aside|figure|button)\b[\s\S]*?<\/\1>/gi, ' ');
  const scope = (body.match(/<article\b[\s\S]*?<\/article>/i) || body.match(/<main\b[\s\S]*?<\/main>/i) || [body])[0];
  const paragraphs = [];
  for (const match of scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = plain(match[1]);
    if (text.length >= 45 && !BOILERPLATE.test(text)) paragraphs.push(text);
  }
  let text = paragraphs.join('\n');
  if (text.length < 200) return '';
  if (text.length > maxChars) text = `${text.slice(0, maxChars).replace(/\s+\S*$/, '')}…`;
  return text;
}

// Never throws: any problem (blocked site, timeout, not HTML, no robots permission) simply returns ''.
export async function fetchArticleText(url, { fetchImpl = globalThis.fetch, timeoutMs = 8000, maxChars = 6000 } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return ''; }
  if (!/^https?:$/.test(parsed.protocol) || isBlockedHost(parsed.hostname)) return '';
  try {
    const response = await fetchImpl(parsed.toString(), {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok || !/html/i.test(response.headers.get('content-type') || '')) return '';
    if (/noai|noarchive|nosnippet/i.test(response.headers.get('x-robots-tag') || '')) return '';
    let finalHost = '';
    try { finalHost = new URL(response.url || parsed.toString()).hostname; } catch { finalHost = ''; }
    if (finalHost && isBlockedHost(finalHost)) return '';
    return extractArticleText(await response.text(), maxChars);
  } catch { return ''; }
}
