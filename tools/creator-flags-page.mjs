/* Two things, in a browser:

     1. A blacklisted or caution creator is impossible to miss — the mark
        follows the handle, the roster says so at the top, and the home
        page lists it as an alert.
     2. Creators can be imported from a file with any headers, in any
        order, mapped by hand, previewed, and applied — and an import
        never overwrites what is already here.

   The workspace is the usual seed with three creators flagged and put on
   the first campaign's roster. */

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'tmp/seed.json'), 'utf8'));

const errs = [];
const ok = (n, cond, extra) => {
  if (cond) console.log('ok   ' + n + (extra ? '   ' + extra : ''));
  else { console.log('FAIL ' + n + (extra ? '   ' + extra : '')); errs.push(n); }
};

/* ---- the workspace: one blacklisted and one caution creator on CP ---- */
const db = seed.db;
const CP = db.campaigns[0].id;
db.campaigns[0].status = 'live';
const onRoster = db.participants.filter((p) => p.campaignId === CP && p.stage !== 'dropped');
if (onRoster.length < 2) throw new Error('the seed campaign needs two roster rows');
const BLOCKED = db.creators.find((c) => c.id === onRoster[0].creatorId);
const CAUTION = db.creators.find((c) => c.id === onRoster[1].creatorId);
BLOCKED.flag = 'blocked'; BLOCKED.flagReason = 'took payment, never posted';
CAUTION.flag = 'caution'; CAUTION.flagReason = 'late twice';
/* one creator who exists with gaps, for the import to fill */
const GAPPY = db.creators.find((c) => c.id !== BLOCKED.id && c.id !== CAUTION.id);
GAPPY.followers = 23000; GAPPY.er = 2.2; GAPPY.country = ''; GAPPY.email = ''; GAPPY.categories = ['Beauty'];
const before = { followers: GAPPY.followers, er: GAPPY.er, name: GAPPY.name };
const creatorCount = db.creators.length;

/* ---- the file to import: odd headers, odd order, odd formatting ---- */
const CSV_PATH = path.join(os.tmpdir(), 'vively-import-check.csv');
fs.writeFileSync(CSV_PATH, [
  'Fee,Profile Handle,팔로워,Full Name,Engagement Rate,Country,Category,Blacklist,Reason',
  `"₩300,000",${GAPPY.handle},"99,000",Renamed Already,9.9,Vietnam,"K-Food",,`,
  '"₩150,000",https://www.instagram.com/import_one/,"45,300",Import One,0.051,Vietnam,"Beauty, Travel",,',
  '"",@import_two,1.2M,Import Two,3.4,Korea,Fashion,BLACKLIST,"chargeback"',
  '"",@import_two,"2,000",Repeat Row,1,Korea,,,',
  '"",,"5,000",No Handle,1,Korea,,,'
].join('\n'), 'utf8');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.get('/api/me', (q, r) => r.json({ user: { email: 'k@v.com', name: 'Harness' }, staff: true }));
let WS = { db, settings: {}, savedAt: new Date().toISOString(), revision: 1 };
let saved = null;
app.get('/api/workspace', (q, r) => r.json({ ok: true, data: WS }));
app.post('/api/workspace', (q, r) => {
  saved = q.body;
  WS = { ...WS, db: (q.body || {}).db || WS.db, revision: WS.revision + 1 };
  r.json({ ok: true, savedAt: new Date().toISOString(), revision: WS.revision });
});
app.use(express.static(ROOT));
app.get('*', (q, r) => r.sendFile(path.join(ROOT, 'index.html')));
const srv = app.listen(0);
await new Promise((r) => srv.once('listening', r));
const BASE = 'http://127.0.0.1:' + srv.address().port;

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
await ctx.addInitScript(() => localStorage.setItem('vively-auth-user-v1', JSON.stringify({ email: 'k@v.com', name: 'K' })));
const p = await ctx.newPage();
const pageErrors = [];
p.on('pageerror', (e) => pageErrors.push(e.message));
p.on('dialog', (d) => d.accept());
const go = async (hash) => { await p.goto(BASE + '/#/blank'); await p.goto(BASE + '/#/' + hash); await p.waitForTimeout(700); };
const viewText = async () => ((await p.textContent('#view')) || '').replace(/\s+/g, ' ');

/* ======================= 1. the flag is obvious ======================= */

await go('campaigns/' + CP + '/roster');
const roster = await viewText();
ok('the roster says a blacklisted creator is on it',
  roster.includes('blacklisted creator') && roster.includes(BLOCKED.handle), roster.slice(0, 120));
ok('and names the caution one too', roster.includes('caution') && roster.includes(CAUTION.handle));
ok('the reason is shown without opening anything', roster.includes('took payment, never posted'));
ok('the flagged creator carries a mark beside the handle on the board',
  (await p.$$('.flag-mark.blocked')).length >= 1 && (await p.$$('.flag-mark.caution')).length >= 1);
/* the seed has a blacklisted creator of its own, dropped from this
   campaign — so these count "at least", not "exactly" */
ok('their card is marked, not just the badge', (await p.$$('.kb-card.flagged-blocked')).length >= 1
  && (await p.$$('.kb-card.flagged-caution')).length === 1);

await p.click('#boardSeg button[data-m="table"]'); await p.waitForTimeout(600);
ok('the table marks the row as well', (await p.$$('tr.flagged-blocked')).length >= 1
  && (await p.$$('tr.flagged-caution')).length === 1);
ok('the mark is in the table too', (await p.$$('tr.flagged-blocked .flag-mark')).length >= 1);

ok('a name in the banner opens that creator\'s card', await (async () => {
  await p.click('[data-flagpid]'); await p.waitForTimeout(600);
  const d = ((await p.textContent('#drawer, .drawer')) || '').replace(/\s+/g, ' ');
  return d.includes('Blacklisted') && d.includes('should not be contacted');
})());
await p.keyboard.press('Escape');

await go('overview/attention');
const attention = await viewText();
ok('the Needs attention list raises it as an alert',
  /blacklisted creator/i.test(attention) && attention.includes(db.campaigns[0].brand), attention.slice(0, 160));
ok('and a separate one for caution', /marked caution/i.test(attention));
ok('the blacklist alert is one of the loudest', await (async () => {
  await go('overview/attention/critical');
  return /blacklisted creator/i.test(await viewText());
})());

await go('creators');
ok('the creators table still shows the flag', (await p.$$('.flag-mark')).length >= 2);

/* ======================= 2. importing a list ======================= */

ok('the creators page offers an import', await p.isVisible('#crImport'));
await p.click('#crImport');
await p.waitForSelector('#ciDrop', { timeout: 6000 });
ok('the import drawer explains that nothing is overwritten',
  ((await p.textContent('#drawer, .drawer')) || '').includes('only have their'));

await p.setInputFiles('#ciFile', CSV_PATH);
await p.waitForSelector('[data-cimap="handle"]', { timeout: 8000 });
const mapped = async (k) => p.inputValue(`[data-cimap="${k}"]`);
ok('the handle column is found under an odd header', (await mapped('handle')) === '1');
ok('a Korean follower header is understood', (await mapped('followers')) === '2');
ok('name, ER, country and category are matched',
  (await mapped('name')) === '3' && (await mapped('er')) === '4'
  && (await mapped('country')) === '5' && (await mapped('categories')) === '6');
ok('the flag column and its reason are matched', (await mapped('flag')) === '7' && (await mapped('flagReason')) === '8');
ok('the fee column is read as the rate', (await mapped('rate')) === '0');

const out = (await p.textContent('#ciOut')).replace(/\s+/g, ' ');
ok('the preview counts two new creators and one to fill', /New creators 2/.test(out) && /Filled in 1/.test(out), out.slice(0, 200));
ok('it reports the repeat and the row with no handle', /Skipped 2/.test(out));
ok('and shows what each row would do', out.includes('new creator') && out.includes('empty field'));

/* a mapping can be corrected by hand, and the preview follows */
await p.selectOption('[data-cimap="followers"]', '');
await p.waitForTimeout(400);
ok('un-mapping a column changes what would be filled',
  !(await p.textContent('#ciOut')).includes('followers →'));
await p.selectOption('[data-cimap="followers"]', '2');
await p.waitForTimeout(400);

await p.click('#ciGo');
await p.waitForTimeout(2500);
const after = await p.evaluate(() => DB.creators.map((c) => ({
  handle: c.handle, name: c.name, followers: c.followers, er: c.er, country: c.country,
  categories: c.categories, flag: c.flag, flagReason: c.flagReason, rate: c.rate, tier: c.tier,
  metricsSource: c.metricsSource, source: c.source
})));
const find = (h) => after.find((c) => c.handle.toLowerCase() === h.toLowerCase());

ok('two creators were added', after.length === creatorCount + 2, after.length + ' vs ' + creatorCount);
const one = find('@import_one');
ok('a profile link became a handle', !!one);
ok('its numbers were read through the formatting', one && one.followers === 45300 && one.er === 5.1, one && one.followers + '/' + one.er);
ok('the rate came through the ₩ and the commas', one && one.rate === 150000);
ok('its categories were split', one && one.categories.join() === 'Beauty,Travel');
const two = find('@import_two');
ok('a creator can arrive blacklisted, with the reason',
  two && two.flag === 'blocked' && two.flagReason === 'chargeback');
ok('1.2M is a million two hundred thousand', two && two.followers === 1200000 && two.tier === 'macro');

const gappy = find(GAPPY.handle);
ok('an existing creator kept the figures it already had',
  gappy.followers === before.followers && gappy.er === before.er && gappy.name === before.name,
  JSON.stringify({ f: gappy.followers, e: gappy.er, n: gappy.name }));
ok('and had its empty fields filled', gappy.country === 'Vietnam');
ok('a new category was added beside the old one', gappy.categories.join() === 'Beauty,K-Food');
ok('the repeat row did not become a second creator',
  after.filter((c) => c.handle.toLowerCase() === '@import_two').length === 1);

await p.waitForTimeout(1500);
ok('the import was saved to the workspace', !!saved && (saved.db.creators || []).length === creatorCount + 2,
  saved ? (saved.db.creators || []).length + ' saved' : 'no save');
ok('the new blacklisted creator is marked on the creators page',
  (await viewText()).includes('import_two') && (await p.$$('.flag-mark.blocked')).length >= 1);

/* ============== the parcel, on a seeding campaign ==============

   A seeding campaign's equivalent of a booking. The stage already said
   "Shipped"; what nobody could answer was which courier, what number,
   and whether it arrived. */

const SEED_CP = await p.evaluate(() => {
  const cp = DB.campaigns.find((c) => !/visit/i.test(String(c.kind || '')));
  if (!cp) return null;
  const part = DB.participants.find((x) => x.campaignId === cp.id
    && STAGE_IDX[x.stage] >= STAGE_IDX.confirmed && x.stage !== 'dropped');
  return part ? { cp: cp.id, kind: cp.kind, pid: part.id } : { cp: cp.id, kind: cp.kind, pid: null };
});
ok('the seed has a campaign that ships product', !!SEED_CP && !!SEED_CP.pid, JSON.stringify(SEED_CP));

await go('campaigns/' + SEED_CP.cp + '/roster');
ok('the roster header counts the parcels, not just the people',
  (await viewText()).includes('product:'), (await viewText()).slice(0, 140));

await p.evaluate((pid) => showParticipant(pid), SEED_CP.pid);
await p.waitForSelector('#drawer.open', { timeout: 5000 });
ok('a confirmed row has somewhere to put the courier and the number',
  await p.isVisible('#pdCarrier') && await p.isVisible('#pdTracking')
  && await p.isVisible('#pdShippedAt') && await p.isVisible('#pdDeliveredAt'));
ok('and says plainly that nothing has gone out yet',
  (await p.textContent('#drawer')).includes('Not sent'));

await p.fill('#pdCarrier', 'CJ대한통운');
await p.fill('#pdTracking', '1234567890');
await p.fill('#pdShippedAt', '2026-10-21');
await p.click('#pdSave');
await p.waitForTimeout(900);
ok('the tracking number is kept on the row', await p.evaluate((pid) => {
  const row = DB.participants.find((x) => x.id === pid);
  return !!row && row.shipment && row.shipment.carrier === 'CJ대한통운'
    && row.shipment.tracking === '1234567890' && row.shippedAt === '2026-10-21';
}, SEED_CP.pid));
ok('and sending it moves the row to Shipped on its own', await p.evaluate((pid) => {
  const row = DB.participants.find((x) => x.id === pid);
  return !!row && STAGE_IDX[row.stage] >= STAGE_IDX.shipped;
}, SEED_CP.pid));
/* both ways of looking at the roster have to say it */
await p.click('#boardSeg button[data-m="board"]');
await p.waitForTimeout(500);
ok('the board card shows where the parcel is, with the courier and number',
  (await viewText()).includes('Sent 2026-10-21 · CJ대한통운 1234567890'), (await viewText()).slice(-260));
await p.click('#boardSeg button[data-m="table"]');
await p.waitForTimeout(500);
ok('and the table has a Product column saying the same thing',
  (await viewText()).includes('Product') && (await viewText()).includes('Sent'));
await p.click('#boardSeg button[data-m="board"]');
await p.waitForTimeout(400);

/* it arrives */
await p.evaluate((pid) => showParticipant(pid), SEED_CP.pid);
await p.waitForSelector('#pdDeliveredAt', { timeout: 5000 });
await p.fill('#pdDeliveredAt', '2026-10-24');
await p.click('#pdSave');
await p.waitForTimeout(900);
ok('an arrival date is kept too', await p.evaluate((pid) =>
  (DB.participants.find((x) => x.id === pid) || {}).shipment.deliveredAt === '2026-10-24', SEED_CP.pid));
await p.click('#boardSeg button[data-m="board"]');
await p.waitForTimeout(500);
ok('and the roster says Delivered rather than Sent',
  (await viewText()).includes('Delivered 2026-10-24'), (await viewText()).slice(-200));

/* a visit campaign has no parcel to track */
const VISIT_CP = await p.evaluate(() => {
  const cp = DB.campaigns.find((c) => /visit/i.test(String(c.kind || '')));
  const part = cp && DB.participants.find((x) => x.campaignId === cp.id
    && STAGE_IDX[x.stage] >= STAGE_IDX.confirmed && x.stage !== 'dropped');
  return cp && part ? { cp: cp.id, pid: part.id } : null;
});
if (VISIT_CP) {
  await go('campaigns/' + VISIT_CP.cp + '/roster');
  ok('a visit campaign is not asked about parcels', !(await viewText()).includes('product:'));
  await p.evaluate((pid) => showParticipant(pid), VISIT_CP.pid);
  await p.waitForSelector('#drawer.open', { timeout: 5000 });
  ok('and its drawer offers no courier field', !(await p.$('#pdCarrier')));
  await p.evaluate(() => closeDrawer());
  await p.waitForTimeout(300);
}

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
await b.close(); srv.close();
console.log(errs.length ? '\n' + errs.length + ' FAILED' : '\nall creator flag and import checks passed');
process.exit(errs.length ? 1 : 0);
