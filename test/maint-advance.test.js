/**
 * Recording a maintenance advance, and approving it.
 *
 * The rules that matter here live in two places, and the tests go to each. The
 * arithmetic and the wording are pure — the quarter span, the soft amount
 * warning, the two emails — so they are checked directly. The GUARANTEE, though,
 * is in the schema: an advance exists only once a SECOND admin approves it, and
 * `maint_advances` CHECKs that recorded_by <> approved_by. That is a claim about
 * a real database, so these run against the real migrations, not a mock.
 */
import { describe, it, expect } from 'vitest';
import { testEnv, seed, rows } from './support/d1.js';
import {
  quarterSpan, advanceAmountCheck, advanceRequestEmail, advanceDecisionEmail,
  mergeAdvancesView, recordAdvanceRequest, applyAdvanceRequest,
} from '../functions/lib/maint-approvals.js';
import { approvalPolicy, canApprove, expiresAt } from '../functions/lib/approvals.js';
import { advanceCovers } from '../functions/lib/maint.js';

/* ── pure: the quarter span and the soft amount check ───────────────────────  */

describe('quarterSpan', () => {
  it('is inclusive of both ends', () => {
    expect(quarterSpan('2026-Q4', '2026-Q4')).toBe(1);
    expect(quarterSpan('2026-Q4', '2027-Q1')).toBe(2);
    expect(quarterSpan('2026-Q4', '2027-Q3')).toBe(4);
  });
  it('is null when a label is malformed or the range runs backwards', () => {
    expect(quarterSpan('2026-Q4', '2026-Q3')).toBeNull();
    expect(quarterSpan('nonsense', '2027-Q1')).toBeNull();
  });
});

describe('advanceAmountCheck', () => {
  it('is consistent when the amount matches rate × quarters', () => {
    expect(advanceAmountCheck({ amount: 15000, rate: 7500, fromQuarter: '2026-Q4', throughQuarter: '2027-Q1' }))
      .toMatchObject({ consistent: true, expected: 15000, quarters: 2 });
  });
  it('warns when the amount is a whole quarter off', () => {
    const r = advanceAmountCheck({ amount: 7500, rate: 7500, fromQuarter: '2026-Q4', throughQuarter: '2027-Q1' });
    expect(r.consistent).toBe(false);
    expect(r.expected).toBe(15000);
  });
  it('tolerates rounding within one quarter, and never warns on an unknowable span', () => {
    expect(advanceAmountCheck({ amount: 15100, rate: 7500, fromQuarter: '2026-Q4', throughQuarter: '2027-Q1' }).consistent)
      .toBe(true);
    expect(advanceAmountCheck({ amount: 999, rate: 0, fromQuarter: '2026-Q4', throughQuarter: '2027-Q1' }).consistent)
      .toBe(true);
  });
});

/* ── pure: the two emails ───────────────────────────────────────────────────  */

describe('the advance emails', () => {
  it('names every figure an approver needs, and the maker≠checker rule', () => {
    const { subject, text } = advanceRequestEmail({
      flat: '2B', amount: 7500, paidThrough: '2026-Q4', paidOn: '12/09/2026',
      paidByName: 'Suresh', reason: 'Paid Q4 up front', requestedBy: 'Priya',
    });
    expect(subject).toContain('2B');
    expect(subject).toContain('₹7,500');
    expect(text).toContain('Q4 2026');
    expect(text).toContain('12/09/2026');
    expect(text).toContain('Suresh');
    expect(text).toMatch(/cannot approve an advance you recorded yourself/);
  });
  it('tells the requester either outcome', () => {
    expect(advanceDecisionEmail({ decision: 'approve', flat: '2B', amount: 7500, paidThrough: '2026-Q4' }).subject)
      .toMatch(/approved/i);
    const rej = advanceDecisionEmail({ decision: 'reject', flat: '2B', amount: 7500, paidThrough: '2026-Q4' });
    expect(rej.subject).toMatch(/rejected/i);
    expect(rej.text).toMatch(/Nothing was recorded/);
  });
});

/* ── pure: the merged view ──────────────────────────────────────────────────  */

describe('mergeAdvancesView', () => {
  it('folds pending requests, approved and cancelled advances into one list', () => {
    const view = mergeAdvancesView({
      advances: [
        { id: 1, flat: '2B', amount: 7500, paid_through: '2026-Q4', approved_by_name: 'Anil',
          recorded_by_name: 'Priya', resident: 'Suresh' },
        { id: 2, flat: '6A', amount: 30000, paid_through: '2027-Q3', cancelled_at: '2026-09-02T00:00:00Z',
          cancelled_by_name: 'Priya' },
      ],
      pendingRequests: [
        { id: 9, flat: '3C', reason: 'r', requested_by: 4, requested_by_name: 'Anil',
          payload: JSON.stringify({ amount: 9000, paid_through: '2026-Q4', owner_id: 30 }),
          paid_by_name: 'Menon' },
      ],
    });
    expect(view.map((v) => v.state)).toEqual(['cancelled', 'approved', 'awaiting']); // paid_through desc
    const awaiting = view.find((v) => v.state === 'awaiting');
    expect(awaiting).toMatchObject({ flat: '3C', amount: 9000, requestId: 9, paidByName: 'Menon' });
    expect(view.find((v) => v.state === 'cancelled').flat).toBe('6A');
  });
});

/* ── against the real database ──────────────────────────────────────────────  */

function building() {
  const { db, env } = testEnv();
  seed(db, {
    flats: ['2B', '3C', '9A', '9B'],
    people: [
      { id: 1, flat: '2B', relationship: 'owner', name: 'Suresh', role: 'owner' },
      { id: 10, flat: '9A', relationship: 'owner', name: 'Priya', role: 'admin', email: 'priya@x.com' },
      { id: 11, flat: '9B', relationship: 'owner', name: 'Anil', role: 'admin', email: 'anil@x.com' },
    ],
  });
  return { db, env };
}

const AT = '2026-09-15T10:00:00Z';

async function record(env, actorId, over = {}) {
  return recordAdvanceRequest(env, {
    actorId, flat: '2B', ownerId: 1, amount: 7500, paidOn: '2026-09-12',
    paidThrough: '2026-Q4', method: 'Bank transfer', reference: 'UTR100',
    reason: 'Paid Q4 up front', now: AT, expiresAt: expiresAt(AT), ...over,
  });
}

describe('recording raises a request and nothing else', () => {
  it('writes a pending advance request and no advance', async () => {
    const { db, env } = building();
    const { requestId } = await record(env, 10);
    expect(requestId).toBeGreaterThan(0);

    const reqs = rows(db, "SELECT kind, flat, status, requested_by FROM maint_approval_requests");
    expect(reqs).toEqual([{ kind: 'advance', flat: '2B', status: 'pending', requested_by: 10 }]);
    expect(rows(db, 'SELECT COUNT(*) n FROM maint_advances')[0].n).toBe(0);
  });
});

describe('a second admin approves', () => {
  it('mints exactly one advance, recorded by the maker and approved by the checker', async () => {
    const { db, env } = building();
    await record(env, 10);
    const req = rows(db, 'SELECT * FROM maint_approval_requests WHERE id = 1')[0];

    const { advanceId } = await applyAdvanceRequest(env, { req, actorId: 11, now: '2026-09-16T09:00:00Z' });
    expect(advanceId).toBeGreaterThan(0);

    const adv = rows(db, 'SELECT * FROM maint_advances')[0];
    expect(adv).toMatchObject({
      flat: '2B', owner_id: 1, paid_through: '2026-Q4', amount: 7500,
      recorded_by: 10, approved_by: 11, paid_on: '2026-09-12', reference: 'UTR100',
    });
    // The request is closed.
    expect(rows(db, 'SELECT status FROM maint_approval_requests WHERE id = 1')[0].status).toBe('applied');
    // And it now counts — the whole point of an approved advance.
    expect(advanceCovers(adv, '2026-Q4')).toBe(true);
    expect(advanceCovers(adv, '2027-Q1')).toBe(false);
  });

  it('the database refuses an advance whose maker and checker are the same person', async () => {
    const { db, env } = building();
    await record(env, 10);
    const req = rows(db, 'SELECT * FROM maint_approval_requests WHERE id = 1')[0];
    // recorded_by is 10; approving as 10 violates the CHECK, the schema backstop
    // under canApprove's own requester guard.
    await expect(applyAdvanceRequest(env, { req, actorId: 10, now: AT })).rejects.toThrow();
    expect(rows(db, 'SELECT COUNT(*) n FROM maint_advances')[0].n).toBe(0);
  });
});

describe('eligibility reuses the shared approval policy', () => {
  it('the requester cannot approve their own advance; another admin can', () => {
    const admins = [
      { id: 10, role: 'admin', flat: '9A' },
      { id: 11, role: 'admin', flat: '9B' },
    ];
    const request = { status: 'pending', requested_by: 10, requested_at: AT };
    const policy = approvalPolicy({ admins, requesterId: 10, billFlat: '2B' });

    expect(canApprove({ policy, approver: { id: 10, role: 'admin', flat: '9A' }, request }).ok).toBe(false);
    expect(canApprove({ policy, approver: { id: 11, role: 'admin', flat: '9B' }, request }).ok).toBe(true);
  });

  it("an admin cannot approve an advance for their own flat", () => {
    const admins = [
      { id: 10, role: 'admin', flat: '2B' },   // lives at the flat the advance is for
      { id: 11, role: 'admin', flat: '9B' },
    ];
    const request = { status: 'pending', requested_by: 11, requested_at: AT };
    const policy = approvalPolicy({ admins, requesterId: 11, billFlat: '2B' });
    expect(policy.approverIds).not.toContain(10);
  });
});
