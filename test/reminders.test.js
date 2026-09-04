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

  it('states the amount, and no longer explains the paise', () => {
    // The paise sentence was removed on 2026-09-04. Bill totals are whole
    // rupees — toWholeRupees, plus a CHECK on `periods` and `bills` — so the
    // amount always ends .00 and the care the line asked for matched nothing.
    // Asserted as an absence in every letter so it cannot come back quietly.
    const { text } = reminderEmail({ ...base, ordinal: 1 });
    expect(text).toContain('₹1,254.03');
    for (const ordinal of [1, 2, 3]) {
      const m = reminderEmail({ ...base, ordinal, previous: [at(20), at(22)] });
      for (const body of [m.text, m.html]) {
        expect(body, `${ordinal}`).not.toMatch(/paise/i);
        expect(body, `${ordinal}`).not.toMatch(/exact amount/i);
      }
    }
  });

  it('lets the subject say which reminder it is, not the body', () => {
    // The letters used to open by announcing their own ordinal. The subject
    // already carries it, and so does the figure's caption; a third telling
    // read as process rather than as a message to a neighbour.
    const second = reminderEmail({ ...base, ordinal: 2, previous: [at(20)] });
    expect(second.subject).toContain('Second reminder');
    expect(second.text).toContain('The gas bill for flat 3B for August 2026 is still unpaid.');
    for (const body of [second.text, second.html]) {
      expect(body).not.toMatch(/This is the second reminder/);
    }

    const third = reminderEmail({ ...base, ordinal: 3, previous: [at(20), at(22)] });
    expect(third.subject).toContain('Final reminder');
    for (const body of [third.text, third.html]) {
      expect(body).not.toMatch(/This is the last reminder/);
    }
  });

  it('says four words and stops, on the last one', () => {
    // Trimmed on 2026-08-19: "the portal will send for this bill" was the
    // software narrating itself to somebody who does not care it exists.
    const { text } = reminderEmail({ ...base, ordinal: 3, previous: [at(20), at(22), at(25)] });
    expect(text).not.toMatch(/portal will send/);
    expect(text).toContain('Reminders were sent on 20, 22 and 25 September.');
  });

  it('always leaves a way to reply, the last letter included', () => {
    // The final reminder is the one most likely to reach somebody who cannot
    // pay. A letter that escalates and then offers no exit is the one thing
    // these three must never do.
    for (const ordinal of [1, 2, 3]) {
      const m = reminderEmail({ ...base, ordinal, previous: [at(20), at(22)] });
      for (const body of [m.text, m.html]) {
        expect(body, `${ordinal}`).toMatch(/upload the screenshot|reach out to the committee/);
      }
    }
  });

  it('carries none of the flourishes the first drafts had', () => {
    for (const ordinal of [1, 2, 3]) {
      const { text } = reminderEmail({ ...base, ordinal, previous: [at(20), at(22)] });
      expect(text, `${ordinal}`).not.toMatch(/would rather have than not/);
      expect(text, `${ordinal}`).not.toMatch(/follow up in person/);
      expect(text, `${ordinal}`).not.toMatch(/better to say so/);
    }
  });

  it('signs as the association exactly once, in both bodies', () => {
    // The template appends the sign-off itself, so nothing here may add one:
    // a letter carrying its own name printed it twice, which is the bug the
    // bill announcement shipped with.
    for (const ordinal of [1, 2, 3]) {
      const m = reminderEmail({ ...base, ordinal, previous: [at(20), at(22)] });
      for (const body of [m.text, m.html]) {
        expect(body.match(/Association/g), `${ordinal}`).toHaveLength(1);
        expect(body, `${ordinal}`).toContain("DD Diamond Park Residents' Welfare Association");
      }
    }
  });

  it('opens its subject the way the reset emails do', () => {
    for (const ordinal of [1, 2, 3]) {
      expect(reminderEmail({ ...base, ordinal, previous: [at(20), at(22)] }).subject)
        .toMatch(/^Diamond Park — /);
    }
  });

  it('greets a resident whose name nobody recorded without a dangling space', () => {
    // The greeting opens the letter under the headline renderEmail puts first.
    expect(reminderEmail({ ...base, ordinal: 1, name: null }).text)
      .toContain('\nHello,\n');
    expect(reminderEmail({ ...base, ordinal: 1 }).text).toContain('\nHello Priya,\n');
  });

  it('carries both bodies, so a client that will not render HTML still shows one', () => {
    for (const ordinal of [1, 2, 3]) {
      const m = reminderEmail({ ...base, ordinal, previous: [at(20), at(22)] });
      expect(m.html, `${ordinal}`).toContain('<!DOCTYPE html>');
      expect(m.text, `${ordinal}`).not.toContain('<');
    }
  });

  it('says the same thing in both bodies', () => {
    // The reason the block list exists. An amount corrected in one body and
    // not the other is a resident told they owe something they do not.
    const m = reminderEmail({ ...base, ordinal: 2, previous: [at(20)] });
    for (const value of ['₹1,254.03', '3B', 'August 2026', 'Hello Priya,',
                         'is still unpaid.']) {
      expect(m.html, `html: ${value}`).toContain(value);
      expect(m.text, `text: ${value}`).toContain(value);
    }
  });

  it('puts the portal in the HTML as a button and in the text as a URL', () => {
    const m = reminderEmail({ ...base, ordinal: 1 });
    expect(m.html).toContain('href="https://diamondpark.pages.dev"');
    expect(m.html).toContain('Pay on the portal');
    expect(m.text).toContain('  https://diamondpark.pages.dev');
  });

  it('carries no payment link — an unsolicited request for money is a fraud shape', () => {
    for (const ordinal of [1, 2, 3]) {
      const m = reminderEmail({ ...base, ordinal, previous: [at(20), at(22)] });
      expect(m.html, `${ordinal}`).not.toContain('upi://');
      expect(m.text, `${ordinal}`).not.toContain('upi://');
    }
  });

  it('escapes a resident whose name is markup rather than rendering it', () => {
    const m = reminderEmail({ ...base, ordinal: 1, name: '<script>alert(1)</script>' });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
  });
});
