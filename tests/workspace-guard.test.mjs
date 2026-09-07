/* The guard that stops an empty workspace replacing a full one.

   This is the layer that does not trust the client, so the cases below
   are written from the server's point of view: it is handed a payload
   and the counts of what is already stored, and it has to decide
   without knowing why the payload looks the way it does. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const G = require('../server/workspace-guard.js');

const full = { campaigns: [1, 2], creators: [1, 2, 3], participants: [1] };
const empty = { campaigns: [], creators: [], participants: [] };

test('an empty payload over a stored workspace is refused', () => {
  const r = G.guardEmptyReplace({ incoming: empty, existing: full });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'empty-workspace');
  /* the message has to be usable by whoever sees it in a toast */
  assert.match(r.message, /2 campaigns/);
  assert.match(r.message, /reload the page/i);
});

test('force does not authorise it — that is a different question', () => {
  /* force settles "overwrite their revision with mine". It was never
     meant to mean "discard everything", and the guard does not read it. */
  const r = G.guardEmptyReplace({ incoming: empty, existing: full, force: true });
  assert.equal(r.ok, false);
});

test('a stated destructive intent is allowed through', () => {
  const r = G.guardEmptyReplace({ incoming: empty, existing: full, intent: G.RESET_INTENT });
  assert.equal(r.ok, true);
  assert.equal(r.reset, true);
});

test('a near-miss intent is not an intent', () => {
  for (const bad of [true, 1, 'reset', 'replace_with_empty', 'REPLACE-WITH-EMPTY', ' replace-with-empty'])
    assert.equal(G.guardEmptyReplace({ incoming: empty, existing: full, intent: bad }).ok, false,
      JSON.stringify(bad) + ' was accepted as a destructive intent');
});

test('a normal save is untouched', () => {
  assert.equal(G.guardEmptyReplace({ incoming: full, existing: full }).ok, true);
  assert.equal(G.guardEmptyReplace({ incoming: full, existing: empty }).ok, true);
});

test('the very first save into an empty database is allowed', () => {
  /* nothing to protect, so nothing is refused — otherwise a new
     deployment could never write its first workspace */
  const r = G.guardEmptyReplace({ incoming: empty, existing: empty });
  assert.equal(r.ok, true);
  assert.equal(G.guardEmptyReplace({ incoming: empty, existing: {} }).ok, true);
});

test('one surviving collection is enough to protect the other two', () => {
  /* a load that half-failed is still a load that half-failed */
  assert.equal(G.guardEmptyReplace({ incoming: empty, existing: { campaigns: [], creators: [1], participants: [] } }).ok, false);
  assert.equal(G.guardEmptyReplace({ incoming: empty, existing: { campaigns: [1], creators: [], participants: [] } }).ok, false);
  assert.equal(G.guardEmptyReplace({ incoming: empty, existing: { campaigns: [], creators: [], participants: [1] } }).ok, false);
});

test('emptiness is judged on the three collections a workspace is made of', () => {
  /* an appointment or a partner link is not evidence that the roster
     survived, so they must not wave a wipe through */
  const decoy = { campaigns: [], creators: [], participants: [], appointments: [1], partnerLinks: [1], socialContent: [1] };
  assert.equal(G.isEmptyWorkspace(decoy), true);
  assert.equal(G.guardEmptyReplace({ incoming: decoy, existing: full }).ok, false);
});

test('a malformed payload is treated as empty rather than trusted', () => {
  for (const junk of [null, undefined, {}, { campaigns: null }, { campaigns: 'nope', creators: 3 }])
    assert.equal(G.guardEmptyReplace({ incoming: junk, existing: full }).ok, false,
      'accepted junk: ' + JSON.stringify(junk));
});

test('counts are reported so the refusal can say what it saved', () => {
  const r = G.guardEmptyReplace({ incoming: empty, existing: full });
  assert.deepEqual(r.existing, { campaigns: 2, creators: 3, participants: 1 });
});

test('the client and the server agree on the intent string', async () => {
  /* two copies of one constant is a drift waiting to happen; this is
     the test that notices */
  const fs = await import('node:fs');
  const src = fs.readFileSync('src/model/db.js', 'utf8');
  const m = src.match(/RESET_INTENT\s*=\s*'([^']+)'/);
  assert.ok(m, 'the client has no RESET_INTENT');
  assert.equal(m[1], G.RESET_INTENT);
});
