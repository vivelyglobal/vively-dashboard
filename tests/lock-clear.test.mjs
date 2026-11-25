/* LOCKING TAKES THE STAFF SCREEN OUT OF THE PAGE, NOT JUST OUT OF SIGHT.

   The lock is a CSS class. Without this, creator handles and post links from
   Home, the Performance tab, the Report builder and a print copy of a report
   stay in the DOM where the browser's own tools can read them. The shell is
   not a module, so the real source of clearStaffScreen, setAuthLocked and
   showAccessDenied is cut out of index.html and run against a fake page.
   All names and links below are made up. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const HTML = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function cut(head) {
  const i = HTML.indexOf(head);
  assert.ok(i > 0, head);
  /* a top-level function ends at the first newline + "}" */
  const j = HTML.indexOf('\n}\n', i);
  return HTML.slice(i, j + 2);
}
const STAFF_ARRAY = HTML.match(/const STAFF_SCREEN_IDS = \[[^\]]*\];/)[0];

const HANDLE = 'secret_handle_zz9';
const POST = 'https://www.instagram.com/p/SECRETPOST123/';
const STAFF = '<a href="' + POST + '">' + HANDLE + '</a>';

function fakePage() {
  const mk = (id) => {
    const cls = new Set();
    return { id, innerHTML: STAFF, textContent: '', classList: { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) },
      setAttribute() {}, addEventListener() {}, querySelector: () => ({ textContent: '', appendChild() {} }), appendChild() {}, style: {} };
  };
  const ids = ['view', 'hmViewsSat', 'rbRoot', 'reportPrint', 'daySheetPrint', 'drawerBody', 'drawerTitle', 'drawer', 'scrim', 'authOverlay', 'loginForm', 'signupForm', 'authMode'];
  const els = Object.fromEntries(ids.map((i) => [i, mk(i)]));
  els.drawer.classList.add('open'); els.scrim.classList.add('open');
  const body = mk('body'); body.classList.add('print-report');
  const document = { body, getElementById: (i) => els[i] || null, createElement: () => mk('new') };
  return { els, body, document };
}
const STAFF_NODES = ['view', 'hmViewsSat', 'rbRoot', 'reportPrint', 'daySheetPrint', 'drawerBody', 'drawerTitle'];
function assertClean(p) {
  STAFF_NODES.forEach((id) => {
    const h = p.els[id].innerHTML;
    assert.ok(!h.includes(HANDLE) && !h.includes('SECRETPOST123') && !h.includes('instagram.com'), id + ' still holds staff data');
    assert.equal(h, '', id);
  });
  assert.ok(!p.els.drawer.classList.contains('open'));
  assert.ok(!p.els.scrim.classList.contains('open'));
  assert.ok(!p.body.classList.contains('print-report'));
}
function run(page, calls, ...fnHeads) {
  const src = STAFF_ARRAY + '\n' + cut('function clearStaffScreen() {') + '\n' + fnHeads.map(cut).join('\n') +
    '\nreturn { setAuthLocked: typeof setAuthLocked === "function" ? setAuthLocked : null, showAccessDenied: typeof showAccessDenied === "function" ? showAccessDenied : null };';
  const $ = (s) => page.els[s.replace(/^#/, '')] || null;
  return new Function('document', 'resetStaffCaches', 'openAuth', '$', 'render', 'authState', 'signOut', src)(
    page.document, () => calls.push('reset'), (m) => calls.push('openAuth:' + m), $, () => calls.push('render'), { deniedReason: '' }, () => {});
}

test('lock: after setAuthLocked(true) the page holds no handle or post link', () => {
  const p = fakePage(); const calls = [];
  const f = run(p, calls, 'function setAuthLocked(locked) {');
  f.setAuthLocked(true);
  assertClean(p);
  assert.ok(p.body.classList.contains('auth-locked'));
  assert.deepEqual(calls, ['reset', 'openAuth:login']);
});
test('unlock: signing in does not empty the page that render() is about to fill', () => {
  const p = fakePage(); const calls = [];
  run(p, calls, 'function setAuthLocked(locked) {').setAuthLocked(false);
  assert.equal(p.els.view.innerHTML, STAFF);
  assert.ok(calls.includes('render'));
});
test('access denied: the page holds no handle or post link', () => {
  const p = fakePage(); const calls = [];
  const f = run(p, calls, 'function showAccessDenied() {');
  f.showAccessDenied();
  assertClean(p);
  assert.ok(p.body.classList.contains('auth-locked'));
  assert.deepEqual(calls, ['reset']);
});
test('shell: clearing runs right after resetStaffCaches in both paths, and sign-out goes through the lock', () => {
  const lock = cut('function setAuthLocked(locked) {');
  assert.ok(lock.indexOf('resetStaffCaches();') < lock.indexOf('clearStaffScreen()'));
  const den = cut('function showAccessDenied() {');
  assert.ok(den.indexOf('resetStaffCaches();') < den.indexOf('clearStaffScreen()'));
  assert.ok(cut('async function signOut() {').includes('setAuthLocked(true);'));
  /* the ids cleared are real: written in the markup or set by the code that builds them */
  const real = (id) => HTML.includes('id="' + id + '"') || HTML.includes("n.id = '" + id + "'") || HTML.includes("holder.id = '" + id + "'") || HTML.includes(", '" + id + "')");
  STAFF_NODES.forEach((id) => assert.ok(real(id), id));
  ['drawer', 'scrim'].forEach((id) => assert.ok(real(id), id));
});
