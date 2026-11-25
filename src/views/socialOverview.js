import { SERIES_HEX, barsH, lineChart } from '../charts/index.js';
import { columnChart } from '../charts/socialViz.js';
import { kmb, num, pct } from '../lib/format.js';
import { DB, notify } from '../model/db.js';
import { OVERVIEW_METRICS, byCampaignRollup, byMarketRollup, byPlatformRollup, engagementSplit, overviewCoverage, overviewFilter, overviewKpis, overviewRows, overviewSeries, topContent, unmappedCountries, viewDistribution } from '../model/socialStats.js';
import { SM } from '../sync/sheetMetrics.js';
import { $, $$, esc } from '../ui/dom.js';
import { downloadFile, emptyState } from '../ui/html.js';
import { ensureDeskStyles } from './desk.js';
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
  .so-hint{font:400 12px/1.3 var(--font);color:var(--text-3)}
  .so-kpi .label{font:500 12px/1.3 var(--font);color:var(--text-3)}
  .so-kpi .value{font-size:23px;font-weight:400;letter-spacing:-.02em;margin-top:7px;line-height:1.1}
  .so-kpi .foot{margin-top:7px;min-height:29px;font:400 12px/1.3 var(--font);color:var(--text-3)}
  .so-meter{height:3px;border-radius:2px;background:var(--surface-3);overflow:hidden;margin-top:8px}
  .so-meter i{display:block;height:100%;background:var(--blue)}
  .so-seg{display:flex;gap:1px;background:var(--surface-2);border-radius:999px;padding:2px}
  .so-seg button{font:500 12px/1.3 var(--font);padding:5px 10px;border-radius:999px;border:0;
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
  .so-tc .plate .big{font:500 19px/1 var(--font);color:#fff;text-shadow:0 1px 6px rgba(0,0,0,.6)}
  .so-tc .plate .tag{position:absolute;top:8px;left:8px;font:500 12px/1.3 var(--font);
    background:rgba(0,0,0,.42);color:#fff;border-radius:3px;padding:4px 5px;letter-spacing:.04em}
  .so-tc .body{padding:9px 10px 11px;display:flex;flex-direction:column;gap:6px}
  .so-tc .h{font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .so-tc .m{font:400 12px/1.3 var(--font);color:var(--text-3)}
  .so-tc .st{display:flex;gap:10px}
  .so-tc .st div{font:400 12px/1.3 var(--font);color:var(--text-3)}
  .so-tc .st b{display:block;font:500 12px/1.2 var(--font);color:var(--text)}
  .so-gap{font:500 12px/1.3 var(--font);color:var(--warning);border:1px solid rgba(250,178,25,.35);
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
  .so-band{background:var(--surface);border:1px solid var(--line);color:var(--text);border-radius:14px;padding:30px 28px 24px;margin-bottom:34px}
  .so-band-in{display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr);gap:44px;align-items:start}
  .so-lab{font:500 12px/1.3 var(--font);color:var(--text-3)}
  .so-big{font-size:clamp(48px,7vw,74px);font-weight:600;line-height:.94;letter-spacing:-.04em;margin-top:12px;
    font-variant-numeric:tabular-nums}
  .so-band .so-sub{color:var(--text-3);font-size:13px;margin-top:11px}
  .so-sats{display:flex;gap:34px;flex-wrap:wrap;margin-top:22px;padding-top:20px;border-top:1px solid var(--line)}
  .so-sat .l{font:500 12px/1.3 var(--font);color:var(--text-3)}
  .so-sat .v{font-size:25px;font-weight:600;letter-spacing:-.028em;margin-top:8px;font-variant-numeric:tabular-nums}
  .so-sat .v.off{color:var(--text-3)}
  .so-sat .s{font:400 12px/1.3 var(--font);color:var(--text-3);margin-top:5px}
  .so-chart-h{display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin-bottom:12px}
  .so-chart-h .t{font:500 12px/1.3 var(--font);color:var(--text-3)}
  .so-band .so-seg{background:var(--surface-2);border-radius:7px;padding:3px;display:flex;gap:2px}
  .so-band .so-seg button{border:0;background:none;color:var(--text-3);font-size:11.5px;font-weight:500;
    padding:6px 10px;border-radius:5px;cursor:pointer;font-family:inherit}
  .so-band .so-seg button[aria-pressed="true"]{background:var(--surface);color:var(--text)}
  .so-band .so-hint{color:var(--text-3)}
  .so-band .so-filters{margin:24px 0 0;padding-top:20px;border-top:1px solid var(--line)}
  .so-band .so-filters select,.so-band .so-filters input{background:var(--surface-2);border-color:var(--line-strong);color:var(--text)}
  .so-band .so-filters .btn{background:var(--surface-2);border-color:var(--line-strong);color:var(--text)}

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
  .so-mrail span{position:relative;font:500 12px/1 var(--font);color:var(--text-3)}
  .so-mkeys{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-top:11px}
  .so-mk{padding:13px 11px;border-radius:9px;background:var(--surface-2)}
  .so-mk .n{font-size:21px;font-weight:600;color:var(--text-3);letter-spacing:-.02em}
  .so-mk .l{font:500 12px/1.3 var(--font);
    color:var(--text-3);margin-top:8px}

  /* richer content plates */
  .so-cards{grid-template-columns:repeat(auto-fit,minmax(168px,1fr))}
  .so-tc{border-radius:12px}
  .so-tc .plate{aspect-ratio:4/5;justify-content:space-between}
  .so-tc .plate .big{font-size:26px;font-weight:600;letter-spacing:-.03em}
  .so-tc .vl{font:400 12px/1.3 var(--font);color:rgba(255,255,255,.72);
    margin-top:6px}
  .so-tc:hover{transform:translateY(-3px)}
  .so-tc{transition:transform .18s ease,border-color .18s ease}

  @media(max-width:1000px){
    .so-band-in{grid-template-columns:1fr;gap:30px}
    .so-duo,.so-duo.flip{grid-template-columns:1fr;gap:32px}
    .so-mkeys{grid-template-columns:repeat(2,1fr)}
  }`;
  document.head.appendChild(s);
}

/* ============================================================
   LIVE PERFORMANCE (Social > Performance) and the "as of" chip

   The server reads the KOL sheet on a timer and keeps one snapshot
   (server/perf-sync.js). This is the screen for it. Staff only: every
   call below is a staff route, and a 401, 403, 503 or a dead network
   becomes one plain sentence instead of an empty page.

   Rules the code keeps:
   - every string from the snapshot is sheet text and is escaped
   - a number the scraper did not read is "—", never 0
   - money fields are never read (posts and campaigns are copied
     through a short whitelist, so an extra field is simply dropped)
   - post links must be http or https, anything else is dropped
   - the thresholds below mirror the server's and are ASSUMED
   ============================================================ */

export const PERF_GREEN_HOURS = 48;    /* newest reading this fresh = green (server: GREEN_READING_HOURS) */
export const PERF_RED_DAYS = 7;        /* this old = red */
export const PERF_CACHE_MS = 30000;    /* a second visit inside this reuses the answer */
export const PERF_OFF_TEXT = 'Live performance is switched off. Ask the admin to set the sheet.';
export const PF_SHEET_ONLY = '__sheet_only__';
export const PF_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const PF_PERIODS = [['all', 'All time', 0], ['7', 'Last 7 days', 7], ['30', 'Last 30 days', 30], ['90', 'Last 90 days', 90]];
export const PF_METRICS = [['views', 'Views'], ['likes', 'Likes'], ['er', 'Average ER'], ['count', 'Post count']];
export const PF_COLS = [
  { key: 'creator', label: 'Creator' }, { key: 'campaign', label: 'Campaign' },
  { key: 'platform', label: 'Platform' }, { key: 'posted', label: 'Posted' },
  { key: 'views', label: 'Views', num: true }, { key: 'likes', label: 'Likes', num: true },
  { key: 'er', label: 'Eng. rate', num: true }, { key: 'reading', label: 'Last read' }
];

/* what the screen remembers between repaints (a repaint is not a refetch) */
export const PERF = {
  gen: 0, status: null, snapResp: null, problem: null, at: 0, loading: null,
  campaign: '', platform: '', period: 'all', metric: 'views',
  sort: { key: 'posted', dir: 'desc' }, limit: 100,
  refresh: { busy: false, text: '' }, matchMsg: {}, picks: {}
};
/* gen goes up on every reset, so a read that was still running when someone signed out
   cannot write its answer back into the screen afterwards */
export function perfReset() {
  Object.assign(PERF, { gen: PERF.gen + 1, status: null, snapResp: null, problem: null, at: 0, loading: null,
    campaign: '', platform: '', period: 'all', metric: 'views', sort: { key: 'posted', dir: 'desc' }, limit: 100,
    refresh: { busy: false, text: '' }, matchMsg: {}, picks: {} });
  rbReset();
}

/* ---- small, strict readers ---- */
export const perfNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const perfText = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max || 200) : '');
export function perfDay(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return '';
  const t = Date.parse(v + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? v : '';
}
export function perfIso(v) {
  if (typeof v !== 'string' || !v) return '';
  const t = Date.parse(v);
  return Number.isFinite(t) ? v : '';
}
/* Only http and https, no credentials in the address. The sheet is text
   anyone with the link can edit, so "javascript:" and friends are real. */
export function perfSafeUrl(u) {
  if (typeof u !== 'string') return '';
  const s = u.trim();
  if (!s || s.length > 2000 || !/^https?:\/\//i.test(s)) return '';
  try {
    const x = new URL(s);
    if ((x.protocol !== 'http:' && x.protocol !== 'https:') || x.username || x.password) return '';
    return x.href;
  } catch (e) { return ''; }
}

/* ---- time words ---- */
export function perfAgeText(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 48) return h + ' h ago';
  const d = Math.floor(h / 24);
  return d + ' days ago';
}
/* "2026-11-24 09:10 Korea time". Plain arithmetic on UTC fields, so it reads the
   same in every browser and in tests. */
export function perfKst(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const k = new Date(t + 9 * 3600000).toISOString();
  return k.slice(0, 10) + ' ' + k.slice(11, 16) + ' Korea time';
}
export function perfShortDate(v) {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return d.getUTCDate() + ' ' + PF_MONTHS[d.getUTCMonth()];
}

/* ---- the freshness chip ---- */
export const PERF_LEVELS = {
  green: { word: 'Fresh', shape: 'check' },
  amber: { word: 'Getting old', shape: 'warn' },
  red:   { word: 'Out of date', shape: 'cross' },
  grey:  { word: 'No time recorded', shape: 'ring' }
};
export const PERF_REASONS = {
  'check-late': 'The sheet was not checked on time.',
  'readings-old': 'The newest post reading is more than 2 days old.',
  'no-readings': 'No post has a reading yet.',
  'last-run-failed': 'The last read did not work.',
  'check-very-late': 'The sheet has not been checked for 7 days or more.',
  'readings-very-old': 'The newest post reading is 7 days old or more.',
  'no-data': 'Nothing has been read yet.'
};
export function perfLevelFromAges(checkedAgeMin, newestAgeHours, intervalMin) {
  if (checkedAgeMin == null) return 'red';
  let level = 'green';
  if (checkedAgeMin > (intervalMin || 30) * 2) level = 'amber';
  if (newestAgeHours == null || newestAgeHours > PERF_GREEN_HOURS) level = 'amber';
  if (checkedAgeMin >= PERF_RED_DAYS * 1440 || (newestAgeHours != null && newestAgeHours >= PERF_RED_DAYS * 24)) level = 'red';
  return level;
}
/* fr: the server's freshness object; checkedAt / newestAt: ISO times or empty.
   The level is the server's. The words are worked out from the times against the
   browser clock, so a page left open keeps telling the truth. */
export function perfFreshness(fr, checkedAt, newestAt, nowMs, intervalMin) {
  const f = fr && typeof fr === 'object' ? fr : {};
  const cT = Date.parse(checkedAt);
  if (!Number.isFinite(cT)) {
    return { level: 'grey', word: 'No data yet', shape: 'ring',
      text: 'Nothing has been read yet', short: 'not checked yet',
      tip: ['The sheet has not been read, so there is no time to show.'] };
  }
  const nT = Date.parse(newestAt);
  const cAge = Math.max(0, nowMs - cT);
  const nAge = Number.isFinite(nT) ? Math.max(0, nowMs - nT) : null;
  const level = PERF_LEVELS[f.level] && f.level !== 'grey' ? f.level
    : perfLevelFromAges(Math.round(cAge / 60000), nAge == null ? null : Math.round(nAge / 3600000), intervalMin);
  const lv = PERF_LEVELS[level];
  const tip = ['Checked: ' + perfKst(checkedAt),
    'Newest post reading: ' + (nAge == null ? 'none yet' : perfKst(newestAt))];
  if (level !== 'green' && PERF_REASONS[f.reason]) tip.push(PERF_REASONS[f.reason]);
  tip.push('Green: checked on time and newest reading under ' + PERF_GREEN_HOURS + ' hours old. Red: ' + PERF_RED_DAYS + ' days or a failed read.');
  return { level, word: lv.word, shape: lv.shape,
    text: 'Checked ' + perfAgeText(cAge) + ' · newest post reading ' + (nAge == null ? 'not yet' : perfAgeText(nAge)),
    short: 'checked ' + perfAgeText(cAge), tip };
}
/* The old way: numbers that arrived through Setup > Sheet metrics. Its own time
   (the newest "last read" stamp on a post), the same thresholds, and the word
   "Out of date" once it is past them. */
export function perfLegacyFreshness(db, importedAt, nowMs) {
  let newest = 0;
  ((db && db.socialContent) || []).forEach((c) => {
    const t = Date.parse(c && c.lastScrapedAt);
    if (Number.isFinite(t) && t > newest) newest = t;
  });
  const imp = importedAt ? Date.parse(importedAt instanceof Date ? importedAt.toISOString() : importedAt) : NaN;
  const asOf = newest || (Number.isFinite(imp) ? imp : 0);
  const impLine = Number.isFinite(imp) ? 'Last import in this browser: ' + perfKst(new Date(imp).toISOString())
    : 'No import has been run in this browser.';
  if (!asOf) {
    return { level: 'grey', word: PERF_LEVELS.grey.word, shape: 'ring',
      text: 'Imported numbers have no read time', short: 'imported, no time recorded',
      tip: [impLine, 'These numbers change only when someone runs the sheet import in Setup.'] };
  }
  const ageH = Math.max(0, nowMs - asOf) / 3600000;
  const level = ageH <= PERF_GREEN_HOURS ? 'green' : ageH >= PERF_RED_DAYS * 24 ? 'red' : 'amber';
  const word = level === 'green' ? 'Fresh' : 'Out of date';
  const when = perfShortDate(new Date(asOf).toISOString());
  const ago = perfAgeText(Math.max(0, nowMs - asOf));
  return { level, word, shape: PERF_LEVELS[level].shape,
    text: 'Imported numbers as of ' + when + (level === 'green' ? '' : ' (' + ago + ')'),
    short: 'imported ' + when,
    tip: ['Newest reading in the imported numbers: ' + when, impLine,
      'These numbers change only when someone runs the sheet import in Setup. Live numbers are on the Performance tab.'] };
}
export function perfShape(shape) {
  const body = {
    check: '<circle cx="6" cy="6" r="5.5" fill="currentColor"/><path d="M3.4 6.2l1.8 1.8 3.4-3.6" fill="none" stroke="var(--surface)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    warn:  '<path d="M6 .8l5.6 10.2H.4z" fill="currentColor"/><path d="M6 4.6v3M6 9.2v.1" stroke="var(--surface)" stroke-width="1.4" stroke-linecap="round"/>',
    cross: '<rect x=".8" y=".8" width="10.4" height="10.4" rx="2" fill="currentColor"/><path d="M4 4l4 4M8 4L4 8" stroke="var(--surface)" stroke-width="1.5" stroke-linecap="round"/>',
    ring:  '<circle cx="6" cy="6" r="4.8" fill="none" stroke="currentColor" stroke-width="1.5"/>'
  }[shape] || '';
  return `<svg class="pf-ico" viewBox="0 0 12 12" aria-hidden="true" focusable="false">${body}</svg>`;
}
/* m comes from perfFreshness or perfLegacyFreshness. Colour is never the only signal:
   a shape, a word and the times are all in it. The long form shows on hover and on
   keyboard focus; the same words are the accessible name. */
export function perfChipHtml(m, opts) {
  const compact = !!(opts && opts.compact);
  const label = [m.word, m.text].concat(m.tip).join('. ');
  return `<span class="pf-asof pf-${esc(m.level)}${compact ? ' pf-sm' : ''}" tabindex="0" role="group" aria-label="${esc(label)}">` +
    `${perfShape(m.shape)}<span class="pf-word">${esc(m.word)}</span>` +
    `<span class="pf-txt">${esc(compact ? m.short : m.text)}</span>` +
    `<span class="pf-tip" aria-hidden="true">${[m.text].concat(m.tip).map((l) => `<span>${esc(l)}</span>`).join('')}</span></span>`;
}
/* the small chip on the imported-numbers band and the Home "Total views" tile */
export function perfLegacyChipHtml() {
  ensurePerfStyles();
  return perfChipHtml(perfLegacyFreshness(DB, SM.at, Date.now()), { compact: true });
}

/* ---- talking to the staff routes ---- */
export async function perfCall(path, init, fetchImpl) {
  let res;
  try { res = await (fetchImpl || fetch)(path, init); } catch (e) { return { ok: false, status: 0, body: {} }; }
  let body = {};
  try { body = await res.json(); } catch (e) { body = {}; }
  if (!body || typeof body !== 'object') body = {};
  return { ok: !!res.ok, status: res.status, body };
}
/* one plain sentence for any failed call; null when the call worked */
export function perfProblem(r) {
  if (r.ok) return null;
  const said = perfText(r.body && r.body.error, 240);
  if (r.status === 0) return { kind: 'network', text: 'Could not reach the server. Showing what was already on this page.' };
  if (r.status === 401) return { kind: 'signin', text: 'You are signed out. Sign in as staff to see live performance.' };
  if (r.status === 403) return { kind: 'forbidden', text: 'Live performance is for staff only, and this account is not staff.' };
  if (r.status === 503) {
    if (r.body && (r.body.state === 'off' || !said)) return { kind: 'off', text: PERF_OFF_TEXT };
    return { kind: 'unavailable', text: said };
  }
  return { kind: 'error', text: said || 'Something went wrong. Try again in a minute.' };
}
/* Both reads, once, together. A second call inside PERF_CACHE_MS reuses the answer. */
export async function perfLoad(opts) {
  const o = opts || {};
  const now = o.nowMs != null ? o.nowMs : Date.now();
  if (!o.force && PERF.at && now - PERF.at < PERF_CACHE_MS && (PERF.snapResp || PERF.problem)) return PERF;
  if (PERF.loading) return PERF.loading;
  const gen = PERF.gen;
  const job = (async () => {
    try {
      const [st, sn] = await Promise.all([
        perfCall('/api/perf/status', undefined, o.fetchImpl),
        perfCall('/api/perf/snapshot', undefined, o.fetchImpl)]);
      if (gen !== PERF.gen) return PERF;        /* signed in or out meanwhile: drop this answer */
      const bad = !st.ok ? st : !sn.ok ? sn : null;
      const problem = bad ? perfProblem(bad) : null;
      if (problem && problem.kind !== 'network' && problem.kind !== 'error' && problem.kind !== 'unavailable') {
        /* signed out, not staff, or switched off: show nothing that was read earlier */
        PERF.status = null; PERF.snapResp = null;
      } else {
        if (st.ok) PERF.status = st.body;
        if (sn.ok) PERF.snapResp = sn.body;
      }
      PERF.problem = problem;
      PERF.at = o.nowMs != null ? o.nowMs : Date.now();
      return PERF;
    } finally { if (gen === PERF.gen) PERF.loading = null; }
  })();
  PERF.loading = job;
  return job;
}
export function perfWaitText(sec) {
  const n = perfNum(sec);
  if (n == null || n <= 0) return '';
  return n < 90 ? Math.ceil(n) + ' seconds' : Math.ceil(n / 60) + ' minutes';
}
export async function perfRefreshNow(opts) {
  const o = opts || {};
  const again = o.onChange || perfPaint;
  if (PERF.refresh.busy) return PERF.refresh;
  PERF.refresh = { busy: true, text: 'Reading the sheet…' };
  again();
  const r = await perfCall('/api/perf/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, o.fetchImpl);
  let text;
  if (r.status === 429) {
    const w = perfWaitText(r.body && r.body.retryAfterSec);
    text = (perfText(r.body && r.body.error, 240) || 'A refresh was started a moment ago.') + (w ? ' You can try again in about ' + w + '.' : '');
  } else if (!r.ok) {
    text = perfProblem(r).text;
  } else {
    await perfLoad({ force: true, fetchImpl: o.fetchImpl, nowMs: o.nowMs });
    const run = r.body && r.body.run;
    if (r.body && r.body.ok === false) text = perfText(run && run.message, 240) || 'The read did not work. Nothing was updated.';
    else text = PERF.status && PERF.status.dryRun ? 'Preview read finished. Nothing was stored, because preview mode is on.' : 'Read finished. The numbers are up to date.';
  }
  PERF.refresh = { busy: false, text };
  again();
  return PERF.refresh;
}
/* The body the match route takes. Nothing from the screen but ids the staff member picked. */
export function perfMatchBody(sheetCampaignId, choice) {
  if (!sheetCampaignId || !choice) return null;
  if (choice === PF_SHEET_ONLY) return { sheetCampaignId, sheetOnly: true };
  return { sheetCampaignId, dashboardCampaignId: choice };
}
export async function perfSaveMatch(sheetCampaignId, choice, opts) {
  const o = opts || {};
  const again = o.onChange || perfPaint;
  const body = perfMatchBody(sheetCampaignId, choice);
  if (!body) {
    PERF.matchMsg[sheetCampaignId] = 'Choose a dashboard campaign, or Sheet only, first.';
    again();
    return { ok: false };
  }
  PERF.matchMsg[sheetCampaignId] = 'Saving…';
  again();
  const r = await perfCall('/api/perf/match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, o.fetchImpl);
  if (!r.ok) {
    const p = perfProblem(r);
    PERF.matchMsg[sheetCampaignId] = (r.body && perfText(r.body.error, 240)) || (p && p.text) || 'Could not save.';
    again();
    return { ok: false };
  }
  delete PERF.picks[sheetCampaignId];
  await perfLoad({ force: true, fetchImpl: o.fetchImpl, nowMs: o.nowMs });
  PERF.matchMsg[sheetCampaignId] = 'Saved.';
  again();
  return { ok: true };
}

/* ---- the snapshot, copied through a whitelist ---- */
export function perfCleanPost(p) {
  if (!p || typeof p !== 'object') return null;
  const c = p.creator && typeof p.creator === 'object' ? p.creator : null;
  const f = p.flags && typeof p.flags === 'object' ? p.flags : {};
  const views = perfNum(p.views), likes = perfNum(p.likes);
  let er = perfNum(p.er);
  if (er != null && !(er > 0 && er <= 100)) er = null;       /* same rule as the server: 0, negative and over 100 are not a rate */
  const handle = c ? perfText(c.handle, 80) : '';
  const platform = perfText(p.platform, 40);
  return {
    id: perfText(p.deliverableId, 80), campaignId: perfText(p.sheetCampaignId, 80) || null,
    url: perfSafeUrl(p.postUrl), platform, handle,
    creatorKey: handle ? perfText(c.platform, 40).toLowerCase() + '|' + handle.toLowerCase() : '',
    posted: perfDay(p.postedDate), scraped: perfIso(p.lastScrapedAt),
    views, likes, er, hasReading: views != null || likes != null,
    readingOld: f.readingOld === true, neverRead: f.neverRead === true
  };
}
export function perfCleanCampaign(c) {
  if (!c || typeof c !== 'object') return null;
  const id = perfText(c.sheetCampaignId, 80);
  if (!id) return null;
  const m = c.match && typeof c.match === 'object' ? c.match : {};
  const cands = (Array.isArray(m.candidates) ? m.candidates : []).map((x) => (x && typeof x === 'object'
    ? { id: perfText(x.id, 80), name: perfText(x.name, 200) } : null)).filter((x) => x && x.id);
  return { id, name: perfText(c.name, 200) || 'Unnamed campaign',
    state: ['matched', 'needs-match', 'sheet-only'].includes(m.state) ? m.state : '',
    dashId: perfText(m.dashboardCampaignId, 80), reason: perfText(m.reason, 40), cands };
}
export function perfCleanNeeds(n) {
  if (!n || typeof n !== 'object') return null;
  const id = perfText(n.sheetCampaignId, 80);
  if (!id) return null;
  return { id, name: perfText(n.name, 200) || 'Unnamed campaign', reason: perfText(n.reason, 40),
    cands: (Array.isArray(n.candidates) ? n.candidates : []).map((x) => (x && typeof x === 'object'
      ? { id: perfText(x.id, 80), name: perfText(x.name, 200) } : null)).filter((x) => x && x.id) };
}

/* The arithmetic. Average ER is the plain mean of the valid rates; a post with no
   rate is left out of it, never counted as zero. Same formulas as the server's
   per-campaign stats, so a screen total matches a campaign line. */
export function perfStats(list) {
  const withReading = list.filter((p) => p.hasReading);
  const viewsRead = list.filter((p) => p.views != null);
  const likesRead = list.filter((p) => p.likes != null);
  const ers = list.map((p) => p.er).filter((x) => x != null);
  const scraped = list.map((p) => p.scraped).filter(Boolean).sort();
  return {
    posts: list.length, withReading: withReading.length,
    creators: new Set(list.map((p) => p.creatorKey).filter(Boolean)).size,
    views: viewsRead.length ? viewsRead.reduce((a, p) => a + p.views, 0) : null, viewsRead: viewsRead.length,
    likes: likesRead.length ? likesRead.reduce((a, p) => a + p.likes, 0) : null, likesRead: likesRead.length,
    avgEr: ers.length ? ers.reduce((a, b) => a + b, 0) / ers.length : null, erCount: ers.length,
    newest: scraped.length ? scraped[scraped.length - 1] : null
  };
}
export function perfPeriodDays(key) { const p = PF_PERIODS.find((x) => x[0] === key); return p ? p[2] : 0; }
export function perfFilterPosts(posts, f, nowMs) {
  const days = perfPeriodDays(f.period);
  const cutoff = days ? new Date(nowMs - (days - 1) * 86400000).toISOString().slice(0, 10) : '';
  return posts.filter((p) => (!f.platform || p.platform === f.platform)
    && (!cutoff || (p.posted && p.posted >= cutoff))
    && (!f.campaign || p.campaignId === f.campaign));
}
/* top 3 by views; ties go to the newest posted date, then the id */
export function perfTop3(posts) {
  return posts.filter((p) => p.views != null)
    .sort((a, b) => b.views - a.views || String(b.posted).localeCompare(String(a.posted)) || String(a.id).localeCompare(String(b.id)))
    .slice(0, 3);
}
export function perfSortValue(p, key, nameOf) {
  const v = key === 'creator' ? p.handle.toLowerCase() : key === 'campaign' ? nameOf(p).toLowerCase()
    : key === 'platform' ? p.platform.toLowerCase() : key === 'posted' ? p.posted
    : key === 'reading' ? p.scraped : key === 'views' ? p.views : key === 'likes' ? p.likes : key === 'er' ? p.er : null;
  return v === '' || v === undefined ? null : v;
}
/* a missing value goes last in either direction */
export function perfSortPosts(posts, sort, nameOf) {
  const dir = sort.dir === 'asc' ? 1 : -1;
  return posts.slice().sort((a, b) => {
    const x = perfSortValue(a, sort.key, nameOf), y = perfSortValue(b, sort.key, nameOf);
    if (x == null && y != null) return 1;
    if (y == null && x != null) return -1;
    if (x != null && y != null && x !== y) return (x < y ? -1 : 1) * dir;
    return String(b.posted).localeCompare(String(a.posted)) || String(a.id).localeCompare(String(b.id));
  });
}
/* one point per posted day. Days with no reading are left out of views, likes and
   rate (never plotted as zero) and counted, so the page can say so. */
export function perfTimeline(posts, metric) {
  const byDay = new Map();
  let noDate = 0;
  posts.forEach((p) => {
    if (!p.posted) { noDate++; return; }
    if (!byDay.has(p.posted)) byDay.set(p.posted, []);
    byDay.get(p.posted).push(p);
  });
  const labels = [], values = [];
  let leftOut = 0;
  [...byDay.keys()].sort().forEach((day) => {
    const list = byDay.get(day);
    const s = perfStats(list);
    const v = metric === 'count' ? list.length : metric === 'likes' ? s.likes : metric === 'er' ? s.avgEr : s.views;
    if (v == null) { leftOut++; return; }
    labels.push(day); values.push(metric === 'er' ? Math.round(v * 100) / 100 : v);
  });
  return { labels, values, leftOut, noDate };
}

/* ---- HTML (every dynamic string goes through esc) ---- */
export const PF_NA = (what) => `<span class="pf-na">—<span class="sr-only"> ${esc(what)}</span></span>`;
export const perfN = (v, what) => (v == null ? PF_NA(what || 'did not read') : esc(num(v)));
export const perfEr = (v) => (v == null ? PF_NA('no rate given') : esc(v.toFixed(2) + '%'));

export function perfBandHtml(st) {
  const none = st.posts === 0;
  const cell = (lab, big, cap) => `<div class="dk-b"><div class="lab">${esc(lab)}</div><div class="big">${big}</div><div class="cap">${esc(cap)}</div></div>`;
  const measured = (v, read, what) => (v == null
    ? cell(what, '—', none ? 'no posts' : 'Not measured')
    : cell(what, esc(num(v)), 'from ' + read + ' of ' + st.posts + ' post' + (st.posts === 1 ? '' : 's')));
  return `<div class="dk-band pf-band">
    ${cell('Posts', esc(num(st.posts)), st.withReading + ' have a reading')}
    ${cell('Creators', esc(num(st.creators)), 'with a handle in the sheet')}
    ${measured(st.views, st.viewsRead, 'Views')}
    ${measured(st.likes, st.likesRead, 'Likes')}
    ${st.avgEr == null ? cell('Average ER', '—', none ? 'no posts' : 'no rate given') : cell('Average ER', esc(st.avgEr.toFixed(2) + '%'), 'mean of ' + st.erCount + ' post' + (st.erCount === 1 ? '' : 's'))}
  </div>
  <p class="pf-reading">${esc(st.withReading + ' of ' + st.posts + ' posts have a reading.')}${st.posts && !st.withReading ? ' <strong>Not measured.</strong>' : ''}</p>`;
}
export function perfDefsHtml(snap) {
  const skipped = snap && snap.erTabs && Array.isArray(snap.erTabs.skipped) ? snap.erTabs.skipped.length : 0;
  return `<ul class="pf-defs">
    <li>Average engagement rate is the plain average of the rates the sheet gives. A post with no rate is left out, not counted as zero.</li>
    <li>— means the scraper did not read a number. It is not zero.</li>
    <li>Top 3 is the most views. A tie goes to the newer posted date.</li>
    <li>${esc(perfText(snap && snap.timeZoneNote, 120) || 'Dates are posted dates from the sheet.')}</li>
    ${skipped ? `<li>${esc(skipped + (skipped === 1 ? ' campaign tab' : ' campaign tabs') + ' had no readable engagement rate, so those posts show — for rate.')}</li>` : ''}
  </ul>`;
}
export function perfLinkHtml(p, label) {
  if (!p.url) return '<span class="pf-na">No link</span>';
  const who = p.handle || 'this creator';
  return `<a class="pf-link" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc('Open post by ' + who + ' (opens in a new tab)')}">${esc(label || 'Open')}</a>`;
}
export function perfMatchLabel(c, nameOfDash) {
  if (c.state === 'matched') return 'Matched' + (nameOfDash(c.dashId) ? ': ' + nameOfDash(c.dashId) : '');
  if (c.state === 'needs-match') return 'Needs a match';
  if (c.state === 'sheet-only') return 'Sheet only';
  return 'Not known';
}
export function perfCampaignsHtml(M, f, nowMs, nameOfDash) {
  const base = perfFilterPosts(M.posts, { platform: f.platform, period: f.period, campaign: '' }, nowMs);
  const rows = M.camps.map((c) => ({ c, s: perfStats(base.filter((p) => p.campaignId === c.id)) }))
    .sort((a, b) => (a.s.views == null) - (b.s.views == null) || (b.s.views || 0) - (a.s.views || 0) || a.c.name.localeCompare(b.c.name));
  if (!rows.length) return '<p class="so-hint">The sheet has no campaigns yet.</p>';
  const noCampaign = base.filter((p) => !p.campaignId).length;
  return `<div class="tbl-wrap"><table class="tbl pf-table"><caption class="sr-only">Campaigns in the sheet</caption>
    <thead><tr><th scope="col">Campaign</th><th scope="col" class="num">Posts</th><th scope="col" class="num">Views</th>
      <th scope="col" class="num">Likes</th><th scope="col" class="num">Avg ER</th><th scope="col">Newest reading</th><th scope="col">Match</th><th scope="col"><span class="sr-only">Open</span></th></tr></thead>
    <tbody>${rows.map(({ c, s }) => `<tr>
      <th scope="row" class="strong">${esc(c.name)}</th>
      <td class="num">${esc(num(s.posts))}<div class="pf-sub">${esc(s.withReading + ' read')}</div></td>
      <td class="num">${s.posts && !s.withReading ? '<span class="pf-sub">Not measured</span>' : perfN(s.views)}</td>
      <td class="num">${s.posts && !s.withReading ? '<span class="pf-sub">Not measured</span>' : perfN(s.likes)}</td>
      <td class="num">${perfEr(s.avgEr)}</td>
      <td>${s.newest ? esc(perfAgeText(nowMs - Date.parse(s.newest))) : '<span class="pf-na">never read</span>'}</td>
      <td>${esc(perfMatchLabel(c, nameOfDash))}</td>
      <td><button type="button" class="btn sm" data-pf-open="${esc(c.id)}" aria-label="${esc('Open ' + c.name)}">Open</button></td></tr>`).join('')}</tbody></table></div>
    ${noCampaign ? `<p class="so-hint">${esc(noCampaign + (noCampaign === 1 ? ' post is' : ' posts are') + ' not linked to any campaign in the sheet.')}</p>` : ''}`;
}
export function perfPlatformsHtml(posts) {
  const names = [...new Set(posts.map((p) => p.platform))].sort();
  if (!names.length) return '<p class="so-hint">No posts in this selection.</p>';
  const rows = names.map((n) => ({ n, s: perfStats(posts.filter((p) => p.platform === n)) })).sort((a, b) => b.s.posts - a.s.posts);
  return `<div class="tbl-wrap"><table class="tbl pf-table"><caption class="sr-only">Split by platform</caption>
    <thead><tr><th scope="col">Platform</th><th scope="col" class="num">Posts</th><th scope="col" class="num">Views</th><th scope="col" class="num">Likes</th><th scope="col" class="num">Avg ER</th></tr></thead>
    <tbody>${rows.map(({ n, s }) => `<tr><th scope="row" class="strong">${esc(n || 'Unknown')}</th>
      <td class="num">${esc(num(s.posts))}</td><td class="num">${perfN(s.views)}</td><td class="num">${perfN(s.likes)}</td><td class="num">${perfEr(s.avgEr)}</td></tr>`).join('')}</tbody></table></div>`;
}
export function perfTopHtml(posts, nameOf) {
  const top = perfTop3(posts);
  if (!top.length) return '<p class="so-hint">No post has a views reading yet.</p>';
  return `<ol class="pf-top">${top.map((p, i) => `<li class="pf-tc">
    <div class="pf-tc-h">${esc('#' + (i + 1))} · ${esc(p.handle || 'unknown creator')}</div>
    <div class="pf-tc-m">${esc(nameOf(p))} · ${esc(p.platform || 'platform not given')}${p.posted ? ' · posted ' + esc(p.posted) : ''}</div>
    <div class="pf-tc-n"><strong>${esc(num(p.views))}</strong> views · rate ${perfEr(p.er)}</div>
    <div>${perfLinkHtml(p, 'Open post')}</div></li>`).join('')}</ol>`;
}
export function perfTableHtml(posts, P, nowMs, nameOf) {
  const sorted = perfSortPosts(posts, P.sort, nameOf);
  const shown = sorted.slice(0, P.limit);
  const th = (c) => {
    const on = P.sort.key === c.key;
    const arrow = on ? (P.sort.dir === 'asc' ? '▲' : '▼') : '';
    return `<th scope="col" class="${c.num ? 'num' : ''}" aria-sort="${on ? (P.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">` +
      `<button type="button" class="pf-sort" data-pf-sort="${esc(c.key)}">${esc(c.label)}<span class="pf-arrow" aria-hidden="true">${arrow}</span></button></th>`;
  };
  if (!sorted.length) return '<p class="so-hint">No posts match these filters.</p>';
  return `<div class="tbl-wrap"><table class="tbl pf-table pf-posts"><caption class="sr-only">${esc('All posts, showing ' + shown.length + ' of ' + sorted.length)}</caption>
    <thead><tr>${PF_COLS.map(th).join('')}<th scope="col"><span class="sr-only">Link</span></th></tr></thead>
    <tbody>${shown.map((p) => `<tr>
      <th scope="row" class="strong">${esc(p.handle || 'unknown')}</th>
      <td>${esc(nameOf(p))}</td><td>${esc(p.platform || '—')}</td><td>${p.posted ? esc(p.posted) : PF_NA('no date')}</td>
      <td class="num">${perfN(p.views)}</td><td class="num">${perfN(p.likes)}</td><td class="num">${perfEr(p.er)}</td>
      <td>${p.scraped ? esc(perfAgeText(nowMs - Date.parse(p.scraped))) : '<span class="pf-na">never read</span>'}</td>
      <td>${perfLinkHtml(p)}</td></tr>`).join('')}</tbody></table></div>
    <p class="so-hint">${esc('Showing ' + shown.length + ' of ' + sorted.length + ' posts.')} — means the scraper did not read a number; it is not zero.
      ${sorted.length > shown.length ? '<button type="button" class="btn sm" data-pf-more="1">Show 100 more</button>' : ''}</p>`;
}
export function perfPickHtml(c, ctx, P, i) {
  const picked = P.picks[c.id] || '';
  const opt = (v, l) => `<option value="${esc(v)}"${v === picked ? ' selected' : ''}>${esc(l)}</option>`;
  const sugg = c.cands.length ? `<optgroup label="Suggested">${c.cands.map((x) => opt(x.id, x.name || x.id)).join('')}</optgroup>` : '';
  const why = { 'no-match': 'No dashboard campaign has this name.', ambiguous: 'More than one dashboard campaign could be this one.',
    shared: 'Another sheet campaign already points at the same dashboard campaign.' }[c.reason] || '';
  const msg = P.matchMsg[c.id] || '';
  return `<div class="pf-mrow">
    <div class="pf-mname"><strong>${esc(c.name)}</strong>${why ? `<div class="pf-sub">${esc(why)}</div>` : ''}</div>
    <div><label class="sr-only" for="pfPick${i}">${esc('Dashboard campaign for ' + c.name)}</label>
      <select id="pfPick${i}" data-pf-pick="${esc(c.id)}"><option value="">Choose a campaign…</option>${sugg}
        <optgroup label="All dashboard campaigns">${ctx.dash.map((d) => opt(d.id, d.label)).join('')}</optgroup>
        <optgroup label="Or">${opt(PF_SHEET_ONLY, 'Sheet only (not in the dashboard)')}</optgroup></select></div>
    <div><button type="button" class="btn sm primary" data-pf-save="${esc(c.id)}">Save</button></div>
    ${msg ? `<div class="pf-mmsg" role="status">${esc(msg)}</div>` : ''}</div>`;
}
export function perfMatchCardHtml(M, ctx, P) {
  /* Only the ones a person has to decide (ambiguous, shared) stay loud. A sheet campaign that
     simply has no dashboard counterpart (no-match) sits in the quiet Sheet only group with the
     ones already marked that way. */
  const rank = { ambiguous: 0, shared: 1 };
  const needs = M.needs.filter((n) => n.reason !== 'no-match')
    .sort((a, b) => (rank[a.reason] ?? 2) - (rank[b.reason] ?? 2) || a.name.localeCompare(b.name));
  const onlyIds = new Set();
  const only = M.camps.filter((c) => c.state === 'sheet-only').map((c) => ({ id: c.id, name: c.name, cands: c.cands, reason: '' }))
    .concat(M.needs.filter((n) => n.reason === 'no-match').map((n) => ({ id: n.id, name: n.name, cands: n.cands, reason: 'no-match' })))
    .filter((c) => (onlyIds.has(c.id) ? false : (onlyIds.add(c.id), true)))
    .sort((a, b) => a.name.localeCompare(b.name));
  let i = 0;
  const needsHtml = needs.length
    ? `<section class="pf-sec"><h4>Needs a match <span class="so-hint">${esc(needs.length + (needs.length === 1 ? ' campaign' : ' campaigns'))}</span></h4>
        <p class="so-hint">Pick the dashboard campaign each sheet campaign belongs to, or mark it Sheet only. Staff only.</p>
        ${needs.map((c) => perfPickHtml(c, ctx, P, i++)).join('')}</section>`
    : '';
  const onlyHtml = only.length
    ? `<details class="pf-quiet"><summary>${esc('Sheet only (' + only.length + ')')}</summary>
        <p class="so-hint">These sheet campaigns have no dashboard campaign. They stay out of the dashboard unless you link one.</p>
        ${only.map((c) => perfPickHtml(c, ctx, P, i++)).join('')}</details>`
    : '';
  return needsHtml + onlyHtml;
}
export function perfFiltersHtml(M, P) {
  const platforms = [...new Set(M.posts.map((p) => p.platform).filter(Boolean))].sort();
  const sel = (id, label, value, opts) => `<select id="${id}" class="${value ? 'on' : ''}" aria-label="${esc(label)}">${opts
    .map(([v, l]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return `<div class="so-filters pf-filters">
    ${sel('pfCampaign', 'Campaign', P.campaign, [['', 'Campaign: all']].concat(M.camps.map((c) => [c.id, c.name])))}
    ${sel('pfPlatform', 'Platform', P.platform, [['', 'Platform: all']].concat(platforms.map((x) => [x, x])))}
    ${sel('pfPeriod', 'Posted', P.period, PF_PERIODS.map((x) => [x[0], x[1]]))}
    <button type="button" class="btn sm" data-pf-reset="1">Reset</button></div>`;
}
export function perfBannerHtml(P, M) {
  const out = [];
  const box = (cls, shape, text) => `<div class="pf-banner ${cls}" role="status">${perfShape(shape)}<span>${esc(text)}</span></div>`;
  if (P.problem) {
    let text = P.problem.text;
    if (P.problem.kind === 'network' && M.snap) {
      const from = perfKst(M.snap.checkedAt);
      text = 'Could not reach the server. Showing numbers from ' + (from || 'earlier') + '.';
    }
    out.push(box(P.problem.kind === 'off' ? '' : 'warn', P.problem.kind === 'off' ? 'ring' : 'warn', text));
  } else if (P.snapResp && P.snapResp.banner && perfText(P.snapResp.banner.text, 300)) {
    const k = perfText(P.snapResp.banner.kind, 40);
    const info = ['off', 'waiting', 'dry-run'].includes(k);
    out.push(box(info ? '' : 'warn', info ? 'ring' : 'warn', perfText(P.snapResp.banner.text, 300)));
  }
  const dry = P.status && P.status.lastDryRun && P.status.lastDryRun.counts;
  if (dry && typeof dry === 'object') {
    const n = (k) => (perfNum(dry[k]) == null ? null : num(dry[k]));
    const bits = [['posts', 'deliverables'], ['creators', 'influencers'], ['campaigns', 'campaigns'], ['still need a match', 'campaignsNeedMatch']]
      .map(([label, key]) => (n(key) == null ? '' : n(key) + ' ' + label)).filter(Boolean);
    if (bits.length) out.push(box('', 'ring', 'Last preview read found ' + bits.join(', ') + '. Nothing was stored.'));
  }
  return out.join('');
}

/* the whole live section. P is PERF (or a stand-in in tests); ctx = { nowMs, dash: [{id, label}] } */
export function perfHtml(P, ctx) {
  const resp = P.snapResp && typeof P.snapResp === 'object' ? P.snapResp : null;
  const snap = resp && resp.snapshot && typeof resp.snapshot === 'object' ? resp.snapshot : null;
  const M = {
    snap, posts: snap && Array.isArray(snap.posts) ? snap.posts.map(perfCleanPost).filter(Boolean) : [],
    camps: snap && Array.isArray(snap.campaigns) ? snap.campaigns.map(perfCleanCampaign).filter(Boolean) : [],
    needs: snap && Array.isArray(snap.needsMatch) ? snap.needsMatch.map(perfCleanNeeds).filter(Boolean) : []
  };
  const dashName = new Map(ctx.dash.map((d) => [d.id, d.label]));
  const nameOfDash = (id) => dashName.get(id) || '';
  const campName = new Map(M.camps.map((c) => [c.id, c.name]));
  const nameOf = (p) => (p.campaignId ? campName.get(p.campaignId) || 'Unknown campaign' : 'No campaign');
  const off = !!(P.problem && P.problem.kind === 'off');
  const blocked = off || !!(P.problem && ['signin', 'forbidden'].includes(P.problem.kind));
  const status = P.status || {};
  const chipM = perfFreshness(resp && resp.freshness, snap && snap.checkedAt, snap && snap.newestReadingAt, ctx.nowMs,
    perfNum(status.intervalMin) || perfNum(snap && snap.intervalMin) || 30);
  const camp = P.campaign && campName.has(P.campaign) ? P.campaign : '';
  const f = { campaign: camp, platform: P.platform, period: P.period };
  const inScope = perfFilterPosts(M.posts, f, ctx.nowMs);
  const st = perfStats(inScope);
  const cur = camp ? M.camps.find((c) => c.id === camp) : null;

  const head = `<div class="pf-head">
    <div><div class="eyebrow">Social</div><h3 class="pf-title">${cur ? esc(cur.name) : 'Live performance'}</h3></div>
    <div class="pf-headr">${blocked ? '' : perfChipHtml(chipM)}
      ${blocked ? '' : `<button type="button" class="btn sm" data-pf-refresh="1"${P.refresh.busy ? ' disabled aria-busy="true"' : ''}>${P.refresh.busy ? 'Reading…' : 'Refresh now'}</button>`}</div>
  </div>
  ${P.refresh.text ? `<p class="pf-msg">${esc(P.refresh.text)}</p>` : ''}
  ${perfBannerHtml(P, M)}`;

  if (!snap) {
    const loading = !!P.loading && !P.problem && !resp;
    return `<section class="pf-wrap" aria-label="Live performance">${head}${loading ? '<p class="so-hint">Reading live performance…</p>'
      : blocked ? '' : '<p class="so-hint">No live readings are stored yet.</p>'}</section>`;
  }

  const back = cur ? `<button type="button" class="btn sm" data-pf-back="1">← All campaigns</button>` : '';
  const curMatch = cur ? `<p class="so-hint">${esc(perfMatchLabel(cur, nameOfDash))}</p>` : '';
  const timeline = `<section class="pf-sec"><div class="so-chart-h"><h4>Timeline by posted date</h4>
      <div class="so-seg" role="group" aria-label="Timeline metric">${PF_METRICS.map(([v, l]) =>
        `<button type="button" data-pf-metric="${v}" aria-pressed="${P.metric === v}">${esc(l)}</button>`).join('')}</div></div>
      <div id="pfTime"></div><p class="so-hint" id="pfTimeNote"></p></section>`;
  const matchBlock = cur
    ? (cur.state === 'needs-match' || cur.state === 'sheet-only' ? perfMatchCardHtml({ needs: M.needs.filter((n) => n.id === cur.id), camps: M.camps.filter((c) => c.id === cur.id) }, ctx, P) : '')
    : perfMatchCardHtml(M, ctx, P);

  return `<section class="pf-wrap" aria-label="Live performance">${head}
    ${back}${curMatch}
    ${perfFiltersHtml(M, P)}
    ${perfBandHtml(st)}
    ${perfDefsHtml(snap)}
    ${cur ? '' : `<section class="pf-sec"><h4>Campaigns</h4>${perfCampaignsHtml(M, f, ctx.nowMs, nameOfDash)}</section>
      <section class="pf-sec"><h4>Platforms</h4>${perfPlatformsHtml(inScope)}</section>`}
    <section class="pf-sec"><h4>Top 3 posts by views</h4>${perfTopHtml(inScope, nameOf)}</section>
    ${timeline}
    <section class="pf-sec"><h4>All posts</h4>${perfTableHtml(inScope, P, ctx.nowMs, nameOf)}</section>
    ${matchBlock}
  </section>`;
}

export function ensurePerfStyles() {
  if (document.getElementById('pfCss')) return;
  const s = document.createElement('style');
  s.id = 'pfCss';
  s.textContent = `
  .pf{margin-bottom:var(--sp-6,32px)}
  .pf-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--sp-3,12px);margin-bottom:var(--sp-3,12px)}
  .pf-headr{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-2,8px)}
  .pf-title{margin:2px 0 0;font:650 var(--fs-card-title,15px)/1.25 var(--font)}
  .pf-msg{margin:0 0 var(--sp-3,12px);font:400 var(--fs-caption,12px)/1.4 var(--font);color:var(--text-2)}
  .pf-sec{margin-top:var(--sp-5,24px)}
  .pf-sec h4{margin:0 0 var(--sp-2,8px);font:600 var(--fs-card-title,15px)/1.3 var(--font)}
  .pf-sub{font:400 var(--fs-caption,12px)/1.3 var(--font);color:var(--text-3)}
  .pf-na{color:var(--text-3)}
  .pf-reading{margin:var(--sp-2,8px) 0 0;font:500 var(--fs-caption,12px)/1.4 var(--font);color:var(--text-2)}
  .pf-defs{margin:var(--sp-2,8px) 0 0;padding-left:18px;font:400 var(--fs-caption,12px)/1.5 var(--font);color:var(--text-3)}
  .pf .btn,.pf select,.pf-sort{min-height:var(--hit,40px)}
  .pf-filters{margin:var(--sp-3,12px) 0}
  .pf-asof{position:relative;display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:4px 10px;
    border-radius:var(--r-pill);border:1px solid var(--line-strong);background:var(--surface-2);color:var(--text-2);
    font:500 var(--fs-caption,12px)/1.3 var(--font);cursor:default;vertical-align:middle}
  .pf-asof::after{content:'';position:absolute;left:0;right:0;top:50%;height:100%;min-height:var(--hit,40px);transform:translateY(-50%)}
  .pf-asof:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
  .pf-ico{flex:0 0 auto;width:12px;height:12px}
  .pf-word{font-weight:600}
  .pf-txt{color:var(--text-2)}
  .pf-green{color:var(--success);background:var(--success-bg)}
  .pf-amber{color:var(--warn-ink);background:var(--warn-bg);border-color:var(--warn-line)}
  .pf-red{color:var(--danger);background:var(--danger-bg)}
  .pf-sm{padding:2px 8px;margin-left:var(--sp-2,8px)}
  .hm-sat .pf-sm{margin:var(--sp-2,8px) 0 0}
  .pf-tip{display:none;position:absolute;left:0;top:calc(100% + 6px);z-index:40;width:max-content;min-width:220px;max-width:min(360px,80vw);
    padding:var(--sp-2,8px) var(--sp-3,12px);background:var(--surface);color:var(--text);border:1px solid var(--line-strong);
    border-radius:var(--r);box-shadow:var(--shadow-2,none);font:400 var(--fs-caption,12px)/1.45 var(--font);white-space:normal}
  .pf-tip span{display:block}
  .pf-asof:hover .pf-tip,.pf-asof:focus .pf-tip,.pf-asof:focus-within .pf-tip{display:block}
  .pf-banner{display:flex;gap:var(--sp-2,8px);align-items:flex-start;padding:var(--sp-3,12px);margin-bottom:var(--sp-3,12px);
    border:1px solid var(--line-strong);border-radius:var(--r);background:var(--surface-2);color:var(--text);font:400 var(--fs-body,14px)/1.45 var(--font)}
  .pf-banner .pf-ico{margin-top:4px}
  .pf-banner.warn{background:var(--warn-bg);border-color:var(--warn-line)}
  .pf-top{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--sp-3,12px)}
  .pf-tc{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:var(--sp-3,12px);display:flex;flex-direction:column;gap:var(--sp-1,4px)}
  .pf-tc-h{font:600 var(--fs-body,14px)/1.3 var(--font);overflow-wrap:anywhere}
  .pf-tc-m{font:400 var(--fs-caption,12px)/1.4 var(--font);color:var(--text-3);overflow-wrap:anywhere}
  .pf-tc-n{font:400 var(--fs-body,14px)/1.4 var(--font);font-variant-numeric:tabular-nums}
  .pf-link{display:inline-flex;align-items:center;min-height:var(--hit,40px);color:var(--blue-hi);font-weight:500}
  .pf-link:focus-visible,.pf-sort:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
  .pf-table th.num,.pf-table td.num{font-variant-numeric:tabular-nums}
  .pf-table th[scope=row]{text-align:left;font-weight:500}
  .pf-sort{display:inline-flex;align-items:center;gap:4px;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:inherit;cursor:pointer}
  .pf-arrow{min-width:1em}
  .pf-mrow{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1.2fr) auto;gap:var(--sp-2,8px) var(--sp-3,12px);align-items:center;padding:var(--sp-3,12px) 0;border-top:1px solid var(--line)}
  .pf-mname{overflow-wrap:anywhere}
  .pf-mmsg{grid-column:1/-1;font:400 var(--fs-caption,12px)/1.4 var(--font);color:var(--text-2)}
  .pf-quiet{margin-top:var(--sp-4,16px);color:var(--text-3)}
  .pf-quiet summary{cursor:pointer;min-height:var(--hit,40px);display:flex;align-items:center;font:500 var(--fs-caption,12px)/1.3 var(--font)}
  @media(max-width:1000px){.pf-band .dk-b:last-child{grid-column:span 2}}
  @media(max-width:640px){
    .pf-top{grid-template-columns:1fr}
    .pf-mrow{grid-template-columns:1fr}
    .pf-head{align-items:flex-start}
    .pf-tip{left:auto;right:0}
  }`;
  document.head.appendChild(s);
}

/* ---- on the page ---- */
export function perfCtx() {
  return { nowMs: Date.now(), dash: (DB.campaigns || []).map((c) => ({ id: c.id, label: [c.brand, c.name].filter(Boolean).join(' · ') || c.id })) };
}
export function perfDrawTimeline(root) {
  const mount = $('#pfTime', root), note = $('#pfTimeNote', root);
  if (!mount) return;
  const resp = PERF.snapResp, snap = resp && resp.snapshot;
  if (!snap || !Array.isArray(snap.posts)) return;
  const campIds = new Set((snap.campaigns || []).map((c) => c && c.sheetCampaignId));
  const camp = PERF.campaign && campIds.has(PERF.campaign) ? PERF.campaign : '';
  const posts = perfFilterPosts(snap.posts.map(perfCleanPost).filter(Boolean),
    { campaign: camp, platform: PERF.platform, period: PERF.period }, Date.now());
  const t = perfTimeline(posts, PERF.metric);
  const label = (PF_METRICS.find((m) => m[0] === PERF.metric) || PF_METRICS[0])[1];
  if (!t.labels.length) {
    mount.innerHTML = '<div class="empty" style="padding:18px">No dated posts with a reading in this selection.</div>';
  } else {
    mount.innerHTML = '';
    lineChart(mount, { labels: t.labels, series: [{ name: label, values: t.values, color: SERIES_HEX[0], area: true }], height: 220,
      title: 'Timeline by posted date: ' + label, format: PERF.metric === 'er' ? (v) => v.toFixed(2) + '%' : PERF.metric === 'count' ? num : kmb });
  }
  if (note) {
    const bits = [];
    if (t.leftOut) bits.push(t.leftOut + (t.leftOut === 1 ? ' day' : ' days') + ' left out: no reading, not zero');
    if (t.noDate) bits.push(t.noDate + (t.noDate === 1 ? ' post has' : ' posts have') + ' no posted date');
    note.textContent = bits.join(' · ');
  }
}
export function perfPaint() {
  const root = $('#pfLive');
  if (!root) return;
  const a = document.activeElement;
  const keep = a && root.contains(a)
    ? ['data-pf-sort', 'data-pf-metric', 'data-pf-refresh', 'data-pf-more', 'data-pf-open', 'data-pf-back', 'data-pf-save', 'data-pf-reset', 'id']
        .map((k) => [k, a.getAttribute(k)]).find((x) => x[1] != null)
    : null;
  root.innerHTML = perfHtml(PERF, perfCtx());
  root.setAttribute('aria-busy', PERF.loading ? 'true' : 'false');
  perfDrawTimeline(root);
  const say = $('#pfAnnounce');
  if (say && say.textContent !== PERF.refresh.text) say.textContent = PERF.refresh.text;
  if (keep) {
    const again = [...root.querySelectorAll('[' + keep[0] + ']')].find((n) => n.getAttribute(keep[0]) === keep[1]);
    if (again) again.focus();
  }
}
export function perfWire(root) {
  root.addEventListener('click', (ev) => {
    const t = ev.target.closest ? ev.target.closest('button') : null;
    if (!t || !root.contains(t)) return;
    if (t.hasAttribute('data-pf-sort')) {
      const key = t.getAttribute('data-pf-sort');
      PERF.sort = PERF.sort.key === key ? { key, dir: PERF.sort.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: ['views', 'likes', 'er', 'posted', 'reading'].includes(key) ? 'desc' : 'asc' };
      PERF.limit = 100; perfPaint();
    } else if (t.hasAttribute('data-pf-metric')) { PERF.metric = t.getAttribute('data-pf-metric'); perfPaint(); }
    else if (t.hasAttribute('data-pf-open')) { PERF.campaign = t.getAttribute('data-pf-open'); PERF.limit = 100; perfPaint(); }
    else if (t.hasAttribute('data-pf-back')) { PERF.campaign = ''; PERF.limit = 100; perfPaint(); }
    else if (t.hasAttribute('data-pf-more')) { PERF.limit += 100; perfPaint(); }
    else if (t.hasAttribute('data-pf-reset')) { Object.assign(PERF, { campaign: '', platform: '', period: 'all', limit: 100 }); perfPaint(); }
    else if (t.hasAttribute('data-pf-refresh')) { perfRefreshNow(); }
    else if (t.hasAttribute('data-pf-save')) {
      const id = t.getAttribute('data-pf-save');
      perfSaveMatch(id, PERF.picks[id] || '');
    }
  });
  root.addEventListener('change', (ev) => {
    const t = ev.target;
    if (!t || !t.id && !t.hasAttribute('data-pf-pick')) return;
    if (t.hasAttribute('data-pf-pick')) { PERF.picks[t.getAttribute('data-pf-pick')] = t.value; return; }
    if (t.id === 'pfCampaign') PERF.campaign = t.value;
    else if (t.id === 'pfPlatform') PERF.platform = t.value;
    else if (t.id === 'pfPeriod') PERF.period = t.value;
    else return;
    PERF.limit = 100; perfPaint();
  });
}

/* ============================================================
   REPORTS: THE REPORT BUILDER (#/overview/report), staff only

   Reads the same cached snapshot as Social > Performance (perfLoad) and
   turns it into a report page you can check, export as CSV and print.
   It is not shared with anyone from here: no public link, no email, no
   share button. A report that goes to a brand needs counsel's answer first.

   Rules the code keeps:
   - the report is built from a short whitelist: campaign name, platform,
     handle, post link, type, posted date, six counts, rate, reading time.
     Creator names, emails, contacts, rates, amounts, budgets, notes, cost
     figures, the sheet address, Notion links and internal ids are never read
   - every string goes through esc (page) or rbCsvText (file); a cell that
     starts with = + - @ gets an apostrophe in front of it
   - a number nobody read is "—" (blank in the CSV), never 0
   - the report sheet is always light (paper), whatever the app theme
   - printing shows the report and nothing else: no controls, no staff note
   ============================================================ */

export const RB_COLS = ['campaign', 'platform', 'handle', 'post URL', 'type', 'posted date', 'views', 'likes', 'comments', 'shares', 'saves', 'reposts', 'ER', 'last reading time'];
export const RB_PERIODS = [['all', 'All time'], ['30', 'Last 30 days'], ['custom', 'Custom dates']];
export const RB_METRICS = [['views', 'Views'], ['likes', 'Likes'], ['comments', 'Comments'], ['shares', 'Shares'], ['saves', 'Saves'],
  ['reposts', 'Reposts'], ['er', 'Average ER'], ['count', 'Posts']];
export const RB_SORTS = [['newest', 'Newest posted first', { key: 'posted', dir: 'desc' }], ['oldest', 'Oldest posted first', { key: 'posted', dir: 'asc' }],
  ['views', 'Most views', { key: 'views', dir: 'desc' }], ['likes', 'Most likes', { key: 'likes', dir: 'desc' }],
  ['er', 'Highest ER', { key: 'er', dir: 'desc' }], ['creator', 'Handle A to Z', { key: 'creator', dir: 'asc' }]];
export const RB_NONE = '__not_linked__';
export const RB_MAX_ROWS = 1500;
export const RB_BLOCKED_HOST = /(^|\.)(docs\.google\.com|drive\.google\.com|sheets\.google\.com|notion\.so|notion\.site|notion\.com)$/i;
export const RB_TRACKING = ['igsh', 'igshid', 'fbclid', 'si', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

/* what the builder remembers between repaints; cleared on sign-in and sign-out (perfReset) */
export const RBT = { sel: new Set(), period: 'all', from: '', to: '', metric: 'views', sort: 'newest', msg: '', hooked: false };
export function rbReset() {
  Object.assign(RBT, { sel: new Set(), period: 'all', from: '', to: '', metric: 'views', sort: 'newest', msg: '' });
}

/* ---- strict readers ---- */
export const rbCount = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
/* one line of plain text: control characters and line breaks become spaces */
export const rbLine = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200) : '');
/* a post link without sharing-tracking parts, and never a link into the sheet or Notion */
export function rbTidyUrl(u) {
  if (!u) return '';
  try {
    const x = new URL(u);
    if (RB_BLOCKED_HOST.test(x.hostname)) return '';
    RB_TRACKING.forEach((k) => x.searchParams.delete(k));
    x.hash = '';
    return x.href;
  } catch (e) { return ''; }
}
export function rbUrlLabel(u) {
  try {
    const x = new URL(u);
    const s = x.hostname.replace(/^www\./i, '') + x.pathname.replace(/\/$/, '');
    return s.length > 44 ? s.slice(0, 43) + '…' : s;
  } catch (e) { return ''; }
}
export function rbCleanPost(p) {
  const b = perfCleanPost(p);
  if (!b) return null;
  const t = Date.parse(b.scraped);
  return Object.assign(b, {
    url: rbTidyUrl(b.url), handle: rbLine(b.handle, 80), platform: rbLine(b.platform, 40), type: rbLine(p.type, 40),
    scraped: Number.isFinite(t) ? new Date(t).toISOString() : '',
    comments: rbCount(p.comments), shares: rbCount(p.shares), saves: rbCount(p.saves), reposts: rbCount(p.reposts)
  });
}

/* ---- what can be chosen: sheet campaigns that have posts, named like the dashboard names them when matched ---- */
export function rbOptions(posts, camps, dashBy) {
  const count = new Map();
  let none = 0;
  posts.forEach((p) => { if (p.campaignId) count.set(p.campaignId, (count.get(p.campaignId) || 0) + 1); else none++; });
  const out = camps.filter((c) => count.get(c.id)).map((c) => {
    const d = c.state === 'matched' && c.dashId ? dashBy.get(c.dashId) : null;
    const brand = rbLine(d && d.brand, 80), name = rbLine((d && d.name) || c.name, 120) || 'Unnamed campaign';
    return { id: c.id, brand, name, label: brand ? brand + ' · ' + name : name, posts: count.get(c.id) };
  }).sort((a, b) => a.label.localeCompare(b.label));
  if (none) out.push({ id: RB_NONE, brand: '', name: 'Not linked to a campaign', label: 'Not linked to a campaign', posts: none });
  return out;
}
export function rbRange(ui, nowMs) {
  if (ui.period === '30') {
    const from = new Date(nowMs - 29 * 86400000).toISOString().slice(0, 10);
    return { mode: '30', from, to: '', error: '', label: 'Last 30 days: posted from ' + from };
  }
  if (ui.period === 'custom') {
    const from = perfDay(ui.from), to = perfDay(ui.to);
    if (from && to && from > to) return { mode: 'custom', from, to, error: 'The start date is after the end date.', label: '' };
    return { mode: 'custom', from, to, error: '',
      label: from && to ? 'Posted ' + from + ' to ' + to : from ? 'Posted from ' + from : to ? 'Posted up to ' + to : 'All posted dates' };
  }
  return { mode: 'all', from: '', to: '', error: '', label: 'All posted dates' };
}
export function rbStats(list) {
  const s = perfStats(list);
  const sum = (k) => {
    const r = list.filter((p) => p[k] != null);
    return { v: r.length ? r.reduce((a, p) => a + p[k], 0) : null, read: r.length };
  };
  return Object.assign(s, { comments: sum('comments'), shares: sum('shares'), saves: sum('saves'), reposts: sum('reposts') });
}
export function rbTitle(chosen) {
  if (!chosen.length) return { brand: '', name: '', list: [] };
  if (chosen.length === 1) return { brand: chosen[0].brand, name: chosen[0].name, list: [] };
  /* a brand heads the report only when every chosen campaign has that same brand */
  const brands = [...new Set(chosen.map((c) => c.brand))];
  return { brand: brands.length === 1 ? brands[0] : '', name: chosen.length + ' campaigns', list: chosen.map((c) => c.label) };
}
/* one point per posted day; a day with no number is left out (never drawn as zero) and counted */
export function rbTimeline(posts, metric) {
  const byDay = new Map();
  let noDate = 0;
  posts.forEach((p) => {
    if (!p.posted) { noDate++; return; }
    if (!byDay.has(p.posted)) byDay.set(p.posted, []);
    byDay.get(p.posted).push(p);
  });
  const days = [];
  let leftOut = 0;
  [...byDay.keys()].sort().forEach((day) => {
    const list = byDay.get(day);
    let v;
    if (metric === 'count') v = list.length;
    else if (metric === 'er') { const s = perfStats(list); v = s.avgEr; }
    else { const r = list.filter((p) => p[metric] != null); v = r.length ? r.reduce((a, p) => a + p[metric], 0) : null; }
    if (v == null) { leftOut++; return; }
    days.push({ day, value: metric === 'er' ? Math.round(v * 100) / 100 : v });
  });
  return { days, leftOut, noDate };
}

/* P is PERF (or a stand-in), ctx = { nowMs, dash: [{ id, brand, name }] }, ui = RBT (or a stand-in) */
export function rbModel(P, ctx, ui) {
  const resp = P.snapResp && typeof P.snapResp === 'object' ? P.snapResp : null;
  const snap = resp && resp.snapshot && typeof resp.snapshot === 'object' ? resp.snapshot : null;
  const posts = snap && Array.isArray(snap.posts) ? snap.posts.map(rbCleanPost).filter(Boolean) : [];
  const camps = snap && Array.isArray(snap.campaigns) ? snap.campaigns.map(perfCleanCampaign).filter(Boolean) : [];
  const dashBy = new Map((ctx.dash || []).map((d) => [d.id, d]));
  const options = rbOptions(posts, camps, dashBy);
  const known = new Set(options.map((o) => o.id));
  const sel = new Set([...ui.sel].filter((id) => known.has(id)));
  const chosen = options.filter((o) => sel.has(o.id));
  const labelOf = new Map(options.map((o) => [o.id, o.label]));
  const nameOf = (p) => labelOf.get(p.campaignId || RB_NONE) || 'Unknown campaign';
  const range = rbRange(ui, ctx.nowMs);
  const byCamp = posts.filter((p) => sel.has(p.campaignId || RB_NONE));
  const limited = !!(range.from || range.to);
  const undatedLeftOut = limited ? byCamp.filter((p) => !p.posted).length : 0;
  const inRange = (p) => !limited || (p.posted && (!range.from || p.posted >= range.from) && (!range.to || p.posted <= range.to));
  const scope = range.error ? [] : byCamp.filter(inRange);
  const sortDef = (RB_SORTS.find((x) => x[0] === ui.sort) || RB_SORTS[0])[2];
  const rows = perfSortPosts(scope, sortDef, nameOf);
  const metric = RB_METRICS.some((x) => x[0] === ui.metric) ? ui.metric : 'views';
  const stats = rbStats(scope);
  const off = !!(P.problem && P.problem.kind === 'off');
  const blocked = off || !!(P.problem && ['signin', 'forbidden'].includes(P.problem.kind));
  const checked = snap ? perfKst(snap.checkedAt) : '';
  let line;
  if (!snap) line = '';
  else if (!chosen.length) line = 'Choose at least one campaign to see the report.';
  else line = scope.length + (scope.length === 1 ? ' post' : ' posts') + ' from ' + chosen.length + (chosen.length === 1 ? ' campaign' : ' campaigns') + ' in the report.';
  return {
    resp, snap, blocked, off, loading: !!P.loading && !P.problem && !resp,
    options, chosen, sel, range, scope, rows, shown: rows.slice(0, RB_MAX_ROWS), truncated: rows.length > RB_MAX_ROWS,
    stats, top: perfTop3(scope), timeline: rbTimeline(scope, metric), metric, nameOf,
    title: rbTitle(chosen), undatedLeftOut, line, sortKey: (RB_SORTS.find((x) => x[0] === ui.sort) || RB_SORTS[0])[0],
    checkedKst: checked, tzNote: rbLine(snap && snap.timeZoneNote, 120),
    newestKst: (() => { const t = scope.map((p) => p.scraped).filter(Boolean).sort(); return t.length ? perfKst(t[t.length - 1]) : ''; })(),
    nowMs: ctx.nowMs
  };
}

/* ---- the CSV: header row is the whitelist and nothing else ---- */
export function rbCsvText(v) {
  let s = rbLine(v == null ? '' : String(v), 500);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function rbCsv(m) {
  const n = (v) => (v == null ? '' : String(v));
  const lines = [RB_COLS.join(',')].concat(m.rows.map((p) => [
    rbCsvText(m.nameOf(p)), rbCsvText(p.platform), rbCsvText(p.handle), rbCsvText(p.url), rbCsvText(p.type), rbCsvText(p.posted),
    n(p.views), n(p.likes), n(p.comments), n(p.shares), n(p.saves), n(p.reposts), p.er == null ? '' : p.er.toFixed(2) + '%', rbCsvText(p.scraped)
  ].join(',')));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
export function rbFileName(m) {
  const base = m.chosen.length === 1 ? m.chosen[0].label : m.chosen.length + ' campaigns';
  const slug = base.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'report';
  const day = new Date(m.nowMs + 9 * 3600000).toISOString().slice(0, 10);
  return 'vively-report-' + slug + '-' + day + '.csv';
}

/* ---- the report sheet (this is what prints; no staff control is inside it) ---- */
export const rbNa = (what) => `<span class="rp-na">—<span class="sr-only"> ${esc(what || 'did not read')}</span></span>`;
export const rbN = (v) => (v == null ? rbNa() : esc(num(v)));
export const rbEr = (v) => (v == null ? rbNa('no rate given') : esc(v.toFixed(2) + '%'));
export function rbLinkHtml(p) {
  if (!p.url) return '<span class="rp-na">No link</span>';
  return `<a class="rp-link" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(rbUrlLabel(p.url) || 'Open post')}</a>`;
}
export function rbBandHtml(m) {
  const st = m.stats, none = st.posts === 0;
  const cell = (lab, big, cap) => `<div class="rp-b"><div class="rp-bl">${esc(lab)}</div><div class="rp-bn">${big}</div><div class="rp-bc">${esc(cap)}</div></div>`;
  const plural = (n) => n + ' post' + (n === 1 ? '' : 's');
  const measured = (lab, v, read) => (v == null
    ? cell(lab, '—', none ? 'no posts' : 'Not measured')
    : cell(lab, esc(num(v)), 'from ' + read + ' of ' + plural(st.posts)));
  return `<div class="rp-band">
    ${cell('Posts', esc(num(st.posts)), st.withReading + ' of ' + st.posts + ' have a reading')}
    ${cell('Creators', esc(num(st.creators)), 'different handles')}
    ${measured('Views', st.views, st.viewsRead)}
    ${measured('Likes', st.likes, st.likesRead)}
    ${measured('Comments', st.comments.v, st.comments.read)}
    ${measured('Shares', st.shares.v, st.shares.read)}
    ${measured('Saves', st.saves.v, st.saves.read)}
    ${measured('Reposts', st.reposts.v, st.reposts.read)}
    ${st.avgEr == null ? cell('Average ER', '—', none ? 'no posts' : 'no rate given') : cell('Average ER', esc(st.avgEr.toFixed(2) + '%'), 'mean of ' + st.erCount + ' of ' + plural(st.posts))}
  </div>`;
}
export function rbNotesHtml(m) {
  const st = m.stats;
  const li = [
    `${st.withReading} of ${st.posts} posts have a reading (views or likes).`,
    'Average engagement rate (ER) is the plain average of the engagement rates in the sheet. A post with no rate is left out, not counted as zero. ' +
      st.erCount + ' of ' + st.posts + ' posts have a rate.',
    '— means no number was read. It is not zero.'
  ];
  if (m.tzNote) li.push(m.tzNote);
  if (m.undatedLeftOut) li.push(m.undatedLeftOut + (m.undatedLeftOut === 1 ? ' post has' : ' posts have') + ' no posted date and is left out of this period.');
  return `<ul class="rp-notes">${li.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
}
export function rbTopHtml(m) {
  if (!m.top.length) return '<p class="rp-empty">No post in this report has a views reading yet.</p>';
  return `<ol class="rp-top">${m.top.map((p, i) => `<li class="rp-tc">
    <div class="rp-tc-h">${esc('#' + (i + 1))} · ${esc(p.handle || 'unknown creator')}</div>
    <div class="rp-tc-m">${esc(m.nameOf(p))} · ${esc([p.platform, p.type].filter(Boolean).join(' · ') || 'platform not given')}${p.posted ? ' · posted ' + esc(p.posted) : ''}</div>
    <div class="rp-tc-n"><strong>${esc(num(p.views))}</strong> views · ER ${rbEr(p.er)}</div>
    <div>${rbLinkHtml(p)}</div></li>`).join('')}</ol>`;
}
export function rbChartHtml(m) {
  const t = m.timeline;
  const label = (RB_METRICS.find((x) => x[0] === m.metric) || RB_METRICS[0])[1];
  const fmt = (v) => (m.metric === 'er' ? v.toFixed(2) + '%' : num(v));
  const notes = [];
  if (t.leftOut) notes.push(t.leftOut + (t.leftOut === 1 ? ' day' : ' days') + ' left out: no reading, not zero');
  if (t.noDate) notes.push(t.noDate + (t.noDate === 1 ? ' post has' : ' posts have') + ' no posted date');
  const note = notes.length ? `<p class="rp-cap">${esc(notes.join(' · '))}</p>` : '';
  if (!t.days.length) return `<p class="rp-empty">No dated posts with a number for ${esc(label.toLowerCase())} in this report.</p>${note}`;
  const t0 = Date.parse(t.days[0].day + 'T00:00:00Z');
  const span = Math.round((Date.parse(t.days[t.days.length - 1].day + 'T00:00:00Z') - t0) / 86400000);
  const W = Math.max(span + 1, 14);
  const max = Math.max(1, ...t.days.map((d) => d.value));
  const best = t.days.reduce((a, d) => (d.value > a.value ? d : a), t.days[0]);
  const bars = t.days.map((d) => {
    const off = Math.round((Date.parse(d.day + 'T00:00:00Z') - t0) / 86400000);
    let h = (d.value / max) * 100;
    if (d.value > 0 && h < 1) h = 1;
    return `<rect class="rp-bar" x="${off + 0.1}" y="${(100 - h).toFixed(2)}" width="0.8" height="${h.toFixed(2)}"><title>${esc(d.day + ': ' + fmt(d.value))}</title></rect>`;
  }).join('');
  const sum = label + ' by posted date: ' + t.days.length + (t.days.length === 1 ? ' day' : ' days') + ' from ' + t.days[0].day + ' to ' + t.days[t.days.length - 1].day +
    ', highest ' + fmt(best.value) + ' on ' + best.day + '.';
  return `<svg class="rp-svg" viewBox="0 0 ${W} 100" preserveAspectRatio="none" role="img" aria-label="${esc(sum)}">
      <line class="rp-axis" x1="0" x2="${W}" y1="100" y2="100"/>${bars}</svg>
    <div class="rp-axis-l"><span>${esc(t.days[0].day)}</span><span>${esc('Highest ' + fmt(best.value) + ' · ' + best.day)}</span><span>${esc(t.days[t.days.length - 1].day)}</span></div>
    ${note}
    <table class="sr-only"><caption>${esc(label + ' by posted date')}</caption><thead><tr><th scope="col">Posted</th><th scope="col">${esc(label)}</th></tr></thead>
      <tbody>${t.days.map((d) => `<tr><th scope="row">${esc(d.day)}</th><td>${esc(fmt(d.value))}</td></tr>`).join('')}</tbody></table>`;
}
export function rbTableHtml(m) {
  if (!m.rows.length) return '<p class="rp-empty">No posts in this report.</p>';
  const many = m.chosen.length > 1;
  const head = ['Post', 'Posted', 'Views', 'Likes', 'Comments', 'Shares', 'Saves', 'Reposts', 'ER'];
  return `<div class="rp-tw"><table class="rp-tbl"><caption class="sr-only">${esc('All posts, ' + m.shown.length + ' of ' + m.rows.length)}</caption>
    <thead><tr>${head.map((h, i) => `<th scope="col"${i >= 2 ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${m.shown.map((p) => `<tr>
      <th scope="row" class="rp-post"><span class="rp-hd">${esc(p.handle || 'unknown')}</span>
        <span class="rp-sub">${esc([p.platform, p.type].filter(Boolean).join(' · ') || 'platform not given')}</span>
        ${many ? `<span class="rp-sub">${esc(m.nameOf(p))}</span>` : ''}${rbLinkHtml(p)}</th>
      <td>${p.posted ? esc(p.posted) : rbNa('no date')}</td>
      <td class="num">${rbN(p.views)}</td><td class="num">${rbN(p.likes)}</td><td class="num">${rbN(p.comments)}</td>
      <td class="num">${rbN(p.shares)}</td><td class="num">${rbN(p.saves)}</td><td class="num">${rbN(p.reposts)}</td><td class="num">${rbEr(p.er)}</td></tr>`).join('')}</tbody></table></div>
    ${m.truncated ? `<p class="rp-cap">${esc('The table shows the first ' + num(RB_MAX_ROWS) + ' of ' + num(m.rows.length) + ' posts. The CSV file has all of them.')}</p>` : ''}`;
}
export function rbDocHtml(m) {
  const t = m.title;
  const h1 = t.brand ? `<span class="rp-t1">${esc(t.brand)}</span> <span class="rp-t2">${esc(t.name)}</span>` : `<span class="rp-t1">${esc(t.name)}</span>`;
  return `<article class="rp-sheet" aria-label="Performance report">
    <header class="rp-top-block">
      <p class="rp-eyebrow">Performance report</p>
      <h2 class="rp-h1">${h1}</h2>
      ${t.list.length ? `<p class="rp-meta">${esc('Campaigns: ' + t.list.join('; '))}</p>` : ''}
      <p class="rp-meta">${esc(m.range.label)}</p>
      <p class="rp-meta">${esc('Data as of ' + (m.checkedKst || 'unknown time'))}${m.newestKst ? esc(' · newest post reading ' + m.newestKst) : ''}</p>
    </header>
    <section class="rp-sec" aria-label="Performance summary"><h3 class="rp-h2">Performance summary</h3>${rbBandHtml(m)}${rbNotesHtml(m)}</section>
    <section class="rp-sec" aria-label="Top 3 posts by views"><h3 class="rp-h2">Top 3 posts by views</h3>${rbTopHtml(m)}</section>
    <section class="rp-sec" aria-label="Timeline by posted date"><h3 class="rp-h2">${esc('Timeline by posted date: ' + (RB_METRICS.find((x) => x[0] === m.metric) || RB_METRICS[0])[1])}</h3>${rbChartHtml(m)}</section>
    <section class="rp-sec rp-sec-tbl" aria-label="All posts"><h3 class="rp-h2">All posts</h3>${rbTableHtml(m)}</section>
    <footer class="rp-foot">${esc('Data as of ' + (m.checkedKst || 'unknown time'))}</footer>
  </article>`;
}
/* the repeating page footer, for browsers that support page margin boxes; the closing footer line above is the fallback */
export function rbPrintCss(m) {
  const t = m.checkedKst;
  if (!/^[0-9A-Za-z :-]{1,60}$/.test(t)) return '';
  return `<style>@page rp{@bottom-center{content:"Data as of ${t}";font-size:9pt;color:black}}</style>`;
}

/* ---- the builder page (screen only) ---- */
export function rbControlsHtml(m, ui) {
  const opt = (o) => `<label class="rb-opt"><input type="checkbox" data-rb-camp="${esc(o.id)}"${m.sel.has(o.id) ? ' checked' : ''}>
    <span>${esc(o.label)} <span class="rb-sub">${esc(o.posts + (o.posts === 1 ? ' post' : ' posts'))}</span></span></label>`;
  const custom = ui.period === 'custom';
  const ready = m.scope.length > 0;
  return `<fieldset class="rb-fs"><legend>Campaigns</legend>
      ${m.options.length ? `<div class="rb-row"><button type="button" class="btn sm" data-rb-all="1">Select all</button><button type="button" class="btn sm" data-rb-none="1">Clear</button></div>
      <div class="rb-list">${m.options.map(opt).join('')}</div>` : '<p class="rb-sub">No campaign in the sheet has posts yet.</p>'}
    </fieldset>
    <fieldset class="rb-fs"><legend>Posted date</legend>
      ${RB_PERIODS.map(([v, l]) => `<label class="rb-opt"><input type="radio" name="rbPeriod" data-rb-period="${esc(v)}" value="${esc(v)}"${ui.period === v ? ' checked' : ''}><span>${esc(l)}</span></label>`).join('')}
      <div class="rb-dates"><label>From<input type="date" id="rbFrom" value="${esc(perfDay(ui.from))}"${custom ? '' : ' disabled'}></label>
        <label>To<input type="date" id="rbTo" value="${esc(perfDay(ui.to))}"${custom ? '' : ' disabled'}></label></div>
      ${m.range.error ? `<p class="rb-warn">${esc(m.range.error)}</p>` : ''}
    </fieldset>
    <div class="rb-fs"><label class="rb-lab" for="rbSort">Table order</label>
      <select id="rbSort">${RB_SORTS.map(([v, l]) => `<option value="${esc(v)}"${m.sortKey === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
    <fieldset class="rb-fs"><legend>Timeline shows</legend>
      <div class="so-seg" role="group" aria-label="Timeline metric">${RB_METRICS.map(([v, l]) =>
        `<button type="button" data-rb-metric="${esc(v)}" aria-pressed="${m.metric === v}">${esc(l)}</button>`).join('')}</div>
    </fieldset>
    <div class="rb-actions">
      <button type="button" class="btn primary" data-rb-print="1"${ready ? '' : ' disabled'}>Print / Save as PDF</button>
      <button type="button" class="btn" data-rb-csv="1"${ready ? '' : ' disabled'}>Download CSV</button></div>
    ${ready ? '' : '<p class="rb-sub">Choose a campaign with posts in the period to turn these on.</p>'}
    <aside class="rb-card"><h4>Content insights</h4>
      <p class="rb-sub">Not in this version. Reading captions and hashtags from public pages needs an answer on platform terms first.</p></aside>`;
}
export function rbHtml(m, P, ui, ctx) {
  const status = P.status || {};
  const chip = m.blocked ? '' : perfChipHtml(perfFreshness(m.resp && m.resp.freshness, m.snap && m.snap.checkedAt, m.snap && m.snap.newestReadingAt, ctx.nowMs,
    perfNum(status.intervalMin) || perfNum(m.snap && m.snap.intervalMin) || 30));
  const head = `<div class="rb-head"><div><div class="eyebrow">Reports</div><h2 class="rb-title">Build a report</h2></div>
    <div class="rb-headr">${chip}${m.blocked ? '' : `<button type="button" class="btn sm" data-rb-refresh="1"${P.refresh.busy ? ' disabled aria-busy="true"' : ''}>${P.refresh.busy ? 'Reading…' : 'Refresh now'}</button>`}</div></div>
    ${P.refresh.text ? `<p class="rb-msg">${esc(P.refresh.text)}</p>` : ''}
    ${perfBannerHtml(P, { snap: m.snap })}`;
  if (!m.snap) {
    return `<section class="rb-wrap" aria-label="Report builder">${head}${m.loading ? '<p class="rb-sub">Reading live performance…</p>'
      : m.blocked ? '' : '<p class="rb-sub">No live readings are stored yet, so there is nothing to report on.</p>'}</section>`;
  }
  let preview;
  if (!m.chosen.length) preview = '<p class="rb-empty">Choose at least one campaign on the left. The report appears here.</p>';
  else if (m.range.error) preview = `<p class="rb-empty">${esc(m.range.error)}</p>`;
  else if (!m.scope.length) preview = '<p class="rb-empty">No posts match this campaign and period. Try All time.</p>';
  else preview = rbDocHtml(m);
  return `<section class="rb-wrap" aria-label="Report builder">${head}
    <div class="rb-grid">
      <div class="rb-side">${rbControlsHtml(m, ui)}</div>
      <div class="rb-main">
        <p class="rb-staff" role="note"><strong>Staff copy: check before sharing.</strong> Handles, post links and public numbers only. This note and the controls do not print.</p>
        <div class="rb-prev" role="region" aria-label="Report preview" tabindex="0">${preview}</div>
      </div>
    </div></section>`;
}

/* The one rule block. The sheet's colours are its own paper palette (--pp-*), the only place hex appears. */
export const RB_CSS = `
  #reportPrint{display:none}
  .rb{margin-bottom:var(--sp-6,32px)}
  .rb-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--sp-3,12px);margin-bottom:var(--sp-3,12px)}
  .rb-headr{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-2,8px)}
  .rb-title{margin:2px 0 0;font:650 var(--fs-card-title,15px)/1.25 var(--font)}
  .rb-msg{margin:0 0 var(--sp-3,12px);font:400 var(--fs-caption,12px)/1.4 var(--font);color:var(--text-2)}
  .rb-sub{font:400 var(--fs-caption,12px)/1.4 var(--font);color:var(--text-3)}
  .rb-grid{display:grid;grid-template-columns:minmax(260px,320px) minmax(0,1fr);gap:var(--sp-5,24px);align-items:start}
  .rb-side{display:flex;flex-direction:column;gap:var(--sp-4,16px);min-width:0}
  .rb-fs{margin:0;padding:var(--sp-3,12px);border:1px solid var(--line);border-radius:var(--r);background:var(--surface);min-width:0}
  .rb-fs legend{padding:0 var(--sp-1,4px);font:600 var(--fs-card-title,15px)/1.3 var(--font)}
  .rb-row,.rb-actions{display:flex;flex-wrap:wrap;gap:var(--sp-2,8px)}
  .rb-list{max-height:280px;overflow-y:auto;margin-top:var(--sp-2,8px)}
  .rb-opt{display:flex;align-items:center;gap:var(--sp-2,8px);min-height:var(--hit,40px);cursor:pointer;font:400 var(--fs-body,14px)/1.3 var(--font);overflow-wrap:anywhere}
  .rb-opt input{width:20px;height:20px;flex:0 0 auto}
  .rb-dates{display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-2,8px);margin-top:var(--sp-2,8px)}
  .rb-dates label,.rb-lab{display:flex;flex-direction:column;gap:var(--sp-1,4px);font:400 var(--fs-caption,12px)/1.3 var(--font);color:var(--text-2)}
  .rb-warn{margin:var(--sp-2,8px) 0 0;font:500 var(--fs-caption,12px)/1.4 var(--font);color:var(--danger)}
  .rb .btn,.rb select,.rb input[type=date]{min-height:var(--hit,40px)}
  .rb select,.rb input[type=date]{max-width:100%}
  .rb input:focus-visible,.rb select:focus-visible,.rb .btn:focus-visible,.rb-prev:focus-visible,.rb .so-seg button:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
  .rb-card{padding:var(--sp-3,12px);border:1px dashed var(--line-strong);border-radius:var(--r)}
  .rb-card h4{margin:0 0 var(--sp-1,4px);font:600 var(--fs-body,14px)/1.3 var(--font)}
  .rb-staff{margin:0 0 var(--sp-3,12px);padding:var(--sp-3,12px);border:1px solid var(--warn-line);border-radius:var(--r);background:var(--warn-bg);color:var(--text);font:400 var(--fs-body,14px)/1.45 var(--font)}
  .rb-prev{overflow-x:auto;min-width:0}
  .rb-empty{margin:0;padding:var(--sp-5,24px);border:1px dashed var(--line-strong);border-radius:var(--r);color:var(--text-2);font:400 var(--fs-body,14px)/1.45 var(--font)}
  .rp-sheet{--pp-bg:#ffffff;--pp-ink:#111111;--pp-ink2:#555555;--pp-ink3:#666666;--pp-line:#d3d5db;--pp-blue:#0b63f6;
    box-sizing:border-box;max-width:210mm;margin:0 auto;padding:var(--sp-5,24px);background:var(--pp-bg);color:var(--pp-ink);
    border:1px solid var(--line-strong);border-radius:var(--r-lg,16px);font:400 var(--fs-body,14px)/1.45 var(--font);
    -webkit-print-color-adjust:exact;print-color-adjust:exact}
  .rp-eyebrow{margin:0 0 var(--sp-2,8px);font:600 var(--fs-eyebrow,12px)/1.3 var(--font);letter-spacing:.08em;text-transform:uppercase;color:var(--pp-ink3)}
  .rp-h1{margin:0;font:700 var(--fs-title,28px)/1.15 var(--font);letter-spacing:-.03em;color:var(--pp-ink);text-wrap:balance;overflow-wrap:anywhere}
  .rp-t2{color:var(--pp-ink2)}
  .rp-meta{margin:var(--sp-2,8px) 0 0;color:var(--pp-ink2);font:400 var(--fs-body,14px)/1.45 var(--font);overflow-wrap:anywhere}
  .rp-sec{margin-top:var(--sp-5,24px)}
  .rp-h2{margin:0 0 var(--sp-3,12px);font:650 var(--fs-card-title,15px)/1.3 var(--font);color:var(--pp-ink);break-after:avoid;page-break-after:avoid}
  .rp-band{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:var(--sp-2,8px)}
  .rp-b{padding:var(--sp-3,12px);border:1px solid var(--pp-line);border-radius:var(--r-sm,6px);min-width:0;break-inside:avoid;page-break-inside:avoid}
  .rp-bl{font:600 var(--fs-caption,12px)/1.3 var(--font);color:var(--pp-ink3)}
  .rp-bn{margin:var(--sp-1,4px) 0;font:600 var(--fs-kpi,28px)/1.1 var(--font);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
  .rp-bc{font:400 var(--fs-caption,12px)/1.3 var(--font);color:var(--pp-ink2)}
  .rp-notes{margin:var(--sp-3,12px) 0 0;padding-left:18px;font:400 var(--fs-caption,12px)/1.5 var(--font);color:var(--pp-ink2)}
  .rp-cap,.rp-empty{margin:var(--sp-2,8px) 0 0;font:400 var(--fs-caption,12px)/1.5 var(--font);color:var(--pp-ink2)}
  .rp-na{color:var(--pp-ink3)}
  .rp-top{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--sp-3,12px)}
  .rp-tc{padding:var(--sp-3,12px);border:1px solid var(--pp-line);border-radius:var(--r-sm,6px);display:flex;flex-direction:column;gap:var(--sp-1,4px);min-width:0;break-inside:avoid;page-break-inside:avoid}
  .rp-tc-h{font:600 var(--fs-body,14px)/1.3 var(--font);overflow-wrap:anywhere}
  .rp-tc-m{font:400 var(--fs-caption,12px)/1.4 var(--font);color:var(--pp-ink2);overflow-wrap:anywhere}
  .rp-tc-n{font:400 var(--fs-body,14px)/1.4 var(--font);font-variant-numeric:tabular-nums}
  .rp-link{color:var(--pp-blue);text-decoration:underline;overflow-wrap:anywhere;font:400 var(--fs-caption,12px)/1.4 var(--font)}
  .rp-svg{display:block;width:100%;height:160px;overflow:visible}
  .rp-bar{fill:var(--pp-blue)}
  .rp-axis{stroke:var(--pp-line);stroke-width:1;vector-effect:non-scaling-stroke}
  .rp-axis-l{display:flex;justify-content:space-between;gap:var(--sp-2,8px);margin-top:var(--sp-1,4px);font:400 var(--fs-caption,12px)/1.3 var(--font);color:var(--pp-ink2)}
  .rp-tw{overflow-x:auto}
  .rp-tbl{width:100%;min-width:720px;border-collapse:collapse;font:400 var(--fs-caption,12px)/1.4 var(--font);color:var(--pp-ink)}
  .rp-tbl thead{display:table-header-group}
  .rp-tbl tr{break-inside:avoid;page-break-inside:avoid}
  .rp-tbl th{padding:6px 8px;text-align:left;font-weight:600;color:var(--pp-ink2);border-bottom:2px solid var(--pp-ink);vertical-align:bottom}
  .rp-tbl td,.rp-tbl th[scope=row]{padding:6px 8px;border-bottom:1px solid var(--pp-line);vertical-align:top;font-weight:400;color:var(--pp-ink)}
  .rp-tbl .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .rp-post{overflow-wrap:anywhere}
  .rp-post>span,.rp-post>a{display:block}
  .rp-hd{font-weight:600}
  .rp-sub{color:var(--pp-ink2)}
  .rp-foot{margin-top:var(--sp-5,24px);padding-top:var(--sp-2,8px);border-top:1px solid var(--pp-line);font:400 var(--fs-caption,12px)/1.3 var(--font);color:var(--pp-ink2)}
  @media screen{.rp-link{display:inline-flex;align-items:center;min-height:var(--hit,40px)}}
  @media(max-width:900px){.rb-grid{grid-template-columns:1fr}}
  @media(max-width:640px){
    .rb-dates{grid-template-columns:1fr}
    .rp-sheet{padding:var(--sp-3,12px)}
    .rp-top{grid-template-columns:1fr}
    .rp-band{grid-template-columns:repeat(2,minmax(0,1fr))}
    .rp-bn{font-size:var(--fs-title-phone,24px)}
  }
  @page rp{size:A4;margin:14mm 14mm 18mm}
  @media print{
    body.print-report>*{display:none!important}
    body.print-report>#reportPrint{display:block!important;page:rp}
    body.print-report{height:auto!important;overflow:visible!important;background:white!important;color:black!important}
    #reportPrint .rp-sheet{max-width:none;margin:0;padding:0;border:0;border-radius:0;font-size:10pt}
    #reportPrint .rp-band{grid-template-columns:repeat(3,minmax(0,1fr))}
    #reportPrint .rp-sec{break-inside:avoid;page-break-inside:avoid}
    #reportPrint .rp-sec-tbl{break-inside:auto;page-break-inside:auto}
    #reportPrint .rp-tw{overflow:visible}
    #reportPrint .rp-tbl{min-width:0;table-layout:fixed;font-size:9pt}
    #reportPrint .rp-tbl th:first-child{width:32%}
    #reportPrint .rp-link{font-size:9pt;min-height:0;display:block}
    #reportPrint .rp-foot{margin-top:var(--sp-4,16px)}
  }`;
export function ensureReportBuilderStyles() {
  if (document.getElementById('rbCss')) return;
  const s = document.createElement('style');
  s.id = 'rbCss';
  s.textContent = RB_CSS;
  document.head.appendChild(s);
}

/* ---- on the page ---- */
export function rbCtx() {
  return { nowMs: Date.now(), dash: (DB.campaigns || []).map((c) => ({ id: c.id, brand: c.brand, name: c.name })) };
}
export function rbCurrent() { return rbModel(PERF, rbCtx(), RBT); }
export function rbPaint() {
  const root = $('#rbRoot');
  if (!root) return;
  const a = document.activeElement;
  const attrs = ['data-rb-camp', 'data-rb-period', 'data-rb-metric', 'data-rb-all', 'data-rb-none', 'data-rb-print', 'data-rb-csv', 'data-rb-refresh', 'id'];
  const keep = a && root.contains(a) ? attrs.map((k) => [k, a.getAttribute(k)]).find((x) => x[1] != null) : null;
  const list = root.querySelector('.rb-list');
  const scroll = list ? list.scrollTop : 0;
  const ctx = rbCtx(), m = rbModel(PERF, ctx, RBT);
  root.innerHTML = rbHtml(m, PERF, RBT, ctx);
  root.setAttribute('aria-busy', PERF.loading ? 'true' : 'false');
  const nl = root.querySelector('.rb-list');
  if (nl) nl.scrollTop = scroll;
  const say = $('#rbAnnounce');
  if (say) say.textContent = RBT.msg || m.line;
  RBT.msg = '';
  if (keep) {
    const again = [...root.querySelectorAll('[' + keep[0] + ']')].find((n) => n.getAttribute(keep[0]) === keep[1]);
    if (again) again.focus();
  }
}
export function rbPrintNode() {
  let n = document.getElementById('reportPrint');
  if (!n) { n = document.createElement('div'); n.id = 'reportPrint'; document.body.appendChild(n); }
  return n;
}
/* Fill the print copy from the current choices. Runs from the Print button and from the
   browser's own beforeprint, so Ctrl+P on this page prints the report and not the app. */
export function rbFillPrint() {
  if (!document.getElementById('rbRoot')) return false;
  const m = rbCurrent();
  if (!m.scope.length) return false;
  rbPrintNode().innerHTML = rbPrintCss(m) + rbDocHtml(m);
  document.body.classList.add('print-report');
  return true;
}
export function rbClearPrint() {
  document.body.classList.remove('print-report');
  const n = document.getElementById('reportPrint');
  if (n) n.innerHTML = '';
}
export function rbPrint() {
  if (!rbFillPrint()) { RBT.msg = 'Nothing to print: choose a campaign with posts in the period.'; rbPaint(); return; }
  RBT.msg = 'Opening the print window. Choose Save as PDF as the printer to make a PDF file.';
  rbPaint();
  window.print();
}
export function rbDownloadCsv() {
  const m = rbCurrent();
  if (!m.rows.length) { RBT.msg = 'Nothing to export: choose a campaign with posts in the period.'; rbPaint(); return; }
  downloadFile(rbCsv(m), rbFileName(m), 'text/csv;charset=utf-8');
  RBT.msg = 'CSV file downloaded with ' + m.rows.length + (m.rows.length === 1 ? ' row.' : ' rows.');
  rbPaint();
}
export function rbWire(root) {
  root.addEventListener('click', (ev) => {
    const t = ev.target.closest ? ev.target.closest('button') : null;
    if (!t || !root.contains(t) || t.disabled) return;
    if (t.hasAttribute('data-rb-all')) { RBT.sel = new Set(rbCurrent().options.filter((o) => o.id !== RB_NONE).map((o) => o.id)); rbPaint(); }
    else if (t.hasAttribute('data-rb-none')) { RBT.sel = new Set(); rbPaint(); }
    else if (t.hasAttribute('data-rb-metric')) { RBT.metric = t.getAttribute('data-rb-metric'); rbPaint(); }
    else if (t.hasAttribute('data-rb-print')) rbPrint();
    else if (t.hasAttribute('data-rb-csv')) rbDownloadCsv();
    else if (t.hasAttribute('data-rb-refresh')) perfRefreshNow({ onChange: () => { RBT.msg = PERF.refresh.text; rbPaint(); } });
  });
  root.addEventListener('change', (ev) => {
    const t = ev.target;
    if (!t) return;
    if (t.hasAttribute('data-rb-camp')) {
      const id = t.getAttribute('data-rb-camp');
      if (t.checked) RBT.sel.add(id); else RBT.sel.delete(id);
    } else if (t.hasAttribute('data-rb-period')) { if (RB_PERIODS.some((x) => x[0] === t.value)) RBT.period = t.value; }
    else if (t.id === 'rbFrom') RBT.from = perfDay(t.value);
    else if (t.id === 'rbTo') RBT.to = perfDay(t.value);
    else if (t.id === 'rbSort') { if (RB_SORTS.some((x) => x[0] === t.value)) RBT.sort = t.value; }
    else return;
    rbPaint();
  });
}
export function renderReportBuilder(view) {
  ensurePerfStyles();
  ensureDeskStyles();
  ensureOverviewStyles();
  ensureReportBuilderStyles();
  rbPrintNode();
  if (!RBT.hooked && typeof window.addEventListener === 'function') {
    RBT.hooked = true;
    window.addEventListener('beforeprint', rbFillPrint);
    window.addEventListener('afterprint', rbClearPrint);
  }
  view.innerHTML = `<div id="rbAnnounce" class="sr-only" role="status" aria-live="polite"></div>
    <div id="rbRoot" class="rb" aria-busy="true"></div>`;
  rbWire($('#rbRoot'));
  const reading = perfLoad();
  rbPaint();
  reading.then(rbPaint, rbPaint);
}

/* The page. The live section is on top; the imported-numbers page that was here before
   sits underneath it, untouched, so nothing it showed goes away. */
export function renderSocialOverview(view) {
  ensurePerfStyles();
  ensureDeskStyles();          /* the stat band is the Desk's: dk-band / dk-b */
  ensureOverviewStyles();      /* the filter pills */
  view.innerHTML = `<div id="pfAnnounce" class="sr-only" role="status" aria-live="polite"></div>
    <div id="pfLive" class="pf" aria-busy="true"></div>
    <p class="so-hint" style="margin:var(--sp-4,16px) 0 var(--sp-2,8px)">Below: the numbers from the sheet import in Setup. They only change when someone runs it.</p>
    <div id="pfLegacy"></div>`;
  perfWire($('#pfLive'));
  renderSocialOverviewLegacy($('#pfLegacy'));
  const reading = perfLoad();   /* starts (or reuses) the read before the first paint, so the page says it is reading */
  perfPaint();
  reading.then(perfPaint, perfPaint);
}

export const SOCIAL_OVERVIEW_ITEMS = [
  { id: 'overview', label: 'Performance', sub: 'live numbers, then the imported ones' }
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

export function renderSocialOverviewLegacy(view) {
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
          <div class="so-lab">Total views ${perfLegacyChipHtml()}</div>
          <div class="so-big">${num(k.views)}</div>
          <div class="so-sub">${num(k.content)} total content · ${num(k.measuredCount)} measured
            · ${pct(k.coverage, 0)} coverage${platformLine ? ' · ' + esc(platformLine) : ''}</div>
          <div class="so-sats">
            ${withHistory ? `<div class="so-sat"><div class="l">+24h</div><div class="v off">—</div>
              <div class="s">${num(withHistory)} posts have history</div></div>` : ''}
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
      <div>
        <div>
          <div class="so-sec"><h4>What's measured</h4><div class="ln"></div></div>
          <div id="soCoverageViz"></div>
        </div>
      </div>

      <div>
        <div class="so-sec"><h4>Top performing content</h4><div class="ln"></div>
</div>
        <div id="soTopViz"></div>
      </div>

      <div class="so-duo">
        <div>
          <div class="so-sec"><h4>Campaign performance</h4><div class="ln"></div>
</div>
          <div id="soCampaignViz"></div>
        </div>
        <div>
          <div class="so-sec"><h4>Engagement breakdown</h4><div class="ln"></div></div>
          <div id="soEngViz"></div>
          <div class="so-sec" style="margin-top:28px"><h4>Needs review</h4><div class="ln"></div></div>
          <div style="display:flex;flex-direction:column;gap:11px">
            <div class="so-row"><span>Unassigned content</span>
              <span style="font:500 12px/1 var(--font);color:${unassigned ? 'var(--warning)' : 'var(--text-3)'}">${num(unassigned)}</span></div>
            <div class="so-row"><span>Suggested matches to confirm</span>
              <span style="font:500 12px/1 var(--font);color:${suggested ? 'var(--warning)' : 'var(--text-3)'}">${num(suggested)}</span></div>
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
            : `<span style="font:500 11.5px/1 var(--font);color:var(--text-2)">${num(p.value)} · ${pct(p.share, 1)}</span>`}
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
          <span style="font:500 11.5px/1 var(--font);color:var(--text-2)">${num(c.have)} / ${num(c.of)}</span>
        </div>
        <div class="so-meter"><i style="width:${c.of ? (c.have / c.of * 100).toFixed(1) : 0}%"></i></div>
      </div>`).join('');
  }
}
