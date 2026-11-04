import { authUser, hasProAccess, supabaseRequest } from './supabase.js';

const BETA_DAILY_LIMIT = 500;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_CONNECTION = 5;
const enc = new TextEncoder();

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function base64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function base64url(bytes) {
  return base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value)));
}

function encryptionKey(env) {
  if (!env.EMAIL_TOKEN_ENCRYPTION_KEY) throw new Error('EMAIL_TOKEN_ENCRYPTION_KEY is not configured');
  const raw = fromBase64(env.EMAIL_TOKEN_ENCRYPTION_KEY);
  if (raw.byteLength !== 32) throw new Error('EMAIL_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encrypt(value, env) {
  const key = await encryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(value)));
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv);
  packed.set(ciphertext, iv.length);
  return base64(packed);
}

async function decrypt(value, env) {
  const key = await encryptionKey(env);
  const packed = fromBase64(value);
  if (packed.length <= 12) throw new Error('Encrypted token is invalid');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.slice(0, 12) }, key, packed.slice(12));
  return new TextDecoder().decode(plaintext);
}

async function rows(env, path, init) {
  const response = await supabaseRequest(env, path, init);
  if (!response.ok) throw new Error(`Supabase request failed: ${response.status}`);
  const body = await response.text();
  return body ? JSON.parse(body) : [];
}

async function betaContext(req, env) {
  const user = await authUser(req, env);
  if (!user) return { response: json({ error: 'login required' }, 401) };
  if (!await hasProAccess(user.id, env)) return { response: json({ error: 'Pro access required' }, 403) };
  const betaUsers = await rows(env, `/rest/v1/email_beta_users?user_id=eq.${encodeURIComponent(user.id)}&enabled=eq.true&limit=1`);
  if (!betaUsers.length) return { response: json({ error: 'Email summariser beta is invite-only' }, 403) };
  const activeUsers = await rows(env, '/rest/v1/email_beta_users?enabled=eq.true&select=user_id&limit=51');
  if (activeUsers.length > 50) return { response: json({ error: 'Email beta is paused because its 50-user limit was exceeded' }, 503) };
  return { user, beta: betaUsers[0] };
}

function oauthConfig(provider, env) {
  if (provider === 'gmail') {
    return {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: env.GOOGLE_EMAIL_REDIRECT_URI,
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
    };
  }
  if (provider === 'outlook') {
    return {
      clientId: env.MICROSOFT_CLIENT_ID,
      clientSecret: env.MICROSOFT_CLIENT_SECRET,
      redirectUri: env.MICROSOFT_EMAIL_REDIRECT_URI,
      authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    };
  }
  return null;
}

function providerFields(provider) {
  if (provider === 'gmail') {
    return {
      scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.metadata'],
      authParams: { access_type: 'offline', prompt: 'consent' },
    };
  }
  return {
    scopes: ['openid', 'email', 'profile', 'offline_access', 'User.Read', 'Mail.ReadBasic'],
    authParams: { response_mode: 'query' },
  };
}

async function startConnect(req, env, user) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
  const provider = body?.provider;
  const config = oauthConfig(provider, env);
  if (!config) return json({ error: 'provider must be gmail or outlook' }, 400);
  if (body?.consent !== true) return json({ error: 'explicit mailbox consent is required' }, 400);
  if (!config.clientId || !config.clientSecret || !config.redirectUri) return json({ error: `${provider} OAuth is not configured` }, 503);

  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(await digest(verifier));
  await rows(env, '/rest/v1/email_oauth_states', {
    method: 'POST',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({
      state_hash: base64url(await digest(state)),
      user_id: user.id,
      provider,
      encrypted_code_verifier: await encrypt(verifier, env),
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }),
  });

  const fields = providerFields(provider);
  const authorize = new URL(config.authorizeUrl);
  authorize.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: fields.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...fields.authParams,
  }).toString();
  return json({ authorize_url: authorize.toString() });
}

async function exchangeCode(provider, code, verifier, env) {
  const config = oauthConfig(provider, env);
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: config.redirectUri,
  });
  if (provider === 'outlook') body.set('scope', providerFields(provider).scopes.join(' '));
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const result = await response.json();
  if (!response.ok || !result.access_token || !result.refresh_token) {
    throw new Error(`OAuth token exchange failed: ${response.status}`);
  }
  return result;
}

async function providerFetch(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });
  if (!response.ok) {
    const error = new Error(`Mailbox provider request failed: ${response.status}`);
    error.status = response.status;
    error.url = url;
    throw error;
  }
  return response.json();
}

async function mailboxIdentity(provider, token) {
  if (provider === 'gmail') {
    const [profile, account] = await Promise.all([
      providerFetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', token),
      providerFetch('https://openidconnect.googleapis.com/v1/userinfo', token),
    ]);
    if (!profile.historyId || !account.email) throw new Error('Google mailbox profile is incomplete');
    return { email: account.email, cursor: String(profile.historyId) };
  }
  const account = await providerFetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', token);
  const email = account.mail || account.userPrincipalName;
  if (!email) throw new Error('Microsoft mailbox profile is incomplete');
  return { email, cursor: null };
}

function returnToBeta(req, env, result) {
  const origin = new URL(req.url).origin;
  const target = env.EMAIL_BETA_RETURN_URL || `${origin}/#/email`;
  const url = new URL(target);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('EMAIL_BETA_RETURN_URL must use HTTPS');
  }
  const [route, currentQuery = ''] = url.hash.slice(1).split('?');
  const params = new URLSearchParams(currentQuery);
  params.set(result.key, result.value);
  url.hash = `${route || '/email'}?${params}`;
  return Response.redirect(url.toString(), 302);
}

async function oauthCallback(req, env, provider) {
  const url = new URL(req.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!state || !code || url.searchParams.has('error')) {
    return returnToBeta(req, env, { key: 'email_error', value: 'authorization_failed' });
  }
  const stateHash = base64url(await digest(state));
  const states = await rows(env, `/rest/v1/email_oauth_states?state_hash=eq.${encodeURIComponent(stateHash)}&provider=eq.${provider}&limit=1`);
  const pending = states[0];
  if (!pending || Date.parse(pending.expires_at) <= Date.now()) {
    return returnToBeta(req, env, { key: 'email_error', value: 'state_expired' });
  }
  await rows(env, `/rest/v1/email_oauth_states?state_hash=eq.${encodeURIComponent(stateHash)}`, { method: 'DELETE' });
  const betaUsers = await rows(env, `/rest/v1/email_beta_users?user_id=eq.${encodeURIComponent(pending.user_id)}&enabled=eq.true&limit=1`);
  if (!betaUsers.length || !await hasProAccess(pending.user_id, env)) {
    return returnToBeta(req, env, { key: 'email_error', value: 'beta_access_required' });
  }
  const token = await exchangeCode(provider, code, await decrypt(pending.encrypted_code_verifier, env), env);
  const identity = await mailboxIdentity(provider, token.access_token);
  const connection = {
    user_id: pending.user_id,
    provider,
    provider_email: identity.email,
    encrypted_refresh_token: await encrypt(token.refresh_token, env),
    cursor: identity.cursor,
    page_cursor: null,
    window_start: new Date().toISOString(),
    last_sync_at: new Date().toISOString(),
    last_error: null,
    enabled: true,
    consented_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await rows(env, '/rest/v1/email_connections?on_conflict=user_id,provider', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(connection),
  });
  return returnToBeta(req, env, { key: 'email_connected', value: provider });
}

function validSchedule(timezone, digestTime) {
  if (typeof timezone !== 'string' || typeof digestTime !== 'string' || !/^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/.test(digestTime)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

async function settings(req, env, context) {
  if (req.method === 'GET') {
    const [connections, reports] = await Promise.all([
      rows(env, `/rest/v1/email_connections?user_id=eq.${encodeURIComponent(context.user.id)}&enabled=eq.true&select=provider,provider_email,last_sync_at,last_error,consented_at`),
      rows(env, `/rest/v1/email_reports?user_id=eq.${encodeURIComponent(context.user.id)}&select=report_key,kind,email_count,report,delivery_status,created_at&order=created_at.desc&limit=30`),
    ]);
    return json({
      settings: { timezone: context.beta.timezone, digest_time: context.beta.digest_time, daily_limit: BETA_DAILY_LIMIT },
      connections,
      reports,
      beta_notice: 'Beta reports use synthetic examples. Real mailbox message text is not read or sent to an AI service.',
    });
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
  if (!validSchedule(body?.timezone, body?.digest_time)) {
    return json({ error: 'valid timezone and HH:MM digest_time on a 15-minute boundary are required' }, 400);
  }
  await rows(env, `/rest/v1/email_beta_users?user_id=eq.${encodeURIComponent(context.user.id)}`, {
    method: 'PATCH',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({ timezone: body.timezone, digest_time: body.digest_time, updated_at: new Date().toISOString() }),
  });
  return json({ ok: true });
}

async function disconnect(req, env, context) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
  if (body?.provider !== 'gmail' && body?.provider !== 'outlook') return json({ error: 'provider must be gmail or outlook' }, 400);
  const connections = await rows(env, `/rest/v1/email_connections?user_id=eq.${encodeURIComponent(context.user.id)}&provider=eq.${body.provider}&select=id,encrypted_refresh_token`);
  if (!connections.length) return json({ ok: true });
  let revocationWarning = null;
  if (body.provider === 'gmail') {
    try {
      const token = await decrypt(connections[0].encrypted_refresh_token, env);
      const revoke = await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      });
      if (!revoke.ok) revocationWarning = `Google token revocation returned ${revoke.status}; local access will still be removed`;
    } catch (error) {
      revocationWarning = `Google token revocation failed (${String(error.message || error).slice(0, 120)}); local access will still be removed`;
    }
  }
  await rows(env, `/rest/v1/email_connections?user_id=eq.${encodeURIComponent(context.user.id)}&provider=eq.${body.provider}`, { method: 'DELETE' });
  return json({ ok: true, warning: revocationWarning });
}

const TEST_REPORT = Object.freeze({
  title: 'BingleSignal email beta — test report',
  label: 'SYNTHETIC EXAMPLE',
  summary: 'This preview was generated from synthetic test emails. It does not summarize your mailbox.',
  important: ['A sample message needs a response by Thursday.', 'A sample project milestone is approaching.'],
  ignore: ['A sample promotional newsletter can wait.'],
});

async function sendReport(env, report, recipients) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { status: 'not_configured', error: null };
  if (!recipients.length) return { status: 'not_configured', error: 'No connected mailbox address is available for delivery' };
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
      'Idempotency-Key': report.report_key,
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [...new Set(recipients)],
      subject: `BingleSignal beta test report (${report.email_count} new messages detected)`,
      html: `<h1>${TEST_REPORT.title}</h1><p>${TEST_REPORT.summary}</p><p>New messages detected from mailbox metadata: ${report.email_count}. No subject, sender, or message body is included.</p><p>This is a beta fixture, not an AI summary.</p>`,
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    return { status: 'failed', error: `Email delivery failed (${response.status}): ${detail}` };
  }
  return { status: 'sent', error: null };
}

async function createReport(env, userId, kind, emailCount, reportKey, recipients) {
  const payload = {
    title: TEST_REPORT.title,
    label: TEST_REPORT.label,
    summary: TEST_REPORT.summary,
    important: TEST_REPORT.important,
    ignore: TEST_REPORT.ignore,
    email_count: emailCount,
  };
  const inserted = await rows(env, '/rest/v1/email_reports?on_conflict=report_key', {
    method: 'POST',
    headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({
      report_key: reportKey,
      user_id: userId,
      kind,
      email_count: emailCount,
      report: payload,
      delivery_status: 'pending',
    }),
  });
  if (!inserted.length) return;
  const record = { report_key: reportKey, email_count: emailCount };
  const delivery = await sendReport(env, record, recipients);
  await rows(env, `/rest/v1/email_reports?report_key=eq.${encodeURIComponent(reportKey)}`, {
    method: 'PATCH',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({
      delivery_status: delivery.status,
      delivery_error: delivery.error,
      sent_at: delivery.status === 'sent' ? new Date().toISOString() : null,
    }),
  });
}

async function connectedRecipients(env, userId) {
  const connections = await rows(env, `/rest/v1/email_connections?user_id=eq.${encodeURIComponent(userId)}&enabled=eq.true&select=provider_email`);
  return connections.map((connection) => connection.provider_email);
}

async function preview(req, env, context) {
  const recipients = await connectedRecipients(env, context.user.id);
  const key = `preview:${context.user.id}:${localClock(new Date(), context.beta.timezone).day}`;
  await createReport(env, context.user.id, 'batch', 100, key, recipients);
  return json({ ok: true, report_key: key, notice: TEST_REPORT.summary });
}

async function tokenForConnection(env, connection) {
  const refreshToken = await decrypt(connection.encrypted_refresh_token, env);
  const config = oauthConfig(connection.provider, env);
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (connection.provider === 'outlook') body.set('scope', providerFields(connection.provider).scopes.join(' '));
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) throw new Error(`Mailbox token refresh failed: ${response.status}`);
  if (result.refresh_token) {
    await rows(env, `/rest/v1/email_connections?id=eq.${encodeURIComponent(connection.id)}`, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ encrypted_refresh_token: await encrypt(result.refresh_token, env), updated_at: new Date().toISOString() }),
    });
  }
  return result.access_token;
}

async function listMessages(provider, token, connection, limit) {
  if (provider === 'gmail') {
    const state = connection.page_cursor ? JSON.parse(connection.page_cursor) : {};
    const query = new URLSearchParams({
      startHistoryId: connection.cursor,
      historyTypes: 'messageAdded',
      maxResults: '100',
    });
    if (state.pageToken) query.set('pageToken', state.pageToken);
    const result = await providerFetch(`https://gmail.googleapis.com/gmail/v1/users/me/history?${query}`, token);
    const added = [];
    for (let historyIndex = state.historyIndex || 0; historyIndex < (result.history || []).length; historyIndex++) {
      const changes = result.history[historyIndex].messagesAdded || [];
      const firstMessage = historyIndex === (state.historyIndex || 0) ? state.messageIndex || 0 : 0;
      for (let messageIndex = firstMessage; messageIndex < changes.length; messageIndex++) {
        added.push(changes[messageIndex].message.id);
        if (added.length === limit) {
          const nextState = {
            pageToken: state.pageToken || null,
            historyIndex,
            messageIndex: messageIndex + 1,
          };
          const onSamePage = historyIndex < result.history.length - 1 || messageIndex + 1 < changes.length;
          if (!onSamePage) {
            if (result.nextPageToken) {
              nextState.pageToken = result.nextPageToken;
              nextState.historyIndex = 0;
              nextState.messageIndex = 0;
            } else {
              return {
                ids: added,
                nextPage: null,
                done: true,
                cursor: result.historyId || connection.cursor,
              };
            }
          }
          return {
            ids: added,
            nextPage: JSON.stringify(nextState),
            done: false,
            cursor: connection.cursor,
          };
        }
      }
    }
    return {
      ids: added,
      nextPage: result.nextPageToken ? JSON.stringify({ pageToken: result.nextPageToken, historyIndex: 0, messageIndex: 0 }) : null,
      done: !result.nextPageToken,
      cursor: result.historyId || connection.cursor,
    };
  }

  const start = connection.window_start || connection.last_sync_at || new Date().toISOString();
  let url = connection.page_cursor;
  if (!url) {
    const query = new URLSearchParams({
      '$filter': `receivedDateTime ge ${new Date(start).toISOString()}`,
      '$select': 'id,receivedDateTime',
      '$top': String(limit),
    });
    url = `https://graph.microsoft.com/v1.0/me/messages?${query}`;
  }
  const result = await providerFetch(url, token, { headers: { Prefer: 'IdType="ImmutableId"' } });
  return {
    ids: (result.value || []).filter((message) => !message['@removed']).map((message) => message.id),
    nextPage: result['@odata.nextLink'] || null,
    done: !result['@odata.nextLink'],
    cursor: result['@odata.deltaLink'] || connection.cursor,
  };
}

async function rememberMessages(env, connectionId, ids) {
  if (!ids.length) return 0;
  const createdAt = new Date().toISOString();
  const inserted = await rows(env, '/rest/v1/email_seen_messages?on_conflict=connection_id,provider_message_id', {
    method: 'POST',
    headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify(ids.map((id) => ({
      connection_id: connectionId,
      provider_message_id: id,
      received_at: createdAt,
    }))),
  });
  return inserted.length;
}

async function updateBetaUser(env, userId, patch) {
  await rows(env, `/rest/v1/email_beta_users?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

async function processConnection(env, connection, beta, remaining) {
  if (!remaining) return { added: 0, pageCursor: connection.page_cursor };
  const token = await tokenForConnection(env, connection);
  let pageCursor = connection.page_cursor;
  let cursor = connection.cursor;
  let added = 0;
  let done = false;
  let windowStart = connection.window_start || connection.last_sync_at || new Date().toISOString();

  for (let page = 0; page < MAX_PAGES_PER_CONNECTION && remaining > added && !done; page++) {
    const limit = Math.min(PAGE_SIZE, remaining - added);
    const current = { ...connection, page_cursor: pageCursor, window_start: windowStart };
    const batch = await listMessages(connection.provider, token, current, limit);
    added += await rememberMessages(env, connection.id, batch.ids);
    pageCursor = batch.nextPage;
    cursor = batch.cursor || cursor;
    done = batch.done;
    if (!done) {
      await rows(env, `/rest/v1/email_connections?id=eq.${encodeURIComponent(connection.id)}`, {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({ page_cursor: pageCursor, window_start: windowStart, updated_at: new Date().toISOString() }),
      });
    }
  }

  const now = new Date().toISOString();
  await rows(env, `/rest/v1/email_connections?id=eq.${encodeURIComponent(connection.id)}`, {
    method: 'PATCH',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({
      page_cursor: done ? null : pageCursor,
      cursor,
      window_start: done ? now : windowStart,
      last_sync_at: done ? now : connection.last_sync_at,
      last_error: connection.last_error?.startsWith('warning:') ? connection.last_error : null,
      updated_at: now,
    }),
  });

  if (added) {
    const today = localClock(new Date(now), beta.timezone).day;
    const dailyMessages = beta.usage_date === today ? beta.daily_messages : 0;
    const pending = beta.pending_messages + added;
    let batchSequence = beta.batch_sequence;
    const recipients = await connectedRecipients(env, beta.user_id);
    let remainingPending = pending;
    while (remainingPending >= PAGE_SIZE) {
      remainingPending -= PAGE_SIZE;
      batchSequence++;
      await createReport(env, beta.user_id, 'batch', PAGE_SIZE, `batch:${beta.user_id}:${batchSequence}`, recipients);
    }
    beta.usage_date = today;
    beta.daily_messages = dailyMessages + added;
    beta.pending_messages = remainingPending;
    beta.batch_sequence = batchSequence;
    await updateBetaUser(env, beta.user_id, {
      usage_date: today,
      daily_messages: beta.daily_messages,
      pending_messages: beta.pending_messages,
      batch_sequence: batchSequence,
    });
  }

  return { added, pageCursor };
}

async function enqueueSyncJobs(env) {
  const activeUsers = await rows(env, '/rest/v1/email_beta_users?enabled=eq.true&select=user_id&order=created_at.asc&limit=51');
  if (activeUsers.length > 50) {
    console.error('email beta sync not enqueued: enabled user limit exceeded');
    return;
  }
  const slot = Math.floor(Date.now() / (6 * 60 * 60 * 1000));
  if (activeUsers.length) {
    await rows(env, '/rest/v1/email_jobs?on_conflict=id', {
      method: 'POST',
      headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(activeUsers.map(({ user_id }) => ({
        id: `sync:${user_id}:${slot}`,
        user_id,
        run_after: new Date().toISOString(),
      }))),
    });
  }
}

async function syncBetaUser(env, userId) {
  const betaRows = await rows(env, `/rest/v1/email_beta_users?user_id=eq.${encodeURIComponent(userId)}&enabled=eq.true&select=user_id,timezone,usage_date,daily_messages,pending_messages,batch_sequence&limit=1`);
  const beta = betaRows[0];
  if (!beta || !await hasProAccess(beta.user_id, env)) return;
  const connections = await rows(env, `/rest/v1/email_connections?user_id=eq.${encodeURIComponent(beta.user_id)}&enabled=eq.true&select=id,user_id,provider,provider_email,encrypted_refresh_token,cursor,page_cursor,window_start,last_sync_at,last_error&order=created_at.asc`);
  const today = localClock(new Date(), beta.timezone).day;
  if (beta.usage_date !== today) {
    beta.usage_date = today;
    beta.daily_messages = 0;
    await updateBetaUser(env, beta.user_id, { usage_date: today, daily_messages: 0 });
  }
  let remaining = Math.max(0, BETA_DAILY_LIMIT - beta.daily_messages);
  let syncFailure = null;
  for (const connection of connections) {
    if (!remaining) break;
    try {
      const result = await processConnection(env, connection, beta, remaining);
      remaining -= result.added;
    } catch (error) {
      if (connection.provider === 'gmail' && error.status === 404 && error.url?.includes('/users/me/history?')) {
        try {
          const token = await tokenForConnection(env, connection);
          const profile = await providerFetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', token);
          if (!profile.historyId) throw new Error('Google mailbox profile is incomplete');
          await rows(env, `/rest/v1/email_connections?id=eq.${encodeURIComponent(connection.id)}`, {
            method: 'PATCH',
            headers: { prefer: 'return=minimal' },
            body: JSON.stringify({
              cursor: String(profile.historyId),
              page_cursor: null,
              window_start: new Date().toISOString(),
              last_sync_at: new Date().toISOString(),
              last_error: 'warning: Gmail change history expired; messages added since the previous cursor may be missed.',
              updated_at: new Date().toISOString(),
            }),
          });
          console.warn('email beta Gmail history cursor reset after provider expiration', connection.id);
          continue;
        } catch (resetError) {
          console.error('email beta Gmail history reset failed', connection.id, resetError);
          error = resetError;
        }
      }
      console.error('email beta mailbox sync failed', connection.provider, connection.id, error);
      syncFailure ||= error;
      await rows(env, `/rest/v1/email_connections?id=eq.${encodeURIComponent(connection.id)}`, {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({ last_error: String(error.message || error).slice(0, 300), updated_at: new Date().toISOString() }),
      });
    }
  }
  await rows(env, `/rest/v1/email_seen_messages?created_at=lt.${encodeURIComponent(new Date(Date.now() - 14 * 864e5).toISOString())}`, { method: 'DELETE' });
  if (syncFailure) throw syncFailure;
}

async function processSyncJobs(env) {
  const jobs = await rows(env, '/rest/v1/rpc/claim_email_beta_jobs', {
    method: 'POST',
    body: JSON.stringify({ batch_limit: 5 }),
  });
  for (const job of jobs) {
    try {
      await syncBetaUser(env, job.user_id);
      await rows(env, `/rest/v1/email_jobs?id=eq.${encodeURIComponent(job.id)}`, { method: 'DELETE' });
    } catch (error) {
      const retryMinutes = Math.min(60, 2 ** job.attempts);
      await rows(env, `/rest/v1/email_jobs?id=eq.${encodeURIComponent(job.id)}`, {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({
          status: job.attempts >= 8 ? 'failed' : 'pending',
          run_after: new Date(Date.now() + retryMinutes * 60 * 1000).toISOString(),
          locked_until: null,
          last_error: String(error.message || error).slice(0, 300),
        }),
      });
      console.error('email beta sync job failed; retry scheduled', job.id, error);
    }
  }
}

function localClock(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { day: `${values.year}-${values.month}-${values.day}`, minute: Number(values.hour) * 60 + Number(values.minute) };
}

async function sendScheduledReports(env) {
  const betaUsers = await rows(env, '/rest/v1/email_beta_users?enabled=eq.true&select=user_id,timezone,digest_time,last_digest_local_date,usage_date,daily_messages&order=created_at.asc&limit=50');
  const now = new Date();
  for (const beta of betaUsers) {
    try {
      if (!await hasProAccess(beta.user_id, env)) continue;
      const clock = localClock(now, beta.timezone);
      const [hour, minute] = beta.digest_time.split(':').map(Number);
      const scheduledMinute = hour * 60 + minute;
      if (clock.minute < scheduledMinute || clock.minute >= scheduledMinute + 15 || beta.last_digest_local_date === clock.day) continue;
      const count = beta.usage_date === clock.day ? beta.daily_messages : 0;
      const recipients = await connectedRecipients(env, beta.user_id);
      await createReport(env, beta.user_id, 'scheduled', count, `scheduled:${beta.user_id}:${clock.day}`, recipients);
      await updateBetaUser(env, beta.user_id, { last_digest_local_date: clock.day });
    } catch (error) {
      console.error('email beta scheduled report failed', beta.user_id, error);
    }
  }
}

export async function handleEmailSchedule(cron, env) {
  if (env.EMAIL_BETA_ENABLED !== 'true') return;
  if (cron === '0 */6 * * *') await enqueueSyncJobs(env);
  if (cron === '*/5 * * * *') await processSyncJobs(env);
  if (cron === '*/15 * * * *') await sendScheduledReports(env);
}

export async function handleEmailRequest(req, env) {
  if (env.EMAIL_BETA_ENABLED !== 'true') return json({ error: 'Email beta is disabled' }, 404);
  const url = new URL(req.url);
  if (url.pathname === '/api/email/oauth/gmail/callback' && req.method === 'GET') return oauthCallback(req, env, 'gmail');
  if (url.pathname === '/api/email/oauth/outlook/callback' && req.method === 'GET') return oauthCallback(req, env, 'outlook');
  if (!url.pathname.startsWith('/api/email/')) return json({ error: 'not found' }, 404);
  const context = await betaContext(req, env);
  if (context.response) return context.response;

  if (url.pathname === '/api/email/settings') return settings(req, env, context);
  if (url.pathname === '/api/email/connect' && req.method === 'POST') return startConnect(req, env, context.user);
  if (url.pathname === '/api/email/disconnect' && req.method === 'POST') return disconnect(req, env, context);
  if (url.pathname === '/api/email/preview' && req.method === 'POST') return preview(req, env, context);
  return json({ error: 'not found' }, 404);
}

export const betaTestReport = () => TEST_REPORT;
export const isValidBetaSchedule = validSchedule;
