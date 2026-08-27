#!/usr/bin/env node
/* ============================================================
   How src/ was cut out of index.html.

   The dashboard was one 7,800-line file. This script is the record
   of the split: for each module it names the exact line ranges it
   came from, the imports that replaced the shared global scope, and
   a checksum of the result. Re-running it against the original
   index.html reproduces src/ byte for byte, which is what makes the
   claim "nothing was rewritten, only moved" checkable rather than
   asserted.

   Run:  node tools/split.mjs            (writes src/, verifies)
         node tools/split.mjs --check    (verifies only)

   It has a shelf life. Once the views become React components,
   index.html is no longer their source and this stops being
   re-runnable — by then it has done its job.
   ============================================================ */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const lines = fs.readFileSync(path.join(root, 'index.html'), 'utf8').split('\n');

/* a top-level declaration becomes a named export */
const DECL = /^(?:(?:async)\s+)?(?:function|const|let|var|class)\s+[A-Za-z_$][\w$]*/;

/* the data layer used to call the renderer directly; it announces now */
const REPLACE = {
  'model/db.js':       [[/\bupdateSaveBadge\(\)/g, 'notifyStatus()']],
  'import/notion.js':  [[/\brender\(\)/g, 'notify()']],
  'import/metrics.js': [[/\brender\(\)/g, 'notify()']],
  'sync/sheets.js':    [[/\brender\(\)/g, 'notify()']]
};
const VIEW_RENDER = /^views\//;

const DB_TAIL = `
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
`;

const MANIFEST = [
 {
  "file": "lib/rng.js",
  "ranges": [
   [
    779,
    800
   ]
  ],
  "imports": [],
  "sha256": "055bb64b9824dcced3bbcf8174b52f7b555984b863403151d8b63a47918b5838"
 },
 {
  "file": "lib/dates.js",
  "ranges": [
   [
    801,
    806
   ]
  ],
  "imports": [],
  "sha256": "02b91e57174acbcf3bfc8bec7a964c22bd0b5a5a06fa63260fed2bfbe9e4d85f"
 },
 {
  "file": "lib/format.js",
  "ranges": [
   [
    1161,
    1184
   ]
  ],
  "imports": [],
  "sha256": "d225f3c53931ea7f60d905a58bc260f044a5ed0dc4f1b10136a7fc48826eec41"
 },
 {
  "file": "lib/csv.js",
  "ranges": [
   [
    5563,
    5581
   ]
  ],
  "imports": [],
  "sha256": "ef6d38377afa64f2cc6d8843bb3088b439330bbccbe377aa6e788e0a54466917"
 },
 {
  "file": "model/vocab.js",
  "ranges": [
   [
    807,
    866
   ]
  ],
  "imports": [],
  "sha256": "fde6aa7698ed449079f212a0d3c6b1beb8bd388d5a84dea7541fdbe47b499536"
 },
 {
  "file": "model/settings.js",
  "ranges": [
   [
    1286,
    1289
   ]
  ],
  "imports": [],
  "sha256": "78e25bd5b99bd043d39d25299b7dbc4c770d70ea8db5d2ff8bd8d9c8b2538f0f"
 },
 {
  "file": "ui/dom.js",
  "ranges": [
   [
    1549,
    1554
   ]
  ],
  "imports": [],
  "sha256": "d75e6b2fd306a04e9b48e3652f44ba11e5b09bba33664fe024ec7486b649ca13"
 },
 {
  "file": "ui/overlay.js",
  "ranges": [
   [
    1555,
    1580
   ]
  ],
  "imports": [
   "import { $ } from './dom.js';"
  ],
  "sha256": "36b13beedc50d734028139ebd3b3a543ffeafe6595215ab7acbc1a8f6136a307"
 },
 {
  "file": "ui/html.js",
  "ranges": [
   [
    1581,
    1687
   ]
  ],
  "imports": [
   "import { $, esc } from './dom.js';",
   "import { toast } from './overlay.js';",
   "import { TODAY, DAY } from '../lib/dates.js';",
   "import { kmb } from '../lib/format.js';",
   "import { stageOf, CAMPAIGN_STATUS, avColor, initials } from '../model/vocab.js';",
   "import { DB } from '../model/db.js';",
   "import { selectable } from '../model/settings.js';"
  ],
  "sha256": "f1bd83e0370fb26fb5511c021d795a6fb19a4a693f185f303a2a9ffe26aadfc5"
 },
 {
  "file": "model/db.js",
  "ranges": [
   [
    867,
    1043
   ]
  ],
  "imports": [
   "import { SETTINGS } from './settings.js';",
   "import { toast } from '../ui/overlay.js';",
   "import { scheduleSheetPush } from '../sync/sheets.js';"
  ],
  "sha256": "83e078aec0fa0affd7957b222b5afaba5cb7a77260e789291ac419068b30eae5"
 },
 {
  "file": "model/creators.js",
  "ranges": [
   [
    1044,
    1160
   ]
  ],
  "imports": [
   "import { STAGE_IDX, tierOf } from './vocab.js';",
   "import { DB, byCreator } from './db.js';"
  ],
  "sha256": "171e71cf0bd596f3b777d0ee8c589fd60b335988e94bb6912e47831244278ee6"
 },
 {
  "file": "model/stats.js",
  "ranges": [
   [
    1185,
    1285
   ]
  ],
  "imports": [
   "import { TODAY, DAY, addDays, iso } from '../lib/dates.js';",
   "import { engagementsOf } from '../lib/format.js';",
   "import { STAGES, STAGE_IDX } from './vocab.js';",
   "import { DB, byCreator } from './db.js';"
  ],
  "sha256": "7988abd79e2500f6fb419d0bf2c0bbc3e601ffebf27e02018ca5e171f8f2be4c"
 },
 {
  "file": "model/suggest.js",
  "ranges": [
   [
    1290,
    1309
   ]
  ],
  "imports": [
   "import { TODAY, DAY } from '../lib/dates.js';"
  ],
  "sha256": "9f2aa0fd21957355c0ea21d82f34dddcdccae4a6e50fb3b2c3c74b37c66195b6"
 },
 {
  "file": "model/calendar.js",
  "ranges": [
   [
    1967,
    1991
   ]
  ],
  "imports": [
   "import { DB, byCreator, byCampaign } from './db.js';",
   "import { parseVisitSlot } from '../import/notion.js';"
  ],
  "sha256": "74ffb2723477db8d033e29aae4f7a8489672e596587118631c08592b17a5824e"
 },
 {
  "file": "charts/index.js",
  "ranges": [
   [
    1310,
    1548
   ]
  ],
  "imports": [
   "import { $ } from '../ui/dom.js';",
   "import { dLabel } from '../lib/dates.js';",
   "import { num, kmb, pct } from '../lib/format.js';"
  ],
  "sha256": "d236eb0ee5cfdc181a95c4b08bc801cf5e27070a9cee845dd538d276b8ca1078"
 },
 {
  "file": "lib/xlsx.js",
  "ranges": [
   [
    3891,
    4162
   ]
  ],
  "imports": [
   "import { toast } from '../ui/overlay.js';"
  ],
  "sha256": "ed0bc7864d5ca17790630cc399f45907a0b08c578811d121d79df6057f44cc00"
 },
 {
  "file": "import/excel.js",
  "ranges": [
   [
    4163,
    4384
   ]
  ],
  "imports": [],
  "sha256": "cc18387c9c818bc67ce69986c63ff5a80fb6ec521007150d757e987935ffc3b9"
 },
 {
  "file": "import/notion.js",
  "ranges": [
   [
    4385,
    4920
   ]
  ],
  "imports": [
   "import { rnd } from '../lib/rng.js';",
   "import { TODAY, iso } from '../lib/dates.js';",
   "import { won } from '../lib/format.js';",
   "import { STAGE_IDX, tierOf, avColor } from '../model/vocab.js';",
   "import { DB, byCreator, SERVER, serverSave, notify } from '../model/db.js';",
   "import { findCreatorByHandle, mergeDuplicateCreators } from '../model/creators.js';",
   "import { $, $$, esc } from '../ui/dom.js';",
   "import { toast, openDrawer, closeDrawer } from '../ui/overlay.js';",
   "import { STATUS_MAP, normHeader, guessField, handleFromUrl, parseFollowers, parseDateCell, countryOf } from './excel.js';"
  ],
  "sha256": "caf4341ec9f3d0c83555243715d8d34d74488348c1064fb2403601f450c174f3"
 },
 {
  "file": "import/metrics.js",
  "ranges": [
   [
    4921,
    5117
   ]
  ],
  "imports": [
   "import { iso } from '../lib/dates.js';",
   "import { parseCsvText } from '../lib/csv.js';",
   "import { num } from '../lib/format.js';",
   "import { readXlsx } from '../lib/xlsx.js';",
   "import { byCreator, SERVER, serverSave, notify } from '../model/db.js';",
   "import { partsOf } from '../model/stats.js';",
   "import { $, $$, esc } from '../ui/dom.js';",
   "import { toast, openDrawer, closeDrawer } from '../ui/overlay.js';",
   "import { statCard } from '../ui/html.js';",
   "import { normHeader, handleFromUrl } from './excel.js';",
   "import { notionVisitValue, notionMetricValue, applyNotionContent } from './notion.js';"
  ],
  "sha256": "b3316228722e86ac2bd5b2a4c684624f58a953091ef525ea3c0b5eadb01bc566"
 },
 {
  "file": "sync/sheets.js",
  "ranges": [
   [
    5811,
    6055
   ]
  ],
  "imports": [
   "import { TODAY, iso } from '../lib/dates.js';",
   "import { avColor } from '../model/vocab.js';",
   "import { DB, byCreator, byCampaign, persist, notify } from '../model/db.js';",
   "import { $, esc } from '../ui/dom.js';",
   "import { toast } from '../ui/overlay.js';"
  ],
  "sha256": "182cb504e32495b3f0942322de14d325e47142f2f0a2c410a60c188300483158"
 },
 {
  "file": "docs/docx.js",
  "ranges": [
   [
    6146,
    6276
   ]
  ],
  "imports": [
   "import { makeZip, xmlEsc } from '../lib/xlsx.js';",
   "import { esc } from '../ui/dom.js';",
   "import { toast } from '../ui/overlay.js';"
  ],
  "sha256": "e1430a47db5e26338a27d7f3654866dcbd1cfcbf6d2eeab4dee9ab881da36860"
 },
 {
  "file": "docs/contracts.js",
  "ranges": [
   [
    6277,
    6748
   ]
  ],
  "imports": [
   "import { TODAY, iso } from '../lib/dates.js';",
   "import { nf } from '../lib/format.js';",
   "import { $ } from '../ui/dom.js';"
  ],
  "sha256": "4a2bca4eb40613471b343deda9a11018016e06e7f9addc07574b9b70f6a3ac07"
 },
 {
  "file": "views/overview.js",
  "ranges": [
   [
    1688,
    1951
   ]
  ],
  "imports": [
   "import { fitHeight, funnelView, lineChart, splitBar } from '../charts/index.js';",
   "import { DAY, TODAY } from '../lib/dates.js';",
   "import { engagementsOf, kmb, money2, num, pct, wonK } from '../lib/format.js';",
   "import { DB, byCampaign, byCreator, notify } from '../model/db.js';",
   "import { campaignStats, dailySeries, funnelOf, partsOf, portfolioStats, viralScore } from '../model/stats.js';",
   "import { STAGE_IDX } from '../model/vocab.js';",
   "import { $, esc } from '../ui/dom.js';",
   "import { emptyState, statCard, statusPill, whoHtml } from '../ui/html.js';"
  ],
  "sha256": "1b3ef013c07818bde50737c7165e2006ae3eba076a3a88cec2c4ce5377d031e1"
 },
 {
  "file": "views/calendarView.js",
  "ranges": [
   [
    1992,
    2117
   ]
  ],
  "imports": [
   "import { notionLinkedCampaigns, parseVisitSlot, syncAllNotionCampaigns } from '../import/notion.js';",
   "import { TODAY } from '../lib/dates.js';",
   "import { dayKey, visitsByDay } from '../model/calendar.js';",
   "import { DB, notify } from '../model/db.js';",
   "import { avColor } from '../model/vocab.js';",
   "import { $, $$, esc } from '../ui/dom.js';",
   "import { showParticipant } from './campaigns.js';",
   "import { state } from './overview.js';"
  ],
  "sha256": "e4e942ca03f0ddf90d36f3edefa8658e20f4eaf9e691bcdb6b592a7b6caa595c"
 },
 {
  "file": "views/campaigns.js",
  "ranges": [
   [
    1952,
    1966
   ],
   [
    2118,
    2850
   ]
  ],
  "imports": [
   "import { SERIES_HEX, barsH, fitHeight, lineChart, sparkSvg, splitBar } from '../charts/index.js';",
   "import { openMetricsImport } from '../import/metrics.js';",
   "import { notionLinkedCampaigns, openNotionMappingDrawer, syncAllNotionCampaigns } from '../import/notion.js';",
   "import { DAY, TODAY, addDays, dLabel, iso } from '../lib/dates.js';",
   "import { engagementsOf, kmb, money2, num, pct, won, wonK } from '../lib/format.js';",
   "import { recomputeCreatorStats } from '../model/creators.js';",
   "import { DB, SERVER, byCampaign, byCreator, notify, persist, serverSave } from '../model/db.js';",
   "import { SETTINGS, isBlocked, selectable } from '../model/settings.js';",
   "import { campaignStats, dailySeries, liveOf, partsOf, viralScore } from '../model/stats.js';",
   "import { suggestScore } from '../model/suggest.js';",
   "import { CAMPAIGN_STATUS, CATEGORIES, COUNTRIES, STAGES, STAGE_IDX, stageOf, viewCurve } from '../model/vocab.js';",
   "import { $, $$, esc } from '../ui/dom.js';",
   "import { FLAGS, avatarHtml, copyText, daysAgo, downloadFile, emptyState, flagPill, stagePill, statCard, statusPill, tierPill, toCsv, whoHtml } from '../ui/html.js';",
   "import { closeDrawer, openDrawer, toast } from '../ui/overlay.js';",
   "import { campaignCalendarTab, renderCampaignCalendar, upcomingVisitsStrip } from './calendarView.js';",
   "import { openImportWizard } from './excelImport.js';",
   "import { briefTab, messagesTab } from './messages.js';",
   "import { openNotionDiagnostic, openNotionSync } from './notionDiag.js';",
   "import { openNotionImportWizard } from './notionImport.js';",
   "import { state } from './overview.js';",
   "import { reportTab } from './report.js';"
  ],
  "sha256": "7c2c7df6517aa392d6877c271b6ca29edc8cdcaa474c11a0e9239d08d4caf19c"
 },
 {
  "file": "views/analytics.js",
  "ranges": [
   [
    2851,
    3067
   ]
  ],
  "imports": [
   "import { SERIES_HEX, barsH, fitHeight, lineChart, splitBar } from '../charts/index.js';",
   "import { engagementsOf, kmb, money2, num, pct, wonK } from '../lib/format.js';",
   "import { DB, byCampaign, byCreator } from '../model/db.js';",
   "import { campaignStats, dailySeries, portfolioStats, viralScore } from '../model/stats.js';",
   "import { CONTENT_FORMATS, PLATFORMS, STAGE_IDX } from '../model/vocab.js';",
   "import { $, esc } from '../ui/dom.js';",
   "import { downloadFile, emptyState, statCard, toCsv, whoHtml } from '../ui/html.js';",
   "import { costCards } from './campaigns.js';",
   "import { rangeSeg, state, wireRange } from './overview.js';"
  ],
  "sha256": "d9ff40e4df78d3c5f845bbf951fcd7fc6da5153114aaeb82a3b6361e66515e3b"
 },
 {
  "file": "views/messages.js",
  "ranges": [
   [
    3068,
    3489
   ]
  ],
  "imports": [
   "import { funnelView } from '../charts/index.js';",
   "import { parseVisitSlot } from '../import/notion.js';",
   "import { dLabel } from '../lib/dates.js';",
   "import { num, pct, won, wonK } from '../lib/format.js';",
   "import { DB, byCampaign, byCreator } from '../model/db.js';",
   "import { campaignStats, funnelOf, partsOf } from '../model/stats.js';",
   "import { stageOf } from '../model/vocab.js';",
   "import { $, esc } from '../ui/dom.js';",
   "import { copyText, downloadFile, emptyState, toCsv } from '../ui/html.js';",
   "import { toast } from '../ui/overlay.js';",
   "import { activeCampaigns, state } from './overview.js';"
  ],
  "sha256": "d05f99ed3fb74b58209b5f1b0c695415696b41d0e415716d79b980af9a29d1e5"
 },
 {
  "file": "views/report.js",
  "ranges": [
   [
    3490,
    3629
   ]
  ],
  "imports": [
   "import { DAY, TODAY, dLabel } from '../lib/dates.js';",
   "import { money2, num, pct, won, wonK } from '../lib/format.js';",
   "import { byCreator } from '../model/db.js';",
   "import { campaignStats, liveOf, partsOf, viralScore } from '../model/stats.js';",
   "import { $, esc } from '../ui/dom.js';",
   "import { copyText, downloadFile, toCsv } from '../ui/html.js';",
   "import { toast } from '../ui/overlay.js';"
  ],
  "sha256": "2e2fc25ae9604e1110f948f6bcb23fb8cfe86ffe8379f321f54f786274998006"
 },
 {
  "file": "views/creators.js",
  "ranges": [
   [
    3630,
    3890
   ]
  ],
  "imports": [
   "import { SERIES_HEX, barsH, splitBar } from '../charts/index.js';",
   "import { TODAY, dLabel, iso } from '../lib/dates.js';",
   "import { engagementsOf, kmb, num, pct, won } from '../lib/format.js';",
   "import { DB, byCampaign, byCreator, notify } from '../model/db.js';",
   "import { SETTINGS, isBlocked } from '../model/settings.js';",
   "import { suggestScore } from '../model/suggest.js';",
   "import { CATEGORIES, COUNTRIES, PLATFORMS } from '../model/vocab.js';",
   "import { $, $$, esc } from '../ui/dom.js';",
   "import { FLAGS, avatarHtml, daysAgo, downloadFile, emptyState, flagPill, sortTable, stagePill, statCard, tierPill, toCsv, whoHtml } from '../ui/html.js';",
   "import { closeDrawer, openDrawer, toast } from '../ui/overlay.js';",
   "import { activeCampaigns, state } from './overview.js';"
  ],
  "sha256": "c08700e626734af96267f90e8a92eb2ded438a9235937990aaaa0a6ffdd6cf11"
 },
 {
  "file": "views/notionDiag.js",
  "ranges": [
   [
    5118,
    5216
   ]
  ],
  "imports": [
   "import { NOTION_FIELD_DEFS, healNotionMapping, notionRowToApplicant, openNotionLinkDrawer, openNotionMappingDrawer, runNotionSync } from '../import/notion.js';",
   "import { findCreatorByHandle } from '../model/creators.js';",
   "import { DB } from '../model/db.js';",
   "import { $, esc } from '../ui/dom.js';",
   "import { copyText } from '../ui/html.js';",
   "import { openDrawer, toast } from '../ui/overlay.js';"
  ],
  "sha256": "7ec58838629ee44f8b6bb0462ca03d82089a61b0fcc6741952cf376f04dc49ac"
 },
 {
  "file": "views/notionImport.js",
  "ranges": [
   [
    5217,
    5503
   ]
  ],
  "imports": [
   "import { countryOf } from '../import/excel.js';",
   "import { NOTION_FIELD_DEFS, guessNotionField, notionRowToApplicant } from '../import/notion.js';",
   "import { TODAY, addDays, iso } from '../lib/dates.js';",
   "import { num } from '../lib/format.js';",
   "import { rnd } from '../lib/rng.js';",
   "import { findCreatorByHandle, mergeDuplicateCreators } from '../model/creators.js';",
   "import { DB, SERVER, byCampaign, byCreator, serverSave } from '../model/db.js';",
   "import { CAMPAIGN_STATUS, CATEGORIES, COUNTRIES, STAGE_IDX, avColor, stageOf, tierOf } from '../model/vocab.js';",
   "import { $, $$, esc } from '../ui/dom.js';",
   "import { stagePill, statCard } from '../ui/html.js';",
   "import { closeDrawer, openDrawer, toast } from '../ui/overlay.js';"
  ],
  "sha256": "b6ee0c55e6e39c1bc8407f0e073a59988619813efbbd9f1583a480ba7ed1d7d8"
 },
 {
  "file": "views/excelImport.js",
  "ranges": [
   [
    5504,
    5562
   ],
   [
    5582,
    5810
   ]
  ],
  "imports": [
   "import { IMPORT_FIELDS, TEMPLATES, countryOf, detectTemplate, guessField, parseImportRows } from '../import/excel.js';",
   "import { parseCsvText } from '../lib/csv.js';",
   "import { TODAY, addDays, iso } from '../lib/dates.js';",
   "import { num } from '../lib/format.js';",
   "import { rnd } from '../lib/rng.js';",
   "import { downloadXlsx, readXlsx } from '../lib/xlsx.js';",
   "import { findCreatorByHandle, mergeDuplicateCreators } from '../model/creators.js';",
   "import { DB, SERVER, byCampaign, byCreator, serverSave } from '../model/db.js';",
   "import { CAMPAIGN_STATUS, CATEGORIES, COUNTRIES, STAGE_IDX, avColor, stageOf, tierOf } from '../model/vocab.js';",
   "import { $, $$, esc } from '../ui/dom.js';",
   "import { stagePill, statCard } from '../ui/html.js';",
   "import { closeDrawer, openDrawer, toast } from '../ui/overlay.js';"
  ],
  "sha256": "f17fb809383983d23617f8835840a4e0c899ba85ce996f2ea2c44c97bf858bd4"
 },
 {
  "file": "views/sheetsSettings.js",
  "ranges": [
   [
    6056,
    6145
   ]
  ],
  "imports": [
   "import { DB } from '../model/db.js';",
   "import { SHEET_SCHEMA, SYNC, renderSyncUi, saveSyncConfig, sheetCall, sheetPull, sheetPush, syncBadgeHtml } from '../sync/sheets.js';",
   "import { $, esc } from '../ui/dom.js';",
   "import { toast } from '../ui/overlay.js';"
  ],
  "sha256": "c24014c05addb561898e4ced051f0cfaeb79d95f21f844742fd3a60354cc1f42"
 },
 {
  "file": "views/contracts.js",
  "ranges": [
   [
    6749,
    7080
   ]
  ],
  "imports": [
   "import { BILLING_LABELS, CONTRACT, CONTRACT_DOCS, saveContractDefaults } from '../docs/contracts.js';",
   "import { blocksToHtml, blocksToText, downloadDocx } from '../docs/docx.js';",
   "import { DB, byCampaign, notify } from '../model/db.js';",
   "import { $, $$, esc } from '../ui/dom.js';",
   "import { copyText } from '../ui/html.js';",
   "import { toast } from '../ui/overlay.js';"
  ],
  "sha256": "be422af34e73a0842501f2f17815a054bce0ad42267a5c41d50d1338c6a07b63"
 },
 {
  "file": "views/settings.js",
  "ranges": [
   [
    7081,
    7356
   ]
  ],
  "imports": [
   "import { STATUS_MAP, TEMPLATES } from '../import/excel.js';",
   "import { iso } from '../lib/dates.js';",
   "import { num } from '../lib/format.js';",
   "import { duplicateCreatorGroups, mergeDuplicateCreators } from '../model/creators.js';",
   "import { DB, byCampaign, byCreator, clearPersisted, notify, persist, persistState } from '../model/db.js';",
   "import { SETTINGS } from '../model/settings.js';",
   "import { SOURCES, tierOf } from '../model/vocab.js';",
   "import { $, esc } from '../ui/dom.js';",
   "import { downloadFile, flagPill, stagePill, statCard, whoHtml } from '../ui/html.js';",
   "import { toast } from '../ui/overlay.js';",
   "import { settingsSheets } from './sheetsSettings.js';"
  ],
  "sha256": "45b85ad5fb359eaf72c6dba68fb69019c52be7169a3d56ea64463d58adee1f04"
 },
 {
  "file": "styles.css",
  "ranges": [
   [
    11,
    662
   ]
  ],
  "raw": true,
  "imports": [],
  "sha256": "7a1b5cedf7f805d96c0b54f7bc2b4cc8be3f4784bfff0cda6a1e5a5b4a02ddc7"
 }
];

let ok = 0, bad = [];
for (const m of MANIFEST) {
  let src = m.ranges.map(([a, b]) => lines.slice(a - 1, b).join('\n')).join('\n');
  if (!m.raw) {
    for (const [re, to] of (REPLACE[m.file] || [])) src = src.replace(re, to);
    if (VIEW_RENDER.test(m.file)) src = src.replace(/\brender\(\)/g, 'notify()');
    src = src.split('\n').map((l) => (DECL.test(l) ? 'export ' + l : l)).join('\n');
    src = (m.imports.length ? m.imports.join('\n') + '\n\n' : '') + src.trim() + '\n';
    if (m.file === 'model/db.js') src += DB_TAIL;
  } else {
    src = src.join ? src.join('\n') : src;
    src = src + '\n';
  }
  const sha = crypto.createHash('sha256').update(src).digest('hex');
  if (sha === m.sha256) ok++; else bad.push(`${m.file}\n     expected ${m.sha256}\n     produced ${sha}`);
  if (!checkOnly) {
    const p = path.join(root, 'src', m.file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, src);
  }
}
console.log(`${ok}/${MANIFEST.length} modules match the recorded checksum`);
if (bad.length) { console.log('\nMISMATCH:\n  - ' + bad.join('\n  - ')); process.exit(1); }
