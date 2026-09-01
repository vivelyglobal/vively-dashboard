import { IMPORT_FIELDS, TEMPLATES, countryOf, detectTemplate, guessField, parseImportRows } from '../import/excel.js';
import { parseCsvText } from '../lib/csv.js';
import { TODAY, addDays, iso } from '../lib/dates.js';
import { num } from '../lib/format.js';
import { downloadXlsx, readXlsx } from '../lib/xlsx.js';
import { findCreatorByHandle, mergeDuplicateCreators } from '../model/creators.js';
import { DB, SERVER, byCampaign, byCreator, serverSave } from '../model/db.js';
import { CAMPAIGN_STATUS, CATEGORIES, COUNTRIES, STAGE_IDX, avColor, newId, stageOf, tierOf } from '../model/vocab.js';
import { $, $$, esc } from '../ui/dom.js';
import { stagePill, statCard } from '../ui/html.js';
import { closeDrawer, openDrawer, toast } from '../ui/overlay.js';

/* --------------------------------- wizard --------------------------------- */
export let importState = null;
window.__importState = () => importState;

export function openImportWizard() {
  importState = { file: null, sheets: [], sheetIdx: 0, headers: [], rows: [], mapping: {}, parsed: [], template: 'delivery' };
  openDrawer('Import a campaign from Excel', importWizardHtml(), true);
  wireImportStep1();
}

export function importWizardHtml() {
  return `
    <div class="note" style="margin-bottom:16px;">
      Upload one of the VIVELY creator sheets. The influencer rows are read automatically —
      you still enter the project name, type and budget by hand below.
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn xs" onclick="downloadTemplate('delivery')">Blank delivery template</button>
        <button class="btn xs" onclick="downloadTemplate('visit')">Blank 방문 template</button>
      </div>
    </div>

    <div class="dz" id="impDrop">
      <div><strong>Click or drop an .xlsx / .csv file</strong></div>
      <div style="margin-top:4px;font-size:12px;color:var(--text-3)">e.g. “VIVELY x JAIMDANG.xlsx”</div>
      <input type="file" id="impFile" accept=".xlsx,.csv" style="display:none"/>
    </div>
    <div id="impResult" style="margin-top:18px"></div>`;
}

export function wireImportStep1() {
  const dz = $('#impDrop'), input = $('#impFile');
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); if (e.dataTransfer.files[0]) loadImportFile(e.dataTransfer.files[0]); });
  input.addEventListener('change', () => { if (input.files[0]) loadImportFile(input.files[0]); });
}

export async function loadImportFile(file) {
  const res = $('#impResult');
  res.innerHTML = `<div class="empty">Reading ${esc(file.name)}…</div>`;
  try {
    importState.file = file;
    if (/\.csv$/i.test(file.name)) {
      const text = await file.text();
      importState.sheets = [{ name: 'CSV', rows: parseCsvText(text) }];
    } else {
      const wb = await readXlsx(file);
      importState.sheets = wb.sheets.filter((s) => s.rows.length > 1);
      if (!importState.sheets.length) throw new Error('No rows found in that workbook.');
    }
    /* pick the sheet with the most rows — the creator list, not the Report tab */
    importState.sheetIdx = importState.sheets.reduce((best, s, i, arr) => (s.rows.length > arr[best].rows.length ? i : best), 0);
    applySheet();
  } catch (err) {
    res.innerHTML = `<div class="note warn"><strong>Could not read that file.</strong> ${esc(err.message)}</div>`;
  }
}

export function applySheet() {
  const sheet = importState.sheets[importState.sheetIdx];
  const rows = sheet.rows;
  importState.headers = rows[0] || [];
  importState.rows = rows.slice(1);

  const mapping = {};
  importState.headers.forEach((h, i) => {
    const samples = importState.rows.slice(0, 20).map((r) => r[i]).filter((x) => x != null && x !== '');
    mapping[i] = guessField(h, i, samples);
  });
  /* never map two columns to the same field */
  const seen = new Set();
  Object.keys(mapping).forEach((k) => {
    if (mapping[k] !== 'skip' && seen.has(mapping[k])) mapping[k] = 'skip';
    else if (mapping[k] !== 'skip') seen.add(mapping[k]);
  });
  importState.mapping = mapping;
  importState.template = detectTemplate(mapping);
  renderImportStep2();
}

export function renderImportStep2() {
  const st = importState;
  st.parsed = parseImportRows(st.rows, st.mapping);
  const tpl = TEMPLATES[st.template];
  const withIssues = st.parsed.filter((r) => r.issues.length);
  const unmatched = st.parsed.filter((r) => !r.handle).length;
  const byStage = {};
  st.parsed.forEach((r) => { byStage[r.stage] = (byStage[r.stage] || 0) + 1; });

  const base = (st.file.name || '').replace(/\.(xlsx|csv)$/i, '');
  const brandGuess = base.split(/\s*[xX×]\s*/).map((s) => s.trim()).filter((s) => s && !/^vively$/i.test(s))[0] || base;

  $('#impResult').innerHTML = `
    <div class="grid g4" style="gap:10px;margin-bottom:16px">
      ${statCard('Rows read', st.parsed.length, { foot: esc(st.sheets[st.sheetIdx].name) })}
      ${statCard('Matched to a handle', st.parsed.length - unmatched, { foot: unmatched ? unmatched + ' unmatched' : 'all matched' })}
      ${statCard('Template', tpl.id === 'delivery' ? 'Delivery' : '방문 Visit', { foot: 'auto-detected' })}
      ${statCard('Rows to check', withIssues.length, { foot: withIssues.length ? 'see below' : 'clean' })}
    </div>

    ${st.sheets.length > 1 ? `<div class="field"><label>Sheet</label><select id="impSheet">${
      st.sheets.map((s, i) => `<option value="${i}" ${i === st.sheetIdx ? 'selected' : ''}>${esc(s.name)} — ${s.rows.length - 1} rows</option>`).join('')}</select></div>` : ''}

    <div class="sec-title" style="margin-top:6px">1 · Campaign details <span style="text-transform:none;letter-spacing:0;color:var(--text-3)">— entered by hand</span></div>
    <div class="grid g2" style="gap:10px">
      <div class="field"><label>Brand / client</label><input type="text" id="impBrand" value="${esc(brandGuess)}"/></div>
      <div class="field"><label>Project name</label><input type="text" id="impName" value="${esc(base)}"/></div>
      <div class="field"><label>Campaign type</label><select id="impKind">${
        ['Seeding', 'Store visit', 'Paid collab', 'Product launch', 'Market validation']
          .map((k) => `<option ${((st.template === 'visit' && k === 'Store visit') || (st.template === 'delivery' && k === 'Seeding')) ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
      <div class="field"><label>Category</label><select id="impCat">${CATEGORIES.map((k) => `<option>${k}</option>`).join('')}</select></div>
      <div class="field"><label>Market</label><select id="impMarket">${['Korea', ...COUNTRIES.filter((c) => c !== 'Korea')].map((k) => `<option>${k}</option>`).join('')}</select></div>
      <div class="field"><label>Status</label><select id="impStatus">${Object.entries(CAMPAIGN_STATUS).map(([k, v]) => `<option value="${k}" ${k === 'production' ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
      <div class="field"><label>Start</label><input type="date" id="impStart" value="${iso(TODAY)}"/></div>
      <div class="field"><label>End</label><input type="date" id="impEnd" value="${iso(addDays(TODAY, 35))}"/></div>
      <div class="field"><label>Target creators</label><input type="number" id="impTarget" value="${Math.max(10, st.parsed.filter((r) => r.stage !== 'dropped' && STAGE_IDX[r.stage] >= 4).length || 30)}"/></div>
      <div class="field"><label>${st.template === 'visit' ? 'Cost per visit (₩)' : 'Product cost / creator (₩)'}</label><input type="number" id="impCost" value="45000"/></div>
      <div class="field full" style="grid-column:1/-1"><label>Deliverables</label><input type="text" id="impDeliv" value="1 Reel + 2 Stories"/></div>
    </div>
    <div class="field"><label>Campaign note — the message generator writes from this</label>
      <textarea id="impNote" style="min-height:120px" placeholder="What the creator gets: …&#10;What we need back: …&#10;Posting window: …&#10;Must tag @…"></textarea></div>

    <div class="sec-title">2 · Column mapping <span style="text-transform:none;letter-spacing:0;color:var(--text-3)">— change anything the guess got wrong</span></div>
    <div class="tbl-wrap" style="max-height:230px;overflow-y:auto"><table class="tbl">
      <thead><tr><th>Column in your sheet</th><th>Sample</th><th style="width:210px">Maps to</th></tr></thead>
      <tbody>${st.headers.map((h, i) => {
        const sample = st.rows.map((r) => r[i]).find((x) => x != null && x !== '');
        return `<tr><td class="strong">${esc(h || '(no header)')}</td>
          <td style="color:var(--text-3);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(String(sample == null ? '' : sample instanceof Date ? sample.toISOString().slice(0, 16).replace('T', ' ') : sample).slice(0, 50))}</td>
          <td><select class="impMap" data-ci="${i}" style="padding:5px 8px;font-size:12px">${
            IMPORT_FIELDS.map((f) => `<option value="${f.key}" ${st.mapping[i] === f.key ? 'selected' : ''}>${f.label}</option>`).join('')}</select></td></tr>`;
      }).join('')}</tbody></table></div>

    <div class="sec-title">3 · Preview <span style="text-transform:none;letter-spacing:0;color:var(--text-3)">— ${Object.entries(byStage).map(([s, n]) => `${n} ${stageOf(s).label}`).join(' · ')}</span></div>
    ${withIssues.length ? `<div class="note warn" style="margin-bottom:12px"><strong>${withIssues.length} rows need a look.</strong> They will still import — issues are listed in the table.</div>` : ''}
    <div class="tbl-wrap" style="max-height:280px;overflow-y:auto"><table class="tbl">
      <thead><tr><th>Row</th><th>Creator</th><th>Name</th><th class="num">Followers</th><th>Sheet status</th><th>Stage</th><th>${st.template === 'visit' ? 'Visit slot' : 'Address'}</th><th>Notes</th></tr></thead>
      <tbody>${st.parsed.slice(0, 200).map((r) => `<tr${r.issues.length ? ' style="background:rgba(250,178,25,.05)"' : ''}>
        <td style="color:var(--text-3)">${r.rowNo}</td>
        <td>${r.handle ? `<span class="strong">${esc(r.handle)}</span><div style="font-size:11px;color:var(--text-3)">${esc(r.platform)}</div>` : '<span style="color:#f08a8a">—</span>'}</td>
        <td>${esc(r.fullName)}</td>
        <td class="num">${r.followers ? num(r.followers) : '—'}</td>
        <td><span class="tag">${esc(r.statusRaw || '(blank)')}</span></td>
        <td>${stagePill(r.stage)}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-3)">${
          st.template === 'visit' ? (r.visitAt ? esc(r.visitAt.toISOString().slice(0, 16).replace('T', ' ')) : '—') : esc(r.address || '—')}</td>
        <td style="font-size:11.5px;color:#f5c451">${r.issues.map(esc).join('; ')}</td></tr>`).join('')}</tbody></table></div>
    ${st.parsed.length > 200 ? `<div style="font-size:12px;color:var(--text-3);margin-top:6px">Showing the first 200 of ${st.parsed.length} rows. All of them will import.</div>` : ''}

    <div class="divider"></div>
    <label style="display:flex;align-items:center;gap:9px;text-transform:none;letter-spacing:0;font-size:13px;color:var(--text-2);margin-bottom:6px">
      <input type="checkbox" id="impMerge" checked/> Match creators already in the database by handle instead of creating duplicates
    </label>
    <label style="display:flex;align-items:center;gap:9px;text-transform:none;letter-spacing:0;font-size:13px;color:var(--text-2);margin-bottom:16px">
      <input type="checkbox" id="impSkipBlocked" checked/> Skip blacklisted creators
    </label>
    <div style="display:flex;gap:8px">
      <button class="btn primary" id="impGo">Create campaign with ${st.parsed.length} creators</button>
      <button class="btn" onclick="closeDrawer()">Cancel</button>
    </div>`;

  $$('.impMap').forEach((sel) => sel.addEventListener('change', () => {
    const ci = sel.dataset.ci, val = sel.value;
    if (val !== 'skip') Object.keys(importState.mapping).forEach((k) => { if (k !== ci && importState.mapping[k] === val) importState.mapping[k] = 'skip'; });
    importState.mapping[ci] = val;
    importState.template = detectTemplate(importState.mapping);
    renderImportStep2();
  }));
  const sheetSel = $('#impSheet');
  if (sheetSel) sheetSel.addEventListener('change', () => { importState.sheetIdx = +sheetSel.value; applySheet(); });
  $('#impGo').addEventListener('click', commitImport);
}

export function commitImport() {
  const st = importState;
  const merge = $('#impMerge').checked;
  const skipBlocked = $('#impSkipBlocked').checked;
  const template = st.template;

  const id = newId('cp');
  const cost = +$('#impCost').value || 0;
  const target = +$('#impTarget').value || 30;
  const cp = {
    id,
    brand: $('#impBrand').value.trim() || 'Untitled brand',
    name: $('#impName').value.trim() || 'Imported campaign',
    kind: $('#impKind').value, category: $('#impCat').value, market: $('#impMarket').value,
    status: $('#impStatus').value,
    start: $('#impStart').value, end: $('#impEnd').value,
    targetCreators: target, minFollowers: 0,
    platforms: ['Instagram', 'TikTok'],
    deliverables: $('#impDeliv').value,
    budget: cost * target,
    productCostPer: cost, adSpend: 0,
    hashtags: ['#vively'], owner: 'Kunzang',
    note: $('#impNote').value,
    createdAt: iso(TODAY),
    fulfilment: template,                 /* delivery | visit */
    importedFrom: st.file.name
  };

  let created = 0, matched = 0, skipped = 0;
  st.parsed.forEach((r) => {
    if (!r.handle) { skipped++; return; }
    let cr = merge ? findCreatorByHandle(r.handle) : null;

    if (cr && skipBlocked && cr.flag === 'blocked') { skipped++; return; }

    if (!cr) {
      const crId = newId('im');
      cr = {
        id: crId, handle: r.handle, name: r.fullName || r.handle,
        platform: r.platform, followers: r.followers,
        er: 0, avgViews: Math.round(r.followers * 0.6),
        categories: [cp.category], country: countryOf(r.nationality),
        nationality: r.nationality, languages: ['EN'],
        tier: tierOf(r.followers).id, source: 'Excel import',
        rate: 0, reliability: null, avgTurnaroundDays: null,
        campaignsDone: 0, lastWorked: null,
        email: '', contact: r.contact, address: r.address,
        tags: [], notes: '', flag: null, flagReason: '', flagAt: null,
        campaignIds: [], contentCount: 0, totalViews: 0, bestViews: 0
      };
      DB.creators.push(cr); byCreator[crId] = cr; created++;
    } else {
      matched++;
      if (r.followers && !cr.followers) cr.followers = r.followers;
      if (r.contact && !cr.contact) cr.contact = r.contact;
      if (r.address && !cr.address) cr.address = r.address;
      if (r.nationality && !cr.nationality) cr.nationality = r.nationality;
    }

    const p = {
      id: cp.id + '-' + cr.id, campaignId: cp.id, creatorId: cr.id,
      stage: r.stage, source: 'Excel import', fee: 0,
      contactedAt: STAGE_IDX[r.stage] >= 1 ? cp.start : null,
      repliedAt: STAGE_IDX[r.stage] >= 2 && r.stage !== 'dropped' ? cp.start : null,
      confirmedAt: STAGE_IDX[r.stage] >= 4 && r.stage !== 'dropped' ? cp.start : null,
      shippedAt: STAGE_IDX[r.stage] >= 5 && r.stage !== 'dropped' ? (r.arrivingDate ? iso(r.arrivingDate) : cp.start) : null,
      dropReason: r.dropReason, revisions: 0, note: '',
      fullName: r.fullName, address: r.address, contact: r.contact,
      nationality: r.nationality,
      visitAt: r.visitAt ? r.visitAt.toISOString().slice(0, 16).replace('T', ' ') : '',
      arrivingDate: r.arrivingDate ? iso(r.arrivingDate) : '',
      otherSns: r.otherSns, importedStatus: r.statusRaw,
      content: null
    };
    if (r.contentUrl) {
      p.content = {
        url: r.contentUrl, platform: r.platform, format: 'Reel',
        postedAt: r.arrivingDate ? iso(r.arrivingDate) : iso(TODAY), submittedAt: iso(TODAY),
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
  const summary = `Imported ${created + matched} creators — ${created} new, ${matched} matched${skipped ? ', ' + skipped + ' skipped' : ''}` +
    (dedupe.mergedCreators ? `, ${dedupe.mergedCreators} duplicate${dedupe.mergedCreators === 1 ? '' : 's'} merged` : '');
  toast(summary);
  serverSave({ force: true, silent: true }).then(() =>
    toast(SERVER.status === 'idle' ? summary + ' — saved' : summary + ' — click Save to store it on the server'));
}

/* ---------------------------- blank templates ---------------------------- */
export function downloadTemplate(kind) {
  const tpl = TEMPLATES[kind];
  const rows = [tpl.columns];
  /* two example rows so the format is unmistakable */
  if (kind === 'delivery') {
    rows.push(['Waiting Approval', '', '', 'Jane Doe', '서울특별시 강남구 …  (우) 06134', '010-1234-5678', 'Philippines', '', 'https://www.instagram.com/janedoe', 'https://www.tiktok.com/@janedoe', '', 12500]);
    rows.push(['Uploaded', '2026-08-20', 'https://www.instagram.com/reel/XXXXXXXX/', 'Kim Minji', '경기도 성남시 …', 'kakao_id_here', 'South Korea', '', 'https://www.instagram.com/minji', '', '', 43000]);
  } else {
    rows.push([1, 'Waiting Approval', '', 'Jane Doe', '2026-08-20 19:00', 'Indonesia', 'https://www.instagram.com/janedoe', 3200, '', '']);
    rows.push([2, 'Confirmation Sent', '', 'Sato Aimi', '2026-08-21 13:30', 'Japan', 'https://www.instagram.com/aimi', 2303, 'https://www.tiktok.com/@aimi', '']);
  }
  downloadXlsx(tpl.sheetName, rows, `VIVELY_template_${kind === 'delivery' ? 'delivery' : 'visit'}.xlsx`);
}
