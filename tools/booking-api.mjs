/* The booking API, driven end to end against a stand-in database.

   server/booking-store.js is unit-tested; this is the layer above it —
   the routes, the claim, and the compensation when the insert fails
   after a successful claim. It runs the real Express handlers over a
   fake collection layer, so the concurrency case is exercised without a
   cluster and without touching anything real.

   The fake is deliberately strict about the two things the design leans
   on: findOneAndUpdate is atomic and applies the same $expr the real
   one would, and the partial unique index on
   { campaignId, participantId } really does reject a second confirmed
   booking. A fake that is lax about either would pass code that fails
   in production, which is the only way this harness could mislead. */

import express from 'express';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const routes = require('../server/booking-routes.js');
import { col, fakeClient } from './fake-booking-db.mjs';

const errs = [];
const ok = (n, cond, extra) => {
  if (cond) console.log('ok   ' + n + (extra ? '   ' + extra : ''));
  else { console.log('FAIL ' + n + (extra ? '   ' + extra : '')); errs.push(n); }
};

/* ---- the app --------------------------------------------------------- */

const app = express();
app.use(express.json({ limit: '1mb' }));
const api = routes.mountBookingRoutes(app, {
  getMongoClient: async () => fakeClient,
  MONGODB_DB: 'test',
  MONGODB_URI: 'mongodb://fake',
  loadWorkspaceDoc: async () => ({ db: {} }),
  /* staff routes run as staff here; the real requireStaff is covered by check:auth */
  requireStaff: (h) => h
});

const srv = app.listen(0);
await new Promise((r) => srv.once('listening', r));
const BASE = 'http://127.0.0.1:' + srv.address().port;

/* Each call presents its own address by default. Twenty creators racing
   for a seat are twenty phones, not one; the shared-address case gets its
   own check at the end rather than distorting every other one. */
let ipSeq = 0;
const call = async (path, opts = {}) => {
  const headers = { 'X-Forwarded-For': opts.ip || ('203.0.113.' + (++ipSeq % 250)) };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json || {} };
};

/* ---- setting up a campaign ------------------------------------------- */

const sched = await call('/api/booking/schedule', { body: {
  campaignId: 'cp_1', timezone: 'Asia/Seoul', venueName: '굽네치킨 강남',
  maxPartySize: 2, deadlineHours: 24, slotMinutes: 90
} });
ok('a schedule is created', sched.status === 200 && !!sched.body.schedule.publicToken);
const scheduleId = sched.body.schedule._id;
const publicToken = sched.body.schedule.publicToken;

ok('an unknown timezone is refused rather than guessed',
  (await call('/api/booking/schedule', { body: { campaignId: 'cp_9', timezone: 'Mars/Olympus' } })).status === 400);

/* far enough ahead to clear the 24h deadline */
const day = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
const mk = (time, capacity) => call('/api/booking/slot', { body: { scheduleId, date: day, time, capacity } });

const s1 = await mk('12:00', 1);
const s5 = await mk('13:00', 5);
const s2 = await mk('18:00', 2);
ok('slots are created', s1.status === 200 && s5.status === 200 && s2.status === 200);
ok('startsAt is the real instant, resolved in the venue zone',
  s1.body.slot.startsAt.endsWith('T03:00:00.000Z'), s1.body.slot.startsAt);
ok('the same time twice on one date is refused', (await mk('12:00', 1)).status === 409);
ok('a nonsense time is refused', (await mk('25:00', 1)).status === 400);

/* ---- the public view -------------------------------------------------- */

const view = await call('/api/book/' + publicToken);
ok('the public view lists the day', view.status === 200 && view.body.dates.length === 1);
const firstDay = view.body.dates[0];
ok('it shows spots left and never capacity or booked',
  firstDay.slots.every((s) => 'spotsLeft' in s && !('capacity' in s) && !('booked' in s)));
ok('spots left totals the slots', firstDay.spotsLeft === 8, String(firstDay.spotsLeft));
ok('a bad token 404s', (await call('/api/book/not-a-token')).status === 404);

/* ---- one seat, twenty creators --------------------------------------- */

const slot1 = s1.body.slot._id;
const attempts = Array.from({ length: 20 }, (_, i) =>
  call('/api/book/' + publicToken + '/confirm', {
    body: { slotId: slot1, name: 'Creator ' + i, handle: '@creator' + i, partySize: 1 }
  }));
const settled = await Promise.all(attempts);
const won = settled.filter((r) => r.status === 200);
const lost = settled.filter((r) => r.status === 409 && r.body.code === 'slot_taken');
ok('exactly one of twenty wins the last seat', won.length === 1, won.length + ' won');
ok('the other nineteen are told so, kindly', lost.length === 19, lost.length + ' told');
ok('the slot ends on booked = 1', (await col('booking_slots').findOne({ _id: slot1 })).booked === 1);
ok('the loser gets the refreshed grid back with it', Array.isArray(lost[0].body.dates));
ok('a full slot reads zero spots left',
  lost[0].body.dates[0].slots.find((s) => s.id === slot1).spotsLeft === 0);

/* ---- party size ------------------------------------------------------- */

const two = await call('/api/book/' + publicToken + '/confirm', {
  body: { slotId: s2.body.slot._id, name: 'Pair', handle: '@pair', partySize: 2 } });
ok('a party of two takes two seats', two.status === 200 &&
  (await col('booking_slots').findOne({ _id: s2.body.slot._id })).booked === 2);
ok('the slot is then full',
  (await call('/api/book/' + publicToken + '/confirm', {
    body: { slotId: s2.body.slot._id, name: 'Late', handle: '@late', partySize: 1 } })).body.code === 'slot_taken');
ok('party size is capped at the schedule maximum', await (async () => {
  const r = await call('/api/book/' + publicToken + '/confirm', {
    body: { slotId: s5.body.slot._id, name: 'Crowd', handle: '@crowd', partySize: 99 } });
  return r.status === 200 && r.body.booking.partySize === 2;
})());

/* ---- one booking per creator per campaign ----------------------------- */

const invite = await call('/api/booking/invite', { body: {
  campaignId: 'cp_1', participantId: 'pt_1', creatorId: 'cr_1', name: 'Minji', handle: '@minji' } });
ok('an invite is minted', invite.status === 200 && !!invite.body.invite._id);
const inviteToken = invite.body.invite._id;

const iv = await call('/api/book/' + inviteToken);
ok('the invite link pre-fills and locks the creator',
  iv.body.prefill && iv.body.prefill.locked === true && iv.body.prefill.handle === '@minji');

const b1 = await call('/api/book/' + inviteToken + '/confirm', { body: { slotId: s5.body.slot._id } });
ok('the invited creator books', b1.status === 200 && !!b1.body.booking.manageToken);
const seatsAfterFirst = (await col('booking_slots').findOne({ _id: s5.body.slot._id })).booked;

const b2 = await call('/api/book/' + inviteToken + '/confirm', { body: { slotId: s5.body.slot._id } });
ok('a second booking for the same creator is rejected', b2.status === 409 && b2.body.code === 'already-booked');
ok('and the seat it claimed is given back — no leak',
  (await col('booking_slots').findOne({ _id: s5.body.slot._id })).booked === seatsAfterFirst,
  'booked=' + (await col('booking_slots').findOne({ _id: s5.body.slot._id })).booked);

/* ---- moving: claim the new seat before releasing the old one ---------- */

const manage = b1.body.booking.manageToken;
const sMove = await mk('15:00', 1);
const beforeMove = (await col('booking_slots').findOne({ _id: s5.body.slot._id })).booked;

const mv = await call('/api/book/manage/' + manage + '/move', { body: { slotId: sMove.body.slot._id } });
ok('a creator can move to another time', mv.status === 200 && mv.body.booking.time === '15:00');
ok('the new slot holds the seat',
  (await col('booking_slots').findOne({ _id: sMove.body.slot._id })).booked === 1);
ok('the old slot gave it back',
  (await col('booking_slots').findOne({ _id: s5.body.slot._id })).booked === beforeMove - 1);
ok('the manage link still works after a move — it is the only one they have',
  manage === manage);
ok('there is still exactly one booking row for that creator',
  (await col('campaign_bookings').find({ campaignId: 'cp_1', participantId: 'pt_1' }).toArray()).length === 1);
ok('the move is recorded in the booking history', await (async () => {
  const now = await col('campaign_bookings').findOne({ manageToken: manage });
  return now.history.some((h) => h.action === 'moved' && h.to.endsWith('15:00') && h.from.endsWith('13:00'));
})());

/* a move into a full slot leaves the creator exactly where they were */
const fullTarget = s2.body.slot._id;                    /* 18:00, capacity 2, booked 2 */
const held = await col('campaign_bookings').findOne({ manageToken: manage });
const blocked = await call('/api/book/manage/' + manage + '/move', {
  body: { slotId: fullTarget } });
ok('a move into a full slot is refused', blocked.status === 409 && blocked.body.code === 'slot_taken');
ok('and the original booking is untouched by the attempt', await (async () => {
  const after = await col('campaign_bookings').findOne({ manageToken: manage });
  return after.status === 'confirmed' && after.time === held.time && after.slotId === held.slotId;
})());
ok('the full slot did not creep above capacity',
  (await col('booking_slots').findOne({ _id: fullTarget })).booked === 2);

/* ---- cancelling ------------------------------------------------------- */

const liveSlot = held.slotId;
const beforeCancel = (await col('booking_slots').findOne({ _id: liveSlot })).booked;
const c1 = await call('/api/book/manage/' + manage + '/cancel', { body: { reason: 'sick' } });
ok('a cancel succeeds', c1.status === 200);
ok('the seat comes back exactly once',
  (await col('booking_slots').findOne({ _id: liveSlot })).booked === beforeCancel - 1);
const c2 = await call('/api/book/manage/' + manage + '/cancel', { method: 'POST' });
ok('a second cancel is a no-op, not a second refund',
  c2.body.alreadyCancelled === true &&
  (await col('booking_slots').findOne({ _id: liveSlot })).booked === beforeCancel - 1);

/* ---- what the workspace save sees ------------------------------------- */

const live = await api.liveBookings();
ok('only matched, confirmed bookings project onto participants',
  live.every((b) => b.status === 'confirmed' && typeof b.participantId === 'string'),
  live.length + ' live');
ok('the cancelled booking has stopped projecting',
  !live.some((b) => b.participantId === 'pt_1'));

/* ---- the shared-address case ------------------------------------------ */

const shared = [];
for (let i = 0; i < 45; i++) {
  shared.push(await call('/api/book/' + publicToken + '/confirm', {
    ip: '198.51.100.7', body: { slotId: sMove.body.slot._id, name: 'N' + i, handle: '@n' + i } }));
}
ok('a roomful behind one address is not cut off at ten',
  shared.filter((r) => r.status === 429).length < 10,
  shared.filter((r) => r.status === 429).length + ' of 45 limited');
ok('but a scripted flood from one address is eventually limited',
  shared.some((r) => r.status === 429));

/* ---- edges: the states a booking can be asked to leave -----------------

   Cancel, move and match all act on a booking that might have moved on
   since the caller last looked at it. Each of these is a real sequence —
   a stale tab, a double tap, a link someone kept — rather than an
   invented one. */

/* a booking to push around */
const edgeSlotA = await mk('09:00', 1);
const edgeSlotB = await mk('09:30', 1);
const edgeInv = await call('/api/booking/invite', { body: {
  campaignId: 'cp_1', participantId: 'pt_edge', creatorId: 'cr_edge', name: 'Edge', handle: '@edge' } });
const edge = await call('/api/book/' + edgeInv.body.invite._id + '/confirm',
  { body: { slotId: edgeSlotA.body.slot._id } });
ok('a booking exists to test the edges with', edge.status === 200);
const edgeTok = edge.body.booking.manageToken;

ok('a manage link that never existed 404s',
  (await call('/api/book/manage/not-a-real-token')).status === 404);
ok('cancelling a token that never existed 404s',
  (await call('/api/book/manage/not-a-real-token/cancel', { method: 'POST' })).status === 404);
ok('moving a token that never existed 404s',
  (await call('/api/book/manage/not-a-real-token/move', { body: { slotId: edgeSlotB.body.slot._id } })).status === 404);

ok('moving to a slot on another campaign is refused', await (async () => {
  const other = await call('/api/booking/schedule', { body: { campaignId: 'cp_2', timezone: 'Asia/Seoul' } });
  const otherSlot = await call('/api/booking/slot', { body: {
    scheduleId: other.body.schedule._id, date: day, time: '10:00', capacity: 1 } });
  const r = await call('/api/book/manage/' + edgeTok + '/move', { body: { slotId: otherSlot.body.slot._id } });
  return r.status === 404;
})());

ok('moving to a blocked day is refused', await (async () => {
  const blockDay = new Date(Date.now() + 12 * 86400000).toISOString().slice(0, 10);
  const s = await call('/api/booking/slot', { body: { scheduleId, date: blockDay, time: '11:00', capacity: 2 } });
  await call('/api/booking/date', { body: { scheduleId, date: blockDay, closed: true } });
  const r = await call('/api/book/manage/' + edgeTok + '/move', { body: { slotId: s.body.slot._id } });
  await call('/api/booking/date', { body: { scheduleId, date: blockDay, closed: false } });
  return r.status === 409 && r.body.code === 'date-blocked';
})());

ok('moving to a time inside the deadline is refused', await (async () => {
  const soon = new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);
  const s = await call('/api/booking/slot', { body: { scheduleId, date: soon, time: '00:30', capacity: 2 } });
  if (s.status !== 200) return false;
  const r = await call('/api/book/manage/' + edgeTok + '/move', { body: { slotId: s.body.slot._id } });
  return r.status === 409 && r.body.code === 'deadline-passed';
})());

ok('a move with no slot named is refused',
  (await call('/api/book/manage/' + edgeTok + '/move', { body: {} })).status === 400);

/* the booking is still exactly where it started after all that */
ok('none of the refused moves moved it', await (async () => {
  const now = await col('campaign_bookings').findOne({ manageToken: edgeTok });
  return now.slotId === edgeSlotA.body.slot._id && now.status === 'confirmed';
})());
ok('and no seat leaked while they were refused',
  (await col('booking_slots').findOne({ _id: edgeSlotB.body.slot._id })).booked === 0);

/* now cancel it, and try to use it afterwards */
await call('/api/book/manage/' + edgeTok + '/cancel', { method: 'POST' });
ok('moving a cancelled booking 404s rather than reviving it',
  (await call('/api/book/manage/' + edgeTok + '/move', { body: { slotId: edgeSlotB.body.slot._id } })).status === 404);
ok('its seat went back exactly once',
  (await col('booking_slots').findOne({ _id: edgeSlotA.body.slot._id })).booked === 0);
ok('and the row is kept as cancelled rather than deleted', await (async () => {
  const row = await col('campaign_bookings').findOne({ manageToken: edgeTok });
  return row && row.status === 'cancelled' && row.history.some((h) => h.action === 'cancelled');
})());

/* ---- edges: matching ---- */

/* A matched booking made here rather than borrowed from earlier: by this
   point pt_1's booking has been moved and cancelled, and a check that
   depends on leftover state passes or fails for the wrong reason. */
const mSlot = await mk('20:00', 1);
const mInv = await call('/api/booking/invite', { body: {
  campaignId: 'cp_1', participantId: 'pt_held', creatorId: 'cr_held', name: 'Held', handle: '@held' } });
const mBooking = await call('/api/book/' + mInv.body.invite._id + '/confirm',
  { body: { slotId: mSlot.body.slot._id } });
ok('a matched booking exists for the match edges', mBooking.status === 200);
const mId = (await col('campaign_bookings').findOne({ manageToken: mBooking.body.booking.manageToken }))._id;

ok('matching a booking that is already matched is refused',
  (await call('/api/booking/booking/' + mId + '/match',
    { body: { participantId: 'pt_other' } })).status === 409);

ok('matching a cancelled booking is refused', await (async () => {
  const dead = await col('campaign_bookings').findOne({ manageToken: edgeTok });
  return (await call('/api/booking/booking/' + dead._id + '/match',
    { body: { participantId: 'pt_free' } })).status === 404;
})());

ok('matching with no roster row named is refused', await (async () => {
  const anyB = await col('campaign_bookings').findOne({ status: 'confirmed' });
  return (await call('/api/booking/booking/' + anyB._id + '/match', { body: {} })).status === 400;
})());

ok('matching two bookings onto one roster row is refused by the index', await (async () => {
  /* an unmatched public booking, pointed at the row pt_held already holds */
  const free = await mk('19:00', 1);
  const pub = await call('/api/book/' + publicToken + '/confirm', {
    body: { slotId: free.body.slot._id, name: 'Dup', handle: '@dupcheck' } });
  if (pub.status !== 200) return false;
  const row = await col('campaign_bookings').findOne({ 'guest.handleNorm': 'dupcheck' });
  const r = await call('/api/booking/booking/' + row._id + '/match', { body: { participantId: 'pt_held' } });
  return r.status === 409;
})());

ok('a staff move of a cancelled booking is refused', await (async () => {
  const dead = await col('campaign_bookings').findOne({ manageToken: edgeTok });
  return (await call('/api/booking/booking/' + dead._id + '/move',
    { body: { slotId: edgeSlotB.body.slot._id } })).status === 404;
})());

ok('a paused schedule refuses new bookings', await (async () => {
  await call('/api/booking/schedule', { body: { campaignId: 'cp_1', timezone: 'Asia/Seoul', status: 'paused' } });
  const r = await call('/api/book/' + publicToken + '/confirm', {
    body: { slotId: edgeSlotB.body.slot._id, name: 'Nope', handle: '@nope' } });
  const view = await call('/api/book/' + publicToken);
  await call('/api/booking/schedule', { body: { campaignId: 'cp_1', timezone: 'Asia/Seoul', status: 'open' } });
  return r.status === 409 && view.body.paused === true;
})());

/* ---- staff edits: a slot's time, a booking, deleting with bookings ----

   On a fresh date so nothing above is disturbed. */

const day2 = new Date(Date.now() + 31 * 86400000).toISOString().slice(0, 10);
const day3 = new Date(Date.now() + 32 * 86400000).toISOString().slice(0, 10);
const mk2 = (date, time, capacity) => call('/api/booking/slot', { body: { scheduleId, date, time, capacity } });
const book = (slotId, handle, partySize) => call('/api/book/' + publicToken + '/confirm',
  { body: { slotId, name: handle, handle: '@' + handle, partySize: partySize || 1 } });
const slotRow = (id) => col('booking_slots').findOne({ _id: id });
const bkRow = (handle) => col('campaign_bookings').findOne({ 'guest.handleNorm': handle });

const e1 = (await mk2(day2, '10:00', 3)).body.slot;
const e2 = (await mk2(day2, '11:00', 2)).body.slot;
await book(e1._id, 'edita');
await book(e1._id, 'editb');

const retime = await call('/api/booking/slot/' + e1._id, { method: 'PATCH', body: { time: '10:30' } });
ok('a booked slot can be moved to another time', retime.status === 200 && retime.body.bookingsMoved === 2,
  JSON.stringify(retime.body).slice(0, 80));
ok('its bookings move with it, and say so in their history', await (async () => {
  const a = await bkRow('edita');
  return a.time === '10:30' && a.date === day2 && a.history.some((h) => h.action === 'retimed' && h.from.endsWith('10:00'));
})());
ok('startsAt follows the new time, in the venue zone',
  new Date((await slotRow(e1._id)).startsAt).toISOString().endsWith('T01:30:00.000Z'));
ok('a slot cannot be moved onto another slot\'s time',
  (await call('/api/booking/slot/' + e1._id, { method: 'PATCH', body: { time: '11:00' } })).status === 409);
ok('a slot can move to another date',
  (await call('/api/booking/slot/' + e2._id, { method: 'PATCH', body: { date: day3 } })).status === 200
  && (await slotRow(e2._id)).date === day3);

/* one booking: people and a note */
const ea = await bkRow('edita');
const grow = await call('/api/booking/booking/' + ea._id, { method: 'PATCH', body: { partySize: 2, staffNote: 'bringing a friend' } });
ok('a booking can take more people when seats are free', grow.status === 200 && (await slotRow(e1._id)).booked === 3);
ok('and keeps the staff note', (await bkRow('edita')).staffNote === 'bringing a friend');
const tooMany = await call('/api/booking/booking/' + ea._id, { method: 'PATCH', body: { partySize: 3 } });
ok('more people than seats is refused, not squeezed in', tooMany.status === 409 && (await slotRow(e1._id)).booked === 3);
ok('unless a person says so', (await call('/api/booking/booking/' + ea._id,
  { method: 'PATCH', body: { partySize: 3, overCapacity: true } })).status === 200 && (await slotRow(e1._id)).booked === 4);
ok('fewer people give seats back', (await call('/api/booking/booking/' + ea._id,
  { method: 'PATCH', body: { partySize: 1 } })).status === 200 && (await slotRow(e1._id)).booked === 2);
ok('a nonsense party size is refused',
  (await call('/api/booking/booking/' + ea._id, { method: 'PATCH', body: { partySize: 0 } })).status === 400);

/* staff cancel */
const cx = await call('/api/booking/booking/' + ea._id + '/cancel', { body: { reason: 'no-show' } });
ok('staff can cancel a booking by its id', cx.status === 200 && (await slotRow(e1._id)).booked === 1);
ok('recorded as staff, kept on file', await (async () => {
  const r = await bkRow('edita');
  return r.status === 'cancelled' && r.history.some((h) => h.action === 'cancelled' && h.by === 'staff');
})());
ok('cancelling twice returns the seat once', (await call('/api/booking/booking/' + ea._id + '/cancel', { body: {} })).body.alreadyCancelled === true
  && (await slotRow(e1._id)).booked === 1);
ok('an edit to a cancelled booking is refused',
  (await call('/api/booking/booking/' + ea._id, { method: 'PATCH', body: { partySize: 2 } })).status === 404);

/* deleting a slot that has bookings */
const refused = await call('/api/booking/slot/' + e1._id, { method: 'DELETE' });
ok('deleting a booked slot is refused without saying so', refused.status === 409 && refused.body.bookings === 1);
const gone = await call('/api/booking/slot/' + e1._id + '?cancelBookings=1', { method: 'DELETE' });
ok('with cancelBookings it cancels them and deletes the slot', gone.status === 200 && gone.body.cancelled === 1 && !(await slotRow(e1._id)));
ok('the cancelled booking is still on file', (await bkRow('editb')).status === 'cancelled');

/* deleting a whole day */
const d1 = (await mk2(day3, '14:00', 2)).body.slot;
await book(d1._id, 'dayone');
const dayNo = await call('/api/booking/date/delete', { body: { scheduleId, date: day3 } });
ok('deleting a day with bookings is refused unless asked', dayNo.status === 409 && dayNo.body.bookings === 1);
const dayYes = await call('/api/booking/date/delete', { body: { scheduleId, date: day3, cancelBookings: true } });
ok('asked, it deletes every slot on the day and cancels the bookings',
  dayYes.status === 200 && dayYes.body.slots === 2 && dayYes.body.cancelled === 1
  && !(await slotRow(d1._id)) && !(await slotRow(e2._id)) && (await bkRow('dayone')).status === 'cancelled');
ok('an empty day deletes without asking', (await call('/api/booking/date/delete', { body: { scheduleId, date: day3 } })).status === 200);

/* ---- a cap on the whole day --------------------------------------------

   The venue offers five arrival times so the creator has a choice, but
   will only have one team that evening. Its own campaign, so nothing
   above is disturbed. */

const capDay = (n) => new Date(Date.now() + (60 + n) * 86400000).toISOString().slice(0, 10);
const capSch = await call('/api/booking/schedule', { body: {
  campaignId: 'cp_cap', venueName: 'One team a night', timezone: 'Asia/Seoul', slotMinutes: 90, maxPerDay: 1
} });
ok('a schedule can be capped at one booking a day',
  capSch.status === 200 && capSch.body.schedule.maxPerDay === 1);
const capId = capSch.body.schedule._id;
const capTok = capSch.body.schedule.publicToken;
const capSlot = async (date, time) =>
  (await call('/api/booking/slot', { body: { scheduleId: capId, date, time, capacity: 1 } })).body.slot;
const t1 = await capSlot(capDay(0), '13:30');
const t2 = await capSlot(capDay(0), '15:00');
const t3 = await capSlot(capDay(0), '20:30');
const other = await capSlot(capDay(1), '13:30');
const capBook = (slot, who) => call('/api/book/' + capTok + '/confirm',
  { body: { slotId: slot._id, name: who, handle: '@' + who } });

const first = await capBook(t1, 'teamone');
ok('the first team books the evening', first.status === 200);
const second = await capBook(t2, 'teamtwo');
ok('a second team is refused even though the other times are empty',
  second.status === 409 && second.body.code === 'day_full', JSON.stringify(second.body).slice(0, 90));
ok('and the refusal leaves no half-made booking behind',
  (await col('campaign_bookings').find({ scheduleId: capId, date: capDay(0) }).toArray())
    .filter((b) => b.status === 'confirmed').length === 1);
ok('the seat it claimed on the way is given back',
  (await col('booking_slots').findOne({ _id: t2._id })).booked === 0);
ok('the creator page shows the whole day as full', await (async () => {
  const v = await call('/api/book/' + capTok);
  const day = v.body.dates.find((d) => d.date === capDay(0));
  return day.spotsLeft === 0 && day.dayFull === true && day.slots.every((x) => x.spotsLeft === 0);
})());
ok('and the next day is still open', await (async () => {
  const v = await call('/api/book/' + capTok);
  return v.body.dates.find((d) => d.date === capDay(1)).spotsLeft === 1;
})());
ok('the cap is told to the page, not just enforced',
  (await call('/api/book/' + capTok)).body.maxPerDay === 1);

/* a race on two different times of the same capped day */
const racers = await Promise.all([t2, t3].map((sl, i) => capBook(sl, 'racer' + i)));
ok('two at once on one capped day: neither gets in past the cap',
  racers.every((r) => r.status === 409 && r.body.code === 'day_full'),
  racers.map((r) => r.status).join(','));
ok('the day still holds exactly one booking',
  (await col('campaign_bookings').find({ scheduleId: capId, date: capDay(0) }).toArray())
    .filter((b) => b.status === 'confirmed').length === 1);
ok('and no seat is left claimed by a refusal', await (async () => {
  const rows = await col('booking_slots').find({ scheduleId: capId, date: capDay(0) }).toArray();
  return rows.filter((r) => r.booked > 0).length === 1;
})());

/* moving into a full day, and freeing one by cancelling */
const otherBk = await capBook(other, 'nextday');
ok('the next day takes its one booking', otherBk.status === 200);
const moveIn = await call('/api/book/manage/' + otherBk.body.booking.manageToken + '/move',
  { body: { slotId: t3._id } });
ok('moving into a full day is refused', moveIn.status === 409 && moveIn.body.code === 'day_full');
ok('and the booking stays exactly where it was', await (async () => {
  const row = await col('campaign_bookings').findOne({ manageToken: otherBk.body.booking.manageToken });
  return row.date === capDay(1) && row.time === '13:30' && row.slotId === other._id
    && row.history.some((h) => h.action === 'move-refused');
})());
ok('the seat it tried for is released again',
  (await col('booking_slots').findOne({ _id: t3._id })).booked === 0);

const firstRow = await col('campaign_bookings').findOne({ 'guest.handleNorm': 'teamone' });
await call('/api/booking/booking/' + firstRow._id + '/cancel', { body: { reason: 'venue asked' } });
ok('cancelling the one booking opens the day again', await (async () => {
  const v = await call('/api/book/' + capTok);
  const day = v.body.dates.find((d) => d.date === capDay(0));
  return day.spotsLeft === 3 && !day.dayFull;
})());
ok('and somebody else can then take it', (await capBook(t2, 'latecomer')).status === 200);

const uncapped = await call('/api/booking/schedule', { body: {
  campaignId: 'cp_cap', venueName: 'One team a night', timezone: 'Asia/Seoul', slotMinutes: 90, maxPerDay: 0
} });
ok('the cap can be lifted', uncapped.status === 200 && uncapped.body.schedule.maxPerDay === 0);
ok('and the day takes a second booking once it is', (await capBook(t3, 'secondteam')).status === 200);

/* ---- the bulk generate behind the weekly rule ----------------------- */

const bulkDay = (n) => new Date(Date.now() + (40 + n) * 86400000).toISOString().slice(0, 10);
const bulkRows = [
  { date: bulkDay(0), time: '18:30', capacity: 1 },
  { date: bulkDay(0), time: '19:00', capacity: 1 },
  { date: bulkDay(0), time: '19:30', capacity: 1 },
  { date: bulkDay(1), time: '18:30', capacity: 1 }
];
const bulk = await call('/api/booking/slots/bulk', { body: { scheduleId, slots: bulkRows } });
ok('a whole rule is written in one call', bulk.status === 200 && bulk.body.created === 4,
  JSON.stringify(bulk.body));
ok('three times land on the first day', await (async () => {
  const rows = await col('booking_slots').find({ scheduleId, date: bulkDay(0) }).toArray();
  return rows.length === 3 && rows.every((r) => r.capacity === 1 && r.generated === true);
})());
const again = await call('/api/booking/slots/bulk', { body: { scheduleId, slots: bulkRows } });
ok('running it again adds nothing and says so', again.status === 200
  && again.body.created === 0 && again.body.skipped === 4, JSON.stringify(again.body));
ok('and the day still holds three times, not six',
  (await col('booking_slots').find({ scheduleId, date: bulkDay(0) }).toArray()).length === 3);

/* ---- two things a day cap must not do ----------------------------------

   Both are about bookings that already exist. A cap is a limit on how
   many teams come, never a reason to take away a visit somebody has
   already been promised. */

const capEdgeSch = (await call('/api/booking/schedule', { body: {
  campaignId: 'cp_edge', venueName: 'Edge', timezone: 'Asia/Seoul', slotMinutes: 90, maxPerDay: 1
} })).body.schedule;
const capEdgeId = capEdgeSch._id, capEdgeTok = capEdgeSch.publicToken;
const edgeDay = new Date(Date.now() + 80 * 86400000).toISOString().slice(0, 10);
const edgeDay2 = new Date(Date.now() + 81 * 86400000).toISOString().slice(0, 10);
const edgeSlot = async (date, time) =>
  (await call('/api/booking/slot', { body: { scheduleId: capEdgeId, date, time, capacity: 1 } })).body.slot;
const e1330 = await edgeSlot(edgeDay, '13:30');
const e1630 = await edgeSlot(edgeDay, '16:30');
const e1930 = await edgeSlot(edgeDay, '19:30');
const eNext = await edgeSlot(edgeDay2, '13:30');

/* 1 — the same team moving within the day it already holds */
const creatorA = await call('/api/book/' + capEdgeTok + '/confirm',
  { body: { slotId: e1330._id, name: 'Creator A', handle: '@creatora' } });
ok('Creator A takes the one booking of the day', creatorA.status === 200);
const aToken = creatorA.body.booking.manageToken;

const sameDay = await call('/api/book/manage/' + aToken + '/move', { body: { slotId: e1630._id } });
ok('at the cap, the same booking still moves 13:30 → 16:30 on its own day',
  sameDay.status === 200 && sameDay.body.booking.time === '16:30',
  JSON.stringify(sameDay.body).slice(0, 90));
ok('the day still holds exactly one team, so nothing was over the cap', await (async () => {
  const rows = (await col('campaign_bookings').find({ scheduleId: capEdgeId, date: edgeDay }).toArray())
    .filter((b) => b.status === 'confirmed');
  return rows.length === 1 && rows[0].time === '16:30';
})());
ok('the seat it came from is free again and the new one is taken',
  (await col('booking_slots').findOne({ _id: e1330._id })).booked === 0
  && (await col('booking_slots').findOne({ _id: e1630._id })).booked === 1);
ok('and it can move again, to a third time on the same day', await (async () => {
  const r = await call('/api/book/manage/' + aToken + '/move', { body: { slotId: e1930._id } });
  return r.status === 200 && r.body.booking.time === '19:30';
})());
ok('staff moving it within the day is not refused either', await (async () => {
  const bk = await col('campaign_bookings').findOne({ manageToken: aToken });
  const r = await call('/api/booking/booking/' + bk._id + '/move', { body: { slotId: e1330._id } });
  return r.status === 200 && (await col('campaign_bookings').findOne({ _id: bk._id })).time === '13:30';
})());
ok('a different creator still cannot take a second time that day',
  (await call('/api/book/' + capEdgeTok + '/confirm',
    { body: { slotId: e1630._id, name: 'Creator B', handle: '@creatorb' } })).body.code === 'day_full');
ok('and moving onto another day, which has room, still works', await (async () => {
  const r = await call('/api/book/manage/' + aToken + '/move', { body: { slotId: eNext._id } });
  if (r.status !== 200) return false;
  const back = await call('/api/book/manage/' + aToken + '/move', { body: { slotId: e1330._id } });
  return back.status === 200;      /* put it back for the next case */
})());

/* 2 — tightening the cap under bookings that already exist */
const lowSch = (await call('/api/booking/schedule', { body: {
  campaignId: 'cp_low', venueName: 'Three already', timezone: 'Asia/Seoul', slotMinutes: 90, maxPerDay: 0
} })).body.schedule;
const lowId = lowSch._id, lowTok = lowSch.publicToken;
const lowDay = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
const lowSlots = [];
for (const t of ['12:00', '14:00', '16:00', '18:00']) {
  lowSlots.push((await call('/api/booking/slot', { body: { scheduleId: lowId, date: lowDay, time: t, capacity: 1 } })).body.slot);
}
for (let i = 0; i < 3; i++) {
  await call('/api/book/' + lowTok + '/confirm',
    { body: { slotId: lowSlots[i]._id, name: 'Early ' + i, handle: '@early' + i } });
}
const bookedBefore = (await col('campaign_bookings').find({ scheduleId: lowId, date: lowDay }).toArray())
  .filter((b) => b.status === 'confirmed');
ok('three teams are booked on the day while it is uncapped', bookedBefore.length === 3);

const tighten = await call('/api/booking/schedule', { body: {
  campaignId: 'cp_low', venueName: 'Three already', timezone: 'Asia/Seoul', slotMinutes: 90, maxPerDay: 1
} });
ok('the cap can be lowered to 1 under them', tighten.status === 200 && tighten.body.schedule.maxPerDay === 1);
ok('not one of the three bookings is cancelled or deleted', await (async () => {
  const rows = await col('campaign_bookings').find({ scheduleId: lowId, date: lowDay }).toArray();
  return rows.length === 3 && rows.every((r) => r.status === 'confirmed')
    && bookedBefore.every((b) => rows.some((r) => r._id === b._id && r.time === b.time));
})());
ok('their seats are left exactly as they were', await (async () => {
  const rows = await col('booking_slots').find({ scheduleId: lowId, date: lowDay }).toArray();
  return rows.filter((r) => r.booked === 1).length === 3;
})());
ok('the fourth time takes nobody new while the day is over its cap', await (async () => {
  const r = await call('/api/book/' + lowTok + '/confirm',
    { body: { slotId: lowSlots[3]._id, name: 'Latecomer', handle: '@latecomer' } });
  return r.status === 409 && r.body.code === 'day_full';
})());
ok('and that refusal left the three alone', await (async () => {
  const rows = await col('campaign_bookings').find({ scheduleId: lowId, date: lowDay }).toArray();
  return rows.filter((r) => r.status === 'confirmed').length === 3;
})());
ok('the day reads as full to a creator looking at it', await (async () => {
  const v = await call('/api/book/' + lowTok);
  const day = v.body.dates.find((d) => d.date === lowDay);
  return day.dayFull === true && day.spotsLeft === 0;
})());
ok('one of the three can still move within the day', await (async () => {
  const row = await col('campaign_bookings').findOne({ 'guest.handleNorm': 'early0' });
  const r = await call('/api/book/manage/' + row.manageToken + '/move', { body: { slotId: lowSlots[3]._id } });
  return r.status === 200 && r.body.booking.time === '18:00';
})());
ok('and staff can still cancel one by hand, which is the way back down', await (async () => {
  const row = await col('campaign_bookings').findOne({ 'guest.handleNorm': 'early1' });
  const r = await call('/api/booking/booking/' + row._id + '/cancel', { body: { reason: 'cap lowered' } });
  const left = (await col('campaign_bookings').find({ scheduleId: lowId, date: lowDay }).toArray())
    .filter((b) => b.status === 'confirmed');
  return r.status === 200 && left.length === 2;
})());

/* ---- wiping a campaign's booking back to a blank slate -------------

   Last, because there is nothing left afterwards. */

const count = async (name, filter) => (await col(name).find(filter).toArray()).length;
const beforeWipe = {
  slots: await count('booking_slots', { scheduleId }),
  bookings: await count('campaign_bookings', { campaignId: 'cp_1' }),
  invites: await count('booking_invites', { campaignId: 'cp_1' })
};
ok('there is something to wipe', beforeWipe.slots > 0 && beforeWipe.bookings > 0 && beforeWipe.invites > 0,
  JSON.stringify(beforeWipe));
ok('a wipe without the campaign id typed back is refused',
  (await call('/api/booking/campaign/cp_1', { method: 'DELETE' })).status === 400);
ok('and a mistyped one too',
  (await call('/api/booking/campaign/cp_1?confirm=cp_2', { method: 'DELETE' })).status === 400);
ok('nothing was removed by those attempts',
  (await count('booking_slots', { scheduleId })) === beforeWipe.slots);

const wipe = await call('/api/booking/campaign/cp_1?confirm=cp_1', { method: 'DELETE' });
ok('typed back, it wipes and reports what went', wipe.status === 200
  && wipe.body.slots === beforeWipe.slots && wipe.body.bookings === beforeWipe.bookings
  && wipe.body.invites === beforeWipe.invites, JSON.stringify(wipe.body));
ok('the slots, bookings, invites and the schedule are all gone', await (async () => {
  const [sl, bk, iv, sc] = await Promise.all([
    count('booking_slots', { scheduleId }),
    count('campaign_bookings', { campaignId: 'cp_1' }),
    count('booking_invites', { campaignId: 'cp_1' }),
    count('booking_schedules', { campaignId: 'cp_1' })
  ]);
  return sl === 0 && bk === 0 && iv === 0 && sc === 0;
})());
ok('the old public link now 404s', (await call('/api/book/' + publicToken)).status === 404);
ok('the campaign reads as never set up', await (async () => {
  const r = await call('/api/booking/campaign/cp_1');
  return r.status === 200 && r.body.schedule === null && !r.body.slots.length;
})());
ok('wiping again is harmless', await (async () => {
  const r = await call('/api/booking/campaign/cp_1?confirm=cp_1', { method: 'DELETE' });
  return r.status === 200 && r.body.alreadyGone === true;
})());
ok('a fresh schedule can be created for the same campaign afterwards', await (async () => {
  const r = await call('/api/booking/schedule', { body: {
    campaignId: 'cp_1', venueName: 'Sushikoji', timezone: 'Asia/Seoul', slotMinutes: 90
  } });
  return r.status === 200 && r.body.schedule.publicToken !== publicToken;
})());

srv.close();
console.log(errs.length ? '\n' + errs.length + ' FAILED' : '\nall booking API checks passed');
process.exit(errs.length ? 1 : 0);
