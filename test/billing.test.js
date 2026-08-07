import { describe, it, expect } from 'vitest';
import {
  round2, paiseOf, isWholeRupees, computeConsumption, computeBill,
  applyLateFee, lateFeeDecision,
} from '../functions/lib/billing.js';

describe('the paise invariant', () => {
  it('stamps the flat tag onto the total', () => {
    // 4A: 4.38 kg at Rs 75 = 328.50, paise_tag 04 -> 329.04
    const { total } = computeBill({ consumption: 4.38, ratePerKg: 75, paiseTag: 4 });
    expect(total).toBe(329.04);
    expect(paiseOf(total)).toBe(4);
  });

  it('keeps the tag distinct for every flat at the same consumption', () => {
    const totals = [4, 5, 6, 17, 99].map(
      (tag) => computeBill({ consumption: 4.38, ratePerKg: 75, paiseTag: tag }).total
    );
    expect(new Set(totals).size).toBe(totals.length);
    expect(totals).toEqual([329.04, 329.05, 329.06, 329.17, 329.99]);
  });

  it('rejects a paise tag outside 1..99', () => {
    expect(() => computeBill({ consumption: 1, ratePerKg: 75, paiseTag: 0 })).toThrow(/DDP-BILL-004/);
    expect(() => computeBill({ consumption: 1, ratePerKg: 75, paiseTag: 100 })).toThrow(/DDP-BILL-004/);
  });
});

describe('late fees are whole rupees', () => {
  it('preserves the paise tag when a fee is applied', () => {
    // the whole reconciliation rests on this staying .04
    expect(applyLateFee(329.04, 50)).toBe(379.04);
    expect(paiseOf(applyLateFee(329.04, 50))).toBe(4);
  });

  it('refuses a fee carrying paise', () => {
    expect(() => applyLateFee(329.04, 50.5)).toThrow(/DDP-BILL-008/);
    expect(() => computeBill({ consumption: 4.38, ratePerKg: 75, lateFee: 0.5, paiseTag: 4 }))
      .toThrow(/DDP-BILL-008/);
  });

  // NOTE: the paise are preserved by the whole-rupee guard, not by any clever
  // arithmetic — mutation testing showed no input can distinguish a "rebuild
  // the total from the tag" implementation from plain addition. The guard below
  // is therefore the test that carries the invariant.

  it('survives repeated application arithmetic without drift', () => {
    let total = 329.04;
    for (let i = 0; i < 12; i++) total = applyLateFee(total, 50);
    expect(paiseOf(total)).toBe(4);
    expect(total).toBe(929.04);
  });

  it('recognises whole rupees regardless of float representation', () => {
    expect(isWholeRupees(50)).toBe(true);
    expect(isWholeRupees(0.1 + 0.2)).toBe(false);
    expect(isWholeRupees(NaN)).toBe(false);
  });
});

describe('late fee decision', () => {
  const due = '2026-08-10';
  const after = '2026-08-12';

  it('charges an untouched overdue bill', () => {
    const d = lateFeeDecision({ status: 'unpaid', late_fee_at: null }, { today: after, dueDate: due });
    expect(d.action).toBe('charge');
  });

  it('HOLDS a bill where the resident tapped Pay — approval lag is not their fault', () => {
    const d = lateFeeDecision({ status: 'initiated', late_fee_at: null }, { today: after, dueDate: due });
    expect(d.action).toBe('hold');
    expect(d.reason).toBe('payment-claimed');
  });

  it('never charges a bill with a proof under review', () => {
    const d = lateFeeDecision({ status: 'awaiting', late_fee_at: null }, { today: after, dueDate: due });
    expect(d.action).toBe('skip');
  });

  it('is idempotent — a second cron run does not charge again', () => {
    const bill = { status: 'unpaid', late_fee_at: '2026-08-11T03:00:00Z' };
    expect(lateFeeDecision(bill, { today: after, dueDate: due }).action).toBe('skip');
  });

  it('respects the grace window', () => {
    const bill = { status: 'unpaid', late_fee_at: null };
    expect(lateFeeDecision(bill, { today: '2026-08-12', dueDate: due, graceDays: 5 }).action).toBe('skip');
    expect(lateFeeDecision(bill, { today: '2026-08-16', dueDate: due, graceDays: 5 }).action).toBe('charge');
  });

  it('leaves settled bills alone', () => {
    for (const status of ['paid', 'waived']) {
      expect(lateFeeDecision({ status, late_fee_at: null }, { today: after, dueDate: due }).action)
        .toBe('skip');
    }
  });
});

describe('consumption', () => {
  it('differences cumulative readings', () => {
    expect(computeConsumption(5.817, 4.134)).toBe(1.68);
  });

  it('refuses a reading below the previous — meters do not run backwards', () => {
    expect(() => computeConsumption(6.1, 6.9)).toThrow(/DDP-BILL-002/);
  });

  it('rounds without float drift', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});
