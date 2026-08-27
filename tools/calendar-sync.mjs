/* Drives the real UI against a stand-in Google, then asks that stand-in
   what actually landed on the calendar. The question this answers is the
   one that matters: does syncing twice create two of everything? */
import { chromium } from 'playwright';
import fs from 'fs';
const seed = fs.readFileSync('tmp/seed.json', 'utf8');
const APP = process.argv[2] || 'http://localhost:3120/';
const FAKE = 'http://127.0.0.1:3455';

const state = async () => (await fetch(FAKE + '/__state')).json();
await fetch(FAKE + '/__reset', { method: 'POST' });

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext();
await ctx.addInitScript(([s]) => {
  localStorage.setItem('vively-workspace-v1', s);
  localStorage.setItem('vively-auth-user-v1', JSON.stringify({ email: 'k@v.com', name: 'K' }));
}, [seed]);
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/ERR_TUNNEL|503|Failed to load resource|fonts\.g/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

await p.goto(APP, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);
await p.evaluate(() => { location.hash = '#/campaigns/all/calendar'; });
await p.waitForTimeout(800);

const strip = await p.$eval('#view', (e) => e.innerText.split('\n').slice(0, 3).join(' | '));
console.log('strip        :', strip);

async function sync(label) {
  await p.click('#gcSync');
  await p.waitForTimeout(2500);
  const s = await state();
  const issues = await p.$$eval('#view .note', (n) => n.map((x) => x.innerText.trim()));
  console.log(`${label.padEnd(14)}: ${s.count} events on the calendar`);
  return { s, issues };
}

const first = await sync('after 1st sync');
const second = await sync('after 2nd sync');
const third = await sync('after 3rd sync');

console.log('\nGoogle received:', third.s.calls.reduce((a, c) => { a[c.what] = (a[c.what] || 0) + 1; return a; }, {}));
console.log('duplicate check:', first.s.count === second.s.count && second.s.count === third.s.count
  ? `PASS — still ${third.s.count} after three syncs` : `FAIL — ${first.s.count} → ${second.s.count} → ${third.s.count}`);

const ids = third.s.ids;
console.log('unique ids     :', new Set(ids).size === ids.length ? 'PASS' : 'FAIL');
console.log('ids legal      :', ids.every((i) => /^[0-9a-v]{5,1024}$/.test(i)) ? 'PASS' : 'FAIL ' + ids.filter((i) => !/^[0-9a-v]{5,1024}$/.test(i)));

const seoul = third.s.events.find((e) => (e.start.dateTime || '').includes('T19:00'));
console.log('19:00 stays 19:00:', seoul ? 'PASS — ' + seoul.start.dateTime : 'no 19:00 event found');

console.log('\nissues shown to the user:');
third.issues.forEach((i) => console.log('  • ' + i.replace(/\s+/g, ' ').slice(0, 150)));
console.log('\nerrors:', errs.length ? '\n  ' + errs.join('\n  ') : 'none');
await b.close();
process.exit(errs.length ? 1 : 0);
