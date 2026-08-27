import fs from 'fs'; import path from 'path';
import * as acorn from 'acorn';
const files=[];(function w(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);
 fs.statSync(p).isDirectory()?w(p):(f.endsWith('.js')&&!f.startsWith('_'))&&files.push(p)}})('src');
const exp={};
for(const f of files){const ast=acorn.parse(fs.readFileSync(f,'utf8'),{ecmaVersion:2022,sourceType:'module'});
 const s=new Set();
 for(const n of ast.body){ if(n.type==='ExportNamedDeclaration'){ if(n.declaration){
   if(n.declaration.type==='VariableDeclaration') n.declaration.declarations.forEach(d=>s.add(d.id.name));
   else if(n.declaration.id) s.add(n.declaration.id.name);
  } n.specifiers.forEach(sp=>s.add(sp.exported.name)); } }
 exp[path.resolve(f)]=s;}
let bad=0;
for(const f of files){const ast=acorn.parse(fs.readFileSync(f,'utf8'),{ecmaVersion:2022,sourceType:'module'});
 for(const n of ast.body){ if(n.type!=='ImportDeclaration') continue;
  const t=path.resolve(path.dirname(f), n.source.value);
  if(!exp[t]){console.log(`${f}: unknown module ${n.source.value}`);bad++;continue;}
  for(const sp of n.specifiers){ if(sp.type!=='ImportSpecifier') continue;
   if(!exp[t].has(sp.imported.name)){console.log(`${f}: '${sp.imported.name}' is not exported by ${n.source.value}`);bad++;} } } }
console.log(bad?`\n${bad} problem(s)`:'\nall imports resolve to real exports');
