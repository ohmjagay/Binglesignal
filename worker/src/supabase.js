export const supabaseRequest = (env, path, init = {}) =>
  fetch(`${env.SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });

export async function authUser(req, env) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}` },
  });
  return response.ok ? response.json() : null;
}

export async function hasProAccess(userId, env) {
  const response = await supabaseRequest(env,
    `/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=plan,status,trial_ends_at,current_period_end&limit=1`);
  if (!response.ok) throw new Error(`subscription lookup failed: ${response.status}`);
  const [subscription] = await response.json();
  if (!subscription || subscription.plan !== 'pro') return false;
  const now = Date.now();
  if (subscription.status === 'trialing') return Date.parse(subscription.trial_ends_at) > now;
  if (subscription.status === 'active') return !subscription.current_period_end || Date.parse(subscription.current_period_end) + 2 * 864e5 > now;
  if (subscription.status === 'past_due') return Date.parse(subscription.current_period_end || subscription.trial_ends_at) + 3 * 864e5 > now;
  if (subscription.status === 'canceled') return !!subscription.current_period_end && Date.parse(subscription.current_period_end) > now;
  return false;
}
