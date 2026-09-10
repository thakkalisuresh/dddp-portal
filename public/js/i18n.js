/**
 * Formatting for the things a resident reads: money, weight, months, dates.
 *
 * This file used to also hold a bilingual label registry — English with
 * Malayalam alongside — which is gone. The labels were the author's own
 * unreviewed guesses, and half a translation next to the English is worse than
 * none: it looks like a promise the app cannot keep. If Malayalam comes back it
 * comes back as a real toggle with reviewed strings (backlog B1, B2), not as a
 * second word in a span.
 *
 * The registry was never the single source of truth in any case — some thirty
 * keys against the ~58 English sentences hardcoded across the screens — so
 * these strings now live where every other one already did: in the markup.
 */

/**
 * Indian rupee. Bill totals are whole rupees, so '₹329.00' is noise — show
 * paise only where they genuinely exist (a rate, a gas subtotal).
 */
export function money(amount) {
  const n = Number(amount);
  return `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

export function kg(value) {
  return `${Number(value).toFixed(2)} kg`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** '2026-07' -> 'July 2026' */
export function periodLabel(period) {
  const [y, m] = String(period).split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

/**
 * EVERY DATE ON THIS SITE IS THE BUILDING'S OWN DATE.
 *
 * These labels used to read the UTC field off the Date — getUTCDate() — which
 * is right for a date-only string like a due date and wrong for a timestamp.
 * Kerala is UTC+5:30, so a notice posted at 2am IST carries a UTC stamp of the
 * previous evening and was displayed under YESTERDAY'S date. Nobody caught it
 * because notices are usually posted in the afternoon; it would have surfaced
 * the first time a committee member posted late at night and residents were
 * told the AGM notice went up a day before it did.
 *
 * Date-only strings ('2026-08-10') are unaffected: they parse as UTC midnight,
 * and midnight + 5:30 is the same calendar day in IST.
 */
const IST = 'Asia/Kolkata';

const IST_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST,
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: '2-digit', hour12: false,
});

/** { year, month, day, hour, minute } as read in Kerala. */
function istParts(iso) {
  const parts = IST_FORMAT.formatToParts(new Date(iso));
  const out = {};
  for (const p of parts) if (p.type !== 'literal') out[p.type] = Number(p.value);
  // Midnight comes back as hour 24 in some engines under hour12: false.
  if (out.hour === 24) out.hour = 0;
  return out;
}

/** '2026-08-10' -> '10 August' */
export function dayLabel(iso) {
  const { day, month } = istParts(iso);
  return `${day} ${MONTHS[month - 1]}`;
}

/** '2026-08-10T08:45:00Z' -> '2:15 PM' */
export function timeLabel(iso) {
  const { hour, minute } = istParts(iso);
  const suffix = hour < 12 ? 'AM' : 'PM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/**
 * When something was posted, at the precision a reader actually wants.
 *
 * Recent things get the clock, because "did I already see this?" is a question
 * about hours. Older things get the date, because by then the hour is noise.
 * The year appears only once it is not the current one — a noticeboard that
 * stamps '2026' on everything in 2026 is just louder, not clearer.
 */
export function stampLabel(iso, now = new Date()) {
  const then = istParts(iso);
  const today = istParts(now);
  const time = timeLabel(iso);

  if (then.year === today.year && then.month === today.month && then.day === today.day) {
    return `Today, ${time}`;
  }

  // Yesterday in IST, found by stepping the calendar back a day rather than
  // subtracting 24 hours — the two disagree across a DST boundary anywhere
  // that has one, and this helper should not care where it runs.
  const yesterday = istParts(new Date(new Date(now).getTime() - 86_400_000));
  if (then.year === yesterday.year && then.month === yesterday.month && then.day === yesterday.day) {
    return `Yesterday, ${time}`;
  }

  const date = `${then.day} ${MONTHS[then.month - 1]}`;
  return then.year === today.year ? `${date}, ${time}` : `${date} ${then.year}, ${time}`;
}

/* ── deadlines ─────────────────────────────────────────────────────────────
   A DEADLINE IS THE ONE THING ON THIS SITE NOT SHOWN IN THE BUILDING'S CLOCK
   ALONE, and the exception is deliberate rather than an oversight of the rule
   at the top of this file.

   That rule is about DATES. A due date is a calendar square: the 20th is the
   20th, and rendering it in the reader's zone is how an owner in Toronto was
   shown the 19th for a bill the treasurer set to the 20th. A poll's closing
   time is not a square, it is an instant — and an owner abroad who has to
   convert 6:00pm IST in their head is an owner who misses the vote.

   So both are shown, the reader's own clock first, and neither is ever printed
   as a bare unlabelled time. A reader in Kerala sees one time, not the same
   time twice.
   ────────────────────────────────────────────────────────────────────────── */

const VIEWER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const VIEWER_IS_IST = VIEWER_TZ === IST;

const DEADLINE_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST, day: 'numeric', month: 'short',
  hour: 'numeric', minute: '2-digit', hour12: true,
});
const LOCAL_DEADLINE_FMT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
});

/**
 * 'PDT', 'EDT', 'GMT+4' — whatever the reader's zone is actually called.
 *
 * en-US rather than en-GB: en-GB renders 'GMT-7' even for zones that have a
 * name, and 'PDT' is what the reader's own phone says. Zones without a name
 * (Dubai) fall back to an offset either way, which is still better than an
 * unlabelled clock.
 */
function zoneLabel(iso, timeZone) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(new Date(iso)).find((x) => x.type === 'timeZoneName');
  return part?.value ?? '';
}

/** '20 Sept, 5:30 am PDT · 20 Sept, 6:00 pm IST' — or just IST, in Kerala. */
export function deadlineLabel(iso) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';
  const ist = `${DEADLINE_FMT.format(when)} IST`;
  if (VIEWER_IS_IST) return ist;
  return `${LOCAL_DEADLINE_FMT.format(when)} ${zoneLabel(iso, VIEWER_TZ) || 'your time'} · ${ist}`;
}

/**
 * 'Closes in 3 days'. Timezone-free, which is why it leads.
 *
 * Rounded rather than precise: a countdown ticking down to the minute invites
 * somebody to wait for the last one, and a vote is not a bid.
 */
export function closesIn(iso, now = Date.now()) {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'Closed';
  const plural = (n, unit) => `Closes in ${n} ${unit}${n === 1 ? '' : 's'}`;
  const hours = ms / 3_600_000;
  if (hours < 1) return plural(Math.max(1, Math.round(ms / 60_000)), 'minute');
  if (hours < 48) return plural(Math.round(hours), 'hour');
  return plural(Math.round(hours / 24), 'day');
}
