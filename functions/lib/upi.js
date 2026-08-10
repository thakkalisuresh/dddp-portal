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

/**
 * Android package names, used to address ONE app instead of asking the OS to
 * choose.
 *
 * The unaddressed `intent://` we shipped first assumed the OS chooser would
 * appear. When it does not — no handler resolved, or an in-app WebView that
 * refuses non-http schemes outright — the tap produces nothing at all, which is
 * the bug that keeps being reported. A `package=` intent cannot land there: if
 * the app is missing, Chrome opens its Play Store page instead of doing
 * nothing.
 */
export const ANDROID_PACKAGES = {
  gpay: 'com.google.android.apps.nbu.paisa.user',
  phonepe: 'com.phonepe.app',
  paytm: 'net.one97.paytm',
  bhim: 'in.org.npci.upiapp',
};

/**
 * Extras on an intent URI go in the fragment, after the scheme.
 *
 * `browser_fallback_url` is the documented escape hatch: without it a
 * non-resolving intent is silent, and silence is indistinguishable from a dead
 * button. It must be percent-encoded — the fragment is `;`-delimited and a raw
 * query string inside it truncates the intent.
 */
function intentUri(qs, { pkg, fallbackUrl } = {}) {
  const parts = ['scheme=upi', 'action=android.intent.action.VIEW'];
  if (pkg) parts.push(`package=${pkg}`);
  if (fallbackUrl) parts.push(`S.browser_fallback_url=${encodeURIComponent(fallbackUrl)}`);
  return `intent://pay?${qs}#Intent;${parts.join(';')};end`;
}

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

/**
 * Query string with spaces as %20, not '+'.
 *
 * URLSearchParams emits '+', which is correct for HTML form encoding and wrong
 * here: '+' only means space in application/x-www-form-urlencoded, and UPI apps
 * percent-decode the query strictly. A payee of "DD+Diamond+Park+RWA" is the
 * best case; some apps reject the intent outright, which looks from the outside
 * exactly like the button doing nothing.
 */
export function queryString(params) {
  return params.toString().replace(/\+/g, '%20');
}

/**
 * The date stamp residents see on their bank statement: 09_08_26.
 *
 * Taken when the link is built rather than when the bill was issued, because
 * the treasurer is matching against a statement line dated the day the money
 * moved.
 */
export function stampFor(date = new Date()) {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(date.getUTCFullYear()).slice(2);
  return `${dd}_${mm}_${yy}`;
}

export function buildUpiLinks({ vpa, payee, amount, flat, period, now = new Date(), fallbackUrl }) {
  // (2B_09_08_26) — the flat, then the day the link was made. The reference
  // below is what actually reconciles; this is what a human reads in a
  // statement line, so it is short and shaped like a label rather than a
  // sentence.
  const note = flat ? `(${flat}_${stampFor(now)})` : undefined;
  const ref = flat && period ? `DDP${flat}${period.replace('-', '')}` : undefined;
  const qs = queryString(buildUpiParams({ vpa, payee, amount, note, ref }));

  const links = {
    generic: `upi://pay?${qs}`,
    qr: `upi://pay?${qs}`,
    // Chrome on Android hands custom schemes to the OS unevenly. An intent URI
    // is the documented form and falls back to the Play Store rather than
    // silently doing nothing, which is the failure that got reported.
    intent: intentUri(qs, { fallbackUrl }),
    // One entry per app, each addressed by package. This is what the Android
    // screen actually renders now: an unaddressed intent relies on a chooser
    // that does not always appear, and "no chooser" and "no app" look the same
    // from the resident's side — nothing happens.
    androidApps: Object.fromEntries(
      Object.entries(ANDROID_PACKAGES).map(([app, pkg]) => [app, intentUri(qs, { pkg, fallbackUrl })])
    ),
  };
  for (const [app, scheme] of Object.entries(IOS_SCHEMES)) {
    links[app] = `${scheme}?${qs}`;
  }
  return links;
}

/** What someone types into their own UPI app when no link worked. */
export function manualPayment({ vpa, payee, amount, flat, now = new Date() }) {
  return {
    vpa,
    payee,
    amount,
    note: flat ? `(${flat}_${stampFor(now)})` : null,
  };
}

/** Coarse platform read — decides one button vs an app row vs a QR. */
export function payTargetFor(userAgent = '') {
  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (/android/.test(ua)) return 'android';
  return 'desktop';
}
