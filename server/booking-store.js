/* ===================================================================
   Booking: everything that can be decided without a database.

   A creator opens a link, picks a time, and the seat is theirs. The
   hard part is not the picking — it is that two creators can pick the
   same last seat in the same millisecond, and that the time one of them
   picks has to survive a dashboard tab that has been open since this
   morning saving the whole workspace over the top of it.

   This file answers both, and touches nothing:

     - It builds the filter and update documents for the atomic claim,
       so the claim is one findOneAndUpdate the database arbitrates
       rather than a read followed by a write this code would have to
       get right under contention.

     - It holds applyBookingSlots(), which re-applies every live booking
       onto an incoming workspace payload. That is what makes a booking
       safe to own a field living on the participant: the booking
       collection owns the fact, and confirmedVisitAt is a projection
       rewritten on the way in rather than trusted.

   Pure, like server/social-store.js and server/workspace-guard.js: it
   takes records and returns records, never opens a connection, reads an
   environment variable or writes to stdout. That is what lets the
   concurrency rehearsal drive it against a fixture with no database
   anywhere near it.

   Times. A slot is wall-clock at the venue — "2026-09-14", "13:00",
   "Asia/Seoul" — because that is what a person means by one o'clock.
   The instant is derived, never the stored truth, and derived with the
   same two-pass offset resolution as src/sync/gcal.js so a booking
   across a DST changeover lands on the minute the calendar sync would.
   =================================================================== */

/* ---- times ---------------------------------------------------------- */

/* Lifted from src/sync/gcal.js. Deliberately a copy rather than a shared
   import: that file is an ES module in the browser bundle, this one is
   CommonJS on the server, and the manifest that generates src/ would
   have to carry any module bridging them. Twelve lines is the cheaper
   side of that trade — and a test feeds both the same instants so the
   copy cannot drift quietly. */
function tzOffsetMinutes(utcMs, tz) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = {};
    dtf.formatToParts(new Date(utcMs)).forEach((x) => { p[x.type] = x.value; });
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day,
      +(p.hour === '24' ? 0 : p.hour), +p.minute, +p.second);
    return Math.round((asUTC - utcMs) / 60000);
  } catch (e) {
    return null;                       /* unknown zone — caller reports it */
  }
}

const pad2 = (n) => String(n).padStart(2, '0');

const normDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '').trim()) ? String(d).trim() : '');

const normTime = (t) => {
  const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '';
  const h = +m[1], mi = +m[2];
  return h > 23 || mi > 59 ? '' : pad2(h) + ':' + pad2(mi);
};

/* "2026-09-14" + "13:00" + "Asia/Seoul" -> the Date that actually is.
   null for an unknown zone or an unparseable date, so a caller refuses
   the request rather than booking something an hour out. */
function wallClockToInstant(date, time, tz) {
  const d = normDate(date);
  if (!d) return null;
  const t = normTime(time);
  const h = t ? +t.slice(0, 2) : 0, mi = t ? +t.slice(3) : 0;

  const wanted = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), h, mi);
  let off = tzOffsetMinutes(wanted, tz);
  if (off == null) return null;
  /* second pass: on a changeover the first guess lands the wrong side of
     the jump and reads back an offset that no longer applies */
  off = tzOffsetMinutes(wanted - off * 60000, tz);
  if (off == null) return null;
  return new Date(wanted - off * 60000);
}

/* The string the rest of the dashboard already speaks. joinSlot() in
   src/import/notion.js produces exactly this and visitSlotOf() reads it,
   so a booking's projection is indistinguishable from a time typed in by
   hand. That is the whole reason the calendar, roster, board, partner
   page and gcal sync need no changes. */
function slotToVisitAt(date, time) {
  const d = normDate(date);
  if (!d) return '';
  const t = normTime(time);
  return t ? d + ' ' + t : d;
}

/* ---- handles -------------------------------------------------------

   A public booking names a creator by whatever the person typed into
   the box. Same normalisation the dashboard's own de-duplication uses,
   so "@Minji", "minji/" and a pasted profile URL are one person — which
   is what stops one creator quietly holding two seats. */
function normHandle(h) {
  let s = String(h || '').trim().toLowerCase()
    .replace(/[\s​]/g, '')
    .replace(/[?#].*$/, '');
  const m = s.match(/^(?:https?:)?\/\/?(?:www\.)?(?:instagram|tiktok|youtube)\.com\/(?:@)?([^/]+)/);
  if (m) s = m[1];
  return s.replace(/^@+/, '').replace(/\/+$/, '').replace(/\.+$/, '');
}

/* ---- the claim -----------------------------------------------------

   One document, one update, arbitrated by the database. Two requests for
   the last seat: one matches the filter, the other does not, and the
   loser is told so rather than discovering it later. No transaction, no
   read-then-write, and capacity and booked never leave the server. */
function claimPlan(slotId, partySize) {
  const n = Math.max(1, Math.floor(Number(partySize) || 1));
  return {
    filter: {
      _id: slotId,
      status: 'open',
      $expr: { $lte: [{ $add: ['$booked', n] }, '$capacity'] }
    },
    update: { $inc: { booked: n }, $set: { updatedAt: new Date() } },
    seats: n
  };
}

/* The other half of every cancel, and the compensation when the insert
   fails after a successful claim. That second case is the one that
   matters: a leaked seat is invisible and permanent, and nothing else in
   the system would ever report it. Guarded by the caller on the
   booking's own status transition, so a double-tapped Cancel releases
   once. */
function releasePlan(slotId, partySize) {
  const n = Math.max(1, Math.floor(Number(partySize) || 1));
  return {
    filter: { _id: slotId },
    update: { $inc: { booked: -n }, $set: { updatedAt: new Date() } },
    seats: n
  };
}

/* What a creator is allowed to see: a number they cannot do arithmetic
   with and cannot be wrong about. Floored at zero so a slot that somehow
   over-booked reads Full rather than negative. */
function spotsLeft(slot) {
  const s = slot || {};
  if (s.status !== 'open') return 0;
  return Math.max(0, (Number(s.capacity) || 0) - (Number(s.booked) || 0));
}

/* ---- rules ---------------------------------------------------------- */

/* Re-checked server-side against the slot's own instant, never against a
   date the browser sent. deadlineHours = 0 means no deadline. */
function deadlinePassed(startsAt, deadlineHours, now) {
  const start = startsAt instanceof Date ? startsAt.getTime() : new Date(startsAt).getTime();
  if (!Number.isFinite(start)) return true;
  const hours = Number(deadlineHours) || 0;
  const nowMs = now instanceof Date ? now.getTime() : (Number(now) || Date.now());
  return nowMs > start - hours * 3600000;
}

/* Raising is unconditional. Lowering below what is already booked is
   refused with the number, because "cancel a booking first" is only
   useful if it says how many. */
function capacityChange(slot, nextCapacity) {
  const next = Math.floor(Number(nextCapacity));
  const booked = Number((slot || {}).booked) || 0;
  if (!Number.isFinite(next) || next < 1) {
    return { ok: false, code: 'capacity-invalid', message: 'Capacity has to be a whole number, 1 or more.' };
  }
  if (next < booked) {
    return {
      ok: false, code: 'capacity-below-booked', booked,
      message: booked + (booked === 1 ? ' person has' : ' people have') +
        ' already booked this slot — cancel a booking first.'
    };
  }
  return { ok: true, capacity: next };
}

function validateSlot(input) {
  const i = input || {};
  const date = normDate(i.date);
  const time = normTime(i.time);
  const capacity = Math.floor(Number(i.capacity));
  if (!date) return { ok: false, code: 'date-invalid', message: 'A slot needs a date as YYYY-MM-DD.' };
  if (!time) return { ok: false, code: 'time-invalid', message: 'A slot needs a time as HH:MM.' };
  if (!Number.isFinite(capacity) || capacity < 1) {
    return { ok: false, code: 'capacity-invalid', message: 'Capacity has to be a whole number, 1 or more.' };
  }
  return { ok: true, date, time, capacity };
}

/* ---- the projection ------------------------------------------------

   The reason a booking can own a field that lives on the participant.

   POST /api/workspace replaces the whole document from a client copy
   that may be minutes or hours old. A dashboard that loaded before a
   creator booked still carries the old confirmedVisitAt, and `force`
   skips the revision check entirely — so without this, closing a stale
   tab would quietly un-book somebody. Same shape of bug as the empty
   overwrite server/workspace-guard.js exists for, and just as silent.

   The incoming payload is corrected rather than refused. Refusing costs
   whoever is saving their actual work; the booking is the one fact here
   we know is current, so it wins and the save goes through.

   Party size is deliberately NOT written to p.headcount. Notion owns
   that field: src/import/notion.js maps a column to it and treats the
   column as authoritative *including clearing it*, so a party size
   written there would survive exactly until the next sync of that
   campaign. The booking carries partySize; the UI reads it from there.

   Returns the corrections made, so the caller can tell an open dashboard
   what moved under it instead of leaving it showing a time that is no
   longer true. */
function applyBookingSlots(db, bookings) {
  const out = { corrected: [], linked: 0 };
  const list = Array.isArray(bookings) ? bookings : [];
  if (!db || !Array.isArray(db.participants) || !list.length) return out;

  const live = new Map();
  list.forEach((b) => {
    if (!b || b.status !== 'confirmed' || !b.participantId) return;
    live.set(String(b.participantId), b);
  });
  if (!live.size) return out;

  db.participants.forEach((p) => {
    if (!p || !p.id) return;
    const b = live.get(String(p.id));
    if (!b) return;

    const slot = slotToVisitAt(b.date, b.time);
    if (!slot) return;

    if (p.confirmedVisitAt !== slot) {
      out.corrected.push({ participantId: p.id, was: p.confirmedVisitAt || '', now: slot });
      p.confirmedVisitAt = slot;
    }
    if (p.bookingId !== b._id) { p.bookingId = b._id; out.linked++; }
  });

  return out;
}

/* A cancelled booking has to stop projecting, or the visit lingers on
   the calendar after the creator called it off. Clearing confirmedVisitAt
   drops the participant back to visitAt — the time Notion still has on
   file — which is exactly what visitSlotOf() is built to do.

   Separate from applyBookingSlots so the caller states plainly which
   bookings it considers live, rather than this file inferring it. */
function clearBookingSlot(db, booking) {
  if (!db || !Array.isArray(db.participants) || !booking || !booking.participantId) return false;
  const p = db.participants.find((x) => x && String(x.id) === String(booking.participantId));
  if (!p || p.bookingId !== booking._id) return false;
  delete p.confirmedVisitAt;
  delete p.bookingId;
  return true;
}

module.exports = {
  tzOffsetMinutes, wallClockToInstant, slotToVisitAt, normDate, normTime, normHandle,
  claimPlan, releasePlan, spotsLeft,
  deadlinePassed, capacityChange, validateSlot,
  applyBookingSlots, clearBookingSlot
};
