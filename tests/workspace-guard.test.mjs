/* The guard that stops an empty workspace replacing a full one.

   This is the layer that does not trust the client, so the cases below
   are written from the server's point of view: it is handed a payload
   and the counts of what is already stored, and it has to decide
   without knowing why the payload looks the way it does. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const G = require('../server/workspace-guard.js');

const full = { campaigns: [1, 2], creators: [1, 2, 3], participants: [1] };
const empty = { campaigns: [], creators: [], participants: [] };

test('an empty payload over a stored workspace is refused', () => {
  const r = G.guardEmptyReplace({ incoming: empty, existing: full });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'empty-workspace');
  /* the message has to be usable by whoever sees it in a toast */
  assert.match(r.message, /2 campaigns/);
  assert.match(r.message, /reload the page/i);
});

test('force does not authorise it — that is a different question', () => {
  /* force settles "overwrite their revision with mine". It was never
     meant to mean "discard everything", and the guard does not read it. */
  const r = G.guardEmptyReplace({ incoming: empty, existing: full, force: true });
  assert.equal(r.ok, false);
});

test('a stated destructive intent is allowed through', () => {
  const r = G.guardEmptyReplace({ incoming: empty, existing: full, intent: G.RESET_INTENT });
  assert.equal(r.ok, true);
  assert.equal(r.reset, true);
});

test('a near-miss intent is not an intent', () => {
  for (const bad of [true, 1, 'reset', 'replace_with_empty', 'REPLACE-WITH-EMPTY', ' replace-with-empty'])
    assert.equal(G.guardEmptyReplace({ incoming: empty, existing: full, intent: bad }).ok, false,
      JSON.stringify(bad) + ' was accepted as a destructive intent');
});

test('a normal save is untouched', () => {
  assert.equal(G.guardEmptyReplace({ incoming: full, existing: full }).ok, true);
  assert.equal(G.guardEmptyReplace({ incoming: full, existing: empty }).ok, true);
});

test('the very first save into an empty database is allowed', () => {
  /* nothing to protect, so nothing is refused — otherwise a new
     deployment could never write its first workspace */
  const r = G.guardEmptyReplace({ incoming: empty, existing: empty });
  assert.equal(r.ok, true);
  assert.equal(G.guardEmptyReplace({ incoming: empty, existing: {} }).ok, true);
});

test('one surviving collection is enough to protect the other two', () => {
  /* a load that half-failed is still a load that half-failed */
  assert.equal(G.guardEmptyReplace({ incoming: empty, existing: { campaigns: [], creators: [1], participants: [] } }).ok, false);
  assert.equal(G.guardEmptyReplace({ incoming: empty, existing: { campaigns: [1], creators: [], participants: [] } }).ok, false);
  assert.equal(G.guardEmptyReplace({ incoming: empty, existing: { campaigns: [], creators: [], participants: [1] } }).ok, false);
});

test('emptiness is judged on the three collections a workspace is made of', () => {
  /* an appointment or a partner link is not evidence that the roster
     survived, so they must not wave a wipe through */
  const decoy = { campaigns: [], creators: [], participants: [], appointments: [1], partnerLinks: [1], socialContent: [1] };
  assert.equal(G.isEmptyWorkspace(decoy), true);
  assert.equal(G.guardEmptyReplace({ incoming: decoy, existing: full }).ok, false);
});

test('a malformed payload is treated as empty rather than trusted', () => {
  for (const junk of [null, undefined, {}, { campaigns: null }, { campaigns: 'nope', creators: 3 }])
    assert.equal(G.guardEmptyReplace({ incoming: junk, existing: full }).ok, false,
      'accepted junk: ' + JSON.stringify(junk));
});

test('counts are reported so the refusal can say what it saved', () => {
  const r = G.guardEmptyReplace({ incoming: empty, existing: full });
  assert.deepEqual(r.existing, { campaigns: 2, creators: 3, participants: 1 });
});

test('the client and the server agree on the intent string', async () => {
  /* two copies of one constant is a drift waiting to happen; this is
     the test that notices */
  const fs = await import('node:fs');
  const src = fs.readFileSync('src/model/db.js', 'utf8');
  const m = src.match(/RESET_INTENT\s*=\s*'([^']+)'/);
  assert.ok(m, 'the client has no RESET_INTENT');
  assert.equal(m[1], G.RESET_INTENT);
});

/* ------------------------------------------------------------------
   The guard and the booking projection, in the order POST /api/workspace
   actually runs them.

   Two separate protections meet on this path and they are not
   interchangeable. The guard answers "is this payload a wipe?" and can
   refuse the whole save. applyBookingSlots answers "is this payload's
   idea of a booked visit current?" and rewrites rather than refuses.
   Getting the order or the interaction wrong loses one of them, so the
   cases below run them together rather than one at a time.
   ------------------------------------------------------------------ */

const B = require('../server/booking-store.js');

const bookingFor = (pid, over) => Object.assign({
  _id: 'bk_1', campaignId: 'cp_1', participantId: pid,
  date: '2026-09-14', time: '13:00', status: 'confirmed'
}, over || {});

/* the shape server.js has at that point: a validated payload, the counts
   of what is stored, and the live bookings */
function saveAttempt({ incoming, existing, intent, bookings }) {
  const guard = G.guardEmptyReplace({ incoming, existing, intent });
  if (!guard.ok) return { refused: true, guard, written: null };
  const applied = B.applyBookingSlots(incoming, bookings || []);
  return { refused: false, guard, applied, written: incoming };
}

test('a stale tab cannot un-book somebody, even saving with force', () => {
  /* the whole reason the projection exists: this payload was loaded
     before the creator booked, and force skips the revision check */
  const stale = {
    campaigns: [{ id: 'cp_1' }], creators: [{ id: 'cr_1' }],
    participants: [{ id: 'pt_1', campaignId: 'cp_1', visitAt: '2026-09-14 12:00',
                    confirmedVisitAt: '2026-09-14 12:00' }]
  };
  const r = saveAttempt({ incoming: stale, existing: full, bookings: [bookingFor('pt_1')] });
  assert.equal(r.refused, false);
  assert.equal(r.written.participants[0].confirmedVisitAt, '2026-09-14 13:00');
  assert.equal(r.written.participants[0].bookingId, 'bk_1');
  assert.equal(r.applied.corrected.length, 1);
});

test('the guard refuses before any booking is written into the payload', () => {
  /* order matters: if the projection ran first, a refused save would
     still have mutated the caller's object, and the next thing to look
     at it would see a workspace that was never stored */
  const wipe = { campaigns: [], creators: [], participants: [] };
  const r = saveAttempt({ incoming: wipe, existing: full, bookings: [bookingFor('pt_1')] });
  assert.equal(r.refused, true);
  assert.equal(r.guard.code, 'empty-workspace');
  assert.deepEqual(wipe.participants, [], 'the refused payload was mutated');
});

test('a deliberate reset is not resurrected by the bookings', () => {
  /* somebody asked for the workspace to be emptied on purpose. The
     projection must not put a participant back to carry a booking. */
  const wipe = { campaigns: [], creators: [], participants: [] };
  const r = saveAttempt({ incoming: wipe, existing: full, intent: G.RESET_INTENT,
                          bookings: [bookingFor('pt_1')] });
  assert.equal(r.refused, false);
  assert.equal(r.guard.reset, true);
  assert.equal(r.written.participants.length, 0);
});

test('a booking for a roster row that has since been deleted is ignored', () => {
  /* staff removed the row while the booking still stands. This must not
     throw, and must not invent a participant to hang it on. */
  const db = { campaigns: [{ id: 'cp_1' }], creators: [{ id: 'cr_1' }],
               participants: [{ id: 'pt_other', campaignId: 'cp_1' }] };
  const out = B.applyBookingSlots(db, [bookingFor('pt_gone')]);
  assert.equal(out.corrected.length, 0);
  assert.equal(db.participants.length, 1);
  assert.equal(db.participants[0].confirmedVisitAt, undefined);
});

test('the projection never adds, removes or reorders participants', () => {
  const db = { campaigns: [], creators: [], participants: [
    { id: 'pt_1', campaignId: 'cp_1' }, { id: 'pt_2', campaignId: 'cp_1' }, { id: 'pt_3', campaignId: 'cp_1' }
  ] };
  B.applyBookingSlots(db, [bookingFor('pt_2')]);
  assert.deepEqual(db.participants.map((p) => p.id), ['pt_1', 'pt_2', 'pt_3']);
});

test('a payload with no participants array is left alone rather than crashed on', () => {
  for (const junk of [null, undefined, {}, { participants: null }, { participants: 'nope' }]) {
    const out = B.applyBookingSlots(junk, [bookingFor('pt_1')]);
    assert.deepEqual(out, { corrected: [], linked: 0 });
  }
});

test('no bookings means the payload comes through byte-identical', () => {
  const db = { campaigns: [{ id: 'cp_1' }], creators: [], participants: [
    { id: 'pt_1', campaignId: 'cp_1', confirmedVisitAt: '2026-09-20 11:00' }
  ] };
  const before = JSON.stringify(db);
  for (const none of [[], null, undefined]) B.applyBookingSlots(db, none);
  assert.equal(JSON.stringify(db), before);
});

test('two confirmed bookings for one participant resolve the same way every time', () => {
  /* the partial unique index makes this impossible in the database, so
     if it ever happens something else is already wrong — the projection
     still has to be deterministic rather than order-dependent */
  const rows = [bookingFor('pt_1', { _id: 'bk_a', time: '13:00' }),
                bookingFor('pt_1', { _id: 'bk_b', time: '15:00' })];
  const run = (list) => {
    const db = { participants: [{ id: 'pt_1', campaignId: 'cp_1' }] };
    B.applyBookingSlots(db, list);
    return db.participants[0].confirmedVisitAt;
  };
  assert.equal(run(rows), '2026-09-14 15:00');   /* the last one wins */
  assert.equal(run(rows), run(rows.slice()));    /* and does so consistently */
});
