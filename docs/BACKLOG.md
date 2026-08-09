# Backlog

Deferred deliberately. Everything here was raised, considered, and parked — not
forgotten. Items move out of this file when they are picked up, not when they
are mentioned again.

Committed work-in-progress lives in git history; this is only what is *not*
being worked on.

---

## B1 — Language toggle (English ⇄ Malayalam)

**Deferred 2026-08-08.** Replace the current side-by-side bilingual labels with
a single-language toggle: pick a language, the whole page renders in it.

The side-by-side pairing is cluttered and nobody reads both columns. The toggle
is the right end state. It is parked because the switch itself is the small
part and the surrounding work is not.

What the survey found:

* 28 keys in `public/js/i18n.js`, used at only 10 call sites across 4 files.
* ~58 longer English literals sit inline in render code, plus all static HTML.
* So the dictionary covers **headings and nouns**. Every explanatory sentence
  ("Each bill keeps the rate it was issued at…") is English-only.

Why that matters: today a weak Malayalam translation is survivable because the
English is right beside it. Under a toggle, Malayalam is the only thing on
screen and there is no fallback. Flipping the switch with today's dictionary
gives Malayalam headings above English paragraphs.

**This makes the native-speaker review (B2) a blocker rather than a nicety.**

Scope questions to settle before starting:

1. Admin console and god mode — English only? Four people use them, and
   translating the treasurer's tooling roughly triples the string count.
2. Notices are typed by an admin in one language and cannot be translated at
   runtime. Leave as typed, or have the admin post both?
3. Server error messages are English from the Worker. The error-code registry
   is a clean seam: send the code, let the client localise it.
4. Month names need translating for dates ("July 2026" → "ജൂലൈ 2026").

Known risk, worth testing first rather than last: Malayalam runs long.
"Upload screenshot" → "സ്ക്രീൻഷോട്ട് അപ്‌ലോഡ് ചെയ്യുക" is roughly 3× the width.
The bottom nav holds five items and buttons are sized for English. If the nav
cannot hold the real strings, that changes the *labels*, not the CSS.

Shape when built: replace `bilingual()` with a single `t(key)`; sweep every
literal into the dictionary; toggle in the header persisted to `localStorage`
so it works logged-out; set `document.documentElement.lang` so the Manjari font
and screen readers both follow. Missing Malayalam falls back to English
silently — never a raw key on screen. Test that every key the code uses exists,
plus a coverage count so completeness is visible instead of assumed.

## B2 — Malayalam review by a native speaker

`public/js/i18n.js` carries a warning that its 28 strings are unreviewed. They
are common terms and probably fine, but "probably fine" is not good enough for
labels 52 families read monthly.

Best use of a resident who reads Malayalam: generate the complete English
string list as a two-column file and have them fill the second column. That is
better than asking them to audit guesses.

Blocks B1.

## B3 — Buy a domain

Currently `diamondpark.pages.dev`. A real domain costs money, which is the one
constraint the whole project was built against, so it needs an explicit
decision rather than a default. Cloudflare Pages supports a custom domain at no
extra hosting cost once the domain itself is paid for.

## B4 — Demo dry-run before cutover

Walk the committee through the site on real-looking data before any resident
sees it. There is no migration path from the old portal — nobody has access to
its hosting — so the cutover is a clean start from a physical meter walk. That
makes the dry-run the only rehearsal available.

## B5 — Password reset without the treasurer

Superseded in part by the email-OTP work now in progress. What remains here is
the fallback for residents with no email at all: today they contact Mukesh, and
the point of the OTP work was to remove that dependency. Decide whether a
no-email resident is a real case in this building before building for it.

## B7 — An AI triage step inside the portal

**Deferred 2026-08-09,** with a recommendation against most of it.

The idea: give a free AI API the PRD and the READMEs, let it review, debug and
fix, and write a comment explaining what happened that gets forwarded on.

The diagnostics work (`npm run doctor`, the Health tab) came out of this and
covers the useful part. What is left is the AI itself, and it is worth being
precise about what each piece would add.

**Reviewing and explaining** — small gain, real cost. The destination for the
explanation is an assistant that will read the raw report anyway. Inserting a
second model to summarise first adds a lossy compression step, a secret to
rotate, a dependency that can rate-limit, and the possibility of debugging from
a confident summary that is wrong. `--md` output is already the artefact.

**Fixing** — recommend against outright. An LLM with credentials to modify
bills, roles or payment status in a live financial system, with no human
between the decision and the write, is a bad trade at any accuracy. God edit
exists so a person makes that call and signs it.

**Where it would genuinely help,** if this is revisited:

* Plain-language explanations of error codes for residents, in English and
  Malayalam — bounded, low-stakes, wrong answers are embarrassing not costly.
* Overnight triage: cluster the night's `error_log` rows and say which of the
  57 codes is new versus routine. Read-only, and it saves reading a list.

Both are additive to the report, not a replacement for it. If it is built, it
reads and writes nothing but its own commentary — no credentials to any table.

## B6 — Telegram: create the bot and set the secrets

**Everything in code is done** (2026-08-09): instant alerts for `fatal` and
`error`, the daily digest for `warn`, a failed send recorded as DDP-SYS-004
instead of swallowed, and a staleness check so a digest that quietly stops gets
noticed. What is left needs a human with a Telegram account.

1. Message `@BotFather`, `/newbot`, keep the token.
2. Message the new bot once — a bot cannot open a conversation, so without this
   it can never reach you. Use a group instead if the committee should see
   alerts; add the bot to it and message there.
3. `npm run telegram:test` — validates the token, finds the chat id for you,
   and sends one message. Nothing is stored.
4. Set both secrets on **both** deployments. They are separate Workers over one
   database, so secrets on one do not reach the other:

   ```
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   cd pages && npx wrangler secret put TELEGRAM_BOT_TOKEN
   cd pages && npx wrangler secret put TELEGRAM_CHAT_ID
   ```

5. `npm run doctor` — CONFIG-NO-ALERTS should be gone.

The digest rides the existing nightly cron (`0 3 * * *` UTC, 08:30 IST), so
there is no second trigger to configure.
