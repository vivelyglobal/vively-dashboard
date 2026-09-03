/* The two things asked for, driven through the real UI rather than by
   poking globals: setting a confirmed visit time by hand, and moving a
   creator to another campaign. Both have to survive a Notion sync, which
   is the whole point — so the sync runs afterwards and the values are
   read back from what the page actually stored. */
import { chromium } from 'playwright';
import fs from 'fs';
const seed = fs.readFileSync('tmp/seed.json', 'utf8');
const APP = process.argv[2] || 'http://localhost:3120/';
const GOOGLE = 'http://127.0.0.1:3455';

const NOTION = 'http://127.0.0.1:3466';
await fetch(GOOGLE + '/__reset', { method: 'POST' });
await fetch(NOTION + '/__reset', { method: 'POST' });
const gstate = async () => (await fetch(GOOGLE + '/__state')).json();

/* Stand the Notion form up from the same seed the page loads, so a sync is
   a real sync. Every roster row that carries a page id becomes a row on its
   own campaign's form — which is exactly what decides where the sync thinks
   that row belongs, and therefore the only way to prove a pin holds. */
{
  const db = JSON.parse(seed).db;
  const form = {};
  db.campaigns.forEach((c) => { if (c.notionDatabaseId) form[c.notionDatabaseId] = form[c.notionDatabaseId] || []; });
  db.participants.forEach((x) => {
    const cp = db.campaigns.find((c) => c.id === x.campaignId);
    if (!x.notionPageId || !cp || !cp.notionDatabaseId) return;
    (form[cp.notionDatabaseId] = form[cp.notionDatabaseId] || []).push({
      pageId: x.notionPageId,
      properties: {
        'Instagram Link (URL)': 'https://instagram.com/' +
          String((db.creators.find((c) => c.id === x.creatorId) || {}).handle || '').replace(/^@/, ''),
        'Full Name ': x.fullName || '',
        'Status': 'Confirmed',
        'Date & Time Availability ': x.visitAt || '',
        'Remark': x.remark || '',
        'Number of people visiting ': x.headcount || '',
        'Notes': x.formNotes || ''
      }
    });
  });
  const r = await fetch(NOTION + '/__form', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form)
  });
  const out = await r.json();
  console.log(`     notion form: ${out.sources.join(', ')} — ` +
    Object.entries(form).map(([k, v]) => `${k}:${v.length}`).join(' '));
}

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext();
await ctx.addInitScript(([s]) => {
  localStorage.setItem('vively-workspace-v1', s);
  localStorage.setItem('vively-auth-user-v1', JSON.stringify({ email: 'k@v.com', name: 'K' }));
}, [seed]);
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('dialog', (d) => d.accept());
const step = async (n, fn) => { try { await fn(); console.log('ok   ' + n); } catch (e) { console.log('FAIL ' + n + ' — ' + e.message); errs.push(n); } };

const store = () => p.evaluate(() => JSON.parse(localStorage.getItem('vively-workspace-v1')).db);
const rowById = async (id) => (await store()).participants.find((x) => x.id === id);

await p.goto(APP, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);

/* Pick a row that came from Notion and already has a requested slot, so
   the confirmed value has something real to override. */
const db0 = await store();
/* and nothing confirmed yet — the seed now ships one row already
   rescheduled, for the partner-page harness, and this one needs a
   blank field to type into */
const target = db0.participants.find((x) =>
  x.visitAt && x.notionPageId && x.stage !== 'dropped' && !x.confirmedVisitAt);
if (!target) { console.log('the seed has no Notion row with a visit slot — nothing to test'); await b.close(); process.exit(1); }
/* Not one of the deliberately-clashing pair — the seed carries two
   campaigns on one id on purpose, and moving a row onto a contested id
   would be testing the collision rather than the move. */
const idCount = {};
db0.campaigns.forEach((c) => { idCount[c.id] = (idCount[c.id] || 0) + 1; });
const otherCampaign = db0.campaigns.find((c) => c.id !== target.campaignId && idCount[c.id] === 1);
if (!otherCampaign) { console.log('no uncontested campaign to move into'); await b.close(); process.exit(1); }
console.log(`     row ${target.id}: asked for ${target.visitAt}, in ${target.campaignId}`);

const openRow = async () => {
  await p.evaluate((t) => { location.hash = `#/campaigns/${t.campaignId}/roster`; }, target);
  await p.waitForTimeout(700);
  await p.evaluate((id) => { window.showParticipant(id); }, target.id);
  await p.waitForTimeout(500);
};

await step('the drawer offers a confirmed date and time, prefilled empty', async () => {
  await openRow();
  for (const id of ['#pdVisitDate', '#pdVisitTime', '#pdCampaign'])
    if (!await p.$(id)) throw new Error('missing ' + id);
  if (await p.$eval('#pdVisitDate', (e) => e.value) !== '')
    throw new Error('a row with nothing confirmed should start blank, not pre-filled with the request');
});

await step('it shows what the creator asked for beside the empty field', async () => {
  const t = await p.$eval('.drawer', (e) => e.innerText);
  if (!t.includes(target.visitAt)) throw new Error('the requested slot is not shown');
});

await step('a confirmed time typed by hand is stored, and the request is kept', async () => {
  await p.fill('#pdVisitDate', '2027-03-09');
  await p.fill('#pdVisitTime', '18:45');
  await p.click('#pdSave');
  await p.waitForTimeout(700);
  const row = await rowById(target.id);
  if (row.confirmedVisitAt !== '2027-03-09 18:45')
    throw new Error('stored ' + JSON.stringify(row.confirmedVisitAt));
  if (row.visitAt !== target.visitAt)
    throw new Error('the original request was overwritten: ' + row.visitAt);
});

await step('the roster card shows the confirmed slot, not the requested one', async () => {
  await p.evaluate((t) => { location.hash = `#/campaigns/${t.campaignId}/roster`; }, target);
  await p.waitForTimeout(800);
  const t = await p.$eval('#view', (e) => e.innerText);
  if (!t.includes('2027-03-09 18:45'))
    throw new Error('the confirmed slot is not on the card');
  if (t.includes(target.visitAt))
    throw new Error('the card still shows the old requested slot — two dates on screen for one booking');
});

await step('Google gets the confirmed time, not the requested one', async () => {
  await p.evaluate(() => { location.hash = '#/campaigns/all/calendar'; });
  await p.waitForTimeout(600);
  await p.click('#gcSync');
  await p.waitForTimeout(2800);
  const st = await gstate();
  const ev = st.events.find((e) => (e.extendedProperties?.private?.vivelyParticipantId) === target.id);
  if (!ev) throw new Error('no event for this booking');
  const start = ev.start?.dateTime || ev.start?.date || '';
  if (!start.startsWith('2027-03-09')) throw new Error('event starts ' + start);
  if (!/18:45/.test(start)) throw new Error('event is not at the confirmed time: ' + start);
});

await step('a Notion sync does not erase the confirmed time', async () => {
  await p.evaluate((t) => { location.hash = `#/campaigns/${t.campaignId}/roster`; }, target);
  await p.waitForTimeout(600);
  await p.click('#notionSync');
  await p.waitForTimeout(2600);
  /* A sync that matched nothing would leave the value alone too, and this
     test would pass for the wrong reason — as it did until the fixture
     gained a column identifying the creator. Insist it did real work. */
  const said = (await p.$$eval('.toast, [class*=toast]', (n) => n.map((x) => x.innerText))).join(' ');
  if (/0 new, 0 updated/.test(said) || /\d+ skipped/.test(said.replace(/, 0 skipped/, '')))
    throw new Error('the sync did no work, so this proves nothing: ' + said);
  const row = await rowById(target.id);
  if (row.confirmedVisitAt !== '2027-03-09 18:45')
    throw new Error('the sync wiped it — got ' + JSON.stringify(row.confirmedVisitAt));
});

/* ---- moving a creator to another campaign ------------------------------ */

await step('the drawer can move the row to another campaign', async () => {
  await openRow();
  await p.selectOption('#pdCampaign', otherCampaign.id);
  await p.click('#pdSave');
  await p.waitForTimeout(700);
  const row = await rowById(target.id);
  if (row.campaignId !== otherCampaign.id) throw new Error('still in ' + row.campaignId);
});

await step('moving pins it, and the row keeps its own id', async () => {
  const row = await rowById(target.id);
  if (!row.pinnedCampaign) throw new Error('the move was not pinned, so a sync will undo it');
  if (row.id !== target.id) throw new Error('the row id changed — calendar events and comments are keyed on it');
});

await step('a sync of the campaign it came from leaves it where you put it', async () => {
  await p.evaluate((id) => { location.hash = `#/campaigns/${id}/roster`; }, target.campaignId);
  await p.waitForTimeout(600);
  await p.click('#notionSync');
  await p.waitForTimeout(2800);
  const row = await rowById(target.id);
  if (row.campaignId !== otherCampaign.id)
    throw new Error('the sync pulled it back to ' + row.campaignId + ' — the pin did not hold');
});

await step('the moved row appears in the new campaign and not the old one', async () => {
  const db = await store();
  const inNew = db.participants.filter((x) => x.campaignId === otherCampaign.id && x.id === target.id).length;
  const inOld = db.participants.filter((x) => x.campaignId === target.campaignId && x.id === target.id).length;
  if (inNew !== 1 || inOld !== 0) throw new Error(`new=${inNew} old=${inOld} — a move must not leave a copy behind`);
});

await step('unpinning hands the row back to Notion', async () => {
  await p.evaluate((t) => { location.hash = `#/campaigns/${t}/roster`; }, otherCampaign.id);
  await p.waitForTimeout(700);
  await p.evaluate((id) => { window.showParticipant(id); }, target.id);
  await p.waitForTimeout(500);
  if (!await p.$('#pdUnpin')) throw new Error('no way to undo the pin');
  await p.click('#pdUnpin');
  await p.waitForTimeout(600);
  const row = await rowById(target.id);
  if (row.pinnedCampaign) throw new Error('still pinned');
  await p.evaluate((id) => { location.hash = `#/campaigns/${id}/roster`; }, target.campaignId);
  await p.waitForTimeout(600);
  await p.click('#notionSync');
  await p.waitForTimeout(2800);
  const back = await rowById(target.id);
  if (back.campaignId !== target.campaignId)
    throw new Error('unpinned but the sync did not take it back: ' + back.campaignId);
});

await step('no calendar event was duplicated by any of this', async () => {
  await p.evaluate(() => { location.hash = '#/campaigns/all/calendar'; });
  await p.waitForTimeout(600);
  await p.click('#gcSync');
  await p.waitForTimeout(2800);
  const st = await gstate();
  const mine = st.events.filter((e) => (e.extendedProperties?.private?.vivelyParticipantId) === target.id);
  if (mine.length !== 1) throw new Error(mine.length + ' events for one booking');
});

console.log('\nerrors: ' + (errs.length ? errs.join(' | ') : 'none'));
await b.close();
process.exit(errs.length ? 1 : 0);
