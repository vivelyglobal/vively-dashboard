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
    mongoClientPromise = client.connect().catch((err) => {
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
  res.json({ ok: true, service: "vively-auth-api", database: MONGODB_URI ? "configured" : "not-configured" });
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

app.post("/api/signup", (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");

  if (!name) return res.status(400).json({ error: "Nama wajib diisi" });
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Email tidak valid" });
  if (password.length < 8) return res.status(400).json({ error: "Password minimal 8 karakter" });

  const users = readUsers();
  if (users.some((u) => u.email === email)) {
    return res.status(409).json({ error: "Email sudah terdaftar" });
  }

  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString()
  };

  users.push(user);
  writeUsers(users);

  return res.status(201).json({ ok: true, user: publicUser(user) });
});

app.post("/api/login", (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");

  if (!email || !password) {
    return res.status(400).json({ error: "Email dan password wajib diisi" });
  }

  const users = readUsers();
  const user = users.find((u) => u.email === email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: "Email atau password salah" });
  }

  return res.json({ ok: true, user: publicUser(user) });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`VIVELY app listening on port ${PORT}`);
});
