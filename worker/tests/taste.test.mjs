import test from 'node:test';
import assert from 'node:assert/strict';
import { capPerKey, cosine, tasteScores, updateTaste } from '../../public/taste.js';

const A = [1, 0, 0, 0], B = [0, 1, 0, 0];
const near = (base, i) => base.map((x, j) => x + (j === 2 ? 0.05 * (i + 1) : 0));
const pool = [
  ...Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, embedding: near(A, i) })),
  ...Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, embedding: near(B, i) })),
];

test('Liked items pull the taste vector toward them and hidden items push it away', () => {
  let taste;
  for (let i = 0; i < 6; i++) taste = updateTaste(taste, A, 1);
  assert.ok(cosine(taste, A) > 0.95);
  assert.ok(cosine(taste, B) < 0.2);
  const pushed = updateTaste(taste, B, -1);
  assert.ok(cosine(pushed, B) < cosine(taste, B));
  assert.equal(taste.length, 4);
});

test('Bad input leaves the taste vector alone', () => {
  const taste = [0.1, 0.2, 0.3, 0.4];
  assert.equal(updateTaste(taste, null, 1), taste);
  assert.equal(updateTaste(taste, [1, 'x', 3, 4], 1), taste);
  assert.equal(updateTaste(taste, A, 0), taste);
  assert.equal(updateTaste(taste, A, NaN), taste);
  assert.equal(updateTaste(undefined, null, 1), undefined);
});

test('Items near what the reader likes score higher than items far from it', () => {
  let taste;
  for (let i = 0; i < 6; i++) taste = updateTaste(taste, A, 1);
  const scores = tasteScores(taste, pool);
  const mean = (prefix) => [...scores].filter(([id]) => id.startsWith(prefix)).reduce((total, [, s]) => total + s, 0) / 5;
  assert.ok(mean('a') > 0.2);
  assert.ok(mean('b') < -0.2);
  for (const value of scores.values()) assert.ok(value >= -1 && value <= 1);
});

test('Without a taste vector, matching embeddings or enough items, taste has no effect', () => {
  assert.equal(tasteScores(undefined, pool).size, 0);
  assert.equal(tasteScores([1, 0, 0, 0], pool.slice(0, 3)).size, 0);
  assert.equal(tasteScores([1, 0], pool).size, 0);
  assert.equal(tasteScores([1, 0, 0, 0], [{ id: 'x' }, ...pool.slice(0, 5)]).has('x'), false);
});

test('At most N items per channel stay up front; the rest follow in their original order', () => {
  const list = ['x', 'x', 'y', 'x', 'x', 'z', 'y'].map((channel, i) => ({ i, channel }));
  const out = capPerKey(list, (entry) => entry.channel, 2);
  assert.deepEqual(out.map((entry) => entry.i), [0, 1, 2, 5, 6, 3, 4]);
  assert.equal(out.length, list.length);
});
