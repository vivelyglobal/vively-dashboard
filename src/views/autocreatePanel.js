import { $, esc } from '../ui/dom.js';

/* ============================================================
   SETUP -> NOTION: AUTO-CREATE PANEL (staff only)
   Runs the server's Notion auto-create job without typing web
   addresses. Every call is the staff-only /api/notion/autocreate/*
   family; the server decides what is allowed, this panel only asks
   and shows the answer. Nothing here is called on page load except
   the read-only status, and only when this settings page is opened.
   Every Notion-derived word (page titles) goes through esc().
   ============================================================ */
export const NAC = { status: null, statusAt: 0, run: null, runKind: '', msg: null, busy: '' };

/* Off / Dry run / Live, from the server's own status answer */
export function nacMode(status) {
  if (!status || !status.enabled) return { id: 'off', label: 'Off', tone: 'grey' };
  if (status.dryRun) return { id: 'dry', label: 'Dry run', tone: 'yellow' };
  return { id: 'live', label: 'Live', tone: 'green' };
}

/* the request body for the run call; always an explicit true or false */
export function nacRunBody(dryRun) { return { dryRun: !!dryRun }; }

/* one request to the staff API. Never throws: a network failure and a
   non-JSON answer both come back as { status, body } the panel can show. */
export async function nacCall(path, method, body) {
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

/* plain-language message for a failed call. 503 is "feature off" and 401
   is "not signed in"; neither is shown as a scary error. */
export function nacProblem(res) {
  const b = res.body || {};
  if (res.status === 401) return { tone: 'warn', text: 'Sign in as staff to use this panel.' };
  if (res.status === 403) return { tone: 'warn', text: 'This account is not allowed to use it. Staff only.' };
  if (res.status === 503) return { tone: 'warn', text: 'Auto-create is switched off on the server.' + (b.reason ? ' (' + b.reason + ')' : '') };
  if (res.status === 0) return { tone: 'bad', text: b.error || 'Could not reach the server.' };
  return { tone: 'bad', text: b.error || ('The server said no (' + res.status + ').') };
}

export const NAC_WHY = {
  'baseline-seen': 'was already in Notion at the starting point',
  'template-or-test': 'template or test page',
  'no-title': 'no title',
  'dismissed': 'dismissed',
  'create-cap': 'over the per-run limit, waits for the next check',
  'day-cap': 'daily limit reached, waits for tomorrow',
  'lookup-failed': 'could not read its form, will try again'
};
export function nacWhy(code) { return NAC_WHY[code] || String(code || ''); }

export function nacCounts(last) {
  const c = (last && last.counts) || {};
  const n = (k) => (Number.isFinite(c[k]) ? c[k] : 0);
  return { created: n('created'), linked: n('linked'), seen: n('seen'), skipped: n('skipped'), ambiguous: n('ambiguous'), errors: n('errors') };
}

export function nacTitle(x) { return (x && x.title) ? String(x.title) : 'Untitled page'; }
export function nacShortId(id) { return String(id || '').replace(/-/g, '').slice(0, 8); }

/* a readable list of what a run did, or WOULD do when it was a dry run */
export function nacRunHtml(run) {
  if (!run) return '';
  const dry = !!run.dryRun;
  const list = (rows, mk) => '<ul style="margin:4px 0 0 18px;padding:0;font-size:12.5px">' +
    rows.map((x) => '<li>' + mk(x) + '</li>').join('') + '</ul>';
  const sec = (head, rows, mk) => (rows && rows.length)
    ? '<div style="margin-top:10px"><strong>' + esc(head) + ' (' + rows.length + ')</strong>' + list(rows, mk) + '</div>' : '';
  const t = (x) => '<strong>' + esc(nacTitle(x)) + '</strong>';
  const why = (x) => ' <span style="color:var(--text-3)">(' + esc(nacWhy(x.why)) + ')</span>';
  const out = [];
  out.push('<div class="lbl">' + (dry ? 'Preview: nothing was changed' : 'Result of the live run') + '</div>');
  if (run.baseline) {
    out.push('<p class="card-sub" style="margin:4px 0">' + (run.baseline.recorded
      ? 'Starting point saved: ' + esc(run.baseline.pages) + ' pages already in Notion will never be turned into campaigns.'
      : 'First live run: it would only save a starting point (' + esc(run.baseline.pages) + ' pages already in Notion) and create nothing.') + '</p>');
  }
  out.push(sec(dry ? 'Would create' : 'Created', run.created, (x) => t(x) + (x.postponed ? ' <span class="tag">postponed</span>' : '')));
  out.push(sec(dry ? 'Would link to an existing campaign' : 'Linked to an existing campaign', run.linked, (x) => t(x)));
  out.push(sec('Not created, already in Notion before the starting point', run.seen, (x) => t(x) + why(x)));
  out.push(sec('Skipped', run.skipped, (x) => t(x) + why(x)));
  out.push(sec('Needs a look: matches more than one campaign', run.ambiguous, (x) => t(x)));
  out.push(sec('Waiting', run.deferred, (x) => t(x) + why(x)));
  out.push(sec('Dismissed', run.dismissed, (x) => t(x)));
  out.push(sec('Errors', (run.errors || []).map((e) => ({ title: e })), (x) => esc(x.title)));
  const total = ['created', 'linked', 'seen', 'skipped', 'ambiguous', 'deferred', 'dismissed', 'errors']
    .reduce((a, k) => a + ((run[k] || []).length || 0), 0);
  if (!total && !run.baseline) out.push('<p class="card-sub" style="margin:6px 0">Nothing new in Notion.</p>');
  if (run.olderPages) out.push('<p class="card-sub" style="margin:8px 0 0">' + esc(run.olderPages) + ' older page' + (run.olderPages === 1 ? '' : 's') + ' left alone.</p>');
  return out.join('');
}

/* skipped pages from the last run, plus every dismissed page id; only a
   dismissed one can be undone */
export function nacSkippedRows(status, run) {
  const rows = [];
  const seen = new Set();
  const take = (arr, kind) => (arr || []).forEach((x) => {
    if (!x || !x.pageId || seen.has(x.pageId)) return;
    seen.add(x.pageId); rows.push({ pageId: x.pageId, title: nacTitle(x), why: x.why || kind, undo: kind === 'dismissed' });
  });
  take(run && run.dismissed, 'dismissed');
  ((status && status.state && status.state.dismissed) || []).forEach((id) => {
    if (!seen.has(id)) { seen.add(id); rows.push({ pageId: id, title: 'Page ' + nacShortId(id), why: 'dismissed', undo: true }); }
  });
  take(run && run.skipped, 'skipped');
  return rows;
}

/* the sentence shown before a live run, built from the preview the server
   just returned. Returns '' when there is nothing to confirm. */
export function nacConfirmText(preview) {
  if (!preview) return '';
  if (preview.baseline && preview.baseline.wouldRecord) {
    return 'This is the first live run. It will save a starting point (' + preview.baseline.pages +
      ' pages already in Notion) and create 0 campaigns. Go ahead?';
  }
  const n = (preview.created || []).length;
  if (!n) return '';
  const names = preview.created.slice(0, 5).map((x) => nacTitle(x).slice(0, 60)).join(', ');
  return 'Create ' + n + ' campaign' + (n === 1 ? '' : 's') + ' in the dashboard now (' + names + (n > 5 ? ', and more' : '') + ')?';
}

export function nacCardHtml() {
  const mode = nacMode(NAC.status);
  return '<div class="card" id="nacCard">' +
    '<div class="card-head"><h3>Notion auto-create</h3><div class="sp"></div>' +
    '<span class="pill ' + mode.tone + '" id="nacPill">' + esc(NAC.status ? mode.label : '...') + '</span></div>' +
    '<p class="card-sub" style="margin-top:10px">Turns a new page in the PAID COLLABORATION list in Notion into a campaign here. ' +
    '<strong>Preview</strong> only looks. <strong>Run now</strong> writes, and only works when the server is Live.</p>' +
    '<div id="nacBody"></div></div>';
}

export function nacBodyHtml() {
  const st = NAC.status;
  const parts = [];
  if (NAC.msg) parts.push('<div class="note ' + (NAC.msg.tone === 'bad' ? 'bad' : NAC.msg.tone === 'ok' ? '' : 'warn') + '" style="margin:10px 0">' + esc(NAC.msg.text) + '</div>');
  if (st && st.enabled) {
    const last = st.last, c = nacCounts(last), s = st.state || {};
    parts.push('<dl class="kv" style="margin-top:8px">' +
      '<dt>Last run</dt><dd>' + (last && last.at ? esc(new Date(last.at).toLocaleString()) + (last.dryRun ? ' (preview)' : '') : 'none yet') + '</dd>' +
      '<dt>Created / linked</dt><dd>' + c.created + ' / ' + c.linked + '</dd>' +
      '<dt>Seen / skipped</dt><dd>' + c.seen + ' / ' + c.skipped + '</dd>' +
      '<dt>Ambiguous / errors</dt><dd>' + c.ambiguous + ' / ' + c.errors + '</dd>' +
      '<dt>Today</dt><dd>' + esc(s.createdTodayCount == null ? '-' : s.createdTodayCount) + ' of ' + esc(s.maxCreatePerDay == null ? '-' : s.maxCreatePerDay) + ' allowed</dd>' +
      '<dt>Starting point</dt><dd>' + (s.baselineAt ? esc(new Date(s.baselineAt).toLocaleString()) : 'not saved yet') + '</dd></dl>');
  } else if (st && st.reason) {
    parts.push('<p class="card-sub">Off because: ' + esc(st.reason) + '.</p>');
  }
  const live = nacMode(st).id === 'live';
  const busy = !!NAC.busy;
  parts.push('<div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">' +
    '<button class="btn sm" data-nac="preview" ' + (st && st.enabled && !busy ? '' : 'disabled') + '>Preview (dry run)</button>' +
    '<button class="btn primary sm" data-nac="run" ' + (live && !busy ? '' : 'disabled') + ' title="' + (live ? 'Create the campaigns for real' : 'Only available when the server is Live') + '">Run now</button>' +
    '<button class="btn xs" data-nac="refresh" ' + (busy ? 'disabled' : '') + '>Refresh</button>' +
    (busy ? '<span style="font-size:12px;color:var(--text-3);align-self:center">Working...</span>' : '') + '</div>');
  if (NAC.run) parts.push('<div id="nacRun">' + nacRunHtml(NAC.run) + '</div>');
  const rows = nacSkippedRows(st, NAC.run);
  if (rows.length) {
    parts.push('<div class="divider"></div><div class="lbl">Skipped / dismissed</div>' +
      '<ul style="margin:4px 0 0 18px;padding:0;font-size:12.5px">' + rows.map((r) => '<li>' + esc(r.title) +
        ' <span style="color:var(--text-3)">(' + esc(nacWhy(r.why)) + ')</span>' +
        (r.undo ? ' <button class="btn xs" data-nac="undo" data-pageid="' + esc(r.pageId) + '">Undo</button>' : '') + '</li>').join('') + '</ul>');
  }
  return parts.join('');
}

export function nacDraw() {
  const body = $('#nacBody');
  if (body) body.innerHTML = nacBodyHtml();
  const pill = $('#nacPill');
  if (pill) { const m = nacMode(NAC.status); pill.className = 'pill ' + m.tone; pill.textContent = NAC.status ? m.label : '...'; }
}

export async function nacLoadStatus() {
  const res = await nacCall('/api/notion/autocreate/status', 'GET');
  if (res.status === 200 && res.body && res.body.ok) { NAC.status = res.body; NAC.statusAt = Date.now(); }
  else { NAC.status = null; NAC.msg = NAC.msg || nacProblem(res); }
}

export async function nacRunCall(dryRun) {
  const res = await nacCall('/api/notion/autocreate/run', 'POST', nacRunBody(dryRun));
  if (res.status === 200 && res.body && res.body.run) return { run: res.body.run };
  return { problem: nacProblem(res) };
}

export async function nacAction(kind, pageId) {
  if (NAC.busy) return;
  NAC.busy = kind; NAC.msg = null; nacDraw();
  try {
    if (kind === 'refresh') await nacLoadStatus();
    else if (kind === 'undo') {
      const res = await nacCall('/api/notion/autocreate/undismiss', 'POST', { pageId });
      NAC.msg = res.status === 200 ? { tone: 'ok', text: 'Undone. It can be picked up again at the next check if it is new in Notion.' } : nacProblem(res);
      await nacLoadStatus();
    } else if (kind === 'preview') {
      const r = await nacRunCall(true);
      if (r.problem) NAC.msg = r.problem; else { NAC.run = r.run; NAC.runKind = 'preview'; }
      await nacLoadStatus();
    } else if (kind === 'run') {
      /* the dry run comes first, so the confirm sentence states a real count */
      const p = await nacRunCall(true);
      if (p.problem) NAC.msg = p.problem;
      else {
        const sentence = nacConfirmText(p.run);
        if (!sentence) { NAC.run = p.run; NAC.runKind = 'preview'; NAC.msg = { tone: 'ok', text: 'Nothing to create right now.' }; }
        else if (!confirm(sentence)) { NAC.run = p.run; NAC.runKind = 'preview'; NAC.msg = { tone: 'ok', text: 'Cancelled. Nothing was changed.' }; }
        else {
          const r = await nacRunCall(false);
          if (r.problem) NAC.msg = r.problem;
          else {
            NAC.run = r.run; NAC.runKind = 'live';
            const made = (r.run.created || []).length;
            const promised = (p.run.created || []).length;
            NAC.msg = made !== promised
              ? { tone: 'warn', text: 'Expected ' + promised + ', created ' + made + '. Check the result below, then press Refresh.' }
              : { tone: 'ok', text: made ? made + ' campaign' + (made === 1 ? '' : 's') + ' created. Reload this page to see them.' : 'Done.' };
          }
        }
      }
      await nacLoadStatus();
    }
  } finally { NAC.busy = ''; nacDraw(); }
}

/* called every time the Notion settings page is drawn. Draws from what it
   already knows, and asks the server for status only when it has none or
   it is older than 30 seconds. */
export function wireNacCard() {
  const card = $('#nacCard');
  if (!card) return;
  if (NAC.msg && NAC.msg.tone !== 'ok') NAC.msg = null;
  nacDraw();
  card.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-nac]') : null;
    if (!b || b.disabled) return;
    nacAction(b.getAttribute('data-nac'), b.getAttribute('data-pageid') || '');
  });
  if (!NAC.status || Date.now() - NAC.statusAt > 30000) nacLoadStatus().then(nacDraw);
}
