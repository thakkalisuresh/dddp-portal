# Backlog

Deferred deliberately. Everything here was raised, considered, and parked — not
forgotten. Items keep their number for life so commit messages stay meaningful;
the ORDER is priority, so the top of this file is what to do next.

Reviewed 2026-08-09.

---

# Blocking the cutover

Nothing else matters until the building is actually using this. Production has
the schema for 99 flats, four committee accounts, and **no bills**.

## C1 — The roster

Flat, name, mobile, owner/tenant, for ~99 flats. Everything to consume it is
built and deployed (`/admin/roster`): paste, preview, import, then a worklist
for sending logins with sent/logged-in tracking.

The only genuine blocker, and it is a people problem rather than a software
one. Collecting it from a committee is measured in weeks.

## C2 — Meter walk and the first month

There is no migration from the old portal — nobody can reach its hosting — so
month one starts from a physical read of every meter. That is also the first
time the arithmetic touches real data: the 2.60 conversion factor, the
round-up, and the whole billing path have only ever run against tests and seed.

**Run `npm run doctor` after generating and before anyone sees a bill.**

## C3 — Order of operations

Import the roster, walk the meters, generate the month, THEN send the logins.
A resident who logs in to an empty dashboard concludes the site is useless and
does not come back. One message, and what they find is their own bill.

---

# Waiting on you, small

## W1 — A Gmail account and its OAuth credentials

Unblocks **two** things, both built and inert:

* `/forgot` — self-service password reset. Live, accepts requests, sends
  nothing. `npm run doctor` reports MAIL-NOT-CONFIGURED.
* The **nightly Drive backup**, which has never run once (B12).

Needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`,
`MAIL_FROM`, plus `GOOGLE_BACKUP_FOLDER_ID` for the backup. The refresh token
needs an OAuth consent round-trip, which wants a terminal rather than a phone.

## W2 — Emails for Joy, Mukesh and Hari

Three of four accounts have no email, so they cannot reset their own passwords
even once W1 is done. Add them from god mode. `npm run doctor` names them under
NO-EMAIL-ON-FILE.

---

# Ready to build

## B10 — Expire admin-issued temporary passwords

The reset message used to claim "expires in 24 hours" while nothing enforced
it. The copy is honest now, but the gap is real: a temporary password sent over
WhatsApp works forever, and those messages persist on both phones for years,
get forwarded, and survive a handset changing hands. It is the one credential
in this system deliberately sent in the clear.

Shape: `pw_expires_at` on `owners`, set when an admin issues one, checked at
login only while `must_change_pw = 1` so it never touches a password the
resident chose. An expired one should say so and point at `/forgot` rather than
failing as "wrong password". Perhaps thirty lines and a test.

## B11 — Homepage parity with the old site

The photographs were rescued, but three things on `gas.dddp.online` were never
carried across and are still missing:

* office hours (Mon–Fri 9–18, Sat 10–16, Sun emergency only)
* a Maps link to Kuriachira, Thrissur — a plain link, NOT their embedded API key
* a subject dropdown on the contact form, so messages arrive sorted

Small and self-contained. Worth doing before the demo dry-run (B4), since that
is exactly when the committee compares old against new.

## B9 — Owner-only notices

Borrowed from ApnaComplex, which scopes some notices to owners. AGM papers,
sinking-fund decisions, anything with a vote attached is owner business, and a
tenant seeing it is noise at best.

Cheap now that `relationship` exists: a scope column on `notices`, filtered by
the viewer. Decide at the same time whether an absent owner sees them (they
should — they are the audience) and whether comments are scoped too (they must
be, or the scope leaks through replies).

---

# Decisions, not code

## B3 — Buy a domain

Currently `diamondpark.pages.dev`. A domain costs money, which is the one
constraint the whole project was built against, so it needs a decision rather
than a default. Cloudflare Pages adds no hosting cost once the domain is paid.

## B4 — Demo dry-run before cutover

Walk the committee through the site on real-looking data before any resident
sees it. There is no migration path, so this is the only rehearsal available.
Do B11 first.

## B5 — Residents with no email at all

Self-service reset is built, so anyone with an address can recover unaided.
What remains is the people with none. `npm run doctor` reports the count as
NO-EMAIL-ON-FILE, and onboarding now explains why an address is worth giving,
so coverage should grow on its own.

**Do not build anything here until the roster is in and the number is known.**
If it turns out to be two households, an admin reset is the right answer and
always was.

## B1 — Language toggle (English ⇄ Malayalam)

Replace the side-by-side bilingual labels with a real toggle. Agreed as the
right end state; parked because the toggle itself is the small part.

28 keys in `public/js/i18n.js` at 10 call sites, against ~58 explanatory
sentences hardcoded in English. Today a weak translation is survivable because
the English sits beside it. Under a toggle it is the only thing on screen.

Known risk worth testing FIRST: Malayalam runs long. "Upload screenshot" is
roughly 3x wider. If the nav cannot hold the real strings, that changes the
labels, not the CSS.

Blocked by B2.

## B2 — Malayalam review by a native speaker

The 28 existing strings are unreviewed. Best use of a resident who reads
Malayalam: generate the full English list as two columns and have them fill the
second. Better than asking them to audit guesses.

Blocks B1.

## B7 — An AI triage step inside the portal

**Recommended against, mostly.** The diagnostics work (`npm run doctor`, the
Health tab) came out of this and covers the useful part.

Fixing: no. An LLM with credentials to change bills, roles or payment status in
a live financial system, with nobody between the decision and the write, is a
bad trade at any accuracy.

Explaining: little gain. The destination is an assistant that reads the raw
report anyway, so a second model summarising first adds a lossy step, a secret
to rotate, and the chance of debugging from a confident summary that is wrong.

Where it would genuinely help: plain-language error-code explanations for
residents in English and Malayalam, and overnight triage saying which of the 57
codes is new versus routine. Both read-only, both additive to the report.

## B12 — The nightly Drive backup has never run

Written in phase 8, deployed, never configured. No Google secrets have ever
been set, so `runBackup` returns early every night and nothing is copied
off-site. The only backups that exist are the ones taken by hand during this
work, sitting in a scratchpad directory that does not survive the session.

Unblocked by W1 — it shares the same OAuth credentials as email.

Worth adding a doctor check once it is on: a backup that silently stops looks
exactly like a backup that is working, which is the failure the digest
staleness check already exists for.

---

# Done

## B6 — Telegram alerting — DONE 2026-08-09

Bot created, secrets on both deployments, delivery proven end to end: a
deliberate DDP-AUTH-004 produced a real alert and no DDP-SYS-004 followed,
which is how success is confirmed without seeing the recipient's phone.

Traps worth keeping, all of which cost time: secrets do not cross between the
two deployments; Pages secrets bind only to a NEW deployment; "Save version"
stages while "Deploy" publishes; and a stopped digest is indistinguishable from
a quiet night without the watermark check.

## B8 — Tenancy — DONE 2026-08-09

`relationship` on `owners`, values `owner` and `tenant`, set by an admin.
Researched against real products first: ApnaComplex uses two fields, MyGate has
the owner add their own tenant. We took neither, and the reasoning is in the
migration.

One decision worth remembering: most society systems bill the OWNER because
they are maintenance systems, and maintenance is a charge against the property.
Gas is metered consumption, so it follows whoever burned it.
