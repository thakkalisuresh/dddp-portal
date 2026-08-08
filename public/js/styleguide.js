/**
 * Extracted from the page's inline <script>. The CSP is script-src 'self',
 * which blocks inline execution — and weakening it to 'unsafe-inline' to keep
 * four small blocks in place would defeat having a policy at all.
 */
import { renderGodBanner } from './ui.js';
import { money, periodLabel, dayLabel } from './i18n.js';

let on = false;
document.getElementById('demo').addEventListener('click', () => {
    on = !on;
    renderGodBanner(
      on ? { name: 'Sabarish Nair', flat: '4A', impersonation: { active: true, canWrite: false } } : null,
      { onExit: () => { on = false; renderGodBanner(null); }, onAllowWrites: () => {} }
    );
    if (on) window.scrollTo({ top: 0, behavior: 'smooth' });
});

// smoke-check the formatters render as expected
console.log('money', money(329.04), 'period', periodLabel('2026-07'), 'day', dayLabel('2026-08-10'));
