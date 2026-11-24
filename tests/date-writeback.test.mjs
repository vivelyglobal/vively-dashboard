/* Confirmed visit date -> Notion row and Sheet row (server/date-writeback.js,
   server/sheets-client.js).

   No live Notion or Google call is made. Unit tests use in-memory stand-ins
   (functions) and the HTTP test uses tools/fake-notion.cjs and
   tools/fake-google.cjs on free ports. The people in the fixtures are
   invented. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import http from 'node:http';
import { format } from 'node:util';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const W = require('../server/date-writeback.js');
const SC = require('../server/sheets-client.js');
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const SHEET_ID = 'SPREADSHEET_TEST_ID_1234567890abcdef';
const hex = (n) => n.toString(16).padStart(32, '0');
const dashed = (n) => { const h = hex(n); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const NOW = Date.parse('2026-11-23T00:00:00Z');
const PROP = 'Confirmed Visit';

/* ---------- fixtures: invented people ---------- */
const PII = ['Kim Minji', 'minji_k', 'Secret Street 12', '010-1234-5678', 'Lee Dohyun', 'dohyun.l'];
function workspace(extra) {
  const ws = {
    db: {
      campaigns: [{ id: 'cp1', brand: 'Aura', name: 'Aura Seoul' }],
      creators: [
        { id: 'c1', handle: '@minji_k', name: 'Kim Minji', address: 'Secret Street 12', contact: '010-1234-5678' },
        { id: 'c2', handle: 'dohyun.l', name: 'Lee Dohyun' }
      ],
      participants: [
        { id: 'p1', campaignId: 'cp1', creatorId: 'c1', stage: 'confirmed', confirmedVisitAt: '2026-12-05 14:30', notionPageId: dashed(1) },
        { id: 'p2', campaignId: 'cp1', creatorId: 'c2', stage: 'confirmed', confirmedVisitAt: '2026-12-06', notionPageId: dashed(2) }
      ]
    }
  };
  return Object.assign(ws, extra || {});
}

/* in-memory Notion: pages by id, each with properties as the real API returns them */
function memNotion(props) {
  const pages = new Map();
  const n = { calls: [], pages, failures: [], hook: null };
  const add = (id, properties) => pages.set(id, { archived: false, properties: JSON.parse(JSON.stringify(properties)) });
  n.add = add;
  [1, 2].forEach((i) => add(dashed(i), props || { [PROP]: { type: 'date', date: null }, 'Visit Date': { type: 'date', date: { start: '2026-12-01' } } }));
  n.fn = async (method, path, body) => {
    n.calls.push({ method, path, body });
    const f = n.failures.shift();
    if (f) throw Object.assign(new Error('forced ' + f), { status: f });
    const id = path.replace('/pages/', '');
    const pg = pages.get(id);
    if (!pg) throw Object.assign(new Error('not found'), { status: 404 });
    if (method === 'GET') return { object: 'page', id, archived: pg.archived, properties: pg.properties };
    const [name, shape] = Object.entries(body.properties)[0];
    pg.properties[name].date = Object.assign({ end: null }, shape.date);
    return { object: 'page', id };
  };
  return n;
}

/* in-memory Sheet with the template's columns: C Instagram, E name, L address, M phone, Q Visiting Date */
const COLS = { C: 2, E: 4, L: 11, M: 12, Q: 16 };
function sheetRow({ ig, name, q, addr, phone }) {
  const r = Array(17).fill('');
  r[COLS.C] = ig || ''; r[COLS.E] = name || ''; r[COLS.Q] = q || ''; r[COLS.L] = addr || 'Some Address 1'; r[COLS.M] = phone || '010-9999-0000';
  return r;
}
const HEADER = (() => { const r = Array(17).fill(''); r[COLS.C] = 'Instagram'; r[COLS.E] = 'Name'; r[COLS.L] = 'Address'; r[COLS.M] = 'Phone'; r[COLS.Q] = 'Visiting Date'; return r; })();
const colIdx = (L) => String(L).split('').reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0) - 1;
/* hooks: afterColumns(tab) runs once after the first column read (simulates someone
   sorting or inserting a row between our read and our write) */
function memSheets(tabs) {
  const s = { tabs, reads: [], headerReads: [], cellReads: [], writes: [], listCalls: 0, failures: [], afterColumns: null };
  const maybeFail = () => { const f = s.failures.shift(); if (f) throw Object.assign(new Error('forced ' + f), { status: f }); };
  s.total = () => s.listCalls + s.reads.length + s.headerReads.length + s.cellReads.length + s.writes.length;
  s.listTabs = async () => { s.listCalls++; maybeFail(); return Object.keys(tabs); };
  s.readHeaderRow = async (tab, row) => { s.headerReads.push({ tab, row }); maybeFail(); return (tabs[tab][row - 1] || []).map((c) => String(c || '')); };
  s.readColumns = async (tab, cols) => {
    s.reads.push({ tab, cols: [...cols] }); maybeFail();
    const out = {};
    cols.forEach((c) => { out[c] = tabs[tab].map((r) => String(r[colIdx(c)] || '')); });
    if (s.afterColumns) { const h = s.afterColumns; s.afterColumns = null; h(tab); }
    return out;
  };
  s.readCells = async (tab, refs) => {
    s.cellReads.push({ tab, refs: refs.map((x) => x.col + x.row) }); maybeFail();
    return refs.map((x) => String(((tabs[tab][x.row - 1]) || [])[colIdx(x.col)] || ''));
  };
  s.writeVisitCell = async (tab, row, text, col) => {
    maybeFail();
    if (!/^[A-Z]{1,3}$/.test(String(col))) throw new Error('fake sheet: a write needs a column letter');
    s.writes.push({ tab, row, text, col });
    const r = tabs[tab][row - 1]; while (r.length <= colIdx(col)) r.push('');
    r[colIdx(col)] = text;
    return {};
  };
  return s;
}
const aura = () => ({ 'Aura Seoul': [HEADER.slice(), sheetRow({ ig: 'https://instagram.com/minji_k', name: 'Kim Minji' }), sheetRow({ ig: '@dohyun.l', name: 'Lee Dohyun' })] });

/* the job, wired to stand-ins */
function make(o) {
  const opts = o || {};
  const env = Object.assign({}, opts.env || {});
  const config = W.parseConfig(env);
  config.notion.enabled = opts.notion !== undefined ? !!opts.notion : false;
  config.sheet.enabled = opts.sheet !== undefined ? !!opts.sheet : false;
  if (opts.notionDry) config.notion.dryRun = true;
  if (opts.sheetDry) config.sheet.dryRun = true;
  if (opts.maxPerRun !== undefined) config.maxPerRun = opts.maxPerRun;
  const clock = { t: NOW };
  const logs = [];
  const logger = { log: (...a) => logs.push(format(...a)), error: (...a) => logs.push(format(...a)) };
  let ws = opts.ws || workspace();
  const store = { state: null, saves: 0, logs: [] };
  const job = W.createDateWriteback({
    config, logger,
    loadWorkspace: async () => structuredClone(ws),
    loadState: async () => (store.state ? structuredClone(store.state) : null),
    saveState: async (s) => { store.saves++; store.state = structuredClone(s); },
    saveLog: async (e) => { store.logs.push(e); },
    notion: opts.notionFn || null,
    sheets: opts.sheetsClient || null,
    venueNames: opts.venues === undefined ? async () => new Map() : opts.venues,
    now: () => new Date(clock.t), sleep: async () => {}, retryDelayMs: 1,
    maxTries: opts.maxTries, debounceMs: opts.debounceMs
  });
  return { job, clock, logs, store, setWs: (w) => { ws = w; }, get ws() { return ws; }, config };
}
const venueFor = (name) => async (targets) => new Map(targets.map((t) => [t.id, name]));

/* ============================ formats ============================ */

test('sheet text: "<Store> store: <Mon D> <HH.MM>", day not padded, dot in the time', () => {
  assert.equal(W.sheetText('2026-10-17 17:30', 'Seongsu'), 'Seongsu store: Oct 17 17.30');
  assert.equal(W.sheetText('2026-10-27 17:30', 'Hongdae'), 'Hongdae store: Oct 27 17.30');
  assert.equal(W.sheetText('2026-11-05 09:05', 'Seongsu'), 'Seongsu store: Nov 5 09.05');
  assert.equal(W.sheetText('2026-12-31', 'Seongsu'), 'Seongsu store: Dec 31', 'no time, no time part');
  assert.equal(W.sheetText('2026-01-02T08:00', ''), 'Jan 2 08.00', 'no store: date and time only');
});

test('store label: a trailing "store" is not doubled; control characters and formula starts are removed', () => {
  assert.equal(W.sheetText('2026-10-17 17:30', 'Seongsu store'), 'Seongsu store: Oct 17 17.30');
  assert.equal(W.storeLabel('=HYPERLINK("x")'), 'HYPERLINK("x")');
  assert.equal(W.storeLabel('  +Seongsu\n'), 'Seongsu');
  assert.equal(W.storeLabel(null), '');
});

test('slot parsing: real calendar dates only', () => {
  assert.equal(W.parseSlot('2026-02-31'), null);
  assert.equal(W.parseSlot('2026-12-05 25:00'), null);
  assert.equal(W.parseSlot('Oct 17'), null);
  assert.equal(W.parseSlot('2026-12-05 9:05').canonical, '2026-12-05 09:05');
});

test('notion date value and equality (wall clock at the venue, offset forms, date only)', () => {
  const tz = 'Asia/Seoul';
  assert.deepEqual(W.notionDateValue('2026-12-05 14:30', tz), { start: '2026-12-05T14:30:00', time_zone: tz });
  assert.deepEqual(W.notionDateValue('2026-12-05', tz), { start: '2026-12-05' });
  assert.equal(W.notionDateEquals({ start: '2026-12-05T14:30:00.000+09:00', time_zone: tz }, '2026-12-05 14:30', tz), true);
  assert.equal(W.notionDateEquals({ start: '2026-12-05T05:30:00.000Z' }, '2026-12-05 14:30', tz), true, 'same instant in UTC');
  assert.equal(W.notionDateEquals({ start: '2026-12-05T14:30:00', time_zone: tz }, '2026-12-05 14:30', tz), true);
  assert.equal(W.notionDateEquals({ start: '2026-12-05T15:30:00.000+09:00' }, '2026-12-05 14:30', tz), false);
  assert.equal(W.notionDateEquals({ start: '2026-12-05' }, '2026-12-05 14:30', tz), false, 'date only is not a time');
  assert.equal(W.notionDateEquals({ start: '2026-12-05' }, '2026-12-05', tz), true);
  assert.equal(W.notionDateEquals({ start: '2026-12-05T14:30:00.000+09:00' }, '2026-12-05', tz), false);
  assert.equal(W.notionDateEquals(null, '2026-12-05', tz), false);
  assert.equal(W.notionDateEquals({ start: '2026-12-05', end: '2026-12-06' }, '2026-12-05', tz), false, 'a range is not our value');
});

test('config: flags are off unless exactly on; defaults; property name configurable; junk falls back', () => {
  const off = W.parseConfig({});
  assert.equal(off.notion.requested, false);
  assert.equal(off.sheet.requested, false);
  assert.equal(off.notion.property, 'Confirmed Visit');
  assert.deepEqual(off.sheet.cols, { instagram: null, name: null, visit: null }, 'no column letter is trusted by default: columns are found by header text');
  assert.deepEqual(off.sheet.headers.instagram, ['instagram']);
  assert.deepEqual(off.sheet.headers.visit, ['visiting date']);
  assert.equal(off.sheet.headerRow, 1);
  assert.equal(off.notion.propertyError, null);
  assert.equal(off.tz, 'Asia/Seoul');
  assert.equal(off.maxPerRun, 25);
  assert.equal(off.pastDays, 7);
  assert.equal(W.parseConfig({ NOTION_DATE_WRITEBACK: '0' }).notion.requested, false);
  assert.equal(W.parseConfig({ NOTION_DATE_WRITEBACK: '1' }).notion.requested, true);
  assert.equal(W.parseConfig({ SHEET_DATE_WRITEBACK: '1', SHEET_DATE_WRITEBACK_DRY_RUN: '1' }).sheet.dryRun, true);
  assert.equal(W.parseConfig({ NOTION_DATE_PROPERTY: 'Booked Visit' }).notion.property, 'Booked Visit');
  assert.equal(W.parseConfig({ DATE_WRITEBACK_TZ: 'Not/AZone' }).tz, 'Asia/Seoul');
  assert.equal(W.parseConfig({ DATE_WRITEBACK_MAX_PER_RUN: '' }).maxPerRun, 25, 'blank is unset, not zero');
  assert.equal(W.parseConfig({ DATE_WRITEBACK_MAX_PER_RUN: '0' }).maxPerRun, 0);
  assert.equal(W.parseConfig({ SHEET_COL_VISIT: 'r' }).sheet.cols.visit, 'R', 'a letter is only a claim; it is checked against the header');
  assert.equal(W.parseConfig({ SHEET_COL_VISIT: 'Q1' }).sheet.cols.visit, null, 'not a column letter: ignored');
  assert.deepEqual(W.parseConfig({ SHEET_HEADER_VISIT: ' Visit  Day , x' }).sheet.headers.visit, ['visiting date', 'visit day', 'x']);
  assert.deepEqual(W.parseConfig({ SHEET_WRITEBACK_TAB_MAP: '{"cp1":"Aura Seoul"}' }).sheet.tabMap, { cp1: 'Aura Seoul' });
  assert.deepEqual(W.parseConfig({ SHEET_WRITEBACK_TAB_MAP: '{bad' }).sheet.tabMap, {});
});

/* ============================ matching ============================ */

test('matchRow: exact (any handle spelling), none, multiple, name only as tie-break, header skipped', () => {
  const col = ['Instagram', 'https://www.instagram.com/Minji_K/', '@dohyun.l', '', '@someone_else'];
  assert.deepEqual(W.matchRow(col, '@minji_k', 1, () => '', ''), { kind: 'match', index: 1 });
  assert.deepEqual(W.matchRow(col, 'DOHYUN.L', 1, () => '', ''), { kind: 'match', index: 2 });
  assert.equal(W.matchRow(col, 'nobody', 1, () => '', '').kind, 'none');
  assert.equal(W.matchRow(col, '', 1, () => '', '').why, 'no-handle');
  assert.equal(W.matchRow(['instagram', 'x'], 'instagram', 1, () => '', '').kind, 'none', 'the header row is never a match');
  const dup = ['h', '@same', '@same', '@same'];
  const names = ['', 'Park Ara', 'Choi Binna', 'Choi Binna'];
  assert.equal(W.matchRow(dup, 'same', 1, (i) => names[i], 'Park Ara').index, 1, 'name breaks the tie');
  assert.equal(W.matchRow(dup, 'same', 1, (i) => names[i], 'Choi Binna').kind, 'multiple', 'two rows still tie');
  assert.equal(W.matchRow(dup, 'same', 1, (i) => names[i], 'Nobody').kind, 'multiple');
  assert.equal(W.matchRow(dup, 'same', 1, (i) => names[i], '').kind, 'multiple', 'no name, no tie-break');
});

test('tab: mapped, exact normalised title, never by brand alone; none or two is reported', () => {
  const cp = { id: 'cp1', brand: 'Aura', name: 'Aura Seoul' };
  assert.equal(W.resolveTab(cp, ['Aura Seoul', 'Other'], {}).tab, 'Aura Seoul');
  assert.equal(W.resolveTab(cp, ['aura  seoul!', 'Other'], {}).tab, 'aura  seoul!');
  assert.equal(W.resolveTab(cp, ['Aura', 'Other'], {}).why, 'no-tab', 'brand alone is not enough');
  assert.equal(W.resolveTab(cp, ['Aura Seoul', 'AURA SEOUL'], {}).why, 'tab-ambiguous');
  assert.equal(W.resolveTab(cp, ['Mine', 'Aura Seoul'], { cp1: 'Mine' }).tab, 'Mine');
  assert.equal(W.resolveTab(cp, ['Mine'], { cp1: 'Gone' }).why, 'no-tab', 'a mapping to a missing tab does not guess');
  assert.equal(W.resolveTab(Object.assign({ sheetTab: 'X' }, cp), ['X', 'Aura Seoul'], {}).tab, 'X');
});

/* ============================ flags and dry run ============================ */

test('flags off: run does nothing and calls nothing, even when clients are supplied', async () => {
  const n = memNotion(); const s = memSheets(aura());
  const t = make({ notion: false, sheet: false, notionFn: n.fn, sheetsClient: s });
  const r = await t.job.run({ trigger: 'manual' });
  assert.deepEqual(r, { off: true });
  t.job.notifySaved();
  assert.equal(n.calls.length, 0);
  assert.equal(s.total(), 0);
  assert.equal(t.store.saves, 0);
  assert.deepEqual(t.job.channels(), { notion: false, sheet: false });
});

test('one flag on touches only its own channel', async () => {
  const n = memNotion(); const s = memSheets(aura());
  const a = make({ notion: true, sheet: false, notionFn: n.fn, sheetsClient: s });
  await a.job.run({ trigger: 'manual' });
  assert.ok(n.calls.length > 0);
  assert.equal(s.total(), 0);
  const n2 = memNotion(); const s2 = memSheets(aura());
  const b = make({ notion: false, sheet: true, notionFn: n2.fn, sheetsClient: s2 });
  await b.job.run({ trigger: 'manual' });
  assert.equal(n2.calls.length, 0);
  assert.ok(s2.writes.length > 0);
});

test('dry run: reads, reports would-write, writes nothing and saves no state or log (both channels)', async () => {
  const n = memNotion(); const s = memSheets(aura());
  const t = make({ notion: true, sheet: true, notionFn: n.fn, sheetsClient: s, venues: venueFor('Seongsu') });
  const r = await t.job.run({ trigger: 'manual', dryRun: true });
  assert.equal(r.channels.notion.counts['would-write'], 2);
  assert.equal(r.channels.sheet.counts['would-write'], 2);
  assert.equal(n.calls.filter((c) => c.method !== 'GET').length, 0, 'no Notion write');
  assert.equal(s.writes.length, 0, 'no Sheet write');
  assert.equal(t.store.saves, 0, 'no state saved');
  assert.equal(t.store.logs.length, 0, 'no log saved');
  /* and a following live run still does the work (the dry run left no trace) */
  const live = await t.job.run({ trigger: 'manual' });
  assert.equal(live.channels.notion.counts.written, 2);
  assert.equal(live.channels.sheet.counts.written, 2);
});

test('env dry-run flags make each channel report only', async () => {
  const n = memNotion(); const s = memSheets(aura());
  const t = make({ notion: true, sheet: true, notionDry: true, sheetDry: true, notionFn: n.fn, sheetsClient: s });
  const r = await t.job.run({ trigger: 'poll' });
  assert.equal(r.channels.notion.counts['would-write'], 2);
  assert.equal(r.channels.sheet.counts['would-write'], 2);
  assert.equal(n.calls.filter((c) => c.method === 'PATCH').length, 0);
  assert.equal(s.writes.length, 0);
});

/* ============================ Notion ============================ */

test('notion: writes only the Confirmed Visit date property, nothing else; the creator-filled Visit Date is untouched', async () => {
  const n = memNotion(); const t = make({ notion: true, notionFn: n.fn });
  const r = await t.job.run({ trigger: 'manual' });
  assert.equal(r.channels.notion.counts.written, 2);
  const patches = n.calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches.length, 2);
  assert.deepEqual(patches[0].body, { properties: { [PROP]: { date: { start: '2026-12-05T14:30:00', time_zone: 'Asia/Seoul' } } } });
  assert.deepEqual(patches[1].body, { properties: { [PROP]: { date: { start: '2026-12-06' } } } }, 'date only when no time');
  patches.forEach((p) => assert.deepEqual(Object.keys(p.body), ['properties']));
  patches.forEach((p) => assert.deepEqual(Object.keys(p.body.properties), [PROP]));
  assert.equal(n.pages.get(dashed(1)).properties['Visit Date'].date.start, '2026-12-01', 'requested date unchanged');
});

test('notion: the property name is configurable', async () => {
  const n = memNotion({ 'Booked Visit': { type: 'date', date: null } });
  const t = make({ notion: true, notionFn: n.fn, env: { NOTION_DATE_PROPERTY: 'Booked Visit' } });
  const r = await t.job.run({ trigger: 'manual' });
  assert.equal(r.channels.notion.counts.written, 2);
  assert.deepEqual(Object.keys(n.calls.find((c) => c.method === 'PATCH').body.properties), ['Booked Visit']);
});

test('notion: idempotent. A second run makes no call at all; a changed date writes once more', async () => {
  const n = memNotion(); const t = make({ notion: true, notionFn: n.fn });
  await t.job.run({ trigger: 'poll' });
  const before = n.calls.length;
  const again = await t.job.run({ trigger: 'poll' });
  assert.equal(n.calls.length, before, 'no call on an unchanged workspace');
  assert.equal(again.channels.notion.counts.unchanged, 2);
  const ws = workspace(); ws.db.participants[0].confirmedVisitAt = '2026-12-07 10:00';
  t.setWs(ws);
  const moved = await t.job.run({ trigger: 'save' });
  assert.equal(moved.channels.notion.counts.written, 1);
  assert.equal(moved.channels.notion.counts.unchanged, 1);
  assert.equal(n.pages.get(dashed(1)).properties[PROP].date.start, '2026-12-07T10:00:00');
});

test('notion: equality skip. Notion already holds the value but the ledger is empty: read, no write, remembered', async () => {
  const n = memNotion();
  n.pages.get(dashed(1)).properties[PROP].date = { start: '2026-12-05T14:30:00.000+09:00', end: null, time_zone: 'Asia/Seoul' };
  n.pages.get(dashed(2)).properties[PROP].date = { start: '2026-12-06', end: null, time_zone: null };
  const t = make({ notion: true, notionFn: n.fn });
  const r = await t.job.run({ trigger: 'manual' });
  assert.equal(r.channels.notion.counts['unchanged-remote'], 2);
  assert.equal(n.calls.filter((c) => c.method === 'PATCH').length, 0);
  const calls = n.calls.length;
  await t.job.run({ trigger: 'manual' });
  assert.equal(n.calls.length, calls, 'remembered: no further reads');
});

test('notion: a missing property is never created; reported once per campaign, nothing written', async () => {
  const n = memNotion({ 'Visit Date': { type: 'date', date: null } });
  const t = make({ notion: true, notionFn: n.fn });
  const r = await t.job.run({ trigger: 'poll' });
  assert.equal(r.channels.notion.counts.waiting, 2);
  assert.ok(r.items.every((i) => i.why === 'property-missing'));
  assert.equal(n.calls.filter((c) => c.method !== 'GET').length, 0, 'no PATCH, so nothing created');
  assert.equal(n.calls.filter((c) => c.method === 'GET').length, 1, 'learned once for the campaign, second row not read');
  const before = n.calls.length;
  await t.job.run({ trigger: 'poll' });
  assert.equal(n.calls.length, before, 'not asked again every poll');
});

test('notion: a property that is not a date is refused, not overwritten', async () => {
  const n = memNotion({ [PROP]: { type: 'rich_text', rich_text: [] } });
  const t = make({ notion: true, notionFn: n.fn });
  const r = await t.job.run({ trigger: 'poll' });
  assert.equal(r.items[0].why, 'property-not-date');
  assert.equal(n.calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('notion: rows with no Notion page, dropped creators, cleared dates, bad dates and old dates are not written', async () => {
  const ws = workspace();
  ws.db.participants = [
    { id: 'a', campaignId: 'cp1', creatorId: 'c1', stage: 'confirmed', confirmedVisitAt: '2026-12-05 14:30' },            // no page id
    { id: 'b', campaignId: 'cp1', creatorId: 'c1', stage: 'dropped', confirmedVisitAt: '2026-12-05', notionPageId: dashed(1) },
    { id: 'c', campaignId: 'cp1', creatorId: 'c1', stage: 'confirmed', confirmedVisitAt: '', notionPageId: dashed(1) },
    { id: 'd', campaignId: 'cp1', creatorId: 'c1', stage: 'confirmed', confirmedVisitAt: 'soon', notionPageId: dashed(1) },
    { id: 'e', campaignId: 'cp1', creatorId: 'c1', stage: 'confirmed', confirmedVisitAt: '2026-10-01', notionPageId: dashed(1) }, // 7+ days ago
    { id: 'f', campaignId: 'gone', creatorId: 'c1', stage: 'confirmed', confirmedVisitAt: '2026-12-05', notionPageId: dashed(1) }
  ];
  const n = memNotion(); const t = make({ ws, notion: true, notionFn: n.fn });
  const r = await t.job.run({ trigger: 'manual' });
  assert.equal(n.calls.length, 0);
  assert.equal(r.channels.notion.counts['no-page-id'], 1);
  assert.deepEqual(r.skipped, { badDate: 1, dropped: 1, tooOld: 1, noCampaign: 1 });
});

test('notion: retries a transient failure with backoff inside one run', async () => {
  const n = memNotion(); const t = make({ notion: true, notionFn: n.fn });
  n.failures = [undefined, 503, 429];   // GET ok, PATCH fails twice, then works
  const r = await t.job.run({ trigger: 'manual' });
  assert.equal(r.channels.notion.counts.written, 2);
  assert.equal(n.calls.filter((c) => c.method === 'PATCH').length, 4, 'row 1 took three tries, row 2 one');
});

test('notion: a persistent failure is queued, backs off, retries, and finally succeeds; the run itself never throws', async () => {
  const n = memNotion(); const t = make({ notion: true, notionFn: n.fn });
  const fail = () => { n.failures = Array(40).fill(503); };
  fail();
  const r1 = await t.job.run({ trigger: 'poll' });
  assert.equal(r1.channels.notion.counts.failed, 2);
  assert.equal((await t.job.stateSummary()).notion.pending, 2, 'queued');
  const calls = n.calls.length;
  const r2 = await t.job.run({ trigger: 'poll' });
  assert.equal(n.calls.length, calls, 'still inside the backoff window: no call');
  assert.equal(r2.channels.notion.counts.waiting, 2);
  t.clock.t += 3 * 60000;
  await t.job.run({ trigger: 'poll' });
  assert.ok(n.calls.length > calls, 'retried after the window');
  n.failures = [];
  t.clock.t += 60 * 60000;
  const ok = await t.job.run({ trigger: 'poll' });
  assert.equal(ok.channels.notion.counts.written, 2);
  assert.equal((await t.job.stateSummary()).notion.pending, 0, 'queue drained');
});

test('notion: gives up after the cap; only a manual run tries again', async () => {
  const n = memNotion(); const t = make({ notion: true, notionFn: n.fn, maxTries: 2 });
  n.failures = Array(100).fill(500);
  await t.job.run({ trigger: 'poll' });
  t.clock.t += 3 * 60000;
  const r = await t.job.run({ trigger: 'poll' });
  assert.equal(r.channels.notion.counts['gave-up'], 2);
  const calls = n.calls.length;
  t.clock.t += 24 * 3600000;
  await t.job.run({ trigger: 'poll' });
  assert.equal(n.calls.length, calls, 'gave up: no automatic retry');
  assert.equal((await t.job.stateSummary()).notion.gaveUp, 2);
  n.failures = [];
  const manual = await t.job.run({ trigger: 'manual' });
  assert.equal(manual.channels.notion.counts.written, 2);
});

test('notion: a permanent error (404) is not retried and waits for a person', async () => {
  const n = memNotion(); n.pages.delete(dashed(1)); n.pages.delete(dashed(2));
  const t = make({ notion: true, notionFn: n.fn });
  const r = await t.job.run({ trigger: 'poll' });
  assert.equal(n.calls.length, 2, 'one call each, no retry loop');
  assert.equal(r.channels.notion.counts.waiting, 2);
  assert.equal(r.items[0].why, 'http-404');
});

test('notion: after 3 failed rows in a run the channel stops for that run', async () => {
  const ws = workspace(); ws.db.participants = [];
  for (let i = 1; i <= 6; i++) ws.db.participants.push({ id: 'q' + i, campaignId: 'cp1', creatorId: 'c1', stage: 'confirmed', confirmedVisitAt: '2026-12-05', notionPageId: dashed(i) });
  const n = memNotion(); n.failures = Array(100).fill(503);
  const t = make({ ws, notion: true, notionFn: n.fn });
  const r = await t.job.run({ trigger: 'poll' });
  assert.equal(r.channels.notion.counts.failed, 3);
  assert.equal(r.channels.notion.counts['channel-stopped'], 3);
  assert.equal(n.calls.length, 9, '3 rows x 3 attempts');
});

test('per-run write cap defers the rest', async () => {
  const n = memNotion(); const t = make({ notion: true, notionFn: n.fn, maxPerRun: 1 });
  const r = await t.job.run({ trigger: 'poll' });
  assert.equal(r.channels.notion.counts.written, 1);
  assert.equal(r.channels.notion.counts.deferred, 1);
  const r2 = await t.job.run({ trigger: 'poll' });
  assert.equal(r2.channels.notion.counts.written, 1, 'the deferred one goes next run');
});

/* ============================ Sheet ============================ */

test('sheet: matches by Instagram handle and writes ONLY the Visiting Date cell, in the template text', async () => {
  const s = memSheets(aura());
  const t = make({ sheet: true, sheetsClient: s, venues: venueFor('Seongsu') });
  const r = await t.job.run({ trigger: 'manual' });
  assert.equal(r.channels.sheet.counts.written, 2);
  assert.deepEqual(s.writes.map((w) => [w.tab, w.row, w.text, w.col]), [
    ['Aura Seoul', 2, 'Seongsu store: Dec 5 14.30', 'Q'],
    ['Aura Seoul', 3, 'Seongsu store: Dec 6', 'Q']
  ]);
  /* nothing else in any row changed */
  const rows = s.tabs['Aura Seoul'];
  assert.equal(rows[1][COLS.L], 'Some Address 1');
  assert.equal(rows[1][COLS.M], '010-9999-0000');
  assert.equal(rows[1][COLS.C], 'https://instagram.com/minji_k');
  assert.equal(rows[1][COLS.E], 'Kim Minji');
});

test('sheet: reads only the handle and Visiting Date columns (never address or phone), and the name column only for a tie-break', async () => {
  const s = memSheets(aura());
  await make({ sheet: true, sheetsClient: s, venues: venueFor('Seongsu') }).job.run({ trigger: 'manual' });
  s.reads.forEach((r) => assert.deepEqual(r.cols, ['C', 'Q']));
  const dup = aura(); dup['Aura Seoul'].push(sheetRow({ ig: '@minji_k', name: 'Someone Else' }));
  const s2 = memSheets(dup);
  const r = await make({ sheet: true, sheetsClient: s2, venues: venueFor('Seongsu') }).job.run({ trigger: 'manual' });
  const flat = s2.reads.flatMap((x) => x.cols);
  assert.ok(flat.includes('E'), 'name read for the tie');
  assert.ok(!flat.includes('L') && !flat.includes('M'), 'address and phone never read');
  assert.equal(r.channels.sheet.counts.written, 2, 'the tie is broken by name: row 2 for Kim Minji');
  assert.equal(s2.writes.find((w) => w.text.includes('Dec 5')).row, 2);
});

test('sheet: no match, and several matches, are reported and nothing is written', async () => {
  const tabs = { 'Aura Seoul': [HEADER, sheetRow({ ig: '@somebody_else' }), sheetRow({ ig: '@dohyun.l', name: 'X' }), sheetRow({ ig: 'https://instagram.com/dohyun.l', name: 'X' })] };
  const s = memSheets(tabs);
  const t = make({ sheet: true, sheetsClient: s, venues: venueFor('Seongsu') });
  const r = await t.job.run({ trigger: 'manual' });
  assert.equal(s.writes.length, 0);
  assert.deepEqual(r.items.map((i) => i.why).sort(), ['multiple-matches', 'no-match']);
});

test('sheet: a cell with text this system did not write is reported and left alone; an equal cell is left alone', async () => {
  const tabs = aura();
  tabs['Aura Seoul'][1][COLS.Q] = 'Seongsu store: Dec 4 11.00';          // a human typed another date
  tabs['Aura Seoul'][2][COLS.Q] = 'Seongsu store: Dec 6';                // already says the same
  const s = memSheets(tabs);
  const t = make({ sheet: true, sheetsClient: s, venues: venueFor('Seongsu') });
  const r = await t.job.run({ trigger: 'manual' });
  assert.equal(s.writes.length, 0);
  assert.equal(r.channels.sheet.counts['unchanged-remote'], 1);
  assert.equal(r.channels.sheet.counts['edited-by-hand'], 1);
  assert.equal(r.items.find((i) => i.why).why, 'cell-has-other-text');
  assert.equal(tabs['Aura Seoul'][1][COLS.Q], 'Seongsu store: Dec 4 11.00');
});

test('sheet: the old SHEET_DATE_OVERWRITE switch no longer exists; a hand-edit stays unless staff force that creator once', async () => {
  const tabs = aura();
  const s = memSheets(tabs);
  const t = make({ sheet: true, sheetsClient: s, venues: venueFor('Seongsu'), env: { SHEET_DATE_OVERWRITE: '1' } });
  await t.job.run({ trigger: 'manual' });                       // writes both rows
  assert.equal(s.writes.length, 2);
  tabs['Aura Seoul'][1][COLS.Q] = 'my own note';                // a person edits row 2
  const ws = workspace(); ws.db.participants[0].confirmedVisitAt = '2026-12-09 18:00';
  t.setWs(ws);
  const r1 = await t.job.run({ trigger: 'save' });
  assert.equal(s.writes.length, 2, 'not overwritten, with the old env switch set');
  assert.equal(r1.channels.sheet.counts['edited-by-hand'], 1);
  assert.equal(r1.items.find((i) => i.outcome === 'edited-by-hand').why, 'edited-by-hand');
  assert.equal((await t.job.stateSummary()).sheet.why['edited-by-hand'], 1, 'shows in the status');
  t.clock.t += 61 * 60000;
  await t.job.run({ trigger: 'poll' });
  assert.equal(s.writes.length, 2, 'asking again later still does not overwrite');
  /* force: only on a manual live run, only for that creator id */
  await t.job.run({ trigger: 'manual', force: ['c2'] });
  assert.equal(s.writes.length, 2, 'forcing another creator changes nothing');
  await t.job.run({ trigger: 'manual', force: ['c1'], dryRun: true });
  assert.equal(s.writes.length, 2, 'a dry run never writes, forced or not');
  await t.job.run({ trigger: 'poll', force: ['c1'] });
  assert.equal(s.writes.length, 2, 'only a manual run honours force');
  const f = await t.job.run({ trigger: 'manual', force: ['c1'] });
  assert.equal(f.channels.sheet.counts.written, 1);
  assert.equal(tabs['Aura Seoul'][1][COLS.Q], 'Seongsu store: Dec 9 18.00');
  const again = await t.job.run({ trigger: 'manual', force: ['c1'] });
  assert.equal(s.writes.length, 3, 'a forced overwrite is one overwrite: nothing more to write');
  assert.equal(again.channels.sheet.counts.unchanged, 2);
});

test('sheet: no venue and no store name -> the campaign name is the default store name', async () => {
  const s = memSheets(aura());
  const t = make({ sheet: true, sheetsClient: s });
  const r = await t.job.run({ trigger: 'manual' });
  assert.equal(s.writes[0].text, 'Aura Seoul: Dec 5 14.30');
  assert.equal(r.channels.sheet.flags['no-store-name'], undefined);
});

test('sheet: no store name anywhere (no venue, no store name, no campaign name) -> date and time only, flagged', async () => {
  const s = memSheets(aura());
  const ws = workspace(); ws.db.campaigns[0] = { id: 'cp1', brand: 'Aura', sheetTab: 'Aura Seoul' };
  const t = make({ sheet: true, sheetsClient: s, ws });
  const r = await t.job.run({ trigger: 'manual' });
  assert.equal(s.writes[0].text, 'Dec 5 14.30');
  assert.equal(r.channels.sheet.flags['no-store-name'], 2);
});

test('sheet: idempotent. A second run makes no call; a moved date rewrites the cell this job wrote', async () => {
  const s = memSheets(aura());
  const t = make({ sheet: true, sheetsClient: s, venues: venueFor('Seongsu') });
  await t.job.run({ trigger: 'poll' });
  const calls = s.total();
  const again = await t.job.run({ trigger: 'poll' });
  assert.equal(s.total(), calls, 'no Sheet call when nothing changed');
  assert.equal(again.channels.sheet.counts.unchanged, 2);
  const ws = workspace(); ws.db.participants[0].confirmedVisitAt = '2026-12-09 18:00';
  t.setWs(ws);
  const moved = await t.job.run({ trigger: 'save' });
  assert.equal(moved.channels.sheet.counts.written, 1);
  assert.equal(s.tabs['Aura Seoul'][1][COLS.Q], 'Seongsu store: Dec 9 18.00', 'allowed: the cell held what this job wrote');
});

test('sheet: missing tab and ambiguous tab: nothing written', async () => {
  const s2 = memSheets({ 'Some Other Tab': aura()['Aura Seoul'] });
  const r2 = await make({ sheet: true, sheetsClient: s2 }).job.run({ trigger: 'manual' });
  assert.equal(s2.writes.length, 0);
  assert.equal(r2.items[0].why, 'no-tab');
  const s3 = memSheets({ 'Aura Seoul': aura()['Aura Seoul'], 'aura seoul ': aura()['Aura Seoul'] });
  const r3 = await make({ sheet: true, sheetsClient: s3 }).job.run({ trigger: 'manual' });
  assert.equal(s3.writes.length, 0);
  assert.equal(r3.items[0].why, 'tab-ambiguous');
});

test('headers: BOTH columns are found by header text; either one missing, duplicated or mismatched means no write', async () => {
  const cases = [
    ['Q header is not Visiting Date', (h) => { h[COLS.Q] = 'Notes'; }, 'visit-header-missing'],
    ['C header is not Instagram', (h) => { h[COLS.C] = 'Link'; }, 'instagram-header-missing'],
    ['two Instagram headers', (h) => { h[COLS.E] = 'instagram'; }, 'instagram-header-ambiguous'],
    ['two Visiting Date headers', (h) => { h[COLS.M] = 'Visiting Date'; }, 'visit-header-ambiguous'],
    ['header row empty', (h) => { h.fill(''); }, 'instagram-header-missing']
  ];
  for (const [label, mutate, why] of cases) {
    const tabs = aura(); mutate(tabs['Aura Seoul'][0]);
    const s = memSheets(tabs);
    const r = await make({ sheet: true, sheetsClient: s, venues: venueFor('Seongsu') }).job.run({ trigger: 'manual' });
    assert.equal(s.writes.length, 0, label + ': nothing written');
    assert.equal(s.cellReads.length, 0, label + ': never got as far as a row');
    assert.ok(r.items.length > 0 && r.items.every((i) => i.why === why), label + ': ' + JSON.stringify(r.items));
  }
});

test('headers: accepts exact, case, spacing and configured aliases; finds the column wherever it is; a letter from env must match its header', async () => {
  /* a different layout: Name | Notes | Instagram | Visiting Date */
  const layout = () => ({ 'Aura Seoul': [
    ['Name', 'Notes', ' INSTAGRAM ', 'visiting   DATE'],
    ['Kim Minji', 'x', 'https://instagram.com/minji_k', ''],
    ['Lee Dohyun', 'y', '@dohyun.l', '']
  ] });
  const tabs = layout(); const s = memSheets(tabs);
  const r = await make({ sheet: true, sheetsClient: s, venues: venueFor('Seongsu') }).job.run({ trigger: 'manual' });
  assert.equal(r.channels.sheet.counts.written, 2);
  assert.deepEqual(s.writes.map((w) => [w.row, w.col]), [[2, 'D'], [3, 'D']], 'the column letter came from the header, not a default');
  assert.equal(tabs['Aura Seoul'][1][3], 'Seongsu store: Dec 5 14.30');
  assert.equal(tabs['Aura Seoul'][1][1], 'x', 'nothing else touched');

  /* env letters: the right letter works, a wrong letter refuses */
  const s2 = memSheets(layout());
  const ok = await make({ sheet: true, sheetsClient: s2, venues: venueFor('S'), env: { SHEET_COL_INSTAGRAM: 'C', SHEET_COL_VISIT: 'D' } }).job.run({ trigger: 'manual' });
  assert.equal(ok.channels.sheet.counts.written, 2);
  const s3 = memSheets(layout());
  const bad = await make({ sheet: true, sheetsClient: s3, venues: venueFor('S'), env: { SHEET_COL_VISIT: 'Q' } }).job.run({ trigger: 'manual' });
  assert.equal(s3.writes.length, 0);
  assert.ok(bad.items.every((i) => i.why === 'visit-header-mismatch'));
  const s4 = memSheets(layout());
  const bad2 = await make({ sheet: true, sheetsClient: s4, venues: venueFor('S'), env: { SHEET_COL_INSTAGRAM: 'B' } }).job.run({ trigger: 'manual' });
  assert.equal(s4.writes.length, 0);
  assert.ok(bad2.items.every((i) => i.why === 'instagram-header-mismatch'));

  /* an alias from env */
  const tabs5 = layout(); tabs5['Aura Seoul'][0][3] = 'Visit slot';
  const s5 = memSheets(tabs5);
  const none = await make({ sheet: true, sheetsClient: s5 }).job.run({ trigger: 'manual' });
  assert.equal(s5.writes.length, 0);
  assert.ok(none.items.every((i) => i.why === 'visit-header-missing'));
  const s6 = memSheets(tabs5);
  const withAlias = await make({ sheet: true, sheetsClient: s6, env: { SHEET_HEADER_VISIT: 'visit slot' } }).job.run({ trigger: 'manual' });
  assert.equal(withAlias.channels.sheet.counts.written, 2);
});

test('headers: only the header row is read to locate columns (no data row, no address or phone)', async () => {
  const s = memSheets(aura());
  await make({ sheet: true, sheetsClient: s, venues: venueFor('Seongsu') }).job.run({ trigger: 'manual' });
  assert.deepEqual(s.headerReads, [{ tab: 'Aura Seoul', row: 1 }]);
});

test('notion: a property the form fills in (or the system owns) is refused as the target, whatever the case or spacing', async () => {
  ['Visit Date', ' visit date ', 'VISIT   DATE', 'Submission time', 'Full Name', 'Instagram Link', 'status'].forEach((p) => {
    const cfg = W.parseConfig({ NOTION_DATE_WRITEBACK: '1', NOTION_DATE_PROPERTY: p });
    assert.ok(cfg.notion.propertyError, 'refused: ' + p);
  });
  assert.ok(W.parseConfig({ NOTION_DATE_PROPERTY: 'Booked Slot', NOTION_DATE_PROPERTY_DENY: 'booked  SLOT' }).notion.propertyError, 'extra deny list');
  assert.equal(W.parseConfig({ NOTION_DATE_PROPERTY: 'Booked Slot' }).notion.propertyError, null);
  assert.equal(W.parseConfig({}).notion.propertyError, null, 'the default Confirmed Visit is fine');
  /* even if a caller flips enabled on, the job itself will not run against a denied property */
  for (const p of ['Visit Date', 'Status']) {
    const n = memNotion({ [p]: { type: 'date', date: { start: '2026-12-01' } } });
    const t = make({ notion: true, notionFn: n.fn, env: { NOTION_DATE_PROPERTY: p } });
    assert.deepEqual(await t.job.run({ trigger: 'manual' }), { off: true });
    assert.deepEqual(t.job.channels(), { notion: false, sheet: false });
    assert.equal(n.calls.length, 0, 'no call at all for ' + p);
  }
  /* and the property must be a Notion date type */
  const n2 = memNotion({ 'Booked Slot': { type: 'rich_text', rich_text: [] } });
  const r = await make({ notion: true, notionFn: n2.fn, env: { NOTION_DATE_PROPERTY: 'Booked Slot' } }).job.run({ trigger: 'manual' });
  assert.ok(r.items.every((i) => i.why === 'property-not-date'));
  assert.equal(n2.calls.filter((c) => c.method !== 'GET').length, 0);
});

test('sheet: the row is checked again right before each write, in one batched read; a sorted or shifted sheet is never written', async () => {
  /* normal case: exactly one two-cell read per write, then the write */
  const s0 = memSheets(aura());
  await make({ sheet: true, sheetsClient: s0, venues: venueFor('Seongsu') }).job.run({ trigger: 'manual' });
  assert.deepEqual(s0.cellReads.map((c) => c.refs), [['C2', 'Q2'], ['C3', 'Q3']], 'one batched read of the handle and target cell per write');

  /* sorted between our read and our write: rows 2 and 3 swap */
  const tabs = aura(); const s = memSheets(tabs);
  s.afterColumns = () => { const t = tabs['Aura Seoul']; [t[1], t[2]] = [t[2], t[1]]; };
  const t = make({ sheet: true, sheetsClient: s, venues: venueFor('Seongsu') });
  const r = await t.job.run({ trigger: 'manual' });
  assert.equal(s.writes.length, 0, 'no write into the wrong creator row');
  assert.equal(r.channels.sheet.counts['row-moved'], 2);
  assert.equal((await t.job.stateSummary()).sheet.pending, 0, 'not a failure and not parked: it is simply matched again');
  /* next run (sheet now stable) matches against the new order and writes the right cells */
  const r2 = await t.job.run({ trigger: 'poll' });
  assert.equal(r2.channels.sheet.counts.written, 2);
  assert.equal(tabs['Aura Seoul'][1][COLS.C], '@dohyun.l');
  assert.equal(tabs['Aura Seoul'][1][COLS.Q], 'Seongsu store: Dec 6');
  assert.equal(tabs['Aura Seoul'][2][COLS.Q], 'Seongsu store: Dec 5 14.30');

  /* a row inserted above: everything below moves down by one */
  const tabs2 = aura(); const s2 = memSheets(tabs2);
  s2.afterColumns = () => { tabs2['Aura Seoul'].splice(1, 0, sheetRow({ ig: '@new_person', name: 'New' })); };
  const t2 = make({ sheet: true, sheetsClient: s2, venues: venueFor('Seongsu') });
  const r3 = await t2.job.run({ trigger: 'manual' });
  assert.equal(s2.writes.length, 0);
  assert.equal(r3.channels.sheet.counts['row-moved'], 2);
  assert.equal(tabs2['Aura Seoul'][1][COLS.Q], '', 'the inserted row was not touched');
  await t2.job.run({ trigger: 'poll' });
  assert.deepEqual(s2.writes.map((w) => w.row), [3, 4]);
});

test('sheet: the target cell is re-read too; text that appeared meanwhile is not overwritten', async () => {
  const tabs = aura(); const s = memSheets(tabs);
  s.afterColumns = () => { tabs['Aura Seoul'][1][COLS.Q] = 'typed a second ago'; };
  const t = make({ sheet: true, sheetsClient: s, venues: venueFor('Seongsu') });
  const r = await t.job.run({ trigger: 'manual' });
  assert.equal(tabs['Aura Seoul'][1][COLS.Q], 'typed a second ago');
  assert.equal(r.channels.sheet.counts['edited-by-hand'], 1);
  assert.equal(r.channels.sheet.counts.written, 1, 'the other row is fine');
  /* it already holds the right text by the time we look: no write */
  const tabs2 = aura(); const s2 = memSheets(tabs2);
  s2.afterColumns = () => { tabs2['Aura Seoul'][1][COLS.Q] = 'Seongsu store: Dec 5 14.30'; };
  const r2 = await make({ sheet: true, sheetsClient: s2, venues: venueFor('Seongsu') }).job.run({ trigger: 'manual' });
  assert.deepEqual(s2.writes.map((w) => w.row), [3]);
  assert.equal(r2.channels.sheet.counts['unchanged-remote'], 1);
});

test('sheet: a failing pre-write read is a normal failure and nothing is written', async () => {
  const s = memSheets(aura());
  s.readCells = async () => { s.cellReads.push({}); throw Object.assign(new Error('x'), { status: 503 }); };
  const r = await make({ sheet: true, sheetsClient: s, venues: venueFor('Seongsu') }).job.run({ trigger: 'manual' });
  assert.equal(s.writes.length, 0);
  assert.ok(r.channels.sheet.counts.failed >= 1);
});

test('notion: a hand-typed Confirmed Visit is never overwritten; reported as edited-by-hand; staff can force one overwrite by creator id', async () => {
  const n = memNotion(); const t = make({ notion: true, notionFn: n.fn });
  await t.job.run({ trigger: 'poll' });                                           // writes both
  n.pages.get(dashed(1)).properties[PROP].date = { start: '2026-12-24', end: null, time_zone: null };   // a person edits row 1
  const ws = workspace(); ws.db.participants[0].confirmedVisitAt = '2026-12-09 18:00';
  t.setWs(ws);
  const patches = () => n.calls.filter((c) => c.method === 'PATCH').length;
  const p0 = patches();
  const r = await t.job.run({ trigger: 'save' });
  assert.equal(patches(), p0, 'no PATCH');
  assert.equal(r.channels.notion.counts['edited-by-hand'], 1);
  assert.equal(r.items.find((i) => i.outcome === 'edited-by-hand').why, 'edited-by-hand');
  assert.equal((await t.job.stateSummary()).notion.why['edited-by-hand'], 1);
  assert.equal(n.pages.get(dashed(1)).properties[PROP].date.start, '2026-12-24');
  await t.job.run({ trigger: 'manual', force: ['c2'] });
  await t.job.run({ trigger: 'poll', force: ['c1'] });
  await t.job.run({ trigger: 'manual', force: ['c1'], dryRun: true });
  assert.equal(patches(), p0, 'wrong creator, wrong trigger, dry run: still no PATCH');
  const f = await t.job.run({ trigger: 'manual', force: ['c1'] });
  assert.equal(f.channels.notion.counts.written, 1);
  assert.equal(n.pages.get(dashed(1)).properties[PROP].date.start, '2026-12-09T18:00:00');
  await t.job.run({ trigger: 'manual', force: ['c1'] });
  assert.equal(patches(), p0 + 1, 'exactly one forced overwrite');
});

test('notion: a value already there when the ledger knows nothing is "has-other-value", not overwritten; an empty one is written', async () => {
  const n = memNotion();
  n.pages.get(dashed(1)).properties[PROP].date = { start: '2026-11-30', end: null, time_zone: null };
  const t = make({ notion: true, notionFn: n.fn });
  const r = await t.job.run({ trigger: 'manual' });
  assert.equal(r.channels.notion.counts.written, 1, 'the empty one is written');
  assert.equal(r.channels.notion.counts['edited-by-hand'], 1);
  assert.equal(r.items.find((i) => i.outcome === 'edited-by-hand').why, 'has-other-value');
  assert.equal(n.pages.get(dashed(1)).properties[PROP].date.start, '2026-11-30');
});

test('env dry run (no request flag) leaves no ledger state and no stored log; a live channel beside it still saves its own', async () => {
  const n = memNotion(); const s = memSheets(aura());
  const t = make({ notion: true, sheet: true, notionDry: true, sheetDry: true, notionFn: n.fn, sheetsClient: s, venues: venueFor('Seongsu') });
  const r = await t.job.run({ trigger: 'poll' });
  assert.equal(r.channels.notion.counts['would-write'], 2);
  assert.equal(r.channels.sheet.counts['would-write'], 2);
  assert.equal(t.store.saves, 0, 'no ledger saved');
  assert.equal(t.store.state, null);
  assert.equal(t.store.logs.length, 0, 'no log saved');
  assert.ok(t.job.lastRun(), 'the result stays in memory for the status call');
  assert.equal((await t.job.stateSummary()).notion.pending, 0);
  assert.equal((await t.job.stateSummary()).sheet.pending, 0);
  /* mixed: Notion live, Sheet env dry. Notion's ledger is saved, the Sheet's is untouched, the log is saved */
  const n2 = memNotion(); const s2 = memSheets(aura());
  const m = make({ notion: true, sheet: true, sheetDry: true, notionFn: n2.fn, sheetsClient: s2, venues: venueFor('Seongsu') });
  const r2 = await m.job.run({ trigger: 'poll' });
  assert.equal(r2.channels.notion.counts.written, 2);
  assert.equal(r2.channels.sheet.counts['would-write'], 2);
  assert.equal(m.store.saves, 1);
  assert.equal(m.store.logs.length, 1);
  Object.values(m.store.state.items).forEach((it) => {
    assert.ok(it.n.done, 'notion ledger kept');
    assert.deepEqual(it.s, { done: null, want: null, tries: 0, nextAt: 0, why: null, gaveUp: false }, 'sheet ledger untouched by a dry channel');
  });
});

test('sheet: failures queue and retry; a failed venue lookup skips the sheet run rather than writing a wrong text', async () => {
  const s = memSheets(aura()); s.failures = Array(60).fill(500);
  const t = make({ sheet: true, sheetsClient: s, venues: venueFor('Seongsu') });
  const r = await t.job.run({ trigger: 'poll' });
  assert.equal(r.channels.sheet.counts.failed, 2);
  assert.equal((await t.job.stateSummary()).sheet.pending, 2);
  s.failures = [];
  t.clock.t += 3 * 60000;
  const ok = await t.job.run({ trigger: 'poll' });
  assert.equal(ok.channels.sheet.counts.written, 2);

  const s2 = memSheets(aura());
  const t2 = make({ sheet: true, sheetsClient: s2, venues: async () => { throw new Error('db down'); } });
  const r2 = await t2.job.run({ trigger: 'poll' });
  assert.equal(s2.writes.length, 0);
  assert.equal(r2.channels.sheet.error, 'venue-lookup-failed');
});

test('sheets client: one spreadsheet, a column letter (never a range), row 2 or later, one line of text; refused calls make no network call', async () => {
  const calls = [];
  const c = SC.makeSheetsClient({
    spreadsheetId: 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit#gid=0',
    apiBase: 'http://sheets.invalid/v4', getToken: async (scope) => { calls.push({ token: scope }); return 't'; },
    fetchImpl: async (url, o) => { calls.push({ url, method: o.method, body: o.body }); return { ok: true, status: 200, json: async () => ({ valueRanges: [{ values: [['a']] }, {}] }) }; }
  });
  assert.equal(c.spreadsheetId, SHEET_ID);
  await c.writeVisitCell("Aura's Tab", 5, 'Seongsu store: Oct 17', 'q');
  const put = calls.find((x) => x.method === 'PUT');
  assert.ok(put.url.startsWith('http://sheets.invalid/v4/spreadsheets/' + SHEET_ID + '/values/'));
  assert.ok(put.url.endsWith('?valueInputOption=RAW'), 'RAW keeps the text a text');
  assert.equal(JSON.parse(put.body).range, "'Aura''s Tab'!Q5");
  assert.equal(calls[0].token, 'https://www.googleapis.com/auth/spreadsheets');

  /* a batched cell read is ONE request with two ranges */
  const before = calls.length;
  const got = await c.readCells('T', [{ col: 'C', row: 4 }, { col: 'q', row: 4 }]);
  assert.deepEqual(got, ['a', '']);
  const fetches = calls.slice(before).filter((x) => x.url);
  assert.equal(fetches.length, 1, 'one request');
  assert.equal((fetches[0].url.match(/ranges=/g) || []).length, 2);

  /* everything below is refused before any token request or network call */
  const n = calls.length;
  await assert.rejects(() => c.writeVisitCell('T', 1, 'x', 'Q'), /refusing/);
  await assert.rejects(() => c.writeVisitCell('T', 'A1', 'x', 'Q'), /refusing/);
  await assert.rejects(() => c.writeVisitCell('T', 3, 'a\nb', 'Q'), /refusing/);
  await assert.rejects(() => c.writeVisitCell('T', 3, '', 'Q'), /refusing/);
  await assert.rejects(() => c.writeVisitCell('T', 3, 'x'), /refusing/, 'no column, no write');
  for (const col of ['5', 'Q5', 'A1:B2', 'Q:Q', '', 'QQQQ']) await assert.rejects(() => c.writeVisitCell('T', 3, 'x', col), /refusing/, 'column ' + col);
  await assert.rejects(() => c.readCells('T', [{ col: 'C', row: 0 }]), /bad cell/);
  await assert.rejects(() => c.readCells('T', [{ col: 'C:D', row: 2 }]), /bad cell/);
  await assert.rejects(() => c.readCells('T', []), /one to four/);
  await assert.rejects(() => c.readCells('T', Array(5).fill({ col: 'C', row: 2 })), /one to four/);
  await assert.rejects(() => c.readHeaderRow('T', 0), /header row/);
  await assert.rejects(() => c.readHeaderRow('T', 11), /header row/);
  assert.equal(calls.length, n, 'no token request and no fetch for any refused call');
  assert.deepEqual(Object.keys(c).sort(), ['listTabs', 'readCells', 'readColumns', 'readHeaderRow', 'spreadsheetId', 'writeVisitCell'], 'no other method exists');
  assert.ok(calls.filter((x) => x.url).every((x) => x.url.startsWith('http://sheets.invalid/v4/spreadsheets/' + SHEET_ID)), 'every request went to the one spreadsheet');
  assert.throws(() => SC.makeSheetsClient({ spreadsheetId: 'short', getToken: async () => 't' }), /spreadsheet id/);
  assert.equal(SC.parseSpreadsheetId('not an id'), null);
});

/* ============================ privacy, saves, workspace ============================ */

test('privacy: planted sentinel names, handles, addresses and phones never reach a log, the run entry, the status, the stored log or the ledger', async () => {
  const SENT = {
    name1: 'Zqxname Alpha7731', name2: 'Zqxname Bravo7731', h1: 'zqx_alpha_7731', h2: 'zqx.bravo.7731',
    addr: 'Zqx Boulevard 7731 Unit 9', phone: '010-7731-7731', email: 'zqx7731@example.invalid', note: 'Zqxnote7731'
  };
  const sentinels = Object.values(SENT);
  const ws = { db: {
    campaigns: [{ id: 'cp1', brand: 'Aura', name: 'Aura Seoul' }],
    creators: [
      { id: 'c1', handle: '@' + SENT.h1, name: SENT.name1, address: SENT.addr, contact: SENT.phone, email: SENT.email },
      { id: 'c2', handle: SENT.h2, name: SENT.name2, address: SENT.addr, contact: SENT.phone, email: SENT.email }
    ],
    participants: [
      { id: 'p1', campaignId: 'cp1', creatorId: 'c1', stage: 'confirmed', confirmedVisitAt: '2026-12-05 14:30', notionPageId: dashed(1), fullName: SENT.name1, notes: SENT.note },
      { id: 'p2', campaignId: 'cp1', creatorId: 'c2', stage: 'confirmed', confirmedVisitAt: '2026-12-06', notionPageId: dashed(2), fullName: SENT.name2, notes: SENT.note }
    ]
  } };
  const rowOf = (ig, name) => sheetRow({ ig, name, addr: SENT.addr, phone: SENT.phone });
  const mk = () => ({ 'Aura Seoul': [HEADER.slice(), rowOf('https://instagram.com/' + SENT.h1, SENT.name1), rowOf('@' + SENT.h2, SENT.name2), rowOf('@' + SENT.h2, SENT.name2)] });
  const seen = [];
  const spy = ['log', 'error', 'warn', 'info'].map((k) => { const o = console[k]; console[k] = (...a) => { seen.push(format(...a)); }; return [k, o]; });
  const runs = [];
  let t, n, s;
  try {
    /* a Notion page whose text fields carry the sentinels, and errors whose message carries them */
    n = memNotion({ [PROP]: { type: 'date', date: null }, 'Full Name': { type: 'title', title: [{ plain_text: SENT.name1 }] }, Notes: { type: 'rich_text', rich_text: [{ plain_text: SENT.addr + ' ' + SENT.phone }] } });
    const realFn = n.fn; let boom = 0;
    n.fn = async (...a) => { if (boom-- > 0) throw Object.assign(new Error('Notion said: ' + sentinels.join(' | ')), { status: 503 }); return realFn(...a); };
    s = memSheets(mk());
    t = make({ ws, notion: true, sheet: true, notionFn: n.fn, sheetsClient: s, venues: venueFor('Seongsu') });
    boom = 4;                                                       // Notion failures with sentinel text
    runs.push(await t.job.run({ trigger: 'manual' }));
    runs.push(await t.job.run({ trigger: 'manual', dryRun: true }));
    s.readColumns = async () => { throw Object.assign(new Error('Google said: ' + sentinels.join(' | ')), { status: 500 }); };
    t.clock.t += 24 * 3600000;
    runs.push(await t.job.run({ trigger: 'manual' }));              // Sheet failure with sentinel text
    runs.push(await t.job.run({ trigger: 'poll' }));
    /* paths that mention people: duplicate handle with no name tie-break, no match, row moved, hand-edited */
    const tabs2 = mk(); tabs2['Aura Seoul'][2][COLS.E] = ''; tabs2['Aura Seoul'][3][COLS.E] = '';
    const s2 = memSheets(tabs2); s2.afterColumns = () => { const x = tabs2['Aura Seoul']; [x[1], x[2]] = [x[2], x[1]]; };
    const t2 = make({ ws, sheet: true, sheetsClient: s2, venues: venueFor('Seongsu') });
    runs.push(await t2.job.run({ trigger: 'manual' }));
    tabs2['Aura Seoul'].find((r) => String(r[COLS.C]).includes(SENT.h1))[COLS.Q] = SENT.note;
    runs.push(await t2.job.run({ trigger: 'manual' }));
    var extra = [t2.logs, t2.store.logs, t2.store.state, await t2.job.stateSummary(), t2.job.lastRun()];
  } finally { spy.forEach(([k, o]) => { console[k] = o; }); }
  const blob = JSON.stringify([runs, t.logs, t.store.logs, t.store.state, t.job.lastRun(), await t.job.stateSummary(), seen, extra]);
  sentinels.forEach((x) => assert.ok(!blob.includes(x), 'leaked: ' + x));
  assert.ok(!blob.toLowerCase().includes('zqx'), 'no part of any planted value appears anywhere');
  assert.ok(t.logs.length >= 3 && runs.length === 6, 'it did run, log and queue');
  assert.ok(runs.some((r) => r.channels.notion.counts.failed) && runs.some((r) => r.channels.sheet.counts.failed), 'the error paths were exercised');
  assert.ok(runs.some((r) => r.channels.sheet.counts['row-moved']) && runs.some((r) => r.channels.sheet.counts['edited-by-hand']), 'the mismatch paths were exercised');
  runs.forEach((r) => r.items.forEach((i) => assert.ok(Object.keys(i).every((k) => ['id', 'campaignId', 'channel', 'outcome', 'why', 'row'].includes(k)))));
});

test('the job only reads the workspace: a counting fake sees one read per run, no workspace write of any kind, and the document is unchanged', async () => {
  const doc = JSON.parse(JSON.stringify(workspace().db));
  const deepFreeze = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };
  const frozen = deepFreeze(JSON.parse(JSON.stringify(doc)));     // a write to it would throw
  const used = new Map(); const count = (k) => used.set(k, (used.get(k) || 0) + 1);
  const n = memNotion(); const s = memSheets(aura());
  const sheetsFake = {}; ['listTabs', 'readHeaderRow', 'readColumns', 'readCells', 'writeVisitCell'].forEach((m) => { sheetsFake[m] = (...a) => { count('sheets.' + m); return s[m](...a); }; });
  const config = W.parseConfig({}); config.notion.enabled = true; config.sheet.enabled = true;
  const deps = {
    config, logger: { log() {}, error() {} },
    loadWorkspace: async () => { count('loadWorkspace'); return { db: frozen }; },
    loadState: async () => { count('loadState'); return null; },
    saveState: async (st) => { count('saveState'); assert.deepEqual(Object.keys(st), ['items']); },
    saveLog: async () => { count('saveLog'); },
    notion: async (...a) => { count('notion.' + a[0]); return n.fn(...a); },
    sheets: sheetsFake,
    venueNames: async () => new Map(),
    /* tripwires: nothing in the job should reach for these, now or after a refactor */
    saveWorkspace: () => count('SAVE WORKSPACE'), saveWorkspaceDoc: () => count('SAVE WORKSPACE'), forceSaveWorkspace: () => count('FORCE SAVE'),
    updateWorkspace: () => count('SAVE WORKSPACE'), now: () => new Date(NOW), sleep: async () => {}, retryDelayMs: 1
  };
  const seenKeys = new Set();
  const job = W.createDateWriteback(new Proxy(deps, { get(t, k) { seenKeys.add(String(k)); return t[k]; } }));
  const r1 = await job.run({ trigger: 'manual' });
  const r2 = await job.run({ trigger: 'manual' });
  assert.equal(r1.error, null); assert.equal(r1.channels.notion.error, null); assert.equal(r1.channels.sheet.error, null);
  assert.equal(r1.channels.notion.counts.written, 2);
  assert.equal(used.get('loadWorkspace'), 2, 'one workspace read per run');
  assert.ok(!used.has('SAVE WORKSPACE') && !used.has('FORCE SAVE'), 'no workspace save of any kind');
  ['saveWorkspace', 'saveWorkspaceDoc', 'forceSaveWorkspace', 'updateWorkspace'].forEach((k) => assert.ok(!seenKeys.has(k), 'the job never even looked up ' + k));
  assert.deepEqual(frozen, doc, 'the document is exactly as it was');
  assert.equal(r2.channels.notion.counts['unchanged-remote'], 2, 'this fake keeps no ledger, so the second run re-reads and finds nothing to write');
  /* the only things written anywhere: the ledger, the log, the one Notion property, the one Sheet column */
  assert.deepEqual([...used.keys()].filter((k) => /save|write|PATCH/i.test(k)).sort(), ['notion.PATCH', 'saveLog', 'saveState', 'sheets.writeVisitCell']);
});

test('wiring (source check, kept short): the save route pings only after a 200 and swallows any error; both endpoints are staff-only', () => {
  const srv = fs.readFileSync(ROOT + 'server.js', 'utf8');
  const start = srv.indexOf('confirmed visit date: dashboard -> Notion row + Sheet row');
  const end = srv.indexOf('---------------------------- google calendar');
  const block = srv.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.equal((block.match(/app\.(get|post)\(/g) || []).length, 2);
  assert.equal((block.match(/requireStaff\(/g) || []).length, 2);
  assert.match(srv, /out\.status === 200 && dateWriteback\) \{ try \{ dateWriteback\.notifySaved\(\); \} catch/);
});

test('a dashboard save is never blocked: notifySaved is synchronous, coalesces, and a failing job does not throw', async () => {
  const n = memNotion(); n.fn = async () => { throw new Error('everything is broken'); };
  const t = make({ notion: true, notionFn: n.fn, debounceMs: 5, ws: workspace() });
  let threw = false;
  const t0 = Date.now();
  try { t.job.notifySaved(); t.job.notifySaved(); t.job.notifySaved(); } catch (e) { threw = true; }
  assert.equal(threw, false);
  assert.ok(Date.now() - t0 < 50, 'returns at once');
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(t.logs.some((l) => /Date write-back run \(save/.test(l)), 'one run happened after the save');
  assert.equal(t.logs.filter((l) => /run \(save/.test(l)).length, 1, 'three saves, one run');
  t.job.notifySaved(); // timer unref'd; nothing to clean up
});

test('a run that fails inside (workspace unreadable) returns an error code instead of throwing', async () => {
  const n = memNotion();
  const config = W.parseConfig({}); config.notion.enabled = true;
  const job = W.createDateWriteback({ config, loadWorkspace: async () => { throw Object.assign(new Error('mongo down'), { status: 500 }); }, notion: n.fn, logger: { log() {}, error() {} } });
  const r = await job.run({ trigger: 'poll' });
  assert.equal(r.error, 'http-500');
  assert.equal(n.calls.length, 0);
});

/* ============================ over HTTP against the fakes ============================ */

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

test('end to end over HTTP: real sheets client against fake-google, Notion calls against fake-notion', async () => {
  const np = await freePort(); const gp = await freePort();
  const fn = await startProc('tools/fake-notion.cjs', { FAKE_NOTION_PORT: String(np) }, 'fake notion on');
  const fg = await startProc('tools/fake-google.cjs', { FAKE_GOOGLE_PORT: String(gp) }, 'fake google on');
  try {
    const props = { [PROP]: { type: 'date', date: null }, 'Visit Date': { type: 'date', date: { start: '2026-12-01' } }, Status: { type: 'status' } };
    await httpJson(np, 'POST', '/__page', { id: dashed(1), properties: props });
    await httpJson(np, 'POST', '/__page', { id: dashed(2), properties: JSON.parse(JSON.stringify(props)) });
    await httpJson(gp, 'POST', '/__sheet', { id: SHEET_ID, tabs: aura() });
    const notion = async (method, path, body) => {
      const r = await fetch('http://127.0.0.1:' + np + '/v1' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json();
      if (!r.ok) throw Object.assign(new Error(j.message), { status: r.status });
      return j;
    };
    const sheets = SC.makeSheetsClient({ spreadsheetId: SHEET_ID, apiBase: 'http://127.0.0.1:' + gp + '/v4', getToken: async () => 'test-token' });
    const t = make({ notion: true, sheet: true, notionFn: notion, sheetsClient: sheets, venues: venueFor('Seongsu') });
    const r = await t.job.run({ trigger: 'manual' });
    assert.equal(r.channels.notion.counts.written, 2, JSON.stringify(r.channels));
    assert.equal(r.channels.sheet.counts.written, 2, JSON.stringify([r.channels, r.items]));

    const ns = (await httpJson(np, 'GET', '/__state')).json;
    const dateWrites = ns.writes.filter((w) => w.shape && w.shape.date);
    assert.equal(dateWrites.length, 2);
    dateWrites.forEach((w) => assert.deepEqual(w.names, [PROP], 'only the one property is ever sent'));
    assert.equal(ns.pageProps[dashed(1)].properties['Visit Date'].date.start, '2026-12-01', 'the creator request is untouched');
    assert.equal(ns.pageProps[dashed(1)].properties[PROP].date.start, '2026-12-05T14:30:00.000+09:00');

    const gs = (await httpJson(gp, 'GET', '/__sheetstate')).json;
    assert.equal(gs.log.writes.length, 2);
    gs.log.writes.forEach((w) => { assert.match(w.range, /^'Aura Seoul'!Q\d+$/, 'only column Q'); assert.equal(w.valueInputOption, 'RAW'); });
    gs.log.reads.forEach((rg) => assert.match(rg, /^'Aura Seoul'!(A1:ZZ1|C:C|Q:Q|C\d+|Q\d+)$/, 'only the header row, the handle and visit columns, and single cells of those were read'));
    assert.ok(gs.log.reads.includes("'Aura Seoul'!A1:ZZ1") && gs.log.reads.includes("'Aura Seoul'!C2") && gs.log.reads.includes("'Aura Seoul'!Q2"), 'header and the pre-write cell reads happened');
    const tab = gs.sheets[SHEET_ID].tabs['Aura Seoul'];
    assert.equal(tab[1][COLS.Q], 'Seongsu store: Dec 5 14.30');
    assert.equal(tab[1][COLS.L], 'Some Address 1');
    assert.equal(tab[1][COLS.M], '010-9999-0000');

    /* second run: nothing more reaches either fake */
    const w1 = ns.writes.length, g1 = gs.log.writes.length, r1 = gs.log.reads.length;
    await t.job.run({ trigger: 'poll' });
    const ns2 = (await httpJson(np, 'GET', '/__state')).json; const gs2 = (await httpJson(gp, 'GET', '/__sheetstate')).json;
    assert.equal(ns2.writes.length, w1);
    assert.equal(gs2.log.writes.length, g1);
    assert.equal(gs2.log.reads.length, r1);

    /* a transient Sheet failure then success, over real HTTP */
    const ws = workspace(); ws.db.participants[0].confirmedVisitAt = '2026-12-12 12:00';
    t.setWs(ws);
    await httpJson(gp, 'POST', '/__sheetfail', { status: 503, times: 1, method: 'PUT' });
    const moved = await t.job.run({ trigger: 'save' });
    assert.equal(moved.channels.sheet.counts.written, 1);
    assert.equal(moved.channels.notion.counts.written, 1);
  } finally { fn.child.kill(); fg.child.kill(); }
});

/* ============================ the real server process ============================ */

async function withServer(env, fn) {
  const port = await freePort();
  const srv = await startProc('server.js', Object.assign({ PORT: String(port) }, env), 'VIVELY app listening on port');
  try { await fn(port, srv); } finally { srv.child.kill(); }
}

test('server: both flags off by default: nothing starts and both endpoints refuse an anonymous caller', async () => {
  await withServer({}, async (port, srv) => {
    assert.ok(!/Date write-back: ON/.test(srv.output()));
    assert.equal((await httpJson(port, 'POST', '/api/date-writeback/run', {})).status, 401);
    assert.equal((await httpJson(port, 'GET', '/api/date-writeback/status')).status, 401);
  });
});

test('server: flags on start the job, print no secret, and stay staff-only; the sheet flag needs its spreadsheet id and key', async () => {
  await withServer({
    NOTION_DATE_WRITEBACK: '1', SHEET_DATE_WRITEBACK: '1', NOTION_DATE_WRITEBACK_DRY_RUN: '1', SHEET_DATE_WRITEBACK_DRY_RUN: '1',
    NOTION_TOKEN: 'notion-secret-not-real', GOOGLE_SERVICE_ACCOUNT: 'google-secret-not-real', SHEET_WRITEBACK_SPREADSHEET_ID: SHEET_ID,
    MONGODB_URI: 'mongodb://127.0.0.1:1/never', NOTION_API: 'http://127.0.0.1:1/v1', GOOGLE_SHEETS_API: 'http://127.0.0.1:1/v4',
    STAFF_EMAILS: 'staff@example.invalid', DATE_WRITEBACK_INTERVAL_MIN: '60'
  }, async (port, srv) => {
    assert.match(srv.output(), /Date write-back: ON \(notion dry run, sheet dry run\), every 60 min/);
    assert.ok(!srv.output().includes('notion-secret-not-real'));
    assert.ok(!srv.output().includes('google-secret-not-real'));
    assert.ok(!srv.output().includes(SHEET_ID), 'the spreadsheet id is not logged either');
    assert.equal((await httpJson(port, 'POST', '/api/date-writeback/run', { dryRun: true })).status, 401);
    assert.equal((await httpJson(port, 'GET', '/api/date-writeback/status')).status, 401);
  });
  await withServer({
    SHEET_DATE_WRITEBACK: '1', GOOGLE_SERVICE_ACCOUNT: 'x', MONGODB_URI: 'mongodb://127.0.0.1:1/never'
  }, async (port, srv) => {
    assert.match(srv.output(), /Sheet date write-back stays off: SHEET_WRITEBACK_SPREADSHEET_ID is missing/);
    assert.ok(!/Date write-back: ON/.test(srv.output()));
  });
  await withServer({ NOTION_DATE_WRITEBACK: '1', MONGODB_URI: 'mongodb://127.0.0.1:1/never' }, async (port, srv) => {
    assert.match(srv.output(), /Notion date write-back stays off: NOTION_TOKEN is not set/);
  });
});

test('server: the Google token code still defaults to the calendar scope; the sheet client asks for its own scope', () => {
  const srv = fs.readFileSync(ROOT + 'server.js', 'utf8');
  assert.match(srv, /const wantScope = scope \|\| GCAL_SCOPE;/);
  assert.match(srv, /getToken: \(scope\) => googleAccessToken\(scope\)/);
  assert.equal(SC.SHEETS_SCOPE, 'https://www.googleapis.com/auth/spreadsheets');
});

test('server: a Notion date property the form fills in keeps the Notion channel off, with the reason', async () => {
  for (const p of ['Visit Date', ' status ']) {
    await withServer({ NOTION_DATE_WRITEBACK: '1', NOTION_TOKEN: 'notion-secret-not-real', MONGODB_URI: 'mongodb://127.0.0.1:1/never', NOTION_DATE_PROPERTY: p }, async (port, srv) => {
      assert.match(srv.output(), /Notion date write-back stays off: NOTION_DATE_PROPERTY is a property the form or the system fills in/);
      assert.ok(!/Date write-back: ON/.test(srv.output()));
    });
  }
});
