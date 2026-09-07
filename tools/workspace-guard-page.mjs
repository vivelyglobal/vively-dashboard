/* The client half of the wipe protection, in a real browser.

   The bug was never visible in a unit test because it needed three
   things at once: no local copy, a load that failed, and a tab being
   closed. So this drives exactly that, and watches what the page tries
   to send. Every assertion is about the request the browser makes —
   not about what a function returns — because the request is what
   reached the database. */
import { chromium } from 'playwright';
import { signIn } from './harness-auth.mjs';
import fs from 'fs';

const seed = fs.readFileSync('tmp/seed.json', 'utf8');
const APP = process.argv[2] || 'http://localhost:3120/';
const errs = [];
const step = async (n, fn) => {
  try { await fn(); console.log('ok   ' + n); }
  catch (e) { console.log('FAIL ' + n + ' — ' + e.message); errs.push(n); }
};

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

/* One page per scenario, because the whole point is what state the
   session starts in. `local` seeds this browser's storage; `loadStatus`
   is what GET /api/workspace answers with. */
const seedObj = JSON.parse(seed);

/* One page per scenario, because the whole point is what state the
   session starts in. `local` seeds this browser's storage; `loadStatus`
   is what GET /api/workspace answers with; `serverEmpty` makes a
   successful load return a workspace with nothing in it.

   Both verbs are intercepted. The harness server runs without a
   database and answers 503, which switches the client's server sync
   off entirely — so a test that did not fake the GET would prove only
   that a disabled feature stays disabled. */
async function session({ local, loadStatus, serverEmpty }) {
  const ctx = await b.newContext();
  await signIn(ctx);
  await ctx.addInitScript(([s, want]) => {
    if (want) localStorage.setItem('vively-workspace-v1', s);
    else localStorage.removeItem('vively-workspace-v1');
    localStorage.setItem('vively-auth-user-v1', JSON.stringify({ email: 'k@v.com', name: 'K' }));
  }, [seed, !!local]);

  const p = await ctx.newPage();
  const posts = [];
  p.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/workspace')) {
      let body = null;
      try { body = JSON.parse(r.postData() || '{}'); } catch (e) { body = { unparsed: true }; }
      posts.push(body);
    }
  });
  await p.route('**/api/workspace', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      if (loadStatus && loadStatus !== 200) {
        return route.fulfill({ status: loadStatus, contentType: 'application/json',
          body: JSON.stringify({ error: 'Sign in to continue.', auth: 'required' }) });
      }
      const db = serverEmpty
        ? { campaigns: [], creators: [], participants: [], appointments: [], partnerLinks: [], socialContent: [] }
        : seedObj.db;
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: { db, settings: seedObj.settings || {},
          savedAt: new Date().toISOString(), revision: 7 } }) });
    }
    if (req.method() === 'POST') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, savedAt: new Date().toISOString(), revision: 8 }) });
    }
    return route.continue();
  });

  await p.goto(APP, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1800);
  return { ctx, p, posts };
}

const closeTab = async (p) => {
  /* what the browser does on the way out */
  await p.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
  await p.waitForTimeout(700);
};
/* DB is a top-level const in a classic script, so it is reachable as a
   bare identifier but never as a property of window */
const counts = (p) => p.evaluate(() => (typeof DB === 'undefined'
  ? { campaigns: null, creators: null }
  : { campaigns: DB.campaigns.length, creators: DB.creators.length }));
/* a save is correctly skipped when the payload has not changed, so a
   test that wants to see one has to change something first */
const touch = (p) => p.evaluate(() => {
  if (typeof DB === 'undefined' || !DB.campaigns.length) return false;
  DB.campaigns[0].note = 'harness touch ' + Date.now();
  persist(true);
  return true;
});

/* ---- the exact failure that lost the campaigns ------------------------ */

await step('a fresh browser whose load was refused never writes anything back', async () => {
  /* no localStorage, and the session is expired: DB is the empty shell
     it started as. Closing the tab used to force-post that over the
     real workspace. */
  const { ctx, p, posts } = await session({ local: false, loadStatus: 401 });
  await closeTab(p);
  if (posts.length) throw new Error('it posted ' + posts.length + ' time(s): ' + JSON.stringify(posts[0]).slice(0, 120));
  await ctx.close();
});

await step('a fresh browser with a working load, but no data yet, stays quiet', async () => {
  const { ctx, p, posts } = await session({ local: false, loadStatus: 200, serverEmpty: true });
  await closeTab(p);
  const empty = posts.filter((x) => x.db && !x.db.campaigns.length && !x.db.creators.length);
  if (empty.length) throw new Error('posted an empty workspace ' + empty.length + ' time(s)');
  await ctx.close();
});

await step('a refused load does not arm the autosave either', async () => {
  /* the beacon is the loud path; the 2-second autosave is the quiet
     one, and it has to be shut too */
  const { ctx, p, posts } = await session({ local: false, loadStatus: 401 });
  await p.evaluate(() => { if (typeof persist === 'function') persist(true); });
  await p.waitForTimeout(2600);
  if (posts.length) throw new Error('the autosave fired: ' + JSON.stringify(posts[0]).slice(0, 120));
  await ctx.close();
});

/* ---- and the cases that must keep working ---------------------------- */

await step('a browser with its own copy still saves on close', async () => {
  /* the load is refused, but this browser restored a real workspace of
     its own — that work is worth keeping and must still go back */
  const { ctx, p, posts } = await session({ local: true, loadStatus: 401 });
  const n = await counts(p);
  if (!n.campaigns) throw new Error('the local copy did not restore, so this proves nothing');
  await closeTab(p);
  if (!posts.length) throw new Error('a real local workspace was not written back');
  if (!posts[0].db.campaigns.length) throw new Error('it posted an empty db');
  await ctx.close();
});

await step('a normal session saves normally', async () => {
  const { ctx, p, posts } = await session({ local: true, loadStatus: 200 });
  if (!await touch(p)) throw new Error('nothing to change, so this proves nothing');
  await p.waitForTimeout(2600);
  if (!posts.length) throw new Error('a normal save did not happen');
  const last = posts[posts.length - 1];
  if (!last.db.campaigns.length) throw new Error('a normal save carried an empty db');
  if (last.intent) throw new Error('a normal save must not carry a destructive intent');
  await ctx.close();
});

/* ---- the one supported way to empty it ------------------------------- */

await step('an intentional clear is still possible, and says so', async () => {
  const { ctx, p, posts } = await session({ local: true, loadStatus: 200 });
  const ok = await p.evaluate(async () => {
    if (!window.serverResetWorkspace) return 'missing';
    DB.campaigns.length = 0; DB.creators.length = 0; DB.participants.length = 0;
    await serverResetWorkspace();
    return 'called';
  });
  if (ok === 'missing') throw new Error('there is no explicit reset path at all');
  await p.waitForTimeout(600);
  const reset = posts.filter((x) => x.intent);
  if (!reset.length) throw new Error('the reset did not reach the server');
  if (reset[0].intent !== 'replace-with-empty') throw new Error('wrong intent: ' + reset[0].intent);
  if (reset[0].db.campaigns.length) throw new Error('the reset did not actually send an empty workspace');
  await ctx.close();
});

console.log('\nerrors: ' + (errs.length ? errs.join(' | ') : 'none'));
await b.close();
process.exit(errs.length ? 1 : 0);
