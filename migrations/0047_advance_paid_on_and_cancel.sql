-- Recording an advance from the admin console, and cancelling an approved one.
--
-- Two things the advance row could not carry before, both added the safe way.
-- `maint_advances` has NOTHING pointing a foreign key at it — no child table
-- references its id — so a plain ADD COLUMN needs none of the table-rebuild that
-- 0042's `payment_proofs` did, and none of the CHECK-widening rebuild a new
-- approval `kind` would force on a table that already has child rows. Existing
-- rows read NULL on every column below, which is the honest value: the advances
-- on record were entered by raw SQL before this UI existed, none was cancelled,
-- and none captured the payment date as its own field.

-- THE PAYMENT DATE, as its own queryable column rather than buried in the note.
-- An advance is the row a treasurer is asked to justify two AGMs later, and
-- "when did the money arrive" is the first question — matched against a bank
-- statement, filtered and sorted on in the admin list, so it is a column, not a
-- sentence. Stored ISO (YYYY-MM-DD); shown DD/MM/YYYY, the portal's en-GB form.
ALTER TABLE maint_advances ADD COLUMN paid_on TEXT;

-- THE APPLIED CANCEL. An approved advance is soft-cancelled, never deleted: the
-- row stays, struck through, so the record of a mistake and its correction both
-- survive. `advanceCovers()` gains `&& !cancelled_at`, so a cancelled advance
-- stops settling any bill the moment this is set.
ALTER TABLE maint_advances ADD COLUMN cancelled_at  TEXT;
ALTER TABLE maint_advances ADD COLUMN cancelled_by  INTEGER REFERENCES owners(id);
ALTER TABLE maint_advances ADD COLUMN cancel_reason TEXT;

-- THE PENDING CANCEL, kept apart from the applied one so maker and checker are
-- two different columns and two different people. The admin who asks sets
-- `cancel_requested_by/at`; the DIFFERENT admin who agrees becomes `cancelled_by`
-- — the maker <> checker rule that runs on every maintenance decision, enforced
-- in code exactly as the advance's own recorded_by <> approved_by CHECK enforces
-- it for the record itself. A cancel awaiting a second admin is
-- `cancel_requested_at IS NOT NULL AND cancelled_at IS NULL`, which is how the
-- approvals queue finds it.
ALTER TABLE maint_advances ADD COLUMN cancel_requested_by INTEGER REFERENCES owners(id);
ALTER TABLE maint_advances ADD COLUMN cancel_requested_at TEXT;

-- THE LATE FEE THE CANCEL CARRIES to the reopened bill, chosen by the admin at
-- cancel time. NULL means no fee — the default — so an accidental cancel does
-- not silently punish a resident. When set, `cancel_late_fee` is the amount
-- (whole rupees, the quarter's ₹750 by default but editable) and
-- `cancel_late_fee_from` the date it applies from. Both live on the advance
-- rather than on the bill because the bill does not exist to carry them until
-- the cancel is approved, at which point the revert reads them here.
ALTER TABLE maint_advances ADD COLUMN cancel_late_fee      INTEGER;
ALTER TABLE maint_advances ADD COLUMN cancel_late_fee_from TEXT;
