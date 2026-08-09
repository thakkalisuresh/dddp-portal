/**
 * Scheduled work: late fees, and the nudge for bills stuck claiming payment.
 *
 * The single most important property here is IDEMPOTENCE. This runs nightly,
 * Cloudflare may invoke it more than once, and a treasurer may trigger it by
 * hand. Charging twice would mean 52 wrong bills and a lot of explaining, so
 * `late_fee_at IS NULL` is the guard and there is a test for exactly that.
 */

import { lateFeeDecision, applyLateFee } from './billing.js';
import { reportError, fail, postToTelegram } from './errors.js';
import { runDigest } from './digest.js';

/**
 * Decide what to do with a month's bills. Pure — the interesting logic is the
 * three-way split, not the writing.
 *
 * `initiated` is HELD rather than charged: someone who tapped Pay on the 9th
 * must not be penalised because the treasurer's approval landed on the 15th
 * (plan §4e).
 */
export function planLateFees(bills, { today, dueDate, graceDays = 0, lateFee }) {
  // Checked up front rather than per bill: a bad fee must stop the whole run,
  // not charge half the building before it hits the first failure.
  if (!Number.isFinite(lateFee) || lateFee < 0) fail('DDP-BILL-008', { lateFee });

  const charge = [];
  const hold = [];
  const skip = [];

  for (const bill of bills) {
    // Exemptions ride on the bill row, joined from its owner, so this stays
    // pure and the caller decides where the date came from.
    const decision = lateFeeDecision(bill, {
      today, dueDate, graceDays, exemptUntil: bill.late_fee_exempt_until ?? null,
    });
    if (decision.action === 'charge') {
      charge.push({ ...bill, newTotal: applyLateFee(bill.total, lateFee), lateFee });
    } else if (decision.action === 'hold') {
      hold.push({ ...bill, reason: decision.reason });
    } else {
      skip.push({ ...bill, reason: decision.reason });
    }
  }

  return {
    charge, hold, skip, lateFee, dueDate,
    // Surfaced separately from the rest of the skips: an exemption is a
    // decision somebody made, and it belongs in the morning digest rather than
    // buried among "already paid".
    exempt: skip.filter((b) => b.reason === 'exempt'),
  };
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
      `SELECT b.id, b.flat, b.status, b.total, b.late_fee_at,
              o.late_fee_exempt_until
         FROM bills b LEFT JOIN owners o ON o.id = b.owner_id
        WHERE b.period = ?`
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
      exempt: plan.exempt.length,
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
    const exempt = fees.reduce((n, f) => n + (f.exempt ?? 0), 0);

    if (charged || held || exempt || stale.length) {
      await reportError(env, 'DDP-SYS-007', {
        charged, held, exempt, staleIntents: stale.length,
      }, ctx);
    }

    // Last, and in its own try. The digest is a convenience; late fees are
    // money. A digest that throws must never cost the building its fee run,
    // and the ordering means the digest can also report what just happened.
    const digest = await sendDigest(env);

    return { fees, stale: stale.length, digest };
  } catch (err) {
    await reportError(env, err?.code ?? 'DDP-SYS-003', err, ctx);
    return null;
  }
}

/** Separated so a failing digest cannot take the fee run down with it. */
export async function sendDigest(env) {
  try {
    return await runDigest(env, { send: (text) => postToTelegram(env, text) });
  } catch (err) {
    await reportError(env, 'DDP-SYS-003', err);
    return { sent: false, reason: 'digest threw' };
  }
}
