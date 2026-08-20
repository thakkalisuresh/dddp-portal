/**
 * Scheduled work: late fees, and the nudge for bills stuck claiming payment.
 *
 * The single most important property here is IDEMPOTENCE. This runs nightly,
 * Cloudflare may invoke it more than once, and a treasurer may trigger it by
 * hand. Charging twice would mean 99 wrong bills and a lot of explaining, so
 * `late_fee_at IS NULL` is the guard and there is a test for exactly that.
 */

import { lateFeeDecision, applyLateFee } from './billing.js';
import { sweepAnnouncements } from './announce.js';
import { reportError, fail, postToTelegram } from './errors.js';
import { runDigest } from './digest.js';
import { istToday } from './time.js';

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

export async function applyLateFees(env, { today = istToday() } = {}) {
  const periods = await env.DB.prepare(
    // `<=`, matching lateFeeDecision: the fee is due ON the due date. The date
    // itself is an IST date — see istToday — because this job now runs at 18:30
    // UTC, where the UTC date is still yesterday in Kerala.
    `SELECT period, due_date, late_fee, late_fee_after
       FROM periods
      WHERE late_fee > 0 AND date(due_date, '+' || late_fee_after || ' day') <= ?`
  ).bind(today).all();

  const results = [];

  for (const p of periods.results ?? []) {
    const bills = await env.DB.prepare(
      // claimed_at is not optional here: lateFeeDecision measures the hold on
      // an `initiated` bill from it, and a column left out of this SELECT
      // arrives as undefined, reads as "no claim", and charges every held bill
      // on the first run. Unit tests would not catch it — they hand the
      // decision a bill object directly and never go through this query.
      // pending_edit rides along for the same reason claimed_at does: a column
      // left out of this SELECT arrives as undefined, reads as "no pending
      // edit", and charges the bill anyway. Unit tests would not catch it —
      // they hand the decision a bill object directly.
      `SELECT b.id, b.flat, b.status, b.total, b.late_fee_at, b.claimed_at,
              o.late_fee_exempt_until,
              EXISTS (SELECT 1 FROM bill_edit_requests r
                       WHERE r.bill_id = b.id AND r.status = 'pending') AS pending_edit
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
 * Apply the fee to ONE bill, right now, if it is due one.
 *
 * WHY THIS EXISTS ALONGSIDE THE NIGHTLY RUN. The committee's rule is that the
 * fee lands at 00:00 IST, exactly. Cloudflare cron triggers are scheduled, not
 * punctual — they can drift by minutes — so a job alone delivers "midnight,
 * roughly", and the gap is not academic: the UPI QR is built from bill.total,
 * so a resident paying at 00:05 would be handed a pre-fee amount, pay it, and
 * land in the reconciliation queue owing ₹50 nobody asked them for.
 *
 * So the fee is applied on first touch after midnight — a dashboard load, a
 * tap on Pay — and the nightly run becomes the backstop for bills nobody
 * opened. `late_fee_at IS NULL` in the UPDATE means the two can race freely;
 * whichever arrives first wins and the second updates nothing.
 *
 * Returns the fields that changed so the caller can patch the row it already
 * holds, rather than paying for a second read on a page load.
 */
export async function applyLateFeeToBill(env, billId, { today = istToday() } = {}) {
  const bill = await env.DB.prepare(
    `SELECT b.id, b.status, b.total, b.late_fee, b.late_fee_at, b.claimed_at,
            p.due_date, p.late_fee AS period_late_fee, p.late_fee_after,
            o.late_fee_exempt_until,
            EXISTS (SELECT 1 FROM bill_edit_requests r
                     WHERE r.bill_id = b.id AND r.status = 'pending') AS pending_edit
       FROM bills b
       JOIN periods p ON p.period = b.period
       LEFT JOIN owners o ON o.id = b.owner_id
      WHERE b.id = ?`
  ).bind(billId).first();

  if (!bill || !(Number(bill.period_late_fee) > 0)) return { applied: false };

  const decision = lateFeeDecision(bill, {
    today,
    dueDate: bill.due_date,
    graceDays: bill.late_fee_after,
    exemptUntil: bill.late_fee_exempt_until ?? null,
  });
  if (decision.action !== 'charge') return { applied: false, reason: decision.reason };

  const lateFee = bill.period_late_fee;
  const total = applyLateFee(bill.total, lateFee);
  const at = new Date().toISOString();

  const res = await env.DB.prepare(
    `UPDATE bills SET late_fee = ?, late_fee_at = ?, total = ?
      WHERE id = ? AND late_fee_at IS NULL`
  ).bind(lateFee, at, total, billId).run();

  // meta.changes is 0 when the nightly run got there first. Reporting `applied`
  // off the decision instead would tell the caller to display a fee it did not
  // write, and on a page load that is the number a resident is about to pay.
  if (!res?.meta?.changes) return { applied: false, reason: 'raced' };

  return { applied: true, lateFee, total, lateFeeAt: at };
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

/**
 * 00:00 IST. Must match wrangler.toml, and deploy-config.test.js checks that it
 * does — a trigger that fires work nobody dispatches is a silent no-op, and the
 * only symptom would be fees quietly landing eight hours late again.
 */
export const LATE_FEE_CRON = '30 18 * * *';

export function isLateFeeCron(cron) {
  return cron === LATE_FEE_CRON;
}

/**
 * The midnight run: fees, and nothing else.
 *
 * Deliberately not runScheduled. The digest, the prune and the statement sweep
 * stay at 08:30 — waking a treasurer's phone at midnight is how a notification
 * gets muted, and the digest is the only thing that reports the warnings.
 */
export async function runLateFees(env, ctx) {
  try {
    const fees = await applyLateFees(env);
    const charged = fees.reduce((n, f) => n + f.charged, 0);
    const exempt = fees.reduce((n, f) => n + (f.exempt ?? 0), 0);
    // Recorded rather than pushed. The morning digest is where a human reads
    // it; this only has to exist for the day somebody asks what happened at
    // midnight.
    if (charged || exempt) {
      await reportError(env, 'DDP-SYS-007', { charged, exempt, at: 'midnight-ist' }, ctx);
    }
    return { fees, charged };
  } catch (err) {
    await reportError(env, err?.code ?? 'DDP-SYS-003', err, ctx);
    return null;
  }
}

/**
 * The dead man's switch.
 *
 * EVERY OTHER SIGNAL IN THIS SYSTEM DEPENDS ON THE SYSTEM WORKING. Telegram
 * needs the Worker to run and the token to be valid; the digest needs the cron
 * to fire; error_log needs D1. When the thing that reports is the thing that
 * broke, all of them report nothing, and nothing is indistinguishable from a
 * quiet week — which is precisely how vision stayed dead through an entire
 * rehearsal.
 *
 * This inverts it. An external monitor expects a ping on a schedule and shouts
 * when one does not arrive, so the alert is raised by the absence of the
 * portal rather than by the portal. It is the only check here that survives
 * the portal being entirely down.
 *
 * Unconfigured is not an error: HEALTHCHECK_URL simply may not be set up yet,
 * and npm run doctor is where that belongs. Failure to ping is swallowed for
 * the same reason the sweeps are — a monitoring call must never cost the
 * building its late-fee run.
 */
async function pingHealthcheck(env) {
  if (!env.HEALTHCHECK_URL) return { pinged: false, reason: 'not-configured' };
  try {
    const res = await fetch(env.HEALTHCHECK_URL, { method: 'POST' });
    return { pinged: res.ok };
  } catch {
    return { pinged: false, reason: 'unreachable' };
  }
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

    // The bills the treasurer published and did not finish telling anyone
    // about. Same drain the console runs, same idempotency — a `sent` row is
    // never selected, so the laptop closing mid-drain costs nothing and this
    // cannot mail anybody twice.
    //
    // AFTER the fee run and before the digest, so the digest can report it,
    // and swallowing its failures for the same reason the digest's are
    // swallowed: telling somebody about a bill must never cost the building
    // its late-fee run.
    // No origin to pass: there is no request behind a cron run, and
    // announcementEmail falls back to the portal's own address for exactly
    // this caller.
    const announced = await sweepAnnouncements(env).catch(() => []);

    // Last, and in its own try. The digest is a convenience; late fees are
    // money. A digest that throws must never cost the building its fee run,
    // and the ordering means the digest can also report what just happened.
    const digest = await sendDigest(env);

    // After the work, so a ping only goes out on a run that actually did it.
    // Pinging first would tell the monitor the portal is healthy and then throw,
    // which is the reassurance-without-the-substance failure the backup
    // watermark is also written to avoid.
    const healthcheck = await pingHealthcheck(env);

    return { fees, stale: stale.length, announced, digest, healthcheck };
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
