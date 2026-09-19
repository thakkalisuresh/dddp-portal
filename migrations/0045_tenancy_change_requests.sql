-- A tenant moving out, held until a second admin agrees.
--
-- Recording a departure is not a tidy-up. It re-rates the quarter, moves an
-- unpaid bill to somebody who did not incur it, and switches who the letters
-- go to — and it takes away a person's login. One admin should not be able to
-- do all of that from a card while nobody is looking, which is the same
-- conclusion 0029 reached about editing a bill total.
--
-- WHY NOT A SIXTH `kind` ON maint_approval_requests. That table's CHECK would
-- have to be widened, which in SQLite means rebuilding it -- and 0042 rebuilt
-- `reconciliations` twice precisely because `maint_approvals` holds a foreign
-- key into it, wrote a long note about DROP TABLE orphaning incoming keys and
-- about `defer_foreign_keys` silently not helping, and closed by asking the
-- next person not to treat the pattern as proven. Spending that risk to add one
-- string to a CHECK is a poor trade.
--
-- It is also the wrong table on its own terms. Every kind in
-- maint_approval_requests is a decision about MONEY that already exists -- a
-- waiver, a cancellation, a rate switch, an advance, an offline payment -- and
-- its CHECK says so: exactly one of bill_id or flat, neither of which is a
-- person. A departure is a fact about somebody's occupancy that happens to have
-- consequences for money. It gets its own table, shaped like 0029's pair,
-- because that is the shape this codebase already reads fluently.
CREATE TABLE tenancy_change_requests (
  id            INTEGER PRIMARY KEY,

  -- WHO LEFT, not which flat. A flat can hold two tenant logins (0040), so the
  -- flat alone does not say which tenancy ended, and an approver agreeing to
  -- the wrong one takes the wrong person's login away.
  person_id     INTEGER NOT NULL REFERENCES owners(id),
  flat          TEXT NOT NULL REFERENCES flats(flat),
  kind          TEXT NOT NULL DEFAULT 'moved-out',

  -- A DATE, not a month, and this is the one place in the schema where the two
  -- conventions differ. A tenancy START is stored as the first of a month
  -- because month-and-year is what anybody actually remembers. A departure
  -- cannot be: the whole consequence turns on which side of the issue date it
  -- falls, and a month cannot express 30 September against 3 October, which are
  -- a re-rate and a reassignment respectively.
  moved_out_on  TEXT NOT NULL,

  -- What the flat becomes: the owner moves in, a new tenant arrives, or it
  -- stands empty. `empty` bills exactly as `owner` does -- nobody is renting it
  -- -- but it is recorded as itself, so that a re-rate's reason says what
  -- happened rather than the nearest thing the billing code could recognise.
  becomes       TEXT NOT NULL,
  reason        TEXT NOT NULL,

  -- The consequences AS THEY WERE SHOWN, snapshotted as JSON. 0029 snapshots
  -- total_before and total_after for the same reason: an approver agrees to the
  -- effect they were shown, and a request raised against a bill that has since
  -- moved should be spotted rather than silently applied to a different number.
  plan          TEXT,

  requested_by  INTEGER NOT NULL REFERENCES owners(id),
  requested_at  TEXT NOT NULL,
  -- An unanswered departure must not sit open forever with a tenant who has
  -- gone still receiving the letters. Same bargain as 0029.
  expires_at    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  resolved_at   TEXT,

  CHECK (kind IN ('moved-out')),
  CHECK (becomes IN ('owner','tenant','empty')),
  CHECK (status IN ('pending','applied','rejected','expired','cancelled')),
  CHECK (moved_out_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);

CREATE INDEX ix_tenancy_requests_open   ON tenancy_change_requests(status, requested_at);
CREATE INDEX ix_tenancy_requests_person ON tenancy_change_requests(person_id, status);

-- Only one departure may be open per person at a time. Two admins each filing
-- one, with different dates, would leave a queue whose entries disagree about
-- when somebody left and whichever was approved second silently winning.
CREATE UNIQUE INDEX ux_tenancy_request_open
  ON tenancy_change_requests(person_id) WHERE status = 'pending';

CREATE TABLE tenancy_change_approvals (
  request_id  INTEGER NOT NULL REFERENCES tenancy_change_requests(id),
  approver_id INTEGER NOT NULL REFERENCES owners(id),
  decision    TEXT NOT NULL,
  -- A superadmin standing in for an admin who has not answered is recorded as
  -- exactly that, as 0029 and 0042 both do: an override that reads like an
  -- ordinary approval is one nobody can audit later.
  substitute  INTEGER NOT NULL DEFAULT 0,
  at          TEXT NOT NULL,
  PRIMARY KEY (request_id, approver_id),
  CHECK (decision IN ('approve','reject'))
);
