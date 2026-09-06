/* The homepage exists because the old one showed three numbers that
   were not measurements. These tests are mostly about the difference
   between "zero" and "we never collected this", because that is the
   distinction the whole page turns on. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  homeKpis, campaignPipeline, creatorPipeline, campaignPerformance, campaignRegister, creatorFlow,
  completionSplit, attentionCounts, activityFeed, trendWindow
} from '../src/model/homeStats.js';
import { overviewRows, overviewSeries } from '../src/model/socialStats.js';
import { CAMPAIGN_STATUS } from '../src/model/vocab.js';

const TODAY = new Date('2026-09-06T00:00:00Z');

const cp = (o) => Object.assign({
  id: 'cp1', name: 'KOWORK', brand: 'KOWORK', status: 'live',
  start: '2026-08-01', end: '2026-09-30', targetCreators: 10,
  productCostPer: 0, adSpend: 0
}, o);
const pt = (o) => Object.assign({ id: 'p1', campaignId: 'cp1', creatorId: 'cr1', stage: 'confirmed', fee: 0 }, o);
const cr = (o) => Object.assign({ id: 'cr1', handle: 'someone', followers: 1000, nationality: 'Japan' }, o);
const sc = (o) => Object.assign({
  id: 'sc1', participantId: 'p1', campaignId: 'cp1', creatorId: 'cr1',
  platform: 'Instagram', format: 'Reel', url: 'https://instagram.com/reel/A/', postUrl: 'https://instagram.com/reel/A/',
  views: 0, likes: 0, comments: 0, shares: 0, saves: 0, reach: 0,
  postedAt: '2026-08-01', metricsAt: '', matchStatus: 'confirmed', curve: [], thumbnailUrl: ''
}, o);
const mk = (o) => Object.assign({ campaigns: [], creators: [], participants: [], socialContent: [] }, o);

/* ---- KPIs ---------------------------------------------------------- */

test('a creator on two campaigns is one creator, not two', () => {
  const db = mk({
    campaigns: [cp(), cp({ id: 'cp2' })],
    creators: [cr()],
    participants: [pt({ id: 'p1', campaignId: 'cp1' }), pt({ id: 'p2', campaignId: 'cp2' })]
  });
  const k = homeKpis(db, overviewRows(db));
  assert.equal(k.creatorsInCampaigns, 1);
  assert.equal(k.creatorsContacted, 1);
});

test('a wrapped campaign is not an active one, but its creators still count as contacted', () => {
  const db = mk({
    campaigns: [cp({ status: 'wrapped' })],
    creators: [cr()],
    participants: [pt()]
  });
  const k = homeKpis(db, overviewRows(db));
  assert.equal(k.activeCampaigns, 0);
  assert.equal(k.creatorsInCampaigns, 0, 'nobody is in an active campaign');
  assert.equal(k.creatorsContacted, 1, 'but they were still contacted');
});

test('a creator who dropped out after being contacted still counts as contacted', () => {
  const db = mk({ campaigns: [cp()], creators: [cr()],
    participants: [pt({ stage: 'dropped', contactedAt: '2026-08-01' })] });
  assert.equal(homeKpis(db, overviewRows(db)).creatorsContacted, 1);
});

test('views come from the content rows, so the homepage and Social Overview agree', () => {
  const db = mk({
    campaigns: [cp()], creators: [cr()],
    participants: [pt({ stage: 'shipped' })],
    socialContent: [sc({ views: 85031 })]
  });
  const k = homeKpis(db, overviewRows(db));
  /* the participant is at 'shipped', not 'live' — campaignStats() would
     drop this post entirely and report 0 views */
  assert.equal(k.views, 85031);
  assert.equal(k.content, 1);
});

test('an empty workspace produces zeros, not NaN or undefined', () => {
  const k = homeKpis(mk({}), []);
  assert.equal(k.views, 0);
  assert.equal(k.content, 0);
  assert.equal(k.avgViews, null, 'no average exists when nothing is measured');
  assert.equal(k.coverage, 0);
});

/* ---- campaign pipeline --------------------------------------------- */

test('the campaign columns sum to the number of campaigns', () => {
  const db = mk({ campaigns: [
    cp({ id: 'a', status: 'planning' }), cp({ id: 'b', status: 'outreach' }),
    cp({ id: 'c', status: 'production' }), cp({ id: 'd', status: 'live' }),
    cp({ id: 'e', status: 'wrapped' })
  ] });
  const p = campaignPipeline(db);
  assert.equal(p.rows.reduce((a, r) => a + r.value, 0) + p.unknown, p.total);
  assert.equal(p.unknown, 0);
});

test('the pipeline uses the schema\'s real status names', () => {
  const labels = campaignPipeline(mk({})).rows.map((r) => r.label);
  assert.deepEqual(labels, Object.values(CAMPAIGN_STATUS).map((s) => s.label));
  assert.ok(labels.includes('Outreach'), 'not "Recruiting" — that status does not exist');
  assert.ok(labels.includes('Wrapped'), 'not "Reporting" — that status does not exist');
  assert.ok(labels.includes('Production'), 'campaigns sit here, so it cannot be omitted');
});

test('a status nobody recognises is counted as unknown rather than dropped', () => {
  const p = campaignPipeline(mk({ campaigns: [cp({ status: 'something-else' })] }));
  assert.equal(p.unknown, 1);
  assert.equal(p.total, 1);
});

/* ---- creator pipeline ---------------------------------------------- */

test('the funnel never increases as it goes down', () => {
  const db = mk({ campaigns: [cp()], creators: [cr()], participants: [
    pt({ id: 'a', stage: 'sourced' }), pt({ id: 'b', stage: 'contacted' }),
    pt({ id: 'c', stage: 'confirmed' }), pt({ id: 'd', stage: 'live' })
  ] });
  const f = creatorPipeline(db, ['cp1']);
  f.counts.forEach((c, i) => { if (i) assert.ok(c.n <= f.counts[i - 1].n, c.stage.id); });
  assert.equal(f.counts[0].n, 4, 'everyone is at least sourced');
});

test('dropped creators are counted apart, not folded into the funnel', () => {
  const db = mk({ campaigns: [cp()], participants: [
    pt({ id: 'a', stage: 'live' }), pt({ id: 'b', stage: 'dropped' })
  ] });
  const f = creatorPipeline(db, ['cp1']);
  assert.equal(f.dropped, 1);
  assert.equal(f.total, 2);
  assert.equal(f.counts[0].n, 1);
});

/* ---- campaign performance ------------------------------------------ */

test('a campaign with posts and no readings is flagged, not scored zero', () => {
  const db = mk({
    campaigns: [cp({ id: 'quiet' })], creators: [cr()],
    participants: [pt({ campaignId: 'quiet' })],
    socialContent: [sc({ campaignId: 'quiet', views: 0 })]
  });
  const r = campaignPerformance(db, overviewRows(db), 'views')[0];
  assert.equal(r.value, 0);
  assert.equal(r.unmeasured, true, 'the view must be able to draw this differently');
  assert.equal(r.content, 1);
});

test('completion is not 100% when no target was ever set', () => {
  const db = mk({ campaigns: [cp({ targetCreators: 0 })], participants: [pt()] });
  const r = campaignPerformance(db, [], 'completion')[0];
  assert.equal(r.value, 0);
  assert.equal(r.noTarget, true);
});

test('completion is capped at 100% when the target is beaten', () => {
  const db = mk({ campaigns: [cp({ targetCreators: 1 })],
    participants: [pt({ id: 'a' }), pt({ id: 'b' }), pt({ id: 'c' })] });
  assert.equal(campaignPerformance(db, [], 'completion')[0].value, 100);
});

test('Creators counts the confirmed roster, not just creators with content', () => {
  const db = mk({ campaigns: [cp()], creators: [cr()],
    participants: [pt({ id: 'a' }), pt({ id: 'b', creatorId: 'cr2' })] });
  assert.equal(campaignPerformance(db, [], 'creators')[0].value, 2);
});

/* ---- completion ----------------------------------------------------- */

test('every campaign lands in exactly one completion bucket', () => {
  const db = mk({ campaigns: [
    cp({ id: 'a', status: 'wrapped' }),
    cp({ id: 'b', end: '2026-08-01' }),
    cp({ id: 'c', end: '2026-12-01' }),
    cp({ id: 'd', end: '' })
  ] });
  const s = completionSplit(db, TODAY);
  const all = s.complete.concat(s.pending, s.overdue);
  assert.equal(all.length, 4);
  assert.equal(new Set(all).size, 4, 'no campaign is counted twice');
  assert.deepEqual(s.overdue, ['b']);
  assert.deepEqual(s.noEnd, ['d']);
  assert.ok(s.pending.includes('d'), 'a campaign with no end date is pending, never overdue');
});

test('hitting the target completes a campaign even before it is wrapped', () => {
  const db = mk({ campaigns: [cp({ targetCreators: 1, end: '2026-08-01' })],
    participants: [pt({ stage: 'live' })] });
  const s = completionSplit(db, TODAY);
  assert.deepEqual(s.complete, ['cp1']);
  assert.deepEqual(s.overdue, [], 'a finished campaign is not overdue');
});

/* ---- needs attention ------------------------------------------------ */

test('an empty workspace has nothing to attend to', () => {
  const a = attentionCounts(mk({}), [], TODAY);
  assert.equal(a.urgent, 0);
  a.items.forEach((i) => assert.equal(i.n, 0, i.key));
});

test('overdue is keyed to the campaign end date, not a backfilled stage date', () => {
  const db = mk({
    campaigns: [cp({ end: '2026-08-01' })],
    /* contactedAt is campaign.start for everybody, so it must not be
       what decides this */
    participants: [pt({ stage: 'shipped', contactedAt: '2026-08-01', shippedAt: '2026-08-01' })]
  });
  assert.equal(attentionCounts(db, [], TODAY).items.find((i) => i.key === 'overdue').n, 1);
  const notYet = mk({ campaigns: [cp({ end: '2026-12-01' })], participants: [pt({ stage: 'shipped' })] });
  assert.equal(attentionCounts(notYet, [], TODAY).items.find((i) => i.key === 'overdue').n, 0);
});

test('a creator who already posted is not overdue', () => {
  const db = mk({ campaigns: [cp({ end: '2026-08-01' })], participants: [pt({ stage: 'live' })] });
  assert.equal(attentionCounts(db, [], TODAY).items.find((i) => i.key === 'overdue').n, 0);
});

test('a post past submission with no url is a missing link', () => {
  const db = mk({ campaigns: [cp()], participants: [
    pt({ id: 'a', stage: 'live', content: null }),
    pt({ id: 'b', stage: 'live', content: { url: 'https://x/' } }),
    pt({ id: 'c', stage: 'confirmed', content: null })
  ] });
  assert.equal(attentionCounts(db, [], TODAY).items.find((i) => i.key === 'links').n, 1);
});

test('behind schedule compares elapsed time against confirmed creators', () => {
  /* half the calendar gone, one of ten confirmed */
  const behind = mk({ campaigns: [cp({ start: '2026-08-01', end: '2026-10-01', targetCreators: 10 })],
    participants: [pt()] });
  assert.equal(attentionCounts(behind, [], TODAY).items.find((i) => i.key === 'behind').n, 1);
  const onTrack = mk({ campaigns: [cp({ start: '2026-08-01', end: '2026-10-01', targetCreators: 1 })],
    participants: [pt()] });
  assert.equal(attentionCounts(onTrack, [], TODAY).items.find((i) => i.key === 'behind').n, 0);
});

test('campaigns with no end date are reported rather than silently skipped', () => {
  const db = mk({ campaigns: [cp({ end: '' }), cp({ id: 'b', end: '' })] });
  assert.equal(attentionCounts(db, [], TODAY).noEnd, 2);
});

/* ---- activity feed --------------------------------------------------- */

test('the feed never invents a creator stage change', () => {
  const db = mk({
    campaigns: [cp({ createdAt: '2026-07-01T00:00:00Z' })],
    creators: [cr()],
    /* every one of these is campaign.start, courtesy of the importer */
    participants: [pt({ contactedAt: '2026-08-01', repliedAt: '2026-08-01',
      confirmedAt: '2026-08-01', shippedAt: '2026-08-01' })],
    socialContent: [sc({ metricsAt: '2026-08-30', views: 10 })]
  });
  const feed = activityFeed(db, overviewRows(db), 20);
  assert.ok(feed.length > 0);
  feed.forEach((e) => assert.ok(['measured', 'sync', 'campaign', 'flag'].includes(e.kind),
    'no stage-change rows: ' + e.kind));
});

test('posts measured on the same day for one campaign collapse to one row', () => {
  const db = mk({
    campaigns: [cp()], creators: [cr()],
    socialContent: [
      sc({ id: 's1', metricsAt: '2026-08-30', views: 1 }),
      sc({ id: 's2', metricsAt: '2026-08-30', views: 2 }),
      sc({ id: 's3', metricsAt: '2026-08-29', views: 3 })
    ]
  });
  const feed = activityFeed(db, overviewRows(db), 20).filter((e) => e.kind === 'measured');
  assert.equal(feed.length, 2);
  assert.equal(feed[0].at, '2026-08-30', 'newest first');
  assert.match(feed[0].text, /2 posts measured/);
});

test('undated records never reach the feed', () => {
  const db = mk({ campaigns: [cp({ createdAt: '' })], creators: [cr()], socialContent: [sc({ metricsAt: '' })] });
  assert.deepEqual(activityFeed(db, overviewRows(db), 20), []);
});

/* ---- the trend window ------------------------------------------------
   The point of this whole page: an empty window says it is empty.
   -------------------------------------------------------------------- */

const series = (dates) => dates.map((d, i) => ({ date: d, views: (i + 1) * 10, content: 1, engagements: 0 }));

test('an empty window returns no points at all — never an array of zeros', () => {
  const w = trendWindow(series(['2026-08-02', '2026-08-30']), 7, TODAY);
  assert.equal(w.state, 'empty');
  assert.deepEqual(w.points, [], 'nothing to plot, and nothing invented to plot');
  assert.equal(w.latest, '2026-08-30');
  assert.equal(w.daysAgo, 7);
});

test('one reading in the window is a point, not a line', () => {
  const w = trendWindow(series(['2026-08-30', '2026-09-05']), 7, TODAY);
  assert.equal(w.state, 'single');
  assert.equal(w.points.length, 1);
});

test('two or more readings make a line', () => {
  const w = trendWindow(series(['2026-09-01', '2026-09-04', '2026-09-05']), 30, TODAY);
  assert.equal(w.state, 'ok');
  assert.equal(w.points.length, 3);
});

test('the window is inclusive of both ends and excludes what falls outside', () => {
  const w = trendWindow(series(['2026-08-07', '2026-08-08', '2026-09-06']), 30, TODAY);
  assert.equal(w.from, '2026-08-08');
  assert.equal(w.to, '2026-09-06');
  assert.deepEqual(w.points.map((p) => p.date), ['2026-08-08', '2026-09-06']);
});

test('a workspace with no measurements at all does not pretend otherwise', () => {
  const w = trendWindow([], 30, TODAY);
  assert.equal(w.state, 'empty');
  assert.equal(w.latest, '');
  assert.equal(w.daysAgo, null);
  assert.equal(w.total, 0);
});

test('the series feeding the trend is built from measurement dates, not publish dates', () => {
  const db = mk({
    campaigns: [cp()], creators: [cr()],
    socialContent: [
      sc({ id: 's1', postedAt: '2026-08-01', metricsAt: '2026-08-20', views: 5 }),
      sc({ id: 's2', postedAt: '2026-08-01', metricsAt: '2026-08-25', views: 7 })
    ]
  });
  const s = overviewSeries(overviewRows(db), 'metrics');
  assert.deepEqual(s.map((p) => p.date), ['2026-08-20', '2026-08-25'],
    'two points, because postedAt would have collapsed them into one');
});

test('a post nobody measured is absent from the axis rather than plotted at zero', () => {
  const db = mk({ campaigns: [cp()], creators: [cr()],
    socialContent: [sc({ metricsAt: '', views: 0 }), sc({ id: 's2', metricsAt: '2026-08-20', views: 5 })] });
  const s = overviewSeries(overviewRows(db), 'metrics');
  assert.equal(s.length, 1);
});

/* ---- the campaign register -------------------------------------------
   Composes rules that already exist; these pin that it composes them
   the same way the other cards do.
   -------------------------------------------------------------------- */

test('the register carries one row per campaign, richest first', () => {
  const db = mk({
    campaigns: [cp({ id: 'a', name: 'A' }), cp({ id: 'b', name: 'B' })],
    creators: [cr()],
    participants: [pt({ campaignId: 'a' })],
    socialContent: [sc({ campaignId: 'a', views: 500 })]
  });
  const reg = campaignRegister(db, overviewRows(db), TODAY);
  assert.equal(reg.length, 2);
  assert.equal(reg[0].id, 'a', 'the campaign with views sorts first');
  assert.equal(reg[0].views, 500);
  assert.equal(reg[0].posts, 1);
});

test('a campaign with posts and no readings is unmeasured, not zero-scoring', () => {
  const db = mk({ campaigns: [cp()], creators: [cr()],
    participants: [pt()], socialContent: [sc({ views: 0 })] });
  const r = campaignRegister(db, overviewRows(db), TODAY)[0];
  assert.equal(r.views, 0);
  assert.equal(r.unmeasured, true);
  assert.equal(r.posts, 1);
});

test('health is at risk only when the calendar has run ahead of delivery', () => {
  const behind = mk({ campaigns: [cp({ start: '2026-08-01', end: '2026-10-01', targetCreators: 10 })],
    participants: [pt()] });
  assert.equal(campaignRegister(behind, [], TODAY)[0].health, 'risk');

  const ahead = mk({ campaigns: [cp({ start: '2026-08-01', end: '2026-10-01', targetCreators: 1 })],
    participants: [pt()] });
  assert.equal(campaignRegister(ahead, [], TODAY)[0].health, 'ontrack');

  const future = mk({ campaigns: [cp({ start: '2026-09-06', end: '2026-09-20', targetCreators: 10 })],
    participants: [] });
  assert.equal(campaignRegister(future, [], TODAY)[0].health, 'notstarted');

  const wrapped = mk({ campaigns: [cp({ status: 'wrapped', targetCreators: 10 })], participants: [] });
  assert.equal(campaignRegister(wrapped, [], TODAY)[0].health, 'complete');
});

test('a campaign with no usable dates says so rather than being judged', () => {
  const db = mk({ campaigns: [cp({ start: '', end: '', targetCreators: 10 })], participants: [] });
  assert.equal(campaignRegister(db, [], TODAY)[0].health, 'unknown');
});

/* ---- the collapsed creator flow -------------------------------------- */

test('the flow collapses the three pass-through stages into one block', () => {
  const db = mk({ campaigns: [cp()], participants: [
    pt({ id: 'a', stage: 'sourced' }), pt({ id: 'b', stage: 'confirmed' }),
    pt({ id: 'c', stage: 'shipped' }), pt({ id: 'd', stage: 'live' })
  ] });
  const f = creatorFlow(db, ['cp1']);
  assert.equal(f.steps.length, 4, 'four blocks, not nine');
  assert.deepEqual(f.steps.map((s) => s.n), [4, 3, 2, 1]);
  assert.match(f.steps[0].label, /Sourced/);
});

test('the flow never widens, and its losses match the step differences', () => {
  const db = mk({ campaigns: [cp()], participants: [
    pt({ id: 'a', stage: 'sourced' }), pt({ id: 'b', stage: 'sourced' }),
    pt({ id: 'c', stage: 'confirmed' }), pt({ id: 'd', stage: 'live' })
  ] });
  const f = creatorFlow(db, ['cp1']);
  f.steps.forEach((s, i) => { if (i) assert.ok(s.n <= f.steps[i - 1].n, s.id); });
  f.losses.forEach((l, i) => assert.equal(l.lost, f.steps[i].n - f.steps[i + 1].n));
});

test('an empty roster produces a flow of zeros rather than throwing', () => {
  const f = creatorFlow(mk({ campaigns: [cp()] }), ['cp1']);
  assert.deepEqual(f.steps.map((s) => s.n), [0, 0, 0, 0]);
  assert.equal(f.total, 0);
});
