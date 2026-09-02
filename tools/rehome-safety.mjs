/* The question behind "I hope this does not interfere with other data":
   after a repair and a sync, is anything ELSE different? */
import { chromium } from 'playwright';
import fs from 'fs';
const seed = fs.readFileSync('tmp/seed.json', 'utf8');
const APP = process.argv[2] || 'http://localhost:3120/';
const GOOGLE = 'http://127.0.0.1:3455';

await fetch(GOOGLE + '/__reset', { method: 'POST' });
const gstate = async () => (await fetch(GOOGLE + '/__state')).json();

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

await p.goto(APP, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);

/* put the calendar in a known state first */
await p.evaluate(() => { location.hash = '#/campaigns/all/calendar'; });
await p.waitForTimeout(700);
await p.click('#gcSync');
await p.waitForTimeout(2600);
const before = await gstate();
const issuesBefore = await p.$$eval('#view .note', (n) => n.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
console.log(`     calendar before: ${before.count} events, ${issuesBefore.length} issue(s) already flagged`);
/* Without this the whole calendar half of the harness passes on nothing:
   start the server without GOOGLE_SERVICE_ACCOUNT and the sync quietly does
   no work, so "before" and "after" are both zero and the comparison holds
   for the wrong reason. Refuse to report a pass on an empty calendar. */
if (!before.count) {
  console.log('FAIL the calendar never got any events \u2014 this run proves nothing.');
  console.log('     start the server with GOOGLE_SERVICE_ACCOUNT, GOOGLE_CALENDAR_ID and');
  console.log('     GOOGLE_CALENDAR_API pointed at tools/fake-google.cjs, then run again.');
  await b.close();
  process.exit(1);
}

await step('the repair does not disturb the calendar', async () => {
  await p.evaluate(() => { location.hash = '#/campaigns/all/all'; });
  await p.waitForTimeout(600);
  await p.click('#dupFix');
  await p.waitForTimeout(1000);
  await p.evaluate(() => { location.hash = '#/campaigns/all/calendar'; });
  await p.waitForTimeout(700);
  await p.click('#gcSync');
  await p.waitForTimeout(2800);
  const after = await gstate();
  if (after.count !== before.count)
    throw new Error(`${before.count} events became ${after.count} — the repair duplicated bookings`);
  const beforeIds = before.ids.slice().sort().join(',');
  const afterIds = after.ids.slice().sort().join(',');
  if (beforeIds !== afterIds) throw new Error('the same bookings resolved to different events');
});

await step('the repair introduces no calendar issue that was not there before', async () => {
  /* the seed contains a deliberately unreadable date and a double booking,
     so what matters is that the list is no LONGER after the repair */
  const after = await p.$$eval('#view .note', (n) => n.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
  const added = after.filter((x) => !issuesBefore.includes(x));
  if (added.length) throw new Error('new issue(s): ' + added.join(' | ').slice(0, 160));
});

await step('every roster row still belongs to a campaign that exists', async () => {
  const orphans = await p.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('vively-workspace-v1'));
    const ids = new Set(raw.db.campaigns.map((c) => c.id));
    return raw.db.participants.filter((x) => !ids.has(x.campaignId)).length;
  });
  if (orphans) throw new Error(orphans + ' rows point at a campaign that no longer exists');
});

await step('creator records, payouts and content are all still intact', async () => {
  const out = await p.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('vively-workspace-v1'));
    return { creators: raw.db.creators.length,
             withContent: raw.db.participants.filter((x) => x.content && x.content.url).length,
             withVisit: raw.db.participants.filter((x) => x.visitAt).length,
             withPage: raw.db.participants.filter((x) => x.notionPageId).length };
  });
  const src = JSON.parse(seed).db;
  const want = { creators: src.creators.length,
                 withContent: src.participants.filter((x) => x.content && x.content.url).length,
                 withVisit: src.participants.filter((x) => x.visitAt).length,
                 withPage: src.participants.filter((x) => x.notionPageId).length };
  for (const k of Object.keys(want))
    if (out[k] !== want[k]) throw new Error(`${k}: ${want[k]} before, ${out[k]} after`);
  console.log(`     unchanged: ${want.creators} creators, ${want.withVisit} bookings, ${want.withContent} posts, ${want.withPage} Notion links`);
});

console.log('\nerrors:', errs.length ? '\n  ' + errs.join('\n  ') : 'none');
await b.close();
process.exit(errs.length ? 1 : 0);
