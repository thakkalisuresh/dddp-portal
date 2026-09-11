import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  postToTelegram, reportError, episodeDecision, describeDevice, requestContextFor,
  alertContext, describeContext, topFrames, AppError,
} from '../functions/lib/errors.js';

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

describe('an alert says who hit it', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
  const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1';
  const WIN_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.68';

  const tenant = { id: 42, name: 'Priya Menon', role: 'owner', relationship: 'tenant', flat: '5A' };
  const admin = { id: 7, name: 'Ramesh K', role: 'admin', relationship: 'owner', flat: '3B' };

  // Safari 26 froze the OS token at 18_6; its own version is the real one.
  const IPHONE_26 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
  // Chrome's reduced UA: "Android 10; K" on every phone, whatever it runs.
  const ANDROID_REDUCED = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
  const SAMSUNG = 'Mozilla/5.0 (Linux; Android 13; SM-A536E) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36';
  const WEBVIEW = 'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A; wv) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36';

  it('labels OS and browser with their versions', () => {
    expect(describeDevice(IPHONE)).toBe('phone · iOS 17.5 · Safari 17.5');
    expect(describeDevice(IPHONE_26)).toBe('phone · iOS 26.0 · Safari 26.0');
    expect(describeDevice(ANDROID_CHROME)).toBe('phone · Android 14 · Chrome 126');
    // Both carry "Safari/" — the order of the tests is what keeps them apart.
    expect(describeDevice(IOS_CHROME)).toBe('phone · iOS 17.5 · Chrome 126');
    expect(describeDevice(WIN_EDGE)).toBe('desktop · Windows · Edge 126');
    expect(describeDevice(SAMSUNG)).toBe('phone · Android 13 · Samsung Internet 25');
    expect(describeDevice('')).toBe('unknown device');
  });

  it('prints no Android version rather than Chrome’s frozen "10"', () => {
    expect(describeDevice(ANDROID_REDUCED)).toBe('phone · Android · Chrome 126');
  });

  it('takes the real version and model from Client Hints when Chrome sends them', () => {
    expect(describeDevice(ANDROID_REDUCED, { platformVersion: '"14.0.0"', model: '"SM-S918B"' }))
      .toBe('phone · Android 14 (SM-S918B) · Chrome 126');
    expect(describeDevice(WIN_EDGE, { platformVersion: '"15.0.0"' })).toBe('desktop · Windows 11 · Edge 126');
    expect(describeDevice(WIN_EDGE, { platformVersion: '"10.0.0"' })).toBe('desktop · Windows 10 · Edge 126');
  });

  it('says when it was opened inside an app', () => {
    expect(describeDevice(WEBVIEW)).toBe('phone · Android 14 · Chrome 126 · in an app webview');
    expect(describeDevice(`${IPHONE} WhatsApp/2.24`)).toMatch(/in WhatsApp$/);
  });

  const request = (headers = {}, cf = { city: 'Dubai', country: 'AE' }) => ({
    method: 'POST',
    url: 'https://diamondpark.pages.dev/api/proof?token=secret',
    headers: new Headers({ 'user-agent': IPHONE, 'cf-ray': '8c1f2a3b4c5d-BOM', ...headers }),
    cf,
  });

  it('reads city, country, page, route and ray off the request — never the query', () => {
    const c = requestContextFor(request({ referer: 'https://diamondpark.pages.dev/pay?link=abc' }));
    expect(c.location).toBe('Dubai, AE');
    expect(c.page).toBe('/pay');
    expect(c.route).toBe('POST /api/proof');
    expect(c.ray).toBe('8c1f2a3b4c5d-BOM');
    expect(JSON.stringify(c)).not.toMatch(/secret|abc/);
  });

  it('ignores a referer from another site, and a request with no cf', () => {
    const c = requestContextFor(request({ referer: 'https://example.com/x' }, null));
    expect(c.page).toBeNull();
    expect(c.location).toBeNull();
  });

  it('names flat, owner or tenant, first name and id — never mobile or email', () => {
    const text = describeContext(alertContext({
      route: 'POST /api/proof', page: '/pay', device: 'phone · iOS 17.5 · Safari 17.5',
      location: 'Dubai, AE', ray: 'r1',
      session: { actor: { ...tenant, mobile: '+919800000000', email: 'p@x.in' }, impersonating: false },
    }));
    expect(text).toContain('Who: Flat 5A · tenant · Priya (#42)');
    expect(text).toContain('Device: phone · iOS 17.5 · Safari 17.5');
    expect(text).toContain('From: Dubai, AE');
    expect(text).toContain('Route: POST /api/proof (on /pay)');
    expect(text).toContain('Release: dev · ray r1');
    expect(text).not.toMatch(/Menon|9800000000|p@x\.in/);
  });

  it('shows the role above resident, and whose screen god mode was on', () => {
    const text = describeContext(alertContext({
      route: 'GET /api/me', device: 'desktop · macOS · Safari 17.5',
      session: { actor: admin, subject: tenant, impersonating: true },
    }));
    expect(text).toContain('Who: Flat 3B · owner · admin · Ramesh (#7)');
    expect(text).toContain('Viewing as: Flat 5A · tenant · Priya (#42)');
  });

  it('says so when nobody was signed in', () => {
    expect(describeContext(alertContext({ route: 'POST /api/login', session: null })))
      .toContain('Who: not signed in');
  });

  it('claims nobody when no request is behind it — the nightly cron', () => {
    expect(alertContext(undefined)).toEqual({ release: 'dev' });
    expect(describeContext(alertContext(undefined))).toBe('Release: dev');
  });

  it('keeps the top frames of a stack, not the whole path there', () => {
    const stack = 'TypeError: x\n    at a (index.js:1:1)\n    at b (index.js:2:2)\n'
      + '    at c (index.js:3:3)\n    at d (index.js:4:4)';
    expect(topFrames(stack)).toBe('at a (index.js:1:1)\nat b (index.js:2:2)\nat c (index.js:3:3)');
    expect(topFrames(undefined)).toBeNull();
  });

  it('puts it all in the Telegram message and in error_log', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const context = requestContextFor(request({ referer: 'https://diamondpark.pages.dev/pay' }));
    context.session = { actor: tenant, impersonating: false };
    const e = Object.create(env(), { requestContext: { value: context } });

    await reportError(e, 'DDP-PROOF-007', new AppError('DDP-PROOF-007', { provider: 'gemini', status: 503 }));

    const { text } = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(text).toContain('Who: Flat 5A · tenant · Priya (#42)');
    expect(text).toContain('Device: phone · iOS 17.5 · Safari 17.5');
    expect(text).toContain('From: Dubai, AE');
    expect(text).toContain('Route: POST /api/proof (on /pay)');
    expect(text).toContain('"provider":"gemini"');
    expect(text).toMatch(/\nat /);   // where it broke

    const row = e.DB.inserts.find((i) => i.sql.includes('context'));
    const stored = JSON.parse(row.args[4]);
    expect(stored.who).toBe('Flat 5A · tenant · Priya (#42)');
    expect(stored.location).toBe('Dubai, AE');
  });

  it('still writes the row when migration 0039 has not been applied', async () => {
    // Deployed before the migration, the context insert fails every time — and
    // reportError swallows failures, so without a fallback error_log goes empty.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    const written = [];
    const DB = {
      prepare: (sql) => ({ bind: (...args) => ({ run: async () => {
        if (sql.includes('context')) throw new Error('no such column: context');
        written.push(args);
        return {};
      } }) }),
    };
    await reportError({ ...env(), DB }, 'DDP-AUTH-002', {});
    expect(written.some((a) => a.includes('DDP-AUTH-002'))).toBe(true);
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
