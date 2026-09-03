/* The webhook as Meta actually meets it: over HTTP, against a running
   server, through the real middleware stack.

   The unit tests prove the signature function is correct. This proves
   the request ever reaches it with the bytes intact — which is the
   part the global express.json() would silently break, and which no
   amount of unit testing would catch.

   The server under test has to be started with all five of these, and
   the three secrets have to be DIFFERENT from each other — several
   steps turn on a delivery signed by a candidate still being refused,
   which proves nothing if the candidate is also the real secret:

     META_APP_SECRET=harness-app-secret
     META_WEBHOOK_VERIFY_TOKEN=harness-verify-token
     META_APP_BASIC_SECRET=harness-basic-secret
     META_INSTAGRAM_APP_SECRET=harness-instagram-secret
     INSTAGRAM_ACCOUNT_ID=17841400000000000   # matches entry[].id below

   (tmp/start-webhook.sh does this; tmp/ is not in the repo.) */
import crypto from 'node:crypto';

const BASE = process.argv[2] || 'http://localhost:3121';
const SECRET = process.env.META_APP_SECRET || 'harness-app-secret';
const VERIFY = process.env.META_WEBHOOK_VERIFY_TOKEN || 'harness-verify-token';
/* the two diagnostic candidates the server holds but must never accept */
const BASIC = process.env.META_APP_BASIC_SECRET || 'harness-basic-secret';
const IGSEC = process.env.META_INSTAGRAM_APP_SECRET || 'harness-instagram-secret';
const OUR_ACCOUNT = process.env.INSTAGRAM_ACCOUNT_ID || '17841400000000000';

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

/* ---- the four states must not look like one ---------------------------- */

const status = async () => (await fetch(BASE + '/api/webhooks/instagram/status')).json();

await step('a signed delivery in a shape we do not parse is kept, not silently dropped', async () => {
  /* exactly what Meta's Test button sends: a bare sample, no entry[]
     envelope. This used to answer 200 and leave nothing behind, which
     is why "Test successful" sat next to a count of zero. */
  const before = (await status()).last24h;
  const body = Buffer.from(JSON.stringify({
    field: 'messages',
    /* unique per run: the dedup is content-addressed, so a fixed fixture
       is a duplicate the second time and the step fails against its own
       earlier success */
    run: Date.now(),
    value: {
      sender: { id: '12334' }, recipient: { id: '23245' },
      timestamp: '1527459824', message: { mid: 'random_mid', text: 'random_text' }
    }
  }));
  const r = await post(body, sign(body));
  if (r.status !== 200) throw new Error('status ' + r.status);
  const out = await r.json();
  if (out.received !== 0) throw new Error('it should parse no events, got ' + out.received);
  if (out.unrecognised !== 1) throw new Error('it was not kept: unrecognised=' + out.unrecognised);

  const after = (await status()).last24h;
  if (after.unrecognised !== before.unrecognised + 1)
    throw new Error(`unrecognised went ${before.unrecognised} -> ${after.unrecognised}`);
  if (after.stored !== before.stored)
    throw new Error('an unparsed delivery must not be counted as a stored event');
});

await step('a refused delivery is counted, without keeping what was sent', async () => {
  const before = (await status()).last24h;
  const body = Buffer.from(JSON.stringify({ object: 'instagram', entry: [], secret: 'attacker-payload-' + Date.now() }));
  const r = await post(body, sign(body, 'the-wrong-secret'));
  if (r.status !== 403) throw new Error('status ' + r.status);

  const after = (await status()).last24h;
  if (after.rejected !== before.rejected + 1)
    throw new Error(`rejected went ${before.rejected} -> ${after.rejected}`);
  if (after.stored !== before.stored || after.unrecognised !== before.unrecognised)
    throw new Error('a refused delivery must not count as received content');
});

await step('the body of a refused delivery is not stored anywhere', async () => {
  /* it failed the signature, so it is unverified input from an unknown
     sender — counting it is useful, keeping it is not */
  const marker = 'attacker-payload-' + Date.now();
  const body = Buffer.from(JSON.stringify({ object: 'instagram', evil: marker }));
  await post(body, sign(body, 'the-wrong-secret'));
  const st = await status();
  if (JSON.stringify(st).includes(marker)) throw new Error('the refused body leaked into the status');
});

await step('the four states are each reported separately', async () => {
  const st = await status();
  for (const k of ['received', 'stored', 'unrecognised', 'rejected'])
    if (typeof st.last24h[k] !== 'number') throw new Error('missing count: ' + k);
  const { received, stored, unrecognised, rejected } = st.last24h;
  if (received !== stored + unrecognised + rejected)
    throw new Error(`received ${received} != ${stored} + ${unrecognised} + ${rejected}`);
  if (!st.reading) throw new Error('no plain-language reading');
});

await step('a repeated refusal is counted once, not once per retry', async () => {
  /* this one is deliberately the same body twice WITHIN the run — that is
     what it is testing — but different between runs */
  const body = Buffer.from(JSON.stringify({ object: 'instagram', repeated: 'refusal-' + Date.now() }));
  await post(body, sign(body, 'the-wrong-secret'));
  const a = (await status()).last24h.rejected;
  await post(body, sign(body, 'the-wrong-secret'));
  const b = (await status()).last24h.rejected;
  if (b !== a) throw new Error(`the same refused body counted twice (${a} -> ${b})`);
});

/* ---- which secret would have worked ------------------------------------ */

/* A refused body, unique per run so the content-addressed dedup does not
   swallow it, and addressed to whichever account the server was told is
   ours unless the caller wants otherwise. */
const refusable = (tag, accountId = OUR_ACCOUNT) => Buffer.from(JSON.stringify({
  object: 'instagram',
  entry: [{ id: accountId, time: Date.now(), messaging: [] }],
  tag: tag + '-' + Date.now() + '-' + Math.random()
}));

await step('a refusal signed with the Basic candidate is named as basic', async () => {
  const before = (await status()).signatureCandidates;
  const body = refusable('BASIC');
  const r = await post(body, sign(body, BASIC));
  if (r.status !== 403) throw new Error('a candidate secret was ACCEPTED — status ' + r.status);
  const after = (await status()).signatureCandidates;
  if (after.basic !== before.basic + 1)
    throw new Error(`basic went ${before.basic} -> ${after.basic}`);
  if (after.none !== before.none) throw new Error('it was also counted as unattributed');
});

await step('a refusal signed with the Instagram candidate is named as instagram', async () => {
  const before = (await status()).signatureCandidates;
  const body = refusable('IG');
  const r = await post(body, sign(body, IGSEC));
  if (r.status !== 403) throw new Error('a candidate secret was ACCEPTED — status ' + r.status);
  const after = (await status()).signatureCandidates;
  if (after.instagram !== before.instagram + 1)
    throw new Error(`instagram went ${before.instagram} -> ${after.instagram}`);
});

await step('a refusal signed with neither is named as none', async () => {
  const before = (await status()).signatureCandidates;
  const body = refusable('THIRD');
  await post(body, sign(body, 'a-third-app-entirely'));
  const after = (await status()).signatureCandidates;
  if (after.none !== before.none + 1) throw new Error(`none went ${before.none} -> ${after.none}`);
  if (after.basic !== before.basic || after.instagram !== before.instagram)
    throw new Error('an unattributed refusal was blamed on a candidate');
});

await step('the diagnostic is re-stated when the same body is refused again', async () => {
  /* the dedup key is the body, so the retry of a refusal inserts
     nothing. Send one body signed by nobody, then the SAME body signed
     by a candidate: the verdict has to move, or the diagnosis is only
     ever recorded for bodies never seen before — which, after several
     Meta test deliveries, is none of them. */
  const body = refusable('RESTATE');
  await post(body, sign(body, 'a-third-app-entirely'));
  const mid = (await status()).signatureCandidates;
  await post(body, sign(body, BASIC));
  const after = (await status()).signatureCandidates;
  if (after.basic !== mid.basic + 1 || after.none !== mid.none - 1)
    throw new Error(`the verdict did not move: none ${mid.none}->${after.none}, basic ${mid.basic}->${after.basic}`);
});

await step('a refused delivery is checked against the account we configured', async () => {
  const before = (await status()).rejectedAccountCheck;
  const mine = refusable('MINE', OUR_ACCOUNT);
  await post(mine, sign(mine, 'nobody'));
  const theirs = refusable('THEIRS', '17849999999999999');
  await post(theirs, sign(theirs, 'nobody'));
  const after = (await status()).rejectedAccountCheck;
  if (after.match !== before.match + 1)
    throw new Error(`match went ${before.match} -> ${after.match}`);
  if (after.different !== before.different + 1)
    throw new Error(`different went ${before.different} -> ${after.different}`);
});

await step('the reading names the secret to use, rather than just "it failed"', async () => {
  const st = await status();
  if (!st.reading) throw new Error('no reading');
  if (st.last24h.rejected && !st.last24h.stored && !st.last24h.unrecognised &&
      st.signatureCandidates.basic && !/Basic app secret/.test(st.reading))
    throw new Error('a matched candidate is not mentioned in the reading: ' + st.reading);
  if (!st.appIdNote || !/no app id/i.test(st.appIdNote))
    throw new Error('nothing says whether the app id can be established');
});

await step('neither candidate secret can get a delivery accepted', async () => {
  /* the diagnostic must not have widened what is trusted: exactly one
     secret decides, and it is still META_APP_SECRET */
  for (const [name, secret] of [['basic', BASIC], ['instagram', IGSEC]]) {
    const body = delivery('mid.CANDIDATE.' + name + '.' + Date.now(), 'hello');
    const r = await post(body, sign(body, secret));
    if (r.status !== 403) throw new Error(`the ${name} candidate was accepted — status ${r.status}`);
  }
  const good = delivery('mid.STILLGOOD.' + Date.now(), 'https://www.instagram.com/reel/STILLGOOD/');
  if ((await post(good, sign(good))).status !== 200)
    throw new Error('the real secret stopped working');
});

await step('no secret and no signature appears anywhere in the status', async () => {
  const st = await status();
  const body = JSON.stringify(st);
  for (const [name, s] of [['app', SECRET], ['basic', BASIC], ['instagram', IGSEC], ['verify', VERIFY]])
    if (body.includes(s)) throw new Error('the ' + name + ' secret is in the status');
  /* and no digest either — a calculated signature is as good as an
     oracle for anyone who can post bodies at us */
  const hex = body.match(/[0-9a-f]{32,}/i);
  if (hex) throw new Error('something digest-shaped is in the status: ' + hex[0].slice(0, 12) + '…');
  for (const k of ['basic', 'instagram'])
    if (!['set', 'missing'].includes(st.candidateSecrets[k]))
      throw new Error(`candidateSecrets.${k} reported ${JSON.stringify(st.candidateSecrets[k])}`);
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
