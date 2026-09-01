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

app.get('/__state', (q, r) => r.json({ pages, writes }));
app.post('/__reset', (q, r) => { Object.keys(pages).forEach((k) => delete pages[k]); writes.length = 0; r.json({ ok: true }); });

app.listen(3466, () => console.log('fake notion on 3466'));
