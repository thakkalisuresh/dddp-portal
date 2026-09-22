import { describe, it, expect } from 'vitest';
import {
  parseQuarter, isQuarterLabel, quarterOf, quarterRange, previousQuarter, nextQuarter,
  describeQuarter, quarterHasEnded,
  isResidentOn, tenantOn, ownerOn, assessFlat, rateFor, previewQuarter,
  dueDateFor, lateFeeDateFor, maintLateFeeDecision, applyMaintLateFee, isSettled,
  advanceCovers, furthestAdvance,
  flatVotingStatus, isVotingExemptOn,
  planOccupancyChange, tenancyReadiness,
  DEFAULT_OWNER_RATE, DEFAULT_TENANT_RATE, DEFAULT_LATE_FEE, DUE_DAYS,
} from '../functions/lib/maint.js';

/** The Q4 2026 quarter as the committee set it: issued 1 Oct, due the 11th. */
const Q4 = { quarter: '2026-Q4', owner_rate: 7500, tenant_rate: 9000, late_fee: 750 };

const owner  = (over = {}) => ({ id: 1, name: 'Owner',  relationship: 'owner',  active: 1, ...over });
const tenant = (over = {}) => ({ id: 2, name: 'Tenant', relationship: 'tenant', active: 1, ...over });

describe('quarter labels', () => {
  it('reads and rejects the YYYY-Qn form', () => {
    expect(parseQuarter('2026-Q4')).toEqual({ year: 2026, quarter: 4 });
    expect(isQuarterLabel('2026-Q4')).toBe(true);
    expect(isQuarterLabel('2026-Q5')).toBe(false);
    expect(isQuarterLabel('2026-10')).toBe(false);   // a gas period, not a quarter
    expect(() => parseQuarter('2026-Q5')).toThrow();
  });

  it('uses CALENDAR quarters, not a financial year', () => {
    // Q1 is Jan–Mar. An Indian financial year would start Q1 in April, and
    // getting this wrong shifts every bill by one quarter.
    expect(quarterOf('2026-01-01')).toBe('2026-Q1');
    expect(quarterOf('2026-03-31')).toBe('2026-Q1');
    expect(quarterOf('2026-04-01')).toBe('2026-Q2');
    expect(quarterOf('2026-10-01')).toBe('2026-Q4');
    expect(quarterOf('2026-12-31')).toBe('2026-Q4');
  });

  it('knows each quarter’s first and last day, including February', () => {
    expect(quarterRange('2026-Q4')).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    expect(quarterRange('2026-Q1')).toEqual({ start: '2026-01-01', end: '2026-03-31' });
    // 2028 is a leap year; Q1 still ends on the 31st of March either way, so
    // the case that would actually catch a month-length table is Q1's end.
    expect(quarterRange('2026-Q2').end).toBe('2026-06-30');
    expect(quarterRange('2026-Q3').end).toBe('2026-09-30');
  });

  it('steps across the year boundary in both directions', () => {
    expect(previousQuarter('2027-Q1')).toBe('2026-Q4');
    expect(nextQuarter('2026-Q4')).toBe('2027-Q1');
    expect(previousQuarter('2026-Q4')).toBe('2026-Q3');
  });

  it('describes a quarter the one way residents see it', () => {
    expect(describeQuarter('2026-Q4')).toBe('Q4 2026 (Oct–Dec)');
    expect(describeQuarter('2027-Q1')).toBe('Q1 2027 (Jan–Mar)');
  });

  it('sorts chronologically as plain strings', () => {
    // The whole reason for the label's shape. advanceCovers and the voting rule
    // both compare labels directly.
    expect(['2027-Q1', '2026-Q4', '2026-Q1'].sort())
      .toEqual(['2026-Q1', '2026-Q4', '2027-Q1']);
  });

  it('ends a quarter on its last day, not before it', () => {
    expect(quarterHasEnded('2026-Q4', '2026-12-31')).toBe(false);  // still Q4
    expect(quarterHasEnded('2026-Q4', '2027-01-01')).toBe(true);
    expect(quarterHasEnded('2026-Q3', '2026-10-01')).toBe(true);
  });
});

describe('who is billed, and at which rate', () => {
  it('bills the owner at the owner rate when nobody rents the flat', () => {
    const a = assessFlat({ flat: '4A', people: [owner()], issueDate: '2026-10-01' });
    expect(a.bill).toBe(true);
    expect(a.basis).toBe('owner');
    expect(a.billedTo.id).toBe(1);
    expect(rateFor(a.basis, Q4)).toBe(7500);
  });

  it('bills the TENANT, at the tenant rate, when one is on the record', () => {
    const a = assessFlat({ flat: '4A', people: [owner(), tenant()], issueDate: '2026-10-01' });
    expect(a.basis).toBe('tenant');
    expect(a.billedTo.id).toBe(2);       // the tenant carries it
    expect(a.owner.id).toBe(1);          // the owner is still liable, and sees it
    expect(rateFor(a.basis, Q4)).toBe(9000);
  });

  it('raises NO bill for a flat with no registered owner', () => {
    // The builder still holds unsold flats. A bill against nobody is a debt the
    // association cannot collect and a dues line that never clears.
    const a = assessFlat({ flat: '12F', people: [], issueDate: '2026-10-01' });
    expect(a.bill).toBe(false);
    expect(a.reason).toBe('no-owner');
  });

  it('calls out a tenant with no owner separately — it is a fault, not an empty flat', () => {
    const a = assessFlat({ flat: '12F', people: [tenant()], issueDate: '2026-10-01' });
    expect(a.bill).toBe(false);
    expect(a.reason).toBe('tenant-no-owner');
  });

  it('decides on the ISSUE DATE, so a flat let mid-quarter is rented for all of it', () => {
    const people = [owner(), tenant({ moved_in_at: '2026-10-03' })];
    // Issued on the 1st: the tenant is not there yet, so it is an owner quarter.
    expect(assessFlat({ flat: '4A', people, issueDate: '2026-10-01' }).basis).toBe('owner');
    // Issued on the 5th: rented, and it stays rented for the whole quarter.
    expect(assessFlat({ flat: '4A', people, issueDate: '2026-10-05' }).basis).toBe('tenant');
  });

  it('picks the lowest id when a flat has several owners', () => {
    // Three owners on a jointly held flat share one bill; an unordered SELECT
    // would move whose name is on it between quarters.
    const people = [owner({ id: 9 }), owner({ id: 3 }), owner({ id: 5 })];
    expect(ownerOn(people, '2026-10-01').id).toBe(3);
  });

  it('ignores people who have left', () => {
    const gone = tenant({ moved_out_at: '2026-09-30' });
    expect(tenantOn([gone], '2026-10-01')).toBe(null);
    expect(assessFlat({ flat: '4A', people: [owner(), gone], issueDate: '2026-10-01' }).basis)
      .toBe('owner');
  });

  it('DOES NOT let an expired lease change the rate', () => {
    // The rule this file exists to protect. A lapsed lease with the tenant
    // still in the flat is the common case here; treating it as owner-occupied
    // would bill 7,500 for a rented flat. lease_ends_at is a data-quality
    // signal, surfaced by tenancyReadiness, never an occupancy fact.
    const stale = tenant({ lease_ends_at: '2026-03-31' });
    expect(isResidentOn(stale, '2026-10-01')).toBe(true);
    expect(assessFlat({ flat: '4A', people: [owner(), stale], issueDate: '2026-10-01' }).basis)
      .toBe('tenant');
    expect(rateFor('tenant', Q4)).toBe(9000);
  });

  it('reads the rate from the quarter, not from the constants', () => {
    // Rates are editable per quarter; a revision must not reach backwards.
    const raised = { ...Q4, owner_rate: 8000, tenant_rate: 9500 };
    expect(rateFor('owner', raised)).toBe(8000);
    expect(rateFor('tenant', raised)).toBe(9500);
    // The constants are only what a NEW quarter is born with.
    expect(DEFAULT_OWNER_RATE).toBe(7500);
    expect(DEFAULT_TENANT_RATE).toBe(9000);
    expect(DEFAULT_LATE_FEE).toBe(750);
  });

  it('refuses a quarter with a missing or fractional rate', () => {
    expect(() => rateFor('owner', { quarter: '2026-Q4' })).toThrow();
    expect(() => rateFor('owner', { ...Q4, owner_rate: 0 })).toThrow();
    expect(() => rateFor('owner', { ...Q4, owner_rate: 7500.5 })).toThrow();
    expect(() => rateFor('neither', Q4)).toThrow();
  });
});

describe('previewQuarter — the number the treasurer confirms', () => {
  const rows = [
    { flat: '4A', people: [owner({ id: 1 })] },
    { flat: '4B', people: [owner({ id: 2 }), tenant({ id: 3 })] },
    { flat: '4C', people: [owner({ id: 4 }), tenant({ id: 5 })] },
    { flat: '12F', people: [] },                        // unsold
    { flat: '9D', people: [tenant({ id: 6 })] },         // fault: nobody liable
  ];

  it('totals what will actually be billed, and says how it splits', () => {
    const p = previewQuarter({ rows, quarter: Q4, issueDate: '2026-10-01' });
    expect(p.willBill).toBe(3);
    expect(p.ownerCount).toBe(1);
    expect(p.tenantCount).toBe(2);
    expect(p.total).toBe(7500 + 9000 + 9000);
    expect(p.dueDate).toBe('2026-10-11');
  });

  it('separates the unsold flat from the one that needs a human', () => {
    const p = previewQuarter({ rows, quarter: Q4, issueDate: '2026-10-01' });
    expect(p.skipped.map((s) => s.flat).sort()).toEqual(['12F', '9D']);
    // Only the tenant-with-no-owner is unresolved. An unsold flat is normal.
    expect(p.unresolved.map((s) => s.flat)).toEqual(['9D']);
  });

  it('names the rented flats, because that count has never been audited', () => {
    const p = previewQuarter({ rows, quarter: Q4, issueDate: '2026-10-01' });
    expect(p.tenantedFlats).toEqual(['4B', '4C']);
  });
});

describe('dates and the late fee', () => {
  it('is due ten days after issue', () => {
    expect(DUE_DAYS).toBe(10);
    expect(dueDateFor('2026-10-01')).toBe('2026-10-11');
  });

  it('crosses a month end correctly', () => {
    expect(dueDateFor('2026-12-26')).toBe('2027-01-05');
  });

  it('charges the fee the day AFTER the due date — not on it, unlike gas', () => {
    // lib/billing.js charges gas ON the due date at 00:00. The maintenance rule
    // as the committee stated it makes the due date itself payable. Two rules,
    // implemented as stated rather than harmonised.
    expect(lateFeeDateFor('2026-10-11')).toBe('2026-10-12');

    const bill = { total: 9000, status: 'unpaid' };
    const at = (today) => maintLateFeeDecision(bill, { today, dueDate: '2026-10-11' });
    expect(at('2026-10-10').action).toBe('skip');
    expect(at('2026-10-11').action).toBe('skip');   // the due date is still payable
    expect(at('2026-10-11').reason).toBe('not-yet-due');
    expect(at('2026-10-12').action).toBe('charge');
  });

  it('applies once and never compounds', () => {
    const charged = { total: 9750, status: 'unpaid', late_fee_at: '2026-10-12T03:00:00Z' };
    const d = maintLateFeeDecision(charged, { today: '2026-11-30', dueDate: '2026-10-11' });
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('already-applied');
  });

  it('skips a settled bill, whatever the date', () => {
    for (const status of ['paid', 'waived', 'cancelled']) {
      const d = maintLateFeeDecision({ total: 9000, status }, { today: '2026-12-01', dueDate: '2026-10-11' });
      expect(d).toEqual({ action: 'skip', reason: 'settled' });
    }
  });

  it('CHARGES a bill that is merely claimed — tapping Pay is not paying', () => {
    // The gas twin of this is CLAIM_HOLD_DAYS, which exists because an
    // unbounded hold on `initiated` was an exemption anybody could grant
    // themselves. Maintenance has no hold at all: the fee lands and a waiver is
    // the documented way back, with two admins on it.
    for (const status of ['unpaid', 'initiated', 'awaiting']) {
      expect(maintLateFeeDecision({ total: 9000, status }, { today: '2026-10-12', dueDate: '2026-10-11' }).action)
        .toBe('charge');
    }
  });

  it('freezes the clock while two admins are deciding', () => {
    const d = maintLateFeeDecision(
      { total: 9000, status: 'unpaid', pending_approval: 1 },
      { today: '2026-11-01', dueDate: '2026-10-11' },
    );
    expect(d).toEqual({ action: 'skip', reason: 'approval-pending' });
  });

  it('never charges a fee on a bill for nothing', () => {
    const d = maintLateFeeDecision({ total: 0, status: 'unpaid' }, { today: '2026-12-01', dueDate: '2026-10-11' });
    expect(d).toEqual({ action: 'skip', reason: 'nothing-owed' });
  });

  it('honours an exemption, inclusive of its end date, and reports it as such', () => {
    const bill = { total: 9000, status: 'unpaid' };
    const opts = { dueDate: '2026-10-11', exemptUntil: '2026-11-30' };
    expect(maintLateFeeDecision(bill, { ...opts, today: '2026-11-30' }))
      .toEqual({ action: 'skip', reason: 'exempt' });
    expect(maintLateFeeDecision(bill, { ...opts, today: '2026-12-01' }).action).toBe('charge');
  });

  it('adds a whole-rupee fee and refuses anything else', () => {
    expect(applyMaintLateFee(9000, 750)).toBe(9750);
    expect(() => applyMaintLateFee(9000, 750.5)).toThrow();
    expect(() => applyMaintLateFee(9000, -750)).toThrow();
    expect(() => applyMaintLateFee(9000, NaN)).toThrow();
  });

  it('counts only paid, waived and cancelled as settled', () => {
    expect(isSettled({ status: 'paid' })).toBe(true);
    expect(isSettled({ status: 'awaiting' })).toBe(false);
    expect(isSettled({ status: 'initiated' })).toBe(false);
  });
});

describe('advances', () => {
  const adv = (over = {}) => ({ paid_through: '2027-Q2', approved_by: 7, ...over });

  it('covers the named quarter inclusively, and everything before it', () => {
    expect(advanceCovers(adv(), '2026-Q4')).toBe(true);
    expect(advanceCovers(adv(), '2027-Q1')).toBe(true);
    expect(advanceCovers(adv(), '2027-Q2')).toBe(true);    // inclusive
    expect(advanceCovers(adv(), '2027-Q3')).toBe(false);
  });

  it('does not count until a second admin has approved it', () => {
    // Otherwise "record an advance" is a way for one admin to clear a flat's
    // dues — and, with the voting rule, hand its vote back.
    expect(advanceCovers(adv({ approved_by: null }), '2026-Q4')).toBe(false);
  });

  it('ignores a malformed or missing quarter rather than guessing', () => {
    expect(advanceCovers(adv({ paid_through: '2027-06' }), '2026-Q4')).toBe(false);
    expect(advanceCovers({ approved_by: 7 }, '2026-Q4')).toBe(false);
    expect(advanceCovers(null, '2026-Q4')).toBe(false);
  });

  it('picks the advance reaching furthest forward', () => {
    const all = [adv({ paid_through: '2026-Q4' }), adv({ paid_through: '2027-Q3' }), adv({ paid_through: '2027-Q1' })];
    expect(furthestAdvance(all).paid_through).toBe('2027-Q3');
    expect(furthestAdvance([adv({ approved_by: null })])).toBe(null);
    expect(furthestAdvance([])).toBe(null);
  });
});

describe('arrears block the flat’s vote', () => {
  const bill = (over = {}) => ({ quarter: '2026-Q3', status: 'unpaid', total: 9000, ...over });
  // A poll created in Q4. Q3 has ended; Q4 has not.
  const pollCreatedAt = '2026-11-01';

  it('blocks on an unpaid bill from an ENDED quarter', () => {
    const v = flatVotingStatus({ bills: [bill()], pollCreatedAt });
    expect(v.canVote).toBe(false);
    expect(v.reason).toBe('arrears');
    expect(v.owed).toBe(9000);
    expect(v.quarters).toEqual(['2026-Q3']);
  });

  it('NEVER blocks on the current quarter, even past its due date', () => {
    // A bill issued on 1 October cannot cost anybody a vote in November. Only a
    // quarter that has finished counts.
    const v = flatVotingStatus({ bills: [bill({ quarter: '2026-Q4' })], pollCreatedAt });
    expect(v.canVote).toBe(true);
    expect(v.reason).toBe('clear');
  });

  it('lets a paid or waived flat vote', () => {
    for (const status of ['paid', 'waived', 'cancelled']) {
      expect(flatVotingStatus({ bills: [bill({ status })], pollCreatedAt }).canVote).toBe(true);
    }
  });

  it('still blocks a flat that has only CLAIMED payment — but says so differently', () => {
    // The block lifts when the treasurer confirms, not when a resident taps
    // Pay or uploads an image. The message changes because telling someone who
    // has paid and uploaded proof that they are unpaid is wrong and
    // inflammatory; the block itself does not.
    for (const status of ['initiated', 'awaiting']) {
      const v = flatVotingStatus({ bills: [bill({ status })], pollCreatedAt });
      expect(v.canVote).toBe(false);
      expect(v.reason).toBe('arrears-claimed');
      expect(v.message).toMatch(/treasurer/);
    }
  });

  it('does not block while two admins are deciding the bill', () => {
    expect(flatVotingStatus({ bills: [bill({ pending_approval: 1 })], pollCreatedAt }).canVote).toBe(true);
  });

  it('sums several ended quarters and lists them in order', () => {
    const v = flatVotingStatus({
      bills: [bill({ quarter: '2026-Q3' }), bill({ quarter: '2026-Q2', total: 7500 }), bill({ quarter: '2026-Q4' })],
      pollCreatedAt,
    });
    expect(v.owed).toBe(16500);
    expect(v.quarters).toEqual(['2026-Q2', '2026-Q3']);   // Q4 is current
  });

  it('is overridden by a committee exemption, and reports that as the reason', () => {
    const exemption = { approved_by: 7, ends_at: '2026-12-31' };
    const v = flatVotingStatus({ bills: [bill()], pollCreatedAt, exemption });
    expect(v.canVote).toBe(true);
    expect(v.reason).toBe('exempt');
  });

  it('ignores an exemption that is unapproved or expired', () => {
    const bills = [bill()];
    expect(flatVotingStatus({ bills, pollCreatedAt, exemption: { approved_by: null, ends_at: '2026-12-31' } }).canVote)
      .toBe(false);
    expect(flatVotingStatus({ bills, pollCreatedAt, exemption: { approved_by: 7, ends_at: '2026-10-01' } }).canVote)
      .toBe(false);
  });

  it('accepts an open-ended exemption, but only an approved one', () => {
    expect(isVotingExemptOn({ approved_by: 7, ends_at: null }, '2030-01-01')).toBe(true);
    expect(isVotingExemptOn({ approved_by: null, ends_at: null }, '2026-11-01')).toBe(false);
    expect(isVotingExemptOn(null, '2026-11-01')).toBe(false);
  });

  it('is evaluated on read, so paying mid-poll unlocks the vote', () => {
    const before = flatVotingStatus({ bills: [bill()], pollCreatedAt });
    const after  = flatVotingStatus({ bills: [bill({ status: 'paid' })], pollCreatedAt });
    expect(before.canVote).toBe(false);
    expect(after.canVote).toBe(true);
  });

  it('does not care about gas at all', () => {
    // A gas bill has a `period`, not a `quarter`. It cannot reach this list, and
    // if one did it would be ignored rather than silently blocking a vote.
    const gas = { period: '2026-08', status: 'unpaid', total: 329 };
    expect(flatVotingStatus({ bills: [gas], pollCreatedAt }).canVote).toBe(true);
  });
});

describe('the household changes mid-quarter', () => {
  const o = owner({ id: 1 });
  const unpaid = { id: 50, owner_id: 2, status: 'unpaid', rate_applied: 9000, total: 9000 };

  it('re-rates 9,000 down to 7,500 and moves it to the owner — with approval', () => {
    const p = planOccupancyChange({ bill: unpaid, change: 'tenant-to-owner', quarter: Q4, owner: o });
    expect(p.action).toBe('re-rate');
    expect(p.rate).toBe(7500);
    expect(p.total).toBe(7500);
    expect(p.billedTo).toBe(1);
    expect(p.reassignedFrom).toBe(2);     // the departed tenant, not lost
    expect(p.needsApproval).toBe(true);
  });

  it('leaves a PAID bill closed — no re-rate, no refund', () => {
    const paid = { ...unpaid, status: 'paid' };
    const p = planOccupancyChange({ bill: paid, change: 'tenant-to-owner', quarter: Q4, owner: o });
    expect(p.action).toBe('none');
    expect(p.reason).toBe('settled');
    expect(p.needsApproval).toBe(false);
  });

  it('keeps 9,000 when one tenant replaces another, and refuses to guess who pays', () => {
    const incoming = tenant({ id: 3 });
    const p = planOccupancyChange({ bill: unpaid, change: 'tenant-to-tenant', quarter: Q4, owner: o, incomingTenant: incoming });
    expect(p.action).toBe('reassign');
    expect(p.rate).toBe(9000);
    expect(p.billedTo).toBe(null);        // an admin picks; a second approves
    expect(p.choices).toEqual([1, 3]);
    expect(p.needsApproval).toBe(true);
  });

  it('does NOT raise an owner quarter to 9,000 when the flat is let mid-quarter', () => {
    // The mirror of "let on 3 October is rented for all of Q4": the rate is
    // fixed on the issue date, so the 9,000 starts next quarter.
    const p = planOccupancyChange({
      bill: { ...unpaid, rate_applied: 7500, total: 7500 },
      change: 'owner-to-tenant', quarter: Q4, owner: o,
    });
    expect(p.action).toBe('none');
    expect(p.reason).toBe('rate-fixed-for-quarter');
  });

  it('stops the emails to the departed tenant and writes to the owner', () => {
    const p = planOccupancyChange({ bill: unpaid, change: 'tenant-to-owner', quarter: Q4, owner: o });
    expect(p.emailsTo).toEqual([1]);
  });

  it('refuses a change it does not recognise', () => {
    expect(() => planOccupancyChange({ bill: unpaid, change: 'something-else', quarter: Q4, owner: o }))
      .toThrow();
  });
});

describe('tenancy readiness gates the schedule', () => {
  it('blocks on a lease that ended before the issue date', () => {
    const rows = [{ flat: '4B', people: [owner(), tenant({ lease_ends_at: '2026-03-31' })] }];
    const r = tenancyReadiness({ rows, issueDate: '2026-10-01' });
    expect(r.ok).toBe(false);
    expect(r.expired).toHaveLength(1);
    expect(r.expired[0].flat).toBe('4B');
    expect(r.message).toMatch(/rented rate/);
  });

  it('WARNS about an undated lease without blocking', () => {
    // Most rows have no end date until the roster is filled in. Refusing to
    // bill the building until every one is entered would miss the quarter.
    const rows = [{ flat: '4B', people: [owner(), tenant()] }];
    const r = tenancyReadiness({ rows, issueDate: '2026-10-01' });
    expect(r.ok).toBe(true);
    expect(r.undated).toHaveLength(1);
    expect(r.message).toBe(null);
  });

  it('says nothing about owners, or about tenants who have already left', () => {
    const rows = [
      { flat: '4A', people: [owner({ lease_ends_at: '2020-01-01' })] },
      { flat: '4C', people: [owner(), tenant({ active: 0, lease_ends_at: '2026-03-31' })] },
    ];
    const r = tenancyReadiness({ rows, issueDate: '2026-10-01' });
    expect(r.ok).toBe(true);
    expect(r.expired).toHaveLength(0);
    expect(r.undated).toHaveLength(0);
  });

  it('is clean for a building with a current lease on file', () => {
    const rows = [{ flat: '4B', people: [owner(), tenant({ lease_ends_at: '2027-03-31' })] }];
    const r = tenancyReadiness({ rows, issueDate: '2026-10-01' });
    expect(r.ok).toBe(true);
    expect(r.undated).toHaveLength(0);
  });
});
