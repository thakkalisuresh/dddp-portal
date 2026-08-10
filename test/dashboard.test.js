import { describe, it, expect } from 'vitest';
import { shapeBill, withConsumption } from '../functions/lib/dashboard.js';

const period = { due_date: '2026-08-10', late_fee: 50, status: 'open' };

const bill = (over = {}) => ({
  id: 1, period: '2026-07', consumption: 4.38, rate_per_kg: 75, gas_amount: 328.5,
  other_charges: 0, additional_charges: 0, late_fee: 0, late_fee_at: null,
  total: 329.04, status: 'unpaid', paid_at: null, ...over,
});

describe('display status', () => {
  it('reads as unpaid before the due date', () => {
    expect(shapeBill(bill(), period, '2026-08-01').displayStatus).toBe('unpaid');
  });

  it('reads as overdue after it, without the stored status changing', () => {
    const shaped = shapeBill(bill(), period, '2026-08-11');
    expect(shaped.displayStatus).toBe('overdue');
    expect(shaped.status).toBe('unpaid'); // the DB is untouched
  });

  it('never shows overdue once settled, however late', () => {
    for (const status of ['paid', 'waived']) {
      expect(shapeBill(bill({ status }), period, '2027-01-01').displayStatus).toBe('paid');
    }
  });

  it('keeps a claimed payment in its own state past the due date', () => {
    // Someone who tapped Pay on the 9th must not be shown as overdue on the 11th.
    for (const status of ['initiated', 'awaiting']) {
      expect(shapeBill(bill({ status }), period, '2026-08-11').displayStatus).toBe(status);
    }
  });
});

describe('the pay CTA disappears rather than disabling', () => {
  it('is offered while anything is owed', () => {
    // 'initiated' means an app opened, nothing more. Someone who bounced off
    // their UPI app still needs the button.
    for (const status of ['unpaid', 'initiated']) {
      expect(shapeBill(bill({ status }), period).showPayButton).toBe(true);
    }
  });

  it('is withdrawn once a screenshot is in', () => {
    // 'awaiting' is the state an upload puts the bill into: that resident has
    // paid and proved it, and a second transfer for the same bill is more work
    // for the treasurer than a missing one. The upload link stays — a rejected
    // proof needs a replacement.
    const shaped = shapeBill(bill({ status: 'awaiting' }), period);
    expect(shaped.showPayButton).toBe(false);
    expect(shaped.showUploadLink).toBe(true);
    expect(shaped.settled).toBe(false);
  });

  it('is withdrawn once settled — a dead button is worse than no button', () => {
    for (const status of ['paid', 'waived']) {
      const shaped = shapeBill(bill({ status }), period);
      expect(shaped.showPayButton).toBe(false);
      expect(shaped.showUploadLink).toBe(false);
      expect(shaped.settled).toBe(true);
    }
  });
});

describe('late fee warning', () => {
  it('warns before the fee lands', () => {
    const w = shapeBill(bill(), period, '2026-08-01').lateFeeWarning;
    expect(w).toEqual({ amount: 50, after: '2026-08-10' });
  });

  it('stops warning once the fee has actually been applied', () => {
    const shaped = shapeBill(bill({ late_fee: 50, late_fee_at: '2026-08-11T03:00:00Z' }), period, '2026-08-11');
    expect(shaped.lateFeeWarning).toBe(null);
    expect(shaped.lateFee).toBe(50);
  });

  it('does not warn a resident who has already settled', () => {
    expect(shapeBill(bill({ status: 'paid' }), period, '2026-08-01').lateFeeWarning).toBe(null);
  });

  it('does not warn when the period charges no fee', () => {
    expect(shapeBill(bill(), { ...period, late_fee: 0 }, '2026-08-01').lateFeeWarning).toBe(null);
  });
});

describe('consumption from cumulative readings', () => {
  const rows = [ // newest first, as the query returns them
    { period: '2026-07', reading: 5.817 },
    { period: '2026-06', reading: 4.134 },
    { period: '2026-05', reading: 2.522 },
  ];

  it('reports kilograms, matching what the bill charges for the same month', () => {
    // The regression this guards: the readings table subtracting raw meter
    // values while the bill table shows converted kilograms, so the dashboard
    // told the resident 1.68 kg and 4.38 kg for the same July.
    const out = withConsumption(rows);
    expect(out[0].consumption).toBe(4.38);   // as billed on the live portal
    expect(out[1].consumption).toBe(4.19);
  });

  it('keeps the raw meter movement available alongside it', () => {
    expect(withConsumption(rows)[0].meterDelta).toBe(1.683);
  });

  it('honours a period whose conversion factor differs', () => {
    expect(withConsumption(rows, 1)[0].consumption).toBe(1.68);
  });

  it('reports null for the oldest row rather than pretending it was all consumed', () => {
    // The window has no predecessor for the last row; 2.522 kg is a meter
    // position, not a month's usage.
    expect(withConsumption(rows).at(-1).consumption).toBe(null);
  });

  it('handles a single reading', () => {
    expect(withConsumption([{ period: '2026-07', reading: 5.817 }])[0].consumption).toBe(null);
  });

  it('handles no readings', () => {
    expect(withConsumption([])).toEqual([]);
  });
});

describe('month labelling matches what residents already see', () => {
  // The old portal labels the bill June and the reading row July for the same
  // 4.38 kg. That is not a bug: the meter closing June's gas is read in early
  // July. Residents have read it that way for months, so we keep it.
  const rows = [
    { period: '2026-06', reading: 5.817, read_on: '2026-07-02' },
    { period: '2026-05', reading: 4.134, read_on: '2026-06-02' },
  ];

  it('keys a reading by the usage month it closes, not the month it was taken', () => {
    const out = withConsumption(rows);
    expect(out[0].period).toBe('2026-06');   // the bill says June
    expect(out[0].readOn).toBe('2026-07-02'); // the meter was read in July
  });

  it('the read date always falls after the usage month it closes', () => {
    for (const r of withConsumption(rows)) {
      if (!r.readOn) continue;
      expect(r.readOn.slice(0, 7) > r.period).toBe(true);
    }
  });

  it('the bill period is the usage month, so it reads June to the resident', () => {
    expect(shapeBill(bill({ period: '2026-06' }), period).period).toBe('2026-06');
  });
});

describe('missing data', () => {
  it('returns null rather than throwing when a flat has no bill', () => {
    expect(shapeBill(null, period)).toBe(null);
  });

  it('survives a bill whose period row is missing', () => {
    const shaped = shapeBill(bill(), null, '2026-12-01');
    expect(shaped.dueDate).toBe(null);
    expect(shaped.displayStatus).toBe('unpaid'); // can't be overdue without a due date
  });
});
