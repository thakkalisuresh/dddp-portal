-- When the resident first claimed to have paid this bill.
--
-- WHY A BILL NEEDS THIS. `initiated` is held by the late-fee cron rather than
-- charged, which is right: somebody who tapped Pay on the 9th should not be
-- penalised because the treasurer reconciled on the 15th. But the hold had no
-- end, so `initiated` was permanent immunity — and there was no timestamp
-- anywhere on the bill to end it with.
--
-- SET ONCE, NEVER RESET. The intent handler only fills this when it is NULL.
-- Restarting the clock on every tap would hand every resident an indefinite
-- hold for the price of opening the app each night, which is the same hole
-- wearing a different hat.
--
-- payment_intents.created_at was not enough: it records taps, so the earliest
-- row is the honest claim and the latest is the loophole. One column on the
-- bill says which one the late fee is measured against.
ALTER TABLE bills ADD COLUMN claimed_at TEXT;

-- Bills already sitting in `initiated` have no claim time, so the hold would
-- expire the moment this ships. Production has no bills at all today, but a
-- dev database does, and a migration that silently charges a late fee is not
-- one anybody should have to reason about at 2am.
UPDATE bills SET claimed_at = created_at WHERE status = 'initiated' AND claimed_at IS NULL;
