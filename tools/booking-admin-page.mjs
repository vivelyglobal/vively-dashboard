/* The Booking tab, driven through the real UI.

   Phase A proved the API and Phase B the creator's page. What is left is
   the part staff actually touch, and the two things it must never do:

     - let a hand-edit compete with a booking for the same field. A booked
       row's confirmed time belongs to the booking; the drawer has to say
       so rather than offering two date inputs the next save would undo.
     - invent a creator. An unmatched public booking is matched to a row
       that already exists, or it waits. Nothing is ever added to the
       creator database from here.

   Runs the real index.html against the real booking routes over
   tools/fake-booking-db.mjs. The workspace comes from tools/seed.mjs via
   localStorage, so the roster is the same one every other harness uses. */

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
const seed = fs.readFileSync(path.join(ROOT, 'tmp/seed.json'), 'utf8');

const errs = [];
const ok = (n, cond, extra) => {
  if (cond) console.log('ok   ' + n + (extra ? '   ' + extra : ''));
  else { console.log('FAIL ' + n + (extra ? '   ' + extra : '')); errs.push(n); }
};

const app = express();
app.use(express.json({ limit: '10mb' }));
const api = routes.mountBookingRoutes(app, {
  getMongoClient: async () => fakeClient,
  MONGODB_DB: 'test', MONGODB_URI: 'mongodb://fake',
  loadWorkspaceDoc: async () => ({ db: {} }),
  /* auth is covered by check:auth; this harness is about the tab */
  requireStaff: (h) => h
});
/* The shell hides itself until /api/me says who is looking — see
   bootAuth() in index.html. Sessions are covered by check:auth; here the
   answer is stubbed for the same reason requireStaff is, so the check
   stays about the tab. */
app.get('/api/me', (req, res) => res.json({ user: { email: 'k@v.com', name: 'Harness' }, staff: true }));

/* The workspace is served rather than refused. A 401 here is not inert:
   the shell treats any refusal as "you are signed out" and locks itself,
   so a stub that 401s makes the whole dashboard invisible. Serving the
   seed is also closer to production than the localStorage fallback. */
let WORKSPACE = { db: JSON.parse(seed).db, settings: JSON.parse(seed).settings || {}, revision: 1 };
app.get('/api/workspace', (req, res) => res.json({ ok: true, ...WORKSPACE }));
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

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
await ctx.addInitScript(([s]) => {
  localStorage.setItem('vively-workspace-v1', s);
  localStorage.setItem('vively-auth-user-v1', JSON.stringify({ email: 'k@v.com', name: 'K' }));
}, [seed]);
const p = await ctx.newPage();
const pageErrors = [];
p.on('pageerror', (e) => pageErrors.push(e.message));

const CP = JSON.parse(seed).db.campaigns[0].id;
/* A goto to a URL the browser is already on does not reload, so a hash
   that has not changed leaves the page exactly as it was — including a
   Booking tab holding a cached read. Blanking the hash first makes every
   call here a real navigation. */
const go = async (hash) => {
  await p.goto(BASE + '/#/blank');
  await p.goto(BASE + '/#/' + hash);
  await p.waitForTimeout(500);
};

/* ---- the tab is there at all ------------------------------------------ */

await go('campaigns/' + CP + '/roster');
const tabNames = await p.$$eval('#tabbar a, #tabbar button', (els) => els.map((e) => e.textContent.trim()));
ok('Booking is a campaign tab', tabNames.includes('Booking'), tabNames.join(' · '));
ok('and it sits next to the roster it feeds',
  tabNames.indexOf('Booking') === tabNames.indexOf('Roster & pipeline') + 1);

/* ---- setting it up ----------------------------------------------------- */

await go('campaigns/' + CP + '/booking');
await p.waitForSelector('#bkCreate', { timeout: 8000 });
ok('an unset campaign offers to set booking up', await p.isVisible('#bkCreate'));
await p.fill('#bkVenue', '굽네치킨 강남');
await p.selectOption('#bkTz', 'Asia/Seoul');
await p.fill('#bkParty', '2');
await p.click('#bkCreate');
await p.waitForSelector('#bkCopy', { timeout: 8000 });
ok('setting it up shows the link', (await p.textContent('#main, #view')).includes('/book/'));

/* ---- availability ------------------------------------------------------ */

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
await p.click('#bkAddDate');
await p.waitForSelector('#adGo', { timeout: 8000 });
await p.fill('#adDate', day(9));
await p.fill('#adFrom', '12:00');
await p.fill('#adCap', '2');
await p.click('#adGo');
await p.waitForSelector('[data-date-row]', { timeout: 8000 });
ok('the date appears as a row', (await p.$$('[data-date-row]')).length === 1);

/* the row expands in place rather than opening anything */
const openRow = async () => {
  if (!(await p.$('[data-addslot]'))) await p.click('[data-date-row] td:first-child');
  await p.waitForSelector('[data-addslot]', { timeout: 8000 });
};
await openRow();
ok('clicking the date expands its times inline', await p.isVisible('[data-addslot]'));

await p.fill('[data-newtime]', '13:00');
await p.fill('[data-newcap]', '1');
await p.click('[data-addslot]');
await p.waitForTimeout(700);
await openRow();
ok('a second time is added to the same day', (await p.$$('[data-cap]')).length === 2);

/* copying a day is the thing that makes a fortnight bearable */
await p.click('#bkAddDate');
await p.waitForSelector('#adGo', { timeout: 8000 });
await p.fill('#adDate', day(10));
await p.selectOption('#adCopy', day(9));
await p.click('#adGo');
await p.waitForTimeout(800);
ok('"same times as" copies a whole day', (await p.$$('[data-date-row]')).length === 2);
ok('and copies every time on it', await p.evaluate(() =>
  [...document.querySelectorAll('[data-date-row]')][1].textContent.includes('2')));

/* ---- blocking ---------------------------------------------------------- */

/* Waits on the state rather than a timeout: this is a fetch, a reload and
   a re-render, and a fixed wait that is occasionally too short leaves the
   day blocked — which then fails the booking three checks later, a long
   way from the cause. */
const blockedNow = () => p.evaluate(() => (BOOKING.schedule.closedDates || []).length);
await p.click(`[data-block="${day(9)}"]`);
await p.waitForFunction(() => (BOOKING.schedule.closedDates || []).length === 1, null, { timeout: 8000 });
ok('a day can be blocked', (await blockedNow()) === 1);
ok('and says so on the row', (await p.textContent(`[data-date-row="${day(9)}"]`)).includes('Blocked'));

await p.click(`[data-block="${day(9)}"]`);
await p.waitForFunction(() => (BOOKING.schedule.closedDates || []).length === 0, null, { timeout: 8000 });
ok('and unblocked again', (await blockedNow()) === 0);
ok('its slots came back rather than being recreated',
  await p.evaluate(() => BOOKING.slots.filter((s) => s.status === 'open').length >= 2));

/* ---- invites ------------------------------------------------------------ */

ok('the roster is offered links it does not have yet', await p.isVisible('#bkInviteAll'));
const beforeCreators = await p.evaluate(() => DB.creators.length);
await p.click('#bkInviteAll');
await p.waitForSelector('[data-copyinvite]', { timeout: 15000 });
const invites = await p.$$('[data-copyinvite]');
ok('every uninvited roster row gets a link', invites.length > 0, invites.length + ' links');
ok('inviting adds nobody to the creator database',
  (await p.evaluate(() => DB.creators.length)) === beforeCreators);

/* ---- a creator books, and staff sees it --------------------------------- */

const inviteId = await p.getAttribute('[data-copyinvite]', 'data-copyinvite');
const slotId = await p.evaluate(() => BOOKING.slots.find((s) => s.time === '12:00')._id);
await p.evaluate(async ([tok, slot]) => {
  await fetch('/api/book/' + tok + '/confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slotId: slot })
  });
}, [inviteId, slotId]);
/* nothing pushes a creator's booking into an open tab, which is what
   Refresh is for — so the check uses it rather than reloading */
await p.click('#bkRefresh');
await p.waitForSelector('[data-move]', { timeout: 10000 });
ok('Refresh brings in a booking made while the tab was open',
  (await p.$$('[data-move]')).length === 1);
const firstRow = await p.$eval('[data-move]', (el) => el.closest('tr').innerText);
ok('and it is attributed to the creator, not a guest',
  !firstRow.includes('unmatched') && /@/.test(firstRow), firstRow.replace(/\s+/g, ' '));

/* ---- staff moving ------------------------------------------------------- */

/* fill a one-seat slot so the move drawer has a genuinely full target —
   without one, "Over capacity" is a branch no check ever reaches */
await p.evaluate(async () => {
  const one = BOOKING.slots.find((s) => s.capacity === 1 && s.booked === 0);
  await fetch('/api/book/' + BOOKING.schedule.publicToken + '/confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slotId: one._id, name: 'Filler', handle: '@filler' })
  });
});
await p.click('#bkRefresh');
await p.waitForTimeout(900);
ok('a one-seat slot is now full',
  await p.evaluate(() => BOOKING.slots.some((s) => s.booked >= s.capacity)));

await p.click('[data-move]');
await p.waitForSelector('[data-moveto]', { timeout: 8000 });
const targets = await p.$$('[data-moveto]');
ok('the move drawer lists every other slot', targets.length >= 3, targets.length + ' targets');
const overBtn = await p.$('[data-moveto][data-free="0"]');
ok('a full slot is offered to staff rather than hidden', !!overBtn);
ok('and it says what it would be', overBtn ? (await overBtn.textContent()).includes('Over capacity') : false);

/* move to an ordinary free slot */
await p.click('[data-moveto][data-free="1"], [data-moveto]:not([data-free="0"])');
await p.waitForTimeout(900);
const movedTo = await p.evaluate(() => BOOKING.bookings[0] && BOOKING.bookings[0].time);
ok('the move lands and the list refreshes', !!movedTo, 'now ' + movedTo);
ok('it is recorded as a staff decision',
  await p.evaluate(() => BOOKING.bookings[0].source === 'staff'));

/* ---- an unmatched public booking ---------------------------------------- */

await p.evaluate(async () => {
  const tok = BOOKING.schedule.publicToken;
  const free = BOOKING.slots.find((s) => s.booked < s.capacity);
  await fetch('/api/book/' + tok + '/confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slotId: free._id, name: '알 수 없는 김', handle: '@unknown_kim' })
  });
});
await p.click('#bkRefresh');
await p.waitForSelector('[data-match]', { timeout: 10000 });
ok('an unmatched booking is surfaced for staff', (await p.$$('[data-match]')).length === 1);
ok('and says plainly that nothing was added to the database',
  (await p.textContent('body')).includes('Nothing has been added to the creator database'));

const creatorsBefore = await p.evaluate(() => DB.creators.length);
const unmatchedBefore = (await p.$$('[data-match]')).length;
await p.click('[data-match]');
await p.waitForSelector('#mbGo', { timeout: 8000 });
await p.click('#mbGo');
await p.waitForTimeout(900);
ok('matching still adds nobody to the creator database',
  (await p.evaluate(() => DB.creators.length)) === creatorsBefore);
ok('and that booking is no longer unmatched',
  (await p.$$('[data-match]')).length === unmatchedBefore - 1,
  unmatchedBefore + ' → ' + (await p.$$('[data-match]')).length);

/* ---- the participant drawer, which is where the two stores meet --------- */

const bookedPid = await p.evaluate(() => (BOOKING.bookings.find((b) => b.participantId) || {}).participantId);
ok('a booking is attached to a roster row', !!bookedPid);

/* the projection has to be on the participant for the roster, calendar and
   partner page to show it — that is the whole point of confirmedVisitAt */
await p.evaluate(async ([pid]) => {
  const live = await (await fetch('/api/booking/campaign/' + DB.campaigns[0].id)).json();
  const b = live.bookings.find((x) => x.participantId === pid);
  const part = DB.participants.find((x) => x.id === pid);
  part.confirmedVisitAt = b.date + ' ' + b.time;
  part.bookingId = b._id;
}, [bookedPid]);

await go('campaigns/' + CP + '/roster');
await p.evaluate(([pid]) => showParticipant(pid), [bookedPid]);
await p.waitForSelector('#drawer.open', { timeout: 8000 });
const drawer = await p.textContent('#drawer');

ok('a booked row says the creator booked it', drawer.includes('booked by the creator'));
ok('and offers no date inputs to compete with the booking',
  (await p.$$('#drawer #pdVisitDate')).length === 0 && (await p.$$('#drawer #pdVisitTime')).length === 0);
ok('it points at where the time is actually changed', await p.isVisible('#pdToBooking'));
ok('saving a booked row leaves the confirmed time alone', await (async () => {
  const before = await p.evaluate(([pid]) => DB.participants.find((x) => x.id === pid).confirmedVisitAt, [bookedPid]);
  await p.click('#pdSave');
  await p.waitForTimeout(500);
  const after = await p.evaluate(([pid]) => DB.participants.find((x) => x.id === pid).confirmedVisitAt, [bookedPid]);
  return before === after && !!after;
})());

/* an unbooked row keeps today's behaviour, byte for byte */
const freePid = await p.evaluate(() => {
  const booked = new Set(DB.participants.filter((x) => x.bookingId).map((x) => x.id));
  return (DB.participants.find((x) => x.campaignId === DB.campaigns[0].id && !booked.has(x.id)) || {}).id;
});
await p.evaluate(([pid]) => showParticipant(pid), [freePid]);
await p.waitForSelector('#drawer.open', { timeout: 8000 });
ok('an unbooked row still has its two date inputs',
  await p.isVisible('#pdVisitDate') && await p.isVisible('#pdVisitTime'));
ok('and can still be set by hand', await (async () => {
  await p.fill('#pdVisitDate', day(11));
  await p.fill('#pdVisitTime', '15:30');
  await p.click('#pdSave');
  await p.waitForTimeout(500);
  return (await p.evaluate(([pid]) => DB.participants.find((x) => x.id === pid).confirmedVisitAt, [freePid]))
    === day(11) + ' 15:30';
})());
ok('an unbooked row is offered a booking link', await (async () => {
  await p.evaluate(([pid]) => showParticipant(pid), [freePid]);
  await p.waitForSelector('#drawer.open');
  return p.isVisible('#pdInvite');
})());

/* ---- nothing else moved -------------------------------------------------- */

ok('the roster still renders', await (async () => {
  await go('campaigns/' + CP + '/roster');
  return (await p.$$('#view .kb-col, #view table')).length > 0;
})());
ok('the visit calendar still renders', await (async () => {
  await go('campaigns/' + CP + '/calendar');
  return (await p.textContent('#view')).length > 40;
})());
ok('no page errors anywhere in the run', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await b.close();
srv.close();
console.log(errs.length ? '\n' + errs.length + ' FAILED' : '\nall booking admin checks passed');
process.exit(errs.length ? 1 : 0);
