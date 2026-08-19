/**
 * The Home board's reading of the month.
 *
 * Two failures matter here and they fail quietly in opposite directions. One is
 * the board demanding a rate for a month that has not ended — an admin who
 * obliges opens a period whose readings cannot exist yet. The other is a board
 * that goes calm while work is outstanding, which is worse than the tab strip
 * it replaced: the old strip told you nothing, but it never told you nothing
 * was wrong.
 */

import { describe, it, expect } from 'vitest';
import { latestEndedPeriod, boardStage, daysOverdue, tallyByStatus } from '../functions/lib/summary.js';

const none = { unpaid: 0, initiated: 0, awaiting: 0, paid: 0, waived: 0 };
const all44 = { saved: 44, expected: 44 };

describe('which month the board is asking about', () => {
  it('is the month before this one, because a meter closes a month it follows', () => {
    // Read in August, measures July. A board that asked for August's rate on
    // the 19th of August would be asking to open a month still running.
    expect(latestEndedPeriod('2026-08-19')).toBe('2026-07');
  });

  it('crosses the year boundary', () => {
    expect(latestEndedPeriod('2026-01-04')).toBe('2025-12');
  });
});

describe('the stage', () => {
  it('asks for a rate when no period has ever been opened', () => {
    expect(boardStage({ period: null, latestEnded: '2026-07', readings: all44, bills: none }))
      .toBe('no-period');
  });

  it('asks for a rate when the newest period is older than the month that ended', () => {
    // THE COMMON CASE, every month: July is settled, August ends, and the
    // console must stop showing July as if it were the work in front of you.
    expect(boardStage({
      period: { period: '2026-06' }, latestEnded: '2026-07',
      readings: all44, bills: { ...none, paid: 44 },
    })).toBe('no-period');
  });

  it('is readings while meters are outstanding', () => {
    expect(boardStage({
      period: { period: '2026-07' }, latestEnded: '2026-07',
      readings: { saved: 31, expected: 44 }, bills: none,
    })).toBe('readings');
  });

  it('is ready once every meter is in and no bill exists yet', () => {
    // The state the mockups missed: nothing outstanding, nothing generated, and
    // an admin left looking at a board with no next step.
    expect(boardStage({
      period: { period: '2026-07' }, latestEnded: '2026-07', readings: all44, bills: none,
    })).toBe('ready');
  });

  it('is billed while any bill is unpaid, claimed or awaiting a proof', () => {
    for (const key of ['unpaid', 'initiated', 'awaiting']) {
      expect(boardStage({
        period: { period: '2026-07' }, latestEnded: '2026-07', readings: all44,
        bills: { ...none, paid: 43, [key]: 1 },
      }), key).toBe('billed');
    }
  });

  it('is settled when every bill is paid or waived', () => {
    expect(boardStage({
      period: { period: '2026-07' }, latestEnded: '2026-07', readings: all44,
      bills: { ...none, paid: 42, waived: 2 },
    })).toBe('settled');
  });

  it('does not call an unbilled month settled', () => {
    // Zero unpaid is true of a month nobody has billed yet. Reading that as
    // "settled" would tell the treasurer the month was done before it started.
    expect(boardStage({
      period: { period: '2026-07' }, latestEnded: '2026-07', readings: all44, bills: none,
    })).not.toBe('settled');
  });

  it('survives a period row arriving without counts', () => {
    expect(boardStage({
      period: { period: '2026-07' }, latestEnded: '2026-07', readings: {}, bills: {},
    })).toBe('ready');
  });
});

describe('how late a bill is', () => {
  it('is nothing on the due date itself', () => {
    // A bill due on the 10th is not late ON the 10th, and a reminder that says
    // otherwise costs the committee more than the fee is worth.
    expect(daysOverdue('2026-09-10', '2026-09-10')).toBe(0);
  });

  it('counts whole days after it', () => {
    expect(daysOverdue('2026-09-10', '2026-09-19')).toBe(9);
  });

  it('never goes negative for a bill that is not due yet', () => {
    expect(daysOverdue('2026-09-10', '2026-09-01')).toBe(0);
  });

  it('returns zero rather than NaN for a missing or unparseable date', () => {
    expect(daysOverdue(null, '2026-09-19')).toBe(0);
    expect(daysOverdue('not a date', '2026-09-19')).toBe(0);
  });
});

describe('counting bills by status', () => {
  it('fills in the statuses the query did not return', () => {
    // A month where nobody has paid has no 'paid' row at all, and undefined
    // turns every sum on it into NaN — which renders as a blank where a number
    // belongs.
    expect(tallyByStatus([{ status: 'unpaid', n: 11 }]))
      .toEqual({ unpaid: 11, initiated: 0, awaiting: 0, paid: 0, waived: 0 });
  });

  it('ignores a status the schema does not have', () => {
    expect(tallyByStatus([{ status: 'nonsense', n: 3 }])).toEqual(none);
  });

  it('copes with no rows at all', () => {
    expect(tallyByStatus([])).toEqual(none);
    expect(tallyByStatus(undefined)).toEqual(none);
  });
});
