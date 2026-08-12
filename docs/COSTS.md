# What this costs

**Deploying is free. There is no per-deploy charge on any of the four services.**
Only usage can cost anything, and the building is roughly three orders of
magnitude below every limit.

Measured on the live account, 2026-08-08 — and note that this traffic was
testing, not 99 flats of residents:

| | Using | Free allowance | |
|---|---|---|---|
| D1 database size | 238 kB | 5 GB | 0.005% |
| D1 rows read / 24h | 2,045 | 5,000,000 / day | 0.04% |
| D1 rows written / 24h | 426 | 100,000 / day | 0.4% |
| R2 stored | ~0 | 10 GB | — |

Re-measure any time:

```
npx wrangler d1 info dddp
```

## Why deploys themselves are free

`npm run deploy:pages` is a **direct upload** from the machine running it, not a
Cloudflare-run build, so it does not consume the 500-builds/month quota — that
quota applies to git-connected projects. Static assets and bandwidth on Pages
are unmetered. Deploying fifty times in a day costs the same as not deploying.

## Where money could actually appear

Workers, Pages and D1 on the free plan **fail closed**: past the daily limit
requests start failing rather than quietly billing. For this building that is
the right failure mode, and it is not a limit 99 flats can reach — one
resident checking a bill is a handful of requests, against 100,000 a day.

**R2 is the exception, and it is why the account needed a card.** R2 meters
storage and operations with no free-plan cutoff, so it bills past the
allowance. In practice: ~99 payment screenshots a month, compressed in the
browser before upload to well under 500 KB each — call it 25 MB/month against
10 GB. With nothing ever deleted that is roughly 3% after a year. Egress is
free on R2, which is the charge that usually catches people on other providers.

Screenshot retention already prunes old objects (see `pruneOldRows` and
`docs/PRIVACY.md`), so storage does not grow without bound.

## The limit that is not about money

**50 subrequests per Worker invocation**, on the free plan. It is in this file
because it is a free-tier ceiling and because B20 was found by checking batch
sizes against this page — which did not mention it, so the ceiling had to be
rediscovered from Cloudflare's documentation.

It binds nothing today and it is not a bill. What it does is cap the nightly
Drive backup at fifty **Google API** calls a night: R2 and D1 do not compete for
those, being counted against a separate internal allowance of 1,000 that this
job comes nowhere near. Workers Paid raises it to 10,000, which is the ~$5/month
subscription described below and a legitimate alternative to rationing.

The reason it matters is the failure mode rather than the number. The backup's
sweeps run in a fixed order and catch per item, so exhausting the budget shows
up as a swallowed count and an unmarked row — the later sweeps starve every
night while the watermark advances and the health check reports a good backup.
See **B20** for the split that fixes it. The month it bites is the month
residents actually start uploading, which is the month the portal goes live.

## The one thing worth doing

A card on file with no alert is the only shape in which a surprise is possible.
Set a **billing notification** in the Cloudflare dashboard under
Manage Account → Notifications.

Worth confirming the plan there too. Workers Paid is a flat subscription
(~$5/month) rather than usage creep — cheap, but you would want it to be a
decision rather than something that happened.

## What is NOT free

Nothing in the running system. The only paid item on the horizon is a domain
name, which is why it is a backlog decision (B3) rather than a default —
`diamondpark.pages.dev` costs nothing. A custom domain on Cloudflare Pages adds
no hosting cost once the domain itself is paid for.
