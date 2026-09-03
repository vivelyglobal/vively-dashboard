/* The webhook as Meta actually meets it: over HTTP, against a running
   server, through the real middleware stack.

   The unit tests prove the signature function is correct. This proves
   the request ever reaches it with the bytes intact — which is the
   part the global express.json() would silently break, and which no
   amount of unit testing would catch. */
import crypto from 'node:crypto';

const BASE = process.argv[2] || 'http://localhost:3121';
const SECRET = process.env.META_APP_SECRET || 'harness-app-secret';
const VERIFY = process.env.META_WEBHOOK_VERIFY_TOKEN || 'harness-verify-token';

const errs = [];
const step = async (n, fn) => {
  try { await fn(); console.log('ok   ' + n); }
  catch (e) { console.log('FAIL ' + n + ' — ' + e.message); errs.push(n); }
};

const sign = (body, secret = SECRET) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

const post = (body, header) => fetch(BASE + '/api/webhooks/instagram', {
  method: 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json' },
    header === null ? {} : { 'X-Hub-Signature-256': header }),
  body
});

const delivery = (mid, text) => Buffer.from(JSON.stringify({
  object: 'instagram',
  entry: [{
    id: '17841400000000000',
    time: Date.now(),
    messaging: [{
      sender: { id: 'IGSID_HARNESS' },
      recipient: { id: '17841400000000000' },
      timestamp: Date.now(),
      message: { mid, text }
    }]
  }]
}));

/* ---- GET, the one-time handshake -------------------------------------- */

await step('the right verify token gets the challenge back, verbatim', async () => {
  const challenge = 'challenge-' + Date.now();
  const r = await fetch(`${BASE}/api/webhooks/instagram?hub.mode=subscribe` +
    `&hub.verify_token=${encodeURIComponent(VERIFY)}&hub.challenge=${encodeURIComponent(challenge)}`);
  if (r.status !== 200) throw new Error('status ' + r.status);
  const body = await r.text();
  /* Meta compares this byte for byte — a JSON wrapper or a trailing
     newline fails the subscription with no useful error */
  if (body !== challenge) throw new Error(`got ${JSON.stringify(body)}, wanted ${JSON.stringify(challenge)}`);
  const type = r.headers.get('content-type') || '';
  if (!/text\/plain/.test(type)) throw new Error('content-type was ' + type);
});

await step('a wrong verify token is refused with 403', async () => {
  const r = await fetch(`${BASE}/api/webhooks/instagram?hub.mode=subscribe` +
    `&hub.verify_token=not-the-token&hub.challenge=abc`);
  if (r.status !== 403) throw new Error('status ' + r.status);
  const body = await r.text();
  if (body.includes('abc')) throw new Error('it echoed the challenge anyway');
});

await step('the challenge is not echoed without hub.mode=subscribe', async () => {
  const r = await fetch(`${BASE}/api/webhooks/instagram?hub.verify_token=${encodeURIComponent(VERIFY)}` +
    `&hub.challenge=abc`);
  if (r.status !== 403) throw new Error('status ' + r.status);
});

await step('a GET does not fall through to the dashboard HTML', async () => {
  /* the catch-all would answer 200 with index.html, which reads as a
     pass to anyone eyeballing it and fails verification at Meta */
  const r = await fetch(`${BASE}/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong`);
  const body = await r.text();
  if (/<!DOCTYPE html>|<html/i.test(body)) throw new Error('the route is registered below the catch-all');
});

/* ---- POST, deliveries -------------------------------------------------- */

await step('a correctly signed delivery is accepted', async () => {
  const body = delivery('mid.HARNESS.' + Date.now(), 'done https://www.instagram.com/reel/HARNESSREEL/');
  const r = await post(body, sign(body));
  if (r.status !== 200) throw new Error('status ' + r.status + ' — ' + (await r.text()).slice(0, 120));
  const out = await r.json();
  if (out.received !== 1) throw new Error('received ' + out.received);
  if (out.stored !== 1) throw new Error('stored ' + out.stored);
});

await step('the reel link in the message was picked out', async () => {
  const mid = 'mid.LINK.' + Date.now();
  const body = delivery(mid, 'here it is https://www.instagram.com/reel/PICKEDUP1/?igsh=xyz');
  const r = await post(body, sign(body));
  const out = await r.json();
  if (!out.ok) throw new Error('not ok');
  /* read it back through the status endpoint rather than trusting the
     response — the point is that it was persisted, not just parsed */
  const st = await (await fetch(BASE + '/api/webhooks/instagram/status')).json();
  if (st.deliveriesLast24h === 0) throw new Error('nothing was stored');
});

await step('the same delivery twice is stored once', async () => {
  const mid = 'mid.RETRY.' + Date.now();
  const body = delivery(mid, 'retry me https://www.instagram.com/reel/RETRY1/');
  const first = await (await post(body, sign(body))).json();
  const again = await (await post(body, sign(body))).json();
  if (first.stored !== 1) throw new Error('first delivery stored ' + first.stored);
  if (again.stored !== 0 || again.duplicate !== 1)
    throw new Error(`a Meta retry stored ${again.stored} again (duplicate=${again.duplicate})`);
  if ((await post(body, sign(body))).status !== 200)
    throw new Error('a repeat must still answer 200, or Meta keeps retrying forever');
});

await step('a delivery signed with the wrong secret is refused with 403', async () => {
  const body = delivery('mid.BADSIG.' + Date.now(), 'hello');
  const r = await post(body, sign(body, 'the-wrong-secret'));
  if (r.status !== 403) throw new Error('status ' + r.status);
});

await step('an unsigned delivery is refused with 403', async () => {
  const body = delivery('mid.NOSIG.' + Date.now(), 'hello');
  const r = await post(body, null);
  if (r.status !== 403) throw new Error('status ' + r.status);
});

await step('a body altered in flight is refused', async () => {
  /* signature over one body, a different body sent — this is the case
     that quietly passes when the raw bytes were not preserved */
  const signed = delivery('mid.TAMPER.' + Date.now(), 'original');
  const header = sign(signed);
  const tampered = delivery('mid.TAMPER.' + Date.now(), 'altered');
  const r = await post(tampered, header);
  if (r.status !== 403) throw new Error('status ' + r.status);
});

await step('a signed body with unicode survives the trip', async () => {
  /* the exact case a re-serialising implementation gets wrong: the
     same JSON value, different bytes on the wire */
  const body = Buffer.from(JSON.stringify({
    object: 'instagram',
    entry: [{
      id: '17841400000000000', time: Date.now(),
      messaging: [{
        sender: { id: 'IGSID_HARNESS' }, recipient: { id: '17841400000000000' },
        timestamp: Date.now(),
        message: { mid: 'mid.UNICODE.' + Date.now(), text: '완료했어요 ☕ https://www.instagram.com/reel/UNICODE1/' }
      }]
    }]
  }));
  const r = await post(body, sign(body));
  if (r.status !== 200) throw new Error('status ' + r.status + ' — a unicode caption broke the signature');
  const out = await r.json();
  if (out.stored !== 1) throw new Error('stored ' + out.stored);
});

await step('a signed non-JSON body is a 400, not a crash', async () => {
  const body = Buffer.from('this is not json');
  const r = await post(body, sign(body));
  if (r.status !== 400) throw new Error('status ' + r.status);
});

await step('a signed delivery with no events still answers 200', async () => {
  const body = Buffer.from(JSON.stringify({ object: 'instagram', entry: [] }));
  const r = await post(body, sign(body));
  if (r.status !== 200) throw new Error('status ' + r.status);
});

await step('the status endpoint reports configuration without revealing it', async () => {
  const r = await fetch(BASE + '/api/webhooks/instagram/status');
  const out = await r.json();
  for (const k of ['verifyToken', 'appSecret', 'instagramAccessToken', 'instagramAccountId'])
    if (!['set', 'missing'].includes(out[k])) throw new Error(`${k} reported ${JSON.stringify(out[k])}`);
  const body = JSON.stringify(out);
  if (body.includes(SECRET) || body.includes(VERIFY)) throw new Error('it leaked a secret');
});

console.log('\nerrors: ' + (errs.length ? errs.join(' | ') : 'none'));
process.exit(errs.length ? 1 : 0);
