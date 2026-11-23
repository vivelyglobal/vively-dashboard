/* The brand-sheet export: template header names (the date write-back finds its
   columns by them), the privacy modes, STANDBY ordering, formula safety, and
   that the export never writes the workspace.
   Every creator below is invented. SENTINEL strings are planted in the real
   fields that exist on creators, participants and campaigns (see SHEET_SCHEMA
   in index.html); a brand-safe file must contain none of them. */
import './helpers/browser-shim.mjs';
import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBrandSheet, BRAND_SHEET_HEADERS, brandSheetVisitText, brandSheetSafeCell, brandSheetStatusLabel,
  loadBrandSheetOptions, saveBrandSheetOptions, BRAND_SHEET_OPTS_KEY
} from '../src/model/brandSheet.js';
import { buildXlsx, unzip } from '../src/lib/xlsx.js';

/* The 27 header names live in a plain fixture file copied from the template by
   hand. The real template spreadsheet is NOT re-read by these tests: they only
   notice if the source list drifts from the copy. */
const TEMPLATE = fs.readFileSync(new URL('./fixtures/brand-sheet-headers.txt', import.meta.url), 'utf8')
  .split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l !== '');

const S = {
  /* creator fields */
  cEmail: 'sentinel-mail@example.invalid', cPhone: 'SENTINEL-CR-PHONE-010', cAddr: 'SENTINEL-CR-ADDRESS-1 Fake Road',
  cNotes: 'SENTINEL-CR-NOTES', cFlag: 'SENTINEL-CR-FLAGREASON', cTag: 'SENTINEL-CR-TAG', cGender: 'SENTINEL-GENDER', cRate: 987654321,
  /* participant fields */
  pNote: 'SENTINEL-PT-NOTE', pFee: 876543210, pNotionId: 'SENTINEL-NOTION-PAGE-0000', pStatus: 'SENTINEL-IMPORTED-STATUS internal remark',
  pAddr: 'SENTINEL-PT-ADDRESS-2 Fake Street', pPhone: 'SENTINEL-PT-PHONE-010', pDm: 'SENTINEL-DM-TEXT', pSns: 'SENTINEL-OTHER-SNS',
  /* campaign fields */
  kNote: 'SENTINEL-CP-NOTE', kNotionDb: 'SENTINEL-CP-NOTION-DB', kDesc: 'SENTINEL-CP-NOTION-DESC', kVenue: 'SENTINEL-CP-VENUE-ADDRESS',
  kOwner: 'SENTINEL-CP-OWNER', kBudget: 765432109,
  /* gated: only with the tick-boxes on */
  name: 'Sentinel Fakename', nat: 'Sentinelland'
};
const LEAKS = Object.entries(S).filter(([k]) => !['name', 'nat'].includes(k)).map(([, v]) => String(v));

const cp = {
  id: 'cp1', name: 'Fake Brand Spring', brand: 'Fake Brand',
  note: S.kNote, notionDatabaseId: S.kNotionDb, notionDescription: S.kDesc, venue: S.kVenue, owner: S.kOwner, budget: S.kBudget
};
const cr = (id, o) => Object.assign({
  id, handle: 'fake_' + id, name: S.name + ' ' + id, platform: 'Instagram', followers: 12345, nationality: S.nat,
  email: S.cEmail, contact: S.cPhone, address: S.cAddr, notes: S.cNotes, flagReason: S.cFlag, tags: [S.cTag],
  gender: S.cGender, rate: S.cRate
}, o);
const pt = (id, stage, o) => Object.assign({
  id: 'p-' + id, campaignId: 'cp1', creatorId: id, stage, fee: S.pFee, note: S.pNote, message: S.pDm,
  notionPageId: S.pNotionId, importedStatus: S.pStatus, address: S.pAddr, contact: S.pPhone, otherSns: S.pSns,
  fullName: S.name + ' ' + id, nationality: S.nat, appliedAt: '2026-10-01T09:30:00.000Z'
}, o);

const creators = {};
['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].forEach((k) => { creators[k] = cr(k); });
const participants = [
  pt('d', 'shortlisted'),
  pt('b', 'confirmed', { confirmedVisitAt: '2026-10-27 17:30' }),
  pt('e', 'dropped', { dropReason: 'Brand rejected' }),
  pt('a', 'live', { confirmedVisitAt: '2026-10-17', content: { postedAt: '2026-10-20', format: 'Reel' } }),
  pt('f', 'dropped', { dropReason: 'Ghosted' }),
  pt('g', 'contacted'),
  pt('h', 'dropped', { dropReason: 'Creator declined' }),
  pt('c', 'shipped', { visitAt: '2026-11-05 12:00' })   /* requested only, not confirmed */
];
const base = { cp, participants, creators, date: '2026-11-23' };
const col = (sheet, h) => sheet.headers.indexOf(h);
const all = (sheet) => JSON.stringify(sheet.rows);
const igOf = (s) => s.rows.slice(1).map((r) => (r[0] === 'STANDBY' ? 'STANDBY' : r[col(s, 'Instagram')].replace('https://www.instagram.com/fake_', '').replace('/', '')));
async function partsText(sheet) {
  const raw = Buffer.from(await buildXlsx(sheet.sheetName, sheet.rows).arrayBuffer());
  const files = await unzip(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
  return Object.values(files).join(String.fromCharCode(10));
}
async function fileText(sheet) {
  const blob = buildXlsx(sheet.sheetName, sheet.rows);
  const raw = Buffer.from(await blob.arrayBuffer());
  const files = await unzip(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
  /* decoded parts plus the raw bytes (in case a part is stored uncompressed) */
  return Object.values(files).join('\n') + '\n' + raw.toString('latin1') + '\n' + raw.toString('utf8');
}

test('the template header names are exact and in order (fixture copy, 27 names)', () => {
  assert.equal(TEMPLATE.length, 27);
  assert.deepEqual(BRAND_SHEET_HEADERS, TEMPLATE);
  const s = buildBrandSheet({ ...base, mode: 'internal', confirmInternal: true });
  assert.deepEqual(s.headers, TEMPLATE);
  assert.deepEqual(s.rows[0], TEMPLATE);
});

test('brand-safe is the default and drops address, phone, DM, gender, secondary usage', () => {
  const s = buildBrandSheet(base);
  assert.equal(s.mode, 'brand');
  ['성별', 'Address', 'Phone Number', 'Secondary Usage', '메시지'].forEach((h) => assert.ok(!s.headers.includes(h), h));
  assert.deepEqual(s.headers, TEMPLATE.filter((h) => !['성별', 'Address', 'Phone Number', 'Secondary Usage', '메시지', '크리에이터', '국적'].includes(h)));
});

test('SENTINELS planted in every real private field never reach a brand-safe file, rows or xlsx bytes', async () => {
  assert.ok(LEAKS.length >= 20, 'sentinel list is populated');
  for (const flags of [{}, { showNames: true, showNationality: true }, { includeRejected: true }, { showNames: true, showNationality: true, includeRejected: true }]) {
    const s = buildBrandSheet({ ...base, ...flags });
    const text = all(s) + '\n' + (await fileText(s));
    LEAKS.forEach((x) => assert.ok(!text.includes(x), x + ' leaked with ' + JSON.stringify(flags)));
    assert.ok(!/notion\.so/i.test(text));
  }
});

test('the sentinel check can fail: the same planted values DO show up where the column exists (internal) and in the xlsx bytes', async () => {
  const s = buildBrandSheet({ ...base, mode: 'internal', confirmInternal: true });
  const text = all(s) + '\n' + (await fileText(s));
  [S.pAddr, S.pPhone, S.pDm, S.pStatus].forEach((x) => assert.ok(text.includes(x), x + ' should be reachable'));
  /* and the xlsx path itself carries a planted cell, so the byte scan is not blind */
  const probe = buildBrandSheet({ ...base, showNames: true });
  assert.ok((await fileText(probe)).includes(S.name + ' a'));
  /* never, even internal: email, notes, fee, Notion id, campaign fields */
  [S.cEmail, S.cNotes, S.cFlag, S.pNote, String(S.pFee), String(S.cRate), S.pNotionId, S.kNote, S.kVenue, S.kNotionDb, S.kOwner, String(S.kBudget)]
    .forEach((x) => assert.ok(!text.includes(x), x + ' must not be in the internal file either'));
});

test('creator names and nationality are off by default and only a real true switches them on', async () => {
  let s = buildBrandSheet(base);
  assert.ok(!s.headers.includes('크리에이터') && !s.headers.includes('국적'));
  const text = all(s) + (await fileText(s));
  assert.ok(!text.includes(S.name) && !text.includes(S.nat));
  s = buildBrandSheet({ ...base, showNames: 'true', showNationality: 1 });
  assert.ok(!s.headers.includes('크리에이터') && !s.headers.includes('국적'));
  s = buildBrandSheet({ ...base, showNames: true });
  assert.ok(s.headers.includes('크리에이터') && !s.headers.includes('국적'));
  assert.ok(all(s).includes(S.name + ' a'));
  s = buildBrandSheet({ ...base, showNationality: true });
  assert.ok(s.headers.includes('국적') && !s.headers.includes('크리에이터'));
  assert.ok(all(s).includes(S.nat));
});

test('the Instagram column is the public profile link, always present', () => {
  const s = buildBrandSheet(base);
  const i = col(s, 'Instagram');
  assert.equal(s.rows[1][i], 'https://www.instagram.com/fake_b/');
  const odd = buildBrandSheet({ ...base, participants: [pt('a', 'confirmed')], creators: { a: cr('a', { handle: ' @Fake.Name/?hl=ko ' }) } });
  assert.equal(odd.rows[1][i], 'https://www.instagram.com/fake.name/');
});

test('internal mode refuses without the explicit confirmation flag', () => {
  assert.throws(() => buildBrandSheet({ ...base, mode: 'internal' }), /confirmation/);
  assert.throws(() => buildBrandSheet({ ...base, mode: 'internal', confirmInternal: 'yes' }), /confirmation/);
  assert.throws(() => buildBrandSheet({ ...base, mode: 'internal', confirmInternal: 1 }), /confirmation/);
  assert.equal(buildBrandSheet({ ...base, mode: 'full' }).mode, 'brand');
});

test('internal mode has the private columns, and says INTERNAL in the file name and the tab', () => {
  const s = buildBrandSheet({ ...base, mode: 'internal', confirmInternal: true });
  const t = all(s);
  assert.ok(t.includes(S.pAddr) && t.includes(S.pPhone) && t.includes(S.pDm));
  assert.match(s.filename, /^INTERNAL_/);
  assert.match(s.sheetName, /^INTERNAL /);
  assert.equal(buildBrandSheet(base).filename.startsWith('INTERNAL'), false);
});

/* ---- fix 2: default rows ---- */
test('brand-safe default: confirmed, STANDBY, waiting for the brand; rejected and declined left out', () => {
  const s = buildBrandSheet({ ...base, showNames: true });
  assert.deepEqual(igOf(s), ['b', 'a', 'c', 'STANDBY', 'd']);
  assert.deepEqual(s.rows.slice(1).map((r) => r[0]), [1, 2, 3, 'STANDBY', 4]);
  assert.equal(s.counts.rejected, 0);
  assert.equal(s.counts.rejectedHidden, 1);
  const op = col(s, '브랜드 의견'), vo = col(s, 'VIVELY 의견');
  assert.deepEqual(s.rows.slice(1).map((r) => [r[op], r[vo]]),
    [['Accepted', 'Confirmed'], ['Accepted', 'Confirmed'], ['Accepted', 'Confirmed'], ['', ''], ['', 'Optional']]);
  assert.ok(s.rows[4].slice(1).every((v) => v === ''), 'STANDBY row has nothing else in it');
  assert.ok(!all(s).includes('Rejected'));
});

test('"Include rejected" adds the brand-rejected creators after the waiting ones; creator-declined stay out', () => {
  const s = buildBrandSheet({ ...base, includeRejected: true });
  assert.deepEqual(igOf(s), ['b', 'a', 'c', 'STANDBY', 'd', 'e']);
  assert.deepEqual(s.counts, { confirmed: 3, standby: 1, rejected: 1, rejectedHidden: 0, missingStore: s.counts.missingStore });
  assert.equal(s.rows[s.rows.length - 1][col(s, '브랜드 의견')], 'Rejected');
  assert.ok(!igOf(s).includes('h') && !igOf(s).includes('f') && !igOf(s).includes('g'));
  /* only a real true counts */
  assert.deepEqual(igOf(buildBrandSheet({ ...base, includeRejected: 'true' })), ['b', 'a', 'c', 'STANDBY', 'd']);
  assert.deepEqual(igOf(buildBrandSheet({ ...base, includeRejected: 1 })), ['b', 'a', 'c', 'STANDBY', 'd']);
});

test('internal mode behaviour is unchanged: rejected rows still included without any option', () => {
  const s = buildBrandSheet({ ...base, mode: 'internal', confirmInternal: true });
  assert.deepEqual(igOf(s), ['b', 'a', 'c', 'STANDBY', 'd', 'e']);
});

test('only rejected creators with the box off: header row only, no STANDBY', () => {
  const s = buildBrandSheet({ ...base, participants: [pt('e', 'dropped', { dropReason: 'Brand rejected' })] });
  assert.equal(s.rows.length, 1);
});

/* ---- fix 1: Status ---- */
test('brand-safe Status is the dashboard stage label only, never imported Notion text', async () => {
  const s = buildBrandSheet({ ...base, includeRejected: true });
  const st = col(s, 'Status');
  const labels = s.rows.slice(1).filter((r) => r[0] !== 'STANDBY').map((r) => r[st]);
  assert.deepEqual(labels, ['Confirmed', 'Live', 'Shipped / Booked', 'Shortlisted', 'Dropped']);
  assert.ok(!(all(s) + (await fileText(s))).includes('SENTINEL-IMPORTED-STATUS'));
  /* hostile status text, formula-looking text and a very long remark */
  const odd = buildBrandSheet({ ...base, participants: [pt('a', 'confirmed', { importedStatus: '=cmd|x  ' + 'x'.repeat(500) })] });
  assert.equal(odd.rows[1][st], 'Confirmed');
});

test('an unknown stage gets a neutral label; internal keeps the imported status as before', () => {
  assert.equal(brandSheetStatusLabel('confirmed'), 'Confirmed');
  assert.equal(brandSheetStatusLabel('no-such-stage'), 'In progress');
  assert.equal(brandSheetStatusLabel(undefined), 'In progress');
  assert.equal(brandSheetStatusLabel('__proto__'), 'In progress');
  const s = buildBrandSheet({ ...base, mode: 'internal', confirmInternal: true });
  assert.equal(s.rows[1][col(s, 'Status')], S.pStatus);
});

test('TRUE/FALSE columns', () => {
  const s = buildBrandSheet(base);
  const ma = col(s, 'Message Accepted'), rc = col(s, 'Replied Confirmed');
  const byIg = (h) => s.rows.find((r) => r[col(s, 'Instagram')] === 'https://www.instagram.com/fake_' + h + '/');
  assert.equal(byIg('a')[rc], 'TRUE');
  assert.equal(byIg('d')[rc], 'FALSE');
  assert.equal(byIg('d')[ma], 'TRUE');
});

test('formula-looking text gets a leading apostrophe in every cell', () => {
  ['=1+1', '+1', '-1', '@SUM(A1)', '\t=x', '\r=x'].forEach((v) => assert.equal(brandSheetSafeCell(v), "'" + v, JSON.stringify(v)));
  assert.equal(brandSheetSafeCell('plain'), 'plain');
  const evil = { a: cr('a', { name: '=HYPERLINK("http://x.invalid")', nationality: '+cmd', address: '-2+3', contact: '@sum' }) };
  const s = buildBrandSheet({ ...base, mode: 'internal', confirmInternal: true, participants: [{ id: 'p', creatorId: 'a', stage: 'confirmed' }], creators: evil });
  const row = s.rows[1];
  ['크리에이터', '국적', 'Address', 'Phone Number'].forEach((h) => assert.match(row[col(s, h)], /^'[=+\-@]/, h));
  s.rows.slice(1).forEach((r) => r.forEach((v) => { if (typeof v === 'string') assert.ok(!/^[=+\-@]/.test(v)); }));
});

test('illegal XML characters are stripped so the file always opens', async () => {
  const evil = { a: cr('a', { name: 'Fake\u0000\u0008Name' }) };
  const s = buildBrandSheet({ ...base, showNames: true, participants: [{ id: 'p', creatorId: 'a', stage: 'confirmed' }], creators: evil });
  assert.equal(s.rows[1][col(s, '크리에이터')], 'FakeName');
  assert.ok(!/[\u0000-\u0008]/.test(await partsText(s)));
});

test('empty campaign: header row only, no STANDBY', () => {
  const s = buildBrandSheet({ cp, participants: [], creators: {}, date: '2026-11-23' });
  assert.equal(s.rows.length, 1);
  assert.deepEqual(s.rows[0], s.headers);
  assert.equal(s.counts.confirmed + s.counts.standby + s.counts.rejected, 0);
  const none = buildBrandSheet({ cp, participants: [pt('g', 'contacted'), pt('f', 'dropped', { dropReason: 'Ghosted' })], creators });
  assert.equal(none.rows.length, 1);
  assert.equal(buildBrandSheet({}).rows.length, 1);
});

test('only standby creators: the STANDBY row comes straight after the header', () => {
  const s = buildBrandSheet({ ...base, participants: [pt('d', 'shortlisted')] });
  assert.equal(s.rows[1][0], 'STANDBY');
  assert.equal(s.rows.length, 3);
});

test('a participant whose creator record is missing is skipped, not a crash', () => {
  const s = buildBrandSheet({ ...base, participants: [pt('zz', 'confirmed'), pt('a', 'confirmed')] });
  assert.equal(s.rows.length, 2);
});

/* ---- fix 6: store name ---- */
test('Visiting Date text format', () => {
  assert.equal(brandSheetVisitText('2026-10-17', 'Seongsu'), 'Seongsu store: Oct 17');
  assert.equal(brandSheetVisitText('2026-10-27 17:30', 'Hongdae store'), 'Hongdae store: Oct 27 17.30');
  assert.equal(brandSheetVisitText('2026-10-27T09:05', 'Hongdae'), 'Hongdae store: Oct 27 09.05');
  assert.equal(brandSheetVisitText('2026-10-17', ''), 'Oct 17');
  assert.equal(brandSheetVisitText('', 'Seongsu'), '');
  assert.equal(brandSheetVisitText('2026-10-17', '=Seongsu'), 'Seongsu store: Oct 17');
  assert.equal(brandSheetVisitText('next Tuesday', 'Seongsu'), 'next Tuesday');
});

test('the store name comes only from stored data: the same campaign always gives the same text', () => {
  const v = (s, h) => s.rows.find((r) => r[col(s, 'Instagram')] === 'https://www.instagram.com/fake_' + h + '/')[col(s, 'Visiting Date')];
  /* nothing stored: date and time only, and a runtime store argument is ignored */
  const a1 = buildBrandSheet(base);
  const a2 = buildBrandSheet({ ...base, storeName: 'Booking-Tab-Venue' });
  assert.deepEqual(a1.rows, a2.rows);
  assert.equal(v(a1, 'a'), 'Oct 17');
  assert.equal(v(a1, 'b'), 'Oct 27 17.30');
  assert.equal(v(a1, 'c'), '', 'a requested (unconfirmed) visit is not exported');
  assert.equal(a1.counts.missingStore, 2);
  assert.ok(!all(a2).includes('Booking-Tab-Venue'));
  /* a stored store name on the creator row or the campaign is used */
  const withP = buildBrandSheet({ ...base, participants: participants.map((p) => (p.id === 'p-a' ? { ...p, storeName: 'Seongsu' } : p)) });
  assert.equal(v(withP, 'a'), 'Seongsu store: Oct 17');
  assert.equal(v(withP, 'b'), 'Oct 27 17.30');
  assert.equal(withP.counts.missingStore, 1);
  const withCp = buildBrandSheet({ ...base, cp: { ...cp, storeName: 'Hongdae' } });
  assert.equal(v(withCp, 'b'), 'Hongdae store: Oct 27 17.30');
  assert.equal(withCp.counts.missingStore, 0);
});

/* ---- fix 5: tab name ---- */
test('file name and tab name are sanitised', () => {
  const s = buildBrandSheet({ ...base, cp: { name: '../../Evil:Brand*?/ "Spring" [x]\\y & <z>' } });
  assert.match(s.filename, /^[\p{L}\p{N}._-]+_2026-11-23\.xlsx$/u);
  assert.ok(!/[\\/:*?"<>]/.test(s.filename) && !s.filename.includes('..'));
  assert.ok(!/[\[\]:*?\/\\'&<>"]/.test(s.sheetName) && s.sheetName.length <= 31);
  assert.equal(buildBrandSheet({ ...base, cp: { name: '' } }).filename, 'campaign_2026-11-23.xlsx');
  assert.equal(buildBrandSheet({ ...base, cp: { name: '캠페인 봄' } }).filename, '캠페인_봄_2026-11-23.xlsx');
});

test('tab name: control characters stripped, 31 characters at most, Excel-forbidden characters gone', () => {
  const tab = (name, mode) => (mode ? buildBrandSheet({ ...base, cp: { name }, mode, confirmInternal: true }) : buildBrandSheet({ ...base, cp: { name } })).sheetName;
  const t1 = tab('Spring\u0000\u0001\u0007\u001f\u007f\u0085 Launch\u2028x\ud83d');
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(t1), JSON.stringify(t1));
  assert.ok(t1.startsWith('Spring') && t1.includes('Launch'));
  assert.equal(tab('x'.repeat(100)).length, 31);
  assert.ok(tab('x'.repeat(100), 'internal').length <= 31 && tab('x'.repeat(100), 'internal').startsWith('INTERNAL '));
  assert.ok(!/[\[\]:*?\/\\]/.test(tab('a[b]c:d*e?f/g\\h')));
  assert.equal(tab('\u0000\u0001'), 'Campaign');
  assert.equal(tab("'''"), 'Campaign');
  assert.ok(!/^'|'$/.test(tab("'quoted'")));
  /* a pair of emoji at the cut point is never split in half */
  const cut = tab('a'.repeat(30) + '😀😀');
  assert.ok(!/[\ud800-\udbff]$/.test(cut) && cut.length <= 31);
});

test('the real xlsx file carries the headers and is a readable zip', async () => {
  const s = buildBrandSheet({ ...base, showNames: true, showNationality: true });
  const files = await unzip(await buildXlsx(s.sheetName, s.rows).arrayBuffer());
  const sheet = files['xl/worksheets/sheet1.xml'];
  s.headers.forEach((h) => assert.ok(sheet.includes(h.replace(/&/g, '&amp;')), h));
  assert.ok(sheet.includes('Oct 17'));
});

/* ---- fix 3: the export never writes the workspace ---- */
test('option helpers: only booleans, only their own key, nothing written on load', () => {
  const writes = [];
  const store = { m: {}, getItem(k) { return k in this.m ? this.m[k] : null; }, setItem(k, v) { writes.push(k); this.m[k] = String(v); } };
  assert.deepEqual(loadBrandSheetOptions(store), { showNames: false, showNationality: false, includeRejected: false });
  assert.equal(writes.length, 0);
  assert.equal(saveBrandSheetOptions(store, { showNames: true, includeRejected: 'yes', extra: S.pAddr }), true);
  assert.deepEqual(writes, [BRAND_SHEET_OPTS_KEY]);
  assert.deepEqual(loadBrandSheetOptions(store), { showNames: true, showNationality: false, includeRejected: false });
  assert.ok(!store.m[BRAND_SHEET_OPTS_KEY].includes('SENTINEL'));
  store.m[BRAND_SHEET_OPTS_KEY] = '{not json';
  assert.deepEqual(loadBrandSheetOptions(store), { showNames: false, showNationality: false, includeRejected: false });
  assert.equal(saveBrandSheetOptions({ setItem() { throw new Error('quota'); } }, {}), false);
  assert.deepEqual(loadBrandSheetOptions(null), { showNames: false, showNationality: false, includeRejected: false });
});

const fnTextOf = (src) => {
  const i = src.indexOf('function openBrandSheetExport(');
  assert.ok(i >= 0, 'openBrandSheetExport found');
  return src.slice(i, src.indexOf('\n}\n', i) + 3);
};
const viewSrc = fs.readFileSync(new URL('../src/views/campaigns.js', import.meta.url), 'utf8');
const htmlSrc = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('index.html and src/views/campaigns.js carry the same drawer code', () => {
  assert.equal(fnTextOf(htmlSrc), fnTextOf(viewSrc));
});

test('drawer code has no persist / save / SETTINGS write in it (source check)', () => {
  const body = fnTextOf(viewSrc).replace(new RegExp('/[*][^]*?[*]/', 'g'), '').replace(new RegExp('^ *//.*$', 'gm'), '');
  assert.ok(!/\bpersist\s*\(/.test(body) && !/serverSave|scheduleServerSave|scheduleSheetPush|SETTINGS/.test(body), 'no workspace write path');
  assert.ok(!/BOOKING/.test(body), 'does not depend on whether the Booking tab was opened');
});

function runDrawer(parts, extraStore) {
  const calls = { persist: 0, serverSave: 0, sheetPush: 0, settingsWrites: [], downloads: [], setItem: [], html: '' };
  const store = Object.assign({}, extraStore || {});
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { calls.setItem.push(k); store[k] = String(v); } };
  const els = {};
  const $ = (sel) => els[sel] || (els[sel] = { checked: false, style: {}, h: {}, addEventListener(t, f) { this.h[t] = f; } });
  const SETTINGS = new Proxy({}, { set(t, k, v) { calls.settingsWrites.push(k); t[k] = v; return true; } });
  const deps = {
    buildBrandSheet, loadBrandSheetOptions, saveBrandSheetOptions, $, SETTINGS,
    partsOf: () => parts, byCreator: creators, esc: (x) => String(x),
    openDrawer: (title, html) => { calls.html = html; },
    downloadXlsx: (name, rows, file) => calls.downloads.push({ name, rows, file }),
    persist: () => { calls.persist++; }, serverSave: () => { calls.serverSave++; },
    scheduleServerSave: () => { calls.serverSave++; }, scheduleSheetPush: () => { calls.sheetPush++; },
    BOOKING: { campaignId: 'cp1', schedule: { venueName: 'Booking-Tab-Venue' } },
    window: { localStorage }
  };
  const names = Object.keys(deps);
  const fn = new Function(...names, fnTextOf(viewSrc).replace(/^export /, '') + '\nreturn openBrandSheetExport;')(...names.map((n) => deps[n]));
  fn(cp);
  return { calls, els, store };
}

test('ticking boxes and downloading calls persist/save/Sheet push zero times and leaves SETTINGS alone (counting fakes)', () => {
  const { calls, els, store } = runDrawer(participants);
  els['#bsNames'].checked = true; els['#bsNames'].h.change();
  els['#bsNat'].checked = true; els['#bsNat'].h.change();
  els['#bsRej'].checked = true; els['#bsRej'].h.change();
  els['#bsDownload'].h.click();
  els['#bsInternalGo'].h.click();
  assert.equal(calls.persist, 0, 'persist called');
  assert.equal(calls.serverSave, 0, 'server save scheduled');
  assert.equal(calls.sheetPush, 0, 'Sheet push scheduled');
  assert.deepEqual(calls.settingsWrites, [], 'SETTINGS written');
  assert.equal(calls.downloads.length, 2);
  /* the only write is this browser's own option key */
  assert.ok(calls.setItem.length >= 1 && calls.setItem.every((k) => k === BRAND_SHEET_OPTS_KEY), JSON.stringify(calls.setItem));
  assert.deepEqual(Object.keys(store), [BRAND_SHEET_OPTS_KEY]);
  /* the options really were used for the download */
  const brand = calls.downloads[0];
  assert.ok(brand.rows[0].includes('크리에이터') && brand.rows[0].includes('국적'));
  assert.ok(JSON.stringify(brand.rows).includes('Rejected'), 'rejected included after the tick');
  assert.ok(!calls.downloads[0].file.startsWith('INTERNAL') && calls.downloads[1].file.startsWith('INTERNAL_'));
});

test('drawer opens with the three boxes off, rejected left out, and a missing-store notice', () => {
  const { calls, els } = runDrawer(participants);
  assert.ok(/id="bsRej"(?![^>]*checked)/.test(calls.html), 'Include rejected is unticked by default');
  assert.ok(/id="bsNames"(?![^>]*checked)/.test(calls.html) && /id="bsNat"(?![^>]*checked)/.test(calls.html));
  assert.ok(calls.html.includes('Store name missing for 2 creators'), 'notice shown');
  assert.ok(!calls.html.includes('Booking-Tab-Venue'));
  els['#bsDownload'].h.click();
  assert.ok(!JSON.stringify(calls.downloads[0].rows).includes('Rejected'));
  /* a remembered tick-box comes back ticked in the next drawer */
  const again = runDrawer(participants, { [BRAND_SHEET_OPTS_KEY]: JSON.stringify({ includeRejected: true }) });
  assert.ok(/id="bsRej"[^>]*checked/.test(again.calls.html));
  /* no notice when every visit has a stored store name */
  const named = runDrawer(participants.map((p) => ({ ...p, storeName: 'Seongsu' })));
  assert.ok(!named.calls.html.includes('Store name missing'));
});
