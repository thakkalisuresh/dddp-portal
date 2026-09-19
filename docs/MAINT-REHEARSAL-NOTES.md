# Maintenance billing: rehearsal notes

Run on `dddp-migtest` via `staging.diamondpark.pages.dev`, 18–19 September 2026,
from branch `feat/maintenance-billing`. Screens were opened and driven by hand,
not exercised by a script. **Nothing touched production, `main`, or the `dddp`
database.**

Read the findings first. A clean write-up would have been the surprising result.

## What broke

### 1. The quarter could not be scheduled at all — FIXED

All 11 flagged tenancies on staging have no lease end date, which is exactly the
state 1 October will be in, because there is no roster. The acknowledgement
checkbox — "Schedule anyway, I know these dates are missing" — was rendered only
when nothing was blocking, and those undated rows *were* the block. So the box
never appeared and **"Schedule this quarter" could not be pressed**.

The server has always accepted this case on the acknowledgement: `tenancyReadiness`
refuses an *expired* lease and lets an undated one through. Only the screen
refused, which is the wrong way round when the server is the guard.

Fixed: a lease that has ended and a tenancy nobody has confirmed stay hard blocks
(both are fixable on the row), a missing lease end is acknowledgeable, and the
checkbox now enables the button.

### 2. A resident tapping Pay got "Something went wrong" — FIXED, but see below

The preview environment has no maintenance payee secrets, so `/api/pay` failed
with `DDP-PAY-004` and the payment sheet rendered an error. **`checkMaintPayee`,
the check written to prevent exactly this, existed with five tests and was never
called by `runChecks`** — so the doctor reported the building healthy while every
Pay button on it was broken.

Now wired in, and it reports `fail` on staging with the remediation. The fix in
the code is done; **the secrets themselves are still missing on both Pages
environments and are the user's to set.**

### 3. "Still here" did nothing on the flag that blocks the quarter — FIXED

Confirming a tenancy whose lease has already ended stamps the date and leaves the
flag exactly where it was, because `lease-ended` outranks `unchecked`. The
approved helper said it clears the flag. The row now also offers **"Add date"**,
which is the fix it was telling the admin to make.

### 4. An issued quarter can become unreachable from its own tab — NOT FIXED

`workingQuarter` returns the first draft or scheduled quarter, else the quarter
the *calendar* is in. With Q4 issued and the calendar still in Q3, the tab showed
"Q3 2026 — not drafted yet" and offered no picker, while 94 bills worth ₹7,21,500
sat behind it. The data was intact: `/api/admin/maint?quarter=2026-Q4` returned
everything.

**Triggered by the rehearsal's own dates** — Q4 was given a September issue date
so the job would fire — and on 1 October the calendar quarter *is* Q4, so
production does not meet this. It is still one date typo away: the quarter picker
should be built from the quarter rows that exist rather than from the working
quarter. Left for a decision rather than fixed mid-rehearsal.

## What worked

- **Migrations 0035–0045 applied to a database with rows in it** — 99 flats, 105
  owners, 994 gas bills. `PRAGMA foreign_key_check` clean afterwards, which is
  the question 0042's closing note raised about `maint_approvals` and
  `tenancy_change_approvals`.
- **Step 2 at 99 flats**: 94 billed, 5 skipped, 11 at the rented rate, ₹7,21,500.
  The flat-by-flat list reads cleanly — flat, who is billed, the rate, and
  owner-occupied or rented — and the tiles carry the rented count, which is the
  number to check first.
- **Schedule → unschedule → schedule again**, then **issue**: 94 bills raised in
  one batch, the receipt naming who scheduled it and when.
- **The outbox at scale**: 94 rows written with the bills, 93 `unreachable`
  (no address on file) and 1 `queued`. A drain must never spend a subrequest
  discovering an address that was never there, and it does not.
- **The resident view** of an issued bill: "Q4 2026 (Oct–Dec) · ₹7,500 · Due 29
  September · ₹750 late fee from 30 September."
- Amounts group correctly at five figures on real data: **₹7,21,500**.

## What could not be tested here, and why

- **No letter was actually sent.** Staging has no mail configured
  (`reason: "not-configured"`), so the drain sends nothing. Reading the letters
  in a real mail client — the last chance to catch a sentence that reads wrong
  outside the template — needs either Gmail secrets on the preview environment or
  a send from production. That is the user's call; the rendered HTML has been
  sent to them separately.
- **The payment sheet end to end**, because of finding 2. Once the preview
  secrets exist this is a five-minute check.
- **Android.** The ₹1 iPhone test is the user's and is done: Google Pay, PhonePe
  and Paytm all completed against the real account. Android is untested and its
  mechanism differs — it goes through an intent rather than a scheme URL.
  Anything below about app behaviour is **iOS-only evidence**.
- **Staging carries two mailable addresses**, one of them the user's own. The
  third-party address was blanked before any job was run, so nothing could reach
  a stranger. Worth knowing before the next `staging:refresh`.

## The three questions about pre-payments

**1. Does recording an advance before the quarter is issued do the right thing?**
**No.** An approved advance covering 2026-Q4, recorded before issuing, does
nothing at issue time: the flat gets a full bill, status `unpaid`, and a letter
demanding money it has already paid. `advanceCovers()` and `furthestAdvance()`
exist and are tested; **nothing in the issue path, the resident payload or the
bill view calls either of them.**

The one-sentence answer for the treasurer: **issue first, then record the payment
against the bill.** Do not record advances ahead of 1 October expecting them to
suppress anything.

**2. Will Reconcile accept a maintenance statement before any bill exists?**
Yes, gracefully. With no unpaid bills every credit falls to "Nothing owing
matches this credit", which is the same reported-never-guessed path as any credit
with no candidates — and `amountIdentifiesPayer: false` means the amount is never
allowed to name the payer on this account. **But an admin cannot turn such a
credit into an advance from that screen**: the only action offered is "Assign to
{flat}" for an actual candidate bill. They would have to note the flat and record
it elsewhere.

**3. So which route?** Neither is comfortable before issuing. The honest answer
is the fallback: after the quarter issues on 1 October, the treasurer names the
flats that already paid and an admin records each payment against its bill. Fine
for a handful, tedious for thirty — and it means the September pre-payers do
receive the 1 October letter.

## Before launch

- Set `MAINT_ACCOUNT_NUMBER`, `MAINT_IFSC` and `MAINT_PAYEE_NAME` as Pages
  secrets on **both** environments, and **redeploy** — Pages binds secrets at
  deploy time, so setting one without redeploying changes nothing.
- Run the doctor after that deploy and confirm `MAINT-PAYEE` is gone.
- Migrations against production **before** the deploy; deploy from `main` with
  the release stamp; then verify the deployed asset itself.
- The payee name is still a stand-in in the config, not a decision.
