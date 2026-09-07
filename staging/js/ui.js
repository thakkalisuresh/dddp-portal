/**
 * Element helpers, the icon set, and the shared components.
 *
 * Deliberately the same `el()` idiom the production portal already uses, so a
 * screen ported from here into public/js reads as the same codebase rather
 * than a transplant.
 */

/* ── el ─────────────────────────────────────────────────────────────────── */

export function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'html') node.innerHTML = v;
    else if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  add(node, kids);
  return node;
}

export function svg(path, { size = 24, fill = false, width = 1.9 } = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('width', size);
  node.setAttribute('height', size);
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('fill', fill ? 'currentColor' : 'none');
  if (!fill) {
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', width);
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
  }
  node.innerHTML = path;
  return node;
}

function add(node, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

/* ── icons ──────────────────────────────────────────────────────────────
   One family, one stroke weight, drawn on the same 24px grid — the HIG
   iconography rule that matters most. Outline by default so they sit at the
   same optical weight as the text beside them.                              */

export const I = {
  bill:     '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2Z"/><path d="M9.5 8.5h5M9.5 12.5h5"/>',
  bell:     '<path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6Z"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/>',
  person:   '<circle cx="12" cy="8" r="4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  grid:     '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
  check:    '<path d="m4.5 12.5 5 5 10-11"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12.2 2.7 2.8L16 9.4"/>',
  clock:    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.3l3.4 2"/>',
  alert:    '<path d="M12 3.8 2.6 20h18.8Z"/><path d="M12 10v4.2"/><circle cx="12" cy="17.2" r="0.1" stroke-width="2.2"/>',
  info:     '<circle cx="12" cy="12" r="9"/><path d="M12 11.2v5"/><circle cx="12" cy="7.9" r="0.1" stroke-width="2.2"/>',
  chevron:  '<path d="m9 5 7 7-7 7"/>',
  back:     '<path d="m15 5-7 7 7 7"/>',
  qr:       '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3h-3zM20 14h1M14 20h3M20 17v4"/>',
  camera:   '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.9l1.3-2h6.6l1.3 2h1.9A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5Z"/><circle cx="12" cy="13" r="3.6"/>',
  upload:   '<path d="M12 16V4.5"/><path d="m7.5 9 4.5-4.5L16.5 9"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  download: '<path d="M12 4v11.5"/><path d="m7.5 11 4.5 4.5L16.5 11"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  chart:    '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  flame:    '<path d="M12 3s5.5 4.2 5.5 9.2A5.5 5.5 0 0 1 12 21a5.5 5.5 0 0 1-5.5-8.8C7.6 9.6 9.5 9 9.5 6.5c1.4.8 2.5 2 2.5 2S11 6 12 3Z"/>',
  lock:     '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/>',
  mail:     '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.8 6.8 8.2 6 8.2-6"/>',
  phone:    '<path d="M6.5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2Z"/>',
  home:     '<path d="m3.5 10.5 8.5-7 8.5 7"/><path d="M5.5 9.2V20h13V9.2"/><path d="M10 20v-5.5h4V20"/>',
  users:    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 19.5a6.5 6.5 0 0 1 13 0"/><path d="M16.5 5.2a3.5 3.5 0 0 1 0 6.6M17.5 14.2a6.5 6.5 0 0 1 4 5.3"/>',
  rupee:    '<path d="M7 4h10M7 8.5h10M16.5 4c0 3.6-2.6 4.5-5.5 4.5H7l8 11.5"/>',
  bank:     '<path d="m3 9.5 9-5.5 9 5.5"/><path d="M5.5 10v8M10 10v8M14 10v8M18.5 10v8"/><path d="M3 20.5h18"/>',
  search:   '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  plus:     '<path d="M12 5v14M5 12h14"/>',
  x:        '<path d="m6 6 12 12M18 6 6 18"/>',
  logout:   '<path d="M15 5.5V4a1.5 1.5 0 0 0-1.5-1.5h-8A1.5 1.5 0 0 0 4 4v16a1.5 1.5 0 0 0 1.5 1.5h8A1.5 1.5 0 0 0 15 20v-1.5"/><path d="M9.5 12H21"/><path d="m17.5 8.5 3.5 3.5-3.5 3.5"/>',
  moon:     '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
  sun:      '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>',
  text:     '<path d="M4 7V5h16v2M12 5v14M9 19h6"/>',
  doc:      '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z"/><path d="M13 3v6h6"/>',
  meter:    '<circle cx="12" cy="12" r="8.5"/><path d="M12 12l3.5-3"/><path d="M12 3.5v2M20.5 12h-2M12 20.5v-2M3.5 12h2"/>',
  send:     '<path d="M21 3 10.5 13.5"/><path d="M21 3 14.5 21l-4-7.5L3 9.5Z"/>',
  eye:      '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3.2"/>',
  shield:   '<path d="M12 2.8 20 6v6c0 4.8-3.4 7.7-8 9.2C7.4 19.7 4 16.8 4 12V6Z"/><path d="m8.8 12 2.3 2.4 4.1-4.6"/>',
};

export const icon = (name, opts) => svg(I[name] ?? I.info, opts);

/* ── formatting ─────────────────────────────────────────────────────────
   One place, so a rupee is written the same way on every screen. Indian
   digit grouping — 1,24,500 not 124,500 — because that is what a resident
   checking the figure against their bank app will see there.                 */

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export const money = (n) => `₹${inr.format(Math.round(n ?? 0))}`;
export const kg = (n) => `${(n ?? 0).toFixed(2)} kg`;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * EVERY DATE HERE IS THE BUILDING'S OWN DATE.
 *
 * Not the viewer's. A due date belongs to Thrissur, and an owner reading their
 * bill from Toronto or Dubai must see the same 20 September the treasurer set —
 * not the 19th because their laptop is seven hours behind.
 *
 * `new Date(iso)` on a bare date string parses as UTC midnight, and reading the
 * local fields off that lands a day early anywhere west of Greenwich. This
 * formats in Asia/Kolkata explicitly instead, which is also what the production
 * portal's i18n.js does — the approach is taken from there rather than
 * reinvented, because it was already right.
 */
const IST = 'Asia/Kolkata';
const IST_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST, year: 'numeric', month: 'numeric', day: 'numeric',
});

/** { year, month, day } as read in Kerala. */
function istParts(iso) {
  const out = {};
  for (const p of IST_FORMAT.formatToParts(new Date(iso))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

/** '2026-08' → 'August 2026' */
export function periodLabel(p) {
  const [y, m] = String(p).split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}
export const periodShort = (p) => periodLabel(p).slice(0, 3);

/** '2026-08-20' → '20 August' — the day, said the way a person says it. */
export function dayLabel(iso) {
  const { day, month } = istParts(iso);
  return `${day} ${MONTHS[month - 1]}`;
}
export const dayFull = (iso) => `${dayLabel(iso)} ${istParts(iso).year}`;

/** '3 days ago' — for anything a person judges by recency, not by date. */
export function ago(iso) {
  const days = Math.round((Date.now() - new Date(iso)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months === 1 ? 'last month' : `${months} months ago`;
}

/* ── components ─────────────────────────────────────────────────────────── */

/**
 * A row in a grouped list.
 *
 * `to` makes it an anchor, `onClick` a button, neither a plain div — so a row
 * that navigates is announced as a link and a row that only reports a fact is
 * not announced as anything clickable. That distinction is most of what makes
 * a list readable without sight.
 */
export function row({ title, sub, value, icon: ic, tint, to, onClick, chip: c, chev, disabled }) {
  const tag = to ? 'a' : onClick ? 'button' : 'div';
  const attrs = {
    class: `list__row${ic ? ' list__row--iconed' : ''}`,
    ...(to ? { href: to } : {}),
    ...(onClick ? { type: 'button', onclick: onClick } : {}),
    ...(disabled ? { 'aria-disabled': 'true' } : {}),
  };
  return el(tag, attrs,
    ic ? el('span', { class: 'list__icon', style: `background:${tint ?? 'var(--accent)'}` }, icon(ic, { size: 18 })) : null,
    el('span', { class: 'list__body' },
      el('span', { class: 'list__title' }, title),
      sub ? el('span', { class: 'list__sub' }, sub) : null),
    c ?? (value != null ? el('span', { class: 'list__value' }, value) : null),
    (to || onClick) && chev !== false ? svg(I.chevron, { size: 15, width: 2.4 }) : null);
}

export const list = (...rows) => el('div', { class: 'list' }, ...rows);

export function group(title, body, note) {
  return el('section', { class: 'group' },
    title ? el('h2', { class: 'group__title' }, title) : null,
    body,
    note ? el('p', { class: 'group__note' }, note) : null);
}

/**
 * Status, said three ways at once: a hue, a glyph and a word.
 *
 * Never colour alone — red-green colour blindness is roughly one man in twelve,
 * and "paid" versus "overdue" is precisely the red/green pair.
 */
const CHIPS = {
  paid:     { kind: 'good', ic: 'checkCircle', text: 'Paid' },
  awaiting: { kind: 'warn', ic: 'clock',       text: 'Checking' },
  due:      { kind: 'info', ic: 'info',        text: 'Due' },
  overdue:  { kind: 'bad',  ic: 'alert',       text: 'Overdue' },
  exempt:   { kind: 'quiet',ic: 'shield',      text: 'Not billed' },
  draft:    { kind: 'quiet',ic: 'doc',         text: 'Draft' },
};
export function statusChip(status, override) {
  const c = CHIPS[status] ?? CHIPS.due;
  return el('span', { class: `chip chip--${c.kind}` }, icon(c.ic, { size: 15 }), override ?? c.text);
}

export function banner(kind, ...body) {
  const ics = { good: 'checkCircle', warn: 'alert', bad: 'alert', info: 'info' };
  return el('div', { class: `banner banner--${kind}`, role: kind === 'bad' ? 'alert' : null },
    icon(ics[kind], { size: 20 }),
    el('div', { class: 'banner__body' }, ...body));
}

export function empty(ic, title, text, action) {
  return el('div', { class: 'empty' },
    el('div', { class: 'empty__icon' }, icon(ic, { size: 28 })),
    el('p', { class: 'empty__title' }, title),
    text ? el('p', {}, text) : null,
    action ?? null);
}

export function field(label, input, { hint, error } = {}) {
  const id = input.id || `f${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  if (hint) input.setAttribute('aria-describedby', `${id}-h`);
  if (error) input.setAttribute('aria-invalid', 'true');
  return el('div', { class: 'field' },
    el('label', { class: 'field__label', for: id }, label),
    input,
    hint ? el('span', { class: 'field__hint', id: `${id}-h` }, hint) : null,
    error ? el('span', { class: 'field__err' }, icon('alert', { size: 16 }), error) : null);
}

/**
 * A password field with a reveal, because a typo you cannot see is a lockout —
 * and a lockout on this portal means ringing the treasurer.
 *
 * Built in this order deliberately: field() first, so it can assign the id and
 * wire the label, and only THEN is the input lifted into the wrapper. Wrapping
 * first and calling field() after moved the input straight back out of the
 * wrapper — field() appends it — and the screen rendered a reveal button with
 * no box beside it.
 */
export function passwordField(label, opts = {}) {
  const input = el('input', { class: 'input', type: 'password', autocomplete: opts.autocomplete ?? 'current-password' });
  const f = field(label, input, opts);

  const toggle = el('button', {
    class: 'field__trail', type: 'button', 'aria-label': 'Show password',
    onclick: () => {
      const shown = input.type === 'text';
      input.type = shown ? 'password' : 'text';
      toggle.textContent = shown ? 'Show' : 'Hide';
      toggle.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
      input.focus();
    },
  }, 'Show');

  const wrap = el('div', { class: 'field__wrap' });
  input.replaceWith(wrap);
  wrap.append(input, toggle);
  return Object.assign(f, { input });
}

export function segmented(options, value, onPick) {
  const bar = el('div', { class: 'segmented', role: 'tablist' });
  bar.replaceChildren(...options.map((o) => el('button', {
    class: 'segmented__opt', type: 'button', role: 'tab',
    'aria-selected': String(o.value === value),
    onclick: () => onPick(o.value),
  }, o.label)));
  return bar;
}

export function kv(k, v, cls = '') {
  return el('div', { class: `kv ${cls}` },
    el('span', { class: 'kv__k' }, k),
    el('span', { class: 'kv__v' }, v));
}

/** A sheet. Focus moves in, Escape and the scrim both close it. */
export function sheet(title, ...body) {
  const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const panel = el('div', {
    class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
    // Focused itself rather than its first control. Focusing the first button
    // scrolled the sheet down to reach it, so a tall sheet opened part-way
    // through its own content with the title off screen. The dialog is the
    // right thing to announce anyway.
    tabindex: '-1',
    onclick: (e) => e.stopPropagation(),
  },
    el('div', { class: 'sheet__grip' }),
    el('h2', { class: 'sheet__title' }, title),
    ...body,
    el('button', { class: 'btn btn--tinted btn--block', type: 'button', onclick: close }, 'Close'));
  const scrim = el('div', { class: 'scrim', onclick: close }, panel);
  document.body.append(scrim);
  document.addEventListener('keydown', onKey);
  panel.focus({ preventScroll: true });
  panel.scrollTop = 0;
  return { close, panel };
}

/** For confirmations only — never for anything the reader must not miss. */
let toastTimer;
export function toast(text) {
  document.querySelector('.toast')?.remove();
  const t = el('div', { class: 'toast', role: 'status' }, icon('check', { size: 18 }), text);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2600);
}

/** Loading, in the shape of what is coming. */
export function skeleton(kind = 'block', n = 1) {
  return el('div', { class: 'stack stack--sm', 'aria-hidden': 'true' },
    ...Array.from({ length: n }, () => el('div', { class: `sk sk--${kind}` })));
}
