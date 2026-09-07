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

/* ================= 2. the phone menu ================= */
for (const [label, dev, size] of [['iPhone 13', 'iPhone 13', null], ['narrow 320x640', null, { width: 320, height: 640 }]]) {
  console.log(`\n     phone menu · ${label}\n`);
  const { ctx, p } = await open(dev, size);
  const vw = p.viewportSize().width;

  const box = (sel) => p.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right),
             w: Math.round(r.width), h: Math.round(r.height),
             z: cs.zIndex, pos: cs.position, opacity: +cs.opacity, events: cs.pointerEvents };
  }, sel);

  await step('the header is one or two rows, not three', async () => {
    const t = await box('.topbar');
    if (t.h > 120) throw new Error(`topbar is ${t.h}px tall`);
  });

  await step('one tap of ☰ opens the menu', async () => {
    await p.click('#panelToggle');
    await p.waitForTimeout(400);
    if (!(await p.evaluate(() => document.body.classList.contains('panel-open'))))
      throw new Error('first tap did not open it');
    const pn = await box('.panel');
    if (pn.left < 0) throw new Error(`still off-screen at left ${pn.left}`);
  });

  await step('the menu starts below the header instead of covering it', async () => {
    const t = await box('.topbar'), pn = await box('.panel');
    if (pn.top < t.h - 1) throw new Error(`menu top ${pn.top} is above header bottom ${t.h}`);
  });

  await step('the whole header is still reachable with the menu open', async () => {
    const hidden = await p.evaluate(() => {
      const out = [];
      for (const sel of ['#panelToggle', '#pageTitle', '#btnSaveNow', '#globalSearch']) {
        const e = document.querySelector(sel);
        if (!e) continue;
        const r = e.getBoundingClientRect();
        if (r.width === 0) continue;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit || (hit !== e && !e.contains(hit) && !hit.contains(e))) out.push(sel + ' → ' + (hit ? hit.id || hit.className : 'nothing'));
      }
      return out;
    });
    if (hidden.length) throw new Error('covered: ' + hidden.join(', '));
  });

  await step('there is a backdrop behind it', async () => {
    const sc = await box('.panel-scrim');
    if (!sc) throw new Error('no .panel-scrim in the page');
    if (sc.opacity < 0.2) throw new Error(`backdrop is invisible (opacity ${sc.opacity})`);
    if (sc.events === 'none') throw new Error('backdrop does not take taps');
  });

  await step('the menu leaves a strip of page wide enough to aim at', async () => {
    const pn = await box('.panel');
    const strip = vw - pn.right;
    if (strip < 40) throw new Error(`only ${strip}px of page left beside a ${pn.w}px menu`);
  });

  await step('tapping that strip closes the menu', async () => {
    const pn = await box('.panel');
    const t = await box('.topbar');
    await p.mouse.click(pn.right + Math.min(24, (vw - pn.right) / 2), t.h + 120);
    await p.waitForTimeout(400);
    if (await p.evaluate(() => document.body.classList.contains('panel-open')))
      throw new Error('still open');
  });

  await step('picking something from the menu closes it', async () => {
    await p.click('#panelToggle');
    await p.waitForTimeout(350);
    await go(p, '#/creators/all');
    if (await p.evaluate(() => document.body.classList.contains('panel-open')))
      throw new Error('menu stayed over the page it just opened');
  });

  await step('the rail is still there once the menu is closed', async () => {
    const r = await box('.rail');
    if (!r || r.w < 40) throw new Error('rail is gone');
  });

  await step('the page still does not scroll sideways', async () => {
    const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 2) throw new Error(`document is ${over}px wider than the screen`);
  });

  await step('typing in the creator search works here too', async () => {
    await go(p, '#/creators/all');
    await p.click('#crQ');
    await p.keyboard.type('julia', { delay: 45 });
    await settle(p);
    eq(await p.$eval('#crQ', (e) => e.value), 'julia', 'value on a phone');
  });

  await ctx.close();
}

/* ================= 3. the desktop menu is untouched ================= */
console.log('\n     desktop 1440x900 · the menu is still a column\n');
{
  const { ctx, p } = await open(null, { width: 1440, height: 900 });
  await step('the menu is a sticky column, not an overlay', async () => {
    const m = await p.evaluate(() => {
      const e = document.querySelector('.panel');
      const cs = getComputedStyle(e);
      return { pos: cs.position, left: Math.round(e.getBoundingClientRect().left) };
    });
    eq(m.pos, 'sticky', 'position');
    if (m.left < 40) throw new Error('menu is not beside the rail');
  });
  await step('the backdrop stays out of the way', async () => {
    eq(await p.evaluate(() => getComputedStyle(document.querySelector('.panel-scrim')).display), 'none', 'scrim display');
  });
  await step('hiding and showing it still works the same way', async () => {
    await p.click('#panelToggle');
    await p.waitForTimeout(300);
    if (!(await p.evaluate(() => document.body.classList.contains('panel-closed')))) throw new Error('did not hide');
    await p.click('#panelToggle');
    await p.waitForTimeout(300);
    if (await p.evaluate(() => document.body.classList.contains('panel-closed'))) throw new Error('did not come back');
  });
  await ctx.close();
}

await b.close();
console.log('\nerrors: ' + (errs.length ? errs.join(' | ') : 'none'));
process.exit(errs.length ? 1 : 0);
