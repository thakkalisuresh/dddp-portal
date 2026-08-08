# DD Diamond Park — gas billing portal

Replacement for `gas.dddp.online`, a PHP/MySQL app on shared hosting abandoned by its author.
Runs at **₹0**: Cloudflare Pages + Workers + D1 + R2, free subdomain, no payment gateway.

**Live: https://diamondpark.pages.dev**

Full design and rationale: `dddp-portal-plan.md` (kept alongside this repo).

## Two deployments, one database

| | What it is | Deploy |
|---|---|---|
| `pages/` | The public site — **diamondpark.pages.dev** | `npm run deploy:pages` |
| root `wrangler.toml` | Cron only, no public route | `npm run deploy:cron` |

Both bind to the **same** D1 (`dddp`, APAC) and the same R2 bucket. The Worker
exists solely because Pages Functions have no cron triggers and the 3am
late-fee / backup / prune job needs one; its `workers.dev` route is off, so
residents have exactly one URL.

`npm run deploy:all` does both. **Deploy both** — shipping only Pages leaves
the cron running old code, and shipping only the Worker leaves the site stale.

## Status

| Phase | | |
|---|---|---|
| 1 | Scaffold, auth, sessions, roles, audit | **done** |
| 1b | God mode — view-as, impersonation, error log | **done** |
| — | Error-code registry + generated docs | **done** |
| 2 | Design system, app shell, self-hosted fonts, bilingual labels | **done** |
| 3 | Resident dashboard, login, dev seed | **done** |
| 4 | Meter reading grid + bill generation | **done** |
| 4b | Bulk reading import (paste + template) | **done** |
| 5 | UPI pay flow — real QR, intent logging | **done** |
| 6 | Proof upload, vision parse, review queue | **done** |
| 6b | Late fees — idempotent cron, waiver | **done** |
| 6c | Notice comments — per-notice opt-in, moderation | **done** |
| 7 | Public site — notices, committee, contact form | **done** |
| 7b | Admin console, profile, forced password change | **done** |
| — | Activity log, ownership transfer, editable committee | **done** |
| — | Click capture (opt-in, self-expiring), single-superadmin rule | **done** |
| 8 | Nightly Drive backup, CSV export, retention, CSP | **done** |

Screen designs for all 19 screens were built before any app code.

## Getting started

```bash
npm install
npx wrangler d1 create dddp          # paste the id into wrangler.toml
npm run db:local
npm run dev
```

```bash
npm run seed      # local dev data: 6 residents, real readings from the old portal
npm test          # 237 tests, no network or D1 needed
npm run errdoc    # regenerate docs/ERROR_CODES.md after editing the registry
```

Secrets: `npx wrangler secret put TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and
optionally `GROQ_API_KEY` or `GEMINI_API_KEY` for screenshot OCR.
Locally they go in `.dev.vars` (see `.dev.vars.example`).

## The five invariants

Everything else is ordinary CRUD. These are the things that will bite.

**0 · The meter counts cubic metres; the bill charges kilograms.** The conversion
factor is 2.60, derived from the old portal's own history (see test/billing.test.js).
Treating a meter delta as kilograms under-bills every flat by 2.6x. The factor is
stored per period and snapshotted onto each bill, like the rate.

**1 · The paise identify the flat.** Every bill total ends in that flat's permanent
`paise_tag` — 4A always `.04`. That is how the treasurer's bank statement tells who paid,
because a personal VPA gives no usable reference field. **Late fees are therefore whole
rupees only**: ₹329.04 + ₹50 = ₹379.**04**, never ₹379.54. Enforced by a `CHECK` constraint,
a guard in `applyLateFee`, and a test.

**1b · Bills and proofs belong to the PERSON, not the flat.** When a flat is sold
the incoming owner must not see the previous owner's bills or open their receipts.
`bills.owner_id` and `payment_proofs.owner_id` enforce it; readings stay keyed to the
flat alone, because a meter reading is a property fact. See `docs/PRIVACY.md`.

**1c · There is exactly one superadmin, and admins cannot see behavioural data.**
The role can only be *moved*, never copied. Admins run the building; the activity
log, click capture, view-as and impersonation are superadmin-only. Recovery from a
lost superadmin is direct D1 access — see `docs/PRIVACY.md`.

**2 · The client never sends an identity.** No `?flat=4A`. The subject is always derived
from the session token server-side. Endpoints that do take a flat id are admin-only and
re-check the role.

**3 · Sessions carry actor and subject separately.** God mode sets `subject_id` without
touching `actor_id`, so the admin's own session is never overwritten and Exit can't strand
you. Credential changes stay blocked while impersonating, even in write mode.

**4 · No error escapes unreported.** `reportError` is the only sanctioned exit. The failure
mode being guarded is a code marked `fatal` whose call sites all bypass the reporter —
invisible to alerts *and* the digest, silently inert since deploy. `test/error-codes.test.js`
asserts every live code has a call site, that no bare `throw new Error` exists, and that a
code gaining a call site drops its `planned` flag.

## Layout

```
functions/
  index.js            router — auth, admin, god mode
  lib/
    billing.js        pure arithmetic; the paise invariant lives here
    crypto.js         PBKDF2 via Web Crypto, one-time passwords
    error-codes.js    the registry — docs are generated from it
    errors.js         reportError, AppError, alert rate limiting
    http.js           json/problem responses, audit, rate limit, guard
    session.js        actor/subject sessions, roles, cookies
    admin.js          reading grid, parsing, generation; period arithmetic
    dashboard.js      the /api/me payload; one round trip, no client identity
    cron.js           late fees; idempotence is the property that matters
    notices.js        comments — opt-in per notice, real names, soft hide
    proof.js          upload validation, claim assessment, queue shaping
    public.js         the unauthenticated surface; leaks nothing private
    backup.js         CSV export, Drive upload, retention windows
    clicks.js         opt-in click capture; drops credential fields entirely
    tenancy.js        flat transfers, role guards, the merged timeline
    qr.js             QR matrix; tests decode it with an independent decoder
    vision.js         optional OCR; never a gate on paying a bill
    upi.js            deep links; iOS needs per-app schemes, Android doesn't
migrations/           D1 schema
scripts/              doc generation
test/                237 tests
```

## Operating it

`wrangler.toml` sets `run_worker_first = true` so static pages get the same
security headers as the API. Without it the asset server answers directly and
the CSP covers JSON only — which is exactly the wrong way round.

The CSP is `script-src 'self'`, so **no inline `<script>` blocks**. Four pages
had them and were silently dead until they were extracted to files; keep new
pages the same way.

Retention: clicks 30 days, page views 180, errors 365. `audit_log` is never
pruned — it is what makes administration accountable.

## Notes for whoever picks this up

- **Measure PBKDF2 before launch.** `PBKDF2_ITERATIONS` is 100k; verify it fits the Workers
  free-tier CPU ceiling. If it doesn't, lower it — for ~50 residents behind a rate limiter
  that is an acceptable trade, and still far better than what the old site did.
- **Nothing migrates from the old site.** No hosting access exists. Everyone gets a fresh
  one-time password at cutover; readings restart from a physical meter walk.
- **Test UPI amount-prefill on real apps early.** The VPA is personal, not a merchant one,
  so behaviour differs across GPay, PhonePe and Paytm and NPCI keeps tightening it.
- **Malayalam labels need a native speaker** before launch.
- **Publish the Google OAuth consent screen to Production** before relying on the
  nightly backup. A refresh token issued in "Testing" mode expires after 7 days and
  the backup then fails silently — `GET /api/admin/backup-health` and the Export tab
  both surface it, and `DDP-SYS-008` alerts on it.
