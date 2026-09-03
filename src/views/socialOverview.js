import { SERIES_HEX, barsH, lineChart } from '../charts/index.js';
import { columnChart, donutChart } from '../charts/socialViz.js';
import { kmb, num, pct } from '../lib/format.js';
import { DB, notify } from '../model/db.js';
import { OVERVIEW_METRICS, byCampaignRollup, byMarketRollup, byPlatformRollup, engagementSplit, overviewCoverage, overviewFilter, overviewKpis, overviewRows, overviewSeries, topContent, unmappedCountries, viewDistribution } from '../model/socialStats.js';
import { $, $$, esc } from '../ui/dom.js';
import { emptyState } from '../ui/html.js';
import { showSocialContent } from './social.js';

/* ============================================================
   SOCIAL — OVERVIEW

   Performance at a glance. The Content page next door stays the
   searchable operational database; this one exists to be read, not
   worked in, so there is no table on it.

   Both read the same DB.socialContent array and neither writes.
   ============================================================ */

export const soOverview = { from: '', to: '', campaign: '', platform: '', market: '', metric: 'views', dateMode: 'metrics' };

/* Injected once from here rather than added to the document head — the
   head is outside the region this module occupies, and editing it
   would shift every other module's anchors. */
export function ensureOverviewStyles() {
  if (document.getElementById('soOverviewCss')) return;
  const s = document.createElement('style');
  s.id = 'soOverviewCss';
  s.textContent = `
  .so-grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px;align-items:start}
  .so-grid > .card{min-width:0;margin:0}
  .so-c12{grid-column:span 12}.so-c8{grid-column:span 8}.so-c7{grid-column:span 7}
  .so-c5{grid-column:span 5}.so-c4{grid-column:span 4}.so-c2{grid-column:span 2}
  .so-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:10px}
  .so-head h4{margin:0;font-size:13px;font-weight:500}
  .so-hint{font:400 11px/1.35 'Roboto Mono',monospace;color:var(--text-3)}
  .so-kpi .label{font:500 10.5px/1.2 'Roboto Mono',monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3)}
  .so-kpi .value{font-size:23px;font-weight:400;letter-spacing:-.02em;margin-top:7px;line-height:1.1}
  .so-kpi .foot{margin-top:7px;min-height:29px;font:400 11px/1.3 'Roboto Mono',monospace;color:var(--text-3)}
  .so-meter{height:3px;border-radius:2px;background:var(--surface-3);overflow:hidden;margin-top:8px}
  .so-meter i{display:block;height:100%;background:var(--blue)}
  .so-seg{display:flex;gap:1px;background:var(--surface-2);border-radius:999px;padding:2px}
  .so-seg button{font:500 10.5px/1 Roboto,sans-serif;padding:5px 10px;border-radius:999px;border:0;
    background:transparent;color:var(--text-3);cursor:pointer}
  .so-seg button[aria-pressed="true"]{background:var(--surface-3);color:var(--text)}
  .so-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
  /* width:auto is doing real work — the app's global form rule sets
     inputs to 100%, which stacked the whole strip into one control per
     row and turned a compact filter bar into a giant form */
  .so-filters select,.so-filters input{background:var(--surface);border:1px solid var(--line);color:var(--text);
    border-radius:999px;padding:7px 12px;font-size:12.5px;font-family:inherit;
    width:auto;max-width:230px;margin:0;flex:0 0 auto}
  .so-filters .on{border-color:var(--blue);background:var(--blue-soft)}
  .so-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
  .so-tc{background:var(--surface-2);border:1px solid var(--line);border-radius:8px;overflow:hidden;
    display:flex;flex-direction:column;cursor:pointer;text-align:left;padding:0;font:inherit;color:inherit}
  .so-tc:hover{border-color:var(--line-strong)}
  .so-tc:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
  .so-tc .plate{aspect-ratio:4/3;position:relative;display:flex;align-items:flex-end;padding:9px}
  .so-tc .plate .big{font:500 19px/1 'Roboto Mono',monospace;color:#fff;text-shadow:0 1px 6px rgba(0,0,0,.6)}
  .so-tc .plate .tag{position:absolute;top:8px;left:8px;font:500 9.5px/1 'Roboto Mono',monospace;
    background:rgba(0,0,0,.42);color:#fff;border-radius:3px;padding:4px 5px;letter-spacing:.04em}
  .so-tc .body{padding:9px 10px 11px;display:flex;flex-direction:column;gap:6px}
  .so-tc .h{font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .so-tc .m{font:400 10.5px/1.35 'Roboto Mono',monospace;color:var(--text-3)}
  .so-tc .st{display:flex;gap:10px}
  .so-tc .st div{font:400 10px/1.3 'Roboto Mono',monospace;color:var(--text-3)}
  .so-tc .st b{display:block;font:500 12px/1.2 'Roboto Mono',monospace;color:var(--text)}
  .so-gap{font:500 10px/1 'Roboto Mono',monospace;color:var(--warning);border:1px solid rgba(250,178,25,.35);
    background:rgba(250,178,25,.08);border-radius:3px;padding:3px 5px;white-space:nowrap}
  .so-row{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;font-size:12px}
  @media(max-width:1000px){.so-grid{grid-template-columns:repeat(6,1fr)}
    .so-c12,.so-c8,.so-c7,.so-c5,.so-c4{grid-column:span 6}.so-c2{grid-column:span 3}
    .so-cards{grid-template-columns:repeat(2,1fr)}}
  @media(max-width:640px){.so-grid{grid-template-columns:1fr}
    .so-c12,.so-c8,.so-c7,.so-c5,.so-c4,.so-c2{grid-column:span 1}
    .so-cards{grid-template-columns:1fr}}`;
  document.head.appendChild(s);
}

export const SOCIAL_OVERVIEW_ITEMS = [
  { id: 'overview', label: 'Overview', sub: 'performance at a glance' }
];

/* Instagram truncated to two letters reads as "IN", which is not a
   platform anyone recognises. */
export const PLATFORM_TAGS = { Instagram: 'IG', TikTok: 'TT', YouTube: 'YT' };
export function platformTag(name) {
  return PLATFORM_TAGS[name] || String(name || '?').slice(0, 2).toUpperCase();
}

export function soCard(cls, title, hint, bodyId) {
  return `<div class="card ${cls}">
    <div class="so-head"><h4>${esc(title)}</h4>${hint ? `<span class="so-hint">${esc(hint)}</span>` : ''}</div>
    <div id="${bodyId}"></div>
  </div>`;
}

export function renderSocialOverview(view) {
  ensureOverviewStyles();
  const all = overviewRows(DB);

  if (!all.length) {
    view.innerHTML = emptyState('No published content yet',
      'Once creators submit links and someone records the numbers, this page fills in. ' +
      'The Content page next door is where individual posts are managed.');
    return;
  }

  const rows = overviewFilter(all, soOverview);
  const k = overviewKpis(rows);
  const campaignOpts = [...new Map(all.map((r) => [r.campaignId, r.campaignName])).entries()]
    .filter(([id]) => id).sort((a, b) => a[1].localeCompare(b[1]));
  const platformOpts = [...new Set(all.map((r) => r.platform))].sort();
  const marketOpts = [...new Set(all.map((r) => r.market).filter(Boolean))].sort();

  const sel = (id, label, value, opts) =>
    `<select id="${id}" class="${value ? 'on' : ''}" aria-label="${esc(label)}">
      <option value="">${esc(label)}: all</option>
      ${opts.map(([v, l]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('')}
    </select>`;

  view.innerHTML = `
    <div class="so-filters">
      <input type="date" id="soFrom" value="${esc(soOverview.from)}" class="${soOverview.from ? 'on' : ''}" aria-label="From"/>
      <input type="date" id="soTo" value="${esc(soOverview.to)}" class="${soOverview.to ? 'on' : ''}" aria-label="To"/>
      ${sel('soCampaign', 'Campaign', soOverview.campaign, campaignOpts)}
      ${sel('soPlatform', 'Platform', soOverview.platform, platformOpts.map((p) => [p, p]))}
      ${sel('soMarket', 'Market', soOverview.market, marketOpts.map((m) => [m, m]))}
      <button class="btn sm" id="soReset">Reset</button>
      <span class="so-hint">${num(rows.length)} of ${num(all.length)} posts</span>
    </div>

    <div class="so-grid">
      <div class="card stat so-kpi so-c2"><div class="label">Total content</div>
        <div class="value">${num(k.content)}</div>
        <div class="foot">${num(new Set(rows.map((r) => r.campaignId).filter(Boolean)).size)} campaigns</div></div>

      <div class="card stat so-kpi so-c2"><div class="label">Total views</div>
        <div class="value">${num(k.views)}</div>
        <div class="foot">${num(k.measuredCount)} of ${num(k.content)} measured</div>
        <div class="so-meter"><i style="width:${(k.coverage * 100).toFixed(1)}%"></i></div></div>

      <div class="card stat so-kpi so-c2"><div class="label">Engagements</div>
        <div class="value">${num(k.engagements)}</div>
        <div class="foot">likes · comments · shares</div></div>

      <div class="card stat so-kpi so-c2"><div class="label">Avg eng. rate</div>
        <div class="value">${k.rate == null ? '—' : k.rate.toFixed(2) + '<span style="font-size:13px;color:var(--text-2)">%</span>'}</div>
        <div class="foot">of measured views</div></div>

      <div class="card stat so-kpi so-c2"><div class="label">Avg views / post</div>
        <div class="value">${k.avgViews == null ? '—' : num(k.avgViews)}</div>
        <div class="foot">measured only <span class="so-gap">÷${num(k.measuredCount)}</span></div></div>

      <div class="card stat so-kpi so-c2"><div class="label">Creators activated</div>
        <div class="value">${num(k.creators)}</div>
        <div class="foot">of ${num((DB.creators || []).length)} on the roster</div>
        <div class="so-meter"><i style="width:${((DB.creators || []).length ? k.creators / DB.creators.length * 100 : 0).toFixed(1)}%"></i></div></div>

      <div class="card so-c8">
        <div class="so-head">
          <div><h4>Performance over time</h4>
            <div class="so-hint" style="margin-top:3px" id="soTimeNote"></div></div>
          <div class="so-seg" id="soMetricSeg">
            <button data-m="views" aria-pressed="${soOverview.metric === 'views'}">Views</button>
            <button data-m="eng" aria-pressed="${soOverview.metric === 'eng'}">Engagement</button>
            <button data-m="content" aria-pressed="${soOverview.metric === 'content'}">Published</button>
          </div>
        </div>
        <div id="soTime"></div>
        <div class="so-seg" id="soDateSeg" style="margin-top:10px;width:max-content">
          <button data-d="metrics" aria-pressed="${soOverview.dateMode === 'metrics'}">By measurement date</button>
          <button data-d="posted" aria-pressed="${soOverview.dateMode === 'posted'}">By publish date</button>
        </div>
      </div>

      ${soCard('so-c4', 'Platform breakdown', '', 'soPlatformViz')}
      ${soCard('so-c7', 'Campaign performance', 'click to open', 'soCampaignViz')}
      ${soCard('so-c5', 'Engagement breakdown', '', 'soEngViz')}
      ${soCard('so-c5', 'View distribution', '', 'soDistViz')}
      ${soCard('so-c7', 'Top performing content', 'click opens the post', 'soTopViz')}
      ${soCard('so-c7', 'Market performance', 'by creator nationality', 'soMarketViz')}
      ${soCard('so-c5', 'Measurement coverage', "what this page can't see yet", 'soCoverageViz')}
    </div>`;

  /* ---- filters drive everything ---- */
  const bind = (id, key) => {
    const el = $('#' + id);
    if (el) el.addEventListener('change', () => { soOverview[key] = el.value; notify(); });
  };
  bind('soFrom', 'from'); bind('soTo', 'to');
  bind('soCampaign', 'campaign'); bind('soPlatform', 'platform'); bind('soMarket', 'market');
  const reset = $('#soReset');
  if (reset) reset.addEventListener('click', () => {
    Object.assign(soOverview, { from: '', to: '', campaign: '', platform: '', market: '' });
    notify();
  });
  $$('#soMetricSeg button').forEach((b) => b.addEventListener('click', () => {
    soOverview.metric = b.dataset.m; notify();
  }));
  $$('#soDateSeg button').forEach((b) => b.addEventListener('click', () => {
    soOverview.dateMode = b.dataset.d; notify();
  }));

  /* ---- time ---- */
  const series = overviewSeries(rows, soOverview.dateMode);
  const withCurve = rows.filter((r) => (r.c.curve || []).length).length;
  const note = $('#soTimeNote');
  if (note) {
    note.textContent = withCurve
      ? `${num(withCurve)} posts have daily history`
      : `${series.length} ${soOverview.dateMode === 'posted' ? 'publish' : 'measurement'} date${series.length === 1 ? '' : 's'}` +
        ' · daily accrual not collected yet';
  }
  const timeMount = $('#soTime');
  if (timeMount) {
    if (!series.length) {
      timeMount.innerHTML = '<div class="empty" style="padding:26px">No dated posts in this selection.</div>';
    } else {
      const key = soOverview.metric === 'eng' ? 'engagements' : soOverview.metric === 'content' ? 'content' : 'views';
      lineChart(timeMount, {
        labels: series.map((p) => p.date.slice(5)),
        series: [{ name: OVERVIEW_METRICS[soOverview.metric === 'eng' ? 'eng' : soOverview.metric].label,
                   values: series.map((p) => p[key]), color: SERIES_HEX[0], area: true }],
        height: 240,
        format: soOverview.metric === 'content' ? num : kmb
      });
    }
  }

  /* ---- platform ---- */
  const platMount = $('#soPlatformViz');
  if (platMount) {
    const seen = byPlatformRollup(rows);
    const order = ['Instagram', 'TikTok', 'YouTube', 'Other'];
    const parts = order.map((name, i) => {
      const g = seen.find((s) => s.key === name);
      return { label: name, value: g ? g.content : 0, color: SERIES_HEX[i] };
    });
    seen.filter((s) => !order.includes(s.key))
      .forEach((s, i) => parts.push({ label: s.key, value: s.content, color: SERIES_HEX[(order.length + i) % 7] }));
    donutChart(platMount, parts, { centreLabel: 'POSTS', aria: 'posts by platform', labelHead: 'Platform' });
  }

  /* ---- campaigns ---- */
  const cMount = $('#soCampaignViz');
  if (cMount) {
    const metric = OVERVIEW_METRICS[soOverview.metric] || OVERVIEW_METRICS.views;
    const groups = byCampaignRollup(rows).sort((a, b) => metric.of(b) - metric.of(a));
    if (!groups.length) {
      cMount.innerHTML = '<div class="empty" style="padding:18px">No campaigns in this selection.</div>';
    } else {
      barsH(cMount, groups.map((g) => ({
        label: g.label,
        value: Math.round(metric.of(g) * (soOverview.metric === 'rate' ? 100 : 1)) / (soOverview.metric === 'rate' ? 100 : 1),
        sub: g.measured ? '' : `${g.content} posts · no metrics entered`,
        color: g.measured ? 'var(--s1)' : 'var(--surface-3)'
      })), { labelWidth: '150px', labelHead: 'Campaign', valueHead: metric.label,
             format: soOverview.metric === 'rate' ? (v) => v.toFixed(2) + '%' : kmb });
      /* the bars are the navigation — clicking one filters the page to
         that campaign, which is what a reader reaches for next */
      [...cMount.querySelectorAll('div[title]')].forEach((row, i) => {
        if (!groups[i]) return;
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => { soOverview.campaign = groups[i].key; notify(); });
      });
    }
  }

  /* ---- engagement ---- */
  const eMount = $('#soEngViz');
  if (eMount) {
    const split = engagementSplit(rows);
    eMount.innerHTML = `<div style="display:flex;flex-direction:column;gap:11px">${
      split.parts.map((p, i) => `<div style="${p.unavailable ? 'opacity:.62' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:5px;font-size:12px">
          <span>${esc(p.label)}</span>
          ${p.unavailable
            ? `<span class="so-gap">${p.id === 'saves' ? 'not in the Notion form' : 'none recorded'}</span>`
            : `<span style="font:500 11.5px/1 'Roboto Mono',monospace;color:var(--text-2)">${num(p.value)} · ${pct(p.share, 1)}</span>`}
        </div>
        <div style="height:9px;border-radius:3px;overflow:hidden;background:${p.unavailable
          ? 'repeating-linear-gradient(135deg,var(--surface-2) 0 5px,var(--surface-3) 5px 10px)'
          : 'var(--surface-2)'}">
          ${p.unavailable ? '' : `<i style="display:block;height:100%;width:${(p.share * 100).toFixed(1)}%;background:${SERIES_HEX[i]}"></i>`}
        </div></div>`).join('')}
      <div class="so-hint" style="padding-top:8px;border-top:1px solid var(--line)">${num(split.total)} engagements in total</div>
    </div>`;
  }

  /* ---- distribution ---- */
  const dMount = $('#soDistViz');
  if (dMount) {
    const dist = viewDistribution(rows);
    columnChart(dMount, dist.buckets.map((b) => ({ label: b.label, value: b.n })), {
      aria: 'posts by view count', labelHead: 'View bucket',
      foot: dist.unmeasured ? `+ ${num(dist.unmeasured)} posts not measured — kept out of the buckets` : ''
    });
  }

  /* ---- top content ---- */
  const tMount = $('#soTopViz');
  if (tMount) {
    const top = topContent(rows, 6);
    if (!top.length) {
      tMount.innerHTML = '<div class="empty" style="padding:18px">No measured posts in this selection.</div>';
    } else {
      tMount.innerHTML = `<div class="so-cards">${top.map((r) => {
        /* no thumbnails exist — thumbnailUrl is empty on every record,
           because Instagram will not serve one without the creator's
           authorisation. The record's own tint stands in, so the card
           still reads as a piece of content rather than a table row. */
        const tint = r.c.thumbTint || SERIES_HEX[0];
        return `<button class="so-tc" data-id="${esc(r.id)}">
          <span class="plate" style="background:linear-gradient(150deg,${esc(tint)},rgba(0,0,0,.55))">
            <span class="tag">${esc(platformTag(r.platform))} ${esc((r.c.format || 'POST').toUpperCase())}</span>
            <span class="big">${kmb(r.views)}</span>
          </span>
          <span class="body">
            <span class="h">${esc(r.handle || 'unknown')}</span>
            <span class="m">${esc(r.campaignName)}${r.market ? ' · ' + esc(r.market) : ''}</span>
            <span class="st">
              <div>ER<b>${r.rate == null ? '—' : r.rate.toFixed(2) + '%'}</b></div>
              <div>vs followers<b>${r.viewsPerFollower == null ? '—' : r.viewsPerFollower.toFixed(1) + '×'}</b></div>
            </span>
          </span>
        </button>`;
      }).join('')}</div>`;
      $$('#soTopViz .so-tc').forEach((b) => b.addEventListener('click', () => showSocialContent(b.dataset.id)));
    }
  }

  /* ---- markets ---- */
  const mMount = $('#soMarketViz');
  if (mMount) {
    const groups = byMarketRollup(rows).sort((a, b) => b.views - a.views).slice(0, 8);
    if (!groups.length) {
      mMount.innerHTML = '<div class="empty" style="padding:18px">No creator nationalities recorded.</div>';
    } else {
      barsH(mMount, groups.map((g) => ({
        label: g.label, value: g.views,
        sub: g.measured ? '' : `${g.content} posts · no metrics entered`,
        color: g.measured ? 'var(--s1)' : 'var(--surface-3)'
      })), { labelWidth: '120px', labelHead: 'Market', valueHead: 'Views' });
      const unmapped = unmappedCountries(DB.creators || []);
      if (unmapped.length) {
        const n = document.createElement('div');
        n.className = 'so-hint';
        n.style.cssText = 'margin-top:11px;padding-top:10px;border-top:1px solid var(--line)';
        n.textContent = `${unmapped.length} nationality spelling${unmapped.length === 1 ? '' : 's'} not in the map yet: ` +
          unmapped.slice(0, 4).map((u) => u.value).join(', ') + (unmapped.length > 4 ? '…' : '');
        mMount.appendChild(n);
      }
    }
  }

  /* ---- coverage ---- */
  const covMount = $('#soCoverageViz');
  if (covMount) {
    covMount.innerHTML = overviewCoverage(rows, DB).map((c) => `
      <div style="margin-bottom:10px">
        <div class="so-row" style="${c.have ? '' : 'color:var(--text-3)'}">
          <span>${esc(c.label)}${c.note ? ` <span class="so-hint">· ${esc(c.note)}</span>` : ''}</span>
          <span style="font:500 11.5px/1 'Roboto Mono',monospace;color:var(--text-2)">${num(c.have)} / ${num(c.of)}</span>
        </div>
        <div class="so-meter"><i style="width:${c.of ? (c.have / c.of * 100).toFixed(1) : 0}%"></i></div>
      </div>`).join('');
  }
}
