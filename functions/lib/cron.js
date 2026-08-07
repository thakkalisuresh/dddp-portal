/**
 * Scheduled work: late fees, and the nudge for bills stuck claiming payment.
 *
 * The single most important property here is IDEMPOTENCE. This runs nightly,
 * Cloudflare may invoke it more than once, and a treasurer may trigger it by
 * hand. Charging twice would mean 52 wrong bills and a lot of explaining, so
 * `late_fee_at IS NULL` is the guard and there is a test for exactly that.
 */

import { lateFeeDecision, applyLateFee, isWholeRupees } from './billing.js';
import { reportError, fail } from './errors.js';

/**
 * Decide what to do with a month's bills. Pure — the interesting logic is the
 * three-way split, not the writing.
 *
 * `initiated` is HELD rather than charged: someone who tapped Pay on the 9th
 * must not be penalised because the treasurer's approval landed on the 15th
 * (plan §4e).
 */
export function planLateFees(bills, { today, dueDate, graceDays = 0, lateFee }) {
  if (!isWholeRupees(lateFee)) fail('DDP-BILL-008', { lateFee });

  const charge = [];
  const hold = [];
  const skip = [];

  for (const bill of bills) {
    const decision = lateFeeDecision(bill, { today, dueDate, graceDays });
    if (decision.action === 'charge') {
      charge.push({ ...bill, newTotal: applyLateFee(bill.total, lateFee), lateFee });
    } else if (decision.action === 'hold') {
      hold.push({ ...bill, reason: decision.reason });
    } else {
      skip.push({ ...bill, reason: decision.reason });
    }
  }

  return { charge, hold, skip, lateFee, dueDate };
}

export async function applyLateFees(env, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const periods = await env.DB.prepare(
    `SELECT period, due_date, late_fee, late_fee_after
       FROM periods
      WHERE late_fee > 0 AND date(due_date, '+' || late_fee_after || ' day') < ?`
  ).bind(today).all();

  const results = [];

  for (const p of periods.results ?? []) {
    const bills = await env.DB.prepare(
      `SELECT id, flat, status, total, late_fee_at FROM bills WHERE period = ?`
    ).bind(p.period).all();

    const plan = planLateFees(bills.results ?? [], {
      today, dueDate: p.due_date, graceDays: p.late_fee_after, lateFee: p.late_fee,
    });

    if (plan.charge.length) {
      const at = new Date().toISOString();
      await env.DB.batch(plan.charge.map((b) =>
        // The status guard is belt-and-braces alongside late_fee_at: if two
        // runs overlap, the second updates zero rows rather than double-charging.
        env.DB.prepare(
          `UPDATE bills SET late_fee = ?, late_fee_at = ?, total = ?
            WHERE id = ? AND late_fee_at IS NULL`
        ).bind(plan.lateFee, at, b.newTotal, b.id)
      ));
    }

    results.push({
      period: p.period,
      charged: plan.charge.length,
      held: plan.hold.length,
      skipped: plan.skip.length,
    });
  }

  return results;
}

/**
 * Bills where the resident tapped Pay and sent nothing. After 48 hours that is
 * worth surfacing — not as a penalty, but because it is the most likely place
 * a payment has quietly gone unrecorded.
 */
export async function staleIntents(env, { hours = 48 } = {}) {
  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT b.id, b.flat, b.period, b.total, MAX(i.created_at) AS last_intent
       FROM bills b JOIN payment_intents i ON i.bill_id = b.id
      WHERE b.status = 'initiated'
      GROUP BY b.id HAVING last_intent < ?`
  ).bind(cutoff).all();
  return rows.results ?? [];
}

export async function runScheduled(env, ctx) {
  try {
    const fees = await applyLateFees(env);
    const stale = await staleIntents(env);
    const charged = fees.reduce((n, f) => n + f.charged, 0);
    const held = fees.reduce((n, f) => n + f.held, 0);

    if (charged || held || stale.length) {
      await reportError(env, 'DDP-SYS-007', {
        charged, held, staleIntents: stale.length,
      }, ctx);
    }
    return { fees, stale: stale.length };
  } catch (err) {
    await reportError(env, err?.code ?? 'DDP-SYS-003', err, ctx);
    return null;
  }
}
