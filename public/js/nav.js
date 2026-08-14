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
import { api } from './api.js';

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
 * A section of the admin console is a dead end without this.
 *
 * The bottom bar has an Admin item, but on the section you are already inside
 * it renders as the current page — so the one control that would take you back
 * is the one that looks like where you already are. Each section had improvised
 * its own answer: roster linked to the console, proofs linked sideways to
 * readings, and readings offered Log out. The way out should not depend on
 * which screen you happened to open.
 *
 * Placed first in the appbar, before the title, because `.appbar__action` is
 * pushed right by `margin-left: auto` and a way back belongs on the left.
 */
function renderAdminBack(current) {
  const bar = document.querySelector('.appbar');
  if (!bar) return;

  const inSection = current.startsWith('/admin')
    && !/^\/admin\/?(index\.html)?$/.test(current);

  const existing = bar.querySelector('.appbar__back');
  if (!inSection) { existing?.remove(); return; }
  if (existing) return;

  bar.prepend(el('a', {
    class: 'appbar__back', href: '/admin/',
    // "Admin" alone reads as a destination among others; the chevron and the
    // label together read as a way out.
    'aria-label': 'Back to the admin console',
  }, el('span', { 'aria-hidden': 'true' }, '‹'), 'Admin'));
}

/**
 * @param me      the /api/me payload
 * @param current pathname to mark as the active destination
 */
export function renderNav(me, current = location.pathname) {
  const items = itemsFor(me);
  renderAdminBack(current);
  // Every screen that draws the nav also gets its way out, whether the page
  // wired one or not, and the number to ring when the way out is broken too.
  wireLogout();
  renderSupportFooter(me?.support);
  const active = (href) =>
    href === '/admin/' ? current.startsWith('/admin') : current.startsWith(href);

  let bar = $('#appnav');
  if (!bar) {
    bar = el('nav', { id: 'appnav', class: 'bottomnav', 'aria-label': 'Main' });
    // Inserted after the header rather than appended to <body>.
    //
    // On a phone the bar is position:fixed, which ignores document order — but
    // on a desktop it becomes position:sticky, and sticky sticks relative to
    // where the element actually sits in the flow. Appended last, it parked
    // *below* the content instead of at the top of the page.
    //
    // It also puts the nav next in the tab order after the header, which is
    // where a screen reader user expects to find it.
    const header = document.querySelector('.appbar');
    if (header) header.insertAdjacentElement('afterend', bar);
    else document.body.prepend(bar);
  }

  bar.replaceChildren(...items.map((item) => {
    // The notice board is the one destination with state worth surfacing.
    // Before B16 a resident met notices on the public homepage without logging
    // in; without this badge, taking them off that page would not make them
    // private so much as invisible.
    const unread = item.href === '/notices' ? (me?.unreadNotices ?? 0) : 0;

    return el('a', {
      class: `bottomnav__item ${active(item.href) ? 'is-current' : ''}`,
      href: item.href,
      // Current location must be announced, not merely coloured.
      'aria-current': active(item.href) ? 'page' : null,
      // The count goes in the accessible name too. A coloured dot says nothing
      // to a screen reader, and "Notices" alone would hide the whole point.
      'aria-label': unread ? `${item.label}, ${unread} new` : null,
    }, icon(item.icon), el('span', {}, item.label),
       unread
         ? el('span', { class: 'bottomnav__badge', 'aria-hidden': 'true' },
             unread > 9 ? '9+' : String(unread))
         : null);
  }));

  // The bar is fixed, so content needs room or the last row hides behind it.
  document.body.classList.add('has-bottomnav');
}

/** A quiet "Log out" for the header, since the bar has no room for it. */
export function renderLogout(onLogout) {
  const slot = $('#logout');
  if (!slot) return;
  slot.addEventListener('click', onLogout);
}

/**
 * Who to tell when the portal itself is broken.
 *
 * Every screen BEHIND THE LOGIN, and none in front of it. The number is a
 * personal mobile, and login and /forgot are reachable by anyone on the
 * internet — putting it there publishes it to every scraper that visits, for
 * the sake of the small number of people who are locked out. Those still have
 * the treasurer's line already printed on the login page.
 *
 * Drawn from renderNav, which only authenticated screens call, so the boundary
 * is the same one the session enforces rather than a list somebody has to keep
 * in step.
 *
 * WhatsApp rather than a form, because a person whose portal is misbehaving
 * should not have to use the portal to report it. The screenshot is asked for
 * because "it isn't working" and a photograph of the error are two very
 * different reports to receive.
 *
 * Appended once and guarded, so a page that redraws its main content does not
 * end up with three of these.
 */
export function renderSupportFooter(support, root = document.querySelector('main') ?? document.body) {
  // No contact, no footer. Better a missing line than one promising a number
  // the page does not have.
  if (!support?.wa || !root || root.querySelector('.supportfoot')) return;
  root.append(
    el('footer', { class: 'supportfoot' },
      'Something not working on the portal? Message ',
      el('b', {}, `${support.name}${support.flat ? ` (${support.flat})` : ''}`),
      ' on ',
      el('a', {
        class: 'linkish', href: `https://wa.me/${support.wa}`,
        rel: 'noopener', target: '_blank',
      }, 'WhatsApp'),
      ` — ${support.shown}. A screenshot helps.`)
  );
}

/**
 * The way OUT, on every resident screen.
 *
 * Notices and Me used to put "My bill" here — a second route to a page the
 * bottom bar already links, occupying the one slot where a person looks to
 * leave. Logging out therefore meant going to the dashboard first and finding
 * the button there, which nobody guesses on a shared phone.
 *
 * Wired here rather than per page because that is how it drifted apart in the
 * first place: each screen answered the question its own way.
 */
export function wireLogout() {
  const slot = $('#logout');
  if (!slot || slot.dataset.wired) return;
  slot.dataset.wired = '1';
  slot.addEventListener('click', async () => {
    slot.disabled = true;
    // The redirect happens either way. A logout that fails on the network has
    // still ended the session as far as this device is concerned, and leaving
    // somebody on a page that looks logged in is the worse outcome.
    await api.logout().catch(() => {});
    location.href = '/login';
  });
}
