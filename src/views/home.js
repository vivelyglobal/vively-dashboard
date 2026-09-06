import { barsH, funnelView, lineChart } from '../charts/index.js';
import { columnChart, donutChart } from '../charts/socialViz.js';
import { DAY, TODAY, dLabel } from '../lib/dates.js';
import { kmb, num } from '../lib/format.js';
import { DB } from '../model/db.js';
import { HOME_METRICS, activityFeed, attentionCounts, campaignPerformance, campaignPipeline, completionSplit, creatorPipeline, homeKpis, trendWindow } from '../model/homeStats.js';
import { overviewRows, overviewSeries, topContent } from '../model/socialStats.js';
import { $, $$, esc } from '../ui/dom.js';
import { emptyState } from '../ui/html.js';
import { showSocialContent } from './social.js';
import { ensureOverviewStyles, platformTag } from './socialOverview.js';

/* ============================================================
   HOME — the page

   White, minimal, asymmetric. Same cards, same series variables, same
   mono figures as the rest of the app; the only new visual weight is
   the amber rule on Needs Attention.

   Its CSS is injected at runtime rather than added to the head, for
   the same reason the Social Overview's is: the head stylesheet is
   itself a module with a line range, and adding a rule to it would
   shift every anchor after it.
   ============================================================ */

export const home = { metric: 'views', range: 30, dateMode: 'metrics' };

export function ensureHomeStyles() {
  if (document.getElementById('hmCss')) return;
  const s = document.createElement('style');
  s.id = 'hmCss';
  s.textContent = `
  .hm-grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px;align-items:start}
  .hm-grid > .card{min-width:0;margin:0}
  .hm-c12{grid-column:span 12}.hm-c8{grid-column:span 8}.hm-c7{grid-column:span 7}
  .hm-c5{grid-column:span 5}.hm-c4{grid-column:span 4}
  .hm-kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:14px}
  .hm-kpis > .card{margin:0;min-width:0}
  .hm-att{border-left:3px solid var(--warning)}
  .hm-att .row{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;
    padding:9px 2px;border-bottom:1px solid var(--line);text-decoration:none;color:inherit}
  .hm-att .row:last-of-type{border-bottom:0}
  .hm-att .row:hover{background:var(--surface-2)}
  .hm-att .n{font:500 14px/1 'Roboto Mono',monospace;min-width:26px;text-align:right}
  .hm-att .row.zero .n,.hm-att .row.zero .t{color:var(--text-3)}
  .hm-att .t{font-size:12.5px}
  .hm-att .go{color:var(--text-3);font-size:12px}
  .hm-note{font:400 11px/1.5 'Roboto Mono',monospace;color:var(--text-3);margin-top:10px}
  .hm-warn{font:400 11px/1.5 'Roboto Mono',monospace;color:var(--warning);margin-top:8px}
  .hm-blank{border:1px dashed var(--line-strong);border-radius:8px;padding:18px;text-align:center;
    color:var(--text-3);font-size:12.5px;line-height:1.6}
  .hm-blank b{display:block;color:var(--text-2);font-weight:500;margin-bottom:5px}
  .hm-feed{display:flex;flex-direction:column;gap:0}
  .hm-feed .e{display:grid;grid-template-columns:52px 1fr;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);font-size:12.5px}
  .hm-feed .e:last-child{border-bottom:0}
  .hm-feed .d{font:400 10.5px/1.5 'Roboto Mono',monospace;color:var(--text-3)}
  .hm-feed .w{color:var(--text-3);font-size:11.5px}
  @media(max-width:1000px){
    .hm-grid{grid-template-columns:repeat(6,1fr)}
    .hm-c12,.hm-c8,.hm-c7,.hm-c5,.hm-c4{grid-column:span 6}
    .hm-kpis{grid-template-columns:repeat(3,1fr)}
  }
  @media(max-width:760px){
    .hm-grid{grid-template-columns:1fr;gap:12px}
    .hm-grid > .card{grid-column:auto}
    .hm-kpis{grid-template-columns:repeat(2,1fr);gap:10px}
    .hm-kpis > .card:nth-child(5){grid-column:span 2}
    /* the funnel's 150px label track leaves 148px of usable width at
       390px, which is not enough for a stage name and a bar */
    .fn-row{grid-template-columns:92px 1fr 64px !important;gap:8px}
    /* Views | Engagement | Creators | Completion is 446px of pills in a
       390px viewport, and .seg is an inline-flex that does not wrap —
       so it dragged the whole document sideways rather than overflowing
       its own card. Wrapping to two rows is the price of keeping four
       readable labels; truncating them would be worse. */
    .hm-grid .so-head{flex-wrap:wrap;row-gap:8px}
    .hm-grid .seg{display:flex;flex-wrap:wrap;max-width:100%}
    .hm-grid .seg button{flex:0 1 auto;padding:8px 11px}
  }`;
  document.head.appendChild(s);
}

export const hmKpi = (label, value, foot, meter) => `<div class="card stat so-kpi">
  <div class="label">${esc(label)}</div>
  <div class="value">${value}</div>
  <div class="foot">${foot || ''}</div>
  ${meter == null ? '' : `<div class="so-meter"><i style="width:${(meter * 100).toFixed(1)}%"></i></div>`}
</div>`;

export const hmSeg = (id, opts, cur) => `<div class="seg" id="${id}">${opts
  .map(([v, l]) => `<button data-v="${esc(String(v))}" class="${String(v) === String(cur) ? 'active' : ''}">${esc(l)}</button>`)
  .join('')}</div>`;

export function renderHome(view) {
  ensureOverviewStyles();
  ensureHomeStyles();

  if (!DB.campaigns.length) {
    view.innerHTML = emptyState('Nothing here yet',
      'Import a campaign from Excel or Notion and this page fills itself in.');
    return;
  }

  const rows = overviewRows(DB);
  const k = homeKpis(DB, rows);
  const att = attentionCounts(DB, rows);
  const comp = completionSplit(DB);
  const pipe = campaignPipeline(DB);
  const activeIds = DB.campaigns.filter((c) => c.status !== 'wrapped').map((c) => c.id);
  const funnel = creatorPipeline(DB, activeIds);
  const series = overviewSeries(rows, home.dateMode);
  const win = trendWindow(series, home.range);
  const top = topContent(rows, 6);
  const feed = activityFeed(DB, rows, 8);

  view.innerHTML = `
    <div class="hm-kpis">
      ${hmKpi('Active campaigns', num(k.activeCampaigns),
        `${num(k.totalCampaigns)} total · ${num(k.liveCampaigns)} live · ${num(k.wrappedCampaigns)} wrapped`)}
      ${hmKpi('Creators in campaigns', num(k.creatorsInCampaigns),
        `${num(k.confirmedEver)} confirmed all-time`)}
      ${hmKpi('Creators contacted', num(k.creatorsContacted),
        `of ${num(k.roster)} on the roster`, k.roster ? k.creatorsContacted / k.roster : 0)}
      ${hmKpi('Content published', num(k.content),
        `${num(k.measuredCount)} of ${num(k.content)} measured`, k.coverage)}
      ${hmKpi('Total campaign views', num(k.views),
        k.avgViews == null ? 'nothing measured yet' : `${num(k.measuredCount)} posts · ${num(k.avgViews)} avg`, k.coverage)}
    </div>

    <div class="hm-grid">
      <div class="card hm-att hm-c4">
        <div class="so-head"><h4>Needs attention</h4><span class="so-hint">${num(att.urgent)} to act on</span></div>
        ${att.items.map((i) => `<a class="row ${i.n ? '' : 'zero'}" href="${i.href}">
            <span class="n">${num(i.n)}</span><span class="t">${esc(i.label)}</span><span class="go">›</span></a>`).join('')}
        ${att.noEnd ? `<div class="hm-warn">${num(att.noEnd)} active campaign${att.noEnd === 1 ? ' has' : 's have'} no end date, so they cannot be counted as overdue or ending soon.</div>` : ''}
      </div>

      <div class="card hm-c8">
        <div class="so-head"><h4>Campaign performance</h4>
          ${hmSeg('hmMetric', Object.keys(HOME_METRICS).map((m) => [m, HOME_METRICS[m].label]), home.metric)}</div>
        <div id="hmPerf"></div>
      </div>

      <div class="card hm-c5">
        <div class="so-head"><h4>Campaign pipeline</h4><span class="so-hint">${num(pipe.total)} campaigns</span></div>
        <div id="hmPipe"></div>
        <div class="hm-note">These are the statuses the campaign editor uses. There is no “Recruiting” or “Reporting” in the schema — Outreach and Wrapped are their real names.</div>
      </div>

      <div class="card hm-c7">
        <div class="so-head"><h4>Creator pipeline</h4><span class="so-hint">drop-off · active campaigns</span></div>
        <div id="hmFunnel"></div>
        <div class="hm-note">${num(funnel.dropped)} of ${num(funnel.total)} dropped out or declined.
          Contacted and Replied are not tracked separately by the Notion form, so both read as pass-through.</div>
      </div>

      <div class="card hm-c4">
        <div class="so-head"><h4>Campaign completion</h4></div>
        <div id="hmDonut"></div>
      </div>

      <div class="card hm-c8">
        <div class="so-head"><h4>Trends</h4>
          ${hmSeg('hmRange', [[7, '7d'], [30, '30d'], [90, '90d']], home.range)}</div>
        <div class="grid g2" style="gap:14px">
          <div><div class="so-head"><h4>Views over time</h4></div><div id="hmViews"></div></div>
          <div><div class="so-head"><h4>Content published over time</h4></div><div id="hmPosts"></div></div>
        </div>
        <div class="hm-note">Plotted by measurement date. Publish dates carry only
          ${num(new Set(rows.map((r) => String(r.c.postedAt || '').slice(0, 10)).filter(Boolean)).size)}
          distinct values across ${num(rows.length)} posts, so they cannot carry a time axis.</div>
      </div>

      <div class="card hm-c8">
        <div class="so-head"><h4>Top performing content</h4><span class="so-hint">by views · measured only</span></div>
        <div id="hmTop"></div>
      </div>

      <div class="card hm-c4">
        <div class="so-head"><h4>Recent activity</h4></div>
        <div id="hmFeed"></div>
        <div class="hm-note">Derived from measurement and sync timestamps — not an event log.
          Creator stage changes are not timestamped individually, so they cannot appear here.</div>
      </div>
    </div>`;

  drawHomePerf(rows);
  drawHomePipeline(pipe, funnel, comp);
  drawHomeTrends(series, win, rows);
  drawHomeTop(top);
  drawHomeFeed(feed);
  wireHome(rows, series);
}

export function drawHomePerf(rows) {
  const mount = $('#hmPerf');
  if (!mount) return;
  mount.innerHTML = '';
  const perf = campaignPerformance(DB, rows, home.metric);
  if (!perf.length) {
    mount.innerHTML = '<div class="hm-blank"><b>No campaigns with a roster yet</b>Confirm a creator or attach a post and this fills in.</div>';
    return;
  }
  const isPct = home.metric === 'completion';
  const fmt = (v) => (isPct ? Math.round(v) + '%' : kmb(v));
  const wrap = barsH(mount, perf.map((r) => ({
    label: r.label,
    value: r.value,
    /* an unmeasured campaign is drawn in the neutral surface colour so
       it cannot be mistaken for a campaign that scored zero */
    color: r.unmeasured || r.noTarget ? 'var(--surface-3)' : 'var(--s1)',
    sub: r.unmeasured ? r.content + ' posts · no metrics entered'
       : r.noTarget ? 'no target set' : ''
  })), { format: fmt, labelWidth: window.innerWidth <= 760 ? '96px' : '150px', labelHead: 'Campaign', valueHead: HOME_METRICS[home.metric].label });

  const flagged = perf.filter((r) => r.unmeasured || r.noTarget);
  if (flagged.length) {
    const note = document.createElement('div');
    note.className = 'hm-warn';
    note.textContent = home.metric === 'completion'
      ? flagged.length + ' campaign(s) have no creator target, so completion cannot be computed for them.'
      : flagged.map((r) => r.label).join(', ') + ' — posts are attached but no view counts have been entered.';
    mount.appendChild(note);
  }
  if (home.metric === 'engagement') {
    const s = document.createElement('div');
    s.className = 'hm-note';
    s.textContent = 'Likes, comments and shares. Saves are not collected by the Notion form, so they are absent rather than zero.';
    mount.appendChild(s);
  }

  /* barsH renders one row element per entry, in order, inside a single
     list container — so index maps to campaign. Depends on that shape;
     the harness clicks a bar and asserts where it lands. */
  const list = wrap && wrap.firstChild;
  if (list) [].slice.call(list.children).forEach((row, i) => {
    if (!perf[i]) return;
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => { location.hash = '#/campaigns/' + perf[i].id; });
  });
}

export function drawHomePipeline(pipe, funnel, comp) {
  const p = $('#hmPipe');
  if (p) { p.innerHTML = ''; columnChart(p, pipe.rows, { labelHead: 'Status' }); }

  const f = $('#hmFunnel');
  if (f) { f.innerHTML = ''; funnelView(f, funnel.counts, funnel.total); }

  const d = $('#hmDonut');
  if (!d) return;
  d.innerHTML = '';
  donutChart(d, [
    { label: 'Complete', value: comp.complete.length, color: 'var(--s3)' },
    { label: 'Pending',  value: comp.pending.length,  color: 'var(--s1)' },
    { label: 'Overdue',  value: comp.overdue.length,  color: 'var(--s6)' }
  ], { centre: 'campaigns' });
  if (comp.noEnd.length) {
    const n = document.createElement('div');
    n.className = 'hm-warn';
    n.textContent = comp.noEnd.length + ' campaign(s) have no end date and can never be counted overdue.';
    d.appendChild(n);
  }
}

/* The two cards that would have lied. A window with nothing in it says
   so and offers the whole range; a window with one reading draws the
   reading and says why there is no line. Neither is ever handed a
   zero-filled array. */
export function drawHomeTrend(mount, win, key, label) {
  if (!mount) return;
  mount.innerHTML = '';
  if (win.state === 'empty') {
    mount.innerHTML = `<div class="hm-blank"><b>No measurements in the last ${win.days} days</b>` +
      (win.latest
        ? `The most recent reading is ${esc(win.latest)}${win.daysAgo == null ? '' : ` — ${win.daysAgo} days ago`}.`
        : 'Nothing has been measured yet.') +
      (win.total ? '<div style="margin-top:10px"><button class="btn sm" data-all="1">Show all time</button></div>' : '') +
      '</div>';
    return;
  }
  if (win.state === 'single') {
    const p = win.points[0];
    mount.innerHTML = `<div class="hm-blank"><b>${esc(label)}: ${num(p[key])}</b>` +
      `One measurement in this window, on ${esc(p.date)}. A line needs two.` +
      (win.total > 1 ? '<div style="margin-top:10px"><button class="btn sm" data-all="1">Show all time</button></div>' : '') +
      '</div>';
    return;
  }
  lineChart(mount, {
    labels: win.points.map((p) => p.date),
    series: [{ name: label, values: win.points.map((p) => p[key]) }],
    height: 190
  });
}

export function drawHomeTrends(series, win, rows) {
  drawHomeTrend($('#hmViews'), win, 'views', 'Views');
  drawHomeTrend($('#hmPosts'), win, 'content', 'Posts measured');
}

export function drawHomeTop(top) {
  const mount = $('#hmTop');
  if (!mount) return;
  if (!top.length) {
    mount.innerHTML = '<div class="hm-blank"><b>No measured posts yet</b>Enter a view count on a post and the best of them appear here.</div>';
    return;
  }
  mount.innerHTML = '<div class="so-cards">' + top.map((r) => {
    /* thumbnailUrl is empty on every record — Instagram will not serve
       one without the creator's authorisation — so the plate is a
       deterministic colour per creator rather than a broken image */
    const tint = r.c.thumbTint || 'var(--s1)';
    return `<button class="so-tc" data-id="${esc(r.id)}">
      <span class="plate" style="background:linear-gradient(150deg,${esc(tint)},rgba(0,0,0,.55))">
        <span class="tag">${esc(platformTag(r.platform))} ${esc((r.c.format || 'POST').toUpperCase())}</span>
        <span class="big">${kmb(r.views)}</span>
      </span>
      <span class="body">
        <span class="h">${esc(r.handle || '—')}</span>
        <span class="m">${esc(r.campaignName)}${r.market ? ' · ' + esc(r.market) : ''}</span>
        <span class="st">
          <div>ER<b>${r.rate == null ? '—' : r.rate.toFixed(1) + '%'}</b></div>
          <div>vs followers<b>${r.viewsPerFollower == null ? '—' : r.viewsPerFollower.toFixed(1) + '×'}</b></div>
        </span>
      </span>
    </button>`;
  }).join('') + '</div>';

  $$('#hmTop .so-tc').forEach((b) => b.addEventListener('click', () => showSocialContent(b.dataset.id)));
}

export function drawHomeFeed(feed) {
  const mount = $('#hmFeed');
  if (!mount) return;
  if (!feed.length) {
    mount.innerHTML = '<div class="hm-blank"><b>Nothing dated yet</b>Measurements and imports appear here as they happen.</div>';
    return;
  }
  mount.innerHTML = '<div class="hm-feed">' + feed.map((e) => `<div class="e">
      <span class="d">${esc(dLabel(e.at))}</span>
      <span>${esc(e.text)}${e.who ? `<span class="w"> · ${esc(e.who)}</span>` : ''}</span>
    </div>`).join('') + '</div>';
}

export function wireHome(rows, series) {
  const seg = (id, apply) => {
    const el = $('#' + id);
    if (!el) return;
    $$('#' + id + ' button').forEach((b) => b.addEventListener('click', () => {
      apply(b.dataset.v);
      $$('#' + id + ' button').forEach((x) => x.classList.toggle('active', x === b));
    }));
  };
  seg('hmMetric', (v) => { home.metric = v; drawHomePerf(rows); });
  seg('hmRange', (v) => { home.range = Number(v); drawHomeTrends(series, trendWindow(series, home.range), rows); });

  /* "Show all time" widens the window to cover every reading rather
     than pretending the empty one had data in it */
  $$('#hmViews [data-all], #hmPosts [data-all]').forEach((b) => b.addEventListener('click', () => {
    const span = series.length
      ? Math.max(1, Math.round((TODAY - new Date(series[0].date + 'T00:00:00Z')) / DAY) + 1)
      : 1;
    home.range = span;
    drawHomeTrends(series, trendWindow(series, span), rows);
  }));
}
