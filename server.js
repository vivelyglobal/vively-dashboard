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

/* ------------------------------------------------------------------
   Instagram webhook.

   META_APP_SECRET signs every delivery; META_WEBHOOK_VERIFY_TOKEN is
   the string Meta echoes back once, when the subscription is first
   set up. The two INSTAGRAM_* values are not needed to RECEIVE an
   event — they are for fetching metrics later — so a missing one must
   not stop a webhook from being accepted.

   None of these are ever logged. read() exists so a stray copy-paste
   with whitespace does not silently produce a signature mismatch that
   looks like an attack.
   ------------------------------------------------------------------ */
const readEnv = (k) => String(process.env[k] || "").trim();
const META_APP_SECRET = readEnv("META_APP_SECRET");
const META_WEBHOOK_VERIFY_TOKEN = readEnv("META_WEBHOOK_VERIFY_TOKEN");
const INSTAGRAM_ACCESS_TOKEN = readEnv("INSTAGRAM_ACCESS_TOKEN");
const INSTAGRAM_ACCOUNT_ID = readEnv("INSTAGRAM_ACCOUNT_ID");

/* Two more secrets, DIAGNOSTIC ONLY.

   Meta shows a Basic app secret under App Settings, and an app using
   Instagram Login has a second, different Instagram app secret. A
   delivery carries nothing that says which app signed it, so when the
   signature fails there is no way to tell "wrong secret" from "wrong
   app" by looking at the request. Holding both candidates lets a
   refused delivery be tested against each, and the answer becomes a
   name instead of a guess.

   META_APP_SECRET remains the ONLY secret that decides accept or
   reject. Setting either of these changes nothing about what is
   accepted — a delivery signed with a candidate is still refused.
   Leaving them unset only means a refusal is reported without that
   extra detail. */
const META_APP_BASIC_SECRET = readEnv("META_APP_BASIC_SECRET");
const META_INSTAGRAM_APP_SECRET = readEnv("META_INSTAGRAM_APP_SECRET");
const SIGNATURE_CANDIDATES = { basic: META_APP_BASIC_SECRET, instagram: META_INSTAGRAM_APP_SECRET };
const HAVE_CANDIDATES = !!(META_APP_BASIC_SECRET || META_INSTAGRAM_APP_SECRET);

/* The collab diagnostic runs server-side so INSTAGRAM_ACCESS_TOKEN
   never has to leave Render. Nothing else on this API is authenticated,
   so this route carries its own key: without DIAGNOSTIC_KEY set it does
   not answer at all, which is the safe default for a route that spends
   our Meta rate limit and returns our media. */
const DIAGNOSTIC_KEY = readEnv("DIAGNOSTIC_KEY");
/* Points the probe at a stub instead of Meta, for the harness.

   Honoured only outside production, and only for a loopback address.
   As written before, this was an environment variable that could send
   the Instagram access token to any host on the internet — anyone who
   could set it on the service could exfiltrate the token without ever
   reading it. That someone with Render access can already read the
   token is not a reason to leave a second, quieter route open. */
const IG_PROBE_BASE = (() => {
  const raw = readEnv("IG_PROBE_BASE");
  if (!raw) return "";
  if (process.env.NODE_ENV === "production") {
    console.error("IG_PROBE_BASE is set but ignored: it is not honoured in production.");
    return "";
  }
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(raw.replace(/\/$/, ""))) {
    console.error("IG_PROBE_BASE is set but ignored: only a loopback address is accepted.");
    return "";
  }
  return raw;
})();

const igWebhook = require("./server/instagram-webhook.js");
const wsGuard = require("./server/workspace-guard.js");
const igCollabProbe = require("./server/instagram-collab-probe.js");
const auth = require("./server/auth.js");
const bookingStore = require("./server/booking-store.js");
const bookingRoutes = require("./server/booking-routes.js");
const sheetProxy = require("./server/sheet-proxy.js");

/* ------------------------------------------------------------------
   Who is allowed into the workspace.

   Signup was open to the internet, so the accounts that exist are not
   by themselves a list of who should see the roster — "has an account"
   and "may read bank details" are different questions.
   STAFF_EMAILS answers the second one, and lives in the environment
   precisely so that nothing inside the app can grant it.

   Both of these fail closed. An unset STAFF_EMAILS locks everyone out
   rather than letting everyone in, and an unset SIGNUP_CODE closes
   signup rather than leaving it open; each says so plainly when it
   refuses, because a silent lockout is its own kind of outage.
   ------------------------------------------------------------------ */
const STAFF_EMAILS = auth.parseStaffList(readEnv("STAFF_EMAILS"));
const SIGNUP_CODE = readEnv("SIGNUP_CODE");
if (!STAFF_EMAILS.length) {
  console.error("STAFF_EMAILS is not set — the workspace API will refuse every request. " +
    "Set it to the comma-separated emails of the people who should have access.");
} else {
  /* the count, not the addresses: enough to catch a value that parsed
     into fewer people than intended, without printing a staff list into
     logs that outlive the deploy */
  console.log("STAFF_EMAILS: %d address(es) authorised.", STAFF_EMAILS.length);
  const rejects = auth.staffListRejects(readEnv("STAFF_EMAILS"));
  if (rejects.length) {
    console.error("STAFF_EMAILS: %d entr(ies) were not usable as an email address and were ignored. " +
      "Check for typos or stray characters.", rejects.length);
  }
}

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
        /* the booking indexes, and in particular the two partial unique
           ones that make "one confirmed booking per creator per campaign"
           the database's rule rather than a race this code has to win */
        await bookingRoutes.ensureBookingIndexes(c, MONGODB_DB);
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
/* overridable so the test harness can point at a local stand-in; unset in
   production, which is every deployment that does not say otherwise */
const NOTION_API = process.env.NOTION_API || "https://api.notion.com/v1";

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

/* ------------------------------------------------------------------
   Sessions.

   Stored server-side and keyed by an unguessable cookie, so signing
   out actually ends the session and a stolen laptop stops working when
   the record expires. Without a database there is an in-memory map so
   the harness can exercise the same code path; it is not what
   production runs on and the process forgets it on restart.
   ------------------------------------------------------------------ */
const sessionMemory = new Map();

async function sessionsCollection() {
  const client = await getMongoClient();
  if (!client) return null;
  const col = client.db(MONGODB_DB).collection("sessions");
  if (!sessionsCollection._ready) {
    sessionsCollection._ready = true;
    col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
      .catch((e) => console.error("sessions TTL index:", e.message));
  }
  return col;
}

async function createSession(user) {
  const session = auth.newSession(user);
  const col = await sessionsCollection();
  if (col) await col.insertOne(session);
  else sessionMemory.set(session._id, session);
  return session;
}

async function readSession(sid) {
  if (!sid) return null;
  const col = await sessionsCollection();
  const session = col ? await col.findOne({ _id: sid }) : sessionMemory.get(sid) || null;
  /* expiry is checked here as well as by the TTL index: the index
     sweeps on a timer, and an expired session has to be refused the
     moment it expires rather than whenever Mongo next gets round to it */
  if (!session || auth.sessionExpired(session)) return null;
  return session;
}

async function destroySession(sid) {
  if (!sid) return;
  const col = await sessionsCollection();
  if (col) await col.deleteOne({ _id: sid });
  else sessionMemory.delete(sid);
}

/* Attaches req.session and req.user when the caller has a valid one.
   Never refuses anything by itself — the guards below decide. */
async function loadSession(req) {
  if (req.session !== undefined) return req.session;
  const sid = auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
  let session = null;
  try { session = await readSession(sid); } catch (e) {
    console.error("Session lookup failed:", e.message);
  }
  req.session = session;
  return session;
}

/* The guard. Two questions, refused differently on purpose: a caller
   with no session gets 401 and the dashboard shows the login screen; a
   caller who is signed in but is not staff gets 403, because logging
   in again will not help them and pretending otherwise would send a
   creator round a loop they cannot exit. */
function requireStaff(handler) {
  return async (req, res) => {
    const session = await loadSession(req);
    if (!session) {
      return res.status(401).json({ error: "Sign in to continue.", auth: "required" });
    }
    if (!auth.isStaff(session.email, STAFF_EMAILS)) {
      console.error("Workspace access refused for a signed-in non-staff account.");
      return res.status(403).json({
        error: STAFF_EMAILS.length
          ? "This account does not have access to the workspace."
          : "Access has not been configured on this server yet.",
        auth: "forbidden"
      });
    }
    return handler(req, res);
  };
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt
  };
}

/* The signature is an HMAC over the bytes Meta actually sent, so this
   one path keeps its raw Buffer. It has to be registered BEFORE the
   global JSON parser below: once express.json() has run, the original
   bytes are gone and re-serialising req.body yields different ones —
   a check written that way passes hand-made test payloads and fails
   real traffic. body-parser skips a request whose body is already
   set, so nothing downstream double-parses. */
app.use("/api/webhooks/instagram", express.raw({ type: "*/*", limit: "1mb" }));

/* The partner comment route is unauthenticated, so its body is capped at 8 KB
   by its own parser, registered BEFORE the global 10 MB one. body-parser
   enforces the limit while reading, so a chunked body (no content-length) is
   cut off too, and the global parser then skips a request already parsed. */
const partnerCommentParser = express.json({ limit: "8kb" });
app.use("/api/partner/:token/comment", (req, res, next) => {
  partnerCommentParser(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.type === "entity.too.large" || err.status === 413;
    res.status(tooBig ? 413 : 400).json({ error: tooBig ? "That comment is too large." : "That request could not be read." });
  });
});

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

/* express.static(__dirname) serves the repo root, which is where the server
   source, tests, tools, docs and render.yaml live. The files stay where they
   are (moving them is a production change), so the request path is checked
   here, first, and anything unusual is refused.

   The raw path is decoded ONCE (what express.static does), then refused if it
   was malformed, held a backslash or NUL, or has a "." / ".." segment, which
   a browser never sends but a script does ("/./server.js", "/x/../server.js").
   EVERY segment, not just the first, is then compared with the deny set,
   lowercased and with trailing dots and spaces stripped (Windows and macOS
   disks ignore them), and any dotfile segment is refused. The name check is
   skipped under /api/, whose segments are ids and tokens that static never
   sees; the malformed and dot-segment checks still apply there.

   This is deny-by-segment, not an allow-list: a new top-level file or folder
   is public until it is added here. An allow-list was not done because the
   served set (index.html, partner.html, book.html, dist/, and whatever else
   a deployed page links) cannot be proven complete without a browser run, and
   a wrong list breaks production. The proper fix is a public/ folder. */
const STATIC_DENY_SEGMENT = new Set(["server.js", "server", "tests", "tools", "docs", "src", "data", "tmp",
  "node_modules", "_to_delete", "architecture.md", "readme.md", "render.yaml", "package.json",
  "package-lock.json", "vite.config.mjs"]);
function staticDenied(rawPath) {
  let p = String(rawPath || "");
  try { p = decodeURIComponent(p); } catch (e) { return true; }
  if (p.indexOf("\\") !== -1 || p.indexOf("\0") !== -1) return true;
  const segs = p.split("/").filter((s) => s !== "");           /* "//" is harmless */
  if (segs.some((s) => s === "." || s === "..")) return true;
  if (segs[0] === "api") return false;
  return segs.some((seg) => {
    const norm = seg.toLowerCase().replace(/[. ]+$/, "");
    /* ":" is refused too: NTFS alternate data streams (/server.js::$DATA) */
    return seg.charAt(0) === "." || seg.indexOf(":") !== -1 || norm === "" || STATIC_DENY_SEGMENT.has(norm);
  });
}
app.use((req, res, next) => {
  if (staticDenied(req.path)) return res.status(404).type("text/plain").send("Not found");
  next();
});

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

app.get("/api/workspace", requireStaff(async (req, res) => {
  if (!MONGODB_URI) {
    return res.status(503).json({ error: "Database not configured on the server yet — set MONGODB_URI." });
  }
  try {
    const col = await getWorkspaceCollection();
    const doc = await col.findOne({ _id: WORKSPACE_ID });
    if (!doc) return res.json({ ok: true, data: null });

    /* The same projection the save path applies, applied on the way out
       as well. A booking owns the time it booked, and the stored
       workspace only learns about a move the next time somebody's save
       goes through — so a staff move, or a creator rebooking, was
       invisible on a reload until then: the roster, the visit calendar
       and the day sheet all kept showing the old time. Projecting here
       makes every load tell the truth whoever saved last. Read-only: the
       next save writes it down. */
    let bookingFixes = null;
    if (bookingApi && doc.db) {
      try {
        const applied = bookingStore.applyBookingSlots(doc.db, await bookingApi.liveBookings());
        if (applied.corrected.length || applied.cleared.length || applied.linked) bookingFixes = applied;
      } catch (err) {
        console.error("Booking projection skipped on this load:", err.message);
      }
    }

    return res.json({
      ok: true,
      data: { db: doc.db, settings: doc.settings || {}, savedAt: doc.savedAt, revision: doc.revision || 0 },
      bookings: bookingFixes
    });
  } catch (err) {
    console.error("GET /api/workspace failed:", err.message);
    return res.status(502).json({ error: "Could not reach the database." });
  }
}));

/* Just the revision and the time, for a page that wants to know whether
   somebody else has saved since it loaded. The workspace itself is far
   too big to poll — this reads two fields and nothing else. */
app.get("/api/workspace/meta", requireStaff(async (req, res) => {
  if (!MONGODB_URI) return res.status(503).json({ error: "Database not configured on the server yet." });
  try {
    const col = await getWorkspaceCollection();
    const doc = await col.findOne({ _id: WORKSPACE_ID }, { projection: { revision: 1, savedAt: 1, savedBy: 1 } });
    return res.json({ ok: true, revision: (doc && doc.revision) || 0, savedAt: (doc && doc.savedAt) || null,
                      savedBy: (doc && doc.savedBy) || null });
  } catch (err) {
    console.error("GET /api/workspace/meta failed:", err.message);
    return res.status(502).json({ error: "Could not reach the database." });
  }
}));

/* Set when the booking routes mount. The workspace save reads live
   bookings through it so a stale client cannot un-book anybody. */
let bookingApi = null;

app.post("/api/workspace", requireStaff(async (req, res) => {
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
    /* $size rather than the document: this only needs to know whether
       anything is in there, and the document is half a megabyte. */
    const existing = await col.findOne({ _id: WORKSPACE_ID }, { projection: {
      revision: 1, savedAt: 1,
      campaigns: { $size: { $ifNull: ["$db.campaigns", []] } },
      creators: { $size: { $ifNull: ["$db.creators", []] } },
      participants: { $size: { $ifNull: ["$db.participants", []] } }
    } });
    const currentRevision = (existing && existing.revision) || 0;

    /* Checked before the revision lock, and independently of `force`.
       A caller saying "overwrite their version with mine" is not the
       same as a caller saying "discard the whole workspace", and until
       now one flag answered both. */
    const guard = wsGuard.guardEmptyReplace({
      incoming: db,
      existing: existing || {},
      intent: req.body && req.body.intent
    });
    if (!guard.ok) {
      console.error("POST /api/workspace refused: empty payload over %d campaigns, %d creators, %d participants.",
        guard.existing.campaigns, guard.existing.creators, guard.existing.participants);
      return res.status(422).json({ error: guard.message, guard: guard.code, existing: guard.existing });
    }
    if (guard.reset) {
      console.log("POST /api/workspace: explicit destructive reset requested; the workspace will be emptied.");
    }

    if (existing && !force && clientRevision !== currentRevision) {
      return res.status(409).json({
        error: "This workspace was saved from elsewhere since you last loaded it.",
        revision: currentRevision,
        savedAt: existing.savedAt
      });
    }

    /* A booking owns the time it booked. This client's copy may predate
       it — and `force` skips the revision check entirely — so every live
       booking is re-applied onto the payload on the way in rather than
       trusted out of it. Corrections are reported back so the open
       dashboard can stop showing a time that is no longer true. */
    let bookingFixes = null;
    if (bookingApi) {
      try {
        const live = await bookingApi.liveBookings();
        const applied = bookingStore.applyBookingSlots(db, live);
        if (applied.corrected.length || applied.cleared.length || applied.linked) bookingFixes = applied;
      } catch (err) {
        /* a booking lookup that fails must not cost somebody their save */
        console.error("Booking projection skipped on this save:", err.message);
      }
    }

    /* Partner-link housekeeping, decided here and not in whichever browser
       saved: a stable clientId on each link and on the campaigns it covers,
       an expiry, and a revoked link stays revoked even if a stale browser
       sends it back without the flag. */
    const storedLinks = await col.findOne({ _id: WORKSPACE_ID }, { projection: { "db.partnerLinks": 1 } });
    const stamped = stampPartnerClients(db, storedLinks && storedLinks.db && storedLinks.db.partnerLinks,
      { ttlDays: PARTNER_LINK_TTL_DAYS });
    if (stamped.revokedKept) console.warn("POST /api/workspace: kept %d revoked partner link(s) revoked.", stamped.revokedKept);

    const savedAt = new Date().toISOString();
    const nextRevision = currentRevision + 1;
    await col.updateOne(
      { _id: WORKSPACE_ID },
      { $set: { db, settings: req.body.settings || {}, savedAt, revision: nextRevision } },
      { upsert: true }
    );
    return res.json({ ok: true, savedAt, revision: nextRevision, bookings: bookingFixes });
  } catch (err) {
    console.error("POST /api/workspace failed:", err.message);
    return res.status(502).json({ error: "Could not reach the database." });
  }
}));

/* ---------------------------- notion sync ---------------------------- */

app.get("/api/notion/database", requireStaff(async (req, res) => {
  if (!NOTION_TOKEN) {
    return res.status(503).json({ error: "Notion is not configured on the server yet — set NOTION_TOKEN." });
  }
  const rawId = normalizeNotionId(req.query.id);
  if (!rawId) return res.status(400).json({ error: "That doesn't look like a Notion database link or ID." });
  try {
    const dataSourceId = await resolveDataSourceId(rawId);
    const ds = await notionFetch("/data_sources/" + dataSourceId);
    const properties = Object.entries(ds.properties || {}).map(([name, def]) => {
      const prop = { name, type: def.type };
      /* the allowed values of a status or select column. Writing back needs
         them: Notion rejects a value that is not already an option, and the
         options are per-database even when every form looks the same. */
      if (def.type === "status") prop.options = Object.values(def.status?.groups || {})
        .flat().map((o) => o.name).filter(Boolean);
      else if (def.type === "select") prop.options = (def.select?.options || []).map((o) => o.name);
      if (prop.options) prop.options = [...new Set(prop.options)];
      return prop;
    });
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
}));

app.get("/api/notion/query", requireStaff(async (req, res) => {
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
}));

/* ---------------------------- google calendar ---------------------------- */

/* client_email is deliberately returned: it is not a secret, and it is the
   exact string that has to be pasted into the calendar's sharing settings.
   Showing it in the app saves digging the JSON key back out. */
app.get("/api/calendar/status", requireStaff(async (req, res) => {
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
}));

app.get("/api/calendar/events", requireStaff(async (req, res) => {
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
}));

/* Create-or-update, keyed on an id the dashboard chooses. Creating with a
   known id is what makes a repeated sync land on the same event instead of
   a second copy; if Google says that id is taken, this patches it rather
   than failing, so re-running the sync is always safe. */
app.post("/api/calendar/event", requireStaff(async (req, res) => {
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
}));

app.post("/api/calendar/event/delete", requireStaff(async (req, res) => {
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
}));

/* Writes one probe event and removes it again, so "is this wired up
   correctly?" has a real answer instead of a hopeful one. */
app.post("/api/calendar/test", requireStaff(async (req, res) => {
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
}));

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
  /* A rejection is not a roster entry. `hidden` keeps these off the
     partner view entirely — 브랜드 거절 and 거절 alike — so a partner
     browsing their link sees who is coming, not a list of the people who
     were turned down or who said no. Withheld at the source, so the names
     are not in the response for anyone to find in devtools either. */
  "brand rejected":   { ko: "브랜드 거절", en: "Brand Rejected", tone: "red", hidden: true },
  "declined":         { ko: "거절", en: "Refused", tone: "grey", hidden: true },
  "cancelled":        { ko: "거절", en: "Refused", tone: "grey", hidden: true },
  "canceled":         { ko: "거절", en: "Refused", tone: "grey", hidden: true },
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
  dropped:     { ko: "거절", en: "Refused", tone: "grey", hidden: true }
};

/* Two reasons a row never reaches the partner, and they are different
   things: `theirs` is still waiting on their own decision, `hidden` has
   been decided against. Both are withheld; keeping them apart means the
   withheld count still explains itself. */
function partnerWithholds(st) {
  return !!(st && (st.theirs || st.hidden));
}

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

/* ---- partner link: lookup, expiry, tenant key ---------------------------

   A link is a bearer credential, so three things are enforced HERE, on the
   server, and never trusted from the browser that stored the link:
     - it must not be revoked, and must not be past `expiresAt`;
     - the token is compared in constant time, over every link (no early exit);
     - the tenant is `clientId`, an opaque id minted by the server, not the
       free-text `partner` label (a typo or rename used to merge tenants).

   A link may carry `tokenHash` (sha256 hex of the token) instead of the
   plaintext `token`; both are accepted. The staff dashboard still stores and
   copies the plaintext token today, so nothing is hashed automatically. */
const PARTNER_TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function digestEq(aHex, bHex) {
  const a = Buffer.from(String(aHex), "hex"), b = Buffer.from(String(bHex), "hex");
  return a.length === 32 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* Returns { partner, clientId, legacy } for a live link, else null. The
   caller gets the same null for unknown, revoked and expired, so the page
   cannot be used to ask which of the three it was. `now` is injectable so
   expiry is testable. */
function resolvePartnerToken(doc, token, now) {
  if (typeof token !== "string" || !PARTNER_TOKEN_RE.test(token)) return null;
  const links = (doc && doc.db && doc.db.partnerLinks) || [];
  const want = sha256Hex(token);
  const at = typeof now === "number" ? now : Date.now();
  let hit = null;
  for (const l of links) {           /* every link, every time: no early exit */
    if (!l) continue;
    const have = l.tokenHash || (typeof l.token === "string" ? sha256Hex(l.token) : "");
    if (digestEq(want, have) && !hit) hit = l;
  }
  if (!hit || hit.revokedAt) return null;
  /* a link with no label would otherwise match every campaign that has no
     partner (the internal ones), so it is not a usable link at all */
  if (typeof hit.partner !== "string" || !hit.partner.trim()) return null;
  if (hit.expiresAt) {
    const t = Date.parse(hit.expiresAt);
    if (!Number.isFinite(t) || t <= at) return null;   /* unreadable date fails closed */
  }
  return { partner: hit.partner || "", clientId: hit.clientId || "", legacy: !hit.clientId };
}

/* Run on every staff save, server-side, so the tenant key does not depend on
   which browser saved. It never invents access: it only (a) gives each link
   a stable clientId, (b) stamps that id onto the campaigns whose label
   already equals the link's label and which have no clientId yet, (c) gives a
   link without an expiry one, and (d) refuses to let a stale browser un-revoke
   a link the stored workspace already has revoked. `stored` is the links
   currently in Mongo. */
function stampPartnerClients(db, stored, opts) {
  opts = opts || {};
  const ttlMs = (opts.ttlDays || 90) * 86400000;
  const nowMs = typeof opts.now === "number" ? opts.now : Date.now();
  const mint = opts.mint || (() => "cl_" + crypto.randomBytes(12).toString("base64url"));
  const links = Array.isArray(db.partnerLinks) ? db.partnerLinks : [];
  const prior = Array.isArray(stored) ? stored : [];
  const keyOf = (l) => l.tokenHash || (l.token ? sha256Hex(l.token) : "");
  const priorByKey = new Map(prior.filter(Boolean).map((l) => [keyOf(l), l]));
  const clientByLabel = new Map();
  [...prior, ...links].forEach((l) => {
    if (l && l.partner && l.clientId && !clientByLabel.has(l.partner)) clientByLabel.set(l.partner, l.clientId);
  });
  const out = { clientIds: 0, expiries: 0, revokedKept: 0, campaigns: 0 };
  links.forEach((l) => {
    if (!l || !l.partner) return;
    const was = priorByKey.get(keyOf(l));
    if (was && was.revokedAt && !l.revokedAt) { l.revokedAt = was.revokedAt; out.revokedKept++; }
    /* a browser that loaded before these fields existed sends the link back
       without them; the stored values win, or every save would re-mint the
       id and push the expiry out another 90 days */
    if (was && was.clientId && !l.clientId) l.clientId = was.clientId;
    if (was && was.expiresAt && !l.expiresAt) l.expiresAt = was.expiresAt;
    if (!l.clientId) {
      if (!clientByLabel.has(l.partner)) clientByLabel.set(l.partner, mint());
      l.clientId = clientByLabel.get(l.partner);
      out.clientIds++;
    }
    if (!l.expiresAt && !l.revokedAt) {
      l.expiresAt = new Date(nowMs + ttlMs).toISOString();
      out.expiries++;
    }
  });
  const liveLabels = new Set(links.filter((l) => l && l.partner && !l.revokedAt).map((l) => l.partner));
  (db.campaigns || []).forEach((c) => {
    if (!c || c.clientId || !c.partner || !liveLabels.has(c.partner)) return;
    c.clientId = clientByLabel.get(c.partner);
    out.campaigns++;
  });
  return out;
}

/* The slot the visit actually happens at, server-side.

   This has to agree with visitSlotOf() in the dashboard, and it did
   not: the browser was updated to prefer the confirmed time and this
   was left reading the creator's original request, so a time someone
   confirmed by hand never reached the partner. Two copies of one rule,
   and only one of them changed.

   A partner is booking a table. What they need is the time that was
   agreed, not the time that was asked for. */
function partnerVisitSlot(p) {
  return String((p && (p.confirmedVisitAt || p.visitAt)) || "").trim();
}

/* A published post used to hang off the roster row. It now lives in
   db.socialContent, so this reads there first and falls back to the
   old shape — a workspace saved before that change still has to render. */
function partnerContentUrl(db, p) {
  const lib = (db && db.socialContent) || [];
  const rec = lib.find((c) => c && c.participantId === p.id);
  if (rec && (rec.url || rec.postUrl)) return rec.url || rec.postUrl;
  return (p.content && p.content.url) || "";
}

/* The ONLY fields that may leave on a partner row. The row is built, then
   passed through this list, so a field added to the builder by mistake still
   does not ship. Deliberately NOT here: email, phone / Kakao, address, gender,
   nationality, payout, fee, note, otherSns, formNotes, creatorId and any
   Notion url. To widen what a brand sees, add a name here and in the leak
   test (tests/partner.test.mjs) in the same change. */
const PARTNER_ROW_FIELDS = ["pid", "campaign", "creator", "handle", "igUrl", "visitDate", "visitTime",
  "status", "followers", "remark", "headcount", "contentUrl"];
const PARTNER_CAMPAIGN_FIELDS = ["id", "brand", "name", "start", "end"];
const PARTNER_STATUS_FIELDS = ["key", "ko", "en", "tone"];

function pickFields(obj, fields) {
  const o = {};
  fields.forEach((k) => { if (obj[k] !== undefined) o[k] = obj[k]; });
  return o;
}

/* Only http(s) links leave: a stored "javascript:" value must not become an
   href on a brand's screen. */
function partnerSafeUrl(u) {
  const s = String(u || "").trim();
  return /^https?:\/\//i.test(s) ? s : "";
}

/* clientId is the tenant key. When given, a campaign belongs to this link
   only if its own clientId is the same AND its label still matches, so a
   renamed, retyped or cleared label hides the campaign instead of moving it
   to someone else. When absent (a legacy link not yet stamped by a staff
   save) it falls back to the label alone, which is the old behaviour. */
function buildPartnerRows(db, partner, clientId) {
  const byCreator = Object.fromEntries((db.creators || []).map((c) => [c.id, c]));
  const byCampaign = Object.fromEntries((db.campaigns || []).map((c) => [c.id, c]));
  const all = db.campaigns || [];
  /* Fail safe on a data bug rather than through it. Two campaigns sharing an
     id used to be possible, and if the two belong to different partners then
     an id is no longer enough to say whose a roster row is — so a contested
     id is dropped from BOTH partners' views. Showing nothing is recoverable;
     showing one partner another's creators is not. */
  const owners = {};
  all.forEach((c) => { (owners[c.id] = owners[c.id] || new Set()).add((c.clientId || "") + "|" + (c.partner || "")); });
  const contested = new Set(Object.keys(owners).filter((id) => owners[id].size > 1));

  /* an empty label never matches: "" would equal every unassigned campaign */
  const isMine = (c) => !partner ? false : clientId
    ? c.clientId === clientId && (c.partner || "") === partner
    : (c.partner || "") === partner;
  const mine = all.filter((c) => isMine(c) && !contested.has(c.id));
  const ids = new Set(mine.map((c) => c.id));

  /* A creator still awaiting brand approval is not shown at all. They are a
     proposal, not a booking, and the partner sees the roster once it is
     settled. Filtered HERE rather than in the page, so an unapproved creator
     is never in the response for anyone to find in devtools. */
  const rows = (db.participants || []).filter((p) => ids.has(p.campaignId))
    .filter((p) => !partnerWithholds(partnerStatusOf(p)))
    .map((p) => {
    const cr = byCreator[p.creatorId] || {};
    const cp = byCampaign[p.campaignId] || {};
    const st = partnerStatusOf(p);
    const m = partnerVisitSlot(p).match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}:\d{2}))?/);
    const handle = cr.handle || "";
    const handleBare = String(handle).replace(/^@/, "");
    const fol = Number(cr.followers);
    return pickFields({
      pid: p.id,
      campaign: cp.brand || "",
      creator: p.fullName || cr.name || handle,   /* name is shown today; see report: founder decision */
      handle,
      igUrl: handleBare ? "https://www.instagram.com/" + encodeURIComponent(handleBare) + "/" : "",
      visitDate: m ? m[1] : "",
      visitTime: m && m[2] ? m[2] : "",
      status: pickFields(st, PARTNER_STATUS_FIELDS),
      followers: Number.isFinite(fol) && fol > 0 ? fol : 0,
      remark: p.remark || "",
      headcount: p.headcount || "",
      contentUrl: partnerSafeUrl(partnerContentUrl(db, p))
    }, PARTNER_ROW_FIELDS);
  });

  rows.sort((a, b) => (a.visitDate || "9999").localeCompare(b.visitDate || "9999") ||
                      (a.visitTime || "").localeCompare(b.visitTime || "") ||
                      a.creator.localeCompare(b.creator));
  const withheld = (db.participants || []).filter((p) => ids.has(p.campaignId))
    .filter((p) => partnerWithholds(partnerStatusOf(p))).length;
  return { partner, withheld, contested: [...contested],
    campaigns: mine.map((c) => pickFields(c, PARTNER_CAMPAIGN_FIELDS)), rows };
}

async function partnerCommentsCollection() {
  const client = await getMongoClient();
  if (!client) return null;
  return client.db(MONGODB_DB).collection("partner_comments");
}

/* The partner page and API carry a bearer token in the URL, so none of it may
   be cached, framed, indexed or leaked through a Referer header. Applied to
   the error responses too, because it is set before the route runs.
   "/api/partner" matches "/api/partner/..." only, not the staff
   "/api/partner-comments". */
function partnerHeaders(req, res, next) {
  res.set({
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow"
  });
  next();
}
app.use("/api/partner", partnerHeaders);
app.use("/partner", partnerHeaders);

/* Same limiter the booking routes use (in memory: right for one Render
   instance). Per IP first, then per token, so one link cannot be hammered
   from many addresses and one address cannot hammer many links. The token
   key is a hash, so no token sits in memory or in a log. The IP comes from
   x-forwarded-for exactly as booking-routes.js does, which a caller can
   spoof; the per-token limit is the backstop that does not depend on it. */
const partnerReadIp = bookingRoutes.rateLimiter({ windowMs: 60000, max: 60 });
const partnerReadTok = bookingRoutes.rateLimiter({ windowMs: 60000, max: 30 });
const partnerWriteIp = bookingRoutes.rateLimiter({ windowMs: 60000, max: 20 });
const partnerWriteTok = bookingRoutes.rateLimiter({ windowMs: 60000, max: 10 });
const PARTNER_LINK_TTL_DAYS = Math.min(365, Math.max(1, Number(process.env.PARTNER_LINK_TTL_DAYS) || 90));
const PARTNER_AUTHOR_MAX = 60;
const PARTNER_TEXT_MAX = 1500;

/* The caller's address for the limiter. x-forwarded-for is "client-supplied
   entries..., then one entry appended by each proxy we trust", so the FIRST
   entry is whatever the caller typed and is never used. We count from the
   RIGHT: with N trusted proxy hops (PARTNER_PROXY_HOPS, default 1: Render's
   edge appends the address it saw) the entry N from the end is the first one
   a proxy of ours vouched for. No header, or fewer entries than hops, means
   the request did not come through the proxy, so the socket address is used.
   Not set app-wide with app.set("trust proxy"), because that also changes
   req.secure / req.protocol, which the login cookie code decides on.
   ASSUMED: one hop. render.yaml and docs do not state Render's chain; if
   there is a second hop in front, every caller shares one bucket (over-
   limiting, never under-limiting) until PARTNER_PROXY_HOPS is raised. */
const PARTNER_PROXY_HOPS = Math.min(5, Math.max(1, Math.floor(Number(process.env.PARTNER_PROXY_HOPS)) || 1));
function partnerClientIp(req) {
  const parts = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const sock = (req.socket && req.socket.remoteAddress) || "unknown";
  if (parts.length >= PARTNER_PROXY_HOPS) return parts[parts.length - PARTNER_PROXY_HOPS].slice(0, 64);
  return sock;
}

/* true (and answered) when the caller is over a limit */
function partnerLimited(req, res, ipLimit, tokLimit) {
  const ok = ipLimit("p|" + partnerClientIp(req)) &&
    (!PARTNER_TOKEN_RE.test(String(req.params.token || "")) ||
     tokLimit("p|" + sha256Hex(req.params.token).slice(0, 24)));
  if (ok) return false;
  res.set("Retry-After", "60");
  res.status(429).json({ error: "Too many requests. Please wait a minute and try again." });
  return true;
}

/* one clean text field: a string, no control characters, capped */
function partnerClean(v, max) {
  return typeof v === "string" ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max) : "";
}

app.get("/api/partner/:token", async (req, res) => {
  if (partnerLimited(req, res, partnerReadIp, partnerReadTok)) return;
  if (!MONGODB_URI) return res.status(503).json({ error: "Not configured." });
  try {
    const doc = await loadWorkspaceDoc();
    const link = resolvePartnerToken(doc, req.params.token);
    if (!link) return res.status(404).json({ error: "This link is not valid, or has been turned off." });
    if (link.legacy) console.warn("Partner link served on the label only (no clientId yet): save the workspace once from the dashboard.");
    const payload = buildPartnerRows(doc.db || {}, link.partner, link.clientId);
    const col = await partnerCommentsCollection();
    /* comments follow the tenant key too; ones written before clientId existed
       are matched on the label, as they always were */
    const mine = link.clientId
      ? { $or: [{ clientId: link.clientId }, { partner: link.partner, clientId: { $exists: false } }] }
      : { partner: link.partner };
    const comments = col ? await col.find(mine).sort({ at: 1 }).limit(1000).toArray() : [];
    const visible = new Set(payload.rows.map((r) => r.pid));
    payload.comments = comments.filter((c) => visible.has(c.pid))
      .map((c) => ({ pid: c.pid, text: c.text, author: c.author, at: c.at }));
    payload.updatedAt = doc.savedAt || null;
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
  if (partnerLimited(req, res, partnerWriteIp, partnerWriteTok)) return;
  if (!MONGODB_URI) return res.status(503).json({ error: "Not configured." });
  if (Number(req.headers["content-length"] || 0) > 8192) {
    return res.status(413).json({ error: "That comment is too large." });
  }
  const b = req.body || {};
  const text = partnerClean(b.text, PARTNER_TEXT_MAX);
  const pid = partnerClean(b.pid, 120);
  const author = partnerClean(b.author, PARTNER_AUTHOR_MAX);
  if (!text || !pid) return res.status(400).json({ error: "A comment and a row are both required." });
  try {
    const doc = await loadWorkspaceDoc();
    const link = resolvePartnerToken(doc, req.params.token);
    if (!link) return res.status(404).json({ error: "This link is not valid, or has been turned off." });
    /* only against a row this partner can actually see */
    const known = buildPartnerRows(doc.db || {}, link.partner, link.clientId).rows.some((r) => r.pid === pid);
    if (!known) return res.status(400).json({ error: "Unknown row." });
    const col = await partnerCommentsCollection();
    const entry = { partner: link.partner, pid, text, author: author || "Partner", at: new Date().toISOString(), read: false };
    if (link.clientId) entry.clientId = link.clientId;
    await col.insertOne(entry);
    return res.json({ ok: true, comment: { pid, text, author: entry.author, at: entry.at } });
  } catch (err) {
    console.error("POST /api/partner comment failed:", err.message);
    return res.status(502).json({ error: "Could not save that comment." });
  }
});

/* what the dashboard reads to show the comments back to you */
app.get("/api/partner-comments", requireStaff(async (req, res) => {
  if (!MONGODB_URI) return res.json({ ok: true, comments: [] });
  try {
    const col = await partnerCommentsCollection();
    const rows = await col.find({}).sort({ at: -1 }).limit(500).toArray();
    return res.json({ ok: true, comments: rows.map((c) => ({
      id: String(c._id), partner: c.partner, pid: c.pid, text: c.text, author: c.author, at: c.at, read: !!c.read })) });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}));

app.post("/api/partner-comments/read", requireStaff(async (req, res) => {
  try {
    const col = await partnerCommentsCollection();
    await col.updateMany({ read: { $ne: true } }, { $set: { read: true } });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}));

app.get("/partner/:token", (req, res) => {
  res.sendFile(path.join(__dirname, "partner.html"));
});

/* The creator's booking page. Three shapes, one file — the page reads
   the token off the last path segment and the API resolves which kind it
   is, so the difference never has to be encoded twice.

     /book/i/<inviteToken>     one named creator, pre-filled
     /book/<publicToken>       anyone with the campaign link
     /book/manage/<token>      an existing booking, to move or cancel

   Declared before the "/book/:token" catch so "i" and "manage" are not
   mistaken for tokens. */
app.get(["/book/i/:token", "/book/manage/:token", "/book/:token"], (req, res) => {
  res.set("X-Robots-Tag", "noindex, nofollow");
  res.sendFile(path.join(__dirname, "book.html"));
});

/* Writing a status back to Notion.

   The dashboard has always read from Notion. This is the one place it
   writes, and it writes exactly one property on one page — never a whole
   row, never a page it was not handed the id for.

   A status column can be Notion's "status" type or an ordinary "select",
   and the two take different shapes. The type is not stored alongside the
   mapping, so this tries the likely one and falls back rather than making
   an extra schema call before every write. */
app.post("/api/notion/status", requireStaff(async (req, res) => {
  if (!NOTION_TOKEN) return res.status(503).json({ error: "Notion is not configured on the server yet." });
  const b = req.body || {};
  const pageId = normalizeNotionId(b.pageId);
  const property = String(b.property || "").trim();
  const value = String(b.value || "").trim();
  if (!pageId || !property || !value) {
    return res.status(400).json({ error: "pageId, property and value are all required." });
  }

  const attempt = (shape) => notionFetch("/pages/" + pageId, {
    method: "PATCH",
    body: JSON.stringify({ properties: { [property]: shape } })
  });

  try {
    await attempt({ status: { name: value } });
    return res.json({ ok: true, wrote: value, as: "status" });
  } catch (err) {
    try {
      await attempt({ select: { name: value } });
      return res.json({ ok: true, wrote: value, as: "select" });
    } catch (err2) {
      console.error("POST /api/notion/status failed:", err.message, "|", err2.message);
      /* the first error is the useful one — the second is only a fallback */
      return res.status(502).json({ error: err.message });
    }
  }
}));

app.post("/api/signup", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");

  /* Signup used to be open to anyone who found the URL. An account no
     longer grants access on its own, but leaving the door open invites
     confusion, so it now needs a code. Unset means closed. */
  if (!SIGNUP_CODE) {
    return res.status(403).json({ error: "Signup is closed on this server." });
  }
  if (String(req.body?.code || "") !== SIGNUP_CODE) {
    return res.status(403).json({ error: "That signup code is not right." });
  }

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
    /* deliberately no session: a new account still has to sign in, and
       still has to be in STAFF_EMAILS to see anything */
    return res.status(201).json({ ok: true, user: publicUser(user) });
  } catch (err) {
    console.error("POST /api/signup failed:", err.message);
    return res.status(502).json({ error: "Could not reach the database." });
  }
});

/* The dashboard asks this on boot instead of trusting what it put in
   localStorage, which is the only way the browser can know whether the
   session is still real. */
app.get("/api/me", async (req, res) => {
  const session = await loadSession(req);
  if (!session) return res.status(401).json({ error: "Not signed in.", auth: "required" });
  const staff = auth.isStaff(session.email, STAFF_EMAILS);
  res.json({
    ok: true,
    user: { id: session.userId, name: session.name, email: session.email },
    staff,
    /* so a non-staff account is told why rather than being bounced
       back to a login screen that will not help it */
    reason: staff ? null : (STAFF_EMAILS.length
      ? "This account does not have access to the workspace."
      : "Access has not been configured on this server yet.")
  });
});

app.post("/api/logout", async (req, res) => {
  const sid = auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
  try { await destroySession(sid); } catch (e) { console.error("Logout:", e.message); }
  /* the cookie is cleared whatever happened to the record — a logout
     that half works is worse than one that fails loudly */
  res.setHeader("Set-Cookie", auth.clearCookie({ secure: auth.isSecureRequest(req) }));
  res.json({ ok: true });
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
    /* The password check here was already sound before this change —
       what was missing is that nothing came of it. Now a session does. */
    const session = await createSession(user);
    res.setHeader("Set-Cookie", auth.sessionCookie(session._id, { secure: auth.isSecureRequest(req) }));
    return res.json({
      ok: true,
      user: publicUser(user),
      /* said out loud so the dashboard can tell "wrong password" apart
         from "right password, but this account is not staff" */
      staff: auth.isStaff(user.email, STAFF_EMAILS)
    });
  } catch (err) {
    console.error("POST /api/login failed:", err.message);
    return res.status(502).json({ error: "Could not reach the database." });
  }
});


/* ==================================================================
   INSTAGRAM WEBHOOK

   Registered above the "*" catch-all on purpose. Without that, a GET
   here would fall through and return index.html with a 200, and Meta's
   verification would fail in a way that looks like a success.
   ================================================================== */

/* Raw deliveries live in their own collection, never in the workspace
   document: that document is saved with an optimistic revision check,
   so a webhook writing into it would collide with whoever has the
   dashboard open. Same reason partner comments have their own home. */
async function instagramEventsCollection() {
  const client = await getMongoClient();
  if (!client) return null;
  const col = client.db(MONGODB_DB).collection("instagram_events");
  if (!instagramEventsCollection._ready) {
    instagramEventsCollection._ready = true;
    /* A raw delivery is evidence, not a record we keep forever. Thirty
       days is long enough to debug a bad week and short enough that a
       person's messages are not stored indefinitely. */
    col.createIndex({ receivedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 })
      .catch((e) => console.error("instagram_events TTL index:", e.message));
    col.createIndex({ processedAt: 1 })
      .catch((e) => console.error("instagram_events index:", e.message));
  }
  return col;
}

/* Without a database configured the webhook still has to be testable,
   so deliveries are held in memory instead. Dev only, and it says so:
   the process forgets everything on restart, which is exactly why it
   is not what production runs on. */
const igMemoryEvents = new Map();

async function storeInstagramEvent(doc) {
  const col = await instagramEventsCollection();
  if (!col) {
    if (igMemoryEvents.has(doc._id)) return "duplicate";
    igMemoryEvents.set(doc._id, doc);
    /* bounded, so a long dev session cannot grow without limit */
    if (igMemoryEvents.size > 500) igMemoryEvents.delete(igMemoryEvents.keys().next().value);
    return "stored";
  }
  try {
    await col.insertOne(doc);
    return "stored";
  } catch (err) {
    /* the unique _id IS the dedup — a Meta retry lands here and is a
       no-op rather than a second copy of the same message */
    if (err && err.code === 11000) return "duplicate";
    throw err;
  }
}

/* Re-state the diagnosis on a refusal already on record. Only fields we
   worked out ourselves — a verdict and a name — are ever written here;
   nothing out of the unverified body, which is why the caller keeps
   passing the same small object it logged. */
async function noteRejectedDelivery(id, fields) {
  const col = await instagramEventsCollection();
  if (!col) {
    const doc = igMemoryEvents.get(id);
    if (doc) Object.assign(doc, fields);
    return;
  }
  await col.updateOne({ _id: id }, { $set: fields });
}

/* GET — the one-time handshake when the subscription is created. */
app.get("/api/webhooks/instagram", (req, res) => {
  if (!META_WEBHOOK_VERIFY_TOKEN) {
    console.error("Instagram webhook verify attempted, but META_WEBHOOK_VERIFY_TOKEN is not set.");
    return res.status(503).type("text/plain").send("Not configured");
  }
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && igWebhook.tokensMatch(token, META_WEBHOOK_VERIFY_TOKEN)) {
    console.log("Instagram webhook verified.");
    /* echoed back as plain text, exactly as sent — Meta compares the
       body byte for byte, so no JSON wrapper and no trailing newline */
    return res.status(200).type("text/plain").send(String(challenge == null ? "" : challenge));
  }
  console.error("Instagram webhook verification refused (mode=%s).", String(mode || ""));
  return res.status(403).type("text/plain").send("Forbidden");
});

/* POST — deliveries. Verify, persist, answer 200, then do the slow
   part. Nothing slow exists yet; the shape is here so that when it
   does, Meta is never waiting on it. */
app.post("/api/webhooks/instagram", async (req, res) => {
  if (!META_APP_SECRET) {
    console.error("Instagram webhook delivery refused: META_APP_SECRET is not set.");
    return res.status(503).json({ error: "Not configured." });
  }

  const raw = Buffer.isBuffer(req.body) ? req.body : null;
  const signature = req.get("x-hub-signature-256");
  if (!igWebhook.verifySignature(raw, signature, META_APP_SECRET)) {
    /* the header itself is never logged: it is a keyed digest of the
       body and there is no reason to write it down */
    console.error("Instagram webhook: bad or missing signature — rejected.");

    /* Which of the secrets we hold WOULD have verified this. The answer
       is a name — "basic", "instagram" or "none" — and nothing else. No
       secret, no digest, no header. With neither candidate configured
       there is nothing to test with, and saying "none" would read as a
       finding rather than an absence, so it says so instead. */
    const candidateMatch = HAVE_CANDIDATES
      ? igWebhook.whichSecretMatched(raw, signature, SIGNATURE_CANDIDATES)
      : "notChecked";

    /* And what the envelope claims about who the delivery was for. This
       is read out of a body that failed verification, so only the
       verdict survives — the account id itself is compared and dropped. */
    let accountMatch = "unreadable";
    let deliveryObject = "";
    try {
      const peek = JSON.parse((raw || Buffer.alloc(0)).toString("utf8"));
      accountMatch = igWebhook.accountVerdict(peek, INSTAGRAM_ACCOUNT_ID);
      deliveryObject = igWebhook.objectKind(peek);
    } catch (e) { /* not JSON — there is nothing to say about it */ }

    console.error("Instagram webhook: refused delivery — candidate secret: %s, account: %s, object: %s.",
      candidateMatch, accountMatch, deliveryObject || "?");

    /* Leave a trace, but NOT the payload. This body failed the signature
       check, so it is unverified input from an unknown sender and storing
       it would be storing whatever a stranger posted at us. The hash is
       enough to dedup a repeat and to tell one refused caller from many.
       Diagnostics must never be the reason a 403 fails to happen, so a
       problem writing it is swallowed. */
    try {
      const rejectionId = "rej:" +
        crypto.createHash("sha256").update(raw || Buffer.alloc(0)).digest("hex").slice(0, 32);
      const diagnosis = { candidateMatch, accountMatch, deliveryObject };
      const outcome = await storeInstagramEvent(Object.assign({
        _id: rejectionId,
        kind: "rejected",
        reason: signature ? "signature did not match" : "no signature header",
        bytes: raw ? raw.length : 0,
        receivedAt: new Date(),
        processedAt: null
      }, diagnosis));
      /* The dedup key is the body, so a Meta retry — or the same test
         sent again after a secret was changed — lands on the record we
         already have and inserts nothing. Without this the diagnosis
         would only ever be written for a body we had never seen before,
         which after several test deliveries is none of them. */
      if (outcome === "duplicate") await noteRejectedDelivery(rejectionId, diagnosis);
    } catch (e) { /* diagnostics only */ }
    return res.status(403).json({ error: "Invalid signature." });
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    console.error("Instagram webhook: signed body was not JSON.");
    return res.status(400).json({ error: "Malformed payload." });
  }

  const parsed = igWebhook.parseWebhookPayload(payload);
  const receivedAt = new Date();
  let stored = 0, duplicate = 0;

  try {
    for (const ev of parsed.events) {
      const outcome = await storeInstagramEvent({
        _id: ev.dedupKey,
        object: parsed.object,
        kind: ev.kind,
        entryId: ev.entryId,
        senderId: ev.senderId || null,
        recipientId: ev.recipientId || null,
        messageId: ev.messageId || null,
        field: ev.field || null,
        isEcho: !!ev.isEcho,
        text: ev.text || "",
        attachments: ev.attachments || [],
        postUrls: ev.postUrls || [],
        sentAt: ev.timestamp || null,
        receivedAt,
        processedAt: null,
        raw: ev.raw
      });
      if (outcome === "duplicate") duplicate++; else stored++;
      console.log("Instagram webhook: %s [%s]", igWebhook.logLineFor(ev), outcome);
    }
  } catch (err) {
    /* Answering 200 on a failed write would lose the delivery for
       good. A 503 asks Meta to send it again, which is recoverable. */
    console.error("Instagram webhook: could not store delivery:", err.message);
    return res.status(503).json({ error: "Could not store the event." });
  }

  /* A validly signed delivery whose shape we do not parse used to answer
     200 and leave nothing behind — which is exactly what Meta's Test
     button sends, and why "Test successful" sat next to a count of zero
     with no way to tell the two apart. It is signed, so it genuinely
     came from Meta: keep the whole thing, and keep it visibly separate
     from the events we understand. */
  let unrecognised = 0;
  if (!parsed.events.length) {
    console.log("Instagram webhook: signed delivery in a shape we do not parse (object=%s) — stored for inspection.",
      parsed.object || "?");
    try {
      const outcome = await storeInstagramEvent({
        _id: "unk:" + crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32),
        kind: "unrecognised",
        object: parsed.object || "",
        topLevelKeys: Object.keys(payload || {}),
        bytes: raw.length,
        receivedAt: new Date(),
        processedAt: null,
        raw: payload
      });
      if (outcome === "duplicate") duplicate++; else unrecognised++;
    } catch (err) {
      console.error("Instagram webhook: could not store an unrecognised delivery:", err.message);
      return res.status(503).json({ error: "Could not store the event." });
    }
  }
  res.status(200).json({ ok: true, received: parsed.events.length, stored, unrecognised, duplicate });

  /* Phase 2 hangs off here — matching a link to a participant, and
     the reply. Deliberately after the response, and deliberately
     empty for now. */
  setImmediate(() => {});
});

/* A quiet way to see whether the plumbing is configured, without
   revealing any of it. Says whether each secret is present, never
   what it is. */
app.get("/api/webhooks/instagram/status", async (req, res) => {
  /* It reports which secret would verify a delivery and how much
     traffic arrives, which is a map of the integration's soft spots.
     Either credential opens it: a staff session for someone with the
     dashboard open, or the diagnostic key for a curl from a terminal. */
  const session = await loadSession(req);
  const keyed = DIAGNOSTIC_KEY &&
    igWebhook.tokensMatch(req.get("x-diagnostic-key") || req.query.key || "", DIAGNOSTIC_KEY);
  if (!keyed && !(session && auth.isStaff(session.email, STAFF_EMAILS))) {
    return res.status(401).json({ error: "Sign in, or pass the diagnostic key.", auth: "required" });
  }

  /* Four states used to look like one number. A delivery that was
     refused, one that arrived in a shape we do not parse, and one that
     never arrived at all all showed as zero — so "Test successful" next
     to a zero was unreadable. They are counted apart now. */
  const emptyTally = { received: 0, messages: 0, changes: 0, unrecognised: 0, rejected: 0 };
  const tally = Object.assign({}, emptyTally);
  /* Refusals, broken down by the two things that can be established
     about them: which secret would have verified the delivery, and
     whether it was addressed to the Instagram account we configured. */
  const candidates = { basic: 0, instagram: 0, none: 0, notChecked: 0 };
  const accounts = { match: 0, different: 0, absent: 0, unconfigured: 0, unreadable: 0, notChecked: 0 };
  let lastDeliveryAt = null;
  let counted = true;

  /* refusals recorded before the diagnostic existed carry neither field */
  const bump = (bucket, value) => {
    const key = Object.prototype.hasOwnProperty.call(bucket, value) ? value : "notChecked";
    bucket[key] += 1;
  };

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const col = await instagramEventsCollection();
    if (col) {
      const rows = await col.aggregate([
        { $match: { receivedAt: { $gte: since } } },
        { $group: { _id: "$kind", n: { $sum: 1 }, newest: { $max: "$receivedAt" } } }
      ]).toArray();
      rows.forEach((r) => {
        const key = r._id === "message" ? "messages"
          : r._id === "change" ? "changes"
          : r._id === "unrecognised" ? "unrecognised"
          : r._id === "rejected" ? "rejected" : null;
        if (key) tally[key] += r.n;
        tally.received += r.n;
        if (r.newest && (!lastDeliveryAt || r.newest > lastDeliveryAt)) lastDeliveryAt = r.newest;
      });
      const refusals = await col.aggregate([
        { $match: { kind: "rejected", receivedAt: { $gte: since } } },
        { $group: { _id: { candidate: "$candidateMatch", account: "$accountMatch" }, n: { $sum: 1 } } }
      ]).toArray();
      refusals.forEach((r) => {
        for (let i = 0; i < r.n; i++) {
          bump(candidates, String((r._id && r._id.candidate) || ""));
          bump(accounts, String((r._id && r._id.account) || ""));
        }
      });
    } else {
      [...igMemoryEvents.values()].forEach((d) => {
        if (!d.receivedAt || d.receivedAt < since) return;
        const key = d.kind === "message" ? "messages"
          : d.kind === "change" ? "changes"
          : d.kind === "unrecognised" ? "unrecognised"
          : d.kind === "rejected" ? "rejected" : null;
        if (key) tally[key] += 1;
        tally.received += 1;
        if (d.kind === "rejected") {
          bump(candidates, String(d.candidateMatch || ""));
          bump(accounts, String(d.accountMatch || ""));
        }
        if (!lastDeliveryAt || d.receivedAt > lastDeliveryAt) lastDeliveryAt = d.receivedAt;
      });
    }
  } catch (e) {
    counted = false;
  }

  const stored = tally.messages + tally.changes;

  /* The one sentence worth reading. Refusals are the interesting case
     now that there is something to say about them: the diagnostic turns
     "the signature did not match" into which secret would have. */
  const refusalReading = () => {
    if (candidates.basic)
      return "Deliveries are arriving and being refused, and the Basic app secret verifies them — " +
        "META_APP_SECRET is holding the other one. Set it to the Basic app secret.";
    if (candidates.instagram)
      return "Deliveries are arriving and being refused, and the Instagram app secret verifies them — " +
        "META_APP_SECRET is holding the other one. Set it to the Instagram app secret.";
    if (candidates.none)
      return META_APP_BASIC_SECRET && META_INSTAGRAM_APP_SECRET
        ? "Deliveries are arriving and being refused, and neither the Basic nor the Instagram app secret " +
          "verifies them — whatever signed these is a third secret. Either the secret was regenerated after " +
          "it was copied, or the subscription belongs to a different Meta app."
        : "Deliveries are arriving and being refused, and the one candidate secret configured does not " +
          "verify them either. Set both META_APP_BASIC_SECRET and META_INSTAGRAM_APP_SECRET to test both.";
    return "Deliveries are arriving and being refused — META_APP_SECRET does not match the app secret in " +
      "Meta. Set META_APP_BASIC_SECRET and META_INSTAGRAM_APP_SECRET to find out which one it should be.";
  };

  res.json({
    ok: true,
    verifyToken: META_WEBHOOK_VERIFY_TOKEN ? "set" : "missing",
    appSecret: META_APP_SECRET ? "set" : "missing",
    instagramAccessToken: INSTAGRAM_ACCESS_TOKEN ? "set" : "missing",
    instagramAccountId: INSTAGRAM_ACCOUNT_ID ? "set" : "missing",
    storage: MONGODB_URI ? "database" : "memory (development only)",
    /* kept so anything already reading this field still works — it has
       always meant "events we recognised and stored" */
    deliveriesLast24h: counted ? stored : null,
    last24h: counted ? {
      received: tally.received,
      stored,
      messages: tally.messages,
      changes: tally.changes,
      unrecognised: tally.unrecognised,
      rejected: tally.rejected
    } : null,
    lastDeliveryAt: lastDeliveryAt || null,

    /* ---- the refusal diagnostic ----------------------------------- */
    /* Which secret WOULD have verified each refused delivery. Names
       only — no digests, and nothing that could be worked back into a
       secret. These two secrets are diagnostic: neither of them can
       cause a delivery to be accepted. */
    candidateSecrets: {
      basic: META_APP_BASIC_SECRET ? "set" : "missing",
      instagram: META_INSTAGRAM_APP_SECRET ? "set" : "missing"
    },
    signatureCandidates: counted ? candidates : null,
    rejectedAccountCheck: counted ? accounts : null,
    appIdNote: "A Meta webhook delivery carries no app id, so the signing app cannot be read off the " +
      "request. It can only be inferred from which secret verifies the signature, which is what " +
      "signatureCandidates reports. rejectedAccountCheck answers the narrower question the envelope " +
      "does allow: whether entry[].id is the Instagram account in INSTAGRAM_ACCOUNT_ID.",

    reading: counted
      ? (tally.received === 0
          ? "Nothing has reached this endpoint in 24h — Meta is not sending, or not to this URL."
          : tally.rejected && !stored && !tally.unrecognised
            ? refusalReading()
            : tally.unrecognised && !stored
              ? "Signed deliveries are arriving in a shape we do not parse yet — stored for inspection."
              : "Deliveries are arriving and being stored.")
      : "Could not read the delivery log."
  });
});

/* ==================================================================
   COLLAB DIAGNOSTIC

   Answers one question — does Meta hand us insights for a Reel we were
   invited to collaborate on? — using the token already in Render, so
   it never has to be copied anywhere.

   Read-only in every direction: every Meta call is a GET, and the only
   thing read from the database is the list of post URLs we already
   track, so the report can say how many of them are reachable. Nothing
   is written.

   Registered above the "*" catch-all, or a GET here would return
   index.html with a 200.
   ================================================================== */

/* One at a time, with a cooldown. The route is on the public internet
   and each run spends ~20 calls of a shared hourly Meta budget, so
   hammering it would cost real quota. */
let probeRunning = false;
let probeLastRunAt = 0;
/* A minute between runs in production. The harness turns it down so a
   suite can run twice; it is a rate-limit courtesy, not a security
   control, so an override is safe to expose. */
const PROBE_COOLDOWN_MS = Number(readEnv("PROBE_COOLDOWN_MS")) || 60 * 1000;

app.get("/api/diagnostics/instagram-collab", async (req, res) => {
  /* No key configured means the diagnostic is off. Failing closed
     matters more than usual here: nothing else on this API is
     authenticated, so an ungated route would let anyone read our media
     and drain the rate limit. */
  if (!DIAGNOSTIC_KEY) {
    return res.status(404).json({ error: "Not found." });
  }
  const given = req.get("x-diagnostic-key") || req.query.key || "";
  if (!igWebhook.tokensMatch(given, DIAGNOSTIC_KEY)) {
    console.error("Collab diagnostic: refused, bad or missing key.");
    return res.status(403).json({ error: "Forbidden." });
  }
  if (!INSTAGRAM_ACCESS_TOKEN) {
    return res.status(503).json({ error: "INSTAGRAM_ACCESS_TOKEN is not set on this service." });
  }
  if (probeRunning) {
    return res.status(429).json({ error: "A probe is already running. Try again in a moment." });
  }
  const since = Date.now() - probeLastRunAt;
  if (probeLastRunAt && since < PROBE_COOLDOWN_MS) {
    return res.status(429).json({
      error: "Cooling down so we do not spend the Meta rate limit.",
      retryInSeconds: Math.ceil((PROBE_COOLDOWN_MS - since) / 1000)
    });
  }

  probeRunning = true;
  probeLastRunAt = Date.now();
  try {
    /* the URLs we already track, read straight out of the workspace —
       a read, and the only database access this route makes */
    let knownUrls = [];
    try {
      const doc = await loadWorkspaceDoc();
      knownUrls = (((doc && doc.db) || {}).socialContent || [])
        .filter((c) => c && /^https?:\/\//.test(String(c.url || "")))
        .map((c) => ({ url: c.url, handle: c.username || null }));
    } catch (e) {
      console.error("Collab diagnostic: could not read tracked URLs:", e.message);
    }

    const report = await igCollabProbe.runProbe({
      token: INSTAGRAM_ACCESS_TOKEN,
      base: IG_PROBE_BASE || undefined,
      knownUrls,
      maxPages: Math.min(Number(req.query.pages) || 4, 10),
      allInsights: req.query.all === "1",
      mediaId: req.query.media || null,
      deadlineMs: 45000
    });

    /* the summary line is the only thing that reaches stdout — no
       token, no captions, no permalinks */
    console.log("Collab diagnostic: %s · %d media · %d owned by others · %d calls",
      report.verdict || report.fatal || "no verdict", report.mediaReturned || 0,
      (report.ownership && report.ownership.ownedByOthers) || 0, report.calls || 0);

    res.json(report);
  } catch (err) {
    console.error("Collab diagnostic failed:", err.message);
    res.status(500).json({ error: "The probe did not complete." });
  } finally {
    probeRunning = false;
  }
});

/* ---------------------------- booking -------------------------------

   Mounted last among the API routes and before the catch-all, and handed
   what it needs rather than reaching for it. The handle it returns is
   what POST /api/workspace reads live bookings through. */
bookingApi = bookingRoutes.mountBookingRoutes(app, {
  getMongoClient, MONGODB_DB, MONGODB_URI, loadWorkspaceDoc, requireStaff
});

/* Setup → Sheet metrics: the two read-only Google Sheet reads the browser
   cannot make itself. See server/sheet-proxy.js. */
sheetProxy.mountSheetProxy(app, { requireStaff });

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`VIVELY app listening on port ${PORT}`);
});
