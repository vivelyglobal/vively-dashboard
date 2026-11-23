/* The staff panel for the Notion auto-create job (Setup -> Notion).
   Runs the real src/views/autocreatePanel.js against a stub fetch, a stub
   confirm and a fake page, so it checks request shapes, the escaping of
   Notion page titles, the Run now gate and the confirm sentence. It does
   not check how the panel looks (visuals unverified). */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const els = {};
const mkEl = () => ({ innerHTML: '', textContent: '', className: '' });
globalThis.document = { querySelector: (s) => els[s] || null, querySelectorAll: () => [] };
let calls = [];
let script = [];
let confirmAnswer = true;
let confirmSeen = [];
globalThis.fetch = async (path, opts) => {
  calls.push({ path, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : undefined });
  const next = script.shift() || { status: 200, json: { ok: true } };
  return { status: next.status, json: async () => next.json };
};
globalThis.confirm = (s) => { confirmSeen.push(s); return confirmAnswer; };

const P = await import('../src/views/autocreatePanel.js');
assert.equal(calls.length, 0, 'importing the panel makes no request');

const HOSTILE = '<img src=x onerror=alert(1)>" onmouseover="alert(2)';
const reset = () => {
  calls = []; script = []; confirmSeen = []; confirmAnswer = true;
  els['#nacBody'] = mkEl(); els['#nacPill'] = mkEl();
  Object.assign(P.NAC, { status: null, statusAt: 0, run: null, runKind: '', msg: null, busy: '' });
};
const live = { ok: true, enabled: true, dryRun: false, state: { dismissed: [], createdTodayCount: 1, maxCreatePerDay: 5, baselineAt: '2026-11-20T00:00:00.000Z' }, last: null };
const runOk = (run) => ({ status: 200, json: { ok: true, run } });

test('mode: Off, Dry run, Live come from the status answer', () => {
  assert.equal(P.nacMode(null).label, 'Off');
  assert.equal(P.nacMode({ enabled: false }).label, 'Off');
  
  assert.equal(P.nacMode({ enabled: true, dryRun: false }).label, 'Live');
});

test('run body always carries an explicit dryRun true or false', () => {
  assert.deepEqual(P.nacRunBody(true), { dryRun: true });
  assert.deepEqual(P.nacRunBody(false), { dryRun: false });
  assert.deepEqual(P.nacRunBody(undefined), { dryRun: false });
});

test('problems: 401 and 503 get plain founder wording, not a stack of codes', () => {
  assert.match(P.nacProblem({ status: 401, body: {} }).text, /Sign in as staff/);
  assert.match(P.nacProblem({ status: 503, body: { reason: 'NOTION_TOKEN is not set' } }).text, /switched off/);
  assert.match(P.nacProblem({ status: 503, body: { reason: 'NOTION_TOKEN is not set' } }).text, /NOTION_TOKEN is not set/);
  assert.match(P.nacProblem({ status: 403, body: {} }).text, /Staff only/);
});

test('escaping: a hostile page title never becomes markup in the preview, the skipped list or the pill area', () => {
  reset();
  const run = {
    dryRun: true, baseline: null,
    created: [{ pageId: 'a', title: HOSTILE }], linked: [{ pageId: 'b', title: HOSTILE, by: 'exact' }],
    seen: [{ pageId: 'c', title: HOSTILE, why: 'baseline-seen' }],
    skipped: [{ pageId: 'd', title: HOSTILE, why: 'template-or-test' }],
    ambiguous: [{ pageId: 'e', title: HOSTILE }], deferred: [{ pageId: 'f', title: HOSTILE, why: 'day-cap' }],
    dismissed: [{ pageId: 'g1', title: HOSTILE, why: 'dismissed' }], errors: [HOSTILE]
  };
  P.NAC.status = Object.assign({}, live, { state: Object.assign({}, live.state, { dismissed: ['"><b>x</b>'] }) });
  P.NAC.run = run;
  const html = P.nacBodyHtml();
  assert.ok(!/<img/i.test(html), 'no tag from a title survives');
  assert.ok(!/<b>x/.test(html), 'a hostile page id is escaped too');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot; onmouseover=&quot;alert(2)'));
  assert.ok(!/data-pageid="[^"]*"[^>]*onmouseover/i.test(html));
  /* positive checks: the rows really are there, so the negatives above are not passing on an empty page */
  assert.ok(html.includes('Would create (1)'), 'the preview section is present');
  assert.ok(html.includes('<li><strong>&lt;img src=x onerror=alert(1)&gt;'), 'the escaped title row exists');
  assert.ok(html.includes('data-pageid="&quot;&gt;&lt;b&gt;x&lt;/b&gt;"'), 'the dismissed row has its Undo button with the escaped page id');
  assert.equal((html.match(/data-pageid="/g) || []).length, 2, 'two Undo buttons: the status id and the run dismissed page');
});

test('preview wording: dry run says "Would create", a live result says "Created"', () => {
  const r = { created: [{ pageId: 'a', title: 'Aura Seoul' }], linked: [], seen: [], skipped: [], ambiguous: [], deferred: [], dismissed: [], errors: [] };
  assert.match(P.nacRunHtml(Object.assign({ dryRun: true }, r)), /Would create \(1\)/);
  assert.match(P.nacRunHtml(Object.assign({ dryRun: true }, r)), /nothing was changed/);
  assert.match(P.nacRunHtml(Object.assign({ dryRun: false }, r)), /Created \(1\)/);
  assert.match(P.nacRunHtml({ dryRun: true, created: [], linked: [], seen: [], skipped: [], ambiguous: [], deferred: [], dismissed: [], errors: [] }), /Nothing new/);
});

test('counts: the six numbers read from last.counts, missing ones are 0', () => {
  assert.deepEqual(P.nacCounts({ counts: { created: 2, linked: 1, seen: 30, skipped: 3, ambiguous: 1, errors: 0 } }),
    { created: 2, linked: 1, seen: 30, skipped: 3, ambiguous: 1, errors: 0 });
  assert.deepEqual(P.nacCounts(null), { created: 0, linked: 0, seen: 0, skipped: 0, ambiguous: 0, errors: 0 });
});

test('confirm sentence states how many will be created; baseline and empty cases', () => {
  const two = { created: [{ title: 'A' }, { title: 'B' }] };
  assert.match(P.nacConfirmText(two), /Create 2 campaigns/);
  assert.match(P.nacConfirmText({ created: [{ title: 'A' }] }), /Create 1 campaign in/);
  assert.equal(P.nacConfirmText({ created: [] }), '');
  const base = P.nacConfirmText({ baseline: { wouldRecord: true, pages: 35 }, created: [] });
  assert.match(base, /first live run/);
  assert.match(base, /create 0 campaigns/);
});

test('Run now is disabled unless the server status says Live', () => {
  reset();
  P.NAC.status = Object.assign({}, live, { dryRun: true });
  assert.match(P.nacBodyHtml(), /data-nac="run" disabled/);
  P.NAC.status = Object.assign({}, live, { enabled: false, reason: 'NOTION_TOKEN is not set' });
  assert.match(P.nacBodyHtml(), /data-nac="run" disabled/);
  assert.match(P.nacBodyHtml(), /data-nac="preview" disabled/);
  P.NAC.status = live;
  assert.ok(!/data-nac="run" disabled/.test(P.nacBodyHtml()));
});

test('Preview sends one POST /run with dryRun:true and then reads status (GET only)', async () => {
  reset();
  P.NAC.status = live;
  script = [runOk({ dryRun: true, created: [], linked: [], seen: [], skipped: [], ambiguous: [], deferred: [], dismissed: [], errors: [] }), { status: 200, json: live }];
  await P.nacAction('preview');
  assert.deepEqual(calls.map((c) => c.method + ' ' + c.path),
    ['POST /api/notion/autocreate/run', 'GET /api/notion/autocreate/status']);
  assert.deepEqual(calls[0].body, { dryRun: true });
  assert.equal(calls[1].body, undefined);
  assert.equal(P.NAC.busy, '');
});

test('Run now: asks for a dry run first, confirms with the count, then runs live with dryRun:false', async () => {
  reset();
  P.NAC.status = live;
  const plan = { dryRun: true, created: [{ pageId: 'a', title: 'A' }, { pageId: 'b', title: 'B' }], linked: [], seen: [], skipped: [], ambiguous: [], deferred: [], dismissed: [], errors: [] };
  script = [runOk(plan), runOk(Object.assign({}, plan, { dryRun: false })), { status: 200, json: live }];
  await P.nacAction('run');
  assert.equal(confirmSeen.length, 1);
  assert.match(confirmSeen[0], /Create 2 campaigns/);
  assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.body), [{ dryRun: true }, { dryRun: false }]);
  assert.match(P.NAC.msg.text, /2 campaigns created/);
});

test('Run now: if the number created differs from the confirmed number, a plain warning shows', async () => {
  reset();
  P.NAC.status = live;
  const row = (id) => ({ pageId: id, title: id });
  const base = { linked: [], seen: [], skipped: [], ambiguous: [], deferred: [], dismissed: [], errors: [] };
  script = [runOk(Object.assign({ dryRun: true, created: [row('a'), row('b'), row('c')] }, base)), runOk(Object.assign({ dryRun: false, created: [row('a')] }, base)), { status: 200, json: live }];
  await P.nacAction('run');
  assert.match(confirmSeen[0], /Create 3 campaigns/);
  assert.equal(P.NAC.msg.text.startsWith('Expected 3, created 1.'), true);
  assert.equal(P.NAC.msg.tone, 'warn');
  assert.ok(!/campaigns? created. Reload/.test(P.NAC.msg.text), 'not the plain success text');
  assert.match(P.nacBodyHtml(), /class="note warn"[^>]*>Expected 3, created 1./);
});

test('Run now: saying no at the confirm makes no live call', async () => {
  reset();
  P.NAC.status = live; confirmAnswer = false;
  script = [runOk({ dryRun: true, created: [{ pageId: 'a', title: 'A' }], linked: [], seen: [], skipped: [], ambiguous: [], deferred: [], dismissed: [], errors: [] }), { status: 200, json: live }];
  await P.nacAction('run');
  assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.body), [{ dryRun: true }]);
  assert.match(P.NAC.msg.text, /Nothing was changed/);
});

test('Run now: nothing to create means no confirm and no live call', async () => {
  reset();
  P.NAC.status = live;
  script = [runOk({ dryRun: true, created: [], linked: [], seen: [], skipped: [], ambiguous: [], deferred: [], dismissed: [], errors: [] }), { status: 200, json: live }];
  await P.nacAction('run');
  assert.equal(confirmSeen.length, 0);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
});

test('feature off (503) and signed out (401) show a clear message, and a failed preview keeps it', async () => {
  reset();
  P.NAC.status = live;
  script = [{ status: 503, json: { error: 'x', reason: 'NOTION_AUTOCREATE_PARENT_ID is not set' } }, { status: 200, json: live }];
  await P.nacAction('preview');
  assert.match(P.NAC.msg.text, /switched off/);
  reset();
  script = [{ status: 401, json: { error: 'Sign in to continue.' } }];
  await P.nacLoadStatus();
  assert.match(P.NAC.msg.text, /Sign in as staff/);
  assert.equal(P.NAC.status, null);
});

test('Undo posts the page id to /undismiss', async () => {
  reset();
  P.NAC.status = live;
  script = [{ status: 200, json: { ok: true } }, { status: 200, json: live }];
  await P.nacAction('undo', '0123abcd');
  assert.equal(calls[0].path, '/api/notion/autocreate/undismiss');
  assert.deepEqual(calls[0].body, { pageId: '0123abcd' });
});

test('wiring the card does not fire a live call; only the read-only status', () => {
  reset();
  els['#nacCard'] = { addEventListener() {} };
  P.wireNacCard();
  assert.deepEqual(calls.map((c) => c.method + ' ' + c.path), ['GET /api/notion/autocreate/status']);
});
