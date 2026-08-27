/* ------------------------------------------------------------------
   Compatibility shim.
   The views that still build their markup as HTML strings carry a
   handful of inline onclick="…" handlers, and an inline handler can
   only see globals. Each one is listed here on purpose: the list
   shrinks to nothing as those views become components, and when it is
   empty this file goes away.
   ------------------------------------------------------------------ */
import { closeDrawer, toast } from '../ui/overlay.js';
import { showParticipant, openNewCampaign } from '../views/campaigns.js';
import { showCreator } from '../views/creators.js';
import { clearFlag } from '../views/settings.js';
import { downloadTemplate, openImportWizard } from '../views/excelImport.js';
import { openNotionImportWizard } from '../views/notionImport.js';
import { sheetPush, sheetPull } from '../sync/sheets.js';

Object.assign(window, {
  clearFlag, closeDrawer, toast, showParticipant, showCreator, downloadTemplate,
  openImportWizard, openNotionImportWizard, openNewCampaign, sheetPush, sheetPull
});

/* tools/check-inline-handlers.mjs fails the build if a view starts calling
   something from an inline handler that is not on this list. */
