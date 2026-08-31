# Splitting the dashboard into modules

The dashboard was one 7,800-line `index.html`: 650 lines of CSS, 7,000 lines
of JavaScript, 242 functions and 328 names sharing a single scope. It works,
and it is still what `/` serves. This document is about the version being
built beside it.

## Where things are now

```
index.html          the app in production today, untouched
src/
  main.jsx          entry point
  index.html        entry document for the build
  styles.css        the stylesheet, moved out verbatim
  app/              the React shell: routing, rail, panel, tabs, auth, theme
  lib/              no domain knowledge: dates, number formatting, csv, xlsx, rng
  model/            the workspace: DB, persistence, creators, stats, calendar
  ui/               DOM helpers and the HTML-string builders the views still use
  charts/           the hand-rolled SVG charts
  import/           Excel import, Notion sync, spreadsheet metrics
  sync/             Google Sheet sync
  docs/             .docx writer and the contract documents
  views/            the section renderers, still writing HTML strings
tools/              the scripts that made and check the split
tests/              node --test over the extracted logic
```

Nothing in `src/lib`, `src/model`, `src/import` or `src/docs` was rewritten.
Every one of those files is a range of lines lifted out of `index.html` with
`export` added to its top-level declarations and an import header naming what
it used to read off the global scope.

## Two things did change, and both on purpose

**The data layer no longer calls the renderer.** `persist()` and the Notion
and Excel importers used to call `render()` and `updateSaveBadge()` from the
middle of the data layer. They now announce instead — `notify()` for "the
workspace changed", `notifyStatus()` for "only where it is saved changed" —
and the shell subscribes. The split matters: a save finishing repaints one
badge, and must not tear down a drawer or a half-filled form.

**Inline `onclick=` needs globals.** The views that still build markup as
strings carry ten inline handlers. `src/app/globals.js` puts exactly those
ten names on `window` and lists why. That file shrinks as views become
components, and disappears when it is empty.

## How to check the split changed nothing

```bash
npm run check:modules   # every name resolves, every import is really exported,
                        # and every module still matches index.html byte for byte
npm test                # the logic that earned a bug this year, pinned down
npm run check:browser   # walks the routes through both versions and diffs the
                        # words on screen  (needs: npx playwright install chromium)
npm run check:calendar  # drives the Google Calendar sync against a stand-in
                        # Google and counts what lands on the calendar
npm run check:partner   # opens a partner link in a browser and checks that
                        # nothing belonging to anyone else is in the page
```

## The partner view

A partner's point of contact gets one unguessable link and no login. The rows
are assembled in `server.js` (`buildPartnerRows`), not in the browser, so bank
details, internal notes, fees, addresses and every campaign belonging to
someone else are absent from the response rather than merely hidden in the
page. `tests/partner.test.mjs` asserts that by searching the serialised
payload for values that must not appear.

Comments live in their own `partner_comments` collection, not in the workspace
document. The workspace is saved with an optimistic revision check, so writing
a partner's comment into it would collide with whoever has the dashboard open.

Payout details never leave the server copy: they are excluded from the Sheet
sync by its explicit column list, stripped from the workspace backup download
and the per-campaign hand-off by `stripPayout`, and masked on screen.

### After editing index.html

`src/` is derived from `index.html`, so an edit there leaves the two out of
step. To bring them back:

```bash
python3 tools/reanchor.py <(git show HEAD:index.html)   # move the line ranges
node tools/rebuild-split.mjs                            # rewrite src/
node tools/autoimport.mjs <changed-module.js> ...       # refresh import headers
npm run check:modules
```

`tools/reanchor.py` maps each range through a diff rather than matching line
text. Only the *starts* are matched — those are banner comments or
declarations. Ends come from the next range's start, because ranges tile the
file in order and several boundaries are a blank line, of which there are
hundreds to align against wrongly. It then checks no module reaches into its
neighbour and refuses to write if one does.

A module added to the manifest by hand carries `current: true`, meaning "these
ranges are already in today's coordinates, do not map them". `rebuild-split`
clears it once the file is written, because from that point the manifest is
the new baseline — a `current` flag that survives into a commit tells the next
re-anchor to skip a module, and its neighbour then swallows it.

`tools/split.mjs` is the record of the extraction: for each module, the exact
line ranges of `index.html` it came from and a checksum of the result. It is
re-runnable until the views become components, at which point `index.html`
stops being their source and the script has done its job.

## Running the two side by side

```bash
npm install
npm run build     # builds the React app into dist/next
npm start         # /  = the original dashboard
                  # /next = the React one
```

`npm run dev` serves the React app on :5173 with hot reload and proxies
`/api` to :3000, so run `npm start` in a second terminal.

Render builds with `npm install && npm run build`; if the build is missing,
the server simply does not mount `/next` and `/` carries on as before.

## What is left

The shell is React. The panels inside it are still the original renderers
writing into one node, which is why the two versions agree route for route.
They convert one at a time — smallest first — with the parity check run after
each one. When the last view is a component, `/` points at the build,
`index.html` is deleted, and `src/ui/html.js` and `src/app/globals.js` go
with it.
