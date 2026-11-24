/* Google Sheet mirror PULL must not drop fields the Sheet has no column for.
   Fake data only. No network: fetch is a stub that answers the Sheet call and
   rejects anything else. No browser, so toast/visuals are stand-ins. */
import './helpers/browser-shim.mjs';
import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../src/sync/sheets.js';
import { DB, byCampaign, byCreator } from '../src/model/db.js';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const NOTION_ID = '01234567-89ab-cdef-0123-456789abcdef';
const SHEET_URL = 'https://sheet.test/exec';

const camp = (over) => Object.assign({
  id: 'c1', brand: 'Fake Brand', name: 'Fake Campaign', status: 'Live', budget: 100, platforms: ['TikTok'],
  sheetUrl: 'https://docs.google.com/spreadsheets/d/fake', guidelineUrl: '',
  notionPageId: NOTION_ID, notionAutoLinked: true, source: 'notion-auto',
  notionMapping: { name: 'Handle', nested: { a: 1 } }, clientId: 'cl_9', partner: { slug: 'fake-partner' }
}, over || {});
const NON_SCHEMA = ['notionPageId', 'notionAutoLinked', 'source', 'notionMapping', 'clientId', 'partner'];

function install(camps, creators, parts) {
  DB.campaigns = camps || []; DB.creators = creators || []; DB.participants = parts || [];
  Object.keys(byCampaign).forEach((k) => delete byCampaign[k]);
  Object.keys(byCreator).forEach((k) => delete byCreator[k]);
}
const gridOf = (name) => S.entityToGrid(name);
const grids = () => ({ campaigns: gridOf('campaigns'), creators: gridOf('creators'), participants: gridOf('participants') });
function setCell(grid, row, col, v) { grid[row][grid[0].indexOf(col)] = v; }

/* run the real sheetPull against a stubbed Sheet */
async function pullWith(g) {
  const calls = [];
  const toasts = [];
  const fakeEl = { setAttribute() {}, classList: { add() {}, remove() {} }, set textContent(v) { toasts.push(v); }, set innerHTML(v) {} };
  globalThis.document.querySelector = () => fakeEl;
  globalThis.confirm = () => true;
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url !== SHEET_URL) throw new Error('unexpected network call ' + url);
    return { ok: true, text: async () => JSON.stringify({ ok: true, revision: 7, data: g }) };
  };
  S.SYNC.url = SHEET_URL; S.SYNC.secret = 'fake'; S.SYNC.auto = false;
  await S.sheetPull({});
  assert.ok(calls.length >= 1 && calls.every((u) => u === SHEET_URL), 'only the stubbed Sheet endpoint was called');
  return toasts;
}

test('a pull that changes a schema field keeps every non-schema campaign field and the sheetUrl', async () => {
  install([camp()]);
  const g = grids();
  setCell(g.campaigns, 1, 'name', 'Renamed In Sheet');
  const toasts = await pullWith(g);
  const c = DB.campaigns[0];
  assert.equal(c.name, 'Renamed In Sheet', 'schema field from the sheet wins');
  assert.equal(c.notionPageId, NOTION_ID);
  assert.equal(c.notionAutoLinked, true);
  assert.equal(c.source, 'notion-auto');
  assert.deepEqual(c.notionMapping, { name: 'Handle', nested: { a: 1 } });
  assert.equal(c.clientId, 'cl_9');
  assert.deepEqual(c.partner, { slug: 'fake-partner' });
  assert.equal(c.sheetUrl, 'https://docs.google.com/spreadsheets/d/fake');
  assert.equal(byCampaign.c1, c, 'lookup table points at the merged campaign');
  assert.ok(toasts.some((t) => /Pulled 1 campaigns/.test(t) && /kept 6 fields the sheet does not carry/.test(t)), JSON.stringify(toasts));
});

test('a sheet-only campaign is still created from the schema columns', async () => {
  install([camp()]);
  const g = grids();
  g.campaigns.push(g.campaigns[0].map((h) => (h === 'id' ? 'c2' : h === 'name' ? 'Sheet Only' : '')));
  await pullWith(g);
  assert.equal(DB.campaigns.length, 2);
  const n = DB.campaigns.find((c) => c.id === 'c2');
  assert.equal(n.name, 'Sheet Only');
  for (const k of NON_SCHEMA) assert.ok(!(k in n), k + ' not invented');
});

test('no field is resurrected when the sheet intentionally blanks a schema field', async () => {
  install([camp({ note: 'old note', sheetUrl: 'https://docs.google.com/x', budget: 500, platforms: ['TikTok', 'Instagram'] })]);
  const g = grids();
  for (const col of ['note', 'sheetUrl', 'budget', 'platforms']) setCell(g.campaigns, 1, col, '');
  await pullWith(g);
  const c = DB.campaigns[0];
  assert.equal(c.note, ''); assert.equal(c.sheetUrl, ''); assert.equal(c.budget, null); assert.deepEqual(c.platforms, []);
  assert.equal(c.notionPageId, NOTION_ID, 'non-schema still kept');
});

test('a campaign missing from the sheet is dropped (unchanged behaviour) and so is its extra data', async () => {
  install([camp(), camp({ id: 'c3', name: 'Gone', notionPageId: 'x' })]);
  const g = grids();
  g.campaigns.splice(2, 1);
  await pullWith(g);
  assert.deepEqual(DB.campaigns.map((c) => c.id), ['c1']);
});

test('creators and participants: non-schema fields survive, content is merged, schema content blanks win', async () => {
  const cr = { id: 'r1', handle: '@fake', name: 'Fake Creator', followers: 10, internalScore: 42, avatarHue: 'x' };
  const p1 = { id: 'p1', campaignId: 'c1', creatorId: 'r1', stage: 'Posted', fee: 5, notionRowHash: 'abc', extra: { k: [1, 2] },
    content: { url: 'https://example.test/v', platform: 'TikTok', views: 100, likes: 5, shares: 3, thumbTint: 'old', viral: true, customTag: 'keep-me' } };
  const p2 = { id: 'p2', campaignId: 'c1', creatorId: 'r1', stage: 'Applied', localOnly: true, content: null };
  install([camp()], [cr], [p1, p2]);
  const g = grids();
  setCell(g.creators, 1, 'followers', '999');
  setCell(g.participants, 1, 'stage', 'Approved');
  setCell(g.participants, 1, 'content.likes', ''); /* sheet blanks likes */
  const toasts = await pullWith(g);
  const r = DB.creators[0];
  assert.equal(r.followers, 999); assert.equal(r.internalScore, 42); assert.equal(r.avatarHue, 'x');
  const a = DB.participants[0], b = DB.participants[1];
  assert.equal(a.stage, 'Approved'); assert.equal(a.notionRowHash, 'abc'); assert.deepEqual(a.extra, { k: [1, 2] });
  assert.equal(a.content.url, 'https://example.test/v');
  assert.equal(a.content.likes, 0, 'blanked schema content field is not resurrected (0 default as before)');
  assert.equal(a.content.customTag, 'keep-me');
  assert.equal(a.content.viral, false, 'pull-derived viral reset as before');
  assert.notEqual(a.content.thumbTint, 'old');
  assert.equal(b.localOnly, true); assert.equal(b.content, null);
  /* campaign 6 + creator 2 + p1 top-level 2 (notionRowHash, extra) + p1 content 1 (customTag) + p2 1 = 12 */
  assert.ok(toasts.some((t) => /kept 12 fields the sheet does not carry/.test(t)), JSON.stringify(toasts));
});

test('sheet blanks the post: content becomes null as before', async () => {
  install([camp()], [], [{ id: 'p1', campaignId: 'c1', creatorId: 'r1', content: { url: 'https://e.test', views: 9, customTag: 't' } }]);
  const g = grids();
  for (const c of g.participants[0].slice()) if (c.startsWith('content.')) setCell(g.participants, 1, c, '');
  await pullWith(g);
  assert.equal(DB.participants[0].content, null);
});

test('a sheet without the content columns leaves existing content alone', () => {
  const old = [{ id: 'p1', content: { url: 'https://e.test', views: 9 } }];
  const header = ['id', 'stage'];
  const pulled = S.gridToEntity('participants', [header, ['p1', 'Posted']]);
  const m = S.mergePulled('participants', pulled, old, header);
  assert.deepEqual(m.list[0].content, { url: 'https://e.test', views: 9 });
});

test('no kept-fields note when nothing extra is held', async () => {
  install([{ id: 'c1', name: 'Plain', brand: 'B' }]);
  const toasts = await pullWith(grids());
  assert.ok(toasts.some((t) => /^Pulled 1 campaigns and 0 creators from the Sheet$/.test(t)), JSON.stringify(toasts));
});

test('sheet layout unchanged: no Notion/ID field became a column', () => {
  const header = gridOf('campaigns')[0];
  for (const k of NON_SCHEMA) assert.ok(!header.includes(k), k + ' must not become a sheet column');
  assert.equal(S.SHEET_SCHEMA.campaigns.length, 28);
  assert.equal(S.SHEET_SCHEMA.creators.length, 29);
  assert.equal(S.SHEET_SCHEMA.participants.length, 45);
});

test('index.html (production) carries the same merge and the toast note', () => {
  assert.ok(html.includes('function mergePulled(name, pulled, existing, header)'));
  assert.ok(html.includes("mergePulled('campaigns'") && html.includes("mergePulled('creators'") && html.includes("mergePulled('participants'"));
  assert.ok(html.includes('fields the sheet does not carry'));
  const src = fs.readFileSync(new URL('../src/sync/sheets.js', import.meta.url), 'utf8');
  const body = (t) => t.slice(t.indexOf('function mergePulled'), t.indexOf('/* ------------------------------ transport'));
  assert.equal(body(html).replace(/^export /gm, ''), body(src).replace(/^export /gm, ''));
});
