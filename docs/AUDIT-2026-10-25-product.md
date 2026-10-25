# Product & UX audit — 2026-10-25

The 2026-10-19 audit covered security and data loss. This one asks a
different question: **does the dashboard help the team do the job, and does
it feel like a product?**

Method: every section rendered in a real browser at 1440px and 390px against
the harness seed (`tmp/seed.json`, booking routes over the fake DB),
screenshots in `tmp/shots/`, plus a read of the views behind them. Seed data
is synthetic, so a few numbers below may look worse than they do on the live
workspace. Each one is flagged where that applies.

---

## Status — same day

All six steps in §6 are built. The detail is in
[CHANGELOG.md](CHANGELOG.md), 2026-10-25.

| Item | State |
|---|---|
| B1 counts disagree | **Fixed.** One rule set, `todayItems()`; Home, Planner, the badge and Today all count it |
| B2 message carried the open link | **Fixed.** Per-creator messages in the send queue |
| B3 raw ER | **Fixed.** `erPct()`. Live data stores a percent; the seed now does too |
| B4 totals disagree | **Fixed.** Analytics reads the same rows as Home and Social |
| B5 empty trend chart | **Fixed.** Hidden until there are daily numbers |
| B6 overlapping pipeline labels | **Fixed** |
| B7 Desk empty state | **Fixed.** Links to each visit campaign's booking setup |
| B8 phone opens on a menu | **Fixed** for menu-only sections; real lists still open as lists |
| B9 "Generate for all 0" | **Fixed** |
| B10 duplicate-id banner | **Shortened** to one line. It still shows, because the problem is real until it is repaired |
| §4.1 Today | **Built** |
| §4.2 booking tedium | **Built:** auto-issue, send queue, presets, one-screen setup, roster status |
| §4.3 creator post links | **Built** |
| §4.4 visit-day pack | **Partly built.** Reminders are on Today; the day sheet is still on the Planner only |
| §4.5 payouts | **Built** |
| §4.6 bulk roster actions | **Not built** |
| §4.7 duplicate campaign, repeat-creator suggestions, weekly brand update | **Not built** |
| §5 nav and look | **Built** in `index.html`. The React shell was not updated |

The Save button was kept rather than removed (§5.2 suggested removing it):
`check:save` pins "a Save button to retry with, wherever you are", for a
history of silent save failures. It is quiet now, and turns primary only when
something is not saved.

---

## 1. Verdict

The engineering underneath is careful. Booking concurrency, the projection
rules and the privacy of the partner page are better than most commercial
tools. The surface doesn't show that care. It reads like an admin console
written by the person who built the database: every screen explains its own
implementation, zeros get the same weight as problems, and the only workflows
that save real time are the creator list and the booking link.

Three things would change that most:

1. **One "Today" queue that tells each person what to do next and lets them
   do it in one click.** Right now four separate engines compute "needs
   attention", and they disagree.
2. **Cut the friction out of booking.** Sending links is one creator at a
   time, and the suggested message points at the wrong link.
3. **A visual and copy pass.** Remove the developer narration, hide zeros,
   use one type system, and give the product a brand.

---

## 2. Bugs and trust problems found in the walkthrough

These come first because they undercut everything else. A dashboard whose
numbers disagree with each other stops getting opened.

| # | What you see | Where | Notes |
|---|---|---|---|
| B1 | **Needs-attention counts contradict each other.** Home says *3 campaigns behind schedule*. Overview → Needs attention says *0 / 0 / 0 / 0 — "this queue is clear"*. Sushikoji's Planner says *2 needs attention, 1 overdue (no post 44 days after the visit)*. | `model/homeStats.js:265`, `views/overview.js` (`alertsList`), planner, `deskChores` | Four independent rule sets. Merge them into one (see §4.1). |
| B2 | **The booking "Message to send with it" uses the open public link**, while the card above it says *always send the invite link*. Anyone who copies the suggested message produces unmatched bookings. | `views/booking.js:1253` | Easy to fix, and probably the cause of some of the manual matching work. |
| B3 | **ER is printed raw:** `0.041999999999999996%`. It also looks like a unit mismatch, since 0.044% should almost certainly read 4.4%. | `views/creators.js:134,244`; `views/campaigns.js:568,623,704,790` | Needs a `pctFmt()`. Check whether live data stores ER as a fraction or as a percent. The seed stores a fraction, and the edit form says "ER (%)". |
| B4 | **Total views disagree across pages.** Home 558,000; Social 558,000; Analytics → Portfolio trend 110K ("1 post across 4 campaigns"). | analytics vs homeStats/socialStats | Could partly come from the seed. Even so, these are different definitions with the same label. |
| B5 | **The Portfolio trend chart says nothing.** The y-axis reads 1, 1, 1, 0, 0 and the line is flat at zero next to a 110K headline. | Analytics → Portfolio trend | Hide the chart until daily data exists, and fix the tick formatter so it can't repeat a value. |
| B6 | **Pipeline stage labels overlap** on Home: "PlanningOutreachConfirming" is drawn on top of itself when those stages are 0. | Home, Campaign pipeline strip | Hide or collapse zero-width stages. |
| B7 | **The Desk empty state offers the wrong actions.** With 3 active campaigns and no booking set up, it offers *Import from Excel / Import from Notion / New campaign / Get the templates*. | Desk | It should say "Set up booking for Sushikoji, Juno Seoul…" and link straight to each campaign's Booking tab. |
| B8 | **Phone home is a menu.** Tapping Overview at 390px shows the sub-list (Summary / Needs attention…) instead of the summary itself. | Shell, mobile | On a phone, the first tap should land on content. |
| B9 | "Generate for all **0**" is shown as a live button. | Messages | Disable it or hide it at 0. |
| B10 | The duplicate-id repair banner sits at the top of Campaigns for every user, every visit. | Campaigns | Belongs in Setup → Data health, or behind one admin-only dot. |

---

## 3. Why it feels "AI" and "backend"

These are specific causes, not taste.

**The copy narrates the implementation.** There are 99 `card-sub`
explanation paragraphs in `index.html`. Examples:

- *"Contacted and Replied are folded into the first block: the Notion form
  never produces those stages, so all 12 pass through them untouched and
  three identical segments would imply movement that was never recorded."*
  This sits under the Home funnel.
- *"The invite link is the one to use: it knows who the creator is, so the
  booking matches itself to the roster and cannot become somebody else if it
  is forwarded."*
- *"Copy for Excel gives two columns — name in A, booking link in B — one row
  per creator…"*

These are good code comments and good docs. On screen they read as a machine
justifying itself. **Rule:** one short line of help at most, written as an
instruction ("Send each creator their own link"), never as a rationale.
Rationale goes in a `?` tooltip or in `docs/`.

**Monospace, uppercase, letter-spaced micro-labels.** The Home hero and the
Social overview use `TOTAL VIEWS`, `awaiting daily tracking`, `fills once
daily tracking begins` and `what this page cannot see yet` in mono. That is
terminal styling. It's the single biggest reason those two pages look
generated.

**Zeros get the same weight as problems.** Six "0 creators overdue"-style
rows in Needs attention; Social momentum tiles of `—` for RISING / GROWING /
STABLE / PLATEAUED; a flat chart. An empty metric should collapse into one
calm line ("All clear") or not render at all.

**System plumbing in the primary chrome.** The header carries search, the
save state, **Save**, a theme toggle, **Logout**, the avatar and **Export**.
Autosave exists (`index.html:1729`), so a manual Save button tells the user
the app might lose their work. "Notion not synced" appears on every campaign
card. "Not loaded from the server · Refresh" appears on the Planner.

**Three levels of navigation plus ten tabs.** Rail → panel → tabs, and a
campaign has **Planner, Roster & pipeline, Booking, Visit calendar, Content
review, Performance, Creator results, Messages, Brief, Report**. The panel
often repeats what the tabs already say (Overview's panel is four links).

**No brand.** The palette is default Material blue on grey, the font is
Roboto/system, selects use native styling, and every card has the same 1px
border and radius. Unicode glyphs (⌂ ◷ ▤ § ◫ ▶ ⚙) stand in for icons. Mixing
a dark hero card with light everything-else makes Home and Social look like
two different products.

**Settings exposed as decisions.** Booking setup asks for *Time zone*
(every venue is Seoul; REFERENCE §5 says so), *Close booking this many hours
before* and *Most people per booking* before you've done anything. Those are
defaults, so they belong behind "More options".

---

## 4. Making it useful — what to build

The team's actual loop for a restaurant or salon campaign:

```
find creators → DM → get a yes → book the visit → remind → visit happens
→ chase the post → capture link + numbers → report to the brand → pay the creator
```

Today the dashboard is strong at *find* (creator DB) and *book* (booking
engine). Every other step is either manual or exists only as a read-only
number. Ranked by time saved per week:

### 4.1 Today — one action queue (replaces Overview → Needs attention)

A single list, per person, of things that need a human, **each with its
action inline**:

| Item | Inline action |
|---|---|
| Confirmed, no booking link sent | **Send link** (see 4.2) |
| Link sent 48h+ ago, not booked | **Copy nudge DM** · Snooze |
| Visit tomorrow | **Copy reminder** (time, address, map link) |
| Visited N days ago, no post | **Copy chase DM** · Mark posted |
| Post live, no metrics in 3 days | **Update metrics** |
| Same creator booked twice in one day, over capacity, closed day | **Open on Desk** |
| Delivered, not paid | **Mark paid** |

One rules module feeds this list, the Home counts, the Planner badge and the
Desk chores, which fixes B1 for good. Done and snoozed state is stored per
item, so the list shrinks as you work. The nav badge shows the count.

### 4.2 Booking links without the tedium

The current flow has six steps: set up → rule → generate → *Make links* →
*Copy for Excel* → paste into a sheet → DM each creator by hand with a link
from that sheet. Proposed changes:

- **Auto-issue the invite** when a creator reaches *Confirmed* on a campaign
  that has booking set up. Nobody should have to press "Make links".
- **Send queue.** One row per creator with *their* message and *their*
  invite link already merged in (using the existing Messages templates and
  tone/language), plus **Copy & open DM** (`ig.me/m/<handle>`, or a Kakao
  link where it's known). The row records `sentAt` and moves to "Sent". This
  replaces the Excel round trip.
- **Fix B2.** The suggested message must use the per-creator invite URL.
- **Venue presets.** Save "Sushikoji: Tue–Sun 18:30/19:30, 2 per sitting,
  max 4/day" once and reuse it next campaign. A **Duplicate last booking
  setup** button would also cover this.
- **Collapse setup to one screen**: venue name + the weekly rule + Generate.
  Time zone, cutoff and party size become defaults behind "More".
- **Show status on the roster card** (link sent / opened / booked) so nobody
  has to switch to the Booking tab to see it.

### 4.3 Creators submit their own post link

Creators already have a manage page (`/book/manage/:token`). Add a field to
it, "Paste your Reel link when it's up", which writes to `socialContent` and
moves the stage to *Content in*. That removes the biggest manual chase in the
loop and reuses a page that already exists and already has the right auth
model.

### 4.4 Visit-day pack

From the Desk for any day: a copy-ready reminder for each creator (D-1) and
a one-page **day sheet** for the venue (who, when, party size, handle, photo).
The day sheet already exists in the Planner; it should be reachable from the
Desk and printable or shareable to the venue's manager by link.

### 4.5 Payouts

`payment.paidAt` is already captured in the participant drawer
(`index.html:3924`) but has no view. A **Payouts** list would show who is
owed what, which campaign, and since when, with **Mark paid** and a bank
transfer CSV. Payout details stay server-side as they are today.

### 4.6 Bulk actions on the roster

There is no multi-select today. Select rows → move stage / send message /
issue links / export. The pipeline board already supports drag; this covers
the 20-at-a-time case.

### 4.7 Smaller, cheap wins

- **Duplicate campaign** (brand, deliverables, booking preset, message
  templates).
- **"Worked well before" suggestions** when adding creators: past campaigns
  done, posted on time, views vs baseline. `model/suggest.js` already scores
  this, so it needs surfacing at the point of adding.
- **Weekly brand update** generated from the partner data, copy-ready for
  Kakao or email.

---

## 5. UI/UX direction

Concrete, in order of effort:

1. **Copy pass (1–2 days).** Every `card-sub` becomes one instruction or
   gets deleted. Rationale moves to `?` tooltips. Remove the mono micro-labels.
   Hide zero rows and empty tiles.
2. **Header clean-up.** Remove **Save** (autosave plus a quiet status dot that
   only speaks on error). Move Export, Logout and the theme toggle into the
   avatar menu. Show the integration state (Notion, Sheet) in Setup, not on
   cards.
3. **Design tokens.** One brand colour, one neutral ramp, one display face
   and one text face (e.g. Pretendard, which handles the Korean and Latin
   mix well), a proper icon set instead of Unicode glyphs, styled selects,
   and one light theme for the hero cards too. All of this lives in
   `:root` in `index.html`'s `<style>`, so it can be done without touching
   view logic.
4. **Navigation.** Rail: **Today · Desk · Campaigns · Creators · Content ·
   Payouts · Setup**. Messages folds into the campaign and the send queue.
   Contracts and Analytics move under Campaigns / Setup → Reports. Campaign
   tabs drop from 10 to 5: **Overview** (planner) · **Creators** (roster +
   booking status) · **Schedule** (booking + visit calendar) · **Content**
   (review + performance + results) · **Brand** (brief, report, partner
   link).
5. **Mobile first for Desk and Today.** Those are the two pages people use
   standing up. Home on a phone should be the Today list, not a menu (B8).

---

## 6. Suggested sequence

| Step | What | Why first |
|---|---|---|
| 1 | Fix B1–B9 | Cheap, and trust in the numbers comes before anything else |
| 2 | Booking: B2, auto-issue on Confirmed, send queue, venue presets | It's the workflow you named as tedious, and the engine is already solid |
| 3 | Copy pass + header + tokens | Biggest change to how it *feels*, low risk |
| 4 | Today queue (one rules module) | Turns the dashboard from a report into a to-do list |
| 5 | Creator post-link submission + Payouts | Closes the loop at both ends |
| 6 | Nav and campaign-tab consolidation | Bigger and needs the earlier pieces in place |

### A constraint on all of this

`index.html` (17.7k lines) is the source of truth, and every change goes
through the reanchor → rebuild → autoimport → check workflow. That's fine for
steps 1–5. Step 6 is the point to decide whether the React shell under
`src/app/` is the future, and if so, to build the new nav there instead of
reworking the old one twice. REFERENCE §11 already notes the shell has
drifted.
