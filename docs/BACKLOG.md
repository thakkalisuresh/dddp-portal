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

## B5 — Residents with no email at all

Self-service reset is built (`/forgot`), so anyone with an email on file can
recover without an admin. What is left is the people who have none.

`npm run doctor` reports this as NO-EMAIL-ON-FILE with the flats named, so the
size of the problem is measurable rather than guessed. Onboarding asks for an
address and explains why, so coverage should grow on its own as residents log
in for the first time.

Do not build anything here until the roster is imported and the number is
known. If it turns out to be two households, an admin reset is the right
answer and always was.

## B8 — Tenancy — DONE 2026-08-09

Built as `relationship` on `owners`, values `owner` and `tenant`, set by an
admin. Researched against real products first: ApnaComplex uses two fields
(relationship type plus resident status) and MyGate has the OWNER add their own
tenant. We took neither — one column, admin-set — and the reasoning is in the
migration.

The wording follows ApnaComplex rather than inventing our own, since the
committee will have met "owner/tenant" elsewhere.

One decision worth remembering: most society systems bill the OWNER, because
they are maintenance systems and maintenance is a charge against the property.
Gas is metered consumption, so it follows whoever burned it. That is why we
differ from them.

## B10 — Expire admin-issued temporary passwords

Found during the content review, 2026-08-09. The reset message told residents
"it expires in 24 hours" and the API returned `expiresInHours: 24`. Nothing
enforced either. A temporary password sent over WhatsApp worked indefinitely.

That matters more than it sounds: WhatsApp messages persist on both phones for
years, get forwarded, and survive a handset changing hands. A credential with
no lifetime sitting in a chat history is a real exposure, and it is the ONE
credential in the system deliberately transmitted in the clear.

The copy now promises nothing, which is honest but not a fix.

Shape: `pw_expires_at` on `owners`, set when an admin issues a temporary
password, checked at login only while `must_change_pw = 1` so it never affects
a password the resident chose themselves. An expired one should say so plainly
and point at /forgot rather than failing as "wrong password".

Small — perhaps thirty lines and a test. It was left out of the content review
because that review was meant to correct what is written, not change what the
system does the day before a deploy.

## B9 — Owner-only notices

Borrowed from ApnaComplex, which has an "Only Owners" notice scope alongside
the ordinary one. Some things a committee posts are genuinely owner business —
AGM papers, sinking-fund decisions, anything with a vote attached — and a
tenant seeing them is noise at best and confusing at worst.

Cheap once `relationship` exists: a scope column on `notices`, and the list
query filters on the viewer's relationship. The reason it is worth recording
now rather than discovering later is that it is the second consumer of
`relationship` — which is why that column belongs somewhere the notices code
can reach, not buried in billing.

Also worth deciding at the same time: whether an owner-only notice is visible
to an absent owner (it should be — they are the audience) and whether comments
on one are similarly scoped (they must be, or the scope leaks through replies).

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

## B6 — Telegram alerting — DONE 2026-08-09

Closed. Bot created, secrets set on both deployments, and delivery proven end
to end: a deliberate DDP-AUTH-004 (invalid session cookie against the live
site) produced a real alert, and no DDP-SYS-004 followed it — which is how
delivery success is confirmed without seeing the recipient's phone.

Worth keeping for whoever inherits this:

* Two deployments over one database. Secrets on one do not reach the other,
  and `dddp-portal` alone was reported by the doctor as CONFIG-HALF-ALERTS.
* Pages secrets bind only to a NEW deployment. Saving them in the dashboard
  and stopping there leaves it looking configured and doing nothing.
* In the Workers dashboard, "Save version" stages; "Deploy" publishes. Only
  Deploy makes a secret live.
* `wrangler secret list` and `wrangler pages secret list` return names only,
  so the setup can be verified without anyone handling the token.
* A digest that stops is silent by design, so DIGEST-STALE watches the
  watermark. Nothing else would notice.

