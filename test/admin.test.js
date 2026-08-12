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

  /**
   * The template this app hands out has to be importable BY this app.
   *
   * It was not. `downloadTemplate` emits flat,floor,previous,reading and the
   * parser read everything before the last number as the flat name, so a
   * filled-in template asked for a flat called "4A 4 5.817" and every row
   * failed. Nothing caught it because every test here pasted two columns,
   * which is not the shape the app's own export produces.
   */
  describe('a filled-in template goes back in', () => {
    // Exactly the columns api.admin.downloadTemplate writes.
    const header = 'flat,floor,previous,reading';

    it('round-trips the template the app itself exports', () => {
      const { rows, errors } = parseReadings(
        `${header}\n4A,4,5.817,6.900\n4B,4,2.94,3.500`, flats);
      expect(rows).toEqual([
        { flat: '4A', reading: 6.900 },
        { flat: '4B', reading: 3.500 },
      ]);
      expect(errors).toEqual([]);
    });

    it('does not report the header row as a failure', () => {
      const { errors } = parseReadings(`${header}\n4A,4,5.817,6.900`, flats);
      expect(errors).toEqual([]);
    });

    it('treats a blank reading as not-yet-read, not as a bad row', () => {
      // The meter walk is done in passes; half a template is the normal state.
      const { rows, errors } = parseReadings(
        `${header}\n4A,4,5.817,6.900\n4B,4,2.94,`, flats);
      expect(rows).toEqual([{ flat: '4A', reading: 6.900 }]);
      expect(errors).toEqual([]);
    });

    it('reads columns by NAME, so their order does not matter', () => {
      const { rows } = parseReadings('reading,flat\n6.900,4A', flats);
      expect(rows).toEqual([{ flat: '4A', reading: 6.900 }]);
    });

    it('still catches an unknown flat when there is a header', () => {
      const { rows, errors } = parseReadings(`${header}\n9F,9,1.0,2.110`, flats);
      expect(rows).toEqual([]);
      expect(errors[0].reason).toBe('unknown-flat');
    });

    it('still catches a duplicate when there is a header', () => {
      const { errors } = parseReadings(
        `${header}\n4A,4,5.8,6.9\n4A,4,5.8,7.9`, flats);
      expect(errors[0].reason).toBe('duplicate');
    });

    it('reports a non-numeric reading in the named column', () => {
      const { errors } = parseReadings(`${header}\n4A,4,5.817,n/a`, flats);
      expect(errors[0].reason).toBe('not-a-number');
    });

    it('does not mistake a data row for a header', () => {
      // '4A 5.817' names no columns and carries a number; the heuristic path
      // must still own it, or every headerless paste breaks.
      const { rows } = parseReadings('4A\t5.817\n4B\t2.940', flats);
      expect(rows).toHaveLength(2);
    });
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
