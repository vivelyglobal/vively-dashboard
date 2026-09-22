/* The read-only Sheet metrics import.

   The rules that matter here are all about what it must NOT do: never
   turn a real figure into a blank, never invent a creator, never touch
   who is on which campaign. Each of those is a line in this file rather
   than a promise in a comment. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsvLoose, sheetCsvUrl, guessSheetColumns, smMetric, smEngagement, smDate,
  planSheetContent, planSheetCreators, applySheetContent, applySheetCreators,
  SM_CREATOR_ALIASES, SM_CONTENT_DEFAULT_MAP, smInfluencerKind, smPostId, smSuggestCampaign,
  SM, discoverSheetTabs, fetchSheetTab, dryRunSheetMetrics
} from '../src/sync/sheetMetrics.js';
import { DB, byCampaign } from '../src/model/db.js';

/* ---- reading ---------------------------------------------------------- */

test('a caption with a line break does not tear the row in two', () => {
  /* lib/csv.js splits on newlines before it reads quotes and loses the
     columns after the caption. This is why this module has its own. */
  const csv = 'url,caption,views\nhttps://x/1,"line one\nline two",100';
  assert.deepEqual(parseCsvLoose(csv), [
    ['url', 'caption', 'views'],
    ['https://x/1', 'line one\nline two', '100']
  ]);
});

test('doubled quotes inside a cell survive', () => {
  assert.deepEqual(parseCsvLoose('a,b\n1,"he said ""hi"""'), [['a', 'b'], ['1', 'he said "hi"']]);
});

test('a CSV endpoint is built from any spelling of a Sheet link', () => {
  const id = '1AbC-dEf';
  assert.match(sheetCsvUrl('https://docs.google.com/spreadsheets/d/' + id + '/edit#gid=0', '77'),
    /\/spreadsheets\/d\/1AbC-dEf\/export\?format=csv&gid=77$/);
  assert.match(sheetCsvUrl('https://docs.google.com/spreadsheets/d/e/2PACX-xyz/pubhtml'),
    /\/d\/e\/2PACX-xyz\/pub\?output=csv$/);
  assert.equal(sheetCsvUrl(''), '');
});

/* ---- values ----------------------------------------------------------- */

test('an empty cell never becomes a zero', () => {
  for (const blank of ['', null, undefined, '  ', '-', 'n/a', 'null'])
    assert.equal(smMetric(blank), null, 'took ' + JSON.stringify(blank) + ' as a number');
});

test('a literal zero is treated as blank by default, and taken when asked', () => {
  assert.equal(smMetric('0'), null);
  assert.equal(smMetric('0', false), 0);
});

test('the shapes a scraper writes numbers in', () => {
  assert.equal(smMetric('12,300'), 12300);
  assert.equal(smMetric('3.3만'), 33000);
  assert.equal(smMetric('1.2k'), 1200);
  assert.equal(smMetric('2M'), 2000000);
});

test('engagement rate is converted by the unit chosen, never guessed', () => {
  assert.equal(smEngagement('4.2', 'percent'), 4.2);
  assert.equal(smEngagement('4.2%', 'percent'), 4.2);
  assert.equal(smEngagement('0.042', 'decimal'), 4.2);
  /* the same cell read the other way would be a hundredfold error, which
     is exactly why the operator states the unit */
  assert.equal(smEngagement('0.042', 'percent'), 0.04);
  assert.equal(smEngagement('', 'percent'), null);
  assert.equal(smEngagement('250', 'percent'), null, 'accepted an impossible rate');
});

test('dates are read in the shapes a Sheet actually produces', () => {
  assert.equal(smDate('2026-09-14'), '2026-09-14');
  assert.equal(smDate('2026/9/4'), '2026-09-04');
  assert.equal(smDate(45914), '2025-09-14');          /* Google serial */
  assert.equal(smDate(1789808000), '2026-09-19');      /* epoch seconds */
  assert.equal(smDate(1789808000000), '2026-09-19');   /* epoch millis */
  assert.equal(smDate(new Date('2026-09-14T00:00:00Z')), '2026-09-14');
});

test('an unreadable date is null, so the row is kept and the stamp left alone', () => {
  for (const junk of ['next tuesday-ish', 'rubbish', '', null]) assert.equal(smDate(junk), null);
});

/* ---- mapping ---------------------------------------------------------- */

test('columns are guessed without one field stealing another\'s column', () => {
  const headers = ['Profile', 'Followers', 'Avg Views', 'Views', 'Engagement Rate', 'Avg Likes'];
  const m = guessSheetColumns(headers, SM_CREATOR_ALIASES);
  assert.equal(m.avgViews, 'Avg Views');
  assert.equal(m.followers, 'Followers');
  assert.equal(m.er, 'Engagement Rate');
  assert.equal(m.avgLikes, 'Avg Likes');
});

test('a column matched exactly wins over one matched loosely', () => {
  const m = guessSheetColumns(['Avg Views', 'Views'], { views: ['views'], avgViews: ['avg views'] });
  assert.equal(m.views, 'Views');
  assert.equal(m.avgViews, 'Avg Views');
});


/* ---- the master Sheet: one tab per campaign ----------------------------

   Rows below are headed exactly as the campaign tabs are, and read with
   the default map, so a renamed column in the importer fails here. */

const TAB_HEADER = ['deliverable_id', 'ci_id', 'influencer_id', 'type', 'post_url', 'posted_date',
  'likes', 'comments', 'views', 'last_scraped_at', 'notes', 'cpe_expected', 'cpe_actual',
  'cpv_expected', 'cpv_actual', 'shares', 'saves', 'reposts', 'post_er'];

/* one row, from an object keyed by column name; anything not given is blank */
const row = (o) => TAB_HEADER.map((h) => (o[h] == null ? '' : String(o[h])));
const tab = (...objs) => [TAB_HEADER, ...objs.map(row)];

function seed() {
  DB.creators.length = 0; DB.campaigns.length = 0; DB.participants.length = 0; DB.socialContent.length = 0;
  Object.keys(byCampaign).forEach((k) => delete byCampaign[k]);
  DB.creators.push(
    { id: 'cr1', handle: '@minji', name: 'Minji', platform: 'Instagram', followers: 12000, er: 3.1, avgViews: 8000 },
    { id: 'cr2', handle: '@jiwoo', name: 'Jiwoo', platform: 'Instagram', followers: 5000, er: 2.0, avgViews: 3000 },
    { id: 'cr3', handle: '@seoyeon', name: 'Seoyeon', platform: 'Instagram', followers: 900, er: 4.0, avgViews: 700 }
  );
  DB.campaigns.push({ id: 'cpK', brand: 'KOWORK', name: '' }, { id: 'cpJ', brand: 'JAIMDANG', name: 'Autumn' });
  DB.campaigns.forEach((c) => (byCampaign[c.id] = c));
  DB.participants.push(
    { id: 'ptK1', campaignId: 'cpK', creatorId: 'cr1', stage: 'live' },   /* has a post already */
    { id: 'ptK2', campaignId: 'cpK', creatorId: 'cr2', stage: 'live' }    /* no post yet */
    /* cr3 is on no roster */
  );
  const sc1 = {
    id: 'sc1', participantId: 'ptK1', campaignId: 'cpK', creatorId: 'cr1', platform: 'Instagram',
    platformPostId: 'ig_ABC123', postUrl: 'https://www.instagram.com/reel/ABC123/', url: 'https://www.instagram.com/reel/ABC123/',
    views: 5000, likes: 400, comments: 20, shares: 0, saves: 0, publishedAt: '2026-09-01',
    dataSource: 'manual', lastScrapedAt: '2026-09-10'
  };
  DB.socialContent.push(sc1);
  DB.participants[0].content = sc1;
}

const OPTS = { tab: 'KOWORK', campaignId: 'cpK', skipZero: true, erUnit: 'percent', allowCreate: true };
const plan = (rows, o) => planSheetContent(rows, SM_CONTENT_DEFAULT_MAP, Object.assign({}, OPTS, o || {}));
const why = (p) => p.unmatched.map((u) => u.why);

test('an existing post is found by the shortcode in post_url, however the link is spelled', () => {
  seed();
  const p = plan(tab({ post_url: 'https://instagram.com/p/ABC123?igsh=xyz', views: 9000, influencer_id: 'minji' }));
  assert.equal(p.updates.length, 1);
  assert.equal(p.updates[0].by, 'post id');
  assert.deepEqual(p.updates[0].changes.find((c) => c.field === 'views'), { field: 'views', from: 5000, to: 9000 });
});

test('ci_id is never taken for a post id', () => {
  seed();
  /* ci_id holds the very shortcode of sc1; post_url points elsewhere */
  const p = plan(tab({ ci_id: 'ABC123', post_url: 'https://www.instagram.com/reel/ZZZ999/', views: 10, influencer_id: 'jiwoo' }));
  assert.equal(p.updates.length, 0, 'ci_id matched an existing post');
  assert.equal(p.creates.length, 1);
  assert.equal(p.creates[0].postId, 'ig_ZZZ999');
});

test('the campaign comes from the tab mapping; a post filed elsewhere is flagged and never moved', () => {
  seed();
  const p = plan(tab({ post_url: 'https://www.instagram.com/reel/ABC123/', views: 9000 }), { tab: 'JAIMDANG', campaignId: 'cpJ' });
  assert.equal(p.campaignName, 'JAIMDANG — Autumn');
  assert.equal(p.conflicts.length, 1);
  assert.equal(p.updates.length, 1, 'its own numbers still update');
  applySheetContent(p);
  const sc = DB.socialContent[0];
  assert.equal(sc.views, 9000);
  assert.equal(sc.campaignId, 'cpK', 'the post was moved');
  assert.equal(sc.participantId, 'ptK1');
});

test('posted_date, last_scraped_at and the five metrics land where they belong', () => {
  seed();
  const p = plan(tab({ post_url: 'https://www.instagram.com/reel/ABC123/', posted_date: '2026-09-02',
    last_scraped_at: '2026-09-19', views: 9000, likes: 500, comments: 30, shares: 7, saves: 12, type: 'reel' }));
  applySheetContent(p);
  const sc = DB.socialContent[0];
  assert.deepEqual([sc.views, sc.likes, sc.comments, sc.shares, sc.saves], [9000, 500, 30, 7, 12]);
  assert.equal(sc.publishedAt, '2026-09-02');
  assert.equal(sc.lastScrapedAt, '2026-09-19');
  assert.equal(sc.format, 'Reel');
  assert.equal(sc.dataSource, 'google_sheet');
});

test('post_er stays on the post and never reaches the creator profile', () => {
  seed();
  const before = JSON.stringify(DB.creators);
  const p = plan(tab({ post_url: 'https://www.instagram.com/reel/ABC123/', post_er: '7.5' }));
  applySheetContent(p);
  assert.equal(DB.socialContent[0].postEr, 7.5);
  assert.equal(JSON.stringify(DB.creators), before, 'a creator profile changed');
});

test('reposts, CPE/CPV, notes and deliverable_id are kept as secondary fields', () => {
  seed();
  const p = plan(tab({ post_url: 'https://www.instagram.com/reel/ABC123/', reposts: 3, cpe_expected: '0.37',
    cpe_actual: '0.41', cpv_expected: '12', cpv_actual: '9.5', notes: 'boosted', deliverable_id: 'D-7' }));
  assert.ok(p.updates[0].changes.filter((c) => c.secondary).length >= 7);
  applySheetContent(p);
  const sc = DB.socialContent[0];
  assert.deepEqual([sc.reposts, sc.cpeExpected, sc.cpeActual, sc.cpvExpected, sc.cpvActual, sc.sheetNotes, sc.deliverableId],
    [3, 0.37, 0.41, 12, 9.5, 'boosted', 'D-7']);
});

test('blank and zero never overwrite a stored metric', () => {
  seed();
  const p = plan(tab({ post_url: 'https://www.instagram.com/reel/ABC123/', views: '', likes: '0', comments: '-' }));
  assert.equal(p.updates.length, 0);
  assert.equal(p.skipped[0].why, 'nothing new');
  applySheetContent(p);
  assert.equal(DB.socialContent[0].views, 5000);
  assert.equal(DB.socialContent[0].likes, 400);
  assert.equal(DB.socialContent[0].comments, 20);
});

test('an unreadable last_scraped_at leaves the stamp as it was', () => {
  seed();
  const p = plan(tab({ post_url: 'https://www.instagram.com/reel/ABC123/', views: 9000, last_scraped_at: 'yesterday-ish' }));
  applySheetContent(p);
  assert.equal(DB.socialContent[0].views, 9000);
  assert.equal(DB.socialContent[0].lastScrapedAt, '2026-09-10');
});

test('a new post for a rostered creator with no post is created and linked to the roster row', () => {
  seed();
  const p = plan(tab({ post_url: 'https://www.instagram.com/reel/NEW1/', influencer_id: '@Jiwoo', views: 1200, last_scraped_at: '2026-09-19' }));
  assert.equal(p.creates.length, 1);
  assert.equal(p.creates[0].linked, true);
  assert.deepEqual(applySheetContent(p), { updated: 0, created: 1 });
  const pt = DB.participants.find((x) => x.id === 'ptK2');
  assert.ok(pt.content, 'not linked');
  assert.equal(pt.content.platformPostId, 'ig_NEW1');
  assert.equal(pt.content.campaignId, 'cpK');
  assert.equal(pt.content.views, 1200);
  assert.equal(pt.content.lastScrapedAt, '2026-09-19');
  assert.equal(pt.content.dataSource, 'google_sheet');
});

test('a second post for a creator who already has one goes to the library, attributed but unlinked', () => {
  seed();
  const p = plan(tab({ post_url: 'https://www.instagram.com/reel/NEW2/', influencer_id: 'minji', views: 300 }));
  assert.equal(p.creates[0].linked, false);
  applySheetContent(p);
  const rec = DB.socialContent.find((c) => c.platformPostId === 'ig_NEW2');
  assert.equal(rec.participantId, '');
  assert.equal(rec.campaignId, 'cpK');
  assert.equal(rec.creatorId, 'cr1');
  assert.equal(DB.participants[0].content.id, 'sc1', 'the roster card was swapped');
});

test('two new posts for one creator make one linked post and one library post, never one merged', () => {
  seed();
  const p = plan(tab(
    { post_url: 'https://www.instagram.com/reel/NA/', influencer_id: 'jiwoo', views: 100 },
    { post_url: 'https://www.instagram.com/reel/NB/', influencer_id: 'jiwoo', views: 200 },
    { post_url: 'https://www.instagram.com/reel/NB/', influencer_id: 'jiwoo', views: 200 }));
  assert.deepEqual(p.creates.map((c) => c.linked), [true, false]);
  assert.equal(p.skipped[0].why, 'same post earlier on this tab');
  applySheetContent(p);
  const a = DB.socialContent.find((c) => c.platformPostId === 'ig_NA');
  const b = DB.socialContent.find((c) => c.platformPostId === 'ig_NB');
  assert.equal(a.views, 100);
  assert.equal(b.views, 200);
  assert.equal(DB.participants.find((x) => x.id === 'ptK2').content, a);
});

test('the linked-in-plan guard carries across tabs', () => {
  seed();
  const first = plan(tab({ post_url: 'https://www.instagram.com/reel/NA/', influencer_id: 'jiwoo' , views: 1 }));
  const second = plan(tab({ post_url: 'https://www.instagram.com/reel/NB/', influencer_id: 'jiwoo', views: 1 }),
    { linkedInPlan: first.linkedInPlan });
  assert.equal(second.creates[0].linked, false);
});

test('every condition for adding a post is enforced, and each refusal says which', () => {
  seed();
  const url = (s) => 'https://www.instagram.com/reel/' + s + '/';
  assert.deepEqual(why(plan(tab({ post_url: url('X1'), influencer_id: 'jiwoo' }), { allowCreate: false })),
    ['new post — adding posts is switched off']);
  assert.deepEqual(why(plan(tab({ post_url: 'https://www.instagram.com/jiwoo/', influencer_id: 'jiwoo' }))),
    ['post_url is not an Instagram or TikTok post link']);
  assert.deepEqual(why(plan(tab({ post_url: url('X2'), influencer_id: 'jiwoo' }), { campaignId: '' })),
    ['this tab is not mapped to a campaign']);
  assert.deepEqual(why(plan(tab({ post_url: url('X3'), influencer_id: 'jiwoo' }, { post_url: url('X4') }))),
    ['no influencer_id on the row']);
  assert.deepEqual(why(plan(tab({ post_url: url('X5'), influencer_id: 'jiwoo' }, { post_url: url('X6'), influencer_id: 'nobody' }))),
    ['creator not in the database']);
  assert.deepEqual(why(plan(tab({ post_url: url('X7'), influencer_id: 'seoyeon' }))),
    ['@seoyeon is not on the KOWORK roster']);
});

test('an influencer_id column of ids is not used to find creators', () => {
  seed();
  const p = plan(tab({ post_url: 'https://www.instagram.com/reel/Q1/', influencer_id: '17841400000000001' },
                     { post_url: 'https://www.instagram.com/reel/Q2/', influencer_id: '17841400000000002' }));
  assert.equal(p.influencer.kind, 'opaque');
  assert.equal(p.creates.length, 0);
  assert.ok(why(p).every((w) => w === 'influencer_id does not hold Instagram handles'));
});

test('influencer_id is judged from what it holds', () => {
  seed();
  assert.equal(smInfluencerKind(['@minji', 'https://instagram.com/jiwoo', 'someone']).kind, 'handle');
  assert.equal(smInfluencerKind(['INF-01', 'INF-02', 'minji']).kind, 'opaque');
  assert.equal(smInfluencerKind(['1001', '1002', 'minji']).kind, 'opaque');
  assert.equal(smInfluencerKind(['', ' ']).kind, 'empty');
});

test('smPostId accepts post links only', () => {
  assert.equal(smPostId('https://www.instagram.com/reel/ABC123/?igsh=1'), 'ig_ABC123');
  assert.equal(smPostId('https://www.tiktok.com/@minji/video/7412345678901234567'), 'tt_7412345678901234567');
  assert.equal(smPostId('https://www.instagram.com/minji/'), '');
  assert.equal(smPostId('not a link'), '');
  assert.equal(smPostId(''), '');
});

test('a tab name suggests the campaign of the same brand', () => {
  seed();
  assert.equal(smSuggestCampaign('KOWORK'), 'cpK');
  assert.equal(smSuggestCampaign('kowork '), 'cpK');
  assert.equal(smSuggestCampaign('Autumn'), 'cpJ');
  assert.equal(smSuggestCampaign('NOPE'), '');
});

test('an import never creates a creator or a campaign membership', () => {
  seed();
  const creators = JSON.stringify(DB.creators), campaigns = JSON.stringify(DB.campaigns);
  const roster = DB.participants.map((x) => x.id + x.campaignId + x.creatorId).join();
  const p = plan(tab(
    { post_url: 'https://www.instagram.com/reel/ABC123/', views: 9000 },
    { post_url: 'https://www.instagram.com/reel/N1/', influencer_id: 'jiwoo', views: 1 },
    { post_url: 'https://www.instagram.com/reel/N2/', influencer_id: 'seoyeon', views: 1 },
    { post_url: 'https://www.instagram.com/reel/N3/', influencer_id: 'ghost', views: 1 }));
  applySheetContent(p);
  assert.equal(JSON.stringify(DB.creators), creators);
  assert.equal(JSON.stringify(DB.campaigns), campaigns);
  assert.equal(DB.participants.map((x) => x.id + x.campaignId + x.creatorId).join(), roster);
  assert.equal(DB.socialContent.length, 2);
});

test('a plan re-checked at apply time does not duplicate a post that appeared meanwhile', () => {
  seed();
  const p = plan(tab({ post_url: 'https://www.instagram.com/reel/LATE/', influencer_id: 'minji', views: 1 }));
  DB.socialContent.push({ id: 'scX', platformPostId: 'ig_LATE', postUrl: 'https://www.instagram.com/reel/LATE/' });
  assert.deepEqual(applySheetContent(p), { updated: 0, created: 0 });
});

/* ---- the optional creator-profile tab -------------------------------- */

test('the creator tab updates profile metrics by handle and never creates a creator', () => {
  seed();
  const n = DB.creators.length;
  const p = planSheetCreators(
    [['Profile', 'Followers', 'ER'], ['https://instagram.com/Minji', '15000', '4.2'], ['@ghost', '99', '1']],
    { handle: 'Profile', followers: 'Followers', er: 'ER' }, { skipZero: true, erUnit: 'percent' });
  assert.equal(p.updates.length, 1);
  assert.equal(p.unmatched.length, 1);
  applySheetCreators(p);
  assert.equal(DB.creators.length, n);
  assert.equal(DB.creators[0].followers, 15000);
  assert.equal(DB.creators[0].er, 4.2);
});

/* ---- reading through the server -----------------------------------------

   The browser never talks to Google: it asks /api/sheet-metrics/*. These
   stand in for that server and check what the page asks it and what it
   does with the answer. */

function stubServer(routes) {
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const u = new URL(String(url), 'http://x');
    const r = routes(u) || { status: 404, body: { ok: false, error: 'no route' } };
    return { status: r.status || 200, ok: (r.status || 200) < 400, json: async () => r.body };
  };
  return asked;
}
const EDIT_URL = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0';

test('Find tabs lists every tab and maps the ones whose name is a campaign', async () => {
  seed();
  SM.base = EDIT_URL;
  SM.contentTabs = [];
  const asked = stubServer((u) => u.pathname === '/api/sheet-metrics/tabs'
    ? { body: { ok: true, tabs: [{ gid: '0', name: 'README' }, { gid: '482910', name: 'KOWORK' }] } } : null);
  const r = await discoverSheetTabs();
  assert.deepEqual(r, { count: 2, added: 2 });
  assert.equal(new URL(asked[0], 'http://x').searchParams.get('sheet'), EDIT_URL);
  assert.deepEqual(SM.contentTabs.map((t) => [t.name, t.gid, t.campaignId, t.on]),
    [['README', '0', '', false], ['KOWORK', '482910', 'cpK', true]]);
});

test('finding tabs again keeps every choice already made', async () => {
  seed();
  SM.base = EDIT_URL;
  SM.contentTabs = [
    { name: 'KOWORK', gid: '482910', campaignId: 'cpJ', on: false, found: true },  /* deliberately remapped, off */
    { name: 'jaimdang', gid: '', campaignId: 'cpJ', on: true },                     /* added by hand, no gid */
    { name: 'OLD', gid: '9', campaignId: '', on: false, found: true }
  ];
  stubServer(() => ({ body: { ok: true, tabs: [
    { gid: '482910', name: 'KOWORK 2026' }, { gid: '1300', name: 'JAIMDANG' }] } }));
  const r = await discoverSheetTabs();
  assert.equal(r.added, 0);
  const [k, j, old] = SM.contentTabs;
  assert.deepEqual([k.name, k.campaignId, k.on], ['KOWORK 2026', 'cpJ', false], 'a rename lost the mapping');
  assert.deepEqual([j.gid, j.campaignId, j.on], ['1300', 'cpJ', true]);
  assert.equal(old.missing, true);
});

test('a tab is read by gid through the server, and the CSV comes back as rows', async () => {
  SM.base = EDIT_URL;
  const asked = stubServer((u) => u.pathname === '/api/sheet-metrics/csv'
    ? { body: { ok: true, csv: 'post_url,notes\nhttps://x/1,"a\nb"\n' } } : null);
  const rows = await fetchSheetTab({ gid: '482910', name: 'KOWORK' });
  const u = new URL(asked[0], 'http://x');
  assert.equal(u.searchParams.get('gid'), '482910');
  assert.equal(u.searchParams.get('name'), null, 'name sent although the gid was known');
  assert.deepEqual(rows, [['post_url', 'notes'], ['https://x/1', 'a\nb']]);
  await fetchSheetTab({ gid: '', name: 'KOWORK' });
  assert.equal(new URL(asked[1], 'http://x').searchParams.get('name'), 'KOWORK');
});

test('the server\'s explanation reaches the operator', async () => {
  SM.base = EDIT_URL;
  stubServer(() => ({ status: 403, body: { ok: false, error: 'Share → Anyone with the link → Viewer.' } }));
  await assert.rejects(fetchSheetTab({ gid: '1' }), /Anyone with the link/);
  stubServer(() => ({ status: 401, body: { error: 'Sign in' } }));
  await assert.rejects(fetchSheetTab({ gid: '1' }), /sign in again/);
});

test('reading with no tab switched on says so instead of showing zeroes', async () => {
  seed();
  SM.base = EDIT_URL;
  SM.contentTabs = [];
  let d = await dryRunSheetMetrics();
  assert.match(d.errors[0], /Find tabs/);
  SM.contentTabs = [{ name: 'KOWORK', gid: '1', campaignId: 'cpK', on: false }];
  d = await dryRunSheetMetrics();
  assert.match(d.errors[0], /tick the tabs/);
});

test('a switched-on tab is read end to end through the server', async () => {
  seed();
  SM.base = EDIT_URL;
  SM.creatorTab = { name: '', gid: '', on: false };
  SM.contentTabs = [{ name: 'KOWORK', gid: '482910', campaignId: 'cpK', on: true }];
  const csv = TAB_HEADER.join(',') + '\n' + row({ post_url: 'https://www.instagram.com/reel/ABC123/', views: 9000 }).join(',');
  stubServer((u) => (u.searchParams.get('gid') === '482910' ? { body: { ok: true, csv } } : null));
  const d = await dryRunSheetMetrics();
  assert.deepEqual(d.errors, []);
  assert.equal(d.tabs.length, 1);
  assert.equal(d.tabs[0].rowsRead, 1);
  assert.equal(d.tabs[0].updates.length, 1);
});
