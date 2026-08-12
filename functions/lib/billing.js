/**
 * Pure billing arithmetic. No I/O — everything here is directly testable.
 *
 * THE RULE: a bill is exactly what the meter and the rate say, rounded UP to
 * the next whole rupee. Nothing is added to it and nothing is encoded in it.
 *
 * An earlier version stamped each flat's identifier into the paise so the
 * treasurer could tell two identical bills apart on a bank statement. That is
 * gone by decision: the amount a resident is asked for must be the amount the
 * calculation produces. Reconciliation now relies on the payer's name on the
 * UPI credit, the payment-intent list and the uploaded screenshot.
 *
 * Ceiling, not round-to-nearest. Most of flat 4A's real history cannot tell
 * the two apart — 328.50 and 298.50 land on 329 and 299 either way. The case
 * that decides it is 314.25, which the old portal billed as 315; rounding to
 * nearest gives 314. Ceiling is also what the RWA asked for outright: 329.01
 * is 330, never 329.
 */

import { fail } from './errors.js';

/** Round to 2dp without float drift (0.1 + 0.2 problems). */
export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Round up to the next whole rupee. 328.50 -> 329, 329.01 -> 330, 315 -> 315. */
export function toWholeRupees(amount) {
  return Math.ceil(round2(amount));
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

/** Build a bill total: gas + charges + any late fee, rounded up to a whole rupee. */
export function computeBill({
  consumption,
  ratePerKg,
  otherCharges = 0,
  additionalCharges = 0,
  lateFee = 0,
}) {
  if (!Number.isFinite(ratePerKg) || ratePerKg <= 0) fail('DDP-BILL-005', { ratePerKg });

  const gasAmount = round2(consumption * ratePerKg);
  const subtotal = round2(gasAmount + otherCharges + additionalCharges + lateFee);
  const total = toWholeRupees(subtotal);

  if (!Number.isFinite(total)) fail('DDP-BILL-003', { gasAmount, subtotal, total });

  return { gasAmount, subtotal, lateFee, total };
}

/**
 * Add a late fee to an existing total, then round up as usual.
 * The total is already whole, so this stays whole for a whole-rupee fee.
 */
export function applyLateFee(currentTotal, lateFee) {
  // Whole rupees, still. The paise tag is gone, but `periods` and `bills` both
  // carry CHECK (late_fee = CAST(late_fee AS INTEGER)), so a fee of 50.50
  // passed validation here and then died at the database as a 500 instead of
  // a message. Nobody charges half a rupee in late fees; the rule is fine, it
  // just needed saying in the one place that produces a readable error.
  if (!Number.isFinite(lateFee) || lateFee < 0 || !isWholeRupees(lateFee)) {
    fail('DDP-BILL-008', { lateFee });
  }
  return toWholeRupees(round2(currentTotal + lateFee));
}

/**
 * The rate moves every month, so it is set per period and never carried
 * forward automatically. A silently inherited rate is the worst failure this
 * system can have: 99 bills go out looking completely normal and every one of
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
 * Catch a fat-fingered rate before 99 bills are generated from it.
 *
 * This is a note at the point of entry, NOT an error. A rate that moved is
 * ordinary monthly business: the real history here is 72 -> 75 -> 75 -> 75, a
 * single 4% change across four months. Filing that as a failure put a normal
 * event in the same list as genuine faults, so DDP-BILL-011 is retired and
 * nothing is logged or alerted.
 *
 * What survives is the one thing worth keeping: a line on screen at the moment
 * the number is typed, when it costs nothing to double-check the supplier bill
 * and everything to discover it after 99 bills have gone out.
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
    level: 'notice',
    change,
    message: `${Math.abs(change * 100).toFixed(0)}% ${change > 0 ? 'higher' : 'lower'} than last month `
           + `(₹${previousRate}). Worth a glance at the supplier bill — then carry on.`,
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
 * zero and 99 wrong bills are avoided.
 *
 * Pure. `rows` are { flat, reading, previous }.
 */
export function previewGeneration({ rows, ratePerKg, conversionFactor = DEFAULT_CONVERSION,
                                    previousRate = null, expectedFlats = null }) {
  const sanity = rateSanity(ratePerKg, previousRate);
  const bills = [];
  const blocked = [];

  for (const row of rows) {
    try {
      const consumption = computeConsumption(row.reading, row.previous, conversionFactor);
      const { gasAmount, total } = computeBill({ consumption, ratePerKg });
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
 * Is this resident exempt on this date?
 *
 * Inclusive of the end date: "exempt until 30 November" means the 30th is
 * still covered, which is how anyone reads it.
 */
export function isExempt(exemptUntil, today) {
  if (!exemptUntil) return false;
  return String(today) <= String(exemptUntil);
}

/**
 * How long a claim of payment holds off the late fee.
 *
 * The treasurer reconciles against a bank statement, which is a weekly job at
 * worst. A week is long enough that an honest payer is never charged for the
 * committee's timing, and short enough that "I tapped Pay" is not a permanent
 * exemption nobody granted.
 */
export const CLAIM_HOLD_DAYS = 7;

/**
 * Which bills the nightly cron should charge.
 *
 * `initiated` is HELD rather than charged: someone who tapped Pay on the 9th
 * must not be penalised because approval landed on the 15th. The treasurer
 * checks the bank statement and decides.
 *
 * THE HOLD NOW ENDS (B13). It used to be unbounded, which made `initiated` an
 * exemption anybody could grant themselves by tapping a button — and a
 * rejected screenshot used to put the bill back into exactly that state, so
 * one rejection made a resident permanently immune. Both holes were the same
 * hole: a hold with no clock. After CLAIM_HOLD_DAYS the claim has had its week
 * and the bill is charged like any other.
 */
export function lateFeeDecision(bill, {
  today, dueDate, graceDays = 0, exemptUntil = null, holdDays = CLAIM_HOLD_DAYS,
}) {
  if (bill.late_fee_at) return { action: 'skip', reason: 'already-applied' }; // idempotency guard
  if (bill.status === 'paid' || bill.status === 'waived') return { action: 'skip', reason: 'settled' };
  if (bill.status === 'awaiting') return { action: 'skip', reason: 'proof-under-review' };

  // An exemption the committee granted, and dated so it cannot become
  // permanent by neglect. Checked before the due date so the reason recorded
  // is the real one — "exempt" rather than "not yet due".
  if (isExempt(exemptUntil, today)) return { action: 'skip', reason: 'exempt' };

  const cutoff = new Date(dueDate);
  cutoff.setUTCDate(cutoff.getUTCDate() + graceDays);
  if (new Date(today) <= cutoff) return { action: 'skip', reason: 'not-yet-due' };

  if (bill.status === 'initiated') {
    // No claim time at all means nothing is known about when they tapped, and
    // an unknown is not a reason to hold forever — that is the bug. Treated as
    // expired, which is also what 0016 backfills away for existing rows.
    if (!bill.claimed_at) return { action: 'charge', reason: 'claim-unconfirmed' };

    const expires = new Date(bill.claimed_at);
    expires.setUTCDate(expires.getUTCDate() + holdDays);
    // Compared by date, not instant: `today` is a date and claimed_at carries a
    // time, so an instant comparison would end the hold part-way through its
    // last day depending on what o'clock somebody tapped Pay.
    if (String(today) <= expires.toISOString().slice(0, 10)) {
      return { action: 'hold', reason: 'payment-claimed' };
    }
    return { action: 'charge', reason: 'claim-unconfirmed' };
  }
  return { action: 'charge', reason: 'overdue' };
}
