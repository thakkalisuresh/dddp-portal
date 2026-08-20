/**
 * Correcting a published month, without ever typing a rupee figure.
 *
 * THE RULE, decided 2026-08-20 (docs/BILLING-TAB.md): the amount is visible and
 * never editable, for everyone including the superadmin. A bill's total is
 * consumption times rate, and both of those come from somewhere real, so there
 * are exactly two things that can be wrong with it:
 *
 *   a meter was misread   -> correct that flat's READING     -> one bill
 *   the gas was priced wrong -> correct the month's PRICE     -> every bill
 *
 * There is no third. There is deliberately no goodwill adjustment either: if
 * the committee wants to give somebody relief it happens outside the bill — a
 * late-fee waiver, or a debt not chased — and the bill goes on saying what the
 * gas cost. A bill that says something other than consumption times rate is a
 * bill nobody can check.
 *
 * Both are PURE here. The approval machinery shows an approver the same numbers
 * the requester saw, and it can only do that if the arithmetic runs twice off
 * the same function rather than once off a figure somebody passed along.
 */

import {
  computeBill, computeConsumption, meterDelta, meterDeltaAcrossChange, toWholeRupees,
} from './billing.js';
import { fail } from './errors.js';

/**
 * The field name a reading correction rides on.
 *
 * Not one of BILL_FIELDS, and that is the point: `editBill` refuses everything
 * outside that list, so a reading cannot be smuggled through the amount-editing
 * endpoint and an amount cannot be smuggled through this one.
 */
export const READING_FIELD = 'reading';

/** The field name a month-wide price correction rides on. */
export const PRICE_FIELD = 'period.rate_per_kg';

/**
 * What a corrected reading does to one bill.
 *
 * The late fee already charged rides along untouched. A meter misread in August
 * does not undo a fee earned in September by not paying, and silently dropping
 * it would be an adjustment nobody asked for — the exact thing this module
 * exists to prevent.
 */
export function planReadingCorrection({ bill, previous, reading, ratePerKg,
                                        conversionFactor, meterChange = null }) {
  const value = Number(reading);
  if (!Number.isFinite(value)) fail('DDP-BILL-001', { reading });
  if (previous == null) fail('DDP-BILL-001', { reading, previous });
  // Meters do not run backwards, and the grid says so on the way in. Saying it
  // again here is not belt and braces: this path is reachable by an API caller
  // that never saw the grid.
  if (!meterChange && value < Number(previous)) {
    fail('DDP-BILL-002', { reading: value, previous });
  }

  const consumption = computeConsumption(value, Number(previous), conversionFactor, meterChange);
  const { gasAmount, total } = computeBill({
    consumption,
    ratePerKg,
    otherCharges: bill.other_charges ?? 0,
    additionalCharges: bill.additional_charges ?? 0,
    lateFee: bill.late_fee ?? 0,
  });

  return {
    reading: value,
    consumption,
    gasAmount,
    total,
    // The gas that MOVED, which across a meter swap is the sum of both
    // segments. Subtracting the raw readings would store a negative delta
    // beside a positive consumption — a bill contradicting itself, which is
    // the DDP-BILL-003 condition arrived at by our own hand. generateBills
    // makes the same distinction for the same reason.
    delta: meterChange
      ? meterDeltaAcrossChange(value, Number(previous), meterChange)
      : Math.round(meterDelta(value, Number(previous)) * 1000) / 1000,
    was: bill.total,
    difference: Math.round((total - bill.total) * 100) / 100,
  };
}

/**
 * What a corrected price does to a whole month.
 *
 * Deliberately separate from a per-flat correction, and deliberately not a
 * per-flat rate: one flat billed at a different rate than its neighbours means
 * the month no longer reconciles against a single supplier invoice.
 *
 * `planRateChange` in admin.js already computes exactly this — which bills
 * move, which paid ones go back to unpaid, which end up in credit — so this
 * wraps it rather than reimplementing it. Two implementations of "what does
 * this cost" eventually disagree, and the one nobody is looking at is the one
 * that ran.
 */
export function priceCorrectionTotals(plan, bills) {
  const skippedIds = new Set(plan.skipped.map((s) => s.billId));
  const before = bills.reduce((sum, b) => sum + Number(b.total ?? 0), 0);
  const after = bills.reduce((sum, b) => {
    if (skippedIds.has(b.id)) return sum + Number(b.total ?? 0);
    const changed = plan.changes.find((c) => c.billId === b.id);
    return sum + Number(changed ? changed.now : b.total ?? 0);
  }, 0);
  return {
    totalBefore: toWholeRupees(before),
    totalAfter: toWholeRupees(after),
    ...plan.totals,
  };
}
