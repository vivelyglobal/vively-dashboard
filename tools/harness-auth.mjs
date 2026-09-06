/* Signs a harness browser in.

   The workspace API needs a session now, so a harness that drives the
   real dashboard needs a real one too — which is worth something on its
   own: every browser check is also, quietly, a check that the login
   works end to end.

   The request context shares its cookie jar with the pages in the same
   browser context, so signing in here means the page is signed in. */

export const HARNESS_EMAIL = 'k@v.com';
export const HARNESS_PASSWORD = 'harness-password-1';
export const HARNESS_CODE = process.env.SIGNUP_CODE || 'harness-signup-code';

export async function signIn(ctx, base = 'http://localhost:3120') {
  const api = ctx.request;

  /* Created if missing, ignored if already there — the harnesses share
     one server and whichever runs first wins. 409 is success here. */
  const up = await api.post(base + '/api/signup', {
    data: { name: 'Harness', email: HARNESS_EMAIL, password: HARNESS_PASSWORD, code: HARNESS_CODE }
  });
  if (![201, 409].includes(up.status())) {
    throw new Error('harness signup failed: ' + up.status() + ' ' + (await up.text()).slice(0, 160));
  }

  const login = await api.post(base + '/api/login', {
    data: { email: HARNESS_EMAIL, password: HARNESS_PASSWORD }
  });
  if (login.status() !== 200) {
    throw new Error('harness login failed: ' + login.status() + ' ' + (await login.text()).slice(0, 160));
  }
  const body = await login.json();
  if (body.staff !== true) {
    /* the usual cause is STAFF_EMAILS not naming the harness account —
       worth saying plainly, because the symptom is every browser check
       failing at once for no obvious reason */
    throw new Error('the harness account is not staff — add ' + HARNESS_EMAIL + ' to STAFF_EMAILS');
  }
  return body.user;
}

/* Some harness steps call the API directly with node's fetch rather
   than through the browser, and those carry no cookie jar. This hands
   them a header to send. */
export async function signInCookie(base = 'http://localhost:3120') {
  await fetch(base + '/api/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Harness', email: HARNESS_EMAIL, password: HARNESS_PASSWORD, code: HARNESS_CODE })
  }).catch(() => {});
  const r = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: HARNESS_EMAIL, password: HARNESS_PASSWORD })
  });
  if (r.status !== 200) throw new Error('harness login failed: ' + r.status);
  const m = (r.headers.get('set-cookie') || '').match(/vively_session=([^;]*)/);
  if (!m) throw new Error('harness login returned no session cookie');
  return 'vively_session=' + m[1];
}
