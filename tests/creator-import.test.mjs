/* Importing a list of creators, and the marks a flagged creator carries.

   The two rules the importer exists to keep are the two tested hardest
   here: a creator already in the database is only ever filled in, never
   overwritten, and one handle never becomes two creators. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ciNumber, ciEngagement, ciHandle, ciFlag, guessCreatorColumns,
  planCreatorImport, applyCreatorPlan, CREATOR_IMPORT_FIELDS
} from '../src/views/creators.js';
import { flagMark, flagRowClass, flaggedOnRoster } from '../src/ui/html.js';
import { DB, byCreator, byCampaign } from '../src/model/db.js';

/* ---- reading what a spreadsheet actually contains -------------------- */

test('numbers survive commas, currency marks and K/M shorthand', () => {
  assert.equal(ciNumber('12,345'), 12345);
  assert.equal(ciNumber(' 1.2M '), 1200000);
  assert.equal(ciNumber('98K'), 98000);
  assert.equal(ciNumber('₩450,000'), 450000);
  assert.equal(ciNumber('3만'), 30000);
  assert.equal(ciNumber(8200), 8200);
});

test('a blank is blank and not zero — only a blank may be filled in later', () => {
  for (const v of ['', null, undefined, '  ', '-', 'n/a', 'N/A']) assert.equal(ciNumber(v), null, String(v));
  assert.equal(ciNumber('0'), 0);
});

test('an engagement rate is read as a percentage either way round', () => {
  assert.equal(ciEngagement('4.2'), 4.2);
  assert.equal(ciEngagement('4.2%'), 4.2);
  assert.equal(ciEngagement('0.042'), 4.2);
  assert.equal(ciEngagement(''), null);
  assert.equal(ciEngagement('470'), null, 'a number that cannot be a rate is refused');
});

test('a handle is found in a name, an @name or a profile link', () => {
  assert.equal(ciHandle('minji'), '@minji');
  assert.equal(ciHandle('@Minji'), '@Minji');
  assert.equal(ciHandle('https://www.instagram.com/minji/'), '@minji');
  assert.equal(ciHandle('https://www.instagram.com/minji?igsh=1'), '@minji');
  assert.equal(ciHandle('https://www.tiktok.com/@jiwoo'), '@jiwoo');
  assert.equal(ciHandle(''), '');
  assert.equal(ciHandle('Kim Minji (beauty)'), '', 'a sentence is not a handle');
});

test('a flag column is only believed when it plainly says one of our flags', () => {
  assert.equal(ciFlag('BLACKLIST'), 'blocked');
  assert.equal(ciFlag('do not use'), 'blocked');
  assert.equal(ciFlag('블랙리스트'), 'blocked');
  assert.equal(ciFlag('caution — late twice'), 'caution');
  assert.equal(ciFlag('주의'), 'caution');
  assert.equal(ciFlag('VIP'), 'preferred');
  assert.equal(ciFlag('ok'), '');
  assert.equal(ciFlag(''), '');
});

/* ---- guessing the columns -------------------------------------------- */

test('columns are guessed from headers in any order or language', () => {
  const m = guessCreatorColumns(['팔로워', 'Profile Handle', 'Engagement Rate', 'Avg Views', 'Country', 'Category']);
  assert.equal(m.followers, 0);
  assert.equal(m.handle, 1);
  assert.equal(m.er, 2);
  assert.equal(m.avgViews, 3);
  assert.equal(m.country, 4);
  assert.equal(m.categories, 5);
});

test('an exact header wins, so avg views never steals the views column', () => {
  const m = guessCreatorColumns(['Views', 'Avg Views', 'Handle']);
  assert.equal(m.avgViews, 1);
  assert.equal(m.handle, 2);
});

test('nothing recognisable leaves the field unmapped rather than guessed', () => {
  const m = guessCreatorColumns(['col a', 'col b']);
  assert.equal(m.handle, undefined);
  assert.deepEqual(Object.keys(m), []);
});

test('every mappable field is offered, and only the handle is required', () => {
  assert.deepEqual(CREATOR_IMPORT_FIELDS.filter((f) => f.req).map((f) => f.k), ['handle']);
  const keys = CREATOR_IMPORT_FIELDS.map((f) => f.k);
  ['handle', 'name', 'platform', 'followers', 'er', 'avgViews', 'country', 'categories',
   'rate', 'email', 'contact', 'notes', 'source', 'flag', 'flagReason'].forEach((k) => assert.ok(keys.includes(k), k));
});

/* ---- planning and applying, against a real database ------------------ */

function seed() {
  DB.creators.length = 0; DB.campaigns.length = 0; DB.participants.length = 0; DB.socialContent.length = 0;
  Object.keys(byCreator).forEach((k) => delete byCreator[k]);
  Object.keys(byCampaign).forEach((k) => delete byCampaign[k]);
  DB.creators.push(
    { id: 'cr1', handle: '@minji', name: 'Minji', platform: 'Instagram', followers: 12000, er: 3.1,
      avgViews: 8000, categories: ['Beauty'], country: 'Korea', rate: 300000, email: 'm@x.com',
      contact: '', notes: '', tags: [], source: 'Referral', tier: 'nano', flag: null, flagReason: '', languages: ['EN'] },
    { id: 'cr2', handle: '@jiwoo', name: '', platform: '', followers: 0, er: 0, avgViews: 0,
      categories: [], country: '', rate: 0, email: '', contact: '', notes: '', tags: [], source: '',
      tier: 'nano', flag: 'blocked', flagReason: 'ghosted a shipment', languages: ['EN'] }
  );
  DB.creators.forEach((c) => (byCreator[c.id] = c));
  DB.campaigns.push({ id: 'cpK', brand: 'KOWORK', name: '', status: 'live' });
  DB.campaigns.forEach((c) => (byCampaign[c.id] = c));
  DB.participants.push(
    { id: 'ptK1', campaignId: 'cpK', creatorId: 'cr1', stage: 'live' },
    { id: 'ptK2', campaignId: 'cpK', creatorId: 'cr2', stage: 'confirmed' }
  );
}

/* a sheet with deliberately odd headers and order */
const HEAD = ['Instagram', 'Full Name', '팔로워', 'Engagement Rate', 'Country', 'Category', 'Blacklist', 'Reason', 'Fee'];
const sheet = (...rows) => ({ fileName: 'list.xlsx', sheets: [], sheetIdx: 0, headers: HEAD,
  rows: [HEAD, ...rows], map: guessCreatorColumns(HEAD) });
const plan = (...rows) => planCreatorImport(sheet(...rows));

test('a creator the database has never seen is planned as new', () => {
  seed();
  const p = plan(['https://instagram.com/seoyeon', 'Seoyeon', '45,000', '5.1', 'Vietnam', 'Beauty, K-Food', '', '', '₩200,000']);
  assert.equal(p.creates.length, 1);
  assert.equal(p.fills.length, 0);
  const v = p.creates[0].v;
  assert.equal(v.handle, '@seoyeon');
  assert.equal(v.followers, 45000);
  assert.equal(v.er, 5.1);
  assert.deepEqual(v.categories, ['Beauty', 'K-Food']);
  assert.equal(v.rate, 200000);
});

test('an existing creator has empty fields filled and nothing else touched', () => {
  seed();
  const before = { ...byCreator.cr1 };
  const p = plan(['@minji', 'Kim Minji', '99,000', '9.9', 'Japan', 'Fashion', '', '', '900000']);
  assert.equal(p.creates.length, 0);
  assert.equal(p.fills.length, 1);
  const fields = p.fills[0].fills.map(([k]) => k);
  assert.deepEqual(fields, ['categories'], 'only the blank field should be offered: ' + fields.join());
  applyCreatorPlan(p, 'list.xlsx');
  const cr = byCreator.cr1;
  assert.equal(cr.followers, before.followers, 'followers were overwritten');
  assert.equal(cr.er, before.er, 'ER was overwritten');
  assert.equal(cr.name, 'Minji', 'the name was overwritten');
  assert.equal(cr.country, 'Korea', 'the country was overwritten');
  assert.equal(cr.rate, 300000, 'the rate was overwritten');
  assert.deepEqual(cr.categories, ['Beauty', 'Fashion'], 'a new category is added, never a replacement');
});

test('empty fields really are filled, and the tier follows the followers', () => {
  seed();
  applyCreatorPlan(plan(['@jiwoo', 'Jiwoo Park', '80,000', '2.5', 'Korea', 'Lifestyle', '', '', '150000']), 'list.xlsx');
  const cr = byCreator.cr2;
  assert.equal(cr.name, 'Jiwoo Park');
  assert.equal(cr.followers, 80000);
  assert.equal(cr.er, 2.5);
  assert.equal(cr.country, 'Korea');
  assert.equal(cr.tier, 'mid');
  assert.equal(cr.metricsSource, 'file_import');
  assert.ok(cr.metricsSyncedAt);
});

test('a file never clears or changes a flag somebody set here', () => {
  seed();
  applyCreatorPlan(plan(['@jiwoo', '', '', '', '', '', 'ok, fine now', 'they apologised', '']), 'list.xlsx');
  assert.equal(byCreator.cr2.flag, 'blocked', 'a file lifted a blacklist');
  assert.equal(byCreator.cr2.flagReason, 'ghosted a shipment');
});

test('a flag in the file is given to a creator who has none, with its reason', () => {
  seed();
  applyCreatorPlan(plan(['@minji', '', '', '', '', '', 'BLACKLIST', 'took payment, no post', '']), 'list.xlsx');
  assert.equal(byCreator.cr1.flag, 'blocked');
  assert.equal(byCreator.cr1.flagReason, 'took payment, no post');
  assert.ok(byCreator.cr1.flagAt);
});

test('a new creator can arrive already blacklisted', () => {
  seed();
  applyCreatorPlan(plan(['@dodgy', 'Dodgy', '1,000', '', '', '', 'do not use', 'chargeback', '']), 'list.xlsx');
  const cr = DB.creators.find((c) => c.handle === '@dodgy');
  assert.equal(cr.flag, 'blocked');
  assert.equal(cr.flagReason, 'chargeback');
});

test('one handle never becomes two creators, however it is spelled', () => {
  seed();
  const n = DB.creators.length;
  const p = plan(
    ['Minji', '', '', '', '', '', '', '', ''],
    ['https://www.instagram.com/MINJI/', '', '', '', '', '', '', '', ''],
    ['@newone', 'New', '2,000', '', '', '', '', '', ''],
    ['@newone', 'New again', '3,000', '', '', '', '', '', '']);
  assert.equal(p.creates.length, 1, 'the repeat inside the file should be skipped');
  assert.ok(p.skipped.some((s) => /same handle as row/.test(s.why)));
  applyCreatorPlan(p, 'list.xlsx');
  assert.equal(DB.creators.length, n + 1);
  assert.equal(DB.creators.filter((c) => c.handle.toLowerCase() === '@newone').length, 1);
});

test('a row with no readable handle is skipped and says why', () => {
  seed();
  const p = plan(['', 'No handle here', '5,000', '', '', '', '', '', ''],
                 ['Kim Minji (beauty)', '', '', '', '', '', '', '', '']);
  assert.equal(p.creates.length, 0);
  assert.equal(p.skipped.length, 2);
  assert.ok(p.skipped.every((s) => s.why === 'no handle in that row'));
});

test('with no handle column mapped, nothing is planned at all', () => {
  seed();
  const st = sheet(['@someone', '', '', '', '', '', '', '', '']);
  delete st.map.handle;
  const p = planCreatorImport(st);
  assert.equal(p.noHandleColumn, true);
  assert.equal(p.creates.length, 0);
});

test('an import never touches campaigns or rosters', () => {
  seed();
  const campaigns = JSON.stringify(DB.campaigns), parts = JSON.stringify(DB.participants);
  applyCreatorPlan(plan(
    ['@brandnew', 'Brand New', '7,000', '3', 'Korea', 'Tech', '', '', ''],
    ['@minji', '', '', '', '', 'Travel', '', '', '']), 'list.xlsx');
  assert.equal(JSON.stringify(DB.campaigns), campaigns);
  assert.equal(JSON.stringify(DB.participants), parts);
  assert.equal(DB.creators.find((c) => c.handle === '@brandnew').campaignIds.length, 0);
});

test('the plan is counted the way the preview reports it', () => {
  seed();
  const p = plan(
    ['@minji', '', '', '', '', '', '', '', ''],
    ['@jiwoo', 'Jiwoo Park', '', '', '', '', '', '', ''],
    ['@fresh', 'Fresh', '1,000', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '']);
  assert.equal(p.noChange.length, 1);
  assert.equal(p.fills.length, 1);
  assert.equal(p.creates.length, 1);
  assert.equal(p.skipped.length, 1);
  assert.deepEqual(applyCreatorPlan(p, 'list.xlsx'), { added: 1, filled: 1 });
});

/* ---- a flagged creator, made obvious -------------------------------- */

test('a blacklisted or caution creator carries a mark; everyone else carries none', () => {
  assert.match(flagMark({ flag: 'blocked', flagReason: 'ghosted' }), /Blacklisted/);
  assert.match(flagMark({ flag: 'blocked' }), /flag-mark blocked/);
  assert.match(flagMark({ flag: 'caution' }), /flag-mark caution/);
  assert.equal(flagMark({ flag: 'preferred' }), '', 'a star beside every good name is noise');
  assert.equal(flagMark({ flag: null }), '');
  assert.equal(flagMark(null), '');
});

test('the reason travels with the mark, escaped', () => {
  assert.match(flagMark({ flag: 'blocked', flagReason: 'said "no" <twice>' }),
    /title="Blacklisted — said &quot;no&quot; &lt;twice&gt;"/);
});

test('the row or card a flagged creator sits on is marked too', () => {
  assert.equal(flagRowClass({ flag: 'blocked' }), 'flagged-blocked');
  assert.equal(flagRowClass({ flag: 'caution' }), 'flagged-caution');
  assert.equal(flagRowClass({ flag: 'preferred' }), '');
  assert.equal(flagRowClass(undefined), '');
});

test('flagged creators on a campaign are found, blacklisted first', () => {
  seed();
  byCreator.cr1.flag = 'caution';
  const rows = flaggedOnRoster('cpK');
  assert.deepEqual(rows.map((x) => x.cr.handle), ['@jiwoo', '@minji']);
  assert.deepEqual(rows.map((x) => x.cr.flag), ['blocked', 'caution']);
  assert.deepEqual(flaggedOnRoster('cp-nothing'), []);
});

test('a dropped roster row is not a warning any more', () => {
  seed();
  DB.participants.find((p) => p.id === 'ptK2').stage = 'dropped';
  assert.deepEqual(flaggedOnRoster('cpK'), []);
});
