/* The collision as the user meets it: two campaigns answering to one id. */
import { chromium } from 'playwright';
import fs from 'fs';
const seed = fs.readFileSync('tmp/seed.json', 'utf8');
/* read the fixture from the seed rather than off the page — nothing is on
   window in the React build, and this harness has to cover both */
const seedDb = JSON.parse(seed).db;
const counts = {};
seedDb.campaigns.forEach((c) => (counts[c.id] = (counts[c.id] || 0) + 1));
const dupId = Object.keys(counts).find((k) => counts[k] > 1);
if (!dupId) { console.log('the seed has no duplicate — nothing to test'); process.exit(1); }
const clashing = seedDb.campaigns.filter((c) => c.id === dupId).map((c) => c.brand);
const APP = process.argv[2] || 'http://localhost:3120/';

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext();
await ctx.addInitScript(([s]) => {
  localStorage.setItem('vively-workspace-v1', s);
  localStorage.setItem('vively-auth-user-v1', JSON.stringify({ email: 'k@v.com', name: 'K' }));
}, [seed]);
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts\.g|ERR_TUNNEL|status of 50\d/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
p.on('dialog', (d) => d.accept());
const step = async (n, fn) => { try { await fn(); console.log('ok   ' + n); } catch (e) { console.log('FAIL ' + n + ' — ' + e.message); errs.push(n); } };

await p.goto(APP, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1400);
await p.evaluate(() => { location.hash = '#/campaigns/all/all'; });
await p.waitForTimeout(700);

await step('the clash is called out on the campaign list', async () => {
  const t = await p.$eval('#view', (e) => e.innerText);
  if (!/share an id/i.test(t)) throw new Error('no warning shown');
  if (!/Sushisora/.test(t)) throw new Error('the affected campaigns are not named');
});

await step('before the fix, both campaigns are highlighted at once', async () => {
  await p.evaluate((id) => { location.hash = `#/campaigns/${id}/roster`; }, dupId);
  await p.waitForTimeout(600);
  const active = await p.$$eval('.panel-item.active', (n) => n.length);
  if (active < 2) throw new Error(`expected both to light up, got ${active}`);
});

await step('the fix gives each its own id', async () => {
  await p.evaluate(() => { location.hash = '#/campaigns/all/all'; });
  await p.waitForTimeout(600);
  await p.click('#dupFix');
  await p.waitForTimeout(1000);
  /* the panel is the campaign list — one entry per campaign, and after the
     repair no two of them can answer to the same route */
  const hrefs = await p.$$eval('.panel-item', (n) => n.map((x) => x.getAttribute('href')));
  const ids = hrefs.filter((h) => h && h.startsWith('#/campaigns/')).map((h) => h.split('/')[2]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) throw new Error('still colliding: ' + dupes.join(', '));
});

await step('and now selecting one selects only that one', async () => {
  const href = await p.$$eval('.panel-item', (n, want) => {
    const hit = n.find((x) => (x.innerText || '').includes(want));
    return hit ? hit.getAttribute('href') : null;
  }, clashing[1]);
  if (!href) throw new Error('cannot find ' + clashing[1] + ' in the menu');
  await p.evaluate((h) => { location.hash = h.replace(/^#/, ''); }, href + '/roster');
  await p.waitForTimeout(600);
  const active = await p.$$eval('.panel-item.active', (n) => n.length);
  if (active !== 1) throw new Error(`${active} campaigns highlighted, expected 1`);
});

await step('the warning is gone', async () => {
  await p.evaluate(() => { location.hash = '#/campaigns/all/all'; });
  await p.waitForTimeout(600);
  const t = await p.$eval('#view', (e) => e.innerText);
  if (/share an id/i.test(t)) throw new Error('still warning');
});

await step('an edit through the UI now lands on one campaign only', async () => {
  /* the real test of the bug: rename one of the pair and check the other
     keeps its name */
  const [keepName, editName] = clashing;
  const href = await p.$$eval('.panel-item', (n, want) => {
    const hit = n.find((x) => (x.innerText || '').includes(want));
    return hit ? hit.getAttribute('href') : null;
  }, editName);
  await p.evaluate((h) => { location.hash = h.replace(/^#/, '') + '/roster'; }, href);
  await p.waitForTimeout(700);
  await p.click('#cpEdit');
  await p.waitForTimeout(500);
  await p.fill('#ecBrand', 'RENAMED-ONLY-THIS-ONE');
  await p.click('#ecSave');
  await p.waitForTimeout(800);
  const menu = await p.$$eval('.panel-item .pi-t', (n) => n.map((x) => x.textContent));
  if (!menu.includes('RENAMED-ONLY-THIS-ONE')) throw new Error('the rename did not take: ' + menu.join(', '));
  if (!menu.includes(keepName)) throw new Error(`renaming one also renamed "${keepName}"`);
});

console.log('\nerrors:', errs.length ? '\n  ' + errs.join('\n  ') : 'none');
await b.close();
process.exit(errs.length ? 1 : 0);
