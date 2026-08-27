/* The parts that only exist once you click something: drawers, wizards,
   and the inline onclick= handlers the string-rendered views still use. */
import { chromium } from 'playwright';
import fs from 'fs';
const seed = fs.readFileSync((process.env.VIVELY_SEED || 'tmp/seed.json'), 'utf8');
const base = process.argv[2] || 'http://localhost:3111/next/';

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext();
await ctx.addInitScript(([s]) => {
  localStorage.setItem('vively-workspace-v1', s);
  localStorage.setItem('vively-auth-user-v1', JSON.stringify({ email: 'a@b.c', name: 'Test' }));
}, [seed]);
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/ERR_TUNNEL|503|Failed to load resource/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
await p.goto(base, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(800);

const drawerLen = () => p.$eval('#drawerBody', (e) => e.innerHTML.length);
const drawerOpen = () => p.$eval('#drawer', (e) => e.classList.contains('open'));
async function step(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + ' — ' + e.message); errs.push(name + ': ' + e.message); }
}

await step('participant drawer opens from the roster', async () => {
  await p.evaluate(() => { location.hash = '#/campaigns/cp1/roster'; });
  await p.waitForTimeout(400);
  await p.click('#view .kb-card', { timeout: 4000 });
  await p.waitForTimeout(300);
  if (!await drawerOpen()) throw new Error('drawer did not open');
  if (await drawerLen() < 200) throw new Error('drawer body is empty');
});

await step('Escape closes the drawer', async () => {
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
  if (await drawerOpen()) throw new Error('drawer stayed open');
});

await step('creator drawer opens from the directory', async () => {
  await p.evaluate(() => { location.hash = '#/creators/all/directory'; });
  await p.waitForTimeout(400);
  await p.click('#view tbody tr');
  await p.waitForTimeout(300);
  if (!await drawerOpen() || await drawerLen() < 200) throw new Error('no creator drawer');
  await p.keyboard.press('Escape');
});

await step('new campaign form opens', async () => {
  await p.evaluate(() => { location.hash = '#/campaigns/all/active'; });
  await p.waitForTimeout(400);
  await p.evaluate(() => window.openNewCampaign());
  await p.waitForTimeout(300);
  if (!await p.$('#ecBrand, #ncBrand, .drawer.open input')) throw new Error('form fields missing');
  await p.keyboard.press('Escape');
});

await step('Excel import wizard opens', async () => {
  await p.evaluate(() => window.openImportWizard());
  await p.waitForTimeout(300);
  if (await drawerLen() < 200) throw new Error('wizard body empty');
  await p.keyboard.press('Escape');
});

await step('Notion import wizard opens', async () => {
  await p.evaluate(() => window.openNotionImportWizard());
  await p.waitForTimeout(300);
  if (await drawerLen() < 200) throw new Error('wizard body empty');
  await p.keyboard.press('Escape');
});

await step('toast shows', async () => {
  await p.evaluate(() => window.toast('hello from the check'));
  await p.waitForTimeout(200);
  const t = await p.$eval('#toast', (e) => e.textContent + '|' + e.classList.contains('show'));
  if (t !== 'hello from the check|true') throw new Error('toast said ' + t);
});

await step('panel filter narrows the campaign list', async () => {
  await p.evaluate(() => { location.hash = '#/campaigns/all/active'; });
  await p.waitForTimeout(300);
  const before = await p.$$eval('.panel-item', (n) => n.length);
  await p.fill('#panelQ', 'juno');
  await p.waitForTimeout(300);
  const after = await p.$$eval('.panel-item', (n) => n.length);
  if (!(after < before && after >= 1)) throw new Error(`${before} -> ${after}`);
  await p.fill('#panelQ', '');
});

await step('global search finds a creator', async () => {
  await p.fill('#globalSearch', 'creator1');
  await p.waitForTimeout(300);
  const n = await p.$$eval('.ac-list.open .ac-item', (x) => x.length);
  if (!n) throw new Error('no results');
  await p.fill('#globalSearch', '');
});

await step('theme toggles and sticks', async () => {
  const before = await p.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await p.click('.theme-btn');
  await p.waitForTimeout(200);
  const after = await p.evaluate(() => document.documentElement.getAttribute('data-theme'));
  if (before === after) throw new Error('theme did not change');
  const stored = await p.evaluate(() => localStorage.getItem('vively-theme'));
  if (stored !== after) throw new Error('not remembered');
  await p.click('.theme-btn');
});

await step('tab switching repaints the panel', async () => {
  await p.evaluate(() => { location.hash = '#/campaigns/cp1/roster'; });
  await p.waitForTimeout(350);
  const a = await p.$eval('#view', (e) => e.innerText);
  await p.evaluate(() => { location.hash = '#/campaigns/cp1/performance'; });
  await p.waitForTimeout(350);
  const c = await p.$eval('#view', (e) => e.innerText);
  if (a === c) throw new Error('panel did not change');
});

console.log('\nerrors:', errs.length ? '\n  ' + errs.join('\n  ') : 'none');
await b.close();
process.exit(errs.length ? 1 : 0);
