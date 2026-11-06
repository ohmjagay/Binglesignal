// BingleSignal API: runs on Cloudflare Workers inside the same deploy as the website.
// Only /api/* reaches this file; every other URL is served straight from /public.
//   GET  /api/health
//   POST /api/checkout           logged-in user picks a plan -> Razorpay subscription (India) or payment link (global)
//   POST /api/webhooks/razorpay  Razorpay tells us a payment happened
//   POST /api/webhooks/global    international provider (Standard Webhooks format, e.g. Dodo Payments)
// Secrets needed: see wrangler.example.toml
import { handleDeleteEmailData, handleEmailRequest, handleEmailSchedule } from './email-beta.js';
import { checkApiRateLimit } from './rate-limit.js';
export { EmailAiBudget } from './llm.js';
export { ApiRateLimits } from './rate-limit.js';

const enc = new TextEncoder();
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, enc.encode(message));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- signature checks (proof the message really came from the payment provider) ----------
export async function verifyRazorpay(raw, signature, secret) {
  if (!signature || !secret) return false;
  return safeEqual(toHex(await hmac(enc.encode(secret), raw)), signature);
}
export async function verifyStandardWebhook(raw, headers, secret, now = Date.now(), toleranceSec = 300) {
  const id = headers.get('webhook-id'), ts = headers.get('webhook-timestamp'), sigs = headers.get('webhook-signature');
  if (!id || !ts || !sigs || !secret) return false;
  if (toleranceSec && Math.abs(now / 1000 - Number(ts)) > toleranceSec) return false;
  const expected = toB64(await hmac(fromB64(secret.replace(/^whsec_/, '')), `${id}.${ts}.${raw}`));
  return sigs.split(' ').some((s) => { const [v, sig] = s.split(','); return v === 'v1' && safeEqual(sig, expected); });
}

// ---------- payment events -> subscription changes ----------
export function mapRazorpay(evt) {
  const e = evt?.payload?.subscription?.entity;
  if (!e) return null;
  const notes = e.notes || {};
  const at = evt.created_at ? new Date(evt.created_at * 1000).toISOString() : new Date().toISOString();
  const base = { provider: 'razorpay', provider_subscription_id: e.id, provider_customer_id: e.customer_id || null, currency: 'INR', last_event_at: at,
    ...(notes.plan === 'lite' || notes.plan === 'pro' ? { plan: notes.plan } : {}) };
  const end = e.current_end ? { current_period_end: new Date(e.current_end * 1000).toISOString() } : {};
  const who = notes.user_id ? { user_id: notes.user_id } : null;
  if (!who) return null;
  switch (evt.event) {
    case 'subscription.authenticated': return { who, patch: base };                       // mandate set up; trial keeps running
    case 'subscription.activated':
    case 'subscription.charged':
    case 'subscription.resumed': return { who, patch: { ...base, ...end, status: 'active', cancel_at_period_end: false } };
    case 'subscription.pending': return { who, patch: { ...base, status: 'past_due' } };  // payment failed, Razorpay retrying
    case 'subscription.halted':
    case 'subscription.completed': return { who, patch: { ...base, status: 'expired' } };
    case 'subscription.cancelled': return { who, patch: { ...base, ...end, status: 'canceled' } }; // access until period end
    default: return null;
  }
}
export function mapGlobal(evt, env = {}) {
  const d = evt?.data || {}, md = d.metadata || {};
  const who = md.user_id ? { user_id: md.user_id } : d.customer?.email ? { email: d.customer.email } : null;
  if (!who) return null;
  const plan = md.plan === 'lite' || md.plan === 'pro' ? md.plan
    : env.GLOBAL_PRODUCT_PRO && d.product_id === env.GLOBAL_PRODUCT_PRO ? 'pro'
    : env.GLOBAL_PRODUCT_LITE && d.product_id === env.GLOBAL_PRODUCT_LITE ? 'lite' : null;
  const base = { provider: 'global', currency: 'USD', provider_subscription_id: d.subscription_id || null,
    provider_customer_id: d.customer?.customer_id || null, last_event_at: evt.timestamp ? new Date(evt.timestamp).toISOString() : new Date().toISOString(),
    ...(plan ? { plan } : {}) };
  const end = d.next_billing_date ? { current_period_end: new Date(d.next_billing_date).toISOString() } : {};
  switch (evt.type) {
    case 'subscription.active':
    case 'subscription.renewed': return { who, patch: { ...base, ...end, status: 'active', cancel_at_period_end: false } };
    case 'subscription.on_hold':
    case 'subscription.failed': return { who, patch: { ...base, status: 'past_due' } };
    case 'subscription.cancelled': return { who, patch: { ...base, status: 'canceled' } };
    case 'subscription.expired': return { who, patch: { ...base, status: 'expired' } };
    default: return null;
  }
}

// ---------- Supabase (server-side, service key) ----------
const sb = (env, path, init = {}) =>
  fetch(`${env.SUPABASE_URL}${path}`, { ...init, headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json', ...init.headers } });

async function applyPatch(env, m, eventId, provider, type) {
  const who = m.who.user_id ? `user_id=eq.${encodeURIComponent(m.who.user_id)}` : `email=eq.${encodeURIComponent(m.who.email.toLowerCase())}`;
  // ignore stale events: only apply if this event is not older than the last one we applied
  const fresh = m.patch.last_event_at ? `&or=(last_event_at.is.null,last_event_at.lte.${m.patch.last_event_at})` : '';
  const r = await sb(env, `/rest/v1/subscriptions?${who}${fresh}`, { method: 'PATCH', headers: { prefer: 'return=minimal' },
    body: JSON.stringify({ ...m.patch, updated_at: new Date().toISOString() }) });
  if (!r.ok) throw new Error(`subscriptions update failed: ${r.status}`);
  if (eventId) await sb(env, '/rest/v1/webhook_events', { method: 'POST', headers: { prefer: 'return=minimal' },
    body: JSON.stringify({ id: `${provider}:${eventId}`, provider, type }) }).catch(() => {});
}

async function handleRazorpay(req, env) {
  const raw = await req.text();
  if (!(await verifyRazorpay(raw, req.headers.get('x-razorpay-signature'), env.RAZORPAY_WEBHOOK_SECRET))) return json({ error: 'bad signature' }, 401);
  let evt; try { evt = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }
  const m = mapRazorpay(evt);
  if (!m) return json({ ok: true, ignored: evt.event });
  await applyPatch(env, m, req.headers.get('x-razorpay-event-id'), 'razorpay', evt.event);
  return json({ ok: true });
}
async function handleGlobal(req, env) {
  const raw = await req.text();
  if (!(await verifyStandardWebhook(raw, req.headers, env.GLOBAL_WEBHOOK_SECRET))) return json({ error: 'bad signature' }, 401);
  let evt; try { evt = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }
  const m = mapGlobal(evt, env);
  if (!m) return json({ ok: true, ignored: evt.type });
  await applyPatch(env, m, req.headers.get('webhook-id'), 'global', evt.type);
  return json({ ok: true });
}

// ---------- checkout ----------
async function handleCheckout(req, env) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'login required' }, 401);
  const u = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}` } });
  if (!u.ok) return json({ error: 'invalid session' }, 401);
  const user = await u.json();
  let body = {}; try { body = await req.json(); } catch {}
  const plan = body.plan === 'lite' || body.plan === 'pro' ? body.plan : null;
  const interval = body.interval === 'year' ? 'year' : 'month';
  if (!plan) return json({ error: 'plan must be lite or pro' }, 400);

  // Indian visitors pay in INR via Razorpay (they may choose USD); everyone else pays in USD
  const india = req.headers.get('cf-ipcountry') === 'IN' && body.region !== 'GLOBAL';
  if (!india) {
    const base = env[`GLOBAL_LINK_${plan.toUpperCase()}_${interval.toUpperCase()}`];
    if (!base) return json({ error: 'plan not configured' }, 500);
    const tpl = env.GLOBAL_LINK_PARAMS || 'email={email}&metadata_user_id={user_id}&metadata_plan={plan}';
    const q = tpl.replace('{email}', encodeURIComponent(user.email || '')).replace('{user_id}', encodeURIComponent(user.id)).replace('{plan}', plan);
    return json({ provider: 'global', url: base + (base.includes('?') ? '&' : '?') + q });
  }
  const planId = env[`RAZORPAY_PLAN_${plan.toUpperCase()}_${interval === 'year' ? 'YEARLY' : 'MONTHLY'}`];
  if (!planId) return json({ error: 'plan not configured' }, 500);
  // keep the unused trial days: first charge starts when the trial ends
  let startAt;
  try {
    const rows = await (await sb(env, `/rest/v1/subscriptions?user_id=eq.${user.id}&select=status,trial_ends_at`)).json();
    const end = rows?.[0]?.status === 'trialing' ? Date.parse(rows[0].trial_ends_at) : 0;
    if (end - Date.now() > 15 * 60 * 1000) startAt = Math.floor(end / 1000);
  } catch {}
  const r = await fetch('https://api.razorpay.com/v1/subscriptions', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`) },
    body: JSON.stringify({ plan_id: planId, total_count: interval === 'year' ? 10 : 120, quantity: 1, customer_notify: 1,
      notes: { user_id: user.id, plan, interval }, ...(startAt ? { start_at: startAt } : {}) }) });
  const data = await r.json();
  if (!r.ok) return json({ error: data?.error?.description || 'razorpay error' }, 502);
  return json({ provider: 'razorpay', key_id: env.RAZORPAY_KEY_ID, subscription_id: data.id, short_url: data.short_url });
}

// ---------- cancel (Razorpay: at cycle end. International: manual until a portal link is configured) ----------
async function authUser(req, env) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const u = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}` } });
  return u.ok ? u.json() : null;
}
async function handleCancel(req, env) {
  const user = await authUser(req, env);
  if (!user) return json({ error: 'login required' }, 401);
  const rows = await (await sb(env, `/rest/v1/subscriptions?user_id=eq.${user.id}&select=provider,provider_subscription_id,status,current_period_end`)).json();
  const s = rows?.[0];
  if (!s || s.status !== 'active' || !s.provider_subscription_id) return json({ error: 'no active subscription to cancel' }, 404);
  if (s.provider !== 'razorpay') return json({ ok: true, manual: true });
  const r = await fetch(`https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(s.provider_subscription_id)}/cancel`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`) },
    body: JSON.stringify({ cancel_at_cycle_end: 1 }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: data?.error?.description || 'razorpay error' }, 502);
  await sb(env, `/rest/v1/subscriptions?user_id=eq.${user.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' },
    body: JSON.stringify({ cancel_at_period_end: true, updated_at: new Date().toISOString() }) });
  return json({ ok: true, ends_at: s.current_period_end });
}

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    try {
      if (p === '/api/health') return json({ ok: true, time: new Date().toISOString(), country: req.headers.get('cf-ipcountry') || null,
        rails: { razorpay: !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_PLAN_LITE_MONTHLY && env.RAZORPAY_PLAN_PRO_MONTHLY),
                 global: !!(env.GLOBAL_LINK_LITE_MONTH && env.GLOBAL_LINK_PRO_MONTH) } });
      if (p === '/api/privacy/delete-email-data') return await handleDeleteEmailData(req, env);
      if (p.startsWith('/api/email/')) return await handleEmailRequest(req, env);
      if (req.method !== 'POST') return json({ error: 'not found' }, 404);
      if (p === '/api/checkout' || p === '/api/cancel') {
        const action = p === '/api/checkout' ? 'checkout' : 'cancel';
        const limit = await checkApiRateLimit(req, env, action);
        if (!limit.available) return json({ error: 'Rate limiting is temporarily unavailable; please try again shortly' }, 503);
        if (!limit.allowed) return new Response(JSON.stringify({ error: 'Too many requests; please try again later' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': action === 'checkout' ? '600' : '3600' },
        });
        if (action === 'checkout') return await handleCheckout(req, env);
        return await handleCancel(req, env);
      }
      if (p === '/api/webhooks/razorpay') return await handleRazorpay(req, env);
      if (p === '/api/webhooks/global') return await handleGlobal(req, env);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: 'server error' }, 500);   // provider will retry
    }
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(handleEmailSchedule(controller.cron, env));
  },
};
