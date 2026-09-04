/**
 * The resident dashboard payload — one request, one round trip (plan §4b).
 *
 * The subject is passed in from the session. Nothing here accepts a flat from
 * the client; if you are tempted to add that parameter, the caller belongs
 * under /api/admin/ instead.
 */

import { buildUpiLinks, payTargetFor, manualPayment } from './upi.js';
import { computeConsumption, meterDeltaAcrossChange, DEFAULT_CONVERSION } from './billing.js';
import { applyLateFeeToBill } from './cron.js';
import { istToday } from './time.js';
import { billAccess, occupantOf, describeRelationship } from './tenancy.js';
import { unreadNoticeCount } from './notices.js';

const READING_HISTORY = 6;
const BILL_HISTORY = 12;

/**
 * Derived presentation state for a bill. Pure — the interesting cases are
 * "overdue" and "the CTA must disappear once settled", both of which are
 * decisions rather than data.
 */
export function shapeBill(bill, period, today = istToday()) {
  if (!bill) return null;

  const settled = bill.status === 'paid' || bill.status === 'waived';
  const claimed = bill.status === 'initiated' || bill.status === 'awaiting';
  // `>=`, because the fee lands at 00:00 IST ON the due date. A bill that is
  // being charged today must not still read "due today" while the resident is
  // looking at a total that already includes the fee.
  const pastDue = !settled && period?.due_date != null && today >= period.due_date;

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
    // The date the bill was raised. Carried only so the printed slip can
    // state one: a printout stamped with the day it came out of the printer
    // would say something different every time the same bill is printed.
    createdAt: bill.created_at,

    // Display status is not the same as the DB status: an unpaid bill past its
    // due date reads as "overdue" to a resident even though nothing changed.
    displayStatus: settled ? 'paid' : claimed ? bill.status : pastDue ? 'overdue' : 'unpaid',

    // A dead button is worse than no button — the CTA vanishes once settled.
    //
    // It also vanishes on 'awaiting', which is the state a screenshot puts the
    // bill into. That resident has paid and proved it; leaving Pay on screen
    // invites a second transfer for the same bill, and a duplicate credit is
    // far more work for the treasurer than a missing one. 'initiated' is NOT
    // included — tapping Pay only means an app opened, so someone who bounced
    // off their UPI app still needs the button.
    showPayButton: !settled && bill.status !== 'awaiting',
    showUploadLink: !settled,
    settled,

    // Warn before the fee lands, so nobody is surprised by it.
    lateFeeWarning:
      !settled && !bill.late_fee && period?.late_fee > 0 && !pastDue
        ? { amount: period.late_fee, after: period.due_date }
        : null,
  };
}

export async function dashboardPayload(env, subject, userAgent = '', origin = '') {
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

    // meter_changes is joined in because without it the number simply DROPS —
    // 19.145 one month, 0.412 the next — and the resident's only reasonable
    // conclusion is that the portal is broken. The row says what happened.
    // meter_changes is joined in because without it the number simply DROPS —
    // 19.145 one month, 0.412 the next — and the resident's only reasonable
    // conclusion is that the portal is broken. The row says what happened, and
    // the figures are here because the month's consumption cannot be computed
    // without them: subtracting the raw readings across a swap is negative, and
    // computeConsumption would throw on the resident's own dashboard.
    env.DB.prepare(
      `SELECT r.period, r.reading, r.read_on,
              mc.changed_on AS meter_changed_on,
              mc.old_final  AS meter_old_final,
              mc.new_start  AS meter_new_start
         FROM readings r
         LEFT JOIN meter_changes mc ON mc.flat = r.flat AND mc.period = r.period
        WHERE r.flat = ? ORDER BY r.period DESC LIMIT ?`
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

  // The fee is charged the moment it is due, not when the nightly job wakes up.
  // Doing it here — on the read, before the QR below is built — is what stops a
  // resident opening the portal at 00:05 and being handed a pre-fee amount to
  // pay. The write is guarded and idempotent, so this is safe on a GET and safe
  // against the cron running at the same instant.
  if (billRow && !billRow.late_fee_at) {
    const charged = await applyLateFeeToBill(env, billRow.id);
    if (charged.applied) {
      billRow.late_fee = charged.lateFee;
      billRow.total = charged.total;
      billRow.late_fee_at = charged.lateFeeAt;
    }
  }

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
        // Where Chrome goes when the intent resolves to nothing.
        //
        // THE QUERY PARAMETER IS THE WHOLE POINT. This used to be a bare
        // /dashboard#pay-help, which meant a refused handoff navigated to the
        // page the resident was already on: indistinguishable from a reload,
        // and reported as exactly that. Worse, the "no app opened" warning is
        // revealed by a timer after the tap, and the navigation destroys the
        // timer — so the one thing built to explain the failure was the one
        // thing the failure switched off. The flag survives the navigation and
        // the page can say what happened.
        fallbackUrl: origin ? `${origin}/dashboard?upi=blocked#pay-help` : undefined,
      }),
      // Always sent, on every platform. A deep link that does nothing is the
      // commonest failure here — no UPI app on iOS, or Chrome declining the
      // scheme on Android — and without this the resident has nowhere to go.
      manual: manualPayment({
        vpa: env.UPI_VPA, payee: env.UPI_PAYEE, amount: bill.total, flat,
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
    // Carried on /api/me because every screen renders the nav from this payload
    // — the badge has to be available on the dashboard, not only on the notice
    // board it points at.
    unreadNotices: await unreadNoticeCount(env, subject),
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
    const change = row.meter_old_final == null ? null : {
      old_final: row.meter_old_final,
      new_start: row.meter_new_start ?? 0,
    };

    // Guarded rather than trusted. This runs on the RESIDENT's dashboard, and
    // an inconsistent changeover row would otherwise throw here and take the
    // whole page down — the bill, the QR, everything — for a data problem that
    // belongs to the committee. Their month shows a dash instead.
    let consumption = null;
    let meterDelta = null;
    if (prev) {
      try {
        consumption = computeConsumption(row.reading, prev.reading, conversionFactor, change);
        meterDelta = change
          ? meterDeltaAcrossChange(row.reading, prev.reading, change)
          : Math.round((row.reading - prev.reading) * 1000) / 1000;
      } catch {
        consumption = null;
        meterDelta = null;
      }
    }

    return {
      period: row.period,          // usage month — what the bill is labelled
      readOn: row.read_on ?? null, // when the meter was read, a month later
      reading: row.reading,
      // The resident's explanation for a number that just went down.
      meterChangedOn: row.meter_changed_on ?? null,
      meterDelta,
      consumption,
    };
  });
}
