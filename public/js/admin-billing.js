/**
 * Billing — one flow from the price of gas to the published bill.
 *
 * This replaces two screens that were the same errand: the Rates tab, and the
 * Readings page. They were split because they were built separately, not
 * because anybody thinks of them apart — a month is one job, done in one order,
 * and splitting it left the treasurer on a screen that looked finished. Two
 * months were opened on 2026-08-12 and then abandoned "unsure how to add
 * readings", because nothing on the rate screen said to go anywhere.
 *
 * Three steps and a publish:
 *
 *   1. The price of gas — rate per kg, payment due, late fee.
 *   2. This month's readings — the meter walk, with paste and file import.
 *   3. Review and publish — every flat, what it used, and what it owes.
 *
 * Publishing generates the bills, locks the month, and queues an email to every
 * resident who has an address. Readings stay editable in step 3. THE AMOUNT
 * NEVER IS — not here, not on the Bills tab, not for the superadmin. A bill is
 * consumption times rate, and the two things that can be wrong with it are the
 * reading and the price, both of which are corrected as themselves.
 *
 * STEP 2 IS admin-readings.js MOVED, NOT REWRITTEN. Its autosave, offline
 * queue, retry banner, beforeunload guard, progress count and per-row
 * validation came with it, and so did its comments — they are the record of
 * what testing already cost, and a prototype of this screen twice reproduced
 * bugs that file had already fixed by copying its shape without them.
 *
 * The design and its reasoning: docs/BILLING-TAB.md. Who is billed, who is
 * liable, and which flats count: docs/RESIDENTS-OCCUPANCY.md.
 */

import { api } from './api.js';
import { el, showError, askFirst } from './ui.js';
import { money, kg, periodLabel, dayLabel } from './i18n.js';
import { trackAction } from './track.js';

/** Mirrors JUMP_MULTIPLE in functions/lib/admin.js. */
const JUMP_MULTIPLE = 3;

/** How many announcements one drain sends. Mirrors DRAIN_SIZE in announce.js. */
const DRAIN_SIZE = 20;

const root = el('div', { class: 'stack' });

let period = null;
let grid = null;          // readingGrid payload for `period`
let periods = [];         // every month, newest first
let emails = new Map();   // owner id -> email, for the coverage count
let announcements = null; // { counts, unreachable } once the month is published
let step = 1;

/**
 * The queue of readings not yet accepted by the server.
 *
 * Module-level rather than per-render, along with the flush timer and the
 * indicator map, because a re-render must not lose a reading that is still in
 * flight — and because the `online` and `beforeunload` listeners below are
 * registered once for the life of the tab.
 */
const pending = new Map();      // flat -> reading, queued while offline
const indicators = new Map();   // flat -> the ✓/! element for that row
let flushTimer = null;
let flushing = false;
let refusal = null;

/* ── arithmetic, matching functions/lib/billing.js ────────────────────────── */

/**
 * What a flat used, from whatever reading is on screen right now.
 *
 * Recomputed here rather than read off `grid.flats[].consumption`, which is the
 * server's answer for the reading it last saw. A treasurer correcting a row in
 * step 3 needs the amount beside it to move as they type, and a stale
 * consumption is how a screen comes to disagree with itself about a number the
 * person is looking at.
 */
function consumptionOf(f) {
  if (f.reading == null || f.previous == null) return null;
  const mc = f.meterChange;
  // Both segments, matching meterDeltaAcrossChange on the server: the old meter
  // to its final reading, plus the new one from where it started.
  const delta = mc
    ? (mc.old_final - f.previous) + (f.reading - (mc.new_start ?? 0))
    : f.reading - f.previous;
  return Math.round(delta * grid.conversionFactor * 100) / 100;
}

/** Bills round UP to whole rupees — toWholeRupees in billing.js. */
function amountOf(f) {
  const c = consumptionOf(f);
  if (c == null || grid.rate == null || c < 0) return null;
  return Math.ceil(Math.round(c * grid.rate * 100) / 100);
}

/**
 * The flats that can actually produce a bill.
 *
 * COUNTS COME FROM HERE, NEVER FROM THE BUILDING. A flat with nobody on file
 * cannot be emailed and cannot be billed, and counting it produced a screen
 * whose Flats tile read 88 while its Gas and Total tiles summed all 89 — the
 * same off-by-one-set that had the publish button offering to send one more
 * bill than the note beneath it described.
 *
 * `residentId` is `occupantOf`'s answer, decided once for the whole grid on the
 * server (see occupantsByFlat). Never re-derived from `relationship` here.
 */
const billable = () => grid.flats.filter((f) => f.residentId != null);

/** Billed, switched on, and nobody on file. The month cannot generate. */
const ownerless = () => grid.flats.filter((f) => f.residentId == null);

/** Billable, and no address to send a bill to. The WhatsApp list, before publishing. */
const noEmail = () => billable().filter((f) => !emails.get(f.residentId));

const enteredCount = () =>
  grid.flats.filter((f) => f.reading != null && (f.meterChange || f.reading >= f.previous)).length;

const totalKg = () => billable().reduce((sum, f) => sum + (consumptionOf(f) ?? 0), 0);
const totalAmount = () => billable().reduce((sum, f) => sum + (amountOf(f) ?? 0), 0);

const isPublished = () => grid.status === 'locked';

function outliers() {
  return billable().filter((f) => {
    const c = consumptionOf(f);
    if (c == null || f.average == null) return false;
    if (c > f.average * JUMP_MULTIPLE) return true;
    return c > 0 && c * JUMP_MULTIPLE < f.average;
  });
}

/* ── loading ─────────────────────────────────────────────────────────────── */

/** Readings entered this month close LAST month's usage (plan §3a). */
function defaultPeriod() {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** '2026-07' -> '2026-08' */
function nextMonth(p) {
  const [y, m] = String(p).split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** The building has always paid by the 10th of the month after the usage month. */
const defaultDue = (p) => `${nextMonth(p)}-10`;

/**
 * The month in hand.
 *
 * THIS TAB IS ONLY EVER ABOUT ONE MONTH. Past months and their bills live under
 * Bills, which already searches by flat — a list of every month under the one
 * you are working on grows without limit, and the tab would be a different size
 * in year three than in month one.
 *
 * The open month if there is one, because that is the month somebody is in the
 * middle of. Otherwise the newest, which will be the one just published, so
 * publishing lands on its own result rather than on an empty next month.
 */
function monthInHand(rows) {
  const open = rows.find((p) => p.status !== 'locked');
  if (open) return open.period;
  if (rows.length) return rows[0].period;
  return defaultPeriod();
}

/**
 * The whole tab. Loads the month in hand, then draws the rail into `root` and
 * redraws it in place for the rest of the session.
 */
export async function billingPanel() {
  periods = (await api.admin.periods()).periods ?? [];
  period = monthInHand(periods);
  await load();
  render();
  return root;
}

async function load() {
  const [readings, directory] = await Promise.all([
    api.admin.readings(period),
    api.admin.residents(),
  ]);
  grid = readings;

  // Who has an address, keyed by the person the bill is FOR. The grid already
  // decided that with occupantOf; this only answers "can we email them".
  emails = new Map((directory.residents ?? []).map((r) => [r.id, r.email || null]));

  announcements = isPublished()
    ? await api.admin.announcements(period).catch(() => null)
    : null;

  // Where to land. A published month opens on its own card; a month with a rate
  // and an incomplete grid opens on the meter walk, which is the errand in
  // hand; anything else starts at the beginning.
  step = isPublished() ? 0
    : grid.rate == null ? 1
      : enteredCount() < grid.total ? 2 : 3;
}

/* ── the rail ────────────────────────────────────────────────────────────── */

function render() {
  const rail = el('div', { class: 'rail' });

  // Bodies are built ONLY for the open step. A closed step's body is hidden
  // anyway, and building step 3 before a rate exists divides by nothing.
  const shell = (n, title, sub, body, state) =>
    stepShell(n, title, sub, state === 'open' ? body() : el('div'), state);

  rail.replaceChildren(
    shell(1, 'The price of gas', priceSub(), priceBody, priceState()),
    shell(2, 'This month’s readings', readingsSub(), readingsBody, readingsState()),
    shell(3, 'Review and publish', reviewSub(), reviewBody, reviewState()),
  );

  // FILTERED, because replaceChildren is not el(). el() skips a null child;
  // replaceChildren stringifies it, and you read the word "null" on the page
  // between the last step and the note under it. This is the THIRD time this
  // codebase has hit it — importPanel carries the same comment, and the
  // prototype for this very screen reproduced it a second time — which is why
  // it is written down again here rather than merely fixed.
  root.replaceChildren(...[
    el('div', { class: 'panel stack' },
      el('div', { class: 'row row--between' },
        el('div', {},
          el('h2', {}, periodLabel(grid.period)),
          el('p', { class: 'small muted' },
            // Stating BOTH months is not redundancy — it is the difference
            // between a correct year and one that is silently a month out. The
            // building is walked in September to close August.
            `Meters read in ${periodLabel(grid.readMonth)} · closes ${periodLabel(grid.period)}’s gas`)),
        el('span', {
          class: `chip ${isPublished() ? 'chip--paid' : grid.rate != null ? 'chip--neutral' : 'chip--awaiting'}`,
        }, isPublished() ? 'Published' : grid.rate != null ? 'Draft' : 'Not started')),
      unsavedBar()),
    rail,
    isPublished() ? publishedCard() : null,
    historyNote(),
  ].filter(Boolean));
}

/** Re-read everything from the server and redraw. Used after any write. */
async function reload(landOn = null) {
  await load();
  if (landOn != null) step = landOn;
  render();
}

function stepShell(n, title, sub, body, state) {
  const head = el('button', {
    class: 'step__head', type: 'button',
    'aria-expanded': String(state === 'open'),
    disabled: state === 'waiting' || null,
    onclick: () => {
      if (state === 'waiting') return;
      step = step === n ? 0 : n;
      render();
    },
  },
    el('span', { class: 'step__n' }, state === 'done' ? '✓' : String(n)),
    el('span', { class: 'step__label' },
      el('span', { class: 'step__title' }, title),
      el('span', { class: 'step__sub' }, sub)));

  // Addressed by `data-step`, not by position. The published card is a `.step`
  // too and sits beside the rail, so a positional selector would have step 3's
  // subtitle and the published card competing for the same nth-child.
  return el('section', { class: 'step', 'data-state': state, 'data-step': String(n) },
    head, el('div', { class: 'step__body' }, body));
}

/**
 * Past months, named as being somewhere else.
 *
 * Said out loud rather than left to be discovered. A treasurer looking for July
 * on a tab called Billing and finding nothing concludes the portal has lost it.
 */
function historyNote() {
  return el('p', { class: 'small muted' },
    'This tab is only ever about the month in hand. Past months and their bills '
    + 'live under ',
    el('a', { class: 'linkish', href: '#bills' }, 'Bills'),
    ', which searches by flat.');
}

/* ── step 1 · the price of gas ───────────────────────────────────────────── */

const priceState = () => step === 1 ? 'open' : grid.rate != null ? 'done' : 'ready';

const priceSub = () => grid.rate != null
  ? `₹${grid.rate.toFixed(2)} per kg · due ${dayLabel(grid.dueDate)} · ₹${grid.lateFee} late fee`
  : 'Not set yet — a reading has nothing to price without it';

function priceBody() {
  if (isPublished()) {
    return el('div', { class: 'stack' },
      el('p', { class: 'small muted' },
        `Locked at ₹${grid.rate.toFixed(2)} per kg when the month was published. `
        + 'Correcting it now recalculates every bill in the month, so it goes to '
        + 'two other admins — the control is on the published card below.'));
  }

  const status = el('div');
  const rate = el('input', {
    class: 'input num', id: 'b-rate', inputmode: 'decimal', placeholder: '78.00',
    value: grid.rate ?? '',
  });
  const due = el('input', {
    class: 'input', id: 'b-due', type: 'date',
    // type=date yields YYYY-MM-DD, already the format the API and the periods
    // table expect, so nothing has to parse a typed date and guess whether
    // 05/08 was May or August.
    value: grid.dueDate ?? defaultDue(period),
  });
  const fee = el('input', {
    class: 'input num', id: 'b-fee', inputmode: 'numeric',
    // ₹50 for a month that does not exist yet, and the stored figure for one
    // that does. NOT `grid.lateFee ?? 50`: readingGrid reports 0 rather than
    // null for a month with no period row, so the default never fired and the
    // treasurer was silently offered a month with no late fee at all.
    value: grid.status == null ? 50 : grid.lateFee,
  });
  const sanity = el('div');

  // The comparison stays; the advice around it does not. "Worth a glance at the
  // supplier bill before you carry on" told a treasurer holding the supplier
  // bill what they were already doing.
  const previous = periods.find((p) => p.period === previousMonth(period));
  const check = () => {
    const v = Number(rate.value);
    if (!Number.isFinite(v) || v <= 0 || !previous?.rate_per_kg) {
      sanity.replaceChildren();
      return;
    }
    const change = ((v - previous.rate_per_kg) / previous.rate_per_kg) * 100;
    const was = `${periodLabel(previous.period)} was ₹${previous.rate_per_kg.toFixed(2)}`;
    sanity.replaceChildren(Math.abs(change) < 20
      ? el('p', { class: 'small muted' },
          `${was} — that is ${change >= 0 ? 'up' : 'down'} ${Math.abs(change).toFixed(1)}%.`)
      : el('div', { class: 'note note--warn' },
          el('b', {}, `₹${v.toFixed(2)} is ${Math.abs(change).toFixed(0)}% `
            + `${change >= 0 ? 'above' : 'below'} ${was.replace(/^.* was /, '')}.`)));
  };
  rate.addEventListener('input', check);
  setTimeout(check, 0);

  const save = async (event) => {
    const button = event.currentTarget;
    const v = Number(rate.value);
    if (!Number.isFinite(v) || v <= 0) {
      rate.classList.add('input--error');
      rate.focus();
      return;
    }
    const lateFee = Number(fee.value);
    if (!Number.isInteger(lateFee) || lateFee < 0) {
      fee.classList.add('input--error');
      fee.focus();
      showError(status, { message: 'The late fee is whole rupees. No paise.' });
      return;
    }

    button.disabled = true;
    try {
      if (grid.status == null) {
        // The month does not exist yet. Opening it is what creates the row
        // every reading is keyed to — saveReadings fails outright on a period
        // that is not there.
        await api.admin.openPeriod({
          period, ratePerKg: v, dueDate: due.value, lateFee,
        });
      } else {
        // An open month has no bills in it — generation locks the month in the
        // same batch it writes them — so changing the rate here moves nothing
        // and needs no impact screen. That is only true while it is open, which
        // is why the published path is a correction and lives elsewhere.
        if (v !== grid.rate) {
          await api.admin.changeRate(period, v, 'Rate set for the month', false);
        }
        if (due.value !== grid.dueDate || lateFee !== grid.lateFee) {
          await api.admin.setPeriodTerms(period, { dueDate: due.value, lateFee });
        }
      }
      trackAction('admin.billing.rate');
      periods = (await api.admin.periods()).periods ?? [];
      await reload(2);
    } catch (err) {
      button.disabled = false;
      showError(status, err);
    }
  };

  return el('div', { class: 'stack' },
    el('p', { class: 'small muted', style: 'max-width:62ch' },
      'Set this every month, even when it has not changed. Nothing is carried '
      + 'forward: an inherited rate produces a building’s worth of bills that '
      + 'look normal and are all wrong.'),
    el('div', { class: 'billfields' },
      el('div', { class: 'field' }, el('label', { for: 'b-rate' }, 'Rate per kg'), rate),
      el('div', { class: 'field' }, el('label', { for: 'b-due' }, 'Payment due'), due),
      el('div', { class: 'field' }, el('label', { for: 'b-fee' }, 'Late fee'), fee,
        el('span', { class: 'field__hint' }, 'Whole rupees. No paise.'))),
    sanity,
    status,
    el('button', { class: 'btn', type: 'button', onclick: save },
      grid.status == null ? 'Save and go to readings' : 'Save'));
}

/** '2026-08' -> '2026-07' */
function previousMonth(p) {
  const [y, m] = String(p).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/* ── step 2 · the readings ───────────────────────────────────────────────── */

const readingsState = () => step === 2 ? 'open'
  : grid.rate == null ? 'waiting'
    : enteredCount() === grid.total ? 'done' : 'ready';

const readingsSub = () => grid.rate == null
  ? 'Needs a rate first — a reading has nothing to price without one'
  : `${enteredCount()} of ${grid.total} meters entered`;

function readingsBody() {
  const progressFill = el('span', { class: 'progress__fill' });
  const progressLabel = el('span', { class: 'progress__label' });
  const tbody = el('tbody');
  const importOut = el('div', { class: 'small muted', style: 'margin-top:var(--s-2)' });
  const go = el('button', { class: 'btn btn--block', type: 'button' });

  /**
   * Keep the counter honest as rows save — it is the treasurer's sense of
   * progress, and the only thing on screen that says whether the walk is done.
   */
  const refresh = () => {
    const cells = [...tbody.querySelectorAll('[data-flat]')];
    const entered = cells.filter((i) => i.value !== '' && !i.classList.contains('input--error'));
    // A REFUSED ROW IS NOT AN EMPTY ONE. The count only ever named saved rows,
    // so a flat where a value had been typed and rejected was indistinguishable
    // from one nobody had touched — and the footer sent the treasurer hunting
    // for empty boxes that were not empty. Reported from testing on 2026-08-13.
    const rejected = cells.filter((i) => i.classList.contains('input--error'));
    const empty = cells.filter((i) => i.value === '' && !i.classList.contains('input--error'));

    progressFill.style.width = `${grid.total ? Math.round((entered.length / grid.total) * 100) : 0}%`;
    progressLabel.textContent = `${entered.length} of ${grid.total} entered`
      + (rejected.length ? ` · ${rejected.length} need${rejected.length > 1 ? '' : 's'} fixing` : '');

    const sub = root.querySelector('.step[data-step="2"] .step__sub');
    if (sub) sub.textContent = readingsSub();

    // NEVER A DEAD BUTTON. Complete, it moves on; incomplete, it takes you to
    // whatever is in the way — which with 89 rows is the whole problem. "1
    // still to enter" was both false and unactionable when the row in question
    // was full and refused.
    const done = entered.length === grid.total && !rejected.length;
    const refused = rejected.map((i) => i.getAttribute('data-flat'));
    go.className = `btn btn--block${done ? '' : ' btn--quiet'}`;
    go.textContent = done
      ? 'Work out what everyone owes'
      : refused.length
        ? `Fix ${refused.slice(0, 3).join(', ')}`
          + (refused.length > 3 ? ` and ${refused.length - 3} more` : '')
        : `${empty.length} still to enter — take me there`;
    go.onclick = done
      ? async () => {
          // Anything still queued goes FIRST. Step 3 prices what the server
          // holds, so an unsent row would read back as a flat nobody entered.
          await flush();
          await reload(3);
        }
      : () => {
          const first = rejected[0] ?? empty[0];
          if (first) { first.scrollIntoView({ block: 'center' }); first.focus(); }
        };
  };

  for (const f of grid.flats) tbody.append(readingRow(f, refresh));
  setTimeout(refresh, 0);

  return el('div', { class: 'stack' },
    el('div', { class: 'row row--between billrow--progress' },
      el('span', { class: 'progress' },
        el('span', { class: 'progress__track' }, progressFill), progressLabel),
      el('span', { class: 'small muted' },
        'Saved as you type · held and retried if the signal drops')),

    importPanel(tbody, importOut, refresh),
    importOut,

    el('div', { class: 'scroll-x' },
      el('table', { class: 'grid' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Flat'), el('th', {}, 'Previous'), el('th', {}, 'Reading'),
          el('th', {}, 'Used'), el('th', {}, ''))),
        tbody)),

    excludedPanel(),
    go);
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
 * The sample is generated from the live grid rather than kept as a static file,
 * so it always carries this building's real flats in reading order, and the
 * previous month's value beside each one. A sample that drifts from the
 * building is worse than none: it teaches a format that no longer imports.
 */
function importPanel(tbody, out, refresh) {
  const box = el('textarea', {
    class: 'input', id: 'b-paste', placeholder: '4A\t5.817\n4B\t2.940\n…',
    'aria-label': 'Paste readings',
  });

  const fill = async (text) => {
    // An empty box is not an import of nothing — it is a press with nothing to
    // press on, and "0 filled in as a draft. Nothing skipped" reads as success.
    if (!String(text ?? '').trim()) {
      out.replaceChildren(el('span', { class: 'msg--warn' },
        'Nothing to read. Paste the readings above, or choose a file.'));
      return;
    }
    out.textContent = 'Reading…';
    try {
      const parsed = await api.admin.parseReadings(text);
      // Parsed values fill the grid as a DRAFT. Nothing is written until the
      // rows save — one transposed column would otherwise mis-bill everyone.
      for (const row of parsed.rows) {
        const input = tbody.querySelector(`[data-flat="${CSS.escape(row.flat)}"]`);
        if (input) { input.value = row.reading; input.dispatchEvent(new Event('change')); }
      }

      // PARSED IS NOT ACCEPTED. This counted rows the parser understood and
      // announced "Nothing skipped", while the grid was in the same breath
      // rejecting some of them for running backwards — so an import of 89 rows
      // where two were refused reported a clean run. What the treasurer needs
      // is the count that survived the grid.
      //
      // Counted over DISTINCT flats, not parsed lines: pasting a correction
      // underneath an existing block counted a flat twice and reported 93
      // filled in a building of 89.
      const cells = [...new Set(parsed.rows.map((r) => r.flat))]
        .map((flat) => tbody.querySelector(`[data-flat="${CSS.escape(flat)}"]`))
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
              `${parsed.errors.length} could not be read: `
              + parsed.errors.map((e) => `${e.flat ?? '?'} (${e.reason})`).join(', ') + ' ')
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
      refresh();
    } catch (err) {
      // Same lesson as the publish button: an import that fails silently leaves
      // the treasurer believing the readings went in.
      showError(out, err);
    }
  };

  const file = el('input', {
    class: 'input', type: 'file', id: 'b-file',
    accept: '.csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain',
    'aria-label': 'Upload a readings file',
    onchange: async (event) => {
      // Captured BEFORE the first await. `event.currentTarget` is only valid
      // while the event is being dispatched and reads back null afterwards, so
      // touching it below the await threw inside the handler — which is how the
      // reset silently never happened.
      const input = event.currentTarget;
      const chosen = input.files?.[0];
      if (!chosen) return;
      try {
        await fill(await chosen.text());
      } catch (err) {
        showError(out, err);
      }
      // Cleared so choosing the SAME file again re-fires change. Without this a
      // corrected re-export of one filename silently does nothing.
      input.value = '';
    },
  });

  // The same template the import reads back, not a second one. Two generators
  // would be two formats to keep in step.
  const sample = el('button', {
    class: 'linkish', type: 'button',
    onclick: () => api.admin.downloadTemplate(period, grid),
  }, 'Download the template');

  return el('details', { class: 'import' },
    el('summary', {}, 'Import from a spreadsheet, or paste'),
    el('div', { class: 'stack', style: 'margin-top:var(--s-3)' },
      el('div', { class: 'field' },
        el('label', { for: 'b-file' }, 'Upload a file'), file,
        el('span', { class: 'field__hint' },
          'CSV, TSV or plain text. In Excel or Sheets choose File → Save as / '
          + 'Download → CSV. ',
          sample,
          ' — it lists every flat with last month’s reading beside it, so the '
          + 'meter walk is a matter of filling the last column in.')),
      el('p', { class: 'label' }, 'Or paste it'),
      box,
      el('div', { class: 'row' },
        el('button', {
          class: 'btn btn--sm btn--ghost', type: 'button',
          onclick: () => fill(box.value),
        }, 'Fill the grid'))));
}

function readingRow(f, refresh) {
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
    sameAsLast.hidden = true;

    if (input.value === '') { f.reading = null; return null; }
    if (!Number.isFinite(value)) {
      input.classList.add('input--error');
      message.classList.add('msg--error');
      message.textContent = 'Not a number';
      f.reading = null;
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
      // Held on the row, but not counted as entered — see refreshProgress.
      f.reading = value;
      return null;
    }
    f.reading = value;
    if (f.previous != null) {
      const consumption = consumptionOf(f);
      used.textContent = kg(consumption);
      if (mc) {
        message.classList.add('msg--warn');
        message.textContent = `New meter from ${mc.changed_on} — billing both`;
        return value;
      }
      // Compare against this flat's own history, as the value is typed — a
      // transposed digit should be questioned before it is saved, not after.
      if (f.average != null && consumption > f.average * JUMP_MULTIPLE) {
        input.classList.add('input--warn');
        message.classList.add('msg--warn');
        message.textContent = `Unusually high. Usually about ${kg(f.average)}`;
      } else if (f.average != null && consumption > 0
                 && consumption * JUMP_MULTIPLE < f.average) {
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
    refresh();
    if (value == null) return;
    pending.set(f.flat, value);
    indicators.set(f.flat, saved);
    saved.className = 'msg__saved muted';
    saved.textContent = 'saving…';
    scheduleFlush();
  });

  if (f.reading != null) setTimeout(validate, 0);

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
      + 'complete before bills are published, and they stay out until they are '
      + 'turned back on. Change that under ',
      el('a', { class: 'linkish', href: '#residents' }, 'Residents'),
      '.'));
}

/* ── autosave ────────────────────────────────────────────────────────────── */

/**
 * Autosave, batched. A corridor is a dead spot, so failures queue and retry —
 * and this time that sentence is true.
 *
 * IT USED TO BE ONE REQUEST PER FLAT. Pasting a month dispatched `change` on
 * all 89 rows at once, so 89 PUTs left the browser inside a second. They mostly
 * arrive; "mostly" is the problem, and the endpoint has always accepted an
 * array, so the burst bought nothing.
 *
 * AND THE FAILURE MESSAGE WAS A LIE. It said "saved on this phone · will sync"
 * while `pending` was an in-memory Map that nothing ever retried, drained or
 * persisted — the value lived until the tab was closed and then did not. A
 * treasurer who trusted that sentence lost the reading and had no way to know.
 * Now the queue is genuinely retried: on the next edit, on `online`, on demand,
 * and the tab refuses to close quietly while anything is unsent.
 */
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
    markRows(flats.filter((f) => !pending.has(f)), 'msg--ok', '✓ saved');
  } catch (err) {
    // NOT EVERY FAILURE IS WORTH RETRYING, and treating them alike is how a
    // safety net becomes a hammer. A locked month, a refused value, any 4xx:
    // the same request will fail identically forever. On 2026-08-14 a reading
    // typed after July closed retried every two seconds, and each attempt
    // logged an error and pushed a Telegram alert — 56 in a minute.
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
        ? 'This month is published — readings can no longer be changed here. '
          + 'Correct the reading on the published card below, and two other '
          + 'admins will be asked to agree.'
        : (err?.message ?? 'Those readings were refused.');
      return;
    }

    markRows(flats, 'msg--error', 'not saved · will retry');
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
function unsavedBar() {
  return el('div', { class: 'unsaved note note--bad', hidden: true },
    el('span', { class: 'unsaved__text' }, ''),
    el('button', {
      class: 'btn btn--sm', type: 'button', style: 'margin-left:var(--s-3)',
      onclick: () => flush(),
    }, 'Retry now'));
}

function refreshUnsaved() {
  const bar = root.querySelector('.unsaved');
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

// The retries that make the promise honest. Registered once for the life of the
// tab rather than per render, or a re-rendered grid would stack a listener each
// time and fire the flush as many times as the panel had been drawn.
addEventListener('online', () => scheduleFlush(0));
addEventListener('beforeunload', (event) => {
  if (!pending.size) return;
  event.preventDefault();
  // Wording is the browser's; what matters is that the tab no longer closes
  // silently on unsent readings.
  event.returnValue = '';
});

/* ── step 3 · review and publish ─────────────────────────────────────────── */

const reviewState = () => isPublished() ? 'done'
  : step === 3 ? 'open'
    : (grid.rate == null || enteredCount() !== grid.total) ? 'waiting' : 'ready';

const reviewSub = () => isPublished()
  ? `Published · ${money(totalAmount())} across ${billable().length} flats`
  : enteredCount() === grid.total
    ? `${money(totalAmount())} across ${billable().length} flats, nothing sent yet`
    : 'Needs every meter in first';

function reviewBody() {
  if (isPublished()) {
    return el('p', { class: 'small muted' },
      'Published. The readings are the building’s archive now — corrections are '
      + 'on the card below.');
  }

  const publishAsk = el('div');
  const oddSlot = el('div');
  const totalsSlot = el('div', { class: 'totals' });
  // The explanation has to live WHERE THE PERSON IS. It was at the top of a
  // very long step, so somebody at the bottom saw only a button naming a
  // problem with no route out of it — and reached for the reading three times,
  // which is the one thing that cannot work.
  const blockHere = el('div');
  const publishBtn = el('button', { class: 'btn btn--block', type: 'button' });

  /**
   * EVERYTHING a changed reading invalidates, repainted from ONE place.
   *
   * It used to be three separate patches inside the row handler — totals,
   * subtitle, button label — each updating a different subset, and one of them
   * counting from the whole building rather than the billable flats. That is
   * how the button came to read "Publish 89 bills" directly above a note saying
   * it would make 88 bills visible, while the outlier list still quoted a flat
   * at a figure the treasurer had just corrected. The button also silently
   * overwrote its own blocked state, so it looked live while refusing to click.
   *
   * The review step has at least six surfaces derived from the readings. A
   * screen that disagrees with itself about how many bills it is about to send
   * is worse than one that simply refuses.
   */
  const repaint = () => {
    const odd = outliers();
    oddSlot.replaceChildren(...(odd.length ? [el('div', { class: 'note note--warn' },
      el('b', {}, `${odd.length} reading${odd.length > 1 ? 's look' : ' looks'} wrong for the flat.`),
      el('p', {}, odd.slice(0, 6).map((f) =>
        `${f.flat} — ${kg(consumptionOf(f))}, ${money(amountOf(f))}`).join(' · ')
        + (odd.length > 6 ? ` …and ${odd.length - 6} more` : '')),
      // A transposed digit — 15.405 typed as 65.405 — passes every check the
      // portal has: the meter still went up, the rate is fine, the month is
      // complete. It shows up only as one flat billed fifty times its usual,
      // and the person publishing is reading a total, not 89 rows.
      el('p', { class: 'small' },
        'Worth a call to the caretaker before publishing. Once bills exist, a '
        + 'correction needs two other admins.'))] : []));

    const stuck = ownerless();
    // Named individually up to a point, then counted. "7A, 9C has nobody on
    // record" is wrong twice over, and a button whose label grows with the list
    // stops being a button anybody can read.
    const names = stuck.map((f) => f.flat);
    const listed = names.length > 6
      ? `${names.slice(0, 6).join(', ')} and ${names.length - 6} more`
      : names.join(', ');

    blockHere.replaceChildren(...(stuck.length ? [el('div', { class: 'note note--bad' },
      el('b', {}, names.length === 1
        ? `${listed} has nobody on record.`
        : `${names.length} flats have nobody on record: ${listed}.`),
      el('p', {}, 'A reading cannot fix this. Any reading produces a bill, and a '
        + 'bill needs somebody to send it to. Occupancy is set on Residents.'),
      // The readings are not at risk, and saying so is the difference between
      // going to fix it now and putting the whole month off. It is only true
      // because the draft IS the readings plus the rate, both already saved.
      el('p', { class: 'small' },
        'Nothing here is lost by going there. The readings and the rate are '
        + 'already saved, and this draft will be as you left it.'),
      el('p', { style: 'margin-top:var(--s-3)' },
        el('a', { class: 'btn btn--sm', href: '#residents' },
          names.length === 1
            ? `Put a resident back on ${names[0]}`
            : `Put residents back on ${names.length} flats`)))] : []));

    publishBtn.disabled = stuck.length > 0;
    // Plural, like the label above it. "8B, 9E, 11D has nobody to bill" is
    // wrong twice over, and a tooltip is exactly where a mismatch like that
    // survives — the visible label was pluralised and this was not.
    publishBtn.title = stuck.length
      ? `${listed} ${stuck.length > 1 ? 'have' : 'has'} nobody to bill.`
      : '';
    publishBtn.textContent = stuck.length
      ? `${stuck.length} flat${stuck.length > 1 ? 's have' : ' has'} nobody to bill`
      : `Publish ${billable().length} bills · ${money(totalAmount())}`;

    totalsSlot.replaceChildren(
      tile('Flats', String(billable().length)),
      tile('Gas', kg(Math.round(totalKg() * 100) / 100)),
      tile('Rate', `₹${grid.rate.toFixed(2)}`),
      tile('Total', money(totalAmount()), true));

    const sub = root.querySelector('.step[data-step="3"] .step__sub');
    if (sub) sub.textContent = reviewSub();

    const willSay = root.querySelector('.publish-note');
    if (willSay) {
      willSay.replaceChildren(
        el('b', {}, `Publishing emails ${billable().length - noEmail().length} residents `
          + `and makes ${billable().length} bills visible.`),
        el('p', {}, `Due ${dayLabel(grid.dueDate)}. `
          + 'After this, the readings are the building’s archive and a correction '
          + 'needs two other admins.'));
    }
  };

  publishBtn.addEventListener('click', async () => {
    if (ownerless().length) return;
    const gap = noEmail().length;
    // ASKED IN THE PAGE, never window.confirm. A browser that has suppressed
    // dialogs returns false at once, so the button does nothing, says nothing
    // and sends nothing — which reached production on the notice board's
    // Withdraw. Publishing a building's bills is a worse place for that bug.
    const ok = await askFirst(publishAsk,
      `Publish ${billable().length} bills totalling ${money(totalAmount())}? `
      + `${billable().length - gap} residents get an email, and ${gap} have no `
      + 'address on file. This is the point residents see their bill.',
      `Yes, publish ${billable().length} bills`, 'Not yet');
    if (!ok) return;

    publishBtn.disabled = true;
    try {
      await flush();
      const result = await api.admin.publish(period);
      trackAction('admin.billing.publish');
      periods = (await api.admin.periods()).periods ?? [];
      await reload(0);
      // Straight into the sending, because a month that is published and not
      // yet announced looks finished and has told nobody.
      await drain(result.announcements?.queued ?? 0);
      root.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (err) {
      publishBtn.disabled = false;
      showError(publishAsk, err);
    }
  });

  setTimeout(repaint, 0);

  const gap = noEmail();

  return el('div', { class: 'stack' },
    // FIRST, because it is the one thing here that stops the month.
    ownerless().length ? el('div', { class: 'note note--bad' },
      el('b', {}, `${ownerless().length} flat${ownerless().length > 1 ? 's are' : ' is'} `
        + 'being billed with nobody on file.'),
      el('p', {}, `${ownerless().map((f) => f.flat).join(', ')} `
        + `${ownerless().length > 1 ? 'have' : 'has'} a reading and a rate, and no `
        + 'resident to bill.'),
      // THE PLAUSIBLE WRONG MOVE, named as wrong. The obvious remedy is to
      // enter last month's figure and bill the flat at zero — and it cannot
      // work, because the blocker tests occupancy, not consumption. The portal
      // taught the instinct: PATCH /api/admin/flats/:flat refuses to stop
      // billing a flat that already has a reading with those very words, for a
      // different problem. Listing the right options does not stop anybody
      // trying the other one.
      el('p', {}, el('b', {}, 'Entering a reading will not clear this'),
        ', not even last month’s figure. That bills the flat at zero, and a '
        + 'zero bill still has to reach somebody.'),
      el('p', {}, 'The month can be published once somebody is on record, or once '
        + 'the flat stops being billed. Both are on ',
        el('a', { class: 'linkish', href: '#residents' }, 'Residents'),
        ' — occupancy is set there, not here.')) : null,

    el('div', { class: 'note' },
      el('b', {}, 'Nothing here has reached a resident.'),
      el('p', {}, 'This is a draft. It is saved, so you can close the laptop and any '
        + 'admin can pick it up. Fix a reading and the amount beside it recalculates. '
        + 'Residents see nothing until you publish.')),

    totalsSlot,
    el('p', { class: 'small muted' },
      'Check that total against the supplier invoice before you publish.'),

    oddSlot,

    gap.length ? el('div', { class: 'note' },
      el('b', {}, `${billable().length - gap.length} of ${billable().length} residents `
        + 'will get an email.'),
      el('p', {}, `No address on file for ${gap.map((f) => f.flat).join(', ')}. `
        + 'Their bills publish all the same — they will need telling by hand, and '
        + 'the numbers to do it appear here once the month is published.')) : null,

    el('div', { class: 'scroll-x' },
      el('table', { class: 'grid' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Flat'), el('th', {}, 'Previous'), el('th', {}, 'Reading'),
          el('th', {}, 'Used'), el('th', { class: 'r' }, 'Owes'), el('th', {}, ''))),
        el('tbody', {}, ...grid.flats.map((f) => reviewRow(f, repaint))))),

    el('div', { class: 'note note--good publish-note' }),

    // The blocker REPEATED at the refusal. Correct copy in the wrong place is
    // not copy anybody reads: the explanation sat at the top of a very long
    // step while the person was at the bottom, looking at a disabled button
    // that named a problem and offered no route out of it.
    blockHere,
    publishAsk,
    publishBtn);
}

function tile(label, value, big = false) {
  return el('div', { class: 'total' },
    el('span', { class: 'total__k' }, label),
    el('span', { class: `total__v${big ? ' total__v--big' : ''}` }, value));
}

function reviewRow(f, repaint) {
  const c = consumptionOf(f);
  // The amount reads as a fact, not a box — which is the whole signal. It is
  // derived and never typed, and a padlock repeated 89 times down a money
  // column was read as a rendering fault, which is worse than saying nothing.
  const amountCell = el('td', { class: 'amount' },
    el('span', { class: 'amount__locked' }, f.residentId == null ? '—' : money(amountOf(f))));
  const usedCell = el('td', { class: 'used' }, c == null ? '—' : kg(c));
  const message = el('span', { class: 'msg__text' });
  const saved = el('span', { class: 'msg__saved' });

  const input = el('input', {
    class: 'input cell num', type: 'text', inputmode: 'decimal',
    'data-flat': f.flat, value: f.reading ?? '',
    'aria-label': `Reading for flat ${f.flat}`,
  });

  const revalue = () => {
    const value = Number(input.value);
    input.classList.remove('input--error', 'input--warn');
    message.className = 'msg__text';
    message.textContent = '';

    if (!Number.isFinite(value) || (f.previous != null && value < f.previous && !f.meterChange)) {
      input.classList.add('input--error');
      message.classList.add('msg--error');
      message.textContent = `Meters don't go down. Last month was ${f.previous}.`;
      return;
    }
    f.reading = value;
    const now = consumptionOf(f);
    usedCell.textContent = kg(now);
    amountCell.replaceChildren(el('span', { class: 'amount__locked' },
      f.residentId == null ? '—' : money(amountOf(f))));

    if (f.average != null && (now > f.average * JUMP_MULTIPLE
        || (now > 0 && now * JUMP_MULTIPLE < f.average))) {
      input.classList.add('input--warn');
      message.classList.add('msg--warn');
      message.textContent = `Usually about ${kg(f.average)}`;
    }

    pending.set(f.flat, value);
    indicators.set(f.flat, saved);
    saved.className = 'msg__saved muted';
    saved.textContent = 'saving…';
    scheduleFlush();

    // ONE call, and nothing else. Everything a corrected reading invalidates
    // lives in repaint.
    repaint();
  };
  input.addEventListener('change', revalue);

  if (f.average != null && c != null
      && (c > f.average * JUMP_MULTIPLE || (c > 0 && c * JUMP_MULTIPLE < f.average))) {
    input.classList.add('input--warn');
    message.classList.add('msg--warn');
    message.textContent = `Usually about ${kg(f.average)}`;
  }

  return el('tr', {},
    el('td', { class: 'flat' }, f.flat),
    el('td', { class: 'prev' }, f.previous == null ? '—' : f.previous),
    el('td', {}, input),
    usedCell,
    amountCell,
    el('td', { class: 'msg' },
      el('span', { class: 'msg__row' }, message, saved,
        f.residentId == null
          ? el('span', { class: 'msg--error' }, 'nobody on file')
          : !emails.get(f.residentId)
            ? el('span', { class: 'muted' }, 'no email')
            : null)));
}

/* ── the published month ─────────────────────────────────────────────────── */

/**
 * Sending the announcements, 20 at a time, behind a progress bar.
 *
 * 89 EMAILS WILL NOT FIT IN ONE REQUEST. `sendEmail` refreshes an OAuth token
 * per send against a 50-subrequest cap, so the outbox exists and this is the
 * loop that drains it — see functions/lib/announce.js. Interrupting it costs
 * nothing: every row's status is written as its send returns, and the 3am cron
 * sweeps whatever is left, so the treasurer can close the laptop.
 */
async function drain(expected) {
  const bar = root.querySelector('.announce__fill');
  const label = root.querySelector('.announce__label');
  if (!bar || !expected) return;

  let sentSoFar = 0;
  // Bounded rather than `while (remaining)`. A drain that stops making progress
  // — Gmail refusing every message — would otherwise loop until the tab was
  // closed, sending nothing and saying nothing.
  const rounds = Math.ceil(expected / DRAIN_SIZE) + 1;
  for (let i = 0; i < rounds; i += 1) {
    let res;
    try {
      res = await api.admin.announce(period);
    } catch (err) {
      if (label) label.textContent = err?.message ?? 'Sending stopped. The 3am sweep will finish it.';
      break;
    }
    sentSoFar += res.sent;
    if (bar) bar.style.width = `${Math.round((sentSoFar / expected) * 100)}%`;
    if (label) label.textContent = `${sentSoFar} of ${expected} sent`;
    if (!res.remaining || (!res.sent && !res.failed)) break;
  }

  announcements = await api.admin.announcements(period).catch(() => announcements);
  render();
}

function publishedCard() {
  const counts = announcements?.counts ?? { sent: 0, queued: 0, unreachable: 0, failed: 0, remaining: 0 };
  const unreachable = announcements?.unreachable ?? [];
  const told = counts.sent;
  const total = billable().length;
  const chaseSlot = el('div');
  const priceSlot = el('div');
  const nextSlot = el('div');

  return el('section', { class: 'step', 'data-state': 'open' },
    el('div', { class: 'step__head step__head--static' },
      el('span', { class: 'step__n' }, '✓'),
      el('span', { class: 'step__label' },
        el('span', { class: 'step__title' }, `${periodLabel(period)}, published`),
        el('span', { class: 'step__sub' },
          'Readings are the archive now. Corrections need two other admins.'))),

    el('div', { class: 'step__body' }, el('div', { class: 'stack' },

      // Sending, and how far it has got. Shown even when finished, because "did
      // the emails go" is the first thing anybody asks after publishing.
      el('div', { class: 'note' },
        el('b', {}, `${told} of ${total} residents were emailed.`),
        counts.remaining
          ? el('div', { class: 'stack', style: 'gap:var(--s-2);margin-top:var(--s-2)' },
              el('span', { class: 'progress' },
                el('span', { class: 'progress__track' },
                  el('span', {
                    class: 'progress__fill announce__fill',
                    style: `width:${total ? Math.round((told / total) * 100) : 0}%`,
                  })),
                el('span', { class: 'progress__label announce__label' },
                  `${counts.remaining} still to send`)),
              el('div', { class: 'row' },
                el('button', {
                  class: 'btn btn--sm', type: 'button',
                  onclick: (event) => {
                    event.currentTarget.disabled = true;
                    return drain(counts.remaining);
                  },
                }, 'Send the rest now'),
                el('span', { class: 'small muted' },
                  'Or leave it — the 3am sweep finishes anything still waiting, '
                  + 'and nobody is ever sent the same bill twice.')))
          : null,
        counts.failed
          ? el('p', { class: 'small' },
              `${counts.failed} could not be delivered. They are retried nightly, `
              + 'three times, and then left for a human.')
          : null,
        unreachable.length
          ? el('p', {}, `${unreachable.length} have no address on file, so `,
              el('button', {
                class: 'linkish', type: 'button',
                onclick: () => togglePanel(chaseSlot, () => unreachablePanel(unreachable)),
              }, 'they need telling by hand'), '.')
          : null,
        chaseSlot),

      el('div', { class: 'note note--warn' },
        el('b', {}, 'Money does not move on one person’s say-so.'),
        el('p', {}, 'A correction here goes to two other admins and applies when they '
          + 'agree — if the bill belongs to an admin, every other admin has to agree. '
          + 'That bill’s late fee is frozen while it waits. You cannot approve your own.')),

      // The month-wide half of the correction rule.
      el('div', { class: 'note' },
        el('b', {}, 'Was the price of gas wrong?'),
        el('p', {}, 'That is not a correction to one bill. It recalculates every bill '
          + `in ${periodLabel(period)}, so it is done once, here, rather than `
          + `${total} times.`),
        el('p', { style: 'margin-top:var(--s-3)' },
          el('button', {
            class: 'btn btn--sm btn--quiet', type: 'button',
            onclick: () => togglePanel(priceSlot, () => pricePanel(priceSlot)),
          }, `Correct ${periodLabel(period)}’s price of gas`)),
        priceSlot),

      el('div', { class: 'scroll-x' },
        el('table', { class: 'grid' },
          el('thead', {}, el('tr', {},
            el('th', {}, 'Flat'), el('th', {}, 'Reading'), el('th', {}, 'Used'),
            el('th', { class: 'r' }, 'Owes'), el('th', {}, ''))),
          el('tbody', {}, ...billable().map(publishedRow)))),

      // Where the next month starts. Without it a published month is a dead
      // end: the tab shows only the month in hand, and the month in hand is
      // finished.
      el('div', { class: 'row' },
        el('button', {
          class: 'btn btn--quiet', type: 'button',
          onclick: async () => {
            period = nextMonth(period);
            await reload(1);
          },
        }, `Start ${periodLabel(nextMonth(period))}`),
        el('span', { class: 'small muted' },
          'Sets next month’s price of gas and opens its meter walk.')),
      nextSlot)));
}

/**
 * A panel that unfolds IN PLACE, pushing the rest down.
 *
 * No overlay. Every other disclosure in this portal is a fold, and one screen
 * with its own idiom is a second idiom to maintain — the same reasoning
 * foldedSection carries. It matters more here than usual: these panels are
 * about figures on the page behind them, which an overlay would cover.
 */
function togglePanel(slot, build) {
  if (slot.hasChildNodes()) { slot.replaceChildren(); return; }
  slot.replaceChildren(build());
  slot.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/**
 * The flats nobody could email, with one tappable number each.
 *
 * AFTER PUBLISHING ONLY. Before it there is no bill to tell anyone about, and a
 * message quoting a figure that could still change is worse than no message.
 *
 * Every resident has a mobile — `owners.mobile` is NOT NULL UNIQUE because it
 * is the login id — so the households that cannot be emailed can always be
 * WhatsApped. That is what turns the missing-address gap from a dead end into a
 * short list of taps.
 */
function unreachablePanel(rows) {
  return el('div', { class: 'stack', style: 'margin-top:var(--s-3)' },
    el('p', { class: 'small muted' },
      'No email on file, so nothing reached them when the month was published. '
      + 'Every resident has a mobile — it is their login — so WhatsApp is the way in.'),
    el('div', { class: 'contact' }, ...rows.map((r) => el('div', { class: 'contact__row' },
      el('span', { class: 'contact__flat' }, r.flat),
      el('span', { class: 'contact__who' }, r.name ?? '—',
        el('span', {}, r.relationship === 'tenant' ? 'Tenant' : 'Owner', ` · ${r.mobile}`)),
      el('span', { class: 'small muted' }, money(r.total)),
      el('a', {
        class: 'btn btn--sm', target: '_blank', rel: 'noopener',
        href: waHref(r),
      }, 'WhatsApp')))),
    el('p', { class: 'small muted' },
      'The message names the association, the amount and the due date. It carries '
      + 'no payment link, so nobody is taught to pay from a chat message.'));
}

/**
 * A wa.me link that works.
 *
 * Bare digits, no '+', matching waLink() in functions/lib/tenancy.js — the trap
 * being that mobiles have been stored in E.164 since migration 0009, and the
 * old `wa.me/91${mobile}` produced a dead link for every one of them.
 *
 * NO PAYMENT LINK, deliberately, and this should not be revisited casually. An
 * unsolicited WhatsApp asking for money is the exact shape of a fraud, and a
 * UPI link in a chat teaches residents to pay from messages. B19 independently
 * found that `upi://` links do not survive Gmail or resolve reliably anyway.
 */
function waHref(r) {
  const text = `DD Diamond Park: your ${periodLabel(period)} gas bill is `
    + `${money(r.total)}, due ${dayLabel(grid.dueDate)}. `
    + 'The full working is on the portal: diamondpark.pages.dev';
  return `https://wa.me/${String(r.mobile).replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

function publishedRow(f) {
  const slot = el('td', { colspan: 5 });
  const wrapper = el('tr', { hidden: true }, slot);

  return [el('tr', {},
    el('td', { class: 'flat' }, f.flat),
    el('td', { class: 'prev' }, String(f.reading)),
    el('td', { class: 'used' }, kg(consumptionOf(f))),
    el('td', { class: 'amount' }, el('span', { class: 'amount__locked' }, money(amountOf(f)))),
    el('td', {}, el('button', {
      class: 'btn btn--sm btn--quiet', type: 'button',
      onclick: () => {
        if (!wrapper.hidden) { wrapper.hidden = true; slot.replaceChildren(); return; }
        wrapper.hidden = false;
        slot.replaceChildren(readingPanel(f, () => {
          wrapper.hidden = true;
          slot.replaceChildren();
        }));
      },
    }, 'Correct the reading'))),
    wrapper];
}

/**
 * Correcting one flat's reading on a published month.
 *
 * THE READING, never the amount. The amount is shown moving as the reading is
 * typed, which is the point: every rupee traces to a meter reading and a rate,
 * and what goes for approval is the corrected reading and the total it
 * produces rather than a total somebody chose.
 */
function readingPanel(f, close) {
  const reading = el('input', {
    class: 'input num', inputmode: 'decimal', value: f.reading,
    id: `b-fix-${f.flat}`,
  });
  const why = el('input', {
    class: 'input', placeholder: 'Why is it changing?', id: `b-why-${f.flat}`,
  });
  const preview = el('p', { class: 'small muted' });
  const status = el('div');

  const recalc = () => {
    const v = Number(reading.value);
    if (!Number.isFinite(v) || (f.previous != null && v < f.previous && !f.meterChange)) {
      preview.textContent = `A meter cannot read below last month’s ${f.previous}.`;
      return;
    }
    const c = consumptionOf({ ...f, reading: v });
    const next = Math.ceil(Math.round(c * grid.rate * 100) / 100);
    preview.textContent = `${kg(c)} at ₹${grid.rate.toFixed(2)} — `
      + `${money(amountOf(f))} becomes ${money(next)}.`;
  };
  reading.addEventListener('input', recalc);
  setTimeout(recalc, 0);

  return el('div', { class: 'correct stack' },
    el('p', { class: 'label' }, `Correct ${f.flat} · ${periodLabel(period)}`),
    el('div', { class: 'billfields' },
      el('div', { class: 'field' },
        el('label', { for: `b-fix-${f.flat}` }, 'Meter reading'), reading),
      el('div', { class: 'field' },
        el('label', { for: `b-why-${f.flat}` }, 'Reason'), why,
        el('span', { class: 'field__hint' },
          'Recorded against your name, and shown to whoever approves.'))),
    preview,
    status,
    el('div', { class: 'row' },
      el('button', {
        class: 'btn btn--sm', type: 'button',
        onclick: async (event) => {
          if (!why.value.trim()) { why.classList.add('input--error'); why.focus(); return; }
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const res = await api.admin.correctReading(f.billId, Number(reading.value), why.value);
            trackAction('admin.billing.correct-reading');
            // SAID HERE, not only in the margin. "Correct the reading" reads
            // like a button that corrects the reading; it does not, and an
            // admin who assumes it did will tell the resident their bill has
            // changed when it has not.
            status.replaceChildren(el('div', { class: 'note note--warn' },
              res.unchanged
                ? 'That is already the reading.'
                : `Not changed yet. ${f.flat} ${periodLabel(period)}: `
                  + `${money(res.totalBefore)} → ${money(res.totalAfter)}. `
                  + `${res.required} other admins will be asked to agree, under `
                  + 'Home → Approvals. You cannot approve your own, and this bill’s '
                  + 'late fee is frozen until it is decided.'));
            button.disabled = false;
          } catch (err) {
            button.disabled = false;
            showError(status, err);
          }
        },
      }, 'Send for approval'),
      el('button', { class: 'btn btn--sm btn--quiet', type: 'button', onclick: close },
        'Cancel')));
}

/**
 * Correcting the month's price of gas — every bill in it.
 *
 * The consequence is on screen BEFORE it happens rather than discovered
 * afterwards, and it is the server's own count of whose bill changes and who
 * ends up owing again, not a guess: the dry run runs the same planRateChange
 * the approval will run.
 *
 * A published month's price is corrected ONCE, for the whole month. It is not a
 * per-flat rate — one flat billed at a different rate than its neighbours would
 * mean the month no longer reconciles against a single supplier invoice.
 */
function pricePanel(slot) {
  const rate = el('input', {
    class: 'input num', inputmode: 'decimal', value: grid.rate.toFixed(2), id: 'b-price',
  });
  const why = el('input', {
    class: 'input', placeholder: 'Why is the price changing?', id: 'b-price-why',
  });
  const impact = el('div');
  const status = el('div');

  const check = async () => {
    const v = Number(rate.value);
    if (!Number.isFinite(v) || v <= 0) {
      impact.replaceChildren(el('p', { class: 'small msg--error' }, 'That is not a price.'));
      return;
    }
    try {
      const plan = await api.admin.correctPrice(period, v, why.value || 'checking', true);
      if (plan.unchanged) {
        // Equality is its own case. Falling through to "cheaper" told the
        // treasurer that twelve paid bills were about to change while the panel
        // showed the same figure on both sides of the sentence.
        impact.replaceChildren(el('div', { class: 'note' },
          el('b', {}, `That is already ${periodLabel(period)}’s price. Nothing changes.`)));
        return;
      }
      const t = plan.totals;
      impact.replaceChildren(el('div', { class: `note ${t.owesAgainCount ? 'note--bad' : 'note--warn'}` },
        el('b', {}, `Every bill in ${periodLabel(period)} is recalculated: `
          + `${money(t.totalBefore)} becomes ${money(t.totalAfter)}.`),
        t.owesAgainCount
          ? el('p', {}, `${t.owesAgainCount} of them are already paid and get dearer. `
              + `Those residents will owe ${money(t.owesAgainTotal)} more between them, `
              + 'their bills return to unpaid, and they will have to pay again.')
          : null,
        t.inCreditCount
          ? el('p', {}, `${t.inCreditCount} already-paid bill${t.inCreditCount === 1 ? '' : 's'} `
              + `get cheaper, leaving ${money(t.inCreditTotal)} in credit. Those stay marked paid.`)
          : null,
        t.skipped
          ? el('p', {}, `${t.skipped} bill${t.skipped === 1 ? '' : 's'} carrying a typed `
              + 'amount will be left alone — they no longer follow the rate.')
          : null,
        el('p', {}, 'The month also has to be reconciled against the bank statement '
          + 'a second time.')));
    } catch (err) {
      showError(impact, err);
    }
  };
  rate.addEventListener('change', check);
  setTimeout(check, 0);

  return el('div', { class: 'correct stack' },
    el('p', { class: 'label' }, `Price of gas · ${periodLabel(period)}`),
    el('div', { class: 'billfields' },
      el('div', { class: 'field' }, el('label', { for: 'b-price' }, 'Rate per kg'), rate),
      el('div', { class: 'field' }, el('label', { for: 'b-price-why' }, 'Reason'), why,
        el('span', { class: 'field__hint' }, 'Recorded against your name.'))),
    impact,
    status,
    el('div', { class: 'row' },
      el('button', {
        class: 'btn btn--sm', type: 'button',
        onclick: async (event) => {
          if (!why.value.trim()) { why.classList.add('input--error'); why.focus(); return; }
          const v = Number(rate.value);
          if (!Number.isFinite(v) || v <= 0) { rate.classList.add('input--error'); rate.focus(); return; }
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const res = await api.admin.correctPrice(period, v, why.value, false);
            trackAction('admin.billing.correct-price');
            status.replaceChildren(el('div', { class: 'note note--warn' },
              res.unchanged
                ? 'That is already the price.'
                : `Not changed yet. ${res.required} other admins will be asked to agree, `
                  + 'under Home → Approvals. Nothing has moved on any resident’s screen.'));
            button.disabled = false;
          } catch (err) {
            button.disabled = false;
            showError(status, err);
          }
        },
      }, 'Send for approval'),
      el('button', {
        class: 'btn btn--sm btn--quiet', type: 'button',
        onclick: () => slot.replaceChildren(),
      }, 'Cancel')));
}
