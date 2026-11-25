/* THE MORNING PAGE (Home, #/today) AND THE REPORTS SUMMARY TILE.

   No browser here, so nothing looks at pixels. What is pinned down: the page
   draws with every status call failing, with data missing, with hostile text
   in every field it reads, and with nothing to show; the "Needs you" list is
   in the right order with one button each; held-row codes and names never
   reach the screen; the staff calls are made only when signed in, once per
   open; sign-in and sign-out clear every cached answer (and a call still in
   the air cannot write back afterwards); the phone CSS and the token rules.
   All data is made up. */

import './helpers/browser-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as O from '../src/views/overview.js';
import * as S from '../src/views/socialOverview.js';
import * as C from '../src/views/campaigns.js';
import { DB, byCampaign, byCreator } from '../src/model/db.js';
import { DESK, kstToday } from '../src/views/desk.js';
import { TODAY, iso, DAY } from '../src/lib/dates.js';

const HTML = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-25T12:00:00Z');
const MIN = 60000, HOUR = 3600000;
const ago = (ms, now) => new Date((now == null ? NOW : now) - ms).toISOString();
const BAD = '<script>alert(1)</script>';

/* ---------------- the workspace ---------------- */

function seed() {
  DB.creators.length = 0; DB.campaigns.length = 0; DB.participants.length = 0; DB.socialContent.length = 0;
  Object.keys(byCreator).forEach((k) => delete byCreator[k]);
  Object.keys(byCampaign).forEach((k) => delete byCampaign[k]);
  DB.creators.push({ id: 'cr1', handle: '@minji', name: 'Minji', platform: 'Instagram', followers: 10000 },
    { id: 'cr2', handle: '@jiwoo', name: 'Jiwoo', platform: 'Instagram', followers: 9000 },
    { id: 'cr3', handle: '@hana', name: 'Hana', platform: 'Instagram', followers: 8000 },
    { id: 'cr4', handle: '@dohyun', name: 'Dohyun', platform: 'Instagram', followers: 7000 });
  DB.creators.forEach((c) => { byCreator[c.id] = c; });
  DB.campaigns.push(
    { id: 'cpA', brand: 'Brand A', name: 'Counter visit', kind: 'visit', status: 'live', targetCreators: 6 },
    { id: 'cpB', brand: 'Brand B ' + BAD, name: 'Dinner', kind: 'visit', status: 'live', targetCreators: 4 },
    { id: 'cpS', brand: 'Shipping Co', name: 'Box', kind: 'shipping', status: 'outreach' },
    { id: 'cpW', brand: 'Old Brand', name: 'Done', kind: 'visit', status: 'wrapped' });
  DB.campaigns.forEach((c) => { byCampaign[c.id] = c; });
  const k = kstToday();
  const at = (n, t) => O.homeAddDays(k, n) + ' ' + (t || '12:00');
  const part = (o) => DB.participants.push(Object.assign({ stage: 'confirmed', headcount: '', content: null }, o));
  part({ id: 'p1', campaignId: 'cpA', creatorId: 'cr1', confirmedVisitAt: at(0), headcount: 2 });     /* today, 2 people */
  part({ id: 'p2', campaignId: 'cpA', creatorId: 'cr2', confirmedVisitAt: at(1) });                    /* tomorrow */
  part({ id: 'p3', campaignId: 'cpA', creatorId: 'cr3' });                                            /* no visit date */
  part({ id: 'p4', campaignId: 'cpB', creatorId: 'cr4', confirmedVisitAt: at(-20) });                 /* long past, no post: overdue */
  part({ id: 'p5', campaignId: 'cpS', creatorId: 'cr1' });                                            /* ships: no visit date is fine */
  part({ id: 'p6', campaignId: 'cpW', creatorId: 'cr2' });                                            /* wrapped campaign: ignored */
}

/* ---------------- fake answers ---------------- */

function post(o) {
  return Object.assign({ deliverableId: 'd?', sheetCampaignId: 'A', postUrl: 'https://www.instagram.com/p/abc/', platform: 'Instagram',
    creator: { handle: '@ok', platform: 'Instagram', followers: 100 }, postedDate: '2026-11-20', views: 1000, likes: 100, er: 5,
    lastScrapedAt: ago(3 * HOUR), flags: { hasReading: true },
    rate: 'RATE-SENTINEL-77', email: 'leak@example.test', amount: 'AMOUNT-SENTINEL-88' }, o);
}
function snap(posts, extra) {
  return Object.assign({ version: 1, checkedAt: ago(12 * MIN), newestReadingAt: ago(3 * HOUR), intervalMin: 30,
    campaigns: [{ sheetCampaignId: 'A', name: 'Autumn ' + BAD, match: { state: 'matched', dashboardCampaignId: 'cpA', candidates: [], reason: '' } },
      { sheetCampaignId: 'B', name: 'Beta', match: { state: 'needs-match', candidates: [], reason: 'no-match' } },
      { sheetCampaignId: 'D', name: 'Delta', match: { state: 'needs-match', candidates: [], reason: 'ambiguous' } },
      { sheetCampaignId: 'F', name: 'Foxtrot', match: { state: 'needs-match', candidates: [], reason: 'shared' } }],
    needsMatch: [{ sheetCampaignId: 'B', name: 'Beta', reason: 'no-match', candidates: [] },
      { sheetCampaignId: 'D', name: 'Delta', reason: 'ambiguous', candidates: [] },
      { sheetCampaignId: 'F', name: 'Foxtrot', reason: 'shared', candidates: [] }],
    posts }, extra || {});
}
const POSTS = () => [
  post({ deliverableId: 'a', creator: { handle: BAD, platform: 'Instagram' }, views: 9000, er: 4, postedDate: '2026-11-24', postUrl: 'javascript:alert(1)' }),
  post({ deliverableId: 'b', views: 5000, er: 6, postedDate: '2026-11-22' }),
  post({ deliverableId: 'c', views: 7000, er: null, postedDate: '2026-11-10' }),
  post({ deliverableId: 'd', views: null, likes: null, er: null, postedDate: '2026-11-21', flags: { hasReading: false } }),
  post({ deliverableId: 'e', views: 100, er: 2, postedDate: '2026-09-01' })];
const okResp = (level, s) => ({ ok: true, state: 'ok', banner: { kind: 'ok', text: '' }, freshness: { level, reason: '' }, snapshot: s || snap(POSTS()) });
function perfIn(over) {
  S.perfReset();
  Object.assign(S.PERF, { status: { ok: true, enabled: true, intervalMin: 30 }, snapResp: okResp('green') }, over || {});
  return S.PERF;
}
const notionOk = (body) => ({ applicants: { status: 200, body: Object.assign({ ok: true, enabled: true, intervalMin: 10, dryRun: false,
  state: { heldTotal: 3, held: [{ campaignId: 'SECRET-CAMPAIGN-ID', pageId: 'SECRET-PAGE-ID', why: 'no-handle' }, { campaignId: 'x', pageId: 'y', why: 'no-handle' },
    { campaignId: 'x', pageId: 'z', why: 'weird-code-' + BAD }] },
  last: { at: '2026-11-25T01:00:00Z', campaigns: [] } }, body || {}) }, autocreate: { status: 200, body: { ok: true, enabled: false } } });
/* PERF is one shared object: build the default only when the test did not bring its own */
const env = (o) => Object.assign({ nowMs: NOW, signedIn: true, hub: notionOk(), local: O.homeLocal() }, o || {}, { perf: o && o.perf ? o.perf : perfIn() });

beforeEach(() => { seed(); S.perfReset(); C.HUB.data = null; C.HUB.at = 0; C.HUB.promise = null; O.HOME_ENV.signedIn = () => true; });

/* ---------------- the local numbers ---------------- */

test('local: today, this week, no-date and overdue come from the workspace, wrapped and shipping campaigns left out', () => {
  const L = O.homeLocal();
  assert.equal(L.todayTeams, 1); assert.equal(L.todayHeads, 2);
  assert.equal(L.weekTotal, 2); assert.equal(L.week.length, 7); assert.equal(L.week[0].key, kstToday());
  assert.deepEqual(L.noDate.map((c) => [c.id, c.n]), [['cpA', 1]], 'only the visit campaign with a confirmed creator and no date');
  assert.equal(L.overdue.n, 1); assert.deepEqual(L.overdue.camps, ['cpB']);
  assert.equal(L.live, 2); assert.equal(L.open, 3, 'wrapped is not open');
});

/* ---------------- the page draws, always ---------------- */

const ALL_PERF = {
  loading: () => perfIn({ snapResp: null }),
  off: () => perfIn({ snapResp: null, problem: { kind: 'off', text: S.PERF_OFF_TEXT } }),
  signin: () => perfIn({ snapResp: null, problem: { kind: 'signin', text: 'You are signed out. Sign in as staff to see live performance.' } }),
  forbidden: () => perfIn({ snapResp: null, problem: { kind: 'forbidden', text: 'Live performance is for staff only, and this account is not staff.' } }),
  error: () => perfIn({ snapResp: null, problem: { kind: 'error', text: 'Something went wrong. ' + BAD } }),
  empty: () => perfIn({ snapResp: { ok: true, state: 'waiting', banner: { kind: 'waiting', text: 'The first read has not finished yet. ' + BAD }, snapshot: null } }),
  network: () => perfIn({ problem: { kind: 'network', text: 'Could not reach the server.' } }),
  ok: () => perfIn()
};
const ALL_HUB = {
  loading: null,
  s401: { applicants: { status: 401, body: {} }, autocreate: { status: 401, body: {} } },
  s403: { applicants: { status: 403, body: {} }, autocreate: { status: 403, body: {} } },
  s503: { applicants: { status: 503, body: { error: 'x' } }, autocreate: { status: 503, body: {} } },
  net: { applicants: { status: 0, body: { error: 'Could not reach the server.' } }, autocreate: { status: 0, body: {} } },
  garbage: { applicants: { status: 200, body: 'nope' }, autocreate: { status: 200, body: null } },
  off: { applicants: { status: 200, body: { ok: true, enabled: false } }, autocreate: { status: 200, body: {} } },
  ok: notionOk(),
  okNoState: { applicants: { status: 200, body: { ok: true, enabled: true, last: { campaigns: [{ campaignId: 'q', counts: { held: 2 } }] } } }, autocreate: { status: 200, body: {} } }
};

test('the page draws with every endpoint failing, in every combination, and never blank', () => {
  for (const [pk, mk] of Object.entries(ALL_PERF)) {
    for (const [hk, hub] of Object.entries(ALL_HUB)) {
      const m = O.homeModel(env({ perf: mk(), hub }));
      const h = O.homeHtml(m);
      const tag = pk + '/' + hk;
      for (const must of ['Needs you', 'This week', 'Performance highlights', 'Notion sync', 'dk-band', 'Creator tiers'])
        assert.ok(h.includes(must), tag + ' lacks ' + must);
      assert.ok(!h.includes('undefined') && !h.includes('NaN') && !h.includes('[object'), tag + ' leaked a JS value');
      assert.ok(!h.includes('<script>'), tag + ' let a script through');
      assert.equal((h.match(/class="dk-b"/g) || []).length, 5, tag + ': five cells');
    }
  }
});
test('the page draws when the workspace itself cannot be worked out, with a retry', () => {
  const m = O.homeModel(env({ local: null }));
  const h = O.homeHtml(m);
  assert.match(h, /Could not work out the visits and deadlines/);
  assert.match(h, /data-hm2-retry="1">Try again<\/button>/);
  assert.match(h, /Part of this page could not be worked out\./);
  assert.ok(h.includes('Performance highlights') && h.includes('Notion sync'));
});
test('signed out: nothing is claimed that was not read; sentences say sign in', () => {
  const m = O.homeModel(env({ signedIn: false, hub: null, perf: perfIn({ snapResp: okResp('green') }) }));
  const h = O.homeHtml(m);
  assert.match(h, /Sign in as staff to see live performance\./);
  assert.match(h, /Sign in as staff to see the Notion check\./);
  assert.ok(!/Top 3 posts/.test(h), 'old numbers held in memory are not shown to a signed-out page');
  assert.equal(m.pending, false);
});
test('failure sentences are plain: 401, 403, 503 and network each say what to do', () => {
  const text = (hub) => O.homeHtml(O.homeModel(env({ hub })));
  assert.match(text(ALL_HUB.s401), /You are signed out\. Sign in as staff to see the Notion check\./);
  assert.match(text(ALL_HUB.s403), /for staff only, and this account is not staff/);
  assert.match(text(ALL_HUB.s503), /The Notion check is not available right now\./);
  assert.match(text(ALL_HUB.net), /Could not reach the server, so Notion could not be checked\./);
  assert.match(text(ALL_HUB.off), /Notion sync is switched off\./);
  assert.match(O.homeHtml(O.homeModel(env({ perf: ALL_PERF.off() }))), /Live performance is switched off\. Ask the admin to set the sheet\./);
  assert.match(O.homeHtml(O.homeModel(env({ perf: ALL_PERF.network() }))), /Could not reach the server\. Showing numbers from 2026-11-25/);
});
test('"Needs you" says what could not be read, so an empty list is not mistaken for all clear', () => {
  seed(); DB.participants.length = 0;
  const h = O.homeHtml(O.homeModel(env({ hub: ALL_HUB.net, perf: ALL_PERF.error(), local: O.homeLocal() })));
  assert.match(h, /Nothing needs a person right now\./);
  assert.match(h, /Notion: Could not reach the server/);
  assert.match(h, /Live performance: Something went wrong/);
});

/* ---------------- the band ---------------- */

test('band: five cells with the right numbers, and "—" where the sheet did not read', () => {
  const h = O.homeHtml(O.homeModel(env()));
  const cells = [...h.matchAll(/<div class="dk-b"><div class="lab">([^<]*)<\/div><div class="big">([^<]*)<\/div><div class="cap">([^<]*)<\/div>/g)].map((x) => x.slice(1));
  assert.deepEqual(cells.map((c) => c[0]), ['Today’s visits', 'Waiting for approval', 'Campaigns live', 'Posts this month', 'Views, last 30 days']);
  assert.deepEqual(cells[0].slice(1), ['1', '2 people']);
  assert.deepEqual(cells[1].slice(1), ['3', 'applicants held in Notion']);
  assert.deepEqual(cells[2].slice(1), ['2', 'of 3 not wrapped']);
  /* NOW is 2026-11-25: posts a, b, d are from 20-24 Nov... this month (Nov) are a, b, c, d */
  assert.deepEqual(cells[3].slice(1), ['4', 'by posted date, from the sheet']);
  /* last 30 days from 2026-11-25: Oct 27 on. a, b, c, d; views 9000 + 5000 + 7000, d unread */
  assert.deepEqual(cells[4].slice(1), ['21,000', 'from 3 of 4 posts']);
});
test('band: nothing read at all is a dash and "Not measured", never zero', () => {
  const none = snap([post({ deliverableId: 'x', views: null, likes: null, er: null, postedDate: '2026-11-20', flags: { hasReading: false } })]);
  const h = O.homeHtml(O.homeModel(env({ perf: perfIn({ snapResp: okResp('green', none) }) })));
  assert.match(h, /<div class="lab">Views, last 30 days<\/div><div class="big">—<\/div><div class="cap">Not measured<\/div>/);
  const m = O.homeModel(env({ perf: perfIn({ snapResp: okResp('green', none) }) }));
  assert.equal(m.perf.views30, null);
  assert.match(O.homeHtml(m), /Average ER: — \(no rate given\)/);
  assert.match(O.homeHtml(m), /No post from the last 30 days has a views reading yet\./);
});
test('band: with the calls failing the remote cells are dashes with a reason, local cells still show', () => {
  const h = O.homeHtml(O.homeModel(env({ perf: ALL_PERF.error(), hub: ALL_HUB.s401 })));
  assert.match(h, /<div class="lab">Waiting for approval<\/div><div class="big">—<\/div><div class="cap">Sign in as staff<\/div>/);
  assert.match(h, /<div class="lab">Posts this month<\/div><div class="big">—<\/div><div class="cap">Could not read the sheet<\/div>/);
  assert.match(h, /<div class="lab">Today’s visits<\/div><div class="big">1<\/div>/);
  assert.match(h, /<div class="lab">Campaigns live<\/div><div class="big">2<\/div>/);
});
test('band: Notion count falls back to the last-run counts, and null waiting is a dash', () => {
  const h = O.homeHtml(O.homeModel(env({ hub: ALL_HUB.okNoState })));
  assert.match(h, /<div class="lab">Waiting for approval<\/div><div class="big">2<\/div>/);
  const none = { applicants: { status: 200, body: { ok: true, enabled: true } }, autocreate: { status: 200, body: {} } };
  assert.match(O.homeHtml(O.homeModel(env({ hub: none }))), /<div class="lab">Waiting for approval<\/div><div class="big">—<\/div><div class="cap">Count not available<\/div>/);
});

/* ---------------- Needs you ---------------- */

test('Needs you: the order is visit dates, not posted, applicants, old numbers, match; one button each', () => {
  DB.campaigns.push({ id: 'cpC', brand: 'Brand C', name: 'Third', kind: 'visit', status: 'live' }); byCampaign.cpC = DB.campaigns[DB.campaigns.length - 1];
  DB.participants.push({ id: 'p9', campaignId: 'cpC', creatorId: 'cr1', stage: 'confirmed', content: null });
  DB.participants.push({ id: 'p10', campaignId: 'cpC', creatorId: 'cr2', stage: 'confirmed', content: null });
  const old = perfIn({ snapResp: okResp('red', Object.assign(snap(POSTS()), { checkedAt: ago(9 * 24 * HOUR), newestReadingAt: ago(9 * 24 * HOUR) })) });
  const m = O.homeModel(env({ perf: old }));
  assert.deepEqual(m.needs.map((n) => n.key), ['visit-date:cpC', 'visit-date:cpA', 'not-posted', 'applicants', 'stale-performance', 'match']);
  const h = O.homeHtml(m);
  const rows = h.split('<li class="hm2-need').slice(1);
  assert.equal(rows.length, 6);
  rows.forEach((r) => assert.equal((r.match(/<a class="btn sm primary"/g) || []).length, 1, 'one button per row'));
  assert.match(h, /href="#\/campaigns\/cpC">Set visit dates<\/a>/);
  assert.match(h, /href="#\/campaigns\/cpB">See who to chase<\/a>/);
  assert.match(h, /href="#\/creators">See the creators<\/a>/);
  assert.match(h, /href="#\/social\/performance">Open Performance<\/a>/);
  assert.match(h, /href="#\/social\/performance">Match them<\/a>/);
  assert.match(h, /6 things need you today\./);
});
test('Needs you: only ambiguous and shared sheet campaigns count for a match; no-match is quiet', () => {
  const m = O.homeModel(env());
  assert.equal(m.perf.needsMatch, 2);
  assert.match(O.homeHtml(m), /2 sheet campaigns need a match/);
  const onlyNoMatch = snap(POSTS(), { needsMatch: [{ sheetCampaignId: 'B', name: 'Beta', reason: 'no-match', candidates: [] }] });
  const m2 = O.homeModel(env({ perf: perfIn({ snapResp: okResp('green', onlyNoMatch) }) }));
  assert.equal(m2.perf.needsMatch, 0);
  assert.ok(!m2.needs.some((n) => n.key === 'match'));
});
test('Needs you: more than three campaigns without a visit date fold into one "more" row', () => {
  for (let i = 0; i < 5; i++) {
    const id = 'cx' + i;
    DB.campaigns.push({ id, brand: 'Extra ' + i, name: 'n', kind: 'visit', status: 'live' }); byCampaign[id] = DB.campaigns[DB.campaigns.length - 1];
    DB.participants.push({ id: 'px' + i, campaignId: id, creatorId: 'cr1', stage: 'confirmed', content: null });
  }
  const m = O.homeModel(env({ hub: null }));
  const keys = m.needs.map((n) => n.key);
  assert.equal(keys.filter((k) => k.startsWith('visit-date:') && k !== 'visit-date:more').length, 3);
  assert.ok(keys.includes('visit-date:more'));
  assert.match(O.homeHtml(m), /3 more campaigns have creators with no visit date/);
});
test('Needs you: the sentence counts what is known and says what is still being read', () => {
  const m = O.homeModel(env({ perf: ALL_PERF.loading(), hub: null }));
  assert.equal(m.pending, true);
  assert.match(m.summary, /^2 things need you today\. Still checking Notion and the sheet\.$/);
  const clear = O.homeModel(env({ local: Object.assign(O.homeLocal(), { noDate: [], overdue: { n: 0, camps: [] } }), hub: ALL_HUB.off, perf: ALL_PERF.off() }));
  assert.equal(clear.summary, 'Nothing needs you right now.');
  assert.match(O.homeHtml(clear), /Nothing needs a person right now\./);
  assert.equal(O.homeModel(env({ perf: ALL_PERF.loading(), hub: null, local: Object.assign(O.homeLocal(), { noDate: [], overdue: { n: 0, camps: [] } }) })).summary, 'Checking Notion and the sheet…');
});

/* ---------------- plain words, no codes, no names ---------------- */

test('held rows: plain words only; no raw code, page id, campaign id or name reaches the page', () => {
  const h = O.homeHtml(O.homeModel(env()));
  assert.match(h, /2 waiting: no Instagram link yet/);
  assert.match(h, /1 waiting: waiting for the next check/, 'an unknown code is turned into plain words');
  for (const raw of ['no-handle', 'unknown-status', 'weird-code', 'SECRET-PAGE-ID', 'SECRET-CAMPAIGN-ID', 'held:', 'heldTotal', 'pageId'])
    assert.ok(!h.includes(raw), 'leaked ' + raw);
});
test('hostile text in every field it reads cannot become markup', () => {
  const evil = snap([post({ deliverableId: 'a', creator: { handle: BAD + '"><img src=x>', platform: 'Instagram' }, views: 5, platform: BAD, postUrl: 'https://ok.test/' + '"onmouseover="x' }),
    post({ deliverableId: 'b', sheetCampaignId: 'A', postedDate: '2026-11-24' })]);
  const m = O.homeModel(env({ perf: perfIn({ snapResp: okResp('green', evil) }), hub: notionOk({ state: { heldTotal: 1, held: [{ why: BAD }] } }) }));
  const h = O.homeHtml(m);
  assert.ok(!h.includes('<script>') && !h.includes('<img'), 'no live tag');
  assert.ok(h.includes('&lt;script&gt;'), 'the text is still there, escaped');
  assert.ok(!/RATE-SENTINEL|AMOUNT-SENTINEL|leak@example/.test(h), 'fields outside the whitelist are never read');
  assert.ok(!h.includes('javascript:'));
  /* a brand name with a script in it, in the visit list */
  byCampaign.cpA.brand = 'Brand A ' + BAD;
  const withBrand = O.homeHtml(O.homeModel(env({ hub: null })));
  assert.ok(!withBrand.includes('<script>'));
  assert.ok(withBrand.includes('Brand A &lt;script&gt;alert(1)&lt;/script&gt;: 1 confirmed creator has no visit date'));
});

/* ---------------- the highlights card ---------------- */

test('highlights: top 3 by views in the last 30 days, the printed ER definition, the freshness chip', () => {
  const m = O.homeModel(env());
  assert.deepEqual(m.perf.top.map((p) => p.views), [9000, 7000, 5000]);
  assert.equal(m.perf.last30.avgEr, 5, 'mean of the valid rates 4 and 6 (the post with no rate is left out)');
  const h = O.homeHtml(m);
  assert.match(h, /Average ER: 5\.00% \(mean of 2 posts\)/);
  assert.match(h, /Average ER is the plain average of the rates the sheet gives\. A post with no rate is left out, not counted as zero\./);
  assert.match(h, /class="pf-asof pf-green"/);
  assert.match(h, /Fresh/);
  assert.match(h, /href="#\/social\/performance">Open Performance →<\/a>/);
  assert.ok(h.indexOf('#1 ·') < h.indexOf('#2 ·') && h.indexOf('#2 ·') < h.indexOf('#3 ·'));
  assert.ok(!h.includes('#4 ·'));
});
test('highlights: stale numbers say so with the shape and word, not colour alone', () => {
  const h = O.homeHtml(O.homeModel(env({ perf: perfIn({ snapResp: okResp('amber') }) })));
  assert.match(h, /class="pf-asof pf-amber"/); assert.match(h, /Getting old/);
  assert.match(h, /Performance numbers are getting old/);
});

/* ---------------- the week strip ---------------- */

test('this week: seven days, today first, a button each, zero days are a dash', () => {
  const h = O.homeHtml(O.homeModel(env()));
  const days = h.match(/<button type="button" class="hm2-day[^>]*>/g) || [];
  assert.equal(days.length, 7);
  assert.match(days[0], /hm2-day today/);
  assert.match(days[0], new RegExp('data-hm2-day="' + kstToday() + '"'));
  assert.match(h, /1 visit<\/span>/);
  assert.match(h, /class="s">2 people<\/span>/);
  assert.match(days[3], /hm2-day z/);
  seed(); DB.participants.length = 0;
  assert.match(O.homeHtml(O.homeModel(env({ local: O.homeLocal() }))), /No visits booked in the next 7 days\./);
});
test('this week: a day button opens the Desk on that day; retry only calls the server when signed in', async () => {
  const body = { listeners: {}, innerHTML: '', attrs: {}, addEventListener(t, f) { this.listeners[t] = f; }, contains: () => true, setAttribute(k, v) { this.attrs[k] = v; } };
  const view = { querySelector: (s) => (s === '#hm2Body' ? body : null) };
  O.homeWire(body, view);
  const btn = (a) => ({ hasAttribute: (k) => k in a, getAttribute: (k) => a[k] });
  const keepDay = DESK.day;
  DESK.day = '';
  body.listeners.click({ target: { closest: () => btn({ 'data-hm2-day': '2026-11-26' }) } });
  assert.equal(DESK.day, '2026-11-26'); assert.equal(location.hash, '#/desk');
  DESK.day = keepDay;
  const calls = [];
  const keepFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { calls.push(u); return { ok: false, status: 401, json: async () => ({}) }; };
  try {
    O.HOME_ENV.signedIn = () => false;
    body.listeners.click({ target: { closest: () => btn({ 'data-hm2-retry': '1' }) } });
    assert.equal(calls.length, 0, 'signed out: retry makes no call');
    assert.match(body.innerHTML, /Sign in as staff to see live performance\./);
  } finally { globalThis.fetch = keepFetch; }
});

/* ---------------- the staff calls: only signed in, once per open, reset on sign in/out ---------------- */

function fakeFetch(routes) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const r = routes[url] || { status: 404, body: {} };
    const out = typeof r === 'function' ? await r() : r;
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.body };
  };
  f.calls = calls;
  return f;
}
const GOOD_ROUTES = () => ({
  '/api/perf/status': { status: 200, body: { ok: true, enabled: true, intervalMin: 30 } },
  '/api/perf/snapshot': { status: 200, body: { ok: true, state: 'ok', banner: { kind: 'ok', text: '' }, freshness: { level: 'green', reason: '' }, snapshot: snap(POSTS(), { checkedAt: ago(5 * MIN, Date.now()), newestReadingAt: ago(HOUR, Date.now()) }) } },
  '/api/notion-applicants/status': { status: 200, body: notionOk().applicants.body },
  '/api/notion/autocreate/status': { status: 200, body: { ok: true, enabled: false } }
});
function fakeView() {
  const body = { innerHTML: '', listeners: {}, attrs: {}, addEventListener(t, f) { this.listeners[t] = f; }, contains: () => true, setAttribute(k, v) { this.attrs[k] = v; } };
  const say = { textContent: '' };
  const view = { innerHTML: '', querySelector: (s) => (s === '#hm2Body' ? body : s === '#hm2Announce' ? say : null) };
  return { view, body, say };
}
async function withDom(fn) {
  const keep = { g: document.getElementById, h: document.head, c: document.createElement, f: globalThis.fetch };
  document.getElementById = () => null;
  document.head = { appendChild() {} };
  document.createElement = () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} });
  try { return await fn(); } finally { document.getElementById = keep.g; document.head = keep.h; document.createElement = keep.c; globalThis.fetch = keep.f; }
}
const settle = () => new Promise((r) => setTimeout(r, 25));

test('calls: signed out makes none; signed in makes each staff call once and draws the answers', async () => {
  await withDom(async () => {
    const f = fakeFetch(GOOD_ROUTES()); globalThis.fetch = f;
    O.HOME_ENV.signedIn = () => false;
    const a = fakeView(); O.renderToday(a.view, 'all'); await settle();
    assert.equal(f.calls.length, 0);
    assert.match(a.body.innerHTML, /Sign in as staff/);

    O.HOME_ENV.signedIn = () => true;
    const b = fakeView(); O.renderToday(b.view, 'all');
    assert.match(b.body.innerHTML, /Reading live performance…/, 'first paint says it is reading');
    assert.match(b.body.innerHTML, /Checking Notion…/);
    await settle();
    assert.deepEqual([...f.calls].sort(), ['/api/notion-applicants/status', '/api/notion/autocreate/status', '/api/perf/snapshot', '/api/perf/status']);
    assert.match(b.body.innerHTML, /Top 3 posts, last 30 days/);
    assert.match(b.body.innerHTML, /Notion sync is on\./);
    assert.match(b.say.textContent, /things? need/);
    const n = f.calls.length;
    const c = fakeView(); O.renderToday(c.view, 'all'); await settle();     /* a second open inside 30 s */
    assert.equal(f.calls.length, n, 'cached: no new calls');
    assert.match(c.body.innerHTML, /Top 3 posts, last 30 days/, 'a repeat open is complete on the first paint');
  });
});
test('calls: 401, 403, 503 and a dead network each draw the page with a plain sentence', async () => {
  await withDom(async () => {
    for (const [status, re] of [[401, /signed out/], [403, /staff only/], [503, /not available right now|switched off/], [0, /Could not reach the server/]]) {
      S.perfReset(); C.HUB.data = null; C.HUB.at = 0;
      const routes = {};
      ['/api/perf/status', '/api/perf/snapshot', '/api/notion-applicants/status', '/api/notion/autocreate/status'].forEach((u) => { routes[u] = { status: status || 500, body: {} }; });
      globalThis.fetch = status === 0 ? async () => { throw new Error('down'); } : fakeFetch(routes);
      const v = fakeView(); O.renderToday(v.view, 'all'); await settle();
      assert.ok(v.body.innerHTML.includes('Needs you') && v.body.innerHTML.includes('Notion sync'), status + ' still draws');
      assert.match(v.body.innerHTML, re, String(status));
      assert.ok(!v.body.innerHTML.includes('undefined'));
    }
  });
});
test('reset: sign-in and sign-out forget cached answers, including a "signed out" answer', async () => {
  await withDom(async () => {
    const f = fakeFetch(GOOD_ROUTES()); globalThis.fetch = f;
    /* a signed-out answer is cached for 30 s ... */
    const out = { '/api/perf/status': { status: 401, body: {} }, '/api/perf/snapshot': { status: 401, body: {} }, '/api/notion-applicants/status': { status: 401, body: {} }, '/api/notion/autocreate/status': { status: 401, body: {} } };
    globalThis.fetch = fakeFetch(out);
    const a = fakeView(); O.renderToday(a.view, 'all'); await settle();
    assert.equal(S.PERF.problem.kind, 'signin'); assert.ok(C.HUB.data);
    /* ... until sign-in clears it, and the next open asks again and succeeds */
    O.resetStaffCaches();
    assert.equal(S.PERF.problem, null); assert.equal(S.PERF.at, 0); assert.equal(C.HUB.data, null); assert.equal(C.HUB.at, 0);
    globalThis.fetch = f;
    const b = fakeView(); O.renderToday(b.view, 'all'); await settle();
    assert.equal(f.calls.length, 4);
    assert.match(b.body.innerHTML, /Top 3 posts/);
    /* sign-out: old numbers leave memory */
    O.resetStaffCaches();
    assert.equal(S.PERF.snapResp, null); assert.equal(S.PERF.status, null); assert.equal(C.HUB.data, null);
  });
});
test('reset: a call still in the air when someone signs out cannot write its answer back', async () => {
  await withDom(async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const routes = GOOD_ROUTES();
    const slow = async () => { await gate; return { status: 200, body: GOOD_ROUTES()['/api/perf/snapshot'].body }; };
    globalThis.fetch = fakeFetch(Object.assign({}, routes, { '/api/perf/snapshot': slow,
      '/api/notion-applicants/status': async () => { await gate; return { status: 200, body: notionOk().applicants.body }; } }));
    const v = fakeView(); O.renderToday(v.view, 'all');
    await settle();
    O.resetStaffCaches();               /* sign-out while both reads are running */
    release(); await settle();
    assert.equal(S.PERF.snapResp, null, 'the perf answer was dropped');
    assert.equal(S.PERF.at, 0);
    assert.equal(C.HUB.data, null, 'the Notion answer was dropped');
    assert.equal(C.HUB.promise, null);
  });
});
test('shell: sign-in, sign-out and refusals all clear the staff caches, and the page asks the shell who is signed in', () => {
  const grab = (head) => { const i = HTML.indexOf(head); assert.ok(i > 0, head); return HTML.slice(i, i + 700); };
  assert.ok(grab('function setAuthLocked(locked) {').includes('resetStaffCaches();'));
  assert.ok(grab('function showAccessDenied() {').includes('resetStaffCaches();'));
  assert.ok(grab('async function signOut() {').includes('resetStaffCaches();'));
  assert.match(HTML, /HOME_ENV\.signedIn = \(\) => !!authState\.user && !document\.body\.classList\.contains\('auth-locked'\);/);
  /* every path that signs in goes through setAuthLocked(false), every path that signs out through setAuthLocked(true) */
  assert.ok(/setAuthLocked\(false\);\s*toast\('Login sukses/.test(HTML));
  assert.ok(/AUTH_HOOKS\.onRefused[\s\S]{0,300}setAuthLocked\(true\)/.test(HTML));
});

/* ---------------- Reports > Summary ---------------- */

test('summary tile: live figures when the snapshot is there, with the chip and the source named', () => {
  const f = O.homeSummaryFigures(perfIn(), NOW);
  assert.equal(f.st.views, 21100);
  const h = O.homeSummaryHtml(f);
  assert.match(h, /<div class="v">21,100<\/div>/);
  assert.match(h, /4 of 5 live posts have a reading/);
  assert.match(h, /Average ER: 4\.00% \(mean of 3 posts\)/);
  assert.match(h, /class="pf-asof pf-green pf-sm"/);
  assert.match(h, /Source: live sheet, all posts/);
});
test('summary tile: with no snapshot (sync off, signed out, nothing read) the old figure stays and says imported', () => {
  assert.equal(O.homeSummaryFigures(perfIn({ snapResp: null, problem: { kind: 'off', text: 'x' } }), NOW), null);
  assert.equal(O.homeSummaryFigures(perfIn({ snapResp: { snapshot: null } }), NOW), null);
  const none = snap([post({ views: null, likes: null, er: null, flags: { hasReading: false } })]);
  assert.equal(O.homeSummaryFigures(perfIn({ snapResp: okResp('green', none) }), NOW), null, 'posts but no reading: keep the imported total');
  assert.ok(HTML.includes('Source: imported numbers (Setup)</div>\', \'hmViewsSat\')'));
  assert.ok(HTML.includes('homeSummaryLive(view);'));
});
test('summary tile: a signed-out page makes no call', async () => {
  await withDom(async () => {
    const f = fakeFetch(GOOD_ROUTES()); globalThis.fetch = f;
    O.HOME_ENV.signedIn = () => false;
    const sat = { innerHTML: 'old' };
    O.homeSummaryLive({ querySelector: (s) => (s === '#hmViewsSat' ? sat : null) });
    await settle();
    assert.equal(f.calls.length, 0); assert.equal(sat.innerHTML, 'old');
    O.HOME_ENV.signedIn = () => true;
    O.homeSummaryLive({ querySelector: (s) => (s === '#hmViewsSat' ? sat : null) });
    await settle();
    assert.match(sat.innerHTML, /Source: live sheet/);
  });
});

/* ---------------- routes and look ---------------- */

test('routes: Home is the morning page; #/today/creators and a campaign id still reach the tier tables', () => {
  assert.ok(HTML.includes('function renderTodayCreators(view, item) {'));
  assert.match(HTML, /if \(item && item !== 'all' && \(item === 'creators' \|\| byCampaign\[item\]\)\) \{ renderTodayCreators\(view, item\); return; \}/);
  assert.ok(O.homeHtml(O.homeModel(env())).includes('href="#/today/creators">Creator tiers and creators not used yet'));
  assert.ok(O.homeHtml(O.homeModel(env())).includes('href="#/creators">All creators'));
});
function homeStyles() {
  const out = [];
  const keep = { g: document.getElementById, h: document.head, c: document.createElement };
  document.getElementById = () => null;
  document.head = { appendChild: (n) => out.push(n.textContent) };
  document.createElement = () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} });
  try { O.ensureHomeMorningStyles(); } finally { document.getElementById = keep.g; document.head = keep.h; document.createElement = keep.c; }
  return out.join('\n');
}
test('phone and look: one column at 390px with 44px targets; tokens only; no transition-all; 12px floor', () => {
  const css = homeStyles();
  const phone = css.slice(css.indexOf('@media(max-width:760px)'));
  assert.match(phone, /\.hm2-grid\{grid-template-columns:1fr\}/);
  assert.match(phone, /\.hm2-need\{grid-template-columns:1fr\}/);
  assert.match(phone, /\.hm2-need \.btn\{width:100%;min-height:44px\}/);
  assert.match(phone, /\.hm2-day,\.hm2-more,\.hm2-card \.btn\{min-height:44px\}/);
  assert.match(css, /@media\(max-width:1000px\)\{\.hm2-band \.dk-b:last-child\{grid-column:span 2\}\}/);
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(css) && !/rgba?\(/.test(css), 'no hard-coded colours');
  assert.ok(!/transition:\s*all/.test(css));
  const sizes = [...css.matchAll(/font(?:-size)?:([^;}]*)/g)].flatMap((d) => [...d[1].matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1])));
  assert.ok(sizes.length > 5 && sizes.every((n) => n >= 12), 'sizes: ' + sizes.join(','));
  const defined = new Set([...HTML.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  [...css.matchAll(/var\((--[a-z0-9-]+)/g)].forEach((m) => assert.ok(defined.has(m[1]), 'undefined token ' + m[1]));
});
test('accessibility: status is announced politely, buttons are real buttons, links have text', () => {
  const h = O.homeHtml(O.homeModel(env()));
  assert.ok(HTML.includes('<div id="hm2Announce" class="sr-only" role="status" aria-live="polite"></div>'));
  assert.match(h, /<section class="hm2-card" aria-labelledby="hm2h-needs">/);
  assert.match(h, /<div class="dk-band hm2-band" role="group" aria-label="Today in numbers">/);
  assert.ok(!/<(div|span)[^>]*onclick/.test(h));
  assert.match(h, /aria-label="[^"]*, today: 1 visit, 2 people"/);
});
