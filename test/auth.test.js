import { describe, it, expect } from 'vitest';
import {
  hashPassword, verifyPassword, timingSafeEqual, generateOneTimePassword,
  newSessionToken, toBase64, fromBase64,
} from '../functions/lib/crypto.js';
import {
  hasRole, isBlockedWhileImpersonating, cookieHeader, clearCookieHeader, readCookie, COOKIE,
} from '../functions/lib/session.js';
import { buildUpiLinks, payTargetFor, IOS_SCHEMES } from '../functions/lib/upi.js';

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

  it('encodes the payee and note safely', () => {
    const { generic } = buildUpiLinks(args);
    expect(generic).toContain('pa=qr.ddwelfare%40sib');
    expect(generic).toContain('tn=Gas+2026-07+4A');
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
