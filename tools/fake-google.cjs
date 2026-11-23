/* A stand-in for Google's token endpoint and Calendar API, so the server's
   service-account signing and the sync's create/patch/delete behaviour can
   be exercised without touching a real calendar. It verifies the JWT
   assertion against the test public key rather than waving it through —
   otherwise the signing code could be wrong and the tests would not care. */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');

/* Generates its own throwaway keypair on first run, so the harness works from
   a clean checkout and a tidied tmp/ cannot quietly break it. */
const KEY = __dirname + '/../tmp/fake-sa.json';
const PUB = __dirname + '/../tmp/fake-sa.pub';
if (!fs.existsSync(PUB) || !fs.existsSync(KEY)) {
  fs.mkdirSync(__dirname + '/../tmp', { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  fs.writeFileSync(KEY, JSON.stringify({ type: 'service_account', project_id: 'vively-test',
    client_email: 'vively-dashboard@vively-test.iam.gserviceaccount.com',
    private_key: privateKey, token_uri: 'http://127.0.0.1:3455/token' }, null, 2));
  fs.writeFileSync(PUB, publicKey);
  console.log('generated a throwaway service-account key for testing');
}
const pub = fs.readFileSync(PUB, 'utf8');
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));

const events = new Map();
const calls = [];
let failNext = null;
const b64urlDec = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

app.post('/token', (req, res) => {
  const a = String(req.body.assertion || '');
  const [h, c, sig] = a.split('.');
  if (!h || !c || !sig) return res.status(400).json({ error: 'invalid_grant', error_description: 'malformed assertion' });
  const v = crypto.createVerify('RSA-SHA256');
  v.update(h + '.' + c);
  const ok = v.verify(pub, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  if (!ok) return res.status(400).json({ error: 'invalid_grant', error_description: 'signature did not verify' });
  const claim = JSON.parse(b64urlDec(c));
  calls.push({ what: 'token', claim });
  if (!claim.iss || !claim.scope || !claim.aud || !claim.exp) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'missing claim' });
  }
  res.json({ access_token: 'test-token', expires_in: 3600, token_type: 'Bearer' });
});

const auth = (req, res, next) =>
  req.get('authorization') === 'Bearer test-token' ? next() : res.status(401).json({ error: { message: 'bad token' } });

app.get('/calendar/v3/calendars/:cal', auth, (req, res) =>
  res.json({ id: req.params.cal, summary: 'VIVELY Creator Visits', timeZone: 'Asia/Seoul' }));

app.get('/calendar/v3/calendars/:cal/events', auth, (req, res) => {
  const want = [].concat(req.query.privateExtendedProperty || []);
  let items = [...events.values()];
  want.forEach((w) => {
    const [k, v] = String(w).split('=');
    items = items.filter((e) => ((e.extendedProperties || {}).private || {})[k] === v);
  });
  if (req.query.timeMin) items = items.filter((e) => (e.end.dateTime || '') > req.query.timeMin);
  if (req.query.timeMax) items = items.filter((e) => (e.start.dateTime || '') < req.query.timeMax);
  res.json({ items });
});

app.post('/calendar/v3/calendars/:cal/events', auth, (req, res) => {
  const e = req.body;
  calls.push({ what: 'insert', id: e.id });
  if (failNext) { const f = failNext; failNext = null; return res.status(f).json({ error: { message: 'forced ' + f } }); }
  if (!e.id) return res.status(400).json({ error: { message: 'no id' } });
  if (!/^[0-9a-v]{5,1024}$/.test(e.id)) return res.status(400).json({ error: { message: 'Invalid resource id value.' } });
  if (events.has(e.id)) return res.status(409).json({ error: { message: 'The requested identifier already exists.' } });
  const saved = Object.assign({ status: 'confirmed', updated: new Date().toISOString(),
    htmlLink: 'https://calendar.google.com/event?eid=' + e.id }, e);
  events.set(e.id, saved);
  res.json(saved);
});

app.patch('/calendar/v3/calendars/:cal/events/:id', auth, (req, res) => {
  const cur = events.get(req.params.id);
  calls.push({ what: 'patch', id: req.params.id });
  if (!cur) return res.status(404).json({ error: { message: 'Not Found' } });
  const next = Object.assign({}, cur, req.body, { updated: new Date().toISOString() });
  events.set(req.params.id, next);
  res.json(next);
});

app.delete('/calendar/v3/calendars/:cal/events/:id', auth, (req, res) => {
  calls.push({ what: 'delete', id: req.params.id });
  if (!events.has(req.params.id)) return res.status(404).json({ error: { message: 'Not Found' } });
  events.delete(req.params.id);
  res.status(204).end();
});

/* test-harness hooks, not part of Google's API */
app.get('/__state', (q, r) => r.json({ count: events.size, ids: [...events.keys()], events: [...events.values()], calls }));
app.post('/__reset', (q, r) => { events.clear(); calls.length = 0; failNext = null; Object.keys(sheets).forEach((k) => delete sheets[k]); sheetLog.reads.length = 0; sheetLog.writes.length = 0; sheetFail = null; r.json({ ok: true }); });
app.post('/__fail', (q, r) => { failNext = q.body.status; r.json({ ok: true }); });
app.post('/__seed', (q, r) => { events.set(q.body.id, q.body); r.json({ ok: true }); });

/* ---- Sheets (date write-back). /__sheet seeds { id, tabs: { Title: [[cell,...],...] } }.
   Records every read range and every write so a test can prove which cells
   were touched. Rows are arrays of cells; a column read returns one entry per
   row, trailing blanks trimmed like the real API. */
const sheets = {};
const sheetLog = { reads: [], writes: [] };
let sheetFail = null;
app.post('/__sheet', (q, r) => { sheets[q.body.id] = { tabs: q.body.tabs || {} }; r.json({ ok: true }); });
app.post('/__sheetfail', (q, r) => { sheetFail = q.body && q.body.status ? { status: q.body.status, times: q.body.times || 1, method: q.body.method || null } : null; r.json({ ok: true }); });
app.get('/__sheetstate', (q, r) => r.json({ sheets, log: sheetLog }));
const colNum = (L) => L.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
const parseRange = (rg) => {
  const m = String(rg).match(/^'((?:[^']|'')+)'!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/);
  if (m) return { tab: m[1].replace(/''/g, "'"), col: m[2], row: m[3] ? +m[3] : null, endCol: m[4] || null, endRow: m[5] ? +m[5] : null };
  const r = String(rg).match(/^'((?:[^']|'')+)'!A(\d+):ZZ(\d+)$/);   // a whole header row
  return r && r[2] === r[3] ? { tab: r[1].replace(/''/g, "'"), col: "A", row: +r[2], endCol: "ZZ", endRow: +r[2], wholeRow: true } : null;
};
const sheetPlanned = (method) => {
  if (!sheetFail || (sheetFail.method && sheetFail.method !== method)) return null;
  const s = sheetFail.status; if (--sheetFail.times <= 0) sheetFail = null; return s;
};
app.get('/v4/spreadsheets/:id', auth, (req, res) => {
  const f = sheetPlanned('GET'); if (f) return res.status(f).json({ error: { message: 'forced ' + f } });
  const sh = sheets[req.params.id];
  if (!sh) return res.status(404).json({ error: { message: 'Requested entity was not found.' } });
  res.json({ sheets: Object.keys(sh.tabs).map((t) => ({ properties: { title: t } })) });
});
app.get(/^\/v4\/spreadsheets\/([^/]+)\/values:batchGet$/, auth, (req, res) => {
  const f = sheetPlanned('GET'); if (f) return res.status(f).json({ error: { message: 'forced ' + f } });
  const sh = sheets[req.params[0]];
  if (!sh) return res.status(404).json({ error: { message: 'Requested entity was not found.' } });
  const ranges = [].concat(req.query.ranges || []);
  const valueRanges = ranges.map((rg) => {
    sheetLog.reads.push(rg);
    const p = parseRange(rg);
    const rows = p && sh.tabs[p.tab];
    if (!rows) return { range: rg };
    const ci = colNum(p.col) - 1;
    if (p.wholeRow || (p.col === "A" && p.endCol === "ZZ" && p.row && p.row === p.endRow)) {            // one row, A..ZZ, trailing blanks trimmed
      const cells = (rows[p.row - 1] || []).map((c) => (c == null ? "" : String(c)));
      while (cells.length && cells[cells.length - 1] === "") cells.pop();
      return cells.length ? { range: rg, majorDimension: "ROWS", values: [cells] } : { range: rg };
    }
    if (p.row && !p.endCol) {    // a single cell
      const v = rows[p.row - 1] && rows[p.row - 1][ci];
      return v == null || v === "" ? { range: rg } : { range: rg, majorDimension: "ROWS", values: [[String(v)]] };
    }
    const col = rows.map((row) => (row[ci] == null ? '' : row[ci]));
    while (col.length && col[col.length - 1] === '') col.pop();
    return { range: rg, majorDimension: 'ROWS', values: col.map((c) => (c === '' ? [] : [c])) };
  });
  res.json({ spreadsheetId: req.params[0], valueRanges });
});
app.put(/^\/v4\/spreadsheets\/([^/]+)\/values\/(.+)$/, auth, (req, res) => {
  const f = sheetPlanned('PUT'); if (f) return res.status(f).json({ error: { message: 'forced ' + f } });
  const sh = sheets[req.params[0]];
  const rg = decodeURIComponent(req.params[1]);
  sheetLog.writes.push({ id: req.params[0], range: rg, valueInputOption: req.query.valueInputOption, values: (req.body || {}).values });
  const p = parseRange(rg);
  if (!sh || !p || !sh.tabs[p.tab] || !p.row) return res.status(400).json({ error: { message: 'Unable to parse range: ' + rg } });
  const rows = sh.tabs[p.tab];
  const ci = colNum(p.col) - 1;
  while (rows.length < p.row) rows.push([]);
  while (rows[p.row - 1].length <= ci) rows[p.row - 1].push('');
  rows[p.row - 1][ci] = String(req.body.values[0][0]);
  res.json({ spreadsheetId: req.params[0], updatedRange: rg, updatedCells: 1 });
});

const GPORT = Number(process.env.FAKE_GOOGLE_PORT) || 3455;
app.listen(GPORT, () => console.log('fake google on ' + GPORT));
