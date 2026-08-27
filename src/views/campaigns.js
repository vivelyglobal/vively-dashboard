import { SERIES_HEX, barsH, fitHeight, lineChart, sparkSvg, splitBar } from '../charts/index.js';
import { openMetricsImport } from '../import/metrics.js';
import { notionLinkedCampaigns, openNotionMappingDrawer, syncAllNotionCampaigns } from '../import/notion.js';
import { DAY, TODAY, addDays, dLabel, iso } from '../lib/dates.js';
import { engagementsOf, kmb, money2, num, pct, won, wonK } from '../lib/format.js';
import { recomputeCreatorStats } from '../model/creators.js';
import { DB, SERVER, byCampaign, byCreator, notify, persist, serverSave } from '../model/db.js';
import { SETTINGS, isBlocked, selectable } from '../model/settings.js';
import { campaignStats, dailySeries, liveOf, partsOf, viralScore } from '../model/stats.js';
import { suggestScore } from '../model/suggest.js';
import { CAMPAIGN_STATUS, CATEGORIES, COUNTRIES, STAGES, STAGE_IDX, stageOf, viewCurve } from '../model/vocab.js';
import { $, $$, esc } from '../ui/dom.js';
import { FLAGS, avatarHtml, copyText, daysAgo, downloadFile, emptyState, flagPill, stagePill, statCard, statusPill, tierPill, toCsv, whoHtml } from '../ui/html.js';
import { closeDrawer, openDrawer, toast } from '../ui/overlay.js';
import { campaignCalendarTab, renderCampaignCalendar, upcomingVisitsStrip } from './calendarView.js';
import { openImportWizard } from './excelImport.js';
import { briefTab, messagesTab } from './messages.js';
import { openNotionDiagnostic, openNotionSync } from './notionDiag.js';
import { openNotionImportWizard } from './notionImport.js';
import { state } from './overview.js';
import { reportTab } from './report.js';

/* ============================================================
   VIEW — CAMPAIGNS
   layer 2 = the campaign list · layer 3 = tabs on one campaign
   ============================================================ */
export const CAMPAIGN_TABS = [
  ['roster', 'Roster & pipeline'], ['calendar', 'Visit calendar'], ['content', 'Content review'],
  ['performance', 'Performance'], ['creators', 'Creator results'], ['messages', 'Messages'],
  ['brief', 'Brief'], ['report', 'Report']
];

export function renderCampaignSection(view, item, tab) {
  if (!item || item === 'all') return renderCampaignGrid(view, tab || 'active');
  return renderCampaign(view, item, tab || 'roster');
}

/* ------------------------------ all campaigns ------------------------------ */
export function renderCampaignGrid(view, tab) {
  if (tab === 'calendar') return renderCampaignCalendar(view);
  const list = DB.campaigns.filter((c) =>
    tab === 'all' ? true : tab === 'wrapped' ? c.status === 'wrapped' : c.status !== 'wrapped');

  if (!DB.campaigns.length) {
    view.innerHTML = emptyState('No campaigns yet',
      'Upload a delivery or 방문 sheet to build a campaign from your existing creator list, or set one up by hand and add creators from the database.',
      { icon: '▤' });
    return;
  }

  view.innerHTML = `
    <div class="card-head" style="margin-bottom:14px;">
      <span style="font-size:13px;color:var(--text-3)">${list.length} campaigns</span>
      <div class="sp"></div>
      <button class="btn sm" id="cpExport">Export list (CSV)</button>
      <button class="btn sm" id="cpImport">Import from Excel</button>
      <button class="btn sm" id="cpImportNotion">Import from Notion</button>
      ${notionLinkedCampaigns().length ? `<button class="btn sm" id="cpSyncAll" title="Pull new submissions for every campaign linked to a Notion form">Sync all from Notion (${notionLinkedCampaigns().length})</button>` : ''}
      <button class="btn primary sm" id="cpNew">New campaign</button>
    </div>
    <div class="grid g3" id="cpGrid"></div>`;

  $('#cpGrid').innerHTML = list.map((cp) => {
    const s = campaignStats(cp);
    const spark = s.views ? sparkSvg(dailySeries([cp], 21).views, SERIES_HEX[0]) : '';
    return `<div class="card" style="cursor:pointer" onclick="location.hash='#/campaigns/${cp.id}/roster'">
      <div class="card-head" style="align-items:flex-start">
        <div style="min-width:0">
          <div style="font-size:15px;font-weight:500;">${esc(cp.brand)}</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px;">${esc(cp.kind)} · ${esc(cp.market)}</div>
        </div>
        <div class="sp"></div>${statusPill(cp.status)}
      </div>
      <div style="font-size:11.5px;color:var(--text-3);margin:10px 0 12px;">${dLabel(cp.start)} – ${dLabel(cp.end)} · owner ${esc(cp.owner)}${
        cp.notionDatabaseId ? ` · <span title="${cp.notionSyncedAt ? 'Last Notion sync ' + new Date(cp.notionSyncedAt).toLocaleString() : 'Linked to Notion but never synced'}">Notion ${cp.notionSyncedAt ? dLabel(cp.notionSyncedAt.slice(0, 10)) : 'not synced'}</span>` : ''}</div>
      <div class="bar"><i style="width:${(s.progress * 100).toFixed(0)}%"></i></div>
      <div style="display:flex;gap:14px;font-size:11.5px;color:var(--text-3);margin-top:6px;">
        <span>${s.confirmed}/${cp.targetCreators} confirmed</span><span>${s.delivered} live</span>
      </div>
      ${spark ? `<div style="margin-top:12px">${spark}</div>` : '<div style="height:34px;margin-top:12px"></div>'}
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line);">
        <div><div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">Views</div><div style="font-size:16px;">${kmb(s.views)}</div></div>
        <div><div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">ER</div><div style="font-size:16px;">${s.views ? pct(s.er) : '—'}</div></div>
        <div><div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">CPM</div><div style="font-size:16px;">${s.reach ? money2(s.cpm) : '—'}</div></div>
      </div>
    </div>`;
  }).join('') || `<div class="empty">No campaigns in this view.</div>`;

  $('#cpNew').addEventListener('click', () => openNewCampaign());
  $('#cpImport').addEventListener('click', () => openImportWizard());
  $('#cpImportNotion').addEventListener('click', () => openNotionImportWizard());
  const syncAll = $('#cpSyncAll');
  if (syncAll) syncAll.addEventListener('click', () => {
    syncAll.disabled = true; syncAll.textContent = 'Syncing…';
    syncAllNotionCampaigns().finally(() => notify());
  });
  $('#cpExport').addEventListener('click', () => {
    const rows = list.map((cp) => {
      const s = campaignStats(cp);
      return [cp.id, cp.brand, cp.name, cp.kind, cp.status, cp.market, cp.start, cp.end, cp.targetCreators,
              s.confirmed, s.delivered, s.views, s.eng, (s.er * 100).toFixed(2) + '%', Math.round(s.spend), Math.round(s.cpm), s.cpv.toFixed(2)];
    });
    downloadFile(toCsv(['id','brand','campaign','type','status','market','start','end','target','confirmed','delivered','views','engagements','er','spend_krw','cpm','cpv'], rows),
      'vively-campaigns.csv', 'text/csv;charset=utf-8');
  });
}

export function openNewCampaign() {
  openDrawer('New campaign', `
    <div class="field"><label>Brand</label><input type="text" id="ncBrand" placeholder="e.g. TONYMOLY"/></div>
    <div class="field"><label>Campaign name</label><input type="text" id="ncName" placeholder="e.g. Autumn Seeding"/></div>
    <div class="grid g2">
      <div class="field"><label>Type</label><select id="ncKind">${['Seeding','Store visit','Paid collab','Product launch','Market validation'].map((k) => `<option>${k}</option>`).join('')}</select></div>
      <div class="field"><label>Category</label><select id="ncCat">${CATEGORIES.map((k) => `<option>${k}</option>`).join('')}</select></div>
      <div class="field"><label>Market</label><select id="ncMarket">${COUNTRIES.map((k) => `<option>${k}</option>`).join('')}</select></div>
      <div class="field"><label>Target creators</label><input type="number" id="ncTarget" value="30"/></div>
      <div class="field"><label>Start</label><input type="date" id="ncStart" value="${iso(TODAY)}"/></div>
      <div class="field"><label>End</label><input type="date" id="ncEnd" value="${iso(addDays(TODAY, 35))}"/></div>
      <div class="field"><label>Min followers</label><input type="number" id="ncMin" value="10000"/></div>
      <div class="field"><label>Product cost / creator (₩)</label><input type="number" id="ncCost" value="45000"/></div>
    </div>
    <div class="field"><label>Deliverables</label><input type="text" id="ncDeliv" value="1 Reel + 2 Stories"/></div>
    <div class="field"><label>Campaign note — this is what the message generator writes from</label>
      <textarea id="ncNote" style="min-height:180px" placeholder="Product, what the creator gets, what we need back, posting window, tags, do's and don'ts…"></textarea></div>
    <button class="btn primary" id="ncSave">Create campaign</button>
  `);
  $('#ncSave').addEventListener('click', () => {
    const id = 'cp' + (DB.campaigns.length + 1);
    const cp = {
      id,
      brand: $('#ncBrand').value.trim() || 'Untitled brand',
      name: $('#ncName').value.trim() || 'Untitled campaign',
      kind: $('#ncKind').value, category: $('#ncCat').value, market: $('#ncMarket').value,
      status: 'planning', start: $('#ncStart').value, end: $('#ncEnd').value,
      targetCreators: +$('#ncTarget').value || 30,
      minFollowers: +$('#ncMin').value || 0,
      platforms: ['Instagram'], deliverables: $('#ncDeliv').value,
      budget: (+$('#ncCost').value || 0) * (+$('#ncTarget').value || 30),
      productCostPer: +$('#ncCost').value || 0, adSpend: 0,
      hashtags: ['#vively'], owner: 'Kunzang', note: $('#ncNote').value, createdAt: iso(TODAY)
    };
    DB.campaigns.push(cp); byCampaign[id] = cp;
    closeDrawer(); location.hash = '#/campaigns/' + id + '/brief';
    toast('Campaign created');
    serverSave({ force: true, silent: true }).then(() =>
      toast(SERVER.status === 'idle' ? 'Campaign created — saved' : 'Campaign created — click Save to store it on the server'));
  });
}

/* ------------------------------ one campaign ------------------------------ */
export function renderCampaign(view, id, tab) {
  const cp = byCampaign[id];
  if (!cp) { view.innerHTML = `<div class="empty">Campaign not found.</div>`; return; }
  const s = campaignStats(cp);

  view.innerHTML = `
    <div class="card-head" style="margin-bottom:14px;">
      <div style="font-size:12.5px;color:var(--text-3);">
        ${esc(cp.name)} · ${dLabel(cp.start)}–${dLabel(cp.end)} · ${esc(cp.market)} · ${esc(cp.deliverables)} · owner ${esc(cp.owner)}
      </div>
      <div class="sp"></div>
      ${s.viralCount ? `<span class="pill green">${s.viralCount} viral</span>` : ''}
      <select id="cpStatus" style="width:145px">${Object.entries(CAMPAIGN_STATUS).map(([k, v]) => `<option value="${k}" ${cp.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
      <button class="btn sm no-print" id="cpEdit">Edit</button>
      <button class="icon-btn no-print" id="cpDelete" title="Delete this campaign">&#128465;</button>
    </div>

    <div class="grid g6" style="margin-bottom:16px;">
      ${statCard('Confirmed', `${s.confirmed}<span style="font-size:15px;color:var(--text-3)"> / ${cp.targetCreators}</span>`, { foot: `${num(s.contacted)} contacted` })}
      ${statCard('Delivered', s.delivered, { foot: `${pct(s.deliveryRate, 0)} of confirmed` })}
      ${statCard('Views', kmb(s.views), { foot: `${pct(s.paidViews / (s.views || 1), 0)} paid` })}
      ${statCard('Engagement rate', s.views ? pct(s.er) : '—', { foot: `${kmb(s.eng)} total` })}
      ${statCard('Spend', wonK(s.spend), { foot: `${wonK(cp.budget)} budget` })}
      ${statCard('CPM', s.reach ? money2(s.cpm) : '—', { hint: 'Spend ÷ reach × 1,000', foot: s.views ? `CPV ${money2(s.cpv)}` : '' })}
    </div>

    <div id="cpTab"></div>`;

  $('#cpStatus').addEventListener('change', (e) => { cp.status = e.target.value; toast('Status updated'); notify(); });
  $('#cpEdit').addEventListener('click', () => openEditCampaign(cp));
  $('#cpDelete').addEventListener('click', () => confirmDeleteCampaign(cp));

  const mount = $('#cpTab');
  ({ roster: rosterTab, calendar: campaignCalendarTab, content: contentTab, performance: campaignPerformanceTab,
     creators: campaignCreatorsTab, messages: messagesTab, brief: briefTab, report: reportTab }[tab] || rosterTab)(mount, cp);
}

/* ------------------------------ edit & delete ------------------------------ */
export function campaignFormHtml(cp) {
  return `
    <div class="grid g2" style="gap:10px">
      <div class="field"><label>Brand / client</label><input type="text" id="ecBrand" value="${esc(cp.brand)}"/></div>
      <div class="field"><label>Project name</label><input type="text" id="ecName" value="${esc(cp.name)}"/></div>
      <div class="field"><label>Type</label><select id="ecKind">${
        ['Seeding','Store visit','Paid collab','Product launch','Market validation']
          .map((k) => `<option ${cp.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
      <div class="field"><label>Category</label><select id="ecCat">${
        CATEGORIES.map((k) => `<option ${cp.category === k ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
      <div class="field"><label>Market</label><select id="ecMarket">${
        [...new Set([cp.market, ...COUNTRIES])].filter(Boolean).map((k) => `<option ${cp.market === k ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></div>
      <div class="field"><label>Status</label><select id="ecStatus">${
        Object.entries(CAMPAIGN_STATUS).map(([k, v]) => `<option value="${k}" ${cp.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
      <div class="field"><label>Start</label><input type="date" id="ecStart" value="${esc(cp.start)}"/></div>
      <div class="field"><label>End</label><input type="date" id="ecEnd" value="${esc(cp.end)}"/></div>
      <div class="field"><label>Target creators</label><input type="number" id="ecTarget" value="${cp.targetCreators}"/></div>
      <div class="field"><label>Min followers</label><input type="number" id="ecMin" value="${cp.minFollowers || 0}"/></div>
      <div class="field"><label>Product / visit cost each (₩)</label><input type="number" id="ecCost" value="${cp.productCostPer || 0}"/></div>
      <div class="field"><label>Ad spend (₩)</label><input type="number" id="ecAd" value="${cp.adSpend || 0}"/></div>
      <div class="field"><label>Budget (₩)</label><input type="number" id="ecBudget" value="${cp.budget || 0}"/></div>
      <div class="field"><label>Owner</label><input type="text" id="ecOwner" value="${esc(cp.owner || '')}"/></div>
    </div>
    <div class="field"><label>Deliverables</label><input type="text" id="ecDeliv" value="${esc(cp.deliverables || '')}"/></div>
    <div class="field"><label>Platforms (comma separated)</label><input type="text" id="ecPlatforms" value="${esc((cp.platforms || []).join(', '))}"/></div>
    <div class="field"><label>Hashtags (comma separated)</label><input type="text" id="ecHashtags" value="${esc((cp.hashtags || []).join(', '))}"/></div>
    <div class="field"><label>Campaign note — the message generator writes from this</label>
      <textarea id="ecNote" style="min-height:170px">${esc(cp.note || '')}</textarea></div>`;
}

export function readCampaignForm(cp) {
  const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
  cp.brand = $('#ecBrand').value.trim() || cp.brand;
  cp.name = $('#ecName').value.trim() || cp.name;
  cp.kind = $('#ecKind').value;
  cp.category = $('#ecCat').value;
  cp.market = $('#ecMarket').value;
  cp.status = $('#ecStatus').value;
  cp.start = $('#ecStart').value;
  cp.end = $('#ecEnd').value;
  cp.targetCreators = +$('#ecTarget').value || 0;
  cp.minFollowers = +$('#ecMin').value || 0;
  cp.productCostPer = +$('#ecCost').value || 0;
  cp.adSpend = +$('#ecAd').value || 0;
  cp.budget = +$('#ecBudget').value || 0;
  cp.owner = $('#ecOwner').value.trim();
  cp.deliverables = $('#ecDeliv').value.trim();
  cp.platforms = list($('#ecPlatforms').value);
  cp.hashtags = list($('#ecHashtags').value);
  cp.note = $('#ecNote').value;
}

export function openEditCampaign(cp) {
  openDrawer(`Edit — ${esc(cp.brand)}`, campaignFormHtml(cp) + `
    <div style="display:flex;gap:8px;margin-top:6px">
      <button class="btn primary" id="ecSave">Save changes</button>
      <button class="btn" onclick="closeDrawer()">Cancel</button>
      <div style="flex:1"></div>
      <button class="btn" id="ecDelete" style="color:#f08a8a;border-color:rgba(208,59,59,.4)">Delete campaign</button>
    </div>`, true);
  $('#ecSave').addEventListener('click', () => {
    readCampaignForm(cp);
    closeDrawer(); notify(); toast('Campaign updated');
  });
  $('#ecDelete').addEventListener('click', () => { closeDrawer(); confirmDeleteCampaign(cp); });
}

export function confirmDeleteCampaign(cp) {
  const rows = partsOf(cp.id);
  const creatorIds = new Set(rows.map((r) => r.creatorId));
  const orphaned = [...creatorIds].filter((id) =>
    !DB.participants.some((p) => p.creatorId === id && p.campaignId !== cp.id)).length;

  openDrawer('Delete campaign', `
    <div class="note warn" style="margin-bottom:16px">
      <strong>${esc(cp.brand)} — ${esc(cp.name)}</strong> and its ${rows.length} roster row${rows.length === 1 ? '' : 's'}
      will be removed. This cannot be undone.
    </div>
    <dl class="kv" style="margin-bottom:18px">
      <dt>Roster rows removed</dt><dd>${rows.length}</dd>
      <dt>Creators involved</dt><dd>${creatorIds.size}</dd>
      <dt>Creators kept in the database</dt><dd style="color:#6fce6f">all ${creatorIds.size} — including the ${orphaned} who appear on no other campaign</dd>
      <dt>Content records removed</dt><dd>${rows.filter((r) => r.content).length}</dd>
    </dl>
    <p class="card-sub">The creator database is never touched by a campaign deletion. Handles, follower counts, contact
    details, blacklist flags and notes all stay exactly as they are — only this campaign's participation rows go.</p>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn" id="dcBackup">Download backup first</button>
      <div style="flex:1"></div>
      <button class="btn" onclick="closeDrawer()">Cancel</button>
      <button class="btn primary" id="dcGo" style="background:var(--critical);border-color:var(--critical);color:#fff">Delete campaign</button>
    </div>`);
  $('#dcBackup').addEventListener('click', () => downloadFile(
    JSON.stringify({ savedAt: new Date().toISOString(), db: DB, settings: SETTINGS }, null, 2),
    `vively-workspace-${iso(new Date())}.json`, 'application/json'));
  $('#dcGo').addEventListener('click', () => {
    deleteCampaign(cp.id);
    closeDrawer();
    location.hash = '#/campaigns/all/active';
    toast(`Deleted ${cp.brand} — ${creatorIds.size} creators kept`);
    notify();
  });
}

/* removes the campaign and its roster rows. Creators are deliberately left alone. */
export function deleteCampaign(id) {
  DB.participants = DB.participants.filter((p) => p.campaignId !== id);
  DB.campaigns = DB.campaigns.filter((c) => c.id !== id);
  delete byCampaign[id];
  recomputeCreatorStats();
  persist(true);
}

/* --------------------------- roster / pipeline --------------------------- */
export function rosterTab(mount, cp) {
  const ps = partsOf(cp.id);
  mount.innerHTML = `
    <div class="card-head" style="margin-bottom:12px;">
      <div class="seg no-print" id="boardSeg">
        <button data-m="board" class="${state.boardMode === 'board' ? 'active' : ''}">Board</button>
        <button data-m="table" class="${state.boardMode === 'table' ? 'active' : ''}">Table</button>
      </div>
      <div class="sp"></div>
      <span style="font-size:12px;color:var(--text-3)">${ps.length} sourced · drag cards between columns</span>
      <button class="btn sm" id="rosterCsv">Export roster</button>
      <button class="btn sm" id="rosterMetrics" title="Update views / likes / comments / shares from a spreadsheet">Update metrics</button>
      <button class="btn sm" id="notionSync" title="${cp.notionSyncedAt ? 'Last synced ' + new Date(cp.notionSyncedAt).toLocaleString() : "Pull submissions from this campaign's Notion form"}">Sync from Notion</button>
      ${cp.notionDatabaseId ? `<button class="icon-btn sm" id="notionConfig" title="Change Notion database or field mapping">&#9881;</button>
      <button class="icon-btn sm" id="notionDiag" title="Show exactly what Notion returns and what the sync makes of it">&#128269;</button>` : ''}
      <button class="btn primary sm" id="addCreators">+ Add creators</button>
    </div>
    ${upcomingVisitsStrip(cp)}
    <div id="rosterBody"></div>`;

  const body = $('#rosterBody');
  if (state.boardMode === 'board') renderBoard(body, cp); else renderRosterTable(body, cp);
  $$('.cal-item', mount).forEach((el) => el.addEventListener('click', () => showParticipant(el.dataset.pid)));

  $('#boardSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.boardMode = b.dataset.m; notify();
  });
  $('#addCreators').addEventListener('click', () => openAddCreators(cp));
  $('#rosterCsv').addEventListener('click', () => exportRoster(cp));
  $('#rosterMetrics').addEventListener('click', () => openMetricsImport(cp));
  $('#notionSync').addEventListener('click', () => openNotionSync(cp));
  const notionCfg = $('#notionConfig');
  /* straight to the field mapping — that's what needs fixing 9 times in 10;
     the mapping drawer itself offers "use a different link" */
  if (notionCfg) notionCfg.addEventListener('click', () => openNotionMappingDrawer(cp));
  const notionDiag = $('#notionDiag');
  if (notionDiag) notionDiag.addEventListener('click', () => openNotionDiagnostic(cp));
}

export function renderBoard(mount, cp) {
  const ps = partsOf(cp.id);
  mount.innerHTML = `<div class="kb">${STAGES.map((st) => {
    const items = ps.filter((p) => p.stage === st.id);
    return `<div class="kb-col" data-stage="${st.id}">
      <header><span style="width:8px;height:8px;border-radius:50%;background:${st.color};display:inline-block"></span>
        <span class="kh">${st.label}</span><span class="kc">${items.length}</span></header>
      <div class="kb-list" data-stage="${st.id}">${items.map((p) => {
        const cr = byCreator[p.creatorId];
        return `<div class="kb-card" draggable="true" data-pid="${p.id}">
          ${whoHtml(cr)}
          <div class="kb-meta"><span>ER ${cr.er}%</span><span>${esc(cr.country)}</span>${p.fee ? `<span>${wonK(p.fee)}</span>` : ''}</div>
          ${p.visitAt ? `<div style="font-size:11px;color:var(--text-2);margin-top:5px">🗓 ${esc(p.visitAt)}</div>` : ''}
          ${p.dropReason ? `<div style="font-size:11px;color:var(--text-3);margin-top:5px">${esc(p.dropReason)}</div>` : ''}
          ${p.content && p.content.views ? `<div style="font-size:11px;color:var(--text-2);margin-top:5px">${kmb(p.content.views)} views${p.content.metricsAt ? ` <span style="color:var(--text-3)">as of ${esc(String(p.content.metricsAt).slice(0, 10))}</span>` : ''}</div>` : ''}
        </div>`;
      }).join('') || '<div style="font-size:12px;color:var(--text-3);padding:8px 2px">—</div>'}</div>
    </div>`;
  }).join('')}</div>`;

  let dragged = null;
  $$('.kb-card', mount).forEach((c) => {
    c.addEventListener('dragstart', () => { dragged = c.dataset.pid; c.classList.add('dragging'); });
    c.addEventListener('dragend', () => c.classList.remove('dragging'));
    c.addEventListener('click', () => showParticipant(c.dataset.pid));
  });
  $$('.kb-list', mount).forEach((l) => {
    l.addEventListener('dragover', (e) => { e.preventDefault(); l.classList.add('over'); });
    l.addEventListener('dragleave', () => l.classList.remove('over'));
    l.addEventListener('drop', (e) => {
      e.preventDefault(); l.classList.remove('over');
      const p = DB.participants.find((x) => x.id === dragged);
      if (!p) return;
      moveStage(p, l.dataset.stage); notify();
    });
  });
}

export function moveStage(p, stage) {
  p.stage = stage;
  const t = iso(TODAY);
  if (stage === 'contacted' && !p.contactedAt) p.contactedAt = t;
  if (STAGE_IDX[stage] >= 2 && !p.repliedAt && stage !== 'dropped') p.repliedAt = t;
  if (STAGE_IDX[stage] >= 4 && !p.confirmedAt && stage !== 'dropped') p.confirmedAt = t;
  if (STAGE_IDX[stage] >= 5 && !p.shippedAt && stage !== 'dropped') p.shippedAt = t;
  toast(byCreator[p.creatorId].handle + ' → ' + stageOf(stage).label);
}

export function renderRosterTable(mount, cp) {
  const ps = partsOf(cp.id);
  mount.innerHTML = `<div class="card" style="padding:0"><div class="tbl-wrap" style="max-height:56vh;overflow-y:auto"><table class="tbl">
    <thead><tr><th>Creator</th><th>Source</th><th class="num">Followers</th><th class="num">ER</th><th>Stage</th>
      <th>Contacted</th><th>Confirmed</th><th class="num">Fee</th><th class="num">Views</th><th></th></tr></thead>
    <tbody>${ps.map((p) => {
      const cr = byCreator[p.creatorId];
      return `<tr>
        <td>${whoHtml(cr)}</td>
        <td><span class="tag">${esc(p.source)}</span></td>
        <td class="num">${num(cr.followers)}</td><td class="num">${cr.er}%</td>
        <td><select data-pid="${p.id}" class="stageSel" style="width:150px;padding:5px 8px;font-size:12px">
          ${STAGES.map((st) => `<option value="${st.id}" ${p.stage === st.id ? 'selected' : ''}>${st.label}</option>`).join('')}
        </select></td>
        <td>${daysAgo(p.contactedAt)}</td><td>${daysAgo(p.confirmedAt)}</td>
        <td class="num">${p.fee ? wonK(p.fee) : '—'}</td>
        <td class="num">${p.content && p.content.views ? num(p.content.views) : '—'}</td>
        <td><button class="btn xs" onclick="showParticipant('${p.id}')">Open</button></td>
      </tr>`;
    }).join('')}</tbody></table></div></div>`;

  $$('.stageSel', mount).forEach((sel) => sel.addEventListener('change', () => {
    moveStage(DB.participants.find((x) => x.id === sel.dataset.pid), sel.value); notify();
  }));
}

export function exportRoster(cp) {
  const rows = partsOf(cp.id).map((p) => {
    const cr = byCreator[p.creatorId], c = p.content;
    return [cr.handle, cr.name, cr.platform, cr.followers, cr.er, cr.country, p.source, p.stage,
            p.contactedAt || '', p.confirmedAt || '', p.shippedAt || '', p.fee,
            c ? c.url : '', c ? c.views : '', c ? c.likes : '', c ? c.comments : '', c ? c.shares : '', c ? c.saves : '', c ? c.reach : ''];
  });
  downloadFile(toCsv(['handle','name','platform','followers','er','country','source','stage','contacted','confirmed','shipped','fee_krw','url','views','likes','comments','shares','saves','reach'], rows),
    `vively-${cp.brand.toLowerCase().replace(/\W+/g, '-')}-roster.csv`, 'text/csv;charset=utf-8');
}

/* --------------------------- add creators (autosuggest) --------------------------- */
export function openAddCreators(cp) {
  const already = new Set(partsOf(cp.id).map((p) => p.creatorId));
  openDrawer(`Add creators — ${esc(cp.brand)}`, `
    <div class="note" style="margin-bottom:16px;">
      Type a handle, name, category or country. Suggestions are scored against this campaign:
      <strong>${esc(cp.category)}</strong> · <strong>${esc(cp.market)}</strong> · min ${kmb(cp.minFollowers)} followers · ${cp.platforms.join(', ')}.
      ${hiddenBlocked ? `<div style="margin-top:6px">${hiddenBlocked} blacklisted creators are hidden. <a href="#/settings/blacklist" onclick="closeDrawer()">Manage the blacklist</a>.</div>` : ''}
    </div>
    <div class="ac-wrap field">
      <label>Search the creator database (${DB.creators.length} creators)</label>
      <input type="text" id="acInput" placeholder="e.g. beauty vietnam, or @seoul.diary" autocomplete="off"/>
      <div class="ac-list" id="acList"></div>
    </div>
    <div class="lbl" style="margin-top:18px">Best matches not yet on this campaign</div>
    <div id="acSuggest"></div>
    <div class="divider"></div>
    <div class="lbl">Selected <span id="acCount">0</span></div>
    <div id="acPicked" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px;"></div>
    <button class="btn primary" id="acAdd">Add to campaign as “Sourced”</button>
  `);

  const picked = new Map();
  const scored = selectable(DB.creators.filter((c) => !already.has(c.id)))
    .map((c) => ({ c, ...suggestScore(c, cp) }))
    .filter((s) => !s.blocked)
    .sort((a, b) => b.score - a.score);
  const hiddenBlocked = DB.creators.filter((c) => !already.has(c.id) && isBlocked(c)).length;

  function renderPicked() {
    $('#acCount').textContent = picked.size;
    $('#acPicked').innerHTML = [...picked.values()].map((c) =>
      `<span class="pill blue" style="cursor:pointer" data-un="${c.id}">${esc(c.handle)} ×</span>`).join('') || '<span style="font-size:12px;color:var(--text-3)">none yet</span>';
    $$('#acPicked .pill').forEach((p) => p.addEventListener('click', () => { picked.delete(p.dataset.un); renderPicked(); }));
  }
  function rowHtml(s, q) {
    const c = s.c;
    const hl = (t) => q ? esc(t).replace(new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>') : esc(t);
    return `<div class="ac-item" data-id="${c.id}">
      ${avatarHtml(c.handle)}
      <div style="min-width:0;flex:1">
        <div style="font-size:13px;font-weight:500">${hl(c.handle)} <span style="color:var(--text-3);font-weight:400">${hl(c.name)}</span> ${flagPill(c.flag)}</div>
        <div style="font-size:11.5px;color:var(--text-3)">${kmb(c.followers)} · ER ${c.er}% · ${esc(c.country)} · ${esc(c.categories.join(', '))}${c.campaignsDone ? ` · ${c.campaignsDone} past` : ' · new'}</div>
        ${s.reasons.length ? `<div style="font-size:11px;color:var(--text-3);margin-top:3px">${s.reasons.map((r) => `<span class="tag">${esc(r)}</span>`).join(' ')}</div>` : ''}
      </div>
      <div class="score">${s.score}</div>
    </div>`;
  }
  function bind(container) {
    $$('.ac-item', container).forEach((it) => it.addEventListener('click', () => {
      const c = byCreator[it.dataset.id];
      picked.set(c.id, c); renderPicked();
      $('#acList').classList.remove('open'); $('#acInput').value = '';
    }));
  }

  $('#acSuggest').innerHTML = `<div class="ac-list open" style="position:static;max-height:280px">${scored.slice(0, 10).map((s) => rowHtml(s, '')).join('')}</div>`;
  bind($('#acSuggest'));

  const input = $('#acInput'), list = $('#acList');
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { list.classList.remove('open'); return; }
    const terms = q.split(/\s+/);
    const hits = scored.filter((s) => {
      const hay = (s.c.handle + ' ' + s.c.name + ' ' + s.c.categories.join(' ') + ' ' + s.c.country + ' ' + s.c.platform + ' ' + s.c.tier + ' ' + s.c.tags.join(' ')).toLowerCase();
      return terms.every((t) => hay.includes(t));
    }).slice(0, 25);
    list.innerHTML = hits.length ? hits.map((s) => rowHtml(s, terms[0])).join('') : '<div class="ac-empty">No creator matches. They may already be on this campaign.</div>';
    list.classList.add('open'); bind(list);
  });
  input.addEventListener('blur', () => setTimeout(() => list.classList.remove('open'), 180));

  renderPicked();
  $('#acAdd').addEventListener('click', () => {
    if (!picked.size) { toast('Pick at least one creator'); return; }
    picked.forEach((c) => {
      if (DB.participants.some((p) => p.campaignId === cp.id && p.creatorId === c.id)) return;
      DB.participants.push({
        id: cp.id + '-' + c.id, campaignId: cp.id, creatorId: c.id, stage: 'sourced',
        source: c.source, fee: 0, contactedAt: null, repliedAt: null, confirmedAt: null,
        shippedAt: null, dropReason: null, revisions: 0, content: null, note: ''
      });
    });
    toast(picked.size + ' creators added');
    closeDrawer(); notify();
  });
}

/* --------------------------- participant drawer --------------------------- */
export function showParticipant(pid) {
  const p = DB.participants.find((x) => x.id === pid);
  if (!p) return;
  const cr = byCreator[p.creatorId], cp = byCampaign[p.campaignId], c = p.content;
  openDrawer(`${avatarHtml(cr.handle)} <span style="margin-left:8px">${esc(cr.handle)}</span>`, `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
      ${stagePill(p.stage)} ${tierPill(cr.tier)} <span class="pill grey">${esc(cr.platform)}</span> <span class="pill grey">${esc(cr.country)}</span> ${flagPill(cr.flag)}
    </div>
    ${cr.flag && cr.flagReason ? `<div class="note ${cr.flag === 'blocked' ? 'warn' : ''}" style="margin-bottom:14px"><strong>${FLAGS[cr.flag].label}:</strong> ${esc(cr.flagReason)}</div>` : ''}
    <dl class="kv" style="margin-bottom:18px">
      <dt>Campaign</dt><dd><a href="#/campaigns/${cp.id}/roster">${esc(cp.brand)} — ${esc(cp.name)}</a></dd>
      <dt>Found via</dt><dd>${esc(p.source)}</dd>
      <dt>Followers</dt><dd>${num(cr.followers)} · ER ${cr.er}% · avg ${kmb(cr.avgViews)} views</dd>
      <dt>Fee</dt><dd>${p.fee ? won(p.fee) : 'Gifted only'}</dd>
      <dt>Contacted</dt><dd>${p.contactedAt || '—'} <span style="color:var(--text-3)">${daysAgo(p.contactedAt)}</span></dd>
      <dt>Confirmed</dt><dd>${p.confirmedAt || '—'}</dd>
      <dt>Shipped / booked</dt><dd>${p.shippedAt || '—'}</dd>
      ${p.dropReason ? `<dt>Drop reason</dt><dd>${esc(p.dropReason)}</dd>` : ''}
      ${p.importedStatus ? `<dt>Sheet status</dt><dd><span class="tag">${esc(p.importedStatus)}</span></dd>` : ''}
      ${p.visitAt ? `<dt>Visit slot</dt><dd>${esc(p.visitAt)}</dd>` : ''}
      ${p.arrivingDate ? `<dt>Arrived</dt><dd>${esc(p.arrivingDate)}</dd>` : ''}
      ${p.address ? `<dt>Address</dt><dd style="white-space:pre-wrap">${esc(p.address)}</dd>` : ''}
      ${p.contact ? `<dt>Kakao / phone</dt><dd>${esc(p.contact)}</dd>` : ''}
      ${p.nationality ? `<dt>Nationality</dt><dd>${esc(p.nationality)}</dd>` : ''}
      ${p.otherSns ? `<dt>Other SNS</dt><dd><a href="${esc(p.otherSns)}" target="_blank" rel="noopener">${esc(String(p.otherSns).slice(0, 40))}…</a></dd>` : ''}
    </dl>
    <div class="field"><label>Move to stage</label>
      <select id="pdStage">${STAGES.map((s) => `<option value="${s.id}" ${p.stage === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}</select></div>
    <div class="field"><label>Internal note</label><textarea id="pdNote" style="min-height:70px">${esc(p.note)}</textarea></div>
    <div style="display:flex;gap:8px;margin-bottom:20px;">
      <button class="btn primary sm" id="pdSave">Save</button>
      <button class="btn sm" id="pdMsg">Generate message</button>
      <button class="btn sm" onclick="showCreator('${cr.id}')">Creator profile</button>
    </div>
    ${c ? `<div class="divider"></div>
      <div class="lbl">Content</div>
      <dl class="kv">
        <dt>Format</dt><dd>${esc(c.format)} on ${esc(c.platform)} ${c.boosted ? '<span class="pill yellow">Boosted</span>' : ''}</dd>
        <dt>Posted</dt><dd>${c.postedAt || 'not live yet'}</dd>
        <dt>URL</dt><dd><a href="${c.url}" target="_blank" rel="noopener">${esc(c.url.slice(0, 42))}…</a></dd>
        <dt>Views</dt><dd>${num(c.views)} <span style="color:var(--text-3)">(${num(c.organicViews)} organic / ${num(c.paidViews)} paid)</span></dd>
        <dt>Reach</dt><dd>${num(c.reach)}</dd>
        <dt>Engagements</dt><dd>${num(engagementsOf(c))} — ${num(c.likes)} likes · ${num(c.comments)} comments · ${num(c.shares)} shares · ${num(c.saves)} saves</dd>
        <dt>Profile visits</dt><dd>${num(c.profileVisits)} · ${num(c.followsGained)} follows · ${num(c.linkClicks)} link clicks</dd>
        <dt>Viral score</dt><dd>${viralScore(p).toFixed(1)}× baseline</dd>
        <dt>Top countries</dt><dd>${c.topCountries.map((x) => `<span class="tag">${x}</span>`).join(' ')}</dd>
      </dl>` : ''}
  `);
  $('#pdSave').addEventListener('click', () => {
    p.note = $('#pdNote').value;
    if ($('#pdStage').value !== p.stage) moveStage(p, $('#pdStage').value);
    closeDrawer(); notify(); toast('Saved');
  });
  $('#pdMsg').addEventListener('click', () => { closeDrawer(); location.hash = `#/messages/${cp.id}/outreach`; });
}
/* ============================================================
   CAMPAIGN TAB — CONTENT REVIEW
   ============================================================ */
export const REVISION_TYPES = ['Video', 'Subtitles / ratio', 'Audio', 'Edit', 'Caption', 'Tags & mentions', 'Timing'];

export function contentTab(mount, cp) {
  const ps = partsOf(cp.id).filter((p) => p.content);
  const pending = ps.filter((p) => p.stage === 'submitted' || p.stage === 'review');
  const live = ps.filter((p) => p.stage === 'live');

  mount.innerHTML = `
    <div class="grid g4" style="margin-bottom:16px;">
      ${statCard('Awaiting review', pending.length, { foot: pending.length ? 'oldest ' + daysAgo(pending.map((p) => p.content.submittedAt).sort()[0]) : 'all clear' })}
      ${statCard('Live posts', live.length)}
      ${statCard('Revisions requested', ps.reduce((a, p) => a + p.revisions, 0))}
      ${statCard('Avg. turnaround', ps.length ? (ps.reduce((a, p) => a + (p.shippedAt && p.content.submittedAt ? (new Date(p.content.submittedAt) - new Date(p.shippedAt)) / DAY : 0), 0) / ps.length).toFixed(1) + ' d' : '—', { foot: 'ship → draft in' })}
    </div>

    ${pending.length ? `<div class="sec-title">Review queue</div><div id="reviewQ" style="display:flex;gap:12px;overflow-x:auto;padding-bottom:6px;margin-bottom:6px"></div>` : ''}
    <div class="sec-title">All content (${ps.length})</div>
    <div class="card" style="padding:0"><div class="tbl-wrap" style="max-height:${pending.length ? 34 : 62}vh;min-height:190px;overflow-y:auto" id="contentTbl"></div></div>
  `;

  if (pending.length) {
    $('#reviewQ').innerHTML = pending.map((p) => {
      const cr = byCreator[p.creatorId], c = p.content;
      return `<div class="card tight" style="flex:0 0 230px">
        <div style="aspect-ratio:16/6;border-radius:8px;background:linear-gradient(140deg, ${c.thumbTint}33, ${c.thumbTint}11);display:grid;place-items:center;color:${c.thumbTint};font-size:20px;margin-bottom:10px;">▶</div>
        <div class="who" style="margin-bottom:8px">${avatarHtml(cr.handle)}<div><div class="h">${esc(cr.handle)}</div><div class="s">${esc(c.format)} · submitted ${daysAgo(c.submittedAt)}</div></div></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">${stagePill(p.stage)}${p.revisions ? `<span class="pill yellow">rev ${p.revisions}</span>` : ''}</div>
        <div style="display:flex;gap:6px;">
          <button class="btn primary xs" data-approve="${p.id}">Approve</button>
          <button class="btn xs" data-revise="${p.id}">Request revision</button>
        </div>
      </div>`;
    }).join('');
    $$('[data-approve]', mount).forEach((b) => b.addEventListener('click', () => {
      const p = DB.participants.find((x) => x.id === b.dataset.approve);
      p.stage = 'live'; p.content.postedAt = iso(TODAY); p.content.curve = viewCurve(p.content.views || byCreator[p.creatorId].avgViews, 3, false);
      toast('Approved — moved to Live'); notify();
    }));
    $$('[data-revise]', mount).forEach((b) => b.addEventListener('click', () => openRevision(b.dataset.revise)));
  }

  $('#contentTbl').innerHTML = ps.length ? `<table class="tbl"><thead><tr>
      <th>Creator</th><th>Format</th><th>Stage</th><th>Posted</th><th class="num">Views</th><th class="num">Organic</th>
      <th class="num">Likes</th><th class="num">Comments</th><th class="num">Saves</th><th class="num">ER</th><th class="num">Viral</th><th></th>
    </tr></thead><tbody>${ps.map((p) => {
      const cr = byCreator[p.creatorId], c = p.content, v = viralScore(p);
      return `<tr>
        <td>${whoHtml(cr)}</td>
        <td><span class="tag">${esc(c.format)}</span>${c.boosted ? ' <span class="pill yellow">Ad</span>' : ''}</td>
        <td>${stagePill(p.stage)}</td>
        <td>${c.postedAt ? dLabel(c.postedAt) : '—'}</td>
        <td class="num">${c.views ? num(c.views) : '—'}</td>
        <td class="num">${c.views ? pct(c.organicViews / c.views, 0) : '—'}</td>
        <td class="num">${num(c.likes)}</td><td class="num">${num(c.comments)}</td><td class="num">${num(c.saves)}</td>
        <td class="num">${c.views ? pct(engagementsOf(c) / c.views) : '—'}</td>
        <td class="num" style="color:${v >= 6 ? 'var(--good)' : v >= 3 ? 'var(--warning)' : 'var(--text-2)'}">${v ? v.toFixed(1) + '×' : '—'}</td>
        <td><button class="btn xs" onclick="showParticipant('${p.id}')">Open</button></td>
      </tr>`;
    }).join('')}</tbody></table>` : `<div class="empty">No content submitted yet.</div>`;
}

export function openRevision(pid) {
  const p = DB.participants.find((x) => x.id === pid);
  const cr = byCreator[p.creatorId], cp = byCampaign[p.campaignId];
  openDrawer('Request revision', `
    <div class="who" style="margin-bottom:16px">${avatarHtml(cr.handle, true)}<div><div class="h" style="font-size:15px">${esc(cr.handle)}</div><div class="s">${esc(cp.brand)} · ${esc(p.content.format)}</div></div></div>
    <div class="field"><label>What needs to change</label>
      <div class="chips" id="revTypes">${REVISION_TYPES.map((t) => `<button class="chip" data-t="${t}">${t}</button>`).join('')}</div></div>
    <div class="field"><label>Timestamp (optional)</label><input type="text" id="revTime" placeholder="e.g. 00:04 – 00:09"/></div>
    <div class="field"><label>Details</label><textarea id="revNote" placeholder="Be specific — the creator sees this verbatim."></textarea></div>
    <div class="field"><label>Message to send</label><div class="msg-out" id="revPreview"></div></div>
    <div style="display:flex;gap:8px">
      <button class="btn primary" id="revSend">Log revision &amp; copy message</button>
      <button class="btn" onclick="closeDrawer()">Cancel</button>
    </div>
  `);
  const chosen = new Set();
  const build = () => {
    const list = [...chosen];
    const txt = `Hi ${cr.handle.replace('@', '')}! Thank you so much for the ${p.content.format.toLowerCase()} — it looks great. Before it goes live we have a small revision request from ${cp.brand}:\n\n` +
      (list.length ? list.map((t) => `• ${t}`).join('\n') + '\n\n' : '') +
      ($('#revTime').value ? `Timestamp: ${$('#revTime').value}\n` : '') +
      ($('#revNote').value ? `${$('#revNote').value}\n` : '') +
      `\nCould you send the updated version within 2 days? Let me know if anything is unclear — happy to jump on a quick call.\n\nThank you!\nVIVELY`;
    $('#revPreview').textContent = txt;
    return txt;
  };
  $$('#revTypes .chip').forEach((c) => c.addEventListener('click', () => {
    c.classList.toggle('on');
    chosen.has(c.dataset.t) ? chosen.delete(c.dataset.t) : chosen.add(c.dataset.t);
    build();
  }));
  ['revTime', 'revNote'].forEach((id) => $('#' + id).addEventListener('input', build));
  build();
  $('#revSend').addEventListener('click', () => {
    p.revisions++; p.stage = 'review';
    copyText(build(), 'Revision request');
    closeDrawer(); notify();
  });
}
/* ============================================================
   ANALYTICS — campaign tabs + cross-campaign section
   ============================================================ */
export function costCards(s) {
  return `<div class="grid g4" style="margin-bottom:16px;">
    ${statCard('CPM', s.reach ? money2(s.cpm) : '—', { hint: 'Cost per 1,000 people reached.', foot: 'per 1,000 reached' })}
    ${statCard('CPV', s.views ? money2(s.cpv) : '—', { hint: 'Cost per view.', foot: 'per view' })}
    ${statCard('CPE', s.eng ? money2(s.cpe) : '—', { hint: 'Cost per engagement.', foot: 'per engagement' })}
    ${statCard('CPI', s.confirmed ? wonK(s.cpi) : '—', { hint: 'Cost per influencer.', foot: 'per confirmed creator' })}
  </div>`;
}

/* ------------------------- campaign · performance ------------------------- */
export function campaignPerformanceTab(mount, cp) {
  const s = campaignStats(cp);
  const live = liveOf(cp.id);
  if (!live.length) { mount.innerHTML = `<div class="empty">No live content yet — performance appears once posts go live.</div>`; return; }

  const days = Math.min(60, Math.max(7, Math.round((TODAY - new Date(cp.start)) / DAY)));
  const ds = dailySeries([cp], days);

  mount.innerHTML = `
    ${costCards(s)}
    <div class="grid g-2-1">
      <div class="card">
        <div class="card-head"><h3>Views since campaign start</h3></div>
        <p class="card-sub">Daily incremental views across every live post in this campaign.</p>
        <div id="caTrend"></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Organic vs paid</h3></div>
        <div id="caSplit" style="margin-top:10px"></div>
        <div class="divider"></div>
        <div class="card-head"><h3>Engagement mix</h3></div>
        <div id="caMix" style="margin-top:10px"></div>
      </div>
    </div>`;

  lineChart($('#caTrend'), { labels: ds.labels, series: [{ name: 'Views', values: ds.views, area: true }], height: fitHeight(500, 220) });
  splitBar($('#caSplit'), [
    { label: 'Organic', value: s.organicViews, color: 'var(--s1)' },
    { label: 'Paid / boosted', value: s.paidViews, color: 'var(--s2)' }
  ]);
  splitBar($('#caMix'), ['likes', 'comments', 'shares', 'saves'].map((k, i) => ({
    label: k[0].toUpperCase() + k.slice(1),
    value: live.reduce((a, p) => a + p.content[k], 0),
    color: SERIES_HEX[[2, 4, 3, 6][i]]
  })));
}

/* -------------------------- campaign · creators -------------------------- */
export function campaignCreatorsTab(mount, cp) {
  const live = liveOf(cp.id);
  if (!live.length) { mount.innerHTML = `<div class="empty">No live content yet.</div>`; return; }

  mount.innerHTML = `
    <div class="grid g2" style="margin-bottom:16px;">
      <div class="card"><div class="card-head"><h3>Views by creator</h3></div>
        <p class="card-sub">Top 8 by total views.</p><div id="caByCreator"></div></div>
      <div class="card"><div class="card-head"><h3>Cost efficiency by tier</h3></div>
        <p class="card-sub">Where the budget actually bought reach.</p><div class="tbl-wrap" id="caTier" style="margin-top:10px"></div></div>
    </div>
    <div class="card"><div class="card-head"><h3>Viral leaderboard</h3></div>
      <p class="card-sub">Views ÷ that creator's own average, weighted by shares and saves. 1.0× is normal for them.</p>
      <div class="tbl-wrap" style="max-height:28vh;min-height:170px;overflow-y:auto" id="caViral"></div></div>`;

  barsH($('#caByCreator'), live.map((p) => ({ label: byCreator[p.creatorId].handle, value: p.content.views, color: 'var(--s1)' }))
    .sort((a, b) => b.value - a.value).slice(0, 8), { labelHead: 'Creator', valueHead: 'Views' });

  const tierRows = ['nano', 'micro', 'mid', 'macro'].map((t) => {
    const ps = live.filter((p) => byCreator[p.creatorId].tier === t);
    if (!ps.length) return null;
    const views = ps.reduce((a, p) => a + p.content.views, 0);
    const reach = ps.reduce((a, p) => a + p.content.reach, 0);
    const eng = ps.reduce((a, p) => a + engagementsOf(p.content), 0);
    const spend = ps.length * cp.productCostPer + ps.reduce((a, p) => a + p.fee, 0);
    return [t[0].toUpperCase() + t.slice(1), ps.length, kmb(views), pct(eng / (views || 1)),
            money2(reach ? spend / reach * 1000 : 0), money2(views ? spend / views : 0)];
  }).filter(Boolean);
  $('#caTier').innerHTML = `<table class="tbl"><thead><tr><th>Tier</th><th class="num">Posts</th><th class="num">Views</th><th class="num">ER</th><th class="num">CPM</th><th class="num">CPV</th></tr></thead>
    <tbody>${tierRows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ' class="strong"'}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

  const viral = live.map((p) => ({ p, v: viralScore(p) })).sort((a, b) => b.v - a.v);
  $('#caViral').innerHTML = `<table class="tbl"><thead><tr><th>Creator</th><th class="num">Views</th><th class="num">vs baseline</th><th class="num">Comments</th><th class="num">Share+save rate</th><th class="num">Score</th></tr></thead>
    <tbody>${viral.map(({ p, v }) => {
      const cr = byCreator[p.creatorId], c = p.content;
      return `<tr class="clickable" onclick="showParticipant('${p.id}')">
        <td>${whoHtml(cr)}</td><td class="num">${num(c.views)}</td>
        <td class="num">${(c.views / (cr.avgViews || 1)).toFixed(1)}×</td>
        <td class="num">${num(c.comments)}</td>
        <td class="num">${pct((c.shares + c.saves) / (c.views || 1), 2)}</td>
        <td class="num" style="color:${v >= 5 ? 'var(--good)' : v >= 3 ? 'var(--warning)' : 'var(--text-2)'};font-weight:500">${v.toFixed(1)}</td></tr>`;
    }).join('')}</tbody></table>`;
}
