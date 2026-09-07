/**
 * The shell: routing, the navigation bar, the tab bar, and the two settings
 * that belong to the reader rather than to the app — theme and text size.
 *
 * A hash router, because this prototype has to run from a file:// URL on
 * whatever device somebody opens it on.
 */

import { el, icon, svg, I, $, skeleton } from './ui.js';
import { PERSONAS } from './data.js';
import * as R from './screens/resident.js';
import * as A from './screens/auth.js';
import * as M from './screens/admin.js';

/* ── the route table ────────────────────────────────────────────────────
   `tab` names the tab bar item to light up; a route with no `tab` gets no
   tab bar at all, which is how login and the pay flow keep the screen to
   themselves. `back` gives the navigation bar its way out — every screen
   that is not a tab destination has one, always.                            */

const ROUTES = {
  '/':              { render: A.home,       title: 'Diamond Park', bare: true },
  '/login':         { render: A.login,      title: 'Log in', bare: true },
  '/forgot':        { render: A.forgot,     title: 'Forgotten password', back: '#/login', bare: true },
  '/set-password':  { render: A.setPassword,title: 'Set your password', bare: true },

  '/bill':          { render: R.dashboard,  title: 'Your bill', tab: 'bill', large: 'Your bill' },
  '/pay':           { render: R.pay,        title: 'Pay', back: '#/bill' },
  '/proof':         { render: R.proof,      title: 'Screenshot', back: '#/bill' },
  '/usage':         { render: R.usage,      title: 'Gas use', back: '#/bill' },
  '/notices':       { render: R.notices,    title: 'Notices', tab: 'notices' },
  '/notice/:id':    { render: R.notice,     title: 'Notice', back: '#/notices' },
  '/me':            { render: R.profile,    title: 'You', tab: 'me' },

  '/admin':            { render: M.adminHome,      title: 'Committee', tab: 'admin' },
  '/admin/month':      { render: M.adminMonth,     title: 'The month', back: '#/admin' },
  '/admin/bills':      { render: M.adminBills,     title: 'Bills', back: '#/admin' },
  '/admin/proofs':     { render: M.adminProofs,    title: 'Screenshots', back: '#/admin' },
  '/admin/reconcile':  { render: M.adminReconcile, title: 'Bank statement', back: '#/admin' },
  '/admin/residents':  { render: M.adminResidents, title: 'The building', back: '#/admin' },
  '/admin/roster':     { render: M.adminRoster,    title: 'Import roster', back: '#/admin' },
  '/admin/notices':    { render: M.adminNotices,   title: 'Notices', back: '#/admin' },
};

const TABS = [
  { id: 'bill',    href: '#/bill',    label: 'Bill',      ic: 'bill' },
  { id: 'notices', href: '#/notices', label: 'Notices',   ic: 'bell', badge: () => (ctx.persona === 'paid' ? 0 : 2) },
  { id: 'me',      href: '#/me',      label: 'You',       ic: 'person' },
  { id: 'admin',   href: '#/admin',   label: 'Committee', ic: 'shield', adminOnly: true },
];

/* ── state ───────────────────────────────────────────────────────────────
   Theme and text size are remembered per device. They are the reader's
   settings, not the app's, and losing them on every visit would be its own
   small insult to somebody who needed the largest size.                     */

const store = {
  get(k, fallback) { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};

const ctx = {
  persona: store.get('dp.persona', 'due'),
  params: [],
  state: {
    theme: store.get('dp.theme', 'auto'),
    text: store.get('dp.text', 'm'),
  },
  personas: PERSONAS,
  go(hash) { location.hash = hash; },
  render: () => render(),
  setPersona(key) { ctx.persona = key; store.set('dp.persona', key); },
  toggleTheme() {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(ctx.state.theme) + 1) % order.length];
    ctx.state.theme = next; store.set('dp.theme', next);
    applyChrome(); render();
  },
  cycleText() {
    const order = ['m', 'l', 'xl'];
    const next = order[(order.indexOf(ctx.state.text) + 1) % order.length];
    ctx.state.text = next; store.set('dp.text', next);
    applyChrome(); render();
  },
};

function applyChrome() {
  const root = document.documentElement;
  if (ctx.state.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', ctx.state.theme);
  if (ctx.state.text === 'm') root.removeAttribute('data-text');
  else root.setAttribute('data-text', ctx.state.text);
}

/* ── routing ────────────────────────────────────────────────────────────── */

function match(path) {
  if (ROUTES[path]) return { route: ROUTES[path], params: [] };
  for (const [pattern, route] of Object.entries(ROUTES)) {
    if (!pattern.includes(':')) continue;
    const p = pattern.split('/'), q = path.split('/');
    if (p.length !== q.length) continue;
    const params = [];
    const ok = p.every((seg, i) => {
      if (seg.startsWith(':')) { params.push(q[i]); return true; }
      return seg === q[i];
    });
    if (ok) return { route, params };
  }
  return { route: ROUTES['/'], params: [] };
}

const app = $('#app');

function render() {
  const path = (location.hash.slice(1) || '/').split('?')[0];
  const { route, params } = match(path);
  ctx.params = params;
  const isAdmin = PERSONAS[ctx.persona].role === 'admin';

  const body = el('main', {
    class: `page${path.startsWith('/admin') || path === '/usage' ? ' page--wide' : ''}`,
    id: 'main', tabindex: '-1',
  });

  // Rendered synchronously; the skeleton is here to show the shape a real
  // network round-trip would fill, not to fake a delay nobody asked for.
  try {
    body.replaceChildren(...[route.render(ctx)].flat().filter(Boolean));
  } catch (err) {
    body.replaceChildren(el('div', { class: 'banner banner--bad' },
      icon('alert', { size: 20 }),
      el('div', { class: 'banner__body' },
        el('strong', {}, 'This screen failed to draw.'),
        el('p', { class: 'small' }, String(err?.message ?? err)))));
  }

  // The tab bar goes BEFORE main in the document, not after it.
  //
  // On a phone it is position:fixed, which ignores document order entirely, so
  // it still draws at the bottom of the screen. On a wide window it becomes
  // position:sticky — and sticky sticks relative to where the element actually
  // sits in the flow, so appended last it parked below the content instead of
  // above it and was simply not there. Putting it here also places it next in
  // the tab order after the header, which is where it is looked for.
  // .filter(Boolean), because replaceChildren does NOT skip null the way our
  // el() helper does — it stringifies it, and a bare screen rendered the word
  // "null" above its own title.
  app.replaceChildren(...[
    navbar(route, path),
    route.bare ? null : tabbar(path, isAdmin),
    body,
  ].filter(Boolean));

  measureTabbar();

  // Focus the content on every navigation, so a keyboard or screen-reader
  // user is put where the new screen begins rather than back at the top of
  // the document. Scroll goes with it.
  if (ctx.state.keepFocus === 'search') {
    ctx.state.keepFocus = null;
    const s = $('#search'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  } else if (ctx.state.lastPath !== path) {
    window.scrollTo(0, 0);
    body.focus({ preventScroll: true });
  }
  ctx.state.lastPath = path;
}

function navbar(route, path) {
  const themeLabel = { auto: 'Match my phone', light: 'Light', dark: 'Dark' }[ctx.state.theme];
  return el('header', { class: 'navbar' },
    el('div', { class: 'navbar__side' },
      route.back
        ? el('a', { class: 'navbtn', href: route.back },
            el('span', { class: 'navbtn__chev' }, svg(I.back, { size: 18, width: 2.4 })), 'Back')
        : null),
    el('h1', { class: 'navbar__title' }, route.title),
    el('div', { class: 'navbar__side navbar__side--end' },
      el('button', {
        class: 'navbtn', type: 'button',
        'aria-label': `Appearance: ${themeLabel}. Change it.`,
        onclick: () => ctx.toggleTheme(),
      }, icon(ctx.state.theme === 'dark' ? 'moon' : 'sun', { size: 20 }))));
}

function tabbar(path, isAdmin) {
  const active = ROUTES[path]?.tab
    ?? (path.startsWith('/admin') ? 'admin' : path.startsWith('/notice') ? 'notices' : 'bill');
  return el('nav', { class: 'tabbar', id: 'tabbar', 'aria-label': 'Main' }, ...TABS
    .filter((t) => !t.adminOnly || isAdmin)
    .map((t) => {
      const n = t.badge?.() ?? 0;
      return el('a', {
        class: 'tab', href: t.href,
        'aria-current': t.id === active ? 'page' : null,
        'aria-label': n ? `${t.label}, ${n} new` : null,
      },
        el('span', { class: 'tab__icon' }, icon(t.ic, { size: 26 })),
        el('span', { class: 'tab__label' }, t.label),
        n ? el('span', { class: 'tab__badge', 'aria-hidden': 'true' }, String(n)) : null);
    }));
}

/**
 * Publishes the bar's real height so the page can reserve it.
 *
 * A hard-coded number is wrong the moment the text size changes or the phone
 * has a home indicator, and the symptom is the last row of every screen
 * hiding behind the bar — close enough to look deliberate, far enough to clip
 * a line of text.
 */
function measureTabbar() {
  const bar = $('#tabbar');
  const h = bar && getComputedStyle(bar).position === 'fixed'
    ? Math.round(bar.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--tabbar-h', `${h}px`);
}

/* ── go ─────────────────────────────────────────────────────────────────── */

applyChrome();
addEventListener('hashchange', render);
addEventListener('resize', measureTabbar);
render();

// The reviewer shell drives the frame from outside; let it in.
addEventListener('message', (e) => {
  if (e.data?.dp === 'theme') { ctx.state.theme = e.data.value; store.set('dp.theme', e.data.value); applyChrome(); render(); }
  if (e.data?.dp === 'text') { ctx.state.text = e.data.value; store.set('dp.text', e.data.value); applyChrome(); render(); }
  if (e.data?.dp === 'persona') { ctx.setPersona(e.data.value); render(); }
});
