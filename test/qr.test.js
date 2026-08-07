import { describe, it, expect } from 'vitest';
import jsQR from 'jsqr';
import { qrMatrix, qrToRgba, QUIET_ZONE } from '../functions/lib/qr.js';
import { buildUpiLinks } from '../functions/lib/upi.js';

/**
 * These tests decode with an INDEPENDENT decoder rather than checking that the
 * output looks QR-shaped. A resident scans this to pay real money; "it renders
 * a grid of squares" is not evidence that it scans, let alone that it scans to
 * the right amount.
 */
const decode = (text) => {
  const { data, width, height } = qrToRgba(text);
  const result = jsQR(data, width, height);
  return result?.data ?? null;
};

const upi = (amount) => buildUpiLinks({
  vpa: 'qr.ddwelfare@sib',
  payee: 'DD Diamond Park RWA',
  amount,
  flat: '4A',
  period: '2026-06',
}).qr;

describe('the QR actually scans back to what we encoded', () => {
  it('round-trips a real bill URI', () => {
    const uri = upi(329.04);
    expect(decode(uri)).toBe(uri);
  });

  it('carries the exact paise — the flat identifier survives the encode', () => {
    const decoded = decode(upi(329.04));
    expect(decoded).toContain('am=329.04');
    expect(decoded).not.toContain('am=329.0&');
  });

  it('regenerates correctly once a late fee is added', () => {
    // 329.04 + Rs 50 -> 379.04, and the QR must follow the new total.
    const uri = upi(379.04);
    expect(decode(uri)).toBe(uri);
    expect(decode(uri)).toContain('am=379.04');
  });

  it('round-trips across the range of plausible bills', () => {
    for (const amount of [1.04, 35.04, 329.04, 1588.51, 9999.99]) {
      const uri = upi(amount);
      expect(decode(uri), `failed at ${amount}`).toBe(uri);
    }
  });

  it('preserves the payee VPA exactly, including the @', () => {
    expect(decode(upi(329.04))).toContain('pa=qr.ddwelfare%40sib');
  });

  it('two different amounts never produce the same code', () => {
    expect(decode(upi(329.04))).not.toBe(decode(upi(329.05)));
  });
});

describe('matrix shape', () => {
  it('is square and non-empty', () => {
    const { size, modules } = qrMatrix(upi(329.04));
    expect(size).toBeGreaterThan(20);
    expect(modules).toHaveLength(size);
    expect(modules.every((row) => row.length === size)).toBe(true);
  });

  it('has the three finder patterns a scanner looks for', () => {
    const { size, modules } = qrMatrix(upi(329.04));
    const finder = (ox, oy) => modules[oy][ox] && modules[oy + 6][ox] &&
                               modules[oy][ox + 6] && !modules[oy + 1][ox + 1];
    expect(finder(0, 0)).toBe(true);              // top-left
    expect(finder(size - 7, 0)).toBe(true);       // top-right
    expect(finder(0, size - 7)).toBe(true);       // bottom-left
  });

  it('includes the four-module quiet zone the spec requires', () => {
    // Many scanners fail without it, and it is invisible in a screenshot.
    const { width } = qrToRgba(upi(329.04), { scale: 1 });
    const { size } = qrMatrix(upi(329.04));
    expect(width).toBe(size + QUIET_ZONE * 2);
  });

  it('refuses to encode nothing rather than drawing an empty box', () => {
    expect(() => qrMatrix('')).toThrow();
  });
});
