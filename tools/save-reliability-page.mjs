/* Does a save actually happen, and does the person find out either way?

   The reported bug: a campaign created, the page refreshed, the campaign
   gone — and no message at any point saying it had or had not been
   stored. Three things in serverSave() made that possible, and all three
   returned quietly:

     if (SERVER.busy) return;                       // dropped mid-flight
     if (SERVER.configured === false && !force) return;
     if (!force && json === lastServerJson) return; // Save button says nothing

   The first is the one that lost the campaign. Creating one saves
   immediately; the autosave debounce is two seconds; so a campaign
   created within two seconds of any other change hit a save already in
   flight, was dropped, and its caller's promise resolved anyway — so the
   toast said it had been saved.

   This drives a real browser against a real server-of-record, and every
   assertion is about what the server ended up holding, or what the
   person was told. */
import { chromium } from 'playwright';
import { signIn } from './harness-auth.mjs';
import fs from 'fs';

const seed = fs.readFileSync('tmp/seed.json', 'utf8');
const seedObj = JSON.parse(seed);
const APP = process.argv[2] || 'http://localhost:3120/';
const errs = [];
const step = async (n, fn) => {
  try { await fn(); console.log('ok   ' + n); }
  catch (e) { console.log('FAIL ' + n + ' — ' + e.message); errs.push(n); }
};

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

/* A stand-in for the database: it keeps whatever the last accepted POST
   sent, and hands the same thing back on the next GET — so "create it,
   reload, is it there" is a question this harness can actually answer.
   `slow` holds each POST open, which is how a second save arrives while
   the first is still in flight. */
async function session(opts) {
  opts = opts || {};
  const ctx = await b.newContext();
  await signIn(ctx);
  await ctx.addInitScript(([s]) => {
    localStorage.removeItem('vively-workspace-v1');
    localStorage.setItem('vively-auth-user-v1', JSON.stringify({ email: 'k@v.com', name: 'K' }));
  }, [seed]);

  const store = { db: JSON.parse(JSON.stringify(seedObj.db)), revision: 7, posts: 0, gate: null };
  store.hold = () => { let go; store.gate = new Promise((r) => { go = r; }); return go; };
  const p = await ctx.newPage();
  const toasts = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

  await p.route('**/api/workspace', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: { db: store.db, settings: seedObj.settings || {},
          savedAt: new Date().toISOString(), revision: store.revision } }) });
    }
    if (req.method() === 'POST') {
      store.posts++;
      if (opts.conflict) {
        /* what another browser saving first looks like: every save is
           refused until somebody decides whose version wins */
        return route.fulfill({ status: 409, contentType: 'application/json',
          body: JSON.stringify({ error: 'conflict', revision: 99, savedAt: new Date().toISOString() }) });
      }
      /* `gate` holds a POST open until the test lets it go, which is how
         a second save is made to arrive while the first is still in
         flight. A fixed delay could not do it: clicking through the
         drawer takes longer than any delay short enough to be sane. */
      if (store.gate) { await store.gate; store.gate = null; }
      if (opts.slow) await new Promise((r) => setTimeout(r, opts.slow));
      if (opts.failPosts) {
        return route.fulfill({ status: 500, contentType: 'application/json',
          body: JSON.stringify({ error: 'the database is unreachable' }) });
      }
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch (e) { /* keep the old copy */ }
      if (body.db) { store.db = body.db; store.revision++; }
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, savedAt: new Date().toISOString(), revision: store.revision }) });
    }
    return route.continue();
  });

  /* Every toast the person actually saw. #toast is one reused element,
     so this watches it change rather than counting elements. */
  await p.exposeFunction('__sawToast', (t) => toasts.push(t));
  await p.addInitScript(() => {
    const start = () => {
      const el = document.getElementById('toast');
      if (!el) return setTimeout(start, 50);
      let last = '';
      new MutationObserver(() => {
        const t = el.textContent.trim();
        if (t && t !== last) { last = t; window.__sawToast(t); }
      }).observe(el, { childList: true, characterData: true, subtree: true });
    };
    start();
  });

  await p.goto(APP, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1900);
  return { ctx, p, store, toasts };
}

/* Create a campaign through the real drawer, exactly as a person does. */
async function createCampaign(p, brand) {
  await p.evaluate((h) => { location.hash = h; }, '#/campaigns/all/active');
  await p.waitForTimeout(700);
  await p.click("#cpNew");
  await p.waitForTimeout(500);
  await p.fill('#ncBrand', brand);
  await p.fill('#ncName', brand + ' seeding');
  await p.click('#ncSave');
}

/* ============ 1. created, then still there after a reload ============ */
console.log('\n     a campaign created two seconds after another change\n');
{
  const { ctx, p, store, toasts } = await session({});

  await step('a campaign created while another save is in flight still reaches the server', async () => {
    /* the exact shape of the bug: touch something so the two-second
       autosave is armed, hold that save open, then create a campaign
       while it is still in the air. */
    const release = store.hold();
    await p.evaluate(() => {
      DB.campaigns[0].note = 'edited at ' + Date.now();
      persist(true);
    });
    await p.waitForTimeout(2400);          // the autosave fires and hangs on the gate
    const postsBefore = store.posts;
    if (postsBefore < 1) throw new Error('the autosave never left — the setup is wrong, not the app');
    await createCampaign(p, '굽네 치킨');
    await p.waitForTimeout(400);
    release();                             // let the first save land
    await p.waitForTimeout(3500);          // and the second

    const brands = await p.evaluate(() => DB.campaigns.map((c) => c.brand));
    if (!brands.includes('굽네 치킨')) throw new Error('it is not even in the page');
    const onServer = store.db.campaigns.map((c) => c.brand);
    if (!onServer.includes('굽네 치킨'))
      throw new Error('the page has it but the server does not — this is the bug');
  });

  await step('and it is still there after a reload', async () => {
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(2200);
    const brands = await p.evaluate(() => DB.campaigns.map((c) => c.brand));
    if (!brands.includes('굽네 치킨')) throw new Error('gone after refresh');
  });

  await step('and the person was told it was saved', async () => {
    const said = toasts.join(' | ');
    if (!/Campaign created/.test(said)) throw new Error('nothing was said at all: ' + said);
    if (!/saved/i.test(said)) throw new Error('never said it was saved: ' + said);
    if (/click Save to store/i.test(said)) throw new Error('told to save something already saved: ' + said);
  });

  await ctx.close();
}

/* ============ 2. when it does NOT save, it says so ============ */
console.log('\n     when the server refuses\n');
{
  const { ctx, p, toasts } = await session({ failPosts: true });

  await step('a campaign that could not be stored says NOT SAVED, not "created"', async () => {
    await createCampaign(p, '실패 테스트');
    await p.waitForTimeout(2500);
    const said = toasts.join(' | ');
    if (!/NOT SAVED/.test(said)) throw new Error('reported as if it worked: ' + said);
    if (!/database is unreachable/.test(said)) throw new Error('did not say why: ' + said);
  });

  await step('the badge shows the failure rather than a comfortable "Saved"', async () => {
    const t = await p.$eval('#saveBadge', (e) => e.textContent + '|' + e.className);
    if (!/warn/.test(t)) throw new Error('badge is not warning: ' + t);
  });

  await step('a failing autosave is reported once, not silently forever', async () => {
    const before = toasts.length;
    await p.evaluate(() => { DB.campaigns[0].note = 'x' + Date.now(); persist(true); });
    await p.waitForTimeout(3000);
    /* it already said so; it must not say so again on every retry */
    const added = toasts.slice(before).filter((t) => /NOT SAVED/.test(t));
    if (added.length > 1) throw new Error('shouted ' + added.length + ' times');
  });

  await ctx.close();
}

/* ============ 3. another browser got there first ============ */
console.log('\n     when another browser saved first\n');
{
  /* The likeliest way a campaign really went missing. One stale revision
     and every silent autosave is refused from then on — and the badge
     that said so was hidden below 1240px, which is most laptops and
     every phone. So the work piled up unsaved, invisibly, until a
     refresh replaced it with the server's copy. */
  const { ctx, p, toasts } = await session({ conflict: true });

  await step('a refused autosave is said out loud rather than only in a hidden badge', async () => {
    await p.evaluate(() => { DB.campaigns[0].note = 'mine ' + Date.now(); persist(true); });
    await p.waitForTimeout(3200);
    const said = toasts.join(' | ');
    if (!/more recently/i.test(said)) throw new Error('never mentioned: ' + said);
  });

  await step('the badge says it needs attention, at laptop width too', async () => {
    await p.setViewportSize({ width: 1100, height: 800 });
    await p.waitForTimeout(400);
    const t = await p.evaluate(() => {
      const e = document.getElementById('saveBadge');
      return { cls: e.className, shown: getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0,
               tip: e.title };
    });
    if (!t.shown) throw new Error('nothing shown at 1100px — this is where it was hidden');
    if (!/warn/.test(t.cls)) throw new Error('not warning: ' + t.cls);
    if (!/another browser/i.test(t.tip)) throw new Error('tooltip does not explain: ' + t.tip);
  });

  await ctx.close();
}

/* ============ 4. the Save button always answers ============ */
console.log('\n     the Save button\n');
{
  const { ctx, p, toasts } = await session({});

  await step('Save with a real change says Saved', async () => {
    await p.evaluate(() => { DB.campaigns[0].note = 'changed ' + Date.now(); });
    const before = toasts.length;
    await p.click('#btnSaveNow');
    await p.waitForTimeout(1500);
    const said = toasts.slice(before).join(' | ');
    if (!/Saved/.test(said)) throw new Error('said: ' + JSON.stringify(said));
  });

  await step('Save with nothing to save still answers — it used to say nothing at all', async () => {
    const before = toasts.length;
    await p.click('#btnSaveNow');
    await p.waitForTimeout(1500);
    const said = toasts.slice(before).join(' | ');
    if (!said) throw new Error('silence — indistinguishable from a save that failed');
    if (!/Already saved/.test(said)) throw new Error('said: ' + JSON.stringify(said));
  });

  await step('the badge is visible on a narrow screen, where it used to be hidden entirely', async () => {
    await p.setViewportSize({ width: 390, height: 700 });
    await p.waitForTimeout(400);
    const vis = await p.evaluate(() => {
      const e = document.getElementById('saveBadge');
      const r = e.getBoundingClientRect();
      return { shown: getComputedStyle(e).display !== 'none' && r.width > 0, w: Math.round(r.width) };
    });
    if (!vis.shown) throw new Error('no save state shown at 390px at all');
    if (vis.w > 60) throw new Error(`badge is ${vis.w}px wide — the sentence should be hidden, not the light`);
  });

  await ctx.close();
}

await b.close();
console.log('\nerrors: ' + (errs.length ? errs.join(' | ') : 'none'));
process.exit(errs.length ? 1 : 0);
