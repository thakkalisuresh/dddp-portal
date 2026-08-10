# DD Diamond Park gas portal — requirements

For someone who is going to change the code. Plain-language description of the
building and the workflow is in the README; this is the reasoning, the
constraints, and the decisions that are expensive to reverse.

---

## The problem

The association bills piped gas to 99 flats. It ran on `gas.dddp.online`, built
by a resident who has since left.

**Nobody can reach that hosting.** Not the domain registrar, not the server, not
the database. The site works today and could stop tomorrow, and when it does
there is no export, no backup, and no way in. Everything the association knows
about who owes what lives somewhere unreachable.

That single fact drove most of what follows.

## Goals

1. **Replace it before it disappears.** The bar is "a resident can see what they
   owe and pay it", not feature parity with a site nobody can maintain.
2. **Cost nothing to run.** The association has no budget line for software. A
   recurring bill is a reason for this to be switched off in two years.
3. **Survive its author.** Whoever inherits this must be able to read the code,
   run it, and change it. That is why the reasoning is in comments rather than
   in anyone's head, and why the documentation is generated where it can be.
4. **Be usable by everyone in the building,** including residents who use only
   WhatsApp, and owners who live abroad.

## Non-goals

Each of these was considered and rejected. Reopening one is fine; doing so
without reading why it was closed is not.

- **A payment gateway.** Fees on every transaction, KYC on the association, and
  a settlement account nobody wants to be personally liable for. UPI to the
  existing account with a screenshot is what the building already does.
- **Automatic reconciliation.** A personal VPA gives no callback and no usable
  reference field. Anything claiming to auto-match would be guessing, and a
  wrong guess is somebody marked paid who has not paid.
- **A mobile app.** 99 households will not install one. The web page is the app.
- **Accounting.** This bills gas. Maintenance, sinking fund and the audit are
  somebody else's system and should stay there.
- **Being a general-purpose society platform.** ApnaComplex and MyGate exist. The
  gap they do not fill is sub-metered gas billing, which is all this does.

## Constraints

**Free tier, permanently.** Cloudflare Pages, Workers, D1 and R2. Measured usage
and headroom are in `docs/COSTS.md`. Deploys are free; only usage meters, and
the building sits about three orders of magnitude under every limit.

**Two deployments over one database.** Pages Functions have no cron trigger, so
the nightly work runs in a separate Worker (`dddp-portal`) beside the site
(`diamondpark`). They share one D1. **Secrets set on one do not reach the
other**, and Pages secrets bind only to a NEW deployment. This has cost hours
more than once.

**No build step for the browser.** Plain ES modules, no framework, no bundler on
the client. Someone opening this in three years should be able to read a file
and change it.

**Strict CSP** (`default-src 'self'`, `script-src 'self'`). No inline script, no
CDN. Anything third-party is vendored.

## The invariants

These are the things that will bite. Each is enforced in code and has a test.

**1 · The meter counts cubic metres; the bill charges kilograms.** The factor is
2.60, derived from the old portal's own history rather than assumed. Treating a
meter delta as kilograms under-bills every flat by 2.6×. Stored per period and
snapshotted onto each bill, because calorific value is revised and old bills
must keep their own.

**2 · A bill is what the meter and the rate produce, rounded UP.** Ceiling, not
round-to-nearest: verified against four real bills, where 314.25 was billed as
315. Nothing is added and nothing is encoded in the amount.

**3 · Bills and proofs belong to the PERSON, not the flat.** After a sale the
incoming owner must not see the previous owner's bills or open their receipts.
`bills.owner_id` and `payment_proofs.owner_id` enforce it. Readings are
different — a meter reading is a fact about the property and carries across.

**4 · The client never sends an identity.** No `?flat=4A`. The subject comes
from the session, always.

**5 · There is exactly one superadmin.** The role can be moved, never copied.
Admins run the building; the activity log, click capture, view-as and
impersonation are superadmin-only. Recovery from a lost superadmin is direct
database access — `scripts/reset-my-password.mjs`.

**6 · The tenant is billed; the owner is liable.** One column, `relationship`,
values `owner` and `tenant`. Everything else derives: a flat with a tenant has
an absent owner who sees amounts but not screenshots; a flat without one bills
its owner. Storing "absent" separately would store the same truth twice and the
copies would drift.

**7 · Every god-mode edit is recorded.** Unlimited power is only safe to hand
someone if the record of using it is automatic. Before, after, actor, and — for
money — a reason.

## The billing cycle

The rate is not known until the supplier invoice arrives, which inverts the
usual order:

```
meter walk  →  readings entered  →  rate set for THAT month  →  preview  →  generate
```

**A rate is never carried forward.** An inherited rate produces 99 bills that
look normal and are all wrong, and nobody notices until someone checks an
invoice. Generation is blocked until the rate is set for that period.

The preview exists because generation is the one irreversible bulk action: it
shows the total, the outliers and anything blocked, so a rate with an extra zero
is caught before 99 bills go out rather than after.

## Payment

UPI deep link to the association's existing VPA, with a QR on desktop. The link
carries `tr=DDP4A202606` — flat and period — which is what reconciliation
actually rests on, plus a human-readable note `(4A_09_08_26)` for the statement.

Four things learned the hard way, three of them from the same report — "I press
Pay and nothing happens":

- Spaces must be `%20`, never `+`. UPI apps decode strictly, and a rejected
  intent looks exactly like a button doing nothing.
- Android needs an `intent://` URI. Chrome hands bare custom schemes to the OS
  unevenly and fails silently when it declines. But an *unaddressed* intent was
  not enough: it relies on the OS chooser appearing, and when it does not — no
  handler resolved, or an in-app WebView that blocks non-http URLs, which is how
  a link arriving over WhatsApp is usually opened — the tap is still silent. So
  Android now gets the same named app row as iOS, each link carrying
  `package=`, which resolves to that app or to its Play Store page. Every intent
  also carries `S.browser_fallback_url`, pointing at `/dashboard#pay-help`.
- **Assume the handoff can fail, and say so.** A UPI link has no success or
  failure callback; the only observable signal that an app took over is the page
  losing visibility. If that never comes within 1.6s, the dashboard reveals the
  manual route by itself rather than leaving somebody tapping a dead button.
- **Always offer a manual route.** No deep link works everywhere. "Pay another
  way" shows the UPI ID, amount and note on every platform.

Tapping Pay records an *intent*, not a payment. There is no callback; all it
means is that someone opened their app. Copying the UPI ID from "Pay another
way" records the same thing, for the same reason — that resident is equally
about to send money, and without it the people who pay from their own app are
exactly the ones the late-fee cron charges. The cron holds intents rather than
charging, and the treasurer checks the bank statement.

Once a screenshot is uploaded the bill reads `awaiting` and the Pay button is
withdrawn: that resident has paid and proved it, and a duplicate credit is more
work for the treasurer than a missing one. `initiated` keeps the button — an app
opening is not a payment.

## What is deliberately manual

The treasurer approves every payment. The system narrows the work — duplicate
screenshots and reused UTRs are rejected, exact amount matches can be approved
in bulk — but a human decides. There is no reliable signal that money arrived,
so pretending otherwise would only move the error somewhere harder to see.

## Failure and observability

Every failure leaves through one path, `reportError`, into a registry of coded
errors (`DDP-<DOMAIN>-<NNN>`). `fatal` and `error` push to Telegram
immediately; `warn` batches into a morning digest; everything lands in
`error_log`.

`npm run doctor` checks the invariants against live data and prints a report
built to be pasted into a chat. **Every real bug this system has had was an
invariant violation that nothing was watching for** — mobiles stored in two
spellings, a "daily digest" documented three times and never built, a bill that
stopped matching its own components. None of them threw. The doctor exists
because comments rot and assertions do not.

## Decisions worth not re-making

| Decision | Why |
|---|---|
| Mobile is the login, stored E.164 | Everyone has one; email coverage is patchy. Mixed formats broke both the UNIQUE index and login. |
| Six-digit reset codes, no link | A link in an email is a bearer token that survives in inboxes, and scanners follow links and consume them. |
| Bills follow the occupant | Gas is metered consumption. Maintenance systems bill the owner because maintenance is a charge against the property. |
| Exemptions expire | A boolean gets set during a dispute and never unset. A date makes forgetting the safe direction. |
| Late fee is flat and charged once | Compounding on a ₹300 bill is a dispute nobody in a 99-flat building wants. |
| Deactivate, never delete | Departure is `active = 0`. History has to survive the person leaving. |
