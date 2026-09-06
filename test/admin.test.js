import { describe, it, expect } from 'vitest';
import {
  nextPeriod, previousPeriod, readMonthFor, parseReadings, normaliseFlat, jumpWarning, dropWarning,
  saveReadings,
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
    const header = 'flat,resident,previous,reading';

    it('round-trips the template the app itself exports', () => {
      const { rows, errors } = parseReadings(
        `${header}\n4A,Meera Menon,5.817,6.900\n4B,Rajesh Pillai,2.94,3.500`, flats);
      expect(rows).toEqual([
        { flat: '4A', reading: 6.900 },
        { flat: '4B', reading: 3.500 },
      ]);
      expect(errors).toEqual([]);
    });

    /**
     * A COMMA INSIDE A NAME USED TO IMPORT SILENTLY.
     *
     * The splitter had no notion of a quoted field, so "Nair, R" became two
     * cells and every column after it moved one to the left. `reading` then
     * held the PREVIOUS reading — a real number, in range, indistinguishable
     * from a real meter walk. The flat billed zero and nothing said so.
     */
    it('reads a quoted name containing the separator as one cell', () => {
      const { rows, errors } = parseReadings(
        `${header}\n4A,"Nair, R",5.817,6.900`, flats);
      expect(rows).toEqual([{ flat: '4A', reading: 6.900 }]);
      expect(errors).toEqual([]);
    });

    it('reads a doubled quote inside a quoted name', () => {
      const { rows, errors } = parseReadings(
        `${header}\n4A,"Nair ""Raju"", R",5.817,6.900`, flats);
      expect(rows).toEqual([{ flat: '4A', reading: 6.900 }]);
      expect(errors).toEqual([]);
    });

    /**
     * An UNQUOTED comma cannot be resolved by any splitter — the row is
     * genuinely ambiguous. Refused by name, because the alternative is what
     * used to happen: last month's number imported as this month's.
     */
    it('refuses a row carrying more columns than the header declared', () => {
      const { rows, errors } = parseReadings(
        `${header}\n4A,Nair, R,5.817,6.900`, flats);
      expect(rows).toEqual([]);
      expect(errors).toEqual([{ line: '4A,Nair, R,5.817,6.900', flat: '4A', reason: 'wrong-columns' }]);
    });

    /**
     * FEWER is not an error. Some exporters drop trailing empty cells, and a
     * flat nobody has read yet is exactly that row.
     */
    it('accepts a row whose trailing empty cells were dropped', () => {
      const { rows, errors } = parseReadings(
        `${header}\n4A,Meera Menon,5.817,6.900\n4B,Rajesh Pillai,2.94`, flats);
      expect(rows).toEqual([{ flat: '4A', reading: 6.900 }]);
      expect(errors).toEqual([]);
    });

    it('does not report the header row as a failure', () => {
      const { errors } = parseReadings(`${header}\n4A,Meera Menon,5.817,6.900`, flats);
      expect(errors).toEqual([]);
    });

    it('treats a blank reading as not-yet-read, not as a bad row', () => {
      // The meter walk is done in passes; half a template is the normal state.
      const { rows, errors } = parseReadings(
        `${header}\n4A,Meera Menon,5.817,6.900\n4B,Rajesh Pillai,2.94,`, flats);
      expect(rows).toEqual([{ flat: '4A', reading: 6.900 }]);
      expect(errors).toEqual([]);
    });

    /**
     * DELETING THE HEADER used to produce 93 identical failures, each naming a
     * flat like "1D Meera Menon [demo] 22.625" — the heuristic reading
     * everything before the last number as the flat name. The cause was one
     * missing line at the top, and the report said nothing about it.
     */
    it('names a missing header instead of failing every row as an unknown flat', () => {
      const { rows, errors } = parseReadings('4A,Meera Menon,5.817,6.900\n4B,Rajesh Pillai,2.94,3.5', flats);
      expect(rows).toEqual([]);
      expect(errors.map((e) => e.reason)).toEqual(['no-header', 'no-header']);
    });

    it('still reads a pasted pair, which has no header and never did', () => {
      // The shape this heuristic exists for: two columns out of a message.
      expect(parseReadings('4A 5.817\n4B\t2.94', flats).rows).toEqual([
        { flat: '4A', reading: 5.817 },
        { flat: '4B', reading: 2.94 },
      ]);
      expect(parseReadings('4A,5.817', flats).rows).toEqual([{ flat: '4A', reading: 5.817 }]);
    });

    it('still reads a pasted pair carrying a unit', () => {
      expect(parseReadings('4A 5.817 m3', flats).rows).toEqual([{ flat: '4A', reading: 5.817 }]);
    });

    it('reads columns by NAME, so their order does not matter', () => {
      const { rows } = parseReadings('reading,flat\n6.900,4A', flats);
      expect(rows).toEqual([{ flat: '4A', reading: 6.900 }]);
    });

    it('still catches an unknown flat when there is a header', () => {
      const { rows, errors } = parseReadings(`${header}\n9F,Nobody,1.0,2.110`, flats);
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

describe('implausibly LOW warning — the error nobody reports', () => {
  const history = [4.38, 4.19, 3.98, 4.01];

  it('stays quiet for an ordinary month', () => {
    expect(dropWarning(4.1, history)).toBe(null);
  });

  it('warns when a dropped digit under-bills the flat', () => {
    // 18.867 typed as 18.100: still above last month, so nothing rejects it and
    // no resident ever complains about being charged too little.
    const w = dropWarning(0.4, history);
    expect(w.level).toBe('warn');
    expect(w.fraction).toBeLessThan(0.34);
  });

  it('says NOTHING about zero, which is how an empty month is recorded', () => {
    // A flat that used nothing is entered by repeating last month's reading.
    // Warning about it would train the treasurer to dismiss the warning that
    // matters — and the vacant flats are exactly the legitimate zeros.
    expect(dropWarning(0, history)).toBe(null);
  });

  it('says nothing without enough history to judge against', () => {
    expect(dropWarning(0.4, [])).toBe(null);
    expect(dropWarning(0.4, [4.38])).toBe(null);
  });
});


/**
 * What may reach the readings table.
 *
 * These are not reachable from the grid — it only ever sends flats it drew and
 * numbers from a number box. They are reachable by anything else holding an
 * admin cookie, which on 2026-09-05 was enough to store a reading against a
 * flat that is not billed, and a meter total below zero.
 */
describe('saveReadings refuses what a meter could not have shown', () => {
  const rows = {
    'SELECT status FROM periods WHERE period = ?': { status: 'open' },
  };

  function fakeDb() {
    const written = [];
    return {
      written,
      DB: {
        prepare(sql) {
          return {
            bind: (...args) => ({
              first: async () => rows[sql] ?? null,
              all: async () => ({ results: [] }),
              _sql: sql,
              _args: args,
            }),
            all: async () => ({
              results: sql.includes('FROM flats')
                ? [{ flat: '4A', active: 1 }, { flat: '4B', active: 1 }, { flat: '6G', active: 0 }]
                : [],
            }),
          };
        },
        batch: async (stmts) => { written.push(...stmts.map((s) => s._args)); },
      },
    };
  }

  const save = async (entries) => {
    const db = fakeDb();
    const result = await saveReadings(db, '2026-09', entries, 1);
    return { ...result, written: db.written };
  };

  it('writes a reading for a billed flat', async () => {
    const r = await save([{ flat: '4A', reading: 21.9 }]);
    expect(r.saved).toBe(1);
    expect(r.rejected).toEqual([]);
  });

  /**
   * A batch with nothing valid in it THROWS, rather than returning a quiet
   * count of zero. Every one of these is a single-row batch, which is what
   * autosave sends as the treasurer types.
   */
  const refuse = async (entries) => {
    let caught = null;
    try { await save(entries); } catch (err) { caught = err; }
    return caught;
  };

  it('refuses a flat that is not part of the building', async () => {
    // It used to reach the INSERT, break its foreign key, and surface as
    // DDP-SYS-001 — our fault, logged and alerted, for their typo.
    const err = await refuse([{ flat: '4AA', reading: 21.9 }]);
    expect(err?.code).toBe('DDP-BILL-019');
    expect(err?.detail?.rejected).toEqual([{ flat: '4AA', reason: 'unknown-flat' }]);
  });

  it('refuses a flat that is not being billed', async () => {
    // Written happily before, then invisible: the grid only draws active flats.
    const err = await refuse([{ flat: '6G', reading: 21.9 }]);
    expect(err?.detail?.rejected).toEqual([{ flat: '6G', reason: 'not-billed' }]);
  });

  it('refuses a reading below zero', async () => {
    const err = await refuse([{ flat: '4A', reading: -5 }]);
    expect(err?.detail?.rejected).toEqual([{ flat: '4A', reason: 'negative' }]);
  });

  it('refuses something that is not a number at all', async () => {
    const err = await refuse([{ flat: '4A', reading: 'abc' }]);
    expect(err?.detail?.rejected).toEqual([{ flat: '4A', reason: 'not-a-number' }]);
  });

  it('writes nothing at all when every row is bad', async () => {
    const err = await refuse([{ flat: '4AA', reading: 1 }, { flat: '6G', reading: 2 }]);
    expect(err?.code).toBe('DDP-BILL-019');
    expect(err?.detail?.rejected.map((r) => r.flat)).toEqual(['4AA', '6G']);
  });
});
