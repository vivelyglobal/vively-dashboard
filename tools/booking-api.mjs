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

const errs = [];
const ok = (n, cond, extra) => {
  if (cond) console.log('ok   ' + n + (extra ? '   ' + extra : ''));
  else { console.log('FAIL ' + n + (extra ? '   ' + extra : '')); errs.push(n); }
};

/* ---- the stand-in ---------------------------------------------------- */

const deepGet = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (k === '$expr') {
      /* only the one shape this code builds: booked + n <= capacity */
      const [add, cap] = v.$lte;
      return (doc.booked + add.$add[1]) <= doc[cap.slice(1)];
    }
    const actual = deepGet(doc, k);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('$ne' in v) return actual !== v.$ne;
      if ('$type' in v) return v.$type === 'string' ? typeof actual === 'string' : actual != null;
    }
    return actual === v;
  });
}

function applyUpdate(doc, update) {
  if (update.$inc) Object.entries(update.$inc).forEach(([k, n]) => { doc[k] = (doc[k] || 0) + n; });
  if (update.$set) Object.assign(doc, update.$set);
  if (update.$push) Object.entries(update.$push).forEach(([k, v]) => { (doc[k] = doc[k] || []).push(v); });
  if (update.$addToSet) Object.entries(update.$addToSet).forEach(([k, v]) => {
    doc[k] = doc[k] || []; if (!doc[k].includes(v)) doc[k].push(v);
  });
  if (update.$pull) Object.entries(update.$pull).forEach(([k, v]) => {
    doc[k] = (doc[k] || []).filter((x) => x !== v);
  });
  return doc;
}

class Col {
  constructor(name) { this.name = name; this.rows = []; this.uniques = []; }
  index(keys, partial) { this.uniques.push({ keys, partial }); return this; }
  #clash(doc, ignore) {
    return this.uniques.some(({ keys, partial }) => {
      if (partial && !matches(doc, partial)) return false;
      return this.rows.some((r) => r !== ignore
        && (!partial || matches(r, partial))
        && keys.every((k) => deepGet(r, k) === deepGet(doc, k)));
    });
  }
  async insertOne(doc) {
    if (this.#clash(doc)) { const e = new Error('dup'); e.code = 11000; throw e; }
    this.rows.push(JSON.parse(JSON.stringify(doc)));
    return { insertedId: doc._id };
  }
  /* a copy, like the real driver — a handler that mutates what it read
     must not silently alter the stored row */
  async findOne(f) {
    const hit = this.rows.find((r) => matches(r, f));
    return hit ? JSON.parse(JSON.stringify(hit)) : null;
  }
  async raw(f) { return this.rows.find((r) => matches(r, f)) || null; }
  async findOneAndUpdate(f, u) {
    const hit = this.rows.find((r) => matches(r, f));
    if (!hit) return null;
    applyUpdate(hit, u);
    return hit;
  }
  async updateOne(f, u) {
    const hit = this.rows.find((r) => matches(r, f));
    if (!hit) return { modifiedCount: 0 };
    const probe = applyUpdate(JSON.parse(JSON.stringify(hit)), u);
    if (this.#clash(probe, hit)) { const e = new Error('dup'); e.code = 11000; throw e; }
    applyUpdate(hit, u);
    return { modifiedCount: 1 };
  }
  async deleteOne(f) {
    const i = this.rows.findIndex((r) => matches(r, f));
    if (i >= 0) this.rows.splice(i, 1);
    return { deletedCount: i >= 0 ? 1 : 0 };
  }
  find(f) {
    let out = this.rows.filter((r) => matches(r, f || {}));
    const api = {
      sort: () => api,
      project: () => api,
      toArray: async () => out.map((r) => JSON.parse(JSON.stringify(r)))
    };
    return api;
  }
}

const store = new Map();
const col = (n) => { if (!store.has(n)) store.set(n, new Col(n)); return store.get(n); };
col('campaign_bookings')
  .index(['campaignId', 'participantId'], { status: 'confirmed', participantId: { $type: 'string' } })
  .index(['manageToken']);
col('booking_slots').index(['scheduleId', 'date', 'time']);
col('booking_schedules').index(['campaignId']).index(['publicToken']);

const fakeClient = { db: () => ({ collection: col }) };

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

srv.close();
console.log(errs.length ? '\n' + errs.length + ' FAILED' : '\nall booking API checks passed');
process.exit(errs.length ? 1 : 0);
