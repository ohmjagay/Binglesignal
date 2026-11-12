// BingleSignal pricing: ONE price for the whole world, $5 a month.
//
//   Outside India  -> $5.00 charged in US dollars.
//   India          -> the visitor chooses USD ($5.00) or rupees. Rupees are worked out live:
//                       base     = round( $5 x today's USD->INR rate )        (whole rupees)
//                       GST      = round( base x GST_PERCENT / 100 )          (whole rupees)
//                       rounding = up to the next INR 5
//                       total    = base + GST + rounding                      <- what the customer pays every month
//
// HOW THE RUPEE AMOUNT REACHES RAZORPAY
// A Razorpay plan has a fixed price, but a Razorpay subscription can be created with a `quantity`
// (amount charged = plan amount x quantity, and Razorpay allows a quantity of at most 500). So the INR plan in Razorpay is a FIVE-RUPEE "unit" plan and each
// new subscriber gets quantity = their total / 5 (about 110 today, 500 would be INR 2,500). The rupee amount is fixed when they subscribe and stays the same every month.
//
// Change the price here (USD_PRICE) AND in public/config.js (price.usd) AND in the Razorpay USD plan: all three must say 5.

export const USD_PRICE = 5;
export const DEFAULT_GST_PERCENT = 18;
const RATE_MIN = 40;            // anything outside this range is treated as a broken feed, never as a price
const RATE_MAX = 300;
const RATE_TTL_SECONDS = 3600;  // reference rates change once a day; an hour of caching also keeps us inside the free API limits
export const UNIT_RUPEES = 5;   // the INR plan MUST be exactly INR 5.00 a month; the customer's total is always a multiple of this
export const MAX_QUANTITY = 500; // Razorpay's own limit on a subscription quantity
const UNIT_PLAN_PAISE = UNIT_RUPEES * 100;

export class QuoteUnavailable extends Error {
  constructor(message = 'Live exchange rate unavailable') { super(message); this.name = 'QuoteUnavailable'; }
}
export class PlanMisconfigured extends Error {
  constructor(message) { super(message); this.name = 'PlanMisconfigured'; }
}

// GST_PERCENT is optional. Leave it unset for 18. Set it to 0 if you are NOT registered for GST yet (you may not charge GST without a GSTIN).
export function gstPercent(env = {}) {
  const raw = env.GST_PERCENT;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_GST_PERCENT;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 40 ? value : DEFAULT_GST_PERCENT;
}

export function buildInrQuote(rate, env = {}, meta = {}) {
  const gst = gstPercent(env);
  const base = Math.round(USD_PRICE * rate);
  const gstInr = Math.round(base * gst / 100);
  const subtotal = base + gstInr;
  const total = Math.ceil(subtotal / UNIT_RUPEES) * UNIT_RUPEES;
  if (total / UNIT_RUPEES > MAX_QUANTITY) throw new QuoteUnavailable('Rupee total is outside what Razorpay can bill');
  return {
    usd: USD_PRICE,
    rate: Math.round(rate * 10000) / 10000,
    base_inr: base,
    gst_percent: gst,
    gst_inr: gstInr,
    rounding_inr: total - subtotal,
    total_inr: total,
    unit_inr: UNIT_RUPEES,
    quantity: total / UNIT_RUPEES,
    source: meta.source || '',
    as_of: meta.at || new Date().toISOString(),
  };
}

async function readRate(url, pick) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`rate source answered ${response.status}`);
  const value = Number(pick(await response.json()));
  if (!(value >= RATE_MIN && value <= RATE_MAX)) throw new Error(`implausible USD->INR rate: ${value}`);
  return value;
}

// Free, keyless daily reference rates. First choice is the ECB table via Frankfurter, second is ExchangeRate-API's open endpoint.
const SOURCES = [
  ['Frankfurter (ECB reference rate)', 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR', (data) => data?.rates?.INR],
  ['ExchangeRate-API', 'https://open.er-api.com/v6/latest/USD', (data) => data?.rates?.INR],
];

export async function usdInrRate(env = {}) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request('https://fx.binglesignal.internal/usd-inr');
  if (cache) {
    try { const hit = await cache.match(cacheKey); if (hit) return await hit.json(); } catch { /* a cache miss is fine */ }
  }
  for (const [source, url, pick] of SOURCES) {
    try {
      const result = { rate: await readRate(url, pick), source, at: new Date().toISOString() };
      if (cache) {
        try {
          await cache.put(cacheKey, new Response(JSON.stringify(result), {
            headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${RATE_TTL_SECONDS}` },
          }));
        } catch { /* caching is an optimisation only */ }
      }
      return result;
    } catch (error) {
      console.error(`FX source failed (${source}): ${error.message}`);
    }
  }
  // Last resort, only if you set it yourself in Cloudflare: a rate you trust, e.g. FX_FALLBACK_USD_INR=88.5
  const fallback = Number(env.FX_FALLBACK_USD_INR);
  if (fallback >= RATE_MIN && fallback <= RATE_MAX) return { rate: fallback, source: 'fallback', at: new Date().toISOString() };
  throw new QuoteUnavailable();
}

export async function getInrQuote(env = {}) {
  const { rate, source, at } = await usdInrRate(env);
  return buildInrQuote(rate, env, { source, at });
}

// Safety net: quantity pricing is only correct if the INR plan really is a one-rupee plan.
// Without this check an old 299-rupee (or 1-rupee) plan in RAZORPAY_PLAN_LITE_MONTHLY would charge the wrong amount.
const verifiedPlans = new Map();
export async function assertInrUnitPlan(env, planId) {
  if (verifiedPlans.get(planId) === true) return;
  const response = await fetch(`https://api.razorpay.com/v1/plans/${encodeURIComponent(planId)}`, {
    headers: { authorization: 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`) },
  });
  if (!response.ok) throw new PlanMisconfigured(`Razorpay could not read the INR plan (${response.status})`);
  const plan = await response.json();
  const item = plan?.item || {};
  if (item.currency !== 'INR' || Number(item.amount) !== UNIT_PLAN_PAISE) {
    throw new PlanMisconfigured(`RAZORPAY_PLAN_LITE_MONTHLY must be a plan of exactly INR 5.00 per month (found ${item.currency} ${Number(item.amount) / 100})`);
  }
  verifiedPlans.set(planId, true);
}

// GET /api/quote  -> what the checkout page shows. Nothing here can change what is charged: /api/checkout recomputes everything itself.
export async function handleQuote(req, env) {
  const country = req.headers.get('cf-ipcountry') || null;
  const body = { usd: USD_PRICE, country, inr: null };
  if (country === 'IN' || country === null) {
    try { body.inr = await getInrQuote(env); } catch (error) { if (!(error instanceof QuoteUnavailable)) throw error; }
  }
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
