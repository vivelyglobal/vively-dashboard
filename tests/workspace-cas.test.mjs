import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { writeWorkspaceCas } = require('../server/workspace-cas.js');
const { makeSaveWorkspace } = require('../server/notion-autocreate.js');

/* In-memory stand-in for the one workspace document. It supports exactly the
   filters the code uses (_id, revision equality, revision {$in:[0,null]}),
   upsert, insertOne with a duplicate-key error, and a `between` hook that
   runs once, right before the first write, to simulate a concurrent writer. */
function fakeCol(initial) {
  const store = new Map();
  if (initial) store.set('ws', structuredClone(initial));
  const c = { store, between: null, writes: [] };
  const matches = (d, f) => {
    if (!d || d._id !== f._id) return false;
    if ('revision' in f) {
      const r = d.revision === undefined ? null : d.revision;
      if (f.revision && f.revision.$in) return f.revision.$in.includes(r);
      return r === f.revision;
    }
    return true;
  };
  const hook = () => { const h = c.between; c.between = null; if (h) h(); };
  c.findOne = async (f) => structuredClone(store.get(f._id) || null);
  c.updateOne = async (f, u, opt = {}) => {
    hook();
    c.writes.push({ f, opt });
    const d = store.get(f._id);
    if (matches(d, f)) { Object.assign(d, u.$set); return { matchedCount: 1 }; }
    if (opt.upsert) { store.set(f._id, { _id: f._id, ...u.$set }); return { matchedCount: 0, upsertedCount: 1 }; }
    return { matchedCount: 0 };
  };
  c.insertOne = async (d) => {
    hook();
    if (store.has(d._id)) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    store.set(d._id, structuredClone(d));
    return {};
  };
  return c;
}

/* The same read -> work -> write sequence as saveWorkspaceDoc in server.js. */
async function saveDoc(col, body) {
  const existing = await col.findOne({ _id: 'ws' });
  const currentRevision = (existing && existing.revision) || 0;
  const clientRevision = Number.isFinite(body.revision) ? body.revision : 0;
  const force = !!body.force;
  if (existing && !force && clientRevision !== currentRevision) return { status: 409, json: { revision: currentRevision } };
  const nextRevision = currentRevision + 1;
  const w = await writeWorkspaceCas(col, 'ws', {
    db: body.db, settings: body.settings || {}, savedAt: 't' + nextRevision, nextRevision, currentRevision,
    existed: !!existing, force
  });
  if (w.conflict) return { status: 409, json: { revision: w.revision, savedAt: w.savedAt } };
  return { status: 200, json: { ok: true, revision: nextRevision } };
}

const base = { _id: 'ws', db: { campaigns: ['a'] }, settings: {}, revision: 5, savedAt: 't5' };

test('plain save bumps the revision and writes with the revision in the filter', async () => {
  const col = fakeCol(base);
  const out = await saveDoc(col, { db: { campaigns: ['b'] }, revision: 5 });
  assert.deepEqual(out, { status: 200, json: { ok: true, revision: 6 } });
  assert.equal(col.store.get('ws').revision, 6);
  assert.deepEqual(col.writes[0].f, { _id: 'ws', revision: 5 });
  assert.notEqual(col.writes[0].opt.upsert, true);
});

test('staff save lands between the job read and write: job gets 409, staff data survives', async () => {
  const col = fakeCol(base);
  col.between = () => { Object.assign(col.store.get('ws'), { db: { campaigns: ['staff'] }, revision: 6, savedAt: 't6' }); };
  const job = makeSaveWorkspace((b) => saveDoc(col, b));
  const r = await job({ db: { campaigns: ['job'] }, settings: {}, revision: 5 });
  assert.deepEqual(r, { conflict: true });
  assert.deepEqual(col.store.get('ws').db, { campaigns: ['staff'] });
  assert.equal(col.store.get('ws').revision, 6);
  /* the job's retry (re-read, revision 6) then succeeds */
  const r2 = await job({ db: { campaigns: ['staff', 'job'] }, settings: {}, revision: 6 });
  assert.deepEqual(r2, { ok: true, revision: 7 });
});

test('job lands first: the staff save gets 409 with the current revision and savedAt', async () => {
  const col = fakeCol(base);
  col.between = () => { Object.assign(col.store.get('ws'), { db: { campaigns: ['job'] }, revision: 6, savedAt: 't6' }); };
  const out = await saveDoc(col, { db: { campaigns: ['staff'] }, revision: 5 });
  assert.equal(out.status, 409);
  assert.deepEqual(out.json, { revision: 6, savedAt: 't6' });
  assert.deepEqual(col.store.get('ws').db, { campaigns: ['job'] });
});

test('first-insert race: both saw no document; the loser gets 409 and does not overwrite', async () => {
  const col = fakeCol(null);
  col.between = () => { col.store.set('ws', { _id: 'ws', db: { campaigns: ['winner'] }, settings: {}, revision: 1, savedAt: 't1' }); };
  const out = await saveDoc(col, { db: { campaigns: ['loser'] }, revision: 0 });
  assert.equal(out.status, 409);
  assert.equal(out.json.revision, 1);
  assert.deepEqual(col.store.get('ws').db, { campaigns: ['winner'] });
});

test('first insert with no race creates the document at revision 1', async () => {
  const col = fakeCol(null);
  const out = await saveDoc(col, { db: { campaigns: ['x'] }, revision: 0 });
  assert.deepEqual(out, { status: 200, json: { ok: true, revision: 1 } });
  assert.deepEqual(col.store.get('ws'), { _id: 'ws', db: { campaigns: ['x'] }, settings: {}, savedAt: 't1', revision: 1 });
});

test('a legacy document with no revision field is still saveable at revision 0', async () => {
  const col = fakeCol({ _id: 'ws', db: { campaigns: [] }, settings: {} });
  const out = await saveDoc(col, { db: { campaigns: ['n'] }, revision: 0 });
  assert.equal(out.status, 200);
  assert.equal(col.store.get('ws').revision, 1);
});

test('force path is unchanged: unfiltered upsert, wins over a concurrent writer', async () => {
  const col = fakeCol(base);
  col.between = () => { Object.assign(col.store.get('ws'), { db: { campaigns: ['other'] }, revision: 6 }); };
  const out = await saveDoc(col, { db: { campaigns: ['forced'] }, revision: 1, force: true });
  assert.equal(out.status, 200);
  assert.deepEqual(col.writes[0].f, { _id: 'ws' });
  assert.equal(col.writes[0].opt.upsert, true);
  assert.deepEqual(col.store.get('ws').db, { campaigns: ['forced'] });
  assert.equal(col.store.get('ws').revision, 6); /* currentRevision(5, as read) + 1, as before */
});

test('a database error other than duplicate key is thrown, not turned into a conflict', async () => {
  const col = fakeCol(null);
  col.insertOne = async () => { throw Object.assign(new Error('boom'), { code: 1 }); };
  await assert.rejects(() => saveDoc(col, { db: {}, revision: 0 }), /boom/);
});

test('server.js writes through the compare-and-set and has no bare upsert left', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /writeWorkspaceCas\(col, WORKSPACE_ID/);
  const fn = src.slice(src.indexOf('async function saveWorkspaceDoc'), src.indexOf('app.post("/api/workspace"'));
  assert.ok(!/upsert/.test(fn), 'saveWorkspaceDoc must not upsert directly');
});
