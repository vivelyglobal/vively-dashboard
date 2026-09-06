import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const auth = require('../server/auth.js');

/* ---- session ids ------------------------------------------------------- */

test('a session id is long, random and hex', () => {
  const a = auth.newSessionId(), b = auth.newSessionId();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('two hundred ids in a row are all different', () => {
  /* it is a bearer credential: a collision is somebody else's session */
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(auth.newSessionId());
  assert.equal(seen.size, 200);
});

/* ---- cookies ----------------------------------------------------------- */

test('a cookie header is parsed into its pairs', () => {
  const c = auth.parseCookies('a=1; vively_session=abc123; b=2');
  assert.equal(c.vively_session, 'abc123');
  assert.equal(c.a, '1');
});

test('a missing or malformed cookie header yields nothing, not a crash', () => {
  for (const h of ['', null, undefined, ';;;', 'novalue', '=orphan']) {
    assert.deepEqual(auth.parseCookies(h).vively_session, undefined, String(h));
  }
});

test('a percent-encoded value comes back decoded', () => {
  assert.equal(auth.parseCookies('vively_session=a%20b').vively_session, 'a b');
});

test('a value containing = keeps everything after the first one', () => {
  assert.equal(auth.parseCookies('vively_session=ab=cd').vively_session, 'ab=cd');
});

test('the session cookie is not readable by script and not sent cross-site', () => {
  const c = auth.sessionCookie('sid123', { secure: true });
  assert.match(c, /^vively_session=sid123;/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Secure/);
  assert.match(c, /Path=\//);
  assert.match(c, /Max-Age=\d+/);
});

test('Secure is left off when the request did not arrive over TLS', () => {
  /* with it on, a cookie set over plain http is silently dropped and the
     login looks broken for no visible reason */
  assert.ok(!/Secure/.test(auth.sessionCookie('sid', { secure: false })));
});

test('clearing sets an empty value that expires immediately', () => {
  const c = auth.clearCookie({ secure: true });
  assert.match(c, /^vively_session=;/);
  assert.match(c, /Max-Age=0/);
  assert.match(c, /HttpOnly/);
});

test('a proxied https request is recognised as secure', () => {
  /* Render terminates TLS in front of the app, so req.secure is false
     even on a genuine https request — the header is the only signal */
  assert.equal(auth.isSecureRequest({ headers: { 'x-forwarded-proto': 'https' } }), true);
  assert.equal(auth.isSecureRequest({ headers: { 'x-forwarded-proto': 'https,http' } }), true);
  assert.equal(auth.isSecureRequest({ headers: { 'x-forwarded-proto': 'http' } }), false);
  assert.equal(auth.isSecureRequest({ headers: {}, secure: true }), true);
  assert.equal(auth.isSecureRequest({ headers: {} }), false);
  assert.equal(auth.isSecureRequest(null), false);
});

/* ---- who is staff ------------------------------------------------------ */

test('the staff list is parsed however it was typed', () => {
  const want = ['a@x.com', 'b@x.com'];
  for (const raw of ['a@x.com,b@x.com', 'a@x.com, b@x.com', 'a@x.com b@x.com',
                     'a@x.com;b@x.com', ' A@X.com , B@x.COM ']) {
    assert.deepEqual(auth.parseStaffList(raw), want, raw);
  }
});

test('entries that are not addresses are dropped', () => {
  assert.deepEqual(auth.parseStaffList('a@x.com, nonsense, , b@x.com'), ['a@x.com', 'b@x.com']);
});

test('staff is matched case-insensitively and ignoring stray spaces', () => {
  const list = auth.parseStaffList('kunzang@vively.com');
  assert.equal(auth.isStaff('Kunzang@Vively.com', list), true);
  assert.equal(auth.isStaff('  kunzang@vively.com  ', list), true);
});

test('an account that is not on the list is not staff', () => {
  /* the case this exists for: creators signed up through the open form,
     and three of the four live accounts are theirs */
  const list = auth.parseStaffList('kunzang@vively.com');
  assert.equal(auth.isStaff('erlynachae@gmail.com', list), false);
  assert.equal(auth.isStaff('jane.adita@daum.net', list), false);
});

test('an unconfigured staff list admits nobody', () => {
  /* fail closed: "not configured" must not read as "everyone", which is
     exactly the bug this whole change exists to fix */
  for (const list of ['', null, undefined, [], '   ', 'not-an-email']) {
    assert.equal(auth.isStaff('kunzang@vively.com', list), false, JSON.stringify(list));
  }
});

test('an empty email is never staff, whatever the list says', () => {
  const list = auth.parseStaffList('a@x.com,b@x.com');
  for (const who of ['', null, undefined, '   ']) {
    assert.equal(auth.isStaff(who, list), false, JSON.stringify(who));
  }
});

test('a raw string works as well as a parsed list', () => {
  assert.equal(auth.isStaff('a@x.com', 'a@x.com, b@x.com'), true);
  assert.equal(auth.isStaff('c@x.com', 'a@x.com, b@x.com'), false);
});

/* ---- session records --------------------------------------------------- */

test('a new session carries the user and an expiry', () => {
  const now = new Date('2026-09-01T00:00:00Z');
  const s = auth.newSession({ id: 'u1', email: 'A@X.com', name: 'A' }, now);
  assert.match(s._id, /^[0-9a-f]{64}$/);
  assert.equal(s.userId, 'u1');
  assert.equal(s.email, 'a@x.com', 'stored folded, so the staff check cannot miss on case');
  assert.equal(s.expiresAt.getTime(), now.getTime() + auth.SESSION_DAYS * 86400000);
});

test('expiry is decided by the record, not by waiting for the sweeper', () => {
  /* a TTL index runs on a timer; a session has to stop working the
     moment it expires, not whenever Mongo next gets round to it */
  const now = new Date('2026-09-15T00:00:00Z');
  const fresh = auth.newSession({ id: 'u', email: 'a@x.com' }, now);
  assert.equal(auth.sessionExpired(fresh, now), false);
  const later = new Date(now.getTime() + (auth.SESSION_DAYS + 1) * 86400000);
  assert.equal(auth.sessionExpired(fresh, later), true);
});

test('a session with no expiry is treated as expired, not as eternal', () => {
  assert.equal(auth.sessionExpired({}, new Date()), true);
  assert.equal(auth.sessionExpired(null, new Date()), true);
  assert.equal(auth.sessionExpired({ expiresAt: 'nonsense' }, new Date()), true);
});
