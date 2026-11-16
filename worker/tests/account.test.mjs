import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { EDITS, applyEdit } from '../../scripts/one-time-config-update.mjs';

const read = (path) => readFile(new URL('../../' + path, import.meta.url), 'utf8');
const app = await read('public/app.js');
const json = (value) => JSON.parse(JSON.stringify(value));   // values made inside the pretend browser come from another realm
const between = (from, to) => {
  const a = app.indexOf(from), b = app.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `could not find ${from} ... ${to} in public/app.js`);
  return app.slice(a, b);
};

// ---------- a saved sign-in whose user no longer exists must not trap anyone ----------
test('A dead session (user deleted, token refused) is recognised; an ordinary network or password problem is not', () => {
  const { deadSession } = vm.runInNewContext(between('const deadSession=', 'function expired()') + '; ({ deadSession })');
  const err = (message, status) => Object.assign(new Error(message), status ? { status } : {});
  assert.equal(deadSession(err('User from sub claim in JWT does not exist', 403)), true, 'the exact error you saw');
  assert.equal(deadSession(err('User from sub claim in JWT does not exist')), true, 'even without a status code');
  assert.equal(deadSession(err('invalid session', 401)), true);
  assert.equal(deadSession(err('invalid JWT: unable to parse or verify signature')), true);
  assert.equal(deadSession(err('JWT expired')), true);
  assert.equal(deadSession(err('User not found')), true);
  assert.equal(deadSession(err('Network problem - please check your connection')), false);
  assert.equal(deadSession(err('Invalid login credentials', 400)), false, 'a wrong password must not look like a dead session');
  assert.equal(deadSession(err('Something went wrong (500)', 500)), false);
  assert.equal(deadSession(null), false);
});

test('Sign out is reachable everywhere, and a dead session signs itself out and asks for a new sign-in', async () => {
  const [premium, home] = await Promise.all([read('public/premium.js'), read('public/home.js')]);
  assert.match(app, /id="so2">Sign out<\/button>/, 'home page header');
  assert.match(app, /else if\(e\.target\.id==='so2'\)out\(\)/);
  assert.match(app, /out:\(\)=>out\(\),\s*expired:\(\)=>\{drop\(\);expired\(\)\}/, 'the pricing and account pages can call these');
  assert.match(app, /if\(S\)await loadUser\(\)\.catch/, 'a saved session is checked on every page load');
  assert.match(app, /catch\(e\)\{if\(deadSession\(e\)\)\{drop\(\);expired\(\)\}throw e\}/);
  assert.match(app, /\{status:r\.status\}\)/, 'api errors carry their status code');
  assert.match(premium, /<button class="link" data-so>Sign out<\/button>/, 'pricing and account header');
  assert.match(premium, /if \(r\.status === 401\) \{ window\.BSAuth\.expired\(\)/, 'checkout with a dead session');
  assert.match(app, /\(pricing\|paused\|account\|manage\)/, 'the main router leaves the Manage account page to premium.js');
  assert.doesNotMatch(home, /Sign out/, 'the home header is drawn by app.js');
});

// ---------- Manage account: what was liked, saved or hidden, and the measured time saved ----------
const block = between('// What the Manage account page lists', 'function like(i){');
function pretendApp({ loadPool } = {}) {
  const calls = { persist: 0, loadPool: 0 };
  const ctx = vm.createContext({
    PR: { lk: [], sv: [], hid: [], seen: {} }, ITEM: {}, POOL: null,
    persist: () => { calls.persist++; },
    loadPool: async () => { calls.loadPool++; if (loadPool) await loadPool(ctx); },
  });
  vm.runInContext(block + '\nthis.api = { remember, myLists, forgetItem, tally, FIRST };', ctx);
  return { ctx, api: ctx.api, calls };
}

test('Every liked, saved or hidden story leaves a small snapshot, so it can still be named after it leaves the feed', () => {
  const { ctx, api } = pretendApp();
  api.remember({ id: 'a', t: 'Alpha', u: 'https://a.example/1', s: 'A News' });
  api.remember({ id: 'b' });   // no headline: nothing to show, so nothing is stored
  assert.deepEqual(json(ctx.PR.meta), { a: { t: 'Alpha', u: 'https://a.example/1', s: 'A News' } });
  for (let k = 0; k < 450; k++) api.remember({ id: 'x' + k, t: 'T' + k });
  assert.equal(Object.keys(ctx.PR.meta).length, 400, 'the profile never grows without limit');
  assert.ok(!('a' in ctx.PR.meta) && 'x449' in ctx.PR.meta, 'the oldest snapshots go first');
});

test('The lists come back newest first, without duplicates, named from the snapshot or from the feed, and survive a feed that cannot load', async () => {
  const { ctx, api, calls } = pretendApp({ loadPool: async (c) => { c.ITEM.a2 = { id: 'a2', t: 'Named by the feed', u: 'https://b.example/2', s: 'B News' }; c.POOL = {}; } });
  ctx.PR.lk.push('a1', 'a2'); ctx.PR.sv.push('s1'); ctx.PR.hid.push('h1', 'h1');
  ctx.PR.meta = { a1: { t: 'Alpha one', u: 'https://a.example/1', s: 'A News' }, s1: { t: 'Saved one', u: 'https://s.example', s: 'S News' } };
  const lists = json(await api.myLists());
  assert.deepEqual(lists.liked.map((r) => r.id), ['a2', 'a1'], 'newest first');
  assert.equal(lists.liked[0].t, 'Named by the feed');
  assert.equal(lists.liked[1].t, 'Alpha one');
  assert.deepEqual(lists.saved.map((r) => r.t), ['Saved one']);
  assert.deepEqual(lists.hidden, [{ id: 'h1', t: '', u: '', s: '' }], 'one entry, with no name to show');
  assert.equal(calls.loadPool, 1);
  assert.equal(ctx.PR.meta.a2.t, 'Named by the feed', 'remembered for next time');
  assert.ok(calls.persist >= 1);
  const again = await api.myLists();
  assert.equal(calls.loadPool, 1, 'the feed is only fetched while something is still unnamed and it is not loaded');
  assert.equal(again.hidden.length, 1);
  const broken = pretendApp({ loadPool: async () => { throw new Error('no access'); } });
  broken.ctx.PR.lk.push('z');
  assert.deepEqual(json((await broken.api.myLists()).liked), [{ id: 'z', t: '', u: '', s: '' }]);
  const named = pretendApp();
  named.ctx.PR.sv.push('q'); named.ctx.PR.meta = { q: { t: 'Q', u: '', s: '' } };
  await named.api.myLists();
  assert.equal(named.calls.loadPool, 0, 'nothing to look up, so the feed is not fetched');
});

test('Taking a story back removes it from that list only, and saves the change', () => {
  const { ctx, api, calls } = pretendApp();
  ctx.PR.lk.push('a', 'b'); ctx.PR.sv.push('a'); ctx.PR.hid.push('c');
  assert.equal(api.forgetItem('liked', 'a'), true);
  assert.deepEqual(json(ctx.PR.lk), ['b']);
  assert.deepEqual(json(ctx.PR.sv), ['a'], 'saved is a separate list');
  assert.equal(calls.persist, 1);
  assert.equal(api.forgetItem('hidden', 'c'), true);
  assert.deepEqual(json(ctx.PR.hid), []);
  assert.equal(api.forgetItem('liked', 'nope'), false);
  assert.equal(api.forgetItem('everything', 'a'), false);
  assert.equal(calls.persist, 2, 'nothing is saved when nothing changed');
});

test('Time saved is measured: a story counts once it was on screen for about a second, and one story never counts for more than 90 seconds', () => {
  const { ctx, api, calls } = pretendApp();
  api.tally(300);   // a flick past it
  assert.equal(ctx.PR.tm, undefined);
  api.tally(20000);
  api.tally(900);
  api.tally(600000);   // left open overnight
  assert.deepEqual(json(ctx.PR.tm), { n: 3, s: 20 + 0.9 + 90 });
  assert.equal(calls.persist, 3);
  assert.match(app, /if\(!PR\.seen\[id\]\)FIRST\.add\(id\)/, 'a story is only counted the first time it is seen');
  assert.match(app, /if\(FIRST\.delete\(id\)\)tally\(d\)/);
});

test('WATCH shows up to 200 videos, and the like, save and hide buttons keep a snapshot of the story', async () => {
  const config = await read('public/config.js');
  assert.match(app, /const cap=BS\.watchCap\|\|200,/);
  assert.match(config, /watchCap:200,/);
  assert.match(app, /PR\.lk\.push\(i\.id\);remember\(i\)/);
  assert.match(app, /PR\.sv\.push\(i\.id\);remember\(i\)/);
  assert.match(app, /PR\.hid\.push\(i\.id\);remember\(i\)/);
  assert.match(app, /lists:\(\)=>myLists\(\),\s*forget:\(kind,id\)=>forgetItem\(kind,id\),\s*stats:\(\)=>/);
});

// ---------- the one-time helper that edits config.js and wrangler.toml ----------
test('The one-time config helper makes each edit once, leaves finished edits alone, keeps Windows line endings, and says when a line was changed by hand', () => {
  const oldConfig = "{ plan:{\n    note:'Every account starts with a 7-day free trial. No card needed. Cancel any time.',\n    faq:[\n      ['Is there a free trial?','Yes. Every account starts with a 7-day free trial, and no card is needed to start it.'],\n      ['Other','Other.']\n    ] },\n  watchCap:30,  // videos in WATCH\n}";
  let text = oldConfig;
  for (const edit of EDITS.filter((e) => e.file === 'public/config.js')) {
    const result = applyEdit(text, edit);
    assert.equal(result.state, 'changed', edit.what);
    text = result.text;
  }
  assert.match(text, /note:'Start reading straight away\./);
  assert.match(text, /\['When am I charged\?'/);
  assert.match(text, /\['Other','Other\.'\]/, 'neighbouring lines are untouched');
  assert.match(text, /watchCap:200,  \/\/ videos in WATCH/);
  for (const edit of EDITS.filter((e) => e.file === 'public/config.js')) assert.equal(applyEdit(text, edit).state, 'already');
  assert.equal(applyEdit(oldConfig.replace('watchCap:30', 'watchCap:45'), EDITS.find((e) => e.what.startsWith('WATCH'))).state, 'missing', 'you changed it yourself');
  const toml = EDITS.find((e) => e.file === 'wrangler.toml');
  const windows = applyEdit('# comment\r\nname = "binglesignal"\r\nmain = "worker/src/index.js"\r\n', toml);
  assert.equal(windows.state, 'changed');
  assert.equal(windows.text, '# comment\r\nname = "binglesignalv1"\r\nmain = "worker/src/index.js"\r\n');
  assert.equal(applyEdit(windows.text, toml).state, 'already');
  assert.equal(applyEdit('name = "something-else"\n', toml).state, 'missing');
});

test('config.js and wrangler.toml in this project already have every one-time edit (if this fails, run: node scripts/one-time-config-update.mjs)', async () => {
  const files = { 'public/config.js': await read('public/config.js'), 'wrangler.toml': await read('wrangler.toml') };
  for (const edit of EDITS) assert.equal(applyEdit(files[edit.file], edit).state, 'already', `${edit.file}: ${edit.what}`);
});
