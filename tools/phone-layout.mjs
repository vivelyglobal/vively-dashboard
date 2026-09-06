/* The dashboard on a phone.

   One property matters more than any other here and it is easy to lose
   by accident: the page itself must not scroll sideways. A single
   element with a min-width wider than the viewport drags the whole
   document with it, and the result is not "a bit cramped" — it is a
   page that slides under the thumb, with the content half off-screen
   and no obvious way back. That is what this file exists to prevent.

   A wide table scrolling inside its own box is the opposite, and is
   fine: the checks below distinguish the two deliberately. */
import { chromium, devices } from 'playwright';
import { signIn } from './harness-auth.mjs';
import fs from 'fs';

const seed = fs.readFileSync('tmp/seed.json', 'utf8');
const APP = process.argv[2] || 'http://localhost:3120/';
const PAGES = [
  ['Overview',        '#/overview'],
  ['Campaigns',       '#/campaigns/all'],
  ['Social Overview', '#/social/overview'],
  ['Content library', '#/social/library'],
  ['Creators',        '#/creators/all'],
  ['Calendar',        '#/campaigns/all/calendar'],
  ['Settings',        '#/settings/templates']
];

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ ...devices['iPhone 13'] });
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
const go = async (hash) => {
  await p.evaluate((h) => { location.hash = h; }, hash);
  await p.waitForTimeout(1100);
};

await p.goto(APP, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1700);

const vw = p.viewportSize();
console.log(`     iPhone 13 · ${vw.width}x${vw.height}\n`);

/* ---- the property that matters ---------------------------------------- */

for (const [label, hash] of PAGES) {
  await step(`${label} does not scroll sideways`, async () => {
    await go(hash);
    const m = await p.evaluate(() => {
      const de = document.documentElement;
      /* the outermost thing sticking out, named, so a failure says what
         to fix rather than only that something is wrong */
      const w = de.clientWidth;
      const culprits = [...document.querySelectorAll('body *')]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          if (r.width === 0 || r.right <= w + 2) return false;
          /* a box that scrolls its own content is doing the right thing */
          const cs = getComputedStyle(e);
          if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return false;
          const par = e.parentElement;
          if (par) {
            const pcs = getComputedStyle(par);
            if (pcs.overflowX === 'auto' || pcs.overflowX === 'scroll') return false;
          }
          return true;
        })
        .slice(0, 3)
        .map((e) => e.tagName + (e.id ? '#' + e.id : '') + '.' + String(e.className || '').slice(0, 24));
      return { scroll: de.scrollWidth, client: w, culprits };
    });
    if (m.scroll > m.client + 2)
      throw new Error(`document is ${m.scroll}px wide in a ${m.client}px viewport` +
        (m.culprits.length ? ' — ' + m.culprits.join(', ') : ''));
  });
}

/* ---- a wide table is allowed to scroll, inside itself ------------------ */

await step('a wide table scrolls in its own box, not by moving the page', async () => {
  await go('#/creators/all');
  const m = await p.evaluate(() => {
    const wrap = document.querySelector('#view .tbl-wrap');
    if (!wrap) return null;
    const cs = getComputedStyle(wrap);
    return { inner: wrap.scrollWidth, outer: wrap.clientWidth, overflowX: cs.overflowX,
             doc: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth };
  });
  if (!m) throw new Error('no table on the Creators page to check');
  if (m.inner <= m.outer) throw new Error('the table is not actually wider than its box — this proves nothing');
  if (!/auto|scroll/.test(m.overflowX)) throw new Error('the wrapper does not scroll: overflow-x is ' + m.overflowX);
  if (m.doc > m.vw + 2) throw new Error('the page moved anyway');
});

/* ---- reachable with a thumb -------------------------------------------- */

await step('every control is big enough to tap', async () => {
  const bad = [];
  for (const [label, hash] of PAGES) {
    await go(hash);
    const small = await p.$$eval('#view button, #view a[href], #view select, #view input, .topbar button',
      (ns) => ns.filter((e) => {
        const r = e.getBoundingClientRect();
        return r.height > 0 && r.width > 0 && r.height < 32;
      }).map((e) => e.tagName + '."' + String(e.innerText || e.value || '').slice(0, 14) + '"'));
    if (small.length) bad.push(`${label}: ${small.slice(0, 4).join(', ')}`);
  }
  if (bad.length) throw new Error(bad.join(' | '));
});

await step('text inputs do not trigger the iOS zoom trap', async () => {
  /* below 16px Safari zooms the page in on focus and does not zoom back
     out, which strands the user at 2x with no obvious way to recover */
  await go('#/social/library');
  const small = await p.$$eval('input, select, textarea', (ns) => ns
    .filter((e) => {
      const r = e.getBoundingClientRect();
      return r.height > 0 && parseFloat(getComputedStyle(e).fontSize) < 16;
    })
    .map((e) => e.tagName + '#' + (e.id || '?') + ' ' + getComputedStyle(e).fontSize));
  if (small.length) throw new Error(small.slice(0, 5).join(', '));
});

/* ---- the shell still works ---------------------------------------------- */

await step('the side menu opens over the page rather than squeezing it', async () => {
  await go('#/social/overview');
  const before = await p.$eval('#view', (e) => Math.round(e.getBoundingClientRect().width));
  await p.evaluate(() => document.body.classList.add('panel-open'));
  await p.waitForTimeout(400);
  const m = await p.evaluate(() => {
    const panel = document.querySelector('aside.panel');
    const r = panel.getBoundingClientRect();
    return { view: Math.round(document.querySelector('#view').getBoundingClientRect().width),
             panelLeft: Math.round(r.left), panelW: Math.round(r.width),
             pos: getComputedStyle(panel).position,
             doc: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth };
  });
  if (m.pos !== 'fixed') throw new Error('the menu is still a layout column (' + m.pos + ')');
  if (m.view !== before) throw new Error(`opening the menu resized the content ${before} -> ${m.view}`);
  if (m.panelLeft < 0) throw new Error('the menu opened off the left edge');
  if (m.doc > m.vw + 2) throw new Error('opening the menu made the page scroll sideways');
  await p.evaluate(() => document.body.classList.remove('panel-open'));
  await p.waitForTimeout(300);
});

await step('the rail is still there to navigate with', async () => {
  const items = await p.$$eval('.rail .rail-item', (ns) => ns.length);
  if (items < 5) throw new Error('only ' + items + ' rail items');
  const w = await p.$eval('.rail', (e) => Math.round(e.getBoundingClientRect().width));
  if (w > 80) throw new Error('the rail is taking ' + w + 'px of a 390px screen');
});

await step('a drawer covers the screen instead of leaving a live strip behind it', async () => {
  await go('#/social/overview');
  const card = await p.$('#soTopViz .so-tc');
  if (!card) { console.log('     (no content card in the seed — skipped)'); return; }
  await card.click();
  await p.waitForTimeout(700);
  const m = await p.evaluate(() => {
    const d = document.querySelector('.drawer');
    const r = d.getBoundingClientRect();
    return { w: Math.round(r.width), left: Math.round(r.left),
             vw: document.documentElement.clientWidth, doc: document.documentElement.scrollWidth };
  });
  if (m.left > 2) throw new Error('the drawer starts at ' + m.left + 'px, leaving a strip of page beside it');
  if (m.w < m.vw - 2) throw new Error('the drawer is ' + m.w + 'px on a ' + m.vw + 'px screen');
  if (m.doc > m.vw + 2) throw new Error('opening the drawer made the page scroll sideways');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
});

/* ---- and none of it broke the desktop ---------------------------------- */

await step('the desktop layout is untouched', async () => {
  const wide = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await signIn(wide);
  await wide.addInitScript(([s]) => {
    if (!localStorage.getItem('vively-workspace-v1')) localStorage.setItem('vively-workspace-v1', s);
    localStorage.setItem('vively-auth-user-v1', JSON.stringify({ email: 'k@v.com', name: 'K' }));
  }, [seed]);
  const w = await wide.newPage();
  await w.goto(APP, { waitUntil: 'domcontentloaded' });
  await w.waitForTimeout(1700);
  await w.evaluate(() => { location.hash = '#/social/overview'; });
  await w.waitForTimeout(1100);
  const m = await w.evaluate(() => {
    const panel = document.querySelector('aside.panel');
    return { panelPos: getComputedStyle(panel).position,
             panelW: Math.round(panel.getBoundingClientRect().width),
             railW: Math.round(document.querySelector('.rail').getBoundingClientRect().width),
             topbarWrap: getComputedStyle(document.querySelector('.topbar')).flexWrap,
             cards: document.querySelectorAll('#view .card').length };
  });
  await wide.close();
  if (m.panelPos === 'fixed') throw new Error('the phone overlay leaked into the desktop layout');
  if (m.panelW < 200) throw new Error('the desktop side menu collapsed: ' + m.panelW + 'px');
  if (m.railW < 70) throw new Error('the desktop rail shrank to ' + m.railW + 'px');
  if (m.topbarWrap === 'wrap') throw new Error('the desktop top bar is wrapping');
  if (m.cards < 5) throw new Error('the Overview lost cards on desktop: ' + m.cards);
});

/* ---- the homepage, which is the first thing anyone sees ---------------- */

await step('the homepage KPI strip goes two-up rather than five-across', async () => {
  await go('#/overview');
  const m = await p.evaluate(() => {
    const strip = document.querySelector('.hm-kpis');
    if (!strip) return null;
    const cards = [...strip.children];
    const cols = getComputedStyle(strip).gridTemplateColumns.split(' ').length;
    return {
      cols,
      widest: Math.max(...cards.map((c) => Math.round(c.getBoundingClientRect().width))),
      lastSpansBoth: cards.length === 5 &&
        Math.round(cards[4].getBoundingClientRect().width) > Math.round(cards[0].getBoundingClientRect().width) + 20,
      overflow: cards.filter((c) => c.getBoundingClientRect().right > window.innerWidth + 1).length
    };
  });
  if (!m) throw new Error('the KPI strip did not render');
  if (m.cols !== 2) throw new Error('the KPI strip is ' + m.cols + ' columns wide on a phone');
  if (m.overflow) throw new Error(m.overflow + ' KPI card(s) run off the right edge');
  if (!m.lastSpansBoth) throw new Error('the fifth card should span both columns rather than sit half-width');
});

await step('the funnel labels still fit beside their bars', async () => {
  const bad = await p.evaluate(() => {
    const rows = [...document.querySelectorAll('#hmFunnel .fn-row')];
    return rows.filter((r) => {
      const label = r.querySelector('.fl');
      const track = r.querySelector('.fn-track');
      /* the track is what has to survive: a label that eats the row
         leaves a bar with no width, which is worse than an ellipsis */
      return !track || track.getBoundingClientRect().width < 40 ||
             label.scrollWidth > label.clientWidth + 40;
    }).length;
  });
  if (bad) throw new Error(bad + ' funnel row(s) have no usable bar at 390px');
});

await step('the four-way metric selector wraps instead of pushing the page', async () => {
  const m = await p.evaluate(() => {
    const seg = document.querySelector('#hmMetric');
    if (!seg) return null;
    return { right: Math.round(seg.getBoundingClientRect().right), vw: window.innerWidth,
             /* scrollWidth, not the box: an inline-flex that refuses to
                wrap sits inside its parent's rectangle while still
                dragging the document out from under it */
             segScroll: seg.scrollWidth, segClient: seg.clientWidth,
             doc: document.documentElement.scrollWidth };
  });
  if (!m) throw new Error('the metric selector did not render');
  if (m.right > m.vw + 1) throw new Error('the selector runs to ' + m.right + 'px in a ' + m.vw + 'px viewport');
  if (m.segScroll > m.segClient + 1) throw new Error('the selector overflows itself: ' + m.segScroll + ' > ' + m.segClient);
  if (m.doc > m.vw + 1) throw new Error('the homepage scrolls sideways: ' + m.doc + 'px');
});

await step('the Needs Attention rows are thumb-sized', async () => {
  const small = await p.evaluate(() => [...document.querySelectorAll('.hm-att .row')]
    .filter((r) => r.getBoundingClientRect().height < 32).length);
  if (small) throw new Error(small + ' attention row(s) are under 32px tall');
});

await step('no page errors anywhere in all of that', async () => {
  const pe = errs.filter((e) => String(e).startsWith('PAGEERROR'));
  if (pe.length) throw new Error(pe.join(' | '));
});

console.log('\nerrors: ' + (errs.length ? errs.join(' | ') : 'none'));
await b.close();
process.exit(errs.length ? 1 : 0);
