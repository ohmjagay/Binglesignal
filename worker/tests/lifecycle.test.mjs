import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleLifecycleSchedule } from '../src/lifecycle.js';

test('lifecycle email scheduling leaves jobs queued while delivery setup is deferred', async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response('[]', { status: 200 });
  };
  await handleLifecycleSchedule({
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
  });
  assert.equal(requests, 0);
});

test('lifecycle jobs send plain text and finish with provider metadata only', async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url.includes('/claim_due_billing_email_jobs')) {
      return Response.json([{
        job_key: 'user-1:trial:day-1',
        user_id: 'user-1',
        recipient: 'founder@example.com',
        email_type: 'trial_day_1',
        attempts: 1,
      }]);
    }
    if (url.includes('api.resend.com')) return Response.json({ id: 'msg_1' });
    if (url.includes('/finish_billing_email_job')) return new Response(null, { status: 204 });
    return new Response('[]', { status: 200 });
  };
  await handleLifecycleSchedule({
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    DELIVERY_EMAIL_PROVIDER: 'resend',
    DELIVERY_FROM_EMAIL: 'brief@binglesignal.com',
    DELIVERY_PHYSICAL_ADDRESS: 'Registered office, India',
    DELIVERY_UNSUBSCRIBE_SECRET: 'test-secret',
    PUBLIC_BASE_URL: 'https://binglesignal.com',
    RESEND_API_KEY: 'test-key',
  });
  const send = calls.find((call) => call.url.includes('api.resend.com'));
  assert.ok(send);
  assert.equal(typeof send.body.text, 'string');
  assert.match(send.body.text, /Unsubscribe: https:\/\/binglesignal\.com\/api\/unsubscribe/);
  assert.match(send.body.text, /Mailing address: Registered office, India/);
  assert.equal(send.body.subject, 'Welcome to BingleSignal');
  const finish = calls.find((call) => call.url.includes('/finish_billing_email_job'));
  assert.deepEqual(finish.body, {
    p_job_key: 'user-1:trial:day-1',
    p_sent: true,
    p_provider_message_id: 'msg_1',
    p_status_code: 200,
  });
});

test('lifecycle migration keeps metrics private and schedules four trial touchpoints', async () => {
  const migration = await readFile(new URL('../../supabase/010_lifecycle_metrics.sql', import.meta.url), 'utf8');
  assert.match(migration, /trial_day_1/);
  assert.match(migration, /trial_day_3/);
  assert.match(migration, /trial_day_5/);
  assert.match(migration, /trial_day_7/);
  assert.match(migration, /schedule\.due_at > now\(\)/);
  assert.match(migration, /insert into public\.billing_email_jobs \(job_key, user_id, email_type, due_at\)[\s\S]*from public\.subscriptions s/);
  assert.match(migration, /create table if not exists public\.user_metrics/);
  assert.match(migration, /alter table public\.user_metrics enable row level security/);
  assert.match(migration, /revoke all on table public\.user_metrics from public, anon, authenticated/);
  assert.match(migration, /time_saved_minutes = public\.user_metrics\.time_saved_minutes \+ 3/);
  assert.match(migration, /updated_at < now\(\) - interval '30 minutes'/);
  assert.match(migration, /s\.email is not null/);
  assert.match(migration, /j\.email_type = 'payment_failed' and s\.status = 'past_due'/);
});
