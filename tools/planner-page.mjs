/* The Planner tab, driven the way a person drives it.

   One campaign is built into the seed workspace with a queue that has
   been waiting, visits in the past and the future, a blacklisted
   creator, a double booking on another campaign and a post that never
   arrived — so every number in the header has something to count. */

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'tmp/seed.json'), 'utf8'));
const errs = [];
const ok = (n, cond, extra) => {
  if (cond) console.log('ok   ' + n + (extra ? '   ' + extra : ''));
  else { console.log('FAIL ' + n + (extra ? '   ' + extra : '')); errs.push(n); }
};

const db = seed.db;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const DAY = 86400000;
const day = (n) => iso(Date.now() + n * DAY);

/* ---- a campaign of our own, so the seed's own rows cannot skew a count ---- */
const CP = 'cpPL';
db.campaigns.push({ ...db.campaigns[0], id: CP, brand: 'Sushikoji', name: 'counter visit', status: 'live',
  targetCreators: 6, deliverables: '1 Reel + 3 stories', notionDatabaseId: '', partner: null, start: day(-7), end: day(21) });
const mkCr = (id, handle, extra) => db.creators.push(Object.assign({ ...db.creators[0], id, handle,
  name: handle.slice(1), followers: 12000, er: 3.2, avgViews: 5000, flag: null, flagReason: '',
  campaignsDone: 0, phone: '', address: '', bank: '', campaignIds: [CP] }, extra || {}));
mkCr('plA', '@pl_alpha', { campaignsDone: 3 });
mkCr('plB', '@pl_beta', { flag: 'blocked', flagReason: 'no-show in June' });
mkCr('plC', '@pl_gamma', { flag: 'caution', flagReason: 'late twice' });
mkCr('plD', '@pl_delta');
mkCr('plE', '@pl_eps');
mkCr('plF', '@pl_zeta');

const part = (o) => db.participants.push(Object.assign({ campaignId: CP, stage: 'sourced', fee: 0, revisions: 0,
  content: null, headcount: '', note: '', source: 'Notion form' }, o));
part({ id: 'plw1', creatorId: 'plA', stage: 'sourced', appliedAt: day(-9) });        /* oldest, repeat creator */
part({ id: 'plw2', creatorId: 'plD', stage: 'sourced', appliedAt: day(-1) });
part({ id: 'plw3', creatorId: 'plB', stage: 'replied', appliedAt: day(-4) });        /* blacklisted applicant */
part({ id: 'plw4', creatorId: 'plF', stage: 'sourced', appliedAt: day(-3), visitAt: day(2) + ' 12:00' });
part({ id: 'plc1', creatorId: 'plC', stage: 'confirmed', confirmedVisitAt: day(1) + ' 12:00', headcount: '2', remark: '알레르기: 새우' });
part({ id: 'plc2', creatorId: 'plE', stage: 'confirmed', confirmedVisitAt: day(1) + ' 18:30' });
part({ id: 'plc3', creatorId: 'plA', stage: 'confirmed', confirmedVisitAt: day(-9) + ' 12:00' });  /* overdue post */
part({ id: 'plc4', creatorId: 'plD', stage: 'confirmed' });                                        /* no date */
/* pl_alpha worked on another campaign before — that is what a repeat is */
part({ id: 'plp1', campaignId: db.campaigns[0].id, creatorId: 'plA', stage: 'live' });
/* the same creator, another campaign, the same day — the clash */
part({ id: 'plx1', campaignId: db.campaigns[0].id, creatorId: 'plC', stage: 'confirmed', confirmedVisitAt: day(1) + ' 19:00' });

const app = express();
app.use(express.json({ limit: '10mb' }));
app.get('/api/me', (q, r) => r.json({ user: { email: 'k@v.com', name: 'Harness' }, staff: true }));
let WS = { db, settings: {}, savedAt: new Date().toISOString(), revision: 4 };
let saved = null, metaRevision = 4;
app.get('/api/workspace', (q, r) => r.json({ ok: true, data: WS }));
app.get('/api/workspace/meta', (q, r) => r.json({ ok: true, revision: metaRevision, savedAt: WS.savedAt }));
app.post('/api/workspace', (q, r) => {
  saved = q.body; WS = { ...WS, db: (q.body || {}).db || WS.db, revision: WS.revision + 1 };
  r.json({ ok: true, savedAt: new Date().toISOString(), revision: WS.revision });
});
/* booking is not set up for this campaign: the planner must work without it */
app.get('/api/booking/campaign/:id', (q, r) => r.json({ ok: true, schedule: null, slots: [], bookings: [], invites: [] }));
app.use(express.static(ROOT));
app.get('*', (q, r) => r.sendFile(path.join(ROOT, 'index.html')));
const srv = app.listen(0);
await new Promise((r) => srv.once('listening', r));
const BASE = 'http://127.0.0.1:' + srv.address().port;

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
await ctx.addInitScript(() => localStorage.setItem('vively-auth-user-v1', JSON.stringify({ email: 'k@v.com', name: 'K' })));
const p = await ctx.newPage();
const pageErrors = [];
p.on('pageerror', (e) => pageErrors.push(e.message));
p.on('dialog', (d) => d.accept());
const go = async (hash) => { await p.goto(BASE + '/#/blank'); await p.goto(BASE + '/#/' + hash); await p.waitForTimeout(800); };
const text = async (sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ');
const stage = (id) => p.evaluate((pid) => (DB.participants.find((x) => x.id === pid) || {}).stage, id);
const field = (id, f) => p.evaluate(([pid, k]) => (DB.participants.find((x) => x.id === pid) || {})[k], [id, f]);

/* ---- it is what a campaign opens on ---- */
await go('campaigns/' + CP);
await p.waitForSelector('.planner-grid', { timeout: 8000 });
ok('a campaign opens on the Planner', await p.isVisible('.planner-grid'));
const tabs = await p.$$eval('#tabbar a, #tabbar button', (els) => els.map((e) => e.textContent.trim()));
ok('Planner is the first tab', tabs[0] === 'Planner', tabs.slice(0, 4).join(' · '));
ok('the board is still there, one tab along', tabs.includes('Roster & pipeline'));

/* ---- the five numbers ---- */
const head = await text('#cpTab');
ok('it counts who is waiting and how long the oldest has', /Waiting on you 4/.test(head) && /oldest 9 days/.test(head), head.slice(0, 200));
ok('it counts confirmed against the target', /Confirmed 4 \/ 6/.test(head));
ok('it names the one with no date', /1 without a date/.test(head));
ok('it counts the visits in the next seven days', /Visits next 7 days 2/.test(head));
ok('it counts posts and overdue ones', /Posted 0 \/ 4/.test(head) && /1 overdue/.test(head));
ok('needs attention adds the overdue, the undated and the blacklisted', /Needs attention 3/.test(head), String(head.match(/Needs attention \d+/)));

/* ---- warnings ---- */
ok('the blacklisted creator is called out at the top', head.includes('blacklisted creator') && head.includes('@pl_beta'));
ok('the double booking is called out', /also booked on/.test(head) && head.includes('@pl_gamma'));

/* ---- the queue ---- */
const applied = await text('#plApplied');
ok('the queue is oldest first', applied.indexOf('@pl_alpha') < applied.indexOf('@pl_delta'));
ok('each row says how long they have waited', /9d waiting/.test(applied) && /1d waiting/.test(applied));
ok('a long wait is marked, a short one is not',
  (await p.$$('#plApplied .pl-age.hot')).length >= 1 && (await p.$$('#plApplied .pl-age.warm')).length >= 1);
ok('a repeat creator is marked in the queue', (await p.$$('#plApplied .mark.repeat')).length === 1);
ok('a blacklisted applicant cannot be confirmed by accident',
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('#plApplied .pl-item')].find((r) => r.textContent.includes('@pl_beta'));
    return !!row && !row.querySelector('[data-plconfirm]') && !!row.querySelector('[data-plstage="dropped"]');
  }));
ok('what they asked for is on the card', applied.includes('asked for ' + day(2)));

/* ---- deciding ---- */
await p.click('[data-plstage="shortlisted"][data-pid="plw2"]');
await p.waitForTimeout(500);
ok('Shortlist moves them out of the queue', (await stage('plw2')) === 'shortlisted'
  && !(await text('#plApplied')).includes('@pl_delta'));
await p.click('[data-pltab="shortlisted"]'); await p.waitForTimeout(400);
ok('and into the shortlisted tab', (await text('#plApplied')).includes('@pl_delta'));
await p.click('[data-pltab="waiting"]'); await p.waitForTimeout(400);

/* bulk */
await p.check('[data-plsel="plw1"]'); await p.waitForTimeout(300);
await p.check('[data-plsel="plw3"]'); await p.waitForTimeout(300);
ok('selecting rows opens the bulk bar', (await text('#plApplied')).includes('2 selected'));
await p.click('[data-plbulk="dropped"]'); await p.waitForTimeout(600);
ok('a bulk decline moves both at once', (await stage('plw1')) === 'dropped' && (await stage('plw3')) === 'dropped');
ok('and the selection clears itself', !(await text('#plApplied')).includes('selected'));

/* keyboard */
await p.keyboard.press('j'); await p.waitForTimeout(250);
ok('j focuses a row', (await p.$$('#plApplied .pl-item.focus')).length === 1);
await p.keyboard.press('s'); await p.waitForTimeout(500);
ok('s shortlists the focused row', (await stage('plw4')) === 'shortlisted');

/* ---- confirming puts them on a day ---- */
await p.click('[data-pltab="shortlisted"]'); await p.waitForTimeout(400);
await p.click('[data-plconfirm="plw4"]');
await p.waitForSelector('#pcDate', { timeout: 5000 });
ok('the confirm drawer starts from the date they asked for', (await p.inputValue('#pcDate')) === day(2));
await p.fill('#pcTime', '13:30');
await p.fill('#pcHead', '3');
await p.click('#pcGo'); await p.waitForTimeout(800);
ok('confirming books the visit', (await stage('plw4')) === 'confirmed'
  && (await field('plw4', 'confirmedVisitAt')) === day(2) + ' 13:30' && (await field('plw4', 'headcount')) === '3');
ok('and the calendar jumps to that day',
  (await p.$$eval('#plCalCard strong[title]', (els) => els.map((e) => e.getAttribute('title')))).includes(day(2)));

/* ---- the day, and who turned up ---- */
await p.click(`[data-plday="${day(1)}"]`); await p.waitForTimeout(600);
const agenda = await text('#plCalCard');
ok('a day shows its sittings and who is in them', agenda.includes('12:00') && agenda.includes('@pl_gamma') && agenda.includes('18:30'));
ok('the flagged creator is marked in the day too', (await p.$$('#plCalCard .pl-visit.flagged-caution')).length === 1);
ok('clicking a day filters the confirmed list to it', (await text('#plConfirmed')).includes('showing ' + day(1)));
await p.click('[data-platt="attended"][data-pid="plc1"]'); await p.waitForTimeout(600);
ok('attendance is recorded on the day', (await field('plc1', 'attendance')) === 'attended' && !!(await field('plc1', 'attendanceAt')));
ok('and shows on the card', (await text('#plCalCard')).includes('Attended'));
await p.click('[data-platt="attended"][data-pid="plc1"]'); await p.waitForTimeout(600);
ok('pressing it again takes it back', (await field('plc1', 'attendance')) === '');

/* ---- who owes a post ---- */
await p.click('#plAllDays'); await p.waitForTimeout(500);
const conf = await text('#plConfirmed');
ok('the undated are pinned to the top in their own group',
  (await p.$$eval('#plConfirmed .pl-group', (els) => els[0].textContent.trim())).startsWith('No date yet'));
ok('an old visit with no post reads as overdue', /No post · 9d since the visit/.test(conf));
ok('a visit still to come reads as booked', /Visit booked/.test(conf));

/* ---- the venue's sheet ---- */
await p.click(`[data-plday="${day(1)}"]`); await p.waitForTimeout(500);
await p.click('#plSheet');
await p.waitForSelector('#dsText', { timeout: 5000 });
const sheet = await p.textContent('#dsText');
ok('the day sheet is in Korean, with names, times and head counts',
  sheet.includes('방문 명단') && sheet.includes('12:00') && sheet.includes('@pl_gamma') && sheet.includes('2명'));
ok('it carries the note the venue needs', sheet.includes('알레르기: 새우'));
ok('it totals the day', /총 2팀 \/ 3명/.test(sheet));
await p.keyboard.press('Escape'); await p.waitForTimeout(300);

/* ---- is what I am looking at still true ---- */
ok('the page says when it was read', (await text('#cpTab')).includes('Read'));
metaRevision = 99;
await p.click('#plRefresh'); await p.waitForTimeout(2000);
ok('and warns when somebody else has saved since', (await text('#cpTab')).includes('Someone else has saved'));
/* refreshing replaces the workspace with the server's copy — anything
   decided in the last two seconds must go up before it does */
ok('refreshing saves what was decided before it reloads',
  !!saved && (saved.db.participants || []).some((x) => x.id === 'plw1' && x.stage === 'dropped'),
  saved ? JSON.stringify((saved.db.participants || []).filter((x) => x.id === 'plw1').map((x) => x.stage)) : 'no save');

/* ---- nothing was done behind anyone's back ---- */
await p.waitForTimeout(3200);        /* the autosave debounce is two seconds */
ok('the decisions reached the workspace', !!saved && await (async () => {
  const rows = (saved.db.participants || []).filter((x) => x.campaignId === CP);
  const by = (id) => rows.find((x) => x.id === id) || {};
  return by('plw1').stage === 'dropped' && by('plw4').stage === 'confirmed' && by('plc1').attendance === '';
})());
ok('no creator or campaign was created along the way',
  await p.evaluate((n) => DB.creators.length === n, db.creators.length));
ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await b.close(); srv.close();
console.log(errs.length ? '\n' + errs.length + ' FAILED' : '\nall planner checks passed');
process.exit(errs.length ? 1 : 0);
