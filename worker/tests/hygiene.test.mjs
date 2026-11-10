import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
async function files(dir) {
  const out = [];
  for (const entry of await readdir(new URL(dir, root), { withFileTypes: true })) {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) out.push(...await files(`${path}/`));
    else out.push(path);
  }
  return out;
}

test('The public teaser file is valid JSON (no Git merge-conflict markers) and small enough to be a teaser', async () => {
  const raw = await read('public/feed.json');
  assert.doesNotMatch(raw, /^(<<<<<<<|=======|>>>>>>>)/m);
  const feed = JSON.parse(raw);
  assert.ok(Array.isArray(feed.items) && feed.items.length > 0 && feed.items.length <= 60);
  for (const item of feed.items) assert.ok(item.t && /^https?:\/\//.test(item.u) && item.c && Array.isArray(item.k));
});

test('DeepSeek is the only AI provider: no Anthropic or OpenAI calls, keys or old settings remain in code or config', async () => {
  const banned = /api\.anthropic\.com|api\.openai\.com|ANTHROPIC_API_KEY|OPENAI_API_KEY|EMAIL_AI_(PROVIDER|ENDPOINT|API_KEY|MODEL)/;
  const targets = [
    ...(await files('worker/src/')), ...(await files('scripts/')).filter((path) => !path.endsWith('.test.mjs')),
    ...(await files('public/')).filter((path) => /\.(js|html)$/.test(path)), ...(await files('.github/workflows/')),
    'wrangler.toml', '.dev.vars.example',
  ];
  for (const path of targets) assert.doesNotMatch(await read(path), banned, path);
});

test('The Refresh briefing workflow passes the DeepSeek settings to the ingest script', async () => {
  const workflow = await read('.github/workflows/refresh-briefing.yml');
  assert.match(workflow, /DEEPSEEK_API_KEY: \$\{\{ secrets\.DEEPSEEK_API_KEY \}\}/);
  assert.match(workflow, /DEEPSEEK_MODEL: \$\{\{ secrets\.DEEPSEEK_MODEL \}\}/);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN/); // embeddings stay on Cloudflare Workers AI
});

test('The email beta is paused: tab hidden, and the server-side switch turns every email job and route off', async () => {
  const context = { window: {} };
  runInNewContext(await read('public/config.js'), context);
  assert.equal(context.window.BS.emailBeta, false);
  assert.match(await read('public/app.js'), /BS\.emailBeta/);
  assert.match(await read('worker/src/email-beta.js'), /EMAIL_BETA_ENABLED !== 'true'/);
  assert.match(await read('.dev.vars.example'), /^EMAIL_BETA_ENABLED=false/m);
  assert.match(await read('wrangler.toml'), /\*\/15 \* \* \* \*/); // the edition and lifecycle cron must stay
});

test('The pricing page sells one Razorpay plan and has no yearly or Pro cards', async () => {
  const premium = await read('public/premium.js');
  assert.match(premium, /BingleSignal Briefing/);
  assert.match(premium, /razorpay_inr/);
  assert.doesNotMatch(premium, /data-plan="pro"|Yearly|Choose Pro|Choose Lite/);
});
