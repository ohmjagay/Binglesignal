export const DEFAULT_CLUSTER_THRESHOLD = 0.78;
export const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';

function cosine(a, b) {
  if (!a?.length || a.length !== b?.length) return 0;
  let dot = 0, left = 0, right = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    left += a[index] * a[index];
    right += b[index] * b[index];
  }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}

function senderKey(item) {
  return String(item.from_address || item.from || '').trim().toLowerCase();
}

function embeddingInput(item) {
  const domain = String(item.from_domain || senderKey(item).split('@').pop() || '').slice(0, 100);
  return `${domain} ${String(item.subject || '').slice(0, 200)} ${String(item.text || item.summary || '').slice(0, 300)}`.trim();
}

function extractVectors(result, count) {
  const vectors = result?.data || result?.embeddings;
  if (!Array.isArray(vectors) || vectors.length !== count ||
      vectors.some((vector) => !Array.isArray(vector) || vector.some((value) => !Number.isFinite(value)))) {
    throw new Error('Workers AI returned invalid email embeddings');
  }
  return vectors;
}

export async function clusterEmails(items, env = {}, threshold = DEFAULT_CLUSTER_THRESHOLD) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('Email cluster threshold must be between 0 and 1');
  const clusters = [];
  const bulkBySender = new Map();
  const semantic = items.filter((item) => !item.bulk && item.category !== 'security');
  let vectors = [];
  if (semantic.length) {
    if (!env.AI) throw new Error('Workers AI binding is required for email clustering');
    const result = await env.AI.run(EMBEDDING_MODEL, { text: semantic.map(embeddingInput) });
    vectors = extractVectors(result, semantic.length);
  }
  const semanticVectors = new Map(semantic.map((item, index) => [item.id, vectors[index]]));

  for (const item of items) {
    if (item.bulk) {
      const key = `${item.category || 'newsletter'}:${senderKey(item) || item.from_domain || 'unknown'}`;
      let cluster = bulkBySender.get(key);
      if (!cluster) {
        cluster = { key, category: item.category || 'newsletter', items: [], centroid: null };
        bulkBySender.set(key, cluster);
        clusters.push(cluster);
      }
      cluster.items.push(item);
      continue;
    }
    if (item.category === 'security') {
      clusters.push({ key: `security:${item.id}`, category: 'security', items: [item], centroid: null });
      continue;
    }
    const vector = semanticVectors.get(item.id);
    const match = clusters.find((cluster) => cluster.centroid &&
      cluster.category === (item.category || 'needs_action') && cosine(vector, cluster.centroid) >= threshold);
    if (match) {
      match.items.push(item);
      const total = match.items.length;
      match.centroid = match.centroid.map((value, index) => (value * (total - 1) + vector[index]) / total);
    } else {
      clusters.push({
        key: `topic:${item.id}`,
        category: item.category || 'needs_action',
        items: [item],
        centroid: vector,
      });
    }
  }
  return clusters;
}
