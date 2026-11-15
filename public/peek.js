// Hover summary. When the pointer rests on a headline box, a larger box opens over it with that story's AI summary.
// A box opts in with four data attributes: data-pk-t (headline), data-pk-y (summary), data-pk-s (source name), data-pk-u (source link).
// The popup never takes the pointer (pointer-events:none in style.css), so a click still opens the original article exactly as before.
// Touch screens have no hover, so they are left alone. Keyboard users get the same box when a headline gets focus; Escape closes it.

export const DWELL_MS = 250;   // the pointer must rest this long, so moving across the page does not flash boxes
export const SWITCH_MS = 90;   // moving straight from one box to the next is quicker
export const HIDE_MS = 120;    // a short grace period, so crossing the gap between two boxes does not flicker
const MARGIN = 12;

export function peekData(el) {
  const d = el?.dataset || {};
  const t = String(d.pkT || '').trim(), y = String(d.pkY || '').trim();
  if (!t || !y) return null;
  return { t, y, s: String(d.pkS || '').trim(), u: /^https?:\/\//i.test(d.pkU || '') ? d.pkU : '' };
}

// Wider than the box it grows out of, never wider than the screen.
export function peekWidth(rect, view) {
  return Math.round(Math.max(240, Math.min(440, Math.max(360, rect.width + 56), view.w - 2 * MARGIN)));
}

// Centered on the box it grows out of, a little higher so it covers it, then kept fully on screen.
export function placePeek(rect, size, view) {
  const left = Math.min(Math.max(rect.left + rect.width / 2 - size.w / 2, MARGIN), Math.max(MARGIN, view.w - size.w - MARGIN));
  let top = rect.top - 10;
  if (top + size.h > view.h - MARGIN) top = view.h - size.h - MARGIN;
  return { left: Math.round(left), top: Math.round(Math.max(MARGIN, top)) };
}

export function install(doc, win) {
  if (!doc || !win || win.__bsPeek) return;
  win.__bsPeek = true;
  const canHover = !!win.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches;
  let box = null, cur = null, showT = 0, hideT = 0;

  const ensure = () => {
    if (box) return box;
    box = doc.createElement('div');
    box.id = 'pk'; box.className = 'pk'; box.hidden = true; box.setAttribute('role', 'tooltip');
    box.innerHTML = '<h4 class="serif"></h4><p class="y"></p><small></small>';   // fixed markup: the story text below goes in as plain text only
    doc.body.appendChild(box);
    return box;
  };
  const hide = () => {
    clearTimeout(showT); clearTimeout(hideT);
    if (box && !box.hidden) { box.classList.remove('on'); box.hidden = true; }
    cur?.removeAttribute('aria-describedby'); cur = null;
  };
  const schedHide = () => { clearTimeout(hideT); hideT = setTimeout(hide, HIDE_MS); };
  const open = (el) => {
    const d = peekData(el);
    if (!d || el.isConnected === false) return;
    const b = ensure(), r = el.getBoundingClientRect(), view = { w: win.innerWidth, h: win.innerHeight };
    b.querySelector('h4').textContent = d.t;
    b.querySelector('.y').textContent = d.y;
    b.querySelector('small').textContent = `AI summary. Click to read the full story${d.s ? ' at ' + d.s : ''}.`;
    const w = peekWidth(r, view);
    b.style.width = w + 'px'; b.style.minHeight = Math.round(r.height + 20) + 'px'; b.hidden = false;
    const pos = placePeek(r, { w, h: b.offsetHeight || 0 }, view);
    b.style.left = pos.left + 'px'; b.style.top = pos.top + 'px';
    if (cur && cur !== el) cur.removeAttribute('aria-describedby');
    cur = el; el.setAttribute('aria-describedby', 'pk');
    win.requestAnimationFrame(() => b.classList.add('on'));
  };

  doc.addEventListener('mouseover', (e) => {
    if (!canHover) return;
    const el = e.target?.closest?.('[data-pk-y]') || null;
    if (el && el === cur) { clearTimeout(hideT); return; }   // still on the same box (or something inside it)
    clearTimeout(showT);
    if (!el) { if (cur) schedHide(); return; }
    clearTimeout(hideT);
    showT = setTimeout(() => open(el), cur ? SWITCH_MS : DWELL_MS);
  });
  doc.addEventListener('focusin', (e) => {
    const el = e.target?.closest?.('[data-pk-y]');
    if (el) { clearTimeout(showT); clearTimeout(hideT); open(el); }
  });
  doc.addEventListener('focusout', () => { if (cur) schedHide(); });
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  doc.addEventListener('click', hide);
  win.addEventListener('scroll', hide, true);
  win.addEventListener('resize', hide);
  win.addEventListener('blur', hide);
  doc.documentElement?.addEventListener('mouseleave', () => { if (cur) schedHide(); });
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') install(document, window);
