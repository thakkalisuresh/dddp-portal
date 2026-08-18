/**
 * Small render helpers shared by every screen. No framework — the app is a
 * handful of pages and a virtual DOM would be more code than the app.
 */

import { money } from './i18n.js';

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Escape for use inside an HTML string — `innerHTML` or an `html:` attribute.
 *
 * NOT for text passed to el(): el() builds text nodes, which are already inert,
 * so escaping first makes the entities render literally ("&quot;" on screen).
 */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// createElement always builds an HTML element, so el('svg') produced an
// HTMLUnknownElement named "svg" that rendered as nothing at all — the bottom
// nav showed labels with a blank space where each icon should be. SVG elements
// only work in their own namespace. Children set through `html:` are fine
// without listing them here: innerHTML parses in the context element's
// namespace, so the paths inside a real <svg> come out as real SVG nodes.
const SVG_TAGS = new Set([
  'svg', 'path', 'g', 'circle', 'ellipse', 'rect', 'line',
  'polyline', 'polygon', 'defs', 'use',
]);

export function el(tag, attrs = {}, ...children) {
  const node = SVG_TAGS.has(tag)
    ? document.createElementNS('http://www.w3.org/2000/svg', tag)
    : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    // setAttribute, not .className: on an SVG element className is a read-only
    // SVGAnimatedString, and assigning to it throws.
    if (k === 'class') node.setAttribute('class', v);
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

/**
 * Like node.replaceChildren, but drops null and undefined.
 *
 * The native method stringifies them, so a conditional child written as
 * `cond ? node : null` renders the literal word "null" on the page. That
 * shipped to production on the public homepage.
 */
export function setChildren(node, ...children) {
  node.replaceChildren(...children.flat().filter((c) => c != null));
}

// Five statuses, four words: 'initiated' and 'awaiting' are both Checking to a
// resident — the difference between them is the treasurer's business — and a
// waived bill reads as Paid, because that is what it means to the person who
// owes nothing.
const CHIP = {
  paid:      { cls: 'chip--paid',     label: 'Paid' },
  unpaid:    { cls: 'chip--overdue',  label: 'Unpaid' },
  overdue:   { cls: 'chip--overdue',  label: 'Overdue' },
  initiated: { cls: 'chip--awaiting', label: 'Checking' },
  awaiting:  { cls: 'chip--awaiting', label: 'Checking' },
  waived:    { cls: 'chip--neutral',  label: 'Paid' },
  // Proof statuses, not bill statuses. Without these the fallback is `unpaid`,
  // which labels an approved proof "Unpaid" — worse than no chip at all.
  approved:  { cls: 'chip--paid',     label: 'Approved' },
  rejected:  { cls: 'chip--overdue',  label: 'Rejected' },
  pending:   { cls: 'chip--awaiting', label: 'Pending' },
};

/** Status always renders as dot + word, never colour alone. */
export function statusChip(status) {
  const conf = CHIP[status] ?? CHIP.unpaid;
  return el('span', { class: `chip ${conf.cls}` }, conf.label);
}

/**
 * How a proof reads in the admin queue: the verdict, not two numbers.
 *
 * The pair this replaces — "Claimed ₹244 · Billed ₹199" — asked the treasurer
 * to do the arithmetic ninety-nine times a month on a phone, and said
 * "claimed" about a figure no resident ever typed: it is what the vision model
 * read off the image. The matching rows, which are most of them, now carry one
 * number and need no reading at all.
 *
 * THE DIRECTION IS IN THE SENTENCE because it used to be assumed. The old line
 * hardcoded "short by" and clamped the difference at zero, so an overpayment
 * rendered as "short by ₹0" — wrong word, meaningless figure, and wrong
 * precisely on the rows that most need a second look.
 */
export function proofVerdict({ claimedAmount, billed }) {
  if (claimedAmount == null) {
    // Deliberately does NOT name a cause. The amount is absent either because
    // the image was poor or because the provider never answered, and this line
    // cannot tell which — asserting the first is how a dead provider reads as
    // ninety-nine bad photographs. What the treasurer can act on is the same
    // either way: look at it.
    return { text: `Bill ${money(billed)} · check by hand`, tone: 'muted' };
  }
  const difference = Math.round((claimedAmount - billed) * 100) / 100;
  if (difference === 0) return { text: `${money(billed)} · matches`, tone: 'ok' };
  return {
    tone: 'bad',
    text: `${money(claimedAmount)} · bill ${money(billed)}, `
      + `${difference > 0 ? 'over' : 'short'} by ${money(Math.abs(difference))}`,
  };
}

/**
 * The viewing-as banner. Rendered from /api/me on every page — if it is ever
 * possible to be impersonating without seeing this, that is a bug, not a
 * styling preference (plan §5.5).
 */
export function renderViewBanner(me, { onExit, onAllowWrites } = {}) {
  const bar = $('#viewbar');
  if (!bar) return;
  if (!me?.impersonation?.active) { bar.hidden = true; return; }

  bar.hidden = false;
  bar.replaceChildren(
    el('svg', {
      class: 'viewbar__icon', width: '18', height: '18', viewBox: '0 0 24 24',
      fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
      html: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    }),
    el('span', { class: 'viewbar__text' },
      `Viewing as ${me.name} · ${me.flat} · ${me.impersonation.canWrite ? 'writes enabled' : 'read only'}`),
    el('span', { class: 'viewbar__actions' },
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

/**
 * Ask before something destructive, in the page rather than in a dialog.
 *
 * REPLACES window.confirm, which is not guaranteed to draw anything: a browser
 * that has suppressed dialogs returns false immediately, so the universal
 * `if (!confirm(msg)) return;` becomes a click that does nothing, sends
 * nothing and says nothing. That reached production on the notice board — the
 * Withdraw button was pressed repeatedly with no dialog and no withdrawal —
 * and the same line guarded five other destructive actions, including handing
 * over superadmin.
 *
 * Promise of a boolean, so a call site keeps the shape it already had and the
 * change is one `await`:
 *
 *   if (!await askFirst(slot, 'Delete X?', 'Yes, delete')) return;
 *
 * `slot` is an element that is ON SCREEN — not inside anything collapsed, the
 * mistake that made a failed withdraw invisible. It is emptied either way, so
 * the same element can hold the error afterwards.
 *
 * The destructive choice is a real button and the way out is the quiet one,
 * matching how the rest of this interface weights an action against its
 * escape. Nothing here is a substitute for the server's own permission check.
 */
export function askFirst(slot, message, confirmLabel = 'Yes', cancelLabel = 'Keep it') {
  return new Promise((resolve) => {
    const answer = (said) => { slot.replaceChildren(); resolve(said); };
    const yes = el('button', {
      class: 'btn btn--sm', type: 'button', onclick: () => answer(true),
    }, confirmLabel);
    slot.replaceChildren(
      el('div', { class: 'note note--warn stack', style: 'gap:var(--s-3)', role: 'alertdialog' },
        el('p', { class: 'small' }, message),
        el('div', { class: 'row', style: 'gap:var(--s-3)' }, yes,
          el('button', {
            class: 'linkish small', type: 'button', onclick: () => answer(false),
          }, cancelLabel))));
    // Focus lands on the confirming button so the keyboard path is one Tab to
    // the way out, rather than a hunt through whatever preceded the slot.
    yes.focus();
  });
}

/** Errors say what went wrong and what to do about it. */
export function showError(container, error) {
  const node = el('div', { class: 'note note--bad', role: 'alert' },
    error?.message ?? 'Something went wrong. Please try again.');
  container.replaceChildren(node);
}

/**
 * A show/hide control for a password field.
 *
 * Six password inputs across login, forgot, onboarding and profile, so this is
 * one component rather than six copies. It toggles `type`, which keeps the
 * field a real password input for autofill and managers until the moment
 * somebody asks to see it.
 *
 * `aria-pressed` rather than a label change alone: a screen reader user needs
 * to know the state, not just that a button exists. And the button never sits
 * inside the input, because on a narrow phone that overlaps the text being
 * revealed — the whole point of pressing it.
 */
export function withReveal(input) {
  const btn = el('button', {
    type: 'button', class: 'reveal', 'aria-pressed': 'false',
    'aria-label': 'Show password',
  }, 'Show');

  btn.addEventListener('click', () => {
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    btn.textContent = shown ? 'Show' : 'Hide';
    btn.setAttribute('aria-pressed', String(!shown));
    btn.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
    // Focus returns to the field so typing continues uninterrupted.
    input.focus();
  });

  // Works whether the input is already on the page or freshly built. The first
  // version returned the wrapper and left callers to do
  // `input.replaceWith(withReveal(input))`, which throws: the wrapper contains
  // the very node being replaced. Doing the swap in here means neither caller
  // has to know the difference.
  const parent = input.parentNode;
  const next = input.nextSibling;
  const wrap = el('div', { class: 'reveal-wrap' });
  wrap.append(input, btn);
  if (parent) parent.insertBefore(wrap, next);
  return wrap;
}

/**
 * A folded-in section: closed, and not loaded until it is opened.
 *
 * Lazy on purpose. Bills now carries two more panels than it did, and eager
 * loading would make the screen everybody uses pay for the two they rarely
 * open — which is the trade that would have made this consolidation a
 * regression rather than a tidy-up.
 *
 * <details> rather than a modal or a nested tab strip, because every other
 * disclosure in this app is a <details> and one screen with its own idiom is a
 * second idiom to maintain (see flatCard, which says the same thing).
 */
export function foldedSection(label, badge, render) {
  const body = el('div');
  const summary = el('summary', { class: 'fold__summary' },
    el('span', {}, label),
    badge ? el('span', { class: 'chip chip--awaiting' }, badge) : null);
  const details = el('details', { class: 'fold' }, summary, body);

  let loaded = false;
  details.addEventListener('toggle', async () => {
    if (!details.open || loaded) return;
    loaded = true;
    body.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
    try {
      body.replaceChildren(await render());
    } catch (err) {
      // Reset, so a failed open can be retried by closing and opening again
      // rather than leaving the section permanently empty.
      loaded = false;
      showError(body, err);
    }
  });
  return details;
}
