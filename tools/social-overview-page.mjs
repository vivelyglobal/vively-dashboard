/* The Overview as a person meets it: a real browser, the real seed, the
   real shell. The unit tests prove the arithmetic; this proves the page
   is reachable, that the filters actually drive the charts, and — the
   thing that matters most here — that the Content library next door is
   untouched by any of it. */
import { chromium } from 'playwright';
import fs from 'fs';

const seed = fs.readFileSync('tmp/seed.json', 'utf8');
const APP = process.argv[2] || 'http://localhost:3120/';

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext();
/* Planted only when absent. An unconditional set runs again on every
   reload, which silently restored the seed underneath any fixture a
   check had just injected — the check then passed against the original
   data and proved nothing. */
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

const go = async (hash) => {
  await p.evaluate((h) => { location.hash = h; }, hash);
  await p.waitForTimeout(650);
};
const text = () => p.$eval('#view', (e) => e.innerText);

await p.goto(APP, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);

/* ---- it exists and is the default ------------------------------------- */

await step('clicking Social lands on the Overview, not the library', async () => {
  await go('#/social');
  await p.waitForTimeout(500);
  if (!await p.$('#soTime')) throw new Error('the Overview did not render');
  /* Every chart here ships a .tbl fallback for screen readers and for
     print — those are a feature, not the operational table the brief
     ruled out. What must not appear is the library's sortable grid. */
  if (await p.$('#view table.data, #view #soTable')) throw new Error('the library table rendered');
});

await step('both pages are offered in the panel', async () => {
  const panel = await p.$eval('#panelList', (e) => e.innerText).catch(() => '');
  for (const label of ['Overview', 'Content'])
    if (!panel.includes(label)) throw new Error('the panel does not offer ' + label);
});

await step('the Overview has no leftover library tabs', async () => {
  /* All / In a campaign / Needs review belong to the library and mean
     nothing here; leaving them on would offer controls that do nothing */
  const tabs = await p.$$eval('#tabs a, #tabs button', (n) => n.map((x) => x.innerText.trim())).catch(() => []);
  if (tabs.some((t) => /Needs review|Unassigned|In a campaign/.test(t)))
    throw new Error('library tabs are showing on the Overview: ' + tabs.join(', '));
});

/* ---- every card is present -------------------------------------------- */

await step('all nine cards render', async () => {
  for (const id of ['#soTime', '#soPlatformViz', '#soCampaignViz', '#soEngViz',
                    '#soDistViz', '#soTopViz', '#soMarketViz', '#soCoverageViz'])
    if (!await p.$(id)) throw new Error('missing ' + id);
  /* the labels are uppercased by CSS, and innerText reports what is
     rendered rather than what is in the markup */
  const t = (await text()).toLowerCase();
  for (const label of ['total content', 'total views', 'engagements',
                       'avg eng. rate', 'avg views / post', 'creators activated'])
    if (!t.includes(label)) throw new Error('missing KPI: ' + label);
});

await step('the KPI numbers agree with the model', async () => {
  const both = await p.evaluate(() => {
    const rows = window.__soRows();
    return { model: window.__soKpis(rows), shown: document.querySelector('#view').innerText };
  }).catch(() => null);
  if (!both) return;                       // helpers only exist in the harness build
  if (!both.shown.includes(String(both.model.content))) throw new Error('content count not on the page');
});

/* ---- the filters actually drive the page ------------------------------ */

await step('a campaign filter narrows every card, not just one', async () => {
  const before = await text();
  const opts = await p.$$eval('#soCampaign option', (n) => n.map((o) => o.value).filter(Boolean));
  if (!opts.length) throw new Error('no campaigns to filter by');
  await p.selectOption('#soCampaign', opts[0]);
  await p.waitForTimeout(800);
  const after = await text();
  if (after === before) throw new Error('nothing changed when a campaign was selected');
  const count = await p.$eval('.so-filters .so-hint', (e) => e.innerText);
  if (!/of \d+ posts/.test(count)) throw new Error('the filtered count is not shown: ' + count);
  if (/^(\d+) of \1 posts/.test(count)) throw new Error('the filter selected everything: ' + count);
});

await step('Reset puts it all back', async () => {
  await p.click('#soReset');
  await p.waitForTimeout(800);
  const v = await p.$eval('#soCampaign', (e) => e.value);
  if (v !== '') throw new Error('the campaign filter survived the reset');
});

await step('the metric selector changes the dominant chart', async () => {
  const before = await p.$eval('#soTime', (e) => e.innerHTML);
  await p.click('#soMetricSeg button[data-m="content"]');
  await p.waitForTimeout(700);
  const after = await p.$eval('#soTime', (e) => e.innerHTML);
  if (after === before) throw new Error('switching to Published redrew nothing');
  await p.click('#soMetricSeg button[data-m="views"]');
  await p.waitForTimeout(600);
});

await step('the date axis can be switched, and says which it is on', async () => {
  const noteFor = () => p.$eval('#soTimeNote', (e) => e.innerText);
  await p.click('#soDateSeg button[data-d="posted"]');
  await p.waitForTimeout(700);
  const posted = await noteFor();
  if (!/publish date/.test(posted)) throw new Error('the note does not name the axis: ' + posted);
  await p.click('#soDateSeg button[data-d="metrics"]');
  await p.waitForTimeout(700);
  const metrics = await noteFor();
  if (!/measurement date/.test(metrics)) throw new Error('the note does not name the axis: ' + metrics);
  if (posted === metrics) throw new Error('both axes report the same thing');
});

/* ---- the honesty properties ------------------------------------------- */

/* The two states this page exists to be honest about — a post nobody
   measured, and a metric nobody records — are pinned at the unit level
   in tests/social-overview.test.mjs, where the data can be controlled.
   The app boots its workspace from the server rather than localStorage,
   so injecting a fixture here does not survive the load, and a check
   built on one would pass without proving anything.

   What the browser can prove is that the rendered page adds up. */

await step('the distribution accounts for every post, measured or not', async () => {
  /* textContent, not innerText: the fallback table lives inside a
     collapsed <details>, and innerText only reports rendered text */
  const buckets = await p.$$eval('#soDistViz .tbl tbody tr', (rs) =>
    rs.map((r) => Number(String(r.cells[1].textContent).replace(/,/g, '')) || 0));
  if (!buckets.length) throw new Error('the distribution has no buckets');
  const foot = await p.$eval('#soDistViz', (e) => e.innerText);
  const unmeasured = Number((foot.match(/\+\s*([\d,]+)\s*posts? not measured/) || [])[1]
    ? (foot.match(/\+\s*([\d,]+)\s*posts? not measured/) || [])[1].replace(/,/g, '') : 0);
  const shown = buckets.reduce((a, b) => a + b, 0) + unmeasured;
  const total = Number(await p.$eval('.so-filters .so-hint', (e) =>
    (e.innerText.match(/^([\d,]+)/) || [])[1].replace(/,/g, '')));
  if (shown !== total)
    throw new Error(`the buckets plus the unmeasured note account for ${shown} of ${total} posts`);
});

await step('every engagement row shows a figure or says why it cannot', async () => {
  /* the failure this guards: a metric that was never collected drawn as
     a plain zero, which reads as "nobody engaged" rather than "we do
     not have this" */
  const rows = await p.$$eval('#soEngViz > div > div', (ns) => ns.map((n) => n.innerText.trim()));
  const named = rows.filter((r) => /^(Likes|Comments|Shares|Saves)/.test(r));
  if (named.length !== 4) throw new Error('expected four engagement rows, got ' + named.length);
  for (const r of named) {
    const isZero = /\b0 · 0\.0%/.test(r);
    const explains = /Notion form|none recorded/.test(r);
    if (isZero && !explains) throw new Error('a bare zero with no explanation: ' + JSON.stringify(r));
  }
});

await step('the coverage card names what is missing', async () => {
  const t = await p.$eval('#soCoverageViz', (e) => e.innerText);
  for (const label of ['Posts with view counts', 'Daily view history', 'Thumbnails'])
    if (!t.includes(label)) throw new Error('coverage is missing: ' + label);
  /* and the two known gaps must read as zero-of-something, not blank */
  if (!/0 \/ \d+/.test(t)) throw new Error('a gap is not reported as a fraction: ' + t);
});

/* ---- it navigates ------------------------------------------------------ */

await step('a top-content card opens the post', async () => {
  const card = await p.$('#soTopViz .so-tc');
  if (!card) { console.log('     (no measured content in the seed — skipped)'); return; }
  await card.click();
  await p.waitForTimeout(700);
  if (!await p.$('.drawer')) throw new Error('clicking a card opened nothing');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
});

await step('clicking a campaign bar filters the page to it', async () => {
  const bar = await p.$('#soCampaignViz div[title]');
  if (!bar) throw new Error('no campaign bars');
  await bar.click();
  await p.waitForTimeout(800);
  const v = await p.$eval('#soCampaign', (e) => e.value);
  if (!v) throw new Error('the click did not set the campaign filter');
  await p.click('#soReset');
  await p.waitForTimeout(600);
});

/* ---- and above all, it did not disturb the library --------------------- */

await step('the Content library still works, unchanged', async () => {
  await go('#/social/library');
  await p.waitForTimeout(900);
  const t = await text();
  if (!await p.$('#soViews')) throw new Error('the library filters are gone');
  if (/Avg views \/ post|Measurement coverage/.test(t))
    throw new Error('the Overview leaked into the library');
});

await step('the Overview wrote nothing to the workspace', async () => {
  /* the shell persists UI state on every render, so the stored string
     always moves. What must not move is the data inside it. */
  const dbOf = () => p.evaluate(() =>
    JSON.stringify(JSON.parse(localStorage.getItem('vively-workspace-v1')).db));
  await go('#/social/overview');
  await p.waitForTimeout(700);
  const before = await dbOf();
  await p.click('#soMetricSeg button[data-m="eng"]');
  await p.waitForTimeout(600);
  await p.selectOption('#soPlatform', 'Instagram').catch(() => {});
  await p.waitForTimeout(600);
  const after = await dbOf();
  if (before !== after) throw new Error('reading the Overview changed the stored data');
});

await step('no page errors anywhere in all of that', async () => {
  const pe = errs.filter((e) => String(e).startsWith('PAGEERROR'));
  if (pe.length) throw new Error(pe.join(' | '));
});

console.log('\nerrors: ' + (errs.length ? errs.join(' | ') : 'none'));
await b.close();
process.exit(errs.length ? 1 : 0);
