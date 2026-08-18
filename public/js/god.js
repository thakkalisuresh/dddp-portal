/**
 * God mode — the usage dashboard, then everything that has happened.
 *
 * The dashboard came second and sits first: the log answers "what happened to
 * 4A on Tuesday", and the question actually being asked of this page most days
 * is "is anyone using the portal at all". See js/god-dash.js.
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
import { renderDashboard } from './god-dash.js';
import { renderNav } from './nav.js';
import { trackPage, trackAction } from './track.js';
import { $, el, esc, renderViewBanner, showError, setChildren, askFirst } from './ui.js';

const main = $('#main');
let filters = { flat: '', kind: '', q: '', since: '' };

// Built once and moved between renders rather than rebuilt with them. Typing in
// the timeline search re-renders the page on every keystroke, and a dashboard
// rebuilt each time would re-run its aggregate query on every letter.
let dash = null;

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
    renderViewBanner(me, { onExit: async () => { await api.god.exit(); location.reload(); } });
    renderNav(me, '/god');
    dash = renderDashboard();
    await load();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login'; return; }
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
    dash,
    controls(),
    el('p', { class: 'label', style: 'padding-top:var(--s-4)' }, 'Activity log'),
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
          ? (state.expiresAt
              ? `Click capture is ON until ${state.expiresAt}.`
              : 'Click capture is ON and stays on until you turn it off.')
          : 'Click capture is off. It records which controls people press, '
            + 'never what they type, and never a password field.'),
      el('div', { class: 'row' },
        el('button', {
          class: state.on ? 'btn btn--sm btn--quiet' : 'btn btn--sm', type: 'button',
          // A plain switch — no window. It stays on until turned off.
          onclick: async () => { await api.god.setCapture(!state.on); location.reload(); },
        }, state.on ? 'Turn capture OFF' : 'Turn capture ON'),
        el('a', { class: 'btn btn--sm btn--quiet', href: '/god-clicks' }, 'View clicks')),
      el('hr', { class: 'rule' }),
      el('p', { class: 'label' }, 'Download'),
      el('div', { class: 'row' },
        el('a', { class: 'btn btn--sm btn--quiet', href: '/api/god/export?what=timeline', download: '' },
          'Activity CSV'),
        el('a', { class: 'btn btn--sm btn--quiet', href: '/api/god/export?what=clicks', download: '' },
          'Clicks CSV')),

      el('hr', { class: 'rule' }),
      el('p', { class: 'label' }, 'View as a resident'),
      el('p', { class: 'small muted' },
        'Read-only opens their dashboard without touching their account. '
        + 'Impersonating issues a real session. The amber banner stays up until you exit.'),
      spoofControl(status),

      el('hr', { class: 'rule' }),
      el('p', { class: 'small muted' },
        'There is exactly one superadmin. The role moves, it is never copied: '
        + 'handing it over makes you an admin.'),
      handoverControl(status));
  }).catch(() => {});

  return box;
}

/**
 * The spoofing control (plan §5.5). Read-only is the default and the safe path:
 * no session is issued and nothing is written to the resident's record.
 */
function spoofControl(status) {
  const picker = el('select', { class: 'input', style: 'max-width:260px' },
    el('option', { value: '' }, 'Choose a resident…'));

  api.god.residents().then(({ residents }) => {
    for (const r of residents) {
      picker.append(el('option', { value: String(r.id), 'data-flat': r.flat },
        `${r.flat} · ${r.name}`));
    }
  }).catch(() => {});

  const chosen = () => picker.options[picker.selectedIndex];

  return el('div', { class: 'stack', style: 'gap:var(--s-2)' }, picker,
    el('div', { class: 'row', style: 'flex-wrap:wrap' },
      el('button', {
        class: 'btn btn--sm btn--ghost', type: 'button',
        onclick: async () => {
          const opt = chosen();
          if (!opt?.value) return;
          try {
            const r = await api.god.viewAs(opt.dataset.flat);
            status.replaceChildren(el('div', { class: 'note note--good' },
              `${r.subject.flat} · ${r.subject.name} — ${r.subject.mobile ?? 'no mobile'} · `
              + `${r.subject.email ?? 'no email'}. Read-only; nothing was changed.`));
          } catch (err) { showError(status, err); }
        },
      }, 'View read-only'),
      el('button', {
        class: 'btn btn--sm', type: 'button',
        onclick: async () => {
          const opt = chosen();
          if (!opt?.value) return;
          if (!await askFirst(status,
            `Open the portal AS ${opt.textContent}? You will see exactly what they see. `
            + 'The amber banner stays up until you exit.', 'Yes, view as them')) return;
          try {
            await api.god.impersonate(Number(opt.value), false);
            location.href = '/dashboard';
          } catch (err) { showError(status, err); }
        },
      }, 'Impersonate (read-only)')));
}

function handoverControl(status) {
  const id = el('input', { class: 'input num', placeholder: 'resident id', style: 'max-width:160px' });
  return el('div', { class: 'row' }, id,
    el('button', {
      class: 'btn btn--sm btn--quiet', type: 'button',
      onclick: async () => {
        // The one on this page that cannot be undone from this page: after it
        // succeeds the button is gone with the rest of the screen.
        if (!await askFirst(status,
          'Hand superadmin to this resident? You become an admin and lose this page.',
          'Yes, hand it over')) return;
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
