import { fileURLToPath } from 'node:url';

const FEEDBACK_WEIGHT = {
  like: 1, save: 0.8, share: 0.8, open: 0.3, dwell: 0.3,
  dislike: -1, less_like: -1, skip: -0.5,
};

export function calculateWeights(feedback, categoriesByStory, currentWeights = {}, now = Date.now()) {
  const grouped = new Map();
  for (const item of feedback) {
    const category = String(categoriesByStory.get(item.story_id) || '').toLowerCase();
    const signalWeight = FEEDBACK_WEIGHT[item.signal];
    if (!category || signalWeight === undefined) continue;
    const ageDays = Math.max(0, (now - Date.parse(item.created_at || now)) / 864e5);
    if (ageDays > 30) continue;
    const recency = 2 ** (-ageDays / 14);
    const entry = grouped.get(category) || { score: 0, weight: 0 };
    entry.score += signalWeight * recency;
    entry.weight += recency;
    grouped.set(category, entry);
  }
  const updated = { ...currentWeights };
  for (const [category, entry] of grouped) {
    const learned = Math.max(-1, Math.min(1, entry.score / entry.weight));
    const prior = Number(currentWeights[category]) || 0;
    updated[category] = Math.round((prior * 0.7 + learned * 0.3) * 1000) / 1000;
  }
  return updated;
}

async function request(path, key, init = {}) {
  const response = await fetch(`${process.env.SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: key,
      authorization: ['Bearer', key].join(' '),
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`Supabase request failed (${response.status})`);
  return response.status === 204 ? [] : response.json();
}

export async function learnWeights(env = process.env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_URL || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');

  const profiles = await request('/rest/v1/user_profile_v2?select=user_id,learned_weights&limit=5000', key);
  let updated = 0;
  for (const profile of profiles) {
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const feedback = await request(`/rest/v1/feedback?user_id=eq.${encodeURIComponent(profile.user_id)}&created_at=gte.${encodeURIComponent(since)}&select=story_id,signal,created_at&limit=1000`, key);
    if (!feedback.length) continue;
    const ids = [...new Set(feedback.map((item) => item.story_id))];
    const categories = new Map();
    for (let offset = 0; offset < ids.length; offset += 100) {
      const group = ids.slice(offset, offset + 100);
      const filter = group.map((id) => encodeURIComponent(id)).join(',');
      const notes = await request(`/rest/v1/story_notes?story_id=in.(${filter})&select=story_id,category`, key);
      for (const note of notes) categories.set(note.story_id, note.category);
    }
    const weights = calculateWeights(feedback, categories, profile.learned_weights || {});
    await request(`/rest/v1/user_profile_v2?user_id=eq.${encodeURIComponent(profile.user_id)}`, key, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ learned_weights: weights, updated_at: new Date().toISOString() }),
    });
    updated++;
  }
  return { profiles: profiles.length, updated };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  learnWeights().then(({ profiles, updated }) => {
    console.log(`Learned preference weights for ${updated} of ${profiles} profiles.`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
