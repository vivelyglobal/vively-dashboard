/* ===================================================================
   Google Sheets, narrowly.

   This client is built for ONE spreadsheet, fixed when it is created.
   There is no method that takes a spreadsheet id, and the only write is
   one text cell, in a column letter the caller passes. The CALLER (the
   date write-back job) is responsible for having proven by header text
   that this column is "Visiting Date" in this tab, and for re-reading the
   row right before writing. Reads are only for what a caller names: the
   header row, the Instagram handle / creator name / Visiting Date columns,
   or single cells of those, never address or phone.

   The access token comes from the server's existing service-account code
   (injected as getToken), so there is no second credential. A Google
   scope cannot be limited to one spreadsheet; what limits this is (a) the
   id fixed here and (b) the founder sharing only that spreadsheet with
   the service account.

   Nothing here runs unless the date write-back is switched on.
   =================================================================== */
"use strict";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const COL_RE = /^[A-Z]{1,3}$/;
const ID_RE = /^[A-Za-z0-9_-]{20,}$/;

/* accepts the bare id or a pasted /spreadsheets/d/<id>/ link */
function parseSpreadsheetId(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  const m = s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  const id = m ? m[1] : s;
  return ID_RE.test(id) ? id : null;
}

const a1Tab = (title) => "'" + String(title).replace(/'/g, "''") + "'";

function makeSheetsClient(opts) {
  const o = opts || {};
  const spreadsheetId = parseSpreadsheetId(o.spreadsheetId);
  if (!spreadsheetId) throw new Error("sheets client: a valid spreadsheet id is required");
  const base = String(o.apiBase || "https://sheets.googleapis.com/v4").replace(/\/+$/, "");
  const doFetch = o.fetchImpl || fetch;
  const getToken = o.getToken;
  const root = base + "/spreadsheets/" + encodeURIComponent(spreadsheetId);

  async function call(method, url, body) {
    const token = await getToken(SHEETS_SCOPE);
    if (!token) throw Object.assign(new Error("Google is not configured on the server."), { status: 0, notConfigured: true });
    const res = await doFetch(url, {
      method,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error((json.error && (json.error.message || json.error.status)) || "Google responded " + res.status);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  const colRange = (tab, col) => {
    if (!COL_RE.test(col)) throw new Error("sheets client: bad column");
    return a1Tab(tab) + "!" + col + ":" + col;
  };

  /* tab titles only; nothing from any cell */
  async function listTabs() {
    const j = await call("GET", root + "?fields=" + encodeURIComponent("sheets.properties.title"));
    return (j.sheets || []).map((s) => s && s.properties && s.properties.title).filter((t) => typeof t === "string");
  }

  /* { C: [cell, ...], Q: [cell, ...] } with one entry per row, "" for a blank */
  async function readColumns(tab, cols) {
    const letters = [...new Set(cols.map((c) => String(c).toUpperCase()))];
    const qs = letters.map((c) => "ranges=" + encodeURIComponent(colRange(tab, c))).join("&");
    const j = await call("GET", root + "/values:batchGet?majorDimension=ROWS&" + qs);
    const out = {};
    letters.forEach((c, i) => {
      const vr = (j.valueRanges || [])[i] || {};
      out[c] = (vr.values || []).map((row) => (row && row[0] != null ? String(row[0]) : ""));
    });
    return out;
  }

  /* One header row, as an array of cell texts (index 0 = column A). Only the
     header row is requested, never a data row. */
  async function readHeaderRow(tab, row) {
    const r = Number(row);
    if (!Number.isInteger(r) || r < 1 || r > 10) throw new Error("sheets client: header row must be 1 to 10");
    const j = await call("GET", root + "/values:batchGet?majorDimension=ROWS&ranges=" + encodeURIComponent(a1Tab(tab) + "!A" + r + ":ZZ" + r));
    const vals = ((j.valueRanges || [])[0] || {}).values;
    return ((vals && vals[0]) || []).map((c) => (c == null ? "" : String(c)));
  }

  /* Single cells in ONE batched read: refs = [{col, row}, ...]. Returns an
     array of strings in the same order ("" for a blank). */
  async function readCells(tab, refs) {
    const list = (refs || []).map((x) => {
      const col = String(x && x.col).toUpperCase(); const row = Number(x && x.row);
      if (!COL_RE.test(col) || !Number.isInteger(row) || row < 1) throw new Error("sheets client: bad cell");
      return { col, row };
    });
    if (!list.length || list.length > 4) throw new Error("sheets client: one to four cells per read");
    const qs = list.map((x) => "ranges=" + encodeURIComponent(a1Tab(tab) + "!" + x.col + x.row)).join("&");
    const j = await call("GET", root + "/values:batchGet?majorDimension=ROWS&" + qs);
    return list.map((x, i) => {
      const v = (((j.valueRanges || [])[i] || {}).values || [])[0];
      return v && v[0] != null ? String(v[0]) : "";
    });
  }

  /* The only write. One cell, in the column the caller passes (a column
     letter, never a range). RAW so that "Oct 17" stays text and is not
     turned into a date by the sheet. */
  async function writeVisitCell(tab, row, text, col) {
    const r = Number(row);
    if (!Number.isInteger(r) || r < 2) throw new Error("sheets client: refusing to write row " + row);
    const visitCol = String(col == null ? "" : col).toUpperCase();
    if (!COL_RE.test(visitCol)) throw new Error("sheets client: refusing this column");
    const t = String(text);
    if (!t || t.length > 200 || /[\r\n]/.test(t)) throw new Error("sheets client: refusing this cell text");
    const range = a1Tab(tab) + "!" + visitCol + r;
    await call("PUT", root + "/values/" + encodeURIComponent(range) + "?valueInputOption=RAW",
      { range, majorDimension: "ROWS", values: [[t]] });
    return { range };
  }

  return { listTabs, readHeaderRow, readColumns, readCells, writeVisitCell, spreadsheetId };
}

module.exports = { makeSheetsClient, parseSpreadsheetId, SHEETS_SCOPE, a1Tab };
