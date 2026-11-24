/* Store name (founder decision 2026-11-24): a campaign-level storeName that
   defaults to the campaign's own name when empty, an optional per-participant
   override, used in (a) the Visiting Date text the date write-back puts in the
   Sheet and (b) the brand-sheet export.

   Rule: the stored name is used AS WRITTEN, "<Store name>: <Mon D> <HH.MM>";
   the word "store" is never added. "Seongsu store" -> "Seongsu store: Oct 17",
   "UH Cell Gangnam 12" -> "UH Cell Gangnam 12: Oct 17".

   No live call is made. The Sheet is an in-memory stand-in. Every name below
   is invented. */
import './helpers/browser-shim.mjs';
import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildBrandSheet, brandSheetVisitTextFor, brandSheetVisitText, brandSheetStoreName } from '../src/model/brandSheet.js';
import { esc } from '../src/ui/dom.js';
const require = createRequire(import.meta.url);
const W = require('../server/date-writeback.js');
const G = require('../server/workspace-guard.js');

const NOW = Date.parse('2026-11-23T00:00:00Z');
const CAMPAIGN_NAME = 'UH Cell Gangnam 12';

/* ---------- the in-memory Sheet ---------- */
const COLS = { C: 2, Q: 16 };
const HEADER = (() => { const r = Array(17).fill(''); r[COLS.C] = 'Instagram'; r[COLS.Q] = 'Visiting Date'; return r; })();
const row = (ig, q) => { const r = Array(17).fill(''); r[COLS.C] = ig; r[COLS.Q] = q || ''; return r; };
const colIdx = (L) => String(L).split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
function memSheets(tabs) {
  const s = { tabs, calls: 0, writes: [] };
  s.listTabs = async () => { s.calls++; return Object.keys(tabs); };
  s.readHeaderRow = async (tab, r) => { s.calls++; return tabs[tab][r - 1].map(String); };
  s.readColumns = async (tab, cols) => { s.calls++; const o = {}; cols.forEach((c) => { o[c] = tabs[tab].map((r) => String(r[colIdx(c)] || '')); }); return o; };
  s.readCells = async (tab, refs) => { s.calls++; return refs.map((x) => String(tabs[tab][x.row - 1][colIdx(x.col)] || '')); };
  s.writeVisitCell = async (tab, r, text, col) => { s.calls++; s.writes.push({ tab, row: r, text }); tabs[tab][r - 1][colIdx(col)] = text; return {}; };
  return s;
}
const sheetOf = () => memSheets({ [CAMPAIGN_NAME]: [HEADER.slice(), row('https://instagram.com/fake_a'), row('@fake_b')] });

function workspace(over) {
  const o = over || {};
  return {
    db: {
      campaigns: [Object.assign({ id: 'cp1', brand: 'UH Cell', name: CAMPAIGN_NAME }, o.cp || {})],
      creators: [{ id: 'c1', handle: '@fake_a', name: 'Fake A' }, { id: 'c2', handle: 'fake_b', name: 'Fake B' }],
      participants: [
        Object.assign({ id: 'p1', campaignId: 'cp1', creatorId: 'c1', stage: 'confirmed', confirmedVisitAt: '2026-12-05 14:30' }, o.p1 || {}),
        Object.assign({ id: 'p2', campaignId: 'cp1', creatorId: 'c2', stage: 'confirmed', confirmedVisitAt: '2026-12-06' }, o.p2 || {})
      ]
    }
  };
}

function make(sheets, ws0, venues) {
  const config = W.parseConfig({});
  config.sheet.enabled = true;
  let ws = ws0 || workspace();
  const store = { state: null };
  const clock = { t: NOW };
  const job = W.createDateWriteback({
    config, logger: { log() {}, error() {} },
    loadWorkspace: async () => structuredClone(ws),
    loadState: async () => (store.state ? structuredClone(store.state) : null),
    saveState: async (s) => { store.state = structuredClone(s); },
    saveLog: async () => {},
    notion: null, sheets,
    venueNames: venues || (async () => new Map()),
    now: () => new Date(clock.t), sleep: async () => {}, retryDelayMs: 1
  });
  return { job, store, clock, setWs: (w) => { ws = w; }, get ws() { return ws; } };
}
const venueFor = (name) => async (targets) => new Map(targets.map((t) => [t.id, name]));

/* ============================ the rule ============================ */

test('default: no store name stored -> the campaign name', () => {
  const cp = { id: 'cp1', name: CAMPAIGN_NAME };
  assert.deepEqual(W.chooseStore({}, cp, ''), { name: CAMPAIGN_NAME, source: 'campaign-default' });
  assert.equal(W.sheetTextFor('2026-10-17', W.chooseStore({}, cp, '').name), 'UH Cell Gangnam 12: Oct 17');
  assert.equal(brandSheetStoreName({}, cp), CAMPAIGN_NAME);
  assert.equal(brandSheetStoreName(null, cp), CAMPAIGN_NAME);
});

test('campaign store name beats the default; participant override beats both; booking venue sits between the campaign field and the default', () => {
  const cp = { name: CAMPAIGN_NAME, storeName: 'Seongsu store' };
  assert.deepEqual(W.chooseStore({}, cp, ''), { name: 'Seongsu store', source: 'campaign' });
  assert.deepEqual(W.chooseStore({ storeName: 'Hongdae' }, cp, ''), { name: 'Hongdae', source: 'participant' });
  assert.equal(brandSheetStoreName({ storeName: 'Hongdae' }, cp), 'Hongdae');
  assert.equal(brandSheetStoreName({}, cp), 'Seongsu store');
  /* venue: a booking's venue name, not a stored store name; it keeps its old text */
  assert.deepEqual(W.chooseStore({}, { name: CAMPAIGN_NAME }, 'Seongsu'), { name: 'Seongsu store', source: 'venue' });
  assert.deepEqual(W.chooseStore({}, cp, 'Seongsu'), { name: 'Seongsu store', source: 'campaign' }, 'a stored campaign name beats the venue');
});

test('empty: blank, whitespace and symbol-only names count as empty; with no campaign name either there is no store', () => {
  assert.deepEqual(W.chooseStore({ storeName: '   ' }, { name: CAMPAIGN_NAME, storeName: '' }, ''), { name: CAMPAIGN_NAME, source: 'campaign-default' });
  assert.deepEqual(W.chooseStore({ storeName: '=+' }, { name: '', storeName: '  ' }, ''), { name: '', source: 'none' });
  assert.deepEqual(W.chooseStore(null, null, null), { name: '', source: 'none' });
  assert.equal(W.sheetTextFor('2026-10-17 17:30', ''), 'Oct 17 17.30');
  assert.equal(brandSheetStoreName({ storeName: ' ' }, { name: '', storeName: '' }), '');
  assert.equal(brandSheetVisitTextFor('2026-10-17 17:30', ''), 'Oct 17 17.30');
});

test('format: a name that already ends with "store" is used as is; any other name is used as is; "store" is never doubled or added', () => {
  assert.equal(W.sheetTextFor('2026-10-17', 'Seongsu store'), 'Seongsu store: Oct 17');
  assert.equal(W.sheetTextFor('2026-10-27 17:30', 'Hongdae store'), 'Hongdae store: Oct 27 17.30');
  assert.equal(W.sheetTextFor('2026-10-17', 'Seongsu'), 'Seongsu: Oct 17');
  assert.equal(W.sheetTextFor('2026-11-05 09:05', 'UH Cell Gangnam 12'), 'UH Cell Gangnam 12: Nov 5 09.05');
  assert.ok(!/store store/i.test(W.sheetTextFor('2026-10-17', 'Seongsu store')));
  /* day not padded, dot in the time, no time part without a time */
  assert.equal(W.sheetTextFor('2026-12-31', 'X'), 'X: Dec 31');
  /* formula starts and control characters are removed; 60 characters at most */
  assert.equal(W.sheetTextFor('2026-10-17', '=HYPERLINK("x")'), 'HYPERLINK("x"): Oct 17');
  assert.equal(W.sheetTextFor('2026-10-17', '  +Seongsu\n'), 'Seongsu: Oct 17');
  assert.equal(W.storeNameClean('x'.repeat(100)).length, 60);
  /* the older venue form is unchanged */
  assert.equal(W.sheetText('2026-10-17', 'Seongsu'), 'Seongsu store: Oct 17');
  assert.equal(brandSheetVisitText('2026-10-17', 'Seongsu'), 'Seongsu store: Oct 17');
});

test('the Sheet job and the export lay the text out identically', () => {
  const names = ['Seongsu store', 'Seongsu', CAMPAIGN_NAME, '=Evil', '  spaced   out  ', '', 'x'.repeat(80)];
  const slots = ['2026-10-17', '2026-10-27 17:30', '2026-11-05T09:05', '2026-12-31 00:00'];
  for (const n of names) for (const sl of slots) assert.equal(brandSheetVisitTextFor(sl, n), W.sheetTextFor(sl, n), JSON.stringify([n, sl]));
});

/* ============================ the Sheet job ============================ */

test('job: with no store name stored, the Visiting Date starts with the campaign name', async () => {
  const s = sheetOf(); const t = make(s);
  const r = await t.job.run({ trigger: 'poll' });
  assert.equal(r.channels.sheet.counts.written, 2);
  assert.deepEqual(s.writes.map((w) => w.text), ['UH Cell Gangnam 12: Dec 5 14.30', 'UH Cell Gangnam 12: Dec 6']);
});

test('job: campaign store name and a per-participant override', async () => {
  const s = sheetOf();
  const t = make(s, workspace({ cp: { storeName: 'Gangnam store' }, p2: { storeName: 'Hongdae' } }));
  await t.job.run({ trigger: 'poll' });
  assert.deepEqual(s.writes.map((w) => w.text), ['Gangnam store: Dec 5 14.30', 'Hongdae: Dec 6']);
});

test('job: nothing at all (no campaign name either) -> date only, flagged', async () => {
  const s = memSheets({ T: [HEADER.slice(), row('@fake_a'), row('@fake_b')] });
  const ws = workspace(); ws.db.campaigns[0] = { id: 'cp1', brand: 'UH Cell', sheetTab: 'T' };
  const r = await make(s, ws).job.run({ trigger: 'poll' });
  assert.deepEqual(s.writes.map((w) => w.text), ['Dec 5 14.30', 'Dec 6']);
  assert.equal(r.channels.sheet.flags['no-store-name'], 2);
});

test('format change: cells this job wrote earlier are NOT rewritten and NOT reported as edited by hand', async () => {
  const s = sheetOf();
  /* before: the old rule, a booking venue gives "Seongsu store: ..." */
  const t = make(s, workspace(), venueFor('Seongsu'));
  await t.job.run({ trigger: 'poll' });
  assert.deepEqual(s.writes.map((w) => w.text), ['Seongsu store: Dec 5 14.30', 'Seongsu store: Dec 6']);
  /* after: the venue is gone and the store name is typed into the campaign: the wanted text changes */
  const ws2 = workspace({ cp: { storeName: 'Gangnam store' } });
  const t2 = make(s, ws2);
  t2.store.state = structuredClone(t.store.state);
  const r = await t2.job.run({ trigger: 'save' });
  assert.equal(s.writes.length, 2, 'no new write');
  assert.equal(r.channels.sheet.counts['kept-format'], 2);
  assert.equal(r.channels.sheet.counts['edited-by-hand'], undefined, 'no false alarm');
  assert.equal(r.channels.sheet.counts.written, undefined);
  assert.equal(s.tabs[CAMPAIGN_NAME][1][COLS.Q], 'Seongsu store: Dec 5 14.30', 'the cell is untouched');
  assert.equal((await t2.job.stateSummary()).sheet.pending, 0, 'nothing pending in the status either');
  /* and it stays quiet: the next run makes no Sheet call at all */
  const calls = s.calls;
  const again = await t2.job.run({ trigger: 'poll' });
  assert.equal(s.calls, calls);
  assert.equal(again.channels.sheet.counts.unchanged, 2);
  /* when the visit date itself moves, the cell takes the new text */
  const ws3 = workspace({ cp: { storeName: 'Gangnam store' }, p1: { confirmedVisitAt: '2026-12-09 18:00' } });
  t2.setWs(ws3);
  const moved = await t2.job.run({ trigger: 'save' });
  assert.equal(moved.channels.sheet.counts.written, 1);
  assert.equal(s.tabs[CAMPAIGN_NAME][1][COLS.Q], 'Gangnam store: Dec 9 18.00');
  assert.equal(s.tabs[CAMPAIGN_NAME][2][COLS.Q], 'Seongsu store: Dec 6', 'the other row is still untouched');
});

test('format change: first run after the default arrives leaves date-only cells alone (no mass overwrite of a live Sheet)', async () => {
  /* 40 cells the previous version wrote as date only, with its ledger */
  const n = 40;
  const rows = [HEADER.slice()]; const participants = []; const creators = []; const items = {};
  for (let i = 0; i < n; i++) {
    const day = 1 + (i % 28);
    const text = 'Dec ' + day;
    rows.push(row('@fake_' + i, text));
    creators.push({ id: 'c' + i, handle: '@fake_' + i, name: 'F' + i });
    participants.push({ id: 'p' + i, campaignId: 'cp1', creatorId: 'c' + i, stage: 'confirmed', confirmedVisitAt: '2026-12-' + String(day).padStart(2, '0') });
    items['p' + i] = { n: {}, s: { done: text, want: null, tries: 0, nextAt: 0, why: null, gaveUp: false } };
  }
  const s = memSheets({ [CAMPAIGN_NAME]: rows });
  const ws = { db: { campaigns: [{ id: 'cp1', brand: 'UH Cell', name: CAMPAIGN_NAME }], creators, participants } };
  const t = make(s, ws);
  t.store.state = { items };
  const r = await t.job.run({ trigger: 'poll' });
  assert.equal(s.writes.length, 0, 'zero writes');
  assert.equal(r.channels.sheet.counts['kept-format'], n);
  assert.equal(r.channels.sheet.counts['edited-by-hand'], undefined);
  assert.equal(r.channels.sheet.counts['cell-has-other-text'], undefined);
});

test('format change: a cell a person typed over is still protected, and a staff force by creator id still rewrites one cell', async () => {
  const s = sheetOf();
  const t = make(s, workspace(), venueFor('Seongsu'));
  await t.job.run({ trigger: 'poll' });
  s.tabs[CAMPAIGN_NAME][1][COLS.Q] = 'Dec 5 evening, ask Joon';   /* hand-typed after our write */
  const t2 = make(s, workspace({ cp: { storeName: 'Gangnam store' } }));
  t2.store.state = structuredClone(t.store.state);
  const r = await t2.job.run({ trigger: 'save' });
  assert.equal(r.channels.sheet.counts['edited-by-hand'], 1, 'the typed-over cell is reported');
  assert.equal(r.channels.sheet.counts['kept-format'], 1, 'the untouched cell is simply kept');
  assert.equal(s.tabs[CAMPAIGN_NAME][1][COLS.Q], 'Dec 5 evening, ask Joon');
  assert.equal(s.writes.length, 2);
  /* force one creator: that one is rewritten with the new text, the other stays */
  const f = await t2.job.run({ trigger: 'manual', force: ['c1', 'c2'] });
  assert.equal(f.channels.sheet.counts.written, 2);
  assert.equal(s.tabs[CAMPAIGN_NAME][1][COLS.Q], 'Gangnam store: Dec 5 14.30');
  assert.equal(s.tabs[CAMPAIGN_NAME][2][COLS.Q], 'Gangnam store: Dec 6');
});

test('format change with the ledger lost: an existing different cell is reported, never overwritten (unchanged rule)', async () => {
  const s = memSheets({ [CAMPAIGN_NAME]: [HEADER.slice(), row('@fake_a', 'Seongsu store: Dec 5 14.30'), row('@fake_b', 'Seongsu store: Dec 6')] });
  const r = await make(s).job.run({ trigger: 'poll' });
  assert.equal(s.writes.length, 0);
  assert.equal(r.channels.sheet.counts['edited-by-hand'], 2);
});

test('a ledger written by the previous version (no "kept" field) is read without error', async () => {
  const s = sheetOf();
  const t = make(s, workspace(), venueFor('Seongsu'));
  await t.job.run({ trigger: 'poll' });
  Object.values(t.store.state.items).forEach((it) => assert.ok(!('kept' in it.s), 'a plain write leaves the ledger shape as before'));
});

/* ============================ the export ============================ */

const creators = { a: { id: 'a', handle: 'fake_a', name: 'Fake A' }, b: { id: 'b', handle: 'fake_b', name: 'Fake B' } };
const parts = [
  { id: 'pa', campaignId: 'cp1', creatorId: 'a', stage: 'confirmed', confirmedVisitAt: '2026-10-17' },
  { id: 'pb', campaignId: 'cp1', creatorId: 'b', stage: 'confirmed', confirmedVisitAt: '2026-10-27 17:30' }
];
const visiting = (s, h) => s.rows.find((r) => r[s.headers.indexOf('Instagram')].includes('/' + h + '/'))[s.headers.indexOf('Visiting Date')];
const exportOf = (cp, ps) => buildBrandSheet({ cp, participants: ps || parts, creators, date: '2026-11-23' });

test('export: default from the campaign name, campaign override, participant override', () => {
  const d = exportOf({ id: 'cp1', name: CAMPAIGN_NAME });
  assert.equal(visiting(d, 'fake_a'), 'UH Cell Gangnam 12: Oct 17');
  assert.equal(visiting(d, 'fake_b'), 'UH Cell Gangnam 12: Oct 27 17.30');
  const c = exportOf({ id: 'cp1', name: CAMPAIGN_NAME, storeName: 'Seongsu store' });
  assert.equal(visiting(c, 'fake_a'), 'Seongsu store: Oct 17');
  const p = exportOf({ id: 'cp1', name: CAMPAIGN_NAME, storeName: 'Seongsu store' }, parts.map((x) => (x.id === 'pb' ? { ...x, storeName: 'Hongdae' } : x)));
  assert.equal(visiting(p, 'fake_a'), 'Seongsu store: Oct 17');
  assert.equal(visiting(p, 'fake_b'), 'Hongdae: Oct 27 17.30');
});

test('export notice: missingStore counts only when participant, campaign store name and campaign name are all empty', () => {
  assert.equal(exportOf({ id: 'cp1', name: CAMPAIGN_NAME }).counts.missingStore, 0, 'default covers it');
  assert.equal(exportOf({ id: 'cp1', name: '' }).counts.missingStore, 2, 'nothing anywhere');
  assert.equal(exportOf({ id: 'cp1', name: '', storeName: 'Seongsu store' }).counts.missingStore, 0, 'campaign store name covers it');
  const one = exportOf({ id: 'cp1', name: '' }, parts.map((x) => (x.id === 'pa' ? { ...x, storeName: 'Hongdae' } : x)));
  assert.equal(one.counts.missingStore, 1, 'participant name covers only that creator');
  assert.equal(visiting(one, 'fake_b'), 'Oct 27 17.30', 'date and time only');
  /* a row with no confirmed visit never counts */
  const noVisit = exportOf({ id: 'cp1', name: '' }, parts.map((x) => ({ ...x, confirmedVisitAt: '' })));
  assert.equal(noVisit.counts.missingStore, 0);
});

test('export: a formula-looking store name is neutralised in the cell and in the text', () => {
  const s = exportOf({ id: 'cp1', name: CAMPAIGN_NAME, storeName: '=HYPERLINK("http://x")' });
  assert.equal(visiting(s, 'fake_a'), 'HYPERLINK("http://x"): Oct 17');
});

/* ============================ old workspaces, schema, guard ============================ */

test('backward compatible: a workspace saved before the field existed behaves as "use the default"', () => {
  const old = JSON.parse(JSON.stringify(workspace()));
  old.db.campaigns.concat(old.db.participants).forEach((o) => assert.ok(!('storeName' in o)));
  const sheet = W.chooseStore(old.db.participants[0], old.db.campaigns[0], '');
  assert.equal(sheet.name, CAMPAIGN_NAME);
  const e = exportOf(old.db.campaigns[0]);
  assert.equal(e.counts.missingStore, 0);
  /* null / odd values from an older pull are the same as missing */
  assert.equal(W.chooseStore({ storeName: null }, { name: CAMPAIGN_NAME, storeName: 5 }, '').name, '5', 'a number is read as text, not crashed on');
  assert.equal(W.chooseStore({ storeName: undefined }, { name: CAMPAIGN_NAME, storeName: undefined }, '').name, CAMPAIGN_NAME);
});

test('workspace guard: documents with and without the field pass identically (the guard counts rows, it does not read fields)', () => {
  const withField = { campaigns: [{ id: 'cp1', storeName: 'X' }], creators: [{ id: 'c1' }], participants: [{ id: 'p1', storeName: 'Y' }] };
  const without = { campaigns: [{ id: 'cp1' }], creators: [{ id: 'c1' }], participants: [{ id: 'p1' }] };
  for (const incoming of [withField, without]) {
    for (const existing of [withField, without]) assert.equal(G.guardEmptyReplace({ incoming, existing }).ok, true);
  }
  assert.equal(G.guardEmptyReplace({ incoming: { campaigns: [], creators: [], participants: [] }, existing: withField }).ok, false, 'an empty replace is still refused');
});

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sheetsSrc = fs.readFileSync(new URL('../src/sync/sheets.js', import.meta.url), 'utf8');
const campaignsSrc = fs.readFileSync(new URL('../src/views/campaigns.js', import.meta.url), 'utf8');

test('Sheet mirror schema carries storeName for campaigns and participants in index.html and src/ alike (a pull would otherwise drop it)', () => {
  for (const src of [html, sheetsSrc]) {
    const schema = src.slice(src.indexOf('const SHEET_SCHEMA = {'), src.indexOf('const getPath'));
    const cps = schema.slice(schema.indexOf('campaigns: ['), schema.indexOf('creators: ['));
    const crs = schema.slice(schema.indexOf('creators: ['), schema.indexOf('participants: ['));
    const pts = schema.slice(schema.indexOf('participants: ['));
    assert.ok(cps.includes("['storeName','s']"), 'campaigns');
    assert.ok(pts.includes("['storeName','s']"), 'participants');
    assert.ok(!crs.includes('storeName'), 'creators do not');
  }
});

/* ============================ escaping ============================ */

const EVIL = '<img src=x onerror=alert(1)>"\'&';
const grab = (src, name) => {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' found');
  return src.slice(i, src.indexOf('\n}\n', i) + 3).replace(/^export /, '');
};
const mustEscape = (html0) => { assert.ok(!html0.includes('<img src=x'), 'raw tag leaked'); assert.ok(html0.includes('&lt;img src=x onerror=alert(1)&gt;'), 'escaped form present'); };

test('escaping: the campaign form shows the store name and the project-name placeholder escaped', () => {
  const body = grab(campaignsSrc, 'campaignFormHtml');
  const deps = { esc, DB: { campaigns: [] }, CATEGORIES: ['A'], COUNTRIES: ['KR'], CAMPAIGN_STATUS: { active: { label: 'Active' } }, GCAL_PREFS: { defaultTz: 'Asia/Seoul' } };
  const fn = new Function(...Object.keys(deps), body + '\nreturn campaignFormHtml;')(...Object.values(deps));
  const out = fn({ id: 'cp1', brand: 'B', name: EVIL, storeName: EVIL, status: 'active', kind: 'Seeding', category: 'A', market: 'KR' });
  mustEscape(out);
  assert.ok(out.includes('id="ecStoreName"'));
  assert.ok(!/value="[^"]*"[^>]*onerror/.test(out.slice(out.indexOf('id="ecStoreName"'), out.indexOf('id="ecVenue"'))), 'attribute not broken out of');
});

test('escaping: the export drawer shows the store name escaped', () => {
  const body = grab(campaignsSrc, 'openBrandSheetExport');
  let shown = '';
  const els = {};
  const $ = (s) => els[s] || (els[s] = { checked: false, style: {}, addEventListener() {} });
  const cp = { id: 'cp1', brand: 'B', name: CAMPAIGN_NAME, storeName: EVIL };
  const deps = {
    esc, $, buildBrandSheet, brandSheetStoreName,
    loadBrandSheetOptions: () => ({ showNames: false, showNationality: false, includeRejected: false }), saveBrandSheetOptions: () => true,
    partsOf: () => parts, byCreator: creators, openDrawer: (t, h) => { shown = t + h; }, downloadXlsx() {}, window: {}
  };
  new Function(...Object.keys(deps), body + '\nreturn openBrandSheetExport;')(...Object.values(deps))(cp);
  mustEscape(shown);
});

test('escaping: the participant drawer source escapes the stored name and the placeholder, and index.html matches src/', () => {
  for (const src of [html, campaignsSrc]) {
    assert.ok(src.includes('placeholder="${esc(brandSheetStoreName(null, cp))}" value="${esc(p.storeName || \'\')}"'));
    assert.ok(src.includes('placeholder="${esc(cp.name || \'\')}" value="${esc(cp.storeName || \'\')}"'));
  }
  /* the saves are trimmed text only; an empty box removes the override */
  assert.ok(campaignsSrc.includes("if (sn) p.storeName = sn; else delete p.storeName;"));
  assert.ok(campaignsSrc.includes("cp.storeName = $('#ecStoreName').value.trim();"));
});
