import { describe, it, expect } from 'vitest';
import {
  approvalPolicy, canApprove, isSatisfied, needsApproval, expiresAt,
  SUBSTITUTE_AFTER_HOURS,
} from '../functions/lib/approvals.js';

/**
 * The REAL bench, because the policy behaves differently on a small one and
 * this building has three admins. Written with their actual flats: an admin's
 * own bill is a case the rules turn on.
 */
const BENCH = [
  { id: 1, role: 'superadmin', flat: '4A' },   // Sabarish
  { id: 2, role: 'admin', flat: '10A' },       // Adv. Joy
  { id: 3, role: 'admin', flat: '13A' },       // Mukesh
  { id: 4, role: 'admin', flat: '13E' },       // Hari
];

const requestedAt = '2026-08-13T10:00:00Z';
const request = (over = {}) => ({
  id: 1, status: 'pending', requested_by: 2, requested_at: requestedAt, ...over,
});

describe('an ordinary resident\'s bill', () => {
  const policy = approvalPolicy({ admins: BENCH, requesterId: 2, billFlat: '10C' });

  it('takes two other admins', () => {
    expect(policy.required).toBe(2);
    expect(policy.approverIds).toEqual([3, 4]);
    expect(policy.satisfiable).toBe(true);
  });

  it('never counts the requester', () => {
    expect(policy.approverIds).not.toContain(2);
    const verdict = canApprove({ policy, approver: BENCH[1], request: request() });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('requester');
  });

  it('leaves the superadmin out of the pool entirely', () => {
    // Rule 3, as decided: the superadmin does not count toward quorum.
    expect(policy.approverIds).not.toContain(1);
  });
});

describe('an admin\'s own bill', () => {
  // Mukesh is 13A. Joy raises the correction.
  const policy = approvalPolicy({ admins: BENCH, requesterId: 2, billFlat: '13A' });

  it('never lets the subject approve their own bill', () => {
    expect(policy.approverIds).not.toContain(3);
  });

  it('needs every other eligible admin, not merely two', () => {
    expect(policy.subjectIsAdmin).toBe(true);
    expect(policy.required).toBe(policy.approverIds.length);
  });

  it('DOES NOT BECOME LAXER THAN AN ORDINARY BILL on a small committee', () => {
    // The trap. Excluding subject (Mukesh) and requester (Joy) leaves Hari
    // alone, so unanimity would mean ONE approval — the strictest rule would
    // need fewer people than the ordinary one. The superadmin tops the pool up.
    expect(policy.approverIds).toContain(4);
    expect(policy.approverIds).toContain(1);
    expect(policy.required).toBe(2);
    expect(policy.satisfiable).toBe(true);
  });
});

describe('the superadmin standing in', () => {
  const policy = approvalPolicy({ admins: BENCH, requesterId: 2, billFlat: '10C' });
  const sabarish = BENCH[0];

  it('cannot act before the wait is over', () => {
    const verdict = canApprove({
      policy, approver: sabarish, request: request(),
      now: '2026-08-13T20:00:00Z',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('too-soon');
    expect(verdict.hoursLeft).toBeGreaterThan(0);
  });

  it('may stand in once an admin has not answered for 48 hours', () => {
    const verdict = canApprove({
      policy, approver: sabarish, request: request(),
      now: '2026-08-15T10:00:00Z',
    });
    expect(verdict.ok).toBe(true);
    // Recorded AS a substitution: an override that reads like an ordinary
    // approval is one nobody can audit later.
    expect(verdict.substitute).toBe(true);
  });

  it('cannot stand in on a request they raised themselves', () => {
    const own = approvalPolicy({ admins: BENCH, requesterId: 1, billFlat: '10C' });
    const verdict = canApprove({
      policy: own, approver: sabarish, request: request({ requested_by: 1 }),
      now: '2026-08-20T10:00:00Z',
    });
    expect(verdict.ok).toBe(false);
  });

  it('cannot approve an edit to their own flat\'s bill', () => {
    const mine = approvalPolicy({ admins: BENCH, requesterId: 2, billFlat: '4A' });
    expect(mine.approverIds).not.toContain(1);
  });
});

describe('quorum that cannot be met', () => {
  it('is reported rather than quietly relaxed', () => {
    // One admin, who is also the requester. An edit that applies itself because
    // nobody was available is the exact failure this exists to prevent.
    const tiny = approvalPolicy({
      admins: [{ id: 2, role: 'admin', flat: '10A' }], requesterId: 2, billFlat: '10C',
    });
    expect(tiny.satisfiable).toBe(false);
  });
});

describe('counting approvals', () => {
  const policy = approvalPolicy({ admins: BENCH, requesterId: 2, billFlat: '10C' });

  it('is not satisfied by one', () => {
    expect(isSatisfied(policy, [{ approver_id: 3, decision: 'approve' }])).toBe(false);
  });

  it('is satisfied by two', () => {
    expect(isSatisfied(policy, [
      { approver_id: 3, decision: 'approve' },
      { approver_id: 4, decision: 'approve' },
    ])).toBe(true);
  });

  it('does not count a rejection as agreement', () => {
    expect(isSatisfied(policy, [
      { approver_id: 3, decision: 'approve' },
      { approver_id: 4, decision: 'reject' },
    ])).toBe(false);
  });
});

describe('which edits need approval at all', () => {
  it('asks for approval whenever the total moves', () => {
    expect(needsApproval({ totalBefore: 12466, totalAfter: 338 })).toBe(true);
    expect(needsApproval({ totalBefore: 338, totalAfter: 339 })).toBe(true);
  });

  it('lets an edit that costs nothing through', () => {
    // Totals are whole rupees, so "paise are free" describes nothing that can
    // happen — what it reduces to is: if the money does not move, apply it.
    expect(needsApproval({ totalBefore: 338, totalAfter: 338 })).toBe(false);
  });
});

describe('a request does not sit open forever', () => {
  it('lapses a week after it was raised', () => {
    expect(expiresAt('2026-08-13T10:00:00Z')).toBe('2026-08-20T10:00:00.000Z');
  });

  it('waits two days before the superadmin may stand in', () => {
    expect(SUBSTITUTE_AFTER_HOURS).toBe(48);
  });
});
