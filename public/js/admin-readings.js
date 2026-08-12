/**
 * Meter reading entry — screen 07, and the one that decides whether the
 * treasurer adopts this at all. Someone enters 99 readings standing in a
 * corridor holding a phone.
 *
 * The header states BOTH months on purpose: they walk the building in July and
 * enter June's readings (plan §3a). Getting that wrong slips the whole year.
 */

import { api, ApiError } from './api.js';
import { renderNav } from './nav.js';
import { trackPage } from './track.js';
import { $, el, esc, renderViewBanner, showError, setChildren } from './ui.js';
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
    renderViewBanner(me, { onExit: async () => { await api.god.exit(); location.reload(); } });
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
    excludedPanel(),
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

/**
 * Paste OR a file, and a sample to start from.
 *
 * The file half is CSV/TSV/plain text and deliberately not .xlsx. A real
 * workbook is a zip of XML that needs a parser, and there is no build step
 * here — a library would be the first bundled dependency in the project, to
 * read a format Excel, Numbers and Sheets all export as CSV in two taps. The
 * file is read IN THE BROWSER and only its text is posted, so it goes through
 * exactly the same parser the paste box already uses; there is no second code
 * path that could disagree with the first.
 *
 * The sample is generated from the live grid rather than kept as a static
 * file, so it always carries this building's real flats in reading order, and
 * the previous month's value beside each one. A sample that drifts from the
 * building is worse than none: it teaches a format that no longer imports.
 */
function importPanel() {
  const box = el('textarea', {
    id: 'paste', placeholder: '4A\t5.817\n4B\t2.940\n…', 'aria-label': 'Paste readings',
  });
  const out = el('div', { class: 'small muted', style: 'margin-top:var(--s-2)' });

  const fill = async (text) => {
    out.textContent = 'Reading…';
    try {
      const parsed = await api.admin.parseReadings(text);
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
    } catch (err) {
      // Same lesson as the Generate button: an import that fails silently
      // leaves the treasurer believing the readings went in.
      showError(out, err);
    }
  };

  const file = el('input', {
    class: 'input', type: 'file', id: 'readings-file',
    accept: '.csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain',
    'aria-label': 'Upload a readings file',
    onchange: async (event) => {
      // Captured BEFORE the first await. `event.currentTarget` is only valid
      // while the event is being dispatched and reads back null afterwards, so
      // touching it below the await threw inside the handler — which is how
      // the reset silently never happened.
      const input = event.currentTarget;
      const chosen = input.files?.[0];
      if (!chosen) return;
      try {
        await fill(await chosen.text());
      } catch (err) {
        showError(out, err);
      }
      // Cleared so choosing the SAME file again re-fires change. Without this
      // a corrected re-export of one filename silently does nothing.
      input.value = '';
    },
  });

  // The same template the footer offers, not a second one. Two generators
  // would be two formats to keep in step, and the import now reads the
  // template's columns by name — so the file you get here is exactly the file
  // that goes back in.
  const sample = el('button', {
    class: 'linkish', type: 'button',
    onclick: () => api.admin.downloadTemplate(period, grid),
  }, 'Download the template');

  return el('details', { class: 'import' },
    el('summary', { style: 'font-family:var(--font-ui);cursor:pointer' },
      'Import readings from a spreadsheet'),
    el('div', { class: 'stack', style: 'margin-top:var(--s-3)' },
      el('div', { class: 'field' },
        el('label', { for: 'readings-file' }, 'Upload a file'), file,
        el('span', { class: 'field__hint' },
          'CSV, TSV or plain text. In Excel or Sheets choose File → Save as / '
          + 'Download → CSV. ',
          sample,
          ' — it lists every flat with last month\'s reading beside it, so the '
          + 'meter walk is a matter of filling the last column in.')),
      el('p', { class: 'label' }, 'Or paste it'),
      box,
      el('div', { class: 'row' },
        el('button', {
          class: 'btn btn--sm btn--ghost', type: 'button',
          onclick: () => fill(box.value),
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

/**
 * Which flats are missing from this grid, and why — READ ONLY.
 *
 * The control used to be here, and here was wrong. Deciding a flat is unsold is
 * a standing decision that holds until somebody buys it; putting the switch on
 * a screen you open once a month made it look like a monthly chore, which is
 * how it read to the person using it. It now lives on the Residents tab, where
 * the building's people and rooms are managed and where it is plainly set once.
 *
 * The fact stays here, though, because this is the screen where a missing row
 * is noticed — a grid that quietly holds fewer flats than the building has,
 * with nothing saying so, is worse than the chore was.
 */
function excludedPanel() {
  if (!grid.excluded?.length) return null;
  const n = grid.excluded.length;
  return el('div', { class: 'note' },
    el('b', {}, `${n} flat${n > 1 ? 's are' : ' is'} not being billed: `),
    grid.excluded.map((f) => f.flat).join(', '),
    el('p', { style: 'margin:var(--s-2) 0 0' },
      'They are left out of this month and out of the count that has to be '
      + 'complete before bills generate, and they stay out until they are turned '
      + 'back on. Change that under ',
      el('a', { class: 'linkish', href: '/admin/#residents' }, 'Residents'),
      '.'));
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
  const failure = el('div');

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
    // The catch is the point. Without it a refusal from the server — a locked
    // month (DDP-BILL-007), a month already generated, a partial month — threw
    // into an unhandled rejection and the button did NOTHING AT ALL: no
    // message, no change, while the failure was logged and pushed to Telegram.
    // The treasurer sees a dead button and the alert reaches somebody else.
    // Reported from the live site on 2026-08-12, generating a locked month.
    el('div', { class: 'stack' }, failure,
      el('button', {
        class: 'btn btn--block', type: 'button',
        onclick: async (event) => {
          const button = event.currentTarget;
          failure.replaceChildren();
          button.disabled = true;
          try {
            const result = await api.admin.generate(period);
            alert(`Generated ${result.generated} bills totalling ${money(result.totalAmount)}.`);
            location.reload();
          } catch (err) {
            showError(failure, err);
            button.disabled = false;
          }
        },
      }, `Generate ${p.willBill} bills`)));
}
