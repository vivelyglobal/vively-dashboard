import { SERIES_HEX, barsH, lineChart } from '../charts/index.js';
import { columnChart } from '../charts/socialViz.js';
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
  /* two columns, not one: the KPI tiles pair up and every chart spans
     the full width, which halves the scroll without shrinking a chart */
  @media(max-width:640px){.so-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
    .so-c12,.so-c8,.so-c7,.so-c5,.so-c4{grid-column:span 2}
    .so-c2{grid-column:span 1}
    .so-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}

  /* ---------- pass 02: the command band and its language ----------
     Appended rather than replacing the rules above, because home.js and
     the chart code both style against them. Later rules win, so the new
     composition overrides the old card grid without breaking anything
     that still reads the old class names. */
  .so-band{background:#0C1211;color:#F1F6F3;border-radius:14px;padding:30px 28px 24px;margin-bottom:34px;
    background-image:radial-gradient(120% 130% at 88% -10%,rgba(47,168,140,.16),transparent 58%)}
  .so-band-in{display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr);gap:44px;align-items:start}
  .so-lab{font:500 10.5px/1 'Roboto Mono',monospace;letter-spacing:.15em;text-transform:uppercase;color:#7E938B}
  .so-big{font-size:clamp(48px,7vw,74px);font-weight:600;line-height:.94;letter-spacing:-.04em;margin-top:12px;
    font-variant-numeric:tabular-nums}
  .so-band .so-sub{color:#7E938B;font-size:13px;margin-top:11px}
  .so-sats{display:flex;gap:34px;flex-wrap:wrap;margin-top:22px;padding-top:20px;border-top:1px solid #22302C}
  .so-sat .l{font:500 10px/1 'Roboto Mono',monospace;letter-spacing:.13em;text-transform:uppercase;color:#7E938B}
  .so-sat .v{font-size:25px;font-weight:600;letter-spacing:-.028em;margin-top:8px;font-variant-numeric:tabular-nums}
  .so-sat .v.off{color:#7E938B}
  .so-sat .s{font:400 10.5px/1.3 'Roboto Mono',monospace;color:#7E938B;margin-top:5px}
  .so-chart-h{display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin-bottom:12px}
  .so-chart-h .t{font:500 10px/1 'Roboto Mono',monospace;letter-spacing:.13em;text-transform:uppercase;color:#7E938B}
  .so-band .so-seg{background:#151E1B;border-radius:7px;padding:3px;display:flex;gap:2px}
  .so-band .so-seg button{border:0;background:none;color:#7E938B;font-size:11.5px;font-weight:500;
    padding:6px 10px;border-radius:5px;cursor:pointer;font-family:inherit}
  .so-band .so-seg button[aria-pressed="true"]{background:#0C1211;color:#F1F6F3}
  .so-band .so-hint{color:#7E938B}
  .so-band .so-filters{margin:24px 0 0;padding-top:20px;border-top:1px solid #22302C}
  .so-band .so-filters select,.so-band .so-filters input{background:#151E1B;border-color:#2A3733;color:#F1F6F3}
  .so-band .so-filters .btn{background:#151E1B;border-color:#2A3733;color:#F1F6F3}

  /* sections, not boxes */
  .so-flow{display:flex;flex-direction:column;gap:46px}
  .so-sec{display:flex;align-items:baseline;gap:12px;margin-bottom:16px}
  .so-sec h4{margin:0;font-size:15px;font-weight:600;letter-spacing:-.015em;white-space:nowrap}
  .so-sec .ln{flex:1;height:1px;background:var(--line)}
  .so-duo{display:grid;grid-template-columns:1.62fr 1fr;gap:38px;align-items:start}
  .so-duo.flip{grid-template-columns:1fr 1.62fr}
  .so-flow .card{background:none;border:0;box-shadow:none;padding:0;margin:0}

  /* momentum */
  .so-mrail{height:42px;border-radius:9px;background:var(--surface-2);display:flex;align-items:center;
    justify-content:center;position:relative;overflow:hidden}
  .so-mrail::before{content:'';position:absolute;inset:0;
    background:repeating-linear-gradient(115deg,transparent 0 9px,var(--line) 9px 10px)}
  .so-mrail span{position:relative;font:500 12px/1 'Roboto Mono',monospace;color:var(--text-3)}
  .so-mkeys{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-top:11px}
  .so-mk{padding:13px 11px;border-radius:9px;background:var(--surface-2)}
  .so-mk .n{font-size:21px;font-weight:600;color:var(--text-3);letter-spacing:-.02em}
  .so-mk .l{font:500 9.5px/1 'Roboto Mono',monospace;letter-spacing:.1em;text-transform:uppercase;
    color:var(--text-3);margin-top:8px}

  /* richer content plates */
  .so-cards{grid-template-columns:repeat(auto-fit,minmax(168px,1fr))}
  .so-tc{border-radius:12px}
  .so-tc .plate{aspect-ratio:4/5;justify-content:space-between}
  .so-tc .plate .big{font-size:26px;font-weight:600;letter-spacing:-.03em}
  .so-tc .vl{font:400 9.5px/1 'Roboto Mono',monospace;color:rgba(255,255,255,.72);
    letter-spacing:.1em;text-transform:uppercase;margin-top:6px}
  .so-tc:hover{transform:translateY(-3px)}
  .so-tc{transition:transform .18s ease,border-color .18s ease}

  @media(max-width:1000px){
    .so-band-in{grid-template-columns:1fr;gap:30px}
    .so-duo,.so-duo.flip{grid-template-columns:1fr;gap:32px}
    .so-mkeys{grid-template-columns:repeat(2,1fr)}
  }`;
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

  /* Only history can answer "how fast" — nothing here invents it. When no
     post carries a curve the velocity satellites read as dashes with the
     reason, which is the honest state until the collector ships. */
  const withHistory = rows.filter((r) => (r.c.curve || []).length).length;
  const platformLine = byPlatformRollup(rows).sort((a, b) => b.content - a.content)
    .map((g) => num(g.content) + ' ' + g.key).join(' · ');
  const suggested = rows.filter((r) => r.c.matchStatus === 'suggested').length;
  const unassigned = rows.filter((r) => !r.campaignId || r.c.matchStatus === 'unassigned').length;
  const seg = (id, key, opts, extra) => `<div class="so-seg" id="${id}"${extra || ''}>${opts
    .map(([v, l]) => `<button data-${key}="${v}" aria-pressed="${soOverview[key === 'm' ? 'metric' : 'dateMode'] === v}">${l}</button>`)
    .join('')}</div>`;

  view.innerHTML = `
    <div class="so-band">
      <div class="so-band-in">
        <div>
          <div class="so-lab">Total views</div>
          <div class="so-big">${num(k.views)}</div>
          <div class="so-sub">${num(k.content)} total content · ${num(k.measuredCount)} measured
            · ${pct(k.coverage, 0)} coverage${platformLine ? ' · ' + esc(platformLine) : ''}</div>
          <div class="so-sats">
            <div class="so-sat"><div class="l">+24h</div><div class="v off">—</div>
              <div class="s">${withHistory ? num(withHistory) + ' posts have history' : 'awaiting daily tracking'}</div></div>
            <div class="so-sat"><div class="l">+7d</div><div class="v off">—</div>
              <div class="s">awaiting daily tracking</div></div>
            <div class="so-sat"><div class="l">Avg eng. rate</div>
              <div class="v">${k.rate == null ? '—' : k.rate.toFixed(2) + '%'}</div>
              <div class="s">${num(k.engagements)} engagements</div></div>
            <div class="so-sat"><div class="l">Avg views / post</div>
              <div class="v">${k.avgViews == null ? '—' : num(k.avgViews)}</div>
              <div class="s">measured only</div></div>
            <div class="so-sat"><div class="l">Creators activated</div>
              <div class="v">${num(k.creators)}</div>
              <div class="s">of ${num((DB.creators || []).length)} on the roster</div></div>
          </div>
        </div>

        <div>
          <div class="so-chart-h"><span class="t">Performance over time</span>
            ${seg('soMetricSeg', 'm', [['views', 'Views'], ['eng', 'Engagement'], ['content', 'Published']])}</div>
          <div id="soTime"></div>
          <div class="so-hint" id="soTimeNote" style="margin-top:9px"></div>
          ${seg('soDateSeg', 'd', [['metrics', 'By measurement date'], ['posted', 'By publish date']],
                ' style="margin-top:11px;width:max-content"')}
        </div>
      </div>

      <div class="so-filters">
        <input type="date" id="soFrom" value="${esc(soOverview.from)}" class="${soOverview.from ? 'on' : ''}" aria-label="From"/>
        <input type="date" id="soTo" value="${esc(soOverview.to)}" class="${soOverview.to ? 'on' : ''}" aria-label="To"/>
        ${sel('soCampaign', 'Campaign', soOverview.campaign, campaignOpts)}
        ${sel('soPlatform', 'Platform', soOverview.platform, platformOpts.map((pl) => [pl, pl]))}
        ${sel('soMarket', 'Market', soOverview.market, marketOpts.map((m) => [m, m]))}
        <button class="btn sm" id="soReset">Reset</button>
        <span class="so-hint">${num(rows.length)} of ${num(all.length)} posts</span>
      </div>
    </div>

    <div class="so-flow">
      <div class="so-duo">
        <div>
          <div class="so-sec"><h4>Content momentum</h4><div class="ln"></div>
            <span class="so-hint">fills once daily tracking begins</span></div>
          <div class="so-mrail"><span>${num(rows.length - withHistory)} posts · no snapshot history yet</span></div>
          <div class="so-mkeys">
            <div class="so-mk"><div class="n">—</div><div class="l">Rising</div></div>
            <div class="so-mk"><div class="n">—</div><div class="l">Growing</div></div>
            <div class="so-mk"><div class="n">—</div><div class="l">Stable</div></div>
            <div class="so-mk"><div class="n">—</div><div class="l">Plateaued</div></div>
          </div>
        </div>
        <div>
          <div class="so-sec"><h4>Data coverage</h4><div class="ln"></div>
            <span class="so-hint">what this page cannot see yet</span></div>
          <div id="soCoverageViz"></div>
        </div>
      </div>

      <div>
        <div class="so-sec"><h4>Top performing content</h4><div class="ln"></div>
          <span class="so-hint">click opens the post</span></div>
        <div id="soTopViz"></div>
      </div>

      <div class="so-duo">
        <div>
          <div class="so-sec"><h4>Campaign performance</h4><div class="ln"></div>
            <span class="so-hint">click a bar to filter</span></div>
          <div id="soCampaignViz"></div>
        </div>
        <div>
          <div class="so-sec"><h4>Engagement breakdown</h4><div class="ln"></div></div>
          <div id="soEngViz"></div>
          <div class="so-sec" style="margin-top:28px"><h4>Needs review</h4><div class="ln"></div></div>
          <div style="display:flex;flex-direction:column;gap:11px">
            <div class="so-row"><span>Unassigned content</span>
              <span style="font:500 12px/1 'Roboto Mono',monospace;color:${unassigned ? 'var(--warning)' : 'var(--text-3)'}">${num(unassigned)}</span></div>
            <div class="so-row"><span>Suggested matches to confirm</span>
              <span style="font:500 12px/1 'Roboto Mono',monospace;color:${suggested ? 'var(--warning)' : 'var(--text-3)'}">${num(suggested)}</span></div>
          </div>
        </div>
      </div>

      <div class="so-duo flip">
        <div>
          <div class="so-sec"><h4>View distribution</h4><div class="ln"></div></div>
          <div id="soDistViz"></div>
        </div>
        <div>
          <div class="so-sec"><h4>Market performance</h4><div class="ln"></div>
            <span class="so-hint">by creator nationality</span></div>
          <div id="soMarketViz"></div>
        </div>
      </div>
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
