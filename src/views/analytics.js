import { SERIES_HEX, barsH, fitHeight, lineChart, splitBar } from '../charts/index.js';
import { engagementsOf, kmb, money2, num, pct, wonK } from '../lib/format.js';
import { DB, byCampaign, byCreator } from '../model/db.js';
import { campaignStats, dailySeries, portfolioStats, viralScore } from '../model/stats.js';
import { CONTENT_FORMATS, PLATFORMS, STAGE_IDX } from '../model/vocab.js';
import { $, esc } from '../ui/dom.js';
import { downloadFile, emptyState, statCard, toCsv, whoHtml } from '../ui/html.js';
import { costCards } from './campaigns.js';
import { rangeSeg, state, wireRange } from './overview.js';

/* ---------------------- cross-campaign analytics ---------------------- */
export const ANALYTICS_ITEMS = [
  { id: 'trend',     label: 'Portfolio trend',     sub: 'views and engagement over time' },
  { id: 'compare',   label: 'Campaign comparison', sub: 'side by side' },
  { id: 'cost',      label: 'Cost efficiency',     sub: 'CPM · CPV · CPE · CPI' },
  { id: 'breakdown', label: 'Breakdowns',          sub: 'platform · tier · organic' },
  { id: 'viral',     label: 'Viral content',       sub: 'posts that beat baseline' }
];
export const ANALYTICS_TABS = {
  trend:     [['views', 'Views'], ['engagement', 'Engagement']],
  compare:   [['views', 'By views'], ['cpm', 'By CPM'], ['er', 'By ER'], ['table', 'Full table']],
  cost:      [['summary', 'Summary'], ['campaign', 'By campaign'], ['tier', 'By tier']],
  breakdown: [['platform', 'Platform'], ['tier', 'Creator tier'], ['organic', 'Organic vs paid'], ['format', 'Format']],
  viral:     [['leaderboard', 'Leaderboard'], ['all', 'All viral posts']]
};

export function renderAnalytics(view, item, tab) {
  const all = DB.campaigns;
  if (!all.length) {
    view.innerHTML = emptyState('No analytics yet',
      'Analytics appear once a campaign has live content with view and engagement numbers on it.', { icon: '◫' });
    return;
  }
  if (!DB.participants.some((p) => p.stage === 'live' && p.content && p.content.views)) {
    view.innerHTML = emptyState('No performance data yet',
      'Your campaigns are loaded, but none of the posts have metrics attached. Add views, likes, comments, shares and saves on a creator\u2019s content card and these charts fill in.',
      { icon: '◫', actions: false });
    return;
  }
  const s = portfolioStats(all);
  const live = DB.participants.filter((p) => p.stage === 'live' && p.content);
  const withLive = all.map((cp) => ({ cp, s: campaignStats(cp) })).filter((x) => x.s.views);

  if (item === 'compare')   return anCompare(view, tab, withLive);
  if (item === 'cost')      return anCost(view, tab, s, withLive, live);
  if (item === 'breakdown') return anBreakdown(view, tab, s, live);
  if (item === 'viral')     return anViral(view, tab, live);

  /* trend */
  const ds = dailySeries(all, state.range);
  const isEng = tab === 'engagement';
  view.innerHTML = `
    <div class="grid g4" style="margin-bottom:16px;">
      ${statCard('Total views', kmb(s.views), { foot: `${num(live.length)} posts across ${all.length} campaigns` })}
      ${statCard('Total reach', kmb(s.reach), { foot: `${pct(s.organicViews / (s.views || 1), 0)} of views organic` })}
      ${statCard('Engagement rate', pct(s.er), { foot: `${kmb(s.eng)} engagements` })}
      ${statCard('Total spend', wonK(s.spend), { foot: 'product + fees + ads' })}
    </div>
    <div class="card">
      <div class="card-head"><h3>${isEng ? 'Daily engagements' : 'Daily views'}</h3><div class="sp"></div>${rangeSeg()}
        <button class="btn sm" id="anExport">Export dataset</button></div>
      <p class="card-sub">Every campaign combined.</p>
      <div id="anTrend"></div>
    </div>`;
  lineChart($('#anTrend'), {
    labels: ds.labels, height: fitHeight(430, 240),
    series: [isEng ? { name: 'Engagements', values: ds.eng, color: 'var(--s2)', area: true }
                   : { name: 'Views', values: ds.views, area: true }]
  });
  wireRange();
  $('#anExport').addEventListener('click', () => exportContentDataset(live));
}

export function exportContentDataset(live) {
  const rows = live.map((p) => {
    const cr = byCreator[p.creatorId], cp = byCampaign[p.campaignId], c = p.content;
    return [cp.brand, cp.name, cr.handle, cr.tier, cr.country, c.platform, c.format, c.postedAt, c.views, c.organicViews, c.paidViews,
            c.reach, c.likes, c.comments, c.shares, c.saves, engagementsOf(c), (engagementsOf(c) / (c.views || 1) * 100).toFixed(2) + '%', viralScore(p), c.url];
  });
  downloadFile(toCsv(['brand','campaign','handle','tier','country','platform','format','posted','views','organic_views','paid_views','reach','likes','comments','shares','saves','engagements','er','viral_score','url'], rows),
    'vively-content-dataset.csv', 'text/csv;charset=utf-8');
}

export function anCompare(view, tab, withLive) {
  if (tab === 'table') {
    view.innerHTML = `<div class="card" style="padding:0"><div class="tbl-wrap" style="max-height:calc(100vh - 190px);overflow-y:auto">
      <table class="tbl"><thead><tr><th>Campaign</th><th>Type</th><th class="num">Posts</th><th class="num">Views</th><th class="num">Reach</th>
        <th class="num">ER</th><th class="num">Spend</th><th class="num">CPM</th><th class="num">CPV</th><th class="num">Viral</th></tr></thead>
      <tbody>${withLive.sort((a, b) => b.s.views - a.s.views).map(({ cp, s }) => `<tr class="clickable" onclick="location.hash='#/campaigns/${cp.id}/performance'">
        <td class="strong">${esc(cp.brand)}</td><td style="color:var(--text-3)">${esc(cp.kind)}</td>
        <td class="num">${s.delivered}</td><td class="num">${num(s.views)}</td><td class="num">${num(s.reach)}</td>
        <td class="num">${pct(s.er)}</td><td class="num">${wonK(s.spend)}</td>
        <td class="num">${money2(s.cpm)}</td><td class="num">${money2(s.cpv)}</td><td class="num">${s.viralCount || '—'}</td></tr>`).join('')}
      </tbody></table></div></div>`;
    return;
  }
  const cfg = {
    views: { title: 'Views by campaign', sub: 'Total views on live content.', v: (x) => x.s.views, color: 'var(--s1)', fmt: kmb, desc: true },
    cpm:   { title: 'CPM by campaign', sub: 'Lower is cheaper reach.', v: (x) => Math.round(x.s.cpm), color: 'var(--s3)', fmt: (v) => '₩' + num(v), desc: false },
    er:    { title: 'Engagement rate by campaign', sub: 'Engagements ÷ views.', v: (x) => +(x.s.er * 100).toFixed(2), color: 'var(--s5)', fmt: (v) => v + '%', desc: true }
  }[tab] || {};
  view.innerHTML = `<div class="card"><div class="card-head"><h3>${cfg.title}</h3></div><p class="card-sub">${cfg.sub}</p><div id="anBars"></div></div>`;
  const rows = withLive.map((x) => ({ label: x.cp.brand, value: cfg.v(x), color: cfg.color }))
    .sort((a, b) => cfg.desc ? b.value - a.value : a.value - b.value);
  barsH($('#anBars'), rows, { labelHead: 'Campaign', valueHead: cfg.title, format: cfg.fmt, valueWidth: '70px' });
}

export function anCost(view, tab, s, withLive, live) {
  if (tab === 'campaign') {
    view.innerHTML = `<div class="card" style="padding:0"><div class="tbl-wrap" style="max-height:calc(100vh - 190px);overflow-y:auto">
      <table class="tbl"><thead><tr><th>Campaign</th><th class="num">Spend</th><th class="num">Confirmed</th><th class="num">CPI</th>
        <th class="num">CPM</th><th class="num">CPV</th><th class="num">CPE</th></tr></thead>
      <tbody>${withLive.sort((a, b) => a.s.cpm - b.s.cpm).map(({ cp, s: st }) => `<tr class="clickable" onclick="location.hash='#/campaigns/${cp.id}/performance'">
        <td class="strong">${esc(cp.brand)}<div style="font-size:11px;color:var(--text-3);font-weight:400">${esc(cp.kind)}</div></td>
        <td class="num">${wonK(st.spend)}</td><td class="num">${st.confirmed}</td><td class="num">${wonK(st.cpi)}</td>
        <td class="num">${money2(st.cpm)}</td><td class="num">${money2(st.cpv)}</td><td class="num">${money2(st.cpe)}</td></tr>`).join('')}
      </tbody></table></div></div>`;
    return;
  }
  if (tab === 'tier') {
    const rows = ['nano', 'micro', 'mid', 'macro'].map((t) => {
      const ps = live.filter((p) => byCreator[p.creatorId].tier === t);
      if (!ps.length) return null;
      const views = ps.reduce((a, p) => a + p.content.views, 0);
      const reach = ps.reduce((a, p) => a + p.content.reach, 0);
      const eng = ps.reduce((a, p) => a + engagementsOf(p.content), 0);
      const spend = ps.reduce((a, p) => a + byCampaign[p.campaignId].productCostPer + p.fee, 0);
      return { t, n: ps.length, views, reach, eng, spend, cpm: reach ? spend / reach * 1000 : 0, cpv: views ? spend / views : 0 };
    }).filter(Boolean);
    view.innerHTML = `<div class="grid g2">
      <div class="card"><div class="card-head"><h3>CPM by creator tier</h3></div><p class="card-sub">Lower is cheaper reach.</p><div id="anTierBars"></div></div>
      <div class="card" style="padding:0"><div class="tbl-wrap">
        <table class="tbl"><thead><tr><th>Tier</th><th class="num">Posts</th><th class="num">Views</th><th class="num">ER</th><th class="num">Spend</th><th class="num">CPM</th><th class="num">CPV</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td class="strong">${r.t[0].toUpperCase() + r.t.slice(1)}</td><td class="num">${r.n}</td>
          <td class="num">${kmb(r.views)}</td><td class="num">${pct(r.eng / (r.views || 1))}</td><td class="num">${wonK(r.spend)}</td>
          <td class="num">${money2(r.cpm)}</td><td class="num">${money2(r.cpv)}</td></tr>`).join('')}</tbody></table></div></div>
    </div>`;
    barsH($('#anTierBars'), rows.map((r, i) => ({ label: r.t[0].toUpperCase() + r.t.slice(1), value: Math.round(r.cpm), color: SERIES_HEX[[0, 2, 4, 3][i]] }))
      .sort((a, b) => a.value - b.value), { labelHead: 'Tier', valueHead: 'CPM', format: (v) => '₩' + num(v), barH: 24 });
    return;
  }

  const shipped = DB.participants.filter((p) => STAGE_IDX[p.stage] >= 5 && p.stage !== 'dropped');
  const productCost = shipped.reduce((a, p) => a + byCampaign[p.campaignId].productCostPer, 0);
  const fees = DB.participants.reduce((a, p) => a + (STAGE_IDX[p.stage] >= 4 && p.stage !== 'dropped' ? p.fee : 0), 0);
  const ads = DB.campaigns.reduce((a, c) => a + c.adSpend, 0);
  view.innerHTML = costCards(s) + `<div class="grid g2">
      <div class="card"><div class="card-head"><h3>Spend composition</h3></div>
        <p class="card-sub">Total ${wonK(s.spend)} across ${DB.campaigns.length} campaigns.</p>
        <div id="anSpend" style="margin-top:12px"></div></div>
      <div class="card"><div class="card-head"><h3>Cheapest reach</h3></div>
        <p class="card-sub">Five campaigns with the lowest CPM.</p><div id="anBest" style="margin-top:12px"></div></div>
    </div>`;
  splitBar($('#anSpend'), [
    { label: 'Product & shipping', value: productCost, color: 'var(--s1)' },
    { label: 'Creator fees', value: fees, color: 'var(--s2)' },
    { label: 'Ad spend', value: ads, color: 'var(--s3)' }
  ]);
  barsH($('#anBest'), withLive.slice().sort((a, b) => a.s.cpm - b.s.cpm).slice(0, 5)
    .map((x) => ({ label: x.cp.brand, value: Math.round(x.s.cpm), color: 'var(--s3)' })),
    { labelHead: 'Campaign', valueHead: 'CPM', format: (v) => '₩' + num(v), barH: 22 });
}

export function anBreakdown(view, tab, s, live) {
  const title = { platform: 'Views by platform', tier: 'Views by creator tier', organic: 'Organic vs paid views', format: 'Views by content format' }[tab] || 'Breakdown';
  view.innerHTML = `<div class="grid g-2-1">
      <div class="card"><div class="card-head"><h3>${title}</h3></div><div id="anSplit" style="margin-top:14px"></div></div>
      <div class="card"><div class="card-head"><h3>Detail</h3></div><div class="tbl-wrap" id="anDetail" style="margin-top:10px"></div></div>
    </div>`;

  let parts;
  if (tab === 'organic') {
    parts = [{ label: 'Organic', value: s.organicViews, color: 'var(--s1)' }, { label: 'Paid / boosted', value: s.paidViews, color: 'var(--s2)' }];
  } else if (tab === 'tier') {
    parts = ['nano', 'micro', 'mid', 'macro'].map((t, i) => ({
      label: t[0].toUpperCase() + t.slice(1), color: SERIES_HEX[[0, 2, 4, 3][i]],
      value: live.filter((p) => byCreator[p.creatorId].tier === t).reduce((a, p) => a + p.content.views, 0)
    })).filter((x) => x.value);
  } else if (tab === 'format') {
    parts = CONTENT_FORMATS.map((f, i) => ({
      label: f, color: SERIES_HEX[i % 7],
      value: live.filter((p) => p.content.format === f).reduce((a, p) => a + p.content.views, 0)
    })).filter((x) => x.value);
  } else {
    parts = PLATFORMS.map((pl, i) => ({
      label: pl, color: SERIES_HEX[i], value: live.filter((p) => p.content.platform === pl).reduce((a, p) => a + p.content.views, 0)
    })).filter((x) => x.value);
  }
  splitBar($('#anSplit'), parts);

  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  const groupOf = tab === 'tier' ? (p) => byCreator[p.creatorId].tier[0].toUpperCase() + byCreator[p.creatorId].tier.slice(1)
    : tab === 'format' ? (p) => p.content.format
    : tab === 'organic' ? null : (p) => p.content.platform;
  $('#anDetail').innerHTML = `<table class="tbl"><thead><tr><th>Segment</th><th class="num">Posts</th><th class="num">Views</th><th class="num">Share</th><th class="num">ER</th></tr></thead>
    <tbody>${parts.map((seg) => {
      const ps = groupOf ? live.filter((p) => groupOf(p) === seg.label) : live;
      const eng = ps.reduce((a, p) => a + engagementsOf(p.content), 0);
      const vw = ps.reduce((a, p) => a + p.content.views, 0);
      return `<tr><td class="strong"><span style="display:inline-block;width:9px;height:9px;border-radius:3px;background:${seg.color};margin-right:8px"></span>${esc(seg.label)}</td>
        <td class="num">${groupOf ? ps.length : '—'}</td><td class="num">${num(seg.value)}</td>
        <td class="num">${pct(seg.value / total)}</td><td class="num">${groupOf ? pct(eng / (vw || 1)) : '—'}</td></tr>`;
    }).join('')}</tbody></table>`;
}

export function anViral(view, tab, live) {
  const scored = live.map((p) => ({ p, v: viralScore(p) })).sort((a, b) => b.v - a.v);
  const rows = tab === 'all' ? scored.filter((x) => x.v >= 3) : scored.slice(0, 12);
  view.innerHTML = `
    <div class="grid g4" style="margin-bottom:16px;">
      ${statCard('Posts above 3×', scored.filter((x) => x.v >= 3).length, { foot: 'beat the creator baseline' })}
      ${statCard('Posts above 5×', scored.filter((x) => x.v >= 5).length, { foot: 'worth boosting' })}
      ${statCard('Best score', scored.length ? scored[0].v.toFixed(1) + '×' : '—', { foot: scored.length ? byCreator[scored[0].p.creatorId].handle : '' })}
      ${statCard('Median score', scored.length ? scored[Math.floor(scored.length / 2)].v.toFixed(1) + '×' : '—', { foot: 'a typical seeded post' })}
    </div>
    <div class="card" style="padding:0"><div class="tbl-wrap" style="max-height:calc(100vh - 330px);overflow-y:auto" id="anViral"></div></div>`;
  $('#anViral').innerHTML = rows.length ? `<table class="tbl"><thead><tr><th>Creator</th><th>Campaign</th><th>Format</th>
      <th class="num">Views</th><th class="num">vs baseline</th><th class="num">Comments</th><th class="num">Score</th></tr></thead>
    <tbody>${rows.map(({ p, v }) => {
      const cr = byCreator[p.creatorId], cp = byCampaign[p.campaignId], c = p.content;
      return `<tr class="clickable" onclick="showParticipant('${p.id}')"><td>${whoHtml(cr)}</td><td>${esc(cp.brand)}</td>
        <td><span class="tag">${esc(c.format)}</span>${c.boosted ? ' <span class="pill yellow">Ad</span>' : ''}</td>
        <td class="num">${num(c.views)}</td><td class="num">${(c.views / (cr.avgViews || 1)).toFixed(1)}×</td>
        <td class="num">${num(c.comments)}</td>
        <td class="num" style="color:${v >= 5 ? 'var(--good)' : v >= 3 ? 'var(--warning)' : 'var(--text-2)'};font-weight:500">${v.toFixed(1)}</td></tr>`;
    }).join('')}</tbody></table>` : `<div class="empty">No posts above 3× yet.</div>`;
}
