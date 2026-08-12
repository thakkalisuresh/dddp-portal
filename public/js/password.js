/**
 * First login — screen 17's forced-change, widened into proper onboarding.
 *
 * A resident arrives with a temporary password and whatever name the roster
 * import guessed. This is the one moment they will reliably correct it, so we
 * ask for name, email and password together instead of a password alone.
 *
 * The mobile number is shown read-only: it is their login and the tie to the
 * flat. If it were wrong they could not have got here.
 */

import { api, ApiError } from './api.js';
import { $, el, showError, withReveal } from './ui.js';
import { ADMINISTRATOR } from './contact.js';

const main = $('#main');

init();

async function init() {
  try {
    const me = await api.me();
    // Someone who has already done this has no business on the page.
    if (!me.mustChangePassword) { location.href = '/dashboard'; return; }
    render(me);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login'; return; }
    showError(main, err);
  }
}

function render(me) {
  const status = el('div');
  const name = el('input', { class: 'input', id: 'name', value: me.name ?? '', autocomplete: 'name' });
  const email = el('input', { class: 'input', id: 'email', type: 'email', value: me.email ?? '',
                              autocomplete: 'email', inputmode: 'email' });
  const pw = el('input', { class: 'input', id: 'pw', type: 'password', autocomplete: 'new-password' });
  const pw2 = el('input', { class: 'input', id: 'pw2', type: 'password', autocomplete: 'new-password' });

  const submit = el('button', { class: 'btn btn--block btn--lg', type: 'submit' }, 'Finish setting up');

  const form = el('form', { class: 'stack', novalidate: true },
    status,

    el('div', { class: 'field' },
      el('label', { for: 'name' }, 'Your name'), name,
      el('span', { class: 'field__hint' }, 'As you would like it to appear to the committee.')),

    el('div', { class: 'field' },
      el('label', { for: 'email' }, 'Email (optional)'), email,
      // Optional, but not arbitrary: it is the only way to reset your own
      // password. Labelling it "optional" and saying nothing else is how a
      // building ends up with one person unlocking everybody's account.
      el('p', { class: 'small muted' },
        `Without one you will have to ask ${ADMINISTRATOR.name} to reset your password.`),
      el('span', { class: 'field__hint' }, 'Only used to send you a code if you forget your password.')),

    el('div', { class: 'field' },
      el('label', {}, 'Mobile number'),
      el('input', { class: 'input num', value: me.mobile ?? '', readonly: true }),
      el('span', { class: 'field__hint' },
        `This is your login and links you to flat ${me.flat}. If it is wrong, contact the treasurer.`)),

    el('div', { class: 'field' },
      el('label', { for: 'pw' }, 'New password'), withReveal(pw),
      el('span', { class: 'field__hint' }, 'At least 8 characters.')),

    el('div', { class: 'field' }, el('label', { for: 'pw2' }, 'Confirm password'), withReveal(pw2)),

    submit);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.replaceChildren();

    if (!name.value.trim()) return showError(status, { message: 'Please give your name.' });
    if (pw.value.length < 8) return showError(status, { message: 'Use at least 8 characters.' });
    // Checked here as well as server-side: a mistyped confirmation would
    // otherwise become a password they cannot reproduce.
    if (pw.value !== pw2.value) return showError(status, { message: 'Those two passwords do not match.' });

    submit.disabled = true;
    submit.textContent = 'Saving…';
    try {
      await api.onboard({ name: name.value, email: email.value, password: pw.value });
      // Completing setup ends every session, so a fresh login is required —
      // which is also the proof that the new password works.
      main.replaceChildren(
        el('div', { class: 'note note--good' },
          'All set. Please log in with your new password.'),
        el('a', { class: 'btn btn--block', href: '/login' }, 'Log in'));
    } catch (err) {
      submit.disabled = false;
      submit.textContent = 'Finish setting up';
      showError(status, err);
    }
  });

  main.replaceChildren(
    el('h1', {}, `Welcome, flat ${me.flat}`),
    el('p', { class: 'muted' },
      'A few details before you start. You can change any of them later.'),
    form);
}
