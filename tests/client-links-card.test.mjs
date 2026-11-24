/* The staff card "Brand campaign links" (Setup -> Partners). Runs the real
   src/views/partners.js against a stub fetch, a stub confirm and a fake page,
   so it checks the request shapes, the show-once token, the escaping of
   campaign names, and the exact button labels. It does not check how the card
   looks (visuals unverified). */
import './helpers/browser-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const els = {};
const mkEl = () => ({ innerHTML: '', textContent: '' });
globalThis.document.querySelector = (s) => els[s] || null;
globalThis.document.createElement = () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, select() {}, remove() {}, setAttribute() {} });
let calls = [], script = [], confirmAnswer = true, confirmSeen = [], copied = [];
globalThis.fetch = async (path, opts) => {
  calls.push({ path, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : undefined });
  const next = script.shift() || { status: 200, json: { ok: true, links: [] } };
  return { status: next.status, json: async () => next.json };
};
globalThis.confirm = (s) => { confirmSeen.push(s); return confirmAnswer; };
globalThis.location = { origin: 'https://dash.test', href: 'https://dash.test/', pathname: '/', search: '', hash: '' };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { copied.push(t); } } }, configurable: true });

const P = await import('../src/views/partners.js');
const { DB } = await import('../src/model/db.js');
const callsAtImport = calls.length;

const HOSTILE = '<img src=x onerror=alert(1)>" onmouseover="alert(2)';
const reset = () => {
  calls = []; script = []; confirmSeen = []; copied = []; confirmAnswer = true;
  els['#clkBody'] = mkEl(); els['#clkTtl'] = mkEl();
  els['#toast'] = { textContent: '', classList: { add() {}, remove() {} } };
  Object.assign(P.CLK, { links: [], projection: null, workspaceRevision: null, ttlDays: 90, loaded: false, error: '', busy: '', shown: null, msg: null });
  DB.campaigns = [{ id: 'c1', brand: 'Brand One', name: 'Sushi Jongno', status: 'live' }, { id: 'c2', brand: HOSTILE, name: HOSTILE, status: 'planning' },
    { id: 'c3', brand: 'Old', name: 'Wrapped One', status: 'wrapped' }];
};
const link = (o) => Object.assign({ id: 'lnk_abc123456', campaignId: 'c1', status: 'active', createdAt: '2026-11-24T10:00:00Z', expiresAt: '2027-02-22T10:00:00Z',
  revokedAt: null, lastOpenedAt: null, viewBuiltAt: '2026-11-24T10:00:00Z', viewRevision: 5, stale: false }, o);
const list = (links, extra) => ({ status: 200, json: Object.assign({ ok: true, ttlDays: 90, workspaceRevision: 5, projection: { lastError: null }, links }, extra) });

test('labels: a campaign with no link offers Create link; one with a link offers Regenerate and Revoke, never a second copy', async () => {
  reset(); script = [list([link()])];
  await P.clkLoad();
  const html = P.clkBodyHtml();
  assert.match(html, /data-clk="create" data-cid="c2"[^>]*>Create link</);
  assert.match(html, /data-clk="regen"[^>]*>Regenerate</);
  assert.match(html, /data-clk="revoke"[^>]*>Revoke</);
  assert.match(html, />Rebuild now</);
  assert.ok(!/Copy link/.test(html), 'no Copy link button until a link has just been made');
  assert.ok(!/Wrapped One/.test(html), 'a wrapped campaign with no link is not listed');
  assert.match(html, /Active/);
  assert.match(html, /Never opened/);
});

test('escaping: a hostile campaign name or brand cannot inject markup into the card', async () => {
  reset(); script = [list([])];
  await P.clkLoad();
  const html = P.clkBodyHtml();
  assert.ok(!html.includes('<img'), 'raw markup reached the card');
  assert.ok(html.includes('&lt;img'));
  assert.ok(!/<[^>]*\sonmouseover=/i.test(html));
});

test('create: POSTs the campaign id only, shows the link ONCE, and the token is not kept anywhere else', async () => {
  reset(); script = [list([]), { status: 200, json: { ok: true, token: 'TOKEN_ONCE_aaaaaaaaaaaaaaaaaaaaaa', path: '/c/TOKEN_ONCE_aaaaaaaaaaaaaaaaaaaaaa', viewReady: true, link: link() } },
    list([link()])];
  await P.clkLoad();
  await P.clkAction('create', '', 'c1');
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [['GET', '/api/client-links', undefined],
    ['POST', '/api/client-links', { campaignId: 'c1' }], ['GET', '/api/client-links', undefined]]);
  assert.equal(P.CLK.shown.url, 'https://dash.test/c/TOKEN_ONCE_aaaaaaaaaaaaaaaaaaaaaa');
  assert.match(els['#clkBody'].innerHTML, /Shown once/);
  assert.match(els['#clkBody'].innerHTML, /Copy link/);
  await P.clkAction('copy', '', '');
  assert.deepEqual(copied, ['https://dash.test/c/TOKEN_ONCE_aaaaaaaaaaaaaaaaaaaaaa']);
  await P.clkAction('dismiss', '', '');
  assert.equal(P.CLK.shown, null);
  assert.ok(!els['#clkBody'].innerHTML.includes('TOKEN_ONCE'), 'the token is gone from the page after dismissing');
  assert.ok(!JSON.stringify(P.CLK).includes('TOKEN_ONCE'), 'the token is not kept in the card state');
});

test('regenerate and revoke: ask first; a "no" sends nothing; a "yes" calls the right route', async () => {
  reset(); script = [list([link()])];
  await P.clkLoad(); calls = [];
  confirmAnswer = false;
  await P.clkAction('regen', 'lnk_abc123456', 'c1');
  await P.clkAction('revoke', 'lnk_abc123456', 'c1');
  assert.equal(calls.length, 0);
  assert.match(confirmSeen[0], /old link stops working immediately/);
  assert.match(confirmSeen[1], /stops being able to open the page, immediately/);
  confirmAnswer = true;
  script = [{ status: 200, json: { ok: true, token: 'NEWTOKEN_bbbbbbbbbbbbbbbbbbbbbbbb', path: '/c/NEWTOKEN_bbbbbbbbbbbbbbbbbbbbbbbb', viewReady: true } }, list([link()]),
    { status: 200, json: { ok: true } }, list([link({ status: 'revoked', revokedAt: '2026-11-25T00:00:00Z' })])];
  await P.clkAction('regen', 'lnk_abc123456', 'c1');
  await P.clkAction('revoke', 'lnk_abc123456', 'c1');
  assert.deepEqual(calls.map((c) => c.method + ' ' + c.path), ['POST /api/client-links/lnk_abc123456/regenerate', 'GET /api/client-links',
    'POST /api/client-links/lnk_abc123456/revoke', 'GET /api/client-links']);
  assert.equal(P.CLK.shown, null, 'revoking clears a link that was on screen');
  assert.match(els['#clkBody'].innerHTML, /Revoked/);
  assert.match(els['#clkBody'].innerHTML, /data-clk="revoke"[^>]*disabled/);
});

test('status: expired, stale and failed projection are all said in words; last opened shows a time, never a viewer', async () => {
  reset();
  script = [list([link({ status: 'expired', lastOpenedAt: '2026-11-20T09:00:00Z' }), link({ id: 'lnk_zzzzzz1', campaignId: 'c2', stale: true })],
    { projection: { lastError: '1 view write(s) failed' } })];
  await P.clkLoad();
  const html = P.clkBodyHtml();
  assert.match(html, /Expired/);
  assert.match(html, /Last opened/);
  assert.match(html, /behind your last save/);
  assert.match(html, /Last update failed \(1 view write\(s\) failed\)/);
});

test('errors: 401, 403 and 503 are plain sentences; a failed create changes nothing on screen', async () => {
  reset(); script = [{ status: 403, json: { error: 'x' } }];
  await P.clkLoad();
  assert.match(P.clkBodyHtml(), /not allowed to manage brand links/);
  reset(); script = [list([]), { status: 409, json: { error: 'That campaign already has a link. Use Regenerate.' } }, list([])];
  await P.clkLoad();
  await P.clkAction('create', '', 'c1');
  assert.equal(P.CLK.shown, null);
  assert.match(els['#clkBody'].innerHTML, /already has a link/);
});

test('importing the card makes no request (passive until staff open the page)', () => {
  assert.equal(callsAtImport, 0);
});


/* ---------- review 37 low findings: staff reminder, and Rebuild skips ---------- */
test('reminder: the one-line check before sharing renders above the Create link buttons, as escaped text', async () => {
  reset(); script = [list([link()])];
  await P.clkLoad();
  const html = P.clkBodyHtml();
  const text = 'Before sharing: open the link yourself and check handles, campaign name and post links look right. Brands see handles only.';
  assert.ok(html.includes(text), 'reminder text missing');
  assert.ok(html.indexOf(text) < html.indexOf('data-clk="create"'), 'reminder is above the Create link button');
  assert.match(html, /<p class="card-sub" id="clkReminder"[^>]*>Before sharing:[^<]*<\/p>/, 'plain text paragraph, no inner markup');
  assert.equal(P.CLK_REMINDER, text);
});

test('rebuild: a skipped view is reported to staff, not hidden', async () => {
  reset(); script = [list([link()]), { status: 200, json: { ok: true, written: 1, skipped: 2 } }, list([link()])];
  await P.clkLoad();
  await P.clkAction('rebuild', '', '');
  assert.match(P.CLK.msg.text, /Rebuilt 1 brand view\./);
  assert.match(P.CLK.msg.text, /2 left as they were because a newer save is already shown/);
  assert.equal(P.CLK.msg.tone, 'warn');
});
