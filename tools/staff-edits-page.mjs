/* Staff edits, in a browser: the three things staff could not do.

     1. Booking — edit a slot's time and seats, delete a slot or a whole
        day that already has bookings (cancelling them on purpose), and
        edit or cancel one booking.
     2. Creators — edit a creator's details, the profile metrics above all.
     3. Add to a campaign — every campaign is offered, wrapped ones
        included, rather than only the active few.

   Runs the real index.html against the real booking routes over
   tools/fake-booking-db.mjs, with the seed workspace in localStorage —
   the same setup as tools/booking-admin-page.mjs. */

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { col, fakeClient } from './fake-booking-db.mjs';

const require = createRequire(import.meta.url);
const routes = require('../server/booking-routes.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const seedObj = JSON.parse(fs.readFileSync(path.join(ROOT, 'tmp/seed.json'), 'utf8'));

/* two of the four campaigns wrapped: the case the old picker hid */
seedObj.db.campaigns.forEach((c, i) => { c.status = i >= 2 ? 'wrapped' : (c.status === 'wrapped' ? 'live' : c.status); });

const errs = [];
const ok = (n, cond, extra) => {
  if (cond) console.log('ok   ' + n + (extra ? '   ' + extra : ''));
  else { console.log('FAIL ' + n + (extra ? '   ' + extra : '')); errs.push(n); }
};

const app = express();
app.use(express.json({ limit: '10mb' }));
routes.mountBookingRoutes(app, {
  getMongoClient: async () => fakeClient, MONGODB_DB: 'test', MONGODB_URI: 'mongodb://fake',
  loadWorkspaceDoc: async () => ({ db: {} }), requireStaff: (h) => h
});
app.get('/api/me', (req, res) => res.json({ user: { email: 'k@v.com', name: 'Harness' }, staff: true }));
/* the real server's shape: { ok, data: { db, … } } */
let WS = { db: seedObj.db, settings: {}, savedAt: new Date().toISOString(), revision: 1 };
let saves = 0;
app.get('/api/workspace', (req, res) => res.json({ ok: true, data: WS }));
app.post('/api/workspace', (req, res) => {
  saves++;
  WS = { ...WS, db: (req.body || {}).db || WS.db, revision: WS.revision + 1, savedAt: new Date().toISOString() };
  res.json({ ok: true, savedAt: WS.savedAt, revision: WS.revision });
});
app.use(express.static(ROOT));
app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
const srv = app.listen(0);
await new Promise((r) => srv.once('listening', r));
const BASE = 'http://127.0.0.1:' + srv.address().port;
const api = async (p, body, method) => {
  const r = await fetch(BASE + p, { method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.' + Math.floor(Math.random() * 250) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
await ctx.addInitScript(() => {
  localStorage.setItem('vively-auth-user-v1', JSON.stringify({ email: 'k@v.com', name: 'K' }));
});
const p = await ctx.newPage();
const pageErrors = [];
p.on('pageerror', (e) => pageErrors.push(e.message));
p.on('dialog', (d) => d.accept());
const go = async (hash) => { await p.goto(BASE + '/#/blank'); await p.goto(BASE + '/#/' + hash); await p.waitForTimeout(600); };
const drawerText = async () => ((await p.textContent('#drawer, .drawer')) || '').replace(/\s+/g, ' ');

/* ======================= 2. editing a creator ======================= */

await go('creators');
const CR = await p.evaluate(() => DB.creators[0].id);
const other = await p.evaluate(() => DB.creators[1].handle);
await p.evaluate((id) => showCreator(id), CR);
await p.waitForSelector('#crEdit', { timeout: 5000 });
ok('the creator drawer has Edit details', await p.isVisible('#crEdit'));
await p.click('#crEdit');
await p.waitForSelector('#ecSave', { timeout: 5000 });
ok('the edit form shows followers, ER and avg views',
  await p.isVisible('#ecFollowers') && await p.isVisible('#ecEr') && await p.isVisible('#ecAvgViews'));

await p.fill('#ecHandle', other);
await p.click('#ecSave'); await p.waitForTimeout(300);
ok('a handle that belongs to another creator is refused',
  (await p.evaluate((id) => byCreator[id].handle, CR)) !== other && await p.isVisible('#ecSave'));

await p.fill('#ecHandle', 'edited_handle');
await p.fill('#ecFollowers', '123456');
await p.fill('#ecEr', '4.75');
await p.fill('#ecAvgViews', '98000');
await p.fill('#ecCountry', 'Vietnam');
await p.fill('#ecCats', 'Beauty, K-Food, Beauty');
await p.click('#ecSave'); await p.waitForTimeout(500);
const cr = await p.evaluate((id) => byCreator[id], CR);
ok('followers, ER and avg views are saved', cr.followers === 123456 && cr.er === 4.75 && cr.avgViews === 98000,
  [cr.followers, cr.er, cr.avgViews].join(' / '));
ok('the handle is saved with its @', cr.handle === '@edited_handle');
ok('country and categories are saved, duplicates dropped', cr.country === 'Vietnam' && cr.categories.join() === 'Beauty,K-Food');
ok('the tier follows the new follower count', cr.tier === 'mid', cr.tier);
ok('a hand edit is marked as manual', cr.metricsSource === 'manual' && !!cr.metricsSyncedAt);
ok('the drawer shows the new figures', (await drawerText()).includes('123.5K') || (await drawerText()).includes('123K'),
  (await drawerText()).slice(0, 120));
await p.waitForTimeout(2500);   /* the autosave */
ok('and the edit reaches the saved workspace', (() => {
  const c = (WS.db.creators || []).find((x) => x.id === CR);
  return !!c && c.followers === 123456;
})(), saves + ' saves');

/* ==================== 3. add to a campaign: all of them ==================== */

await p.evaluate((id) => showCreator(id), CR);
await p.waitForSelector('#crAddTo');
await p.click('#crAddTo');
await p.waitForSelector('#atCp', { timeout: 5000 });
const counts = await p.evaluate(() => ({
  all: DB.campaigns.length,
  opts: document.querySelectorAll('#atCp option').length,
  wrappedGroup: !!document.querySelector('#atCp optgroup[label^="Wrapped"]'),
  disabled: document.querySelectorAll('#atCp option[disabled]').length,
  onIt: new Set(DB.participants.filter((p) => p.creatorId === document.title && false)).size
}));
const onCount = await p.evaluate((id) => new Set(DB.participants.filter((x) => x.creatorId === id).map((x) => x.campaignId)).size, CR);
ok('every campaign is listed, wrapped ones included', counts.opts === counts.all && counts.wrappedGroup, counts.opts + ' of ' + counts.all);
ok('campaigns the creator is already on are shown but disabled', counts.disabled === onCount, counts.disabled + ' vs ' + onCount);

const target = await p.evaluate((id) => {
  const on = new Set(DB.participants.filter((x) => x.creatorId === id).map((x) => x.campaignId));
  const w = DB.campaigns.find((c) => c.status === 'wrapped' && !on.has(c.id));
  return w ? { id: w.id, brand: w.brand } : null;
}, CR);
ok('there is a wrapped campaign to add to', !!target);
if (target) {
  await p.fill('#atFind', target.brand.slice(0, 4));
  await p.waitForTimeout(200);
  ok('the search narrows the list', await p.evaluate(() =>
    [...document.querySelectorAll('#atCp option')].some((o) => o.hidden)
    || document.querySelectorAll('#atCp option').length <= 1));
  await p.selectOption('#atCp', target.id);
  await p.click('#atGo'); await p.waitForTimeout(400);
  ok('adding to a wrapped campaign works', await p.evaluate(([id, cp]) =>
    DB.participants.some((x) => x.creatorId === id && x.campaignId === cp && x.stage === 'sourced'), [CR, target.id]));
}

/* ========================= 1. booking edits ========================= */

const CP = seedObj.db.campaigns[0].id;
const sc = (await api('/api/booking/schedule', { campaignId: CP, timezone: 'Asia/Seoul', venueName: 'Test venue',
  maxPartySize: 3, deadlineHours: 1, slotMinutes: 60 })).body.schedule;
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const sA = (await api('/api/booking/slot', { scheduleId: sc._id, date: day(9), time: '12:00', capacity: 4 })).body.slot;
const sB = (await api('/api/booking/slot', { scheduleId: sc._id, date: day(9), time: '15:00', capacity: 2 })).body.slot;
const sC = (await api('/api/booking/slot', { scheduleId: sc._id, date: day(10), time: '12:00', capacity: 2 })).body.slot;
const pub = (slotId, h, n) => api('/api/book/' + sc.publicToken + '/confirm', { slotId, name: h, handle: '@' + h, partySize: n || 1 });
await pub(sA._id, 'guest_one', 1);
await pub(sA._id, 'guest_two', 2);
await pub(sB._id, 'guest_three', 1);
await pub(sC._id, 'guest_four', 1);
const bk = (h) => col('campaign_bookings').findOne({ 'guest.handleNorm': h });
const slotRow = (id) => col('booking_slots').findOne({ _id: id });

await go('campaigns/' + CP + '/booking');
await p.waitForSelector('[data-date-row]', { timeout: 8000 });
ok('both dates are listed', (await p.$$('[data-date-row]')).length === 2);
ok('each date can be deleted', (await p.$$('[data-delday]')).length === 2);
ok('each booking has Edit, Move and Cancel', (await p.$$('[data-editbk]')).length === 4
  && (await p.$$('[data-move]')).length === 4);

/* edit a slot: new time, more seats */
await p.click(`[data-date-row="${day(9)}"] td:first-child`);
await p.waitForSelector(`[data-editslot="${sA._id}"]`, { timeout: 5000 });
ok('a booked slot\'s Delete is no longer greyed out', !(await p.isDisabled(`[data-delslot="${sA._id}"]`)));
await p.click(`[data-editslot="${sA._id}"]`);
await p.waitForSelector('#esSave', { timeout: 5000 });
ok('the slot editor says the bookings move with it', (await drawerText()).includes('2 bookings on this slot will move'));
await p.fill('#esTime', '12:30');
await p.fill('#esCap', '5');
await p.click('#esSave'); await p.waitForTimeout(900);
const sA2 = await slotRow(sA._id);
ok('the slot moved to 12:30 with 5 seats', sA2.time === '12:30' && sA2.capacity === 5);
ok('its bookings moved with it', (await bk('guest_one')).time === '12:30' && (await bk('guest_two')).time === '12:30');
ok('the board shows the new time', (await p.textContent('#view')).includes('12:30'));

/* edit one booking: people and a note */
const g1 = await bk('guest_one');
await p.click(`[data-editbk="${g1._id}"]`);
await p.waitForSelector('#ebSave', { timeout: 5000 });
await p.fill('#ebParty', '3');
await p.fill('#ebNote', 'needs parking');
await p.click('#ebSave'); await p.waitForTimeout(900);
ok('a booking\'s people and note are saved', (await bk('guest_one')).partySize === 3 && (await bk('guest_one')).staffNote === 'needs parking');
ok('the extra seats are taken from the slot', (await slotRow(sA._id)).booked === 5);
ok('the note shows on the board', (await p.textContent('#view')).includes('needs parking'));

/* cancel one booking from its editor */
const g3 = await bk('guest_three');
await p.click(`[data-editbk="${g3._id}"]`);
await p.waitForSelector('#ebCancel', { timeout: 5000 });
await p.click('#ebCancel'); await p.waitForTimeout(900);
ok('a booking can be cancelled from its editor', (await bk('guest_three')).status === 'cancelled'
  && (await slotRow(sB._id)).booked === 0);

/* delete a slot that still has bookings */
await p.waitForSelector(`[data-delslot="${sA._id}"]`, { timeout: 5000 }).catch(async () => {
  await p.click(`[data-date-row="${day(9)}"] td:first-child`);
});
await p.waitForSelector(`[data-delslot="${sA._id}"]`, { timeout: 5000 });
await p.click(`[data-delslot="${sA._id}"]`); await p.waitForTimeout(900);
ok('a slot with bookings is deleted after confirming', !(await slotRow(sA._id)));
ok('its bookings are cancelled, not lost', (await bk('guest_one')).status === 'cancelled' && (await bk('guest_two')).status === 'cancelled');

/* delete a whole day */
await p.click(`[data-delday="${day(10)}"]`); await p.waitForTimeout(900);
ok('a whole day is deleted', !(await slotRow(sC._id)) && (await bk('guest_four')).status === 'cancelled');
ok('and is gone from the board', !(await p.$(`[data-date-row="${day(10)}"]`)));

ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
await b.close(); srv.close();
console.log(errs.length ? '\n' + errs.length + ' FAILED' : '\nall staff edit checks passed');
process.exit(errs.length ? 1 : 0);
