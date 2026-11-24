/* Notion Responses rows -> roster (server/notion-applicants.js).

   FAKE DATA ONLY. Every name, handle, address, phone and e-mail below is
   invented ("Fake Person", "fake.creatorN", example.invalid). No live Notion,
   Mongo or Google call is made: Notion is a function or tools/fake-notion.cjs,
   and the workspace is an in-memory stand-in that enforces the server's
   revision rule. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const N = require('../server/notion-applicants.js');
const AC = require('../server/notion-autocreate.js');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const hex = (n) => n.toString(16).padStart(32, '0');
const pid = (n) => AC.normalizeId(hex(n));
const DS1 = AC.normalizeId(hex(9001));
const DS2 = AC.normalizeId(hex(9002));
const shared = N.loadShared();

/* ---------- fixtures ---------- */
const MAPPING = {
  instagram: 'Instagram Link', tiktok: null, fullName: 'Full Name', email: 'Email', contact: 'Contact',
  address: 'Address', nationality: 'Nationality', followers: 'Followers', otherSns: null, contentUrl: null,
  views: null, likes: null, comments: null, shares: null, metricsAt: null, gender: null,
  formNotes: 'Notes', remark: null, headcount: 'People', visitAt: 'Visit Date', status: 'Status', note: null
};
const edit = (n, minute) => '2026-11-20T10:' + String(minute == null ? n : minute).padStart(2, '0') + ':00.000Z';
const row = (n, o) => {
  const x = o || {};
  return {
    pageId: pid(n), createdTime: '2026-11-19T0' + (n % 9) + ':00:00.000Z', lastEdited: x.edited || edit(n),
    properties: Object.assign({
      'Full Name': 'Fake Person ' + n, 'Instagram Link': 'https://instagram.com/fake.creator' + n,
      Nationality: 'Japanese', Followers: '12k', 'Visit Date': '2026-12-05T19:00:00.000+09:00',
      Status: 'Waiting Approval', Address: 'Fake Street ' + n, Contact: 'fake-contact-' + n,
      Email: 'fake' + n + '@example.invalid', Notes: 'fake note ' + n, People: '2'
    }, x.props || {})
  };
};
const campaign = (id, ds, extra) => Object.assign({ id, brand: 'Fake Brand', name: 'Fake Campaign ' + id, status: 'outreach',
  category: 'Lifestyle', start: '2026-11-01', notionDatabaseId: ds, notionMapping: Object.assign({}, MAPPING) }, extra || {});

/* a roster row the MANUAL import made earlier: Notion page id set, dashboard-owned fields filled in */
const manualCreator = (n) => ({ id: 'crOLD' + n, handle: '@fake.creator' + n, name: 'Old Name ' + n, platform: 'Instagram', followers: 5000, email: '', contact: '', address: '' });
const manualPart = (n, cpId, o) => Object.assign({
  id: cpId + '-crOLD' + n, campaignId: cpId, creatorId: 'crOLD' + n, stage: 'confirmed', source: 'Notion form', fee: 50000,
  contactedAt: '2026-11-02', repliedAt: '2026-11-02', confirmedAt: '2026-11-03', shippedAt: '2026-11-04', dropReason: null, revisions: 1,
  note: 'internal hand note', fullName: 'Old Name ' + n, address: 'Old Address ' + n, contact: '', nationality: 'Japanese',
  visitAt: '2026-12-01 18:00', confirmedVisitAt: '2026-12-06 15:00', arrivingDate: '2026-12-02', otherSns: '', importedStatus: 'Confirmed',
  formNotes: '', remark: '', headcount: '', appliedAt: '2026-11-01T00:00:00.000Z', notionPageId: pid(n), content: null
}, o || {});

const clone = (v) => JSON.parse(JSON.stringify(v));

/* in-memory workspace with the server's revision rule; `hooks` play another browser saving first */
function makeStore(init, opts) {
  const o = opts || {};
  const st = { doc: { db: Object.assign({ campaigns: [], creators: [], participants: [] }, init), settings: { s: 1 }, revision: 7 },
    saves: [], conflicts: 0, hooks: o.hooks || [], failSave: null };
  st.load = async () => (o.empty ? null : clone(st.doc));
  st.save = async (w) => {
    st.saves.push({ revision: w.revision, keys: Object.keys(w).sort() });
    if (st.failSave) throw new Error(st.failSave);
    const hook = st.hooks.shift();
    if (hook) hook(st.doc);
    if (w.revision !== st.doc.revision) { st.conflicts++; return { conflict: true }; }
    st.doc = { db: clone(w.db), settings: w.settings, revision: st.doc.revision + 1 };
    return { ok: true, revision: st.doc.revision };
  };
  return st;
}
function makeJobState(init) {
  const st = { value: init === undefined ? null : init, writes: 0, logs: [] };
  st.loadState = async () => (st.value ? clone(st.value) : null);
  st.saveState = async (v) => { st.writes++; st.value = clone(v); };
  st.saveLog = async (e) => { st.logs.push(clone(e)); };
  return st;
}
/* a Notion stand-in: one table of rows per data source, same filter / sort / paging rules as the real query */
function makeTable(init) {
  const t = { rows: init || {}, calls: [], failWith: null };
  t.query = async (o) => {
    t.calls.push({ ds: o.dataSourceId, since: o.since, startCursor: o.startCursor, pageSize: o.pageSize });
    if (t.failWith) {
      const e = new Error(t.failWith.message); e.status = t.failWith.status;
      if (t.failWith.rateLimited) { e.rateLimited = true; e.vcode = 'rate-limited'; e.retryAfterSec = t.failWith.retryAfterSec || 0; }
      throw e;
    }
    let rs = (t.rows[o.dataSourceId] || []).filter((r) => !o.since || r.lastEdited >= o.since)
      .map((r, i) => ({ r, i })).sort((a, b) => (a.r.lastEdited < b.r.lastEdited ? -1 : a.r.lastEdited > b.r.lastEdited ? 1 : a.i - b.i)).map((x) => x.r);
    const from = Number(o.startCursor) || 0;
    const more = from + o.pageSize < rs.length;
    return { rows: clone(rs.slice(from, from + o.pageSize)), hasMore: more, nextCursor: more ? String(from + o.pageSize) : null };
  };
  return t;
}
let idN = 0;
function job(store, table, extra) {
  const x = extra || {};
  const js = x.jobState || makeJobState();
  const logs = x.logs || [];
  const j = N.createApplicants(Object.assign({
    shared, loadWorkspace: store.load, saveWorkspace: store.save, queryRows: table.query, manualMinSec: 0,
    loadState: js.loadState, saveState: js.saveState, saveLog: js.saveLog,
    newId: (p) => p + 'TEST' + (++idN), now: () => new Date('2026-11-24T10:00:00Z'),
    logger: { error: (m) => logs.push(String(m)), log: (m) => logs.push(String(m)) }
  }, x));
  j.js = js; j.logs = logs;
  return j;
}
const cpReport = (run, id) => run.campaigns.find((c) => c.campaignId === id);
const rosterOf = (store, cpId) => store.doc.db.participants.filter((p) => p.campaignId === cpId);

/* ---------- the shared mapping code is the real one ---------- */

test('parity: the pieces the job evaluates give the same answers as the real browser module', async () => {
  const real = await import('../src/import/notion.js');
  const excel = await import('../src/import/excel.js');
  const creators = await import('../src/model/creators.js');
  const vocab = await import('../src/model/vocab.js');
  const rows = [row(1), row(2, { props: { Status: 'Brand Rejected', Followers: '1.2만', 'Instagram Link': '@Fake.Creator2.' } }),
    row(3, { props: { Status: 'Declined', 'Visit Date': 'next tuesday please' } }), row(4, { props: { 'Instagram Link': 'not a handle !!' } }),
    row(5, { props: { Status: '', Followers: 45 } })];
  const b = shared.bind('2026-11-24');
  rows.forEach((r) => assert.deepEqual(b.notionRowToApplicant(r.properties, MAPPING), real.notionRowToApplicant(r.properties, MAPPING)));
  ['@Fake.Creator2.', 'https://www.instagram.com/Fake.One/?hl=ko', 'fake', ''].forEach((h) => assert.equal(b.normHandle(h), creators.normHandle(h)));
  [100, 14999, 15000, 70000, 900000].forEach((f) => assert.equal(b.tierOf(f).id, vocab.tierOf(f).id));
  assert.deepEqual(Object.keys(b.STATUS_MAP), Object.keys(excel.STATUS_MAP));
  const p1 = {}, p2 = {};
  real.applyStageDates(p1, 'shipped', { start: '2026-11-01' }); b.applyStageDates(p2, 'shipped', { start: '2026-11-01' });
  assert.deepEqual(p2, p1);
  assert.equal(b.countryOf('Japanese'), excel.countryOf('Japanese'));
});

test('a created roster row has every key the manual import gives a new one', () => {
  const src = fs.readFileSync(ROOT + 'src/import/notion.js', 'utf8');
  const a = src.indexOf('const np = {'); const z = src.indexOf('};', a);
  const manualKeys = [...src.slice(a, z).matchAll(/(?:^|[\s,{])(\w+):/g)].map((m) => m[1]).filter((k) => !['when'].includes(k));
  const db = { campaigns: [campaign('cp1', DS1)], creators: [], participants: [] };
  N.applyRows({ db, cp: db.campaigns[0], rows: [row(1)], shared: shared.bind('2026-11-24'), newId: (p) => p + 'X', baseline: true });
  const mine = Object.keys(db.participants[0]);
  manualKeys.forEach((k) => assert.ok(mine.includes(k), 'missing key ' + k));
});

/* ---------- config / flag ---------- */

test('config: only the literal 1 turns it on; dry run, caps and page size have safe defaults and bounds', () => {
  assert.equal(N.parseConfig({}).requested, false);
  ['true', 'yes', '0', ' ', 'on'].forEach((v) => assert.equal(N.parseConfig({ NOTION_APPLICANTS_SYNC: v }).requested, false, v));
  assert.equal(N.parseConfig({ NOTION_APPLICANTS_SYNC: '1' }).requested, true);
  const d = N.parseConfig({});
  assert.deepEqual([d.intervalMin, d.maxCreate, d.maxRows, d.pageSize, d.maxCampaigns, d.dryRun, d.includeWrapped], [2, 10, 200, 50, 25, false, false]);
  const c = N.parseConfig({ NOTION_APPLICANTS_PAGE_SIZE: '9999', NOTION_APPLICANTS_MAX_CREATE: '', NOTION_APPLICANTS_MAX_ROWS: 'junk', NOTION_APPLICANTS_DRY_RUN: 'yes' });
  assert.equal(c.pageSize, 100); assert.equal(c.maxCreate, 10); assert.equal(c.maxRows, 200); assert.equal(c.dryRun, true);
  assert.equal(N.parseConfig({ NOTION_APPLICANTS_MAX_CREATE: '0' }).maxCreate, 0, '0 means create nothing');
});

/* ---------- first run: baseline, dedupe by row id and by handle ---------- */

function baselineWorld() {
  const store = makeStore({
    campaigns: [campaign('cp1', DS1)],
    creators: [manualCreator(1), Object.assign(manualCreator(2), { handle: '@Fake.Creator2' })],
    participants: [manualPart(1, 'cp1'),
      Object.assign(manualPart(2, 'cp1'), { notionPageId: undefined, stage: 'shortlisted', importedStatus: 'Waiting Approval' })]
  });
  delete store.doc.db.participants[1].notionPageId;
  const table = makeTable({ [DS1]: [row(1), row(2), row(3), row(4)] });
  return { store, table };
}

test('baseline: rows the manual import made are untouched; a sheet row is LINKED by handle (page id only); only new rows are created', async () => {
  const { store, table } = baselineWorld();
  const before1 = clone(store.doc.db.participants[0]);
  const before2 = clone(store.doc.db.participants[1]);
  const crBefore = clone(store.doc.db.creators);
  const j = job(store, table);
  const run = await j.run();
  assert.equal(run.ok, true, JSON.stringify(run.errors));
  const r = cpReport(run, 'cp1');
  assert.equal(r.baseline, true);
  assert.deepEqual(r.counts, { created: 2, linked: 1, updated: 0, already: 1, ambiguous: 0, held: 0, deferred: 0, differs: 1, elsewhere: 0, newCreators: 2, edited: 0 });
  /* row 1: nothing at all changed, even though Notion's name/address differ from the roster row's */
  assert.deepEqual(store.doc.db.participants[0], before1);
  /* row 2: the ONLY change is the page id */
  const after2 = clone(store.doc.db.participants[1]);
  assert.equal(after2.notionPageId, pid(2));
  delete after2.notionPageId;
  assert.deepEqual(after2, before2);
  /* the two old creators are as they were; two new ones exist */
  assert.deepEqual(store.doc.db.creators.slice(0, 2), crBefore);
  assert.equal(store.doc.db.creators.length, 4);
  assert.equal(rosterOf(store, 'cp1').length, 4);
  assert.equal(store.saves.length, 1, 'one save for the whole campaign batch');
  const st = j.js.value.campaigns.cp1;
  assert.equal(st.baselineDone, true);
  assert.equal(st.cursor, edit(4));
  assert.equal(st.ds, DS1);
});

test('dedupe by row id: running again, and a fresh job with the same state, never create a second roster row', async () => {
  const { store, table } = baselineWorld();
  const j = job(store, table);
  await j.run();
  const n = store.doc.db.participants.length;
  await j.run(); await j.run();
  assert.equal(store.doc.db.participants.length, n);
  /* state lost (for example the collection was dropped): everything is read again, still no duplicate */
  const j2 = job(store, table);
  const run = await j2.run();
  assert.equal(store.doc.db.participants.length, n);
  assert.equal(cpReport(run, 'cp1').counts.created, 0);
});

test('a second run with nothing new makes no save at all', async () => {
  const { store, table } = baselineWorld();
  const j = job(store, table);
  await j.run();
  const run2 = await j.run();
  assert.equal(store.saves.length, 1);
  assert.equal(cpReport(run2, 'cp1').counts.created, 0);
  assert.equal(cpReport(run2, 'cp1').baseline, false);
});

test('dedupe by handle: spelling variants of one handle reuse the existing creator, no second creator, no second roster row', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1), campaign('cp2', DS2)],
    creators: [{ id: 'crX', handle: '@Fake.Creator5', name: 'Elsewhere', followers: 0, email: '' }],
    participants: [{ id: 'cp2-crX', campaignId: 'cp2', creatorId: 'crX', stage: 'sourced', notionPageId: pid(77) }] });
  const table = makeTable({ [DS1]: [row(5, { props: { 'Instagram Link': 'https://www.instagram.com/FAKE.creator5/?hl=ko' } })], [DS2]: [] });
  const run = await job(store, table).run();
  assert.equal(store.doc.db.creators.length, 1, 'same person, one creator');
  assert.equal(rosterOf(store, 'cp1').length, 1, 'now also on cp1');
  assert.equal(rosterOf(store, 'cp1')[0].creatorId, 'crX');
  assert.equal(cpReport(run, 'cp1').counts.newCreators, 0);
  /* the existing creator was only filled in where empty */
  assert.equal(store.doc.db.creators[0].name, 'Elsewhere');
  assert.equal(store.doc.db.creators[0].email, 'fake5@example.invalid');
});

test('ambiguous: two creators with one handle, two roster rows for one creator, and a second submission by the same person are reported, never written', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)],
    creators: [
      { id: 'crA1', handle: '@fake.creator1', name: 'A' }, { id: 'crA2', handle: 'https://instagram.com/Fake.Creator1', name: 'B' },   // row 1: two creators
      { id: 'crB', handle: '@fake.creator2', name: 'C' },                                                                              // row 2: two roster rows
      { id: 'crC', handle: '@fake.creator3', name: 'D' }],                                                                             // row 3: already has another submission
    participants: [
      { id: 'p-b1', campaignId: 'cp1', creatorId: 'crB', stage: 'sourced' }, { id: 'p-b2', campaignId: 'cp1', creatorId: 'crB', stage: 'sourced' },
      { id: 'p-c', campaignId: 'cp1', creatorId: 'crC', stage: 'sourced', notionPageId: pid(300) }] });
  const table = makeTable({ [DS1]: [row(1), row(2), row(3)] });
  const before = clone(store.doc);
  const run = await job(store, table).run();
  const r = cpReport(run, 'cp1');
  assert.deepEqual(r.ambiguous.map((a) => a.why).sort(), ['duplicate-creators', 'several-roster-rows']);
  assert.deepEqual(r.held.map((h) => h.why), ['duplicate-submission']);
  assert.equal(r.counts.created, 0); assert.equal(r.counts.linked, 0);
  assert.deepEqual(store.doc, before, 'nothing was written');
  assert.equal(store.saves.length, 0);
});

test('a row whose page id sits on ANOTHER campaign is reported and left there (no rehoming, no second copy)', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1), campaign('cp2', DS2)],
    creators: [manualCreator(1)], participants: [manualPart(1, 'cp2')] });
  const table = makeTable({ [DS1]: [row(1)], [DS2]: [] });
  const run = await job(store, table, { jobState: makeJobState({ campaigns: { cp1: { ds: DS1, cursor: null, baselineDone: true } } }) }).run();
  assert.equal(cpReport(run, 'cp1').counts.elsewhere, 1);
  assert.equal(store.doc.db.participants.length, 1);
  assert.equal(store.doc.db.participants[0].campaignId, 'cp2');
  assert.equal(store.saves.length, 0);
});

/* ---------- what Notion may and may not change after the first import ---------- */

test('later edits: intake fields follow Notion; dashboard-owned fields never change; "Notion differs" is reported', async () => {
  const { store, table } = baselineWorld();
  const j = job(store, table);
  await j.run();
  const created = rosterOf(store, 'cp1').find((p) => p.notionPageId === pid(4));
  /* the team works on the new row in the dashboard */
  const d = store.doc.db.participants.find((p) => p.id === created.id);
  Object.assign(d, { stage: 'shipped', note: 'team note', confirmedVisitAt: '2026-12-09 12:00', arrivingDate: '2026-12-08', shippedAt: '2026-12-08', fee: 123, importedStatus: 'Waiting Upload' });
  const owned = clone(d);
  /* the creator edits the form and someone changes the Notion status */
  table.rows[DS1][3] = row(4, { edited: '2026-11-22T09:00:00.000Z', props: {
    'Full Name': 'Fake Person 4 Renamed', Address: 'Fake Street 4 New', Nationality: 'Korean', 'Visit Date': '2026-12-20T11:00:00.000+09:00',
    Notes: 'new answer', People: '3', Status: 'Brand Rejected' } });
  const run = await j.run();
  const r = cpReport(run, 'cp1');
  assert.equal(r.counts.updated, 1);
  const after = store.doc.db.participants.find((p) => p.id === created.id);
  assert.equal(after.fullName, 'Fake Person 4 Renamed');
  assert.equal(after.address, 'Fake Street 4 New');
  assert.equal(after.nationality, 'Korean');
  assert.equal(after.visitAt, '2026-12-20 11:00', 'the REQUESTED date follows Notion');
  assert.equal(after.formNotes, 'new answer');
  assert.equal(after.headcount, '3');
  ['stage', 'note', 'confirmedVisitAt', 'arrivingDate', 'shippedAt', 'fee', 'importedStatus', 'dropReason', 'confirmedAt', 'contactedAt', 'repliedAt']
    .forEach((k) => assert.deepEqual(after[k], owned[k], k + ' is dashboard-owned'));
  assert.deepEqual(r.differs, [{ participantId: created.id, field: 'status' }]);
});

test('the creator\'s Visit Date is the REQUEST: a new row has visitAt and no confirmedVisitAt', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  await job(store, makeTable({ [DS1]: [row(1)] })).run();
  const p = store.doc.db.participants[0];
  assert.equal(p.visitAt, '2026-12-05 19:00');
  assert.equal(p.confirmedVisitAt, undefined);
  assert.equal(p.stage, 'shortlisted');
  assert.equal(p.importedStatus, 'Waiting Approval');
  assert.ok(p.appliedAt && p.notionPageId === pid(1) && p.source === 'Notion form');
});

test('a mapped column cleared in Notion clears it here; a field with no column is left alone', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const table = makeTable({ [DS1]: [row(1)] });
  const j = job(store, table);
  await j.run();
  const p0 = store.doc.db.participants[0];
  p0.remark = 'typed by the team'; p0.otherSns = 'team typed this too';   // remark / otherSns have no mapped column
  table.rows[DS1][0] = row(1, { edited: '2026-11-22T09:00:00.000Z', props: { Address: '', Notes: '' } });
  await j.run();
  const p = store.doc.db.participants[0];
  assert.equal(p.address, ''); assert.equal(p.formNotes, '');
  assert.equal(p.remark, 'typed by the team'); assert.equal(p.otherSns, 'team typed this too');
});

test('a creator\'s fields are only ever FILLED IN (followers, e-mail), never overwritten by a form answer', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)], creators: [Object.assign(manualCreator(1), { followers: 99000, email: 'kept@example.invalid' })],
    participants: [manualPart(1, 'cp1')] });
  const table = makeTable({ [DS1]: [row(1)] });
  const j = job(store, table, { jobState: makeJobState({ campaigns: { cp1: { ds: DS1, cursor: null, baselineDone: true } } }) });
  await j.run();
  assert.equal(store.doc.db.creators[0].followers, 99000);
  assert.equal(store.doc.db.creators[0].email, 'kept@example.invalid');
});

test('nothing is deleted or archived because a row vanished or was trashed', async () => {
  const { store, table } = baselineWorld();
  const j = job(store, table);
  await j.run();
  const snapshot = clone(store.doc.db);
  table.rows[DS1] = [];                         // every row gone from Notion
  await j.run(); await j.run({ });
  await j.run({ rescan: ['cp1'] });
  assert.deepEqual(store.doc.db, snapshot);
  /* a trashed / archived page is not even read as a row */
  const out = N.pageToRow({ id: pid(1), archived: true, properties: {} }, () => '');
  assert.equal(out, null);
  assert.equal(N.pageToRow({ id: pid(1), in_trash: true, properties: {} }, () => ''), null);
});

/* ---------- statuses ---------- */

test('"Declined" is a real status: the new row is created as Dropped with reason Declined (same meaning as the Notion write-back); a word nobody knows is held', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const table = makeTable({ [DS1]: [row(1, { props: { Status: 'Declined' } }), row(2, { props: { Status: 'Confirmed' } }), row(3, { props: { Status: 'Brand Rejected' } }), row(4, { props: { Status: 'Some New Word' } })] });
  const run = await job(store, table).run();
  assert.deepEqual(run.unknownStatuses, [{ value: 'unknown', count: 1 }], 'only the unknown one is counted, and its text is not kept');
  assert.equal(run.counts.unknownStatusRows, 1);
  const r = cpReport(run, 'cp1');
  assert.deepEqual(r.held, [{ pageId: pid(4), why: 'unknown-status' }]);
  const dec = rosterOf(store, 'cp1').find((p) => p.notionPageId === pid(1));
  assert.equal(dec.stage, 'dropped'); assert.equal(dec.dropReason, 'Declined'); assert.equal(dec.importedStatus, 'Declined');
  assert.deepEqual(rosterOf(store, 'cp1').map((p) => p.stage).sort(), ['confirmed', 'dropped', 'dropped']);
  assert.equal(store.doc.db.creators.length, 3, 'no creator made for the held row');
  assert.ok(!JSON.stringify([run, store.doc, await job(store, table).stateSummary()]).includes('Some New Word'), 'the unknown status text is nowhere');
});

test('Declined agrees with the rest of the dashboard: the write-back sends Declined for that drop, and Dropped is a real stage', async () => {
  const wb = await import('../src/sync/notionWriteback.js');
  const vocab = await import('../src/model/vocab.js');
  const x = N.EXTRA_STATUS.declined;
  assert.equal(wb.notionValueForDrop({ dropReason: x.reason }), 'Declined');
  assert.ok(vocab.STAGES.some((st) => st.id === x.stage));
  assert.equal(x.stage, 'dropped');
});

test('unknown status on a row already on the roster: reported as "unknown" (no text), the stage is not touched', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)], creators: [manualCreator(1)], participants: [manualPart(1, 'cp1')] });
  const table = makeTable({ [DS1]: [row(1, { props: { Status: 'Some New Word' } })] });
  const run = await job(store, table, { jobState: makeJobState({ campaigns: { cp1: { ds: DS1, cursor: null, baselineDone: true } } }) }).run();
  assert.deepEqual(run.unknownStatuses, [{ value: 'unknown', count: 1 }]);
  assert.equal(store.doc.db.participants[0].stage, 'confirmed');
  assert.equal(store.doc.db.participants[0].importedStatus, 'Confirmed');
});

test('a status that is an Object.prototype name ("constructor") is unknown, not a crash and not a stage', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const run = await job(store, makeTable({ [DS1]: [row(1, { props: { Status: 'constructor' } })] })).run();
  assert.deepEqual(run.unknownStatuses, [{ value: 'unknown', count: 1 }]);
  assert.equal(store.doc.db.participants.length, 0);
});

test('a row with no readable handle is held with a reason, never created', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const run = await job(store, makeTable({ [DS1]: [row(1, { props: { 'Instagram Link': '' } }), row(2, { props: { 'Instagram Link': 'two words !!' } })] })).run();
  assert.deepEqual(cpReport(run, 'cp1').held.map((h) => h.why), ['no-handle', 'no-handle']);
  assert.equal(store.doc.db.participants.length, 0);
});

test('unknown status text is never stored or shown, whatever it looks like (an address, a link, a long number, a very long text)', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const table = makeTable({ [DS1]: [row(1, { props: { Status: 'fake@example.invalid' } }), row(2, { props: { Status: '01012345678' } }),
    row(3, { props: { Status: 'x'.repeat(200) } }), row(4, { props: { Status: 'https://example.invalid/a' } })] });
  const js = makeJobState();
  const j = job(store, table, { jobState: js });
  const run = await j.run();
  assert.deepEqual(run.unknownStatuses, [{ value: 'unknown', count: 4 }]);
  const all = JSON.stringify([run, js.value, js.logs, await j.stateSummary()]);
  ['example.invalid', '01012345678', 'xxxxxxxx'].forEach((v) => assert.ok(!all.includes(v), v));
});

/* ---------- cursor, saves, retries ---------- */

test('the cursor advances only after a successful save; a failed save leaves state alone and the next run converges', async () => {
  const { store, table } = baselineWorld();
  const j = job(store, table);
  store.failSave = 'database down';
  const bad = await j.run();
  assert.equal(cpReport(bad, 'cp1').status, 'error');
  assert.equal(j.js.writes, 0, 'no state written');
  assert.equal(j.js.value, null);
  assert.equal(store.doc.db.participants.length, 2, 'workspace untouched');
  store.failSave = null;
  const good = await j.run();
  assert.equal(cpReport(good, 'cp1').counts.created, 2);
  assert.equal(j.js.value.campaigns.cp1.cursor, edit(4));
  assert.equal(rosterOf(store, 'cp1').length, 4, 'created once, not twice');
});

test('409: re-reads, re-applies WITHOUT another Notion call and without force, keeps the other writer\'s edit, creates once', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] },
    { hooks: [(d) => { d.revision += 1; d.db.campaigns[0].note = 'typed meanwhile'; }] });
  const table = makeTable({ [DS1]: [row(1), row(2)] });
  const j = job(store, table);
  const run = await j.run();
  assert.equal(run.ok, true, JSON.stringify(run.errors));
  assert.equal(cpReport(run, 'cp1').attempts, 2);
  assert.equal(store.conflicts, 1);
  assert.equal(store.doc.db.campaigns[0].note, 'typed meanwhile');
  assert.equal(rosterOf(store, 'cp1').length, 2);
  assert.equal(table.calls.length, 1, 'the Notion rows were read once');
  store.saves.forEach((s) => assert.ok(!s.keys.includes('force'), 'force never sent'));
  assert.deepEqual(store.saves[0].keys, ['db', 'revision', 'settings']);
  assert.equal(j.js.value.campaigns.cp1.cursor, edit(2));
});

test('409 forever: gives up after the cap, writes nothing, does not move the cursor, and says so', async () => {
  const hooks = Array.from({ length: 10 }, () => (d) => { d.revision += 1; });
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] }, { hooks });
  const j = job(store, makeTable({ [DS1]: [row(1)] }));
  const run = await j.run();
  assert.equal(run.ok, false);
  assert.equal(cpReport(run, 'cp1').why, 'workspace-kept-changing');
  assert.equal(cpReport(run, 'cp1').attempts, 4);
  assert.equal(store.doc.db.participants.length, 0);
  assert.equal(j.js.writes, 0);
});

test('a save answer that is neither ok nor a conflict is an error: no cursor, no state', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  store.save = async () => ({ ok: false });
  const j = job(store, makeTable({ [DS1]: [row(1)] }));
  const run = await j.run();
  assert.equal(cpReport(run, 'cp1').status, 'error');
  assert.equal(j.js.writes, 0);
});

test('Notion order is asked for, not trusted: unsorted rows are sorted before the cursor is chosen, and a truncated unsorted read does not move the cursor', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const rows = [row(3), row(1), row(2)];
  const q = async () => ({ rows: clone(rows), hasMore: false, nextCursor: null });
  const j = job(store, { query: q }, { maxCreate: 50 });
  await j.run();
  assert.equal(j.js.value.campaigns.cp1.cursor, edit(3), 'the newest edit, not the last row Notion happened to list');
  const store2 = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const q2 = async () => ({ rows: clone(rows), hasMore: true, nextCursor: '3' });
  const j2 = job(store2, { query: q2 }, { maxCreate: 50, maxRows: 3, pageSize: 3 });
  const run2 = await j2.run();
  assert.equal(cpReport(run2, 'cp1').cursorNote, 'unsorted-truncated');
  assert.equal(j2.js.value.campaigns.cp1.cursor, null);
});

test('the cursor never moves backwards, even if Notion returns rows older than the filter asked for', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const j = job(store, { query: async () => ({ rows: clone([row(1), row(2)]), hasMore: false, nextCursor: null }) },
    { jobState: makeJobState({ campaigns: { cp1: { ds: DS1, cursor: edit(30), baselineDone: true } } }) });
  await j.run();
  assert.equal(j.js.value.campaigns.cp1.cursor, edit(30));
});

test('409 through the REAL saveWorkspaceDoc and the real wrapper (force:false): another browser saves in the gap, its edit survives', async () => {
  const col = fakeCollection({ db: { campaigns: [campaign('cp1', DS1)], creators: [], participants: [] }, settings: { s: 1 }, revision: 3 });
  const save = realSaveWorkspaceDoc(col);
  const calls = [];
  const wrapper = AC.makeSaveWorkspace(async (b) => { calls.push(b); return save(b); });
  col.hooks = [(d) => { d.revision += 1; d.db.campaigns.push({ id: 'typed', name: 'Someone typed this' }); }];
  const j = N.createApplicants({
    shared, loadWorkspace: async () => ({ db: clone(col.doc.db), settings: col.doc.settings, revision: col.doc.revision }),
    saveWorkspace: wrapper, queryRows: makeTable({ [DS1]: [row(1)] }).query, newId: (p) => p + 'REAL1',
    now: () => new Date('2026-11-24T10:00:00Z'), logger: { error() {}, log() {} }
  });
  const run = await j.run();
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.ok(col.doc.db.campaigns.some((c) => c.name === 'Someone typed this'));
  assert.equal(col.doc.db.participants.length, 1);
  assert.equal(col.updates, 1, 'one write reached the database');
  assert.ok(calls.length === 2 && calls.every((c) => c.force === false), 'every save was force:false');
});

/* ---------- caps and bounds ---------- */

test('create cap: more new rows than the cap are deferred, reported as remaining, and arrive on later runs; none lost, none doubled', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const table = makeTable({ [DS1]: [1, 2, 3, 4, 5].map((n) => row(n)) });
  const j = job(store, table, { maxCreate: 2 });
  const r1 = await j.run();
  assert.equal(cpReport(r1, 'cp1').counts.created, 2);
  assert.equal(cpReport(r1, 'cp1').counts.deferred, 3);
  assert.equal(r1.remaining.creates, 3);
  assert.equal(j.js.value.campaigns.cp1.cursor, edit(3), 'the cursor stops at the first deferred row, not past it');
  assert.equal(j.js.value.campaigns.cp1.baselineDone, false);
  await j.run(); await j.run();
  assert.equal(rosterOf(store, 'cp1').length, 5);
  assert.equal(new Set(rosterOf(store, 'cp1').map((p) => p.notionPageId)).size, 5);
  const r4 = await j.run();
  assert.equal(cpReport(r4, 'cp1').counts.created, 0);
  assert.equal(j.js.value.campaigns.cp1.baselineDone, true);
});

test('the create cap is shared across campaigns in one run', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1), campaign('cp2', DS2)] });
  const table = makeTable({ [DS1]: [row(1), row(2)], [DS2]: [row(11), row(12)] });
  const run = await job(store, table, { maxCreate: 3 }).run();
  assert.equal(run.counts.created, 3);
  assert.equal(run.remaining.creates, 1);
  assert.equal(store.doc.db.participants.length, 3);
});

test('maxCreate 0 creates nothing but still links and reports', async () => {
  const { store, table } = baselineWorld();
  const run = await job(store, table, { maxCreate: 0 }).run();
  assert.equal(run.counts.created, 0); assert.equal(run.counts.deferred, 2); assert.equal(run.counts.linked, 1);
});

test('row cap and page size: rows are read in bounded pages, a long table is worked through over several runs, and the cursor never moves backwards', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const table = makeTable({ [DS1]: [1, 2, 3, 4, 5, 6, 7].map((n) => row(n)) });
  const j = job(store, table, { maxRows: 3, pageSize: 2, maxCreate: 50 });
  const r1 = await j.run();
  assert.equal(cpReport(r1, 'cp1').rows, 3);
  assert.equal(cpReport(r1, 'cp1').moreRows, true);
  assert.equal(r1.remaining.campaignsWithMoreRows, 1);
  table.calls.forEach((c) => assert.ok(c.pageSize <= 2, 'page size bound'));
  assert.deepEqual(table.calls.map((c) => c.pageSize), [2, 1], 'the last page is shortened so no more than maxRows are read');
  assert.equal(j.js.value.campaigns.cp1.baselineDone, false);
  for (let i = 0; i < 4; i++) await j.run();
  assert.equal(rosterOf(store, 'cp1').length, 7);
  assert.equal(j.js.value.campaigns.cp1.cursor, edit(7));
  assert.equal(j.js.value.campaigns.cp1.baselineDone, true);
});

test('many rows with one edit time cannot be walked past: the run says the cursor is stalled instead of looping silently', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const same = [1, 2, 3, 4].map((n) => row(n, { edited: edit(5, 5) }));
  const j = job(store, makeTable({ [DS1]: same }), { maxRows: 2, pageSize: 2, maxCreate: 50 });
  await j.run();
  const r2 = await j.run();
  assert.equal(cpReport(r2, 'cp1').cursorNote, 'cursor-stalled');
});

test('campaign cap: campaigns not visited this run are counted, and the longest-waiting ones go first next time', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1), campaign('cp2', DS2)] });
  const table = makeTable({ [DS1]: [row(1)], [DS2]: [row(2)] });
  const j = job(store, table, { maxCampaigns: 1 });
  const r1 = await j.run();
  assert.equal(r1.remaining.campaignsNotVisited, 1);
  assert.equal(r1.campaigns.filter((c) => c.status === 'ok').length, 1);
  const r2 = await j.run();
  const done = [r1, r2].map((r) => r.campaigns.find((c) => c.status === 'ok').campaignId).sort();
  assert.deepEqual(done, ['cp1', 'cp2']);
});

/* ---------- which campaigns ---------- */

test('only campaigns with a Notion data source and a mapping are read; shared forms, no mapping and wrapped are skipped with a reason', async () => {
  const store = makeStore({ campaigns: [
    campaign('ok', DS1), campaign('twinA', DS2), campaign('twinB', DS2),
    campaign('nomap', AC.normalizeId(hex(9003)), { notionMapping: null }),
    campaign('done', AC.normalizeId(hex(9004)), { status: 'wrapped' }),
    { id: 'manualonly', brand: 'x', name: 'never connected' }] });
  const table = makeTable({ [DS1]: [row(1)], [DS2]: [row(2)] });
  const run = await job(store, table).run();
  const why = Object.fromEntries(run.campaigns.filter((c) => c.status === 'skipped').map((c) => [c.campaignId, c.why]));
  assert.deepEqual(why, { twinA: 'shared-source', twinB: 'shared-source', nomap: 'no-mapping', done: 'wrapped' });
  assert.deepEqual(table.calls.map((c) => c.ds), [DS1], 'only the one clean campaign was queried');
  assert.equal(run.campaigns.some((c) => c.campaignId === 'manualonly'), false);
  const inc = await job(makeStore({ campaigns: [campaign('done', DS1, { status: 'wrapped' })] }), makeTable({ [DS1]: [] }), { includeWrapped: true }).run();
  assert.equal(inc.campaigns[0].status, 'ok');
});

test('a campaign whose form link changed since the cursor was stored starts again from the baseline', async () => {
  const { store, table } = baselineWorld();
  const j = job(store, table, { jobState: makeJobState({ campaigns: { cp1: { ds: DS2, cursor: edit(50), baselineDone: true } } }) });
  const run = await j.run();
  assert.equal(cpReport(run, 'cp1').baseline, true);
  assert.equal(table.calls[0].since, null);
});

test('rescan (staff, one campaign): reads from the first row again as a normal run; rows already on the roster are matched, not copied', async () => {
  const { store, table } = baselineWorld();
  const j = job(store, table);
  await j.run();
  const n = store.doc.db.participants.length;
  const run = await j.run({ rescan: ['cp1'] });
  assert.equal(table.calls.at(-1).since, null);
  assert.equal(cpReport(run, 'cp1').baseline, false);
  assert.equal(store.doc.db.participants.length, n);
});

test('campaignId restricts a manual run to that campaign', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1), campaign('cp2', DS2)] });
  const table = makeTable({ [DS1]: [row(1)], [DS2]: [row(2)] });
  await job(store, table).run({ campaignId: 'cp2' });
  assert.deepEqual(table.calls.map((c) => c.ds), [DS2]);
});

test('a Notion error for one campaign is reported for that campaign only, as a code, and nothing is written for it', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const table = makeTable({ [DS1]: [row(1)] });
  table.failWith = { status: 404, message: 'Could not find data source with id ' + DS1 };
  const j = job(store, table);
  const run = await j.run();
  assert.equal(cpReport(run, 'cp1').status, 'error');
  assert.equal(cpReport(run, 'cp1').why, 'query-failed:http-404');
  assert.equal(store.saves.length, 0); assert.equal(j.js.writes, 0);
  assert.ok(!JSON.stringify(run).includes('Could not find'), 'Notion\'s message text is not kept');
});

test('no workspace document yet: nothing is created from nothing', async () => {
  const store = makeStore({}, { empty: true });
  const table = makeTable({ [DS1]: [row(1)] });
  const run = await job(store, table).run();
  assert.equal(run.errors.length, 1); assert.equal(table.calls.length, 0);
});

test('overlapping runs: the second returns busy instead of racing', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const table = makeTable({ [DS1]: [row(1)] });
  let release; const gate = new Promise((r) => { release = r; });
  const slow = { query: async (o) => { await gate; return table.query(o); } };
  const j = job(store, slow);
  const a = j.run();
  const b = await j.run();
  assert.equal(b.busy, true);
  release();
  await a;
  assert.equal(rosterOf(store, 'cp1').length, 1);
});

/* ---------- dry run ---------- */

test('dry run writes NOTHING: no workspace save, no state, no log; the answer says what it would do and can be repeated', async () => {
  const { store, table } = baselineWorld();
  const before = clone(store.doc);
  const j = job(store, table);
  const run = await j.run({ dryRun: true });
  assert.equal(run.dryRun, true);
  assert.equal(cpReport(run, 'cp1').status, 'dry-run');
  assert.equal(cpReport(run, 'cp1').counts.created, 2);
  assert.equal(cpReport(run, 'cp1').counts.linked, 1);
  assert.equal(store.saves.length, 0);
  assert.equal(j.js.writes, 0); assert.equal(j.js.logs.length, 0);
  assert.deepEqual(store.doc, before);
  /* the in-memory last run is readable for /status, the stored one is not written */
  assert.equal(j.lastRun().dryRun, true);
  const again = await j.run({ dryRun: true });
  assert.equal(cpReport(again, 'cp1').counts.created, 2, 'repeatable');
});

test('env dry run: a poll with the env flag set never writes either, and a live-looking request cannot turn it off', async () => {
  const { store, table } = baselineWorld();
  const j = job(store, table, { dryRun: true });
  const run = await j.run({ trigger: 'poll' });
  assert.equal(run.dryRun, true);
  assert.equal(store.saves.length, 0); assert.equal(j.js.writes, 0); assert.equal(j.js.logs.length, 0);
  /* server.js passes dryRun: undefined unless the request said true, so the env value stands */
  const run2 = await j.run({ trigger: 'manual', dryRun: undefined });
  assert.equal(run2.dryRun, true);
});

test('a live run is logged (counts and ids); that is the only difference to a dry run', async () => {
  const { store, table } = baselineWorld();
  const j = job(store, table);
  await j.run();
  assert.equal(j.js.logs.length, 1);
  assert.equal(j.js.logs[0].dryRun, false);
});

/* ---------- privacy ---------- */

test('PII never reaches a log line, the run entry, the stored log, the job state, or an error: planted sentinels in every personal field', async () => {
  const S = { name: 'SENTINEL-NAME-Zq81', handle: 'sentinel.handle.zq82', addr: 'SENTINEL-ADDR-Zq83 Fake-ro 9', phone: 'SENTINEL-PHONE-0100000084',
    mail: 'sentinel85@example.invalid', note: 'SENTINEL-NOTE-Zq86', nat: 'SENTINEL-NATION-Zq87' };
  const sentinels = Object.values(S);
  const prop = (extra) => Object.assign({ 'Full Name': S.name, 'Instagram Link': 'https://instagram.com/' + S.handle, Address: S.addr, Contact: S.phone,
    Email: S.mail, Notes: S.note, Nationality: S.nat, Followers: '8k', Status: 'Waiting Approval', 'Visit Date': '2026-12-05T19:00:00.000+09:00', People: '2' }, extra);
  const mk = (n, extra) => ({ pageId: pid(n), createdTime: '2026-11-19T01:00:00.000Z', lastEdited: edit(n), properties: prop(extra) });
  const store = makeStore({ campaigns: [campaign('cp1', DS1), campaign('cp2', DS2), campaign('cp3', AC.normalizeId(hex(9005)))],
    creators: [Object.assign(manualCreator(8), { handle: '@' + S.handle + '8' })], participants: [] });
  const logs = [];
  const table = makeTable({
    [DS1]: [mk(1, { 'Instagram Link': 'https://instagram.com/' + S.handle + '1' }), mk(2, { 'Instagram Link': 'https://instagram.com/' + S.handle + '2', Status: 'Declined' }), mk(3, { 'Instagram Link': '' })],
    [DS2]: [mk(4, { 'Instagram Link': 'https://instagram.com/' + S.handle + '8' }), mk(5, { 'Instagram Link': 'https://instagram.com/' + S.handle + '8' })],
    [AC.normalizeId(hex(9005))]: [mk(6)]
  });
  const j = job(store, table, { logs });
  const outputs = [];
  outputs.push(await j.run({ dryRun: true }));
  outputs.push(await j.run());
  /* a failing Notion that puts a sentinel in its message, and a failing save with one in its text */
  table.failWith = { status: 500, message: 'boom ' + S.name + ' ' + S.addr };
  outputs.push(await j.run({ rescan: ['cp1', 'cp2', 'cp3'] }));
  table.failWith = null; store.failSave = 'db said ' + S.phone + ' ' + S.mail;
  table.rows[DS1].push(mk(7, { 'Instagram Link': 'https://instagram.com/' + S.handle + '7' }));
  outputs.push(await j.run());
  const surfaces = [JSON.stringify(outputs), JSON.stringify(j.js.logs), JSON.stringify(j.js.value), logs.join('\n'), JSON.stringify(await j.stateSummary())];
  surfaces.forEach((s) => sentinels.forEach((v) => assert.ok(!s.includes(v), 'leaked: ' + v.slice(0, 18))));
  assert.ok(JSON.stringify(store.doc).includes(S.name), 'the roster itself does hold the data (that is its job)');
});

/* ---------- Notion over HTTP: the real flatten, the real request bodies ---------- */

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const httpJson = (port, method, p, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
    let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }));
  });
  r.on('error', reject); r.end(data);
});
async function startProc(file, env, mark) {
  const child = spawn(process.execPath, [file], { cwd: ROOT, env: Object.assign({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, env), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('did not start: ' + out)), 15000);
    child.stdout.on('data', (d) => { out += d; if (String(out).includes(mark)) { clearTimeout(t); resolve(); } });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', () => reject(new Error('exited early: ' + out)));
  });
  return { child, output: () => out };
}
function realExtractNotionValue() {
  const src = fs.readFileSync(ROOT + 'server.js', 'utf8');
  const a = src.indexOf('function extractNotionValue(prop) {');
  const b = src.indexOf('\n}\n', a);
  assert.ok(a > 0 && b > a, 'extractNotionValue found in server.js');
  return new Function('return (' + src.slice(a, b + 2) + ');')();
}

test('over HTTP against tools/fake-notion.cjs: only data source QUERIES are sent (ascending last_edited_time, bounded page size, cursor filter on the second run); nothing is written to Notion', async () => {
  const port = await freePort();
  const fake = await startProc('tools/fake-notion.cjs', { FAKE_NOTION_PORT: String(port) }, 'fake notion on');
  const base = 'http://127.0.0.1:' + port + '/v1';
  const requests = [];
  try {
    await httpJson(port, 'POST', '/__form', { [DS1]: [1, 2, 3, 4, 5].map((n) => ({ pageId: pid(n), createdTime: '2026-11-19T01:00:00.000Z', lastEditedTime: edit(n),
      properties: row(n).properties })) });
    const post = async (p, body) => {
      requests.push({ method: 'POST', path: p });
      const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' }, body: JSON.stringify(body) });
      const out = await r.json(); if (!r.ok) { const e = new Error(out.message); e.status = r.status; throw e; } return out;
    };
    const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
    const j = N.createApplicants({
      shared, loadWorkspace: store.load, saveWorkspace: store.save, queryRows: N.makeQueryRows(post, realExtractNotionValue()),
      newId: (p) => p + 'HTTP' + (++idN), now: () => new Date('2026-11-24T10:00:00Z'), logger: { error() {}, log() {} }, pageSize: 2, maxRows: 10, maxCreate: 20
    });
    const r1 = await j.run();
    assert.equal(r1.ok, true, JSON.stringify(r1.errors));
    assert.equal(rosterOf(store, 'cp1').length, 5);
    /* real flatten: rich_text and status values came through the same way the manual route reads them */
    const p3 = rosterOf(store, 'cp1').find((p) => p.notionPageId === pid(3));
    assert.equal(p3.fullName, 'Fake Person 3'); assert.equal(p3.importedStatus, 'Waiting Approval'); assert.equal(p3.stage, 'shortlisted');
    const r2 = await j.run();
    assert.equal(cpReport(r2, 'cp1').counts.created, 0);
    assert.equal(store.saves.length, 1);
    const st = await httpJson(port, 'GET', '/__state');
    const bodies = st.json.queries.map((q) => q.body);
    assert.ok(bodies.length >= 4);
    bodies.forEach((b) => {
      assert.ok(b.page_size <= 2);
      assert.deepEqual(b.sorts, [{ timestamp: 'last_edited_time', direction: 'ascending' }]);
      assert.deepEqual(Object.keys(b).filter((k) => !['page_size', 'sorts', 'filter', 'start_cursor'].includes(k)), []);
    });
    assert.equal(bodies[0].filter, undefined, 'first run: no cursor, no filter');
    assert.deepEqual(bodies.at(-1).filter, { timestamp: 'last_edited_time', last_edited_time: { on_or_after: edit(5) } }, 'second run starts at the stored cursor');
    assert.ok(requests.every((r) => r.method === 'POST' && /^\/data_sources\/[0-9a-f-]{36}\/query$/.test(r.path)), 'only query requests');
    assert.deepEqual(st.json.writes, [], 'nothing was written to Notion');
  } finally { fake.child.kill(); }
});

/* ---------- the real save, cut out of server.js ---------- */

function realSaveWorkspaceDoc(col) {
  const src = fs.readFileSync(ROOT + 'server.js', 'utf8');
  const a = src.indexOf('async function saveWorkspaceDoc(body) {');
  const b = src.indexOf('\n}\n', a);
  assert.ok(a > 0 && b > a, 'saveWorkspaceDoc found in server.js');
  const fn = new Function('getWorkspaceCollection', 'WORKSPACE_ID', 'wsGuard', 'bookingApi', 'bookingStore',
    'stampPartnerClients', 'PARTNER_LINK_TTL_DAYS', 'console', 'writeWorkspaceCas', 'clientViews',
    'return (' + src.slice(a, b + 2) + ');');
  return fn(async () => col, 'shared', require('../server/workspace-guard.js'), null, {},
    () => ({ revokedKept: 0 }), 90, { error() {}, log() {}, warn() {} },
    require('../server/workspace-cas.js').writeWorkspaceCas, null);
}
function fakeCollection(doc) {
  const c = { doc, updates: 0, hooks: [] };
  c.findOne = async (q, o) => {
    const p = (o && o.projection) || {};
    if (p['db.partnerLinks']) return { db: { partnerLinks: [] } };
    if (p.revision) {
      const h = c.hooks.shift(); if (h) h(c.doc);
      return { revision: c.doc.revision, savedAt: 'x', campaigns: c.doc.db.campaigns.length,
        creators: c.doc.db.creators.length, participants: c.doc.db.participants.length };
    }
    return c.doc;
  };
  c.updateOne = async (q, u) => { c.updates++; const s = u.$set; c.doc = { db: s.db, settings: s.settings, revision: s.revision }; return { matchedCount: 1 }; };
  return c;
}

/* ---------- the wiring in server.js ---------- */

test('server.js wiring: the routes are registered behind the real requireStaff, the force:false wrapper, ONE guarded Notion caller, no force anywhere in the block', () => {
  const src = fs.readFileSync(ROOT + 'server.js', 'utf8');
  const a = src.indexOf('creator applications: Notion Responses rows');
  const b = src.indexOf('/* ---------------- confirmed visit date: dashboard -> Notion row + Sheet row');
  assert.ok(a > 0 && b > a);
  const block = src.slice(a, b);
  assert.match(block, /notionApplicants\.registerRoutes\(app, requireStaff, /);
  assert.match(block, /saveWorkspace: notionAutocreate\.makeSaveWorkspace\(saveWorkspaceDoc\)/);
  assert.ok(!/force/i.test(block.replace(/`force`|force:false/g, '')), 'no force in the block');
  assert.ok(!/forceSave|force: true/.test(block));
  /* the only Notion call is the guarded caller's raw function */
  assert.equal((block.match(/notionFetch\(/g) || []).length, 1);
  assert.match(block, /makeNotionApi\(\(p, o\) => notionFetch\(p, o\), extractNotionValue,/);
  /* the request can make a run more careful, never less, and nothing in the job module can write to Notion or save with force */
  const mod = fs.readFileSync(ROOT + 'server/notion-applicants.js', 'utf8');
  assert.match(mod, /dryRun: b\.dryRun \? true : undefined/);
  assert.ok(!/method:\s*"(PATCH|PUT|DELETE)"|force:\s*true|forceSave/.test(mod));
  assert.ok(!/\bd\.notionGet\b|\bfetch\(/.test(mod));
  /* the growth guard measures against the same 10mb the server reads request bodies with */
  assert.match(src, /express\.json\(\{ limit: "10mb" \}\)/);
  assert.equal(N.BROWSER_SAVE_LIMIT_BYTES, 10 * 1024 * 1024);
});

/* ---------- the real server process ---------- */

async function withServer(env, fn) {
  const port = await freePort();
  const srv = await startProc('server.js', Object.assign({ PORT: String(port) }, env), 'VIVELY app listening on port');
  try { await fn(port, srv); } finally { srv.child.kill(); }
}

test('flag off: no job, ZERO calls to Notion (a recording fake is pointed at), and both endpoints refuse an anonymous caller', async () => {
  const fport = await freePort();
  const fake = await startProc('tools/fake-notion.cjs', { FAKE_NOTION_PORT: String(fport) }, 'fake notion on');
  try {
    await httpJson(fport, 'POST', '/__form', { [DS1]: [row(1)] });
    await withServer({ NOTION_API: 'http://127.0.0.1:' + fport + '/v1', NOTION_TOKEN: 'test-token-not-real', MONGODB_URI: 'mongodb://127.0.0.1:1/never',
      NOTION_APPLICANTS_SYNC: '0' }, async (port, srv) => {
      assert.ok(!/Notion applicants sync: ON/.test(srv.output()));
      await new Promise((r) => setTimeout(r, 400));
      const run = await httpJson(port, 'POST', '/api/notion-applicants/run', {});
      const st = await httpJson(port, 'GET', '/api/notion-applicants/status');
      assert.equal(run.status, 401); assert.equal(st.status, 401);
    });
    const state = await httpJson(fport, 'GET', '/__state');
    assert.deepEqual(state.json.queries, [], 'no query reached Notion');
    assert.deepEqual(state.json.writes, []);
  } finally { fake.child.kill(); }
});

test('flag unset entirely behaves the same: nothing started, nothing said', async () => {
  await withServer({}, async (port, srv) => {
    assert.ok(!/applicants/i.test(srv.output()));
    assert.equal((await httpJson(port, 'POST', '/api/notion-applicants/run', { dryRun: true })).status, 401);
  });
});

test('flag on (token + a Mongo uri set): polling starts, the token is never printed, both endpoints stay staff-only (401 without a session)', async () => {
  await withServer({
    NOTION_APPLICANTS_SYNC: '1', NOTION_APPLICANTS_DRY_RUN: '1', NOTION_TOKEN: 'test-token-not-real', MONGODB_URI: 'mongodb://127.0.0.1:1/never',
    NOTION_API: 'http://127.0.0.1:1/v1', STAFF_EMAILS: 'staff@example.invalid', NOTION_APPLICANTS_INTERVAL_MIN: '60'
  }, async (port, srv) => {
    assert.match(srv.output(), /Notion applicants sync: ON, every 60 min \(dry run: reads Notion, writes nothing\)/);
    assert.ok(!srv.output().includes('test-token-not-real'));
    const run = await httpJson(port, 'POST', '/api/notion-applicants/run', { dryRun: true });
    const st = await httpJson(port, 'GET', '/api/notion-applicants/status');
    assert.equal(run.status, 401); assert.equal(st.status, 401);
  });
});

test('flag set but token or database missing: stays off and says why', async () => {
  await withServer({ NOTION_APPLICANTS_SYNC: '1', MONGODB_URI: 'mongodb://127.0.0.1:1/never' }, async (port, srv) => {
    assert.match(srv.output(), /Notion applicants sync stays off: NOTION_TOKEN is not set/);
    assert.ok(!/Notion applicants sync: ON/.test(srv.output()));
  });
  await withServer({ NOTION_APPLICANTS_SYNC: '1', NOTION_TOKEN: 'test-token-not-real' }, async (port, srv) => {
    assert.match(srv.output(), /Notion applicants sync stays off: MONGODB_URI is not set/);
  });
});

test('the mapping code is loaded from the repo\'s own files; a file that changed shape makes the loader fail closed', () => {
  assert.throws(() => N.sliceDecl('export function other() {\n}\n', 'notionRowToApplicant'), /not found/);
  assert.throws(() => N.sliceDecl('export function f() {\n  return 1;\n', 'f'), /not closed/);
  assert.throws(() => N.loadShared(ROOT + 'tests/fixtures'), /ENOENT|no such file/);
});

/* =====================================================================
   Step 4 follow-up fixes (report 28). Each block below fails against the
   Step 4 code as first delivered and passes now.
   ===================================================================== */

const clockAt = (iso) => { const c = { t: Date.parse(iso || '2026-11-24T10:00:00Z') }; c.now = () => new Date(c.t); c.add = (ms) => { c.t += ms; }; return c; };
const NOW_STATE = (ds) => makeJobState({ campaigns: { cp1: { ds, cursor: null, baselineDone: true } } });

/* ---------- 1. staff edits are not overwritten ---------- */

test('FIX 1: after creation a field follows Notion only while the dashboard still holds what was imported; a staff correction is kept and reported', async () => {
  const { store, table } = baselineWorld();
  const j = job(store, table);
  await j.run();
  const p3 = () => store.doc.db.participants.find((p) => p.notionPageId === pid(3));
  assert.ok(j.js.value.campaigns.cp1.snap[pid(3)], 'a fingerprint was stored for the created row');
  p3().address = 'HAND FIXED ADDRESS (staff)';
  table.rows[DS1][2] = row(3, { edited: '2026-11-22T09:00:00.000Z', props: { Address: 'Notion new address', 'Full Name': 'Fake Person 3 Renamed', Contact: 'new-contact-3' } });
  const run = await j.run();
  const r = cpReport(run, 'cp1');
  assert.equal(p3().address, 'HAND FIXED ADDRESS (staff)', 'the staff correction survives');
  assert.equal(p3().fullName, 'Fake Person 3 Renamed', 'a field staff never touched still follows Notion');
  assert.equal(p3().contact, 'new-contact-3');
  assert.deepEqual(r.edited, [{ participantId: p3().id, field: 'address', why: 'edited-in-dashboard' }]);
  assert.equal(r.counts.edited, 1); assert.equal(run.counts.edited, 1);
  /* a second Notion change to the same field still does not win */
  table.rows[DS1][2] = row(3, { edited: '2026-11-22T10:00:00.000Z', props: { Address: 'Notion newer address', 'Full Name': 'Fake Person 3 Renamed', Contact: 'new-contact-3' } });
  await j.run();
  assert.equal(p3().address, 'HAND FIXED ADDRESS (staff)');
});

test('FIX 1: a Notion edit that changes nothing we read (the Confirmed Visit write-back) writes nothing and says nothing, even on a staff-corrected row', async () => {
  const { store, table } = baselineWorld();
  const j = job(store, table);
  await j.run();
  const p3 = store.doc.db.participants.find((p) => p.notionPageId === pid(3));
  p3.address = 'HAND FIXED ADDRESS (staff)'; p3.fullName = 'Hand Fixed Name';
  const savesBefore = store.saves.length, docBefore = clone(store.doc.db);
  table.rows[DS1][2] = row(3, { edited: '2026-11-22T09:00:00.000Z' });   // only the edit time moved: same answers as when imported
  const run = await j.run();
  assert.equal(store.saves.length, savesBefore, 'no workspace save');
  assert.deepEqual(store.doc.db, docBefore);
  assert.equal(cpReport(run, 'cp1').counts.edited, 0);
});

test('FIX 1: a row the manual import made (no fingerprint) is fill-only: empty fields are filled, a different value is kept and reported', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)], creators: [manualCreator(1)], participants: [manualPart(1, 'cp1')] });
  const table = makeTable({ [DS1]: [row(1, { edited: '2026-11-22T09:00:00.000Z', props: { 'Full Name': 'Notion Name', Address: 'Notion Address' } })] });
  const run = await job(store, table, { jobState: NOW_STATE(DS1) }).run();
  const p = store.doc.db.participants[0];
  assert.equal(p.fullName, 'Old Name 1'); assert.equal(p.address, 'Old Address 1');
  assert.equal(p.headcount, '2', 'the empty field is filled');
  const why = cpReport(run, 'cp1').edited.map((e) => e.field + ':' + e.why).sort();
  assert.ok(why.includes('fullName:no-fingerprint') && why.includes('address:no-fingerprint'), why.join());
});

test('FIX 1: if the job state is lost, nothing is overwritten (fill-only again), and the state holds fingerprints, never the text', async () => {
  const { store, table } = baselineWorld();
  const j = job(store, table);
  await j.run();
  const raw = JSON.stringify(j.js.value);
  ['Fake Street 3', 'Fake Person 3', 'fake-contact-3', 'fake3@example.invalid'].forEach((v) => assert.ok(!raw.includes(v), 'state holds ' + v));
  const p3 = store.doc.db.participants.find((p) => p.notionPageId === pid(3));
  table.rows[DS1][2] = row(3, { edited: '2026-11-22T09:00:00.000Z', props: { Address: 'Notion new address' } });
  const lost = job(store, table, { jobState: NOW_STATE(DS1) });
  await lost.run();
  assert.equal(p3 && store.doc.db.participants.find((p) => p.notionPageId === pid(3)).address, 'Fake Street 3');
});

test('FIX 1: the creator\'s gender is only filled in, never overwritten, on an existing creator and on a returning one', async () => {
  const mapped = Object.assign({}, MAPPING, { gender: 'Gender' });
  const store = makeStore({ campaigns: [campaign('cp1', DS1, { notionMapping: mapped })],
    creators: [Object.assign(manualCreator(1), { gender: 'staff-set' }), Object.assign(manualCreator(2), { gender: 'staff-set' }), manualCreator(3)],
    participants: [manualPart(1, 'cp1')] });
  const table = makeTable({ [DS1]: [row(1, { edited: '2026-11-22T09:00:00.000Z', props: { Gender: 'F' } }), row(2, { props: { Gender: 'F' } }), row(3, { props: { Gender: 'F' } })] });
  await job(store, table, { jobState: makeJobState({ campaigns: { cp1: { ds: DS1, cursor: null, baselineDone: true } } }) }).run();
  const g = (id) => store.doc.db.creators.find((c) => c.id === id).gender;
  assert.equal(g('crOLD1'), 'staff-set'); assert.equal(g('crOLD2'), 'staff-set'); assert.equal(g('crOLD3'), 'F', 'an empty gender is filled in');
});

/* ---------- 2. held rows are retried; run history ---------- */

function heldWorld(statusOfRow1) {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const table = makeTable({ [DS1]: [row(1, { props: { Status: statusOfRow1 || 'Some New Word' }, edited: edit(1) }), row(2, { edited: edit(2) })] });
  table.pageCalls = [];
  table.getPage = async (id) => {
    table.pageCalls.push(id);
    if (table.pageFail) { const e = new Error('x'); e.status = table.pageFail; if (table.pageFail === 429) { e.rateLimited = true; e.vcode = 'rate-limited'; } throw e; }
    const r = table.rows[DS1].find((x) => x.pageId === id);
    return r && !r.archived ? clone(r) : null;
  };
  return { store, table };
}

test('FIX 2: a held row is remembered by page id (no personal data) and read again by id on the next run, so it is not skipped forever', async () => {
  const { store, table } = heldWorld();
  const clock = clockAt();
  const j = job(store, table, { getPage: table.getPage, now: clock.now });
  const r1 = await j.run();
  assert.deepEqual(cpReport(r1, 'cp1').held, [{ pageId: pid(1), why: 'unknown-status' }]);
  assert.equal(rosterOf(store, 'cp1').length, 1, 'only row 2 was created');
  assert.deepEqual(Object.keys(j.js.value.campaigns.cp1.held), [pid(1)]);
  assert.equal(j.js.value.campaigns.cp1.held[pid(1)].why, 'unknown-status');
  assert.ok(!JSON.stringify(j.js.value).includes('Some New Word') && !JSON.stringify(j.js.value).includes('Fake Person 1'));
  assert.equal(j.js.value.campaigns.cp1.cursor, edit(2), 'the cursor moved past the held row');
  /* Notion now has a status we know, but the row's edit time is older than the cursor (as after a code change that adds a status) */
  table.rows[DS1][0] = row(1, { props: { Status: 'Confirmed' }, edited: edit(1) });
  clock.add(120000);
  const r2 = await j.run();
  assert.deepEqual(table.pageCalls, [pid(1)]);
  assert.equal(cpReport(r2, 'cp1').counts.created, 1, 'the held row came in');
  assert.equal(rosterOf(store, 'cp1').length, 2);
  assert.deepEqual(j.js.value.campaigns.cp1.held, {}, 'and left the held list');
  /* nothing left to retry on the next run */
  clock.add(120000); table.pageCalls.length = 0;
  await j.run();
  assert.deepEqual(table.pageCalls, []);
});

test('FIX 2: retries are bounded: a per-run cap, every run for 10 tries and then at most once an hour, and a trashed or hidden row leaves the list', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const table = makeTable({ [DS1]: [1, 2, 3].map((n) => row(n, { props: { Status: 'Some New Word' }, edited: edit(n) })).concat([row(9, { edited: edit(9) })]) });
  table.pageCalls = [];
  table.getPage = async (id) => { table.pageCalls.push(id); const r = table.rows[DS1].find((x) => x.pageId === id); return r && !r.archived ? clone(r) : null; };
  const clock = clockAt();
  const j = job(store, table, { getPage: table.getPage, now: clock.now, maxHeldRetry: 2 });
  await j.run();
  assert.equal(Object.keys(j.js.value.campaigns.cp1.held).length, 3);
  table.pageCalls.length = 0;
  clock.add(120000); await j.run();
  assert.equal(table.pageCalls.length, 2, 'cap of 2 held rows read per run');
  clock.add(120000); table.pageCalls.length = 0; await j.run();
  assert.equal(table.pageCalls.length, 2);
  assert.notDeepEqual(table.pageCalls.slice().sort(), []);
  /* wear one row down to 10 tries: it then waits an hour */
  const j2 = job(makeStore({ campaigns: [campaign('cp1', DS1)] }), table, { getPage: table.getPage, now: clock.now, maxHeldRetry: 50 });
  await j2.run();
  for (let i = 0; i < 10; i++) { clock.add(120000); await j2.run(); }
  assert.ok(j2.js.value.campaigns.cp1.held[pid(1)].tries >= 10);
  table.pageCalls.length = 0; clock.add(120000); await j2.run();
  assert.deepEqual(table.pageCalls, [], 'after 10 tries, not on every run');
  clock.add(3600000); await j2.run();
  assert.equal(table.pageCalls.length, 3, 'but once an hour');
  /* a row trashed in Notion, or no longer visible, leaves the list */
  table.rows[DS1][0].archived = true;
  clock.add(3600000); await j2.run();
  assert.ok(!j2.js.value.campaigns.cp1.held[pid(1)]);
  table.getPage = async (id) => { if (id === pid(2)) { const e = new Error('x'); e.status = 404; throw e; } return null; };
  const j3 = job(makeStore({ campaigns: [campaign('cp1', DS1)] }), makeTable({ [DS1]: [row(2, { props: { Status: 'Some New Word' }, edited: edit(2) }), row(9, { edited: edit(9) })] }), { getPage: table.getPage, now: clock.now });
  await j3.run(); clock.add(120000); await j3.run();
  assert.deepEqual(j3.js.value.campaigns.cp1.held, {});
});

test('FIX 2: the last N run summaries are kept (newest N, no per-row lists) and staff can read them with the held list', async () => {
  const col = { docs: {}, async updateOne(q, u) {
    const d = this.docs[q._id] || (this.docs[q._id] = { _id: q._id });
    if (u.$set) Object.assign(d, clone(u.$set));
    if (u.$push) Object.entries(u.$push).forEach(([k, v]) => { d[k] = (d[k] || []).concat(clone(v.$each)).slice(v.$slice); });
  }, async findOne(q) { return this.docs[q._id] ? clone(this.docs[q._id]) : null; } };
  const logStore = N.makeLogStore(col, 20);
  const { store, table } = heldWorld();
  const clock = clockAt();
  const j = job(store, table, { getPage: table.getPage, now: clock.now, saveLog: logStore.save });
  for (let i = 0; i < 25; i++) { clock.add(120000); await j.run(); }
  const hist = await logStore.readHistory();
  assert.equal(hist.length, 20, 'only the newest 20');
  assert.equal(hist.at(-1).at, clock.now().toISOString());
  assert.ok(hist[0].at > '2026-11-24T10:00:00.000Z' && hist[0].at < hist.at(-1).at);
  assert.ok(!('created' in hist[0].campaigns[0]) && !('held' in hist[0].campaigns[0]), 'compact: counts and codes only');
  assert.equal((await logStore.readLast()).trigger, 'poll');
  assert.ok(!JSON.stringify(col.docs).includes('Fake Person'));
  const sum = await j.stateSummary();
  assert.deepEqual(sum.held, [{ campaignId: 'cp1', pageId: pid(1), why: 'unknown-status', since: sum.held[0].since, tries: sum.held[0].tries }]);
});

/* ---------- 3. Notion load: timeout, Retry-After, backoff, stop on repeated 429 ---------- */

const UUID1 = pid(1);
const err = (status, extra) => Object.assign(new Error('Notion said sentinel-text-should-not-surface'), { status }, extra || {});
function callerWith(responses, o) {
  const log = { calls: [], sleeps: [], signals: [] }; const clock = { t: 1000000 };
  const raw = async (p, init) => { log.calls.push({ p, method: init.method, body: init.body }); log.signals.push(init.signal); const r = responses.shift(); if (r instanceof Error) throw r; return r; };
  const sleep = async (ms) => { log.sleeps.push(ms); clock.t += ms; };
  const call = N.makeNotionCaller(raw, Object.assign({ sleep, now: () => clock.t, minGapMs: 0 }, o || {}));
  return { call, log, clock };
}

test('FIX 3: every request carries a timeout signal; a 429 with Retry-After waits at least that long, then succeeds', async () => {
  const { call, log } = callerWith([err(429, { retryAfter: 3 }), { ok: true }]);
  assert.deepEqual(await call('GET', '/pages/' + UUID1), { ok: true });
  assert.equal(log.calls.length, 2);
  assert.ok(log.sleeps[0] >= 3000, 'waited ' + log.sleeps[0]);
  assert.ok(log.signals.every((s) => s && typeof s.aborted === 'boolean'), 'an AbortSignal on every request');
});

test('FIX 3: 5xx and network errors back off exponentially (1 s, 2 s, 4 s), bounded; the error that comes out has a code, never Notion\'s text', async () => {
  const { call, log } = callerWith([err(503), err(500), err(502), err(500)]);
  await assert.rejects(() => call('GET', '/pages/' + UUID1), (e) => {
    assert.equal(e.vcode, 'http-500'); assert.equal(e.status, 500); assert.ok(!/sentinel-text/.test(e.message)); return true; });
  assert.deepEqual(log.sleeps, [1000, 2000, 4000]);
  assert.equal(log.calls.length, 4, 'one try plus 3 retries, then stop');
  const net = callerWith([Object.assign(new TypeError('fetch failed'), {}), { ok: 1 }]);
  assert.deepEqual(await net.call('GET', '/pages/' + UUID1), { ok: 1 });
  const none = callerWith([err(429), err(429)], { maxRetries: 0 });
  await assert.rejects(() => none.call('GET', '/pages/' + UUID1), (e) => e.rateLimited === true && e.vcode === 'rate-limited');
});

test('FIX 3: a permanent failure is not retried; a Retry-After longer than the cap is not waited out; a timeout is retried then reported as a timeout', async () => {
  const perm = callerWith([err(400)]);
  await assert.rejects(() => perm.call('GET', '/pages/' + UUID1), (e) => e.status === 400);
  assert.equal(perm.log.calls.length, 1); assert.deepEqual(perm.log.sleeps, []);
  const long = callerWith([err(429, { retryAfter: 600 })]);
  await assert.rejects(() => long.call('GET', '/pages/' + UUID1), (e) => e.rateLimited && e.retryAfterSec === 600);
  assert.deepEqual(long.log.sleeps, [], 'did not sleep 10 minutes inside a request');
  const to = callerWith([Object.assign(new Error('t'), { name: 'TimeoutError' }), Object.assign(new Error('t'), { name: 'TimeoutError' })], { maxRetries: 1 });
  await assert.rejects(() => to.call('GET', '/pages/' + UUID1), (e) => e.vcode === 'timeout');
  assert.equal(to.log.calls.length, 2);
});

test('FIX 3: a gap is kept between requests, and only the three read requests are allowed at all', async () => {
  const { call, log } = callerWith([{ a: 1 }, { a: 2 }], { minGapMs: 350 });
  await call('GET', '/pages/' + UUID1); await call('GET', '/pages/' + UUID1);
  assert.deepEqual(log.sleeps, [350]);
  const ds = AC.normalizeId(hex(9001));
  const ok = callerWith([{}, {}, {}]);
  await ok.call('POST', '/data_sources/' + ds + '/query', { page_size: 1 }); await ok.call('GET', '/data_sources/' + ds); await ok.call('GET', '/pages/' + UUID1);
  const bad = callerWith([{}]);
  for (const [m, p] of [['PATCH', '/pages/' + UUID1], ['POST', '/pages'], ['GET', '/users'], ['POST', '/data_sources/' + ds], ['DELETE', '/blocks/' + UUID1], ['GET', '/pages/not-an-id'], ['POST', '/search']]) {
    await assert.rejects(() => bad.call(m, p, {}), (e) => e.vcode === 'not-allowed', m + ' ' + p);
  }
  assert.equal(bad.log.calls.length, 0, 'nothing reached the network');
});

function realNotionFetch(base) {
  const src = fs.readFileSync(ROOT + 'server.js', 'utf8');
  const a = src.indexOf('async function notionFetch(path, opts) {');
  const b = src.indexOf('\n}\n', a);
  assert.ok(a > 0 && b > a, 'notionFetch found in server.js');
  return new Function('fetch', 'NOTION_API', 'NOTION_TOKEN', 'NOTION_VERSION', 'return (' + src.slice(a, b + 2) + ');')(fetch, base, 'test-token-not-real', '2025-09-03');
}
async function withHttp(handler, fn) {
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.method + ' ' + req.url); handler(req, res, hits.length); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn('http://127.0.0.1:' + srv.address().port + '/v1', hits); } finally { srv.closeAllConnections(); srv.close(); }
}

test('FIX 3 over real HTTP: the real notionFetch exposes Retry-After, the caller honours it; a server that never answers is cut off by the timeout', async () => {
  await withHttp((req, res, n) => {
    if (n === 1) { res.writeHead(429, { 'Retry-After': '2', 'Content-Type': 'application/json' }); res.end('{"message":"slow down sentinel-text"}'); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"object":"page","id":"x"}'); }
  }, async (base, hits) => {
    const sleeps = [];
    const call = N.makeNotionCaller(realNotionFetch(base), { sleep: async (ms) => { sleeps.push(ms); }, minGapMs: 0 });
    assert.equal((await call('GET', '/pages/' + UUID1)).object, 'page');
    assert.equal(hits.length, 2); assert.ok(sleeps[0] >= 2000, 'waited ' + sleeps[0]);
  });
  await withHttp((req, res, n) => { /* never answers */ }, async (base, hits) => {
    const call = N.makeNotionCaller(realNotionFetch(base), { sleep: async () => {}, minGapMs: 0, timeoutMs: 80, maxRetries: 1 });
    await assert.rejects(() => call('GET', '/pages/' + UUID1), (e) => e.vcode === 'timeout');
    assert.equal(hits.length, 2, 'tried twice, each cut off');
  });
});

test('FIX 3: repeated 429 stops the WHOLE run (the next campaign is not asked), is reported, and the job rests before it asks again', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1), campaign('cp2', DS2)] });
  const table = makeTable({ [DS1]: [row(1)], [DS2]: [row(2)] });
  table.failWith = { status: 429, message: 'sentinel-text', rateLimited: true, retryAfterSec: 30 };
  const clock = clockAt(); const logs = [];
  const j = job(store, table, { now: clock.now, logs });
  const r1 = await j.run();
  assert.deepEqual(table.calls.map((c) => c.ds), [DS1], 'cp2 was never asked');
  assert.equal(r1.aborted, 'rate-limited'); assert.equal(r1.ok, false);
  assert.equal(cpReport(r1, 'cp1').why, 'query-failed:rate-limited');
  assert.equal(r1.remaining.campaignsNotVisited, 1);
  assert.ok(r1.errors.some((e) => /rate-limited/.test(e)));
  assert.ok(!logs.join('\n').includes('sentinel-text'));
  assert.equal(store.saves.length, 0);
  /* resting: no Notion call at all until the cool-down is over */
  table.failWith = null; table.calls.length = 0;
  clock.add(60000);
  const r2 = await j.run();
  assert.equal(r2.skipped, 'cooling-down'); assert.equal(table.calls.length, 0);
  clock.add(300000);
  const r3 = await j.run();
  assert.equal(r3.ok, true); assert.deepEqual(table.calls.map((c) => c.ds).sort(), [DS1, DS2].sort());
});

/* ---------- 4. workspace growth guard ---------- */

test('FIX 4: past 80% of the save limit no row is added: reported as workspace-near-limit, the cursor stays, and the rows arrive once there is room', async () => {
  const filler = { id: 'crBIG', handle: '@fake.filler', name: 'Z'.repeat(12000), platform: 'Instagram', followers: 1, email: '', contact: '', address: '' };
  const store = makeStore({ campaigns: [campaign('cp1', DS1)], creators: [filler] });
  const table = makeTable({ [DS1]: [row(1), row(2)] });
  const j = job(store, table, { docLimitBytes: 20000, docLimitFraction: 0.5 });   // threshold 10000 bytes, the document is above it
  const r1 = await j.run();
  assert.equal(rosterOf(store, 'cp1').length, 0, 'nothing added');
  assert.equal(store.saves.length, 0);
  assert.deepEqual(r1.warnings, ['workspace-near-limit']); assert.equal(r1.counts.warnings, 1);
  assert.equal(cpReport(r1, 'cp1').workspace, 'workspace-near-limit');
  assert.deepEqual(cpReport(r1, 'cp1').deferred.map((d) => d.why), ['workspace-near-limit', 'workspace-near-limit']);
  assert.equal(r1.remaining.creates, 2);
  assert.equal(j.js.value.campaigns.cp1.cursor, edit(1), 'the cursor stays AT the first deferred row (it is read again), not past it');
  /* room again (someone cleans the workspace): the same rows are picked up */
  store.doc.db.creators[0].name = 'short';
  const r2 = await j.run();
  assert.equal(rosterOf(store, 'cp1').length, 2); assert.deepEqual(r2.warnings, []);
});

test('FIX 4: the share is configurable, defaults to 80% of 10 MB, and a normal workspace is not refused', async () => {
  const c = N.parseConfig({});
  assert.equal(c.docLimitFraction, 0.8); assert.equal(c.docLimitBytes, 10 * 1024 * 1024);
  assert.equal(N.parseConfig({ NOTION_APPLICANTS_DOC_LIMIT_FRACTION: '0.5' }).docLimitFraction, 0.5);
  assert.equal(N.parseConfig({ NOTION_APPLICANTS_DOC_LIMIT_FRACTION: '7' }).docLimitFraction, 0.95);
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const r = await job(store, makeTable({ [DS1]: [row(1)] })).run();
  assert.equal(rosterOf(store, 'cp1').length, 1); assert.deepEqual(r.warnings, []);
});

/* ---------- 5. minimum gap between staff runs ---------- */

test('FIX 5: a staff-triggered run within 30 s of the last one is refused (with the wait); polls are not limited', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const table = makeTable({ [DS1]: [row(1)] });
  const clock = clockAt();
  const j = job(store, table, { now: clock.now, manualMinSec: 30 });
  const a = await j.run({ trigger: 'manual' });
  assert.equal(a.ok, true);
  clock.add(10000);
  const b = await j.run({ trigger: 'manual', dryRun: true });
  assert.equal(b.throttled, true); assert.equal(b.retryAfterSec, 20);
  assert.equal((await j.run({ trigger: 'poll' })).ok, true, 'the timer is not throttled');
  clock.add(21000);
  assert.equal((await j.run({ trigger: 'manual' })).ok, true);
  assert.equal(N.parseConfig({}).manualMinSec, 30);
});

/* ---------- 7. poll interval ---------- */

test('FIX 7: the poll interval is 2 minutes by default, env-configurable, never below 1 minute', () => {
  assert.equal(N.parseConfig({}).intervalMin, 2); assert.equal(N.parseConfig({}).intervalMs, 120000);
  assert.equal(N.parseConfig({ NOTION_APPLICANTS_INTERVAL_MIN: '5' }).intervalMs, 300000);
  assert.equal(N.parseConfig({ NOTION_APPLICANTS_INTERVAL_MIN: '0.2' }).intervalMin, 1);
  assert.equal(N.parseConfig({ NOTION_APPLICANTS_INTERVAL_MIN: '1' }).intervalMs, 60000);
  ['0', '-3', 'junk', ''].forEach((v) => assert.equal(N.parseConfig({ NOTION_APPLICANTS_INTERVAL_MIN: v }).intervalMin, 2, v));
});

test('FIX 7: the first run per campaign is still the baseline (the 2-minute poll does not change that)', async () => {
  const { store, table } = baselineWorld();
  const j = job(store, table);
  const r1 = await j.run();
  assert.equal(cpReport(r1, 'cp1').baseline, true);
  assert.equal(cpReport(await j.run(), 'cp1').baseline, false);
});

/* ---------- 8. hands-free default mapping ---------- */

const SCHEMA_OK = { 'Full Name': { type: 'title' }, Nationality: { type: 'rich_text' }, 'Instagram Link': { type: 'url' }, Followers: { type: 'number' },
  Status: { type: 'status' }, 'Submission time': { type: 'created_time' }, 'Visit Date': { type: 'date' }, Contact: { type: 'rich_text' } };
function schemaDeps(schemas) {
  const s = { calls: [] };
  s.getSchema = async (ds) => { s.calls.push(ds); const v = schemas[ds]; if (v instanceof Error) throw v; return { properties: v }; };
  return s;
}
const unmapped = (id, ds) => campaign(id, ds, { notionMapping: null });
const FIELD_KEYS = (shared.bind(null).NOTION_FIELD_DEFS || []).map((f) => f.key);

test('FIX 8: buildDefaultMapping needs every required column with its expected type, and names exactly what is missing; it never guesses', () => {
  const ok = N.buildDefaultMapping(SCHEMA_OK, FIELD_KEYS);
  assert.deepEqual(Object.keys(ok.mapping), FIELD_KEYS, 'every field key is present, the same shape the mapping screen saves');
  assert.deepEqual(Object.entries(ok.mapping).filter(([, v]) => v).sort(), [['fullName', 'Full Name'], ['followers', 'Followers'], ['instagram', 'Instagram Link'], ['nationality', 'Nationality'], ['status', 'Status'], ['visitAt', 'Visit Date']].sort());
  assert.equal(ok.mapping.contact, null, 'an optional column is not guessed');
  const s = clone(SCHEMA_OK);
  delete s['Visit Date']; s.Followers = { type: 'rich_text' }; s['Instagram Link'] = { type: 'rich_text' }; delete s['Submission time'];
  const bad = N.buildDefaultMapping(s, FIELD_KEYS);
  assert.equal(bad.mapping, undefined);
  assert.deepEqual(bad.missing.map((m) => [m.property, m.expected, m.found]).sort(), [
    ['Followers', 'number', 'rich_text'], ['Instagram Link', 'url', 'rich_text'], ['Submission time', 'created_time or date', null], ['Visit Date', 'date', null]].sort());
  /* a look-alike name or type is not accepted */
  assert.ok(N.buildDefaultMapping(Object.assign({}, SCHEMA_OK, { Status: { type: 'rich_text' } }), FIELD_KEYS).missing);
  assert.ok(N.buildDefaultMapping(Object.assign(clone(SCHEMA_OK), { 'full name': { type: 'title' } }), FIELD_KEYS).missing, 'two columns with one name is ambiguous');
  assert.ok(N.buildDefaultMapping({}, FIELD_KEYS).missing.length === 7);
  assert.ok(N.buildDefaultMapping(null, FIELD_KEYS).missing.length === 7);
});

test('FIX 8: a campaign with a Responses data source and no mapping gets the default mapping saved (never forced) and its rows come in on the same run', async () => {
  const store = makeStore({ campaigns: [unmapped('cp1', DS1)] });
  const table = makeTable({ [DS1]: [row(1), row(2)] });
  const sc = schemaDeps({ [DS1]: SCHEMA_OK });
  const j = job(store, table, { getSchema: sc.getSchema });
  const run = await j.run();
  const m = store.doc.db.campaigns[0].notionMapping;
  assert.deepEqual(Object.keys(m), FIELD_KEYS);
  assert.equal(m.instagram, 'Instagram Link'); assert.equal(m.status, 'Status'); assert.equal(m.visitAt, 'Visit Date');
  assert.equal(cpReport(run, 'cp1').mapping, 'saved');
  assert.equal(cpReport(run, 'cp1').counts.created, 2);
  assert.equal(store.saves.length, 2, 'one save for the mapping, one for the rows');
  assert.ok(store.saves.every((s) => !s.keys.includes('force')));
  assert.equal(cpReport(run, 'cp1').baseline, true);
  /* the next run does not read the schema again */
  await j.run();
  assert.deepEqual(sc.calls, [DS1]);
});

test('FIX 8: an incomplete form is skipped and the exact missing or wrong-typed property is reported; nothing is saved, no row is read, and it is looked at again only after 10 minutes', async () => {
  const s = clone(SCHEMA_OK); delete s['Visit Date']; s.Followers = { type: 'rich_text' };
  const store = makeStore({ campaigns: [unmapped('cp1', DS1)] });
  const table = makeTable({ [DS1]: [row(1)] });
  const sc = schemaDeps({ [DS1]: s });
  const clock = clockAt();
  const j = job(store, table, { getSchema: sc.getSchema, now: clock.now });
  const run = await j.run();
  const r = cpReport(run, 'cp1');
  assert.equal(r.status, 'skipped'); assert.equal(r.why, 'mapping-incomplete');
  assert.deepEqual(r.missing, [{ property: 'Followers', expected: 'number', found: 'rich_text' }, { property: 'Visit Date', expected: 'date', found: null }]);
  assert.equal(store.saves.length, 0); assert.equal(store.doc.db.campaigns[0].notionMapping, null);
  assert.equal(table.calls.length, 0, 'no rows were read');
  clock.add(120000); const again = await j.run();
  assert.deepEqual(cpReport(again, 'cp1').missing, r.missing); assert.equal(sc.calls.length, 1, 'not re-read within 10 minutes');
  /* the form is fixed in Notion: picked up after the wait */
  sc.getSchema = null; const fixed = schemaDeps({ [DS1]: SCHEMA_OK });
  const j2 = job(store, table, { getSchema: fixed.getSchema, now: clock.now });
  assert.equal(cpReport(await j2.run(), 'cp1').mapping, 'saved');
});

test('FIX 8: a dry run saves nothing (no mapping, no rows) and says what it would do; a campaign that already has a mapping is never touched or asked about', async () => {
  const store = makeStore({ campaigns: [unmapped('cp1', DS1), campaign('cp2', DS2), campaign('cp3', AC.normalizeId(hex(9003)), { notionMapping: { status: 'Status' } })] });
  const table = makeTable({ [DS1]: [row(1)], [DS2]: [row(2)], [AC.normalizeId(hex(9003))]: [] });
  const sc = schemaDeps({ [DS1]: SCHEMA_OK, [DS2]: SCHEMA_OK });
  const before = clone(store.doc);
  const run = await job(store, table, { getSchema: sc.getSchema }).run({ dryRun: true });
  assert.deepEqual(store.doc, before); assert.equal(store.saves.length, 0);
  assert.equal(cpReport(run, 'cp1').mapping, 'would-save'); assert.equal(cpReport(run, 'cp1').counts.created, 1);
  assert.deepEqual(sc.calls, [DS1], 'only the unmapped campaign was looked up');
  assert.equal(cpReport(run, 'cp3').why, 'no-mapping', 'a partial mapping a person made is not replaced');
});

test('FIX 8: without a schema reader the old behaviour holds (no-mapping); a failing schema read is reported by code; a 429 on it stops the run', async () => {
  const store = makeStore({ campaigns: [unmapped('cp1', DS1), unmapped('cp2', DS2)] });
  const table = makeTable({ [DS1]: [row(1)], [DS2]: [row(2)] });
  assert.equal(cpReport(await job(store, table).run(), 'cp1').why, 'no-mapping');
  const e500 = Object.assign(new Error('sentinel-text'), { status: 500, vcode: 'http-500' });
  const r = await job(store, table, { getSchema: async () => { throw e500; } }).run();
  assert.equal(cpReport(r, 'cp1').why, 'schema-failed:http-500'); assert.ok(!JSON.stringify(r).includes('sentinel-text'));
  const e429 = Object.assign(new Error('x'), { status: 429, rateLimited: true, vcode: 'rate-limited' });
  const calls = [];
  const r2 = await job(store, table, { getSchema: async (ds) => { calls.push(ds); throw e429; } }).run();
  assert.equal(r2.aborted, 'rate-limited'); assert.equal(calls.length, 1);
});

/* ---------- 9. real routing for the staff endpoints ---------- */

function realRequireStaff() {
  const src = fs.readFileSync(ROOT + 'server.js', 'utf8');
  const a = src.indexOf('function requireStaff(handler) {');
  const b = src.indexOf('\n}\n', a);
  assert.ok(a > 0 && b > a, 'requireStaff found in server.js');
  /* the real guard; only the session lookup (needs Mongo) is a stand-in: the test names the caller in a header */
  const loadSession = async (req) => { const e = req.headers['x-test-user']; return e ? { email: e } : null; };
  return new Function('loadSession', 'auth', 'STAFF_EMAILS', 'console', 'return (' + src.slice(a, b + 2) + ');')(
    loadSession, require('../server/auth.js'), ['staff@example.invalid'], { error() {}, log() {} });
}
async function withRoutes(get, fn) {
  const express = require('express');
  const app = express(); app.use(express.json());
  N.registerRoutes(app, realRequireStaff(), get);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = (method, p, user, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = Object.assign({}, user ? { 'x-test-user': user } : {}, data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {});
    const r = http.request({ host: '127.0.0.1', port: srv.address().port, path: p, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }));
    });
    r.on('error', reject); r.end(data);
  });
  try { await fn(call); } finally { srv.close(); }
}

test('FIX 9: the staff endpoints, mounted behind the real requireStaff: 401 anonymous, 403 for a signed-in non-staff account, 200 for staff, and only staff reach the job', async () => {
  const seen = [];
  const fake = { run: async (o) => { seen.push(o); return { ok: true, at: 'x', campaigns: [] }; }, stateSummary: async () => ({ heldRows: 0, held: [] }), lastRun: () => ({ at: 'x' }) };
  const get = () => ({ applicants: fake, off: '', cfg: { intervalMin: 2, dryRun: false }, logStore: { readHistory: async () => [{ at: 'h1' }, { at: 'h2' }], readLast: async () => null } });
  await withRoutes(get, async (call) => {
    for (const [m, p] of [['POST', '/api/notion-applicants/run'], ['GET', '/api/notion-applicants/status']]) {
      const anon = await call(m, p, null, m === 'POST' ? {} : null);
      assert.equal(anon.status, 401, m + ' anonymous'); assert.equal(anon.json.auth, 'required');
      const other = await call(m, p, 'someone@example.invalid', m === 'POST' ? {} : null);
      assert.equal(other.status, 403, m + ' non-staff'); assert.equal(other.json.auth, 'forbidden');
    }
    assert.deepEqual(seen, [], 'the job was never reached by a caller who is not staff');
    const run = await call('POST', '/api/notion-applicants/run', 'STAFF@example.invalid', { dryRun: true, campaignId: 'cp1', rescan: ['cp2', 5] });
    assert.equal(run.status, 200); assert.equal(run.json.ok, true);
    assert.deepEqual(seen, [{ trigger: 'manual', dryRun: true, campaignId: 'cp1', rescan: ['cp2'] }]);
    const st = await call('GET', '/api/notion-applicants/status', 'staff@example.invalid');
    assert.equal(st.status, 200); assert.deepEqual(st.json.history.map((h) => h.at), ['h1', 'h2']); assert.equal(st.json.intervalMin, 2);
    /* a request can only make a run more careful */
    await call('POST', '/api/notion-applicants/run', 'staff@example.invalid', { dryRun: false });
    assert.equal(seen.at(-1).dryRun, undefined);
  });
});

test('FIX 9: through the same routing, a second staff run within 30 s answers 429 with the wait; a server with the job off answers 503 with the reason (after the auth checks)', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const clock = clockAt();
  const j = job(store, makeTable({ [DS1]: [row(1)] }), { now: clock.now, manualMinSec: 30 });
  await withRoutes(() => ({ applicants: j, off: '', cfg: { intervalMin: 2, dryRun: false }, logStore: null }), async (call) => {
    const a = await call('POST', '/api/notion-applicants/run', 'staff@example.invalid', {});
    assert.equal(a.status, 200); assert.equal(a.json.run.counts.created, 1);
    const b = await call('POST', '/api/notion-applicants/run', 'staff@example.invalid', {});
    assert.equal(b.status, 429); assert.ok(b.json.retryAfterSec > 0);
  });
  await withRoutes(() => ({ applicants: null, off: 'NOTION_APPLICANTS_SYNC is not 1', cfg: {}, logStore: null }), async (call) => {
    assert.equal((await call('POST', '/api/notion-applicants/run', null, {})).status, 401);
    assert.equal((await call('POST', '/api/notion-applicants/run', 'x@example.invalid', {})).status, 403);
    const off = await call('POST', '/api/notion-applicants/run', 'staff@example.invalid', {});
    assert.equal(off.status, 503); assert.equal(off.json.reason, 'NOTION_APPLICANTS_SYNC is not 1');
    const st = await call('GET', '/api/notion-applicants/status', 'staff@example.invalid');
    assert.equal(st.status, 200); assert.equal(st.json.enabled, false);
  });
});

/* ---------- hands-free flow end to end over HTTP (real notionFetch + guarded caller + fake Notion) ---------- */

test('hands-free over HTTP against tools/fake-notion.cjs: schema read, default mapping saved, rows imported; only reads reach Notion; an incomplete form is reported and left alone', async () => {
  const port = await freePort();
  const fake = await startProc('tools/fake-notion.cjs', { FAKE_NOTION_PORT: String(port) }, 'fake notion on');
  try {
    const rows = [1, 2, 3].map((n) => ({ pageId: pid(n), createdTime: '2026-11-19T01:00:00.000Z', lastEditedTime: edit(n), properties: row(n).properties }));
    await httpJson(port, 'POST', '/__form', { [DS1]: rows, [DS2]: rows.slice(0, 1) });
    const types = { 'Full Name': 'title', Nationality: 'rich_text', 'Instagram Link': 'url', Followers: 'number', Status: 'status', 'Submission time': 'created_time', 'Visit Date': 'date' };
    await httpJson(port, 'POST', '/__schema', { [DS1]: types, [DS2]: Object.assign({}, types, { 'Visit Date': 'rich_text' }) });
    const api = N.makeNotionApi(realNotionFetch('http://127.0.0.1:' + port + '/v1'), realExtractNotionValue(), { sleep: async () => {}, minGapMs: 0 });
    const store = makeStore({ campaigns: [unmapped('cp1', DS1), unmapped('cp2', DS2)] });
    const j = N.createApplicants({ shared, loadWorkspace: store.load, saveWorkspace: store.save, queryRows: api.queryRows, getPage: api.getPage, getSchema: api.getSchema,
      newId: (p) => p + 'HF' + (++idN), now: () => new Date('2026-11-24T10:00:00Z'), logger: { error() {}, log() {} }, manualMinSec: 0 });
    const run = await j.run();
    assert.equal(cpReport(run, 'cp1').mapping, 'saved'); assert.equal(cpReport(run, 'cp1').counts.created, 3);
    assert.equal(store.doc.db.campaigns[0].notionMapping.visitAt, 'Visit Date');
    assert.deepEqual(cpReport(run, 'cp2').missing, [{ property: 'Visit Date', expected: 'date', found: 'rich_text' }]);
    assert.equal(store.doc.db.campaigns[1].notionMapping, null);
    const st = await httpJson(port, 'GET', '/__state');
    assert.deepEqual(st.json.writes, [], 'nothing was written to Notion');
    assert.deepEqual(st.json.schemaReads.sort(), [DS1, DS2].sort());
    assert.ok(st.json.queries.every((q) => q.id === DS1), 'the incomplete form was never queried');
  } finally { fake.child.kill(); }
});

/* ---------- gaps found by the mutation run (report 28) ---------- */

test('FIX 8: a mapping a person saved while the job was reading the schema is never replaced', async () => {
  const store = makeStore({ campaigns: [unmapped('cp1', DS1)] });
  const table = makeTable({ [DS1]: [row(1)] });
  const getSchema = async () => { store.doc.db.campaigns[0].notionMapping = Object.assign({}, MAPPING, { instagram: 'My Own Column' }); return { properties: SCHEMA_OK }; };
  const run = await job(store, table, { getSchema }).run();
  assert.equal(store.doc.db.campaigns[0].notionMapping.instagram, 'My Own Column');
  assert.equal(cpReport(run, 'cp1').mapping, 'existing');
});

test('FIX 2: a held row retried while the create cap is used up stays held (reason create-cap); it is not counted as deferred and does not hold the cursor back', async () => {
  const { store, table } = heldWorld();
  const clock = clockAt();
  const j1 = job(store, table, { getPage: table.getPage, now: clock.now });
  await j1.run();                                           // row 2 comes in, row 1 is held
  const j = job(store, table, { getPage: table.getPage, now: clock.now, maxCreate: 0, jobState: j1.js });
  table.rows[DS1][0] = row(1, { props: { Status: 'Confirmed' }, edited: edit(1) });
  clock.add(120000);
  const r = await j.run();
  assert.equal(cpReport(r, 'cp1').counts.deferred, 0); assert.equal(r.remaining.creates, 0);
  assert.deepEqual(cpReport(r, 'cp1').held, [{ pageId: pid(1), why: 'create-cap' }]);
  assert.equal(j.js.value.campaigns.cp1.held[pid(1)].why, 'create-cap');
  assert.equal(j.js.value.campaigns.cp1.cursor, edit(2), 'the cursor is not pulled back to the retried row');
});

test('FIX 2: an ambiguous row is remembered too, and comes in once the ambiguity is gone', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)],
    creators: [{ id: 'crA1', handle: '@fake.creator1', name: 'A' }, { id: 'crA2', handle: 'https://instagram.com/Fake.Creator1', name: 'B' }] });
  const table = makeTable({ [DS1]: [row(1, { edited: edit(1) }), row(2, { edited: edit(2) })] });
  table.getPage = async (id) => { const r = table.rows[DS1].find((x) => x.pageId === id); return r ? clone(r) : null; };
  const clock = clockAt();
  const j = job(store, table, { getPage: table.getPage, now: clock.now });
  await j.run();
  assert.equal(j.js.value.campaigns.cp1.held[pid(1)].why, 'duplicate-creators');
  store.doc.db.creators = store.doc.db.creators.filter((c) => c.id !== 'crA2');   // staff merged the duplicate
  clock.add(120000);
  const r = await j.run();
  assert.equal(cpReport(r, 'cp1').counts.created, 1);
  assert.deepEqual(j.js.value.campaigns.cp1.held, {});
});

test('FIX 4: the size is kept up to date inside one run: rows added to the first campaign count against the second', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1), campaign('cp2', DS2)] });
  const size0 = Buffer.byteLength(JSON.stringify({ db: store.doc.db, settings: store.doc.settings }), 'utf8');
  const table = makeTable({ [DS1]: [1, 2, 3, 4].map((n) => row(n)), [DS2]: [row(9)] });
  const r = await job(store, table, { docLimitBytes: size0 + 3000, docLimitFraction: 1 }).run();
  assert.equal(cpReport(r, 'cp1').counts.created, 4);
  assert.equal(cpReport(r, 'cp2').counts.created, 0);
  assert.deepEqual(cpReport(r, 'cp2').deferred.map((d) => d.why), ['workspace-near-limit']);
  assert.deepEqual(r.warnings, ['workspace-near-limit']);
});


/* ---------- 10. step 4 follow-ups (security re-check 30): tombstones, held list, circuit breaker ---------- */

const deleteRoster = (store, n) => { store.doc.db.participants = store.doc.db.participants.filter((p) => p.notionPageId !== pid(n)); };

test('TOMBSTONE: a roster row staff deleted does not come back, not even after Notion edits that row; the page id (no personal data) is recorded', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const table = makeTable({ [DS1]: [row(1, { edited: edit(1) }), row(2, { edited: edit(2) })] });
  const clock = clockAt();
  const j = job(store, table, { now: clock.now });
  await j.run();
  assert.equal(rosterOf(store, 'cp1').length, 2);
  deleteRoster(store, 1);                                       /* staff delete the first applicant */
  clock.add(120000);
  const r2 = await j.run();
  assert.equal(rosterOf(store, 'cp1').length, 1, 'not created again');
  assert.deepEqual(Object.keys(j.js.value.campaigns.cp1.tomb), [pid(1)]);
  assert.equal(cpReport(r2, 'cp1').counts.tombstoned, 1);
  /* Notion edits the deleted row: still not back */
  table.rows[DS1][0] = row(1, { edited: edit(30), props: { Notes: 'edited later' } });
  clock.add(120000);
  await j.run();
  assert.equal(rosterOf(store, 'cp1').length, 1, 'still gone after a Notion edit');
  assert.ok(!JSON.stringify(j.js.value).includes('Fake Person'), 'the state holds ids only');
  /* a fresh job reading the same stored state behaves the same */
  const j2 = job(store, table, { jobState: j.js, now: clock.now });
  clock.add(120000); await j2.run({ rescan: ['cp1'] });
  assert.equal(rosterOf(store, 'cp1').length, 1, 'a rescan does not bring a tombstoned row back');
});

test('TOMBSTONE: a row the manual import made (never seen by the job) that staff deleted is also not re-created', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)], creators: [manualCreator(1), manualCreator(2)], participants: [manualPart(1, 'cp1'), manualPart(2, 'cp1')] });
  const table = makeTable({ [DS1]: [row(1, { edited: edit(1) }), row(2, { edited: edit(2) })] });
  const clock = clockAt();
  const j = job(store, table, { now: clock.now });
  await j.run();                                                /* baseline: both matched */
  store.doc.db.participants = store.doc.db.participants.filter((p) => p.id !== 'cp1-crOLD1');
  table.rows[DS1][0] = row(1, { edited: edit(40) });
  clock.add(120000); await j.run();
  assert.equal(rosterOf(store, 'cp1').length, 1);
  assert.ok(j.js.value.campaigns.cp1.tomb[pid(1)]);
});

test('TOMBSTONE: a row moved to another campaign by staff is not a deletion', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1), campaign('cp2', DS2)] });
  const table = makeTable({ [DS1]: [row(1)], [DS2]: [] });
  const clock = clockAt();
  const j = job(store, table, { now: clock.now });
  await j.run();
  store.doc.db.participants.forEach((p) => { p.campaignId = 'cp2'; });
  clock.add(120000); await j.run();
  assert.deepEqual(j.js.value.campaigns.cp1.tomb || {}, {});
});

test('TOMBSTONE: staff restore removes the tombstone (staff only) and the row returns on a rescan; unknown ids change nothing', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const table = makeTable({ [DS1]: [row(1, { edited: edit(1) })] });
  const clock = clockAt();
  const j = job(store, table, { now: clock.now });
  await j.run(); deleteRoster(store, 1);
  clock.add(120000); await j.run();
  assert.ok(j.js.value.campaigns.cp1.tomb[pid(1)]);
  assert.equal(typeof j.restore, 'function');
  assert.deepEqual(await j.restore('cp1', 'not-an-id'), { ok: false, error: 'bad-request' });
  assert.deepEqual(await j.restore('cp1', pid(5)), { ok: true, removed: false });
  assert.deepEqual(await j.restore('cp1', pid(1)), { ok: true, removed: true });
  assert.deepEqual(j.js.value.campaigns.cp1.tomb, {});
  clock.add(120000); await j.run({ rescan: ['cp1'] });
  assert.equal(rosterOf(store, 'cp1').length, 1, 'back after restore + rescan');
  /* the route: 401 / 403 / staff 200, and the job is reached only by staff */
  const seen = [];
  const get = () => ({ applicants: { restore: async (c, p) => { seen.push([c, p]); return { ok: true, removed: true }; } }, off: '', cfg: {}, logStore: null });
  await withRoutes(get, async (call) => {
    assert.equal((await call('POST', '/api/notion-applicants/restore', null, { campaignId: 'cp1', pageId: pid(1) })).status, 401);
    assert.equal((await call('POST', '/api/notion-applicants/restore', 'someone@example.invalid', { campaignId: 'cp1', pageId: pid(1) })).status, 403);
    assert.deepEqual(seen, []);
    const ok = await call('POST', '/api/notion-applicants/restore', 'staff@example.invalid', { campaignId: 'cp1', pageId: pid(1) });
    assert.equal(ok.status, 200); assert.deepEqual(seen, [['cp1', pid(1)]]);
    assert.equal((await call('POST', '/api/notion-applicants/restore', 'staff@example.invalid', { campaignId: 5, pageId: {} })).status, 400);
  });
});

test('TOMBSTONE: a full list is never trimmed silently: nothing old is dropped, the overflow is reported with a warning', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const table = makeTable({ [DS1]: [1, 2, 3].map((n) => row(n, { edited: edit(n) })) });
  const clock = clockAt();
  const j = job(store, table, { now: clock.now, tombCap: 2 });
  await j.run();
  [1, 2, 3].forEach((n) => deleteRoster(store, n));
  clock.add(120000);
  const r = await j.run();
  assert.equal(Object.keys(j.js.value.campaigns.cp1.tomb).length, 2, 'cap holds');
  assert.ok(r.warnings.includes('tombstone-list-full'));
  assert.equal(cpReport(r, 'cp1').tombstoneNotRecorded, 1);
  assert.equal(rosterOf(store, 'cp1').length, 0, 'none of the three came back in this run');
  /* the next run does not evict the two already there */
  const before = Object.keys(j.js.value.campaigns.cp1.tomb).sort();
  clock.add(120000); await j.run();
  assert.deepEqual(Object.keys(j.js.value.campaigns.cp1.tomb).sort(), before);
});

test('TOMBSTONE: a dry run records nothing, and the state is validated on load', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const table = makeTable({ [DS1]: [row(1)] });
  const clock = clockAt();
  const j = job(store, table, { now: clock.now });
  await j.run(); deleteRoster(store, 1);
  const writes = j.js.writes;
  clock.add(120000);
  const r = await j.run({ dryRun: true });
  assert.equal(j.js.writes, writes); assert.equal(cpReport(r, 'cp1').counts.tombstoned, 1);
  const n = N.normState({ campaigns: { cp1: { tomb: { [pid(1)]: '2026-11-24T10:00:00Z', 'junk<script>': 'x' }, imp: { [pid(3)]: 1, bad: 1 } } } });
  assert.deepEqual(Object.keys(n.campaigns.cp1.tomb), [pid(1)]);
  assert.deepEqual(Object.keys(n.campaigns.cp1.imp), [pid(3)]);
});

test('HELD: past the cap nothing is silently dropped: existing held rows stay, new ones are reported with a warning', async () => {
  const store = makeStore({ campaigns: [campaign('cp1', DS1)] });
  const table = makeTable({ [DS1]: [1, 2, 3].map((n) => row(n, { props: { Status: 'Some New Word' }, edited: edit(n) })) });
  const clock = clockAt();
  const j = job(store, table, { now: clock.now, heldCap: 2 });
  const r = await j.run();
  assert.equal(Object.keys(j.js.value.campaigns.cp1.held).length, 2);
  assert.ok(r.warnings.includes('held-list-full'));
  assert.equal(cpReport(r, 'cp1').heldNotRemembered.length, 1);
  const kept = Object.keys(j.js.value.campaigns.cp1.held).sort();
  clock.add(120000);
  table.rows[DS1].push(row(4, { props: { Status: 'Another Word' }, edited: edit(4) }));
  const r2 = await j.run();
  assert.deepEqual(Object.keys(j.js.value.campaigns.cp1.held).sort(), kept, 'the same two stay; the newest are never swapped in for them');
  assert.ok(r2.warnings.includes('held-list-full'));
  const sum = await j.stateSummary();
  assert.ok(sum.heldFull.includes('cp1'));
});

test('HELD: a staff rescan keeps the held list (a row that cannot be read right now is not forgotten)', async () => {
  const { store, table } = heldWorld();
  const clock = clockAt();
  const j = job(store, table, { getPage: table.getPage, now: clock.now });
  await j.run();
  const since = j.js.value.campaigns.cp1.held[pid(1)].since;
  table.rows[DS1] = table.rows[DS1].filter((r) => r.pageId !== pid(1));   /* the query no longer returns it ... */
  table.pageFail = 500;                                                     /* ... and reading it by id fails */
  clock.add(120000);
  await j.run({ trigger: 'manual', rescan: ['cp1'] });
  const h = j.js.value.campaigns.cp1.held[pid(1)];
  assert.ok(h, 'still held after the rescan');
  assert.equal(h.since, since); assert.equal(h.tries, 1);
});

function manyCampaigns(n, failFor) {
  const ds = (i) => AC.normalizeId(hex(9100 + i));
  const cps = [], rows = {};
  for (let i = 1; i <= n; i++) { cps.push(campaign('cq' + i, ds(i))); rows[ds(i)] = [row(i)]; }
  const store = makeStore({ campaigns: cps });
  const table = makeTable(rows);
  const asked = [];
  const base = table.query;
  table.query = async (o) => {
    asked.push(o.dataSourceId);
    if (failFor(o.dataSourceId, ds)) { const e = new Error('sentinel-text'); e.status = 503; throw e; }
    return base(o);
  };
  return { store, table, asked, ds };
}

test('BREAKER: after 5 server failures in a row (default) the run stops, says so, and the rest are counted as not visited', async () => {
  const w = manyCampaigns(8, () => true);
  const r = await job(w.store, w.table).run();
  assert.equal(w.asked.length, 5, 'campaigns 6 to 8 were never asked');
  assert.equal(r.aborted, 'circuit-open'); assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /circuit/i.test(e)));
  assert.equal(r.remaining.campaignsNotVisited, 3);
  assert.equal(r.campaigns.filter((c) => c.why === 'query-failed:http-503').length, 5);
  assert.ok(!JSON.stringify(r).includes('sentinel-text'));
  assert.equal(w.store.saves.length, 0);
});

test('BREAKER: the threshold is configurable; a success resets the count; a 4xx is not a server failure', async () => {
  const a = manyCampaigns(6, () => true);
  await job(a.store, a.table, { breakerFailures: 2 }).run();
  assert.equal(a.asked.length, 2);
  /* fail, fail, ok, fail, fail, fail with a threshold of 3: only the last three trip it, so all six are asked and the run is not aborted before the end */
  const pattern = [true, true, false, true, true, false];
  const b = manyCampaigns(6, (id, ds) => { for (let i = 1; i <= 6; i++) if (id === ds(i)) return pattern[i - 1]; return false; });
  const rb = await job(b.store, b.table, { breakerFailures: 3 }).run();
  assert.equal(b.asked.length, 6); assert.equal(rb.aborted, null);
  /* a permanent error (404) does not count */
  const c = manyCampaigns(6, () => false);
  const base = c.table.query;
  c.table.query = async (o) => { c.asked.push(o.dataSourceId); const e = new Error('x'); e.status = 404; throw e; };
  const rc = await job(c.store, c.table, { breakerFailures: 2 }).run();
  assert.equal(c.asked.length, 6); assert.equal(rc.aborted, null);
});
