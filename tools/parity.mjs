/* The refactor is only worth anything if it changed nothing. This walks
   the same routes through the original single-file dashboard and through
   the React build, with the same seeded workspace, and compares what
   each one puts on screen. */
import { chromium } from 'playwright';
import fs from 'fs';
const seed = fs.readFileSync((process.env.VIVELY_SEED || 'tmp/seed.json'), 'utf8');

const ROUTES = [
  '#/overview/summary/views', '#/overview/summary/eng', '#/overview/summary/cost',
  '#/overview/attention', '#/overview/pipeline', '#/overview/content',
  '#/campaigns/all/active', '#/campaigns/all/all', '#/campaigns/all/wrapped', '#/campaigns/all/calendar',
  '#/campaigns/cp1/roster', '#/campaigns/cp1/content', '#/campaigns/cp1/calendar',
  '#/campaigns/cp1/performance', '#/campaigns/cp1/creators', '#/campaigns/cp1/brief', '#/campaigns/cp1/report',
  '#/campaigns/cp2/roster', '#/campaigns/cp3/report',
  '#/creators/all/directory', '#/creators/all/insights',
  '#/analytics/trend', '#/analytics/cost', '#/analytics/breakdown', '#/analytics/viral',
  '#/messages/cp1/outreach', '#/contracts/msa/draft', '#/contracts/msa/clauses', '#/contracts/msa/preview',
  '#/contracts/sow/draft', '#/contracts/short/draft',
  '#/settings/templates', '#/settings/blacklist', '#/settings/sheet', '#/settings/calendar', '#/settings/partners', '#/settings/integrations',
  '#/settings/sources', '#/settings/report', '#/settings/definitions'
];

/* ids and generated colours differ run to run in a couple of places; the
   comparison is on the words on screen, not the markup */
const norm = (t) => t.replace(/\s+/g, ' ').trim();

async function walk(base) {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext();
  await ctx.addInitScript(([s]) => {
    localStorage.setItem('vively-workspace-v1', s);
    localStorage.setItem('vively-auth-user-v1', JSON.stringify({ email: 'a@b.c', name: 'Test' }));
  }, [seed]);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  await p.goto(base, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(800);
  const out = {};
  for (const h of ROUTES) {
    await p.evaluate((x) => { location.hash = x; }, h);
    await p.waitForTimeout(260);
    out[h] = {
      text: norm(await p.$eval('#view', (e) => e.innerText)),
      h1: await p.$eval('.topbar h1, #pageTitle', (e) => e.textContent),
      tabs: await p.$$eval('.tabbar .tab', (n) => n.map((x) => x.textContent).join('|')),
      panel: await p.$$eval('.panel-item .pi-t', (n) => n.map((x) => x.textContent).join('|'))
    };
  }
  await b.close();
  return { out, errs };
}

const legacy = await walk('http://localhost:3120/');
const next   = await walk('http://localhost:3120/next/');
if (legacy.errs.length) console.log('legacy page errors:', legacy.errs);
if (next.errs.length)   console.log('react page errors :', next.errs);

let same = 0, diff = [];
for (const h of ROUTES) {
  const a = legacy.out[h], c = next.out[h];
  const keys = ['h1', 'tabs', 'panel', 'text'].filter((k) => a[k] !== c[k]);
  if (!keys.length) { same++; continue; }
  diff.push({ h, keys, a, c });
}
console.log(`\n${same}/${ROUTES.length} routes identical`);
for (const d of diff) {
  console.log('\n### ' + d.h + '  differs in: ' + d.keys.join(', '));
  for (const k of d.keys) {
    if (k !== 'text') { console.log(`  legacy ${k}: ${d.a[k]}\n  react  ${k}: ${d.c[k]}`); continue; }
    const A = d.a.text.split(' '), C = d.c.text.split(' ');
    let i = 0; while (i < A.length && A[i] === C[i]) i++;
    console.log('  first divergence at word ' + i);
    console.log('  legacy: …' + A.slice(Math.max(0, i - 8), i + 14).join(' '));
    console.log('  react : …' + C.slice(Math.max(0, i - 8), i + 14).join(' '));
  }
}
