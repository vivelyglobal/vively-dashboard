/* THE PERFORMANCE TAB AND THE "AS OF" CHIP.

   No browser here, so nothing looks at pixels. What is pinned down:
   the words and colours the freshness chip maps to, that every string
   from the snapshot is escaped, that a number nobody read is a dash and
   never a zero, the sort order, the average that leaves blanks out, what
   each failure (not configured, 401, 403, 503, network) says, the body
   the match route is sent, and that nothing money-shaped can reach the
   screen. All data is made up. */

import './helpers/browser-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as V from '../src/views/socialOverview.js';

const HTML = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-25T12:00:00Z');
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const DASH = [{ id: 'dash1', label: 'Brand A · Autumn' }, { id: 'dash2', label: 'Brand D · Delta A' }];
const CTX = { nowMs: NOW, dash: DASH };

beforeEach(() => V.perfReset());

/* ---- a fake snapshot: sentinels sit where a real one must never be read ---- */
const BAD = '<script>alert(1)</script>';
function post(o) {
  return Object.assign({
    deliverableId: 'd?', sheetCampaignId: 'A', platformPostId: 'x', postUrl: 'https://www.instagram.com/p/abc/',
    platform: 'Instagram', creator: { handle: '@ok', platform: 'Instagram', followers: 100 }, type: 'Reel',
    postedDate: '2026-11-20', views: 1000, likes: 100, comments: 5, shares: 1, saves: 2, reposts: 0, er: 5,
    lastScrapedAt: iso(3 * HOUR), flags: { hasReading: true, readingOld: false, neverRead: false },
    /* a snapshot should never carry these; if one did, they must not be drawn */
    rate: 'RATE-SENTINEL-77', amount: 'AMOUNT-SENTINEL-88', email: 'leak@example.test', contact: 'CONTACT-SENTINEL-99', cpe: 'CPE-SENTINEL'
  }, o);
}
function snapshot() {
  return {
    version: 1, checkedAt: iso(12 * MIN), newestReadingAt: iso(3 * HOUR), intervalMin: 30,
    timeZoneNote: 'Dates from the sheet are read as UTC.', erTabs: { read: 2, skipped: [{ tab: 'secret tab', why: 'x' }] },
    campaigns: [
      { sheetCampaignId: 'A', name: 'Autumn ' + BAD, match: { state: 'matched', by: 'manual', dashboardCampaignId: 'dash1', candidates: [], reason: '' }, budget: 'BUDGET-SENTINEL' },
      { sheetCampaignId: 'B', name: 'Beta', match: { state: 'needs-match', by: null, dashboardCampaignId: '', candidates: [], reason: 'no-match' } },
      { sheetCampaignId: 'C', name: 'Gamma', match: { state: 'sheet-only', by: 'manual', dashboardCampaignId: '', candidates: [], reason: '' } },
      { sheetCampaignId: 'D', name: 'Delta', match: { state: 'needs-match', by: null, dashboardCampaignId: '', candidates: [{ id: 'dash2', name: 'Delta A' }], reason: 'ambiguous' } },
      { sheetCampaignId: 'E', name: 'Echo (no readings)', match: { state: 'matched', by: 'name', dashboardCampaignId: 'dash2', candidates: [], reason: '' } }
    ],
    needsMatch: [
      { sheetCampaignId: 'B', name: 'Beta', reason: 'no-match', candidates: [] },
      { sheetCampaignId: 'D', name: 'Delta', reason: 'ambiguous', candidates: [{ id: 'dash2', name: 'Delta A' }] }
    ],
    posts: [
      post({ deliverableId: 'd1', creator: { handle: BAD, platform: 'Instagram', followers: 1 }, postUrl: 'javascript:alert(1)', views: 1000, likes: 100, er: 5 }),
      post({ deliverableId: 'd2', views: null, likes: null, er: null, postedDate: '2026-11-21', flags: { hasReading: false, neverRead: true }, lastScrapedAt: null }),
      post({ deliverableId: 'd3', sheetCampaignId: 'B', creator: { handle: '@tik', platform: 'TikTok', followers: 5 }, platform: 'TikTok', postUrl: 'https://www.tiktok.com/@tik/video/1', views: 5000, likes: 50, er: 3, postedDate: '2026-11-19' }),
      post({ deliverableId: 'd4', views: 300, likes: null, er: 0, postedDate: '2026-11-18', postUrl: 'data:text/html,hi' }),
      post({ deliverableId: 'd5', views: 700, likes: 70, er: 150, postedDate: '2026-11-17', postUrl: '' }),
      post({ deliverableId: 'd6', sheetCampaignId: null, creator: null, views: 40, likes: 4, er: null, postedDate: '2026-11-16', postUrl: 'ftp://x.test/a' }),
      post({ deliverableId: 'd7', sheetCampaignId: 'E', views: null, likes: null, er: null, postedDate: '2026-11-15', flags: { hasReading: false } })
    ]
  };
}
function stateOk(extra) {
  V.perfReset();
  Object.assign(V.PERF, {
    status: { ok: true, enabled: true, dryRun: false, intervalMin: 30 },
    snapResp: { ok: true, state: 'ok', banner: { kind: 'ok', text: '' }, showingDataFrom: iso(12 * MIN),
      freshness: { level: 'green', reason: '', checkedAgeMin: 12, newestReadingAgeHours: 3 }, snapshot: snapshot() }
  }, extra || {});
  return V.PERF;
}
const html = (extra, ctx) => V.perfHtml(stateOk(extra), ctx || CTX);

/* ---------------- the chip ---------------- */

test('freshness: the level is the server\'s, and the words carry the times', () => {
  const fr = (level, reason) => ({ level, reason });
  const g = V.perfFreshness(fr('green', ''), iso(12 * MIN), iso(3 * HOUR), NOW, 30);
  assert.equal(g.level, 'green'); assert.equal(g.word, 'Fresh'); assert.equal(g.shape, 'check');
  assert.equal(g.text, 'Checked 12 min ago · newest post reading 3 h ago');
  const a = V.perfFreshness(fr('amber', 'readings-old'), iso(5 * MIN), iso(60 * HOUR), NOW, 30);
  assert.equal(a.level, 'amber'); assert.equal(a.word, 'Getting old'); assert.equal(a.shape, 'warn');
  assert.ok(a.tip.some((l) => /more than 2 days old/.test(l)));
  const r = V.perfFreshness(fr('red', 'last-run-failed'), iso(5 * MIN), iso(10 * DAY), NOW, 30);
  assert.equal(r.level, 'red'); assert.equal(r.word, 'Out of date'); assert.equal(r.shape, 'cross');
  assert.equal(new Set([g.shape, a.shape, r.shape]).size, 3, 'three different shapes: never colour only');
});
test('freshness: no snapshot yet is grey with its own words, not a fake time', () => {
  const m = V.perfFreshness({ level: 'red', reason: 'no-data' }, null, null, NOW, 30);
  assert.equal(m.level, 'grey'); assert.equal(m.word, 'No data yet'); assert.match(m.text, /Nothing has been read/);
});
test('freshness: with no server level the same thresholds give the same colours', () => {
  const lvl = (cMin, nH) => V.perfLevelFromAges(cMin, nH, 30);
  assert.equal(lvl(10, 3), 'green'); assert.equal(lvl(61, 3), 'amber'); assert.equal(lvl(10, 49), 'amber');
  assert.equal(lvl(10, null), 'amber'); assert.equal(lvl(7 * 1440, 3), 'red'); assert.equal(lvl(10, 7 * 24), 'red');
  assert.equal(V.perfFreshness({}, iso(10 * MIN), iso(49 * HOUR), NOW, 30).level, 'amber');
});
test('chip: shape, word, text, full times (hover and focus) and a keyboard stop', () => {
  const m = V.perfFreshness({ level: 'amber', reason: 'check-late' }, iso(90 * MIN), iso(3 * HOUR), NOW, 30);
  const h = V.perfChipHtml(m);
  assert.match(h, /class="pf-asof pf-amber"/);
  assert.match(h, /tabindex="0"/);
  assert.match(h, /<svg class="pf-ico"[^>]*aria-hidden="true"/);
  assert.match(h, /Getting old/);
  assert.match(h, /Checked: 2026-11-25 19:30 Korea time/);        /* 12:00 UTC minus 90 min = 10:30 UTC = 19:30 KST */
  assert.match(h, /aria-label="Getting old\. Checked 1 h ago/);
  assert.ok(V.perfChipHtml(m, { compact: true }).includes('pf-sm'));
  /* hover and focus both reveal the long form */
  const css = styles();
  assert.match(css, /\.pf-asof:hover \.pf-tip,\.pf-asof:focus \.pf-tip/);
});
test('chip: a hostile word in the text cannot become markup', () => {
  const h = V.perfChipHtml({ level: 'green"><img src=x>', word: BAD, shape: 'check', text: BAD, short: BAD, tip: [BAD] });
  assert.ok(!h.includes('<script>') && !h.includes('<img'));
});
test('legacy chip: its own as-of time, "Out of date" past the thresholds', () => {
  const db = (ago) => ({ socialContent: [{ lastScrapedAt: new Date(NOW - ago).toISOString().slice(0, 10) }, { lastScrapedAt: null }] });
  const fresh = V.perfLegacyFreshness(db(DAY), null, NOW);
  assert.equal(fresh.level, 'green'); assert.equal(fresh.word, 'Fresh'); assert.match(fresh.text, /^Imported numbers as of \d+ Nov$/);
  const old = V.perfLegacyFreshness(db(4 * DAY), null, NOW);
  assert.equal(old.level, 'amber'); assert.equal(old.word, 'Out of date');
  const gone = V.perfLegacyFreshness(db(20 * DAY), null, NOW);
  assert.equal(gone.level, 'red'); assert.equal(gone.word, 'Out of date'); assert.match(gone.text, /20 days ago/);
  const none = V.perfLegacyFreshness({ socialContent: [{ lastScrapedAt: null }] }, null, NOW);
  assert.equal(none.level, 'grey'); assert.match(none.text, /no read time/);
  const viaImport = V.perfLegacyFreshness({ socialContent: [] }, new Date(NOW - 5 * DAY), NOW);
  assert.equal(viaImport.level, 'amber', 'falls back to the time of the last import in this browser');
  assert.ok(V.perfLegacyFreshness(db(20 * DAY), new Date(NOW - 2 * DAY), NOW).tip.some((l) => /Last import in this browser: 2026-11-23/.test(l)));
});

/* ---------------- reading the snapshot ---------------- */

test('urls: only http and https survive', () => {
  assert.equal(V.perfSafeUrl('https://www.instagram.com/p/abc/'), 'https://www.instagram.com/p/abc/');
  assert.equal(V.perfSafeUrl('http://example.test/a?b=1'), 'http://example.test/a?b=1');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hi', 'ftp://x.test/a', '//evil.test', 'https://user:pw@x.test/', '', null, 42, ' javascript:alert(1)', 'https://' + 'a'.repeat(3000)])
    assert.equal(V.perfSafeUrl(bad), '', String(bad).slice(0, 30));
});
test('stats: the average rate leaves blanks, zeros and impossible values out; views never default to 0', () => {
  const posts = snapshot().posts.map(V.perfCleanPost);
  const s = V.perfStats(posts);
  assert.equal(s.posts, 7); assert.equal(s.withReading, 5);
  assert.equal(s.erCount, 2); assert.equal(s.avgEr, 4);                       /* (5 + 3) / 2: the 0, the 150 and the blanks are out */
  assert.equal(s.views, 1000 + 5000 + 300 + 700 + 40); assert.equal(s.viewsRead, 5);
  assert.equal(s.likes, 100 + 50 + 70 + 4); assert.equal(s.likesRead, 4);
  assert.equal(s.creators, 3);                                             /* the post with no creator is not a creator */
  const none = V.perfStats(posts.filter((p) => !p.hasReading));
  assert.equal(none.views, null); assert.equal(none.likes, null); assert.equal(none.avgEr, null);
});
test('stats agree with the server\'s own formula for a campaign', () => {
  const p = snapshot().posts.filter((x) => x.sheetCampaignId === 'A').map(V.perfCleanPost);
  const s = V.perfStats(p);
  assert.equal(s.avgEr, 5); assert.equal(s.erCount, 1);
});
test('top 3: most views, ties to the newer posted date, nulls never ranked', () => {
  const mk = (id, views, posted) => V.perfCleanPost(post({ deliverableId: id, views, postedDate: posted }));
  const top = V.perfTop3([mk('a', 10, '2026-11-01'), mk('b', 10, '2026-11-05'), mk('c', null, '2026-11-09'), mk('d', 99, '2026-11-02'), mk('e', 5, '2026-11-02')]);
  assert.deepEqual(top.map((p) => p.id), ['d', 'b', 'a']);
});
test('sorting: either direction, missing values always last', () => {
  const posts = snapshot().posts.map(V.perfCleanPost);
  const nameOf = (p) => p.campaignId || '';
  const ids = (key, dir) => V.perfSortPosts(posts, { key, dir }, nameOf).map((p) => p.id);
  assert.deepEqual(ids('views', 'desc'), ['d3', 'd1', 'd5', 'd4', 'd6', 'd2', 'd7']);
  assert.deepEqual(ids('views', 'asc'), ['d6', 'd4', 'd5', 'd1', 'd3', 'd2', 'd7']);
  assert.equal(ids('posted', 'desc')[0], 'd2');
  assert.equal(ids('posted', 'asc')[0], 'd7');
  const byHandle = V.perfSortPosts(posts, { key: 'creator', dir: 'asc' }, nameOf).map((p) => p.handle);
  assert.equal(byHandle[byHandle.length - 1], '', 'a post with no creator sorts last');
});
test('timeline: days with no reading are left out, not drawn as zero', () => {
  const posts = snapshot().posts.map(V.perfCleanPost);
  const v = V.perfTimeline(posts, 'views');
  assert.ok(!v.labels.includes('2026-11-21') && !v.labels.includes('2026-11-15'));
  assert.ok(v.values.every((x) => x > 0)); assert.equal(v.leftOut, 2);
  const c = V.perfTimeline(posts, 'count');
  assert.equal(c.labels.length, 7); assert.equal(c.leftOut, 0);
  const e = V.perfTimeline(posts, 'er');
  assert.deepEqual(e.labels, ['2026-11-19', '2026-11-20']); assert.deepEqual(e.values, [3, 5]);
  assert.equal(V.perfTimeline([V.perfCleanPost(post({ postedDate: '' }))], 'count').noDate, 1);
});
test('period filter uses the posted date and counts today', () => {
  const posts = snapshot().posts.map(V.perfCleanPost);
  const n = (period) => V.perfFilterPosts(posts, { period, platform: '', campaign: '' }, NOW).length;
  assert.equal(n('all'), 7); assert.equal(n('7'), 3); /* only 11-19, 11-20 and 11-21 fall in the 7 days 11-19..11-25 */
});

/* ---------------- what is drawn ---------------- */

test('page: a hostile handle, campaign name and url are escaped or dropped everywhere', () => {
  const h = html();
  assert.ok(!h.includes('<script'), 'no script tag anywhere');
  assert.ok(h.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!/href="javascript:/i.test(h) && !/href="data:/i.test(h) && !/href="ftp:/i.test(h));
  const hrefs = [...h.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 2 && hrefs.every((u) => /^https?:\/\//.test(u)), hrefs.join(' | '));
  /* every post link opens a new tab safely */
  for (const m of h.matchAll(/<a [^>]*class="pf-link"[^>]*>/g)) {
    assert.match(m[0], /target="_blank"/); assert.match(m[0], /rel="noopener noreferrer"/);
  }
  /* an attribute-breaking handle in a select option or data attribute stays inside its quotes */
  const P = stateOk();
  P.snapResp.snapshot.needsMatch[0].sheetCampaignId = '"><img src=x onerror=1>';
  P.snapResp.snapshot.needsMatch[0].name = '"><img src=x onerror=1>';
  const h2 = V.perfHtml(P, CTX);
  assert.ok(!h2.includes('"><img'), 'attribute breakout');
});
test('page: nothing money-shaped or personal is drawn, even if the payload carried it', () => {
  const h = html();
  for (const s of ['RATE-SENTINEL', 'AMOUNT-SENTINEL', 'CONTACT-SENTINEL', 'CPE-SENTINEL', 'BUDGET-SENTINEL', 'leak@example.test', 'secret tab'])
    assert.ok(!h.includes(s), s);
  assert.ok(!/\b(cpe|cpv|amount|currency|email|contact|budget|payment|barter|followers)\b/i.test(h.replace(/<style[\s\S]*?<\/style>/g, '')));
});
test('page: five-cell band, then the reading line and the definitions', () => {
  const h = html();
  const band = h.match(/<div class="dk-band pf-band">([\s\S]*?)<\/div>\s*<p class="pf-reading">/);
  assert.ok(band, 'band present');
  assert.equal((band[1].match(/class="dk-b"/g) || []).length, 5);
  for (const l of ['Posts', 'Creators', 'Views', 'Likes', 'Average ER']) assert.ok(band[1].includes('>' + l + '<'), l);
  assert.match(h, /5 of 7 posts have a reading\./);
  assert.match(h, /plain average of the rates the sheet gives/);
  assert.match(h, /mean of 2 posts/); assert.match(h, /4\.00%/);
  assert.match(h, /did not read a number\. It is not zero/);
  assert.match(h, /Dates from the sheet are read as UTC\./);
  assert.match(h, /1 campaign tab had no readable engagement rate/);
});
test('page: a number nobody read is a dash with "did not read", never 0', () => {
  const P = stateOk();
  P.snapResp.snapshot.posts = [post({ deliverableId: 'z', views: null, likes: null, er: null, flags: { hasReading: false } })];
  const h = V.perfHtml(P, CTX);
  const row = h.match(/<tbody>\s*<tr>[\s\S]*?<\/tr>/g).pop();
  assert.ok(row.includes('<span class="pf-na">—<span class="sr-only"> did not read</span></span>'));
  assert.ok(row.includes('no rate given'));
  assert.ok(!/<td class="num">\s*0\s*<\/td>/.test(row));
  assert.match(h, /Not measured/);
  assert.match(h, /0 of 1 posts have a reading\./);
});
test('page: a campaign with posts and no reading says Not measured', () => {
  const h = html();
  const echo = h.match(/<tr>\s*<th scope="row" class="strong">Echo \(no readings\)<\/th>[\s\S]*?<\/tr>/);
  assert.ok(echo, 'Echo row'); assert.ok(echo[0].includes('Not measured'));
  assert.match(echo[0], /Matched: Brand D · Delta A/);
});
test('page: campaigns, platforms, top 3 and the table are all there', () => {
  const h = html();
  assert.match(h, /<h4>Campaigns<\/h4>/); assert.match(h, /<h4>Platforms<\/h4>/);
  assert.match(h, /Top 3 posts by views/);
  const top = h.match(/<ol class="pf-top">([\s\S]*?)<\/ol>/)[1];
  assert.equal((top.match(/<li class="pf-tc">/g) || []).length, 3);
  assert.ok(top.indexOf('5,000') < top.indexOf('1,000'));
  assert.match(h, /Timeline by posted date/);
  for (const k of ['views', 'likes', 'er', 'count']) assert.ok(h.includes(`data-pf-metric="${k}"`));
});
test('table: real headers, aria-sort on the sorted one, keyboard-native sort buttons', () => {
  const h = html({ sort: { key: 'views', dir: 'desc' } });
  const table = h.match(/<table class="tbl pf-table pf-posts">[\s\S]*?<\/table>/)[0];
  assert.match(table, /<th scope="col" class="num" aria-sort="descending"><button type="button" class="pf-sort" data-pf-sort="views">/);
  assert.equal((table.match(/aria-sort="none"/g) || []).length, 7);
  assert.ok(!/<th[^>]*data-pf-sort/.test(table), 'the control is a real button inside the header');
  const asc = html({ sort: { key: 'views', dir: 'asc' } });
  assert.match(asc, /aria-sort="ascending"/);
  const order = [...table.matchAll(/<th scope="row" class="strong">([^<]*)<\/th>/g)].map((m) => m[1]);
  assert.equal(order[0], '@tik');                                          /* 5,000 views first */
});
test('table: shows the first hundred and offers more', () => {
  const P = stateOk();
  P.snapResp.snapshot.posts = Array.from({ length: 130 }, (_, i) => post({ deliverableId: 'p' + i, views: i + 1 }));
  const h = V.perfHtml(P, CTX);
  assert.equal((h.match(/<a [^>]*class="pf-link"/g) || []).length, 100 + 3 /* top 3 cards */);
  assert.match(h, /Showing 100 of 130 posts\./); assert.ok(h.includes('data-pf-more="1"'));
});
test('filters: platform and period narrow the band; a campaign opens the campaign view', () => {
  const tik = html({ platform: 'TikTok' });
  assert.match(tik, /1 of 1 posts have a reading\./);
  const camp = html({ campaign: 'A' });
  assert.match(camp, /data-pf-back="1"/); assert.ok(!/<h4>Campaigns<\/h4>/.test(camp), 'campaign view has no campaigns table');
  assert.match(camp, /<h3 class="pf-title">Autumn &lt;script&gt;/);
  assert.match(camp, /Matched: Brand A · Autumn/);
  assert.match(camp, /id="pfPeriod"/);
  assert.ok(!/Needs a match <span/.test(camp), 'a matched campaign shows no match card');
  assert.match(html({ campaign: 'ZZZ' }), /<h4>Campaigns<\/h4>/, 'an unknown campaign id falls back to the global view');
});
test('needs a match: listed with a select, a Save button, and Sheet only grouped quietly', () => {
  const h = html();
  /* only a campaign a person must decide (ambiguous, shared) is loud; "no match" is quiet */
  assert.match(h, /Needs a match <span class="so-hint">1 campaign<\/span>/);
  const loud = h.slice(h.indexOf('Needs a match'), h.indexOf('<details class="pf-quiet"'));
  assert.ok(loud.includes('Delta</strong>') && !loud.includes('Beta</strong>') && !loud.includes('Gamma</strong>'), 'Beta (no-match) is not in the loud card');
  assert.ok(!loud.includes('No dashboard campaign has this name.'));
  const quiet = h.slice(h.indexOf('<details class="pf-quiet"'));
  assert.ok(quiet.includes('Beta</strong>') && quiet.includes('Gamma</strong>'), 'no-match and sheet-only share the quiet group');
  assert.match(quiet, /No dashboard campaign has this name\./);
  assert.match(h, /<optgroup label="Suggested"><option value="dash2">Delta A<\/option>/);
  assert.match(h, /<option value="__sheet_only__">Sheet only \(not in the dashboard\)<\/option>/);
  assert.equal((h.match(/data-pf-save=/g) || []).length, 3, 'one to match, two quiet rows');
  assert.match(h, /<details class="pf-quiet"><summary>Sheet only \(2\)<\/summary>/);
  assert.ok(!/<details class="pf-quiet" open/.test(h));
  const withMsg = html({ matchMsg: { B: 'That dashboard campaign does not exist.' }, picks: { B: 'dash1' } });
  assert.match(withMsg, /role="status">That dashboard campaign does not exist\./);
  assert.match(withMsg, /<option value="dash1" selected>/);
});
test('refresh: the button, its busy state and the status text', () => {
  assert.match(html(), /data-pf-refresh="1">Refresh now<\/button>/);
  const busy = html({ refresh: { busy: true, text: 'Reading the sheet…' } });
  assert.match(busy, /disabled aria-busy="true">Reading…<\/button>/);
  assert.match(busy, /<p class="pf-msg">Reading the sheet…<\/p>/);
});
test('phone and touch: 40px targets, one column at 640px, no hard-coded colours', () => {
  const css = styles();
  assert.match(css, /\.pf \.btn,\.pf select,\.pf-sort\{min-height:var\(--hit,40px\)\}/);
  assert.match(css, /@media\(max-width:640px\)\{\s*\.pf-top\{grid-template-columns:1fr\}\s*\.pf-mrow\{grid-template-columns:1fr\}/);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(css), 'colours come from tokens');
  for (const v of new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1])))
    assert.ok(new RegExp(v + '\\s*:').test(HTML), v + ' is defined');
});

/* ---------------- the failures ---------------- */

function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const r = routes[(init && init.method ? init.method + ' ' : '') + url];
    if (r === 'throw') throw new TypeError('network');
    const x = typeof r === 'function' ? r(init) : r;
    return { ok: x.status < 400, status: x.status, json: async () => x.body };
  };
  f.calls = calls;
  return f;
}
const OK_ROUTES = () => ({
  '/api/perf/status': { status: 200, body: { ok: true, enabled: true, dryRun: false, intervalMin: 30 } },
  '/api/perf/snapshot': { status: 200, body: { ok: true, state: 'ok', banner: { kind: 'ok', text: '' }, freshness: { level: 'green' }, snapshot: snapshot() } }
});
const bothFail = (status, body) => ({ '/api/perf/status': { status, body }, '/api/perf/snapshot': { status, body } });

test('load: both routes once, then 30 seconds of cache, then again', async () => {
  const f = fakeFetch(OK_ROUTES());
  await V.perfLoad({ fetchImpl: f, nowMs: 1000 });
  assert.deepEqual(f.calls.map((c) => c.url).sort(), ['/api/perf/snapshot', '/api/perf/status']);
  await V.perfLoad({ fetchImpl: f, nowMs: 1000 + 29000 });
  assert.equal(f.calls.length, 2, 'inside 30 s: no new request');
  await V.perfLoad({ fetchImpl: f, nowMs: 1000 + 31000 });
  assert.equal(f.calls.length, 4);
  await V.perfLoad({ fetchImpl: f, nowMs: 1000 + 32000, force: true });
  assert.equal(f.calls.length, 6);
  assert.ok(V.PERF.snapResp.snapshot.posts.length);
});
test('load: two opens at once share one pair of requests', async () => {
  const f = fakeFetch(OK_ROUTES());
  await Promise.all([V.perfLoad({ fetchImpl: f }), V.perfLoad({ fetchImpl: f })]);
  assert.equal(f.calls.length, 2);
});
test('not configured (503 off): the plain sentence, nothing else drawn', async () => {
  await V.perfLoad({ fetchImpl: fakeFetch(bothFail(503, { error: 'Live performance is switched off. Ask the admin to set the sheet.', reason: 'PERF_SHEET_ID', state: 'off' })) });
  assert.equal(V.PERF.problem.kind, 'off');
  const h = V.perfHtml(V.PERF, CTX);
  assert.ok(h.includes('Live performance is switched off. Ask the admin to set the sheet.'));
  assert.ok(!h.includes('data-pf-refresh') && !h.includes('pf-asof') && !h.includes('dk-band'));
  assert.ok(!h.includes('PERF_SHEET_ID'), 'the env name is not echoed');
});
test('signed out (401) and not staff (403)', async () => {
  await V.perfLoad({ fetchImpl: fakeFetch(bothFail(401, { error: 'Sign in first.' })) });
  assert.equal(V.PERF.problem.kind, 'signin'); assert.match(V.perfHtml(V.PERF, CTX), /You are signed out\. Sign in as staff/);
  V.perfReset();
  await V.perfLoad({ fetchImpl: fakeFetch(bothFail(403, { error: 'Staff only.' })) });
  assert.equal(V.PERF.problem.kind, 'forbidden'); assert.match(V.perfHtml(V.PERF, CTX), /for staff only/);
  assert.ok(!V.perfHtml(V.PERF, CTX).includes('data-pf-refresh'), 'no refresh button for a non-staff account');
});
test('a 401 after a good read clears what was on screen', async () => {
  await V.perfLoad({ fetchImpl: fakeFetch(OK_ROUTES()), nowMs: 1 });
  assert.ok(V.PERF.snapResp);
  await V.perfLoad({ fetchImpl: fakeFetch(bothFail(401, {})), nowMs: 100000 });
  assert.equal(V.PERF.snapResp, null);
  assert.ok(!V.perfHtml(V.PERF, CTX).includes('dk-band'));
});
test('503 that is not "off" shows what the server said, escaped', async () => {
  await V.perfLoad({ fetchImpl: fakeFetch(bothFail(503, { error: 'Database is busy ' + BAD })) });
  assert.equal(V.PERF.problem.kind, 'unavailable');
  const h = V.perfHtml(V.PERF, CTX);
  assert.ok(h.includes('Database is busy') && !h.includes('<script'));
});
test('network error: keeps the numbers already read and says so', async () => {
  const good = fakeFetch(OK_ROUTES());
  await V.perfLoad({ fetchImpl: good, nowMs: 1 });
  await V.perfLoad({ fetchImpl: fakeFetch({ '/api/perf/status': 'throw', '/api/perf/snapshot': 'throw' }), nowMs: 100000 });
  assert.equal(V.PERF.problem.kind, 'network');
  const h = V.perfHtml(V.PERF, CTX);
  assert.match(h, /Could not reach the server\. Showing numbers from \d{4}-\d{2}-\d{2} \d{2}:\d{2} Korea time\./);
  assert.ok(h.includes('dk-band'), 'the old numbers are still shown');
  V.perfReset();
  await V.perfLoad({ fetchImpl: fakeFetch({ '/api/perf/status': 'throw', '/api/perf/snapshot': 'throw' }) });
  assert.match(V.perfHtml(V.PERF, CTX), /Could not reach the server\. Showing what was already on this page\./);
});
test('the server\'s own banner text is shown, with the data kept underneath', () => {
  const P = stateOk();
  P.snapResp.state = 'google-down';
  P.snapResp.banner = { kind: 'google-down', text: 'Google did not answer. Showing data from 14:30 UTC.' };
  const h = V.perfHtml(P, CTX);
  assert.match(h, /class="pf-banner warn" role="status">.*Google did not answer\. Showing data from 14:30 UTC\./s);
  assert.ok(h.includes('dk-band'));
  P.snapResp.banner.text = BAD;
  assert.ok(!V.perfHtml(P, CTX).includes('<script'));
});
test('waiting and preview modes: the banner, and the preview counts as numbers only', () => {
  V.perfReset();
  Object.assign(V.PERF, {
    status: { ok: true, enabled: true, dryRun: true, lastDryRun: { counts: { deliverables: 650, influencers: 90, campaigns: 24, campaignsNeedMatch: 21 }, email: 'a@b.test' } },
    snapResp: { ok: true, state: 'dry-run', banner: { kind: 'dry-run', text: 'Live performance is in preview mode: it reads the sheet and stores nothing yet.' }, freshness: { level: 'red', reason: 'no-data' }, snapshot: null }
  });
  const h = V.perfHtml(V.PERF, CTX);
  assert.match(h, /preview mode/); assert.match(h, /Last preview read found 650 posts, 90 creators, 24 campaigns, 21 still need a match\. Nothing was stored\./);
  assert.match(h, /No live readings are stored yet\./); assert.match(h, /No data yet/);
  assert.ok(!h.includes('a@b.test'));
});

/* ---------------- the writes ---------------- */

test('match body: one campaign id, or sheetOnly, nothing else', () => {
  assert.deepEqual(V.perfMatchBody('B', 'dash1'), { sheetCampaignId: 'B', dashboardCampaignId: 'dash1' });
  assert.deepEqual(V.perfMatchBody('B', '__sheet_only__'), { sheetCampaignId: 'B', sheetOnly: true });
  assert.equal(V.perfMatchBody('B', ''), null); assert.equal(V.perfMatchBody('', 'dash1'), null);
});
test('match save: POSTs the body, then reads again; a refusal shows the API\'s own words', async () => {
  const routes = Object.assign(OK_ROUTES(), { 'POST /api/perf/match': { status: 200, body: { ok: true, match: {} } } });
  const f = fakeFetch(routes);
  const r = await V.perfSaveMatch('B', 'dash1', { fetchImpl: f, onChange() {}, nowMs: 5 });
  assert.equal(r.ok, true);
  const post = f.calls.find((c) => c.url === '/api/perf/match');
  assert.equal(post.init.method, 'POST'); assert.equal(post.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(post.init.body), { sheetCampaignId: 'B', dashboardCampaignId: 'dash1' });
  assert.ok(f.calls.some((c) => c.url === '/api/perf/snapshot'), 'read again after saving');
  assert.equal(V.PERF.matchMsg.B, 'Saved.');
  const f2 = fakeFetch({ 'POST /api/perf/match': { status: 400, body: { error: 'That dashboard campaign does not exist.' } } });
  const r2 = await V.perfSaveMatch('B', 'nope', { fetchImpl: f2, onChange() {} });
  assert.equal(r2.ok, false); assert.equal(V.PERF.matchMsg.B, 'That dashboard campaign does not exist.');
  const f3 = fakeFetch({ 'POST /api/perf/match': { status: 403, body: {} } });
  await V.perfSaveMatch('D', '__sheet_only__', { fetchImpl: f3, onChange() {} });
  assert.deepEqual(JSON.parse(f3.calls[0].init.body), { sheetCampaignId: 'D', sheetOnly: true });
  assert.match(V.PERF.matchMsg.D, /for staff only/);
  const f4 = fakeFetch({});
  await V.perfSaveMatch('D', '', { fetchImpl: f4, onChange() {} });
  assert.equal(f4.calls.length, 0, 'nothing is sent without a choice');
  assert.match(V.PERF.matchMsg.D, /Choose a dashboard campaign/);
});
test('refresh now: rate limit shows the API words and the wait; success reads again', async () => {
  const f = fakeFetch({ 'POST /api/perf/refresh': { status: 429, body: { error: 'A refresh was started a moment ago. Try again in a few minutes.', retryAfterSec: 200 } } });
  const seen = [];
  const out = await V.perfRefreshNow({ fetchImpl: f, onChange() { seen.push(V.PERF.refresh.text); } });
  assert.match(out.text, /^A refresh was started a moment ago\. Try again in a few minutes\. You can try again in about 4 minutes\.$/);
  assert.equal(out.busy, false); assert.equal(seen[0], 'Reading the sheet…');
  const ok = fakeFetch(Object.assign(OK_ROUTES(), { 'POST /api/perf/refresh': { status: 200, body: { ok: true, run: {} } } }));
  const o2 = await V.perfRefreshNow({ fetchImpl: ok, onChange() {}, nowMs: 9 });
  assert.match(o2.text, /Read finished/);
  assert.equal(JSON.parse(ok.calls[0].init.body) && ok.calls[0].init.method, 'POST');
  const failed = fakeFetch(Object.assign(OK_ROUTES(), { 'POST /api/perf/refresh': { status: 200, body: { ok: false, run: { message: "The tab 'Deliverables' was not found. Nothing was updated." } } } }));
  assert.match((await V.perfRefreshNow({ fetchImpl: failed, onChange() {}, nowMs: 9 })).text, /Deliverables' was not found/);
  const net = fakeFetch({ 'POST /api/perf/refresh': 'throw' });
  assert.match((await V.perfRefreshNow({ fetchImpl: net, onChange() {} })).text, /Could not reach the server/);
});
test('refresh: a second click while one runs does nothing', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = async () => { await gate; return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  const a = V.perfRefreshNow({ fetchImpl: f, onChange() {} });
  const b = await V.perfRefreshNow({ fetchImpl: f, onChange() {} });
  assert.equal(b.busy, true);
  release(); await a;
});

/* ---------------- the page, from the source ---------------- */

test('the old imported-numbers page stays underneath, and the placeholder is gone', () => {
  const src = fs.readFileSync(new URL('../src/views/socialOverview.js', import.meta.url), 'utf8');
  assert.ok(src.includes("renderSocialOverviewLegacy($('#pfLegacy'))"));
  assert.ok(!HTML.includes('Content momentum') && !src.includes('Content momentum'));
  assert.ok(!/class="so-mk"><div class="n">—<\/div>/.test(HTML), 'no tile that is only a dash');
  /* the imported band and the Home tile carry the small chip */
  assert.ok(HTML.includes('<div class="so-lab">Total views ${perfLegacyChipHtml()}</div>'));
  assert.ok(HTML.includes(`perfLegacyChipHtml() + '<div class="s hm-src">Source: imported numbers (Setup)</div>', 'hmViewsSat')`));
});
test('routes: Performance is the Social tab, the old links still land', () => {
  assert.ok(HTML.includes("{ id: 'overview', label: 'Performance'"));
  assert.ok(HTML.includes("label: 'Social' },"));
  assert.ok(HTML.includes("if (section === 'social' && item === 'performance') item = 'overview';"));
  assert.ok(HTML.includes("social: 'overview'"), 'the Social default is unchanged, so #/social and #/social/overview still land');
  assert.ok(HTML.includes("(item === 'overview' ? renderSocialOverview : renderSocial)"));
});

/* collect the styles the page injects */
function styles() {
  const out = [];
  const keepGet = document.getElementById, keepHead = document.head, keepCreate = document.createElement;
  document.getElementById = () => null;
  document.head = { appendChild: (n) => out.push(n.textContent) };
  document.createElement = () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} });
  try { V.ensurePerfStyles(); } finally { document.getElementById = keepGet; document.head = keepHead; document.createElement = keepCreate; }
  return out.join('\n');
}

/* ---------------- the wiring, against a hand-made page ---------------- */

function fakePage() {
  const root = { innerHTML: '', listeners: {}, attrs: {},
    addEventListener(t, f) { this.listeners[t] = f; }, contains: () => true, setAttribute(k, v) { this.attrs[k] = v; },
    querySelectorAll: () => [], querySelector: () => null };
  const say = { textContent: '' };
  const keep = document.querySelector;
  document.querySelector = (sel) => (sel === '#pfLive' ? root : sel === '#pfAnnounce' ? say : null);
  V.perfWire(root);
  const btn = (attrs) => ({ hasAttribute: (k) => k in attrs, getAttribute: (k) => attrs[k] });
  return {
    root, say,
    click: (attrs) => root.listeners.click({ target: { closest: () => btn(attrs) } }),
    change: (id, value, attrs) => root.listeners.change({ target: Object.assign({ id, value }, attrs ? btn(attrs) : { hasAttribute: () => false, getAttribute: () => null }) }),
    done: () => { document.querySelector = keep; }
  };
}
test('wiring: a click on a header sorts, the next click flips it, aria-sort follows', () => {
  stateOk();
  const pg = fakePage();
  try {
    pg.click({ 'data-pf-sort': 'views' });
    assert.deepEqual(V.PERF.sort, { key: 'views', dir: 'desc' });
    assert.match(pg.root.innerHTML, /aria-sort="descending"><button type="button" class="pf-sort" data-pf-sort="views"/);
    pg.click({ 'data-pf-sort': 'views' });
    assert.deepEqual(V.PERF.sort, { key: 'views', dir: 'asc' });
    assert.match(pg.root.innerHTML, /aria-sort="ascending"><button type="button" class="pf-sort" data-pf-sort="views"/);
    pg.click({ 'data-pf-sort': 'creator' });
    assert.deepEqual(V.PERF.sort, { key: 'creator', dir: 'asc' });
  } finally { pg.done(); }
});
test('wiring: filters, opening a campaign, back, reset, metric toggle, show more', () => {
  stateOk();
  const pg = fakePage();
  try {
    pg.change('pfPlatform', 'TikTok'); assert.equal(V.PERF.platform, 'TikTok');
    assert.match(pg.root.innerHTML, /1 of 1 posts have a reading\./);
    pg.change('pfPeriod', '7'); assert.equal(V.PERF.period, '7');
    pg.click({ 'data-pf-open': 'A' }); assert.equal(V.PERF.campaign, 'A');
    assert.match(pg.root.innerHTML, /data-pf-back="1"/);
    pg.click({ 'data-pf-back': '1' }); assert.equal(V.PERF.campaign, '');
    pg.click({ 'data-pf-metric': 'er' }); assert.equal(V.PERF.metric, 'er');
    assert.match(pg.root.innerHTML, /data-pf-metric="er" aria-pressed="true"/);
    pg.click({ 'data-pf-more': '1' }); assert.equal(V.PERF.limit, 200);
    pg.click({ 'data-pf-reset': '1' });
    assert.deepEqual([V.PERF.platform, V.PERF.period, V.PERF.campaign, V.PERF.limit], ['', 'all', '', 100]);
    pg.change('pfCampaign', 'B'); assert.equal(V.PERF.campaign, 'B');
  } finally { pg.done(); }
});
test('wiring: choose in the select, press Save, and the right body goes to the match route', async () => {
  stateOk();
  const f = fakeFetch(Object.assign(OK_ROUTES(), { 'POST /api/perf/match': { status: 200, body: { ok: true } } }));
  const keepFetch = globalThis.fetch;
  globalThis.fetch = f;
  const pg = fakePage();
  try {
    pg.change('pfPick0', 'dash1', { 'data-pf-pick': 'B' });
    assert.equal(V.PERF.picks.B, 'dash1');
    pg.click({ 'data-pf-save': 'B' });
    await new Promise((r) => setTimeout(r, 20));
    const sent = f.calls.find((c) => c.url === '/api/perf/match');
    assert.deepEqual(JSON.parse(sent.init.body), { sheetCampaignId: 'B', dashboardCampaignId: 'dash1' });
    pg.change('pfPick1', '__sheet_only__', { 'data-pf-pick': 'D' });
    pg.click({ 'data-pf-save': 'D' });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(JSON.parse(f.calls.filter((c) => c.url === '/api/perf/match')[1].init.body), { sheetCampaignId: 'D', sheetOnly: true });
  } finally { pg.done(); globalThis.fetch = keepFetch; }
});
test('wiring: Refresh now announces its status in the live region', async () => {
  stateOk();
  const f = fakeFetch({ 'POST /api/perf/refresh': { status: 429, body: { error: 'A refresh was started a moment ago. Try again in a few minutes.', retryAfterSec: 120 } } });
  const keepFetch = globalThis.fetch;
  globalThis.fetch = f;
  const pg = fakePage();
  try {
    pg.click({ 'data-pf-refresh': '1' });
    assert.equal(pg.say.textContent, 'Reading the sheet…');
    await new Promise((r) => setTimeout(r, 20));
    assert.match(pg.say.textContent, /try again in about 2 minutes/i);
    assert.match(pg.root.innerHTML, /Refresh now/);
  } finally { pg.done(); globalThis.fetch = keepFetch; }
});
