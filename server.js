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
    default: return "";
  }
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
