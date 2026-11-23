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

/* Date write-back support. /__page seeds { id, properties:{Name:{type}}, archived? };
   a date PATCH needs the property to exist and be a date, as the real API does.
   /__fail makes the next N calls (optionally only one method) answer a status. */
const pageProps = {};     // pageId -> { archived, properties: { Name: { type, date? } } }
let failPlan = null;
app.post('/__page', (q, r) => { const b = q.body || {}; pageProps[b.id] = { archived: !!b.archived, properties: b.properties || {} }; r.json({ ok: true }); });
app.post('/__fail', (q, r) => { failPlan = q.body && q.body.status ? { status: q.body.status, times: q.body.times || 1, method: q.body.method || null } : null; r.json({ ok: true }); });
const planned = (q) => {
  if (!failPlan || (failPlan.method && failPlan.method !== q.method)) return null;
  const s = failPlan.status; if (--failPlan.times <= 0) failPlan = null; return s;
};
app.get('/v1/pages/:id', (q, r) => {
  const f = planned(q); if (f) return r.status(f).json({ message: 'forced ' + f });
  const pg = pageProps[q.params.id];
  if (!pg) return r.status(404).json({ message: 'Could not find page' });
  r.json({ object: 'page', id: q.params.id, archived: pg.archived, in_trash: false, properties: pg.properties });
});

app.patch('/v1/pages/:id', (q, r) => {
  const props = (q.body || {}).properties || {};
  const [name, shape] = Object.entries(props)[0] || [];
  writes.push({ id: q.params.id, name, shape, names: Object.keys(props) });
  if (!name) return r.status(400).json({ message: 'No property given' });
  if (shape && shape.date !== undefined) {
    const f = planned(q); if (f) return r.status(f).json({ message: 'forced ' + f });
    const pg = pageProps[q.params.id];
    if (!pg) return r.status(404).json({ message: 'Could not find page' });
    const cur = pg.properties[name];
    if (!cur) return r.status(400).json({ message: name + ' is not a property that exists.' });
    if (cur.type !== 'date') return r.status(400).json({ message: name + ' is expected to be ' + cur.type + '.' });
    const d = shape.date || {};
    const seoul = d.time_zone === 'Asia/Seoul' && d.start.length > 10;
    cur.date = { start: seoul ? d.start + '.000+09:00' : d.start, end: null, time_zone: d.time_zone || null };
    return r.json({ object: 'page', id: q.params.id });
  }
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

/* Block children, for the campaign-page autocreate: a parent page's child
   pages and a page's child databases. /__blocks sets { <blockOrPageId>: [block,...] };
   pagination is honoured (page_size and start_cursor as a numeric offset). */
let blocks = {};
app.post('/__blocks', (q, r) => { blocks = q.body || {}; r.json({ ok: true, parents: Object.keys(blocks) }); });
app.get('/v1/blocks/:id/children', (q, r) => {
  const all = blocks[q.params.id];
  if (!all) return r.status(404).json({ message: 'Could not find block' });
  const size = Math.min(Number(q.query.page_size) || 100, 100);
  const from = Number(q.query.start_cursor) || 0;
  const slice = all.slice(from, from + size);
  const more = from + size < all.length;
  r.json({ object: 'list', results: slice, has_more: more, next_cursor: more ? String(from + size) : null });
});

app.get('/__state', (q, r) => r.json({ pages, writes, sources: Object.keys(form), pageProps }));
app.post('/__reset', (q, r) => { Object.keys(pages).forEach((k) => delete pages[k]); Object.keys(pageProps).forEach((k) => delete pageProps[k]); failPlan = null; writes.length = 0; form = {}; blocks = {}; r.json({ ok: true }); });

/* the port is overridable so a test can pick a free one; 3466 stays the default */
const PORT = Number(process.env.FAKE_NOTION_PORT) || 3466;
app.listen(PORT, () => console.log('fake notion on ' + PORT));
