import { describe, it, expect, vi, afterEach } from 'vitest';
import { postToTelegram, reportError, shouldAlert } from '../functions/lib/errors.js';

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
  // The window is module-level state, so it carries whatever the alerting
  // tests above already spent. Each case starts beyond the window so the first
  // call forces a reset and the counts mean what they say.
  //
  // Monotonic, not random. A random offset made this FLAKY rather than merely
  // wrong: if one case's base landed earlier than the previous case's, the
  // elapsed time went negative, no reset happened, and the count carried over.
  // The full suite passed by luck while the file alone failed.
  let clock = Date.now() + 3_600_000;
  const fresh = () => (clock += 600_000);

  it('stops after 8 in a minute, with exactly one notice', () => {
    const t = fresh();
    const results = Array.from({ length: 12 }, () => shouldAlert(t));
    expect(results.filter((r) => r === true)).toHaveLength(8);
    expect(results.filter((r) => r === 'suppress-notice')).toHaveLength(1);
    expect(results.filter((r) => r === false)).toHaveLength(3);
  });

  it('reopens in the next minute', () => {
    const t = fresh();
    for (let i = 0; i < 12; i++) shouldAlert(t);
    expect(shouldAlert(t + 61_000)).toBe(true);
  });
});
