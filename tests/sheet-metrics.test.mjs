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
  SM_CONTENT_ALIASES, SM_CREATOR_ALIASES
} from '../src/sync/sheetMetrics.js';
import { DB } from '../src/model/db.js';

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
  const m = guessSheetColumns(['Post URL', 'URL'], SM_CONTENT_ALIASES);
  assert.equal(m.postUrl, 'Post URL');
});

/* ---- planning and applying, against a real DB -------------------------- */

function seed() {
  DB.creators.length = 0; DB.campaigns.length = 0; DB.participants.length = 0; DB.socialContent.length = 0;
  DB.creators.push(
    { id: 'cr1', handle: '@minji', name: 'Minji', platform: 'Instagram',
      followers: 12000, er: 3.1, avgViews: 8000, categories: [], country: '', campaignIds: ['cp1'] },
    { id: 'cr2', handle: '@jiwoo', name: 'Jiwoo', platform: 'Instagram',
      followers: 0, er: 0, avgViews: 0, categories: ['Beauty'], country: 'Korea', campaignIds: [] }
  );
  DB.campaigns.push({ id: 'cp1', brand: 'JAIMDANG' });
  DB.participants.push({ id: 'pt1', campaignId: 'cp1', creatorId: 'cr1', stage: 'live' });
  DB.socialContent.push({
    id: 'sc1', platform: 'Instagram', platformPostId: 'ig_ABC123',
    postUrl: 'https://www.instagram.com/reel/ABC123/', url: 'https://www.instagram.com/reel/ABC123/',
    views: 5000, likes: 400, comments: 20, shares: 0, saves: 0, reach: 0,
    publishedAt: '', dataSource: 'manual', lastScrapedAt: null
  });
}

const rows = (header, ...body) => [header, ...body];

test('a post is matched on its id however the URL is spelled', () => {
  seed();
  const plan = planSheetContent(
    rows(['Post URL', 'Views'], ['https://instagram.com/reel/ABC123?igsh=xyz', '9000']),
    { postUrl: 'Post URL', views: 'Views' }, {});
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].by, 'post id from URL');
  assert.deepEqual(plan.updates[0].changes, [{ field: 'views', from: 5000, to: 9000 }]);
});

test('a blank metric column leaves the stored figure alone', () => {
  seed();
  const plan = planSheetContent(
    rows(['Post URL', 'Views', 'Likes'], ['https://www.instagram.com/reel/ABC123/', '', '0']),
    { postUrl: 'Post URL', views: 'Views', likes: 'Likes' }, {});
  /* views blank and likes zero: neither may overwrite 5000 and 400 */
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(DB.socialContent[0].views, 5000);
  assert.equal(DB.socialContent[0].likes, 400);
});

test('a post not in the library is reported, never created', () => {
  seed();
  const before = DB.socialContent.length;
  const plan = planSheetContent(
    rows(['Post URL', 'Views'], ['https://www.instagram.com/reel/NOTHERE/', '900']),
    { postUrl: 'Post URL', views: 'Views' }, {});
  assert.equal(plan.unmatched.length, 1);
  assert.equal(plan.updates.length, 0);
  applySheetContent(plan);
  assert.equal(DB.socialContent.length, before, 'a content row was created');
});

test('applying a content plan stamps provenance and nothing else moves', () => {
  seed();
  const campaigns = JSON.stringify(DB.campaigns), parts = JSON.stringify(DB.participants);
  const plan = planSheetContent(
    rows(['Post URL', 'Views', 'Scraped'], ['https://www.instagram.com/reel/ABC123/', '9000', '2026-09-18']),
    { postUrl: 'Post URL', views: 'Views', scrapedAt: 'Scraped' }, {});
  assert.equal(applySheetContent(plan), 1);
  const c = DB.socialContent[0];
  assert.equal(c.views, 9000);
  assert.equal(c.dataSource, 'google_sheet');
  assert.equal(c.lastScrapedAt, '2026-09-18');
  assert.equal(c.organicViews, 9000, 'views with no split should read as organic');
  assert.equal(JSON.stringify(DB.campaigns), campaigns);
  assert.equal(JSON.stringify(DB.participants), parts, 'campaign membership moved');
});

test('a campaign column on a row changes no membership', () => {
  seed();
  const plan = planSheetContent(
    rows(['Post URL', 'Views', 'Campaign'], ['https://www.instagram.com/reel/ABC123/', '9000', 'SOME OTHER BRAND']),
    { postUrl: 'Post URL', views: 'Views', campaign: 'Campaign' }, {});
  applySheetContent(plan);
  assert.equal(DB.participants[0].campaignId, 'cp1');
  assert.equal(DB.creators[0].campaignIds[0], 'cp1');
});

test('creators are matched on a normalised handle, including a profile URL', () => {
  seed();
  const plan = planSheetCreators(
    rows(['Profile', 'Followers'], ['https://www.instagram.com/MINJI/', '15000']),
    { handle: 'Profile', followers: 'Followers' }, {});
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].cr.id, 'cr1');
});

test('an unknown handle never becomes a creator', () => {
  seed();
  const before = DB.creators.length;
  const plan = planSheetCreators(
    rows(['Profile', 'Followers'], ['@someone_new', '15000']),
    { handle: 'Profile', followers: 'Followers' }, {});
  assert.equal(plan.unmatched.length, 1);
  applySheetCreators(plan);
  assert.equal(DB.creators.length, before, 'a creator was created from the Sheet');
});

test('country and category fill a blank and never overwrite a choice', () => {
  seed();
  const plan = planSheetCreators(
    rows(['Profile', 'Country', 'Category'],
         ['@minji', 'Japan', 'Food'],          /* cr1: both blank -> filled */
         ['@jiwoo', 'Thailand', 'Fitness']),   /* cr2: both set   -> untouched */
    { handle: 'Profile', country: 'Country', category: 'Category' }, {});
  applySheetCreators(plan);
  assert.equal(DB.creators[0].country, 'Japan');
  assert.deepEqual(DB.creators[0].categories, ['Food']);
  assert.equal(DB.creators[1].country, 'Korea', 'overwrote a country already set');
  assert.deepEqual(DB.creators[1].categories, ['Beauty'], 'overwrote a category already set');
});

test('profile metrics land with provenance, and the Vively side is untouched', () => {
  seed();
  const plan = planSheetCreators(
    rows(['Profile', 'Followers', 'ER', 'Avg Views', 'Avg Likes', 'Avg Comments', 'Scraped'],
         ['@minji', '15000', '0.052', '11000', '900', '40', '2026-09-18']),
    { handle: 'Profile', followers: 'Followers', er: 'ER', avgViews: 'Avg Views',
      avgLikes: 'Avg Likes', avgComments: 'Avg Comments', scrapedAt: 'Scraped' },
    { erUnit: 'decimal' });
  applySheetCreators(plan);
  const c = DB.creators[0];
  assert.equal(c.followers, 15000);
  assert.equal(c.er, 5.2);
  assert.equal(c.avgLikes, 900);
  assert.equal(c.avgComments, 40);
  assert.equal(c.metricsSource, 'google_sheet');
  assert.equal(c.metricsSyncedAt, '2026-09-18');
  /* the Vively side is derived from participants and content and must not
     be written from a scraper Sheet */
  assert.deepEqual(c.campaignIds, ['cp1']);
  assert.equal(c.flag, undefined, 'the Sheet touched creator status');
});

test('a row with no post reference and a row with no handle are skipped, not guessed', () => {
  seed();
  const c = planSheetContent(rows(['Post URL', 'Views'], ['', '900']), { postUrl: 'Post URL', views: 'Views' }, {});
  assert.equal(c.skipped.length, 1);
  assert.equal(c.updates.length, 0);
  const k = planSheetCreators(rows(['Profile', 'Followers'], ['', '900']), { handle: 'Profile', followers: 'Followers' }, {});
  assert.equal(k.skipped.length, 1);
  assert.equal(k.updates.length, 0);
});
