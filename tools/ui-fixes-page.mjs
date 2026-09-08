/* Two bugs a person hit every day, pinned down so they cannot come back.

   1. The creator search box accepted one letter at a time. Typing
      re-renders the section, the re-render replaces the very <input>
      being typed into, and the new one has no focus and no caret — so
      the second keystroke went nowhere and the person had to click the
      box again for every character.

   2. The phone menu opened over the header. The slide-over sat at
      top:0 / z-index 120 against a topbar at z-index 30, so opening the
      menu covered the page title, the search box, the Save button and
      the ☰ that opened it. There was no backdrop, nothing closed on a
      tap outside, and 300px of menu beside a 56px rail left a 34px
      ribbon of page on a 390px screen.

   These are behaviour checks, not screenshots: they type real keys and
   read real geometry. */
import { chromium, devices } from 'playwright';
import { signIn } from './harness-auth.mjs';
import fs from 'fs';

const seed = fs.readFileSync('tmp/seed.json', 'utf8');
const APP = process.argv[2] || 'http://localhost:3120/';

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errs = [];
const step = async (n, fn) => {
  try { await fn(); console.log('ok   ' + n); }
  catch (e) { console.log('FAIL ' + n + ' — ' + e.message); errs.push(n); }
};
const eq = (got, want, what) => {
  if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
};

async function open(deviceName, size) {
  /* a narrow desktop window and a phone are not the same thing — the
     phone reports touch and a device pixel ratio, and the header measures
     differently under each, so the narrow case emulates one properly */
  const ctx = await b.newContext(deviceName ? { ...devices[deviceName] }
    : (size && size.width <= 760 ? { viewport: size, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
                                 : { viewport: size }));
  await signIn(ctx);
  await ctx.addInitScript(([s]) => {
    if (!localStorage.getItem('vively-workspace-v1')) localStorage.setItem('vively-workspace-v1', s);
    localStorage.setItem('vively-auth-user-v1', JSON.stringify({ email: 'k@v.com', name: 'K' }));
  }, [seed]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  await p.goto(APP, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1700);
  return { ctx, p };
}
const go = async (p, hash) => {
  await p.evaluate((h) => { location.hash = h; }, hash);
  await p.waitForTimeout(900);
};
/* longer than the 140ms debounce, with room for the redraw */
const settle = (p) => p.waitForTimeout(450);

/* ================= 1. the creator search box ================= */
console.log('\n     creator search · desktop 1440x900\n');
{
  const { ctx, p } = await open(null, { width: 1440, height: 900 });
  await go(p, '#/creators/all');

  await step('typing a whole word lands a whole word', async () => {
    await p.click('#crQ');
    await p.keyboard.type('julia', { delay: 45 });
    await settle(p);
    eq(await p.$eval('#crQ', (e) => e.value), 'julia', 'input value');
  });

  await step('the box still has focus after the list has been filtered', async () => {
    eq(await p.evaluate(() => document.activeElement && document.activeElement.id), 'crQ', 'focused element');
  });

  await step('the caret is at the end of what was typed, not at 0', async () => {
    eq(await p.$eval('#crQ', (e) => e.selectionStart), 5, 'caret');
  });

  await step('the filter actually applied', async () => {
    const state = await p.evaluate(() => state.creatorFilters.q);
    eq(state, 'julia', 'state.creatorFilters.q');
    const rows = await p.$$eval('#crBody tr', (r) => r.length);
    const all = await p.evaluate(() => selectable(DB.creators).length);
    if (!(rows < all)) throw new Error(`filter did nothing: ${rows} rows of ${all}`);
  });

  await step('backspace removes exactly one character', async () => {
    await p.keyboard.press('Backspace');
    await settle(p);
    eq(await p.$eval('#crQ', (e) => e.value), 'juli', 'value after one backspace');
    eq(await p.evaluate(() => document.activeElement.id), 'crQ', 'focus after backspace');
    eq(await p.$eval('#crQ', (e) => e.selectionStart), 4, 'caret after backspace');
  });

  await step('editing in the middle keeps the caret in the middle', async () => {
    await p.$eval('#crQ', (e) => e.setSelectionRange(2, 2));
    await p.keyboard.type('X');
    await settle(p);
    eq(await p.$eval('#crQ', (e) => e.value), 'juXli', 'value');
    eq(await p.$eval('#crQ', (e) => e.selectionStart), 3, 'caret stayed mid-word');
  });

  await step('a paste arrives in one piece', async () => {
    await p.$eval('#crQ', (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await settle(p);
    await p.$eval('#crQ', (e) => {
      e.focus();
      e.value = 'mansi_in_korea';
      e.setSelectionRange(14, 14);
      e.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(p);
    eq(await p.$eval('#crQ', (e) => e.value), 'mansi_in_korea', 'pasted value');
    eq(await p.evaluate(() => state.creatorFilters.q), 'mansi_in_korea', 'filter took the paste');
  });

  await step('clearing the field brings the whole list back', async () => {
    await p.$eval('#crQ', (e) => { e.focus(); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await settle(p);
    eq(await p.evaluate(() => state.creatorFilters.q), '', 'filter cleared');
    eq(await p.evaluate(() => document.activeElement.id), 'crQ', 'focus survives clearing');
  });

  await step('Reset clears the box and does not leave a redraw pending', async () => {
    await p.$eval('#crQ', (e) => { e.focus(); e.value = 'zz'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await p.click('#crReset');
    await p.waitForTimeout(500);
    eq(await p.$eval('#crQ', (e) => e.value), '', 'box after Reset');
    eq(await p.evaluate(() => state.creatorFilters.q), '', 'filter after Reset');
  });

  await step('the tier select still filters, and immediately', async () => {
    await p.selectOption('#crTier', 'macro');
    await p.waitForTimeout(250);
    eq(await p.evaluate(() => state.creatorFilters.tier), 'macro', 'tier filter');
  });

  await ctx.close();
}

/* ================= 2. the phone shell ================= */
/* The old shape was a desktop three-column layout with the middle column
   turned into a slide-over: a 56px rail of unlabelled glyphs, a 113px
   header carrying a search box, and a menu covering 278 of 390px. Three
   layers deep to reach one campaign, and no way to tell where you were.

   The shape now is one column, one page at a time, and a bottom bar:
   tap a section, get its list, tap a row, get the page, ← to go back. */
for (const [label, dev, size] of [['iPhone 13', 'iPhone 13', null], ['narrow 320x640', null, { width: 320, height: 640 }]]) {
  console.log(`\n     phone shell · ${label}\n`);
  const { ctx, p } = await open(dev, size);
  const vw = p.viewportSize().width;
  const box = (sel) => p.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const cs = getComputedStyle(e);
    if (cs.display === 'none') return 'hidden';
    const r = e.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right),
             w: Math.round(r.width), h: Math.round(r.height) };
  }, sel);
  const inDetail = () => p.evaluate(() => document.body.classList.contains('m-detail'));

  await step('there is no icon rail eating the width', async () => {
    eq(await box('.rail'), 'hidden', '.rail');
  });

  await step('the bottom bar is there, and is the full width', async () => {
    const b = await box('.mbar');
    if (b === 'hidden' || !b) throw new Error('no bottom bar');
    eq(b.w, vw, 'bar width');
    if (b.h < 44) throw new Error(`bar is only ${b.h}px tall`);
  });

  await step('it names five places, in words rather than glyphs', async () => {
    const labels = await p.$$eval('.mbar a .ml', (n) => n.map((x) => x.textContent.trim()));
    eq(labels.length, 5, 'tab count');
    if (labels.some((t) => !t)) throw new Error('an unlabelled tab: ' + JSON.stringify(labels));
  });

  await step('the bar keeps clear of the rounded corners and the bottom edge', async () => {
    /* A rounded screen bites both bottom corners, and the bite lands on
       the first and last tab. env(safe-area-inset-*) reports the bite
       only once a page opts into drawing under the system UI — this one
       does not, so on a phone it reads 0 and any padding built purely on
       it does nothing at all. There has to be a floor. */
    const m = await p.evaluate(() => {
      const tabs = [...document.querySelectorAll('.mbar a')].map((e) => e.getBoundingClientRect());
      return { left: Math.round(tabs[0].left),
               right: Math.round(innerWidth - tabs[tabs.length - 1].right),
               below: Math.round(Math.min(...tabs.map((r) => innerHeight - r.bottom))) };
    });
    if (m.left < 8) throw new Error(`first tab is ${m.left}px from the left edge`);
    if (m.right < 8) throw new Error(`last tab is ${m.right}px from the right edge`);
    if (m.below < 8) throw new Error(`labels are ${m.below}px off the bottom edge`);
  });

  await step('every tab is a thumb-sized target', async () => {
    const small = await p.$$eval('.mbar a', (n) => n.map((e) => {
      const r = e.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    }).filter((r) => r.h < 40 || r.w < 40));
    if (small.length) throw new Error(JSON.stringify(small));
  });

  await step('a section opens on its list, not on a page you did not pick', async () => {
    await go(p, '#/campaigns/all/active');
    await p.click('[data-mtab="campaigns"]');
    await p.waitForTimeout(700);
    if (await inDetail()) throw new Error('landed in a detail page');
    const rows = await p.$$eval('.panel-item', (n) => n.length);
    if (!rows) throw new Error('the list is empty');
  });

  await step('the list is the whole screen above the bar — no sliver of another page', async () => {
    const pn = await box('.panel'), bar = await box('.mbar');
    eq(pn.left, 0, 'list left');
    eq(pn.w, vw, 'list width');
    if (Math.abs(pn.top + pn.h - bar.top) > 2)
      throw new Error(`list ends at ${pn.top + pn.h}, bar starts at ${bar.top}`);
  });

  await step('tapping a row opens that page', async () => {
    const name = await p.$eval('.panel-item:not(.active) .pi-t', (e) => e.textContent.trim());
    await p.click('.panel-item:not(.active)');
    await p.waitForTimeout(800);
    if (!(await inDetail())) throw new Error('still on the list');
    const title = await p.$eval('#pageTitle', (e) => e.textContent.trim());
    if (!title) throw new Error('no title on the page');
    if (await box('.panel') !== 'hidden') throw new Error('the list is still on top of it');
    return name;
  });

  await step('the header is one row, and carries a back arrow', async () => {
    const t = await box('.topbar');
    if (t.h > 64) throw new Error(`header is ${t.h}px tall`);
    eq(t.left, 0, 'header left');
    const glyph = await p.$eval('#panelToggle', (e) => e.textContent.trim());
    if (glyph !== '\u2190') throw new Error('the button says ' + JSON.stringify(glyph) + ', not back');
  });

  await step('back returns to the list', async () => {
    await p.click('#panelToggle');
    await p.waitForTimeout(600);
    if (await inDetail()) throw new Error('still in the page');
    if (!(await p.$('.panel-item'))) throw new Error('the list did not come back');
  });

  await step('another tab switches section and opens on its list', async () => {
    await p.click('[data-mtab="creators"]');
    await p.waitForTimeout(900);
    if (await inDetail()) throw new Error('jumped straight into a page');
    const active = await p.$eval('.mbar a.active .ml', (e) => e.textContent.trim());
    eq(active, 'Creators', 'active tab');
  });

  await step('More reaches the sections that are not in the bar', async () => {
    await p.click('#mMore');
    await p.waitForTimeout(600);
    const rest = await p.$$eval('[data-mmore] .pi-t', (n) => n.map((x) => x.textContent.trim()));
    for (const want of ['Messages', 'Contracts', 'Analytics', 'Setup'])
      if (!rest.includes(want)) throw new Error(want + ' is unreachable: ' + rest.join(', '));
    await p.click('[data-mmore]');
    await p.waitForTimeout(800);
  });

  await step('nothing hides under the bottom bar', async () => {
    await go(p, '#/campaigns/all/active');
    await p.waitForTimeout(600);
    const covered = await p.evaluate(() => {
      const bar = document.querySelector('.mbar').getBoundingClientRect();
      const view = document.querySelector('#view');
      view.scrollTop = view.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
      const last = [...view.querySelectorAll('button, a[href], select')].pop();
      if (!last) return null;
      const r = last.getBoundingClientRect();
      return r.bottom > bar.top + 1 ? last.textContent.trim().slice(0, 30) : null;
    });
    if (covered) throw new Error('the bar sits on top of: ' + covered);
  });

  await step('the page does not scroll sideways', async () => {
    const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 2) throw new Error(`${over}px wider than the screen`);
  });

  await step('typing in the creator search still works here', async () => {
    await p.click('[data-mtab="creators"]');
    await p.waitForTimeout(700);
    await p.click('.panel-item');
    await p.waitForTimeout(800);
    await p.click('#crQ');
    await p.keyboard.type('julia', { delay: 45 });
    await settle(p);
    eq(await p.$eval('#crQ', (e) => e.value), 'julia', 'value on a phone');
  });

  await ctx.close();
}

/* ================= 3. the desktop is untouched ================= */
console.log('\n     desktop 1440x900 · unchanged\n');
{
  const { ctx, p } = await open(null, { width: 1440, height: 900 });
  await step('the rail and the menu are both still columns', async () => {
    const m = await p.evaluate(() => {
      const panel = document.querySelector('.panel');
      const rail = document.querySelector('.rail');
      return { pos: getComputedStyle(panel).position,
               left: Math.round(panel.getBoundingClientRect().left),
               rail: getComputedStyle(rail).display };
    });
    eq(m.pos, 'sticky', 'menu position');
    if (m.rail === 'none') throw new Error('the rail is gone on a desktop');
    if (m.left < 40) throw new Error('the menu is not beside the rail');
  });
  await step('there is no bottom bar in the way', async () => {
    eq(await p.evaluate(() => getComputedStyle(document.querySelector('.mbar')).display), 'none', 'bar display');
  });
  await step('hiding and showing the menu still works the same way', async () => {
    await p.click('#panelToggle');
    await p.waitForTimeout(300);
    if (!(await p.evaluate(() => document.body.classList.contains('panel-closed')))) throw new Error('did not hide');
    await p.click('#panelToggle');
    await p.waitForTimeout(300);
    if (await p.evaluate(() => document.body.classList.contains('panel-closed'))) throw new Error('did not come back');
  });
  await step('the desktop never enters the phone drill-down', async () => {
    if (await p.evaluate(() => document.body.classList.contains('m-detail')))
      throw new Error('m-detail leaked onto the desktop');
  });
  await ctx.close();
}

await b.close();
console.log('\nerrors: ' + (errs.length ? errs.join(' | ') : 'none'));
process.exit(errs.length ? 1 : 0);
