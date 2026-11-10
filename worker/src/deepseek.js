// DeepSeek client shared by the Worker (email summarizer) and the GitHub Actions scripts (story notes).
// DeepSeek speaks the OpenAI chat-completions format, so this is plain fetch: no SDK, no dependency.
// Docs: https://api-docs.deepseek.com  Model names change over time: set DEEPSEEK_MODEL, no code change needed.
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash';
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export class DeepSeekError extends Error {
  constructor(message, status = 0, flags = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status;
    this.fatal = !!flags.fatal;         // true = stop calling DeepSeek for this run (bad key, empty balance)
    this.retryable = !!flags.retryable; // true = worth trying again (busy server, timeout)
  }
}

function privateHost(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.local') || /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(hostname);
}

export function deepseekConfig(env = {}) {
  const apiKey = String(env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) throw new DeepSeekError('DEEPSEEK_API_KEY is not configured', 0, { fatal: true });
  const base = String(env.DEEPSEEK_BASE_URL || DEEPSEEK_BASE_URL).trim().replace(/\/+$/, '');
  let url;
  try { url = new URL(base); } catch { throw new DeepSeekError('DEEPSEEK_BASE_URL must be a valid HTTPS URL', 0, { fatal: true }); }
  if (url.protocol !== 'https:' || url.username || url.password || privateHost(url.hostname)) {
    throw new DeepSeekError('DEEPSEEK_BASE_URL must be a public HTTPS URL', 0, { fatal: true });
  }
  return {
    apiKey,
    endpoint: `${base}/chat/completions`,
    model: String(env.DEEPSEEK_MODEL || '').trim() || DEEPSEEK_DEFAULT_MODEL,
  };
}

// Provider messages are shown in logs, so the key is always removed first.
function safeMessage(body, apiKey) {
  try {
    const payload = JSON.parse(body);
    const message = payload?.error?.message || payload?.message;
    return typeof message === 'string'
      ? message.split(apiKey).join('[redacted]').replace(/[\r\n\t]+/g, ' ').slice(0, 300)
      : '';
  } catch { return ''; }
}

function httpError(status, detail) {
  const suffix = detail ? `: ${detail}` : '';
  if (status === 401) return new DeepSeekError(`DeepSeek rejected the API key (401). Check DEEPSEEK_API_KEY${suffix}`, 401, { fatal: true });
  if (status === 402) return new DeepSeekError('DeepSeek balance is empty (402). Top up at platform.deepseek.com', 402, { fatal: true });
  if (RETRY_STATUS.has(status)) return new DeepSeekError(`DeepSeek is busy or unavailable (${status})${suffix}`, status, { retryable: true });
  if ([400, 404, 422].includes(status)) {
    return new DeepSeekError(`DeepSeek rejected the request (${status}). If this mentions the model, update DEEPSEEK_MODEL${suffix}`, status);
  }
  return new DeepSeekError(`DeepSeek request failed (${status})${suffix}`, status);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One chat completion. Thinking mode is switched OFF on purpose: DeepSeek V4 turns it on by default, which makes
// short JSON jobs slower, dearer and (with a small max_tokens) empty. Summaries do not need it.
export async function deepseekChat(env, {
  system, user, maxTokens = 800, temperature = 0.2, json = true,
  timeoutMs = 45_000, retries = 2, retryDelayMs = 800, fetchImpl,
} = {}) {
  const config = deepseekConfig(env);
  const doFetch = fetchImpl || globalThis.fetch;
  const body = JSON.stringify({
    model: config.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: maxTokens,
    temperature,
    thinking: { type: 'disabled' },
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  });
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await doFetch(config.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body,
      });
      if (!response.ok) throw httpError(response.status, safeMessage(await response.text().catch(() => ''), config.apiKey));
      const result = await response.json();
      const choice = result?.choices?.[0];
      const content = choice?.message?.content;
      if (choice?.finish_reason === 'length') throw new DeepSeekError('DeepSeek output was cut off (max_tokens reached)', 200);
      if (typeof content !== 'string' || !content.trim()) throw new DeepSeekError('DeepSeek returned an empty answer', 200, { retryable: true });
      return {
        content,
        usage: {
          inputTokens: result.usage?.prompt_tokens || 0,
          outputTokens: result.usage?.completion_tokens || 0,
          cacheHitTokens: result.usage?.prompt_cache_hit_tokens || 0,
        },
        model: result.model || config.model,
      };
    } catch (error) {
      last = error instanceof DeepSeekError ? error
        : new DeepSeekError(`DeepSeek request failed: ${error?.name === 'TimeoutError' ? 'timed out' : 'network error'}`, 0, { retryable: true });
      if (last.fatal || !last.retryable || attempt === retries) throw last;
      await sleep(retryDelayMs * (attempt + 1));
    }
  }
  throw last;
}

// Same call, but the answer must be a JSON object.
export async function deepseekJson(env, options) {
  const result = await deepseekChat(env, { ...options, json: true });
  let data;
  try { data = JSON.parse(result.content); } catch { throw new DeepSeekError('DeepSeek answer was not valid JSON', 200, { retryable: true }); }
  return { data, usage: result.usage, model: result.model };
}
