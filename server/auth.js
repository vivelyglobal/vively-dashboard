/* ===================================================================
   Sessions, and who is allowed in.

   Until now /api/workspace answered anyone who asked. The document it
   returns holds every creator's name, email, phone, address and bank
   details, and the matching POST replaced the whole thing. The login
   screen existed but only ever convinced the browser — the server
   never checked, so the lock was on the inside of the door.

   Two separate questions are answered here, and keeping them apart
   matters:

     1. Who are you?      — a signed-in session, from the existing
                            password login, which was already sound
                            (pbkdf2, 100k rounds, per-user salt).

     2. Are you staff?    — deliberately not the same set as "has an
                            account". Signup was open to anyone who
                            found the URL, so the accounts that exist
                            are not by themselves evidence of who
                            should see a roster with bank details on
                            it. STAFF_EMAILS answers this second
                            question explicitly, and lives in the
                            environment so that nothing inside the app
                            can grant it — including a signup form.
   =================================================================== */

const crypto = require("crypto");

/* A session id is a bearer credential: whoever holds it is the user
   until it expires, so it has to be unguessable rather than merely
   unique. 32 bytes from the CSPRNG, never a uuid or a counter. */
function newSessionId() {
  return crypto.randomBytes(32).toString("hex");
}

const SESSION_COOKIE = "vively_session";
/* Long enough that the team is not logging in every morning, short
   enough that a forgotten laptop stops working within a fortnight. */
const SESSION_DAYS = 14;

/* No cookie-parser dependency for something this small. Values are
   percent-decoded because that is what Set-Cookie writes. */
function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i < 1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) return;
    try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; }
  });
  return out;
}

/* HttpOnly so a cross-site script cannot read it; SameSite=Lax so it
   is not sent on someone else's form post; Secure whenever the request
   arrived over TLS, which on Render it always does — but not when it
   did not, or local development over http would silently never receive
   the cookie and look like a broken login. */
function sessionCookie(sid, opts) {
  const o = opts || {};
  const maxAge = Math.round((o.maxAgeSec != null ? o.maxAgeSec : SESSION_DAYS * 86400));
  const bits = [
    SESSION_COOKIE + "=" + encodeURIComponent(sid),
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + maxAge
  ];
  if (o.secure) bits.push("Secure");
  return bits.join("; ");
}

function clearCookie(opts) {
  const o = opts || {};
  const bits = [SESSION_COOKIE + "=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (o.secure) bits.push("Secure");
  return bits.join("; ");
}

/* Render terminates TLS in front of the app, so req.secure is false
   even on an https request; the proxy's header is what tells us. */
function isSecureRequest(req) {
  if (!req) return false;
  const proto = String((req.headers && req.headers["x-forwarded-proto"]) || "").split(",")[0].trim();
  if (proto) return proto === "https";
  return !!req.secure;
}

/* ---- who counts as staff ------------------------------------------- */

/* Surrounding quotes are stripped, from the whole value and from each
   entry. Pasting a quoted list is an easy thing to do — it is how the
   value looks in a .env file — and without this the first and last
   addresses keep a quote character and silently stop matching, while
   the middle ones work. Two of four people locked out with no error
   anywhere is a far worse failure than all four or none. */
const unquote = (s) => String(s || "").trim().replace(/^["']+|["']+$/g, "").trim();

function parseStaffList(raw) {
  return unquote(raw)
    .split(/[,\s;]+/)
    .map((s) => unquote(s).toLowerCase())
    .filter((s) => s.includes("@"));
}

/* What was in the value but could not be read as an address, so a
   typo can be reported at startup instead of discovered by somebody
   who cannot sign in. */
function staffListRejects(raw) {
  return unquote(raw)
    .split(/[,\s;]+/)
    .map((s) => unquote(s))
    .filter((s) => s && !s.includes("@"));
}

/* Fails closed on purpose. An unset STAFF_EMAILS is not "let everyone
   in" — it is "this has not been configured", and the safe reading of
   that is nobody, with a loud message rather than a silent opening. */
function isStaff(email, staffList) {
  const who = String(email || "").trim().toLowerCase();
  if (!who) return false;
  const list = Array.isArray(staffList) ? staffList : parseStaffList(staffList);
  if (!list.length) return false;
  return list.includes(who);
}

/* ---- session records ------------------------------------------------ */

function newSession(user, now) {
  const at = now instanceof Date ? now : new Date();
  return {
    _id: newSessionId(),
    userId: (user && user.id) || null,
    email: String((user && user.email) || "").toLowerCase(),
    name: (user && user.name) || "",
    createdAt: at,
    lastSeenAt: at,
    /* the record carries its own expiry as well as relying on the TTL
       index, because a TTL index sweeps on a timer and "expired" has to
       be true the moment it is true, not up to a minute later */
    expiresAt: new Date(at.getTime() + SESSION_DAYS * 86400 * 1000)
  };
}

function sessionExpired(session, now) {
  if (!session) return true;
  const at = (now instanceof Date ? now : new Date()).getTime();
  const exp = session.expiresAt ? new Date(session.expiresAt).getTime() : 0;
  return !exp || exp <= at;
}

module.exports = {
  SESSION_COOKIE, SESSION_DAYS,
  newSessionId, parseCookies, sessionCookie, clearCookie, isSecureRequest,
  parseStaffList, staffListRejects, isStaff, newSession, sessionExpired
};
