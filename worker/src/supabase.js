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
  if (!token) return null;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be configured for email beta authentication');
  }
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    console.warn('email beta Supabase rejected the access token', response.status);
    return null;
  }
  return response.json();
}

export function hasSecondFactor(req) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const encoded = token.split('.')[1];
  if (!encoded) return false;
  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')));
    return payload.aal === 'aal2';
  } catch {
    return false;
  }
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
