/* THE DESK, driven through the real page.

   Three restaurants are running at once and one person is answering
   "what is happening today". The unit tests cover the judgements; this
   covers the thing they stand in front of: two venues side by side, the
   same creator booked at both, a move that sticks, a daily limit that
   has to be overruled out loud, and an undo.

   Real index.html, real booking routes, tools/fake-booking-db.mjs
   underneath. The workspace is the shared seed, with one row added so a
   creator genuinely appears on two campaigns — the case the desk exists
   for, and one the seed does not happen to contain. */

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { col, fakeClient } from './fake-booking-db.mjs';

const require = createRequire(import.meta.url);
const routes = require('../server/booking-routes.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const errs = [];
const ok = (n, cond, extra) => {
  if (cond) console.log('ok   ' + n + (extra ? '   ' + extra : ''));
  else { console.log('FAIL ' + n + (extra ? '   ' + extra : '')); errs.push(n); }
};

/* ---- a workspace where one creator is on two campaigns ---------------- */

const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'tmp/seed.json'), 'utf8'));
const db = base.db;
const CP_A = db.campaigns[0].id;
const CP_B = (db.campaigns.find((c) => c.id !== CP_A) || {}).id;
if (!CP_B) { console.log('FAIL the seed has only one campaign'); process.exit(1); }

const partA = db.participants.find((p) => p.campaignId === CP_A && p.creatorId);
const CRE = partA.creatorId;
const HANDLE = (db.creators.find((c) => c.id === CRE) || {}).handle || '';
/* the same human, a second restaurant */
const twin = { ...partA, id: 'pt_desk_twin', campaignId: CP_B, stage: partA.stage };
delete twin.confirmedVisitAt; delete twin.bookingId;
db.participants.push(twin);
/* and a second person, so the grid has somebody who is not in trouble */
const partC = db.participants.find((p) => p.campaignId === CP_A && p.creatorId && p.creatorId !== CRE);
const seed = JSON.stringify(base);

const app = express();
app.use(express.json({ limit: '10mb' }));
routes.mountBookingRoutes(app, {
  getMongoClient: async () => fakeClient,
  MONGODB_DB: 'test', MONGODB_URI: 'mongodb://fake',
  loadWorkspaceDoc: async () => ({ db: {} }),
  requireStaff: (h) => h
});
app.get('/api/me', (req, res) => res.json({ user: { email: 'k@v.com', name: 'Harness' }, staff: true }));
let WORKSPACE = { db, settings: base.settings || {}, revision: 1 };
app.get('/api/workspace', (req, res) => res.json({ ok: true, data: WORKSPACE }));
app.post('/api/workspace', (req, res) => {
  WORKSPACE = { db: (req.body || {}).db || WORKSPACE.db,
                settings: (req.body || {}).settings || {}, revision: WORKSPACE.revision + 1 };
  res.json({ ok: true, savedAt: new Date().toISOString(), revision: WORKSPACE.revision });
});
app.use(express.static(ROOT));
app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));

const srv = app.listen(0);
await new Promise((r) => srv.once('listening', r));
const BASE = 'http://127.0.0.1:' + srv.address().port;

const call = async (p, body, method) => {
  const res = await fetch(BASE + p, body || method
    ? { method: method || 'POST', headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined }
    : {});
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/* ---- two venues, two days, three bookings ----------------------------- */

/* Korea's today, the same clock the page uses. A window that starts
   today is the window a person opens the desk on. */
const kst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const plus = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const D1 = plus(kst(), 2);
const D2 = plus(kst(), 3);

const schA = (await call('/api/booking/schedule', {
  campaignId: CP_A, venueName: 'Hangang Cool Rain', timezone: 'Asia/Seoul', slotMinutes: 90, maxPartySize: 2
})).body.schedule;
const schB = (await call('/api/booking/schedule', {
  campaignId: CP_B, venueName: 'Mapo Galbi', timezone: 'Asia/Seoul', slotMinutes: 90, maxPartySize: 2
})).body.schedule;

const slot = async (sch, date, time, capacity) =>
  (await call('/api/booking/slot', { scheduleId: sch._id, date, time, capacity })).body.slot;

const a1 = await slot(schA, D1, '18:00', 2);
const a2 = await slot(schA, D1, '20:00', 2);
const a3 = await slot(schA, D2, '18:00', 2);
const b1 = await slot(schB, D1, '19:00', 2);

const invite = async (cp, p) => (await call('/api/booking/invite', {
  campaignId: cp, participantId: p.id, creatorId: p.creatorId,
  name: p.fullName || 'Creator', handle: (db.creators.find((c) => c.id === p.creatorId) || {}).handle || '@x'
})).body.invite;

const invA = await invite(CP_A, partA);
const invB = await invite(CP_B, twin);
const invC = partC ? await invite(CP_A, partC) : null;

await call('/api/book/' + invA._id + '/confirm', { slotId: a1._id });
await call('/api/book/' + invB._id + '/confirm', { slotId: b1._id });
if (invC) await call('/api/book/' + invC._id + '/confirm', { slotId: a2._id });
/* one link that goes out and is never used — the chase list */
await call('/api/booking/invite', { campaignId: CP_A, participantId: 'pt_never', creatorId: 'cr_never',
  name: 'Never Booked', handle: '@neverbooked' });

/* ---- the page --------------------------------------------------------- */

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1600, height: 1100 } });
await ctx.addInitScript(([s]) => {
  localStorage.setItem('vively-workspace-v1', s);
  localStorage.setItem('vively-auth-user-v1', JSON.stringify({ email: 'k@v.com', name: 'K' }));
}, [seed]);
const p = await ctx.newPage();
const pageErrors = [];
p.on('pageerror', (e) => pageErrors.push(e.message));
let lastDialog = '';
p.on('dialog', async (d) => { lastDialog = d.message(); await d.accept(); });

const go = async (hash) => {
  await p.goto(BASE + '/#/blank');
  await p.goto(BASE + '/#/' + hash);
  await p.waitForTimeout(500);
};
const onDay = async (d) => {
  await p.evaluate((x) => { DESK.day = x; render(); }, d);
  await p.waitForTimeout(250);
};

await go('desk');
await p.waitForSelector('.dk-band', { timeout: 10000 });

ok('the Desk is a section of its own in the rail',
  (await p.$$eval('#rail a', (a) => a.map((x) => x.textContent.trim()))).some((t) => /Desk/.test(t)));
ok('and it reads every campaign, not one', await p.evaluate(() => (DESK.data.schedules || []).length >= 2),
  await p.evaluate(() => String((DESK.data.schedules || []).length)));
ok('it lands on the Korean today', await p.evaluate((d) => DESK.from === d, kst()),
  await p.evaluate(() => DESK.from));

await onDay(D1);
ok('the day everyone is booked on shows all three visits',
  await p.evaluate(() => deskBookingsOn(DESK.day).length) === (invC ? 3 : 2));
ok('the venue grid has a column per venue',
  (await p.$$('.dk-head .v')).length >= 2,
  (await p.$$eval('.dk-head .v', (e) => e.map((x) => x.textContent))).join(' · '));
ok('and the venue name the campaign gave is the column heading',
  (await p.textContent('#view')).includes('Hangang Cool Rain')
  && (await p.textContent('#view')).includes('Mapo Galbi'));

/* ---- the thing it was built for --------------------------------------- */

const queue = async () => p.evaluate(() => deskClashes(DESK.day).map((c) => c.kind + ':' + c.text));
ok('the same creator at two restaurants in one night is on the queue',
  (await queue()).some((t) => /^double:/.test(t)), (await queue()).join(' | '));
ok('and the page says so in words, not just in the data',
  (await p.textContent('#view')).includes('booked twice'));
ok('an hour apart counts as urgent',
  await p.evaluate(() => deskClashes(DESK.day).some((c) => c.kind === 'double' && c.bad)));
ok('links that went out and were never used are chased across the window',
  (await p.textContent('#view')).includes('never used'));

/* ---- moving somebody, from here --------------------------------------- */

const bkA = await col('campaign_bookings').findOne({ participantId: partA.id });
ok('the booking the roster row points at is the one on the desk',
  await p.evaluate((id) => !!deskBooking(id), bkA._id));

await p.click(`[data-dkmove="${bkA._id}"]`);
await p.waitForSelector('[data-dkto]', { timeout: 8000 });
ok('Move offers this venue\'s own times, and no other venue\'s',
  await p.evaluate((ids) => [...document.querySelectorAll('[data-dkto]')]
    .every((el) => ids.includes(el.dataset.dkto)), [a1._id, a2._id, a3._id]));
await p.click(`[data-dkto="${a2._id}"]`);
await p.waitForTimeout(1200);

ok('the move landed on the server, not just on screen', await (async () => {
  const again = await col('campaign_bookings').findOne({ _id: bkA._id });
  return again.slotId === a2._id && again.time === '20:00';
})());
ok('and the desk redrew on the new time',
  await p.evaluate((id) => (deskBooking(id) || {}).time, bkA._id) === '20:00');
ok('the roster row followed it without a reload', await p.evaluate((id) => {
  const row = DB.participants.find((x) => x.id === id);
  return !!row && /20:00/.test(String(row.confirmedVisitAt || ''));
}, partA.id), await p.evaluate((id) => String((DB.participants.find((x) => x.id === id) || {}).confirmedVisitAt), partA.id));

ok('and an undo is offered', await p.isVisible('#dkUndo'));
await p.click('#dkUndo');
await p.waitForTimeout(1200);
ok('which puts the booking back where it was', await (async () => {
  const again = await col('campaign_bookings').findOne({ _id: bkA._id });
  return again.slotId === a1._id && again.time === '18:00';
})());

/* ---- a limit that has to be overruled out loud ------------------------- */

await call('/api/booking/schedule', { campaignId: CP_A, venueName: 'Hangang Cool Rain',
  timezone: 'Asia/Seoul', maxPerDay: 1, maxPartySize: 2 });
await call('/api/book/' + (await call('/api/booking/invite', { campaignId: CP_A,
  participantId: 'pt_capfill', creatorId: 'cr_capfill', name: 'Cap Fill', handle: '@capfill' })).body.invite._id
  + '/confirm', { slotId: a3._id });
await p.evaluate(() => loadDesk(true).then(() => render()));
await p.waitForTimeout(900);
await onDay(D1);

lastDialog = '';
await p.click(`[data-dkmove="${bkA._id}"]`);
await p.waitForSelector('[data-dkto]', { timeout: 8000 });
await p.click(`[data-dkto="${a3._id}"]`);
await p.waitForTimeout(1500);
ok('moving onto a day already at its limit asks first, in plain words',
  /daily limit/i.test(lastDialog), JSON.stringify(lastDialog).slice(0, 120));
ok('and when the person says yes it is written down against the booking',
  await (async () => {
    const again = await col('campaign_bookings').findOne({ _id: bkA._id });
    return again.slotId === a3._id && again.overDailyLimit === true
      && (again.history || []).some((h) => h.action === 'moved' && h.overDailyLimit);
  })());
ok('the overrun then shows on the desk as a venue over its limit', await (async () => {
  await onDay(D2);
  return (await p.evaluate(() => deskClashes(DESK.day).some((c) => c.kind === 'daycap')));
})());

/* ---- adding a time without touching the weekly rule -------------------- */

await onDay(D1);
await p.click(`[data-dkaddtime="${schB._id}"]`);
await p.waitForSelector('#dkNewGo', { timeout: 8000 });
await p.fill('#dkNewTime', '21:30');
await p.fill('#dkNewCap', '2');
await p.click('#dkNewGo');
await p.waitForTimeout(1200);
ok('a time added from the desk exists on the server', await (async () => {
  const s = await col('booking_slots').findOne({ scheduleId: schB._id, date: D1, time: '21:30' });
  return !!s && s.capacity === 2;
})());
ok('and appears in that venue\'s column straight away',
  await p.evaluate(() => deskSlotsOn(DESK.day).some((s) => s.time === '21:30')));

/* ---- dragging a card onto a time --------------------------------------- */

/* The grid's one gesture. It makes the same request the Move button
   does, which is the point: there is one way to move a booking, and two
   ways to ask for it. */
await onDay(D1);
const bkC = partC ? await col('campaign_bookings').findOne({ participantId: partC.id }) : null;
if (bkC) {
  const freeSlot = await slot(schA, D1, '22:00', 2);
  await p.evaluate(() => loadDesk(true).then(() => render()));
  await p.waitForTimeout(900);
  await onDay(D1);
  /* Chromium's headless drag does not reliably synthesise the HTML5
     drag sequence from pointer moves, so the three events the handlers
     actually listen for are dispatched directly. What is under test is
     the handler chain and the request it makes, not Chromium's mouse. */
  await p.evaluate(([from, to]) => {
    const card = document.querySelector(`[data-dkbk="${from}"]`);
    const cell = document.querySelector(`[data-dkslot="${to}"]`);
    const dt = new DataTransfer();
    const fire = (el, type) => el.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    fire(card, 'dragstart');
    fire(cell, 'dragover');
    fire(cell, 'drop');
  }, [bkC._id, freeSlot._id]);
  await p.waitForTimeout(1500);
  ok('dragging a card onto a free time moves the booking', await (async () => {
    const again = await col('campaign_bookings').findOne({ _id: bkC._id });
    return again.slotId === freeSlot._id && again.time === '22:00';
  })(), await (async () => (await col('campaign_bookings').findOne({ _id: bkC._id })).time)());
  ok('and the drag is undoable like any other move', await p.isVisible('#dkUndo'));
}

/* ---- getting around --------------------------------------------------- */

await p.click('#dkNext');
await p.waitForTimeout(400);
ok('the arrow steps a day', await p.evaluate((d) => DESK.day === d, plus(D1, 1)));
await p.keyboard.press('ArrowLeft');
await p.waitForTimeout(400);
ok('and so does the left arrow key', await p.evaluate((d) => DESK.day === d, D1));
await p.click('#dkToday');
await p.waitForTimeout(900);
ok('Today comes back to the Korean today', await p.evaluate((d) => DESK.day === d, kst()));

await onDay(D1);
await p.fill('#dkQ', 'Mapo');
await p.waitForTimeout(400);
ok('searching a venue name narrows the grid and leaves the search box alone',
  await p.evaluate(() => document.activeElement && document.activeElement.id === 'dkQ'));
ok('and only that venue\'s bookings survive the filter',
  await p.evaluate(() => deskBookingsOn(DESK.day).filter(deskMatchesQuery)
    .every((b) => deskVenue(b.scheduleId).name === 'Mapo Galbi')));
await p.fill('#dkQ', '');
await p.waitForTimeout(300);

await p.evaluate(() => { DESK.view = 'people'; render(); });
await p.waitForTimeout(400);
ok('by creator, the double-booked person is one row holding two campaigns',
  await p.evaluate((h) => {
    const r = deskPeople().find((x) => x.who.handle === h);
    return !!r && new Set(r.list.map((b) => b.campaignId)).size === 2;
  }, HANDLE), HANDLE);
ok('and the page marks them as being in more than one',
  (await p.textContent('#view')).includes('in more than one'));

/* ---- narrowing to one venue ------------------------------------------- */

await go('desk/' + CP_B);
await p.waitForSelector('.dk-band', { timeout: 10000 });
await onDay(D1);
ok('picking a venue in the panel narrows the whole page to it',
  await p.evaluate(() => deskSchedules().length) === 1);
ok('and the clash that needed two venues goes quiet there',
  await p.evaluate(() => deskClashes(DESK.day).filter((c) => c.kind === 'double').length) === 0);

/* ---- on a phone -------------------------------------------------------- */

await p.setViewportSize({ width: 390, height: 844 });
await go('desk');
await p.waitForSelector('.dk-band', { timeout: 10000 });
await onDay(D1);
ok('the desk is reachable from the phone tab bar',
  (await p.$$eval('#mbar a', (a) => a.map((x) => x.textContent))).some((t) => /Desk/.test(t)));
ok('and the grid stacks instead of scrolling sideways off the screen',
  await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  await p.evaluate(() => document.documentElement.scrollWidth + ' vs ' + window.innerWidth));
ok('the queue still tells a phone what needs a person',
  (await p.textContent('#view')).includes('need a person')
  || (await p.textContent('#view')).includes('needs a person'));
await p.setViewportSize({ width: 1600, height: 1100 });

/* ---- nothing else moved ------------------------------------------------ */

await go('campaigns/' + CP_A + '/booking');
await p.waitForTimeout(1200);
ok('the campaign Booking tab still renders', (await p.textContent('#view')).length > 200);
ok('and it agrees with the desk about where that booking now is', await p.evaluate(([id, d]) => {
  const b = BOOKING.bookings.find((x) => x._id === id) || {};
  return b.date === d && b.time === '18:00';
}, [bkA._id, D2]), await p.evaluate((id) => {
  const b = BOOKING.bookings.find((x) => x._id === id) || {};
  return b.date + ' ' + b.time;
}, bkA._id));

await go('campaigns/' + CP_A + '/roster');
ok('the roster still renders', (await p.$$('#view .kb-col, #view table')).length > 0);
ok('no page errors anywhere in the run', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await br.close();
srv.close();
console.log(errs.length ? '\n' + errs.length + ' FAILED' : '\nall desk checks passed');
process.exit(errs.length ? 1 : 0);
