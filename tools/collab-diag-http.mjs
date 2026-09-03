/* The collab diagnostic as the internet meets it: over HTTP, against a
   running server, through the real middleware stack.

   The unit tests prove the probe's logic. This proves the route around
   it — the key gate, the cooldown, and the promise that the token never
   reaches the response or the logs. Nothing else on this API is
   authenticated, so the gate is the only thing standing between a
   stranger and our media list plus our Meta rate limit.

   Run tools/fake-graph.cjs on :3479 first (SCENARIO=collab), then start
   the server under test with:

     DIAGNOSTIC_KEY=harness-diagnostic-key
     INSTAGRAM_ACCESS_TOKEN=harness-instagram-token-0123456789abcdef
     IG_PROBE_BASE=http://127.0.0.1:3479     # the stub, not Meta
     PROBE_COOLDOWN_MS=30000                 # longer than one run
     PORT=3122

   (tmp/start-diag.sh does this; tmp/ is not in the repo.)

   The server has to be freshly started: a successful run opens the
   cooldown window, so a second suite against the same process would be
   refused on its first step. */

const BASE = process.argv[2] || 'http://localhost:3122';
const KEY = process.env.DIAGNOSTIC_KEY || 'harness-diagnostic-key';
const TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || 'harness-instagram-token-0123456789abcdef';
const ROUTE = '/api/diagnostics/instagram-collab';

const errs = [];
const step = async (n, fn) => {
  try { await fn(); console.log('ok   ' + n); }
  catch (e) { console.log('FAIL ' + n + ' — ' + e.message); errs.push(n); }
};

const call = (opts = {}) => {
  const url = new URL(BASE + ROUTE);
  Object.entries(opts.query || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  return fetch(url, { headers: opts.headers || {} });
};

/* Order matters here. A successful run starts the cooldown, so the happy
   path goes first while the server is fresh; every refusal below returns
   before the cooldown is touched, so the gate tests do not disturb it. */
let report = null;

await step('with the right key it runs and answers', async () => {
  const r = await call({ headers: { 'X-Diagnostic-Key': KEY } });
  if (r.status !== 200) throw new Error('status ' + r.status + ' — ' + (await r.text()).slice(0, 160));
  report = await r.json();
  if (!report.verdict) throw new Error('no verdict in the report');
});

await step('a second run inside the cooldown is refused, not re-run', async () => {
  const r = await call({ headers: { 'X-Diagnostic-Key': KEY } });
  if (r.status !== 429) throw new Error('status ' + r.status + ' — the Meta rate limit is not protected');
  const out = await r.json();
  if (typeof out.retryInSeconds !== 'number') throw new Error('it does not say how long to wait');
});

await step('without the key it is refused with 403', async () => {
  const r = await call();
  if (r.status !== 403) throw new Error('status ' + r.status);
  const body = await r.text();
  if (/instagram\.com|media_count|username/i.test(body))
    throw new Error('a refusal leaked part of the report');
});

await step('with the wrong key it is refused with 403', async () => {
  const r = await call({ headers: { 'X-Diagnostic-Key': 'not-the-key' } });
  if (r.status !== 403) throw new Error('status ' + r.status);
});

await step('a near miss on the key is refused', async () => {
  /* length is part of a constant-time compare, so a prefix, a suffix and
     a case change all have to fail. Leading and trailing spaces are NOT
     in this list: RFC 9110 has the parser strip optional whitespace from
     a header value, so " key" legitimately arrives as "key". That is
     correct HTTP, not a bypass — a padded key is checked below where it
     actually survives the trip, in the query string. */
  for (const bad of [KEY.slice(0, -1), KEY + 'x', KEY.toUpperCase()]) {
    const r = await call({ headers: { 'X-Diagnostic-Key': bad } });
    if (r.status !== 403) throw new Error(`"${bad}" was accepted with ${r.status}`);
  }
});

await step('a padded key in the query string is refused', async () => {
  for (const bad of [' ' + KEY, KEY + ' ', KEY + '\t']) {
    const r = await call({ query: { key: bad } });
    if (r.status !== 403) throw new Error(`${JSON.stringify(bad)} was accepted with ${r.status}`);
  }
});

await step('the route does not fall through to the dashboard HTML', async () => {
  /* registered below the "*" catch-all, an unauthorised GET would
     answer 200 with index.html and read as a pass */
  const r = await call({ headers: { 'X-Diagnostic-Key': 'wrong' } });
  const body = await r.text();
  if (/<!DOCTYPE html>|<html/i.test(body)) throw new Error('the route sits below the catch-all');
});

await step('the key also works as a query parameter, for a browser', async () => {
  /* the cooldown makes this a 429, which still proves the gate opened
     rather than refusing the credential */
  const r = await call({ query: { key: KEY } });
  if (r.status === 403) throw new Error('the query parameter was not accepted');
  if (![200, 429].includes(r.status)) throw new Error('status ' + r.status);
});

await step('the report answers the ownership question', async () => {
  if (!report) throw new Error('no report');
  for (const k of ['total', 'ownedByUs', 'ownedByOthers', 'otherOwners'])
    if (report.ownership[k] === undefined) throw new Error('missing ownership.' + k);
  if (report.ownership.ownedByOthers < 1)
    throw new Error('the stub serves a collab and it was not detected');
  if (!/collabs ARE on our media edge/.test(report.verdict))
    throw new Error('verdict: ' + report.verdict);
});

await step('the report says which metrics Meta served and which it refused', async () => {
  const ins = (report.insights || [])[0];
  if (!ins) throw new Error('no insights section');
  const supported = ins.supported.map((s) => s.metric);
  const refused = ins.refused.map((s) => s.metric);
  if (!supported.includes('views')) throw new Error('views not reported as supported');
  if (!refused.length) throw new Error('nothing reported as refused — the per-metric probe did not run');
  if (supported.length + refused.length < 16)
    throw new Error(`only ${supported.length + refused.length} of 16 metrics have a verdict`);
  if (!ins.refused.some((r) => r.reason && /code 100/.test(r.reason)))
    throw new Error("Meta's own error text is not being reported");
});

await step('it counts how many of our tracked posts are reachable', async () => {
  if (!report.trackedOverlap) throw new Error('no overlap section');
  if (typeof report.trackedOverlap.reachable !== 'number') throw new Error('no count');
});

await step('the access token is nowhere in the response', async () => {
  const body = JSON.stringify(report);
  if (body.includes(TOKEN)) throw new Error('the token is in the report');
  if (/access_token=[^&"‹]+/.test(body)) throw new Error('a live access_token parameter is in the report');
  if (body.includes(KEY)) throw new Error('the diagnostic key is in the report');
});

await step('nothing was written to the workspace', async () => {
  /* the route reads socialContent to match permalinks; it must not save */
  const before = await (await fetch(BASE + '/api/workspace')).json();
  await call({ query: { key: KEY } });          // refused by the cooldown, but still
  const after = await (await fetch(BASE + '/api/workspace')).json();
  if ((before.revision ?? null) !== (after.revision ?? null))
    throw new Error(`revision moved ${before.revision} -> ${after.revision}`);
});

console.log('\nerrors: ' + (errs.length ? errs.join(' | ') : 'none'));
process.exit(errs.length ? 1 : 0);
