# VIVELY Dashboard — technical reference

What the thing is, how it is put together, and the rules you have to know
before changing it. Companion documents: [CHANGELOG.md](CHANGELOG.md) for
what was built when, [BUGS.md](BUGS.md) for what was broken and why,
[../ARCHITECTURE.md](../ARCHITECTURE.md) for the module split in detail.

---

## 1. What it is

An influencer-campaign dashboard for VIVELY: a creator database, campaigns
with a roster and pipeline, outreach message generation, contracts, a
booking system that lets creators pick their own restaurant visit, social
content tracking, and syncs out to Google Sheets, Google Calendar and
Notion.

One Node + Express process serves both the page and the API. There is no
build step in production.

---

## 2. The rule that governs every change

**`index.html` is the source of truth. Every module listed in
`tools/manifest.json` is generated from it.**

`index.html` is the app in production — one file, its own `<style>`, its
own `<script>`. The `src/` tree is the same code cut into ES modules by
line range, kept honest by the manifest. Editing one of those generated
files by hand is pointless: the next rebuild overwrites it.

The exceptions are hand-written and **not** regenerated: `src/app/*`
(the React shell — routing, rail, panel, tabs, auth, theme),
`src/main.jsx` and `src/index.html`. They are not in the manifest, so a
fix made in `index.html` does **not** reach them. See **Known gaps**.

### The workflow, in order

```bash
cp index.html /tmp/index.pre.html          # keep a pre-edit copy
#   …edit index.html…
python3 tools/reanchor.py /tmp/index.pre.html   # move the manifest's line ranges
node tools/rebuild-split.mjs                    # regenerate src/ + checksums
node tools/autoimport.mjs views/thing.js        # write import headers (new/changed files)
node tools/rebuild-split.mjs                    # again: autoimport changed the files
npm run check:modules                           # must be clean before you stop
```

`reanchor.py` is the step people skip and then wonder why the split is
scrambled: inserting 800 lines in the middle of `index.html` moves every
range after it, and the manifest has to be told.

### `tools/manifest.json`

One entry per module: `file`, `ranges` (1-indexed, inclusive, into
`index.html`), `imports`, `sha256`. A **new module needs its entry added
by hand** — `file`, `ranges`, empty `imports`, empty `sha256` — before the
rebuild will produce it. 52 modules today.

### Two rewrites the split applies automatically

- In anything under `views/`, a bare `render()` becomes `notify()`.
  **`.then(render)` is not rewritten** — pass `() => render()` or the free
  variable check will fail.
- In `model/db.js`, `updateSaveBadge()` becomes `notifyStatus()`.

The data layer announces; the shell subscribes. A save finishing must
repaint one badge without tearing down a half-filled drawer.

### `npm run check:modules`

Four gates: every name resolves to something imported or declared; every
import names something really exported; every inline `onclick=` resolves
against the eleven globals in `src/app/globals.js`; and every module still
matches `index.html` byte for byte. **It must be clean before you stop.**

---

## 3. Data model

Two halves, with different rules. Mixing them up is the cause of
[BUGS.md](BUGS.md) #2.

### Half one: the workspace document

One Mongo document, `workspace` collection, `_id: "shared"` — one shared
workspace for the whole team, mirroring how the Google Sheet worked.

```
{ _id: "shared", db: {…}, settings: {…}, savedAt, revision, savedBy }
```

`db` holds six arrays: `creators`, `campaigns`, `participants`,
`appointments`, `partnerLinks`, `socialContent`. The client holds the
whole thing in memory as `DB` and POSTs the whole thing back.

- **`revision` is an optimistic lock.** Saved behind your load → the
  server returns 409. Treat a 409 as unresolved; do not adopt the
  revision without the data.
- **`server/workspace-guard.js`** refuses a payload whose `campaigns`,
  `creators` and `participants` are *all* empty, unless the caller states
  `intent: "replace-with-empty"`. The deliberately wordy sentence exists
  so no stray truthy value can produce it.
- **A published post is one record.** It lives in `DB.socialContent`;
  `participant.content` points at the same object in memory and the save
  path strips it back out, so there is one copy on disk.
- **Payout details never leave in a file.** `stripPayout()` on every
  download. The server copy keeps them.

### Half two: the booking collections — authoritative

```
booking_schedules    one per campaign: venue, timezone, slot length,
                     status, maxPartySize, maxPerDay, closedDates,
                     publicToken, rule
booking_slots        one per date+time: capacity, booked, status
booking_invites      a per-creator link; its _id is the token
campaign_bookings    a confirmed booking: slotId, date, time, partySize,
                     participantId or guest, status, history[]
```

**The booking owns the time it booked.** `participant.confirmedVisitAt`
and `participant.bookingId` are a *projection* of the booking onto the
workspace, written by `applyBookingSlots` in `server/booking-store.js`.
It runs on `POST /api/workspace`, on `GET /api/workspace`, and is
mirrored client-side by `applyBookingTimesLocally()` and `deskProject()`.
A change that touches a booking must keep all of those in step, or you
reintroduce [BUGS.md](BUGS.md) #2.

### Indexes that are load-bearing

Built by `ensureBookingIndexes()` inside the lazy Mongo connect — so on
the first request that actually needs the database, not at boot, and not
at all while `MONGODB_URI` is unset. Two are *partial unique* indexes,
and they are what make "one confirmed booking per creator per campaign" a
database fact rather than a race:

```
campaign_bookings { campaignId, participantId }   unique, partial:
                     { status: "confirmed", participantId: {$type:"string"} }
campaign_bookings { campaignId, guest.handleNorm } unique, partial:
                     { status: "confirmed", "guest.handleNorm": {$type:"string"} }
campaign_bookings { manageToken }                 unique
campaign_bookings { campaignId, status, startsAt }
booking_slots     { scheduleId, date, time }      unique
booking_slots     { campaignId, startsAt }
booking_schedules { campaignId }                  unique
booking_schedules { publicToken }                 unique
booking_invites   { campaignId, participantId }
users             { email }                       unique   (built in server.js)
```

The `$type: "string"` half of each partial filter is not decoration: it is
what keeps unmatched and guest rows out of the index, so a campaign can
hold many guest bookings while still allowing only one confirmed booking
per roster row.

### Other collections

`users`, `sessions` (auth), `partner_comments`, `instagram_events`,
`post_submissions` (post links a creator pasted on their booking page —
kept apart from the workspace for the same reason partner comments are,
and accepted onto the roster from Today).

Fields the dashboard writes on a participant for Today:
`bookingLinkSentAt`, `reminderFor` (the visit slot reminded about),
`chasedAt`, `todaySnooze: { kind: 'YYYY-MM-DD' }`. Campaigns carry
`todaySnooze` too. `SETTINGS.venuePresets` holds saved booking shapes.

---

## 4. Concurrency

Three staff and any number of creators on phones write at the same time.
Three mechanisms, each for a different shape of race:

- **Optimistic lock** on the workspace document (`revision`).
- **Atomic claim** on a slot: `findOneAndUpdate` with an `$expr` filter
  asserting `booked + n <= capacity`. Capacity and `booked` never leave
  the server, so no client can compute a seat it is not allowed.
- **Insert-then-arbitrate** for the per-day cap: inserts, then orders
  deterministically by `bookedAt` then `_id`, so two simultaneous
  bookings resolve the same way whichever lands first.

Every staff override is written down: `overCapacity`, `overDailyLimit`,
and a `history[]` entry with `byEmail` from the session.

---

## 5. Time

**Every venue is in Seoul, and a slot is wall-clock at the venue.** The
Desk reads dates and times as written and converts nothing. The one place
the zone matters is "today", which is `kstToday()` — the Korean day, not
the browser's.

The trap, and it has bitten once ([BUGS.md](BUGS.md) #4):

- `iso()` formats in **UTC**
- `parseVisitSlot()` builds at **local midnight**

Mixing them shifts every date by a day in Korea. Rule dates use
`ruleDate()` (UTC midnight) and `getUTCDay()`. Do not tidy those back
into `getDay()`.

Run the test suite under at least two zones. `TZ=Asia/Seoul` is the real
one; a UTC-only run cannot see this class of bug.

---

## 6. The booking system

### The weekly rule

`defaultBookingRule()` returns the shape:

```js
{ days:   { Mon: null, Tue: ['18:30','19:30'], … },   // arrival window per weekday
  slotsPerDay: 1,      // how many times a day, spread across the window
  perDay: 1,           // creators per time slot (seats in a sitting)
  breaks: [],          // windows blocked inside the arrival window
  from, to,            // the booking period
  skipHolidays: true }
```

`slotsPerDay` and `perDay` and `maxPerDay` are three different numbers and
venues talk about all three:

| Number | Means | Lives on |
|---|---|---|
| `slotsPerDay` | how many sittings a day | the rule |
| `perDay` | creators per sitting | the rule |
| `maxPerDay` | total teams a day, whatever the times allow | the schedule; `0` = unlimited |

Key functions, all in `src/views/booking.js`: `ruleSlotCount`,
`ruleSegments`, `ruleTimesFor`, `ruleDate`, `ruleDayName`,
`ruleFirstWindow`, `applyRuleWindow`, `ruleSlotsToAdd`,
`expandBookingRule`, `bookingRuleSummary`.

**The rule is expanded in the browser, not the server.** The preview
somebody approved and the rows that get written have to be the same list,
and one expander means they cannot drift. The server validates every row
it is handed, and skips a time that already exists on that date —
generating twice is a normal thing to do after editing a rule, and must
never duplicate a day or disturb a booked one.

**The rule is never read to decide what is bookable.** The slots are, as
they always were. The rule is stored so the setup screen can show it back
and regenerate.

### Links, and who gets one

`INVITE_SCOPES` — `confirmed` (the default and `SAFE_SCOPE`),
`shortlisted`, `all`. Blacklisted creators (`isBlocked`) and dropped rows
are excluded under **every** scope. The two broad scopes sit behind
**Advanced** and are labelled "includes unconfirmed creators".

**Always send the invite link, not the public one.** The invite knows who
the creator is, so the booking matches itself to the roster and cannot
become somebody else if it is forwarded.

### The Desk

`GET /api/booking/desk?from=&to=` returns `{schedules, slots, bookings,
invites}` for a window — per-schedule queries, default 7 days, capped at
`DESK_MAX_DAYS = 31`, and it never reads the workspace document.
`GET /api/booking/desk/meta` is the cheap half for the 20-second poll:
counts plus the newest `updatedAt`, so a move that keeps the count the
same still registers as a change and a cancel that moves nothing still
does too.

Client state and helpers are in `src/views/desk.js`: `DESK`, `loadDesk`,
`deskPollOnce`, `deskKey`, `deskWho`, `deskClashes`, `deskChores`,
`deskPeople`, `deskMove`, `deskProject`, `renderDesk`.

---

## 7. API

Most of `/api` requires a staff session via `requireStaff`, and
`STAFF_EMAILS` decides who is staff. The routes that take **no** session
are: the public booking routes and the partner routes (the token is in the
URL), the four auth routes (`signup`, `login`, `logout`, `me`), the three
Instagram webhook routes (Meta signs those), and
`/api/diagnostics/instagram-collab`, which is guarded by `DIAGNOSTIC_KEY`
instead. Everything else is staff-only.

### Workspace — `server.js`
```
GET    /api/workspace            whole document + booking projection fixes
GET    /api/workspace/meta       revision + savedAt only (cheap poll)
POST   /api/workspace            replace, revision-checked, guard-checked
GET    /api/health
GET    *                         the SPA catch-all, serves index.html
GET    /next/*                   only when a Next build is present
```

### Auth — `server.js` + `server/auth.js`
```
POST   /api/signup               gated by SIGNUP_CODE; unset = closed
POST   /api/login
POST   /api/logout
GET    /api/me
```

### Booking, staff — `server/booking-routes.js`
```
POST   /api/booking/schedule             create or patch a campaign's schedule
GET    /api/booking/campaign/:campaignId schedule + slots + bookings + invites
GET    /api/booking/desk                 every campaign, one window
GET    /api/booking/desk/meta            counts + newest change, for the poll
POST   /api/booking/slot                 one time on one date
POST   /api/booking/slots/bulk           a generated rule, validated row by row
POST   /api/booking/slots/clear
PATCH  /api/booking/slot/:id
DELETE /api/booking/slot/:id
POST   /api/booking/date                 add a date
POST   /api/booking/date/delete
PATCH  /api/booking/booking/:id
POST   /api/booking/booking/:id/cancel
POST   /api/booking/booking/:id/move     409 day_full / slot_full unless overridden
POST   /api/booking/booking/:id/match    point an unmatched booking at a roster row
POST   /api/booking/invite               issue a per-creator link
DELETE /api/booking/campaign/:campaignId wipe a campaign's booking setup
```

### Booking, public — no session
```
GET    /api/book/:token                  invite token or a schedule's publicToken
POST   /api/book/:token/confirm
GET    /api/book/manage/:manageToken     the creator's own booking
POST   /api/book/manage/:manageToken/move
POST   /api/book/manage/:manageToken/cancel
POST   /api/book/manage/:manageToken/post   the creator's post link → post_submissions
GET    /book/i/:token                    one handler, three paths,
GET    /book/manage/:token                 all serving book.html
GET    /book/:token
```

All six `/api/book/...` routes are rate-limited per token. The post route
also checks the URL is Instagram, TikTok or YouTube and keeps at most ten
links per booking.

Staff, for the same collection:
```
GET    /api/booking/submissions              unhandled post links
POST   /api/booking/submissions/:id/handled  { outcome: accepted | rejected }
```
`X-Robots-Tag: noindex, nofollow` is set on the three read-and-confirm
routes and on the page itself; the two `manage` write routes do not set
it. Harmless — nothing crawls a POST — but worth knowing before you reason
about it.

### Partner pages — token, no session
```
GET    /partner/:token                   serves partner.html
GET    /api/partner/:token
POST   /api/partner/:token/comment
GET    /api/partner-comments             staff
POST   /api/partner-comments/read        staff
```

### Integrations
```
GET    /api/notion/database  /api/notion/query   POST /api/notion/status
GET    /api/calendar/status  /api/calendar/events
POST   /api/calendar/event   /api/calendar/event/delete   /api/calendar/test
GET    /api/sheet-metrics/tabs   /api/sheet-metrics/csv
GET,POST /api/webhooks/instagram     GET /api/webhooks/instagram/status
GET    /api/diagnostics/instagram-collab    (DIAGNOSTIC_KEY)
```

**Do not touch** `sync/sheets.js` behaviour or the Meta API
implementation. Both are working against live external systems.

---

## 8. Pipeline vocabulary

`STAGES`, in order, from `src/model/vocab.js`:

```
sourced → contacted → replied → shortlisted → confirmed →
shipped (Shipped / Booked) → submitted (Content in) → review → live
                                                       …and dropped
```

`STAGE_IDX` gives the ordinal, so "confirmed or beyond" is
`STAGE_IDX[p.stage] >= STAGE_IDX.confirmed`.
`PLANNER_CONFIRMED = ['confirmed','shipped','submitted','review','live']`
is "actually taking part".

Shipment tracking applies to campaigns where `campaignShips(cp)` — any
`kind` that is not a store visit. Over ten days shipped and not delivered
reads as late.

---

## 9. Tests and checks

### `npm test` — 556 tests, 28 files
Pure logic under `node --test`, no browser. Run it under
`TZ=Asia/Seoul`. Largest files: `booking-rule` (44), `home` (39),
`sheet-metrics` (37), `social-store` (36), `instagram-webhook` (35),
`social-overview` (30), `booking` (28).

### `npm run check:modules`
The four gates in §2. Clean before you stop.

### Browser harnesses
Playwright drives the **real `index.html`**. Two kinds:

**Self-contained** — they stand up their own stub and need **no server
and no Mongo**. These are the ones to run first:

```bash
npm run check:booking      # the booking API, end to end
npm run check:bookadmin    # the Booking tab through the real UI
npm run check:desk         # the Desk: clashes, moves, overrides, phone
npm run check:bookpage     # the creator's own booking page
npm run check:staffedits   # a staff edit vs. a booking's own time
npm run check:planner      # the Planner tab
npm run check:crflags      # creator flags + shipment
npm run check:sheetmetrics
npm run check:partner
npm run check:bookrace     # concurrency rehearsal, no browser at all
```

The first five drive the real booking routes over
`tools/fake-booking-db.mjs`, an in-memory stand-in for Mongo. The next
four use an Express stub without it, and `check:bookrace` is pure logic.

**Needs a real server on port 3120** — they sign in for real:
`check:save`, `check:home`, `check:phone`, `check:guard`,
`check:uifixes`, `check:browser`, `check:calendar`, `check:visit`,
`check:social`, `check:sooverview`, `check:writeback`, `check:ids`,
`check:syncskips`.

To run those, in one terminal:

```powershell
$env:MONGODB_URI="mongodb://127.0.0.1:27017"   # or the Atlas URI
$env:MONGODB_DB="vively_harness"               # NOT vively
$env:SIGNUP_CODE="harness-signup-code"
$env:PORT="3120"
npm start
```

and the checks in another. **`MONGODB_DB` must not be `vively`.**
`check:guard` deliberately tries to empty and restore a workspace and
`check:save` deliberately conflicts; pointed at the live database they
would do that to real data. Changing only `MONGODB_DB` is enough — even
on the Atlas URI it isolates every write into a different database on the
same cluster. Drop `vively_harness` afterwards.

### Known test-environment quirks

- `check:uifixes` was already failing before this round of work, with the
  same failures after it. Believed stale rather than a regression — but
  there is no recorded baseline in the tree, so treat it as something to
  check rather than a settled fact.
- The Planner's four "days ago" tests fail under `TZ=America/New_York`.
  Pre-existing.
- One `check:bookadmin` step, "an unmatched booking is surfaced", is
  timing-flaky.
- `check:visit` needs calendar fakes; `check:syncskips` needs a server on
  port 3466.
- Playwright: `executablePath: '/opt/pw-browsers/chromium'` in the cloud
  container; locally `npx playwright install chromium`.

---

## 10. Running and deploying

```bash
npm install
npm start          # http://localhost:3000
```

Deploys to Render from `render.yaml` (Blueprint) or as a manual Web
Service. Frontend and backend are the same service.

### Environment

| Variable | What it does |
|---|---|
| `MONGODB_URI` | **required**; unset ⇒ the API answers 503 and the dashboard runs browser-only |
| `MONGODB_DB` | defaults to `vively` |
| `PORT` | defaults to 3000 |
| `SIGNUP_CODE` | gates signup; **unset closes signup entirely** |
| `STAFF_EMAILS` | who counts as staff |
| `NODE_ENV` | read in one place only: `production` makes the server ignore `IG_PROBE_BASE`. Cookie hardening is decided per request from `x-forwarded-proto` / `req.secure`, never from this |
| `NOTION_TOKEN`, `NOTION_API` | Notion sync |
| `GOOGLE_SERVICE_ACCOUNT`, `GOOGLE_CALENDAR_ID`, `GOOGLE_CALENDAR_API` | Calendar sync |
| `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_ACCOUNT_ID` | Instagram |
| `META_APP_SECRET`, `META_APP_BASIC_SECRET`, `META_INSTAGRAM_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` | Meta webhooks |
| `DIAGNOSTIC_KEY` | guards the collab diagnostic route |
| `IG_PROBE_BASE`, `PROBE_COOLDOWN_MS` | the collab probe |

`data/users.json` is gitignored and local-only.

---

## 11. Known gaps

### Still open from the 2026-10-19 audit (P1/P2)

- The partner page exposes email, gender and nationality fields.
- Day-sheet internal-note fallback can show a note not meant to leave.
- Full-campaign JSON export carries PII beyond payout details.
- `express.static` serves the repo root.
- No rate limiting on login.
- No `helmet`, no Origin checking.

### The React shell has drifted from production

As of 2026-10-25 it is further out: it has none of Today, Payouts, the
new rail (`SECTIONS`, `RAIL_HOME`), the grouped campaign tabs
(`CAMPAIGN_GROUPS`) or the account menu. Porting it means porting those.

`src/app/*` is hand-written and not in the manifest, so fixes made in
`index.html` never reach it. At least one is already out of step:
`src/app/App.jsx` still carries the old scroll behaviour that
[BUGS.md](BUGS.md) #6 fixed — it scrolls to the top unless a text field
has focus, instead of comparing the route. The shell is not what
production serves, so this is not urgent; it is a trap for whoever
finishes the migration. Either port the fix or decide the shell is
abandoned and say so in [../ARCHITECTURE.md](../ARCHITECTURE.md).

### Dashboard-level, deferred

Backups, PII separation, per-user roles (everyone with a session is equal
today), CI, observability.

### Design decisions, not bugs

- **Request mode is dead weight.** `requestExpiryHours` is written and
  never read at all; `schedule.mode` is read in exactly one place, where
  the desk payload passes it through, and **nothing anywhere acts on it**.
  Every booking is instant. The suggested message no longer pretends
  otherwise. Either implement it or delete both fields — leaving a setting
  that looks live but changes nothing is how the false 24-hour promise got
  into that message in the first place.
- **Cancel is deliberately not on the Desk.** Cancelling is a
  conversation, not a glance.
- **A booking cannot move between campaigns.** It belongs to the campaign
  that issued it.
- **The Desk needs the server.** The rest of the dashboard degrades to
  browser-only storage; the Desk says so plainly instead of pretending.

---

## 12. If you change one thing, remember this

1. Edit `index.html`, never `src/`. Run the five-step workflow. Leave
   `check:modules` clean.
2. A booking owns its time. Touching bookings means keeping four
   projection points in step.
3. Dates in UTC, "today" in Korea. Never mix `iso()` with
   `parseVisitSlot()`.
4. Treat a 409 as unresolved. Never adopt a revision without its data.
5. Write the test first when the bug involves two people, two campaigns or
   two timezones — that is where every expensive bug in
   [BUGS.md](BUGS.md) came from.
