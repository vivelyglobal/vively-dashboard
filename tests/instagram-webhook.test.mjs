import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wh = require('../server/instagram-webhook.js');

const SECRET = 'test-app-secret';
const sign = (body, secret = SECRET) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

/* ---- signature --------------------------------------------------------- */

test('a correctly signed body is accepted', () => {
  const body = Buffer.from('{"object":"instagram"}');
  assert.equal(wh.verifySignature(body, sign(body), SECRET), true);
});

test('a body signed with the wrong secret is refused', () => {
  const body = Buffer.from('{"object":"instagram"}');
  assert.equal(wh.verifySignature(body, sign(body, 'not-our-secret'), SECRET), false);
});

test('a body altered after signing is refused', () => {
  const body = Buffer.from('{"object":"instagram"}');
  const header = sign(body);
  assert.equal(wh.verifySignature(Buffer.from('{"object":"tampered"}'), header, SECRET), false);
});

test('an unsigned request is refused, in every shape of unsigned', () => {
  const body = Buffer.from('{}');
  for (const header of [undefined, null, '', 'sha256=', 'sha1=abc', 'garbage',
                        'sha256=' + 'z'.repeat(64), 'sha256=abc']) {
    assert.equal(wh.verifySignature(body, header, SECRET), false, String(header));
  }
});

test('with no app secret configured nothing verifies', () => {
  /* an unset secret must fail closed — never treat "we cannot check"
     as "the check passed" */
  const body = Buffer.from('{}');
  assert.equal(wh.verifySignature(body, sign(body), ''), false);
  assert.equal(wh.verifySignature(body, sign(body), undefined), false);
});

test('a parsed object is not a signable body', () => {
  /* the whole reason server.js keeps the raw buffer: anything that is
     not the original bytes must be refused rather than re-serialised */
  assert.equal(wh.verifySignature({ object: 'instagram' }, sign(Buffer.from('{}')), SECRET), false);
  assert.equal(wh.verifySignature('{"object":"instagram"}', sign(Buffer.from('{}')), SECRET), false);
});

test('the signature covers the exact bytes, not the equivalent JSON', () => {
  /* same value, different bytes — express.json() would have collapsed
     these to one object and the signature would no longer match */
  const sent = Buffer.from('{"a":"caf\\u00e9"}');
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(sent.toString())));
  assert.notEqual(sent.toString(), reserialised.toString(), 'the fixture must actually differ');
  assert.equal(wh.verifySignature(reserialised, sign(sent), SECRET), false);
});

/* ---- which secret would have worked ------------------------------------ */

const BASIC = 'the-basic-app-secret';
const IGSEC = 'the-instagram-app-secret';
const both = { basic: BASIC, instagram: IGSEC };

test('a refusal is attributed to the candidate that would have verified it', () => {
  const body = Buffer.from('{"object":"instagram"}');
  assert.equal(wh.whichSecretMatched(body, sign(body, BASIC), both), 'basic');
  assert.equal(wh.whichSecretMatched(body, sign(body, IGSEC), both), 'instagram');
});

test('a signature from neither candidate is "none", not a near miss', () => {
  const body = Buffer.from('{"object":"instagram"}');
  assert.equal(wh.whichSecretMatched(body, sign(body, 'some-third-app'), both), 'none');
});

test('an unset candidate is skipped, never matched', () => {
  /* the trap: an empty secret must not be tried at all. If it were, an
     unconfigured slot could be reported as the answer and send someone
     off to copy a value that is not the problem. */
  const body = Buffer.from('{}');
  for (const empty of ['', undefined, null]) {
    assert.equal(wh.whichSecretMatched(body, sign(body, BASIC), { basic: empty, instagram: IGSEC }), 'none');
  }
  assert.equal(wh.whichSecretMatched(body, sign(body, BASIC), {}), 'none');
  assert.equal(wh.whichSecretMatched(body, sign(body, BASIC), null), 'none');
});

test('the answer is only ever a name — never a digest, never a secret', () => {
  /* this is the whole safety property of the diagnostic: it may say
     WHICH secret worked and must never say anything about the value */
  const body = Buffer.from('{"object":"instagram"}');
  for (const header of [sign(body, BASIC), sign(body, IGSEC), sign(body, 'other'), 'garbage', undefined]) {
    const out = wh.whichSecretMatched(body, header, both);
    assert.ok(['basic', 'instagram', 'none'].includes(out), JSON.stringify(out));
    assert.ok(!/[0-9a-f]{16,}/i.test(out), 'a digest leaked into the answer');
    assert.ok(!out.includes(BASIC) && !out.includes(IGSEC), 'a secret leaked into the answer');
  }
});

test('an unsignable body answers "none" rather than throwing', () => {
  for (const b of [null, undefined, '{"object":"instagram"}', { object: 'instagram' }]) {
    assert.equal(wh.whichSecretMatched(b, 'sha256=' + 'a'.repeat(64), both), 'none');
  }
});

test('the same value in both slots resolves to one answer, not an error', () => {
  /* entirely plausible while someone is hunting for the right secret */
  const body = Buffer.from('{}');
  assert.equal(wh.whichSecretMatched(body, sign(body, BASIC), { basic: BASIC, instagram: BASIC }), 'basic');
});

/* ---- who the delivery was for ------------------------------------------ */

const OURS = '17841400000000000';
const envelope = (id) => ({ object: 'instagram', entry: [{ id, time: 1789000000000 }] });

test('a delivery for our own account is told apart from one for another', () => {
  assert.equal(wh.accountVerdict(envelope(OURS), OURS), 'match');
  assert.equal(wh.accountVerdict(envelope('17841499999999999'), OURS), 'different');
});

test('a verdict is given even when there is nothing to compare', () => {
  assert.equal(wh.accountVerdict(envelope(OURS), ''), 'unconfigured');
  assert.equal(wh.accountVerdict({ object: 'instagram' }, OURS), 'absent');
  assert.equal(wh.accountVerdict({ object: 'instagram', entry: [] }, OURS), 'absent');
  assert.equal(wh.accountVerdict(null, OURS), 'absent');
  assert.equal(wh.accountVerdict({ entry: [{}] }, OURS), 'absent');
});

test('the account id itself never comes back — only the verdict', () => {
  /* it is read out of a body that failed verification, so the id is
     compared and dropped rather than returned and stored */
  for (const p of [envelope(OURS), envelope('17841499999999999')]) {
    const v = wh.accountVerdict(p, OURS);
    assert.ok(['match', 'different', 'absent', 'unconfigured'].includes(v));
    assert.ok(!v.includes('1784'), 'an id came back inside the verdict');
  }
});

test('the object of a delivery is reported from a fixed vocabulary', () => {
  /* it comes out of an unverified body, so an unknown value must not be
     passed through — that is a stranger writing into our diagnostics */
  assert.equal(wh.objectKind({ object: 'instagram' }), 'instagram');
  assert.equal(wh.objectKind({ object: 'page' }), 'page');
  assert.equal(wh.objectKind({ object: '<script>alert(1)</script>' }), 'other');
  assert.equal(wh.objectKind({ object: 'x'.repeat(5000) }), 'other');
  assert.equal(wh.objectKind({}), '');
  assert.equal(wh.objectKind(null), '');
});

/* ---- verify token ------------------------------------------------------ */

test('the verify token matches only itself', () => {
  assert.equal(wh.tokensMatch('abc123', 'abc123'), true);
  assert.equal(wh.tokensMatch('abc124', 'abc123'), false);
  assert.equal(wh.tokensMatch('abc123 ', 'abc123'), false, 'a stray space is a different token');
  assert.equal(wh.tokensMatch('', 'abc123'), false);
  assert.equal(wh.tokensMatch(undefined, 'abc123'), false);
});

test('an unset verify token never matches, including against empty', () => {
  assert.equal(wh.tokensMatch('', ''), false);
  assert.equal(wh.tokensMatch(undefined, undefined), false);
});

/* ---- link extraction --------------------------------------------------- */

test('reel and post links are both found', () => {
  const found = wh.extractPostUrls(
    'here you go https://www.instagram.com/reel/ABC123/ and https://instagram.com/p/XYZ789');
  assert.equal(found.length, 2);
  assert.equal(found[0].platformPostId, 'ig_ABC123');
  assert.equal(found[0].kind, 'reel');
  assert.equal(found[1].platformPostId, 'ig_XYZ789');
  assert.equal(found[1].kind, 'post');
});

test('a link is normalised, losing the tracking tail', () => {
  const [f] = wh.extractPostUrls('https://www.instagram.com/reel/ABC123/?igsh=abc&utm_source=x');
  assert.equal(f.url, 'https://www.instagram.com/reel/ABC123/');
});

test('the same reel twice is one link, however it arrived', () => {
  const found = wh.extractPostUrls(
    'https://www.instagram.com/reel/SAME1/ ... https://instagram.com/reels/SAME1/?igsh=z');
  assert.equal(found.length, 1, 'a link and its share attachment are one deliverable');
});

test('a message with no Instagram link yields nothing', () => {
  assert.equal(wh.extractPostUrls('hi! posted it, check my profile').length, 0);
  assert.equal(wh.extractPostUrls('https://www.tiktok.com/@x/video/7301234567890123456').length, 0);
  assert.equal(wh.extractPostUrls('').length, 0);
  assert.equal(wh.extractPostUrls(null).length, 0);
});

test('a profile link is not mistaken for a post', () => {
  assert.equal(wh.extractPostUrls('https://www.instagram.com/somecreator/').length, 0);
});

/* ---- the two URL parsers must not drift apart -------------------------- */

test('the server reads a post id exactly as the dashboard does', () => {
  /* the browser copy lives in index.html and cannot be required from
     CommonJS, so it is lifted out and both are run over one table —
     a duplicated parser is only safe if something notices a drift */
  const src = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    .match(/<script>([\s\S]*)<\/script>/)[1];
  const browserSrc = src.slice(src.indexOf('function platformPostIdOf(url)'),
                               src.indexOf('function platformOfUrl(url, fallback)'));
  const ctx = vm.createContext({ String });
  vm.runInContext(browserSrc + '\nthis.f = platformPostIdOf;', ctx);

  for (const url of [
    'https://www.instagram.com/reel/ABC123/',
    'https://instagram.com/p/XYZ789',
    'https://www.instagram.com/reels/Cx1_ab-cD/?igsh=xyz',
    'https://www.instagram.com/tv/Deff_gh/',
    'https://www.instagram.com/reel/with-dash_and_underscore/'
  ]) {
    assert.equal(wh.instagramPostId(url), ctx.f(url), url);
  }
});

/* ---- parsing a delivery ------------------------------------------------ */

const messageEvent = (over = {}) => ({
  object: 'instagram',
  entry: [{
    id: '17841400000000000',
    time: 1789000000000,
    messaging: [Object.assign({
      sender: { id: 'IGSID_SENDER_1' },
      recipient: { id: '17841400000000000' },
      timestamp: 1789000000000,
      message: { mid: 'mid.ABC123', text: 'done! https://www.instagram.com/reel/ABC123/' }
    }, over)]
  }]
});

test('a messaging delivery yields every field asked for', () => {
  const { object, events } = wh.parseWebhookPayload(messageEvent());
  assert.equal(object, 'instagram');
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.kind, 'message');
  assert.equal(e.senderId, 'IGSID_SENDER_1');
  assert.equal(e.recipientId, '17841400000000000');
  assert.equal(e.messageId, 'mid.ABC123');
  assert.equal(e.timestamp, new Date(1789000000000).toISOString());
  assert.match(e.text, /done!/);
  assert.equal(e.postUrls.length, 1);
  assert.equal(e.postUrls[0].platformPostId, 'ig_ABC123');
});

test('a link shared as an attachment is found too', () => {
  const payload = messageEvent({
    message: {
      mid: 'mid.SHARE1', text: 'here',
      attachments: [{ type: 'share', payload: { url: 'https://www.instagram.com/reel/SHARED9/' } }]
    }
  });
  const [e] = wh.parseWebhookPayload(payload).events;
  assert.equal(e.attachments.length, 1);
  assert.equal(e.postUrls[0].platformPostId, 'ig_SHARED9');
});

test('our own outgoing message is marked as an echo', () => {
  const payload = messageEvent({ message: { mid: 'mid.ECHO', text: 'thanks', is_echo: true } });
  assert.equal(wh.parseWebhookPayload(payload).events[0].isEcho, true);
});

test('a comment or mention change is kept, not discarded', () => {
  const payload = {
    object: 'instagram',
    entry: [{ id: '178414', time: 1789000000, changes: [{ field: 'comments', value: { id: 'c1' } }] }]
  };
  const [e] = wh.parseWebhookPayload(payload).events;
  assert.equal(e.kind, 'change');
  assert.equal(e.field, 'comments');
});

test('seconds and milliseconds both read as the same moment', () => {
  assert.equal(wh.iso(1789000000), wh.iso(1789000000000));
  assert.equal(wh.iso(0), null);
  assert.equal(wh.iso('nonsense'), null);
});

test('an empty or malformed payload yields no events and does not throw', () => {
  for (const p of [{}, null, { entry: null }, { entry: [{}] }, { entry: [{ messaging: null }] }]) {
    assert.equal(wh.parseWebhookPayload(p).events.length, 0, JSON.stringify(p));
  }
});

/* ---- duplicate protection ---------------------------------------------- */

test('the same message id gives the same key, twice', () => {
  const a = wh.parseWebhookPayload(messageEvent()).events[0].dedupKey;
  const b = wh.parseWebhookPayload(messageEvent()).events[0].dedupKey;
  assert.equal(a, b, 'a Meta retry has to land on the same key or it stores twice');
  assert.equal(a, 'mid.ABC123'.length ? 'mid:mid.ABC123' : '');
});

test('two different messages give different keys', () => {
  const a = wh.parseWebhookPayload(messageEvent()).events[0].dedupKey;
  const b = wh.parseWebhookPayload(messageEvent({
    message: { mid: 'mid.OTHER', text: 'hi' }
  })).events[0].dedupKey;
  assert.notEqual(a, b);
});

test('an event with no message id still dedups, on its content', () => {
  const payload = {
    object: 'instagram',
    entry: [{ id: '178414', time: 1789000000, changes: [{ field: 'comments', value: { id: 'c1' } }] }]
  };
  const a = wh.parseWebhookPayload(payload).events[0].dedupKey;
  const b = wh.parseWebhookPayload(payload).events[0].dedupKey;
  assert.equal(a, b);
  assert.match(a, /^ev:[0-9a-f]{32}$/);
});

/* ---- logging ----------------------------------------------------------- */

test('a log line never carries the sender id or the message body', () => {
  const [e] = wh.parseWebhookPayload(messageEvent({
    sender: { id: 'IGSID_PRIVATE_PERSON' },
    recipient: { id: '17841400000000000' },
    timestamp: 1789000000000,
    message: { mid: 'mid.ABC123', text: 'my private message https://www.instagram.com/reel/ABC123/' }
  })).events;
  const line = wh.logLineFor(e);
  assert.ok(!line.includes('IGSID_PRIVATE_PERSON'), 'an Instagram-scoped id identifies a person');
  assert.ok(!line.includes('private message'), 'the body belongs in the database, not in Render logs');
  assert.match(line, /1 link\(s\)/);
});
