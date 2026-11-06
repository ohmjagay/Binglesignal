import { authUser, supabaseRequest } from './supabase.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const SOURCE_WEIGHT = { 1: 1, 2: 0.8, 3: 0.6, 4: 0.4 };
const INTEREST_LABELS = {
  ai: 'AI', business: 'business', india: 'India', fintech: 'fintech', markets: 'markets',
  policy: 'policy', startups: 'startups', tech: 'technology', world: 'world affairs',
};
const clamp = (value) => Math.max(0, Math.min(1, value));

async function rows(env, path, init) {
  const response = await supabaseRequest(env, path, init);
  if (!response.ok) throw new Error(`Briefing storage request failed (${response.status})`);
  const body = await response.text();
  return body ? JSON.parse(body) : [];
}

async function activePlan(env, userId) {
  const subscriptions = await rows(env,
    `/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=plan,status,trial_ends_at,current_period_end&limit=1`);
  const subscription = subscriptions[0];
  if (!subscription || !['lite', 'pro'].includes(subscription.plan)) return null;
  const now = Date.now();
  const end = Date.parse(subscription.current_period_end || subscription.trial_ends_at);
  const active = subscription.status === 'trialing' ? Date.parse(subscription.trial_ends_at) > now
    : subscription.status === 'active' ? !subscription.current_period_end || end + 2 * 864e5 > now
    : subscription.status === 'past_due' ? end + 3 * 864e5 > now
    : subscription.status === 'canceled' ? !!subscription.current_period_end && end > now : false;
  return active ? subscription.plan : null;
}

async function requireReader(req, env) {
  const user = await authUser(req, env);
  if (!user) return { response: json({ error: 'login required' }, 401) };
  const plan = await activePlan(env, user.id);
  if (!plan) return { response: json({ error: 'An active Lite or Pro plan is required' }, 403) };
  return { user, plan };
}

async function poolRows(env, now = new Date()) {
  const output = [];
  for (let offset = 0; offset < 4000; offset += 500) {
    const page = await rows(env,
      `/rest/v1/story_clusters?select=story_id,stories,embedding,source_tier,source_count,published_at,expires_at&expires_at=gt.${encodeURIComponent(now.toISOString())}&order=published_at.desc&limit=500&offset=${offset}`);
    output.push(...page);
    if (page.length < 500) break;
  }
  return output;
}

function inFilter(ids) {
  return `in.(${ids.map((id) => encodeURIComponent(id)).join(',')})`;
}

async function notesForStories(env, ids) {
  if (!ids.length) return new Map();
  const groups = [];
  for (let offset = 0; offset < ids.length; offset += 200) {
    groups.push(ids.slice(offset, offset + 200));
  }
  const pages = await Promise.all(groups.map((group) => rows(env,
    `/rest/v1/story_notes?story_id=${inFilter(group)}&select=story_id,headline,summary,why_it_matters,do_next,category,entities,confidence,source_count,sources`)));
  return new Map(pages.flat().map((note) => [note.story_id, note]));
}

function publicItems(clusterRows, notes) {
  return clusterRows.flatMap((cluster) => (Array.isArray(cluster.stories) ? cluster.stories : []).map((story) => {
    const note = notes.get(cluster.story_id) || {};
    return {
      ...story,
      c: cluster.story_id,
      n: cluster.source_count,
      embedding: cluster.embedding,
      source_tier: cluster.source_tier,
      headline: note.headline || story.t,
      summary: note.summary || '',
      why_it_matters: note.why_it_matters || '',
      do_next: note.do_next || '',
    };
  }));
}

function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) return 0;
  let product = 0, leftNorm = 0, rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    const a = Number(left[index]), b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    product += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return product / Math.sqrt(leftNorm * rightNorm || 1);
}

function terms(value) {
  return String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 2);
}

export function rankEdition(stories, notes, profile, watchlist, recentlyShown, plan, now = Date.now()) {
  const interests = Array.isArray(profile?.interests)
    ? profile.interests.map((interest) => typeof interest === 'string' ? interest : interest?.id).filter(Boolean)
    : [];
  const watches = watchlist.map((entry) => ({ term: String(entry.term || '').trim(), kind: entry.kind }))
    .filter((entry) => entry.term);
  const recent = new Set(recentlyShown);
  const mutedSources = new Set((profile?.muted_sources || []).map((source) => String(source).toLowerCase()));
  const blockedTopics = new Set((profile?.blocked_topics || []).map((topic) => String(topic).toLowerCase()));
  const evaluated = stories.map((story) => {
    const note = notes.get(story.story_id) || {};
    const sources = (Array.isArray(story.stories) ? story.stories : [])
      .filter((source) => !mutedSources.has(String(source.s || '').toLowerCase()));
    const representative = sources[0] || {};
    if (!representative.t || (representative.k || []).some((topic) => blockedTopics.has(String(topic).toLowerCase()))) return null;
    const noteText = `${note.headline || representative.t || ''} ${note.summary || ''}`.toLowerCase();
    const matchedWatches = watches.filter(({ term }) => noteText.includes(term.toLowerCase()));
    const matchedInterests = interests.filter((interest) => (representative.k || []).includes(interest));
    const vector = Array.isArray(representative.embedding) ? representative.embedding : story.embedding;
    const interestVector = profile?.interest_vector;
    const relevance = Array.isArray(interestVector) && Array.isArray(vector)
      ? clamp((cosine(vector, interestVector) + 1) / 2)
      : clamp(matchedInterests.length / Math.max(1, Math.min(interests.length, 3)));
    const tier = Number(story.source_tier) || 4;
    const sourceCount = Math.max(1, Number(story.source_count) || 1);
    const importance = clamp((SOURCE_WEIGHT[tier] || SOURCE_WEIGHT[4]) *
      (0.7 + 0.3 * Math.min(1, Math.log2(sourceCount + 1) / 2)));
    const ageHours = Math.max(0, (now - Date.parse(story.published_at || representative.d || now)) / 36e5);
    const category = String(note.category || 'news').toLowerCase();
    const halfLife = /market|finance/.test(category) ? 3 : /policy|regulat/.test(category) ? 24 : 72;
    const urgency = 2 ** (-ageHours / halfLife);
    const region = String(profile?.region || '').toUpperCase();
    const personal = clamp((matchedWatches.length ? 1 : 0) * 0.75 + (matchedInterests.length ? 0.5 : 0) +
      ((representative.g || []).includes(region) ? 0.25 : 0));
    const novelty = recent.has(story.story_id) ? 0 : 1;
    const score = 0.35 * relevance + 0.25 * importance + 0.15 * urgency + 0.15 * personal + 0.10 * novelty;
    const whyRanked = matchedWatches.length
      ? `Watchlist match: ${matchedWatches.slice(0, 2).map((match) => match.term).join(', ')}.`
      : matchedInterests.length
        ? `Matches your ${matchedInterests.slice(0, 2).map((interest) => INTEREST_LABELS[interest] || interest).join(' and ')} interests.`
        : tier === 1 ? 'Primary-source update with high editorial importance.'
        : `${sourceCount} source${sourceCount === 1 ? '' : 's'}; recent and not shown in your latest editions.`;
    const personalizedWhy = matchedWatches.length
      ? `This matches your watchlist: ${matchedWatches.slice(0, 2).map((match) => match.term).join(', ')}.`
      : matchedInterests.length
        ? `This relates to your selected interests: ${matchedInterests.slice(0, 2).map((interest) => INTEREST_LABELS[interest] || interest).join(', ')}.`
        : '';
    return {
      story_id: story.story_id,
      score,
      watchlist_hit: matchedWatches.length > 0,
      embedding: vector,
      item: {
        ...representative,
        c: story.story_id,
        n: sourceCount,
        headline: note.headline || representative.t || '',
        summary: note.summary || '',
        why_it_matters: personalizedWhy || note.why_it_matters || '',
        do_next: note.do_next || '',
        why_ranked_here: whyRanked,
        source_count: sourceCount,
        source_tier: tier,
      },
    };
  }).filter((entry) => entry && entry.item.t && /^https:\/\//i.test(entry.item.u));

  const mandatory = evaluated.filter((entry) => entry.watchlist_hit).sort((a, b) => b.score - a.score);
  const rest = evaluated.filter((entry) => !entry.watchlist_hit).sort((a, b) => b.score - a.score);
  const cap = plan === 'pro' ? 15 : 10;
  const selected = mandatory.slice(0, Math.min(3, cap));
  while (selected.length < cap && rest.length) {
    let bestIndex = 0, bestScore = -Infinity;
    for (let index = 0; index < rest.length; index++) {
      const diversityPenalty = selected.reduce((penalty, entry) =>
        Math.max(penalty, Math.max(0, cosine(rest[index].embedding, entry.embedding))), 0);
      const adjusted = rest[index].score - 0.15 * diversityPenalty;
      if (adjusted > bestScore) { bestIndex = index; bestScore = adjusted; }
    }
    selected.push(rest.splice(bestIndex, 1)[0]);
  }
  const ignore = evaluated.filter((entry) => !selected.some((picked) => picked.story_id === entry.story_id))
    .sort((a, b) => b.score - a.score).slice(0, plan === 'pro' ? 5 : 3)
    .map((entry) => ({ story_id: entry.story_id, headline: entry.item.headline, reason: 'Ranked lower for your interests or already covered by a more relevant story.' }));
  return { items: selected.map((entry) => entry.item), safely_ignore: ignore };
}

export async function handleBriefingRequest(req, env) {
  const url = new URL(req.url);
  const context = await requireReader(req, env);
  if (context.response) return context.response;
  if (url.pathname === '/api/pool' && req.method === 'GET') {
    const clusters = await poolRows(env);
    const notes = await notesForStories(env, clusters.map((story) => story.story_id));
    const items = publicItems(clusters, notes);
    return json({
      plan: context.plan,
      gen: Math.floor(Date.now() / 1000),
      items: items.slice(0, context.plan === 'pro' ? 3000 : 1200),
    });
  }
  if (url.pathname === '/api/edition/latest' && req.method === 'GET') {
    const editions = await rows(env,
      `/rest/v1/editions?user_id=eq.${encodeURIComponent(context.user.id)}&select=slot_key,kind,plan,local_date,local_slot,items,safely_ignore,created_at,opened_at&order=created_at.desc&limit=1`);
    return json({ edition: editions[0] || null });
  }
  if (url.pathname === '/api/feedback' && req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
    const validSignals = new Set(['like', 'dislike', 'less_like', 'mute_source', 'open', 'dwell', 'save', 'share', 'skip']);
    if (!body || typeof body.story_id !== 'string' || !/^[a-z0-9]{1,32}$/i.test(body.story_id) ||
        !validSignals.has(body.signal) ||
        body.signal === 'mute_source' && (typeof body.source !== 'string' || body.source.trim().length < 1 || body.source.length > 120)) {
      return json({ error: 'invalid feedback' }, 400);
    }
    await rows(env, '/rest/v1/feedback?on_conflict=user_id,story_id,signal', {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        user_id: context.user.id,
        story_id: body.story_id,
        signal: body.signal,
        source: body.signal === 'mute_source' ? body.source.trim() : null,
      }),
    });
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

async function poolForEditions(env) {
  const clusters = await poolRows(env);
  const notes = await notesForStories(env, clusters.map((story) => story.story_id));
  return { clusters, notes };
}

export async function handleEditionSchedule(env, now = new Date()) {
  const slots = await rows(env, '/rest/v1/rpc/claim_due_edition_slots', {
    method: 'POST',
    body: JSON.stringify({ p_now: now.toISOString() }),
  });
  if (!slots.length) return;
  const due = slots.slice(0, 100);
  const userIds = [...new Set(due.map((slot) => slot.user_id))];
  const filter = inFilter(userIds);
  const [profiles, watchlist, feedback, previous, pool] = await Promise.all([
    rows(env, `/rest/v1/user_profile_v2?user_id=${filter}&select=user_id,role,industry,timezone,delivery_time,brief_length,interests,blocked_topics,muted_sources`),
    rows(env, `/rest/v1/watchlists?user_id=${filter}&select=user_id,kind,term`),
    rows(env, `/rest/v1/feedback?user_id=${filter}&created_at=gte.${encodeURIComponent(new Date(now.getTime() - 3 * 864e5).toISOString())}&select=user_id,story_id,signal,source`),
    rows(env, `/rest/v1/editions?user_id=${filter}&created_at=gte.${encodeURIComponent(new Date(now.getTime() - 3 * 864e5).toISOString())}&select=user_id,items&limit=1000`),
    poolForEditions(env),
  ]);
  const profilesByUser = new Map(profiles.map((profile) => [profile.user_id, profile]));
  const watchesByUser = new Map(), feedbackByUser = new Map(), recentByUser = new Map();
  for (const entry of watchlist) watchesByUser.set(entry.user_id, [...(watchesByUser.get(entry.user_id) || []), entry]);
  for (const entry of feedback) feedbackByUser.set(entry.user_id, [...(feedbackByUser.get(entry.user_id) || []), entry]);
  for (const edition of previous) {
    const ids = (edition.items || []).map((item) => item.story_id).filter(Boolean);
    recentByUser.set(edition.user_id, [...(recentByUser.get(edition.user_id) || []), ...ids]);
  }
  const upserts = due.map((slot) => {
    const userProfile = profilesByUser.get(slot.user_id) || {};
    const feedbackRows = feedbackByUser.get(slot.user_id) || [];
    const blockedIds = new Set(feedbackRows.filter((item) => ['dislike', 'less_like', 'skip'].includes(item.signal)).map((item) => item.story_id));
    const mutedSources = feedbackRows.filter((item) => item.signal === 'mute_source' && item.source).map((item) => item.source);
    const ranked = rankEdition(pool.clusters.filter((story) => !blockedIds.has(story.story_id)), pool.notes,
      { ...userProfile, muted_sources: [...(userProfile.muted_sources || []), ...mutedSources] },
      watchesByUser.get(slot.user_id) || [], recentByUser.get(slot.user_id) || [], slot.plan, now.getTime());
    const items = ranked.items;
    return {
      slot_key: slot.slot_key,
      user_id: slot.user_id,
      kind: 'daily',
      plan: slot.plan,
      local_date: slot.local_date,
      local_slot: slot.local_slot,
      items: items.slice(0, slot.plan === 'pro' ? 15 : 10).map((item) => ({
        story_id: item.c,
        item,
        why_it_matters: item.why_it_matters,
        why_ranked_here: item.why_ranked_here,
        do_next: item.do_next,
      })),
      safely_ignore: ranked.safely_ignore,
    };
  });
  await rows(env, '/rest/v1/editions?on_conflict=slot_key', {
    method: 'POST',
    headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(upserts),
  });
  console.log('briefing editions composed', upserts.length);
}
