/* The homepage in a real browser.

   The unit tests prove the arithmetic. This proves the things the
   arithmetic cannot: that the page is what you land on, that the two
   figures which were never measurements are gone from the screen, and
   that the places where data does not exist say so instead of showing
   a zero. */
import { chromium } from 'playwright';
import { signIn } from './harness-auth.mjs';
import fs from 'fs';

const seed = fs.readFileSync('tmp/seed.json', 'utf8');
const APP = process.argv[2] || 'http://localhost:3120/';

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext();
await signIn(ctx);
await ctx.addInitScript(([s]) => {
  if (!localStorage.getItem('vively-workspace-v1')) localStorage.setItem('vively-workspace-v1', s);
  localStorage.setItem('vively-auth-user-v1', JSON.stringify({ email: 'k@v.com', name: 'K' }));
}, [seed]);
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
const step = async (n, fn) => {
  try { await fn(); console.log('ok   ' + n); }
  catch (e) { console.log('FAIL ' + n + ' — ' + e.message); errs.push(n); }
};
const go = async (hash) => { await p.evaluate((h) => { location.hash = h; }, hash); await p.waitForTimeout(700); };
/* Steps that need the homepage navigate to it first rather than relying
   on the previous step to have left them there — one failure used to
   strand every step after it, so a single real problem read as twelve. */
const atHome = (fn) => async () => { await go('#/overview'); await fn(); };
const tabStrip = () => p.$eval('.tabbar', (e) => e.textContent.trim());
const text = () => p.$eval('#view', (e) => e.textContent);

await p.goto(APP, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);

/* ---- it is the front door --------------------------------------------- */

await step('the app opens on the command band', async () => {
  if (!await p.$('.hm-band')) throw new Error('the band did not render at the default route');
  if (!await p.$('#hmRegister')) throw new Error('no campaign register');
});

await step('the band leads with active campaigns and four supporting figures', atHome(async () => {
  const lab = await p.$eval('.hm-band .hm-lab', (e) => e.textContent.trim());
  if (!/active campaigns/i.test(lab)) throw new Error('the lede is ' + lab);
  const big = await p.$eval('.hm-big', (e) => e.textContent.trim());
  if (!/^\d[\d,]*$/.test(big)) throw new Error('the headline is not a number: ' + big);
  const sats = await p.$$eval('.hm-sat .l', (els) => els.map((e) => e.textContent.trim()));
  if (sats.length !== 4) throw new Error('expected 4 satellites, got ' + sats.length);
  for (const want of ['Confirmed creators', 'Contacted', 'Content pieces', 'Total views'])
    if (!sats.includes(want)) throw new Error('missing satellite: ' + want);
}));

/* ---- the two figures that were not measurements ------------------------ */

await step('Blended CPM is gone from the homepage', atHome(async () => {
  const t = await text();
  if (/blended cpm/i.test(t)) throw new Error('Blended CPM is still on the page');
  /* it divided spend by reach, and reach is zero on every record, so it
     could only ever print ₩0.0 */
  if (/₩0\.0(\D|$)/.test(t)) throw new Error('a ₩0.0 figure is still rendered');
}));

await step('the Views | Engagement | Cost tab strip is gone', atHome(async () => {
  const tabs = await tabStrip();
  for (const gone of ['Engagement', 'Cost'])
    if (new RegExp('\\b' + gone + '\\b').test(tabs)) throw new Error('the ' + gone + ' tab is still there');
}));

await step('the other Overview pages keep their tabs', async () => {
  await go('#/overview/pipeline');
  const tabs = await tabStrip();
  if (!/Funnel/.test(tabs)) throw new Error('the Pipeline page lost its tabs: ' + tabs);
});

/* ---- the pipeline rail -------------------------------------------------- */

await step('the rail uses the real status names and accounts for every campaign', atHome(async () => {
  const labs = await p.$$eval('.hm-labs span', (els) => els.map((e) => e.textContent.trim()));
  for (const want of ['Planning', 'Outreach', 'Confirming', 'Production', 'Live', 'Wrapped'])
    if (!labs.includes(want)) throw new Error('missing status ' + want);
  const counts = await p.$$eval('#hmRail .hm-seg .c',
    (els) => els.map((e) => Number(e.textContent.replace(/,/g, ''))));
  const total = counts.reduce((a, n) => a + n, 0);
  const stated = Number((await p.$eval('.hm-rail-h .n', (e) => e.textContent.match(/[\d,]+/)[0])).replace(/,/g, ''));
  if (total !== stated) throw new Error(`segments sum to ${total} but the rail claims ${stated}`);
}));

/* ---- the creator flow --------------------------------------------------- */

await step('the flow never widens, and names the stages it folded together', atHome(async () => {
  const ns = await p.$$eval('#hmFlow g text', (els) => els.map((e) => e.textContent.trim())
    .filter((t) => /^[\d,]+$/.test(t)).map((t) => Number(t.replace(/,/g, ''))));
  if (ns.length !== 4) throw new Error('expected 4 stage counts, got ' + ns.length);
  ns.forEach((n, i) => { if (i && n > ns[i - 1]) throw new Error('the flow widens at step ' + i); });
  const note = await p.$eval('#hmFlow', (e) => e.parentElement.textContent);
  if (!/Contacted and Replied are folded/.test(note))
    throw new Error('the card does not explain why nine stages became four');
}));

/* ---- needs attention ---------------------------------------------------- */

await step('every attention row links where it says it does', atHome(async () => {
  const rows = await p.$$eval('.hm-att .row', (els) =>
    els.map((e) => ({ href: e.getAttribute('href'), text: e.textContent.trim() })));
  if (rows.length !== 6) throw new Error('expected 6 rows, got ' + rows.length);
  for (const r of rows) if (!r.href || !r.href.startsWith('#/')) throw new Error('row has no route: ' + r.text);
  await go(rows[0].href);
  if (await p.$('.hm-band')) throw new Error('the first row did not navigate away from the homepage');
}));

await step('a resolved row stays visible rather than disappearing', atHome(async () => {
  /* a queue that hides its cleared items reads as incomplete, not as done */
  const zeros = await p.$$eval('.hm-att .row.done', (els) => els.length);
  const rows = await p.$$eval('.hm-att .row', (els) => els.length);
  if (rows !== 6) throw new Error('rows: ' + rows);
  if (zeros === rows) throw new Error('every row reads as resolved — the seed should have at least one open');
}));

/* ---- the campaign register ---------------------------------------------- */

await step('the register lists campaigns with progress and health', atHome(async () => {
  const n = await p.$$eval('#hmRegister .hm-reg-row', (els) => els.length);
  if (!n) throw new Error('no campaign rows');
  const first = await p.$eval('#hmRegister .hm-reg-row', (e) => e.textContent);
  if (!/\d+\/(\d+|—)/.test(first)) throw new Error('no creators-confirmed figure: ' + first);
  const chips = await p.$$eval('#hmRegister .hm-chip', (els) => els.length);
  if (chips < n * 2) throw new Error('every row needs a status chip and a health chip');
}));

await step('an unmeasured campaign says so instead of scoring zero', atHome(async () => {
  const cells = await p.$$eval('#hmRegister .fig', (els) => els.map((e) => e.textContent.trim()));
  /* a campaign with posts but no readings must never render "0" in the
     views column — the two are not the same claim */
  const t = await p.$eval('#hmRegister', (e) => e.textContent);
  if (/unmeasured/.test(t) === false && cells.includes('0'))
    throw new Error('a zero appears in the register with no "unmeasured" anywhere to explain it');
}));

await step('a register row opens that campaign', atHome(async () => {
  const row = await p.$('#hmRegister .hm-reg-row');
  if (!row) throw new Error('no rows');
  await row.click();
  await p.waitForTimeout(700);
  const h = await p.evaluate(() => location.hash);
  if (!/^#\/campaigns\//.test(h)) throw new Error('a row click went to ' + h);
}));

/* ---- content and activity ----------------------------------------------- */

await step('a top content card opens the post', atHome(async () => {
  const card = await p.$('#hmTop .so-tc');
  if (!card) return;                     // a seed with no measured posts is legitimate
  await card.click();
  await p.waitForTimeout(600);
  if (!await p.$('.drawer, #drawer, .drawer-open')) {
    const t = await p.evaluate(() => document.body.textContent);
    if (!/views/i.test(t)) throw new Error('clicking a card did nothing visible');
  }
}));

await step('the activity feed is labelled as derived, not as an event log', atHome(async () => {
  const card = await p.$eval('#hmFeed', (e) => e.parentElement.textContent);
  if (!/not an event log/.test(card)) throw new Error('the feed does not say what it is');
  if (!/not timestamped individually/.test(card))
    throw new Error('the feed does not name the half it cannot show');
}));

/* ---- nothing broke ------------------------------------------------------ */

await step('the Social Overview next door is untouched', async () => {
  await go('#/social');
  if (!await p.$('#soTime')) throw new Error('the Social Overview stopped rendering');
});

await step('the page threw nothing', async () => {
  const thrown = errs.filter((e) => String(e).startsWith('PAGEERROR'));
  if (thrown.length) throw new Error(thrown.join(' | '));
});

console.log('\nerrors: ' + (errs.length ? errs.join(' | ') : 'none'));
await b.close();
process.exit(errs.length ? 1 : 0);
