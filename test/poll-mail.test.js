import { describe, it, expect } from 'vitest';
import { pollEmail, drainPollMail, DRAIN_SIZE, MAX_ATTEMPTS } from '../functions/lib/poll-mail.js';
import { deadlineText } from '../functions/lib/poll-text.js';

const CLOSES = '2026-09-20T12:30:00.000Z';   // 6:00 pm IST
const base = { title: 'Which quote?', closesAt: CLOSES, pollId: 4, origin: 'https://x.test' };

describe('the letters', () => {
  const text = (kind) => pollEmail(kind, base).blocks
    .map((b) => b.text ?? b.label ?? '').join(' ');

  it('never states a count, a turnout or a split', () => {
    // The one rule an email cannot walk back: it reaches ninety inboxes at
    // once and the committee cannot un-send it.
    for (const kind of ['opened', 'reminder', 'result']) {
      const body = text(kind);
      expect(body, kind).not.toMatch(/\b\d+\s*(flats?|votes?)\b/i);
      expect(body, kind).not.toMatch(/so far|leading|ahead|turnout/i);
    }
  });

  it('links to the poll, not to the portal’s front door', () => {
    for (const kind of ['opened', 'reminder', 'result']) {
      const link = pollEmail(kind, base).blocks.find((b) => b.type === 'action');
      expect(link.url, kind).toBe('https://x.test/polls?id=4');
    }
  });

  it('names the deadline in the building’s clock on both letters that have one', () => {
    expect(text('opened')).toContain('IST');
    expect(text('reminder')).toContain('IST');
  });

  it('says the reminder is the only one, because it is', () => {
    // reminders.js records the committee deciding a fourth chase for an unpaid
    // bill is harassment. A poll is smaller than a bill.
    expect(text('reminder')).toMatch(/only reminder/i);
  });

  it('says a published result is the count alone', () => {
    expect(text('result')).toMatch(/how each flat voted is not shown/i);
  });

  it('gives each kind its own subject', () => {
    const subjects = ['opened', 'reminder', 'result'].map((k) => pollEmail(k, base).subject);
    expect(new Set(subjects).size).toBe(3);
    expect(subjects[1]).toMatch(/has not voted/i);
  });
});

describe('deadlineText', () => {
  it('writes the building’s clock, named', () => {
    expect(deadlineText(CLOSES)).toBe('Sunday 20 September at 6:00 pm IST');
  });

  it('degrades rather than printing Invalid Date at a resident', () => {
    expect(deadlineText('not a date')).toBe('shortly');
  });
});

describe('the drain', () => {
  const row = (over = {}) => ({
    poll_id: 1, owner_id: 7, kind: 'reminder', attempts: 0,
    email: 'a@b.test', title: 'Which quote?', closes_at: CLOSES, ...over,
  });

  function fakeEnv({ queue = [], send = async () => ({ sent: true }) } = {}) {
    const writes = [];
    return {
      writes,
      MAIL_FROM: 'x@y.test',
      GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REFRESH_TOKEN: 'tok',
      _send: send,
      DB: {
        prepare: (sql) => ({
          bind: (...args) => ({
            all: async () => ({ results: sql.includes('FROM poll_mail m') ? queue : [] }),
            first: async () => ({ n: queue.length }),
            run: async () => { writes.push({ sql, args }); },
          }),
        }),
      },
    };
  }

  it('sends nothing, and says why, when mail is not configured', async () => {
    const env = fakeEnv({ queue: [row()] });
    delete env.GOOGLE_REFRESH_TOKEN;
    const out = await drainPollMail(env);
    expect(out).toEqual({ sent: 0, failed: 0, reason: 'not-configured' });
  });

  it('reports sends and failures only — never a breakdown by kind', async () => {
    // A reminder drain reporting "18 reminders sent for poll 4" tells the
    // reader that eighteen flats had not voted. That IS the turnout.
    const out = await drainPollMail(fakeEnv({ queue: [] }));
    expect(Object.keys(out).sort()).toEqual(['failed', 'sent']);
  });

  it('takes twenty at a time, which is the subrequest budget', () => {
    expect(DRAIN_SIZE).toBe(20);
  });

  it('gives up after three attempts', () => {
    expect(MAX_ATTEMPTS).toBe(3);
  });
});
