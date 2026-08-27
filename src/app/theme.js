/* Theme lives on the document element so the CSS tokens switch in one
   place; the choice is remembered per browser. */
const THEME_KEY = 'vively-theme';

export function readStoredTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
}
export function storeTheme(t) {
  try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* private mode — session only */ }
}
export function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'dark'; }
export function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); }
export function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  applyTheme(next); storeTheme(next);
  return next;
}
export function initialTheme() {
  return readStoredTheme() ||
    (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}
