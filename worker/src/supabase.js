// Names of Supabase settings that are missing (or malformed) on this Worker. Empty list = fine.
// These three must be added in Cloudflare -> Workers & Pages -> <your Worker> -> Settings -> Variables and Secrets,
// as type "Secret" (see docs/FIX-2026-11-11.md). Only names are ever reported, never values.
export function missingSupabaseConfig(env = {}, names = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  return names.filter((name) => {
    const value = String(env[name] || '').trim();
    if (!value) return true;
    return name === 'SUPABASE_URL' && !/^https:\/\/[^/\s]+$/.test(value); // must look like https://xxxx.supabase.co (no trailing slash)
  });
}

// Headers that identify THIS server to Supabase. A legacy key (long, starts with "eyJ") is also sent as the Bearer token, exactly
// as before. The newer keys (sb_secret_..., sb_publishable_...) are not JWTs: Supabase says to send them in the apikey header
// only, so no Authorization header is added for them. This makes either kind of key work.
export const supabaseKeyHeaders = (key) => ({
  apikey: key,
  ...(/^sb_(secret|publishable)_/.test(String(key || '')) ? {} : { authorization: `Bearer ${key}` }),
});

export const supabaseRequest = (env, path, init = {}) =>
  fetch(`${env.SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      ...supabaseKeyHeaders(env.SUPABASE_SERVICE_ROLE_KEY),
      'content-type': 'application/json',
      ...init.headers,
    },
  });

export async function authUser(req, env) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are not set on this Worker (add them as Secrets in Cloudflare)');
  }
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    console.warn('Supabase rejected the sign-in token', response.status);
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
