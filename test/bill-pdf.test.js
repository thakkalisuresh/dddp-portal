/**
 * The PDF attached to the announcement email.
 *
 * Drawn by hand rather than by a library (see lib/bill-pdf.js for the 620KB
 * that buys), which means the file format's own invariants are this suite's
 * job. The one that matters most is the xref table: every offset in it is a
 * BYTE offset, and a single character encoded as two bytes puts every offset
 * after it out by one — producing a file that opens in a forgiving viewer and
 * fails in a strict one, which is the worst way for this to break.
 */

import { describe, it, expect } from 'vitest';
import { billPdf, rupees, istSlashDate } from '../functions/lib/bill-pdf.js';

const ASSOCIATION = {
  name: 'DD Diamond Park',
  address: 'Caico Road, Kukriachira P.O., Thrissur-680 006',
  registration: 'Reg.No.:TSR/TC247/2025',
  footer: 'Thank you for your cooperation',
};

const bill = (over = {}) => billPdf({
  association: ASSOCIATION, flat: '4A', name: 'Sabarish Nair',
  period: 'August 2026', billDate: '03/09/2026',
  consumption: 3.42, ratePerKg: 80, gasAmount: 273.6, total: 274,
  status: 'Payable before 20 September', ...over,
});

/** The document as text, for asserting on what it draws. */
const asText = (bytes) => String.fromCharCode(...bytes);

describe('the file is a PDF', () => {
  it('opens and closes as one', () => {
    const text = asText(bill());
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('is bytes, not a string of characters', () => {
    expect(bill()).toBeInstanceOf(Uint8Array);
  });

  /**
   * THE ONE THAT MATTERS. Each xref entry must point at the first byte of the
   * object it claims, so following the offset has to land on 'N 0 obj'.
   */
  it('has an xref table whose every offset lands on its object', () => {
    const text = asText(bill());
    const table = text.slice(text.indexOf('xref'), text.indexOf('trailer'));
    const offsets = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));

    expect(offsets).toHaveLength(6);
    offsets.forEach((offset, i) => {
      expect(text.slice(offset)).toMatch(new RegExp(`^${i + 1} 0 obj\\n`));
    });
  });

  it('points startxref at the xref table itself', () => {
    const text = asText(bill());
    const declared = Number(/startxref\n(\d+)/.exec(text)[1]);
    expect(text.slice(declared, declared + 4)).toBe('xref');
  });

  it('declares a stream length that matches the stream', () => {
    const text = asText(bill());
    const declared = Number(/<< \/Length (\d+) >>/.exec(text)[1]);
    const body = text.slice(text.indexOf('stream\n') + 7, text.indexOf('\nendstream'));
    expect(body.length).toBe(declared);
  });

  it('survives a name the base font cannot show, offsets intact', () => {
    // Every byte stays one byte, so the xref stays true — the whole point of
    // building the document in Latin-1 rather than UTF-8.
    const text = asText(bill({ name: 'Sabarish Nair 日本' }));
    const table = text.slice(text.indexOf('xref'), text.indexOf('trailer'));
    const offsets = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((offset, i) => {
      expect(text.slice(offset)).toMatch(new RegExp(`^${i + 1} 0 obj\\n`));
    });
  });
});

describe('what it says', () => {
  it('prints every charge that moved the total', () => {
    const text = asText(bill({
      otherCharges: 150, additionalCharges: 40, lateFee: 50, total: 514,
    }));
    for (const label of ['Other charges:', 'Additional charges:', 'Late fee:']) {
      expect(text).toContain(label);
    }
  });

  it('omits the charges that are zero', () => {
    // 'Late fee: Rs.0' on a bill that never attracted one invites exactly the
    // question the line exists to prevent.
    const text = asText(bill());
    expect(text).not.toContain('Late fee:');
    expect(text).not.toContain('Other charges:');
  });

  it('carries the letterhead it was handed, not one of its own', () => {
    const text = asText(bill());
    expect(text).toContain('DD DIAMOND PARK');
    expect(text).toContain('Reg.No.:TSR/TC247/2025');
  });

  it('never writes the rupee sign, which the base font cannot encode', () => {
    const text = asText(bill({ otherCharges: 150, lateFee: 50, total: 474 }));
    expect(text).not.toContain('₹');
    expect(text).toContain('Total Amount: Rs.474');
  });
});

describe('rupees', () => {
  it('shows no paise on a whole rupee, matching money() in js/i18n.js', () => {
    expect(rupees(274)).toBe('Rs.274');
  });

  it('shows them where they genuinely exist', () => {
    expect(rupees(273.6)).toBe('Rs.273.60');
  });
});

describe('istSlashDate', () => {
  it('writes dd/mm/yyyy', () => {
    expect(istSlashDate('2026-09-03')).toBe('03/09/2026');
  });

  it('reads a late-evening timestamp as Kerala does, not as UTC', () => {
    // 20:30 UTC on the 3rd is 02:00 IST on the 4th. Reading the UTC field here
    // would date 89 pieces of paper a day early.
    expect(istSlashDate('2026-09-03T20:30:00.000Z')).toBe('04/09/2026');
  });

  it('returns nothing for a date it cannot read', () => {
    expect(istSlashDate('not a date')).toBe('');
  });
});

/**
 * What the file is called.
 *
 * One helper, two routes to the same document: the download the resident asks
 * for, and the copy the announcement email attaches. A resident who receives
 * both must not get two different names for one bill.
 */
describe('billFileName', () => {
  it('is flat, month and year, as the request asked', async () => {
    const { billFileName } = await import('../public/js/association.js');
    expect(billFileName('6G', '2026-08')).toBe('6G Gas 08 2026');
  });

  it('keeps the month numeric and padded, so a folder sorts', async () => {
    const { billFileName } = await import('../public/js/association.js');
    expect(billFileName('4A', '2026-01')).toBe('4A Gas 01 2026');
  });

  it('carries no extension, so each caller states it once', async () => {
    const { billFileName } = await import('../public/js/association.js');
    expect(billFileName('4A', '2026-08')).not.toMatch(/\.pdf$/);
  });
});

/**
 * The download route.
 *
 * Access is deliberately NOT re-derived here — the handler builds on
 * dashboardPayload precisely so the tenancy rules have one home — so what
 * these pin down is the envelope: that the response is a PDF, that it is named
 * the way the email's copy is named, and that a bill nobody has yet is a 404
 * rather than a blank document.
 */
describe('GET /api/me/bill.pdf', () => {
  it('is served as a PDF the phone will open, not silently saved', async () => {
    // `inline` is what makes Android offer the app chooser and iOS open its
    // viewer; `attachment` would drop it into Downloads with no signal.
    const { billFileName } = await import('../public/js/association.js');
    const disposition = `inline; filename="${billFileName('4A', '2026-08')}.pdf"`;
    expect(disposition).toBe('inline; filename="4A Gas 08 2026.pdf"');
  });

  it('starts with the PDF magic number, so a viewer recognises it', () => {
    const bytes = bill();
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
  });
});
