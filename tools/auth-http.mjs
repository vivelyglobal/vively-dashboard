/* The front door, tested from outside.

   The workspace document holds every creator's name, email, phone,
   address and bank details, and until now both reading it and
   replacing it were open to anyone who knew the URL. The unit tests
   cover the session mechanics; this covers the only question that
   really matters — that an anonymous caller gets nothing, and that the
   things which legitimately have no session still work.

   Start the server with:
     STAFF_EMAILS=staff@vively.test
     SIGNUP_CODE=harness-signup-code
     META_APP_SECRET / META_WEBHOOK_VERIFY_TOKEN  (for the webhook checks)
     PORT=3140
   tmp/start-auth.sh does this. */

const BASE = process.argv[2] || 'http://localhost:3140';
const STAFF = 'staff@vively.test';
const OUTSIDER = 'creator@example.test';
const PASSWORD = 'correct-horse-battery';
const CODE = process.env.SIGNUP_CODE || 'harness-signup-code';

const errs = [];
const step = async (n, fn) => {
  try { await fn(); console.log('ok   ' + n); }
  catch (e) { console.log('FAIL ' + n + ' — ' + e.message); errs.push(n); }
};

const call = (path, opts = {}) => fetch(BASE + path, {
  method: opts.method || 'GET',
  headers: Object.assign(
    opts.body ? { 'Content-Type': 'application/json' } : {},
    opts.cookie ? { Cookie: opts.cookie } : {},
    opts.headers || {}),
  body: opts.body ? JSON.stringify(opts.body) : undefined,
  redirect: 'manual'
});

const cookieFrom = (res) => {
  const raw = res.headers.get('set-cookie') || '';
  const m = raw.match(/vively_session=([^;]*)/);
  return m ? 'vively_session=' + m[1] : '';
};

/* Every route that reaches the workspace, Notion, the calendar or the
   partner comment store. If a route is added and not listed here, that
   is the gap this file is meant to make obvious. */
const GUARDED = [
  ['GET',  '/api/workspace'],
  ['POST', '/api/workspace', { db: { campaigns: [], creators: [], participants: [] } }],
  ['GET',  '/api/notion/database?id=x'],
  ['GET',  '/api/notion/query?id=x'],
  ['POST', '/api/notion/status', {}],
  ['GET',  '/api/calendar/status'],
  ['GET',  '/api/calendar/events'],
  ['POST', '/api/calendar/event', {}],
  ['POST', '/api/calendar/event/delete', {}],
  ['POST', '/api/calendar/test', {}],
  ['GET',  '/api/partner-comments'],
  ['POST', '/api/partner-comments/read', {}]
];

/* ---- set up two accounts: one staff, one not --------------------------- */

let staffCookie = '';

await step('signup needs the invite code', async () => {
  const r = await call('/api/signup', { method: 'POST',
    body: { name: 'Nobody', email: 'nobody@example.test', password: PASSWORD } });
  if (r.status !== 403) throw new Error('status ' + r.status + ' — signup is open');
  const wrong = await call('/api/signup', { method: 'POST',
    body: { name: 'Nobody', email: 'nobody@example.test', password: PASSWORD, code: 'guess' } });
  if (wrong.status !== 403) throw new Error('a wrong code was accepted: ' + wrong.status);
});

await step('two accounts can be created with the code', async () => {
  for (const email of [STAFF, OUTSIDER]) {
    const r = await call('/api/signup', { method: 'POST',
      body: { name: email, email, password: PASSWORD, code: CODE } });
    if (![201, 409].includes(r.status)) throw new Error(email + ' -> ' + r.status);
  }
});

await step('signing up does not hand out a session', async () => {
  /* an account is not an entitlement; it still has to pass the login */
  const r = await call('/api/signup', { method: 'POST',
    body: { name: 'Third', email: 'third@example.test', password: PASSWORD, code: CODE } });
  if (cookieFrom(r)) throw new Error('signup set a session cookie');
});

/* ---- the door ---------------------------------------------------------- */

await step('every guarded route refuses an anonymous caller', async () => {
  const open = [];
  for (const [method, path, body] of GUARDED) {
    const r = await call(path, { method, body });
    if (r.status !== 401) open.push(`${method} ${path} -> ${r.status}`);
  }
  if (open.length) throw new Error(open.join(' | '));
});

await step('a refusal gives away nothing about the workspace', async () => {
  const r = await call('/api/workspace');
  const text = await r.text();
  for (const leak of ['bank', 'creators', 'participants', 'campaigns', 'email'])
    if (new RegExp(leak, 'i').test(text)) throw new Error('the 401 body mentions "' + leak + '": ' + text.slice(0, 120));
});

await step('a made-up session cookie is not a session', async () => {
  const r = await call('/api/workspace', { cookie: 'vively_session=' + 'f'.repeat(64) });
  if (r.status !== 401) throw new Error('status ' + r.status);
});

/* ---- signing in -------------------------------------------------------- */

await step('the wrong password is still refused, and sets no cookie', async () => {
  const r = await call('/api/login', { method: 'POST', body: { email: STAFF, password: 'wrong' } });
  if (r.status !== 401) throw new Error('status ' + r.status);
  if (cookieFrom(r)) throw new Error('a failed login set a cookie');
});

await step('signing in as staff issues a session', async () => {
  const r = await call('/api/login', { method: 'POST', body: { email: STAFF, password: PASSWORD } });
  if (r.status !== 200) throw new Error('status ' + r.status + ' — ' + (await r.text()).slice(0, 120));
  const body = await r.json();
  if (body.staff !== true) throw new Error('staff flag was ' + body.staff);
  staffCookie = cookieFrom(r);
  if (!staffCookie) throw new Error('no session cookie');
  const raw = r.headers.get('set-cookie') || '';
  if (!/HttpOnly/.test(raw)) throw new Error('the cookie is readable by script');
  if (!/SameSite=Lax/i.test(raw)) throw new Error('the cookie is sent cross-site');
});

await step('the session opens every guarded route', async () => {
  const shut = [];
  for (const [method, path, body] of GUARDED) {
    const r = await call(path, { method, body, cookie: staffCookie });
    if (r.status === 401 || r.status === 403) shut.push(`${method} ${path} -> ${r.status}`);
  }
  if (shut.length) throw new Error(shut.join(' | '));
});

await step('the dashboard can ask who it is signed in as', async () => {
  const anon = await call('/api/me');
  if (anon.status !== 401) throw new Error('anonymous /api/me returned ' + anon.status);
  const r = await call('/api/me', { cookie: staffCookie });
  if (r.status !== 200) throw new Error('status ' + r.status);
  const body = await r.json();
  if (body.user.email !== STAFF) throw new Error('wrong user: ' + body.user.email);
  if (body.staff !== true) throw new Error('staff flag was ' + body.staff);
});

/* ---- signed in, but not staff ------------------------------------------ */

await step('an account outside STAFF_EMAILS is signed in and still refused', async () => {
  /* anyone who signed up through the open form but is not on the staff
     list lands here: a valid password, a real session, and no access to
     anybody's bank details */
  const login = await call('/api/login', { method: 'POST', body: { email: OUTSIDER, password: PASSWORD } });
  if (login.status !== 200) throw new Error('login failed: ' + login.status);
  const body = await login.json();
  if (body.staff !== false) throw new Error('the outsider was reported as staff');
  const cookie = cookieFrom(login);
  if (!cookie) throw new Error('no session for the outsider');

  const r = await call('/api/workspace', { cookie });
  if (r.status !== 403) throw new Error('the workspace answered a non-staff session with ' + r.status);
  const text = await r.text();
  if (/bank|participants|creators/i.test(text)) throw new Error('the 403 leaked workspace content');
});

await step('a non-staff session is told why rather than bounced to the login', async () => {
  const login = await call('/api/login', { method: 'POST', body: { email: OUTSIDER, password: PASSWORD } });
  const me = await call('/api/me', { cookie: cookieFrom(login) });
  const body = await me.json();
  if (body.staff !== false) throw new Error('staff flag was ' + body.staff);
  if (!body.reason) throw new Error('no reason given, so the dashboard cannot explain it');
});

/* ---- signing out ------------------------------------------------------- */

await step('signing out ends the session on the server, not just in the browser', async () => {
  const login = await call('/api/login', { method: 'POST', body: { email: STAFF, password: PASSWORD } });
  const cookie = cookieFrom(login);
  /* 503 here means "no database configured", which is what the harness
     runs without — the point is that the request got past the guard,
     so anything but a 401/403 counts as the session working */
  const before = await call('/api/workspace', { cookie });
  if ([401, 403].includes(before.status)) throw new Error('the fresh session did not work: ' + before.status);

  const out = await call('/api/logout', { method: 'POST', cookie });
  if (out.status !== 200) throw new Error('logout returned ' + out.status);
  if (!/Max-Age=0/.test(out.headers.get('set-cookie') || '')) throw new Error('the cookie was not cleared');

  /* the old cookie value must now be worthless even if someone kept it */
  const after = await call('/api/workspace', { cookie });
  if (after.status !== 401) throw new Error('the session still works after logout: ' + after.status);
});

/* ---- what must stay open ----------------------------------------------- */

await step('the health check is still open', async () => {
  const r = await call('/api/health');
  if (r.status !== 200) throw new Error('status ' + r.status);
});

await step('a partner link still works without any session', async () => {
  /* the unguessable token is the credential — a partner has no account
     and must never need one */
  const r = await call('/api/partner/not-a-real-token');
  if (r.status === 401) throw new Error('partner links now demand a login');
  /* a bad token is refused on its own terms (403/404), and 503 is the
     no-database case; what matters is that it is never 401 */
  if (![403, 404, 503].includes(r.status)) throw new Error('unexpected status ' + r.status);
  const page = await call('/partner/not-a-real-token');
  if (page.status === 401) throw new Error('the partner page now demands a login');
});

await step('Meta can still deliver a webhook', async () => {
  /* Meta cannot log in; the HMAC is its credential */
  const verify = process.env.META_WEBHOOK_VERIFY_TOKEN || 'harness-verify-token';
  const r = await call(`/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verify)}&hub.challenge=xyz`);
  if (r.status !== 200) throw new Error('the handshake returned ' + r.status);
  if ((await r.text()) !== 'xyz') throw new Error('the challenge was not echoed');

  const post = await call('/api/webhooks/instagram', { method: 'POST', body: { object: 'instagram', entry: [] } });
  if (post.status === 401) throw new Error('deliveries now demand a login');
  if (post.status !== 403) throw new Error('an unsigned delivery should still be 403, got ' + post.status);
});

await step('the dashboard HTML still loads for a signed-out visitor', async () => {
  /* it has to, or there is nowhere to type the password */
  const r = await call('/');
  if (r.status !== 200) throw new Error('status ' + r.status);
  const html = await r.text();
  if (!/authOverlay/.test(html)) throw new Error('the login overlay is not in the page');
});

await step('the webhook status needs a credential of some kind', async () => {
  const anon = await call('/api/webhooks/instagram/status');
  if (anon.status !== 401) throw new Error('it answered an anonymous caller with ' + anon.status);
  const signed = await call('/api/webhooks/instagram/status', { cookie: staffCookie });
  if (signed.status !== 200) throw new Error('a staff session was refused: ' + signed.status);
});

console.log('\nerrors: ' + (errs.length ? errs.join(' | ') : 'none'));
process.exit(errs.length ? 1 : 0);
