-- Reconciliation, once there are two bank accounts.
--
-- Gas and maintenance are paid into DIFFERENT accounts (0042). Until now a
-- statement was simply "the statement", because there was only one. With two,
-- an upload has to say which account it came from, and the matcher has to be
-- held to that account's proofs and that account's bills. The alternative --
-- one combined list -- was rejected in design: it invites an admin to settle a
-- gas claim with a maintenance credit, which is a false match with real money
-- behind it and no statement left afterwards to disprove it.
--
-- THREE COLUMNS, NO TABLE REBUILD. 0042 rebuilt `reconciliations` twice to get
-- a foreign key back, and its own closing note asks the next person not to
-- treat that as a proven pattern. Nothing here needs it: every column added
-- below is nullable or has a default, which is all SQLite requires of ADD
-- COLUMN, and the CHECK that would have constrained `account` is enforced in
-- the application instead. A rebuild to gain one CHECK would be spending the
-- risk 0042 warned about on the smallest possible gain.

-- Which account this statement came from: 'gas' or 'maintenance'.
--
-- DEFAULT 'gas' is the honest backfill, not a convenience. Every statement
-- reconciled before this migration was the gas account, because it was the only
-- account the portal knew how to bill into.
ALTER TABLE statement_sessions ADD COLUMN account TEXT NOT NULL DEFAULT 'gas';

-- The maintenance twin of `reconciliations.bill_id`. A verdict about a
-- maintenance bill could not be recorded at all before this: 0017 declared
-- bill_id REFERENCES bills(id), so writing a maint_bills id into it would
-- either fail the key or, worse, point at an unrelated gas bill with the same
-- number. Exactly one of the two is set, the same bargain payment_proofs makes.
ALTER TABLE reconciliations ADD COLUMN maint_bill_id INTEGER REFERENCES maint_bills(id);

-- WHO ASSIGNED A CREDIT TO A FLAT, and the discriminator that says an
-- assignment is what this row is.
--
-- Assignment exists because maintenance has no fingerprint. 0042 says it
-- plainly: forty-one flats owing the same rupee mean an amount cannot identify
-- a payer, so an amount match alone is never a match here. What the matcher can
-- do is narrow -- the reference, the note in the narration, the amount -- and
-- then an admin reads the evidence and says which flat this credit belongs to.
--
-- ADMIN ALONE, DELIBERATELY. A credit on the statement is the bank's own record
-- that the money arrived; assigning it is reading that evidence, which is the
-- same act as approving a payment screenshot and needs the same one admin. What
-- needs two is an admin asserting a payment with NO bank evidence behind it,
-- and that is the offline-payment path in 0042, which already has them. The two
-- doors stay separate so that neither becomes a way around the other -- and
-- this column is what makes an assignment auditable as its own kind of act
-- rather than looking, later, like an ordinary match the computer made.
ALTER TABLE reconciliations ADD COLUMN assigned_by INTEGER REFERENCES owners(id);

CREATE INDEX ix_reconciliations_maint ON reconciliations(maint_bill_id);
