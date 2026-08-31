/* Stands in for the Mongo-backed endpoints with the same contract —
   including the revision conflict — so the client half of the save
   path can be driven end to end without touching the real database. */
const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
app.use(express.json({ limit: '10mb' }));

let store = null, revision = 0;
if (process.env.PRELOAD) {
  store = { db: JSON.parse(fs.readFileSync(process.env.PRELOAD, 'utf8')).db, settings: { hideBlocked: true },
            savedAt: new Date().toISOString() };
  revision = 7;
}
app.get('/api/health', (q, r) => r.json({ ok: true, database: 'configured' }));
app.get('/api/workspace', (q, r) =>
  r.json(store ? { ok: true, data: { ...store, revision } } : { ok: true, data: null }));
app.post('/api/workspace', (q, r) => {
  const body = q.body || {};
  console.log('POST rev=' + body.revision + ' force=' + !!body.force + ' (server rev ' + revision + ')');
  if (store && !body.force && body.revision !== revision)
    return r.status(409).json({ error: 'saved from elsewhere', revision, savedAt: store.savedAt });
  store = { db: body.db, settings: body.settings || {}, savedAt: new Date().toISOString() };
  revision += 1;
  return r.json({ ok: true, savedAt: store.savedAt, revision });
});
app.post('/api/login', (q, r) => r.json({ ok: true, user: { id: 'u1', name: 'Kunzang', email: q.body.email } }));
app.post('/api/signup', (q, r) => r.json({ ok: true, user: { id: 'u2', name: q.body.name, email: q.body.email } }));

const NEXT = path.join(__dirname, 'dist', 'next');
app.use('/next', express.static(NEXT));
app.get('/next/*', (q, r) => r.sendFile(path.join(NEXT, 'index.html')));
app.use(express.static(__dirname));
app.get('*', (q, r) => r.sendFile(path.join(__dirname, 'index.html')));
app.listen(3222, () => console.log('fake api on 3222'));
