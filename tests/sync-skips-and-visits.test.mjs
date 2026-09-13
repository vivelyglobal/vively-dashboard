import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/* Two questions a person asked of a live campaign, and the code that now
   answers them.

   1. "One person is continuously being missed." The sync reported a bare
      "1 skipped" with two possible causes behind it — a handle it could
      not read, or a second submission from someone already on the roster
      — and no way to tell which, or who.

   2. "Tell me when the dashboard and Notion disagree about a visit."
      A time confirmed here is never touched by the sync; `visitAt` keeps
      whatever Notion still says. The two drift the moment a booking is
      moved from this side.

   Both rules are read out of the shipping index.html rather than restated
   here, so a change there fails here. */
const src = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  .match(/<script>([\s\S]*)<\/script>/)[1];

const slice = (from, to) => {
  const a = src.indexOf(from);
  assert.ok(a > -1, 'not found in index.html: ' + from);
  const b = src.indexOf(to, a);
  assert.ok(b > a, 'end not found after: ' + from);
  return src.slice(a, b);
};

/* ---------------- 1 · which row was skipped, and why ---------------- */
const noHandle = slice("    if (!ap.handle) {", "\n    let cr = findCreatorByHandle");
const runNoHandle = (mapping, properties) => {
  const box = {};
  const ctx = vm.createContext({ String, cp: { notionMapping: mapping }, ap: { handle: null },
    row: { properties }, rowIdx: 3,
    skip: (why, label) => { box.out = { why, label }; } });
  /* the block ends in `return;`, which only parses inside a function */
  vm.runInContext('(function () {\n' + noHandle + '\n})();', ctx);
  return box.out || null;
};

test('an empty Instagram cell names the column, not just the row', () => {
  const r = runNoHandle({ instagram: 'IG 주소' }, { 'IG 주소': '' });
  assert.equal(r.why, 'no-handle');
  assert.match(r.label, /row 4/);
  assert.match(r.label, /"IG 주소" is empty/);
});

test('a handle the parser could not read is quoted back verbatim', () => {
  /* the actual shape of the bug: something typed into the cell that is
     not a handle and not a URL, so handleFromUrl returns null */
  const r = runNoHandle({ instagram: 'IG' }, { IG: '인스타 없음 (DM으로 연락)' });
  assert.equal(r.why, 'no-handle');
  assert.match(r.label, /could not read a handle from/);
  assert.match(r.label, /인스타 없음/);
});

test('a form with no Instagram column mapped says so, rather than blaming the row', () => {
  const r = runNoHandle({}, {});
  assert.match(r.label, /no column is mapped to Instagram/);
});

test('a long paste is truncated so one bad cell cannot swamp the message', () => {
  const r = runNoHandle({ instagram: 'IG' }, { IG: 'x'.repeat(400) });
  assert.ok(r.label.length < 120, 'label is ' + r.label.length + ' chars');
});

const dupe = slice("      const twin = DB.participants.find((x) => x.campaignId === cp.id", "\n      const np = {");
const runDupe = (participants, cpId, crId, handle) => {
  const box = {};
  const ctx = vm.createContext({ DB: { participants }, cp: { id: cpId }, cr: { id: crId },
    ap: { handle }, skip: (why, label) => { box.out = { why, label }; } });
  vm.runInContext('(function () {\n' + dupe + '\n})();', ctx);
  return box.out || null;
};

test('a second submission from someone already on the roster says whose', () => {
  const r = runDupe([{ id: 'cp1-cr9', campaignId: 'cp1', creatorId: 'cr9' }], 'cp1', 'cr9', '@wendyaaan');
  assert.equal(r.why, 'duplicate');
  assert.match(r.label, /@wendyaaan/);
  assert.match(r.label, /already on this roster/);
});

test('a creator on a different campaign is not a duplicate here', () => {
  const r = runDupe([{ id: 'cp2-cr9', campaignId: 'cp2', creatorId: 'cr9' }], 'cp1', 'cr9', '@wendyaaan');
  assert.equal(r, null, 'it should not have been skipped');
});

test('the two reasons stay distinguishable — they need different fixes', () => {
  const a = runNoHandle({ instagram: 'IG' }, { IG: '' });
  const b = runDupe([{ id: 'x', campaignId: 'cp1', creatorId: 'cr9' }], 'cp1', 'cr9', '@a');
  assert.notEqual(a.why, b.why);
});

/* ---------------- 2 · the visit-date disagreement ---------------- */
const visit = slice('function visitSlotOf(p) {', '\nfunction visitMismatchesIn');
const vis = (() => {
  const ctx = vm.createContext({ esc: (x) => String(x), DB: { participants: [] } });
  vm.runInContext(visit + '\nthis.api = { visitSlotOf, visitSlotMoved, visitMismatchMark, visitMismatchTitle };', ctx);
  return ctx.api;
})();

test('no confirmed time means nothing to disagree about', () => {
  assert.equal(vis.visitSlotMoved({ visitAt: '2026-09-12 18:00' }), false);
  assert.equal(vis.visitMismatchMark({ visitAt: '2026-09-12 18:00' }), '');
});

test('a confirmed time equal to Notion is not a disagreement', () => {
  const p = { visitAt: '2026-09-12 18:00', confirmedVisitAt: '2026-09-12 18:00' };
  assert.equal(vis.visitSlotMoved(p), false);
  assert.equal(vis.visitMismatchMark(p), '');
});

test('a booking moved from the dashboard is flagged', () => {
  const p = { visitAt: '2026-09-12 18:00', confirmedVisitAt: '2026-09-12 19:30' };
  assert.equal(vis.visitSlotMoved(p), true);
  assert.match(vis.visitMismatchMark(p), /class="vmis"/);
});

test('the marker carries both times, so hovering answers the question', () => {
  const t = vis.visitMismatchTitle({ visitAt: '2026-09-12 18:00', confirmedVisitAt: '2026-09-12 19:30' });
  assert.match(t, /2026-09-12 18:00/);
  assert.match(t, /2026-09-12 19:30/);
  assert.match(t, /Notion/);
});

test('a creator with no Notion date at all is not flagged as a disagreement', () => {
  /* added by hand here and never in Notion — nothing to reconcile */
  assert.equal(vis.visitSlotMoved({ confirmedVisitAt: '2026-09-12 19:30' }), false);
});

test('the confirmed time is still what everything downstream reads', () => {
  assert.equal(vis.visitSlotOf({ visitAt: '18:00', confirmedVisitAt: '19:30' }), '19:30');
  assert.equal(vis.visitSlotOf({ visitAt: '18:00' }), '18:00');
});
