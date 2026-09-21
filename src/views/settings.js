import { STATUS_MAP, TEMPLATES } from '../import/excel.js';
import { iso } from '../lib/dates.js';
import { num } from '../lib/format.js';
import { duplicateCreatorGroups, mergeDuplicateCreators } from '../model/creators.js';
import { DB, byCampaign, byCreator, clearPersisted, linkSocialContent, notify, persist, persistState, serverSave, toastAfterSave } from '../model/db.js';
import { SETTINGS } from '../model/settings.js';
import { SOURCES, newId, tierOf } from '../model/vocab.js';
import { SM, SM_CONTENT_DEFAULT_MAP, SM_CONTENT_FIELDS, commitSheetMetrics, dryRunSheetMetrics, fetchSheetTab, saveSheetMetricsConfig, smHeaderIndex, smInfluencerKind, smSuggestCampaign } from '../sync/sheetMetrics.js';
import { $, $$, esc } from '../ui/dom.js';
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
  { id: 'sheetmetrics', label: 'Sheet metrics',       sub: 'read performance from a scraper Sheet' },
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
  if (item === 'sheetmetrics') return settingsSheetMetrics(view);
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

/* ------------------------------------------------------------------
   Setup → Sheet metrics.

   Deliberately a different panel from Setup → Google Sheet. That one is
   the workspace mirror and its Pull replaces everything; this one reads
   a master Sheet onto records that already exist. Keeping them apart on
   screen is as much a part of the safety as keeping the code apart.
   ------------------------------------------------------------------ */
export let SM_DRY = null;

export function smCampaignOptions(selected) {
  return `<option value="">— not mapped —</option>` + DB.campaigns.slice()
    .sort((a, b) => String(a.brand).localeCompare(String(b.brand)))
    .map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.brand)}${c.name ? ' — ' + esc(c.name) : ''}</option>`)
    .join('');
}

/* One row per campaign tab, and the mapping reads the way it works:
   Tab KOWORK → Campaign KOWORK. */
export function smTabRows() {
  return (SM.contentTabs || []).map((t, i) => {
    const cp = t.campaignId ? byCampaign[t.campaignId] : null;
    return `<div class="card tight" style="margin-bottom:8px;padding:10px 12px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="checkbox" data-smton="${i}" ${t.on ? 'checked' : ''} title="read this tab"/>
        <span style="font-size:12px;color:var(--text-3)">Tab</span>
        <input type="text" data-smtname="${i}" value="${esc(t.name || '')}" placeholder="KOWORK" style="width:150px"/>
        <span style="color:var(--text-3)">→</span>
        <span style="font-size:12px;color:var(--text-3)">Campaign</span>
        <select data-smtcp="${i}" style="min-width:220px">${smCampaignOptions(t.campaignId)}</select>
        <input type="text" data-smtgid="${i}" value="${esc(t.gid || '')}" placeholder="gid" style="width:110px" title="the number after gid= in the tab's URL"/>
        <button class="btn xs" data-smtdel="${i}">Remove</button>
      </div>
      <div style="font-size:12px;margin-top:6px;color:${cp ? 'var(--text-2)' : 'var(--amber)'}">
        ${cp ? `Tab <strong>${esc(t.name || '?')}</strong> → Campaign <strong>${esc(cp.brand)}</strong>`
             : `Not mapped yet — existing posts on this tab still update, but no new post can be added from it.`}
      </div>
    </div>`;
  }).join('');
}

export function smMapRows(which, fields, map, defaults) {
  return fields.map((f) => `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:5px">
      <code style="width:120px;font-size:11.5px;color:var(--text-3)">${f}</code>
      <input type="text" data-smmap="${which}" data-field="${f}" value="${esc((map || {})[f] || '')}"
        placeholder="${esc((defaults || {})[f] || 'the column header in your Sheet')}" style="flex:1"/>
    </div>`).join('');
}

export function settingsSheetMetrics(view) {
  view.innerHTML = `
    <div class="card" style="max-width:900px;margin-bottom:14px">
      <div class="card-head"><h3>Performance from your master Sheet</h3><div class="sp"></div>
        <span class="pill ${SM.at ? 'green' : 'grey'}">${SM.at ? 'read ' + SM.at.toLocaleString() : 'never read'}</span></div>
      <p class="card-sub">One Sheet, one tab per campaign. Reads views, likes and comments onto posts already here
        and, within strict limits, adds posts the library has not seen. It never writes to the Sheet, never creates
        a creator, and never puts anyone on a roster or takes them off one.
        This is not the workspace mirror in <strong>Setup → Google Sheet</strong> — that one's Pull replaces the
        workspace. These two share no settings.</p>

      <div class="field" style="margin-top:14px"><label>Master Sheet link</label>
        <input type="text" id="smBase" value="${esc(SM.base)}" placeholder="https://docs.google.com/spreadsheets/d/…"/></div>
      <div class="grid g3" style="gap:10px">
        <div class="field"><label>post_er in the Sheet</label>
          <select id="smEr">
            <option value="percent" ${SM.erUnit === 'percent' ? 'selected' : ''}>Percent — 4.2 means 4.2%</option>
            <option value="decimal" ${SM.erUnit === 'decimal' ? 'selected' : ''}>Decimal — 0.042 means 4.2%</option>
          </select></div>
        <div class="field"><label>A zero in the Sheet</label>
          <select id="smZero">
            <option value="skip" ${SM.skipZero ? 'selected' : ''}>Treat as blank — keep what we have</option>
            <option value="take" ${SM.skipZero ? '' : 'selected'}>Take it literally</option>
          </select></div>
        <div class="field"><label>Posts the library hasn't seen</label>
          <select id="smCreate">
            <option value="yes" ${SM.allowCreate ? 'selected' : ''}>Add them, within the rules</option>
            <option value="no" ${SM.allowCreate ? '' : 'selected'}>Only update existing posts</option>
          </select></div>
      </div>
    </div>

    <div class="card" style="max-width:900px;margin-bottom:14px">
      <div class="card-head"><h3>Campaign tabs</h3><div class="sp"></div>
        <button class="btn xs" id="smAddTab">+ Add tab</button></div>
      <p class="card-sub">Map each tab to its campaign once. That mapping is the only place a campaign comes from —
        there is no campaign column. Find a tab's <strong>gid</strong> in the Sheet's address bar when the tab is open.</p>
      <div style="margin-top:12px" id="smTabs">${smTabRows() || '<p class="card-sub">No tabs yet — add one per campaign.</p>'}</div>
      <div class="divider"></div>
      <div class="lbl">Columns on every campaign tab</div>
      <p class="card-sub">Already set to your master Sheet's headers. Change one only if a tab is laid out differently.
        <strong>post_url</strong> is how a row finds its post. <strong>ci_id</strong> is not used — it isn't a post id.</p>
      <div style="margin-top:10px">${smMapRows('content', SM_CONTENT_FIELDS, SM.contentMap, SM_CONTENT_DEFAULT_MAP)}</div>
    </div>

    <div class="card" style="max-width:900px;margin-bottom:14px">
      <div class="card-head"><h3>Creator profile tab</h3><div class="sp"></div><span class="pill grey">optional</span></div>
      <p class="card-sub">Only for a tab of <em>profile</em> figures — followers and account-wide averages. Leave it off
        until you have one. Per-post numbers, <strong>post_er</strong> included, never stand in for a creator's profile.
        Creator status stays on the Vively flag; nothing in a Sheet changes it.</p>
      <div style="display:flex;gap:8px;align-items:center;margin:12px 0">
        <input type="checkbox" id="smCrOn" ${SM.creatorTab.on ? 'checked' : ''}/>
        <input type="text" id="smCrName" value="${esc(SM.creatorTab.name || '')}" placeholder="tab name" style="flex:1"/>
        <input type="text" id="smCrGid" value="${esc(SM.creatorTab.gid || '')}" placeholder="gid" style="width:110px"/>
      </div>
      ${SM.creatorTab.on ? `<div style="margin-top:4px">${smMapRows('creator',
        ['handle','followers','er','avgViews','avgLikes','avgComments','country','category','scrapedAt'], SM.creatorMap)}</div>` : ''}
    </div>

    <div class="card" style="max-width:900px">
      <div class="card-head"><h3>Read and preview</h3></div>
      <p class="card-sub">Nothing is written until you have seen what would change.</p>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn primary" id="smDry" ${SM.base ? '' : 'disabled'}>Read the Sheet</button>
        <button class="btn" id="smCheck" ${SM.base ? '' : 'disabled'}>Check the columns</button>
      </div>
      <div id="smOut" style="margin-top:14px"></div>
    </div>`;

  wireSheetMetrics(view);
}

export function wireSheetMetrics(view) {
  const save = () => { saveSheetMetricsConfig(); };
  const redraw = () => { notify(); };

  $('#smBase').addEventListener('change', (e) => { SM.base = e.target.value.trim(); save(); redraw(); });
  $('#smEr').addEventListener('change', (e) => { SM.erUnit = e.target.value; save(); });
  $('#smZero').addEventListener('change', (e) => { SM.skipZero = e.target.value === 'skip'; save(); });
  $('#smCreate').addEventListener('change', (e) => { SM.allowCreate = e.target.value === 'yes'; save(); });

  $('#smAddTab').addEventListener('click', () => {
    SM.contentTabs = (SM.contentTabs || []).concat([{ name: '', gid: '', campaignId: '', on: true }]);
    save(); redraw();
  });
  $$('[data-smtdel]').forEach((b) => b.addEventListener('click', () => {
    SM.contentTabs.splice(+b.dataset.smtdel, 1); save(); redraw();
  }));
  $$('[data-smton]').forEach((c) => c.addEventListener('change', () => {
    SM.contentTabs[+c.dataset.smton].on = c.checked; save();
  }));
  /* naming a tab offers the campaign of the same name — a suggestion the
     operator can change, never a mapping made behind their back */
  $$('[data-smtname]').forEach((i) => i.addEventListener('change', () => {
    const t = SM.contentTabs[+i.dataset.smtname];
    t.name = i.value.trim();
    if (!t.campaignId) t.campaignId = smSuggestCampaign(t.name);
    save(); redraw();
  }));
  $$('[data-smtcp]').forEach((s) => s.addEventListener('change', () => {
    SM.contentTabs[+s.dataset.smtcp].campaignId = s.value; save(); redraw();
  }));
  $$('[data-smtgid]').forEach((i) => i.addEventListener('change', () => {
    SM.contentTabs[+i.dataset.smtgid].gid = i.value.trim(); save();
  }));

  $('#smCrOn').addEventListener('change', (e) => { SM.creatorTab.on = e.target.checked; save(); redraw(); });
  $('#smCrName').addEventListener('change', (e) => { SM.creatorTab.name = e.target.value.trim(); save(); });
  $('#smCrGid').addEventListener('change', (e) => { SM.creatorTab.gid = e.target.value.trim(); save(); });

  $$('[data-smmap]').forEach((i) => i.addEventListener('change', () => {
    const target = i.dataset.smmap === 'content' ? SM.contentMap : SM.creatorMap;
    if (i.value.trim()) target[i.dataset.field] = i.value.trim();
    else delete target[i.dataset.field];
    save();
  }));

  /* Reads each enabled tab's header row and says which of the expected
     columns it found. The master Sheet's layout is known, so this checks
     rather than guesses. */
  $('#smCheck').addEventListener('click', async () => {
    const map = Object.assign({}, SM_CONTENT_DEFAULT_MAP, SM.contentMap || {});
    const lines = [];
    for (const t of (SM.contentTabs || []).filter((x) => x.on)) {
      try {
        const rows = await fetchSheetTab(t.gid);
        const idx = smHeaderIndex(rows[0] || [], map);
        const missing = SM_CONTENT_FIELDS.filter((f) => idx[f] == null);
        const kind = idx.influencer != null
          ? smInfluencerKind(rows.slice(1).map((r) => r[idx.influencer])) : { kind: 'empty' };
        lines.push(`<div style="margin-bottom:8px"><strong>${esc(t.name || 'tab')}</strong> — ` +
          (idx.postUrl == null ? '<span style="color:var(--red)">no post_url column; this tab cannot match anything</span>'
            : `${SM_CONTENT_FIELDS.length - missing.length}/${SM_CONTENT_FIELDS.length} columns found` +
              (missing.length ? ` · missing: ${esc(missing.join(', '))}` : '')) +
          `<br><span style="font-size:12px;color:var(--text-3)">influencer_id: ${esc(smInfluencerLabel(kind))}</span></div>`);
      } catch (err) { lines.push(`<div class="note bad" style="margin-bottom:8px">${esc(t.name || 'tab')}: ${esc(err.message)}</div>`); }
    }
    $('#smOut').innerHTML = lines.join('') || '<p class="card-sub">No enabled tabs to check.</p>';
  });

  $('#smDry').addEventListener('click', async () => {
    $('#smOut').innerHTML = '<p class="card-sub">Reading…</p>';
    try { SM_DRY = await dryRunSheetMetrics(); renderSheetMetricsPreview(); }
    catch (err) { $('#smOut').innerHTML = `<div class="note bad">${esc(err.message)}</div>`; }
  });
}

export function smInfluencerLabel(k) {
  if (k.kind === 'handle') return `Instagram handles — ${k.resolved} of ${k.total} match a creator here, so it is used to attribute new posts`;
  if (k.kind === 'opaque') return `not handles${k.sample && k.sample.length ? ' (e.g. ' + k.sample.join(', ') + ')' : ''} — ` +
    `${k.resolved || 0} of ${k.total || 0} match a creator, so it is NOT used; new posts on this tab cannot be attributed`;
  return 'empty — new posts on this tab cannot be attributed';
}

export function smChangeLine(c) {
  if (c.fillOnly) return c.field + ' ← ' + String(c.to) + ' (was blank)';
  const f = (x) => (typeof x === 'number' ? num(x) : String(x || '—'));
  return (c.secondary ? '· ' : '') + c.field + ' ' + f(c.from) + ' → ' + f(c.to);
}

export function renderSheetMetricsPreview() {
  const d = SM_DRY;
  const sum = (k) => d.tabs.reduce((a, t) => a + t[k].length, 0);
  const rowsRead = d.tabs.reduce((a, t) => a + t.rowsRead, 0);
  const updates = sum('updates'), creates = sum('creates'), unmatched = sum('unmatched');
  const cr = d.creators || { updates: [], unmatched: [], skipped: [], rowsRead: 0 };

  const tabBlock = (t) => {
    const linked = t.creates.filter((c) => c.linked).length;
    return `<div class="card tight" style="margin-bottom:12px;padding:12px 14px">
      <div class="card-head"><h3 style="font-size:13.5px">Tab ${esc(t.tab || '?')} → ${t.campaignName
        ? 'Campaign ' + esc(t.campaignName) : '<span style="color:var(--amber)">not mapped</span>'}</h3>
        <div class="sp"></div><span style="font-size:12px;color:var(--text-3)">${t.rowsRead} rows</span></div>
      <div style="font-size:12px;color:var(--text-3);margin:4px 0 8px">influencer_id: ${esc(smInfluencerLabel(t.influencer))}</div>
      <div style="font-size:12.5px">${t.updates.length} to update · ${t.creates.length} to add
        ${t.creates.length ? `(${linked} onto an empty roster card, ${t.creates.length - linked} into the library only)` : ''}
        · ${t.skipped.length} skipped · ${t.unmatched.length} not added</div>
      ${t.conflicts.length ? `<div class="note warn" style="margin-top:8px;font-size:12px">
        ${t.conflicts.length} post${t.conflicts.length === 1 ? ' is' : 's are'} filed under a different campaign than this tab.
        Their numbers still update; they are not moved.</div>` : ''}
      ${t.unmatched.length ? `<details style="margin-top:8px"><summary style="font-size:12px;cursor:pointer">
        Why ${t.unmatched.length} row${t.unmatched.length === 1 ? ' was' : 's were'} not added</summary>
        <div class="tbl-wrap" style="max-height:200px;overflow-y:auto;margin-top:6px"><table class="tbl">
        <thead><tr><th>Row</th><th>Post</th><th>Reason</th></tr></thead><tbody>
        ${t.unmatched.slice(0, 100).map((u) => `<tr><td>${u.rowNo}</td>
          <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis">${esc(u.url)}</td>
          <td style="font-size:12px">${esc(u.why)}</td></tr>`).join('')}
        </tbody></table></div></details>` : ''}
      ${t.updates.length ? `<details style="margin-top:6px"><summary style="font-size:12px;cursor:pointer">
        What changes on ${t.updates.length} post${t.updates.length === 1 ? '' : 's'}</summary>
        <div class="tbl-wrap" style="max-height:220px;overflow-y:auto;margin-top:6px"><table class="tbl">
        <tbody>${t.updates.slice(0, 150).map((u) => `<tr>
          <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis">${esc(u.rec.postUrl || u.rec.url)}</td>
          <td style="font-size:12px">${u.changes.map(smChangeLine).map(esc).join('<br>') || '<span style="color:var(--text-3)">timestamp only</span>'}</td>
        </tr>`).join('')}</tbody></table></div></details>` : ''}
    </div>`;
  };

  $('#smOut').innerHTML = `
    ${d.errors.length ? `<div class="note bad" style="margin-bottom:12px">${d.errors.map(esc).join('<br>')}</div>` : ''}
    <div class="grid g4" style="gap:10px;margin-bottom:14px">
      ${statCard('Rows read', rowsRead, { foot: d.tabs.length + ' campaign tab' + (d.tabs.length === 1 ? '' : 's') })}
      ${statCard('Posts to update', updates, { foot: 'already in the library' })}
      ${statCard('Posts to add', creates, { foot: 'creator on the roster already' })}
      ${statCard('Not added', unmatched, { foot: 'each with its reason below' })}
    </div>
    ${d.tabs.map(tabBlock).join('')}
    ${d.creators ? `<div class="lbl">Creator profiles</div>
      <p class="card-sub">${cr.updates.length} to update · ${cr.unmatched.length} not in the database — never created</p>` : ''}
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn primary" id="smApply" ${(updates + creates + cr.updates.length) ? '' : 'disabled'}>
        Apply: update ${updates}, add ${creates}${d.creators ? ', ' + cr.updates.length + ' profiles' : ''}</button>
      <button class="btn" id="smDiscard">Discard</button>
    </div>`;

  const apply = $('#smApply');
  if (apply) apply.addEventListener('click', () => {
    const r = commitSheetMetrics(SM_DRY);
    SM_DRY = null;
    const msg = `Updated ${r.updated} and added ${r.created} post${r.created === 1 ? '' : 's'} from the Sheet` +
      (r.creators ? `, and ${r.creators} creator profile${r.creators === 1 ? '' : 's'}` : '');
    toast(msg);
    notify();
    serverSave({ force: true, silent: true }).then((res) => toastAfterSave(msg, res));
  });
  $('#smDiscard').addEventListener('click', () => { SM_DRY = null; notify(); });
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
