import { SERIES_HEX, barsH, splitBar } from '../charts/index.js';
import { TODAY, dLabel, iso } from '../lib/dates.js';
import { engagementsOf, kmb, num, pct, won } from '../lib/format.js';
import { DB, byCampaign, byCreator, notify } from '../model/db.js';
import { SETTINGS, isBlocked } from '../model/settings.js';
import { suggestScore } from '../model/suggest.js';
import { CATEGORIES, COUNTRIES, PLATFORMS } from '../model/vocab.js';
import { $, $$, esc } from '../ui/dom.js';
import { FLAGS, avatarHtml, daysAgo, downloadFile, emptyState, flagPill, sortTable, stagePill, statCard, tierPill, toCsv, whoHtml } from '../ui/html.js';
import { closeDrawer, openDrawer, toast } from '../ui/overlay.js';
import { activeCampaigns, state } from './overview.js';

/* ============================================================
   VIEW — CREATOR DATABASE
   layer 2 = saved segments · layer 3 = directory / insights
   ============================================================ */
export let creatorSort = { key: 'followers', dir: -1 };

export const CREATOR_SEGMENTS = [
  { id: 'all',       label: 'All creators',      test: () => true },
  { id: 'worked',    label: 'Worked with us',    test: (c) => c.campaignsDone > 0 },
  { id: 'prospects', label: 'Prospects',         test: (c) => c.campaignsDone === 0 },
  { id: 'repeat',    label: 'Repeat performers', test: (c) => c.campaignsDone >= 2 },
  { id: 'reliable',  label: 'Top rated',         test: (c) => c.reliability >= 4.3 },
  { id: 'preferred', label: '★ Preferred',       test: (c) => c.flag === 'preferred' },
  { id: 'caution',   label: '! Flagged',         test: (c) => c.flag === 'caution' },
  { id: 'blocked',   label: '⊘ Blacklist',       test: (c) => c.flag === 'blocked' },
  { id: 'nano',      label: 'Nano · under 15K',  test: (c) => c.tier === 'nano' },
  { id: 'micro',     label: 'Micro · 15–60K',    test: (c) => c.tier === 'micro' },
  { id: 'mid',       label: 'Mid · 60–250K',     test: (c) => c.tier === 'mid' },
  { id: 'macro',     label: 'Macro · 250K+',     test: (c) => c.tier === 'macro' }
];
export const CREATOR_TABS = [['directory', 'Directory'], ['insights', 'Insights']];

export function segmentOf(id) { return CREATOR_SEGMENTS.find((s) => s.id === id) || CREATOR_SEGMENTS[0]; }

export function filteredCreators(segId) {
  const seg = segmentOf(segId);
  const f = state.creatorFilters;
  const terms = f.q.trim() ? f.q.trim().toLowerCase().split(/\s+/) : [];
  const showBlocked = segId === 'blocked' || segId === 'all';
  return DB.creators.filter((c) => {
    if (!seg.test(c)) return false;
    if (isBlocked(c) && !showBlocked && SETTINGS.hideBlocked) return false;
    if (f.tier && c.tier !== f.tier) return false;
    if (f.cat && !c.categories.includes(f.cat)) return false;
    if (f.country && c.country !== f.country) return false;
    if (f.platform && c.platform !== f.platform) return false;
    if (!terms.length) return true;
    const hay = (c.handle + ' ' + c.name + ' ' + c.categories.join(' ') + ' ' + c.country + ' ' + c.platform + ' ' + c.tags.join(' ')).toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

export function renderCreators(view, item, tab) {
  if (!DB.creators.length) {
    view.innerHTML = emptyState('The creator database is empty',
      'Creators are added when you import a campaign sheet, or you can bring a list in on its own from <a href="#/settings/sources">Setup → Data sources</a>.',
      { icon: '◎' });
    return;
  }
  const segId = item || 'all';
  const list = filteredCreators(segId);
  if (tab === 'insights') return creatorInsights(view, list, segId);

  const f = state.creatorFilters;
  view.innerHTML = `
    <div class="card" style="margin-bottom:14px;">
      <div class="inline-fields">
        <div class="field" style="flex:2;min-width:220px"><label>Search</label>
          <input type="text" id="crQ" value="${esc(f.q)}" placeholder="handle, name, category, tag…"/></div>
        <div class="field"><label>Tier</label><select id="crTier">${optList(['nano','micro','mid','macro'], f.tier, 'Any tier')}</select></div>
        <div class="field"><label>Category</label><select id="crCat">${optList(CATEGORIES, f.cat, 'Any category')}</select></div>
        <div class="field"><label>Country</label><select id="crCountry">${optList(allCountries(), f.country, 'Any country')}</select></div>
        <div class="field"><label>Platform</label><select id="crPlatform">${optList(PLATFORMS, f.platform, 'Any platform')}</select></div>
        <button class="btn sm" id="crReset">Reset</button>
        <button class="btn sm" id="crExport">Export ${list.length}</button>
      </div>
    </div>

    <div class="card" style="padding:0">
      <div class="tbl-wrap" style="max-height:62vh;overflow-y:auto">
        <table class="tbl"><thead><tr>
          ${th('Creator', 'handle')}<th>Flag</th><th>Tier</th><th>Category</th><th>Country</th>
          ${th('Followers', 'followers', 1)}${th('ER', 'er', 1)}${th('Avg views', 'avgViews', 1)}
          ${th('Campaigns', 'campaignsDone', 1)}${th('Best post', 'bestViews', 1)}${th('Rating', 'reliability', 1)}
          <th>Last worked</th><th></th>
        </tr></thead><tbody id="crBody"></tbody></table>
      </div>
    </div>`;

  const sorted = sortTable(list, (c) => c[creatorSort.key], creatorSort.dir);
  $('#crBody').innerHTML = sorted.slice(0, 400).map((c) => `<tr class="clickable ${c.flag === 'blocked' ? 'blocked-row' : c.flag === 'preferred' ? 'preferred-row' : ''}" onclick="showCreator('${c.id}')">
      <td>${whoHtml(c, c.name)}</td>
      <td>${flagPill(c.flag) || '<span style="color:var(--text-3)">—</span>'}</td>
      <td>${tierPill(c.tier)}</td>
      <td>${c.categories.slice(0, 2).map((x) => `<span class="tag">${esc(x)}</span>`).join(' ')}</td>
      <td>${esc(c.country)}</td>
      <td class="num">${num(c.followers)}</td>
      <td class="num">${c.er}%</td>
      <td class="num">${kmb(c.avgViews)}</td>
      <td class="num">${c.campaignsDone || '—'}</td>
      <td class="num">${c.bestViews ? kmb(c.bestViews) : '—'}</td>
      <td class="num">${c.reliability ? '★ ' + c.reliability : '—'}</td>
      <td>${daysAgo(c.lastWorked)}</td>
      <td><button class="btn xs" onclick="event.stopPropagation();showCreator('${c.id}')">View</button></td>
    </tr>`).join('') || `<tr><td colspan="13"><div class="empty">No creators match those filters.</div></td></tr>`;

  const bind = (id, key) => $('#' + id).addEventListener('input', () => { state.creatorFilters[key] = $('#' + id).value; notify(); });
  bind('crQ', 'q'); bind('crTier', 'tier'); bind('crCat', 'cat'); bind('crCountry', 'country'); bind('crPlatform', 'platform');
  $('#crReset').addEventListener('click', () => { state.creatorFilters = { q: '', tier: '', cat: '', country: '', platform: '', worked: '' }; notify(); });
  $('#crExport').addEventListener('click', () => {
    downloadFile(toCsv(['handle','name','platform','followers','er','avg_views','tier','categories','country','languages','source','rate_krw','campaigns','best_views','rating','last_worked','tags','email','flag','flag_reason'],
      sorted.map((c) => [c.handle, c.name, c.platform, c.followers, c.er, c.avgViews, c.tier, c.categories.join('|'), c.country, c.languages.join('|'),
        c.source, c.rate, c.campaignsDone, c.bestViews, c.reliability || '', c.lastWorked || '', c.tags.join('|'), c.email, c.flag || '', c.flagReason || ''])),
      `vively-creators-${segId}.csv`, 'text/csv;charset=utf-8');
  });
  $$('th.sortable').forEach((h) => h.addEventListener('click', () => {
    const k = h.dataset.k;
    creatorSort = { key: k, dir: creatorSort.key === k ? -creatorSort.dir : -1 };
    notify();
  }));
}

export function creatorInsights(view, list, segId) {
  const worked = list.filter((c) => c.campaignsDone);
  view.innerHTML = `
    <div class="grid g4" style="margin-bottom:16px;">
      ${statCard('In this segment', num(list.length), { foot: `${num(worked.length)} have worked with us` })}
      ${statCard('Median ER', pct(median(list.map((c) => c.er)) / 100), { foot: 'engagement rate' })}
      ${statCard('Median followers', kmb(median(list.map((c) => c.followers))), { foot: 'audience size' })}
      ${statCard('Content on file', num(list.reduce((a, c) => a + c.contentCount, 0)), { foot: 'posts with metrics' })}
    </div>
    <div class="grid g3">
      <div class="card"><div class="card-head"><h3>By tier</h3></div><div id="ciTier" style="margin-top:12px"></div></div>
      <div class="card"><div class="card-head"><h3>By platform</h3></div><div id="ciPlat" style="margin-top:12px"></div></div>
      <div class="card"><div class="card-head"><h3>By country</h3></div><div id="ciCountry" style="margin-top:12px"></div></div>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><div class="card-head"><h3>Top categories</h3></div><p class="card-sub">Creators can sit in more than one.</p><div id="ciCat"></div></div>
      <div class="card"><div class="card-head"><h3>Best performers in this segment</h3></div><p class="card-sub">By best single post.</p><div class="tbl-wrap" id="ciTop" style="margin-top:8px"></div></div>
    </div>`;

  splitBar($('#ciTier'), ['nano', 'micro', 'mid', 'macro'].map((t, i) => ({
    label: t[0].toUpperCase() + t.slice(1), color: SERIES_HEX[[0, 2, 4, 3][i]], value: list.filter((c) => c.tier === t).length
  })).filter((x) => x.value));
  splitBar($('#ciPlat'), PLATFORMS.map((p, i) => ({ label: p, color: SERIES_HEX[i], value: list.filter((c) => c.platform === p).length })).filter((x) => x.value));
  const byCountry = COUNTRIES.map((k, i) => ({ label: k, color: SERIES_HEX[i % 7], value: list.filter((c) => c.country === k).length }))
    .filter((x) => x.value).sort((a, b) => b.value - a.value).slice(0, 5);
  splitBar($('#ciCountry'), byCountry);

  barsH($('#ciCat'), CATEGORIES.map((k) => ({ label: k, value: list.filter((c) => c.categories.includes(k)).length, color: 'var(--s1)' }))
    .sort((a, b) => b.value - a.value).slice(0, 8), { labelHead: 'Category', valueHead: 'Creators', format: num, barH: 16 });

  const top = worked.slice().sort((a, b) => b.bestViews - a.bestViews).slice(0, 8);
  $('#ciTop').innerHTML = top.length ? `<table class="tbl"><thead><tr><th>Creator</th><th class="num">Best post</th><th class="num">Campaigns</th><th class="num">Rating</th></tr></thead>
    <tbody>${top.map((c) => `<tr class="clickable" onclick="showCreator('${c.id}')"><td>${whoHtml(c, c.name)}</td>
      <td class="num">${kmb(c.bestViews)}</td><td class="num">${c.campaignsDone}</td><td class="num">${c.reliability ? '★ ' + c.reliability : '—'}</td></tr>`).join('')}</tbody></table>`
    : `<div class="empty">Nobody in this segment has published yet.</div>`;
}

export function th(label, key, isNum) {
  const on = creatorSort.key === key;
  return `<th class="sortable${isNum ? ' num' : ''}" data-k="${key}">${label}${on ? ` <span class="sort-ind">${creatorSort.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`;
}
export function optList(arr, val, any) {
  return `<option value="">${any}</option>` + arr.map((a) => `<option value="${a}" ${val === a ? 'selected' : ''}>${a[0].toUpperCase() + a.slice(1)}</option>`).join('');
}
export function allCountries() { return [...new Set(DB.creators.map((c) => c.country).filter(Boolean))].sort(); }
export function median(a) { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; }

export function showCreator(id) {
  const c = byCreator[id];
  if (!c) return;
  const ps = DB.participants.filter((p) => p.creatorId === id);
  const live = ps.filter((p) => p.stage === 'live' && p.content);

  openDrawer(`${avatarHtml(c.handle)} <span style="margin-left:8px">${esc(c.handle)}</span>`, `
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;">
      ${tierPill(c.tier)}<span class="pill grey">${esc(c.platform)}</span><span class="pill grey">${esc(c.country)}</span>
      ${c.categories.map((x) => `<span class="pill blue">${esc(x)}</span>`).join('')}
      ${c.tags.map((t) => `<span class="pill grey">${esc(t)}</span>`).join('')}
      ${flagPill(c.flag)}
    </div>
    ${c.flag && c.flagReason ? `<div class="note ${c.flag === 'blocked' ? 'warn' : ''}" style="margin-bottom:16px">
      <strong>${FLAGS[c.flag].label}${c.flagAt ? ' · ' + c.flagAt : ''}:</strong> ${esc(c.flagReason)}</div>` : ''}

    <div class="grid g3" style="gap:10px;margin-bottom:18px;">
      <div class="card tight stat"><div class="label">Followers</div><div class="value" style="font-size:22px">${kmb(c.followers)}</div></div>
      <div class="card tight stat"><div class="label">ER</div><div class="value" style="font-size:22px">${c.er}%</div></div>
      <div class="card tight stat"><div class="label">Avg views</div><div class="value" style="font-size:22px">${kmb(c.avgViews)}</div></div>
    </div>

    <dl class="kv" style="margin-bottom:18px">
      <dt>Name</dt><dd>${esc(c.name)}</dd>
      <dt>Languages</dt><dd>${c.languages.join(', ')}</dd>
      <dt>Found via</dt><dd>${esc(c.source)}</dd>
      <dt>Typical rate</dt><dd>${won(c.rate)}</dd>
      <dt>Reliability</dt><dd>${c.reliability ? '★ ' + c.reliability + ' / 5' : 'not rated yet'}</dd>
      <dt>Turnaround</dt><dd>${c.avgTurnaroundDays ? c.avgTurnaroundDays + ' days avg' : '—'}</dd>
      <dt>Contact</dt><dd>${esc(c.email || c.contact || '—')}</dd>
      ${c.address ? `<dt>Address</dt><dd style="white-space:pre-wrap">${esc(c.address)}</dd>` : ''}
      ${c.nationality ? `<dt>Nationality</dt><dd>${esc(c.nationality)}</dd>` : ''}
      <dt>Last worked</dt><dd>${c.lastWorked || 'never'} <span style="color:var(--text-3)">${daysAgo(c.lastWorked)}</span></dd>
    </dl>

    <div class="lbl">Campaign history (${ps.length})</div>
    <div class="tbl-wrap" style="margin-bottom:18px"><table class="tbl">
      <thead><tr><th>Campaign</th><th>Stage</th><th class="num">Views</th><th class="num">ER</th></tr></thead>
      <tbody>${ps.map((p) => {
        const cp = byCampaign[p.campaignId], ct = p.content;
        return `<tr><td><a href="#/campaigns/${cp.id}/roster" onclick="closeDrawer()">${esc(cp.brand)}</a><div style="font-size:11px;color:var(--text-3)">${dLabel(cp.start)}</div></td>
          <td>${stagePill(p.stage)}</td><td class="num">${ct && ct.views ? num(ct.views) : '—'}</td>
          <td class="num">${ct && ct.views ? pct(engagementsOf(ct) / ct.views) : '—'}</td></tr>`;
      }).join('') || `<tr><td colspan="4"><div class="empty">No campaigns yet.</div></td></tr>`}</tbody></table></div>

    <div class="lbl">Content archive (${live.length})</div>
    <div class="grid g2" style="gap:10px;margin-bottom:18px">
      ${live.map((p) => {
        const ct = p.content, cp = byCampaign[p.campaignId];
        return `<div class="card tight">
          <div style="aspect-ratio:16/10;border-radius:6px;background:linear-gradient(140deg, ${ct.thumbTint}33, ${ct.thumbTint}11);display:grid;place-items:center;color:${ct.thumbTint};margin-bottom:8px;">▶</div>
          <div style="font-size:12px;font-weight:500">${esc(cp.brand)}</div>
          <div style="font-size:11px;color:var(--text-3);margin-bottom:6px">${esc(ct.format)} · ${ct.postedAt ? dLabel(ct.postedAt) : ''}</div>
          <div style="font-size:12px">${num(ct.views)} views · ${pct(engagementsOf(ct) / (ct.views || 1))}</div>
          <a href="${ct.url}" target="_blank" rel="noopener" style="font-size:11.5px">open post</a>
        </div>`;
      }).join('') || `<div class="empty" style="grid-column:1/-1">No published content on file.</div>`}
    </div>

    <div class="divider"></div>
    <div class="lbl">Flag this creator</div>
    <div class="chips" id="crFlags" style="margin-bottom:10px">
      <button class="chip ${!c.flag ? 'on' : ''}" data-f="">No flag</button>
      ${Object.entries(FLAGS).map(([k, f]) => `<button class="chip ${c.flag === k ? 'on' : ''}" data-f="${k}" title="${esc(f.desc)}">${f.icon} ${f.label}</button>`).join('')}
    </div>
    <div class="field"><label>Reason (shown to anyone who opens this creator)</label>
      <textarea id="crFlagReason" style="min-height:60px" placeholder="Why is this creator flagged?">${esc(c.flagReason || '')}</textarea></div>

    <div class="field"><label>Notes</label><textarea id="crNote" style="min-height:60px">${esc(c.notes)}</textarea></div>
    <div style="display:flex;gap:8px">
      <button class="btn primary sm" id="crSaveNote">Save</button>
      <button class="btn sm" id="crAddTo">Add to a campaign</button>
    </div>
  `);
  let pendingFlag = c.flag;
  $$('#crFlags .chip').forEach((b) => b.addEventListener('click', () => {
    $$('#crFlags .chip').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); pendingFlag = b.dataset.f || null;
  }));
  $('#crSaveNote').addEventListener('click', () => {
    c.notes = $('#crNote').value;
    const reason = $('#crFlagReason').value.trim();
    if (pendingFlag !== c.flag) { c.flag = pendingFlag; c.flagAt = pendingFlag ? iso(TODAY) : null; }
    c.flagReason = pendingFlag ? reason : '';
    toast(pendingFlag ? FLAGS[pendingFlag].label + ' saved' : 'Saved');
    closeDrawer(); notify();
  });
  $('#crAddTo').addEventListener('click', () => {
    if (isBlocked(c)) { toast('This creator is blacklisted — remove the flag first'); return; }
    const opts = activeCampaigns().filter((cp) => !DB.participants.some((p) => p.campaignId === cp.id && p.creatorId === c.id));
    openDrawer('Add ' + esc(c.handle) + ' to a campaign', `
      <div class="field"><label>Campaign</label><select id="atCp">${opts.map((cp) => `<option value="${cp.id}">${esc(cp.brand)} — ${esc(cp.name)} (fit ${suggestScore(c, cp).score})</option>`).join('')}</select></div>
      <button class="btn primary" id="atGo">Add as Sourced</button>`);
    $('#atGo').addEventListener('click', () => {
      const cpId = $('#atCp').value;
      if (DB.participants.some((p) => p.campaignId === cpId && p.creatorId === c.id)) { toast('Already on that campaign'); return; }
      DB.participants.push({ id: cpId + '-' + c.id, campaignId: cpId, creatorId: c.id, stage: 'sourced', source: c.source,
        fee: 0, contactedAt: null, repliedAt: null, confirmedAt: null, shippedAt: null, dropReason: null, revisions: 0, content: null, note: '' });
      closeDrawer(); toast('Added'); notify();
    });
  });
}
