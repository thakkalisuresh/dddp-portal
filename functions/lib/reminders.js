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

import { renderEmail, para, figure, action, aside, SITE } from './email-template.js';

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
 * Described as blocks and rendered by renderEmail(), so the resident gets the
 * amount as a figure and the portal as a button where their client draws HTML,
 * and a readable plain-text letter where it does not. BOTH bodies come from
 * this one description: written by hand twice, the two drift, and the one a
 * resident happens to read decides what they were told they owe.
 *
 * The sign-off is the template's. Nothing here appends the association's name
 * — a letter that says it twice was the bug the bill announcement shipped with.
 */
export function reminderEmail({
  ordinal, name, flat, period, periodLabel, total, dueDate, daysOver, previous = [],
}) {
  const blocks = [para(`Hello${name ? ` ${name}` : ''},`)];

  // No "this is the second/last reminder" opener. The subject already says
  // which one this is, and the figure's caption carries the count — a letter
  // that announces its own ordinal before saying what it is about reads as
  // process rather than as a message to a neighbour.
  if (ordinal === 2) {
    blocks.push(para(`The gas bill for flat ${flat} for ${periodLabel} is still unpaid.`));
  } else if (ordinal === 3) {
    blocks.push(para(`The gas bill for flat ${flat} for ${periodLabel} is unpaid, `
      + `${daysOver} days after it was due.`));
  } else {
    blocks.push(para(`The gas bill for flat ${flat} for ${periodLabel} has not been paid.`));
  }

  // The line that used to follow the amount, now the figure's caption — same
  // sentence, same place in the letter, and on the third it is the dates
  // rather than the due date, because by then the count is the point.
  blocks.push(figure(money(total),
    ordinal === 1 ? `It was due on ${dayAndMonth(dueDate)}.`
      : ordinal === 2 ? `It was due on ${dayAndMonth(dueDate)}, ${daysOver} days ago.`
        : `Reminders were sent on ${listDates([...previous])}.`));

  // A button here and a bare URL in the text body, both to the portal itself.
  // No `upi://` and no amount in the link, matching the announcement: an
  // unsolicited message carrying a payment link is the shape of a fraud.
  blocks.push(action('Pay on the portal', SITE));

  // NO PAISE SENTENCE. It used to stand here telling the resident to pay the
  // exact amount "including the paise, the paise are how the payment is
  // matched to your flat" — which stopped being true when the paise tag was
  // retired. Bill totals are whole rupees (toWholeRupees in billing.js, and a
  // CHECK on both `periods` and `bills`), so the amount always ends .00 and
  // the care it asked for matched nothing. An instruction a resident cannot
  // follow correctly teaches them the rest of the letter is decorative too.
  if (ordinal === 1) {
    blocks.push(aside('If you have already paid, please upload the screenshot on the portal.'));
  } else if (ordinal === 2) {
    blocks.push(aside('If the bill is wrong, please reach out to the committee.'));
  } else {
    blocks.push(aside('If the bill is wrong, reach out to the committee.'));
  }

  // `title` is the subject and the headline both, which is why it is written
  // to read as either. The count leads on the second and third: it is what
  // the resident needs from the inbox list without opening anything.
  const title = ordinal === 1
    ? `Gas bill for ${periodLabel} is unpaid`
    : ordinal === 2
      ? `Second reminder, gas bill for ${periodLabel}`
      : `Final reminder, gas bill for ${periodLabel}`;

  return renderEmail({
    title,
    preview: `${money(total)} for flat ${flat}, unpaid.`,
    blocks,
  });
}
