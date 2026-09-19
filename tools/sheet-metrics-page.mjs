/* Setup → Sheet metrics, in a browser.

   The panel that connects the scraper Sheet. What matters here is less
   that it renders and more that it can never be mistaken for the other
   one: Setup → Google Sheet is the workspace mirror whose Pull replaces
   everything, and this reads numbers onto records that already exist.
   The two share no storage key and no code, and the panel says so on
   screen — which is the last of those three that a person actually sees.

   Runs against the real index.html; the workspace comes from the same
   seed every other harness uses. */

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const seed = fs.readFileSync(path.join(ROOT, 'tmp/seed.json'), 'utf8');
const errs = [];
const ok = (n, c, x) => {
  if (c) console.log('ok   ' + n + (x ? '   ' + x : ''));
  else { console.log('FAIL ' + n + (x ? '   ' + x : '')); errs.push(n); }
};

const app = express(); app.use(express.json({limit:'10mb'}));
app.get('/api/me',(q,r)=>r.json({user:{email:'k@v.com',name:'H'},staff:true}));
let WS={db:JSON.parse(seed).db,settings:{},revision:1};
app.get('/api/workspace',(q,r)=>r.json({ok:true,...WS}));
app.post('/api/workspace',(q,r)=>r.json({ok:true,savedAt:new Date().toISOString(),revision:++WS.revision}));
app.use(express.static(ROOT)); app.get('*',(q,r)=>r.sendFile(path.join(ROOT, 'index.html')));
const srv=app.listen(0); await new Promise(r=>srv.once('listening',r));
const BASE='http://127.0.0.1:'+srv.address().port;
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const ctx=await b.newContext({viewport:{width:1500,height:1000}});
const p=await ctx.newPage(); p.on('pageerror', (e) => errs.push('page error: ' + e.message));

await p.goto(BASE+'/#/settings/sheetmetrics'); await p.waitForTimeout(1200);
ok('the Setup panel renders', await p.isVisible('#smBase'));
ok('it is listed in the Setup menu', (await p.textContent('.panel, #panelList')).includes('Sheet metrics'));
ok('ER unit selector is there with Percent default',
  (await p.inputValue('#smEr'))==='percent');
ok('zero handling defaults to "treat as blank"', (await p.inputValue('#smZero'))==='skip');
ok('it warns that this is NOT the workspace mirror',
  (await p.textContent('#view')).includes('not the workspace mirror'));

await p.fill('#smBase','https://docs.google.com/spreadsheets/d/1AbC/edit');
await p.dispatchEvent('#smBase','change'); await p.waitForTimeout(600);
ok('the Sheet link is kept', (await p.inputValue('#smBase')).includes('1AbC'));
ok('Read the Sheet becomes available', !(await p.isDisabled('#smDry')));

await p.click('#smAddTab'); await p.waitForTimeout(500);
ok('a content tab row can be added', (await p.$$('[data-smtgid]')).length===1);
await p.fill('[data-smtname]','Campaign A'); await p.dispatchEvent('[data-smtname]','change');
await p.click('#smAddTab'); await p.waitForTimeout(500);
ok('and a second, for per-campaign tabs', (await p.$$('[data-smtgid]')).length===2);
ok('the first tab kept its name', (await p.inputValue('[data-smtname]'))==='Campaign A');

ok('content column mapping fields are present',
  (await p.$$('[data-smmap="content"]')).length===12, (await p.$$('[data-smmap="content"]')).length+' fields');
ok('creator column mapping fields are present',
  (await p.$$('[data-smmap="creator"]')).length===9);

await p.fill('[data-smmap="content"][data-field="postUrl"]','Post URL');
await p.dispatchEvent('[data-smmap="content"][data-field="postUrl"]','change'); await p.waitForTimeout(400);
ok('a mapping survives a re-render', await (async()=>{
  await p.goto(BASE+'/#/settings/templates'); await p.waitForTimeout(400);
  await p.goto(BASE+'/#/settings/sheetmetrics'); await p.waitForTimeout(700);
  return (await p.inputValue('[data-smmap="content"][data-field="postUrl"]'))==='Post URL';
})());

/* a Sheet that is not published must say so rather than fail silently */
await p.click('#smDry'); await p.waitForTimeout(3000);
ok('an unreachable Sheet explains itself', (await p.textContent('#smOut')).length>20,
  (await p.textContent('#smOut')).slice(0,90));

ok('the existing Google Sheet panel still works', await (async()=>{
  await p.goto(BASE+'/#/settings/sheet'); await p.waitForTimeout(800);
  return (await p.textContent('#view')).length>200;
})());
ok('no page errors', errs.length===0, errs.slice(0,2).join(' | '));
await b.close(); srv.close();
console.log(errs.length ? '\n' + errs.length + ' FAILED' : '\nall sheet metrics panel checks passed');
process.exit(errs.length ? 1 : 0);
