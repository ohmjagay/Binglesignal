// GET /api/logo?d=reuters.com  ->  the small icon of a news website, fetched once and then cached for 30 days.
// It goes through our own server so a reader's browser never contacts a third party just to see a logo.
// Only real picture types are passed on (never SVG, which can carry scripts), and only plausible website names are accepted.
const SITE = /^(?=.{4,80}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}$/;
const PICTURES = /^image\/(png|x-icon|vnd\.microsoft\.icon|jpeg|gif|webp)\b/i;
const UA = 'Mozilla/5.0 (compatible; BingleSignalBot/5.0; +https://binglesignal.com)';

export async function handleLogo(req, env, ctx, fetchImpl = globalThis.fetch) {
  const domain = (new URL(req.url).searchParams.get('d') || '').toLowerCase().replace(/^www\./, '');
  if (!SITE.test(domain)) return new Response('bad request', { status: 400 });
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(new URL(`/api/logo?d=${domain}`, req.url).toString());
  const hit = cache ? await cache.match(key) : null;
  if (hit) return hit;
  let res = null;
  try { res = await fetchImpl(`https://icons.duckduckgo.com/ip3/${domain}.ico`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(5000) }); } catch { res = null; }
  const type = res?.headers.get('content-type') || '';
  const body = res?.ok && PICTURES.test(type) ? await res.arrayBuffer() : null;
  const valid = body && body.byteLength > 0 && body.byteLength <= 60000;
  const out = valid
    ? new Response(body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=2592000, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" } })
    : new Response('', { status: 404, headers: { 'cache-control': 'public, max-age=86400' } });    // the page just keeps its letter badge
  if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}
