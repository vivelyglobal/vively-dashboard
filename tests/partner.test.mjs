import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/* buildPartnerRows decides what a partner is allowed to see. It runs on the
   server so the fields it drops are never in a response at all — which only
   holds if it actually drops them. Pulled out of the real server.js rather
   than reimplemented, so this tests the shipping code. */
const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const from = src.indexOf('const PARTNER_STATUS = {');
const to = src.indexOf('async function partnerCommentsCollection');
const ctx = vm.createContext({ Object, String, Set, RegExp, Math, console });
vm.runInContext(src.slice(from, to) + '\nthis.api = { buildPartnerRows, partnerStatusOf };', ctx);
const { buildPartnerRows, partnerStatusOf } = ctx.api;

const db = {
  campaigns: [
    { id: 'a', brand: 'Sushikoji', name: 'Jongno', partner: 'SPLABAB', start: '2026-09-01', end: '2026-09-30' },
    { id: 'b', brand: 'Glowbe',    name: 'Serum',  partner: 'OTHERCO', start: '2026-09-01', end: '2026-09-30' },
    { id: 'c', brand: 'Mine',      name: 'Own',                       start: '2026-09-01', end: '2026-09-30' }
  ],
  creators: [
    { id: 'c1', handle: '@one', name: 'One', email: 'one@x.com', followers: 12000, gender: 'F',
      nationality: 'Korean', contact: 'kakao-one',
      payout: { bank: 'KB', name: 'One', number: '110-234-567890' } },
    { id: 'c2', handle: '@two', name: 'Two', email: 'two@x.com', followers: 4000 },
    { id: 'c3', handle: '@three', name: 'Three', email: 'three@x.com', followers: 90000 }
  ],
  participants: [
    { id: 'a-c1', campaignId: 'a', creatorId: 'c1', stage: 'confirmed', visitAt: '2026-09-04 19:00',
      note: 'INTERNAL — creator was difficult', formNotes: '채식주의자입니다', remark: '2명 방문 예정',
      fee: 50000, address: '서울시 강남구 비밀주소', otherSns: 'https://tiktok.com/@one',
      acceptMessage: '승인되었습니다', content: { url: 'https://instagram.com/reel/xyz' } },
    { id: 'a-c2', campaignId: 'a', creatorId: 'c2', stage: 'shortlisted', importedStatus: 'Waiting Approval',
      note: 'INTERNAL', visitAt: '' },
    { id: 'b-c3', campaignId: 'b', creatorId: 'c3', stage: 'live', note: 'INTERNAL', visitAt: '2026-09-02 11:00' }
  ]
};

test('a partner sees only their own campaigns', () => {
  const out = buildPartnerRows(db, 'SPLABAB');
  assert.deepEqual(out.campaigns.map((c) => c.brand), ['Sushikoji']);
  /* a-c2 is Waiting Approval, so it is withheld — see the next test */
  assert.deepEqual(out.rows.map((r) => r.pid), ['a-c1']);
});

test('a creator still awaiting brand approval is ABSENT, not just hidden', () => {
  const out = buildPartnerRows(db, 'SPLABAB');
  assert.equal(out.rows.some((r) => r.pid === 'a-c2'), false);
  assert.equal(out.withheld, 1, 'the count is reported back to the dashboard');
  /* not merely filtered in the page — the row is not in the payload at all,
     so there is nothing to find by opening devtools */
  const json = JSON.stringify(out);
  assert.ok(!json.includes('@two'), 'an unapproved creator reached the payload');
  assert.ok(!json.includes('two@x.com'), 'an unapproved creator\'s email reached the payload');
});

test('every other status still comes through', () => {
  const many = { ...db, participants: [
    { id: 'a-x1', campaignId: 'a', creatorId: 'c1', stage: 'confirmed',  importedStatus: 'Confirmed' },
    { id: 'a-x2', campaignId: 'a', creatorId: 'c1', stage: 'dropped',    importedStatus: 'Brand Rejected' },
    { id: 'a-x3', campaignId: 'a', creatorId: 'c1', stage: 'dropped',    importedStatus: 'Declined' },
    { id: 'a-x4', campaignId: 'a', creatorId: 'c1', stage: 'shipped',    importedStatus: 'Waiting Upload' },
    { id: 'a-x5', campaignId: 'a', creatorId: 'c1', stage: 'live',       importedStatus: 'Uploaded' },
    { id: 'a-x6', campaignId: 'a', creatorId: 'c1', stage: 'confirmed',  importedStatus: 'Brand Accepted' },
    { id: 'a-x7', campaignId: 'a', creatorId: 'c1', stage: 'shipped',    importedStatus: 'Re-Schedule' },
    { id: 'a-x8', campaignId: 'a', creatorId: 'c1', stage: 'dropped',    importedStatus: 'Cancelled' },
    { id: 'a-x9', campaignId: 'a', creatorId: 'c1', stage: 'shortlisted', importedStatus: 'Waiting Approval' }
  ] };
  const out = buildPartnerRows(many, 'SPLABAB');
  assert.deepEqual(out.rows.map((r) => r.pid).sort(),
    ['a-x1', 'a-x2', 'a-x3', 'a-x4', 'a-x5', 'a-x6', 'a-x7', 'a-x8']);
  assert.equal(out.withheld, 1);
});

test('a shortlisted row with no Notion status is withheld too', () => {
  /* shortlisted means "sent to the brand for approval" — the same thing
     Waiting Approval means, arrived at from the pipeline instead */
  const only = { ...db, participants: [
    { id: 'a-s', campaignId: 'a', creatorId: 'c1', stage: 'shortlisted' }
  ] };
  assert.equal(buildPartnerRows(only, 'SPLABAB').rows.length, 0);
});

test('another partner sees a different set, and never yours', () => {
  const other = buildPartnerRows(db, 'OTHERCO');
  assert.deepEqual(other.rows.map((r) => r.pid), ['b-c3']);
  const unowned = buildPartnerRows(db, '');
  assert.deepEqual(unowned.rows.map((r) => r.pid), []);
  /* the campaign with no partner belongs to nobody but you */
  assert.equal(buildPartnerRows(db, 'Mine').rows.length, 0);
});

test('NOTHING sensitive survives into a partner row', () => {
  const json = JSON.stringify(buildPartnerRows(db, 'SPLABAB'));
  for (const secret of ['110-234-567890', 'INTERNAL', '비밀주소', '50000', 'payout', 'KB']) {
    assert.ok(!json.includes(secret), `"${secret}" leaked into the partner payload`);
  }
  const row = buildPartnerRows(db, 'SPLABAB').rows[0];
  ['note', 'fee', 'address', 'payout'].forEach((k) =>
    assert.equal(row[k], undefined, `${k} should not be on a partner row`));
});

test('every column the partner asked for is present', () => {
  const r = buildPartnerRows(db, 'SPLABAB').rows.find((x) => x.pid === 'a-c1');
  assert.equal(r.creator, 'One');
  assert.equal(r.igUrl, 'https://www.instagram.com/one/');
  assert.equal(r.visitDate, '2026-09-04');
  assert.equal(r.visitTime, '19:00');
  assert.equal(r.email, 'one@x.com');
  assert.equal(r.gender, 'F');
  assert.equal(r.followers, 12000);
  assert.equal(r.remark, '2명 방문 예정');
  assert.equal(r.contentUrl, 'https://instagram.com/reel/xyz');
  assert.equal(r.nationality, 'Korean');
  assert.equal(r.notes, '채식주의자입니다');
  assert.equal(r.otherSns, 'https://tiktok.com/@one');
});

test('the Kakao ID and the accept/reject message are not sent at all', () => {
  const out = buildPartnerRows(db, 'SPLABAB');
  const json = JSON.stringify(out);
  assert.ok(!json.includes('kakao-one'), 'the Kakao ID reached the partner payload');
  assert.ok(!json.includes('승인되었습니다'), 'the accept/reject message reached the partner payload');
  const row = out.rows[0];
  assert.equal(row.kakao, undefined);
  assert.equal(row.acceptMessage, undefined);
});

test('the creator form note and the internal note are different fields', () => {
  const r = buildPartnerRows(db, 'SPLABAB').rows.find((x) => x.pid === 'a-c1');
  assert.equal(r.notes, '채식주의자입니다');
  assert.ok(!String(r.notes).includes('INTERNAL'));
});

test('Waiting Approval is the flag the row filter keys on', () => {
  const s = partnerStatusOf({ importedStatus: 'Waiting Approval', stage: 'shortlisted' });
  assert.equal(s.en, 'Waiting Approval');
  assert.equal(s.theirs, true);
  assert.equal(partnerStatusOf({ stage: 'shortlisted' }).theirs, true);
  /* and nothing else carries it, or rows would vanish for the wrong reason */
  ['Confirmed', 'Brand Accepted', 'Brand Rejected', 'Declined', 'Cancelled',
   'Re-Schedule', 'Waiting Upload', 'Uploaded'].forEach((st) =>
    assert.ok(!partnerStatusOf({ importedStatus: st }).theirs, st + ' should not be withheld'));
});

test('the nine Notion statuses land on the right partner labels', () => {
  const m = (s) => partnerStatusOf({ importedStatus: s }).en;
  assert.equal(m('Confirmed'), 'Confirmed');
  assert.equal(m('Brand Accepted'), 'Confirmed');
  assert.equal(m('Brand Rejected'), 'Brand Rejected');
  assert.equal(m('Declined'), 'Refused');
  assert.equal(m('Cancelled'), 'Refused');
  assert.equal(m('Re-Schedule'), 'Waiting For upload');
  assert.equal(m('Waiting Upload'), 'Waiting For upload');
  assert.equal(m('Uploaded'), 'Uploaded');
});

test('a row with no Notion status still gets one from its stage', () => {
  assert.equal(partnerStatusOf({ stage: 'contacted' }).en, 'Contacted');
  assert.equal(partnerStatusOf({ stage: 'live' }).en, 'Uploaded');
  assert.equal(partnerStatusOf({ stage: 'dropped' }).en, 'Refused');
  assert.equal(partnerStatusOf({ stage: 'dropped', dropReason: 'Brand rejected' }).en, 'Brand Rejected');
});

test('rows come back in visit order so the POC reads it as a schedule', () => {
  const withDates = { ...db, participants: [
    { id: 'a-late', campaignId: 'a', creatorId: 'c1', stage: 'confirmed', visitAt: '2026-09-20 10:00' },
    { id: 'a-none', campaignId: 'a', creatorId: 'c2', stage: 'confirmed', visitAt: '' },
    { id: 'a-soon', campaignId: 'a', creatorId: 'c3', stage: 'confirmed', visitAt: '2026-09-04 19:00' }
  ] };
  const rows = buildPartnerRows(withDates, 'SPLABAB').rows;
  assert.deepEqual(rows.map((r) => r.pid), ['a-soon', 'a-late', 'a-none']);
});
