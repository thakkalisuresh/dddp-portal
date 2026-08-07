/**
 * Pure billing arithmetic. No I/O — everything here is directly testable.
 *
 * THE INVARIANT: the paise of every bill total equal the flat's permanent
 * paise_tag. That is how the treasurer's bank statement identifies who paid.
 * Late fees are therefore whole rupees only (plan §4e); a fee carrying paise
 * would silently break reconciliation for the whole building.
 */

import { fail } from './errors.js';

/** Round to 2dp without float drift (0.1 + 0.2 problems). */
export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function paiseOf(total) {
  return Math.round(round2(total) * 100) % 100;
}

export function isWholeRupees(n) {
  return Number.isFinite(n) && Math.round(n * 100) % 100 === 0;
}

export function computeConsumption(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) {
    fail('DDP-BILL-001', { current, previous });
  }
  if (current < previous) {
    fail('DDP-BILL-002', { current, previous });
  }
  return round2(current - previous);
}

/**
 * Build a bill total. `paiseTag` is stamped onto the total as the flat's
 * identifier — the rupee part is the real amount owed.
 */
export function computeBill({
  consumption,
  ratePerKg,
  otherCharges = 0,
  additionalCharges = 0,
  lateFee = 0,
  paiseTag,
}) {
  if (!Number.isFinite(ratePerKg) || ratePerKg <= 0) fail('DDP-BILL-005', { ratePerKg });
  if (!isWholeRupees(lateFee)) fail('DDP-BILL-008', { lateFee });
  if (!Number.isInteger(paiseTag) || paiseTag < 1 || paiseTag > 99) {
    fail('DDP-BILL-004', { paiseTag });
  }

  const gasAmount = round2(consumption * ratePerKg);
  const subtotal = round2(gasAmount + otherCharges + additionalCharges + lateFee);
  const rupees = Math.round(subtotal); // absorb the natural paise, then stamp ours
  const total = round2(rupees + paiseTag / 100);

  if (!Number.isFinite(total)) fail('DDP-BILL-003', { gasAmount, subtotal, total });
  if (paiseOf(total) !== paiseTag) fail('DDP-BILL-004', { total, paiseTag });

  return { gasAmount, lateFee, total };
}

/**
 * Apply a late fee to an existing total, preserving the paise tag.
 * ₹329.04 + ₹50 -> ₹379.04, never ₹379.54.
 */
export function applyLateFee(currentTotal, lateFee) {
  // The whole-rupee guard is what preserves the tag; addition then just works.
  // The post-condition below is an assertion, not a branch — it exists so a
  // future refactor that breaks the invariant fails loudly instead of quietly.
  if (!isWholeRupees(lateFee)) fail('DDP-BILL-008', { lateFee });
  const tag = paiseOf(currentTotal);
  const total = round2(currentTotal + lateFee);
  if (paiseOf(total) !== tag) fail('DDP-BILL-004', { currentTotal, lateFee, total });
  return total;
}

/**
 * Which bills the nightly cron should charge.
 *
 * `initiated` is deliberately HELD, not charged: someone who tapped Pay on the
 * 9th must not be penalised because approval landed on the 15th. The treasurer
 * checks the bank statement and decides.
 */
export function lateFeeDecision(bill, { today, dueDate, graceDays = 0 }) {
  if (bill.late_fee_at) return { action: 'skip', reason: 'already-applied' }; // idempotency guard
  if (bill.status === 'paid' || bill.status === 'waived') return { action: 'skip', reason: 'settled' };
  if (bill.status === 'awaiting') return { action: 'skip', reason: 'proof-under-review' };

  const cutoff = new Date(dueDate);
  cutoff.setUTCDate(cutoff.getUTCDate() + graceDays);
  if (new Date(today) <= cutoff) return { action: 'skip', reason: 'not-yet-due' };

  if (bill.status === 'initiated') return { action: 'hold', reason: 'payment-claimed' };
  return { action: 'charge', reason: 'overdue' };
}
