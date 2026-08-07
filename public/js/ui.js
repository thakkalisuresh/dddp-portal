/**
 * Small render helpers shared by every screen. No framework — the app is a
 * handful of pages and a virtual DOM would be more code than the app.
 */

import { money, en } from './i18n.js';

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape anything that came from a resident. Comments and names go through here. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const CHIP = {
  paid:      { cls: 'chip--paid',     key: 'paid' },
  unpaid:    { cls: 'chip--overdue',  key: 'unpaid' },
  overdue:   { cls: 'chip--overdue',  key: 'overdue' },
  initiated: { cls: 'chip--awaiting', key: 'checking' },
  awaiting:  { cls: 'chip--awaiting', key: 'checking' },
  waived:    { cls: 'chip--neutral',  key: 'paid' },
};

/** Status always renders as dot + word, never colour alone. */
export function statusChip(status) {
  const conf = CHIP[status] ?? CHIP.unpaid;
  return el('span', { class: `chip ${conf.cls}` }, en(conf.key));
}

/**
 * The god-mode banner. Rendered from /api/me on every page — if it is ever
 * possible to be impersonating without seeing this, that is a bug, not a
 * styling preference (plan §5.5).
 */
export function renderGodBanner(me, { onExit, onAllowWrites } = {}) {
  const bar = $('#godbar');
  if (!bar) return;
  if (!me?.impersonation?.active) { bar.hidden = true; return; }

  bar.hidden = false;
  bar.replaceChildren(
    el('svg', {
      class: 'godbar__icon', width: '18', height: '18', viewBox: '0 0 24 24',
      fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
      html: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    }),
    el('span', { class: 'godbar__text' },
      `Viewing as ${me.name} · ${me.flat} · ${me.impersonation.canWrite ? 'writes enabled' : 'read only'}`),
    el('span', { class: 'godbar__actions' },
      me.impersonation.canWrite ? null : el('button', {
        class: 'btn btn--sm btn--quiet', type: 'button', onclick: onAllowWrites,
      }, 'Allow writes'),
      el('button', { class: 'btn btn--sm', type: 'button', onclick: onExit }, 'Exit'))
  );
}

/** A ruled bill breakdown — a paper document, not a card grid. */
export function billBreakdown(bill) {
  const line = (label, value, cls) =>
    el('tr', { class: cls }, el('td', {}, label), el('td', { class: 'r' }, value));

  const rows = [
    line('Consumption', `${Number(bill.consumption).toFixed(2)} kg`),
    line('Rate', `${money(bill.rate_per_kg)} / kg`),
    line('Gas amount', money(bill.gas_amount)),
  ];
  if (bill.other_charges) rows.push(line('Other charges', money(bill.other_charges)));
  if (bill.additional_charges) rows.push(line('Additional charges', money(bill.additional_charges)));
  if (bill.late_fee) {
    const r = line('Late fee', money(bill.late_fee));
    r.style.color = 'var(--overdue)';
    rows.push(r);
  }
  rows.push(line('Total', money(bill.total), 'total'));

  return el('table', { class: 'table' }, el('tbody', {}, ...rows));
}

/** Errors say what went wrong and what to do about it. */
export function showError(container, error) {
  const node = el('div', { class: 'note note--bad', role: 'alert' },
    error?.message ?? 'Something went wrong. Please try again.');
  container.replaceChildren(node);
}
