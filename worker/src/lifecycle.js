import { supabaseRequest } from './supabase.js';
import { sendLifecycleEmail } from './delivery.js';

async function rpc(env, name, body) {
  const response = await supabaseRequest(env, `/rest/v1/rpc/${name}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${name} failed (${response.status})`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export async function handleLifecycleSchedule(env) {
  const provider = env.DELIVERY_EMAIL_PROVIDER || 'resend';
  const configured = env.DELIVERY_PHYSICAL_ADDRESS && env.DELIVERY_FROM_EMAIL &&
    (provider === 'resend' ? env.RESEND_API_KEY
      : provider === 'ses' ? env.SES_REGION && env.SES_ACCESS_KEY_ID && env.SES_SECRET_ACCESS_KEY
      : false);
  if (!configured) {
    console.log('Lifecycle email jobs deferred until delivery settings are configured', { status_code: 503 });
    return;
  }
  const jobs = await rpc(env, 'claim_due_billing_email_jobs', { p_limit: 10 });
  let sent = 0, failed = 0;
  for (const job of jobs || []) {
    let result;
    try {
      if (!job.recipient) throw Object.assign(new Error('Billing email recipient is missing.'), { statusCode: 404 });
      result = await sendLifecycleEmail(env, job.recipient, job.email_type, job.user_id);
      await rpc(env, 'finish_billing_email_job', {
        p_job_key: job.job_key,
        p_sent: true,
        p_provider_message_id: result.messageId,
        p_status_code: result.statusCode,
      });
      sent++;
    } catch (error) {
      const statusCode = error.statusCode || 500;
      await rpc(env, 'finish_billing_email_job', {
        p_job_key: job.job_key,
        p_sent: false,
        p_provider_message_id: null,
        p_status_code: statusCode,
      });
      console.warn('Lifecycle email delivery failed', {
        status_code: statusCode,
      });
      failed++;
    }
  }
  if (sent || failed) console.log('Lifecycle emails processed', { sent, failed });
}
