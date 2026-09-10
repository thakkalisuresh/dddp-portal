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
- **`/forgot` is documented as working**, by the user's decision of 2026-08-31.
  Section 11 of the resident guide v2 assumes the association mailbox exists. If
  it does not, a resident following that section gets no email, and the portal's
  reply is deliberately vague about whether anything was sent, so they are not
  told it failed. The hold that used to sit here has been lifted deliberately;
  it was not forgotten.

---

## Two resident guides, same words

The approved content lives in both layouts. Pick one and delete the other when
you have decided; keeping both indefinitely is how they drift apart.

| Build | Command | Output | Pages | Median fill |
|---|---|---|---|---|
| Original A4 | `node guides/build.mjs` | `resident-guide.pdf` | 18 | ~55% |
| A5 rebuild | `node guides/build-resident.mjs` | `resident-guide-a5.pdf` | 24 | ~70% |

`content/resident.mjs` feeds the original A4 layout; `content/resident-v2.mjs`
feeds the A5 one. **Both carry the same approved wording**, so a correction has
to be made twice until one is retired.

Check either with `node guides/page-fill.mjs [--legacy]`, where `--legacy` means
the original A4 build.

## The A5 rebuild

Rebuilt from scratch: new content, new design, same capture pipeline.

```bash
npm run build:pages
# start the dev server on :8788 (launch config "portal")

export GUIDE_RESIDENT_MOBILE=…  GUIDE_RESIDENT_PW=…
node guides/capture.mjs --resident-only
node guides/shot-email.mjs        # the two emails, rendered from their own functions
node guides/build-resident.mjs    # -> resident-guide.pdf and -print.pdf
node guides/page-shots.mjs        # optional: one PNG per page, to look at
```

| File | What |
|---|---|
| `content/resident-v2.mjs` | Every word. Data, not markup |
| `layout/resident.css` | A4, both page treatments, and the greyscale token swap |
| `lib/render2.mjs` | Markup builders |
| `build-resident.mjs` | paged.js -> PDF (the A5 build only) |
| `page-shots.mjs` | PNG per page, for looking at without a PDF rasteriser |
| `page-fill.mjs` | How full each page is. Catches orphaned headings and empty pages |
| `shot-email.mjs` | The bill email and the reset-code email |
| `lint-prose.mjs` | Wikipedia:Signs of AI writing, as a check |

**A5, not A4.** One task is not enough content for an A4 sheet: at A4 either the
type has to grow past readability or half of every page stays blank. A5 puts the
same words at the same size on a page they fill, is the better shape on a phone,
and prints two-up on A4 for anyone who wants paper. `page-fill.mjs` reports the
fill of every page; the guide currently runs a median of about 70% with nothing
below 49%.

**Two page treatments, one document.** `.sheet--split` puts the screenshot beside
the instructions and carries most of the guide. `.sheet--single` gives one action
a whole page and is used only for section 6, because paying is the step people
get wrong and the cost of getting it wrong is a payment nobody can match to a
flat.

**Why paged.js.** Chrome implements `@page` size and margins but not the margin
*boxes*, so `@bottom-right { content: counter(page) }` prints nothing. The first
build worked around this by writing a page number into every page as data and
measuring each page for overflow. paged.js paginates in the browser, fills the
margin boxes and counts pages itself, so nothing numbers a page by hand. It also
means the built HTML paginates in an ordinary browser, not only through the
build.

**Served over HTTP, never opened as a file.** paged.js re-fetches every
stylesheet with XHR to parse the `@page` rules. Chrome gives each `file://`
document an opaque origin, so those fetches are refused and the polyfill rejects
with a bare `ProgressEvent`. Both scripts start a throwaway server on a random
port rooted at `guides/`.

**Greyscale is a token swap.** `body.mono` redefines the colour variables and
nothing else — no component is restyled, so the print build cannot drift from the
colour one. Every step is a numbered badge, so greyscale loses ink and nothing
else.

**The emails are rendered from their own functions**, not mocked. Note they are
not the same kind: `announcementEmail()` returns `{subject, html, text}` and the
bill email really is HTML; `resetEmail()` returns `{subject, text}` only, and the
reset-code mail is plain text on purpose — it carries no link, because mail
scanners follow links and a followed link carrying a credential is worse than a
code.

### Still open

- **Snapzy annotation was not possible.** Snapzy is `LSUIElement = 1`, a menu-bar
  agent with no regular application presence, so the automation layer cannot
  resolve or target it. Every badge in the guide is generated from the capture
  manifest instead. If hand-annotated hero shots are still wanted, the shots in
  `out/shots/` can be marked up by hand and dropped back in under the same names.
- **The demo account is a TENANT.** `canSeeNotice` hides `scope: "owners"`
  notices from tenants, so those render as "That notice could not be found"
  rather than as a notice. Any shot of an owners-only notice needs an owner
  account.

---

## The committee guides (v3 pipeline)

> **Draft. Not signed off, and expected to change.**
>
> The wording, the section order and the page count are all still open, and
> the committee has not reviewed any of it. Do not print a run, and do not
> circulate the PDFs as the association's documentation yet. Treat what is
> here as a working version: edit `content/admin-v3.mjs` and rebuild.
>
> The pipeline underneath it — the capture pass, the overflow check, the
> prose lint — is not draft in the same way, and the portal fixes that came
> out of building these are independent of whether the guides ship at all.


A spine plus reference sheets, on the same pipeline as the resident v3 guide —
same stylesheet, same device frame, same overflow check.

```bash
# 1 · capture, at the RESIDENT viewport. The admin console is mobile-first.
export GUIDE_ADMIN_MOBILE=…  GUIDE_ADMIN_PW=…
node guides/capture.mjs --admin-phone      # -> out/admin-phone-shots.json

# 2 · build
GUIDE_WHATSAPP=91XXXXXXXXXX node guides/build-admin.mjs
```

| File | What |
|---|---|
| `content/admin-v3.mjs` | Every word. `spinePages()` and `sheetPages(id)` |
| `build-admin.mjs` | 13 documents: the spine in three trims, five sheets in two |
| `layout/resident-v3.css` | Shared with the resident guide, unforked |

**Why a phone capture.** Every dense admin screen is a flex row with
`min-width: 0` or an `auto-fit minmax()` grid — none is a fixed-width table. So
the console shoots at 390×844 and reuses `device()`, the measured badge rail and
the phone trim with no new machinery.

**`--admin-phone` sets `hasTouch`.** The thumb-reachable bottom bar is gated on
`@media (pointer: coarse)` (`public/css/app.css:391`) and Playwright's default
context is `pointer: fine`. Without it a 390px capture renders the wide-screen
nav at phone width — a screen nobody has ever seen, and it fails silently
because the shot still looks like a phone. The resident MOBILE passes now set it
too, so re-running `capture.mjs` will change those shots. That is a fix, but it
is a change: the older resident guides' figures move.

**A separate manifest.** `--admin-phone` writes `out/admin-phone-shots.json`,
never `shots.json` — the A4 handbook and the two older resident guides are still
built from that one, and merging would replace their figures invisibly.

**`GUIDE_PLACEHOLDER=1`** builds with hatched boxes instead of screenshots, so
pagination can be checked without a login. Its figure heights are the capture
spec's `clipTo` values, not measurements, so treat its overflow report as close
rather than final.

### Still open

- **The captures have not been run.** Every figure is unverified until they are.
- **The tab strip wraps.** `.tabs` is `flex-wrap: wrap` (`public/admin/index.html:11`);
  at 390px six tabs wrap to two or three rows, so no tab holds a stable
  position. That is the failure the console's own comment blames for the old
  fourteen-tab strip. Decide before the orientation figure is shot.
- **`/admin/readings.html` is a redirect stub** kept "for a release or two".
  Nothing here names that URL, but a printed guide outlives a release.
