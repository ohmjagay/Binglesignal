export function scoreEmail(item, context = {}) {
  const senderDomain = String(item.from_domain || '').toLowerCase();
  const userDomain = String(context.userDomain || '').toLowerCase();
  const sender = item.important || context.vipSenders?.has?.(senderDomain) ? 1 : userDomain && senderDomain === userDomain ? 0.7
    : item.automated ? 0 : 0.3;
  const direct = item.direct === 'to' ? 1 : item.direct === 'cc' ? 0.4 : 0;
  const ask = item.needs_reply ? 1 : 0;
  const deadlineDays = Number.isFinite(item.deadline_days) ? item.deadline_days : Infinity;
  const deadline = deadlineDays <= 0 ? 1 : deadlineDays <= 1 ? 0.9 : deadlineDays <= 3 ? 0.7 : deadlineDays <= 7 ? 0.4 : 0;
  const thread = item.waiting_on ? 1 : 0;
  const feedback = Math.max(0, Math.min(1, Number(item.feedback_weight) || 0));
  const priority = Math.round(40 * sender + 20 * direct + 15 * ask + 15 * deadline + 5 * thread + 5 * feedback);
  const label = priority >= 70 ? 'ACT NOW' : priority >= 50 ? 'TODAY' : priority >= 25 ? 'FYI' : 'BUNDLE';
  const reasons = [];
  if (sender >= 0.7) reasons.push('trusted or same-company sender');
  if (item.important) reasons.push('marked important by your mail provider');
  if (direct) reasons.push(direct === 1 ? 'addressed directly to you' : 'you were copied');
  if (ask) reasons.push('asks for a response');
  if (deadline) reasons.push('has a near-term deadline');
  if (thread) reasons.push('someone is waiting on you');
  if (!reasons.length) reasons.push(item.bulk ? 'grouped as bulk mail' : 'no clear urgent action found');
  return { ...item, priority, priority_label: label, why_ranked: `Ranked ${label.toLowerCase()} because it ${reasons.join(', ')}.` };
}
