/**
 * Self-service password reset.
 *
 * Two steps on one page rather than two pages, because the mobile number has
 * to survive into the second step and a page boundary would mean either
 * carrying it in the URL — where it does not belong — or asking for it twice.
 *
 * The first step's reply is deliberately identical whether or not the account
 * exists, so this screen cannot say "no such resident" even when it is true.
 * That means the copy has to leave room for the possibility that the number
 * was mistyped, which is what "if that number belongs to a resident" does.
 */

import { api, ApiError } from './api.js';
import { $, el, showError, withReveal } from './ui.js';
import { TREASURER } from './contact.js';

const ask = $('#ask');
const finish = $('#finish');
const alertBox = $('#alert');

/** Held in memory across the two steps; never put in the URL. */
let mobile = '';

function note(text, tone = '') {
  alertBox.replaceChildren(el('div', { class: `note ${tone}` }, text));
}

/* ── step 1: ask for a code ──────────────────────────────────────────────── */

ask.addEventListener('submit', async (event) => {
  event.preventDefault();
  alertBox.replaceChildren();

  const entered = $('#mobile').value.trim();
  if (!entered) {
    showError(alertBox, { message: 'Enter your mobile number.' });
    return;
  }

  const button = $('#askSubmit');
  button.disabled = true;
  button.textContent = 'Sending…';

  try {
    const res = await api.forgot(entered);
    mobile = entered;
    ask.hidden = true;
    finish.hidden = false;
    $('#fallback').hidden = true;
    $('#sentTo').textContent = res.message;
    note('Check your email. The code lasts 15 minutes.');
    $('#code').focus();
  } catch (err) {
    // Rate limiting is the one failure the server does report, since it says
    // nothing about whether the account exists.
    showError(alertBox, err);
    button.disabled = false;
    button.textContent = 'Email me a code';
  }
});

/* ── step 2: code plus new password ──────────────────────────────────────── */

finish.addEventListener('submit', async (event) => {
  event.preventDefault();
  alertBox.replaceChildren();

  const code = $('#code').value.trim();
  const password = $('#password').value;

  if (code.replace(/\D/g, '').length !== 6) {
    showError(alertBox, { message: 'The code is six digits.' });
    return;
  }
  if (password.length < 8) {
    showError(alertBox, { message: 'Use at least 8 characters.' });
    return;
  }

  const button = $('#finishSubmit');
  button.disabled = true;
  button.textContent = 'Setting…';

  try {
    await api.reset(mobile, code, password);
    // Straight to login rather than logging them in: they have just chosen a
    // password, and typing it once proves it is the one they think it is.
    finish.hidden = true;
    note('Password changed. You can log in now.', 'note--good');
    alertBox.append(el('p', { class: 'stack' },
      el('a', { class: 'btn btn--block btn--lg', href: '/login' }, 'Log in')));
  } catch (err) {
    showError(alertBox, err);
    button.disabled = false;
    button.textContent = 'Set my password';
    // The code is cleared and the password kept: a wrong code is the likely
    // fault, and making someone retype a long password they got right is
    // how a reset flow gets abandoned.
    $('#code').value = '';
    $('#code').focus();
  }
});

$('#again').addEventListener('click', async () => {
  alertBox.replaceChildren();
  try {
    await api.forgot(mobile);
    note('A new code is on its way. The previous one no longer works.');
    $('#code').value = '';
    $('#code').focus();
  } catch (err) {
    showError(alertBox, err);
  }
});

// Filled in rather than written into the HTML, so the number lives in one place.
const slot = $('#treasurer');
if (slot) slot.textContent = `${TREASURER.name} on ${TREASURER.phone}`;

// Wrap the password field so it can be revealed. Done here rather than in the
// HTML because the CSP forbids inline script, and the control needs a listener.
for (const id of ['password']) {
  const field = $('#' + id);
  if (field && !field.closest('.reveal-wrap')) withReveal(field);
}
