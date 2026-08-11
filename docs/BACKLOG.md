# Backlog

Deferred deliberately. Everything here was raised, considered, and parked — not
forgotten. Items keep their number for life so commit messages stay meaningful;
the ORDER is priority, so the top of this file is what to do next.

Reviewed 2026-08-11.

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

---

# Decisions, not code

## B3 — Buy a domain

Currently `diamondpark.pages.dev`. A domain costs money, which is the one
constraint the whole project was built against, so it needs a decision rather
than a default. Cloudflare Pages adds no hosting cost once the domain is paid.

## B4 — Demo dry-run before cutover

Walk the committee through the site on real-looking data before any resident
sees it. There is no migration path, so this is the only rehearsal available.
B11 is done, so this is no longer blocked.

## B18 — Email as a second login identity

Raised 2026-08-10, out of a worry about owners living abroad. Parked until the
list of usernames from the old portal turns up: that says what residents already
expect to type, which is the one input none of the analysis could supply. Until
then login stays the mobile, taken as ten bare digits, `91…` or `+91…` — all
three already land on the same stored number through `normaliseMobile`.

**Email is not credential-grade today, and that is the real finding.** `mobile`
is the only UNIQUE identity column; `email` is nullable and not unique, so two
residents may share one right now. Onboarding and `PATCH /api/me` are the only
two write paths that skip `normaliseEmail`, so an address can be stored mixed
case and untrimmed. `npm run doctor` reports a shared address as a **warn**,
correctly — today it means one reset inbox for two people. As a login it would
mean one account for two people, and that severity would be wrong.

Which is to say email is where the mobile was before 0009, and 0009 is the
template if this is ever built: canonicalise the data, route every path through
one function, then add the unique index and let it start meaning something.
Two things would be worth doing whatever is decided about login — the index, and
requiring the current password to change your own email, since a stolen session
plus `/forgot` is otherwise a permanent takeover.

Worth knowing before weighing it up: **2 of 107 accounts have any address at
all** (B5 and W2 are the same fact from other angles), so this is a door almost
nobody could use on the day it shipped.

**One live bug hides in here.** The login field is `type="tel"
inputmode="numeric"` — a digit keypad with no `+`. An owner with a foreign
number cannot type their own login on a phone. Harmless so far because every
stored number is `+91`; a text input fixes it in one line, and should not wait
for the rest of this.

## B19 — A pay link in the bill email

Raised 2026-08-11. The idea was to put a `upi://` link in the body of the bill
email so a resident taps once, straight from Gmail into their UPI app with the
amount already filled. **The link half cannot be built. The email half should
be, and is nearly free once W1 lands.**

**Gmail deletes it.** Custom URL schemes are stripped from `href` during
sanitisation, so the resident sees text that will not click. The known
workaround stacks several `href` attributes hoping one survives the sanitiser,
which is invalid HTML that other clients render their own way. That alone ends
the `upi://` version, before any argument about whether it is a good idea.

**And it would not fire if it arrived.** A tap still asks Android to resolve
`upi://`, which is the thing that already does not work — see STATE.md, "The
Android payment failure". Email changes nothing about resolution and usually
makes it worse, since email links open in an in-app WebView, which refuses
custom schemes more readily than Chrome.

**The phishing objection was raised and is weaker than it first looks.** UPI
resolves the payee from the registry and shows the NAME on the confirmation
screen, so a spoofed mail pointing at a scam VPA announces itself as somebody
else before any money moves. Banks and utilities send payment links routinely.
The idea is legitimate; it is the plumbing that refuses, not the ethics.

**What to build instead**, when there is an account to send from:

> Your July bill is ₹289, due the 10th. **[View and pay]**

An ordinary `https` link to that resident's bill. Same single tap, and it lands
somewhere that can adapt to the handset — the OS chooser, the QR, the copyable
UPI ID, or the proof upload if they have already paid. It renders in every
client, and forwarding it is harmless because the destination needs a login.

`lib/mailer.js` and `lib/digest.js` already exist, so this is a template and a
send, not a subsystem. **Blocked on W1** for the same reason `/forgot` is: there
is no account to send from. Worth doing in the same sitting as W1 rather than
as its own project.

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
facility booking — something with its own state worth a tile. At three, this is
the dashboard with a notice strip.

**B16 shipped the unread signal**, which was the overlapping half. What remains
is genuinely the grid — the part to keep not building.

## B5 — Residents with no email at all

Self-service reset is built, so anyone with an address can recover unaided.
What remains is the people with none. `npm run doctor` reports the count as
NO-EMAIL-ON-FILE, and onboarding now explains why an address is worth giving,
so coverage should grow on its own.

**Do not build anything here until the roster is in and the number is known.**
If it turns out to be two households, an admin reset is the right answer and
always was.

## B1 — Language toggle (English ⇄ Malayalam)

Still the agreed end state. **The half-measure is gone**: the side-by-side
bilingual labels were removed 2026-08-10, along with the Manjari face and the
`.ml` class, because a second word in a span was an unreviewed guess sitting
next to every English label — a promise the app could not keep. English-only is
honest; a toggle would be better; the thing in between was neither.

So this now starts from nothing rather than from 28 keys, which changes less
than it sounds: the registry was never the source of truth, and the ~58
explanatory sentences hardcoded across the screens always were the real body of
work. The old strings are in git if they are ever worth reviving as a starting
draft — `git show 4bba0ab:public/js/i18n.js`.

Known risk worth testing FIRST, unchanged: Malayalam runs long. "Upload
screenshot" is roughly 3x wider. If the nav cannot hold the real strings, that
changes the labels, not the CSS.

Blocked by B2.

## B2 — Malayalam strings, from a native speaker

Nothing to review any more — there are no Malayalam strings in the app. What is
needed is the strings themselves, which was always the better shape: give a
resident who reads Malayalam the full English list as two columns and have them
fill the second, rather than asking them to audit somebody's guesses.

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

**Still true, and still blocked on W1** — it shares the same OAuth credentials
as email, plus `GOOGLE_BACKUP_FOLDER_ID`.

**The watching half is now built (2026-08-10).** `runBackup` writes a
`last_backup_at` watermark to `settings` on an upload that returned, mirroring
the digest's, and `checkBackup` reads it: BACKUP-NOT-CONFIGURED while the
secrets are missing, BACKUP-NEVER once configured but before the first 3am run,
BACKUP-STALE past 48 hours. The Export tab shows the same fact in words a
treasurer reads — "Last copy written 3 days ago", or "No copy has ever been
written".

That check is what makes the rest safe to switch on. `backupHealth` only ever
answered "would the token work right now", which is the reassuring half: a
refresh token issued in OAuth "Testing" mode expires after seven days and the
upload then stops silently, looking exactly like a folder nobody opened. Only
the watermark separates the two.

Doctor now reports BACKUP-NOT-CONFIGURED against production, so the silence is
at least visible while it lasts. Also removed: the Export tab used to state
flatly that "a copy is also sent to the committee Drive folder every night",
which has never once been true.

What remains is entirely W1: set the four secrets, publish the OAuth consent
screen to Production, then confirm the watermark advances after the first 3am
run rather than trusting that it did.

---

# Done

## B16 — Notices are resident business — DONE 2026-08-09

`publicNotices` served the full title and body of every active notice to anyone
who loaded the homepage. Comments were always held back because they carry
names and flats; the notice text never got the same treatment. Deleted rather
than left behind a flag.

Done when it was free: production had zero notices, so it cost one deleted
section. After the committee starts posting it costs a crawler's memory, which
withdrawing a notice does not reach.

The badge is the other half — `notices_seen_at` on `owners`, stamped when the
board is opened, carried on `/api/me` because every screen renders the nav from
that payload. Without it, removing notices from the public page would not make
them private so much as invisible. Not stamped while impersonating.

**The trap, found in a browser and invisible in the source:** the table holds
timestamps in two spellings — `postNotice` writes ISO from JavaScript, SQL
written with `datetime('now')` writes a space where the T goes — and compared
raw, the space sorts BELOW the T, so a later notice reads as older and the
badge silently stops appearing. Both sides go through `datetime()` now, with a
1970 fallback rather than `''`, because `datetime('')` is NULL and would take
the comparison with it.

## B9 — Owner-only notices — DONE 2026-08-09

`scope` on `notices`, values `all` and `owners`, defaulting to `all` so every
existing notice keeps meaning what it meant. AGM papers and sinking-fund
decisions are owner business; a tenant cannot act on the agenda.

Absent owners are the audience, not an edge case — `relationship` says nothing
about presence, and a landlord abroad is exactly who an AGM paper is for.

One predicate, `canSeeNotice`, with four callers: the list, the single notice,
the comment endpoint and the unread badge. Four copies of a visibility rule is
four chances for one to be wrong, and the wrong one is the leak. Comments are
scoped or the scope leaks through replies; the badge is scoped or a tenant
carries a permanent count for a notice they can never open. Admins are exempt,
because the console lists notices through the resident endpoint.

Caught while wiring it: `session.actor` carries no `relationship` — only
`subject` does. Passing actor left it undefined, which read as "not a tenant".

## B13 — The late-fee hold now ends — DONE 2026-08-09

Two holes that turned out to be one: a hold with no clock.

A rejected proof used to return the bill to `initiated`, which the cron holds
rather than charges, so one rejected screenshot made a resident permanently
immune. Rejection now returns it to `unpaid`; where charging is harsh, the
treasurer has the waive button from B14.

The hold on `initiated` had no end either, so tapping Pay was an exemption
anybody could grant themselves. It now runs seven days from `claimed_at`, which
is set only when NULL — refreshing it per tap would restore the whole hole for
the price of opening the app each night.

**The catch unit tests could not make:** the cron's own SELECT did not fetch
`claimed_at`. It would have arrived undefined, read as "no claim", and charged
every held bill on the first run — while every test passed, because they hand
the decision a bill object and never go through that query.

## B11 — Homepage parity — DONE 2026-08-09

Office hours and a contact subject dropdown. Sunday reads "emergencies only",
never "closed", and there is a test that says so: a gas smell does not respect
office hours.

The subject was nearly free — `messages` has had the column since 0002 and
`submitMessage` always bound it, but no form ever sent one. Same shape as
`waiveLateFee` before B14. Showing it in the admin console is half the change;
a dropdown nobody can see the result of sorts nothing. Options are served from
the constant the server validates against, and an unrecognised subject becomes
null rather than an error — a message rejected over its dropdown is a message
lost.

The Maps link became B15.

## B15 — An embedded map — DONE 2026-08-09

Google Maps, pinned on the building, with no API key.

**Shipped as OpenStreetMap first, and that was wrong.** The entry had been
written from B11's note — "NOT their embedded API key" — without anybody
opening the old site. gas.dddp.online is still up, and looking at it settled
in one minute what had been guessed at: it frames
`google.com/maps/embed/v1/place?q=dd%20diamond%20park%20kuriachira&key=AIza…`.

Two facts came out of that iframe. Google knows this building **by name**,
which OpenStreetMap does not — so the OSM version could only centre on the
neighbourhood with no marker, while `q=dd diamond park kuriachira` drops a pin
that reads "DD Diamond Park". And the key is the only genuinely unusable part
of it: it belongs to a Google Cloud project nobody in the association can
reach, the same account problem as the old hosting and the old domain, so
copying it would put the map on a stranger's billing and end it the day they
restrict the key.

`output=embed` is the keyless form — no key, no Cloud project, no card. It is
undocumented rather than unsupported, so the "Open in Google Maps" link stays
as the way out if Google ever retires it.

CSP allows `https://maps.google.com` **and** `https://www.google.com`: the
first 301s to the second, and a frame navigation is checked at every hop, so
listing one silently blanks the map. `test/headers.test.js` pins the whole
policy and greps the page source for `AIza` and `key=`, because a key would be
pasted into the iframe URL rather than into the header.

**`loading="lazy"` left the map permanently blank** — scrolled into view,
waited five seconds, load event never fired. The empty box this item warns
about, caused by the guard against it. Removed for the map; the six gallery
photographs keep it, images honour lazy.

The lesson worth more than the map: the old site is READABLE. Anything the new
one is supposed to match can be checked in a browser instead of remembered in
a backlog entry.

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

## B8 — Tenancy — DONE 2026-08-09

`relationship` on `owners`, values `owner` and `tenant`, set by an admin.
Researched against real products first: ApnaComplex uses two fields, MyGate has
the owner add their own tenant. We took neither, and the reasoning is in the
migration.

One decision worth remembering: most society systems bill the OWNER because
they are maintenance systems, and maintenance is a charge against the property.
Gas is metered consumption, so it follows whoever burned it.
