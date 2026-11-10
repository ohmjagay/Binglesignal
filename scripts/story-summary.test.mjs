import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeStory } from './story-summary.mjs';
import { DeepSeekError } from '../worker/src/deepseek.js';

const source = { id: 'story-1', t: 'Headline', s: 'Publisher', x: 'Excerpt' };
const env = { DEEPSEEK_API_KEY: 'test-secret' };
const valid = {
  headline: 'Headline', summary: 'A short summary.', why_it_matters: 'A short impact.',
  category: 'technology', entities: ['Example'], confidence: 0.9, source_ids: ['story-1'],
};
const answer = (content, usage = { prompt_tokens: 120, completion_tokens: 40 }) =>
  Response.json({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }], usage });

async function withFetch(handler, run) {
  const previous = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const request = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    requests.push(request);
    return handler(request, requests.length);
  };
  try { return await run(requests); } finally { globalThis.fetch = previous; }
}

test('Summaries go to DeepSeek with thinking off and JSON output, and the answer is validated', async () => {
  await withFetch(() => answer(valid), async (requests) => {
    const result = await summarizeStory([source], env);
    const [request] = requests;
    assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer test-secret');
    assert.equal(request.body.model, 'deepseek-flash');
    assert.deepEqual(request.body.thinking, { type: 'disabled' });
    assert.equal(request.body.response_format.type, 'json_object');
    assert.equal(request.body.messages[0].role, 'system');
    assert.match(request.body.messages[0].content, /JSON/);
    assert.match(request.body.messages[0].content, /1-2 plain sentences/); // headline + excerpt only
    assert.equal(result.headline, 'Headline');
    assert.deepEqual(result.source_ids, ['story-1']);
    assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 40 });
  });
});

test('The model name and base URL come from settings, so a DeepSeek rename needs no code change', async () => {
  await withFetch(() => answer(valid), async (requests) => {
    await summarizeStory([source], { ...env, DEEPSEEK_MODEL: 'deepseek-v4-pro', DEEPSEEK_BASE_URL: 'https://api.deepseek.com/' });
    assert.equal(requests[0].body.model, 'deepseek-v4-pro');
    assert.equal(requests[0].url, 'https://api.deepseek.com/chat/completions');
  });
});

test('Stories with article text get the longer 3-4 sentence summary prompt and the text is sent', async () => {
  await withFetch(() => answer({ ...valid, summary: 'One. Two. Three. Four sentences about the story.' }), async (requests) => {
    const result = await summarizeStory([{ ...source, body: 'The full article text '.repeat(40) }, { id: 'story-2', t: 'Other', s: 'B', x: '' }], env);
    assert.match(requests[0].body.messages[0].content, /3-4 plain sentences/);
    const sent = JSON.parse(requests[0].body.messages[1].content);
    assert.match(sent[0].text, /full article text/);
    assert.equal(sent[1].text, undefined);
    assert.match(result.summary, /Four sentences/);
  });
});

test('Article text is capped so one request stays cheap', async () => {
  await withFetch(() => answer(valid), async (requests) => {
    const big = 'word '.repeat(5000);
    await summarizeStory([{ ...source, body: big }, { id: 's2', t: 'T2', s: 'B', x: '', body: big }, { id: 's3', t: 'T3', s: 'C', x: '', body: big }], env);
    const sent = JSON.parse(requests[0].body.messages[1].content);
    assert.ok(sent.reduce((total, item) => total + (item.text || '').length, 0) <= 9000);
  });
});

test('Videos get a "Watch if" note from the title and description, with confidence capped (there is no transcript)', async () => {
  await withFetch(() => answer({ ...valid, why_it_matters: 'Watch if you follow AI.', confidence: 0.95 }), async (requests) => {
    const video = { id: 'vid-1', t: 'How AI chips work', s: 'Channel', x: 'A walkthrough of GPUs.', v: 1, vid: 'abc' };
    const result = await summarizeStory([video], env);
    assert.match(requests[0].body.messages[0].content, /watch notes/);
    assert.match(requests[0].body.messages[0].content, /never the transcript/);
    assert.equal(result.confidence, 0.7);
    assert.match(result.why_it_matters, /^Watch if/);
  });
});

test('Bad output is asked for once more, then rejected; the retry says what was wrong', async () => {
  await withFetch((_request, n) => answer(n === 1 ? { headline: 'only a headline' } : valid), async (requests) => {
    const result = await summarizeStory([source], env);
    assert.equal(requests.length, 2);
    assert.match(requests[1].body.messages[0].content, /previous answer failed validation/);
    assert.equal(result.summary, 'A short summary.');
    assert.equal(result.usage.inputTokens, 240);
  });
  await withFetch(() => answer({ headline: 'nope' }), async () => {
    await assert.rejects(summarizeStory([source], env), /failed schema validation/);
  });
});

test('Slightly long text is trimmed, unknown source ids are dropped, odd categories become "news", URLs are stripped', async () => {
  await withFetch(() => answer({
    ...valid, headline: `${'H'.repeat(120)} https://x.example`, summary: `${'word '.repeat(70)}https://bad.example`,
    category: 'Tech!!', source_ids: ['unknown', 'story-1'], entities: ['A', 5, 'B'],
  }), async () => {
    const result = await summarizeStory([source], env);
    assert.ok(result.headline.length <= 90);
    assert.ok(result.summary.split(/\s+/).length <= 61);
    assert.doesNotMatch(result.summary, /https?:/);
    assert.equal(result.category, 'news');
    assert.deepEqual(result.source_ids, ['story-1']);
    assert.deepEqual(result.entities, ['A', 'B']);
  });
});

test('A rejected key or an empty balance is a fatal error with a clear message and never leaks the key', async () => {
  for (const [status, pattern] of [[401, /rejected the API key \(401\)/], [402, /balance is empty \(402\)/]]) {
    await withFetch(() => Response.json({ error: { message: 'details test-secret' } }, { status }), async (requests) => {
      await assert.rejects(summarizeStory([source], env), (error) => {
        assert.ok(error instanceof DeepSeekError);
        assert.equal(error.fatal, true);
        assert.match(error.message, pattern);
        assert.doesNotMatch(error.message, /test-secret/);
        return true;
      });
      assert.equal(requests.length, 1);
    });
  }
});

test('A busy server (429/503) is retried; a wrong model name is a normal, non-fatal error', async () => {
  const previous = globalThis.fetch;
  try {
    await withFetch((_request, n) => (n < 3 ? new Response('busy', { status: 503 }) : answer(valid)), async (requests) => {
      await summarizeStory([source], env, { retryDelayMs: 1 });
      assert.equal(requests.length, 3);
    });
    await withFetch(() => Response.json({ error: { message: 'model not found' } }, { status: 400 }), async () => {
      await assert.rejects(summarizeStory([source], env), (error) => {
        assert.equal(error.fatal, false);
        assert.match(error.message, /update DEEPSEEK_MODEL/);
        return true;
      });
    });
  } finally { globalThis.fetch = previous; }
});

test('A cut-off answer or an empty answer is an error, not a blank summary', async () => {
  await withFetch(() => Response.json({ choices: [{ message: { content: '{"headline":"x' }, finish_reason: 'length' }] }), async () => {
    await assert.rejects(summarizeStory([source], env, { retries: 0 }), /cut off/);
  });
  await withFetch(() => Response.json({ choices: [{ message: { content: '   ' }, finish_reason: 'stop' }] }), async () => {
    await assert.rejects(summarizeStory([source], env, { retries: 0 }), /empty answer/);
  });
});

test('Invalid settings fail before any request is sent', async () => {
  await withFetch(() => { throw new Error('no request expected'); }, async () => {
    await assert.rejects(summarizeStory([source], {}), /DEEPSEEK_API_KEY is not configured/);
    await assert.rejects(summarizeStory([source], { ...env, DEEPSEEK_BASE_URL: 'http://api.deepseek.com' }), /public HTTPS URL/);
    await assert.rejects(summarizeStory([source], { ...env, DEEPSEEK_BASE_URL: 'https://localhost/v1' }), /public HTTPS URL/);
    await assert.rejects(summarizeStory([source], { ...env, DEEPSEEK_BASE_URL: 'not a url' }), /valid HTTPS URL/);
  });
  assert.equal(await summarizeStory([], env), null);
});
