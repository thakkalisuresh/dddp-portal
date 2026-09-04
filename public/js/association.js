/**
 * The association, as it appears on paper. ONE home, two readers.
 *
 * The Worker imports it — through esbuild, which inlines it into _worker.js —
 * for the bill PDF (lib/bill-pdf.js), which is both what a resident downloads
 * and what the announcement email attaches. It lives under public/js because
 * that is the one tree both sides can reach.
 *
 * Not in the database: nothing else needs it, and a settings table holding one
 * immutable address is a table nobody remembers to look in.
 *
 * The locality is "Kuriachira" — confirmed 2026-09-04, after the letterhead
 * this was drawn from spelled it "Kukriachira" and shipped that on a day's
 * worth of bills. It now agrees with public/index.html and js/home.js.
 */
export const ASSOCIATION = {
  name: 'DD Diamond Park',
  address: 'Caico Road, Kuriachira P.O., Thrissur-680 006',
  registration: 'Reg.No.:TSR/TC247/2025',
  footer: 'Thank you for your cooperation',
};

/**
 * What the downloaded bill is called: `6G Gas 08 2026`, no extension.
 *
 * The extension is left off so each caller states it once: the download route
 * and the email attachment both append `.pdf` to their Content-Disposition.
 *
 * Numeric month, so a year of bills sorts correctly in a folder — which is the
 * whole reason a resident downloads one rather than reading it on screen.
 */
export function billFileName(flat, period) {
  const [year, month] = String(period).split('-');
  return `${flat} Gas ${month} ${year}`;
}
