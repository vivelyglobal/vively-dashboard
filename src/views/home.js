import { dLabel } from '../lib/dates.js';
import { kmb, num } from '../lib/format.js';
import { DB, notify } from '../model/db.js';
import { activityFeed, attentionCounts, campaignPipeline, campaignRegister, creatorFlow, homeKpis } from '../model/homeStats.js';
import { overviewRows, topContent } from '../model/socialStats.js';
import { $, $$, esc } from '../ui/dom.js';
import { emptyState } from '../ui/html.js';
import { showSocialContent } from './social.js';
import { ensureOverviewStyles, platformTag } from './socialOverview.js';

/* ============================================================
   HOME — the page

   Composed as an operating surface rather than a dashboard. A dark
   command band carries the headline figure and the shape of the
   portfolio; below it the page runs as a rhythm of sections separated
   by space and a hairline rather than by a border on every widget.

   Three things are deliberate:

     · One elevated surface per screen. The band is the only thing that
       lifts off the ground, so elevation means "this is the summary"
       rather than "this is a div".
     · The creator funnel is drawn as a flow whose narrowing IS the
       loss, not as nine bars of which five record no movement.
     · Campaigns are entities, not a chart. One row each, progress
       integrated, so fifteen of them scan in a single pass.

   Its CSS is injected here rather than added to the head stylesheet,
   which is itself a module with a line range — editing it would shift
   every anchor after it.
   ============================================================ */

export const home = { registerAll: false };

export function ensureHomeStyles() {
  if (document.getElementById('hmCss')) return;
  const s = document.createElement('style');
  s.id = 'hmCss';
  s.textContent = `
  /* ---- the command band ---- */
  .hm-band{background:#0C1211;color:#F1F6F3;border-radius:14px;padding:34px 30px 26px;margin-bottom:44px;
    background-image:radial-gradient(120% 130% at 88% -10%,rgba(47,168,140,.16),transparent 58%)}
  .hm-top{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:58px;align-items:start}
  .hm-lab{font:500 10.5px/1 'Roboto Mono',monospace;letter-spacing:.15em;text-transform:uppercase;color:#7E938B}
  .hm-big{font-size:clamp(56px,8vw,86px);font-weight:600;line-height:.92;letter-spacing:-.045em;
    margin-top:14px;font-variant-numeric:tabular-nums}
  .hm-cap{font-size:19px;font-weight:500;letter-spacing:-.02em;margin-top:10px}
  .hm-band .hm-sub{color:#7E938B;font-size:13px;margin-top:7px}
  .hm-sats{display:grid;grid-template-columns:1fr 1fr;gap:24px 44px;padding-left:38px;border-left:1px solid #22302C}
  .hm-sat .l{font:500 10px/1 'Roboto Mono',monospace;letter-spacing:.13em;text-transform:uppercase;color:#7E938B}
  .hm-sat .v{font-size:26px;font-weight:600;letter-spacing:-.028em;margin-top:8px;font-variant-numeric:tabular-nums}
  .hm-sat .s{font:400 10.5px/1.35 'Roboto Mono',monospace;color:#7E938B;margin-top:5px}

  /* ---- the campaign pipeline rail, inside the band ---- */
  .hm-rail{margin-top:32px;padding-top:22px;border-top:1px solid #22302C}
  .hm-rail-h{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:13px}
  .hm-rail-h .t{font:500 10px/1 'Roboto Mono',monospace;letter-spacing:.13em;text-transform:uppercase;color:#7E938B}
  .hm-rail-h .n{font:400 11px/1 'Roboto Mono',monospace;color:#7E938B}
  .hm-track{display:flex;gap:4px;height:34px}
  .hm-seg{border-radius:5px;display:flex;align-items:center;justify-content:center;background:#151E1B;
    cursor:pointer;transition:transform .16s ease;min-width:28px;border:0;color:inherit;font:inherit;padding:0}
  .hm-seg:hover{transform:translateY(-2px)}
  .hm-seg .c{font:600 14px/1 'Roboto Mono',monospace}
  .hm-seg.on{background:#0E7C66}.hm-seg.on .c{color:#04120E}
  .hm-seg.mid{background:#2C403A}
  .hm-seg.zero{background:transparent;box-shadow:inset 0 0 0 1px #22302C}
  .hm-seg.zero .c{color:#7E938B;font-weight:400}
  .hm-labs{display:flex;gap:4px;margin-top:9px}
  .hm-labs span{font:400 10.5px/1.3 'Roboto Mono',monospace;color:#7E938B;text-align:center;min-width:28px}

  /* ---- sections, not boxes ---- */
  .hm-flow{display:flex;flex-direction:column;gap:50px}
  .hm-sec{display:flex;align-items:baseline;gap:12px;margin-bottom:17px}
  .hm-sec h4{margin:0;font-size:15px;font-weight:600;letter-spacing:-.015em;white-space:nowrap}
  .hm-sec .ln{flex:1;height:1px;background:var(--line)}
  .hm-sec .m{font:400 11px/1 'Roboto Mono',monospace;color:var(--text-3);white-space:nowrap}
  .hm-duo{display:grid;grid-template-columns:1.62fr 1fr;gap:44px;align-items:start}
  .hm-note{font:400 11.5px/1.65 'Roboto Mono',monospace;color:var(--text-3);margin-top:15px}

  /* ---- creator flow ---- */
  #hmFlow svg{width:100%;height:auto;display:block;overflow:visible}

  /* ---- attention feed ---- */
  .hm-att .row{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;
    padding:13px 10px;margin:0 -10px;border-radius:8px;text-decoration:none;color:inherit;
    min-height:40px;transition:background .14s ease}
  .hm-att .row + .row{box-shadow:inset 0 1px 0 var(--line)}
  .hm-att .row:hover{background:var(--surface-2)}
  .hm-att .dot{width:7px;height:7px;border-radius:50%;background:var(--text-3)}
  .hm-att .row.crit .dot{background:var(--danger);box-shadow:0 0 0 3px rgba(220,76,76,.14)}
  .hm-att .row.warn .dot{background:var(--warning);box-shadow:0 0 0 3px rgba(250,178,25,.14)}
  .hm-att .tx{font-size:13.5px;display:flex;align-items:baseline;gap:9px;min-width:0}
  .hm-att .tx b{font:600 15px/1 'Roboto Mono',monospace}
  .hm-att .row.crit .tx b{color:var(--danger)}
  .hm-att .row.warn .tx b{color:var(--warning)}
  .hm-att .tx span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .hm-att .row.done .tx,.hm-att .row.done .tx b{color:var(--text-3);font-weight:400}
  .hm-att .go{color:var(--text-3);font-size:13px;opacity:0;transition:opacity .14s ease}
  .hm-att .row:hover .go{opacity:1}
  .hm-att .row.done:hover{background:transparent}
  .hm-att .row.done:hover .go{opacity:0}

  /* ---- campaign register ---- */
  .hm-reg-head,.hm-reg-row{display:grid;
    grid-template-columns:minmax(160px,2fr) 104px minmax(120px,1fr) 66px 104px 96px;
    gap:18px;align-items:center}
  .hm-reg-head{padding:0 12px 11px;border-bottom:1px solid var(--line-strong)}
  .hm-reg-head span{font:500 10px/1 'Roboto Mono',monospace;letter-spacing:.12em;
    text-transform:uppercase;color:var(--text-3)}
  .hm-reg-head .r,.hm-reg-row .r{text-align:right}
  .hm-reg-row{padding:14px 12px;border-radius:9px;cursor:pointer;width:100%;text-align:left;
    border:0;background:none;font:inherit;color:inherit;transition:background .14s ease}
  .hm-reg-row + .hm-reg-row{box-shadow:inset 0 1px 0 var(--line)}
  .hm-reg-row:hover{background:var(--surface-2)}
  .hm-reg-row .nm{font-size:13.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .hm-reg-row:hover .nm{color:var(--blue)}
  .hm-prog{display:flex;align-items:center;gap:10px}
  .hm-prog .t{flex:1;height:5px;border-radius:3px;background:var(--surface-3);overflow:hidden;min-width:40px}
  .hm-prog .f{height:100%;border-radius:3px;background:var(--s1)}
  .hm-prog .f.nil{background:var(--danger);width:2px}
  .hm-prog .v{font:500 11.5px/1 'Roboto Mono',monospace;color:var(--text-2);white-space:nowrap}
  .hm-reg-row .fig{font:500 13px/1 'Roboto Mono',monospace;font-variant-numeric:tabular-nums}
  .hm-reg-row .fig.na{color:var(--text-3);font-weight:400;font-size:10.5px}
  .hm-more{margin-top:13px;font:500 12px/1 'Roboto Mono',monospace;color:var(--blue);cursor:pointer;
    padding:11px 12px;border-radius:8px;border:0;background:none}
  .hm-more:hover{background:var(--blue-soft)}

  /* ---- chips ---- */
  .hm-chip{display:inline-flex;align-items:center;gap:6px;font:500 11px/1 inherit;padding:5px 9px;
    border-radius:100px;white-space:nowrap}
  .hm-chip::before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor;flex:0 0 5px}
  .hm-ok{background:rgba(38,166,110,.12);color:var(--success)}
  .hm-risk{background:rgba(220,76,76,.12);color:var(--danger)}
  .hm-idle{background:var(--surface-3);color:var(--text-3)}

  /* ---- activity ---- */
  .hm-feed .e{display:grid;grid-template-columns:56px 1fr;gap:12px;padding:9px 0;font-size:13px}
  .hm-feed .e + .e{border-top:1px solid var(--line)}
  .hm-feed .d{font:400 10.5px/1.5 'Roboto Mono',monospace;color:var(--text-3)}
  .hm-feed .w{color:var(--text-3);font-size:11.5px}

  .hm-blank{border-radius:10px;background:var(--surface-2);padding:22px;text-align:center;
    color:var(--text-3);font-size:12.5px;line-height:1.6}

  @media(max-width:1000px){
    .hm-top{grid-template-columns:1fr;gap:28px}
    .hm-sats{padding-left:0;border-left:0;border-top:1px solid #22302C;padding-top:24px}
    .hm-duo{grid-template-columns:1fr;gap:36px}
    .hm-reg-head{display:none}
    .hm-reg-row{grid-template-columns:1fr auto;gap:8px 14px}
    .hm-reg-row .hm-prog,.hm-reg-row .fig{grid-column:1/-1}
  }
  @media(max-width:760px){
    .hm-band{padding:26px 18px 20px}
    .hm-sats{grid-template-columns:1fr 1fr;gap:20px}
    .hm-flow{gap:38px}
  }`;
  document.head.appendChild(s);
}

export const hmSat = (l, v, s) => `<div class="hm-sat"><div class="l">${esc(l)}</div>
  <div class="v">${v}</div><div class="s">${esc(s)}</div></div>`;

/* The flow is drawn rather than charted: the ribbon's narrowing is the
   drop-off, and the shed volume is filled in so the loss is a shape you
   can see instead of a percentage you have to read. */
export function flowSvg(flow) {
  const W = 720, top = 26, maxH = 130, nodeW = 14;
  const xs = [24, 248, 472, 680];
  const max = Math.max(1, ...flow.steps.map((s) => s.n));
  const h = (n) => Math.max(2, (n / max) * maxH);
  let body = '';
  for (let i = 0; i < 3; i++) {
    const lx = xs[i] + nodeW, rx = xs[i + 1];
    const lh = top + h(flow.steps[i].n), rh = top + h(flow.steps[i + 1].n);
    body += `<polygon points="${lx},${top} ${rx},${top} ${rx},${rh} ${lx},${lh}" fill="url(#hmFl)" opacity=".85"/>`
      + `<polygon points="${lx},${lh} ${rx},${rh} ${rx},${lh}" fill="var(--danger)" opacity=".2"/>`
      + `<line x1="${lx}" y1="${lh}" x2="${rx}" y2="${rh}" stroke="var(--danger)" stroke-width="1.25" opacity=".75"/>`;
  }
  const nodes = flow.steps.map((s, i) =>
    `<rect x="${xs[i]}" y="${top}" width="${nodeW}" height="${h(s.n)}" rx="3" fill="var(--s1)"/>`).join('');
  const counts = flow.steps.map((s, i) =>
    `<text x="${i === 3 ? xs[i] - 24 : xs[i]}" y="18">${num(s.n)}</text>`).join('');
  const labels = flow.steps.map((s, i) =>
    `<text x="${i === 3 ? xs[i] - 24 : xs[i]}" y="180">${esc(s.label)}</text>`).join('');
  const losses = flow.losses.map((l, i) => {
    const mid = (xs[i] + nodeW + xs[i + 1]) / 2 - 46;
    return `<text x="${mid}" y="203" fill="var(--danger)" font-weight="500">−${num(l.lost)} ${esc(l.label)}</text>`
      + `<text x="${mid}" y="217" fill="var(--text-3)">${(l.through * 100).toFixed(0)}% through</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} 226" role="img" aria-label="Creator flow: ${
    flow.steps.map((s) => s.label + ' ' + s.n).join(', ')}">
    <defs><linearGradient id="hmFl" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="var(--s1)" stop-opacity=".92"/>
      <stop offset="1" stop-color="var(--s3)" stop-opacity=".62"/></linearGradient></defs>
    ${body}${nodes}
    <g font-family="inherit" font-size="21" font-weight="600" fill="var(--text)">${counts}</g>
    <g font-family="'Roboto Mono',monospace" font-size="10.5" fill="var(--text-3)">${labels}</g>
    <g font-family="'Roboto Mono',monospace" font-size="11">${losses}</g>
  </svg>`;
}

export const HEALTH = {
  ontrack:    { cls: 'hm-ok',   label: 'On track' },
  complete:   { cls: 'hm-ok',   label: 'Complete' },
  risk:       { cls: 'hm-risk', label: 'At risk' },
  notstarted: { cls: 'hm-idle', label: 'Not started' },
  unknown:    { cls: 'hm-idle', label: 'No dates' }
};

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
  const pipe = campaignPipeline(DB);
  const activeIds = DB.campaigns.filter((c) => c.status !== 'wrapped').map((c) => c.id);
  const flow = creatorFlow(DB, activeIds);
  const reg = campaignRegister(DB, rows);
  const top = topContent(rows, 6);
  const feed = activityFeed(DB, rows, 5);
  const shown = home.registerAll ? reg : reg.slice(0, 9);

  const railSeg = (r, cls) => `<button class="hm-seg ${cls}" data-status="${esc(r.key)}"
    style="${r.value ? 'flex:' + r.value : 'flex:0 0 30px'}" title="${esc(r.label)} — ${r.value}">
    <span class="c">${num(r.value)}</span></button>`;

  view.innerHTML = `
    <div class="hm-band">
      <div class="hm-top">
        <div>
          <div class="hm-lab">Active campaigns</div>
          <div class="hm-big">${num(k.activeCampaigns)}</div>
          <div class="hm-cap">${num(k.totalCampaigns)} in the book</div>
          <div class="hm-sub">${num(k.liveCampaigns)} live · ${num(k.wrappedCampaigns)} wrapped
            · ${num(flow.total)} creators in the funnel</div>
        </div>
        <div class="hm-sats">
          ${hmSat('Confirmed creators', num(k.creatorsInCampaigns), num(flow.total) + ' in the funnel')}
          ${hmSat('Contacted', num(k.creatorsContacted), 'of ' + num(k.roster) + ' on the roster')}
          ${hmSat('Content pieces', num(k.content), num(k.measuredCount) + ' with view counts')}
          ${hmSat('Total views', num(k.views),
            k.avgViews == null ? 'nothing measured yet' : num(k.avgViews) + ' avg per post')}
        </div>
      </div>

      <div class="hm-rail">
        <div class="hm-rail-h"><span class="t">Campaign pipeline</span>
          <span class="n">${num(pipe.total)} campaigns · width by count</span></div>
        <div class="hm-track" id="hmRail">
          ${pipe.rows.map((r) => railSeg(r, r.value === 0 ? 'zero' : r.key === 'live' ? 'on' : 'mid')).join('')}
        </div>
        <div class="hm-labs">
          ${pipe.rows.map((r) => `<span style="${r.value ? 'flex:' + r.value : 'flex:0 0 30px'}">${esc(r.label)}</span>`).join('')}
        </div>
      </div>
    </div>

    <div class="hm-flow">
      <div class="hm-duo">
        <div>
          <div class="hm-sec"><h4>Creator flow</h4><div class="ln"></div>
            <span class="m">${num(flow.total)} active · ${num(flow.dropped)} dropped</span></div>
          <div id="hmFlow">${flowSvg(flow)}</div>
          <p class="hm-note">Contacted and Replied are folded into the first block: the Notion form never
            produces those stages, so all ${num(flow.steps[0].n)} pass through them untouched and three
            identical segments would imply movement that was never recorded.</p>
        </div>
        <div class="hm-att">
          <div class="hm-sec"><h4>Needs attention</h4><div class="ln"></div>
            <span class="m">${num(att.urgent)} open</span></div>
          ${att.items.map((i) => `<a class="row ${i.n ? (i.key === 'overdue' || i.key === 'links' ? 'crit' : 'warn') : 'done'}"
             href="${esc(i.href)}"><span class="dot"></span>
             <span class="tx"><b>${num(i.n)}</b><span>${esc(i.label)}</span></span>
             <span class="go">→</span></a>`).join('')}
          ${att.noEnd ? `<p class="hm-note">${num(att.noEnd)} active campaign${att.noEnd === 1 ? ' has' : 's have'}
            no end date, so they cannot be counted as overdue or ending soon.</p>` : ''}
        </div>
      </div>

      <div>
        <div class="hm-sec"><h4>Campaigns</h4><div class="ln"></div>
          <span class="m">scan the company in one pass</span></div>
        <div class="hm-reg-head"><span>Campaign</span><span>Status</span><span>Creators confirmed</span>
          <span class="r">Posts</span><span class="r">Views</span><span class="r">Health</span></div>
        <div id="hmRegister">${shown.map((c) => `
          <button class="hm-reg-row" data-id="${esc(c.id)}">
            <span class="nm">${esc(c.name)}</span>
            <span><span class="hm-chip hm-idle">${esc(c.statusLabel)}</span></span>
            <span class="hm-prog"><span class="t"><span class="f${c.confirmed ? '' : ' nil'}"
              style="width:${(c.progress * 100).toFixed(1)}%"></span></span>
              <span class="v">${num(c.confirmed)}/${c.target ? num(c.target) : '—'}</span></span>
            <span class="fig r${c.posts ? '' : ' na'}">${c.posts ? num(c.posts) : '—'}</span>
            <span class="fig r${c.views ? '' : ' na'}">${c.views ? num(c.views)
              : c.unmeasured ? 'unmeasured' : '—'}</span>
            <span class="r"><span class="hm-chip ${HEALTH[c.health].cls}">${HEALTH[c.health].label}</span></span>
          </button>`).join('')}</div>
        ${reg.length > 9 ? `<button class="hm-more" id="hmRegMore">${
          home.registerAll ? 'Show fewer' : 'Show all ' + num(reg.length) + ' campaigns'} →</button>` : ''}
        <p class="hm-note">A campaign with posts and no readings shows “unmeasured”, never a zero —
          a zero would say the work failed rather than that nobody entered a number.</p>
      </div>

      <div class="hm-duo">
        <div>
          <div class="hm-sec"><h4>Top content</h4><div class="ln"></div>
            <span class="m">by views · measured only</span></div>
          <div id="hmTop"></div>
        </div>
        <div>
          <div class="hm-sec"><h4>Activity</h4><div class="ln"></div></div>
          <div id="hmFeed"></div>
          <p class="hm-note">Derived from measurement and sync timestamps — not an event log.
            Creator stage changes are not timestamped individually, so they cannot appear here.</p>
        </div>
      </div>
    </div>`;

  drawHomeTop(top);
  drawHomeFeed(feed);
  wireHome(reg);
}

export function drawHomeTop(top) {
  const mount = $('#hmTop');
  if (!mount) return;
  if (!top.length) {
    mount.innerHTML = '<div class="hm-blank">No measured posts yet. Enter a view count and the best of them appear here.</div>';
    return;
  }
  mount.innerHTML = '<div class="so-cards">' + top.map((r) => {
    /* thumbnailUrl is empty on every record — Instagram will not serve
       one without the creator's authorisation — so the plate is a
       deterministic colour per creator rather than a broken image */
    const tint = r.c.thumbTint || 'var(--s1)';
    return `<button class="so-tc" data-id="${esc(r.id)}">
      <span class="plate" style="background:linear-gradient(158deg,${esc(tint)},rgba(0,0,0,.62))">
        <span class="tag">${esc(platformTag(r.platform))} ${esc((r.c.format || 'POST').toUpperCase())}</span>
        <span class="big">${kmb(r.views)}</span><span class="vl">views</span>
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
    mount.innerHTML = '<div class="hm-blank">Nothing dated yet. Measurements and imports appear here as they happen.</div>';
    return;
  }
  mount.innerHTML = '<div class="hm-feed">' + feed.map((e) => `<div class="e">
      <span class="d">${esc(dLabel(e.at))}</span>
      <span>${esc(e.text)}${e.who ? `<span class="w"> · ${esc(e.who)}</span>` : ''}</span>
    </div>`).join('') + '</div>';
}

export function wireHome(reg) {
  $$('#hmRegister .hm-reg-row').forEach((b) => b.addEventListener('click', () => {
    location.hash = '#/campaigns/' + b.dataset.id;
  }));
  $$('#hmRail .hm-seg').forEach((b) => b.addEventListener('click', () => {
    location.hash = '#/campaigns/all';
  }));
  const more = $('#hmRegMore');
  if (more) more.addEventListener('click', () => { home.registerAll = !home.registerAll; notify(); });
}
