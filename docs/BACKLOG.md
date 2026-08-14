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
Stated once, here. **B21 and B22 are done and sit under "Done". What is left of
the whole decision is B10's roster-invite half, below.**

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

1. **"Temporary password" is still not a one-time code.** `generateOneTimePassword`
   writes an ordinary password into `owners.pw_hash` via `hashPassword`. B10 made
   it time-limited; nothing makes it single-use, and the emails deliberately do
   not claim otherwise. Do not let its copy converge with the reset-code email's.
2. **Four paths mint one, not just the reset.** `resetPassword`, `postResident`,
   `postTransfer` and `rosterImport` all call `generateOneTimePassword` and hand
   the result to whoever is looking at the screen. B21 fixed the reset because
   that is the one a resident triggers; all four now carry B10's expiry, and the
   remaining three are accounted for at the end of B21.
3. **`/forgot` cannot accept a code you did not just request.** `public/js/forgot.js`
   holds the mobile in a module variable set only after step 1 succeeds, and step
   2 is `hidden` until then. This shaped B21 by ruling something out: the
   superadmin sends a temporary password rather than a code precisely so that
   nobody ever holds a code they did not request on that page, and `/forgot` kept
   its two-step shape unchanged.

## B10 — Expire issued temporary passwords — EXPIRY DONE 2026-08-12

**The column and the login check shipped 2026-08-12.** Migration 0023,
`pw_expires_at`, and `tempPasswordState` in `lib/reset.js`: 24 hours for a reset,
72 for a roster invite, set at all four minting sites and cleared wherever
`must_change_pw` goes to 0. An expired one answers DDP-AUTH-012 and points at
`/forgot` instead of failing as "wrong password", and `resetPassword` may promise
the expiry again because something now enforces it.

Verified by logging in rather than by reading the code: expired plus the right
password is refused; expired plus a *wrong* password still answers the generic
"incorrect", because the expiry is checked after verification and must not tell
an attacker holding a stale WhatsApp message that the number is real; a live one
logs in and lands on `/password`; and a password the resident chose is unaffected
even with a long-past deadline still sitting on the row. Both guards were broken
deliberately to watch the tests catch them.

**What remains of this entry** is the roster-invite half below — sending an
announcement rather than a password where the resident has an email.

**Why it was worth doing**, kept because the reasoning outlives the work. The
reset message used to claim "expires in 24 hours" while nothing enforced it, and
the claim was withdrawn rather than kept. Until 2026-08-12 a temporary password
sent over WhatsApp worked forever, and those messages persist on both phones for
years, get forwarded, and survive a handset changing hands. It is the one
credential in this system deliberately sent in the clear.

The shape it shipped as: `pw_expires_at` on `owners`, set when one is issued,
checked at login only while `must_change_pw = 1` so it never touches a password
the resident chose. Thirty lines and a test, as estimated.

**The two durations as shipped: 24 hours for a reset, 72 for a roster invite.**
`TEMP_PW_HOURS` and `INVITE_PW_HOURS` in `lib/reset.js`. They differ because the
two messages are read at different speeds — a reset goes to somebody locked out
and waiting who will use it within minutes, an invite goes in bulk to people who
were not expecting it and some of whom are travelling. (An earlier draft of this
entry said 4 hours for a reset; 24 is the decision.)

---

### STILL TO DO — the roster invite sends an announcement, not a password

The remaining half of B10, and the one piece of the 2026-08-12 decision not yet
built. Nothing blocks it except C1: there is no roster to import yet, so this is
best done in the same sitting as the import rather than months before it.

**Where the resident has an email, the invite stops carrying a password.** It
says: you have an account, here is the address it is under, set your own password
at `/forgot`. A bulk WhatsApp of 99 live credentials is the largest single
exposure this system could create, and the resident has to choose a password on
first login regardless — so the temporary one is a step that exists only to be
replaced.

This is a **deletion**, and worth recognising as one rather than building a
setting: `generateOneTimePassword`, `hashPassword` and `waLink` come out of
`rosterImport`, and the `oneTimePassword` / `whatsapp` pair comes out of the
worklist it returns. `sendList` in `public/js/admin-roster.js` loses the WhatsApp
`href` and keeps the row, the Sent tracking and `rosterMarkSent` — knowing who
has been told is still the point. The `state` derivation on the worklist
(`!must_change_pw ? 'logged-in' : invited_at ? 'sent' : 'not-sent'`) survives
untouched, which is the useful accident: it reads `must_change_pw`, not the
password, so it still says who has actually logged in.

Two things to settle when it is built:

* **What the announcement is sent BY.** An email needs W1. A WhatsApp message
  saying "go to /forgot" needs nothing and reaches the phone the roster already
  has. The second is probably right for the cutover, and it makes this
  independent of W1 — but it is a choice, not an obvious default, because C3
  wants exactly one message to each resident.
* **What happens to a row with no email**, which is the same open question B18
  records for the mandatory column. The invite keeps the temporary password for
  those residents — B5's population, with no other route to them — so
  `INVITE_PW_HOURS` exists for them and only them.

---

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

**The live bug that used to hang off this entry is fixed**, and the paragraph is
kept rather than deleted because the reasoning is what made it worth finding.
The login field was `type="tel" inputmode="numeric"` — a digit keypad with no
`+`, so an owner with a foreign number could not type their own login on a
phone. It is now `inputmode="tel"` (`public/login.html`), which `/forgot` had
right all along. Nothing else in B18 is affected: this was always the one part
that did not need the list of old usernames to proceed.

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

## B24 — Groq's free tier runs out of OCR at ~83 uploads in a day

**Raised 2026-08-14, and revised the same day after hitting it for real.** The
first version of this item named the wrong limit; the correction is the item.

**The binding constraint is tokens per DAY, not per minute.**

| | |
|---|---|
| Tokens per upload | **2,402** measured (1,833 prompt + 569 completion) |
| Observed cost per answer in a real batch | **~3,900** |
| Free tier: tokens per day | **200,000** |
| Free tier: tokens per minute | 8,000 |
| Free tier: requests per day | 1,000 |

200,000 ÷ 2,402 is **about 83 uploads a day** at best. The 2026-08-14 batch
actually produced **51** answers for a full day's tokens — ~3,900 each. Plan
against 51. The building has **99 flats**.
One bill cycle where everybody pays on the same day exceeds the daily budget by
roughly sixteen uploads — and re-uploads after a rejected proof spend it
twice, so real capacity is under 83 distinct flats.

**How this was found.** Running the August 2026 proof test over the exported
WhatsApp screenshots died at 58 images with `TPD: Limit 200000, Used 199160`.
Every retry failed identically, because a per-day lockout lasts hours — the
`x-ratelimit-*-tokens` headers showed 7,983 of 8,000 free at that exact moment,
which is why a per-minute reading of the problem is so easy to reach and so
wrong.

**Two earlier estimates were wrong, both in the reassuring direction:**

- `_HANDOFF.md` reasoned from monthly volume — "comfortable for 99 uploads a
  month". Arithmetically true, wrong unit: nobody uploads spread evenly over a
  month, and the limit that binds resets daily.
- The first draft of this item said burst was the only ceiling and daily
  allowances were "nowhere near binding". That came from extrapolating one
  1,951-token measurement taken on an unusually small 30 KB image.

**Resolution turned out NOT to drive the cost, and an earlier draft of this
item said it did.** The same receipt measured 1,833 prompt tokens at both
709×1000 and 1135×1600 — identical. The model tiles to a fixed budget, so
`compress.js` earns its keep on bandwidth and R2, not on tokens. Above 1600px is
untested: the daily budget ran out before the 4000px case could be measured.

**The unexplained gap is the more useful finding.** A clean call costs 2,402
tokens but the batch averaged ~3,900 per answer. The likely cause is work paid
for and discarded — `TIMEOUT_MS` aborts at 12s, while Groq has already processed
and billed the request. If that is right, every timeout costs a full upload's
budget and returns nothing, and raising the timeout would *save* tokens rather
than spend them. Worth confirming before anyone tunes it.

**The failure is graceful but silent, and that is the real cost.** A 429 raises
`DDP-PROOF-007`, `readReceipt` catches it, and the proof stores as unreadable
for the treasurer. Nobody is blocked from paying — `vision.js` is explicit that
OCR is never a gate. But an unreadable proof looks identical whether the model
failed, the image was poor, or the provider locked the account out for the rest
of the day. On the busiest evening of the month the treasurer would be hand-
typing a growing backlog with nothing on screen explaining why.

Two ways out, and they are not exclusive:

**Put a card on Groq.** Pay-as-you-go, no monthly minimum, and it brings ~10×
the rate limits plus a 25% discount — roughly 40 screenshots a minute, which
lifts the daily token cap, which is the ceiling that actually binds. Usage would
be about **₹9–13/month** at one upload per flat (see `COSTS.md`) — less than the
free tier's own daily budget is worth. The headroom is the reason to do it; the
discount is incidental.

*The tier details — no monthly minimum, ~10× limits, 25% discount — come from
third-party pricing trackers, not Groq's own page, which would not load.
Confirm in the console billing screen before acting. The 200,000 TPD figure is
not from those trackers: it came from Groq's own 429 response and is solid.*

**Or defer only on 429.** Keep the inline call and its upload-time verdict
exactly as they are, and on a 429 or timeout mark the proof for a retry sweep
instead of burning it to `unreadable` permanently. One new column — `status` is
already the treasurer's review state — and a pass hung off the existing 08:30
cron, which is the right cadence now that the lockout is known to last hours
rather than a minute. Worth having at any tier, since limits exist at all of
them, and it is the only option here that makes the failure *visible*.

**Rejected: a general upload queue.** A funnel paced at four a minute was the
answer to the per-minute ceiling, and the per-minute ceiling turned out not to
be the problem. Rationing a daily budget more smoothly does not create more of
it: 99 uploads exceed 200,000 tokens whether they arrive in ten minutes or
spread across the day. It would also cost the instant verdict that `proof.js`
argues is the point — "telling them at upload beats the treasurer finding it
days later" — and need a per-minute cron against the three-a-day this project
runs now.

**The trigger has already fired once, in testing.** A 58-image batch exhausted
a full day's tokens on 2026-08-14. That was one machine running flat out rather
than residents uploading, so it is not proof the building will hit it — but it
is proof the ceiling is reachable, and it arrived well before anyone expected
it. Revisit at the first month residents upload at volume, which is the same
month B20 bites, for the same reason.

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
bills, and the watermark advancing are all still unobserved. BACKUP-NEVER
disappearing is the only evidence that counts, and this entry stays open until
it does.

**The check was set for the morning of 2026-08-12 and that date was wrong — by
about sixteen minutes.** Established on 2026-08-12 rather than assumed, because
"the backup did not run" is exactly the shape of failure this feature is prone
to and it deserved evidence either way. The `0 22 * * *` trigger was committed
at 21:36 UTC on 2026-08-11, and the deploy carrying it landed at **22:16 UTC —
after that night's 22:00 window had passed.** There has therefore never been a
window with the trigger deployed. **The real check is the morning of
2026-08-13.**

Everything downstream is verified, so there is nothing to do but wait: all four
`GOOGLE_BACKUP_*` secrets are on the cron Worker, `BACKUP_CRON` matches
`wrangler.toml`, `last_digest_at` proves cron delivery reaches this Worker, and
`settings` has no `last_backup_at` key at all — the shape of a job that never
ran, not one that ran and failed. Worth recording because the diagnosis is
reusable: **a deploy that misses tonight's window is indistinguishable from a
broken job until the following night**, and the four checks above are what
separate them without waiting.

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
  room: roughly 12 proofs and 6 attachments. At an expected inflow near three
  proofs a night — 99 flats, most paying once a month — that is still several
  times more than needed.
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

## B22 — An admin requests a contact change, Sabarish approves it — DONE 2026-08-12

Raised, decided and built 2026-08-12. Migration 0024, `lib/contact-requests.js`.
Approving applies the change in the same call, and the audit row carries
`{from, to}` in the same shape as `resident.update` so one search of the log finds
every route by which a number has ever moved.

**Reject exists, though this entry did not ask for it.** Without it a request that
should not happen has no disposal and the queue grows until people stop reading
it, which is the failure the panel is designed against — it is hidden entirely
when nothing is waiting, so it has to mean something on the day it appears.

**Two guards that only matter because approval is not instant.** The duplicate
check runs again at approval, because days can pass and another row may have taken
the number. And a request is refused if the value is already in place — the
resident may have fixed it themselves from their profile, and applying it anyway
would write an audit row claiming a change that did not happen.

**Admins see the queue and no buttons.** An admin who cannot see that their own
request is still pending will raise it again or telephone about it, which are the
two things this replaced.

An admin loses `mobile` and `email` on `PATCH /api/admin/residents/:id` and gains
a request. `canEditResident` is the ladder to extend.

**Email is the takeover vector, and this entry originally said mobile.** Worth
correcting rather than quietly fixing, because the wrong emphasis was inherited
from a comment in `patchResident` that predates `/forgot` working the way it does.
Traced through the code: `forgotPassword` looks an account up **by mobile** and
mails the code **to the email on file**. So:

* **Email is how an account is taken.** Change the address to one you control,
  request a reset against the resident's own mobile, and the code arrives in your
  inbox. That is B21's refusal taken the long way round, and it is available to
  any admin today.
* **Mobile is how an account is locked out.** It is the login identifier, so
  changing it stops the resident logging in — but it does not deliver the reset
  code anywhere new, because the code follows the address. Denial rather than
  takeover.

Both belong behind approval; email is the one that makes this urgent rather than
tidy. And an admin editing the *superadmin's* mobile is separately guarded
already, which is what the original comment was really about.

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

**The naming trap this introduced, recorded because it will bite.** User-facing
copy now says "Sabarish" rather than "the superadmin", from `ADMINISTRATOR` —
`functions/lib/tenancy.js` for server messages and `public/js/contact.js` for the
browser, two definitions on the same deliberate split as TREASURER. **God mode can
hand the superadmin role to another resident, and nothing makes those constants
follow**, so the day that happens every message names the wrong person. The right
fix is to read the name from the row that holds the role — `SELECT name FROM owners
WHERE role = 'superadmin'` — and carry it on `/api/me` for the browser. Not done
because it is a query on paths that are currently pure functions, and because
handover has never happened; do it before it does.

## B21 — Reset is the superadmin's alone — DONE 2026-08-12

Raised, decided and built 2026-08-12. The reasoning is in "The credential
decision" above.

**What came out.** `canResetPassword` lost its middle rungs: the ladder is now
superadmin-only, and an admin gets a refusal that names `/forgot` and says the
code goes to the resident's own email — because an admin reading it is standing in
front of somebody who cannot log in, and a bare "no" just routes the problem to a
phone call. The Reset button is gone from the admin's directory card and replaced
by that same sentence. **Both halves matter:** the endpoint refuses an admin
independently of the button being hidden, which was verified by calling it
directly with an admin session.

**What the superadmin gets: the password on screen, then a button that emails it.**
Not an emailed code, which is what this entry originally proposed — a temporary
password the resident logs in with, which is simpler and reuses the forced-change
path that already existed (`login.js` sends `mustChangePassword` to `/password`,
and `dashboard.js` guards it independently).

**On screen FIRST, and that is not a compromise.** Showing it to the superadmin
is not the hole this closed: the hole was ADMINS holding credentials for accounts
that are not theirs. The superadmin can already reset any account with the
break-glass script, so the screen tells them nothing their database access would
not. What it buys is a flow that survives its own failures — a wrong address, a
full mailbox, mail not configured at all — where the alternative is a resident
locked out with a password nobody knows, since the old one is dead the moment the
reset runs. This is also why the whole design could ship before W1.

**The email endpoint takes the password back and checks it against the stored
hash before sending.** Two consequences, both deliberate: it cannot be used to
mail arbitrary text to a resident, and it stops working the moment the password
stops being current — a second reset, or the resident choosing their own, makes a
stale tab's Send button fail loudly rather than mail a password that opens
nothing. Verified all three ways, plus the empty-string case.

A failed send says so plainly and says the on-screen password is still valid. A
screen that claims to have sent a password nobody received is how a locked-out
resident stays locked out while everybody believes they were helped.

**WhatsApp stayed** for residents with no address on file — B5's people, for whom
it is the only route that exists. The panel offers it instead of the email button,
and says why.

**Not built, deliberately: "I already have a code" and the `#code` fragment.**
This entry called for both. The design that shipped removes the need for them
entirely — the superadmin sends a password rather than a code, so nobody ever
holds a code they did not just request on that page. `/forgot` keeps its two-step
shape untouched, and `forgot.js` did not need to change at all. Recorded because
the reasoning for them was sound and would come back if the superadmin path ever
becomes a code again.

**The other three minting paths** (`postResident`, `postTransfer`,
`rosterImport`) are the same exposure and are not all fixed here. B10's remaining
half handles `rosterImport`. `postResident` and `postTransfer` are superadmin- and
admin-facing and low volume — a handful of rows a year — so they keep the
temporary password with B10's expiry on it, and that is a deliberate stopping
point rather than an oversight. Revisit if either becomes routine.

**Still true, and the reason W1 still matters:** a resident whose stored address
is wrong cannot use `/forgot`, and until W1 the emailed half of this reaches
nobody. The superadmin path works today regardless; the self-service path does
not, and 103 of 105 accounts have no address at all.

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
