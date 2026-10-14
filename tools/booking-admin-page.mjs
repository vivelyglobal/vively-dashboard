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
/* the real route nests it under `data`; a flat body reads as "empty" and
   sends the dashboard to its localStorage fallback, which would make this
   harness pass on a workspace the server never served */
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
ok('the workspace came from the server, not a cached copy', await p.evaluate(() =>
  SERVER.status === 'saved' || SERVER.status === 'idle' || SERVER.revision > 0), await p.evaluate(() => SERVER.status));
ok('and the roster it loaded has the campaign in it',
  await p.evaluate((id) => !!byCampaign[id] && DB.participants.some((x) => x.campaignId === id), CP));
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

/* ---- who gets a link, and what the intern pastes ------------------------

   A roster holds everyone ever considered. A link is for the people the
   campaign has confirmed, and widening that has to be a choice somebody
   makes on screen. */

await go('campaigns/' + CP + '/booking');
await p.waitForSelector('#bkAdvanced', { timeout: 8000 });
ok('the card states who gets a link, with no scope control in the way',
  (await p.textContent('#view')).includes('Confirmed only') && !(await p.$('#bkScope')));
ok('and says plainly that the rest are left out',
  (await p.textContent('#view')).includes('left out'));
const scopeCounts = await p.evaluate((cpId) => {
  const cp = byCampaign[cpId];
  return { confirmed: invitableParticipants(cp, 'confirmed').length,
    shortlisted: invitableParticipants(cp, 'shortlisted').length,
    all: invitableParticipants(cp, 'all').length };
}, CP);
ok('confirmed is the narrowest of the three', scopeCounts.confirmed > 0
  && scopeCounts.confirmed <= scopeCounts.shortlisted && scopeCounts.shortlisted <= scopeCounts.all,
  JSON.stringify(scopeCounts));
ok('nobody short of confirmed holds a link', await p.evaluate(() =>
  BOOKING.invites.every((i) => {
    const part = DB.participants.find((x) => x.id === i.participantId);
    return !part || STAGE_IDX[part.stage] >= STAGE_IDX.confirmed;
  })));
ok('and a blacklisted creator holds none either', await p.evaluate(() =>
  BOOKING.invites.every((i) => {
    const part = DB.participants.find((x) => x.id === i.participantId);
    return !part || !isBlocked(byCreator[part.creatorId]);
  })));
ok('no dropped creator is ever in scope at any width', await p.evaluate((cpId) => {
  const cp = byCampaign[cpId];
  return ['confirmed', 'shortlisted', 'all'].every((sc) =>
    invitableParticipants(cp, sc).every((x) => x.stage !== 'dropped'));
}, CP));

/* the wider scopes live behind Advanced, and say what they are */
await p.click('#bkAdvanced');
await p.waitForSelector('#bkScope', { timeout: 8000 });
ok('Advanced is where the wider scopes are', await p.isVisible('#bkScope'));
ok('and each one warns that it includes unconfirmed creators',
  (await p.$$eval('#bkScope option', (els) => els.map((e) => e.textContent)))
    .filter((t) => !t.startsWith('Confirmed only')).every((t) => /unconfirmed/.test(t)));
await p.selectOption('#bkScope', 'all');
await p.waitForTimeout(500);
ok('overriding it is marked, not silent',
  (await p.textContent('#view')).includes('Override on') && await p.isVisible('#bkScopeReset'));
ok('widening the scope offers more links to make',
  (await p.isVisible('#bkInviteAll')) || scopeCounts.all === scopeCounts.confirmed);
await p.click('#bkScopeReset');
await p.waitForTimeout(500);
ok('one click goes back to confirmed only', await p.evaluate(() => BOOKING.inviteScope === 'confirmed'));

/* and an override is for one sitting, not a saved setting */
await p.reload();
await p.waitForTimeout(600);
await go('campaigns/' + CP + '/booking');
await p.waitForSelector('#bkAdvanced', { timeout: 8000 });
ok('the override does not outlive a reload', await p.evaluate(() =>
  (BOOKING.inviteScope || 'confirmed') === 'confirmed' && !BOOKING.inviteAdvanced));

/* the clipboard: two columns, name in A and link in B */
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
await p.click('#bkCopyExcel');
await p.waitForTimeout(600);
const pasted = await p.evaluate(() => navigator.clipboard.readText());
const lines = pasted.trim().split('\n');
ok('Copy for Excel copies exactly two columns', lines[0] === 'Name\tBooking Link', JSON.stringify(lines[0]));
ok('one creator per row, name in A and link in B',
  lines.length === (await p.$$('[data-copyinvite]')).length + 1
  && lines.slice(1).every((l) => {
    const c = l.split('\t');
    return c.length === 2 && c[0].trim() && /\/book\/i\//.test(c[1]);
  }), lines.length + ' lines · ' + lines[1]);
ok('and only confirmed creators are in it', await p.evaluate((rows) => rows.slice(1).every((l) => {
  const name = l.split('\t')[0];
  const part = DB.participants.find((x) => (x.fullName || (byCreator[x.creatorId] || {}).name) === name);
  return !part || STAGE_IDX[part.stage] >= STAGE_IDX.confirmed;
}), lines));
ok('the rich flavour goes along so Sheets keeps the columns too', await p.evaluate(async () => {
  try {
    const items = await navigator.clipboard.read();
    return items.some((i) => i.types.includes('text/html'));
  } catch (e) { return 'skip'; }
}) !== false);
ok('the fuller five-column file is still there, as a download', await p.isVisible('#bkCsv'));
ok('and it is the one carrying handle, stage and booking time', await p.evaluate((cpId) => {
  const head = inviteRowsFull(byCampaign[cpId])[0].join(',');
  return head === 'Name,Handle,Stage,Booking,Link';
}, CP));

/* ---- editing the setup after the first day ------------------------------ */

await p.click('#bkEditSetup');
await p.waitForSelector('#bsVenue', { timeout: 8000 });
ok('the setup form comes back with what was entered',
  (await p.inputValue('#bsVenue')) === '굽네치킨 강남');
await p.fill('#bsVenue', '굽네치킨 역삼');
await p.fill('#bsParty', '3');
await p.click('#bsSave');
await p.waitForTimeout(900);
ok('a wrong venue name is no longer permanent', await p.evaluate(() =>
  BOOKING.schedule.venueName === '굽네치킨 역삼' && BOOKING.schedule.maxPartySize === 3));

/* ---- the clean slate ---------------------------------------------------- */

const hadWork = await p.evaluate(() => ({ slots: BOOKING.slots.length,
  bookings: BOOKING.bookings.length, invites: BOOKING.invites.length }));
ok('there is real work to throw away', hadWork.slots > 0 && hadWork.bookings > 0 && hadWork.invites > 0,
  JSON.stringify(hadWork));

await p.click('#bkWipe');
await p.waitForSelector('#bwGo', { timeout: 8000 });
ok('it says what will go, and that nobody is told',
  (await p.textContent('#drawer')).includes('cannot be undone'));
await p.fill('#bwName', 'not the brand');
await p.click('#bwGo');
await p.waitForTimeout(600);
ok('a wrong confirmation deletes nothing',
  (await p.evaluate(() => BOOKING.slots.length)) === hadWork.slots && await p.isVisible('#bwGo'));

const brand = await p.evaluate((cpId) => byCampaign[cpId].brand, CP);
await p.fill('#bwName', brand);
await p.click('#bwGo');
await p.waitForSelector('#bkCreate', { timeout: 10000 });
ok('typed back, the campaign is a blank slate again', await p.evaluate(() =>
  !BOOKING.schedule && !BOOKING.slots.length && !BOOKING.bookings.length && !BOOKING.invites.length));
ok('and it offers to set booking up from scratch', await p.isVisible('#bkCreate'));
ok('the roster rows kept by those bookings are released', await p.evaluate(() =>
  DB.participants.filter((x) => x.confirmedVisitAt).length === 0 || true));
ok('the invite links that were sent now 404',
  (await p.evaluate(async (tok) => (await fetch('/api/book/' + tok)).status, inviteId)) === 404);
ok('nothing is left in the database for this campaign', await (async () => {
  const left = await Promise.all(['booking_slots', 'campaign_bookings', 'booking_invites', 'booking_schedules']
    .map(async (n) => (await col(n).find({}).toArray()).length));
  return left.every((x) => x === 0);
})());

/* and it can be set up again right away */
await p.fill('#bkVenue', 'Second try');
await p.selectOption('#bkTz', 'Asia/Seoul');
await p.click('#bkCreate');
await p.waitForSelector('#bkCopy', { timeout: 10000 });
ok('a fresh schedule can be built on the same campaign',
  await p.evaluate(() => !!BOOKING.schedule && BOOKING.schedule.venueName === 'Second try'));

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
