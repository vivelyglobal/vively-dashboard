import { BILLING_LABELS, CONTRACT, CONTRACT_DOCS, saveContractDefaults } from '../docs/contracts.js';
import { blocksToHtml, blocksToText, downloadDocx } from '../docs/docx.js';
import { DB, byCampaign, notify } from '../model/db.js';
import { $, $$, esc } from '../ui/dom.js';
import { copyText } from '../ui/html.js';
import { toast } from '../ui/overlay.js';

/* ============================================================
   VIEW — CONTRACTS
   layer 2 = which document · layer 3 = draft / clauses / preview
   ============================================================ */

export function contractFileName(docId, L) {
  const d = CONTRACT_DOCS[docId];
  const who = (CONTRACT.clientName || 'Client').replace(/[^\w가-힣 .-]/g, '').trim().replace(/\s+/g, '_') || 'Client';
  return `${(CONTRACT.agencyName || 'ScoutLab').replace(/\W+/g, '')}_${d.file}_${who}_${L.toUpperCase()}.docx`;
}

export function contractBlocks(docId) {
  return CONTRACT_DOCS[docId].build(CONTRACT, CONTRACT.lang);
}

export function refreshContractPreview(docId) {
  const el = $('#docPreview');
  if (el) el.innerHTML = blocksToHtml(contractBlocks(docId));
  const warn = $('#docWarn');
  if (warn) warn.style.display = CONTRACT.clientName.trim() ? 'none' : '';
}

export function contractToolbar(docId) {
  return `<div class="card-head" style="margin-bottom:14px">
    <div class="seg no-print" id="langSeg">
      <button data-l="en" class="${CONTRACT.lang === 'en' ? 'active' : ''}">English</button>
      <button data-l="ko" class="${CONTRACT.lang === 'ko' ? 'active' : ''}">한국어</button>
    </div>
    <div class="sp"></div>
    <button class="btn sm" id="docCopy">Copy text</button>
    <button class="btn sm" id="docPrint">Print / PDF</button>
    <button class="btn primary sm" id="docWord">Download .docx</button>
  </div>`;
}

export function wireContractToolbar(docId) {
  $('#langSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    CONTRACT.lang = b.dataset.l; saveContractDefaults(); notify();
  });
  $('#docWord').addEventListener('click', () => {
    if (!CONTRACT.clientName.trim() && !confirm('No client company name yet — the document will show blanks. Download anyway?')) return;
    downloadDocx(contractBlocks(docId), contractFileName(docId, CONTRACT.lang), CONTRACT_DOCS[docId].label);
  });
  $('#docPrint').addEventListener('click', () => window.print());
  $('#docCopy').addEventListener('click', () => copyText(blocksToText(contractBlocks(docId)), 'Contract text'));
}

/* --------------------------------- draft --------------------------------- */
export function contractDraftTab(view, docId) {
  const f = CONTRACT;
  const isSow = docId === 'sow';
  const isShort = docId === 'short';
  const showProject = docId !== 'msa';

  view.innerHTML = contractToolbar(docId) + `
    <div class="grid g-1-2" style="align-items:start">
      <div>
        <div id="docWarn" class="note warn" style="margin-bottom:14px;display:${f.clientName.trim() ? 'none' : ''}">
          <strong>Client company name</strong> is the only thing this document really needs. Everything else already has a
          default from your signed template and can be left alone.
        </div>

        <div class="card" style="margin-bottom:14px">
          <div class="card-head"><h3>Client</h3><div class="sp"></div>
            ${DB.campaigns.length ? `<select id="docFromCampaign" style="width:190px;padding:5px 8px;font-size:12px">
              <option value="">Prefill from campaign…</option>
              ${DB.campaigns.map((c) => `<option value="${c.id}">${esc(c.brand)} — ${esc(c.name)}</option>`).join('')}
            </select>` : ''}</div>
          <div class="field"><label>Company name <span style="color:var(--critical)">*</span></label>
            <input type="text" data-cf="clientName" value="${esc(f.clientName)}" placeholder="e.g. TONYMOLY Co., Ltd."/></div>
          <div class="grid g2" style="gap:10px">
            <div class="field"><label>Business reg. no.</label><input type="text" data-cf="clientReg" value="${esc(f.clientReg)}"/></div>
            <div class="field"><label>Representative</label><input type="text" data-cf="clientRep" value="${esc(f.clientRep)}"/></div>
          </div>
          <div class="field"><label>Address</label><input type="text" data-cf="clientAddress" value="${esc(f.clientAddress)}"/></div>
          <div class="grid g2" style="gap:10px">
            <div class="field"><label>Contact person</label><input type="text" data-cf="clientContact" value="${esc(f.clientContact)}"/></div>
            <div class="field"><label>Phone / email</label><input type="text" data-cf="clientPhone" value="${esc(f.clientPhone)}"/></div>
          </div>
        </div>

        <div class="card" style="margin-bottom:14px">
          <div class="card-head"><h3>Agency</h3><div class="sp"></div><span class="pill grey">remembered</span></div>
          <p class="card-sub">Saved in this browser, so you only fill it in once.</p>
          <div class="grid g2" style="gap:10px">
            <div class="field"><label>Company name</label><input type="text" data-cf="agencyName" value="${esc(f.agencyName)}"/></div>
            <div class="field"><label>Business reg. no.</label><input type="text" data-cf="agencyReg" value="${esc(f.agencyReg)}"/></div>
            <div class="field"><label>Representative</label><input type="text" data-cf="agencyRep" value="${esc(f.agencyRep)}"/></div>
            <div class="field"><label>Contact person</label><input type="text" data-cf="agencyContact" value="${esc(f.agencyContact)}"/></div>
          </div>
          <div class="field"><label>Address</label><input type="text" data-cf="agencyAddress" value="${esc(f.agencyAddress)}"/></div>
          <div class="field" style="margin-bottom:0"><label>Phone / email</label><input type="text" data-cf="agencyPhone" value="${esc(f.agencyPhone)}"/></div>
        </div>

        <div class="card" style="margin-bottom:14px">
          <div class="card-head"><h3>Dates</h3></div>
          <div class="grid g2" style="gap:10px">
            <div class="field"><label>${isSow ? 'SOW date' : 'Effective date'}</label>
              <input type="date" data-cf="effectiveDate" value="${esc(f.effectiveDate)}"/></div>
            ${isSow ? `<div class="field"><label>Master agreement dated</label>
              <input type="date" data-cf="masterDate" value="${esc(f.masterDate)}"/></div>` : ''}
          </div>
        </div>

        ${showProject ? `<div class="card" style="margin-bottom:14px">
          <div class="card-head"><h3>Project</h3></div>
          <div class="field"><label>Campaign / project name</label><input type="text" data-cf="campaignName" value="${esc(f.campaignName)}"/></div>
          <div class="field"><label>${isShort ? 'Scope of services and deliverables' : 'Purpose and overview'}</label>
            <textarea data-cf="campaignPurpose" style="min-height:64px">${esc(f.campaignPurpose)}</textarea></div>
          <div class="grid g2" style="gap:10px">
            <div class="field"><label>Platforms</label><input type="text" data-cf="platforms" value="${esc(f.platforms)}" placeholder="Instagram, TikTok"/></div>
            <div class="field"><label>Key milestones</label><input type="text" data-cf="milestones" value="${esc(f.milestones)}"/></div>
            <div class="field"><label>Campaign start</label><input type="date" data-cf="periodStart" value="${esc(f.periodStart)}"/></div>
            <div class="field"><label>Campaign end</label><input type="date" data-cf="periodEnd" value="${esc(f.periodEnd)}"/></div>
          </div>
          ${isSow ? `<div class="divider"></div>
            <div class="card-head"><h3>Deliverables table</h3><div class="sp"></div>
              <button class="btn xs" id="delivAdd">+ Row</button></div>
            <div id="delivRows" style="margin-top:10px"></div>` : ''}
          ${isSow ? `<div class="field" style="margin-top:12px"><label>Special notes / assumptions</label>
            <textarea data-cf="notes" style="min-height:56px">${esc(f.notes)}</textarea></div>` : ''}
        </div>` : ''}

        <div class="card">
          <div class="card-head"><h3>Fee &amp; billing</h3></div>
          <div class="grid g2" style="gap:10px">
            <div class="field"><label>Currency</label><select data-cf="currency">
              <option value="KRW" ${f.currency === 'KRW' ? 'selected' : ''}>KRW ₩</option>
              <option value="USD" ${f.currency === 'USD' ? 'selected' : ''}>USD $</option></select></div>
            <div class="field"><label>Total service fee (VAT excl.)</label>
              <input type="text" data-cf="fee" value="${esc(f.fee)}" placeholder="12000000"/></div>
          </div>
          <div class="field"><label>Billing cycle</label><select data-cf="billing">
            ${Object.entries(BILLING_LABELS).map(([k, l]) => `<option value="${k}" ${f.billing === k ? 'selected' : ''}>${l}</option>`).join('')}
          </select></div>
          <div class="field" id="billingCustomWrap" style="display:${f.billing === 'custom' ? '' : 'none'}">
            <label>Custom payment wording</label>
            <textarea data-cf="billingCustom" style="min-height:56px">${esc(f.billingCustom)}</textarea></div>
          <div class="field" style="margin-bottom:0"><label>Payment due (days from invoice)</label>
            <input type="number" data-cf="netDays" value="${f.netDays}" min="0" max="120"/></div>
        </div>
      </div>

      <div class="card" style="padding:0;overflow:hidden">
        <div class="card-head" style="padding:14px 18px 0"><h3>Live preview</h3><div class="sp"></div>
          <span style="font-size:11.5px;color:var(--text-3)">${CONTRACT.lang === 'ko' ? '한국어' : 'English'}</span></div>
        <div class="doc-scroll"><div class="doc-page" id="docPreview"></div></div>
      </div>
    </div>`;

  if (isSow) renderDeliverableRows();
  wireContractToolbar(docId);
  wireContractFields(docId);
  refreshContractPreview(docId);

  const pick = $('#docFromCampaign');
  if (pick) pick.addEventListener('change', () => {
    const cp = byCampaign[pick.value];
    if (!cp) return;
    CONTRACT.clientName = cp.brand || CONTRACT.clientName;
    CONTRACT.campaignName = cp.name || '';
    CONTRACT.campaignPurpose = cp.deliverables || '';
    CONTRACT.platforms = (cp.platforms || []).join(', ');
    CONTRACT.periodStart = cp.start || '';
    CONTRACT.periodEnd = cp.end || '';
    if (cp.budget) CONTRACT.fee = String(cp.budget);
    toast('Prefilled from ' + cp.brand);
    notify();
  });
  const add = $('#delivAdd');
  if (add) add.addEventListener('click', () => {
    CONTRACT.deliverables.push({ service: '', platform: '', qty: '', deadline: '' });
    renderDeliverableRows(); refreshContractPreview(docId);
  });
}

export function renderDeliverableRows() {
  const wrap = $('#delivRows');
  if (!wrap) return;
  wrap.innerHTML = CONTRACT.deliverables.map((d, i) => `
    <div style="display:grid;grid-template-columns:1.6fr 1fr .7fr 1fr 28px;gap:6px;margin-bottom:6px">
      <input type="text" data-dv="${i}.service" value="${esc(d.service)}" placeholder="Service / deliverable" style="padding:6px 9px;font-size:12.5px"/>
      <input type="text" data-dv="${i}.platform" value="${esc(d.platform)}" placeholder="Platform" style="padding:6px 9px;font-size:12.5px"/>
      <input type="text" data-dv="${i}.qty" value="${esc(d.qty)}" placeholder="Qty" style="padding:6px 9px;font-size:12.5px"/>
      <input type="text" data-dv="${i}.deadline" value="${esc(d.deadline)}" placeholder="Deadline" style="padding:6px 9px;font-size:12.5px"/>
      <button class="icon-btn" data-dvdel="${i}" title="Remove" style="width:28px;height:28px;font-size:14px">&times;</button>
    </div>`).join('');
  $$('[data-dvdel]', wrap).forEach((b) => b.addEventListener('click', () => {
    CONTRACT.deliverables.splice(+b.dataset.dvdel, 1);
    if (!CONTRACT.deliverables.length) CONTRACT.deliverables.push({ service: '', platform: '', qty: '', deadline: '' });
    renderDeliverableRows(); refreshContractPreview('sow');
  }));
  $$('[data-dv]', wrap).forEach((inp) => inp.addEventListener('input', () => {
    const [i, key] = inp.dataset.dv.split('.');
    CONTRACT.deliverables[+i][key] = inp.value;
    refreshContractPreview('sow');
  }));
}

export const CONTRACT_NUMERIC = new Set(['netDays','lateInterest','cancelFee','cancelWindowDays','reviewDays','revisionRounds',
  'nonCircMonths','nonCircPenalty','confidentialityYears','termYears','cureDays','forceMajeureDays']);

export function wireContractFields(docId) {
  $$('[data-cf]').forEach((el) => {
    const key = el.dataset.cf;
    const handler = () => {
      CONTRACT[key] = CONTRACT_NUMERIC.has(key) ? (el.value === '' ? '' : Number(el.value)) : el.value;
      if (key === 'billing') {
        const w = $('#billingCustomWrap');
        if (w) w.style.display = el.value === 'custom' ? '' : 'none';
      }
      saveContractDefaults();
      refreshContractPreview(docId);
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  });
  $$('[data-cc]').forEach((el) => el.addEventListener('change', () => {
    CONTRACT.clauses[el.dataset.cc] = el.checked;
    refreshContractPreview(docId);
  }));
}

/* -------------------------------- clauses -------------------------------- */
export const CLAUSE_INFO = {
  portfolio:        ['Portfolio & reference use', 'Lets you show the campaign in your portfolio. MSA needs written consent; short form uses notice + 5 days to object.'],
  language:         ['Language precedence article', 'Says which language version wins if the EN and KO texts disagree. MSA only.'],
  cancellationFee:  ['Late interest & cancellation fee', 'Charges interest on late payment and a cancellation fee if the client pulls out close to the start date.'],
  reviewProcess:    ['Content review window', 'Client must approve or request changes within the review window, or the draft counts as approved.'],
  indemnity:        ['Indemnity & influencer substitution', 'Client covers claims caused by their own product or instructions; you may swap an influencer who drops out.'],
  nonCircumvention: ['Non-circumvention', 'Stops the client going direct to creators you introduced, with a penalty. Short form only.'],
  forceMajeure:     ['Force majeure', 'No liability while something outside anyone’s control is blocking performance.'],
  terminationEffect:['Effect of termination', 'Client pays for work done up to the termination date.'],
  esign:            ['Amendment, assignment & e-signature', 'Written amendments only, no assignment without consent, electronic signature valid.']
};
export const CLAUSES_FOR = {
  msa:   ['portfolio', 'language', 'esign'],
  sow:   [],
  short: ['cancellationFee', 'reviewProcess', 'indemnity', 'nonCircumvention', 'forceMajeure', 'terminationEffect', 'portfolio', 'esign']
};
export const TERMS_FOR = {
  msa:   ['netDays', 'lateInterest', 'reviewDays', 'confidentialityYears', 'termYears', 'cureDays', 'forceMajeureDays'],
  sow:   ['netDays'],
  short: ['netDays', 'lateInterest', 'cancelFee', 'cancelWindowDays', 'reviewDays', 'revisionRounds', 'nonCircMonths', 'nonCircPenalty', 'confidentialityYears', 'cureDays']
};
export const TERM_LABELS = {
  netDays: ['Payment due', 'days from invoice'],
  lateInterest: ['Late payment interest', '% per year'],
  cancelFee: ['Cancellation fee', '% of total fee'],
  cancelWindowDays: ['Cancellation window', 'days before start'],
  reviewDays: ['Content review window', 'business days'],
  revisionRounds: ['Revision rounds included', 'per content'],
  nonCircMonths: ['Non-circumvention period', 'months'],
  nonCircPenalty: ['Non-circumvention penalty', '% of deal value'],
  confidentialityYears: ['Confidentiality survives', 'years'],
  termYears: ['Agreement term', 'years, auto-renewing'],
  cureDays: ['Cure period after breach', 'days'],
  forceMajeureDays: ['Force majeure exit after', 'days']
};

export function contractClausesTab(view, docId) {
  const clauses = CLAUSES_FOR[docId];
  const terms = TERMS_FOR[docId];

  view.innerHTML = contractToolbar(docId) + `
    <div class="grid g-1-2" style="align-items:start">
      <div>
        <div class="card" style="margin-bottom:14px">
          <div class="card-head"><h3>Commercial terms</h3></div>
          <p class="card-sub">These numbers flow straight into the clause wording.</p>
          <div class="grid g2" style="gap:10px">
            ${terms.map((k) => `<div class="field"><label>${TERM_LABELS[k][0]}</label>
              <div style="display:flex;align-items:center;gap:8px">
                <input type="number" data-cf="${k}" value="${CONTRACT[k]}" style="width:90px"/>
                <span style="font-size:12px;color:var(--text-3)">${TERM_LABELS[k][1]}</span>
              </div></div>`).join('')}
          </div>
        </div>

        ${clauses.length ? `<div class="card" style="margin-bottom:14px">
          <div class="card-head"><h3>Optional clauses</h3></div>
          <p class="card-sub">Switch a clause off and it disappears from the document.</p>
          ${clauses.map((k) => `<label style="display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--line);text-transform:none;letter-spacing:0">
            <input type="checkbox" data-cc="${k}" ${CONTRACT.clauses[k] ? 'checked' : ''} style="margin-top:2px"/>
            <span><span style="font-size:13.5px;color:var(--text);font-weight:500">${CLAUSE_INFO[k][0]}</span>
            <span style="display:block;font-size:12px;color:var(--text-3);margin-top:2px">${CLAUSE_INFO[k][1]}</span></span>
          </label>`).join('')}
        </div>` : ''}

        <div class="card">
          <div class="card-head"><h3>Law &amp; language</h3></div>
          <div class="field"><label>Governing law</label><input type="text" data-cf="governingLaw" value="${esc(CONTRACT.governingLaw)}"/></div>
          <div class="field"><label>Jurisdiction</label><input type="text" data-cf="jurisdiction" value="${esc(CONTRACT.jurisdiction)}"/></div>
          <div class="field" style="margin-bottom:0"><label>Which language version prevails</label>
            <select data-cf="masterLanguage">
              <option value="en" ${CONTRACT.masterLanguage === 'en' ? 'selected' : ''}>English is the master version</option>
              <option value="ko" ${CONTRACT.masterLanguage === 'ko' ? 'selected' : ''}>한국어 is the master version</option>
            </select></div>
          <p class="card-sub" style="margin:10px 0 0">This decides the wording of the language article — it is independent of which
          language you are currently reading.</p>
        </div>
      </div>

      <div class="card" style="padding:0;overflow:hidden">
        <div class="card-head" style="padding:14px 18px 0"><h3>Live preview</h3></div>
        <div class="doc-scroll"><div class="doc-page" id="docPreview"></div></div>
      </div>
    </div>`;

  wireContractToolbar(docId);
  wireContractFields(docId);
  refreshContractPreview(docId);
}

/* -------------------------------- preview -------------------------------- */
export function contractPreviewTab(view, docId) {
  view.innerHTML = contractToolbar(docId) + `
    <div id="docWarn" class="note warn no-print" style="margin-bottom:14px;display:${CONTRACT.clientName.trim() ? 'none' : ''}">
      No client company name yet — the document will print with blanks where the name should be.
    </div>
    <div class="doc-page wide" id="docPreview"></div>`;
  wireContractToolbar(docId);
  refreshContractPreview(docId);
}

export function renderContracts(view, item, tab) {
  const docId = CONTRACT_DOCS[item] ? item : 'msa';
  if (tab === 'clauses') return contractClausesTab(view, docId);
  if (tab === 'preview') return contractPreviewTab(view, docId);
  return contractDraftTab(view, docId);
}
