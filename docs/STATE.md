# Where this is, 12 August 2026

What is built, what is live, what is half-done. Figures read from production
rather than remembered.

---

## In one line

The portal is **built and deployed**. It has never billed a real month.

## Production right now

**https://diamondpark.pages.dev** · 1200 tests · `npm run doctor` reports
**0 failing**, 2 warnings.

Figures below read from production on 2026-08-20.

> **The Billing tab is live.** Deployed 2026-08-20 with migration
> `0033_bill_announcements.sql` applied first, since it creates the table
> publishing writes to. `/admin/readings.html` now redirects to `/admin/#billing`
> for anyone who bookmarked the meter walk.

| | |
|---|---|
| Flats | 99 — **94 billed**, 5 excluded |
| People | 105 — **100 of them demo** |
| Bills | 898 — all demo (0 belong to a real account) |
| Readings | 990 |
| Months | 10 — all demo |
| Migrations applied | 33 |
| Error codes | 93 |

> ### The demo data is live
>
> 100 generated residents across 89 flats, and all 898 bills, are in the
> production database for user testing. **It must come out before the real
> roster goes in**, or the import meets flats that already exist.
>
> ```
> node scripts/seed-demo.mjs --remote --remove
> ```
>
> It removes exactly what it created, recorded before creation. The four real
> committee accounts — 4A, 10A, 13A, 13E — are untouched by both the seed and
> the removal.
>
> `npm run doctor` reports this as `DEMO-DATA-PRESENT` and stops reporting it
> the moment the data is gone, so the database is the source of truth rather
> than this paragraph.

### The five flats with nobody on them — CLEARED 2026-08-20

`FLAT-BILLED-NO-OWNER` failed for **8B, 9E, 11D, 14A and 16D** the day the check
shipped. All five are now set to no owner and stopped being billed, so
`npm run doctor` reports **0 failing**. Kept here because the finding is not
finished — it is deferred.

**They were a demo-coverage gap, not a fact about the building.** The register
holds 99 flats; the demo seed populated 89, and the real committee accounts
bring it to 94 with people. These five had **zero owner rows, ever** — not
departed residents. Whether they are unsold, empty, or simply not imported is
still unknown, which is why the reason stored on each flat says so rather than
taking the interface's default of "Unsold":

> Not in the demo roster; status unknown until the real roster import

**What has to happen when the roster lands.** Review all five. Each is either a
real flat that needs its owner, or genuinely unsold and correctly excluded. The
import will not decide this for you — an excluded flat stays excluded until
somebody turns it back on.

**How it was done, and why that is worth knowing.** A direct D1 write, not the
Residents tab, because every flat and resident in this database is demo data.
The `flat.occupancy` audit row for it has `actor_id` NULL and says as much: no
session made the change. The endpoint's own guard — it refuses to stop billing a
flat that holds a reading in an open month — was checked by hand first and none
of the five did.

**On real data, use the Residents tab.** The audit row is the point there, and
the occupancy endpoint still has not been exercised against a real session.

**What it would have cost if left.** Generation refuses a partial month, so
those five would have blocked billing for all 99 flats the moment a month was
generated — while the readings grid said only "94 of 99 entered", sending
somebody hunting for meters in empty flats.

**Also learned from this:** the building has floors above 12 — 14A and 16D are
real. Any fixture or prototype assuming 12 floors is a stand-in.

## The five flats with nobody on them

`npm run doctor` fails on `FLAT-BILLED-NO-OWNER` for **8B, 9E, 11D, 14A and
16D**. Recorded here on 2026-08-20 so the finding is not investigated from
scratch a second time.

**They are a demo-coverage gap, not a fact about the building.** The register
holds 99 flats; the demo seed populated 89, plus the real committee accounts,
which is 94 with people. These five have **zero owner rows, ever** — not
departed residents. Nobody yet knows whether they are unsold, empty, or simply
not imported, and that question is answered by the roster import, not by
guessing now.

**Why it is left failing.** Setting an occupancy for them today would be an
invented answer that the roster import overwrites. The sequence that resolves it
is: remove the demo data, import the real roster, and then whatever
`FLAT-BILLED-NO-OWNER` still reports is a genuine finding worth acting on.

**What it costs while it sits there.** Generation refuses a partial month, so
these five would block billing for all 99 flats. That does not matter until a
month is generated — but **anyone rehearsing a month on the current demo data
must mark them "not billed" first**, on the Residents tab. It is reversible and
the roster import supersedes it.

And a red check is not free: a doctor report that always fails is how people
learn to skim past one. That is the same habit that let a misnamed API key kill
vision in production until a resident noticed the yellow boxes.

**Set them through the Residents tab, never with a direct database write.** The
occupancy endpoint shipped on 2026-08-20, writes an audit row, and has not yet
been used against production once.

**Also learned from this:** the building has floors above 12 — 14A and 16D are
real. Any fixture or prototype assuming 12 floors is a stand-in.

## Built and verified

**Billing.** Readings grid, paste import, per-period rate, preview before
generation, ceiling rounding, the 2.60 conversion, locked periods.

**Payment.** Four routes, ordered by how reliably they survive a device that
will not cooperate: Android leads with the plain `upi://` link that raises the
OS chooser (the mechanism NPCI defines), then the named app row, then a QR —
available on phones now, not only desktop — then the UPI ID, copyable, which
always works. iOS keeps per-app schemes because it has no chooser to fall back
on. A failed handoff says so, both when the page watches the tap go nowhere and
when Chrome bounces back through `browser_fallback_url` carrying `?upi=blocked`.
Payment-intent logging fires from Pay and from Copy alike.

The ordering is not a preference, it is a finding: see "The Android payment
failure" below. No `tr` is sent — it described a merchant transaction the
payload could not substantiate, and nothing ever read it back.

**Proof.** Client-side resize, upload to R2, duplicate detection by image hash
and UTR, a review queue with bulk approve for exact matches, retention pruning.
Payment references now cover what residents actually send — the 12-digit RRN,
PhonePe's `T…` id, and card-UPI alphanumerics. Before this the reference came
back null for those apps, the uniqueness check was skipped, and one payment
could be claimed on two bills.

**Reconciliation.** The treasurer uploads the bank statement (CSV, or PDF with a
text layer) and the portal matches its credits against what residents claimed —
by RRN first, then by amount and date where the app's reference cannot reach the
bank. It reports four disagreements: claimed with no money, bank disagrees on
amount, one reference claimed twice, and money in with no screenshot (with the
unpaid bills that match it). On finish the verdicts are saved and the statement
is deleted; anything left open is swept at 3am. The statement file is never
stored, and never leaves the Worker — the PDF text layer is read locally rather
than posted to the vision provider, because the alternative is mailing every
member's payment history to a third party.

**People.** Roster import with preview against the real 99-flat model, temp
passwords that expire, a send-and-chase worklist, owners and tenants, flat
transfer, self-service password reset by emailed code.

**Admins no longer write a mobile or an email either** (2026-08-12, B22). They
raise a request with a reason and Sabarish approves it, which is what applies the
change. Email is the reason: `/forgot` finds an account by mobile and mails the
code to the address on file, so an admin who could rewrite the address could
receive somebody else's reset. Mobile is the lockout rather than the takeover.
Names stay directly editable — not a credential, and routing a spelling fix
through an approval queue teaches people to ignore the queue.

**Resetting a password is the superadmin's alone**, as of 2026-08-12. An admin
who can reset an account is handed a working credential for it and can log in as
that resident, so they no longer can: residents recover themselves through
`/forgot`, and an admin's part is to tell them to. The superadmin's reset shows
the temporary password on screen and offers a button that emails it — on screen
first, because a send that fails must not leave somebody locked out with a
password nobody knows. Backlog B21.

**Admin and god.** Console, activity log, click capture, view-as and
impersonation, god edit of any person or bill with a full audit trail, CSV
export.

**Operations.** Telegram alerting proven end to end, a morning digest,
`npm run doctor` self-checks, generated error-code and function references with
drift tests.

## Built but inert

**Self-service password reset** (`/forgot`) — live, accepts requests, sends
nothing. No Google credentials. `doctor` reports `MAIL-NOT-CONFIGURED`.

**Nightly Drive backup** — written in phase 8, and **configured on 2026-08-11**
after sitting inert since. Doctor moved from BACKUP-NOT-CONFIGURED to
BACKUP-NEVER, which is the whole of what has been proven so far.

> ### Why it had not run by 2026-08-12, and it is not a fault
>
> Checked properly on 2026-08-12 rather than assumed. **The backup has never
> had a window.** The `0 22 * * *` trigger was committed at 21:36 UTC on
> 2026-08-11 and the deploy carrying it landed at **22:16 UTC — sixteen minutes
> after that night's 22:00 window had already passed.** The next 22:00 is
> 2026-08-12, so the first genuine opportunity is 03:30 IST on the **13th**.
>
> Everything downstream of the trigger checks out, so there is nothing to fix
> while waiting: all four `GOOGLE_BACKUP_*` secrets are on the cron Worker,
> `BACKUP_CRON` in `lib/backup.js` matches `wrangler.toml` exactly, and cron
> delivery to this Worker is proven — `last_digest_at` reads
> `2026-08-12T03:00:25Z`, so the 03:00 UTC trigger fired that morning. A
> `last_backup_at` key does not exist in `settings` at all, which is the shape
> of a job that has not run rather than one that ran and failed. `error_log`
> carries no backup failure, and a failure would have paged Telegram.
>
> **So the check is the morning of 2026-08-13**, and BACKUP-NEVER still showing
> then is the first moment this becomes a fault worth investigating.

What IS proven: the credentials work and the folder is writable, because
`google:auth` uploaded a real check file (`setup-check-2026-08-11.csv`) before
finishing. What is NOT proven: that the cron fires, that `runBackup` completes
against the real database, and that the watermark advances. Only the morning
after says that, and until it does this line stays here rather than under
"built and verified".

`npm run google:auth -- backup` (2026-08-11) does the consent round-trip and
prints the secret commands for both deployments, so this is now a browser tab
and a few commands rather than a research task. Two things it cannot do for
you: the consent screen must be **published to Production** — a Testing-mode
refresh token expires in seven days and the backup then stops silently — and the
secrets must go on the **cron Worker as well as Pages**, because the 3am upload
runs there and only there. Doctor used to check Pages alone and would have
reported an all-clear on a backup that never ran; it now names each half.

> ### The backup account is personal, and deliberately
>
> Decided 2026-08-11. The nightly upload authenticates as a committee member's
> own Google account (`GOOGLE_BACKUP_CLIENT_ID` and friends, overriding the
> shared trio), because Drive charges a file to whoever creates it and the
> association's 15 GB is wanted for the association's own documents. Storage
> was never the constraint — production D1 is 639 kB entire, so a year of
> nightly bundles is under 200 MB — the quota is.
>
> Two consequences, recorded here so they are not discovered:
>
> * That person holds every resident's name, mobile, email and payment history
>   in a personal Drive. Passwords are never exported (`NEVER_EXPORT`).
> * **When they leave the committee this is an account to replace, not a folder
>   to move.** Re-run `npm run google:auth -- backup` as the new holder.
>
> `/forgot` deliberately did not follow. Reset codes go to 99 residents and must
> come from the association's address, so `sendEmail` stays on the shared
> credentials. Only `uploadToDrive` and `backupHealth` take the override.

## The PBKDF2 incident, 2026-08-12 — over, and no account was stranded

Recorded because the git log shows a raise and a revert (PRs #16, #17) without
showing what happened in between, and the thing worth knowing is what it did to
the data rather than to the code.

Between 17:59 and 18:04 UTC, production ran with `PBKDF2_ITERATIONS = 200000`.
Cloudflare's Web Crypto caps it at 100,000 and says so only at runtime, so every
login in that window threw `NotSupportedError: Pbkdf2 failed: iteration counts
above 100000 are not supported (requested 200000)` — four fatal DDP-SYS-001 rows
in `error_log`, then the revert.

**The question the revert did not answer is whether any password was WRITTEN at
200000 in those five minutes.** One would have been a permanent lockout rather
than a failed login: verification re-reads `pw_iterations` from the row and
would throw the same error every time, for ever, with no way back except a
break-glass reset. Checked on 2026-08-12 — `SELECT pw_iterations, COUNT(*) FROM
owners GROUP BY pw_iterations` returns a single row, **100000 for all 105
accounts.** Nothing to repair.

Worth keeping as the shape of the risk: an iteration count is snapshotted onto
the row, so a bad value does not fail loudly at deploy time and then get fixed —
it is written into accounts and outlives the revert.

## Never tested against real data

This is the honest gap, and it is the whole of it.

Production has **no real bills**. Every billing behaviour — the conversion
factor, the rounding, late fees, the reconciliation flow — is verified by tests
and by demo data that this project generated itself. The first genuine test is
the cutover meter walk.

**Run `npm run doctor` after generating the first real month and before any
resident sees a bill.**

## What is actually blocking

1. **The roster.** ~99 flats: flat, name, mobile, owner or tenant. Everything to
   consume it is built. This is a people problem, measured in weeks.
2. **The meter walk.** There is no migration from the old portal; month one
   starts from a physical read.
3. **A Gmail account for the association.** Unblocks `/forgot`. It no longer
   blocks the backup, which now runs under a personal Google account — see
   above.

Order matters: import the roster, walk the meters, generate the month, **then**
send the logins. A resident who logs in to an empty dashboard decides the site
is useless and does not come back.

## Known open problems

| | |
|---|---|
| **B10** | Half done 2026-08-12: temporary passwords now expire (24h reset, 72h invite). What remains is the roster invite sending an announcement rather than a password where there is an email — not started, and wants doing with the import. |
| **B12** | Configured 2026-08-11; no off-site backup has run *yet*, because the trigger was deployed 16 minutes after that night's window. First real window is 03:30 IST on 2026-08-13. |
| **B20** | The nightly backup's three sweeps share one 50-subrequest ceiling, and the later ones would starve silently once residents start uploading. Not failing today. |
| — | Rejecting a proof gives the resident no reason, so they re-upload the same wrong screenshot. Now that rejection also returns the bill to `unpaid` and the late fee applies (B13), this matters more than it did. |
| — | Deleting a proof clears R2 but keeps `image_sha256`, so duplicate detection still fires against an image nobody can see. |
| — | Notices can be withdrawn and scoped, but not edited in place, pinned or expired. Fixing a typo still means withdrawing and reposting, which loses the comments — the PATCH endpoint accepts title and body, nothing in the interface sends them. |

**B13 is fixed** as of 2026-08-09 and no longer belongs here: the late-fee hold
now expires after seven days and a rejected proof returns the bill to `unpaid`
rather than to the state the cron protects.

Full list with reasoning in `docs/BACKLOG.md`.

## The Android payment failure — REOPENED, one run done

**Reopened 2026-08-11**, hours after being written up as closed. The handoff
note said do not reopen; that is superseded. Nothing new broke — what changed is
that a second look found the closing argument rests on two handsets, and one of
them contradicts it. Read the section below as the leading hypothesis, not as a
finding.

**The first run has since happened, and it moved things.** Every link shape
tried resolved on a third handset, so the failure is not universal; and Google
Pay resolving while an installed-but-unregistered PhonePe did not — same phone,
same minute — is the first controlled evidence that account state is what
decides. Jump to "Results" below for the table and the reasoning. The paragraphs
between here and there are the ORIGINAL write-up, left unedited so it can be
read against what the run actually showed.

Investigated 2026-08-11 on real hardware. **The links were never the problem,
and no change to them can fix this.**

What was proven, on a stock Android with apps registered for `upi://`: every
link shape the portal emits — plain `upi://`, `intent://` with and without a
package, `gpay://`, `tez://` — delivers our exact URI to the app byte for byte,
and the plain link raises Android's own app chooser. The payload is equally
clear: Google Pay reads the identical URI correctly when it arrives by QR.

What actually fails is intent RESOLUTION. On both handsets inspected, the UPI
apps had **disabled their own deep-link components** — Google Pay's
`UpiIntentFilter`, PhonePe's `IntentRegistrationActivity`, Paytm's
`UPIDeeplinkActivity`. The manifests still advertise the filters, which is why
they look correct from outside, but a disabled component is invisible to
resolution. Android returns "unable to resolve", and Chrome does the only two
things it can: nothing at all for `upi://`, or follows `browser_fallback_url`
for `intent://` — which pointed back at the dashboard and read as a page
reload. Both reported symptoms, one cause.

**Nothing outside the app can switch those components back on.** Enabling them
needs `CHANGE_COMPONENT_ENABLED_STATE`, which is signature-level; a web page has
no access to the package manager at all. Even `adb shell pm enable` with USB
debugging is refused outright — `SecurityException: Shell cannot change
component state`. Only Google Pay can, by its own logic, per device.

Why the apps disable it is NOT established. Onboarding state is the obvious
theory — the OnePlus tested had no bank linked, and an app should not advertise
a payment door it cannot open — but the phone that originally failed has a
working Google Pay, which the theory does not explain. No documentation states
the rule. The direction of travel is at least consistent: UPI security guidance
says not to rely on custom schemes because any app can claim `upi://`, and
Google's own web documentation offers websites no deep-link path, only a
verified-merchant API.

**The design conclusion:** a web page cannot see whether a resident's UPI app
will accept a link, so the pay screen must work when it does not. Hence the
chooser first, the QR on mobile as well as desktop, the UPI ID always copyable,
and an honest message when a tap goes nowhere.

**That design conclusion survives the reopening and should not be unpicked.** It
does not depend on WHY the apps refuse — only on the fact that a web page cannot
find out in advance. Every result below leaves that argument standing. What is
back in question is the cause, and therefore whether anything can be done about
it beyond coping.

### What is being tested now

The question that reopens this is the one already written down as unverified:
**does a UPI app with a bank account actually linked keep its deep-link
component enabled?** The onboarding-state theory predicts yes. The phone that
originally failed predicts no, because its Google Pay works. Both cannot hold.

The direct check is `adb shell dumpsys package … | grep -A10 disabledComponents`,
and **it is not available on the handset we have access to** — a OnePlus in
India with several UPI apps and real bank accounts linked, reachable only by
sending its owner a link. No USB, no adb, no shell.

So component state has to be inferred from tap outcome, and that inference runs
in one direction only:

* **A tap that opens the UPI app proves the component was enabled.** Nothing
  else produces that outcome. This is the direction that settles the question.
* **A tap that does nothing proves very little.** A disabled component, an
  in-app WebView refusing the scheme, and an OEM browser build behaving
  differently are indistinguishable from outside — an absence, which is what
  made this hard the first time.

Fortunately the decisive direction is the one this handset can supply, because
its apps work. If bank-linked apps open cleanly, the onboarding theory gains
real support and the originally-failing phone becomes a separate anomaly needing
its own explanation. If they also die, the theory is dead and the cause lies in
the device, the OEM build or Chrome — not in onboarding.

**The payload is not a suspect, and cannot be made one.** Android matches intent
filters on action, category and data — scheme, host, path, MIME type. Query
parameters take no part in matching, so `pa`, `pn`, `am`, `tr` and `mc` are
opaque bytes at the moment resolution succeeds or fails. An app that never
launches never reads them. This is why the merchant-VPA question recorded under
"Not verified by me" does not bear on this section however it is answered: it
can only matter once an app has opened, which is the step that is failing.

The one caveat is worth carrying, because `functions/lib/upi.js` invites the
confusion: the note there on removing `tr` claims a payload an app cannot
classify draws a refusal that "from a browser looks like the app simply
declining to open." Today's links carry no `tr`, so nothing current can trigger
that. But it means restoring `tr` without a correct `mc` would create a SECOND,
independent path to this exact symptom — one that would look like a regression
of this bug and would not be. Knowing the MCC is how that is avoided, not how
this is fixed.

**The largest threat to this test is not the phone, it is the messenger.**
In-app WebViews refuse custom schemes outright, so a link tapped inside WhatsApp
dies silently and looks *identical* to the bug. That single mistake would
manufacture a false negative and appear to confirm the theory while proving
nothing. The harness warns about it on screen; the tester still has to open the
page in Chrome for any result to mean anything.

### The harness

`scripts/gen-upi-testpage.mjs` generates a standalone page carrying all eleven
shapes — plain `upi://`, bare `intent://`, `intent://` addressed to each of the
four packages, each per-app scheme, and legacy `tez://`. Its design choices are
constraints rather than preferences, and each is argued at the top of that file:

* **Generated from `buildUpiLinks`, not hand-written.** A page carrying its own
  copy of the URI construction would prove that the copy resolves, which is
  worth nothing. `test/upi-testpage.test.js` fails if the two drift.
* **Deployed as its own throwaway Pages project, never under the portal.** The
  portal's hostname carries the association's name, and so does every preview
  beneath it. It also keeps test traffic out of production D1 — going through
  the real pay route would write `payment_intents` rows and flip a bill to
  `initiated`, putting a phantom "this resident is paying" in the committee's
  queue for a payment nobody attempted.
* **The payee is a parameter with an unresolvable default, and the amount is
  ₹1.** The association's VPA must never appear, or a working link puts a real
  bill payment one tap from someone who does not know what they are looking at.
  But an unresolvable payee is not free either: an app that opens and then
  errors is ambiguous in the tester's retelling. A VPA the tester's family owns
  resolves that ambiguity and costs at most a rupee.
* **`tn` carries `TEST LINK - PLEASE DO NOT PAY`.** The note is rendered on the
  UPI app's own confirmation screen — the only channel that reaches the tester
  after the browser has handed off. Mitigation, not a guarantee: not every app
  displays it, which is why the ₹1 cap does the load-bearing work.
* **Results are read off the screen and copied back by hand, not beaconed.**
  Silent reporting would be less trouble and would collect less. The page can
  only observe whether it lost focus; *which* app opened, whether a chooser
  appeared, and whether the confirmation screen resolved a payee are the
  observations that actually settle this, and only the person holding the phone
  can make them.

### How the run is being done

Over a WhatsApp video call with the handset's screen shared, the link pasted
into Chrome by hand rather than tapped from the chat. The hand-paste is the
point: a link opened from inside WhatsApp lands in its WebView, which refuses
custom schemes by design, and every shape would die in a way indistinguishable
from the bug. Watching live also replaces the tester's retelling with direct
observation, which matters because the page itself can only detect focus loss.

**A limitation to read the results through: the confirmation screen will
probably not be visible.** UPI apps set `FLAG_SECURE` on payment screens to
defeat screenshot fraud, and that blanks screen capture as well, so the shared
view is expected to go black at exactly the most interesting moment. This costs
less than it appears — the app LAUNCHING is the observation that settles
resolution, and it happens before the secure screen. The payee name, which is
the secondary confirmation, has to be read aloud instead.

The plain `upi://` link is tapped first and the chooser dismissed with "just
once" every time. Choosing "always" would set an Android default and silently
skip the chooser on every later tap, which would turn the single most
informative test into one that cannot be repeated without clearing app defaults
in system settings.

### Results — run 1, 2026-08-11

One handset, in India, over a shared screen. Chrome confirmed genuine
(`webview-detected: false`), so the WebView false negative did not occur. UA
`Mozilla/5.0 (Linux; Android 10; K) … Chrome/150.0.0.0 Mobile Safari/537.36` —
the `Android 10; K` is Chrome's reduced user agent, not the real OS version,
which this run therefore does not establish.

| Link shape | Tap outcome | Reads as |
|---|---|---|
| `upi://` plain | opened, **OS chooser shown** | resolved; chooser path proven |
| `intent://` bare | opened | resolved |
| `intent://` → gpay | opened | Google Pay's component ENABLED |
| `intent://` → phonepe | **Play Store**, app INSTALLED, no account registered | component NOT resolvable |
| `intent://` → paytm | Play Store, app not installed | correct fallback |
| `intent://` → bhim | Play Store, app not installed | correct fallback |
| `gpay://` scheme | opened | resolved |
| `phonepe://` scheme | not tried | — |
| `paytm://` scheme | not tried | — |
| `bhim://` scheme | not tried | — |
| `tez://` legacy | opened | resolved, still alive on this install |

**The headline: resolution WORKS on this device, for every shape tried.** The
closed write-up above says Android refuses these links. On a third handset it
does not refuse them at all. Whatever is wrong, it is not universal — which
means the portal's Android pay screen is very likely fine for a resident whose
UPI app is properly set up, and that is most residents.

**The PhonePe row is the whole finding, and it is a controlled one.** Same
phone, same Chrome, same minute: Google Pay — registered, bank linked —
resolved. PhonePe — *installed* but registered to nobody — did not resolve, and
Chrome fell back to the Play Store, which is precisely what an addressed intent
does when no component answers. Device, OEM build and browser version are held
constant across those two rows, so they cannot explain the difference. Account
state is the only variable left standing.

That is the strongest evidence yet for the onboarding-state theory, and it was
obtained without the `adb` command that could not be run. The inference works
because the direction is the sound one: an app that opens proves its component
was enabled.

**What it still does not explain** is the phone that started all of this, which
reportedly has a working Google Pay and failed anyway. That was the reason for
reopening and it remains unanswered. The likeliest resolutions are that its
Google Pay was less set up than remembered, that it failed for a different
reason entirely, or that the original report described something other than
what we now think it did. Re-testing THAT handset against this same page is the
obvious next move, and it is now a cheap one.

**Every row is accounted for, with nothing left over.** Install and account
state were established afterwards, and they explain the table exactly:

| App | Installed | Account | Outcome |
|---|---|---|---|
| Google Pay | yes | yes | opens |
| PhonePe | **yes** | **no** | Play Store |
| Paytm | no | — | Play Store |
| BHIM | no | — | Play Store |

The Paytm and BHIM rows turn out to be the control, and they earn their place by
being unremarkable: an absent app SHOULD bounce to the store, that is what the
fallback in `intentUri` was added for, and it did. Which sharpens the PhonePe
row into the finding of this run — **an installed app with no account behaved
identically to an app that was not installed at all.** From the browser's side
the two are indistinguishable, and that is precisely why this bug was so hard to
see: the portal cannot tell "you don't have this app" from "you have it and it
won't answer", and neither can the resident.

**The full chain is verified, not just the launch.** The confirmation screen
showed the payee name, the ₹1 amount, and note text (unreadable over the video
call, but present). So registry resolution, amount carriage and `tn` delivery
all work end to end. The payee name in particular is what makes this run
unambiguous — it is the reason a resolving VPA was used instead of the
unresolvable default.

**The OS chooser DID appear**, reported after the run. That is the single most
load-bearing observation here, because the Android pay screen leads with the
plain `upi://` link on the argument that the chooser is the mechanism NPCI
defines — and until now that first route rested on behaviour nobody had watched.
It works.

This was first written up in this document as unobserved, on the reasoning that
only one app on the device could answer and Android launches straight into a
single handler. **The reasoning was sound and the premise was invented.** That
only Google Pay could answer was an inference from the four apps this page
happens to test, never an observation, and a chooser appearing proves at least
two handlers resolved. The correction is left visible rather than tidied away,
because the mistake is instructive: the page tests four packages, the DEVICE has
whatever it has, and reading "the apps we asked about" as "the apps installed"
is exactly the sort of quiet substitution that produced the original wrong
conclusion about this bug.

So the device carries at least one more UPI-capable app than the four tested —
WhatsApp Pay, Amazon Pay, Cred and bank apps such as iMobile or SBI Pay all
register for `upi://` and are ordinary things to have. **Which apps the chooser
listed is not recorded, and it matters**: if PhonePe appeared in it, that sits
awkwardly against the same PhonePe failing to answer a package-addressed intent
minutes earlier, and the account-state finding would need re-examining. If the
list was other apps entirely, the finding stands untouched. Noted in "Not
verified by me" rather than guessed at.

**A real UX defect fell out of this.** An `intent://` addressed to an installed
but unregistered app sends the resident to the Play Store to install software
they already have. The pay screen shows all four app buttons unconditionally,
so a resident with a dormant PhonePe taps PhonePe and is told to install
PhonePe. Filed as B23.

## Not verified by me

Things I could not check and someone should:

- **Whether the handset that ORIGINALLY failed still fails**, against the same
  test page. After run 1 this is the open question rather than a loose end: its
  Google Pay reportedly works, which is the one thing the account-state finding
  does not account for. The page is already deployed and the run takes ten
  minutes, so this is the cheapest unanswered question in this document.
- **WHICH apps the chooser listed** in run 1. That it appeared at all is now
  settled and was the bigger question; its contents are the loose end. If
  PhonePe was among them, that sits badly against the same PhonePe refusing a
  package-addressed intent minutes earlier, and the account-state conclusion
  would need re-examining rather than defending. If the list was other apps —
  WhatsApp Pay, Amazon Pay, a bank app — the conclusion stands and the only news
  is that the device has more UPI apps than this page tests.
- The god-mode Health tab rendering against production.
- That an impersonated admin genuinely cannot reset the superadmin's password
  on the live site. Proven locally with a real admin session, never on prod.
- Whether `qr.ddwelfare@sib` is registered as a MERCHANT VPA, and its MCC. The
  answer decides whether `tr` can return to the payment link — it was removed
  because sending it without `mc` describes a merchant transaction the payload
  cannot substantiate, which PSP apps refuse. One call to South Indian Bank.

  **Partial evidence as of 2026-08-11: Google Pay lists this payee under
  "Businesses."** Together with the `qr.` prefix, which South Indian Bank
  issues for collect/QR merchant accounts, and with the payee name resolving
  from the registry, that points at a genuine merchant registration.

  It is not enough to act on, for two reasons. It is a PSP's own UI grouping
  rather than the registry answering, so it is a strong hint about how one app
  classifies the payee, not a fact about how the account is registered. And it
  yields **no MCC at all** — which is the half that matters, because `tr` only
  returns alongside `mc`, and `mc` needs the actual category code. The call to
  the bank is still the thing that closes this.

**`qr.ddwelfare@sib` is a live VPA** and no longer belongs on this list, as of
2026-08-11: Google Pay resolved it from the portal's own QR and displayed the
payee as DD Diamond Park RWA. A UPI app only shows a payee name after the
address resolves against the registry.

**The deep-link component question has moved off this list**, also 2026-08-11 —
not because it was answered, but because it is now being actively tested rather
than merely noted. It lives under "The Android payment failure", along with the
reason the `adb` command that would settle it cannot be run on the only suitable
handset available.
