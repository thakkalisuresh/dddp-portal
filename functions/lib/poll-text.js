/**
 * A closing time, written for an email.
 *
 * SEPARATE FROM public/js/i18n.js, and not sharing its `deadlineLabel`, for one
 * reason: that function reads the VIEWER's timezone off the browser, and there
 * is no viewer here. An email is composed in a Worker running in UTC and read
 * hours later on a device nobody can ask about, so the only honest clock is the
 * building's — named, so a reader abroad knows what to convert from.
 *
 * The portal shows the reader's own time because it can. The letter cannot, and
 * says the one thing it knows instead of guessing.
 */

const IST = 'Asia/Kolkata';

const FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST, weekday: 'long', day: 'numeric', month: 'long',
  hour: 'numeric', minute: '2-digit', hour12: true,
});

const SHORT = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST, day: 'numeric', month: 'short',
  hour: 'numeric', minute: '2-digit', hour12: true,
});

/**
 * '20 Sept, 6:00 pm' — for the figure block, which sets 32px type.
 *
 * The full sentence below would wrap to three lines at that size and stop
 * reading as a figure. The word IST is not dropped, it moves to the caption,
 * because an unlabelled clock is the one thing these must never print.
 */
export function deadlineShort(iso) {
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? 'soon' : SHORT.format(when);
}

/** 'Sunday 20 September at 6:00 pm IST' */
export function deadlineText(iso) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return 'shortly';
  const parts = Object.fromEntries(
    FMT.formatToParts(when).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.day} ${parts.month} at `
    + `${parts.hour}:${parts.minute} ${parts.dayPeriod?.toLowerCase() ?? ''} IST`.replace(/\s+/g, ' ');
}
