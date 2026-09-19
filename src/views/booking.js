import { DB, byCreator, notify } from '../model/db.js';
import { isBlocked } from '../model/settings.js';
import { partsOf } from '../model/stats.js';
import { $, $$, esc } from '../ui/dom.js';
import { copyText, statCard } from '../ui/html.js';
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
    <div class="card" style="margin-bottom:14px">
      <div class="card-head"><h3>Booking link</h3><div class="sp"></div>
        <span style="font-size:12px;color:var(--text-3)">read ${BOOKING.at ? BOOKING.at.toLocaleTimeString() : '—'}</span>
        <button class="btn xs" id="bkRefresh">Refresh</button>
        <span class="pill ${sc.status === 'open' ? 'green' : sc.status === 'paused' ? 'amber' : 'grey'}">${esc(sc.status)}</span></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px">
        <code style="font-size:12px;color:var(--text-2);word-break:break-all">${esc(bookingUrl(sc.publicToken))}</code>
        <button class="btn xs" id="bkCopy">Copy</button>
        <div class="sp"></div>
        <button class="btn xs" id="bkPause">${sc.status === 'paused' ? 'Reopen' : 'Pause'}</button>
      </div>
      <p class="card-sub" style="margin-top:10px">This is the fallback link — anyone holding it can book, and a
      name they type has to be matched by hand. Prefer <strong>Invite to book</strong> below: it fills the
      creator in, matches itself, and cannot become somebody else if it is forwarded.</p>
    </div>

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
      <div class="card-head"><h3>Availability</h3><div class="sp"></div>
        <button class="btn sm" id="bkAddDate">+ Add date</button></div>
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
              <td style="text-align:right"><button class="btn xs" data-block="${esc(d)}">${blocked ? 'Unblock' : 'Block day'}</button></td>
            </tr>` + (isOpen ? rows.map((s) => `<tr data-slot-row="1">
              <td style="padding-left:26px;color:var(--text-2)">${esc(s.time)}</td>
              <td colspan="2"><input type="number" min="1" value="${s.capacity}" data-cap="${esc(s._id)}"
                  style="width:70px;padding:3px 6px;font-size:12px"/> seats</td>
              <td>${s.booked} booked</td>
              <td style="text-align:right">
                <button class="btn xs" data-slotstatus="${esc(s._id)}" data-to="${s.status === 'open' ? 'closed' : 'open'}">${s.status === 'open' ? 'Close' : 'Open'}</button>
                <button class="btn xs" data-delslot="${esc(s._id)}"${s.booked ? ' disabled title="Someone has booked this"' : ''}>Delete</button>
              </td></tr>`).join('') + `<tr><td colspan="5" style="padding-left:26px">
                <input type="time" data-newtime="${esc(d)}" style="width:110px;padding:3px 6px;font-size:12px"/>
                <input type="number" min="1" value="1" data-newcap="${esc(d)}" style="width:60px;padding:3px 6px;font-size:12px"/> seats
                <button class="btn xs" data-addslot="${esc(d)}">+ Add time</button></td></tr>` : '');
        }).join('')}
      </tbody></table></div>` : '<p class="card-sub" style="margin-top:10px">No dates yet. Add one and the link starts working.</p>'}
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-head"><h3>Invite to book</h3><div class="sp"></div>
        ${toInvite.length ? `<button class="btn sm" id="bkInviteAll">Invite all ${toInvite.length}</button>` : ''}</div>
      ${BOOKING.invites.length ? `<div class="tbl-wrap" style="margin-top:10px"><table class="tbl"><thead><tr>
        <th>Creator</th><th>Status</th><th>Link</th></tr></thead><tbody>
        ${BOOKING.invites.map((i) => {
          const b = BOOKING.bookings.find((x) => x.participantId === i.participantId);
          return `<tr><td>${esc(i.name || i.handle || i.participantId)}</td>
            <td>${b ? `<span class="pill green">${esc(b.date)} ${esc(b.time)}</span>` : '<span class="pill grey">not booked yet</span>'}</td>
            <td><button class="btn xs" data-copyinvite="${esc(i._id)}">Copy link</button></td></tr>`;
        }).join('')}
      </tbody></table></div>` : ''}
      ${toInvite.length ? `<p class="card-sub" style="margin-top:10px">${toInvite.length} on the roster
        ${BOOKING.invites.length ? 'still have' : 'have'} no link: ${esc(toInvite.slice(0, 6).map((p) => (byCreator[p.creatorId] || {}).handle || '?').join(', '))}${toInvite.length > 6 ? ` and ${toInvite.length - 6} more` : ''}.</p>`
        : '<p class="card-sub" style="margin-top:10px">Everyone on the roster has a link.</p>'}
    </div>

    <div class="card">
      <div class="card-head"><h3>Bookings</h3></div>
      ${BOOKING.bookings.length ? `<div class="tbl-wrap" style="margin-top:10px"><table class="tbl"><thead><tr>
        <th>When</th><th>Creator</th><th>People</th><th>Booked by</th><th></th></tr></thead><tbody>
        ${BOOKING.bookings.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map((b) => {
          const p = b.participantId ? DB.participants.find((x) => x.id === b.participantId) : null;
          const cr = p ? byCreator[p.creatorId] : null;
          return `<tr>
            <td style="white-space:nowrap">${esc(b.date)} ${esc(b.time)}</td>
            <td>${cr ? esc(cr.handle) : `<span style="color:var(--amber)">${esc((b.guest || {}).handle || '—')} · unmatched</span>`}</td>
            <td>${b.partySize || 1}</td>
            <td><span class="pill grey">${esc(b.source || 'creator')}</span></td>
            <td style="text-align:right">
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

  $$('[data-delslot]').forEach((b) => b.addEventListener('click', () => guard(
    () => bookingCall('/api/booking/slot/' + b.dataset.delslot, null, 'DELETE'))));

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
    guard(() => bookingCall('/api/book/manage/' + bk.manageToken + '/cancel', { reason: 'cancelled by staff' }), 'Booking cancelled');
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
