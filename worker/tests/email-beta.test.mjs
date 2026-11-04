import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { betaTestReport, handleEmailSchedule, isValidBetaSchedule } from '../src/email-beta.js';

const user = { id: 'aaaaaaaa-0000-0000-0000-000000000001', email: 'ria@example.com' };
const baseEnv = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  EMAIL_BETA_ENABLED: 'true',
};

function fakeFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    for (const [needle, reply] of Object.entries(routes)) {
      if (url.includes(needle)) return reply(url, init);
    }
    return Response.json([]);
  };
  return calls;
}

const post = (path, body = {}, token = 'test-token') => new Request(`https://binglesignal.com${path}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('Email beta schedule validates IANA time zones and local HH:MM values', () => {
  assert.equal(isValidBetaSchedule('Asia/Kolkata', '07:00'), true);
  assert.equal(isValidBetaSchedule('America/New_York', '23:45'), true);
  assert.equal(isValidBetaSchedule('Asia/Kolkata', '07:07'), false);
  assert.equal(isValidBetaSchedule('not-a-timezone', '07:00'), false);
  assert.equal(isValidBetaSchedule('Asia/Kolkata', '24:00'), false);
});

test('Email beta mock report is explicitly synthetic and contains no mailbox content', () => {
  const report = betaTestReport();
  assert.match(report.label, /SYNTHETIC/);
  assert.match(report.summary, /does not summarize your mailbox/);
  assert.deepEqual(Object.keys(report).sort(), ['ignore', 'important', 'label', 'summary', 'title']);
});

test('Email beta endpoints are disabled unless explicitly enabled', async () => {
  const res = await worker.fetch(new Request('https://binglesignal.com/api/email/settings'), {
    ...baseEnv,
    EMAIL_BETA_ENABLED: 'false',
  });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /disabled/);
});

test('Email beta requires login and a Pro subscription', async () => {
  fakeFetch({});
  const noLogin = await worker.fetch(new Request('https://binglesignal.com/api/email/settings'), baseEnv);
  assert.equal(noLogin.status, 401);

  fakeFetch({
    '/auth/v1/user': () => Response.json(user),
    '/rest/v1/subscriptions?': () => Response.json([{ plan: 'lite', status: 'active' }]),
  });
  const noPro = await worker.fetch(post('/api/email/settings'), baseEnv);
  assert.equal(noPro.status, 403);
});

test('Email beta reports missing Supabase auth configuration instead of a login failure', async () => {
  const response = await worker.fetch(new Request('https://binglesignal.com/api/email/settings', {
    headers: { authorization: 'Bearer test-token' },
  }), { ...baseEnv, SUPABASE_ANON_KEY: '' });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /server error/);
});

test('Gmail OAuth requests metadata scope and requires the beta consent flag', async () => {
  const beta = { user_id: user.id, enabled: true };
  fakeFetch({
    '/auth/v1/user': () => Response.json(user),
    '/rest/v1/subscriptions?': () => Response.json([{ plan: 'pro', status: 'active' }]),
    '/rest/v1/email_beta_users?user_id=': () => Response.json([beta]),
    '/rest/v1/email_beta_users?enabled=': () => Response.json([beta]),
  });
  const env = {
    ...baseEnv,
    EMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_EMAIL_REDIRECT_URI: 'https://binglesignal.com/api/email/oauth/gmail/callback',
  };
  const withoutConsent = await worker.fetch(post('/api/email/connect', { provider: 'gmail' }), env);
  assert.equal(withoutConsent.status, 400);

  const response = await worker.fetch(post('/api/email/connect', { provider: 'gmail', consent: true }), env);
  assert.equal(response.status, 200);
  const authorize = new URL((await response.json()).authorize_url);
  assert.match(authorize.searchParams.get('scope'), /gmail\.metadata/);
  assert.doesNotMatch(authorize.searchParams.get('scope'), /gmail\.readonly/);
});

test('Email beta preview stores only a fixture-backed report for invited Pro users', async () => {
  const beta = { user_id: user.id, enabled: true, timezone: 'Asia/Kolkata', digest_time: '07:00', pending_messages: 0 };
  let insertedReport = false;
  const calls = fakeFetch({
    '/auth/v1/user': () => Response.json(user),
    '/rest/v1/subscriptions?': () => Response.json([{ plan: 'pro', status: 'active' }]),
    '/rest/v1/email_beta_users?user_id=': () => Response.json([beta]),
    '/rest/v1/email_beta_users?enabled=': () => Response.json([beta]),
    '/rest/v1/email_connections?user_id=': () => Response.json([{ provider_email: user.email }]),
    '/rest/v1/email_reports?on_conflict=report_key': () => {
      if (insertedReport) return Response.json([]);
      insertedReport = true;
      return Response.json([{ report_key: 'preview' }]);
    },
    '/rest/v1/email_reports?report_key=eq.': () => new Response(null, { status: 204 }),
  });
  const first = await worker.fetch(post('/api/email/preview'), baseEnv);
  const second = await worker.fetch(post('/api/email/preview'), baseEnv);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.match((await first.json()).notice, /synthetic test emails/);

  const inserts = calls.filter((call) => call.url.includes('/rest/v1/email_reports?on_conflict=report_key'));
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0].body.report_key, inserts[1].body.report_key);
  const insert = inserts[0];
  assert.equal(insert.body.email_count, 100);
  assert.match(insert.body.report.summary, /does not summarize your mailbox/);
  assert.equal(calls.some((call) => call.url.includes('gmail.googleapis.com') || call.url.includes('graph.microsoft.com')), false);
});

test('Six-hour cron idempotently enqueues bounded beta sync jobs', async () => {
  const calls = fakeFetch({
    '/rest/v1/email_beta_users?enabled=eq.true&select=user_id': () => Response.json([
      { user_id: user.id },
      { user_id: 'bbbbbbbb-0000-0000-0000-000000000002' },
    ]),
    '/rest/v1/email_jobs?on_conflict=id': () => new Response(null, { status: 204 }),
  });

  await handleEmailSchedule('0 */6 * * *', baseEnv);

  const insert = calls.find((call) => call.url.includes('/rest/v1/email_jobs?on_conflict=id'));
  assert.equal(insert.init.method, 'POST');
  assert.equal(insert.body.length, 2);
  assert.ok(insert.body.every((job) => job.id.startsWith(`sync:${job.user_id}:`)));
});

test('Five-minute cron claims queued beta sync jobs', async () => {
  const calls = fakeFetch({
    '/rest/v1/rpc/claim_email_beta_jobs': () => Response.json([]),
  });

  await handleEmailSchedule('*/5 * * * *', baseEnv);

  const claim = calls.find((call) => call.url.includes('/rest/v1/rpc/claim_email_beta_jobs'));
  assert.equal(claim.init.method, 'POST');
  assert.deepEqual(claim.body, { batch_limit: 5 });
});
