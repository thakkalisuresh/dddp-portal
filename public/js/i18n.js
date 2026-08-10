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

/** '2026-08-10' -> '10 August' */
export function dayLabel(iso) {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
