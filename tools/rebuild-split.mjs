/* Writes src/ from index.html using the ranges in tools/manifest.json, then
   refreshes the manifest's checksums to whatever it just produced. Run after
   tools/reanchor.mjs; tools/split.mjs then verifies the result. */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const lines = fs.readFileSync('index.html', 'utf8').split('\n');
const manifest = JSON.parse(fs.readFileSync('tools/manifest.json', 'utf8'));
const DECL = /^(?:(?:async)\s+)?(?:function|const|let|var|class)\s+[A-Za-z_$][\w$]*/;
const REPLACE = {
  'model/db.js':       [[/\bupdateSaveBadge\(\)/g, 'notifyStatus()']],
  'import/notion.js':  [[/\brender\(\)/g, 'notify()']],
  'import/metrics.js': [[/\brender\(\)/g, 'notify()']],
  'sync/sheets.js':    [[/\brender\(\)/g, 'notify()']],
  'sync/gcal.js':      [[/\brender\(\)/g, 'notify()']],
  'sync/notionWriteback.js': [[/\brender\(\)/g, 'notify()']]
};
const DB_TAIL = fs.readFileSync('tools/db-tail.txt', 'utf8');

for (const m of manifest) {
  let src = m.ranges.map(([a, b]) => lines.slice(a - 1, b).join('\n')).join('\n');
  if (!m.raw) {
    for (const [re, to] of (REPLACE[m.file] || [])) src = src.replace(re, to);
    if (/^views\//.test(m.file)) src = src.replace(/\brender\(\)/g, 'notify()');
    src = src.split('\n').map((l) => (DECL.test(l) ? 'export ' + l : l)).join('\n');
    src = (m.imports.length ? m.imports.join('\n') + '\n\n' : '') + src.trim() + '\n';
    if (m.file === 'model/db.js') src += DB_TAIL;
  } else {
    src = src + '\n';
  }
  const p = path.join('src', m.file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, src);
  m.sha256 = crypto.createHash('sha256').update(src).digest('hex');
  /* `current` means "ranges are already in today's coordinates", which is
     true only until this file is written and the manifest becomes the new
     baseline. Clearing it here stops a stale flag telling a later re-anchor
     to skip the module, which lets its neighbour swallow it. */
  delete m.current;
}
fs.writeFileSync('tools/manifest.json', JSON.stringify(manifest, null, 1));
console.log(`wrote ${manifest.length} modules and refreshed their checksums`);
