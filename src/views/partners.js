import { num } from '../lib/format.js';
import { DB, byCreator, notify, serverSave, toastAfterSave } from '../model/db.js';
import { STAGES } from '../model/vocab.js';
import { STAGE_TO_NOTION, WRITEBACK, saveWriteback } from '../sync/notionWriteback.js';
import { partnerStatus, partnersInUse } from '../sync/partner.js';
import { $, $$, esc } from '../ui/dom.js';
import { copyText } from '../ui/html.js';
import { toast } from '../ui/overlay.js';
import { showParticipant } from './campaigns.js';

/* ------------------------------------------------------------------
   Setup → Partners. Where a link is made, revoked, and where the
   comments a partner leaves come back to.
   ------------------------------------------------------------------ */
export const PARTNER_COMMENTS = { list: [], at: null, error: null };

export async function loadPartnerComments() {
  try {
    const res = await fetch('/api/partner-comments');
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'failed');
    PARTNER_COMMENTS.list = body.comments || [];
    PARTNER_COMMENTS.at = new Date();
    PARTNER_COMMENTS.error = null;
  } catch (err) {
    PARTNER_COMMENTS.error = err.message;
  }
  return PARTNER_COMMENTS;
}

/* 32 random bytes of URL-safe text. Nobody guesses one, and it can be
   turned off without touching the others. */
export function newPartnerToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function partnerLinkFor(partner) {
  DB.partnerLinks = DB.partnerLinks || [];
  return DB.partnerLinks.find((l) => l.partner === partner && !l.revokedAt) || null;
}

/* ------------------------------------------------------------------
   Setup → Partners → Brand campaign links (staff only).
   One private, view-only link per campaign, for the brand. The token is
   shown ONCE, when it is made; the server keeps only a hash of it, so
   there is no "copy again": Regenerate makes a new link and the old one
   stops working at once. All state lives on the server (its own
   collection), never in the workspace this page saves, so a stale tab
   cannot bring a revoked link back.
   ------------------------------------------------------------------ */
export const CLK = { links: [], projection: null, workspaceRevision: null, ttlDays: 90, loaded: false, error: '', busy: '', shown: null, msg: null };

/* one request to the staff API; never throws */
export async function clkCall(path, method, body) {
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (method !== 'GET') opts.body = JSON.stringify(body || {});
    const res = await fetch(path, opts);
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json || {} };
  } catch (err) {
    return { status: 0, body: { error: 'Could not reach the server.' } };
  }
}

export function clkProblem(res) {
  const b = res.body || {};
  if (res.status === 401) return 'Sign in as staff to use this card.';
  if (res.status === 403) return 'This account is not allowed to manage brand links. Staff only.';
  if (res.status === 503) return 'The database is not configured on the server yet.';
  return b.error || 'Something went wrong. Nothing was changed.';
}

export function clkLinkFor(campaignId) { return CLK.links.find((l) => l.campaignId === campaignId) || null; }

export const clkDate = (iso) => { const d = new Date(iso); return iso && !isNaN(d) ? d.toLocaleDateString() : '-'; };
export const clkTime = (iso) => { const d = new Date(iso); return iso && !isNaN(d) ? d.toLocaleString() : ''; };

/* the words for one link's state: Active / Expired / Revoked */
export function clkStatusPill(l) {
  if (!l) return { tone: 'grey', label: 'No link' };
  if (l.status === 'active') return { tone: 'green', label: 'Active' };
  if (l.status === 'revoked') return { tone: 'red', label: 'Revoked' };
  return { tone: 'amber', label: 'Expired' };
}

export function clkDetail(l) {
  if (!l) return 'Not created';
  const parts = [];
  if (l.status === 'active') parts.push('Expires ' + clkDate(l.expiresAt));
  else if (l.status === 'expired') parts.push('Expired ' + clkDate(l.expiresAt));
  else parts.push('Revoked ' + clkDate(l.revokedAt));
  parts.push(l.lastOpenedAt ? 'Last opened ' + clkTime(l.lastOpenedAt) : 'Never opened');
  if (l.status === 'active') {
    parts.push(l.viewBuiltAt ? 'Brand sees data from ' + clkTime(l.viewBuiltAt) : 'No data prepared yet');
    if (l.stale) parts.push('behind your last save');
  }
  return parts.join(' · ');
}

export function clkSummary() {
  const p = CLK.projection;
  const active = CLK.links.filter((l) => l.status === 'active');
  const stale = active.filter((l) => l.stale).length;
  if (p && p.lastError) return { tone: 'amber', text: 'Last update failed (' + p.lastError + '). It is retried on your next save, or press Rebuild now.' };
  if (stale) return { tone: 'amber', text: stale + ' link' + (stale === 1 ? '' : 's') + ' showing older data. Save once, or press Rebuild now.' };
  return { tone: 'green', text: active.length ? 'Brand views are up to date.' : 'No active brand links.' };
}

export function clkCardHtml() {
  return '<div class="card" id="clkCard">' +
    '<div class="card-head"><h3>Brand campaign links</h3><div class="sp"></div>' +
    '<button class="btn xs" data-clk="refresh">Refresh</button></div>' +
    '<p class="card-sub" style="margin-top:10px">One private, view-only link per campaign. The brand sees the campaign name, status, ' +
    'headcount, each creator\'s Instagram handle and profile link, a status (confirmed, waiting to post, posted), the confirmed visit ' +
    'date and time, and the post link. Never names, contact details, fees, notes or bank details. Links expire after <span id="clkTtl">90</span> days ' +
    'and can be turned off at any time.</p><div id="clkBody"></div></div>';
}

export function clkBodyHtml() {
  const parts = [];
  if (CLK.msg) parts.push('<div class="note ' + (CLK.msg.tone === 'bad' ? 'bad' : CLK.msg.tone === 'ok' ? '' : 'warn') + '" style="margin:10px 0">' + esc(CLK.msg.text) + '</div>');
  if (CLK.shown) {
    parts.push('<div class="note" style="margin:10px 0;border-color:var(--warning)"><strong>New link for ' + esc(CLK.shown.name) + '. Shown once.</strong>' +
      '<div style="margin:6px 0">Copy it now and send it yourself. It cannot be shown again; if you lose it, use Regenerate.</div>' +
      '<input type="text" readonly id="clkUrl" value="' + esc(CLK.shown.url) + '" style="width:100%"/>' +
      '<div style="display:flex;gap:8px;margin-top:8px"><button class="btn sm primary" data-clk="copy">Copy link</button>' +
      '<button class="btn sm" data-clk="dismiss">I have copied it</button></div></div>');
  }
  if (!CLK.loaded) { parts.push('<p class="card-sub">' + (CLK.error ? esc(CLK.error) : 'Loading…') + '</p>'); return parts.join(''); }
  const s = clkSummary();
  parts.push('<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0"><span class="pill ' + s.tone + '">' + esc(s.text) + '</span>' +
    '<button class="btn xs" data-clk="rebuild"' + (CLK.busy ? ' disabled' : '') + '>Rebuild now</button>' +
    (CLK.busy ? '<span style="font-size:12px;color:var(--text-3)">Working…</span>' : '') + '</div>');
  const camps = DB.campaigns.filter((c) => c.status !== 'wrapped' || clkLinkFor(c.id));
  if (!camps.length) { parts.push('<p class="card-sub">No campaigns yet.</p>'); return parts.join(''); }
  parts.push('<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Campaign</th><th>Link</th><th></th></tr></thead><tbody>' +
    camps.map((c) => {
      const l = clkLinkFor(c.id), pill = clkStatusPill(l), id = esc(c.id);
      return '<tr><td><strong>' + esc(c.name) + '</strong><br><span style="font-size:11.5px;color:var(--text-3)">' + esc(c.brand || '') + '</span></td>' +
        '<td><span class="pill ' + pill.tone + '">' + esc(pill.label) + '</span><br><span style="font-size:11.5px;color:var(--text-3)">' + esc(clkDetail(l)) + '</span></td>' +
        '<td style="text-align:right;white-space:nowrap">' + (l
          ? '<button class="btn xs" data-clk="regen" data-id="' + esc(l.id) + '" data-cid="' + id + '"' + (CLK.busy ? ' disabled' : '') + '>Regenerate</button> ' +
            '<button class="btn xs" data-clk="revoke" data-id="' + esc(l.id) + '" data-cid="' + id + '"' + (CLK.busy || l.status === 'revoked' ? ' disabled' : '') + '>Revoke</button>'
          : '<button class="btn xs primary" data-clk="create" data-cid="' + id + '"' + (CLK.busy ? ' disabled' : '') + '>Create link</button>') +
        '</td></tr>';
    }).join('') + '</tbody></table></div>');
  return parts.join('');
}

export function clkDraw() {
  const body = $('#clkBody');
  if (body) body.innerHTML = clkBodyHtml();
  const ttl = $('#clkTtl');
  if (ttl) ttl.textContent = String(CLK.ttlDays);
}

export async function clkLoad() {
  const res = await clkCall('/api/client-links', 'GET');
  if (res.status === 200 && res.body && res.body.ok) {
    CLK.links = res.body.links || []; CLK.projection = res.body.projection || null;
    CLK.workspaceRevision = res.body.workspaceRevision; CLK.ttlDays = res.body.ttlDays || 90;
    CLK.loaded = true; CLK.error = '';
  } else { CLK.loaded = false; CLK.error = clkProblem(res); }
}

export async function clkAction(kind, id, cid) {
  if (CLK.busy && kind !== 'copy' && kind !== 'dismiss') return;
  const cp = DB.campaigns.find((c) => c.id === cid);
  const name = cp ? cp.name : 'this campaign';
  CLK.msg = null;
  if (kind === 'copy') { if (CLK.shown) copyText(CLK.shown.url, 'Brand link'); return; }
  if (kind === 'dismiss') { CLK.shown = null; return clkDraw(); }
  if (kind === 'regen' && !confirm('Make a new link for "' + name + '"? The old link stops working immediately.')) return;
  if (kind === 'revoke' && !confirm('Turn off the brand link for "' + name + '"? Anyone holding it stops being able to open the page, immediately.')) return;
  CLK.busy = kind; clkDraw();
  try {
    if (kind === 'refresh') await clkLoad();
    else if (kind === 'create' || kind === 'regen') {
      const res = kind === 'create'
        ? await clkCall('/api/client-links', 'POST', { campaignId: cid })
        : await clkCall('/api/client-links/' + encodeURIComponent(id) + '/regenerate', 'POST', {});
      if (res.status === 200 && res.body && res.body.token) {
        CLK.shown = { name, url: location.origin + res.body.path };
        CLK.msg = res.body.viewReady === false
          ? { tone: 'warn', text: 'The link exists but its data is not ready. Press Rebuild now before sending it.' } : null;
      } else CLK.msg = { tone: 'bad', text: clkProblem(res) };
      await clkLoad();
    } else if (kind === 'revoke') {
      const res = await clkCall('/api/client-links/' + encodeURIComponent(id) + '/revoke', 'POST', {});
      CLK.msg = res.status === 200 ? { tone: 'ok', text: 'Link turned off. It stopped working immediately.' } : { tone: 'bad', text: clkProblem(res) };
      if (CLK.shown && res.status === 200) CLK.shown = null;
      await clkLoad();
    } else if (kind === 'rebuild') {
      const res = await clkCall('/api/client-links/rebuild', 'POST', {});
      CLK.msg = res.status === 200 && res.body.ok ? { tone: 'ok', text: 'Rebuilt ' + (res.body.written || 0) + ' brand view' + (res.body.written === 1 ? '' : 's') + '.' }
        : { tone: 'bad', text: res.status === 200 ? 'Some views could not be written. Try again.' : clkProblem(res) };
      await clkLoad();
    }
  } finally { CLK.busy = ''; clkDraw(); }
}

/* called every time the Partners page is drawn */
export function wireClkCard() {
  const card = $('#clkCard');
  if (!card) return;
  clkDraw();
  card.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-clk]') : null;
    if (!b || b.disabled) return;
    clkAction(b.getAttribute('data-clk'), b.getAttribute('data-id') || '', b.getAttribute('data-cid') || '');
  });
  if (!CLK.loaded) clkLoad().then(clkDraw);
}

/* the switch for writing stage changes back to Notion */
export function writebackCardHtml() {
  return `<div class="card">
    <div class="card-head"><h3>Stage changes → Notion</h3><div class="sp"></div>
      <span class="pill ${WRITEBACK.on ? 'green' : 'grey'}">${WRITEBACK.on ? 'On' : 'Off'}</span></div>
    <p class="card-sub" style="margin-top:10px">Moving a creator between stages here sets the same row's
      <strong>Status</strong> in Notion, so the two stop drifting apart. It only touches campaigns whose form
      has a Status column mapped, and only rows that came from Notion.</p>
    <label style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px">
      <input type="checkbox" id="wbOn" ${WRITEBACK.on ? 'checked' : ''}/> Write stage changes back to Notion</label>
    <div class="divider"></div>
    <div class="lbl">How the two vocabularies line up</div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Dashboard stage</th><th>Notion Status</th></tr></thead>
      <tbody>${STAGES.map((st) => {
        const v = st.id === 'dropped' ? 'Declined / Cancelled / Brand Rejected' : STAGE_TO_NOTION[st.id];
        return `<tr><td>${esc(st.label)}</td><td>${v
          ? esc(v)
          : '<span style="color:var(--text-3)">no equivalent — left as it was</span>'}</td></tr>`;
      }).join('')}</tbody>
    </table></div>
    <p class="card-sub" style="margin-top:10px">Notion has no status for the first three, so moving a card there
      changes nothing over there and says so. Content in and In review both read as <em>Waiting Upload</em>;
      that is safe because reading Notion only ever moves a creator forward, never back.</p>
  </div>`;
}

export function wireWritebackCard() {
  const box = $('#wbOn');
  if (box) box.addEventListener('change', () => {
    WRITEBACK.on = box.checked; saveWriteback(); notify();
    toast(WRITEBACK.on ? 'Stage changes will be written to Notion' : 'Stage changes stay in the dashboard');
  });
}

export function settingsPartners(view) {
  DB.partnerLinks = DB.partnerLinks || [];
  const partners = partnersInUse();
  const unread = PARTNER_COMMENTS.list.filter((c) => !c.read);

  view.innerHTML = `<div class="grid g2">
    <div class="card">
      <div class="card-head"><h3>Partner links</h3><div class="sp"></div>
        <span style="font-size:12px;color:var(--text-3)">${partners.length} partner${partners.length === 1 ? '' : 's'}</span></div>
      ${!partners.length ? `<div class="note" style="margin-top:12px">
        No campaigns have a partner yet. Open a campaign → Edit → <strong>Partner</strong> and type the name
        (e.g. SPLABAB). Campaigns with the field left empty stay private and never appear on any partner link.
      </div>` : `
      <p class="card-sub" style="margin-top:10px">Each link is read-only and shows only that partner's campaigns.
        Anyone holding the link can open it, so send it to the person who needs it and revoke it when they no longer do.</p>
      <div class="tbl-wrap" style="margin-top:10px"><table class="tbl">
        <thead><tr><th>Partner</th><th class="num">Campaigns</th><th class="num">Creators shown</th><th>Link</th><th></th></tr></thead>
        <tbody>${partners.map((name) => {
          const link = partnerLinkFor(name);
          const camps = DB.campaigns.filter((c) => c.partner === name);
          const ids = new Set(camps.map((c) => c.id));
          const all = DB.participants.filter((p) => ids.has(p.campaignId));
          const people = all.filter((p) => !partnerStatus(p).theirs).length;
          const hidden = all.length - people;
          return `<tr>
            <td><strong>${esc(name)}</strong></td>
            <td class="num">${num(camps.length)}</td>
            <td class="num">${num(people)}${hidden ? `<br><span style="font-size:11px;color:var(--text-3)">${num(hidden)} awaiting approval, hidden</span>` : ''}</td>
            <td>${link
              ? `<code style="font-size:11px">/partner/${esc(link.token.slice(0, 10))}…</code>`
              : '<span style="color:var(--text-3)">not created</span>'}</td>
            <td style="text-align:right;white-space:nowrap">
              ${link
                ? `<button class="btn xs" data-copy="${esc(name)}">Copy link</button>
                   <button class="btn xs" data-revoke="${esc(name)}">Revoke</button>`
                : `<button class="btn xs primary" data-make="${esc(name)}">Create link</button>`}
            </td></tr>`;
        }).join('')}</tbody>
      </table></div>`}
      <div class="note" style="margin-top:12px">
        <strong>What a partner never sees:</strong> creators still on <em>Waiting Approval</em>, bank details,
        internal notes, fees, shipping addresses, and any campaign that is not theirs. The list is assembled on the server, so those fields are not in
        the page at all rather than merely hidden from it.
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Comments from partners</h3><div class="sp"></div>
        ${unread.length ? `<span class="pill amber">${unread.length} new</span>` : ''}
        <button class="btn xs" id="pcRefresh">Refresh</button></div>
      ${PARTNER_COMMENTS.error ? `<div class="note bad" style="margin-top:10px">${esc(PARTNER_COMMENTS.error)}</div>` : ''}
      ${!PARTNER_COMMENTS.list.length
        ? `<p class="card-sub" style="margin-top:10px">Nothing yet. A partner can comment on any creator row, but cannot change anything.</p>`
        : `<div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;max-height:60vh;overflow:auto">
            ${PARTNER_COMMENTS.list.slice(0, 60).map((c) => {
              const p = DB.participants.find((x) => x.id === c.pid);
              const cr = p ? byCreator[p.creatorId] : null;
              return `<div class="note" style="margin:0${c.read ? '' : ';border-color:var(--warning)'}">
                <div style="display:flex;gap:8px;align-items:baseline">
                  <strong>${esc(c.author)}</strong>
                  <span style="color:var(--text-3);font-size:11.5px">${esc(c.partner)}</span>
                  <div style="flex:1"></div>
                  <span style="color:var(--text-3);font-size:11.5px">${esc(new Date(c.at).toLocaleString())}</span>
                </div>
                <div style="margin:5px 0">${esc(c.text)}</div>
                ${cr ? `<button class="btn xs" data-goto="${esc(c.pid)}">${esc(cr.handle)}</button>`
                     : `<span style="color:var(--text-3);font-size:11.5px">row no longer exists</span>`}
              </div>`;
            }).join('')}
          </div>
          ${unread.length ? `<button class="btn sm" id="pcRead" style="margin-top:10px">Mark all as read</button>` : ''}`}
    </div>
    ${clkCardHtml()}
  </div>`;
  wireClkCard();

  $$('[data-make]').forEach((b) => b.addEventListener('click', () => {
    DB.partnerLinks.push({ partner: b.dataset.make, token: newPartnerToken(), createdAt: new Date().toISOString(), revokedAt: null });
    /* the link only works once the server has the token, so save immediately
       rather than waiting for the debounce */
    /* the toast used to fire on a refused save too, so a link the server
       never stored still read as created and got sent to the venue */
    serverSave({ silent: true }).then((r) => toastAfterSave('Link created', r));
    notify();
  }));

  $$('[data-copy]').forEach((b) => b.addEventListener('click', () => {
    const link = partnerLinkFor(b.dataset.copy);
    if (link) copyText(location.origin + '/partner/' + link.token, 'Partner link');
  }));

  $$('[data-revoke]').forEach((b) => b.addEventListener('click', () => {
    const link = partnerLinkFor(b.dataset.revoke);
    if (!link) return;
    if (!confirm(`Turn off ${b.dataset.revoke}'s link? Anyone holding it stops being able to open the page.`)) return;
    link.revokedAt = new Date().toISOString();
    serverSave({ silent: true }).then((r) => toastAfterSave('Link revoked', r));
    notify();
  }));

  $$('[data-goto]').forEach((b) => b.addEventListener('click', () => showParticipant(b.dataset.goto)));

  $('#pcRefresh').addEventListener('click', () => loadPartnerComments().then(() => notify()));
  const pcRead = $('#pcRead');
  if (pcRead) pcRead.addEventListener('click', async () => {
    await fetch('/api/partner-comments/read', { method: 'POST' });
    await loadPartnerComments();
    notify();
  });
}
