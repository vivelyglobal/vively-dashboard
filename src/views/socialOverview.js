import { SERIES_HEX, barsH, lineChart } from '../charts/index.js';
import { columnChart } from '../charts/socialViz.js';
import { kmb, num, pct } from '../lib/format.js';
import { DB, notify } from '../model/db.js';
import { OVERVIEW_METRICS, byCampaignRollup, byMarketRollup, byPlatformRollup, engagementSplit, overviewCoverage, overviewFilter, overviewKpis, overviewRows, overviewSeries, topContent, unmappedCountries, viewDistribution } from '../model/socialStats.js';
import { SM } from '../sync/sheetMetrics.js';
import { $, $$, esc } from '../ui/dom.js';
import { emptyState } from '../ui/html.js';
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
