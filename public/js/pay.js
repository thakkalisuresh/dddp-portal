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
 * How long the bank details stay folded before opening themselves.
 *
 * Longer than the per-tap watcher's 1.6s, which answers "did THAT tap work".
 * This one answers "has anything happened at all", and firing it while someone
 * is still reading the amount would open a drawer they had not asked for.
 */
const AUTO_REVEAL_MS = 6000;

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

  // The quarter and the flat on ONE line. They were a heading and a muted line
  // under it, which read as two facts; they are one fact — which bill this is.
  return el('section', { class: 'stack' },
    el('p', { class: 'label' },
      sheet.kind === 'maintenance' ? 'Maintenance charges' : 'Gas'),
    el('h1', { class: 'h2' }, `${label} · Flat ${sheet.flat}`));
}

/* ── 2. the amount and who it goes to ─────────────────────────────────── */

function amountBlock(sheet) {
  const m = sheet.manual;
  const total = sheet.bill.total;
  // COPYABLE, like everything else on this screen that somebody has to retype.
  // A resident paying from their own bank app types this figure by hand, and a
  // transposed digit is a payment the treasurer cannot match to any bill.
  const figure = el('p', { class: 'amount' }, money(total));
  return el('section', { class: 'stack' },
    el('div', { class: 'manual__row' }, figure, copyButton(String(total), figure)),
    // The payee NAME, not the address. The address is a string of digits and
    // an IFSC in account mode, which tells a resident nothing about whether
    // they are paying the right people.
    m?.payee ? el('p', { class: 'muted' }, `To ${m.payee}`) : null);
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
  // Set the moment anything takes the page over. Shared by the per-tap watcher
  // and by the standing timer below, because both are asking the same question
  // the platform will not answer: did an app actually open?
  let appLaunched = false;
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
    const mark = () => { handedOff = true; appLaunched = true; };
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
      el('p', { class: 'label' }, target === 'android' ? 'Or pay with' : 'Pay with'),
      el('div', { class: 'pay-apps' },
        ...apps.filter((key) => APPS[key] && hrefFor(key)).map((key) =>
          el('a', { class: 'pay-app', href: hrefFor(key), onclick: handoff },
            appMark(key), APPS[key].label))));

    // NO WARNING ABOUT PHONEPE AND PAYTM. There was one, on the published
    // guidance that they refuse a bank-account address; a ₹1 test from an
    // iPhone through all three apps completed against the real account, so the
    // claim is not merely unproven but contradicted. It is not softened either
    // — a hedged version of a sentence we have evidence against is still that
    // sentence. The bank-transfer fold below is now the only thing on this
    // screen making a claim about failure, and it claims only that an app did
    // not open, which is the thing we can actually observe.
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

    // OPENS ITSELF IF NOTHING HAPPENS. A resident with no UPI app installed
    // taps, the page does not move, and there is no event to tell us so — see
    // manualBlock. Left alone if they have already opened or closed it
    // themselves: a fold that reopens after somebody shut it is the page
    // arguing with them.
    let touched = false;
    manual.addEventListener('toggle', () => { touched = true; });

    const reveal = () => {
      if (touched || appLaunched || manual.open) return;
      // FIRED INTO A BACKGROUNDED PAGE: decide when they come back rather than
      // never. If an app took over, `appLaunched` is already true and we never
      // reach here; if the screen simply locked while they read the amount,
      // giving up would leave the fold shut for exactly the resident who walked
      // away confused and then returned to a page that still says nothing.
      if (document.visibilityState === 'hidden') {
        addEventListener('visibilitychange', reveal, { once: true });
        return;
      }
      manual.open = true;
    };
    setTimeout(reveal, AUTO_REVEAL_MS);
  }

  // THE UPLOAD PROMPT, last. A screenshot is what turns a payment into
  // something the treasurer can confirm, and it is asked for after the payment
  // rather than before it.
  block.append(
    el('p', { style: 'text-align:center;margin-top:var(--s-4)' },
      el('a', { class: 'linkish', href: `/proof?bill=${encodeURIComponent(sheet.bill.id)}` },
        'Paid? Upload the payment screenshot so the treasurer can confirm it.')));

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
    el('span', { class: 'label' }, 'Your payment will carry this note'),
    el('div', { class: 'manual__row' }, field, copyButton(note, field)),
    el('p', { class: 'small', style: 'color:var(--awaiting)' },
      'It appears on the bank statement and is how the treasurer matches your '
      + 'payment to your flat.'));
}

/**
 * The way out when no app opens: secondary, but never out of reach.
 *
 * SECONDARY RATHER THAN ALWAYS VISIBLE. Most residents tap an app and are gone,
 * and a screen that shows an account number to all of them buries the one
 * button that works for nine in ten. So it folds — and then opens ITSELF.
 *
 * WHY IT OPENS ITSELF. A page cannot tell whether a UPI app opened; there is no
 * callback either way. A resident with no UPI app installed taps, nothing
 * happens, and behind a closed summary there is nothing to tell them what to do
 * next — they are stranded on a screen that appears broken. So if nothing has
 * taken the page over after a few seconds, this opens without being asked.
 * Opening a fold nobody needed costs a little clutter; leaving it shut costs
 * somebody their payment.
 *
 * THE NOTE IS IN HERE TOO, repeated from above. Somebody paying from their own
 * bank app is typing four fields by hand, and the one that reconciliation
 * depends on must not be the one they have to scroll back up for.
 */
function manualBlock(sheet, record = () => {}) {
  const m = sheet.manual;
  if (!m) return null;

  const bank = m.bankDetails;

  const box = el('details', { class: 'manual' },
    el('summary', {}, "App didn't open? Pay from your bank app instead"),
    // THE BANK DETAILS in account mode; the UPI ID where there is no account
    // to quote. The assembled UPI ID is built from these two halves, and an app
    // that refuses the assembled form still accepts a plain bank transfer — so
    // this is the route that works when every other one here has been refused.
    ...(bank
      ? [copyRow('Account', bank.account),
         copyRow('IFSC', bank.ifsc),
         copyRow('Name', bank.name)]
      // Copying the UPI ID is the same declaration as tapping Pay: this person
      // is about to send money, so it starts the same hold. Otherwise the
      // residents who pay from their own app are precisely the ones who get
      // charged the late fee.
      : [copyRow('UPI ID', m.vpa, record),
         m.payee ? copyRow('Name', m.payee) : null]),
    sheet.note ? copyRow('Note', sheet.note) : null,
    el('p', { class: 'small', style: 'color:var(--awaiting)' },
      'Add the note so the treasurer can match your payment to your flat.'));

  return box;
}

function copyRow(label, value, onCopy = () => {}) {
  const field = el('code', { class: 'vpa' }, value);
  return el('div', {},
    el('span', { class: 'label' }, label),
    el('div', { class: 'manual__row' }, field, copyButton(value, field, onCopy)));
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
