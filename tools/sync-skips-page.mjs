/* Two things a person asked for after using this on a live campaign.

   1. "One person is continuously being missed." The sync said "1 skipped"
      and nothing else — no row, no name, no reason. There are two causes
      behind that number and they need opposite fixes: a handle Notion
      holds in a form the parser cannot read, or a second submission from
      someone already on the roster.

   2. "Warn me when the dashboard and Notion disagree about a visit date."
      A time confirmed here is never touched by the sync; `visitAt` keeps
      whatever Notion still says. Moving a booking from this side makes
      them disagree, silently, forever.

   Driven through the real sync against the fake Notion, so these are the
   messages a person actually sees. */
import { chromium } from 'playwright';
import { signIn } from './harness-auth.mjs';
import fs from 'fs';

const seed = fs.readFileSync('tmp/seed.json', 'utf8');
const db = JSON.parse(seed).db;
const APP = process.argv[2] || 'http://localhost:3120/';
const NOTION = 'http://127.0.0.1:3466';
const errs = [];
const step = async (n, fn) => {
  try { await fn(); console.log('ok   ' + n); }
  catch (e) { console.log('FAIL ' + n + ' — ' + e.message); errs.push(n); }
};

const cp = db.campaigns.find((c) => c.notionDatabaseId && db.participants.some((p) => p.campaignId === c.id && p.notionPageId));
if (!cp) { console.log('FAIL no seeded campaign with a Notion form'); process.exit(1); }
const mine = db.participants.filter((p) => p.campaignId === cp.id && p.notionPageId);
const handleOf = (p) => String((db.creators.find((c) => c.id === p.creatorId) || {}).handle || '');

/* One clean row, one with an unreadable handle, and one duplicate of the
   first — the three outcomes, in one form. */
const rowFor = (p, over) => ({
  pageId: (over && over.pageId) || p.notionPageId,
  properties: Object.assign({
    'Instagram Link (URL)': 'https://instagram.com/' + handleOf(p).replace(/^@/, ''),
    'Full Name ': p.fullName || '',
    'Status': 'Confirmed',
    'Date & Time Availability ': p.visitAt || '',
    'Remark': '', 'Number of people visiting ': '', 'Notes': ''
  }, (over && over.properties) || {})
});

if (mine.length < 2) { console.log(`FAIL the seed gives ${cp.id} only ${mine.length} Notion-linked rows; 2 are needed`); process.exit(1); }

await fetch(NOTION + '/__reset', { method: 'POST' });
const form = {};
form[cp.notionDatabaseId] = [
  rowFor(mine[0]),
  rowFor(mine[1], { properties: { 'Instagram Link (URL)': '인스타 없음 — DM으로 연락주세요' } }),
  rowFor(mine[0], { pageId: 'page-duplicate-0001' })
];
{
  const r = await fetch(NOTION + '/__form', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form)
  });
  const out = await r.json().catch(() => ({}));
  console.log(`     fake notion: ${r.status} sources=${(out.sources || []).join(',') || '(none)'} rows=${form[cp.notionDatabaseId].length}`);
  if (!(out.sources || []).includes(cp.notionDatabaseId)) {
    console.log('FAIL the fake Notion did not accept the form'); process.exit(1);
  }
}

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext();
await signIn(ctx);
await ctx.addInitScript(([s]) => {
  localStorage.setItem('vively-workspace-v1', s);
  localStorage.setItem('vively-auth-user-v1', JSON.stringify({ email: 'k@v.com', name: 'K' }));
}, [seed]);
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

const toasts = [];
await p.exposeFunction('__sawToast', (t) => toasts.push(t));
await p.addInitScript(() => {
  const start = () => {
    const el = document.getElementById('toast');
    if (!el) return setTimeout(start, 50);
    let last = '';
    new MutationObserver(() => {
      const t = el.textContent.trim();
      if (t && t !== last) { last = t; window.__sawToast(t); }
    }).observe(el, { childList: true, characterData: true, subtree: true });
  };
  start();
});

await p.goto(APP + '#/campaigns/' + cp.id + '/roster', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1800);

/* Prove the app can read the fake form before blaming the sync for what
   it makes of it — a 404 here is the harness's own setup, not the
   product. */
{
  const probe = await p.evaluate(async (id) => {
    const r = await fetch('/api/notion/query?id=' + encodeURIComponent(id));
    const b = await r.json().catch(() => ({}));
    return { status: r.status, rows: (b.rows || []).length, error: b.error };
  }, cp.notionDatabaseId);
  console.log(`     notion form: ${probe.status} rows=${probe.rows}${probe.error ? ' error=' + probe.error : ''}`);
}

/* ---------------- the skipped submissions ---------------- */
await step('the sync runs and reports skipped rows', async () => {
  await p.click('#notionSync');
  await p.waitForTimeout(3000);
  if (!toasts.some((t) => /skipped/.test(t))) throw new Error('nothing mentioned a skip: ' + toasts.join(' | '));
});

await step('an unreadable handle is quoted back, not just counted', async () => {
  const said = toasts.join(' | ');
  if (!/could not read a handle/.test(said)) throw new Error(said);
  if (!/인스타 없음/.test(said)) throw new Error('did not show what was in the cell: ' + said);
});

await step('a duplicate submission names the creator it collides with', async () => {
  const said = toasts.join(' | ');
  if (!/already on this roster/.test(said)) throw new Error(said);
  if (!said.includes(handleOf(mine[0]))) throw new Error('did not name the handle: ' + said);
});

await step('the diagnostic lists every row, not just the first five', async () => {
  await p.click('#notionDiag');
  await p.waitForTimeout(3000);
  const text = await p.$eval('#drawerBody pre', (e) => e.textContent);
  if (!/ROWS THAT WILL NOT LAND: 2/.test(text)) throw new Error('no skip section: ' + text.slice(0, 300));
  if (!/WHAT THE SYNC MAKES OF EVERY ROW/.test(text)) throw new Error('still capped at five rows');
  for (const row of ['row 1:', 'row 2:', 'row 3:'])
    if (!text.includes(row)) throw new Error('missing ' + row);
  await p.click('#drawerClose');
  await p.waitForTimeout(400);
});

/* ---------------- the visit-date disagreement ---------------- */
await step('a booking moved here is marked on the board', async () => {
  const pid = mine[0].id;
  await p.evaluate((id) => {
    const row = DB.participants.find((x) => x.id === id);
    row.visitAt = '2026-09-12 18:00';
    row.confirmedVisitAt = '2026-09-12 19:30';
    render();
  }, pid);
  await p.waitForTimeout(700);
  const marks = await p.$$eval('.kb-card .vmis', (n) => n.length);
  if (!marks) throw new Error('no marker on any card');
});

await step('the marker says both times, so hovering answers the question', async () => {
  /* scoped to a card: the banner carries a decorative ! of its own, which
     has no tooltip because the sentence beside it already explains */
  const t = await p.$eval('.kb-card .vmis', (e) => e.getAttribute('title'));
  if (!/2026-09-12 18:00/.test(t) || !/2026-09-12 19:30/.test(t)) throw new Error(t);
  if (!/Notion/.test(t)) throw new Error(t);
});

await step('the roster says it in words too, above the board', async () => {
  const note = await p.$eval('.vmis-note', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  if (!/visit dates? differs? from Notion/.test(note)) throw new Error(note);
  if (!note.includes(handleOf(mine[0]))) throw new Error('did not name who: ' + note);
});

await step('the table view shows the visit and the same marker', async () => {
  await p.click('[data-m="table"]');
  await p.waitForTimeout(700);
  const heads = await p.$$eval('.tbl thead th', (n) => n.map((x) => x.textContent.trim()));
  if (!heads.includes('Visit')) throw new Error('no Visit column: ' + heads.join(', '));
  const marks = await p.$$eval('.tbl .vmis', (n) => n.length);
  if (!marks) throw new Error('no marker in the table');
  await p.click('[data-m="board"]');
  await p.waitForTimeout(500);
});

await step('a booking that matches Notion is not marked', async () => {
  await p.evaluate(() => {
    DB.participants.forEach((x) => { if (x.confirmedVisitAt) x.confirmedVisitAt = x.visitAt; });
    render();
  });
  await p.waitForTimeout(700);
  const marks = await p.$$eval('.vmis', (n) => n.length);
  if (marks) throw new Error(marks + ' markers left when everything agrees');
});

/* ---------------- the button that did nothing ---------------- */
await step('+ Add creators opens its drawer', async () => {
  /* it threw "Cannot access 'hiddenBlocked' before initialization" inside
     the click handler, so the button looked simply dead */
  const before = errs.length;
  await p.click('#addCreators');
  await p.waitForTimeout(800);
  if (!(await p.evaluate(() => document.querySelector('#drawer').classList.contains('open'))))
    throw new Error('the drawer did not open');
  if (!(await p.$('#acInput'))) throw new Error('the search box is not there');
  if (errs.length > before) throw new Error('it threw: ' + errs.slice(before).join(', '));
});

await b.close();
console.log('\nerrors: ' + (errs.length ? errs.join(' | ') : 'none'));
process.exit(errs.length ? 1 : 0);
