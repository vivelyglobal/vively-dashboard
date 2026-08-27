/* Account state. The session's identity is remembered in this browser;
   the accounts themselves live in the database behind /api/signup and
   /api/login, which is why a login now survives a Render restart. */
const AUTH_USER_KEY = 'vively-auth-user-v1';

export function saveAuthUser(user) {
  try {
    if (!user) localStorage.removeItem(AUTH_USER_KEY);
    else localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
  } catch (e) { /* storage unavailable */ }
}

export function loadAuthUser() {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.email ? parsed : null;
  } catch (e) { return null; }
}

export async function sendAuth(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Auth request failed');
  return body;
}
