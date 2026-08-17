import { describe, it, expect } from 'vitest';
import {
  parseAmount, parseDate, parseCsv, findHeader, creditsFromCsv, creditsFromText,
  reconcile, validateStatement, textFromContentStream, bucketReconciliation } from '../functions/lib/statement.js';

/* ── the shapes a bank actually exports ─────────────────────────────────── */

describe('reading money out of an export', () => {
  it('strips the decoration banks add', () => {
    expect(parseAmount('₹1,234.56')).toBe(1234.56);
    expect(parseAmount('  494.00  ')).toBe(494);
    expect(parseAmount('"7,500.00"')).toBe(7500);
  });

  it('reads a trailing Dr as money out', () => {
    expect(parseAmount('500.00 Cr')).toBe(500);
    expect(parseAmount('500.00 Dr')).toBe(-500);
    expect(parseAmount('(500.00)')).toBe(-500);
  });

  it('returns null rather than zero for a blank cell', () => {
    for (const junk of ['', '   ', null, undefined, '-', 'n/a', '0.00']) {
      expect(parseAmount(junk), String(junk)).toBe(null);
    }
  });
});

describe('reading dates out of an export', () => {
  it('reads the formats Indian banks emit', () => {
    expect(parseDate('05/08/2026')).toBe('2026-08-05');
    expect(parseDate('5-8-26')).toBe('2026-08-05');
    expect(parseDate('05-Aug-2026')).toBe('2026-08-05');
    expect(parseDate('2026-08-05')).toBe('2026-08-05');
  });

  it('reads an ambiguous date day-first, as India writes them', () => {
    // 05/08 is 5 August. Month-first would shift every match window by months.
    expect(parseDate('05/08/2026')).toBe('2026-08-05');
    expect(parseDate('12/01/2026')).toBe('2026-01-12');
  });

  it('returns null on nonsense', () => {
    expect(parseDate('not a date')).toBe(null);
    expect(parseDate('')).toBe(null);
  });
});

describe('CSV reading', () => {
  it('handles quoted fields with embedded commas', () => {
    const rows = parseCsv('a,"b,c",d\n1,"2,3",4');
    expect(rows[1]).toEqual(['1', '2,3', '4']);
  });

  it('handles doubled quotes and CRLF', () => {
    const rows = parseCsv('x,y\r\n"he said ""hi""",2\r\n');
    expect(rows[1]).toEqual(['he said "hi"', '2']);
  });

  it('skips the preamble and finds the real header row', () => {
    const csv = [
      'DD DIAMOND PARK RESIDENTS WELFARE ASSOCIATION',
      'Account: 0184073000000744',
      '',
      'Txn Date,Narration,Ref No,Debit,Credit,Balance',
      '05/08/2026,UPI/CR/621932447570/SHEEJA,,,494.00,10000.00',
    ].join('\n');
    const header = findHeader(parseCsv(csv));
    // Index into the PARSED rows — the blank separator line is dropped on the
    // way in, so the header is the third row that survived, not the fourth line.
    expect(header.index).toBe(2);
    expect(header.columns.credit).toBe(4);
    expect(header.columns.narration).toBe(1);
  });
});

const STATEMENT = [
  'Txn Date,Narration,Ref No,Debit,Credit,Balance',
  '05/08/2026,UPI/CR/621932447570/SHEEJA SHINO/SIBL,,,494.00,10494.00',
  '05/08/2026,UPI/CR/125764686884/LAKSHMI IYER/HDFC,,,286.00,10780.00',
  '06/08/2026,NEFT/618622601669/DHANYA,,,9000.00,19780.00',
  '06/08/2026,ATM WITHDRAWAL,,5000.00,,14780.00',
].join('\n');

describe('credits from a statement', () => {
  it('takes credits and ignores debits', () => {
    const { credits } = creditsFromCsv(STATEMENT);
    expect(credits).toHaveLength(3);
    expect(credits.map((c) => c.amount)).toEqual([494, 286, 9000]);
  });

  it('digs the 12-digit reference out of the narration', () => {
    const { credits } = creditsFromCsv(STATEMENT);
    expect(credits[0].reference).toBe('621932447570');
    expect(credits[2].reference).toBe('618622601669');
  });

  it('refuses a file with no table rather than inventing rows', () => {
    expect(() => creditsFromCsv('just some text\nand more')).toThrow(/DDP-RECON-001/);
  });

  it('refuses a statement whose credits are all debits', () => {
    const debitsOnly = 'Txn Date,Narration,Debit,Credit,Balance\n05/08/2026,ATM,5000.00,,100.00';
    expect(() => creditsFromCsv(debitsOnly)).toThrow(/DDP-RECON-002/);
  });

  it('warns when it had to guess that positive means money in', () => {
    const noCreditColumn = 'Date,Description,Amount\n05/08/2026,UPI/CR/621932447570/X,494.00';
    const { credits, warnings } = creditsFromCsv(noCreditColumn);
    expect(credits).toHaveLength(1);
    expect(warnings.join(' ')).toMatch(/no separate credit column/i);
  });
});

describe('PDF text', () => {
  it('turns text-showing operators back into lines', () => {
    const content = '(05/08/2026 UPI CR 621932447570) Tj (494.00 10494.00) Tj ET';
    expect(textFromContentStream(content)).toContain('621932447570');
  });

  it('reads credit lines and drops the running balance', () => {
    const text = [
      '05/08/2026 UPI/CR/621932447570/SHEEJA 494.00 10494.00',
      '06/08/2026 ATM WITHDRAWAL DR 5000.00 5494.00',
    ].join('\n');
    const { credits } = creditsFromText(text);
    expect(credits).toHaveLength(1);
    expect(credits[0].amount).toBe(494);        // not 10494.00, the balance
    expect(credits[0].reference).toBe('621932447570');
  });
});

describe('what may be uploaded', () => {
  it('accepts csv and pdf, by type or by extension', () => {
    expect(validateStatement({ type: 'text/csv', size: 100, name: 'a.csv' }).ok).toBe(true);
    expect(validateStatement({ type: 'application/pdf', size: 100, name: 'a.pdf' }).ok).toBe(true);
    expect(validateStatement({ type: '', size: 100, name: 'statement.CSV' }).ok).toBe(true);
  });

  it('refuses anything else, and anything empty or huge', () => {
    expect(validateStatement({ type: 'image/png', size: 100, name: 'a.png' }).ok).toBe(false);
    expect(validateStatement({ type: 'text/csv', size: 0, name: 'a.csv' }).ok).toBe(false);
    expect(validateStatement({ type: 'text/csv', size: 9e9, name: 'a.csv' }).ok).toBe(false);
  });
});

/* ── matching ───────────────────────────────────────────────────────────── */

const proof = (over = {}) => ({
  proofId: 1, billId: 11, flat: '7D', name: 'A Resident', period: '2026-07',
  billed: 494, claimedAmount: 494, utr: '621932447570', createdAt: '2026-08-05T10:00:00Z', ...over,
});

describe('matching credits to proofs', () => {
  it('matches on the 12-digit reference', () => {
    const report = reconcile({
      credits: [{ date: '2026-08-05', amount: 494, reference: '621932447570', narration: '' }],
      proofs: [proof()],
    });
    expect(report.confirmed).toHaveLength(1);
    expect(report.confirmed[0].how).toBe('reference');
    expect(report.discrepancies).toHaveLength(0);
  });

  it('falls back to amount and date when the reference cannot reach the bank', () => {
    // PhonePe's own id never appears in a statement narration; this is the
    // normal path for those residents, not a failure.
    const report = reconcile({
      credits: [{ date: '2026-08-05', amount: 494, reference: null, narration: 'UPI/CR/PHONEPE' }],
      proofs: [proof({ utr: 'T2608051827501900771902' })],
    });
    expect(report.confirmed).toHaveLength(1);
    expect(report.confirmed[0].how).toBe('amount-and-date');
  });

  it('refuses to guess when two credits fit equally well', () => {
    // Two flats paying the same gas bill on the same day is ordinary here.
    const credits = [
      { date: '2026-08-05', amount: 494, reference: null, narration: '' },
      { date: '2026-08-05', amount: 494, reference: null, narration: '' },
    ];
    const report = reconcile({ credits, proofs: [proof({ utr: null })] });
    expect(report.confirmed).toHaveLength(0);
    expect(report.discrepancies.filter((d) => d.kind === 'proof_no_credit')).toHaveLength(1);
    expect(report.discrepancies.filter((d) => d.kind === 'credit_no_proof')).toHaveLength(2);
  });

  it('will not match a credit that sits outside the day window', () => {
    const report = reconcile({
      credits: [{ date: '2026-07-01', amount: 494, reference: null, narration: '' }],
      proofs: [proof({ utr: null })],
      dayWindow: 3,
    });
    expect(report.confirmed).toHaveLength(0);
  });

  it('flags a screenshot with no money behind it', () => {
    const report = reconcile({ credits: [], proofs: [proof()] });
    expect(report.discrepancies[0].kind).toBe('proof_no_credit');
    expect(report.discrepancies[0].flat).toBe('7D');
  });

  it('flags money that arrived with no screenshot, and suggests who', () => {
    const report = reconcile({
      credits: [{ date: '2026-08-05', amount: 626, reference: '999999999999', narration: 'UPI/CR/X' }],
      proofs: [],
      openBills: [{ id: 42, flat: '11A', name: 'Someone', period: '2026-07', total: 626 }],
    });
    const stray = report.discrepancies.find((d) => d.kind === 'credit_no_proof');
    expect(stray.suggestions).toHaveLength(1);
    expect(stray.suggestions[0].flat).toBe('11A');
  });

  it('flags a claim the bank disagrees with', () => {
    const report = reconcile({
      credits: [{ date: '2026-08-05', amount: 400, reference: '621932447570', narration: '' }],
      proofs: [proof({ claimedAmount: 494 })],
    });
    expect(report.discrepancies[0].kind).toBe('amount_mismatch');
    expect(report.discrepancies[0].bankAmount).toBe(400);
  });

  it('flags one reference claimed on two bills', () => {
    const report = reconcile({
      credits: [{ date: '2026-08-05', amount: 494, reference: '621932447570', narration: '' }],
      proofs: [proof(), proof({ proofId: 2, billId: 12, flat: '8B' })],
    });
    const dupes = report.discrepancies.filter((d) => d.kind === 'duplicate_reference');
    expect(dupes).toHaveLength(2);
    expect(report.confirmed).toHaveLength(0);
  });

  it('does not call one proof a duplicate of itself', () => {
    // The join that produced this: a flat with an owner AND a tenant matched
    // `owners.flat` twice, so the same proof arrived twice and was reported as
    // the same payment claimed on two bills. The resident had done nothing.
    const twice = [proof(), proof()];
    const report = reconcile({
      credits: [{ date: '2026-08-05', amount: 494, reference: '621932447570', narration: '' }],
      proofs: twice,
    });
    expect(report.discrepancies.filter((d) => d.kind === 'duplicate_reference')).toHaveLength(0);
    expect(report.confirmed).toHaveLength(1);
  });

  it('confirms a payment that does not settle the bill, and says so', () => {
    const report = reconcile({
      credits: [{ date: '2026-08-05', amount: 494, reference: '621932447570', narration: '' }],
      proofs: [proof({ billed: 700, claimedAmount: 494 })],
    });
    expect(report.confirmed[0].settles).toBe(false);
  });

  it('never matches one credit to two proofs', () => {
    const report = reconcile({
      credits: [{ date: '2026-08-05', amount: 494, reference: null, narration: '' }],
      proofs: [proof({ utr: null }), proof({ proofId: 2, billId: 12, flat: '8B', utr: null })],
    });
    expect(report.confirmed.length).toBeLessThanOrEqual(1);
  });

  it('totals what was seen, confirmed and left unexplained', () => {
    const report = reconcile({
      credits: [
        { date: '2026-08-05', amount: 494, reference: '621932447570', narration: '' },
        { date: '2026-08-05', amount: 900, reference: null, narration: '' },
      ],
      proofs: [proof()],
    });
    expect(report.totals.creditTotal).toBe(1394);
    expect(report.totals.confirmedTotal).toBe(494);
    expect(report.totals.unmatchedCreditTotal).toBe(900);
  });
});

/**
 * B25 — the report called the whole bank account a discrepancy.
 *
 * Seventeen residents paying perfectly still produced a page of things
 * "needing attention", because the bank pays interest into the account and no
 * resident will ever upload a screenshot for it.
 */
describe('splitting a reconciliation into what anyone can act on', () => {
  const credit = (suggestions) => ({ kind: 'credit_no_proof', amount: 500, suggestions });

  it('separates a probable resident from money nothing matches', () => {
    const b = bucketReconciliation({
      discrepancies: [
        credit([{ billId: 1, flat: '4A' }]),
        credit([]),
      ],
    });
    expect(b.likelyResident).toHaveLength(1);
    expect(b.unmatched).toHaveLength(1);
  });

  it('keeps real problems out of both credit buckets', () => {
    const b = bucketReconciliation({
      discrepancies: [
        { kind: 'amount_mismatch' },
        { kind: 'duplicate_reference' },
        { kind: 'proof_no_credit' },
        credit([]),
      ],
    });
    expect(b.needsAttention.map((d) => d.kind))
      .toEqual(['amount_mismatch', 'duplicate_reference', 'proof_no_credit']);
    expect(b.likelyResident).toEqual([]);
    expect(b.unmatched).toHaveLength(1);
  });

  it('never drops a row — every discrepancy lands in exactly one bucket', () => {
    // The rejected simplification was to reconcile only against the month's
    // expected amounts, which makes a flat billed ₹310 that paid ₹300 vanish
    // entirely. Nothing here may filter a row away.
    const discrepancies = [
      { kind: 'amount_mismatch' }, credit([]), credit([{ billId: 2 }]), { kind: 'proof_no_credit' },
    ];
    const b = bucketReconciliation({ discrepancies });
    expect(b.needsAttention.length + b.likelyResident.length + b.unmatched.length)
      .toBe(discrepancies.length);
  });

  it('treats a missing suggestions list as nothing matching', () => {
    const b = bucketReconciliation({ discrepancies: [{ kind: 'credit_no_proof', amount: 12 }] });
    expect(b.unmatched).toHaveLength(1);
  });

  it('survives an empty reconciliation', () => {
    expect(bucketReconciliation()).toMatchObject({
      confirmed: [], needsAttention: [], likelyResident: [], unmatched: [],
    });
  });
});
