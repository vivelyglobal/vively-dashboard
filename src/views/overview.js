import { fitHeight, funnelView, lineChart, splitBar } from '../charts/index.js';
import { DAY, TODAY } from '../lib/dates.js';
import { engagementsOf, kmb, money2, num, pct, wonK } from '../lib/format.js';
import { DB, byCampaign, byCreator, notify } from '../model/db.js';
import { campaignStats, dailySeries, funnelOf, partsOf, portfolioStats, viralScore } from '../model/stats.js';
import { STAGE_IDX } from '../model/vocab.js';
import { $, esc } from '../ui/dom.js';
import { emptyState, statCard, statusPill, whoHtml } from '../ui/html.js';

/* ============================================================
   VIEW — OVERVIEW  (layer 2 items × layer 3 tabs)
   ============================================================ */
export const state = {
  range: 30,
  creatorFilters: { q: '', tier: '', cat: '', country: '', platform: '', worked: '' },
  boardMode: 'board',
  msgTone: 'friendly',
  msgLang: 'en',
  panelQ: '',
  calMonth: null,      /* which month the visit calendar is showing */
  calCampaign: '',     /* '' = every campaign */
  calSeededFor: null   /* scope the month was auto-picked for */
};

export function activeCampaigns() { return DB.campaigns.filter((c) => c.status !== 'wrapped'); }

export function alertsList() {
  const out = [];
  const push = (sev, kind, title, sub, href) => out.push({ sev, kind, title, sub, href });

  activeCampaigns().forEach((cp) => {
    const ps = partsOf(cp.id);
    const stale = ps.filter((p) => p.stage === 'contacted' && p.contactedAt && (TODAY - new Date(p.contactedAt)) / DAY > 7);
    if (stale.length) push('warning', 'chasing', `${stale.length} creators un-answered for 7+ days`, `${cp.brand} · ${cp.name}`, `#/campaigns/${cp.id}/roster`);

    const unshipped = ps.filter((p) => p.stage === 'confirmed' && p.confirmedAt && (TODAY - new Date(p.confirmedAt)) / DAY > 5);
    if (unshipped.length) push('serious', 'chasing', `${unshipped.length} confirmed creators not shipped yet`, `${cp.brand} · ${cp.name}`, `#/campaigns/${cp.id}/roster`);

    const lateContent = ps.filter((p) => p.stage === 'shipped' && p.shippedAt && (TODAY - new Date(p.shippedAt)) / DAY > 14);
    if (lateContent.length) push('critical', 'chasing', `${lateContent.length} shipped but no content after 14 days`, `${cp.brand} · ${cp.name}`, `#/campaigns/${cp.id}/roster`);

    const inReview = ps.filter((p) => p.stage === 'review' || p.stage === 'submitted');
    if (inReview.length >= 3) push('warning', 'chasing', `${inReview.length} drafts waiting on review`, `${cp.brand} · ${cp.name}`, `#/campaigns/${cp.id}/content`);

    const s = campaignStats(cp);
    const daysToStart = Math.round((new Date(cp.start) - TODAY) / DAY);
    if (daysToStart > -3 && daysToStart < 8 && s.confirmed < cp.targetCreators * 0.7)
      push('critical', 'chasing', `Only ${s.confirmed}/${cp.targetCreators} confirmed, starts ${daysToStart <= 0 ? 'already' : 'in ' + daysToStart + 'd'}`, `${cp.brand} · ${cp.name}`, `#/campaigns/${cp.id}/roster`);
  });

  DB.participants.filter((p) => p.content && p.stage === 'live' && viralScore(p) >= 5).slice(0, 8).forEach((p) => {
    const cr = byCreator[p.creatorId], cp = byCampaign[p.campaignId];
    push('good', 'wins', `${cr.handle} is outperforming — ${kmb(p.content.views)} views`, `${cp.brand} · ${viralScore(p).toFixed(1)}× their baseline · worth boosting`, `#/campaigns/${cp.id}/performance`);
  });

  const order = { critical: 0, serious: 1, warning: 2, good: 3 };
  return out.sort((a, b) => order[a.sev] - order[b.sev]);
}

export const OVERVIEW_ITEMS = [
  { id: 'summary',   label: 'Summary',         sub: 'KPIs and the trend' },
  { id: 'attention', label: 'Needs attention',  sub: 'what to chase today' },
  { id: 'pipeline',  label: 'Pipeline',         sub: 'outreach funnel' },
  { id: 'content',   label: 'Top content',      sub: 'best performing posts' }
];
export const OVERVIEW_TABS = {
  summary:   [['views', 'Views'], ['engagement', 'Engagement'], ['cost', 'Cost']],
  attention: [['all', 'All'], ['critical', 'Urgent'], ['chasing', 'To chase'], ['wins', 'Wins']],
  pipeline:  [['funnel', 'Funnel'], ['conversion', 'Stage conversion'], ['status', 'Campaign status']],
  content:   [['viral', 'By viral score'], ['views', 'By views'], ['comments', 'By comments']]
};

export function rangeSeg() {
  return `<div class="seg no-print" id="rangeSeg">${[7, 30, 90].map((d) => `<button data-r="${d}" class="${state.range === d ? 'active' : ''}">${d}d</button>`).join('')}</div>`;
}
export function wireRange() {
  const el = $('#rangeSeg'); if (!el) return;
  el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.range = +b.dataset.r; notify(); } });
}

export function renderOverview(view, item, tab) {
  const all = DB.campaigns, act = activeCampaigns();
  if (!all.length) {
    view.innerHTML = emptyState('Nothing here yet',
      'Start a campaign by hand, or upload one of the VIVELY creator sheets and the influencer rows will be read in automatically — statuses, handles, followers, addresses and visit slots included.',
      { icon: '⌂' });
    return;
  }
  if (item === 'attention') return ovAttention(view, tab);
  if (item === 'pipeline')  return ovPipeline(view, tab, act);
  if (item === 'content')   return ovContent(view, tab);
  return ovSummary(view, tab, all, act);
}

export function ovSummary(view, tab, all, act) {
  const cur = dailySeries(all, state.range);
  const prev = dailySeries(all, state.range * 2);
  const prevViews = prev.views.slice(0, state.range).reduce((a, b) => a + b, 0);
  const curViews = cur.views.reduce((a, b) => a + b, 0);
  const curEng = cur.eng.reduce((a, b) => a + b, 0);
  const port = portfolioStats(all);
  const inFlight = DB.participants.filter((p) => act.some((c) => c.id === p.campaignId) &&
    ['contacted', 'replied', 'shortlisted', 'confirmed', 'shipped', 'submitted', 'review'].includes(p.stage)).length;

  const head = `<div class="grid g4" style="margin-bottom:16px;">
      ${statCard('Active campaigns', act.length, { foot: `${all.length} total · ${all.filter((c) => c.status === 'live').length} live` })}
      ${statCard('Creators in flight', num(inFlight), { foot: `${num(port.confirmed)} confirmed all-time` })}
      ${statCard(`Views · last ${state.range}d`, kmb(curViews), { delta: prevViews ? (curViews - prevViews) / prevViews : null, foot: `${kmb(curEng)} engagements` })}
      ${statCard('Blended CPM', money2(port.cpm), { hint: 'Total spend ÷ reach × 1,000.', foot: `CPV ${money2(port.cpv)} · CPE ${money2(port.cpe)}` })}
    </div>`;

  if (tab === 'cost') {
    view.innerHTML = head + `<div class="grid g2">
      <div class="card"><div class="card-head"><h3>Cost efficiency</h3></div>
        <p class="card-sub">Across every campaign with live content.</p>
        <div class="grid g2" style="gap:10px">
          ${statCard('CPM', money2(port.cpm), { foot: 'per 1,000 reached' })}
          ${statCard('CPV', money2(port.cpv), { foot: 'per view' })}
          ${statCard('CPE', money2(port.cpe), { foot: 'per engagement' })}
          ${statCard('CPI', wonK(port.cpi), { foot: 'per confirmed creator' })}
        </div>
      </div>
      <div class="card"><div class="card-head"><h3>Where the money went</h3></div>
        <p class="card-sub">Total spend ${wonK(port.spend)}.</p>
        <div id="ovSpend" style="margin-top:12px"></div>
        <div class="divider"></div>
        <div class="card-head"><h3>Organic vs paid views</h3></div>
        <div id="ovOrg" style="margin-top:12px"></div>
      </div>
    </div>`;
    const shipped = DB.participants.filter((p) => STAGE_IDX[p.stage] >= 5 && p.stage !== 'dropped');
    const productCost = shipped.reduce((a, p) => a + byCampaign[p.campaignId].productCostPer, 0);
    const fees = DB.participants.reduce((a, p) => a + (STAGE_IDX[p.stage] >= 4 && p.stage !== 'dropped' ? p.fee : 0), 0);
    const ads = DB.campaigns.reduce((a, c) => a + c.adSpend, 0);
    splitBar($('#ovSpend'), [
      { label: 'Product & shipping', value: productCost, color: 'var(--s1)' },
      { label: 'Creator fees', value: fees, color: 'var(--s2)' },
      { label: 'Ad spend', value: ads, color: 'var(--s3)' }
    ]);
    splitBar($('#ovOrg'), [
      { label: 'Organic', value: port.organicViews, color: 'var(--s1)' },
      { label: 'Paid / boosted', value: port.paidViews, color: 'var(--s2)' }
    ]);
    return;
  }

  const isEng = tab === 'engagement';
  view.innerHTML = head + `<div class="card">
      <div class="card-head"><h3>${isEng ? 'Daily engagements' : 'Daily views'}</h3><div class="sp"></div>${rangeSeg()}</div>
      <p class="card-sub">${isEng ? 'Likes, comments, shares and saves accruing each day.' : 'Incremental views across every campaign with live content.'}</p>
      <div id="ovChart"></div>
    </div>`;
  lineChart($('#ovChart'), {
    labels: cur.labels, height: fitHeight(430, 240),
    series: [isEng
      ? { name: 'Engagements', values: cur.eng, color: 'var(--s2)', area: true }
      : { name: 'Views', values: cur.views, area: true }]
  });
  wireRange();
}

export function ovAttention(view, tab) {
  const all = alertsList();
  const list = tab === 'critical' ? all.filter((a) => a.sev === 'critical' || a.sev === 'serious')
    : tab === 'wins' ? all.filter((a) => a.kind === 'wins')
    : tab === 'chasing' ? all.filter((a) => a.kind === 'chasing')
    : all;

  const counts = {
    critical: all.filter((a) => a.sev === 'critical').length,
    serious: all.filter((a) => a.sev === 'serious').length,
    warning: all.filter((a) => a.sev === 'warning').length,
    good: all.filter((a) => a.sev === 'good').length
  };

  view.innerHTML = `
    <div class="grid g4" style="margin-bottom:16px;">
      ${statCard('Urgent', counts.critical, { foot: 'blocking delivery' })}
      ${statCard('Slipping', counts.serious, { foot: 'behind schedule' })}
      ${statCard('To follow up', counts.warning, { foot: 'nudge today' })}
      ${statCard('Wins to press', counts.good, { foot: 'posts worth boosting' })}
    </div>
    <div class="card"><div id="alerts" style="max-height:calc(100vh - 330px);overflow-y:auto"></div></div>`;

  $('#alerts').innerHTML = list.length ? list.map((a) => {
    const color = { critical: 'var(--critical)', serious: 'var(--serious)', warning: 'var(--warning)', good: 'var(--good)' }[a.sev];
    const icon = { critical: '!', serious: '!', warning: '•', good: '↑' }[a.sev];
    return `<a class="alert-row" href="${a.href}" style="color:inherit;text-decoration:none;">
      <span class="ai" style="background:${color};color:#0b0c0e;font-weight:700;">${icon}</span>
      <span class="at"><b>${esc(a.title)}</b><div class="as">${esc(a.sub)}</div></span>
      <span style="color:var(--text-3)">›</span></a>`;
  }).join('') : `<div class="empty">Nothing here — this queue is clear.</div>`;
}

export function ovPipeline(view, tab, act) {
  const f = funnelOf(act.map((c) => c.id));

  if (tab === 'status') {
    view.innerHTML = `<div class="card" style="padding:0"><div class="tbl-wrap" style="max-height:calc(100vh - 200px);overflow-y:auto" id="ovCampaigns"></div></div>`;
    $('#ovCampaigns').innerHTML = `<table class="tbl"><thead><tr>
        <th>Campaign</th><th>Status</th><th style="width:170px">Confirmed vs target</th><th class="num">Delivered</th>
        <th class="num">Views</th><th class="num">ER</th><th class="num">CPM</th></tr></thead><tbody>${
        act.map((cp) => {
          const s = campaignStats(cp);
          return `<tr class="clickable" onclick="location.hash='#/campaigns/${cp.id}/roster'">
            <td class="strong">${esc(cp.brand)}<div style="font-size:11.5px;color:var(--text-3);font-weight:400;">${esc(cp.kind)} · ${esc(cp.market)}</div></td>
            <td>${statusPill(cp.status)}</td>
            <td><div class="bar"><i style="width:${(s.progress * 100).toFixed(0)}%"></i></div>
                <div style="font-size:11px;color:var(--text-3);margin-top:4px;">${s.confirmed} / ${cp.targetCreators}</div></td>
            <td class="num">${s.delivered}</td><td class="num">${kmb(s.views)}</td>
            <td class="num">${s.views ? pct(s.er) : '—'}</td><td class="num">${s.reach ? money2(s.cpm) : '—'}</td>
          </tr>`;
        }).join('')}</tbody></table>`;
    return;
  }

  if (tab === 'conversion') {
    view.innerHTML = `<div class="card" style="padding:0"><div class="tbl-wrap">
      <table class="tbl"><thead><tr><th>Stage</th><th>What it means</th><th class="num">Creators</th><th class="num">From previous</th><th class="num">From sourced</th></tr></thead>
      <tbody>${f.counts.map((c, i) => `<tr>
        <td class="strong"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c.stage.color};margin-right:8px"></span>${c.stage.label}</td>
        <td style="color:var(--text-3);font-size:12.5px">${esc(c.stage.desc)}</td>
        <td class="num">${num(c.n)}</td>
        <td class="num">${i ? pct(c.n / (f.counts[i - 1].n || 1), 0) : '—'}</td>
        <td class="num">${pct(c.n / (f.counts[0].n || 1), 0)}</td></tr>`).join('')}
        <tr><td class="strong" style="color:#f08a8a">Dropped</td><td style="color:var(--text-3);font-size:12.5px">Declined, ghosted or removed by the brand</td>
        <td class="num">${num(f.dropped)}</td><td class="num">—</td><td class="num">${pct(f.dropped / (f.total || 1), 0)}</td></tr>
      </tbody></table></div></div>`;
    return;
  }

  view.innerHTML = `<div class="grid g-2-1">
      <div class="card"><div class="card-head"><h3>Outreach funnel</h3></div>
        <p class="card-sub">All active campaigns. Each row counts creators still in play at or past that stage.</p>
        <div id="ovFunnel"></div>
      </div>
      <div class="card"><div class="card-head"><h3>Health</h3></div>
        <div class="grid" style="gap:10px;margin-top:12px">
          ${statCard('Reply rate', pct(f.counts[2].n / (f.counts[1].n || 1), 0), { foot: 'replied ÷ contacted' })}
          ${statCard('Confirm rate', pct(f.counts[4].n / (f.counts[1].n || 1), 0), { foot: 'confirmed ÷ contacted' })}
          ${statCard('Delivery rate', pct(f.counts[8].n / (f.counts[4].n || 1), 0), { foot: 'live ÷ confirmed' })}
        </div>
      </div>
    </div>`;
  funnelView($('#ovFunnel'), f.counts, f.total);
  $('#ovFunnel').insertAdjacentHTML('beforeend',
    `<div style="margin-top:12px;font-size:12px;color:var(--text-3);">${num(f.dropped)} of ${num(f.total)} sourced dropped out or were declined along the way.</div>`);
}

export function ovContent(view, tab) {
  const live = DB.participants.filter((p) => p.stage === 'live' && p.content);
  const key = tab === 'views' ? (p) => p.content.views : tab === 'comments' ? (p) => p.content.comments : (p) => viralScore(p);
  const rows = live.slice().sort((a, b) => key(b) - key(a)).slice(0, 25);

  view.innerHTML = `<div class="card" style="padding:0">
    <div style="padding:16px 20px 0"><div class="card-head"><h3>Top ${rows.length} posts ${tab === 'views' ? 'by views' : tab === 'comments' ? 'by comments' : 'by viral score'}</h3></div>
    <p class="card-sub">${tab === 'comments' || tab === 'views' ? 'Live posts only.' : "Viral score is views ÷ that creator's own average, weighted by shares and saves. 1.0× is a normal post for them."}</p></div>
    <div class="tbl-wrap" style="max-height:calc(100vh - 260px);overflow-y:auto" id="ovTop"></div></div>`;

  $('#ovTop').innerHTML = `<table class="tbl"><thead><tr>
      <th>Creator</th><th>Campaign</th><th>Format</th><th class="num">Views</th><th class="num">ER</th>
      <th class="num">Comments</th><th class="num">Saves</th><th class="num">Viral</th><th></th></tr></thead><tbody>${
      rows.map((p) => {
        const cr = byCreator[p.creatorId], cp = byCampaign[p.campaignId], c = p.content, v = viralScore(p);
        return `<tr class="clickable" onclick="showParticipant('${p.id}')">
          <td>${whoHtml(cr)}</td><td>${esc(cp.brand)}</td>
          <td><span class="tag">${esc(c.format)}</span>${c.boosted ? ' <span class="pill yellow">Ad</span>' : ''}</td>
          <td class="num">${num(c.views)}</td><td class="num">${pct(engagementsOf(c) / (c.views || 1))}</td>
          <td class="num">${num(c.comments)}</td><td class="num">${num(c.saves)}</td>
          <td class="num" style="color:${v >= 5 ? 'var(--good)' : v >= 3 ? 'var(--warning)' : 'var(--text-2)'};font-weight:500;">${v.toFixed(1)}×</td>
          <td><a href="${c.url}" target="_blank" rel="noopener" onclick="event.stopPropagation()">open</a></td></tr>`;
      }).join('')}</tbody></table>`;
}
