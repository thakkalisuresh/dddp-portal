/**
 * The resident dashboard payload — one request, one round trip (plan §4b).
 *
 * The subject is passed in from the session. Nothing here accepts a flat from
 * the client; if you are tempted to add that parameter, the caller belongs
 * under /api/admin/ instead.
 */

import { buildUpiLinks, payTargetFor } from './upi.js';
import { computeConsumption, DEFAULT_CONVERSION } from './billing.js';
import { billAccess, occupantOf, describeRelationship } from './tenancy.js';

const READING_HISTORY = 6;
const BILL_HISTORY = 12;

/**
 * Derived presentation state for a bill. Pure — the interesting cases are
 * "overdue" and "the CTA must disappear once settled", both of which are
 * decisions rather than data.
 */
export function shapeBill(bill, period, today = new Date().toISOString().slice(0, 10)) {
  if (!bill) return null;

  const settled = bill.status === 'paid' || bill.status === 'waived';
  const claimed = bill.status === 'initiated' || bill.status === 'awaiting';
  const pastDue = !settled && period?.due_date != null && today > period.due_date;

  return {
    id: bill.id,
    period: bill.period,
    consumption: bill.consumption,
    ratePerKg: bill.rate_per_kg,
    gasAmount: bill.gas_amount,
    otherCharges: bill.other_charges,
    additionalCharges: bill.additional_charges,
    lateFee: bill.late_fee,
    lateFeeAt: bill.late_fee_at,
    total: bill.total,
    status: bill.status,
    paidAt: bill.paid_at,
    dueDate: period?.due_date ?? null,

    // Display status is not the same as the DB status: an unpaid bill past its
    // due date reads as "overdue" to a resident even though nothing changed.
    displayStatus: settled ? 'paid' : claimed ? bill.status : pastDue ? 'overdue' : 'unpaid',

    // A dead button is worse than no button — the CTA vanishes once settled.
    showPayButton: !settled,
    showUploadLink: !settled,
    settled,

    // Warn before the fee lands, so nobody is surprised by it.
    lateFeeWarning:
      !settled && !bill.late_fee && period?.late_fee > 0 && !pastDue
        ? { amount: period.late_fee, after: period.due_date }
        : null,
  };
}

export async function dashboardPayload(env, subject, userAgent = '') {
  const flat = subject.flat;
  // Bills follow the PERSON, not the flat. After a sale the new owner must not
  // see the previous owner's bills, and vice versa. Readings are different —
  // a meter reading is a property fact and carries across.
  const ownerId = subject.id;

  // Everyone attached to this flat, so the tenancy rules can be applied. An
  // absent owner reads their TENANT's bills here, not their own, which is the
  // one place the bills-follow-the-person rule is deliberately relaxed — and
  // only for amounts, never for screenshots.
  const household = await env.DB.prepare(
    'SELECT id, name, flat, relationship, active FROM owners WHERE flat = ?'
  ).bind(flat).all();
  const people = household.results ?? [];

  const access = billAccess({ viewer: subject, people });
  const occupant = occupantOf(people);
  // A landlord is shown the occupant's bills; everyone else, their own.
  const billsOf = access.reason === 'landlord' && occupant ? occupant.id : ownerId;

  const [flatRow, billRow, readings, bills] = await Promise.all([
    env.DB.prepare('SELECT flat, floor FROM flats WHERE flat = ?').bind(flat).first(),

    env.DB.prepare(
      `SELECT b.*, p.due_date, p.late_fee AS period_late_fee, p.status AS period_status
         FROM bills b JOIN periods p ON p.period = b.period
        WHERE b.flat = ? AND (b.owner_id IS NULL OR b.owner_id = ?)
        ORDER BY b.period DESC LIMIT 1`
    ).bind(flat, billsOf).first(),

    env.DB.prepare(
      `SELECT period, reading, read_on FROM readings WHERE flat = ? ORDER BY period DESC LIMIT ?`
    ).bind(flat, READING_HISTORY).all(),

    env.DB.prepare(
      `SELECT period, consumption, rate_per_kg, total, status, late_fee
         FROM bills WHERE flat = ? AND (owner_id IS NULL OR owner_id = ?)
        ORDER BY period DESC LIMIT ?`
    ).bind(flat, billsOf, BILL_HISTORY).all(),
  ]);

  const period = billRow
    ? { due_date: billRow.due_date, late_fee: billRow.period_late_fee, status: billRow.period_status }
    : null;
  const bill = shapeBill(billRow, period);

  // The QR and the button are built from the same URI, so a late fee changes
  // both automatically (plan §4e).
  let pay = null;
  // A landlord never gets a Pay button. They are liable for the debt, but the
  // bill is the tenant's to settle, and two people paying one bill is a
  // reconciliation problem nobody wants.
  if (bill && bill.showPayButton && access.canPay) {
    pay = {
      target: payTargetFor(userAgent),
      links: buildUpiLinks({
        vpa: env.UPI_VPA,
        payee: env.UPI_PAYEE,
        amount: bill.total,
        flat,
        period: bill.period,
      }),
    };
  }

  const tenancy = {
    // Shown on the profile. With no confirmation step in onboarding, this
    // line IS the error-catching mechanism for a wrong roster entry.
    description: describeRelationship({ viewer: subject, people }),
    relationship: subject.relationship ?? 'owner',
    viewing: access.reason,
    canPay: access.canPay,
    seesProofs: access.proofs,
    occupantName: access.reason === 'landlord' ? (occupant?.name ?? null) : null,
  };

  return {
    flat,
    floor: flatRow?.floor ?? null,
    name: subject.name,
    mobile: subject.mobile,
    email: subject.email,
    role: subject.role,
    mustChangePassword: subject.mustChangePassword,
    bill,
    pay,
    readings: withConsumption(readings.results ?? [], billRow?.conversion_factor ?? DEFAULT_CONVERSION),
    bills: bills.results ?? [],
    tenancy,
  };
}

/**
 * Meters are cumulative, so consumption is the gap to the previous row —
 * converted to kilograms, because the meter counts cubic metres and the bill
 * charges mass. Skipping the conversion here made the reading table disagree
 * with the bill table about the same month, which is exactly how a resident
 * loses trust in the whole thing.
 *
 * The oldest row in the window has no predecessor and reports null rather than
 * pretending its entire meter position was consumed that month.
 */
export function withConsumption(rows, conversionFactor = DEFAULT_CONVERSION) {
  return rows.map((row, i) => {
    const prev = rows[i + 1];
    return {
      period: row.period,          // usage month — what the bill is labelled
      readOn: row.read_on ?? null, // when the meter was read, a month later
      reading: row.reading,
      meterDelta: prev ? Math.round((row.reading - prev.reading) * 1000) / 1000 : null,
      consumption: prev ? computeConsumption(row.reading, prev.reading, conversionFactor) : null,
    };
  });
}
