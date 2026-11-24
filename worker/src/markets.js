// Live index numbers for the side panel on the homepage:  GET /api/markets  (cached for 5 minutes at the edge).
// Data comes from Yahoo Finance's public chart feed: no key, no cost, and the quotes are delayed. Name Yahoo as the source wherever it is shown.
// If the feed ever fails, the endpoint answers 503 and the website simply hides the panel. Nothing else breaks.
// To change what is shown, edit MARKETS: id (any short word), name (what readers see), symbol (Yahoo's code), region (IN, US or GL), decimals.
export const MARKETS = [
  { id: 'sensex', name: 'Sensex', symbol: '^BSESN', region: 'IN' },
  { id: 'nifty', name: 'Nifty 50', symbol: '^NSEI', region: 'IN' },
  { id: 'usdinr', name: 'USD/INR', symbol: 'INR=X', region: 'IN', decimals: 2 },
  { id: 'nasdaq', name: 'Nasdaq', symbol: '^IXIC', region: 'US' },
  { id: 'sp500', name: 'S&P 500', symbol: '^GSPC', region: 'US' },
  { id: 'brent', name: 'Brent crude', symbol: 'BZ=F', region: 'GL', decimals: 2 },
];

const UA = 'Mozilla/5.0 (compatible; BingleSignalBot/5.0; +https://binglesignal.com)';

// One quote from Yahoo's reply. null when the reply is missing or looks wrong, so a bad number can never be shown.
export function parseQuote(def, body) {
  const meta = body?.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  const previous = Number(meta?.chartPreviousClose ?? meta?.previousClose);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(previous) || previous <= 0) return null;
  const change = price - previous;
  return { id: def.id, name: def.name, region: def.region, price, change, pct: (change / previous) * 100, ...(def.decimals != null ? { decimals: def.decimals } : {}) };
}

export async function loadMarkets(fetchImpl = globalThis.fetch) {
  const quotes = await Promise.all(MARKETS.map(async (def) => {
    try {
      const res = await fetchImpl(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(def.symbol)}?range=1d&interval=1d`,
        { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
      return res.ok ? parseQuote(def, await res.json()) : null;
    } catch { return null; }
  }));
  return quotes.filter(Boolean);
}

const reply = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });

export async function handleMarkets(req, env, ctx, fetchImpl = globalThis.fetch) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(new URL('/api/markets', req.url).toString());
  const hit = cache ? await cache.match(key) : null;
  if (hit) return hit;
  const items = await loadMarkets(fetchImpl);
  if (items.length < 2) return reply({ error: 'markets unavailable' }, 503, { 'cache-control': 'no-store' });
  const out = reply({ v: 1, gen: new Date().toISOString(), source: 'Yahoo Finance', delayed: true, items }, 200,
    { 'cache-control': 'public, max-age=300, stale-while-revalidate=600' });
  if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}
