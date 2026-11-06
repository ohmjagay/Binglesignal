import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';
import { encryptField } from '../src/crypto.js';
import {
  createForwardAddress,
  deleteCloudflareEmailRoute,
  ensureCloudflareEmailRoute,
  handleForwardApi,
  handleForwardEmail,
  MAX_FORWARDED_EMAIL_BYTES,
} from '../src/forward.js';
import { readFile } from 'node:fs/promises';

const userId = 'aaaaaaaa-0000-0000-0000-000000000001';
const localPart = 'a'.repeat(48);
const emailAddress = `${localPart}@in.binglesignal.com`;
const baseEnv = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  EMAIL_BETA_ENABLED: 'true',
  EMAIL_FORWARD_DOMAIN: 'in.binglesignal.com',
  KEK_CURRENT: 'v1',
  KEK_V1: Buffer.alloc(32, 8).toString('base64'),
};
const cloudflareEnv = {
  CF_ZONE_ID: 'a'.repeat(32),
  CF_EMAIL_ROUTING_TOKEN: 'test-token',
  CF_EMAIL_WORKER_NAME: 'binglesignal',
};
const rawDek = new Uint8Array(32).fill(6);

async function wrappedUserKey() {
  const rawKek = Buffer.alloc(32, 8);
  const key = await crypto.subtle.importKey('raw', rawKek, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: new TextEncoder().encode(`dek|${userId}`),
  }, key, rawDek));
  return {
    kid: 'v1',
    wrapped_dek: Buffer.from(Uint8Array.from([...iv, ...encrypted])).toString('base64'),
  };
}

function installFetch(context, responder) {
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  globalThis.fetch = responder;
}

function incomingEmail({ raw, to = emailAddress, size = Buffer.byteLength(raw), auth = 'mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass' }) {
  const rejected = [];
  return {
    message: {
      to,
      from: 'sender@example.test',
      rawSize: size,
      raw: new Response(raw).body,
      headers: new Headers({ 'authentication-results': auth }),
      setReject: (reason) => rejected.push(reason),
    },
    rejected,
  };
}

const confirmationMime = `From: Gmail <no-reply@gmail.com>\r
To: ${emailAddress}\r
Subject: Gmail Forwarding Confirmation\r
Message-ID: <confirmation-1@example.test>\r
Content-Type: text/plain; charset=utf-8\r
\r
Enter this confirmation code to finish forwarding: 12345678\r
`;

test('Worker exports the Cloudflare email handler', () => {
  assert.equal(typeof worker.email, 'function');
});

test('forwarding rejects an oversized email before reading or storing it', async (context) => {
  let fetchCalls = 0;
  installFetch(context, async () => { fetchCalls++; return Response.json([]); });
  const { message, rejected } = incomingEmail({ raw: '', size: MAX_FORWARDED_EMAIL_BYTES + 1 });
  await handleForwardEmail(message, baseEnv);
  assert.equal(fetchCalls, 0);
  assert.match(rejected[0], /size limit/);
});

test('forwarding emergency switch rejects messages before reading or storing them', async (context) => {
  let fetchCalls = 0;
  installFetch(context, async () => { fetchCalls++; return Response.json([]); });
  const { message, rejected } = incomingEmail({ raw: confirmationMime });
  await handleForwardEmail(message, { ...baseEnv, EMAIL_BETA_ENABLED: 'false' });
  assert.equal(fetchCalls, 0);
  assert.match(rejected[0], /temporarily unavailable/);
});

test('forwarding rejects a DMARC failure reported by Cloudflare', async (context) => {
  let fetchCalls = 0;
  installFetch(context, async () => { fetchCalls++; return Response.json([]); });
  const { message, rejected } = incomingEmail({ raw: confirmationMime, auth: 'mx.cloudflare.net; dmarc=fail' });
  await handleForwardEmail(message, baseEnv);
  assert.equal(fetchCalls, 0);
  assert.match(rejected[0], /authentication failed/);
});

test('unknown addresses and daily-cap claims are rejected; duplicate mail is not processed twice', async (context) => {
  const claims = ['unknown', 'limit', 'duplicate'];
  installFetch(context, async (input) => {
    const url = new URL(input);
    if (!url.pathname.endsWith('/rpc/claim_email_forward_message')) throw new Error(`Unexpected request: ${url.pathname}`);
    return Response.json([{ result: claims.shift(), owner_id: userId }]);
  });
  const unknown = incomingEmail({ raw: confirmationMime });
  await handleForwardEmail(unknown.message, baseEnv);
  assert.match(unknown.rejected[0], /Unknown/);
  const capped = incomingEmail({ raw: confirmationMime });
  await handleForwardEmail(capped.message, baseEnv);
  assert.match(capped.rejected[0], /daily.*limit/i);
  const duplicate = incomingEmail({ raw: confirmationMime });
  await handleForwardEmail(duplicate.message, baseEnv);
  assert.deepEqual(duplicate.rejected, []);
  assert.equal(claims.length, 0);
});

test('Gmail forwarding confirmation is encrypted and not logged or stored as plaintext', async (context) => {
  const key = await wrappedUserKey();
  const writes = [];
  installFetch(context, async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/rpc/claim_email_forward_message')) {
      return Response.json([{ result: 'accepted', owner_id: userId }]);
    }
    if (url.pathname.endsWith('/user_keys')) return Response.json([key]);
    if (url.pathname.endsWith('/email_forward_addresses')) {
      writes.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith('/email_forward_messages')) {
      writes.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const { message, rejected } = incomingEmail({ raw: confirmationMime });
  await handleForwardEmail(message, baseEnv);
  assert.deepEqual(rejected, []);
  const storedCode = writes.find((write) => write.confirmation_code_enc);
  assert.match(storedCode.confirmation_code_enc, /^v1\.v1\./);
  assert.doesNotMatch(JSON.stringify(writes), /12345678|Gmail Forwarding Confirmation/);
});

test('forwarded message report is encrypted and only the user-scoped record is updated', async (context) => {
  const key = await wrappedUserKey();
  const writes = [];
  const aiCalls = [];
  const raw = `From: Ria <ria@example.test>\r
To: ${emailAddress}\r
Subject: Project decision\r
Message-ID: <brief-1@example.test>\r
Content-Type: text/plain; charset=utf-8\r
\r
Please approve the project plan by Friday.\r
`;
  installFetch(context, async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/rpc/claim_email_forward_message')) return Response.json([{ result: 'accepted', owner_id: userId }]);
    if (url.pathname.endsWith('/user_keys')) return Response.json([key]);
    if (url.hostname === 'ai.example') {
      const request = JSON.parse(init.body);
      aiCalls.push(request);
      const items = JSON.parse(request.messages[1].content);
      const results = items.map((email) => ({
        id: email.id, category: 'decision', priority_hint: 70, one_line: 'Approve the project plan',
        summary: 'Please approve the plan by Friday.', ask: 'Approve the plan', deadline_iso: '2026-11-06',
        amount: null, needs_reply: true, urgent: false, confidence: 0.9,
      }));
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ summary: JSON.stringify(results) }) } }],
        usage: { prompt_tokens: 40, completion_tokens: 30 },
      });
    }
    if (url.pathname.endsWith('/email_forward_messages')) {
      writes.push({ url: url.toString(), body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const env = {
    ...baseEnv,
    EMAIL_AI_ENDPOINT: 'https://ai.example/v1/chat/completions',
    EMAIL_AI_API_KEY: 'test',
    EMAIL_AI_MODEL: 'test-model',
    EMAIL_AI_BUDGET: {
      idFromName: () => 'global',
      get: () => ({
        fetch: async (input) => new URL(input).pathname === '/reserve'
          ? Response.json({ allowed: true, reservationId: 'test' })
          : Response.json({ ok: true }),
      }),
    },
  };
  const { message, rejected } = incomingEmail({ raw });
  await handleForwardEmail(message, env);
  assert.deepEqual(rejected, []);
  assert.equal(aiCalls.length, 1);
  assert.match(aiCalls[0].messages[1].content, /Please approve the project plan/);
  const saved = writes[writes.length - 1];
  assert.ok(saved.url.includes(`user_id=eq.${userId}`));
  assert.match(saved.body.report_enc, /^v1\.v1\./);
  assert.doesNotMatch(JSON.stringify(writes), /Please approve the project plan by Friday/);
});

test('private address lookup and confirmation retrieval are scoped to the signed-in user', async (context) => {
  const key = await wrappedUserKey();
  const encrypted = await encryptField(rawDek, userId, 'forward_code', '12345678');
  const calls = [];
  installFetch(context, async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname.endsWith('/email_forward_addresses')) return Response.json([{ local_part: localPart }]);
    if (url.pathname.endsWith('/rpc/consume_email_forward_confirmation')) return Response.json(encrypted);
    if (url.pathname.endsWith('/user_keys')) return Response.json([key]);
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const address = await handleForwardApi(new Request('https://binglesignal.com/api/email/forward/address'), baseEnv, { id: userId }, '/api/email/forward/address');
  assert.equal((await address.json()).address, emailAddress);
  const code = await handleForwardApi(new Request('https://binglesignal.com/api/email/forward/confirmation-code', { method: 'POST' }), baseEnv, { id: userId }, '/api/email/forward/confirmation-code');
  assert.equal((await code.json()).code, '12345678');
  assert.ok(calls.filter(({ url }) => url.pathname.endsWith('/email_forward_addresses'))
    .every(({ url }) => url.searchParams.get('user_id') === `eq.${userId}`));
  assert.ok(calls.some(({ url }) => url.pathname.endsWith('/rpc/consume_email_forward_confirmation')));
});

test('creating a private address registers its exact subdomain route with Cloudflare', async (context) => {
  const calls = [];
  installFetch(context, async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname.endsWith('/email_forward_addresses') && init.method === 'POST') {
      return Response.json([{ local_part: localPart }], { status: 201 });
    }
    if (url.pathname.endsWith('/email_forward_addresses')) return Response.json([]);
    if (url.pathname.endsWith('/email/routing/rules') && (!init.method || init.method === 'GET')) {
      return Response.json({ success: true, result: [], result_info: { total_pages: 1 } });
    }
    if (url.pathname.endsWith('/email/routing/rules') && init.method === 'POST') {
      return Response.json({ success: true, result: { id: 'route-1' } });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const address = await createForwardAddress({ ...baseEnv, ...cloudflareEnv }, userId);
  assert.equal(address, emailAddress);
  const insert = calls.find(({ url }) => url.pathname.endsWith('/email/routing/rules') && url.search === '');
  const rule = JSON.parse(insert.init.body);
  assert.deepEqual(rule.matchers, [{ type: 'literal', field: 'to', value: emailAddress }]);
  assert.deepEqual(rule.actions, [{ type: 'worker', value: ['binglesignal'] }]);
  const userQuery = calls.find(({ url }) => url.pathname.endsWith('/email_forward_addresses') && url.searchParams.has('user_id'));
  assert.equal(userQuery.url.searchParams.get('user_id'), `eq.${userId}`);
});

test('Cloudflare route management refuses conflicting routes and deletes only its own worker route', async (context) => {
  const removed = [];
  let lookups = 0;
  const existing = {
    id: 'route-owned',
    enabled: true,
    matchers: [{ type: 'literal', field: 'to', value: emailAddress }],
    actions: [{ type: 'worker', value: ['binglesignal'] }],
  };
  installFetch(context, async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/email/routing/rules') && (!init.method || init.method === 'GET')) {
      const rule = lookups++ === 0
        ? { ...existing, actions: [{ type: 'worker', value: ['another-worker'] }] }
        : existing;
      return Response.json({ success: true, result: [rule], result_info: { total_pages: 1 } });
    }
    if (url.pathname.endsWith('/route-owned') && init.method === 'DELETE') {
      removed.push(url.pathname);
      return Response.json({ success: true, result: { id: 'route-owned' } });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  await assert.rejects(ensureCloudflareEmailRoute({ ...baseEnv, ...cloudflareEnv }, emailAddress), /conflicting or disabled/);
  await deleteCloudflareEmailRoute({ ...baseEnv, ...cloudflareEnv }, emailAddress);
  assert.deepEqual(removed, ['/client/v4/zones/' + cloudflareEnv.CF_ZONE_ID + '/email/routing/rules/route-owned']);
});

test('forward migration keeps email rows server-only and caps claims atomically', async () => {
  const migration = await readFile(new URL('../../supabase/006_forward_to_brief.sql', import.meta.url), 'utf8');
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table public\.email_forward_addresses from public, anon, authenticated/i);
  assert.match(migration, /revoke all on table public\.email_forward_messages from public, anon, authenticated/i);
  assert.match(migration, /for update/i);
  assert.match(migration, /daily_messages >= p_daily_limit/);
  assert.match(migration, /where user_id = address_row\.user_id/);
  assert.match(migration, /set confirmation_code_enc = null,\s*confirmation_code_expires_at = null/i);
});
