/**
 * Extracted from the page's inline <script>. The CSP is script-src 'self',
 * which blocks inline execution — and weakening it to 'unsafe-inline' to keep
 * four small blocks in place would defeat having a policy at all.
 */
import { api } from './api.js';
import { $, el, showError, withReveal } from './ui.js';
import { applyCountryHint, showCountryHint, rememberFormatKnown } from './country-hint.js';

const form = $('#form');
const submit = $('#submit');
const alertBox = $('#alert');

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alertBox.replaceChildren();

    const mobile = $('#mobile').value.trim();
    const password = $('#password').value;
    if (!mobile || !password) {
      showError(alertBox, { message: 'Enter your mobile number and password.' });
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Logging in…';
    try {
      const result = await api.login(mobile, password, $('#remember')?.checked !== false);
      // They typed a number this server recognises, so the country-code hint has
      // nothing left to teach this browser. Set before the redirect: the page is
      // about to be replaced.
      rememberFormatKnown();
      // A temporary password must be replaced before anything else is reachable.
      location.href = result.mustChangePassword ? '/password' : '/dashboard';
    } catch (err) {
      showError(alertBox, err);
      // Wherever they are. The timezone guess below misses an owner abroad on a
      // device still set to Kolkata, and a failed attempt is the moment the hint
      // is worth most — it is the one signal that beats guessing.
      showCountryHint();
      submit.disabled = false;
      submit.textContent = 'Log in';
      $('#password').value = '';
      $('#password').focus();
    }
});

applyCountryHint();

// Wrap the password field so it can be revealed. Done here rather than in the
// HTML because the CSP forbids inline script, and the control needs a listener.
for (const id of ['password']) {
  const field = $('#' + id);
  if (field && !field.closest('.reveal-wrap')) withReveal(field);
}
