# Where this is, 9 August 2026

What is built, what is live, what is half-done. Figures read from production
rather than remembered.

---

## In one line

The portal is **built and deployed**. It has never billed a real month.

## Production right now

**https://diamondpark.pages.dev** · 472 tests · `npm run doctor` reports 0 failing

| | |
|---|---|
| Flats | 99 |
| People | 103 — **99 of them demo** |
| Bills | 880 — all demo |
| Months | 10 — all demo |
| Migrations applied | 13 |
| Error codes | 61 |

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

**Payment.** UPI deep links per platform, dynamic QR on desktop, Android
`intent://`, a manual fallback on every platform, payment-intent logging.

**Proof.** Client-side resize, upload to R2, duplicate detection by image hash
and UTR, a review queue with bulk approve for exact matches, retention pruning.

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

**Nightly Drive backup** — written in phase 8, deployed, **never run once**. No
Google secrets have ever been set. The only backups that exist were taken by
hand during development. Same credentials as email, so one setup fixes both.

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
3. **A Gmail account.** Unblocks `/forgot` and the backup together.

Order matters: import the roster, walk the meters, generate the month, **then**
send the logins. A resident who logs in to an empty dashboard decides the site
is useless and does not come back.

## Known open problems

| | |
|---|---|
| **B13** | A rejected proof returns a bill to `initiated`, which the late-fee cron holds rather than charges — so a resident whose screenshot is rejected becomes permanently immune. The hold also has no time limit. Neither has fired; there are no real bills. |
| **B10** | Admin-issued temporary passwords never expire. Sent over WhatsApp, which keeps them for years. |
| **B12** | No off-site backup has ever run. |
| — | Rejecting a proof gives the resident no reason, so they re-upload the same wrong screenshot. |
| — | Deleting a proof clears R2 but keeps `image_sha256`, so duplicate detection still fires against an image nobody can see. |
| — | Notices cannot be edited, pinned, or expired. Fixing a typo means deleting and reposting, which loses the comments. |

Full list with reasoning in `docs/BACKLOG.md`.

## Not verified by me

Things I could not check and someone should:

- **Whether the reported Android payment failure is fixed.** Two real defects
  were found and corrected, but the original could not be reproduced from here.
  It needs testing on the phone that failed.
- The god-mode Health tab rendering against production.
- That an impersonated admin genuinely cannot reset the superadmin's password
  on the live site. Proven locally with a real admin session, never on prod.
- Whether `qr.ddwelfare@sib` is a live VPA.
- Whether the Malayalam strings are correct. They are unreviewed, and a
  language toggle would remove the English sitting beside them.
