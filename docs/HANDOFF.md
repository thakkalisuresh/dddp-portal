# Handoff

## The short version

Two lines is enough:

```
Pick up the DD Diamond Park gas portal at /Users/sabarish/Downloads/Claude/dddp-portal
Read docs/HANDOFF.md first, then run npm run doctor before doing anything.
```

`npm run doctor` is what makes that sufficient. It reads production and reports
the current state — including whether demo data is still loaded — so nothing
here has to be remembered or kept in step by hand. A warning written into a
prompt goes stale the day it stops being true, and a stale warning teaches
people to ignore the next one.

Then add whatever you actually want done that day.

---

## The long version

Paste this instead when a session seems to be guessing, or when it started
somewhere unexpected. Everything after it is context for a human reading on.

## The prompt

```
You are picking up the DD Diamond Park gas billing portal.

  /Users/sabarish/Downloads/Claude/dddp-portal

It is live at https://diamondpark.pages.dev and runs at zero cost on
Cloudflare Pages + Workers + D1 + R2. 786 tests. The user is Sabarish, the
association's superadmin, and he is often on a phone with no terminal.

READ FIRST, in this order:
  docs/STATE.md     what is built, what is inert, what is untested
  docs/BACKLOG.md   what is deferred and WHY — read before proposing anything
  docs/PRD.md       goals, non-goals, and the seven invariants
  README.md         how to run it
  docs/FUNCTIONS.md generated index of every export

Then run `npm run doctor` before touching anything. It checks the building's
invariants against live production and is read-only.

THREE THINGS THAT WILL CATCH YOU OUT:

1. 99 flats and 880 bills of DEMO data are in production for user testing.
   Remove them before importing the real roster:
     node scripts/seed-demo.mjs --remote --remove
   The four real committee accounts (4A, 10A, 13A, 13E) are untouched by it.

2. There are TWO deployments over ONE database — `diamondpark` (the site) and
   `dddp-portal` (the nightly cron). Secrets set on one do NOT reach the other,
   and Pages secrets only bind to a NEW deployment. Deploy both:
     npm run deploy:pages && npm run deploy:cron

3. Nothing has ever billed a real month. Every billing behaviour is verified
   by tests and by self-generated demo data. The first real test is the
   cutover meter walk.

HOW THIS PROJECT WORKS:

Verify by looking, not by reading the code. Almost every bug found here was
invisible in the source and obvious in rendered output or an endpoint
response: a "daily digest" documented in three places and never built, mobiles
stored in two spellings that defeated the UNIQUE index, a health check that
reported "no superadmin" because one query blipped. Tests passed throughout.

Check that a check can fail. Several tests here asserted nothing — one compared
a function's output with itself and passed while the endpoint leaked resident
names. If you add a guard, break the code deliberately and watch it catch it.

Back up before any migration, and confirm the backup file exists before
running it:
  npx wrangler d1 export dddp --remote --output backup.sql

Never handle the user's passwords, tokens or API keys. He does those himself;
scripts/reset-my-password.mjs and scripts/telegram-test.mjs are built so the
secret never passes through the assistant.

WHAT IS ACTUALLY BLOCKING: the roster (~99 flats of names, mobiles and now
EMAIL), the meter walk, and a Gmail account. All three are the user's, not
code. The Gmail is no longer a small errand: B21 made email the way a resident
recovers their own account, and it is built, so nothing can be sent to
residents until the account exists.
```

---

## Why the prompt says what it says

**Read the backlog before proposing.** Most obvious ideas here have already been
considered and closed with reasons — a language toggle, an AI triage step, a
plain on/off late-fee exemption. Re-proposing them without the reasoning wastes
a turn and reads as not having looked.

**"Verify by looking" is not a style preference.** It is the single highest-value
habit for this codebase, and the evidence is in the git log. The failure mode is
always the same: the code looks right, the tests pass, and the thing is broken
in a way only visible in output.

**The user is often on a phone.** He cannot run commands. Anything requiring a
terminal has to either wait or be done for him — and things needing an OAuth
round-trip genuinely cannot be done from a phone, which is why the Gmail setup
is still open.

## Where things live

```
functions/
  index.js          one router: route table at the top, handlers below
  lib/              all the logic; pure where it can be
public/
  js/               plain ES modules, no build step, no framework
  admin/            admin console pages
migrations/         0001..0025, applied in order
scripts/            run by hand; several touch production
docs/               this, plus PRD, STATE, BACKLOG, COSTS, PRIVACY,
                    ERROR_CODES and FUNCTIONS (the last two generated)
test/               786 tests
```

## Commands worth knowing

```
npm test                    the suite
npm run doctor              invariants against production, read-only
npm run doctor -- --md      the same, as markdown to paste
npm run dev                 local server on :8787
npm run db:local            apply migrations locally
npm run db:remote           apply migrations to production
npm run deploy:pages        the site
npm run deploy:cron         the nightly worker
npm run errdoc              regenerate docs/ERROR_CODES.md
npm run fndoc               regenerate docs/FUNCTIONS.md
npm run telegram:test       check a bot token and chat id actually work
```

Both generated docs have drift tests, so editing them by hand fails the suite.

## The shape of the building

99 flats, and the irregularity matters because the roster import validates
against it:

- Floor 1 — D to H only; A, B and C are car parking
- Floors 2–9 — A to H
- Floors 10–15 — A, B, D, E, plus C duplexes at 10, 12 and 14
- Floor 16 — B, D and A; C and E are recreation rooms

A duplex spans two floors and is one home with one meter. `11C`, `13C` and
`15C` are not flats and must never be created. `functions/lib/building.js` is
the authority.

## If something looks wrong in production

1. `npm run doctor` — it names the problem and the flats involved
2. God mode → Health, for the same checks in the browser
3. God mode → Activity log, for who did what
4. `docs/ERROR_CODES.md` for what a `DDP-…` code means

Errors reach Telegram already: `fatal` and `error` immediately, `warn` in the
morning digest.
