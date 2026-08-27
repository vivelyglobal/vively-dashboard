import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/* The calendar code lives inside index.html. Rather than copy it here and
   test a copy, this pulls the real functions out of the real file. */
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const start = script.indexOf('function tzOffsetMinutes');
const end = script.indexOf('const campaignTimeZone');
const src = script.slice(start, script.indexOf('\n', end));

const ctx = vm.createContext({ Intl, Date, Math, String, Number, console,
  GCAL_PREFS: { defaultTz: 'Asia/Seoul', visitMinutes: 90 } });
vm.runInContext(src + '\nthis.api = { tzOffsetMinutes, wallClockToRfc3339, slotToRange, pad2 };', ctx);
const { tzOffsetMinutes, wallClockToRfc3339, slotToRange } = ctx.api;

test('Seoul times keep their wall-clock hour', () => {
  assert.equal(wallClockToRfc3339(2026, 9, 4, 19, 0, 'Asia/Seoul'), '2026-09-04T19:00:00+09:00');
  assert.equal(wallClockToRfc3339(2026, 1, 15, 9, 30, 'Asia/Seoul'), '2026-01-15T09:30:00+09:00');
});

test('a zone with daylight saving uses the offset for THAT date', () => {
  /* the bug this guards: reading today's offset and applying it to a
     booking six months away, which is wrong for half the year */
  const winter = wallClockToRfc3339(2026, 1, 15, 14, 0, 'America/Los_Angeles');
  const summer = wallClockToRfc3339(2026, 7, 15, 14, 0, 'America/Los_Angeles');
  assert.equal(winter, '2026-01-15T14:00:00-08:00');
  assert.equal(summer, '2026-07-15T14:00:00-07:00');
  /* both still read as 2pm locally, which is the whole point */
  assert.ok(winter.startsWith('2026-01-15T14:00'));
  assert.ok(summer.startsWith('2026-07-15T14:00'));
});

test('an hour that does not exist still produces a real instant', () => {
  /* 2:30am on a spring-forward morning is skipped by the clock */
  const v = wallClockToRfc3339(2026, 3, 8, 2, 30, 'America/Los_Angeles');
  assert.ok(v, 'should not return null');
  assert.ok(!isNaN(new Date(v).getTime()));
});

test('an unknown timezone is reported, not guessed', () => {
  assert.equal(tzOffsetMinutes(Date.now(), 'Mars/Olympus'), null);
  assert.equal(wallClockToRfc3339(2026, 9, 4, 19, 0, 'Mars/Olympus'), null);
});

test('a slot with no end time gets the configured length', () => {
  const r = slotToRange('2026-09-04 19:00', 'Asia/Seoul', 90);
  assert.equal(r.start, '2026-09-04T19:00:00+09:00');
  assert.equal(r.end, '2026-09-04T20:30:00+09:00');
  assert.equal(r.hasTime, true);
});

test('a slot that runs past midnight rolls into the next day', () => {
  const r = slotToRange('2026-09-04 23:30', 'Asia/Seoul', 90);
  assert.equal(r.start, '2026-09-04T23:30:00+09:00');
  assert.equal(r.end, '2026-09-05T01:00:00+09:00');
});

test('a date with no time becomes a sensible daytime block', () => {
  const r = slotToRange('2026-09-04', 'Asia/Seoul', 90);
  assert.equal(r.hasTime, false);
  assert.equal(r.start, '2026-09-04T10:00:00+09:00');
});

test('an explicit end wins over the default length', () => {
  const r = slotToRange('2026-09-04 10:00', 'Asia/Seoul', 90, '2026-09-06 18:00');
  assert.equal(r.start, '2026-09-04T10:00:00+09:00');
  assert.equal(r.end, '2026-09-06T18:00:00+09:00');
});

test('rubbish in the slot returns nothing rather than a wrong date', () => {
  assert.equal(slotToRange('next tuesday-ish', 'Asia/Seoul', 90), null);
  assert.equal(slotToRange('', 'Asia/Seoul', 90), null);
});
