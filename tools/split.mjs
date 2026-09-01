#!/usr/bin/env node
/* ============================================================
   How src/ was cut out of index.html.

   The dashboard was one 7,800-line file. This script is the record
   of the split: for each module it names the exact line ranges it
   came from, the imports that replaced the shared global scope, and
   a checksum of the result. Re-running it against the original
   index.html reproduces src/ byte for byte, which is what makes the
   claim "nothing was rewritten, only moved" checkable rather than
   asserted.

   Run:  node tools/split.mjs            (writes src/, verifies)
         node tools/split.mjs --check    (verifies only)

   It has a shelf life. Once the views become React components,
   index.html is no longer their source and this stops being
   re-runnable — by then it has done its job.
   ============================================================ */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const lines = fs.readFileSync(path.join(root, 'index.html'), 'utf8').split('\n');

/* a top-level declaration becomes a named export */
const DECL = /^(?:(?:async)\s+)?(?:function|const|let|var|class)\s+[A-Za-z_$][\w$]*/;

/* the data layer used to call the renderer directly; it announces now */
const REPLACE = {
  'model/db.js':       [[/\bupdateSaveBadge\(\)/g, 'notifyStatus()']],
  'import/notion.js':  [[/\brender\(\)/g, 'notify()']],
  'import/metrics.js': [[/\brender\(\)/g, 'notify()']],
  'sync/sheets.js':    [[/\brender\(\)/g, 'notify()']],
  'sync/gcal.js':      [[/\brender\(\)/g, 'notify()']],
  'sync/notionWriteback.js': [[/\brender\(\)/g, 'notify()']],
  'model/duplicates.js':     [[/\brender\(\)/g, 'notify()']]
};
const VIEW_RENDER = /^views\//;

const DB_TAIL = fs.readFileSync(path.join(root, 'tools/db-tail.txt'), 'utf8');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(root, 'tools/manifest.json'), 'utf8'));

let ok = 0, bad = [];
for (const m of MANIFEST) {
  let src = m.ranges.map(([a, b]) => lines.slice(a - 1, b).join('\n')).join('\n');
  if (!m.raw) {
    for (const [re, to] of (REPLACE[m.file] || [])) src = src.replace(re, to);
    if (VIEW_RENDER.test(m.file)) src = src.replace(/\brender\(\)/g, 'notify()');
    src = src.split('\n').map((l) => (DECL.test(l) ? 'export ' + l : l)).join('\n');
    src = (m.imports.length ? m.imports.join('\n') + '\n\n' : '') + src.trim() + '\n';
    if (m.file === 'model/db.js') src += DB_TAIL;
  } else {
    src = src.join ? src.join('\n') : src;
    src = src + '\n';
  }
  const sha = crypto.createHash('sha256').update(src).digest('hex');
  if (sha === m.sha256) ok++; else bad.push(`${m.file}\n     expected ${m.sha256}\n     produced ${sha}`);
  if (!checkOnly) {
    const p = path.join(root, 'src', m.file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, src);
  }
}
console.log(`${ok}/${MANIFEST.length} modules match the recorded checksum`);
if (bad.length) { console.log('\nMISMATCH:\n  - ' + bad.join('\n  - ')); process.exit(1); }
