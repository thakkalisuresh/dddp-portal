-- Exempt a resident from late fees, until a date.
--
-- WHY NOT A PLAIN ON/OFF. A boolean gets set during a dispute, the dispute
-- resolves, and nobody remembers to unset it. Two years later it is invisible
-- policy, and the question "why has 4B never once paid a late fee" has no
-- answer anybody can find. An end date makes renewing a decision and forgetting
-- a no-op, which is the right way round.
--
-- The reason is stored because the committee turns over at every AGM. A date
-- with no reason is the same problem one step later.
ALTER TABLE owners ADD COLUMN late_fee_exempt_until  TEXT;
ALTER TABLE owners ADD COLUMN late_fee_exempt_reason TEXT;
