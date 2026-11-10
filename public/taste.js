// Taste vector: a running average of the "meaning numbers" (embeddings) of the stories and videos a reader liked, saved, opened
// or watched, pushed away from what they hid or skipped. Items close in meaning rank higher, even when no keyword or topic matches.
// Pure functions only (no page access), so they are easy to test.
const isVec = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => Number.isFinite(x));
const unit = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };

export function cosine(a, b) {
  if (!isVec(a) || !isVec(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na * nb) || 1);
}

// weight: +1 = strong like (saved, finished a video), -1 = strong dislike (hid it), small numbers = weak signals.
export function updateTaste(taste, vector, weight, rate = 0.12) {
  if (!isVec(vector) || !Number.isFinite(weight) || weight === 0) return taste;
  const next = unit(vector);
  const base = isVec(taste) && taste.length === next.length ? taste : new Array(next.length).fill(0);
  const r = rate * Math.min(1, Math.abs(weight)), sign = Math.sign(weight);
  return base.map((x, i) => Math.round(((1 - r) * x + r * sign * next[i]) * 1000) / 1000);
}

// -1..1 per item id. Scores are compared inside the candidate pool (z-score), so no fixed similarity threshold is needed.
export function tasteScores(taste, items) {
  const raw = new Map();
  if (!isVec(taste)) return raw;
  for (const item of items) if (isVec(item.embedding) && item.embedding.length === taste.length) raw.set(item.id, cosine(taste, item.embedding));
  if (raw.size < 5) return new Map();
  const values = [...raw.values()];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) || 1;
  return new Map([...raw].map(([id, c]) => [id, Math.max(-1, Math.min(1, (c - mean) / sd / 2))]));
}

// Keeps the order but moves anything beyond `max` per key (for example per YouTube channel) to the end, so one channel cannot fill the queue.
export function capPerKey(list, key, max) {
  const seen = new Map(), keep = [], rest = [];
  for (const entry of list) {
    const k = key(entry), n = seen.get(k) || 0;
    if (n < max) { keep.push(entry); seen.set(k, n + 1); } else rest.push(entry);
  }
  return [...keep, ...rest];
}
