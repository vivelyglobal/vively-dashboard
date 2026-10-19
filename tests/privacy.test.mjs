/* Where creator bank details are allowed to go, and what leaving the
   dashboard takes off the machine. These are small functions, and each
   one of them is the last thing standing between a bank account number
   and somebody's Downloads folder. */

import './helpers/browser-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DB, SERVER, stripPayout, applyStoredSettings, clearPersisted } from '../src/model/db.js';
import { SETTINGS } from '../src/model/settings.js';

const creator = (id, extra) => Object.assign({
  id, handle: '@' + id, name: id, email: id + '@mail.test', platform: 'Instagram',
  followers: 1000, address: 'Seoul', contact: 'kakao-' + id,
  payout: { bank: 'KB', name: 'Real Name', number: '1234-5678-9012' }
}, extra || {});

test('stripPayout removes the bank details and nothing else', () => {
  const out = stripPayout({ creators: [creator('a'), creator('b', { payout: null })], campaigns: [{ id: 'c' }] });
  assert.ok(out.creators.every((c) => !c.payout), 'no payout survives');
  assert.equal(out.creators[0].email, 'a@mail.test', 'the rest of the record is untouched');
  assert.equal(out.creators[0].handle, '@a');
  assert.deepEqual(out.campaigns, [{ id: 'c' }], 'other collections pass through');
});

test('and it does not quietly empty the original', () => {
  const src = { creators: [creator('a')] };
  stripPayout(src);
  assert.equal(src.creators[0].payout.number, '1234-5678-9012', 'the in-memory copy still has it');
});

test('a creator with no payout at all survives the strip intact', () => {
  const plain = { id: 'z', handle: '@z', email: 'z@mail.test' };
  const out = stripPayout({ creators: [plain] });
  assert.deepEqual(out.creators[0], plain);
});

test('an account number never appears in what stripPayout returns', () => {
  const json = JSON.stringify(stripPayout({ creators: [creator('a'), creator('b')] }));
  assert.ok(!json.includes('1234-5678-9012'), 'the number is gone from the serialised copy');
  assert.ok(!/\bKB\b/.test(json), 'and so is the bank');
});

test('stored settings come back whole, not one key at a time', () => {
  SETTINGS.hideBlocked = true;
  delete SETTINGS.holidays;
  applyStoredSettings({ hideBlocked: false, holidays: [{ d: '2026-12-25', n: 'Christmas' }] });
  assert.equal(SETTINGS.hideBlocked, false);
  assert.deepEqual(SETTINGS.holidays, [{ d: '2026-12-25', n: 'Christmas' }],
    'the hand-maintained holiday list used to be dropped here');
});

test('a key the stored copy has never heard of is left alone', () => {
  SETTINGS.somethingLocal = 'keep me';
  applyStoredSettings({ hideBlocked: true });
  assert.equal(SETTINGS.somethingLocal, 'keep me');
  delete SETTINGS.somethingLocal;
});

test('nothing stored means nothing changed', () => {
  SETTINGS.hideBlocked = true;
  applyStoredSettings(null);
  applyStoredSettings(undefined);
  applyStoredSettings('not an object');
  assert.equal(SETTINGS.hideBlocked, true);
});

test('clearing takes every collection with it, not just three', () => {
  DB.creators.push(creator('a'));
  DB.campaigns.push({ id: 'cp1', brand: 'B' });
  DB.participants.push({ id: 'p1', campaignId: 'cp1', creatorId: 'a' });
  DB.appointments.push({ id: 'ap1' });
  DB.partnerLinks.push({ partner: 'B', token: 'tok' });
  DB.socialContent.push({ id: 'sc1' });
  clearPersisted();
  ['creators', 'campaigns', 'participants', 'appointments', 'partnerLinks', 'socialContent']
    .forEach((k) => assert.equal(DB[k].length, 0, k + ' was left behind'));
});

test('and it takes the browser copy with it', () => {
  localStorage.setItem('vively-workspace-v1', JSON.stringify({ db: { creators: [creator('a')] } }));
  clearPersisted();
  assert.equal(localStorage.getItem('vively-workspace-v1'), null);
});

test('a refused save does not leave the tab looking up to date', () => {
  /* the partner-link bug in one line: the conflict is remembered as the
     other side's revision, never adopted as this tab's */
  SERVER.revision = 7;
  SERVER.conflictRevision = null;
  SERVER.status = 'idle';
  const before = SERVER.revision;
  SERVER.status = 'conflict';
  SERVER.conflictRevision = 8;
  assert.equal(SERVER.revision, before, 'the tab stays behind until it reloads or a person overwrites');
});
