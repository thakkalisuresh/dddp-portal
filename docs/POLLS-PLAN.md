# Polls — the plan

Decided 2026-09-09 in one sitting, question by question. This is the record of
what was chosen and why, written before the code so the reasoning survives the
implementation. Prototype: `docs/documents-polls-prototype.html` (Polls tab).

The companion feature, the document library, is parked as **B30**.

---

## What a poll is here

A question the committee puts to the building, answered once per flat by the
flat's owner, whose result nobody sees until the committee decides to publish
it. It is **advisory** — there is no quorum and no constitutional weight. A
decision that needs either belongs at an AGM with the AGM's own rules, and the
portal should not be mistaken for one.

## The decisions, and what each rules out

### Its own tables, not a third notice kind

`notices.kind` has `CHECK (kind IN ('notice','event'))`, so a `'poll'` kind
means rebuilding the most-read table in the schema — and every poll would carry
`body` and `event_date` columns that do not apply to it. Three small tables cost
less than that and keep `notices` about text.

The price, paid deliberately: scope, the unread badge and the announcement path
are re-implemented for a second object rather than inherited. That is the trade.

### Polls live under Notices

Not a nav slot of their own. `nav.js` caps the bar at five and a superadmin
already has five. A poll is the committee addressing the building, which is what
the notice board is; putting it there also means one place to look rather than
four.

### Seeing and voting come apart

This is the one place polls **cannot** reuse the notice rule. A notice asks one
question — may you see it — and `scope` answers it. A poll asks two:

* **Voting is the owner's, always.** Tenants never vote, on any poll.
* **Whether a tenant may WATCH is a per-poll switch** the committee sets.

Folding those into one flag would make "let the tenants read it" also mean "let
the tenants vote", which is the thing being avoided. So a poll carries
`show_tenants`, and `canSeePoll` / `canVote` are two functions, not one.

### One vote per flat

The flat holds the vote; the owner casts it. Two owners of one flat share a
single vote and the last one to cast it holds the flat's answer. The ballot
records **which** of them acted, because that is the question a disputed count
actually asks.

A flat sold mid-poll: **the vote stands and reads as the new owner's.** The
vote belongs to the flat. The ballot still names whoever actually cast it —
the resident-facing view speaks of the flat, the ballot speaks of the person,
and both are true.

### Selecting is not voting

Tap an option, then Submit. A mis-tap on a phone must not be a cast vote. The
vote can be changed until the poll closes.

### Nothing is visible while a poll is open

Not the split, not the turnout — to residents **and to admins**.

**The superadmin sees the live count, and this is never mentioned anywhere.**
No label, no "superadmin only" note, nothing in the admin view saying a count
exists elsewhere. The resident copy therefore says *results are not shown while
voting is open* rather than *nobody can see the results*: the first is true
about what the screen does, the second was about to become a lie printed on 89
people's screens to protect a secret.

The superadmin votes like anybody else and nothing is said about that either.
The advantage is real and small; naming it would give away the live view.

### Closing is a date and time, and can be brought forward

Set at creation. The poll's creator or any admin may close it early.

**Closing is evaluated on read, not by the cron.** The nightly jobs run three
times a day, which cannot express "closes at 6pm". A poll whose `closes_at` has
passed is treated as closed by every read path the moment anyone looks; the
cron is a backstop that finalises the row and queues the result email. Anything
else means a poll visibly open past its own deadline.

**No minimum duration** — the creator decides. The creation form warns when a
poll is short enough that the emails will not finish sending before it closes
(see the drain arithmetic below), because that is a fact the creator should
meet before posting rather than after.

### Publishing is a separate act from closing

Closing reveals the count to the committee. Publishing reveals it to residents.
Two acts, because the committee should be able to see a result before deciding
whether announcing it helps.

A published result is **the count and nothing else** — no names, not even to
admins. A closed poll shows every resident the question, the options and their
own flat's answer whether or not the count was published: whether the committee
published the total is a different question from whether you can see what you
yourself chose.

**A poll cannot be reopened.** Reopening a vote after the committee has seen the
count is the single action that would make the whole feature untrustworthy.

### A tie is reported, not resolved

Advisory polls have no tie-break. The result shows the tie and the committee
decides. The portal does not invent a casting vote it has no authority to give.

### Editing after the first vote

Title and description stay editable; **options freeze.** Changing
"Deccan ₹3,80,000" after 34 flats chose it silently rewrites what they agreed
to, and a recorded edit explains that afterwards rather than preventing it.

### Question types

Single choice, or multi-select with a creator-set maximum ("pick up to 3"). An
unbounded multi-select lets a flat tick everything, which is an abstention that
looks like participation.

**Multi-select plus a yes/no pair is refused with an error.** Two options whose
text matches a yes/no pair — yes/no, y/n, agree/disagree, for/against,
approve/reject, case-insensitively — cannot be a multi-select, because picking
both is incoherent. The creator is told and asked to change it.

---

## Email

Three moments, all HTML, all to **owners only** — an email is a call to act, and
a tenant who may watch but not vote should not be asked to do anything.

| When | What |
|---|---|
| Poll opens | The question, the options, and a link |
| Midpoint | Only to flats that have not voted |
| Result published | The count |

**None of this is new machinery.** `email-template.js` already renders HTML
letters from blocks (`para`, `figure`, `action`, `aside`); `announce.js` already
has the shape the sending needs — an outbox row per recipient, drained
resumably and idempotently.

### The arithmetic that constrains it

From `announce.js`: `sendEmail` refreshes an OAuth token per call, so a naive
loop is two subrequests per message against the free plan's **50 per
invocation**. `mailToken()` is minted once per drain and threaded through, and
`DRAIN_SIZE` is 20 — twenty sends plus one refresh is 21.

Three crons a day × 20 = **60 sends/day**, so reaching ~89 owners takes about
two days unless an admin drains manually from the console.

### The reminder fires at the midpoint

`reminder_at = created_at + (closes_at - created_at) / 2`. A 48-hour poll
reminds at 24 hours; a two-week poll reminds after a week. Self-scaling, and it
never needs a second column of policy.

**One reminder, never more.** `reminders.js` records the committee's own rule
that three chases for an unpaid bill is the limit and a fourth is harassment. A
poll is smaller than a bill.

**The reminder must never report how many it went to.** The system knows who has
not voted; the admin who triggers or schedules it must not learn the turnout
from the result of sending it. "Reminders queued: 38" hands over the exact
number the whole design hides.

---

## Schema

```sql
CREATE TABLE polls (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  multi         INTEGER NOT NULL DEFAULT 0,   -- 0 single, 1 multi-select
  max_choices   INTEGER,                      -- multi only
  show_tenants  INTEGER NOT NULL DEFAULT 0,
  opens_at      TEXT NOT NULL,
  closes_at     TEXT NOT NULL,
  closed_at     TEXT,                         -- set when closed, early or not
  published_at  TEXT,                         -- the count is visible to residents
  reminder_at   TEXT,                         -- midpoint; NULL once queued
  reminded_at   TEXT,
  created_by    INTEGER NOT NULL REFERENCES owners(id),
  created_at    TEXT NOT NULL
);

-- 0036 also gave this a `sub` column for a per-option note. 0037 drops it
-- again: given a field for it, the answer was that an option is an option and
-- the description already carries the context.
CREATE TABLE poll_options (
  id       INTEGER PRIMARY KEY,
  poll_id  INTEGER NOT NULL REFERENCES polls(id),
  label    TEXT NOT NULL,
  sort     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE poll_votes (
  id         INTEGER PRIMARY KEY,
  poll_id    INTEGER NOT NULL REFERENCES polls(id),
  flat       TEXT NOT NULL,                   -- the vote belongs to the FLAT
  option_id  INTEGER NOT NULL REFERENCES poll_options(id),
  cast_by    INTEGER NOT NULL REFERENCES owners(id),  -- who actually acted
  cast_at    TEXT NOT NULL,
  UNIQUE (poll_id, flat, option_id)
);
```

`flat` rather than `owner_id` as the subject is the whole of "one vote per
flat", enforced by the database instead of by the handler. Changing a vote is a
delete-then-insert inside one batch, so a flat never briefly holds two answers.

## Backup, and the ballot

The coverage test in `test/backup.test.js` reads `migrations/` and insists every
table is named in `TABLES` or `NEVER_BACKUP`. Three tables, and they are not
alike:

* **`polls` and `poll_options` → `TABLES`.** Structural, and the counts on the
  poll row are what a published result is.
* **`poll_votes` → `TABLES`, but dumped only for polls that have closed.**

That last one is the decision of 2026-09-09, and it needs `dumpTable` to grow a
per-table query override — today it is `SELECT * FROM ${table}` with no
filtering. While a poll is open its ballot never leaves D1, so nobody can read
the running count out of a CSV. Once closed, it rides the next nightly bundle
like everything else.

**This is only safe because the bundle goes to the restricted folder.**
`committeeFolder()` in `backup.js` documents the split: the nightly CSV — the
whole roster, every mobile and email — goes to `GOOGLE_BACKUP_FOLDER_ID`, a
personal Drive whose reader list is short. Proofs and notice attachments go to
`GOOGLE_COMMITTEE_FOLDER_ID`, which is *shared with the committee*.

**If `GOOGLE_COMMITTEE_FOLDER_ID` is unset the two are the same folder**, and
the ballot lands where every committee member can read it — which undoes the
secrecy the rest of this design is built on. `committeeFolderSeparate()` exists
to detect exactly this and `npm run doctor` reports it. **Confirm it before
this ships.**

### Retention

Ballots are pruned **6 months after the poll closes**. The counts live on
forever; who voted what does not. This matches `activity` and `click_log`, which
`PRIVACY.md` calls a promise rather than housekeeping. Backups taken before the
prune still contain the ballot, which is what a backup is.

---

## Permissions

| | Create | Manage (close, publish, edit) | See live count | See the ballot |
|---|---|---|---|---|
| Resident (owner) | — | — | — | — |
| Resident (tenant) | — | — | — | — |
| Committee | yes | own polls only | no | no |
| Admin | yes | all polls | no | no |
| Superadmin | yes | all polls | **yes** | **yes, recorded** |

Committee members manage only what they created, mirroring `canManageNotice`
and the asymmetry 0030 established. The named exception goes in
`committeeMayUse` in `session.js` — the list of what a committee member may
reach, rather than loosening the admin gate for everyone.

Opening the ballot is written to the activity log, like every other god-mode
power. Invariant 7: unlimited power is only safe to hand someone if the record
of using it is automatic.

---

## Build order

1. Migration — three tables, named in the backup lists in the same commit
2. `lib/polls.js` — validation, visibility, counting, the yes/no guard, the
   midpoint calculation. Pure functions, tested against a clock
3. Routes — create, vote, close, publish, ballot
4. Resident UI under `/notices`
5. Creation and management UI in the admin console
6. The three emails and the outbox drain
7. `dumpTable`'s query override, and the prune
