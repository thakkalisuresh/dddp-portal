/**
 * Meter reading entry — screen 07, and the one that decides whether the
 * treasurer adopts this at all. Someone enters ~52 readings standing in a
 * corridor holding a phone.
 *
 * The header states BOTH months on purpose: they walk the building in July and
 * enter June's readings (plan §3a). Getting that wrong slips the whole year.
 */

import { api, ApiError } from './api.js';
import { renderNav } from './nav.js';
import { trackPage } from './track.js';
import { $, el, esc, renderGodBanner, showError, setChildren } from './ui.js';
import { money, kg, periodLabel } from './i18n.js';

/** Mirrors JUMP_MULTIPLE in functions/lib/admin.js. */
const JUMP_MULTIPLE = 3;

const main = $('#main');
const params = new URLSearchParams(location.search);
let period = params.get('period');
let grid = null;
const pending = new Map();   // flat -> reading, queued while offline

trackPage('/admin/readings');
init();

async function init() {
  try {
    const me = await api.me();
    $('#who').innerHTML = `Admin <span>· ${esc(me.name)}</span>`;
    $('#logout').addEventListener('click', async () => {
      await api.logout().catch(() => {});
      location.href = '/login';
    });
    renderGodBanner(me, { onExit: async () => { await api.god.exit(); location.reload(); } });
    renderNav(me, '/admin/readings');

    if (!period) { period = defaultPeriod(); }
    await load();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login'; return; }
    showError(main, err);
  }
}

/** Readings entered this month close LAST month's usage. */
function defaultPeriod() {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function load() {
  grid = await api.admin.readings(period);
  render();
}

const previewPanel = el('div', { class: 'previewpanel' });

function render() {
  setChildren(main,
    header(),
    importPanel(),
    el('div', { class: 'scroll-x' }, table()),
    // The preview is a normal block, NOT part of the sticky bar: when it grew
    // it covered the last flats in the building, which is precisely where an
    // unentered reading hides.
    previewPanel,
    footbar()
  );
}

/** Keep the counter honest as rows save — it is the treasurer's sense of progress. */
function refreshProgress() {
  const entered = [...main.querySelectorAll('[data-flat]')]
    .filter((i) => i.value !== '' && !i.classList.contains('input--error')).length;
  const fill = main.querySelector('.progress__fill');
  const label = main.querySelector('.progress__label');
  if (fill) fill.style.width = `${grid.total ? Math.round((entered / grid.total) * 100) : 0}%`;
  if (label) label.textContent = `${entered} of ${grid.total} entered`;
}

function header() {
  const pct = grid.total ? Math.round((grid.entered / grid.total) * 100) : 0;
  return el('div', { class: 'gridhead' },
    el('div', { class: 'stack', style: 'gap:var(--s-1)' },
      el('h2', {}, `${periodLabel(grid.period)} readings`),
      // Stating both months is not redundancy — it is the difference between a
      // correct year and one that is silently a month out.
      el('p', { class: 'small muted' },
        `Meters read in ${periodLabel(grid.readMonth)} · closes ${periodLabel(grid.period)}'s gas`),
      grid.rate == null
        ? el('p', { class: 'small', style: 'color:var(--overdue);font-family:var(--font-ui)' },
            'Set this month\u2019s rate before generating.')
        : el('p', { class: 'small muted' },
            `Rate ₹${grid.rate.toFixed(2)} / kg · ${grid.conversionFactor} kg per unit`)),
    el('div', { class: 'progress' },
      el('span', { class: 'progress__track' },
        el('span', { class: 'progress__fill', style: `width:${pct}%` })),
      el('span', { class: 'progress__label' }, `${grid.entered} of ${grid.total} entered`))
  );
}

function importPanel() {
  const box = el('textarea', {
    id: 'paste', placeholder: '4A\t5.817\n4B\t2.940\n…', 'aria-label': 'Paste readings',
  });
  const out = el('div', { class: 'small muted', style: 'margin-top:var(--s-2)' });

  return el('details', { class: 'import' },
    el('summary', { style: 'font-family:var(--font-ui);cursor:pointer' },
      'Paste readings from a spreadsheet'),
    el('div', { class: 'stack', style: 'margin-top:var(--s-3)' },
      box,
      el('div', { class: 'row' },
        el('button', {
          class: 'btn btn--sm btn--ghost', type: 'button',
          onclick: async () => {
            out.textContent = 'Reading…';
            const parsed = await api.admin.parseReadings(box.value);
            // Parsed values fill the grid as a DRAFT. Nothing is written until
            // Save — one transposed column would otherwise mis-bill everyone.
            for (const row of parsed.rows) {
              const input = main.querySelector(`[data-flat="${CSS.escape(row.flat)}"]`);
              if (input) { input.value = row.reading; input.dispatchEvent(new Event('change')); }
            }
            out.replaceChildren(
              el('span', {}, `${parsed.rows.length} filled in as a draft. `),
              parsed.errors.length
                ? el('strong', { style: 'color:var(--overdue)' },
                    `${parsed.errors.length} could not be read: ` +
                    parsed.errors.map((e) => `${e.flat ?? '?'} (${e.reason})`).join(', '))
                : el('span', { style: 'color:var(--accent)' }, 'Nothing skipped.')
            );
          },
        }, 'Fill the grid'),
        out))
  );
}

function table() {
  return el('table', { class: 'grid' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Flat'),
      el('th', {}, 'Previous'),
      el('th', {}, 'Reading'),
      el('th', {}, 'Used'),
      el('th', {}, ''))),
    el('tbody', {}, ...grid.flats.map(row))
  );
}

function row(f) {
  // Validation message and save indicator are separate elements. Sharing one
  // cell meant "saved" overwrote "unusually high" — flagging the value amber
  // while deleting the sentence explaining why.
  const message = el('span', { class: 'msg__text' });
  const saved = el('span', { class: 'msg__saved' });
  const status = el('td', { class: 'msg' }, message, saved);
  const used = el('td', { class: 'used muted' }, f.consumption == null ? '—' : kg(f.consumption));

  const input = el('input', {
    class: 'input cell num', type: 'text', inputmode: 'decimal',
    'data-flat': f.flat, value: f.reading ?? '',
    'aria-label': `Reading for flat ${f.flat}`,
  });

  const validate = () => {
    const value = Number(input.value);
    input.classList.remove('input--error', 'input--warn');
    message.className = 'msg__text';
    message.textContent = '';
    used.textContent = '—';

    if (input.value === '') { refreshProgress(); return null; }
    if (!Number.isFinite(value)) {
      input.classList.add('input--error');
      message.classList.add('msg--error');
      message.textContent = 'Not a number';
      return null;
    }
    if (f.previous != null && value < f.previous) {
      // Blocked inline, with last month's value shown — meters don't run back.
      input.classList.add('input--error');
      message.classList.add('msg--error');
      message.textContent = `Lower than last month (${f.previous})`;
      return null;
    }
    if (f.previous != null) {
      const consumption = Math.round((value - f.previous) * grid.conversionFactor * 100) / 100;
      used.textContent = kg(consumption);
      // Compare against this flat's own history, as the value is typed — a
      // transposed digit should be questioned before it is saved, not after.
      if (f.average != null && consumption > f.average * JUMP_MULTIPLE) {
        input.classList.add('input--warn');
        message.classList.add('msg--warn');
        message.textContent = `Unusually high. Usually about ${kg(f.average)}`;
      }
    }
    return value;
  };

  input.addEventListener('change', () => {
    const value = validate();
    if (value == null) return;
    pending.set(f.flat, value);
    refreshProgress();
    save(f.flat, saved);
  });

  if (f.reading != null) validate();

  return el('tr', {},
    el('td', { class: 'flat' }, f.flat),
    el('td', { class: 'prev' }, f.previous == null ? '—' : f.previous),
    el('td', {}, input),
    used,
    status);
}

/** Autosave per row. A corridor is a dead spot, so failures queue and retry. */
async function save(flat, saved) {
  try {
    await api.admin.saveReadings(period, [{ flat, reading: pending.get(flat) }]);
    pending.delete(flat);
    saved.className = 'msg__saved msg--ok';
    saved.textContent = '\u2713 saved';
  } catch {
    saved.className = 'msg__saved msg--warn';
    saved.textContent = 'saved on this phone \u00b7 will sync';
  }
}

function footbar() {
  const generate = el('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      previewPanel.replaceChildren(el('p', { class: 'small muted' }, 'Checking…'));
      try {
        const p = await api.admin.preview(period);
        previewPanel.replaceChildren(previewSummary(p));
      } catch (err) {
        showError(previewPanel, err);
      }
      previewPanel.scrollIntoView({ block: 'nearest' });
    },
  }, 'Check this month');

  return el('div', { class: 'footbar' },
    el('button', {
      class: 'btn btn--quiet', type: 'button',
      onclick: () => api.admin.downloadTemplate(period, grid),
    }, 'Download template'),
    el('span', { class: 'spacer' }),
    generate);
}

function previewSummary(p) {
  const blocked = p.blocked.length;
  const missing = p.missing ?? 0;

  if (!p.canGenerate) {
    return el('div', { class: 'note note--bad' },
      blocked ? `${blocked} reading${blocked > 1 ? 's' : ''} need fixing. ` : '',
      missing ? `${missing} flat${missing > 1 ? 's' : ''} still empty. ` : '',
      !p.rateSanity.ok ? 'Set this month\'s rate. ' : '');
  }

  return el('div', { class: 'stack', style: 'gap:var(--s-2)' },
    el('div', { class: 'note note--good' },
      el('div', {}, `${p.willBill} flats · ${kg(p.totalKg)} · rate ₹${p.ratePerKg.toFixed(2)}`),
      el('strong', { style: 'font-size:var(--text-md)' }, `Total ${money(p.totalAmount)}`),
      el('div', { class: 'small' },
        'Check this against the supplier invoice before generating.')),
    p.rateSanity.level === 'notice'
      ? el('div', { class: 'note' }, p.rateSanity.message)
      : null,
    el('button', {
      class: 'btn btn--block', type: 'button',
      onclick: async () => {
        const result = await api.admin.generate(period);
        alert(`Generated ${result.generated} bills totalling ${money(result.totalAmount)}.`);
        location.reload();
      },
    }, `Generate ${p.willBill} bills`));
}
