/**
 * What the admin console's Home screen says about the month.
 *
 * Home used to be the export panel — a job done twice a year — so the screen an
 * admin landed on told them nothing about the month they had come to work on.
 * Everything that actually needed a person (a proof to check, a correction
 * waiting on a second admin, a resident's message) was invisible until somebody
 * remembered to open the section it hid in.
 *
 * The stage is computed here rather than in the browser because it is the one
 * part of the board with rules in it: which month is late, whether readings can
 * be entered at all, whether "all paid" means settled or means no bills exist
 * yet. The wording lives in admin-console.js; this file decides only WHICH
 * thing is true.
 */

import { previousPeriod } from './admin.js';

/**
 * The most recent usage month that has finished.
 *
 * The meter closing a month is read early in the FOLLOWING month, so on any day
 * in August the month waiting to be billed is July. Getting this wrong in the
 * other direction is the dangerous one: it would have the board demanding a
 * rate for a month that is still running, and an admin who obliges opens a
 * period whose readings cannot exist yet.
 */
export function latestEndedPeriod(today) {
  return previousPeriod(String(today).slice(0, 7));
}

/**
 * Where the month stands, as one of five words.
 *
 * The order is the month as it actually happens, and each stage is defined by
 * what CANNOT be done yet rather than by what was last done — which is why
 * `no-period` beats every other test. saveReadings fails outright on a period
 * that does not exist, so a board that showed "readings outstanding" for an
 * unopened month would be pointing at a screen that refuses the work.
 *
 *   no-period  the ended month has no rate; nothing else can start
 *   readings   open, meters not all in
 *   ready      every meter in, bills not generated
 *   billed     bills out, money still owed
 *   settled    bills out, nothing owed
 *
 * `settled` lasts only until the next month ends, at which point `no-period`
 * takes over and asks for the new rate — so the quiet state and the blocked
 * state are never both true, and the screen never has to choose between them.
 */
export function boardStage({ period, latestEnded, readings, bills }) {
  if (!period || period.period < latestEnded) return 'no-period';

  const outstanding = (bills.unpaid ?? 0) + (bills.initiated ?? 0) + (bills.awaiting ?? 0);
  const total = outstanding + (bills.paid ?? 0) + (bills.waived ?? 0);

  if (total === 0) {
    return (readings.saved ?? 0) < (readings.expected ?? 0) ? 'readings' : 'ready';
  }
  if (outstanding > 0) return 'billed';

  // Settled, but only until the next month ends — at which point `no-period`
  // takes over above and asks for the new rate.
  return 'settled';
}

/**
 * How many days late a bill is, counted in whole days.
 *
 * Zero on the due date itself: a bill due on the 10th is not late ON the 10th,
 * and telling a resident they are one day overdue when they are not is the kind
 * of error that costs the committee more than the fee is worth.
 */
export function daysOverdue(dueDate, today) {
  if (!dueDate || !today) return 0;
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(now)) return 0;
  return Math.max(0, Math.round((now - due) / 86_400_000));
}

/**
 * Turn the rows of `SELECT status, COUNT(*) GROUP BY status` into an object
 * with every status present.
 *
 * Missing keys are the bug this prevents: a month where nobody has paid has no
 * 'paid' row at all, and `counts.paid` reading undefined turns every arithmetic
 * on it into NaN — which renders as a blank where a number belongs.
 */
export function tallyByStatus(rows) {
  const out = { unpaid: 0, initiated: 0, awaiting: 0, paid: 0, waived: 0 };
  for (const row of rows ?? []) {
    if (row?.status in out) out[row.status] = Number(row.n ?? row.count ?? 0);
  }
  return out;
}
