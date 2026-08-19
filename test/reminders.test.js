/**
 * The reminder cap, which is the only thing standing between a committee and a
 * neighbour who feels harassed over ₹1,200.
 *
 * Three failures matter. Sending a fourth, which the rule forbids outright.
 * Sending the second the moment the first goes, because a clock comparison went
 * the wrong way. And Remind-all quietly refilling itself, which is what happens
 * if a run that skipped everybody is not counted.
 */

import { describe, it, expect } from 'vitest';
import {
  reminderDecision, batchDecision, reminderEmail, listDates, dayAndMonth,
  MAX_REMINDERS, MAX_BATCHES,
} from '../functions/lib/reminders.js';

const at = (day, hour = 0) => `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

describe('whether one flat can be reminded', () => {
  it('allows the first at any time', () => {
    expect(reminderDecision([], at(20))).toMatchObject({ ok: true, ordinal: 1 });
  });

  it('refuses a second inside 24 hours, and says how long is left', () => {
    const d = reminderDecision([at(20, 9)], at(20, 20));
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('cooling');
    expect(d.hoursLeft).toBe(13);
  });

  it('allows the second once 24 hours have passed', () => {
    expect(reminderDecision([at(20)], at(21))).toMatchObject({ ok: true, ordinal: 2 });
  });

  it('makes the third wait 48 hours, not 24', () => {
    // The spacing widens. Reading SPACING_HOURS off by one would send the third
    // a day early, every time.
    expect(reminderDecision([at(20), at(21)], at(22)).ok).toBe(false);
    expect(reminderDecision([at(20), at(21)], at(23))).toMatchObject({ ok: true, ordinal: 3 });
  });

  it('REFUSES A FOURTH, however long anybody waits', () => {
    const spent = [at(1), at(2), at(5)];
    expect(reminderDecision(spent, at(30))).toMatchObject({ ok: false, reason: 'spent' });
    expect(MAX_REMINDERS).toBe(3);
  });

  it('counts a bulk send against the same three', () => {
    // ONE BUDGET. The decision takes rows, not sources — a run of Remind-all
    // writes the same rows an individual click does, so two bulk sends plus an
    // individual click is the third and last, not the fourth.
    expect(reminderDecision([at(20), at(21)], at(23)).ordinal).toBe(3);
  });

  it('refuses rather than sends when a timestamp cannot be read', () => {
    // A corrupt row must not read as "waited long enough". Failing closed costs
    // a reminder nobody sends; failing open sends one nobody sanctioned.
    expect(reminderDecision(['not a date'], at(25)))
      .toMatchObject({ ok: false, reason: 'unclear' });
  });
});

describe('whether Remind-all may run', () => {
  it('allows the first run', () => {
    expect(batchDecision([], at(20))).toMatchObject({ ok: true, run: 1 });
  });

  it('holds the second for 24 hours', () => {
    expect(batchDecision([at(20, 8)], at(20, 23)).reason).toBe('cooling');
    expect(batchDecision([at(20, 8)], at(21, 9))).toMatchObject({ ok: true, run: 2 });
  });

  it('is spent after two, for the whole month', () => {
    expect(batchDecision([at(20), at(22)], at(30)))
      .toMatchObject({ ok: false, reason: 'spent' });
    expect(MAX_BATCHES).toBe(2);
  });
});

describe('the dates the letters quote', () => {
  it('reads a timestamp as a day and a month', () => {
    expect(dayAndMonth(at(20))).toBe('20 September');
  });

  it('names the month once when they share one', () => {
    expect(listDates([at(20), at(22), at(25)])).toBe('20, 22 and 25 September');
  });

  it('names both months when they do not', () => {
    expect(listDates(['2026-08-30T00:00:00Z', at(2)])).toBe('30 August and 2 September');
  });
});

describe('the letters', () => {
  const base = {
    name: 'Priya', flat: '3B', period: '2026-08', periodLabel: 'August 2026',
    total: 1254.03, dueDate: '2026-09-10T00:00:00Z', daysOver: 12,
  };

  it('states the amount with paise, because the paise identify the flat', () => {
    const { text } = reminderEmail({ ...base, ordinal: 1 });
    expect(text).toContain('₹1,254.03');
    expect(text).toContain('The paise are how the');
  });

  it('says which reminder it is, from the second on', () => {
    expect(reminderEmail({ ...base, ordinal: 2, previous: [at(20)] }).text)
      .toContain('This is the second reminder. The first was sent on 20 September.');
  });

  it('says four words and stops, on the last one', () => {
    // Trimmed on 2026-08-19: "the portal will send for this bill" was the
    // software narrating itself to somebody who does not care it exists.
    const { text } = reminderEmail({ ...base, ordinal: 3, previous: [at(20), at(22), at(25)] });
    expect(text).toContain('This is the last reminder.');
    expect(text).not.toMatch(/portal will send/);
    expect(text).toContain('Reminders were sent on 20, 22 and 25 September.');
  });

  it('carries none of the flourishes the first drafts had', () => {
    for (const ordinal of [1, 2, 3]) {
      const { text } = reminderEmail({ ...base, ordinal, previous: [at(20), at(22)] });
      expect(text, `${ordinal}`).not.toMatch(/would rather have than not/);
      expect(text, `${ordinal}`).not.toMatch(/follow up in person/);
      expect(text, `${ordinal}`).not.toMatch(/better to say so/);
    }
  });

  it('signs as the association, like every other email the portal sends', () => {
    for (const ordinal of [1, 2, 3]) {
      expect(reminderEmail({ ...base, ordinal, previous: [at(20), at(22)] }).text)
        .toMatch(/DD Diamond Park Residents' Welfare Association$/);
    }
  });

  it('opens its subject the way the reset emails do', () => {
    for (const ordinal of [1, 2, 3]) {
      expect(reminderEmail({ ...base, ordinal, previous: [at(20), at(22)] }).subject)
        .toMatch(/^Diamond Park — /);
    }
  });

  it('greets a resident whose name nobody recorded without a dangling space', () => {
    expect(reminderEmail({ ...base, ordinal: 1, name: null }).text.split('\n')[0]).toBe('Hello,');
  });
});
