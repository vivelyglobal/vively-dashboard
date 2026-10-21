/* The parcel: a seeding campaign's equivalent of a booking.

   The stage already said "Shipped" and shippedAt already held the day.
   What nobody could answer was which courier, what number, and whether
   it arrived — so these are the rules for the state the roster shows. */

import './helpers/browser-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campaignShips, shipmentState, shipmentLine, shipmentLate, shipmentSummary, shippableParts }
  from '../src/views/campaigns.js';
import { DB, byCampaign, byCreator } from '../src/model/db.js';
import { TODAY, DAY, iso } from '../src/lib/dates.js';

const seed = (parts) => {
  DB.creators.length = 0; DB.campaigns.length = 0; DB.participants.length = 0;
  Object.keys(byCreator).forEach((k) => delete byCreator[k]);
  Object.keys(byCampaign).forEach((k) => delete byCampaign[k]);
  DB.campaigns.push({ id: 'cp1', brand: 'HANGANG SEOUL', name: 'Cool Rain seeding', kind: 'Seeding' });
  byCampaign.cp1 = DB.campaigns[0];
  (parts || []).forEach((x, i) => {
    const id = 'c' + i;
    DB.creators.push({ id, handle: '@c' + i, name: 'C' + i, followers: 1000, er: 2, flag: null, categories: [] });
    byCreator[id] = DB.creators[DB.creators.length - 1];
    DB.participants.push(Object.assign({ id: 'p' + i, campaignId: 'cp1', creatorId: id, stage: 'confirmed' }, x));
  });
};
const daysAgo = (n) => iso(new Date(TODAY.getTime() - n * DAY));

test('a visit campaign ships nothing — booking covers those', () => {
  /* the kinds in use are not one fixed list: the New Campaign form offers
     "Store visit" while campaigns imported earlier say "Salon visit", and
     both of them are somebody turning up rather than a parcel */
  ['Store visit', 'Salon visit', 'Restaurant visit'].forEach((k) =>
    assert.equal(campaignShips({ kind: k }), false, k));
  ['Seeding', 'Product seeding', 'Paid collab', 'Product launch', 'Market validation']
    .forEach((k) => assert.equal(campaignShips({ kind: k }), true, k));
  assert.equal(campaignShips(null), false, 'no campaign, nothing to ship');
});

test('a confirmed creator with nothing sent is waiting, not sent', () => {
  seed([{}]);
  const st = shipmentState(DB.participants[0]);
  assert.equal(st.id, 'waiting');
  assert.equal(st.label, 'Not sent');
  assert.equal(shipmentLine(DB.participants[0]), 'Not sent');
});

test('a sent date makes it sent, and the courier and number ride along', () => {
  seed([{ shippedAt: '2026-10-21', shipment: { carrier: 'CJ대한통운', tracking: '1234567890' } }]);
  const p = DB.participants[0];
  assert.equal(shipmentState(p).id, 'sent');
  assert.equal(shipmentState(p).at, '2026-10-21');
  assert.equal(shipmentLine(p), 'Sent 2026-10-21 · CJ대한통운 1234567890');
});

test('an arrival date wins over the sent date, because it is the later truth', () => {
  seed([{ shippedAt: '2026-10-21', shipment: { deliveredAt: '2026-10-24' } }]);
  const st = shipmentState(DB.participants[0]);
  assert.equal(st.id, 'delivered');
  assert.equal(st.at, '2026-10-24');
});

test('a parcel out more than ten days with nothing back is flagged', () => {
  seed([{ shippedAt: daysAgo(11) }, { shippedAt: daysAgo(3) },
    { shippedAt: daysAgo(30), shipment: { deliveredAt: daysAgo(25) } }]);
  assert.equal(shipmentLate(DB.participants[0]), true, 'eleven days with no word');
  assert.equal(shipmentLate(DB.participants[1]), false, 'three days is fine');
  assert.equal(shipmentLate(DB.participants[2]), false, 'it arrived, so there is nothing to chase');
});

test('only rows that are owed a parcel are counted', () => {
  seed([{ stage: 'sourced' }, { stage: 'shortlisted' }, { stage: 'confirmed' },
    { stage: 'live' }, { stage: 'dropped' }]);
  assert.deepEqual(shippableParts('cp1').map((p) => p.id), ['p2', 'p3'],
    'confirmed and beyond, and never a dropped row');
});

test('the summary counts what the header prints', () => {
  seed([
    { stage: 'confirmed' },
    { stage: 'shipped', shippedAt: daysAgo(2) },
    { stage: 'shipped', shippedAt: daysAgo(12) },
    { stage: 'live', shippedAt: daysAgo(20), shipment: { deliveredAt: daysAgo(17) } },
    { stage: 'dropped', shippedAt: daysAgo(5) }
  ]);
  assert.deepEqual(shipmentSummary('cp1'),
    { total: 4, waiting: 1, sent: 2, delivered: 1, late: 1 });
});

test('a campaign with nobody confirmed yet summarises to nothing', () => {
  seed([{ stage: 'contacted' }]);
  assert.deepEqual(shipmentSummary('cp1'), { total: 0, waiting: 0, sent: 0, delivered: 0, late: 0 });
});
