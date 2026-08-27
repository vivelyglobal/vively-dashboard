import { chromium } from 'playwright';
import fs from 'fs';
const seed = fs.readFileSync('tmp/seed.json', 'utf8');
const FAKE = 'http://127.0.0.1:3455';
await fetch(FAKE + '/__reset', { method: 'POST' });
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext();
await ctx.addInitScript(([s]) => {
  localStorage.setItem('vively-workspace-v1', s);
  localStorage.setItem('vively-auth-user-v1', JSON.stringify({ email: 'k@v.com', name: 'K' }));
}, [seed]);
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
await p.goto('http://localhost:3120/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1400);
await p.evaluate(() => { location.hash = '#/campaigns/all/calendar'; });
await p.waitForTimeout(700);

const step = async (n, fn) => { try { await fn(); console.log('ok   ' + n); } catch (e) { console.log('FAIL ' + n + ' — ' + e.message); errs.push(n); } };

await step('the form opens with every field asked for', async () => {
  await p.click('#gcAppt');
  await p.waitForTimeout(400);
  for (const id of ['#apTitle', '#apDate', '#apEndDate', '#apStart', '#apEnd', '#apLocation', '#apDesc', '#apCampaign', '#apTz'])
    if (!await p.$(id)) throw new Error('missing ' + id);
});

await step('it refuses an end time before the start', async () => {
  await p.fill('#apTitle', 'Backwards');
  await p.fill('#apDate', '2026-10-01');
  await p.fill('#apStart', '15:00');
  await p.fill('#apEnd', '09:00');
  await p.click('#apSave');
  await p.waitForTimeout(300);
  const w = await p.$eval('#apWarn', (e) => e.innerText);
  if (!/not after the start/i.test(w)) throw new Error('accepted it: ' + w);
});

await step('it refuses a timezone it cannot resolve', async () => {
  await p.fill('#apEnd', '17:00');
  await p.fill('#apTz', 'Mars/Olympus');
  await p.click('#apSave');
  await p.waitForTimeout(300);
  const w = await p.$eval('#apWarn', (e) => e.innerText);
  if (!/not a timezone/i.test(w)) throw new Error('accepted it: ' + w);
});

await step('a good appointment saves', async () => {
  await p.fill('#apTz', 'Asia/Seoul');
  await p.fill('#apTitle', 'Guryonggak — venue walkthrough');
  await p.fill('#apLocation', '서울 강남구 테헤란로 123');
  await p.fill('#apDesc', 'Meet the manager, check the counter lighting');
  await p.click('#apSave');
  await p.waitForTimeout(600);
  const rows = await p.$$eval('[data-appt]', (n) => n.map((x) => x.innerText.replace(/\s+/g, ' ')));
  if (!rows.some((r) => /venue walkthrough/.test(r))) throw new Error('not listed: ' + JSON.stringify(rows));
});

await step('it reaches Google with its address and time intact', async () => {
  await p.click('#gcSync');
  await p.waitForTimeout(2600);
  const s = await (await fetch(FAKE + '/__state')).json();
  const ev = s.events.find((e) => /venue walkthrough/.test(e.summary || ''));
  if (!ev) throw new Error('not on the calendar');
  if (ev.location !== '서울 강남구 테헤란로 123') throw new Error('location: ' + ev.location);
  if (ev.start.dateTime !== '2026-10-01T15:00:00+09:00') throw new Error('start: ' + ev.start.dateTime);
  if (ev.end.dateTime !== '2026-10-01T17:00:00+09:00') throw new Error('end: ' + ev.end.dateTime);
  if (!/lighting/.test(ev.description || '')) throw new Error('description lost');
});

await step('editing it moves the same event rather than adding one', async () => {
  const before = (await (await fetch(FAKE + '/__state')).json()).count;
  await p.click('[data-appt]:has-text("venue walkthrough")');
  await p.waitForTimeout(400);
  await p.fill('#apStart', '11:00'); await p.fill('#apEnd', '12:30');
  await p.click('#apSave');
  await p.waitForTimeout(500);
  await p.click('#gcSync');
  await p.waitForTimeout(2600);
  const s = await (await fetch(FAKE + '/__state')).json();
  if (s.count !== before) throw new Error(`${before} -> ${s.count}`);
  const ev = s.events.find((e) => /venue walkthrough/.test(e.summary || ''));
  if (ev.start.dateTime !== '2026-10-01T11:00:00+09:00') throw new Error('did not move: ' + ev.start.dateTime);
});

await step('deleting it takes the event off Google too', async () => {
  const before = (await (await fetch(FAKE + '/__state')).json()).count;
  await p.click('[data-appt]:has-text("venue walkthrough")');
  await p.waitForTimeout(400);
  await p.click('#apDelete');
  await p.waitForTimeout(900);
  const s = await (await fetch(FAKE + '/__state')).json();
  if (s.count !== before - 1) throw new Error(`${before} -> ${s.count}`);
});

console.log('\nerrors:', errs.length ? errs.join(', ') : 'none');
await b.close();
process.exit(errs.length ? 1 : 0);
