-- Quarterly maintenance charges.
--
-- The second billing stream this portal runs, and almost nothing is shared with
-- the first. Gas is monthly, metered, paid into one bank account, and every
-- flat's total differs. Maintenance is quarterly, a flat rate, paid into a
-- DIFFERENT account, and every flat of the same kind owes the same rupee.
--
-- WHY NEW TABLES RATHER THAN A SECOND KIND ON `bills`. The cheap move was
-- `kind = 'maintenance'` on bills and periods, reusing the proof queue, the
-- late-fee cron and the dues report as they stand. It was rejected for the same
-- reason 0036 refused to make a poll a third kind of notice: `bills` carries
-- meter_delta, consumption, conversion_factor and rate_per_kg, all NOT NULL,
-- none of which describes a maintenance charge, and widening the CHECK on
-- `periods.status` means rebuilding the table every bill in the building joins
-- against. Separate tables cost less and keep `bills` about gas.
--
-- THE RECONCILIATION CONSEQUENCE, stated here because the schema is where
-- somebody will look for it: gas leans on totals being effectively unique per
-- flat — a ₹329 credit belongs to whoever was billed ₹329. Forty-one flats
-- owing ₹9,000 have no such fingerprint, so nothing here may assume an amount
-- identifies a payer. Matching is on the screenshot reference and the payment
-- narration, and anything unmatched is reported rather than guessed.

-- ── the quarter ──────────────────────────────────────────────────────────
-- One row per quarter, holding the numbers the committee set and the dates they
-- chose. The twin of `periods`, and like `periods` it stores the rate rather
-- than letting bills inherit one: a rate carried forward silently is the worst
-- failure this system can have, because ninety-nine bills go out looking
-- completely normal and every one of them is wrong.
CREATE TABLE maint_quarters (
  -- '2026-Q4'. Sorts chronologically as a string, which is the whole reason for
  -- the shape — the same bargain `periods.period` makes with '2026-06'. The
  -- resident-facing form, "Q4 2026 (Oct–Dec)", is BUILT from this and never
  -- stored, so a quarter cannot end up described two different ways on two
  -- different screens.
  quarter      TEXT PRIMARY KEY,

  -- Editable per quarter, because the committee revises them at an AGM and old
  -- quarters must keep the figures they were actually billed at. Defaults are
  -- the 2026 rates; every bill snapshots the one it used.
  owner_rate   REAL NOT NULL,
  tenant_rate  REAL NOT NULL,
  late_fee     REAL NOT NULL DEFAULT 750,

  -- The day the bills go out. THIS is the date that decides each flat's rate —
  -- not the quarter's first day and not "today" — because it is the moment the
  -- committee fixed when they scheduled. A flat let on 3 October is rented for
  -- all of Q4; a tenant who leaves on the 4th does not turn Q4 back into an
  -- owner quarter by arithmetic. That is a re-rate, and two admins decide it.
  issue_date   TEXT NOT NULL,
  due_date     TEXT NOT NULL,            -- issue_date + 10 days

  -- draft      created automatically about a week before the quarter
  -- scheduled  an admin confirmed; rates and the flat list are now frozen
  -- issued     the nightly job raised the bills and started the emails
  -- locked     closed for edits, as `periods.status` means it
  status       TEXT NOT NULL DEFAULT 'draft',

  -- Who confirmed, so the quarter-confirm reminder can go to every admin EXCEPT
  -- whoever scheduled the previous one.
  scheduled_by INTEGER REFERENCES owners(id),
  scheduled_at TEXT,
  issued_at    TEXT,
  created_at   TEXT NOT NULL,

  CHECK (quarter GLOB '[0-9][0-9][0-9][0-9]-Q[1-4]'),
  CHECK (status IN ('draft','scheduled','issued','locked')),
  CHECK (owner_rate > 0 AND tenant_rate > 0),
  -- Whole rupees throughout, for the reason `periods` and `bills` both state
  -- it: a fractional figure passes the application and then dies at the
  -- database as a 500 rather than as a message anybody can act on.
  CHECK (owner_rate  = CAST(owner_rate  AS INTEGER)),
  CHECK (tenant_rate = CAST(tenant_rate AS INTEGER)),
  CHECK (late_fee    = CAST(late_fee    AS INTEGER)),
  CHECK (due_date > issue_date)
);

-- ── the bills ────────────────────────────────────────────────────────────
CREATE TABLE maint_bills (
  id            INTEGER PRIMARY KEY,
  flat          TEXT NOT NULL REFERENCES flats(flat),
  quarter       TEXT NOT NULL REFERENCES maint_quarters(quarter),

  -- WHO CARRIES THE BILL — the tenant when there is one, the owner otherwise.
  -- Not nullable: a bill raised against nobody is a debt the association cannot
  -- collect and a line on the dues report that never clears, which is why a flat
  -- with no registered owner gets no bill at all rather than an unowned one.
  --
  -- This column is also what SCOPES VISIBILITY, exactly as `bills.owner_id`
  -- does. That is why a re-rate updates it in place rather than deriving the
  -- payer at read time: a bill still pointing at a departed tenant simply does
  -- not appear on the owner's screen, and they would be liable for something
  -- they cannot see.
  owner_id      INTEGER NOT NULL REFERENCES owners(id),

  -- Snapshots, deliberately not a join to maint_quarters. The rate is fixed on
  -- the issue date and a later revision must not reach backwards.
  rate_applied  REAL NOT NULL,
  basis         TEXT NOT NULL,           -- the kind of household on the issue date

  late_fee      REAL NOT NULL DEFAULT 0,
  late_fee_at   TEXT,                    -- NULL = never applied; the idempotency guard
  late_fee_waived_by INTEGER REFERENCES owners(id),
  total         REAL NOT NULL,

  status        TEXT NOT NULL DEFAULT 'unpaid',
  -- When the resident tapped Pay. Kept for the same reason `bills.claimed_at`
  -- is, though the maintenance late fee does not hold on it: it is the only
  -- record of when a claim was made, and a dispute asks that question.
  claimed_at    TEXT,
  paid_at       TEXT,

  -- An offline payment an admin recorded — cash, a transfer the treasurer saw on
  -- the statement, a cheque. Second-admin approved like every other money move.
  -- The reference is not optional in practice: maintenance amounts repeat, so
  -- the reference is the ONLY thing tying a credit to a flat.
  paid_method   TEXT,
  paid_reference TEXT,

  -- The adjustment and waiver trail `bills` carries, from 0008. Same columns,
  -- same meanings, so the god-mode editor and the statement code read alike.
  manual_total  INTEGER NOT NULL DEFAULT 0,
  adjusted_by   INTEGER REFERENCES owners(id),
  adjusted_at   TEXT,
  adjust_reason TEXT,

  -- WHERE THE BILL CAME FROM, when it changed hands mid-quarter. A bill that
  -- silently moves between people is one nobody can audit, and "why is this
  -- ₹7,500 when the quarter was issued at ₹9,000" needs an answer with a name
  -- in it. owner_id moves; this remembers who it moved from.
  reassigned_from_id INTEGER REFERENCES owners(id),
  reassigned_at TEXT,

  cancelled_by  INTEGER REFERENCES owners(id),
  cancelled_at  TEXT,
  cancel_reason TEXT,

  created_at    TEXT NOT NULL,

  -- One bill per flat per quarter. The rule that makes re-running the issue job
  -- safe, exactly as UNIQUE (flat, period) does for gas.
  UNIQUE (flat, quarter),
  CHECK (basis IN ('owner','tenant')),
  -- `cancelled` is the one status gas does not have. A maintenance bill raised
  -- against the wrong party is withdrawn rather than waived: a waiver says the
  -- association forgave a real debt, and the difference matters on a dues report
  -- the treasurer has to explain.
  CHECK (status IN ('unpaid','initiated','awaiting','paid','waived','cancelled')),
  CHECK (rate_applied > 0 AND rate_applied = CAST(rate_applied AS INTEGER)),
  CHECK (late_fee = CAST(late_fee AS INTEGER)),
  CHECK (total >= 0)
);

CREATE INDEX ix_maint_bills_status  ON maint_bills(status, quarter);
CREATE INDEX ix_maint_bills_flat    ON maint_bills(flat, quarter);
-- The hot path for the voting block: every poll read asks "what does this flat
-- owe from an ended quarter", and it asks it once per flat per render.
CREATE INDEX ix_maint_bills_owner   ON maint_bills(owner_id, status);

-- ── advances ─────────────────────────────────────────────────────────────
-- A resident who pays a year up front.
--
-- STORED AS THE QUARTER IT REACHES, not as a balance to draw down. A balance
-- that decrements is a second ledger that can disagree with the bills, and
-- "paid up to 2027-Q3" cannot disagree with anything. The AMOUNT is stored too,
-- alongside it and not instead of it: money recorded without an amount cannot be
-- reconciled against the bank statement, and an advance is exactly the row a
-- treasurer will be asked to justify two AGMs later.
CREATE TABLE maint_advances (
  id           INTEGER PRIMARY KEY,
  flat         TEXT NOT NULL REFERENCES flats(flat),
  -- Who actually paid, which is not always who lives there now.
  owner_id     INTEGER REFERENCES owners(id),

  -- Inclusive: "paid up to 2027-Q2" means Q2 is covered, which is how the
  -- person writing the cheque understands it.
  paid_through TEXT NOT NULL,
  amount       REAL NOT NULL,
  method       TEXT,
  reference    TEXT,

  recorded_by  INTEGER NOT NULL REFERENCES owners(id),
  recorded_at  TEXT NOT NULL,
  -- NULL until a second admin agrees. An unapproved advance is one person's
  -- assertion, and code that treated it as payment would make "record an
  -- advance" a way for a single admin to clear a flat's dues and, with the
  -- voting rule, restore its vote.
  approved_by  INTEGER REFERENCES owners(id),
  approved_at  TEXT,
  note         TEXT,

  CHECK (paid_through GLOB '[0-9][0-9][0-9][0-9]-Q[1-4]'),
  CHECK (amount > 0),
  CHECK (recorded_by <> COALESCE(approved_by, -1))
);

CREATE INDEX ix_maint_advances_flat ON maint_advances(flat, paid_through);

-- ── exemptions ───────────────────────────────────────────────────────────
-- Two exemption lists, and they are keyed differently on purpose.

-- The maintenance late-fee exemption. SEPARATE FROM THE GAS ONE, which lives as
-- two columns on `owners` (0013) — a resident excused a ₹50 gas fee during a
-- meter dispute has not been excused a ₹750 maintenance fee, and one list doing
-- both would mean exactly that.
--
-- Keyed on the PERSON, matching gas and matching what was asked for: an
-- exemption is a fact about somebody's circumstances — a bereavement, a job
-- lost, a hardship the committee agreed to — and when they leave it should go
-- with them rather than quietly become the next occupant's.
--
-- What it adds over 0013 is the approval trail gas never had. Waiving a fee is
-- one of the five things two admins must agree on.
CREATE TABLE maint_fee_exemptions (
  id          INTEGER PRIMARY KEY,
  owner_id    INTEGER NOT NULL REFERENCES owners(id),
  -- Not nullable, following 0013's reasoning and 0024's: the committee turns
  -- over at every AGM, and a date with no reason is invisible policy one step
  -- later.
  reason      TEXT NOT NULL,
  -- An end date rather than a boolean, for 0013's reason exactly: a flag set
  -- during a dispute is never unset, and two years on "why has 4B never paid a
  -- late fee" has no answer anybody can find. A date makes forgetting a no-op.
  ends_at     TEXT NOT NULL,
  granted_by  INTEGER NOT NULL REFERENCES owners(id),
  granted_at  TEXT NOT NULL,
  approved_by INTEGER REFERENCES owners(id),
  approved_at TEXT,
  CHECK (granted_by <> COALESCE(approved_by, -1))
);

CREATE INDEX ix_maint_fee_exempt ON maint_fee_exemptions(owner_id, ends_at);

-- The voting exemption, which lets a flat vote despite arrears.
--
-- KEYED ON THE FLAT, and the asymmetry with the table above is deliberate. A
-- vote belongs to the flat — one vote per flat, cast by the owner (0036) — so an
-- exemption from a block on that vote is a fact about the flat, and it must
-- survive the owner selling or the tenant changing. A late-fee exemption is a
-- fact about a person and must not.
--
-- This is the override for the case the arrears rule cannot see: a flat whose
-- bill is genuinely disputed, or whose owner is settling through the committee,
-- should not lose its say at an AGM-adjacent poll over it.
CREATE TABLE voting_exemptions (
  id          INTEGER PRIMARY KEY,
  flat        TEXT NOT NULL REFERENCES flats(flat),
  reason      TEXT NOT NULL,
  -- Nullable here, unlike the late-fee list: an open-ended exemption is a
  -- deliberate committee decision for a flat in a long dispute, and forcing a
  -- date would mean inventing one. It shows as open-ended on the admin screen so
  -- it cannot hide.
  ends_at     TEXT,
  granted_by  INTEGER NOT NULL REFERENCES owners(id),
  granted_at  TEXT NOT NULL,
  approved_by INTEGER REFERENCES owners(id),
  approved_at TEXT,
  CHECK (granted_by <> COALESCE(approved_by, -1))
);

CREATE INDEX ix_voting_exempt ON voting_exemptions(flat, ends_at);

-- ── second-admin approvals ───────────────────────────────────────────────
-- Five actions need two admins: a rate switch, a late-fee waiver, an advance
-- recorded, a bill cancelled, and an offline payment recorded. All five move
-- money or restore a vote, and all five are the kind of thing that must not be
-- possible quietly.
--
-- WHY NOT bill_edit_requests. 0029 already implements these rules, and reusing
-- it was the first choice. Two things stopped it: its FK is bills(id), so
-- widening it means rebuilding a live gas table two weeks before a launch that
-- has a fixed date; and its field/value/total_before/total_after shape describes
-- an edit to a number, which is not what "advance recorded" or "offline payment
-- recorded" is. MERGING THE TWO QUEUES IS THE OBVIOUS LATER CONSOLIDATION and
-- is written here so the next reader knows it was considered rather than missed
-- — one approvals table with a subject kind, once the launch is behind us.
--
-- The rules themselves are 0029's, unchanged:
--   * the requester never approves their own request
--   * the bill's own household never approves it — an admin has a flat like
--     everyone else, and their own bill is where a quiet approval looks worst
--   * an admin's own bill needs every other eligible admin
--   * the superadmin is not in the pool but tops it up and may stand in
--   * a request expires rather than sitting open forever
CREATE TABLE maint_approval_requests (
  id           INTEGER PRIMARY KEY,
  -- What is being asked for. A `kind`, not a field name, because these are five
  -- different actions rather than five edits to one column.
  kind         TEXT NOT NULL,

  -- The subject. Exactly one of these is set, depending on the kind: a waiver,
  -- cancellation, rate switch or offline payment is about a bill; an advance is
  -- about a flat, because the advance row does not exist until this is approved.
  bill_id      INTEGER REFERENCES maint_bills(id),
  flat         TEXT REFERENCES flats(flat),

  -- The proposed change, held HERE rather than on the bill — 0029's reasoning:
  -- holding it on the row would mean the bill briefly says something nobody has
  -- agreed to, and a resident would see it.
  payload      TEXT,                    -- JSON: the fields the action would set
  reason       TEXT NOT NULL,
  -- Snapshotted so an approver sees the effect they are agreeing to, and so a
  -- request raised against a bill that has since moved can be spotted instead of
  -- silently applying to a different number.
  total_before REAL,
  total_after  REAL,

  requested_by INTEGER NOT NULL REFERENCES owners(id),
  requested_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  resolved_at  TEXT,

  CHECK (kind IN ('rate-switch','late-fee-waiver','advance','cancel-bill','offline-payment')),
  CHECK (status IN ('pending','applied','rejected','expired','cancelled')),
  CHECK ((bill_id IS NOT NULL) <> (flat IS NOT NULL))
);

CREATE INDEX ix_maint_approvals_bill ON maint_approval_requests(bill_id, status);
CREATE INDEX ix_maint_approvals_open ON maint_approval_requests(status, expires_at);

CREATE TABLE maint_approvals (
  request_id  INTEGER NOT NULL REFERENCES maint_approval_requests(id),
  approver_id INTEGER NOT NULL REFERENCES owners(id),
  decision    TEXT NOT NULL,
  -- A superadmin standing in for an admin who has not answered is recorded as
  -- exactly that, following 0029: an override that reads like an ordinary
  -- approval is one nobody can audit later.
  substitute  INTEGER NOT NULL DEFAULT 0,
  at          TEXT NOT NULL,
  PRIMARY KEY (request_id, approver_id),
  CHECK (decision IN ('approve','reject'))
);

-- ── tenancy dates ────────────────────────────────────────────────────────
-- The expiry that does not exist today. `moved_in_at` and `moved_out_at` are
-- already here from 0003; what has never existed is any way to tell an active
-- tenant from one who left eight months ago without an admin flipping `active`.
-- Migration 0011 derives who pays entirely from that one flag, and scheduling a
-- quarter is the moment that stops being harmless, because it fixes
-- ninety-nine rates at once.
--
-- THIS COLUMN DOES NOT DRIVE THE RATE, and the code says so too (isResidentOn in
-- functions/lib/maint.js). A lapsed lease with the tenant still in the flat is
-- the common case in this building, and treating an expired date as "no tenant"
-- would bill the owner rate for a rented flat and cost the association ₹1,500 a
-- quarter on each one. It is a DATA-QUALITY SIGNAL: tenancyReadiness raises
-- expired and undated leases before a quarter can be scheduled, and a human —
-- who can tell a lapsed lease from a departed tenant — resolves them.
ALTER TABLE owners ADD COLUMN lease_ends_at TEXT;

-- When an admin last confirmed this tenancy is real. The answer to "is the
-- undated lease on 7C still current" is a date somebody checked, not an
-- inference, and without it every quarter re-asks the same ninety-nine
-- questions from scratch.
ALTER TABLE owners ADD COLUMN tenancy_confirmed_at TEXT;

-- ── payment proofs, rebuilt ──────────────────────────────────────────────
-- A screenshot can now prove a gas bill or a maintenance bill, so `bill_id` has
-- to become nullable — and SQLite cannot drop NOT NULL in place. This is the
-- table rebuild 0030 did for `owners`, in the same shape.
--
-- WHY ONE TABLE AND NOT A SECOND maint_payment_proofs. The deciding factor is
-- `image_sha256 UNIQUE`. With two tables the same screenshot can be spent once
-- against a gas bill and once against a maintenance bill and nothing anywhere
-- notices — a hole somebody eventually finds, in the one part of this system
-- that exists to stop a payment being claimed twice. One table also means one
-- review queue, one dedupe, one backup sweep and one vision path rather than
-- two of each drifting apart.
--
-- ROW IDS ARE PRESERVED, which matters beyond tidiness: `reconciliations.proof_id`
-- (0017) points into this table, and a rebuild that renumbered rows would
-- silently repoint every reconciliation ever recorded. R2 keys are column
-- values, so nothing in the bucket moves.
--
-- WHY `reconciliations` IS REBUILT TWICE BELOW, WHICH LOOKS ABSURD UNTIL YOU
-- TRY IT ANY OTHER WAY. This was found by running the migration against a
-- populated database, not by reading it.
--
-- `reconciliations.proof_id` (0017) is a foreign key INTO payment_proofs. The
-- moment one reconciliation row exists, `DROP TABLE payment_proofs` orphans it
-- and the migration dies with SQLITE_CONSTRAINT_FOREIGNKEY — halfway through,
-- with the new table already built. An empty database never shows this, which
-- is exactly why check-migrations.mjs did not catch it and says so in its own
-- header.
--
-- `PRAGMA defer_foreign_keys = ON` does not save it, and that is worth writing
-- down because it is the obvious fix and it silently does not work. Deferring
-- moves the check to commit, but DROP TABLE runs an implicit delete that
-- INCREMENTS the deferred-violation counter, and re-creating the table under
-- the same name afterwards never decrements it. The transaction still fails at
-- commit, now with a rolled-back Durable Object instead of a clean error.
--
-- `PRAGMA foreign_keys = OFF` is the documented SQLite answer and is not
-- available: it is a no-op inside a transaction, and D1 runs each migration in
-- one.
--
-- What is left is to make sure nothing references payment_proofs at the moment
-- it is dropped. `reconciliations` has no children of its own, so rebuilding it
-- is cheap and safe: once without the foreign key, then payment_proofs, then
-- once more to put the key back exactly as 0017 declared it. The database ends
-- in the shape it would have had if SQLite could simply drop a NOT NULL.
--
-- Note for whoever rebuilds the next table: 0030 rebuilt `owners`, which half
-- the schema references, and does none of this. It applied cleanly only because
-- production held almost no rows at the time. The pattern in this repo is less
-- proven than its comments suggest — rehearse the next one against real data.

-- Step 1 of 3: reconciliations, minus the key into payment_proofs.
CREATE TABLE reconciliations_tmp (
  id         INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES statement_sessions(id),
  proof_id   INTEGER,
  bill_id    INTEGER REFERENCES bills(id),
  verdict    TEXT NOT NULL,
  reference  TEXT,
  amount     REAL,
  txn_date   TEXT,
  matched_by TEXT,
  created_at TEXT NOT NULL,
  CHECK (verdict IN ('confirmed', 'amount_mismatch', 'proof_no_credit', 'credit_no_proof', 'duplicate_reference')),
  CHECK (matched_by IS NULL OR matched_by IN ('reference', 'amount-and-date'))
);
INSERT INTO reconciliations_tmp
  (id, session_id, proof_id, bill_id, verdict, reference, amount, txn_date, matched_by, created_at)
SELECT id, session_id, proof_id, bill_id, verdict, reference, amount, txn_date, matched_by, created_at
FROM reconciliations;
DROP TABLE reconciliations;
ALTER TABLE reconciliations_tmp RENAME TO reconciliations;

-- Step 2 of 3: the rebuild this migration actually came for.
CREATE TABLE payment_proofs_new (
  id            INTEGER PRIMARY KEY,

  -- Exactly one of these. A proof belongs to one bill of one kind; a screenshot
  -- pointing at both would be a payment counted twice, and one pointing at
  -- neither is an orphan nobody can review.
  bill_id       INTEGER REFERENCES bills(id),
  maint_bill_id INTEGER REFERENCES maint_bills(id),

  owner_id      INTEGER REFERENCES owners(id),
  r2_key        TEXT,                      -- nulled on delete, row retained
  image_sha256  TEXT NOT NULL UNIQUE,      -- survives deletion, powers dedupe
  utr           TEXT,
  parsed_amount REAL,
  status        TEXT NOT NULL DEFAULT 'pending',
  reviewed_by   INTEGER REFERENCES owners(id),
  reviewed_at   TEXT,
  deleted_at    TEXT,
  backed_up_at  TEXT,
  created_at    TEXT NOT NULL,
  CHECK (status IN ('pending','approved','rejected')),
  CHECK ((bill_id IS NOT NULL) <> (maint_bill_id IS NOT NULL))
);

INSERT INTO payment_proofs_new
  (id, bill_id, maint_bill_id, owner_id, r2_key, image_sha256, utr, parsed_amount,
   status, reviewed_by, reviewed_at, deleted_at, backed_up_at, created_at)
SELECT
   id, bill_id, NULL, owner_id, r2_key, image_sha256, utr, parsed_amount,
   status, reviewed_by, reviewed_at, deleted_at, backed_up_at, created_at
FROM payment_proofs;

DROP TABLE payment_proofs;
ALTER TABLE payment_proofs_new RENAME TO payment_proofs;

-- ux_proof_utr is recreated exactly as 0001 had it: PARTIAL, because a proof
-- whose UTR could not be read stores NULL and several NULLs must not collide.
-- The three below are new. The table had no index on bill_id at all, which was
-- survivable while every lookup came from one bill at a time; the review queue
-- and the dues report both scan by status, and both now carry twice the rows.
CREATE UNIQUE INDEX ux_proof_utr ON payment_proofs(utr) WHERE utr IS NOT NULL;
CREATE INDEX ix_proof_bill       ON payment_proofs(bill_id);
CREATE INDEX ix_proof_maint_bill ON payment_proofs(maint_bill_id);
CREATE INDEX ix_proof_status     ON payment_proofs(status, created_at);

-- Step 3 of 3: reconciliations again, with the key into payment_proofs put
-- back exactly as 0017 declared it. Every id was preserved through the rebuild,
-- so each proof_id still points at the same proof it always did.
CREATE TABLE reconciliations_new (
  id         INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES statement_sessions(id),
  proof_id   INTEGER REFERENCES payment_proofs(id),
  bill_id    INTEGER REFERENCES bills(id),
  verdict    TEXT NOT NULL,
  -- Statement-derived, and kept on purpose: without it a confirmation cannot
  -- be justified after the statement is gone. Narration is NOT kept.
  reference  TEXT,
  amount     REAL,
  txn_date   TEXT,
  matched_by TEXT,
  created_at TEXT NOT NULL,
  CHECK (verdict IN ('confirmed', 'amount_mismatch', 'proof_no_credit', 'credit_no_proof', 'duplicate_reference')),
  CHECK (matched_by IS NULL OR matched_by IN ('reference', 'amount-and-date'))
);
INSERT INTO reconciliations_new
  (id, session_id, proof_id, bill_id, verdict, reference, amount, txn_date, matched_by, created_at)
SELECT id, session_id, proof_id, bill_id, verdict, reference, amount, txn_date, matched_by, created_at
FROM reconciliations;
DROP TABLE reconciliations;
ALTER TABLE reconciliations_new RENAME TO reconciliations;

CREATE INDEX ix_reconciliations_proof ON reconciliations(proof_id);
CREATE INDEX ix_reconciliations_bill  ON reconciliations(bill_id);
