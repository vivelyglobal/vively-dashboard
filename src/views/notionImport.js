import { countryOf } from '../import/excel.js';
import { NOTION_FIELD_DEFS, guessNotionField, notionRowToApplicant } from '../import/notion.js';
import { TODAY, addDays, iso } from '../lib/dates.js';
import { num } from '../lib/format.js';
import { findCreatorByHandle, mergeDuplicateCreators } from '../model/creators.js';
import { DB, SERVER, byCampaign, byCreator, serverSave } from '../model/db.js';
import { CAMPAIGN_STATUS, CATEGORIES, COUNTRIES, STAGE_IDX, avColor, newId, stageOf, tierOf } from '../model/vocab.js';
import { $, $$, esc } from '../ui/dom.js';
import { stagePill, statCard } from '../ui/html.js';
import { closeDrawer, openDrawer, toast } from '../ui/overlay.js';

/* ============================================================
   NOTION CAMPAIGN IMPORT WIZARD
   Same job as "Import from Excel" (openImportWizard/commitImport
   above) but the source is a Notion database instead of a file —
   this is the "create AND update from Notion" path: it builds the
   campaign, creators and roster from the current submissions, and
   also saves notionDatabaseId/notionMapping on the new campaign so
   the roster tab's "Sync from Notion" button keeps it current
   afterwards without asking again.
   ============================================================ */
export let notionImportState = null;

export function openNotionImportWizard() {
  notionImportState = { databaseId: '', schema: null, mapping: {}, parsed: [] };
  openDrawer('Import a campaign from Notion', notionImportStep1Html(), true);
  wireNotionImportStep1();
}

export function notionImportStep1Html() {
  return `
    <div class="note" style="margin-bottom:16px;">
      Paste the link to the Notion database behind this campaign's form — the database of
      submission rows, not the form editor itself. In Notion, open it as a full page, click
      <strong>Share</strong>, make sure the integration this dashboard uses has access, then
      copy the page link here.
    </div>
    <div class="field"><label>Notion database link or ID</label>
      <input type="text" id="niDbInput" placeholder="https://www.notion.so/.../1a2b3c4d5e6f..."/></div>
    <button class="btn primary" id="niDbContinue">Continue</button>
    <div id="niResult" style="margin-top:18px"></div>`;
}

export function wireNotionImportStep1() {
  $('#niDbContinue').addEventListener('click', async () => {
    const v = $('#niDbInput').value.trim();
    if (!v) { toast('Paste a Notion database link first'); return; }
    notionImportState.databaseId = v;
    await loadNotionImportSchema();
  });
}

export async function loadNotionImportSchema() {
  const res = $('#niResult');
  res.innerHTML = `<div class="empty">Reading the database…</div>`;
  try {
    const r = await fetch('/api/notion/database?id=' + encodeURIComponent(notionImportState.databaseId));
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || ('Server responded ' + r.status));
    notionImportState.schema = out;
    notionImportState.databaseId = out.id; // resolved ID, in case a page link was pasted
    renderNotionImportStep2();
  } catch (err) {
    res.innerHTML = `<div class="note warn"><strong>Could not read that database.</strong> ${esc(err.message)}</div>`;
  }
}

export function renderNotionImportStep2() {
  const st = notionImportState;
  const props = st.schema.properties || [];
  const used = new Set();
  const guesses = {};
  NOTION_FIELD_DEFS.forEach((f) => {
    const hit = props.find((p) => !used.has(p.name) && guessNotionField(p.name, p.type) === f.key);
    const pick = hit ? hit.name : '';
    if (pick) used.add(pick);
    guesses[f.key] = pick;
  });
  st.mapping = guesses;

  $('#niResult').innerHTML = `
    <div class="note" style="margin-bottom:16px;">
      <strong>${esc(st.schema.title)}</strong> — ${props.length} fields found. Match each of ours to the
      Notion property that holds it. Leave “— none —” for anything this form doesn't collect.
      This mapping is saved on the campaign so future syncs won't ask again.
    </div>
    ${NOTION_FIELD_DEFS.map((f) => `
      <div class="field">
        <label>${esc(f.label)}</label>
        <select class="niMap" data-key="${f.key}">
          <option value="">— none —</option>
          ${props.map((p) => `<option value="${esc(p.name)}" ${guesses[f.key] === p.name ? 'selected' : ''}>${esc(p.name)} (${esc(p.type)})</option>`).join('')}
        </select>
      </div>`).join('')}
    <div style="display:flex;gap:8px;margin-top:6px">
      <button class="btn primary" id="niMapNext">Continue</button>
      <button class="btn" id="niMapBack">Use a different link</button>
    </div>`;

  $('#niMapBack').addEventListener('click', () => {
    openDrawer('Import a campaign from Notion', notionImportStep1Html(), true);
    wireNotionImportStep1();
  });
  $('#niMapNext').addEventListener('click', async () => {
    $$('.niMap').forEach((sel) => { st.mapping[sel.dataset.key] = sel.value || null; });
    if (!st.mapping.instagram && !st.mapping.tiktok) {
      if (!confirm("Neither Instagram nor TikTok is mapped, so submissions won't match to a creator. Continue anyway?")) return;
    }
    await loadNotionImportRows();
  });
}

export async function loadNotionImportRows() {
  $('#niResult').innerHTML = `<div class="empty">Pulling submissions…</div>`;
  try {
    const r = await fetch('/api/notion/query?id=' + encodeURIComponent(notionImportState.databaseId));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('Server responded ' + r.status));
    notionImportState.parsed = data.rows.map((row, i) => {
      const ap = notionRowToApplicant(row.properties, notionImportState.mapping);
      ap.rowNo = i + 1;
      ap.notionPageId = row.pageId;
      ap.issues = ap.handle ? [] : ['no Instagram / TikTok match — cannot match a creator'];
      return ap;
    });
    renderNotionImportStep3();
  } catch (err) {
    $('#niResult').innerHTML = `<div class="note warn"><strong>Could not read submissions.</strong> ${esc(err.message)}</div>`;
  }
}

export function renderNotionImportStep3() {
  const st = notionImportState;
  const withIssues = st.parsed.filter((r) => r.issues.length);
  const unmatched = st.parsed.filter((r) => !r.handle).length;
  const byStage = {};
  st.parsed.forEach((r) => { byStage[r.stage] = (byStage[r.stage] || 0) + 1; });

  const base = st.schema.title || 'Notion campaign';
  const brandGuess = base.split(/\s*[xX×]\s*/).map((s) => s.trim()).filter((s) => s && !/^vively$/i.test(s))[0] || base;

  $('#niResult').innerHTML = `
    <div class="grid g4" style="gap:10px;margin-bottom:16px">
      ${statCard('Rows read', st.parsed.length, { foot: 'from Notion' })}
      ${statCard('Matched to a handle', st.parsed.length - unmatched, { foot: unmatched ? unmatched + ' unmatched' : 'all matched' })}
      ${statCard('Rows to check', withIssues.length, { foot: withIssues.length ? 'see below' : 'clean' })}
    </div>

    <div class="sec-title" style="margin-top:6px">1 · Campaign details <span style="text-transform:none;letter-spacing:0;color:var(--text-3)">— entered by hand</span></div>
    <div class="grid g2" style="gap:10px">
      <div class="field"><label>Brand / client</label><input type="text" id="niBrand" value="${esc(brandGuess)}"/></div>
      <div class="field"><label>Project name</label><input type="text" id="niName" value="${esc(base)}"/></div>
      <div class="field"><label>Campaign type</label><select id="niKind">${
        ['Seeding', 'Store visit', 'Paid collab', 'Product launch', 'Market validation']
          .map((k) => `<option ${k === 'Seeding' ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
      <div class="field"><label>Category</label><select id="niCat">${CATEGORIES.map((k) => `<option>${k}</option>`).join('')}</select></div>
      <div class="field"><label>Market</label><select id="niMarket">${['Korea', ...COUNTRIES.filter((c) => c !== 'Korea')].map((k) => `<option>${k}</option>`).join('')}</select></div>
      <div class="field"><label>Status</label><select id="niStatus">${Object.entries(CAMPAIGN_STATUS).map(([k, v]) => `<option value="${k}" ${k === 'production' ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
      <div class="field"><label>Start</label><input type="date" id="niStart" value="${iso(TODAY)}"/></div>
      <div class="field"><label>End</label><input type="date" id="niEnd" value="${iso(addDays(TODAY, 35))}"/></div>
      <div class="field"><label>Target creators</label><input type="number" id="niTarget" value="${Math.max(10, st.parsed.length || 30)}"/></div>
      <div class="field"><label>Product cost / creator (₩)</label><input type="number" id="niCost" value="45000"/></div>
      <div class="field full" style="grid-column:1/-1"><label>Deliverables</label><input type="text" id="niDeliv" value="1 Reel + 2 Stories"/></div>
    </div>
    <div class="field"><label>Campaign note — the message generator writes from this${st.schema.description ? ' <span style="text-transform:none;letter-spacing:0;color:var(--text-3)">— prefilled from the Notion form</span>' : ''}</label>
      <textarea id="niNote" style="min-height:${st.schema.description ? '200px' : '120px'}" placeholder="What the creator gets: …&#10;What we need back: …&#10;Posting window: …&#10;Must tag @…">${esc(st.schema.description || '')}</textarea></div>

    <div class="sec-title">2 · Preview <span style="text-transform:none;letter-spacing:0;color:var(--text-3)">— ${Object.entries(byStage).map(([s, n]) => `${n} ${stageOf(s).label}`).join(' · ')}</span></div>
    ${withIssues.length ? `<div class="note warn" style="margin-bottom:12px"><strong>${withIssues.length} rows need a look.</strong> They will still import — issues are listed in the table.</div>` : ''}
    <div class="tbl-wrap" style="max-height:280px;overflow-y:auto"><table class="tbl">
      <thead><tr><th>Row</th><th>Creator</th><th>Name</th><th class="num">Followers</th><th>Notion status</th><th>Stage</th><th>Notes</th></tr></thead>
      <tbody>${st.parsed.slice(0, 200).map((r) => `<tr${r.issues.length ? ' style="background:rgba(250,178,25,.05)"' : ''}>
        <td style="color:var(--text-3)">${r.rowNo}</td>
        <td>${r.handle ? `<span class="strong">${esc(r.handle)}</span><div style="font-size:11px;color:var(--text-3)">${esc(r.platform)}</div>` : '<span style="color:#f08a8a">—</span>'}</td>
        <td>${esc(r.fullName)}</td>
        <td class="num">${r.followers ? num(r.followers) : '—'}</td>
        <td><span class="tag">${esc(r.statusRaw || '(blank)')}</span></td>
        <td>${stagePill(r.stage)}</td>
        <td style="font-size:11.5px;color:#f5c451">${r.issues.map(esc).join('; ')}</td></tr>`).join('')}</tbody></table></div>
    ${st.parsed.length > 200 ? `<div style="font-size:12px;color:var(--text-3);margin-top:6px">Showing the first 200 of ${st.parsed.length} rows. All of them will import.</div>` : ''}

    <div class="divider"></div>
    <label style="display:flex;align-items:center;gap:9px;text-transform:none;letter-spacing:0;font-size:13px;color:var(--text-2);margin-bottom:6px">
      <input type="checkbox" id="niMerge" checked/> Match creators already in the database by handle instead of creating duplicates
    </label>
    <label style="display:flex;align-items:center;gap:9px;text-transform:none;letter-spacing:0;font-size:13px;color:var(--text-2);margin-bottom:16px">
      <input type="checkbox" id="niSkipBlocked" checked/> Skip blacklisted creators
    </label>
    <div style="display:flex;gap:8px">
      <button class="btn primary" id="niGo">Create campaign with ${st.parsed.length} creators</button>
      <button class="btn" onclick="closeDrawer()">Cancel</button>
    </div>`;

  $('#niGo').addEventListener('click', commitNotionImport);
}

export function commitNotionImport() {
  const st = notionImportState;
  const merge = $('#niMerge').checked;
  const skipBlocked = $('#niSkipBlocked').checked;

  const id = newId('cp');
  const cost = +$('#niCost').value || 0;
  const target = +$('#niTarget').value || 30;
  const cp = {
    id,
    brand: $('#niBrand').value.trim() || 'Untitled brand',
    name: $('#niName').value.trim() || 'Notion campaign',
    kind: $('#niKind').value, category: $('#niCat').value, market: $('#niMarket').value,
    status: $('#niStatus').value,
    start: $('#niStart').value, end: $('#niEnd').value,
    targetCreators: target, minFollowers: 0,
    platforms: ['Instagram', 'TikTok'],
    deliverables: $('#niDeliv').value,
    budget: cost * target,
    productCostPer: cost, adSpend: 0,
    hashtags: ['#vively'], owner: 'Kunzang',
    note: $('#niNote').value,
    createdAt: iso(TODAY),
    fulfilment: 'delivery',
    /* saved so the roster tab's "Sync from Notion" button keeps this
       campaign current later, without asking for the link/mapping again */
    notionDatabaseId: st.databaseId,
    notionMapping: st.mapping,
    notionDescription: st.schema.description || '',
    notionSyncedAt: new Date().toISOString()
  };

  let created = 0, matched = 0, skipped = 0;
  st.parsed.forEach((r) => {
    if (!r.handle) { skipped++; return; }
    let cr = merge ? findCreatorByHandle(r.handle) : null;

    if (cr && skipBlocked && cr.flag === 'blocked') { skipped++; return; }

    if (!cr) {
      const crId = newId('nt');
      cr = {
        id: crId, handle: r.handle, name: r.fullName || r.handle,
        platform: r.platform, followers: r.followers,
        er: 0, avgViews: Math.round(r.followers * 0.6),
        categories: [cp.category], country: countryOf(r.nationality),
        nationality: r.nationality, languages: ['EN'],
        tier: tierOf(r.followers).id, source: 'Notion form',
        rate: 0, reliability: null, avgTurnaroundDays: null,
        campaignsDone: 0, lastWorked: null,
        email: r.email || '', contact: r.contact, address: r.address,
        tags: [], notes: '', flag: null, flagReason: '', flagAt: null,
        campaignIds: [], contentCount: 0, totalViews: 0, bestViews: 0
      };
      DB.creators.push(cr); byCreator[crId] = cr; created++;
    } else {
      matched++;
      if (r.followers && !cr.followers) cr.followers = r.followers;
      if (r.email && !cr.email) cr.email = r.email;
      if (r.contact && !cr.contact) cr.contact = r.contact;
      if (r.address && !cr.address) cr.address = r.address;
      if (r.nationality && !cr.nationality) cr.nationality = r.nationality;
    }

    const p = {
      id: cp.id + '-' + cr.id, campaignId: cp.id, creatorId: cr.id,
      stage: r.stage, source: 'Notion form', fee: 0,
      contactedAt: STAGE_IDX[r.stage] >= 1 ? cp.start : null,
      repliedAt: STAGE_IDX[r.stage] >= 2 && r.stage !== 'dropped' ? cp.start : null,
      confirmedAt: STAGE_IDX[r.stage] >= 4 && r.stage !== 'dropped' ? cp.start : null,
      shippedAt: STAGE_IDX[r.stage] >= 5 && r.stage !== 'dropped' ? cp.start : null,
      dropReason: r.dropReason, revisions: 0, note: r.note || '',
      fullName: r.fullName, address: r.address, contact: r.contact,
      nationality: r.nationality, otherSns: r.otherSns,
      visitAt: r.visitAt || '', arrivingDate: '', importedStatus: r.statusRaw,
      notionPageId: r.notionPageId, content: null
    };
    if (r.contentUrl) {
      p.content = {
        url: r.contentUrl, platform: r.platform, format: 'Reel', postedAt: iso(TODAY), submittedAt: iso(TODAY),
        views: 0, paidViews: 0, organicViews: 0, likes: 0, comments: 0, shares: 0, saves: 0,
        reach: 0, profileVisits: 0, followsGained: 0, linkClicks: 0,
        curve: [], boosted: false, viral: false, topCountries: [], thumbTint: avColor(cr.handle)
      };
    }
    DB.participants.push(p);
  });

  byCampaign[id] = cp;
  DB.campaigns.push(cp);

  /* never leave the database with two rows for the same person */
  const dedupe = mergeDuplicateCreators();
  closeDrawer();
  location.hash = '#/campaigns/' + id + '/roster';
  const summary = `Created “${cp.name}” from Notion — ${created + matched} creators (${created} new, ${matched} matched)${skipped ? ', ' + skipped + ' skipped' : ''}` +
    (dedupe.mergedCreators ? `, ${dedupe.mergedCreators} duplicate${dedupe.mergedCreators === 1 ? '' : 's'} merged` : '');
  toast(summary);
  serverSave({ force: true, silent: true }).then(() =>
    toast(SERVER.status === 'idle' ? summary + ' — saved' : summary + ' — click Save to store it on the server'));
}
