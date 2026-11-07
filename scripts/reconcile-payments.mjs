import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.razorpay.com/v1/subscriptions';
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

const PLAN_KEYS = [
  ['RAZORPAY_PLAN_LITE_MONTHLY', 'lite', 'month', 'INR'],
  ['RAZORPAY_PLAN_PRO_MONTHLY', 'pro', 'month', 'INR'],
  ['RAZORPAY_PLAN_LITE_YEARLY', 'lite', 'year', 'INR'],
  ['RAZORPAY_PLAN_PRO_YEARLY', 'pro', 'year', 'INR'],
  ['RAZORPAY_PLAN_LITE_MONTHLY_USD', 'lite', 'month', 'USD'],
  ['RAZORPAY_PLAN_PRO_MONTHLY_USD', 'pro', 'month', 'USD'],
  ['RAZORPAY_PLAN_LITE_YEARLY_USD', 'lite', 'year', 'USD'],
  ['RAZORPAY_PLAN_PRO_YEARLY_USD', 'pro', 'year', 'USD'],
];

function getPlan(planId, env) {
  for (const [key, plan, billingInterval, currency] of PLAN_KEYS) {
    if (env[key] && env[key] === planId) return { plan, billing_interval: billingInterval, currency };
  }
  return null;
}

function subscriptionPatch(entity, env) {
  const status = {
    authenticated: null,
    active: 'active',
    pending: 'past_due',
    halted: 'expired',
    completed: 'expired',
    cancelled: 'canceled',
    paused: 'canceled',
    resumed: 'active',
  }[entity.status];
  if (!status || !entity.notes?.user_id) return null;
  const plan = getPlan(entity.plan_id, env);
  if (!plan) return { unknownPlan: true };
  const updatedAt = entity.updated_at || entity.created_at || Math.floor(Date.now() / 1000);
  return {
    userId: entity.notes.user_id,
    patch: {
      ...plan,
      provider: 'razorpay',
      provider_subscription_id: entity.id,
      provider_customer_id: entity.customer_id || null,
      status,
      ...(entity.current_end ? { current_period_end: new Date(entity.current_end * 1000).toISOString() } : {}),
      cancel_at_period_end: entity.status === 'cancelled' || entity.status === 'paused',
      last_event_at: new Date(updatedAt * 1000).toISOString(),
    },
  };
}

export async function reconcilePayments(env = process.env, fetchImpl = fetch) {
  for (const key of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (!env[key]) throw new Error(`Missing required reconciliation setting: ${key}`);
  }
  const authorization = `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;
  let scanned = 0, updated = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(API);
    url.searchParams.set('count', String(PAGE_SIZE));
    url.searchParams.set('skip', String(page * PAGE_SIZE));
    const response = await fetchImpl(url, { headers: { authorization } });
    if (!response.ok) throw new Error(`Razorpay subscription listing failed (${response.status})`);
    const rows = (await response.json()).items || [];
    for (const entity of rows) {
      scanned++;
      const result = subscriptionPatch(entity, env);
      if (!result) continue;
      if (result.unknownPlan) {
        console.error('Payment reconciliation found an unconfigured plan', {
          subscription_id: entity.id || null,
          plan_id: entity.plan_id || null,
        });
        continue;
      }
      const patchUrl = new URL('/rest/v1/subscriptions', env.SUPABASE_URL);
      patchUrl.searchParams.set('user_id', `eq.${result.userId}`);
      patchUrl.searchParams.set('or', `(last_event_at.is.null,last_event_at.lte.${result.patch.last_event_at})`);
      const saved = await fetchImpl(patchUrl, {
        method: 'PATCH',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'content-type': 'application/json',
          prefer: 'return=minimal',
        },
        body: JSON.stringify(result.patch),
      });
      if (!saved.ok) throw new Error(`Subscription reconciliation update failed (${saved.status})`);
      updated++;
    }
    if (rows.length < PAGE_SIZE) return { scanned, updated };
  }
  throw new Error(`Razorpay reconciliation exceeded ${MAX_PAGES * PAGE_SIZE} subscriptions; increase the bounded page limit.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  reconcilePayments().then(({ scanned, updated }) => {
    console.log('Payment reconciliation completed', { scanned, updated });
  }).catch((error) => {
    console.error('Payment reconciliation failed', { error: error.message });
    process.exitCode = 1;
  });
}
