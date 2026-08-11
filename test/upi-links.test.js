import { describe, it, expect } from 'vitest';
import { buildUpiLinks, buildUpiParams, queryString, payTargetFor, APP_SCHEMES } from '../functions/lib/upi.js';

/**
 * The reported bug: on Android Chrome, every UPI button appeared to reload the
 * page instead of opening an app.
 *
 * Two causes, both pinned here.
 *
 * 1. The payload carried `tr` and no `mc`. NPCI's linking spec makes `tr`
 *    "mandatory for merchant transactions", so sending it alone describes a P2M
 *    payment missing half its fields — and a PSP app that cannot classify a
 *    payload refuses it generically, which from a browser is indistinguishable
 *    from the app declining to open. It was also derived from flat and period,
 *    so every retry reused one reference and invited duplicate detection.
 *
 * 2. Android was offered ONLY package-addressed intents, never the implicit
 *    `upi://pay` link that NPCI defines and that hands the OS every installed
 *    PSP app. One refusal took the whole screen down with it.
 */

const base = {
  vpa: 'qr.ddwelfare@sib',
  payee: 'DD Diamond Park RWA',
  amount: 289,
  flat: '16A',
  period: '2026-07',
  now: new Date('2026-08-11T04:00:00Z'),
};

describe('what goes into the payment link', () => {
  it('does not send a transaction reference', () => {
    const { generic } = buildUpiLinks(base);
    expect(generic).not.toContain('tr=');
  });

  it('does not claim to be a merchant', () => {
    // If `mc` ever appears, `tr` has to come back with it — the pair is the
    // thing that makes a P2M payload valid.
    const { generic } = buildUpiLinks(base);
    expect(generic).not.toContain('mc=');
  });

  it('still carries what the treasurer reconciles against', () => {
    const { generic } = buildUpiLinks(base);
    // The note is the human-readable handle in a bank statement line.
    expect(decodeURIComponent(generic)).toContain('(16A_11_08_26)');
  });

  it('sends the amount with two decimal places', () => {
    // Whole integers are rejected by some apps, per the linking spec.
    expect(buildUpiLinks(base).generic).toContain('am=289.00');
  });

  it('percent-encodes spaces rather than using +', () => {
    const { generic } = buildUpiLinks(base);
    expect(generic).toContain('DD%20Diamond%20Park%20RWA');
    expect(generic).not.toContain('+');
  });

  it('rejects an amount that is not payable', () => {
    for (const amount of [0, -5, NaN, undefined]) {
      expect(() => buildUpiParams({ ...base, amount }), String(amount)).toThrow(/DDP-PAY-002/);
    }
  });
});

describe('the routes Android is given', () => {
  const links = buildUpiLinks({ ...base, fallbackUrl: 'https://x.test/dashboard?upi=blocked#pay-help' });

  it('offers the implicit upi:// link, which is the one NPCI defines', () => {
    expect(links.generic.startsWith('upi://pay?')).toBe(true);
  });

  it('still offers a package-addressed intent per app', () => {
    expect(links.androidApps.gpay).toContain('package=com.google.android.apps.nbu.paisa.user');
    expect(links.androidApps.phonepe).toContain('package=com.phonepe.app');
    expect(links.androidApps.gpay.startsWith('intent://pay?')).toBe(true);
    expect(links.androidApps.gpay).toContain('scheme=upi');
  });

  it('sends the fallback somewhere that can explain itself', () => {
    // A bare /dashboard was the bug: navigating to the page you are already on
    // is indistinguishable from a reload.
    expect(decodeURIComponent(links.androidApps.gpay)).toContain('upi=blocked');
  });

  it('percent-encodes the fallback so it cannot truncate the intent', () => {
    // The fragment is ';'-delimited; a raw query string inside it would cut the
    // intent short at the first '&'.
    const fragment = links.androidApps.gpay.split('#Intent;')[1];
    expect(fragment).not.toContain('?upi=blocked');
    expect(fragment.endsWith(';end')).toBe(true);
  });

  it('gives the QR the same URI as the buttons', () => {
    expect(links.qr).toBe(links.generic);
  });
});

describe('per-app schemes', () => {
  it('leads with the current Google Pay scheme, not the old Tez one', () => {
    // tez:// was the scheme when the app was called Tez. It stays as a second
    // attempt for old installs, but it is no longer what we try first.
    expect(APP_SCHEMES.gpay[0]).toBe('gpay://upi/pay');
    expect(APP_SCHEMES.gpay).toContain('tez://upi/pay');
  });

  it('has a scheme for every app the screen offers', () => {
    for (const app of ['gpay', 'phonepe', 'paytm', 'bhim']) {
      expect(APP_SCHEMES[app]?.length, app).toBeGreaterThan(0);
    }
  });
});

describe('which screen a device gets', () => {
  it('reads Android, iOS and everything else', () => {
    expect(payTargetFor('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126')).toBe('android');
    expect(payTargetFor('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari')).toBe('ios');
    expect(payTargetFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/126')).toBe('desktop');
    expect(payTargetFor('')).toBe('desktop');
  });
});

describe('query encoding', () => {
  it('never emits a bare +, which UPI apps read as a literal plus', () => {
    const p = new URLSearchParams({ pn: 'A B C' });
    expect(queryString(p)).toBe('pn=A%20B%20C');
  });
});
