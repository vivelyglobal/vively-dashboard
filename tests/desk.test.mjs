/* THE DESK — the cross-campaign view.

   Three restaurants running at once, and one person answering "what is
   happening today". Everything below is that person's question: who is
   double-booked, which venue is over the limit it agreed to, and which
   links went out and were never used. The grid is not tested here; the
   judgements behind it are. */

import './helpers/browser-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DB, byCampaign, byCreator } from '../src/model/db.js';
import { DESK, deskClashes, deskChores, deskPeople, deskWho, deskLabel,
  deskAdd, deskMins, deskBookingsOn, deskMatchesQuery, deskSchedules } from '../src/views/desk.js';

const DAY = '2026-11-12';   /* a Thursday */

function world(extra) {
  Object.keys(byCampaign).forEach((k) => delete byCampaign[k]);
  Object.keys(byCreator).forEach((k) => delete byCreator[k]);
  DB.campaigns = [
    { id: 'cp1', brand: 'Hangang Cool Rain', name: 'November', kind: 'Store visit' },
    { id: 'cp2', brand: 'Mapo Galbi', name: 'Autumn', kind: 'Store visit' }
  ];
  DB.campaigns.forEach((c) => { byCampaign[c.id] = c; });
  DB.creators = [
    { id: 'cr1', handle: '@mina' }, { id: 'cr2', handle: '@joon' },
    { id: 'cr3', handle: '@blocked', flag: 'blocked', flagReason: 'no-showed twice' }
  ];
  DB.creators.forEach((c) => { byCreator[c.id] = c; });
  DB.participants = [
    { id: 'p1', campaignId: 'cp1', creatorId: 'cr1', stage: 'confirmed' },
    { id: 'p2', campaignId: 'cp2', creatorId: 'cr1', stage: 'confirmed' },
    { id: 'p3', campaignId: 'cp1', creatorId: 'cr2', stage: 'confirmed' },
    { id: 'p4', campaignId: 'cp1', creatorId: 'cr3', stage: 'confirmed' }
  ];

  DESK.from = DAY; DESK.day = DAY; DESK.q = ''; DESK.only = '';
  DESK.data = Object.assign({
    schedules: [
      { _id: 'sch1', campaignId: 'cp1', venueName: 'Hangang Cool Rain', status: 'open', closedDates: [], maxPerDay: 0 },
      { _id: 'sch2', campaignId: 'cp2', venueName: 'Mapo Galbi', status: 'open', closedDates: [], maxPerDay: 0 }
    ],
    slots: [
      { _id: 's1', scheduleId: 'sch1', campaignId: 'cp1', date: DAY, time: '18:00', capacity: 2, booked: 0 },
      { _id: 's2', scheduleId: 'sch1', campaignId: 'cp1', date: DAY, time: '20:00', capacity: 2, booked: 0 },
      { _id: 's3', scheduleId: 'sch2', campaignId: 'cp2', date: DAY, time: '19:00', capacity: 2, booked: 0 }
    ],
    bookings: [],
    invites: []
  }, extra || {});
  return DESK.data;
}

const bk = (o) => Object.assign({ _id: 'b' + Math.random().toString(36).slice(2, 7),
  date: DAY, status: 'confirmed', partySize: 1 }, o);

/* ---- the same person twice in one day ---- */

test('a creator booked at two venues on one day is surfaced, and the gap decides how loudly', () => {
  const d = world();
  d.bookings = [
    bk({ _id: 'bA', scheduleId: 'sch1', campaignId: 'cp1', slotId: 's1', time: '18:00', participantId: 'p1' }),
    bk({ _id: 'bB', scheduleId: 'sch2', campaignId: 'cp2', slotId: 's3', time: '19:00', participantId: 'p2' })
  ];
  /* different roster rows, same human — the join has to be the creator */
  const cs = deskClashes(DAY).filter((c) => c.kind === 'double');
  assert.equal(cs.length, 1);
  assert.equal(cs[0].bad, true, 'an hour apart in two restaurants is urgent');
  assert.match(cs[0].text, /@mina is booked twice/);
  assert.match(cs[0].why, /two venues/);
});

test('the same two bookings four hours apart are worth knowing, not worth panicking about', () => {
  const d = world();
  d.slots.push({ _id: 's4', scheduleId: 'sch2', campaignId: 'cp2', date: DAY, time: '22:00', capacity: 2, booked: 0 });
  d.bookings = [
    bk({ scheduleId: 'sch1', campaignId: 'cp1', slotId: 's1', time: '18:00', participantId: 'p1' }),
    bk({ scheduleId: 'sch2', campaignId: 'cp2', slotId: 's4', time: '22:00', participantId: 'p2' })
  ];
  const cs = deskClashes(DAY).filter((c) => c.kind === 'double');
  assert.equal(cs.length, 1);
  assert.equal(cs[0].bad, false);
});

test('two different people at the same time is not a clash', () => {
  const d = world();
  d.bookings = [
    bk({ scheduleId: 'sch1', campaignId: 'cp1', slotId: 's1', time: '18:00', participantId: 'p1' }),
    bk({ scheduleId: 'sch1', campaignId: 'cp1', slotId: 's1', time: '18:00', participantId: 'p3' })
  ];
  assert.equal(deskClashes(DAY).filter((c) => c.kind === 'double').length, 0);
});

/* ---- the limits the venue set ---- */

test('more heads than the sitting holds is urgent, and counts party size not bookings', () => {
  const d = world();
  d.bookings = [
    bk({ scheduleId: 'sch1', campaignId: 'cp1', slotId: 's1', time: '18:00', participantId: 'p1', partySize: 2 }),
    bk({ scheduleId: 'sch1', campaignId: 'cp1', slotId: 's1', time: '18:00', participantId: 'p3', partySize: 1 })
  ];
  const over = deskClashes(DAY).filter((c) => c.kind === 'over');
  assert.equal(over.length, 1);
  assert.equal(over[0].bad, true);
  assert.match(over[0].why, /3 booked into 2 seats/);
});

test('a venue past the teams-a-day it agreed to is called out by name', () => {
  const d = world();
  d.schedules[0].maxPerDay = 1;
  d.bookings = [
    bk({ scheduleId: 'sch1', campaignId: 'cp1', slotId: 's1', time: '18:00', participantId: 'p1' }),
    bk({ scheduleId: 'sch1', campaignId: 'cp1', slotId: 's2', time: '20:00', participantId: 'p3' })
  ];
  const cap = deskClashes(DAY).filter((c) => c.kind === 'daycap');
  assert.equal(cap.length, 1);
  assert.match(cap[0].text, /Hangang Cool Rain has 2 teams/);
  /* and the other venue, with no limit set, says nothing */
  assert.equal(cap.filter((c) => /Mapo/.test(c.text)).length, 0);
});

test('a limit of 0 means as many as the times allow, and never complains', () => {
  const d = world();
  d.schedules[0].maxPerDay = 0;
  d.bookings = [
    bk({ scheduleId: 'sch1', campaignId: 'cp1', slotId: 's1', time: '18:00', participantId: 'p1' }),
    bk({ scheduleId: 'sch1', campaignId: 'cp1', slotId: 's2', time: '20:00', participantId: 'p3' })
  ];
  assert.equal(deskClashes(DAY).filter((c) => c.kind === 'daycap').length, 0);
});

test('somebody booked on a day the venue is shut is urgent', () => {
  const d = world();
  d.schedules[0].closedDates = [DAY];
  d.bookings = [bk({ scheduleId: 'sch1', campaignId: 'cp1', slotId: 's1', time: '18:00', participantId: 'p1' })];
  const shut = deskClashes(DAY).filter((c) => c.kind === 'closed');
  assert.equal(shut.length, 1);
  assert.equal(shut[0].bad, true);
});

test('a closed venue with nobody booked on it is silent', () => {
  const d = world();
  d.schedules[0].closedDates = [DAY];
  assert.equal(deskClashes(DAY).filter((c) => c.kind === 'closed').length, 0);
});

/* ---- who is coming ---- */

test('a blacklisted creator with a booking is the loudest row on the page', () => {
  const d = world();
  d.bookings = [bk({ scheduleId: 'sch1', campaignId: 'cp1', slotId: 's1', time: '18:00', participantId: 'p4' })];
  const f = deskClashes(DAY).filter((c) => c.kind === 'flag');
  assert.equal(f.length, 1);
  assert.equal(f[0].bad, true);
  assert.match(f[0].text, /@blocked is blacklisted/);
  assert.match(f[0].why, /no-showed twice/);
});

test('a booking made on the open link that matches nobody is flagged, not hidden', () => {
  const d = world();
  d.bookings = [bk({ scheduleId: 'sch1', campaignId: 'cp1', slotId: 's1', time: '18:00',
    participantId: '', guest: { handle: '@walkin' } })];
  const u = deskClashes(DAY).filter((c) => c.kind === 'unmatched');
  assert.equal(u.length, 1);
  assert.equal(u[0].bad, false);
  assert.match(u[0].text, /@walkin booked on the open link/);
  assert.equal(deskWho(d.bookings[0]).matched, false);
  assert.equal(deskWho(d.bookings[0]).handle, '@walkin');
});

/* ---- links that went nowhere ---- */

test('links sent and never used are grouped by campaign, over the whole window not one day', () => {
  const d = world();
  d.bookings = [bk({ scheduleId: 'sch1', campaignId: 'cp1', slotId: 's1', time: '18:00', participantId: 'p1' })];
  d.invites = [
    { _id: 'i1', campaignId: 'cp1', participantId: 'p1', handle: '@mina' },     /* used */
    { _id: 'i2', campaignId: 'cp1', participantId: 'p3', handle: '@joon' },
    { _id: 'i3', campaignId: 'cp2', participantId: 'p2', handle: '@mina' }
  ];
  const chores = deskChores();
  assert.equal(chores.length, 2);
  const one = chores.find((c) => c.campaignId === 'cp1');
  assert.equal(one.list.length, 1, 'the used link is not chased');
  assert.match(one.text, /1 link sent and never used/);
});

test('narrowing the desk to one venue narrows the chase list with it', () => {
  const d = world();
  d.invites = [
    { _id: 'i2', campaignId: 'cp1', participantId: 'p3', handle: '@joon' },
    { _id: 'i3', campaignId: 'cp2', participantId: 'p2', handle: '@mina' }
  ];
  DESK.only = 'cp1';
  assert.equal(deskChores().length, 1);
  assert.equal(deskSchedules().length, 1);
  DESK.only = '';
  assert.equal(deskChores().length, 2);
});

/* ---- the by-creator view ---- */

test('by creator, one person holding two campaigns is one row with both', () => {
  const d = world();
  d.bookings = [
    bk({ scheduleId: 'sch1', campaignId: 'cp1', slotId: 's1', time: '18:00', participantId: 'p1' }),
    bk({ scheduleId: 'sch2', campaignId: 'cp2', slotId: 's3', time: '19:00', participantId: 'p2' }),
    bk({ scheduleId: 'sch1', campaignId: 'cp1', slotId: 's2', time: '20:00', participantId: 'p3' })
  ];
  const rows = deskPeople();
  assert.equal(rows.length, 2);
  const mina = rows.find((r) => r.who.handle === '@mina');
  assert.equal(mina.list.length, 2);
  assert.equal(new Set(mina.list.map((b) => b.campaignId)).size, 2);
});

test('the search box filters the grid and the people list the same way', () => {
  const d = world();
  d.bookings = [
    bk({ scheduleId: 'sch1', campaignId: 'cp1', slotId: 's1', time: '18:00', participantId: 'p1' }),
    bk({ scheduleId: 'sch2', campaignId: 'cp2', slotId: 's3', time: '19:00', participantId: 'p3' })
  ];
  DESK.q = 'joon';
  assert.equal(deskBookingsOn(DAY).filter(deskMatchesQuery).length, 1);
  assert.equal(deskPeople().length, 1);
  DESK.q = 'mapo';
  assert.equal(deskBookingsOn(DAY).filter(deskMatchesQuery).length, 1, 'a venue name matches too');
  DESK.q = '';
});

/* ---- Korea time, and dates that do not slide ---- */

test('the day label never slides a day, whatever the browser thinks the zone is', () => {
  assert.equal(deskLabel('2026-11-12'), 'Thu 12 Nov');
  assert.equal(deskLabel('2026-01-01'), 'Thu 1 Jan');
  assert.equal(deskAdd('2026-12-31', 1), '2027-01-01');
  assert.equal(deskAdd('2026-03-01', -1), '2026-02-28');
});

test('times sort by the clock, not by their text', () => {
  assert.equal(deskMins('09:30'), 570);
  assert.equal(deskMins('18:00'), 1080);
  assert.ok(deskMins('9:30') < deskMins('11:00'), 'a one-digit hour still comes first');
  assert.equal(deskMins(''), 0);
});
