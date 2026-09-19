/**
 * Reconciling the SECOND bank account.
 *
 * Everything here exists because maintenance has no fingerprint. 0042 states
 * the rule in the schema — forty-one flats owe the same rupee, so an amount
 * cannot identify a payer — and these tests are what hold the code to it. The
 * one that matters most is the first: gas settles on amount and date, and if
 * that pass is ever left on for maintenance it will confidently post real money
 * to the wrong flat and report itself as confirmed.
 */
import { describe, it, expect } from 'vitest';
import { reconcile, bucketReconciliation, rankCandidates, MAX_CANDIDATES }
  from '../functions/lib/statement.js';
import { maintNote, parseMaintNote, maintAccountHint } from '../functions/lib/upi.js';
import { freshDb } from './support/d1.js';

const bill = (flat, id, over = {}) =>
  ({ id, flat, period: '2026-Q4', total: 9000, name: `${flat} resident`, ...over });

const credit = (over = {}) =>
  ({ date: '2026-10-05', amount: 9000, reference: null, narration: '', ...over });

const proof = (over = {}) => ({
  proofId: 1, billId: 1, utr: null, claimedAmount: 9000, createdAt: '2026-10-05T04:00:00Z',
  flat: '2B', period: '2026-Q4', billed: 9000, name: 'A resident', ...over,
});

/* ── the note, and its inverse ──────────────────────────────────────────── */

describe('the note on the bank statement', () => {
  it('reads back exactly what the payment sheet wrote', () => {
    // The agreement between the two halves, asserted rather than assumed. A
    // format change that breaks reconciliation should break here first.
    expect(parseMaintNote(maintNote('2B', '2026-Q4'))).toEqual({ flat: '2B', quarter: '2026-Q4' });
    expect(parseMaintNote(maintNote('13A', '2027-Q1'))).toEqual({ flat: '13A', quarter: '2027-Q1' });
  });

  it('finds the note inside a narration a bank has mangled', () => {
    expect(parseMaintNote('UPI/CR/621900011111/PAYMENT (2B_MAINT_Q4_26)/SIB'))
      .toEqual({ flat: '2B', quarter: '2026-Q4' });
    // Banks upper-case freely.
    expect(parseMaintNote('neft inward (4c_maint_q3_26) ref 99'))
      .toEqual({ flat: '4C', quarter: '2026-Q3' });
  });

  it('refuses to guess at half a note', () => {
    for (const junk of ['', null, 'MAINT Q4', '(2B_MAINT_Q4)', '2B_MAINT_Q4_26', '(2B_MAINT_Q9_26)']) {
      expect(parseMaintNote(junk), String(junk)).toBe(null);
    }
  });
});

describe('what the account picker is allowed to say', () => {
  it('shows four digits and never the account or the IFSC', () => {
    const env = { MAINT_PAYEE_MODE: 'account', MAINT_PAYEE_NAME: 'RWA', MAINT_ACCOUNT_NUMBER: '00000000000744', MAINT_IFSC: 'SIBL0000999' };
    const hint = maintAccountHint(env);
    expect(hint).toBe('the account ending 0744');
    // The repository is public and this string reaches an admin screen.
    expect(hint).not.toContain('00000000000744');
    expect(hint).not.toContain('SIBL0000999');
  });

  it('says nothing at all rather than something misleading when unconfigured', () => {
    expect(maintAccountHint({ MAINT_PAYEE_MODE: 'account', MAINT_PAYEE_NAME: 'RWA' })).toBe(null);
    expect(maintAccountHint({})).toBe(null);
  });
});

/* ── the rule the whole account turns on ────────────────────────────────── */

describe('an amount is not a fingerprint', () => {
  it('matches a gas proof on amount and date', () => {
    const r = reconcile({ credits: [credit()], proofs: [proof()], openBills: [] });
    expect(r.confirmed).toHaveLength(1);
    expect(r.confirmed[0].how).toBe('amount-and-date');
  });

  it('refuses the same match on the maintenance account', () => {
    // THE TEST THIS FILE EXISTS FOR. Same inputs, same day, same rupee — and
    // here it must come back unexplained rather than confirmed, because the
    // rupee is every flat's rupee.
    const r = reconcile({
      credits: [credit()], proofs: [proof()], openBills: [], amountIdentifiesPayer: false,
    });
    expect(r.confirmed).toHaveLength(0);
    expect(r.discrepancies.map((d) => d.kind)).toContain('proof_no_credit');
  });

  it('matches on the note in the narration instead', () => {
    const r = reconcile({
      credits: [credit({ narration: `UPI/CR/PAYMENT ${maintNote('2B', '2026-Q4')}` })],
      proofs: [proof()], openBills: [], amountIdentifiesPayer: false,
    });
    expect(r.confirmed).toHaveLength(1);
    expect(r.confirmed[0].how).toBe('narration');
  });

  it('will not use a note that names a different quarter', () => {
    const r = reconcile({
      credits: [credit({ narration: maintNote('2B', '2026-Q3') })],
      proofs: [proof()], openBills: [], amountIdentifiesPayer: false,
    });
    expect(r.confirmed).toHaveLength(0);
  });

  it('still matches on the reference, which means the same thing on both accounts', () => {
    const r = reconcile({
      credits: [credit({ reference: '621900011111' })],
      proofs: [proof({ utr: '621900011111' })], openBills: [], amountIdentifiesPayer: false,
    });
    expect(r.confirmed[0].how).toBe('reference');
  });

  it('carries the rule out with the result so nothing downstream has to remember it', () => {
    expect(reconcile({ amountIdentifiesPayer: false }).amountIdentifiesPayer).toBe(false);
    expect(reconcile({}).amountIdentifiesPayer).toBe(true);
  });
});

/* ── the shortlist ──────────────────────────────────────────────────────── */

describe('the flats a credit could belong to', () => {
  const openBills = [bill('2B', 1), bill('4C', 2), bill('5A', 3), bill('13A', 4)];

  it('puts the flat whose note is in the narration first', () => {
    const c = rankCandidates({
      credit: credit({ narration: `NEFT ${maintNote('5A', '2026-Q4')}` }), openBills,
    });
    expect(c[0]).toMatchObject({ flat: '5A', reason: 'note' });
  });

  it('ranks a flat mentioned in the narration above one that only shares the amount', () => {
    const c = rankCandidates({ credit: credit({ narration: 'NEFT INWARD 4C MAINTENANCE' }), openBills });
    expect(c[0]).toMatchObject({ flat: '4C', reason: 'flat' });
    expect(c.slice(1).every((x) => x.reason === 'amount')).toBe(true);
  });

  it('does not read a flat out of the middle of a longer token', () => {
    // '2B' must not match inside '12BQ' or a reference number.
    const c = rankCandidates({ credit: credit({ narration: 'UPI 6219000112BQ77 TRANSFER' }), openBills });
    expect(c.find((x) => x.flat === '2B').reason).toBe('amount');
  });

  it('ranks a distinctive part of the payer’s name', () => {
    const c = rankCandidates({
      credit: credit({ narration: 'IMPS RAJAN PILLAI' }),
      openBills: [bill('2B', 1, { name: 'Rajan Pillai' }), bill('4C', 2)],
    });
    expect(c[0]).toMatchObject({ flat: '2B', reason: 'name' });
  });

  it('will not match on an initial or a two-letter particle', () => {
    const c = rankCandidates({
      credit: credit({ narration: 'TRANSFER FROM K P' }),
      openBills: [bill('2B', 1, { name: 'K P Nair' })],
    });
    expect(c[0].reason).toBe('amount');
  });

  it('keeps a named flat on the list even when the figures disagree, and says how short', () => {
    // B25's underpayer. ₹8,500 against a ₹9,000 bill is a person to talk to.
    const c = rankCandidates({
      credit: credit({ amount: 8500, narration: 'NEFT 4C MAINT PART' }), openBills,
    });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ flat: '4C', reason: 'flat', short: 500 });
  });

  it('marks an exact payment as not short', () => {
    const c = rankCandidates({ credit: credit({ narration: '4C' }), openBills });
    expect(c[0].short).toBe(0);
  });

  it('breaks a tie on the oldest debt', () => {
    const c = rankCandidates({
      credit: credit(),
      openBills: [bill('9A', 9, { period: '2027-Q1' }), bill('8A', 8, { period: '2026-Q4' })],
    });
    expect(c.map((x) => x.flat)).toEqual(['8A', '9A']);
  });

  it('caps the list, because forty candidates is not a shortlist', () => {
    const many = Array.from({ length: 40 }, (_, i) => bill(`F${i}`, i + 1));
    expect(rankCandidates({ credit: credit(), openBills: many })).toHaveLength(MAX_CANDIDATES);
  });

  it('offers nothing for bank interest', () => {
    expect(rankCandidates({ credit: credit({ amount: 42, narration: 'CREDIT INTEREST' }), openBills }))
      .toEqual([]);
  });
});

/* ── the buckets ────────────────────────────────────────────────────────── */

describe('how a maintenance report is split up', () => {
  const openBills = [bill('2B', 1), bill('4C', 2)];
  const run = () => reconcile({
    credits: [
      credit({ narration: 'NEFT 4C MAINT' }),
      credit({ amount: 42, narration: 'CREDIT INTEREST CAPITALISED' }),
    ],
    proofs: [], openBills, amountIdentifiesPayer: false,
  });

  it('never fills the one-tap bucket, whatever the amounts say', () => {
    // `likelyResident` is the gas screen's "one unpaid bill matches this
    // amount, settle it". On this account that sentence is true of every flat.
    const b = bucketReconciliation(run());
    expect(b.likelyResident).toEqual([]);
  });

  it('separates money with a shortlist from money without one', () => {
    const b = bucketReconciliation(run());
    expect(b.assignable).toHaveLength(1);
    expect(b.assignable[0].candidates[0].flat).toBe('4C');
    expect(b.unmatched).toHaveLength(1);
    expect(b.unmatched[0].amount).toBe(42);
  });

  it('moves a credit out of the shortlist once it is assigned, and keeps showing it', () => {
    const result = run();
    result.discrepancies[0].assignedTo = { billId: 2, flat: '4C', name: '4C resident' };
    const b = bucketReconciliation(result);
    expect(b.assignable).toEqual([]);
    expect(b.assigned).toHaveLength(1);
    expect(b.assigned[0].assignedTo.flat).toBe('4C');
  });

  it('leaves the gas buckets exactly as they were', () => {
    const b = bucketReconciliation(reconcile({
      credits: [credit()], proofs: [], openBills: [bill('2B', 1)],
    }));
    expect(b.likelyResident).toHaveLength(1);
    expect(b.assignable).toEqual([]);
    expect(b.assigned).toEqual([]);
  });
});

/* ── the schema 0044 asked for ──────────────────────────────────────────── */

describe('a verdict about a maintenance bill (0044, against the real migrations)', () => {
  const seed = (db) => {
    db.exec(`
      INSERT INTO flats (flat, floor) VALUES ('2B', 2);
      INSERT INTO owners (id, flat, name, mobile, pw_hash, pw_salt, role, created_at)
        VALUES (1, '2B', 'A resident', '9000000001', 'x', 'y', 'admin', '2026-09-01');
      INSERT INTO maint_quarters (quarter, owner_rate, tenant_rate, issue_date, due_date, status, created_at)
        VALUES ('2026-Q4', 7500, 9000, '2026-10-01', '2026-10-11', 'issued', '2026-09-24');
      INSERT INTO maint_bills (id, flat, quarter, owner_id, rate_applied, basis, total, created_at)
        VALUES (500, '2B', '2026-Q4', 1, 7500, 'owner', 7500, '2026-10-01');
      INSERT INTO statement_sessions (id, created_by, row_count, credit_total, status, account, created_at)
        VALUES (1, 1, 1, 7500, 'open', 'maintenance', '2026-10-06');`);
  };

  it('records the account a statement came from, and calls an old one gas', () => {
    const db = freshDb();
    seed(db);
    expect(db.prepare('SELECT account FROM statement_sessions WHERE id = 1').get().account)
      .toBe('maintenance');
    // The backfill: a session written without the column is what every
    // statement before 0044 was.
    db.exec("INSERT INTO statement_sessions (id, created_by, status, created_at) VALUES (2, 1, 'open', '2026-01-01')");
    expect(db.prepare('SELECT account FROM statement_sessions WHERE id = 2').get().account).toBe('gas');
  });

  it('holds an assignment against the maintenance bill, not the gas column', () => {
    const db = freshDb();
    seed(db);
    db.exec(`INSERT INTO reconciliations (session_id, maint_bill_id, verdict, reference, amount, txn_date, assigned_by, created_at)
             VALUES (1, 500, 'confirmed', '621900011111', 7500, '2026-10-05', 1, '2026-10-06')`);
    const row = db.prepare('SELECT bill_id, maint_bill_id, assigned_by FROM reconciliations').get();
    expect(row).toMatchObject({ bill_id: null, maint_bill_id: 500, assigned_by: 1 });
  });

  it('refuses a maintenance bill id written into the gas column', () => {
    // The reason 0044 added a column rather than reusing `bill_id`: with
    // foreign keys on, 500 is not a gas bill and the database says so. Without
    // the new column this row would have been accepted the moment some gas bill
    // happened to have id 500, and pointed at a stranger's money.
    const db = freshDb();
    seed(db);
    expect(() => db.exec(`INSERT INTO reconciliations (session_id, bill_id, verdict, amount, created_at)
                          VALUES (1, 500, 'confirmed', 7500, '2026-10-06')`)).toThrow();
  });
});
