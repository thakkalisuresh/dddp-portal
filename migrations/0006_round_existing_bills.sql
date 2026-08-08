-- Bring already-generated bills onto the new rule.
--
-- Totals written before this carry a paise tag (329.04, 195.05). Leaving them
-- would mean a resident's history shows amounts the current arithmetic can no
-- longer produce, and the QR for an unpaid one would ask for paise.
--
-- RECOMPUTE, do not round the stored total. The first version of this migration
-- ceilinged `total` in place and was wrong in a way that looked plausible:
-- 328.50 had been stored as 329.04 (rounded to the rupee, then tagged), so
-- ceiling it gave 330 when the correct bill is 329. Four of eight demo bills
-- came out a rupee high. The tag has to be discarded, not rounded over — which
-- means going back to the components.
--
-- SQLite has no CEIL, so: truncate, then add one rupee if anything was lost.
-- CAST(x AS INTEGER) truncates toward zero, which equals floor here because a
-- bill total is never negative.
UPDATE bills
   SET total = CAST(gas_amount + other_charges + additional_charges + late_fee AS INTEGER)
             + (CASE WHEN gas_amount + other_charges + additional_charges + late_fee
                          > CAST(gas_amount + other_charges + additional_charges + late_fee AS INTEGER)
                     THEN 1 ELSE 0 END);

-- gas_amount is deliberately NOT rounded. It is the honest pre-rounding figure
-- (consumption x rate) that the breakdown shows the resident, and it is what
-- makes the rounding visible as a line rather than an unexplained gap.
