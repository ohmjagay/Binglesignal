// A friendly "Page not found" for people. Browsers get the same page as public/404.html; programs asking for JSON still get {"error":"not found"}.
const FALLBACK = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found - BingleSignal</title>'
  + '<meta name="robots" content="noindex"><link rel="stylesheet" href="/style.css"></head><body><main class="legal" style="text-align:center;margin-top:12vh"><h1 class="serif">We could not find that page</h1>'
  + '<p>The link may be old or mistyped. Your briefing is one click away.</p><p><a class="btn fill" href="/">Back to the news</a></p></main></body></html>';

export async function notFound(req, env) {
  if (!(req.headers.get('accept') || '').includes('text/html')) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  let html = FALLBACK;
  try {
    const page = await env?.ASSETS?.fetch(new Request(new URL('/404.html', req.url)));
    if (page?.ok) html = await page.text();
  } catch { /* the built-in page above is used */ }
  return new Response(html, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
