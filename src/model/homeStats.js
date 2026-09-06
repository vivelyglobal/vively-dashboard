import { DAY, TODAY, addDays, iso } from '../lib/dates.js';
import { DB } from './db.js';
import { byCampaignRollup, overviewKpis } from './socialStats.js';
import { CAMPAIGN_STATUS, STAGES, STAGE_IDX } from './vocab.js';

/* ============================================================
   HOME — the numbers

   The homepage this replaces was showing three figures that were
   not measurements:

     · "Views · last 30d" came from dailySeries(), which accumulates
       only from content.curve. curve is empty on every record, so the
       loop never ran and the card read 0 beside 550,118 real views.
     · "Blended CPM" is spend ÷ reach, and reach is 0 on every record,
       so it could only ever print ₩0.0.
     · Anything dated per creator came from contactedAt / repliedAt /
       confirmedAt / shippedAt, which the Notion importer back-fills to
       the campaign's start date. That one is the worst of the three
       because nothing on screen looks wrong.

   So the rule for everything below: a number is either measured or it
   is absent. There is no third state where a zero stands in for "we
   never collected this". Where the data cannot answer the question,
   the function says so — usually by returning null or a flag the view
   turns into a sentence — rather than returning 0 and letting the
   reader assume the worst about a campaign that is doing fine.

   Everything here takes `db` as a parameter rather than reaching for
   the global, so the whole page can be tested against a fixture.
   ============================================================ */

/* Roster rows for one campaign. Local rather than stats.js's partsOf()
   because that one reads the global DB, and the point of this file is
   that it does not. */
export function homeParts(d, campaignId) {
  return (d.participants || []).filter((p) => p.campaignId === campaignId);
}
export const homeLive = (p) => p.stage === 'live';
export const homeActive = (p) => p.stage !== 'dropped';
export const atLeast = (p, stage) => STAGE_IDX[p.stage] >= STAGE_IDX[stage];
export const dateOnly = (v) => String(v || '').slice(0, 10);

/* ---- the five headline numbers ------------------------------------- */

export function homeKpis(db, rows) {
  const d = db || DB;
  const camps = d.campaigns || [];
  const parts = d.participants || [];
  const active = camps.filter((c) => c.status !== 'wrapped');
  const activeIds = new Set(active.map((c) => c.id));
  const distinct = (list) => new Set(list.map((p) => p.creatorId).filter(Boolean)).size;

  /* Distinct creators, not a sum of per-campaign counts. Summing
     campaignStats().contacted counts anybody who is on two rosters
     twice, which is how a 305-creator roster reports 340 contacted. */
  const contacted = parts.filter((p) =>
    (homeActive(p) && atLeast(p, 'contacted')) || (p.stage === 'dropped' && p.contactedAt));

  const k = overviewKpis(rows);
  return {
    activeCampaigns: active.length,
    totalCampaigns: camps.length,
    liveCampaigns: camps.filter((c) => c.status === 'live').length,
    wrappedCampaigns: camps.filter((c) => c.status === 'wrapped').length,
    creatorsInCampaigns: distinct(parts.filter((p) => homeActive(p) && atLeast(p, 'confirmed') && activeIds.has(p.campaignId))),
    confirmedEver: distinct(parts.filter((p) => homeActive(p) && atLeast(p, 'confirmed'))),
    creatorsContacted: distinct(contacted),
    roster: (d.creators || []).length,
    /* content and views come from the same rows the Social Overview
       reads, so the two pages cannot disagree about the total */
    content: k.content,
    measuredCount: k.measuredCount,
    coverage: k.coverage,
    views: k.views,
    avgViews: k.avgViews
  };
}

/* ---- campaign pipeline ---------------------------------------------

   A distribution, not a funnel: a campaign in Planning is not "not yet
   past Live", so there is no drop-off between these and none is drawn.

   The labels are the schema's own. "Recruiting" and "Reporting" do not
   exist here — Outreach and Wrapped are the real values, they are what
   the campaign editor's dropdown offers, and they are what gets written
   back to Notion. Production is in the list because campaigns sit in
   it; leaving it out would make the columns not sum to the total.
   ------------------------------------------------------------------ */

export function campaignPipeline(db) {
  const d = db || DB;
  const order = Object.keys(CAMPAIGN_STATUS);
  const counts = {};
  order.forEach((k) => { counts[k] = 0; });
  let unknown = 0;
  (d.campaigns || []).forEach((c) => {
    const s = String(c.status || '').toLowerCase();
    if (counts[s] === undefined) unknown += 1; else counts[s] += 1;
  });
  return {
    rows: order.map((k) => ({ key: k, label: CAMPAIGN_STATUS[k].label, value: counts[k] })),
    unknown,
    total: (d.campaigns || []).length
  };
}

/* ---- creator pipeline -----------------------------------------------

   Cumulative "at or past this stage", which is what makes the step
   percentages a drop-off rather than a histogram.

   One honest caveat travels with this and the view prints it: the
   Notion form never produces the literal values that map to `contacted`
   and `replied`, so almost nobody rests at those two stages and both
   rows show ~100% conversion. That is arithmetically right and
   operationally meaningless, and saying so is cheaper than letting
   somebody read it as a triumph.
   ------------------------------------------------------------------ */

export function creatorPipeline(db, campaignIds) {
  const d = db || DB;
  const ids = campaignIds || (d.campaigns || []).map((c) => c.id);
  const idSet = new Set(ids);
  const ps = (d.participants || []).filter((p) => idSet.has(p.campaignId));
  const active = ps.filter(homeActive);
  const counts = STAGES.filter((s) => s.id !== 'dropped').map((s) => ({
    stage: s,
    n: active.filter((p) => atLeast(p, s.id)).length
  }));
  return { counts, dropped: ps.length - active.length, total: ps.length };
}

/* ---- campaign performance ------------------------------------------- */

export const HOME_METRICS = {
  views:      { label: 'Views' },
  engagement: { label: 'Engagement' },
  creators:   { label: 'Creators' },
  completion: { label: 'Completion' }
};

export function campaignPerformance(db, rows, metric) {
  const d = db || DB;
  const by = {};
  byCampaignRollup(rows).forEach((g) => { by[g.key] = g; });
  const m = HOME_METRICS[metric] ? metric : 'views';

  return (d.campaigns || []).map((cp) => {
    const g = by[cp.id] || { views: 0, engagements: 0, content: 0, measured: 0 };
    const ps = homeParts(d, cp.id);
    const confirmed = ps.filter((p) => homeActive(p) && atLeast(p, 'confirmed')).length;
    const delivered = ps.filter(homeLive).length;
    const target = Number(cp.targetCreators) || 0;
    /* A campaign with posts and no readings is not a campaign that did
       badly. The flag lets the view draw it differently from a real
       zero instead of putting both at the bottom of the same axis. */
    const unmeasured = g.content > 0 && g.measured === 0;

    let value = 0;
    if (m === 'views') value = g.views;
    else if (m === 'engagement') value = g.engagements;
    else if (m === 'creators') value = confirmed;
    else value = target ? Math.min(1, confirmed / target) * 100 : 0;

    return {
      id: cp.id,
      label: cp.name || cp.brand || cp.id,
      value,
      metric: m,
      content: g.content, measured: g.measured,
      confirmed, delivered, target,
      unmeasured: m === 'views' || m === 'engagement' ? unmeasured : false,
      noTarget: m === 'completion' && !target
    };
  }).filter((r) => r.content > 0 || r.confirmed > 0)
    .sort((a, b) => b.value - a.value);
}

/* ---- completion ------------------------------------------------------

   Every campaign lands in exactly one bucket, tested in this order.
   `wrapped` is the completion flag — there is no completedAt field —
   and a campaign with no end date can never be Overdue, so those are
   counted separately and reported rather than quietly filed as Pending.
   ------------------------------------------------------------------ */

export function completionSplit(db, today) {
  const d = db || DB;
  const cut = iso(today || TODAY);
  const out = { complete: [], pending: [], overdue: [], noEnd: [] };
  (d.campaigns || []).forEach((cp) => {
    const delivered = homeParts(d, cp.id).filter(homeLive).length;
    const target = Number(cp.targetCreators) || 0;
    if (cp.status === 'wrapped' || (target > 0 && delivered >= target)) { out.complete.push(cp.id); return; }
    const end = dateOnly(cp.end);
    if (!end) { out.noEnd.push(cp.id); out.pending.push(cp.id); return; }
    if (end < cut) out.overdue.push(cp.id); else out.pending.push(cp.id);
  });
  return out;
}

/* ---- needs attention -------------------------------------------------

   Six counts, each one a real query. Deliberately NOT built on
   alertsList(), four of whose five rules key off the back-filled stage
   timestamps and would therefore over-report every time.

   "Overdue" here means the campaign's end date has passed while the
   creator is still short of Live. That is a genuine field. A per-creator
   "overdue by N days" needs a stage-change timestamp that does not exist
   yet, and inventing one out of campaign.start is exactly the mistake
   this page is being built to stop making.
   ------------------------------------------------------------------ */

export function attentionCounts(db, rows, today) {
  const d = db || DB;
  const now = today || TODAY;
  const cut = iso(now);
  const soon = iso(addDays(now, 7));
  const camps = d.campaigns || [];
  const byId = {}; camps.forEach((c) => { byId[c.id] = c; });
  const parts = (d.participants || []).filter(homeActive);

  const owing = ['confirmed', 'shipped', 'submitted', 'review'];
  const overdue = parts.filter((p) => {
    if (!owing.includes(p.stage)) return false;
    const end = dateOnly((byId[p.campaignId] || {}).end);
    return !!end && end < cut;
  });

  const missingLink = parts.filter((p) =>
    atLeast(p, 'submitted') && !(p.content && (p.content.url || p.content.postUrl)));

  const endingSoon = camps.filter((c) => {
    if (c.status === 'wrapped') return false;
    const end = dateOnly(c.end);
    return !!end && end >= cut && end <= soon;
  });

  /* schedule against delivery: how far through the campaign's own
     calendar it is, versus how much of its roster is confirmed */
  const behind = camps.filter((c) => {
    if (c.status === 'wrapped') return false;
    const start = dateOnly(c.start), end = dateOnly(c.end);
    const target = Number(c.targetCreators) || 0;
    if (!start || !end || !target || end <= start) return false;
    const span = new Date(end + 'T00:00:00Z') - new Date(start + 'T00:00:00Z');
    const gone = now - new Date(start + 'T00:00:00Z');
    const elapsed = Math.max(0, Math.min(1, gone / span));
    if (elapsed <= 0) return false;
    const confirmed = homeParts(d, c.id).filter((p) => homeActive(p) && atLeast(p, 'confirmed')).length;
    return Math.min(1, confirmed / target) < elapsed;
  });

  const unassigned = rows.filter((r) => !r.campaignId || r.c.matchStatus === 'unassigned');
  const needsReview = parts.filter((p) => p.stage === 'submitted' || p.stage === 'review').length
                    + rows.filter((r) => r.c.matchStatus === 'suggested').length;

  const items = [
    { key: 'overdue',    n: overdue.length,    label: 'creators overdue',           href: '#/overview/attention/critical' },
    { key: 'links',      n: missingLink.length, label: 'missing content links',     href: '#/overview/attention/chasing' },
    { key: 'ending',     n: endingSoon.length,  label: 'campaigns ending in 7 days', href: '#/campaigns/all' },
    { key: 'behind',     n: behind.length,      label: 'campaigns behind schedule',  href: '#/overview/pipeline/status' },
    { key: 'unassigned', n: unassigned.length,  label: 'unassigned social content',  href: '#/social/library' },
    { key: 'review',     n: needsReview,        label: 'submissions needing review', href: '#/social/library' }
  ];
  return {
    items,
    /* the four that are somebody's job today */
    urgent: items.slice(0, 4).reduce((a, x) => a + x.n, 0),
    noEnd: camps.filter((c) => c.status !== 'wrapped' && !dateOnly(c.end)).length
  };
}

/* ---- recent activity -------------------------------------------------

   There is no activity log, and one cannot be honestly derived from the
   participant timestamps: contactedAt, repliedAt, confirmedAt and
   shippedAt are all set to campaign.start by the Notion importer, so a
   feed built from them would report that twenty-six creators were
   contacted, replied, confirmed and shipped on a single afternoon.

   What IS real and dated: when posts were measured, when a campaign was
   synced or created, and when a creator was flagged by hand. So the card
   is built from those and labelled as derived, and the half that cannot
   be recovered is named rather than faked.
   ------------------------------------------------------------------ */

export function activityFeed(db, rows, n) {
  const d = db || DB;
  const out = [];
  const cpName = (id) => {
    const c = (d.campaigns || []).find((x) => x.id === id);
    return (c && (c.name || c.brand)) || '';
  };

  const measured = new Map();
  rows.forEach((r) => {
    const day = dateOnly(r.c.metricsAt);
    if (!day) return;
    const key = day + '|' + r.campaignId;
    if (!measured.has(key)) measured.set(key, { at: day, campaignId: r.campaignId, n: 0 });
    measured.get(key).n += 1;
  });
  measured.forEach((m) => out.push({
    at: m.at, kind: 'measured', campaignId: m.campaignId,
    text: m.n + (m.n === 1 ? ' post measured' : ' posts measured'), who: cpName(m.campaignId)
  }));

  (d.campaigns || []).forEach((c) => {
    if (c.notionSyncedAt) out.push({ at: dateOnly(c.notionSyncedAt), kind: 'sync', campaignId: c.id, text: 'synced from Notion', who: c.name || c.brand || '' });
    if (c.createdAt) out.push({ at: dateOnly(c.createdAt), kind: 'campaign', campaignId: c.id, text: 'campaign created', who: c.name || c.brand || '' });
  });

  (d.creators || []).forEach((cr) => {
    if (cr.flagAt) out.push({ at: dateOnly(cr.flagAt), kind: 'flag', text: 'flagged' + (cr.flagReason ? ' — ' + cr.flagReason : ''), who: cr.handle || cr.name || '' });
  });

  return out.filter((x) => x.at).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, n || 8);
}

/* ---- the trend window ------------------------------------------------

   The whole measurement history is 27 dates in one month. A 7-day
   window ending today is therefore usually empty, and this is the
   function that admits it: it never pads, never zero-fills, and returns
   the state the card should render rather than an array of noughts that
   would draw as a confident flat line.
   ------------------------------------------------------------------ */

export function trendWindow(series, days, today) {
  const now = today || TODAY;
  const from = iso(addDays(now, -(days - 1)));
  const to = iso(now);
  const points = (series || []).filter((p) => p.date >= from && p.date <= to);
  const latest = series && series.length ? series[series.length - 1].date : '';
  return {
    points, from, to, days,
    total: (series || []).length,
    latest,
    daysAgo: latest ? Math.round((now - new Date(latest + 'T00:00:00Z')) / DAY) : null,
    /* 'single' matters: one measurement is a reading, but a line needs
       two, and joining one point to the axis would be a fabrication */
    state: points.length === 0 ? 'empty' : points.length === 1 ? 'single' : 'ok'
  };
}

/* ---- the campaign register -------------------------------------------

   One row per campaign for the scan-the-company view. It composes rules
   that already exist — the confirmed count from campaignPerformance, the
   schedule test from attentionCounts, the completion test from
   completionSplit — rather than inventing a sixth definition of "how is
   this campaign doing". If those rules change, this changes with them.
   ------------------------------------------------------------------ */

export function campaignRegister(db, rows, today) {
  const d = db || DB;
  const now = today || TODAY;
  const by = {};
  byCampaignRollup(rows).forEach((g) => { by[g.key] = g; });

  return (d.campaigns || []).map((cp) => {
    const g = by[cp.id] || { views: 0, engagements: 0, content: 0, measured: 0 };
    const ps = homeParts(d, cp.id);
    const confirmed = ps.filter((p) => homeActive(p) && atLeast(p, 'confirmed')).length;
    const delivered = ps.filter(homeLive).length;
    const target = Number(cp.targetCreators) || 0;
    const status = String(cp.status || '').toLowerCase();
    const start = dateOnly(cp.start), end = dateOnly(cp.end);

    /* how far through its own calendar the campaign is; null when the
       dates cannot answer it, which is not the same as zero */
    let elapsed = null;
    if (start && end && end > start) {
      const span = new Date(end + 'T00:00:00Z') - new Date(start + 'T00:00:00Z');
      elapsed = Math.max(0, Math.min(1, (now - new Date(start + 'T00:00:00Z')) / span));
    }
    const progress = target ? Math.min(1, confirmed / target) : 0;

    let health = 'ontrack';
    if (status === 'wrapped' || (target > 0 && delivered >= target)) health = 'complete';
    else if (elapsed === null) health = 'unknown';
    else if (elapsed <= 0) health = 'notstarted';
    else if (target && progress < elapsed) health = 'risk';

    return {
      id: cp.id, name: cp.name || cp.brand || cp.id, status,
      statusLabel: (CAMPAIGN_STATUS[status] || {}).label || 'Unknown',
      confirmed, delivered, target, progress, elapsed,
      posts: g.content, views: g.views, measured: g.measured,
      unmeasured: g.content > 0 && g.measured === 0,
      noTarget: !target, health
    };
  }).sort((a, b) => b.views - a.views || b.confirmed - a.confirmed);
}

/* ---- the creator flow, collapsed to the steps that record movement ----

   creatorPipeline returns all nine stages. Three of them — contacted,
   replied and shortlisted — are pass-through: the Notion form never
   produces those values, so every sourced creator counts at all three
   and drawing them as separate segments would show movement that was
   never recorded. They collapse into the first block, and the card says
   so rather than leaving the reader to wonder why three bars match.
   ------------------------------------------------------------------ */

export function creatorFlow(db, campaignIds) {
  const f = creatorPipeline(db, campaignIds);
  const at = (id) => (f.counts.find((c) => c.stage.id === id) || { n: 0 }).n;
  const steps = [
    { id: 'shortlisted', label: 'Sourced → Shortlisted', n: at('sourced') },
    { id: 'confirmed',   label: 'Confirmed',             n: at('confirmed') },
    { id: 'shipped',     label: 'Shipped',               n: at('shipped') },
    { id: 'live',        label: 'Live',                  n: at('live') }
  ];
  const losses = steps.slice(1).map((s, i) => ({
    lost: steps[i].n - s.n,
    through: steps[i].n ? s.n / steps[i].n : 0,
    label: s.id === 'confirmed' ? 'declined' : s.id === 'shipped' ? 'not shipped' : 'no link'
  }));
  return { steps, losses, dropped: f.dropped, total: f.total };
}
