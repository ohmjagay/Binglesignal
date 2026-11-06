function decodeEntities(value) {
  return value
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function stripHtml(value) {
  return decodeEntities(value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|svg|iframe|object|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+\b(hidden|aria-hidden)\b[^>]*>[\s\S]*?<\/[^>]+>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
}

function removeQuotedHistory(value) {
  const cutAt = [
    /^\s*>/m,
    /^On .{1,160}wrote:\s*$/im,
    /^[- ]{2,}Original Message[- ]{2,}\s*$/im,
    /^From:\s.+\r?\n(?:Sent|Date):/im,
  ].map((pattern) => value.search(pattern)).filter((index) => index >= 0);
  return cutAt.length ? value.slice(0, Math.min(...cutAt)) : value;
}

export function normalizeEmailText({ text = '', html = '' } = {}, maxLength = 1500) {
  const source = String(text).trim() ? String(text) : stripHtml(String(html));
  const visible = source
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n');
  const withoutHistory = removeQuotedHistory(visible);
  const withoutSignature = withoutHistory.split(/^\s*--\s*$/m, 1)[0]
    .split(/^Sent from my (?:iPhone|iPad|Android)\s*$/im, 1)[0];
  return withoutSignature.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxLength);
}
