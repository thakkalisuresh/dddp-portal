/**
 * UPI deep links.
 *
 * Android surfaces an OS app chooser for `upi://pay`. iOS has NO such chooser,
 * so it needs per-app schemes. Desktop gets the same URI rendered as a QR.
 * The QR is DYNAMIC — built from the bill total at render time, so a late fee
 * regenerates it automatically (plan §4e).
 */

import { fail } from './errors.js';

/**
 * Per-app schemes, used where the OS will not offer a chooser.
 *
 * `tez://` was Google Pay's scheme when the app was called Tez, and it is the
 * one this file shipped with. Current guidance across the gateway SDKs is
 * `gpay://upi/pay`; tez:// still resolves on older installs, so it stays as a
 * second attempt rather than being deleted.
 */
export const APP_SCHEMES = {
  gpay: ['gpay://upi/pay', 'tez://upi/pay'],
  phonepe: ['phonepe://pay', 'phonepe://upi/pay'],
  paytm: ['paytmmp://pay', 'paytm://upi/pay'],
  bhim: ['bhim://pay', 'bhim://upi/pay'],
};

/** The first scheme for each app — what a single href can carry. */
export const IOS_SCHEMES = Object.fromEntries(
  Object.entries(APP_SCHEMES).map(([app, [first]]) => [app, first])
);

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
  // (2B_09_08_26) — the flat, then the day the link was made. This is what a
  // human reads in a statement line, so it is short and shaped like a label
  // rather than a sentence, and it is what the treasurer reconciles against.
  const note = flat ? `(${flat}_${stampFor(now)})` : undefined;

  // NO `tr`. It used to carry DDP<flat><period>, and it was doing damage:
  //
  //   * NPCI's linking spec makes `tr` "mandatory for merchant transactions".
  //     Sending it WITHOUT the merchant code `mc` describes a P2M payment that
  //     is missing half its fields, and PSP apps answer a payload they cannot
  //     classify with a generic refusal — which from a browser looks like the
  //     app simply declining to open.
  //   * It was derived from flat and period, so every retry of the same bill
  //     reused the same reference. A repeated `tr` is what duplicate detection
  //     exists to catch.
  //
  // Nothing in this codebase ever read it back: reconciliation matches on the
  // note above and on the UTR lifted from the payment screenshot. So it was
  // pure liability, and this is a P2P transfer to the association's own VPA —
  // which is what it should have been described as all along. If the RWA ever
  // registers as a merchant, `tr` comes back WITH `mc`, together.
  const qs = queryString(buildUpiParams({ vpa, payee, amount, note }));

  const links = {
    // The implicit link, and on Android the one to try FIRST. NPCI's own flow
    // is "hand `upi://pay` to the OS and let it offer every PSP app installed";
    // Paytm's integration guide says the same for mobile web. Addressing one
    // package is an optimisation on top of that, and this file previously
    // shipped only the optimisation — so when it was refused, Android had no
    // route left at all.
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

/* ── the maintenance payee ────────────────────────────────────────────────
   Maintenance is paid into a DIFFERENT bank account from gas, and at the time
   of writing that account has no UPI ID. Both routes are therefore built and
   the live one is chosen by configuration, so that whichever the bank ends up
   giving us is a variable change rather than a code change.

   NOTHING HERE IS HARD-CODED, and that is not a style preference: this repo is
   public. The account number and the IFSC are read from the environment and set
   as Pages secrets, and no test fixture or default may carry the real ones.   */

/** `upi` once the bank issues a VPA; `account` until then. */
export function maintPayeeMode(env) {
  return env?.MAINT_PAYEE_MODE === 'upi' ? 'upi' : 'account';
}

/**
 * The address residents actually pay, and what to show beside it.
 *
 * In `account` mode the address is ASSEMBLED HERE, at runtime, from the two
 * halves — `<account>@<IFSC>.ifsc.npci`, NPCI's documented form for paying an
 * account number directly. Assembling rather than storing the finished string
 * means neither half is ever written down anywhere but the secret store, and
 * the diagnostics check can tell "no account configured" from "no IFSC".
 *
 * Returns `{ ok: false }` rather than throwing or guessing. A half-configured
 * payee must surface as a finding an admin can read, never as a Pay button that
 * opens a UPI app addressed to nobody — which is indistinguishable, from the
 * resident's side, from the app being broken.
 */
export function maintPayee(env) {
  const mode = maintPayeeMode(env);
  const payee = String(env?.MAINT_PAYEE_NAME ?? '').trim();

  if (mode === 'upi') {
    const vpa = String(env?.MAINT_UPI_VPA ?? '').trim();
    if (!vpa) return { ok: false, mode, reason: 'no-vpa' };
    if (!payee) return { ok: false, mode, reason: 'no-payee-name' };
    return { ok: true, mode, vpa, payee, bankDetails: null };
  }

  const account = String(env?.MAINT_ACCOUNT_NUMBER ?? '').trim();
  const ifsc = String(env?.MAINT_IFSC ?? '').trim().toUpperCase();
  if (!account) return { ok: false, mode, reason: 'no-account' };
  if (!ifsc) return { ok: false, mode, reason: 'no-ifsc' };
  if (!payee) return { ok: false, mode, reason: 'no-payee-name' };

  return {
    ok: true,
    mode,
    vpa: `${account}@${ifsc}.ifsc.npci`,
    payee,
    // Shown beside the button so a resident whose app refuses the address —
    // PhonePe and Paytm both block account-number payments — has something to
    // copy into a transfer by hand rather than a dead end.
    bankDetails: { account, ifsc, name: payee },
  };
}

/**
 * The note that lands on the bank statement: `(2B_MAINT_Q4_26)`.
 *
 * THE YEAR IS NOT DECORATION. Gas stamps the day the link was built, which is
 * unique enough in practice. Maintenance cannot borrow that: the bill is the
 * same amount for every flat of the same kind, so the unique-paise fingerprint
 * gas once relied on does not exist here and the note is one of only two things
 * reconciliation has. `(2B_MAINT_Q4)` without a year repeats every fourth
 * quarter, and a treasurer looking at two identical credits from the same flat
 * a year apart would have no way to tell which quarter either one settled.
 *
 * Shaped like a label rather than a sentence, because a human reads it in a
 * statement line: flat, what it is for, the quarter, the year.
 */
export function maintNote(flat, quarter) {
  const m = /^(\d{4})-Q([1-4])$/.exec(String(quarter ?? ''));
  if (!flat || !m) return undefined;
  return `(${flat}_MAINT_Q${m[2]}_${m[1].slice(2)})`;
}

/**
 * Read a maintenance note back out of a bank statement narration.
 *
 * THE INVERSE OF `maintNote`, and deliberately sitting against it: the format
 * is agreed between the payment sheet that writes it and reconciliation that
 * reads it, and two copies of that agreement in two files is how one of them
 * quietly stops matching. Change the shape above and this fails in the same
 * commit.
 *
 * This is the SECOND of the two things reconciliation has for maintenance -- the
 * first being the reference -- and 0042 is explicit that they are all it has.
 * A narration carrying `(2B_MAINT_Q4_26)` names the flat AND the quarter, which
 * is a stronger claim than the amount could ever make, because the amount is
 * the same rupee for forty-one flats.
 *
 * Tolerant about what surrounds it and strict about the note itself: banks pad,
 * truncate and upper-case narrations freely, so the note is searched for rather
 * than anchored, but a partial one is not guessed at. Returns null when there
 * is nothing certain to say.
 *
 * The two-digit year is widened to 20xx. This portal did not exist in 1926 and
 * will be somebody else's problem in 2126.
 */
export function parseMaintNote(narration) {
  const m = /\(\s*([A-Za-z0-9-]{1,10})_MAINT_Q([1-4])_(\d{2})\s*\)/i.exec(String(narration ?? ''));
  if (!m) return null;
  return { flat: m[1].toUpperCase(), quarter: `20${m[3]}-Q${m[2]}` };
}

/**
 * What to show beside "Maintenance" on the reconciliation account picker.
 *
 * LAST FOUR DIGITS, NEVER MORE, and never the IFSC. The whole reason the
 * account and the IFSC are secrets rather than vars is that this repository is
 * public; a helper that renders them in full on an admin screen would put them
 * one screenshot away from being public too. Four digits are enough for a
 * treasurer to tell which of two statements they are holding, which is the only
 * question this line exists to answer.
 *
 * Returns null when the payee is not configured yet, so the picker can say so
 * rather than drawing a blank second line nobody can interpret.
 */
export function maintAccountHint(env) {
  const payee = maintPayee(env);
  if (!payee.ok) return null;
  if (payee.mode === 'upi') return payee.vpa;
  const digits = String(env?.MAINT_ACCOUNT_NUMBER ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? `the account ending ${digits.slice(-4)}` : null;
}

/**
 * The pay links for a maintenance bill.
 *
 * Deliberately thin over buildUpiLinks: the platform quirks it handles — the
 * missing iOS chooser, Chrome's uneven scheme handling, the intent fallback —
 * are properties of UPI and Android, not of which bill is being paid. The only
 * things that differ are the payee and the note.
 *
 * No `tr`, for the reason buildUpiLinks states at length: without a merchant
 * code it describes a P2M payment missing half its fields, and PSP apps answer
 * a payload they cannot classify with a generic refusal that looks, from a
 * browser, exactly like the app declining to open.
 */
export function buildMaintUpiLinks({ env, amount, flat, quarter, fallbackUrl }) {
  const payee = maintPayee(env);
  if (!payee.ok) fail('DDP-PAY-004', { reason: payee.reason, mode: payee.mode });

  const qs = queryString(buildUpiParams({
    vpa: payee.vpa, payee: payee.payee, amount, note: maintNote(flat, quarter),
  }));

  const links = {
    generic: `upi://pay?${qs}`,
    qr: `upi://pay?${qs}`,
    intent: intentUri(qs, { fallbackUrl }),
    androidApps: Object.fromEntries(
      Object.entries(ANDROID_PACKAGES).map(([app, pkg]) => [app, intentUri(qs, { pkg, fallbackUrl })])
    ),
  };
  for (const [app, scheme] of Object.entries(IOS_SCHEMES)) {
    links[app] = `${scheme}?${qs}`;
  }
  return { ...links, mode: payee.mode, bankDetails: payee.bankDetails };
}

/** What someone types into their own UPI app when no maintenance link worked. */
export function manualMaintPayment({ env, amount, flat, quarter }) {
  const payee = maintPayee(env);
  if (!payee.ok) return { ok: false, reason: payee.reason };
  return {
    ok: true,
    vpa: payee.vpa,
    payee: payee.payee,
    amount,
    note: maintNote(flat, quarter) ?? null,
    bankDetails: payee.bankDetails,
  };
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
