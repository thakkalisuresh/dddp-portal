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

/**
 * DEFAULT_CONVERSION is derived, not guessed. Flat 4A's own history on the old
 * portal bills 4.38 kg against a meter delta of 1.683, 4.19 against 1.612,
 * 3.98 against 1.531 and 2.01 against 0.773 — a constant 2.60 across every
 * month. The meter measures volume (cubic metres of piped gas); the bill is
 * priced per kilogram.
 *
 * Treating the meter delta AS kilograms under-bills every flat by 2.6x, so
 * this factor is stored per period rather than hard-coded — gas calorific
 * value is revised occasionally and old bills must keep their own factor.
 */
export const DEFAULT_CONVERSION = 2.60;

/** Raw meter movement, in whatever unit the meter counts. */
export function meterDelta(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) {
    fail('DDP-BILL-001', { current, previous });
  }
  if (current < previous) {
    fail('DDP-BILL-002', { current, previous });
  }
  return Math.round((current - previous) * 1000) / 1000;
}

/** Billable consumption in kilograms. */
export function computeConsumption(current, previous, conversionFactor = DEFAULT_CONVERSION) {
  if (!Number.isFinite(conversionFactor) || conversionFactor <= 0) {
    fail('DDP-BILL-005', { conversionFactor });
  }
  return round2(meterDelta(current, previous) * conversionFactor);
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
 * The rate moves every month, so it is set per period and never carried
 * forward automatically. A silently inherited rate is the worst failure this
 * system can have: 52 bills go out looking completely normal and every one of
 * them is wrong, and nobody notices until someone checks a supplier invoice.
 *
 * Generation is therefore blocked until the rate has been set FOR THAT PERIOD.
 */
export function assertRateSetForPeriod(period) {
  if (!period || !Number.isFinite(period.rate_per_kg) || period.rate_per_kg <= 0) {
    fail('DDP-BILL-005', { period: period?.period });
  }
  if (period.rate_inherited) {
    fail('DDP-BILL-010', { period: period.period, rate: period.rate_per_kg });
  }
  return true;
}

/**
 * Catch a fat-fingered rate before 52 bills are generated from it. This warns
 * rather than blocks — gas prices genuinely do jump, and a treasurer who means
 * it must be able to proceed.
 */
export const RATE_JUMP_THRESHOLD = 0.25;

export function rateSanity(newRate, previousRate) {
  if (!Number.isFinite(newRate) || newRate <= 0) {
    return { ok: false, level: 'error', message: 'Enter a rate greater than zero.' };
  }
  if (!Number.isFinite(previousRate) || previousRate <= 0) {
    return { ok: true, level: 'none' };
  }
  const change = (newRate - previousRate) / previousRate;
  if (Math.abs(change) < RATE_JUMP_THRESHOLD) return { ok: true, level: 'none' };
  return {
    ok: true,
    level: 'warn',
    change,
    message: `That is ${Math.abs(change * 100).toFixed(0)}% ${change > 0 ? 'higher' : 'lower'} than last month (₹${previousRate}). Check the supplier bill before generating.`,
  };
}

/**
 * Many RWAs do not get a published per-kg tariff — they get one bulk invoice
 * and divide it across the sub-metered flats, which is why the effective rate
 * moves every month even when the supplier's tariff hasn't.
 *
 * Deriving the rate this way means it can only be known AFTER every reading is
 * in, which inverts the admin flow: readings first, then rate, then generate.
 */
export function deriveRate(supplierTotal, totalKg) {
  if (!Number.isFinite(supplierTotal) || supplierTotal <= 0) fail('DDP-BILL-005', { supplierTotal });
  if (!Number.isFinite(totalKg) || totalKg <= 0) fail('DDP-BILL-005', { totalKg });
  return Math.round((supplierTotal / totalKg) * 100) / 100;
}

/**
 * Sub-meters never sum to the bulk meter — there are line losses and unmetered
 * common usage. Surfacing the gap lets the treasurer see what they are actually
 * spreading across the flats instead of it disappearing into the rate.
 */
export function meterReconciliation(bulkKg, sumOfFlatsKg) {
  const gap = round2(bulkKg - sumOfFlatsKg);
  const pct = bulkKg > 0 ? gap / bulkKg : 0;
  return {
    bulkKg: round2(bulkKg),
    sumOfFlatsKg: round2(sumOfFlatsKg),
    gap,
    percent: Math.round(pct * 1000) / 10,
    // A negative gap means the flats measured MORE than the bulk meter, which
    // is physically impossible and means a reading is wrong.
    impossible: gap < 0,
  };
}

/**
 * What a month's import will actually bill, computed BEFORE anything is
 * written. The rate and the readings arrive together each month, so the
 * treasurer confirms one number they can check against the supplier invoice:
 * if that invoice is ~₹15,000 and this says ₹150,000, the rate has an extra
 * zero and 52 wrong bills are avoided.
 *
 * Pure. `rows` are { flat, reading, previous, paiseTag }.
 */
export function previewGeneration({ rows, ratePerKg, conversionFactor = DEFAULT_CONVERSION,
                                    previousRate = null, expectedFlats = null }) {
  const sanity = rateSanity(ratePerKg, previousRate);
  const bills = [];
  const blocked = [];

  for (const row of rows) {
    try {
      const consumption = computeConsumption(row.reading, row.previous, conversionFactor);
      const { gasAmount, total } = computeBill({
        consumption, ratePerKg, paiseTag: row.paiseTag,
      });
      bills.push({ flat: row.flat, consumption, gasAmount, total });
    } catch (err) {
      blocked.push({ flat: row.flat, reason: err.code ?? 'DDP-BILL-001' });
    }
  }

  const totalKg = round2(bills.reduce((sum, b) => sum + b.consumption, 0));
  const totalAmount = round2(bills.reduce((sum, b) => sum + b.total, 0));
  const amounts = bills.map((b) => b.total);

  return {
    ratePerKg,
    conversionFactor,
    rateSanity: sanity,
    willBill: bills.length,
    blocked,
    missing: expectedFlats == null ? null : expectedFlats - bills.length - blocked.length,
    totalKg,
    totalAmount,
    // Outliers are how a transposed digit shows itself.
    smallest: amounts.length ? Math.min(...amounts) : 0,
    largest: amounts.length ? Math.max(...amounts) : 0,
    // Generation is refused while anything is unresolved — a partial month
    // means some flats silently never get billed.
    canGenerate: blocked.length === 0 &&
                 sanity.ok &&
                 (expectedFlats == null || bills.length === expectedFlats),
  };
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
