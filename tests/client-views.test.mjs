import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/* The brand view. Everything here runs against FAKE collections (no Mongo, no
   network) mounted on a real express app on its own port. The status / visit /
   content rules are pulled out of the real server.js, as partner.test.mjs does,
   so the shipping rules are what is under test. */
const require = createRequire(import.meta.url);
const express = require('express');
const CV = require('../server/client-views.js');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const ctx = vm.createContext({ Object, String, Set, RegExp, Math, console, crypto, Buffer, Map, Number });
vm.runInContext(src.slice(src.indexOf('const PARTNER_STATUS = {'), src.indexOf('async function partnerCommentsCollection')) +
  '\nthis.api = { partnerStatusOf, partnerVisitSlot, partnerContentUrl, partnerSafeUrl, PARTNER_STATUS, STAGE_TO_PARTNER };', ctx);
const real = ctx.api;
const helpers = { statusOf: real.partnerStatusOf, visitSlot: real.partnerVisitSlot,
  contentUrl: real.partnerContentUrl, safeUrl: real.partnerSafeUrl };

/* ---------------- a fake Mongo with just the operations the module uses ---------------- */
const dup = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
class Col {
  constructor(name, spy) { this.name = name; this.docs = new Map(); this.unique = []; this.spy = spy; this.failUpdate = false; this.n = 0; }
  _t(op) { this.spy.touched.add(this.name); this.spy.ops.push(this.name + '.' + op); }
  _m(d, f) {
    return Object.entries(f).every(([k, v]) => (v && typeof v === 'object' && '$lt' in v)
      ? d[k] !== undefined && d[k] < v.$lt : d[k] === v);
  }
  async createIndex(spec, o) { this._t('createIndex'); if (o && o.unique) this.unique.push(Object.keys(spec)[0]); }
  _checkUnique(doc, exceptId) {
    for (const [id, d] of this.docs) for (const u of this.unique) if (id !== exceptId && d[u] !== undefined && d[u] === doc[u]) throw dup();
  }
  async findOne(f) { this._t('findOne'); for (const d of this.docs.values()) if (this._m(d, f)) return structuredClone(d); return null; }
  find(f) { this._t('find'); const out = [...this.docs.values()].filter((d) => this._m(d, f)).map((d) => structuredClone(d));
    return { toArray: async () => out }; }
  async insertOne(doc) { this._t('insertOne'); if (this.docs.has(doc._id)) throw dup(); this._checkUnique(doc, null); this.docs.set(doc._id, structuredClone(doc)); return {}; }
  async updateOne(f, u, o) {
    this._t('updateOne');
    if (this.failUpdate) throw new Error('boom');
    if (this.failNth && --this.failNth === 0) throw new Error('boom once');
    for (const [id, d] of this.docs) if (this._m(d, f)) {
      const next = Object.assign({}, d, structuredClone(u.$set)); this._checkUnique(next, id); this.docs.set(id, next); return { matchedCount: 1 };
    }
    if (o && o.upsert) {
      if (this.docs.has(f._id)) throw dup();
      const doc = Object.assign({ _id: f._id }, structuredClone(u.$set)); this._checkUnique(doc, null); this.docs.set(f._id, doc);
    }
    return { matchedCount: 0 };
  }
  async deleteOne(f) { this._t('deleteOne'); for (const [id, d] of this.docs) if (this._m(d, f)) { this.docs.delete(id); return { deletedCount: 1 }; } return { deletedCount: 0 }; }
}
function fakeMongo() {
  const spy = { touched: new Set(), ops: [] };
  const cols = {};
  return { spy, cols, client: { db: () => ({ collection: (n) => (cols[n] = cols[n] || new Col(n, spy)) }) } };
}

/* ---------------- the leak fixture: a sentinel in every real field ---------------- */
const SENT = [];
const S = (label) => { const v = 'SENT_' + label + '_' + crypto.randomBytes(3).toString('hex'); SENT.push(v); return v; };
const CAMP = 'cmp_visible', OTHER = 'cmp_other', CLIENTX = 'cmp_clientx';
function sentinelDb() {
  SENT.length = 0;
  const cid = S('creatorId1'), cid2 = S('creatorId2'), cidRej = S('creatorIdRej');
  const mk = (id, handle, extra) => Object.assign({ id, handle,
    name: S('creator_name'), email: S('email') + '@x.test', phone: S('phone'), contact: S('kakao'), kakao: S('kakao2'),
    address: S('address'), gender: S('gender'), nationality: S('nationality'), country: S('country'),
    otherSns: S('otherSns'), notionUrl: 'https://www.notion.so/' + S('notionUrl'), notionPageId: S('notionPageId'),
    payout: { bank: S('bank'), name: S('bankName'), number: S('bankNumber') }, followers: 123456, notes: S('creatorNotes'),
    memo: S('creatorMemo'), birthday: S('birthday'), tags: [S('tag')] }, extra);
  return {
    campaigns: [
      { id: CAMP, brand: S('brand'), name: 'Sushi Jongno', storeName: S('storeName'), partner: S('partner'), clientId: S('clientId'),
        status: 'live', start: '2026-12-01', end: '2026-12-31', targetCreators: 6, note: S('campNote'), fee: S('campFee'),
        budget: S('budget'), notionUrl: 'https://www.notion.so/' + S('campNotion'), remark: S('campRemark') },
      { id: OTHER, brand: S('otherBrand'), name: S('otherCampaignName'), status: 'live', start: '2026-12-01', end: '2026-12-31' },
      { id: CLIENTX, brand: S('otherClientBrand'), name: S('otherClientCampaign'), partner: S('otherPartner'), status: 'live' }
    ],
    creators: [
      mk(cid, '@onehandle', { followers: 98765 }), mk(cid2, '@twohandle'), mk(cidRej, '@' + S('rejectedHandle')),
      mk(S('c3'), '@' + S('otherCampHandle')), mk(S('c4'), '@' + S('otherClientHandle')),
      mk(S('c5'), '@' + S('contactedHandle')), mk(S('c6'), '@' + S('approvalHandle'))
    ],
    participants: [
      /* shown */
      { id: S('pid1'), campaignId: CAMP, creatorId: cid, stage: 'confirmed', importedStatus: 'Confirmed',
        confirmedVisitAt: '2026-12-05 19:00', visitAt: '2026-12-01 12:00', headcount: '2',
        fullName: S('fullName'), note: S('note'), formNotes: S('formNotes'), remark: S('remark'), fee: S('fee'),
        address: S('pAddress'), otherSns: S('pOtherSns'), acceptMessage: S('accept'), notionUrl: 'https://www.notion.so/' + S('pNotion'),
        notionPageId: S('pNotionPage'), bookingToken: S('bookingToken'), manageToken: S('manageToken'),
        payout: { bank: S('pBank'), number: S('pBankNo') }, content: { url: 'https://www.notion.so/' + S('notionContent') } },
      { id: S('pid2'), campaignId: CAMP, creatorId: cid2, stage: 'shipped', importedStatus: 'Waiting Upload', visitAt: '2026-12-09 11:30', headcount: '1',
        note: S('note2'), remark: S('remark2'), fee: S('fee2'), fullName: S('fullName2') },
      { id: S('pid3'), campaignId: CAMP, creatorId: cid, stage: 'live', importedStatus: 'Uploaded', confirmedVisitAt: '2026-12-05 21:00',
        note: S('note3'), remark: S('remark3') },
      /* never shown: rejected, declined, awaiting approval, contacted, and rows of other campaigns */
      { id: S('pidRej'), campaignId: CAMP, creatorId: cidRej, stage: 'dropped', importedStatus: 'Brand Rejected', note: S('noteRej') },
      { id: S('pidDec'), campaignId: CAMP, creatorId: cidRej, stage: 'dropped', importedStatus: 'Declined' },
      { id: S('pidApp'), campaignId: CAMP, creatorId: 'x', stage: 'shortlisted', importedStatus: 'Waiting Approval' },
      { id: S('pidCon'), campaignId: CAMP, creatorId: 'x', stage: 'contacted' },
      { id: S('pidO'), campaignId: OTHER, creatorId: cid, stage: 'confirmed', importedStatus: 'Confirmed', confirmedVisitAt: '2026-12-20 10:00' },
      { id: S('pidX'), campaignId: CLIENTX, creatorId: cid2, stage: 'confirmed', importedStatus: 'Confirmed' }
    ],
    socialContent: [
      { participantId: null, url: 'https://instagram.com/p/other', caption: S('captionOther') }
    ],
    partnerLinks: [{ partner: S('partnerLabel'), token: S('partnerToken') + 'abcdefgh', clientId: S('plClient') }],
    settings: { secret: S('settingsSecret') }
  };
}
function withContent(db, pidIndex, url) {
  db.socialContent.push({ participantId: db.participants[pidIndex].id, url, postUrl: url, caption: S('caption'), views: 4242, notionUrl: S('scNotion') });
  return db;
}

/* ---------------- harness ---------------- */
async function harness(opts) {
  opts = opts || {};
  const m = fakeMongo();
  const counts = { workspace: 0, revision: 0 };
  let db = opts.db || withContent(sentinelDb(), 2, 'https://www.instagram.com/reel/abc123/');
  let revision = 5;
  let clock = opts.now || Date.parse('2026-11-24T10:00:00Z');
  const cv = CV.createClientViews({
    getMongoClient: async () => m.client, MONGODB_DB: 'testdb', MONGODB_URI: 'fake://',
    loadWorkspaceDoc: async () => { counts.workspace++; return { db, revision, savedAt: '2026-11-24T09:59:00Z' }; },
    getWorkspaceRevision: async () => { counts.revision++; return revision; },
    requireStaff: (handler) => async (req, res) => {
      const u = req.headers['x-test-user'];
      if (!u) return res.status(401).json({ error: 'Sign in' });
      if (u !== 'staff') return res.status(403).json({ error: 'No' });
      req.session = { email: 'staff-person@example.test' };
      return handler(req, res);
    },
    rateLimiter: require('../server/booking-routes.js').rateLimiter,
    clientIp: (req) => String(req.headers['x-test-ip'] || '10.0.0.1'),
    helpers, pageFile: ROOT + 'client.html', ttlDays: opts.ttlDays, now: () => clock,
    log: { error() {}, warn() {}, log() {} }
  });
  const app = express(); app.use(express.json()); cv.mount(app);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (path, o) => {
    o = o || {};
    const r = await fetch(base + path, { method: o.method || 'GET',
      headers: Object.assign({ 'content-type': 'application/json' }, o.staff === false ? {} : o.staff === 'other' ? { 'x-test-user': 'other' } : { 'x-test-user': 'staff' }, o.headers || {}),
      body: o.body ? JSON.stringify(o.body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* page */ }
    return { status: r.status, headers: r.headers, text, json };
  };
  const brand = (path, o) => call(path, Object.assign({ staff: false }, o));
  const create = async (campaignId) => (await call('/api/client-links', { method: 'POST', body: { campaignId: campaignId || CAMP } }));
  return { m, cv, counts, call, brand, create, base, server,
    setDb: (d) => { db = d; }, getDb: () => db, setRev: (r) => { revision = r; }, getRev: () => revision,
    tick: (ms) => { clock += ms; }, close: () => server.close() };
}
const stringify = (x) => JSON.stringify(x);
const NEUTRAL = { error: 'This link is not valid, or has been turned off.' };

/* ================= 1. payload leak test ================= */
test('LEAK: no planted sentinel reaches the brand API response, the page, or the stored view', async () => {
  const h = await harness();
  try {
    const c = await h.create();
    assert.equal(c.status, 200);
    const api = await h.brand('/api/client/' + c.json.token);
    assert.equal(api.status, 200);
    const page = await h.brand('/c/' + c.json.token);
    assert.equal(page.status, 200);
    const stored = stringify([...h.m.cols.client_views.docs.values()].map((d) => d.payload));
    const everything = api.text + page.text + stored;
    assert.ok(SENT.length > 80, 'fixture should plant a sentinel in every field (' + SENT.length + ')');
    for (const s of SENT) assert.ok(!everything.includes(s), 'sentinel leaked: ' + s);
    /* and the strings the brand IS allowed to see are really there, so the test is not vacuous */
    assert.ok(api.text.includes('@onehandle') && api.text.includes('Sushi Jongno'));
    /* the staff create response carries the token once, and no workspace data */
    assert.ok(!c.text.includes('SENT_'), 'staff create response leaked');
    /* the staff list never contains a token, a hash, or the staff identity */
    const list = await h.call('/api/client-links');
    assert.ok(!list.text.includes(c.json.token) && !list.text.includes(CV.sha256Hex(c.json.token)));
    assert.ok(!list.text.includes('staff-person'));
    for (const s of SENT) assert.ok(!list.text.includes(s), 'sentinel in staff list: ' + s);
  } finally { h.close(); }
});

test('LEAK: the response keys equal the allow-list exactly', async () => {
  const h = await harness();
  try {
    const c = await h.create();
    const api = (await h.brand('/api/client/' + c.json.token)).json;
    assert.deepEqual(Object.keys(api).sort(), [...CV.CLIENT_TOP_FIELDS].sort());
    assert.deepEqual(Object.keys(api.campaign).sort(), [...CV.CLIENT_CAMPAIGN_FIELDS].sort());
    assert.deepEqual(Object.keys(api.counts).sort(), [...CV.CLIENT_COUNT_FIELDS].sort());
    assert.deepEqual(Object.keys(api.campaign.status).sort(), ['en', 'key', 'ko']);
    assert.ok(api.rows.length > 0);
    api.rows.forEach((r) => assert.deepEqual(Object.keys(r).sort(), [...CV.CLIENT_ROW_FIELDS].sort()));
    /* the list itself is pinned, so widening it is a visible, reviewed change */
    assert.deepEqual([...CV.CLIENT_ROW_FIELDS], ['handle', 'igUrl', 'bucket', 'visitDate', 'visitTime', 'people', 'contentUrl']);
  } finally { h.close(); }
});

/* ================= 2. list and calendar shape ================= */
test('SHAPE: handles only, three buckets, rejected / declined / contacted / awaiting approval absent, dates sorted', async () => {
  const h = await harness();
  try {
    const c = await h.create();
    const api = (await h.brand('/api/client/' + c.json.token)).json;
    assert.equal(api.campaign.name, 'Sushi Jongno');
    assert.deepEqual(api.campaign.status, { key: 'live', en: 'Live', ko: '진행 중' });
    assert.equal(api.campaign.headcount, 6);
    assert.deepEqual(api.counts, { confirmed: 1, waiting: 1, posted: 1, total: 3 });
    assert.deepEqual(api.rows.map((r) => [r.handle, r.bucket, r.visitDate, r.visitTime]), [
      ['@onehandle', 'confirmed', '2026-12-05', '19:00'],
      ['@onehandle', 'posted', '2026-12-05', '21:00'],
      ['@twohandle', 'waiting', '2026-12-09', '11:30']
    ]);
    assert.equal(api.rows[0].igUrl, 'https://www.instagram.com/onehandle/');
    assert.equal(api.rows[0].people, 2);
    assert.equal(api.rows[1].contentUrl, 'https://www.instagram.com/reel/abc123/');
    assert.equal(api.rows[0].contentUrl, '', 'a Notion link is never a post link');
    assert.match(api.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(api.rows.every((r) => r.visitDate === '' || /^\d{4}-\d{2}-\d{2}$/.test(r.visitDate)));
  } finally { h.close(); }
});

test('SHAPE: every status the partner view can produce maps to a bucket or is withheld (guards a renamed label)', () => {
  const buckets = {};
  for (const [k, st] of Object.entries(real.PARTNER_STATUS)) buckets['ps:' + k] = CV.BUCKET_BY_STATUS_EN[st.en] || null;
  for (const [k, st] of Object.entries(real.STAGE_TO_PARTNER)) buckets['st:' + k] = CV.BUCKET_BY_STATUS_EN[st.en] || null;
  assert.equal(buckets['ps:confirmed'], 'confirmed'); assert.equal(buckets['ps:brand accepted'], 'confirmed');
  assert.equal(buckets['ps:waiting upload'], 'waiting'); assert.equal(buckets['ps:re-schedule'], 'waiting');
  assert.equal(buckets['ps:uploaded'], 'posted');
  for (const k of ['ps:waiting approval', 'ps:brand rejected', 'ps:declined', 'ps:cancelled', 'ps:canceled',
    'st:sourced', 'st:contacted', 'st:replied', 'st:shortlisted', 'st:dropped']) assert.equal(buckets[k], null, k);
  assert.equal(buckets['st:confirmed'], 'confirmed'); assert.equal(buckets['st:shipped'], 'waiting'); assert.equal(buckets['st:live'], 'posted');
});

test('SHAPE: a campaign id claimed twice, or missing, has no view (fail closed)', () => {
  const db = { campaigns: [{ id: 'a', name: 'One' }, { id: 'a', name: 'Two' }, { id: 'b', name: 'B' }], creators: [], participants: [] };
  assert.equal(CV.buildClientView(db, 'a', helpers), null);
  assert.equal(CV.buildClientView(db, 'zzz', helpers), null);
  assert.equal(CV.buildClientView(db, 'b', helpers).campaign.name, 'B');
});

/* ================= 3. token behaviour ================= */
test('TOKEN: wrong, malformed, expired, revoked and regenerated tokens all give the same neutral 404', async () => {
  const h = await harness();
  try {
    const a = await h.create();
    const tok = a.json.token;
    assert.equal((await h.brand('/api/client/' + tok)).status, 200);
    const unknown = await h.brand('/api/client/' + 'x'.repeat(32));
    const malformed = await h.brand('/api/client/short');
    const odd = await h.brand('/api/client/' + encodeURIComponent('a b%c'));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error, NEUTRAL.error);

    /* regenerate: the old token dies at once, the new one lives */
    const id = a.json.link.id;
    const r = await h.call('/api/client-links/' + id + '/regenerate', { method: 'POST' });
    assert.equal(r.status, 200);
    assert.notEqual(r.json.token, tok);
    const replaced = await h.brand('/api/client/' + tok);
    assert.equal((await h.brand('/api/client/' + r.json.token)).status, 200);

    /* revoke: immediate */
    const rv = await h.call('/api/client-links/' + id + '/revoke', { method: 'POST' });
    assert.equal(rv.status, 200);
    const revoked = await h.brand('/api/client/' + r.json.token);
    assert.equal(h.m.cols.client_views.docs.size, 0, 'the brand copy is deleted on revoke');

    /* expiry: 90 days by default, boundary instant counts as expired */
    const b = await h.create(OTHER);
    const link = [...h.m.cols.client_links.docs.values()].find((l) => l.campaignId === OTHER);
    assert.equal(Date.parse(link.expiresAt) - Date.parse(link.createdAt), 90 * 86400000);
    h.tick(90 * 86400000 - 1000);
    assert.equal((await h.brand('/api/client/' + b.json.token)).status, 200, 'still valid a second before');
    h.tick(1000);
    const expired = await h.brand('/api/client/' + b.json.token);

    for (const x of [malformed, odd, replaced, revoked, expired]) {
      assert.equal(x.status, 404);
      assert.deepEqual(x.json, unknown.json, 'one neutral answer, whatever the reason');
    }
    const strip = (r) => [r.headers.get('content-type'), r.headers.get('cache-control')];
    for (const x of [malformed, replaced, revoked, expired]) assert.deepEqual(strip(x), strip(unknown));
  } finally { h.close(); }
});

test('TOKEN: only the sha256 is stored; the token appears once, in the create response', async () => {
  const h = await harness();
  try {
    const a = await h.create();
    const tok = a.json.token;
    assert.match(tok, /^[A-Za-z0-9_-]{32}$/);
    const all = stringify([...h.m.cols.client_links.docs.values(), ...h.m.cols.client_views.docs.values()]);
    assert.ok(!all.includes(tok), 'plaintext token is at rest');
    assert.ok(all.includes(CV.sha256Hex(tok)), 'the hash is what is stored');
    const list = await h.call('/api/client-links');
    assert.ok(!list.text.includes(tok));
    assert.equal(a.json.path, '/c/' + tok);
    /* regenerate shows a different token once, and the old hash is gone */
    const r = await h.call('/api/client-links/' + a.json.link.id + '/regenerate', { method: 'POST' });
    const after = stringify([...h.m.cols.client_links.docs.values()]);
    assert.ok(!after.includes(CV.sha256Hex(tok)) && !after.includes(r.json.token) && after.includes(CV.sha256Hex(r.json.token)));
  } finally { h.close(); }
});

test('TOKEN: create twice is refused (409); Regenerate resets the 90 days and un-revokes', async () => {
  const h = await harness();
  try {
    const a = await h.create();
    assert.equal((await h.create()).status, 409);
    h.tick(30 * 86400000);
    await h.call('/api/client-links/' + a.json.link.id + '/revoke', { method: 'POST' });
    const r = await h.call('/api/client-links/' + a.json.link.id + '/regenerate', { method: 'POST' });
    assert.equal(r.status, 200);
    const l = [...h.m.cols.client_links.docs.values()][0];
    assert.equal(l.revokedAt, null);
    assert.equal(Date.parse(l.expiresAt) - h.getRev() * 0 - (Date.parse('2026-11-24T10:00:00Z') + 30 * 86400000), 90 * 86400000);
    assert.equal((await h.brand('/api/client/' + r.json.token)).status, 200);
    assert.equal(h.m.cols.client_links.docs.size, 1, 'one row per campaign');
  } finally { h.close(); }
});

test('TOKEN: expiry length is configurable (ttlDays)', async () => {
  const h = await harness({ ttlDays: 7 });
  try {
    const a = await h.create();
    const l = [...h.m.cols.client_links.docs.values()][0];
    assert.equal(Date.parse(l.expiresAt) - Date.parse(l.createdAt), 7 * 86400000);
    h.tick(7 * 86400000);
    assert.equal((await h.brand('/api/client/' + a.json.token)).status, 404);
  } finally { h.close(); }
});

test('TOKEN: an unreadable expiry fails closed', () => {
  assert.equal(CV.linkStatus({ expiresAt: 'garbage' }, Date.now()), 'expired');
  assert.equal(CV.linkStatus({ expiresAt: '' }, Date.now()), 'expired');
  assert.equal(CV.linkStatus({ revokedAt: 'x', expiresAt: '2999-01-01' }, Date.now()), 'revoked');
});

/* ================= 4. rate limits and headers ================= */
test('LIMITS: 30 per token per minute, then 429 with Retry-After; 60 per IP across tokens', async () => {
  const h = await harness();
  try {
    const tok = 'a'.repeat(32);
    const s = [];
    for (let i = 0; i < 32; i++) s.push((await h.brand('/api/client/' + tok, { headers: { 'x-test-ip': '9.9.9.' + i } })).status);
    assert.deepEqual([s.slice(0, 30).every((x) => x === 404), s[30], s[31]], [true, 429, 429]);
    const lim = await h.brand('/api/client/' + tok, { headers: { 'x-test-ip': '9.9.9.200' } });
    assert.equal(lim.headers.get('retry-after'), '60');
    const ip = [];
    for (let i = 0; i < 62; i++) ip.push((await h.brand('/api/client/tok' + String(i).padStart(8, '0'), { headers: { 'x-test-ip': '7.7.7.7' } })).status);
    assert.equal(ip[59], 404); assert.equal(ip[60], 429);
    assert.equal((await h.brand('/api/client/tokzzzzzzzzzz', { headers: { 'x-test-ip': '7.7.7.8' } })).status, 404, 'another address is not limited');
  } finally { h.close(); }
});

test('HEADERS: no-store, no-referrer, frame denial, noindex on the page and the API, errors included', async () => {
  const h = await harness();
  try {
    const a = await h.create();
    for (const p of ['/api/client/' + a.json.token, '/api/client/nope-nope-nope', '/c/' + a.json.token, '/c/whatever']) {
      const r = await h.brand(p);
      assert.match(r.headers.get('cache-control'), /no-store/, p);
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer', p);
      assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
      assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/, p);
      assert.match(r.headers.get('x-robots-tag'), /noindex/, p);
    }
    /* the staff routes do not carry the brand-page CSP */
    assert.equal((await h.call('/api/client-links')).headers.get('content-security-policy'), null);
  } finally { h.close(); }
});

/* ================= 5. projection lifecycle ================= */
test('PROJECTION: rebuilt after a save; a slower, older save cannot overwrite a newer view', async () => {
  const h = await harness();
  try {
    const a = await h.create();
    const before = (await h.brand('/api/client/' + a.json.token)).json;
    assert.equal(before.counts.posted, 1);
    /* a staff save at revision 6: the waiting creator has now posted */
    const db6 = withContent(h.getDb(), 1, 'https://www.instagram.com/reel/second/');
    db6.participants[1].importedStatus = 'Uploaded'; db6.participants[1].stage = 'live';
    await h.cv.afterSave(db6, 6, '2026-11-24T11:00:00Z');
    const after = (await h.brand('/api/client/' + a.json.token)).json;
    assert.deepEqual(after.counts, { confirmed: 1, waiting: 0, posted: 2, total: 3 });
    /* the older save (revision 5) lands late */
    const old = structuredClone(db6); old.participants[1].importedStatus = 'Waiting Upload'; old.participants[1].stage = 'shipped';
    await h.cv.afterSave(old, 5, '2026-11-24T10:00:00Z');
    assert.deepEqual((await h.brand('/api/client/' + a.json.token)).json.counts, after.counts, 'newer view must win');
    assert.equal(h.cv.state.failures, 0);
  } finally { h.close(); }
});

test('PROJECTION: a campaign that disappears from the workspace loses its view (fail closed, neutral 404)', async () => {
  const h = await harness();
  try {
    const a = await h.create();
    const db = h.getDb(); db.campaigns = db.campaigns.filter((c) => c.id !== CAMP);
    await h.cv.afterSave(db, 6, 'x');
    assert.equal(h.m.cols.client_views.docs.size, 0);
    assert.equal((await h.brand('/api/client/' + a.json.token)).status, 404);
  } finally { h.close(); }
});

test('PROJECTION: a failed write does not throw, is visible on the staff status endpoint, and the next save retries', async () => {
  const h = await harness();
  try {
    const a = await h.create();
    h.m.cols.client_views.failUpdate = true;
    const db = h.getDb(); db.participants[1].importedStatus = 'Uploaded'; db.participants[1].stage = 'live';
    h.setRev(6);
    await assert.doesNotReject(h.cv.afterSave(db, 6, 'x'));
    const st = (await h.call('/api/client-links/status')).json;
    assert.equal(st.projection.failures, 1);
    assert.match(st.projection.lastError, /failed/);
    assert.equal(st.projection.lastCounts.failed, 1);
    assert.equal(st.staleCount, 1, 'the link is flagged stale: its view is older than the workspace');
    assert.equal(st.links[0].stale, true);
    /* the brand still sees the LAST GOOD copy, with its own older time, not a mix */
    const still = (await h.brand('/api/client/' + a.json.token)).json;
    assert.equal(still.counts.posted, 1);
    /* retry on the next save */
    h.m.cols.client_views.failUpdate = false;
    h.setRev(7);
    await h.cv.afterSave(db, 7, 'y');
    const ok = (await h.call('/api/client-links/status')).json;
    assert.equal(ok.projection.lastError, null);
    assert.equal(ok.staleCount, 0);
    assert.equal((await h.brand('/api/client/' + a.json.token)).json.counts.posted, 2);
  } finally { h.close(); }
});

test('PROJECTION: a database that is down, or throws on connect, never rejects afterSave', async () => {
  const bad = CV.createClientViews({
    getMongoClient: async () => { throw new Error('down'); }, MONGODB_DB: 'x', MONGODB_URI: 'fake://',
    loadWorkspaceDoc: async () => null, getWorkspaceRevision: async () => 0, requireStaff: (f) => f,
    rateLimiter: () => () => true, clientIp: () => 'ip', helpers, pageFile: 'x', log: { error() {} }
  });
  await assert.doesNotReject(bad.afterSave({ campaigns: [] }, 1, 'x'));
  assert.equal(bad.state.failures, 1);
  await assert.doesNotReject(bad.afterSave(null, 2, 'x'));
  await assert.doesNotReject(bad.afterSave({ campaigns: 'nope' }, 3, 'x'));
  const slow = CV.createClientViews({
    getMongoClient: () => new Promise(() => {}), MONGODB_DB: 'x', MONGODB_URI: 'fake://', writeTimeoutMs: 30,
    loadWorkspaceDoc: async () => null, getWorkspaceRevision: async () => 0, requireStaff: (f) => f,
    rateLimiter: () => () => true, clientIp: () => 'ip', helpers, pageFile: 'x', log: { error() {} }
  });
  await assert.doesNotReject(slow.afterSave({ campaigns: [] }, 1, 'x'));
  assert.match(slow.state.lastError, /timeout|failed/);
});

test('PROJECTION: server.js calls afterSave only after the compare-and-set write succeeded, inside try/catch', () => {
  const w = src.indexOf('const wrote = await writeWorkspaceCas');
  const c = src.indexOf('if (wrote.conflict)', w);
  const a = src.indexOf('clientViews.afterSave(', c);
  const r = src.indexOf("return { status: 200, json: { ok: true, savedAt, revision: nextRevision", a);
  assert.ok(w > 0 && c > w && a > c && r > a, 'order: write, conflict return, afterSave, 200');
  assert.match(src.slice(a - 60, a), /try \{/);
  assert.match(src.slice(a, a + 160), /catch \(e\)/);
});

test('ISOLATION: the brand routes never read the workspace, the revision, or any collection but their two', async () => {
  const h = await harness();
  try {
    const a = await h.create();
    const afterCreate = { ...h.counts };
    h.m.spy.touched.clear(); h.m.spy.ops.length = 0;
    for (let i = 0; i < 5; i++) await h.brand('/api/client/' + a.json.token);
    await h.brand('/api/client/' + 'q'.repeat(32));
    await h.brand('/c/' + a.json.token);
    assert.deepEqual(h.counts, afterCreate, 'brand routes called loadWorkspaceDoc / getWorkspaceRevision');
    assert.ok([...h.m.spy.touched].every((n) => n === 'client_links' || n === 'client_views'), [...h.m.spy.touched].join());
    assert.ok(!h.m.spy.ops.some((o) => /insertOne|deleteOne/.test(o)), 'a brand read must not create or delete rows');
    /* afterSave works from the db it is handed, not by re-reading the workspace */
    const before = { ...h.counts };
    await h.cv.afterSave(h.getDb(), 6, 'x');
    assert.deepEqual(h.counts, before);
    assert.equal(h.counts.workspace, 1, 'only the staff create read the workspace');
  } finally { h.close(); }
});

test('REBUILD: staff Rebuild now fills a missing view from the workspace', async () => {
  const h = await harness();
  try {
    const a = await h.create();
    h.m.cols.client_views.docs.clear();
    assert.equal((await h.brand('/api/client/' + a.json.token)).status, 404);
    const r = await h.call('/api/client-links/rebuild', { method: 'POST' });
    assert.deepEqual([r.status, r.json.ok, r.json.written], [200, true, 1]);
    assert.equal((await h.brand('/api/client/' + a.json.token)).status, 200);
  } finally { h.close(); }
});

test('LAST OPENED: set on a brand read, throttled, and carries no viewer identity', async () => {
  const h = await harness();
  try {
    const a = await h.create();
    assert.equal((await h.call('/api/client-links')).json.links[0].lastOpenedAt, null);
    await h.brand('/api/client/' + a.json.token, { headers: { 'user-agent': 'UA_SENTINEL_viewer', 'x-test-ip': '5.5.5.5' } });
    await new Promise((r) => setTimeout(r, 20));
    const l = [...h.m.cols.client_links.docs.values()][0];
    assert.equal(l.lastOpenedAt, '2026-11-24T10:00:00.000Z');
    const doc = stringify(l);
    assert.ok(!doc.includes('UA_SENTINEL') && !doc.includes('5.5.5.5'), 'a viewer identity was stored');
    const writes = h.m.spy.ops.filter((o) => o === 'client_links.updateOne').length;
    await h.brand('/api/client/' + a.json.token); await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.m.spy.ops.filter((o) => o === 'client_links.updateOne').length, writes, 'second read inside a minute is not written');
  } finally { h.close(); }
});

/* ================= 6. staff-only routes ================= */
test('STAFF: every management route is 401 without a session, 403 for a non-staff account, 200 for staff', async () => {
  const h = await harness();
  try {
    const a = await h.create();
    const id = a.json.link.id;
    const routes = [['GET', '/api/client-links'], ['GET', '/api/client-links/status'], ['POST', '/api/client-links', { campaignId: OTHER }],
      ['POST', '/api/client-links/rebuild'], ['POST', '/api/client-links/' + id + '/regenerate'], ['POST', '/api/client-links/' + id + '/revoke']];
    for (const [method, path, body] of routes) {
      assert.equal((await h.call(path, { method, body, staff: false })).status, 401, method + ' ' + path);
      assert.equal((await h.call(path, { method, body, staff: 'other' })).status, 403, method + ' ' + path);
    }
    assert.equal(h.m.cols.client_links.docs.size, 1, 'refused calls created nothing');
    for (const [method, path, body] of routes) assert.equal((await h.call(path, { method, body })).status, 200, method + ' ' + path);
    assert.equal((await h.call('/api/client-links/lnk_doesnotexist1/revoke', { method: 'POST' })).status, 404);
    assert.equal((await h.call('/api/client-links/..%2F/revoke', { method: 'POST' })).status, 404);
    assert.equal((await h.call('/api/client-links', { method: 'POST', body: { campaignId: 'nope' } })).status, 404);
    assert.equal((await h.call('/api/client-links', { method: 'POST', body: {} })).status, 400);
  } finally { h.close(); }
});

test('STAFF: a brand token cannot be used on a staff route', async () => {
  const h = await harness();
  try {
    const a = await h.create();
    for (const p of ['/api/client-links', '/api/client-links/status']) {
      assert.equal((await h.brand(p, { headers: { authorization: 'Bearer ' + a.json.token } })).status, 401);
    }
  } finally { h.close(); }
});

/* ================= 7. escaping on the page ================= */
test('PAGE: hostile values are escaped and only http(s) links open (client.html run against a stub DOM)', async () => {
  const html = fs.readFileSync(ROOT + 'client.html', 'utf8');
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '', setAttribute() {}, addEventListener() {}, querySelectorAll() { return []; } });
  const evil = '<img src=x onerror=alert(1)>"\'';
  const payload = { ok: true, updatedAt: '2026-11-24T10:00:00Z',
    campaign: { name: '<b>Name</b>', start: '2026-12-01', end: '2026-12-31', status: { key: 'live', en: '<i>Live</i>', ko: '진행 중' }, headcount: 6 },
    counts: { confirmed: 1, waiting: 0, posted: 0, total: 1 },
    rows: [{ handle: evil, igUrl: 'javascript:alert(1)', bucket: 'x"onmouseover="y', visitDate: '2026-12-05', visitTime: evil,
      people: evil, contentUrl: 'data:text/html,<script>1</script>' },
      { handle: '@ok', igUrl: 'https://www.instagram.com/ok/', bucket: 'confirmed', visitDate: '2026-12-05', visitTime: '19:00', people: 2,
        contentUrl: 'https://www.instagram.com/p/x"y/' }] };
  const doc = { getElementById: el, documentElement: {}, title: '' };
  const sandbox = { document: doc, navigator: { language: 'en-US' }, location: { pathname: '/c/abcdefgh12345678' },
    fetch: async () => ({ ok: true, status: 200, json: async () => payload }), encodeURIComponent, Date, Number, String, Object, Promise, Set, Array, isNaN, RegExp };
  vm.runInNewContext(script, sandbox);
  await new Promise((r) => setTimeout(r, 30));
  const out = Object.values(els).map((e) => e.innerHTML).join('\n');
  assert.ok(out.includes('@ok'), 'the page rendered');
  assert.ok(!/<img/i.test(out) && !/<script/i.test(out) && !/<i>/i.test(out), 'raw markup reached innerHTML');
  assert.ok(out.includes('&lt;img'), 'the hostile handle is shown as text');
  assert.ok(!/href="javascript:/i.test(out) && !/href="data:/i.test(out), 'a non-http link became an href');
  assert.ok(/href="https:\/\/www\.instagram\.com\/ok\/"/.test(out));
  assert.ok(/instagram\.com\/p\/x&quot;y/.test(out), 'a quote in a link cannot break out of the attribute');
  const m = out.match(/<[^>]*son[a-z]+=/i);
  assert.equal(m, null, 'an event handler attribute got in: ' + (m && m[0]));
  /* the page has no write path at all */
  assert.ok(!/method:\s*'POST'|XMLHttpRequest|<form|localStorage|sendBeacon/.test(script), 'the brand page must be read-only');
});

test('TOKEN: revoke holds even if a brand copy somehow still exists (the link row is checked on every request)', async () => {
  const h = await harness();
  try {
    const a = await h.create();
    const id = a.json.link.id;
    const copy = structuredClone(h.m.cols.client_views.docs.get(id));
    await h.call('/api/client-links/' + id + '/revoke', { method: 'POST' });
    h.m.cols.client_views.docs.set(id, copy);                 /* a stale write put the copy back */
    assert.equal((await h.brand('/api/client/' + a.json.token)).status, 404);
    /* and a rebuild does not resurrect it */
    await h.cv.afterSave(h.getDb(), 9, 'x');
    assert.equal(h.m.cols.client_views.docs.size, 0);
    assert.equal((await h.brand('/api/client/' + a.json.token)).status, 404);
  } finally { h.close(); }
});

/* ================= 8. the real save path ================= */
function realSave(col, clientViews) {
  const a = src.indexOf('async function saveWorkspaceDoc(body) {');
  const b = src.indexOf('\n}\n', a);
  const fn = new Function('getWorkspaceCollection', 'WORKSPACE_ID', 'wsGuard', 'bookingApi', 'bookingStore',
    'stampPartnerClients', 'PARTNER_LINK_TTL_DAYS', 'console', 'writeWorkspaceCas', 'clientViews',
    'return (' + src.slice(a, b + 2) + ');');
  return fn(async () => col, 'shared', require('../server/workspace-guard.js'), null, {}, () => ({ revokedKept: 0 }), 90,
    { error() {}, log() {}, warn() {} }, require('../server/workspace-cas.js').writeWorkspaceCas, clientViews);
}
function wsCol(rev) {
  const c = { doc: { revision: rev, savedAt: 'x', db: { campaigns: [{ id: 'k' }], creators: [], participants: [] } }, writes: 0 };
  c.findOne = async (q, o) => {
    const p = (o && o.projection) || {};
    if (p['db.partnerLinks']) return { db: { partnerLinks: [] } };
    return { revision: c.doc.revision, savedAt: 'x', campaigns: 1, creators: 0, participants: 0 };
  };
  c.updateOne = async (f, u) => { if (f.revision !== c.doc.revision) return { matchedCount: 0 }; c.writes++; c.doc = Object.assign({}, c.doc, u.$set); return { matchedCount: 1 }; };
  return c;
}
const saveBody = (rev) => ({ db: { campaigns: [{ id: 'k' }], creators: [], participants: [] }, settings: {}, revision: rev });

test('SAVE: the real saveWorkspaceDoc hands the projection the saved db and revision, after the write', async () => {
  const seen = [];
  const col = wsCol(3);
  const out = await realSave(col, { afterSave: async (db, rev, at) => { seen.push([col.writes, rev, Array.isArray(db.campaigns), typeof at]); } })(saveBody(3));
  assert.equal(out.status, 200);
  assert.deepEqual(seen, [[1, 4, true, 'string']], 'called once, after exactly one write, with the new revision');
});

test('SAVE: a projection that throws, or a stale save (409), never changes the save result', async () => {
  const col = wsCol(3);
  const out = await realSave(col, { afterSave: async () => { throw new Error('projection down'); } })(saveBody(3));
  assert.equal(out.status, 200);
  assert.equal(out.json.revision, 4);
  let called = 0;
  const stale = await realSave(wsCol(3), { afterSave: async () => { called++; } })(saveBody(1));
  assert.equal(stale.status, 409);
  assert.equal(called, 0, 'no projection for a save that did not happen');
});

test('SAVE: with real failing view writes the save is still 200, the failure is counted, and the next save retries', async () => {
  const h = await harness();
  try {
    const a = await h.create();
    h.m.cols.client_views.failUpdate = true;
    const col = wsCol(5);
    const bodyDb = h.getDb();
    const out = await realSave(col, h.cv)({ db: bodyDb, settings: {}, revision: 5 });
    assert.equal(out.status, 200);
    assert.equal(h.cv.state.failures, 1);
    h.m.cols.client_views.failUpdate = false;
    h.setRev(7);
    const out2 = await realSave(col, h.cv)({ db: bodyDb, settings: {}, revision: 6 });
    assert.equal(out2.status, 200);
    assert.equal(h.cv.state.lastError, null);
    assert.equal(h.cv.state.lastRevision, 7);
    assert.equal((await h.brand('/api/client/' + a.json.token)).status, 200);
  } finally { h.close(); }
});


/* ================= 9. step 5 fixes (security review 35) ================= */
function handleDb(handleValues) {
  /* one confirmed creator per handle value, all in campaign CAMP */
  const db = { campaigns: [{ id: CAMP, name: 'Sushi Jongno', status: 'live' }], creators: [], participants: [], socialContent: [] };
  handleValues.forEach((hv, i) => {
    db.creators.push({ id: 'cr' + i, handle: hv, name: 'Real Name ' + i });
    db.participants.push({ id: 'pp' + i, campaignId: CAMP, creatorId: 'cr' + i, stage: 'confirmed', importedStatus: 'Confirmed',
      confirmedVisitAt: '2026-12-05 1' + (i % 10) + ':00' });
  });
  return db;
}

test('HANDLE: a real full name or any non-handle text in the handle field never reaches the brand', () => {
  const bad = ['Kim Minji', '김민지', 'Minji Kim (kim.minji@example.test)', 'a b', '@' + 'x'.repeat(31), 'https://example.test/kim',
    'https://www.instagram.com/p/abc/', '@@twice', '', '   ', '<img src=x>', 'name@domain.test', '...', '@'];
  const v = CV.buildClientView(handleDb(bad), CAMP, helpers);
  assert.equal(v.rows.length, bad.length);
  const out = stringify(v);
  for (const b of bad) if (b.trim().length > 3) assert.ok(!out.includes(b), 'leaked: ' + b);
  assert.ok(!/Real Name|Kim|김민지|kim\.minji|example\.test/.test(out), 'a name-like value reached the projection');
  v.rows.forEach((r) => { assert.match(r.handle, /^Creator \d+$/); assert.equal(r.igUrl, ''); });
  assert.equal(new Set(v.rows.map((r) => r.handle)).size, bad.length, 'labels are distinct per creator');
});

test('HANDLE: good handles pass; a leading @ is stripped and re-added; a profile URL yields its handle only', () => {
  const v = CV.buildClientView(handleDb(['@one_handle', 'two.handle', 'https://www.instagram.com/three3/?igsh=SECRET#x', 'instagram.com/four.4/', 'x'.repeat(30)]), CAMP, helpers);
  assert.deepEqual(v.rows.map((r) => r.handle).sort(), ['@one_handle', '@two.handle', '@three3', '@four.4', '@' + 'x'.repeat(30)].sort());
  assert.equal(v.rows.find((r) => r.handle === '@three3').igUrl, 'https://www.instagram.com/three3/');
  assert.ok(!stringify(v).includes('SECRET'));
});

test('HANDLE: labels are numbered per campaign, stable when other rows change status', () => {
  const db = handleDb(['Kim Minji', 'Lee Joon', 'Park Soo']);
  const first = CV.buildClientView(db, CAMP, helpers).rows.map((r) => r.handle).sort();
  assert.deepEqual(first, ['Creator 1', 'Creator 2', 'Creator 3']);
  db.participants[0].importedStatus = 'Declined'; db.participants[0].stage = 'dropped';   /* creator 1 leaves the brand's list */
  const later = CV.buildClientView(db, CAMP, helpers).rows.map((r) => r.handle).sort();
  assert.deepEqual(later, ['Creator 2', 'Creator 3'], 'the others keep their numbers');
});

test('URLS: post links must be http(s) on a known social host; query, fragment and credentials are dropped', () => {
  const mk = (url) => { const db = handleDb(['@ok']); db.socialContent = [{ participantId: 'pp0', url, postUrl: url }]; return CV.buildClientView(db, CAMP, helpers).rows[0].contentUrl; };
  assert.equal(mk('https://www.instagram.com/reel/abc123/?igsh=TOKEN123#frag'), 'https://www.instagram.com/reel/abc123/');
  assert.equal(mk('https://vt.tiktok.com/ZS123/?k=1'), 'https://vt.tiktok.com/ZS123/');
  assert.equal(mk('https://www.youtube.com/watch?v=abcDEF12345&token=SECRET&list=x'), 'https://www.youtube.com/watch?v=abcDEF12345');
  assert.equal(mk('https://youtu.be/abcDEF12345?si=SECRET'), 'https://youtu.be/abcDEF12345');
  for (const bad of ['https://example.test/post', 'https://evil.test/instagram.com/p/x', 'https://instagram.com.evil.test/p/x',
    'https://user:pass@www.instagram.com/p/x/', 'javascript:alert(1)', 'ftp://www.instagram.com/p/x', 'https://www.notion.so/abc', 'https://notinstagram.com/p/x']) {
    assert.equal(mk(bad), '', 'accepted: ' + bad);
  }
  assert.equal(mk('https://www.instagram.com/p/' + 'a'.repeat(400) + '/'), '', 'over-long link dropped');
});

test('CAMPAIGN NAME: capped, control and invisible characters removed, email addresses masked', () => {
  const db = handleDb(['@ok']); db.campaigns[0].name = 'Sushi​ ‮gnojgnoj\n  Jongno ' + 'z'.repeat(300) + ' kim@example.test';
  const n = CV.buildClientView(db, CAMP, helpers).campaign.name;
  assert.ok(n.length <= 100 && !/[​‮\n]/.test(n) && !n.includes('example.test'), n);
});

test('STAFF: create and regenerate responses carrying the raw token are no-store', async () => {
  const h = await harness();
  try {
    const a = await h.create();
    const r = await h.call('/api/client-links/' + a.json.link.id + '/regenerate', { method: 'POST' });
    for (const x of [a, r]) {
      assert.ok(x.json.token);
      assert.match(x.headers.get('cache-control') || '', /no-store/);
      assert.equal(x.headers.get('pragma'), 'no-cache');
    }
    assert.match((await h.call('/api/client-links')).headers.get('cache-control') || '', /no-store/);
  } finally { h.close(); }
});

test('REBUILD: a write that fails midway leaves every brand page up; the failure shows on the staff status endpoint', async () => {
  const h = await harness();
  try {
    const t = [];
    for (const id of [CAMP, OTHER, CLIENTX]) t.push((await h.create(id)).json.token);
    h.setRev(6);
    h.m.cols.client_views.failNth = 2;                       /* the second upsert of the rebuild throws */
    const r = await h.call('/api/client-links/rebuild', { method: 'POST' });
    assert.equal(r.json.ok, false);
    assert.equal(r.json.failed, 1);
    assert.equal(h.m.cols.client_views.docs.size, 3, 'no view was taken down');
    for (const tok of t) assert.equal((await h.brand('/api/client/' + tok)).status, 200);
    const st = (await h.call('/api/client-links/status')).json;
    assert.match(st.projection.lastError, /failed/);
    assert.equal(st.projection.lastCounts.failed, 1);
    /* the retry heals it */
    const again = await h.call('/api/client-links/rebuild', { method: 'POST' });
    assert.deepEqual([again.json.ok, again.json.failed, again.json.written], [true, 0, 3]);
    assert.equal((await h.call('/api/client-links/status')).json.projection.lastError, null);
  } finally { h.close(); }
});

test('REBUILD: stale views are deleted only after every upsert succeeded', async () => {
  const h = await harness();
  try {
    const a = await h.create(CAMP), b = await h.create(OTHER);
    const db = h.getDb(); db.campaigns = db.campaigns.filter((c) => c.id !== OTHER);   /* OTHER is gone from the workspace */
    h.m.cols.client_views.failNth = 1;
    await h.cv.afterSave(db, 6, 'x');                       /* the CAMP upsert fails */
    assert.equal(h.m.cols.client_views.docs.size, 2, 'nothing deleted while an upsert failed');
    await h.cv.afterSave(db, 7, 'y');
    assert.equal(h.m.cols.client_views.docs.size, 1, 'deleted once all upserts succeed');
    assert.equal((await h.brand('/api/client/' + a.json.token)).status, 200);
    assert.equal((await h.brand('/api/client/' + b.json.token)).status, 404);
  } finally { h.close(); }
});

test('REBUILD: Rebuild still replaces a view of the same revision (no clear-first needed)', async () => {
  const h = await harness();
  try {
    const a = await h.create();
    const doc = [...h.m.cols.client_views.docs.values()][0]; doc.payload.counts.posted = 99;
    await h.call('/api/client-links/rebuild', { method: 'POST' });
    assert.equal((await h.brand('/api/client/' + a.json.token)).json.counts.posted, 1);
  } finally { h.close(); }
});
