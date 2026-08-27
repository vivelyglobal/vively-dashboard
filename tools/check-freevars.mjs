import fs from 'fs'; import path from 'path';
import * as acorn from 'acorn'; import * as walk from 'acorn-walk';

const BROWSER = new Set(['window','document','console','setTimeout','clearTimeout','setInterval','clearInterval','requestAnimationFrame','fetch','navigator','localStorage','Intl','JSON','Math','Date','Object','Array','String','Number','Boolean','RegExp','Set','Map','Promise','Error','TypeError','isNaN','parseInt','parseFloat','encodeURIComponent','decodeURIComponent','btoa','atob','Blob','URL','File','FileReader','FormData','Uint8Array','Uint16Array','Uint32Array','Int32Array','Float64Array','ArrayBuffer','DataView','TextDecoder','TextEncoder','DecompressionStream','Response','Request','Headers','CustomEvent','Event','globalThis','alert','confirm','prompt','structuredClone','crypto','performance','Intl','undefined','NaN','Infinity','SVGElement','HTMLElement','Node','AbortController','queueMicrotask','React','ResizeObserver','MutationObserver','IntersectionObserver','getComputedStyle','matchMedia','history','location','screen','XMLHttpRequest','DOMParser','Image','Audio','WeakMap','WeakSet','Symbol','Proxy','Reflect','BigInt','process','import','arguments','isFinite','isNaN']);

function collect(node, out) {                     // declared names in a scope-ish way
  walk.full(node, (n) => {
    if (n.type === 'VariableDeclarator') idsOf(n.id, out);
    if (n.type === 'FunctionDeclaration' && n.id) out.add(n.id.name);
    if (n.type === 'ClassDeclaration' && n.id) out.add(n.id.name);
    if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'FunctionDeclaration')
      n.params.forEach((p) => idsOf(p, out));
    if (n.type === 'CatchClause' && n.param) idsOf(n.param, out);
    if (n.type === 'ImportDeclaration') n.specifiers.forEach((s) => out.add(s.local.name));
  });
}
function idsOf(p, out) {
  if (!p) return;
  if (p.type === 'Identifier') out.add(p.name);
  else if (p.type === 'ObjectPattern') p.properties.forEach((q) => idsOf(q.value || q.argument, out));
  else if (p.type === 'ArrayPattern') p.elements.forEach((q) => idsOf(q, out));
  else if (p.type === 'AssignmentPattern') idsOf(p.left, out);
  else if (p.type === 'RestElement') idsOf(p.argument, out);
}

const files = [];
(function walkDir(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f);
  if (fs.statSync(p).isDirectory()) walkDir(p); else if (f.endsWith('.js') && !f.startsWith('_')) files.push(p); } })('src');

let bad = 0;
for (const f of files.sort()) {
  const code = fs.readFileSync(f, 'utf8');
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module' });
  const declared = new Set(); collect(ast, declared);
  const used = new Set();
  walk.full(ast, (n, st, type) => {
    if (n.type === 'MemberExpression' && !n.computed) { /* skip prop names */ }
    if (n.type === 'Identifier') used.add(n.name);
    if (n.type === 'Property' && !n.computed && n.key.type === 'Identifier') used.delete(undefined);
  });
  // remove non-reference identifier positions
  const refs = new Set();
  walk.ancestor(ast, {
    Identifier(n, st, anc) {
      const parent = anc[anc.length - 2];
      if (!parent) return refs.add(n.name);
      if (parent.type === 'MemberExpression' && parent.property === n && !parent.computed) return;
      if (parent.type === 'Property' && parent.key === n && !parent.computed && parent.value !== n) return;
      if (parent.type === 'MethodDefinition' && parent.key === n) return;
      if (parent.type === 'ExportSpecifier' || parent.type === 'ImportSpecifier') return;
      if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return;
      refs.add(n.name);
    }
  });
  const free = [...refs].filter((n) => !declared.has(n) && !BROWSER.has(n));
  if (free.length) { bad++; console.log(f + '\n   FREE: ' + free.join(' ')); }
}
console.log(bad ? `\n${bad} file(s) with unresolved names` : '\nno unresolved names');
