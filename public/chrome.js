// The footer, the light/dark switch and the shared links, written ONCE and used by every page (home, pricing, About, legal pages, 404).
// To change a footer link, the company line or a social handle, edit it here or in config.js. Nothing else needs touching.
const BS = window.BS || {};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SOCIAL = [['x', 'X', 'https://x.com/'], ['linkedin', 'LinkedIn', 'https://www.linkedin.com/company/'], ['instagram', 'Instagram', 'https://instagram.com/'],
  ['youtube', 'YouTube', 'https://youtube.com/@'], ['whatsapp', 'WhatsApp channel', '']];

// Only the accounts that are filled in config.js are shown.
export function socialLinks() {
  return SOCIAL.map(([key, name, base]) => {
    const value = String(BS[key] || '').trim();
    if (!value) return null;
    const url = /^https?:\/\//i.test(value) ? value : base ? base + value.replace(/^@/, '') : '';
    return url ? { name, url } : null;
  }).filter(Boolean);
}

// The logo and wordmark. `gid` keeps the gradient id unique when two headers exist in the same page.
export const brandInner = (gid = 'g') => `<svg class="logo" viewBox="0 0 40 40" role="img" aria-label="BingleSignal"><defs><linearGradient id="${gid}" x1="0" x2="1"><stop offset="0" stop-color="#F0D690"/><stop offset="1" stop-color="#B8954A"/></linearGradient></defs><rect x=".5" y=".5" width="39" height="39" rx="9" fill="#0D1B2E" stroke="#D4B46A" stroke-opacity=".55"/><path d="M12 9h9a5.5 5.5 0 0 1 0 11h-9zM12 20h10a5.5 5.5 0 0 1 0 11H12z" fill="url(#${gid})"/><circle cx="31.5" cy="8.5" r="2.2" fill="#fff"/></svg><span>Bingle<em>Signal</em></span>`;

export function footerHTML() {
  const soc = socialLinks().map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a>`).join('');
  const mail = BS.email ? `<a href="mailto:${esc(BS.email)}">${esc(BS.email)}</a>` : '';
  return `<div class="co"><b>© ${new Date().getFullYear()} ${esc(BS.company || 'BingleSignal')}${BS.city ? ` · ${esc(BS.city)}` : ''}</b>${BS.operator ? `<span>${esc(BS.operator)}</span>` : ''}${mail ? `<span>${mail}</span>` : ''}</div>`
    + '<nav aria-label="Footer"><a href="/pricing">Pricing</a><a href="/about">About</a><a href="/how-we-choose-news">How we choose news</a><a href="/terms">Terms</a><a href="/refund">Refunds</a><a href="/privacy">Privacy Policy</a><a href="/contact">Contact</a><a href="/copyright">Copyright</a></nav>'
    + (soc ? `<div class="soc" aria-label="Follow BingleSignal">${soc}</div>` : '')
    + '<p>Headlines, summaries and videos belong to their publishers and creators; every item links to its original source. Videos play through YouTube - by watching you agree to the <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">YouTube Terms of Service</a> and the <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Google Privacy Policy</a>.</p>';
}

// "Share" row for one story: WhatsApp, LinkedIn, X and Copy link. It shares the story's own link, so the reader lands on the publisher.
export function shareLinks(title, url) {
  const link = encodeURIComponent(url);
  return [
    ['WhatsApp', `https://wa.me/?text=${encodeURIComponent(`${title} — via BingleSignal (binglesignal.com)\n${url}`)}`],
    ['LinkedIn', `https://www.linkedin.com/sharing/share-offsite/?url=${link}`],
    ['X', `https://x.com/intent/post?text=${encodeURIComponent(`${title} — via BingleSignal`)}&url=${link}`],
  ];
}
export function shareHTML(title, url) {
  if (!/^https?:\/\//i.test(url || '')) return '';
  return `<div class="shr" role="group" aria-label="Share this story"><span>Share</span>${shareLinks(title, url).map(([name, href]) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${name}</a>`).join('')}<button type="button" data-copy="${esc(url)}">Copy link</button></div>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-copy]');
  if (!b) return;
  const done = () => { const was = b.textContent; b.textContent = 'Copied ✓'; setTimeout(() => { b.textContent = was; }, 1600); };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(b.dataset.copy).then(done, () => prompt('Copy this link:', b.dataset.copy));
  else prompt('Copy this link:', b.dataset.copy);
});

// Light / dark switch. Safe to call more than once.
export function wireTheme() {
  if (window.__bsTheme) return;
  window.__bsTheme = true;
  const root = document.documentElement;
  const paint = () => {
    const light = root.getAttribute('data-theme') === 'light';
    for (const b of document.querySelectorAll('#tgl')) { b.textContent = light ? '☾' : '☀'; b.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode'); b.title = light ? 'Dark mode' : 'Light mode'; }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#F3F6FB' : '#07111F');
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('#tgl')) return;
    const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('bs_theme', next); } catch { /* the choice just is not remembered */ }
    paint();
  });
  paint();
}

window.BSChrome = { brandInner, footerHTML, shareHTML };   // for premium.js, which is a plain script

// Plain pages (About, legal pages, 404...) call this by simply loading chrome.js.
export function mountChrome() {
  const foot = document.getElementById('foot');
  if (foot && !foot.dataset.owned) foot.innerHTML = footerHTML();
  for (const el of document.querySelectorAll('[data-email]')) { el.textContent = BS.email || ''; if (el.tagName === 'A' && BS.email) el.href = 'mailto:' + BS.email; }
  wireTheme();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountChrome); else mountChrome();
