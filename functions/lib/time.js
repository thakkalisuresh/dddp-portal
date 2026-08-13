/**
 * The building's clock.
 *
 * Every date the portal reasons about is a KERALA date. Cloudflare runs in UTC
 * and `new Date().toISOString()` is a UTC date, and the two disagree for five
 * and a half hours of every day — between 18:30 and 24:00 UTC it is already
 * tomorrow in Thrissur. A late fee that fires at "midnight" off a UTC date
 * fires at 05:30 IST, and one computed at 18:30 UTC reads yesterday's date and
 * fires a day late. Both bugs are invisible in a test suite that runs at noon.
 *
 * IST has never observed daylight saving, so a fixed offset is correct rather
 * than merely convenient — which is why this is arithmetic and not a timezone
 * library.
 */

export const IST_OFFSET_MS = 5.5 * 3600_000;

/** The IST calendar day a UTC timestamp falls in, as YYYY-MM-DD. */
export function istDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The IST hour of day, 0–23. */
export function istHour(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + IST_OFFSET_MS).getUTCHours();
}

/**
 * Today, in Kerala. The default for every "is this bill overdue" comparison.
 *
 * Takes `now` so tests can sit on the boundary rather than hope: 18:29 UTC and
 * 18:31 UTC are different days here, and that hour is exactly where late fees
 * are decided.
 */
export function istToday(now = new Date().toISOString()) {
  return istDay(now);
}
