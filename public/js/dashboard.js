/**
 * Resident dashboard — screens 03/04/05 of the design set.
 *
 * The shape of this file follows the design decision, not the data: the bill
 * is one dominant element, and when it is settled the pay CTA is REMOVED
 * rather than disabled. A dead button is worse than no button.
 */

import { api, ApiError } from './api.js';
import { renderNav } from './nav.js';
import { trackPage } from './track.js';
import { $, el, esc, statusChip, billBreakdown, renderViewBanner, showError } from './ui.js';
import { money, kg, periodLabel, dayLabel } from './i18n.js';
import { drawQr } from './qr.js';

const main = $('#main');

// `initials` is the fallback mark, NOT an attempt at the brand's logo. See
// appMark() for why there is no logo here and what to do about it.
const UPI_APPS = [
  { key: 'gpay',    label: 'Google Pay', colour: '#1A73E8', initials: 'GP' },
  { key: 'phonepe', label: 'PhonePe',    colour: '#5F259F', initials: 'Pe' },
  { key: 'paytm',   label: 'Paytm',      colour: '#00BAF2', initials: 'Pm' },
];

trackPage('/dashboard');
init();

async function init() {
  try {
    const me = await api.me();
    if (me.mustChangePassword) { location.href = '/password'; return; }
    render(me);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login'; return; }
    showError(main, err);
  }
}

function render(me) {
  // A landlord is reading their TENANT's bill. Saying so is not decoration:
  // an amount with no name against it looks like a demand for money you owe.
  const t = me.tenancy;
  const landlordBanner = t?.viewing === 'landlord'
    ? el('div', { class: 'note' },
        `You are the owner of ${me.flat}. This is ${t.occupantName ?? 'your tenant'}'s bill. `
        + 'They pay it. You are liable only if it goes unpaid. '
        + 'Payment screenshots are not shown to owners.')
    : null;

  $('#who').innerHTML = `Flat ${esc(me.flat)} <span>· ${esc(me.name)}</span>`;
  $('#logout').addEventListener('click', async () => {
    await api.logout().catch(() => {});
    location.href = '/login';
  });

  renderViewBanner(me, {
    onExit: async () => { await api.god.exit(); location.reload(); },
    onAllowWrites: async () => { /* phase 7b: re-issue the session with writes */ },
  });
  renderNav(me, '/dashboard');

  main.replaceChildren(
    ...(landlordBanner ? [landlordBanner] : []),
    ...(me.bill
      ? [billSection(me), paySection(me), breakdownSection(me.bill), downloadSection()]
      : [noBill()]),
    ...(me.readings.length ? [consumptionSection(me.readings, me.bills)] : []),
    ...(me.bills.length ? [billHistorySection(me.bills)] : []),
    helpSection()
  );
}

/* ── the hero ─────────────────────────────────────────────────────────── */

function billSection(me) {
  const b = me.bill;
  const settled = b.settled;

  return el('section', { class: 'bill-hero' },
    el('div', { class: 'bill-hero__top' },
      el('p', { class: 'label' }, periodLabel(b.period)),
      statusChip(b.displayStatus)),

    el('p', { class: 'amount', style: settled ? 'color:var(--ink-muted)' : '' }, money(b.total)),

    el('p', { class: 'muted' },
      settled
        ? (b.paidAt ? `Paid ${dayLabel(b.paidAt)}` : 'Settled')
        // "Due 20 Aug" read as "the 20th is fine", and it is not: the fee lands
        // at 00:00 that morning, so the 20th is already late. The deadline is
        // stated as the instant it expires rather than the day it falls on.
        : `Pay before ${dayLabel(b.dueDate)}`),

    // Warn about the fee before it lands — nobody should be surprised by it.
    b.lateFeeWarning
      ? el('p', { class: 'small', style: 'color:var(--awaiting);font-family:var(--font-ui)' },
          `${money(b.lateFeeWarning.amount)} late fee from ${dayLabel(b.lateFeeWarning.after)}, 00:00`)
      : null,

    b.displayStatus === 'overdue' && b.lateFee
      ? el('p', { class: 'small', style: 'color:var(--overdue);font-family:var(--font-ui)' },
          `Late fee of ${money(b.lateFee)} applied ${dayLabel(b.lateFeeAt)}`)
      : null,

    settled
      ? el('div', { class: 'note note--good' }, 'Nothing due. Your next bill arrives early next month.')
      : null,

    b.status === 'awaiting'
      ? el('div', { class: 'note note--warn' },
          "The treasurer is verifying your payment. You don't need to do anything.")
      : null
  );
}

/* ── pay ──────────────────────────────────────────────────────────────── */

function paySection(me) {
  const b = me.bill;
  if (!b.showPayButton || !me.pay) return el('div');

  const { target, links } = me.pay;
  // Named, because the Android intent's browser_fallback_url lands on
  // /dashboard#pay-help — the anchor has to exist for that to mean anything.
  const block = el('section', { class: 'pay-block', id: 'pay-help' });

  // Record the intent before handing off to the UPI app. Fire-and-forget: a
  // failed log must never stop someone paying their bill.
  const record = () => { api.payIntent(b.id).catch(() => {}); };

  const manual = me.pay.manual ? manualBlock(me.pay.manual, record) : null;
  // Assigned further down, once the platform decides whether the QR is folded
  // away or shown outright. Declared here so the failure handling can reach it.
  let qrDetails = null;
  const revealFallbacks = () => {
    if (qrDetails) qrDetails.open = true;
    if (manual) manual.open = true;
  };

  // Shown when a tap demonstrably did nothing — either watched live by
  // handoff(), or reported by the intent's own fallback landing back here with
  // ?upi=blocked, which is the only signal that survives the navigation.
  // WORDED FROM WHAT WE LEARNED, not from what it looks like. The phone is not
  // broken and the resident has not done anything wrong: their UPI app declined
  // to accept a payment link from a browser, which is the app's own decision and
  // outside anybody's control here. Saying "no app opened" invites them to hunt
  // for a setting that does not exist, so it names the two routes that cannot be
  // refused instead.
  const stuck = el('div', { class: 'note note--warn', hidden: true },
    'Your UPI app did not accept the payment link — some apps refuse links from a browser. ',
    el('strong', {}, 'Scan the QR'),
    ' or ',
    el('strong', {}, 'copy the UPI ID'),
    ' below. Both always work.');

  // Chrome came back here instead of opening an app. Read now, ACTED ON at the
  // end of this function: the fallbacks it opens do not exist yet.
  const blocked = new URLSearchParams(location.search).get('upi') === 'blocked';

  /**
   * Wrap a pay link so a tap that goes nowhere says so.
   *
   * A UPI handoff has no success callback and no failure callback; when the OS
   * declines the scheme — no handler, or an in-app WebView that blocks
   * non-http URLs — the page simply does not move. That is the whole of the
   * reported bug: not an error, an absence. So we watch for the page LOSING
   * focus, which is the one observable signal that an app took over, and if it
   * never comes we surface the manual route instead of leaving a resident
   * tapping a button that appears dead.
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
    // ANDROID LEADS WITH THE PLAIN `upi://` LINK, and that is a reversal.
    //
    // This screen used to offer package-addressed intents ONLY, on the theory
    // that the OS chooser for an unaddressed `upi://` does not reliably appear.
    // But the implicit link is the mechanism NPCI defines and the one Paytm's
    // own m-web guide describes — "invokes all the UPI PSP Apps on the device"
    // — and making it the fallback rather than the first attempt left Android
    // with a single route. When that route was refused, every button on the
    // page failed at once, which is the bug that was reported.
    //
    // So: the chooser first, the named apps underneath for anyone whose device
    // does not offer one. iOS keeps per-app schemes because it genuinely has no
    // chooser to fall back on.
    if (target === 'android') {
      block.append(
        el('a', { class: 'btn btn--block btn--lg', href: links.generic, onclick: handoff },
          `Pay ${money(b.total)}`),
        el('p', { class: 'helper' }, 'Opens your UPI app'));
    }

    const hrefFor = (key) => (target === 'ios' ? links[key] : links.androidApps?.[key]);
    block.append(
      el('p', { class: 'label' },
        target === 'android' ? 'Or choose your app' : 'Choose your UPI app'),
      el('div', { class: 'pay-apps' },
        ...UPI_APPS.filter((app) => hrefFor(app.key)).map((app) =>
          el('a', { class: 'pay-app', href: hrefFor(app.key), onclick: handoff },
            // The official mark when it is present, the coloured dot when it
            // is not. onerror rather than a build-time check, so dropping an
            // SVG into public/img/upi/ is the whole installation step and a
            // missing file never leaves a broken image on a resident's phone.
            appMark(app),
            app.label)))
    );
  } else {
    block.append(
      el('a', { class: 'btn btn--block btn--lg', href: links.generic, onclick: handoff },
        `Pay ${money(b.total)}`),
      el('p', { class: 'helper' }, 'Scan with any UPI app')
    );
  }

  block.append(stuck);

  const canvas = el('canvas', {
    id: 'qr', role: 'img',
    'aria-label': `UPI payment QR code for ${money(b.total)} to DD Diamond Park RWA`,
  });
  const qrBox = el('div', { style: 'margin-top:var(--s-4);text-align:center' }, canvas);

  if (target === 'desktop') {
    block.append(qrBox);
  } else {
    // ON A PHONE TOO, folded away. The QR is the one route that cannot be
    // refused by a scheme handler: every UPI app has a scanner, and a resident
    // whose taps go nowhere can screenshot this and scan it from their gallery,
    // or have someone else scan it. It is behind a summary because it is the
    // third thing to try, not the first — and `qrDetails` exists so that a
    // failed handoff can open it, since the warning tells them to scan it and
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
    // Arrived here from a dead intent: open the way out without being asked.
    if (location.hash === '#pay-help') manual.open = true;
  }

  block.append(
    el('p', { class: 'helper' },
      el('span', {}, 'Pay exactly '),
      el('strong', {}, money(b.total)),
      el('span', {}, ` and leave the reference as it is. That is how flat ${me.flat}'s payment is matched.`)),
    el('p', { style: 'text-align:center;margin-top:var(--s-3)' },
      el('a', { class: 'linkish', href: '/proof' }, 'Already paid? Upload screenshot'))
  );

  // Now that the QR and the manual details exist, a handoff that bounced back
  // here can open them. The resident has just watched the page appear to reload
  // for no reason; this is the only explanation they will get.
  if (blocked) {
    stuck.hidden = false;
    revealFallbacks();
    // The flag has done its job. Left in the URL, a later refresh would accuse
    // the app of a failure that already happened.
    history.replaceState(null, '', `${location.pathname}#pay-help`);
  }

  return block;
}


/* ── breakdown, history ───────────────────────────────────────────────── */

/**
 * "Download bill" — a link to a real PDF, not a print dialog.
 *
 * A LINK, DELIBERATELY, not a button running script. The browser's own
 * handling of a PDF response is the thing a resident wants: Android Chrome
 * offers the app chooser, iOS Safari opens its viewer with a share sheet, and
 * a desktop opens a tab. Every one of those is better than what a page can
 * build, and all of them come free from an anchor pointing at bytes.
 *
 * `target="_blank"` so the dashboard survives the trip. Without it, a phone
 * that hands the PDF to another app leaves the resident's portal tab sitting
 * on a document they have navigated away from, and Back does not always
 * return them.
 *
 * The file is drawn by the Worker (functions/lib/bill-pdf.js), which is also
 * what the announcement email attaches — one document, one implementation,
 * whichever way a resident comes to it.
 */
function downloadSection() {
  return el('section', { class: 'stack' },
    el('a', {
      class: 'btn btn--ghost btn--block',
      href: '/api/me/bill.pdf',
      target: '_blank',
      rel: 'noopener',
      // Click capture records id and classes, never text, so an id is what
      // makes this identifiable in the log when it is on (js/track.js).
      id: 'download-bill',
    }, 'Download bill'));
}




function breakdownSection(bill) {
  return el('section', { class: 'stack' },
    el('hr', { class: 'rule' }),
    billBreakdown({
      consumption: bill.consumption,
      rate_per_kg: bill.ratePerKg,
      gas_amount: bill.gasAmount,
      other_charges: bill.otherCharges,
      additional_charges: bill.additionalCharges,
      late_fee: bill.lateFee,
      total: bill.total,
    })
  );
}

/**
 * The brand mark, with the lettered tile still behind it as a fallback.
 *
 * THE LOGOS ARE NOW IN THE REPOSITORY, added 2026-08-13 on Sabarish's explicit
 * instruction that trademark use is not a concern for this association's own
 * portal. `public/img/upi/README.md` records where each file came from — worth
 * reading before replacing one, because provenance is the part that is hard to
 * reconstruct later.
 *
 * They are NOT drawn here, and that part has not changed: a mark everybody
 * recognises is a mark everybody can see is slightly wrong, so an approximation
 * would look worse than no logo at all. These are the real vectors.
 *
 * THE FALLBACK STAYS, and is not dead code. It is what renders if a file is
 * ever removed, renamed, or fails to load, and it is per-app — the `error`
 * handler swaps that one row without touching the others. It also still covers
 * a brand added to UPI_APPS before its file arrives.
 *
 * `loading="lazy"` is deliberate and was CHECKED rather than assumed, because
 * this project has been bitten by it before: the embedded map in B15 stayed
 * permanently blank behind it. Here all three decode with it on, verified by
 * awaiting img.decode() on the live page. It is left alone.
 */
function appMark(app) {
  // aria-hidden, exactly as the img is: the row already says "Google Pay", and
  // without this a screen reader announces the link as "GP Google Pay".
  const tile = el('span', {
    class: 'pay-app__mark', style: `background:${app.colour}`, 'aria-hidden': 'true',
  }, app.initials ?? '');
  const img = el('img', {
    class: 'pay-app__logo', src: `/img/upi/${app.key}.svg`, alt: '', 'aria-hidden': 'true',
    width: '30', height: '30', loading: 'lazy',
  });
  img.addEventListener('error', () => img.replaceWith(tile));
  return img;
}

/**
 * A single line under the chart that says what the bar you are touching cost.
 *
 * One shared readout rather than a floating tooltip per bar: a tooltip near
 * the top of a phone screen ends up under the thumb that summoned it, and
 * hover does not exist on touch at all. Pointer and keyboard both drive it,
 * so it is reachable by tabbing as well.
 */
function chartReadout() {
  const out = el('p', { class: 'chart-readout', 'aria-live': 'polite' },
    'Touch a bar to see that month.');

  const show = (bar) => {
    if (!bar) return;
    const amount = bar.dataset.amount;
    out.textContent = `${periodLabel(bar.dataset.period)} · ${bar.dataset.kg}`
                    + (amount ? ` · ${amount}` : '');
  };

  // Delegated, so it survives the chart being re-rendered.
  setTimeout(() => {
    const chart = document.querySelector('.chart');
    if (!chart) return;
    const pick = (e) => show(e.target.closest('.chart__bar'));
    chart.addEventListener('pointerenter', pick, true);
    chart.addEventListener('pointerdown', pick);
    chart.addEventListener('focusin', pick);
  }, 0);

  return out;
}

/**
 * The way out when no app opens.
 *
 * Always visible, never behind a "did it fail?" question. Someone whose app
 * did not open is already unsure what happened, and someone who simply prefers
 * their own app should not have to admit to a failure to find this.
 */
function manualBlock(m, record = () => {}) {
  const idField = el('code', { class: 'vpa' }, m.vpa);
  const copy = el('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Copy');
  copy.addEventListener('click', async () => {
    // Copying the UPI ID is the same declaration as tapping Pay: this person is
    // about to send money. It reaches the treasurer's shortlist by the same
    // route, and it starts the same late-fee hold — otherwise the residents who
    // pay from their own app are precisely the ones who get charged the fee.
    record();
    try {
      await navigator.clipboard.writeText(m.vpa);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
    } catch {
      // Clipboard is blocked in some in-app browsers. Selecting the text is
      // then the fallback to the fallback, so make that possible.
      const r = document.createRange();
      r.selectNodeContents(idField);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      copy.textContent = 'Select and copy';
    }
  });

  return el('details', { class: 'manual' },
    el('summary', {}, 'Pay another way'),
    el('p', { class: 'small muted' }, 'Open any UPI app and send to this ID.'),
    el('div', { class: 'manual__row' }, idField, copy),
    el('div', { class: 'manual__grid' },
      el('div', {},
        el('span', { class: 'label' }, 'Amount'),
        el('strong', { class: 'num' }, money(m.amount))),
      m.note
        ? el('div', {},
            el('span', { class: 'label' }, 'Add this note'),
            el('code', {}, m.note))
        : null),
    m.note
      ? el('p', { class: 'small', style: 'color:var(--awaiting)' },
          'The note is how the treasurer matches your payment.')
      : null);
}

function consumptionSection(readings, bills = []) {
  const withUse = readings.filter((r) => r.consumption != null).reverse();
  const peak = Math.max(...withUse.map((r) => r.consumption), 0.01);
  // What each month cost, so the bar can say it. The chart plots kilograms,
  // but the question people actually have is what they paid.
  const paidFor = new Map(bills.map((b) => [b.period, b.total]));

  return el('section', { class: 'stack' },
    el('hr', { class: 'rule' }),
    el('p', { class: 'label' }, 'Consumption'),
    el('div', { class: 'chart-wrap' },
      el('div', { class: 'chart' },
        ...withUse.map((r, i) =>
          el('div', {
            class: `chart__bar ${i === withUse.length - 1 ? 'chart__bar--now' : ''}`,
            style: `height:${Math.max(4, (r.consumption / peak) * 100)}%`,
            // Native title is desktop-only and slow. The readout below works
            // on touch too, where there is no hover at all.
            title: `${periodLabel(r.period)}: ${kg(r.consumption)}`
                 + (paidFor.has(r.period) ? ` · ${money(paidFor.get(r.period))}` : ''),
            tabindex: '0',
            'data-period': r.period,
            'data-kg': kg(r.consumption),
            'data-amount': paidFor.has(r.period) ? money(paidFor.get(r.period)) : '',
          }, el('span', {}, periodLabel(r.period).slice(0, 3).toUpperCase()))))),
    chartReadout(),
    el('div', { class: 'scroll-x' },
      el('table', { class: 'table' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Month'),
          el('th', {}, 'Meter read'),
          el('th', { class: 'r' }, 'Reading'),
          el('th', { class: 'r' }, 'Used'))),
        el('tbody', {}, ...readings.map((r) =>
          el('tr', {},
            el('td', {}, periodLabel(r.period)),
            // The meter closing June's usage is read in early July. Showing both
            // stops "why is my June bill from a July reading?"
            el('td', { class: 'muted small' }, r.readOn ? dayLabel(r.readOn) : '—'),
            el('td', { class: 'r' },
              r.reading.toFixed(3),
              // A new meter starts near zero, so this column drops by twenty
              // without explanation and reads as a fault in the portal. Said on
              // the row itself, where the surprising number is.
              r.meterChangedOn
                ? el('div', { class: 'small muted' }, `new meter ${dayLabel(r.meterChangedOn)}`)
                : null),
            el('td', { class: 'r' }, r.consumption == null ? '—' : kg(r.consumption)))))))
  );
}

function billHistorySection(bills) {
  return el('section', { class: 'stack' },
    el('hr', { class: 'rule' }),
    el('p', { class: 'label' }, 'Bill history'),
    el('div', { class: 'scroll-x' },
      el('table', { class: 'table' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Month'),
          el('th', { class: 'r' }, 'Used'),
          el('th', { class: 'r' }, 'Rate'),
          el('th', { class: 'r' }, 'Amount'),
          el('th', { class: 'r' }, 'Status'))),
        el('tbody', {}, ...bills.map((b) =>
          el('tr', {},
            el('td', {}, periodLabel(b.period)),
            el('td', { class: 'r' }, kg(b.consumption)),
            el('td', { class: 'r muted' }, `₹${b.rate_per_kg}`),
            el('td', { class: 'r' }, money(b.total)),
            el('td', { class: 'r' }, statusChip(b.status))))))),
    // The rate is snapshotted per bill, so a historic rate change is visible.
    new Set(bills.map((b) => b.rate_per_kg)).size > 1
      ? el('p', { class: 'small muted' },
          'Each bill keeps the rate it was issued at, so a rate change does not alter past months.')
      : null
  );
}

function noBill() {
  return el('div', { class: 'note note--good' },
    'No bill yet. The treasurer generates bills once the month\'s meter readings are in.');
}

function helpSection() {
  return el('section', { class: 'stack' },
    el('hr', { class: 'rule' }),
    el('p', { class: 'small muted' },
      'Questions about your bill? Reach out to the committee.')
  );
}
