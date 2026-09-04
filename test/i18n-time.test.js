import { describe, it, expect } from 'vitest';
import { dayLabel, timeLabel, stampLabel } from '../public/js/i18n.js';

/**
 * Dates are read in Kerala, so they are formatted in Kerala's time zone.
 *
 * The bug these tests pin down: the labels used to read getUTCDate(), which is
 * 5h30m behind the reader. Anything posted after 6:30pm IST carried the
 * previous day's UTC date and was displayed as such.
 */

describe('dayLabel', () => {
  it('reads a date-only string as that date', () => {
    // Parses as UTC midnight; +5:30 keeps it on the same calendar day.
    expect(dayLabel('2026-08-10')).toBe('10 August');
  });

  it('puts a late-evening IST timestamp on the day Kerala calls it', () => {
    // 22:39 UTC on the 10th is 04:09 IST on the 11th.
    expect(dayLabel('2026-08-10T22:39:02.319Z')).toBe('11 August');
  });

  it('does not roll a mid-afternoon stamp forward', () => {
    expect(dayLabel('2026-08-10T09:00:00.000Z')).toBe('10 August');
  });
});

describe('timeLabel', () => {
  it('renders afternoon in 12-hour form', () => {
    // 08:45 UTC -> 14:15 IST
    expect(timeLabel('2026-08-10T08:45:00.000Z')).toBe('2:15 PM');
  });

  it('renders morning', () => {
    expect(timeLabel('2026-08-10T04:10:00.000Z')).toBe('9:40 AM');
  });

  it('calls IST midnight 12:00 AM, not 0:00', () => {
    // 18:30 UTC on the 9th is exactly midnight IST on the 10th.
    expect(timeLabel('2026-08-09T18:30:00.000Z')).toBe('12:00 AM');
  });

  it('calls IST noon 12:00 PM', () => {
    expect(timeLabel('2026-08-10T06:30:00.000Z')).toBe('12:00 PM');
  });

  it('pads the minute', () => {
    expect(timeLabel('2026-08-10T03:35:00.000Z')).toBe('9:05 AM');
  });
});

describe('stampLabel', () => {
  const now = new Date('2026-08-10T12:00:00.000Z'); // 5:30 PM IST, 10 August

  it('says Today for something posted this morning', () => {
    expect(stampLabel('2026-08-10T04:10:00.000Z', now)).toBe('Today, 9:40 AM');
  });

  it('says Yesterday across the IST midnight, not the UTC one', () => {
    // 20:00 UTC on the 8th is 1:30 AM IST on the 9th — yesterday in Kerala,
    // but two days ago if you go by the UTC date.
    expect(stampLabel('2026-08-08T20:00:00.000Z', now)).toBe('Yesterday, 1:30 AM');
  });

  it('counts a late-night post as today once IST has rolled over', () => {
    // 19:00 UTC on the 9th is 12:30 AM IST on the 10th.
    expect(stampLabel('2026-08-09T19:00:00.000Z', now)).toBe('Today, 12:30 AM');
  });

  it('gives older things a date instead of a clock alone', () => {
    expect(stampLabel('2026-08-03T10:30:00.000Z', now)).toBe('3 August, 4:00 PM');
  });

  it('adds the year only when it is not the current one', () => {
    expect(stampLabel('2025-12-30T10:30:00.000Z', now)).toBe('30 December 2025, 4:00 PM');
  });
});

