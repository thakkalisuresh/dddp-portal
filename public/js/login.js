/**
 * Extracted from the page's inline <script>. The CSP is script-src 'self',
 * which blocks inline execution — and weakening it to 'unsafe-inline' to keep
 * four small blocks in place would defeat having a policy at all.
 */
import { api } from './api.js';
import { $, showError } from './ui.js';
import { TREASURER } from './contact.js';

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
      const result = await api.login(mobile, password);
      // A temporary password must be replaced before anything else is reachable.
      location.href = result.mustChangePassword ? '/password' : '/dashboard';
    } catch (err) {
      showError(alertBox, err);
      submit.disabled = false;
      submit.textContent = 'Log in';
      $('#password').value = '';
      $('#password').focus();
    }
});

// Filled in rather than written into login.html, so the treasurer's number
// lives in exactly one place (js/contact.js) and cannot go stale here.
const contact = document.getElementById('treasurer');
if (contact) {
  contact.replaceChildren(
    Object.assign(document.createElement('strong'), {
      textContent: `${TREASURER.name} (${TREASURER.role})`,
    }),
    document.createTextNode(', '),
    Object.assign(document.createElement('span'), {
      className: 'num', textContent: TREASURER.phone,
    })
  );
}
