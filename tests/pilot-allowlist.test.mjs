/* Pilot allow-list for the applicants job (NOTION_APPLICANTS_ONLY) and the
   date write-back job (DATE_WRITEBACK_ONLY).

   FAKE DATA ONLY: invented names, example.invalid addresses. No live Notion,
   Mongo or Google call: Notion, the Sheet and the workspace are in-memory
   stand-ins. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
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

test('parsePilot: unset or blank is "unset" (refuse); ALL is "all"; NONE is "none"; a list is "list"; a set-but-unusable value parks (never all)', () => {
  assert.equal(P.parsePilot(undefined, 'X').mode, 'unset');
  assert.equal(P.parsePilot('', 'X').mode, 'unset');
  assert.equal(P.parsePilot('   ', 'X').mode, 'unset');
  assert.equal(P.parsePilot('ALL', 'X').mode, 'all');
  assert.equal(P.parsePilot('  all ', 'X').mode, 'all');
  assert.equal(P.parsePilot('All', 'X').mode, 'all');
  assert.equal(P.parsePilot('everything', 'X').mode, 'list', 'only the literal ALL means all; any other word is a (useless) list entry');
  assert.equal(P.parsePilot('NONE', 'X').mode, 'none');
  assert.equal(P.parsePilot(' none ', 'X').mode, 'none');
  assert.equal(P.parsePilot('cpA, cpB', 'X').mode, 'list');
  assert.equal(P.parsePilot(',,', 'X').mode, 'none', 'set but empty entries: process nothing');
  assert.equal(P.parsePilot('has space and symbols!', 'X').mode, 'none', 'typo: process nothing');
  assert.equal(P.parsePilot('NONE,cpA', 'X').mode, 'list', 'NONE inside a list matches nothing; the rest applies');
  const mixed = P.parsePilot('ALL,cpA', 'X');
  assert.equal(mixed.mode, 'list', 'ALL inside a list never widens it: the list applies');
  assert.ok(P.inPilot(mixed, { id: 'cpA' })); assert.ok(!P.inPilot(mixed, { id: 'cpB' }));
  assert.ok(!P.inPilot(P.parsePilot(undefined, 'X'), { id: 'cpA' }), 'an unset list allows nothing, even when asked directly');
  assert.ok(P.inPilot(P.parsePilot('ALL', 'X'), { id: 'cpA' }));
});

test('parsePilot: an unusable value (symbols, spaces, empty entries) is NONE, never ALL', () => {
  ['has space and symbols!', ',,', '!!!', 'a b'].forEach((v) => assert.equal(P.parsePilot(v, 'X').mode, 'none', v));
});

test('notionId: a 32-hex id matches only as a WHOLE token (dashes or none), never as part of a longer hex string', () => {
  const h = hex(77);
  assert.equal(P.notionId(h), dashed(77));
  assert.equal(P.notionId(dashed(77)), dashed(77));
  assert.equal(P.notionId(' ' + h.toUpperCase() + ' '), dashed(77));
  assert.equal(P.notionId('a' + h), null, '33 hex characters: a typo, not an id');
  assert.equal(P.notionId(h + 'f'), null);
  assert.equal(P.notionId(h + h.slice(0, 8)), null, '40 hex characters');
  assert.equal(P.notionId('x' + h), null);
  assert.equal(P.notionId('id=' + h), null);
  assert.equal(P.notionId('zz-' + h), null, 'a title prefix is only allowed inside a page URL');
  assert.equal(P.notionId(dashed(77) + 'a'), null);
  assert.equal(P.notionId('f' + dashed(77)), null);
  /* a real page URL still works, with or without a title, a query string or a trailing slash */
  assert.equal(P.notionId('https://www.notion.so/Some-Title-' + h), dashed(77));
  assert.equal(P.notionId('https://www.notion.so/ws/' + h + '?v=abc#x'), dashed(77));
  assert.equal(P.notionId('https://www.notion.so/ws/Title-' + h + '/'), dashed(77));
  assert.equal(P.notionId('https://www.notion.so/Title-a' + h), null, 'a longer hex string at the end of a URL is not an id either');
});

test('a 40-hex typo is NOT turned into a page id: it matches no campaign', () => {
  const typo = hex(501) + 'abcdef01';          // 40 hex: starts with the 32 of campaign cp1's page id
  const pl = P.parsePilot(typo, 'X');
  assert.ok(!P.inPilot(pl, { id: 'cp1', notionPageId: hex(501) }), 'must not select the page that its first 32 characters spell');
  assert.equal(pl.pages.size, 0);
  const pl2 = P.parsePilot('x' + hex(501), 'X');
  assert.ok(!P.inPilot(pl2, { id: 'cp1', notionPageId: hex(501) }));
  /* the stored side is anchored too: a stored longer string is not a page id */
  const ok = P.parsePilot(hex(501), 'X');
  assert.ok(P.inPilot(ok, { id: 'zz', notionPageId: hex(501) }));
  assert.ok(!P.inPilot(ok, { id: 'zz', notionPageId: hex(501) + '00' }));
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

test('applicants: ALL = every campaign (the old behaviour, now written out on purpose)', async () => {
  const w = world();
  const run = await ajob(w, { pilot: pilotFrom('ALL') }).run();
  assert.equal(run.ok, true);
  assert.deepEqual(rosterIds(w), ['cp1', 'cp2', 'cp3']);
  assert.equal(run.pilot.mode, 'all');
  assert.equal(run.counts.campaignsNotInPilot, 0);
  assert.deepEqual(w.queried.slice().sort(), [DS.cp1, DS.cp2, DS.cp3].sort());
  const lower = world();
  await ajob(lower, { pilot: pilotFrom('  all ') }).run();
  assert.deepEqual(rosterIds(lower), ['cp1', 'cp2', 'cp3']);
});

test('applicants FAIL CLOSED: job on, NOTION_APPLICANTS_ONLY unset = a live run is refused: no load, no Notion read, no workspace/state/log write', async () => {
  for (const unsetValue of [undefined, '', '   ']) {
    const w = world();
    const state = { writes: 0 }; let logs = 0, loads = 0;
    const job = ajob(w, {
      pilot: pilotFrom(unsetValue), loadWorkspace: async () => { loads++; return w.st.load(); },
      saveState: async () => { state.writes++; }, saveLog: async () => { logs++; }
    });
    for (const trigger of ['poll', 'manual']) {
      const run = await job.run({ trigger, campaignId: 'cp1', rescan: ['cp1'] });
      assert.equal(run.refused, true, trigger);
      assert.equal(run.ok, false);
      assert.equal(run.reason, 'refusing: set NOTION_APPLICANTS_ONLY to a campaign list, or to ALL to act on every campaign');
    }
    assert.equal(loads, 0, 'the workspace was not even read');
    assert.deepEqual(w.queried, [], 'Notion was not asked');
    assert.equal(w.st.saves, 0); assert.equal(state.writes, 0); assert.equal(logs, 0);
  }
  /* no pilot dependency at all is the same: the default is closed, not open */
  const w = world();
  const run = await ajob(w).run();
  assert.equal(run.refused, true);
  assert.deepEqual(w.queried, []);
  /* a request cannot turn a refusal into a run: dryRun:false and force from the caller are still the live path */
  const w2 = world();
  const r2 = await ajob(w2, { pilot: pilotFrom(undefined) }).run({ trigger: 'manual', dryRun: false, force: true });
  assert.equal(r2.refused, true);
  assert.deepEqual(w2.queried, []);
});

test('applicants: unset + dry run may still preview every campaign (read only), clearly labelled; nothing is written', async () => {
  const w = world();
  const run = await ajob(w, { pilot: pilotFrom(undefined), dryRun: true }).run();
  assert.equal(run.refused, undefined);
  assert.equal(run.dryRun, true);
  assert.equal(run.pilot.mode, 'unset');
  assert.equal(run.pilot.previewOnly, true);
  assert.ok(run.warnings.some((x) => /^preview only: NOTION_APPLICANTS_ONLY is not set/.test(x)));
  assert.equal(w.st.saves, 0, 'a dry run writes nothing');
  assert.deepEqual(rosterIds(w), []);
  assert.equal(w.queried.length, 3, 'the preview reads every campaign');
  /* a manual request with dryRun:true on a live-configured job is the same preview */
  const w2 = world();
  const r2 = await ajob(w2, { pilot: pilotFrom(undefined) }).run({ trigger: 'manual', dryRun: true });
  assert.equal(r2.pilot.previewOnly, true); assert.equal(w2.st.saves, 0);
  /* a list set: not labelled as a preview */
  const r3 = await ajob(world(), { pilot: pilotFrom('cp1'), dryRun: true }).run();
  assert.equal(r3.pilot.previewOnly, undefined);
});

test('applicants: the staff run route answers 409 with the refusal message when the list is unset', async () => {
  const w = world();
  const job = ajob(w, { pilot: pilotFrom(undefined) });
  const cfg = { intervalMin: 2, dryRun: false, pilot: pilotFrom(undefined) };
  await withRoutes(() => ({ applicants: job, off: '', cfg, logStore: { readHistory: async () => [], readLast: async () => null } }), async (call) => {
    const r = await call('POST', '/api/notion-applicants/run', 'staff@example.invalid', {});
    assert.equal(r.status, 409);
    assert.equal(r.json.refused, true);
    assert.equal(r.json.error, 'refusing: set NOTION_APPLICANTS_ONLY to a campaign list, or to ALL to act on every campaign');
    assert.deepEqual(w.queried, []);
    const d = await call('POST', '/api/notion-applicants/run', 'staff@example.invalid', { dryRun: true });
    assert.equal(d.status, 200, 'a dry-run preview is still allowed');
    assert.equal(d.json.run.pilot.previewOnly, true);
  });
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

test('date write-back FAIL CLOSED: a live channel with DATE_WRITEBACK_ONLY unset refuses the whole run: no workspace read, no Notion call, no state or log write', async () => {
  const m0 = dwMake({});
  let loads = 0, saves = 0, logs = 0;
  const calls = [];
  const job = W.createDateWriteback({
    config: m0.config, logger: { log() {}, error() {} },
    loadWorkspace: async () => { loads++; return { db: dwWorld().db }; },
    loadState: async () => null, saveState: async () => { saves++; }, saveLog: async () => { logs++; },
    notion: async (...a) => { calls.push(a); return {}; }, sheets: null, venueNames: async () => new Map(),
    now: () => new Date(Date.parse('2026-11-23T00:00:00Z')), sleep: async () => {}, retryDelayMs: 1
  });
  for (const o of [{ trigger: 'poll' }, { trigger: 'manual' }, { trigger: 'manual', force: ['c1', 'c2'] }, { trigger: 'save' }]) {
    const run = await job.run(o);
    assert.equal(run.refused, true, JSON.stringify(o));
    assert.equal(run.reason, 'refusing: set DATE_WRITEBACK_ONLY to a campaign list, or to ALL to act on every campaign');
    assert.equal(run.considered, 0);
    assert.equal(run.pilot.mode, 'unset');
  }
  assert.equal(loads, 0); assert.deepEqual(calls, []); assert.equal(saves, 0); assert.equal(logs, 0);
  assert.equal(job.lastRun().refused, true, 'the status shows the refusal');
});

test('date write-back: unset + dry run only previews every campaign (labelled), writes nothing', async () => {
  const m = dwMake({}, { dry: true });
  const run = await m.job.run({ trigger: 'poll' });
  assert.equal(run.refused, undefined);
  assert.equal(run.pilot.mode, 'unset'); assert.equal(run.pilot.previewOnly, true);
  assert.deepEqual(run.channels.notion.counts, { 'would-write': 2 });
  assert.deepEqual(writes(m), []);
  const viaRequest = dwMake({});
  const r2 = await viaRequest.job.run({ trigger: 'manual', dryRun: true });
  assert.equal(r2.pilot.previewOnly, true);
  assert.deepEqual(writes(viaRequest), []);
});

test('date write-back: ALL = every campaign (the old behaviour, written out on purpose)', async () => {
  const m = dwMake({ DATE_WRITEBACK_ONLY: 'all' });
  const run = await m.job.run({ trigger: 'manual' });
  assert.deepEqual(writes(m).sort(), [dashed(1), dashed(2)]);
  assert.equal(run.considered, 2);
  assert.deepEqual(run.skipped, { badDate: 0, dropped: 0, tooOld: 0, noCampaign: 0 }, 'unset: the skipped block is exactly as before');
  assert.equal(run.pilot.mode, 'all');
  assert.equal(run.refused, undefined);
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

test('status: ids only, count, mode; "refusing" when the job is ON with no list; a warning when it acts on ALL', () => {
  const on = P.pilotStatus(P.parsePilot(undefined, 'NOTION_APPLICANTS_ONLY'), { enabled: true, dryRun: false });
  assert.equal(on.mode, 'unset');
  assert.equal(on.refusing, true);
  assert.equal(on.warning, 'refusing: set NOTION_APPLICANTS_ONLY to a campaign list, or to ALL to act on every campaign');
  const dry = P.pilotStatus(P.parsePilot('', 'DATE_WRITEBACK_ONLY'), { enabled: true, dryRun: true });
  assert.equal(dry.refusing, false); assert.equal(dry.previewOnly, true);
  assert.match(dry.warning, /^Preview only \(dry run, nothing is written\): DATE_WRITEBACK_ONLY is not set/);
  const all = P.pilotStatus(P.parsePilot('ALL', 'NOTION_APPLICANTS_ONLY'), { enabled: true, dryRun: false });
  assert.equal(all.mode, 'all'); assert.equal(all.refusing, false);
  assert.match(all.warning, /Acting on ALL campaigns/);
  const off = P.pilotStatus(P.parsePilot(undefined, 'X'), { enabled: false });
  assert.equal(off.warning, null, 'job off: nothing is acting');
  assert.equal(off.refusing, false);
  const list = P.pilotStatus(P.parsePilot('cp1,' + hex(5), 'X'), { enabled: true });
  assert.equal(list.warning, null);
  assert.deepEqual(Object.keys(list).sort(), ['envVar', 'idCount', 'ids', 'idsTruncated', 'ignoredEntries', 'mode', 'previewOnly', 'refusing', 'unrecognisedEntries', 'warning']);
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
    assert.deepEqual(s.json.pilot, { envVar: 'NOTION_APPLICANTS_ONLY', mode: 'list', refusing: false, previewOnly: false, idCount: 1, ids: ['cp2'], idsTruncated: false, unrecognisedEntries: 0, ignoredEntries: 0, warning: null });
    assert.deepEqual(s.json.last.pilot, { mode: 'list', campaignsInPilot: 1, campaignsNotInPilot: 2, unmatchedEntries: 0 });
    assert.equal(s.json.last.counts.campaignsNotInPilot, 2);
    assert.ok(!JSON.stringify(s.json.pilot).includes('Fake'), 'no names in the pilot block');
  });
  const cfgAll = { intervalMin: 2, dryRun: false, pilot: pilotFrom('ALL') };
  await withRoutes(mk(cfgAll, job), async (call) => {
    const s = await call('GET', '/api/notion-applicants/status', 'staff@example.invalid');
    assert.equal(s.json.pilot.mode, 'all');
    assert.match(s.json.pilot.warning, /Acting on ALL campaigns/);
  });
  const cfgUnset = { intervalMin: 2, dryRun: false, pilot: pilotFrom(undefined) };
  await withRoutes(mk(cfgUnset, job), async (call) => {
    const s = await call('GET', '/api/notion-applicants/status', 'staff@example.invalid');
    assert.equal(s.json.pilot.mode, 'unset');
    assert.equal(s.json.pilot.refusing, true);
    assert.equal(s.json.pilot.warning, 'refusing: set NOTION_APPLICANTS_ONLY to a campaign list, or to ALL to act on every campaign');
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
  assert.equal(st.unrecognisedEntries, 0);
  /* the date job: the entry's pilot block and items stay ids and counts */
  const m = dwMake({ DATE_WRITEBACK_ONLY: 'cp1' });
  const dw = await m.job.run({ trigger: 'manual' });
  ['Fake One', 'fake.one', 'Fake Two', 'fake.two'].forEach((s) => assert.ok(!JSON.stringify(dw).includes(s), s));
});

test('status ids echo: only campaign-id-shaped or Notion-id values are shown; anything else is a count only, never the text', () => {
  const secret = ['MariaKim', 'jane.doe_99', 'kim-minji', 'Brand-Name', 'handle_only'];
  const raw = ['cp1', 'cmp8abc12def', hex(7), secret.join(',')].join(',');
  const st = P.pilotStatus(P.parsePilot(raw, 'X'), { enabled: true });
  assert.deepEqual(st.ids, ['cp1', 'cmp8abc12def', dashed(7)]);
  assert.equal(st.unrecognisedEntries, secret.length);
  assert.equal(st.idCount, 3 + secret.length);
  const blob = JSON.stringify(st);
  secret.forEach((x) => assert.ok(!blob.includes(x), x));
  /* a name-like string with a cp prefix and no digit is not shaped like an id either */
  const st2 = P.pilotStatus(P.parsePilot('cpmorgan,cp1', 'X'), { enabled: true });
  assert.deepEqual(st2.ids, ['cp1']); assert.equal(st2.unrecognisedEntries, 1);
  assert.ok(!JSON.stringify(st2).includes('cpmorgan'));
});

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
async function bootServer(env, wait) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(port) }, env), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('did not start: ' + out)), 15000);
    const on = (d) => { out += d; if (out.includes('VIVELY app listening on port')) { clearTimeout(t); resolve(); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', () => reject(new Error('exited early: ' + out)));
  });
  await new Promise((r) => setTimeout(r, wait || 300));
  const output = out; child.kill();
  return output;
}
const FLAGS_ON = { NOTION_TOKEN: 'test-token-not-real', MONGODB_URI: 'mongodb://127.0.0.1:1/never', NOTION_API: 'http://127.0.0.1:1/v1', GOOGLE_SERVICE_ACCOUNT: 'g-secret-not-real', STAFF_EMAILS: 'staff@example.invalid' };

test('startup log (real server, own port): flags on with no list = "refusing" in the log; a list or ALL does not; flags OFF by default (nothing said)', async () => {
  const unset = await bootServer(Object.assign({ NOTION_APPLICANTS_SYNC: '1', NOTION_DATE_WRITEBACK: '1' }, FLAGS_ON));
  assert.match(unset, /Notion applicants sync: refusing: set NOTION_APPLICANTS_ONLY to a campaign list, or to ALL to act on every campaign/);
  assert.match(unset, /Date write-back: refusing: set DATE_WRITEBACK_ONLY to a campaign list, or to ALL to act on every campaign/);
  assert.ok(!unset.includes('test-token-not-real') && !unset.includes('g-secret-not-real'));
  const all = await bootServer(Object.assign({ NOTION_APPLICANTS_SYNC: '1', NOTION_APPLICANTS_ONLY: 'ALL', NOTION_DATE_WRITEBACK: '1', DATE_WRITEBACK_ONLY: 'all' }, FLAGS_ON));
  assert.ok(!/refusing/.test(all));
  assert.match(all, /WARNING, acting on ALL campaigns \(NOTION_APPLICANTS_ONLY=ALL\)/);
  const list = await bootServer(Object.assign({ NOTION_APPLICANTS_SYNC: '1', NOTION_APPLICANTS_ONLY: 'cp1', NOTION_DATE_WRITEBACK: '1', DATE_WRITEBACK_ONLY: 'cp1' }, FLAGS_ON));
  assert.ok(!/refusing/.test(list));
  assert.match(list, /Notion applicants sync: pilot mode \(list\), 1 allow-list id/);
  const dry = await bootServer(Object.assign({ NOTION_APPLICANTS_SYNC: '1', NOTION_APPLICANTS_DRY_RUN: '1', NOTION_DATE_WRITEBACK: '1', NOTION_DATE_WRITEBACK_DRY_RUN: '1' }, FLAGS_ON));
  assert.ok(!/refusing/.test(dry));
  assert.match(dry, /dry-run preview of every campaign; a live run would be refused/);
  const off = await bootServer({});
  assert.ok(!/refusing|applicants|write-back/i.test(off), 'defaults: both jobs are off and say nothing');
});

test('server.js wiring: both env names are read, the list is passed to the job, the date status shows it', () => {
  const src = fs.readFileSync(ROOT + 'server.js', 'utf8');
  assert.match(src, /pilot: applicantsCfg\.pilot/);
  assert.match(src, /dateWritebackLib\.pilotStatus\(dwCfg\.pilot/);
  assert.match(src, /mustRefuse\(applicantsCfg\.pilot/);
  assert.match(src, /mustRefuse\(dwCfg\.pilot/);
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
