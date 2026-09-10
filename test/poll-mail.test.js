import { describe, it, expect } from 'vitest';
import { pollEmail, drainPollMail, DRAIN_SIZE, MAX_ATTEMPTS } from '../functions/lib/poll-mail.js';
import { deadlineText } from '../functions/lib/poll-text.js';
import { renderEmail } from '../functions/lib/email-template.js';

const CLOSES = '2026-09-20T12:30:00.000Z';   // 6:00 pm IST
const base = { title: 'Which quote?', closesAt: CLOSES, pollId: 4, origin: 'https://x.test' };

describe('the letters', () => {
  const OPTIONS = [
    { label: 'Shalimar Waterproofing', sub: '₹4,20,000 · 7-year warranty' },
    { label: 'Deccan Coatings', sub: '₹3,80,000 · 5-year warranty' },
  ];
  const full = { ...base, body: 'Three quotes are on the noticeboard.', options: OPTIONS };

  /** Every word a block renders, whatever field it keeps it in. */
  const words = (mail) => mail.blocks.flatMap((b) => [
    b.text, b.label, b.value, b.caption,
    ...(b.entries ?? []).flat(),
  ]).filter(Boolean).join(' ');

  it('carries the options, so the letter is not just a notification', () => {
    // The first version sent the title and a button, which asked the reader to
    // open a link to find out what the question even offered.
    for (const kind of ['opened', 'reminder']) {
      const body = words(pollEmail(kind, full));
      expect(body, kind).toContain('Shalimar Waterproofing');
      expect(body, kind).toContain('₹3,80,000 · 5-year warranty');
    }
  });

  it('carries the poll’s own description on the opening letter', () => {
    expect(words(pollEmail('opened', full))).toContain('Three quotes are on the noticeboard.');
  });

  it('states no count before the committee has published one', () => {
    // An email is the one surface the committee cannot take back.
    for (const kind of ['opened', 'reminder']) {
      const body = words(pollEmail(kind, full));
      expect(body, kind).not.toMatch(/\b\d+\s*(flats?|votes?)\b/i);
      expect(body, kind).not.toMatch(/so far|leading|ahead|turnout/i);
    }
  });

  it('carries the winner and the turnout, and NOT the split', () => {
    // An email is a permanent copy outside the portal. Unpublishing takes the
    // count off the screen; it cannot take it out of ninety inboxes. So the
    // outcome travels and the per-option breakdown stays where withdrawing it
    // still means something.
    const body = words(pollEmail('result', {
      ...full,
      result: {
        options: [{ label: 'Shalimar Waterproofing', votes: 51 },
                  { label: 'Deccan Coatings', votes: 19 }],
        flats: 70, flatsTotal: 89,
      },
    }));
    expect(body).toContain('Shalimar Waterproofing');
    expect(body).toContain('70 of 89 flats voted');
    // The loser's number must not be in the letter.
    expect(body).not.toContain('19 flats');
    expect(body).not.toContain('51 flats');
  });

  it('reports a tie and does not resolve it', () => {
    const body = words(pollEmail('result', {
      ...full,
      result: {
        options: [{ label: 'Shalimar Waterproofing', votes: 20 },
                  { label: 'Deccan Coatings', votes: 20 }],
        flats: 40, flatsTotal: 89,
      },
    }));
    expect(body).toMatch(/tied between/i);
    expect(body).toMatch(/committee will decide/i);
  });

  it('links to the poll, not to the portal’s front door', () => {
    for (const kind of ['opened', 'reminder', 'result']) {
      const link = pollEmail(kind, full).blocks.find((b) => b.type === 'action');
      expect(link.url, kind).toBe('https://x.test/polls?id=4');
    }
  });

  it('never prints an unlabelled clock', () => {
    // The figure sets 32px type, so the deadline is shortened and IST moves to
    // the caption — it must not be dropped on the way.
    for (const kind of ['opened', 'reminder']) {
      expect(words(pollEmail(kind, full)), kind).toContain('IST');
    }
  });

  it('says a published result is the count alone', () => {
    expect(words(pollEmail('result', full))).toMatch(/how each flat voted is not shown/i);
  });

  it('gives each kind its own subject', () => {
    const subjects = ['opened', 'reminder', 'result'].map((k) => pollEmail(k, full).subject);
    expect(new Set(subjects).size).toBe(3);
    expect(subjects[1]).toMatch(/has not voted/i);
  });

  it('renders to real HTML with the shared template', () => {
    const m = pollEmail('opened', full);
    const out = renderEmail({ title: m.subject, preview: m.preview, blocks: m.blocks });
    expect(out.html).toMatch(/<table/);
    expect(out.html).toContain('Shalimar Waterproofing');
    expect(out.text).toContain('Shalimar Waterproofing');
    expect(out.subject).toMatch(/^Diamond Park — /);
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
