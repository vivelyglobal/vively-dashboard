/* The homepage in a real browser.

   The unit tests prove the arithmetic. This proves the three things the
   arithmetic cannot: that the page is what you land on, that the two
   fabricated figures are actually gone from the screen, and that a
   window with no measurements in it says so instead of drawing a
   confident flat line at zero. */
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
   strand every step after it on whatever route it died on, so a single
   real problem read as twelve. */
const atHome = (fn) => async () => { await go('#/overview'); await fn(); };
const tabStrip = () => p.$eval('.tabbar', (e) => e.textContent.trim());
const text = () => p.$eval('#view', (e) => e.textContent);

await p.goto(APP, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);

/* ---- it is the front door --------------------------------------------- */

await step('the app opens on the new homepage', async () => {
  if (!await p.$('#hmPerf')) throw new Error('the homepage did not render at the default route');
  if (!await p.$('.hm-kpis')) throw new Error('no KPI strip');
});

await step('five KPI cards, and the fifth is the view total', atHome(async () => {
  const n = await p.$$eval('.hm-kpis > .card', (els) => els.length);
  if (n !== 5) throw new Error('expected 5 KPI cards, got ' + n);
  const labels = await p.$$eval('.hm-kpis .label', (els) => els.map((e) => e.textContent.trim()));
  for (const want of ['Active campaigns', 'Creators in campaigns', 'Creators contacted',
    'Content published', 'Total campaign views'])
    if (!labels.includes(want)) throw new Error('missing KPI: ' + want);
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

/* ---- honesty about what has not been measured -------------------------- */

await step('a trend window with no readings says so instead of drawing zero', atHome(async () => {
  const blanks = await p.$$eval('#hmViews .hm-blank, #hmPosts .hm-blank', (els) => els.map((e) => e.textContent));
  const svgs = await p.$$eval('#hmViews svg, #hmPosts svg', (els) => els.length);
  if (!blanks.length && !svgs) throw new Error('the trend cards rendered neither a chart nor an explanation');
  for (const b of blanks) {
    if (!/No measurements|One measurement|Nothing has been measured/.test(b))
      throw new Error('an empty trend card does not explain itself: ' + b.slice(0, 80));
  }
}));

await step('a line is never drawn through a single point', atHome(async () => {
  /* one reading is a reading; a line between it and nothing is a
     fabrication, so the card must fall back to prose */
  const single = await p.$$eval('#hmViews .hm-blank, #hmPosts .hm-blank',
    (els) => els.filter((e) => /One measurement/.test(e.textContent)).length);
  const paths = await p.$$eval('#hmViews path, #hmPosts path', (els) => els.length);
  if (single && paths) throw new Error('a single-point window still drew a path');
}));

await step('an unmeasured campaign is not drawn as a campaign that scored zero', atHome(async () => {
  const t = await text();
  const hasQuiet = await p.$$eval('#hmPerf .viz > div > div',
    (els) => els.some((e) => /no metrics entered/.test(e.getAttribute('title') || '')));
  if (hasQuiet && !/no metrics entered|no view counts have been entered/.test(t))
    throw new Error('a campaign with posts and no readings is not explained anywhere');
}));

/* ---- the controls actually do something -------------------------------- */

await step('the metric selector redraws the bars', atHome(async () => {
  const before = await p.$eval('#hmPerf', (e) => e.textContent);
  await p.click('#hmMetric button[data-v="creators"]');
  await p.waitForTimeout(400);
  const after = await p.$eval('#hmPerf', (e) => e.textContent);
  if (before === after) throw new Error('switching to Creators changed nothing');
  const active = await p.$eval('#hmMetric button.active', (e) => e.dataset.v);
  if (active !== 'creators') throw new Error('the active button is ' + active);
  await p.click('#hmMetric button[data-v="views"]');
  await p.waitForTimeout(300);
}));

await step('the range selector is wired, and every window explains itself', atHome(async () => {
  /* The seed holds a single measurement date, so 7d, 30d and 90d all
     legitimately render the same "one measurement, a line needs two"
     card — comparing the text across ranges would only ever assert that
     the seed is thin. What is checkable here is that the control drives
     the state and that no window ever renders a chart it cannot
     justify; the window arithmetic itself is covered by the unit
     tests, which can supply the histories the seed does not have. */
  for (const r of ['7', '30', '90']) {
    await p.click(`#hmRange button[data-v="${r}"]`);
    await p.waitForTimeout(350);
    const active = await p.$eval('#hmRange button.active', (e) => e.dataset.v);
    if (active !== r) throw new Error(`clicked ${r}d, active is ${active}d`);

    for (const id of ['#hmViews', '#hmPosts']) {
      const svg = await p.$$eval(id + ' svg', (els) => els.length);
      const blank = await p.$eval(id, (e) => e.textContent.trim());
      if (svg) continue;
      if (!/No measurements|One measurement|Nothing has been measured/.test(blank))
        throw new Error(`${id} at ${r}d drew no chart and gave no reason: ${blank.slice(0, 70)}`);
      if (/^0$|\b0 views\b/.test(blank))
        throw new Error(`${id} at ${r}d printed a bare zero`);
    }
  }
  await p.click('#hmRange button[data-v="30"]');
}));

await step('every Needs Attention row links where it says it does', atHome(async () => {
  const rows = await p.$$eval('.hm-att .row', (els) =>
    els.map((e) => ({ href: e.getAttribute('href'), text: e.textContent.trim() })));
  if (rows.length !== 6) throw new Error('expected 6 rows, got ' + rows.length);
  for (const r of rows) {
    if (!r.href || !r.href.startsWith('#/')) throw new Error('row has no route: ' + r.text);
  }
  await go(rows[0].href);
  if (await p.$('#hmPerf')) throw new Error('the first row did not navigate away from the homepage');
}));

await step('a campaign bar opens that campaign', atHome(async () => {
  const bar = await p.$('#hmPerf .viz > div > div');
  if (!bar) throw new Error('no bars rendered');
  await bar.click();
  await p.waitForTimeout(600);
  const h = await p.evaluate(() => location.hash);
  if (!/^#\/campaigns\//.test(h)) throw new Error('a bar click went to ' + h);
}));

/* ---- the pipelines say what they can and cannot -------------------------- */

await step('the campaign pipeline uses the real status names', atHome(async () => {
  const t = await p.$eval('#hmPipe', (e) => e.textContent);
  for (const want of ['Planning', 'Outreach', 'Confirming', 'Production', 'Live', 'Wrapped'])
    if (!t.includes(want)) throw new Error('missing status ' + want);
  const card = await p.$eval('#hmPipe', (e) => e.closest('.card').textContent);
  if (!/Recruiting|Reporting/.test(card))
    throw new Error('the card does not explain why the asked-for names are absent');
}));

await step('the creator funnel never grows as it descends', atHome(async () => {
  /* .fv holds the count and, from the second row down, an <em> with the
     step percentage. textContent runs the two together — "287" and
     "94%" read back as 28794 — so take the first text node only. */
  const ns = await p.$$eval('#hmFunnel .fv', (els) =>
    els.map((e) => Number(String(e.childNodes[0].textContent).replace(/[^\d]/g, ''))));
  if (ns.length < 3) throw new Error('the funnel did not render');
  ns.forEach((n, i) => { if (i && n > ns[i - 1]) throw new Error('the funnel grows at step ' + i); });
}));

await step('the activity feed is labelled as derived, not as an event log', atHome(async () => {
  const card = await p.$eval('#hmFeed', (e) => e.closest('.card').textContent);
  if (!/not an event log/.test(card)) throw new Error('the feed does not say what it is');
  if (!/stage changes are not timestamped|not timestamped individually/.test(card))
    throw new Error('the feed does not name the half it cannot show');
}));

/* ---- nothing broke ------------------------------------------------------ */

await step('the Social Overview next door is untouched', async () => {
  await go('#/social');
  if (!await p.$('#soTime')) throw new Error('the Social Overview stopped rendering');
  await go('#/overview');
});

await step('the page threw nothing', async () => {
  const thrown = errs.filter((e) => String(e).startsWith('PAGEERROR'));
  if (thrown.length) throw new Error(thrown.join(' | '));
});

console.log('\nerrors: ' + (errs.length ? errs.join(' | ') : 'none'));
await b.close();
process.exit(errs.length ? 1 : 0);
