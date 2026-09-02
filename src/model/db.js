import { TODAY, iso } from '../lib/dates.js';
import { scheduleSheetPush } from '../sync/sheets.js';
import { toast } from '../ui/overlay.js';
import { SETTINGS } from './settings.js';
import { avColor, newId } from './vocab.js';

/* ---------------- the workspace ---------------- */
export const DB = { creators: [], campaigns: [], participants: [], appointments: [], partnerLinks: [], socialContent: [] };
export const byCreator = {};
export const byCampaign = {};

/* ==================================================================
   SOCIAL CONTENT

   A published post is one record, and it lives in DB.socialContent.
   It is NOT stored a second time on the roster row: `p.content`
   points at the very same object in memory, and the save path strips
   it back out, so there is exactly one copy on disk and no way for
   the two to drift apart. Everything already written against
   `p.content` keeps working untouched.

   The campaign is a real field on the record, never a hashtag.
   Hashtags are only ever evidence used to fill campaignId in, which
   is why matchMethod and matchConfidence are recorded beside it:
   a number nobody can explain is a number nobody will trust.
   ================================================================== */
export const SOCIAL_MATCH_STATUS = {
  confirmed:    { label: 'Confirmed',    tone: 'green',  sub: 'a person decided this' },
  auto_matched: { label: 'Auto-matched', tone: 'blue',   sub: 'matched with high confidence' },
  suggested:    { label: 'Needs review', tone: 'yellow', sub: 'a guess worth checking' },
  unassigned:   { label: 'Unassigned',   tone: 'grey',   sub: 'no campaign yet' },
  excluded:     { label: 'Not campaign', tone: 'grey',   sub: 'ruled out by hand' }
};

/* the fields the app has always kept on a content record, defaulted so
   an older record and a freshly imported one have the same shape */
export function socialContentDefaults() {
  return {
    platform: 'Instagram', platformPostId: '', username: '',
    postUrl: '', thumbnailUrl: '', caption: '', hashtags: [], mentions: [],
    format: 'Reel', publishedAt: '', submittedAt: '',
    views: 0, paidViews: 0, organicViews: 0, likes: 0, comments: 0, shares: 0, saves: 0,
    reach: 0, profileVisits: 0, followsGained: 0, linkClicks: 0,
    matchMethod: '', matchConfidence: 0, matchStatus: 'unassigned',
    dataSource: 'manual', lastScrapedAt: null,
    curve: [], boosted: false, viral: false, topCountries: [], thumbTint: '',
    createdAt: '', updatedAt: ''
  };
}

/* Instagram and TikTok both put the post id in the path; anything else
   falls back to the whole URL, which is still stable per post. */
export function platformPostIdOf(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  let m = u.match(/instagram\.com\/(?:p|reel|reels|tv)\/([\w-]+)/i);
  if (m) return 'ig_' + m[1];
  m = u.match(/tiktok\.com\/@[\w.]+\/video\/(\d+)/i);
  if (m) return 'tt_' + m[1];
  return u.replace(/[?#].*$/, '');
}

export function platformOfUrl(url, fallback) {
  const u = String(url || '');
  if (/tiktok\.com/i.test(u)) return 'TikTok';
  if (/instagram\.com/i.test(u)) return 'Instagram';
  if (/youtube\.com|youtu\.be/i.test(u)) return 'YouTube';
  return fallback || 'Instagram';
}

export const hashtagsIn = (text) => (String(text || '').match(/#[\p{L}\p{N}_]+/gu) || []).map((h) => h.toLowerCase());
export const mentionsIn = (text) => (String(text || '').match(/@[\w.]+/g) || []).map((h) => h.toLowerCase());

export function socialEngagements(c) {
  if (!c) return 0;
  return (c.likes || 0) + (c.comments || 0) + (c.shares || 0) + (c.saves || 0);
}
/* Rate against views, because that is what a brand asks about a video.
   Returns null rather than 0 when there is nothing to divide by, so an
   unmeasured post sorts and reads as "no data" instead of "terrible". */
export function socialEngagementRate(c) {
  if (!c || !c.views) return null;
  return (socialEngagements(c) / c.views) * 100;
}
export function socialViewRatio(c, cr) {
  const f = cr && cr.followers;
  if (!c || !c.views || !f) return null;
  return c.views / f;
}

/* ---- linking -----------------------------------------------------
   Called after every load. Rebuilds `p.content` as a reference to the
   record in DB.socialContent, and adopts any older row that still
   carries its content inline — which is every row until this ships.
   ------------------------------------------------------------------ */
export function linkSocialContent() {
  if (!Array.isArray(DB.socialContent)) DB.socialContent = [];
  const byParticipant = {};
  DB.socialContent.forEach((c) => {
    Object.entries(socialContentDefaults()).forEach(([k, v]) => {
      if (c[k] === undefined) c[k] = Array.isArray(v) ? v.slice() : v;
    });
    if (c.participantId) byParticipant[c.participantId] = c;
  });

  let adopted = 0;
  DB.participants.forEach((p) => {
    const existing = byParticipant[p.id];
    if (existing) {
      /* the row and the record are now the same object, so a write
         through either one is the same write */
      existing.campaignId = p.campaignId;
      existing.creatorId = p.creatorId;
      p.content = existing;
      return;
    }
    if (!p.content) return;
    const cr = byCreator[p.creatorId] || {};
    const rec = Object.assign(socialContentDefaults(), p.content, {
      id: p.content.id || newId('sc'),
      participantId: p.id,
      campaignId: p.campaignId,
      creatorId: p.creatorId,
      username: p.content.username || cr.handle || '',
      postUrl: p.content.postUrl || p.content.url || '',
      publishedAt: p.content.publishedAt || p.content.postedAt || '',
      /* it came in through the roster, so the campaign is not a guess */
      matchMethod: p.content.matchMethod || 'roster',
      matchConfidence: p.content.matchConfidence || 100,
      matchStatus: p.content.matchStatus || 'confirmed',
      dataSource: p.content.dataSource || 'manual',
      createdAt: p.content.createdAt || new Date().toISOString()
    });
    rec.platform = platformOfUrl(rec.postUrl, p.content.platform || cr.platform);
    rec.platformPostId = rec.platformPostId || platformPostIdOf(rec.postUrl);
    if (!rec.hashtags.length) rec.hashtags = hashtagsIn(rec.caption);
    if (!rec.mentions.length) rec.mentions = mentionsIn(rec.caption);
    if (!rec.thumbTint) rec.thumbTint = avColor(cr.handle || p.creatorId || '');
    /* url and postUrl are the same string; url is what 108 existing
       call sites read, so it stays rather than being renamed */
    rec.url = rec.postUrl;
    DB.socialContent.push(rec);
    byParticipant[p.id] = rec;
    p.content = rec;
    adopted++;
  });
  return adopted;
}

/* The one place a content record is created. Every caller used to build
   the object literal itself, so a field added in one place was missing in
   the other three — and now there is a second thing to get right, filing
   it in DB.socialContent. Doing both here means a post can never exist on
   a row without existing in the library. */
export function attachContent(p, cr, seed) {
  if (p.content) return p.content;
  const url = (seed && seed.url) || '';
  const rec = Object.assign(socialContentDefaults(), {
    id: newId('sc'),
    participantId: p.id, campaignId: p.campaignId, creatorId: p.creatorId,
    username: (cr && cr.handle) || '',
    publishedAt: iso(TODAY), postedAt: iso(TODAY), submittedAt: iso(TODAY),
    matchMethod: 'roster', matchConfidence: 100, matchStatus: 'confirmed',
    thumbTint: avColor((cr && cr.handle) || p.creatorId || ''),
    createdAt: new Date().toISOString()
  }, seed || {});
  rec.url = url; rec.postUrl = url;
  rec.platform = platformOfUrl(url, (seed && seed.platform) || (cr && cr.platform));
  rec.platformPostId = platformPostIdOf(url);
  DB.socialContent.push(rec);
  p.content = rec;
  return rec;
}

/* Clearing the URL on a post nobody measured removes it outright — and it
   has to leave the library too, or the content page goes on listing a
   video that no roster row claims any more. */
export function detachContent(p) {
  if (!p.content) return;
  const i = DB.socialContent.indexOf(p.content);
  if (i >= 0) DB.socialContent.splice(i, 1);
  p.content = null;
}

export function setContentUrl(p, cr, url) {
  const c = attachContent(p, cr, { url });
  c.url = url;
  c.postUrl = url;
  c.platform = platformOfUrl(url, c.platform);
  c.platformPostId = platformPostIdOf(url);
  c.updatedAt = new Date().toISOString();
  return c;
}

/* The saved shape: participants without their content, and one
   socialContent array beside them. Called by every write path so the
   local copy and the server copy are the same shape. */
export function dbPayload() {
  return {
    creators: DB.creators,
    campaigns: DB.campaigns,
    participants: DB.participants.map((p) => {
      if (!p.content) return p;
      const { content, ...rest } = p;
      return rest;
    }),
    appointments: DB.appointments,
    partnerLinks: DB.partnerLinks,
    socialContent: DB.socialContent
  };
}

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
        const json = JSON.stringify({ savedAt: new Date().toISOString(), db: dbPayload(), settings: SETTINGS });
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

export function workspacePayload() { return dbPayload(); }

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
    DB.socialContent = db.socialContent || [];
    DB.creators.forEach((c) => (byCreator[c.id] = c));
    DB.campaigns.forEach((c) => (byCampaign[c.id] = c));
    linkSocialContent();
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
    DB.socialContent = db.socialContent || [];
    DB.creators.forEach((c) => (byCreator[c.id] = c));
    DB.campaigns.forEach((c) => (byCampaign[c.id] = c));
    linkSocialContent();
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
