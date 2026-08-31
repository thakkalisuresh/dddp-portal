# User guides

Two PDFs, regenerated from the running portal with one command.

```bash
npm run build:pages          # dist/ must be current
# start the dev server on :8788 (launch config "portal")

# The two demo logins the shots are taken through. Not in the repository:
# the same accounts exist on production, and 999… is an admin, so a literal
# in a tracked file would be a live credential published to GitHub.
export GUIDE_ADMIN_MOBILE=…    GUIDE_ADMIN_PW=…
export GUIDE_RESIDENT_MOBILE=… GUIDE_RESIDENT_PW=…

npm run guides               # capture, then build
```

Outputs land in `guides/out/`:

| File | For |
|---|---|
| `resident-guide.pdf` | 99 flats. Read on a phone, forwarded as a PDF |
| `resident-guide-print.pdf` | The same, greyscale-safe |
| `admin-handbook.pdf` | The committee. Eight sections, ordered as a month happens |
| `admin-handbook-print.pdf` | The same, greyscale-safe |

## Why it is built this way

**One stylesheet, two renderings.** `layout/guide.css` defines the portal's real
tokens, and an `@media print` block redefines *only those variables* — never a
component. The screen PDF is the portal exactly; the print PDF is hairline rules
and black text. There is no second layout to forget to update.

**Nothing carries meaning by colour alone.** Step markers are numbered badges, so
they survive greyscale, photocopying and colour-blind readers. That is why the
print rendering loses nothing but ink.

**Badges are drawn in CSS, not burnt into the image.** `capture.mjs` records the
*box* of each element being pointed at as a percentage of the image;
`lib/render.mjs` turns those into positioned badges. So badges stay vector-sharp
at print resolution, and the print stylesheet can restyle them without a single
capture being re-run.

**Figures are sized from the manifest.** Each capture's real dimensions are known,
so the width that makes a shot fit its page is arithmetic rather than guesswork.
`build.mjs` then *measures* every page against the A4 text block and fails the
build if one overflows — an overflowing page does not look broken in HTML, it
silently becomes two PDF pages and pushes every page number after it out by one.

## What capture does to the local database

All three are stashed and restored in a `finally` block. Nothing persists.

| Step | Why |
|---|---|
| Blanks `settings.demo_seed_ids` | Stops the Billing tab offering months that have not ended, which is what removes the orange "for testing" panel. The capture then matches production with no cropping |
| Uses the open month, and only creates one if none exists | Every seeded month is published and locked, so its steps render read-only. The guide needs an open month to teach against. It no longer hard-codes `2026-08` — that month is now seeded, locked and carrying 93 bills, and `INSERT OR REPLACE` on it would have reopened and then deleted a settled month |
| Stashes that month's readings, then fills them | Step 2 only shows an empty grid before any meter is read, and step 3 refuses to open until every one is in. Both states are needed, so the same month is photographed twice and the readings are put back afterwards |
| Gives demo residents an address, then takes it away | Step 3 reports who will be emailed. With the seed as-is it reads "0 of 93", which is true of the seed and false of the building |
| Blurs the treasurer's number | Text-node level, so the sentence around it survives. See `redactPhone` in `lib/portal.mjs` |

`prep-proofs.mjs` is run once by hand, not by `npm run guides`. It uploads the
fictional UniPay props through the **real** upload endpoint so the Proofs queue
has something in it — a row inserted straight into the table would render with
no image and no parsed amount, which is not what a treasurer ever sees.

```bash
node scripts/seed-notices.mjs     # the notice board starts empty too
node guides/prep-proofs.mjs
```

## Editing

- **Wording** — `content/admin.mjs`, `content/resident.mjs`. Data, not markup.
- **A screen changed** — edit its entry in `capture.mjs` and re-run. Selectors are
  text-based, and anything that fails to resolve is reported rather than dropped.
  A Billing-tab step is addressed by its visible title (`openStep`), and a fold
  whose summary carries a count is addressed by selector (`openDetails`).
- **Layout** — `layout/guide.css`. Change tokens, not components.

## Standing decisions

- **Roles, never names** in prose ("the Treasurer"). A printed guide outlives a
  committee; the screenshots show who currently holds the role.
- **The treasurer's number is redacted everywhere**, including in screenshots.
- **Version and date on the cover only.** Set with `GUIDE_VERSION`.
- **Superadmin screens are excluded** — Roster, Errors, god mode.
- **English.** Malayalam is a separate pass and needs a native speaker
  (`docs/BACKLOG.md` B2).

## Not done yet

- **Error documentation.** 28 of the 89 codes have user-facing wording
  (`EXPECTED` in `functions/lib/http.js`); the rest are operator alerts. Only the
  three proof-upload refusals are covered so far, on the resident guide's
  "If the upload is refused" page. The wider treatment was deferred.
- **`/forgot` is documented as working.** It is written for the world in which
  the association mailbox exists. Until it does, section 8 of the resident guide
  describes a flow that sends nothing — **these must not circulate before then.**
