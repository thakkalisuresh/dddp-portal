-- The maintenance mail outbox.
--
-- WHY A SECOND OUTBOX AND NOT `bill_announcements`. That table is keyed on
-- `bill_id` alone — one row per bill, which is exactly right for gas, where
-- the announcement is a single moment: the bill exists, here it is. Maintenance
-- writes to a resident FOUR times about the same bill, and a table with one row
-- per bill cannot say which of the four has already gone. Widening it would
-- mean rebuilding a live table to add a column to its primary key, for no gain
-- to gas.
--
-- So this is `poll_mail`'s shape rather than `bill_announcements`': PRIMARY KEY
-- (bill_id, kind), one row per bill per moment. That key IS the idempotency
-- record, and it is the only thing standing between a drain that runs twice —
-- a retried request, the nightly cron landing while an admin is draining — and
-- a resident being told twice that their bill is overdue. The failure worth
-- spending a table on is the one that arrives in a neighbour's inbox rather
-- than in a log file.
--
-- THE SUBREQUEST ARITHMETIC, which is why an outbox exists at all: one
-- `sendEmail` is two outbound fetches, because it refreshes an OAuth token per
-- call, and a Cloudflare request on the free plan gets 50 (docs/COSTS.md). A
-- quarter is up to 99 bills times four moments. Queue here; drain ~20 at a time
-- with a single token minted by `mailToken()`, which makes a batch of N cost
-- N+1 instead of 2N.
CREATE TABLE maint_mail (
  bill_id    INTEGER NOT NULL REFERENCES maint_bills(id),

  -- The four moments, in the order they happen: the bill was issued, the due
  -- date is three days off, the due date is today, the fee has been added.
  --
  -- THESE STRINGS ARE INTERNAL. Nothing resident-visible renders them, which is
  -- deliberate: the committee is still to approve the wording, and a label that
  -- has leaked into a subject line cannot be renamed without a migration.
  kind       TEXT NOT NULL,

  -- queued       waiting for a drain
  -- sent         Gmail accepted it
  -- unreachable  no address on file; queued, never attempted
  -- failed       a send that did not land, retried up to MAX_ATTEMPTS
  --
  -- `unreachable` is not a failure to retry. A resident with no email is the
  -- WhatsApp list, and a row that keeps being tried keeps costing a subrequest
  -- to rediscover the same absent address. `owners.email` is nullable and most
  -- accounts have none, so this is the ordinary case rather than the edge.
  status     TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  queued_at  TEXT NOT NULL,
  sent_at    TEXT,

  PRIMARY KEY (bill_id, kind),
  CHECK (kind IN ('issued','due_soon','due','overdue')),
  CHECK (status IN ('queued','sent','unreachable','failed'))
);

-- The drain's only question: what is still to send. Status first because that
-- is what narrows — a quarter with 99 sent rows would otherwise be scanned in
-- full every time the cron asks whether there is anything left to do.
CREATE INDEX ix_maint_mail_queued ON maint_mail(status, bill_id);

-- ── the confirm reminder ─────────────────────────────────────────────────
-- When the "this quarter needs confirming" email last went out to the admins.
--
-- THIS IS AN IDEMPOTENCY MARKER, not a log line. The reminder is sent by the
-- nightly job from the day the draft appears until somebody schedules the
-- quarter — which is a week — and without a marker that is seven consecutive
-- nights of the same email to every admin. The realistic outcome of that is not
-- a prompt committee; it is the portal's address filtered to a folder nobody
-- reads, which costs us every later email as well.
--
-- Stamped ONLY on a send that succeeded, so a night where Gmail was down
-- retries tomorrow instead of being silently spent.
ALTER TABLE maint_quarters ADD COLUMN reminded_at TEXT;

-- ── what the admin was looking at when they scheduled ────────────────────
-- Two scalars, deliberately NOT a snapshot of the flat list.
--
-- The rate a flat takes is decided on the ISSUE DATE and nowhere else — that
-- rule is stated in the rates, in the mid-quarter cases and in the tenancy
-- work, and storing a flat list at schedule time would quietly introduce a
-- second, earlier date that also decides it. That is how a bill becomes
-- unexplainable eighteen months later.
--
-- But an admin confirming a quarter should be confirming something. So these
-- record what they were shown — how many flats, and what the total came to —
-- and the issue-day summary compares them against what actually went out:
-- "39 flats and ₹3,03,000 expected, 40 and ₹3,12,000 issued". A tenancy that
-- changed in that week then appears as a line in the summary rather than as a
-- surprise in the next dues report. The bills are still computed fresh on the
-- issue date; these only make the difference visible.
ALTER TABLE maint_quarters ADD COLUMN scheduled_flats INTEGER;
ALTER TABLE maint_quarters ADD COLUMN scheduled_total REAL;
