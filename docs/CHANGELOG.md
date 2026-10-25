# What changed

Newest first. One entry per piece of work, with what it was for, where it
lives, and what proves it. For the things that were broken rather than
missing, see [BUGS.md](BUGS.md). For how any of it works, see
[REFERENCE.md](REFERENCE.md).

Nothing below has been committed. Every change is sitting in the working
tree of `vively-dashboard` for review — `git status` and `git diff` will
show the lot.

---

## 2026-10-25 — Today, Payouts, the send queue, and a new look

**Why.** The product audit ([AUDIT-2026-10-25-product.md](AUDIT-2026-10-25-product.md))
found the dashboard useful for two things: the creator list and the booking link.
Everything after a creator says yes was manual, four pages disagreed about what
needed attention, and the screens explained their own implementation.

**What changed, in six steps.**

1. **Bugs.** ER printed raw (`0.041999999999999996%`), now `erPct()` everywhere.
   Analytics' total views came from a different source than Home and Social
   (110K vs 558K), so it now reads `overviewKpis(overviewRows())`. Its daily
   chart is hidden until there are daily numbers to draw. Zero-width pipeline
   stages no longer overlap their labels. The Desk's empty state offers "Set up
   *campaign*" instead of imports. On a phone, sections whose panel is only a
   sub-menu open on content. "Generate for all 0" is hidden. The duplicate-id
   banner is one line.
2. **Booking links.** Confirmed creators get their invite link automatically,
   under the safe scope only (a widened scope still needs the button). The
   Share card is now a **send queue**: one row per creator with *their* message
   and *their* link (Korean or English), **Copy message**, **DM ↗**
   (`ig.me/m/<handle>`), and a status (Not sent → Sent → Nudge after 2 days →
   Booked). Copying records `participant.bookingLinkSentAt`. The old suggested
   message carried the open link; that is gone. Setup is one field plus
   "More options". Generating a rule saves a **venue preset**
   (`SETTINGS.venuePresets`), and the next campaign can start from it. Roster
   cards show "booking link sent · not booked". The send queue sits at the top
   of the tab once times exist.
3. **Look.** Pretendard replaces Roboto and Roboto Mono. Uppercase monospace
   micro-labels are now sentence case. One violet accent and warm neutrals,
   defined in `:root`, so a rebrand changes four tokens. Home and Social heroes
   follow the theme instead of being always-black. Styled selects, focus rings,
   8px buttons. Developer-voice notes are removed from Home, Social, Booking,
   Desk and Planner. The header is search, save state, a quiet Save that turns
   primary only when something is unsaved, and an account menu holding theme,
   export and log out.
4. **Today** (`#/today`, the new landing page). `todayItems()` in
   `views/planner.js` is the one rule set: send link, nudge, visit reminder
   today/tomorrow, did they come, post overdue, parcel with no word, content to
   review, pay, blacklisted or caution on a roster, applications waiting,
   campaign behind, post link sent in, and the Desk's clashes when the server
   is up. Every row has its action inline. Copy reminder writes `reminderFor`,
   copy chase writes `chasedAt`, and Later writes `todaySnooze`. Home's card,
   the Planner's "Needs attention" and the rail badge all count this list.
   `#/overview/attention` redirects here. Only dated facts are used, never the
   back-filled stage timestamps.
5. **Creators submit their post link** from the booking page they already have
   (`POST /api/book/manage/:token/post`, stored in `post_submissions`, never in
   the workspace). It appears on Today with **Accept**, which runs the same
   `setContentUrl` + `moveStage('submitted')` as typing it into the drawer.
   **Payouts** (`#/payouts`): to pay / not due yet / paid, Mark paid, and a CSV
   of names and amounts. Bank details are masked on screen and never written
   to the file. `payInfo()` treats a fee-only row as owed.
6. **Navigation.** The rail is Today · Desk · Campaigns · Creators · Content ·
   Payouts · Reports · Setup, with SVG icons. Messages, Contracts and Analytics
   still route, and the rail lights the section that now holds them
   (`RAIL_HOME`). Reports' panel carries Overview and Analytics; Setup's
   carries the contract documents. A campaign's ten tabs are six groups
   (Planner, Creators, Schedule, Content, Messages, Brand), with a sub-switch
   inside a group. Every old tab URL lands where it did. The six-number stat
   row shows only on Roster, Performance and Creator results.

**Also.** `tools/autoimport.mjs` compared backslash paths on Windows and
silently skipped every file. Fixed.

**Proof.** `tests/today.test.mjs` (12 tests). `planner.test.mjs` now asserts the
Planner count is the Today list. A post-submission section is in
`tools/booking-api.mjs`. `check:bookadmin`, `check:planner` and `check:crflags`
are updated for the new copy and navigation. 556/556 under `TZ=Asia/Seoul` and
`UTC`. `check:booking`, `desk`, `planner`, `staffedits`, `crflags`, `partner`,
`sheetmetrics`, `bookpage` and `bookrace` are clean. `check:bookadmin` has the
same two failures it had before this work (the timing-flaky unmatched check, and
Windows clipboard `\r`). The server-backed harnesses (`check:home`, `phone`,
`save`, `social`, `sooverview`, `uifixes` and the rest) were **not run**: they
need Mongo on :3120.

**Not done.** The React shell (`src/app/`) was not touched and is now further
from production. See REFERENCE §11.

---

## 2026-10-21 — The Desk

**Why.** Three restaurant campaigns were running at once. Answering "what
is happening today" meant opening three Booking tabs and holding the
clashes in your head. There was no page that asked the question once.

**What it is.** A new top-level section, second in the rail, at `#/desk`.
It reads a seven-day window across *every* campaign in one request and
never touches the workspace document.

- **Band of five** — visits today and heads expected, venues open, things
  needing a person, bookings this week, people booked twice in one day.
- **Next up** strip, then a seven-day row where each day carries its count
  and how many things need looking at.
- **"Needs a person" queue** — the same creator at two restaurants
  (urgent under three hours apart, noted beyond), a sitting over capacity,
  a venue past its *Max teams per day*, somebody booked on a closed day, a
  holiday with visits on it, a blacklisted or caution creator, an unmatched
  open-link booking, and links sent that were never used.
- **Venue grid** — a column per venue, a row per time. Drag a card onto a
  free time to move it, or use **Move**, which only ever offers that
  venue's own times. **+ time** adds one time to one day without touching
  the weekly rule. Attendance buttons on past visits.
- **By creator** view, search (`/` focuses it), ←/→ to change day, a
  20-second poll that *says* somebody else changed something instead of
  redrawing under your hands, and **Put it back** after any move.
- The panel on the left narrows the whole page to one venue.
- Korea time throughout. The only clock that matters is "today", which is
  the Korean day rather than the browser's.
- On a phone the grid stacks; the Desk took Social's place in the bottom
  tab bar and Social moved under **More**.

**Decisions taken.** No timezone control — every venue is in Seoul and a
slot is already wall-clock at the venue. Cancel is deliberately *not* on
the Desk: cancelling is a conversation, not a glance. A booking cannot be
moved between restaurants, because it belongs to the campaign that issued
it.

**Where.** `index.html` (region extracted to `src/views/desk.js`),
`GET /api/booking/desk` and `GET /api/booking/desk/meta` in
`server/booking-routes.js`.

**Proof.** 16 unit tests in `tests/desk.test.mjs`; 40 browser checks in
`tools/desk-page.mjs` (`npm run check:desk` — two of them only run when
the seed has a second bookable creator); and the desk-endpoint section of
`tools/booking-api.mjs`, from "the desk answers with a default window of
its own" to "a move with no count change still shows as a change".

---

## 2026-10-21 — Honest wording on the suggested message

The Share card's suggested message branched on `schedule.mode` and told
creators *"We'll confirm your time within 24 hours."* Nothing reads
`mode`: every booking is instant, and the creator's own page has always
said 예약이 확정되었습니다 — "your booking is confirmed". The message was
the only thing lying. It now says the booking is made on the spot, and the
branch is gone with a comment saying why it must not come back.

Request mode itself was considered and dropped — see **Known gaps** in
[REFERENCE.md](REFERENCE.md).

---

## 2026-10-20 — Shipment tracking on the roster

For parcel campaigns (anything whose `kind` is not a store visit),
each confirmed creator now carries carrier, tracking number, shipped date
and delivered date. Setting a shipped date moves the row to the
**Shipped / Booked** stage. A parcel that has been shipped for more than
ten days without being delivered reads as late.

Lives in the participant drawer; summarised on the roster. Store-visit
campaigns never show the fields. `tests/shipment.test.mjs` (8 tests),
plus checks in `tools/creator-flags-page.mjs`.

---

## 2026-10-20 — Hangang Cool Rain campaign setup

A setup sheet was written for the one campaign from the brand brief,
rather than an importer for Google Form briefs in general. One campaign
did not justify a parser, and a parser nobody feeds goes stale.

---

## 2026-10-19 → 20 — Booking availability, as a venue actually describes it

A run of changes to the availability card, each from a real gap:

**Times per day, not a fixed five.** `slotsPerDay` is now an explicit
number. A venue that takes one sitting a night gets one time; three gets
three, spread across the arrival window the venue gave, first time at the
window's open and last at its close.

**Max teams per day.** A separate limit from the seats in a sitting —
*"the restaurant has asked for only one team to visit"* could not be
expressed before. `0` means as many as the times allow, which is what
every schedule written before this did. Enforced server-side on the public
confirm, the creator's own move and the staff move.

**Group editing.** Mon–Fri (or any set of days) given the same window in
one action, instead of five identical edits.

**Breaks.** A lunch break blocked inside the arrival window: 11:00–17:00
with 14:00–15:00 out generates around the gap rather than through it.

**Reset, and a Proceed button.** The dates below the card are now
generated by an explicit action, and can be cleared and re-run after
changing the options above.

**Extending the period without losing anything.** Changing the From/To
dates and applying adds the new days and leaves every existing date,
time and booking exactly as it was.

Rule engine and card in `index.html` (`src/views/booking.js`);
44 tests in `tests/booking-rule.test.mjs`.

---

## 2026-10-19 — Who gets a booking link

**Confirmed-only is now the default and the safe one.** Generating links,
**Copy for Excel** and the CSV all cover confirmed creators only.
Blacklisted and dropped creators are never included under any setting.
The broader scopes — *Shortlisted and up*, *Everyone on the roster* — live
behind an **Advanced** control, each labelled "includes unconfirmed
creators", with a banner and a one-click way back while an override is on.

**Copy for Excel is two columns.** `Name` and `Booking Link`, copied as
both tab-separated text and an HTML table, so pasting into Excel or Google
Sheets puts the name in column A and the link in column B. Only creators
who actually hold a link are listed — a blank link cell is how the wrong
person gets sent nothing. The richer five-column export is still there as
a separate CSV download.

`tests/booking-links.test.mjs` (20 tests).

---

## 2026-10-19 — Security and data audit, and the P0 fixes

A full read of the dashboard for ways in and ways data leaks, prompted by
partner links disappearing with three people using it at once. The report
is [AUDIT-2026-10-19.md](AUDIT-2026-10-19.md), kept here beside this file.
Everything it rated P0 was fixed the same day — the partner-link loss, the forced unload beacon, settings
being dropped on load, payout details in downloaded backups, and a logout
that left the workspace in the browser. Each is written up in
[BUGS.md](BUGS.md).

The P1 and P2 items are listed under **Known gaps** in
[REFERENCE.md](REFERENCE.md) and are still open.
