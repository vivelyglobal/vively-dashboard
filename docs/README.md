# docs

Six files. Start wherever your question sits.

| File | What it answers |
|---|---|
| [REFERENCE.md](REFERENCE.md) | How the dashboard works, and the rules you must know before changing it: the `index.html` → `src/` workflow, the data model, every API route, the booking engine, time, concurrency, the test suite, env vars, known gaps. **Read §2 and §12 before your first change.** |
| [CHANGELOG.md](CHANGELOG.md) | What was built and changed, newest first, with why and what proves it. |
| [BUGS.md](BUGS.md) | Every bug found and fixed: the symptom as reported, the real cause, the fix, and the test holding it down. |
| [AUDIT-2026-10-19.md](AUDIT-2026-10-19.md) | The security and data-loss audit. P0 items are all fixed; P1/P2 are still open and listed in REFERENCE §11. |
| [AUDIT-2026-10-25-product.md](AUDIT-2026-10-25-product.md) | The product and UX audit: what was missing, why it felt like a backend, and what was built in response. |
| [HANGANG-COOL-RAIN-SETUP.md](HANGANG-COOL-RAIN-SETUP.md) | The setup sheet for that campaign, from the brand brief. |

[../ARCHITECTURE.md](../ARCHITECTURE.md) covers the module split in more
detail than REFERENCE §2 does.

## The short version

- **`index.html` is the source of truth.** Modules under `src/` listed in
  `tools/manifest.json` are generated from it. `src/app/*` is not.
- **After editing `index.html`:** `tools/reanchor.py` →
  `tools/rebuild-split.mjs` → `tools/autoimport.mjs` →
  `tools/rebuild-split.mjs` → `npm run check:modules` clean.
- **A booking owns the time it booked.** The roster row's visit time is a
  projection of it, maintained in four places.
- **Dates in UTC, "today" in Korea.** Never mix `iso()` with
  `parseVisitSlot()`.
- **Never point a test at the `vively` database.** See REFERENCE §9.
