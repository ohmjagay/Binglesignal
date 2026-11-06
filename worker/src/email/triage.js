const SECURITY_TERMS = /\b(password reset|new sign[- ]in|new device|verify (?:your )?account|security alert|unusual activity|one[- ]time code|otp)\b/i;
const AUTOMATED_SENDER = /(?:^|[._+-])(?:no[-.]?reply|notifications?|alerts?|mailer-daemon)(?:[._+-]|@)/i;
const CATEGORIES = new Set([
  'needs_action', 'decision', 'waiting_on', 'meeting', 'finance', 'travel',
  'security', 'client', 'internal', 'newsletter', 'promotion', 'notification',
]);

export function triageEmail(metadata = {}) {
  const headers = metadata.headers || {};
  const subject = String(metadata.subject || '');
  const from = String(metadata.from || headers.from || '');
  const domain = String(metadata.from_domain || from.split('@').pop()?.replace(/[>;,].*$/, '') || '').toLowerCase();
  const labels = new Set((metadata.labelIds || []).map((label) => String(label).toUpperCase()));
  const header = (name) => String(headers[name.toLowerCase()] || '');
  const security = SECURITY_TERMS.test(`${subject} ${from}`);
  const bulk = Boolean(header('list-unsubscribe') || /\bbulk\b/i.test(header('precedence')) ||
    ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'SPAM'].some((label) => labels.has(label)));
  const automated = AUTOMATED_SENDER.test(from);
  const finance = /\b(invoice|receipt|payment|bank|transaction|upi)\b/i.test(subject) ||
    /\b(?:bank|payments?|upi|wallet|billing|invoice)\b/i.test(domain);
  const travel = /\b(flight|boarding|itinerary|hotel|booking|train)\b/i.test(subject) ||
    /\b(?:airline|travel|railway|hotel|booking)\b/i.test(domain);
  let category = security ? 'security' : bulk ? (labels.has('CATEGORY_PROMOTIONS') ? 'promotion' : 'newsletter')
    : finance ? 'finance' : travel ? 'travel' : automated ? 'notification' : null;
  if (category && !CATEGORIES.has(category)) category = 'notification';
  return {
    category,
    security,
    bulk,
    automated,
    important: labels.has('IMPORTANT') || labels.has('STARRED'),
    needsAi: !security && !bulk && !automated,
    labels: [...labels],
  };
}
