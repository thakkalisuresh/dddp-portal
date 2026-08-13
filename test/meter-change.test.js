import { describe, it, expect } from 'vitest';
import {
  meterDeltaAcrossChange, computeConsumption, previewGeneration,
} from '../functions/lib/billing.js';
import { withConsumption } from '../functions/lib/dashboard.js';

/**
 * A meter replaced mid-month. Last month closed at 19.145; the old meter ran on
 * to 19.900 before it came off, and the new one has reached 0.412 since.
 *
 * Gas used = 0.755 on the old meter + 0.412 on the new = 1.167.
 */
const change = { old_final: 19.9, new_start: 0, changed_on: '2026-07-14' };

describe('a replaced meter is recorded, not fought with', () => {
  it('bills both segments — the old meter\'s last days and the new one\'s first', () => {
    expect(meterDeltaAcrossChange(0.412, 19.145, change)).toBe(1.167);
  });

  it('converts that to kilograms like any other month', () => {
    expect(computeConsumption(0.412, 19.145, 2.6, change)).toBe(3.03);
  });

  it('honours a replacement that did not start at zero', () => {
    // Refurbished meters exist and arrive with a reading already on them.
    expect(meterDeltaAcrossChange(1.412, 19.145, { old_final: 19.9, new_start: 1 })).toBe(1.167);
  });

  it('UNBLOCKS THE MONTH — this is the whole point', () => {
    // Without a changeover the reading is below last month's, computeConsumption
    // throws DDP-BILL-002, the flat lands in `blocked`, and canGenerate is false
    // for the WHOLE BUILDING. One flat's plumber froze billing for 99 homes.
    const rows = [
      { flat: '4A', reading: 20.5, previous: 19.0 },
      { flat: '4B', reading: 0.412, previous: 19.145 },
    ];

    const without = previewGeneration({ rows, ratePerKg: 90, expectedFlats: 2 });
    expect(without.blocked).toHaveLength(1);
    expect(without.canGenerate).toBe(false);

    const withChange = previewGeneration({
      rows: [rows[0], { ...rows[1], meterChange: change }],
      ratePerKg: 90, previousRate: 90, expectedFlats: 2,
    });
    expect(withChange.blocked).toEqual([]);
    expect(withChange.canGenerate).toBe(true);
    expect(withChange.willBill).toBe(2);
  });

  it('refuses a changeover that is itself impossible', () => {
    // old_final below last month's reading describes a meter that ran backwards
    // BEFORE it was replaced — the same impossibility the swap explains away,
    // and silently billing it turns one mistyped number into an unaccountable
    // bill.
    expect(() => meterDeltaAcrossChange(0.412, 19.145, { old_final: 18, new_start: 0 }))
      .toThrow();
    expect(() => meterDeltaAcrossChange(0.2, 19.145, { old_final: 19.9, new_start: 0.5 }))
      .toThrow();
  });
});

describe('what the resident sees', () => {
  // Newest first, exactly as the dashboard query returns them.
  const rows = [
    { period: '2026-07', reading: 0.412, read_on: '2026-08-02',
      meter_changed_on: '2026-07-14', meter_old_final: 19.9, meter_new_start: 0 },
    { period: '2026-06', reading: 19.145, read_on: '2026-07-02' },
  ];

  it('shows the real consumption instead of a negative month', () => {
    const [july] = withConsumption(rows, 2.6);
    expect(july.consumption).toBe(3.03);
    expect(july.meterDelta).toBe(1.167);
  });

  it('says the meter was changed, so a number that drops is explained', () => {
    expect(withConsumption(rows, 2.6)[0].meterChangedOn).toBe('2026-07-14');
  });

  it('never takes the dashboard down over a bad changeover row', () => {
    // This runs on the RESIDENT's page. A committee data problem must not cost
    // them their bill, their QR and their history — that month shows a dash.
    const broken = [{ ...rows[0], meter_old_final: 1 }, rows[1]];
    expect(() => withConsumption(broken, 2.6)).not.toThrow();
    expect(withConsumption(broken, 2.6)[0].consumption).toBeNull();
  });
});
