import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../src/model/socialStats.js';

/* A miniature of the real workspace: two measured campaigns, two with
   content and no numbers at all, one TikTok post, Japan spelled three
   ways, and a creator with no follower count. Every shape the live data
   actually contains, small enough to reason about. */
const db = {
  creators: [
    { id: 'cr1', handle: '@a', nationality: 'India',    followers: 5000 },
    { id: 'cr2', handle: '@b', nationality: 'Indian',   followers: 1000 },
    { id: 'cr3', handle: '@c', nationality: '日本',      followers: 2000 },
    { id: 'cr4', handle: '@d', nationality: 'JAPAN',    followers: 0 },
    { id: 'cr5', handle: '@e', nationality: '🇯🇵',        followers: 4000 },
    { id: 'cr6', handle: '@f', nationality: 'Freedonia', followers: 0 }
  ],
  campaigns: [
    { id: 'cpA', name: 'KOWORK' },
    { id: 'cpB', name: 'NAAP' },
    { id: 'cpC', name: 'Quiet' }
  ],
  socialContent: [
    { id: 's1', campaignId: 'cpA', creatorId: 'cr1', username: '@a', platform: 'Instagram',
      views: 50000, likes: 1000, comments: 100, shares: 50, saves: 0,
      metricsAt: '2026-08-10', postedAt: '2026-08-01', thumbTint: '#e5514a', format: 'Reel' },
    { id: 's2', campaignId: 'cpA', creatorId: 'cr2', username: '@b', platform: 'Instagram',
      views: 3000, likes: 200, comments: 20, shares: 5, saves: 0,
      metricsAt: '2026-08-12', postedAt: '2026-08-01' },
    { id: 's3', campaignId: 'cpB', creatorId: 'cr3', username: '@c', platform: 'TikTok',
      views: 900, likes: 50, comments: 5, shares: 1, saves: 0,
      metricsAt: '2026-08-20', postedAt: '2026-08-15' },
    /* no metrics recorded — the case that must never be averaged in */
    { id: 's4', campaignId: 'cpC', creatorId: 'cr4', username: '@d', platform: 'Instagram',
      views: 0, likes: 0, comments: 0, shares: 0, saves: 0,
      metricsAt: '', postedAt: '2026-08-15' },
    { id: 's5', campaignId: 'cpC', creatorId: 'cr5', username: '@e', platform: 'Instagram',
      views: 0, likes: 0, comments: 0, shares: 0, saves: 0,
      metricsAt: '', postedAt: '2026-08-15' },
    { id: 's6', campaignId: 'cpB', creatorId: 'cr6', username: '@f', platform: 'YouTube',
      views: 120000, likes: 900, comments: 40, shares: 10, saves: 0,
      metricsAt: '2026-08-20', postedAt: '2026-08-15' }
  ]
};

const rows = S.overviewRows(db);

/* ---- country normalisation -------------------------------------------- */

test('one country spelled six ways is one market', () => {
  for (const spelling of ['Japan', 'JAPAN', 'japan', '日本', '일본', '🇯🇵'])
    assert.equal(S.normaliseCountry(spelling), 'Japan', spelling);
});

test('a demonym resolves to its country', () => {
  assert.equal(S.normaliseCountry('Indian'), 'India');
  assert.equal(S.normaliseCountry('Moroccan'), 'Morocco');
  assert.equal(S.normaliseCountry('Persian'), 'Iran');
  assert.equal(S.normaliseCountry('Ukrainian'), 'Ukraine');
});

test('a known typo still lands on the right country', () => {
  assert.equal(S.normaliseCountry('Repbulic of Korea'), 'Korea');
});

test('an unmapped value is kept, not dropped', () => {
  /* dropping it would quietly shrink the totals — the market chart
     would stop adding up to the KPI row and nobody would know why */
  assert.equal(S.normaliseCountry('Freedonia'), 'Freedonia');
  assert.equal(S.normaliseCountry('  wakanda  '), 'Wakanda');
  assert.equal(S.normaliseCountry('UAE'), 'UAE', 'a short code keeps its case');
});

test('an empty nationality is empty, not a country called blank', () => {
  for (const v of ['', '   ', null, undefined]) assert.equal(S.normaliseCountry(v), '');
});

test('spellings outside the map are reported so it can be maintained', () => {
  const out = S.unmappedCountries(db.creators);
  assert.deepEqual(out.map((u) => u.value), ['Freedonia']);
  assert.equal(out[0].n, 1);
});

/* ---- rows -------------------------------------------------------------- */

test('a row carries the creator, campaign and market resolved', () => {
  const r = rows.find((x) => x.id === 's1');
  assert.equal(r.campaignName, 'KOWORK');
  assert.equal(r.market, 'India');
  assert.equal(r.engagements, 1150);
  assert.equal(r.viewsPerFollower, 10);
});

test('a post with no views has no rate, rather than a rate of zero', () => {
  /* zero would sort alongside genuinely terrible content and paint an
     empty bar that reads as "measured, and bad" */
  const r = rows.find((x) => x.id === 's4');
  assert.equal(r.measured, false);
  assert.equal(r.rate, null);
  assert.equal(r.viewsPerFollower, null);
});

test('a creator with no follower count gets no ratio, not Infinity', () => {
  const r = rows.find((x) => x.id === 's6');
  assert.equal(r.viewsPerFollower, null);
});

/* ---- KPIs -------------------------------------------------------------- */

test('averages divide by measured posts, and say how many that was', () => {
  const k = S.overviewKpis(rows);
  assert.equal(k.content, 6);
  assert.equal(k.measuredCount, 4);
  assert.equal(k.views, 173900);
  /* 173900 / 4 measured, not / 6 — the two differ by more than half */
  assert.equal(k.avgViews, 43475);
  assert.equal(k.coverage, 4 / 6);
});

test('engagement rate is over measured views only', () => {
  const k = S.overviewKpis(rows);
  const eng = 1150 + 225 + 56 + 950;
  assert.equal(k.engagements, eng);
  assert.ok(Math.abs(k.rate - (eng / 173900) * 100) < 1e-9);
});

test('with nothing measured the averages are null, not zero or NaN', () => {
  const k = S.overviewKpis(rows.filter((r) => !r.measured));
  assert.equal(k.avgViews, null);
  assert.equal(k.rate, null);
  assert.equal(k.coverage, 0);
});

test('an empty selection does not divide by zero', () => {
  const k = S.overviewKpis([]);
  assert.equal(k.content, 0);
  assert.equal(k.avgViews, null);
  assert.equal(k.creators, 0);
});

test('creators activated counts people, not posts', () => {
  const dup = rows.concat(rows);
  assert.equal(S.overviewKpis(dup).creators, 6);
});

/* ---- filters ----------------------------------------------------------- */

test('each filter narrows the set it says it does', () => {
  assert.equal(S.overviewFilter(rows, { campaign: 'cpA' }).length, 2);
  assert.equal(S.overviewFilter(rows, { platform: 'TikTok' }).length, 1);
  assert.equal(S.overviewFilter(rows, { market: 'Japan' }).length, 3);
  assert.equal(S.overviewFilter(rows, {}).length, 6);
});

test('filters combine rather than replace one another', () => {
  assert.equal(S.overviewFilter(rows, { market: 'Japan', platform: 'Instagram' }).length, 2);
  assert.equal(S.overviewFilter(rows, { campaign: 'cpA', platform: 'TikTok' }).length, 0);
});

test('a date range uses the axis the page is showing', () => {
  /* by measurement date s3 is in August 20; by publish date it is the
     15th, so the same range must select differently */
  const late = { from: '2026-08-18', to: '2026-08-31' };
  assert.equal(S.overviewFilter(rows, Object.assign({ dateMode: 'metrics' }, late)).length, 2);
  assert.equal(S.overviewFilter(rows, Object.assign({ dateMode: 'posted' }, late)).length, 0);
});

test('a post with no date on the chosen axis is not on that axis', () => {
  /* s4 was never measured, so it has no measurement date. Borrowing its
     publish date would draw a reading that was never taken. */
  const out = S.overviewFilter(rows, { from: '2026-01-01', to: '2026-12-31', dateMode: 'metrics' });
  assert.ok(!out.some((r) => r.id === 's4'), 's4 has no metricsAt');
  assert.equal(out.length, 4, 'only the measured posts have a measurement date');
  /* it is on the publish axis, where it does have one */
  const posted = S.overviewFilter(rows, { from: '2026-01-01', to: '2026-12-31', dateMode: 'posted' });
  assert.equal(posted.length, 6);
});

/* ---- rollups ----------------------------------------------------------- */

test('campaigns roll up views, posts and creators', () => {
  const g = S.byCampaignRollup(rows);
  const a = g.find((x) => x.key === 'cpA');
  assert.equal(a.label, 'KOWORK');
  assert.equal(a.content, 2);
  assert.equal(a.views, 53000);
  assert.equal(a.creators, 2);
  const c = g.find((x) => x.key === 'cpC');
  assert.equal(c.measured, 0, 'a campaign with no numbers is present with zero measured');
  assert.equal(c.content, 2, 'and still reports its post count');
});

test('markets group the six Japanese spellings into one row', () => {
  const g = S.byMarketRollup(rows);
  const jp = g.find((x) => x.key === 'Japan');
  assert.equal(jp.content, 3);
  assert.equal(jp.views, 900);
  assert.equal(g.find((x) => x.key === 'India').content, 2);
});

test('a rate rollup over unmeasured content is zero, not NaN', () => {
  const g = S.byCampaignRollup(rows).find((x) => x.key === 'cpC');
  assert.equal(S.OVERVIEW_METRICS.rate.of(g), 0);
});

/* ---- time series ------------------------------------------------------- */

test('the series has one point per date, in order, with no gap filling', () => {
  const s = S.overviewSeries(rows, 'metrics');
  assert.deepEqual(s.map((p) => p.date), ['2026-08-10', '2026-08-12', '2026-08-20']);
  assert.equal(s[2].views, 120900, 'two posts share the 20th and are summed');
  assert.equal(s[2].content, 2);
});

test('switching the axis changes the points, which is the whole reason for the switch', () => {
  const byPosted = S.overviewSeries(rows, 'posted');
  assert.deepEqual(byPosted.map((p) => p.date), ['2026-08-01', '2026-08-15']);
  assert.notEqual(byPosted.length, S.overviewSeries(rows, 'metrics').length);
});

/* ---- distribution ------------------------------------------------------ */

test('unmeasured posts are held out of the buckets', () => {
  /* folding them into "<1K" is the exact distortion the chart exists
     to prevent — it would show two posts that were never measured as
     two posts that flopped */
  const d = S.viewDistribution(rows);
  assert.equal(d.unmeasured, 2);
  assert.equal(d.measured, 4);
  const n = Object.fromEntries(d.buckets.map((b) => [b.id, b.n]));
  assert.equal(n.lt1k, 1);
  assert.equal(n['1k5k'], 1);
  assert.equal(n['10k50k'], 0);
  assert.equal(n['50k100k'], 1);
  assert.equal(n.gt100k, 1);
  assert.equal(d.buckets.reduce((a, b) => a + b.n, 0), 4, 'every measured post lands in exactly one bucket');
});

test('a boundary value falls in the higher bucket, once', () => {
  const at = (v) => S.viewDistribution(S.overviewRows({
    creators: [], campaigns: [], socialContent: [{ id: 'x', views: v, likes: 0, comments: 0, shares: 0, saves: 0 }]
  }));
  assert.equal(at(1000).buckets.find((b) => b.id === '1k5k').n, 1);
  assert.equal(at(1000).buckets.find((b) => b.id === 'lt1k').n, 0);
  assert.equal(at(100000).buckets.find((b) => b.id === 'gt100k').n, 1);
});

/* ---- engagement -------------------------------------------------------- */

test('saves is reported as unavailable rather than as zero', () => {
  const e = S.engagementSplit(rows);
  const saves = e.parts.find((p) => p.id === 'saves');
  assert.equal(saves.value, 0);
  assert.equal(saves.unavailable, true, 'the Notion form has no Saves column');
  const likes = e.parts.find((p) => p.id === 'likes');
  assert.equal(likes.unavailable, false);
  assert.ok(Math.abs(likes.share - 2150 / e.total) < 1e-9);
});

test('with no rows at all nothing is called unavailable', () => {
  /* "unavailable" is a claim about our collection, and an empty
     selection is not evidence of one */
  const e = S.engagementSplit([]);
  assert.ok(e.parts.every((p) => !p.unavailable));
  assert.equal(e.total, 0);
});

/* ---- top content ------------------------------------------------------- */

test('top content ranks by views and excludes the unmeasured', () => {
  const top = S.topContent(rows, 6);
  assert.deepEqual(top.map((r) => r.id), ['s6', 's1', 's2', 's3']);
  assert.ok(!top.some((r) => !r.measured));
});

/* ---- coverage ---------------------------------------------------------- */

test('coverage counts what is missing, including the two known gaps', () => {
  const c = S.overviewCoverage(rows, db);
  const by = Object.fromEntries(c.map((x) => [x.label, x]));
  assert.equal(by['Posts with view counts'].have, 4);
  assert.equal(by['Posts with view counts'].of, 6);
  assert.equal(by['Daily view history'].have, 0);
  assert.equal(by['Thumbnails'].have, 0);
  assert.equal(by['Creators with followers'].have, 4, 'two creators have none');
});

/* ---- the page must not disturb the library ----------------------------- */

test('nothing here mutates the workspace it was given', () => {
  const before = JSON.stringify(db);
  S.overviewRows(db);
  S.overviewKpis(rows);
  S.viewDistribution(rows);
  S.engagementSplit(rows);
  S.byCampaignRollup(rows);
  S.overviewCoverage(rows, db);
  assert.equal(JSON.stringify(db), before, 'the Overview is a reader, not a writer');
});
