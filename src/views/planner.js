import { joinSlot, parseVisitSlot, splitSlot, visitSlotOf } from '../import/notion.js';
import { DAY, TODAY } from '../lib/dates.js';
import { kmb, wonK } from '../lib/format.js';
import { dayKey } from '../model/calendar.js';
import { DB, SERVER, byCampaign, byCreator, lastServerJson, notify, serverLoad, serverSave, workspacePayload } from '../model/db.js';
import { partsOf } from '../model/stats.js';
import { $, $$, esc } from '../ui/dom.js';
import { copyText, flagMark, flagRowClass, statCard } from '../ui/html.js';
import { closeDrawer, openDrawer, toast } from '../ui/overlay.js';
import { BOOKING, loadBooking } from './booking.js';
import { flaggedRosterBanner, moveStage, showParticipant } from './campaigns.js';

/* ============================================================
   PLANNER — the tab a campaign opens on.

   The board answers "what stage is everyone at". That is not the
   question anyone has on a Tuesday. Three are: who is waiting on a
   decision, who is coming in and when, and who owes us a post. This
   tab is those three, side by side, over one calendar.

   Everything here reads the same participant rows the roster does —
   there is no second copy of the truth. The only fields it adds are
   attendance (did they turn up) and appliedAt (when they asked),
   because neither was recorded anywhere and both are needed to tell
   a waiting queue from a stale one.
   ============================================================ */

export const PLANNER_WAITING   = ['sourced', 'contacted', 'replied'];
export const PLANNER_CONFIRMED = ['confirmed', 'shipped', 'submitted', 'review', 'live'];
export const POST_DUE_DAYS = 7;         /* a post is late this many days after the visit */
export const WAIT_WARN_DAYS = 2;        /* an application older than this is going cold */

export const PLANNER = { day: null, tab: 'waiting', sel: new Set(), focus: -1, behind: false, checking: false };

/* ---- the fields the planner adds ---- */

/* When they asked to come. Notion gives every submission a created
   time; rows that predate this field fall back to the first contact we
   recorded, and anything older than that is honestly unknown. */
export function appliedAtOf(p) {
  return (p && (p.appliedAt || p.contactedAt)) || '';
}
export function daysWaiting(p, today) {
  const at = appliedAtOf(p);
  if (!at) return null;
  const d = parseVisitSlot(at) || new Date(at);
  if (isNaN(d)) return null;
  return Math.max(0, Math.floor(((today || TODAY) - d) / DAY));
}

/* 'attended' | 'no_show' | 'cancelled' | '' — typed by a person on the
   day, never inferred. A visit in the past with nothing recorded is
   exactly that, and the planner asks rather than assuming. */
export function attendanceOf(p) { return (p && p.attendance) || ''; }
export const ATTENDANCE = {
  attended:  { label: 'Attended', cls: 'green' },
  no_show:   { label: 'No-show',  cls: 'red' },
  cancelled: { label: 'Cancelled', cls: 'grey' }
};

export function setAttendance(p, value) {
  if (!p) return;
  if (attendanceOf(p) === value) { p.attendance = ''; p.attendanceAt = null; return; }
  p.attendance = value;
  p.attendanceAt = new Date().toISOString();
}

/* Did the post land, and is it late? A visit that has not happened yet
   is not late by definition, which is why the visit date is the clock
   rather than the day they were confirmed. */
export function postedState(p, today, dueDays) {
  const c = p && p.content;
  const posted = !!(c && (c.url || c.postUrl));
  const slot = visitSlotOf(p);
  const visitAt = slot ? parseVisitSlot(slot) : null;
  /* the day it happened, not the hour — otherwise a visit at noon reads
     as half a day younger than one at nine, and "9 days ago" becomes 8 */
  const visitDate = visitAt ? new Date(visitAt.getFullYear(), visitAt.getMonth(), visitAt.getDate()) : null;
  const now = today || TODAY;
  const due = dueDays || POST_DUE_DAYS;
  if (posted) {
    const postedAt = c.publishedAt || c.postedAt || '';
    const pd = postedAt ? parseVisitSlot(postedAt) : null;
    const lag = pd && visitDate ? Math.round((pd - visitDate) / DAY) : null;
    return { state: 'posted', lag, label: lag == null ? 'Posted' : (lag <= 0 ? 'Posted' : `Posted ${lag}d after`) };
  }
  if (attendanceOf(p) === 'no_show')   return { state: 'no_show', label: 'No-show' };
  if (attendanceOf(p) === 'cancelled') return { state: 'cancelled', label: 'Cancelled' };
  if (!visitDate) return { state: 'no_date', label: 'No date yet' };
  const since = Math.floor((now - visitDate) / DAY);
  if (since < 0) return { state: 'upcoming', label: 'Visit booked' };
  if (since > due) return { state: 'overdue', label: `No post · ${since}d since the visit` };
  return { state: 'due', label: `Post due · ${due - since}d left` };
}

/* How many other campaigns this creator has been confirmed on. Not
   cr.campaignsDone, which only counts campaigns where a post was
   recorded — a creator who came to three dinners and whose posts were
   never logged is still somebody we have worked with three times. */
export function pastCampaignsWith(p) {
  if (!p) return 0;
  return new Set(DB.participants
    .filter((q) => q.creatorId === p.creatorId && q.campaignId !== p.campaignId && PLANNER_CONFIRMED.includes(q.stage))
    .map((q) => q.campaignId)).size;
}

/* ---- what a planner row is ---- */
export function plannerRow(p) {
  const cr = byCreator[p.creatorId] || {};
  const slot = visitSlotOf(p);
  const at = slot ? parseVisitSlot(slot) : null;
  return {
    p, cr, slot, at,
    dayKey: at ? dayKey(at) : '',
    time: splitSlot(slot).time,
    waited: daysWaiting(p),
    post: postedState(p),
    flag: cr.flag || '',
    repeat: pastCampaignsWith(p)
  };
}

export function plannerBuckets(cp) {
  const rows = partsOf(cp.id).map(plannerRow);
  const by = (list) => (r) => list.includes(r.p.stage);
  return {
    waiting: rows.filter(by(PLANNER_WAITING)).sort((a, b) => (b.waited ?? -1) - (a.waited ?? -1)),
    shortlisted: rows.filter(by(['shortlisted'])).sort((a, b) => (b.waited ?? -1) - (a.waited ?? -1)),
    confirmed: rows.filter(by(PLANNER_CONFIRMED)).sort((a, b) => (a.dayKey || '9999').localeCompare(b.dayKey || '9999') || a.time.localeCompare(b.time)),
    declined: rows.filter(by(['dropped']))
  };
}

/* ---- the five numbers at the top ---- */
export function plannerSummary(cp) {
  const b = plannerBuckets(cp);
  const waiting = b.waiting;
  const oldest = waiting.reduce((m, r) => (r.waited != null && r.waited > m ? r.waited : m), 0);
  const confirmed = b.confirmed;
  const withDate = confirmed.filter((r) => r.at);
  const weekEnd = new Date(TODAY.getTime() + 7 * DAY);
  const thisWeek = withDate.filter((r) => r.at >= TODAY && r.at < weekEnd);
  const posted = confirmed.filter((r) => r.post.state === 'posted');
  const overdue = confirmed.filter((r) => r.post.state === 'overdue');
  const flagged = confirmed.concat(waiting, b.shortlisted).filter((r) => r.flag === 'blocked' || r.flag === 'caution');
  return {
    waiting: waiting.length,
    oldest,
    shortlisted: b.shortlisted.length,
    confirmed: confirmed.length,
    target: Number(cp.targetCreators) || 0,
    noDate: confirmed.length - withDate.length,
    thisWeek: thisWeek.length,
    posted: posted.length,
    overdue: overdue.length,
    flagged: flagged.length,
    attention: overdue.length + (confirmed.length - withDate.length) + flagged.filter((r) => r.flag === 'blocked').length
  };
}

/* ---- the three conflicts the data knows about and a person cannot see ----

   A creator booked on two campaigns the same day, a visit on a day the
   venue is closed, and more people in one sitting than the sitting
   holds. Each one is a phone call on the day if nobody catches it. */
export function plannerConflicts(cp) {
  const out = [];
  const rows = plannerBuckets(cp).confirmed.filter((r) => r.at);
  const closed = new Set((BOOKING.schedule && BOOKING.campaignId === cp.id ? BOOKING.schedule.closedDates : []) || []);

  /* the same creator, somewhere else, the same day */
  const elsewhere = {};
  DB.participants.forEach((q) => {
    if (q.campaignId === cp.id || q.stage === 'dropped') return;
    const s = visitSlotOf(q);
    const d = s ? parseVisitSlot(s) : null;
    if (!d) return;
    (elsewhere[q.creatorId + '|' + dayKey(d)] = elsewhere[q.creatorId + '|' + dayKey(d)] || []).push(q);
  });

  rows.forEach((r) => {
    const clash = elsewhere[r.p.creatorId + '|' + r.dayKey];
    if (clash && clash.length) {
      const other = byCampaign[clash[0].campaignId];
      out.push({ kind: 'double', pid: r.p.id, dayKey: r.dayKey,
        text: `${r.cr.handle} is also booked on ${other ? other.brand : 'another campaign'} on ${r.dayKey}` });
    }
    if (closed.has(r.dayKey)) {
      out.push({ kind: 'blocked', pid: r.p.id, dayKey: r.dayKey,
        text: `${r.cr.handle} is booked on ${r.dayKey}, a day this campaign has blocked` });
    }
  });

  /* more heads than the sitting holds, when booking knows the capacity */
  if (BOOKING.campaignId === cp.id && (BOOKING.slots || []).length) {
    const seats = {};
    BOOKING.slots.forEach((s) => { seats[s.date + ' ' + s.time] = s.capacity || 0; });
    const heads = {};
    rows.forEach((r) => {
      const k = r.dayKey + ' ' + r.time;
      heads[k] = (heads[k] || 0) + (Number(r.p.headcount) || 1);
    });
    Object.entries(heads).forEach(([k, n]) => {
      const cap = seats[k];
      if (cap != null && n > cap) {
        out.push({ kind: 'over', dayKey: k.split(' ')[0],
          text: `${k.replace(' ', ' at ')} has ${n} people in ${cap} seat${cap === 1 ? '' : 's'}` });
      }
    });
  }
  return out;
}

/* ---- the sheet the venue gets ----

   Korean, because the person reading it at the counter is the venue's,
   not ours. Plain text so it can go straight into KakaoTalk. */
export function daySheetText(cp, key) {
  const rows = plannerBuckets(cp).confirmed.filter((r) => r.dayKey === key);
  const d = parseVisitSlot(key);
  const title = `${cp.brand} 방문 명단 · ${key}${d ? ' (' + ['일', '월', '화', '수', '목', '금', '토'][d.getDay()] + ')' : ''}`;
  if (!rows.length) return title + '\n예약된 방문이 없습니다.';
  const lines = rows.map((r) => {
    const who = r.p.fullName || r.cr.name || r.cr.handle;
    const head = Number(r.p.headcount) || 1;
    const note = (r.p.remark || r.p.note || '').trim();
    return `${r.time || '시간 미정'}  ${who} (${r.cr.handle}) · ${head}명${note ? ' · ' + note : ''}`;
  });
  const total = rows.reduce((n, r) => n + (Number(r.p.headcount) || 1), 0);
  return [title, '', ...lines, '', `총 ${rows.length}팀 / ${total}명`, `촬영: ${cp.deliverables || '—'}`].join('\n');
}

/* ---- small pieces of markup shared by both lists ---- */
export function plAgePill(r) {
  if (r.waited == null) return '<span class="pl-age none">no date</span>';
  const cls = r.waited > WAIT_WARN_DAYS * 2 ? 'hot' : r.waited > WAIT_WARN_DAYS ? 'warm' : '';
  return `<span class="pl-age ${cls}">${r.waited === 0 ? 'today' : r.waited + 'd waiting'}</span>`;
}
export function plRepeat(r) {
  return r.repeat >= 1 ? `<span class="mark repeat" title="Campaigns with us">↻ ${r.repeat}</span>` : '';
}
export function plMarks(r) { return flagMark(r.cr) + plRepeat(r); }
export function plPostPill(r) {
  const s = r.post;
  const cls = s.state === 'posted' ? 'green' : s.state === 'overdue' ? 'red'
    : s.state === 'due' ? 'amber' : s.state === 'no_date' ? 'amber' : 'grey';
  return `<span class="pill ${cls}">${esc(s.label)}</span>`;
}

/* ---- the tab ---- */
export function plannerTab(mount, cp) {
  /* booking data makes the day cells and the conflict check sharper, but
     the planner works without it — a campaign may never have set booking
     up, and the fetch must never block the first paint */
  if (BOOKING.campaignId !== cp.id || !BOOKING.at) loadBooking(cp.id).then(() => { if (currentPlannerCampaign() === cp.id) notify(); });

  const b = plannerBuckets(cp);
  const s = plannerSummary(cp);
  const conflicts = plannerConflicts(cp);
  if (!PLANNER.day) {
    const next = b.confirmed.filter((r) => r.dayKey && r.dayKey >= dayKey(TODAY))[0] || b.confirmed.filter((r) => r.dayKey).slice(-1)[0];
    PLANNER.day = next ? next.dayKey : dayKey(TODAY);
  }

  mount.innerHTML = `
    ${plannerFreshness()}
    ${flaggedRosterBanner(cp)}
    ${conflicts.length ? `<div class="flag-note caution-only">
      <span class="flag-mark caution" style="margin-left:0">!</span>
      <span><strong>${conflicts.length} clash${conflicts.length === 1 ? '' : 'es'} to sort out.</strong>
      ${conflicts.slice(0, 3).map((c) => esc(c.text)).join('<br>')}
      ${conflicts.length > 3 ? `<br>and ${conflicts.length - 3} more` : ''}</span></div>` : ''}

    <div class="grid g5" style="margin-bottom:14px">
      ${statCard('Waiting on you', s.waiting, { foot: s.waiting ? (s.oldest ? `oldest ${s.oldest} day${s.oldest === 1 ? '' : 's'}` : 'all new today') : 'queue clear' })}
      ${statCard('Confirmed', `${s.confirmed}<span style="font-size:15px;color:var(--text-3)"> / ${s.target || '—'}</span>`,
        { foot: s.noDate ? `${s.noDate} without a date` : 'every one has a date' })}
      ${statCard('Visits next 7 days', s.thisWeek, { foot: `${b.confirmed.filter((r) => r.at).length} booked in all` })}
      ${statCard('Posted', `${s.posted}<span style="font-size:15px;color:var(--text-3)"> / ${s.confirmed}</span>`,
        { foot: s.overdue ? `${s.overdue} overdue` : 'nothing overdue' })}
      ${statCard('Needs attention', s.attention, { foot: s.attention ? 'overdue, undated or flagged' : 'nothing on fire' })}
    </div>

    <div class="planner-grid">
      <div class="planner-cal">
        <section class="card" id="plCalCard">${plannerCalendar(cp, b)}</section>
      </div>
      <div class="planner-lists">
        <section class="card pl-card" id="plApplied">${plannerApplied(cp, b)}</section>
        <section class="card pl-card" id="plConfirmed">${plannerConfirmed(cp, b)}</section>
      </div>
    </div>`;

  wirePlanner(cp);
}

export function currentPlannerCampaign() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  return parts[0] === 'campaigns' ? parts[1] : null;
}

/* ---- how old is what you are looking at ---- */
export function plannerFreshness() {
  const read = SERVER.at ? Math.round((Date.now() - SERVER.at.getTime()) / 60000) : null;
  return `<div class="card-head no-print" style="margin-bottom:12px">
    <span style="font-size:12px;color:var(--text-3)">
      ${read == null ? 'Not loaded from the server' : read < 1 ? 'Read just now' : `Read ${read} minute${read === 1 ? '' : 's'} ago`}
    </span>
    <button class="btn xs" id="plRefresh">Refresh</button>
    <div class="sp"></div>
    ${PLANNER.behind ? `<span class="pill amber" title="Someone saved after you loaded this page">Someone else has saved since you opened this — refresh before you change anything</span>` : ''}
  </div>`;
}

/* ---- the calendar rail ---- */
export function plannerCalendar(cp, b) {
  const map = {};
  b.confirmed.forEach((r) => { if (r.dayKey) (map[r.dayKey] = map[r.dayKey] || []).push(r); });
  const seed = parseVisitSlot(PLANNER.day) || TODAY;
  const cur = PLANNER.month || new Date(seed.getFullYear(), seed.getMonth(), 1);
  PLANNER.month = cur;
  const first = new Date(cur.getFullYear(), cur.getMonth(), 1);
  const pad = (first.getDay() + 6) % 7;                 /* weeks start Monday */
  const dim = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate();
  const closed = new Set((BOOKING.schedule && BOOKING.campaignId === cp.id ? BOOKING.schedule.closedDates : []) || []);
  const seats = {};
  if (BOOKING.campaignId === cp.id) (BOOKING.slots || []).forEach((sl) => {
    seats[sl.date] = seats[sl.date] || { cap: 0, booked: 0 };
    seats[sl.date].cap += sl.capacity || 0; seats[sl.date].booked += sl.booked || 0;
  });

  let cells = '';
  for (let i = 0; i < pad; i++) cells += '<div class="pl-day out"></div>';
  for (let d = 1; d <= dim; d++) {
    const k = dayKey(new Date(cur.getFullYear(), cur.getMonth(), d));
    const list = map[k] || [];
    const seat = seats[k];
    const flagged = list.some((r) => r.flag === 'blocked' || r.flag === 'caution');
    const cls = ['pl-day'];
    if (list.length) cls.push('has');
    if (seat && seat.cap && seat.booked >= seat.cap) cls.push('full');
    if (closed.has(k)) cls.push('closed');
    if (flagged) cls.push('flagged');
    if (k === dayKey(TODAY)) cls.push('today');
    if (k === PLANNER.day) cls.push('sel');
    cells += `<button class="${cls.join(' ')}" data-plday="${k}" title="${esc(k)}${closed.has(k) ? ' · blocked' : ''}">
      <span class="n">${d}</span>
      ${list.length ? `<span class="s">${list.length}${seat && seat.cap ? '/' + seat.cap : ''}</span>` : ''}
    </button>`;
  }

  return `
    <header class="card-head" style="padding:12px 14px;border-bottom:1px solid var(--line)">
      <h3 style="font-size:14px">Visits</h3><div class="sp"></div>
      <button class="icon-btn sm" id="plPrev" title="Previous month">&#8249;</button>
      <span style="font-size:12.5px;min-width:120px;text-align:center">${esc(cur.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</span>
      <button class="icon-btn sm" id="plNext" title="Next month">&#8250;</button>
    </header>
    <div style="padding:12px 14px">
      <div class="pl-dow">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => `<span>${d}</span>`).join('')}</div>
      <div class="pl-days">${cells}</div>
      <div class="pl-legend">
        <span><i class="has"></i>visits</span><span><i class="full"></i>full</span>
        <span><i class="closed"></i>blocked</span><span><i class="flagged"></i>flagged creator</span>
      </div>
    </div>
    ${plannerAgenda(cp, map[PLANNER.day] || [])}`;
}

/* ---- the selected day, where attendance is recorded ---- */
export function plannerAgenda(cp, rows) {
  const heads = rows.reduce((n, r) => n + (Number(r.p.headcount) || 1), 0);
  const byTime = {};
  rows.forEach((r) => { (byTime[r.time || '—'] = byTime[r.time || '—'] || []).push(r); });
  const times = Object.keys(byTime).sort();
  const past = (parseVisitSlot(PLANNER.day) || TODAY) <= TODAY;

  return `<div class="pl-agenda">
    <div class="card-head" style="margin-bottom:8px">
      <strong style="font-size:12.5px;white-space:nowrap" title="${esc(PLANNER.day)}">${esc(plannerDayShort(PLANNER.day))}</strong>
      <span style="font-size:11.5px;color:var(--text-3)">${rows.length} visit${rows.length === 1 ? '' : 's'} · ${heads} ${heads === 1 ? 'person' : 'people'}</span>
      <div class="sp"></div>
      <button class="btn xs" id="plSheet" ${rows.length ? '' : 'disabled'} title="The list the venue needs, in Korean">Day sheet</button>
    </div>
    ${rows.length ? times.map((t) => `
      <div class="pl-slot">
        <div class="t">${esc(t)}</div>
        <div class="g">
          ${byTime[t].map((r) => `
            <div class="pl-visit ${flagRowClass(r.cr)}">
              <span class="h" data-plopen="${esc(r.p.id)}">${esc(r.cr.handle || r.p.fullName || '—')}</span>
              ${plMarks(r)}
              <span class="hc">${Number(r.p.headcount) || 1}p</span>
              ${attendanceOf(r.p) ? `<span class="pill ${ATTENDANCE[attendanceOf(r.p)].cls}">${ATTENDANCE[attendanceOf(r.p)].label}</span>` : ''}
              <span class="sp"></span>
              <button class="btn xs ${attendanceOf(r.p) === 'attended' ? 'primary' : ''}" data-platt="attended" data-pid="${esc(r.p.id)}">Came</button>
              <button class="btn xs" data-platt="no_show" data-pid="${esc(r.p.id)}">No-show</button>
            </div>`).join('')}
        </div>
      </div>`).join('')
      : `<p class="card-sub" style="margin:0">Nobody is booked on this day.${past ? '' : ' Confirm someone from the list on the right and pick this date.'}</p>`}
  </div>`;
}

/* ---- list one: who applied and is waiting ---- */
export function plannerApplied(cp, b) {
  const list = PLANNER.tab === 'shortlisted' ? b.shortlisted : PLANNER.tab === 'declined' ? b.declined : b.waiting;
  const selectable = PLANNER.tab !== 'declined';
  return `
    <header class="card-head" style="padding:12px 14px;border-bottom:1px solid var(--line)">
      <h3 style="font-size:14px">Applied</h3>
      <span style="font-size:12px;color:var(--text-3)">oldest first</span>
      <div class="sp"></div>
      <span class="pl-hint no-print" title="j and k move · x selects · s shortlist · c confirm · d decline">j k · s c d</span>
    </header>
    <div class="pl-filters">
      ${[['waiting', 'Waiting', b.waiting.length], ['shortlisted', 'Shortlisted', b.shortlisted.length], ['declined', 'Declined', b.declined.length]]
        .map(([id, label, n]) => `<button class="pl-chip ${PLANNER.tab === id ? 'on' : ''}" data-pltab="${id}">${label} ${n}</button>`).join('')}
    </div>
    ${PLANNER.sel.size ? `<div class="pl-bulk">
      <strong>${PLANNER.sel.size} selected</strong>
      <div class="sp"></div>
      <button class="btn xs" data-plbulk="shortlisted">Shortlist</button>
      <button class="btn xs primary" data-plbulk="confirmed">Confirm</button>
      <button class="btn xs" data-plbulk="dropped">Decline</button>
      <button class="btn xs ghost" data-plbulk="clear">Clear</button>
    </div>` : ''}
    <div class="pl-list">${list.length ? list.map((r, i) => plannerApplicant(r, i, selectable)).join('')
      : `<div class="empty" style="padding:22px 14px">Nothing ${PLANNER.tab === 'waiting' ? 'waiting on you' : 'here'}.</div>`}</div>`;
}

export function plannerApplicant(r, i, selectable) {
  const p = r.p, cr = r.cr;
  const asked = p.visitAt ? splitSlot(p.visitAt) : null;
  const blocked = r.flag === 'blocked';
  return `
    <div class="pl-item ${flagRowClass(cr)} ${PLANNER.focus === i ? 'focus' : ''}" data-plrow="${esc(p.id)}" data-plidx="${i}">
      ${selectable ? `<input type="checkbox" class="pl-check" data-plsel="${esc(p.id)}" ${PLANNER.sel.has(p.id) ? 'checked' : ''} aria-label="Select ${esc(cr.handle || '')}"/>` : '<span></span>'}
      <div class="pl-main" style="min-width:0">
        <div class="pl-handle" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <span data-plopen="${esc(p.id)}" style="cursor:pointer">${esc(cr.handle || p.fullName || '—')}</span>
          ${plMarks(r)} ${plAgePill(r)}
        </div>
        <div class="pl-facts">${kmb(cr.followers || 0)} followers · ER ${cr.er || 0}% · ${esc(cr.country || '—')}${p.headcount ? ' · ' + esc(String(p.headcount)) + ' people' : ''}</div>
        ${cr.flagReason ? `<div class="pl-why ${r.flag === 'caution' ? 'amber' : ''}">${esc(cr.flagReason)}</div>` : ''}
        ${asked && asked.date ? `<div class="pl-prefs"><span>🗓 asked for ${esc(asked.date)}${asked.time ? ' ' + esc(asked.time) : ''}</span></div>` : ''}
      </div>
      <div class="pl-acts no-print">
        ${blocked
          ? `<button class="btn xs" data-plopen="${esc(p.id)}">Review</button><button class="btn xs" data-plstage="dropped" data-pid="${esc(p.id)}">Decline</button>`
          : `<button class="btn xs" data-plstage="shortlisted" data-pid="${esc(p.id)}">Shortlist</button>
             <button class="btn xs primary" data-plconfirm="${esc(p.id)}">Confirm…</button>
             <button class="btn xs ghost" data-plstage="dropped" data-pid="${esc(p.id)}">Decline</button>`}
      </div>
    </div>`;
}

/* ---- list two: who is coming, by the day they come ---- */
export function plannerConfirmed(cp, b) {
  const rows = b.confirmed;
  const filtered = PLANNER.dayFilter ? rows.filter((r) => r.dayKey === PLANNER.day) : rows;
  const groups = [];
  const undated = filtered.filter((r) => !r.dayKey);
  if (undated.length) groups.push({ key: '', label: 'No date yet', rows: undated, warn: true });
  [...new Set(filtered.filter((r) => r.dayKey).map((r) => r.dayKey))].sort().forEach((k) => {
    groups.push({ key: k, label: plannerDayLabel(k), rows: filtered.filter((r) => r.dayKey === k) });
  });

  return `
    <header class="card-head" style="padding:12px 14px;border-bottom:1px solid var(--line)">
      <h3 style="font-size:14px">Confirmed</h3>
      <span style="font-size:12px;color:var(--text-3)">${rows.length} going${PLANNER.dayFilter ? ` · showing ${PLANNER.day}` : ''}</span>
      <div class="sp"></div>
      ${PLANNER.dayFilter ? '<button class="btn xs" id="plAllDays">All days</button>' : ''}
    </header>
    <div class="pl-list">${groups.length ? groups.map((g) => `
      <div class="pl-group ${g.warn ? 'warn' : ''}">
        <span>${esc(g.label)}</span><div class="sp"></div>
        <span>${g.rows.length} ${g.rows.length === 1 ? 'person' : 'people'}</span>
      </div>
      ${g.rows.map((r) => `
        <div class="pl-item ${flagRowClass(r.cr)}" data-plrow="${esc(r.p.id)}">
          <span></span>
          <div class="pl-main" style="min-width:0">
            <div class="pl-handle" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              ${r.time ? `<span class="num" style="color:var(--text-2)">${esc(r.time)}</span>` : ''}
              <span data-plopen="${esc(r.p.id)}" style="cursor:pointer">${esc(r.cr.handle || r.p.fullName || '—')}</span>
              ${plMarks(r)} ${plPostPill(r)}
              ${attendanceOf(r.p) ? `<span class="pill ${ATTENDANCE[attendanceOf(r.p)].cls}">${ATTENDANCE[attendanceOf(r.p)].label}</span>` : ''}
            </div>
            <div class="pl-facts">${kmb(r.cr.followers || 0)} · ${Number(r.p.headcount) || 1} ${(Number(r.p.headcount) || 1) === 1 ? 'person' : 'people'}${r.p.fee ? ' · ' + wonK(r.p.fee) : ''}</div>
          </div>
          <div class="pl-acts no-print">
            <button class="btn xs" data-plconfirm="${esc(r.p.id)}">${r.dayKey ? 'Move' : 'Pick a date…'}</button>
            <button class="btn xs ghost" data-plopen="${esc(r.p.id)}">Open</button>
          </div>
        </div>`).join('')}`).join('')
      : '<div class="empty" style="padding:22px 14px">Nobody confirmed yet.</div>'}</div>`;
}

/* "Tue 13 Oct" — the ISO date is kept in the tooltip, because a column
   this narrow breaks 2026-10-13 across two lines. */
export function plannerDayShort(k) {
  const d = parseVisitSlot(k);
  return d ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : k;
}

export function plannerDayLabel(k) {
  const d = parseVisitSlot(k);
  if (!d) return k;
  const days = Math.round((d - TODAY) / DAY);
  const rel = days === 0 ? 'today' : days === 1 ? 'tomorrow' : days > 0 ? `in ${days} days` : `${-days} days ago`;
  return `${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })} · ${rel}`;
}

/* ---- wiring ---- */
export function wirePlanner(cp) {
  const redraw = () => notify();

  /* Reloading replaces the workspace with the server's copy, so anything
     typed here and not yet saved would go with it. The autosave is a
     couple of seconds behind at the best of times, which is exactly when
     somebody reaches for Refresh. So: send ours up first, and only
     reload when that worked. */
  $('#plRefresh').addEventListener('click', async () => {
    const btn = $('#plRefresh');
    btn.disabled = true; btn.textContent = 'Refreshing…';
    try {
      if (JSON.stringify(workspacePayload()) !== lastServerJson) {
        const r = await serverSave({ force: false });
        if (r && r.ok === false) {
          toast(r.reason === 'conflict'
            ? 'Someone else saved first — use Save in the top bar to decide whose copy wins'
            : 'Your changes could not be saved, so nothing was reloaded');
          btn.disabled = false; btn.textContent = 'Refresh';
          return;
        }
      }
      await serverLoad();
      PLANNER.behind = false;
      toast('Up to date');
    } catch (err) {
      toast('Could not reach the server — showing what was last read');
    }
    redraw();
  });
  checkPlannerRevision();

  const prev = $('#plPrev'), next = $('#plNext');
  if (prev) prev.addEventListener('click', () => { PLANNER.month = new Date(PLANNER.month.getFullYear(), PLANNER.month.getMonth() - 1, 1); redraw(); });
  if (next) next.addEventListener('click', () => { PLANNER.month = new Date(PLANNER.month.getFullYear(), PLANNER.month.getMonth() + 1, 1); redraw(); });

  $$('[data-plday]').forEach((el) => el.addEventListener('click', () => {
    const k = el.dataset.plday;
    PLANNER.dayFilter = !(PLANNER.day === k && PLANNER.dayFilter);
    PLANNER.day = k;
    redraw();
  }));
  const all = $('#plAllDays');
  if (all) all.addEventListener('click', () => { PLANNER.dayFilter = false; redraw(); });

  $$('[data-pltab]').forEach((el) => el.addEventListener('click', () => {
    PLANNER.tab = el.dataset.pltab; PLANNER.sel.clear(); PLANNER.focus = -1; redraw();
  }));

  $$('[data-plsel]').forEach((el) => el.addEventListener('change', () => {
    const id = el.dataset.plsel;
    if (el.checked) PLANNER.sel.add(id); else PLANNER.sel.delete(id);
    redraw();
  }));

  $$('[data-plopen]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); showParticipant(el.dataset.plopen); }));

  $$('[data-plstage]').forEach((el) => el.addEventListener('click', () => {
    const p = DB.participants.find((x) => x.id === el.dataset.pid);
    if (!p) return;
    moveStage(p, el.dataset.plstage);
    PLANNER.sel.delete(p.id);
    redraw();
  }));

  $$('[data-plconfirm]').forEach((el) => el.addEventListener('click', () => openPlannerConfirm(cp, el.dataset.plconfirm)));

  $$('[data-platt]').forEach((el) => el.addEventListener('click', () => {
    const p = DB.participants.find((x) => x.id === el.dataset.pid);
    if (!p) return;
    setAttendance(p, el.dataset.platt);
    toast(attendanceOf(p) ? `${(byCreator[p.creatorId] || {}).handle || 'Visit'} — ${ATTENDANCE[attendanceOf(p)].label.toLowerCase()}` : 'Attendance cleared');
    redraw();
  }));

  $$('[data-plbulk]').forEach((el) => el.addEventListener('click', () => {
    const what = el.dataset.plbulk;
    if (what === 'clear') { PLANNER.sel.clear(); redraw(); return; }
    const ids = [...PLANNER.sel];
    const label = what === 'dropped' ? 'Decline' : what === 'confirmed' ? 'Confirm' : 'Shortlist';
    if (!window.confirm(`${label} ${ids.length} creator${ids.length === 1 ? '' : 's'}?`)) return;
    ids.forEach((id) => {
      const p = DB.participants.find((x) => x.id === id);
      if (p) moveStage(p, what);
    });
    PLANNER.sel.clear();
    toast(`${ids.length} moved to ${what === 'dropped' ? 'declined' : what}`);
    redraw();
  }));

  const sheet = $('#plSheet');
  if (sheet) sheet.addEventListener('click', () => openDaySheet(cp, PLANNER.day));

  bindPlannerKeys(cp);
}

/* Keyboard, because deciding on forty applicants with a mouse is an
   afternoon. Only while the planner is on screen, and never while
   something is being typed into. */
export function bindPlannerKeys(cp) {
  if (PLANNER.keysBound) return;
  PLANNER.keysBound = true;
  document.addEventListener('keydown', (e) => {
    if (!document.querySelector('.planner-grid')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const rows = $$('[data-plidx]');
    if (!rows.length && 'jkxscd'.includes(e.key)) return;
    const move = (d) => {
      PLANNER.focus = Math.max(0, Math.min(rows.length - 1, PLANNER.focus + d));
      notify();
      const el = document.querySelector('[data-plidx="' + PLANNER.focus + '"]');
      if (el) el.scrollIntoView({ block: 'nearest' });
    };
    const current = () => {
      const el = rows[PLANNER.focus];
      return el ? DB.participants.find((x) => x.id === el.dataset.plrow) : null;
    };
    if (e.key === 'j') { e.preventDefault(); move(1); }
    else if (e.key === 'k') { e.preventDefault(); move(-1); }
    else if (e.key === 'x') {
      const p = current(); if (!p) return;
      e.preventDefault();
      if (PLANNER.sel.has(p.id)) PLANNER.sel.delete(p.id); else PLANNER.sel.add(p.id);
      notify();
    } else if (e.key === 's' || e.key === 'd') {
      const p = current(); if (!p) return;
      e.preventDefault();
      moveStage(p, e.key === 's' ? 'shortlisted' : 'dropped');
      notify();
    } else if (e.key === 'c') {
      const p = current(); if (!p) return;
      e.preventDefault();
      openPlannerConfirm(cp, p.id);
    }
  });
}

/* Confirming is also where a date gets picked, because a confirmed
   creator with no date is the thing that quietly breaks the week. */
export function openPlannerConfirm(cp, pid) {
  const p = DB.participants.find((x) => x.id === pid);
  if (!p) return;
  const cr = byCreator[p.creatorId] || {};
  const asked = splitSlot(p.visitAt || '');
  const now = splitSlot(p.confirmedVisitAt || '');
  const taken = plannerBuckets(cp).confirmed.filter((r) => r.dayKey).reduce((m, r) => {
    m[r.dayKey] = (m[r.dayKey] || 0) + (Number(r.p.headcount) || 1); return m;
  }, {});

  openDrawer(`${p.stage === 'confirmed' ? 'Move' : 'Confirm'} ${esc(cr.handle || p.fullName || '')}`, `
    ${cr.flag === 'blocked' ? `<div class="flag-note"><span class="flag-mark blocked" style="margin-left:0">⊘</span>
      <span><strong>This creator is blacklisted.</strong> ${esc(cr.flagReason || 'No reason recorded.')}</span></div>` : ''}
    ${asked.date ? `<p class="card-sub">They asked for <strong>${esc(asked.date)}${asked.time ? ' ' + esc(asked.time) : ''}</strong>.</p>` : ''}
    <div class="grid g2" style="gap:10px;margin-top:10px">
      <div class="field"><label>Visit date</label><input type="date" id="pcDate" value="${esc(now.date || asked.date || '')}"/></div>
      <div class="field"><label>Time</label><input type="time" id="pcTime" value="${esc(now.time || asked.time || '')}"/></div>
    </div>
    <div class="field"><label>People coming</label><input type="number" min="1" max="20" id="pcHead" value="${esc(String(Number(p.headcount) || 1))}"/></div>
    <div id="pcWarn"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn primary" id="pcGo">${p.stage === 'confirmed' ? 'Save the date' : 'Confirm and book'}</button>
      <button class="btn" id="pcNoDate">${p.stage === 'confirmed' ? 'Clear the date' : 'Confirm without a date'}</button>
    </div>`);

  const warn = () => {
    const d = $('#pcDate').value;
    const already = taken[d] || 0;
    $('#pcWarn').innerHTML = d && already
      ? `<p class="card-sub" style="margin-top:8px">${already} ${already === 1 ? 'person is' : 'people are'} already booked that day.</p>` : '';
  };
  $('#pcDate').addEventListener('change', warn); warn();

  $('#pcGo').addEventListener('click', () => {
    const d = $('#pcDate').value, t = $('#pcTime').value;
    if (!d) { toast('Pick a date, or use “without a date”'); return; }
    p.headcount = String(Math.max(1, Number($('#pcHead').value) || 1));
    p.confirmedVisitAt = joinSlot(d, t);
    if (p.stage !== 'confirmed' && !PLANNER_CONFIRMED.includes(p.stage)) moveStage(p, 'confirmed');
    PLANNER.day = d; PLANNER.sel.delete(p.id);
    closeDrawer(); toast(`${(byCreator[p.creatorId] || {}).handle || 'Booked'} — ${d}${t ? ' ' + t : ''}`); notify();
  });
  $('#pcNoDate').addEventListener('click', () => {
    if (p.stage === 'confirmed' || PLANNER_CONFIRMED.includes(p.stage)) p.confirmedVisitAt = '';
    else moveStage(p, 'confirmed');
    PLANNER.sel.delete(p.id);
    closeDrawer(); notify();
  });
}

/* The venue's copy of the day. */
export function openDaySheet(cp, key) {
  const text = daySheetText(cp, key);
  openDrawer(`Day sheet — ${esc(key)}`, `
    <p class="card-sub">What the venue needs: who is coming, when, and how many. Korean, because the person
      reading it works at the restaurant.</p>
    <pre id="dsText" style="white-space:pre-wrap;background:var(--surface-2);border:1px solid var(--line);
      border-radius:8px;padding:12px;font-size:12.5px;line-height:1.6;margin-top:10px">${esc(text)}</pre>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn primary" id="dsCopy">Copy for KakaoTalk</button>
      <button class="btn" id="dsPrint">Print</button>
    </div>`);
  $('#dsCopy').addEventListener('click', () => copyText(text));
  $('#dsPrint').addEventListener('click', () => {
    let holder = document.getElementById('daySheetPrint');
    if (!holder) { holder = document.createElement('pre'); holder.id = 'daySheetPrint'; document.body.appendChild(holder); }
    holder.textContent = text;
    document.body.classList.add('print-sheet');
    window.print();
    setTimeout(() => document.body.classList.remove('print-sheet'), 300);
  });
}

/* Has anyone else saved since this page was loaded? One cheap call; the
   workspace itself is far too big to poll. */
export async function checkPlannerRevision() {
  if (PLANNER.checking) return;
  PLANNER.checking = true;
  try {
    const res = await fetch('/api/workspace/meta');
    if (res.ok) {
      const body = await res.json();
      const behind = !!(body && body.revision && SERVER.revision && body.revision > SERVER.revision);
      if (behind !== PLANNER.behind) { PLANNER.behind = behind; notify(); }
    }
  } catch (err) { /* offline: the freshness line already says when it was read */ }
  PLANNER.checking = false;
}
