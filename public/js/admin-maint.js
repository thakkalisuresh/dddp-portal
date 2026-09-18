/**
 * The Maintenance tab — step 6.
 *
 * Four steps down one page, in the order the quarter actually happens: the
 * rates, which flats are billed, schedule, collect.
 *
 * NOT A WIZARD, deliberately. Every step stays reachable and revisitable, and a
 * finished one shows its RESULT rather than its form. The gas readings screen
 * learned this already — a stepper that traps an admin in order is one they
 * work around — and this reuses its `.step` shell so the two screens feel like
 * one product.
 *
 * Step 2 is the one that matters. It is what stands between the committee and
 * ninety-nine bills at the wrong rate, and its flags BLOCK scheduling: the
 * quarter cannot go out until each flagged tenancy has been resolved or
 * explicitly confirmed. That is the user's own instruction and it is not a
 * warning anybody can scroll past.
 *
 * Every resident-visible string here is placeholder under PLACEHOLDER_COPY.
 */

import { api } from './api.js';
import { el, esc, showError, askFirst } from './ui.js';
import { money, dayLabel } from './i18n.js';
import { trackAction } from './track.js';

let state = null;
let step = 1;
let root = null;

export async function maintPanel(mount) {
  root = mount;
  root.replaceChildren(el('p', { class: 'muted' }, 'Loading the quarter…'));
  try {
    state = await api.admin.maint();
    landOnFirstUnfinishedStep();
    render();
  } catch (err) {
    showError(root, err);
  }
}

/**
 * Where to open.
 *
 * On the errand in hand rather than always at the top: a quarter with no rates
 * opens on step 1, one whose tenancies are flagged opens on step 2, a scheduled
 * one opens on step 3's receipt, and an issued one opens on collect. An admin
 * who came here to do the next thing should find it open.
 */
function landOnFirstUnfinishedStep() {
  if (!state.row) step = 1;
  else if (state.status === 'issued' || state.status === 'locked') step = 4;
  else if (state.status === 'scheduled') step = 3;
  else if (state.blocked?.blocked) step = 2;
  else step = 3;
}

async function reload(landOn = null) {
  state = await api.admin.maint(state.quarter);
  if (landOn != null) step = landOn;
  else landOnFirstUnfinishedStep();
  render();
}

function render() {
  const rail = el('div', { class: 'rail' });
  const shell = (n, title, sub, body, st) =>
    stepShell(n, title, sub, st === 'open' ? body() : el('div'), st);

  rail.replaceChildren(
    shell(1, 'Rates for the quarter', ratesSub(), ratesBody, stateOf(1)),
    shell(2, 'Which flats are billed', flatsSub(), flatsBody, stateOf(2)),
    shell(3, 'Schedule', scheduleSub(), scheduleBody, stateOf(3)),
    shell(4, 'Collect', collectSub(), collectBody, stateOf(4)),
  );

  // FILTERED, because replaceChildren is not el(). el() skips a null child;
  // replaceChildren stringifies it and you read the word "null" on the page.
  // This codebase has hit that three times; admin-billing.js carries the same
  // comment for the same reason.
  root.replaceChildren(...[
    header(),
    rail,
    state.readOnly ? null : panels(),
  ].filter(Boolean));
}

function header() {
  return el('div', { class: 'panel stack' },
    el('div', { class: 'row row--between' },
      el('div', {},
        el('h2', {}, state.quarterLabel),
        el('p', { class: 'small muted' },
          state.row
            ? `Bills go out ${dayLabel(state.issueDate)} · due ${dayLabel(state.consequences.dueDate)}`
            : 'Not drafted yet')),
      el('span', { class: `chip ${statusChipClass()}` }, statusWord())),

    // The picker. Earlier quarters open READ-ONLY: the page is for working a
    // quarter, and a past one is a record rather than something to edit.
    state.quarters.length > 1 ? quarterPicker() : null,

    state.readOnly
      ? el('p', { class: 'small muted' }, 'This quarter is closed. Nothing here can be changed.')
      : null);
}

function quarterPicker() {
  return el('label', { class: 'field' },
    el('span', { class: 'label' }, 'Quarter'),
    el('select', {
      class: 'input',
      onchange: async (e) => {
        state = await api.admin.maint(e.target.value);
        landOnFirstUnfinishedStep();
        render();
      },
    }, ...state.quarters.map((q) =>
      el('option', { value: q, selected: q === state.quarter ? 'selected' : null }, q))));
}

function statusWord() {
  return { none: 'Not started', draft: 'Draft', scheduled: 'Scheduled',
    issued: 'Issued', locked: 'Closed' }[state.status] ?? state.status;
}

function statusChipClass() {
  if (state.status === 'issued' || state.status === 'locked') return 'chip--paid';
  if (state.status === 'scheduled') return 'chip--neutral';
  return 'chip--awaiting';
}

/**
 * A step is done, open, or waiting.
 *
 * `waiting` is the only one that cannot be clicked, and it is used sparingly:
 * step 3 genuinely cannot be worked before there are rates to schedule. Steps 2
 * and 4 stay open even when there is little in them, because an admin checking
 * something is a legitimate reason to be there.
 */
function stateOf(n) {
  if (step === n) return 'open';
  if (n === 1) return state.row ? 'done' : 'waiting';
  if (n === 2) return state.blocked?.blocked ? 'open' : state.row ? 'done' : 'waiting';
  if (n === 3) {
    if (!state.row) return 'waiting';
    return state.status === 'scheduled' || state.status === 'issued'
      || state.status === 'locked' ? 'done' : 'waiting';
  }
  return state.status === 'issued' || state.status === 'locked' ? 'done' : 'waiting';
}

function stepShell(n, title, sub, body, st) {
  const head = el('button', {
    class: 'step__head', type: 'button',
    'aria-expanded': String(st === 'open'),
    onclick: () => { step = step === n ? 0 : n; render(); },
  },
    el('span', { class: 'step__n' }, st === 'done' ? '✓' : String(n)),
    el('span', { class: 'step__label' },
      el('span', { class: 'step__title' }, title),
      el('span', { class: 'step__sub' }, sub)));

  return el('section', { class: 'step', 'data-state': st, 'data-step': String(n) },
    head, el('div', { class: 'step__body' }, body));
}

/* ── step 1 · rates ───────────────────────────────────────────────────────  */

function ratesSub() {
  if (!state.row) return 'Not set';
  return `${money(state.row.owner_rate)} owner · ${money(state.row.tenant_rate)} rented`
       + ` · ${money(state.row.late_fee)} late fee`;
}

function ratesBody() {
  // FROZEN ONCE SCHEDULED. The step becomes a record of what was set rather
  // than a form that silently refuses — a disabled input an admin can type into
  // and then lose is worse than a sentence saying why.
  if (state.status !== 'none' && state.status !== 'draft') {
    return el('div', { class: 'stack' },
      el('p', {}, `Owner ${money(state.row.owner_rate)} · `
        + `Rented ${money(state.row.tenant_rate)} · Late fee ${money(state.row.late_fee)}`),
      el('p', { class: 'small muted' },
        'These were fixed when the quarter was scheduled. After issuing, a rate '
        + 'moves one bill at a time and needs a second admin.'));
  }

  const prev = state.previous;
  const field = (name, label, value) => el('label', { class: 'field' },
    el('span', { class: 'label' }, label),
    el('input', {
      class: 'input', type: 'number', name, min: '0', step: '1',
      inputmode: 'numeric', value: String(value ?? ''),
    }));

  const out = el('p', { class: 'small muted' });

  const form = el('form', { class: 'stack' },
    field('ownerRate', 'Owner-occupied', state.row?.owner_rate ?? prev?.owner_rate ?? 7500),
    field('tenantRate', 'Rented out', state.row?.tenant_rate ?? prev?.tenant_rate ?? 9000),
    field('lateFee', 'Late fee', state.row?.late_fee ?? prev?.late_fee ?? 750),

    // The comparison AND the explanation in one line. An admin who sees where
    // a default came from does not have to go looking for last quarter.
    prev
      ? el('p', { class: 'small muted' },
          `Carried from ${prev.quarter}: ${money(prev.owner_rate)} owner, `
          + `${money(prev.tenant_rate)} rented, ${money(prev.late_fee)} late fee.`)
      : el('p', { class: 'small muted' },
          'No previous quarter to carry from. These are the 2026 rates.'),

    el('button', { class: 'btn', type: 'submit' }, 'Save rates'),
    out);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    out.textContent = 'Saving…';
    try {
      trackAction('maint.rates');
      state = await api.admin.maintRates(
        state.quarter,
        Number(data.get('ownerRate')), Number(data.get('tenantRate')), Number(data.get('lateFee')));
      // Straight to step 2, because the rates are only interesting as an input
      // to who gets billed what.
      await reload(2);
    } catch (err) {
      out.textContent = err.message ?? 'Could not save those rates.';
      out.style.color = 'var(--overdue)';
    }
  });

  return form;
}

/* ── step 2 · which flats are billed ──────────────────────────────────────  */

function flatsSub() {
  if (!state.preview) return 'Set the rates first';
  if (state.blocked?.blocked) {
    return `${state.blocked.count} tenanc${state.blocked.count === 1 ? 'y' : 'ies'} to confirm`;
  }
  return `${state.preview.willBill} flats · ${money(state.preview.total)}`;
}

/**
 * Two blocks, and the first gates the second.
 *
 * The tenancy check leads because a wrong tenancy is a wrong RATE, and the
 * billing table underneath is computed from exactly the records the check is
 * asking about. Reading them the other way round invites an admin to approve a
 * total that the rows above have not finished arguing about.
 */
function flatsBody() {
  if (!state.preview) {
    return el('p', { class: 'muted' }, 'Set the rates in step 1 and this fills in.');
  }

  return el('div', { class: 'stack' },
    tenancyBlock(),
    el('hr', { class: 'rule' }),
    billingBlock());
}

function tenancyBlock() {
  const blocked = state.blocked ?? { blocked: false, count: 0 };

  const strip = blocked.blocked
    ? el('div', { class: 'note note--warn' },
        el('p', {}, `${blocked.count} tenanc${blocked.count === 1 ? 'y needs' : 'ies need'} `
          + 'confirming before this quarter can be scheduled.'),
        // NAMED, because "3 tenancies" is not something anybody can act on
        // until they know which flats.
        el('p', { class: 'small' }, `Flats: ${blocked.flats.join(', ')}`))
    : el('div', { class: 'note note--good' }, 'Every tenancy on record is current.');

  if (!state.tenancies.length) {
    return el('div', { class: 'stack' },
      el('p', { class: 'label' }, 'Tenancies'),
      el('p', { class: 'muted' }, 'No tenancies on record. Every flat bills at the owner rate.'));
  }

  return el('div', { class: 'stack' },
    el('p', { class: 'label' }, 'Tenancies'),
    strip,
    el('div', { class: 'scroll-x' },
      el('table', { class: 'table' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Flat'),
          el('th', {}, 'Tenant'),
          el('th', {}, 'Lease to'),
          el('th', {}, 'Last confirmed'),
          el('th', {}, 'Flag'),
          el('th', {}, ''))),
        el('tbody', {}, ...state.tenancies.map(tenancyRow)))));
}

function tenancyRow(row) {
  const out = el('span', { class: 'small muted' });
  // The cell the row's controls live in, held as a reference because "Add date"
  // replaces its contents in place. Built before the row so both can reach it.
  const actions = el('td', {});
  const tr = el('tr', { 'data-flag': row.flag });

  // NOT named `confirm`. The suite bans that identifier in browser modules
  // because window.confirm is not guaranteed to draw anything — a browser that
  // has suppressed dialogs returns false immediately — and a local helper
  // wearing the name would make the guard useless for every file after it.
  const stampConfirmed = (leaseEndsAt = null) => async () => {
    out.textContent = 'Saving…';
    try {
      trackAction('maint.tenancy.confirm');
      await api.admin.confirmTenancy(row.id, leaseEndsAt);
      await reload(2);
    } catch (err) {
      out.textContent = err.message ?? 'Could not confirm that.';
    }
  };

  // "Add date" is the same call with a date on it. Confirming a row whose
  // problem IS the missing date would stamp a record that is still missing the
  // thing that made it a problem.
  const addDate = () => {
    const input = el('input', { class: 'input input--sm', type: 'date' });
    const save = el('button', {
      class: 'btn btn--sm', type: 'button',
      onclick: () => {
        if (!input.value) { out.textContent = 'Pick a date first.'; return; }
        stampConfirmed(input.value)();
      },
    }, 'Save');
    actions.replaceChildren(input, save, out);
    input.focus();
  };

  actions.replaceChildren(...[
    row.flag === 'missing-date'
      ? el('button', { class: 'btn btn--sm btn--ghost', type: 'button', onclick: addDate },
          'Add date')
      : null,
    row.flag !== 'current'
      ? el('button', { class: 'btn btn--sm', type: 'button', onclick: stampConfirmed() }, 'Still here')
      : null,
    // "Moved out" spells out the consequences BEFORE the confirm — the re-rate,
    // the bill moving, the letters switching.
    row.flag !== 'current'
      ? el('button', {
          class: 'btn btn--sm btn--ghost', type: 'button',
          onclick: () => movedOut(row, tr),
        }, 'Moved out')
      : null,
    out,
  ].filter(Boolean));

  tr.replaceChildren(
    el('td', {}, row.flat),
    el('td', {},
      row.name,
      row.since ? el('div', { class: 'small muted' }, `since ${dayLabel(row.since)}`) : null),
    el('td', {}, row.leaseEndsAt ? dayLabel(row.leaseEndsAt) : '—'),
    el('td', { class: 'small muted' }, row.confirmedAt ? dayLabel(row.confirmedAt) : 'never'),
    el('td', {}, flagChip(row)),
    actions);

  return tr;
}

function flagChip(row) {
  const conf = {
    current: { cls: 'chip--paid', label: 'Current' },
    'lease-ended': { cls: 'chip--overdue',
      label: `Lease ended${row.endedDaysAgo ? ` ${row.endedDaysAgo}d ago` : ''}` },
    'missing-date': { cls: 'chip--awaiting', label: 'No lease date' },
    unchecked: { cls: 'chip--awaiting', label: '2+ years unchecked' },
  }[row.flag];
  return el('span', { class: `chip ${conf.cls}` }, conf.label);
}

/**
 * What happens if this tenant has gone — SAID BEFORE the confirm, not after.
 *
 * The user approved this dialog on the strength of spelling the consequences
 * out first: the flat re-rates from ₹9,000 to ₹7,500, the bill moves to the
 * owner, and the letters go to a different person. An admin clicking "Moved
 * out" to tidy a row should see all three before anything happens.
 */
function movedOut(row, tr) {
  const slot = el('div', { class: 'note note--warn' });
  tr.after(el('tr', {}, el('td', { colspan: '6' }, slot)));

  askFirst(slot,
    `If ${row.name} has left ${row.flat}: the flat re-rates to the owner rate for this `
    + 'quarter, the bill moves to the owner, and the letters go to them instead. '
    + 'This does not remove their account — an admin does that on Residents.',
    'Yes, they have left', 'Keep the tenancy'
  ).then(async (yes) => {
    if (!yes) { render(); return; }
    // Deliberately NOT a write from here. Ending a tenancy moves money and
    // changes who is billed; it belongs on Residents, where the whole record is
    // visible, and this sends the admin there rather than doing half of it.
    location.href = '/admin/#residents';
  });
}

function billingBlock() {
  const p = state.preview;
  const byFlat = new Map(p.bills.map((b) => [b.flat, b]));
  const skipped = new Map(p.skipped.map((s) => [s.flat, s.reason]));
  const flats = [...new Set([...byFlat.keys(), ...skipped.keys()])].sort();

  return el('div', { class: 'stack' },
    el('p', { class: 'label' }, 'Who is billed'),
    el('div', { class: 'tiles' },
      tile('Billed', String(p.willBill)),
      tile('At the rented rate', String(p.tenantCount)),
      tile('Skipped', String(p.skipped.length)),
      tile('Draft total', money(p.total), true)),

    el('div', { class: 'scroll-x' },
      el('table', { class: 'table' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Flat'),
          el('th', {}, 'Billed to'),
          el('th', { class: 'r' }, 'Rate'),
          el('th', {}, 'Note'))),
        el('tbody', {}, ...flats.map((flat) => {
          const bill = byFlat.get(flat);
          if (!bill) {
            return el('tr', {},
              el('td', {}, flat),
              el('td', { class: 'muted' }, '—'),
              el('td', { class: 'r muted' }, '—'),
              el('td', {}, el('span', { class: 'chip chip--neutral' }, 'Skipped'),
                el('div', { class: 'small muted' }, skipReason(skipped.get(flat)))));
          }
          return el('tr', {},
            el('td', {}, flat),
            el('td', {}, bill.billedToName ?? `#${bill.billedTo}`),
            el('td', { class: 'r' }, money(bill.rate)),
            el('td', { class: 'small muted' },
              bill.basis === 'tenant' ? 'Rented' : 'Owner-occupied'));
        })))),

    // NO INLINE OVERRIDE, and this says so rather than leaving an admin hunting
    // for one. The basis comes from the records; if the records are wrong the
    // fix is the records, otherwise you get a bill whose reason lives nowhere.
    el('p', { class: 'small muted' },
      'The rate follows the records. To change one, fix the tenancy above or on '
      + 'Residents — there is no way to override it here on purpose, because a '
      + 'bill whose reason is not written down anywhere cannot be explained later.'));
}

function skipReason(reason) {
  return {
    'no-owner': 'No owner on record',
    'tenant-no-owner': 'Someone is living here with no owner on record',
  }[reason] ?? reason ?? '';
}

function tile(label, value, big = false) {
  return el('div', { class: 'tile' },
    el('span', { class: 'label' }, label),
    el('strong', { class: big ? 'tile__big' : '' }, value));
}

/* ── step 3 · schedule ────────────────────────────────────────────────────  */

function scheduleSub() {
  if (state.status === 'scheduled') return `Goes out ${dayLabel(state.issueDate)}`;
  if (state.status === 'issued' || state.status === 'locked') return 'Issued';
  if (state.blocked?.blocked) return 'Blocked by step 2';
  return 'Not scheduled';
}

function scheduleBody() {
  if (!state.row) return el('p', { class: 'muted' }, 'Set the rates first.');

  // A RECEIPT once scheduled: what was scheduled, by whom, when it goes.
  if (state.status === 'scheduled') return scheduledReceipt();
  if (state.status === 'issued' || state.status === 'locked') {
    return el('p', {}, `Issued ${state.row.issued_at ? dayLabel(state.row.issued_at) : ''}.`);
  }

  const c = state.consequences;
  const out = el('p', { class: 'small' });

  const dateInput = el('input', {
    class: 'input', type: 'date', value: state.issueDate,
    onchange: async (e) => {
      // The consequences move with the date, so they are recomputed rather than
      // left showing the old ones — a due date that does not follow the issue
      // date is exactly the kind of stale number somebody schedules against.
      state.issueDate = e.target.value;
      state = await api.admin.maint(state.quarter).catch(() => state);
      render();
    },
  });

  const blocked = state.blocked?.blocked;
  // The rows whose only problem is a missing lease end. These do not stop the
  // quarter for ever — the roster is filled in over time and refusing to bill
  // until every date is entered would miss the quarter entirely — but they must
  // be scheduled past DELIBERATELY. The server refuses without this.
  const undated = state.tenancies.filter((t) => t.flag === 'missing-date');
  const ack = el('input', { type: 'checkbox', id: 'ack-undated' });

  return el('div', { class: 'stack' },
    el('label', { class: 'field' },
      el('span', { class: 'label' }, 'Bills go out on'),
      dateInput),

    // BOTH DATES, SEPARATELY. The fee lands the day AFTER the due date, and the
    // gas screens have already taught residents to misread those as one day.
    el('p', { class: 'small muted' },
      `Due ${dayLabel(c.dueDate)}. The late fee of ${money(state.row.late_fee)} is `
      + `charged overnight after ${dayLabel(c.dueDate)} — the first bills carrying it `
      + `are dated ${dayLabel(c.lateFeeDate)}.`),

    el('div', { class: 'note' },
      el('p', {}, `Issuing raises ${c.willBill} bills totalling ${money(c.total)}.`),
      el('p', { class: 'small' },
        `${c.tenantCount} at the rented rate, ${c.ownerCount} at the owner rate. `
        + 'Letters go to whoever is billed, and to the owner of a let flat. '
        + 'A reminder follows three days before the due date.')),

    el('button', {
      class: 'btn btn--ghost', type: 'button',
      onclick: () => { location.href = `/admin/#messages`; },
    }, 'Preview an email'),

    blocked
      ? el('div', { class: 'note note--warn' },
          `Step 2 has ${state.blocked.count} tenanc${state.blocked.count === 1 ? 'y' : 'ies'} `
          + 'still to confirm. Scheduling fixes every rate at once, so they have to be '
          + 'settled first.')
      : null,

    // Offered only once nothing else is blocking, so it cannot become the box
    // an admin ticks to get past step 2 without reading it.
    !blocked && undated.length
      ? el('label', { class: 'row', style: 'gap:var(--s-2);align-items:flex-start' },
          ack,
          el('span', { class: 'small' },
            `${undated.length} tenanc${undated.length === 1 ? 'y has' : 'ies have'} no lease `
            + `end date (${[...new Set(undated.map((t) => t.flat))].join(', ')}). `
            + 'Schedule anyway — I know these dates are missing.'))
      : null,

    el('button', {
      class: 'btn btn--lg', type: 'button',
      // Disabled ON THE FLAGS, which is the whole point of step 2. The server
      // refuses it too — this is the explanation, not the guard.
      disabled: blocked || null,
      onclick: async () => {
        out.textContent = 'Scheduling…';
        try {
          trackAction('maint.schedule');
          state = await api.admin.maintSchedule(
            state.quarter, dateInput.value, ack.checked);
          await reload(3);
        } catch (err) {
          out.textContent = err.message ?? 'Could not schedule that quarter.';
          out.style.color = 'var(--overdue)';
        }
      },
    }, 'Schedule this quarter'),
    out,

    // No typed confirmation and no second admin. Scheduling is reversible and
    // nothing has reached a resident; an approval on a reversible act teaches
    // people to click through approvals.
    el('p', { class: 'small muted' },
      'Nothing reaches residents until the issue date. This can be undone until then.'));
}

function scheduledReceipt() {
  const out = el('p', { class: 'small' });
  return el('div', { class: 'stack' },
    el('div', { class: 'note note--good' },
      el('p', {}, `${state.row.scheduled_flats ?? state.consequences.willBill} bills, `
        + `${money(state.row.scheduled_total ?? state.consequences.total)}, `
        + `going out ${dayLabel(state.issueDate)}.`),
      el('p', { class: 'small' },
        `Due ${dayLabel(state.consequences.dueDate)}.`
        + (state.row.scheduled_at ? ` Scheduled ${dayLabel(state.row.scheduled_at)}.` : ''))),

    el('button', {
      class: 'btn btn--ghost', type: 'button',
      onclick: async () => {
        if (!await askFirst(out,
          'Unscheduling puts this quarter back to draft. Nothing has reached anybody yet, '
          + 'so nothing is withdrawn — but the rates become editable again.',
          'Yes, unschedule', 'Leave it scheduled')) return;
        try {
          state = await api.admin.maintUnschedule(state.quarter);
          await reload(1);
        } catch (err) {
          out.textContent = err.message ?? 'Could not unschedule that.';
        }
      },
    }, 'Unschedule'),
    out);
}

/* ── step 4 · collect ─────────────────────────────────────────────────────  */

function collectSub() {
  if (!state.collect) return 'Once the bills are out';
  const c = state.collect;
  return `${c.paid} paid · ${c.checking} checking · ${c.unpaid} unpaid`;
}

/**
 * A SUMMARY THAT LINKS OUT, owning only a few actions.
 *
 * Bills and Proofs already exist and already work. The proofs queue in
 * particular must not be forked: one queue, filtered, or the treasurer ends up
 * with two half-lists and no idea which is authoritative.
 */
function collectBody() {
  if (!state.collect) {
    return el('p', { class: 'muted' }, 'This fills in once the bills have gone out.');
  }
  const c = state.collect;

  return el('div', { class: 'stack' },
    el('div', { class: 'tiles' },
      tile('Paid', `${c.paid}`),
      tile('Awaiting check', `${c.checking}`),
      tile('Unpaid', `${c.unpaid}`),
      tile('Outstanding', money(c.unpaidAmount), true)),

    // WORDED FROM WHEN THE JOB RUNS, not from the due date. The fee is charged
    // after midnight, so on the due date the truthful line is "tonight" — and
    // the next question after "tonight" is always "how much".
    c.lateFeeTonight
      ? el('div', { class: 'note note--warn' },
          `Tonight the late fee lands on ${c.lateFeeTonight.bills} unpaid `
          + `bill${c.lateFeeTonight.bills === 1 ? '' : 's'}: `
          + `${money(c.lateFeeTonight.each)} each, ${money(c.lateFeeTonight.total)} in total.`)
      : null,

    el('div', { class: 'row' },
      el('a', { class: 'btn btn--ghost', href: '/admin/#bills' }, 'Bills for this quarter'),
      el('a', { class: 'btn btn--ghost', href: '/admin/proofs.html' }, 'Payment screenshots'),
      el('a', { class: 'btn btn--ghost', href: '/admin/dues.html' }, 'Who owes what')));
}

/* ── the three panels ─────────────────────────────────────────────────────  */

function panels() {
  return el('div', { class: 'stack' },
    el('hr', { class: 'rule' }),
    exemptionsPanel(),
    advancesPanel(),
    approvalsPanel());
}

/**
 * ONE PANEL, TWO LABELLED GROUPS.
 *
 * A late-fee exemption is per person and a voting exemption is per flat, which
 * is a real difference and is what the labels carry. But an admin looking for
 * "who is excused what" should find both in one place rather than learning
 * which of two screens holds which kind.
 */
function exemptionsPanel() {
  const { fee, voting } = state.exemptions;
  return el('details', { class: 'panel' },
    el('summary', {}, `Exemptions (${fee.length + voting.length})`),
    el('div', { class: 'stack' },
      el('p', { class: 'label' }, 'Late fee — per person'),
      fee.length
        ? el('ul', { class: 'list' }, ...fee.map((e) => el('li', {},
            `${esc(e.resident ?? '')} (${esc(e.flat ?? '')}) — until ${dayLabel(e.ends_at)}`,
            el('div', { class: 'small muted' }, esc(e.reason ?? '')),
            e.approved_by ? null : el('span', { class: 'chip chip--awaiting' }, 'Needs a second admin'))))
        : el('p', { class: 'muted small' }, 'None.'),

      el('p', { class: 'label' }, 'Voting — per flat'),
      voting.length
        ? el('ul', { class: 'list' }, ...voting.map((e) => el('li', {},
            `${esc(e.flat)} — ${e.ends_at ? `until ${dayLabel(e.ends_at)}` : 'open-ended'}`,
            el('div', { class: 'small muted' }, esc(e.reason ?? '')),
            e.approved_by ? null : el('span', { class: 'chip chip--awaiting' }, 'Needs a second admin'))))
        : el('p', { class: 'muted small' }, 'None.')));
}

function advancesPanel() {
  return el('details', { class: 'panel' },
    el('summary', {}, `Advances (${state.advances.length})`),
    state.advances.length
      ? el('div', { class: 'scroll-x' },
          el('table', { class: 'table' },
            el('thead', {}, el('tr', {},
              el('th', {}, 'Flat'),
              el('th', { class: 'r' }, 'Amount'),
              el('th', {}, 'Paid up to'),
              el('th', {}, 'Reference'),
              el('th', {}, 'Recorded / approved'))),
            el('tbody', {}, ...state.advances.map((a) => el('tr', {},
              el('td', {}, a.flat),
              el('td', { class: 'r' }, money(a.amount)),
              el('td', {}, a.paid_through),
              el('td', { class: 'small muted' },
                `${esc(a.method ?? '')} ${esc(a.reference ?? '')}`.trim() || '—'),
              el('td', { class: 'small muted' },
                // An unapproved advance has not been banked. Said on the row,
                // because advanceCovers() refuses to count it and an admin
                // seeing the amount would otherwise assume it counts.
                a.approved_by
                  ? `${esc(a.recorded_by_name ?? '')} → ${esc(a.approved_by_name ?? '')}`
                  : el('span', { class: 'chip chip--awaiting' }, 'Needs a second admin')))))))
      : el('p', { class: 'muted small' }, 'No advances recorded.'));
}

/**
 * A QUEUE, not buttons on the row that asked for it.
 *
 * Approving is a second person's deliberate act, and it should not sit under
 * the mouse of whoever made the request. Maintenance approvals only for now —
 * merging this with the gas bill-edit queue is the obvious later consolidation
 * and is not this fortnight's work.
 */
function approvalsPanel() {
  return el('details', { class: 'panel', open: state.approvals.length ? 'open' : null },
    el('summary', {}, `Approvals waiting (${state.approvals.length})`),
    state.approvals.length
      ? el('ul', { class: 'list' }, ...state.approvals.map((r) => el('li', {},
          el('strong', {}, esc(r.kind ?? '')),
          r.flat ? ` · ${esc(r.flat)}` : '',
          el('div', { class: 'small muted' },
            `asked by ${esc(r.requested_by_name ?? 'an admin')}`
            + (r.reason ? ` — ${esc(r.reason)}` : '')))))
      : el('p', { class: 'muted small' }, 'Nothing waiting.'));
}
