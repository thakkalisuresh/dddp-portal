/**
 * One bill in full — the screen behind every card on Home.
 *
 * This IS the old dashboard hero, moved rather than rebuilt: the amount, the
 * deadline, the fee warnings, the breakdown and the chart all worked and all
 * still say what they said. What changed is that the hero used to be the whole
 * of /dashboard and now answers for one bill among several.
 *
 * ONE SCREEN FOR BOTH KINDS. The gas-specific parts — consumption, kilograms,
 * rate per kg, the chart — are ABSENT for a maintenance bill rather than
 * rendered as zeroes, and there is no second maintenance screen. A second route
 * would mean a second access-control path, and bill visibility is the one thing
 * in this application that has already had a privacy bug.
 *
 * THE KIND COMES FROM THE SERVER. The URL carries an id and nothing else, so a
 * mismatched id-and-kind pair is not a thing anybody has to remember to check.
 */

import { api, ApiError } from './api.js';
import { renderNav } from './nav.js';
import { trackPage } from './track.js';
import {
  $, el, esc, statusChip, billBreakdown, maintBreakdown, renderViewBanner, showError,
} from './ui.js';
import { money, kg, periodLabel, dayLabel } from './i18n.js';

const main = $('#main');

trackPage('/bill');
init();

async function init() {
  const id = new URLSearchParams(location.search).get('id');
  try {
    const [me, detail] = await Promise.all([api.me(), api.billDetail(id)]);
    if (me.mustChangePassword) { location.href = '/password'; return; }
    render(me, detail);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login'; return; }
    // A 404 here covers both "no such bill" and "not your bill", deliberately:
    // a distinguishable "not yours" would let somebody walk the ids and learn
    // which flats owe what.
    showError(main, err);
  }
}

function render(me, detail) {
  $('#who').innerHTML = `Flat ${esc(me.flat)} <span>· ${esc(me.name)}</span>`;
  renderViewBanner(me, {
    onExit: async () => { await api.god.exit(); location.reload(); },
    onAllowWrites: async () => { /* phase 7b: re-issue the session with writes */ },
  });
  renderNav(me, '/dashboard');

  const isGas = detail.kind === 'gas';

  // FILTERED, because replaceChildren is not el(). el() skips a null child;
  // replaceChildren stringifies it and the word "null" appears on the page.
  // landlordNote, paySection and whySection all return null in the common case,
  // so without this an ordinary bill renders three of them.
  main.replaceChildren(...[
    el('p', {}, el('a', { class: 'linkish', href: '/dashboard' }, '‹ Home')),
    landlordNote(detail),
    heroSection(detail),
    paySection(detail),
    breakdownSection(detail),
    isGas ? downloadSection() : null,
    isGas && me.readings?.length ? consumptionSection(me.readings, me.bills) : null,
    // The bill history stayed OFF Home deliberately and lives here, where a
    // resident is already looking at one bill and asking how it compares.
    isGas && me.bills?.length ? billHistorySection(me.bills) : null,
    whySection(detail),
  ].filter(Boolean));
}

/**
 * A landlord is reading their TENANT's bill.
 *
 * Saying so is not decoration: an amount with no name against it looks like a
 * demand for money you owe. The owner may pay it on the tenant's behalf — the
 * Pay button works — and they are liable if it goes unpaid, but it is the
 * tenant's bill and the screen should not pretend otherwise.
 */
function landlordNote(detail) {
  if (detail.viewing !== 'landlord') return null;
  const who = detail.occupantName ?? 'your tenant';
  return el('div', { class: 'note' },
    `This is ${who}'s bill. You can pay it on their behalf. `
    + 'You are liable if it goes unpaid. Payment screenshots are not shown to owners.');
}

/* ── the hero ─────────────────────────────────────────────────────────── */

function heroSection(detail) {
  const b = detail.bill;
  const settled = b.settled;
  const label = detail.kind === 'maintenance'
    // The full form here, where there is room: the card said "Q4 2026".
    ? detail.maintenance.quarterLabel
    : periodLabel(b.period);

  return el('section', { class: 'bill-hero' },
    el('div', { class: 'bill-hero__top' },
      el('p', { class: 'label' }, label),
      statusChip(b.displayStatus, b.settledByAdvance ? 'Paid in advance' : null)),

    el('p', { class: 'amount', style: settled ? 'color:var(--ink-muted)' : '' }, money(b.total)),

    el('p', { class: 'muted' },
      settled
        ? (b.paidAt ? `Paid ${dayLabel(b.paidAt)}` : 'Settled')
        // "Due 20 Aug" read as "the 20th is fine", and it is not. The deadline
        // is stated as the instant it expires rather than the day it falls on.
        : b.dueDate ? `Pay before ${dayLabel(b.dueDate)}` : null),

    // The full amount is shown above, greyed like any settled bill, but a bill
    // the resident never paid a rupee towards THIS quarter needs to say why it
    // is settled — never a silent zero, never an unexplained "Paid".
    b.settledByAdvance
      ? el('p', { class: 'small muted' },
          'Covered by your advance payment — nothing further due for this quarter.')
      : null,

    // Warn about the fee before it lands — nobody should be surprised by it.
    b.lateFeeWarning
      ? el('p', { class: 'small', style: 'color:var(--awaiting);font-family:var(--font-ui)' },
          `${money(b.lateFeeWarning.amount)} late fee from ${dayLabel(b.lateFeeWarning.after)}, 00:00`)
      : null,

    // NEVER FOLD AN UNEXPLAINED FEE INTO A TOTAL. Once charged, the amount above
    // already includes it, so this line is what stops the total looking wrong.
    b.lateFee
      ? el('p', { class: 'small', style: 'color:var(--overdue);font-family:var(--font-ui)' },
          `Includes a late fee of ${money(b.lateFee)}`
          + (b.lateFeeAt ? `, applied ${dayLabel(b.lateFeeAt)}` : ''))
      : null,

    b.pendingApproval
      ? el('div', { class: 'note' },
          'The committee is reviewing a change to this bill. The amount may change, '
          + 'and no late fee is added while they decide.')
      : null,

    b.status === 'awaiting'
      ? el('div', { class: 'note note--warn' },
          "The treasurer is verifying your payment. You don't need to do anything.")
      : null,

    b.status === 'cancelled'
      ? el('div', { class: 'note' },
          'This bill was withdrawn. Nothing is owed on it.')
      : null
  );
}

/**
 * Pay is a LINK to the payment sheet, not the sheet itself.
 *
 * The sheet is its own route so that a poll's Pay button can link into it and
 * return; putting a second copy of it here would be two implementations of the
 * one screen where a mistake costs somebody money.
 */
function paySection(detail) {
  if (!detail.canPay) return null;
  const from = `/bill?id=${encodeURIComponent(detail.bill.id)}`;
  return el('section', { class: 'stack' },
    el('a', {
      class: 'btn btn--block btn--lg', id: 'pay',
      href: `/pay?bill=${encodeURIComponent(detail.bill.id)}&from=${encodeURIComponent(from)}`,
    }, `Pay ${money(detail.bill.total)}`));
}

function breakdownSection(detail) {
  const b = detail.bill;
  return el('section', { class: 'stack' },
    el('hr', { class: 'rule' }),
    detail.kind === 'gas'
      ? billBreakdown({
          consumption: detail.gas.consumption,
          rate_per_kg: detail.gas.ratePerKg,
          gas_amount: detail.gas.gasAmount,
          other_charges: detail.gas.otherCharges,
          additional_charges: detail.gas.additionalCharges,
          late_fee: b.lateFee,
          total: b.total,
        })
      : maintBreakdown(b, {
          basis: detail.maintenance.basis,
          rateApplied: detail.maintenance.rateApplied,
        }));
}

/**
 * Why this bill is what it is — maintenance only, and only when there is
 * something to say.
 *
 * The rate a flat is charged depends on whether it was let on the day the
 * quarter was issued, and a bill that moved between people mid-quarter carries
 * a history. Both produce the same question from the resident, and it is better
 * answered on the bill than by the treasurer on WhatsApp.
 */
function whySection(detail) {
  if (detail.kind !== 'maintenance') return null;
  const m = detail.maintenance;
  const lines = [];

  if (m.basis === 'tenant') {
    lines.push('This flat was recorded as let when the quarter was issued, '
      + 'so it is charged at the rented rate.');
  }
  if (m.reassignedAt) {
    lines.push(`This bill was moved to you on ${dayLabel(m.reassignedAt)}.`);
  }
  if (m.adjustReason) {
    lines.push(`The committee adjusted this bill: ${m.adjustReason}`);
  }
  if (!lines.length) return null;

  return el('section', { class: 'stack' },
    el('hr', { class: 'rule' }),
    el('p', { class: 'label' }, 'About this bill'),
    ...lines.map((text) => el('p', { class: 'small muted' }, text)));
}

/**
 * "Download bill" — a link to a real PDF, not a print dialog.
 *
 * A LINK, DELIBERATELY, not a button running script. The browser's own handling
 * of a PDF response is the thing a resident wants, and all of it comes free
 * from an anchor pointing at bytes.
 *
 * GAS ONLY for now: functions/lib/bill-pdf.js draws a gas bill, and pointing
 * this at a maintenance bill would produce a document with empty meter rows.
 * A maintenance slip is its own piece of work.
 */
function downloadSection() {
  return el('section', { class: 'stack' },
    el('a', {
      class: 'btn btn--ghost btn--block', href: '/api/me/bill.pdf',
      target: '_blank', rel: 'noopener', id: 'download-bill',
    }, 'Download bill'));
}

/* ── consumption, gas only ────────────────────────────────────────────── */

function consumptionSection(readings, bills = []) {
  const withUse = readings.filter((r) => r.consumption != null).reverse();
  const peak = Math.max(...withUse.map((r) => r.consumption), 0.01);
  // What each month cost, so the bar can say it. The chart plots kilograms, but
  // the question people actually have is what they paid.
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
            // Native title is desktop-only and slow. The readout below works on
            // touch too, where there is no hover at all.
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

/**
 * Every gas bill this household has had, with the rate each was issued at.
 *
 * Reached from "See all" on Home. It is the gas history only: maintenance has
 * four bills a year against gas's twelve, they are the same amount for every
 * flat of a kind, and a table of four identical rows answers nothing the cards
 * on Home have not already said.
 */
function billHistorySection(bills) {
  return el('section', { class: 'stack', id: 'history' },
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
      : null);
}

/** One shared readout rather than a floating tooltip per bar — a tooltip near
 *  the top of a phone screen ends up under the thumb that summoned it, and
 *  hover does not exist on touch at all. */
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
