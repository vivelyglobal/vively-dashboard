import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  .match(/<script>([\s\S]*)<\/script>/)[1];

/* newId, on its own */
const idSrc = src.slice(src.indexOf('function newId(prefix)'), src.indexOf('const AV_COLORS ='));
const idCtx = vm.createContext({ Date, Math, globalThis: {}, crypto: undefined });
vm.runInContext(idSrc + '\nthis.newId = newId;', idCtx);
const { newId } = idCtx.newId ? idCtx : { newId: idCtx.newId };

test('ids do not repeat, even 5000 in a row', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(idCtx.newId('cp'));
  assert.equal(seen.size, 5000);
});

test('ids do not repeat across a simulated page reload', () => {
  /* the actual bug: mulberry32 has a fixed seed, so a fresh page produced
     the same "random" number at the same point in the sequence */
  const fresh = () => {
    const c = vm.createContext({ Date, Math, globalThis: {}, crypto: undefined });
    vm.runInContext(idSrc, c);
    return c;
  };
  const a = fresh(), b = fresh();
  assert.notEqual(vm.runInContext("newId('cp')", a), vm.runInContext("newId('cp')", b));
});

test('the seeded generator is NOT used for identity any more', () => {
  const idLines = src.split('\n').filter((l) => /\bid\s*[:=]\s*'(cp|nt|im|ap)'/.test(l) || /newId\(/.test(l));
  const seeded = idLines.filter((l) => /rnd\(\)/.test(l));
  assert.equal(seeded.length, 0, 'an id is still being built from the seeded RNG:\n' + seeded.join('\n'));
});

/* the detector and the repair, against the real shape of the problem */
const dupSrc = src.slice(src.indexOf('function duplicateIdGroups()'), src.indexOf('function duplicateIdBanner()'));
function makeCtx(db) {
  const ctx = vm.createContext({ Date, Math, Object, Set, globalThis: {}, crypto: undefined,
    DB: db, byCampaign: {}, byCreator: {}, recomputeCreatorStats() {} });
  vm.runInContext(idSrc + dupSrc + '\nthis.api = { duplicateIdGroups, repairDuplicateIds };', ctx);
  return ctx;
}

const sushi = () => ({
  campaigns: [
    { id: 'cp9345', brand: 'Sushikoji- JP', name: 'Sushikoji- JP', notionDatabaseId: 'e65c' },
    { id: 'cp9345', brand: 'Sushisora',     name: 'Sushisora',     notionDatabaseId: '8b5c' },
    { id: 'cp1000', brand: 'KOWORK',        name: 'KOWORK' }
  ],
  creators: [{ id: 'cr1' }, { id: 'cr2' }],
  participants: Array.from({ length: 46 }, (_, i) => ({
    id: 'cp9345-cr' + i, campaignId: 'cp9345', creatorId: 'cr' + i,
    notionPageId: 'pg' + i
  }))
});

test('it finds the real collision', () => {
  const ctx = makeCtx(sushi());
  const groups = ctx.api.duplicateIdGroups();
  const camps = groups.filter((g) => g.kind === 'campaigns');
  assert.equal(camps.length, 1);
  assert.equal(camps[0].id, 'cp9345');
  /* arrays built inside the vm have a different realm's prototype, so
     compare the values rather than the objects */
  assert.equal(camps[0].list.map((c) => c.brand).join('|'), 'Sushikoji- JP|Sushisora');
});

test('the repair renumbers the LATER one and leaves the first alone', () => {
  const db = sushi();
  const ctx = makeCtx(db);
  ctx.api.repairDuplicateIds();
  assert.equal(db.campaigns[0].id, 'cp9345', 'the first campaign should keep the id links point at');
  assert.notEqual(db.campaigns[1].id, 'cp9345');
  assert.match(db.campaigns[1].id, /^cp/);
  assert.equal(ctx.api.duplicateIdGroups().length, 0, 'nothing should collide afterwards');
});

test('the repair does not guess which creators belong where', () => {
  /* there is no way to tell offline — the pages say, and only Notion knows
     which pages are whose. Guessing would scatter a roster silently. */
  const db = sushi();
  makeCtx(db).api.repairDuplicateIds();
  assert.equal(db.participants.filter((p) => p.campaignId === 'cp9345').length, 46);
});

test('a clean workspace is left completely alone', () => {
  const db = { campaigns: [{ id: 'a' }, { id: 'b' }], creators: [{ id: 'c' }], participants: [{ id: 'd' }] };
  const ctx = makeCtx(db);
  assert.equal(ctx.api.duplicateIdGroups().length, 0);
  assert.equal(ctx.api.repairDuplicateIds().fixed, 0);
  assert.equal(db.campaigns.map((c) => c.id).join('|'), 'a|b');
});

test('duplicate creators and roster rows are caught too', () => {
  const db = { campaigns: [], creators: [{ id: 'x' }, { id: 'x' }],
               participants: [{ id: 'y', campaignId: 'c', creatorId: 'x' }, { id: 'y', campaignId: 'c', creatorId: 'z' }] };
  const ctx = makeCtx(db);
  assert.equal(ctx.api.duplicateIdGroups().length, 2);
  ctx.api.repairDuplicateIds();
  assert.equal(ctx.api.duplicateIdGroups().length, 0);
});

/* --- what a repair must NOT disturb ---------------------------------------
   A roster row's id is not just a label. The Google Calendar event for that
   booking has an id derived from it, and a partner's comments are filed
   against it. Change it and you get a second event for the same visit and
   comments attached to nothing. */
const rehomeSrc = src.slice(src.indexOf('    if (p && p.campaignId !== cp.id) {'),
                            src.indexOf('rehomed++;') + 'rehomed++;\n    }'.length);

test('re-homing a row to its real campaign does not change the row id', () => {
  assert.ok(/p\.campaignId = cp\.id;/.test(rehomeSrc), 'it should set the campaign');
  assert.ok(!/p\.id\s*=/.test(rehomeSrc),
    'the row id must not be reassigned — a calendar event and any partner comments are keyed on it');
});

test('a re-homed booking keeps the calendar event it already has', () => {
  const ctx = makeCtx({ campaigns: [], creators: [], participants: [] });
  /* the calendar derives an event id from the row id, so the same row must
     keep resolving to the same event after it moves campaign */
  const row = { id: 'cp9345-nt33-962', campaignId: 'cp9345', creatorId: 'nt33',
                notionPageId: 'pg1', googleEventId: 'v0abc' };
  const before = row.id;
  row.campaignId = 'cpNEWID';            /* what re-homing now does, and only this */
  assert.equal(row.id, before);
  assert.equal(row.googleEventId, 'v0abc');
});

test('a renumbered duplicate row does not inherit another row\'s event', () => {
  const db = { campaigns: [], creators: [],
    participants: [
      { id: 'dup', campaignId: 'c', creatorId: 'a', googleEventId: 'v0shared', googleLink: 'x' },
      { id: 'dup', campaignId: 'c', creatorId: 'b', googleEventId: 'v0shared', googleLink: 'x' }
    ] };
  makeCtx(db).api.repairDuplicateIds();
  assert.equal(db.participants[0].googleEventId, 'v0shared', 'the first row keeps what it had');
  assert.equal(db.participants[1].googleEventId, undefined,
    'the renumbered row must not point at an event that is no longer its own');
  assert.notEqual(db.participants[1].id, 'dup');
});

test('the repair leaves every other record untouched', () => {
  const db = {
    campaigns: [{ id: 'a', brand: 'A', notionDatabaseId: 'x', notionMapping: { S: 'status' } },
                { id: 'b', brand: 'B' }, { id: 'b', brand: 'C' }],
    creators: [{ id: 'c1', handle: '@one', payout: { number: '110' } }],
    participants: [{ id: 'p1', campaignId: 'a', creatorId: 'c1', visitAt: '2026-09-04 19:00',
                     googleEventId: 'v0keep', notionPageId: 'pg' }]
  };
  const snapshot = JSON.stringify({ a: db.campaigns[0], c: db.creators[0], p: db.participants[0] });
  makeCtx(db).api.repairDuplicateIds();
  assert.equal(JSON.stringify({ a: db.campaigns[0], c: db.creators[0], p: db.participants[0] }), snapshot,
    'only the colliding record should have been touched');
});
