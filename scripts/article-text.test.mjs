import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArticleText, fetchArticleText, isBlockedHost } from './article-text.mjs';

const para = (n) => `<p>This is paragraph ${n} of the article, with enough words to count as real article text for the summary.</p>`;
const page = (body, head = '') => `<html><head>${head}<title>x</title></head><body><nav><p>Home news sport and many other menu items here</p></nav>${body}<footer><p>Subscribe to our newsletter today for more news every morning of the week.</p></footer></body></html>`;
const html = (text, headers = {}) => new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

test('Article paragraphs are kept; menus, footers, scripts, short lines and boilerplate are dropped', () => {
  const text = extractArticleText(page(`<article><h1>Title</h1><script>var secret=1</script>${para(1)}${para(2)}${para(3)}<p>Short.</p><p>Sign up for our newsletter to get the best stories in your inbox every day.</p></article>`));
  assert.match(text, /paragraph 1/);
  assert.match(text, /paragraph 3/);
  assert.doesNotMatch(text, /secret|Home news|Short\.|newsletter/i);
});

test('HTML entities are decoded and pages without an <article> tag still work', () => {
  const text = extractArticleText(page(`<p>Prices rose 5&nbsp;% on Monday &amp; analysts said it&rsquo;s the biggest move in months, according to the report.</p>${para(2)}${para(3)}`));
  assert.match(text, /rose 5 % on Monday & analysts said it’s/);
});

test('Too little text, or a publisher opt-out, returns nothing', () => {
  assert.equal(extractArticleText(page(`<article>${para(1)}</article>`)), '');
  assert.equal(extractArticleText(page(`<article>${para(1)}${para(2)}${para(3)}</article>`, '<meta name="robots" content="noai, noarchive">')), '');
  assert.equal(extractArticleText(''), '');
});

test('Long articles are cut at a word boundary under the limit', () => {
  const text = extractArticleText(page(`<article>${Array.from({ length: 60 }, (_, n) => para(n)).join('')}</article>`), 1000);
  assert.ok(text.length <= 1001);
  assert.match(text, /…$/);
});

test('Paywalled, redirect-only and social hosts are never fetched', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return html(''); };
  for (const url of ['https://www.nytimes.com/a', 'https://news.google.com/rss/articles/x', 'https://www.youtube.com/watch?v=1', 'https://sub.ft.com/x', 'ftp://example.com/x', 'not a url']) {
    assert.equal(await fetchArticleText(url, { fetchImpl }), '');
  }
  assert.equal(called, false);
  assert.equal(isBlockedHost('www.ft.com'), true);
  assert.equal(isBlockedHost('bbc.co.uk'), false);
});

test('fetchArticleText returns article text, and swallows every kind of failure', async () => {
  const good = page(`<article>${para(1)}${para(2)}${para(3)}</article>`);
  assert.match(await fetchArticleText('https://news.example/a', { fetchImpl: async () => html(good) }), /paragraph 2/);
  assert.equal(await fetchArticleText('https://news.example/a', { fetchImpl: async () => new Response(good, { headers: { 'content-type': 'application/pdf' } }) }), '');
  assert.equal(await fetchArticleText('https://news.example/a', { fetchImpl: async () => new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } }) }), '');
  assert.equal(await fetchArticleText('https://news.example/a', { fetchImpl: async () => html(good, { 'x-robots-tag': 'noai' }) }), '');
  assert.equal(await fetchArticleText('https://news.example/a', { fetchImpl: async () => { throw new Error('network down'); } }), '');
});
