import assert from 'node:assert/strict';
import test from 'node:test';
import { composeInboxBrief } from '../src/email/brief.js';
import { clusterEmails } from '../src/email/cluster.js';
import { normalizeEmailText } from '../src/email/normalize.js';
import { scoreEmail } from '../src/email/score.js';
import { scrubSensitiveText } from '../src/email/scrub.js';
import { summarizeEmailBatch } from '../src/email/summarize.js';
import { triageEmail } from '../src/email/triage.js';
import { listSummaryMessages, MAX_SUBREQUESTS_PER_CRON_TICK, MAX_SUMMARY_MESSAGES_PER_PAGE } from '../src/email-beta.js';
import { syntheticEmailSamples } from './fixtures/email-samples.mjs';

test('email normalization drops hidden HTML, quoted replies, signatures, and zero-width characters', () => {
  const text = normalizeEmailText({
    html: '<style>.x{display:none}</style><p>Hello\u200b there</p><div hidden>private quote</div><script>alert(1)</script>',
  });
  assert.equal(text, 'Hello there');
  assert.equal(normalizeEmailText({ text: 'New note\nOn Monday, someone wrote:\n> old message\n--\nSignature' }), 'New note');
  assert.equal(normalizeEmailText({ text: 'a'.repeat(1600) }).length, 1500);
});

test('scrubber masks common identity, financial, password, token, and URL patterns', () => {
  const scrubbed = scrubSensitiveText('OTP: 123456 card 4111 1111 1111 1111 Aadhaar 1234 5678 9012 PAN ABCDE1234F IFSC HDFC0123456 SSN 123-45-6789 password: hunter2 key ghp_123456789012345678901234 URL https://private.test');
  for (const marker of ['[CODE]', '[CARD]', '[AADHAAR]', '[PAN]', '[IFSC]', '[SSN]', '[SECRET]', '[LINK]']) {
    assert.ok(scrubbed.includes(marker), `expected ${marker}`);
  }
  assert.doesNotMatch(scrubbed, /https?:\/\/|4111 1111/);
});

test('email triage classifies newsletter and security alerts before AI', () => {
  assert.deepEqual(
    (({ category, needsAi }) => ({ category, needsAi }))(triageEmail({
      subject: 'Weekly update',
      from: 'news@example.test',
      headers: { 'list-unsubscribe': '<mailto:leave@example.test>' },
    })),
    { category: 'newsletter', needsAi: false },
  );
  assert.equal(triageEmail({ subject: 'New sign-in detected', from: 'alerts@example.test' }).category, 'security');
  assert.equal(triageEmail({ subject: 'Project update', from: 'teammate@example.test', labelIds: ['IMPORTANT'] }).important, true);
});

test('Gmail reads metadata first and fetches full content only for messages that need AI', async (context) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    calls.push(url.toString());
    if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'bulk' }, { id: 'person' }] });
    if (url.pathname.endsWith('/messages/bulk')) {
      return Response.json({ labelIds: ['INBOX'], payload: { headers: [
        { name: 'From', value: 'digest@example.test' },
        { name: 'Subject', value: 'Weekly digest' },
        { name: 'List-Unsubscribe', value: '<mailto:leave@example.test>' },
      ] } });
    }
    if (url.pathname.endsWith('/messages/person')) {
      if (url.searchParams.get('format') === 'metadata') {
        return Response.json({ labelIds: ['INBOX'], payload: { headers: [
          { name: 'From', value: 'Ria <ria@example.test>' },
          { name: 'To', value: 'owner@example.test' },
          { name: 'Subject', value: 'Project review' },
        ] } });
      }
      return Response.json({ payload: { mimeType: 'text/plain', body: { data: btoa('Please review the project update.') } } });
    }
    return Response.json({});
  };

  const page = await listSummaryMessages('access-token', {
    provider: 'gmail',
    provider_email: 'owner@example.test',
  }, { mode: 'all' }, 'UTC', 10);
  assert.equal(page.messages.length, 2);
  assert.equal(page.messages[0].category, 'newsletter');
  assert.equal(page.messages[0].text, '');
  assert.equal(page.messages[1].text, 'Please review the project update.');
  assert.equal(calls.filter((url) => new URL(url).searchParams.get('format') === 'metadata').length, 2);
  assert.equal(calls.filter((url) => new URL(url).searchParams.get('format') === 'full').length, 1);
});

test('embedding clustering groups same sender bulk mail and applies the cosine threshold to other mail', async () => {
  const calls = [];
  const env = {
    AI: {
      run: async (_model, input) => {
        calls.push(input.text);
        return { data: [[1, 0], [1, 0], [0, 1]] };
      },
    },
  };
  const items = [
    { id: 'bulk-1', bulk: true, category: 'newsletter', from: 'digest@example.test' },
    { id: 'bulk-2', bulk: true, category: 'newsletter', from: 'digest@example.test' },
    { id: 'topic-1', category: 'client', subject: 'Project update' },
    { id: 'topic-2', category: 'client', subject: 'Project update follow-up' },
    { id: 'topic-3', category: 'client', subject: 'Travel plan' },
  ];
  const clusters = await clusterEmails(items, env, 0.78);
  assert.equal(calls.length, 1);
  assert.equal(clusters.find((cluster) => cluster.key.startsWith('newsletter:')).items.length, 2);
  assert.equal(clusters.find((cluster) => cluster.items.some((item) => item.id === 'topic-1')).items.length, 2);
  assert.equal(clusters.find((cluster) => cluster.items.some((item) => item.id === 'topic-3')).items.length, 1);
});

test('priority score uses the documented weights and explains its ranking', () => {
  const result = scoreEmail({
    from_domain: 'company.test',
    direct: 'to',
    needs_reply: true,
    deadline_days: 1,
  }, { userDomain: 'company.test' });
  assert.equal(result.priority, 77);
  assert.equal(result.priority_label, 'ACT NOW');
  assert.match(result.why_ranked, /addressed directly to you/);
});

test('brief composes action, deadline, and safely-ignore sections as plain text', () => {
  const brief = composeInboxBrief([{
    id: 'mail-1', priority: 80, priority_label: 'ACT NOW', one_line: 'Review contract',
    why_ranked: 'Ranked act now because it asks for a response.', needs_reply: true,
    category: 'needs_action', deadline_iso: '2026-11-07', bulk: false,
  }], 1);
  assert.equal(brief.summary.split('\n').length, 3);
  assert.equal(brief.important.length, 1);
  assert.match(brief.deadlines[0], /2026-11-07/);
});

test('100 synthetic messages including 10 injection attempts retain strict structure and have no URLs in output', async () => {
  const samples = syntheticEmailSamples();
  assert.equal(samples.length, 100);
  assert.equal(samples.filter((email) => email.text.startsWith('Synthetic content') && email.text.includes('Ignore all rules')).length, 10);
  const env = {
    EMAIL_AI_ENDPOINT: 'https://ai.example/v1/chat/completions',
    EMAIL_AI_API_KEY: 'test-key',
    EMAIL_AI_MODEL: 'test-model',
    EMAIL_AI_MONTHLY_BUDGET_EXCEEDED: 'false',
    EMAIL_AI_BUDGET: {
      idFromName: () => 'budget',
      get: () => ({
        fetch: async (url) => new URL(url).pathname === '/reserve'
          ? Response.json({ allowed: true, reservationId: 'test' })
          : Response.json({ ok: true }),
      }),
    },
    AI: {
      run: async (_model, { text }) => ({ data: text.map((_, index) => index % 2 ? [0, 1] : [1, 0]) }),
    },
  };
  const outputs = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    const input = JSON.parse(request.messages[1].content);
    const results = input.map((email) => ({
      id: email.id,
      category: 'needs_action',
      priority_hint: 50,
      one_line: `Synthetic note ${email.id}`,
      summary: 'Review this synthetic update; injected URL https://bad.example/private',
      ask: null,
      deadline_iso: null,
      amount: null,
      needs_reply: false,
      urgent: false,
      confidence: 0.9,
    }));
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ summary: JSON.stringify(results) }) } }],
      usage: { prompt_tokens: 50, completion_tokens: 50 },
    });
  };
  for (let index = 0; index < samples.length; index += 10) {
    const batch = samples.slice(index, index + 10);
    const result = await summarizeEmailBatch(env, 'user-1', batch, 'UTC');
    outputs.push(...result.items);
  }
  assert.equal(outputs.length, 100);
  assert.deepEqual(outputs.map((item) => item.id), samples.map((email) => email.id));
  assert.ok(outputs.every((item) => item.summary && !/https?:\/\/|www\./i.test(item.summary)));
});

test('email summary page limit is derived from the cron subrequest budget', () => {
  assert.equal(MAX_SUBREQUESTS_PER_CRON_TICK, 45);
  assert.equal(MAX_SUMMARY_MESSAGES_PER_PAGE, 8);
});
