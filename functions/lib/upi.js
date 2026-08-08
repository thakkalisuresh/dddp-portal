/**
 * UPI deep links.
 *
 * Android surfaces an OS app chooser for `upi://pay`. iOS has NO such chooser,
 * so it needs per-app schemes. Desktop gets the same URI rendered as a QR.
 * The QR is DYNAMIC — built from the bill total at render time, so a late fee
 * regenerates it automatically (plan §4e).
 */

import { fail } from './errors.js';

export const IOS_SCHEMES = {
  gpay: 'tez://upi/pay',
  phonepe: 'phonepe://pay',
  paytm: 'paytmmp://pay',
  bhim: 'bhim://pay',
};

export function buildUpiParams({ vpa, payee, amount, note, ref }) {
  if (!vpa) fail('DDP-PAY-004', { vpa });
  if (!Number.isFinite(amount) || amount <= 0) fail('DDP-PAY-002', { amount });

  const p = new URLSearchParams();
  p.set('pa', vpa);
  p.set('pn', payee);
  p.set('am', amount.toFixed(2)); // UPI wants 2dp on the wire even for a whole amount
  p.set('cu', 'INR');
  if (note) p.set('tn', note);
  if (ref) p.set('tr', ref);
  return p;
}

export function buildUpiLinks({ vpa, payee, amount, flat, period }) {
  const note = flat && period ? `Gas ${period} ${flat}` : undefined;
  const ref = flat && period ? `DDP${flat}${period.replace('-', '')}` : undefined;
  const qs = buildUpiParams({ vpa, payee, amount, note, ref }).toString();

  const links = { generic: `upi://pay?${qs}`, qr: `upi://pay?${qs}` };
  for (const [app, scheme] of Object.entries(IOS_SCHEMES)) {
    links[app] = `${scheme}?${qs}`;
  }
  return links;
}

/** Coarse platform read — decides one button vs an app row vs a QR. */
export function payTargetFor(userAgent = '') {
  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (/android/.test(ua)) return 'android';
  return 'desktop';
}
