import { DB } from '../model/db.js';
import { SHEET_SCHEMA, SYNC, renderSyncUi, saveSyncConfig, sheetCall, sheetPull, sheetPush, syncBadgeHtml } from '../sync/sheets.js';
import { $, esc } from '../ui/dom.js';
import { toast } from '../ui/overlay.js';

export function settingsSheets(view) {
  view.innerHTML = `
    <div class="grid g-2-1">
      <div>
        <div class="card" style="margin-bottom:16px">
          <div class="card-head"><h3>Google Sheet</h3><div class="sp"></div><span id="syncStatus">${syncBadgeHtml()}</span></div>
          <p class="card-sub">The Sheet holds the shared copy. Everyone points their dashboard at the same Web App URL, and the
          workspace pushes up automatically a few seconds after each change.</p>

          <div class="field"><label>Web App URL</label>
            <input type="text" id="syncUrl" value="${esc(SYNC.url)}" placeholder="https://script.google.com/macros/s/…/exec"/></div>
          <div class="field"><label>Shared key</label>
            <input type="text" id="syncSecret" value="${esc(SYNC.secret)}" placeholder="the SHARED_KEY you set in the script"/></div>
          <label style="display:flex;align-items:center;gap:9px;text-transform:none;letter-spacing:0;font-size:13.5px;color:var(--text-2);margin:4px 0 16px">
            <input type="checkbox" id="syncAuto" ${SYNC.auto ? 'checked' : ''}/> Push automatically after each change
          </label>

          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn primary sm" id="syncSave">Save &amp; test</button>
            <button class="btn sm" id="syncPull">Pull from Sheet</button>
            <button class="btn sm" id="syncPush">Push to Sheet</button>
          </div>
          <div id="syncError"></div>
          <p class="card-sub" style="margin-top:14px">Last sync: <span id="syncMeta">${SYNC.at ? SYNC.at.toLocaleString() : 'never'}</span>.
          The URL and key are stored in this browser only — they are never written into the HTML file, so the dashboard stays safe to share.</p>
        </div>

        <div class="card">
          <div class="card-head"><h3>Setting it up — once, about 10 minutes</h3></div>
          <ol style="font-size:13.5px;color:var(--text-2);line-height:1.8;padding-left:20px;margin:8px 0 0">
            <li>Create a new Google Sheet. Name it something like <strong>VIVELY Workspace</strong>.</li>
            <li>In the Sheet: <strong>Extensions → Apps Script</strong>. Delete whatever is there.</li>
            <li>Paste in <span class="kbd">vively-sheet-backend.gs</span> (the file I sent alongside this dashboard).</li>
            <li>Change <span class="kbd">SHARED_KEY</span> at the top to any phrase your team agrees on. Save.</li>
            <li><strong>Deploy → New deployment → Web app.</strong> Execute as <strong>Me</strong>, access <strong>Anyone</strong>.
                Google will warn you about permissions — that is expected, it is your own script.</li>
            <li>Copy the <strong>/exec</strong> URL it gives you, paste it above with the same key, and hit <strong>Save &amp; test</strong>.</li>
            <li>Push once to fill the Sheet. Everyone else pastes the same URL and key, then hits <strong>Pull</strong>.</li>
          </ol>
          <div class="note warn" style="margin-top:14px">
            <strong>Access:</strong> "Anyone" means anyone <em>with the URL and the key</em>. Keep both internal —
            the Sheet holds creator addresses and phone numbers. Never commit them to a public repo.
          </div>
        </div>
      </div>

      <div>
        <div class="card" style="margin-bottom:16px">
          <div class="card-head"><h3>What lands in the Sheet</h3></div>
          <p class="card-sub">Three tabs, plain columns. Your team can read and correct them directly.</p>
          <dl class="kv" style="margin-top:10px">
            <dt>Campaigns</dt><dd>${SHEET_SCHEMA.campaigns.length} columns · ${DB.campaigns.length} rows</dd>
            <dt>Creators</dt><dd>${SHEET_SCHEMA.creators.length} columns · ${DB.creators.length} rows</dd>
            <dt>Participants</dt><dd>${SHEET_SCHEMA.participants.length} columns · ${DB.participants.length} rows</dd>
          </dl>
          <p class="card-sub" style="margin-top:12px">Lists like categories and hashtags are stored pipe-separated
          (<span class="kbd">Beauty|Skincare</span>) so they survive the round trip.</p>
        </div>

        <div class="card">
          <div class="card-head"><h3>How conflicts are handled</h3></div>
          <p class="card-sub" style="margin:0">Every push carries a revision number. If someone saved since you last synced,
          your push stops and asks you to choose: take the Sheet's version, or push over it. Nothing is overwritten silently.
          It is not live co-editing — if two people work on the same campaign at once, agree who pushes.</p>
        </div>
      </div>
    </div>`;

  $('#syncSave').addEventListener('click', async () => {
    SYNC.url = $('#syncUrl').value.trim();
    SYNC.secret = $('#syncSecret').value.trim();
    SYNC.auto = $('#syncAuto').checked;
    SYNC.status = SYNC.url ? 'idle' : 'off';
    SYNC.error = null;
    saveSyncConfig();
    if (!SYNC.url) { toast('Cleared'); renderSyncUi(); return; }
    try {
      const json = await sheetCall('ping');
      SYNC.revision = json.revision || 0;
      SYNC.error = null; SYNC.status = 'idle';
      toast('Connected to ' + (json.sheetName || 'the Sheet'));
      saveSyncConfig();
    } catch (err) { SYNC.error = err.message; SYNC.status = 'error'; toast('Could not connect — ' + err.message); }
    renderSyncUi();
  });
  $('#syncPull').addEventListener('click', () => sheetPull());
  $('#syncPush').addEventListener('click', () => sheetPush());
  $('#syncAuto').addEventListener('change', () => { SYNC.auto = $('#syncAuto').checked; saveSyncConfig(); });
}
