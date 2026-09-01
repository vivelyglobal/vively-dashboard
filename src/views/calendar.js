import { TODAY, iso } from '../lib/dates.js';
import { num } from '../lib/format.js';
import { DB, byCampaign, notify } from '../model/db.js';
import { newId } from '../model/vocab.js';
import { GCAL, GCAL_PREFS, calendarItems, gcalCall, removeCalendarEvent, runCalendarSync, saveGcalPrefs, testCalendarConnection, tzOffsetMinutes } from '../sync/gcal.js';
import { $, $$, esc } from '../ui/dom.js';
import { closeDrawer, openDrawer, toast } from '../ui/overlay.js';

/* ------------------------------------------------------------------
   The appointment form. Everything on the calendar that is not a
   creator's own booking gets typed in here.
   ------------------------------------------------------------------ */
export function openAppointmentForm(existing) {
  const a = existing || {};
  const today = iso(TODAY);
  openDrawer(existing ? 'Edit appointment' : 'New appointment', `
    <div class="grid g2" style="gap:10px">
      <div style="grid-column:1/-1"><div class="lbl">Title</div>
        <input id="apTitle" placeholder="Sushikoji — filming day" value="${esc(a.title || '')}"/></div>

      <div><div class="lbl">Date from</div><input type="date" id="apDate" value="${esc(a.date || today)}"/></div>
      <div><div class="lbl">Date until</div><input type="date" id="apEndDate" value="${esc(a.endDate || '')}"/>
        <p class="card-sub" style="margin:4px 0 0">Leave empty for a same-day appointment.</p></div>

      <div><div class="lbl">Time from</div><input type="time" id="apStart" value="${esc(a.startTime || '10:00')}"/></div>
      <div><div class="lbl">Time until</div><input type="time" id="apEnd" value="${esc(a.endTime || '11:00')}"/></div>

      <div style="grid-column:1/-1"><div class="lbl">Address or link</div>
        <input id="apLocation" placeholder="서울 종로구 … or https://meet.google.com/…" value="${esc(a.location || '')}"/>
        <p class="card-sub" style="margin:4px 0 0">Either works. Google turns an address into a map and a link into a clickable one.</p></div>

      <div style="grid-column:1/-1"><div class="lbl">Description</div>
        <textarea id="apDesc" rows="4" placeholder="What this is, who is coming, anything they need to bring">${esc(a.description || '')}</textarea></div>

      <div><div class="lbl">Campaign (optional)</div>
        <select id="apCampaign">
          <option value="">Not tied to a campaign</option>
          ${DB.campaigns.map((c) => `<option value="${c.id}" ${a.campaignId === c.id ? 'selected' : ''}>${esc(c.brand)} — ${esc(c.name)}</option>`).join('')}
        </select></div>
      <div><div class="lbl">Timezone</div>
        <input id="apTz" value="${esc(a.timezone || GCAL_PREFS.defaultTz)}"/>
        <p class="card-sub" style="margin:4px 0 0">The time above is the local time <em>there</em>.</p></div>
    </div>

    <div id="apWarn"></div>

    <div style="display:flex;gap:8px;margin-top:14px">
      <button class="btn primary" id="apSave">${existing ? 'Save changes' : 'Add appointment'}</button>
      <button class="btn" onclick="closeDrawer()">Cancel</button>
      <div style="flex:1"></div>
      ${existing ? `<button class="btn" id="apDelete" style="color:#f08a8a;border-color:rgba(208,59,59,.4)">Delete</button>` : ''}
    </div>`, true);

  $('#apSave').addEventListener('click', () => {
    const title = $('#apTitle').value.trim();
    const date = $('#apDate').value;
    const startTime = $('#apStart').value;
    const endTime = $('#apEnd').value;
    const endDate = $('#apEndDate').value;
    const tz = $('#apTz').value.trim() || GCAL_PREFS.defaultTz;

    const problems = [];
    if (!title) problems.push('Give it a title.');
    if (!date) problems.push('Pick a start date.');
    if (tzOffsetMinutes(Date.now(), tz) == null) problems.push(`“${tz}” is not a timezone this browser knows.`);
    if (date && startTime && endTime && !endDate && endTime <= startTime)
      problems.push('The end time is not after the start time — set an end date if it runs past midnight.');
    if (endDate && endDate < date) problems.push('The end date is before the start date.');
    if (problems.length) {
      $('#apWarn').innerHTML = `<div class="note bad" style="margin-top:12px">${problems.map(esc).join('<br>')}</div>`;
      return;
    }

    const rec = existing || { id: newId('ap'),
                              createdAt: new Date().toISOString() };
    Object.assign(rec, {
      title, date, endDate, startTime, endTime, timezone: tz,
      location: $('#apLocation').value.trim(),
      description: $('#apDesc').value,
      campaignId: $('#apCampaign').value || null
    });
    if (!existing) DB.appointments.push(rec);
    closeDrawer();
    notify();
    toast(existing ? 'Appointment updated' : 'Appointment added — hit “Send to Google” to put it on the calendar');
  });

  const del = $('#apDelete');
  if (del) del.addEventListener('click', async () => {
    const idx = DB.appointments.indexOf(existing);
    if (idx >= 0) DB.appointments.splice(idx, 1);
    closeDrawer();
    /* if it reached Google, take it off there too — otherwise it lingers
       as an event nobody can trace back to anything */
    if (existing.googleEventId) {
      try { await gcalCall('/api/calendar/event/delete', { method: 'POST', body: JSON.stringify({ id: existing.googleEventId }) }); }
      catch (err) { toast('Removed here, but not from Google — ' + err.message); }
    }
    notify();
    toast('Appointment deleted');
  });
}

/* the Google strip that sits above the calendar grid */
export function calendarGoogleStrip() {
  const issues = GCAL.issues || [];
  const bad = issues.filter((i) => i.level === 'bad').length;
  const last = GCAL.last;
  return `
    <div class="card" style="margin-bottom:14px;padding:11px 14px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3)">Google Calendar</span>
        ${GCAL.checked && !GCAL.configured
          ? `<span class="pill">Not connected</span><span style="font-size:12px;color:var(--text-3)">Set it up in Setup → Google Calendar.</span>`
          : `<span class="pill ${bad ? 'red' : issues.length ? 'amber' : 'green'}">${
                GCAL.busy ? 'Working…' : issues.length ? `${issues.length} to look at` : 'In step'}</span>
             ${last ? `<span style="font-size:12px;color:var(--text-3)">${
                [last.created && last.created + ' added', last.updated && last.updated + ' updated',
                 last.unchanged && last.unchanged + ' already correct', last.held && last.held + ' left alone']
                .filter(Boolean).join(' · ') || 'nothing to send'}${GCAL.at ? ' · ' + GCAL.at.toLocaleTimeString() : ''}</span>` : ''}`}
        <div class="sp"></div>
        <button class="btn xs" id="gcAppt">New appointment</button>
        <button class="btn xs primary" id="gcSync" ${GCAL.busy ? 'disabled' : ''}>Send to Google</button>
      </div>
      ${GCAL.error ? `<div class="note bad" style="margin-top:10px">${esc(GCAL.error)}</div>` : ''}
      ${issues.length ? `<div style="margin-top:10px;display:flex;flex-direction:column;gap:6px">
        ${issues.map((i, n) => `<div class="note ${i.level === 'bad' ? 'bad' : ''}" style="margin:0;display:flex;gap:8px;align-items:flex-start">
          <span style="flex:1">${esc(i.text)}</span>
          ${i.htmlLink ? `<a class="btn xs" href="${esc(i.htmlLink)}" target="_blank" rel="noopener">Open in Google</a>` : ''}
          ${i.type === 'orphan' ? `<button class="btn xs" data-drop="${esc(i.eventId)}" data-n="${n}">Remove it</button>` : ''}
        </div>`).join('')}
      </div>` : ''}
    </div>`;
}

export function wireCalendarGoogleStrip() {
  const sync = $('#gcSync');
  if (sync) sync.addEventListener('click', () => runCalendarSync());
  const appt = $('#gcAppt');
  if (appt) appt.addEventListener('click', () => openAppointmentForm(null));
  $$('[data-drop]').forEach((b) => b.addEventListener('click', () => {
    const issue = (GCAL.issues || [])[+b.dataset.n] || {};
    removeCalendarEvent(b.dataset.drop, (issue.text || '').slice(0, 40));
  }));
}

/* appointments that are not a creator visit, listed under the grid */
export function appointmentsPanel(scope) {
  const list = DB.appointments.filter((a) => !scope || a.campaignId === scope.id)
    .slice().sort((a, b) => (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')));
  if (!list.length) return '';
  return `<div class="card" style="margin-top:14px">
    <div class="card-head"><h3>Appointments</h3><div class="sp"></div>
      <span style="font-size:12px;color:var(--text-3)">${list.length} not tied to a creator booking</span></div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>When</th><th>Title</th><th>Where</th><th>Campaign</th><th>On Google</th></tr></thead>
      <tbody>${list.map((a) => {
        const cp = a.campaignId ? byCampaign[a.campaignId] : null;
        const when = a.date + (a.startTime ? ' ' + a.startTime : '') +
                     (a.endTime ? '–' + a.endTime : '') + (a.endDate ? ' → ' + a.endDate : '');
        return `<tr data-appt="${esc(a.id)}" style="cursor:pointer">
          <td>${esc(when)}</td>
          <td>${esc(a.title || '')}</td>
          <td>${a.location ? esc(a.location.slice(0, 40)) : '<span style="color:var(--text-3)">—</span>'}</td>
          <td>${cp ? esc(cp.brand) : '<span style="color:var(--text-3)">—</span>'}</td>
          <td>${a.googleEventId
            ? (a.googleLink ? `<a href="${esc(a.googleLink)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">open</a>` : 'yes')
            : '<span style="color:var(--text-3)">not sent</span>'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
  </div>`;
}

export function wireAppointmentsPanel() {
  $$('[data-appt]').forEach((tr) => tr.addEventListener('click', () => {
    const a = DB.appointments.find((x) => x.id === tr.dataset.appt);
    if (a) openAppointmentForm(a);
  }));
}

/* Setup → Google Calendar */
export function settingsCalendar(view) {
  const { items, skipped } = calendarItems();
  const sent = items.filter((i) => i.record.googleEventId).length;
  view.innerHTML = `<div class="grid g2">
    <div class="card">
      <div class="card-head"><h3>Connection</h3><div class="sp"></div>
        <span class="pill ${GCAL.configured ? 'green' : 'red'}">${GCAL.configured ? 'Connected' : 'Not connected'}</span></div>
      ${GCAL.configured ? `
        <dl class="kv" style="margin-top:12px">
          <dt>Calendar</dt><dd>${esc(GCAL.summary || GCAL.calendarId)}</dd>
          <dt>Calendar timezone</dt><dd>${esc(GCAL.timeZone || '—')}</dd>
          <dt>Writing as</dt><dd style="font-family:var(--mono);font-size:11.5px">${esc(GCAL.clientEmail)}</dd>
        </dl>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn sm" id="gcTest">Test the connection</button>
          <button class="btn sm primary" id="gcSyncNow">Send everything to Google</button>
        </div>
        <p class="card-sub" style="margin-top:10px">The test writes one event and removes it again, so a green result means
          it can genuinely write — not just that the key parses.</p>
      ` : `
        <p class="card-sub" style="margin-top:10px">Two environment variables on the server, then one sharing step in Google.
          Nothing goes in this page — the key stays on the server, same as the Notion token.</p>
        <ol class="card-sub" style="margin:10px 0 0;padding-left:18px;line-height:1.7">
          <li>Google Cloud console → new project → enable the <strong>Google Calendar API</strong>.</li>
          <li>Create a <strong>service account</strong>, add a <strong>JSON key</strong>, download it.</li>
          <li>Render → Environment → <code>GOOGLE_SERVICE_ACCOUNT</code> = the whole JSON file.</li>
          <li>In Google Calendar, make a calendar for this (e.g. “VIVELY Creator Visits”).</li>
          <li>That calendar → Settings → <strong>Share with specific people</strong> → add the service account's
              <code>client_email</code> → permission <strong>Make changes to events</strong>.</li>
          <li>Render → Environment → <code>GOOGLE_CALENDAR_ID</code> = that calendar's ID.</li>
        </ol>
        <div class="note" style="margin-top:12px"><strong>Step 5 is the one people miss.</strong> Without it Google answers
          404 for the calendar and it looks exactly like a bad key — the same trap as sharing a Notion database with an integration.</div>
        ${GCAL.missing && GCAL.missing.length ? `<div class="note bad" style="margin-top:10px">Still to set: ${GCAL.missing.map(esc).join(', ')}</div>` : ''}
        ${GCAL.clientEmail ? `<div class="note" style="margin-top:10px">Share the calendar with:<br>
          <span style="font-family:var(--mono);font-size:11.5px">${esc(GCAL.clientEmail)}</span></div>` : ''}
      `}
      ${GCAL.error ? `<div class="note bad" style="margin-top:12px">${esc(GCAL.error)}</div>` : ''}
    </div>

    <div class="card">
      <div class="card-head"><h3>What gets sent</h3></div>
      <dl class="kv" style="margin-top:12px">
        <dt>Creator visits with a slot</dt><dd>${num(items.filter((i) => i.kind === 'visit').length)}</dd>
        <dt>Appointments</dt><dd>${num(items.filter((i) => i.kind === 'appointment').length)}</dd>
        <dt>Already on the calendar</dt><dd>${num(sent)}</dd>
        <dt>Unreadable dates</dt><dd>${skipped.length ? `<span style="color:var(--warning)">${num(skipped.length)}</span>` : '0'}</dd>
      </dl>
      <div class="divider"></div>
      <div class="grid g2" style="gap:10px">
        <div><div class="lbl">Default timezone</div><input id="gcTz" value="${esc(GCAL_PREFS.defaultTz)}"/></div>
        <div><div class="lbl">Visit length (minutes)</div><input type="number" id="gcMins" min="15" step="15" value="${GCAL_PREFS.visitMinutes}"/></div>
      </div>
      <p class="card-sub" style="margin-top:10px">A creator's form answer gives a start time, not an end, so visits are
        this long unless a campaign says otherwise. The timezone is the venue's local time — get it wrong and every
        booking lands at the wrong hour.</p>
      <div class="divider"></div>
      <div class="lbl">Duplicates</div>
      <p class="card-sub">Each event's id is derived from the booking it belongs to, the id is stored here once written,
        and the sync reads back what is already on the calendar before sending. Re-running it is always safe. Where Google
        and this dashboard disagree, the difference is reported and nothing is overwritten.</p>
    </div>
  </div>`;

  const test = $('#gcTest');
  if (test) test.addEventListener('click', testCalendarConnection);
  const now = $('#gcSyncNow');
  if (now) now.addEventListener('click', () => runCalendarSync());
  $('#gcTz').addEventListener('change', () => {
    const v = $('#gcTz').value.trim();
    if (tzOffsetMinutes(Date.now(), v) == null) return toast(`“${v}” is not a timezone this browser knows`);
    GCAL_PREFS.defaultTz = v; saveGcalPrefs(); toast('Default timezone saved');
  });
  $('#gcMins').addEventListener('change', () => {
    GCAL_PREFS.visitMinutes = Math.max(15, +$('#gcMins').value || 90); saveGcalPrefs(); notify();
  });
}
