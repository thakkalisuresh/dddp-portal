/**
 * Resident profile — screen 17.
 *
 * Mobile is read-only with the reason stated inline. It is both the login id
 * and the tie to the flat, so a resident editing it invites lockouts and
 * takeover by typo (plan §4b).
 */

import { api, ApiError } from './api.js';
import { renderNav } from './nav.js';
import { trackPage } from './track.js';
import { $, el, esc, renderGodBanner, showError, withReveal } from './ui.js';
import { bilingual } from './i18n.js';

const main = $('#main');

trackPage('/profile');
init();

async function init() {
  try {
    const me = await api.me();
    $('#who').innerHTML = `Flat ${esc(me.flat)} <span>· ${esc(me.name)}</span>`;
    renderGodBanner(me, { onExit: async () => { await api.god.exit(); location.reload(); } });
    renderNav(me, '/profile');
    render(me);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login'; return; }
    showError(main, err);
  }
}

function render(me) {
  const status = el('div');
  const name = el('input', { class: 'input', id: 'name', value: me.name ?? '', autocomplete: 'name' });
  const email = el('input', { class: 'input', id: 'email', type: 'email', value: me.email ?? '', autocomplete: 'email' });

  const pwStatus = el('div');
  const current = el('input', { class: 'input', id: 'cur', type: 'password', autocomplete: 'current-password' });
  const next = el('input', { class: 'input', id: 'new', type: 'password', autocomplete: 'new-password' });

  main.replaceChildren(
    el('h1', { html: bilingual('myDetails') }),
    status,
    // Apartment, floor, and whether you own or rent. There is no confirmation
    // step in onboarding by design, so this line IS how a wrong roster entry
    // gets noticed — by the one person who knows it is wrong.
    el('div', { class: 'field' },
      el('label', {}, 'Apartment'),
      el('input', {
        class: 'input', readonly: true,
        value: me.floor != null ? `${me.flat} (Floor ${me.floor})` : me.flat,
      }),
      el('span', { class: 'field__hint' },
        `${me.tenancy?.description ?? ''}. If that is wrong, tell an admin.`)),
    el('div', { class: 'field' }, el('label', { for: 'name' }, 'Name'), name),
    el('div', { class: 'field' }, el('label', { for: 'email' }, 'Email'), email),
    el('div', { class: 'field' },
      el('label', {}, 'Mobile number'),
      el('input', { class: 'input num', value: me.mobile ?? '', readonly: true }),
      el('span', { class: 'field__hint' },
        `This is your login and links you to flat ${me.flat}. To change it, contact the treasurer.`)),
    el('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        try {
          await api.updateProfile(name.value, email.value);
          status.replaceChildren(el('div', { class: 'note note--good' }, 'Saved.'));
        } catch (err) { showError(status, err); }
      },
    }, 'Save'),

    el('hr', { class: 'rule' }),
    el('p', { class: 'label', html: bilingual('changePassword') }),
    pwStatus,
    el('div', { class: 'field' }, el('label', { for: 'cur' }, 'Current password'), withReveal(current)),
    el('div', { class: 'field' }, el('label', { for: 'new' }, 'New password'), withReveal(next)),
    el('button', {
      class: 'btn btn--ghost', type: 'button',
      onclick: async () => {
        try {
          await api.changePassword(current.value, next.value);
          // Every session ends on a password change, so send them to log in
          // again rather than leaving a page that will 401 on its next call.
          location.href = '/login';
        } catch (err) { showError(pwStatus, err); }
      },
    }, 'Change password'),
    el('p', { class: 'small muted' }, "You'll be signed out on every device.")
  );
}
