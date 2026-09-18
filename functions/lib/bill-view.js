/**
 * One bill, and the screen that pays it — step 5.
 *
 * TWO SCREENS, ONE ACCESS RULE. The detail screen and the payment sheet both
 * resolve a bill for a resident, and they do it through this module rather than
 * each fetching their own. Bill visibility is the part of this application that
 * has already had a privacy bug, and the way that happens is two handlers
 * answering the same question in two places until one of them is changed.
 *
 * THE KIND IS DERIVED, NEVER TRUSTED. The URL carries a bill id and nothing
 * else. A `kind` in the query string would make a mismatched pair — a
 * maintenance id labelled gas — into a thing somebody has to remember to check,
 * and forgetting it is exactly the shape of the old bug. Here the record says
 * what it is.
 */

import { istToday } from './time.js';
import { billAccess, householdIds, occupantOf } from './tenancy.js';
import { shapeBill } from './dashboard.js';
import { shapeMaintBill, asGasCard } from './maint-home.js';
import {
  buildUpiLinks, buildMaintUpiLinks, manualPayment, manualMaintPayment,
  maintPayeeMode, maintNote, payTargetFor,
} from './upi.js';
import { applyLateFeeToBill } from './cron.js';
import { applyLateFeeToMaintBill } from './maint-cron.js';
import { describeQuarter } from './maint.js';

/**
 * Apps that can pay a BANK ACCOUNT rather than a UPI ID.
 *
 * PhonePe and Paytm refuse `<account>@<IFSC>.ifsc.npci` addresses outright.
 * Offering them anyway would put two dead buttons on the sheet, and a resident
 * whose payment app "does not work" blames the portal — so in account mode the
 * list is these two and the sheet says why the others are missing.
 */
export const ACCOUNT_MODE_APPS = ['gpay', 'bhim'];

/**
 * May this viewer pay this bill?
 *
 * `billAccess().canPay` is FALSE for a landlord, and that is the shipped gas
 * rule rather than an oversight: "the bill is the tenant's to settle, and two
 * people paying one bill is a reconciliation problem nobody wants."
 *
 * MAINTENANCE IS DIFFERENT, and narrowly so. The owner is liable for their
 * flat's maintenance in a way they are not for their tenant's gas, the charge
 * is against the flat, and an unpaid quarter costs the OWNER their vote — so an
 * owner who wants to clear it must be able to. That does not generalise to gas,
 * and this function exists precisely so it cannot: the gas answer is untouched,
 * and nothing already in production changes.
 *
 * Provisional pending the design session's ruling; if it comes back as "both
 * kinds", this collapses into billAccess() and the comment above goes with it.
 */
export function canPayBill(access, kind) {
  if (access.canPay) return true;
  return kind === 'maintenance' && access.reason === 'landlord';
}

/** Every app, for the day the association has a UPI ID of its own. */
export const UPI_MODE_APPS = ['gpay', 'phonepe', 'paytm', 'bhim'];

/**
 * Where a resident may be sent back to after paying.
 *
 * AN ALLOWLIST, NOT A SANITISER. `from` arrives off the query string, and the
 * one rule that cannot be got wrong by accident is that an unrecognised value
 * goes to Home rather than anywhere it asked for. Poll ids are matched by
 * shape so a real ballot can be returned to without listing every poll.
 */
export function resolveReturn(from) {
  const value = String(from ?? '');
  if (value === '/dashboard' || value === '/') return '/dashboard';
  if (/^\/polls(#poll-\d+)?$/.test(value)) return value;
  if (/^\/bill\?id=\d+$/.test(value)) return value;
  return '/dashboard';
}

/**
 * Resolve a bill for this viewer, whichever kind it is.
 *
 * Looks in `bills` first and `maint_bills` second. The ids are separate
 * sequences and can collide, so the kind is settled by which table the ROW came
 * from and the lookup is ordered rather than merged — a union that matched both
 * would have to break the tie, and any tie-break here is a way to serve the
 * wrong bill.
 *
 * Returns null when the bill does not exist OR this viewer may not read it, and
 * deliberately does not distinguish the two: "no such bill" and "not yours"
 * must look identical from outside, or the 404 becomes a way to enumerate which
 * flats owe what.
 */
export async function resolveBill(env, subject, id, { today = istToday() } = {}) {
  const billId = Number(id);
  if (!Number.isInteger(billId) || billId <= 0) return null;

  const household = await env.DB.prepare(
    'SELECT id, name, flat, relationship, active FROM owners WHERE flat = ?'
  ).bind(subject.flat).all();
  const people = household.results ?? [];

  const access = billAccess({ viewer: subject, people });
  const occupant = occupantOf(people);
  const billsOf = access.reason === 'landlord' && occupant
    ? householdIds(people, occupant)
    : householdIds(people, subject);
  // An empty list would match every bill. A viewer the rules place outside both
  // households gets an id that cannot exist, never an unrestricted query.
  const readers = billsOf.length ? billsOf : [0];
  const holders = readers.map(() => '?').join(', ');

  const gas = await env.DB.prepare(
    `SELECT b.*, p.due_date, p.late_fee AS period_late_fee, p.status AS period_status
       FROM bills b JOIN periods p ON p.period = b.period
      WHERE b.id = ? AND b.flat = ? AND (b.owner_id IS NULL OR b.owner_id IN (${holders}))`
  ).bind(billId, subject.flat, ...readers).first();

  if (gas) {
    // The fee is charged on the read, before any amount is shown or any pay
    // link built, for the reason lib/dashboard.js states: a resident opening
    // the portal at 00:05 must not be handed a pre-fee amount to pay. The write
    // is guarded and idempotent.
    if (!gas.late_fee_at) {
      const charged = await applyLateFeeToBill(env, gas.id);
      if (charged.applied) {
        gas.late_fee = charged.lateFee;
        gas.total = charged.total;
        gas.late_fee_at = charged.lateFeeAt;
      }
    }
    const shaped = asGasCard(shapeBill(gas, {
      due_date: gas.due_date, late_fee: gas.period_late_fee, status: gas.period_status,
    }, today));
    return { kind: 'gas', row: gas, card: shaped, access, people, occupant };
  }

  const maint = await env.DB.prepare(
    `SELECT b.*, q.due_date AS quarter_due, q.late_fee AS quarter_late_fee,
            EXISTS (SELECT 1 FROM maint_approval_requests r
                     WHERE r.bill_id = b.id AND r.status = 'pending') AS pending_approval
       FROM maint_bills b
       JOIN maint_quarters q ON q.quarter = b.quarter
      WHERE b.id = ? AND b.flat = ? AND b.owner_id IN (${holders})`
  ).bind(billId, subject.flat, ...readers).first();

  if (!maint) return null;

  if (!maint.late_fee_at) {
    const charged = await applyLateFeeToMaintBill(env, maint.id, { today });
    if (charged?.applied) {
      maint.late_fee = charged.lateFee;
      maint.total = charged.total;
      maint.late_fee_at = charged.lateFeeAt;
    }
  }

  const card = shapeMaintBill(maint, {
    due_date: maint.quarter_due, late_fee: maint.quarter_late_fee,
  }, today);
  return { kind: 'maintenance', row: maint, card, access, people, occupant };
}

/**
 * The detail screen's payload.
 *
 * ONE SCREEN FOR BOTH KINDS. The gas-specific parts — consumption, kilograms,
 * rate per kg, the chart — are ABSENT for a maintenance bill rather than sent
 * as zeroes. A zero is a measurement; absent is the truth, and a maintenance
 * bill that reported 0.000 kg would be a number somebody eventually tries to
 * explain.
 */
export async function billDetailPayload(env, subject, id, { today = istToday() } = {}) {
  // NULL, not an error. "No such bill" and "not your bill" must be
  // indistinguishable from outside, or a 404 becomes a way to enumerate which
  // flats owe what. The route turns this into one 404 for both.
  const found = await resolveBill(env, subject, id, { today });
  if (!found) return null;

  const { kind, row, card, access, occupant } = found;

  const base = {
    kind,
    bill: card,
    flat: subject.flat,
    // A landlord is reading their TENANT's bill. An amount with no name against
    // it looks like a demand for money you owe.
    viewing: access.reason,
    occupantName: access.reason === 'landlord' ? (occupant?.name ?? null) : null,
    // Liable, but it is the tenant's bill to settle: two people paying one bill
    // is a reconciliation problem nobody wants. The button is theirs only when
    // the rules say so.
    canPay: canPayBill(access, kind) && card.showPayButton,
    seesProofs: access.proofs,
  };

  if (kind === 'gas') {
    return {
      ...base,
      gas: {
        consumption: row.consumption,
        ratePerKg: row.rate_per_kg,
        gasAmount: row.gas_amount,
        otherCharges: row.other_charges,
        additionalCharges: row.additional_charges,
        conversionFactor: row.conversion_factor ?? null,
      },
    };
  }

  return {
    ...base,
    maintenance: {
      // The full form here, where there is room for it. The card says "Q4 2026"
      // and this says "Q4 2026 (Oct–Dec)" — built from the label, never stored,
      // so a quarter cannot end up described two ways on two screens.
      quarterLabel: describeQuarter(row.quarter),
      basis: row.basis,
      rateApplied: row.rate_applied,
      // Why this flat was billed at the rented rate, in the one place a
      // resident can ask. A ₹9,000 bill where a neighbour paid ₹7,500 is the
      // commonest maintenance question there is.
      reassignedAt: row.reassigned_at ?? null,
      adjustReason: row.adjust_reason ?? null,
    },
  };
}

/**
 * The payment sheet's payload.
 *
 * Its own route rather than a bottom sheet, because a poll's Pay button links
 * into it and comes back, and a sheet can be neither linked to nor returned
 * from.
 */
export async function paySheetPayload(env, subject, id, {
  userAgent = '', origin = '', from = '', today = istToday(),
} = {}) {
  const found = await resolveBill(env, subject, id, { today });
  if (!found) return null;

  const { kind, row, card, access } = found;

  const back = resolveReturn(from);

  // A settled bill has no sheet. Sending someone to a payment screen for a bill
  // they have already paid is how duplicate transfers happen, and a duplicate
  // credit is far more work for the treasurer than a missing one.
  if (!card.showPayButton || !canPayBill(access, kind)) {
    return { payable: false, kind, bill: card, flat: subject.flat, back };
  }

  const fallbackUrl = origin
    ? `${origin}/pay?bill=${encodeURIComponent(row.id)}&upi=blocked#pay-help`
    : undefined;

  if (kind === 'gas') {
    return {
      payable: true,
      kind,
      bill: card,
      flat: subject.flat,
      back,
      target: payTargetFor(userAgent),
      mode: 'upi',
      apps: UPI_MODE_APPS,
      links: buildUpiLinks({
        vpa: env.UPI_VPA, payee: env.UPI_PAYEE, amount: card.total,
        flat: subject.flat, period: row.period, fallbackUrl,
      }),
      manual: manualPayment({
        vpa: env.UPI_VPA, payee: env.UPI_PAYEE, amount: card.total, flat: subject.flat,
      }),
    };
  }

  const mode = maintPayeeMode(env);
  const links = buildMaintUpiLinks({
    env, amount: card.total, flat: subject.flat, quarter: row.quarter, fallbackUrl,
  });

  return {
    payable: true,
    kind,
    bill: card,
    flat: subject.flat,
    back,
    target: payTargetFor(userAgent),
    mode,
    // In account mode two of the four apps refuse the address outright. The
    // sheet shows the two that work and says why, which is the difference
    // between a short list and a broken one.
    apps: mode === 'account' ? ACCOUNT_MODE_APPS : UPI_MODE_APPS,
    links,
    manual: manualMaintPayment({
      env, amount: card.total, flat: subject.flat, quarter: row.quarter,
    }),
    // The note is the load-bearing part of this screen. Maintenance amounts are
    // identical across flats of the same kind, so the unique-paise fingerprint
    // gas relies on does not exist here — this string and the flat are the only
    // two things reconciliation has.
    note: maintNote(subject.flat, row.quarter) ?? null,
    quarterLabel: describeQuarter(row.quarter),
  };
}
