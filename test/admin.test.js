import { describe, it, expect } from 'vitest';
import {
  nextPeriod, previousPeriod, readMonthFor, parseReadings, normaliseFlat, jumpWarning,
} from '../functions/lib/admin.js';

describe('period arithmetic', () => {
  it('steps forward and back', () => {
    expect(nextPeriod('2026-06')).toBe('2026-07');
    expect(previousPeriod('2026-06')).toBe('2026-05');
  });

  it('crosses the year boundary in both directions', () => {
    expect(nextPeriod('2026-12')).toBe('2027-01');
    expect(previousPeriod('2026-01')).toBe('2025-12');
  });

  it('knows the meter closing a month is read the month after', () => {
    // The treasurer walks the building in July and enters JUNE's readings.
    expect(readMonthFor('2026-06')).toBe('2026-07');
    expect(readMonthFor('2026-12')).toBe('2027-01');
  });
});

describe('flat name normalisation', () => {
  it('accepts the ways a treasurer actually types a flat', () => {
    for (const input of ['4A', '4a', '4 A', '4-A', ' 4a ']) {
      expect(normaliseFlat(input)).toBe('4A');
    }
  });
});

describe('parsing a pasted month', () => {
  const flats = ['4A', '4B', '4C', '5A', '5B'];

  it('reads tab-separated columns straight out of a spreadsheet', () => {
    const { rows, errors } = parseReadings('4A\t5.817\n4B\t2.940\n5B\t4.221', flats);
    expect(rows).toEqual([
      { flat: '4A', reading: 5.817 },
      { flat: '4B', reading: 2.940 },
      { flat: '5B', reading: 4.221 },
    ]);
    expect(errors).toEqual([]);
  });

  it('copes with commas, extra spaces and blank lines', () => {
    const { rows } = parseReadings('4A, 5.817\n\n 4b   2.940 \n', flats);
    expect(rows).toEqual([
      { flat: '4A', reading: 5.817 },
      { flat: '4B', reading: 2.940 },
    ]);
  });

  it('surfaces an unknown flat rather than silently dropping it', () => {
    // Silently dropping is how a flat never gets billed and nobody notices.
    const { rows, errors } = parseReadings('4A\t5.817\n9F\t2.110', flats);
    expect(rows).toHaveLength(1);
    expect(errors).toEqual([{ line: '9F\t2.110', flat: '9F', reason: 'unknown-flat' }]);
  });

  it('flags a duplicated flat instead of letting the last one win quietly', () => {
    const { rows, errors } = parseReadings('4A\t5.817\n4A\t9.999', flats);
    expect(rows).toHaveLength(1);
    expect(errors[0].reason).toBe('duplicate');
  });

  it('rejects a non-numeric reading', () => {
    const { errors } = parseReadings('4A\tn/a', flats);
    expect(errors[0].reason).toBe('not-a-number');
  });

  it('rejects a line with no reading at all', () => {
    expect(parseReadings('4A', flats).errors[0].reason).toBe('malformed');
  });

  it('strips stray currency or unit characters', () => {
    expect(parseReadings('4A\t5.817 m3', flats).rows[0].reading).toBe(5.817);
  });

  it('never writes — it only ever returns a draft', () => {
    const result = parseReadings('4A\t5.817', flats);
    expect(Object.keys(result).sort()).toEqual(['errors', 'rows']);
  });
});

describe('implausible jump warning', () => {
  const history = [4.38, 4.19, 3.98, 2.01];

  it('stays quiet for an ordinary month', () => {
    expect(jumpWarning(4.5, history)).toBe(null);
  });

  it('warns when consumption is wildly above this flat\'s own average', () => {
    const w = jumpWarning(40, history);
    expect(w.level).toBe('warn');
    expect(w.multiple).toBeGreaterThan(3);
  });

  it('says nothing without enough history to judge against', () => {
    expect(jumpWarning(40, [])).toBe(null);
    expect(jumpWarning(40, [4.38])).toBe(null);
  });

  it('warns rather than blocks — a genuine spike must be enterable', () => {
    // Returning a warning object, not throwing, is the contract.
    expect(() => jumpWarning(999, history)).not.toThrow();
  });
});
