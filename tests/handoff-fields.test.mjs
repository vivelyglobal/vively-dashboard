/* The Report hand-off JSON goes to a brand or partner: no internal Notion or link
   fields. Fake data only. */
import './helpers/browser-shim.mjs';
import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoffCampaign } from '../src/views/report.js';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const cp = () => ({
  id: 'c1', brand: 'Fake Brand', name: 'Fake Campaign', kind: 'Seeding', category: 'Beauty', market: 'US', status: 'Live',
  start: '2026-01-01', end: '2026-02-01', targetCreators: 5, minFollowers: 1000, platforms: ['TikTok'], deliverables: '1 reel',
  budget: 1000, productCostPer: 10, adSpend: 5, hashtags: ['#fake'], owner: 'Fake Owner', note: 'fake note', createdAt: '2026-01-01',
  fulfilment: 'ship', importedFrom: 'notion', storeName: 'Fake Store',
  sheetUrl: 'https://docs.google.com/spreadsheets/d/fake', guidelineUrl: 'https://notion.so/fake',
  notionPageId: 'SENT_PAGE', notionMapping: { name: 'SENT_MAP' }, notionDatabaseId: 'SENT_DB', notionAutoLinked: true,
  notionSyncedAt: '2026-01-02', notionDescription: 'SENT_DESC', notionSomethingNew: 'SENT_FUTURE',
  clientId: 'SENT_CLIENT', partner: { slug: 'SENT_PARTNER' }, source: 'notion-auto'
});

test('hand-off campaign drops every internal Notion / link field', () => {
  const src = cp(); const out = handoffCampaign(src);
  for (const k of ['sheetUrl', 'guidelineUrl', 'clientId', 'partner', 'source', 'notionPageId', 'notionMapping', 'notionDatabaseId',
    'notionAutoLinked', 'notionSyncedAt', 'notionDescription', 'notionSomethingNew']) assert.ok(!(k in out), k + ' leaked');
  assert.ok(!JSON.stringify(out).includes('SENT_'), 'no sentinel value in the JSON');
  assert.ok('notionPageId' in src && 'partner' in src, 'the original is not changed');
});

test('hand-off campaign still carries the business fields (pre-existing, listed in the report)', () => {
  const out = handoffCampaign(cp());
  assert.deepEqual(Object.keys(out), ['id', 'brand', 'name', 'kind', 'category', 'market', 'status', 'start', 'end', 'targetCreators',
    'minFollowers', 'platforms', 'deliverables', 'budget', 'productCostPer', 'adSpend', 'hashtags', 'owner', 'note', 'createdAt',
    'fulfilment', 'importedFrom', 'storeName']);
});

test('index.html carries the same hand-off function', () => {
  assert.ok(html.includes("const HANDOFF_STRIP = ['sheetUrl', 'guidelineUrl', 'clientId', 'partner', 'source'];"));
  assert.ok(html.includes("k.indexOf('notion') !== 0"));
});
