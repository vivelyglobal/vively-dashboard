/* THE REPORT BUILDER (Reports > Build a report) AND ITS CSV AND PRINT LAYOUT.

   No browser here, so nothing looks at pixels and no page was printed.
   What is pinned down: what can be chosen, the arithmetic (sums, the mean
   that leaves blanks out, top 3, the timeline), that a number nobody read
   is a dash and never a zero, the CSV (exact header, formula-safe cells,
   no line breaks inside a cell, a file name with no sheet id in it), that
   hostile text is escaped, that nothing forbidden reaches the report page
   or the file (sentinels planted in every forbidden field), what the print
   rules say in the CSS text, and that the staff-only parts stay out of the
   printed sheet. All data is made up. */

import './helpers/browser-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as V from '../src/views/socialOverview.js';

const HTML = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-25T12:00:00Z');
const HOUR = 3600000, DAY = 86400000, MIN = 60000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const dayAgo = (n) => new Date(NOW - n * DAY).toISOString().slice(0, 10);
const BAD = '<script>alert(1)</script>';

/* things that must never be on the page or in the file */
const SENTINELS = ['RATE-SENTINEL-77', 'AMOUNT-SENTINEL-88', 'BUDGET-SENTINEL-66', 'NOTE-SENTINEL-55', 'COST-SENTINEL-44', 'leak@example.test',
  'CONTACT-SENTINEL-99', 'PHONE-SENTINEL-33', 'REALNAME-SENTINEL', 'NOTION-DB-SENTINEL', 'NOTION-PAGE-SENTINEL', 'SHEETID-SENTINEL',
  'CAMPID-SENTINEL-A', 'CAMPID-SENTINEL-B', 'DASHID-SENTINEL-7', 'PAYOUT-SENTINEL', 'CPE-SENTINEL'];

function post(o) {
  return Object.assign({
    deliverableId: 'DELIV-SENTINEL-?', sheetCampaignId: 'CAMPID-SENTINEL-A', platformPostId: 'x', postUrl: 'https://www.instagram.com/p/abc/',
    platform: 'Instagram', creator: { handle: 'okhandle', platform: 'Instagram', followers: 100, name: 'REALNAME-SENTINEL', email: 'leak@example.test', phone: 'PHONE-SENTINEL-33' },
    type: 'Reel', postedDate: dayAgo(5), views: 1000, likes: 100, comments: 10, shares: 4, saves: 6, reposts: 2, er: 5,
    lastScrapedAt: iso(3 * HOUR), flags: { hasReading: true },
    rate: 'RATE-SENTINEL-77', amount: 'AMOUNT-SENTINEL-88', budget: 'BUDGET-SENTINEL-66', notes: 'NOTE-SENTINEL-55', cost: 'COST-SENTINEL-44',
    email: 'leak@example.test', contact: 'CONTACT-SENTINEL-99', cpe: 'CPE-SENTINEL', payout: 'PAYOUT-SENTINEL', notionPageId: 'NOTION-PAGE-SENTINEL'
  }, o);
}
function snapshot(posts, extra) {
  return Object.assign({
    version: 1, checkedAt: iso(12 * MIN), newestReadingAt: iso(3 * HOUR), intervalMin: 30,
    timeZoneNote: 'Dates from the sheet are read as UTC.',
    sheetId: 'SHEETID-SENTINEL', sheetUrl: 'https://docs.google.com/spreadsheets/d/SHEETID-SENTINEL/edit',
    campaigns: [
      { sheetCampaignId: 'CAMPID-SENTINEL-A', name: 'Autumn', budget: 'BUDGET-SENTINEL-66', notionDatabaseId: 'NOTION-DB-SENTINEL',
        match: { state: 'matched', dashboardCampaignId: 'DASHID-SENTINEL-7', candidates: [], reason: '' } },
      { sheetCampaignId: 'CAMPID-SENTINEL-B', name: 'Beta Only', notionDatabaseId: 'NOTION-DB-SENTINEL', match: { state: 'sheet-only', candidates: [], reason: '' } },
      { sheetCampaignId: 'EMPTY-ONE', name: 'Has no posts', match: { state: 'sheet-only', candidates: [], reason: '' } }],
    needsMatch: [], posts
  }, extra || {});
}
const CTX = { nowMs: NOW, dash: [{ id: 'DASHID-SENTINEL-7', brand: 'Brand A', name: 'Autumn Seeding' }] };
const okResp = (s) => ({ ok: true, state: 'ok', banner: { kind: 'ok', text: '' }, freshness: { level: 'green', reason: '' }, snapshot: s });
function P(posts, extra) {
  V.perfReset();
  Object.assign(V.PERF, { status: { ok: true, enabled: true, intervalMin: 30 }, snapResp: okResp(snapshot(posts, extra)) });
  return V.PERF;
}
const UI = (o) => Object.assign({ sel: new Set(['CAMPID-SENTINEL-A']), period: 'all', from: '', to: '', metric: 'views', sort: 'newest' }, o || {});
const model = (posts, ui, extra) => V.rbModel(P(posts, extra), CTX, UI(ui));

const BASE = () => [
  post({ deliverableId: 'a', views: 9000, likes: 900, er: 4, postedDate: dayAgo(2), postUrl: 'https://www.instagram.com/p/AAA/?igsh=TRACK123' }),
  post({ deliverableId: 'b', creator: { handle: 'second', platform: 'TikTok' }, platform: 'TikTok', views: 5000, likes: 400, er: 6, postedDate: dayAgo(10), comments: null, shares: null, saves: null, reposts: null }),
  post({ deliverableId: 'c', creator: { handle: 'third', platform: 'Instagram' }, views: 7000, likes: 300, er: null, postedDate: dayAgo(40) }),
  post({ deliverableId: 'd', creator: { handle: 'fourth', platform: 'Instagram' }, views: null, likes: null, er: null, postedDate: dayAgo(1), flags: { hasReading: false }, comments: null, shares: null, saves: null, reposts: null, lastScrapedAt: null }),
  post({ deliverableId: 'e', creator: { handle: 'fifth', platform: 'Instagram' }, views: 100, likes: 10, er: 0, postedDate: null }),
  post({ deliverableId: 'f', creator: { handle: 'sixth', platform: 'Instagram' }, views: 50, likes: 5, er: 150, postedDate: dayAgo(3) }),
  post({ deliverableId: 'g', sheetCampaignId: 'CAMPID-SENTINEL-B', creator: { handle: 'otherbrand', platform: 'Instagram' }, views: 123456, likes: 1, er: 2, postedDate: dayAgo(4) }),
  post({ deliverableId: 'h', sheetCampaignId: null, creator: { handle: 'unlinked', platform: 'Instagram' }, views: 77, likes: 7, er: 1, postedDate: dayAgo(4) })
];

beforeEach(() => V.perfReset());

/* ---------------- what can be chosen ---------------- */

test('options: sheet campaigns that have posts, matched ones named like the dashboard, an unlinked group last, empty ones left out', () => {
  const m = model(BASE());
  assert.deepEqual(m.options.map((o) => o.label), ['Beta Only', 'Brand A · Autumn Seeding', 'Not linked to a campaign']);
  assert.deepEqual(m.options.map((o) => o.posts), [1, 6, 1]);
  assert.ok(!m.options.some((o) => o.label === 'Has no posts'));
  assert.equal(m.chosen.length, 1);
  assert.deepEqual(m.title, { brand: 'Brand A', name: 'Autumn Seeding', list: [] });
});
test('options: a choice that no longer exists is ignored, nothing chosen means an empty report and a prompt', () => {
  const m = model(BASE(), { sel: new Set(['gone']) });
  assert.equal(m.chosen.length, 0); assert.equal(m.scope.length, 0);
  assert.match(m.line, /Choose at least one campaign/);
  assert.match(V.rbHtml(m, V.PERF, UI({ sel: new Set() }), CTX), /Choose at least one campaign on the left/);
});
test('title: two campaigns give "2 campaigns" with the names listed; the same brand is kept', () => {
  const m = model(BASE(), { sel: new Set(['CAMPID-SENTINEL-A', 'CAMPID-SENTINEL-B']) });
  assert.equal(m.title.name, '2 campaigns'); assert.equal(m.title.brand, '');
  assert.equal(m.title.list.length, 2);
  assert.equal(m.scope.length, 7);
});

/* ---------------- the numbers ---------------- */

test('summary: sums leave out posts nobody read, the mean ER leaves out blanks, zero and over 100, and the counts are printed', () => {
  const m = model(BASE());
  const s = m.stats;
  assert.equal(s.posts, 6); assert.equal(s.withReading, 5);
  assert.equal(s.views, 9000 + 5000 + 7000 + 100 + 50); assert.equal(s.viewsRead, 5);
  assert.equal(s.likes, 900 + 400 + 300 + 10 + 5);
  assert.deepEqual([s.comments.v, s.comments.read], [10 * 4, 4]);       /* b and d have none */
  assert.deepEqual([s.shares.v, s.shares.read], [4 * 4, 4]);
  assert.equal(s.avgEr, 5); assert.equal(s.erCount, 2);                  /* only 4 and 6 are valid rates */
  assert.equal(s.creators, 6);
  const h = V.rbDocHtml(m);
  assert.match(h, /5 of 6 posts have a reading/);
  assert.match(h, /plain average of the engagement rates in the sheet/);
  assert.match(h, /2 of 6 posts have a rate/);
  assert.match(h, /mean of 2 of 6 posts/);
  assert.match(h, /5\.00%/);
});
test('summary: a column nobody read says Not measured, never 0', () => {
  const none = BASE().map((p) => Object.assign(p, { comments: null, shares: null, saves: null, reposts: null }));
  const h = V.rbDocHtml(model(none));
  assert.match(h, /Comments<\/div><div class="rp-bn">—<\/div><div class="rp-bc">Not measured/);
  assert.doesNotMatch(h, /rp-bn">0</);
});
test('top 3: most views first, a missing reading never ranks, a tie goes to the newer post', () => {
  const m = model(BASE());
  assert.deepEqual(m.top.map((p) => p.handle), ['okhandle', 'third', 'second']);
  const tie = model([post({ deliverableId: 'x1', views: 10, postedDate: '2026-11-01' }), post({ deliverableId: 'x2', views: 10, postedDate: '2026-11-09', creator: { handle: 'newer' } }),
    post({ deliverableId: 'x3', views: null, likes: null })]);
  assert.deepEqual(tie.top.map((p) => p.handle), ['newer', 'okhandle']);
});
test('timeline: per posted day, a day with no number is left out and counted, ER is a mean, count counts', () => {
  const m = model(BASE());
  const v = V.rbTimeline(m.scope, 'views');
  assert.equal(v.noDate, 1);
  assert.ok(v.days.every((d) => d.value > 0));
  assert.equal(v.leftOut, 1, 'the day with only the unread post');
  const er = V.rbTimeline(m.scope, 'er');
  assert.ok(er.days.some((d) => d.value === 4) && er.days.some((d) => d.value === 6));
  assert.equal(V.rbTimeline(m.scope, 'count').days.reduce((a, d) => a + d.value, 0), 5);
  const sv = V.rbTimeline(m.scope, 'saves');
  assert.ok(sv.leftOut >= 1);
});
test('timeline chart: one bar per day, an accessible summary and a hidden values table; none in the data says so', () => {
  const h = V.rbChartHtml(model(BASE()));
  assert.match(h, /<svg class="rp-svg"[^>]*role="img" aria-label="Views by posted date: \d+ days? from /);
  assert.equal((h.match(/<rect class="rp-bar"/g) || []).length, V.rbTimeline(model(BASE()).scope, 'views').days.length);
  assert.match(h, /<table class="sr-only">/);
  assert.match(h, /left out: no reading, not zero/);
  const empty = V.rbChartHtml(model([post({ views: null, likes: null, comments: null, flags: { hasReading: false } })]));
  assert.match(empty, /No dated posts with a number for views/);
});
test('table: dash with hidden words for a number nobody read, links, handles, platform, type and posted date are there', () => {
  const h = V.rbDocHtml(model(BASE()));
  const row = h.split('<tr>').find((r) => r.includes('>fourth<'));
  assert.ok(row);
  assert.match(row, /—<span class="sr-only"> did not read<\/span>/);
  assert.doesNotMatch(row, /<td class="num">0</);
  const first = h.split('<tr>').find((r) => r.includes('>okhandle<'));
  assert.match(first, /Instagram · Reel/); assert.match(first, /href="https:\/\/www\.instagram\.com\/p\/AAA\/"/);
  assert.match(h, /<th scope="col"[^>]*>Post<\/th>/); assert.match(h, /<th scope="col" class="num">Reposts<\/th>/);
  assert.match(h, /no rate given/);
});
test('links: tracking parts are removed, javascript: and sheet or Notion links are dropped', () => {
  const m = model([post({ deliverableId: 'a', postUrl: 'https://www.instagram.com/p/AAA/?igsh=TRACK123&utm_source=x#frag' }),
    post({ deliverableId: 'b', postUrl: 'javascript:alert(1)' }),
    post({ deliverableId: 'c', postUrl: 'https://docs.google.com/spreadsheets/d/SHEETID-SENTINEL/edit' }),
    post({ deliverableId: 'd', postUrl: 'https://www.notion.so/NOTION-PAGE-SENTINEL' }),
    post({ deliverableId: 'e', postUrl: 'https://www.youtube.com/watch?v=VID123&si=SHARE' })]);
  const urls = Object.fromEntries(m.scope.map((p) => [p.id, p.url]));
  assert.equal(urls.a, 'https://www.instagram.com/p/AAA/');
  assert.equal(urls.b, ''); assert.equal(urls.c, ''); assert.equal(urls.d, '');
  assert.equal(urls.e, 'https://www.youtube.com/watch?v=VID123');
});

/* ---------------- the period ---------------- */

test('period: last 30 days uses the Performance tab rule, custom dates are inclusive, undated posts are left out and counted', () => {
  const all = model(BASE());
  assert.equal(all.scope.length, 6); assert.equal(all.undatedLeftOut, 0);
  const d30 = model(BASE(), { period: '30' });
  assert.deepEqual(d30.scope.map((p) => p.id).sort(), ['a', 'b', 'd', 'f']);
  assert.equal(d30.undatedLeftOut, 1);
  assert.match(V.rbDocHtml(d30), /1 post has no posted date and is left out of this period/);
  assert.match(d30.range.label, /^Last 30 days: posted from \d{4}-\d{2}-\d{2}$/);
  const c = model(BASE(), { period: 'custom', from: dayAgo(10), to: dayAgo(3) });
  assert.deepEqual(c.scope.map((p) => p.id).sort(), ['b', 'f']);
  assert.equal(c.range.label, 'Posted ' + dayAgo(10) + ' to ' + dayAgo(3));
  const open = model(BASE(), { period: 'custom', from: dayAgo(10), to: '' });
  assert.equal(open.scope.length, 4);
});
test('period: a start after the end gives an empty report and a plain sentence, bad dates are ignored', () => {
  const m = model(BASE(), { period: 'custom', from: dayAgo(2), to: dayAgo(9) });
  assert.equal(m.scope.length, 0); assert.match(m.range.error, /start date is after the end date/);
  assert.match(V.rbHtml(m, V.PERF, UI({ period: 'custom', from: dayAgo(2), to: dayAgo(9) }), CTX), /The start date is after the end date/);
  const junk = model(BASE(), { period: 'custom', from: '<script>', to: 'nope' });
  assert.equal(junk.scope.length, 6); assert.equal(junk.range.label, 'All posted dates');
});

/* ---------------- the table order ---------------- */

test('order: the chosen order drives the table and the CSV, blanks last', () => {
  assert.deepEqual(model(BASE(), { sort: 'views' }).rows.map((p) => p.id).slice(0, 3), ['a', 'c', 'b']);
  assert.equal(model(BASE(), { sort: 'views' }).rows.at(-1).id, 'd');
  assert.deepEqual(model(BASE(), { sort: 'creator' }).rows.map((p) => p.handle).slice(0, 2), ['fifth', 'fourth']);
  assert.equal(model(BASE(), { sort: 'newest' }).rows[0].id, 'd');
  assert.equal(model(BASE(), { sort: 'nonsense' }).sortKey, 'newest');
});

/* ---------------- the CSV ---------------- */

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r') { /* skip */ }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const HOSTILE = [BAD, '"><img src=x onerror=alert(1)>', "=cmd|' /C calc'!A0", '+SUM(1,1)', '-2+3', '@SUM(1)', 'line one\nline two', '\t=1+1', '  =HYPERLINK("http://x","y")', 'a,b,"c"'];
function hostilePosts() {
  return HOSTILE.map((h, i) => post({ deliverableId: 'h' + i, creator: { handle: h, platform: 'Instagram' }, type: h, platform: h, postUrl: 'https://www.instagram.com/p/H' + i + '/' }));
}
test('csv: header row is the whitelist and nothing else', () => {
  const csv = V.rbCsv(model(BASE()));
  assert.equal(csv.charCodeAt(0), 0xFEFF, 'a byte-order mark so Excel reads Korean text');
  const rows = parseCsv(csv.slice(1));
  assert.deepEqual(rows[0], ['campaign', 'platform', 'handle', 'post URL', 'type', 'posted date', 'views', 'likes', 'comments', 'shares', 'saves', 'reposts', 'ER', 'last reading time']);
  assert.deepEqual(rows[0], V.RB_COLS);
  assert.equal(rows.length, 1 + 6);
  rows.slice(1).forEach((r) => assert.equal(r.length, 14));
});
test('csv: a number nobody read is blank, not 0; the rate has a percent sign; the reading time is an ISO time', () => {
  const rows = parseCsv(V.rbCsv(model(BASE(), { sort: 'newest' })).slice(1));
  const d = rows.find((r) => r[2] === 'fourth');
  assert.deepEqual(d.slice(6, 13), ['', '', '', '', '', '', '']); assert.equal(d[13], '');
  const a = rows.find((r) => r[2] === 'okhandle');
  assert.equal(a[6], '9000'); assert.equal(a[12], '4.00%'); assert.match(a[13], /^\d{4}-\d{2}-\d{2}T\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(a[0], 'Brand A · Autumn Seeding');
});
test('csv: cells that start with = + - @ get an apostrophe, line breaks never survive, quotes are doubled', () => {
  const m = model(hostilePosts());
  const csv = V.rbCsv(m);
  const rows = parseCsv(csv.slice(1));
  assert.equal(rows.length, 1 + HOSTILE.length, 'one line per post: no cell carries a line break');
  assert.equal((csv.match(/\r\n/g) || []).length, 1 + HOSTILE.length);
  for (const r of rows.slice(1)) {
    for (const c of r) assert.ok(!/^[=+\-@]/.test(c), 'formula-looking cell was not defused: ' + c);
    assert.ok(!/[\r\n\t]/.test(r.join('')));
  }
  const cells = rows.slice(1).map((r) => r[2]);
  assert.ok(cells.includes("'=cmd|' /C calc'!A0")); assert.ok(cells.includes("'+SUM(1,1)")); assert.ok(cells.includes("'-2+3")); assert.ok(cells.includes("'@SUM(1)"));
  assert.ok(cells.includes("'=1+1"), 'a leading tab does not hide a formula');
  assert.ok(cells.includes('line one line two'));
  assert.ok(cells.includes('a,b,"c"'));
  /* raw text: after the quoted parts are blanked out, no field in the file starts with a formula character */
  const raw = csv.slice(1).split('\r\n').slice(1).filter(Boolean).map((l) => l.replace(/"([^"]|"")*"/g, 'Q'));
  raw.forEach((l) => l.split(',').forEach((f) => assert.ok(!/^[=+\-@]/.test(f), 'raw field ' + f)));
});
test('csv: the file name is plain, sanitised, dated, and has no sheet id in it', () => {
  const name = (n, brand) => V.rbFileName({ chosen: [{ label: n, name: n, brand }], nowMs: NOW });
  assert.equal(name('Autumn Seeding', 'Brand A'), 'vively-report-autumn-seeding-2026-11-25.csv');
  for (const hostile of ['../../evil"; <x>.csv', 'SHEET ?id=1AbC/..\\x', '한국어 캠페인', '', '   ', 'a'.repeat(300), BAD]) {
    const n = name(hostile);
    assert.match(n, /^vively-report-[a-z0-9]+(-[a-z0-9]+)*-2026-11-25\.csv$/, n);
    assert.ok(n.length < 80);
  }
  assert.equal(name('한국어 캠페인'), 'vively-report-report-2026-11-25.csv');
  const multi = V.rbFileName(model(BASE(), { sel: new Set(['CAMPID-SENTINEL-A', 'CAMPID-SENTINEL-B']) }));
  assert.equal(multi, 'vively-report-2-campaigns-2026-11-25.csv');
  assert.ok(!V.rbFileName(model(BASE())).includes('SENTINEL'.toLowerCase()));
});
test('csv: every post is in the file even when the page table is capped', () => {
  const many = Array.from({ length: V.RB_MAX_ROWS + 100 }, (_, i) => post({ deliverableId: 'm' + i, postUrl: 'https://www.instagram.com/p/M' + i + '/', creator: { handle: 'h' + i } }));
  const m = model(many);
  assert.equal(m.shown.length, V.RB_MAX_ROWS); assert.ok(m.truncated);
  assert.equal(parseCsv(V.rbCsv(m).slice(1)).length, 1 + V.RB_MAX_ROWS + 100);
  assert.match(V.rbDocHtml(m), /The table shows the first 1,500 of 1,600 posts\. The CSV file has all of them\./);
});

/* ---------------- nothing forbidden, nothing hostile ---------------- */

function leakScan(label, text) {
  for (const s of SENTINELS) assert.ok(!text.includes(s), label + ' contains ' + s);
  for (const w of ['docs.google.com', 'spreadsheets/d', 'notion.so', 'notion.site', 'notionDatabaseId', 'sheetUrl', 'sheetId', 'mailto:', 'TRACK123'])
    assert.ok(!text.toLowerCase().includes(w.toLowerCase()), label + ' contains ' + w);
}
test('leak scan: report HTML and CSV carry none of the planted forbidden values, for every campaign, period and order', () => {
  const ALL = BASE().concat(hostilePosts(), [post({ deliverableId: 'z', postUrl: 'https://docs.google.com/spreadsheets/d/SHEETID-SENTINEL/edit', creator: { handle: 'viaSheetLink' } })]);
  const sels = [['CAMPID-SENTINEL-A'], ['CAMPID-SENTINEL-B'], ['CAMPID-SENTINEL-A', 'CAMPID-SENTINEL-B'], ['__not_linked__'], ['CAMPID-SENTINEL-A', 'CAMPID-SENTINEL-B', '__not_linked__']];
  for (const sel of sels) for (const period of ['all', '30', 'custom']) for (const metric of V.RB_METRICS.map((x) => x[0])) {
    const m = model(ALL, { sel: new Set(sel), period, from: dayAgo(60), to: dayAgo(0), metric, sort: 'views' });
    const tag = sel.join('+') + '/' + period + '/' + metric;
    leakScan('doc ' + tag, V.rbDocHtml(m));
    leakScan('csv ' + tag, V.rbCsv(m));
    leakScan('file ' + tag, V.rbFileName(m));
    leakScan('print ' + tag, V.rbPrintCss(m));
  }
});
test('leak scan: the sheet campaign id and the dashboard id are not in the report, only in the staff controls', () => {
  const m = model(BASE());
  const doc = V.rbDocHtml(m);
  assert.ok(!doc.includes('CAMPID-SENTINEL') && !doc.includes('DASHID-SENTINEL') && !doc.includes('DELIV-SENTINEL'));
  assert.ok(!/\bid="/.test(doc), 'the print copy and the screen copy must not share an id');
});
test('escaping: hostile handles, types, platforms and campaign names never become tags or attributes', () => {
  const ALL = hostilePosts().concat([post({ deliverableId: 'q', sheetCampaignId: 'CAMPID-SENTINEL-B', creator: { handle: BAD } })]);
  const snap = { campaigns: [{ sheetCampaignId: 'CAMPID-SENTINEL-A', name: BAD + '"onmouseover="x', match: { state: 'sheet-only' } },
    { sheetCampaignId: 'CAMPID-SENTINEL-B', name: '</title><img src=x onerror=1>', match: { state: 'sheet-only' } }] };
  const m = model(ALL, { sel: new Set(['CAMPID-SENTINEL-A', 'CAMPID-SENTINEL-B']) }, snap);
  const doc = V.rbDocHtml(m), page = V.rbHtml(m, V.PERF, UI({ sel: m.sel }), CTX);
  for (const h of [doc, page]) {
    assert.ok(!h.includes('<script'), 'script tag'); assert.ok(!/<img/i.test(h), 'img tag'); assert.ok(!h.includes('</title><img'), 'closed a title');
    assert.ok(!/<[a-z][^>]*\son[a-z]+=/i.test(h), 'a live event attribute inside a tag');
    assert.ok(h.includes('&lt;script&gt;'));
  }
});

/* ---------------- the printed sheet holds the report and nothing else ---------------- */

test('print: the sheet has no staff control, no staff note and no builder class, and says when the data is from', () => {
  const m = model(BASE());
  const doc = V.rbDocHtml(m);
  for (const bad of ['<button', '<input', '<select', 'rb-', 'data-rb', 'Staff copy', 'check before sharing', 'Refresh', 'Content insights', 'no-print'])
    assert.ok(!doc.includes(bad), 'the sheet contains ' + bad);
  assert.match(doc, /Performance report/);
  assert.match(doc, /Data as of \d{4}-\d{2}-\d{2} \d\d:\d\d Korea time/);
  assert.match(doc, /<footer class="rp-foot">Data as of /);
  assert.match(doc, /newest post reading \d{4}-\d{2}-\d{2}/);
});
test('print: the repeating footer rule is built only from a plain time and is dropped otherwise', () => {
  const m = model(BASE());
  assert.match(V.rbPrintCss(m), /^<style>@page rp\{@bottom-center\{content:"Data as of \d{4}-\d{2}-\d{2} \d\d:\d\d Korea time";font-size:9pt;color:black\}\}<\/style>$/);
  assert.equal(V.rbPrintCss({ checkedKst: 'x"} body{display:none} /*' }), '');
  assert.equal(V.rbPrintCss({ checkedKst: '' }), '');
});
test('print css: A4 named page, only the report shows, tables repeat headers, headings and cards stay whole', () => {
  const css = V.RB_CSS;
  assert.match(css, /@page rp\{size:A4;margin:14mm 14mm 18mm\}/);
  assert.match(css, /@media print\{[\s\S]*body\.print-report>\*\{display:none!important\}/);
  assert.match(css, /body\.print-report>#reportPrint\{display:block!important;page:rp\}/);
  assert.match(css, /#reportPrint\{display:none\}/, 'hidden on screen');
  assert.match(css, /\.rp-tbl thead\{display:table-header-group\}/);
  assert.match(css, /\.rp-tbl tr\{break-inside:avoid/);
  assert.match(css, /\.rp-h2\{[^}]*break-after:avoid/);
  assert.match(css, /\.rp-tc\{[^}]*break-inside:avoid/); assert.match(css, /\.rp-b\{[^}]*break-inside:avoid/);
  assert.match(css, /#reportPrint \.rp-sec-tbl\{break-inside:auto/, 'the long table may split across pages');
  assert.match(css, /#reportPrint \.rp-tw\{overflow:visible\}/, 'nothing clips in print');
  assert.match(css, /body\.print-report\{height:auto!important;overflow:visible!important/);
  assert.doesNotMatch(css, /@page\s*\{/, 'no global page rule: other documents print as before');
});
test('print css: the sheet is light paper whatever the theme, and the only hex colours are the paper palette', () => {
  const css = V.RB_CSS;
  const hexLines = css.split('\n').filter((l) => /#[0-9a-fA-F]{3,8}\b/.test(l));
  assert.equal(hexLines.length, 1); assert.match(hexLines[0], /^\s*\.rp-sheet\{--pp-bg:#ffffff;--pp-ink:#111111;/);
  assert.doesNotMatch(css, /rgba?\(/);
  assert.match(css, /print-color-adjust:exact/);
  assert.doesNotMatch(css, /transition:\s*all/);
});
test('css: nothing under 12px, 40px hit areas, every token it reads exists, a phone layout, visible focus', () => {
  const css = V.RB_CSS;
  for (const m of css.matchAll(/var\(--fs-[a-z-]+,(\d+(?:\.\d+)?)px\)/g)) assert.ok(Number(m[1]) >= 12, 'small fallback ' + m[0]);
  for (const m of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)(px|pt)/g)) assert.ok(m[2] === 'pt' ? Number(m[1]) >= 9 : Number(m[1]) >= 12, 'small ' + m[0]);
  for (const m of css.matchAll(/font:\s*\d+\s+(\d+(?:\.\d+)?)px/g)) assert.ok(Number(m[1]) >= 12, 'small ' + m[0]);
  assert.match(css, /\.rb \.btn,\.rb select,\.rb input\[type=date\]\{min-height:var\(--hit,40px\)\}/);
  assert.match(css, /\.rb-opt\{[^}]*min-height:var\(--hit,40px\)/);
  assert.match(css, /@media\(max-width:640px\)/); assert.match(css, /@media\(max-width:900px\)\{\.rb-grid\{grid-template-columns:1fr\}\}/);
  assert.match(css, /:focus-visible\{outline:2px solid var\(--blue\)/);
  const defined = new Set([...HTML.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  for (const m of css.matchAll(/var\((--[a-z0-9-]+)(,[^)]*)?\)/g)) {
    if (m[2]) continue;                                 /* has a fallback */
    assert.ok(defined.has(m[1]) || css.includes(m[1] + ':'), 'undefined token ' + m[1]);
  }
});

/* ---------------- the builder page ---------------- */

test('page: states with no snapshot say what is wrong and offer no controls', () => {
  const cases = {
    off: { snapResp: null, problem: { kind: 'off', text: V.PERF_OFF_TEXT } },
    signin: { snapResp: null, problem: { kind: 'signin', text: 'You are signed out. Sign in as staff to see live performance.' } },
    forbidden: { snapResp: null, problem: { kind: 'forbidden', text: 'Live performance is for staff only, and this account is not staff.' } },
    loading: { snapResp: null, loading: Promise.resolve() },
    empty: { snapResp: { ok: true, state: 'waiting', banner: { kind: 'waiting', text: 'The first read has not finished yet.' }, snapshot: null } }
  };
  for (const [k, c] of Object.entries(cases)) {
    V.perfReset(); Object.assign(V.PERF, { status: null }, c);
    const m = V.rbModel(V.PERF, CTX, UI());
    const h = V.rbHtml(m, V.PERF, UI(), CTX);
    assert.match(h, /Build a report/, k);
    assert.ok(!h.includes('data-rb-csv') && !h.includes('rb-grid'), k + ' drew controls');
    assert.ok(!h.includes('undefined') && !h.includes('NaN'), k);
  }
  V.perfReset(); Object.assign(V.PERF, { snapResp: null, problem: { kind: 'off', text: V.PERF_OFF_TEXT } });
  assert.match(V.rbHtml(V.rbModel(V.PERF, CTX, UI()), V.PERF, UI(), CTX), /Live performance is switched off\. Ask the admin to set the sheet\./);
});
test('page: staff note on screen only, print and CSV turned off when nothing is in the report, no sharing of any kind', () => {
  const full = V.rbHtml(model(BASE()), V.PERF, UI(), CTX);
  assert.match(full, /<p class="rb-staff" role="note"><strong>Staff copy: check before sharing\.<\/strong>/);
  assert.ok(full.indexOf('rb-staff') < full.indexOf('rp-sheet'));
  assert.doesNotMatch(full.slice(full.indexOf('rp-sheet')), /Staff copy/, 'the note is not inside the sheet');
  assert.doesNotMatch(full, /data-rb-print="1" disabled/);
  const empty = V.rbHtml(model(BASE(), { sel: new Set() }), V.PERF, UI({ sel: new Set() }), CTX);
  assert.match(empty, /data-rb-print="1" disabled/); assert.match(empty, /data-rb-csv="1" disabled/);
  for (const h of [full, empty]) {
    assert.doesNotMatch(h, /mailto:|navigator\.share|Copy link|Public link|Share (report|link)|Send (by )?email|Email this/i);
    assert.doesNotMatch(h, /<button[^>]*>\s*(share|email|send|copy link|public)\b/i);
  }
  assert.match(full, /Not in this version/);
});
test('page: campaigns are checkboxes in a labelled group, dates are native inputs, the chip and the refresh button are there', () => {
  const h = V.rbHtml(model(BASE()), V.PERF, UI(), CTX);
  assert.match(h, /<fieldset class="rb-fs"><legend>Campaigns<\/legend>/);
  assert.equal((h.match(/type="checkbox" data-rb-camp=/g) || []).length, 3);
  assert.match(h, /data-rb-camp="CAMPID-SENTINEL-A" checked/);
  assert.match(h, /<input type="date" id="rbFrom" value="" disabled>/);
  const c = V.rbHtml(model(BASE(), { period: 'custom', from: dayAgo(9) }), V.PERF, UI({ period: 'custom', from: dayAgo(9) }), CTX);
  assert.match(c, /<input type="date" id="rbFrom" value="\d{4}-\d{2}-\d{2}">/);
  assert.match(h, /pf-asof/); assert.match(h, /data-rb-refresh="1"/);
  assert.match(h, /<select id="rbSort">/); assert.match(h, /aria-pressed="true">Views<\/button>/);
});
test('page: a failed read keeps the numbers on screen and says so', () => {
  const p = P(BASE());
  p.problem = { kind: 'network', text: 'Could not reach the server.' };
  const h = V.rbHtml(V.rbModel(p, CTX, UI()), p, UI(), CTX);
  assert.match(h, /Showing numbers from \d{4}-\d{2}-\d{2}/); assert.match(h, /rp-sheet/);
});

/* ---------------- wiring, reset and where it lives ---------------- */

test('wiring: clicks and changes only move the builder state, with checked values', () => {
  P(BASE());
  const h = {};
  V.rbWire({ addEventListener: (t, f) => { h[t] = f; }, contains: () => true });
  const btn = (attr, val) => ({ closest: () => ({ hasAttribute: (a) => a === attr, getAttribute: () => val, disabled: false }), });
  h.click({ target: btn('data-rb-all') });
  assert.deepEqual([...V.RBT.sel].sort(), ['CAMPID-SENTINEL-A', 'CAMPID-SENTINEL-B'], 'select all leaves out the unlinked group');
  h.click({ target: btn('data-rb-none') }); assert.equal(V.RBT.sel.size, 0);
  h.click({ target: btn('data-rb-metric', 'saves') }); assert.equal(V.RBT.metric, 'saves');
  const ch = (attrs, extra) => ({ target: Object.assign({ hasAttribute: (a) => a in attrs, getAttribute: (a) => attrs[a], id: '' }, extra) });
  h.change(ch({ 'data-rb-camp': 'CAMPID-SENTINEL-A' }, { checked: true })); assert.ok(V.RBT.sel.has('CAMPID-SENTINEL-A'));
  h.change(ch({ 'data-rb-camp': 'CAMPID-SENTINEL-A' }, { checked: false })); assert.ok(!V.RBT.sel.has('CAMPID-SENTINEL-A'));
  h.change(ch({ 'data-rb-period': '30' }, { value: '30' })); assert.equal(V.RBT.period, '30');
  h.change(ch({ 'data-rb-period': 'x' }, { value: 'x' })); assert.equal(V.RBT.period, '30', 'an unknown period is refused');
  h.change(ch({}, { id: 'rbFrom', value: '2026-11-01' })); assert.equal(V.RBT.from, '2026-11-01');
  h.change(ch({}, { id: 'rbTo', value: '<script>' })); assert.equal(V.RBT.to, '');
  h.change(ch({}, { id: 'rbSort', value: 'views' })); assert.equal(V.RBT.sort, 'views');
  h.change(ch({}, { id: 'rbSort', value: 'evil' })); assert.equal(V.RBT.sort, 'views');
});
test('reset: signing in or out clears what was chosen', () => {
  V.RBT.sel = new Set(['CAMPID-SENTINEL-A']); V.RBT.period = 'custom'; V.RBT.from = '2026-01-01'; V.RBT.metric = 'likes';
  V.perfReset();
  assert.equal(V.RBT.sel.size, 0); assert.equal(V.RBT.period, 'all'); assert.equal(V.RBT.from, ''); assert.equal(V.RBT.metric, 'views');
});
test('source: the builder block makes no request of its own, offers no sharing, and the route and old routes are wired', () => {
  const a = HTML.indexOf('REPORTS: THE REPORT BUILDER'), b = HTML.indexOf('/* The page. The live section is on top;');
  assert.ok(a > 0 && b > a);
  const block = HTML.slice(a, b);
  assert.doesNotMatch(block, /fetch\(|XMLHttpRequest|sendBeacon|mailto:|navigator\.share|location\.(href|assign)|clipboard|localStorage|sessionStorage/);
  assert.match(block, /perfLoad\(\)/); assert.match(block, /window\.addEventListener\('beforeprint', rbFillPrint\)/); assert.match(block, /'afterprint', rbClearPrint/);
  assert.match(HTML, /else if \(item === 'report'\)\s+renderReportBuilder\(view\);/);
  assert.match(HTML, /if \(section === 'reports'\) section = 'overview';/);
  assert.match(HTML, /\{ id: 'report', title: 'Build a report', sub: 'choose, preview, print', section: 'overview' \}/);
  assert.match(HTML, /return \{ today: 'all', payouts: 'all', overview: 'summary'/, 'Reports still opens on Summary');
  /* the Toolkit hand-off page and its route are untouched */
  assert.match(HTML, /\{ id: 'report',       label: 'Report hand-off',     sub: 'Vively Toolkit' \}/);
  assert.match(HTML, /if \(item === 'report'\) \{/);
  const tab = fs.readFileSync(new URL('../src/views/report.js', import.meta.url), 'utf8');
  assert.match(tab, /export function reportTab/); assert.match(tab, /Report CSV \(toolkit format\)/);
});

test('leak scan has teeth: a planted value in a handle, a link or a campaign name is caught', () => {
  const m = model([post({ deliverableId: 'p', creator: { handle: 'leak@example.test' } })]);
  assert.throws(() => leakScan('doc', V.rbDocHtml(m)), /leak@example\.test/);
  assert.throws(() => leakScan('csv', V.rbCsv(m)), /leak@example\.test/);
  const m2 = model([post({ deliverableId: 'p', postUrl: 'https://example.test/p/SHEETID-SENTINEL/' })]);
  assert.throws(() => leakScan('doc', V.rbDocHtml(m2)), /SHEETID-SENTINEL/);
});

/* ---- the byte-order mark, so Excel reads Korean text ---- */
test('csv bom: one byte-order mark at the very start, none anywhere else, then the exact header', () => {
  const csv = V.rbCsv(model(BASE()));
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.equal(csv.charCodeAt(1), 'c'.charCodeAt(0), 'a single mark, not two');
  assert.equal(csv.split('\uFEFF').length - 1, 1);
  assert.ok(csv.slice(1).startsWith(V.RB_COLS.join(',') + '\r\n'));
  /* the source says it with an escape, not a character nobody can see in a review */
  const i = HTML.indexOf('function rbCsv(m) {');
  const body = HTML.slice(i, HTML.indexOf('\n}\n', i));
  assert.ok(body.includes("'\\uFEFF'") && !body.includes('\uFEFF'));
});
test('csv bom: written as UTF-8 the file starts EF BB BF and Korean text comes back whole', () => {
  const kr = '한글핸들_테스트';
  const csv = V.rbCsv(model([post({ deliverableId: 'kr1', creator: { handle: kr, platform: 'Instagram' }, postUrl: 'https://www.instagram.com/p/KR1/' })]));
  const bytes = new TextEncoder().encode(csv);
  assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF]);
  assert.ok(!(bytes[3] === 0xEF && bytes[4] === 0xBB), 'no second mark');
  assert.ok(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes).includes(kr));
  assert.ok(parseCsv(csv.slice(1)).some((r) => r[2] === kr));
});
test('csv bom: the mark does not weaken the formula guard, the header whitelist or the leak scan', () => {
  const m = model(hostilePosts());
  const csv = V.rbCsv(m);
  const rows = parseCsv(csv.slice(1));
  assert.deepEqual(rows[0], V.RB_COLS);
  rows.slice(1).forEach((r) => r.forEach((c) => assert.ok(!/^[=+\-@]/.test(c))));
  /* no data cell can start with the mark, so it cannot be used to hide a formula behind it */
  rows.slice(1).forEach((r) => r.forEach((c) => assert.ok(!c.includes('\uFEFF'))));
  leakScan('csv with mark', V.rbCsv(model(BASE())));
});
