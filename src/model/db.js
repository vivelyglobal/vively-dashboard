import { scheduleSheetPush } from '../sync/sheets.js';
import { toast } from '../ui/overlay.js';
import { SETTINGS } from './settings.js';

/* ---------------- the workspace ---------------- */
export const DB = { creators: [], campaigns: [], participants: [], appointments: [], partnerLinks: [] };
export const byCreator = {};
export const byCampaign = {};

/* ------------------------------------------------------------------
   Persistence. The whole workspace is saved to this browser's local
   storage after every change, so a refresh or a closed tab does not
   lose anything. It is per-browser and per-device — not shared, and
   not a server. Use Export workspace (JSON) for a real backup.
   ------------------------------------------------------------------ */
export const STORE_KEY = 'vively-workspace-v1';
export let persistState = { on: false, at: null, bytes: 0, error: null };
export let persistTimer = null;

export function storageAvailable() {
  try { localStorage.setItem('__v', '1'); localStorage.removeItem('__v'); return true; }
  catch (e) { return false; }
}

export function persist(now) {
  clearTimeout(persistTimer);
  const write = () => {
    if (persistState.on) {
      try {
        const json = JSON.stringify({ savedAt: new Date().toISOString(), db: DB, settings: SETTINGS });
        localStorage.setItem(STORE_KEY, json);
        persistState.at = new Date();
        persistState.bytes = json.length;
        persistState.error = null;
      } catch (e) {
        persistState.error = /quota/i.test(e.name + e.message)
          ? 'Browser storage is full — export the workspace and clear old campaigns.'
          : e.message;
      }
    }
    /* these two run even if this browser blocks local storage — the server
       save in particular does not depend on it at all */
    if (typeof scheduleSheetPush === 'function') scheduleSheetPush(JSON.stringify(DB));
    if (typeof scheduleServerSave === 'function') scheduleServerSave();
    notifyStatus();
  };
  if (now) write(); else persistTimer = setTimeout(write, 600);
}

/* ------------------------------------------------------------------
   Server save. This is the real cross-browser, cross-device copy —
   it lives in the database behind /api/workspace, not in this
   browser. Auto-saves a couple seconds after every change (like the
   Sheet sync below), plus there's a visible Save button in the
   topbar for "save this right now and tell me it worked".

   Revision is a simple optimistic lock: if another browser saved
   since this one last loaded, the server refuses (409) unless we
   pass force — same conflict shape as the Google Sheet sync.
   ------------------------------------------------------------------ */
export const SERVER = { status: 'idle', at: null, revision: 0, error: null, busy: false, configured: null };
export let lastServerJson = '';
export let serverSaveTimer = null;

export function workspacePayload() {
  return { creators: DB.creators, campaigns: DB.campaigns, participants: DB.participants,
           appointments: DB.appointments, partnerLinks: DB.partnerLinks };
}

export async function serverLoad() {
  try {
    const res = await fetch('/api/workspace');
    if (res.status === 503) { SERVER.configured = false; return 'error'; }
    if (!res.ok) throw new Error('Server responded ' + res.status);
    const json = await res.json();
    SERVER.configured = true;
    if (!json.data || !json.data.db || !Array.isArray(json.data.db.campaigns)) return 'empty';
    const { db, settings, savedAt, revision } = json.data;
    Object.keys(byCreator).forEach((k) => delete byCreator[k]);
    Object.keys(byCampaign).forEach((k) => delete byCampaign[k]);
    DB.creators = db.creators || [];
    DB.campaigns = db.campaigns || [];
    DB.participants = db.participants || [];
    DB.appointments = db.appointments || [];
    DB.partnerLinks = db.partnerLinks || [];
    DB.creators.forEach((c) => (byCreator[c.id] = c));
    DB.campaigns.forEach((c) => (byCampaign[c.id] = c));
    if (settings && typeof settings.hideBlocked === 'boolean') SETTINGS.hideBlocked = settings.hideBlocked;
    SERVER.revision = revision || 0;
    SERVER.at = savedAt ? new Date(savedAt) : null;
    SERVER.status = 'idle'; SERVER.error = null;
    lastServerJson = JSON.stringify(workspacePayload());
    return 'loaded';
  } catch (err) {
    SERVER.error = err.message; SERVER.status = 'error';
    return 'error';
  }
}

export async function serverSave(opts) {
  opts = opts || {};
  if (SERVER.busy) return;
  if (SERVER.configured === false && !opts.force) return;
  const json = JSON.stringify(workspacePayload());
  if (!opts.force && json === lastServerJson) return;

  SERVER.busy = true; SERVER.status = 'syncing'; notifyStatus();
  try {
    const res = await fetch('/api/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db: workspacePayload(), settings: SETTINGS, revision: SERVER.revision, force: !!opts.force })
    });
    if (res.status === 503) {
      SERVER.configured = false; SERVER.status = 'off';
      return;
    }
    const out = await res.json().catch(() => ({}));
    if (res.status === 409) {
      SERVER.status = 'conflict';
      SERVER.error = `Saved from another browser at ${out.savedAt ? new Date(out.savedAt).toLocaleString() : 'a later time'}. Click Save again to overwrite it, or reload this page to get their version.`;
      SERVER.revision = out.revision != null ? out.revision : SERVER.revision;
      if (!opts.silent) toast('Someone else saved more recently — click Save again to overwrite');
      return;
    }
    if (!res.ok) throw new Error(out.error || ('Server responded ' + res.status));
    SERVER.configured = true;
    SERVER.revision = out.revision;
    SERVER.at = new Date(out.savedAt);
    SERVER.status = 'idle'; SERVER.error = null;
    lastServerJson = json;
    if (!opts.silent) toast('Saved');
  } catch (err) {
    SERVER.status = 'error'; SERVER.error = err.message;
    if (!opts.silent) toast('Save failed — ' + err.message);
  } finally {
    SERVER.busy = false; notifyStatus();
  }
}

export function scheduleServerSave() {
  if (SERVER.configured === false) return;
  clearTimeout(serverSaveTimer);
  serverSaveTimer = setTimeout(() => serverSave({ silent: true }), 2000);
}

/* last-ditch save when the tab is actually closing — fetch() can get
   cancelled mid-flight on unload, sendBeacon is built for exactly this */
export function flushServerSaveBeacon() {
  try {
    if (!navigator.sendBeacon) return;
    const body = JSON.stringify({ db: workspacePayload(), settings: SETTINGS, revision: SERVER.revision, force: true });
    navigator.sendBeacon('/api/workspace', new Blob([body], { type: 'application/json' }));
  } catch (e) { /* best effort only */ }
}

export function loadPersisted() {
  if (!persistState.on) return false;
  let raw;
  try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return false; }
  if (!raw) return false;
  try {
    const saved = JSON.parse(raw);
    const db = saved.db || saved;
    if (!db || !Array.isArray(db.creators)) return false;
    DB.creators = db.creators || [];
    DB.campaigns = db.campaigns || [];
    DB.participants = db.participants || [];
    DB.appointments = db.appointments || [];
    DB.partnerLinks = db.partnerLinks || [];
    DB.creators.forEach((c) => (byCreator[c.id] = c));
    DB.campaigns.forEach((c) => (byCampaign[c.id] = c));
    if (saved.settings && typeof saved.settings.hideBlocked === 'boolean') SETTINGS.hideBlocked = saved.settings.hideBlocked;
    persistState.at = saved.savedAt ? new Date(saved.savedAt) : null;
    persistState.bytes = raw.length;
    return true;
  } catch (e) { return false; }
}

export function clearPersisted() {
  try { localStorage.removeItem(STORE_KEY); } catch (e) { /* nothing to clear */ }
  DB.creators.length = 0; DB.campaigns.length = 0; DB.participants.length = 0;
  Object.keys(byCreator).forEach((k) => delete byCreator[k]);
  Object.keys(byCampaign).forEach((k) => delete byCampaign[k]);
  persistState.at = null; persistState.bytes = 0; persistState.error = null;
}

/* ------------------------------------------------------------------
   Change notification. The single-file version called render() and
   updateSaveBadge() from the middle of the data layer; the app
   subscribes here instead, so the data layer no longer has to know
   what is on screen.
   ------------------------------------------------------------------ */
const dataListeners = new Set();
const statusListeners = new Set();
const fire = (set) => set.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });

/* the workspace itself changed — whatever is on screen has to be rebuilt */
export function subscribe(fn) { dataListeners.add(fn); return () => dataListeners.delete(fn); }
export function notify() { fire(dataListeners); fire(statusListeners); }

/* only where the workspace is saved changed. This used to repaint one
   badge, and it must stay that cheap: a full rebuild here would tear down
   any drawer or form the person had open a moment ago. */
export function subscribeStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); }
export function notifyStatus() { fire(statusListeners); }
