import { describe, it, expect } from 'vitest';
import {
  round2, toWholeRupees, isWholeRupees, computeConsumption, meterDelta, computeBill,
  applyLateFee, lateFeeDecision,
} from '../functions/lib/billing.js';
import { floorOf, addFlat } from '../functions/lib/flats.js';

describe('totals round UP to the next whole rupee', () => {
  it('never asks for paise', () => {
    // 4.38 kg at Rs 75 = 328.50 -> Rs 329.
    expect(computeBill({ consumption: 4.38, ratePerKg: 75 }).total).toBe(329);
    expect(Number.isInteger(computeBill({ consumption: 4.38, ratePerKg: 75 }).total)).toBe(true);
  });

  it('rounds up, not to nearest — a single paisa over pushes to the next rupee', () => {
    // The rule the RWA stated: even 329.01 becomes 330. Math.round gives 329,
    // so this is the assertion that would catch a regression to plain rounding.
    expect(toWholeRupees(329.01)).toBe(330);
    expect(toWholeRupees(329.5)).toBe(330);
    expect(toWholeRupees(329.99)).toBe(330);
  });

  it('leaves an already-whole amount alone', () => {
    // Ceiling must not inflate an exact figure into the next rupee.
    expect(toWholeRupees(315)).toBe(315);
    expect(computeBill({ consumption: 4, ratePerKg: 75 }).total).toBe(300);
  });

  it('is not fooled by float representation', () => {
    // 0.1 + 0.2 is 0.30000000000000004; a naive Math.ceil turns Rs 315.3 worth
    // of float noise into Rs 316. round2 runs first precisely to stop that.
    expect(toWholeRupees(315 + 0.1 + 0.2 - 0.3)).toBe(315);
    expect(toWholeRupees(4.35 * 3)).toBe(14);   // 13.049999999999999
  });

  it('keeps the pre-rounding subtotal so a resident can check the sum', () => {
    // Rounding up must be visible as a line, not a discrepancy the resident
    // cannot reconcile against the rate they were told.
    const b = computeBill({ consumption: 4.38, ratePerKg: 75 });
    expect(b.gasAmount).toBe(328.5);
    expect(b.subtotal).toBe(328.5);
    expect(b.total).toBe(329);
  });

  it('rounds once at the end, not per charge', () => {
    // Three charges of .40 are Rs 1.20, so the total moves by 2 rupees, not 3.
    const b = computeBill({
      consumption: 0.4, ratePerKg: 1, otherCharges: 0.4, additionalCharges: 0.4,
    });
    expect(b.subtotal).toBe(1.2);
    expect(b.total).toBe(2);
  });
});

describe('late fees', () => {
  it('adds the fee and stays whole', () => {
    expect(applyLateFee(329, 50)).toBe(379);
  });

  it('accepts a fee carrying paise now that nothing is encoded in them', () => {
    // This used to throw DDP-BILL-008. The constraint existed only to protect
    // the paise tag, so it went with it — the ceiling absorbs the fraction.
    expect(applyLateFee(329, 50.5)).toBe(380);
  });

  it('rejects a negative or non-numeric fee', () => {
    expect(() => applyLateFee(329, -1)).toThrow(/DDP-BILL-008/);
    expect(() => applyLateFee(329, NaN)).toThrow(/DDP-BILL-008/);
  });

  it('does not compound or drift over repeated application', () => {
    let total = 329;
    for (let i = 0; i < 12; i++) total = applyLateFee(total, 50);
    expect(total).toBe(929);
  });

  it('recognises whole rupees regardless of float representation', () => {
    expect(isWholeRupees(50)).toBe(true);
    expect(isWholeRupees(0.1 + 0.2)).toBe(false);
    expect(isWholeRupees(NaN)).toBe(false);
  });
});

describe('consumption — the meter counts volume, the bill charges mass', () => {
  // These four cases are flat 4A's real history from the old portal. They are
  // the evidence for the 2.60 factor: treating the meter delta as kilograms
  // under-bills every flat by 2.6x, which is exactly the bug these catch.
  const LIVE = [
    { current: 5.817, previous: 4.134, kg: 4.38, rate: 75, gas: 328.50 },
    { current: 4.134, previous: 2.522, kg: 4.19, rate: 75, gas: 314.25 },
    { current: 2.522, previous: 0.991, kg: 3.98, rate: 75, gas: 298.50 },
    { current: 0.991, previous: 0.218, kg: 2.01, rate: 72, gas: 144.72 },
  ];

  it('reproduces the live portal to the paisa', () => {
    for (const c of LIVE) {
      expect(computeConsumption(c.current, c.previous)).toBeCloseTo(c.kg, 2);
    }
  });

  it('produces the same rupee amounts the old site billed', () => {
    for (const c of LIVE) {
      const consumption = computeConsumption(c.current, c.previous);
      const { gasAmount } = computeBill({ consumption, ratePerKg: c.rate });
      expect(gasAmount).toBeCloseTo(c.gas, 1);
    }
  });

  it('July 2026 comes out at the ₹329 the resident actually sees', () => {
    const consumption = computeConsumption(5.817, 4.134);
    expect(computeBill({ consumption, ratePerKg: 75 }).total).toBe(329);
  });

  it('bills the whole live history the way the old portal did', () => {
    // 314.25 -> 315 is the case that distinguishes ceiling from rounding to
    // nearest; the others agree either way, so this row is the real evidence.
    const billed = LIVE.map((c) =>
      computeBill({ consumption: computeConsumption(c.current, c.previous), ratePerKg: c.rate }).total);
    expect(billed).toEqual([329, 315, 299, 145]);
    expect(billed.map((t) => Math.round(t * 100) % 100)).toEqual([0, 0, 0, 0]);
  });

  it('keeps the raw meter movement separate from billable mass', () => {
    expect(meterDelta(5.817, 4.134)).toBe(1.683);
    expect(computeConsumption(5.817, 4.134)).toBe(4.38);
  });

  it('honours a per-period factor, since calorific value gets revised', () => {
    expect(computeConsumption(5.817, 4.134, 1)).toBe(1.68);
    expect(computeConsumption(5.817, 4.134, 2.5)).toBe(4.21);
  });

  it('refuses a reading below the previous — meters do not run backwards', () => {
    expect(() => computeConsumption(6.1, 6.9)).toThrow(/DDP-BILL-002/);
  });

  it('refuses a nonsensical conversion factor', () => {
    expect(() => computeConsumption(5.817, 4.134, 0)).toThrow(/DDP-BILL-005/);
    expect(() => computeConsumption(5.817, 4.134, -1)).toThrow(/DDP-BILL-005/);
  });

  it('rounds without float drift', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});

describe('adding a flat around the retired column', () => {
  it('reads the floor out of the label', () => {
    expect(floorOf('4A')).toBe(4);
    expect(floorOf('13E')).toBe(13);
    expect(floorOf(' 5B ')).toBe(5);
  });

  it('refuses a label it cannot place on a floor', () => {
    // Better to stop the import than to file someone on floor NaN.
    expect(() => floorOf('Penthouse')).toThrow(/DDP-ADMIN-007/);
    expect(() => floorOf('')).toThrow(/DDP-ADMIN-007/);
  });

  it('fills the dead column so callers never see it', async () => {
    // The point of addFlat: legacy_paise_tag is NOT NULL UNIQUE and nothing
    // reads it, so the INSERT must supply a value without the caller knowing.
    const seen = [];
    const env = { DB: {
      prepare(sql) {
        return {
          first: async () => ({ n: 3 }),
          bind: (...args) => ({ run: async () => seen.push({ sql, args }) }),
        };
      },
    } };
    await addFlat(env, '7C');
    expect(seen[0].args).toEqual(['7C', 7]);
    expect(seen[0].sql).toMatch(/legacy_paise_tag/);
    expect(seen[0].sql).toMatch(/ON CONFLICT\(flat\) DO NOTHING/);
  });

  it('refuses to exceed the cap the dead CHECK imposes', async () => {
    const env = { DB: { prepare: () => ({ first: async () => ({ n: 99 }) }) } };
    await expect(addFlat(env, '99Z')).rejects.toThrow(/DDP-ADMIN-008/);
  });
});
