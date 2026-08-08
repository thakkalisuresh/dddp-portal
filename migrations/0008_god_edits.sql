-- God edits: let the superadmin change anything, and record every change.
--
-- The power is the easy part. What makes it safe to use is that a bill can no
-- longer be altered without the alteration being visible — to the treasurer
-- explaining a discrepancy, and to the superadmin defending one.
--
-- WHY manual_total EXISTS. DDP-BILL-003 is a *fatal* error meaning "bill total
-- does not match its own components". Overriding a total to a goodwill figure
-- creates exactly that mismatch, so without a flag every manual adjustment
-- would alert as data corruption and the real signal would be lost in it.
-- The flag says the mismatch is intentional, so the check keeps its teeth for
-- the case it was written for.
ALTER TABLE bills ADD COLUMN manual_total    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bills ADD COLUMN adjusted_by     INTEGER REFERENCES owners(id);
ALTER TABLE bills ADD COLUMN adjusted_at     TEXT;
ALTER TABLE bills ADD COLUMN adjust_reason   TEXT;

-- The audit_log already records actor, subject, action and a JSON detail, and
-- audit() always writes the REAL actor rather than an impersonated subject, so
-- god edits need no new table — only the discipline of always calling it.
--
-- No new index either: 0003 already added ix_audit_action(action, at), which is
-- exactly what the "what has been changed" view needs.
