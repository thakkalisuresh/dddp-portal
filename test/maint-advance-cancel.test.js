/**
 * Cancelling an approved advance (Option B).
 *
 * The guarantee is a chain across the schema: a cancelled advance stops
 * settling (advanceCovers / furthestAdvance / the issue query), and cancelling
 * one that ALREADY settled a bill reopens that bill as unpaid — with the admin's
 * chosen late fee, or none. That is a claim about real rows moving through
 * issueQuarter and revertBillsSettledByAdvance, so it runs against the real
 * migrations.
 */
import { describe, it, expect } from 'vitest';
import { testEnv, seed, rows } from './support/d1.js';
import { advanceCovers, furthestAdvance } from '../functions/lib/maint.js';
import { issueQuarter, revertBillsSettledByAdvance } from '../functions/lib/maint-cron.js';

/* ── pure: a cancelled advance counts for nothing ───────────────────────────  */

describe('a cancelled advance stops counting', () => {
  const base = { approved_by: 11, paid_through: '2026-Q4' };
  it('advanceCovers is false once cancelled', () => {
    expect(advanceCovers({ ...base }, '2026-Q4')).toBe(true);
    expect(advanceCovers({ ...base, cancelled_at: '2026-10-20T00:00:00Z' }, '2026-Q4')).toBe(false);
  });
  it('furthestAdvance skips a cancelled one', () => {
    const advances = [
      { approved_by: 11, paid_through: '2027-Q3', cancelled_at: '2026-10-20T00:00:00Z' },
      { approved_by: 11, paid_through: '2026-Q4' },
    ];
    expect(furthestAdvance(advances).paid_through).toBe('2026-Q4');
  });
});

/* ── against the real database ──────────────────────────────────────────────  */

function building() {
  const { db, env } = testEnv();
  seed(db, {
    flats: ['2B', '9A', '9B'],
    people: [
      { id: 1, flat: '2B', relationship: 'owner', name: 'Suresh', email: 'suresh@x.com' },
      { id: 10, flat: '9A', relationship: 'owner', name: 'Priya', role: 'admin' },
      { id: 11, flat: '9B', relationship: 'owner', name: 'Anil', role: 'admin' },
    ],
  });
  db.prepare(
    `INSERT INTO maint_quarters (quarter, owner_rate, tenant_rate, late_fee, issue_date, due_date, status, created_at)
     VALUES ('2026-Q4', 7500, 9000, 750, '2026-10-01', '2026-10-11', 'scheduled', '2026-09-24T00:00:00Z')`
  ).run();
  return { db, env };
}

function approvedAdvance(db, over = {}) {
  const cols = {
    flat: '2B', owner_id: 1, paid_through: '2026-Q4', amount: 7500, method: 'Bank transfer',
    reference: 'UTR100', paid_on: '2026-09-12', recorded_by: 10, recorded_at: '2026-09-15T00:00:00Z',
    approved_by: 11, approved_at: '2026-09-16T00:00:00Z', ...over,
  };
  db.prepare(
    `INSERT INTO maint_advances (flat, owner_id, paid_through, amount, method, reference, paid_on,
                                 recorded_by, recorded_at, approved_by, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(cols.flat, cols.owner_id, cols.paid_through, cols.amount, cols.method, cols.reference,
        cols.paid_on, cols.recorded_by, cols.recorded_at, cols.approved_by, cols.approved_at);
  return db.prepare('SELECT * FROM maint_advances WHERE flat = ? ORDER BY id DESC LIMIT 1').get(cols.flat);
}

describe('issuing settles from an approved advance, but not a cancelled one', () => {
  it('settles the bill when the advance is live', async () => {
    const { db, env } = building();
    approvedAdvance(db);
    await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });
    const bill = rows(db, "SELECT * FROM maint_bills WHERE flat = '2B'")[0];
    expect(bill.status).toBe('paid');
    expect(bill.paid_method).toBe('advance');
    expect(bill.paid_reference).toBe('UTR100');
  });

  it('does NOT settle from a cancelled advance', async () => {
    const { db, env } = building();
    approvedAdvance(db, { flat: '2B' });
    db.prepare("UPDATE maint_advances SET cancelled_at = '2026-09-20T00:00:00Z', cancelled_by = 10").run();
    await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });
    const bill = rows(db, "SELECT * FROM maint_bills WHERE flat = '2B'")[0];
    expect(bill.status).toBe('unpaid');
    expect(bill.paid_method).toBeNull();
  });
});

describe('cancelling reopens the settled bill', () => {
  async function settledThenCancel(db, env, cancelOver) {
    approvedAdvance(db);
    await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });
    const advance = db.prepare('SELECT * FROM maint_advances LIMIT 1').get();
    Object.assign(advance, cancelOver);
    const now = '2026-10-25T00:00:00Z';
    await revertBillsSettledByAdvance(env, { advance, now });
    return rows(db, "SELECT * FROM maint_bills WHERE flat = '2B'")[0];
  }

  it('reopens as unpaid with no fee when the toggle was off', async () => {
    const { db, env } = building();
    const bill = await settledThenCancel(db, env, { cancel_late_fee: null, cancel_late_fee_from: null });
    expect(bill.status).toBe('unpaid');
    expect(bill.paid_method).toBeNull();
    expect(bill.paid_reference).toBeNull();
    expect(bill.total).toBe(7500);
    expect(bill.late_fee).toBe(0);
    // Parked against the automatic nightly fee — the committee waived it.
    expect(bill.late_fee_at).not.toBeNull();
  });

  it('adds the chosen late fee from the chosen date, and queues the overdue letter', async () => {
    const { db, env } = building();
    const bill = await settledThenCancel(db, env, { cancel_late_fee: 750, cancel_late_fee_from: '2026-10-20' });
    expect(bill.status).toBe('unpaid');
    expect(bill.late_fee).toBe(750);
    expect(bill.total).toBe(8250);
    expect(bill.late_fee_at).toBe('2026-10-20');
    const overdue = rows(db, "SELECT * FROM maint_mail WHERE bill_id = ? AND kind = 'overdue'", bill.id);
    expect(overdue.length).toBe(1);
  });

  it('reopens nothing when the advance never settled a bill', async () => {
    const { db, env } = building();
    // An advance reaching a FUTURE quarter that has not issued — nothing to revert.
    const advance = approvedAdvance(db, { paid_through: '2027-Q3', reference: 'UTR999' });
    const { reopened } = await revertBillsSettledByAdvance(env, { advance, now: '2026-10-25T00:00:00Z' });
    expect(reopened).toEqual([]);
  });
});
