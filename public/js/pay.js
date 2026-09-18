/**
 * The payment sheet — one bill, one payment, its own route.
 *
 * A ROUTE RATHER THAN A SHEET, and that was a decision. A poll whose Pay button
 * links here has to be able to come back afterwards, and a bottom sheet can be
 * neither linked to nor returned from. `from` carries where the resident came
 * from; the server resolves it against an allowlist, so nothing here ever
 * navigates to a value off the query string.
 *
 * MOST OF THIS FILE IS FAILURE HANDLING, and it is not over-built. A UPI handoff
 * has no success callback and no failure callback: when the OS declines the
 * scheme the page simply does not move, and "nothing happened" is the single
 * most reported bug this portal has had. The watcher, the QR, the manual block
 * and the ?upi=blocked flag are four independent routes to the same payment,
 * because each of them is refused by some real phone in this building.
 *
 * Carried over from the old dashboard hero rather than rewritten — every one of
 * these guards was added in response to something that actually happened.
 */

import { api, ApiError } from './api.js';
import { renderNav } from './nav.js';
import { trackPage } from './track.js';
import { $, el, esc, showError } from './ui.js';
import { money, periodLabel } from './i18n.js';
import { drawQr } from './qr.js';

const main = $('#main');

/**
 * `initials` is the fallback mark, NOT an attempt at the brand's logo — the
 * official SVG is used when public/img/upi/ has one, and a lettered tile in
 * the interface's own font when it does not.
 */
const APPS = {
  gpay:    { label: 'Google Pay', colour: '#1A73E8', initials: 'GP' },
  phonepe: { label: 'PhonePe',    colour: '#5F259F', initials: 'Pe' },
  paytm:   { label: 'Paytm',      colour: '#00BAF2', initials: 'Pm' },
  bhim:    { label: 'BHIM',       colour: '#00539F', initials: 'BH' },
};

trackPage('/pay');
init();

async function init() {
  const params = new URLSearchParams(location.search);
  const billId = params.get('bill');
  try {
    const [me, sheet] = await Promise.all([
      api.me(),
      api.paySheet(billId, params.get('from') ?? ''),
    ]);
    if (me.mustChangePassword) { location.href = '/password'; return; }
    render(me, sheet);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login'; return; }
    showError(main, err);
  }
}

function render(me, sheet) {
  $('#who').innerHTML = `Flat ${esc(me.flat)} <span>· ${esc(me.name)}</span>`;
  renderNav(me, '/dashboard');

  // The way back, at the top where a way back belongs. `sheet.back` has already
  // been resolved against the allowlist server-side; it is never the raw value.
  const back = el('p', {},
    el('a', { class: 'linkish', href: sheet.back }, '‹ Back'));

  if (!sheet.payable) {
    // A settled bill has no sheet. Sending someone to a payment screen for a
    // bill they have already paid is how duplicate transfers happen, and a
    // duplicate credit is far more work for the treasurer than a missing one.
    main.replaceChildren(back,
      el('div', { class: 'note' },
        'This bill does not need paying. It may already be settled, or it may be '
        + 'a bill somebody else pays.'));
    return;
  }

  main.replaceChildren(
    back,
    // 1. WHAT THIS IS. The amount alone is a demand; the amount under a label
    //    saying which bill and whose flat is a bill.
    whatThisIs(sheet),
    // 2. The amount, with the payee under it.
    amountBlock(sheet),
    // 3-5. Apps, the note, and — in account mode — the warning and the bank
    //      details. Assembled in payBlock because they share the handoff.
    payBlock(sheet),
  );
}

/* ── 1. what this is ──────────────────────────────────────────────────── */

function whatThisIs(sheet) {
  const label = sheet.kind === 'maintenance'
    // The full form here, where there is room for it: the card said "Q4 2026".
    ? sheet.quarterLabel
    : periodLabel(sheet.bill.period);

  return el('section', { class: 'stack' },
    el('p', { class: 'label' },
      sheet.kind === 'maintenance' ? 'Maintenance' : 'Gas'),
    el('h1', { class: 'h2' }, label),
    el('p', { class: 'muted' }, `Flat ${sheet.flat}`));
}

/* ── 2. the amount and who it goes to ─────────────────────────────────── */

function amountBlock(sheet) {
  const m = sheet.manual;
  return el('section', { class: 'stack' },
    el('p', { class: 'amount' }, money(sheet.bill.total)),
    // The payee NAME, not the address. The address is a string of digits and
    // an IFSC in account mode, which tells a resident nothing about whether
    // they are paying the right people.
    m?.payee ? el('p', { class: 'muted' }, `to ${m.payee}`) : null);
}

/* ── 3-5. the apps, the note, the bank details ────────────────────────── */

function payBlock(sheet) {
  const { target, links, mode, apps } = sheet;
  const total = sheet.bill.total;

  // Named, because the Android intent's browser_fallback_url lands on
  // /pay#pay-help — the anchor has to exist for that to mean anything.
  const block = el('section', { class: 'pay-block', id: 'pay-help' });

  // Record the intent before handing off. Fire-and-forget: a failed log must
  // never stop someone paying their bill.
  const record = () => { api.payIntent(sheet.bill.id, sheet.kind).catch(() => {}); };

  const manual = sheet.manual?.ok === false ? null : manualBlock(sheet, record);
  let qrDetails = null;
  const revealFallbacks = () => {
    if (qrDetails) qrDetails.open = true;
    if (manual) manual.open = true;
  };

  // WORDED FROM WHAT WE LEARNED, not from what it looks like. The phone is not
  // broken and the resident has not done anything wrong: their UPI app declined
  // to accept a payment link from a browser, which is the app's own decision.
  // Saying "no app opened" invites them to hunt for a setting that does not
  // exist, so this names the two routes that cannot be refused instead.
  const stuck = el('div', { class: 'note note--warn', hidden: true },
    'Your UPI app did not accept the payment link — some apps refuse links from a browser. ',
    el('strong', {}, 'Scan the QR'),
    ' or ',
    el('strong', {}, 'copy the details'),
    ' below. Both always work.');

  const blocked = new URLSearchParams(location.search).get('upi') === 'blocked';

  /**
   * Wrap a pay link so a tap that goes nowhere says so.
   *
   * There is no callback either way, so we watch for the page LOSING focus —
   * the one observable signal that an app took over — and if it never comes we
   * surface the manual route rather than leaving a resident tapping a button
   * that appears dead.
   */
  const handoff = () => {
    record();
    let handedOff = false;
    const mark = () => { handedOff = true; };
    const events = [[document, 'visibilitychange'], [window, 'pagehide'], [window, 'blur']];
    for (const [t, e] of events) t.addEventListener(e, mark);

    setTimeout(() => {
      for (const [t, e] of events) t.removeEventListener(e, mark);
      if (handedOff || document.visibilityState === 'hidden') return;
      stuck.hidden = false;
      revealFallbacks();
      stuck.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 1600);
  };

  if (target === 'ios' || target === 'android') {
    // ANDROID LEADS WITH THE PLAIN `upi://` LINK. The implicit link is the
    // mechanism NPCI defines and the one that invokes every PSP app on the
    // device; making it the fallback rather than the first attempt once left
    // Android with a single route, and when that route was refused every button
    // on the page failed at once. iOS keeps per-app schemes because it has no
    // chooser to fall back on.
    if (target === 'android') {
      block.append(
        el('a', { class: 'btn btn--block btn--lg', href: links.generic, onclick: handoff },
          `Pay ${money(total)}`),
        el('p', { class: 'helper' }, 'Opens your UPI app'));
    }

    const hrefFor = (key) => (target === 'ios' ? links[key] : links.androidApps?.[key]);
    block.append(
      el('p', { class: 'label' },
        target === 'android' ? 'Or choose your app' : 'Choose your UPI app'),
      el('div', { class: 'pay-apps' },
        ...apps.filter((key) => APPS[key] && hrefFor(key)).map((key) =>
          el('a', { class: 'pay-app', href: hrefFor(key), onclick: handoff },
            appMark(key), APPS[key].label))));

    // WHY TWO APPS ARE MISSING. In account mode the address is
    // <account>@<IFSC>.ifsc.npci, which PhonePe and Paytm refuse outright.
    // Offering them would be two dead buttons, and a resident whose payment app
    // "does not work" blames the portal — so they are absent and this says why.
    if (mode === 'account') {
      block.append(
        el('p', { class: 'small muted' },
          'PhonePe and Paytm do not accept payments made to a bank account. '
          + 'Use one of the apps above, or the bank details below.'));
    }
  } else {
    block.append(
      el('a', { class: 'btn btn--block btn--lg', href: links.generic, onclick: handoff },
        `Pay ${money(total)}`),
      el('p', { class: 'helper' }, 'Scan with any UPI app'));
  }

  block.append(stuck);

  // THE NOTE. Load-bearing on this screen in a way it is not for gas:
  // maintenance amounts are identical across flats of the same kind, so the
  // unique-paise fingerprint gas relies on does not exist here and this string
  // is one of only two things reconciliation has.
  if (sheet.note) block.append(noteBlock(sheet.note));

  const canvas = el('canvas', {
    id: 'qr', role: 'img',
    'aria-label': `UPI payment QR code for ${money(total)}`,
  });
  const qrBox = el('div', { style: 'margin-top:var(--s-4);text-align:center' }, canvas);

  if (target === 'desktop') {
    block.append(qrBox);
  } else {
    // ON A PHONE TOO, folded away. The QR is the one route no scheme handler
    // can refuse: every UPI app has a scanner, and a resident whose taps go
    // nowhere can screenshot this and scan it from their gallery. It is behind
    // a summary because it is the third thing to try, and `qrDetails` exists so
    // a failed handoff can open it — the warning tells them to scan it, and
    // pointing at something folded shut would be its own small betrayal.
    qrDetails = el('details', { class: 'manual' },
      el('summary', {}, 'Show QR code'),
      el('p', { class: 'small muted' },
        'Scan with any UPI app — or screenshot it and scan from your gallery.'),
      qrBox);
    block.append(qrDetails);
  }
  drawQr(canvas, links.qr, { target: 240 });

  if (manual) {
    block.append(manual);
    if (location.hash === '#pay-help') manual.open = true;
  }

  block.append(
    el('p', { class: 'helper' },
      el('span', {}, 'Pay exactly '),
      el('strong', {}, money(total)),
      el('span', {}, ` and leave the note as it is. That is how flat ${sheet.flat}'s payment is matched.`)),
    // THE UPLOAD PROMPT, last. A screenshot is what turns a payment into
    // something the treasurer can confirm, and it is asked for after the
    // payment rather than before it.
    el('p', { style: 'text-align:center;margin-top:var(--s-3)' },
      el('a', { class: 'linkish', href: `/proof?bill=${encodeURIComponent(sheet.bill.id)}` },
        'Already paid? Upload screenshot')));

  // Arrived here from a dead intent: open the way out without being asked. The
  // resident has just watched the page appear to reload for no reason, and this
  // is the only explanation they will get.
  if (blocked) {
    stuck.hidden = false;
    revealFallbacks();
    // The flag has done its job. Left in the URL, a later refresh would accuse
    // the app of a failure that already happened.
    history.replaceState(null, '', `${location.pathname}${location.search.replace(/[?&]upi=blocked/, '')}#pay-help`);
  }

  return block;
}

/**
 * The reference that lands on the bank statement, with one line saying why.
 *
 * EXPLAINED, NOT JUST DISPLAYED. A bare `(2B_MAINT_Q4_26)` reads as noise and
 * gets deleted by people tidying up the note field in their payment app —
 * which is precisely the field the treasurer reconciles against.
 */
function noteBlock(note) {
  const field = el('code', { class: 'ref' }, note);
  return el('div', { class: 'stack', style: 'margin-top:var(--s-4)' },
    el('span', { class: 'label' }, 'Add this note to the payment'),
    el('div', { class: 'manual__row' }, field, copyButton(note, field)),
    el('p', { class: 'small', style: 'color:var(--awaiting)' },
      'This note lands on the bank statement and is how the treasurer matches '
      + 'your payment to your flat. Please do not change it.'));
}

/**
 * The way out when no app opens.
 *
 * Always visible, never behind a "did it fail?" question. Someone whose app did
 * not open is already unsure what happened, and someone who simply prefers
 * their own app should not have to admit to a failure to find this.
 */
function manualBlock(sheet, record = () => {}) {
  const m = sheet.manual;
  if (!m) return null;

  const idField = el('code', { class: 'vpa' }, m.vpa);
  // Copying the UPI ID is the same declaration as tapping Pay: this person is
  // about to send money. It starts the same hold — otherwise the residents who
  // pay from their own app are precisely the ones who get charged the late fee.
  const copy = copyButton(m.vpa, idField, record);

  const bank = m.bankDetails;

  return el('details', { class: 'manual' },
    el('summary', {}, 'Pay another way'),
    el('p', { class: 'small muted' }, 'Open any UPI app and send to this ID.'),
    el('div', { class: 'manual__row' }, idField, copy),
    el('div', { class: 'manual__grid' },
      el('div', {},
        el('span', { class: 'label' }, 'Amount'),
        el('strong', { class: 'num' }, money(m.amount)))),

    // THE BANK DETAILS, in account mode only. The UPI ID above is assembled
    // from these two halves, and an app that refuses the assembled form will
    // still accept a plain bank transfer — so this is the route that works when
    // every other one on this page has been refused.
    bank
      ? el('div', { class: 'stack', style: 'margin-top:var(--s-4)' },
          el('span', { class: 'label' }, 'Or transfer to the account'),
          copyRow('Account number', bank.account),
          copyRow('IFSC', bank.ifsc),
          copyRow('Name', bank.name))
      : null);
}

function copyRow(label, value) {
  const field = el('code', { class: 'vpa' }, value);
  return el('div', {},
    el('span', { class: 'label' }, label),
    el('div', { class: 'manual__row' }, field, copyButton(value, field)));
}

function copyButton(text, field, onCopy = () => {}) {
  const btn = el('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Copy');
  btn.addEventListener('click', async () => {
    onCopy();
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    } catch {
      // Clipboard is blocked in some in-app browsers. Selecting the text is
      // then the fallback to the fallback, so make that possible.
      const r = document.createRange();
      r.selectNodeContents(field);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      btn.textContent = 'Select and copy';
    }
  });
  return btn;
}

function appMark(key) {
  const app = APPS[key];
  // aria-hidden, exactly as the img is: the row already says "Google Pay", and
  // without this a screen reader announces the link as "GP Google Pay".
  const tile = el('span', {
    class: 'pay-app__mark', style: `background:${app.colour}`, 'aria-hidden': 'true',
  }, app.initials ?? '');
  const img = el('img', {
    class: 'pay-app__logo', src: `/img/upi/${key}.svg`, alt: '', 'aria-hidden': 'true',
    width: '30', height: '30', loading: 'lazy',
  });
  img.addEventListener('error', () => img.replaceWith(tile));
  return img;
}
