/* A stand-in for the booking collections.

   Strict about the two things the design leans on, because a lax fake
   would pass code that fails in production: findOneAndUpdate is atomic
   and applies the same $expr the real driver would, and the partial
   unique indexes really do reject a second confirmed booking for one
   creator. Reads return copies, like the real driver, so a handler that
   mutates what it read cannot silently alter the stored row.

   Shared by tools/booking-api.mjs and tools/booking-page.mjs.
   Same idea as fake-google.cjs and fake-notion.cjs beside it. */

/* ---- the stand-in ---------------------------------------------------- */

const deepGet = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (k === '$expr') {
      /* only the one shape this code builds: booked + n <= capacity */
      const [add, cap] = v.$lte;
      return (doc.booked + add.$add[1]) <= doc[cap.slice(1)];
    }
    const actual = deepGet(doc, k);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('$ne' in v) return actual !== v.$ne;
      if ('$type' in v) return v.$type === 'string' ? typeof actual === 'string' : actual != null;
    }
    return actual === v;
  });
}

function applyUpdate(doc, update) {
  if (update.$inc) Object.entries(update.$inc).forEach(([k, n]) => { doc[k] = (doc[k] || 0) + n; });
  if (update.$set) Object.assign(doc, update.$set);
  if (update.$push) Object.entries(update.$push).forEach(([k, v]) => { (doc[k] = doc[k] || []).push(v); });
  if (update.$addToSet) Object.entries(update.$addToSet).forEach(([k, v]) => {
    doc[k] = doc[k] || []; if (!doc[k].includes(v)) doc[k].push(v);
  });
  if (update.$pull) Object.entries(update.$pull).forEach(([k, v]) => {
    doc[k] = (doc[k] || []).filter((x) => x !== v);
  });
  return doc;
}

class Col {
  constructor(name) { this.name = name; this.rows = []; this.uniques = []; }
  index(keys, partial) { this.uniques.push({ keys, partial }); return this; }
  #clash(doc, ignore) {
    return this.uniques.some(({ keys, partial }) => {
      if (partial && !matches(doc, partial)) return false;
      return this.rows.some((r) => r !== ignore
        && (!partial || matches(r, partial))
        && keys.every((k) => deepGet(r, k) === deepGet(doc, k)));
    });
  }
  async insertOne(doc) {
    if (this.#clash(doc)) { const e = new Error('dup'); e.code = 11000; throw e; }
    this.rows.push(JSON.parse(JSON.stringify(doc)));
    return { insertedId: doc._id };
  }
  /* a copy, like the real driver — a handler that mutates what it read
     must not silently alter the stored row */
  async findOne(f) {
    const hit = this.rows.find((r) => matches(r, f));
    return hit ? JSON.parse(JSON.stringify(hit)) : null;
  }
  async raw(f) { return this.rows.find((r) => matches(r, f)) || null; }
  async findOneAndUpdate(f, u) {
    const hit = this.rows.find((r) => matches(r, f));
    if (!hit) return null;
    applyUpdate(hit, u);
    return hit;
  }
  async updateOne(f, u) {
    const hit = this.rows.find((r) => matches(r, f));
    if (!hit) return { modifiedCount: 0 };
    const probe = applyUpdate(JSON.parse(JSON.stringify(hit)), u);
    if (this.#clash(probe, hit)) { const e = new Error('dup'); e.code = 11000; throw e; }
    applyUpdate(hit, u);
    return { modifiedCount: 1 };
  }
  async deleteOne(f) {
    const i = this.rows.findIndex((r) => matches(r, f));
    if (i >= 0) this.rows.splice(i, 1);
    return { deletedCount: i >= 0 ? 1 : 0 };
  }
  find(f) {
    let out = this.rows.filter((r) => matches(r, f || {}));
    const api = {
      sort: () => api,
      project: () => api,
      toArray: async () => out.map((r) => JSON.parse(JSON.stringify(r)))
    };
    return api;
  }
}

export const store = new Map();
export const col = (n) => { if (!store.has(n)) store.set(n, new Col(n)); return store.get(n); };
col('campaign_bookings')
  .index(['campaignId', 'participantId'], { status: 'confirmed', participantId: { $type: 'string' } })
  .index(['manageToken']);
col('booking_slots').index(['scheduleId', 'date', 'time']);
col('booking_schedules').index(['campaignId']).index(['publicToken']);

export const fakeClient = { db: () => ({ collection: col }) };

