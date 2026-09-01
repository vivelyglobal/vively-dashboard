/* Moves a creator between stages in the real UI and checks what Notion was
   actually asked to store. */
import { chromium } from 'playwright';
import fs from 'fs';
const seed = fs.readFileSync('tmp/seed.json', 'utf8');
const APP = process.argv[2] || 'http://localhost:3120/';
const FAKE = 'http://127.0.0.1:3466';
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
/* 503 is /api/workspace with no database in this harness; 502 is the
   deliberately-invalid value the last step provokes */
p.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (/favicon|fonts\.g|ERR_TUNNEL|status of (503|502)/.test(m.text())) return;
  errs.push('CONSOLE: ' + m.text());
});
const step = async (n, fn) => { try { await fn(); console.log('ok   ' + n); } catch (e) { console.log('FAIL ' + n + ' — ' + e.message); errs.push(n); } };

await p.goto(APP, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);

/* Driven through the roster's own stage dropdown rather than by calling
   internals, so this exercises the same path a person does — and works
   against the React build, where nothing is on window. */
const campaignId = JSON.parse(seed).db.campaigns.find((c) => c.partner === 'SPLABAB').id;
const rows = JSON.parse(seed).db.participants.filter((x) => x.campaignId === campaignId);
const pidOf = async (n) => rows[n].id;

async function openRoster() {
  await p.evaluate((id) => { location.hash = `#/campaigns/${id}/roster`; }, campaignId);
  await p.waitForTimeout(500);
  if (!await p.$('.stageSel')) {     /* the board is the default view; the dropdowns live on the table */
    const toggle = await p.$('[data-m="table"]');
    if (toggle) { await toggle.click(); await p.waitForTimeout(500); }
  }
}

const move = async (pid, stage) => {
  await openRoster();
  const sel = await p.$(`select.stageSel[data-pid="${pid}"]`);
  if (!sel) throw new Error('no stage dropdown for ' + pid);
  await sel.selectOption(stage);
  await p.waitForTimeout(900);
};

/* the cases that need particular starting state are arranged in the seed,
   so nothing here has to reach into the app to set one up */
const pidWhere = (fn) => { const r = rows.find(fn); if (!r) throw new Error('no seeded row matches'); return r.id; };

await step('a stage with a Notion equivalent is written', async () => {
  const pid = await pidOf(0);
  await move(pid, 'confirmed');
  const s = await state();
  const w = s.writes.filter((x) => x.shape.status);
  if (!w.length) throw new Error('nothing was written');
  if (w[w.length - 1].shape.status.name !== 'Confirmed') throw new Error(JSON.stringify(w[w.length - 1]));
});

await step('it writes to the property the mapping names', async () => {
  const s = await state();
  const last = s.writes[s.writes.length - 1];
  if (last.name !== 'Status') throw new Error('wrote to ' + last.name);
});

await step('a stage Notion has no word for writes nothing', async () => {
  const before = (await state()).writes.length;
  const pid = await pidOf(1);
  await move(pid, 'contacted');
  const after = (await state()).writes.length;
  if (after !== before) throw new Error('it sent something for Contacted');
});

await step('and says so rather than failing silently', async () => {
  const t = await p.$eval('#toast', (e) => e.textContent);
  if (!/no status for that/i.test(t)) throw new Error('toast said: ' + t);
});

await step('a drop writes the reason Notion understands', async () => {
  const pid = pidWhere((r) => r.dropReason === 'Brand rejected');
  await move(pid, 'dropped');
  const s = await state();
  const last = s.writes[s.writes.length - 1];
  if (last.shape.status.name !== 'Brand Rejected') throw new Error(JSON.stringify(last.shape));
});

await step('a row already saying the same thing is not rewritten', async () => {
  /* seeded as Brand Accepted, which reads as Confirmed here — writing
     "Confirmed" over it would flatten the more specific word */
  const pid = pidWhere((r) => r.importedStatus === 'Brand Accepted');
  const before = (await state()).writes.length;
  await move(pid, 'confirmed');
  const after = (await state()).writes.length;
  if (after !== before) throw new Error('it flattened Brand Accepted to Confirmed');
});

await step('turning the switch off stops the writing', async () => {
  await p.evaluate(() => { location.hash = '#/settings/notion'; });
  await p.waitForTimeout(500);
  await p.uncheck('#wbOn');
  await p.waitForTimeout(300);
  const before = (await state()).writes.length;
  await move(pidWhere((r) => r.importedStatus === ''), 'confirmed');
  if ((await state()).writes.length !== before) throw new Error('it wrote anyway');
  await p.evaluate(() => { location.hash = '#/settings/notion'; });
  await p.waitForTimeout(500);
  await p.check('#wbOn');
  await p.waitForTimeout(300);
});

await step('a value Notion rejects is reported, not swallowed', async () => {
  /* the stub refuses anything outside the real option list, so a campaign
     whose Status column is mapped to a property that does not exist is the
     honest way to provoke a rejection */
  await fetch(FAKE + '/__reset', { method: 'POST' });
  const res = await fetch(APP.replace(/\/(next\/)?$/, '') + '/api/notion/status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageId: rows[0].notionPageId, property: 'Status', value: 'Not A Real Option' })
  });
  if (res.ok) throw new Error('the server accepted a value Notion would refuse');
  const body = await res.json();
  if (!/not a valid option/i.test(body.error || '')) throw new Error('unhelpful error: ' + body.error);
});

console.log('\nwrites Notion received:',
  (await state()).writes.filter((w) => w.shape.status).map((w) => w.shape.status.name).join(', '));
console.log('errors:', errs.length ? '\n  ' + errs.join('\n  ') : 'none');
await b.close();
process.exit(errs.length ? 1 : 0);
