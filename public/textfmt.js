// Small text helpers shared by the website, the Worker and the news robot (scripts/ingest.mjs).
// Pure functions only: no browser, no network, so the same file runs everywhere and is easy to test.

// "1 story", "2 stories". Use this instead of writing `${n} stories` by hand.
export const plural = (n, one, many = one + 's') => `${n} ${Number(n) === 1 ? one : many}`;

// ---------- one headline style: Title Case, tidy punctuation ----------
// Publishers write headlines in different styles (Sentence case, Title Case, ALL CAPS). Capitalising every significant word is the only
// direction that can never damage a name (Tata, Zomato, iPhone), so that is the house style.
// ("up", "off" and "out" are left out on purpose: in "Sells Out" and "Picks Up" they are part of the verb and keep their capital.)
const SMALL = new Set('a an the and but or nor for so yet as at by in of on to vs via per'.split(' '));
// Short all-caps words that really are acronyms, so an ALL-CAPS headline keeps them as they are.
const ACRONYMS = new Set(('AI IT US UK EU UN UAE USA RBI SEBI IPO IPOS GDP GST UPI CEO CFO CTO COO EV EVS ETF ETFS NSE BSE NATO IMF OPEC ECB FBI CIA FDA SEC FED ' +
  'ISRO NASA IPL BCCI ICC FIFA NBA NFL F1 TCS HDFC SBI LIC ONGC NHAI FII DII SIP KYC SME SMES MSME MSMES AGM Q1 Q2 Q3 Q4 FY OTT D2C B2B B2C SAAS API ' +
  'ML LLM LLMS GPU CPU 5G 4G 3D VC PE NFT DAO USD INR EUR GBP PM CM MP MLA DGP CBI ED NIA NCLT CCI IRDAI TRAI DPDP').split(' '));
const MIXED = /[a-z][A-Z]/;            // iPhone, OpenAI, YouTube, PhonePe: leave exactly as written
const HAS_DIGIT_OR_SYMBOL = /[0-9@#$€£₹%&+=<>]/;

const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w);

function isShouting(text) {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < 8) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length >= 0.8 && text.trim().split(/\s+/).length >= 3;
}

function fixWord(core, { first, afterBreak, shouting }) {
  if (!core) return core;
  if (/^([A-Za-z]\.){2,}$/.test(core)) return core.toUpperCase();                    // U.S., U.K.
  if (/^[a-z0-9-]+\.(com|in|org|net|io|ai|co|app|dev)$/.test(core)) return core;      // x.com, yourstory.com
  if (HAS_DIGIT_OR_SYMBOL.test(core)) return core;                                    // Q3, $5bn, ₹500, H-1B, 5G
  if (core.includes('-') && !/^-|-$/.test(core)) {                                    // cost-cutting -> Cost-Cutting, US-China stays
    return core.split('-').map((part, i) => fixWord(part, { first: first && i === 0, afterBreak: afterBreak && i === 0, shouting })).join('-');
  }
  if (core.includes('/')) return core.split('/').map((part) => fixWord(part, { first, afterBreak, shouting })).join('/');
  if (shouting) {
    if (ACRONYMS.has(core)) return core;
    if (core.length === 1) return core === 'A' && !first ? 'a' : core;
    core = core.toLowerCase();
  } else {
    if (MIXED.test(core)) return core;
    if (core === core.toUpperCase() && core.length > 1) return core;                  // AI, NASA, UPI written in capitals
  }
  const lower = core.toLowerCase();
  if (!first && !afterBreak && SMALL.has(lower)) return lower;
  if (!/[a-z]/i.test(core)) return core;
  return cap(core);
}

export function titleCase(text) {
  const input = String(text || '').trim();
  if (!input) return '';
  const shouting = isShouting(input);
  let first = true, afterBreak = false;
  return input.split(/(\s+)/).map((piece) => {
    if (/^\s+$/.test(piece) || piece === '') return piece;
    const m = piece.match(/^([“"‘'(\[]*)(.*?)([”"’'.,:;!?)\]…]*)$/s);
    const [, lead, core, trail] = m;
    if (!core) return piece;
    if (/^[—–|•·&-]+$/.test(core)) { afterBreak = true; return piece; }
    const out = lead + fixWord(core, { first, afterBreak: afterBreak || lead.length > 0, shouting }) + trail;
    first = false;
    afterBreak = /[:?!]$/.test(trail);
    return out;
  }).join('');
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
const looseName = (s) => String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');

// Tidy quotes and dashes the same way everywhere.
function typography(text) {
  let s = text.replace(/\s*(\.{3}|…)\s*/g, '… ').replace(/\s+([,.;:!?])/g, '$1');
  s = s.replace(/(\w)'(\w)/g, '$1’$2');                                 // India's -> India’s
  s = s.replace(/(^|[\s(\[“—–-])"/g, '$1“').replace(/"/g, '”');
  s = s.replace(/(^|[\s(\[“—–-])'/g, '$1‘').replace(/'/g, '’');
  s = s.replace(/\s+(-{1,2}|–|—)\s+/g, ' — ');                          // spaced hyphen or dash -> one em dash
  return s.replace(/\s+/g, ' ').replace(/[\s\-–—|:]+$/, '').trim();   // no dangling " -" or " |" left behind
}

// The one function every headline goes through. `source` lets it remove a trailing " - Reuters" that some feeds add.
export function cleanHeadline(title, source = '') {
  let s = String(title || '');
  for (const [entity, char] of Object.entries(ENTITIES)) s = s.split(entity).join(char);
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  if (source) {
    const wanted = looseName(source);
    for (const sep of [' - ', ' | ', ' – ', ' — ', ' :: ', ' • ']) {
      const at = s.lastIndexOf(sep);
      if (at > 20 && looseName(s.slice(at + sep.length)) === wanted) { s = s.slice(0, at).trim(); break; }
    }
  }
  return titleCase(typography(s));
}

// ---------- the same story told twice ----------
const STOP = new Set('the and for with from that this these those after over into about how why what when who will new says said more than not but has have had you your our their his her she they can could may might out off amid via per are was were been its'.split(' '));
export const titleWords = (t) => new Set(String(t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));

export function sameStory(a, b) {
  const x = a instanceof Set ? a : titleWords(a), y = b instanceof Set ? b : titleWords(b);
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  const j = shared / (x.size + y.size - shared || 1);
  return shared >= 3 && (j >= 0.5 || (shared >= 4 && j >= 0.35));   // at least 3 meaningful words in common, so short headlines are never mistaken for repeats
}

// Keeps the first of every group of near-identical headlines. `items` must already be in best-first order.
export function dropRepeats(items, getTitle = (x) => x.t) {
  const kept = [];
  for (const item of items) {
    const words = titleWords(getTitle(item));
    if (!kept.some((k) => sameStory(k.words, words))) kept.push({ item, words });
  }
  return kept.map((k) => k.item);
}

// Domain used for the small source logo, taken from the link when it is a real publisher link.
export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

// ---------- a summary split into its sentences (for the "What happened" points) ----------
const ABBREVIATION = /^(?:[A-Z]\.){1,3}$|^(?:Mr|Mrs|Ms|Dr|St|Inc|Ltd|Co|Corp|vs|No|Jr|Sr|Prof|Rs|Fig)\.$/;
export function sentences(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const out = [], re = /[.!?]+["”’)]*\s+/g;
  let start = 0, m;
  while ((m = re.exec(t))) {
    const end = m.index + m[0].length;
    const lastWord = t.slice(start, m.index + m[0].trimEnd().length).split(' ').pop();
    if (!/[A-Z0-9“"‘(]/.test(t[end] || '')) continue;      // a new sentence starts with a capital letter, a digit or a quote
    if (ABBREVIATION.test(lastWord)) continue;             // "U.S.", "Dr." and "Inc." do not end a sentence
    out.push(t.slice(start, end).trim());
    start = end;
  }
  const rest = t.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}
