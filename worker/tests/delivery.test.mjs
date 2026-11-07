import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import worker from '../src/index.js';
import { deliverEdition, makeUnsubscribeUrl, renderEditionText, sendEditionEmail } from '../src/delivery.js';
import { handleEditionSchedule } from '../src/briefing.js';

const userId = 'aaaaaaaa-0000-0000-0000-000000000001';
const session = `header.${Buffer.from(JSON.stringify({ sub: userId, aal: 'aal1' })).toString('base64url')}.signature`;
const baseEnv = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
};
const json = (body, status = 200) => Response.json(body, { status });
const get = (path) => new Request(`https://binglesignal.com${path}`, { headers: { authorization: ['Bearer', session].join(' ') } });
const post = (path, body, headers = {}) => new Request(`https://binglesignal.com${path}`, {
  method: 'POST',
  headers: { authorization: ['Bearer', session].join(' '), 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

function installFetch(context, responder) {
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  globalThis.fetch = responder;
}

const edition = {
  user_id: userId,
  slot_key: `${userId}:2026-02-01:0700`,
  local_date: '2026-02-01',
  items: [{
    story_id: 'story1',
    item: { headline: 'A market update', why_it_matters: 'It may affect your industry.', u: 'https://news.example/story' },
    why_it_matters: 'It may affect your industry.',
  }],
  safely_ignore: [{ headline: 'A lower-priority update' }],
};

test('email edition uses plain text and includes an unsubscribe link and physical address', () => {
  const body = renderEditionText(edition, '100 Example Road, Example City', 'https://binglesignal.com/api/unsubscribe?sig=example');
  assert.match(body, /A market update/);
  assert.match(body, /https:\/\/news\.example\/story/);
  assert.match(body, /Unsubscribe: https:\/\/binglesignal\.com/);
  assert.match(body, /Mailing address: 100 Example Road/);
  assert.doesNotMatch(body, /<html|<script|<a\s/i);
});

test('email delivery refuses to send until a real mailing address is configured', async () => {
  await assert.rejects(sendEditionEmail({
    RESEND_API_KEY: 'test-key',
    DELIVERY_EMAIL_PROVIDER: 'resend',
    DELIVERY_FROM_EMAIL: 'brief@example.com',
    DELIVERY_UNSUBSCRIBE_SECRET: 'test-secret',
  }, 'reader@example.com', edition, userId), /mailing address is not configured/);
});

test('Resend provider sends only a plain-text body and records provider response metadata', async (context) => {
  let outbound;
  installFetch(context, async (input, init) => {
    assert.equal(String(input), 'https://api.resend.com/emails');
    outbound = { headers: init.headers, body: JSON.parse(init.body) };
    return json({ id: 'msg_123' });
  });
  const result = await sendEditionEmail({
    RESEND_API_KEY: 'test-key',
    DELIVERY_EMAIL_PROVIDER: 'resend',
    DELIVERY_FROM_EMAIL: 'brief@example.com',
    DELIVERY_PHYSICAL_ADDRESS: '100 Example Road',
    DELIVERY_UNSUBSCRIBE_SECRET: 'test-secret',
  }, 'reader@example.com', edition, userId);
  assert.equal(result.messageId, 'msg_123');
  assert.equal(outbound.body.text.includes('Mailing address: 100 Example Road'), true);
  assert.equal('html' in outbound.body, false);
  assert.match(outbound.headers.authorization, /^Bearer /);
  assert.match(outbound.body.headers['List-Unsubscribe'], /api\/unsubscribe/);
});

test('Amazon SES provider signs a plain-text request', async (context) => {
  let outbound;
  installFetch(context, async (input, init) => {
    assert.equal(String(input), 'https://email.us-east-1.amazonaws.com/v2/email/outbound-emails');
    outbound = { headers: init.headers, body: JSON.parse(init.body) };
    return json({ MessageId: 'ses_123' });
  });
  const result = await sendEditionEmail({
    DELIVERY_EMAIL_PROVIDER: 'ses',
    DELIVERY_FROM_EMAIL: 'brief@example.com',
    DELIVERY_PHYSICAL_ADDRESS: '100 Example Road',
    DELIVERY_UNSUBSCRIBE_SECRET: 'test-secret',
    SES_REGION: 'us-east-1',
    SES_ACCESS_KEY_ID: 'test-access',
    SES_SECRET_ACCESS_KEY: 'test-secret',
  }, 'reader@example.com', edition, userId);
  assert.equal(result.messageId, 'ses_123');
  assert.match(outbound.headers.authorization, /^AWS4-HMAC-SHA256/);
  assert.equal(outbound.body.Content.Simple.Body.Text.Data.includes('Mailing address: 100 Example Road'), true);
  assert.equal(outbound.body.Content.Simple.Body.Html, undefined);
});

test('email delivery claims a user-owned slot and records status without storing edition text', async (context) => {
  const calls = [];
  installFetch(context, async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url.pathname.endsWith('/claim_edition_delivery')) return json(true);
    if (url.pathname === `/auth/v1/admin/users/${userId}`) {
      return json({ email: 'reader@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' });
    }
    if (url.hostname === 'api.resend.com') return json({ id: 'msg_456' });
    if (url.pathname.endsWith('/delivery_logs')) return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const result = await deliverEdition({
    ...baseEnv,
    RESEND_API_KEY: 'test-key',
    DELIVERY_EMAIL_PROVIDER: 'resend',
    DELIVERY_FROM_EMAIL: 'brief@example.com',
    DELIVERY_PHYSICAL_ADDRESS: '100 Example Road',
    DELIVERY_UNSUBSCRIBE_SECRET: 'test-secret',
  }, { delivery_channel: 'email' }, edition);
  assert.equal(result.status, 'sent');
  const claim = calls.find(({ url }) => url.pathname.endsWith('/claim_edition_delivery'));
  assert.equal(claim.body.p_user_id, userId);
  assert.equal(claim.body.p_slot_key, edition.slot_key);
  const log = calls.find(({ url, init }) => url.pathname.endsWith('/delivery_logs') && init.method === 'PATCH');
  assert.equal(log.url.searchParams.get('user_id'), `eq.${userId}`);
  assert.equal(log.body.status, 'sent');
  assert.equal(log.body.provider_message_id, 'msg_456');
  assert.equal('items' in log.body, false);
});

test('15-minute edition schedule sends email for the generated timezone-local slot', async (context) => {
  const calls = [];
  installFetch(context, async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url.pathname.endsWith('/claim_due_edition_slots')) return json([{
      user_id: userId, plan: 'lite', timezone: 'Asia/Kolkata', local_date: '2026-02-01',
      local_slot: '07:00:00', slot_key: edition.slot_key,
    }]);
    if (url.pathname.endsWith('/user_profile_v2')) return json([{
      user_id: userId, role: 'other', timezone: 'Asia/Kolkata', delivery_channel: 'email',
      delivery_time: '07:00:00', interests: [], blocked_topics: [], muted_sources: [],
    }]);
    if (['/watchlists', '/feedback', '/editions', '/story_clusters'].some(path => url.pathname.endsWith(path))) {
      if (init.method === 'POST' && url.pathname.endsWith('/editions')) return new Response(null, { status: 204 });
      return json([]);
    }
    if (url.pathname.endsWith('/claim_edition_delivery')) return json(true);
    if (url.pathname === `/auth/v1/admin/users/${userId}`) return json({
      email: 'reader@example.com', email_confirmed_at: '2026-01-01T00:00:00Z',
    });
    if (url.hostname === 'api.resend.com') return json({ id: 'scheduled_msg' });
    if (url.pathname.endsWith('/delivery_logs')) return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  await handleEditionSchedule({
    ...baseEnv,
    RESEND_API_KEY: 'test-key',
    DELIVERY_EMAIL_PROVIDER: 'resend',
    DELIVERY_FROM_EMAIL: 'brief@example.com',
    DELIVERY_PHYSICAL_ADDRESS: '100 Example Road',
    DELIVERY_UNSUBSCRIBE_SECRET: 'test-secret',
  }, new Date('2026-02-01T01:30:00Z'));
  const emailCall = calls.find(({ url }) => url.hostname === 'api.resend.com');
  assert.ok(emailCall);
  const profileRead = calls.find(({ url }) => url.pathname.endsWith('/user_profile_v2'));
  assert.equal(profileRead.url.searchParams.get('user_id'), `in.(${userId})`);
  const deliveryLog = calls.find(({ url, init }) => url.pathname.endsWith('/delivery_logs') && init.method === 'PATCH');
  assert.equal(deliveryLog.url.searchParams.get('user_id'), `eq.${userId}`);
});

test('Telegram delivery sends a plain-text briefing to the connected user chat', async (context) => {
  let outbound, deliveryLog;
  installFetch(context, async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/claim_edition_delivery')) return json(true);
    if (url.pathname.endsWith('/telegram_connections')) return json([{ chat_id: '12345' }]);
    if (url.hostname === 'api.telegram.org') {
      outbound = JSON.parse(init.body);
      return json({ ok: true, result: { message_id: 44 } });
    }
    if (url.pathname.endsWith('/delivery_logs')) {
      deliveryLog = { url, body: JSON.parse(init.body) };
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const result = await deliverEdition({
    ...baseEnv, TELEGRAM_BOT_TOKEN: 'test-token',
  }, { delivery_channel: 'telegram' }, edition);
  assert.equal(result.status, 'sent');
  assert.equal(outbound.chat_id, '12345');
  assert.match(outbound.text, /A market update/);
  assert.equal(deliveryLog.url.searchParams.get('user_id'), `eq.${userId}`);
  assert.equal(deliveryLog.body.provider_message_id, '44');
  assert.equal('text' in deliveryLog.body, false);
});

test('Telegram link codes are one-time, hashed in storage, and accepted only from the configured webhook', async (context) => {
  const calls = [];
  installFetch(context, async (input, init = {}) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    if (url.pathname === '/auth/v1/user') return json({ id: userId });
    if (url.pathname.endsWith('/telegram_link_codes')) return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/consume_telegram_link_code')) return json(userId);
    if (url.hostname === 'api.telegram.org') return json({ ok: true, result: { message_id: 7 } });
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const env = { ...baseEnv, TELEGRAM_BOT_USERNAME: 'BingleSignalBot', TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret' };
  const linkResponse = await worker.fetch(post('/api/telegram/link-code', {}, {}), env);
  assert.equal(linkResponse.status, 200);
  const { code } = await linkResponse.json();
  assert.equal(code.length, 32);
  const storedCode = calls.find(({ url, init }) =>
    url.pathname.endsWith('/telegram_link_codes') && init.method === 'POST').body;
  assert.equal(storedCode.code_hash, createHash('sha256').update(code).digest('hex'));
  assert.equal('code' in storedCode, false);
  assert.equal(calls.find(({ url, init }) =>
    url.pathname.endsWith('/telegram_link_codes') && init.method === 'DELETE').url.searchParams.get('user_id'), `eq.${userId}`);

  const unauthorized = await worker.fetch(post('/api/telegram/webhook', {}, { 'x-telegram-bot-api-secret-token': 'wrong' }), env);
  assert.equal(unauthorized.status, 401);
  const update = { message: { text: `/start ${code}`, chat: { id: 123, type: 'private' } } };
  const linked = await worker.fetch(post('/api/telegram/webhook', update, {
    'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET,
  }), env);
  assert.equal(linked.status, 200);
  const consume = calls.find(({ url }) => url.pathname.endsWith('/consume_telegram_link_code'));
  assert.equal(consume.body.p_code_hash, storedCode.code_hash);
});

test('unsubscribe signatures switch only the matching user back to in-app delivery', async (context) => {
  let updatedUrl;
  installFetch(context, async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/user_profile_v2')) {
      updatedUrl = url;
      assert.equal(init.method, 'PATCH');
      assert.deepEqual(JSON.parse(init.body), { delivery_channel: 'app' });
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const env = { ...baseEnv, DELIVERY_UNSUBSCRIBE_SECRET: 'test-secret' };
  const url = await makeUnsubscribeUrl(userId, env);
  const response = await worker.fetch(new Request(url), env);
  assert.equal(response.status, 200);
  assert.equal(updatedUrl.searchParams.get('user_id'), `eq.${userId}`);
  const tampered = new URL(url);
  tampered.searchParams.set('sig', 'bad-signature');
  assert.equal((await worker.fetch(new Request(tampered), env)).status, 400);
});

test('delivery migration keeps delivery and Telegram tables server-only', async () => {
  const migration = await (await import('node:fs/promises')).readFile(
    new URL('../../supabase/008_delivery.sql', import.meta.url), 'utf8');
  for (const table of ['delivery_logs', 'telegram_connections', 'telegram_link_codes']) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, 'i'));
  }
  assert.match(migration, /claim_edition_delivery/);
  assert.match(migration, /consume_telegram_link_code/);
  assert.match(migration, /delivery_logs l[\s\S]*l\.user_id = d\.user_id/i);
  assert.match(migration, /interval '2 hours'/i);
});
