import { describe, it, expect } from 'vitest';
import { planRateChange } from '../functions/lib/admin.js';

/** A generated bill, as the row actually comes back from D1. */
const bill = (over = {}) => ({
  id: 1, flat: '7D', consumption: 8, gas_amount: 500, other_charges: 0,
  additional_charges: 0, late_fee: 0, total: 500, status: 'unpaid', manual_total: 0, ...over,
});

describe('planning a rate change', () => {
  it('recalculates gas and total from the new rate', () => {
    // 8 kg at 62.50 = 500; at 78 = 624.
    const plan = planRateChange([bill()], { ratePerKg: 78 });
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].now).toBe(624);
    expect(plan.changes[0].was).toBe(500);
    expect(plan.changes[0].difference).toBe(124);
  });

  it('leaves a bill alone when the rate produces the same total', () => {
    const plan = planRateChange([bill()], { ratePerKg: 62.5 });
    expect(plan.changes).toHaveLength(0);
  });

  it('keeps other charges and an applied late fee', () => {
    const plan = planRateChange(
      [bill({ other_charges: 30, late_fee: 50, total: 580 })], { ratePerKg: 78 });
    expect(plan.changes[0].now).toBe(624 + 30 + 50);
  });

  it('rounds the new total up to a whole rupee', () => {
    const plan = planRateChange([bill({ consumption: 7.9 })], { ratePerKg: 62.5 });
    expect(Number.isInteger(plan.changes[0].now)).toBe(true);
  });

  it('refuses a rate that is not a positive number', () => {
    for (const bad of [0, -1, NaN, null, 'seventy']) {
      expect(() => planRateChange([bill()], { ratePerKg: bad }), String(bad)).toThrow(/DDP-BILL-005/);
    }
  });
});

describe('who ends up owing again', () => {
  it('flags a paid bill that got dearer', () => {
    const plan = planRateChange([bill({ status: 'paid' })], { ratePerKg: 78 });
    expect(plan.changes[0].owesAgain).toBe(true);
    expect(plan.totals.owesAgainCount).toBe(1);
    expect(plan.totals.owesAgainTotal).toBe(124);
  });

  it('does not call a paid bill that got cheaper a new debt', () => {
    // Cheaper leaves the resident in credit. Dressing that up as money owed
    // would have the treasurer chasing people who overpaid.
    const plan = planRateChange([bill({ status: 'paid' })], { ratePerKg: 50 });
    expect(plan.changes[0].owesAgain).toBe(false);
    expect(plan.changes[0].inCredit).toBe(true);
    expect(plan.totals.owesAgainCount).toBe(0);
    expect(plan.totals.inCreditTotal).toBe(100);
  });

  it('treats a waived bill as settled too', () => {
    const plan = planRateChange([bill({ status: 'waived' })], { ratePerKg: 78 });
    expect(plan.changes[0].owesAgain).toBe(true);
  });

  it('does not flag an unpaid bill as owing again — it was never settled', () => {
    for (const status of ['unpaid', 'initiated', 'awaiting']) {
      const plan = planRateChange([bill({ status })], { ratePerKg: 78 });
      expect(plan.changes[0].owesAgain, status).toBe(false);
    }
  });
});

describe('bills the superadmin set by hand', () => {
  it('skips them rather than overwriting a considered figure', () => {
    const plan = planRateChange(
      [bill({ manual_total: 1, total: 1 })], { ratePerKg: 78 });
    expect(plan.changes).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].why).toBe('manually adjusted');
  });
});

describe('the totals the caveat is built from', () => {
  it('counts each group separately and nets the difference', () => {
    const plan = planRateChange([
      bill({ id: 1, flat: '7D', status: 'paid' }),                     // +124, owes again
      bill({ id: 2, flat: '8E', status: 'unpaid' }),                   // +124, never settled
      bill({ id: 3, flat: '5D', status: 'paid', consumption: 16, total: 1000 }), // dearer too
      bill({ id: 4, flat: '11A', manual_total: 1 }),                   // skipped
    ], { ratePerKg: 78 });

    expect(plan.totals.billsAffected).toBe(3);
    expect(plan.totals.skipped).toBe(1);
    expect(plan.totals.owesAgainCount).toBe(2);
    expect(plan.totals.netDifference).toBe(124 + 124 + 248);
  });

  it('reports nothing to do when the month has no bills yet', () => {
    const plan = planRateChange([], { ratePerKg: 78 });
    expect(plan.totals.billsAffected).toBe(0);
    expect(plan.totals.owesAgainCount).toBe(0);
    expect(plan.totals.netDifference).toBe(0);
  });
});
