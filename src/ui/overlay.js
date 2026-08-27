import { $ } from './dom.js';

export let toastTimer;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

export function openDrawer(title, html, wide) {
  window.__keepDrawer = true;
  setTimeout(() => { window.__keepDrawer = false; }, 0);
  $('#drawerTitle').innerHTML = title;
  $('#drawerBody').innerHTML = html;
  $('#drawer').classList.toggle('wide', !!wide);
  $('#drawer').classList.add('open');
  $('#scrim').classList.add('open');
  /* always open at the top — otherwise a long form inherits the last panel's scroll
     position and the first fields sit above the fold */
  $('#drawerBody').scrollTop = 0;
  requestAnimationFrame(() => { $('#drawerBody').scrollTop = 0; });
}
export function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#scrim').classList.remove('open');
}
