-- Chasing an unpaid bill, with a hard ceiling on how often a resident hears it.
--
-- The committee's rule, decided 2026-08-19: three reminders per bill and no
-- more, spaced 24, then 48, then 72 hours. Remind-all is capped at two runs for
-- a month, a day apart. The two limits share ONE budget — a run of Remind-all
-- spends each flat's reminders exactly as an individual click does — because
-- separate budgets would let five emails about one bill reach a household that
-- the escalating spacing exists to protect.
--
-- WHY A TABLE AND NOT A COLUMN ON bills. Two of the three emails state their
-- own history ("the first was sent on 20 September"; "reminders were sent on
-- 20, 22 and 25 September"), so the dates are content, not bookkeeping. A
-- counter and a last-sent timestamp could enforce the cap but could not write
-- the letter. This also gives the committee an answer to "who chased 3B, and
-- when" that outlives the admin who did it — the same argument the flat
-- exclusions and late-fee exemptions make for a reason column.
--
-- The cap is enforced against these rows on the server. The console greys the
-- button using the same numbers, but that is a courtesy: an admin with two
-- browser tabs open must not be able to send a fourth.
-- One press of Remind-all. Rows here are the bulk cap: two per usage month.
--
-- Recorded even when it sent nothing, because "I pressed it and nothing
-- happened" needs an answer, and because a run that skipped every flat has
-- still used one of the two.
CREATE TABLE reminder_batches (
  id        INTEGER PRIMARY KEY,
  -- The usage month being chased, so the cap resets with the month rather than
  -- running down over a year.
  period    TEXT    NOT NULL REFERENCES periods(period),
  sent_at   TEXT    NOT NULL,
  sent_by   INTEGER NOT NULL REFERENCES owners(id),
  sent      INTEGER NOT NULL DEFAULT 0,   -- flats that received one
  skipped   INTEGER NOT NULL DEFAULT 0    -- spent, cooling, or with no address
);

CREATE INDEX ix_reminder_batches_period ON reminder_batches(period, sent_at);

CREATE TABLE bill_reminders (
  id        INTEGER PRIMARY KEY,
  bill_id   INTEGER NOT NULL REFERENCES bills(id),
  -- 1, 2 or 3. Stored rather than derived from COUNT so the email that was
  -- actually sent stays readable years later, and so a deletion — which should
  -- never happen — cannot silently renumber the ones that remain.
  ordinal   INTEGER NOT NULL,
  sent_at   TEXT    NOT NULL,
  sent_by   INTEGER NOT NULL REFERENCES owners(id),
  -- The address it went to, snapshotted. A resident whose email changes later
  -- leaves a record that still says where the reminder actually landed.
  sent_to   TEXT    NOT NULL,
  -- Which run wrote this row, if it was a bulk one. NULL for a single click.
  batch_id  INTEGER REFERENCES reminder_batches(id),
  CHECK (ordinal BETWEEN 1 AND 3),
  -- The ceiling, in the schema rather than only in the handler. Three rows can
  -- exist for a bill and a fourth cannot be written at all.
  UNIQUE (bill_id, ordinal)
);

CREATE INDEX ix_bill_reminders_bill ON bill_reminders(bill_id, sent_at);
