import { STATUS_MAP, TEMPLATES } from '../import/excel.js';
import { iso } from '../lib/dates.js';
import { num } from '../lib/format.js';
import { duplicateCreatorGroups, mergeDuplicateCreators } from '../model/creators.js';
import { DB, byCampaign, byCreator, clearPersisted, linkSocialContent, notify, persist, persistState } from '../model/db.js';
import { SETTINGS } from '../model/settings.js';
import { SOURCES, newId, tierOf } from '../model/vocab.js';
import { $, esc } from '../ui/dom.js';
import { downloadFile, flagPill, stagePill, statCard, whoHtml } from '../ui/html.js';
import { toast } from '../ui/overlay.js';
import { settingsCalendar } from './calendar.js';
import { settingsPartners, wireWritebackCard, writebackCardHtml } from './partners.js';
import { settingsSheets } from './sheetsSettings.js';

/* ============================================================
   SETTINGS SECTION
   ============================================================ */
export const SETTINGS_ITEMS = [
  { id: 'templates',    label: 'Campaign templates',  sub: 'the two Excel sheets' },
  { id: 'blacklist',    label: 'Creator blacklist',   sub: 'blocked, flagged, preferred' },
  { id: 'sheet',        label: 'Google Sheet',        sub: 'shared store for the team' },
  { id: 'calendar',     label: 'Google Calendar',     sub: 'push bookings to a calendar' },
  { id: 'notion',       label: 'Notion',              sub: 'stage changes written back' },
  { id: 'partners',     label: 'Partners',            sub: 'share progress, read their comments' },
  { id: 'integrations', label: 'Instagram & TikTok',  sub: 'what a connection can pull' },
  { id: 'sources',      label: 'Data sources',        sub: 'where creators come from' },
  { id: 'report',       label: 'Report hand-off',     sub: 'Vively Toolkit' },
  { id: 'definitions',  label: 'Metric definitions',  sub: 'how the numbers are built' }
];

export function renderSettings(view, item) {
  if (item === 'templates')  return settingsTemplates(view);
  if (item === 'blacklist')  return settingsBlacklist(view);
  if (item === 'sheet')      return settingsSheets(view);
  if (item === 'calendar')   return settingsCalendar(view);
  if (item === 'notion')     { view.innerHTML = `<div class="grid g2">${writebackCardHtml()}</div>`; return wireWritebackCard(); }
  if (item === 'partners')   return settingsPartners(view);
  if (item === 'sources') {
    const dupGroups = duplicateCreatorGroups();
    const dupExtra = dupGroups.reduce((a, g) => a + g.list.length - 1, 0);
    view.innerHTML = `<div class="grid g2">
      <div class="card"><div class="card-head"><h3>Where creators enter the database</h3></div>
        <dl class="kv" style="margin-top:12px">
          ${SOURCES.map((s) => `<dt>${esc(s)}</dt><dd>${num(DB.creators.filter((c) => c.source === s).length)} creators</dd>`).join('')}
        </dl>
        <div class="divider"></div>
        <div class="lbl">Import creators</div>
        <label class="btn sm">Import creators (CSV)<input type="file" id="setImport" accept=".csv" style="display:none"/></label>
        <p class="card-sub" style="margin-top:10px">CSV needs at least: handle, platform, followers. Optional: name, er, avg_views, categories, country, rate_krw, email.</p>
      </div>
      <div class="card">
        <div class="card-head"><h3>Where your data lives</h3><div class="sp"></div>
          <span class="pill ${persistState.on ? 'green' : 'red'}">${persistState.on ? 'Auto-saving' : 'Not saving'}</span></div>
        <p class="card-sub">${persistState.on
          ? 'Everything is saved to this browser automatically after each change, so closing the tab is safe. It is stored on this computer only — it is not on a server and your team cannot see it.'
          : 'This browser is blocking local storage (private window, or opened from a file with storage disabled). The workspace only lives in this tab — export a backup before you close it.'}</p>
        <dl class="kv" style="margin-top:4px">
          <dt>Last saved</dt><dd>${persistState.at ? persistState.at.toLocaleString() : 'not yet'}</dd>
          <dt>Size</dt><dd>${persistState.bytes ? Math.round(persistState.bytes / 1024) + ' KB of about 5,000 KB' : '—'}</dd>
          <dt>Shared with team</dt><dd>No — one browser, one device</dd>
        </dl>
        ${persistState.error ? `<div class="note warn" style="margin-top:12px"><strong>Last save failed:</strong> ${esc(persistState.error)}</div>` : ''}
        <div class="divider"></div>
        <div class="lbl">Backup &amp; restore</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary sm" id="setExportAll">Download backup (JSON)</button>
          <label class="btn sm">Restore from backup<input type="file" id="setRestore" accept="application/json,.json" style="display:none"/></label>
          <button class="btn sm" id="setClear">Clear workspace</button>
        </div>
        <p class="card-sub" style="margin-top:10px">Keep a backup in your Dashboard folder — restoring it on another machine moves the whole workspace across.</p>
      </div>

      <div class="card"><div class="card-head"><h3>Database health</h3></div>
        <div class="grid g2" style="gap:10px;margin-top:12px">
          ${statCard('Creators', num(DB.creators.length))}
          ${statCard('Worked with us', num(DB.creators.filter((c) => c.campaignsDone).length))}
          ${statCard('Missing email', num(DB.creators.filter((c) => !c.email).length))}
          ${statCard('Never contacted', num(DB.creators.filter((c) => !c.campaignIds.length).length))}
        </div>
        <div class="divider"></div>
        <div class="lbl">Duplicates</div>
        ${dupGroups.length
          ? `<div class="note warn" style="margin-bottom:12px"><strong>${dupGroups.length} handle${dupGroups.length === 1 ? '' : 's'}</strong>
               appear${dupGroups.length === 1 ? 's' : ''} more than once — ${num(dupExtra)} extra record${dupExtra === 1 ? '' : 's'} in total.</div>
             <table class="tbl" style="margin-bottom:12px"><thead><tr><th>Handle</th><th>Records</th><th>Campaigns</th></tr></thead><tbody>
               ${dupGroups.slice(0, 8).map((g) => `<tr>
                 <td>@${esc(g.key)}</td><td>${g.list.length}</td>
                 <td>${num(new Set(g.list.flatMap((c) => c.campaignIds || [])).size)}</td></tr>`).join('')}
             </tbody></table>
             ${dupGroups.length > 8 ? `<p class="card-sub">and ${dupGroups.length - 8} more.</p>` : ''}
             <button class="btn primary sm" id="setMerge">Merge duplicates</button>`
          : `<p class="card-sub" style="margin-top:0">No duplicates. Every creator appears once, matched on their handle
             regardless of <span class="kbd">@</span>, capitals, trailing slashes or a full profile URL. New imports are
             checked automatically — a creator already in the database is joined to the new campaign instead of copied.</p>`}
      </div>
    </div>`;
    if (dupGroups.length) $('#setMerge').addEventListener('click', () => {
      const r = mergeDuplicateCreators();
      toast(`Merged ${r.mergedCreators} duplicate record${r.mergedCreators === 1 ? '' : 's'} into ${r.groups} creator${r.groups === 1 ? '' : 's'}`);
      persist(true); notify();
    });
    $('#setExportAll').addEventListener('click', () => downloadFile(
      JSON.stringify({ savedAt: new Date().toISOString(), db: DB, settings: SETTINGS }, null, 2),
      `vively-workspace-${iso(new Date())}.json`, 'application/json'));
    $('#setImport').addEventListener('change', importCreatorsCsv);
    $('#setRestore').addEventListener('change', restoreBackup);
    $('#setClear').addEventListener('click', () => {
      if (!confirm('Delete every campaign and creator in this workspace? Download a backup first if you need one.')) return;
      clearPersisted(); toast('Workspace cleared'); notify();
    });
    return;
  }

  if (item === 'report') {
    view.innerHTML = `<div class="card" style="max-width:820px">
      <div class="card-head"><h3>Report generator</h3></div>
      <p class="card-sub">Client-facing reports are produced in the existing Vively Toolkit — this dashboard packages the data for it.</p>
      <p style="font-size:13px;color:var(--text-2)">Open <span class="kbd">vivelytoolkit.html</span> → <strong>성과 리포트</strong> tab →
      <strong>CSV 불러오기</strong>, and load the file exported from any campaign's <strong>Report</strong> tab. Column names are matched
      automatically. Proof screenshots, the printable PDF and the standalone HTML report all live there.</p>
      <div class="divider"></div>
      <div class="lbl">Campaign note → messages</div>
      <p style="font-size:13px;color:var(--text-2)">The message generator reads structured lines out of the campaign note. Keep these prefixes and it fills
      the templates precisely: <span class="kbd">What the creator gets:</span> <span class="kbd">What we need back:</span>
      <span class="kbd">Posting window:</span> <span class="kbd">Must tag</span>.</p>
    </div>`;
    return;
  }

  if (item === 'definitions') {
    view.innerHTML = `<div class="card" style="max-width:820px">
      <div class="card-head"><h3>Metric definitions</h3></div>
      <p class="card-sub">So the numbers mean the same thing to everyone.</p>
      <dl class="kv" style="margin-top:12px">
        <dt>Spend</dt><dd>product cost × shipped creators + creator fees + ad spend</dd>
        <dt>CPM</dt><dd>spend ÷ reach × 1,000</dd>
        <dt>CPV</dt><dd>spend ÷ views</dd>
        <dt>CPE</dt><dd>spend ÷ (likes + comments + shares + saves)</dd>
        <dt>CPI</dt><dd>spend ÷ confirmed creators (cost per influencer)</dd>
        <dt>ER</dt><dd>engagements ÷ views</dd>
        <dt>Viral score</dt><dd>(views ÷ creator's own average views) × (1 + 6 × share-and-save rate). 3× or more is flagged.</dd>
        <dt>Organic</dt><dd>views not attributed to a boosted / paid placement</dd>
        <dt>Delivery rate</dt><dd>posts live ÷ creators confirmed</dd>
      </dl>
    </div>`;
    return;
  }

  view.innerHTML = `<div class="grid g2">
    <div class="card">
      <div class="card-head"><h3>Instagram / Meta</h3><div class="sp"></div><span class="pill grey">Not connected</span></div>
      <p class="card-sub">What connecting actually buys you, and what it doesn't.</p>
      <div class="note" style="margin-bottom:14px">
        <strong>Automatic:</strong> your own account's insights, and — for creators who grant access via the Instagram Graph API
        Creator Marketplace or who add you as a business partner — views, reach, likes, comments, shares and saves on tagged
        or branded-content posts.
      </div>
      <div class="note warn">
        <strong>Not automatic:</strong> a creator's private post insights without their explicit grant. For everyone else the
        day-7 / day-14 screenshot request stays the fallback — that is what the “Post-live thank you + analytics request”
        template is for.
      </div>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn primary sm" onclick="toast('Connect flow is not wired in this prototype')">Connect Instagram</button>
        <button class="btn sm" onclick="toast('Connect flow is not wired in this prototype')">Connect TikTok</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>ScoutLab</h3><div class="sp"></div><span class="pill grey">Manual</span></div>
      <p class="card-sub">Creators sourced in ScoutLab currently arrive by CSV.</p>
      <p style="font-size:13px;color:var(--text-2)">Export your ScoutLab shortlist, then import it under
      <a href="#/settings/sources">Data sources</a>. Imported creators land in the database tagged
      <span class="tag">Imported CSV</span> and immediately appear in campaign auto-suggest.</p>
    </div>
  </div>`;
}

export function settingsTemplates(view) {
  view.innerHTML = `
    <div class="note" style="margin-bottom:16px">
      A campaign can be created two ways: filled in by hand, or built from one of these sheets.
      Upload happens under <a href="#/campaigns/all/active">Campaigns → Import from Excel</a>. The project name, type,
      dates and budget are always entered by hand — the sheet only supplies the creator rows.
    </div>
    <div class="grid g2">
      ${Object.values(TEMPLATES).map((t) => `<div class="card">
        <div class="card-head"><h3>${esc(t.label)}</h3><div class="sp"></div>
          <button class="btn sm" onclick="downloadTemplate('${t.id}')">Download .xlsx</button></div>
        <p class="card-sub">${esc(t.note)}</p>
        <div class="lbl">Columns</div>
        <div class="chips" style="margin-bottom:14px">${t.columns.map((c) => `<span class="tag">${esc(c)}</span>`).join('')}</div>
        <div class="lbl">Status values</div>
        <div class="chips">${t.statuses.map((c) => `<span class="tag">${esc(c)}</span>`).join('')}</div>
      </div>`).join('')}
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>How sheet statuses become pipeline stages</h3></div>
      <p class="card-sub">Anything unrecognised lands in Sourced and gets flagged during the preview.</p>
      <div class="tbl-wrap" style="max-height:34vh;overflow-y:auto"><table class="tbl">
        <thead><tr><th>Status in the sheet</th><th>Pipeline stage</th><th>Drop reason</th></tr></thead>
        <tbody>${Object.entries(STATUS_MAP).filter(([k]) => k).map(([k, v]) => `<tr>
          <td class="strong">${esc(k)}</td><td>${stagePill(v.stage)}</td>
          <td style="color:var(--text-3)">${esc(v.reason || '—')}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="card-sub" style="margin-top:12px">Column headers are matched loosely — “Full Name”, “Name”, “이름” all map to the same field,
      and anything the matcher gets wrong can be re-pointed in the import preview.</p>
    </div>`;
}

export function settingsBlacklist(view) {
  const blocked   = DB.creators.filter((c) => c.flag === 'blocked');
  const caution   = DB.creators.filter((c) => c.flag === 'caution');
  const preferred = DB.creators.filter((c) => c.flag === 'preferred');
  const rows = [...blocked, ...caution, ...preferred];

  view.innerHTML = `
    <div class="grid g4" style="margin-bottom:16px">
      ${statCard('Blacklisted', blocked.length, { foot: 'hidden from suggestions' })}
      ${statCard('Flagged', caution.length, { foot: 'selectable, but warned' })}
      ${statCard('Preferred', preferred.length, { foot: 'boosted in suggestions' })}
      ${statCard('Clean', num(DB.creators.length - rows.length), { foot: 'no flag' })}
    </div>

    <div class="card" style="margin-bottom:16px">
      <label style="display:flex;align-items:center;gap:10px;text-transform:none;letter-spacing:0;font-size:13.5px;color:var(--text-2)">
        <input type="checkbox" id="setHideBlocked" ${SETTINGS.hideBlocked ? 'checked' : ''}/>
        Hide blacklisted creators from search, auto-suggest and every segment except the blacklist itself
      </label>
      <p class="card-sub" style="margin:8px 0 0">Turn this off to keep them visible everywhere but still clearly marked.</p>
    </div>

    <div class="card" style="padding:0"><div class="tbl-wrap" style="max-height:52vh;overflow-y:auto">
      <table class="tbl"><thead><tr><th>Creator</th><th>Flag</th><th>Reason</th><th>Since</th><th class="num">Campaigns</th><th></th></tr></thead>
      <tbody>${rows.length ? rows.map((c) => `<tr class="clickable ${c.flag === 'blocked' ? 'blocked-row' : c.flag === 'preferred' ? 'preferred-row' : ''}" onclick="showCreator('${c.id}')">
        <td>${whoHtml(c, c.name)}</td><td>${flagPill(c.flag)}</td>
        <td style="color:var(--text-2);max-width:420px">${esc(c.flagReason || '—')}</td>
        <td>${c.flagAt || '—'}</td><td class="num">${c.campaignsDone || '—'}</td>
        <td><button class="btn xs" onclick="event.stopPropagation();clearFlag('${c.id}')">Clear flag</button></td></tr>`).join('')
        : `<tr><td colspan="6"><div class="empty">Nobody is flagged. Open any creator and use “Flag this creator”.</div></td></tr>`}</tbody></table>
    </div></div>`;

  $('#setHideBlocked').addEventListener('change', (e) => { SETTINGS.hideBlocked = e.target.checked; toast('Saved'); });
}

export function clearFlag(id) {
  const c = byCreator[id];
  if (!c) return;
  c.flag = null; c.flagReason = ''; c.flagAt = null;
  toast(c.handle + ' — flag cleared'); notify();
}

export async function restoreBackup(e) {
  const f = e.target.files[0]; if (!f) return;
  try {
    const saved = JSON.parse(await f.text());
    const db = saved.db || saved;
    if (!db || !Array.isArray(db.creators) || !Array.isArray(db.campaigns)) throw new Error('That file is not a VIVELY workspace backup.');
    clearPersisted();
    DB.creators = db.creators; DB.campaigns = db.campaigns; DB.participants = db.participants || [];
    DB.appointments = db.appointments || [];
    DB.partnerLinks = db.partnerLinks || [];
    DB.socialContent = db.socialContent || [];
    DB.creators.forEach((c) => (byCreator[c.id] = c));
    DB.campaigns.forEach((c) => (byCampaign[c.id] = c));
    /* a backup taken before the split still has content on the rows;
       linking adopts it rather than losing every video in the file */
    linkSocialContent();
    if (saved.settings && typeof saved.settings.hideBlocked === 'boolean') SETTINGS.hideBlocked = saved.settings.hideBlocked;
    persist(true);
    toast(`Restored ${DB.campaigns.length} campaigns and ${DB.creators.length} creators`);
    notify();
  } catch (err) { toast('Restore failed — ' + err.message); }
}

export async function importCreatorsCsv(e) {
  const f = e.target.files[0]; if (!f) return;
  const text = await f.text();
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(',').map((h) => h.trim().toLowerCase());
  let n = 0, dup = 0;
  lines.forEach((l) => {
    const v = l.split(',');
    const get = (k) => { const i = cols.indexOf(k); return i >= 0 ? (v[i] || '').trim().replace(/^"|"$/g, '') : ''; };
    const handle = get('handle'); if (!handle) return;
    const id = newId('im');
    const followers = +get('followers') || 0;
    const c = {
      id, handle: handle.startsWith('@') ? handle : '@' + handle, name: get('name') || handle,
      platform: get('platform') || 'Instagram', followers, er: +get('er') || 0,
      avgViews: +get('avg_views') || Math.round(followers * 0.8),
      categories: (get('categories') || 'Lifestyle').split('|'), country: get('country') || 'Korea',
      languages: ['EN'], tier: tierOf(followers).id, source: 'Imported CSV', rate: +get('rate_krw') || 0,
      reliability: null, avgTurnaroundDays: null, campaignsDone: 0, lastWorked: null,
      email: get('email') || '', tags: [], notes: '', campaignIds: [], contentCount: 0, totalViews: 0, bestViews: 0
    };
    DB.creators.push(c); byCreator[id] = c; n++;
  });
  mergeDuplicateCreators();
  toast(`${n} creators imported${dup ? `, ${dup} already in the database` : ''}`); notify();
}
