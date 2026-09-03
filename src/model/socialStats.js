import { DB } from './db.js';

/* ============================================================
   SOCIAL STATS — every number the Overview shows

   Deliberately free of the DOM: the Overview reads these, the tests
   read these, and nothing here knows a chart exists. Where the data
   cannot answer a question the answer is null or a stated gap, never
   a zero dressed up as a measurement — 54 of 97 posts currently have
   no metrics at all, and a chart that folds them into "under 1K"
   would be lying about the distribution.
   ============================================================ */

/* Creator nationality is free text typed into a Notion form, and it
   shows: Japan arrives as Japan, JAPAN, japan, 日本, 일본 and 🇯🇵, all
   of which are the same market. Left raw, the market chart splits one
   country into six slivers and reads as noise.

   This map is display-only. It never rewrites the creator record or
   anything in Notion — the roster keeps whatever was typed, and the
   Overview groups it on the way past. Canonical name first, then
   every spelling seen in the data. */
export const COUNTRY_ALIASES = {
  Japan: ['japan', '日本', '일본', '🇯🇵', 'jp', 'japanese'],
  India: ['india', 'indian'],
  Indonesia: ['indonesia', 'indonesian'],
  Iran: ['iran', 'iranian', 'persian'],
  Morocco: ['morocco', 'moroccan', 'korean moroccan'],
  Egypt: ['egypt', 'egyptian'],
  'United States': ['usa', 'us', 'u.s.', 'united states', 'american'],
  Korea: ['korea', 'south korea', 'republic of korea', 'repbulic of korea', 'korean', '한국'],
  Philippines: ['philippines', 'philippines (filipino)', 'filipino'],
  Ukraine: ['ukraine', 'ukrainian'],
  Russia: ['russia', 'russian'],
  Uzbekistan: ['uzbekistan', 'uzbek'],
  Tajikistan: ['tajikistan', 'tajik'],
  Colombia: ['colombia', 'colombian'],
  Sweden: ['sweden', 'swedish'],
  Nepal: ['nepal', 'nepali'],
  Pakistan: ['pakistan', 'pakistani'],
  Thailand: ['thailand', 'thai'],
  Bahrain: ['bahrain', 'bahraini'],
  Turkey: ['turkey', 'turkish'],
  Malaysia: ['malaysia', 'malaysian'],
  Uganda: ['uganda', 'ugandan'],
  Spain: ['spain', 'spanish'],
  France: ['france', 'french'],
  Singapore: ['singapore', 'singapore citizen', 'singaporean']
};

export const COUNTRY_LOOKUP = (() => {
  const out = {};
  Object.keys(COUNTRY_ALIASES).forEach((canon) => {
    out[canon.toLowerCase()] = canon;
    COUNTRY_ALIASES[canon].forEach((a) => { out[a] = canon; });
  });
  return out;
})();

/* An unrecognised value is title-cased and kept rather than dropped —
   a market we have not mapped is still a market, and swallowing it
   would quietly shrink the totals. */
export function normaliseCountry(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  const hit = COUNTRY_LOOKUP[s.toLowerCase()];
  if (hit) return hit;
  return s.length <= 3 ? s.toUpperCase() : s[0].toUpperCase() + s.slice(1).toLowerCase();
}

/* Which raw spellings the map does not cover, so it can be kept up to
   date instead of silently rotting as new creators are added. */
export function unmappedCountries(creators) {
  const seen = new Map();
  (creators || []).forEach((cr) => {
    const raw = String((cr && cr.nationality) || '').trim();
    if (!raw) return;
    if (COUNTRY_LOOKUP[raw.toLowerCase()]) return;
    seen.set(raw, (seen.get(raw) || 0) + 1);
  });
  return [...seen.entries()].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n);
}

/* A post counts as measured when someone recorded a view count for it.
   Everything that averages or buckets views works off this, so an
   unmeasured post never drags a mean towards zero. */
export const isMeasured = (c) => Number(c && c.views) > 0;

/* The date the Overview plots against.

   `postedAt` looked like the obvious choice and is not: it carries
   only three distinct values across all 97 posts and matches the
   campaign start date on three of the four campaigns, so it is a
   fallback rather than a record of when anything was published.
   `metricsAt` — the Metrics Updated column the team fills in — has 27
   distinct dates over four weeks. It means "when we measured", which
   is a weaker claim than "when it went up" but a true one. */
export function contentDate(c, mode) {
  if (!c) return '';
  /* Strict per axis, with no falling back to the other one. An earlier
     draft let a post with no metricsAt borrow its postedAt, which put
     posts nobody has ever measured onto an axis labelled "measurement
     date" — a reading that was never taken, drawn as if it had been.
     A post with no date on the chosen axis simply is not on it. */
  const pick = mode === 'posted' ? (c.postedAt || c.publishedAt) : c.metricsAt;
  return String(pick || '').slice(0, 10);
}

/* One row per post with everything the page needs already resolved, so
   the KPI row, the charts and the cards cannot disagree. */
export function overviewRows(db) {
  const d = db || DB;
  const creators = d.creators || [];
  const campaigns = d.campaigns || [];
  const crById = {}; creators.forEach((c) => { crById[c.id] = c; });
  const cpById = {}; campaigns.forEach((c) => { cpById[c.id] = c; });

  return (d.socialContent || []).map((c) => {
    const cr = crById[c.creatorId] || null;
    const cp = cpById[c.campaignId] || null;
    const views = Number(c.views) || 0;
    const eng = (Number(c.likes) || 0) + (Number(c.comments) || 0) +
                (Number(c.shares) || 0) + (Number(c.saves) || 0);
    const followers = Number(cr && cr.followers) || 0;
    return {
      c, cr, cp,
      id: c.id,
      handle: c.username || (cr && cr.handle) || '',
      platform: c.platform || 'Other',
      campaignId: c.campaignId || '',
      campaignName: (cp && (cp.name || cp.brand)) || 'Unassigned',
      market: normaliseCountry(cr && cr.nationality),
      views,
      measured: isMeasured(c),
      engagements: eng,
      /* rate over views, and only where views exist — dividing by zero
         produced Infinity in an earlier draft and painted a full bar */
      rate: views > 0 ? (eng / views) * 100 : null,
      followers,
      viewsPerFollower: followers > 0 && views > 0 ? views / followers : null
    };
  });
}

export function overviewFilter(rows, f) {
  const q = f || {};
  return rows.filter((r) => {
    if (q.campaign && r.campaignId !== q.campaign) return false;
    if (q.platform && r.platform !== q.platform) return false;
    if (q.market && r.market !== q.market) return false;
    if (q.from || q.to) {
      const d = contentDate(r.c, q.dateMode);
      if (!d) return false;
      if (q.from && d < q.from) return false;
      if (q.to && d > q.to) return false;
    }
    return true;
  });
}

/* The KPI row. avgViews divides by measured posts, not by all of them:
   550,118 over 43 measured is 12,793, over all 97 it is 5,671, and the
   second number describes our data entry rather than our content. The
   coverage is returned alongside so the card can show it rather than
   burying it in the denominator. */
export function overviewKpis(rows) {
  const measured = rows.filter((r) => r.measured);
  const views = rows.reduce((a, r) => a + r.views, 0);
  const engagements = rows.reduce((a, r) => a + r.engagements, 0);
  const measuredViews = measured.reduce((a, r) => a + r.views, 0);
  return {
    content: rows.length,
    views,
    engagements,
    rate: measuredViews > 0 ? (engagements / measuredViews) * 100 : null,
    avgViews: measured.length ? measuredViews / measured.length : null,
    creators: new Set(rows.map((r) => r.c.creatorId).filter(Boolean)).size,
    measuredCount: measured.length,
    coverage: rows.length ? measured.length / rows.length : 0
  };
}

export const OVERVIEW_METRICS = {
  views:   { label: 'Views',       of: (g) => g.views },
  eng:     { label: 'Engagement',  of: (g) => g.engagements },
  rate:    { label: 'Eng. rate',   of: (g) => (g.measuredViews > 0 ? (g.engagements / g.measuredViews) * 100 : 0) },
  content: { label: 'Content',     of: (g) => g.content },
  creators:{ label: 'Creators',    of: (g) => g.creators }
};

/* Group rows by any key and roll up every metric once, so switching the
   metric selector never re-reads the source rows. */
export function groupRollup(rows, keyOf, labelOf) {
  const map = new Map();
  rows.forEach((r) => {
    const key = keyOf(r);
    if (key == null || key === '') return;
    if (!map.has(key)) {
      map.set(key, { key, label: labelOf ? labelOf(r) : key, content: 0, views: 0,
        engagements: 0, measured: 0, measuredViews: 0, creatorIds: new Set() });
    }
    const g = map.get(key);
    g.content += 1;
    g.views += r.views;
    g.engagements += r.engagements;
    if (r.measured) { g.measured += 1; g.measuredViews += r.views; }
    if (r.c.creatorId) g.creatorIds.add(r.c.creatorId);
  });
  return [...map.values()].map((g) => Object.assign(g, { creators: g.creatorIds.size }));
}

export const byCampaignRollup = (rows) => groupRollup(rows, (r) => r.campaignId, (r) => r.campaignName);
export const byMarketRollup   = (rows) => groupRollup(rows, (r) => r.market, (r) => r.market);
export const byPlatformRollup = (rows) => groupRollup(rows, (r) => r.platform, (r) => r.platform);

/* The time axis. Every date present is a point; there is no
   interpolation, because a straight line between two measurements
   would invent readings that were never taken. */
export function overviewSeries(rows, mode) {
  const map = new Map();
  rows.forEach((r) => {
    const d = contentDate(r.c, mode);
    if (!d) return;
    if (!map.has(d)) map.set(d, { date: d, views: 0, engagements: 0, content: 0 });
    const g = map.get(d);
    g.views += r.views;
    g.engagements += r.engagements;
    g.content += 1;
  });
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/* The buckets asked for, plus the one that has to exist: posts nobody
   has measured. Keeping them out of "under 1K" is the entire point of
   showing a distribution rather than an average. */
export const VIEW_BUCKETS = [
  { id: 'lt1k',   label: '<1K',      min: 1,      max: 1000 },
  { id: '1k5k',   label: '1–5K',     min: 1000,   max: 5000 },
  { id: '5k10k',  label: '5–10K',    min: 5000,   max: 10000 },
  { id: '10k50k', label: '10–50K',   min: 10000,  max: 50000 },
  { id: '50k100k',label: '50–100K',  min: 50000,  max: 100000 },
  { id: 'gt100k', label: '100K+',    min: 100000, max: Infinity }
];

export function viewDistribution(rows) {
  const buckets = VIEW_BUCKETS.map((b) => Object.assign({}, b, { n: 0, views: 0 }));
  let unmeasured = 0;
  rows.forEach((r) => {
    if (!r.measured) { unmeasured += 1; return; }
    const hit = buckets.find((b) => r.views >= b.min && r.views < b.max);
    if (hit) { hit.n += 1; hit.views += r.views; }
  });
  return { buckets, unmeasured, measured: rows.length - unmeasured };
}

/* Likes, comments and shares are real. Saves is zero on every record
   because the Notion form has no Saves column — that is missing, not
   nothing, and the card says so rather than drawing an empty bar and
   letting someone read it as "nobody saves our content". */
export function engagementSplit(rows) {
  const sum = (k) => rows.reduce((a, r) => a + (Number(r.c[k]) || 0), 0);
  const parts = [
    { id: 'likes',    label: 'Likes',    value: sum('likes') },
    { id: 'comments', label: 'Comments', value: sum('comments') },
    { id: 'shares',   label: 'Shares',   value: sum('shares') },
    { id: 'saves',    label: 'Saves',    value: sum('saves') }
  ];
  const total = parts.reduce((a, p) => a + p.value, 0);
  return {
    parts: parts.map((p) => Object.assign(p, {
      share: total > 0 ? p.value / total : 0,
      /* a metric nobody has ever recorded is unavailable, not zero */
      unavailable: p.value === 0 && rows.length > 0
    })),
    total
  };
}

export function topContent(rows, n) {
  return rows.filter((r) => r.measured)
    .sort((a, b) => b.views - a.views)
    .slice(0, n || 6);
}

/* What the page cannot see yet, gathered in one place instead of an
   amber footnote on every card. */
export function overviewCoverage(rows, db) {
  const d = db || DB;
  const creators = d.creators || [];
  const campaignsWithContent = new Set(rows.map((r) => r.campaignId).filter(Boolean));
  const measuredCampaigns = new Set(rows.filter((r) => r.measured).map((r) => r.campaignId).filter(Boolean));
  return [
    { label: 'Posts with view counts', have: rows.filter((r) => r.measured).length, of: rows.length },
    { label: 'Campaigns measured', have: measuredCampaigns.size, of: campaignsWithContent.size },
    { label: 'Creators with followers', have: creators.filter((c) => Number(c.followers) > 0).length, of: creators.length },
    { label: 'Daily view history', have: rows.filter((r) => (r.c.curve || []).length).length, of: rows.length,
      note: 'needs the collector' },
    { label: 'Thumbnails', have: rows.filter((r) => r.c.thumbnailUrl).length, of: rows.length,
      note: 'needs creator authorisation' }
  ];
}
