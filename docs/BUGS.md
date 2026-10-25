# Bugs found and fixed

Each entry: the symptom as it was reported, what was actually wrong, what
changed, and the test that stops it coming back. The symptom is kept in
the words it was described in, because that is how it will be recognised
if something like it ever happens again.

The pattern worth noticing: in five of the seven below, the reported
symptom and the cause were in different parts of the system. "The dates
are wrong" was a timezone call. "My edit doesn't save" was three missing
projections. "Partner links get deleted" was a conflict handler. Guessing
from the symptom would have fixed none of them.

---

## 1. Partner links got lost and deleted on their own

> *"we have up to 3 people using the dashboard so sometimes the partner
> links are lost and get automatically deleted"*

**Cause.** Two bugs, both in the save path, and both only visible with
more than one browser open.

The workspace is one document. The client holds the whole thing and POSTs
it back, with `revision` as an optimistic lock: if somebody else saved
since you loaded, the server refuses with 409. The 409 handler *adopted
the server's new revision number without taking the server's data with
it.* So the next autosave carried your stale copy with a revision the
server now accepted — and overwrote whatever the other person had just
added. Partner links were simply the first thing anyone noticed going
missing.

Second: `beforeunload` fired a `sendBeacon` POST with `force: true`, which
skips the revision check entirely. Closing a tab could therefore
force-write a stale workspace over a fresh one. A regression test written
for the first fix caught this one still destroying the other browser's
link, which is the only reason it was found.

**Fix.** The 409 handler records the server's revision as
`SERVER.conflictRevision` and does *not* adopt it — the conflict stays a
conflict until it is resolved with real data. The unload beacon no longer
sends `force`; it requires only that the server copy actually arrived this
session (`SERVER.loadedOk`).

**Held by.** `tools/save-reliability-page.mjs` — two browsers, one
workspace, a link added in each.

---

## 2. A booking moved by staff did not stick

> *"when i click on the edit or move after the creator has selected their
> choice im unable to see the change — even if i move and click on save —
> when i refresh the original date and time that the creator has chosen
> has been saved"*

**Cause.** Three missing projections, not one.

Bookings live in their own collections and are authoritative. The roster
row's `confirmedVisitAt` is a *projection* of the booking onto the
workspace. `applyBookingSlots` existed to do that projection — and ran on
`POST /api/workspace` only. So:

1. the client never projected locally, so the change was invisible
   immediately;
2. `GET /api/workspace` never projected, so a reload re-read the old
   workspace value and showed the creator's original time;
3. the save response carried corrections the client threw away.

**Fix.** `applyBookingTimesLocally()` runs at the end of `loadBooking`;
`GET /api/workspace` applies the projection on the way out and returns
what it changed as `bookings`; `adoptBookingFixes()` consumes that on the
client. The Desk does the same thing with `deskProject()` after a move.

**Also found while fixing it.** `clearBookingSlot` was dead code —
cancelling relied on it and therefore cleared nothing. Cancellation now
clears through the projection, which is the only path that can see the
whole picture.

**Held by.** `tests/booking.test.mjs` (28 tests, including the cases
where cancelling must clear the projected time), plus
`tools/booking-admin-page.mjs`, which moves a booking and then *reloads*
before asserting — a test that does not reload cannot see this bug.

---

## 3. The same bug again, from the Planner tab

> *"the booking change bug looks like its solved from the booking tab —
> but when i click it from the planner tab i am still unable to change the
> timeslot"*

**Cause.** The Planner's confirm drawer offered its own date and time
inputs for a row that already had a booking. Two fields claiming the same
truth: whichever was written last won, and the booking collections never
heard about it.

**Fix.** A booked row in the Planner drawer no longer gets date/time
inputs. It gets the same **Move booking** control the Booking tab uses, so
there is one way to change a booked time and it goes through the booking
routes.

**Held by.** `tools/planner-page.mjs`.

---

## 4. Weekly rules landed on the wrong day

> *"on sunday i choose 5:00 until 5:00 — i should only see 1 slot …
> however it ends up creating the same open days as the rest — it does not
> listen to the table"*

**Cause.** A timezone mistake, one line wide. `iso()` formats a date in
**UTC**; `parseVisitSlot()` builds one at **local midnight**. The rule
engine mixed them. In Korea (UTC+9) local midnight is 15:00 UTC the
previous day, so every rule date was read as the day before: Sunday's
single sitting was generated onto Saturday, and Thursday quietly vanished.

**Fix.** Rule dates are built and read in UTC throughout — `ruleDate()`
plus `getUTCDay()`, never the local-time equivalents. The comment in the
code says why, because it is exactly the sort of line someone tidies back
into `getDay()`.

**Held by.** 6 timezone and weekday tests in
`tests/booking-rule.test.mjs`. Run the suite under `TZ=Asia/Seoul` and
`TZ=America/New_York` — mixing the two is only visible away from UTC.

---

## 5. The daily cap could be walked straight past, in silence

Found while verifying the cap, not reported.

**Cause.** *Max teams per day* and the seats in a sitting are two
different limits. The staff move only checked the seats. Moving somebody
into an empty time on a day already at its cap went through with no
warning and no record.

**Fix.** The staff move now counts the target day, refuses with
`409 day_full` unless the caller passes `overDaily`, and when it is
overridden writes `overDailyLimit` on the booking plus a history entry
carrying the limit, the count before, and — because with three people on
one desk *"who moved this?"* is the question that gets asked — the email
from the session. The Desk surfaces the overrun afterwards as
"*venue* has N teams on *day*".

Moving within the same day never trips it: the day's count is unchanged.

**Held by.** `tools/booking-api.mjs` and `tools/desk-page.mjs`, which both
assert the warning *and* that the override was recorded.

---

## 6. Every click jumped the page back to the top

> *"when i click on the down arrow next to a date or any button in the
> booking tab - it keeps taking me to the top after every click - which is
> inconvenient"*

**Cause.** `render()` ended with `window.scrollTo(0, 0)`, and the single
exception was "a text field inside the view has focus". Expanding a date,
blocking a day, ticking a box — none of those involve a text field, so
every one of them threw the page to the top. On a Booking tab holding a
fortnight of dates that meant scrolling back down after each click.

**Fix.** What earns the top of the page is no longer *was somebody
typing*, it is *did the route change*. `render()` remembers the page it
last drew (`section/item/tab`) and only scrolls to the top on arriving
somewhere new; a redraw of the page you are already on restores the exact
position. This fixed the same annoyance everywhere in the production app — roster,
creator list, settings, the Desk. It did **not** reach
`src/app/App.jsx`: that file is hand-written rather than generated from
`index.html`, so the React shell being built beside production still has
the old behaviour. Noted under **Known gaps** in
[REFERENCE.md](REFERENCE.md).

**Held by.** The "a click is not a navigation" block in
`tools/booking-admin-page.mjs` — six checks, four of which assert the
scroll position. They scroll the control into the middle of a short
viewport first, so the click itself cannot be what moved the page, and
they compare the offset exactly rather than settling for "not zero".

On the run that confirmed the fix, the two scroll checks printed
`1747 -> 0` and `1758 -> 0` against the old code and `1747 -> 1747` and
`1758 -> 1758` against the new. The offsets themselves are measured at
runtime from a 480px viewport, so expect different numbers — what matters
is that the arrow points back to where it started.

---

## 7. The suggested message promised a confirmation that never came

**Cause.** The Share card's suggested message branched on
`schedule.mode`, defaulting to `'request'`, and said *"We'll confirm your
time within 24 hours."* Nothing in the system reads `mode`: every booking
is instant and the creator's page confirms on the spot.

**Fix.** The branch is gone. The message says the booking is made
immediately, with a comment above it explaining that branching on a
setting nothing reads is how the false promise got there.

---

## Smaller fixes from the 2026-10-19 audit

- **Settings were silently dropped** on load in one path.
  `applyStoredSettings()` now runs on every load path.
- **Downloaded backups carried payout details.** `stripPayout()` is
  applied to every file that leaves for someone's Downloads folder; the
  server copy keeps them. `tests/privacy.test.mjs` (10 tests).
- **Signing out left the whole workspace in the browser.** `signOut()`
  calls `clearPersisted()`, and `clearPersisted()` clears all six
  collections rather than three.
- **An empty workspace could replace a full one.**
  `server/workspace-guard.js` refuses a payload whose campaigns, creators
  and participants are all empty unless the caller states the intent
  `replace-with-empty`. `tests/workspace-guard.test.mjs` (19 tests).
- **Duplicate record ids.** `newId()` used a fixed-seed PRNG that
  restarted the same sequence on every page load, so two campaigns
  created in two sessions could get the same id.
  `tests/duplicate-ids.test.mjs`.

---

## Two bugs the tests found before the code shipped

Worth recording because they argue for writing the test first.

**The clash detector could not see the same person twice.** It keyed on
the roster row, and a roster row is per campaign — so one creator booked
at two restaurants read as two different people. That is the single case
the Desk exists for. Now keyed on the creator, falling back to the roster
row, then the handle (`deskKey()`).

**`deskMins('9:30')` returned nonsense.** It sliced fixed character
positions out of the string, so a one-digit hour parsed as `NaN` and
sorted to the front. Now a regex with two capture groups.
