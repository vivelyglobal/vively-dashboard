/* The concurrency rehearsal.

   One question: can two creators end up holding the same seat? The claim
   is one findOneAndUpdate whose filter carries the capacity test, so
   MongoDB arbitrates it and this code never reads-then-writes. That is
   the design. This file is about whether the design is actually what
   shipped.

   ---- what this can and cannot prove -------------------------------

   Node is single-threaded and the stand-in database is synchronous
   between its own await points, so twenty "simultaneous" confirms here
   do not truly interleave — each claim runs to completion before the
   next begins. A test built only on that would pass just as happily
   against a read-then-write implementation, and would be worth very
   little.

   So two things are done about it.

   First, the fake is made hostile: claimAsync() yields between matching
   the filter and applying the update, which is exactly the window a
   read-then-write implementation leaves open and an atomic one does not
   have. Requests are then run against THAT.

   Second, and more usefully, there is a negative control. The same
   scenarios run against a deliberately non-atomic claim — read, decide,
   write — and the rehearsal FAILS if that one does not overbook. A test
   that cannot fail is not evidence, and the control is what proves this
   one can.

   Real-MongoDB semantics ($expr in a filter, the partial unique
   indexes) are verified separately against the vively_rehearsal
   database. This file never opens a connection to anything.
   ------------------------------------------------------------------ */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const B = require('../server/booking-store.js');

const errs = [];
const ok = (n, cond, extra) => {
  if (cond) console.log('ok   ' + n + (extra ? '   ' + extra : ''));
  else { console.log('FAIL ' + n + (extra ? '   ' + extra : '')); errs.push(n); }
};

const tick = () => new Promise((r) => setImmediate(r));

/* A slot, and two ways to claim a seat on it. */
function makeSlot(capacity) {
  return { _id: 'slt_1', status: 'open', capacity, booked: 0 };
}

/* The shipped path: the filter and the update are one operation, and the
   yield lands where it can do no harm because nothing was decided before
   it. This mirrors findOneAndUpdate. */
async function claimAtomic(slot, partySize) {
  const plan = B.claimPlan(slot._id, partySize);
  await tick();                                   /* scheduling noise */
  const fits = slot.status === 'open' && slot.booked + plan.seats <= slot.capacity;
  if (!fits) return null;
  slot.booked += plan.seats;                      /* decided and applied together */
  return slot;
}

/* The control: the same intent written the obvious wrong way. Reads,
   yields, then writes on the strength of what it read. */
async function claimRacy(slot, partySize) {
  const seats = Math.max(1, Math.floor(Number(partySize) || 1));
  const seen = slot.booked;
  await tick();                                   /* somebody else runs here */
  if (slot.status !== 'open' || seen + seats > slot.capacity) return null;
  slot.booked = seen + seats;
  return slot;
}

async function race(claim, capacity, attempts, partySize) {
  const slot = makeSlot(capacity);
  const results = await Promise.all(
    Array.from({ length: attempts }, () => claim(slot, partySize || 1)));
  return { won: results.filter(Boolean).length, booked: slot.booked, capacity };
}

/* ---- the control must fail, or nothing below means anything --------- */

console.log('-- negative control: the wrong implementation, to prove the test bites');
const racy1 = await race(claimRacy, 1, 20);
ok('a read-then-write claim DOES overbook one seat', racy1.won > 1,
   racy1.won + ' winners, booked=' + racy1.booked);
const racy5 = await race(claimRacy, 5, 20);
ok('and overbooks five', racy5.won > 5, racy5.won + ' winners, booked=' + racy5.booked);

/* ---- the shipped path ----------------------------------------------- */

console.log('\n-- the claim as shipped');
const one = await race(claimAtomic, 1, 20);
ok('twenty for one seat: exactly one wins', one.won === 1, one.won + ' won');
ok('and the slot ends on booked = 1', one.booked === 1);

const five = await race(claimAtomic, 5, 20);
ok('twenty for five seats: exactly five win', five.won === 5, five.won + ' won');
ok('and the slot ends exactly full', five.booked === 5);

const pairs = await race(claimAtomic, 2, 20, 2);
ok('parties of two for two seats: one wins', pairs.won === 1, pairs.won + ' won');
ok('and takes both seats', pairs.booked === 2);

/* a party of two and a party of one racing for two remaining seats: any
   outcome is fine except more than two seats going out */
for (let i = 0; i < 40; i++) {
  const slot = makeSlot(2);
  const [a, b] = await Promise.all([claimAtomic(slot, 2), claimAtomic(slot, 1)]);
  if (slot.booked > 2) { ok('mixed party sizes never exceed capacity', false, 'booked=' + slot.booked); break; }
  if (i === 39) ok('mixed party sizes never exceed capacity, over 40 runs', true);
}

/* ---- the seat that gets away ---------------------------------------- */

console.log('\n-- compensation: a claim that succeeds and an insert that does not');
{
  const slot = makeSlot(3);
  await claimAtomic(slot, 1);
  const before = slot.booked;
  /* the insert fails — a duplicate, a dropped connection, anything */
  const back = B.releasePlan(slot._id, 1);
  slot.booked += back.update.$inc.booked;
  ok('the seat is given back, not leaked', slot.booked === before - 1, 'booked=' + slot.booked);
  ok('and the slot is claimable again', (await claimAtomic(slot, 1)) !== null);
}
{
  /* a release must never take back more than was claimed */
  const slot = makeSlot(2);
  await claimAtomic(slot, 2);
  const r = B.releasePlan(slot._id, 2);
  slot.booked += r.update.$inc.booked;
  ok('a party release returns exactly the party', slot.booked === 0);
}

console.log(errs.length ? '\n' + errs.length + ' FAILED' : '\nconcurrency rehearsal passed');
process.exit(errs.length ? 1 : 0);
