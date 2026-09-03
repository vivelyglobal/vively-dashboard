/* ==================================================================
   Instagram messaging webhook — receipt only.

   Phase 1 deliberately stops at "the event is safely on disk and we
   can see the links in it". No campaign matching, no replies. The
   point of this stage is to prove delivery is reliable before
   anything is built on top of it.

   Two things here are easy to get subtly wrong, so they are handled
   explicitly rather than left to a library:

   1. The signature is an HMAC over the EXACT bytes Meta sent. Once
      express.json() has parsed the request those bytes are gone, and
      re-serialising the parsed object produces different ones — the
      same JSON, different unicode escaping and whitespace. A check
      built that way passes hand-written test payloads and fails real
      traffic. server.js therefore mounts express.raw() on this path
      only, above the global parser, and everything below works from
      the Buffer.

   2. Meta retries. A retry is not a new event, so every delivery is
      stored under a key derived from the message id, and a repeat is
      a no-op rather than a second record.
   ================================================================== */
const crypto = require("crypto");

/* ---- signature ---------------------------------------------------- */

/* Constant-time, and false for every shape of "not actually signed" —
   a missing header must never be treated as a pass. */
function verifySignature(rawBody, header, appSecret) {
  if (!appSecret) return false;
  if (!Buffer.isBuffer(rawBody)) return false;
  const m = String(header || "").match(/^sha256=([0-9a-f]{64})$/i);
  if (!m) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest();
  let given;
  try { given = Buffer.from(m[1], "hex"); } catch (e) { return false; }
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

/* ---- which secret would have worked (diagnostic only) -------------- */

/* A Meta delivery carries no app id. When the signature fails there is
   therefore nothing in the request that says "this was signed by app
   X", and "wrong secret" is indistinguishable from "wrong app" by
   inspection alone. The one thing that CAN be established is which of
   the secrets we hold would have verified it — so hold both candidates
   and ask.

   This never decides whether a delivery is accepted. It returns a
   name — a key of `candidates`, or "none" — and nothing else: not a
   digest, not a secret, not the header. A candidate with no value set
   is skipped rather than tried, so an unset secret can never be the
   thing that "matched". */
function whichSecretMatched(rawBody, header, candidates) {
  const list = (candidates && typeof candidates === "object") ? candidates : {};
  for (const name of Object.keys(list)) {
    if (!list[name]) continue;
    if (verifySignature(rawBody, header, list[name])) return name;
  }
  return "none";
}

/* ---- who a delivery was for (diagnostic only) ---------------------- */

/* The other half of "is this even ours". There is no app id in the
   envelope, but there is entry[].id — the Instagram account the
   subscription belongs to — and we know which account we configured.
   That answers a narrower question than "which app", but a real one:
   whether these deliveries are for our inbox at all.

   Called on bodies that FAILED verification, so it returns a verdict
   and never the id itself. Nothing out of an unverified body is kept. */
function accountVerdict(payload, configuredAccountId) {
  const entries = (payload && Array.isArray(payload.entry)) ? payload.entry : [];
  const ids = entries.map((e) => String((e && e.id) || "")).filter(Boolean);
  if (!ids.length) return "absent";
  if (!configuredAccountId) return "unconfigured";
  return ids.includes(String(configuredAccountId)) ? "match" : "different";
}

/* `object` says which product the subscription is on — "instagram" for
   an Instagram-Login app, "page" for one routed through a Facebook
   Page — which is worth knowing when deliveries are being refused. It
   comes out of an unverified body, so it is matched against a fixed
   vocabulary rather than stored as sent. */
const KNOWN_OBJECTS = ["instagram", "page", "user", "application", "permissions"];
function objectKind(payload) {
  const o = String((payload && payload.object) || "");
  if (!o) return "";
  return KNOWN_OBJECTS.includes(o) ? o : "other";
}

/* The verify-token comparison is constant-time too. Lower stakes than
   the signature, but it is still a secret being compared. */
function tokensMatch(given, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(given || ""), "utf8");
  const b = Buffer.from(String(expected), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ---- links -------------------------------------------------------- */

/* Kept in step with the browser-side platformPostIdOf by a test that
   runs both over the same table of URLs — a second copy of a parser is
   only safe if something notices when the two drift apart. */
const IG_POST_RE = /https?:\/\/(?:www\.)?instagram\.com\/(p|reel|reels|tv)\/([\w-]+)/gi;

function instagramPostId(url) {
  const m = String(url || "").match(/instagram\.com\/(?:p|reel|reels|tv)\/([\w-]+)/i);
  return m ? "ig_" + m[1] : "";
}

/* Every Instagram post or reel link in a blob of text, de-duplicated by
   post id — the same reel pasted twice, or sent as both a link and a
   share attachment, is one deliverable and not two. */
function extractPostUrls(text) {
  const out = [];
  const seen = new Set();
  const s = String(text || "");
  let m;
  IG_POST_RE.lastIndex = 0;
  while ((m = IG_POST_RE.exec(s)) !== null) {
    const id = "ig_" + m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    const kindWord = m[1].toLowerCase();
    out.push({
      url: "https://www.instagram.com/" + (kindWord === "reels" ? "reel" : kindWord) + "/" + m[2] + "/",
      kind: kindWord === "p" ? "post" : kindWord === "tv" ? "tv" : "reel",
      platformPostId: id
    });
  }
  return out;
}

/* ---- events ------------------------------------------------------- */

const iso = (t) => {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  /* Meta sends milliseconds on messaging and seconds on some change
     events; anything below ~1e11 is really a seconds value. */
  const d = new Date(n < 1e11 ? n * 1000 : n);
  return isNaN(d) ? null : d.toISOString();
};

function attachmentsOf(message) {
  const list = (message && message.attachments) || [];
  return list.filter(Boolean).map((a) => ({
    type: a.type || "",
    url: (a.payload && (a.payload.url || a.payload.link)) || ""
  }));
}

/* A delivery Meta can retry needs a key that is identical on the
   retry. The message id is that key when there is one; the rest —
   read receipts, reactions, comment changes — get a digest of the
   item so they dedup too rather than piling up. */
function dedupKeyFor(entryId, item, messageId) {
  if (messageId) return "mid:" + messageId;
  const h = crypto.createHash("sha256")
    .update(String(entryId) + " " + JSON.stringify(item))
    .digest("hex").slice(0, 32);
  return "ev:" + h;
}

function parseWebhookPayload(payload) {
  const events = [];
  const entries = (payload && Array.isArray(payload.entry)) ? payload.entry : [];

  entries.forEach((entry) => {
    const entryId = (entry && entry.id) || "";
    const messaging = Array.isArray(entry && entry.messaging) ? entry.messaging : [];

    messaging.forEach((item) => {
      const message = item.message || {};
      const messageId = message.mid || "";
      const text = typeof message.text === "string" ? message.text : "";
      const atts = attachmentsOf(message);
      /* links arrive either typed into the message or as a share
         attachment, and a creator may well do both */
      const postUrls = extractPostUrls([text].concat(atts.map((a) => a.url)).join(" "));

      events.push({
        kind: "message",
        entryId,
        senderId: (item.sender && item.sender.id) || "",
        recipientId: (item.recipient && item.recipient.id) || "",
        messageId,
        isEcho: !!message.is_echo,
        timestamp: iso(item.timestamp) || iso(entry && entry.time),
        text,
        attachments: atts,
        postUrls,
        dedupKey: dedupKeyFor(entryId, item, messageId),
        raw: item
      });
    });

    /* comments, mentions and the rest. Stored, not interpreted — this
       phase is about proving receipt, and dropping an event we have
       not designed for yet would hide that it arrived at all. */
    const changes = Array.isArray(entry && entry.changes) ? entry.changes : [];
    changes.forEach((item) => {
      events.push({
        kind: "change",
        entryId,
        field: (item && item.field) || "",
        timestamp: iso(entry && entry.time),
        postUrls: extractPostUrls(JSON.stringify((item && item.value) || {})),
        dedupKey: dedupKeyFor(entryId, item, ""),
        raw: item
      });
    });
  });

  return { object: (payload && payload.object) || "", events };
}

/* What is safe to put in a log line. The sender's Instagram-scoped id
   identifies a person, and Render keeps logs where anyone with
   dashboard access can read them — so the full payload goes to the
   database and only a shape summary goes to stdout. */
function logLineFor(ev) {
  const bits = [ev.kind];
  bits.push(ev.messageId ? "mid=" + String(ev.messageId).slice(0, 12) + "…" : "no-mid");
  if (ev.field) bits.push("field=" + ev.field);
  if (ev.isEcho) bits.push("echo");
  bits.push((ev.postUrls || []).length + " link(s)");
  if (ev.text) bits.push(ev.text.length + " chars");
  return bits.join(" · ");
}

module.exports = {
  verifySignature, tokensMatch,
  whichSecretMatched, accountVerdict, objectKind,
  extractPostUrls, instagramPostId,
  parseWebhookPayload, dedupKeyFor, logLineFor, iso
};
