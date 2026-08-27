/* ------------------------------------------------------------------
   Startup, in the order the single-file version used: restore this
   browser's copy, restore the saved settings, then reach for the
   server copy, which is the cross-device truth and wins if it has
   anything. Runs after the first paint so the shell is on screen
   while the network call is in flight.
   ------------------------------------------------------------------ */
import { DB, flushServerSaveBeacon, loadPersisted, notify, persist, persistState,
         serverLoad, serverSave, storageAvailable } from '../model/db.js';
import { loadSyncConfig } from '../sync/sheets.js';
import { loadGcalPrefs, refreshGcalStatus } from '../sync/gcal.js';
import { loadContractDefaults } from '../docs/contracts.js';
import { toast } from '../ui/overlay.js';

export function boot() {
  window.addEventListener('beforeunload', () => { persist(true); flushServerSaveBeacon(); });
  persistState.on = storageAvailable();
  loadPersisted();
  loadSyncConfig();
  loadContractDefaults();
  loadGcalPrefs();

  /* asked for once, after the shell is on screen — the Setup panel and the
     strip above the calendar both read the answer */
  refreshGcalStatus().then(notify);

  serverLoad().then((result) => {
    if (result === 'loaded') { notify(); toast('Loaded the latest saved workspace'); }
    else if (result === 'empty' && (DB.campaigns.length || DB.creators.length)) {
      serverSave({ silent: true, force: true });
    }
    notify();
  });
}
