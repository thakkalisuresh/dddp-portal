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
import { $, el, esc, statusChip, billBreakdown, renderGodBanner, showError } from './ui.js';
import { money, kg, periodLabel, dayLabel, bilingual } from './i18n.js';
import { drawQr } from './qr.js';
import { treasurerLine } from './contact.js';

const main = $('#main');

const UPI_APPS = [
  { key: 'gpay',    label: 'Google Pay', colour: '#1A73E8' },
  { key: 'phonepe', label: 'PhonePe',    colour: '#5F259F' },
  { key: 'paytm',   label: 'Paytm',      colour: '#00BAF2' },
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
        `You are the owner of ${me.flat}. This is ${t.occupantName ?? 'your tenant'}'s bill — `
        + 'they pay it, and you are liable only if it goes unpaid. '
        + 'Payment screenshots are not shown to owners.')
    : null;

  $('#who').innerHTML = `Flat ${esc(me.flat)} <span>· ${esc(me.name)}</span>`;
  $('#logout').addEventListener('click', async () => {
    await api.logout().catch(() => {});
    location.href = '/login';
  });

  renderGodBanner(me, {
    onExit: async () => { await api.god.exit(); location.reload(); },
    onAllowWrites: async () => { /* phase 7b: re-issue the session with writes */ },
  });
  renderNav(me, '/dashboard');

  main.replaceChildren(
    ...(landlordBanner ? [landlordBanner] : []),
    ...(me.bill ? [billSection(me), paySection(me), breakdownSection(me.bill)] : [noBill()]),
    ...(me.readings.length ? [consumptionSection(me.readings)] : []),
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
        : el('span', { html: `Due ${esc(dayLabel(b.dueDate))} <span class="ml" aria-hidden="true">അവസാന തീയതി</span>` })),

    // Warn about the fee before it lands — nobody should be surprised by it.
    b.lateFeeWarning
      ? el('p', { class: 'small', style: 'color:var(--awaiting);font-family:var(--font-ui)' },
          `${money(b.lateFeeWarning.amount)} late fee applies after ${dayLabel(b.lateFeeWarning.after)}`)
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
  const block = el('section', { class: 'pay-block' });

  // Record the intent before handing off to the UPI app. Fire-and-forget: a
  // failed log must never stop someone paying their bill.
  const record = () => { api.payIntent(b.id).catch(() => {}); };

  if (target === 'ios') {
    // iOS has no UPI app chooser, so the apps must be listed explicitly.
    block.append(
      el('p', { class: 'label' }, 'Choose your UPI app'),
      el('div', { class: 'pay-apps' },
        ...UPI_APPS.map((app) =>
          el('a', { class: 'pay-app', href: links[app.key], onclick: record },
            el('span', { class: 'pay-app__mark', style: `background:${app.colour}` }),
            app.label)))
    );
  } else {
    block.append(
      el('a', { class: 'btn btn--block btn--lg', href: links.generic, onclick: record },
        `Pay ${money(b.total)}`),
      el('p', { class: 'helper' },
        target === 'android' ? 'Your phone will ask which UPI app to use' : 'Scan with any UPI app')
    );
  }

  if (target === 'desktop') {
    const canvas = el('canvas', {
      id: 'qr', role: 'img',
      'aria-label': `UPI payment QR code for ${money(b.total)} to DD Diamond Park RWA`,
    });
    block.append(el('div', { style: 'margin-top:var(--s-4);text-align:center' }, canvas));
    drawQr(canvas, links.qr, { target: 240 });
  }

  block.append(
    el('p', { class: 'helper' },
      el('span', {}, 'Pay exactly '),
      el('strong', {}, money(b.total)),
      el('span', {}, ` and leave the reference as it is — that is how flat ${me.flat}'s payment is matched.`)),
    el('p', { style: 'text-align:center;margin-top:var(--s-3)' },
      el('a', { class: 'linkish', href: '/proof' }, 'Already paid? Upload screenshot'))
  );

  return block;
}


/* ── breakdown, history ───────────────────────────────────────────────── */

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

function consumptionSection(readings) {
  const withUse = readings.filter((r) => r.consumption != null).reverse();
  const peak = Math.max(...withUse.map((r) => r.consumption), 0.01);

  return el('section', { class: 'stack' },
    el('hr', { class: 'rule' }),
    el('p', { class: 'label', html: bilingual('consumption') }),
    el('div', { class: 'chart-wrap' },
      el('div', { class: 'chart' },
        ...withUse.map((r, i) =>
          el('div', {
            class: `chart__bar ${i === withUse.length - 1 ? 'chart__bar--now' : ''}`,
            style: `height:${Math.max(4, (r.consumption / peak) * 100)}%`,
            title: `${periodLabel(r.period)} — ${kg(r.consumption)}`,
          }, el('span', {}, periodLabel(r.period).slice(0, 3).toUpperCase()))))),
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
            el('td', { class: 'r' }, r.reading.toFixed(3)),
            el('td', { class: 'r' }, r.consumption == null ? '—' : kg(r.consumption)))))))
  );
}

function billHistorySection(bills) {
  return el('section', { class: 'stack' },
    el('hr', { class: 'rule' }),
    el('p', { class: 'label', html: bilingual('billHistory') }),
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
      `Questions about your bill? Contact ${treasurerLine()}.`)
  );
}
