/* Today: one list of what needs a person, and the counts every other
   page now takes from it.

   Each test is a morning somebody has: a creator confirmed with nothing
   booked, a link that went out three days ago, a visit tomorrow, a post
   that never came. The rule under test is that each of those appears
   once, with the right urgency, and goes away when the thing is done. */

import './helpers/browser-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  todayItems, todayCounts, snoozeToday, payInfo, markPaid, plannerSummary, setAttendance
} from '../src/views/planner.js';
import { BOOKING } from '../src/views/booking.js';
import { DB, byCampaign, byCreator } from '../src/model/db.js';
import { TODAY, DAY, iso } from '../src/lib/dates.js';

const day = (n) => iso(new Date(TODAY.getTime() + n * DAY));
const slot = (n, t) => day(n) + (t ? ' ' + t : '');
const ago = (n) => new Date(Date.now() - n * DAY).toISOString();

function seed() {
  DB.creators.length = 0; DB.campaigns.length = 0; DB.participants.length = 0; DB.socialContent.length = 0;
  Object.keys(byCreator).forEach((k) => delete byCreator[k]);
  Object.keys(byCampaign).forEach((k) => delete byCampaign[k]);
  BOOKING.campaignId = null; BOOKING.schedule = null; BOOKING.slots = []; BOOKING.bookings = []; BOOKING.at = null;
  const cr = (id, handle, extra) => Object.assign({ id, handle, name: handle.slice(1), platform: 'Instagram',
    followers: 10000, er: 3, avgViews: 5000, categories: [], country: 'Korea', flag: null, flagReason: '',
    campaignsDone: 0, tags: [] }, extra || {});
  DB.creators.push(cr('cr1', '@minji'), cr('cr2', '@jiwoo', { flag: 'blocked' }), cr('cr3', '@hana'));
  DB.creators.forEach((c) => (byCreator[c.id] = c));
  /* no start/end or target: keeps the campaign-level "behind" rule out of
     tests that are about one creator */
  DB.campaigns.push(
    { id: 'cpK', brand: 'Sushikoji', name: 'counter visit', kind: 'Store visit', market: 'Korea', status: 'live' },
    { id: 'cpW', brand: 'Wrapped', name: 'done', kind: 'Store visit', market: 'Korea', status: 'wrapped' },
    { id: 'cpP', brand: 'Glowbe', name: 'parcel', kind: 'Product seeding', market: 'Vietnam', status: 'live' });
  DB.campaigns.forEach((c) => (byCampaign[c.id] = c));
}
const part = (o) => { const p = Object.assign({ campaignId: 'cpK', stage: 'confirmed', creatorId: 'cr1', content: null }, o);
  DB.participants.push(p); return p; };
const kinds = (opts) => todayItems(opts).map((x) => x.kind).sort();

test('a confirmed visit with nothing booked asks for a link to be sent', () => {
  seed();
  part({ id: 'p1' });
  const it = todayItems();
  assert.deepEqual(it.map((x) => x.kind), ['send_link']);
  assert.equal(it[0].sev, 'todo');
  assert.ok(it[0].acts.includes('booking'));
});

test('a link sent today is waiting, not a to-do; three days on it is a nudge', () => {
  seed();
  const p = part({ id: 'p1', bookingLinkSentAt: ago(0.2) });
  assert.deepEqual(kinds(), []);
  p.bookingLinkSentAt = ago(3);
  assert.deepEqual(kinds(), ['nudge_link']);
});

test('a visit tomorrow asks for a reminder until one has been sent for that visit', () => {
  seed();
  const p = part({ id: 'p1', confirmedVisitAt: slot(1, '18:30') });
  const it = todayItems();
  assert.deepEqual(it.map((x) => x.kind), ['remind']);
  assert.equal(it[0].sev, 'soon');
  assert.match(it[0].title, /tomorrow at 18:30/);
  p.reminderFor = slot(1, '18:30');
  assert.deepEqual(kinds(), []);
  /* moved to another day: the reminder for the old time does not count */
  p.confirmedVisitAt = slot(0, '19:00');
  assert.equal(todayItems()[0].sev, 'now', 'a visit today is today\'s job');
});

test('a visit nine days ago with no post: chase it now, and ask whether they came', () => {
  seed();
  const p = part({ id: 'p1', confirmedVisitAt: slot(-9, '12:00') });
  assert.deepEqual(kinds(), ['attend', 'chase']);
  assert.equal(todayItems().find((x) => x.kind === 'chase').sev, 'now');
  p.chasedAt = ago(1);
  assert.deepEqual(kinds(), ['attend'], 'a chase that just went out stays quiet');
  p.chasedAt = ago(4);
  assert.deepEqual(kinds(), ['attend', 'chase'], 'and comes back after three days');
  setAttendance(p, 'attended');
  assert.deepEqual(kinds(), ['chase']);
  setAttendance(p, 'no_show');
  assert.deepEqual(kinds(), [], 'a no-show owes no post');
});

test('a blacklisted creator still on a roster is the first thing on the list', () => {
  seed();
  part({ id: 'p1', creatorId: 'cr3' });
  part({ id: 'p2', creatorId: 'cr2', stage: 'shortlisted' });
  const it = todayItems();
  assert.equal(it[0].kind, 'blocked');
  assert.equal(it[0].sev, 'now');
});

test('wrapped campaigns and dropped rows put nothing on the list', () => {
  seed();
  part({ id: 'p1', campaignId: 'cpW' });
  part({ id: 'p2', stage: 'dropped', creatorId: 'cr2' });
  assert.deepEqual(kinds(), []);
});

test('a parcel campaign is not asked to send booking links', () => {
  seed();
  part({ id: 'p1', campaignId: 'cpP' });
  assert.deepEqual(kinds(), []);
});

test('Later hides one thing for two days and nothing else', () => {
  seed();
  const a = part({ id: 'p1' });
  part({ id: 'p2', creatorId: 'cr3' });
  snoozeToday(a, 'send_link', 2);
  const it = todayItems();
  assert.equal(it.length, 1);
  assert.equal(it[0].participantId, 'p2');
});

test('what is owed: a fee alone counts, gifted-only does not, and paid is paid', () => {
  assert.equal(payInfo({ fee: 50000 }).owed, true);
  assert.equal(payInfo({ fee: 50000 }).amount, 50000);
  assert.equal(payInfo({ payment: { mode: 'none' } }).owed, false);
  assert.equal(payInfo({ payment: { mode: 'paid', amount: 30000, status: 'unpaid' } }).owed, true);
  assert.equal(payInfo({ payment: { mode: 'paid', amount: 30000, paidAt: day(-1) } }).owed, false);
  const p = { fee: 70000 };
  markPaid(p, day(0));
  assert.deepEqual([p.payment.status, p.payment.paidAt, p.payment.amount, p.payment.mode], ['paid', day(0), 70000, 'paid']);
});

test('a creator who posted and is owed money shows up to be paid, once', () => {
  seed();
  const p = part({ id: 'p1', stage: 'live', fee: 50000, confirmedVisitAt: slot(-5, '12:00'),
    content: { url: 'https://instagram.com/p/x', publishedAt: day(-2) } });
  assert.deepEqual(kinds(), ['pay']);
  markPaid(p);
  assert.deepEqual(kinds(), []);
});

test('the Planner\'s "needs attention" is this list, narrowed to the campaign', () => {
  seed();
  part({ id: 'p1' });
  part({ id: 'p2', creatorId: 'cr3', confirmedVisitAt: slot(-9, '12:00') });
  part({ id: 'p3', campaignId: 'cpP', creatorId: 'cr3', stage: 'submitted' });
  const mine = todayItems({ campaignId: 'cpK' }).filter((x) => x.sev !== 'soon').length;
  assert.equal(plannerSummary(byCampaign.cpK).attention, mine);
  const c = todayCounts();
  assert.equal(c.total, todayItems().length);
  assert.equal(c.now + c.todo + c.soon, c.total);
});

test('a wrapped campaign still shows money owed, and nothing else', () => {
  seed();
  part({ id: 'p1', campaignId: 'cpW', stage: 'live', fee: 40000, confirmedVisitAt: slot(-20, '12:00'),
    content: { url: 'https://instagram.com/p/y', publishedAt: day(-15) } });
  part({ id: 'p2', campaignId: 'cpW', creatorId: 'cr3' });   /* would be send_link on a live campaign */
  assert.deepEqual(kinds(), ['pay']);
});
