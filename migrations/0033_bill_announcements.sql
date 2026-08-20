-- Telling the building its bills exist, one row per bill.
--
-- WHY A TABLE AND NOT A COLUMN ON `bills`. The row is the idempotency record.
-- One per bill, PRIMARY KEY (bill_id), so a drain that runs twice — a retried
-- request, the 3am cron landing on a month the treasurer is already draining —
-- cannot send the same person the same bill again. That is the failure worth
-- spending a table on, because the second email arrives at a neighbour rather
-- than in a log file.
--
-- WHY AN OUTBOX AT ALL. 89 emails will not fit in one request. sendEmail
-- refreshes an OAuth token per send and nothing caches it, so a month is ~178
-- outbound fetches against a 50-subrequest cap on the free plan
-- (docs/COSTS.md). Publishing queues; the console drains ~20 at a time behind
-- a progress bar; the cron sweeps whatever is left when the treasurer closes
-- the laptop.
--
-- `unreachable` is queued, never attempted. A resident with no email on file is
-- not a failure to retry — they are the WhatsApp list, and a row that keeps
-- being tried is a row that keeps costing a subrequest to discover the same
-- absent address. owners.email is nullable and today 103 of 105 accounts have
-- none, so this is the ordinary case rather than the edge one.
CREATE TABLE bill_announcements (
  bill_id    INTEGER PRIMARY KEY REFERENCES bills(id),
  period     TEXT NOT NULL,
  status     TEXT NOT NULL,     -- queued | sent | unreachable | failed
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  queued_at  TEXT NOT NULL,
  sent_at    TEXT,
  CHECK (status IN ('queued','sent','unreachable','failed'))
);

-- The drain's only query: "what is still to send for this month". Both columns
-- because a month with 89 sent rows would otherwise be scanned in full every
-- time the cron asks whether there is anything left.
CREATE INDEX ix_announce_period ON bill_announcements(period, status);
