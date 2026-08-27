/* Inline onclick="…" can only see globals. src/app/globals.js is the list
   of names put there on purpose; this fails if a view calls something that
   is not on it, which is a blank "x is not defined" at the moment someone
   clicks — the kind of thing that reaches production because nobody clicks
   that particular button while testing. */
import fs from 'fs';
import path from 'path';

const files = [];
(function w(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f);
  fs.statSync(p).isDirectory() ? w(p) : /\.jsx?$/.test(f) && files.push(p); } })('src');

const BUILTIN = new Set(['event', 'location', 'this', 'Number', 'String', 'parseInt',
  'parseFloat', 'confirm', 'alert', 'stopPropagation', 'preventDefault', 'JSON', 'Math']);

const exposed = new Set();
{
  const g = fs.readFileSync('src/app/globals.js', 'utf8');
  const m = g.match(/Object\.assign\(window,\s*\{([\s\S]*?)\}\)/);
  if (m) m[1].split(',').forEach((n) => { const t = n.trim(); if (t) exposed.add(t); });
}

const HANDLER = /on(?:click|change|input|submit|keyup|keydown|mouseenter|mouseleave)=\\?["']([^"']*)["']/g;
const CALL = /([A-Za-z_$][\w$]*)\s*\(/g;

let bad = [];
for (const f of files) {
  if (f.endsWith('globals.js')) continue;
  const src = fs.readFileSync(f, 'utf8');
  for (const h of src.matchAll(HANDLER)) {
    for (const c of h[1].matchAll(CALL)) {
      const name = c[1];
      if (BUILTIN.has(name) || exposed.has(name)) continue;
      bad.push(`${f}: ${name}() is called from an inline handler but is not on window`);
    }
  }
}
console.log(bad.length ? bad.join('\n') : `every inline handler resolves (${exposed.size} names exposed)`);
process.exit(bad.length ? 1 : 0);
