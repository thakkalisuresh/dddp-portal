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

## B16 — Notices are resident business, not public

Asked for 2026-08-09, and the reasoning is the whole of it: a notice is the
association talking to the people who live here. Nobody outside the building
needs to read it, and some of what a committee posts — a meeting about a
defaulter, a security incident, a plumber's phone number — is nobody else's
business at all.

Today `publicNotices` in `functions/lib/public.js` serves the full **title and
body** of every active notice to anyone who loads the homepage. Comments were
already held back, because they carry names and flats; the notice text was not.

**Do this before the first real notice is posted.** There are zero notices in
production right now, so today it costs one deleted section. Afterwards it does
not: a notice that has been served publicly has been fetched by crawlers, and
withdrawing it from the site does not withdraw it from anybody's index. This is
the only item here with a genuine deadline, which is why it sits at the top.

Small: drop `notices` from the public payload and the section from
`public/js/home.js`. The endpoint stays — it also carries `committee` and
`amenities`, which are legitimately public. Residents lose nothing, because
`/notices` is already its own tab in the bottom nav.

### Does the landing page change? No — but something must ship with it

Raised at the same time, and worth answering here rather than rediscovering it.

Leave the landing page as the bill. That is a decision, not an accident: C3 says
a resident who lands on an empty dashboard concludes the site is useless, and
the reason they were sent a login in the first place is that they owe money.
Notices are the second thing they came for, and they already have a tab.

The real consequence is subtler. Today a resident sees notices on the homepage
**without logging in** — that is where they'd notice one. Take that away and
notices do not become private, they become invisible: nothing anywhere tells a
resident a new one exists, so the committee posts into a room nobody enters.

So the removal needs a companion, and it is small: a count or a dot on the
Notices tab when there is something newer than that resident has seen. Perhaps
`notices_seen_at` on `owners`, stamped when they open the tab. Without it this
change quietly turns the notice board off.

Related: **B9** proposes a `scope` column so some notices are owner-only. If
that lands, `public` becomes a deliberate third value — an evacuation notice or
a road closure could still be posted outward on purpose — rather than the
default everything gets today.

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

## B15 — An embedded map on the homepage

Asked for 2026-08-09, and it reverses the third bullet of B11, which settled on
a plain Maps link precisely to avoid an embed. Worth reopening — a map you can
see beats a link you have to trust — but the reason it was closed is a real
constraint rather than a preference, so the entry keeps it.

**An iframe is blocked today.** The CSP in `functions/lib/http.js` is
`default-src 'self'` with no `frame-src`, so it falls back to `'self'` and a
Google or OpenStreetMap iframe silently does not render. This is the one that
will waste an afternoon: nothing errors, the box is just empty. Note that
`frame-ancestors 'none'` is unrelated — that stops the portal being framed, not
the portal framing something.

Three ways out, cheapest first:

* **A static map image, self-hosted.** A screenshot of the location saved into
  `public/img/`, wrapped in a plain link to Maps. No CSP change, no key, no
  third party, works offline, and is what `public/img/upi/` already does and
  says why. Loses pan and zoom.
* **An OpenStreetMap iframe.** Needs `frame-src https://www.openstreetmap.org`
  added to the CSP, but no API key, no billing account and no Google. This is
  the sensible middle.
* **The Google Maps Embed API.** Needs a key, and a key needs a billing account
  on somebody's card — against goal 2, and the whole reason the old site's
  embed is unreachable is that it was keyed to a person who left.

The decision is therefore not "embed or link" but **how much CSP to spend**, and
that is worth one deliberate answer rather than a default. The static image
needs no decision at all and could ship with B11 today.

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

## B17 — A status-first home, when there are four things to route between

Raised 2026-08-09, after looking at MyGate and NoBrokerHood. Both open on a
tile grid, and the question was whether the portal should too. Shape agreed,
deliberately not scheduled — the trigger is below.

**Why they have a hub, and we do not.** MyGate carries accounting, billing,
visitors, facility booking, helpdesk, vendors, assets, security and forums;
NoBrokerHood is visitors, payments, notices, forums, services and a help desk.
A grid is what you build when there are eight to twelve destinations. This
portal has three — Bill, Notices, Me — and they are all already visible in the
bottom nav. A router for three doors you can see is a tap added to the one
thing the resident came for, and C3 is explicit that the thing they came for is
their own bill. It would also be the visual signature of the general-purpose
society platform the PRD lists as a non-goal.

**What is worth taking** is not the grid but the direction MyGate's own home
moved in: quick actions and unified updates, so the screen answers "is there
anything I need to do" rather than listing places to go. Concretely:

* the bill stays first and largest, with Pay on it
* one notice row beneath it, present only when there is something unread
* two shortcuts — upload proof, past bills
* the bottom nav is untouched at three tabs

**The trigger: a fourth real destination.** Maintenance billing, a helpdesk,
facility booking — something with its own state worth a tile. At three, this
is the dashboard with a notice strip, which is B16's job anyway.

**It overlaps B16 almost entirely, and that is the useful finding.** Taking
notices off the public page makes them invisible unless something signals a new
one; that signal is this design's notice row. Build it once, in B16. If that
happens, most of B17 is already shipped and what is left is genuinely the grid
— which is the part to keep not building.

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

## B14 — Late fee exemptions — DONE 2026-08-09

Per-resident exemption with an end date and a reason, plus the waive button
that had been missing since phase 6b.

Not a plain on/off, deliberately. A boolean gets set during a dispute, the
dispute resolves, and nobody unsets it — two years later it is invisible policy
and "why has 4B never paid a late fee" has no answer anybody can find. A date
makes renewing a decision and forgetting a no-op, which is the right way round.
The reason is required because the committee turns over at every AGM.

`waiveLateFee` had existed as an audited endpoint since phase 6b with nothing
in the interface calling it, so waiving needed god mode. Both now live on one
Late fees panel, because "who is being charged" and "who has been let off" are
the same question asked twice and splitting them is how a standing exemption
stops being noticed.

LATE-FEE-EXEMPT in `npm run doctor` is the third guard: the date stops an
exemption lasting forever, and the check stops it going unnoticed while it runs.

## B13 — Two holes in the late-fee path — STILL OPEN

Deliberately NOT fixed alongside B14, since they are different problems. A
rejected proof still returns a bill to `initiated`, which the cron holds rather
than charges, so a resident who has any screenshot rejected becomes immune. And
the hold on `initiated` still has no time limit. Neither has ever fired:
production has no periods and no bills.

## B8 — Tenancy — DONE 2026-08-09

`relationship` on `owners`, values `owner` and `tenant`, set by an admin.
Researched against real products first: ApnaComplex uses two fields, MyGate has
the owner add their own tenant. We took neither, and the reasoning is in the
migration.

One decision worth remembering: most society systems bill the OWNER because
they are maintenance systems, and maintenance is a charge against the property.
Gas is metered consumption, so it follows whoever burned it.
