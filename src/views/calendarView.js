import { notionLinkedCampaigns, parseVisitSlot, syncAllNotionCampaigns } from '../import/notion.js';
import { TODAY } from '../lib/dates.js';
import { dayKey, visitsByDay } from '../model/calendar.js';
import { DB, notify } from '../model/db.js';
import { avColor } from '../model/vocab.js';
import { $, $$, esc } from '../ui/dom.js';
import { showParticipant } from './campaigns.js';
import { state } from './overview.js';

/* `scope` = a campaign to lock the calendar to (the per-campaign tab).
   Left out, it's the cross-campaign view with its own campaign filter. */
export function renderCampaignCalendar(view, scope) {
  const map = visitsByDay(scope ? scope.id : state.calCampaign);
  const total = Object.values(map).reduce((n, l) => n + l.length, 0);
  /* Open on the month the visits are actually in — landing on an empty
     "this month" and making someone page around to find their bookings is
     the wrong first impression. Reseed whenever the scope changes, but
     leave the month alone while they're paging within one scope. */
  const seedFor = scope ? scope.id : 'all:' + state.calCampaign;
  if (!state.calMonth || state.calSeededFor !== seedFor) {
    const days = Object.keys(map).sort();
    const soon = days.find((k) => k >= dayKey(TODAY)) || days[days.length - 1];
    const seed = (soon && parseVisitSlot(soon)) || TODAY;
    state.calMonth = new Date(seed.getFullYear(), seed.getMonth(), 1);
    state.calSeededFor = seedFor;
  }
  const cur = state.calMonth;

  const first = new Date(cur.getFullYear(), cur.getMonth(), 1);
  const startPad = first.getDay();                                     /* Sun = 0 */
  const daysInMonth = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(cur.getFullYear(), cur.getMonth(), d));
  while (cells.length % 7) cells.push(null);

  const monthLabel = cur.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const inMonth = Object.entries(map).filter(([k]) => k.startsWith(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`));
  const monthCount = inMonth.reduce((n, [, l]) => n + l.length, 0);
  const todayKey = dayKey(TODAY);

  view.innerHTML = `
    <div class="card-head" style="margin-bottom:14px;">
      <button class="icon-btn sm" id="calPrev" title="Previous month">&#8249;</button>
      <span style="font-size:14px;font-weight:500;min-width:170px;text-align:center">${esc(monthLabel)}</span>
      <button class="icon-btn sm" id="calNext" title="Next month">&#8250;</button>
      <button class="btn sm" id="calToday">Today</button>
      ${!scope && notionLinkedCampaigns().length ? `<button class="btn sm" id="calSyncAll" title="Pull the latest bookings for every campaign linked to a Notion form">Sync all from Notion</button>` : ''}
      <div class="sp"></div>
      <span style="font-size:12px;color:var(--text-3)">${monthCount} visit${monthCount === 1 ? '' : 's'} this month · ${total} booked${scope ? '' : ' overall'}</span>
      ${scope ? '' : `<select id="calCampaign" style="padding:5px 8px;font-size:12px;max-width:220px">
        <option value="">All campaigns</option>
        ${DB.campaigns.map((c) => `<option value="${c.id}" ${state.calCampaign === c.id ? 'selected' : ''}>${esc(c.brand)} — ${esc(c.name)}</option>`).join('')}
      </select>`}
    </div>

    ${!total ? `<div class="note" style="margin-bottom:14px">
      <strong>No visit dates booked yet.</strong> They appear here as soon as a creator picks a slot in the
      campaign's Notion form. If your form has a “Date &amp; Time Availability” question and nothing is showing,
      open <em>Sync from Notion</em> — the field is matched automatically on the next sync.
    </div>` : ''}

    <div class="card" style="padding:0;overflow:hidden">
      <div class="cal-grid cal-head">
        ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="cal-dow">${d}</div>`).join('')}
      </div>
      <div class="cal-grid">
        ${cells.map((d) => {
          if (!d) return `<div class="cal-cell cal-empty"></div>`;
          const k = dayKey(d);
          const list = map[k] || [];
          const isToday = k === todayKey;
          return `<div class="cal-cell${isToday ? ' cal-today' : ''}${list.length ? ' cal-has' : ''}" data-day="${k}">
            <div class="cal-date">${d.getDate()}${list.length ? `<span class="cal-count">${list.length}</span>` : ''}</div>
            ${list.slice(0, 4).map((v) => {
              const time = /\d{1,2}:\d{2}/.test(v.p.visitAt) ? v.p.visitAt.slice(-5) : '';
              return `<div class="cal-item" title="${esc(v.cr.handle)} · ${esc(v.cp.brand)} — ${esc(v.p.visitAt)}" data-pid="${esc(v.p.id)}">
                <span class="cal-dot" style="background:${avColor(v.cr.handle)}"></span>
                <span class="cal-name">${time ? `<span class="cal-time">${time}</span> ` : ''}${esc(v.cr.handle)}</span>
              </div>`;
            }).join('')}
            ${list.length > 4 ? `<div class="cal-more">+${list.length - 4} more</div>` : ''}
          </div>`;
        }).join('')}
      </div>
    </div>`;

  $('#calPrev').addEventListener('click', () => { state.calMonth = new Date(cur.getFullYear(), cur.getMonth() - 1, 1); notify(); });
  $('#calNext').addEventListener('click', () => { state.calMonth = new Date(cur.getFullYear(), cur.getMonth() + 1, 1); notify(); });
  $('#calToday').addEventListener('click', () => { state.calMonth = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1); notify(); });
  const calSel = $('#calCampaign');
  if (calSel) calSel.addEventListener('change', (e) => { state.calCampaign = e.target.value; notify(); });
  const calSync = $('#calSyncAll');
  if (calSync) calSync.addEventListener('click', () => {
    calSync.disabled = true; calSync.textContent = 'Syncing…';
    /* new bookings may land in another month — let it re-pick */
    state.calSeededFor = null;
    syncAllNotionCampaigns().finally(() => notify());
  });
  $$('.cal-item', view).forEach((el) => el.addEventListener('click', () => showParticipant(el.dataset.pid)));
}

/* the same calendar, locked to one campaign */
export function campaignCalendarTab(mount, cp) { renderCampaignCalendar(mount, cp); }

/* the next few visits, shown above the board so the roster answers
   "who's coming in and when" without leaving the tab */
export function upcomingVisitsStrip(cp) {
  const map = visitsByDay(cp.id);
  const rows = Object.keys(map).sort().flatMap((k) => map[k]);
  if (!rows.length) return '';
  const todayK = dayKey(TODAY);
  const ahead = rows.filter((v) => dayKey(v.at) >= todayK);
  const show = (ahead.length ? ahead : rows.slice(-6)).slice(0, 6);
  const label = ahead.length ? 'Upcoming visits' : 'Past visits';
  return `<div class="card" style="margin-bottom:12px;padding:11px 14px">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3)">${label}</span>
      ${show.map((v) => {
        const time = /\d{1,2}:\d{2}/.test(v.p.visitAt) ? ' ' + v.p.visitAt.slice(-5) : '';
        const day = v.at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        return `<span class="cal-item" data-pid="${esc(v.p.id)}" style="width:auto;padding:3px 9px;border:1px solid var(--line);border-radius:20px">
          <span class="cal-dot" style="background:${avColor(v.cr.handle)}"></span>
          <span>${esc(v.cr.handle)}</span>
          <span style="color:var(--text-3)">${esc(day + time)}</span>
        </span>`;
      }).join('')}
      ${rows.length > show.length ? `<span style="font-size:11.5px;color:var(--text-3)">+${rows.length - show.length} more</span>` : ''}
      <div class="sp"></div>
      <a class="btn xs" href="#/campaigns/${cp.id}/calendar">Open calendar</a>
    </div>
  </div>`;
}
