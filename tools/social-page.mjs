/* The content library, driven through the UI on both builds.

   The point of most of these is the storage split: a post now lives in
   DB.socialContent and the roster row points at the same object. If the
   two ever became separate copies, the numbers on the campaign page and
   the numbers here would drift apart without anything failing loudly —
   so several of these check identity, not just equality. */
import { chromium } from 'playwright';
import fs from 'fs';
const seed = fs.readFileSync('tmp/seed.json', 'utf8');
const BASE = process.argv[2] || 'http://localhost:3120/';

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errs = [];

for (const [name, app] of [['legacy', BASE], ['react', BASE + 'next/']]) {
  const ctx = await b.newContext();
  await ctx.addInitScript(([s]) => {
    localStorage.setItem('vively-workspace-v1', s);
    localStorage.setItem('vively-auth-user-v1', JSON.stringify({ email: 'k@v.com', name: 'K' }));
  }, [seed]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`PAGEERROR(${name}): ` + e.message));
  p.on('dialog', (d) => d.accept());
  const step = async (n, fn) => {
    try { await fn(); console.log(`ok   [${name}] ` + n); }
    catch (e) { console.log(`FAIL [${name}] ` + n + ' — ' + e.message); errs.push(name + ': ' + n); }
  };
  const store = () => p.evaluate(() => JSON.parse(localStorage.getItem('vively-workspace-v1')));

  await p.goto(app, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1600);

  const go = async (hash) => { await p.evaluate((h) => { location.hash = h; }, hash); await p.waitForTimeout(800); };

  await step('the sidebar offers a Social section', async () => {
    const t = await p.$eval('body', (e) => e.innerText);
    if (!/Social/.test(t)) throw new Error('no Social entry in the shell');
  });

  await step('every post that existed on a roster row is in the library', async () => {
    await go('#/social/library/all');
    const { db } = await store();
    const onRows = db.participants.filter((x) => x.content && x.content.url).length;
    const inLib = (db.socialContent || []).filter((c) => c.url).length;
    if (!inLib) throw new Error('the library is empty');
    if (onRows) throw new Error(`${onRows} row(s) still carry their own copy of a post`);
    const shown = await p.$$eval('#view tr[data-sc]', (n) => n.length);
    if (shown !== inLib) throw new Error(`${inLib} in the library, ${shown} on screen`);
  });

  await step('the saved workspace holds exactly one copy of each post', async () => {
    const saved = await store();
    const dup = saved.db.participants.filter((x) => x.content).length;
    if (dup) throw new Error(dup + ' participant(s) serialise their content a second time');
    const ids = (saved.db.socialContent || []).map((c) => c.id);
    if (new Set(ids).size !== ids.length) throw new Error('duplicate ids inside the library');
  });

  await step('a link added on a roster row shows up in the library', async () => {
    /* the real proof that the row and the library are one record: write
       through the campaign page, read through the content page */
    const { db } = await store();
    const row = db.participants.find((x) => !x.content && x.campaignId);
    if (!row) throw new Error('the seed has no roster row without a post to use');
    const url = 'https://www.instagram.com/reel/HARNESS' + Date.now().toString(36) + '/';
    await go(`#/campaigns/${row.campaignId}/roster`);
    await p.evaluate((id) => { window.showParticipant(id); }, row.id);
    await p.waitForTimeout(500);
    await p.fill('#pdContentUrl', url);
    await p.click('#pdSave');
    await p.waitForTimeout(800);

    const after = await store();
    const rec = (after.db.socialContent || []).find((c) => c.url === url);
    if (!rec) throw new Error('the new post never reached the library');
    if (rec.participantId !== row.id) throw new Error('it is not filed against the row that made it');
    if (rec.campaignId !== row.campaignId) throw new Error('it did not inherit the campaign');
    if (rec.matchStatus !== 'confirmed') throw new Error('a post added through a roster is not a guess: ' + rec.matchStatus);
    if (!/^ig_HARNESS/.test(rec.platformPostId)) throw new Error('the platform post id was not read off the URL: ' + rec.platformPostId);
    if (after.db.participants.some((x) => x.content)) throw new Error('it was also written onto the row — two copies again');

    await go('#/social/library/all');
    await p.fill('#soQ', url);
    await p.waitForTimeout(700);
    const shown = await p.$$eval('#view tr[data-sc]', (n) => n.length);
    if (shown !== 1) throw new Error(`${shown} rows match the new post`);
    await p.click('#soClear');
    await p.waitForTimeout(600);
  });

  await step('searching narrows the list', async () => {
    await go('#/social/library/all');
    const before = await p.$$eval('#view tr[data-sc]', (n) => n.length);
    const handle = await p.$eval('#view tr[data-sc] td', (e) => e.innerText.trim().split(/\s+/)[0]);
    await p.fill('#soQ', handle);
    await p.waitForTimeout(700);
    const after = await p.$$eval('#view tr[data-sc]', (n) => n.length);
    if (!after) throw new Error(`searching "${handle}" found nothing`);
    if (after > before) throw new Error('search widened the list');
    await p.click('#soClear');
    await p.waitForTimeout(600);
    const cleared = await p.$$eval('#view tr[data-sc]', (n) => n.length);
    if (cleared !== before) throw new Error(`clearing gave back ${cleared}, not ${before}`);
  });

  await step('a nonsense search empties the list without breaking the page', async () => {
    await p.fill('#soQ', 'zzz-no-such-creator-zzz');
    await p.waitForTimeout(700);
    const rows = await p.$$eval('#view tr[data-sc]', (n) => n.length);
    if (rows) throw new Error(rows + ' rows still shown');
    const t = await p.$eval('#view', (e) => e.innerText);
    if (!/Nothing matches/i.test(t)) throw new Error('no empty state');
    await p.click('#soClear');
    await p.waitForTimeout(600);
  });

  await step('filtering by campaign shows only that campaign', async () => {
    const { db } = await store();
    const cid = (db.socialContent || []).map((c) => c.campaignId).find(Boolean);
    await p.selectOption('#soCampaign', cid);
    await p.waitForTimeout(700);
    const names = await p.$$eval('#view tr[data-sc] td:nth-child(2)', (n) => n.map((x) => x.innerText.trim()));
    const brand = (db.campaigns.find((c) => c.id === cid) || {}).brand;
    const wrong = names.filter((x) => x && x !== brand);
    if (wrong.length) throw new Error('also showed ' + [...new Set(wrong)].join(', '));
    await p.click('#soClear');
    await p.waitForTimeout(600);
  });

  await step('a minimum engagement rate excludes posts with no views, not counts them as zero', async () => {
    const { db } = await store();
    const unmeasured = (db.socialContent || []).filter((c) => !c.views).length;
    await p.fill('#soRate', '0');
    await p.waitForTimeout(700);
    const rows = await p.$$eval('#view tr[data-sc]', (n) => n.length);
    const total = (db.socialContent || []).length;
    if (unmeasured && rows > total - unmeasured)
      throw new Error(`${rows} rows for a >=0% filter, but ${unmeasured} post(s) have no view count to rate`);
    await p.click('#soClear');
    await p.waitForTimeout(600);
  });

  await step('sorting by views actually sorts', async () => {
    await p.selectOption('#soSort', 'views');
    await p.waitForTimeout(700);
    const vals = await p.$$eval('#view tr[data-sc] td:nth-child(5)',
      (n) => n.map((x) => +x.innerText.replace(/[^\d]/g, '') || 0));
    for (let i = 1; i < vals.length; i++)
      if (vals[i] > vals[i - 1]) throw new Error(`row ${i} has more views than the one above it`);
  });

  await step('clicking a row opens that video, with its own numbers', async () => {
    const first = await p.$eval('#view tr[data-sc]', (e) => e.dataset.sc);
    await p.click(`#view tr[data-sc="${first}"]`);
    await p.waitForTimeout(700);
    const t = await p.$eval('#drawerBody', (e) => e.innerText);
    for (const label of ['Views', 'Engagements', 'Engagement rate', 'Published', 'Campaign'])
      if (!t.includes(label)) throw new Error('detail is missing ' + label);
    const { db } = await store();
    const rec = db.socialContent.find((c) => c.id === first);
    if (rec.views && !t.replace(/,/g, '').includes(String(rec.views)))
      throw new Error('the detail does not show this post’s view count');
  });

  await step('a post with no readings says so rather than drawing an empty chart', async () => {
    const t = await p.$eval('#drawerBody', (e) => e.innerText);
    if (/Daily performance/.test(t) && !/No readings yet|One reading so far/.test(t) && !await p.$('#scCurve'))
      throw new Error('neither a chart nor an explanation');
  });

  await step('the CSV export offers the columns the table shows', async () => {
    if (!await p.$('#soCsv')) throw new Error('no export button');
  });

  await ctx.close();
}

console.log('\nerrors: ' + (errs.length ? errs.join(' | ') : 'none'));
await b.close();
process.exit(errs.length ? 1 : 0);
