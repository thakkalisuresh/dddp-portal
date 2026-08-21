/**
 * God edit — change anything about anyone, and about any bill.
 *
 * Superadmin only, enforced on the server; the check here only decides what to
 * draw. Every save is a single field, because a whole-form save makes the
 * audit trail say "edited resident 4A" when what matters is which value moved
 * and what it was before.
 *
 * The fields look like text until you touch one. This page is a record of the
 * building rather than a form to fill in, and making every value permanently
 * look like an input invites accidental edits on a page where an accident is
 * expensive.
 */

import { api, ApiError } from './api.js';
import { renderNav } from './nav.js';
import { trackPage, trackAction } from './track.js';
import { $, el, esc, renderViewBanner, showError, setChildren } from './ui.js';
import { money, periodLabel } from './i18n.js';

const main = $('#main');
let tab = 'people';
// What the server said about the last save. A save reloads and re-renders, so
// an inline message would be wiped by the thing that produced it; this is held
// across the render and drawn once.
let flash = null;
let data = { people: [], bills: [], edits: [], health: null };

trackPage('/god/edit');
init();

async function init() {
  try {
    const me = await api.me();
    if (me.role !== 'superadmin') {
      main.replaceChildren(el('div', { class: 'note note--bad' }, 'Superadmin only.'));
      return;
    }
    $('#who').innerHTML = `Edit anything <span>· ${esc(me.name)}</span>`;
    renderViewBanner(me, { onExit: async () => { await api.god.exit(); location.reload(); } });
    renderNav(me, '/god');
    await load();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login'; return; }
    showError(main, err);
  }
}

async function load() {
  const [people, bills, edits, health] = await Promise.all([
    api.god.people(), api.god.bills(), api.god.edits('?limit=100'),
    api.god.diagnostics('?md=1'),
  ]);
  data = { people: people.people, bills: bills.bills, edits: edits.edits, health };
  render();
}

function render() {
  setChildren(main,
    el('div', { class: 'tabs' },
      tabButton('people', `People (${data.people.length})`),
      tabButton('bills', `Bills (${data.bills.length})`),
      tabButton('log', `What I've changed (${data.edits.length})`),
      tabButton('meters', 'Meters'),
      tabButton('health', healthLabel())),
    el('div', { class: 'panel', style: 'padding:var(--s-3) var(--s-4)' },
      el('p', { class: 'small muted' }, blurb())),
    takeFlash(),
    ...body()
  );
}

/** Drawn once, then forgotten, so it does not follow you between tabs. */
function takeFlash() {
  if (!flash) return null;
  const { kind, text } = flash;
  flash = null;
  return el('div', { class: `note note--${kind}`, style: 'margin:var(--s-3) 0' }, text);
}

/**
 * The reason, asked for IN THE PAGE.
 *
 * It was a `prompt()`. A browser with dialogs suppressed returns null from it,
 * which this code read as "cancelled" — so the value snapped back to what it
 * was, silently, and the edit looked broken rather than refused. Same family
 * as the notice-board Withdraw button, and the same answer: ask in the page.
 *
 * askFirst() in ui.js is the wrong shape here, because a reason is text rather
 * than a yes. This is that idiom with a field: the question, an input, the
 * committing button, and the way out as the quiet one.
 *
 * Resolves to the reason, or to null if they backed out.
 */
function askReason(wrap, name, original, next) {
  return new Promise((resolve) => {
    const input = el('input', {
      class: 'input', placeholder: 'Why is this changing?',
      'aria-label': `Reason for changing ${name}`,
    });
    const finish = (value) => { panel.remove(); resolve(value); };
    const commit = () => {
      if (!input.value.trim()) { input.classList.add('input--error'); input.focus(); return; }
      finish(input.value.trim());
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });

    const panel = el('div', {
      class: 'note note--warn stack', role: 'alertdialog',
      style: 'gap:var(--s-2); margin-top:var(--s-2)',
    },
      el('p', { class: 'small' },
        `${name}: ${original} \u2192 ${next}. Money always needs a reason, and the `
        + 'server refuses the edit without one.'),
      input,
      el('div', { class: 'row', style: 'gap:var(--s-3); flex-wrap:wrap' },
        el('button', { class: 'btn btn--sm', type: 'button', onclick: commit }, 'Save the change'),
        el('button', { class: 'linkish small', type: 'button', onclick: () => finish(null) },
          'Leave it as it was')));

    wrap.append(panel);
    input.focus();
  });
}

function blurb() {
  if (tab === 'people') {
    return 'Change any detail. Mobile is the login number and accepts a country code '
         + 'for owners abroad. Every change is recorded with what it was before.';
  }
  if (tab === 'bills') {
    return 'Editing a component recalculates the total. Editing the total directly '
         + 'overrides it and the bill is marked so. The components are left as metered. '
         + 'Money edits need a reason.';
  }
  if (tab === 'health') {
    return 'The building\u2019s invariants, checked against live data. The same checks '
         + 'run from the command line with: npm run doctor';
  }
  return 'Every edit made here, newest first. This log cannot be edited from the portal.';
}

/* ── health ──────────────────────────────────────────────────────────────── */

function healthBody() {
  const h = data.health;
  if (!h) return [el('p', { class: 'muted', style: 'padding:var(--s-4)' }, 'Could not run the checks.')];

  const copy = el('button', { class: 'btn btn--ghost', type: 'button' }, 'Copy report');
  copy.addEventListener('click', async () => {
    // The whole point of the report is that it can be pasted somewhere else,
    // so the button matters as much as the checks.
    await navigator.clipboard.writeText(h.markdown ?? '');
    copy.textContent = 'Copied';
    setTimeout(() => { copy.textContent = 'Copy report'; }, 2000);
  });

  const head = el('div', { class: 'rec' },
    el('div', { class: 'rec__head' },
      el('span', { class: 'rec__flat' },
        h.summary.healthy ? 'Everything checks out'
                          : `${h.summary.fail} failing \u00b7 ${h.summary.warn} warnings`),
      el('span', { class: 'rec__meta' },
        Object.entries(h.meta.counts).map(([k, v]) => `${v} ${k}`).join(' \u00b7 ')),
      copy));

  return [head, ...h.findings.map(findingRow),
    ...(h.errors.length ? [errorsPanel(h.errors)] : [])];
}

function findingRow(f) {
  const tone = f.severity === 'fail' ? 'flag--bad'
             : f.severity === 'warn' ? 'flag--manual' : '';
  return el('div', { class: 'rec' },
    el('div', { class: 'rec__head' },
      el('span', { class: `flag ${tone}` }, f.severity),
      el('span', { class: 'rec__flat' }, f.title),
      el('span', { class: 'rec__meta' }, f.id)),
    el('p', { class: 'rec__meta', style: 'margin-top:var(--s-1)' }, f.detail),
    ...f.rows.slice(0, 10).map((r) =>
      el('p', { class: 'rec__meta', style: 'margin-top:2px' },
        Object.entries(r).map(([k, v]) => `${k}=${v}`).join('  \u00b7  '))),
    f.rows.length > 10
      ? el('p', { class: 'rec__meta' }, `\u2026${f.rows.length - 10} more`)
      : null);
}

function errorsPanel(errors) {
  return el('div', { class: 'rec' },
    el('div', { class: 'rec__head' }, el('span', { class: 'rec__flat' }, 'Recent errors')),
    ...errors.slice(0, 15).map((e) =>
      el('p', { class: 'rec__meta', style: 'margin-top:2px' },
        `${e.atIST ?? e.at}  ${e.code}  ${e.message}`)));
}

function tabButton(id, label) {
  return el('button', {
    class: `tab ${tab === id ? 'is-on' : ''}`, type: 'button',
    onclick: () => { tab = id; render(); },
  }, label);
}

function healthLabel() {
  const s = data.health?.summary;
  if (!s) return 'Health';
  if (s.fail) return `Health · ${s.fail} failing`;
  if (s.warn) return `Health · ${s.warn} warnings`;
  return 'Health · ok';
}

function body() {
  if (tab === 'people') return data.people.map(personRow);
  if (tab === 'bills')  return data.bills.map(billRow);
  if (tab === 'meters') return metersBody();
  if (tab === 'health') return healthBody();
  return data.edits.length
    ? data.edits.map(editRow)
    : [el('p', { class: 'muted', style: 'padding:var(--s-4)' }, 'Nothing has been edited yet.')];
}

/* ── meters ──────────────────────────────────────────────────────────────── */

/**
 * A replaced meter. Here rather than on the readings screen on purpose: this
 * restates what a month's consumption MEANS, it happens perhaps once in three
 * years, and a control that rare sitting on a monthly screen is one the
 * treasurer learns to scroll past.
 *
 * The readings themselves are never touched. This sits beside them and is
 * consulted for the one month the swap falls in, which is what keeps the
 * resident's history and the archive honest.
 */
function metersBody() {
  const flat = el('input', { class: 'input', placeholder: '12F', id: 'mc-flat' });
  const period = el('input', { class: 'input', placeholder: '2026-07', id: 'mc-period' });
  const oldFinal = el('input', { class: 'input num', placeholder: '19.900', id: 'mc-old', inputmode: 'decimal' });
  const newStart = el('input', { class: 'input num', value: '0', id: 'mc-new', inputmode: 'decimal' });
  const changedOn = el('input', { class: 'input', type: 'date', id: 'mc-on' });
  const note = el('input', { class: 'input', placeholder: 'Reported by the caretaker', id: 'mc-note' });
  const status = el('div');
  const listing = el('div', { class: 'stack small' });

  const refresh = async () => {
    if (!/^\d{4}-\d{2}$/.test(period.value)) { listing.replaceChildren(); return; }
    try {
      const { changes } = await api.god.meterChanges(period.value);
      listing.replaceChildren(
        el('p', { class: 'label' }, `Recorded for ${periodLabel(period.value)}`),
        ...(changes.length
          ? changes.map((c) => el('div', {},
              el('b', {}, c.flat), ` — old meter ended ${c.old_final}, new one started `,
              `${c.new_start}, changed ${c.changed_on}. `,
              el('button', {
                class: 'btn btn--sm btn--ghost', type: 'button',
                onclick: async () => {
                  await api.god.clearMeterChange(c.flat, c.period);
                  await refresh();
                },
              }, 'Remove')))
          : [el('p', { class: 'muted' }, 'None.')])
      );
    } catch (err) { showError(listing, err); }
  };

  period.addEventListener('change', refresh);

  return [
    el('div', { class: 'panel stack', style: 'padding:var(--s-4)' },
      el('h2', {}, 'Meter replaced'),
      el('p', { class: 'small muted' },
        'A new meter starts at zero, so its first reading is lower than last '
        + 'month\'s and the grid refuses it — which stops the whole month '
        + 'generating, not just this flat. Record the swap here and the month '
        + 'bills both halves: what the old meter counted before it came off, '
        + 'plus what the new one has counted since. The readings themselves are '
        + 'left exactly as they were taken.'),

      el('div', { class: 'field' }, el('label', { for: 'mc-flat' }, 'Flat'), flat),
      el('div', { class: 'field' }, el('label', { for: 'mc-period' }, 'Usage month'), period,
        el('span', { class: 'field__hint' }, 'The month the gas was used, e.g. 2026-07.')),
      el('div', { class: 'field' }, el('label', { for: 'mc-old' }, 'Old meter\'s final reading'), oldFinal,
        el('span', { class: 'field__hint' }, 'What it read the day it came off.')),
      el('div', { class: 'field' }, el('label', { for: 'mc-new' }, 'New meter started at'), newStart,
        el('span', { class: 'field__hint' }, 'Usually 0. A refurbished meter may not be.')),
      el('div', { class: 'field' }, el('label', { for: 'mc-on' }, 'Date changed'), changedOn,
        el('span', { class: 'field__hint' },
          'The day it was actually swapped — backdate it. The caretaker often '
          + 'mentions this weeks later.')),
      el('div', { class: 'field' }, el('label', { for: 'mc-note' }, 'Note'), note),
      status,
      el('button', {
        class: 'btn', type: 'button',
        onclick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          status.replaceChildren();
          try {
            await api.god.setMeterChange({
              flat: flat.value, period: period.value,
              oldFinal: Number(oldFinal.value), newStart: Number(newStart.value || 0),
              changedOn: changedOn.value, note: note.value || null,
            });
            trackAction('god.meter-change');
            status.replaceChildren(el('div', { class: 'note note--good' },
              `Recorded. ${flat.value} will bill both meters for ${periodLabel(period.value)}.`));
            await refresh();
          } catch (err) {
            showError(status, err);
          }
          button.disabled = false;
        },
      }, 'Record the change')),
    el('div', { class: 'panel', style: 'padding:var(--s-4)' }, listing),
  ];
}

/* ── people ──────────────────────────────────────────────────────────────── */

function personRow(p) {
  return el('div', { class: 'rec' },
    el('div', { class: 'rec__head' },
      el('span', { class: 'rec__flat' }, p.flat),
      el('span', { class: 'rec__meta' }, p.role),
      p.active ? null : el('span', { class: 'flag flag--bad' }, 'inactive')),
    el('div', { class: 'rec__grid' },
      field(p, 'owner', 'name', 'Name'),
      field(p, 'owner', 'mobile', 'Mobile'),
      field(p, 'owner', 'email', 'Email', { type: 'email', placeholder: 'none' }),
      select(p, 'owner', 'relationship', 'Owner / tenant', ['owner', 'tenant']),
      select(p, 'owner', 'role', 'Role', ['owner', 'committee', 'admin', 'superadmin']),
      select(p, 'owner', 'active', 'Active', [['1', 'Yes'], ['0', 'No']])));
}

/* ── bills ───────────────────────────────────────────────────────────────── */

function billRow(b) {
  return el('div', { class: 'rec' },
    el('div', { class: 'rec__head' },
      el('span', { class: 'rec__flat' }, b.flat),
      el('span', { class: 'rec__meta' }, periodLabel(b.period)),
      el('span', { class: 'rec__meta' }, `${b.consumption} kg @ ${money(b.rate_per_kg)}`),
      b.manual_total
        ? el('span', { class: 'flag flag--manual', title: `Components add up to ${money(b.computed)}` },
            `manual · sum ${money(b.computed)}`)
        : null,
      // An unexplained mismatch is the DDP-BILL-003 condition sitting in data
      // rather than in an alert, so it is worth showing where it can be fixed.
      b.mismatch ? el('span', { class: 'flag flag--bad' }, `does not add up (${money(b.computed)})`) : null),
    el('div', { class: 'rec__grid' },
      field(b, 'bill', 'gas_amount', 'Gas amount', { num: true }),
      field(b, 'bill', 'other_charges', 'Other', { num: true }),
      field(b, 'bill', 'additional_charges', 'Additional', { num: true }),
      field(b, 'bill', 'late_fee', 'Late fee', { num: true }),
      // The total is READ ONLY, here as everywhere — decided 2026-08-20, and
      // the superadmin is not an exception. It is the sum of the components
      // beside it, and the components are the things that can be wrong. A
      // typed total is a bill that no longer matches its own working, which is
      // the DDP-BILL-003 condition arrived at deliberately. `editBill` refuses
      // the field outright, so offering the box would only be a way to meet
      // that refusal.
      readOnly('Total', money(b.total)),
      select(b, 'bill', 'status', 'Status',
             ['unpaid', 'initiated', 'awaiting', 'paid', 'waived'])),
    b.adjust_reason
      ? el('p', { class: 'rec__meta', style: 'margin-top:var(--s-2)' }, `Reason: ${b.adjust_reason}`)
      : null);
}

/** A value that is shown and cannot be changed, in the shape of a field. */
function readOnly(label, value) {
  return el('div', { class: 'cell cell--num' },
    el('span', { class: 'cell__label' }, label),
    el('input', { value, readonly: true, disabled: true, 'aria-label': label }));
}

/* ── one editable value ──────────────────────────────────────────────────── */

function field(row, entity, name, label, { num = false, type = 'text', placeholder = '' } = {}) {
  const input = el('input', {
    type: num ? 'number' : type,
    step: num ? '0.01' : null,
    value: row[name] ?? '',
    placeholder,
    'aria-label': `${label} for ${row.flat}`,
  });
  return cell(label, input, row, entity, name, num);
}

function select(row, entity, name, label, options) {
  const input = el('select', { 'aria-label': `${label} for ${row.flat}` },
    ...options.map((o) => {
      const [value, text] = Array.isArray(o) ? o : [o, o];
      return el('option', { value, selected: String(row[name]) === value ? true : null }, text);
    }));
  return cell(label, input, row, entity, name, false);
}

function cell(label, input, row, entity, name, num) {
  const wrap = el('div', { class: `cell ${num ? 'cell--num' : ''}` },
    el('span', { class: 'cell__label' }, label), input);

  const original = String(row[name] ?? '');
  input.addEventListener('input', () => {
    wrap.classList.toggle('cell--dirty', input.value !== original);
  });
  // Commit on blur or Enter rather than per keystroke: an audit row per
  // character would make the log useless for the thing it is for.
  input.addEventListener('change', () => save(wrap, input, row, entity, name, original));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  return wrap;
}

async function save(wrap, input, row, entity, name, original) {
  if (input.value === original) return;

  // Money always needs a reason; the server enforces it too, but asking here
  // means the edit is not rejected after the fact.
  let reason = null;
  if (entity === 'bill') {
    reason = await askReason(wrap, name, original, input.value);
    if (reason == null) { input.value = original; wrap.classList.remove('cell--dirty'); return; }
  }

  try {
    const fn = entity === 'bill' ? api.god.editBill : api.god.editOwner;
    const res = await fn(row.id, name, input.value, reason);
    trackAction(`god:edit:${entity}.${name}`, { id: row.id });

    wrap.classList.remove('cell--dirty');
    // What the server said about the edit, kept for the render that follows.
    // These were alert()s, which a browser with dialogs suppressed never draws
    // - so the one sentence explaining what the edit actually did to the bill
    // was the sentence most likely to go missing.
    const said = [res.confirm, res.note].filter(Boolean).join(' ');
    if (said) flash = { kind: 'good', text: said };
    // Reload rather than patch in place: a component edit changes the total
    // and the flags, and a half-updated row is how someone reads a stale
    // number and acts on it.
    await load();
  } catch (err) {
    input.value = original;
    wrap.classList.remove('cell--dirty');
    // A failed save that says nothing is indistinguishable from one that
    // worked, since the value reverts either way.
    flash = { kind: 'bad', text: err instanceof ApiError ? err.message : 'Could not save that.' };
    render();
  }
}

/* ── the log ─────────────────────────────────────────────────────────────── */

function editRow(e) {
  const what = e.entity === 'bill'
    ? `${e.flat ?? ''} ${e.period ? periodLabel(e.period) : ''} · ${e.field}`
    : `${e.targetFlat ?? ''} ${e.targetName ?? ''} · ${e.field}`;
  return el('div', { class: 'edit' },
    el('span', { class: 'edit__at' }, e.atIST ?? e.at),
    el('div', {},
      el('div', {}, what.trim()),
      el('div', { class: 'rec__meta' },
        el('span', { class: 'edit__was' }, String(e.before ?? '—')),
        el('span', {}, ` → ${e.after ?? '—'}`),
        e.reason ? el('span', {}, ` · ${e.reason}`) : null,
        e.actor ? el('span', {}, ` · ${e.actor}`) : null)));
}
