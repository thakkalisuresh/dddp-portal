-- Two other admins have to agree before a bill's total moves.
--
-- The committee's rule, decided 2026-08-13: readings are checked before they
-- are submitted, so an edit after generation means somebody already got it
-- wrong, and correcting money quietly is the thing that must not be possible.
-- Bill totals are whole rupees, so the smallest change any edit can make is ₹1
-- and effectively every total-changing edit needs sign-off.
--
--   * the requester never approves their own request
--   * the bill's own household never approves it — an admin has a flat like
--     everyone else, and their own bill is exactly where a quiet edit looks
--     worst
--   * an admin's bill needs EVERY other eligible admin, not just two
--   * the superadmin is not part of the pool, but tops it up when fewer than
--     two admins remain, and may stand in for one who has not answered
--
-- WHY A REQUEST TABLE AND NOT A FLAG. The edit has to be held somewhere until
-- it is approved, and holding it in the bill would mean the bill briefly says
-- something nobody agreed to. The proposed value waits here; `bills` changes
-- once, when the last approval lands.
CREATE TABLE bill_edit_requests (
  id            INTEGER PRIMARY KEY,
  bill_id       INTEGER NOT NULL REFERENCES bills(id),
  field         TEXT NOT NULL,
  value         REAL,
  value_text    TEXT,                     -- for `status`, which is not a number
  reason        TEXT NOT NULL,
  -- Snapshotted at request time so an approver sees the effect they are
  -- agreeing to, and so a request raised against a bill that has since moved
  -- can be spotted instead of silently applying to a different number.
  total_before  REAL NOT NULL,
  total_after   REAL NOT NULL,
  requested_by  INTEGER NOT NULL REFERENCES owners(id),
  requested_at  TEXT NOT NULL,
  -- Patience was the point ("they can take their time"), but an unanswered
  -- request must not sit open forever with a wrong bill on a resident's screen.
  expires_at    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  resolved_at   TEXT,
  CHECK (status IN ('pending','applied','rejected','expired','cancelled'))
);
CREATE INDEX ix_edit_requests_bill ON bill_edit_requests(bill_id, status);

CREATE TABLE bill_edit_approvals (
  request_id  INTEGER NOT NULL REFERENCES bill_edit_requests(id),
  approver_id INTEGER NOT NULL REFERENCES owners(id),
  decision    TEXT NOT NULL,
  -- A superadmin standing in for an admin who has not answered is recorded as
  -- exactly that. The stand-in is meant to be visible: an override that reads
  -- like an ordinary approval is one nobody can audit later.
  substitute  INTEGER NOT NULL DEFAULT 0,
  at          TEXT NOT NULL,
  PRIMARY KEY (request_id, approver_id),
  CHECK (decision IN ('approve','reject'))
);
