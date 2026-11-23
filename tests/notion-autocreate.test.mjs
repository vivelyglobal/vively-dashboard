/* Notion -> dashboard campaign autocreate (server/notion-autocreate.js).

   Fixtures are built from what was seen in the real parent page (titles with
   emoji, language tags, TEMPLATE / TEST pages, a (postponed) page, plain
   text blocks that are not pages). No live Notion call is made: Notion is a
   function, or the local tools/fake-notion.cjs, and the workspace is an
   in-memory stand-in that enforces the same revision rule as the server. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const A = require('../server/notion-autocreate.js');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PARENT = '383ce5b8-09f9-808e-8aaa-e7021218ae00';
const hex = (n) => n.toString(16).padStart(32, '0');
const pid = (n) => A.normalizeId(hex(n));

/* ---------- fixtures ---------- */
const TITLES = {
  1: '🌸 Aura Seoul x Vively | Creator Application (jp)',
  2: '🌸 Aura Seoul x Vively | Creator Application (Eng)',
  3: '🍣 Sushikoji x Vively | Creator Application (postponed)',
  4: '🔴 TEMPLATE (MAIN) 🔴',
  5: 'TEST FORM',
  6: 'TEST Aura Seoul x Vively | Creator Application',
  7: '✨ Lumi Beauty x Vively (wld)'
};
const page = (n, extra) => Object.assign({
  object: 'block', id: hex(n), type: 'child_page', archived: false,
  created_time: '2026-10-1' + (n % 9) + 'T03:00:00.000Z', child_page: { title: TITLES[n] }
}, extra || {});
const text = (s) => ({ object: 'block', id: hex(900 + s.length), type: 'paragraph', paragraph: { rich_text: [{ plain_text: s }] } });
const dbBlock = (n, title) => ({ object: 'block', id: hex(n), type: 'child_database', child_database: { title: title || 'Responses' } });

function makeNotion(parentChildren, pageChildren, dsOf) {
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    let m = path.match(/^\/blocks\/([^/?]+)\/children/);
    if (m) {
      if (m[1] === PARENT) return { results: parentChildren, has_more: false };
      if (pageChildren[m[1]] === 'fail') throw new Error('rate limited');
      return { results: pageChildren[m[1]] || [], has_more: false };
    }
    m = path.match(/^\/databases\/([^/?]+)/);
    if (m) return { data_sources: [{ id: dsOf[m[1]] || m[1], name: 'Responses' }] };
    throw new Error('unexpected path ' + path);
  };
  return { get, calls };
}

/* in-memory workspace with the server's revision rule; `beforeSave` lets a
   test play another browser saving first */
function makeStore(campaigns, opts) {
  const o = opts || {};
  const st = { doc: { db: { campaigns, creators: [{ id: 'c1' }], participants: [] }, settings: { s: 1 }, revision: 7 },
    saves: [], conflicts: 0, hooks: o.beforeSave || [] };
  st.loadWorkspace = async () => (o.empty ? null : JSON.parse(JSON.stringify(st.doc)));
  st.saveWorkspace = async (w) => {
    const hook = st.hooks.shift();
    if (hook) hook(st.doc);
    st.saves.push({ revision: w.revision, keys: Object.keys(w).sort() });
    if (w.revision !== st.doc.revision) { st.conflicts++; return { conflict: true }; }
    st.doc = { db: JSON.parse(JSON.stringify(w.db)), settings: w.settings, revision: st.doc.revision + 1 };
    return { ok: true, revision: st.doc.revision };
  };
  return st;
}

/* the job's own state document, in memory, counting every write */
function makeJobState(init) {
  const st = { value: init === undefined ? null : init, writes: 0, logs: [] };
  st.loadState = async () => (st.value ? JSON.parse(JSON.stringify(st.value)) : null);
  st.saveState = async (v) => { st.writes++; st.value = JSON.parse(JSON.stringify(v)); };
  st.saveLog = async (e) => { st.logs.push(e); };
  return st;
}
/* a baseline long ago: every fixture page (created October 2026) counts as new */
const OLD_BASELINE = { baselineAt: '2026-01-01T00:00:00.000Z', baselineSeen: [], dismissed: [], createdIds: [] };

let idN = 0;
function job(notion, store, extra) {
  const x = extra || {};
  const js = x.jobState || makeJobState(OLD_BASELINE);
  return A.createAutocreate(Object.assign({
    parentId: PARENT, notionGet: notion.get,
    loadWorkspace: store.loadWorkspace, saveWorkspace: store.saveWorkspace,
    loadState: js.loadState, saveState: js.saveState, saveLog: js.saveLog,
    newId: () => 'cpTEST' + (++idN), now: () => new Date('2026-11-23T10:00:00Z'),
    logger: { error() {}, log() {} }
  }, x));
}

const standardParent = () => [
  text('KOWORK'), text('LABAB'), text('LABIOTTE'),
  page(1), page(2), page(3), page(4), page(5), page(6), page(7)
];
const withForms = () => ({
  [pid(1)]: [dbBlock(101)], [pid(2)]: [dbBlock(102)], [pid(3)]: [dbBlock(103)], [pid(7)]: [dbBlock(107)]
});
const titles = (arr) => arr.map((x) => x.title);

/* ---------- pure rules ---------- */

test('skip rule: TEMPLATE and TEST titles, whole word, any case; real brands are not skipped', () => {
  assert.equal(A.isSkippedTitle(TITLES[4]), true);
  assert.equal(A.isSkippedTitle(TITLES[5]), true);
  assert.equal(A.isSkippedTitle(TITLES[6]), true);
  assert.equal(A.isSkippedTitle('Template (copy)'), true);
  assert.equal(A.isSkippedTitle('x test y'), true);
  assert.equal(A.isSkippedTitle(TITLES[1]), false);
  assert.equal(A.isSkippedTitle('Latest Skin x Vively'), false);
  assert.equal(A.isSkippedTitle('Contest House x Vively'), false);
});

test('titles: emoji and the postponed tag are cleaned, language tags are kept and distinguish copies', () => {
  assert.equal(A.cleanTitle(TITLES[3]), 'Sushikoji x Vively | Creator Application');
  assert.equal(A.isPostponedTitle(TITLES[3]), true);
  assert.equal(A.isPostponedTitle(TITLES[1]), false);
  assert.equal(A.cleanTitle(TITLES[1]), 'Aura Seoul x Vively | Creator Application (jp)');
  assert.notEqual(A.normaliseTitle(TITLES[1]), A.normaliseTitle(TITLES[2]));
  assert.equal(A.normaliseTitle('🌸  AURA seoul X Vively | creator application (JP)'), A.normaliseTitle(TITLES[1]));
  assert.equal(A.brandOf(TITLES[1]), 'Aura Seoul');
});

/* ---------- the job ---------- */

test('first run: creates real campaigns only; TEMPLATE/TEST skipped; plain-text blocks ignored', async () => {
  const notion = makeNotion(standardParent(), withForms(), {});
  const store = makeStore([]);
  const run = await job(notion, store).run();
  assert.equal(run.ok, true);
  assert.equal(run.created.length, 4);
  assert.deepEqual(titles(run.created).sort(), [
    'Aura Seoul x Vively | Creator Application (Eng)', 'Aura Seoul x Vively | Creator Application (jp)',
    'Lumi Beauty x Vively (wld)', 'Sushikoji x Vively | Creator Application'].sort());
  assert.equal(run.skipped.length, 3);
  assert.ok(run.skipped.every((s) => s.why === 'template-or-test'));
  assert.equal(run.ignoredBlocks, 3);           // KOWORK, LABAB, LABIOTTE
  assert.equal(store.doc.db.campaigns.length, 4);
  assert.equal(store.doc.db.creators.length, 1, 'other collections untouched');
  assert.deepEqual(store.doc.settings, { s: 1 });
  const cp = store.doc.db.campaigns.find((c) => c.notionPageId === pid(1));
  assert.equal(cp.status, 'planning');
  assert.equal(cp.source, 'notion-auto');
  assert.equal(cp.notionDatabaseId, pid(101));
  assert.equal(cp.brand, 'Aura Seoul');
  assert.ok(!JSON.stringify(store.doc.db.campaigns).includes('notion.so'), 'no Notion url stored');
});

test('postponed title is imported with the postponed flag, in the earliest status', async () => {
  const notion = makeNotion([page(3)], withForms(), {});
  const store = makeStore([]);
  await job(notion, store).run();
  const cp = store.doc.db.campaigns[0];
  assert.equal(cp.postponed, true);
  assert.equal(cp.status, 'planning');
  assert.match(cp.note, /postponed/i);
  assert.ok(!/postponed/i.test(cp.name), 'tag removed from the name');
});

test('idempotent: a second and third run create nothing and write nothing', async () => {
  const notion = makeNotion(standardParent(), withForms(), {});
  const store = makeStore([]);
  const j = job(notion, store);
  await j.run();
  const after1 = JSON.stringify(store.doc);
  const savesAfter1 = store.saves.length;
  const r2 = await j.run();
  const r3 = await j.run();
  assert.equal(r2.created.length + r3.created.length, 0);
  assert.equal(r2.alreadyLinked, 4);
  assert.equal(store.saves.length, savesAfter1, 'no save when nothing changed');
  assert.equal(JSON.stringify(store.doc), after1);
  assert.equal(store.doc.db.campaigns.length, 4);
});

test('a campaign that already has the notionPageId (any id format) is never duplicated', async () => {
  const store = makeStore([{ id: 'old', name: 'Whatever', notionPageId: hex(1) }]); // undashed form
  const notion = makeNotion([page(1)], withForms(), {});
  const run = await job(notion, store).run();
  assert.equal(run.created.length, 0);
  assert.equal(run.alreadyLinked, 1);
  assert.equal(store.doc.db.campaigns.length, 1);
});

test('manual campaign found by its stored Notion form id is LINKED, not duplicated', async () => {
  /* a hand import stores the data source id of the form (notionImport.js) */
  const manual = { id: 'm1', brand: 'Aura', name: 'Aura JP seeding', notionDatabaseId: pid(101), status: 'outreach' };
  const store = makeStore([manual]);
  const notion = makeNotion([page(1)], withForms(), {});
  const run = await job(notion, store).run();
  assert.equal(run.created.length, 0);
  assert.equal(run.linked.length, 1);
  assert.equal(run.linked[0].by, 'database');
  const c = store.doc.db.campaigns;
  assert.equal(c.length, 1);
  assert.equal(c[0].notionPageId, pid(1));
  assert.equal(c[0].status, 'outreach', 'existing fields are not changed');
  assert.equal(c[0].name, 'Aura JP seeding');
});

test('manual campaign found by exact normalised title (no form id) is linked and gets the form id', async () => {
  const manual = { id: 'm2', brand: 'Lumi Beauty', name: 'Lumi Beauty x Vively (WLD)', status: 'live' };
  const store = makeStore([manual]);
  const notion = makeNotion([page(7)], withForms(), {});
  const run = await job(notion, store).run();
  assert.equal(run.linked.length, 1);
  assert.equal(run.linked[0].by, 'title');
  assert.equal(run.created.length, 0);
  assert.equal(store.doc.db.campaigns.length, 1);
  assert.equal(store.doc.db.campaigns[0].notionPageId, pid(7));
  assert.equal(store.doc.db.campaigns[0].notionDatabaseId, pid(107));
});

test('brand + name also matches; a different language copy does NOT match (each copy is its own campaign)', async () => {
  const jp = { id: 'm3', brand: 'Aura Seoul', name: 'x Vively | Creator Application (jp)' };
  const store = makeStore([jp]);
  const notion = makeNotion([page(1), page(2)], withForms(), {});
  const run = await job(notion, store).run();
  assert.equal(run.linked.length, 1);
  assert.equal(run.linked[0].pageId, pid(1));
  assert.equal(run.created.length, 1);
  assert.equal(run.created[0].pageId, pid(2));
});

test('a campaign tied to a DIFFERENT form is not linked by title', async () => {
  const other = { id: 'm4', name: 'Lumi Beauty x Vively (wld)', notionDatabaseId: pid(555) };
  const store = makeStore([other]);
  const notion = makeNotion([page(7)], withForms(), {});
  const run = await job(notion, store).run();
  assert.equal(run.linked.length, 0);
  assert.equal(run.created.length, 1, 'treated as a new campaign');
  assert.equal(store.doc.db.campaigns.find((c) => c.id === 'm4').notionPageId, undefined);
});

test('ambiguous: two manual campaigns match one page -> reported, nothing created or linked', async () => {
  const a = { id: 'a', name: 'Lumi Beauty x Vively (wld)' };
  const b = { id: 'b', brand: 'Lumi Beauty', name: 'x Vively (wld)' };
  const store = makeStore([a, b]);
  const notion = makeNotion([page(7)], withForms(), {});
  const run = await job(notion, store).run();
  assert.equal(run.ambiguous.length, 1);
  assert.equal(run.ambiguous[0].matches, 2);
  assert.equal(run.created.length, 0);
  assert.equal(run.linked.length, 0);
  assert.equal(store.saves.length, 0, 'nothing to write');
  assert.equal(store.doc.db.campaigns.length, 2);
  assert.ok(store.doc.db.campaigns.every((c) => !c.notionPageId));
});

test('ambiguous: one manual campaign wanted by two pages -> neither links, neither creates', async () => {
  const pages = [page(7), Object.assign(page(7), { id: hex(8) })];       // same title twice
  const store = makeStore([{ id: 'only', name: 'Lumi Beauty x Vively (wld)' }]);
  const notion = makeNotion(pages, { [pid(7)]: [dbBlock(107)], [pid(8)]: [dbBlock(108)] }, {});
  const run = await job(notion, store).run();
  assert.equal(run.ambiguous.length, 2);
  assert.equal(run.ambiguous[0].sharedWithOtherPage, true);
  assert.equal(run.linked.length + run.created.length, 0);
});

test('409: re-reads and retries WITHOUT force, keeps the other writer\'s edit, creates once', async () => {
  const store = makeStore([{ id: 'x1', name: 'Existing' }], {
    beforeSave: [(doc) => { doc.revision += 1; doc.db.campaigns.push({ id: 'typed-in-browser', name: 'Someone typed this' }); }]
  });
  const notion = makeNotion([page(7)], withForms(), {});
  const run = await job(notion, store).run();
  assert.equal(run.ok, true);
  assert.equal(run.attempts, 2);
  assert.equal(store.conflicts, 1);
  assert.equal(store.saves.length, 2);
  /* (the real force:false check is in the "real wrapper" tests below; this fake store
     only sees the fields the job hands to its saveWorkspace dependency) */
  assert.ok(store.saves[1].revision > store.saves[0].revision, 'second try carries the re-read revision');
  const names = store.doc.db.campaigns.map((c) => c.name);
  assert.ok(names.includes('Someone typed this'), 'the concurrent edit survived');
  assert.equal(store.doc.db.campaigns.filter((c) => c.notionPageId === pid(7)).length, 1);
});

test('409 forever: gives up after the cap, writes nothing, says so', async () => {
  const hooks = Array.from({ length: 10 }, () => (doc) => { doc.revision += 1; });
  const store = makeStore([], { beforeSave: hooks });
  const notion = makeNotion([page(7)], withForms(), {});
  const run = await job(notion, store, { maxAttempts: 3 }).run();
  assert.equal(run.ok, false);
  assert.equal(run.attempts, 3);
  assert.match(run.errors.join(' '), /gave up/);
  assert.equal(store.doc.db.campaigns.length, 0);
});

test('a duplicate created by a racing run is avoided: after a 409 the re-read already holds the page', async () => {
  const racer = { id: 'racer', name: 'Lumi Beauty x Vively (wld)', notionPageId: hex(7) };
  const store = makeStore([], { beforeSave: [(doc) => { doc.revision += 1; doc.db.campaigns.push(racer); }] });
  const notion = makeNotion([page(7)], withForms(), {});
  const run = await job(notion, store).run();
  assert.equal(store.doc.db.campaigns.length, 1);
  assert.equal(run.created.length, 0);
  assert.equal(run.alreadyLinked, 1);
});

test('form lookup failure defers the page (no guess, no create) and the next run picks it up', async () => {
  const kids = Object.assign(withForms(), { [pid(7)]: 'fail' });
  const store = makeStore([]);
  const notion = makeNotion([page(7)], kids, {});
  const j = job(notion, store);
  const r1 = await j.run();
  assert.equal(r1.created.length, 0);
  assert.equal(r1.deferred.length, 1);
  assert.equal(store.doc.db.campaigns.length, 0);
  kids[pid(7)] = [dbBlock(107)];
  const r2 = await j.run();
  assert.equal(r2.created.length, 1);
});

test('create cap: more new pages than the cap are deferred, not mass-created', async () => {
  const notion = makeNotion(standardParent(), withForms(), {});
  const store = makeStore([]);
  const run = await job(notion, store, { maxCreate: 2 }).run();
  assert.equal(run.created.length, 2);
  assert.equal(run.deferred.filter((d) => d.why === 'create-cap').length, 2);
  assert.equal(store.doc.db.campaigns.length, 2);
});

test('dry run: reports what it would do and writes nothing', async () => {
  const store = makeStore([{ id: 'm', name: 'Lumi Beauty x Vively (wld)' }]);
  const notion = makeNotion(standardParent(), withForms(), {});
  const js = makeJobState(OLD_BASELINE);
  const run = await job(notion, store, { dryRun: true, jobState: js }).run();
  assert.equal(run.dryRun, true);
  assert.equal(run.linked.length, 1);
  assert.equal(run.created.length, 3);
  assert.equal(store.saves.length, 0);
  assert.equal(store.doc.db.campaigns.length, 1);
  assert.equal(store.doc.revision, 7);
  assert.equal(js.writes, 0, 'a dry run writes no state');
  assert.equal(js.logs.length, 0, 'a dry run writes no run log');
});

test('no workspace document yet: nothing is created from nothing', async () => {
  const store = makeStore([], { empty: true });
  const run = await job(makeNotion([page(7)], withForms(), {}), store).run();
  assert.equal(run.created.length, 0);
  assert.match(run.errors.join(' '), /no workspace/);
  assert.equal(store.saves.length, 0);
});

test('Notion listing failure: reported, no writes, error text carries no token', async () => {
  const store = makeStore([]);
  const notion = { get: async () => { throw new Error('boom Bearer secret_ABC123xyz'); } };
  const run = await job(notion, store).run();
  assert.equal(run.ok, false);
  assert.ok(!/secret_ABC123xyz/.test(JSON.stringify(run)));
  assert.equal(store.saves.length, 0);
});

test('only GET paths under the parent and the page ids it lists are requested; no creator rows', async () => {
  const notion = makeNotion(standardParent(), withForms(), {});
  await job(notion, makeStore([])).run();
  const allowed = [PARENT, ...[1, 2, 3, 7].map(hex)].map((x) => A.normalizeId(x));
  notion.calls.forEach((c) => {
    assert.ok(/^\/(blocks\/[0-9a-f-]+\/children|databases\/[0-9a-f-]+)/.test(c), c);
    assert.ok(!/query|data_sources/.test(c), 'no row queries: ' + c);
    const m = c.match(/^\/blocks\/([0-9a-f-]+)\//);
    if (m) assert.ok(allowed.includes(m[1]), 'unlisted page requested: ' + c);
  });
  assert.ok(!notion.calls.some((c) => c.includes(hex(4)) || c.includes(hex(5)) || c.includes(hex(6))), 'skipped pages are not even opened');
});

test('the run log holds titles and ids only, never a Notion url or a person', async () => {
  const store = makeStore([]);
  const run = await job(makeNotion(standardParent(), withForms(), {}), store).run();
  const s = JSON.stringify(run);
  assert.ok(!/notion\.so|https?:/.test(s));
  const okKeys = ['pageId', 'title', 'why', 'by', 'matches', 'campaignId', 'postponed', 'sharedWithOtherPage'];
  Object.values(run).forEach((v) => {
    if (!Array.isArray(v)) return;
    v.forEach((x) => {
      if (typeof x !== 'object') return;
      assert.ok(Object.keys(x).every((k) => okKeys.includes(k)), JSON.stringify(x));
    });
  });
});

test('overlapping runs: the second returns busy instead of racing', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const store = makeStore([]);
  const slow = { get: async (p) => { await gate; return makeNotion([page(7)], withForms(), {}).get(p); } };
  const j = job(slow, store);
  const p1 = j.run();
  const r2 = await j.run();
  assert.equal(r2.busy, true);
  release();
  await p1;
  assert.equal(store.doc.db.campaigns.length, 1);
});

/* ---------- baseline: no bulk backfill ---------- */

const manyPages = (n, createdTime) => Array.from({ length: n }, (_, i) => ({
  object: 'block', id: hex(2000 + i), type: 'child_page', archived: false,
  created_time: createdTime, child_page: { title: 'Brand' + i + ' x Vively | Creator Application' }
}));
const NEW_PAGE = (n, title) => ({
  object: 'block', id: hex(n), type: 'child_page', archived: false,
  created_time: '2026-11-23T11:00:00.000Z', child_page: { title }
});

test('baseline: the first live run creates NOTHING from the pages already there, records the baseline, and links an exact hand-made match', async () => {
  const js = makeJobState(null);                                        // never ran before
  const store = makeStore([{ id: 'm', name: 'Lumi Beauty x Vively (wld)' }]);
  const notion = makeNotion(standardParent(), withForms(), {});
  const run = await job(notion, store, { jobState: js }).run();
  assert.equal(run.created.length, 0, 'no page is created on the baseline run');
  assert.equal(run.linked.length, 1, 'the one exact match is still linked');
  assert.equal(run.seen.length, 3, 'the other real pages are reported as seen');
  assert.ok(run.seen.every((x) => x.why === 'baseline-seen'));
  assert.equal(run.baseline.recorded, true);
  assert.equal(store.doc.db.campaigns.length, 1, 'no campaign was added');
  assert.equal(js.value.baselineAt, '2026-11-23T10:00:00.000Z');
  assert.ok(js.value.baselineSeen.includes(pid(1)) && js.value.baselineSeen.includes(pid(7)));
});

test('baseline: ~35 existing pages and ten polls create nothing; then only a page made AFTER the baseline is created', async () => {
  const js = makeJobState(null);
  const store = makeStore([]);
  const parent = [...manyPages(35, '2026-09-01T00:00:00.000Z')];
  const notion = makeNotion(parent, {}, {});
  const j = job(notion, store, { jobState: js });
  for (let i = 0; i < 10; i++) { const r = await j.run(); assert.equal(r.created.length, 0, 'poll ' + i); }
  assert.equal(store.doc.db.campaigns.length, 0);
  assert.equal(store.saves.length, 0);
  assert.equal(js.value.baselineSeen.length, 35);
  /* after the baseline, older pages are not even opened */
  const before = notion.calls.length;
  await j.run();
  assert.equal(notion.calls.length - before, 1, 'one listing call, no per-page lookups');
  /* a genuinely new page */
  parent.push(NEW_PAGE(7, TITLES[7]));
  const r = await j.run();
  assert.equal(r.created.length, 1);
  assert.equal(r.olderPages, 35);
  assert.equal(store.doc.db.campaigns.length, 1);
});

test('baseline: a page that is not in the baseline list but was created BEFORE it is not created (created_time rule)', async () => {
  const js = makeJobState({ baselineAt: '2026-11-01T00:00:00.000Z', baselineSeen: [], dismissed: [], createdIds: [] });
  const store = makeStore([]);
  const run = await job(makeNotion([page(7)], withForms(), {}), store, { jobState: js }).run();   // page(7) created 2026-10
  assert.equal(run.created.length, 0);
  assert.equal(run.olderPages, 1);
  assert.equal(store.saves.length, 0);
});

test('baseline: a dry run before the baseline reports it would record one, and records nothing', async () => {
  const js = makeJobState(null);
  const store = makeStore([]);
  const run = await job(makeNotion(standardParent(), withForms(), {}), store, { jobState: js, dryRun: true }).run();
  assert.equal(run.baseline.wouldRecord, true);
  assert.equal(run.baseline.recorded, false);
  assert.equal(run.created.length, 0);
  assert.equal(js.writes, 0);
  assert.equal(js.value, null);
  assert.equal(js.logs.length, 0);
  assert.equal(store.saves.length, 0);
});

test('a live run is logged; a dry run is not (the log is only written for real runs)', async () => {
  const js = makeJobState(OLD_BASELINE);
  const store = makeStore([]);
  await job(makeNotion([page(7)], withForms(), {}), store, { jobState: js }).run();
  assert.equal(js.logs.length, 1);
});

/* ---------- per-day cap ---------- */

test('day cap: 8 new pages, cap 5 a day -> 5 now, none later the same day, the rest the next day', async () => {
  const js = makeJobState(OLD_BASELINE);
  let clock = new Date('2026-11-23T10:00:00Z');
  const store = makeStore([]);
  const parent = Array.from({ length: 8 }, (_, i) => NEW_PAGE(3000 + i, 'Shop' + i + ' x Vively'));
  const j = job(makeNotion(parent, {}, {}), store, { jobState: js, maxCreate: 10, maxPerDay: 5, now: () => clock });
  const r1 = await j.run();
  assert.equal(r1.created.length, 5);
  assert.equal(r1.deferred.filter((x) => x.why === 'day-cap').length, 3);
  const r2 = await j.run();
  assert.equal(r2.created.length, 0, 'a later poll the same day: nothing more');
  clock = new Date('2026-11-24T00:05:00Z');
  const r3 = await j.run();
  assert.equal(r3.created.length, 3);
  assert.equal(store.doc.db.campaigns.length, 8);
});

test('config: per-run and per-day caps come from env; blank or junk falls back to the defaults', () => {
  const P = { NOTION_AUTOCREATE_PARENT_ID: PARENT };
  const both = Object.assign({ NOTION_AUTOCREATE_MAX_PER_DAY: '2', NOTION_AUTOCREATE_MAX_CREATE: '1' }, P);
  assert.equal(A.parseConfig(both).maxPerDay, 2);
  assert.equal(A.parseConfig(both).maxCreate, 1);
  assert.equal(A.parseConfig(Object.assign({ NOTION_AUTOCREATE_MAX_PER_DAY: '0' }, P)).maxPerDay, 0, '0 is allowed: nothing is ever created');
  assert.equal(A.parseConfig(Object.assign({ NOTION_AUTOCREATE_MAX_PER_DAY: '' }, P)).maxPerDay, 5);
  assert.equal(A.parseConfig(Object.assign({ NOTION_AUTOCREATE_MAX_PER_DAY: 'lots' }, P)).maxPerDay, 5);
  assert.equal(A.parseConfig(Object.assign({ NOTION_AUTOCREATE_MAX_PER_DAY: '-3' }, P)).maxPerDay, 5);
});

/* ---------- dismissed pages ---------- */

test('dismissed: a dismissed page is never created, and the run says so; undismiss brings it back', async () => {
  const js = makeJobState(OLD_BASELINE);
  const store = makeStore([]);
  const j = job(makeNotion([page(7), page(1)], withForms(), {}), store, { jobState: js });
  const d = await j.dismiss(hex(7).toUpperCase());
  assert.equal(d.ok, true);
  assert.equal(d.pageId, pid(7));
  const r1 = await j.run();
  assert.deepEqual(r1.created.map((x) => x.pageId), [pid(1)]);
  assert.deepEqual(r1.dismissed.map((x) => x.pageId), [pid(7)]);
  await j.undismiss(pid(7));
  const r2 = await j.run();
  assert.deepEqual(r2.created.map((x) => x.pageId), [pid(7)]);
  assert.equal((await j.dismiss('not an id')).ok, false);
});

test('dismissed: a campaign staff DELETE after it was auto-created is not recreated on the next poll', async () => {
  const js = makeJobState(OLD_BASELINE);
  const store = makeStore([]);
  const j = job(makeNotion([page(7)], withForms(), {}), store, { jobState: js });
  const r1 = await j.run();
  assert.equal(r1.created.length, 1);
  assert.deepEqual(js.value.createdIds, [pid(7)]);
  store.doc.db.campaigns = [];                       // staff delete it in the dashboard and save
  const r2 = await j.run();
  assert.equal(r2.created.length, 0, 'not recreated');
  assert.equal(r2.dismissed.length, 1);
  assert.equal(store.doc.db.campaigns.length, 0);
  assert.ok(js.value.dismissed.includes(pid(7)), 'remembered as dismissed');
  const r3 = await j.run();
  assert.equal(r3.created.length, 0);
});

test('dismissed: a dismissal made while a poll is running is not overwritten by that poll', async () => {
  const js = makeJobState(OLD_BASELINE);
  const store = makeStore([]);
  let release; const gate = new Promise((r) => { release = r; });
  const inner = makeNotion([page(7), page(1)], withForms(), {});
  const slow = { get: async (p) => { await gate; return inner.get(p); } };
  const j = job(slow, store, { jobState: js });
  const p1 = j.run();
  await j.dismiss(pid(3));                          // an unrelated page, dismissed mid-run
  release();
  await p1;
  assert.ok(js.value.dismissed.includes(pid(3)), 'the dismissal survived the poll\'s own state write');
  assert.equal(store.doc.db.campaigns.length, 2);
});

/* ---------- staff create by page id ---------- */

test('create-page: staff can deliberately create ONE older page the baseline left alone; it must be a child of the parent', async () => {
  const js = makeJobState(null);
  const store = makeStore([]);
  const notion = makeNotion([page(7), page(1)], withForms(), {});
  const j = job(notion, store, { jobState: js });
  await j.run();                                       // baseline: nothing created
  assert.equal(store.doc.db.campaigns.length, 0);
  const r = await j.createPage(pid(7));
  assert.deepEqual(r.created.map((x) => x.pageId), [pid(7)]);
  assert.equal(store.doc.db.campaigns.length, 1);
  assert.equal(store.doc.db.campaigns[0].notionPageId, pid(7));
  const bad = await j.createPage(hex(777));
  assert.match(bad.errors.join(' '), /not a direct child/);
  assert.equal((await j.createPage('nonsense')).errors[0], 'not a Notion page id');
  assert.equal(store.doc.db.campaigns.length, 1);
  /* it also overrides a dismissal, and clears it */
  await j.dismiss(pid(1));
  const r2 = await j.createPage(pid(1));
  assert.equal(r2.created.length, 1);
  assert.ok(!js.value.dismissed.includes(pid(1)));
});

test('create-page: a TEMPLATE page is still refused, and a dry run creates nothing', async () => {
  const store = makeStore([]);
  const j = job(makeNotion([page(4), page(7)], withForms(), {}), store);
  const t = await j.createPage(pid(4));
  assert.equal(t.created.length, 0);
  assert.equal(t.skipped.length, 1);
  const dry = await j.createPage(pid(7), { dryRun: true });
  assert.equal(dry.created.length, 1);
  assert.equal(store.saves.length, 0);
});

/* ---------- the real wrapper, and the real saveWorkspaceDoc ---------- */

test('real wrapper (makeSaveWorkspace, the one server.js uses): hands saveWorkspaceDoc force === false, and maps 409 / 200 / other', async () => {
  const seen = [];
  let status = 200;
  const w = A.makeSaveWorkspace(async (body) => {
    seen.push(body);
    return status === 200 ? { status, json: { ok: true, revision: 9 } } : { status, json: { error: 'nope' } };
  });
  assert.deepEqual(await w({ db: { campaigns: [] }, settings: { a: 1 }, revision: 8 }), { ok: true, revision: 9 });
  assert.equal(seen[0].force, false, 'force is exactly false');
  assert.ok(Object.prototype.hasOwnProperty.call(seen[0], 'force'));
  assert.equal(seen[0].revision, 8);
  assert.equal(seen[0].intent, undefined, 'no destructive-reset intent is ever sent');
  status = 409;
  assert.deepEqual(await w({ db: {}, settings: {}, revision: 1 }), { conflict: true });
  status = 502;
  await assert.rejects(() => w({ db: {}, settings: {}, revision: 1 }), /nope/);
  assert.ok(seen.every((b) => b.force === false));
});

test('server.js really uses that wrapper, and nothing in the autocreate block can send force:true', () => {
  const src = fs.readFileSync(ROOT + 'server.js', 'utf8');
  assert.ok(src.includes('saveWorkspace: notionAutocreate.makeSaveWorkspace(saveWorkspaceDoc)'));
  const a = src.indexOf('notionAutocreate.createAutocreate(');
  const b = src.indexOf('/* ---------------------------- google calendar');
  assert.ok(a > 0 && b > a);
  assert.ok(!/force\s*:\s*true|\bforce\s*:\s*!/.test(src.slice(a, b)), 'no force in the autocreate wiring');
});

/* The REAL saveWorkspaceDoc, cut out of server.js and run against a fake
   collection (server.js starts a server when loaded, so it cannot be
   imported). Its Mongo, booking and partner-link neighbours are stubs; the
   guard, revision check and write are the real code. */
function realSaveWorkspaceDoc(col) {
  const src = fs.readFileSync(ROOT + 'server.js', 'utf8');
  const a = src.indexOf('async function saveWorkspaceDoc(body) {');
  const b = src.indexOf('\n}\n', a);
  assert.ok(a > 0 && b > a, 'saveWorkspaceDoc found in server.js');
  const fn = new Function('getWorkspaceCollection', 'WORKSPACE_ID', 'wsGuard', 'bookingApi', 'bookingStore',
    'stampPartnerClients', 'PARTNER_LINK_TTL_DAYS', 'console', 'writeWorkspaceCas',
    'return (' + src.slice(a, b + 2) + ');');
  return fn(async () => col, 'shared', require('../server/workspace-guard.js'), null, {},
    () => ({ revokedKept: 0 }), 90, { error() {}, log() {}, warn() {} },
    require('../server/workspace-cas.js').writeWorkspaceCas);
}
function fakeCollection(doc) {
  const c = { doc, updates: 0, hooks: [] };
  c.findOne = async (q, o) => {
    const p = (o && o.projection) || {};
    if (p['db.partnerLinks']) return { db: { partnerLinks: [] } };
    if (p.revision) {
      const h = c.hooks.shift(); if (h) h(c.doc);                  // another browser saves in this gap
      return { revision: c.doc.revision, savedAt: 'x', campaigns: c.doc.db.campaigns.length,
        creators: c.doc.db.creators.length, participants: c.doc.db.participants.length };
    }
    return c.doc;
  };
  c.updateOne = async (q, u) => { c.updates++; const s = u.$set; c.doc = { db: s.db, settings: s.settings, revision: s.revision }; return { matchedCount: 1 }; };
  return c;
}

test('real saveWorkspaceDoc: a stale revision with force:false is refused with 409 and writes nothing', async () => {
  const col = fakeCollection({ db: { campaigns: [{ id: 'a' }], creators: [{ id: 'c' }], participants: [] }, settings: {}, revision: 5 });
  const save = realSaveWorkspaceDoc(col);
  const stale = await save({ db: { campaigns: [{ id: 'a' }], creators: [{ id: 'c' }], participants: [] }, settings: {}, revision: 4, force: false });
  assert.equal(stale.status, 409);
  assert.equal(col.updates, 0);
  const ok = await save({ db: { campaigns: [{ id: 'a' }, { id: 'b' }], creators: [{ id: 'c' }], participants: [] }, settings: {}, revision: 5, force: false });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.revision, 6);
});

test('409 through the real chain (job -> real wrapper -> real saveWorkspaceDoc): re-read, retry, keep the other writer\'s edit', async () => {
  const col = fakeCollection(
    { db: { campaigns: [{ id: 'x1', name: 'Existing' }], creators: [{ id: 'c' }], participants: [] }, settings: { s: 1 }, revision: 7 });
  const save = realSaveWorkspaceDoc(col);
  const store = {
    loadWorkspace: async () => JSON.parse(JSON.stringify(col.doc)),
    saveWorkspace: A.makeSaveWorkspace(save)
  };
  /* another browser saves in the gap between the job's read and its save */
  col.hooks = [(d) => { d.revision += 1; d.db.campaigns.push({ id: 'typed', name: 'Someone typed this' }); }];
  const j = job(makeNotion([page(7)], withForms(), {}), store);
  const run = await j.run();
  assert.equal(run.ok, true, run.errors.join(';'));
  assert.equal(run.attempts, 2, 'first save was a 409, the retry won');
  const names = col.doc.db.campaigns.map((c) => c.name);
  assert.ok(names.includes('Someone typed this'), 'the concurrent edit survived');
  assert.equal(col.doc.db.campaigns.filter((c) => c.notionPageId === pid(7)).length, 1);
  assert.equal(col.doc.db.creators.length, 1, 'other collections untouched');
  assert.equal(col.updates, 1, 'exactly one write reached the database');
});

/* ---------- config / flag ---------- */

test('flag: unset or blank parent id means OFF; a bad id is flagged; defaults are 5 min and cap 10', () => {
  assert.equal(A.parseConfig({}).requested, false);
  assert.equal(A.parseConfig({ NOTION_AUTOCREATE_PARENT_ID: '   ' }).requested, false);
  const bad = A.parseConfig({ NOTION_AUTOCREATE_PARENT_ID: 'not-an-id' });
  assert.equal(bad.requested, true); assert.equal(bad.invalid, true);
  const ok = A.parseConfig({ NOTION_AUTOCREATE_PARENT_ID: 'https://www.notion.so/x-383ce5b809f9808e8aaae7021218ae00' });
  assert.equal(ok.parentId, PARENT);
  assert.equal(ok.intervalMs, 5 * 60000);
  assert.equal(ok.maxCreate, 10);
  assert.equal(ok.maxPerDay, 5, 'default per-day cap is 5');
  assert.equal(A.parseConfig({ NOTION_AUTOCREATE_PARENT_ID: PARENT, NOTION_AUTOCREATE_INTERVAL_MIN: '0.01' }).intervalMs, 60000, 'floor of 1 minute');
  assert.equal(A.parseConfig({ NOTION_AUTOCREATE_PARENT_ID: PARENT, NOTION_AUTOCREATE_DRY_RUN: '1' }).dryRun, true);
});

/* ---------- over HTTP against tools/fake-notion.cjs ---------- */

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const httpJson = (port, method, path, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: '127.0.0.1', port, path, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
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

test('end to end over HTTP against the fake Notion: pagination, plain text, forms, idempotent re-run', async () => {
  const port = await freePort();
  const fake = await startProc('tools/fake-notion.cjs', { FAKE_NOTION_PORT: String(port) }, 'fake notion on');
  try {
    const many = [text('KOWORK'), page(1), page(4), page(5)];
    for (let i = 0; i < 120; i++) many.push(text('filler ' + i));      // forces a second page of children
    many.push(page(7));
    await httpJson(port, 'POST', '/__blocks', { [PARENT]: many, [pid(1)]: [dbBlock(101)], [pid(7)]: [dbBlock(107)] });
    await httpJson(port, 'POST', '/__form', { [pid(101)]: [], [pid(107)]: [] });
    const notionGet = async (p) => {
      const r = await fetch('http://127.0.0.1:' + port + '/v1' + p, { headers: { Authorization: 'Bearer test' } });
      const body = await r.json(); if (!r.ok) throw new Error(body.message); return body;
    };
    const store = makeStore([]);
    const j = job({ get: notionGet }, store);
    const r1 = await j.run();
    assert.equal(r1.errors.length, 0, r1.errors.join(';'));
    assert.deepEqual(titles(r1.created).sort(), ['Aura Seoul x Vively | Creator Application (jp)', 'Lumi Beauty x Vively (wld)']);
    assert.equal(r1.skipped.length, 2);
    assert.equal(r1.ignoredBlocks, 121);
    const r2 = await j.run();
    assert.equal(r2.created.length, 0);
    assert.equal(store.doc.db.campaigns.length, 2);
  } finally { fake.child.kill(); }
});

/* ---------- the real server process: flag off, staff-only ---------- */

async function withServer(env, fn) {
  const port = await freePort();
  const srv = await startProc('server.js', Object.assign({ PORT: String(port) }, env), 'VIVELY app listening on port');
  try { await fn(port, srv); } finally { srv.child.kill(); }
}

test('flag off: no polling is started, and the endpoints refuse an anonymous caller', async () => {
  await withServer({}, async (port, srv) => {
    assert.ok(!/Notion autocreate: ON/.test(srv.output()));
    const run = await httpJson(port, 'POST', '/api/notion/autocreate/run', {});
    const st = await httpJson(port, 'GET', '/api/notion/autocreate/status');
    assert.equal(run.status, 401);
    assert.equal(st.status, 401);
  });
});

test('flag on (parent id + token + a Mongo uri set): polling starts; endpoints still staff-only (401 without a session)', async () => {
  await withServer({
    NOTION_AUTOCREATE_PARENT_ID: PARENT, NOTION_TOKEN: 'test-token-not-real',
    MONGODB_URI: 'mongodb://127.0.0.1:1/never', NOTION_API: 'http://127.0.0.1:1/v1',
    STAFF_EMAILS: 'staff@example.invalid', NOTION_AUTOCREATE_INTERVAL_MIN: '60'
  }, async (port, srv) => {
    assert.match(srv.output(), /Notion autocreate: ON, every 60 min/);
    assert.ok(!srv.output().includes('test-token-not-real'), 'token never printed');
    const run = await httpJson(port, 'POST', '/api/notion/autocreate/run', { dryRun: true });
    const st = await httpJson(port, 'GET', '/api/notion/autocreate/status');
    assert.equal(run.status, 401);
    assert.equal(st.status, 401);
    for (const p of ['dismiss', 'undismiss', 'create-page']) {
      const r = await httpJson(port, 'POST', '/api/notion/autocreate/' + p, { pageId: hex(7) });
      assert.equal(r.status, 401, p + ' is staff-only');
    }
  });
});

test('flag set but token missing: stays off and says why', async () => {
  await withServer({ NOTION_AUTOCREATE_PARENT_ID: PARENT, MONGODB_URI: 'mongodb://127.0.0.1:1/never' }, async (port, srv) => {
    assert.match(srv.output(), /Notion autocreate stays off: NOTION_TOKEN is not set/);
    assert.ok(!/Notion autocreate: ON/.test(srv.output()));
  });
});
