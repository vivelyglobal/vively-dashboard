/* Gives every module an import header naming what it used to read off the
   global scope. Only touches files that are missing one, so hand-tuned
   headers survive. Writes the result back into tools/manifest.json too, so
   tools/split.mjs reproduces the same files. */
import fs from 'fs'; import path from 'path';
import * as acorn from 'acorn'; import * as walk from 'acorn-walk';
const BROWSER = new Set(JSON.parse(fs.readFileSync('tools/browser-globals.json', 'utf8')));
const files = [];
(function w(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f);
  fs.statSync(p).isDirectory() ? w(p) : f.endsWith('.js') && files.push(p); } })('src');
/* The header is always recomputed from the bare body, never added on top of
   what is already there. Appending a second header worked, until the file
   was regenerated from the manifest and only the newest lines survived. */
const bareBody = (f) => {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].startsWith('import ') || lines[i].trim() === '')) i++;
  return lines.slice(i).join('\n');
};
const parse = (f) => acorn.parse(fs.readFileSync(f, 'utf8'), { ecmaVersion: 2022, sourceType: 'module' });
const parseBody = (f) => acorn.parse(bareBody(f), { ecmaVersion: 2022, sourceType: 'module' });
const owner = {};
for (const f of files) for (const n of parse(f).body) {
  if (n.type !== 'ExportNamedDeclaration' || !n.declaration) continue;
  const d = n.declaration;
  if (d.type === 'VariableDeclaration') d.declarations.forEach((x) => (owner[x.id.name] = f));
  else if (d.id) owner[d.id.name] = f;
}
function idsOf(p, out) {
  if (!p) return;
  if (p.type === 'Identifier') out.add(p.name);
  else if (p.type === 'ObjectPattern') p.properties.forEach((q) => idsOf(q.value || q.argument, out));
  else if (p.type === 'ArrayPattern') p.elements.forEach((q) => idsOf(q, out));
  else if (p.type === 'AssignmentPattern') idsOf(p.left, out);
  else if (p.type === 'RestElement') idsOf(p.argument, out);
}
const only = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync('tools/manifest.json', 'utf8'));
let touched = 0; const unknown = new Set();
for (const f of files) {
  const rel = f.replace(/^src\//, '');
  if (only.length && !only.includes(rel)) continue;
  const ast = parseBody(f);
  const declared = new Set();
  walk.full(ast, (n) => {
    if (n.type === 'VariableDeclarator') idsOf(n.id, declared);
    if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id) declared.add(n.id.name);
    if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'FunctionDeclaration')
      n.params.forEach((p) => idsOf(p, declared));
    if (n.type === 'CatchClause' && n.param) idsOf(n.param, declared);
    if (n.type === 'ImportDeclaration') n.specifiers.forEach((s) => declared.add(s.local.name));
  });
  const refs = new Set();
  walk.ancestor(ast, { Identifier(n, st, anc) {
    const parent = anc[anc.length - 2];
    if (parent) {
      if (parent.type === 'MemberExpression' && parent.property === n && !parent.computed) return;
      if (parent.type === 'Property' && parent.key === n && !parent.computed && parent.value !== n) return;
      if (parent.type === 'MethodDefinition' && parent.key === n) return;
      if (parent.type === 'ExportSpecifier' || parent.type === 'ImportSpecifier') return;
      if (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent.type)) return;
    }
    refs.add(n.name);
  } });
  const free = [...refs].filter((n) => !declared.has(n) && !BROWSER.has(n));
  if (!free.length) continue;
  const byMod = {};
  for (const n of free) {
    const src = owner[n];
    if (!src) { unknown.add(`${n} (${f})`); continue; }
    let r = path.relative(path.dirname(f), src).replace(/\\/g, '/');
    if (!r.startsWith('.')) r = './' + r;
    (byMod[r] = byMod[r] || []).push(n);
  }
  const head = Object.entries(byMod).sort()
    .map(([m, names]) => `import { ${[...new Set(names)].sort().join(', ')} } from '${m}';`);
  if (!head.length) continue;
  fs.writeFileSync(f, head.join('\n') + '\n\n' + bareBody(f).trimStart());
  const entry = manifest.find((m) => m.file === rel);
  if (entry) entry.imports = head;
  touched++;
}
fs.writeFileSync('tools/manifest.json', JSON.stringify(manifest, null, 1));
console.log(`import headers written into ${touched} file(s)`);
if (unknown.size) { console.log('\nSTILL UNRESOLVED:'); [...unknown].sort().forEach((u) => console.log('  ' + u)); }
