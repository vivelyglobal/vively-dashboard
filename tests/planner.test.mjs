/* The planner: the queue, the visits, the posts and the clashes.

   Everything here is the arithmetic the tab shows as a number, so each
   test is a sentence somebody says out loud — "nobody has posted and the
   visit was nine days ago" — rather than a shape check. */

import './helpers/browser-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  daysWaiting, attendanceOf, setAttendance, postedState, plannerBuckets,
  plannerSummary, plannerConflicts, daySheetText
} from '../src/views/planner.js';
import { BOOKING } from '../src/views/booking.js';
import { DB, byCampaign, byCreator } from '../src/model/db.js';
import { TODAY, DAY, iso } from '../src/lib/dates.js';

const day = (n) => iso(new Date(TODAY.getTime() + n * DAY));
const slot = (n, t) => day(n) + (t ? ' ' + t : '');

function seed() {
  DB.creators.length = 0; DB.campaigns.length = 0; DB.participants.length = 0; DB.socialContent.length = 0;
  Object.keys(byCreator).forEach((k) => delete byCreator[k]);
  Object.keys(byCampaign).forEach((k) => delete byCampaign[k]);
  BOOKING.campaignId = null; BOOKING.schedule = null; BOOKING.slots = []; BOOKING.at = null;

  const cr = (id, handle, extra) => Object.assign({ id, handle, name: handle.slice(1), platform: 'Instagram',
    followers: 10000, er: 3, avgViews: 5000, categories: [], country: 'Korea', flag: null, flagReason: '',
    campaignsDone: 0, tags: [] }, extra || {});
  DB.creators.push(
    cr('cr1', '@minji', { campaignsDone: 3 }),
    cr('cr2', '@jiwoo', { flag: 'blocked', flagReason: 'no-show in June' }),
    cr('cr3', '@seoyeon', { flag: 'caution', flagReason: 'late twice' }),
    cr('cr4', '@hana'), cr('cr5', '@dohyun')
  );
  DB.creators.forEach((c) => (byCreator[c.id] = c));
  DB.campaigns.push(
    { id: 'cpK', brand: 'Sushikoji', name: 'counter visit', targetCreators: 6, deliverables: '1 Reel', status: 'live' },
    { id: 'cpJ', brand: 'Jaimdang', name: 'autumn', targetCreators: 4, status: 'live' }
  );
  DB.campaigns.forEach((c) => (byCampaign[c.id] = c));
}

const part = (o) => { const p = Object.assign({ campaignId: 'cpK', stage: 'sourced', headcount: '', content: null }, o); DB.participants.push(p); return p; };

/* ---- how long has somebody been waiting ---- */

test('waiting time comes from when they applied, then from first contact, then nowhere', () => {
  assert.equal(daysWaiting({ appliedAt: day(-3) }), 3);
  assert.equal(daysWaiting({ contactedAt: day(-10) }), 10);
  assert.equal(daysWaiting({ appliedAt: day(-1), contactedAt: day(-9) }), 1, 'applied wins over contacted');
  assert.equal(daysWaiting({}), null);
  assert.equal(daysWaiting({ appliedAt: 'not a date' }), null);
  assert.equal(daysWaiting({ appliedAt: day(0) }), 0);
});

/* ---- which list somebody is in ---- */

test('the three lists are the three questions, and the queue is oldest first', () => {
  seed();
  part({ id: 'p1', creatorId: 'cr1', stage: 'sourced', appliedAt: day(-1) });
  part({ id: 'p2', creatorId: 'cr4', stage: 'replied', appliedAt: day(-6) });
  part({ id: 'p3', creatorId: 'cr5', stage: 'shortlisted', appliedAt: day(-2) });
  part({ id: 'p4', creatorId: 'cr3', stage: 'confirmed', confirmedVisitAt: slot(2, '12:00') });
  part({ id: 'p5', creatorId: 'cr2', stage: 'dropped' });
  const b = plannerBuckets(byCampaign.cpK);
  assert.deepEqual(b.waiting.map((r) => r.p.id), ['p2', 'p1'], 'six days waiting comes before one');
  assert.deepEqual(b.shortlisted.map((r) => r.p.id), ['p3']);
  assert.deepEqual(b.confirmed.map((r) => r.p.id), ['p4']);
  assert.deepEqual(b.declined.map((r) => r.p.id), ['p5']);
});

test('a confirmed creator who has already shipped or posted is still confirmed', () => {
  seed();
  ['confirmed', 'shipped', 'submitted', 'review', 'live'].forEach((stage, i) =>
    part({ id: 'p' + i, creatorId: 'cr1', stage }));
  assert.equal(plannerBuckets(byCampaign.cpK).confirmed.length, 5);
});

test('confirmed rows read in visit order, with the undated ones last', () => {
  seed();
  part({ id: 'late', creatorId: 'cr1', stage: 'confirmed', confirmedVisitAt: slot(5, '12:00') });
  part({ id: 'none', creatorId: 'cr4', stage: 'confirmed' });
  part({ id: 'soon', creatorId: 'cr5', stage: 'confirmed', confirmedVisitAt: slot(1, '18:00') });
  assert.deepEqual(plannerBuckets(byCampaign.cpK).confirmed.map((r) => r.p.id), ['soon', 'late', 'none']);
});

/* ---- did they post ---- */

test('a post is late by the visit date, not by the day they were confirmed', () => {
  assert.equal(postedState({ confirmedVisitAt: slot(3) }).state, 'upcoming');
  assert.equal(postedState({ confirmedVisitAt: slot(-2) }).state, 'due');
  assert.equal(postedState({ confirmedVisitAt: slot(-9) }).state, 'overdue');
  assert.match(postedState({ confirmedVisitAt: slot(-9) }).label, /9d since the visit/);
  assert.equal(postedState({ stage: 'confirmed' }).state, 'no_date');
});

test('a posted visit says how long it took', () => {
  const p = { confirmedVisitAt: slot(-5), content: { url: 'https://instagram.com/reel/A', publishedAt: day(-3) } };
  const s = postedState(p);
  assert.equal(s.state, 'posted');
  assert.equal(s.lag, 2);
  assert.equal(s.label, 'Posted 2d after');
});

test('a no-show is not an overdue post', () => {
  const p = { confirmedVisitAt: slot(-9), attendance: 'no_show' };
  assert.equal(postedState(p).state, 'no_show');
});

/* ---- attendance ---- */

test('attendance is typed by a person and can be taken back', () => {
  const p = { id: 'x' };
  setAttendance(p, 'attended');
  assert.equal(attendanceOf(p), 'attended');
  assert.ok(p.attendanceAt);
  setAttendance(p, 'no_show');
  assert.equal(attendanceOf(p), 'no_show');
  setAttendance(p, 'no_show');
  assert.equal(attendanceOf(p), '', 'pressing the same button again clears it');
});

/* ---- the five numbers ---- */

test('the summary answers the five questions the header asks', () => {
  seed();
  part({ id: 'w1', creatorId: 'cr1', stage: 'sourced', appliedAt: day(-6) });
  part({ id: 'w2', creatorId: 'cr4', stage: 'sourced', appliedAt: day(-1) });
  part({ id: 'c1', creatorId: 'cr5', stage: 'confirmed', confirmedVisitAt: slot(2, '12:00') });
  part({ id: 'c2', creatorId: 'cr3', stage: 'confirmed', confirmedVisitAt: slot(-9, '12:00') });   /* overdue */
  part({ id: 'c3', creatorId: 'cr1', stage: 'live', confirmedVisitAt: slot(-4, '12:00'),
         content: { url: 'https://instagram.com/reel/B', publishedAt: day(-3) } });
  part({ id: 'c4', creatorId: 'cr2', stage: 'confirmed' });                                        /* no date, blacklisted */
  const s = plannerSummary(byCampaign.cpK);
  assert.equal(s.waiting, 2);
  assert.equal(s.oldest, 6);
  assert.equal(s.confirmed, 4);
  assert.equal(s.target, 6);
  assert.equal(s.noDate, 1);
  assert.equal(s.thisWeek, 1, 'only the visit in the next seven days counts');
  assert.equal(s.posted, 1);
  assert.equal(s.overdue, 1);
  assert.equal(s.flagged, 2, 'one blacklisted and one caution');
  assert.equal(s.attention, 3, 'one overdue + one undated + one blacklisted');
});

test('an empty campaign reports zeroes rather than breaking', () => {
  seed();
  const s = plannerSummary(byCampaign.cpK);
  assert.deepEqual([s.waiting, s.confirmed, s.posted, s.overdue, s.attention], [0, 0, 0, 0, 0]);
  assert.equal(s.oldest, 0);
});

/* ---- the clashes ---- */

test('a creator booked on two campaigns the same day is a clash', () => {
  seed();
  part({ id: 'k1', creatorId: 'cr1', stage: 'confirmed', confirmedVisitAt: slot(3, '12:00') });
  part({ id: 'j1', campaignId: 'cpJ', creatorId: 'cr1', stage: 'confirmed', confirmedVisitAt: slot(3, '19:00') });
  const c = plannerConflicts(byCampaign.cpK);
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'double');
  assert.match(c[0].text, /@minji is also booked on Jaimdang/);
});

test('a dropped row elsewhere is not a clash, and neither is another day', () => {
  seed();
  part({ id: 'k1', creatorId: 'cr1', stage: 'confirmed', confirmedVisitAt: slot(3, '12:00') });
  part({ id: 'j1', campaignId: 'cpJ', creatorId: 'cr1', stage: 'dropped', confirmedVisitAt: slot(3, '19:00') });
  part({ id: 'j2', campaignId: 'cpJ', creatorId: 'cr1', stage: 'confirmed', confirmedVisitAt: slot(4, '19:00') });
  assert.deepEqual(plannerConflicts(byCampaign.cpK), []);
});

test('a visit on a day the campaign blocked is a clash', () => {
  seed();
  part({ id: 'k1', creatorId: 'cr1', stage: 'confirmed', confirmedVisitAt: slot(3, '12:00') });
  BOOKING.campaignId = 'cpK';
  BOOKING.schedule = { closedDates: [day(3)] };
  const c = plannerConflicts(byCampaign.cpK);
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'blocked');
});

test('more heads than seats in one sitting is a clash', () => {
  seed();
  part({ id: 'k1', creatorId: 'cr1', stage: 'confirmed', confirmedVisitAt: slot(3, '12:00'), headcount: '2' });
  part({ id: 'k2', creatorId: 'cr4', stage: 'confirmed', confirmedVisitAt: slot(3, '12:00'), headcount: '2' });
  BOOKING.campaignId = 'cpK';
  BOOKING.schedule = { closedDates: [] };
  BOOKING.slots = [{ date: day(3), time: '12:00', capacity: 3, booked: 3 }];
  const c = plannerConflicts(byCampaign.cpK);
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'over');
  assert.match(c[0].text, /4 people in 3 seats/);
});

test('booking data for another campaign is never read into this one', () => {
  seed();
  part({ id: 'k1', creatorId: 'cr1', stage: 'confirmed', confirmedVisitAt: slot(3, '12:00') });
  BOOKING.campaignId = 'cpJ';
  BOOKING.schedule = { closedDates: [day(3)] };
  assert.deepEqual(plannerConflicts(byCampaign.cpK), []);
});

/* ---- the venue's sheet ---- */

test('the day sheet is the list the restaurant needs, in Korean', () => {
  seed();
  part({ id: 'k1', creatorId: 'cr1', stage: 'confirmed', confirmedVisitAt: slot(1, '12:00'),
         headcount: '2', fullName: '김민지', remark: '알레르기: 새우' });
  part({ id: 'k2', creatorId: 'cr4', stage: 'confirmed', confirmedVisitAt: slot(1, '18:30'), headcount: '1' });
  part({ id: 'k3', creatorId: 'cr5', stage: 'confirmed', confirmedVisitAt: slot(2, '12:00') });
  const text = daySheetText(byCampaign.cpK, day(1));
  assert.ok(text.startsWith('Sushikoji 방문 명단 · ' + day(1)), text.split('\n')[0]);
  assert.match(text, /12:00 {2}김민지 \(@minji\) · 2명 · 알레르기: 새우/);
  assert.match(text, /18:30 {2}hana \(@hana\) · 1명/);
  assert.ok(!text.includes('@dohyun'), 'another day leaked into the sheet');
  assert.match(text, /총 2팀 \/ 3명/);
  assert.match(text, /촬영: 1 Reel/);
});

test('a day with nobody on it says so rather than printing an empty list', () => {
  seed();
  assert.match(daySheetText(byCampaign.cpK, day(4)), /예약된 방문이 없습니다/);
});

test('a repeat creator is one we have confirmed on another campaign, posted or not', () => {
  seed();
  part({ id: 'k1', creatorId: 'cr1', stage: 'sourced', appliedAt: day(-1) });
  part({ id: 'j1', campaignId: 'cpJ', creatorId: 'cr1', stage: 'live' });
  const r = plannerBuckets(byCampaign.cpK).waiting[0];
  assert.equal(r.repeat, 1, 'a past campaign counts even with no post on file');
  part({ id: 'j2', campaignId: 'cpJ', creatorId: 'cr1', stage: 'confirmed' });
  assert.equal(plannerBuckets(byCampaign.cpK).waiting[0].repeat, 1, 'the same campaign twice is still one campaign');
  part({ id: 'k2', creatorId: 'cr4', stage: 'sourced', appliedAt: day(-2) });
  part({ id: 'j3', campaignId: 'cpJ', creatorId: 'cr4', stage: 'sourced' });
  assert.equal(plannerBuckets(byCampaign.cpK).waiting[0].repeat, 0, 'somebody who only ever applied is not a repeat');
});

test('a visit at noon is still nine days ago nine days later', () => {
  assert.equal(postedState({ confirmedVisitAt: slot(-9, '12:00') }).state, 'overdue');
  assert.match(postedState({ confirmedVisitAt: slot(-9, '12:00') }).label, /9d since the visit/);
  assert.equal(postedState({ confirmedVisitAt: slot(0, '12:00') }).state, 'due');
});
