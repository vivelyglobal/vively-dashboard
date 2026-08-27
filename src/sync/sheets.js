import { TODAY, iso } from '../lib/dates.js';
import { avColor } from '../model/vocab.js';
import { DB, byCreator, byCampaign, persist, notify } from '../model/db.js';
import { $, esc } from '../ui/dom.js';
import { toast } from '../ui/overlay.js';

/* ============================================================
   GOOGLE SHEET SYNC
   The Sheet is the shared copy of the workspace. Each entity gets
   its own tab with plain columns, so the team can open the Sheet
   and read (or fix) anything without this dashboard.

   The endpoint URL and shared key live in this browser only —
   never in the HTML — so the file itself stays safe to share.
   ============================================================ */

export const SYNC_KEY = 'vively-sync-v1';
export const SYNC = { url: '', secret: '', auto: true, at: null, revision: 0, status: 'off', error: null, busy: false };
export let syncTimer = null;
export let lastPushedJson = '';

export function loadSyncConfig() {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    if (!raw) return;
    Object.assign(SYNC, JSON.parse(raw), { busy: false, error: null });
    if (SYNC.at) SYNC.at = new Date(SYNC.at);
    SYNC.status = SYNC.url ? 'idle' : 'off';
  } catch (e) { /* no config yet */ }
}
export function saveSyncConfig() {
  try {
    localStorage.setItem(SYNC_KEY, JSON.stringify({
      url: SYNC.url, secret: SYNC.secret, auto: SYNC.auto,
      at: SYNC.at ? SYNC.at.toISOString() : null, revision: SYNC.revision
    }));
  } catch (e) { /* storage blocked */ }
}

/* ------------------------------ schema ------------------------------ */
/* type: s = string, n = number, b = boolean, a = array of strings, c = comma-joined numbers */
export const SHEET_SCHEMA = {
  campaigns: [
    ['id','s'],['brand','s'],['name','s'],['kind','s'],['category','s'],['market','s'],['status','s'],
    ['start','s'],['end','s'],['targetCreators','n'],['minFollowers','n'],['platforms','a'],
    ['deliverables','s'],['budget','n'],['productCostPer','n'],['adSpend','n'],['hashtags','a'],
    ['owner','s'],['note','s'],['createdAt','s'],['fulfilment','s'],['importedFrom','s'],
    ['notionDatabaseId','s'],['notionSyncedAt','s'],['notionDescription','s']
  ],
  creators: [
    ['id','s'],['handle','s'],['name','s'],['platform','s'],['followers','n'],['er','n'],['avgViews','n'],
    ['categories','a'],['country','s'],['nationality','s'],['languages','a'],['tier','s'],['source','s'],
    ['rate','n'],['reliability','n'],['avgTurnaroundDays','n'],['lastWorked','s'],['email','s'],
    ['contact','s'],['address','s'],['tags','a'],['notes','s'],['flag','s'],['flagReason','s'],['flagAt','s']
  ],
  participants: [
    ['id','s'],['campaignId','s'],['creatorId','s'],['stage','s'],['source','s'],['fee','n'],
    ['contactedAt','s'],['repliedAt','s'],['confirmedAt','s'],['shippedAt','s'],['dropReason','s'],
    ['revisions','n'],['note','s'],['fullName','s'],['address','s'],['contact','s'],['nationality','s'],
    ['visitAt','s'],['arrivingDate','s'],['otherSns','s'],['importedStatus','s'],['notionPageId','s'],
    ['content.url','s'],['content.platform','s'],['content.format','s'],['content.postedAt','s'],
    ['content.submittedAt','s'],['content.views','n'],['content.paidViews','n'],['content.organicViews','n'],
    ['content.likes','n'],['content.comments','n'],['content.shares','n'],['content.saves','n'],
    ['content.reach','n'],['content.profileVisits','n'],['content.followsGained','n'],['content.linkClicks','n'],
    ['content.boosted','b'],['content.topCountries','a'],['content.curve','c'],['content.metricsAt','s']
  ]
};

export const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
export function setPath(o, p, v) {
  const parts = p.split('.');
  const last = parts.pop();
  let cur = o;
  parts.forEach((k) => { if (cur[k] == null) cur[k] = {}; cur = cur[k]; });
  cur[last] = v;
}

export function encodeCell(v, type) {
  if (v == null) return '';
  if (type === 'a') return Array.isArray(v) ? v.join('|') : String(v);
  if (type === 'c') return Array.isArray(v) ? v.join(',') : String(v);
  if (type === 'b') return v ? 'TRUE' : 'FALSE';
  if (type === 'n') return v === '' ? '' : Number(v);
  return String(v);
}
export function decodeCell(v, type) {
  const s = v == null ? '' : String(v).trim();
  if (type === 'a') return s ? s.split('|').filter(Boolean) : [];
  if (type === 'c') return s ? s.split(',').map(Number).filter((n) => !isNaN(n)) : [];
  if (type === 'b') return /^(true|1|yes)$/i.test(s);
  if (type === 'n') { if (s === '') return null; const n = Number(s.replace(/,/g, '')); return isNaN(n) ? null : n; }
  return s;
}

export function entityToGrid(name) {
  const cols = SHEET_SCHEMA[name];
  const rows = [cols.map((c) => c[0])];
  DB[name].forEach((obj) => rows.push(cols.map(([k, t]) => encodeCell(getPath(obj, k), t))));
  return rows;
}

export function gridToEntity(name, grid) {
  if (!grid || grid.length < 2) return [];
  const header = grid[0].map((h) => String(h).trim());
  const cols = SHEET_SCHEMA[name];
  return grid.slice(1).filter((r) => r.some((c) => c !== '' && c != null)).map((row) => {
    const obj = {};
    cols.forEach(([key, type]) => {
      const i = header.indexOf(key);
      if (i < 0) return;
      const val = decodeCell(row[i], type);
      if (key.startsWith('content.')) { if (val !== '' && val !== null && !(Array.isArray(val) && !val.length)) setPath(obj, key, val); }
      else obj[key] = val;
    });
    if (obj.content && !obj.content.url && !obj.content.views) obj.content = null;
    if (obj.content) {
      obj.content.thumbTint = avColor(obj.creatorId || obj.id || '');
      obj.content.viral = false;
      ['views','paidViews','organicViews','likes','comments','shares','saves','reach','profileVisits','followsGained','linkClicks']
        .forEach((k) => { if (obj.content[k] == null) obj.content[k] = 0; });
      if (!Array.isArray(obj.content.topCountries)) obj.content.topCountries = [];
      if (!Array.isArray(obj.content.curve)) obj.content.curve = [];
    } else obj.content = null;
    return obj;
  });
}

/* ------------------------------ transport ------------------------------ */
/* text/plain keeps the request "simple", so the browser skips the CORS
   preflight that Apps Script cannot answer */
export async function sheetCall(action, body) {
  if (!SYNC.url) throw new Error('No Google Sheet endpoint configured.');
  const res = await fetch(SYNC.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action, key: SYNC.secret }, body || {}))
  });
  if (!res.ok) throw new Error('Sheet responded ' + res.status);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new Error('Unexpected reply — check the Web App is deployed with access set to "Anyone".'); }
  if (!json.ok) throw new Error(json.error || 'The Sheet rejected the request.');
  return json;
}

export async function sheetPull(opts) {
  opts = opts || {};
  SYNC.busy = true; SYNC.status = 'syncing'; renderSyncUi();
  try {
    const json = await sheetCall('pull');
    const grids = json.data || {};
    const campaigns = gridToEntity('campaigns', grids.campaigns);
    const creators = gridToEntity('creators', grids.creators);
    const participants = gridToEntity('participants', grids.participants);

    if (!opts.silent && (DB.campaigns.length || DB.creators.length) &&
        !confirm(`Replace this browser's workspace (${DB.campaigns.length} campaigns, ${DB.creators.length} creators) with the Sheet's (${campaigns.length} campaigns, ${creators.length} creators)?`)) {
      SYNC.busy = false; SYNC.status = 'idle'; renderSyncUi(); return;
    }

    Object.keys(byCreator).forEach((k) => delete byCreator[k]);
    Object.keys(byCampaign).forEach((k) => delete byCampaign[k]);
    DB.campaigns = campaigns; DB.creators = creators; DB.participants = participants;
    DB.creators.forEach((c) => (byCreator[c.id] = c));
    DB.campaigns.forEach((c) => (byCampaign[c.id] = c));

    SYNC.revision = json.revision || 0;
    SYNC.at = new Date(); SYNC.error = null; SYNC.status = 'idle';
    lastPushedJson = JSON.stringify(DB);
    saveSyncConfig(); persist(true);
    toast(`Pulled ${campaigns.length} campaigns and ${creators.length} creators from the Sheet`);
    notify();
  } catch (err) {
    SYNC.error = err.message; SYNC.status = 'error';
    toast('Pull failed — ' + err.message);
    renderSyncUi();
  } finally { SYNC.busy = false; }
}

export async function sheetPush(opts) {
  opts = opts || {};
  if (!SYNC.url || SYNC.busy) return;
  SYNC.busy = true; SYNC.status = 'syncing'; renderSyncUi();
  try {
    const json = await sheetCall('push', {
      revision: SYNC.revision,
      force: !!opts.force,
      data: {
        campaigns: entityToGrid('campaigns'),
        creators: entityToGrid('creators'),
        participants: entityToGrid('participants')
      }
    });
    if (json.conflict) {
      SYNC.status = 'conflict';
      SYNC.error = `Someone else saved to the Sheet at ${new Date(json.updatedAt).toLocaleString()}. Pull their version, or push over it.`;
      renderSyncUi();
      if (!opts.silent) toast('Sheet has newer changes — resolve in Setup → Google Sheet');
      return;
    }
    SYNC.revision = json.revision;
    SYNC.at = new Date(); SYNC.error = null; SYNC.status = 'idle';
    lastPushedJson = JSON.stringify(DB);
    saveSyncConfig();
    if (!opts.silent) toast('Pushed to the Sheet');
    renderSyncUi();
  } catch (err) {
    SYNC.error = err.message; SYNC.status = 'error';
    if (!opts.silent) toast('Push failed — ' + err.message);
    renderSyncUi();
  } finally { SYNC.busy = false; }
}

/* called from persist() whenever the workspace actually changed */
export function scheduleSheetPush(currentJson) {
  if (!SYNC.url || !SYNC.auto) return;
  if (currentJson === lastPushedJson) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sheetPush({ silent: true }), 3000);
}

/* ------------------------------ settings UI ------------------------------ */
export function syncBadgeHtml() {
  const map = {
    off:      ['grey',   'Not connected'],
    idle:     ['green',  SYNC.at ? 'Synced ' + SYNC.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Connected'],
    syncing:  ['blue',   'Syncing…'],
    conflict: ['yellow', 'Needs attention'],
    error:    ['red',    'Sync error']
  };
  const [cls, label] = map[SYNC.status] || map.off;
  return `<span class="pill ${cls}">${label}</span>`;
}

export function renderSyncUi() {
  const el = $('#syncStatus');
  if (el) el.innerHTML = syncBadgeHtml();
  const err = $('#syncError');
  if (err) {
    err.innerHTML = SYNC.error
      ? `<div class="note ${SYNC.status === 'error' ? 'warn' : ''}" style="margin-top:12px">
           <strong>${SYNC.status === 'conflict' ? 'Conflict' : 'Problem'}:</strong> ${esc(SYNC.error)}
           ${SYNC.status === 'conflict' ? `<div style="display:flex;gap:8px;margin-top:10px">
             <button class="btn xs" onclick="sheetPull()">Pull the Sheet's version</button>
             <button class="btn xs" onclick="sheetPush({force:true})">Push mine over it</button></div>` : ''}
         </div>` : '';
  }
  const meta = $('#syncMeta');
  if (meta) meta.textContent = SYNC.at ? SYNC.at.toLocaleString() : 'never';
}
