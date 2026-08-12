import { describe, it, expect } from 'vitest';
import {
  hashPassword, verifyPassword, timingSafeEqual, generateOneTimePassword,
  newSessionToken, toBase64, fromBase64,
} from '../functions/lib/crypto.js';
import {
  hasRole, isBlockedWhileImpersonating, cookieHeader, clearCookieHeader, readCookie, COOKIE,
} from '../functions/lib/session.js';
import { buildUpiLinks, manualPayment, payTargetFor, IOS_SCHEMES, ANDROID_PACKAGES } from '../functions/lib/upi.js';

// Keep iterations low in tests — the production value is measured separately.
const ITER = 1000;

describe('passwords', () => {
  it('round-trips', async () => {
    const { hash, salt } = await hashPassword('correct horse battery', ITER);
    expect(await verifyPassword('correct horse battery', hash, salt, ITER)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const { hash, salt } = await hashPassword('correct horse battery', ITER);
    expect(await verifyPassword('Correct horse battery', hash, salt, ITER)).toBe(false);
  });

  it('salts, so identical passwords do not share a hash', async () => {
    const a = await hashPassword('dddp@123', ITER);
    const b = await hashPassword('dddp@123', ITER);
    expect(a.hash).not.toBe(b.hash);
    expect(a.salt).not.toBe(b.salt);
  });

  it('reports the iteration count it used, so the row can record it', async () => {
    const { iterations } = await hashPassword('correct horse battery', ITER);
    expect(iterations).toBe(ITER);
  });

  it('does not verify at a different count — the reason 0025 exists', async () => {
    // This is the lockout the per-row column prevents. Before it, raising
    // PBKDF2_ITERATIONS made every stored hash look like a wrong password,
    // for every resident, in the same deploy.
    const { hash, salt } = await hashPassword('correct horse battery', ITER);
    expect(await verifyPassword('correct horse battery', hash, salt, ITER * 2)).toBe(false);
    expect(await verifyPassword('correct horse battery', hash, salt, ITER)).toBe(true);
  });

  it('re-hashing at a new count keeps the same password working', async () => {
    // The upgrade-on-login path: verify old, re-hash high, verify high.
    const old = await hashPassword('correct horse battery', ITER);
    expect(await verifyPassword('correct horse battery', old.hash, old.salt, old.iterations))
      .toBe(true);

    const upgraded = await hashPassword('correct horse battery', ITER * 3);
    expect(upgraded.iterations).toBe(ITER * 3);
    expect(await verifyPassword('correct horse battery', upgraded.hash, upgraded.salt,
                                upgraded.iterations)).toBe(true);
    expect(await verifyPassword('wrong', upgraded.hash, upgraded.salt, upgraded.iterations))
      .toBe(false);
  });

  it('compares in constant time', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    expect(timingSafeEqual(a, new Uint8Array([1, 2, 3, 4]))).toBe(true);
    expect(timingSafeEqual(a, new Uint8Array([1, 2, 3, 5]))).toBe(false);
    expect(timingSafeEqual(a, new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('base64 round-trips arbitrary bytes', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });
});

describe('one-time passwords', () => {
  it('is say-able down a phone line — digits exclude 0 and 1', () => {
    // The word is spoken as a word, so its letters are fine; it's the isolated
    // digits that get misheard (0 as "oh", 1 as "I").
    for (let i = 0; i < 300; i++) {
      const otp = generateOneTimePassword();
      expect(otp).toMatch(/^[a-z]+-[2-9]{4}$/);
    }
  });

  it('does not repeat trivially', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateOneTimePassword()));
    expect(seen.size).toBeGreaterThan(100);
  });

  it('gives committee accounts three words and six digits', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateOneTimePassword({ strong: true }))
        .toMatch(/^[a-z]+-[a-z]+-[a-z]+-[2-9]{6}$/);
    }
  });

  it('is worth materially more than the short form', () => {
    // Not a statistical test — a floor. 200 strong codes colliding at all
    // would mean the extra words are not reaching the output.
    const strong = new Set(
      Array.from({ length: 200 }, () => generateOneTimePassword({ strong: true })));
    expect(strong.size).toBe(200);
  });
});

describe('sessions', () => {
  it('issues unique tokens that are URL-safe', () => {
    const tokens = Array.from({ length: 100 }, () => newSessionToken());
    expect(new Set(tokens).size).toBe(100);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('sets HttpOnly, Secure and SameSite on the cookie', () => {
    const h = cookieHeader('abc', 3600);
    expect(h).toContain('HttpOnly');
    expect(h).toContain('Secure');
    expect(h).toContain('SameSite=Lax');
    expect(h).toContain('Max-Age=3600');
  });

  it('clears with Max-Age=0', () => {
    expect(clearCookieHeader()).toContain('Max-Age=0');
  });

  it('reads its own cookie back out of a request', () => {
    const req = new Request('https://x/', { headers: { cookie: `other=1; ${COOKIE}=tok123; z=2` } });
    expect(readCookie(req)).toBe('tok123');
  });

  it('returns null when no cookie is present', () => {
    expect(readCookie(new Request('https://x/'))).toBe(null);
  });
});

describe('roles', () => {
  const at = (role) => ({ actor: { role } });

  it('ranks owner < admin < superadmin', () => {
    expect(hasRole(at('owner'), 'admin')).toBe(false);
    expect(hasRole(at('admin'), 'admin')).toBe(true);
    expect(hasRole(at('superadmin'), 'admin')).toBe(true);
    expect(hasRole(at('admin'), 'superadmin')).toBe(false);
  });

  it('treats a missing session as unauthorised', () => {
    expect(hasRole(null, 'owner')).toBe(false);
  });

  it('blocks credential changes while impersonating', () => {
    for (const a of ['password.change', 'mobile.change', 'email.change', 'owner.delete']) {
      expect(isBlockedWhileImpersonating(a)).toBe(true);
    }
    expect(isBlockedWhileImpersonating('bill.view')).toBe(false);
  });
});

describe('UPI links', () => {
  const args = { vpa: 'qr.ddwelfare@sib', payee: 'DD Diamond Park RWA', amount: 329.04, flat: '4A', period: '2026-07' };

  it('always sends the amount to two decimals — the paise identify the flat', () => {
    const { generic } = buildUpiLinks(args);
    expect(generic).toContain('am=329.04');
    expect(buildUpiLinks({ ...args, amount: 379 }).generic).toContain('am=379.00');
  });

  it('regenerates for a late-fee total, so the QR follows automatically', () => {
    expect(buildUpiLinks({ ...args, amount: 379.04 }).qr).toContain('am=379.04');
  });

  it('emits an iOS scheme per app, because iOS has no chooser', () => {
    const links = buildUpiLinks(args);
    for (const app of Object.keys(IOS_SCHEMES)) {
      expect(links[app].startsWith(IOS_SCHEMES[app])).toBe(true);
      expect(links[app]).toContain('am=329.04');
    }
  });

  it('encodes spaces as %20, never as +', () => {
    // URLSearchParams emits '+', which is right for HTML forms and wrong here:
    // '+' only means space in form encoding, and UPI apps percent-decode the
    // query strictly. The best case is a payee reading "DD+Diamond+Park+RWA";
    // the worst is the app rejecting the intent, which from the outside looks
    // exactly like the Pay button doing nothing at all.
    const { generic } = buildUpiLinks(args);
    expect(generic).toContain('pa=qr.ddwelfare%40sib');
    expect(generic).toContain('%20');
    expect(generic).not.toContain('+');
  });

  it('writes the note as (flat_DD_MM_YY)', () => {
    const { generic } = buildUpiLinks({ ...args, now: new Date(Date.UTC(2026, 7, 9)) });
    expect(decodeURIComponent(generic)).toContain('tn=(4A_09_08_26)');
  });

  it('offers an intent URI for Android', () => {
    // Chrome hands bare custom schemes to the OS unevenly. When it declines,
    // nothing happens at all — the reported failure. An intent URI is the
    // documented shape and falls back to the Play Store rather than silence.
    const { intent } = buildUpiLinks(args);
    expect(intent.startsWith('intent://pay?')).toBe(true);
    expect(intent).toContain('scheme=upi');
    expect(intent.endsWith(';end')).toBe(true);
  });

  it('addresses each Android app by package, so a missing app is not silence', () => {
    // The unaddressed intent assumed an OS chooser that does not always
    // appear, and "no chooser" is indistinguishable from "no app" — nothing
    // happens either way. A package intent resolves to that app or to its Play
    // Store page.
    const { androidApps } = buildUpiLinks(args);
    for (const [app, pkg] of Object.entries(ANDROID_PACKAGES)) {
      expect(androidApps[app]).toContain(`package=${pkg}`);
      expect(androidApps[app]).toContain('scheme=upi');
      expect(androidApps[app]).toContain('am=329.04');
    }
  });

  it('carries a browser_fallback_url, percent-encoded', () => {
    // Without it a non-resolving intent does nothing at all. Encoded because
    // the fragment is ';'-delimited and a raw query string truncates it.
    const { intent } = buildUpiLinks({ ...args, fallbackUrl: 'https://x.example/dashboard#pay-help' });
    expect(intent).toContain(
      `S.browser_fallback_url=${encodeURIComponent('https://x.example/dashboard#pay-help')}`);
    expect(intent.split('#Intent;')[1]).not.toContain('?');
  });

  it('omits the fallback when there is no origin to send anyone to', () => {
    expect(buildUpiLinks(args).intent).not.toContain('browser_fallback_url');
  });

  it('gives the details to type in by hand', () => {
    const m = manualPayment({ ...args, now: new Date(Date.UTC(2026, 7, 9)) });
    expect(m).toMatchObject({ vpa: 'qr.ddwelfare@sib', amount: 329.04, note: '(4A_09_08_26)' });
  });

  it('refuses a null or non-finite amount', () => {
    expect(() => buildUpiLinks({ ...args, amount: null })).toThrow(/DDP-PAY-002/);
    expect(() => buildUpiLinks({ ...args, amount: NaN })).toThrow(/DDP-PAY-002/);
    expect(() => buildUpiLinks({ ...args, amount: 0 })).toThrow(/DDP-PAY-002/);
  });

  it('refuses a missing VPA', () => {
    expect(() => buildUpiLinks({ ...args, vpa: '' })).toThrow(/DDP-PAY-004/);
  });

  it('reads the platform from the user agent', () => {
    expect(payTargetFor('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('ios');
    expect(payTargetFor('Mozilla/5.0 (Linux; Android 14)')).toBe('android');
    expect(payTargetFor('Mozilla/5.0 (Macintosh)')).toBe('desktop');
  });
});
