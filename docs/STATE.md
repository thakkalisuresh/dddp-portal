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
| **B10** | Half done 2026-08-12: temporary passwords now expire (24h reset, 72h invite). What remains is the roster invite sending an announcement rather than a password where there is an email — not started, and wants doing with the import. |
| **B12** | Configured 2026-08-11; no off-site backup has run *yet*. First 3am is unproven. |
| — | Rejecting a proof gives the resident no reason, so they re-upload the same wrong screenshot. Now that rejection also returns the bill to `unpaid` and the late fee applies (B13), this matters more than it did. |
| — | Deleting a proof clears R2 but keeps `image_sha256`, so duplicate detection still fires against an image nobody can see. |
| — | Notices can be withdrawn and scoped, but not edited in place, pinned or expired. Fixing a typo still means withdrawing and reposting, which loses the comments — the PATCH endpoint accepts title and body, nothing in the interface sends them. |

**B13 is fixed** as of 2026-08-09 and no longer belongs here: the late-fee hold
now expires after seven days and a rejected proof returns the bill to `unpaid`
rather than to the state the cron protects.

Full list with reasoning in `docs/BACKLOG.md`.

## The Android payment failure, resolved as far as it can be

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

## Not verified by me

Things I could not check and someone should:

- Whether a UPI app with a bank account actually linked keeps its deep-link
  component enabled. One command answers it on such a phone:
  `adb shell dumpsys package com.google.android.apps.nbu.paisa.user | grep -A10 disabledComponents`
- The god-mode Health tab rendering against production.
- That an impersonated admin genuinely cannot reset the superadmin's password
  on the live site. Proven locally with a real admin session, never on prod.
- Whether `qr.ddwelfare@sib` is registered as a MERCHANT VPA, and its MCC. The
  answer decides whether `tr` can return to the payment link — it was removed
  because sending it without `mc` describes a merchant transaction the payload
  cannot substantiate, which PSP apps refuse. One call to South Indian Bank.

**`qr.ddwelfare@sib` is a live VPA** and no longer belongs on this list, as of
2026-08-11: Google Pay resolved it from the portal's own QR and displayed the
payee as DD Diamond Park RWA. A UPI app only shows a payee name after the
address resolves against the registry.
