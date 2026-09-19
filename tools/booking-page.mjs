/* The creator's booking page, in a phone.

   book.html is the one surface in this system opened by someone who has
   never seen it, on mobile data, from a DM, and who will see it once. So
   the checks below are about what a thumb can actually do, not about
   whether the markup is present:

     - the page itself must never scroll sideways (see phone-layout.mjs
       for why that one matters more than it sounds)
     - a full or blocked slot must be visibly unavailable AND refuse the
       tap, not merely look grey
     - every time on screen carries the venue's zone, never the phone's
     - losing a race re-renders the grid in place; it never alerts, and
       never leaves a stale "3 left" under the thumb

   Served by the real Express routes over tools/fake-booking-db.mjs, so
   the 409 path is the real one rather than a mocked fetch. */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
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

/* ---- a server that serves the real page and the real API -------------- */

const app = express();
app.use(express.json({ limit: '1mb' }));
const api = routes.mountBookingRoutes(app, {
  getMongoClient: async () => fakeClient,
  MONGODB_DB: 'test', MONGODB_URI: 'mongodb://fake',
  loadWorkspaceDoc: async () => ({ db: {} }),
  requireStaff: (h) => h
});
app.get(['/book/i/:token', '/book/manage/:token', '/book/:token'], (req, res) =>
  res.sendFile(path.join(ROOT, 'book.html')));

const srv = app.listen(0);
await new Promise((r) => srv.once('listening', r));
const BASE = 'http://127.0.0.1:' + srv.address().port;

const post = async (p, body) => (await fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
})).json();

/* ---- a campaign to book into ------------------------------------------ */

const sched = await post('/api/booking/schedule', {
  campaignId: 'cp_1', timezone: 'Asia/Seoul', venueName: '굽네치킨 강남',
  maxPartySize: 2, deadlineHours: 24, slotMinutes: 90,
  noteForCreator: '10분 일찍 도착해 주세요.'
});
const scheduleId = sched.schedule._id;
const publicToken = sched.schedule.publicToken;

const dayOf = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const d1 = dayOf(9), d2 = dayOf(10), d3 = dayOf(11);
const slot = (date, time, capacity) =>
  post('/api/booking/slot', { scheduleId, date, time, capacity });

const open1 = await slot(d1, '12:00', 2);
const open2 = await slot(d1, '13:00', 1);
const willFill = await slot(d1, '18:00', 1);
await slot(d2, '12:00', 3);
await slot(d2, '16:00', 3);
await slot(d3, '11:00', 2);
/* d3 is blocked as a whole day; its slot stays, so the day reads 휴무
   rather than vanishing */
await post('/api/booking/date', { scheduleId, date: d3, closed: true });
/* and one slot is filled so a Full state exists to test */
await post('/api/book/' + publicToken + '/confirm',
  { slotId: willFill.slot._id, name: 'Taken', handle: '@taken' });

const invite = await post('/api/booking/invite', {
  campaignId: 'cp_1', participantId: 'pt_1', creatorId: 'cr_1', name: '김민지', handle: '@minji'
});

/* ---- the browser ------------------------------------------------------- */

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage();
const pageErrors = [];
p.on('pageerror', (e) => pageErrors.push(e.message));

const noSideways = async (label) => {
  const wide = await p.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  ok(label + ': the page does not scroll sideways', !wide);
};

/* ---- the public link --------------------------------------------------- */

await p.goto(BASE + '/book/' + publicToken);
await p.waitForSelector('.date', { timeout: 8000 });

ok('the venue names itself', (await p.textContent('#venue')).includes('굽네치킨'));
ok('the note from staff is shown', (await p.textContent('#main')).includes('10분 일찍'));
await noSideways('public link');

const dates = await p.$$('.date');
ok('every open day is on the strip', dates.length === 3, dates.length + ' days');
const blocked = await p.$('.date.out');
ok('a blocked day stays visible rather than vanishing', !!blocked);
ok('and says so in words', (await blocked.textContent()).includes('휴무'));
ok('a blocked day refuses the tap', await blocked.isDisabled());

const slots = await p.$$('.slot');
ok('the first open day shows its times', slots.length === 3, slots.length + ' slots');
const full = await p.$('.slot.full');
ok('a full slot is present and marked', !!full && (await full.textContent()).includes('마감'));
ok('a full slot refuses the tap', await full.isDisabled());
ok('times carry the venue zone, not the phone\'s',
  (await p.textContent('.tz')).includes('KST'));

/* tap targets: 44px is the floor a thumb needs */
const small = await p.evaluate(() => [...document.querySelectorAll('.slot, .date, button.go')]
  .map((el) => ({ cls: el.className, h: Math.round(el.getBoundingClientRect().height) }))
  .filter((x) => x.h < 44));
ok('every target a thumb hits is at least 44px tall', small.length === 0, JSON.stringify(small));

ok('the button will not fire before a time is chosen', await p.isDisabled('#go'));
await p.click('.slot:not(.full)');
ok('choosing a time names it on the button',
  (await p.textContent('#go')).includes('12:00'), await p.textContent('#go'));

/* the public link asks who you are; the invite link will not */
ok('the public link asks for a name', !(await p.getAttribute('#f_name', 'readonly') !== null));
await p.fill('#f_name', '박지우');
await p.fill('#f_handle', '@jiwoo');
ok('party size is offered when the schedule allows more than one',
  await p.isVisible('#f_party'));
await p.selectOption('#f_party', '2');
await p.click('#go');
await p.waitForSelector('.ok-mark', { timeout: 8000 });

const doneText = await p.textContent('#main');
ok('the confirmation states the booking', doneText.includes('12:00') && doneText.includes('굽네치킨'));
ok('it states the party size', doneText.includes('2명'));
ok('it states the zone', doneText.includes('KST'));
ok('the manage link is shown in full, because it is the only one they have',
  (await p.textContent('#manageUrl')).includes('/book/manage/'));
await noSideways('confirmation');

/* ---- the invite link ---------------------------------------------------- */

await p.goto(BASE + '/book/i/' + invite.invite._id);
await p.waitForSelector('.date', { timeout: 8000 });
ok('an invite pre-fills the creator', (await p.inputValue('#f_name')) === '김민지');
ok('and locks it, so a forwarded link cannot quietly become someone else',
  (await p.getAttribute('#f_name', 'readonly')) !== null &&
  (await p.getAttribute('#f_handle', 'readonly')) !== null);
await noSideways('invite link');

/* ---- losing the race ----------------------------------------------------

   The creator has 13:00 on screen showing one seat. Somebody else takes
   it between the page loading and the thumb landing. What must NOT
   happen: an alert, a dead button, or a page still advertising a seat
   that is gone. */
/* by time, not by position: which slots are still open depends on what
   the checks above have already booked, and an index quietly picks the
   wrong one when that changes */
const slotAt = (t) => p.locator('.slot', { hasText: t });
await slotAt('13:00').click();
const chosen = await p.textContent('#go');
ok('13:00 is the one selected', chosen.includes('13:00'), chosen);

await post('/api/book/' + publicToken + '/confirm',
  { slotId: open2.slot._id, name: 'Faster', handle: '@faster' });   /* taken from under them */

let alerted = false;
p.on('dialog', async (d) => { alerted = true; await d.dismiss(); });
await p.click('#go');
await p.waitForSelector('.note.bad', { timeout: 8000 });

ok('losing the race does not raise a dialog', !alerted);
ok('it says so in the page instead',
  (await p.textContent('.note.bad')).includes('방금'), await p.textContent('.note.bad'));
ok('the slot that went is now marked full',
  await slotAt('13:00').evaluate((el) => el.classList.contains('full')));
ok('the taken slot now refuses the tap', await slotAt('13:00').isDisabled());
ok('the selection was cleared rather than left pointing at a gone slot',
  await p.isDisabled('#go'));
await noSideways('after a lost race');

/* that day is now full end to end, so the way forward is another day —
   and the strip has to say so without the creator having to guess */
const firstDay = p.locator('.date').first();
ok('a day with nothing left reads as full on the strip',
  (await firstDay.textContent()).includes('마감'), await firstDay.textContent());
ok('another day is still offered', (await p.$$('.date:not(.out)')).length > 0);

await p.locator('.date:not(.out)').first().click();
await p.waitForSelector('.slot:not(.full)', { timeout: 8000 });
await p.locator('.slot:not(.full)').first().click();
await p.click('#go');
await p.waitForSelector('.ok-mark', { timeout: 8000 });
ok('the invited creator completes on another day', true);
const manageUrl = await p.textContent('#manageUrl');

/* ---- moving ------------------------------------------------------------- */

await p.goto(manageUrl.trim());
await p.waitForSelector('.ok-mark', { timeout: 8000 });
ok('the manage link opens the existing booking', (await p.textContent('#main')).includes('12:00'));
await p.click('#change');
await p.waitForSelector('.date', { timeout: 8000 });
ok('changing shows the picker again', (await p.$$('.slot')).length > 0);

await p.locator('.date:not(.out)').last().click();
await p.waitForSelector('.slot:not(.full)', { timeout: 8000 });
/* deliberately a different time from the one being held, or the move is
   a no-op and proves nothing */
await p.locator('.slot', { hasText: '16:00' }).click();
await p.click('#go');
await p.waitForSelector('.ok-mark', { timeout: 8000 });
const moved = await p.textContent('#main');
ok('the move lands on the newly chosen time', moved.includes('16:00'));
ok('exactly one booking still exists for that creator',
  (await col('campaign_bookings').find({ campaignId: 'cp_1', participantId: 'pt_1' }).toArray()).length === 1);

/* ---- cancelling ---------------------------------------------------------- */

p.removeAllListeners('dialog');
p.on('dialog', async (d) => { await d.accept(); });
await p.click('#cancel');
await p.waitForFunction(() => document.querySelector('#main').textContent.includes('취소되었습니다'),
  null, { timeout: 8000 });
ok('cancelling says so plainly', true);
ok('and the bottom bar goes with it', await p.isHidden('#bar'));
ok('the seat went back to the slot', await (async () => {
  const live = await api.liveBookings();
  return !live.some((x) => x.participantId === 'pt_1');
})());

/* ---- a dead link ---------------------------------------------------------- */

await p.goto(BASE + '/book/not-a-real-token');
await p.waitForSelector('.note.bad', { timeout: 8000 });
ok('a dead link says so rather than showing an empty picker',
  (await p.textContent('.note.bad')).length > 5);
ok('no picker is drawn for it', (await p.$$('.date')).length === 0);

ok('no page errors anywhere in the run', pageErrors.length === 0, pageErrors.join(' | '));

await b.close();
srv.close();
console.log(errs.length ? '\n' + errs.length + ' FAILED' : '\nall booking page checks passed');
process.exit(errs.length ? 1 : 0);
