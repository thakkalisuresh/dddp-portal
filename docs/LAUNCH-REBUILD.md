# Launch rebuild — replacing production with an empty database

Everything in production today is demo data: 115 accounts of which 109 carry a
`[demo]` tag, 956 bills across 11 months, 13 rate rows (two of them junk,
including one at ₹900/kg), two test notices and three test payment proofs.
None of it is real, none of it should meet the real roster, and the building
has never billed a genuine month.

So production is not pruned, it is **replaced**: a new D1 database, born from
`migrations/`, holding 99 flats and the published committee — and **no accounts
at all**, including the superadmin's. Month one then starts where it was always
going to start, at the cutover meter walk.

Every account going, with no exceptions, is what makes this a rebuild rather
than a prune with a special case in it. No row is carried across by hand and no
password hash is smuggled out of the old database. The state in between is the
honest one: a building with flats and nobody enrolled.

The superadmin goes back afterwards, as a separate step, **with no working
password** — `reset-my-password.mjs` then sets one with echo off, hashing
locally and sending only the hash, so it never passes through a terminal, a
shell history or an assistant's context.

There is no way around that being a direct database write. Every route that
creates a resident lives under `/api/admin/` and needs a session, and a session
needs an account, so account number one cannot come from the portal — exactly
as the roster import will be a direct write by whoever holds the credentials.

`scripts/launch-rebuild.mjs` does the fiddly parts. It deliberately does **not**
delete or create a database; those two commands are the irreversible edge and
belong in a human's shell history with wrangler's own prompt in front of them.

## Before you start

- **Nobody should be looking at the site.** There is a window between the
  delete and the deploy where every database query 500s. That is free while the
  portal is unpublished and expensive the day it is not.
- **The branch must reach `main` before the deploy step.** `wrangler pages
  deploy` reads the git branch to pick the environment: run it from anywhere
  else and it creates a *Preview*, prints "Deployment complete", and leaves
  production on the old bundle. The config swap in step 7 has to be merged.
- **Joy, Mukesh and Hari lose their logins.** Their published committee entries
  survive — those come from migration `0003`/`0007` and are not accounts — but
  the accounts themselves go, and come back through the roster import.

Record the before-picture so the after-picture means something:

```bash
npm run doctor
```

On 2026-09-12 that read: 1 fail (`FLAT-BILLED-NO-OWNER`, 5 flats), 2 warnings
(`MAIL-NOT-CONFIGURED`, `DEMO-DATA-PRESENT` at 109 residents), 1 note. The
first and third are demo debris the rebuild resolves.

## 1. Capture

```bash
node scripts/launch-rebuild.mjs capture --confirm
```

Exports the whole database to `.launch/pre-launch-<date>.sql` and checks the
file before calling it a backup — size, `CREATE TABLE`, and real `INSERT INTO
owners` rows. An export that failed halfway still leaves a file, and a file is
exactly what makes people feel safe enough to run step 3.

It also lifts the 4A row out whole, into `.launch/keep-owner.sql`. Step 5b reads
the **identity** back out of it — name, mobile, email — so none of it is
retyped, and deliberately leaves the password hash behind.

That file is `0600` and gitignored because it does still contain the old
`pw_hash` and `pw_salt`. Nothing replays them, but they are in the file, so
delete `.launch/` once step 9 passes. Keeping it until then is the insurance: if
the rebuild has to be abandoned, that row plus the archive puts the old account
back exactly as it was.

Finally it records the R2 keys, because once the database is gone nothing knows
which objects belonged to it.

## 2. Put the archive somewhere that is not your laptop

```bash
npx wrangler r2 object put dddp-archive/pre-launch/<date>.sql \
  --file .launch/pre-launch-<date>.sql --content-type application/sql
```

`dddp-archive` is the association's own bucket, in APAC, created for this.
The `pre-launch/` prefix keeps it clear of the `snapshots/` tree the monthly
archive writes into.

## 3. Delete and recreate — the irreversible step

Do not run this until step 2 is done and you have seen the object listed.

```bash
npx wrangler d1 delete dddp
npx wrangler d1 create dddp --location apac
```

**`--location apac` is not optional.** The old database was pinned near Kerala
deliberately; omit the flag and the new one lands wherever, the way
`dddp-proofs` ended up in WNAM.

Keep the new `database_id` from the output — steps 7 needs it.

## 4. Migrate

```bash
npx wrangler d1 migrations apply dddp --remote
```

All 39 apply cleanly to an empty database; the resulting schema was diffed
against production and is identical bar retained SQL comments and one quoted
table name.

If this returns **7403**, that is the known account flakiness — which of `list`
and `apply` fails moves between deploys, sometimes within a day, while
`d1 execute --remote` has worked every time. Use the fallback, which applies
each file and records the ledger row separately, and skips anything already
applied:

```bash
node scripts/launch-rebuild.mjs migrate --confirm
```

## 5. Seed the building

```bash
node scripts/launch-rebuild.mjs seed --confirm
```

99 flats from `building.js`, and nothing else. Refuses to run unless the
database is empty, which is what stops it being pointed at the wrong one.

The committee and `click_capture=off` are **not** seeded here: a fresh database
is born with them, from migrations `0003`, `0007` and `0004`.

At this point the portal has a building and no people. `doctor` will report
`SUPERADMIN-NONE`, and that is true rather than broken.

## 5b. Let yourself back in

```bash
node scripts/launch-rebuild.mjs account --confirm
node scripts/reset-my-password.mjs
```

The first command recreates the 4A superadmin, reusing the name, mobile and
email from the row `capture` lifted out — so nothing is retyped — while
**discarding the old password hash**. The account exists and cannot be logged
into: `pw_hash` is set to a value that is not valid base64.

The second sets your password. It asks with echo off, hashes on your machine
and sends only the hash, so the password is never an argument, never in shell
history and never in anybody's context.

Flats must exist first — `owners.flat` references `flats(flat)` and D1 will not
defer the check. The step refuses if any account already exists, so it cannot
quietly create a second superadmin.

Note it sets `must_change_pw = 0`, because you are choosing the password
yourself. To exercise the real first-time-resident flow — temporary password,
forced change, onboarding — create a throwaway resident from the admin console
once you are in. That tests what 99 people will actually meet, which is the
version worth testing.

## 6. The R2 buckets

```bash
npx wrangler r2 object delete dddp-proofs/<key>   # the keys are in .launch/manifest.json
npx wrangler r2 bucket delete dddp-proofs
npx wrangler r2 bucket create dddp-proofs --location apac
```

Four junk objects, 118 kB, all of them test proofs. Recreating under the same
name means no config edit, and APAC stops every resident's upload crossing the
Pacific — a fix that is only cheap while the bucket is empty.

## 7. Swap the binding

Four references, and all four must move:

| File | What |
|---|---|
| `wrangler.toml` | `database_id` |
| `pages/wrangler.toml` | `database_id` |
| `test/deploy-config.test.js` | `PROD_DB` constant, **twice** (two `describe` blocks) |

The test constant is the quiet one: it asserts previews are not bound to
production, so a stale value keeps passing while guarding nothing. Previews
served production data once already.

```bash
npm test        # 1461 tests
```

If the archive code is deploying for the first time here, delete any snapshot
the cron wrote from the *old* database first — the monthly archive is
append-only by design, so a demo-data September would never be replaced:

```bash
npx wrangler r2 object delete dddp-archive/snapshots/2026/2026-09.csv
```

## 8. Deploy both, from `main`

```bash
npm run deploy:pages        # or: cd pages && npx wrangler pages deploy --branch main
npm run deploy:cron
```

Both, always: secrets and bindings set on one do not reach the other. Then
confirm the deploy actually landed on production rather than a preview:

```bash
npx wrangler pages deployment list --project-name diamondpark
```

You want a row reading `Production | main | <sha>`. A `-dirty` suffix in the
release stamp means `git status --porcelain` was non-empty at build time —
usually a `node_modules` symlink inside the worktree, which belongs in the
parent directory instead.

## 9. Verify

```bash
node scripts/launch-rebuild.mjs verify
npm run doctor
```

`verify` asserts rather than prints: 99 flats, **at most** one account and — if
one exists — that it is the active 4A superadmin, no periods, bills, readings,
notices, audit rows or sessions, committee published, click capture off, and
all 39 migrations in the ledger. It exits non-zero if any of that is wrong, and
distinguishes "no accounts yet" (correct before step 5b) from "the wrong
account" (never correct).

`doctor` should now be quiet where it was noisy: `DEMO-DATA-PRESENT` gone,
`FLAT-BILLED-NO-OWNER` gone, `SUPERADMIN-NONE` **must not** appear.
`BACKUP-NEVER` and `DIGEST-NEVER` will show as info until the crons run once —
that is honest, not a regression.

Last: log in as 4A with the password you set in step 5b. That is the check that
the account and your new credential agree.

Then delete `.launch/`.

## What this does not fix

The three things blocking launch are unchanged, and all three are yours rather
than the code's: the roster (~99 flats of names, mobiles and emails), the meter
walk, and an association Gmail account — without which no resident can reset
their own password, which `doctor` reports as `MAIL-NOT-CONFIGURED`.

Order still matters, and `docs/BACKLOG.md` C3 is the reason: import the roster,
walk the meters, generate the month, **then** send the logins. A resident who
logs in to an empty dashboard concludes the site is useless and does not come
back.
