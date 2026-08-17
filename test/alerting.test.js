import { describe, it, expect, vi, afterEach } from 'vitest';
import { postToTelegram, reportError, episodeDecision } from '../functions/lib/errors.js';

/** Records inserts so a "did it log?" assertion is possible without D1. */
function fakeDb() {
  const inserts = [];
  return {
    inserts,
    prepare(sql) {
      return { bind: (...args) => ({ run: async () => { inserts.push({ sql, args }); return {}; } }) };
    },
  };
}

const env = (extra = {}) => ({
  TELEGRAM_BOT_TOKEN: 'test-token',
  TELEGRAM_CHAT_ID: '123',
  DB: fakeDb(),
  ...extra,
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('a failed Telegram send is not silent', () => {
  it('records DDP-SYS-004 when Telegram answers non-2xx', async () => {
    // The case that matters: a revoked token replies 401 POLITELY. Treating
    // any reply as success is exactly how alerting dies without anyone
    // noticing, which is what DDP-SYS-004 was reserved for.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 })));
    const e = env();
    const ok = await postToTelegram(e, 'hello');

    expect(ok).toBe(false);
    expect(e.DB.inserts).toHaveLength(1);
    expect(e.DB.inserts[0].args).toContain('DDP-SYS-004');
    expect(e.DB.inserts[0].args.join(' ')).toMatch(/401/);
  });

  it('records DDP-SYS-004 when the request throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const e = env();
    expect(await postToTelegram(e, 'hello')).toBe(false);
    expect(e.DB.inserts[0].args).toContain('DDP-SYS-004');
  });

  it('never echoes the bot token into the log', async () => {
    // Telegram's error bodies can quote the request URL back, token included.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 404,
      text: async () => 'Not Found: https://api.telegram.org/bottest-token/sendMessage',
    })));
    const e = env();
    await postToTelegram(e, 'hello');
    expect(JSON.stringify(e.DB.inserts)).not.toContain('test-token');
  });

  it('does not recurse when reporting its own failure', async () => {
    // DDP-SYS-004 is severity 'error', so routing it through reportError would
    // try to send again, fail again, and spin until the request died.
    const fetchMock = vi.fn(async () => { throw new Error('down'); });
    vi.stubGlobal('fetch', fetchMock);
    const e = env();
    await postToTelegram(e, 'hello');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(e.DB.inserts).toHaveLength(1);
  });

  it('reports true only on a delivery Telegram acknowledged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    const e = env();
    expect(await postToTelegram(e, 'hello')).toBe(true);
    expect(e.DB.inserts).toHaveLength(0);
  });

  it('sends nothing, and logs nothing, when unconfigured', async () => {
    // The missing-secret case is DDP-SYS-005's job at boot. Logging it again
    // on every single send would bury the error log in one repeated fact.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const e = env({ TELEGRAM_BOT_TOKEN: undefined });
    expect(await postToTelegram(e, 'hello')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(e.DB.inserts).toHaveLength(0);
  });
});

describe('what reaches Telegram instantly', () => {
  it('pushes fatal and error, and never warn', async () => {
    for (const [code, expected] of [
      ['DDP-SYS-003', true],    // error
      ['DDP-BILL-003', true],   // fatal
      ['DDP-AUTH-002', false],  // warn — a wrong password must not buzz a phone
      ['DDP-AUTH-003', false],  // warn
    ]) {
      const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      await reportError(env(), code, { probe: true });
      expect(fetchMock.mock.calls.length > 0, `${code} should ${expected ? '' : 'not '}alert`)
        .toBe(expected);
      vi.unstubAllGlobals();
    }
  });

  it('writes every severity to error_log regardless', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    const e = env();
    await reportError(e, 'DDP-AUTH-002', {});
    expect(e.DB.inserts.some((i) => i.args.includes('DDP-AUTH-002'))).toBe(true);
  });
});

describe('the rate gate', () => {
  // A pure function of the stored episode now, so there is no module-level
  // state to reset between cases and no clock to keep monotonic. The previous
  // version of this block needed both, and its flakiness was the clue that the
  // counter lived somewhere it should not have.
  const t = Date.parse('2026-08-17T10:00:00.000Z');
  const ago = (ms) => new Date(t - ms).toISOString();

  it('sends the first occurrence of a code', () => {
    expect(episodeDecision(undefined, t)).toEqual({ send: true, suppressed: 0 });
  });

  it('holds a repeat inside the cooldown and counts it', () => {
    const d = episodeDecision({ notified_at: ago(60_000), suppressed: 0 }, t);
    expect(d.send).toBe(false);
    expect(d.suppressed).toBe(1);
  });

  it('reopens once the cooldown has passed, carrying what was missed', () => {
    const d = episodeDecision({ notified_at: ago(11 * 60_000), suppressed: 47 }, t);
    expect(d.send).toBe(true);
    expect(d.suppressed).toBe(47);
  });

  it('keeps codes independent — a noisy one cannot silence a serious one', () => {
    // The failure the global bucket allowed: a blurry screenshot and a dead
    // vision provider arrive on the same path, and one filling the budget hid
    // the other entirely.
    const noisy = { notified_at: ago(60_000), suppressed: 300 };
    expect(episodeDecision(noisy, t).send).toBe(false);
    expect(episodeDecision(undefined, t).send).toBe(true);
  });

  it('sends when the stored timestamp is unusable', () => {
    // Every ambiguity resolves towards delivering: a duplicate alert is an
    // annoyance, a swallowed one is what this module exists to prevent.
    expect(episodeDecision({ notified_at: 'not a date' }, t).send).toBe(true);
  });

  it('treats a suppressed-but-never-notified row as sendable', () => {
    // A failed delivery leaves suppressed set and notified_at null. The next
    // occurrence must go out rather than inheriting a cooldown that no
    // successful send ever started.
    expect(episodeDecision({ notified_at: null, suppressed: 3 }, t).send).toBe(true);
  });
});
