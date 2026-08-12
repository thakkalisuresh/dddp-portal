# Where this is, 9 August 2026

What is built, what is live, what is half-done. Figures read from production
rather than remembered.

---

## In one line

The portal is **built and deployed**. It has never billed a real month.

## Production right now

**https://diamondpark.pages.dev** · 547 tests · `npm run doctor` reports 0 failing

| | |
|---|---|
| Flats | 99 |
| People | 103 — **99 of them demo** |
| Bills | 880 — all demo |
| Months | 10 — all demo |
| Migrations applied | 13 |
| Error codes | 69 |

> ### The demo data is live
>
> 99 flats and 880 bills of generated data are in the production database for
> user testing. **It must come out before the real roster goes in**, or the
> import meets 99 flats that already exist.
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
passwords, a send-and-chase worklist, owners and tenants, flat transfer,
self-service password reset by emailed code.

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
after sitting inert since. It has still not run: the first 3am is the one to
check. Doctor moved from BACKUP-NOT-CONFIGURED to BACKUP-NEVER, which is the
whole of what has been proven so far.

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
| **B10** | Admin-issued temporary passwords never expire. Sent over WhatsApp, which keeps them for years. |
| **B12** | Configured 2026-08-11; no off-site backup has run *yet*. First 3am is unproven. |
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
| `upi://` plain | opened | resolved, chooser path works |
| `intent://` bare | opened | resolved |
| `intent://` → gpay | opened | Google Pay's component ENABLED |
| `intent://` → phonepe | **Play Store**, app installed but no account registered | component NOT resolvable |
| `intent://` → paytm | Play Store | uninterpretable — install state unknown |
| `intent://` → bhim | Play Store | uninterpretable — install state unknown |
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

The Paytm and BHIM rows are recorded as uninterpretable rather than quietly
counted as failures. The Play Store fallback is the correct and documented
behaviour for a package that is not installed, so without knowing whether those
two apps are on the device the rows carry no information. Treating them as
evidence would be counting an expected result as a surprising one.

**A real UX defect fell out of this.** An `intent://` addressed to an installed
but unregistered app sends the resident to the Play Store to install software
they already have. The pay screen shows all four app buttons unconditionally,
so a resident with a dormant PhonePe taps PhonePe and is told to install
PhonePe. Filed as B20.

## Not verified by me

Things I could not check and someone should:

- **Whether the handset that ORIGINALLY failed still fails**, against the same
  test page. After run 1 this is the open question rather than a loose end: its
  Google Pay reportedly works, which is the one thing the account-state finding
  does not account for. The page is already deployed and the run takes ten
  minutes, so this is the cheapest unanswered question in this document.
- Whether Paytm and BHIM were installed on the handset used in run 1. Two rows
  of that table stay uninterpretable without it, because the Play Store fallback
  is the correct behaviour for an app that is simply absent.
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
