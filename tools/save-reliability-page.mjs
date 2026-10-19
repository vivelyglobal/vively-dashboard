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

  const store = { db: JSON.parse(JSON.stringify(seedObj.db)), revision: 7, posts: 0, refused: 0, gate: null };
  store.hold = () => { let go; store.gate = new Promise((r) => { go = r; }); return go; };
  const p = await ctx.newPage();
  const toasts = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

  await p.route('**/api/workspace', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: { db: store.db, settings: store.settings || seedObj.settings || {},
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
      if (opts.realLock) {
        /* The real server's optimistic lock, which `conflict` above does
           not model: it refuses only while the client's revision is
           behind. That difference is why a harness that always said 409
           could not catch a client that stopped being behind. */
        let body = {};
        try { body = JSON.parse(req.postData() || '{}'); } catch (e) { /* treated as stale */ }
        if (!body.force && body.revision !== store.revision) {
          store.refused++;
          return route.fulfill({ status: 409, contentType: 'application/json',
            body: JSON.stringify({ error: 'conflict', revision: store.revision, savedAt: new Date().toISOString() }) });
        }
        if (body.db) { store.db = body.db; store.revision++; }
        if (body.settings) store.settings = body.settings;
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ ok: true, savedAt: new Date().toISOString(), revision: store.revision }) });
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

  await step('a save state is visible on a phone, on both kinds of page', async () => {
    /* The phone shell has two pages and only one of them has a topbar, so
       "is the badge visible" has to be asked of both — a save state that
       shows on some screens is the same as no save state at all. */
    await p.setViewportSize({ width: 390, height: 700 });
    await p.waitForTimeout(600);
    const seen = await p.evaluate(() => [...document.querySelectorAll('.save-badge')]
      .map((e) => { const r = e.getBoundingClientRect();
        return { shown: getComputedStyle(e).display !== 'none' && r.width > 0, w: Math.round(r.width) }; })
      .filter((x) => x.shown));
    if (!seen.length) throw new Error('no save state shown at 390px at all');
    if (seen.some((x) => x.w > 70)) throw new Error('the sentence should be hidden, not the light: ' + JSON.stringify(seen));
  });

  await step('and a Save button to retry with, wherever you are', async () => {
    const reachable = await p.evaluate(() => [...document.querySelectorAll('[data-save-now]')]
      .filter((e) => e.getBoundingClientRect().width > 0).length);
    if (!reachable) throw new Error('nothing to press when a save has failed');
  });

  await ctx.close();
}

/* ============ N. the partner link another browser just made ============ */
console.log('\n     a partner link made in another browser\n');
{
  /* The reported bug, end to end. Two people, one document. The stale tab
     used to take the server's new revision number on a 409 without taking
     its data, so the very next autosave — armed by any click, nobody
     deciding anything — passed the lock and wrote the old copy over the
     new link. The venue's link then 404'd, and both people saw "Saved". */
  const { ctx, p, store, toasts } = await session({ realLock: true });

  await step('this tab is up to date to begin with', async () => {
    const rev = await p.evaluate(() => SERVER.revision);
    if (rev !== 7) throw new Error('revision ' + rev);
    const n = await p.evaluate(() => DB.partnerLinks.length);
    if (n !== (store.db.partnerLinks || []).length) throw new Error('links out of step at the start');
  });

  /* somebody else creates a partner link and saves it */
  const linkCount = (store.db.partnerLinks || []).length;
  store.db.partnerLinks = (store.db.partnerLinks || []).concat([{
    partner: 'SPLABAB', token: 'tok-from-the-other-browser', createdAt: new Date().toISOString(), revokedAt: null
  }]);
  store.revision = 8;

  await step('the first autosave from this tab is refused, and says so', async () => {
    const before = toasts.length;
    await p.evaluate(() => { DB.campaigns[0].note = 'mine ' + Date.now(); persist(true); });
    await p.waitForTimeout(3200);
    const said = toasts.slice(before).join(' | ');
    if (!/more recently/i.test(said)) throw new Error('never said: ' + said);
    if (store.refused !== 1) throw new Error('refusals: ' + store.refused);
  });

  await step('it does not quietly become up to date — the revision stays behind', async () => {
    const rev = await p.evaluate(() => SERVER.revision);
    if (rev !== 7) throw new Error('adopted the server revision: ' + rev);
  });

  await step('so the next autosave is refused too, instead of overwriting', async () => {
    await p.evaluate(() => { DB.campaigns[0].note = 'mine again ' + Date.now(); persist(true); });
    await p.waitForTimeout(3200);
    if (store.refused < 2) throw new Error('the second save was accepted — refusals: ' + store.refused);
  });

  await step('the other browser\'s partner link is still on the server', async () => {
    const links = store.db.partnerLinks || [];
    if (links.length !== linkCount + 1) throw new Error(links.length + ' links, expected ' + (linkCount + 1));
    if (!links.some((l) => l.token === 'tok-from-the-other-browser')) throw new Error('the new link is gone');
  });

  await step('and the save state still says it needs attention, not Saved', async () => {
    const t = await p.evaluate(() => {
      const e = document.getElementById('saveBadge');
      return { cls: e.className, tip: e.title, status: SERVER.status };
    });
    if (t.status !== 'conflict') throw new Error('status: ' + t.status);
    if (!/warn/.test(t.cls)) throw new Error('badge not warning: ' + t.cls);
  });

  await step('reloading brings their link into this tab', async () => {
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1900);
    const seen = await p.evaluate(() => DB.partnerLinks.map((l) => l.token));
    if (!seen.includes('tok-from-the-other-browser')) throw new Error('not loaded: ' + seen.join(','));
    const rev = await p.evaluate(() => SERVER.revision);
    if (rev !== 8) throw new Error('revision after reload: ' + rev);
  });

  await step('and from there a normal save is accepted again', async () => {
    await p.evaluate(() => { DB.campaigns[0].note = 'after reload ' + Date.now(); persist(true); });
    await p.waitForTimeout(3200);
    if (store.revision !== 9) throw new Error('revision: ' + store.revision);
    if (!(store.db.partnerLinks || []).some((l) => l.token === 'tok-from-the-other-browser')) {
      throw new Error('saving after the reload dropped their link');
    }
  });

  await ctx.close();
}

/* ============ N+1. settings survive the round trip ============ */
console.log('\n     the holiday list\n');
{
  /* Only hideBlocked was read back out of the stored settings, so the
     hand-maintained holiday list was dropped on load and then written
     away by the next save. One person, no conflict needed. */
  const { ctx, p, store } = await session({ realLock: true });

  await step('a holiday added here reaches the server', async () => {
    await p.evaluate(() => {
      SETTINGS.holidays = [{ d: '2026-12-25', n: 'Christmas' }];
      DB.campaigns[0].note = 'touch ' + Date.now();
      persist(true);
    });
    await p.waitForTimeout(3200);
    const hol = (store.settings || {}).holidays || [];
    if (!hol.some((h) => h.d === '2026-12-25')) throw new Error('not saved: ' + JSON.stringify(store.settings));
  });

  await step('and is still there after a reload, instead of being dropped', async () => {
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1900);
    const hol = await p.evaluate(() => (SETTINGS.holidays || []).map((h) => h.d));
    if (!hol.includes('2026-12-25')) throw new Error('lost on load: ' + hol.join(','));
  });

  await step('the next save keeps it rather than writing it away', async () => {
    await p.evaluate(() => { DB.campaigns[0].note = 'again ' + Date.now(); persist(true); });
    await p.waitForTimeout(3200);
    const hol = (store.settings || {}).holidays || [];
    if (!hol.some((h) => h.d === '2026-12-25')) throw new Error('written away: ' + JSON.stringify(store.settings));
  });

  await ctx.close();
}

/* ============ N+2. what leaves the dashboard ============ */
console.log('\n     the backup file and signing out\n');
{
  const { ctx, p } = await session({ realLock: true });

  await step('a creator with bank details is what we are protecting', async () => {
    const n = await p.evaluate(() => {
      DB.creators[0].payout = { bank: 'KB', name: 'Real Name', number: '1234-5678-9012' };
      return DB.creators.filter((c) => c.payout && c.payout.number).length;
    });
    if (!n) throw new Error('no payout to strip');
  });

  await step('the backup a person downloads carries no account number', async () => {
    await p.evaluate(() => { location.hash = '#/settings/sources'; });
    await p.waitForTimeout(900);
    const [dl] = await Promise.all([
      p.waitForEvent('download'),
      p.click('#setExportAll')
    ]);
    const path = await dl.path();
    const text = await fs.promises.readFile(path, 'utf8');
    if (text.includes('1234-5678-9012')) throw new Error('the account number is in the file');
    if (/"payout"/.test(text)) throw new Error('payout objects are in the file');
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.db.creators) || !parsed.db.creators.length) throw new Error('the backup is empty');
    if (!parsed.db.creators[0].handle) throw new Error('it stripped more than the payout');
  });

  await step('signing out takes the workspace off this machine', async () => {
    const before = await p.evaluate(() => (localStorage.getItem('vively-workspace-v1') || '').length);
    if (!before) throw new Error('nothing was stored to begin with');
    await p.evaluate(() => signOut());
    await p.waitForTimeout(700);
    const after = await p.evaluate(() => ({
      stored: localStorage.getItem('vively-workspace-v1'),
      creators: DB.creators.length, campaigns: DB.campaigns.length, links: DB.partnerLinks.length,
      locked: document.body.classList.contains('auth-locked')
    }));
    if (after.stored !== null) throw new Error('the local copy is still there: ' + after.stored.length + ' bytes');
    if (after.creators || after.campaigns || after.links) throw new Error('still in memory: ' + JSON.stringify(after));
    if (!after.locked) throw new Error('the page did not lock');
  });

  await ctx.close();
}

await b.close();
console.log('\nerrors: ' + (errs.length ? errs.join(' | ') : 'none'));
process.exit(errs.length ? 1 : 0);
