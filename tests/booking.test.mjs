/* Booking, as far as it can be tested without a database.

   Two of these matter more than the rest. The timezone pair, because a
   booking written an hour out is wrong in a way nobody notices until a
   creator turns up to a closed shop. And applyBookingSlots, because it
   is the only thing standing between a workspace saved from a stale tab
   and a booking silently un-made. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const B = require('../server/booking-store.js');

/* ---- times ---------------------------------------------------------- */

test('Seoul has no DST, so a summer and a winter slot share an offset', () => {
  const summer = B.wallClockToInstant('2026-07-14', '13:00', 'Asia/Seoul');
  const winter = B.wallClockToInstant('2026-01-14', '13:00', 'Asia/Seoul');
  /* 13:00 KST is 04:00 UTC, all year */
  assert.equal(summer.toISOString(), '2026-07-14T04:00:00.000Z');
  assert.equal(winter.toISOString(), '2026-01-14T04:00:00.000Z');
});

test('a zone that does observe DST resolves per date, not by today', () => {
  /* London: BST in July (+1), GMT in January (0). A single-pass offset
     lookup gets one of these wrong; that is what the second pass is for. */
  const summer = B.wallClockToInstant('2026-07-14', '13:00', 'Europe/London');
  const winter = B.wallClockToInstant('2026-01-14', '13:00', 'Europe/London');
  assert.equal(summer.toISOString(), '2026-07-14T12:00:00.000Z');
  assert.equal(winter.toISOString(), '2026-01-14T13:00:00.000Z');
});

test('a slot on the evening of a spring-forward day still lands right', () => {
  /* London springs forward at 01:00 on 29 March 2026. A slot later that
     day is in the new offset, and the first-pass guess reads the old one. */
  const after = B.wallClockToInstant('2026-03-29', '13:00', 'Europe/London');
  assert.equal(after.toISOString(), '2026-03-29T12:00:00.000Z');
});

test('an unknown zone returns null rather than a plausible wrong time', () => {
  assert.equal(B.wallClockToInstant('2026-09-14', '13:00', 'Mars/Olympus'), null);
});

test('the projected string is the one visitSlotOf already reads', () => {
  assert.equal(B.slotToVisitAt('2026-09-14', '13:00'), '2026-09-14 13:00');
  assert.equal(B.slotToVisitAt('2026-09-14', '9:05'), '2026-09-14 09:05');
  assert.equal(B.slotToVisitAt('2026-09-14', ''), '2026-09-14');
  assert.equal(B.slotToVisitAt('rubbish', '13:00'), '');
});

/* ---- handles -------------------------------------------------------- */

test('one creator cannot hold two seats by typing their handle differently', () => {
  const forms = ['@Minji', 'minji', 'MINJI/', 'https://www.instagram.com/minji/?hl=ko', ' minji '];
  const seen = new Set(forms.map(B.normHandle));
  assert.equal(seen.size, 1);
  assert.equal([...seen][0], 'minji');
});

/* ---- the claim ------------------------------------------------------ */

test('the claim filter asks the database, not this process', () => {
  const plan = B.claimPlan('slt_1', 2);
  assert.equal(plan.seats, 2);
  assert.equal(plan.filter.status, 'open');
  assert.deepEqual(plan.filter.$expr, { $lte: [{ $add: ['$booked', 2] }, '$capacity'] });
  assert.equal(plan.update.$inc.booked, 2);
});

test('a missing or silly party size claims exactly one seat', () => {
  assert.equal(B.claimPlan('slt_1').seats, 1);
  assert.equal(B.claimPlan('slt_1', 0).seats, 1);
  assert.equal(B.claimPlan('slt_1', -4).seats, 1);
  assert.equal(B.claimPlan('slt_1', 2.7).seats, 2);
});

test('release returns exactly what was claimed', () => {
  assert.equal(B.releasePlan('slt_1', 2).update.$inc.booked, -2);
  assert.equal(B.releasePlan('slt_1').update.$inc.booked, -1);
});

test('spotsLeft never exposes capacity, and never goes negative', () => {
  assert.equal(B.spotsLeft({ status: 'open', capacity: 5, booked: 3 }), 2);
  assert.equal(B.spotsLeft({ status: 'open', capacity: 2, booked: 2 }), 0);
  assert.equal(B.spotsLeft({ status: 'open', capacity: 2, booked: 9 }), 0);
  assert.equal(B.spotsLeft({ status: 'closed', capacity: 5, booked: 0 }), 0);
});

/* ---- rules ---------------------------------------------------------- */

test('the deadline is measured against the slot, at its boundary', () => {
  const start = new Date('2026-09-14T04:00:00Z');       /* 13:00 KST */
  const h = 3600000;
  assert.equal(B.deadlinePassed(start, 24, start.getTime() - 25 * h), false);
  assert.equal(B.deadlinePassed(start, 24, start.getTime() - 23 * h), true);
  /* exactly on the line is still open — the hour named is the last one */
  assert.equal(B.deadlinePassed(start, 24, start.getTime() - 24 * h), false);
  /* no deadline set: bookable right up to the slot itself */
  assert.equal(B.deadlinePassed(start, 0, start.getTime() - 60000), false);
  assert.equal(B.deadlinePassed(start, 0, start.getTime() + 60000), true);
});

test('capacity can be raised freely and never cut below what is booked', () => {
  const slot = { capacity: 4, booked: 3 };
  assert.equal(B.capacityChange(slot, 9).capacity, 9);
  assert.equal(B.capacityChange(slot, 3).ok, true);
  const bad = B.capacityChange(slot, 2);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'capacity-below-booked');
  assert.match(bad.message, /3 people have/);
  assert.equal(B.capacityChange(slot, 0).code, 'capacity-invalid');
});

test('a slot is validated before it is stored, not after', () => {
  assert.equal(B.validateSlot({ date: '2026-09-14', time: '9:00', capacity: 2 }).time, '09:00');
  assert.equal(B.validateSlot({ date: '14/09/2026', time: '09:00', capacity: 2 }).code, 'date-invalid');
  assert.equal(B.validateSlot({ date: '2026-09-14', time: '25:00', capacity: 2 }).code, 'time-invalid');
  assert.equal(B.validateSlot({ date: '2026-09-14', time: '09:00', capacity: 0 }).code, 'capacity-invalid');
});

/* ---- the projection -------------------------------------------------

   The scenario in full: a creator books 13:00 at 09:15. A colleague has
   had the dashboard open since 08:00, so their copy still says 12:00 —
   the time Notion has on file. At 09:20 they close the tab, beforeunload
   fires a save with force: true, and the revision check is skipped.
   Without this, the booking is gone and nothing says so. */

const booked = (over) => Object.assign({
  _id: 'bk_1', campaignId: 'cp_1', participantId: 'pt_1',
  date: '2026-09-14', time: '13:00', partySize: 2, status: 'confirmed'
}, over || {});

test('a stale payload is corrected on the way in, not refused', () => {
  const db = { participants: [
    { id: 'pt_1', campaignId: 'cp_1', visitAt: '2026-09-14 12:00', confirmedVisitAt: '2026-09-14 12:00' }
  ] };
  const out = B.applyBookingSlots(db, [booked()]);

  assert.equal(db.participants[0].confirmedVisitAt, '2026-09-14 13:00');
  assert.equal(db.participants[0].bookingId, 'bk_1');
  assert.equal(out.corrected.length, 1);
  assert.deepEqual(out.corrected[0], {
    participantId: 'pt_1', was: '2026-09-14 12:00', now: '2026-09-14 13:00'
  });
  /* Notion's own request is untouched — that is what trips the amber
     "moved" marker the roster already draws */
  assert.equal(db.participants[0].visitAt, '2026-09-14 12:00');
});

test('party size never reaches p.headcount — Notion owns that field', () => {
  const db = { participants: [{ id: 'pt_1', campaignId: 'cp_1', headcount: '4' }] };
  B.applyBookingSlots(db, [booked({ partySize: 2 })]);
  /* a sync of a campaign with a headcount column mapped would overwrite
     or clear anything written here, so nothing is written here */
  assert.equal(db.participants[0].headcount, '4');
});

test('a participant with no booking comes out byte-identical', () => {
  const db = { participants: [
    { id: 'pt_1', campaignId: 'cp_1', visitAt: '2026-09-14 12:00', confirmedVisitAt: '2026-09-14 12:00' },
    { id: 'pt_2', campaignId: 'cp_1', visitAt: '2026-09-15 10:00', stage: 'confirmed', headcount: '1' }
  ] };
  const before = JSON.stringify(db.participants[1]);
  B.applyBookingSlots(db, [booked()]);
  assert.equal(JSON.stringify(db.participants[1]), before);
});

test('an already-correct payload reports no corrections', () => {
  const db = { participants: [
    { id: 'pt_1', campaignId: 'cp_1', confirmedVisitAt: '2026-09-14 13:00', bookingId: 'bk_1' }
  ] };
  const out = B.applyBookingSlots(db, [booked()]);
  assert.equal(out.corrected.length, 0);
  assert.equal(out.linked, 0);
});

test('cancelled and moved bookings do not project', () => {
  const db = { participants: [{ id: 'pt_1', campaignId: 'cp_1', visitAt: '2026-09-14 12:00' }] };
  B.applyBookingSlots(db, [booked({ status: 'cancelled' }), booked({ _id: 'bk_0', status: 'moved' })]);
  assert.equal(db.participants[0].confirmedVisitAt, undefined);
  assert.equal(db.participants[0].bookingId, undefined);
});

test('an unmatched public booking touches no participant at all', () => {
  /* the seat is genuinely taken, but nobody here is claiming it yet —
     it waits for staff to match it rather than inventing a record */
  const db = { participants: [{ id: 'pt_1', campaignId: 'cp_1', visitAt: '2026-09-14 12:00' }] };
  const out = B.applyBookingSlots(db, [booked({ participantId: null, guest: { handle: '@unknown_kim' } })]);
  assert.equal(out.corrected.length, 0);
  assert.equal(db.participants[0].confirmedVisitAt, undefined);
});

test('nothing but participants is ever touched', () => {
  const db = {
    campaigns: [{ id: 'cp_1', name: 'JAIMDANG' }],
    creators: [{ id: 'cr_1', handle: 'minji' }],
    participants: [{ id: 'pt_1', campaignId: 'cp_1', confirmedVisitAt: '2026-09-14 12:00' }]
  };
  const campaigns = JSON.stringify(db.campaigns), creators = JSON.stringify(db.creators);
  B.applyBookingSlots(db, [booked()]);
  assert.equal(JSON.stringify(db.campaigns), campaigns);
  assert.equal(JSON.stringify(db.creators), creators);
});

test('a cancel drops the participant back to what Notion still says', () => {
  const db = { participants: [
    { id: 'pt_1', campaignId: 'cp_1', visitAt: '2026-09-14 12:00',
      confirmedVisitAt: '2026-09-14 13:00', bookingId: 'bk_1' }
  ] };
  assert.equal(B.clearBookingSlot(db, booked({ status: 'cancelled' })), true);
  assert.equal(db.participants[0].confirmedVisitAt, undefined);
  assert.equal(db.participants[0].bookingId, undefined);
  assert.equal(db.participants[0].visitAt, '2026-09-14 12:00');
});

test('a cancel does not clear a time confirmed by some other booking', () => {
  const db = { participants: [
    { id: 'pt_1', campaignId: 'cp_1', confirmedVisitAt: '2026-09-16 10:00', bookingId: 'bk_2' }
  ] };
  assert.equal(B.clearBookingSlot(db, booked({ _id: 'bk_1', status: 'cancelled' })), false);
  assert.equal(db.participants[0].confirmedVisitAt, '2026-09-16 10:00');
});

test('a hand-typed confirmed time is left alone when no booking claims it', () => {
  const db = { participants: [
    { id: 'pt_9', campaignId: 'cp_1', confirmedVisitAt: '2026-09-20 11:00' }
  ] };
  B.applyBookingSlots(db, [booked()]);
  assert.equal(db.participants[0].confirmedVisitAt, '2026-09-20 11:00');
});
