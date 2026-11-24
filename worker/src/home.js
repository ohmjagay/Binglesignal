// Pre-rendered homepage: the top headlines are written into the page's HTML before it leaves the Worker, so Google, WhatsApp and LinkedIn
// (and anyone with JavaScript switched off) can read the news without waiting for scripts. The website then replaces this list with the full
// interactive version and removes it (see home.js in /public).
// The homepage can never break because of this: any problem at all returns the plain page exactly as it is stored.
const MARKER = '<!--SEO-NEWS-->';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : '#');

export function renderSeoNews(items, limit = 12) {
  const list = (Array.isArray(items) ? items : []).filter((i) => i && i.t && /^https?:\/\//i.test(i.u || '')).slice(0, limit);
  if (!list.length) return '';
  const li = list.map((i) => `<li><a href="${esc(safeUrl(i.u))}" rel="noopener noreferrer">${esc(i.t)}</a> <small>${esc(i.s)}</small></li>`).join('');
  const data = { '@context': 'https://schema.org', '@type': 'ItemList', name: 'Top stories on BingleSignal',
    itemListElement: list.map((i, n) => ({ '@type': 'ListItem', position: n + 1, name: i.t, url: i.u })) };
  const ld = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<section id="seo-news" class="seo-news" aria-label="Top stories"><h2 class="serif">Top stories right now</h2><ol>${li}</ol></section><script type="application/ld+json">${ld}</script>`;
}

// `getItems` returns the teaser headlines (or null). Returns the homepage response.
export async function handleHome(req, env, getItems) {
  const asset = await env.ASSETS.fetch(req);
  try {
    if (req.method !== 'GET' || !asset.ok || !/text\/html/i.test(asset.headers.get('content-type') || '')) return asset;
    const html = await asset.clone().text();
    if (!html.includes(MARKER)) return asset;
    const items = await getItems();
    if (!items?.length) return asset;
    const headers = new Headers(asset.headers);
    headers.delete('content-length');
    return new Response(html.replace(MARKER, renderSeoNews(items)), { status: asset.status, headers });
  } catch (error) {
    console.error('home: served the plain page because pre-rendering failed:', error?.message || error);
    return asset;
  }
}
