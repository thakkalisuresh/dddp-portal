/**
 * UPI handoff diagnostic — one tap per mechanism, so a real phone can tell us
 * which one Android actually honours.
 *
 * WHY THIS EXISTS. The pay screen was rebuilt twice on reasoning alone: the URI
 * matches NPCI's spec and the standard libraries, the intent syntax matches
 * Chrome's documentation, and a QR carrying the IDENTICAL string is read
 * correctly by Google Pay on the same handset. So the payload is not in doubt
 * and the app is not in doubt — only the browser-to-app handoff is, and that is
 * a property of the device, not of anything visible from here.
 *
 * Eight variants, differing in ONE thing each, so whichever opens an app names
 * the cause rather than merely fixing it. Delete this page once we know.
 */

const params = new URLSearchParams(location.search);
const VPA = params.get('vpa') || 'qr.ddwelfare@sib';
const PAYEE = params.get('pn') || 'DD Diamond Park RWA';
const AM = params.get('am') || '1.00';

/** %20 for spaces: '+' means space only in form encoding, and UPI apps decode strictly. */
const qs = (extra = {}) => {
  const p = new URLSearchParams({ pa: VPA, pn: PAYEE, am: AM, cu: 'INR', ...extra });
  return p.toString().replace(/\+/g, '%20');
};

const GPAY_PKG = 'com.google.android.apps.nbu.paisa.user';
const PHONEPE_PKG = 'com.phonepe.app';
const back = `${location.origin}/pay-test.html?returned=1`;

const VARIANTS = [
  {
    n: 1,
    title: 'Plain upi:// link',
    why: 'The mechanism NPCI defines. If this works, nothing else is needed.',
    href: `upi://pay?${qs()}`,
  },
  {
    n: 2,
    title: 'Plain upi:// — bare minimum payload',
    why: 'Same as 1 with no transaction note, in case a character in the note is rejected.',
    href: `upi://pay?${new URLSearchParams({ pa: VPA, pn: 'DDP', am: AM, cu: 'INR' }).toString().replace(/\+/g, '%20')}`,
  },
  {
    n: 3,
    title: 'Intent, no package, no fallback',
    why: 'Asks Android for ANY app that handles upi://. With no fallback it cannot silently return here, so a reload would mean something else is wrong.',
    href: `intent://pay?${qs()}#Intent;scheme=upi;action=android.intent.action.VIEW;end`,
  },
  {
    n: 4,
    title: 'Intent addressed to Google Pay, no fallback',
    why: 'If Google Pay is installed but not registered for browser links, Chrome should offer its Play Store page instead of coming back here.',
    href: `intent://pay?${qs()}#Intent;scheme=upi;action=android.intent.action.VIEW;package=${GPAY_PKG};end`,
  },
  {
    n: 5,
    title: 'Intent addressed to PhonePe, no fallback',
    why: 'Same test against a different app. If 4 fails and this works, the problem is specific to Google Pay.',
    href: `intent://pay?${qs()}#Intent;scheme=upi;action=android.intent.action.VIEW;package=${PHONEPE_PKG};end`,
  },
  {
    n: 6,
    title: "Google Pay's own scheme (gpay://)",
    why: 'Bypasses the shared upi:// scheme entirely and speaks to Google Pay directly.',
    href: `gpay://upi/pay?${qs()}`,
  },
  {
    n: 7,
    title: 'The old Tez scheme (tez://)',
    why: 'What Google Pay was called before the rename. Some installs still answer to it.',
    href: `tez://upi/pay?${qs()}`,
  },
  {
    n: 8,
    title: 'Intent with fallback — what the app ships today',
    why: 'The current behaviour, for comparison. This is the one expected to bounce back here.',
    href: `intent://pay?${qs()}#Intent;scheme=upi;action=android.intent.action.VIEW;package=${GPAY_PKG};S.browser_fallback_url=${encodeURIComponent(back)};end`,
  },
];

const list = document.getElementById('list');
for (const v of VARIANTS) {
  const a = document.createElement('a');
  a.className = 't';
  a.href = v.href;

  const title = document.createElement('b');
  const num = document.createElement('span');
  num.className = 'n';
  num.textContent = `${v.n}. `;
  title.append(num, document.createTextNode(v.title));

  const why = document.createElement('div');
  why.className = 'small muted';
  why.textContent = v.why;

  const code = document.createElement('code');
  // Truncated: the full URI is long and the point here is which shape it is.
  code.textContent = v.href.length > 110 ? `${v.href.slice(0, 110)}…` : v.href;

  a.append(title, why, code);
  list.append(a);
}

// Variant 8 sends the browser back here on failure; say so plainly rather than
// leaving a silent return looking like a page that did nothing.
if (params.get('returned')) {
  const note = document.createElement('p');
  note.className = 'note note--warn';
  note.textContent = 'You came back here from a fallback — that tap did not reach an app.';
  list.before(note);
}

document.getElementById('ua').textContent = navigator.userAgent;
