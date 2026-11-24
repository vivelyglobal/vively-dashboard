/* Campaign hub v1: the Overview tab, its two link fields, the Notion strip and
   the keyboard / contrast fixes that shipped with it.

   Everything here is fake data and a stand-in page (no browser, no network,
   no Mongo). It checks logic, escaping, request shapes and source text. It
   does NOT check how anything looks (visuals unverified). */
import './helpers/browser-shim.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hubCheckLink, hubSafeLink, hubNotionPageUrl, hubNotionOrigin, hubNotionModel, hubNotionBodyHtml, hubDocsHtml,
  hubCachedNotion, hubLoadNotion, HUB, HUB_LINKS, overviewTab, CAMPAIGN_GROUPS, renderCampaignSection
} from '../src/views/campaigns.js';
import { handoffCampaign } from '../src/views/report.js';
import { drawerTrapTarget, openDrawer, closeDrawer, toast } from '../src/ui/overlay.js';
import { DB, byCampaign } from '../src/model/db.js';
import { SHEET_SCHEMA } from '../src/sync/sheets.js';

const require = createRequire(import.meta.url);
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/* ------------------------------------------------------------------ 1. link fields */

test('sheetUrl accepts https on docs.google.com and drive.google.com only', () => {
  for (const ok of ['https://docs.google.com/spreadsheets/d/abc123/edit#gid=0', 'https://drive.google.com/drive/folders/xyz?usp=sharing',
    'HTTPS://DOCS.GOOGLE.COM/spreadsheets/d/abc', '  https://docs.google.com/document/d/1  ']) {
    const r = hubCheckLink(ok, 'sheet');
    assert.equal(r.ok, true, ok); assert.ok(r.value.startsWith('https://'), ok);
  }
  for (const bad of ['http://docs.google.com/x', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'https://evil.example/docs.google.com',
    'https://docs.google.com.evil.example/x', 'https://docs.google.com@evil.example/x', 'https://user:pw@docs.google.com/x',
    'https://docs.google.com:8443/x', 'https://sheets.google.com/x', 'https://www.notion.so/page', 'docs.google.com/x', '//docs.google.com/x',
    'https://docs.google.com/a b', 'https://docs.google.com/\nx', 'ftp://drive.google.com/x',
    'https://xn--ocs-gla.google.com/x', 'x'.repeat(700)]) {
    const r = hubCheckLink(bad, 'sheet');
    assert.equal(r.ok, false, JSON.stringify(bad.slice(0, 50)));
    assert.match(r.error, /docs\.google\.com or drive\.google\.com/, 'a plain message that says what is allowed');
    assert.equal(r.value, '');
  }
});

test('guidelineUrl accepts https on the Notion hosts only', () => {
  for (const ok of ['https://www.notion.so/Guide-0123456789abcdef0123456789abcdef', 'https://notion.so/x', 'https://app.notion.com/p/abc',
    'https://notion.site/x', 'https://vively.notion.site/Guide-abc']) assert.equal(hubCheckLink(ok, 'guideline').ok, true, ok);
  for (const bad of ['http://www.notion.so/x', 'javascript:alert(1)', 'https://docs.google.com/x', 'https://notion.so.evil.example/x',
    'https://evilnotion.so/x', 'https://notion.site.evil.example/x', 'https://evil.example/?u=https://www.notion.so/x',
    'https://www.notion.so@evil.example/x', 'https://.notion.site/x', 'https://x.notion.so/x']) {
    const r = hubCheckLink(bad, 'guideline');
    assert.equal(r.ok, false, bad);
    assert.match(r.error, /notion\.so, notion\.site or app\.notion\.com/);
  }
});

test('a backslash is read like a slash, so the host is still docs.google.com and the stored value says so', () => {
  const r = hubCheckLink('https://docs.google.com\\@evil.example/', 'sheet');
  assert.equal(r.ok, true); assert.equal(new URL(r.value).hostname, 'docs.google.com');
});

test('an empty box is valid and means clear', () => {
  for (const v of ['', '   ', null, undefined]) assert.deepEqual(hubCheckLink(v, 'sheet'), { ok: true, value: '', error: '' });
});

test('a bad stored value never becomes an href: hubSafeLink re-checks on display (Sheet pull, hand-edited workspace)', () => {
  assert.equal(hubSafeLink({ sheetUrl: 'javascript:alert(1)' }, 'sheet'), '');
  assert.equal(hubSafeLink({ sheetUrl: 'https://evil.example/x' }, 'sheet'), '');
  assert.equal(hubSafeLink({ guidelineUrl: 'https://docs.google.com/x' }, 'guideline'), '');
  assert.equal(hubSafeLink({}, 'sheet'), '', 'a workspace written before the field existed: missing means empty');
  assert.equal(hubSafeLink({ sheetUrl: 'https://docs.google.com/spreadsheets/d/1' }, 'sheet'), 'https://docs.google.com/spreadsheets/d/1');
});

test('escaping: a hostile value that survives parsing is encoded and escaped in the page', () => {
  const sneaky = 'https://docs.google.com/"><svg/onload=alert(1)>';
  const r = hubCheckLink(sneaky, 'sheet');
  assert.ok(!/[<>"]/.test(r.value), 'the parser percent-encodes quotes and angle brackets: ' + r.value);
  const out = hubDocsHtml({ id: 'c1', sheetUrl: sneaky, guidelineUrl: 'https://www.notion.so/"><img src=x>' });
  assert.ok(!out.includes('<svg') && !out.includes('<img src=x'), 'no raw tag from a stored link');
  assert.ok(!out.includes('onload=alert(1)>'), 'no raw handler');
});

test('the two fields are in the Sheet mirror schema, so a pull does not drop them; old workspaces without them still load', () => {
  const keys = SHEET_SCHEMA.campaigns.map((c) => c[0]);
  assert.ok(keys.includes('sheetUrl') && keys.includes('guidelineUrl'));
  assert.equal(new Set(keys).size, keys.length, 'no duplicate column');
  assert.equal(hubNotionOrigin({}).key, 'none');
  assert.doesNotThrow(() => hubDocsHtml({ id: 'old', brand: 'Old', name: 'x' }));
});

/* ------------------------------------------------------------------ 2. Notion page link and origin */

test('the Notion page link is built from notionPageId only when it is a real id', () => {
  assert.equal(hubNotionPageUrl({ notionPageId: '01234567-89ab-cdef-0123-456789abcdef' }), 'https://www.notion.so/0123456789abcdef0123456789abcdef');
  assert.equal(hubNotionPageUrl({ notionPageId: '0123456789ABCDEF0123456789ABCDEF' }), 'https://www.notion.so/0123456789abcdef0123456789abcdef');
  for (const bad of [undefined, '', 'javascript:alert(1)', '../x', 'abc', '0123456789abcdef0123456789abcdef/../x', '<script>']) assert.equal(hubNotionPageUrl({ notionPageId: bad }), '', String(bad));
});

test('origin: auto-created, auto-linked, linked by hand, page only, none', () => {
  assert.equal(hubNotionOrigin({ source: 'notion-auto', notionPageId: 'x' }).key, 'auto');
  assert.equal(hubNotionOrigin({ notionAutoLinked: true, notionPageId: 'x' }).key, 'auto-linked');
  assert.equal(hubNotionOrigin({ notionDatabaseId: 'd' }).key, 'manual');
  assert.equal(hubNotionOrigin({ notionPageId: 'p' }).key, 'page');
  assert.equal(hubNotionOrigin({}).key, 'none');
  assert.match(hubNotionOrigin({ source: 'notion-auto' }).text, /automatically/);
  assert.match(hubNotionOrigin({ notionDatabaseId: 'd' }).text, /by hand/);
});

/* ------------------------------------------------------------------ 3. the Notion strip */

const CP = { id: 'cpA', brand: 'Fake', name: 'Spring', notionDatabaseId: 'db1', notionPageId: '01234567-89ab-cdef-0123-456789abcdef' };
const res = (status, body) => ({ status, body: body || {} });
const okApplicants = (extra) => res(200, Object.assign({ ok: true, enabled: true, dryRun: false, intervalMin: 15,
  pilot: { mode: 'all', ids: [], idsTruncated: false }, last: { at: '2026-11-20T09:12:00.000Z', campaigns: [
    { campaignId: 'cpA', status: 'ok', counts: { created: 3, held: 2, ambiguous: 1, differs: 4 } }, { campaignId: 'cpB', status: 'ok', counts: { created: 99 } }] },
  state: { held: [{ campaignId: 'cpA', pageId: 'PAGEID-SENTINEL-1', why: 'no-handle', since: 'x', tries: 1 },
    { campaignId: 'cpA', pageId: 'PAGEID-SENTINEL-2', why: 'unknown-status' }, { campaignId: 'cpA', pageId: 'PAGEID-SENTINEL-3', why: 'no-handle' },
    { campaignId: 'cpB', pageId: 'OTHER', why: 'no-handle' }] } }, extra));
const okAuto = res(200, { ok: true, enabled: true, dryRun: false });

test('strip: counts for THIS campaign only, plain reasons for held rows, one next sentence', () => {
  const m = hubNotionModel(CP, { applicants: okApplicants(), autocreate: okAuto });
  assert.equal(m.state, 'ok');
  assert.deepEqual(m.counts, { added: 3, waiting: 3, needsLook: 1, differs: 4 }, 'waiting comes from the held list filtered to this campaign');
  assert.deepEqual(m.held, [{ why: 'no Instagram link yet', n: 2 }, { why: 'status not recognised', n: 1 }]);
  assert.equal(m.last.kind, 'automatic check');
  assert.match(m.next, /3 waiting rows join the roster/);
  assert.match(m.next, /every 15 minutes/);
  const out = hubNotionBodyHtml(m);
  assert.match(out, /no Instagram link yet/); assert.match(out, /status not recognised/); assert.match(out, /What happens next/);
  assert.ok(!/no-handle|unknown-status|baseline-seen|held:|differs\b(?!<)/.test(out.replace(/different in Notion/g, '')), 'no internal code words');
});

test('strip: no personal data and no page ids reach the HTML, even if the server sent them', () => {
  const body = okApplicants();
  body.body.state.held[0].handle = '@SENTINEL_HANDLE'; body.body.state.held[0].email = 'SENTINEL_EMAIL@x.test'; body.body.state.held[0].name = 'SENTINEL NAME';
  body.body.last.campaigns[0].held = [{ pageId: 'PAGEID-SENTINEL-9', handle: '@SENTINEL_HANDLE' }];
  const out = hubNotionBodyHtml(hubNotionModel(CP, { applicants: body, autocreate: okAuto }));
  for (const s of ['SENTINEL', 'PAGEID', '@']) assert.ok(!out.includes(s), 'leaked ' + s);
});

test('strip: graceful failure in plain words', () => {
  const t = (applicants, state, text) => {
    const m = hubNotionModel(CP, { applicants, autocreate: okAuto });
    assert.equal(m.state, state); assert.match(m.message, text); assert.ok(m.next, 'always says what to do');
    assert.doesNotThrow(() => hubNotionBodyHtml(m));
    return m;
  };
  t(res(401), 'signin', /signed in as staff/);
  t(res(403), 'forbidden', /Staff only/);
  t(res(0, { error: 'Could not reach the server.' }), 'unreachable', /Could not reach the server/);
  t(res(500, { error: 'boom' }), 'unavailable', /not available right now/);
  t(res(200, { ok: true, enabled: false, reason: 'NOTION_TOKEN is not set' }), 'off', /switched off/);
  t(res(200, 'garbage'), 'unavailable', /not available/);
  const off = hubNotionBodyHtml(hubNotionModel(CP, { applicants: res(200, { ok: true, enabled: false, reason: 'NOTION_TOKEN is not set' }), autocreate: okAuto }));
  assert.ok(!off.includes('NOTION_TOKEN'), 'the server reason text is not echoed');
});

test('strip: not part of the pilot, not read, skipped, error, preview, no run yet', () => {
  const base = { ok: true, enabled: true, intervalMin: 10, last: { at: '2026-11-20T09:12:00.000Z', campaigns: [{ campaignId: 'cpZ', status: 'ok', counts: {} }] }, state: { held: [] } };
  const run = (extra, cp) => hubNotionModel(cp || CP, { applicants: res(200, Object.assign({}, base, extra)), autocreate: okAuto });
  assert.equal(run({ pilot: { mode: 'list', ids: ['cpZ'], idsTruncated: false } }).state, 'nopilot');
  assert.match(run({ pilot: { mode: 'none', ids: [] } }).message, /not part of the Notion sync pilot yet/);
  assert.equal(run({ pilot: { mode: 'list', ids: ['cpA'], idsTruncated: false } }).state, 'notread', 'in the list but not visited: not "pilot"');
  assert.equal(run({ pilot: { mode: 'list', ids: ['01234567-89ab-cdef-0123-456789abcdef'], idsTruncated: false } }).state, 'notread', 'matched by Notion page id');
  assert.equal(run({ pilot: { mode: 'list', ids: [], idsTruncated: true } }).state, 'notread', 'a cut-off list is not proof of "not in pilot"');
  assert.equal(run({ pilot: { mode: 'all' }, last: null, state: { held: [] } }).state, 'norun');
  const sk = run({ pilot: { mode: 'all' }, last: { at: '2026-11-20T09:12:00.000Z', campaigns: [{ campaignId: 'cpA', status: 'skipped', why: 'shared-source' }] } });
  assert.equal(sk.state, 'skipped'); assert.match(sk.message, /another campaign uses the same Notion form/);
  const er = run({ pilot: { mode: 'all' }, last: { at: '2026-11-20T09:12:00.000Z', campaigns: [{ campaignId: 'cpA', status: 'error', why: 'mapping-failed:x' }] } });
  assert.equal(er.state, 'error'); assert.ok(!er.message.includes('mapping-failed'));
  const dry = run({ dryRun: true, pilot: { mode: 'all' }, last: { at: '2026-11-20T09:12:00.000Z', campaigns: [{ campaignId: 'cpA', status: 'dry-run', counts: { created: 2 } }] } });
  assert.match(dry.message, /Preview only/); assert.match(dry.next, /preview mode/);
});

test('strip: unlinked campaigns make no claim and need no fetch; loading is its own state', () => {
  const m = hubNotionModel({ id: 'c9' }, null);
  assert.equal(m.state, 'unlinked'); assert.match(m.message, /Not linked to Notion/);
  assert.equal(hubNotionModel(CP, null).state, 'loading');
});

test('strip: last time is the later of the automatic check and the manual sync, and says which', () => {
  const m1 = hubNotionModel(Object.assign({}, CP, { notionSyncedAt: '2026-11-22T10:00:00.000Z' }), { applicants: okApplicants(), autocreate: okAuto });
  assert.equal(m1.last.kind, 'manual sync');
  const m2 = hubNotionModel(Object.assign({}, CP, { notionSyncedAt: '2026-11-01T10:00:00.000Z' }), { applicants: okApplicants(), autocreate: okAuto });
  assert.equal(m2.last.kind, 'automatic check');
  assert.equal(hubNotionModel(Object.assign({}, CP, { notionSyncedAt: 'not a date' }), null).last, null);
});

test('strip: auto-create line only for campaigns that came through it', () => {
  const auto = Object.assign({}, CP, { source: 'notion-auto' });
  assert.match(hubNotionModel(auto, { applicants: okApplicants(), autocreate: okAuto }).autocreate, /Auto-create is on/);
  assert.match(hubNotionModel(auto, { applicants: okApplicants(), autocreate: res(401) }).autocreate, /not available/);
  assert.equal(hubNotionModel(CP, { applicants: okApplicants(), autocreate: okAuto }).autocreate, '');
});

/* ------------------------------------------------------------------ 4. one fetch, cached ~30 s */

test('the two status endpoints are asked once per 30 seconds, GET only, and only those two', async () => {
  const calls = [];
  globalThis.fetch = async (path, opts) => { calls.push([path, (opts && opts.method) || 'GET']); return { status: 200, json: async () => ({ ok: true, enabled: false }) }; };
  HUB.data = null; HUB.at = 0; HUB.promise = null;
  const [a, b] = await Promise.all([hubLoadNotion(), hubLoadNotion()]);
  assert.equal(a, b);
  await hubLoadNotion();
  assert.deepEqual(calls.map((c) => c.join(' ')).sort(), ['/api/notion-applicants/status GET', '/api/notion/autocreate/status GET']);
  assert.ok(hubCachedNotion(HUB.at + 29000), 'still fresh at 29 s');
  assert.equal(hubCachedNotion(HUB.at + 31000), null, 'stale after 30 s');
  await hubLoadNotion(true);
  assert.equal(calls.length, 4, 'Check again forces a new pair of calls');
});

test('a network failure comes back as a state, never a throw', async () => {
  globalThis.fetch = async () => { throw new Error('offline'); };
  HUB.data = null; HUB.at = 0; HUB.promise = null;
  const data = await hubLoadNotion();
  assert.equal(hubNotionModel(CP, data).state, 'unreachable');
});

/* ------------------------------------------------------------------ 5. the Overview tab on a stand-in page */

function fakePage() {
  const els = {}; const handlers = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '', value: '', dataset: {}, hidden: false, focus() { els.__focused = id; },
    addEventListener(t, fn) { handlers[id + ':' + t] = fn; }, classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    setAttribute() {}, getAttribute() { return null; } });
  globalThis.document.querySelector = (sel) => (sel.startsWith('#') ? el(sel.slice(1)) : null);
  return { els, el, handlers };
}

test('Overview: renders header, Notion strip and Documents; fetches only for a linked campaign; save validates', async () => {
  const pg = fakePage();
  const calls = [];
  globalThis.fetch = async (path) => { calls.push(path); return { status: 200, json: async () => ({ ok: true, enabled: false }) }; };
  DB.campaigns.length = 0; Object.keys(byCampaign).forEach((k) => delete byCampaign[k]);
  const cp = { id: 'cpA', brand: 'Fake & <Brand>', name: 'Spring', kind: 'Seeding', market: 'Korea', status: 'live', start: '2026-10-03', end: '2026-11-07',
    targetCreators: 30, owner: 'K', deliverables: '1 Reel', notionPageId: '01234567-89ab-cdef-0123-456789abcdef', notionDatabaseId: 'db1', source: 'notion-auto' };
  DB.campaigns.push(cp); byCampaign.cpA = cp; DB.participants.length = 0;
  HUB.data = null; HUB.at = 0; HUB.promise = null;
  const mount = pg.el('mount');
  pg.el('hubNotionBody').dataset.cid = 'cpA'; /* the real page gets this from the markup */
  overviewTab(mount, cp);
  assert.match(mount.innerHTML, /Fake &amp; &lt;Brand&gt;/, 'brand is escaped');
  assert.ok(!mount.innerHTML.includes('<Brand>'));
  for (const w of ['Notion', 'Documents', 'Brand sheet (Google Drive)', 'Campaign guideline (Notion)', 'Notion campaign page', 'Brand sheet (.xlsx)', 'Contract documents', 'Brand view link', 'Created automatically']) assert.ok(mount.innerHTML.includes(w), w);
  assert.match(mount.innerHTML, /No Drive sheet yet/); assert.match(mount.innerHTML, /href="https:\/\/www\.notion\.so\/0123456789abcdef0123456789abcdef"/);
  assert.match(mount.innerHTML, /href="#\/contracts\/msa"/);
  assert.match(mount.innerHTML, /Status is loaded when you open the Partners page/, 'brand link pointer when the Setup card has not loaded');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 2, 'one pair of requests when the campaign opens');
  assert.match(pg.el('hubNotionBody').innerHTML, /switched off/);
  overviewTab(mount, cp);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 2, 'reopening within 30 s asks nothing');
  assert.match(pg.el('hubNotionBody').innerHTML, /switched off/, 'and paints from the cache at once');

  /* save: a bad link is refused with a plain message and nothing is stored */
  pg.el('hubSheetUrl').value = 'http://evil.example/x';
  pg.handlers['hubSheetSave:click']();
  assert.match(pg.el('hubSheetErr').textContent, /docs\.google\.com or drive\.google\.com/);
  assert.equal(cp.sheetUrl, undefined);
  assert.equal(pg.els.__focused, 'hubSheetUrl', 'focus goes back to the field');
  pg.el('hubGuideUrl').value = 'https://docs.google.com/x';
  pg.handlers['hubGuideSave:click']();
  assert.match(pg.el('hubGuideErr').textContent, /notion\.so/);
  assert.equal(cp.guidelineUrl, undefined);

  /* an unlinked campaign makes no request at all */
  calls.length = 0; HUB.data = null; HUB.at = 0;
  const plain = { id: 'cpP', brand: 'Plain', name: 'p', kind: 'Seeding', market: 'Korea', status: 'planning', start: '2026-10-03', end: '2026-11-07', targetCreators: 5, owner: 'K', deliverables: '' };
  overviewTab(pg.el('mount2'), plain);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 0);
  assert.match(pg.el('mount2').innerHTML, /Not linked to Notion yet/);
  assert.match(pg.el('mount2').innerHTML, /No Notion page linked yet/);
});

test('Overview is the first tab group and the default for a campaign with no tab in the address', () => {
  assert.equal(CAMPAIGN_GROUPS[0][0], 'overview');
  assert.deepEqual(CAMPAIGN_GROUPS.map((g) => g[0]).slice(0, 3), ['overview', 'planner', 'roster']);
  assert.match(html, /return renderCampaign\(view, item, tab \|\| 'overview'\);/);
  assert.ok(html.includes("overview: overviewTab, planner: plannerTab"), 'the tab is wired');
  assert.match(html, /['"]roster['"], 'Creators', \['roster'\]/, 'the roster is still one click away');
});

/* ------------------------------------------------------------------ 6. keyboard, dialog, toast */

test('drawerTrapTarget: Tab wraps at the end, Shift+Tab wraps at the start, the middle is left alone', () => {
  const a = { n: 'a' }, b = { n: 'b' }, c = { n: 'c' }, out = { n: 'out' };
  assert.equal(drawerTrapTarget([a, b, c], c, false), a);
  assert.equal(drawerTrapTarget([a, b, c], a, true), c);
  assert.equal(drawerTrapTarget([a, b, c], b, false), null);
  assert.equal(drawerTrapTarget([a, b, c], b, true), null);
  assert.equal(drawerTrapTarget([a, b, c], out, false), a, 'focus that has escaped is pulled back in');
  assert.equal(drawerTrapTarget([a, b, c], out, true), c);
  assert.equal(drawerTrapTarget([], a, false), null);
  assert.equal(drawerTrapTarget([a], a, false), a); assert.equal(drawerTrapTarget([a], a, true), a);
});

function fakeDrawerPage() {
  const mk = (extra) => Object.assign({ innerHTML: '', scrollTop: 0, _cls: new Set(), _l: {}, _attr: {},
    classList: null, focus() { globalThis.document.activeElement = this; }, isConnected: true,
    addEventListener(t, f) { this._l[t] = f; }, setAttribute(k, v) { this._attr[k] = v; }, querySelectorAll() { return this._items || []; } }, extra);
  const els = { '#drawer': mk(), '#scrim': mk(), '#drawerTitle': mk(), '#drawerBody': mk(), '#toast': mk({ textContent: '' }) };
  Object.values(els).forEach((e) => { e.classList = { add: (c) => e._cls.add(c), remove: (c) => e._cls.delete(c), contains: (c) => e._cls.has(c), toggle: (c, on) => (on ? e._cls.add(c) : e._cls.delete(c)) }; });
  globalThis.document.querySelector = (s) => els[s] || null;
  globalThis.requestAnimationFrame = (fn) => fn();
  globalThis.document.activeElement = document.body || {};
  return els;
}

test('drawer: focus moves to the title, Tab is trapped, closing gives focus back to what opened it', () => {
  const els = fakeDrawerPage();
  const opener = { focus() { globalThis.document.activeElement = this; }, isConnected: true };
  globalThis.document.activeElement = opener;
  openDrawer('Edit', '<p>x</p>', false);
  assert.ok(els['#drawer']._cls.has('open'));
  assert.equal(globalThis.document.activeElement, els['#drawerTitle'], 'focus is inside the dialog');
  assert.equal(typeof els['#drawer']._l.keydown, 'function', 'a Tab handler is attached once');
  const item = () => ({ hidden: false, getAttribute() { return null; }, focus() { globalThis.document.activeElement = this; } });
  const first = item(), last = item();
  els['#drawer']._items = [first, last];
  globalThis.document.activeElement = last;
  let prevented = false;
  els['#drawer']._l.keydown({ key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(globalThis.document.activeElement, first, 'Tab from the last control wraps to the first');
  globalThis.document.activeElement = els['#drawerTitle'];
  closeDrawer();
  assert.ok(!els['#drawer']._cls.has('open'));
  assert.equal(globalThis.document.activeElement, opener, 'focus restored');
  closeDrawer(); /* a second close (Escape on a closed drawer) must not throw or steal focus */
  assert.equal(globalThis.document.activeElement, opener);
});

test('drawer: a second open while open keeps the ORIGINAL opener', () => {
  const els = fakeDrawerPage();
  const opener = { focus() { globalThis.document.activeElement = this; }, isConnected: true };
  globalThis.document.activeElement = opener;
  openDrawer('One', 'a'); openDrawer('Two', 'b');
  closeDrawer();
  assert.equal(globalThis.document.activeElement, opener);
  void els;
});

test('toast: polite for normal messages, assertive and longer for failures', () => {
  const els = fakeDrawerPage();
  toast('Saved'); assert.equal(els['#toast']._attr['aria-live'], 'polite');
  toast('NOT SAVED - server said no'); assert.equal(els['#toast']._attr['aria-live'], 'assertive');
  toast('Push failed - offline'); assert.equal(els['#toast']._attr['aria-live'], 'assertive');
  toast('Link saved'); assert.equal(els['#toast']._attr['aria-live'], 'polite');
});

test('markup: drawer is a labelled modal dialog with a named close button; toast is a live region', () => {
  assert.match(html, /<aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-labelledby="drawerTitle">/);
  assert.match(html, /id="drawerTitle" tabindex="-1"/);
  assert.match(html, /id="drawerClose" aria-label="Close panel"/);
  assert.match(html, /<div class="toast" id="toast" role="status" aria-live="polite"/);
  assert.ok(!/Sign up dulu/.test(html), 'the Indonesian sign-in line is gone');
  assert.match(html, /<p class="auth-sub">Sign in to continue\.<\/p>/);
  assert.ok(!/transition:\s*all/.test(html), 'no transition: all anywhere');
  assert.match(html, /^:focus-visible \{ outline: 2px solid var\(--blue-hi\)/m);
  assert.match(html, /\.icon-btn::after \{ content: ''; position: absolute; inset: -4px; \}/, '32px circle, 40px hit area');
  assert.match(html, /aria-label="Campaign stage"/);
  assert.match(html, /id="cpDelete"[^>]*aria-label="Delete this campaign"/);
});

test('campaign cards are real links (keyboard reachable) with an accessible name, not a clickable div', () => {
  assert.match(html, /<div class="card card-linked">/);
  assert.match(html, /<a class="card-link" href="#\/campaigns\/\$\{esc\(cp\.id\)\}\/overview">/);
  assert.ok(!/<div class="card" style="cursor:pointer" onclick="location\.hash='#\/campaigns\/\$\{cp\.id\}\/roster'">/.test(html));
  assert.match(html, /\.card-link::after \{ content: ''; position: absolute; inset: 0;/, 'the whole card is the click target');
});

/* ------------------------------------------------------------------ 7. contrast */

const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
test('--text-3 is at least 4.5:1 on every surface, in both themes (computed from the tokens in index.html)', () => {
  const root = html.slice(html.indexOf(':root {'), html.indexOf(':root[data-theme="light"] {'));
  const light = html.slice(html.indexOf(':root[data-theme="light"] {'), html.indexOf('}', html.indexOf(':root[data-theme="light"] {')));
  const tok = (css, n) => (css.match(new RegExp('--' + n + ':\\s+(#[0-9a-fA-F]{6})')) || [])[1];
  for (const [css, label] of [[root, 'dark'], [light, 'light']]) {
    const fg = tok(css, 'text-3');
    assert.ok(fg, label + ' token found');
    for (const s of ['bg', 'surface', 'surface-2', 'surface-3']) {
      const bg = tok(css, s); assert.ok(bg, label + ' ' + s);
      assert.ok(ratio(fg, bg) >= 4.5, `${label} --text-3 ${fg} on ${bg} is ${ratio(fg, bg).toFixed(2)}`);
    }
  }
});

/* ------------------------------------------------------------------ 8. privacy: the links never reach a partner or a brand */

const SENT = { sheet: 'https://docs.google.com/spreadsheets/d/SENTINEL_SHEET_9f3a', guide: 'https://www.notion.so/SENTINEL_GUIDE_71bc',
  page: '0123456789abcdef0123456789abcdef', pageDashed: '01234567-89ab-cdef-0123-456789abcdef', db: 'SENTINEL_DB_55aa' };
const SENT_VALUES = ['SENTINEL_SHEET_9f3a', 'SENTINEL_GUIDE_71bc', SENT.page, SENT.pageDashed, 'SENTINEL_DB_55aa', 'docs.google.com', 'notion.so'];

function leakDb() {
  const link = { sheetUrl: SENT.sheet, guidelineUrl: SENT.guide, notionPageId: SENT.pageDashed, notionAutoLinked: true, source: 'notion-auto', notionDatabaseId: SENT.db };
  return {
    campaigns: [
      Object.assign({ id: 'cmp_a', brand: 'Visible', name: 'Spring', partner: 'SPLABAB', status: 'live', start: '2026-10-01', end: '2026-11-01', targetCreators: 10, note: 'internal note' }, link),
      Object.assign({ id: 'cmp_b', brand: 'Other', name: 'Other', partner: 'OTHERCO', status: 'live', start: '2026-10-01', end: '2026-11-01' }, link)
    ],
    creators: [{ id: 'c1', handle: '@one', name: 'One', email: 'one@x.test', followers: 100 }],
    participants: [{ id: 'p1', campaignId: 'cmp_a', creatorId: 'c1', stage: 'confirmed', visitAt: '2026-10-20 14:00', note: 'n' }]
  };
}

const serverSrc = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const ctx = vm.createContext({ Object, String, Set, RegExp, Math, console, crypto, Buffer, Map, Number });
vm.runInContext(serverSrc.slice(serverSrc.indexOf('const PARTNER_STATUS = {'), serverSrc.indexOf('async function partnerCommentsCollection')) +
  '\nthis.api = { buildPartnerRows, partnerStatusOf, partnerVisitSlot, partnerContentUrl, partnerSafeUrl, PARTNER_ROW_FIELDS, PARTNER_CAMPAIGN_FIELDS };', ctx);
const real = ctx.api;
const CV = require('../server/client-views.js');

test('LEAK: the partner payload contains none of the link fields or their values', () => {
  const out = real.buildPartnerRows(leakDb(), 'SPLABAB');
  assert.equal(out.campaigns.length, 1, 'the campaign is in the payload, so the test is not vacuous');
  const json = JSON.stringify(out);
  for (const v of SENT_VALUES) assert.ok(!json.includes(v), 'partner payload leaked ' + v);
  for (const k of ['sheetUrl', 'guidelineUrl', 'notionPageId', 'notionAutoLinked', 'notionDatabaseId']) assert.ok(!json.includes(k), 'partner payload carries key ' + k);
  assert.deepEqual([...real.PARTNER_CAMPAIGN_FIELDS].sort(), ['brand', 'end', 'id', 'name', 'start'], 'the partner campaign field list is unchanged');
});

test('LEAK: the brand (client) projection contains none of the link fields or their values', () => {
  const helpers = { statusOf: real.partnerStatusOf, visitSlot: real.partnerVisitSlot, contentUrl: real.partnerContentUrl, safeUrl: real.partnerSafeUrl };
  const view = CV.buildClientView(leakDb(), 'cmp_a', helpers);
  assert.ok(view && view.campaign.name === 'Spring', 'a real view was built');
  const json = JSON.stringify(view);
  for (const v of SENT_VALUES) assert.ok(!json.includes(v), 'brand view leaked ' + v);
  for (const k of ['sheetUrl', 'guidelineUrl', 'notionPageId', 'notionAutoLinked', 'notionDatabaseId']) assert.ok(!json.includes(k), 'brand view carries key ' + k);
  assert.deepEqual([...CV.CLIENT_CAMPAIGN_FIELDS], ['name', 'start', 'end', 'status', 'headcount'], 'the brand campaign field list is unchanged');
  for (const list of [CV.CLIENT_CAMPAIGN_FIELDS, CV.CLIENT_TOP_FIELDS, CV.CLIENT_ROW_FIELDS, CV.CLIENT_COUNT_FIELDS, real.PARTNER_ROW_FIELDS, real.PARTNER_CAMPAIGN_FIELDS])
    for (const k of ['sheetUrl', 'guidelineUrl', 'notionPageId']) assert.ok(!list.includes(k), k + ' is on an allow-list');
});

test('LEAK: the Report hand-off file (sent to a brand or partner) leaves the staff-only links behind', () => {
  const cp = leakDb().campaigns[0];
  const out = handoffCampaign(cp);
  const json = JSON.stringify(out);
  for (const v of ['SENTINEL_SHEET_9f3a', 'SENTINEL_GUIDE_71bc', SENT.pageDashed]) assert.ok(!json.includes(v), 'hand-off leaked ' + v);
  assert.equal(out.sheetUrl, undefined); assert.equal(out.guidelineUrl, undefined); assert.equal(out.notionPageId, undefined);
  assert.equal(out.brand, 'Visible', 'the rest of the campaign still goes');
  assert.ok('sheetUrl' in cp, 'the original is not changed');
  assert.match(html, /campaign: handoffCampaign\(cp\), stats: s,/, 'the download actually uses it');
});

test('LEAK: the brand-safe .xlsx contains none of the link values', async () => {
  const { buildBrandSheet } = await import('../src/model/brandSheet.js');
  const { buildXlsx, unzip } = await import('../src/lib/xlsx.js');
  const cp = leakDb().campaigns[0];
  const out = buildBrandSheet({ cp, participants: leakDb().participants, creators: { c1: { id: 'c1', handle: '@one', name: 'One' } }, mode: 'brand', date: '2026-11-24' });
  const blob = JSON.stringify(out);
  for (const v of ['SENTINEL_SHEET_9f3a', 'SENTINEL_GUIDE_71bc', SENT.pageDashed, 'SENTINEL_DB_55aa']) assert.ok(!blob.includes(v), 'brand sheet leaked ' + v);
  void buildXlsx; void unzip;
});

test('LEAK: no server route or brand/partner page reads the two fields', () => {
  for (const f of ['server.js', 'server/client-views.js', 'partner.html', 'client.html', 'book.html', 'server/booking-routes.js', 'server/booking-store.js']) {
    const text = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.ok(!/sheetUrl|guidelineUrl/.test(text), f + ' mentions a staff-only link field');
  }
});

test('workspace guard and server save path are untouched: they look at collection counts, not campaign fields', () => {
  const guard = require('../server/workspace-guard.js');
  const withLinks = { campaigns: leakDb().campaigns, creators: [], participants: [] };
  assert.equal(guard.guardEmptyReplace({ incoming: withLinks, existing: leakDb() }).ok, true);
  assert.equal(guard.guardEmptyReplace({ incoming: { campaigns: [], creators: [], participants: [] }, existing: leakDb() }).ok, false, 'the guard still refuses an empty replace');
});

test('routes: renderCampaignSection exists and lands on overview by default', () => {
  assert.equal(typeof renderCampaignSection, 'function');
  assert.equal(HUB_LINKS.sheet.field, 'sheetUrl'); assert.equal(HUB_LINKS.guideline.field, 'guidelineUrl');
});

test('Documents: brand link status comes from the Setup card data when it is loaded, never shows a URL or token', async () => {
  const { CLK } = await import('../src/views/partners.js');
  const cp = { id: 'cpA', brand: 'B', name: 'n' };
  const before = Object.assign({}, CLK);
  try {
    CLK.loaded = true;
    CLK.links = [{ id: 'lnk_1', campaignId: 'cpA', status: 'active', expiresAt: '2027-02-22T10:00:00Z', lastOpenedAt: null, viewBuiltAt: '2026-11-24T10:00:00Z', stale: true, token: 'SENTINEL-TOKEN-ZZ', url: 'https://x.test/c/SENTINEL-TOKEN-ZZ' }];
    let out = hubDocsHtml(cp);
    assert.match(out, /Active/); assert.match(out, /behind your last save/); assert.match(out, /Never opened/);
    assert.ok(!out.includes('SENTINEL-TOKEN-ZZ'), 'no token or link in the hub');
    CLK.links = [];
    out = hubDocsHtml(cp);
    assert.match(out, /No link/);
    CLK.loaded = false;
    assert.match(hubDocsHtml(cp), /Status is loaded when you open the Partners page in Setup/);
    assert.match(hubDocsHtml(cp), /href="#\/settings\/partners"/);
  } finally { Object.assign(CLK, before); }
});
