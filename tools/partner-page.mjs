/* Serves partner.html against the REAL buildPartnerRows, with Mongo replaced
   by the seeded workspace, and drives the page in a browser. */
import express from 'express';
import fs from 'fs';
import vm from 'vm';
import { chromium } from 'playwright';

const seed = JSON.parse(fs.readFileSync('tmp/seed.json', 'utf8')).db;
const src = fs.readFileSync('server.js', 'utf8');
const ctx = vm.createContext({ Object, String, Set, RegExp, Math, console });
vm.runInContext(src.slice(src.indexOf('const PARTNER_STATUS = {'), src.indexOf('async function partnerCommentsCollection')) +
  '\nthis.api = { buildPartnerRows };', ctx);
const { buildPartnerRows } = ctx.api;

const comments = [];
const app = express();
app.use(express.json());
const resolve = (t) => (seed.partnerLinks.find((l) => l.token === t && !l.revokedAt) || {}).partner || null;

app.get('/api/partner/:token', (q, r) => {
  const partner = resolve(q.params.token);
  if (!partner) return r.status(404).json({ error: 'This link is not valid, or has been turned off.' });
  const payload = buildPartnerRows(seed, partner);
  payload.comments = comments.filter((c) => c.partner === partner);
  payload.updatedAt = new Date().toISOString();
  r.json({ ok: true, ...payload });
});
app.post('/api/partner/:token/comment', (q, r) => {
  const partner = resolve(q.params.token);
  if (!partner) return r.status(404).json({ error: 'not valid' });
  const known = buildPartnerRows(seed, partner).rows.some((x) => x.pid === q.body.pid);
  if (!known) return r.status(400).json({ error: 'Unknown row.' });
  const c = { partner, pid: q.body.pid, text: q.body.text, author: q.body.author || 'Partner', at: new Date().toISOString() };
  comments.push(c); r.json({ ok: true, comment: c });
});
app.get('/partner/:token', (q, r) => r.sendFile(process.cwd() + '/partner.html'));
const srv = app.listen(3199);

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
/* the revoked- and invalid-link steps deliberately provoke a 404 */
let expect404 = false;
p.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (/404/.test(m.text()) && (expect404 || /favicon/.test(m.location().url || ''))) return;
  errs.push('CONSOLE: ' + m.text());
});
const step = async (n, fn) => { try { await fn(); console.log('ok   ' + n); } catch (e) { console.log('FAIL ' + n + ' — ' + e.message); errs.push(n); } };

await p.goto('http://localhost:3199/partner/tok-splabab-test', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(900);

await step('the page loads and names the partner', async () => {
  const t = await p.$eval('#title', (e) => e.textContent);
  if (!/SPLABAB/.test(t)) throw new Error(t);
});

await step('it shows only SPLABAB campaigns', async () => {
  const chips = await p.$$eval('.chip', (n) => n.map((x) => x.textContent));
  if (chips.includes('Glowbe')) throw new Error('a campaign belonging to another partner is listed: ' + chips.join(','));
  if (!chips.includes('Sushikoji') || !chips.includes('Juno Seoul')) throw new Error(chips.join(','));
});

await step('nothing sensitive is anywhere in the delivered page', async () => {
  const html = await p.content();
  for (const secret of ['INTERNAL ONLY', '비밀주소', '110-234-5678', 'payout', 'Glowbe'])
    if (html.includes(secret)) throw new Error(`"${secret}" is present in the page`);
});

await step('the columns the POC asked for are all there', async () => {
  const heads = await p.$$eval('th', (n) => n.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  for (const want of ['크리에이터', '방문 일정', '예약 시간', '인원수', 'Email', 'IG 팔로워수', '성별', '국적', '참고', 'Notes'])
    if (!heads.some((h) => h.includes(want))) throw new Error('missing column: ' + want + ' | ' + heads.join(' / '));
  for (const gone of ['Kakao', 'Message'])
    if (heads.some((h) => h.includes(gone))) throw new Error(gone + ' should have been removed');
});

await step('the table is not skewed by the removed columns', async () => {
  const heads = await p.$$eval('thead th', (n) => n.length);
  const cells = await p.$$eval('tbody tr:not(.thread)', (rows) =>
    [...new Set(rows.map((r) => r.querySelectorAll('td').length))]);
  if (cells.length !== 1 || cells[0] !== heads)
    throw new Error(`${heads} headers vs ${JSON.stringify(cells)} cells per row`);
});

await step('no creator awaiting approval appears anywhere', async () => {
  const withheld = await p.evaluate(() => DATA.withheld);
  if (!withheld) throw new Error('the seed has no withheld rows, so this would prove nothing');
  const labels = await p.evaluate(() => DATA.rows.map((r) => r.status.en));
  if (labels.includes('Waiting Approval')) throw new Error('a Waiting Approval row is in the list');
  const shown = await p.$$eval('tbody tr', (n) => n.length);
  console.log(`     (${withheld} withheld, ${shown} shown)`);
});

await step('a withheld creator is not in the payload at all', async () => {
  const raw = await p.evaluate(() => JSON.stringify(DATA));
  if (/WITHHELD-MARKER/.test(raw)) throw new Error('a withheld row reached the browser');
  const html = await p.content();
  if (/WITHHELD-MARKER/.test(html)) throw new Error('a withheld row is in the page source');
});

await step('인원수 is shown, so a table can be held for the right number', async () => {
  const counts = await p.evaluate(() => DATA.rows.map((r) => r.headcount).filter(Boolean));
  if (!counts.length) throw new Error('no headcounts in the payload');
  const text = await p.$eval('table', (e) => e.innerText);
  if (!text.includes(counts[0])) throw new Error('the headcount is not in the table');
});

await step('참고 from the Notion Remark column is shown', async () => {
  const text = await p.$eval('table', (e) => e.innerText);
  if (!/2명 방문 예정/.test(text)) throw new Error('the remark is not on the page');
});

await step('filtering by campaign narrows the list', async () => {
  const before = await p.$$eval('tbody tr', (n) => n.length);
  await p.click('.chip:not(.on)');
  await p.waitForTimeout(400);
  const after = await p.$$eval('tbody tr', (n) => n.length);
  if (!(after < before)) throw new Error(`${before} -> ${after}`);
  await p.click('.chip');
  await p.waitForTimeout(300);
});

await step('a comment can be left and comes back on the row', async () => {
  await p.click('.cbtn');
  await p.waitForTimeout(300);
  await p.fill('[data-name]', '김POC');
  await p.fill('[data-t]', '이 크리에이터 확인 부탁드립니다');
  await p.click('.send');
  await p.waitForTimeout(600);
  const txt = await p.$eval('.thread', (e) => e.innerText);
  if (!/김POC/.test(txt) || !/확인 부탁/.test(txt)) throw new Error(txt.slice(0, 120));
});

expect404 = true;
await step('a revoked link stops working', async () => {
  await p.goto('http://localhost:3199/partner/tok-revoked-test', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(700);
  const t = await p.$eval('#body', (e) => e.innerText);
  if (!/valid|turned off/i.test(t)) throw new Error(t);
});

await step('a made-up link shows nothing', async () => {
  await p.goto('http://localhost:3199/partner/not-a-real-token', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(700);
  const t = await p.$eval('#body', (e) => e.innerText);
  if (!/valid|turned off/i.test(t)) throw new Error(t);
});

await step('one partner cannot comment on another partner\'s row', async () => {
  const other = buildPartnerRows(seed, 'OTHERCO').rows[0];
  const res = await fetch('http://localhost:3199/api/partner/tok-splabab-test/comment', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: other.pid, text: 'should be refused' })
  });
  if (res.status !== 400) throw new Error('accepted with status ' + res.status);
});

/* ---- what the partner is actually booking against ---------------------
   The payload is built server-side, in its own copy of the rules. The
   dashboard's copy was taught to prefer a confirmed time and this one
   was not, so a booking someone moved by hand went on showing the
   creator's original request — to the one audience that turns it into
   a table reservation. These read through the server. */

await step('the partner sees the confirmed time, not what the creator asked for', async () => {
  const row = seed.participants.find((x) => x.confirmedVisitAt);
  if (!row) throw new Error('the seed has no rescheduled booking to check');
  const [date, time] = row.confirmedVisitAt.split(' ');
  const [wasDate, wasTime] = row.visitAt.split(' ');

  const payload = buildPartnerRows(seed, 'SPLABAB');
  const got = payload.rows.find((r) => r.pid === row.id);
  if (!got) throw new Error('the rescheduled row is not in the partner payload at all');
  if (got.visitDate !== date || got.visitTime !== time)
    throw new Error(`payload says ${got.visitDate} ${got.visitTime}, confirmed is ${date} ${time}`);
  if (got.visitDate === wasDate && got.visitTime === wasTime)
    throw new Error('it is still showing the original request');

  /* and on the page itself, not just in the JSON */
  await p.goto('http://localhost:3199/partner/tok-splabab-test', { waitUntil: 'networkidle' });
  const text = await p.$eval('body', (e) => e.innerText);
  if (!text.includes(date)) throw new Error(`the page never shows ${date}`);
});

await step('the old time is gone from the page, not sitting beside the new one', async () => {
  const row = seed.participants.find((x) => x.confirmedVisitAt);
  const text = await p.$eval('body', (e) => e.innerText);
  const [wasDate] = row.visitAt.split(' ');
  const [nowDate] = row.confirmedVisitAt.split(' ');
  /* only meaningful when the two fall on different days, which the
     fixture guarantees — two dates for one booking is worse than one
     wrong date, because nobody knows which to trust */
  if (wasDate !== nowDate && text.includes(wasDate))
    throw new Error(`both ${wasDate} and ${nowDate} are on screen`);
});

await step('a post stored in the library still reaches the partner', async () => {
  /* content used to hang off the roster row; it now lives in
     db.socialContent, and the server was still reading the old place */
  const rec = (seed.socialContent || [])[0];
  if (!rec) throw new Error('the seed has no split-out post to check');
  const got = buildPartnerRows(seed, 'SPLABAB').rows.find((r) => r.pid === rec.participantId);
  if (!got) throw new Error('that row is not in the partner payload');
  if (!got.contentUrl) throw new Error('the video link is empty — the server is reading the old shape');
  if (got.contentUrl !== (rec.url || rec.postUrl))
    throw new Error(`got ${got.contentUrl}, expected ${rec.url || rec.postUrl}`);
});

console.log('\nerrors:', errs.length ? '\n  ' + errs.join('\n  ') : 'none');
await b.close(); srv.close();
process.exit(errs.length ? 1 : 0);
