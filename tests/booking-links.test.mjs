/* Who gets a booking link, and what the intern pastes into Excel.

   The rule that matters: a roster holds everyone ever considered, and a
   link is for the people the campaign has confirmed. Widening that is a
   choice somebody makes on screen, never the default. */

import './helpers/browser-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOOKING, INVITE_SCOPES, SAFE_SCOPE, invitableParticipants, bookableParticipants, inviteRows, inviteRowsFull } from '../src/views/booking.js';
import { DB, byCreator, byCampaign } from '../src/model/db.js';

function seed() {
  DB.creators.length = 0; DB.campaigns.length = 0; DB.participants.length = 0;
  Object.keys(byCreator).forEach((k) => delete byCreator[k]);
  Object.keys(byCampaign).forEach((k) => delete byCampaign[k]);
  const cr = (id, handle, extra) => Object.assign({ id, handle, name: handle.slice(1), platform: 'Instagram',
    followers: 1000, er: 2, flag: null, flagReason: '', categories: [] }, extra || {});
  DB.creators.push(cr('c1', '@alpha'), cr('c2', '@beta'), cr('c3', '@gamma'),
    cr('c4', '@delta'), cr('c5', '@blocked', { flag: 'blocked', flagReason: 'no-show' }));
  DB.creators.forEach((c) => (byCreator[c.id] = c));
  DB.campaigns.push({ id: 'cp1', brand: 'Sushikoji', name: 'counter visit' });
  byCampaign.cp1 = DB.campaigns[0];
  DB.participants.push(
    { id: 'p1', campaignId: 'cp1', creatorId: 'c1', stage: 'confirmed', fullName: 'Alpha Kim' },
    { id: 'p2', campaignId: 'cp1', creatorId: 'c2', stage: 'live' },
    { id: 'p3', campaignId: 'cp1', creatorId: 'c3', stage: 'shortlisted' },
    { id: 'p4', campaignId: 'cp1', creatorId: 'c4', stage: 'sourced' },
    { id: 'p5', campaignId: 'cp1', creatorId: 'c5', stage: 'confirmed' },      /* blacklisted */
    { id: 'p6', campaignId: 'cp1', creatorId: 'c1', stage: 'dropped' }
  );
  BOOKING.campaignId = 'cp1'; BOOKING.schedule = { _id: 'sch1', publicToken: 'tok' };
  BOOKING.slots = []; BOOKING.bookings = []; BOOKING.invites = []; BOOKING.inviteScope = 'confirmed';
}

test('a booking link is for confirmed creators, and that is the default', () => {
  seed();
  assert.deepEqual(invitableParticipants(byCampaign.cp1).map((p) => p.id), ['p1', 'p2'],
    'confirmed and live are in; shortlisted, sourced, dropped and blacklisted are not');
  assert.equal(INVITE_SCOPES[0][0], 'confirmed');
});

test('the wider scopes are there when somebody asks for them', () => {
  seed();
  assert.deepEqual(invitableParticipants(byCampaign.cp1, 'shortlisted').map((p) => p.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(invitableParticipants(byCampaign.cp1, 'all').map((p) => p.id), ['p1', 'p2', 'p3', 'p4']);
});

test('a blacklisted creator never gets a link, at any scope', () => {
  seed();
  INVITE_SCOPES.forEach(([id]) => {
    assert.ok(!invitableParticipants(byCampaign.cp1, id).some((p) => p.id === 'p5'), id);
  });
});

test('whoever already has a link or a booking is not offered one again', () => {
  seed();
  BOOKING.invites = [{ _id: 'i1', participantId: 'p1', campaignId: 'cp1' }];
  BOOKING.bookings = [{ _id: 'b1', participantId: 'p2', date: '2026-10-21', time: '18:30' }];
  assert.deepEqual(bookableParticipants(byCampaign.cp1).map((p) => p.id), []);
  BOOKING.inviteScope = 'all';
  assert.deepEqual(bookableParticipants(byCampaign.cp1).map((p) => p.id), ['p3', 'p4']);
});

test('the Excel copy is two columns — name, then link', () => {
  seed();
  BOOKING.invites = [{ _id: 'inv1', participantId: 'p1', campaignId: 'cp1' }];
  BOOKING.bookings = [{ _id: 'b1', participantId: 'p1', date: '2026-10-21', time: '18:30' }];
  const rows = inviteRows(byCampaign.cp1);
  assert.deepEqual(rows[0], ['Name', 'Booking Link']);
  assert.equal(rows.length, 2, 'header plus the one creator who has a link');
  assert.deepEqual(rows[1], ['Alpha Kim', 'https://dash.test/book/i/inv1']);
  rows.forEach((r) => assert.equal(r.length, 2, 'two columns, always'));
});

test('a creator without a link is left out rather than pasted blank', () => {
  seed();
  BOOKING.invites = [{ _id: 'inv1', participantId: 'p1', campaignId: 'cp1' }];
  const rows = inviteRows(byCampaign.cp1);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r[1] !== ''), 'no empty link cell for the intern to send');
});

test('the full CSV keeps the working detail, including who has no link yet', () => {
  seed();
  BOOKING.invites = [{ _id: 'inv1', participantId: 'p1', campaignId: 'cp1' }];
  BOOKING.bookings = [{ _id: 'b1', participantId: 'p1', date: '2026-10-21', time: '18:30' }];
  const rows = inviteRowsFull(byCampaign.cp1);
  assert.deepEqual(rows[0], ['Name', 'Handle', 'Stage', 'Booking', 'Link']);
  assert.equal(rows.length, 3, 'header plus both confirmed creators');
  assert.equal(rows[1][3], '2026-10-21 18:30');
  assert.equal(rows[2][4], '', 'the one without a link is still visible here');
});

test('the table follows the scope on screen', () => {
  seed();
  BOOKING.inviteScope = 'all';
  BOOKING.invites = [{ _id: 'i3', participantId: 'p3', campaignId: 'cp1' }];
  assert.equal(inviteRows(byCampaign.cp1).length, 2, 'the shortlisted creator is in once the scope says so');
  assert.equal(inviteRowsFull(byCampaign.cp1).length, 5, 'header plus four');
  BOOKING.inviteScope = 'confirmed';
  assert.equal(inviteRows(byCampaign.cp1).length, 1, 'and out again — header only');
});

test('confirmed is the scope anything else has to be overridden to', () => {
  assert.equal(SAFE_SCOPE, 'confirmed');
  assert.equal(INVITE_SCOPES[0][0], SAFE_SCOPE);
  assert.equal(INVITE_SCOPES[0][3], '', 'the safe one carries no warning');
  INVITE_SCOPES.slice(1).forEach(([id, , , warn]) =>
    assert.match(warn, /unconfirmed|not confirmed|nobody has confirmed/, id));
});

/* The clipboard itself. Excel splits on tabs, so a cell that contains a
   tab or a newline would silently become two columns or two rows. */

test('the clipboard carries tabs, so Excel lands each field in its own column', async () => {
  const { tableTsv } = await import('../src/ui/html.js');
  const tsv = tableTsv([['Name', 'Link'], ['Alpha Kim', 'https://x.test/book/i/inv1']]);
  assert.equal(tsv, 'Name\tLink\nAlpha Kim\thttps://x.test/book/i/inv1');
  assert.equal(tsv.split('\n').length, 2);
});

test('a stray tab or newline inside a cell cannot break the columns', async () => {
  const { tableTsv } = await import('../src/ui/html.js');
  const tsv = tableTsv([['a\tb', 'c\nd', 'e\r\nf']]);
  assert.equal(tsv, 'a b\tc d\te f');
});

test('empty and missing cells stay as empty columns, not gaps', async () => {
  const { tableTsv } = await import('../src/ui/html.js');
  assert.equal(tableTsv([['x', null, undefined, '']]), 'x\t\t\t');
});

test('the rich flavour is a real table with a header row, and it escapes', async () => {
  const { tableHtml } = await import('../src/ui/html.js');
  const html = tableHtml([['Name', 'Link'], ['A & B <co>', 'https://x.test/1']]);
  assert.match(html, /^<table><tr><th>Name<\/th><th>Link<\/th><\/tr>/);
  assert.match(html, /<td>A &amp; B &lt;co&gt;<\/td>/);
  assert.ok(!html.includes('<co>'));
});

/* The booking owns the confirmed time. Everything else on the page reads
   it off the participant, so the page has to copy it across the moment
   it knows — or a staff move shows up on the Booking tab and nowhere
   else, and the next save posts the old time back. */

test('a move projects onto the roster row the page is showing', async () => {
  const { applyBookingTimesLocally } = await import('../src/views/booking.js');
  seed();
  DB.participants.find((x) => x.id === 'p1').confirmedVisitAt = '2026-11-02 11:00';
  DB.participants.find((x) => x.id === 'p1').bookingId = 'bk1';
  BOOKING.bookings = [{ _id: 'bk1', participantId: 'p1', date: '2026-11-03', time: '19:30', status: 'confirmed' }];
  const changed = applyBookingTimesLocally('cp1');
  const row = DB.participants.find((x) => x.id === 'p1');
  assert.equal(row.confirmedVisitAt, '2026-11-03 19:30');
  assert.deepEqual(changed, [{ id: 'p1', was: '2026-11-02 11:00', now: '2026-11-03 19:30' }]);
});

test('a creator booking for the first time lands on the row too', async () => {
  const { applyBookingTimesLocally } = await import('../src/views/booking.js');
  seed();
  BOOKING.bookings = [{ _id: 'bk9', participantId: 'p2', date: '2026-11-04', time: '18:30', status: 'confirmed' }];
  applyBookingTimesLocally('cp1');
  const row = DB.participants.find((x) => x.id === 'p2');
  assert.equal(row.confirmedVisitAt, '2026-11-04 18:30');
  assert.equal(row.bookingId, 'bk9');
});

test('a cancelled booking lets the row fall back to what they asked for', async () => {
  const { applyBookingTimesLocally } = await import('../src/views/booking.js');
  seed();
  const row = DB.participants.find((x) => x.id === 'p1');
  row.visitAt = '2026-11-01 12:00';
  row.confirmedVisitAt = '2026-11-02 11:00';
  row.bookingId = 'bk1';
  BOOKING.bookings = [{ _id: 'bk1', participantId: 'p1', date: '2026-11-02', time: '11:00', status: 'cancelled' }];
  applyBookingTimesLocally('cp1');
  assert.equal(row.confirmedVisitAt, undefined);
  assert.equal(row.bookingId, undefined);
  assert.equal(row.visitAt, '2026-11-01 12:00', 'the requested time is still on file');
});

test('rows on other campaigns are left alone', async () => {
  const { applyBookingTimesLocally } = await import('../src/views/booking.js');
  seed();
  DB.participants.push({ id: 'other', campaignId: 'cp2', creatorId: 'c1', stage: 'confirmed',
    confirmedVisitAt: '2026-12-01 10:00', bookingId: 'bkX' });
  applyBookingTimesLocally('cp1');
  const row = DB.participants.find((x) => x.id === 'other');
  assert.equal(row.confirmedVisitAt, '2026-12-01 10:00', 'another campaign is not this tab\'s business');
});

test('nothing to change reports nothing', async () => {
  const { applyBookingTimesLocally } = await import('../src/views/booking.js');
  seed();
  DB.participants.find((x) => x.id === 'p1').confirmedVisitAt = '2026-11-03 19:30';
  DB.participants.find((x) => x.id === 'p1').bookingId = 'bk1';
  BOOKING.bookings = [{ _id: 'bk1', participantId: 'p1', date: '2026-11-03', time: '19:30', status: 'confirmed' }];
  assert.deepEqual(applyBookingTimesLocally('cp1'), []);
});

test('corrections the server made are taken, not argued with', async () => {
  const { adoptBookingFixes } = await import('../src/model/db.js');
  seed();
  DB.participants.find((x) => x.id === 'p1').confirmedVisitAt = '2026-11-02 11:00';
  const n = adoptBookingFixes({ corrected: [
    { participantId: 'p1', was: '2026-11-02 11:00', now: '2026-11-05 20:00' },
    { participantId: 'nobody', was: '', now: '2026-11-05 20:00' }
  ] });
  assert.equal(n, 1);
  assert.equal(DB.participants.find((x) => x.id === 'p1').confirmedVisitAt, '2026-11-05 20:00');
});

test('and a response carrying no corrections changes nothing', async () => {
  const { adoptBookingFixes } = await import('../src/model/db.js');
  seed();
  DB.participants.find((x) => x.id === 'p1').confirmedVisitAt = '2026-11-02 11:00';
  [null, undefined, {}, { corrected: [] }].forEach((x) => assert.equal(adoptBookingFixes(x), 0));
  assert.equal(DB.participants.find((x) => x.id === 'p1').confirmedVisitAt, '2026-11-02 11:00');
});
