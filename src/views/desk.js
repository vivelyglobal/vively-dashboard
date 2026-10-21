import { joinSlot } from '../import/notion.js';
import { DB, byCampaign, byCreator, notify } from '../model/db.js';
import { $, $$, esc } from '../ui/dom.js';
import { emptyState, flagMark } from '../ui/html.js';
import { closeDrawer, openDrawer, toast } from '../ui/overlay.js';
import { holidayList } from './booking.js';
import { showParticipant } from './campaigns.js';
import { ATTENDANCE, attendanceOf, pastCampaignsWith, setAttendance } from './planner.js';

/* ============================================================
   THE DESK — every campaign's bookings, in one window

   The Booking tab answers "what is happening on this campaign".
   With three restaurants running at once, nobody could answer "what is
   happening today" without three tabs open and the clashes held in
   their head. This page is that question asked once.

   It is not a second copy of anything. Every number on it comes from
   /api/booking/desk, and every change it makes goes through the same
   routes the Booking tab uses — so a move made here is the same write,
   and the roster, the visit calendar, the planner and the day sheet
   follow it the way they follow a move made there.

   Korea time throughout. A slot is already wall-clock at the venue and
   every venue is in Seoul, so the desk reads dates and times as written
   and converts nothing. The one place that matters is "today", which is
   the Korean day rather than the browser's.
   ============================================================ */

export const DESK_SPAN = 7;                 /* days on screen; the server caps at 31 */
export const DESK_TIGHT_HOURS = 3;          /* two visits closer than this is a tight day */
export const DESK_POLL_MS = 20000;

export const DESK = {
  from: '', day: '', view: 'grid', q: '',
  data: null, at: null, loading: false, error: '',
  stale: false, meta: '', poll: null, undo: null,
  only: '', drag: '', keys: false
};

export const kstToday = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
export const deskAdd = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
export const deskDayList = () => Array.from({ length: DESK_SPAN }, (_, i) => deskAdd(DESK.from, i));
export const deskMins = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  return m ? +m[1] * 60 + +m[2] : 0;
};
export function deskLabel(d) {
  const x = new Date(d + 'T00:00:00Z');
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][x.getUTCDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][x.getUTCMonth()];
  return `${wd} ${x.getUTCDate()} ${mo}`;
}

/* ---- loading, and noticing somebody else ---- */

export async function loadDesk(force) {
  if (!DESK.from) { DESK.from = kstToday(); DESK.day = DESK.from; }
  if (DESK.data && !force) return DESK.data;
  DESK.loading = true;
  try {
    const to = deskAdd(DESK.from, DESK_SPAN - 1);
    const res = await fetch(`/api/booking/desk?from=${DESK.from}&to=${to}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Could not read the bookings.');
    DESK.data = body;
    DESK.at = new Date();
    DESK.error = '';
    DESK.stale = false;
    DESK.meta = deskMetaKey(body);
  } catch (err) {
    DESK.error = err.message;
  }
  DESK.loading = false;
  return DESK.data;
}

export const deskMetaKey = (m) => [m.slots != null ? m.slots : (m.slots || []).length,
  m.bookings != null && !Array.isArray(m.bookings) ? m.bookings : (m.bookings || []).length,
  m.lastChange || ''].join('|');

/* Three people and a creator on a phone all change this page. The poll
   is the cheap half of the same question: counts and the newest change,
   never the whole desk. */
export async function deskPollOnce() {
  if (!DESK.data || DESK.loading) return;
  try {
    const to = deskAdd(DESK.from, DESK_SPAN - 1);
    const res = await fetch(`/api/booking/desk/meta?from=${DESK.from}&to=${to}`);
    if (!res.ok) return;
    const m = await res.json();
    const key = deskMetaKey(m);
    if (DESK.meta && key !== DESK.meta && !DESK.stale) { DESK.stale = true; notify(); }
  } catch (e) { /* offline: the freshness line already says when it was read */ }
}

export function deskStartPoll() {
  if (DESK.poll) return;
  DESK.poll = setInterval(() => {
    if (!location.hash.startsWith('#/desk')) { clearInterval(DESK.poll); DESK.poll = null; return; }
    deskPollOnce();
  }, DESK_POLL_MS);
}

/* ---- joining the booking to the person ---- */

export function deskSchedule(id) { return ((DESK.data || {}).schedules || []).find((s) => s._id === id) || null; }
export function deskVenue(id) {
  const sc = deskSchedule(id);
  const cp = sc ? byCampaign[sc.campaignId] : null;
  return { sc, cp, name: (sc && sc.venueName) || (cp && cp.brand) || 'Campaign', brand: (cp && cp.brand) || '' };
}

/* Which human a booking belongs to. The roster row is per campaign, so
   two rows are two rows — but a creator at two restaurants in one night
   is one person with a problem, and that is the whole reason this page
   exists. The creator is the identity; the roster row is only how we
   reached them. */
export function deskKey(b, w) {
  return (w && w.cr && w.cr.id) || b.creatorId || b.participantId || (w && w.handle) || '?';
}

export function deskWho(b) {
  const p = b.participantId ? DB.participants.find((x) => x.id === b.participantId) : null;
  const cr = p ? byCreator[p.creatorId] : (b.creatorId ? byCreator[b.creatorId] : null);
  return {
    p, cr,
    handle: (cr && cr.handle) || (b.guest && b.guest.handle) || (b.guest && b.guest.name) || 'Unmatched',
    matched: !!p,
    flag: (cr && cr.flag) || null,
    repeat: !!(p && typeof pastCampaignsWith === 'function' && pastCampaignsWith(p))
  };
}

/* The panel on the left narrows the desk to one venue. Everything the
   page counts goes through these three, so narrowing cannot leave a
   number behind that still counts the others. */
export const deskScheduleIds = () => new Set(deskSchedules().map((s) => s._id));
export function deskSchedules() {
  return ((DESK.data || {}).schedules || [])
    .filter((s) => byCampaign[s.campaignId] && (!DESK.only || s.campaignId === DESK.only));
}
export const deskBookings = () => { const ok = deskScheduleIds();
  return ((DESK.data || {}).bookings || []).filter((b) => ok.has(b.scheduleId)); };
export const deskBookingsOn = (day) => deskBookings().filter((b) => b.date === day);
export const deskSlots = () => { const ok = deskScheduleIds();
  return ((DESK.data || {}).slots || []).filter((s) => ok.has(s.scheduleId)); };
export const deskSlotsOn = (day) => deskSlots().filter((s) => s.date === day);
export const deskClosed = (sc, day) => !!sc && ((sc.closedDates || []).includes(day) || sc.status !== 'open');

/* ---- what needs a person ---- */

export function deskClashes(day) {
  const out = [];
  const rows = deskBookingsOn(day);
  const hol = {};
  (typeof holidayList === 'function' ? holidayList() : []).forEach((h) => { hol[h.d] = h.n || 'Holiday'; });

  /* the same creator twice in a day, wherever those bookings live */
  const byWho = {};
  rows.forEach((b) => {
    const w = deskWho(b);
    const key = deskKey(b, w);
    (byWho[key] = byWho[key] || []).push({ b, w });
  });
  Object.values(byWho).forEach((list) => {
    if (list.length < 2) return;
    const s = list.slice().sort((a, x) => deskMins(a.b.time) - deskMins(x.b.time));
    for (let i = 1; i < s.length; i++) {
      const gap = (deskMins(s[i].b.time) - deskMins(s[i - 1].b.time)) / 60;
      const a = deskVenue(s[i - 1].b.scheduleId), z = deskVenue(s[i].b.scheduleId);
      out.push({
        bad: gap < DESK_TIGHT_HOURS, kind: 'double', bookingId: s[i].b._id,
        text: `${s[i].w.handle} is booked twice on ${deskLabel(day)}`,
        why: `${a.name} ${s[i - 1].b.time} and ${z.name} ${s[i].b.time} — ${Math.round(gap * 10) / 10} h apart`
          + (a.name === z.name ? ', same venue' : ', two venues')
      });
    }
  });

  deskSchedules().forEach((sc) => {
    const mine = rows.filter((b) => b.scheduleId === sc._id);
    const v = deskVenue(sc._id);

    /* more people than the sitting holds */
    const heads = {};
    mine.forEach((b) => { heads[b.time] = (heads[b.time] || 0) + (b.partySize || 1); });
    deskSlotsOn(day).filter((s) => s.scheduleId === sc._id).forEach((s) => {
      const n = heads[s.time] || 0;
      if (n > (s.capacity || 0)) out.push({ bad: true, kind: 'over', bookingId: null,
        text: `${v.name} ${s.time} is over capacity`,
        why: `${n} booked into ${s.capacity} seat${s.capacity === 1 ? '' : 's'}` });
    });

    /* more teams than the venue agreed to in a day */
    const cap = Math.max(0, Math.floor(Number(sc.maxPerDay) || 0));
    if (cap && mine.length > cap) out.push({ bad: true, kind: 'daycap', bookingId: null,
      text: `${v.name} has ${mine.length} teams on ${deskLabel(day)}`,
      why: `the daily limit is ${cap} — somebody went over it on purpose, or the limit changed afterwards` });

    /* booked on a day the venue is shut */
    if (mine.length && deskClosed(sc, day)) out.push({ bad: true, kind: 'closed', bookingId: mine[0]._id,
      text: `${v.name} is closed on ${deskLabel(day)}`,
      why: sc.status !== 'open' ? `booking is ${sc.status} for this campaign` : 'the day is blocked, and somebody is booked on it' });
    if (mine.length && hol[day]) out.push({ bad: false, kind: 'holiday', bookingId: null,
      text: `${deskLabel(day)} is ${hol[day]}`, why: `${v.name} has ${mine.length} booked that day` });
  });

  /* who is coming */
  rows.forEach((b) => {
    const w = deskWho(b);
    const v = deskVenue(b.scheduleId);
    if (w.flag) out.push({ bad: w.flag === 'blocked', kind: 'flag', bookingId: b._id,
      text: `${w.handle} is ${w.flag === 'blocked' ? 'blacklisted' : 'marked caution'}`,
      why: `booked at ${v.name} ${b.time}${w.cr && w.cr.flagReason ? ' — ' + w.cr.flagReason : ''}` });
    if (!w.matched) out.push({ bad: false, kind: 'unmatched', bookingId: b._id,
      text: `${b.guest && b.guest.handle ? b.guest.handle : 'Somebody'} booked on the open link`,
      why: `${v.name} ${b.time} — not matched to anyone on the roster yet` });
  });

  return out;
}

/* Links that went out and were never used: the chase list that fills
   the grid. Deliberately over the whole window, not one day. */
export function deskChores() {
  const d = DESK.data || {};
  const booked = new Set((d.bookings || []).map((b) => b.participantId).filter(Boolean));
  const unused = (d.invites || []).filter((i) => i.participantId && !booked.has(i.participantId)
    && (!DESK.only || i.campaignId === DESK.only));
  const byCamp = {};
  unused.forEach((i) => { (byCamp[i.campaignId] = byCamp[i.campaignId] || []).push(i); });
  return Object.entries(byCamp).map(([cid, list]) => ({
    campaignId: cid,
    brand: (byCampaign[cid] || {}).brand || 'A campaign',
    list,
    text: `${list.length} link${list.length === 1 ? '' : 's'} sent and never used`,
    why: `${(byCampaign[cid] || {}).brand || 'A campaign'} — ${list.slice(0, 4).map((i) => i.handle || i.name || '—').join(', ')}${list.length > 4 ? ' and others' : ''}`
  }));
}

export function deskPeople() {
  const rows = {};
  deskBookings().forEach((b) => {
    const w = deskWho(b);
    const key = deskKey(b, w);
    (rows[key] = rows[key] || { who: w, list: [] }).list.push(b);
  });
  const q = DESK.q.trim().toLowerCase();
  return Object.values(rows)
    .filter((r) => !q || r.who.handle.toLowerCase().includes(q))
    .sort((a, z) => a.who.handle.localeCompare(z.who.handle));
}

export function deskMatchesQuery(b) {
  const q = DESK.q.trim().toLowerCase();
  if (!q) return true;
  const w = deskWho(b), v = deskVenue(b.scheduleId);
  return (w.handle + ' ' + v.name + ' ' + v.brand).toLowerCase().includes(q);
}

/* ---- the page ---- */

export function ensureDeskStyles() {
  if (document.getElementById('dkCss')) return;
  const s = document.createElement('style');
  s.id = 'dkCss';
  s.textContent = `
  .dk-band{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:var(--line);
    border:1px solid var(--line);border-radius:var(--r-lg);overflow:hidden;margin-bottom:12px}
  .dk-b{background:var(--surface);padding:12px 14px}
  .dk-b .lab{font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em}
  .dk-b .big{font-size:26px;font-weight:600;line-height:1.15;margin-top:3px}
  .dk-b .big.warn{color:var(--warning)} .dk-b .big.bad{color:#f08a8a}
  .dk-b .cap{font-size:11.5px;color:var(--text-3)}
  .dk-next{display:flex;gap:8px;overflow-x:auto;padding:2px 0 12px}
  .dk-nx{flex:0 0 auto;background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--s1);
    border-radius:var(--r);padding:8px 11px;min-width:166px}
  .dk-nx .t{font-size:15px;font-weight:600}
  .dk-nx .m{font-size:11.5px;color:var(--text-3);margin-top:2px}
  .dk-days{display:flex;gap:6px;overflow-x:auto;padding:2px 0 10px}
  .dk-day{min-width:96px;flex:0 0 auto;background:var(--surface);border:1px solid var(--line);
    border-radius:var(--r);padding:8px 10px;cursor:pointer;text-align:left;color:var(--text);font:inherit}
  .dk-day.on{border-color:var(--blue);background:var(--blue-soft)}
  .dk-day .d{font-size:11.5px;color:var(--text-3)} .dk-day .n{font-size:15px;font-weight:600;margin-top:2px}
  .dk-day .w{font-size:11px;margin-top:2px;color:var(--warning)}
  .dk-q{display:flex;gap:10px;align-items:flex-start;padding:9px 12px;border-bottom:1px solid var(--line)}
  .dk-q:last-child{border-bottom:0}
  .dk-q .ic{width:22px;height:22px;flex:0 0 22px;border-radius:6px;display:grid;place-items:center;font-size:11px;margin-top:1px}
  .dk-q .t{font-size:12.5px} .dk-q .why{font-size:11.5px;color:var(--text-3);margin-top:2px}
  .dk-q .act{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
  .dk-grid{display:grid;gap:1px;background:var(--line);border:1px solid var(--line);
    border-radius:var(--r-lg);overflow:hidden;margin-top:14px}
  .dk-cell{background:var(--surface);padding:8px 9px;min-height:44px;display:flex;flex-direction:column;gap:5px}
  .dk-head{background:var(--surface-2);padding:10px}
  .dk-head .v{font-weight:600;font-size:13px}
  .dk-head .m{font-size:11.5px;color:var(--text-3);margin-top:2px}
  .dk-time{background:var(--surface-2);color:var(--text-3);font-size:11.5px;padding:8px;text-align:right;white-space:nowrap}
  .dk-bk{background:var(--surface-2);border:1px solid var(--line);border-left:3px solid var(--s1);
    border-radius:6px;padding:6px 8px;font-size:12px;cursor:grab}
  .dk-bk:hover{border-color:var(--line-strong)}
  .dk-bk.dragging{opacity:.4}
  .dk-bk.warn{border-left-color:var(--warning)} .dk-bk.bad{border-left-color:var(--critical)}
  .dk-bk .h{font-weight:500;display:flex;gap:5px;align-items:center;flex-wrap:wrap}
  .dk-bk .m{color:var(--text-3);font-size:11px;margin-top:3px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  .dk-bk .acts{display:flex;gap:4px;margin-top:5px;flex-wrap:wrap}
  .dk-free{border:1px dashed var(--line-strong);border-radius:6px;color:var(--text-3);font-size:11.5px;
    padding:5px 8px;text-align:center;cursor:pointer;background:none;font:inherit;width:100%}
  .dk-free:hover{color:var(--blue-hi);border-color:var(--blue)}
  .dk-free.full{opacity:.4;cursor:default}
  .dk-shut{color:var(--text-3);font-size:11.5px;font-style:italic}
  .dk-pr{display:grid;grid-template-columns:210px 1fr;gap:10px;padding:9px 12px;border-bottom:1px solid var(--line)}
  .dk-pr:last-child{border-bottom:0}
  .dk-chips{display:flex;gap:6px;flex-wrap:wrap}
  .dk-chip{background:var(--surface-2);border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:11.5px}
  .dk-chip.clash{border-color:rgba(250,178,25,.5);color:#f5c451}
  .dk-stale{background:rgba(250,178,25,.12);border:1px solid rgba(250,178,25,.4);color:#f5c451;
    border-radius:var(--r);padding:8px 12px;font-size:12.5px;margin-bottom:10px;display:flex;gap:10px;align-items:center}
  @media(max-width:1000px){.dk-band{grid-template-columns:repeat(2,1fr)}}
  @media(max-width:820px){
    .dk-grid{display:block;background:none;border:0}
    .dk-head{border-radius:var(--r);margin-top:10px;border:1px solid var(--line)}
    .dk-time{text-align:left;font-weight:600;color:var(--text-2);background:none;padding:10px 2px 4px}
    .dk-cell{border:1px solid var(--line);border-radius:var(--r);margin-bottom:6px}
    .dk-pr{grid-template-columns:1fr}
  }`;
  document.head.appendChild(s);
}

export function renderDesk(view, item) {
  ensureDeskStyles();
  DESK.only = item && item !== 'today' ? item : '';
  if (!DESK.from) { DESK.from = kstToday(); DESK.day = DESK.from; }

  if (!DESK.data) {
    view.innerHTML = `<div class="empty">Reading every campaign's bookings…</div>`;
    loadDesk().then(() => notify());
    return;
  }
  if (DESK.error) {
    view.innerHTML = `<div class="note bad">${esc(DESK.error)}</div>
      <p class="card-sub" style="margin-top:10px">The desk needs the server — the rest of the dashboard works
      offline, this page does not. <button class="btn sm" id="dkRetry">Try again</button></p>`;
    $('#dkRetry').addEventListener('click', () => loadDesk(true).then(() => notify()));
    return;
  }

  const schedules = deskSchedules();
  if (!schedules.length) {
    view.innerHTML = emptyState('No campaign takes bookings yet',
      'Set booking up on a campaign and every venue shows here, side by side.');
    return;
  }

  const day = DESK.day;
  const rows = deskBookingsOn(day).filter(deskMatchesQuery);
  const heads = rows.reduce((a, b) => a + (b.partySize || 1), 0);
  const cs = deskClashes(day);
  const chores = deskChores();
  const bad = cs.filter((c) => c.bad).length;
  const openVenues = schedules.filter((s) => !deskClosed(s, day)).length;
  const doubles = new Set(cs.filter((c) => c.kind === 'double').map((c) => c.bookingId)).size;

  view.innerHTML = `
    ${DESK.stale ? `<div class="dk-stale"><span>Somebody else changed a booking since this was read.</span>
      <button class="btn xs" id="dkRefresh">Read it again</button></div>` : ''}
    ${DESK.undo ? `<div class="dk-stale" style="background:var(--surface-2);border-color:var(--line);color:var(--text-2)">
      <span>Moved ${esc(DESK.undo.label)}.</span>
      <button class="btn xs" id="dkUndo">Put it back</button></div>` : ''}

    <div class="dk-band">
      <div class="dk-b"><div class="lab">Visits on ${esc(deskLabel(day))}</div>
        <div class="big">${rows.length}</div>
        <div class="cap">${heads} ${heads === 1 ? 'person' : 'people'} expected</div></div>
      <div class="dk-b"><div class="lab">Venues open</div>
        <div class="big">${openVenues}/${schedules.length}</div>
        <div class="cap">${schedules.length - openVenues} closed today</div></div>
      <div class="dk-b"><div class="lab">Needs a person</div>
        <div class="big ${bad ? 'bad' : cs.length ? 'warn' : ''}">${cs.length}</div>
        <div class="cap">${bad ? bad + ' urgent' : cs.length ? 'none urgent' : 'nothing waiting'}</div></div>
      <div class="dk-b"><div class="lab">This week</div>
        <div class="big">${deskBookings().length}</div>
        <div class="cap">across ${schedules.length} campaign${schedules.length === 1 ? '' : 's'}</div></div>
      <div class="dk-b"><div class="lab">In two places</div>
        <div class="big ${doubles ? 'warn' : ''}">${doubles}</div>
        <div class="cap">booked twice in one day</div></div>
    </div>

    <div class="card-head" style="margin-bottom:8px">
      <button class="btn sm" id="dkPrev">←</button>
      <strong style="font-size:14px">${esc(deskLabel(day))}</strong>
      <button class="btn sm" id="dkNext">→</button>
      <button class="btn sm" id="dkToday">Today</button>
      <div class="sp"></div>
      <input type="search" id="dkQ" placeholder="Find a creator or venue…" value="${esc(DESK.q)}"
        style="width:210px;padding:5px 9px;font-size:12.5px"/>
      <div class="seg" id="dkSeg">
        <button data-v="grid" class="${DESK.view === 'grid' ? 'active' : ''}">By venue</button>
        <button data-v="people" class="${DESK.view === 'people' ? 'active' : ''}">By creator</button>
      </div>
      <button class="btn sm" id="dkReload" title="Read every campaign's bookings again">Refresh</button>
    </div>
    <div style="font-size:11.5px;color:var(--text-3);margin:-4px 0 8px">
      Read ${DESK.at ? DESK.at.toLocaleTimeString() : '—'} · Korea time · ← → to change the day
    </div>

    <div class="dk-next">${deskNextHtml(day)}</div>
    <div class="dk-days">${deskDayList().map((d) => deskDayBtn(d)).join('')}</div>
    ${deskQueueHtml(cs, chores, day)}
    <div id="dkBody">${DESK.view === 'people' ? deskPeopleHtml() : deskGridHtml(day)}</div>`;

  wireDesk(day);
  deskStartPoll();
}

export function deskDayBtn(d) {
  const n = deskBookingsOn(d).length;
  const c = deskClashes(d);
  return `<button class="dk-day ${d === DESK.day ? 'on' : ''}" data-dkday="${esc(d)}">
    <div class="d">${esc(deskLabel(d))}${d === kstToday() ? ' · today' : ''}</div>
    <div class="n">${n}</div>
    <div class="w" style="${c.length ? '' : 'color:var(--text-3)'}">${c.length ? c.length + ' to look at' : 'clear'}</div>
  </button>`;
}

export function deskNextHtml(day) {
  const rows = deskBookingsOn(day).slice().sort((a, b) => deskMins(a.time) - deskMins(b.time)).slice(0, 6);
  if (!rows.length) return `<div class="dk-nx" style="border-left-color:var(--line-strong)">
    <div class="m">Nobody is coming on ${esc(deskLabel(day))}.</div></div>`;
  return rows.map((b) => {
    const v = deskVenue(b.scheduleId), w = deskWho(b);
    return `<div class="dk-nx"><div class="t">${esc(b.time)}</div>
      <div class="m">${esc(w.handle)} · ${b.partySize || 1} ${(b.partySize || 1) === 1 ? 'person' : 'people'}</div>
      <div class="m">${esc(v.name)}</div></div>`;
  }).join('');
}

export function deskQueueHtml(cs, chores, day) {
  const total = cs.length + chores.length;
  if (!total) return `<div class="note" style="margin:4px 0 0">Nothing needs a person on ${esc(deskLabel(day))}.</div>`;
  return `<div class="card" style="margin:4px 0 0">
    <div style="padding:11px 12px;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--text-2)">
      <strong style="color:var(--text)">${total} thing${total === 1 ? '' : 's'} need a person</strong> · ${esc(deskLabel(day))}</div>
    ${cs.map((c) => `<div class="dk-q">
      <div class="ic" style="background:${c.bad ? 'rgba(208,59,59,.2)' : 'rgba(250,178,25,.18)'};
        color:${c.bad ? '#f08a8a' : '#f5c451'}">${c.bad ? '!' : '•'}</div>
      <div style="flex:1;min-width:0"><div class="t">${esc(c.text)}</div><div class="why">${esc(c.why)}</div>
        ${c.bookingId ? `<div class="act">
          <button class="btn xs" data-dkmove="${esc(c.bookingId)}">Move this one</button>
          <button class="btn xs" data-dkopen="${esc(c.bookingId)}">Open the row</button></div>` : ''}
      </div></div>`).join('')}
    ${chores.map((c) => `<div class="dk-q">
      <div class="ic" style="background:var(--surface-2)">↗</div>
      <div style="flex:1;min-width:0"><div class="t">${esc(c.text)}</div><div class="why">${esc(c.why)}</div>
        <div class="act"><button class="btn xs" data-dkcamp="${esc(c.campaignId)}">Open the booking tab</button></div>
      </div></div>`).join('')}
  </div>`;
}

export function deskGridHtml(day) {
  const schedules = deskSchedules();
  const slots = deskSlotsOn(day);
  const times = [...new Set(slots.map((s) => s.time))].sort((a, b) => deskMins(a) - deskMins(b));
  const cols = `92px repeat(${schedules.length}, minmax(176px,1fr))`;

  const head = schedules.map((sc) => {
    const v = deskVenue(sc._id);
    const mine = deskBookingsOn(day).filter((b) => b.scheduleId === sc._id);
    const shut = deskClosed(sc, day);
    const cap = Math.max(0, Math.floor(Number(sc.maxPerDay) || 0));
    return `<div class="dk-head"><div class="v">${esc(v.name)}</div>
      <div class="m">${esc(v.brand)} · ${shut ? (sc.status !== 'open' ? sc.status : 'closed today')
        : `${mine.length} team${mine.length === 1 ? '' : 's'}${cap ? ' of ' + cap : ''}`}</div>
      <button class="btn xs" style="margin-top:6px" data-dkaddtime="${esc(sc._id)}">+ time</button></div>`;
  }).join('');

  if (!times.length) {
    return `<div class="dk-grid" style="grid-template-columns:${cols}">
      <div class="dk-head"></div>${head}
      <div class="dk-time">—</div>
      ${schedules.map((sc) => `<div class="dk-cell"><span class="dk-shut">no times on this day</span>
        </div>`).join('')}</div>`;
  }

  const body = times.map((t) => `<div class="dk-time">${esc(t)}</div>` + schedules.map((sc) => {
    const slot = slots.find((s) => s.scheduleId === sc._id && s.time === t);
    if (!slot) return `<div class="dk-cell"></div>`;
    if (deskClosed(sc, day)) return `<div class="dk-cell"><span class="dk-shut">closed</span></div>`;
    const here = deskBookingsOn(day).filter((b) => b.slotId === slot._id).filter(deskMatchesQuery);
    const used = here.reduce((a, b) => a + (b.partySize || 1), 0);
    const free = Math.max(0, (slot.capacity || 0) - used);
    return `<div class="dk-cell" data-dkslot="${esc(slot._id)}">
      ${here.map((b) => deskCardHtml(b, day)).join('')}
      ${free ? `<button class="dk-free" data-dkinvite="${esc(sc._id)}">${free} free</button>`
        : `<div class="dk-free full">full</div>`}</div>`;
  }).join('')).join('');

  return `<div class="dk-grid" style="grid-template-columns:${cols}">
    <div class="dk-head"></div>${head}${body}</div>`;
}

export function deskCardHtml(b, day) {
  const w = deskWho(b);
  const past = day <= kstToday();
  const att = w.p ? attendanceOf(w.p) : '';
  const cls = w.flag === 'blocked' ? 'bad' : (w.flag || !w.matched) ? 'warn' : '';
  return `<div class="dk-bk ${cls}" draggable="true" data-dkbk="${esc(b._id)}">
    <div class="h">${esc(w.handle)}
      ${w.repeat ? '<span class="flag-mark" title="worked with us before" style="margin-left:0">↻</span>' : ''}
      ${w.flag ? flagMark(w.cr) : ''}
      ${!w.matched ? '<span class="pill grey">unmatched</span>' : ''}</div>
    <div class="m"><span>${b.partySize || 1} ${(b.partySize || 1) === 1 ? 'person' : 'people'}</span>
      ${b.overDailyLimit ? '<span class="pill amber">over the daily limit</span>' : ''}
      ${b.overCapacity ? '<span class="pill amber">over capacity</span>' : ''}
      ${att ? `<span class="pill ${ATTENDANCE[att].cls}">${ATTENDANCE[att].label}</span>` : ''}</div>
    <div class="acts">
      <button class="btn xs" data-dkmove="${esc(b._id)}">Move</button>
      ${w.matched && past ? `<button class="btn xs" data-dkatt="${esc(b._id)}" data-v="attended">Turned up</button>
        <button class="btn xs" data-dkatt="${esc(b._id)}" data-v="no_show">No-show</button>` : ''}
      ${w.matched ? `<button class="btn xs" data-dkopen="${esc(b._id)}">Row</button>` : ''}
    </div></div>`;
}

export function deskPeopleHtml() {
  const rows = deskPeople();
  if (!rows.length) return `<div class="note" style="margin-top:14px">Nobody is booked in this window.</div>`;
  return `<div class="card" style="margin-top:14px">
    <div style="padding:11px 12px;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--text-2)">
      <strong style="color:var(--text)">By creator</strong> — everything they hold across every campaign in this week</div>
    ${rows.map((r) => {
      const camps = new Set(r.list.map((b) => b.campaignId));
      const byDay = {};
      r.list.forEach((b) => { (byDay[b.date] = byDay[b.date] || []).push(b); });
      return `<div class="dk-pr">
        <div><div style="font-weight:500">${esc(r.who.handle)} ${r.who.flag ? flagMark(r.who.cr) : ''}</div>
          <div style="font-size:11.5px;color:var(--text-3)">${r.list.length} booking${r.list.length === 1 ? '' : 's'}
            · ${camps.size} campaign${camps.size === 1 ? '' : 's'}</div>
          ${camps.size > 1 ? '<span class="pill blue" style="margin-top:4px">in more than one</span>' : ''}</div>
        <div class="dk-chips">${r.list.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
          .map((b) => {
            const twice = byDay[b.date].length > 1;
            const v = deskVenue(b.scheduleId);
            return `<button class="dk-chip ${twice ? 'clash' : ''}" data-dkgo="${esc(b.date)}"
              title="${esc(v.name)}">${esc(deskLabel(b.date).slice(0, 6))} ${esc(b.time)} · ${esc(v.brand || v.name)}${twice ? ' ⚠' : ''}</button>`;
          }).join('')}</div></div>`;
    }).join('')}</div>`;
}

/* ---- making the change ---- */

export function wireDesk(day) {
  const hop = (n) => {
    const next = deskAdd(DESK.day, n);
    /* stepping past the edge of the window slides the window itself,
       so the arrows never hit a wall */
    if (next < DESK.from || next > deskAdd(DESK.from, DESK_SPAN - 1)) {
      DESK.from = next; DESK.day = next; DESK.data = null; notify(); return;
    }
    DESK.day = next; notify();
  };
  const on = (sel, ev, fn) => $$(sel).forEach((el) => el.addEventListener(ev, fn));

  const prev = $('#dkPrev'), nxt = $('#dkNext'), tod = $('#dkToday');
  if (prev) prev.addEventListener('click', () => hop(-1));
  if (nxt) nxt.addEventListener('click', () => hop(1));
  if (tod) tod.addEventListener('click', () => {
    DESK.from = kstToday(); DESK.day = DESK.from; DESK.data = null; notify();
  });
  on('[data-dkday]', 'click', (e) => { DESK.day = e.currentTarget.dataset.dkday; notify(); });
  on('[data-dkgo]', 'click', (e) => {
    const d = e.currentTarget.dataset.dkgo;
    if (d < DESK.from || d > deskAdd(DESK.from, DESK_SPAN - 1)) { DESK.from = d; DESK.data = null; }
    DESK.day = d; DESK.view = 'grid'; notify();
  });

  const reload = $('#dkReload'), refresh = $('#dkRefresh');
  if (reload) reload.addEventListener('click', () => loadDesk(true).then(() => notify()));
  if (refresh) refresh.addEventListener('click', () => loadDesk(true).then(() => notify()));

  on('#dkSeg button', 'click', (e) => { DESK.view = e.currentTarget.dataset.v; notify(); });

  /* Typing must not redraw the whole page — the input would lose the
     caret on every letter. Only the body below the controls changes. */
  const q = $('#dkQ');
  if (q) q.addEventListener('input', () => {
    DESK.q = q.value;
    const body = $('#dkBody');
    if (!body) return;
    body.innerHTML = DESK.view === 'people' ? deskPeopleHtml() : deskGridHtml(DESK.day);
    wireDeskBody(DESK.day);
  });

  const undo = $('#dkUndo');
  if (undo) undo.addEventListener('click', deskUndo);

  wireDeskBody(day);
  wireDeskKeys();
}

export function wireDeskKeys() {
  if (DESK.keys) return;
  DESK.keys = true;
  document.addEventListener('keydown', (e) => {
    if (!location.hash.startsWith('#/desk')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if ($('#drawer') && $('#drawer').classList.contains('open')) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const n = e.key === 'ArrowLeft' ? -1 : 1;
      const next = deskAdd(DESK.day, n);
      if (next < DESK.from || next > deskAdd(DESK.from, DESK_SPAN - 1)) {
        DESK.from = next; DESK.day = next; DESK.data = null;
      } else DESK.day = next;
      notify();
    } else if (e.key === '/') { e.preventDefault(); const q = $('#dkQ'); if (q) q.focus(); }
  });
}

export function wireDeskBody(day) {
  const on = (sel, ev, fn) => $$(sel).forEach((el) => el.addEventListener(ev, fn));

  on('[data-dkmove]', 'click', (e) => { e.stopPropagation(); openDeskMove(e.currentTarget.dataset.dkmove); });
  on('[data-dkopen]', 'click', (e) => {
    e.stopPropagation();
    const b = deskBooking(e.currentTarget.dataset.dkopen);
    const w = b ? deskWho(b) : null;
    if (w && w.p) showParticipant(w.p.id);
    else toast('That booking is not matched to anyone on the roster yet.');
  });
  on('[data-dkatt]', 'click', (e) => {
    e.stopPropagation();
    const b = deskBooking(e.currentTarget.dataset.dkatt);
    const w = b ? deskWho(b) : null;
    if (!w || !w.p) return;
    setAttendance(w.p, e.currentTarget.dataset.v);
    toast(attendanceOf(w.p) ? `${w.handle} — ${ATTENDANCE[attendanceOf(w.p)].label.toLowerCase()}` : 'Attendance cleared');
    notify();
  });
  on('[data-dkaddtime]', 'click', (e) => openDeskAddTime(e.currentTarget.dataset.dkaddtime, day));
  on('[data-dkcamp]', 'click', (e) => { location.hash = '#/campaigns/' + e.currentTarget.dataset.dkcamp + '/booking'; });
  on('[data-dkinvite]', 'click', (e) => {
    const sc = deskSchedule(e.currentTarget.dataset.dkinvite);
    if (sc) location.hash = '#/campaigns/' + sc.campaignId + '/booking';
  });

  /* Dragging a card onto a time is the whole point of the grid: it is
     the one gesture that says "put them there" without a form. It makes
     the same request the Move button does, so nothing can diverge. */
  on('[data-dkbk]', 'dragstart', (e) => {
    DESK.drag = e.currentTarget.dataset.dkbk;
    e.currentTarget.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', DESK.drag); e.dataTransfer.effectAllowed = 'move'; } catch (err) { /* older browsers */ }
  });
  on('[data-dkbk]', 'dragend', (e) => { e.currentTarget.classList.remove('dragging'); DESK.drag = ''; });
  on('[data-dkslot]', 'dragover', (e) => { if (DESK.drag) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } });
  on('[data-dkslot]', 'drop', (e) => {
    e.preventDefault();
    const id = DESK.drag || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
    DESK.drag = '';
    if (id) deskMove(id, e.currentTarget.dataset.dkslot);
  });
}

export const deskBooking = (id) => ((DESK.data || {}).bookings || []).find((b) => b._id === id) || null;

export function openDeskMove(bookingId) {
  const b = deskBooking(bookingId);
  if (!b) return;
  const w = deskWho(b), v = deskVenue(b.scheduleId);
  const mine = ((DESK.data || {}).slots || []).filter((s) => s.scheduleId === b.scheduleId)
    .slice().sort((a, z) => (a.date + a.time).localeCompare(z.date + z.time));
  const byDate = {};
  mine.forEach((s) => { (byDate[s.date] = byDate[s.date] || []).push(s); });
  const sc = deskSchedule(b.scheduleId);
  const cap = Math.max(0, Math.floor(Number((sc || {}).maxPerDay) || 0));

  const body = `
    <p class="card-sub">${esc(w.handle)} is at <strong>${esc(v.name)}</strong> on
      ${esc(deskLabel(b.date))} at ${esc(b.time)} — ${b.partySize || 1}
      ${(b.partySize || 1) === 1 ? 'person' : 'people'}.</p>
    <p class="card-sub" style="margin-top:4px">Pick the new time. Only this venue's own times are listed:
      a booking belongs to the campaign that issued it, so it cannot be moved to a different restaurant.</p>
    ${Object.keys(byDate).length ? Object.entries(byDate).map(([d, list]) => {
      const onDay = deskBookingsOn(d).filter((x) => x.scheduleId === b.scheduleId).length;
      const shut = deskClosed(sc, d);
      return `<div style="margin-top:12px">
        <div style="font-size:12px;color:var(--text-3)">${esc(deskLabel(d))}
          ${shut ? ' · closed' : ''}${cap ? ` · ${onDay} of ${cap} teams` : ''}</div>
        <div class="dk-chips" style="margin-top:5px">${list.map((s) => {
          const free = Math.max(0, (s.capacity || 0) - (s.booked || 0));
          const here = s._id === b.slotId;
          return `<button class="dk-chip" data-dkto="${esc(s._id)}" ${here ? 'disabled style="opacity:.45"' : ''}
            title="${free} free of ${s.capacity || 0}">${esc(s.time)} · ${here ? 'now' : free ? free + ' free' : 'full'}</button>`;
        }).join('')}</div></div>`;
    }).join('') : `<div class="note" style="margin-top:12px">This venue has no other times in the window.
      Add one on the day's column with <strong>+ time</strong>, or open the campaign's Booking tab.</div>`}`;

  openDrawer(`Move ${esc(w.handle)}`, body);
  $$('[data-dkto]').forEach((el) => el.addEventListener('click', () => {
    closeDrawer();
    deskMove(bookingId, el.dataset.dkto);
  }));
}

export async function deskMove(bookingId, slotId, opts) {
  const b = deskBooking(bookingId);
  if (!b || b.slotId === slotId) return;
  const from = b.slotId;
  const w = deskWho(b);
  const to = ((DESK.data || {}).slots || []).find((s) => s._id === slotId);
  const body = Object.assign({ slotId }, opts || {});
  try {
    const res = await fetch(`/api/booking/booking/${encodeURIComponent(bookingId)}/move`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const out = await res.json();
    if (!res.ok) {
      /* The two refusals a person is allowed to overrule. Both are
         deliberate: the server says no, a human says do it anyway, and
         the booking carries a mark saying which rule was bent. */
      if (out.code === 'slot_full' && !body.overCapacity) {
        if (window.confirm(`${out.error} Seat ${w.handle} over the capacity anyway?`))
          return deskMove(bookingId, slotId, Object.assign({}, body, { overCapacity: true }));
        return;
      }
      if (out.code === 'day_full' && !body.overDaily) {
        if (window.confirm(`${out.error}\n\nGo over the daily limit? It will be recorded against this booking.`))
          return deskMove(bookingId, slotId, Object.assign({}, body, { overDaily: true }));
        return;
      }
      toast(out.error || 'Could not move that booking.');
      return;
    }
    DESK.undo = out.unchanged ? null
      : { bookingId, slotId: from, label: `${w.handle} → ${to ? deskLabel(to.date) + ' ' + to.time : 'a new time'}` };
    await loadDesk(true);
    /* The roster, the planner and the visit calendar all read the time
       off the participant row. The server rewrites that row on the next
       workspace read; doing it here too means the rest of the dashboard
       agrees with the desk immediately, and the autosave in notify()
       carries it. Deliberately only ever sets — clearing a row belongs
       to the server's projection, which can see bookings this window
       cannot. */
    deskProject();
    notify();
    toast(out.unchanged ? 'That was already the time.' : `Moved ${w.handle}.`
      + (out.overDailyLimit ? ' Over the daily limit — recorded.' : ''));
  } catch (err) {
    toast('Could not reach the server.');
  }
}

export function deskUndo() {
  const u = DESK.undo;
  if (!u) return;
  DESK.undo = null;
  deskMove(u.bookingId, u.slotId, { overCapacity: true, overDaily: true });
}

export function openDeskAddTime(scheduleId, day) {
  const sc = deskSchedule(scheduleId);
  if (!sc) return;
  const v = deskVenue(scheduleId);
  const have = deskSlotsOn(day).filter((s) => s.scheduleId === scheduleId).map((s) => s.time).sort();
  openDrawer(`A time at ${esc(v.name)}`, `
    <p class="card-sub">${esc(deskLabel(day))} — ${have.length ? 'already open at ' + have.join(', ') : 'nothing open yet'}.</p>
    <div class="field" style="margin-top:12px"><label>Time</label>
      <input type="time" id="dkNewTime" value="${have.length ? '' : '18:00'}" step="900"/></div>
    <div class="field"><label>Seats</label>
      <input type="number" id="dkNewCap" min="1" max="20" value="${deskUsualCapacity(scheduleId)}"/></div>
    <p class="card-sub">This adds one time to this day only. The weekly rule on the campaign's Booking tab is
      untouched, so regenerating later will not wipe it.</p>
    <div style="display:flex;gap:8px;margin-top:14px"><button class="btn primary" id="dkNewGo">Add it</button>
      <button class="btn" id="dkNewNo">Cancel</button></div>`);
  $('#dkNewNo').addEventListener('click', closeDrawer);
  $('#dkNewGo').addEventListener('click', async () => {
    const time = $('#dkNewTime').value;
    const capacity = Math.max(1, Math.floor(Number($('#dkNewCap').value) || 1));
    if (!/^\d{2}:\d{2}$/.test(time)) { toast('Pick a time first.'); return; }
    try {
      const res = await fetch('/api/booking/slot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduleId, date: day, time, capacity })
      });
      const out = await res.json();
      if (!res.ok) { toast(out.error || 'Could not add that time.'); return; }
      closeDrawer();
      await loadDesk(true);
      notify();
      toast(`${v.name} is open at ${time} on ${deskLabel(day)}.`);
    } catch (err) { toast('Could not reach the server.'); }
  });
}

/* Seats to suggest for a new time: whatever this venue's other times
   use, rather than a number from nowhere. */
export function deskUsualCapacity(scheduleId) {
  const caps = ((DESK.data || {}).slots || []).filter((s) => s.scheduleId === scheduleId)
    .map((s) => Math.max(1, Number(s.capacity) || 1));
  if (!caps.length) return 1;
  const tally = {};
  caps.forEach((c) => { tally[c] = (tally[c] || 0) + 1; });
  return +Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
}

export function deskProject() {
  let n = 0;
  ((DESK.data || {}).bookings || []).forEach((b) => {
    if (!b || !b.participantId || b.status === 'cancelled') return;
    const p = DB.participants.find((x) => x.id === b.participantId);
    if (!p) return;
    const slot = joinSlot(b.date, b.time);
    if (!slot) return;
    if (p.confirmedVisitAt !== slot || p.bookingId !== b._id) {
      p.confirmedVisitAt = slot; p.bookingId = b._id; n++;
    }
  });
  return n;
}
