/**
 * The activity log — everything that has happened, newest first.
 *
 * Superadmin only. Actions, page views and errors are merged into one
 * timeline, because "what happened to this resident on Tuesday" is a question
 * that spans all three and is unanswerable if they live in separate screens.
 *
 * Clicks are recorded only while capture is switched on, and live on their own
 * page. Keystrokes, scrolling and mouse movement are never recorded at all.
 * See docs/PRIVACY.md — the people this records live in the same building as
 * the people who can read it.
 */

import { api, ApiError } from './api.js';
import { trackPage, trackAction } from './track.js';
import { $, el, esc, renderGodBanner, showError, setChildren } from './ui.js';

const main = $('#main');
let filters = { flat: '', kind: '', q: '', since: '' };

trackPage('/god');
init();

async function init() {
  try {
    const me = await api.me();
    if (me.role !== 'superadmin') {
      main.replaceChildren(el('div', { class: 'note note--bad' }, 'Superadmin only.'));
      return;
    }
    $('#who').innerHTML = `God mode <span>· ${esc(me.name)}</span>`;
    renderGodBanner(me, { onExit: async () => { await api.god.exit(); location.reload(); } });
    await load();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login.html'; return; }
    showError(main, err);
  }
}

async function load() {
  const params = new URLSearchParams();
  if (filters.flat) params.set('flat', filters.flat.toUpperCase());
  if (filters.since) params.set('since', filters.since);
  params.set('limit', '400');

  // Reading the log is itself an act worth recording — a superadmin browsing
  // residents' activity should leave the same trail as anyone else.
  trackAction('god:timeline', { flat: filters.flat || 'all', kind: filters.kind || 'all' });
  const { timeline, generatedAt } = await api.god.timeline(`?${params}`);
  render(timeline, generatedAt);
}

function render(rows, generatedAt) {
  const visible = rows.filter((r) => {
    if (filters.kind && r.kind !== filters.kind) return false;
    if (filters.q) {
      const hay = `${r.name} ${r.actor ?? ''} ${r.subject ?? ''} ${r.detail ?? ''}`.toLowerCase();
      if (!hay.includes(filters.q.toLowerCase())) return false;
    }
    return true;
  });

  setChildren(main,
    controls(),
    filterBar(),
    el('div', { class: 'panel', style: 'padding:var(--s-3) var(--s-4)' },
      el('p', { class: 'small muted' },
        `${visible.length} of ${rows.length} events · all times IST · generated ${generatedAt}`)),
    ...(visible.length
      ? visible.map(eventRow)
      : [el('p', { class: 'muted', style: 'padding:var(--s-4)' }, 'Nothing matches those filters.')])
  );
}

/** Click capture and the superadmin handover — the two switches only you hold. */
function controls() {
  const status = el('div');
  const box = el('details', { class: 'panel', style: 'padding:var(--s-3) var(--s-4)' },
    el('summary', { style: 'font-family:var(--font-ui);cursor:pointer' }, 'Controls'),
    el('div', { class: 'stack', style: 'margin-top:var(--s-3)' }, status));

  const body = box.querySelector('.stack');

  api.captureState().then((state) => {
    setChildren(body,
      status,
      el('p', { class: 'small muted' },
        state.on
          ? `Click capture is ON until ${state.expiresAt}. It switches itself off then.`
          : 'Click capture is off. Turn it on only to chase a specific problem — '
            + 'it records which controls people press, never what they type.'),
      el('div', { class: 'row' },
        el('button', {
          class: state.on ? 'btn btn--sm btn--quiet' : 'btn btn--sm', type: 'button',
          onclick: async () => {
            await api.god.setCapture(!state.on, 2);
            location.reload();
          },
        }, state.on ? 'Turn capture off' : 'Turn on for 2 hours'),
        state.on
          ? el('a', { class: 'btn btn--sm btn--quiet', href: '/god-clicks.html' }, 'View clicks')
          : null),
      el('hr', { class: 'rule' }),
      el('p', { class: 'small muted' },
        'There is exactly one superadmin. The role can only be moved, never copied — '
        + 'handing it over makes you an admin.'),
      handoverControl(status));
  }).catch(() => {});

  return box;
}

function handoverControl(status) {
  const id = el('input', { class: 'input num', placeholder: 'resident id', style: 'max-width:160px' });
  return el('div', { class: 'row' }, id,
    el('button', {
      class: 'btn btn--sm btn--quiet', type: 'button',
      onclick: async () => {
        if (!confirm('Hand superadmin to this resident? You become an admin and lose this page.')) return;
        try {
          const r = await api.god.handover(Number(id.value));
          status.replaceChildren(el('div', { class: 'note note--warn' },
            `Superadmin moved from ${r.from} to ${r.to}. ${r.note}`));
        } catch (err) { showError(status, err); }
      },
    }, 'Hand over superadmin'));
}

function filterBar() {
  const flat = el('input', { class: 'input', value: filters.flat, placeholder: 'e.g. 4A', id: 'f-flat' });
  const since = el('input', { class: 'input num', value: filters.since, placeholder: 'YYYY-MM-DD', id: 'f-since' });
  const q = el('input', { class: 'input', value: filters.q, placeholder: 'login, proof, DDP-…', id: 'f-q' });

  const kind = el('select', { class: 'input', id: 'f-kind' },
    ...[['', 'Everything'], ['action', 'Actions'], ['page', 'Page views'],
        ['error', 'Server errors'], ['client-error', 'Browser errors']]
      .map(([value, label]) =>
        el('option', { value, selected: filters.kind === value || null }, label)));

  const apply = async () => {
    filters = { flat: flat.value.trim(), kind: kind.value, q: q.value.trim(), since: since.value.trim() };
    await load();
  };

  // Text and type filter locally; flat and date re-query, because they change
  // which rows the database returns at all.
  q.addEventListener('input', () => { filters.q = q.value; load(); });
  kind.addEventListener('change', apply);

  return el('div', { class: 'filters' },
    el('div', { class: 'field' }, el('label', { for: 'f-flat' }, 'Flat'), flat),
    el('div', { class: 'field' }, el('label', { for: 'f-kind' }, 'Type'), kind),
    el('div', { class: 'field' }, el('label', { for: 'f-since' }, 'Since'), since),
    el('div', { class: 'field', style: 'flex:1 1 200px' }, el('label', { for: 'f-q' }, 'Search'), q),
    el('button', { class: 'btn btn--sm', type: 'button', onclick: apply }, 'Apply'));
}

function eventRow(r) {
  const who = r.actor && r.subject && r.actor !== r.subject
    // Under god mode these differ, and that difference is the whole point of
    // keeping actor and subject apart in the session.
    ? `${r.actor} → ${r.subject}`
    : (r.subject ?? r.actor ?? 'system');

  return el('div', { class: 'ev' },
    el('span', { class: 'ev__at' }, r.atIST ?? r.at),
    el('span', { class: `ev__kind ev__kind--${r.kind}` }, r.kind === 'client-error' ? 'browser' : r.kind),
    el('div', {},
      el('span', { class: 'ev__name' }, r.name),
      el('span', { class: 'muted' }, ` · ${who}`),
      r.detail ? el('div', { class: 'ev__detail' }, String(r.detail).slice(0, 300)) : null));
}
