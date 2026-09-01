import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/* The rules that decide what, if anything, gets written to Notion when a
   creator is moved between stages. Pulled out of the real index.html. */
const src = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  .match(/<script>([\s\S]*)<\/script>/)[1];
const body = src.slice(src.indexOf('const STAGE_TO_NOTION = {'),
                       src.indexOf('const WRITEBACK_KEY'));
const ctx = vm.createContext({ Object, String, console });
vm.runInContext(body + '\nthis.api = { STAGE_TO_NOTION, notionValueForStage, notionValueForDrop, notionStatusProperty };', ctx);
const { STAGE_TO_NOTION, notionValueForStage, notionValueForDrop, notionStatusProperty } = ctx.api;

/* the option list from the real Sushikoji form */
const REAL_OPTIONS = ['Waiting Approval', 'Confirmed', 'Brand Rejected', 'Brand Accepted',
                      'Declined', 'Re-Schedule', 'Waiting Upload', 'Cancelled', 'Uploaded'];

test('every value this would write is one Notion actually offers', () => {
  const written = new Set();
  ['shortlisted', 'confirmed', 'shipped', 'submitted', 'review', 'live'].forEach((st) =>
    written.add(notionValueForStage({}, st)));
  ['Brand rejected', 'Cancelled', 'Ghosted', 'No show', null].forEach((why) =>
    written.add(notionValueForStage({ dropReason: why }, 'dropped')));
  written.forEach((v) =>
    assert.ok(REAL_OPTIONS.includes(v), `"${v}" is not an option on the form — Notion would reject it`));
});

test('stages Notion has no word for write nothing', () => {
  ['sourced', 'contacted', 'replied'].forEach((st) =>
    assert.equal(notionValueForStage({}, st), null, st + ' should not be written'));
});

test('a drop says WHY, because Notion distinguishes three kinds', () => {
  assert.equal(notionValueForDrop({ dropReason: 'Brand rejected' }), 'Brand Rejected');
  assert.equal(notionValueForDrop({ dropReason: 'Cancelled' }), 'Cancelled');
  assert.equal(notionValueForDrop({ dropReason: 'Ghosted' }), 'Declined');
  assert.equal(notionValueForDrop({}), 'Declined');
});

test('the status column is found from the campaign mapping', () => {
  assert.equal(notionStatusProperty({ notionMapping: { 'Full Name ': 'fullName', 'Status': 'status' } }), 'Status');
  assert.equal(notionStatusProperty({ notionMapping: { 'Full Name ': 'fullName' } }), null);
  assert.equal(notionStatusProperty({}), null);
});

/* --- the round trip, which is where a two-way sync usually goes wrong ---
   Writing a value and then reading it back must not move the creator. */
const excelSrc = src.slice(src.indexOf('const STATUS_MAP = {'), src.indexOf('const TEMPLATES'));
const sctx = vm.createContext({});
vm.runInContext(excelSrc + '\nthis.map = STATUS_MAP;', sctx);
const STATUS_MAP = sctx.map;
const stagesSrc = src.slice(src.indexOf('const STAGES = ['), src.indexOf('const stageOf'));
const gctx = vm.createContext({ Object });
vm.runInContext(stagesSrc + '\nthis.idx = STAGE_IDX;', gctx);
const STAGE_IDX = gctx.idx;

test('writing a stage then reading it back never drags a creator backwards', () => {
  Object.keys(STAGE_TO_NOTION).forEach((stage) => {
    const wrote = STAGE_TO_NOTION[stage];
    const readsAs = (STATUS_MAP[wrote.toLowerCase()] || {}).stage;
    assert.ok(readsAs, `"${wrote}" is written but the importer cannot read it back`);
    /* the sync only moves a creator forward, so a read that lands on the
       same or an earlier stage is harmless; one that lands LATER would
       silently promote them, which is not */
    assert.ok(STAGE_IDX[readsAs] <= STAGE_IDX[stage],
      `${stage} -> "${wrote}" -> ${readsAs} would move the creator forward on its own`);
  });
});

test('the three that share Waiting Upload read back as the earliest of them', () => {
  /* documented because it looks like a bug until you know the sync is
     forward-only: Content in stays Content in, it is not pulled to Shipped */
  assert.equal(STAGE_TO_NOTION.shipped, 'Waiting Upload');
  assert.equal(STAGE_TO_NOTION.submitted, 'Waiting Upload');
  assert.equal(STAGE_TO_NOTION.review, 'Waiting Upload');
  assert.equal((STATUS_MAP['waiting upload'] || {}).stage, 'shipped');
  assert.ok(STAGE_IDX.shipped < STAGE_IDX.submitted);
});
