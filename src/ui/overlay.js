import { $ } from './dom.js';

export let toastTimer;
/* a message that says something went wrong is announced at once and stays a
   little longer; everything else waits for a pause in the screen reader */
export const TOAST_BAD = /not saved|failed|could not|couldn't|error|refused|rejected|sign in/i;
export function toast(msg) {
  const t = $('#toast');
  const bad = TOAST_BAD.test(String(msg));
  t.setAttribute('aria-live', bad ? 'assertive' : 'polite');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), bad ? 6000 : 2200);
}

/* Keyboard handling for the side panel (it is a dialog: focus moves in, Tab
   stays inside, Escape closes, focus goes back to what opened it). The
   decision is a pure function so a test can run it without a page. */
export const DRAWER_FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
export function drawerTrapTarget(items, active, shift) {
  if (!items || !items.length) return null;
  const first = items[0], last = items[items.length - 1];
  const at = items.indexOf(active);
  if (shift && (at <= 0)) return last;
  if (!shift && (at === items.length - 1 || at < 0)) return first;
  return null;
}
export let drawerReturnTo = null;
export function drawerKeydown(e) {
  if (e.key !== 'Tab') return;
  const d = $('#drawer');
  const items = Array.from(d.querySelectorAll(DRAWER_FOCUSABLE)).filter((el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true');
  const to = drawerTrapTarget(items, document.activeElement, e.shiftKey);
  if (to) { e.preventDefault(); to.focus(); }
}

export function openDrawer(title, html, wide) {
  window.__keepDrawer = true;
  setTimeout(() => { window.__keepDrawer = false; }, 0);
  const d = $('#drawer');
  if (!d.classList.contains('open')) {
    const a = document.activeElement;
    drawerReturnTo = a && a !== document.body ? a : null;
  }
  if (!d.__trap) { d.addEventListener('keydown', drawerKeydown); d.__trap = true; }
  $('#drawerTitle').innerHTML = title;
  $('#drawerBody').innerHTML = html;
  $('#drawer').classList.toggle('wide', !!wide);
  $('#drawer').classList.add('open');
  $('#scrim').classList.add('open');
  /* always open at the top — otherwise a long form inherits the last panel's scroll
     position and the first fields sit above the fold */
  $('#drawerBody').scrollTop = 0;
  requestAnimationFrame(() => {
    $('#drawerBody').scrollTop = 0;
    $('#drawerTitle').focus();
  });
}
export function closeDrawer() {
  const d = $('#drawer');
  const wasOpen = d.classList.contains('open');
  d.classList.remove('open');
  $('#scrim').classList.remove('open');
  if (wasOpen && drawerReturnTo && drawerReturnTo.isConnected) { try { drawerReturnTo.focus(); } catch (e) { /* gone */ } }
  drawerReturnTo = null;
}
