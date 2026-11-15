import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker, { cleanSummary, addTeaserSummaries } from '../src/index.js';
import { peekData, peekWidth, placePeek, install, DWELL_MS, SWITCH_MS, HIDE_MS } from '../../public/peek.js';

const read = (path) => readFile(new URL('../../' + path, import.meta.url), 'utf8');
const SUMMARY = 'Kenya has discharged its last Ebola patient after weeks of treatment. Health officials say no new cases have been found and monitoring continues.';

// ---------- the Worker: the public teaser carries a short AI summary ----------
test('Summaries are plain text, capped, cut at the end of a sentence, and empty when there is too little to show', () => {
  assert.equal(cleanSummary(''), '');
  assert.equal(cleanSummary('Too short.'), '');
  assert.equal(cleanSummary('  <b>Kenya</b> has   discharged its last patient. See https://example.com/x for more details now.  '),
    'Kenya has discharged its last patient. See for more details now.');
  const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} says something useful.`).join(' ');
  const cut = cleanSummary(long, 200);
  assert.ok(cut.length <= 200 && cut.endsWith('.'), 'ends on a full sentence');
  assert.ok(cleanSummary('word '.repeat(200), 100).endsWith('…'), 'with no sentence end, cut at a word');
});

test('Each teaser headline gets its summary as y, and only when there is one', () => {
  const items = [{ c: 'a', t: 'A' }, { c: 'b', t: 'B' }, { c: 'c', t: 'C' }];
  const out = addTeaserSummaries(items, [{ story_id: 'a', summary: SUMMARY }, { story_id: 'b', summary: '' }, { story_id: 'zzz', summary: SUMMARY }]);
  assert.equal(out[0].y, SUMMARY);
  assert.deepEqual(out[1], { c: 'b', t: 'B' });
  assert.deepEqual(out[2], { c: 'c', t: 'C' });
  assert.deepEqual(addTeaserSummaries(items, null), items);
});

const env = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' };
const cluster = (id, q) => ({ story_id: id, source_count: 3, stories: [{ id: `${id}-a`, t: `Headline ${id}`, u: `https://news.example/${id}`, s: 'Example News', d: 1793000000, k: ['business'], q, g: ['IN'] }] });

test('GET /api/teaser adds the AI summary to each headline, and still serves headlines when the summaries cannot be read', async () => {
  const calls = [];
  const fake = (notesReply) => { globalThis.fetch = async (url) => {
    url = String(url); calls.push(url);
    if (url.includes('story_clusters')) return Response.json([cluster('a', 0.7), cluster('b', 0.4)]);
    if (url.includes('story_notes')) return notesReply();
    return new Response('[]');
  }; };
  fake(() => Response.json([{ story_id: 'a', summary: SUMMARY }]));
  let body = await (await worker.fetch(new Request('https://binglesignal.com/api/teaser'), env)).json();
  assert.equal(body.items[0].y, SUMMARY);
  assert.equal('y' in body.items[1], false, 'no summary yet means no y, not an empty one');
  assert.ok(calls.some((url) => url.includes('story_notes') && url.includes('story_id=in.(a,b)')), 'one lookup for exactly the headlines being served');
  fake(() => new Response('boom', { status: 500 }));
  const res = await worker.fetch(new Request('https://binglesignal.com/api/teaser'), env);
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.items.length, 2);
  assert.equal('y' in body.items[0], false);
});

// ---------- the browser: where the box goes ----------
test('The hover box is wider than the box it grows out of, centred on it, and always fully on screen', () => {
  const view = { w: 1280, h: 800 };
  assert.equal(peekWidth({ width: 270 }, view), 360);
  assert.equal(peekWidth({ width: 900 }, view), 440);
  assert.equal(peekWidth({ width: 270 }, { w: 300, h: 600 }), 276, 'never wider than a narrow screen');
  assert.deepEqual(placePeek({ left: 500, top: 300, width: 280, height: 120 }, { w: 360, h: 220 }, view), { left: 460, top: 290 });
  assert.equal(placePeek({ left: 0, top: 300, width: 280, height: 120 }, { w: 360, h: 220 }, view).left, 12, 'kept off the left edge');
  assert.equal(placePeek({ left: 1200, top: 300, width: 280, height: 120 }, { w: 360, h: 220 }, view).left, 908, 'kept off the right edge');
  assert.equal(placePeek({ left: 500, top: 700, width: 280, height: 120 }, { w: 360, h: 220 }, view).top, 568, 'moved up when it would run off the bottom');
  assert.equal(placePeek({ left: 500, top: 0, width: 280, height: 120 }, { w: 360, h: 220 }, view).top, 12, 'kept off the top edge');
});

test('A box needs a headline and a summary, and only web links count as the source', () => {
  assert.equal(peekData({ dataset: { pkT: 'Headline', pkY: '' } }), null);
  assert.equal(peekData({ dataset: { pkY: 'Summary' } }), null);
  assert.equal(peekData(null), null);
  assert.deepEqual(peekData({ dataset: { pkT: ' Headline ', pkY: ' Summary ', pkS: 'DW', pkU: 'https://dw.example/a' } }), { t: 'Headline', y: 'Summary', s: 'DW', u: 'https://dw.example/a' });
  assert.equal(peekData({ dataset: { pkT: 'H', pkY: 'S', pkU: 'javascript:alert(1)' } }).u, '');
});

// ---------- the browser: when the box opens and closes (a tiny pretend page) ----------
function fakeBrowser({ hover = true } = {}) {
  const handlers = {};
  const parts = { h4: { textContent: '' }, '.y': { textContent: '' }, small: { textContent: '' } };
  const classes = new Set();
  const box = { hidden: true, style: {}, attrs: {}, offsetHeight: 200, set innerHTML(html) { box.html = html; }, setAttribute(k, v) { box.attrs[k] = v; },
    querySelector: (selector) => parts[selector], classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } };
  const doc = { createElement: () => box, body: { appendChild() {} }, addEventListener: (type, fn) => { handlers[type] = fn; },
    documentElement: { addEventListener: (type, fn) => { handlers['root:' + type] = fn; } } };
  const win = { innerWidth: 1280, innerHeight: 800, matchMedia: () => ({ matches: hover }), requestAnimationFrame: (fn) => fn(),
    addEventListener: (type, fn) => { handlers['win:' + type] = fn; } };
  install(doc, win);
  return { handlers, box, parts, classes };
}
const headline = (data = { pkT: 'Kenya\'s last Ebola patient leaves hospital', pkY: SUMMARY, pkS: 'DW', pkU: 'https://dw.example/a' }, top = 300) => ({
  dataset: data, isConnected: true, attrs: {}, getBoundingClientRect: () => ({ left: 500, top, width: 280, height: 120 }),
  setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
  closest(selector) { return selector === '[data-pk-y]' && this.dataset.pkY ? this : null; },
});
const elsewhere = { closest: () => null };

test('Resting the pointer on a headline opens a bigger box with its summary; leaving closes it', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const page = fakeBrowser(), el = headline();
    page.handlers.mouseover({ target: el });
    mock.timers.tick(DWELL_MS - 1);
    assert.equal(page.box.hidden, true, 'moving across the page does not flash boxes');
    mock.timers.tick(1);
    assert.equal(page.box.hidden, false);
    assert.equal(page.parts.h4.textContent, "Kenya's last Ebola patient leaves hospital");
    assert.equal(page.parts['.y'].textContent, SUMMARY);
    assert.match(page.parts.small.textContent, /AI summary\. Click to read the full story at DW\./);
    assert.equal(page.box.style.left, '460px');
    assert.equal(page.box.style.top, '290px');
    assert.equal(page.box.style.width, '360px');
    assert.equal(page.box.style.minHeight, '140px', 'tall enough to cover the box it grows out of');
    assert.ok(page.classes.has('on'));
    assert.equal(el.attrs['aria-describedby'], 'pk');
    page.handlers.mouseover({ target: elsewhere });
    mock.timers.tick(HIDE_MS - 1);
    assert.equal(page.box.hidden, false, 'a short grace period so crossing a gap does not flicker');
    mock.timers.tick(1);
    assert.equal(page.box.hidden, true);
    assert.equal('aria-describedby' in el.attrs, false);
  } finally { mock.timers.reset(); }
});

test('Moving from one headline straight to the next switches quickly; Escape, scrolling and clicking close the box', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const page = fakeBrowser(), one = headline(), two = headline({ pkT: 'Second headline', pkY: 'Second summary text that is long enough to show.', pkS: 'BBC', pkU: 'https://bbc.example/b' });
    page.handlers.mouseover({ target: one }); mock.timers.tick(DWELL_MS);
    page.handlers.mouseover({ target: two }); mock.timers.tick(SWITCH_MS);
    assert.equal(page.parts.h4.textContent, 'Second headline');
    assert.equal('aria-describedby' in one.attrs, false);
    for (const close of [() => page.handlers.keydown({ key: 'Escape' }), () => page.handlers['win:scroll'](), () => page.handlers.click()]) {
      page.handlers.mouseover({ target: one }); mock.timers.tick(DWELL_MS + SWITCH_MS);
      assert.equal(page.box.hidden, false);
      close();
      assert.equal(page.box.hidden, true);
    }
    page.handlers.keydown({ key: 'a' });
  } finally { mock.timers.reset(); }
});

test('Keyboard focus opens the same box at once; a headline with no summary, or a touch screen, gets nothing', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const page = fakeBrowser(), el = headline();
    page.handlers.focusin({ target: el });
    assert.equal(page.box.hidden, false, 'no waiting for a keyboard user');
    page.handlers.focusout();
    mock.timers.tick(HIDE_MS);
    assert.equal(page.box.hidden, true);
    page.handlers.focusin({ target: headline({ pkT: 'No summary yet', pkY: '' }) });
    page.handlers.mouseover({ target: headline({ pkT: 'No summary yet' }) });
    mock.timers.tick(DWELL_MS * 2);
    assert.equal(page.box.hidden, true);
    const touch = fakeBrowser({ hover: false });
    touch.handlers.mouseover({ target: headline() });
    mock.timers.tick(DWELL_MS * 2);
    assert.equal(touch.box.hidden, true, 'a phone tap goes straight to the article, as before');
  } finally { mock.timers.reset(); }
});

// ---------- the site files are wired up ----------
test('The homepage boxes and the Read headlines are wired to the hover box, which never takes the pointer', async () => {
  const [home, app, css, peek] = await Promise.all([read('public/home.js'), read('public/app.js'), read('public/style.css'), read('public/peek.js')]);
  assert.match(home, /import '\.\/peek\.js'/);
  assert.match(home, /class="tile" \$\{lnk\(e\.a\)\}\$\{pk\(e\.a\)\}/, 'homepage tiles');
  assert.match(home, /class="row" \$\{lnk\(a\)\}\$\{pk\(a\)\}/, 'homepage list rows');
  assert.match(home, /pk=a=>a\.y\?/, 'only when the teaser has a summary');
  assert.match(app, /data-a="open"\$\{pkR\(i\)\}>\$\{esc\(i\.t\)\}<\/a>/, 'Read headline link');
  assert.match(app, /const pkR=i=>i\.summary\?/, 'only when the story has a summary');
  assert.match(css, /\.pk\{[^}]*pointer-events:none/);
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.pk\{transition:none/);
  assert.doesNotMatch(peek, /innerHTML\s*=\s*[^'"\s]/, 'only fixed markup is ever assigned as HTML; story text goes in as plain text');
  assert.match(peek, /textContent = d\.t/);
});
