"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

/* ------------------------------------------------------------------
   Workspace storage (campaigns / creators / participants).

   This is the durable, cross-browser save the dashboard's Save
   button writes to. Render's filesystem is ephemeral — anything
   written to a local file here is wiped on every deploy/restart —
   so this goes to MongoDB Atlas instead, over MONGODB_URI.

   Until MONGODB_URI is set as an env var on Render, these endpoints
   respond 503 and the dashboard just keeps using its browser-local
   copy, same as it always has.
   ------------------------------------------------------------------ */
const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB = process.env.MONGODB_DB || "vively";
const WORKSPACE_ID = "shared"; // one shared workspace for the whole team, same as today's Google Sheet sync

let mongoClientPromise = null;
function getMongoClient() {
  if (!MONGODB_URI) return null;
  if (!mongoClientPromise) {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    mongoClientPromise = client
      .connect()
      .then(async (c) => {
        // enforce one account per email at the DB level too, not just in app code
        try {
          await c.db(MONGODB_DB).collection("users").createIndex({ email: 1 }, { unique: true });
        } catch (e) {
          console.error("Could not ensure users email index:", e.message);
        }
        return c;
      })
      .catch((err) => {
        mongoClientPromise = null; // let the next request try to reconnect
        throw err;
      });
  }
  return mongoClientPromise;
}

async function getWorkspaceCollection() {
  const client = await getMongoClient();
  if (!client) return null;
  return client.db(MONGODB_DB).collection("workspace");
}

async function getUsersCollection() {
  const client = await getMongoClient();
  if (!client) return null;
  return client.db(MONGODB_DB).collection("users");
}

/* ------------------------------------------------------------------
   Notion integration.

   Each campaign can point at a Notion database (the one behind that
   campaign's duplicated form) — the dashboard's "Sync from Notion"
   button reads it through here. The integration secret stays on the
   server, never sent to the browser, same reasoning as MONGODB_URI.

   Setup on Notion's side (one time): create an internal integration
   at notion.so/my-integrations, copy its secret into NOTION_TOKEN,
   then for each campaign's database, open it in Notion → Share →
   invite that integration. Without that per-database share, Notion's
   API returns a 404 even with a valid token — that's expected, not
   a bug here.
   ------------------------------------------------------------------ */
const NOTION_TOKEN = process.env.NOTION_TOKEN || "";
/* 2025-09-03 is the "data sources" API version — Notion split a database's
   schema/rows out into one-or-more "data source" objects underneath it, and
   the old 2022-06-28 database endpoints refuse to answer for a database that
   has more than one. Everything below talks to /data_sources/... instead of
   /databases/.../query, per Notion's upgrade guide. */
const NOTION_VERSION = "2025-09-03";
const NOTION_API = "https://api.notion.com/v1";

function normalizeNotionId(raw) {
  const s = String(raw || "").trim();
  let m = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (m) return m[0].toLowerCase();
  m = s.match(/[0-9a-f]{32}/i);
  if (!m) return null;
  const h = m[0].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function notionFetch(path, opts) {
  const res = await fetch(NOTION_API + path, Object.assign({
    headers: {
      Authorization: "Bearer " + NOTION_TOKEN,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    }
  }, opts || {}));
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body && body.message) || `Notion responded ${res.status}`);
  }
  return body;
}

const notionRichText = (arr) => (arr || []).map((t) => t.plain_text || "").join("").trim();

/* Pull the readable prose out of a Notion page — the campaign blurb that
   sits above a form ("Enjoy a Complimentary Premium Omakase Experience…")
   lives in blocks, not in a property, so it has to be walked block by
   block. Headings/bullets/quotes are kept, everything else is skipped. */
async function notionPageText(pageId, limit) {
  const KEEP = new Set([
    "paragraph", "heading_1", "heading_2", "heading_3",
    "bulleted_list_item", "numbered_list_item", "quote", "callout", "toggle"
  ]);
  try {
    const body = await notionFetch("/blocks/" + pageId + "/children?page_size=" + (limit || 60));
    const lines = [];
    (body.results || []).forEach((b) => {
      if (!KEEP.has(b.type)) return;
      const text = notionRichText((b[b.type] || {}).rich_text);
      if (!text) return;
      if (b.type.startsWith("heading_")) lines.push("\n" + text);
      else if (b.type.endsWith("list_item")) lines.push("• " + text);
      else lines.push(text);
    });
    return lines.join("\n").trim();
  } catch (err) {
    console.error("notionPageText failed for " + pageId + ":", err.message);
    return "";
  }
}

/* The campaign blurb, hunted down wherever Notion happens to keep it for
   this database: the data source's own description, then the parent
   database's, then the prose on the page the database lives on. */
async function notionDescriptionFor(ds) {
  const direct = notionRichText(ds.description);
  if (direct) return direct;

  const parent = ds.parent || {};
  const dbId = parent.database_id || parent.data_source_id;
  if (!dbId) return "";
  try {
    const db = await notionFetch("/databases/" + dbId);
    const dbDesc = notionRichText(db.description);
    if (dbDesc) return dbDesc;
    const dbParent = db.parent || {};
    if (dbParent.page_id) return await notionPageText(dbParent.page_id);
  } catch (err) {
    console.error("notionDescriptionFor failed:", err.message);
  }
  return "";
}

/* Whatever ID gets pasted in — a database link, a page link, a link to
   one submission, a data source link — resolve it down to the actual
   Notion "data source" ID that /data_sources/... reads from. Handles:
     - a database with exactly one data source (the normal case): use it
     - a database with several data sources: use the first, and log it,
       since there's no way for us to guess which one the form feeds
     - a page that merely contains a database (Notion's "Copy link" hands
       these out constantly — from inside one entry, from a column, from
       the database's own "view as page"): look inside the page for the
       database it holds, then resolve that
     - an ID that's already a data source: used as-is */
async function resolveDataSourceId(id) {
  try {
    const db = await notionFetch("/databases/" + id);
    const sources = db.data_sources || [];
    if (!sources.length) {
      throw new Error("That database doesn't have a data source Notion will let this integration read.");
    }
    if (sources.length > 1) {
      console.error(`Notion database ${id} has ${sources.length} data sources — using "${sources[0].name}".`);
    }
    return sources[0].id;
  } catch (err) {
    if (/is a page, not a database/i.test(err.message || "")) {
      const children = await notionFetch("/blocks/" + id + "/children?page_size=100");
      const dbBlock = (children.results || []).find((b) => b.type === "child_database");
      if (!dbBlock) {
        throw new Error(
          "That link points to a page that doesn't contain a database. Open the actual submissions table in Notion (not one entry, and not the form itself) and copy its link from there."
        );
      }
      return resolveDataSourceId(dbBlock.id);
    }
    // last resort: maybe this was already a data source ID
    try {
      await notionFetch("/data_sources/" + id);
      return id;
    } catch (err2) {
      throw err; // the original error is the more useful one to surface
    }
  }
}

function extractNotionValue(prop) {
  if (!prop) return "";
  switch (prop.type) {
    case "title": return (prop.title || []).map((t) => t.plain_text).join("");
    case "rich_text": return (prop.rich_text || []).map((t) => t.plain_text).join("");
    case "email": return prop.email || "";
    case "phone_number": return prop.phone_number || "";
    case "url": return prop.url || "";
    case "number": return prop.number == null ? "" : prop.number;
    case "select": return prop.select ? prop.select.name : "";
    case "status": return prop.status ? prop.status.name : "";
    case "multi_select": return (prop.multi_select || []).map((o) => o.name).join(", ");
    case "checkbox": return prop.checkbox ? "true" : "false";
    case "date": return prop.date ? (prop.date.start || "") : "";
    case "people": return (prop.people || []).map((p) => p.name || p.id).join(", ");
    case "files": return (prop.files || []).map((f) => f.name || (f.file && f.file.url) || (f.external && f.external.url) || "").join(", ");
    case "created_time": return prop.created_time || "";
    case "last_edited_time": return prop.last_edited_time || "";
    case "relation": return (prop.relation || []).map((r) => r.id).join(", ");
    case "formula": {
      const f = prop.formula || {};
      if (f.type === "string") return f.string || "";
      if (f.type === "number") return f.number == null ? "" : f.number;
      if (f.type === "boolean") return f.boolean ? "true" : "false";
      if (f.type === "date") return f.date ? f.date.start || "" : "";
      return "";
    }
    case "unique_id": {
      const u = prop.unique_id || {};
      return u.number == null ? "" : (u.prefix ? u.prefix + "-" : "") + u.number;
    }
    case "rollup": {
      const r = prop.rollup || {};
      if (r.type === "number") return r.number == null ? "" : r.number;
      if (r.type === "date") return r.date ? r.date.start || "" : "";
      if (r.type === "array") return (r.array || []).map(extractNotionValue).filter(Boolean).join(", ");
      return "";
    }
    /* A property type this was never taught (Notion keeps adding them, and
       form questions can land on any of them) still carries its value under
       a key named after its own type. Read that generically rather than
       dropping the answer on the floor. */
    default: {
      const v = prop[prop.type];
      if (v == null) return "";
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
      if (Array.isArray(v)) return v.map((x) => (x && (x.plain_text || x.name)) || "").filter(Boolean).join(", ");
      if (typeof v === "object") return v.start || v.name || v.url || v.string || "";
      return "";
    }
  }
}

/* ------------------------------------------------------------------
   Google Calendar.

   Setup on Google's side (one time):
     1. Google Cloud console → new project → enable the Calendar API.
     2. Create a service account. Add a key, type JSON, and download it.
     3. Put the whole JSON into GOOGLE_SERVICE_ACCOUNT on Render.
        Base64 is accepted too, for pasting into a one-line field.
     4. In Google Calendar, make a calendar for this (e.g. "VIVELY
        Creator Visits"), open its settings → Share with specific
        people → add the service account's client_email → give it
        "Make changes to events". Put that calendar's ID into
        GOOGLE_CALENDAR_ID.

   Step 4 is the one people miss, and its absence looks exactly like a
   bad key: the API answers 404 for a calendar the service account has
   not been invited to. Same trap as sharing a Notion database with an
   integration.

   A service account is its own account with its own (empty) calendar
   list — it cannot see anything of yours until you share it. That is
   also why events land on a dedicated calendar rather than a personal
   one, and why nobody has to sign in through a consent screen.
   ------------------------------------------------------------------ */
const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT || "";
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "";
/* overridable so the test harness can point at a local stand-in; unset in
   production, which is every deployment that does not say otherwise */
const GCAL_API = process.env.GOOGLE_CALENDAR_API || "https://www.googleapis.com/calendar/v3";
const GCAL_SCOPE = "https://www.googleapis.com/auth/calendar.events";

function googleCredentials() {
  if (!GOOGLE_SERVICE_ACCOUNT) return null;
  let raw = GOOGLE_SERVICE_ACCOUNT.trim();
  /* accept the raw JSON or a base64 copy of it — a private key is full of
     newlines, and pasting it into a single-line env field mangles them */
  if (!raw.startsWith("{")) {
    try { raw = Buffer.from(raw, "base64").toString("utf8").trim(); } catch (e) { /* fall through */ }
  }
  let key;
  try { key = JSON.parse(raw); } catch (e) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT is not valid JSON (or base64 of it).");
  }
  if (!key.client_email || !key.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT is missing client_email or private_key.");
  }
  /* some hosting UIs turn real newlines into the two characters \n */
  key.private_key = String(key.private_key).replace(/\\n/g, "\n");
  return key;
}

const b64url = (buf) => Buffer.from(buf).toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let gcalToken = null;   // { value, expiresAt }

/* Service accounts authenticate by signing a short-lived assertion with
   their private key and trading it for an access token. No library — it
   is a signature and one POST, and this keeps the dependency list at
   express + mongodb. */
async function googleAccessToken() {
  if (gcalToken && gcalToken.expiresAt > Date.now() + 60000) return gcalToken.value;
  const key = googleCredentials();
  if (!key) return null;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: key.client_email,
    scope: GCAL_SCOPE,
    aud: key.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(header + "." + claim);
  const assertion = header + "." + claim + "." + b64url(signer.sign(key.private_key));

  const res = await fetch(key.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const detail = body.error_description || body.error || `token endpoint responded ${res.status}`;
    throw new Error("Google refused the service account key — " + detail);
  }
  gcalToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  return gcalToken.value;
}

async function gcalFetch(path, opts) {
  const token = await googleAccessToken();
  if (!token) throw new Error("Google Calendar is not configured on the server yet.");
  const o = opts || {};
  const res = await fetch(GCAL_API + path, {
    method: o.method || "GET",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  if (res.status === 204) return {};
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body.error && (body.error.message || body.error.status)) || `Google responded ${res.status}`;
    const err = new Error(res.status === 404
      ? msg + " — check the calendar is shared with the service account's client_email."
      : msg);
    err.status = res.status;
    throw err;
  }
  return body;
}

const calendarPath = (id) => "/calendars/" + encodeURIComponent(id || GOOGLE_CALENDAR_ID);

/* Google event ids are base32hex: digits 0-9 and letters a-v ONLY. w, x, y
   and z are not legal, which rules out readable ids — "vively-cp1" is
   rejected twice over, for the y and the hyphen. So the id is a hash of the
   thing it belongs to: deterministic, so the same booking always lands on
   the same event however many times the sync runs, and hex digits are a
   subset of the legal alphabet so it is valid by construction.

   The readable identifiers live in extendedProperties instead, where they
   can be searched on and are not constrained. */
function gcalEventId(kind, key) {
  const digest = crypto.createHash("sha256").update(String(kind) + ":" + String(key)).digest("hex");
  return "v" + digest.slice(0, 30);          /* 31 chars, all within [0-9a-v] */
}

/* ------------------------------------------------------------------
   Accounts (signup/login) live in MongoDB now, same as the workspace
   data — the flat file below is kept ONLY as a fallback for when
   MONGODB_URI isn't set (e.g. running this locally without Atlas).
   On Render, that file lived on the ephemeral disk, so every restart
   or redeploy silently wiped every signed-up account, which is why
   logins stopped "sticking" — this fixes that.
   ------------------------------------------------------------------ */
function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]", "utf8");
}

function readUsers() {
  ensureDataFile();
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch (err) {
    return [];
  }
}

function writeUsers(users) {
  ensureDataFile();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function hashPassword(password, salt) {
  const saltValue = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(String(password), saltValue, 100000, 64, "sha512")
    .toString("hex");
  return `${saltValue}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, originalHash] = String(stored || "").split(":");
  if (!salt || !originalHash) return false;
  const next = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(originalHash), Buffer.from(next));
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt
  };
}

app.use(express.json({ limit: "10mb" }));

/* The React build, served alongside the original single-file dashboard.
   "/" still serves index.html exactly as before, so nothing anyone is
   using today changes; "/next" serves the converted app while the two
   are brought to parity. When they match, "/" points here instead. */
const NEXT_DIR = path.join(__dirname, "dist", "next");
if (fs.existsSync(NEXT_DIR)) {
  app.use("/next", express.static(NEXT_DIR));
  app.get("/next/*", (req, res) => res.sendFile(path.join(NEXT_DIR, "index.html")));
}

app.use(express.static(__dirname));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "vively-auth-api",
    database: MONGODB_URI ? "configured" : "not-configured",
    notion: NOTION_TOKEN ? "configured" : "not-configured"
  });
});

/* ---------------------------- workspace save/load ---------------------------- */

app.get("/api/workspace", async (req, res) => {
  if (!MONGODB_URI) {
    return res.status(503).json({ error: "Database not configured on the server yet — set MONGODB_URI." });
  }
  try {
    const col = await getWorkspaceCollection();
    const doc = await col.findOne({ _id: WORKSPACE_ID });
    if (!doc) return res.json({ ok: true, data: null });
    return res.json({
      ok: true,
      data: { db: doc.db, settings: doc.settings || {}, savedAt: doc.savedAt, revision: doc.revision || 0 }
    });
  } catch (err) {
    console.error("GET /api/workspace failed:", err.message);
    return res.status(502).json({ error: "Could not reach the database." });
  }
});

app.post("/api/workspace", async (req, res) => {
  if (!MONGODB_URI) {
    return res.status(503).json({ error: "Database not configured on the server yet — set MONGODB_URI." });
  }

  const db = req.body && req.body.db;
  const dbOk = db && Array.isArray(db.campaigns) && Array.isArray(db.creators) && Array.isArray(db.participants);
  if (!dbOk) {
    return res.status(400).json({ error: "Malformed workspace payload." });
  }

  const clientRevision = Number.isFinite(req.body.revision) ? req.body.revision : 0;
  const force = !!req.body.force;

  try {
    const col = await getWorkspaceCollection();
    const existing = await col.findOne({ _id: WORKSPACE_ID }, { projection: { revision: 1, savedAt: 1 } });
    const currentRevision = (existing && existing.revision) || 0;

    if (existing && !force && clientRevision !== currentRevision) {
      return res.status(409).json({
        error: "This workspace was saved from elsewhere since you last loaded it.",
        revision: currentRevision,
        savedAt: existing.savedAt
      });
    }

    const savedAt = new Date().toISOString();
    const nextRevision = currentRevision + 1;
    await col.updateOne(
      { _id: WORKSPACE_ID },
      { $set: { db, settings: req.body.settings || {}, savedAt, revision: nextRevision } },
      { upsert: true }
    );
    return res.json({ ok: true, savedAt, revision: nextRevision });
  } catch (err) {
    console.error("POST /api/workspace failed:", err.message);
    return res.status(502).json({ error: "Could not reach the database." });
  }
});

/* ---------------------------- notion sync ---------------------------- */

app.get("/api/notion/database", async (req, res) => {
  if (!NOTION_TOKEN) {
    return res.status(503).json({ error: "Notion is not configured on the server yet — set NOTION_TOKEN." });
  }
  const rawId = normalizeNotionId(req.query.id);
  if (!rawId) return res.status(400).json({ error: "That doesn't look like a Notion database link or ID." });
  try {
    const dataSourceId = await resolveDataSourceId(rawId);
    const ds = await notionFetch("/data_sources/" + dataSourceId);
    const properties = Object.entries(ds.properties || {}).map(([name, def]) => ({ name, type: def.type }));
    return res.json({
      ok: true,
      id: dataSourceId, // a data-source ID now, not a database ID — store and reuse this as-is
      title: (ds.title || []).map((t) => t.plain_text).join("") || "Untitled database",
      description: await notionDescriptionFor(ds),
      properties
    });
  } catch (err) {
    console.error("GET /api/notion/database failed:", err.message);
    return res.status(502).json({ error: err.message });
  }
});

app.get("/api/notion/query", async (req, res) => {
  if (!NOTION_TOKEN) {
    return res.status(503).json({ error: "Notion is not configured on the server yet — set NOTION_TOKEN." });
  }
  const rawId = normalizeNotionId(req.query.id);
  if (!rawId) return res.status(400).json({ error: "That doesn't look like a Notion database link or ID." });
  try {
    const dataSourceId = await resolveDataSourceId(rawId);
    const rows = [];
    let cursor = null;
    let guard = 0;
    do {
      const body = await notionFetch("/data_sources/" + dataSourceId + "/query", {
        method: "POST",
        body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 })
      });
      (body.results || []).forEach((page) => {
        const properties = {};
        Object.entries(page.properties || {}).forEach(([name, prop]) => {
          properties[name] = extractNotionValue(prop);
        });
        rows.push({ pageId: page.id, url: page.url, createdTime: page.created_time, properties });
      });
      cursor = body.has_more ? body.next_cursor : null;
      guard++;
    } while (cursor && guard < 50); // safety cap: 5,000 rows
    return res.json({ ok: true, count: rows.length, rows });
  } catch (err) {
    console.error("GET /api/notion/query failed:", err.message);
    return res.status(502).json({ error: err.message });
  }
});

/* ---------------------------- google calendar ---------------------------- */

/* client_email is deliberately returned: it is not a secret, and it is the
   exact string that has to be pasted into the calendar's sharing settings.
   Showing it in the app saves digging the JSON key back out. */
app.get("/api/calendar/status", async (req, res) => {
  if (!GOOGLE_SERVICE_ACCOUNT || !GOOGLE_CALENDAR_ID) {
    return res.json({
      ok: true, configured: false,
      missing: [!GOOGLE_SERVICE_ACCOUNT && "GOOGLE_SERVICE_ACCOUNT", !GOOGLE_CALENDAR_ID && "GOOGLE_CALENDAR_ID"].filter(Boolean)
    });
  }
  let clientEmail = null;
  try { clientEmail = googleCredentials().client_email; } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  try {
    const cal = await gcalFetch(calendarPath());
    return res.json({
      ok: true, configured: true, clientEmail,
      calendarId: GOOGLE_CALENDAR_ID, summary: cal.summary || "", timeZone: cal.timeZone || ""
    });
  } catch (err) {
    return res.status(err.status === 404 ? 404 : 502).json({ error: err.message, clientEmail });
  }
});

app.get("/api/calendar/events", async (req, res) => {
  try {
    const q = new URLSearchParams({ maxResults: "2500", singleEvents: "true", showDeleted: "false" });
    if (req.query.timeMin) q.set("timeMin", String(req.query.timeMin));
    if (req.query.timeMax) q.set("timeMax", String(req.query.timeMax));
    /* every event this dashboard writes carries a private tag, so the sync
       can ask Google "what of mine is already here?" instead of trusting
       local state — that is what survives a lost workspace */
    if (req.query.tag) q.append("privateExtendedProperty", "vivelySource=" + String(req.query.tag));

    const rows = [];
    let pageToken = null, guard = 0;
    do {
      if (pageToken) q.set("pageToken", pageToken); else q.delete("pageToken");
      const body = await gcalFetch(calendarPath() + "/events?" + q.toString());
      (body.items || []).forEach((e) => rows.push({
        id: e.id, summary: e.summary || "", description: e.description || "", location: e.location || "",
        start: (e.start || {}).dateTime || (e.start || {}).date || "",
        end: (e.end || {}).dateTime || (e.end || {}).date || "",
        timeZone: (e.start || {}).timeZone || "",
        status: e.status, updated: e.updated, htmlLink: e.htmlLink,
        props: (e.extendedProperties && e.extendedProperties.private) || {}
      }));
      pageToken = body.nextPageToken || null;
      guard++;
    } while (pageToken && guard < 20);
    return res.json({ ok: true, count: rows.length, events: rows });
  } catch (err) {
    console.error("GET /api/calendar/events failed:", err.message);
    return res.status(502).json({ error: err.message });
  }
});

/* Create-or-update, keyed on an id the dashboard chooses. Creating with a
   known id is what makes a repeated sync land on the same event instead of
   a second copy; if Google says that id is taken, this patches it rather
   than failing, so re-running the sync is always safe. */
app.post("/api/calendar/event", async (req, res) => {
  const e = req.body || {};
  if (!e.key || !e.summary || !e.start || !e.end) {
    return res.status(400).json({ error: "key, summary, start and end are all required." });
  }
  /* derived here, not sent by the browser: one place decides what an event
     is called, so a client that gets it wrong cannot create a duplicate */
  const eventId = gcalEventId(e.kind || "visit", e.key);
  const payload = {
    id: eventId,
    summary: e.summary,
    description: e.description || "",
    location: e.location || "",
    start: { dateTime: e.start, timeZone: e.timeZone || undefined },
    end:   { dateTime: e.end,   timeZone: e.timeZone || undefined },
    extendedProperties: { private: Object.assign(
      { vivelySource: "vively-dashboard", vivelyKind: e.kind || "visit", vivelyKey: String(e.key) },
      e.props || {}) }
  };
  try {
    const created = await gcalFetch(calendarPath() + "/events", { method: "POST", body: payload });
    return res.json({ ok: true, action: "created", event: { id: created.id, htmlLink: created.htmlLink, updated: created.updated } });
  } catch (err) {
    if (err.status !== 409) {
      console.error("POST /api/calendar/event failed:", err.message);
      return res.status(502).json({ error: err.message });
    }
  }
  try {
    const { id, ...patch } = payload;
    const updated = await gcalFetch(calendarPath() + "/events/" + encodeURIComponent(eventId), { method: "PATCH", body: patch });
    return res.json({ ok: true, action: "updated", event: { id: updated.id, htmlLink: updated.htmlLink, updated: updated.updated } });
  } catch (err) {
    console.error("PATCH /api/calendar/event failed:", err.message);
    return res.status(502).json({ error: err.message });
  }
});

app.post("/api/calendar/event/delete", async (req, res) => {
  const b = req.body || {};
  const id = b.id ? String(b.id) : (b.key ? gcalEventId(b.kind || "visit", b.key) : "");
  if (!id) return res.status(400).json({ error: "id, or kind and key, are required." });
  try {
    await gcalFetch(calendarPath() + "/events/" + encodeURIComponent(id), { method: "DELETE" });
    return res.json({ ok: true, deleted: id });
  } catch (err) {
    /* already gone is the outcome we wanted anyway */
    if (err.status === 404 || err.status === 410) return res.json({ ok: true, deleted: id, alreadyGone: true });
    console.error("POST /api/calendar/event/delete failed:", err.message);
    return res.status(502).json({ error: err.message });
  }
});

/* Writes one probe event and removes it again, so "is this wired up
   correctly?" has a real answer instead of a hopeful one. */
app.post("/api/calendar/test", async (req, res) => {
  const id = gcalEventId("test", Date.now());
  const start = new Date(Date.now() + 86400000);
  const iso = (d) => d.toISOString().replace(/\.\d+Z$/, "Z");
  try {
    const created = await gcalFetch(calendarPath() + "/events", { method: "POST", body: {
      id,
      summary: "VIVELY connection test — safe to ignore",
      description: "Written by the dashboard to check its Google Calendar connection. It is removed again immediately.",
      start: { dateTime: iso(start) },
      end: { dateTime: iso(new Date(start.getTime() + 900000)) },
      extendedProperties: { private: { vivelySource: "vively-dashboard", vivelyKind: "test" } }
    } });
    await gcalFetch(calendarPath() + "/events/" + encodeURIComponent(created.id), { method: "DELETE" });
    return res.json({ ok: true, wrote: created.id, cleanedUp: true });
  } catch (err) {
    console.error("POST /api/calendar/test failed:", err.message);
    return res.status(502).json({ error: err.message });
  }
});

/* ---------------------------- partner view ----------------------------
   A partner's point of contact gets one unguessable link and no login.
   The link resolves to a partner name, and the rows are assembled HERE,
   from the same database the dashboard reads — so the page is current
   because it is the same data, not because somebody exported it lately.

   Shaping the rows on the server is the point. Bank details, internal
   notes, fees and every campaign belonging to someone else are removed
   before the response is written, so they are never in a payload that
   reaches the browser, whatever the page does with it.
   ---------------------------------------------------------------------- */

/* Their Notion form has nine statuses; the partner view has seven. Waiting
   Approval keeps its own label because it is the one that sits with THEM. */
const PARTNER_STATUS = {
  "waiting approval": { ko: "승인 대기", en: "Waiting Approval", tone: "amber", theirs: true },
  "brand accepted":   { ko: "확정", en: "Confirmed", tone: "green" },
  "confirmed":        { ko: "확정", en: "Confirmed", tone: "green" },
  "brand rejected":   { ko: "브랜드 거절", en: "Brand Rejected", tone: "red" },
  "declined":         { ko: "거절", en: "Refused", tone: "grey" },
  "cancelled":        { ko: "거절", en: "Refused", tone: "grey" },
  "canceled":         { ko: "거절", en: "Refused", tone: "grey" },
  "re-schedule":      { ko: "업로드 대기", en: "Waiting For upload", tone: "blue" },
  "waiting upload":   { ko: "업로드 대기", en: "Waiting For upload", tone: "blue" },
  "uploaded":         { ko: "업로드 완료", en: "Uploaded", tone: "green" }
};
const STAGE_TO_PARTNER = {
  sourced:     { ko: "컨택", en: "Contacted", tone: "grey" },
  contacted:   { ko: "컨택", en: "Contacted", tone: "grey" },
  replied:     { ko: "컨택", en: "Contacted", tone: "grey" },
  shortlisted: { ko: "승인 대기", en: "Waiting Approval", tone: "amber", theirs: true },
  confirmed:   { ko: "확정", en: "Confirmed", tone: "green" },
  shipped:     { ko: "업로드 대기", en: "Waiting For upload", tone: "blue" },
  submitted:   { ko: "업로드 대기", en: "Waiting For upload", tone: "blue" },
  review:      { ko: "업로드 대기", en: "Waiting For upload", tone: "blue" },
  live:        { ko: "업로드 완료", en: "Uploaded", tone: "green" },
  dropped:     { ko: "거절", en: "Refused", tone: "grey" }
};

function partnerStatusOf(p) {
  const raw = String(p.importedStatus || "").trim().toLowerCase();
  if (raw && PARTNER_STATUS[raw]) return PARTNER_STATUS[raw];
  if (/brand.*reject/.test(raw)) return PARTNER_STATUS["brand rejected"];
  if (p.stage === "dropped" && /brand/i.test(p.dropReason || "")) return PARTNER_STATUS["brand rejected"];
  return STAGE_TO_PARTNER[p.stage] || STAGE_TO_PARTNER.contacted;
}

async function loadWorkspaceDoc() {
  const col = await getWorkspaceCollection();
  if (!col) return null;
  return col.findOne({ _id: WORKSPACE_ID });
}

function resolvePartnerToken(doc, token) {
  const links = (doc && doc.db && doc.db.partnerLinks) || [];
  const hit = links.find((l) => l.token === token && !l.revokedAt);
  return hit ? hit.partner : null;
}

function buildPartnerRows(db, partner) {
  const byCreator = Object.fromEntries((db.creators || []).map((c) => [c.id, c]));
  const byCampaign = Object.fromEntries((db.campaigns || []).map((c) => [c.id, c]));
  const mine = (db.campaigns || []).filter((c) => (c.partner || "") === partner);
  const ids = new Set(mine.map((c) => c.id));

  /* A creator still awaiting brand approval is not shown at all. They are a
     proposal, not a booking, and the partner sees the roster once it is
     settled. Filtered HERE rather than in the page, so an unapproved creator
     is never in the response for anyone to find in devtools. */
  const rows = (db.participants || []).filter((p) => ids.has(p.campaignId))
    .filter((p) => !partnerStatusOf(p).theirs)
    .map((p) => {
    const cr = byCreator[p.creatorId] || {};
    const cp = byCampaign[p.campaignId] || {};
    const st = partnerStatusOf(p);
    const m = String(p.visitAt || "").trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}:\d{2}))?/);
    const handle = cr.handle || "";
    return {
      pid: p.id,
      campaign: cp.brand || "",
      creator: p.fullName || cr.name || handle,
      handle,
      igUrl: handle ? "https://www.instagram.com/" + String(handle).replace(/^@/, "") + "/" : "",
      visitDate: m ? m[1] : "",
      visitTime: m && m[2] ? m[2] : "",
      email: cr.email || "",
      status: st,
      gender: cr.gender || "",
      followers: cr.followers || 0,
      remark: p.remark || "",
      contentUrl: (p.content && p.content.url) || "",
      nationality: p.nationality || cr.nationality || cr.country || "",
      notes: p.formNotes || "",
      otherSns: p.otherSns || ""
      /* deliberately absent: cr.payout, p.note, p.fee, p.address, the Kakao
         ID, the accept/reject message, and every campaign that is not this
         partner's */
    };
  });

  rows.sort((a, b) => (a.visitDate || "9999").localeCompare(b.visitDate || "9999") ||
                      (a.visitTime || "").localeCompare(b.visitTime || "") ||
                      a.creator.localeCompare(b.creator));
  const withheld = (db.participants || []).filter((p) => ids.has(p.campaignId))
    .filter((p) => partnerStatusOf(p).theirs).length;
  return { partner, withheld,
    campaigns: mine.map((c) => ({ id: c.id, brand: c.brand, name: c.name, start: c.start, end: c.end })), rows };
}

async function partnerCommentsCollection() {
  const client = await getMongoClient();
  if (!client) return null;
  return client.db(MONGODB_DB).collection("partner_comments");
}

app.get("/api/partner/:token", async (req, res) => {
  if (!MONGODB_URI) return res.status(503).json({ error: "Not configured." });
  try {
    const doc = await loadWorkspaceDoc();
    const partner = resolvePartnerToken(doc, req.params.token);
    if (!partner) return res.status(404).json({ error: "This link is not valid, or has been turned off." });
    const payload = buildPartnerRows(doc.db || {}, partner);
    const col = await partnerCommentsCollection();
    const comments = col ? await col.find({ partner }).sort({ at: 1 }).toArray() : [];
    payload.comments = comments.map((c) => ({ pid: c.pid, text: c.text, author: c.author, at: c.at }));
    payload.updatedAt = doc.savedAt || null;
    res.set("X-Robots-Tag", "noindex, nofollow");
    return res.json({ ok: true, ...payload });
  } catch (err) {
    console.error("GET /api/partner failed:", err.message);
    return res.status(502).json({ error: "Could not reach the database." });
  }
});

/* Comments live in their own collection, not in the workspace document.
   The workspace is saved with an optimistic revision check, so writing a
   partner's comment into it would collide with whoever has the dashboard
   open — and a comment is not worth a save conflict. */
app.post("/api/partner/:token/comment", async (req, res) => {
  if (!MONGODB_URI) return res.status(503).json({ error: "Not configured." });
  const text = String((req.body || {}).text || "").trim().slice(0, 2000);
  const pid = String((req.body || {}).pid || "");
  const author = String((req.body || {}).author || "").trim().slice(0, 80);
  if (!text || !pid) return res.status(400).json({ error: "A comment and a row are both required." });
  try {
    const doc = await loadWorkspaceDoc();
    const partner = resolvePartnerToken(doc, req.params.token);
    if (!partner) return res.status(404).json({ error: "This link is not valid, or has been turned off." });
    /* only against a row this partner can actually see */
    const known = buildPartnerRows(doc.db || {}, partner).rows.some((r) => r.pid === pid);
    if (!known) return res.status(400).json({ error: "Unknown row." });
    const col = await partnerCommentsCollection();
    const entry = { partner, pid, text, author: author || "Partner", at: new Date().toISOString(), read: false };
    await col.insertOne(entry);
    return res.json({ ok: true, comment: { pid, text, author: entry.author, at: entry.at } });
  } catch (err) {
    console.error("POST /api/partner comment failed:", err.message);
    return res.status(502).json({ error: "Could not save that comment." });
  }
});

/* what the dashboard reads to show the comments back to you */
app.get("/api/partner-comments", async (req, res) => {
  if (!MONGODB_URI) return res.json({ ok: true, comments: [] });
  try {
    const col = await partnerCommentsCollection();
    const rows = await col.find({}).sort({ at: -1 }).limit(500).toArray();
    return res.json({ ok: true, comments: rows.map((c) => ({
      id: String(c._id), partner: c.partner, pid: c.pid, text: c.text, author: c.author, at: c.at, read: !!c.read })) });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

app.post("/api/partner-comments/read", async (req, res) => {
  try {
    const col = await partnerCommentsCollection();
    await col.updateMany({ read: { $ne: true } }, { $set: { read: true } });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

app.get("/partner/:token", (req, res) => {
  res.set("X-Robots-Tag", "noindex, nofollow");
  res.sendFile(path.join(__dirname, "partner.html"));
});

app.post("/api/signup", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");

  if (!name) return res.status(400).json({ error: "Nama wajib diisi" });
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Email tidak valid" });
  if (password.length < 8) return res.status(400).json({ error: "Password minimal 8 karakter" });

  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString()
  };

  try {
    const col = await getUsersCollection();
    if (col) {
      try {
        await col.insertOne(user);
      } catch (err) {
        if (err && err.code === 11000) {
          return res.status(409).json({ error: "Email sudah terdaftar" });
        }
        throw err;
      }
    } else {
      // no MONGODB_URI configured — fall back to the local (ephemeral) file
      const users = readUsers();
      if (users.some((u) => u.email === email)) {
        return res.status(409).json({ error: "Email sudah terdaftar" });
      }
      users.push(user);
      writeUsers(users);
    }
    return res.status(201).json({ ok: true, user: publicUser(user) });
  } catch (err) {
    console.error("POST /api/signup failed:", err.message);
    return res.status(502).json({ error: "Could not reach the database." });
  }
});

app.post("/api/login", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");

  if (!email || !password) {
    return res.status(400).json({ error: "Email dan password wajib diisi" });
  }

  try {
    const col = await getUsersCollection();
    const user = col ? await col.findOne({ email }) : readUsers().find((u) => u.email === email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: "Email atau password salah" });
    }
    return res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    console.error("POST /api/login failed:", err.message);
    return res.status(502).json({ error: "Could not reach the database." });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`VIVELY app listening on port ${PORT}`);
});
