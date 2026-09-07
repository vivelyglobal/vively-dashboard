import React from 'react';

/* Where this workspace currently lives — the one thing on screen that
   says whether what you are looking at survives a closed laptop. */
export default function SaveBadge({ server, sync, persistState }) {
  let warn = false, off = false, text, title;

  if (server.configured === false) {
    warn = true; text = 'Not connected to server';
    title = 'MONGODB_URI is not set on the server yet, so Save only writes to this browser for now.';
  } else if (server.status === 'conflict') {
    warn = true; text = 'Needs attention';
    title = server.error || 'Another browser saved more recently.';
  } else if (server.status === 'error') {
    warn = true; text = 'Save failed';
    title = server.error || 'Could not reach the server. Click Save to retry.';
  } else if (sync.url && (sync.status === 'conflict' || sync.status === 'error')) {
    warn = true; text = 'Sheet needs attention';
    title = sync.error || 'Open Setup → Google Sheet.';
  } else if (server.status === 'syncing') {
    text = 'Saving…'; title = 'Saving to the server…';
  } else {
    const st = server.at ? server.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
    /* an unsaved workspace is not a neutral state — the dot says so
       where there is no room for the sentence */
    if (!st) off = true;
    text = st ? `Saved ${st}` : 'Not saved yet — click Save';
    title = st
      ? `Saved to the server at ${server.at.toLocaleString()} — available on any browser.${sync.url ? ' Also pushed to the shared Google Sheet.' : ''}`
      : (persistState.on
          ? `Kept in this browser only (${Math.round(persistState.bytes / 1024)} KB) until you click Save.`
          : 'This browser blocks local storage — click Save to store this on the server.');
  }

  /* The sentence is in its own span so a narrow screen can drop it and
     keep the light. Hiding the whole badge below 1240px — which was
     every laptop and every phone — meant a save that had been failing
     for an hour looked exactly like one that was fine. */
  return (
    <span className={'save-badge no-print' + (warn ? ' warn' : '') + (off ? ' off' : '')} title={title}>
      <i className="sdot" /><span className="sb-t">{text}</span>
    </span>
  );
}
