-- Bank statement reconciliation.
--
-- Two lifetimes deliberately kept apart:
--
--   statement_sessions / statement_credits  TRANSIENT. The statement itself.
--     Deleted the moment the treasurer finishes, and swept by the 3am cron if
--     they never do. statement_credits carries narration, which carries other
--     members' names and payment habits — it is the sensitive half and it is
--     the half that does not survive.
--
--   reconciliations                          PERMANENT. The verdict, plus the
--     reference and amount that justified it. Enough to answer "why was this
--     marked confirmed?" a year later without keeping the statement.

CREATE TABLE statement_sessions (
  id           INTEGER PRIMARY KEY,
  created_by   INTEGER NOT NULL REFERENCES owners(id),
  filename     TEXT,
  row_count    INTEGER NOT NULL DEFAULT 0,
  credit_total REAL    NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'open',
  created_at   TEXT    NOT NULL,
  finished_at  TEXT,
  CHECK (status IN ('open', 'finished', 'discarded', 'swept'))
);
CREATE INDEX ix_statement_sessions_status ON statement_sessions(status, created_at);

CREATE TABLE statement_credits (
  session_id INTEGER NOT NULL REFERENCES statement_sessions(id) ON DELETE CASCADE,
  id         INTEGER PRIMARY KEY,
  txn_date   TEXT,
  amount     REAL NOT NULL,
  reference  TEXT,
  narration  TEXT
);
CREATE INDEX ix_statement_credits_session ON statement_credits(session_id);

CREATE TABLE reconciliations (
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
CREATE INDEX ix_reconciliations_proof ON reconciliations(proof_id);
CREATE INDEX ix_reconciliations_bill  ON reconciliations(bill_id);
