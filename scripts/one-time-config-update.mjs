// One-time helper. Run it once from the project folder:   node scripts/one-time-config-update.mjs
// It makes the few small edits to public/config.js and wrangler.toml that cannot be shipped as whole files
// (you edit config.js by hand, and a whole file would overwrite your changes). Safe to run twice; delete it afterwards if you like.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const EDITS = [
  { file: 'public/config.js', what: 'pricing note (there is no free trial)', find: "note:'Every account starts with a 7-day free trial. No card needed. Cancel any time.',",
    replace: "note:'Start reading straight away. Cancel any time. Full refund within 7 days of your first payment.'," },
  { file: 'public/config.js', what: 'FAQ answer about when you are charged', find: "['Is there a free trial?','Yes. Every account starts with a 7-day free trial, and no card is needed to start it.'],",
    replace: "['When am I charged?','The moment you subscribe, then every month until you cancel. If you are not satisfied, email us within 7 days of your first payment for a full refund.']," },
  { file: 'public/config.js', what: 'WATCH shows up to 200 videos', find: 'watchCap:30,', replace: 'watchCap:200,' },
  { file: 'wrangler.toml', what: 'Worker name (binglesignalv1)', find: /^name = "binglesignal"[ \t]*$/m, replace: 'name = "binglesignalv1"' },
];

// state: 'changed' (edit made), 'already' (nothing to do) or 'missing' (the line was not found exactly once)
export function applyEdit(text, edit) {
  if (text.includes(edit.replace)) return { text, state: 'already' };
  if (typeof edit.find === 'string') {
    return text.split(edit.find).length === 2 ? { text: text.replace(edit.find, () => edit.replace), state: 'changed' } : { text, state: 'missing' };
  }
  return (text.match(new RegExp(edit.find.source, 'gm')) || []).length === 1 ? { text: text.replace(edit.find, () => edit.replace), state: 'changed' } : { text, state: 'missing' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = new URL('../', import.meta.url), files = {};
  let missing = 0;
  for (const edit of EDITS) {
    files[edit.file] ??= readFileSync(new URL(edit.file, root), 'utf8');
    const { text, state } = applyEdit(files[edit.file], edit);
    files[edit.file] = text;
    console.log(`${{ changed: 'DONE    ', already: 'ALREADY ', missing: 'MISSING ' }[state]} ${edit.file}: ${edit.what}`);
    if (state === 'missing') missing++;
  }
  for (const [file, text] of Object.entries(files)) writeFileSync(new URL(file, root), text);
  if (missing) { console.log(`\n${missing} edit(s) could not be found, so you changed that line yourself. Tell me which ones and I will give you the exact text.`); process.exitCode = 1; }
}
