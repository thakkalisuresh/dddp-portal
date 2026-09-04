/**
 * The bill as a PDF, built by hand — what a resident downloads, and what the
 * announcement email attaches.
 *
 * WHY BY HAND. A page cannot hand anybody a file — window.print() opens a
 * dialog and hopes — so both routes to a bill are bytes from here: the resident
 * tapping Download bill (GET /api/me/bill.pdf) and the announcement email's
 * attachment. One document, one implementation, whichever way it is reached.
 *
 * WHAT IT COSTS. `Rs.` rather than `₹`. No built-in PDF font contains U+20B9,
 * and teaching one costs pdf-lib plus fontkit plus a committed TTF — about
 * 730KB of Worker bundle against the 109KB this file leaves it at. That was
 * weighed and declined on 2026-09-04; `Rs.` is unambiguous in India and the
 * portal's own screens still show the real sign everywhere. Revisit it by
 * embedding a CID font here, not by reaching for the library.
 */

/* ── page geometry, in PDF points (72 per inch) ─────────────────────────── */

const A4 = { w: 595.28, h: 841.89 };
const MM = 72 / 25.4;
const MARGIN = 18 * MM;
const PAD_X = 9 * MM;
const PAD_Y = 10 * MM;

const BOX_L = MARGIN;
const BOX_R = A4.w - MARGIN;
const TEXT_L = BOX_L + PAD_X;
const TEXT_R = BOX_R - PAD_X;

/**
 * Adobe's own widths for the two base-14 faces this uses, printable ASCII
 * only (32..126), in 1/1000 em. Extracted from @pdf-lib/standard-fonts (MIT),
 * which packages the AFM metrics Adobe published for the standard fonts.
 *
 * These are here so a value can be RIGHT-ALIGNED, which needs its width before
 * it is drawn. Guessing an average width instead is what makes a column of
 * money fail to line up, and a column of money that does not line up is the
 * one defect a reader notices on a bill without being able to name it.
 */
const W_REGULAR = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

/**
 * A width for anything outside the table — an accented letter in a name, say.
 *
 * WinAnsi and Latin-1 agree from 160 up, so such a character still PRINTS
 * correctly; only its measured width is approximate, which can leave one
 * right-aligned name a hair off true. Amounts are pure ASCII and are therefore
 * always exact, which is where exactness actually matters.
 */
const W_FALLBACK = 556;

function widthOf(text, size, bold) {
  const table = bold ? W_BOLD : W_REGULAR;
  let mils = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    mils += (c >= 32 && c <= 126) ? table[c - 32] : W_FALLBACK;
  }
  return (mils / 1000) * size;
}

/**
 * A string as PDF text: parentheses and backslashes carry meaning and must be
 * escaped, and anything the font cannot show becomes '?' rather than a byte
 * that would desynchronise the stream.
 */
function pdfText(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255)) out += ch;
    else out += '?';
  }
  return out;
}

/* ── dates ─────────────────────────────────────────────────────────────── */

const IST_DATE = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
});

/**
 * '2026-09-03T20:30:00Z' -> '04/09/2026', read in Kerala.
 *
 * The Worker's own, rather than reminders.js's `dayAndMonth`, which reads UTC
 * fields. That is correct for a due date — a calendar day, parsed as UTC
 * midnight, which +5:30 leaves on the same day — and wrong for a timestamp: a
 * bill raised at 2am IST carries the previous evening's UTC stamp and would be
 * dated a day early on 89 pieces of paper. Same IST rule the browser's own
 * date labels follow in js/i18n.js.
 */
export function istSlashDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return IST_DATE.format(d).replace(/-/g, '/');
}

/* ── money ──────────────────────────────────────────────────────────────── */

/**
 * `Rs.274`, `Rs.273.60` — the same rounding rule as money() in js/i18n.js.
 *
 * Whole rupees show no paise, because bill totals are whole rupees and
 * 'Rs.274.00' is noise; a rate or a gas subtotal that genuinely carries paise
 * shows them. If i18n.js ever changes its mind about that, this has to follow.
 */
export function rupees(amount) {
  const n = Number(amount);
  return `Rs.${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

/* ── the content stream ─────────────────────────────────────────────────── */

class Canvas {
  constructor() { this.ops = []; this.y = A4.h - MARGIN - PAD_Y; }

  /** Move the cursor down by `pt` before drawing the next thing. */
  down(pt) { this.y -= pt; return this; }

  text(str, x, size, { bold = false, align = 'left' } = {}) {
    const w = widthOf(str, size, bold);
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.ops.push(
      'BT', `/${bold ? 'F2' : 'F1'} ${size} Tf`,
      `${left.toFixed(2)} ${this.y.toFixed(2)} Td`, `(${pdfText(str)}) Tj`, 'ET');
    return this;
  }

  /** A label at the left margin and its value hard against the right one. */
  row(label, value, { size = 13, boldValue = false } = {}) {
    this.text(label, TEXT_L, size);
    this.text(value, TEXT_R, size, { bold: boldValue, align: 'right' });
    return this.down(size * 1.45);
  }

  centered(str, size, { bold = false } = {}) {
    this.text(str, (TEXT_L + TEXT_R) / 2, size, { bold, align: 'center' });
    return this.down(size * 1.6);
  }

  rule(weight = 1.5) {
    this.ops.push(`${weight} w`,
      `${TEXT_L.toFixed(2)} ${this.y.toFixed(2)} m`,
      `${TEXT_R.toFixed(2)} ${this.y.toFixed(2)} l`, 'S');
    return this.down(14);
  }

  /** The frame, drawn last because its height is only known once. */
  frame(bottom) {
    this.ops.push('1 w',
      `${BOX_L.toFixed(2)} ${bottom.toFixed(2)} `
      + `${(BOX_R - BOX_L).toFixed(2)} ${(A4.h - MARGIN - bottom).toFixed(2)} re`, 'S');
    return this;
  }

  toString() { return this.ops.join('\n'); }
}

/* ── the document ───────────────────────────────────────────────────────── */

/**
 * One bill, one A4 page.
 *
 * `association` is passed in rather than hardcoded so the letterhead has ONE
 * home — js/association.js, which the Worker imports through esbuild. Two
 * files stating the registration number differently would be a document that
 * contradicts itself depending on which route produced it.
 */
export function billPdf({ association, flat, name, period, billDate,
                          consumption, ratePerKg, gasAmount,
                          otherCharges = 0, additionalCharges = 0, lateFee = 0,
                          total, status = null }) {
  const c = new Canvas();

  c.centered(String(association.name).toUpperCase(), 22, { bold: true });
  c.centered(association.address, 11);
  c.centered(association.registration, 11);
  c.down(4).centered(`Gas Bill - ${period}`, 11, { bold: true });
  c.down(4).rule();

  c.row('Apartment:', flat, { boldValue: true });
  c.row('Owner:', name);
  if (billDate) c.row('Bill Date:', billDate);

  c.down(8);
  c.row('Consumption:', `${Number(consumption).toFixed(2)} kg`);
  c.row('Rate per kg:', `Rs.${Number(ratePerKg).toFixed(2)}`);
  c.row('Gas Amount:', rupees(gasAmount));
  // Every charge that moved the total, exactly as the browser's slip does. A
  // printed bill whose lines do not sum to its own total is worse than none.
  if (otherCharges) c.row('Other charges:', rupees(otherCharges));
  if (additionalCharges) c.row('Additional charges:', rupees(additionalCharges));
  if (lateFee) c.row('Late fee:', rupees(lateFee));

  c.down(4).rule();
  c.text(`Total Amount: ${rupees(total)}`, TEXT_L, 15, { bold: true });
  c.down(18);
  if (status) { c.text(status, TEXT_L, 11); c.down(16); }
  c.down(12).centered(association.footer, 11);

  const bottom = c.y - PAD_Y;
  c.frame(bottom);

  return assemble(c.toString());
}

/**
 * Objects, xref, trailer.
 *
 * Every offset in an xref table is a BYTE offset, so the document is built as
 * a string whose every character is below 256 and converted one char to one
 * byte at the end. Encoding it as UTF-8 instead would make an accented name
 * two bytes wide and put every offset after it out by one — a file that opens
 * in a forgiving viewer and fails in a strict one, which is the worst way for
 * this to break.
 */
function assemble(stream) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] `
      + '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
       + `startxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}
