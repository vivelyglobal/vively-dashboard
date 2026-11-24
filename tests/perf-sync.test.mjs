/* server/perf-sync.js: live performance snapshot from the link-shared KOL Sheet.

   No network. A stand-in `fetch` answers the way Google's gviz endpoint does
   (the "/*O_o*\/" line, google.visualization.Query.setResponse({...}), zero-based
   Date(y,m,d) cells, `select * limit 0` = columns only, a column-limited select =
   only those columns) and records every URL it was asked for. Every id, handle
   and "secret" below is invented. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const P = require('../server/perf-sync.js');
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const FAKE_ID = 'FAKE_SHEET_ID_NOT_REAL_0000';
const S = {  // planted in columns that must never be read
  contact: 'SENTINEL_CONTACT_kakao_71f3', rate: 'SENTINEL_RATE_9981234', amount: 'SENTINEL_AMOUNT_5550001',
  budget: 'SENTINEL_BUDGET_7770002', notes: 'SENTINEL_NOTES_paid_extra', name: 'SENTINEL_NAME_Hong_Gildong',
  cpe: 'SENTINEL_CPE_3330003', barter: 'SENTINEL_BARTER_serum', brief: 'SENTINEL_BRIEF_https_x'
};
const SENTINELS = Object.values(S);
const FORBIDDEN_WORDS = /contact|rate|amount|budget|notes?|cpe|cpv|barter|brief|objective|target|profile|location|name_full/i;

/* ---------- fake Google ---------- */
const colId = (i) => String.fromCharCode(65 + i);
const D = (y, m, d, h, mi, s) => ({ date: [y, m, d, h, mi, s] });   // m is ZERO-based, like gviz
function cell(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object' && v.date) {
    const [y, m, d, h, mi, s] = v.date;
    const hasT = h != null;
    return { v: 'Date(' + [y, m, d].concat(hasT ? [h, mi || 0, s || 0] : []).join(',') + ')', f: (m + 1) + '/' + d + '/' + y };
  }
  if (typeof v === 'object' && v.pct) return { v: v.pct, f: (v.pct * 100).toFixed(1) + '%' };
  return { v };
}
function wrap(obj) { return '/*O_o*/\ngoogle.visualization.Query.setResponse(' + JSON.stringify(obj) + ');'; }

function makeSheet(tabs, opt) {
  const o = opt || {};
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (o.throwOnFetch) throw new Error('connect failed to ' + url);
    const u = new URL(url);
    if (u.hostname !== 'docs.google.com') throw new Error('off-host fetch: ' + u.hostname);
    const reply = (status, body, headers) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => (headers || {})[String(k).toLowerCase()] || null }, text: async () => body });
    if (o.status) return reply(o.status, 'nope');
    if (o.redirectTo) return reply(302, '', { location: o.redirectTo });
    if (o.html) return reply(200, '<!doctype html><title>Sign in</title>', { 'content-type': 'text/html' });
    if (o.contentLength) return reply(200, 'x', { 'content-length': String(o.contentLength) });
    const tab = u.searchParams.get('sheet');
    const q = u.searchParams.get('tq');
    const t = tabs[tab];
    if (!t) return reply(200, wrap({ version: '0.6', status: 'error', errors: [{ reason: 'invalid_query', message: 'no such sheet' }] }));
    const cols = t.labels.map((l, i) => ({ id: colId(i), label: l, type: 'string' }));
    let m = q.match(/^select \* limit 0$/);
    if (m) return reply(200, wrap({ version: '0.6', status: 'ok', table: { cols, rows: [] } }));
    m = q.match(/^select ([A-Z,]+) limit (\d+)$/);
    if (!m) return reply(200, wrap({ status: 'error', errors: [{ reason: 'invalid_query' }] }));
    const want = m[1].split(',');
    const limit = Number(m[2]);
    const use = o.ignoreColumnLimit ? cols.map((c) => c.id) : want;
    const rows = t.rows.slice(0, limit).map((r) => ({ c: use.map((id) => cell(r[id.charCodeAt(0) - 65])) }));
    return reply(200, wrap({ version: '0.6', status: 'ok', table: { cols: use.map((id) => cols[id.charCodeAt(0) - 65]), rows } }));
  };
  return { fetchImpl, requests, tabs };
}

/* ---------- fixture: the structure the founder's Sheet really has ---------- */
const DB_A = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';   // 32 chars
const DB_SH = '11111111222233334444555555555555';
function fixtureTabs() {
  return {
    'Campaign Map': { labels: ['', ''], rows: [
      ['Campaign Name', 'Notion Database ID'],
      ['Aura Seoul', DB_A],
      ['Lumi Beauty', ''],
      ['Sheet Only Co', ''],
      ['Twin', ''],
      ['Share A', DB_SH],
      ['Share B', DB_SH]
    ] },
    Campaigns: { labels: ['campaign_id', 'name', 'budget', 'created_date', 'campaign_status', 'start_date', 'end_date', 'objective', 'target_audience', 'key_message', 'content_brief', 'hashtags', 'dos_donts', 'brief_url', 'visit_place', 'barter_item', 'barter_value'],
      rows: [
        ['c1', 'Aura Seoul', S.budget, D(2026, 8, 1), 'live', '2026-09-01', D(2026, 10, 30), S.notes, S.notes, S.notes, S.notes, '#x', S.notes, S.brief, S.notes, S.barter, S.barter],
        ['c2', 'Lumi Beauty', S.budget, null, 'live', '2026-10-01', null, null, null, null, null, null, null, null, null, null, null],
        ['c3', 'Sheet Only Co', S.budget, null, 'done', '2026-07-01', null, null, null, null, null, null, null, null, null, null, null],
        ['c4', 'Twin', S.budget, null, 'live', '2026-10-01', null, null, null, null, null, null, null, null, null, null, null],
        ['c5', 'Share A', S.budget, null, 'live', '2026-10-01', null, null, null, null, null, null, null, null, null, null, null],
        ['c6', 'Share B', S.budget, null, 'live', '2026-10-01', null, null, null, null, null, null, null, null, null, null, null],
        ['c7', 'Contains Lumi', S.budget, null, 'live', '2026-10-01', null, null, null, null, null, null, null, null, null, null, null]
      ] },
    CampaignInfluencers: { labels: ['ci_id', 'campaign_id', 'influencer_id', 'current_step', 'amount_due', 'date_added_to_campaign', 'note', 'barter_item', 'barter_value', 'barter_sent_date', 'visit_date', 'visit_done_date'],
      rows: [
        ['ci1', 'c1', 'i1', 'posted', S.amount, null, S.notes, S.barter, S.barter, null, null, null],
        ['ci2', 'c2', 'i2', 'posted', S.amount, null, S.notes, null, null, null, null, null],
        ['ci3', 'c3', 'i1', 'posted', S.amount, null, S.notes, null, null, null, null, null]
      ] },
    Influencers: { labels: ['influencer_id', 'platform', 'username', 'name', 'profile url', 'followers', 'following', 'avg_likes', 'avg_comments', 'avg_views', 'engagement', 'status', 'category', 'location', 'contact', 'date added', 'last sync', 'notes', 'rate_post', 'rate_story', 'rate_bundle'],
      rows: [
        ['i1', 'Instagram', 'creator_one', S.name, S.contact, 12000, 300, 1, 1, 1, 1, 'active', 'beauty', 'Seoul', S.contact, null, null, S.notes, S.rate, S.rate, S.rate],
        ['i2', 'TikTok', 'creator_two', S.name, S.contact, 5400, 10, 1, 1, 1, 1, 'active', 'food', 'Busan', S.contact, null, null, S.notes, S.rate, S.rate, S.rate]
      ] },
    Deliverables: { labels: ['deliverable_id', 'ci_id', 'type', 'post_url', 'posted_date', 'likes', 'comments', 'views', 'last_scraped_at', 'notes', 'cpe_expected', 'cpe_actual', 'cpv_expected', 'cpv_actual', 'shares', 'saves', 'reposts'],
      rows: [
        ['D1', 'ci1', 'reel', 'https://www.instagram.com/reel/AAA1/', D(2026, 10, 20), 100, 5, 2000, D(2026, 10, 23, 9, 5, 0), S.notes, S.cpe, S.cpe, S.cpe, S.cpe, 3, 4, 0],
        ['D3', 'ci1', 'reel', 'https://www.instagram.com/reel/AAA1/?igsh=zz', D(2026, 10, 20), 110, 6, 2500, D(2026, 10, 24, 9, 5, 0), S.notes, S.cpe, S.cpe, S.cpe, S.cpe, 3, 4, 0],
        ['D2', 'ci2', 'video', 'https://www.tiktok.com/@creator_two/video/7000000000000000001', D(2026, 10, 21), 50, 2, 0, D(2026, 10, 24, 8, 0, 0), S.notes, S.cpe, S.cpe, S.cpe, S.cpe, null, null, null],
        ['D4', 'ci1', 'story', 'https://www.instagram.com/p/BBB2/', D(2026, 10, 22), 30, 1, 900, D(2026, 10, 10), S.notes, S.cpe, S.cpe, S.cpe, S.cpe, 0, 0, 0],
        ['D4', 'ci1', 'story', 'https://www.instagram.com/p/BBB2/', D(2026, 10, 22), 40, 2, 950, D(2026, 10, 11), S.notes, S.cpe, S.cpe, S.cpe, S.cpe, 0, 0, 0],
        ['D5', 'ci1', 'video', 'https://www.tiktok.com/@creator_one/video/7000000000000000009', D(2026, 10, 19), 70, 3, 1200, D(2026, 10, 24, 1, 0, 0), S.notes, S.cpe, S.cpe, S.cpe, S.cpe, 1, 1, 1],
        ['D6', 'ci-unknown', 'reel', 'https://www.instagram.com/reel/CCC3/', D(2026, 10, 18), 10, 1, 100, D(2026, 10, 24, 2, 0, 0), S.notes, S.cpe, S.cpe, S.cpe, S.cpe, 0, 0, 0],
        ['D7', 'ci3', 'reel', 'https://www.instagram.com/reel/DDD4/', D(2026, 10, 17), 0, 0, 0, null, S.notes, S.cpe, S.cpe, S.cpe, S.cpe, null, null, null]
      ] },
    'Aura Seoul': { labels: ['deliverable_id', 'post_url', 'post_er', 'notes', 'likes'],
      rows: [
        ['D1', 'https://www.instagram.com/reel/AAA1/', { pct: 0.042 }, S.notes, 1],
        ['D4', 'https://www.instagram.com/p/BBB2/', 'abc', S.notes, 1],
        ['D5', 'https://www.tiktok.com/@creator_one/video/7000000000000000009', 6, S.notes, 1],
        ['D9', 'https://www.instagram.com/reel/NOPE/', null, S.notes, 1]
      ] },
    'Lumi Beauty': { labels: ['deliverable_id', 'post_url', 'notes'], rows: [['D2', 'x', S.notes]] }
  };
}

const DASH = [
  { id: 'dA', name: 'Totally Different Name', notionDatabaseId: DB_A.slice(0, 8).toUpperCase() + '-' + DB_A.slice(8, 12) + '-' + DB_A.slice(12, 16) + '-' + DB_A.slice(16, 20) + '-' + DB_A.slice(20) },
  { id: 'dB', name: '  lumi beauty ' },
  { id: 'dT1', name: 'Twin' }, { id: 'dT2', name: 'twin' },
  { id: 'dS', name: 'Shared Target', notionDatabaseId: DB_SH },
  { id: 'dX', name: 'Contains Lumi Beauty Extra' }
];

function memStore() {
  const st = { snapshot: null, log: null, matches: [], writes: { snapshot: 0, log: 0, matches: 0 } };
  return {
    st,
    async readSnapshot() { return st.snapshot ? JSON.parse(JSON.stringify(st.snapshot)) : null; },
    async writeSnapshot(doc) { st.writes.snapshot++; st.snapshot = JSON.parse(JSON.stringify(doc)); },
    async readLog() { return st.log ? JSON.parse(JSON.stringify(st.log)) : null; },
    async appendLog(e) { st.writes.log++; const runs = ((st.log && st.log.runs) || []).concat([e]).slice(-30); st.log = { last: e, runs }; },
    async readMatches() { return st.matches.slice(); },
    async writeMatches(l) { st.writes.matches++; st.matches = l.slice(); }
  };
}
function clock(iso) { const c = { t: Date.parse(iso || '2026-11-25T10:00:00Z') }; c.now = () => new Date(c.t); c.advance = (ms) => { c.t += ms; }; return c; }

function job(sheet, over) {
  const o = over || {};
  const store = o.store || memStore();
  const logs = [];
  const logger = { error: (...a) => logs.push(a.join(' ')), log: (...a) => logs.push(a.join(' ')) };
  const clk = o.clock || clock();
  const perf = P.createPerfSync({
    sheetId: FAKE_ID, fetchImpl: sheet.fetchImpl, now: clk.now, logger, maxRows: o.maxRows || 5000, intervalMin: 30,
    dryRun: !!o.dryRun, store,
    loadWorkspace: o.loadWorkspace || (async () => ({ db: { campaigns: o.dash || DASH } }))
  });
  return { perf, store, logs, clk };
}

const byId = (snap, id) => snap.campaigns.find((c) => c.sheetCampaignId === id);
const post = (snap, id) => snap.posts.find((p) => p.deliverableId === id);
const dataQueries = (sheet) => sheet.requests.map((r) => { const u = new URL(r.url); return { tab: u.searchParams.get('sheet'), q: u.searchParams.get('tq') }; });

/* ---------- config ---------- */
test('config: off by default, interval default 30 and floor 5, row cap default 5000, dry run flag, bad id is invalid', () => {
  assert.equal(P.parseConfig({}).requested, false);
  const c = P.parseConfig({ PERF_SHEET_ID: FAKE_ID });
  assert.equal(c.requested, true); assert.equal(c.sheetId, FAKE_ID);
  assert.equal(c.intervalMin, 30); assert.equal(c.maxRows, 5000); assert.equal(c.dryRun, false);
  assert.equal(P.parseConfig({ PERF_SHEET_ID: FAKE_ID, PERF_SYNC_INTERVAL_MIN: '1' }).intervalMin, 5);
  assert.equal(P.parseConfig({ PERF_SHEET_ID: FAKE_ID, PERF_SYNC_INTERVAL_MIN: '' }).intervalMin, 30);
  assert.equal(P.parseConfig({ PERF_SHEET_ID: FAKE_ID, PERF_SYNC_MAX_ROWS: '123' }).maxRows, 123);
  assert.equal(P.parseConfig({ PERF_SHEET_ID: FAKE_ID, PERF_SYNC_DRY_RUN: '1' }).dryRun, true);
  const bad = P.parseConfig({ PERF_SHEET_ID: 'short id with spaces' });
  assert.equal(bad.invalid, true); assert.equal(bad.sheetId, '');
});

/* ---------- discovery, column limiting ---------- */
test('schema discovery: labels come from `select * limit 0`; data queries name only whitelisted columns and never select *', async () => {
  const sheet = makeSheet(fixtureTabs());
  const j = job(sheet);
  const e = await j.perf.run({ trigger: 'manual' });
  assert.equal(e.ok, true, e.message);
  const qs = dataQueries(sheet);
  /* columns discovered by label, then asked for by letter */
  const tabs = fixtureTabs();
  const allowed = {
    Campaigns: ['campaign_id', 'name', 'start_date', 'end_date', 'campaign_status'],
    CampaignInfluencers: ['ci_id', 'campaign_id', 'influencer_id'],
    Influencers: ['influencer_id', 'platform', 'username', 'followers'],
    Deliverables: ['deliverable_id', 'ci_id', 'type', 'post_url', 'posted_date', 'likes', 'comments', 'views', 'last_scraped_at', 'shares', 'saves', 'reposts'],
    'Aura Seoul': ['post_er', 'deliverable_id', 'post_url']
  };
  let checked = 0;
  qs.forEach(({ tab, q }) => {
    assert.ok(!FORBIDDEN_WORDS.test(q), 'query mentions a forbidden word: ' + q);
    if (q === 'select * limit 0') return;
    assert.match(q, /^select [A-Z,]+ limit \d+$/, 'no select * with rows: ' + q);
    if (tab === 'Campaign Map') { assert.match(q, /^select A,B limit 5001$/); checked++; return; }
    if (!allowed[tab]) return;          // per-campaign tab with no post_er is never data-queried
    const letters = q.match(/^select ([A-Z,]+)/)[1].split(',');
    const labels = letters.map((L) => tabs[tab].labels[L.charCodeAt(0) - 65]);
    assert.deepEqual(labels.slice().sort(), allowed[tab].slice().sort(), 'columns asked for in ' + tab);
    checked++;
  });
  assert.equal(checked, 6);
  /* a tab with no post_er was probed for its column list only */
  assert.ok(qs.filter((x) => x.tab === 'Lumi Beauty').every((x) => x.q === 'select * limit 0'));
  /* the limit is maxRows + 1 */
  assert.ok(qs.some((x) => x.tab === 'Deliverables' && /limit 5001$/.test(x.q)));
  /* only docs.google.com, https, request never carries redirect:follow */
  sheet.requests.forEach((r) => { const u = new URL(r.url); assert.equal(u.protocol, 'https:'); assert.equal(u.hostname, 'docs.google.com'); assert.equal(r.init.redirect, 'manual'); });
});

test('the snapshot: whitelisted fields only, Date(y,m,d) cells read with a zero-based month, stamps set', async () => {
  const j = job(makeSheet(fixtureTabs()));
  const e = await j.perf.run({ trigger: 'manual' });
  assert.equal(e.ok, true);
  const snap = j.store.st.snapshot;
  assert.equal(snap.checkedAt, '2026-11-25T10:00:00.000Z');
  assert.equal(snap.newestReadingAt, '2026-11-24T09:05:00.000Z');
  const d3 = post(snap, 'D3');
  assert.equal(d3.postedDate, '2026-11-20');                 // Date(2026,10,20) -> November
  assert.equal(d3.lastScrapedAt, '2026-11-24T09:05:00.000Z');
  assert.deepEqual(d3.creator, { handle: 'creator_one', platform: 'Instagram', followers: 12000 });
  assert.equal(d3.sheetCampaignId, 'c1');
  assert.equal(byId(snap, 'c1').startDate, '2026-09-01');
  assert.equal(byId(snap, 'c1').endDate, '2026-11-30');
  assert.equal(snap.counts.campaigns, 7); assert.equal(snap.counts.deliverables, 8);
  /* every key that can appear in a post, a campaign or a creator is on the list */
  const okPost = new Set(['deliverableId', 'sheetCampaignId', 'platformPostId', 'postUrl', 'platform', 'creator', 'type', 'postedDate', 'views', 'likes', 'comments', 'shares', 'saves', 'reposts', 'er', 'lastScrapedAt', 'flags']);
  snap.posts.forEach((p) => Object.keys(p).forEach((k) => assert.ok(okPost.has(k), 'unexpected post key ' + k)));
  const okCp = new Set(['sheetCampaignId', 'name', 'startDate', 'endDate', 'status', 'notionDatabaseId', 'match', 'stats']);
  snap.campaigns.forEach((c) => Object.keys(c).forEach((k) => assert.ok(okCp.has(k), 'unexpected campaign key ' + k)));
  snap.posts.filter((p) => p.creator).forEach((p) => assert.deepEqual(Object.keys(p.creator).sort(), ['followers', 'handle', 'platform']));
});

/* ---------- refusals keep old data ---------- */
test('a missing label refuses the run, keeps the old snapshot, and says it in plain words', async () => {
  const tabs = fixtureTabs();
  const sheet = makeSheet(tabs);
  const j = job(sheet);
  await j.perf.run({ trigger: 'manual' });
  const before = JSON.stringify(j.store.st.snapshot);
  j.clk.advance(31 * 60000);
  tabs.Deliverables.labels[7] = 'view_count';           // 'views' renamed
  const e = await j.perf.run({ trigger: 'poll' });
  assert.equal(e.ok, false); assert.equal(e.errorCode, 'column-missing');
  assert.equal(e.message, "Column 'views' is missing from 'Deliverables'. Nothing was updated.");
  assert.equal(JSON.stringify(j.store.st.snapshot), before, 'snapshot untouched');
  const v = await j.perf.view();
  assert.equal(v.state.state, 'column-missing');
  assert.equal(v.state.banner.text, "Column 'views' is missing from 'Deliverables'. Nothing was updated.");
  assert.equal(v.state.showingDataFrom, '2026-11-25T10:00:00.000Z');
  assert.equal(v.freshness.level, 'red');
});

test('a duplicated whitelisted label refuses too (no guessing which column)', async () => {
  const tabs = fixtureTabs(); tabs.Influencers.labels[17] = 'username';
  const j = job(makeSheet(tabs));
  const e = await j.perf.run({});
  assert.equal(e.errorCode, 'column-ambiguous'); assert.equal(j.store.st.snapshot, null);
});

test('the other plain-words states: tab renamed, not shared (403, sign-in page, redirect to accounts), too big (rows, content-length), Google down', async () => {
  let tabs = fixtureTabs(); delete tabs.Deliverables;
  let j = job(makeSheet(tabs));
  let e = await j.perf.run({});
  assert.equal(e.errorCode, 'tab-missing'); assert.equal(e.message, "The tab 'Deliverables' was not found. Nothing was updated.");

  tabs = fixtureTabs(); delete tabs['Campaign Map'];
  e = await job(makeSheet(tabs)).perf.run({});
  assert.equal(e.errorCode, 'tab-missing'); assert.match(e.message, /Campaign Map/);

  for (const o of [{ status: 403 }, { html: true }, { redirectTo: 'https://accounts.google.com/ServiceLogin?x=1' }]) {
    j = job(makeSheet(fixtureTabs(), o)); e = await j.perf.run({});
    assert.equal(e.errorCode, 'not-shared', JSON.stringify(o));
    assert.equal(e.message, 'Google asked for a sign-in, so the sheet cannot be read. Set sharing to Anyone with the link, Viewer.');
  }
  j = job(makeSheet(fixtureTabs()), { maxRows: 7 }); e = await j.perf.run({});
  assert.equal(e.errorCode, 'too-big'); assert.equal(e.message, 'A tab is larger than the safety limit. Nothing was updated.');
  assert.equal(j.store.st.snapshot, null);
  j = job(makeSheet(fixtureTabs(), { contentLength: P.MAX_BYTES + 1 })); e = await j.perf.run({});
  assert.equal(e.errorCode, 'too-big');

  j = job(makeSheet(fixtureTabs(), { status: 503 })); e = await j.perf.run({});
  assert.equal(e.errorCode, 'google-down');
  j = job(makeSheet(fixtureTabs(), { throwOnFetch: true })); e = await j.perf.run({});
  assert.equal(e.errorCode, 'google-down');
  const v = await j.perf.view();
  assert.equal(v.state.banner.text, 'Google did not answer. There is no earlier data yet.');
});

test('Google down after a good run: banner names the time of the data still on screen', async () => {
  const tabs = fixtureTabs(); const sheet = makeSheet(tabs);
  const j = job(sheet);
  await j.perf.run({});
  const bad = job(makeSheet(tabs, { status: 502 }), { store: j.store, clock: j.clk });
  j.clk.advance(30 * 60000);
  await bad.perf.run({});
  const v = await bad.perf.view();
  assert.equal(v.state.banner.text, 'Google did not answer. Showing data from 10:00 UTC.');
  assert.ok(j.store.st.snapshot, 'old data kept');
});

test('a redirect to any other host is refused, never followed (the fake throws on an off-host fetch)', async () => {
  const sheet = makeSheet(fixtureTabs(), { redirectTo: 'https://evil.example.invalid/steal' });
  const e = await job(sheet).perf.run({});
  assert.equal(e.errorCode, 'bad-response');
  assert.equal(sheet.requests.length, 1, 'only the first hop was requested');
});

/* ---------- joining to dashboard campaigns ---------- */
test('join order: Notion database id first (dashes and case ignored), then exact name when exactly one, else needs-match; no contains; shared target lists both', async () => {
  const j = job(makeSheet(fixtureTabs()));
  await j.perf.run({});
  const s = j.store.st.snapshot;
  assert.deepEqual([byId(s, 'c1').match.state, byId(s, 'c1').match.by, byId(s, 'c1').match.dashboardCampaignId], ['matched', 'notion-db', 'dA']);
  assert.deepEqual([byId(s, 'c2').match.state, byId(s, 'c2').match.by, byId(s, 'c2').match.dashboardCampaignId], ['matched', 'name', 'dB']);
  assert.equal(byId(s, 'c3').match.state, 'needs-match'); assert.equal(byId(s, 'c3').match.reason, 'no-match');
  assert.equal(byId(s, 'c4').match.state, 'needs-match'); assert.equal(byId(s, 'c4').match.reason, 'ambiguous');
  assert.deepEqual(byId(s, 'c4').match.candidates.map((x) => x.id).sort(), ['dT1', 'dT2']);
  assert.equal(byId(s, 'c7').match.state, 'needs-match', '"Contains Lumi" must not match "Lumi Beauty" by contains');
  for (const id of ['c5', 'c6']) { assert.equal(byId(s, id).match.state, 'needs-match'); assert.equal(byId(s, id).match.reason, 'shared'); }
  assert.deepEqual(s.needsMatch.map((x) => x.sheetCampaignId).sort(), ['c3', 'c4', 'c5', 'c6', 'c7']);
  assert.equal(s.counts.campaignsMatched, 2);
});

test('exact-name fallback only: pure function checks (case, spaces, no substring, ambiguity)', () => {
  const m = P.computeMatches([{ id: 'a', name: ' Foo Bar ' }, { id: 'b', name: 'Foo' }, { id: 'c', name: 'Dup' }],
    [{ id: 'd1', name: 'foo bar' }, { id: 'd2', name: 'Foo Bar Baz' }, { id: 'd3', name: 'dup' }, { id: 'd4', name: 'DUP' }], []);
  assert.equal(m.get('a').dashboardCampaignId, 'd1');
  assert.equal(m.get('b').state, 'needs-match');
  assert.equal(m.get('c').reason, 'ambiguous');
  /* a database id that matches NOTHING falls through to the name step */
  const m2 = P.computeMatches([{ id: 'a', name: 'Foo', notionDatabaseId: 'f'.repeat(32) }], [{ id: 'd1', name: 'foo', notionDatabaseId: 'e'.repeat(32) }], []);
  assert.equal(m2.get('a').by, 'name');
  /* a database id that matches TWO dashboard campaigns is ambiguous, not "first wins" */
  const m3 = P.computeMatches([{ id: 'a', name: 'Foo', notionDatabaseId: 'f'.repeat(32) }], [{ id: 'd1', name: 'x', notionDatabaseId: 'f'.repeat(32) }, { id: 'd2', name: 'y', notionDatabaseId: 'f'.repeat(32) }], []);
  assert.equal(m3.get('a').reason, 'ambiguous');
});

test('manual match: saved server-side, survives a re-sync, validated, can mark Sheet only', async () => {
  const sheet = makeSheet(fixtureTabs());
  const j = job(sheet);
  await j.perf.run({});
  assert.equal((await j.perf.setMatch('nope', 'dA')).status, 404);
  assert.equal((await j.perf.setMatch('c3', 'does-not-exist')).status, 400);
  const ok = await j.perf.setMatch('c3', 'dX');
  assert.equal(ok.ok, true); assert.equal(ok.match.state, 'matched'); assert.equal(ok.match.by, 'manual');
  assert.equal(j.store.st.matches.length, 1);
  assert.equal(byId(j.store.st.snapshot, 'c3').match.dashboardCampaignId, 'dX');
  assert.equal(j.store.st.snapshot.counts.campaignsNeedMatch, 4);
  j.clk.advance(31 * 60000);
  await j.perf.run({});                                       // a fresh read rebuilds the whole snapshot...
  assert.equal(byId(j.store.st.snapshot, 'c3').match.dashboardCampaignId, 'dX', '...and the choice is still there');
  await j.perf.setMatch('c4', '');                             // "Sheet only", on purpose
  assert.equal(byId(j.store.st.snapshot, 'c4').match.state, 'sheet-only');
  /* the chosen dashboard campaign is deleted: back to the automatic steps, not a dangling id */
  const j2 = job(sheet, { store: j.store, dash: DASH.filter((c) => c.id !== 'dX') });
  await j2.perf.run({});
  assert.equal(byId(j.store.st.snapshot, 'c3').match.state, 'needs-match');
});

/* ---------- posts ---------- */
test('duplicates: same post (url with a tracking suffix) and repeated deliverable id keep the newest last_scraped_at and are counted', async () => {
  const j = job(makeSheet(fixtureTabs()));
  await j.perf.run({});
  const s = j.store.st.snapshot;
  assert.equal(s.duplicates.byDeliverableId, 1);   // D4 twice
  assert.equal(s.duplicates.byPost, 1);            // D1 vs D3 (same reel)
  assert.equal(s.counts.posts, 6);                 // 8 rows - 2
  assert.equal(post(s, 'D1'), undefined); assert.equal(post(s, 'D3').views, 2500);
  assert.equal(post(s, 'D4').views, 950, 'the row scraped on 11/11 beats 11/10');
  assert.equal(post(s, 'D3').platformPostId, 'ig_AAA1');
});

test('zero or blank likes/views = "did not read": null plus a flag; other counts keep their numbers', async () => {
  const j = job(makeSheet(fixtureTabs()));
  await j.perf.run({});
  const s = j.store.st.snapshot;
  const d2 = post(s, 'D2');
  assert.equal(d2.views, null); assert.equal(d2.flags.viewsUnread, true);
  assert.equal(d2.likes, 50); assert.equal(d2.flags.likesUnread, false); assert.equal(d2.flags.hasReading, true);
  const d7 = post(s, 'D7');
  assert.deepEqual([d7.views, d7.likes, d7.flags.hasReading, d7.flags.neverRead], [null, null, false, true]);
  assert.equal(post(s, 'D3').reposts, 0, 'a reposts 0 is kept as 0');
  assert.equal(post(s, 'D6').flags.noCampaign, true);
  assert.equal(post(s, 'D4').flags.readingOld, true, 'last read 14 days ago');
  assert.equal(post(s, 'D3').flags.readingOld, false);
  const c3 = byId(s, 'c3');
  assert.equal(c3.stats.posts, 1); assert.equal(c3.stats.withReading, 0); assert.equal(c3.stats.views, 0);
});

/* ---------- engagement rate ---------- */
test('post_er comes from the per-campaign tab named like the campaign; the mean excludes blank and invalid; a % cell is scaled', async () => {
  const sheet = makeSheet(fixtureTabs());
  const j = job(sheet);
  await j.perf.run({});
  const s = j.store.st.snapshot;
  assert.equal(post(s, 'D3').er, 4.2);              // 0.042 shown as "4.2%", matched by post url
  assert.equal(post(s, 'D4').er, null);             // 'abc'
  assert.equal(post(s, 'D5').er, 6);
  assert.equal(post(s, 'D2').er, null);             // Lumi Beauty tab has no post_er
  assert.equal(post(s, 'D3').flags.noEr, false); assert.equal(post(s, 'D2').flags.noEr, true);
  const c1 = byId(s, 'c1').stats;
  assert.equal(c1.avgEr, 5.1); assert.equal(c1.erCount, 2);
  assert.equal(byId(s, 'c2').stats.avgEr, null, 'no value is not a zero');
  assert.deepEqual(s.erTabs.read, 1);
  const why = Object.fromEntries(s.erTabs.skipped.map((x) => [x.tab, x.why]));
  assert.equal(why['Lumi Beauty'], 'no-post_er'); assert.equal(why['Twin'], 'tab-missing');
  /* the unit rules */
  assert.equal(P.cellEr({ v: 0.042, f: '4.2%' }), 4.2); assert.equal(P.cellEr({ v: 4.2 }), 4.2);
  assert.equal(P.cellEr({ v: '5.5%' }), 5.5); assert.equal(P.cellEr({ v: 0 }), null);
  assert.equal(P.cellEr({ v: 140 }), null); assert.equal(P.cellEr(null), null); assert.equal(P.cellEr({ v: '' }), null);
});

test('per-campaign tabs: at most 40 are tried, and a tab that fails never refuses the run', async () => {
  const tabs = fixtureTabs();
  tabs.Campaigns.rows = [];
  for (let i = 0; i < 45; i++) tabs.Campaigns.rows.push(['k' + i, 'Camp ' + i, null, null, 'live', '2026-10-01', null, ...Array(10).fill(null)]);
  const sheet = makeSheet(tabs);
  const j = job(sheet);
  const e = await j.perf.run({});
  assert.equal(e.ok, true, e.message);
  const fixed = new Set(['Campaign Map', 'Campaigns', 'CampaignInfluencers', 'Influencers', 'Deliverables']);
  const tried = new Set(dataQueries(sheet).map((x) => x.tab).filter((t) => !fixed.has(t)));
  assert.equal(tried.size, 40);
  assert.ok(j.store.st.snapshot.erTabs.skipped.some((x) => x.why === 'tab-cap'));
});

/* ---------- privacy: sentinels ---------- */
function surfaces(j, extra) {
  const s = [JSON.stringify(j.store.st), j.logs.join('\n')].concat(extra || []);
  return s;
}
test('sentinels: values planted in forbidden columns never reach the snapshot, status, run log, logs or errors', async () => {
  const sheet = makeSheet(fixtureTabs());
  const j = job(sheet);
  await j.perf.run({});
  const v = await j.perf.view();
  const all = surfaces(j, [JSON.stringify(v), JSON.stringify(sheet.requests.map((r) => r.url))]);
  all.forEach((t) => SENTINELS.forEach((x) => assert.ok(!t.includes(x), 'leaked ' + x)));
  /* the snapshot does hold the whitelisted things it should (so the check above is not vacuous) */
  assert.ok(JSON.stringify(j.store.st.snapshot).includes('creator_one'));
});

test('sentinels, defence in depth: even if Google ignored the column limit and sent every column, nothing forbidden is kept', async () => {
  const sheet = makeSheet(fixtureTabs(), { ignoreColumnLimit: true });
  const j = job(sheet);
  const e = await j.perf.run({});
  assert.equal(e.ok, true, e.message);
  surfaces(j, [JSON.stringify(await j.perf.view())]).forEach((t) => SENTINELS.forEach((x) => assert.ok(!t.includes(x), 'leaked ' + x)));
  assert.equal(post(j.store.st.snapshot, 'D3').views, 2500);
});

test('the sheet id never appears in a snapshot, run log, error, log line or status, including when the network error text carries the url', async () => {
  const bad = job(makeSheet(fixtureTabs(), { throwOnFetch: true }));
  await bad.perf.run({});
  const good = job(makeSheet(fixtureTabs()));
  await good.perf.run({});
  for (const j of [bad, good]) {
    surfaces(j, [JSON.stringify(await j.perf.view())]).forEach((t) => assert.ok(!t.includes(FAKE_ID), 'sheet id leaked'));
  }
  const scrub = P.makeScrub(FAKE_ID);
  assert.ok(!scrub('failed https://docs.google.com/spreadsheets/d/' + FAKE_ID + '/gviz/tq?x=1 and ' + FAKE_ID).includes(FAKE_ID));
});

/* ---------- dry run ---------- */
test('dry run (env or per request) reads and reports counts and the unmatched list and writes NOTHING', async () => {
  const sheet = makeSheet(fixtureTabs());
  const j = job(sheet, { dryRun: true });
  const e = await j.perf.run({ trigger: 'poll' });
  assert.equal(e.ok, true); assert.equal(e.dryRun, true);
  assert.equal(e.counts.posts, 6); assert.equal(e.counts.deliverables, 8);
  assert.equal(e.needsMatch.length, 5);
  assert.deepEqual(j.store.st.writes, { snapshot: 0, log: 0, matches: 0 });
  assert.equal(j.store.st.snapshot, null);
  assert.equal(j.perf.lastDryRun().ok, true);
  const v = await j.perf.view();
  assert.equal(v.state.state, 'dry-run');
  /* per request, with the env flag off */
  const j2 = job(makeSheet(fixtureTabs()));
  await j2.perf.run({ trigger: 'manual', dryRun: true });
  assert.deepEqual(j2.store.st.writes, { snapshot: 0, log: 0, matches: 0 });
  /* and a failing dry run writes nothing either */
  const j3 = job(makeSheet(fixtureTabs(), { status: 503 }), { dryRun: true });
  await j3.perf.run({});
  assert.deepEqual(j3.store.st.writes, { snapshot: 0, log: 0, matches: 0 });
});

/* ---------- freshness ---------- */
test('badge data: green, amber, red thresholds (ASSUMED values from the PM plan) and per-state words', () => {
  const NOW = Date.parse('2026-11-25T12:00:00Z');
  const snap = (checked, newest) => ({ checkedAt: checked, newestReadingAt: newest });
  assert.equal(P.freshness(null, null, 30, NOW).level, 'red');
  assert.equal(P.freshness(snap('2026-11-25T11:30:00Z', '2026-11-24T20:00:00Z'), null, 30, NOW).level, 'green');
  assert.equal(P.freshness(snap('2026-11-25T10:00:00Z', '2026-11-25T09:00:00Z'), null, 30, NOW).level, 'amber');   // 120 min > 2 x 30
  assert.equal(P.freshness(snap('2026-11-25T11:50:00Z', '2026-11-22T09:00:00Z'), null, 30, NOW).level, 'amber');   // 3 days
  assert.equal(P.freshness(snap('2026-11-25T11:50:00Z', '2026-11-10T09:00:00Z'), null, 30, NOW).level, 'red');     // 15 days
  assert.equal(P.freshness(snap('2026-11-15T11:50:00Z', '2026-11-25T09:00:00Z'), null, 30, NOW).level, 'red');
  assert.equal(P.freshness(snap('2026-11-25T11:50:00Z', '2026-11-25T09:00:00Z'), { ok: false }, 30, NOW).level, 'red');
  assert.equal(P.freshness(snap('2026-11-25T11:50:00Z', '2026-11-25T09:00:00Z'), { ok: false, dryRun: true }, 30, NOW).level, 'green');
  const f = P.freshness(snap('2026-11-25T11:48:00Z', '2026-11-25T09:00:00Z'), null, 30, NOW);
  assert.equal(f.checkedAgeMin, 12); assert.equal(f.newestReadingAgeHours, 3);
  assert.equal(P.describeState({ enabled: false }).banner.text, 'Live performance is switched off. Ask the admin to set the sheet.');
});

/* ---------- cell and id helpers ---------- */
test('date cells: zero-based month, optional time, junk is null; counts: unread rule', () => {
  assert.equal(P.cellDate({ v: 'Date(2026,10,24)' }).toISOString(), '2026-11-24T00:00:00.000Z');
  assert.equal(P.cellDate({ v: 'Date(2026,0,5,9,5,7)' }).toISOString(), '2026-01-05T09:05:07.000Z');
  assert.equal(P.cellDate({ v: 'soon' }), null); assert.equal(P.cellDate(null), null);
  assert.deepEqual(P.readCount({ v: 0 }), { value: null, unread: true });
  assert.deepEqual(P.readCount({ v: '1,234' }), { value: 1234, unread: false });
  assert.deepEqual(P.readCount(null), { value: null, unread: true });
});

test('platformPostIdOf is the same logic as the dashboard helper in src/model/db.js', () => {
  const src = fs.readFileSync(ROOT + 'src/model/db.js', 'utf8');
  const a = src.indexOf('export function platformPostIdOf'); const b = src.indexOf('\n}\n', a);
  assert.ok(a > 0 && b > a);
  const theirs = new Function('return (' + src.slice(a, b + 2).replace('export ', '') + ');')();
  ['https://www.instagram.com/reel/AAA1/?igsh=1', 'https://instagram.com/p/X-y_1', 'https://www.tiktok.com/@a.b/video/123?x=1',
    'https://youtu.be/abc?t=1', '', '  ', 'https://example.com/a#b'].forEach((u) => assert.equal(P.platformPostIdOf(u), theirs(u), u));
});

test('gviz wrapper parsing', () => {
  assert.deepEqual(P.parseGviz('/*O_o*/\ngoogle.visualization.Query.setResponse({"status":"ok","table":{"cols":[],"rows":[]}});').status, 'ok');
  assert.throws(() => P.parseGviz('<!doctype html><title>Sign in</title>'), (e) => e.code === 'not-shared');
  assert.throws(() => P.parseGviz('garbage'), (e) => e.code === 'bad-response');
});

/* ---------- Mongo store (own collections, one-write swap) ---------- */
test('mongo store: snapshot swapped with ONE replaceOne, run log capped at 30, matches in their own collection', async () => {
  const calls = [];
  const docs = {};
  const client = { db: (name) => ({ collection: (c) => ({
    findOne: async (q) => docs[c + ':' + q._id] || null,
    replaceOne: async (q, d, o) => { calls.push(['replaceOne', c, o]); docs[c + ':' + q._id] = d; },
    updateOne: async (q, u, o) => { calls.push(['updateOne', c, u]); const cur = docs[c + ':' + q._id] || { _id: q._id }; Object.assign(cur, u.$set || {});
      if (u.$push) { cur.runs = (cur.runs || []).concat(u.$push.runs.$each).slice(u.$push.runs.$slice); } docs[c + ':' + q._id] = cur; }
  }) }) };
  const st = P.makeMongoStore(async () => client, 'testdb');
  await st.writeSnapshot({ checkedAt: 'x', posts: [] });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'replaceOne'); assert.equal(calls[0][1], 'perf_snapshot'); assert.equal(calls[0][2].upsert, true);
  assert.deepEqual(await st.readSnapshot(), { checkedAt: 'x', posts: [] });
  for (let i = 0; i < 35; i++) await st.appendLog({ i });
  const log = await st.readLog();
  assert.equal(log.runs.length, 30); assert.equal(log.last.i, 34);
  await st.writeMatches([{ sheetCampaignId: 'a', dashboardCampaignId: 'b' }]);
  assert.deepEqual(await st.readMatches(), [{ sheetCampaignId: 'a', dashboardCampaignId: 'b' }]);
  assert.ok(calls.every((c) => ['perf_snapshot', 'perf_sync_log', 'perf_match'].includes(c[1])));
  const noDb = P.makeMongoStore(async () => null, 'testdb');
  await assert.rejects(() => noDb.readSnapshot());
});

/* ---------- routes ---------- */
function realRequireStaff() {
  const src = fs.readFileSync(ROOT + 'server.js', 'utf8');
  const a = src.indexOf('function requireStaff(handler) {');
  const b = src.indexOf('\n}\n', a);
  assert.ok(a > 0 && b > a, 'requireStaff found in server.js');
  const loadSession = async (req) => { const e = req.headers['x-test-user']; return e ? { email: e } : null; };
  return new Function('loadSession', 'auth', 'STAFF_EMAILS', 'console', 'return (' + src.slice(a, b + 2) + ');')(
    loadSession, require('../server/auth.js'), ['staff@example.invalid'], { error() {}, log() {} });
}
async function withRoutes(get, fn) {
  const express = require('express');
  const app = express(); app.use(express.json());
  P.registerRoutes(app, realRequireStaff(), get);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = (method, p, user, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = Object.assign({}, user ? { 'x-test-user': user } : {}, data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {});
    const r = http.request({ host: '127.0.0.1', port: srv.address().port, path: p, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, text: b, json: b ? JSON.parse(b) : null }));
    });
    r.on('error', reject); r.end(data);
  });
  try { await fn(call); } finally { srv.close(); }
}
const STAFF = 'staff@example.invalid';
const ROUTES = [['GET', '/api/perf/status'], ['GET', '/api/perf/snapshot'], ['POST', '/api/perf/refresh'], ['POST', '/api/perf/match']];

test('routes are staff only: 401 with no session, 403 for a signed-in non-staff, in BOTH the on and off states', async () => {
  const on = job(makeSheet(fixtureTabs()));
  for (const get of [() => ({ perf: on.perf, off: '', cfg: { intervalMin: 30, maxRows: 5000, dryRun: false } }), () => ({ perf: null, off: 'PERF_SHEET_ID is not set', cfg: {} })]) {
    await withRoutes(get, async (call) => {
      for (const [m, p] of ROUTES) {
        assert.equal((await call(m, p, null, {})).status, 401, m + ' ' + p);
        assert.equal((await call(m, p, 'creator@example.invalid', {})).status, 403, m + ' ' + p);
      }
    });
  }
  assert.equal(on.store.st.snapshot, null, 'no anonymous request caused a read');
});

test('flag off: every route answers 503 for staff with the env var NAME as the reason', async () => {
  await withRoutes(() => ({ perf: null, off: 'PERF_SHEET_ID is not set', cfg: {} }), async (call) => {
    for (const [m, p] of ROUTES) {
      const r = await call(m, p, STAFF, {});
      assert.equal(r.status, 503, p); assert.equal(r.json.reason, 'PERF_SHEET_ID is not set'); assert.equal(r.json.state, 'off');
    }
  });
});

test('refresh: 1 per 5 minutes (429 with retryAfterSec), dryRun honoured, a request cannot turn a dry run off', async () => {
  const sheet = makeSheet(fixtureTabs());
  const j = job(sheet);
  const cfg = { intervalMin: 30, maxRows: 5000, dryRun: false };
  await withRoutes(() => ({ perf: j.perf, off: '', cfg }), async (call) => {
    const a = await call('POST', '/api/perf/refresh', STAFF, { dryRun: true });
    assert.equal(a.status, 200); assert.equal(a.json.run.dryRun, true); assert.equal(j.store.st.snapshot, null);
    const b = await call('POST', '/api/perf/refresh', STAFF, {});
    assert.equal(b.status, 429); assert.ok(b.json.retryAfterSec > 0 && b.json.retryAfterSec <= 300);
    j.clk.advance(4 * 60000);
    assert.equal((await call('POST', '/api/perf/refresh', STAFF, {})).status, 429);
    j.clk.advance(61000);
    const c = await call('POST', '/api/perf/refresh', STAFF, {});
    assert.equal(c.status, 200); assert.equal(c.json.run.dryRun, false); assert.ok(j.store.st.snapshot);
  });
  const envDry = job(makeSheet(fixtureTabs()), { dryRun: true });
  await withRoutes(() => ({ perf: envDry.perf, off: '', cfg: { intervalMin: 30, maxRows: 5000, dryRun: true } }), async (call) => {
    const r = await call('POST', '/api/perf/refresh', STAFF, { dryRun: false });
    assert.equal(r.json.run.dryRun, true, 'the request cannot override the env dry run');
    assert.equal(envDry.store.st.snapshot, null);
  });
});

test('status and snapshot routes: shapes, banner, unmatched list; match route validates and re-joins; no sentinel and no sheet id in any response', async () => {
  const j = job(makeSheet(fixtureTabs()));
  const cfg = { intervalMin: 30, maxRows: 5000, dryRun: false };
  const bodies = [];
  await withRoutes(() => ({ perf: j.perf, off: '', cfg }), async (call) => {
    let st = await call('GET', '/api/perf/status', STAFF); bodies.push(st.text);
    assert.equal(st.json.state, 'waiting'); assert.equal(st.json.counts, null);
    let sn = await call('GET', '/api/perf/snapshot', STAFF); bodies.push(sn.text);
    assert.equal(sn.json.snapshot, null);
    assert.equal((await call('POST', '/api/perf/match', STAFF, { sheetCampaignId: 'c3', sheetOnly: true })).status, 409);
    await j.perf.refresh({});
    st = await call('GET', '/api/perf/status', STAFF); bodies.push(st.text);
    assert.equal(st.json.state, 'ok'); assert.equal(st.json.counts.posts, 6); assert.equal(st.json.unmatched.length, 5);
    assert.equal(st.json.freshness.level, 'green'); assert.equal(st.json.checkedAt, '2026-11-25T10:00:00.000Z');
    assert.equal(st.json.intervalMin, 30);
    assert.ok(!('posts' in st.json), 'status carries counts, not rows');
    sn = await call('GET', '/api/perf/snapshot', STAFF); bodies.push(sn.text);
    assert.equal(sn.json.snapshot.posts.length, 6); assert.equal(sn.json.freshness.level, 'green');
    assert.equal((await call('POST', '/api/perf/match', STAFF, {})).status, 400);
    assert.equal((await call('POST', '/api/perf/match', STAFF, { sheetCampaignId: 'c3', dashboardCampaignId: 'nope' })).status, 400);
    assert.equal((await call('POST', '/api/perf/match', STAFF, { sheetCampaignId: 'zzz', sheetOnly: true })).status, 404);
    assert.equal((await call('POST', '/api/perf/match', STAFF, { sheetCampaignId: 'c3', dashboardCampaignId: 'x'.repeat(200) })).status, 400);
    const m = await call('POST', '/api/perf/match', STAFF, { sheetCampaignId: 'c3', dashboardCampaignId: 'dX' }); bodies.push(m.text);
    assert.equal(m.status, 200); assert.equal(m.json.match.state, 'matched');
    st = await call('GET', '/api/perf/status', STAFF); bodies.push(st.text);
    assert.equal(st.json.unmatched.length, 4);
  });
  bodies.forEach((t) => { SENTINELS.forEach((x) => assert.ok(!t.includes(x))); assert.ok(!t.includes(FAKE_ID)); });
});

/* ---------- the real server process ---------- */
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const httpJson = (port, method, p, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
    let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }));
  });
  r.on('error', reject); r.end(data);
});
async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(port) }, env), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('did not start: ' + out)), 15000);
    child.stdout.on('data', (d) => { out += d; if (out.includes('VIVELY app listening on port')) { clearTimeout(t); resolve(); } });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', () => reject(new Error('exited early: ' + out)));
  });
  return { port, child, output: () => out };
}

test('real server, flag unset: nothing starts, nothing is said, routes refuse an anonymous caller', async () => {
  const srv = await startServer({});
  try {
    assert.ok(!/performance sync/i.test(srv.output()));
    for (const [m, p] of ROUTES) assert.equal((await httpJson(srv.port, m, p, {})).status, 401, p);
  } finally { srv.child.kill(); }
});

test('real server, flag set (fake id, unreachable database): timers start, the id is never printed, a bad id keeps it off', async () => {
  const srv = await startServer({ PERF_SHEET_ID: FAKE_ID, MONGODB_URI: 'mongodb://127.0.0.1:1/never', PERF_SYNC_DRY_RUN: '1' });
  try {
    assert.match(srv.output(), /Performance sync: ON, every 30 min \(dry run/);
    assert.ok(!srv.output().includes(FAKE_ID));
    assert.equal((await httpJson(srv.port, 'GET', '/api/perf/status')).status, 401);
  } finally { srv.child.kill(); }
  const off = await startServer({ PERF_SHEET_ID: 'bad id', MONGODB_URI: 'mongodb://127.0.0.1:1/never' });
  try {
    assert.match(off.output(), /Performance sync stays off: PERF_SHEET_ID is not a Google Sheet id/);
    assert.ok(!/Performance sync: ON/.test(off.output()));
  } finally { off.child.kill(); }
});

test('wiring: off unless configured, first tick after boot, interval unref, only its own collections, no request-supplied sheet id', () => {
  const src = fs.readFileSync(ROOT + 'server.js', 'utf8');
  assert.match(src, /perfSyncLib\.registerRoutes\(app, requireStaff, /);
  assert.match(src, /setTimeout\(perfTick, 45000\)\.unref\(\)/);
  assert.match(src, /setInterval\(perfTick, perfCfg\.intervalMs\)\.unref\(\)/);
  assert.match(src, /if \(!perfOff\) \{\s*perfSync = perfSyncLib\.createPerfSync/);
  const lib = fs.readFileSync(ROOT + 'server/perf-sync.js', 'utf8');
  assert.ok(!/req\.(query|body|params)[^;]*sheet(Id)?\b(?!Campaign)/i.test(lib.replace(/sheetCampaignId/g, '')), 'no route reads a sheet id from the request');
  const cols = [...lib.matchAll(/col\("([a-z_]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(cols)].sort(), ['perf_match', 'perf_snapshot', 'perf_sync_log']);
  assert.ok(!/insertOne|deleteOne|saveWorkspace|\.collection\("workspace/.test(lib), 'never writes the workspace');
});
