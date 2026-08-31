import { num } from '../lib/format.js';
import { DB, byCreator, notify, serverSave } from '../model/db.js';
import { partnersInUse } from '../sync/partner.js';
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
        <thead><tr><th>Partner</th><th class="num">Campaigns</th><th class="num">Creators</th><th>Link</th><th></th></tr></thead>
        <tbody>${partners.map((name) => {
          const link = partnerLinkFor(name);
          const camps = DB.campaigns.filter((c) => c.partner === name);
          const ids = new Set(camps.map((c) => c.id));
          const people = DB.participants.filter((p) => ids.has(p.campaignId)).length;
          return `<tr>
            <td><strong>${esc(name)}</strong></td>
            <td class="num">${num(camps.length)}</td>
            <td class="num">${num(people)}</td>
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
        <strong>What a partner never sees:</strong> bank details, internal notes, fees, shipping addresses,
        and any campaign that is not theirs. The list is assembled on the server, so those fields are not in
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
  </div>`;

  $$('[data-make]').forEach((b) => b.addEventListener('click', () => {
    DB.partnerLinks.push({ partner: b.dataset.make, token: newPartnerToken(), createdAt: new Date().toISOString(), revokedAt: null });
    /* the link only works once the server has the token, so save immediately
       rather than waiting for the debounce */
    serverSave({ silent: true }).then(() => toast('Link created — copy it once it says Saved'));
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
    serverSave({ silent: true });
    notify();
    toast('Link revoked');
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
