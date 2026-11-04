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
    let body;
    if (init.body) {
      try { body = JSON.parse(init.body); } catch { body = String(init.body); }
    }
    calls.push({ url, init, body });
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

async function encryptTokenForTest(value, rawKey) {
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value)));
  return Buffer.from(Uint8Array.from([...iv, ...encrypted])).toString('base64');
}

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

test('Gmail OAuth requests read-only content scope and requires explicit consent', async () => {
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
  assert.match(authorize.searchParams.get('scope'), /gmail\.readonly/);
  assert.doesNotMatch(authorize.searchParams.get('scope'), /gmail\.metadata/);
});

test('Outlook OAuth requests Mail.Read for user-requested content summaries', async () => {
  const beta = { user_id: user.id, enabled: true };
  fakeFetch({
    '/auth/v1/user': () => Response.json(user),
    '/rest/v1/subscriptions?': () => Response.json([{ plan: 'pro', status: 'active' }]),
    '/rest/v1/email_beta_users?user_id=': () => Response.json([beta]),
    '/rest/v1/email_beta_users?enabled=': () => Response.json([beta]),
  });
  const response = await worker.fetch(post('/api/email/connect', { provider: 'outlook', consent: true }), {
    ...baseEnv,
    EMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    MICROSOFT_CLIENT_ID: 'client-id',
    MICROSOFT_CLIENT_SECRET: 'client-secret',
    MICROSOFT_EMAIL_REDIRECT_URI: 'https://binglesignal.com/api/email/oauth/outlook/callback',
  });
  assert.equal(response.status, 200);
  const authorize = new URL((await response.json()).authorize_url);
  assert.match(authorize.searchParams.get('scope'), /Mail\.Read/);
  assert.doesNotMatch(authorize.searchParams.get('scope'), /Mail\.ReadBasic/);
});

test('Content summaries require consent, a configured AI endpoint, and an owned mailbox', async () => {
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  const today = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const beta = {
    user_id: user.id, enabled: true, timezone: 'Asia/Kolkata',
    usage_date: today, daily_messages: 480, summary_usage_date: today, summary_messages: 0,
  };
  const connection = { id: 'cccccccc-0000-0000-0000-000000000003', provider: 'gmail' };
  const routes = {
    '/auth/v1/user': () => Response.json(user),
    '/rest/v1/subscriptions?': () => Response.json([{ plan: 'pro', status: 'active' }]),
    '/rest/v1/email_beta_users?user_id=': () => Response.json([beta]),
    '/rest/v1/email_beta_users?enabled=': () => Response.json([beta]),
    '/rest/v1/email_connections?id=': () => Response.json([connection]),
    '/rest/v1/email_summary_jobs?user_id=': () => Response.json([]),
    '/rest/v1/email_summary_jobs': () => Response.json([{ id: 'summary-job', mode: 'latest50', status: 'queued', max_messages: 50 }]),
  };
  fakeFetch(routes);
  const noConsent = await worker.fetch(post('/api/email/summaries', {
    connection_id: connection.id, mode: 'latest50',
  }), { ...baseEnv, EMAIL_AI_ENDPOINT: 'https://ai.example/v1/chat/completions', EMAIL_AI_API_KEY: 'test', EMAIL_AI_MODEL: 'model' });
  assert.equal(noConsent.status, 400);

  fakeFetch(routes);
  const noAiConfig = await worker.fetch(post('/api/email/summaries', {
    connection_id: connection.id, mode: 'latest50', content_consent: true,
  }), baseEnv);
  assert.equal(noAiConfig.status, 503);

  const calls = fakeFetch(routes);
  const response = await worker.fetch(post('/api/email/summaries', {
    connection_id: connection.id, mode: 'latest50', content_consent: true,
  }), {
    ...baseEnv,
    EMAIL_AI_ENDPOINT: 'https://ai.example/v1/chat/completions',
    EMAIL_AI_API_KEY: 'test',
    EMAIL_AI_MODEL: 'model',
  });
  assert.equal(response.status, 202);
  const insert = calls.find((call) => call.url.includes('/rest/v1/email_summary_jobs') && call.init.method === 'POST');
  assert.equal(insert.body.max_messages, 20);
  assert.equal(insert.body.content_consented_at !== undefined, true);
});

test('Content summary date ranges are validated and limited to 31 calendar days', async () => {
  const beta = { user_id: user.id, enabled: true, timezone: 'Asia/Kolkata', summary_messages: 0 };
  const calls = fakeFetch({
    '/auth/v1/user': () => Response.json(user),
    '/rest/v1/subscriptions?': () => Response.json([{ plan: 'pro', status: 'active' }]),
    '/rest/v1/email_beta_users?user_id=': () => Response.json([beta]),
    '/rest/v1/email_beta_users?enabled=': () => Response.json([beta]),
  });
  const env = {
    ...baseEnv,
    EMAIL_AI_ENDPOINT: 'https://ai.example/v1/chat/completions',
    EMAIL_AI_API_KEY: 'test',
    EMAIL_AI_MODEL: 'model',
  };
  const tooWide = await worker.fetch(post('/api/email/summaries', {
    connection_id: 'cccccccc-0000-0000-0000-000000000003',
    mode: 'date_range', date_from: '2026-01-01', date_to: '2026-02-01', content_consent: true,
  }), env);
  assert.equal(tooWide.status, 400);
  assert.match((await tooWide.json()).error, /31 calendar days/);
  assert.equal(calls.some((call) => call.url.includes('/rest/v1/email_summary_jobs')), false);
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
    '/rest/v1/rpc/claim_email_summary_jobs': () => Response.json([]),
  });

  await handleEmailSchedule('*/5 * * * *', baseEnv);

  const claim = calls.find((call) => call.url.includes('/rest/v1/rpc/claim_email_beta_jobs'));
  assert.equal(claim.init.method, 'POST');
  assert.deepEqual(claim.body, { batch_limit: 5 });
  const summaryClaim = calls.find((call) => call.url.includes('/rest/v1/rpc/claim_email_summary_jobs'));
  assert.equal(summaryClaim.init.method, 'POST');
  assert.deepEqual(summaryClaim.body, { batch_limit: 3 });
});

test('Summary worker fetches selected Gmail content transiently and stores only the generated summary', async () => {
  const rawKey = new Uint8Array(32).fill(7);
  const encryptedRefreshToken = await encryptTokenForTest('refresh-token', rawKey);
  const emailText = 'Synthetic test content: project delivery is due Friday.';
  const aiRequests = [];
  const calls = fakeFetch({
    '/rest/v1/rpc/claim_email_beta_jobs': () => Response.json([]),
    '/rest/v1/rpc/claim_email_summary_jobs': () => Response.json([{
      id: 'dddddddd-0000-0000-0000-000000000004',
      user_id: user.id,
      connection_id: 'cccccccc-0000-0000-0000-000000000003',
      mode: 'latest50',
      max_messages: 50,
      processed_count: 0,
      provider_cursor: null,
      partial_summaries: [],
    }]),
    '/rest/v1/email_beta_users?user_id=': () => Response.json([{ user_id: user.id, enabled: true, timezone: 'Asia/Kolkata' }]),
    '/rest/v1/email_connections?id=': () => Response.json([{
      id: 'cccccccc-0000-0000-0000-000000000003',
      user_id: user.id,
      provider: 'gmail',
      provider_email: user.email,
      encrypted_refresh_token: encryptedRefreshToken,
    }]),
    '/rest/v1/subscriptions?': () => Response.json([{ plan: 'pro', status: 'active' }]),
    'oauth2.googleapis.com/token': () => Response.json({ access_token: 'mail-access-token' }),
    'gmail.googleapis.com/gmail/v1/users/me/messages?': () => Response.json({ messages: [{ id: 'message-id' }] }),
    'gmail.googleapis.com/gmail/v1/users/me/messages/message-id?format=full': () => Response.json({
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: 'Project update' }, { name: 'From', value: 'team@example.com' }],
        body: { data: Buffer.from(emailText).toString('base64url') },
      },
    }),
    'ai.example/v1/chat/completions': (_url, init) => {
      aiRequests.push(JSON.parse(init.body));
      return Response.json({ choices: [{ message: { content: 'One message: delivery is due Friday.' } }] });
    },
    '/rest/v1/rpc/advance_email_summary_job': () => Response.json([{ id: 'summary-job', status: 'completed' }]),
    '/rest/v1/email_summary_jobs?status=in.': () => new Response(null, { status: 204 }),
  });

  await handleEmailSchedule('*/5 * * * *', {
    ...baseEnv,
    EMAIL_TOKEN_ENCRYPTION_KEY: Buffer.from(rawKey).toString('base64'),
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    EMAIL_AI_ENDPOINT: 'https://ai.example/v1/chat/completions',
    EMAIL_AI_API_KEY: 'ai-key',
    EMAIL_AI_MODEL: 'test-model',
  });

  assert.ok(aiRequests.some((request) => request.messages[1].content.includes(emailText)));
  const advance = calls.find((call) => call.url.includes('/rest/v1/rpc/advance_email_summary_job'));
  assert.equal(advance.body.p_increment, 1);
  assert.equal(advance.body.p_done, true);
  assert.equal(advance.body.p_report.email_count, 1);
  assert.doesNotMatch(JSON.stringify(advance.body), new RegExp(emailText));
});

test('Summary worker reads Outlook inbox text only for the selected summary job', async () => {
  const rawKey = new Uint8Array(32).fill(8);
  const encryptedRefreshToken = await encryptTokenForTest('outlook-refresh-token', rawKey);
  const emailText = 'Synthetic Outlook content: review the draft next week.';
  let graphRequest;
  const calls = fakeFetch({
    '/rest/v1/rpc/claim_email_beta_jobs': () => Response.json([]),
    '/rest/v1/rpc/claim_email_summary_jobs': () => Response.json([{
      id: 'eeeeeeee-0000-0000-0000-000000000005',
      user_id: user.id,
      connection_id: 'ffffffff-0000-0000-0000-000000000006',
      mode: 'latest50',
      max_messages: 50,
      processed_count: 0,
      provider_cursor: null,
      partial_summaries: [],
    }]),
    '/rest/v1/email_beta_users?user_id=': () => Response.json([{ user_id: user.id, enabled: true, timezone: 'Asia/Kolkata' }]),
    '/rest/v1/email_connections?id=': () => Response.json([{
      id: 'ffffffff-0000-0000-0000-000000000006',
      user_id: user.id,
      provider: 'outlook',
      provider_email: user.email,
      encrypted_refresh_token: encryptedRefreshToken,
    }]),
    '/rest/v1/subscriptions?': () => Response.json([{ plan: 'pro', status: 'active' }]),
    '/common/oauth2/v2.0/token': () => Response.json({ access_token: 'graph-access-token' }),
    'graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?': (url, init) => {
      graphRequest = { url, headers: init.headers };
      return Response.json({ value: [{
        subject: 'Draft review',
        from: { emailAddress: { address: 'team@example.com' } },
        receivedDateTime: '2026-11-03T08:00:00Z',
        body: { content: emailText },
      }] });
    },
    'ai.example/v1/chat/completions': () => Response.json({ choices: [{ message: { content: 'Review the draft next week.' } }] }),
    '/rest/v1/rpc/advance_email_summary_job': () => Response.json([{ id: 'summary-job', status: 'completed' }]),
    '/rest/v1/email_summary_jobs?status=in.': () => new Response(null, { status: 204 }),
  });

  await handleEmailSchedule('*/5 * * * *', {
    ...baseEnv,
    EMAIL_TOKEN_ENCRYPTION_KEY: Buffer.from(rawKey).toString('base64'),
    MICROSOFT_CLIENT_ID: 'client-id',
    MICROSOFT_CLIENT_SECRET: 'client-secret',
    EMAIL_AI_ENDPOINT: 'https://ai.example/v1/chat/completions',
    EMAIL_AI_API_KEY: 'ai-key',
    EMAIL_AI_MODEL: 'test-model',
  });

  assert.match(graphRequest.url, /%24select=id%2Csubject%2Cfrom%2CreceivedDateTime%2Cbody/);
  assert.equal(graphRequest.headers.Prefer, 'outlook.body-content-type="text"');
  const aiRequest = calls.find((call) => call.url.includes('ai.example/v1/chat/completions'));
  assert.match(aiRequest.body.messages[1].content, new RegExp(emailText));
});
