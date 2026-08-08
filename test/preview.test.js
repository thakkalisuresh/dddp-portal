import { describe, it, expect } from 'vitest';
import { previewGeneration } from '../functions/lib/billing.js';

// A small building, with 4A's real readings among them.
const rows = [
  { flat: '4A', reading: 5.817, previous: 4.134 },
  { flat: '4B', reading: 2.940, previous: 2.020 },
  { flat: '5B', reading: 4.221, previous: 2.600 },
];

describe('what this month will bill, before anything is written', () => {
  it('totals the month so it can be checked against the supplier invoice', () => {
    // 4A 329 + 4B 180 + 5B 316
    const p = previewGeneration({ rows, ratePerKg: 75, previousRate: 75, expectedFlats: 3 });
    expect(p.willBill).toBe(3);
    expect(p.totalKg).toBe(10.98);
    expect(p.totalAmount).toBe(825);
    expect(p.canGenerate).toBe(true);
  });

  it('the headline total is exactly the sum of the individual bills', () => {
    // Checked as a relationship rather than a constant, so it stays true when
    // the fixtures change.
    const p = previewGeneration({ rows, ratePerKg: 75 });
    const perFlat = rows.map((r) =>
      previewGeneration({ rows: [r], ratePerKg: 75 }).totalAmount);
    const summed = Math.round(perFlat.reduce((a, b) => a + b, 0) * 100) / 100;
    expect(p.totalAmount).toBe(summed);
  });

  it('reproduces 4A at the rate the resident will see', () => {
    const p = previewGeneration({ rows, ratePerKg: 75, previousRate: 75 });
    expect(p.totalAmount).toBeGreaterThan(0);
    // 4.38 kg x Rs 75 = 328.50 -> Rs 329
    expect(previewGeneration({ rows: [rows[0]], ratePerKg: 75 }).largest).toBe(329);
  });

  it('scales with the rate, so an extra zero is impossible to miss', () => {
    const right = previewGeneration({ rows, ratePerKg: 75, previousRate: 75 });
    const typo  = previewGeneration({ rows, ratePerKg: 750, previousRate: 75 });
    expect(typo.totalAmount / right.totalAmount).toBeCloseTo(10, 0);
    expect(typo.rateSanity.level).toBe('warn');
  });

  it('surfaces the largest and smallest bill, where a transposed digit shows', () => {
    const withTypo = [...rows, { flat: '9F', reading: 99.9, previous: 1.0 }];
    const p = previewGeneration({ rows: withTypo, ratePerKg: 75 });
    expect(p.largest).toBeGreaterThan(p.smallest * 10);
  });
});

describe('generation is refused while anything is unresolved', () => {
  it('blocks a reading below the previous', () => {
    const bad = [...rows, { flat: '4C', reading: 6.1, previous: 6.9 }];
    const p = previewGeneration({ rows: bad, ratePerKg: 75, expectedFlats: 4 });
    expect(p.blocked).toEqual([{ flat: '4C', reason: 'DDP-BILL-002' }]);
    expect(p.canGenerate).toBe(false);
  });

  it('blocks a partial month — a missing flat silently never gets billed', () => {
    const p = previewGeneration({ rows, ratePerKg: 75, expectedFlats: 52 });
    expect(p.missing).toBe(49);
    expect(p.canGenerate).toBe(false);
  });

  it('blocks a zero rate', () => {
    const p = previewGeneration({ rows, ratePerKg: 0 });
    expect(p.rateSanity.ok).toBe(false);
    expect(p.canGenerate).toBe(false);
  });

  it('still allows a genuine large rate move once seen', () => {
    // A 25%+ jump warns but must not stop a treasurer who means it.
    const p = previewGeneration({ rows, ratePerKg: 100, previousRate: 75, expectedFlats: 3 });
    expect(p.rateSanity.level).toBe('warn');
    expect(p.canGenerate).toBe(true);
  });
});

describe('every previewed total is a whole rupee', () => {
  it('leaves no paise anywhere in the month', () => {
    const p = previewGeneration({ rows, ratePerKg: 75 });
    expect(p.willBill).toBe(3);
    // The treasurer reads these off the preview and types them nowhere else,
    // so a stray .04 here is a stray .04 on someone's bill.
    for (const v of [p.smallest, p.largest, p.totalAmount]) {
      expect(Number.isInteger(v), `${v} is not whole`).toBe(true);
    }
    expect(p.smallest).toBe(180);
    expect(p.largest).toBe(329);
  });
});
