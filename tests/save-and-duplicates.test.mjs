import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/* Two bugs that cost real work, and the rules that now stop them.

   1. A campaign created and then gone after a refresh. serverSave() had
      three silent early returns, and the worst of them was
      `if (SERVER.busy) return` — a save that arrived while another was in
      flight was dropped, and the caller's promise resolved anyway, so
      "Create campaign" reported success and stored nothing. The autosave
      debounce is two seconds, so this was not a rare window.

   2. A roster that empties itself. Two campaigns built from the same
      Notion form both claim every submission in it, and the sync's
      rehoming rule moves the whole roster onto whichever was synced last.

   Both are read out of the shipping index.html rather than restated
   here, so a rule that changes there fails here. */
const src = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  .match(/<script>([\s\S]*)<\/script>/)[1];

const slice = (startsWith, endsBefore) => {
  const a = src.indexOf(startsWith);
  assert.ok(a > -1, 'not found in index.html: ' + startsWith);
  const b = src.indexOf(endsBefore, a);
  assert.ok(b > a, 'end not found after: ' + startsWith);
  return src.slice(a, b);
};

/* ---------------- 1 · what a save reports ---------------- */
const saveText = slice('function saveOutcomeText(r) {', '\n/* "I did the thing');
const outcome = (r) => {
  const ctx = vm.createContext({ SERVER: { error: null } });
  vm.runInContext(saveText + '\nthis.out = saveOutcomeText(' + JSON.stringify(r) + ');', ctx);
  return ctx.out;
};

test('a save that did not run never reads as one that did', () => {
  /* the old code returned undefined here and the caller toasted success */
  assert.match(outcome(undefined), /^Not saved/);
});

test('"there was nothing to save" is said out loud, not by staying silent', () => {
  assert.match(outcome({ ok: true, reason: 'unchanged' }), /Already saved/);
});

test('a real save says so plainly', () => {
  assert.equal(outcome({ ok: true, reason: 'saved' }), 'Saved');
});

test('every failure says NOT SAVED and what to do about it', () => {
  for (const r of [{ ok: false, reason: 'failed', error: 'network down' },
                   { ok: false, reason: 'refused', error: 'the guard said no' },
                   { ok: false, reason: 'auth', error: 'Not signed in' }]) {
    const t = outcome(r);
    assert.match(t, /NOT SAVED/, JSON.stringify(r));
    assert.match(t, /Click Save/, JSON.stringify(r));
    assert.ok(t.includes(r.error), 'the reason the server gave is missing: ' + t);
  }
});

test('a conflict tells you the other browser won, not that it saved', () => {
  const t = outcome({ ok: false, reason: 'conflict' });
  assert.match(t, /^Not saved/);
  assert.match(t, /someone else saved more recently/i);
});

test('an unconfigured server is not reported as a failure of yours', () => {
  assert.match(outcome({ ok: false, reason: 'not-configured' }), /this browser only/);
});

test('nothing is dropped on the floor: every early return carries an answer', () => {
  /* the shape of the bug, guarded structurally — a bare `return;` inside
     serverSaveNow is exactly what made a dropped save look successful */
  const body = slice('async function serverSaveNow(opts) {', '\nfunction scheduleServerSave');
  const bare = body.split('\n').filter((l) => /^\s*return;\s*$/.test(l));
  assert.deepEqual(bare, [], 'serverSaveNow still has a bare return: ' + bare.join(' | '));
});

test('saves are serialised rather than dropped when one is in flight', () => {
  const entry = slice('function serverSave(opts) {', '\n\n/* An autosave says nothing');
  assert.match(entry, /saveChain/, 'serverSave no longer queues');
  assert.ok(!/if \(SERVER\.busy\) return;/.test(entry), 'the dropping guard is back');
});

/* ---------------- 2 · one Notion form, two campaigns ---------------- */
const dup = slice('function notionDbKey(id) {', '\nasync function runNotionSync');
const dupCtx = (campaigns) => {
  const ctx = vm.createContext({ DB: { campaigns }, String });
  vm.runInContext(dup + '\nthis.api = { notionDbKey, campaignsSharingNotionDb };', ctx);
  return ctx.api;
};

test('the same database id in two spellings is one database', () => {
  const { notionDbKey } = dupCtx([]);
  assert.equal(notionDbKey('1a2b3c4d-5e6f-7071-8283-849596a7b8c9'),
               notionDbKey('1A2B3C4D5E6F70718283849596A7B8C9'));
});

test('a blank id matches nothing — an unlinked campaign is not a duplicate', () => {
  const cps = [{ id: 'a' }, { id: 'b' }, { id: 'c', notionDatabaseId: 'xyz' }];
  const { campaignsSharingNotionDb } = dupCtx(cps);
  assert.equal(campaignsSharingNotionDb(cps[0]).map((c) => c.id).join(','), '');
});

test('two campaigns built from one form find each other, dashes or not', () => {
  const cps = [
    { id: 'a', name: 'JP 마포직영점', notionDatabaseId: '1a2b3c4d-5e6f-7071-8283-849596a7b8c9' },
    { id: 'b', name: 'JP 마포직영점 (again)', notionDatabaseId: '1A2B3C4D5E6F70718283849596A7B8C9' },
    { id: 'c', name: 'somebody else', notionDatabaseId: 'ffffffffffffffffffffffffffffffff' }
  ];
  const { campaignsSharingNotionDb } = dupCtx(cps);
  assert.equal(campaignsSharingNotionDb(cps[0]).map((c) => c.id).join(','), 'b');
  assert.equal(campaignsSharingNotionDb(cps[1]).map((c) => c.id).join(','), 'a');
  assert.equal(campaignsSharingNotionDb(cps[2]).map((c) => c.id).join(','), '');
});

/* The rehoming rule itself. Lifted whole, so this is the branch that
   ships. `ambiguous` counts rows the sync refused to move because the
   form no longer identifies an owner — before, every one of them was
   dragged onto whichever campaign was synced last, which is what emptied
   the other one. */
const rehome = slice('    if (p && p.campaignId !== cp.id && dbIsShared) {', '\n    if (!p) {');
const runRehome = (dbIsShared, p, cpId) => {
  const ctx = vm.createContext({ dbIsShared, p, cp: { id: cpId }, ambiguous: 0, rehomed: 0, heldBack: 0 });
  vm.runInContext(rehome + '\nthis.out = { p, ambiguous, rehomed, heldBack };', ctx);
  return ctx.out;
};

test('with one campaign on the form, a row still comes home', () => {
  const out = runRehome(false, { campaignId: 'old' }, 'mine');
  assert.equal(out.p.campaignId, 'mine');
  assert.equal(out.rehomed, 1);
  assert.equal(out.ambiguous, 0);
});

test('with two campaigns on the form, the row is left exactly where it is', () => {
  /* THE BUG: this used to set campaignId = 'mine' and empty the other
     campaign's roster the moment it was synced */
  const out = runRehome(true, { campaignId: 'the-twin' }, 'mine');
  assert.equal(out.p.campaignId, 'the-twin');
  assert.equal(out.rehomed, 0);
  assert.equal(out.ambiguous, 1, 'a row left behind must be counted, not silently skipped');
});

test('a row pinned by hand is still never moved', () => {
  const out = runRehome(false, { campaignId: 'elsewhere', pinnedCampaign: true }, 'mine');
  assert.equal(out.p.campaignId, 'elsewhere');
  assert.equal(out.heldBack, 1);
});

test('a row already on this campaign is not touched or counted', () => {
  const out = runRehome(false, { campaignId: 'mine' }, 'mine');
  assert.equal(out.rehomed, 0);
  assert.equal(out.ambiguous, 0);
  assert.equal(out.heldBack, 0);
});

test('sharing is checked before pinning, so an ambiguous pinned row stays put once', () => {
  const out = runRehome(true, { campaignId: 'the-twin', pinnedCampaign: true }, 'mine');
  assert.equal(out.p.campaignId, 'the-twin');
  assert.equal(out.ambiguous, 1);
  assert.equal(out.heldBack, 0);
});
