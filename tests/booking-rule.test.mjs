/* The weekly rule, and the one number a venue actually says out loud:
   how many times a day it will take. One sitting a night, or three.
   The times are spread across the arrival window the venue gave. */

import './helpers/browser-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultBookingRule, ruleSlotCount, ruleTimesFor, ruleWithSlotCount,
  bookingRuleSlots, bookingRuleSummary } from '../src/views/booking.js';

const ruleWith = (n, window) => {
  const r = defaultBookingRule();
  r.slotsPerDay = n;
  if (window) ['Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((d) => { r.days[d] = window.slice(); });
  return r;
};

test('a venue that takes one booking a night gets one time, not five', () => {
  const r = ruleWith(1);
  assert.deepEqual(ruleTimesFor(r, 'Tue'), ['18:30']);
  assert.equal(ruleSlotCount(r), 1);
});

test('and one is what a fresh rule starts at', () => {
  assert.equal(ruleSlotCount(defaultBookingRule()), 1);
  assert.deepEqual(ruleTimesFor(defaultBookingRule(), 'Tue'), ['18:30']);
});

test('two, three or five times a day spread across the arrival window', () => {
  assert.deepEqual(ruleTimesFor(ruleWith(2), 'Tue'), ['18:30', '19:30']);
  assert.deepEqual(ruleTimesFor(ruleWith(3), 'Tue'), ['18:30', '19:00', '19:30']);
  assert.deepEqual(ruleTimesFor(ruleWith(5), 'Tue'), ['18:30', '18:45', '19:00', '19:15', '19:30']);
});

test('the first time is when the window opens and the last when it shuts', () => {
  [2, 3, 4, 6].forEach((n) => {
    const times = ruleTimesFor(ruleWith(n, ['18:00', '21:00']), 'Tue');
    assert.equal(times[0], '18:00', n + ' slots');
    assert.equal(times[times.length - 1], '21:00', n + ' slots');
    assert.equal(times.length, n, n + ' slots');
  });
});

test('each weekday keeps its own window, and the count applies to all of them', () => {
  const r = ruleWith(3);                        /* Sun is 18:00–19:00 by default */
  assert.deepEqual(ruleTimesFor(r, 'Tue'), ['18:30', '19:00', '19:30']);
  assert.deepEqual(ruleTimesFor(r, 'Sun'), ['18:00', '18:30', '19:00']);
  assert.deepEqual(ruleTimesFor(r, 'Mon'), [], 'a closed day stays closed');
});

test('a single arrival time stays one time however many are asked for', () => {
  assert.deepEqual(ruleTimesFor(ruleWith(4, ['20:30', '20:30']), 'Tue'), ['20:30']);
});

test('a window too narrow fits fewer rather than inventing duplicates', () => {
  const times = ruleTimesFor(ruleWith(6, ['18:00', '18:10']), 'Tue');
  assert.deepEqual(times, ['18:00', '18:05', '18:10']);
  assert.equal(new Set(times).size, times.length);
});

test('the generated slots are one per time per open day', () => {
  const r = ruleWith(3);
  r.from = '2026-11-03'; r.to = '2026-11-05';   /* Tue, Wed, Thu */
  r.skipHolidays = false;
  const rows = bookingRuleSlots(r, { slotMinutes: 90 });
  assert.equal(rows.length, 9);
  assert.deepEqual(rows.filter((x) => x.date === '2026-11-03').map((x) => x.time),
    ['18:30', '19:00', '19:30']);
  assert.ok(rows.every((x) => x.capacity === 1), 'one creator per time unless told otherwise');
});

test('creators per time is a separate number from times per day', () => {
  const r = ruleWith(2);
  r.perDay = 4;
  r.from = '2026-11-03'; r.to = '2026-11-03'; r.skipHolidays = false;
  const rows = bookingRuleSlots(r, { slotMinutes: 90 });
  assert.equal(rows.length, 2, 'still two times');
  assert.ok(rows.every((x) => x.capacity === 4), 'four creators can take each of them');
});

test('the sentence says how many times a day, not how many minutes apart', () => {
  const r = ruleWith(3);
  r.from = '2026-11-03'; r.to = '2026-11-09';
  const line = bookingRuleSummary(r, {});
  assert.match(line, /3 times a day/);
  assert.match(line, /Closed Mon/);
  assert.ok(!/every \d+ min/.test(line));
  assert.match(bookingRuleSummary(ruleWith(1), {}), /1 time a day/);
});

test('and it counts what the window really fits, not what was asked for', () => {
  const r = ruleWith(6, ['18:00', '18:10']);
  assert.match(bookingRuleSummary(r, {}), /3 times a day/);
});

test('a rule written before the count existed keeps the times it had', () => {
  const old = defaultBookingRule();
  delete old.slotsPerDay;
  old.stepMinutes = 30;
  assert.deepEqual(ruleTimesFor(old, 'Tue'), ['18:30', '19:00', '19:30'], 'read as it always was');
  assert.equal(ruleSlotCount(old), null);
  const moved = ruleWithSlotCount(JSON.parse(JSON.stringify(old)));
  assert.equal(moved.slotsPerDay, 3, 'and converts to the same number of times');
  assert.deepEqual(ruleTimesFor(moved, 'Tue'), ['18:30', '19:00', '19:30']);
});

test('converting a rule with no open day at all does not crash', () => {
  const r = defaultBookingRule();
  delete r.slotsPerDay;
  Object.keys(r.days).forEach((d) => { r.days[d] = null; });
  assert.equal(ruleWithSlotCount(r).slotsPerDay, 1);
});

/* Setting several days at once. Typing the same window into five rows
   is exactly the kind of work this card exists to remove. */

test('one window goes onto Mon–Fri in a single apply', async () => {
  const { applyRuleWindow, ruleFirstWindow } = await import('../src/views/booking.js');
  const r = defaultBookingRule();                       /* Mon starts closed */
  const touched = applyRuleWindow(r, 'weekdays', '13:30', '20:30');
  assert.deepEqual(touched, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  touched.forEach((d) => assert.deepEqual(r.days[d], ['13:30', '20:30'], d));
  assert.deepEqual(r.days.Sat, ['18:30', '19:30'], 'Saturday is left alone');
  assert.deepEqual(r.days.Sun, ['18:00', '19:00'], 'and so is Sunday');
});

test('a closed day inside the group is opened, not skipped', async () => {
  const { applyRuleWindow } = await import('../src/views/booking.js');
  const r = defaultBookingRule();
  assert.equal(r.days.Mon, null);
  applyRuleWindow(r, 'weekdays', '12:00', '14:00');
  assert.deepEqual(r.days.Mon, ['12:00', '14:00'], 'Mon–Fri means five days');
});

test('"every open day" leaves the closed ones closed', async () => {
  const { applyRuleWindow } = await import('../src/views/booking.js');
  const r = defaultBookingRule();
  const touched = applyRuleWindow(r, 'open', '19:00', '20:00');
  assert.ok(!touched.includes('Mon'));
  assert.equal(r.days.Mon, null, 'a day the venue shuts stays shut');
  assert.deepEqual(r.days.Sun, ['19:00', '20:00']);
});

test('the weekend and the whole week are their own groups', async () => {
  const { applyRuleWindow } = await import('../src/views/booking.js');
  const r = defaultBookingRule();
  assert.deepEqual(applyRuleWindow(r, 'weekend', '11:00', '13:00'), ['Sat', 'Sun']);
  assert.deepEqual(r.days.Fri, ['18:30', '19:30'], 'Friday is not the weekend here');
  assert.equal(applyRuleWindow(r, 'all', '17:00', '18:00').length, 7);
  assert.ok(Object.values(r.days).every((w) => w && w[0] === '17:00'));
});

test('the group editor starts from the window already in use', async () => {
  const { ruleFirstWindow } = await import('../src/views/booking.js');
  assert.deepEqual(ruleFirstWindow(defaultBookingRule()), ['18:30', '19:30']);
  const shut = defaultBookingRule();
  Object.keys(shut.days).forEach((d) => { shut.days[d] = null; });
  assert.deepEqual(ruleFirstWindow(shut), ['18:30', '19:30'], 'a sane pair even with nothing open');
});

test('a group edit and the times-per-day count work together', async () => {
  const { applyRuleWindow } = await import('../src/views/booking.js');
  const r = defaultBookingRule();
  r.slotsPerDay = 5;
  applyRuleWindow(r, 'weekdays', '13:30', '20:30');
  assert.deepEqual(ruleTimesFor(r, 'Mon'), ['13:30', '15:15', '17:00', '18:45', '20:30']);
  assert.deepEqual(ruleTimesFor(r, 'Sun'), ['18:00', '18:15', '18:30', '18:45', '19:00'],
    'Sunday keeps its own shorter window');
});
