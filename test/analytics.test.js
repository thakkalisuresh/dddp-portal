import { describe, it, expect } from 'vitest';
import {
  istDay, istHour, dayRange, windowStart, mergeDaily, weekHeat,
  classifyDevice, deviceSplit, summarise, reachOf, topList,
  adoptionCurve, seriesByKey, funnelOf,
} from '../functions/lib/analytics.js';

/**
 * The whole dashboard is a timezone bug waiting to happen. Timestamps are UTC,
 * the building is IST, and the hours people actually use the portal — evening —
 * belong to the previous UTC day. Every test here is that bug in some costume.
 */
describe('IST bucketing', () => {
  it('puts a 9pm IST evening in the right day, not yesterday', () => {
    // 2026-08-11T15:30Z is 21:00 IST on the 11th. In UTC it is still the 11th,
    // so this one passes even when the shift is missing — the next one is the
    // test that matters.
    expect(istDay('2026-08-11T15:30:00.000Z')).toBe('2026-08-11');
  });

  it('puts a 1am IST night owl in the day that has just begun', () => {
    // 2026-08-11T19:30Z is 01:00 IST on the 12th. Counted in UTC this lands on
    // the 11th, which is how a Tuesday would steal Wednesday's traffic.
    expect(istDay('2026-08-11T19:30:00.000Z')).toBe('2026-08-12');
    expect(istHour('2026-08-11T19:30:00.000Z')).toBe(1);
  });

  it('reads the hour in IST, not UTC', () => {
    expect(istHour('2026-08-12T14:00:00.000Z')).toBe(19);   // 7pm, the peak
  });

  it('returns null rather than a wrong day for junk', () => {
    expect(istDay('not a date')).toBeNull();
    expect(istHour(undefined)).toBeNull();
  });
});

describe('the window', () => {
  it('ends on today and runs back the requested number of days', () => {
    const r = dayRange(3, '2026-08-12T04:00:00.000Z');
    expect(r).toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
  });

  it('counts the IST day, so late evening is still today', () => {
    // 23:30 IST on the 12th.
    expect(dayRange(1, '2026-08-12T18:00:00.000Z')).toEqual(['2026-08-12']);
  });

  it('starts at midnight IST, which is 18:30 UTC the day before', () => {
    expect(windowStart(1, '2026-08-12T04:00:00.000Z')).toBe('2026-08-11T18:30:00.000Z');
  });

  it('refuses a nonsense span rather than building a million days', () => {
    expect(dayRange(0, '2026-08-12T04:00:00.000Z')).toHaveLength(1);
    expect(dayRange(9999, '2026-08-12T04:00:00.000Z')).toHaveLength(365);
  });
});

describe('the daily series', () => {
  const range = ['2026-08-10', '2026-08-11', '2026-08-12'];

  it('keeps the quiet days, because a vanished Sunday invents a trend', () => {
    const series = mergeDaily({
      activity: [{ day: '2026-08-10', events: 9, pages: 5, people: 2 },
                 { day: '2026-08-12', events: 4, pages: 4, people: 1 }],
      logins: [{ day: '2026-08-12', logins: 3, people: 1 }],
      errors: [{ day: '2026-08-11', errors: 2 }],
    }, range);

    expect(series.map((r) => r.day)).toEqual(range);
    expect(series[1]).toMatchObject({ events: 0, pageViews: 0, people: 0, errors: 2 });
    expect(series[2]).toMatchObject({ pageViews: 4, logins: 3 });
  });

  it('is all zeroes rather than empty when nothing happened at all', () => {
    const series = mergeDaily({}, range);
    expect(series).toHaveLength(3);
    expect(series.every((r) => r.events === 0)).toBe(true);
  });
});

describe('the totals', () => {
  const daily = [
    { day: 'a', events: 10, pageViews: 6, logins: 2, errors: 1, people: 3 },
    { day: 'b', events: 30, pageViews: 20, logins: 5, errors: 0, people: 4 },
  ];

  it('adds up the window and names its busiest day', () => {
    const t = summarise(daily);
    expect(t).toMatchObject({ events: 40, pageViews: 26, logins: 7, errors: 1, busiestDay: 'b' });
  });

  it('reports peak daily people, never their sum', () => {
    // Summing distinct-per-day actives says 7 people used a portal that only
    // has 4 of them — the mistake that makes an adoption figure meaningless.
    expect(summarise(daily).peakDailyPeople).toBe(4);
  });

  it('carries the previous window so a number has something to be measured against', () => {
    expect(summarise(daily, [{ events: 5, pageViews: 4, logins: 1, errors: 0 }]).previous)
      .toMatchObject({ events: 5, pageViews: 4, logins: 1 });
  });

  it('names no busiest day when the window is empty', () => {
    expect(summarise([{ day: 'a', events: 0 }]).busiestDay).toBeNull();
  });
});

describe('the weekday and hour grid', () => {
  it('fills all 168 cells, so a dead Monday morning is a gap and not a hole', () => {
    const { grid, peak, busiest } = weekHeat([
      { weekday: 0, hour: 20, events: 40 },
      { weekday: 2, hour: 9, events: 12 },
    ]);
    expect(grid).toHaveLength(7);
    expect(grid[0].hours).toHaveLength(24);
    expect(grid[0].hours[20].events).toBe(40);
    expect(grid[1].hours[20].events).toBe(0);
    expect(peak).toBe(40);
    expect(busiest).toMatchObject({ label: 'Sun', hour: 20, events: 40 });
  });

  it('reports no busiest cell at all when the window is empty', () => {
    const { peak, busiest } = weekHeat([]);
    expect(peak).toBe(0);
    expect(busiest).toBeNull();
  });
});

describe('devices', () => {
  it('reads a phone, a tablet and a laptop apart', () => {
    expect(classifyDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari')).toBe('phone');
    expect(classifyDevice('Mozilla/5.0 (Linux; Android 14; SM-G991B) Mobile Safari')).toBe('phone');
    // Android without "Mobile" is the tablet convention, and it is the one
    // everybody gets wrong.
    expect(classifyDevice('Mozilla/5.0 (Linux; Android 14; SM-X200) Safari')).toBe('tablet');
    expect(classifyDevice('Mozilla/5.0 (iPad; CPU OS 17_0) Safari')).toBe('tablet');
    expect(classifyDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome')).toBe('desktop');
    expect(classifyDevice('')).toBe('unknown');
  });

  it('collapses many user agents into buckets, busiest first', () => {
    const split = deviceSplit([
      { user_agent: 'iPhone Safari', events: 10, people: 2 },
      { user_agent: 'Android Mobile', events: 5, people: 1 },
      { user_agent: 'Macintosh Chrome', events: 3, people: 1 },
    ]);
    expect(split[0]).toMatchObject({ device: 'phone', events: 15, people: 3 });
    expect(split[1]).toMatchObject({ device: 'desktop', events: 3 });
  });
});

describe('rollout reach', () => {
  const owners = [
    { id: 1, flat: '4A', name: 'A', active: 1 },
    { id: 2, flat: '5A', name: 'B', active: 1 },
    { id: 3, flat: '6A', name: 'C', active: 1 },
    { id: 9, flat: '7A', name: 'Moved out', active: 0 },
  ];
  const now = '2026-08-12T04:00:00.000Z';

  it('names the flats that have never logged in — the door-knocking list', () => {
    const r = reachOf({
      owners,
      lastLogins: [{ actor_id: 1, at: '2026-08-11T10:00:00.000Z' }],
      activeIds: [1], now,
    });
    expect(r.residents).toBe(3);            // the moved-out account is not a resident
    expect(r.everLoggedIn).toBe(1);
    expect(r.activeInWindow).toBe(1);
    expect(r.neverLoggedIn.map((o) => o.flat)).toEqual(['5A', '6A']);
  });

  it('separates "never used it" from "used it once in March"', () => {
    const r = reachOf({
      owners,
      lastLogins: [
        { actor_id: 1, at: '2026-08-11T10:00:00.000Z' },
        { actor_id: 2, at: '2026-03-01T10:00:00.000Z' },
      ],
      activeIds: [], now,
    });
    expect(r.dormant.map((d) => d.flat)).toEqual(['5A']);
    expect(r.dormantCount).toBe(1);
    expect(r.neverLoggedIn.map((o) => o.flat)).toEqual(['6A']);
  });
});

describe('the adoption curve', () => {
  const range = ['2026-08-10', '2026-08-11', '2026-08-12'];

  it('only ever rises, and counts a flat on the day it first logged in', () => {
    const a = adoptionCurve({
      firstLogins: [
        { actor_id: 1, at: '2026-08-10T05:00:00.000Z' },
        { actor_id: 2, at: '2026-08-12T05:00:00.000Z' },
        { actor_id: 3, at: '2026-08-12T06:00:00.000Z' },
      ],
      range, residents: 99,
    });
    expect(a.points.map((p) => p.everLoggedIn)).toEqual([1, 1, 3]);
    expect(a.points[2].newThisDay).toBe(2);
    expect(a.gained).toBe(3);
  });

  it('carries flats that joined before the window instead of restarting at zero', () => {
    // Shortening the window must not make a portal adopted in March look new.
    const a = adoptionCurve({
      firstLogins: [
        { actor_id: 1, at: '2026-03-01T05:00:00.000Z' },
        { actor_id: 2, at: '2026-08-11T05:00:00.000Z' },
      ],
      range, residents: 4,
    });
    expect(a.startedAt).toBe(1);
    expect(a.points.map((p) => p.everLoggedIn)).toEqual([1, 2, 2]);
    expect(a.gained).toBe(1);
    expect(a.share).toBe(0.5);
  });

  it('puts a late-evening first login on the IST day it happened', () => {
    // 01:00 IST on the 12th — counted in UTC this would land on the 11th.
    const a = adoptionCurve({
      firstLogins: [{ actor_id: 1, at: '2026-08-11T19:30:00.000Z' }],
      range, residents: 1,
    });
    expect(a.points.map((p) => p.everLoggedIn)).toEqual([0, 0, 1]);
  });
});

describe('per-row series', () => {
  it('gives every row the same number of days, gaps filled with zero', () => {
    const out = seriesByKey([
      { name: '/dashboard', day: '2026-08-10', count: 4 },
      { name: '/dashboard', day: '2026-08-12', count: 9 },
      { name: '/notices', day: '2026-08-11', count: 2 },
    ], ['2026-08-10', '2026-08-11', '2026-08-12']);

    expect(out['/dashboard']).toEqual([4, 0, 9]);
    expect(out['/notices']).toEqual([0, 2, 0]);
  });
});

describe('the paying funnel', () => {
  it('measures each step against the top and names the drop from the one above', () => {
    const f = funnelOf({ opened: 99, intents: 71, proofs: 43, approvals: 38 });
    expect(f.map((s) => s.people)).toEqual([99, 71, 43, 38]);
    expect(f[1].lostFromPrevious).toBe(28);
    expect(f[2].lostFromPrevious).toBe(28);
    expect(Math.round(f[2].share * 100)).toBe(43);
  });

  it('survives a step that is larger than the one above it', () => {
    // Possible and not a bug: a proof can be approved this window for a bill
    // that was opened in the last one. It must not produce a negative loss or
    // a bar wider than its track.
    const f = funnelOf({ opened: 2, intents: 1, proofs: 1, approvals: 5 });
    expect(f[3].lostFromPrevious).toBe(0);
    expect(f[3].share).toBeGreaterThan(1);
  });

  it('does not divide by zero on a portal nobody has opened', () => {
    expect(funnelOf({}).every((s) => s.people === 0 && s.share === 0)).toBe(true);
  });
});

describe('top lists', () => {
  it('drops a null key and coerces the count SQLite handed back', () => {
    expect(topList([{ name: 'login', count: '4' }, { name: null, count: 2 }]))
      .toEqual([{ name: 'login', count: 4 }]);
  });
});
