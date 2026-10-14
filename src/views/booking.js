import { parseVisitSlot } from '../import/notion.js';
import { DAY, TODAY, dLabel, iso } from '../lib/dates.js';
import { DB, byCreator, notify, persist } from '../model/db.js';
import { SETTINGS, isBlocked } from '../model/settings.js';
import { partsOf } from '../model/stats.js';
import { $, $$, esc } from '../ui/dom.js';
import { copyText, flagMark, statCard } from '../ui/html.js';
import { closeDrawer, openDrawer, toast } from '../ui/overlay.js';

/* ============================================================
   VIEW — BOOKING
   The staff side of the creator's booking page.

   Availability lives in its own collections on the server, not in the
   workspace document, so everything here is fetched rather than read off
   DB — the same shape as the partner comments panel. One cache, one
   loader, and a render that draws whatever the cache currently holds.
   ============================================================ */
export const BOOKING = { campaignId: null, schedule: null, slots: [], bookings: [], invites: [],
                  at: null, error: null, loading: false, openDates: {} };

export async function loadBooking(campaignId, force) {
  if (BOOKING.campaignId === campaignId && BOOKING.at && !force) return BOOKING;
  BOOKING.campaignId = campaignId;
  BOOKING.loading = true;
  try {
    const res = await fetch('/api/booking/campaign/' + encodeURIComponent(campaignId));
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Could not load booking.');
    BOOKING.schedule = body.schedule;
    BOOKING.slots = body.slots || [];
    BOOKING.bookings = body.bookings || [];
    BOOKING.invites = body.invites || [];
    BOOKING.error = null;
    BOOKING.at = new Date();
  } catch (err) {
    BOOKING.error = err.message;
  }
  BOOKING.loading = false;
  return BOOKING;
}

export async function bookingCall(path, body, method) {
  const res = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  let json = {};
  try { json = await res.json(); } catch (e) { /* nothing useful came back */ }
  if (!res.ok) throw new Error(json.error || 'That did not work.');
  return json;
}

export const bookingUrl = (tok) => location.origin + '/book/' + tok;
export const inviteUrl = (tok) => location.origin + '/book/i/' + tok;

/* A creator on the roster who could be invited but has not been. Blocked
   creators are left out: the blacklist is meant to keep them off a
   campaign, and an invite link is an invitation. */
export function bookableParticipants(cp) {
  const invited = new Set(BOOKING.invites.map((i) => i.participantId));
  const booked = new Set(BOOKING.bookings.map((b) => b.participantId).filter(Boolean));
  return partsOf(cp.id).filter((p) => {
    const cr = byCreator[p.creatorId];
    return cr && !isBlocked(cr) && !invited.has(p.id) && !booked.has(p.id);
  });
}

export function bookingTab(mount, cp) {
  if (!BOOKING.at || BOOKING.campaignId !== cp.id) {
    mount.innerHTML = `<div class="empty">Loading booking…</div>`;
    loadBooking(cp.id).then(() => notify());
    return;
  }
  if (BOOKING.error) {
    mount.innerHTML = `<div class="note bad">${esc(BOOKING.error)}</div>
      <p class="card-sub" style="margin-top:10px">Bookings need the server — the rest of this campaign works offline,
      this tab does not. Reconnecting will bring it back.</p>`;
    return;
  }
  if (!BOOKING.schedule) return bookingSetup(mount, cp);
  return bookingBoard(mount, cp);
}

/* ---- before there is a schedule ---- */
export function bookingSetup(mount, cp) {
  mount.innerHTML = `
    <div class="card" style="max-width:640px">
      <div class="card-head"><h3>Let creators book their own visit</h3></div>
      <p class="card-sub">Set the times you can take, then send each creator a link. They pick a slot, it is
      theirs, and the confirmed time lands on the roster, the calendar and the partner page exactly as if you
      had typed it in.</p>
      <div class="grid g2" style="gap:10px;margin-top:14px">
        <div class="field"><label>Venue name — what the creator sees</label>
          <input type="text" id="bkVenue" placeholder="${esc(cp.brand)}" value="${esc(cp.brand || '')}"/></div>
        <div class="field"><label>Time zone</label>
          <select id="bkTz">${['Asia/Seoul', 'Asia/Tokyo', 'Asia/Bangkok', 'Asia/Singapore', 'Europe/London', 'America/New_York']
            .map((z) => `<option ${z === 'Asia/Seoul' ? 'selected' : ''}>${z}</option>`).join('')}</select></div>
        <div class="field"><label>How long each visit takes (minutes)</label>
          <input type="number" id="bkMins" value="90" min="5"/></div>
        <div class="field"><label>Close booking this many hours before</label>
          <input type="number" id="bkDeadline" value="24" min="0"/></div>
        <div class="field"><label>Most people per booking</label>
          <input type="number" id="bkParty" value="1" min="1"/></div>
      </div>
      <div class="field"><label>A note on the booking page (optional)</label>
        <input type="text" id="bkNote" placeholder="e.g. 10분 일찍 도착해 주세요."/></div>
      <button class="btn primary" id="bkCreate">Set up booking</button>
    </div>`;

  $('#bkCreate').addEventListener('click', async () => {
    try {
      await bookingCall('/api/booking/schedule', {
        campaignId: cp.id,
        venueName: $('#bkVenue').value.trim(),
        timezone: $('#bkTz').value,
        slotMinutes: +$('#bkMins').value || 90,
        deadlineHours: +$('#bkDeadline').value || 0,
        maxPartySize: +$('#bkParty').value || 1,
        noteForCreator: $('#bkNote').value.trim()
      });
      await loadBooking(cp.id, true);
      toast('Booking is set up — now add some dates');
      notify();
    } catch (err) { toast(err.message); }
  });
}

/* ---- the board, once a schedule exists ---- */
export function bookingBoard(mount, cp) {
  const sc = BOOKING.schedule;
  const closed = new Set(sc.closedDates || []);
  const seats = BOOKING.slots.reduce((a, s) => a + (s.capacity || 0), 0);
  const taken = BOOKING.slots.reduce((a, s) => a + (s.booked || 0), 0);
  const unmatched = BOOKING.bookings.filter((b) => !b.participantId);
  const toInvite = bookableParticipants(cp);

  /* dates as rows, their times inside — a fortnight of slots is thirty
     rows if every time is one, and fourteen if the day is */
  const byDate = {};
  BOOKING.slots.forEach((s) => { (byDate[s.date] = byDate[s.date] || []).push(s); });
  const dates = Object.keys(byDate).sort();

  mount.innerHTML = `
    <div class="card-head no-print" style="margin-bottom:12px">
      <span style="font-size:12px;color:var(--text-3)">read ${BOOKING.at ? BOOKING.at.toLocaleTimeString() : '—'}</span>
      <button class="btn xs" id="bkRefresh">Refresh</button>
      <span class="pill ${sc.status === 'open' ? 'green' : sc.status === 'paused' ? 'amber' : 'grey'}">${esc(sc.status)}</span>
      <div class="sp"></div>
      <button class="btn xs" id="bkPause">${sc.status === 'paused' ? 'Reopen' : 'Pause'}</button>
    </div>

    ${bookingAvailabilityCard(cp)}

    <div class="grid g4" style="margin-bottom:16px">
      ${statCard('Booked', taken, { foot: `${seats - taken} seat${seats - taken === 1 ? '' : 's'} left` })}
      ${statCard('Slots', BOOKING.slots.length, { foot: `${dates.length} date${dates.length === 1 ? '' : 's'}` })}
      ${statCard('Not invited yet', toInvite.length, { foot: 'on the roster, no link sent' })}
      ${statCard('Needs matching', unmatched.length, { foot: unmatched.length ? 'booked, not on the roster' : 'all matched' })}
    </div>

    ${unmatched.length ? `<div class="card" style="margin-bottom:14px">
      <div class="card-head"><h3>Booked, but not matched to anyone</h3></div>
      <p class="card-sub">These came in on the public link under a handle that is not on this roster. The seat is
      held. Nothing has been added to the creator database — matching is yours to do.</p>
      <div class="tbl-wrap" style="margin-top:10px"><table class="tbl"><thead><tr>
        <th>When</th><th>Handle</th><th>Name</th><th></th></tr></thead><tbody>
        ${unmatched.map((b) => `<tr>
          <td>${esc(b.date)} ${esc(b.time)}</td>
          <td>${esc((b.guest || {}).handle || '')}</td>
          <td>${esc((b.guest || {}).name || '')}</td>
          <td style="text-align:right"><button class="btn xs" data-match="${esc(b._id)}">Match to…</button>
            <button class="btn xs" data-cancel="${esc(b._id)}">Cancel</button></td></tr>`).join('')}
      </tbody></table></div></div>` : ''}

    <div class="card" style="margin-bottom:14px">
      <div class="card-head"><h3>Dates in detail</h3>
        <span style="font-size:12px;color:var(--text-3)">change one day without touching the rule</span>
        <div class="sp"></div>
        <button class="btn sm" id="bkAddDate">+ Add a date by hand</button></div>
      ${dates.length ? `<div class="tbl-wrap" style="margin-top:10px"><table class="tbl"><thead><tr>
        <th>Date</th><th>Slots</th><th>Seats</th><th>Booked</th><th></th></tr></thead><tbody>
        ${dates.map((d) => {
          const rows = byDate[d].slice().sort((a, b) => a.time.localeCompare(b.time));
          const cap = rows.reduce((a, s) => a + s.capacity, 0);
          const bk = rows.reduce((a, s) => a + s.booked, 0);
          const isOpen = !!BOOKING.openDates[d];
          const blocked = closed.has(d);
          return `<tr data-date-row="${esc(d)}" style="cursor:pointer">
              <td><span style="color:var(--text-3)">${isOpen ? '▾' : '▸'}</span> ${esc(d)}
                ${blocked ? '<span class="pill grey" style="margin-left:6px">Blocked</span>' : ''}</td>
              <td>${rows.length}</td><td>${cap}</td>
              <td>${bk}${bk >= cap && cap ? ' <span class="pill amber">Full</span>' : ''}</td>
              <td style="text-align:right"><button class="btn xs" data-block="${esc(d)}">${blocked ? 'Unblock' : 'Block day'}</button>
                <button class="btn xs" data-delday="${esc(d)}">Delete day</button></td>
            </tr>` + (isOpen ? rows.map((s) => `<tr data-slot-row="1">
              <td style="padding-left:26px;color:var(--text-2)">${esc(s.time)}</td>
              <td colspan="2"><input type="number" min="1" value="${s.capacity}" data-cap="${esc(s._id)}"
                  style="width:70px;padding:3px 6px;font-size:12px"/> seats</td>
              <td>${s.booked} booked</td>
              <td style="text-align:right">
                <button class="btn xs" data-slotstatus="${esc(s._id)}" data-to="${s.status === 'open' ? 'closed' : 'open'}">${s.status === 'open' ? 'Close' : 'Open'}</button>
                <button class="btn xs" data-editslot="${esc(s._id)}">Edit</button>
                <button class="btn xs" data-delslot="${esc(s._id)}">Delete</button>
              </td></tr>`).join('') + `<tr><td colspan="5" style="padding-left:26px">
                <input type="time" data-newtime="${esc(d)}" style="width:110px;padding:3px 6px;font-size:12px"/>
                <input type="number" min="1" value="1" data-newcap="${esc(d)}" style="width:60px;padding:3px 6px;font-size:12px"/> seats
                <button class="btn xs" data-addslot="${esc(d)}">+ Add time</button></td></tr>` : '');
        }).join('')}
      </tbody></table></div>` : '<p class="card-sub" style="margin-top:10px">No dates yet. Add one and the link starts working.</p>'}
    </div>

    ${bookingShareCard(cp)}

    <div class="card">
      <div class="card-head"><h3>Bookings</h3></div>
      ${BOOKING.bookings.length ? `<div class="tbl-wrap" style="margin-top:10px"><table class="tbl"><thead><tr>
        <th>When</th><th>Creator</th><th>People</th><th>Booked by</th><th></th></tr></thead><tbody>
        ${BOOKING.bookings.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map((b) => {
          const p = b.participantId ? DB.participants.find((x) => x.id === b.participantId) : null;
          const cr = p ? byCreator[p.creatorId] : null;
          return `<tr>
            <td style="white-space:nowrap">${esc(b.date)} ${esc(b.time)}</td>
            <td>${cr ? esc(cr.handle) + flagMark(cr) : `<span style="color:var(--amber)">${esc((b.guest || {}).handle || '—')} · unmatched</span>`}
              ${b.staffNote ? `<div style="font-size:11.5px;color:var(--text-3)">${esc(b.staffNote)}</div>` : ''}</td>
            <td>${b.partySize || 1}</td>
            <td><span class="pill grey">${esc(b.source || 'creator')}</span></td>
            <td style="text-align:right">
              <button class="btn xs" data-editbk="${esc(b._id)}">Edit</button>
              <button class="btn xs" data-move="${esc(b._id)}">Move</button>
              <button class="btn xs" data-cancel="${esc(b._id)}">Cancel</button></td></tr>`;
        }).join('')}
      </tbody></table></div>` : '<p class="card-sub" style="margin-top:10px">Nobody has booked yet.</p>'}
    </div>`;

  wireBookingBoard(cp);
}

/* One delegated listener per concern rather than one per row: the table
   is rebuilt on every change, and per-row handlers would be re-bound
   dozens of times a minute for no gain. */
export function wireBookingBoard(cp) {
  const sc = BOOKING.schedule;
  const after = async (msg) => { await loadBooking(cp.id, true); if (msg) toast(msg); notify(); };
  const guard = async (fn, msg) => { try { await fn(); await after(msg); } catch (err) { toast(err.message); } };

  /* Creators book while this tab is open and nothing pushes that here.
     Rather than poll — which would spend a request a second on a page
     that is usually idle — the list says when it was read and offers to
     read it again. */
  $('#bkRefresh').addEventListener('click', () => guard(async () => {}, null));
  wireBookingAvailability(cp);
  wireBookingShare(cp);

  $('#bkCopy').addEventListener('click', () => copyText(bookingUrl(sc.publicToken)));
  $('#bkPause').addEventListener('click', () => guard(
    () => bookingCall('/api/booking/schedule', { campaignId: cp.id, timezone: sc.timezone,
      slotMinutes: sc.slotMinutes, deadlineHours: sc.deadlineHours, maxPartySize: sc.maxPartySize,
      venueName: sc.venueName, noteForCreator: sc.noteForCreator,
      status: sc.status === 'paused' ? 'open' : 'paused' }),
    sc.status === 'paused' ? 'Booking reopened' : 'Booking paused'));

  $('#bkAddDate').addEventListener('click', () => openAddBookingDate(cp));

  const invAll = $('#bkInviteAll');
  if (invAll) invAll.addEventListener('click', () => guard(async () => {
    for (const p of bookableParticipants(cp)) {
      const cr = byCreator[p.creatorId] || {};
      await bookingCall('/api/booking/invite', { campaignId: cp.id, participantId: p.id,
        creatorId: p.creatorId, name: p.fullName || cr.handle || '', handle: cr.handle || '' });
    }
  }, 'Links made — copy them from the table'));

  /* the expanding date rows */
  $$('[data-date-row]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('button,input')) return;
    const d = tr.dataset.dateRow;
    BOOKING.openDates[d] = !BOOKING.openDates[d];
    notify();
  }));

  $$('[data-block]').forEach((b) => b.addEventListener('click', () => guard(
    () => bookingCall('/api/booking/date', { scheduleId: sc._id, date: b.dataset.block,
      closed: !(sc.closedDates || []).includes(b.dataset.block) }))));

  $$('[data-addslot]').forEach((b) => b.addEventListener('click', () => {
    const d = b.dataset.addslot;
    const time = $(`[data-newtime="${d}"]`).value;
    const capacity = +$(`[data-newcap="${d}"]`).value || 1;
    if (!time) return toast('Pick a time first');
    BOOKING.openDates[d] = true;
    guard(() => bookingCall('/api/booking/slot', { scheduleId: sc._id, date: d, time, capacity }));
  }));

  /* A slot with bookings can be deleted, but only as a decision: the
     count is spelled out and the bookings are cancelled, not orphaned. */
  $$('[data-delslot]').forEach((b) => b.addEventListener('click', () => {
    const slot = BOOKING.slots.find((x) => x._id === b.dataset.delslot);
    if (!slot) return;
    const n = BOOKING.bookings.filter((x) => x.slotId === slot._id).length;
    if (n && !window.confirm(`${n} booking${n === 1 ? '' : 's'} on ${slot.date} ${slot.time} will be cancelled and the slot deleted. ` +
      'The creators are not told automatically — tell them yourself. Go ahead?')) return;
    guard(() => bookingCall('/api/booking/slot/' + slot._id + (n ? '?cancelBookings=1' : ''), null, 'DELETE'),
      n ? `Slot deleted, ${n} booking${n === 1 ? '' : 's'} cancelled` : 'Slot deleted');
  }));
  $$('[data-editslot]').forEach((b) => b.addEventListener('click', () => openEditSlot(cp, b.dataset.editslot)));
  $$('[data-delday]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();          /* the row itself toggles open */
    const d = b.dataset.delday;
    const ids = new Set(BOOKING.slots.filter((x) => x.date === d).map((x) => x._id));
    const n = BOOKING.bookings.filter((x) => ids.has(x.slotId)).length;
    if (!window.confirm(n
      ? `Delete all ${ids.size} slot${ids.size === 1 ? '' : 's'} on ${d}? ${n} booking${n === 1 ? '' : 's'} will be cancelled — the creators are not told automatically.`
      : `Delete all ${ids.size} slot${ids.size === 1 ? '' : 's'} on ${d}?`)) return;
    guard(() => bookingCall('/api/booking/date/delete', { scheduleId: sc._id, date: d, cancelBookings: !!n }),
      n ? `${d} deleted, ${n} booking${n === 1 ? '' : 's'} cancelled` : `${d} deleted`);
  }));
  $$('[data-editbk]').forEach((b) => b.addEventListener('click', () => openEditBooking(cp, b.dataset.editbk)));

  $$('[data-slotstatus]').forEach((b) => b.addEventListener('click', () => guard(
    () => bookingCall('/api/booking/slot/' + b.dataset.slotstatus, { status: b.dataset.to }, 'PATCH'))));

  /* capacity is committed on blur rather than per keystroke, and a refusal
     puts the old number back rather than leaving a figure on screen the
     server never accepted */
  $$('[data-cap]').forEach((inp) => inp.addEventListener('change', async () => {
    const slot = BOOKING.slots.find((s) => s._id === inp.dataset.cap);
    try {
      await bookingCall('/api/booking/slot/' + inp.dataset.cap, { capacity: +inp.value }, 'PATCH');
      await loadBooking(cp.id, true); notify();
    } catch (err) { inp.value = slot ? slot.capacity : inp.value; toast(err.message); }
  }));

  $$('[data-copyinvite]').forEach((b) => b.addEventListener('click', () => copyText(inviteUrl(b.dataset.copyinvite))));
  $$('[data-move]').forEach((b) => b.addEventListener('click', () => openStaffMove(cp, b.dataset.move)));
  $$('[data-cancel]').forEach((b) => b.addEventListener('click', () => {
    const bk = BOOKING.bookings.find((x) => x._id === b.dataset.cancel);
    if (!bk) return;
    if (!window.confirm('Cancel this booking? The creator is not told — there are no notifications yet, so tell them yourself.')) return;
    guard(() => bookingCall('/api/booking/booking/' + bk._id + '/cancel', { reason: 'cancelled by staff' }), 'Booking cancelled');
  }));
  $$('[data-match]').forEach((b) => b.addEventListener('click', () => openMatchBooking(cp, b.dataset.match)));
}

/* ---- adding a date ---- */
export function openAddBookingDate(cp) {
  const sc = BOOKING.schedule;
  const existing = [...new Set(BOOKING.slots.map((s) => s.date))].sort();
  openDrawer('Add a date', `
    <div class="field"><label>Date</label><input type="date" id="adDate"/></div>
    ${existing.length ? `<div class="field"><label>Same times as…</label>
      <select id="adCopy"><option value="">— set them by hand —</option>
        ${existing.map((d) => `<option value="${esc(d)}">${esc(d)} (${BOOKING.slots.filter((s) => s.date === d).length} times)</option>`).join('')}
      </select>
      <div style="font-size:12px;color:var(--text-3);margin-top:5px">Copying a day is how a fortnight gets set up
        without typing every time twice.</div></div>` : ''}
    <div id="adManual" class="grid g2" style="gap:10px">
      <div class="field"><label>First time</label><input type="time" id="adFrom" value="12:00"/></div>
      <div class="field"><label>Seats per time</label><input type="number" id="adCap" value="1" min="1"/></div>
    </div>
    <button class="btn primary" id="adGo">Add</button>`);

  $('#adGo').addEventListener('click', async () => {
    const date = $('#adDate').value;
    if (!date) return toast('Pick a date');
    const copyFrom = ($('#adCopy') || {}).value || '';
    try {
      if (copyFrom) {
        for (const s of BOOKING.slots.filter((x) => x.date === copyFrom)) {
          await bookingCall('/api/booking/slot', { scheduleId: sc._id, date, time: s.time, capacity: s.capacity });
        }
      } else {
        await bookingCall('/api/booking/slot', { scheduleId: sc._id, date,
          time: $('#adFrom').value, capacity: +$('#adCap').value || 1 });
      }
      BOOKING.openDates[date] = true;
      closeDrawer();
      await loadBooking(cp.id, true);
      toast('Date added'); notify();
    } catch (err) { toast(err.message); }
  });
}

/* ---- staff moving a booking ----

   The same picker the creator sees, plus one thing theirs does not have:
   a full slot can still be chosen. A human deciding to squeeze somebody
   in is a real decision, and refusing it outright would only send them
   to the database. It is recorded rather than prevented. */
/* ---- editing a slot: its date, time and seats ----

   Bookings on the slot move with it. Nobody is told automatically, so
   the drawer says how many people that is. */
export function openEditSlot(cp, slotId) {
  const slot = BOOKING.slots.find((x) => x._id === slotId);
  if (!slot) return;
  const n = BOOKING.bookings.filter((x) => x.slotId === slot._id).length;
  openDrawer(`Edit slot — ${esc(slot.date)} ${esc(slot.time)}`, `
    <div class="grid g3" style="gap:10px">
      <div class="field"><label>Date</label><input type="date" id="esDate" value="${esc(slot.date)}"/></div>
      <div class="field"><label>Time</label><input type="time" id="esTime" value="${esc(slot.time)}"/></div>
      <div class="field"><label>Seats</label><input type="number" min="1" id="esCap" value="${slot.capacity}"/></div>
    </div>
    <div class="field"><label>Note (staff only)</label><input type="text" id="esNote" value="${esc(slot.note || '')}" maxlength="200"/></div>
    ${n ? `<div class="note" style="margin:8px 0">${n} booking${n === 1 ? '' : 's'} on this slot will move with it. The creator${n === 1 ? ' is' : 's are'} not told automatically.</div>` : ''}
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn primary" id="esSave">Save</button>
      <button class="btn" id="esCancel">Cancel</button>
    </div>`);
  $('#esCancel').addEventListener('click', closeDrawer);
  $('#esSave').addEventListener('click', async () => {
    const body = { note: $('#esNote').value.trim() };
    const date = $('#esDate').value, time = $('#esTime').value, cap = +$('#esCap').value;
    if (date !== slot.date) body.date = date;
    if (time !== slot.time) body.time = time;
    if (cap !== slot.capacity) body.capacity = cap;
    try {
      const r = await bookingCall('/api/booking/slot/' + slot._id, body, 'PATCH');
      closeDrawer();
      await loadBooking(cp.id, true);
      toast(r.bookingsMoved ? `Slot changed — ${r.bookingsMoved} booking${r.bookingsMoved === 1 ? '' : 's'} moved with it` : 'Slot saved');
      notify();
    } catch (err) { toast(err.message); }
  });
}

/* ---- editing one booking: people and a staff note ----

   The time is changed with Move (a different slot), so the seat claim
   stays the one atomic path it has always been. */
export function openEditBooking(cp, bookingId) {
  const bk = BOOKING.bookings.find((x) => x._id === bookingId);
  if (!bk) return;
  const p = bk.participantId ? DB.participants.find((x) => x.id === bk.participantId) : null;
  const cr = p ? byCreator[p.creatorId] : null;
  const who = cr ? cr.handle : ((bk.guest || {}).handle || 'unmatched booking');
  openDrawer(`Edit booking — ${esc(who)}`, `
    <p class="card-sub"><strong>${esc(bk.date)} ${esc(bk.time)}</strong> · booked by ${esc(bk.source || 'creator')}</p>
    <div class="grid g2" style="gap:10px;margin-top:10px">
      <div class="field"><label>People</label><input type="number" min="1" max="50" id="ebParty" value="${bk.partySize || 1}"/></div>
    </div>
    <div class="field"><label>Staff note</label><textarea id="ebNote" style="min-height:60px" maxlength="500">${esc(bk.staffNote || '')}</textarea></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
      <button class="btn primary" id="ebSave">Save</button>
      <button class="btn" id="ebMove">Change time…</button>
      <div class="sp"></div>
      <button class="btn" id="ebCancel" style="color:var(--red)">Cancel booking</button>
    </div>`);
  const done = async (msg) => { closeDrawer(); await loadBooking(cp.id, true); toast(msg); notify(); };
  $('#ebMove').addEventListener('click', () => { closeDrawer(); openStaffMove(cp, bk._id); });
  $('#ebCancel').addEventListener('click', async () => {
    if (!window.confirm('Cancel this booking? The creator is not told — there are no notifications yet, so tell them yourself.')) return;
    try { await bookingCall('/api/booking/booking/' + bk._id + '/cancel', { reason: 'cancelled by staff' }); await done('Booking cancelled'); }
    catch (err) { toast(err.message); }
  });
  $('#ebSave').addEventListener('click', async () => {
    const body = { staffNote: $('#ebNote').value.trim() };
    const party = +$('#ebParty').value;
    if (party !== (bk.partySize || 1)) body.partySize = party;
    try {
      await bookingCall('/api/booking/booking/' + bk._id, body, 'PATCH');
      await done('Booking saved');
    } catch (err) {
      if (/Not enough seats/.test(err.message) && window.confirm(err.message + ' Save it over capacity anyway?')) {
        try { await bookingCall('/api/booking/booking/' + bk._id, Object.assign(body, { overCapacity: true }), 'PATCH'); await done('Saved — over capacity, recorded as a staff decision'); }
        catch (e2) { toast(e2.message); }
      } else toast(err.message);
    }
  });
}

export function openStaffMove(cp, bookingId) {
  const bk = BOOKING.bookings.find((x) => x._id === bookingId);
  if (!bk) return;
  const sc = BOOKING.schedule;
  const closed = new Set(sc.closedDates || []);
  const rows = BOOKING.slots.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  openDrawer(`Move — ${esc(bk.date)} ${esc(bk.time)}`, `
    <p class="card-sub">Currently <strong>${esc(bk.date)} ${esc(bk.time)}</strong>${bk.partySize > 1 ? `, ${bk.partySize} people` : ''}.
      The creator is not told automatically — there are no notifications yet.</p>
    <div class="tbl-wrap" style="margin-top:12px"><table class="tbl"><thead><tr>
      <th>Date</th><th>Time</th><th>Free</th><th></th></tr></thead><tbody>
      ${rows.map((s) => {
        const free = Math.max(0, s.capacity - s.booked);
        const unavailable = closed.has(s.date) || s.status !== 'open';
        const here = s._id === bk.slotId;
        return `<tr${here ? ' style="opacity:.5"' : ''}>
          <td>${esc(s.date)}${closed.has(s.date) ? ' <span class="pill grey">blocked</span>' : ''}</td>
          <td>${esc(s.time)}</td>
          <td>${free ? free : '<span style="color:var(--amber)">full</span>'}</td>
          <td style="text-align:right">${here ? '<span style="color:var(--text-3)">current</span>'
            : `<button class="btn xs" data-moveto="${esc(s._id)}" data-free="${free}"${unavailable ? ' disabled' : ''}>${free ? 'Move here' : 'Over capacity'}</button>`}</td>
        </tr>`;
      }).join('')}
    </tbody></table></div>`);

  $$('[data-moveto]').forEach((b) => b.addEventListener('click', async () => {
    const over = +b.dataset.free === 0;
    if (over && !window.confirm('That slot is full. Book over capacity anyway?')) return;
    try {
      await bookingCall('/api/booking/booking/' + bk._id + '/move',
        { slotId: b.dataset.moveto, overCapacity: over });
      closeDrawer();
      await loadBooking(cp.id, true);
      toast(over ? 'Moved — over capacity, recorded as a staff decision' : 'Moved');
      notify();
    } catch (err) { toast(err.message); }
  }));
}

/* ---- matching a public booking to a roster row ----

   Never creates a creator or a participant. If the person who booked is
   not on the roster, adding them is a separate decision made in the
   roster, and this only points an existing row at a seat already held. */
export function openMatchBooking(cp, bookingId) {
  const bk = BOOKING.bookings.find((x) => x._id === bookingId);
  if (!bk) return;
  const taken = new Set(BOOKING.bookings.map((b) => b.participantId).filter(Boolean));
  const rows = partsOf(cp.id).filter((p) => !taken.has(p.id));

  openDrawer('Match this booking', `
    <p class="card-sub"><strong>${esc((bk.guest || {}).handle || '')}</strong> booked
      ${esc(bk.date)} ${esc(bk.time)} on the public link, under a handle that is not on this roster.</p>
    <div class="note" style="margin:12px 0">Matching points this seat at a roster row and sets that row's
      confirmed visit. It does not add anyone to the creator database — if they are genuinely new, add them to
      the roster first and then come back.</div>
    ${rows.length ? `<div class="field"><label>Roster row</label><select id="mbRow">
      ${rows.map((p) => { const cr = byCreator[p.creatorId] || {};
        return `<option value="${esc(p.id)}">${esc(cr.handle || p.fullName || p.id)}${p.fullName ? ` · ${esc(p.fullName)}` : ''}</option>`; }).join('')}
    </select></div><button class="btn primary" id="mbGo">Match</button>`
    : '<p class="card-sub">Every row on this roster already has a booking.</p>'}`);

  const go = $('#mbGo');
  if (go) go.addEventListener('click', async () => {
    try {
      await bookingCall('/api/booking/booking/' + bk._id + '/match', { participantId: $('#mbRow').value });
      closeDrawer();
      await loadBooking(cp.id, true);
      toast('Matched — the confirmed visit is on the roster now');
      notify();
    } catch (err) { toast(err.message); }
  });
}

/* ============================================================
   AVAILABILITY FROM A RULE

   A venue never says "add 2026-10-20 at 18:30". It says "Tuesday to
   Saturday, arrive between 6:30 and 7:30, closed Mondays". So that is
   what this stores and what the screen shows; the slots are generated
   from it in one go.

   The expansion runs here, in the browser, and the list it produces is
   both what the preview draws and what gets written. One expander, so
   the preview cannot promise a day the server does not create.
   ============================================================ */

export const RULE_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const RULE_DAY_KO = { Mon: '월', Tue: '화', Wed: '수', Thu: '목', Fri: '금', Sat: '토', Sun: '일' };

export function defaultBookingRule() {
  const start = new Date(TODAY.getTime() + 2 * DAY);
  const end = new Date(TODAY.getTime() + 16 * DAY);
  return {
    days: { Mon: null, Tue: ['18:30', '19:30'], Wed: ['18:30', '19:30'], Thu: ['18:30', '19:30'],
            Fri: ['18:30', '19:30'], Sat: ['18:30', '19:30'], Sun: ['18:00', '19:00'] },
    stepMinutes: 15,
    perDay: 1,
    from: iso(start),
    to: iso(end),
    skipHolidays: true
  };
}

export const ruleMinutes = (t) => {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? +m[1] * 60 + +m[2] : null;
};
export const ruleTime = (n) => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
export const ruleDayName = (d) => RULE_DAYS[(d.getDay() + 6) % 7];

/* every exact time a creator could pick on one weekday */
export function ruleTimesFor(rule, dayName) {
  const w = (rule.days || {})[dayName];
  if (!Array.isArray(w) || !w[0]) return [];
  const from = ruleMinutes(w[0]);
  const to = ruleMinutes(w[1] || w[0]);
  if (from == null || to == null || to < from) return from == null ? [] : [ruleTime(from)];
  const step = Math.max(5, Math.floor(Number(rule.stepMinutes) || 15));
  const out = [];
  for (let t = from; t <= to; t += step) out.push(ruleTime(t));
  return out;
}

/* Every day in the range, with the times it opens and why it does not.
   Holidays and one-off closures are the same thing to the generator —
   a date that is skipped and says so. */
export function expandBookingRule(rule, opts) {
  const o = opts || {};
  const holidays = new Map((o.holidays || []).map((h) => [h.d, h.n || 'Holiday']));
  const closed = new Set(o.closedDates || []);
  const from = parseVisitSlot(rule.from), to = parseVisitSlot(rule.to);
  const out = [];
  if (!from || !to || to < from) return out;
  if ((to - from) / DAY > 180) return out;          /* half a year is a typo, not a plan */

  for (let d = new Date(from); d <= to; d = new Date(d.getTime() + DAY)) {
    const key = iso(d);
    const dayName = ruleDayName(d);
    const times = ruleTimesFor(rule, dayName);
    const holiday = holidays.get(key) || '';
    let why = '';
    if (!times.length) why = 'closed on ' + dayName + 's';
    else if (holiday && rule.skipHolidays !== false) why = holiday;
    else if (closed.has(key)) why = 'blocked';
    out.push({
      date: key, dayName, holiday,
      times: why ? [] : times,
      open: !why,
      why
    });
  }
  return out;
}

/* What the bulk create is handed: one slot per exact time. The per-day
   limit rides on the slot's capacity, so the atomic claim that has
   always guarded a seat guards the day as well. */
export function bookingRuleSlots(rule, opts) {
  const perDay = Math.max(1, Math.floor(Number(rule.perDay) || 1));
  const minutes = Math.max(5, Math.floor(Number((opts || {}).slotMinutes) || 90));
  const rows = [];
  expandBookingRule(rule, opts).forEach((day) => {
    day.times.forEach((t) => rows.push({ date: day.date, time: t, capacity: perDay, minutes }));
  });
  return rows;
}

/* The sentence a person would say, in the language the creator reads. */
export function bookingRuleSummary(rule, opts) {
  const o = opts || {};
  const open = RULE_DAYS.filter((d) => ruleTimesFor(rule, d).length);
  const shut = RULE_DAYS.filter((d) => !ruleTimesFor(rule, d).length);
  const days = expandBookingRule(rule, o);
  const live = days.filter((d) => d.open);
  const perDay = Math.max(1, Math.floor(Number(rule.perDay) || 1));

  if (o.ko) {
    const windows = {};
    open.forEach((d) => { const w = rule.days[d].join('–'); (windows[w] = windows[w] || []).push(RULE_DAY_KO[d]); });
    return `${Object.entries(windows).map(([w, ds]) => `${ds.join('·')}요일 ${w} 도착`).join(' / ') || '가능한 요일 없음'}`
      + `${shut.length ? ` · ${shut.map((d) => RULE_DAY_KO[d]).join('·')}요일 휴무` : ''}`
      + ` · 하루 ${perDay}팀 · 예약 가능 ${live.length}일`;
  }
  const windows = {};
  open.forEach((d) => { const w = rule.days[d].join('–'); (windows[w] = windows[w] || []).push(d); });
  const parts = Object.entries(windows).map(([w, ds]) => `${ds.join(', ')} arrive ${w}`);
  return `${parts.join('. ') || 'No days open yet'}.`
    + `${shut.length ? ` Closed ${shut.join(', ')}.` : ''}`
    + ` ${perDay} booking a day, ${live.length} bookable day${live.length === 1 ? '' : 's'}.`;
}

/* ---- the setup card itself ---- */

export let RULE_DRAFT = null;          /* what is on screen but not yet generated */

export function bookingRuleOf(sc) {
  if (RULE_DRAFT) return RULE_DRAFT;
  RULE_DRAFT = JSON.parse(JSON.stringify((sc && sc.rule) || defaultBookingRule()));
  return RULE_DRAFT;
}

export function holidayList() {
  if (!Array.isArray(SETTINGS.holidays)) SETTINGS.holidays = defaultHolidays();
  return SETTINGS.holidays;
}

/* The fixed-date Korean public holidays only. The lunar ones — Seollal,
   Chuseok, Buddha's birthday — move every year and a wrong date here
   would silently close a day the venue is open, so they are added by
   hand rather than guessed. */
export function defaultHolidays() {
  const years = [TODAY.getFullYear(), TODAY.getFullYear() + 1];
  const fixed = [['01-01', "New Year's Day"], ['03-01', 'Independence Movement Day'], ['05-05', "Children's Day"],
    ['06-06', 'Memorial Day'], ['08-15', 'Liberation Day'], ['10-03', 'National Foundation Day'],
    ['10-09', 'Hangul Day'], ['12-25', 'Christmas Day']];
  const out = [];
  years.forEach((y) => fixed.forEach(([md, n]) => out.push({ d: y + '-' + md, n })));
  return out;
}

export function bookingAvailabilityCard(cp) {
  const sc = BOOKING.schedule;
  const rule = bookingRuleOf(sc);
  const days = expandBookingRule(rule, { holidays: holidayList(), closedDates: sc.closedDates || [] });
  const live = days.filter((d) => d.open);
  const times = live.reduce((n, d) => n + d.times.length, 0);
  const existing = new Set(BOOKING.slots.map((s) => s.date + ' ' + s.time));
  const toAdd = bookingRuleSlots(rule, { holidays: holidayList(), closedDates: sc.closedDates || [], slotMinutes: sc.slotMinutes })
    .filter((s) => !existing.has(s.date + ' ' + s.time)).length;

  return `<div class="card" style="margin-bottom:14px">
    <div class="card-head"><h3>When creators can come</h3>
      <span style="font-size:12px;color:var(--text-3)">one rule, not one date at a time</span>
      <div class="sp"></div>
      <button class="btn xs" id="bkPaste">Paste the venue's message</button>
    </div>

    <div id="bkPasteBox" hidden style="margin-top:10px">
      <textarea id="bkPasteText" style="min-height:92px" placeholder="e.g. Closed every Monday. Tuesday–Saturday: please arrive between 6:30 PM and 7:30 PM. Sunday: 6:00 PM – 7:00 PM."></textarea>
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">
        <button class="btn sm primary" id="bkReadText">Read it</button>
        <span style="font-size:11.5px;color:var(--text-3)" id="bkReadOut">It fills in the rule below. Nothing is created until you press Generate.</span>
      </div>
    </div>

    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0 6px">
      <strong style="font-size:12.5px">The weekly rule</strong>
      <div class="sp"></div>
      <label style="font-size:11.5px;color:var(--text-3);display:flex;align-items:center;gap:6px;margin:0">
        a time every <input type="number" id="bkStep" value="${rule.stepMinutes}" min="5" max="120" step="5" style="width:62px;padding:3px 6px;font-size:12px"/> min</label>
      <label style="font-size:11.5px;color:var(--text-3);display:flex;align-items:center;gap:6px;margin:0">
        <input type="number" id="bkPerDay" value="${rule.perDay}" min="1" max="20" style="width:52px;padding:3px 6px;font-size:12px"/> booking${rule.perDay === 1 ? '' : 's'} a day</label>
    </div>
    <div id="bkRuleRows">${RULE_DAYS.map((d) => {
      const w = rule.days[d];
      const n = ruleTimesFor(rule, d).length;
      return `<div class="bk-dayrow${w ? '' : ' off'}">
        <label style="margin:0;display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--text)">
          <input type="checkbox" data-bkday="${d}" ${w ? 'checked' : ''}/> ${d}</label>
        ${w ? `<span style="font-size:11.5px;color:var(--text-3)">arrive</span>
          <input type="time" data-bkfrom="${d}" value="${esc(w[0])}"/>
          <span style="color:var(--text-3)">–</span>
          <input type="time" data-bkto="${d}" value="${esc(w[1] || w[0])}"/>
          <span style="font-size:11.5px;color:var(--text-3)">${n} time${n === 1 ? '' : 's'}</span>`
        : '<span style="font-size:11.5px;color:var(--text-3)">closed</span>'}
      </div>`;
    }).join('')}</div>

    <div class="divider"></div>
    <div class="grid g3" style="gap:10px">
      <div class="field"><label>From</label><input type="date" id="bkFrom" value="${esc(rule.from)}"/></div>
      <div class="field"><label>To</label><input type="date" id="bkTo" value="${esc(rule.to)}"/></div>
      <div class="field"><label>Public holidays</label>
        <select id="bkSkipHol"><option value="skip" ${rule.skipHolidays !== false ? 'selected' : ''}>Skip them</option>
          <option value="keep" ${rule.skipHolidays === false ? 'selected' : ''}>Open as usual</option></select></div>
    </div>

    <div class="lbl" style="margin-top:10px">Holidays and one-off closures</div>
    <div class="chips" id="bkHolidays" style="margin-top:6px">${holidaysInRange(rule).map((h, i) =>
      `<span class="bk-chip">${esc(h.d.slice(5))} ${esc(h.n)} <span class="x" data-bkholdel="${esc(h.d)}" title="Remove">×</span></span>`).join('')
      || '<span style="font-size:11.5px;color:var(--text-3)">None inside this range.</span>'}</div>
    <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;max-width:460px">
      <input type="date" id="bkHolDate" style="flex:0 0 160px"/>
      <input type="text" id="bkHolName" placeholder="what is it? e.g. Chuseok" style="flex:1 1 140px"/>
      <button class="btn xs" id="bkHolAdd">Add</button>
    </div>
    <p class="card-sub" style="margin-top:7px">Fixed-date Korean holidays are here already. Seollal, Chuseok and
      Buddha's birthday move each year, so add those — and the venue's own closures — by hand.</p>

    <div class="divider"></div>
    <div class="grid g2" style="gap:12px;align-items:start">
      <div>
        <div class="lbl">What this produces</div>
        <div class="bk-mini" id="bkPreview">${bookingRulePreview(days)}</div>
        <div class="bk-legend">
          <span><i class="open"></i>bookable</span><span><i class="shut"></i>closed</span><span><i class="hol"></i>holiday</span>
        </div>
      </div>
      <div>
        <div class="note" style="margin:0 0 10px">${esc(bookingRuleSummary(rule, { holidays: holidayList(), closedDates: sc.closedDates || [] }))}</div>
        <div style="font-size:12px;color:var(--text-3);margin-bottom:10px">
          ${live.length} day${live.length === 1 ? '' : 's'} · ${times} time${times === 1 ? '' : 's'} ·
          ${toAdd ? `<strong style="color:var(--text-2)">${toAdd} new</strong>` : 'nothing new to add'}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary" id="bkGenerate" ${toAdd ? '' : 'disabled'}>Generate ${toAdd || ''} time${toAdd === 1 ? '' : 's'}</button>
          <button class="btn" id="bkClear">Clear unbooked days in range</button>
        </div>
        <p class="card-sub" style="margin-top:8px">Generating never touches a day somebody has already booked.</p>
      </div>
    </div>
  </div>`;
}

export function holidaysInRange(rule) {
  const from = rule.from, to = rule.to;
  return holidayList().filter((h) => h.d >= from && h.d <= to).sort((a, b) => a.d.localeCompare(b.d));
}

export function bookingRulePreview(days) {
  if (!days.length) return '<p class="card-sub" style="margin:0">Pick a date range.</p>';
  const first = parseVisitSlot(days[0].date);
  const pad = (first.getDay() + 6) % 7;
  let html = '';
  for (let i = 0; i < pad; i++) html += '<span class="bk-cell out"></span>';
  days.forEach((d) => {
    const cls = ['bk-cell'];
    if (d.open) cls.push('open'); else cls.push('shut');
    if (d.holiday) cls.push('hol');
    const day = parseVisitSlot(d.date);
    html += `<span class="${cls.join(' ')}" title="${esc(d.date + (d.why ? ' · ' + d.why : ' · ' + d.times.length + ' times'))}">
      <b>${day.getDate()}</b>${d.open ? `<i>${d.times.length}</i>` : ''}</span>`;
  });
  return `<div class="bk-dow">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => `<span>${d}</span>`).join('')}</div>
    <div class="bk-grid">${html}</div>`;
}

/* ---- reading the venue's own words ----

   Deliberately not clever. It reads the handful of shapes venues
   actually write — "closed Mondays", "Tuesday–Saturday 6:30–7:30 PM",
   "after 8:30 PM", "5:00 PM only", "Friday and Saturday unavailable" —
   and leaves everything it did not understand exactly as it was, with
   a line saying what it took. The operator checks it before anything
   is created, which is the whole point of the Generate button. */
export const RULE_WORDS = {
  mon: 'Mon', monday: 'Mon', tue: 'Tue', tues: 'Tue', tuesday: 'Tue', wed: 'Wed', weds: 'Wed', wednesday: 'Wed',
  thu: 'Thu', thur: 'Thu', thurs: 'Thu', thursday: 'Thu', fri: 'Fri', friday: 'Fri',
  sat: 'Sat', saturday: 'Sat', sun: 'Sun', sunday: 'Sun',
  월: 'Mon', 화: 'Tue', 수: 'Wed', 목: 'Thu', 금: 'Fri', 토: 'Sat', 일: 'Sun'
};

export function parseClock(raw, ampmHint) {
  const m = String(raw).match(/(\d{1,2})\s*[:시]?\s*(\d{2})?\s*(am|pm|오전|오후)?/i);
  if (!m) return null;
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  const ap = (m[3] || ampmHint || '').toLowerCase();
  if (/pm|오후/.test(ap) && h < 12) h += 12;
  if (/am|오전/.test(ap) && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return ruleTime(h * 60 + min);
}

export function daysInPhrase(line) {
  const out = new Set();
  const l = line.toLowerCase();
  /* a range: tuesday–saturday, mon-thu */
  const range = l.match(/(mon|tues?|wed|thur?s?|fri|sat|sun)[a-z]*\s*[–—\-~]\s*(mon|tues?|wed|thur?s?|fri|sat|sun)[a-z]*/);
  if (range) {
    const a = RULE_DAYS.indexOf(RULE_WORDS[range[1]]), b = RULE_DAYS.indexOf(RULE_WORDS[range[2]]);
    if (a >= 0 && b >= 0) for (let i = a; ; i = (i + 1) % 7) { out.add(RULE_DAYS[i]); if (i === b) break; }
  }
  Object.entries(RULE_WORDS).forEach(([w, d]) => {
    if (new RegExp('(^|[^a-z])' + w + '([^a-z]|$)', 'i').test(l)) out.add(d);
  });
  if (/weekend/.test(l)) { out.add('Sat'); out.add('Sun'); }
  if (/weekday/.test(l)) ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].forEach((d) => out.add(d));
  return [...out];
}

export function parseVenueHours(text, base) {
  const rule = JSON.parse(JSON.stringify(base || defaultBookingRule()));
  const took = [];
  let touched = false;
  String(text || '').split(/[\n•·]+/).forEach((raw) => {
    const line = raw.trim();
    if (!line) return;
    const days = daysInPhrase(line);
    const shut = /closed|unavailable|not available|휴무|쉽니다|no visits/i.test(line);
    const ampm = (line.match(/\b(am|pm)\b/i) || [])[1] || (/evening|저녁|밤/i.test(line) ? 'pm' : '');

    if (shut && days.length) {
      days.forEach((d) => { rule.days[d] = null; });
      took.push(`${days.join(', ')} closed`); touched = true;
      return;
    }
    const between = line.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:[–—\-~]|to|부터)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
    const after = line.match(/after\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i) || line.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*이후/);
    const only = line.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:only|한\s*타임|정각)/i);
    let window = null;
    if (between) {
      const a = parseClock(between[1], ampm), b = parseClock(between[2], ampm);
      if (a && b) window = [a, b];
    } else if (after) {
      const a = parseClock(after[1], ampm || 'pm');
      if (a) window = [a, ruleTime(Math.min(23 * 60 + 45, ruleMinutes(a) + 90))];
    } else if (only) {
      const a = parseClock(only[1], ampm);
      if (a) window = [a, a];
    }
    if (window && days.length) {
      days.forEach((d) => { rule.days[d] = window.slice(); });
      took.push(`${days.join(', ')} ${window[0]}–${window[1]}`); touched = true;
    }
  });
  if (/public holiday|공휴일/i.test(text || '')) { rule.skipHolidays = true; took.push('public holidays skipped'); }
  return { rule, took, touched };
}

/* ---- the links, where they belong: at the end of setting it up ---- */
export function bookingShareCard(cp) {
  const sc = BOOKING.schedule;
  const live = BOOKING.slots.filter((s) => s.status === 'open').length;
  const invites = BOOKING.invites || [];
  const toInvite = bookableParticipants(cp);
  const dates = [...new Set(BOOKING.slots.map((s) => s.date))].sort();
  const span = dates.length
    ? `${dLabel(dates[0])} to ${dLabel(dates[dates.length - 1])}`
    : 'dates to be confirmed';
  const message = [
    `Hi! Here's your booking link for the ${sc.venueName || cp.brand} visit: ${bookingUrl(sc.publicToken)}`,
    `Pick any date and time that suits you — ${span}.`,
    sc.noteForCreator ? sc.noteForCreator : '',
    (sc.mode || 'request') === 'request'
      ? "We'll confirm your time within 24 hours."
      : 'Your pick is booked straight away.'
  ].filter(Boolean).join('\n');

  return `<div class="card" style="margin-bottom:14px">
    <div class="card-head"><h3>Send it to the creators</h3>
      <div class="sp"></div>
      <span class="pill ${live ? 'green' : 'grey'}">${live ? live + ' times live' : 'nothing to book yet'}</span>
    </div>
    <p class="card-sub">The invite link is the one to use: it knows who the creator is, so the booking matches
      itself to the roster and cannot become somebody else if it is forwarded.</p>

    <div class="lbl" style="margin-top:12px">Invite links</div>
    ${invites.length ? `<div class="tbl-wrap" style="margin-top:6px;max-height:190px;overflow-y:auto"><table class="tbl"><tbody>
      ${invites.map((i) => {
        const b = BOOKING.bookings.find((x) => x.participantId === i.participantId);
        return `<tr><td style="width:40%">${esc(i.name || i.handle || i.participantId)}</td>
          <td>${b ? `<span class="pill green">${esc(b.date)} ${esc(b.time)}</span>` : '<span class="pill grey">not booked yet</span>'}</td>
          <td style="text-align:right"><button class="btn xs" data-copyinvite="${esc(i._id)}">Copy link</button></td></tr>`;
      }).join('')}
    </tbody></table></div>` : '<p class="card-sub" style="margin:4px 0 0">No invites yet.</p>'}
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
      ${toInvite.length ? `<button class="btn sm" id="bkInviteAll">Invite all ${toInvite.length} on the roster</button>` : ''}
      ${invites.length ? '<button class="btn sm" id="bkCopyAll">Copy every link as a list</button>' : ''}
    </div>

    <div class="divider"></div>
    <div class="lbl">Open link — anyone holding it can book</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">
      <code style="flex:1 1 240px;min-width:0;font-size:12px;color:var(--text-2);word-break:break-all">${esc(bookingUrl(sc.publicToken))}</code>
      <button class="btn xs" id="bkCopy">Copy</button>
    </div>
    <p class="card-sub" style="margin-top:6px">A booking made on this one arrives unmatched and waits for you to say who it is.</p>

    <div class="divider"></div>
    <div class="lbl">Message to send with it</div>
    <pre id="bkMsg" style="white-space:pre-wrap;background:var(--surface-2);border:1px solid var(--line);border-radius:8px;
      padding:10px 12px;font-size:12.5px;line-height:1.6;margin:6px 0 0">${esc(message)}</pre>
    <button class="btn xs" id="bkCopyMsg" style="margin-top:8px">Copy message</button>
  </div>`;
}

/* ---- wiring the availability card ---- */
export function wireBookingAvailability(cp) {
  const sc = BOOKING.schedule;
  const rule = bookingRuleOf(sc);
  const redraw = () => notify();
  const opts = () => ({ holidays: holidayList(), closedDates: sc.closedDates || [], slotMinutes: sc.slotMinutes });

  const paste = $('#bkPaste');
  if (paste) paste.addEventListener('click', () => {
    const box = $('#bkPasteBox');
    box.hidden = !box.hidden;
    if (!box.hidden) $('#bkPasteText').focus();
  });
  const readBtn = $('#bkReadText');
  if (readBtn) readBtn.addEventListener('click', () => {
    const r = parseVenueHours($('#bkPasteText').value, rule);
    if (!r.touched) {
      $('#bkReadOut').textContent = 'Nothing here it could read — set the days by hand below.';
      return;
    }
    RULE_DRAFT = r.rule;
    toast('Read: ' + r.took.join(' · '));
    redraw();
  });

  $$('[data-bkday]').forEach((c) => c.addEventListener('change', () => {
    const d = c.dataset.bkday;
    rule.days[d] = c.checked ? (rule.days[d] || ['18:30', '19:30']) : null;
    redraw();
  }));
  $$('[data-bkfrom]').forEach((i) => i.addEventListener('change', () => {
    const d = i.dataset.bkfrom; rule.days[d] = [i.value, (rule.days[d] || [])[1] || i.value]; redraw();
  }));
  $$('[data-bkto]').forEach((i) => i.addEventListener('change', () => {
    const d = i.dataset.bkto; rule.days[d] = [(rule.days[d] || [])[0] || i.value, i.value]; redraw();
  }));
  $('#bkStep').addEventListener('change', (e) => { rule.stepMinutes = Math.max(5, +e.target.value || 15); redraw(); });
  $('#bkPerDay').addEventListener('change', (e) => { rule.perDay = Math.max(1, +e.target.value || 1); redraw(); });
  $('#bkFrom').addEventListener('change', (e) => { rule.from = e.target.value; redraw(); });
  $('#bkTo').addEventListener('change', (e) => { rule.to = e.target.value; redraw(); });
  $('#bkSkipHol').addEventListener('change', (e) => { rule.skipHolidays = e.target.value === 'skip'; redraw(); });

  $('#bkHolAdd').addEventListener('click', () => {
    const d = $('#bkHolDate').value;
    if (!d) { toast('Pick the date first'); return; }
    const list = holidayList();
    if (!list.some((h) => h.d === d)) list.push({ d, n: $('#bkHolName').value.trim() || 'Closed' });
    persist(); redraw();
  });
  $$('[data-bkholdel]').forEach((x) => x.addEventListener('click', () => {
    SETTINGS.holidays = holidayList().filter((h) => h.d !== x.dataset.bkholdel);
    persist(); redraw();
  }));

  $('#bkGenerate').addEventListener('click', async () => {
    const rows = bookingRuleSlots(rule, opts());
    if (!rows.length) { toast('Nothing to generate — no day in that range is open'); return; }
    const btn = $('#bkGenerate');
    btn.disabled = true; btn.textContent = 'Generating…';
    try {
      const r = await bookingCall('/api/booking/slots/bulk', { scheduleId: sc._id, slots: rows });
      /* the rule is kept so the screen can show it back and regenerate */
      await bookingCall('/api/booking/schedule', { campaignId: cp.id, timezone: sc.timezone, rule });
      await loadBooking(cp.id, true);
      toast(`${r.created} time${r.created === 1 ? '' : 's'} added${r.skipped ? `, ${r.skipped} already there` : ''}`);
      notify();
    } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = 'Generate'; }
  });

  $('#bkClear').addEventListener('click', async () => {
    if (!window.confirm(`Remove every unbooked time between ${rule.from} and ${rule.to}? Booked days are kept.`)) return;
    try {
      const r = await bookingCall('/api/booking/slots/clear', { scheduleId: sc._id, from: rule.from, to: rule.to });
      await loadBooking(cp.id, true);
      toast(`${r.removed} removed${r.kept.length ? `, ${r.kept.length} kept because they are booked` : ''}`);
      notify();
    } catch (err) { toast(err.message); }
  });
}

export function wireBookingShare(cp) {
  const sc = BOOKING.schedule;
  const copy2 = $('#bkCopy');
  if (copy2) copy2.addEventListener('click', () => copyText(bookingUrl(sc.publicToken)));
  const msg = $('#bkCopyMsg');
  if (msg) msg.addEventListener('click', () => copyText($('#bkMsg').textContent));
  const all = $('#bkCopyAll');
  if (all) all.addEventListener('click', () => copyText((BOOKING.invites || [])
    .map((i) => `${i.name || i.handle || i.participantId}: ${inviteUrl(i._id)}`).join('\n')));
  const inviteAll = $('#bkInviteAll');
  if (inviteAll) inviteAll.addEventListener('click', async () => {
    const list = bookableParticipants(cp);
    inviteAll.disabled = true; inviteAll.textContent = 'Inviting…';
    try {
      for (const p of list) {
        await bookingCall('/api/booking/invite', { campaignId: cp.id, participantId: p.id,
          creatorId: p.creatorId, handle: (byCreator[p.creatorId] || {}).handle, name: p.fullName });
      }
      await loadBooking(cp.id, true);
      toast(`${list.length} invite link${list.length === 1 ? '' : 's'} ready to copy`);
      notify();
    } catch (err) { toast(err.message); inviteAll.disabled = false; }
  });
}

/* ---- one creator, from the participant drawer ---- */
export async function inviteParticipantToBook(cp, p) {
  const cr = byCreator[p.creatorId] || {};
  try {
    const r = await bookingCall('/api/booking/invite', { campaignId: cp.id, participantId: p.id,
      creatorId: p.creatorId, name: p.fullName || cr.handle || '', handle: cr.handle || '' });
    copyText(inviteUrl(r.invite._id));
    toast('Link copied — send it to ' + (cr.handle || 'them'));
  } catch (err) { toast(err.message); }
}
