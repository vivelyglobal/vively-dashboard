/* The cases a naive dedup gets wrong. */
import { chromium } from 'playwright';
import fs from 'fs';
const seed = JSON.parse(fs.readFileSync('tmp/seed.json', 'utf8'));
const APP = 'http://localhost:3120/';
const FAKE = 'http://127.0.0.1:3455';
const state = async () => (await fetch(FAKE + '/__state')).json();

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errs = [];

async function session(workspace) {
  const ctx = await b.newContext();
  await ctx.addInitScript(([s]) => {
    localStorage.setItem('vively-workspace-v1', s);
    localStorage.setItem('vively-auth-user-v1', JSON.stringify({ email: 'k@v.com', name: 'K' }));
  }, [JSON.stringify(workspace)]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  await p.goto(APP, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1400);
  await p.evaluate(() => { location.hash = '#/campaigns/all/calendar'; });
  await p.waitForTimeout(700);
  return { p, ctx };
}
async function sync(p) { await p.click('#gcSync'); await p.waitForTimeout(2500); }
const notes = (p) => p.$$eval('#view .note', (n) => n.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));

/* ---- 1. a first sync from clean ---- */
await fetch(FAKE + '/__reset', { method: 'POST' });
let s1 = await session(seed);
await sync(s1.p);
const base = await state();
console.log('1. first sync                  :', base.count, 'events');
/* capture what the app stored, the way a real save would */
const saved = await s1.p.evaluate(() => JSON.parse(localStorage.getItem('vively-workspace-v1')));
await s1.ctx.close();

/* ---- 2. the workspace is lost; every stored google id goes with it ---- */
const wiped = JSON.parse(JSON.stringify(saved));
let stripped = 0;
wiped.db.participants.forEach((p) => { if (p.googleEventId) { delete p.googleEventId; delete p.googleSyncedAt; delete p.googleLink; stripped++; } });
wiped.db.appointments.forEach((a) => { if (a.googleEventId) { delete a.googleEventId; delete a.googleSyncedAt; delete a.googleLink; stripped++; } });
let s2 = await session(wiped);
await sync(s2.p);
const afterWipe = await state();
console.log(`2. after losing all ${String(stripped).padStart(2)} stored ids:`, afterWipe.count, 'events',
  afterWipe.count === base.count ? '— PASS, found its own events' : '— FAIL, duplicated');
await s2.ctx.close();

/* ---- 3. someone moves an event in Google ---- */
const victim = afterWipe.events.find((e) => e.extendedProperties.private.vivelyKind === 'visit');
await fetch(FAKE + '/__seed', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(Object.assign({}, victim, {
    start: { dateTime: '2027-01-01T09:00:00+09:00', timeZone: 'Asia/Seoul' },
    end: { dateTime: '2027-01-01T10:30:00+09:00', timeZone: 'Asia/Seoul' },
    updated: new Date(Date.now() + 600000).toISOString() })) });
let s3 = await session(saved);
await sync(s3.p);
const afterEdit = await state();
const moved = afterEdit.events.find((e) => e.id === victim.id);
const flagged = (await notes(s3.p)).filter((n) => /changed in Google/i.test(n));
console.log('3. edited in Google            :', afterEdit.count, 'events;',
  moved.start.dateTime.startsWith('2027-01-01') ? 'PASS — not overwritten' : 'FAIL — overwritten');
console.log('   flagged to the user         :', flagged.length ? 'PASS — "' + flagged[0].slice(0, 110) + '…"' : 'FAIL — silent');
await s3.ctx.close();

/* ---- 4. a booking is cancelled here but its event is still there ---- */
const dropped = JSON.parse(JSON.stringify(saved));
const gone = dropped.db.participants.find((p) => p.visitAt && p.googleEventId);
gone.visitAt = '';
let s4 = await session(dropped);
await sync(s4.p);
const orphanNotes = (await notes(s4.p)).filter((n) => /still on the calendar/i.test(n));
const afterDrop = await state();
console.log('4. booking cancelled here      :', afterDrop.count, 'events still there (nothing auto-deleted)');
console.log('   flagged as orphan           :', orphanNotes.length ? 'PASS — "' + orphanNotes[0].slice(0, 110) + '…"' : 'FAIL — silent');
await s4.ctx.close();

/* ---- 5. rescheduled in the dashboard ----
   from a clean calendar, so this measures rescheduling and not the
   held-back event step 3 deliberately sabotaged */
await fetch(FAKE + '/__reset', { method: 'POST' });
const clean = await session(seed);
await sync(clean.p);
const freshSaved = await clean.p.evaluate(() => JSON.parse(localStorage.getItem('vively-workspace-v1')));
await clean.ctx.close();

const resched = JSON.parse(JSON.stringify(freshSaved));
const move = resched.db.participants.find((p) => /^\d{4}-/.test(p.visitAt || '') && p.googleEventId);
move.visitAt = '2026-12-24 11:30';
let s5 = await session(resched);
await sync(s5.p);
const afterResched = await state();
const ev = afterResched.events.find((e) => e.id === move.googleEventId);
console.log('5. rescheduled here            :', afterResched.count, 'events;',
  ev && ev.start.dateTime.startsWith('2026-12-24T11:30') ? 'PASS — moved in place, not duplicated' : 'FAIL — ' + (ev && ev.start.dateTime));
await s5.ctx.close();

console.log('\nerrors:', errs.length ? '\n  ' + errs.join('\n  ') : 'none');
await b.close();
process.exit(errs.length ? 1 : 0);
