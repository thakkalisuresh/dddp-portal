import { describe, it, expect } from 'vitest';
import {
  assertRateSetForPeriod, rateSanity, deriveRate, meterReconciliation,
  computeBill, computeConsumption, RATE_JUMP_THRESHOLD,
} from '../functions/lib/billing.js';

describe('the rate moves every month', () => {
  it('accepts a rate explicitly set for this period', () => {
    expect(assertRateSetForPeriod({ period: '2026-07', rate_per_kg: 75 })).toBe(true);
  });

  it('refuses to generate on an inherited rate', () => {
    // The worst failure this system can have: 52 bills that look completely
    // normal and are every one of them wrong.
    expect(() => assertRateSetForPeriod({ period: '2026-08', rate_per_kg: 75, rate_inherited: true }))
      .toThrow(/DDP-BILL-010/);
  });

  it('refuses to generate with no rate at all', () => {
    expect(() => assertRateSetForPeriod({ period: '2026-08' })).toThrow(/DDP-BILL-005/);
    expect(() => assertRateSetForPeriod({ period: '2026-08', rate_per_kg: 0 })).toThrow(/DDP-BILL-005/);
    expect(() => assertRateSetForPeriod(null)).toThrow(/DDP-BILL-005/);
  });

  it('keeps each bill on the rate it was issued at', () => {
    // April ran at 72, May at 75 — the April bill must not move when the rate does.
    const kg = computeConsumption(0.991, 0.218);
    const april = computeBill({ consumption: kg, ratePerKg: 72, paiseTag: 4 });
    const may = computeBill({ consumption: kg, ratePerKg: 75, paiseTag: 4 });
    expect(april.total).not.toBe(may.total);
    expect(april.gasAmount).toBeCloseTo(144.72, 2);
    expect(may.gasAmount).toBeCloseTo(150.75, 2);
  });
});

describe('rate sanity check', () => {
  it('stays quiet for an ordinary monthly move', () => {
    expect(rateSanity(78, 75).level).toBe('none');
    expect(rateSanity(70, 75).level).toBe('none');
  });

  it('warns on a fat-fingered rate rather than blocking it', () => {
    // 750 instead of 75 is the typo that would bill the building 10x.
    const r = rateSanity(750, 75);
    expect(r.level).toBe('notice');
    expect(r.ok).toBe(true); // a treasurer who means it can proceed
    expect(r.message).toMatch(/higher than last month/);
  });

  it('warns on a suspiciously large drop too', () => {
    expect(rateSanity(7.5, 75).level).toBe('notice');
  });

  it('rejects a zero or negative rate outright', () => {
    expect(rateSanity(0, 75).ok).toBe(false);
    expect(rateSanity(-5, 75).ok).toBe(false);
  });

  it('has nothing to compare against in the first month', () => {
    expect(rateSanity(75, null).level).toBe('none');
  });

  it('sits exactly on the threshold without tipping', () => {
    const boundary = 75 * (1 + RATE_JUMP_THRESHOLD) - 0.01;
    expect(rateSanity(boundary, 75).level).toBe('none');
  });
});

describe('deriving the rate from a bulk supplier invoice', () => {
  it('divides the invoice across the metered kilograms', () => {
    expect(deriveRate(15000, 200)).toBe(75);
  });

  it('rounds to paise', () => {
    expect(deriveRate(15007, 200)).toBe(75.04);
  });

  it('refuses nonsense inputs', () => {
    expect(() => deriveRate(0, 200)).toThrow(/DDP-BILL-005/);
    expect(() => deriveRate(15000, 0)).toThrow(/DDP-BILL-005/);
  });
});

describe('bulk meter vs sum of flats', () => {
  it('reports the loss the treasurer is actually spreading', () => {
    const r = meterReconciliation(210, 200);
    expect(r.gap).toBe(10);
    expect(r.percent).toBe(4.8);
    expect(r.impossible).toBe(false);
  });

  it('flags the physically impossible case', () => {
    // Flats cannot measure more than the bulk meter — a reading is wrong.
    expect(meterReconciliation(195, 200).impossible).toBe(true);
  });
});
