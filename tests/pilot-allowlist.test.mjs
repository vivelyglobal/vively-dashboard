/* Pilot allow-list for the applicants job (NOTION_APPLICANTS_ONLY) and the
   date write-back job (DATE_WRITEBACK_ONLY).

   FAKE DATA ONLY: invented names, example.invalid addresses. No live Notion,
   Mongo or Google call: Notion, the Sheet and the workspace are in-memory
   stand-ins. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const N = require('../server/notion-applicants.js');
const W = require('../server/date-writeback.js');
const P = require('../server/pilot-allowlist.js');
const AC = require('../server/notion-autocreate.js');
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const hex = (n) => n.toString(16).padStart(32, '0');
const dashed = (n) => AC.normalizeId(hex(n));
const clone = (v) => JSON.parse(JSON.stringify(v));
const shared = N.loadShared();

/* =============================== the list itself =============================== */

test('parsePilot: unset or blank is "all"; NONE is "none"; a list is "list"; a set-but-unusable value parks (never all)', () => {
  assert.equal(P.parsePilot(undefined, 'X').mode, 'all');
  assert.equal(P.parsePilot('', 'X').mode, 'all');
  assert.equal(P.parsePilot('   ', 'X').mode, 'all');
  assert.equal(P.parsePilot('NONE', 'X').mode, 'none');
  assert.equal(P.parsePilot(' none ', 'X').mode, 'none');
  assert.equal(P.parsePilot('cpA, cpB', 'X').mode, 'list');
  assert.equal(P.parsePilot(',,', 'X').mode, 'none', 'set but empty entries: process nothing');
  assert.equal(P.parsePilot('has space and symbols!', 'X').mode, 'none', 'typo: process nothing');
  assert.equal(P.parsePilot('NONE,cpA', 'X').mode, 'list', 'NONE inside a list matches nothing; the rest applies');
});

test('parsePilot: Notion ids with or without dashes, any case, or a page URL, all normalise to one dashed id', () => {
  const want = dashed(77);
  const a = P.parsePilot(hex(77).toUpperCase() + ',' + want + ',https://www.notion.so/Some-Title-' + hex(77), 'X');
  assert.deepEqual(a.ids, [want], 'three spellings of one page id are one entry');
  assert.ok(P.inPilot(a, { id: 'zzz', notionPageId: hex(77) }));
  assert.ok(P.inPilot(a, { id: 'zzz', notionPageId: want.toUpperCase() }));
  assert.ok(!P.inPilot(a, { id: 'zzz', notionPageId: dashed(78) }));
  assert.ok(!P.inPilot(a, { id: 'zzz' }), 'a campaign with no page id and another id is out');
});

/* =============================== applicants job =============================== */

const MAPPING = {
  instagram: 'Instagram Link', tiktok: null, fullName: 'Full Name', email: null, contact: null,
  address: null, nationality: 'Nationality', followers: 'Followers', otherSns: null, contentUrl: null,
  views: null, likes: null, comments: null, shares: null, metricsAt: null, gender: null,
  formNotes: null, remark: null, headcount: null, visitAt: 'Visit Date', status: 'Status', note: null
};
const DS = { cp1: dashed(9001), cp2: dashed(9002), cp3: dashed(9003) };
const cmp = (id, extra) => Object.assign({ id, brand: 'Fake Brand', name: 'Fake Campaign ' + id, status: 'outreach', category: 'Lifestyle',
  start: '2026-11-01', notionDatabaseId: DS[id], notionMapping: Object.assign({}, MAPPING) }, extra || {});
const rowOf = (n) => ({
  pageId: dashed(n), createdTime: '2026-11-19T01:00:00.000Z', lastEdited: '2026-11-20T10:0' + (n % 9) + ':00.000Z',
  properties: { 'Full Name': 'Fake Person ' + n, 'Instagram Link': 'https://instagram.com/fake.creator' + n, Nationality: 'Japanese',
    Followers: '12k', 'Visit Date': '2026-12-05T19:00:00.000+09:00', Status: 'Waiting Approval' }
});
function world() {
  const doc = { db: { campaigns: [cmp('cp1', { notionPageId: hex(501) }), cmp('cp2', { notionPageId: dashed(502) }), cmp('cp3')], creators: [], participants: [] }, settings: {}, revision: 1 };
  const st = { doc, saves: 0 };
  st.load = async () => clone(st.doc);
  st.save = async (w) => { st.saves++; st.doc = { db: clone(w.db), settings: w.settings, revision: st.doc.revision + 1 }; return { ok: true }; };
  const queried = [];
  const rows = { [DS.cp1]: [rowOf(1), rowOf(2)], [DS.cp2]: [rowOf(3)], [DS.cp3]: [rowOf(4)] };
  const query = async (o) => { queried.push(o.dataSourceId); return { rows: clone(rows[o.dataSourceId] || []), hasMore: false, nextCursor: null }; };
  return { st, queried, query };
}
let idN = 0;
function ajob(w, extra) {
  const state = { v: null, writes: 0 };
  return N.createApplicants(Object.assign({
    shared, loadWorkspace: w.st.load, saveWorkspace: w.st.save, queryRows: w.query, manualMinSec: 0,
    loadState: async () => (state.v ? clone(state.v) : null), saveState: async (s) => { state.writes++; state.v = clone(s); }, saveLog: async () => {},
    newId: (p) => p + 'PILOT' + (++idN), now: () => new Date('2026-11-24T10:00:00Z'), logger: { error() {}, log() {} }
  }, extra || {}));
}
const rosterIds = (w) => [...new Set(w.st.doc.db.participants.map((p) => p.campaignId))].sort();
const pilotFrom = (v) => N.parseConfig({ NOTION_APPLICANTS_ONLY: v }).pilot;

test('applicants: allow-list unset = every campaign, unchanged behaviour', async () => {
  const w = world();
  const run = await ajob(w, { pilot: pilotFrom(undefined) }).run();
  assert.equal(run.ok, true);
  assert.deepEqual(rosterIds(w), ['cp1', 'cp2', 'cp3']);
  assert.equal(run.pilot.mode, 'all');
  assert.equal(run.counts.campaignsNotInPilot, 0);
  assert.deepEqual(w.queried.slice().sort(), [DS.cp1, DS.cp2, DS.cp3].sort());
  const noDeps = await ajob(world()).run();      // no pilot given at all: same
  assert.equal(noDeps.pilot.mode, 'all');
});

test('applicants: allow-list set = only those campaigns; the rest are counted "not in pilot", never read, never written', async () => {
  const w = world();
  const run = await ajob(w, { pilot: pilotFrom('cp2') }).run();
  assert.deepEqual(rosterIds(w), ['cp2']);
  assert.deepEqual(w.queried, [DS.cp2], 'Notion was only asked about the pilot campaign');
  assert.deepEqual(run.pilot, { mode: 'list', campaignsInPilot: 1, campaignsNotInPilot: 2, unmatchedEntries: 0 });
  assert.equal(run.counts.campaignsNotInPilot, 2);
  assert.equal(run.counts.campaignsSynced, 1);
  assert.deepEqual(run.campaigns.map((c) => c.campaignId), ['cp2'], 'other campaigns appear as a count only');
});

test('applicants: mixed id formats (campaign id, Notion id plain, dashed, upper case) all select the right campaigns', async () => {
  const w = world();
  const run = await ajob(w, { pilot: pilotFrom('cp3 , ' + hex(501).toUpperCase()) }).run();   // cp3 by id, cp1 by plain upper-case page id
  assert.deepEqual(rosterIds(w), ['cp1', 'cp3']);
  assert.equal(run.pilot.campaignsInPilot, 2);
  const w2 = world();
  await ajob(w2, { pilot: pilotFrom(dashed(502)) }).run();                                       // cp2 by dashed page id (stored dashed)
  assert.deepEqual(rosterIds(w2), ['cp2']);
  const w3 = world();
  await ajob(w3, { pilot: pilotFrom(dashed(501)) }).run();                                       // cp1 stored plain, listed dashed
  assert.deepEqual(rosterIds(w3), ['cp1']);
});

test('applicants: an entry that matches nothing is counted (typo check) and nothing else runs', async () => {
  const w = world();
  const run = await ajob(w, { pilot: pilotFrom('cpTYPO') }).run();
  assert.deepEqual(rosterIds(w), []);
  assert.equal(run.pilot.unmatchedEntries, 1);
  assert.equal(run.pilot.campaignsInPilot, 0);
  assert.deepEqual(w.queried, []);
});

test('applicants: NONE processes nothing at all', async () => {
  const w = world();
  const run = await ajob(w, { pilot: pilotFrom('NONE') }).run();
  assert.deepEqual(rosterIds(w), []);
  assert.deepEqual(w.queried, []);
  assert.equal(w.st.saves, 0);
  assert.equal(run.pilot.mode, 'none');
  assert.equal(run.counts.campaignsNotInPilot, 3);
});

test('applicants: a dry run respects the allow-list (reads only the pilot campaign, writes nothing)', async () => {
  const w = world();
  const run = await ajob(w, { pilot: pilotFrom('cp1'), dryRun: true }).run();
  assert.equal(run.dryRun, true);
  assert.deepEqual(w.queried, [DS.cp1]);
  assert.equal(w.st.saves, 0);
  assert.deepEqual(run.campaigns.map((c) => [c.campaignId, c.status]), [['cp1', 'dry-run']]);
  assert.equal(run.counts.campaignsNotInPilot, 2);
});

test('applicants: a manual run, a campaignId, rescan or a forged body cannot bypass the list (routes behind the real requireStaff)', async () => {
  const w = world();
  const job = ajob(w, { pilot: pilotFrom('cp2') });
  const cfg = { intervalMin: 2, dryRun: false, pilot: pilotFrom('cp2') };
  const get = () => ({ applicants: job, off: '', cfg, logStore: { readHistory: async () => [], readLast: async () => null } });
  await withRoutes(get, async (call) => {
    /* names a campaign that is NOT in the pilot, plus every spelling of "force / widen" a caller might try */
    const r = await call('POST', '/api/notion-applicants/run', 'staff@example.invalid',
      { campaignId: 'cp1', rescan: ['cp1', 'cp3'], force: true, pilot: 'all', only: 'cp1', allowList: [], NOTION_APPLICANTS_ONLY: '' });
    assert.equal(r.status, 200);
    assert.deepEqual(rosterIds(w), [], 'cp1 was named but is not in the pilot: nothing happened');
    assert.deepEqual(w.queried, []);
    assert.equal(r.json.run.counts.campaignsNotInPilot, 2);
    const ok = await call('POST', '/api/notion-applicants/run', 'staff@example.invalid', { campaignId: 'cp2' });
    assert.equal(ok.status, 200);
    assert.deepEqual(rosterIds(w), ['cp2'], 'the pilot campaign still runs on a manual call');
  });
});

/* ============================ date write-back job ============================ */

const PROP = 'Confirmed Visit';
function dwWorld() {
  return {
    db: {
      campaigns: [{ id: 'cp1', brand: 'Aura', name: 'Aura Seoul', notionPageId: hex(601) }, { id: 'cp2', brand: 'Bram', name: 'Bram Seoul', notionPageId: dashed(602) }],
      creators: [{ id: 'c1', handle: '@fake.one', name: 'Fake One' }, { id: 'c2', handle: '@fake.two', name: 'Fake Two' }],
      participants: [
        { id: 'p1', campaignId: 'cp1', creatorId: 'c1', stage: 'confirmed', confirmedVisitAt: '2026-12-05 14:30', notionPageId: dashed(1) },
        { id: 'p2', campaignId: 'cp2', creatorId: 'c2', stage: 'confirmed', confirmedVisitAt: '2026-12-06 11:00', notionPageId: dashed(2) }
      ]
    }
  };
}
function dwMake(env, o) {
  const opts = o || {};
  const config = W.parseConfig(env || {});
  config.notion.enabled = true; config.sheet.enabled = false;
  if (opts.dry) config.notion.dryRun = true;
  const pages = new Map([[dashed(1), { [PROP]: { type: 'date', date: null } }], [dashed(2), { [PROP]: { type: 'date', date: null } }]]);
  const calls = [];
  const notion = async (method, path, body) => {
    calls.push({ method, path });
    const id = path.replace('/pages/', ''); const pg = pages.get(id);
    if (method === 'GET') return { object: 'page', id, archived: false, properties: clone(pg) };
    pg[PROP].date = Object.assign({ end: null }, body.properties[PROP].date); return { object: 'page', id };
  };
  const store = { state: null };
  const job = W.createDateWriteback({
    config, logger: { log() {}, error() {} }, loadWorkspace: async () => clone({ db: dwWorld().db }),
    loadState: async () => (store.state ? clone(store.state) : null), saveState: async (s) => { store.state = clone(s); }, saveLog: async () => {},
    notion, sheets: null, venueNames: async () => new Map(), now: () => new Date(Date.parse('2026-11-23T00:00:00Z')), sleep: async () => {}, retryDelayMs: 1
  });
  return { job, calls, pages, config };
}
const writes = (m) => m.calls.filter((c) => c.method === 'PATCH').map((c) => c.path.replace('/pages/', ''));

test('date write-back: allow-list unset = every campaign, unchanged behaviour', async () => {
  const m = dwMake({});
  const run = await m.job.run({ trigger: 'manual' });
  assert.deepEqual(writes(m).sort(), [dashed(1), dashed(2)]);
  assert.equal(run.considered, 2);
  assert.deepEqual(run.skipped, { badDate: 0, dropped: 0, tooOld: 0, noCampaign: 0 }, 'unset: the skipped block is exactly as before');
  assert.equal(run.pilot.mode, 'all');
});

test('date write-back: allow-list set = only those campaigns (Notion page id in a different format selects cp2)', async () => {
  const m = dwMake({ DATE_WRITEBACK_ONLY: hex(602).toUpperCase() });
  const run = await m.job.run({ trigger: 'manual' });
  assert.deepEqual(writes(m), [dashed(2)]);
  assert.equal(run.considered, 1);
  assert.equal(run.skipped.notInPilot, 1);
  assert.deepEqual(run.pilot, { mode: 'list', campaignsInPilot: 1, campaignsNotInPilot: 1, participantsNotInPilot: 1, unmatchedEntries: 0 });
  assert.ok(!m.calls.some((c) => c.path === '/pages/' + dashed(1)), 'the other campaign\'s page was never even read');
  const m2 = dwMake({ DATE_WRITEBACK_ONLY: 'cp1, ' + dashed(999) });
  const run2 = await m2.job.run({ trigger: 'manual' });
  assert.deepEqual(writes(m2), [dashed(1)]);
  assert.equal(run2.pilot.unmatchedEntries, 1);
});

test('date write-back: NONE processes nothing', async () => {
  const m = dwMake({ DATE_WRITEBACK_ONLY: 'NONE' });
  const run = await m.job.run({ trigger: 'manual' });
  assert.deepEqual(m.calls, []);
  assert.equal(run.considered, 0);
  assert.equal(run.skipped.notInPilot, 2);
  assert.equal(run.pilot.mode, 'none');
});

test('date write-back: a dry run respects the allow-list (would-write only for the pilot campaign)', async () => {
  const m = dwMake({ DATE_WRITEBACK_ONLY: 'cp1' }, { dry: true });
  const run = await m.job.run({ trigger: 'poll' });
  assert.deepEqual(run.channels.notion.counts, { 'would-write': 1 });
  assert.deepEqual(writes(m), []);
  assert.deepEqual(run.items.map((i) => i.campaignId), ['cp1']);
  const viaRequest = dwMake({ DATE_WRITEBACK_ONLY: 'cp2' });
  const r2 = await viaRequest.job.run({ trigger: 'manual', dryRun: true });
  assert.deepEqual(r2.items.map((i) => i.campaignId), ['cp2']);
});

test('date write-back: a staff force (live manual run) cannot reach a creator outside the list', async () => {
  const m = dwMake({ DATE_WRITEBACK_ONLY: 'cp2' });
  /* someone typed a value on cp1\'s row; cp1 is outside the pilot, so even a force for that creator does nothing */
  m.pages.get(dashed(1))[PROP].date = { start: '2026-01-01', end: null };
  const run = await m.job.run({ trigger: 'manual', force: ['c1', 'c2'] });
  assert.deepEqual(writes(m), [dashed(2)]);
  assert.equal(m.pages.get(dashed(1))[PROP].date.start, '2026-01-01', 'the out-of-pilot row is untouched');
  assert.ok(!run.items.some((i) => i.campaignId === 'cp1'));
  assert.equal(run.skipped.notInPilot, 1);
});

/* ============================ status shape ============================ */

test('status: ids only, count, mode; a warning appears only when the job is ON with no list', () => {
  const on = P.pilotStatus(P.parsePilot(undefined, 'NOTION_APPLICANTS_ONLY'), { enabled: true, dryRun: false });
  assert.equal(on.mode, 'all');
  assert.match(on.warning, /Acting on ALL campaigns/);
  assert.match(on.warning, /NOTION_APPLICANTS_ONLY/);
  const dry = P.pilotStatus(P.parsePilot('', 'DATE_WRITEBACK_ONLY'), { enabled: true, dryRun: true });
  assert.match(dry.warning, /dry run/);
  const off = P.pilotStatus(P.parsePilot(undefined, 'X'), { enabled: false });
  assert.equal(off.warning, null, 'job off: nothing is acting');
  const list = P.pilotStatus(P.parsePilot('cp1,' + hex(5), 'X'), { enabled: true });
  assert.equal(list.warning, null);
  assert.deepEqual(Object.keys(list).sort(), ['envVar', 'idCount', 'ids', 'idsTruncated', 'ignoredEntries', 'mode', 'warning']);
  assert.deepEqual(list.ids, ['cp1', dashed(5)]);
  assert.equal(list.idCount, 2);
  const none = P.pilotStatus(P.parsePilot('NONE', 'X'), { enabled: true });
  assert.equal(none.mode, 'none'); assert.equal(none.warning, null); assert.deepEqual(none.ids, []);
});

test('status endpoint (applicants): shows the allow-list, mode, counts from the last run; warning when on with no list', async () => {
  const w = world();
  const cfgList = { intervalMin: 2, dryRun: false, pilot: pilotFrom('cp2') };
  const job = ajob(w, { pilot: cfgList.pilot });
  await job.run();
  const mk = (cfg, applicants) => () => ({ applicants, off: applicants ? '' : 'NOTION_APPLICANTS_SYNC is not 1', cfg, logStore: { readHistory: async () => [], readLast: async () => null } });
  await withRoutes(mk(cfgList, job), async (call) => {
    const s = await call('GET', '/api/notion-applicants/status', 'staff@example.invalid');
    assert.equal(s.status, 200);
    assert.deepEqual(s.json.pilot, { envVar: 'NOTION_APPLICANTS_ONLY', mode: 'list', idCount: 1, ids: ['cp2'], idsTruncated: false, ignoredEntries: 0, warning: null });
    assert.deepEqual(s.json.last.pilot, { mode: 'list', campaignsInPilot: 1, campaignsNotInPilot: 2, unmatchedEntries: 0 });
    assert.equal(s.json.last.counts.campaignsNotInPilot, 2);
    assert.ok(!JSON.stringify(s.json.pilot).includes('Fake'), 'no names in the pilot block');
  });
  const cfgAll = { intervalMin: 2, dryRun: false, pilot: pilotFrom(undefined) };
  await withRoutes(mk(cfgAll, job), async (call) => {
    const s = await call('GET', '/api/notion-applicants/status', 'staff@example.invalid');
    assert.equal(s.json.pilot.mode, 'all');
    assert.match(s.json.pilot.warning, /Acting on ALL campaigns/);
  });
  await withRoutes(mk(cfgAll, null), async (call) => {
    const s = await call('GET', '/api/notion-applicants/status', 'staff@example.invalid');
    assert.equal(s.json.enabled, false);
    assert.equal(s.json.pilot.warning, null, 'job off: no warning');
  });
});

test('no personal data: the pilot block, the run pilot summary and the run counts carry no name, handle, address or phone', async () => {
  const w = world();
  w.st.doc.db.creators.push({ id: 'cx', handle: '@private.person', name: 'Private Person', address: 'Secret Street 9', contact: '010-0000-0000' });
  const run = await ajob(w, { pilot: pilotFrom('cp1,cpTYPO') }).run();
  const st = P.pilotStatus(pilotFrom('cp1,Secret Street 9,Private Person'), { enabled: true });
  const blob = JSON.stringify({ pilot: run.pilot, counts: run.counts, status: st });
  ['Private Person', 'private.person', 'Secret Street', '010-0000', 'Fake Person', 'fake.creator'].forEach((x) => assert.ok(!blob.includes(x), x));
  assert.deepEqual(st.ids, ['cp1'], 'free text with spaces is dropped, never echoed');
  assert.equal(st.ignoredEntries, 2);
  /* the date job: the entry's pilot block and items stay ids and counts */
  const m = dwMake({ DATE_WRITEBACK_ONLY: 'cp1' });
  const dw = await m.job.run({ trigger: 'manual' });
  ['Fake One', 'fake.one', 'Fake Two', 'fake.two'].forEach((s) => assert.ok(!JSON.stringify(dw).includes(s), s));
});

test('server.js wiring: both env names are read, the list is passed to the job, the date status shows it', () => {
  const src = fs.readFileSync(ROOT + 'server.js', 'utf8');
  assert.match(src, /pilot: applicantsCfg\.pilot/);
  assert.match(src, /dateWritebackLib\.pilotStatus\(dwCfg\.pilot/);
  const cfgSrc = fs.readFileSync(ROOT + 'server/notion-applicants.js', 'utf8') + fs.readFileSync(ROOT + 'server/date-writeback.js', 'utf8');
  assert.match(cfgSrc, /NOTION_APPLICANTS_ONLY/);
  assert.match(cfgSrc, /DATE_WRITEBACK_ONLY/);
  assert.ok(!/NOTION_AUTOCREATE_ONLY|pilot/.test(fs.readFileSync(ROOT + 'server/notion-autocreate.js', 'utf8')), 'auto-create is untouched');
});

/* ---------- the real requireStaff guard, as the applicants tests do it ---------- */
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
