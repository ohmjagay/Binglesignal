import { authUser, supabaseRequest } from './supabase.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const text = (body, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
const encoder = new TextEncoder();
const bytesToHex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const sha256 = value => crypto.subtle.digest('SHA-256', encoder.encode(value));
const clean = value => String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

function equal(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

async function hmac(keyBytes, value) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

async function unsubscribeSignature(userId, expiresAt, secret) {
  return bytesToHex(await hmac(encoder.encode(secret), `${userId}.${expiresAt}`));
}

export async function makeUnsubscribeUrl(userId, env, now = Date.now()) {
  if (!env.DELIVERY_UNSUBSCRIBE_SECRET) throw new Error('Unsubscribe signing secret is not configured.');
  const expiresAt = Math.floor(now / 1000) + 365 * 86400;
  const signature = await unsubscribeSignature(userId, expiresAt, env.DELIVERY_UNSUBSCRIBE_SECRET);
  const url = new URL('/api/unsubscribe', env.PUBLIC_BASE_URL || 'https://binglesignal.com');
  url.searchParams.set('user', userId);
  url.searchParams.set('expires', String(expiresAt));
  url.searchParams.set('sig', signature);
  return url.href;
}

export function renderEditionText(edition, mailingAddress, unsubscribeUrl) {
  const lines = [
    'BingleSignal — your daily briefing',
    `Edition: ${clean(edition.local_date || new Date().toISOString().slice(0, 10))}`,
    '',
  ];
  (edition.items || []).forEach((entry, index) => {
    const item = entry.item || entry;
    lines.push(`${index + 1}. ${clean(item.headline || item.t || 'Briefing story')}`);
    const explanation = clean(entry.why_it_matters || item.why_it_matters);
    if (explanation) lines.push(`Why it matters: ${explanation}`);
    const url = String(item.u || '');
    if (/^https:\/\//i.test(url)) lines.push(`Source: ${url}`);
    lines.push('');
  });
  if (edition.safely_ignore?.length) {
    lines.push('Safely ignore or read later');
    edition.safely_ignore.slice(0, 5).forEach(item => lines.push(`- ${clean(item.headline || item.reason)}`));
    lines.push('');
  }
  lines.push(`Unsubscribe: ${unsubscribeUrl}`);
  lines.push(`Mailing address: ${clean(mailingAddress)}`);
  return lines.join('\n');
}

async function providerResponse(response, provider) {
  if (!response.ok) {
    const error = new Error(`${provider} delivery failed (${response.status})`);
    error.statusCode = response.status;
    throw error;
  }
  let result = {};
  try { result = await response.json(); } catch {}
  return result.id || result.MessageId || null;
}

async function sendResend(env, recipient, subject, body, unsubscribeUrl) {
  if (!env.RESEND_API_KEY || !env.DELIVERY_FROM_EMAIL) throw new Error('Resend delivery settings are incomplete.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: ['Bearer', env.RESEND_API_KEY].join(' '), 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.DELIVERY_FROM_EMAIL,
      to: [recipient],
      subject,
      text: body,
      headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    }),
  });
  return { provider: 'resend', messageId: await providerResponse(response, 'Resend'), statusCode: response.status };
}

async function awsSignature(secret, date, region, canonicalRequest, amzDate, sessionToken) {
  const host = `email.${region}.amazonaws.com`;
  const payloadHash = bytesToHex(await sha256(canonicalRequest.payload));
  const headers = {
    host,
    'content-type': 'application/json',
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
  };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map(name => `${name}:${headers[name].trim()}\n`).join('');
  const request = `POST\n/v2/email/outbound-emails\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${region}/ses/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${bytesToHex(await sha256(request))}`;
  const dateKey = await hmac(encoder.encode(`AWS4${secret}`), date);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, 'ses');
  const signingKey = await hmac(serviceKey, 'aws4_request');
  const signature = bytesToHex(await hmac(signingKey, stringToSign));
  const requestHeaders = { ...headers };
  delete requestHeaders.host;
  return {
    headers: {
      ...requestHeaders,
      authorization: `AWS4-HMAC-SHA256 Credential=${canonicalRequest.access}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    host,
  };
}

async function sendSes(env, recipient, subject, body) {
  const region = env.SES_REGION, access = env.SES_ACCESS_KEY_ID, secret = env.SES_SECRET_ACCESS_KEY;
  if (!region || !access || !secret || !env.DELIVERY_FROM_EMAIL) throw new Error('Amazon SES delivery settings are incomplete.');
  const payload = JSON.stringify({
    FromEmailAddress: env.DELIVERY_FROM_EMAIL,
    Destination: { ToAddresses: [recipient] },
    Content: { Simple: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: { Text: { Data: body, Charset: 'UTF-8' } },
    } },
  });
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const signed = await awsSignature(secret, date, region,
    { payload, access }, amzDate, env.SES_SESSION_TOKEN);
  const response = await fetch(`https://${signed.host}/v2/email/outbound-emails`, {
    method: 'POST',
    headers: signed.headers,
    body: payload,
  });
  return { provider: 'ses', messageId: await providerResponse(response, 'Amazon SES'), statusCode: response.status };
}

export async function sendEditionEmail(env, recipient, edition, userId) {
  if (!env.DELIVERY_PHYSICAL_ADDRESS) throw new Error('Delivery mailing address is not configured.');
  const unsubscribeUrl = await makeUnsubscribeUrl(userId, env);
  const body = renderEditionText(edition, env.DELIVERY_PHYSICAL_ADDRESS, unsubscribeUrl);
  const subject = `Your BingleSignal briefing — ${clean(edition.local_date || '')}`;
  const provider = env.DELIVERY_EMAIL_PROVIDER || 'resend';
  if (provider === 'resend') return sendResend(env, recipient, subject, body, unsubscribeUrl);
  if (provider === 'ses') return sendSes(env, recipient, subject, body);
  throw new Error('DELIVERY_EMAIL_PROVIDER must be resend or ses.');
}

export async function sendLifecycleEmail(env, recipient, emailType, userId) {
  const messages = {
    trial_day_1: ['Welcome to BingleSignal', 'Your first briefing is ready. Set your interests and preferred delivery time to make it more useful.'],
    trial_day_3: ['Your BingleSignal trial', 'Your daily briefing is ready whenever you are. Open your account to continue reading.'],
    trial_day_5: ['Two days left in your BingleSignal trial', 'Your trial is almost over. Choose Lite or Pro to keep your personalized briefing.'],
    trial_day_7: ['Your BingleSignal trial has ended', 'Your briefing is paused and your settings are saved. Choose a plan any time to resume.'],
    payment_failed: ['Action needed for your BingleSignal plan', 'A subscription payment did not go through. Your access continues during the grace period; please review your billing details.'],
  };
  const [subject, message] = messages[emailType] || [];
  if (!subject) throw new Error('Unsupported lifecycle email type.');
  if (!env.DELIVERY_PHYSICAL_ADDRESS) throw new Error('Delivery mailing address is not configured.');
  const unsubscribeUrl = await makeUnsubscribeUrl(userId, env);
  const body = [
    'BingleSignal',
    '',
    message,
    '',
    'Open your account: ' + (env.PUBLIC_BASE_URL || 'https://binglesignal.com'),
    `Unsubscribe: ${unsubscribeUrl}`,
    `Mailing address: ${clean(env.DELIVERY_PHYSICAL_ADDRESS)}`,
  ].join('\n');
  const provider = env.DELIVERY_EMAIL_PROVIDER || 'resend';
  if (provider === 'resend') return sendResend(env, recipient, subject, body, unsubscribeUrl);
  if (provider === 'ses') return sendSes(env, recipient, subject, body);
  throw new Error('DELIVERY_EMAIL_PROVIDER must be resend or ses.');
}

async function sendTelegram(env, chatId, edition) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('Telegram bot token is not configured.');
  const lines = ['BingleSignal — your daily briefing', `Edition: ${clean(edition.local_date || '')}`, ''];
  for (const [index, entry] of (edition.items || []).entries()) {
    const item = entry.item || entry;
    lines.push(`${index + 1}. ${clean(item.headline || item.t || 'Briefing story')}`);
    const explanation = clean(entry.why_it_matters || item.why_it_matters);
    if (explanation) lines.push(explanation);
    if (/^https:\/\//i.test(String(item.u || ''))) lines.push(String(item.u));
    lines.push('');
  }
  const message = lines.join('\n').slice(0, 4000);
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, link_preview_options: { is_disabled: true } }),
  });
  if (!response.ok) {
    const error = new Error(`Telegram delivery failed (${response.status})`);
    error.statusCode = response.status;
    throw error;
  }
  let result = {};
  try { result = await response.json(); } catch {}
  if (result.ok === false) {
    const error = new Error('Telegram delivery was rejected by the provider.');
    error.statusCode = 502;
    throw error;
  }
  return { provider: 'telegram', messageId: result.result?.message_id ? String(result.result.message_id) : null, statusCode: response.status };
}

async function markDelivery(env, userId, slotKey, channel, status, result = {}) {
  const response = await supabaseRequest(env,
    `/rest/v1/delivery_logs?user_id=eq.${encodeURIComponent(userId)}&slot_key=eq.${encodeURIComponent(slotKey)}&channel=eq.${channel}`,
    {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({
        status,
        provider_message_id: result.messageId || null,
        status_code: result.statusCode || null,
        sent_at: status === 'sent' ? new Date().toISOString() : null,
      }),
    });
  if (!response.ok) throw new Error(`Delivery log update failed (${response.status})`);
}

async function claimDelivery(env, userId, slotKey, channel) {
  const response = await supabaseRequest(env, '/rest/v1/rpc/claim_edition_delivery', {
    method: 'POST',
    body: JSON.stringify({ p_user_id: userId, p_slot_key: slotKey, p_channel: channel }),
  });
  if (!response.ok) throw new Error(`Delivery claim failed (${response.status})`);
  return response.json();
}

export async function deliverEdition(env, profile, edition) {
  const channel = profile.delivery_channel;
  if (!['email', 'telegram'].includes(channel)) return { status: 'not_configured' };
  const claimed = await claimDelivery(env, edition.user_id, edition.slot_key, channel);
  if (!claimed) return { status: 'already_claimed' };
  try {
    let result;
    if (channel === 'email') {
      const account = await supabaseRequest(env, `/auth/v1/admin/users/${encodeURIComponent(edition.user_id)}`);
      if (!account.ok) {
        const error = new Error(`Account email lookup failed (${account.status})`);
        error.statusCode = account.status;
        throw error;
      }
      const user = await account.json();
      if (!user.email || !user.email_confirmed_at) {
        const error = new Error('A confirmed account email is required for delivery.');
        error.statusCode = 400;
        throw error;
      }
      result = await sendEditionEmail(env, user.email, edition, edition.user_id);
    } else {
      const response = await supabaseRequest(env,
        `/rest/v1/telegram_connections?user_id=eq.${encodeURIComponent(edition.user_id)}&select=chat_id&limit=1`);
      if (!response.ok) throw new Error(`Telegram connection lookup failed (${response.status})`);
      const [connection] = await response.json();
      if (!connection?.chat_id) {
        const error = new Error('No linked Telegram chat is configured.');
        error.statusCode = 404;
        throw error;
      }
      result = await sendTelegram(env, connection.chat_id, edition);
    }
    await markDelivery(env, edition.user_id, edition.slot_key, channel, 'sent', result);
    return { status: 'sent', statusCode: result.statusCode };
  } catch (error) {
    await markDelivery(env, edition.user_id, edition.slot_key, channel, 'failed', { statusCode: error.statusCode || 500 });
    throw error;
  }
}

async function createTelegramCode(req, env) {
  if (!env.TELEGRAM_BOT_USERNAME) return json({ error: 'Telegram bot is not configured yet.' }, 503);
  const user = await authUser(req, env);
  if (!user) return json({ error: 'login required' }, 401);
  const code = crypto.randomUUID().replace(/-/g, '');
  const codeHash = bytesToHex(await sha256(code));
  const cleared = await supabaseRequest(env,
    `/rest/v1/telegram_link_codes?user_id=eq.${encodeURIComponent(user.id)}`,
    { method: 'DELETE', headers: { prefer: 'return=minimal' } });
  if (!cleared.ok) throw new Error(`Previous Telegram link codes could not be cleared (${cleared.status})`);
  const response = await supabaseRequest(env, '/rest/v1/telegram_link_codes', {
    method: 'POST',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({
      code_hash: codeHash,
      user_id: user.id,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }),
  });
  if (!response.ok) throw new Error(`Telegram link code could not be saved (${response.status})`);
  return json({ code, bot_username: env.TELEGRAM_BOT_USERNAME || null, expires_in_seconds: 600 });
}

async function handleTelegramWebhook(req, env) {
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || !equal(req.headers.get('x-telegram-bot-api-secret-token'), expected)) {
    return json({ error: 'unauthorized' }, 401);
  }
  const raw = await req.text();
  if (raw.length > 16_384) return json({ error: 'request too large' }, 413);
  let update;
  try { update = JSON.parse(raw); } catch { return json({ error: 'invalid JSON body' }, 400); }
  const message = update?.message;
  const match = message?.chat?.type === 'private' && typeof message?.text === 'string' &&
    message.text.match(/^\/start\s+([a-f0-9]{32})$/i);
  if (!match || !message?.chat?.id) return json({ ok: true });
  const codeHash = bytesToHex(await sha256(match[1]));
  const linked = await supabaseRequest(env, '/rest/v1/rpc/consume_telegram_link_code', {
    method: 'POST',
    body: JSON.stringify({ p_code_hash: codeHash, p_chat_id: String(message.chat.id) }),
  });
  if (!linked.ok) throw new Error(`Telegram code verification failed (${linked.status})`);
  const userId = await linked.json();
  if (userId && env.TELEGRAM_BOT_TOKEN) {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: String(message.chat.id), text: 'Your BingleSignal account is connected. You will receive your briefing here.' }),
    });
    let result = {};
    try { result = await response.json(); } catch {}
    if (!response.ok || result.ok === false) {
      console.warn('Telegram link confirmation failed', { status_code: response.status || 502 });
    }
  }
  return json({ ok: true });
}

async function handleUnsubscribe(req, env) {
  const url = new URL(req.url);
  const userId = url.searchParams.get('user') || '';
  const expires = Number(url.searchParams.get('expires'));
  const signature = url.searchParams.get('sig') || '';
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !Number.isInteger(expires) ||
      expires < Math.floor(Date.now() / 1000) || expires > Math.floor(Date.now() / 1000) + 366 * 86400 ||
      !env.DELIVERY_UNSUBSCRIBE_SECRET) return text('This unsubscribe link is invalid or expired.', 400);
  const expected = await unsubscribeSignature(userId, expires, env.DELIVERY_UNSUBSCRIBE_SECRET);
  if (!equal(signature, expected)) return text('This unsubscribe link is invalid or expired.', 400);
  const response = await supabaseRequest(env,
    `/rest/v1/user_profile_v2?user_id=eq.${encodeURIComponent(userId)}`,
    { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ delivery_channel: 'app' }) });
  if (!response.ok) throw new Error(`Unsubscribe update failed (${response.status})`);
  return text('You are unsubscribed from email briefings. You can change delivery settings in your BingleSignal account.');
}

export async function handleDeliveryRequest(req, env) {
  const path = new URL(req.url).pathname;
  if (path === '/api/telegram/webhook' && req.method === 'POST') return handleTelegramWebhook(req, env);
  if (path === '/api/telegram/link-code' && req.method === 'POST') return createTelegramCode(req, env);
  if (path === '/api/unsubscribe' && ['GET', 'POST'].includes(req.method)) return handleUnsubscribe(req, env);
  return json({ error: 'not found' }, 404);
}
