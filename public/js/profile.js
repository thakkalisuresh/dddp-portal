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
import { $, el, esc, renderViewBanner, showError, withReveal } from './ui.js';
import { checkPassword, describePolicy } from './password-rules.js';

const main = $('#main');

trackPage('/profile');
init();

async function init() {
  try {
    const me = await api.me();
    $('#who').innerHTML = `Flat ${esc(me.flat)} <span>· ${esc(me.name)}</span>`;
    renderViewBanner(me, { onExit: async () => { await api.god.exit(); location.reload(); } });
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
  // Typed twice for the same reason as onboarding: a password change ends
  // every session, so the next thing that happens is a login with a password
  // they only ever typed once. A mistyped one is not discovered here — it is
  // discovered at the login screen, by someone who now cannot get in.
  const next2 = el('input', { class: 'input', id: 'new2', type: 'password', autocomplete: 'new-password' });

  main.replaceChildren(
    el('h1', {}, 'My details'),
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
    el('p', { class: 'label' }, 'Change password'),
    pwStatus,
    el('div', { class: 'field' }, el('label', { for: 'cur' }, 'Current password'), withReveal(current)),
    el('div', { class: 'field' },
      el('label', { for: 'new' }, 'New password'), withReveal(next),
      // An admin sees the stricter rule here, because `me.role` is their own.
      el('span', { class: 'field__hint' }, describePolicy(me.role))),
    el('div', { class: 'field' },
      el('label', { for: 'new2' }, 'Confirm new password'), withReveal(next2)),
    el('button', {
      class: 'btn btn--ghost', type: 'button',
      onclick: async () => {
        // The stored name and email, not the fields above: those edit the
        // profile through a different button and may be unsaved.
        const weak = checkPassword(next.value, me);
        if (weak) return showError(pwStatus, { message: weak.message });
        if (next.value !== next2.value) {
          return showError(pwStatus, { message: 'Those two passwords do not match.' });
        }
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
