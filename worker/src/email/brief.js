function safeText(value, maxLength = 500) {
  return String(value || '').replace(/https?:\/\/[^\s"'<>]+|www\.[^\s"'<>]+/gi, '[link removed]')
    .replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function composeInboxBrief(items, emailCount) {
  const ranked = [...items].sort((a, b) => b.priority - a.priority);
  const actions = ranked.filter((item) => item.needs_reply || item.urgent).slice(0, 5);
  const deadlines = ranked.filter((item) => item.deadline_iso).slice(0, 5);
  const decisions = ranked.filter((item) => item.category === 'decision').slice(0, 5);
  const waiting = ranked.filter((item) => item.category === 'waiting_on').slice(0, 5);
  const bundles = ranked.filter((item) => item.bulk);
  const noiseCount = ranked.filter((item) => ['promotion', 'newsletter', 'notification'].includes(item.category)).length;
  const earliest = deadlines[0]?.deadline_iso || 'none detected';
  const summary = [
    actions[0] ? `Top priority: ${safeText(actions[0].one_line, 140)}` : `Top priority: no urgent action found in ${emailCount} selected emails.`,
    `${actions.length} selected item${actions.length === 1 ? '' : 's'} need action; earliest detected deadline: ${earliest}.`,
    `Safely ignore or review later: ${noiseCount} low-priority notifications and ${bundles.length} sender bundles.`,
  ].join('\n');
  return {
    summary,
    important: actions.map((item) => safeText(`${item.priority_label} · ${item.one_line} — ${item.why_ranked}`)),
    decisions: decisions.map((item) => safeText(item.one_line, 140)),
    deadlines: deadlines.map((item) => safeText(`${item.deadline_iso}: ${item.one_line}`, 220)),
    waiting_on: waiting.map((item) => safeText(item.one_line, 140)),
    bundles: bundles.map((item) => safeText(`${item.from_name || item.from_domain || 'Sender'} (${item.cluster_count || 1})`, 160)),
    ignore: [`${noiseCount} promotions or notifications can wait.`],
    ranked_items: ranked.map((item) => ({
      id: safeText(item.id, 200),
      category: safeText(item.category, 40),
      one_line: safeText(item.one_line, 140),
      summary: safeText(item.summary, 300),
      ask: item.ask ? safeText(item.ask, 200) : null,
      deadline_iso: item.deadline_iso || null,
      amount: item.amount || null,
      needs_reply: Boolean(item.needs_reply),
      urgent: Boolean(item.urgent),
      confidence: Number.isFinite(item.confidence) ? item.confidence : 0,
      priority: item.priority,
      priority_label: safeText(item.priority_label, 20),
      why_ranked: safeText(item.why_ranked, 300),
      from_name: safeText(item.from_name || 'Sender', 100),
      from_domain: safeText(item.from_domain, 100),
      received: safeText(item.received, 80),
      bulk: Boolean(item.bulk),
      cluster_count: item.cluster_count || 1,
    })),
  };
}
