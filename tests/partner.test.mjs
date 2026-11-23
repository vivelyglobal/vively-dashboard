import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

/* buildPartnerRows decides what a partner is allowed to see. It runs on the
   server so the fields it drops are never in a response at all — which only
   holds if it actually drops them. Pulled out of the real server.js rather
   than reimplemented, so this tests the shipping code. */
const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const from = src.indexOf('const PARTNER_STATUS = {');
const to = src.indexOf('async function partnerCommentsCollection');
const ctx = vm.createContext({ Object, String, Set, RegExp, Math, console, crypto, Buffer, Map, Number });
vm.runInContext(src.slice(from, to) +
  '\nthis.api = { buildPartnerRows, partnerStatusOf, resolvePartnerToken, stampPartnerClients,' +
  ' PARTNER_ROW_FIELDS, PARTNER_CAMPAIGN_FIELDS };', ctx);
const { buildPartnerRows, partnerStatusOf, resolvePartnerToken, stampPartnerClients,
  PARTNER_ROW_FIELDS, PARTNER_CAMPAIGN_FIELDS } = ctx.api;

const db = {
  campaigns: [
    { id: 'a', brand: 'Sushikoji', name: 'Jongno', partner: 'SPLABAB', start: '2026-09-01', end: '2026-09-30' },
    { id: 'b', brand: 'Glowbe',    name: 'Serum',  partner: 'OTHERCO', start: '2026-09-01', end: '2026-09-30' },
    { id: 'c', brand: 'Mine',      name: 'Own',                       start: '2026-09-01', end: '2026-09-30' }
  ],
  creators: [
    { id: 'c1', handle: '@one', name: 'One', email: 'one@x.com', followers: 12000, gender: 'F',
      nationality: 'Korean', contact: 'kakao-one', phone: '010-9876-5432', address: '서울 마포구 비밀로 1',
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

test('a booking that is still on comes through; a rejection does not', () => {
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
  /* x2 Brand Rejected, x3 Declined and x8 Cancelled are all rejections —
     브랜드 거절 and 거절 alike — and a partner link is a list of who is
     coming, not of who was turned down or who said no. x9 is still
     waiting on the brand's own decision, so it is withheld as before. */
  assert.deepEqual(out.rows.map((r) => r.pid).sort(),
    ['a-x1', 'a-x4', 'a-x5', 'a-x6', 'a-x7']);
  assert.equal(out.withheld, 4, 'one awaiting approval and three rejections');
  /* not merely absent from the table — absent from the response, so the
     names are not in devtools either */
  const json = JSON.stringify(out);
  ['a-x2', 'a-x3', 'a-x8'].forEach((pid) =>
    assert.ok(!json.includes(pid), pid + ' reached the partner payload'));
});

test('a shortlisted row with no Notion status is withheld too', () => {
  /* shortlisted means "sent to the brand for approval" — the same thing
     Waiting Approval means, arrived at from the pipeline instead */
  const only = { ...db, participants: [
    { id: 'a-s', campaignId: 'a', creatorId: 'c1', stage: 'shortlisted' }
  ] };
  assert.equal(buildPartnerRows(only, 'SPLABAB').rows.length, 0);
});

test('an id claimed by two partners is shown to NEITHER of them', () => {
  /* two campaigns sharing an id was possible before ids were made unique.
     Where the two belong to different partners, the id no longer says whose
     a roster row is — so it is withdrawn from both rather than guessed at.
     Showing nothing is recoverable; showing the wrong partner is not. */
  const clashed = { ...db, campaigns: [
    { id: 'x', brand: 'Ours',   partner: 'SPLABAB' },
    { id: 'x', brand: 'Theirs', partner: 'OTHERCO' },
    { id: 'safe', brand: 'Fine', partner: 'SPLABAB' }
  ], participants: [
    { id: 'x-1', campaignId: 'x', creatorId: 'c1', stage: 'confirmed' },
    { id: 's-1', campaignId: 'safe', creatorId: 'c2', stage: 'confirmed' }
  ] };
  const mine = buildPartnerRows(clashed, 'SPLABAB');
  const theirs = buildPartnerRows(clashed, 'OTHERCO');
  assert.equal(mine.rows.length, 1, 'only the uncontested campaign should show');
  assert.equal(mine.rows[0].campaign, 'Fine');
  assert.equal(theirs.rows.length, 0);
  assert.equal(mine.contested.join(), 'x');
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

test('every column a brand is allowed to see is present', () => {
  const r = buildPartnerRows(db, 'SPLABAB').rows.find((x) => x.pid === 'a-c1');
  assert.equal(r.creator, 'One');
  assert.equal(r.igUrl, 'https://www.instagram.com/one/');
  assert.equal(r.visitDate, '2026-09-04');
  assert.equal(r.visitTime, '19:00');
  assert.equal(r.followers, 12000);
  assert.equal(r.remark, '2명 방문 예정');
  assert.equal(r.contentUrl, 'https://instagram.com/reel/xyz');
});

/* ---- payload leak test ---------------------------------------------------
   Searches the SERIALISED response for every forbidden class, by value and by
   key, so it still catches a leak under a renamed field. Run against both the
   label path and the clientId path. */
const FORBIDDEN_VALUES = ['one@x.com', 'two@x.com', 'three@x.com', '010-9876-5432', '비밀로', '비밀주소',
  'kakao-one', '110-234-567890', '승인되었습니다', 'INTERNAL', 'tiktok.com/@one', '50000'];
const FORBIDDEN_KEYS = ['email', 'phone', 'contact', 'kakao', 'address', 'gender', 'nationality', 'country',
  'payout', 'bank', 'fee', 'note', 'notes', 'formNotes', 'otherSns', 'acceptMessage', 'creatorId', 'url'];

function assertNoLeak(payload, label) {
  const json = JSON.stringify(payload);
  FORBIDDEN_VALUES.forEach((v) => assert.ok(!json.includes(v), label + ': value "' + v + '" leaked'));
  const keys = [];
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') Object.keys(o).forEach((k) => { keys.push(k); walk(o[k]); });
  })(payload);
  FORBIDDEN_KEYS.forEach((k) => assert.ok(!keys.includes(k), label + ': key "' + k + '" present'));
}

test('payload leak test: no forbidden field class in the serialised response', () => {
  const linked = stampDb();
  assertNoLeak(buildPartnerRows(db, 'SPLABAB'), 'label path');
  assertNoLeak(buildPartnerRows(linked.db, 'SPLABAB', linked.cid), 'clientId path');
});

test('every row key is on the allow-list, and nothing else', () => {
  const out = buildPartnerRows(db, 'SPLABAB');
  out.rows.forEach((r) => Object.keys(r).forEach((k) =>
    assert.ok(PARTNER_ROW_FIELDS.includes(k), 'row key "' + k + '" is not allow-listed')));
  out.campaigns.forEach((c) => Object.keys(c).forEach((k) =>
    assert.ok(PARTNER_CAMPAIGN_FIELDS.includes(k), 'campaign key "' + k + '" is not allow-listed')));
  assert.deepEqual(Object.keys(out).sort(), ['campaigns', 'contested', 'partner', 'rows', 'withheld']);
});

test('an injected extra field on a creator, participant or campaign cannot ride out', () => {
  const sneaky = JSON.parse(JSON.stringify(db));
  sneaky.creators[0].secretFlag = 'LEAK-ME-1';
  sneaky.participants[0].extraThing = 'LEAK-ME-2';
  sneaky.campaigns[0].internalBudget = 'LEAK-ME-3';
  const json = JSON.stringify(buildPartnerRows(sneaky, 'SPLABAB'));
  ['LEAK-ME-1', 'LEAK-ME-2', 'LEAK-ME-3'].forEach((v) => assert.ok(!json.includes(v), v));
});

test('only http(s) content links leave; a javascript: value is dropped', () => {
  const bad = JSON.parse(JSON.stringify(db));
  bad.participants[0].content = { url: 'javascript:alert(1)' };
  assert.equal(buildPartnerRows(bad, 'SPLABAB').rows[0].contentUrl, '');
});

test('a non-numeric follower count cannot carry markup', () => {
  const bad = JSON.parse(JSON.stringify(db));
  bad.creators[0].followers = '<img src=x onerror=alert(1)>';
  assert.equal(buildPartnerRows(bad, 'SPLABAB').rows[0].followers, 0);
});

/* ---- tenant key ---------------------------------------------------------- */
function stampDb() {
  const d = JSON.parse(JSON.stringify(db));
  d.partnerLinks = [
    { partner: 'SPLABAB', token: 'tok-splabab-test', createdAt: '2026-11-01T00:00:00Z', revokedAt: null },
    { partner: 'OTHERCO', token: 'tok-otherco-test', createdAt: '2026-11-01T00:00:00Z', revokedAt: null }
  ];
  stampPartnerClients(d, [], { ttlDays: 90, now: Date.parse('2026-11-23T00:00:00Z') });
  return { db: d, cid: d.partnerLinks[0].clientId, other: d.partnerLinks[1].clientId };
}

test('stamping gives each partner its own clientId and stamps only matching campaigns', () => {
  const { db: d, cid, other } = stampDb();
  assert.ok(cid && other && cid !== other);
  assert.equal(d.campaigns.find((c) => c.id === 'a').clientId, cid);
  assert.equal(d.campaigns.find((c) => c.id === 'b').clientId, other);
  assert.equal(d.campaigns.find((c) => c.id === 'c').clientId, undefined, 'an unlinked campaign stays unlinked');
});

test('wrong client: a link for one clientId never shows another client’s campaigns', () => {
  const { db: d, cid, other } = stampDb();
  assert.deepEqual(buildPartnerRows(d, 'SPLABAB', cid).rows.map((r) => r.pid), ['a-c1']);
  assert.deepEqual(buildPartnerRows(d, 'OTHERCO', other).rows.map((r) => r.pid), ['b-c3']);
  /* right label, wrong id */
  assert.equal(buildPartnerRows(d, 'SPLABAB', other).rows.length, 0);
  /* right id, wrong label */
  assert.equal(buildPartnerRows(d, 'OTHERCO', cid).rows.length, 0);
});

test('a retyped or cleared label hides the campaign instead of moving it to another tenant', () => {
  const { db: d, cid, other } = stampDb();
  d.campaigns.find((c) => c.id === 'a').partner = 'OTHERCO';   /* retyped into the other tenant */
  assert.equal(buildPartnerRows(d, 'OTHERCO', other).rows.some((r) => r.pid === 'a-c1'), false);
  assert.equal(buildPartnerRows(d, 'SPLABAB', cid).rows.length, 0);
  d.campaigns.find((c) => c.id === 'a').partner = '';
  assert.equal(buildPartnerRows(d, 'SPLABAB', cid).rows.length, 0);
});

test('two tenants sharing one label are NOT merged once the clientId is used', () => {
  const d = JSON.parse(JSON.stringify(db));
  d.campaigns = [
    { id: 'p', brand: 'P', partner: 'SAME', clientId: 'cl_1' },
    { id: 'q', brand: 'Q', partner: 'SAME', clientId: 'cl_2' }
  ];
  d.participants = [
    { id: 'p-1', campaignId: 'p', creatorId: 'c1', stage: 'confirmed' },
    { id: 'q-1', campaignId: 'q', creatorId: 'c2', stage: 'confirmed' }
  ];
  assert.deepEqual(buildPartnerRows(d, 'SAME', 'cl_1').rows.map((r) => r.pid), ['p-1']);
  assert.deepEqual(buildPartnerRows(d, 'SAME', 'cl_2').rows.map((r) => r.pid), ['q-1']);
});

test('stamping is stable: stored ids and expiries win over a stale browser', () => {
  const first = stampDb();
  const stored = JSON.parse(JSON.stringify(first.db.partnerLinks));
  const stale = JSON.parse(JSON.stringify(db));      /* a browser that predates clientId */
  stale.partnerLinks = [
    { partner: 'SPLABAB', token: 'tok-splabab-test', createdAt: '2026-11-01T00:00:00Z', revokedAt: null },
    { partner: 'OTHERCO', token: 'tok-otherco-test', createdAt: '2026-11-01T00:00:00Z', revokedAt: null }
  ];
  stampPartnerClients(stale, stored, { ttlDays: 90, now: Date.parse('2027-03-01T00:00:00Z') });
  assert.equal(stale.partnerLinks[0].clientId, first.cid);
  assert.equal(stale.partnerLinks[0].expiresAt, stored[0].expiresAt, 'a save must not extend the expiry');
  assert.equal(stale.campaigns.find((c) => c.id === 'a').clientId, first.cid);
});

/* ---- token: expiry, revoke, constant-time path ---------------------------- */
const T0 = Date.parse('2026-11-23T00:00:00Z');
const mk = (links) => ({ db: { partnerLinks: links } });

test('a live link resolves to its partner and clientId', () => {
  const r = resolvePartnerToken(mk([{ partner: 'S', token: 'tok-splabab-test', clientId: 'cl_9',
    expiresAt: '2027-01-01T00:00:00Z' }]), 'tok-splabab-test', T0);
  assert.deepEqual({ ...r }, { partner: 'S', clientId: 'cl_9', legacy: false });
});

test('expired link is refused; the boundary instant is expired', () => {
  const l = (e) => mk([{ partner: 'S', token: 'tok-splabab-test', clientId: 'c', expiresAt: e }]);
  assert.equal(resolvePartnerToken(l('2026-11-22T23:59:59Z'), 'tok-splabab-test', T0), null);
  assert.equal(resolvePartnerToken(l('2026-11-23T00:00:00Z'), 'tok-splabab-test', T0), null);
  assert.ok(resolvePartnerToken(l('2026-11-23T00:00:01Z'), 'tok-splabab-test', T0));
});

test('an unreadable expiresAt fails closed', () => {
  assert.equal(resolvePartnerToken(mk([{ partner: 'S', token: 'tok-splabab-test', expiresAt: 'soon' }]),
    'tok-splabab-test', T0), null);
});

test('a link with no expiresAt still works until a staff save stamps one (legacy)', () => {
  const r = resolvePartnerToken(mk([{ partner: 'S', token: 'tok-splabab-test' }]), 'tok-splabab-test', T0);
  assert.equal(r.legacy, true);
});

test('revoked link is refused', () => {
  assert.equal(resolvePartnerToken(mk([{ partner: 'S', token: 'tok-splabab-test', clientId: 'c',
    revokedAt: '2026-11-01T00:00:00Z' }]), 'tok-splabab-test', T0), null);
});

test('wrong, empty, overlong and non-string tokens are refused', () => {
  const doc = mk([{ partner: 'S', token: 'tok-splabab-test', clientId: 'c' }]);
  ['tok-splabab-tesu', '', 'x'.repeat(500), null, undefined, 123, { a: 1 }, 'tok-splabab-test ', 'tok splabab'].forEach((t) =>
    assert.equal(resolvePartnerToken(doc, t, T0), null, JSON.stringify(t)));
  assert.equal(resolvePartnerToken(null, 'tok-splabab-test', T0), null);
});

test('a hashed-at-rest link (tokenHash, no plaintext) resolves', () => {
  const h = crypto.createHash('sha256').update('tok-hashed-test').digest('hex');
  const r = resolvePartnerToken(mk([{ partner: 'H', tokenHash: h, clientId: 'c' }]), 'tok-hashed-test', T0);
  assert.equal(r.partner, 'H');
  assert.equal(resolvePartnerToken(mk([{ partner: 'H', tokenHash: h, clientId: 'c' }]), 'tok-hashed-tesu', T0), null);
});

test('a stale browser cannot un-revoke a link that is revoked in storage', () => {
  const stored = [{ partner: 'S', token: 'tok-splabab-test', clientId: 'c', revokedAt: '2026-11-10T00:00:00Z' }];
  const d = { campaigns: [], partnerLinks: [{ partner: 'S', token: 'tok-splabab-test', revokedAt: null }] };
  const out = stampPartnerClients(d, stored, { now: T0 });
  assert.equal(out.revokedKept, 1);
  assert.equal(d.partnerLinks[0].revokedAt, '2026-11-10T00:00:00Z');
  assert.equal(resolvePartnerToken({ db: d }, 'tok-splabab-test', T0), null);
});

test('default expiry is 90 days from the save, configurable, and not set on a revoked link', () => {
  const d = { campaigns: [], partnerLinks: [
    { partner: 'S', token: 'tok-aaaaaaaa' },
    { partner: 'R', token: 'tok-bbbbbbbb', revokedAt: '2026-11-01T00:00:00Z' }] };
  stampPartnerClients(d, [], { now: T0, ttlDays: 90 });
  assert.equal(d.partnerLinks[0].expiresAt, new Date(T0 + 90 * 86400000).toISOString());
  assert.equal(d.partnerLinks[1].expiresAt, undefined);
  const e = { campaigns: [], partnerLinks: [{ partner: 'S', token: 'tok-aaaaaaaa' }] };
  stampPartnerClients(e, [], { now: T0, ttlDays: 7 });
  assert.equal(e.partnerLinks[0].expiresAt, new Date(T0 + 7 * 86400000).toISOString());
});

/* The partner view showed a column of other social handles and a column
   of form notes, and on a real link both were empty on every row. They
   are gone from the page, and gone from the payload with it — a field
   nobody reads is a field that should not be leaving the building, and a
   creator's other handles are roster data rather than booking data.
   Anything the partner genuinely needs about a guest goes in `remark`. */
test('a creator\u2019s other handles and form notes do not leave with the payload', () => {
  const out = buildPartnerRows(db, 'SPLABAB');
  const r = out.rows.find((x) => x.pid === 'a-c1');
  assert.equal(r.otherSns, undefined);
  assert.equal(r.notes, undefined);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('tiktok.com/@one'), 'the other-SNS link reached the partner payload');
  assert.ok(!json.includes('\uCC44\uC2DD\uC8FC\uC758\uC790'), 'the form note reached the partner payload');
  /* the column that is still there, and still carries what they need */
  assert.equal(r.remark, '2\uBA85 \uBC29\uBB38 \uC608\uC815');
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

test('the internal note never reaches the partner under any name', () => {
  const json = JSON.stringify(buildPartnerRows(db, 'SPLABAB'));
  assert.ok(!json.includes('INTERNAL'), 'the internal note reached the partner payload');
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

/* ---- follow-up round: empty label, safeHref, limiter bound ---- */

test('a link with an empty partner label resolves to nothing (cannot match unassigned campaigns)', () => {
  const tok = 'tok_emptylabel_1234';
  assert.equal(resolvePartnerToken({ db: { partnerLinks: [{ token: tok, partner: '' }] } }, tok), null);
  assert.equal(resolvePartnerToken({ db: { partnerLinks: [{ token: tok }] } }, tok), null);
  assert.equal(resolvePartnerToken({ db: { partnerLinks: [{ token: tok, partner: '', clientId: 'cl_x' }] } }, tok), null);
});

test('buildPartnerRows with an empty label shows nothing, not the unassigned campaigns', () => {
  const out = buildPartnerRows(db, '');
  assert.deepEqual(out.campaigns, []);
  assert.deepEqual(out.rows, []);
  assert.ok(!JSON.stringify(out).includes('Own'), 'the unassigned campaign leaked');
  assert.deepEqual(buildPartnerRows(db, '', 'cl_x').rows, []);
});

test('partner.html safeHref: https passes, javascript: is blocked, empty/null give an empty string', () => {
  const html = fs.readFileSync(new URL('../partner.html', import.meta.url), 'utf8');
  const line = html.split('\n').find((l) => l.startsWith('const safeHref'));
  assert.ok(line, 'safeHref not found');
  assert.ok(line.includes('/^https?:\\/\\//i'), 'regex must be /^https?:\\/\\//i');
  const f = vm.runInNewContext('(' + line.replace(/^const safeHref = /, '').replace(/;\s*$/, '') + ')', { String });
  assert.equal(f('https://instagram.com/x'), 'https://instagram.com/x');
  assert.equal(f('HTTP://a.b'), 'HTTP://a.b');
  assert.equal(f('javascript:alert(1)'), '');
  assert.equal(f('data:text/html,x'), '');
  assert.equal(f('//evil.com'), '');
  assert.equal(f(''), '');
  assert.equal(f(null), '');
  assert.equal(f(undefined), '');
});

test('the rate limiter stays bounded under many distinct keys and still limits', async () => {
  const { createRequire } = await import('node:module');
  const { rateLimiter } = createRequire(import.meta.url)('../server/booking-routes.js');
  const check = rateLimiter({ windowMs: 60000, max: 3, maxKeys: 100 });
  for (let i = 0; i < 5000; i++) check('k' + i);
  assert.ok(typeof check.size === 'function', 'limiter must expose size()');
  assert.ok(check.size() <= 100, 'map grew to ' + check.size());
  const lim = rateLimiter({ windowMs: 60000, max: 3, maxKeys: 100 });
  assert.deepEqual([1, 2, 3, 4].map(() => lim('same')), [true, true, true, false]);
});
