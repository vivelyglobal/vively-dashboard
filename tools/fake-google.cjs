/* A stand-in for Google's token endpoint and Calendar API, so the server's
   service-account signing and the sync's create/patch/delete behaviour can
   be exercised without touching a real calendar. It verifies the JWT
   assertion against the test public key rather than waving it through —
   otherwise the signing code could be wrong and the tests would not care. */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');

const pub = fs.readFileSync(__dirname + '/../tmp/fake-sa.pub', 'utf8');
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
app.post('/__reset', (q, r) => { events.clear(); calls.length = 0; failNext = null; r.json({ ok: true }); });
app.post('/__fail', (q, r) => { failNext = q.body.status; r.json({ ok: true }); });
app.post('/__seed', (q, r) => { events.set(q.body.id, q.body); r.json({ ok: true }); });

app.listen(3455, () => console.log('fake google on 3455'));
