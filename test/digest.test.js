import { describe, it, expect } from 'vitest';
import {
  digestWindow, summariseErrors, buildDigest, runDigest, DIGEST_SETTING,
} from '../functions/lib/digest.js';

const at = (iso) => iso;
const warn = (code, when) => ({ code, severity: 'warn', at: at(when) });

/* ── the window ──────────────────────────────────────────────────────────── */

describe('the reporting window', () => {
  const now = new Date('2026-08-09T03:00:00.000Z');

  it('runs from the last digest to now, so a missed run is covered not dropped', () => {
    const w = digestWindow('2026-08-07T03:00:00.000Z', now);
    expect(w.start).toBe('2026-08-07T03:00:00.000Z');
    expect(w.end).toBe(now.toISOString());
  });

  it('falls back to 24 hours the first time it ever runs', () => {
    expect(digestWindow(null, now).start).toBe('2026-08-08T03:00:00.000Z');
  });

  it('truncates a very long gap rather than sending a wall of text', () => {
    const w = digestWindow('2026-01-01T00:00:00.000Z', now);
    expect(w.truncated).toBe(true);
    expect(w.start).toBe('2026-08-06T03:00:00.000Z');   // 72h cap
  });

  it('survives a corrupted watermark instead of reporting since 1970', () => {
    const w = digestWindow('not a date', now);
    expect(w.start).toBe('2026-08-08T03:00:00.000Z');
  });
});

/* ── grouping ────────────────────────────────────────────────────────────── */

describe('grouping', () => {
  it('counts by code and puts the loudest first', () => {
    const s = summariseErrors([
      warn('DDP-AUTH-002', '2026-08-08T10:00:00Z'),
      warn('DDP-AUTH-002', '2026-08-08T11:00:00Z'),
      warn('DDP-PROOF-002', '2026-08-08T12:00:00Z'),
    ]);
    expect(s[0]).toMatchObject({ code: 'DDP-AUTH-002', count: 2 });
    expect(s[1]).toMatchObject({ code: 'DDP-PROOF-002', count: 1 });
  });

  it('attaches the registry meaning, so the message is readable without a lookup', () => {
    expect(summariseErrors([warn('DDP-AUTH-002', '2026-08-08T10:00:00Z')])[0].message)
      .toMatch(/wrong password/i);
  });
});

/* ── the message ─────────────────────────────────────────────────────────── */

describe('the message', () => {
  const window = { start: '2026-08-08T03:00:00.000Z', end: '2026-08-09T03:00:00.000Z' };

  it('sends NOTHING when nothing happened', () => {
    // A digest that arrives every morning saying "0 warnings" trains you to
    // swipe it away, and then the one that matters gets swiped too.
    expect(buildDigest({ warns: [], alerts: [], window })).toBe(null);
  });

  it('lists warnings with counts and meanings', () => {
    const text = buildDigest({
      warns: [warn('DDP-AUTH-002', '2026-08-08T10:00:00Z'),
              warn('DDP-AUTH-002', '2026-08-08T11:00:00Z')],
      window,
    });
    expect(text).toContain('2 warnings');
    expect(text).toContain('2x DDP-AUTH-002');
    expect(text).toMatch(/wrong password/i);
  });

  it('recaps instant alerts as counts, not as a second incident', () => {
    const text = buildDigest({
      warns: [],
      alerts: [{ code: 'DDP-SYS-003', severity: 'error', at: '2026-08-08T10:00:00Z' }],
      window,
    });
    expect(text).toContain('1 alert already sent');
    expect(text).toContain('DDP-SYS-003');
  });

  it('gets the singular right, because "1 warnings" looks broken', () => {
    const text = buildDigest({ warns: [warn('DDP-AUTH-002', '2026-08-08T10:00:00Z')], window });
    expect(text).toContain('1 warning:');
    expect(text).not.toContain('1 warnings');
  });

  it('caps the list so the message stays readable', () => {
    const many = Array.from({ length: 25 }, (_, i) => warn(`DDP-FAKE-${i}`, '2026-08-08T10:00:00Z'));
    const text = buildDigest({ warns: many, window });
    expect(text).toMatch(/and 10 more kinds/);
  });

  it('says when the window was truncated, so a gap is not mistaken for calm', () => {
    const text = buildDigest({
      warns: [warn('DDP-AUTH-002', '2026-08-08T10:00:00Z')],
      window: { ...window, truncated: true },
    });
    expect(text).toMatch(/truncated/i);
  });
});

/* ── the watermark ───────────────────────────────────────────────────────── */

/** Minimal D1 stand-in: enough to drive runDigest, no more. */
function fakeDb({ rows = [], watermark = null }) {
  const writes = [];
  const db = {
    writes,
    prepare(sql) {
      return {
        bind(...args) { return this._with(args); },
        _with(args) {
          return {
            first: async () => {
              if (sql.includes('FROM settings')) return watermark ? { value: watermark } : null;
              if (sql.includes('FROM bills')) return { unpaid: 3, awaiting: 1 };
              return null;
            },
            all: async () => ({ results: rows }),
            run: async () => { writes.push({ sql, args }); return {}; },
          };
        },
        // The bills roll-up is called without .bind(), so this path has to
        // answer it too — the first version returned null here and the test
        // failed against a harness bug rather than a real one.
        first: async () => (sql.includes('FROM bills') ? { unpaid: 3, awaiting: 1 } : null),
        all: async () => ({ results: rows }),
        run: async () => { writes.push({ sql, args: [] }); return {}; },
      };
    },
  };
  return db;
}

describe('the watermark only moves on a delivery that succeeded', () => {
  const rows = [warn('DDP-AUTH-002', '2026-08-08T10:00:00Z')];

  it('advances after a successful send', async () => {
    const db = fakeDb({ rows });
    const r = await runDigest({ DB: db }, { send: async () => true });
    expect(r.sent).toBe(true);
    expect(db.writes.some((w) => w.args.includes(DIGEST_SETTING))).toBe(true);
  });

  it('does NOT advance when the send failed', async () => {
    // Otherwise a failed delivery silently eats the window and those warnings
    // are never reported by anything, ever.
    const db = fakeDb({ rows });
    const r = await runDigest({ DB: db }, { send: async () => false });
    expect(r.sent).toBe(false);
    expect(db.writes.some((w) => w.args.includes(DIGEST_SETTING))).toBe(false);
  });

  it('closes the window on a quiet night even though nothing was sent', async () => {
    // Otherwise a quiet night's rows get re-counted tomorrow and look new.
    const db = fakeDb({ rows: [] });
    let sends = 0;
    const r = await runDigest({ DB: db }, { send: async () => { sends += 1; return true; } });
    expect(sends).toBe(0);
    expect(r.sent).toBe(false);
    expect(db.writes.some((w) => w.args.includes(DIGEST_SETTING))).toBe(true);
  });

  it('includes the outstanding-bill count people actually want in the morning', async () => {
    const db = fakeDb({ rows });
    let text = '';
    await runDigest({ DB: db }, { send: async (t) => { text = t; return true; } });
    expect(text).toContain('3 unpaid bills');
    expect(text).toContain('1 awaiting review');
  });
});
