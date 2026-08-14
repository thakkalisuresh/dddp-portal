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
  const cells = [...main.querySelectorAll('[data-flat]')];
  const entered = cells.filter((i) => i.value !== '' && !i.classList.contains('input--error')).length;
  // A REFUSED ROW IS NOT AN EMPTY ONE. The count only ever named saved rows, so
  // a flat where a value had been typed and rejected was indistinguishable from
  // one nobody had touched — and the footer sent the treasurer hunting for
  // empty boxes that were not empty. Reported from testing on 2026-08-13.
  const rejected = cells.filter((i) => i.classList.contains('input--error')).length;
  const fill = main.querySelector('.progress__fill');
  const label = main.querySelector('.progress__label');
  if (fill) fill.style.width = `${grid.total ? Math.round((entered / grid.total) * 100) : 0}%`;
  if (label) {
    label.textContent = `${entered} of ${grid.total} entered`
      + (rejected ? ` · ${rejected} need${rejected > 1 ? '' : 's'} fixing` : '');
  }
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
            `Rate ₹${grid.rate.toFixed(2)} / kg · ${grid.conversionFactor} kg per unit`),

      // Said once, at the top, rather than discovered by typing into a box that
      // will not take it.
      grid.status === 'locked'
        ? el('p', { class: 'small', style: 'color:var(--awaiting);font-family:var(--font-ui)' },
            'This month is generated and locked. Readings can no longer be '
            + 'changed — a correction is made on the bill itself, in god mode, '
            + 'and needs two other admins to approve it.')
        : null),
    el('div', { class: 'progress' },
      el('span', { class: 'progress__track' },
        el('span', { class: 'progress__fill', style: `width:${pct}%` })),
      el('span', { class: 'progress__label' }, `${grid.entered} of ${grid.total} entered`)),

    // Unsent readings, said out loud. The old code claimed a failed save was
    // queued and would sync, and neither half was true — so the one state that
    // could lose a meter walk was also the only one with no indicator.
    el('div', { class: 'unsaved note note--bad', hidden: true },
      el('span', { class: 'unsaved__text' }, ''),
      el('button', {
        class: 'btn btn--sm', type: 'button', style: 'margin-left:var(--s-3)',
        onclick: () => flush(),
      }, 'Retry now'))
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

      // PARSED IS NOT ACCEPTED. This counted rows the parser understood and
      // announced "Nothing skipped", while the grid was in the same breath
      // rejecting some of them for running backwards — so an import of 99 rows
      // where two were refused reported a clean run. What the treasurer needs
      // is the count that survived the grid.
      const cells = parsed.rows
        .map((r) => main.querySelector(`[data-flat="${CSS.escape(r.flat)}"]`))
        .filter(Boolean);
      const refused = cells.filter((i) => i.classList.contains('input--error'));
      const odd = cells.filter((i) => i.classList.contains('input--warn'));
      const accepted = cells.length - refused.length;
      const flatOf = (i) => i.getAttribute('data-flat');

      // FILTERED, because replaceChildren is not el(). el() skips a null child;
      // replaceChildren stringifies it, and the treasurer reads the word "null"
      // in the middle of their import summary. Reported during testing on
      // 2026-08-14, from exactly the conditional-child style used everywhere
      // else in this file.
      out.replaceChildren(...[
        el('span', {}, `${accepted} filled in as a draft. `),
        parsed.errors.length
          ? el('strong', { style: 'color:var(--overdue)' },
              `${parsed.errors.length} could not be read: ` +
              parsed.errors.map((e) => `${e.flat ?? '?'} (${e.reason})`).join(', ') + ' ')
          : null,
        refused.length
          ? el('strong', { style: 'color:var(--overdue)' },
              `${refused.length} refused by the grid: ${refused.map(flatOf).join(', ')}. `)
          : null,
        odd.length
          ? el('strong', { style: 'color:var(--awaiting)' },
              `${odd.length} look unusual for the flat: ${odd.map(flatOf).join(', ')}. `)
          : null,
        !parsed.errors.length && !refused.length && !odd.length
          ? el('span', { style: 'color:var(--accent)' }, 'Nothing skipped.')
          : null,
      ].filter(Boolean));
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

  // "Nothing used" is entered by typing LAST MONTH'S reading again, because the
  // box holds a cumulative meter total and a flat that burned no gas has the
  // same total it had before. Everyone's first instinct is to type 0, which
  // claims the meter itself reads zero — a meter that ran backwards — and is
  // refused. The old message stated the problem and not the remedy, and a
  // treasurer with a resident away for the month had no way to record it.
  const sameAsLast = el('button', {
    class: 'btn btn--sm btn--ghost', type: 'button', hidden: true,
    onclick: () => {
      input.value = String(f.previous);
      input.dispatchEvent(new Event('change'));
    },
  }, 'Nothing used');

  // All three in the one flex row, so "saved" still sits beside the message
  // rather than dropping below it now that the cell itself is not the flex box.
  const status = el('td', { class: 'msg' },
    el('span', { class: 'msg__row' }, message, sameAsLast, saved));
  const used = el('td', { class: 'used muted' }, f.consumption == null ? '—' : kg(f.consumption));

  // A GENERATED MONTH IS NOT EDITABLE. The server has always refused these
  // saves; the screen went on offering them, so the treasurer typed into boxes
  // that could never be written and the failures looked like a broken portal.
  // Reported on 2026-08-14 — and it was worse than cosmetic, because each
  // refusal fed a retry that alerted the treasurer's phone every two seconds.
  const locked = grid.status === 'locked';

  const input = el('input', {
    class: 'input cell num', type: 'text', inputmode: 'decimal',
    'data-flat': f.flat, value: f.reading ?? '',
    'aria-label': `Reading for flat ${f.flat}`,
    disabled: locked || null,
    title: locked ? 'This month is generated. Correct the bill instead.' : null,
  });

  const validate = () => {
    const value = Number(input.value);
    input.classList.remove('input--error', 'input--warn');
    message.className = 'msg__text';
    message.textContent = '';
    used.textContent = '—';
    sameAsLast.hidden = true;

    if (input.value === '') { refreshProgress(); return null; }
    if (!Number.isFinite(value)) {
      input.classList.add('input--error');
      message.classList.add('msg--error');
      message.textContent = 'Not a number';
      return null;
    }
    // A flat whose meter was replaced this month is EXPECTED to read lower —
    // the new meter started near zero. The superadmin has recorded the swap, so
    // the grid must stop refusing it, or recording it changed nothing.
    const mc = f.meterChange;
    if (f.previous != null && value < f.previous && !mc) {
      // Blocked inline, with last month's value shown — meters don't run back.
      // The remedy is offered beside it, because the two cases that land here
      // are a typo and a flat that used nothing, and only one of them is wrong.
      input.classList.add('input--error');
      message.classList.add('msg--error');
      message.textContent = `Meters don't go down. Last month was ${f.previous}.`;
      sameAsLast.hidden = false;
      sameAsLast.textContent = `Nothing used — ${f.previous}`;
      return null;
    }
    if (f.previous != null && mc) {
      // Both segments, matching meterDeltaAcrossChange on the server.
      const delta = (mc.old_final - f.previous) + (value - (mc.new_start ?? 0));
      const consumption = Math.round(delta * grid.conversionFactor * 100) / 100;
      used.textContent = kg(consumption);
      message.classList.add('msg--warn');
      message.textContent = `New meter from ${mc.changed_on} — billing both`;
      return value;
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
      } else if (f.average != null && consumption > 0 && consumption * JUMP_MULTIPLE < f.average) {
        // The mirror case, and the one nobody reports: a digit dropped from
        // 18.867 to 18.100 still passes every check and under-bills the flat.
        // Zero is exempt — that is the documented way to record an empty month.
        input.classList.add('input--warn');
        message.classList.add('msg--warn');
        message.textContent = `Unusually low. Usually about ${kg(f.average)}`;
      }
    }
    return value;
  };

  input.addEventListener('change', () => {
    const value = validate();
    if (value == null) return;
    // A CHECK GOES STALE THE MOMENT A READING MOVES. The panel is a statement
    // about numbers that have since changed — leaving it on screen means a
    // corrected flat is still listed in red, and the treasurer cannot tell
    // whether their fix worked without noticing the panel is old.
    if (previewPanel.hasChildNodes()) {
      previewPanel.replaceChildren(el('p', { class: 'small muted' },
        'A reading changed. Check again to see what this month will bill.'));
    }
    pending.set(f.flat, value);
    indicators.set(f.flat, saved);
    saved.className = 'msg__saved muted';
    saved.textContent = 'saving…';
    refreshProgress();
    scheduleFlush();
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

/**
 * Autosave, batched. A corridor is a dead spot, so failures queue and retry \u2014
 * and this time that sentence is true.
 *
 * IT USED TO BE ONE REQUEST PER FLAT. Pasting a month dispatched `change` on
 * all 99 rows at once, so 99 PUTs left the browser inside a second. They mostly
 * arrive; "mostly" is the problem, and the endpoint has always accepted an
 * array, so the burst bought nothing.
 *
 * AND THE FAILURE MESSAGE WAS A LIE. It said "saved on this phone \u00b7 will sync"
 * while `pending` was an in-memory Map that nothing ever retried, drained or
 * persisted \u2014 the value lived until the tab was closed and then did not. A
 * treasurer who trusted that sentence lost the reading and had no way to know.
 * Now the queue is genuinely retried: on the next edit, on `online`, on demand,
 * and the tab refuses to close quietly while anything is unsent.
 */
const indicators = new Map();   // flat -> the \u2713/! element for that row
let flushTimer = null;
let flushing = false;

function scheduleFlush(delay = 400) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, delay);
}

function markRows(flats, className, text) {
  for (const flat of flats) {
    const node = indicators.get(flat);
    if (!node) continue;
    node.className = `msg__saved ${className}`;
    node.textContent = text;
  }
}

async function flush() {
  if (flushing || !pending.size) return;
  flushing = true;

  // Snapshotted before the await: a treasurer types on while the request is in
  // flight, and anything added afterwards belongs to the NEXT flush rather than
  // being marked saved by this one.
  const batch = [...pending.entries()].map(([flat, reading]) => ({ flat, reading }));
  const flats = batch.map((b) => b.flat);

  try {
    await api.admin.saveReadings(period, batch);
    for (const { flat, reading } of batch) {
      // Only clear if unchanged since the snapshot, or an edit made mid-flight
      // would be dropped without ever being sent.
      if (pending.get(flat) === reading) pending.delete(flat);
    }
    markRows(flats.filter((f) => !pending.has(f)), 'msg--ok', '\u2713 saved');
  } catch (err) {
    // NOT EVERY FAILURE IS WORTH RETRYING, and treating them alike is how a
    // safety net becomes a hammer. A locked month, a refused value, any 4xx:
    // the same request will fail identically forever. On 2026-08-14 a reading
    // typed after July closed retried every two seconds, and each attempt
    // logged an error and pushed a Telegram alert \u2014 56 in a minute.
    //
    // 408 and 429 are the exceptions: a timeout and a rate limit are both
    // "later, not never".
    const permanent = err?.status >= 400 && err?.status < 500
                   && err.status !== 408 && err.status !== 429;

    if (permanent) {
      // Dropped from the queue, because retrying is the bug. The rows keep
      // their red "not saved" so nothing looks accepted that was not.
      for (const { flat } of batch) pending.delete(flat);
      markRows(flats, 'msg--error', 'not saved');
      refusal = err?.code === 'DDP-BILL-007'
        ? 'This month is generated and locked \u2014 readings can no longer be changed. '
          + 'Corrections are made on the bill now, under god mode.'
        : (err?.message ?? 'Those readings were refused.');
      return;
    }

    markRows(flats, 'msg--error', 'not saved \u00b7 will retry');
    // Backing off rather than hammering: the usual cause is a dead spot in a
    // stairwell, and it comes back on its own.
    scheduleFlush(5000);
  } finally {
    flushing = false;
    refreshUnsaved();
    if (pending.size) scheduleFlush(1500);
  }
}

/**
 * A banner while anything is unsent, because a lost reading is silent — and a
 * different one when the server has refused outright, which is not the same
 * thing and must not offer a Retry button that cannot help.
 */
let refusal = null;

function refreshUnsaved() {
  const bar = main.querySelector('.unsaved');
  if (!bar) return;
  const retry = bar.querySelector('button');

  if (refusal) {
    bar.hidden = false;
    bar.querySelector('.unsaved__text').textContent = refusal;
    if (retry) retry.hidden = true;
    return;
  }

  bar.hidden = pending.size === 0;
  if (retry) retry.hidden = false;
  bar.querySelector('.unsaved__text').textContent =
    `${pending.size} reading${pending.size > 1 ? 's' : ''} not saved yet`;
}

// The retries that make the promise honest.
addEventListener('online', () => scheduleFlush(0));
addEventListener('beforeunload', (event) => {
  if (!pending.size) return;
  event.preventDefault();
  // Wording is the browser's; what matters is that the tab no longer closes
  // silently on unsent readings.
  event.returnValue = '';
});

function footbar() {
  const generate = el('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      previewPanel.replaceChildren(el('p', { class: 'small muted' }, 'Checking…'));
      try {
        // Anything still queued is flushed FIRST. The preview asks the server
        // what it holds, so an unsent row reads back as a flat nobody entered —
        // the check would report the month incomplete and point at rows that
        // are filled in on screen.
        await flush();
        const p = await api.admin.preview(period);
        previewPanel.replaceChildren(previewSummary(p));
      } catch (err) {
        showError(previewPanel, err);
      }
      previewPanel.scrollIntoView({ block: 'nearest' });
    },
    // "Check this month" read like a health check you could run any time, and
    // gave no hint that it was the only route to generating. It is the step
    // before the irreversible one, and it should say so.
  }, grid.status === 'locked' ? 'Show this month' : 'Check before generating');

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

  const outliers = p.outliers ?? [];

  return el('div', { class: 'stack', style: 'gap:var(--s-2)' },
    el('div', { class: 'note note--good' },
      el('div', {}, `${p.willBill} flats · ${kg(p.totalKg)} · rate ₹${p.ratePerKg.toFixed(2)}`),
      el('strong', { style: 'font-size:var(--text-md)' }, `Total ${money(p.totalAmount)}`),
      el('div', { class: 'small' },
        'Check this against the supplier invoice before generating.')),

    // NAMED HERE, NOT ONLY IN THE GRID. A transposed digit — 15.405 typed as
    // 65.405 — passes every check the portal has: the meter still went up, the
    // rate is fine, the month is complete. It shows up only as one flat billed
    // fifty times its usual, and the person clicking Generate was reading a
    // total, not ninety-nine rows. This is the last screen before bills reach
    // residents, so it is the last chance to catch it.
    outliers.length
      ? el('div', { class: 'note note--warn' },
          el('strong', {},
            `${outliers.length} reading${outliers.length > 1 ? 's look' : ' looks'} wrong for the flat`),
          el('div', { class: 'stack small', style: 'gap:var(--s-1);margin-top:var(--s-2)' },
            ...outliers.slice(0, 6).map((o) =>
              el('div', {},
                el('b', {}, o.flat), ' · ', kg(o.consumption), ' · ', money(o.total),
                el('span', { class: 'muted' },
                  o.direction === 'high'
                    ? ` — ${o.multiple}× its usual ${kg(o.average)}`
                    : ` — usually about ${kg(o.average)}`))),
            outliers.length > 6
              ? el('div', { class: 'muted' }, `…and ${outliers.length - 6} more`)
              : null),
          el('div', { class: 'small', style: 'margin-top:var(--s-2)' },
            'Worth a call to the caretaker before generating. Once bills exist '
            + 'the month is locked, and each one has to be corrected by hand.'))
      : null,
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
