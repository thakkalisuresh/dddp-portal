# Backlog

Deferred deliberately. Everything here was raised, considered, and parked — not
forgotten. Items keep their number for life so commit messages stay meaningful;
the ORDER is priority, so the top of this file is what to do next.

Reviewed 2026-08-12.

**B10, B21, B22 and B18 are one decision, taken 2026-08-12.** Read them
together or they mislead: each one alone looks like a smaller, stranger change
than it is. The decision is written out once at the head of "Ready to build"
rather than four times.

---

# Blocking the cutover

Nothing else matters until the building is actually using this. Production has
the schema for 99 flats, four committee accounts, and **no bills**.

## C1 — The roster

Flat, name, mobile, **email**, owner/tenant, for ~99 flats. Everything to consume
it is built and deployed (`/admin/roster`): paste, preview, import, then a
worklist for sending logins with sent/logged-in tracking.

**Email joined that list on 2026-08-12** and is the one addition worth chasing
while the sheet is still going round — it is now how a resident recovers their
own account, so a flat without one is a flat that will need a person every time
somebody forgets a password. See the credential decision under "Ready to build".

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

## The credential decision, 2026-08-12

B10, B21 and B22 are three parts of one change, and B18 is what it leans on.
Stated once, here:

**An admin who can reset a resident's password can become that resident.** The
reset does not show them an existing password — the old one is a hash and is
gone — but it mints a new one and hands it to the admin, who then knows a working
credential for an account that is not theirs. `must_change_pw = 1` does not
help: the admin can log in first and change it themselves. Every bill, every
proof, every notice comment that account touches afterwards is attributable to
a resident who never typed the password. `canResetPassword` already stops an
admin resetting the superadmin or another admin, which was the sharp end; what
remains is all 99 residents.

So: **reset moves to the superadmin, and residents recover their own accounts by
email.** The admin's job in a recovery becomes telling the resident to use
`/forgot`.

**Admins keep the collecting, not the writing.** An admin is the person who
learns that 7B's number has changed — they are in the building and they answer
the phone. Taking away the edit and leaving them nothing to do with what they
learn would just route the change through a WhatsApp message to the superadmin,
which is worse than a form because nothing records it. So they raise a request
with a reason, the superadmin approves, and approving is what applies the change
(B22).

**Email becomes a mandatory roster column** (C1), because email is now the
recovery route and a resident without one has no way back into their account.

Three things that will catch you out, all verified in the code rather than
remembered:

1. **"Temporary password" is not a one-time code.** `generateOneTimePassword`
   writes an ordinary password into `owners.pw_hash` via `hashPassword`. Nothing
   about it is single-use or time-limited today. B10 is what makes the name
   half-true.
2. **Four paths mint one, not just the reset.** `resetPassword`, `postResident`,
   `postTransfer` and `rosterImport` all call `generateOneTimePassword` and all
   hand the result to whichever admin is looking at the screen. B21 names the
   reset because that is the one a resident triggers, but the other three are the
   same hole and are accounted for there.
3. **`/forgot` cannot accept a code you did not just request.** `public/js/forgot.js`
   holds the mobile in a module variable set only after step 1 succeeds, and step
   2 is `hidden` until then. See B21 — this is why "I already have a code" is a
   real change and not a link.

## B10 — Expire admin-issued temporary passwords

The reset message used to claim "expires in 24 hours" while nothing enforced
it. The copy is honest now, but the gap is real: a temporary password sent over
WhatsApp works forever, and those messages persist on both phones for years,
get forwarded, and survive a handset changing hands. It is the one credential
in this system deliberately sent in the clear.

Shape: `pw_expires_at` on `owners`, set when one is issued, checked at login
only while `must_change_pw = 1` so it never touches a password the resident
chose. An expired one should say so and point at `/forgot` rather than failing as
"wrong password". Perhaps thirty lines and a test.

**Two durations, decided 2026-08-12.** They differ because the two messages are
read at different speeds:

* **4 hours** for a superadmin reset. Somebody is locked out and waiting; they
  will use it within minutes, and a short window is nearly free to them and
  expensive to anyone reading the WhatsApp thread next year.
* **48–72 hours** for a roster invite. Sent in bulk to 99 people who were not
  expecting it, some of whom will be travelling. Anything shorter and the
  cutover becomes a re-send exercise. Pick one number in that range and put it
  in a named constant — the range is the argument, not the value.

**The roster invite stops sending a password at all where there is an email.**
It sends an announcement instead: you have an account, here is the address it is
under, set your own password at `/forgot`. A bulk WhatsApp of 99 live
credentials is the largest single exposure this system would ever create, and
the resident has to choose a password on first login regardless — so the
temporary one is a step that exists only to be replaced.

This part is a **deletion**, and worth recognising as one rather than building a
setting: `generateOneTimePassword`, `hashPassword` and `waLink` come out of
`rosterImport`, and the `oneTimePassword` / `whatsapp` pair comes out of the
worklist it returns. `sendList` in `public/js/admin-roster.js` loses the WhatsApp
`href` and keeps the row, the Sent tracking and `rosterMarkSent` — knowing who
has been told is still the point. The `state` derivation on the worklist
(`!must_change_pw ? 'logged-in' : invited_at ? 'sent' : 'not-sent'`) survives
untouched, which is the useful accident: it reads `must_change_pw`, not the
password, so it still says who has actually logged in.

**Where a resident has no email, the invite keeps the temporary password** — that
is B5's population and there is no other route to them. Which means the 48–72
hour expiry only ever applies to those rows, and the 4-hour one only to whatever
residual reset path B21 leaves for the same people. Build B10 before B21 anyway:
the column and the login check are what both need, and they are correct on their
own.

Do not promise an expiry in any message until it is enforced. The copy in
`resetPassword` was corrected once already for exactly this — `expiresInHours: 24`
was a decorative number nothing acted on.

## B21 — Reset moves to the superadmin, and the resident recovers by email

Raised and decided 2026-08-12. The reasoning is in "The credential decision"
above; this is the work.

**BLOCKED ON W1.** Not partially — there is no path here that does not send
mail. The whole point is that recovery arrives at an address the admin does not
control, so building it against a `sendEmail` that returns early would ship a
reset nobody receives, and the only symptom would be residents who cannot get in.
B22 is the half of this decision that is **not** blocked, so if W1 lingers, build
that and leave this.

**What comes out.** `resetPassword` stops being available to `admin` — the
`canResetPassword` ladder keeps its shape and loses a rung, so an admin gets the
same refusal an admin already gets for another admin. The temporary-password
reply (`oneTimePassword` plus `whatsapp`) goes with it, and so does the button in
`public/js/admin-console.js` that renders them. What the admin sees instead is a
line telling them to send the resident to `/forgot`, which is the actual
procedure now.

**What the superadmin gets** is issuing a code, not a password: a row in
`password_resets` and an email, the same two things `/forgot` already produces.
This is much smaller than it sounds, because migration 0010 built that table for
exactly this and it already has the hard parts — the code stored as a PBKDF2
hash, `expires_at`, an `attempts` cap, `used_at` for single use, and `sent_to` for
the trail. Reuse it. A second mechanism for "a code that lets you in" is how the
two drift apart and one of them stops being rate-limited.

**Why the superadmin needs it at all, when `/forgot` exists.** A resident whose
stored address is wrong cannot use `/forgot` — the code goes to the old address.
The superadmin path is for that case and for the walk-in, and it is the reason
this is not simply "delete admin reset and point at `/forgot`".

**"I already have a code" on `/forgot`.** Needed because the emailed code and the
form that accepts it are now separated by however long it takes someone to open
their email — possibly on another device, and the superadmin-issued case never
touched the page at all. Today step 2 is unreachable without step 1: `forgot.js`
keeps the mobile in a module-level variable assigned only on step 1's success and
unhides `#finish` at the same moment. So the entry point has to **set the mobile
too** — the code alone cannot identify the account, since `api.reset(mobile, code,
password)` and the `ix_resets_owner` lookup are both keyed by owner. Two fields,
not one: mobile and code.

**The `#code` fragment in the email** prefills the code box. A fragment rather
than a query string deliberately — it never reaches the server, stays out of
logs, and out of `Referer`. It prefills only; the resident still types their
mobile, per the paragraph above. And it must not auto-submit: a prefetching mail
client would burn the single use before the resident read the message.

Keep step 1's identical reply whichever way in you take. The page cannot say "no
such resident" even when it is true, and a new entry point that answers
differently would reintroduce the account-enumeration hole through the side door.

**The other three minting paths** (`postResident`, `postTransfer`,
`rosterImport`) are the same exposure and are not all fixed here. B10 handles
`rosterImport`. `postResident` and `postTransfer` are admin-facing and low
volume — a handful of rows a year — so they keep the temporary password with
B10's expiry on it, and that is a deliberate stopping point rather than an
oversight. Revisit if either becomes routine.

## B22 — An admin requests a contact change, the superadmin approves it

Raised and decided 2026-08-12. Reasoning above; **not blocked on anything**, and
therefore the part of this decision to build if W1 drags.

An admin loses `mobile` and `email` on `PATCH /api/admin/residents/:id` and gains
a request. Mobile especially: it is the login identity, and B21 is pointless if an
admin can point a resident's account at a phone they hold and then use `/forgot`
themselves — `patchResident` already carries that reasoning in a comment and
enforces it through `canEditResident`, which is the ladder to extend.

Small, and it should stay small: **one table, one form, one approve button, one
Telegram notification.**

* **One table.** `contact_requests` — owner_id, field, requested_value, reason,
  requested_by, state, decided_by, decided_at. Its own table for the same reasons
  0010 gives: a request in flight is a separate short-lived fact, several can be
  raised and abandoned, and who asked for what is worth keeping after the change
  itself is applied.
* **Validate on the way in, not only on approval.** Put the requested value
  through `validateOwnerField` when it is raised, so a malformed number is
  refused while the admin is still talking to the resident rather than days later
  in front of the superadmin, who cannot fix it.
* **Approving applies the change** — one action, not "approve" then "and now go
  and edit it". Two steps means a queue of approved requests nobody applied, and
  the resident still cannot log in.
* **Reason required**, following B14: the committee turns over at every AGM and
  "why is 7B's number different" needs an answer somebody can find. `checkReason`
  is the existing helper.
* **Re-run the duplicate check at approval**, not just at request time.
  `duplicateContact` guards the login identity, and an approval can land days
  after the request — long enough for another row to take the number.
* **One Telegram notification**, through `postToTelegram`. It should say a
  request is waiting and who raised it, and **not** carry the resident's new
  number or address: `TELEGRAM_CHAT_ID` is one shared chat, the same one
  alerting uses, and this is a resident's personal contact detail going somewhere
  docs/PRIVACY.md has not accounted for. A nudge to open the console is the whole
  job.

**The audit groundwork is already done (2026-08-12).** `resident.update` used to
record only which field *names* were submitted; it now records `{from, to}` per
field that actually moved, so the approval trail can say what a number was
changed from. That was worth doing before this rather than during it: an approval
flow whose log cannot say what the old value was is accountability theatre. The
old value now comes from the same `SELECT` the edit already needed — verified by
issuing a real PATCH and reading the row back, because with the narrower select
it silently logged `"from": null` and looked correct.

**What this is not.** Not a general approvals framework. Two fields, one
approver, no delegation, no partial approval, no expiry on a pending request. If
a third field ever needs this, that is the moment to generalise, not before.

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
Worth doing whatever is decided about login: requiring the current password to
change your own email, since a stolen session plus `/forgot` is otherwise a
permanent takeover.

**The index is now deliberately deferred, and that reverses what this entry used
to say** (2026-08-12). It read that the unique index was worth adding whatever
was decided. It is not, not yet, and the reason is ordering rather than doubt:
adding it before the roster is in means adding it to a table where 2 of 107 rows
have an address at all. It would pass instantly, guard nothing, and then meet 99
pasted addresses with a `UNIQUE constraint failed` in the middle of the one
import the cutover depends on — where the failure surfaces as a half-finished
roster rather than as a duplicate anybody can act on. Import first, find the
collisions with the doctor warn that already exists, resolve them as data, then
add the index.

**So B21 ships email as a reset destination without a uniqueness guarantee.**
That is a known and accepted gap, recorded here so nobody discovers it in the
code and treats it as a bug: two residents sharing an address means either can
request a reset that lands in a shared inbox. It is bounded by what the paragraph
above already describes — one reset inbox for two people, which is what the
doctor warn has meant since `/forgot` shipped — and it becomes unbounded only if
email also becomes a login, which is the question this entry is still parked on. **Do not add the index ahead of the roster to close
it.** The doctor warn is the interim control and is correctly a warn.

**Email becomes a mandatory roster column** (C1, B10). Two things follow that are
not free:

* `parseRoster` currently treats a missing address as `null` and imports the row.
  Making it a hard `stop()` means the roster cannot be imported until the last
  address has been chased out of the last owner, which fights C1 — weeks — and
  C3, which wants the import done before the meter walk. **Open decision, and it
  wants an answer before B10's roster half is built:** block the line, or import
  it and surface it as a worklist state alongside `not-sent`. The second is
  probably right, since a resident with no email still needs a bill, and B5 is
  the population that will never have one.
* `roster.js` lowercases and trims the address inline rather than calling
  `normaliseEmail`. Harmless today because the two agree — and exactly the shape
  of the two-spellings bug 0009 was written to end. Fold it into the one function
  while the column is being made to matter.

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
If it turns out to be two households, a reset by hand is the right answer and
always was — **by the superadmin, not an admin**, as of 2026-08-12. That is the
one correction this entry needed: it used to say "an admin reset", which B21
removes. The residual temporary-password path in B10 and B21 exists for exactly
the households counted here.

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
