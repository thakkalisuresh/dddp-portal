import { describe, it, expect } from 'vitest';
import {
  shapeMaintBill, asGasCard, toPay, comingUp, recentlyPaid, waitingForYou, votingCard,
  RECENT_LIMIT, RECENT_DAYS,
} from '../functions/lib/maint-home.js';

const Q4 = { quarter: '2026-Q4', due_date: '2026-10-11', late_fee: 750 };

const mbill = (over = {}) => ({
  id: 1, flat: '2B', quarter: '2026-Q4', basis: 'owner', rate_applied: 7500,
  late_fee: 0, late_fee_at: null, total: 7500, status: 'unpaid',
  paid_at: null, created_at: '2026-10-01', ...over,
});

/** A gas bill as lib/dashboard.js shapeBill() leaves it. */
const gbill = (over = {}) => ({
  id: 9, period: '2026-09', total: 412, status: 'unpaid', settled: false,
  dueDate: '2026-10-10', paidAt: null, displayStatus: 'unpaid', ...over,
});

describe('shapeMaintBill', () => {
  it('derives overdue from the due date rather than storing it', () => {
    expect(shapeMaintBill(mbill(), Q4, '2026-10-10').displayStatus).toBe('unpaid');
    // `>=` the due date: the day the fee is being charged must not still read
    // "due today" over a total that already includes the fee.
    expect(shapeMaintBill(mbill(), Q4, '2026-10-11').displayStatus).toBe('overdue');
  });

  it('keeps the settled statuses distinct instead of flattening them to paid', () => {
    // A waived bill and a cancelled one are different outcomes and the resident
    // is told which: one was forgiven, the other should never have existed.
    for (const status of ['paid', 'waived', 'cancelled']) {
      const card = shapeMaintBill(mbill({ status }), Q4, '2026-12-01');
      expect(card.settled).toBe(true);
      expect(card.displayStatus).toBe(status);
      expect(card.showPayButton).toBe(false);
    }
  });

  it('removes Pay once a screenshot is with the treasurer, keeps it after a bounced handoff', () => {
    // awaiting = proof uploaded. A second transfer for one bill is far more
    // work for the treasurer than a missing one.
    expect(shapeMaintBill(mbill({ status: 'awaiting' }), Q4, '2026-10-05').showPayButton).toBe(false);
    // initiated = an app opened, which proves nothing. They still need Pay.
    expect(shapeMaintBill(mbill({ status: 'initiated' }), Q4, '2026-10-05').showPayButton).toBe(true);
  });

  it('warns about the fee before it lands and stops once it has', () => {
    const before = shapeMaintBill(mbill(), Q4, '2026-10-05');
    expect(before.lateFeeWarning).toEqual({ amount: 750, after: '2026-10-12' });

    const charged = shapeMaintBill(mbill({ late_fee: 750, late_fee_at: '2026-10-12', total: 8250 }), Q4, '2026-10-13');
    expect(charged.lateFeeWarning).toBeNull();
    expect(charged.lateFee).toBe(750);
  });

  it('silences the fee warning while an approval is in flight', () => {
    // maintLateFeeDecision refuses to charge a bill under approval, so a card
    // that still threatened the fee would be threatening one that cannot land.
    const card = shapeMaintBill(mbill({ pending_approval: 1 }), Q4, '2026-10-05');
    expect(card.lateFeeWarning).toBeNull();
    expect(card.pendingApproval).toBe(true);
  });

  it('flags a bill settled from an advance, keeping the full amount', () => {
    // A flat that paid ahead is settled as 'paid' with paid_method 'advance'.
    // The card must carry its FULL total and a flag the screen turns into "Paid
    // in advance" — never a silent zero, never a bare "Paid" on a number the
    // resident may not remember owing.
    const card = shapeMaintBill(
      mbill({ status: 'paid', total: 7500, paid_method: 'advance', paid_at: '2026-10-01' }),
      Q4, '2026-10-05',
    );
    expect(card.settled).toBe(true);
    expect(card.settledByAdvance).toBe(true);
    expect(card.total).toBe(7500);          // the amount is shown, not zeroed
    expect(card.displayStatus).toBe('paid');
    expect(card.showPayButton).toBe(false);
  });

  it('does not flag an ordinary payment as an advance', () => {
    // paid_method is the only signal, so a bill paid the ordinary way — or by a
    // bank-statement match — must not read as "Paid in advance".
    expect(shapeMaintBill(mbill({ status: 'paid' }), Q4, '2026-10-05').settledByAdvance).toBe(false);
    expect(shapeMaintBill(
      mbill({ status: 'paid', paid_method: 'bank-statement' }), Q4, '2026-10-05',
    ).settledByAdvance).toBe(false);
  });
});

describe('toPay', () => {
  it('sorts by due date across both kinds rather than grouping by kind', () => {
    // The question the page answers is "what is next", not "what sort is it".
    const list = toPay([
      asGasCard(gbill({ dueDate: '2026-10-10' })),
      shapeMaintBill(mbill(), Q4, '2026-10-01'),          // due the 11th
    ], '2026-10-01');
    expect(list.map((c) => c.kind)).toEqual(['gas', 'maintenance']);
  });

  it('puts maintenance first when two bills fall due the same day', () => {
    // Not because it is the bigger number: missing it costs ₹750 where missing
    // the gas bill costs a fraction of that.
    const list = toPay([
      asGasCard(gbill({ dueDate: '2026-10-11' })),
      shapeMaintBill(mbill(), Q4, '2026-10-01'),
    ], '2026-10-01');
    expect(list.map((c) => c.kind)).toEqual(['maintenance', 'gas']);
  });

  it('sorts an undated bill last, never first', () => {
    // An undated bill is a data problem, and a data problem must not jump the
    // queue in front of a real deadline.
    const list = toPay([
      asGasCard(gbill({ dueDate: null })),
      shapeMaintBill(mbill(), Q4, '2026-10-01'),
    ], '2026-10-01');
    expect(list.map((c) => c.kind)).toEqual(['maintenance', 'gas']);
  });

  it('drops settled and cancelled bills', () => {
    const list = toPay([
      shapeMaintBill(mbill({ status: 'paid' }), Q4, '2026-12-01'),
      shapeMaintBill(mbill({ id: 2, status: 'cancelled' }), Q4, '2026-12-01'),
      shapeMaintBill(mbill({ id: 3 }), Q4, '2026-12-01'),
    ], '2026-12-01');
    expect(list.map((c) => c.id)).toEqual([3]);
  });

  it('never reports a combined total', () => {
    // The user rejected a single "you owe" figure, and the same reasoning keeps
    // the admin dues report split per bank account: a monthly bill and a
    // quarterly one are not summable. This test is the guard on that.
    const list = toPay([asGasCard(gbill()), shapeMaintBill(mbill(), Q4)], '2026-10-01');
    expect(Array.isArray(list)).toBe(true);
    expect(list).not.toHaveProperty('total');
  });

  it('is a total order — the same input always renders the same way', () => {
    const cards = [
      asGasCard(gbill({ dueDate: '2026-10-11' })),
      shapeMaintBill(mbill(), Q4, '2026-10-01'),
      shapeMaintBill(mbill({ id: 5, quarter: '2026-Q3', total: 9000 }),
        { due_date: '2026-10-11', late_fee: 750 }, '2026-10-01'),
    ];
    const once = toPay(cards, '2026-10-01').map((c) => `${c.kind}:${c.period}`);
    const again = toPay([...cards].reverse(), '2026-10-01').map((c) => `${c.kind}:${c.period}`);
    expect(again).toEqual(once);
  });
});

describe('comingUp', () => {
  const quarters = [
    { quarter: '2027-Q1', status: 'scheduled', issue_date: '2027-01-01', owner_rate: 7500, tenant_rate: 9000 },
  ];

  it('carries no amount, not even for a scheduled quarter whose rates are frozen', () => {
    // Considered and rejected: rates are editable per quarter, and a number a
    // resident has read is a number the committee will be held to.
    const [card] = comingUp({ quarters });
    expect(card.amount).toBeUndefined();
    expect(JSON.stringify(card)).not.toContain('7500');
  });

  it('shows the period and when it arrives', () => {
    const [card] = comingUp({ quarters });
    expect(card.periodLabel).toContain('Q1 2027');
    expect(card.issueDate).toBe('2027-01-01');
    expect(card.status).toBe('scheduled');
  });

  it('drops a quarter this flat has already been billed for', () => {
    expect(comingUp({ quarters, billedQuarters: ['2027-Q1'] })).toEqual([]);
  });

  it('ignores issued and locked quarters — those are bills, not forecasts', () => {
    expect(comingUp({ quarters: [{ quarter: '2026-Q4', status: 'issued' }] })).toEqual([]);
    expect(comingUp({ quarters: [{ quarter: '2026-Q3', status: 'locked' }] })).toEqual([]);
  });

  it('names the gas month that is coming, and the month its bill arrives in', () => {
    // A usage month is billed early in the month after it: October's gas is
    // read and billed in November.
    const cards = comingUp({ latestGasPeriod: '2026-09', gasPending: true });
    expect(cards).toEqual([{
      kind: 'gas', period: '2026-10', periodLabel: '2026-10', arrivesIn: '2026-11',
    }]);
  });

  it('rolls the year over', () => {
    const [card] = comingUp({ latestGasPeriod: '2026-11', gasPending: true });
    expect(card.period).toBe('2026-12');
    expect(card.arrivesIn).toBe('2027-01');
  });
});

describe('recentlyPaid', () => {
  const paid = (id, at, over = {}) =>
    shapeMaintBill(mbill({ id, status: 'paid', paid_at: at, ...over }), Q4, '2026-12-01');

  it('keeps at most three', () => {
    const list = recentlyPaid(
      ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'].map((d, i) => paid(i, d)),
      { today: '2026-11-10' });
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list).toHaveLength(3);
  });

  it('is newest first', () => {
    const list = recentlyPaid([paid(1, '2026-10-01'), paid(2, '2026-11-01')], { today: '2026-11-10' });
    expect(list.map((c) => c.id)).toEqual([2, 1]);
  });

  it('forgets anything older than the window', () => {
    // A count alone would show four cheerful cards from last autumn under a
    // heading that says "recently".
    expect(RECENT_DAYS).toBe(90);
    const list = recentlyPaid([paid(1, '2026-01-01')], { today: '2026-11-10' });
    expect(list).toEqual([]);
  });

  it('includes a waived bill and excludes a cancelled one', () => {
    // Waived is a closed outcome the resident should see. Cancelled is a bill
    // that should never have existed, and listing it under paid invites the
    // question of what happened to money that was never owed.
    const list = recentlyPaid([
      paid(1, '2026-11-01', { status: 'waived' }),
      paid(2, '2026-11-02', { status: 'cancelled' }),
    ], { today: '2026-11-10' });
    expect(list.map((c) => c.status)).toEqual(['waived']);
  });
});

describe('waitingForYou', () => {
  it('is two labelled groups with polls first', () => {
    const groups = waitingForYou({
      openPolls: [{ id: 3, title: 'Lift tender', closes_at: '2026-10-20' }],
      unreadNotices: 2,
    });
    expect(groups.map((g) => g.kind)).toEqual(['polls', 'notices']);
    expect(groups[0].items[0].href).toBe('/polls#poll-3');
    expect(groups[1].count).toBe(2);
  });

  it('is empty when there is nothing, so the section can be hidden', () => {
    expect(waitingForYou({})).toEqual([]);
    expect(waitingForYou({ unreadNotices: 0 })).toEqual([]);
  });
});

describe('votingCard', () => {
  it('passes the block through with the debt attached', () => {
    const card = votingCard({
      canVote: false, reason: 'arrears', message: 'placeholder',
      owed: 9750, quarters: ['2026-Q3'],
    });
    expect(card.canVote).toBe(false);
    expect(card.owed).toBe(9750);
    // Described, not the internal key: this is the resident-facing shape, and
    // "2026-Q3" reached the home page's voting card once already.
    expect(card.quarters).toEqual(['Q3 2026 (Jul–Sep)']);
    expect(card.quarters.join('')).not.toMatch(/\d{4}-Q\d/);
  });

  it('carries the blocking bills, so the locked poll card can offer a way out', () => {
    // Lost once already: routing the poll payload through this shaper dropped
    // billIds, and the locked card's Pay button vanished with them.
    const card = votingCard({ canVote: false, reason: 'arrears', owed: 9750, billIds: [7, 9] });
    expect(card.billIds).toEqual([7, 9]);
  });

  it('carries no person — the copy names the debt, never who owes it', () => {
    // A tenant's arrears lock the owner's vote. The one case where naming is
    // most tempting is the one where it does most damage.
    const card = votingCard({ canVote: false, reason: 'arrears', owed: 9750, quarters: ['2026-Q3'] });
    expect(Object.keys(card)).toEqual([
      'canVote', 'reason', 'message', 'owed', 'quarters', 'billIds', 'lateFee', 'claimedAt',
    ]);
  });
});
