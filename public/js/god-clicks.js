/**
 * Extracted from the page's inline <script>. The CSP is script-src 'self',
 * which blocks inline execution — and weakening it to 'unsafe-inline' to keep
 * four small blocks in place would defeat having a policy at all.
 */
import { api } from './api.js';
import { $, el, showError, setChildren } from './ui.js';

const main = $('#main');
try {
    const state = await api.captureState();
    const { clicks } = await api.god.clicks();
    setChildren(main,
      el('div', { class: 'panel', style: 'padding:var(--s-4)' },
        el('h1', {}, 'Click capture'),
        el('p', { class: 'small muted' },
          state.on ? `Recording until ${state.expiresAt}.` : 'Not currently recording.'),
        el('p', { class: 'small muted' },
          `${clicks.length} events. Field values are never recorded. An input shows its `
          + 'identity only, and a password field is dropped entirely.')),
      ...(clicks.length
        ? clicks.map((c) => el('div', { class: 'c' },
            el('span', { class: 'c__at' }, c.atIST),
            el('span', {}, `${c.flat ?? '—'} · ${c.name ?? ''}`),
            el('div', {},
              el('span', {}, c.label ?? '(no label)'),
              el('div', { class: 'c__target' }, `${c.page} · ${c.target}`))))
        : [el('p', { class: 'muted', style: 'padding:var(--s-4)' }, 'Nothing captured.')]));
} catch (err) { showError(main, err); }
