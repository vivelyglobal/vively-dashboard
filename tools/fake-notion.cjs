/* Stands in for Notion's API for the write-back tests. Enforces the parts
   that actually bite: a status value must already be an option on that
   database, and a "status" column will not accept a "select" payload. */
const express = require('express');
const app = express();
app.use(express.json({ limit: '5mb' }));

const OPTIONS = ['Waiting Approval', 'Confirmed', 'Brand Rejected', 'Brand Accepted',
                 'Declined', 'Re-Schedule', 'Waiting Upload', 'Cancelled', 'Uploaded'];
const pages = {};      // pageId -> { Status }
const writes = [];

app.patch('/v1/pages/:id', (q, r) => {
  const props = (q.body || {}).properties || {};
  const [name, shape] = Object.entries(props)[0] || [];
  writes.push({ id: q.params.id, name, shape });
  if (!name) return r.status(400).json({ message: 'No property given' });
  if (shape.select) {
    /* the real API refuses a select payload for a status column */
    return r.status(400).json({ message: `${name} is expected to be status.` });
  }
  const value = (shape.status || {}).name;
  if (!OPTIONS.includes(value)) {
    return r.status(400).json({ message: `Invalid status option: "${value}" is not a valid option.` });
  }
  pages[q.params.id] = { Status: value };
  r.json({ object: 'page', id: q.params.id });
});

/* ------------------------------------------------------------------
   Enough of the read side to make a sync do real work.

   Without this the fake answered only the write-back PATCH, so every
   harness that pressed "Sync from Notion" got an error, changed nothing,
   and still reported a pass — the sync had no rows to disagree with. A
   test that survives because nothing happened is worse than no test, so
   the form is served here from the same seed the page is loaded with,
   and /__form decides which rows belong to which data source.
   ------------------------------------------------------------------ */
let form = {};         // dataSourceId -> [{ pageId, properties }]

app.post('/__form', (q, r) => { form = q.body || {}; r.json({ ok: true, sources: Object.keys(form) }); });

/* the dashboard stores a database id; Notion resolves it to a data source */
app.get('/v1/databases/:id', (q, r) => {
  if (!form[q.params.id]) return r.status(404).json({ message: 'Could not find database' });
  r.json({ object: 'database', id: q.params.id, data_sources: [{ id: q.params.id, name: 'Responses' }] });
});

app.get('/v1/data_sources/:id', (q, r) => {
  const rows = form[q.params.id];
  if (!rows) return r.status(404).json({ message: 'Could not find data source' });
  const properties = {};
  Object.keys((rows[0] || {}).properties || {}).forEach((name) => {
    properties[name] = name === 'Status'
      ? { type: 'status', status: { groups: { to_do: OPTIONS.map((o) => ({ name: o })) } } }
      : { type: 'rich_text' };
  });
  r.json({ object: 'data_source', id: q.params.id, title: [{ plain_text: 'Responses' }], properties });
});

app.post('/v1/data_sources/:id/query', (q, r) => {
  const rows = form[q.params.id] || [];
  r.json({
    object: 'list', has_more: false, next_cursor: null,
    results: rows.map((row) => ({
      object: 'page', id: row.pageId, url: 'https://notion.so/' + String(row.pageId).replace(/-/g, ''),
      created_time: row.createdTime || '2026-08-01T00:00:00.000Z',
      properties: Object.fromEntries(Object.entries(row.properties || {}).map(([name, v]) =>
        [name, name === 'Status'
          ? { type: 'status', status: { name: (pages[row.pageId] || {}).Status || v } }
          : { type: 'rich_text', rich_text: [{ plain_text: String(v == null ? '' : v) }] }]))
    }))
  });
});

app.get('/__state', (q, r) => r.json({ pages, writes, sources: Object.keys(form) }));
app.post('/__reset', (q, r) => { Object.keys(pages).forEach((k) => delete pages[k]); writes.length = 0; form = {}; r.json({ ok: true }); });

app.listen(3466, () => console.log('fake notion on 3466'));
