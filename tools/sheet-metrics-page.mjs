/* Setup → Sheet metrics, in a browser.

   One master Sheet, one tab per campaign. This drives the panel the way
   an operator does: name a tab, see it mapped to a campaign, read the
   Sheet, look at the preview, apply — and then checks what was actually
   saved. Google is never contacted: the Sheet's CSV export is answered
   from here, so the run is the same every time.

   It also keeps the panel from being mistaken for Setup → Google Sheet,
   the workspace mirror whose Pull replaces everything. The two share no
   storage key and no code, and the panel says so on screen.

   The workspace is the usual seed plus one synthetic campaign (KOWORK),
   three synthetic creators and two roster rows. */

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'tmp/seed.json'), 'utf8'));
const errs = [];
const ok = (n, c, x) => {
  if (c) console.log('ok   ' + n + (x ? '   ' + x : ''));
  else { console.log('FAIL ' + n + (x ? '   ' + x : '')); errs.push(n); }
};

/* ---- the synthetic campaign ---- */
const db = seed.db;
const base = db.campaigns[0];
db.campaigns.push(Object.assign({}, base, { id: 'cpKW', brand: 'KOWORK', name: '', notionDatabaseId: '', partner: null }));
const mkCr = (id, handle) => Object.assign({}, db.creators[0], {
  id, handle, name: handle.slice(1), platform: 'Instagram', followers: 5000, er: 3, avgViews: 2000,
  phone: '', kakao: '', address: '', bank: '', campaignIds: ['cpKW']
});
db.creators.push(mkCr('crA', '@kw_alpha'), mkCr('crB', '@kw_beta'), mkCr('crC', '@kw_gamma'));
const mkPt = (id, creatorId) => ({ id, campaignId: 'cpKW', creatorId, stage: 'live', content: null });
db.participants.push(mkPt('ptA', 'crA'), mkPt('ptB', 'crB'));   /* gamma is on no roster */
db.socialContent.push({
  id: 'scA', participantId: 'ptA', campaignId: 'cpKW', creatorId: 'crA', platform: 'Instagram',
  platformPostId: 'ig_KWOLD1', postUrl: 'https://www.instagram.com/reel/KWOLD1/', url: 'https://www.instagram.com/reel/KWOLD1/',
  views: 5000, likes: 400, comments: 20, shares: 0, saves: 0, publishedAt: '2026-09-01',
  dataSource: 'manual', lastScrapedAt: '2026-09-10'
});
const counts0 = { creators: db.creators.length, participants: db.participants.length, campaigns: db.campaigns.length };

/* ---- the Sheet, as its CSV export ---- */
const H = 'deliverable_id,ci_id,influencer_id,type,post_url,posted_date,likes,comments,views,last_scraped_at,notes,cpe_expected,cpe_actual,cpv_expected,cpv_actual,shares,saves,reposts,post_er';
const KOWORK_CSV = [H,
  'D1,KWNEW9,kw_alpha,reel,https://www.instagram.com/reel/KWOLD1/,2026-09-02,450,,9000,2026-09-19,"line one\nline two",0.3,0.35,,,5,6,1,4.2',
  'D2,,@kw_beta,reel,https://www.instagram.com/reel/KWNEW1/,2026-09-05,80,4,1200,2026-09-19,,,,,,,,,',
  'D3,,kw_gamma,reel,https://www.instagram.com/reel/KWNEW2/,2026-09-06,1,1,10,2026-09-19,,,,,,,,,',
  'D4,,kw_nobody,reel,https://www.instagram.com/reel/KWNEW3/,2026-09-06,1,1,10,2026-09-19,,,,,,,,,',
  'D5,,kw_alpha,reel,https://www.instagram.com/kw_alpha/,2026-09-06,1,1,10,2026-09-19,,,,,,,,,'
].join('\n');

let saved = null;
const app = express(); app.use(express.json({ limit: '10mb' }));
app.get('/api/me', (q, r) => r.json({ user: { email: 'k@v.com', name: 'H' }, staff: true }));
/* The real server answers { ok, data: { db, … } }. A stub that spreads
   the workspace at the top level is read as "no workspace" and the page
   runs on an empty database — every check below would pass vacuously. */
let WS = { db, settings: {}, savedAt: new Date().toISOString(), revision: 1 };
app.get('/api/workspace', (q, r) => r.json({ ok: true, data: WS }));
app.post('/api/workspace', (q, r) => { saved = q.body; WS.revision++; r.json({ ok: true, savedAt: new Date().toISOString(), revision: WS.revision }); });
app.use(express.static(ROOT)); app.get('*', (q, r) => r.sendFile(path.join(ROOT, 'index.html')));
const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
const BASE = 'http://127.0.0.1:' + srv.address().port;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
const sheetHits = [];
await ctx.route('https://docs.google.com/**', (route) => {
  const u = route.request().url(); sheetHits.push(u);
  if (/gid=111/.test(u)) return route.fulfill({ status: 200, contentType: 'text/csv', body: KOWORK_CSV });
  return route.fulfill({ status: 404, body: 'nope' });
});
const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push('page error: ' + e.message));
const text = async (s) => (await p.textContent(s)) || '';

await p.goto(BASE + '/#/settings/sheetmetrics'); await p.waitForTimeout(1200);
ok('the workspace loaded (KOWORK and its roster are here)',
  await p.evaluate(() => !!byCampaign.cpKW && DB.creators.some((c) => c.id === 'crA') && DB.socialContent.some((c) => c.id === 'scA')));
ok('the Setup panel renders', await p.isVisible('#smBase'));
ok('it is listed in the Setup menu', (await text('.panel, #panelList')).includes('Sheet metrics'));
ok('post_er unit defaults to Percent', (await p.inputValue('#smEr')) === 'percent');
ok('zero defaults to "treat as blank"', (await p.inputValue('#smZero')) === 'skip');
ok('it says it is not the workspace mirror', (await text('#view')).includes('not the workspace mirror'));
ok('there is no campaign column to map', !(await p.$('[data-smmap="content"][data-field="campaign"]')));
ok('ci_id is not offered as a post id', !(await p.$('[data-smmap="content"][data-field="ciId"]')));
const fields = await p.$$eval('[data-smmap="content"]', (els) => els.map((e) => e.dataset.field));
ok('content mapping lists the 18 master-Sheet fields', fields.length === 18, fields.length + ' fields');
ok('post_url is read from post_url by default',
  (await p.getAttribute('[data-smmap="content"][data-field="postUrl"]', 'placeholder')) === 'post_url');
ok('the creator-profile tab is off by default', !(await p.isChecked('#smCrOn')));
ok('its column mapping is hidden while off', (await p.$$('[data-smmap="creator"]')).length === 0);

await p.fill('#smBase', 'https://docs.google.com/spreadsheets/d/1AbCtest/edit');
await p.dispatchEvent('#smBase', 'change'); await p.waitForTimeout(500);
ok('Read the Sheet becomes available', !(await p.isDisabled('#smDry')));

await p.click('#smAddTab'); await p.waitForTimeout(400);
ok('a new tab starts unmapped and says so', (await text('#view')).includes('Not mapped yet'));
await p.fill('[data-smtname="0"]', 'KOWORK'); await p.dispatchEvent('[data-smtname="0"]', 'change'); await p.waitForTimeout(400);
ok('naming the tab KOWORK suggests campaign KOWORK', (await p.inputValue('[data-smtcp="0"]')) === 'cpKW');
const mapLine = (await text('#view')).replace(/\s+/g, ' ');
ok('the panel shows "Tab KOWORK → Campaign KOWORK"', mapLine.includes('Tab KOWORK → Campaign KOWORK'));
await p.fill('[data-smtgid="0"]', '111'); await p.dispatchEvent('[data-smtgid="0"]', 'change'); await p.waitForTimeout(200);

ok('the mapping survives leaving and coming back', await (async () => {
  await p.goto(BASE + '/#/settings/templates'); await p.waitForTimeout(400);
  await p.goto(BASE + '/#/settings/sheetmetrics'); await p.waitForTimeout(700);
  return (await p.inputValue('[data-smtcp="0"]')) === 'cpKW' && (await p.inputValue('[data-smtgid="0"]')) === '111';
})());

await p.click('#smCheck'); await p.waitForTimeout(1200);
const chk = await text('#smOut');
ok('Check the columns finds every column', chk.includes('18/18 columns found') && /handles/.test(chk), chk.replace(/\s+/g, ' ').slice(0, 120));

await p.click('#smDry'); await p.waitForTimeout(1500);
const out = (await text('#smOut')).replace(/\s+/g, ' ');
ok('only the Sheet export was fetched', sheetHits.length > 0 && sheetHits.every((u) => /format=csv&gid=111/.test(u)));
ok('the preview names the tab and its campaign', out.includes('KOWORK'));
ok('influencer_id is recognised as handles', /handle/i.test(out));
ok('one post to update, one to add', /Posts to update\s*1/.test(out) && /Posts to add\s*1/.test(out), out.slice(0, 160));
ok('three rows not added', /Not added\s*3/.test(out));
ok('the off-roster creator is refused by name', out.includes('@kw_gamma is not on the KOWORK roster'));
ok('an unknown creator is refused', out.includes('creator not in the database'));
ok('a profile link in post_url is refused', out.includes('not an Instagram or TikTok post link'));

await p.click('#smApply'); await p.waitForTimeout(1500);
ok('applying saves the workspace', !!saved);
if (saved) {
  const s = saved.db || saved;
  const old = s.socialContent.find((c) => c.platformPostId === 'ig_KWOLD1');
  const neu = s.socialContent.find((c) => c.platformPostId === 'ig_KWNEW1');
  ok('the existing post took the Sheet numbers', old && old.views === 9000 && old.likes === 450 && old.shares === 5);
  ok('a blank comments cell left 20 alone', old && old.comments === 20);
  ok('last_scraped_at and provenance are stored', old && old.lastScrapedAt === '2026-09-19' && old.dataSource === 'google_sheet');
  ok('post_er is kept on the post', old && old.postEr === 4.2);
  ok('a quoted multi-line note survived', old && old.sheetNotes === 'line one\nline two');
  ok('the new post was added under KOWORK for kw_beta', neu && neu.campaignId === 'cpKW' && neu.creatorId === 'crB' && neu.views === 1200);
  ok('and linked to kw_beta\'s roster row', neu && neu.participantId === 'ptB');
  ok('no post for the refused rows', !s.socialContent.some((c) => /KWNEW2|KWNEW3/.test(c.platformPostId || '')));
  ok('no creator, roster row or campaign was created',
    s.creators.length === counts0.creators && s.participants.length === counts0.participants && s.campaigns.length === counts0.campaigns);
  const alpha = s.creators.find((c) => c.id === 'crA');
  ok('post_er did not touch the creator profile ER', alpha && alpha.er === 3);
}

ok('the Google Sheet mirror panel still renders', await (async () => {
  await p.goto(BASE + '/#/settings/sheet'); await p.waitForTimeout(800);
  return (await text('#view')).length > 200;
})());
ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
await b.close(); srv.close();
console.log(errs.length ? '\n' + errs.length + ' FAILED' : '\nall sheet metrics panel checks passed');
process.exit(errs.length ? 1 : 0);
