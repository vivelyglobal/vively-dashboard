import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  .match(/<script>([\s\S]*)<\/script>/)[1];

/* The four slot helpers, lifted out of the page and run on their own. */
const slotSrc = src.slice(src.indexOf('function parseVisitSlot(v)'),
                          src.indexOf('function notionMetricValue(v)'));
const ctx = vm.createContext({ Date, String, RegExp, isNaN });
vm.runInContext(slotSrc +
  '\nthis.visitSlotOf = visitSlotOf; this.visitSlotMoved = visitSlotMoved;' +
  '\nthis.splitSlot = splitSlot; this.joinSlot = joinSlot;' +
  '\nthis.parseVisitSlot = parseVisitSlot;', ctx);
const { visitSlotOf, visitSlotMoved, splitSlot, joinSlot, parseVisitSlot } = ctx;

/* ---- which slot the rest of the app acts on ---------------------------- */

test('with nothing confirmed, the form answer is the booking', () => {
  assert.equal(visitSlotOf({ visitAt: '2026-09-05 19:00' }), '2026-09-05 19:00');
});

test('a confirmed slot beats what they asked for', () => {
  assert.equal(visitSlotOf({ visitAt: '2026-09-05 19:00', confirmedVisitAt: '2026-09-06 12:30' }),
    '2026-09-06 12:30');
});

test('a confirmed slot stands on its own when the form said nothing', () => {
  assert.equal(visitSlotOf({ confirmedVisitAt: '2026-09-06' }), '2026-09-06');
});

test('a row with neither yields an empty string, not undefined', () => {
  assert.equal(visitSlotOf({}), '');
  assert.equal(visitSlotOf(null), '');
});

test('the two agreeing is not a move', () => {
  assert.equal(visitSlotMoved({ visitAt: '2026-09-05', confirmedVisitAt: '2026-09-05' }), false);
  assert.equal(visitSlotMoved({ visitAt: '2026-09-05', confirmedVisitAt: '2026-09-07' }), true);
  assert.equal(visitSlotMoved({ confirmedVisitAt: '2026-09-07' }), false, 'nothing to move from');
});

/* ---- the round trip through the two form inputs ------------------------ */

test('a slot splits into the date and time inputs and comes back whole', () => {
  for (const raw of ['2026-09-05 19:00', '2026-09-05', '2026-12-31 09:05']) {
    const { date, time } = splitSlot(raw);
    assert.equal(joinSlot(date, time), raw, raw);
  }
});

test('a single-digit hour survives the trip as 24-hour time', () => {
  const { date, time } = splitSlot('2026-09-05 9:30');
  assert.equal(time, '09:30');
  assert.equal(joinSlot(date, time), '2026-09-05 09:30');
});

test('a date with no time stays a date, and is not pushed to midnight', () => {
  assert.equal(splitSlot('2026-09-05').time, '');
  assert.equal(joinSlot('2026-09-05', ''), '2026-09-05');
  /* midnight here would put a real 00:00 booking on the calendar */
  assert.ok(!/00:00/.test(joinSlot('2026-09-05', '')));
});

test('a time with no date is not a slot and is dropped', () => {
  assert.equal(joinSlot('', '19:00'), '');
  assert.equal(joinSlot('not a date', '19:00'), '');
});

test('an unreadable stored value clears both inputs rather than half-filling them', () => {
  /* compared field by field: the object is built inside the vm context, so
     its prototype is not this realm's Object and deepEqual would object to
     that rather than to anything about the value */
  for (const raw of ['next tuesday-ish', '', undefined, '05/09/2026']) {
    const { date, time } = splitSlot(raw);
    assert.equal(date, '', String(raw));
    assert.equal(time, '', String(raw));
  }
});

/* ---- and what the calendar then reads --------------------------------- */

test('a confirmed slot parses to the wall-clock time someone typed', () => {
  const d = parseVisitSlot(visitSlotOf({ visitAt: '2026-09-05 19:00', confirmedVisitAt: '2026-09-06 12:30' }));
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 6);
  assert.equal(d.getHours(), 12);
  assert.equal(d.getMinutes(), 30);
});
