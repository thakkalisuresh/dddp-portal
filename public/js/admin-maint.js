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
 * The wording here is the committee's, approved in the pass that took
 * PLACEHOLDER_COPY down. Changing it is their decision, not a tidy-up.
 */

import { api } from './api.js';
import { el, esc, showError, askFirst, setChildren } from './ui.js';
import { money, dayLabel } from './i18n.js';
import { trackAction } from './track.js';

let state = null;
let step = 1;
let root = null;

/**
 * The Maintenance tab.
 *
 * RETURNS ITS NODE. The tab dispatcher in admin-console.js calls every panel as
 * `main.replaceChildren(await tab.render())` — no argument, node back — and this
 * one took a mount instead, so `root` was undefined and the whole tab rendered
 * "Cannot read properties of undefined (reading 'replaceChildren')" from the
 * moment step 6 shipped it. The suite never saw it: every function below is
 * tested, and none of them is the one that was wrong.
 *
 * `mount` is still accepted, so a caller that has a node to fill keeps working.
 */
export async function maintPanel(mount = null) {
  root = mount ?? el('div');
  root.replaceChildren(el('p', { class: 'muted' }, 'Loading the quarter…'));
  try {
    state = await api.admin.maint();
    landOnFirstUnfinishedStep();
    render();
  } catch (err) {
    showError(root, err);
  }
  return root;
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
    votingPanel(),
  ].filter(Boolean));
}

/**
 * The voting block, and the committee's exceptions to it.
 *
 * NOT A STEP. The four steps are a quarter's life and run in order; this is a
 * standing view of a rule that is true between quarters as much as during one,
 * so it sits below the rail rather than pretending to be step five.
 *
 * The rule itself is `flatVotingStatus`, read from the server. Nothing here
 * recomputes who is blocked — the resident's poll card, the ballot endpoint and
 * this screen all ask the same function, which is the only way the portal can
 * avoid showing somebody a vote it is about to refuse.
 */
function votingPanel() {
  const body = el('div', {}, el('p', { class: 'muted' }, 'Loading…'));
  const panel = el('div', { class: 'panel stack' },
    el('h2', {}, 'Voting'),
    el('p', { class: 'small muted' },
      'A flat with maintenance outstanding from a closed quarter cannot vote in a poll. '
      + 'The block lifts the moment the treasurer confirms payment.'),
    body);

  const load = async () => {
    try {
      const data = await api.admin.voting();
      setChildren(body, votingBody(data, load));
    } catch (err) {
      setChildren(body, el('p', { class: 'note note--bad' },
        err.message ?? 'Could not load the voting block.'));
    }
  };
  load();
  return panel;
}

function votingBody(data, reloadVoting) {
  const blocked = (data.flats ?? []).filter((f) => !f.canVote);
  const pending = (data.exemptions ?? []).filter((e) => !e.approved_by);

  return el('div', { class: 'stack' },
    blocked.length
      ? el('div', { class: 'scroll-x' },
          el('table', { class: 'table' },
            el('thead', {}, el('tr', {},
              el('th', {}, 'Flat'), el('th', {}, 'Owes'),
              el('th', {}, 'Quarters'), el('th', {}, ''))),
            el('tbody', {}, ...blocked.map((f) => el('tr', {},
              el('td', {}, f.flat),
              el('td', { class: 'r' }, money(f.owed)),
              el('td', {}, (f.quarters ?? []).join(', ')),
              el('td', {}, exemptButton(f.flat, reloadVoting)))))))
      : el('p', { class: 'note note--good' }, 'No flat is blocked from voting.'),

    // WAITING ON A SECOND ADMIN, shown to everybody rather than only to the
    // approver: an admin who cannot see that their own grant is still pending
    // will raise it again or telephone about it, which is what the queue
    // replaced. They see the row and no button.
    pending.length
      ? el('div', { class: 'stack', style: 'gap:var(--s-2)' },
          el('p', { class: 'label' }, 'Waiting for a second admin'),
          ...pending.map((e) => el('div', { class: 'note note--warn' },
            el('p', { class: 'small' },
              `${e.flat} — “${e.reason}” · `
              + (e.ends_at ? `until ${e.ends_at}` : 'open-ended')
              + ` · granted by ${e.granted_by_name ?? 'an admin'}`),
            el('button', {
              class: 'btn btn--sm', type: 'button',
              onclick: async (ev) => {
                ev.target.disabled = true;
                try { await api.admin.approveVotingExemption(e.id); await reloadVoting(); }
                catch (err) { ev.target.disabled = false; ev.target.after(
                  el('span', { class: 'small bad' }, ` ${err.message ?? 'Refused.'}`)); }
              },
            }, 'Approve'))))
      : null,

    approvedExemptions(data));
}

/** The exceptions in force, so an open-ended one cannot quietly hide. */
function approvedExemptions(data) {
  const live = (data.exemptions ?? []).filter((e) => e.approved_by);
  if (!live.length) return null;
  return el('details', {},
    el('summary', { class: 'small muted' }, `${live.length} exemption${live.length === 1 ? '' : 's'} granted`),
    ...live.map((e) => el('p', { class: 'small muted' },
      `${e.flat} — “${e.reason}” · `
      + (e.ends_at ? `until ${e.ends_at}` : 'open-ended')
      + ` · ${e.granted_by_name ?? 'an admin'}, approved by ${e.approved_by_name ?? 'an admin'}`)));
}

/**
 * Propose an exemption. One admin asks; it does nothing until another agrees.
 *
 * The end date is ASKED FOR rather than defaulted. 0042 allows an open-ended
 * exemption deliberately — a flat in a long dispute is a real committee
 * decision — but an open-ended one granted by accident is the one nobody ever
 * revisits, so saying so has to be a separate act.
 */
function exemptButton(flat, reloadVoting) {
  const slot = el('span', {});
  const open = () => {
    const reason = el('input', {
      class: 'input input--sm', placeholder: 'In dispute with the committee',
      'aria-label': `Why ${flat} is excused from the voting block`,
    });
    const until = el('input', { class: 'input input--sm', type: 'date',
                                'aria-label': `Excused until when` });
    const forever = el('input', { type: 'checkbox' });
    const out = el('span', { class: 'small' });

    setChildren(slot, el('div', { class: 'stack', style: 'gap:var(--s-2)' },
      el('div', { class: 'field' }, el('label', {}, 'Why'), reason),
      el('div', { class: 'field' }, el('label', {}, 'Excused until'), until),
      el('label', { class: 'small', style: 'display:flex;gap:var(--s-2)' },
        forever, 'No end date — the committee decided this one is open-ended'),
      el('div', { class: 'row', style: 'gap:var(--s-3);flex-wrap:wrap' },
        el('button', {
          class: 'btn btn--sm', type: 'button',
          onclick: async (ev) => {
            ev.target.disabled = true;
            try {
              await api.admin.grantVotingExemption({
                flat, reason: reason.value || reason.placeholder,
                endsAt: until.value || null, openEnded: forever.checked,
              });
              await reloadVoting();
            } catch (err) {
              ev.target.disabled = false;
              out.textContent = err.message ?? 'Could not grant that.';
            }
          },
        }, 'Send for a second admin'),
        el('button', { class: 'linkish small', type: 'button',
                       onclick: () => slot.replaceChildren() }, 'Cancel'),
        out)));
    reason.focus();
  };

  return el('span', {},
    el('button', { class: 'btn btn--sm btn--quiet', type: 'button', onclick: open }, 'Excuse'),
    slot);
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
    pickable().length > 1 ? quarterPicker() : null,

    state.readOnly
      ? el('p', { class: 'small muted' }, 'This quarter is closed. Nothing here can be changed.')
      : null);
}

/**
 * The quarters the picker offers: the ones that EXIST, plus the one on screen.
 *
 * It used to be `state.quarters` alone, and the two are not the same list. The
 * page opens on `workingQuarter` — the quarter being drafted, or failing that
 * the one the calendar is in — and the calendar's quarter may have no row at
 * all. On staging that put "Q3 2026, not drafted yet" on screen with a list of
 * one (`['2026-Q4']`), so the picker was hidden as a list of one always is, and
 * an issued quarter holding 94 bills worth ₹7,21,500 had no route back to it
 * from its own tab.
 *
 * Deduplicated and sorted newest first, so adding the working quarter cannot
 * put a duplicate or an out-of-order entry in the list.
 */
function pickable() {
  return [...new Set([...(state.quarters ?? []), state.quarter])]
    .filter(Boolean)
    .sort()
    .reverse();
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
    }, ...pickable().map((q) =>
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
          + 'confirming before this quarter can be scheduled'),
        el('p', { class: 'small' },
          'A record that is out of date bills the wrong person at the wrong rate.'),
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
          el('th', {}, 'Flag'),
          el('th', {}, ''))),
        el('tbody', {}, ...state.tenancies.map(tenancyRow)))),
    // Said once under the table rather than on every row: "Still here" is the
    // button an admin presses most and the one whose effect is least obvious.
    //
    // THE SECOND SENTENCE IS NOT IN THE APPROVED COPY and is here because the
    // first one is not true of every flag. Confirming a tenancy whose lease end
    // has already passed stamps the date and leaves the flag exactly where it
    // was — `lease-ended` outranks `unchecked` — so an admin who read only the
    // approved sentence would press "Still here", watch nothing happen, and
    // press it again. Found by pressing it.
    el('p', { class: 'small muted' },
      '"Still here" records today\u2019s date against the tenancy and clears the '
      + 'flag for this quarter. A lease that has already ended needs a new end '
      + 'date — "Add date" on that row — because confirming alone does not '
      + 'clear it.'));
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
  // problem IS the date would stamp a record that is still missing, or still
  // carrying, the thing that made it a problem.
  //
  // OFFERED ON A LEASE THAT HAS ENDED TOO, not only on one with no date at all.
  // `lease-ended` is the flag that actually blocks the quarter, and until now
  // the only way to clear it was to leave for Residents — the screen complained
  // and then sent you elsewhere to fix it, which is how a console becomes
  // something people work around.
  const addDate = () => {
    const input = el('input', {
      class: 'input input--sm', type: 'date',
      // The existing end date, where there is one, so extending a lease by a
      // year is an edit rather than a re-entry.
      value: row.leaseEndsAt ?? '',
    });
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
    row.flag === 'missing-date' || row.flag === 'lease-ended'
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

  // ONE LINE PER ROW rather than a column each for the lease end and the last
  // confirmation. Four columns of dates made every row read as four separate
  // facts to check; what an admin is actually deciding is one thing — whether
  // this tenancy is real — and the line says only what its flag makes relevant.
  tr.replaceChildren(
    el('td', {}, row.flat),
    el('td', {},
      row.name,
      el('div', { class: 'small muted' }, tenancyDetail(row))),
    el('td', {}, flagChip(row)),
    actions);

  return tr;
}

function flagChip(row) {
  const conf = {
    current: { cls: 'chip--paid', label: 'Current' },
    'lease-ended': { cls: 'chip--overdue', label: 'Lease ended' },
    'missing-date': { cls: 'chip--awaiting', label: 'No end date' },
    unchecked: { cls: 'chip--awaiting', label: 'Not checked in 2 years' },
  }[row.flag];
  return el('span', { class: `chip ${conf.cls}` }, conf.label);
}

/** '2027-03-14' -> '03/27'. Month precision, which is how leases are talked about. */
function monthYear(iso) {
  const [y, m] = String(iso ?? '').split('-');
  return y && m ? `${m}/${y.slice(2)}` : '';
}

/** 86 -> 'two months'. Words up to a year, because "86d ago" is not a sentence. */
function agoInWords(days) {
  const n = Number(days ?? 0);
  if (n < 14) return `${n} day${n === 1 ? '' : 's'}`;
  const months = Math.round(n / 30);
  if (months < 1) return `${Math.round(n / 7)} weeks`;
  if (months >= 12) return 'over a year';
  const words = ['', 'one', 'two', 'three', 'four', 'five', 'six',
    'seven', 'eight', 'nine', 'ten', 'eleven'];
  return `${words[months]} month${months === 1 ? '' : 's'}`;
}

/**
 * The one line under a tenant's name, by flag.
 *
 * Each flag is a different question, so each line answers a different one: a
 * current tenancy is asking to be trusted, an ended one is asking to be acted
 * on, and an unconfirmed one is asking when anybody last looked. Showing all
 * four facts on all four rows was how the table became unreadable.
 */
function tenancyDetail(row) {
  if (row.flag === 'lease-ended') {
    return `Lease ended ${monthYear(row.leaseEndsAt)}, ${agoInWords(row.endedDaysAgo)} ago`;
  }
  if (row.flag === 'unchecked') {
    // NOT ALWAYS "never". The flag covers both a tenancy nobody has ever
    // confirmed and one last confirmed three years ago, and telling an admin
    // "never confirmed" about a row they themselves confirmed in 2024 is how a
    // screen loses their trust. Written here rather than approved: the wording
    // pass gave the "never" case only.
    const since = row.since ? `Tenant since ${monthYear(row.since)}, ` : '';
    return row.confirmedAt
      ? `${since}last confirmed ${monthYear(row.confirmedAt)}`
      : `${since || 'Tenant'}never confirmed`.replace('Tenantnever', 'Never');
  }
  if (row.flag === 'missing-date') {
    return row.since
      ? `Tenant since ${monthYear(row.since)}, no lease end recorded`
      : 'No lease end recorded';
  }
  const parts = [];
  if (row.leaseEndsAt) parts.push(`Lease to ${monthYear(row.leaseEndsAt)}`);
  if (row.confirmedAt) parts.push(`confirmed ${shortDay(row.confirmedAt)}`);
  return parts.join(' · ') || 'On record';
}

/** '2026-07-12' -> '12 Jul'. The short form, for a line that is already long. */
function shortDay(iso) {
  return dayLabel(iso).replace(
    /\s(\w{3})\w*$/, (_, abbr) => ` ${abbr}`);
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

/**
 * Read the letter before committing the building to it.
 *
 * Sits directly above "Schedule this quarter" because that is the moment it is
 * for: scheduling commits ninety-odd people to four letters, and until this
 * existed an admin could not read one of them. It is also where the committee
 * reads the final wording in place once the copy pass lands.
 *
 * It was a button pointing at `/admin/#messages` — a tab that stopped existing
 * in the fourteen-to-eight consolidation, on a hash that did not route anyway.
 * It did nothing at all, and no test could see that.
 *
 * NOTHING IS SENT AND NOTHING IS QUEUED; the endpoint writes no outbox row, for
 * the reason given there. The flats offered are the ones this quarter would
 * bill, taken from the preview the page already has rather than a second query.
 */
function letterPreview() {
  const KINDS = [
    ['issued', 'When the bill is raised'],
    ['due_soon', 'Three days before it is due'],
    ['due', 'On the due date'],
    ['overdue', 'The day after, with the late fee'],
  ];

  const flats = (state.preview?.bills ?? []).map((b) => b.flat);
  // No rates yet means no preview to read; step 1 is where that is fixed and
  // an empty picker would be a worse way of saying so.
  if (!flats.length) return null;

  const out = el('div', { class: 'stack' });
  const flatPick = el('select', { class: 'input' },
    ...flats.map((f) => el('option', { value: f }, f)));
  const kindPick = el('select', { class: 'input' },
    ...KINDS.map(([value, label]) => el('option', { value }, label)));

  const read = async () => {
    setChildren(out, el('p', { class: 'muted small' }, 'Reading…'));
    try {
      trackAction('maint.preview-letter');
      const p = await api.admin.maintPreviewLetter(state.quarter, flatPick.value, kindPick.value);
      setChildren(out,
        el('div', { class: 'note' },
          el('p', {}, el('strong', {}, p.subject)),
          // Said plainly, because every figure in a projection can still move:
          // a tenancy confirmed tomorrow changes the rate and the recipient.
          p.projected
            ? el('p', { class: 'small muted' },
                'Not a bill yet — this is what would be sent on the issue date, '
                + `at the ${p.basis === 'tenant' ? 'rented' : 'owner'} rate.`)
            : null,
          el('pre', { class: 'small', style: 'white-space:pre-wrap;margin:0' }, p.text),
          el('p', { class: 'small muted' },
            'Nothing was sent, and nothing is queued by reading this.')));
    } catch (err) {
      showError(out, err);
    }
  };

  return el('details', { class: 'panel-sub' },
    el('summary', {}, 'Preview an email'),
    el('div', { class: 'stack' },
      el('div', { class: 'row' },
        el('label', { class: 'field' }, el('span', { class: 'label' }, 'Flat'), flatPick),
        el('label', { class: 'field' }, el('span', { class: 'label' }, 'Letter'), kindPick)),
      el('button', { class: 'btn btn--sm', type: 'button', onclick: read }, 'Read it'),
      out));
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

  // The rows whose only problem is a missing lease end. These do not stop the
  // quarter for ever — the roster is filled in over time and refusing to bill
  // until every date is entered would miss the quarter entirely — but they must
  // be scheduled past DELIBERATELY. The server refuses without this.
  const undated = state.tenancies.filter((t) => t.flag === 'missing-date');

  // WHAT THE ACKNOWLEDGEMENT CANNOT CLEAR, which is not the same as "anything
  // flagged". A lease that has ended and a tenancy nobody has confirmed in two
  // years are both fixed on the row itself — "Add date", "Still here", "Moved
  // out" — so they stay hard blocks. A missing lease end has no such fix until
  // the roster exists, and the checkbox IS its explicit confirmation.
  //
  // THIS WAS THE REHEARSAL'S FIRST FINDING. The checkbox was offered only when
  // nothing was blocking, and the undated rows were themselves the block — so
  // on staging, where all 11 flagged tenancies were undated, the box never
  // appeared and "Schedule this quarter" could not be pressed at all. The
  // server has always accepted this case on the acknowledgement; only the
  // screen refused, which is the wrong way round for a guard that lives on the
  // server. It is also the exact case 1 October will be in, since there is no
  // roster and no lease dates.
  const byFlag = state.blocked?.byFlag ?? {};
  const hardBlocks = (byFlag['lease-ended'] ?? 0) + (byFlag.unchecked ?? 0);
  const ack = el('input', { type: 'checkbox', id: 'ack-undated' });
  const needsAck = hardBlocks === 0 && undated.length > 0;
  const blocked = hardBlocks > 0 || needsAck;

  const scheduleButton = el('button', {
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
  }, 'Schedule this quarter');

  // The checkbox has to DO something, and re-rendering the step on every tick
  // would take the focus off it. Nothing else on the screen changes, so this is
  // the one control it touches.
  ack.addEventListener('change', () => {
    scheduleButton.disabled = hardBlocks > 0 || (undated.length > 0 && !ack.checked);
  });

  return el('div', { class: 'stack' },
    el('label', { class: 'field' },
      el('span', { class: 'label' }, 'Bills go out on'),
      dateInput),

    // BOTH DATES, SEPARATELY. The fee lands the day AFTER the due date, and the
    // gas screens have already taught residents to misread those as one day.
    // THE THREE DATES IN ONE SENTENCE. They were three sentences, and the one
    // that matters — that the fee lands the day AFTER the due date, not on it —
    // was the third of them.
    el('p', { class: 'small muted' },
      `Issuing on ${dayLabel(c.issueDate ?? state.issueDate)} means due `
      + `${dayLabel(c.dueDate)}, and a ${money(state.row.late_fee)} late fee on `
      + `${dayLabel(c.lateFeeDate)}.`),

    el('div', { class: 'note' },
      el('p', {}, `On the issue date: ${c.willBill} bills are raised, and each flat's `
        + 'tenant and owner are emailed. A reminder follows three days before the due date.'),
      // Kept under it: the split is the number the committee is least sure of,
      // and it is the difference between ₹7,500 and ₹9,000 ninety times over.
      el('p', { class: 'small' },
        `${c.tenantCount} at the rented rate, ${c.ownerCount} at the owner rate.`)),

    letterPreview(),

    hardBlocks
      ? el('div', { class: 'note note--warn' },
          `Step 2 has ${hardBlocks} tenanc${hardBlocks === 1 ? 'y' : 'ies'} `
          + 'still to confirm. Scheduling fixes every rate at once, so they have to be '
          + 'settled first.')
      : null,

    // Offered only once nothing an admin can actually fix is outstanding, so it
    // cannot become the box they tick to get past step 2 without reading it.
    needsAck
      ? el('label', { class: 'row', style: 'gap:var(--s-2);align-items:flex-start' },
          ack,
          el('span', { class: 'small' },
            `${undated.length} tenanc${undated.length === 1 ? 'y has' : 'ies have'} no lease `
            + `end date (${[...new Set(undated.map((t) => t.flat))].join(', ')}). `
            + 'Schedule anyway — I know these dates are missing.'))
      : null,

    scheduleButton,
    out,

    // No typed confirmation and no second admin. Scheduling is reversible and
    // nothing has reached a resident; an approval on a reversible act teaches
    // people to click through approvals.
    el('p', { class: 'small muted' },
      'Nothing reaches residents until the issue date. This can be undone until then.'));
}

function scheduledReceipt() {
  const out = el('p', { class: 'small' });
  const flats = state.row.scheduled_flats ?? state.consequences.willBill;
  const total = state.row.scheduled_total ?? state.consequences.total;
  const who = state.row.scheduled_by_name;
  const when = state.row.scheduled_at ? dayLabel(state.row.scheduled_at) : null;

  return el('div', { class: 'stack' },
    el('div', { class: 'note note--good' },
      el('p', {},
        // Who and when first: this is a receipt, and a receipt with no name on
        // it does not tell a second admin who to ask about it.
        (who && when ? `Scheduled by ${who} on ${when}. ` : who ? `Scheduled by ${who}. ` : '')
        + `${state.quarterLabel} issues on ${dayLabel(state.issueDate)}: `
        + `${flats} flats, ${money(total)}.`),
      el('p', { class: 'small' },
        'Nothing has been sent. You can still unschedule or change this until '
        + `${dayLabel(state.issueDate)}.`)),

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
