/**
 * Navigation.
 *
 * This was missing entirely: every screen was built carefully and nothing
 * linked them, so the only way to reach the admin console was to type its URL.
 *
 * Role-driven. A resident sees three things and never learns that an admin
 * console exists; an admin gets one more; the superadmin gets god mode. The
 * bottom bar is thumb-reachable because 80% of use is a phone, and it caps at
 * five items per the navigation rules in the plan.
 */

import { el, $ } from './ui.js';

const RESIDENT = [
  { href: '/dashboard', label: 'Bill', icon: 'M3 3h18v4H3zM3 10h18v11H3z' },
  { href: '/notices', label: 'Notices', icon: 'M4 4h16v12H7l-3 3z' },
  { href: '/profile', label: 'Me', icon: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0' },
];

const ADMIN = { href: '/admin/', label: 'Admin', icon: 'M3 6h18M3 12h18M3 18h18' };
const GOD = { href: '/god', label: 'God', icon: 'M12 2l9 5v6c0 5-4 8-9 9-5-1-9-4-9-9V7z' };

function itemsFor(me) {
  const items = [...RESIDENT];
  if (me?.role === 'admin' || me?.role === 'superadmin') items.push(ADMIN);
  if (me?.role === 'superadmin') items.push(GOD);
  return items;
}

function icon(path) {
  return el('svg', {
    width: '22', height: '22', viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round',
    'stroke-linejoin': 'round', 'aria-hidden': 'true',
    html: `<path d="${path}"/>`,
  });
}

/**
 * @param me      the /api/me payload
 * @param current pathname to mark as the active destination
 */
export function renderNav(me, current = location.pathname) {
  const items = itemsFor(me);
  const active = (href) =>
    href === '/admin/' ? current.startsWith('/admin') : current.startsWith(href);

  let bar = $('#appnav');
  if (!bar) {
    bar = el('nav', { id: 'appnav', class: 'bottomnav', 'aria-label': 'Main' });
    document.body.append(bar);
  }

  bar.replaceChildren(...items.map((item) =>
    el('a', {
      class: `bottomnav__item ${active(item.href) ? 'is-current' : ''}`,
      href: item.href,
      // Current location must be announced, not merely coloured.
      'aria-current': active(item.href) ? 'page' : null,
    }, icon(item.icon), el('span', {}, item.label))));

  // The bar is fixed, so content needs room or the last row hides behind it.
  document.body.classList.add('has-bottomnav');
}

/** A quiet "Log out" for the header, since the bar has no room for it. */
export function renderLogout(onLogout) {
  const slot = $('#logout');
  if (!slot) return;
  slot.addEventListener('click', onLogout);
}
