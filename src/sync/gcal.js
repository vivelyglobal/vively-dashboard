import { visitSlotOf } from '../import/notion.js';
import { kmb } from '../lib/format.js';
import { DB, byCampaign, byCreator, notify, serverSave } from '../model/db.js';
import { $ } from '../ui/dom.js';
import { toast } from '../ui/overlay.js';

/* ============================================================
   GOOGLE CALENDAR
   Bookings live in two places: creator visit slots that arrive
   with the Notion sync, and appointments typed in by hand. Both
   become events on one shared Google Calendar, so the people who
   have to be at the restaurant can see them without opening this
   dashboard.

   The whole design question here is "what stops it writing the
   same booking twice?", and the answer is three things, because
   any one of them can be wrong on its own:

     1. Every event id is derived from what the event is FOR — the
        participant, or the appointment. The server computes it;
        the same booking therefore always resolves to the same
        event, however many times anyone hits sync.
     2. The id we got back is stored on the record, so an ordinary
        re-sync is an update by intent, not by accident.
     3. Every event is tagged, and the sync reads back what is
        already on the calendar under that tag before writing. So
        even with the workspace wiped and every stored id lost,
        the sync still finds its own events instead of doubling
        them.

   Nothing is ever deleted or overwritten to resolve a conflict.
   Where Google and the dashboard disagree, that is reported and
   left alone — you decide which one is right.
   ============================================================ */

export const GCAL = { checked: false, configured: false, clientEmail: '', calendarId: '', summary: '',
               timeZone: '', error: null, busy: false, at: null, issues: [], last: null };

export const GCAL_KEY = 'vively-gcal-v1';
export const GCAL_PREFS = { defaultTz: 'Asia/Seoul', visitMinutes: 90 };

export function loadGcalPrefs() {
  try {
    const raw = localStorage.getItem(GCAL_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.defaultTz) GCAL_PREFS.defaultTz = saved.defaultTz;
    if (+saved.visitMinutes > 0) GCAL_PREFS.visitMinutes = +saved.visitMinutes;
  } catch (e) { /* first run, or storage blocked */ }
}
export function saveGcalPrefs() {
  try { localStorage.setItem(GCAL_KEY, JSON.stringify(GCAL_PREFS)); } catch (e) { /* nothing to do */ }
}

/* ------------------------------------------------------------------
   Wall-clock to a real instant.

   A booking is written as "2026-09-04 19:00" and means seven in the
   evening at the venue. Google needs an actual instant, so the zone's
   offset has to be worked out FOR THAT DATE — not today's offset, or
   the browser's. Seoul never moves, but a Tokyo or Los Angeles
   campaign would, and reading the offset off the wrong day is how you
   get a booking an hour out for half the year.
   ------------------------------------------------------------------ */
export function tzOffsetMinutes(utcMs, tz) {
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

export const pad2 = (n) => String(n).padStart(2, '0');

export function wallClockToRfc3339(y, mo, d, h, mi, tz) {
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  let off = tzOffsetMinutes(wanted, tz);
  if (off == null) return null;
  /* second pass: on a DST changeover the first guess lands on the wrong
     side of the jump, and the offset it reads back is the old one */
  off = tzOffsetMinutes(wanted - off * 60000, tz);
  if (off == null) return null;
  const sign = off >= 0 ? '+' : '-', a = Math.abs(off);
  return `${y}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${pad2(mi)}:00` +
         `${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

/* "2026-09-04 19:00" (or just the date) -> { start, end } as RFC3339 */
export function slotToRange(wall, tz, minutes, endWall) {
  const m = String(wall || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const hasTime = m[4] != null;
  const h = hasTime ? +m[4] : 10, mi = hasTime ? +m[5] : 0;
  const start = wallClockToRfc3339(y, mo, d, h, mi, tz);
  if (!start) return null;

  let end = null;
  if (endWall) {
    const e = String(endWall).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
    if (e) end = wallClockToRfc3339(+e[1], +e[2], +e[3], +(e[4] || 0), +(e[5] || 0), tz);
  }
  if (!end) {
    const total = h * 60 + mi + (minutes || GCAL_PREFS.visitMinutes);
    const dayShift = Math.floor(total / 1440);
    const rest = total % 1440;
    const base = new Date(Date.UTC(y, mo - 1, d + dayShift));
    end = wallClockToRfc3339(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(),
                             Math.floor(rest / 60), rest % 60, tz);
  }
  return end ? { start, end, hasTime } : null;
}

export const campaignTimeZone = (cp) => (cp && cp.timezone) || GCAL_PREFS.defaultTz;

/* ------------------------------------------------------------------
   Everything that should be on the calendar, in one shape.
   `key` is what the event id is derived from, so it must identify the
   booking and never change for it.
   ------------------------------------------------------------------ */
export function calendarItems() {
  const items = [], skipped = [];

  DB.participants.forEach((p) => {
    /* the confirmed slot when there is one, otherwise what they asked for —
       so a booking moved by hand moves the Google event with it */
    const slot = visitSlotOf(p);
    if (!slot) return;
    const cr = byCreator[p.creatorId], cp = byCampaign[p.campaignId];
    if (!cr || !cp) return;
    if (p.stage === 'dropped') return;               /* dropped out, no booking */
    const tz = campaignTimeZone(cp);
    const range = slotToRange(slot, tz, GCAL_PREFS.visitMinutes);
    if (!range) { skipped.push({ kind: 'visit', why: 'unreadable', label: `${cr.handle} · ${cp.brand}`, raw: slot }); return; }
    items.push({
      kind: 'visit', key: p.id, record: p,
      title: `${cr.handle} — ${cp.brand}`,
      description: [cp.name, p.fullName && ('Name: ' + p.fullName), p.contact && ('Contact: ' + p.contact),
                    cr.followers && (kmb(cr.followers) + ' followers on ' + cr.platform),
                    p.note && ('Note: ' + p.note)].filter(Boolean).join('\n'),
      location: cp.venue || cp.market || '',
      start: range.start, end: range.end, timeZone: tz,
      campaignId: cp.id, participantId: p.id, wall: slot
    });
  });

  DB.appointments.forEach((a) => {
    const cp = a.campaignId ? byCampaign[a.campaignId] : null;
    const tz = a.timezone || campaignTimeZone(cp);
    const startWall = a.date + (a.startTime ? ' ' + a.startTime : '');
    const endWall = (a.endDate || a.date) + (a.endTime ? ' ' + a.endTime : '');
    const range = slotToRange(startWall, tz, 60, a.endTime || a.endDate ? endWall : null);
    if (!range) { skipped.push({ kind: 'appointment', why: 'unreadable', label: a.title || '(untitled)', raw: startWall }); return; }
    items.push({
      kind: 'appointment', key: a.id, record: a,
      title: a.title || 'Appointment',
      description: a.description || '',
      location: a.location || '',
      start: range.start, end: range.end, timeZone: tz,
      campaignId: a.campaignId || null, wall: startWall
    });
  });

  return { items, skipped };
}

/* ------------------------------------------------------------------
   What is wrong, stated rather than silently worked around.
   ------------------------------------------------------------------ */
export function detectCalendarIssues(items, skipped, remote) {
  const issues = [];
  const add = (level, type, text, extra) => issues.push(Object.assign({ level, type, text }, extra || {}));

  skipped.forEach((s) =>
    add('warn', 'unreadable', `${s.label}: cannot read “${s.raw}” as a date and time, so it was not sent.`));

  /* two people booked into the same slot at the same place */
  const byCampaignSlot = {};
  items.filter((i) => i.kind === 'visit').forEach((i) => {
    const k = i.campaignId + '|' + i.start;
    (byCampaignSlot[k] = byCampaignSlot[k] || []).push(i);
  });
  Object.values(byCampaignSlot).forEach((group) => {
    if (group.length < 2) return;
    const cp = byCampaign[group[0].campaignId];
    add('warn', 'double-booked',
      `${group.length} creators are booked into ${cp ? cp.brand : 'a campaign'} at the same time (${group[0].wall}): ` +
      group.map((g) => g.title.split(' — ')[0]).join(', '));
  });

  /* a booking outside the campaign's own dates is usually a typo in the year */
  items.forEach((i) => {
    const cp = i.campaignId ? byCampaign[i.campaignId] : null;
    if (!cp || !cp.start || !cp.end) return;
    const day = i.start.slice(0, 10);
    if (day < cp.start || day > cp.end)
      add('warn', 'outside-window', `${i.title} is booked for ${day}, outside ${cp.brand}'s dates (${cp.start} → ${cp.end}).`);
  });

  /* a zone nobody can resolve means every time on it is a guess */
  const zones = [...new Set(items.map((i) => i.timeZone))];
  zones.forEach((tz) => {
    if (tzOffsetMinutes(Date.now(), tz) == null)
      add('bad', 'bad-timezone', `“${tz}” is not a timezone this browser knows, so those times cannot be sent.`);
  });

  /* events on the calendar whose booking no longer exists here */
  const liveKeys = new Set(items.map((i) => i.kind + ':' + i.key));
  remote.forEach((e) => {
    const k = (e.props.vivelyKind || 'visit') + ':' + (e.props.vivelyKey || '');
    if (!e.props.vivelyKey || liveKeys.has(k)) return;
    add('warn', 'orphan', `“${e.summary}” on ${String(e.start).slice(0, 10)} is still on the calendar, but the booking behind it is gone.`,
        { eventId: e.id, htmlLink: e.htmlLink });
  });

  return issues;
}

/* did someone move this in Google since we last wrote it? */
export function remoteDrift(item, remote) {
  const e = remote.find((x) => x.props.vivelyKey === String(item.key) &&
                               (x.props.vivelyKind || 'visit') === item.kind);
  if (!e) return null;
  const same = (a, b) => new Date(a).getTime() === new Date(b).getTime();
  const changed = !same(e.start, item.start) || !same(e.end, item.end) ||
                  (e.location || '') !== (item.location || '');
  if (!changed) return null;
  const stamp = item.record && item.record.googleSyncedAt;
  const editedThere = stamp && e.updated && new Date(e.updated) > new Date(stamp);
  return { event: e, editedThere: !!editedThere };
}

export async function gcalCall(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Server responded ${res.status}`);
  return body;
}

export async function refreshGcalStatus() {
  try {
    const body = await gcalCall('/api/calendar/status');
    Object.assign(GCAL, { checked: true, configured: !!body.configured, clientEmail: body.clientEmail || '',
      calendarId: body.calendarId || '', summary: body.summary || '', timeZone: body.timeZone || '',
      error: null, missing: body.missing || [] });
  } catch (err) {
    Object.assign(GCAL, { checked: true, configured: false, error: err.message });
  }
  return GCAL;
}

/* ------------------------------------------------------------------
   The sync. Reads the calendar first, then writes only what needs
   writing, and refuses to touch anything that was edited in Google
   since we last wrote it.
   ------------------------------------------------------------------ */
export async function runCalendarSync(opts) {
  const o = opts || {};
  if (GCAL.busy) return;
  GCAL.busy = true; GCAL.error = null;
  if (!o.silent) toast('Reading the calendar…');
  notify();

  try {
    const { items, skipped } = calendarItems();
    const days = 365;
    const min = new Date(Date.now() - 60 * 86400000).toISOString();
    const max = new Date(Date.now() + days * 86400000).toISOString();
    const listed = await gcalCall(`/api/calendar/events?tag=vively-dashboard&timeMin=${encodeURIComponent(min)}&timeMax=${encodeURIComponent(max)}`);
    const remote = listed.events || [];

    const issues = detectCalendarIssues(items, skipped, remote);
    let created = 0, updated = 0, unchanged = 0, held = 0, failed = 0;

    for (const item of items) {
      const drift = remoteDrift(item, remote);
      if (drift && drift.editedThere) {
        held++;
        issues.push({ level: 'warn', type: 'edited-in-google',
          text: `“${item.title}” was changed in Google (now ${String(drift.event.start).slice(0, 16).replace('T', ' ')}) ` +
                `and the dashboard says ${item.wall}. Left alone — fix whichever is wrong.`,
          eventId: drift.event.id, htmlLink: drift.event.htmlLink });
        continue;
      }
      const existing = remote.find((x) => x.props.vivelyKey === String(item.key) &&
                                          (x.props.vivelyKind || 'visit') === item.kind);
      if (existing && !drift && item.record.googleEventId) { unchanged++; continue; }

      try {
        const body = await gcalCall('/api/calendar/event', { method: 'POST', body: JSON.stringify({
          kind: item.kind, key: item.key, summary: item.title, description: item.description,
          location: item.location, start: item.start, end: item.end, timeZone: item.timeZone,
          props: { vivelyCampaignId: item.campaignId || '', vivelyParticipantId: item.participantId || '' }
        }) });
        item.record.googleEventId = body.event.id;
        item.record.googleLink = body.event.htmlLink || '';
        item.record.googleSyncedAt = body.event.updated || new Date().toISOString();
        if (body.action === 'created') created++; else updated++;
      } catch (err) {
        failed++;
        issues.push({ level: 'bad', type: 'write-failed', text: `${item.title}: ${err.message}` });
      }
    }

    GCAL.issues = issues;
    GCAL.at = new Date();
    GCAL.last = { created, updated, unchanged, held, failed, total: items.length };

    const parts = [];
    if (created) parts.push(`${created} added`);
    if (updated) parts.push(`${updated} updated`);
    if (unchanged) parts.push(`${unchanged} already correct`);
    if (held) parts.push(`${held} left alone`);
    if (failed) parts.push(`${failed} failed`);
    const summary = parts.length ? parts.join(', ') : 'nothing to send';
    if (!o.silent) toast(`Calendar: ${summary}` + (issues.length ? ` · ${issues.length} to look at` : ''));
    serverSave({ silent: true });
  } catch (err) {
    GCAL.error = err.message;
    if (!o.silent) toast('Calendar sync failed — ' + err.message);
  } finally {
    GCAL.busy = false;
    notify();
  }
}

export async function removeCalendarEvent(id, label) {
  try {
    await gcalCall('/api/calendar/event/delete', { method: 'POST', body: JSON.stringify({ id }) });
    GCAL.issues = GCAL.issues.filter((i) => i.eventId !== id);
    toast(`Removed “${label}” from the calendar`);
    notify();
  } catch (err) {
    toast('Could not remove it — ' + err.message);
  }
}

export async function testCalendarConnection() {
  const btn = $('#gcTest');
  if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
  try {
    await gcalCall('/api/calendar/test', { method: 'POST', body: '{}' });
    toast('Connected — wrote a test event and removed it again');
    GCAL.error = null;
  } catch (err) {
    GCAL.error = err.message;
    toast('Test failed — ' + err.message);
  }
  await refreshGcalStatus();
  notify();
}
