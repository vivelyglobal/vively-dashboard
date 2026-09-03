import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const probe = require('../server/instagram-collab-probe.js');

const TOKEN = 'IGAAQtest-token-0123456789abcdefghijklmnop';

/* ---- redaction --------------------------------------------------------- */

test('the token is replaced wherever it appears', () => {
  const r = probe.redactor(TOKEN);
  assert.equal(r(`?access_token=${TOKEN}&x=1`), '?access_token=‹token›&x=1');
  assert.ok(!r(`a ${TOKEN} b ${TOKEN}`).includes(TOKEN), 'every occurrence, not just the first');
});

test('a value too short to be a token is left alone', () => {
  /* the bug this pins: redacting "x" turned "expired" into "e‹token›pired",
     so a placeholder made the output read as corrupted rather than safe */
  const r = probe.redactor('x');
  assert.equal(r('the token has expired'), 'the token has expired');
  assert.equal(probe.redactor('')('anything'), 'anything');
  assert.equal(probe.redactor(undefined)('anything'), 'anything');
});

/* ---- ownership, the actual question ------------------------------------ */

const m = (id, username, type = 'REELS', permalink = null) => ({
  id, username, media_product_type: type,
  permalink: permalink || `https://www.instagram.com/reel/${id}/`
});

test('media owned by someone else is what proves a collab is ours', () => {
  const out = probe.classifyOwnership(
    [m('a', 'vively.global'), m('b', 'julia.glowwy'), m('c', 'shaily.dev')], 'vively.global');
  assert.equal(out.ownedByUs, 1);
  assert.equal(out.ownedByOthers, 2);
  assert.deepEqual([...out.otherOwners], ['julia.glowwy', 'shaily.dev']);
});

test('an account name is matched regardless of case', () => {
  const out = probe.classifyOwnership([m('a', 'Vively.Global')], 'vively.global');
  assert.equal(out.ownedByUs, 1);
  assert.equal(out.ownedByOthers, 0);
});

test('owner is read from the nested field when the flat one is absent', () => {
  const out = probe.classifyOwnership(
    [{ id: 'x', owner: { username: 'someone.else' } }], 'vively.global');
  assert.equal(out.ownedByOthers, 1);
});

test('media with no owner at all is counted apart, not assumed to be ours', () => {
  /* the dangerous failure: treating "Meta told us nothing" as "it is
     ours" would report a false negative on the whole question */
  const out = probe.classifyOwnership([{ id: 'x' }, { id: 'y' }], 'vively.global');
  assert.equal(out.ownerFieldMissing, 2);
  assert.equal(out.ownedByUs, 0);
  assert.equal(out.ownedByOthers, 0);
});

test('an empty edge does not throw', () => {
  for (const input of [[], null, undefined]) {
    assert.equal(probe.classifyOwnership(input, 'vively.global').total, 0);
  }
});

/* ---- matching against what we already track ---------------------------- */

test('a post is matched to ours however the URL is spelled', () => {
  assert.equal(probe.shortcodeOf('https://www.instagram.com/reel/ABC123/'), 'ABC123');
  assert.equal(probe.shortcodeOf('https://instagram.com/p/ABC123'), 'ABC123');
  assert.equal(probe.shortcodeOf('https://www.instagram.com/reels/ABC123/?igsh=x'), 'ABC123');
  assert.equal(probe.shortcodeOf('https://www.instagram.com/p/ABC123/?hl=en'), 'ABC123');
  assert.equal(probe.shortcodeOf('https://www.instagram.com/p/ABC123/?img_index=1'), 'ABC123');
});

test('a non-Instagram URL yields no shortcode', () => {
  assert.equal(probe.shortcodeOf('https://vt.tiktok.com/ZSVbFyv8Y/'), null);
  assert.equal(probe.shortcodeOf('cant open the ig'), null);
  assert.equal(probe.shortcodeOf(''), null);
  assert.equal(probe.shortcodeOf(null), null);
});

test('the overlap counts our tracked posts that came back', () => {
  const media = [
    m('m1', 'julia.glowwy', 'REELS', 'https://www.instagram.com/reel/Db0ntMnilDr/'),
    m('m2', 'vively.global', 'FEED', 'https://www.instagram.com/p/OWNPOST/')
  ];
  const known = [
    { url: 'https://www.instagram.com/reel/Db0ntMnilDr/', handle: '@julia.glowwy' },
    { url: 'https://www.instagram.com/p/NOTBACK/', handle: '@someone' },
    { url: 'https://vt.tiktok.com/ZSVbFyv8Y/', handle: '@miicha_korea' }
  ];
  const out = probe.overlapWithTracked(media, known);
  assert.equal(out.trackedWithShortcode, 2, 'the TikTok URL has no shortcode and is not counted');
  assert.equal(out.reachable, 1);
  assert.equal(out.matches[0].handle, '@julia.glowwy');
  assert.equal(out.matches[0].mediaId, 'm1');
});

test('overlap survives an empty or missing tracked list', () => {
  assert.equal(probe.overlapWithTracked([m('a', 'x')], []).reachable, 0);
  assert.equal(probe.overlapWithTracked([m('a', 'x')], null).reachable, 0);
});

/* ---- reading a metric -------------------------------------------------- */

test('a metric value is read from either shape Meta uses', () => {
  assert.equal(probe.readInsightValue({ total_value: { value: 85031 } }), 85031);
  assert.equal(probe.readInsightValue({ values: [{ value: 42 }] }), 42);
  assert.equal(probe.readInsightValue({}), null);
  assert.equal(probe.readInsightValue(null), null);
});

test('a zero metric is a value, not a missing one', () => {
  assert.equal(probe.readInsightValue({ total_value: { value: 0 } }), 0);
});

/* ---- a whole run, against a stub --------------------------------------- */

/* No network: fetchImpl is injected. The stub imitates the two things
   the real API does that shape the code — only one version answers, and
   `owner` is rejected as a field. */
function stubFetch(routes) {
  return async (url) => {
    const u = new URL(url);
    const version = (u.pathname.match(/^\/(v\d+\.\d+)\//) || [])[1] || null;
    const rest = u.pathname.replace(/^\/v\d+\.\d+\//, '').replace(/^\//, '');
    const key = `${version || '-'} ${rest}`;
    const handler = routes[key] || routes[rest];
    const body = handler ? handler(u) : { error: { message: 'no stub for ' + key, code: 100 } };
    return { ok: !body.error, status: body.error ? 400 : 200, json: async () => body };
  };
}

const okVersion = 'v23.0';
const baseRoutes = {
  [`${okVersion} me`]: () => ({ id: '178414', username: 'vively.global', account_type: 'BUSINESS', media_count: 9 }),
  [`${okVersion} me/media`]: (u) => {
    if ((u.searchParams.get('fields') || '').includes('owner')) {
      return { error: { message: '(#100) Tried accessing nonexisting field (owner)', code: 100 } };
    }
    return { data: [
      m('own1', 'vively.global', 'FEED', 'https://www.instagram.com/p/OWN1/'),
      m('collab1', 'julia.glowwy', 'REELS', 'https://www.instagram.com/reel/Db0ntMnilDr/')
    ] };
  },
  [`${okVersion} collab1/insights`]: (u) => {
    const asked = (u.searchParams.get('metric') || '').split(',');
    const values = { views: 85031, reach: 71204, saved: 402 };
    if (asked.some((a) => !(a in values))) {
      return { error: { message: '(#100) ' + asked.find((a) => !(a in values)) + ' is not supported', code: 100, error_subcode: 2108006 } };
    }
    return { data: asked.map((a) => ({ name: a, total_value: { value: values[a] } })) };
  }
};

const run = (routes = baseRoutes, over = {}) => probe.runProbe(Object.assign({
  token: TOKEN,
  base: 'https://stub.test',
  fetchImpl: stubFetch(routes),
  spacingMs: 0,
  knownUrls: [{ url: 'https://www.instagram.com/reel/Db0ntMnilDr/', handle: '@julia.glowwy' }]
}, over));

test('a run finds the collab, names the owner and reaches the tracked post', async () => {
  const r = await run();
  assert.equal(r.apiVersion, okVersion, 'it negotiated down to the version that answers');
  assert.equal(r.account.username, 'vively.global');
  assert.equal(r.fieldsUsed, probe.MEDIA_FIELDS_SAFE, 'it retried without the rejected field');
  assert.match(r.fullFieldListRefused, /nonexisting field/);
  assert.equal(r.ownership.ownedByOthers, 1);
  assert.deepEqual([...r.ownership.otherOwners], ['julia.glowwy']);
  assert.equal(r.verdict, 'collabs ARE on our media edge');
  assert.equal(r.trackedOverlap.reachable, 1);
});

test('insights are probed per metric, so one refusal does not hide the rest', async () => {
  const r = await run();
  const [ins] = r.insights;
  assert.equal(ins.mediaId, 'collab1', 'it picked the collab, not our own post');
  assert.match(ins.batchOfAllMetrics, /^refused/, 'asking for all 16 at once fails on the first bad one');
  const got = Object.fromEntries(ins.supported.map((s) => [s.metric, s.value]));
  assert.equal(got.views, 85031);
  assert.equal(got.reach, 71204);
  assert.equal(got.saved, 402);
  assert.ok(ins.refused.length >= 10, 'and the unsupported ones are reported individually');
  assert.equal(ins.supported.length + ins.refused.length, probe.METRICS.length);
});

test('with no collab present it says so rather than inventing one', async () => {
  const routes = Object.assign({}, baseRoutes, {
    [`${okVersion} me/media`]: () => ({ data: [m('own1', 'vively.global', 'REELS', 'https://www.instagram.com/reel/OWN1/')] }),
    [`${okVersion} own1/insights`]: () => ({ data: [{ name: 'views', total_value: { value: 12 } }] })
  });
  const r = await run(routes);
  assert.equal(r.ownership.ownedByOthers, 0);
  assert.equal(r.verdict, 'no media owned by anyone else came back');
  assert.match(r.insights[0].label, /no collab available/);
});

test('media with no owner field is called inconclusive, not negative', async () => {
  const routes = Object.assign({}, baseRoutes, {
    [`${okVersion} me/media`]: () => ({ data: [{ id: 'x', permalink: 'https://www.instagram.com/p/X/' }] })
  });
  const r = await run(routes);
  assert.match(r.verdict, /inconclusive/);
});

test('a dead token is reported as such, and nothing else is attempted', async () => {
  const r = await run({});
  assert.match(r.fatal, /did not work against any API version/);
  assert.equal(r.versionsTried.length, probe.VERSIONS.length, 'every version was tried before giving up');
  assert.equal(r.insights, undefined);
});

test('no token at all fails closed', async () => {
  const r = await probe.runProbe({ token: '', fetchImpl: stubFetch(baseRoutes) });
  assert.match(r.fatal, /No access token/);
  assert.equal(r.calls, 0, 'it must not call Meta without one');
});

test('the token never appears in the report, even when an error echoes it', async () => {
  /* Meta puts the request URL inside some error payloads, so the token
     can arrive back inside a message and get written into the report */
  const routes = Object.assign({}, baseRoutes, {
    [`${okVersion} collab1/insights`]: (u) => ({
      error: { message: 'Bad request: ' + u.toString(), code: 100 }
    })
  });
  const r = await run(routes);
  const serialised = JSON.stringify(r);
  assert.ok(!serialised.includes(TOKEN), 'the token leaked into the report');
  assert.ok(serialised.includes('‹token›'), 'and it was actually redacted, not merely absent');
});

test('every request is a GET', async () => {
  const seen = [];
  await run(baseRoutes, {
    fetchImpl: async (url, init) => {
      seen.push((init && init.method) || 'GET');
      return stubFetch(baseRoutes)(url, init);
    }
  });
  assert.ok(seen.length > 5);
  assert.deepEqual([...new Set(seen)], ['GET']);
});

test('a run stops at its deadline instead of running forever', async () => {
  let clock = 0;
  const r = await run(baseRoutes, { now: () => (clock += 5000), deadlineMs: 12000 });
  assert.equal(r.truncated, true);
});
