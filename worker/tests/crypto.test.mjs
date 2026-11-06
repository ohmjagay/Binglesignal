import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiRateLimits, checkApiRateLimit } from '../src/rate-limit.js';
import { decryptField, decryptLegacyToken, encryptField, getUserDek } from '../src/crypto.js';

const userId = 'aaaaaaaa-0000-0000-0000-000000000001';
const env = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  KEK_CURRENT: 'v1',
  KEK_V1: Buffer.alloc(32, 7).toString('base64'),
};

test('Envelope encryption creates a per-user key and authenticates user and purpose', async (t) => {
  const originalFetch = globalThis.fetch;
  const records = new Map();
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    const id = new URLSearchParams(url.search).get('user_id')?.replace(/^eq\./, '');
    if (init.method === 'POST') {
      const record = JSON.parse(init.body);
      records.set(record.user_id, record);
      return Response.json([]);
    }
    return Response.json(records.has(id) ? [records.get(id)] : []);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const dek = await getUserDek(env, userId);
  const encrypted = await encryptField(dek, userId, 'summary_report', '{"summary":"private"}');
  assert.match(encrypted, /^v1\.v1\./);
  assert.equal(await decryptField(dek, userId, 'summary_report', encrypted), '{"summary":"private"}');
  await assert.rejects(decryptField(dek, 'bbbbbbbb-0000-0000-0000-000000000002', 'summary_report', encrypted));
  await assert.rejects(decryptField(dek, userId, 'refresh_token', encrypted));

  const otherDek = await getUserDek(env, 'bbbbbbbb-0000-0000-0000-000000000002');
  assert.notDeepEqual(otherDek, dek);
  assert.equal(records.size, 2);
});

test('Legacy refresh tokens can be decrypted for lazy migration', async () => {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode('old-refresh-token'),
  ));
  const packed = Buffer.from(Uint8Array.from([...iv, ...encrypted])).toString('base64');
  assert.equal(await decryptLegacyToken({ EMAIL_TOKEN_ENCRYPTION_KEY: Buffer.from(rawKey).toString('base64') }, packed), 'old-refresh-token');
});

test('API rate limits retain only the configured sliding-window timestamps', async () => {
  const values = new Map();
  let alarmAt;
  const storage = {
    get: async (key) => values.get(key),
    put: async (key, value) => values.set(key, value),
    delete: async (key) => values.delete(key),
    setAlarm: async (timestamp) => { alarmAt = timestamp; },
  };
  const limiter = new ApiRateLimits({ storage });
  const request = () => new Request('https://rate-limit/check', {
    method: 'POST',
    body: JSON.stringify({ limit: 1, windowMs: 60_000 }),
  });
  assert.equal((await (await limiter.fetch(request())).json()).allowed, true);
  assert.equal((await (await limiter.fetch(request())).json()).allowed, false);
  assert.equal(values.get('events').length, 1);
  assert.ok(alarmAt > Date.now());
});

test('Payment rate limiting fails closed when the trusted client address or binding is missing', async () => {
  assert.deepEqual(await checkApiRateLimit(new Request('https://binglesignal.com/api/checkout'), {}, 'checkout'), { available: false });
  let action;
  const envWithLimiter = {
    API_RATE_LIMITS: {
      idFromName: (name) => { action = name; return name; },
      get: () => ({ fetch: async () => Response.json({ allowed: false }) }),
    },
  };
  const result = await checkApiRateLimit(new Request('https://binglesignal.com/api/checkout', {
    headers: { 'cf-connecting-ip': '203.0.113.4' },
  }), envWithLimiter, 'checkout');
  assert.deepEqual(result, { available: true, allowed: false });
  assert.equal(action, 'checkout:203.0.113.4');
});
