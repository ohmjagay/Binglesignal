const WINDOW_LIMITS = Object.freeze({
  checkout: { limit: 5, windowMs: 10 * 60 * 1000 },
  cancel: { limit: 3, windowMs: 60 * 60 * 1000 },
});

export async function checkApiRateLimit(req, env, action) {
  const policy = WINDOW_LIMITS[action];
  if (!policy) throw new Error('Unknown rate-limit action');
  const ip = req.headers.get('cf-connecting-ip');
  if (!ip || !env.API_RATE_LIMITS) return { available: false };
  const key = `${action}:${ip}`;
  const id = env.API_RATE_LIMITS.idFromName(key);
  const response = await env.API_RATE_LIMITS.get(id).fetch('https://rate-limit/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(policy),
  });
  if (!response.ok) return { available: false };
  const result = await response.json();
  return { available: true, allowed: result.allowed === true };
}

export class ApiRateLimits {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (new URL(request.url).pathname !== '/check' || request.method !== 'POST') {
      return Response.json({ error: 'not found' }, { status: 404 });
    }
    const policy = await request.json();
    if (!Number.isSafeInteger(policy.limit) || policy.limit < 1 ||
        !Number.isSafeInteger(policy.windowMs) || policy.windowMs < 1) {
      return Response.json({ error: 'invalid rate-limit policy' }, { status: 400 });
    }
    const now = Date.now();
    const cutoff = now - policy.windowMs;
    const events = (await this.state.storage.get('events') || []).filter((timestamp) => timestamp > cutoff);
    await this.state.storage.put('window_ms', policy.windowMs);
    if (events.length >= policy.limit) {
      await this.state.storage.put('events', events);
      await this.state.storage.setAlarm(events[0] + policy.windowMs);
      return Response.json({ allowed: false });
    }
    events.push(now);
    await this.state.storage.put('events', events);
    await this.state.storage.setAlarm(events[0] + policy.windowMs);
    return Response.json({ allowed: true });
  }

  async alarm() {
    const windowMs = await this.state.storage.get('window_ms') || 0;
    const events = (await this.state.storage.get('events') || []).filter((timestamp) => timestamp > Date.now() - windowMs);
    if (!events.length) {
      await this.state.storage.delete('events');
      await this.state.storage.delete('window_ms');
      return;
    }
    await this.state.storage.put('events', events);
    await this.state.storage.setAlarm(events[0] + windowMs);
  }
}
