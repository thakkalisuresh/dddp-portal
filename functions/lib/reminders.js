/**
 * Chasing an unpaid bill.
 *
 * The first email this portal has ever sent a resident about money. Everything
 * else it sends is a credential or an alert to an admin, which is why the rules
 * here are stricter than anywhere else in the codebase: a reminder that goes
 * out twice, or a fourth one that should never have existed, is a committee
 * member's neighbour deciding they are being harassed over ₹1,200.
 *
 * The committee's rule, 2026-08-19: three per bill and no more, spaced 24, then
 * 48, then 72 hours. Remind-all runs twice for a month, a day apart, and spends
 * each flat's allowance exactly as an individual click does. ONE BUDGET — see
 * the migration for why separate ones were rejected.
 *
 * The decisions live here rather than in the handler so they can be tested
 * against a clock, and so the console can grey the button using the identical
 * arithmetic instead of a second implementation that drifts.
 */

/** Hours to wait after the 1st, 2nd and 3rd reminder. The third never lifts. */
export const SPACING_HOURS = [24, 48, 72];

/** The ceiling. Three rows can exist for a bill; the schema refuses a fourth. */
export const MAX_REMINDERS = SPACING_HOURS.length;

/** Runs of Remind-all allowed per usage month, and the wait between them. */
export const MAX_BATCHES = 2;
export const BATCH_SPACING_HOURS = 24;

const HOUR_MS = 3_600_000;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function hoursBetween(fromIso, toIso) {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  // NaN, deliberately, so an unreadable timestamp propagates as "cannot tell"
  // rather than as Infinity — which would read as "waited long enough" and let
  // a send through on the strength of a corrupt row.
  if (Number.isNaN(from) || Number.isNaN(to)) return NaN;
  return (to - from) / HOUR_MS;
}

/**
 * Whether this bill can be reminded about now, and which of the three it is.
 *
 * `sentAt` is every reminder already sent for the bill, oldest first. The
 * caller passes the rows; this decides. Returns the reason when it refuses,
 * because the console states why a button is unavailable rather than hiding it
 * — the same choice the approvals screen makes, for the same reason.
 */
export function reminderDecision(sentAt, now) {
  const sent = (sentAt ?? []).filter(Boolean);

  if (sent.length >= MAX_REMINDERS) {
    return { ok: false, reason: 'spent', ordinal: null, hoursLeft: 0 };
  }

  const last = sent[sent.length - 1];
  if (!last) return { ok: true, ordinal: 1, previous: [] };

  const wait = SPACING_HOURS[sent.length - 1];
  const waited = hoursBetween(last, now);
  if (!Number.isFinite(waited)) {
    return { ok: false, reason: 'unclear', ordinal: null, hoursLeft: null };
  }
  if (waited < wait) {
    return {
      ok: false,
      reason: 'cooling',
      ordinal: null,
      // Rounded up: "wait 1 more hour" that turns out to be 90 minutes is the
      // kind of small lie that makes somebody press the button again.
      hoursLeft: Math.max(1, Math.ceil(wait - waited)),
    };
  }
  return { ok: true, ordinal: sent.length + 1, previous: sent };
}

/**
 * Whether Remind-all may run for this month.
 *
 * Batches are counted even when they sent nothing: a run that skipped every
 * flat has still used one of the two, and the alternative is a button that
 * quietly resets itself by failing.
 */
export function batchDecision(batchSentAt, now) {
  const runs = (batchSentAt ?? []).filter(Boolean);
  if (runs.length >= MAX_BATCHES) return { ok: false, reason: 'spent', hoursLeft: 0 };

  const last = runs[runs.length - 1];
  if (!last) return { ok: true, run: 1 };

  const waited = hoursBetween(last, now);
  if (!Number.isFinite(waited)) return { ok: false, reason: 'unclear', hoursLeft: null };
  if (waited < BATCH_SPACING_HOURS) {
    return {
      ok: false,
      reason: 'cooling',
      hoursLeft: Math.max(1, Math.ceil(BATCH_SPACING_HOURS - waited)),
    };
  }
  return { ok: true, run: runs.length + 1 };
}

/** '2026-08' -> 'August 2026'. The client has its own; the Worker writes emails. */
export function periodLabel(period) {
  const [year, month] = String(period).split('-');
  return `${MONTHS[Number(month) - 1] ?? period} ${year}`;
}

/** '2026-09-20T04:31:00.000Z' -> '20 September' */
export function dayAndMonth(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** '20, 22 and 25 September' where they share a month, '20 August, 2 September' where they do not. */
export function listDates(isoList) {
  const parts = (isoList ?? []).map(dayAndMonth).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? '';
  const months = new Set(parts.map((p) => p.split(' ')[1]));
  const shown = months.size === 1
    ? parts.map((p, i) => (i === parts.length - 1 ? p : p.split(' ')[0]))
    : parts;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

const money = (n) => `₹${Number(n).toLocaleString('en-IN', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
})}`;

const SITE = 'https://diamondpark.pages.dev';
const SIGNATURE = "DD Diamond Park Residents' Welfare Association";

/**
 * The three letters.
 *
 * Escalation is carried by stating the count, not by sharpening the tone: the
 * committee is asking a neighbour for money it is owed, and the resident will
 * meet whoever sent this in the lift. Earlier drafts closed with lines like "it
 * is a conversation the committee would rather have than not", which perform
 * warmth without telling anybody anything; they are gone. So is the sentence
 * promising that someone would follow up in person, which nothing in the portal
 * makes true.
 *
 * Plain text only, matching resetEmail and approvalMessage — buildRawMessage
 * writes a single text/plain part, and nothing this association sends has ever
 * carried a button.
 */
export function reminderEmail({
  ordinal, name, flat, period, periodLabel, total, dueDate, daysOver, previous = [],
}) {
  const hello = `Hello${name ? ` ${name}` : ''},`;
  const lines = [hello, ''];

  if (ordinal === 2) {
    lines.push(`This is the second reminder. The first was sent on ${dayAndMonth(previous[0])}.`, '');
    lines.push(`The gas bill for flat ${flat} for ${periodLabel} is still unpaid.`);
  } else if (ordinal === 3) {
    lines.push('This is the last reminder.', '');
    lines.push(`The gas bill for flat ${flat} for ${periodLabel} is unpaid, `
      + `${daysOver} days after it was due.`);
  } else {
    lines.push(`The gas bill for flat ${flat} for ${periodLabel} has not been paid.`);
  }

  lines.push('', `    ${money(total)}`, '');

  if (ordinal === 1) {
    lines.push(`It was due on ${dayAndMonth(dueDate)}.`);
  } else if (ordinal === 2) {
    lines.push(`It was due on ${dayAndMonth(dueDate)}, ${daysOver} days ago.`);
  } else {
    lines.push(`Reminders were sent on ${listDates([...previous])}.`);
  }

  lines.push('', `Pay at ${SITE}`, '');

  if (ordinal === 1) {
    lines.push('Pay the exact amount, including the paise. The paise are how the',
      'payment is matched to your flat.', '',
      'If you have already paid, upload the screenshot on the portal.');
  } else if (ordinal === 2) {
    lines.push('If the bill is wrong, reply to this email or send a message from the',
      'portal. A correction can be raised.');
  } else {
    lines.push('If the bill is wrong, or paying it is a difficulty, tell the committee.');
  }

  lines.push('', SIGNATURE);

  const subject = ordinal === 1
    ? `Diamond Park — gas bill for ${periodLabel} is unpaid`
    : ordinal === 2
      ? `Diamond Park — second reminder, gas bill for ${periodLabel}`
      : `Diamond Park — final reminder, gas bill for ${periodLabel}`;

  return { subject, text: lines.join('\n') };
}
