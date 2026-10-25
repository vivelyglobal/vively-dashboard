import { fitHeight, funnelView, lineChart, splitBar } from '../charts/index.js';
import { DAY, TODAY, iso } from '../lib/dates.js';
import { engagementsOf, erPct, kmb, money2, num, pct, won, wonK } from '../lib/format.js';
import { DB, byCampaign, byCreator, notify } from '../model/db.js';
import { isBlocked } from '../model/settings.js';
import { campaignStats, dailySeries, funnelOf, partsOf, portfolioStats, viralScore } from '../model/stats.js';
import { CAMPAIGN_STATUS, STAGE_IDX, tierOf } from '../model/vocab.js';
import { $, $$, esc } from '../ui/dom.js';
import { downloadFile, emptyState, flaggedOnRoster, statCard, statusPill, tierPill, toCsv, whoHtml } from '../ui/html.js';
import { toast } from '../ui/overlay.js';
import { maskAccount, showParticipant } from './campaigns.js';
import { showCreator } from './creators.js';
import { DESK, kstToday } from './desk.js';
import { PLANNER_CONFIRMED, attendanceOf, markPaid, payInfo, plannerRow, postedState } from './planner.js';

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

    /* A blacklisted creator on an active campaign is a mistake somebody
       has to undo, not a number to watch — so it is said here as well as
       on the roster itself. */
    const flagged = flaggedOnRoster(cp.id);
    const blockedOn = flagged.filter((x) => x.cr.flag === 'blocked');
    const cautionOn = flagged.filter((x) => x.cr.flag === 'caution');
    if (blockedOn.length) {
      push('critical', 'flag', `${blockedOn.length} blacklisted creator${blockedOn.length === 1 ? '' : 's'} on this roster`,
        `${cp.brand} · ${blockedOn.slice(0, 3).map((x) => x.cr.handle).join(', ')}${blockedOn.length > 3 ? ' and more' : ''}`,
        `#/campaigns/${cp.id}/roster`);
    }
    if (cautionOn.length) {
      push('warning', 'flag', `${cautionOn.length} creator${cautionOn.length === 1 ? '' : 's'} marked caution on this roster`,
        `${cp.brand} · ${cautionOn.slice(0, 3).map((x) => x.cr.handle).join(', ')}${cautionOn.length > 3 ? ' and more' : ''}`,
        `#/campaigns/${cp.id}/roster`);
    }

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

/* ============================================================
   VIEW — TODAY (the home page)
   Not a to-do list: bookings and chasing already live in the Google
   Sheet and in Instagram DMs. This page answers the two questions the
   team opens the dashboard for —

     · who is coming in, and when (the next two weeks, day by day)
     · where the creator list stands: how many of them have been in a
       campaign, how many campaigns each has done, who has not been used
       yet, and how that splits across Nano / Micro / Mid / Macro.

   "In a campaign" means confirmed or further along. Sourced, contacted,
   replied and shortlisted are still a conversation, and dropped is not
   a participation, so none of them count.
   ============================================================ */
export const TODAY_VIEW = { tier: '', allCamps: false };
export const TODAY_TIERS = ['nano', 'micro', 'mid', 'macro'];
export const TODAY_TIER_RANGE = { nano: 'under 15K', micro: '15–60K', mid: '60–250K', macro: '250K+' };
export const TODAY_TIER_COLOR = { nano: 'var(--text-3)', micro: 'var(--blue)', mid: 'var(--s5)', macro: 'var(--warning)' };
export const TODAY_HORIZON = 14;

export function ensureTodayStyles() {
  if (document.getElementById('tdCss')) return;
  const s = document.createElement('style');
  s.id = 'tdCss';
  s.textContent = `
  .td-wrap{max-width:1080px}
  .td-head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:18px}
  .td-head h2{margin:0;font-size:22px;font-weight:650;letter-spacing:-.025em}
  .td-head .d{color:var(--text-3);font-size:13px}
  .td-sec{margin-top:30px}
  .td-sec > h3{display:flex;gap:10px;align-items:baseline;font-size:14px;font-weight:600;margin:0 0 10px}
  .td-sec > h3 .m{font-size:12px;font-weight:400;color:var(--text-3)}
  .td-sec > h3 .sp{flex:1}
  .td-sec > h3 a,.td-sec > h3 select{font-size:12.5px;font-weight:500}
  .td-sec > h3 select{width:auto;padding:5px 28px 5px 9px}
  .td-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);overflow:hidden}
  .td-card .tbl-wrap{overflow-x:auto}
  .td-card tr.go{cursor:pointer}
  .td-card tr.go:hover td{background:var(--surface-2)}
  .td-card td.num,.td-card th.num{text-align:right;font-variant-numeric:tabular-nums}
  .td-card tr.tot td{font-weight:600;border-top:1px solid var(--line-strong)}
  .td-card td.z{color:var(--text-3)}
  .td-bar{display:flex;align-items:center;gap:9px;min-width:130px}
  .td-bar .t{flex:1;height:6px;border-radius:3px;background:var(--surface-3);overflow:hidden;min-width:60px}
  .td-bar .f{display:block;height:100%;border-radius:3px;background:var(--s1)}
  .td-bar .v{font-size:12px;color:var(--text-2);min-width:34px;text-align:right;font-variant-numeric:tabular-nums}
  .td-mix{display:flex;gap:5px;flex-wrap:wrap}
  .td-mix span{font-size:11.5px;padding:3px 7px;border-radius:100px;background:var(--surface-2);color:var(--text-2);
    white-space:nowrap;font-variant-numeric:tabular-nums}
  .td-mix span.z{opacity:.4}
  .td-mix i{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;font-style:normal}
  .td-days .r{display:grid;grid-template-columns:116px 78px minmax(0,1fr);gap:14px;align-items:center;
    padding:12px 16px;border-top:1px solid var(--line);cursor:pointer;width:100%;text-align:left;
    border-left:0;border-right:0;border-bottom:0;background:none;font:inherit;color:inherit}
  .td-days .r:first-child{border-top:0}
  .td-days .r:hover{background:var(--surface-2)}
  .td-days .dy{font-size:13.5px;font-weight:550}
  .td-days .dy small{display:block;font-size:11.5px;font-weight:400;color:var(--blue);margin-top:2px}
  .td-days .n{font-size:13px;font-variant-numeric:tabular-nums}
  .td-days .n small{display:block;font-size:11.5px;color:var(--text-3)}
  .td-note{font-size:12px;color:var(--text-3);padding:11px 16px;border-top:1px solid var(--line)}
  .td-empty{padding:26px 18px;text-align:center;color:var(--text-3);font-size:13px}
  .td-two{display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start}
  @media(max-width:900px){.td-two{grid-template-columns:1fr}}
  @media(max-width:760px){
    .td-days .r{grid-template-columns:96px minmax(0,1fr);gap:4px 12px}
    .td-days .r .td-mix{grid-column:1/-1}
  }`;
  document.head.appendChild(s);
}

/* creatorId -> Set of campaign ids they have been confirmed on or beyond.
   Only campaigns that still exist count, so a deleted campaign cannot keep
   somebody marked as "used". */
export function creatorUse() {
  const by = {};
  DB.participants.forEach((p) => {
    if (!p.creatorId || !PLANNER_CONFIRMED.includes(p.stage) || !byCampaign[p.campaignId]) return;
    (by[p.creatorId] = by[p.creatorId] || new Set()).add(p.campaignId);
  });
  return by;
}
/* the Creators page's "Never in a campaign" segment uses this per creator */
export function hasBeenInCampaign(creatorId) {
  return DB.participants.some((p) => p.creatorId === creatorId && PLANNER_CONFIRMED.includes(p.stage) && byCampaign[p.campaignId]);
}
export const creatorTier = (c) => c.tier || tierOf(c.followers || 0).id;

export function todayMix(counts) {
  return `<div class="td-mix">${TODAY_TIERS.map((t) => `<span class="${counts[t] ? '' : 'z'}"><i style="background:${TODAY_TIER_COLOR[t]}"></i>${
    t[0].toUpperCase() + t.slice(1)} ${counts[t] || 0}</span>`).join('')}</div>`;
}
export const todayBar = (n, of) => `<div class="td-bar"><span class="t"><span class="f" style="width:${of ? Math.round(n / of * 100) : 0}%"></span></span>
  <span class="v">${of ? Math.round(n / of * 100) + '%' : '—'}</span></div>`;

/* the next TODAY_HORIZON days of visits, one entry per day that has any */
export function todaySchedule(only) {
  const start = kstToday();
  const end = new Date(new Date(start + 'T00:00:00Z').getTime() + (TODAY_HORIZON - 1) * DAY).toISOString().slice(0, 10);
  const days = {};
  const dated = new Set();
  DB.participants.forEach((p) => {
    const cp = byCampaign[p.campaignId];
    if (!cp || (only && p.campaignId !== only) || !PLANNER_CONFIRMED.includes(p.stage)) return;
    const r = plannerRow(p);
    if (r.at) dated.add(p.campaignId);
    if (attendanceOf(p) === 'cancelled') return;
    if (!r.at) return;
    if (r.dayKey < start || r.dayKey > end) return;
    const d = days[r.dayKey] = days[r.dayKey] || { key: r.dayKey, teams: 0, heads: 0, by: {} };
    d.teams += 1;
    d.heads += Number(p.headcount) || 1;
    d.by[p.campaignId] = (d.by[p.campaignId] || 0) + 1;
  });
  /* "no date yet" only means something for campaigns that schedule visits at all */
  const noDate = DB.participants.filter((p) => byCampaign[p.campaignId] && (!only || p.campaignId === only) && p.stage === 'confirmed'
    && byCampaign[p.campaignId].status !== 'wrapped' && dated.has(p.campaignId) && !plannerRow(p).at).length;
  const list = Object.values(days).sort((a, b) => a.key.localeCompare(b.key));
  const weekEnd = new Date(new Date(start + 'T00:00:00Z').getTime() + 6 * DAY).toISOString().slice(0, 10);
  return { start, list, noDate,
    week: list.filter((d) => d.key <= weekEnd).reduce((n, d) => n + d.teams, 0),
    total: list.reduce((n, d) => n + d.teams, 0) };
}

export function renderToday(view, item) {
  ensureTodayStyles();
  if (!DB.campaigns.length && !DB.creators.length) {
    view.innerHTML = emptyState('Nothing here yet', 'Import a campaign or a creator list and the overview fills itself in.');
    return;
  }
  const only = item && item !== 'all' && byCampaign[item] ? item : '';
  const use = creatorUse();
  const blocked = DB.creators.filter(isBlocked).length;
  const live = DB.creators.filter((c) => !isBlocked(c));
  const inCamp = (c) => !!(use[c.id] && (!only || use[c.id].has(only)));
  /* one campaign: the pool is everyone with a live row on it, so "not yet"
     reads as "still to confirm" rather than "everyone we have ever sourced" */
  const poolIds = only ? new Set(DB.participants.filter((p) => p.campaignId === only && p.stage !== 'dropped').map((p) => p.creatorId)) : null;
  const pool = poolIds ? live.filter((c) => poolIds.has(c.id)) : live;
  const did = pool.filter(inCamp);
  const repeat = pool.filter((c) => use[c.id] && use[c.id].size >= 2);
  const avg = did.length ? did.reduce((n, c) => n + use[c.id].size, 0) / did.length : 0;
  const when = new Date(kstToday() + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const cpTitle = only ? byCampaign[only].brand : 'Home';

  /* ---- by tier ---- */
  const tierRows = TODAY_TIERS.map((t) => {
    const all = pool.filter((c) => creatorTier(c) === t);
    const d = all.filter(inCamp).length;
    return { t, total: all.length, did: d, not: all.length - d };
  });
  const tierHtml = tierRows.map((r) => `<tr class="go" data-tdgo="#/creators/${r.t}">
      <td><b>${r.t[0].toUpperCase() + r.t.slice(1)}</b> <span style="color:var(--text-3);font-size:12px">· ${TODAY_TIER_RANGE[r.t]}</span></td>
      <td class="num">${num(r.total)}</td><td class="num">${num(r.did)}</td>
      <td class="num ${r.not ? '' : 'z'}">${num(r.not)}</td><td>${todayBar(r.did, r.total)}</td></tr>`).join('');

  /* ---- how many campaigns each creator has done (everything view only) ---- */
  const BUCKETS = [[0, '0 — not yet'], [1, '1 campaign'], [2, '2 campaigns'], [3, '3 campaigns'], [4, '4 or more']];
  const bucketOf = (c) => Math.min(4, use[c.id] ? use[c.id].size : 0);
  const matrix = BUCKETS.map(([n, label]) => {
    const inB = pool.filter((c) => bucketOf(c) === n);
    const by = {}; TODAY_TIERS.forEach((t) => { by[t] = inB.filter((c) => creatorTier(c) === t).length; });
    return { n, label, total: inB.length, by };
  });
  const matrixHtml = matrix.map((m) => `<tr class="go" data-tdgo="#/creators/${m.n === 0 ? 'unused' : m.n >= 2 ? 'repeat' : 'worked'}">
      <td>${m.label}</td>${TODAY_TIERS.map((t) => `<td class="num ${m.by[t] ? '' : 'z'}">${m.by[t]}</td>`).join('')}
      <td class="num"><b>${num(m.total)}</b></td><td>${todayBar(m.total, pool.length)}</td></tr>`).join('');

  /* ---- campaigns ---- */
  const camps = DB.campaigns.filter((c) => !only || c.id === only).map((cp) => {
    const rows = DB.participants.filter((p) => p.campaignId === cp.id && PLANNER_CONFIRMED.includes(p.stage) && byCreator[p.creatorId]);
    const ids = [...new Set(rows.map((p) => p.creatorId))];
    const by = {}; TODAY_TIERS.forEach((t) => { by[t] = 0; });
    ids.forEach((id) => { by[creatorTier(byCreator[id])] += 1; });
    return { cp, n: ids.length, by, fresh: ids.filter((id) => use[id] && use[id].size === 1).length,
      target: Number(cp.targetCreators) || 0 };
  }).sort((a, b) => (a.cp.status === 'wrapped') - (b.cp.status === 'wrapped')
    || String(b.cp.start || '').localeCompare(String(a.cp.start || '')));
  const shownCamps = TODAY_VIEW.allCamps || only ? camps : camps.filter((r) => r.cp.status !== 'wrapped');
  const wrappedHidden = camps.length - shownCamps.length;
  const dates = (cp) => [cp.start, cp.end].filter(Boolean).map((d) => String(d).slice(5, 10)).join(' → ') || '—';

  /* ---- schedule ---- */
  const sch = todaySchedule(only);
  const dayLabel = (key) => new Date(key + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const tomorrow = new Date(new Date(sch.start + 'T00:00:00Z').getTime() + DAY).toISOString().slice(0, 10);
  const dayHtml = sch.list.map((d) => `<button class="r" data-tdday="${esc(d.key)}">
      <span class="dy">${esc(dayLabel(d.key))}${d.key === sch.start ? '<small>Today</small>' : d.key === tomorrow ? '<small>Tomorrow</small>' : ''}</span>
      <span class="n"><b>${d.teams}</b> visit${d.teams === 1 ? '' : 's'}<small>${d.heads} people</small></span>
      <span class="td-mix">${Object.entries(d.by).map(([id, n]) => `<span>${esc(byCampaign[id].brand)} ${n}</span>`).join('')}</span>
    </button>`).join('');

  /* ---- who has not been used ---- */
  const tierPick = TODAY_VIEW.tier;
  const idle = !only ? live.filter((c) => !use[c.id]) : [];
  const idleShown = idle.filter((c) => !tierPick || creatorTier(c) === tierPick)
    .sort((a, b) => (b.followers || 0) - (a.followers || 0));

  view.innerHTML = `<div class="td-wrap">
    <div class="td-head"><h2>${esc(cpTitle)}</h2><span class="d">${esc(when)}</span></div>

    <div class="grid g4">
      ${statCard(only ? 'On the roster' : 'Creators', num(pool.length), { foot: only ? 'not dropped' : blocked ? `${num(blocked)} blacklisted left out` : 'in the database' })}
      ${statCard(only ? 'Confirmed' : 'Been in a campaign', num(did.length), { foot: `${pool.length ? Math.round(did.length / pool.length * 100) : 0}% of ${only ? 'the roster' : 'the creator list'}` })}
      ${statCard(only ? 'Not confirmed yet' : 'Not yet in one', num(pool.length - did.length), { foot: only ? 'waiting on a decision' : 'never confirmed on a campaign' })}
      ${statCard(only ? 'Worked with us before' : 'Repeat · 2+ campaigns', num(only ? did.filter((c) => use[c.id].size >= 2).length : repeat.length),
        { foot: did.length ? `${avg.toFixed(1)} campaigns each, on average` : 'no one confirmed yet' })}
    </div>

    <div class="td-sec"><h3>${only ? 'Visits' : 'Scheduling'}<span class="m">next ${TODAY_HORIZON} days · ${sch.week} this week · ${sch.total} in all</span>
        <span class="sp"></span><a href="#/desk">Open the Desk →</a></h3>
      <div class="td-card td-days">${sch.list.length ? dayHtml
        : `<div class="td-empty">No visits booked in the next ${TODAY_HORIZON} days.</div>`}
        ${sch.noDate ? `<div class="td-note">${sch.noDate} confirmed creator${sch.noDate === 1 ? ' has' : 's have'} no visit date yet.</div>` : ''}</div>
    </div>

    <div class="td-sec"><h3>${only ? 'Roster by tier' : 'Creators by tier'}<span class="m">${only ? 'confirmed vs still to confirm' : 'who has been in a campaign'}</span></h3>
      <div class="td-card"><div class="tbl-wrap"><table class="tbl"><thead><tr>
        <th>Tier</th><th class="num">${only ? 'On roster' : 'Creators'}</th><th class="num">${only ? 'Confirmed' : 'In a campaign'}</th>
        <th class="num">${only ? 'Not yet' : 'Not yet used'}</th><th>${only ? 'Confirmed' : 'Used'}</th></tr></thead>
        <tbody>${tierHtml}<tr class="tot"><td>All tiers</td><td class="num">${num(pool.length)}</td><td class="num">${num(did.length)}</td>
          <td class="num">${num(pool.length - did.length)}</td><td>${todayBar(did.length, pool.length)}</td></tr></tbody></table></div></div>
    </div>

    ${only ? '' : `<div class="td-sec"><h3>Campaigns per creator<span class="m">how many campaigns each creator has been confirmed on</span></h3>
      <div class="td-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Campaigns done</th>
        ${TODAY_TIERS.map((t) => `<th class="num">${t[0].toUpperCase() + t.slice(1)}</th>`).join('')}<th class="num">Creators</th><th>Share</th></tr></thead>
        <tbody>${matrixHtml}</tbody></table></div></div>
    </div>`}

    <div class="td-sec"><h3>${only ? 'Campaign' : 'Campaigns'}<span class="m">creators confirmed, by tier</span><span class="sp"></span>
        ${!only && (wrappedHidden || TODAY_VIEW.allCamps) ? `<a href="#" id="tdAllCamps">${TODAY_VIEW.allCamps ? 'Hide wrapped' : `Show ${wrappedHidden} wrapped`}</a>` : ''}</h3>
      <div class="td-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Campaign</th><th>Status</th><th>Dates</th>
        <th class="num">Confirmed</th><th>By tier</th><th class="num">First-timers</th></tr></thead>
        <tbody>${shownCamps.length ? shownCamps.map((r) => `<tr class="go" data-tdgo="#/campaigns/${esc(r.cp.id)}">
          <td><b>${esc(r.cp.brand)}</b><div style="color:var(--text-3);font-size:12px">${esc(r.cp.name || '')}</div></td>
          <td><span class="pill ${(CAMPAIGN_STATUS[r.cp.status] || {}).cls || 'grey'}">${esc((CAMPAIGN_STATUS[r.cp.status] || {}).label || r.cp.status || '—')}</span></td>
          <td style="white-space:nowrap;color:var(--text-2)">${esc(dates(r.cp))}</td>
          <td class="num">${r.n}${r.target ? `<span style="color:var(--text-3)"> / ${r.target}</span>` : ''}</td>
          <td>${todayMix(r.by)}</td><td class="num ${r.fresh ? '' : 'z'}">${r.fresh}</td></tr>`).join('')
          : `<tr><td colspan="6" class="td-empty">No campaigns yet.</td></tr>`}</tbody></table></div></div>
    </div>

    ${only ? '' : `<div class="td-sec"><h3>Not used yet<span class="m">${num(idleShown.length)} creator${idleShown.length === 1 ? '' : 's'}, biggest first</span><span class="sp"></span>
        <select id="tdTier"><option value="">Any tier</option>${TODAY_TIERS.map((t) => `<option value="${t}" ${tierPick === t ? 'selected' : ''}>${
          t[0].toUpperCase() + t.slice(1)} · ${TODAY_TIER_RANGE[t]}</option>`).join('')}</select>
        <a href="#/creators/unused">All in Creators →</a></h3>
      <div class="td-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Creator</th><th>Tier</th><th>Category</th><th>Country</th>
        <th class="num">Followers</th><th class="num">ER</th></tr></thead>
        <tbody>${idleShown.slice(0, 12).map((c) => `<tr class="go" data-tdcr="${esc(c.id)}"><td>${whoHtml(c, c.name)}</td>
          <td>${tierPill(creatorTier(c))}</td><td>${esc((c.categories || []).slice(0, 2).join(', ') || '—')}</td><td>${esc(c.country || '—')}</td>
          <td class="num">${kmb(c.followers)}</td><td class="num">${c.er ? erPct(c.er) : '—'}</td></tr>`).join('')
          || `<tr><td colspan="6" class="td-empty">${idle.length ? 'No one in that tier.' : 'Every creator on the list has been in a campaign.'}</td></tr>`}</tbody></table></div>
        ${idleShown.length > 12 ? `<div class="td-note">Showing 12 of ${num(idleShown.length)}.</div>` : ''}</div>
    </div>`}
  </div>`;

  $$('[data-tdgo]', view).forEach((r) => r.addEventListener('click', () => { location.hash = r.dataset.tdgo; }));
  $$('[data-tdcr]', view).forEach((r) => r.addEventListener('click', () => showCreator(r.dataset.tdcr)));
  $$('[data-tdday]', view).forEach((b) => b.addEventListener('click', () => { DESK.day = b.dataset.tdday; location.hash = '#/desk'; }));
  const tierSel = $('#tdTier', view);
  if (tierSel) tierSel.addEventListener('change', () => { TODAY_VIEW.tier = tierSel.value; notify(); });
  const allC = $('#tdAllCamps', view);
  if (allC) allC.addEventListener('click', (e) => { e.preventDefault(); TODAY_VIEW.allCamps = !TODAY_VIEW.allCamps; notify(); });
}

/* ============================================================
   VIEW — PAYOUTS
   Who is owed money, for which campaign, and since when. The drawer
   already recorded payment mode, amount and the day it was paid; this
   is the list of those across every campaign, with the one action
   that matters here.

   Bank details never leave the server copy (see stripPayout). They are
   shown masked, and the CSV carries names and amounts only — the bank
   transfer itself is done from the drawer's Reveal, one person at a time.
   ============================================================ */
export const PAYOUT_TABS = [['due', 'To pay'], ['upcoming', 'Not due yet'], ['paid', 'Paid']];

export function payoutRows(campaignId) {
  return DB.participants
    .filter((p) => p.stage !== 'dropped' && (!campaignId || p.campaignId === campaignId) && byCampaign[p.campaignId])
    .map((p) => {
      const pay = payInfo(p);
      if (pay.mode === 'none' || !pay.amount) return null;
      const post = postedState(p);
      const posted = post.state === 'posted';
      const state = pay.paid ? 'paid' : posted ? 'due' : 'upcoming';
      return { p, pay, post, state, cp: byCampaign[p.campaignId], cr: byCreator[p.creatorId] || {} };
    })
    .filter(Boolean);
}

export function renderPayouts(view, item, tab) {
  const only = item && item !== 'all' && byCampaign[item] ? item : '';
  const rows = payoutRows(only);
  const pick = PAYOUT_TABS.some((t) => t[0] === tab) ? tab : 'due';
  const sum = (k) => rows.filter((r) => r.state === k).reduce((a, r) => a + r.pay.amount, 0);
  const n = (k) => rows.filter((r) => r.state === k).length;
  const month = iso(TODAY).slice(0, 7);
  const paidMonth = rows.filter((r) => r.state === 'paid' && String(r.pay.paidAt).slice(0, 7) === month);

  if (!rows.length) {
    view.innerHTML = emptyState('Nobody to pay yet',
      'Creators show up here once a fee or a paid amount is set on their roster card.', { actions: false, icon: '₩' });
    return;
  }
  const list = rows.filter((r) => r.state === pick)
    .sort((a, b) => pick === 'paid' ? String(b.pay.paidAt).localeCompare(String(a.pay.paidAt))
      : a.cp.brand.localeCompare(b.cp.brand));
  const bankOf = (cr) => cr.payout && cr.payout.number
    ? `${esc(cr.payout.bank || 'Bank')} ${esc(maskAccount(cr.payout.number))}` : '<span style="color:var(--critical)">no bank details</span>';

  view.innerHTML = `
    <div class="grid g3" style="margin-bottom:16px">
      ${statCard('To pay now', wonK(sum('due')), { foot: `${n('due')} creator${n('due') === 1 ? '' : 's'} — posted, not paid` })}
      ${statCard('Not due yet', wonK(sum('upcoming')), { foot: `${n('upcoming')} still to post` })}
      ${statCard('Paid this month', wonK(paidMonth.reduce((a, r) => a + r.pay.amount, 0)), { foot: `${paidMonth.length} payment${paidMonth.length === 1 ? '' : 's'}` })}
    </div>
    <div class="card" style="padding:0">
      <div class="card-head" style="padding:14px 16px 10px"><h3>${esc(PAYOUT_TABS.find((t) => t[0] === pick)[1])}</h3>
        <div class="sp"></div>
        <button class="btn sm" id="poCsv" title="Names and amounts only — bank details never go in a file">Download CSV</button></div>
      ${list.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>
        <th>Creator</th><th>Campaign</th><th class="num">Amount</th><th>${pick === 'paid' ? 'Paid on' : 'Post'}</th><th>Bank</th><th></th>
      </tr></thead><tbody>${list.map((r) => `<tr data-poid="${esc(r.p.id)}">
        <td>${r.cr.handle ? whoHtml(r.cr, r.p.fullName || r.cr.name || '') : esc(r.p.fullName || '—')}</td>
        <td>${esc(r.cp.brand)}</td>
        <td class="num">${won(r.pay.amount)}</td>
        <td>${pick === 'paid' ? esc(r.pay.paidAt || 'paid') : `<span class="pill ${r.post.state === 'posted' ? 'green' : 'grey'}">${esc(r.post.label)}</span>`}</td>
        <td style="font-size:12.5px;color:var(--text-2)">${bankOf(r.cr)}</td>
        <td style="text-align:right;white-space:nowrap">
          ${pick === 'paid' ? '<button class="btn xs" data-pounpaid>Undo</button>' : `<button class="btn xs ${pick === 'due' ? 'primary' : ''}" data-popaid>Mark paid</button>`}
          <button class="btn xs" data-poopen>Open</button></td>
      </tr>`).join('')}</tbody></table></div>`
      : `<p class="card-sub" style="padding:0 16px 16px">Nothing here.</p>`}
    </div>`;

  const rowP = (b) => DB.participants.find((x) => x.id === b.closest('[data-poid]').dataset.poid);
  $$('[data-popaid]', view).forEach((b) => b.addEventListener('click', () => { markPaid(rowP(b)); toast('Marked paid'); notify(); }));
  $$('[data-pounpaid]', view).forEach((b) => b.addEventListener('click', () => {
    const p = rowP(b);
    p.payment = Object.assign({}, p.payment, { status: 'unpaid', paidAt: '' });
    notify();
  }));
  $$('[data-poopen]', view).forEach((b) => b.addEventListener('click', () => showParticipant(rowP(b).id)));
  $('#poCsv').addEventListener('click', () => {
    downloadFile(toCsv(['creator', 'handle', 'campaign', 'amount_krw', 'status', 'paid_on'],
      rows.map((r) => [r.p.fullName || r.cr.name || '', r.cr.handle || '', r.cp.brand, r.pay.amount, r.state, r.pay.paidAt || ''])),
      `vively-payouts-${iso(TODAY)}.csv`, 'text/csv;charset=utf-8');
  });
}

export function renderOverview(view, item, tab) {
  const all = DB.campaigns, act = activeCampaigns();
  if (!all.length) {
    view.innerHTML = emptyState('Nothing here yet',
      'Start a campaign by hand, or upload one of the VIVELY creator sheets and the influencer rows will be read in automatically — statuses, handles, followers, addresses and visit slots included.',
      { icon: '⌂' });
    return;
  }
  /* Needs attention became Today: one list, counted one way */
  if (item === 'attention') { location.replace('#/today'); return; }
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
