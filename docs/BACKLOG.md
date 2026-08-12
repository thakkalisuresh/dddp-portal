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

Unblocks `/forgot` — self-service password reset, live, accepting requests and
sending nothing. `npm run doctor` reports MAIL-NOT-CONFIGURED.

It **no longer blocks the nightly backup** (B12), as of 2026-08-11: the backup
authenticates as a committee member's personal Google account, so it needs no
association Gmail. Sharing one account was always the reason W1 blocked two
things at once.

Needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` and
`MAIL_FROM`, from an account that belongs to the association — 99 residents will
read that From line, and their replies have to reach the committee. The refresh
token needs an OAuth consent round-trip, which wants a terminal rather than a
phone: `npm run google:auth -- mail` is that step, and its header lists what to
set up in the Google console first. Set the secrets on **both** deployments;
see B12.

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

## B23 — The app row sends people to install apps they already have

Raised 2026-08-11, out of the device run recorded in STATE.md under "The Android
payment failure". Observed, not theorised: on the handset tested, PhonePe was
installed but registered to no account, and tapping the PhonePe button went to
the Play Store listing for PhonePe.

That is `intent://` behaving exactly as designed — an addressed intent whose
package answers nothing falls back to the store — and the fallback was added
deliberately, because the alternative was a button that did nothing at all. It
is still the right behaviour for an app that genuinely is not installed. The
defect is narrower: **the portal cannot tell the two cases apart, and one of
them insults the resident.** Being told to install software you are already
looking at reads as the site being broken, which is worse than the silence the
fallback was introduced to fix.

A web page cannot enumerate installed packages — that is the same wall the whole
investigation ran into, and no amount of cleverness gets around it. So this
cannot be fixed by detection, only by wording and ordering. Cheapest honest
version: the plain `upi://` chooser already leads on Android and only offers
apps that actually answer, so the named row below it could say what it is for —
something admitting that a named button may offer to install the app — and the
existing "did not accept the link" warning could cover the store bounce too,
since returning from the Play Store is itself a signal the tap failed.

Small, and worth doing before residents see this. It costs a sentence and
possibly a `pagehide` check, and the failure it prevents is the one that makes
somebody give up and not pay.

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

That second argument is now **dead, and B19 survives it.** The device run on
2026-08-11 found every link shape resolving on a properly set-up handset, so
"resolution does not work" can no longer be leaned on here. The verdict does not
move, because the two arguments were independent and that is exactly why both
were written down: Gmail's sanitiser strips the scheme before resolution is ever
reached. The WebView half of the claim also still holds — the run had to route
around WhatsApp's WebView deliberately to get a valid result at all, which is
evidence for that point rather than against it.

**The phishing objection was raised and is weaker than it first looks.** UPI
resolves the payee from the registry and shows the NAME on the confirmation
screen, so a spoofed mail pointing at a scam VPA announces itself as somebody
else before any money moves. Banks and utilities send payment links routinely.
The idea is legitimate; it is the plumbing that refuses, not the ethics.

That paragraph was reasoning from the spec when it was written. It is now
observed: the device run of 2026-08-11 reached a confirmation screen showing the
payee name, the amount and the note, from a link built by this codebase. The
protection it describes is real and works.

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

## B12 — The nightly Drive backup — CONFIGURED 2026-08-11, first run unproven

Written in phase 8, deployed, and never configured until now: no Google secrets
had ever been set, so `runBackup` returned early every night for months and
nothing was copied off-site. The only backups that existed were taken by hand
during that work, in a scratchpad directory that did not survive the session.

**Configured on 2026-08-11.** All four `GOOGLE_BACKUP_*` secrets are set on both
deployments, both are deployed, and `npm run doctor` reads BACKUP-NEVER rather
than BACKUP-NOT-CONFIGURED.

**It has still not run.** `google:auth` proved the credentials and the folder by
uploading a real check file, which is a different claim from "the nightly job
works": the cron firing, `runBackup` completing against 105 residents and 898
bills, and the watermark advancing are all still unobserved. The morning of
2026-08-12 is the check, and BACKUP-NEVER disappearing is the only evidence that
counts. This entry stays open until then.

If it fails instead, it will say so — Telegram alerting is live and `runBackup`
reports through `reportError`, so a failed upload pages the treasurer rather
than passing as a quiet night.

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

**The terminal half is now written (2026-08-11).** `npm run google:auth -- backup`
does the consent round-trip end to end: it mints the refresh token, writes one
small real file into the Drive folder — which is the only way to find out before
3am that the folder id is wrong, or the account cannot write to it, or the Drive
API was never enabled — and prints the commands that put the secrets on both
deployments. Nothing is written to disk; `wrangler secret put` prompts, so the
token never reaches shell history either.

**The backup runs under its own Google account** (decided 2026-08-11). Drive
charges a file to the account that created it, so the account that authenticates
is the account whose quota fills; the committee would rather spend its 15 GB on
its own documents than on this. `GOOGLE_BACKUP_CLIENT_ID`,
`GOOGLE_BACKUP_CLIENT_SECRET` and `GOOGLE_BACKUP_REFRESH_TOKEN` override the
shared trio for the upload path only, and fall back to it when unset — one
account remains a valid and simpler setup.

The mail path deliberately does NOT follow. `/forgot` emails 99 residents their
reset codes, and that From line should read as the association rather than as
whichever member set this up; the replies should reach the committee too. So
`sendEmail` stays on the shared credentials and only `uploadToDrive` and
`backupHealth` take the override.

Two things this costs, and they are worth writing down rather than discovering:
the export carries every resident's name, mobile, email and payment history
(never passwords — `NEVER_EXPORT`), so the holder is keeping the association's
records personally; and when that person leaves the committee this is an account
to replace, not a folder to move. Size is not among the costs — production D1 is
639 kB entire, so a nightly bundle is a few hundred kB and a year is well under
200 MB.

**Doctor was checking the wrong deployment.** `driveSecrets()` asked Pages only,
because it was copied from the mail check, where Pages is the whole answer —
mail sends from the request path. The backup does not: it runs from the cron
Worker. Secrets set only on Pages would have produced an all-clear from doctor
AND a healthy "token is valid" line in the Export tab, while `runBackup`
returned early every night. Both deployments are now asked, and the two halves
are separate findings — BACKUP-CRON-UNCONFIGURED (warn: nothing is being
written, and everything says otherwise) and BACKUP-PAGES-UNCONFIGURED (info: the
copies are fine, the tab reporting on them is blind).

What remains is a browser tab and a few commands, and the backup half no longer
waits on the association Gmail at all:

1. In the **personal** account: a Google Cloud project, the Drive API enabled, a
   **Desktop app** OAuth client, and a folder for the backups. Details in the
   header of `scripts/google-oauth.mjs`.
2. **Publish the consent screen to Production.** Not Testing — seven days and
   the token dies, silently. No code can tell the two apart; the tokens are
   identical. Doctor catches it the day after, which is a smoke alarm.
3. `npm run google:auth -- backup`, then the printed `wrangler secret put` lines
   — on **both** deployments — then `npm run deploy:all`.
4. `npm run doctor` — BACKUP-NOT-CONFIGURED should become BACKUP-NEVER the same
   day, and BACKUP-NEVER should be gone the morning after. That second check is
   the one that matters: it is the only evidence a file actually landed.

`/forgot` is still blocked on W1 and the association Gmail, which is now a
separate errand: `npm run google:auth -- mail`.

## B20 — The nightly backup outgrows one invocation

Raised 2026-08-11, while checking the batch size against `docs/COSTS.md`. Not
failing today and it will not fail this month; it fails the month residents
actually start uploading, which is the month the portal goes live.

**The ceiling.** This account is on the Workers free plan, which allows **50
subrequests per invocation**. Calls to R2 and D1 do NOT compete for those —
Cloudflare counts internal services against a separate allowance of 1,000, which
this job comes nowhere near. So the 50 is, in practice, "calls to the Google
Drive API in one night". Workers Paid raises it to 10,000, and buying the $5
plan is a legitimate alternative to everything below.

**The arithmetic that matters** is that an item costs more than its upload. A
folder lookup is one fetch when the folder exists and two when it must be
created, and a night can need a folder per period and a folder per notice. The
worst realistic night — a backlog spanning months, attachments on different
notices — is `5 + 2 × (proofs + attachments)`. At the batch sizes shipped in
PR #8 that is 65, over the ceiling; the arithmetic only stayed under 50 while
you counted the proof sweep alone.

Three separate problems, in the order they bite:

1. **`PROOF_BATCH` is shared.** `backupAttachments` defaults to the same
   constant as `backupProofs`, so "twenty" is really forty uploads, and the
   comment defending the number reasons about one sweep of the two.
2. **`backupNotices` has no cap at all.** Its docstring is right that the
   signature check makes most notices free — and wrong about the day that
   stops being true. `noticeSignature` hashes a fixed list of fields; add one
   or reorder it and every notice in the building goes dirty on the same run.
   Weekly cadence does not help, because they all come due at once.
3. **The starvation is silent, and it is what makes this urgent.** The sweeps
   run in a fixed order and each catches per item, so a subrequest error is
   swallowed as a `failed` count and the row is left unmarked for tomorrow.
   Proofs spend the budget, attachments get the remainder, notice Docs get
   nothing — every night, for ever, while the watermark advances and
   `checkBackup` reports a healthy backup. This feature has now twice nearly
   shipped a signal that reports the reassuring half.

**The agreed shape, decided 2026-08-11.** Split by schedule rather than by
budget, because the ceiling is per invocation and nothing forces this into one:

* Nightly at `0 22 * * *` — the CSV bundle, the proof images, and the notice
  attachments. Separate constants, sized so the worst-case night fits with
  room: roughly 12 proofs and 6 attachments. At an expected inflow near two
  proofs a night that is still several times more than needed.
* Weekly at `0 21 * * 0` (02:30 IST Sunday) — the notice Docs, with a cap of
  their own around fifteen. A different hour on purpose: `0 22 * * 0` would
  fire alongside the nightly job every Sunday and race it for the same folders.
  Cron triggers are limited to five per account on the free plan and two are in
  use, so the third is free.

A shared budget counter threaded through the three sweeps was the other
candidate and was rejected: it is accounting code to make one invocation fit,
when two invocations make the problem disappear. Alternate nights by date
parity was rejected too — the 31st and the 1st are both odd, so it silently
runs twice in a row and then gaps.

Attachments deliberately stay nightly rather than joining the weekly job.
Moving them would widen the window in which a photograph exists in exactly one
bucket from a day to a week, which is the single point of failure
`backupAttachments` exists to close.

**Two things the split needs that the current code has no place for.** The
weekly job needs its own watermark — `last_backup_at` is written by the CSV
path, so a weekly sweep that quietly stops looks exactly like a weekly sweep
with nothing to do — and doctor needs a staleness threshold for it near nine
days, so one missed Sunday is not an alarm and two are.

**And a test that would have caught the original mistake.** `BACKUP_CRON`'s own
comment calls a mismatch with `wrangler.toml` this feature's signature failure,
but the test asserts the constant equals a literal, which passes happily while
`wrangler.toml` says something else. It should parse `wrangler.toml` and assert
the constants match what is actually deployed. That is worth doing before a
third trigger exists, not after.

**Left alone deliberately:** the folder a notice's attachments go into is named
from its title, so a title edited between the nightly attachment run and the
weekly Doc run sends the two to different folders. Latent — nothing in the
interface sends a title change today (see the open problems in `STATE.md`) —
but the split widens the window from one invocation to a week.

**Not a fix for this:** the manual export. `Download everything` in the Export
tab already produces the identical bundle the nightly job uploads, makes no
Drive calls at all, and was never at risk from this ceiling. It carries no
images, and it depends on somebody remembering — which is the dependency this
whole feature exists to remove. It is worth keeping as the one copy that does
not depend on Google, and a quarterly download before the AGM is a habit worth
having, but it does not relieve the automated path.

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
