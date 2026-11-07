const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const ROLES = [
  ['ceo_founder', 'CEO / Founder'], ['cfo', 'CFO'], ['product', 'Product'],
  ['marketing_brand', 'Marketing / Brand'], ['investor', 'Investor'],
  ['consultant', 'Consultant'], ['legal_ca', 'Legal / CA'], ['doctor', 'Doctor'], ['other', 'Other'],
];

async function request(path, method = 'GET', body) {
  const token = await window.BSAuth?.token();
  if (!token) throw new Error('Your sign-in expired. Please sign in again.');
  const response = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

const lines = values => (values || []).join('\n');

export async function renderOnboarding(root) {
  root.innerHTML = '<div class="end">Loading your briefing preferences…</div>';
  try {
    const [{ profile }, { watchlist, limit }] = await Promise.all([
      request('/api/profile'), request('/api/watchlist'),
    ]);
    root.innerHTML = `<section class="sum"><div class="eyebrow">Personalization</div><h1 class="serif">Tune your briefing</h1><p>These six optional questions shape your daily edition. You can skip any of them and update your answers later.</p></section>
      <form id="profile-form" class="card email-settings">
        <label>1. Your role<select name="role">${ROLES.map(([value, label]) => `<option value="${value}"${profile.role === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
        <label>2. Your industry<input name="industry" maxlength="80" value="${escapeHtml(profile.industry)}" placeholder="For example: SaaS, healthcare, manufacturing"></label>
        <label>3. Where you operate<select name="region">${[['IN','India'],['US','United States'],['GB','United Kingdom'],['EU','Europe'],['GL','Global']].map(([value,label])=>`<option value="${value}"${profile.region===value?' selected':''}>${label}</option>`).join('')}</select></label>
        <label>4. Watchlist <small>One per line: company:, person:, regulator:, or keyword: — up to ${limit} entries on your plan.</small><textarea name="watchlist" rows="4" placeholder="company: Acme&#10;regulator: RBI">${escapeHtml(watchlist.map(item => `${item.kind}: ${item.term}`).join('\n'))}</textarea></label>
        <label>5. Never show me <small>Enter topics and source names, one per line.</small><textarea name="blocked_topics" rows="3">${escapeHtml(lines(profile.blocked_topics))}</textarea><textarea name="muted_sources" rows="3" aria-label="Muted sources" placeholder="Source names to mute">${escapeHtml(lines(profile.muted_sources))}</textarea></label>
        <label>6. Delivery preferences<div class="email-settings"><label>Time zone<input name="timezone" required maxlength="64" value="${escapeHtml(profile.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')}"></label><label>Time<input name="delivery_time" type="time" step="900" required value="${escapeHtml(String(profile.delivery_time || '07:00').slice(0,5))}"></label><label>Brief length<select name="brief_length">${[5,10,15].map(value=>`<option value="${value}"${Number(profile.brief_length)===value?' selected':''}>${value} minutes</option>`).join('')}</select></label><label>Channel<select name="delivery_channel">${['app','email','telegram'].map(value=>`<option value="${value}"${profile.delivery_channel===value?' selected':''}>${value==='app'?'In the app':value[0].toUpperCase()+value.slice(1)}</option>`).join('')}</select></label><div id="telegram-link-panel" ${profile.delivery_channel === 'telegram' ? '' : 'hidden'}><p>To link Telegram, create a one-time code and send it to the BingleSignal bot. The code expires after 10 minutes.</p><button class="btn" type="button" id="telegram-link-button">Create one-time Telegram code</button><p id="telegram-link-message" class="email-message" role="status"></p></div></div></label>
        <p id="onboarding-message" class="email-message" role="status"></p><button class="btn fill" type="submit">Save my preferences</button><button class="btn" type="button" id="skip-onboarding">Skip for now</button>
      </form>`;
    const form = root.querySelector('#profile-form');
    const message = root.querySelector('#onboarding-message');
    const channel = form.elements.delivery_channel;
    const telegramPanel = root.querySelector('#telegram-link-panel');
    channel.addEventListener('change', () => { telegramPanel.hidden = channel.value !== 'telegram'; });
    root.querySelector('#telegram-link-button').addEventListener('click', async event => {
      const button = event.currentTarget;
      const output = root.querySelector('#telegram-link-message');
      button.disabled = true;
      output.textContent = '';
      try {
        const result = await request('/api/telegram/link-code', 'POST', {});
        output.textContent = `One-time code: ${result.code}. In Telegram, open ${result.bot_username ? '@' + result.bot_username : 'the BingleSignal bot'} and send: /start ${result.code}`;
      } catch (error) {
        output.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
    root.querySelector('#skip-onboarding').addEventListener('click', () => { location.hash = '#/me/read'; });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const data = new FormData(form);
      const watchlistLines = String(data.get('watchlist') || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const blockedTopics = String(data.get('blocked_topics') || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const mutedSources = String(data.get('muted_sources') || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const profileBody = {
        role: data.get('role'),
        industry: data.get('industry'),
        region: data.get('region'),
        timezone: data.get('timezone'),
        delivery_time: data.get('delivery_time'),
        delivery_channel: data.get('delivery_channel'),
        brief_length: Number(data.get('brief_length')),
        interests: profile.interests || [],
        blocked_topics: blockedTopics,
        muted_sources: mutedSources,
      };
      try {
        const entries = watchlistLines.map(line => {
          const match = line.match(/^(company|person|regulator|keyword)\s*:\s*(.{2,80})$/i);
          if (!match) throw new Error('Use the format "company: Acme" for each watchlist line.');
          return { kind: match[1].toLowerCase(), term: match[2].trim() };
        });
        const uniqueEntries = [...new Map(entries.map(entry =>
          [`${entry.kind}:${entry.term.toLowerCase()}`, entry])).values()];
        if (uniqueEntries.length > limit) throw new Error(`Your plan supports up to ${limit} watchlist entries.`);
        for (const entry of watchlist) await request(`/api/watchlist?id=${encodeURIComponent(entry.id)}`, 'DELETE');
        for (const entry of uniqueEntries) await request('/api/watchlist', 'POST', entry);
        await request('/api/profile', 'PUT', profileBody);
        message.textContent = 'Preferences saved. Your next edition will reflect them.';
      } catch (error) {
        message.textContent = error.message;
      }
    });
  } catch (error) {
    root.innerHTML = `<div class="card end" role="alert">${escapeHtml(error.message)}</div>`;
  }
}
