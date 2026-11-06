import PostalMime from 'postal-mime';
import { decryptField, encryptField, getUserDek } from './crypto.js';
import { normalizeEmailText } from './email/normalize.js';
import { scrubSensitiveText } from './email/scrub.js';
import { triageEmail } from './email/triage.js';
import { summarizeEmailBatch } from './email/summarize.js';
import { scoreEmail } from './email/score.js';
import { composeInboxBrief } from './email/brief.js';
import { supabaseRequest } from './supabase.js';

export const MAX_FORWARDED_EMAIL_BYTES = 1_000_000;
export const FORWARDED_EMAIL_DAILY_LIMIT = 100;
const DEFAULT_FORWARD_DOMAIN = 'in.binglesignal.com';
const enc = new TextEncoder();

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function requestRows(env, path, init) {
  const response = await supabaseRequest(env, path, init);
  if (!response.ok) throw new Error(`Forward email storage failed (${response.status})`);
  const body = await response.text();
  return body ? JSON.parse(body) : [];
}

function randomLocalPart() {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((value) => value.toString(16).padStart(2, '0')).join('');
}

function forwardDomain(env) {
  const domain = String(env.EMAIL_FORWARD_DOMAIN || DEFAULT_FORWARD_DOMAIN).toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new Error('EMAIL_FORWARD_DOMAIN must be a valid email domain');
  }
  return domain;
}

function cloudflareEmailConfig(env) {
  const zoneId = String(env.CF_ZONE_ID || '');
  const token = String(env.CF_EMAIL_ROUTING_TOKEN || '');
  const workerName = String(env.CF_EMAIL_WORKER_NAME || 'binglesignal');
  if (!/^[a-f0-9]{32}$/i.test(zoneId) || !token || !/^[a-z0-9_-]{1,63}$/i.test(workerName)) {
    throw new Error('Cloudflare Email Routing API is not configured');
  }
  return { zoneId, token, workerName };
}

async function cloudflareEmailRequest(env, path, init = {}) {
  const { zoneId, token } = cloudflareEmailConfig(env);
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  const result = await response.json();
  if (!response.ok || result.success !== true) {
    throw new Error(`Cloudflare Email Routing request failed (${response.status})`);
  }
  return result.result;
}

async function findCloudflareEmailRule(env, address) {
  const { zoneId, token } = cloudflareEmailConfig(env);
  let page = 1;
  while (true) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules?per_page=100&page=${page}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const result = await response.json();
    if (!response.ok || result.success !== true) {
      throw new Error(`Cloudflare Email Routing lookup failed (${response.status})`);
    }
    const rule = (result.result || []).find((candidate) =>
      (candidate.matchers || []).some((matcher) =>
        matcher.type === 'literal' && matcher.field === 'to' &&
        String(matcher.value || '').toLowerCase() === address.toLowerCase()));
    if (rule) return rule;
    const totalPages = Number(result.result_info?.total_pages || 1);
    if (page >= totalPages || (result.result || []).length === 0) return null;
    page++;
  }
}

export async function ensureCloudflareEmailRoute(env, address) {
  const { workerName } = cloudflareEmailConfig(env);
  const existing = await findCloudflareEmailRule(env, address);
  if (existing) {
    const ownedByWorker = (existing.actions || []).some((action) =>
      action.type === 'worker' && (action.value || []).includes(workerName));
    if (existing.enabled && ownedByWorker) return;
    throw new Error('A conflicting or disabled Cloudflare email route already uses this address');
  }
  await cloudflareEmailRequest(env, '', {
    method: 'POST',
    body: JSON.stringify({
      name: 'BingleSignal Forward-to-Brief',
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: address }],
      actions: [{ type: 'worker', value: [workerName] }],
    }),
  });
}

export async function deleteCloudflareEmailRoute(env, address) {
  const { workerName } = cloudflareEmailConfig(env);
  const existing = await findCloudflareEmailRule(env, address);
  if (!existing) return;
  const ownedByWorker = (existing.actions || []).some((action) =>
    action.type === 'worker' && (action.value || []).includes(workerName));
  if (!ownedByWorker) throw new Error('Refusing to delete a Cloudflare route not owned by BingleSignal');
  await cloudflareEmailRequest(env, `/${encodeURIComponent(existing.id)}`, { method: 'DELETE' });
}

export async function createForwardAddress(env, userId) {
  const existing = await requestRows(env, `/rest/v1/email_forward_addresses?user_id=eq.${encodeURIComponent(userId)}&enabled=eq.true&select=local_part&limit=1`);
  if (existing.length) {
    const address = `${existing[0].local_part}@${forwardDomain(env)}`;
    await ensureCloudflareEmailRoute(env, address);
    return address;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const localPart = randomLocalPart();
    const response = await supabaseRequest(env, '/rest/v1/email_forward_addresses', {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ user_id: userId, local_part: localPart }),
    });
    if (response.status === 409) continue;
    if (!response.ok) throw new Error(`Forward address creation failed (${response.status})`);
    const created = await response.json();
    if (!created.length) throw new Error('Forward address creation returned no address');
    const address = `${created[0].local_part}@${forwardDomain(env)}`;
    try {
      await ensureCloudflareEmailRoute(env, address);
    } catch (error) {
      await requestRows(env, `/rest/v1/email_forward_addresses?user_id=eq.${encodeURIComponent(userId)}`, { method: 'DELETE' });
      throw error;
    }
    return address;
  }
  throw new Error('Could not create a unique private forwarding address');
}

export async function handleForwardApi(req, env, user, path) {
  if (path === '/api/email/forward/address' && (req.method === 'GET' || req.method === 'POST')) {
    const addresses = await requestRows(env, `/rest/v1/email_forward_addresses?user_id=eq.${encodeURIComponent(user.id)}&enabled=eq.true&select=local_part&limit=1`);
    const address = addresses.length ? `${addresses[0].local_part}@${forwardDomain(env)}` : null;
    return json({ address: req.method === 'POST' ? address || await createForwardAddress(env, user.id) : address });
  }
  if (path === '/api/email/forward/confirmation-code' && req.method === 'POST') {
    const response = await supabaseRequest(env, '/rest/v1/rpc/consume_email_forward_confirmation', {
      method: 'POST',
      body: JSON.stringify({ p_user_id: user.id }),
    });
    if (!response.ok) throw new Error(`Forward confirmation lookup failed (${response.status})`);
    const encryptedCode = await response.json();
    if (!encryptedCode) return json({ error: 'No unused Gmail confirmation code is waiting.' }, 404);
    const dek = await getUserDek(env, user.id);
    return json({ code: await decryptField(dek, user.id, 'forward_code', encryptedCode) });
  }
  if (path === '/api/email/forward/reports' && req.method === 'GET') {
    await requestRows(env, `/rest/v1/email_forward_messages?user_id=eq.${encodeURIComponent(user.id)}&created_at=lt.${encodeURIComponent(new Date(Date.now() - 30 * 864e5).toISOString())}`, { method: 'DELETE' });
    const messages = await requestRows(env, `/rest/v1/email_forward_messages?user_id=eq.${encodeURIComponent(user.id)}&status=eq.completed&select=message_hash,report_enc,created_at&order=created_at.desc&limit=20`);
    const dek = messages.length ? await getUserDek(env, user.id) : null;
    const reports = await Promise.all(messages.map(async (message) => ({
      created_at: message.created_at,
      report: JSON.parse(await decryptField(dek, user.id, 'forward_report', message.report_enc)),
    })));
    return json({ reports });
  }
  return json({ error: 'not found' }, 404);
}

function localPartForRecipient(recipient, expectedDomain) {
  const match = String(recipient || '').trim().toLowerCase().match(/^([a-f0-9]{48})@([^@]+)$/);
  return match && match[2] === expectedDomain ? match[1] : null;
}

function trustedDmarcFailure(headers) {
  const results = headers.get('authentication-results') || '';
  return /(?:^|;\s*)mx\.cloudflare\.net\b/i.test(results) && /\bdmarc=fail\b/i.test(results);
}

function confirmationCode(subject, text) {
  if (!/gmail/i.test(subject) || !/forward/i.test(subject) || !/confirm/i.test(subject)) return null;
  return String(text).match(/(?:confirmation|verification)\s+(?:code|number)\D{0,40}(\d{6,10})/i)?.[1] || null;
}

async function messageHash(userId, parsed, envelope) {
  const identity = parsed.messageId || [
    envelope.from,
    envelope.to,
    parsed.date || '',
    parsed.subject || '',
    (parsed.text || parsed.html || '').slice(0, 1500),
  ].join('|');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${userId}|${identity}`)))]
    .map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function claimMessage(env, localPart, hash) {
  const response = await supabaseRequest(env, '/rest/v1/rpc/claim_email_forward_message', {
    method: 'POST',
    body: JSON.stringify({
      p_local_part: localPart,
      p_message_hash: hash,
      p_usage_date: new Date().toISOString().slice(0, 10),
      p_daily_limit: FORWARDED_EMAIL_DAILY_LIMIT,
    }),
  });
  if (!response.ok) throw new Error(`Forward message claim failed (${response.status})`);
  const [claim] = await response.json();
  return claim;
}

async function finishMessage(env, userId, hash, status, reportEnc = null) {
  await requestRows(env, `/rest/v1/email_forward_messages?message_hash=eq.${encodeURIComponent(hash)}&user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({
      status,
      report_enc: reportEnc,
      locked_until: null,
      updated_at: new Date().toISOString(),
    }),
  });
}

async function saveConfirmation(env, userId, code) {
  const dek = await getUserDek(env, userId);
  await requestRows(env, `/rest/v1/email_forward_addresses?user_id=eq.${encodeURIComponent(userId)}&enabled=eq.true`, {
    method: 'PATCH',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({
      confirmation_code_enc: await encryptField(dek, userId, 'forward_code', code),
      confirmation_code_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
}

async function makeForwardBrief(env, userId, parsed, hash) {
  const from = String(parsed.from?.address || '');
  const fromDomain = from.split('@').pop()?.toLowerCase() || '';
  const subject = scrubSensitiveText(String(parsed.subject || '(no subject)')).slice(0, 300);
  const text = scrubSensitiveText(normalizeEmailText({ text: parsed.text || '', html: parsed.html || '' }));
  const triage = triageEmail({
    subject,
    from,
    from_domain: fromDomain,
    headers: parsed.headers || {},
  });
  let analyzed = [];
  let fallback = false;
  if (triage.needsAi && text) {
    const result = await summarizeEmailBatch(env, userId, [{
      id: hash,
      from_domain: fromDomain,
      from_name: String(parsed.from?.name || fromDomain),
      subject,
      date: parsed.date || '',
      direct: 'to',
      category: triage.category || 'needs_action',
      text,
    }], 'UTC');
    analyzed = result.items;
    fallback = result.fallback;
  }
  const ai = analyzed[0];
  const item = scoreEmail({
    id: hash,
    category: ai?.category || triage.category || 'notification',
    one_line: ai?.one_line || `Review: ${subject}`,
    summary: ai?.summary || (triage.security ? 'Security alert; open the original email to review it.' : 'Forwarded message needs a quick review.'),
    ask: ai?.ask || null,
    deadline_iso: ai?.deadline_iso || null,
    needs_reply: ai?.needs_reply || false,
    urgent: ai?.urgent || triage.security,
    confidence: ai?.confidence || 0.2,
    from_domain: fromDomain,
    from_name: scrubSensitiveText(String(parsed.from?.name || fromDomain)).slice(0, 100),
    received: parsed.date || '',
    direct: 'to',
    automated: triage.automated,
    bulk: triage.bulk,
  });
  const brief = composeInboxBrief([item], 1);
  return {
    title: 'Forwarded email brief',
    summary: brief.summary,
    important: brief.important,
    decisions: brief.decisions,
    deadlines: brief.deadlines,
    waiting_on: brief.waiting_on,
    bundles: brief.bundles,
    ignore: brief.ignore,
    label: fallback ? 'RULES-ONLY SUMMARY' : 'EMAIL BRIEF',
    generated_at: new Date().toISOString(),
  };
}

export async function handleForwardEmail(message, env) {
  let hash = null;
  let ownerId = null;
  try {
    if (env.EMAIL_BETA_ENABLED !== 'true') {
      message.setReject('BingleSignal forwarding is temporarily unavailable');
      return;
    }
    if (message.rawSize > MAX_FORWARDED_EMAIL_BYTES) {
      message.setReject('Message exceeds BingleSignal forwarding size limit');
      return;
    }
    if (trustedDmarcFailure(message.headers)) {
      message.setReject('Email authentication failed');
      return;
    }
    const domain = forwardDomain(env);
    const localPart = localPartForRecipient(message.to, domain);
    if (!localPart) {
      message.setReject('Unknown BingleSignal forwarding address');
      return;
    }
    const parsed = await PostalMime.parse(message.raw);
    hash = await messageHash(message.to, parsed, message);
    const claim = await claimMessage(env, localPart, hash);
    if (claim.result === 'duplicate') return;
    if (claim.result === 'unknown') {
      message.setReject('Unknown BingleSignal forwarding address');
      return;
    }
    if (claim.result === 'limit') {
      message.setReject('Daily BingleSignal forwarding limit reached');
      return;
    }
    ownerId = claim.owner_id;
    const code = confirmationCode(parsed.subject || '', parsed.text || '');
    if (code) {
      await saveConfirmation(env, ownerId, code);
      await finishMessage(env, ownerId, hash, 'completed');
      return;
    }
    const report = await makeForwardBrief(env, ownerId, parsed, hash);
    const dek = await getUserDek(env, ownerId);
    const reportEnc = await encryptField(dek, ownerId, 'forward_report', JSON.stringify(report));
    await finishMessage(env, ownerId, hash, 'completed', reportEnc);
  } catch {
    if (ownerId && hash) await finishMessage(env, ownerId, hash, 'failed');
    console.error('forwarded email processing failed');
    message.setReject('BingleSignal could not safely process this email');
  }
}
