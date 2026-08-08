/**
 * Extracted from the page's inline <script>. The CSP is script-src 'self',
 * which blocks inline execution — and weakening it to 'unsafe-inline' to keep
 * four small blocks in place would defeat having a policy at all.
 */
import { api } from './api.js';
import { $, el, showError } from './ui.js';

const form = $('#form'), submit = $('#submit'), alertBox = $('#alert');

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    alertBox.replaceChildren();
    const pw = $('#pw').value, pw2 = $('#pw2').value;

    if (pw.length < 8) return showError(alertBox, { message: 'Use at least 8 characters.' });
    // Checked here as well as server-side: a mistyped confirmation should be
    // caught before it becomes a password the resident cannot reproduce.
    if (pw !== pw2) return showError(alertBox, { message: 'Those two passwords do not match.' });

    submit.disabled = true;
    submit.textContent = 'Saving…';
    try {
      // The server ends every session on a password change, so a fresh login
      // is required — which is also the confirmation that it worked.
      await api.changePassword('', pw);
      $('#main').replaceChildren(
        el('div', { class: 'note note--good' }, 'Password changed. Please log in with it.'),
        el('a', { class: 'btn btn--block', href: '/login.html' }, 'Log in'));
    } catch (err) {
      submit.disabled = false;
      submit.textContent = 'Continue';
      showError(alertBox, err);
    }
});
