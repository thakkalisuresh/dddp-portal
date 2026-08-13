/**
 * Admin console — the remaining screens of the design set, in one place.
 *
 * Separate pages would mirror the mockups more literally, but the treasurer is
 * one person doing one monthly job; making them navigate a site map to change
 * a rate is worse than a row of tabs.
 *
 * Readings and the proof queue stay on their own pages: they are the two
 * screens used under time pressure, and they deserve the whole viewport.
 */

import { api, ApiError } from './api.js';
import { renderNav } from './nav.js';
import { trackPage, trackAction } from './track.js';
import { $, el, esc, renderViewBanner, showError } from './ui.js';
import { mobileField } from './mobile-field.js';
import { ADMINISTRATOR } from './contact.js';
import { money, kg, periodLabel, dayLabel, stampLabel } from './i18n.js';
import { prepareUpload, makeThumbnail } from './compress.js';

const main = $('#main');
let me = null;

/**
 * Whether the portal can send email, as the server last reported it.
 *
 * Defaults to true — the strict reading — so a render that happens before the
 * directory loads hides the reset button rather than offering one the endpoint
 * would refuse. Mirrors the same default in canResetPassword.
 */
let mailConfigured = true;

// Ordered by when you actually do them. Rates comes before Readings because
// the month has to be open, with its rate set, before a reading can be entered
// against it — saveReadings fails outright on a period that does not exist.
// The strip used to read Roster, Readings, Proofs, …, Rates, which put the
// first step of every month near the end.
const TABS = [
  { id: 'roster',    label: 'Roster',    href: '/admin/roster.html' },
  { id: 'periods',   label: 'Rates',     render: periodsPanel },
  { id: 'readings',  label: 'Readings',  href: '/admin/readings.html' },
  { id: 'proofs',    label: 'Proofs',    href: '/admin/proofs.html' },
  { id: 'statement', label: 'Reconcile', href: '/admin/statement.html' },
  { id: 'latefees',  label: 'Late fees', render: lateFeesPanel },
  { id: 'approvals', label: 'Approvals', render: approvalsPanel },
  { id: 'residents', label: 'Residents', render: residentsPanel },
  { id: 'notices',   label: 'Notices',   render: noticesPanel },
  { id: 'messages',  label: 'Messages',  render: messagesPanel },
  { id: 'archive',   label: 'Archive',   render: archivePanel },
  { id: 'export',    label: 'Export',    render: exportPanel },
  { id: 'errors',    label: 'Errors',    render: errorsPanel, superadmin: true },
];

trackPage('/admin');
init();

async function init() {
  try {
    me = await api.me();
    $('#who').innerHTML = `Admin <span>· ${esc(me.name)}</span>`;
    renderViewBanner(me, { onExit: async () => { await api.god.exit(); location.reload(); } });
    renderNav(me, '/admin/');
    renderTabs();
    await show(location.hash.slice(1) || 'periods');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login'; return; }
    showError(main, err);
  }
}

function renderTabs() {
  const nav = $('#tabs');
  nav.replaceChildren(...TABS
    .filter((t) => !t.superadmin || me.role === 'superadmin')
    .map((t) => t.href
      ? el('a', { class: 'tab', href: t.href }, t.label)
      : el('button', { class: 'tab', type: 'button', 'data-tab': t.id,
                       onclick: () => show(t.id) }, t.label)));
}

async function show(id) {
  // The same role test as renderTabs, applied to the destination rather than
  // to the tab strip. Hiding a tab only hides the button: /admin/#errors typed
  // or bookmarked still reached the panel, which then called a god endpoint and
  // got the 403 it deserved — correct, but an admin met a raw error where they
  // should simply land somewhere sensible.
  const visible = (t) => t.render && (!t.superadmin || me.role === 'superadmin');
  const tab = TABS.find((t) => t.id === id && visible(t)) ?? TABS.find(visible);
  location.hash = tab.id;
  // Tabs change the view without a page load, so trackPage never fires for
  // them. Without this, an admin's whole session reads as one visit to /admin.
  trackAction(`admin:${tab.id}`);
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.setAttribute('aria-current', String(button.dataset.tab === tab.id));
  }
  main.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
  try {
    main.replaceChildren(await tab.render());
  } catch (err) {
    showError(main, err);
  }
}

/* ── rates ─────────────────────────────────────────────────────────────── */

/** '2026-07' -> '2026-08' */
function nextMonth(period) {
  const [y, m] = String(period).split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** The building has always paid by the 10th of the month after the usage month. */
function defaultDue(period) {
  return `${nextMonth(period)}-10`;
}

/**
 * The usage months worth offering: the last twelve that have ended, newest
 * first, minus the ones already open.
 *
 * It starts at LAST month, not this one. A usage month cannot be billed until
 * it has finished, because the meter that closes it is read in the month after
 * — the same off-by-one that made this field confusing as free text, where
 * "2026-08" typed during August meant a month that had not happened yet.
 *
 * Already-open months are dropped because `periods.period` is the primary key:
 * choosing one again is not a warning, it is a failed insert.
 */
function selectableMonths(periods) {
  const taken = new Set(periods.map((p) => p.period));
  const now = new Date();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();          // 1-indexed previous month; 0 in January
  const out = [];
  for (let i = 0; i < 12; i += 1) {
    if (month === 0) { month = 12; year -= 1; }
    const period = `${year}-${String(month).padStart(2, '0')}`;
    if (!taken.has(period)) out.push(period);
    month -= 1;
  }
  return out;
}

/** How many months from this one the testing list runs. */
const UNENDED_MONTHS = 5;

/**
 * This month and the next few — months that have NOT ended.
 *
 * Offered only while the demo data is loaded, and that is the whole design.
 * Billing a month that has not finished is meaningless: the meter closing it
 * is read in the month after, so there is nothing to read yet. But a test
 * cannot wait for September to arrive to find out whether September works, and
 * before this the only openable months were ones already full of demo history.
 *
 * The gate is `demoData` rather than a flag or an environment check because it
 * expires by itself. `seed-demo.mjs --remove` must run before the real roster
 * — it is a documented step and doctor reports DEMO-DATA-PRESENT until it
 * happens — and the moment it does, these months stop being offered. Nobody
 * has to remember to turn anything off, which is the only kind of switch that
 * survives a handover.
 *
 * The server does not refuse these independently, and did not refuse them
 * before either: the "months that have ended" rule has always lived in this
 * dropdown alone. So this changes what is easy, not what is possible.
 */
function unendedMonths(periods) {
  const taken = new Set(periods.map((p) => p.period));
  const now = new Date();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1;      // 1-indexed CURRENT month
  const out = [];
  for (let i = 0; i < UNENDED_MONTHS; i += 1) {
    const period = `${year}-${String(month).padStart(2, '0')}`;
    if (!taken.has(period)) out.push(period);
    month += 1;
    if (month === 13) { month = 1; year += 1; }
  }
  return out;
}

async function periodsPanel() {
  const { periods, demoData } = await api.admin.periods();
  const status = el('div');
  const ended = selectableMonths(periods);
  const unended = demoData ? unendedMonths(periods) : [];
  // Ended months first: on any ordinary day that is the one you want, and it
  // stays the default selection. The unended ones sit below, named as such.
  const months = [...ended, ...unended];

  const rate = el('input', { class: 'input num', placeholder: '78.00', id: 'p-rate', inputmode: 'decimal' });
  const fee = el('input', { class: 'input num', value: '50', id: 'p-fee', inputmode: 'numeric' });
  // type=date gives the platform's own calendar, and yields YYYY-MM-DD —
  // already the format the API and the periods table expect, so nothing has to
  // parse a typed date and guess whether 05/08 was May or August.
  const due = el('input', { class: 'input', type: 'date', id: 'p-due' });

  const period = el('select', {
    class: 'input', id: 'p-period',
    // The due date follows the month rather than being typed twice. Still
    // editable — this sets a sensible default, it does not lock it.
    onchange: () => { due.value = defaultDue(period.value); },
  }, ...months.map((p) => el('option', { value: p },
    // Said on the option itself, not only in a note above it. The note is read
    // once; the dropdown is read every time, and "December 2026" sitting in a
    // list of past months is otherwise indistinguishable from a real choice.
    unended.includes(p) ? `${periodLabel(p)} — not ended yet` : periodLabel(p))));

  if (months.length) due.value = defaultDue(months[0]);

  return el('div', { class: 'panel stack' },
    el('h2', {}, 'Rate per kg'),
    el('p', { class: 'muted small' },
      'Set the rate for every month, even when it has not changed. Nothing is '
      + 'carried forward: an inherited rate would produce 99 bills that look '
      + 'normal and are all wrong.'),

    ...(months.length
      ? [
          el('div', { class: 'field' }, el('label', { for: 'p-period' }, 'Usage month'), period,
            el('span', { class: 'field__hint' }, 'The month the gas was used. Meters are read the month after.')),
          unended.length
            ? el('div', { class: 'note note--warn' },
                el('b', {}, 'Months that have not ended are listed, for testing.'),
                el('p', { style: 'margin:var(--s-2) 0 0' },
                  'They are there because demo data is still loaded, and they '
                  + 'stop being offered the moment it is removed. A month that '
                  + 'has not finished has no meter reading to close it, so '
                  + 'opening one is only useful for trying the flow — never for '
                  + 'billing anybody.'))
            : null,
          el('div', { class: 'field' }, el('label', { for: 'p-rate' }, 'Rate per kg'), rate),
          el('div', { class: 'field' }, el('label', { for: 'p-due' }, 'Payment due'), due),
          el('div', { class: 'field' }, el('label', { for: 'p-fee' }, 'Late fee (whole rupees)'), fee,
            el('span', { class: 'field__hint' }, 'Whole rupees only. No paise.')),
          status,
          el('button', {
            class: 'btn', type: 'button',
            // Opening a month and entering its readings are one errand, and
            // splitting them left the treasurer on a screen that looked
            // finished. Reported on 2026-08-12: two months were opened and
            // then "unsure how to add readings" — the Readings tab defaults to
            // whatever month it likes and nothing said to go there.
            //
            // The rate-sanity warning is not lost by leaving: the readings
            // screen shows it again on the preview, right beside the total it
            // would produce, which is the more useful place to read it.
            onclick: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              try {
                const r = await api.admin.openPeriod({
                  period: period.value, ratePerKg: Number(rate.value),
                  dueDate: due.value, lateFee: Number(fee.value),
                });
                status.replaceChildren(
                  el('div', { class: 'note note--good' },
                    `Opened ${periodLabel(r.period)}. Taking you to its readings…`));
                location.href = `/admin/readings.html?period=${encodeURIComponent(r.period)}`;
              } catch (err) {
                showError(status, err);
                button.disabled = false;
              }
            },
          }, 'Open month and enter readings'),
        ]
      : [el('p', { class: 'note' },
          'Every month of the last year is already open. Nothing to add here.')]),

    el('hr', { class: 'rule' }),
    el('p', { class: 'label' }, 'Months'),
    ...periods.map(monthRow)
  );
}

function monthRow(p) {
  const panel = el('div');
  return el('div', { class: 'stack', style: 'gap:0' },
    el('div', { class: 'rowitem' },
      el('div', { class: 'rowitem__main' },
        el('b', {}, periodLabel(p.period)),
        el('div', {}, `₹${p.rate_per_kg}/kg · ${p.conversion_factor} kg per unit · due ${p.due_date}`)),
      el('span', { class: `chip ${p.status === 'locked' ? 'chip--paid' : 'chip--awaiting'}` },
        p.status === 'locked' ? 'Locked' : 'Open'),
      el('button', {
        class: 'btn btn--sm btn--quiet', type: 'button',
        onclick: () => panel.replaceChildren(
          p.status === 'locked' ? lockedNotice(p) : rateEditor(p, panel)),
      }, 'Change rate')),
    panel);
}

/**
 * A locked month says who decides, not merely "no".
 *
 * The server refuses this too (DDP-BILL-012) — showing it here is so the
 * treasurer reads the consequence before they go looking for a way around it,
 * not because the interface is the thing enforcing it.
 */
function lockedNotice(p) {
  return el('div', { class: 'note note--warn', style: 'margin:var(--s-3) 0' },
    el('b', {}, `${periodLabel(p.period)} is locked.`),
    el('p', { style: 'margin:var(--s-2) 0 0' },
      'Reach out to Sabarish to change this rate. Reopening a locked month recalculates '
      + 'every bill in it, which means residents who have already paid will need to pay '
      + 'again, and the month has to be reconciled against the bank statement a second time.'));
}

/** An open month can be changed here — after the consequence is on screen. */
function rateEditor(p, panel) {
  const rate = el('input', {
    class: 'input num', value: String(p.rate_per_kg), inputmode: 'decimal',
    id: `edit-rate-${p.period}`,
  });
  const reason = el('input', {
    class: 'input', placeholder: 'Why is the rate changing?', id: `edit-reason-${p.period}`,
  });
  const impact = el('div');

  return el('div', { class: 'stack', style: 'margin:var(--s-3) 0' },
    el('div', { class: 'field' },
      el('label', { for: `edit-rate-${p.period}` }, `Rate per kg for ${periodLabel(p.period)}`), rate),
    el('div', { class: 'field' },
      el('label', { for: `edit-reason-${p.period}` }, 'Reason'), reason,
      el('span', { class: 'field__hint' }, 'Recorded against your name in the activity log.')),
    impact,
    el('div', { class: 'row', style: 'gap:var(--s-2)' },
      el('button', {
        class: 'btn btn--sm', type: 'button',
        // Never straight to the write. The caveat is not a guess — it is the
        // server's own count of whose bill changes and who ends up owing again.
        onclick: async () => {
          try {
            const plan = await api.admin.changeRate(p.period, Number(rate.value), reason.value, true);
            impact.replaceChildren(impactNotice(p, plan, rate, reason, panel));
          } catch (err) { showError(impact, err); }
        },
      }, 'Check what this changes'),
      el('button', {
        class: 'btn btn--sm btn--quiet', type: 'button',
        onclick: () => panel.replaceChildren(),
      }, 'Cancel')));
}

function impactNotice(p, plan, rate, reason, panel) {
  const t = plan.totals;
  const nothing = t.billsAffected === 0 && t.skipped === 0;

  return el('div', { class: `note ${t.owesAgainCount ? 'note--bad' : 'note--warn'}` },
    el('b', {}, nothing
      ? `No bills exist for ${periodLabel(p.period)} yet — only the rate changes.`
      : `${t.billsAffected} bill${t.billsAffected === 1 ? '' : 's'} will be recalculated.`),

    t.owesAgainCount
      ? el('p', { style: 'margin:var(--s-2) 0 0' },
          t.owesAgainCount === 1
            ? `One of them is already paid and gets dearer. That resident will owe `
              + `${money(t.owesAgainTotal)} more, the bill returns to unpaid, and they will `
              + 'have to pay again.'
            : `${t.owesAgainCount} of them are already paid and get dearer. Those residents `
              + `will owe ${money(t.owesAgainTotal)} more between them, their bills return to `
              + 'unpaid, and they will have to pay again.')
      : null,
    t.inCreditCount
      ? el('p', { style: 'margin:var(--s-2) 0 0' },
          `${t.inCreditCount} already-paid bill${t.inCreditCount === 1 ? '' : 's'} get cheaper, `
          + `leaving ${money(t.inCreditTotal)} in credit. Those stay marked paid.`)
      : null,
    t.skipped
      ? el('p', { style: 'margin:var(--s-2) 0 0' },
          `${t.skipped} manually adjusted bill${t.skipped === 1 ? '' : 's'} will be left alone.`)
      : null,
    plan.sanity?.level === 'notice'
      ? el('p', { style: 'margin:var(--s-2) 0 0' }, plan.sanity.message)
      : null,

    el('button', {
      class: 'btn btn--sm', type: 'button', style: 'margin-top:var(--s-3)',
      onclick: async (e) => {
        e.target.disabled = true;
        try {
          await api.admin.changeRate(p.period, Number(rate.value), reason.value, false);
          panel.replaceChildren();
          await show('periods');
        } catch (err) { e.target.disabled = false; showError(panel, err); }
      },
    }, t.owesAgainCount
         ? `Change the rate and make ${t.owesAgainCount} bill${t.owesAgainCount === 1 ? '' : 's'} payable again`
         : 'Change the rate'));
}

/* ── residents ─────────────────────────────────────────────────────────── */

/**
 * A directory keyed by the flat, not a list of people.
 *
 * The committee thinks in apartments — "who is in 7B" is the question actually
 * asked, and the old list answered it by making somebody scan 41 rows for two
 * that happened to share a number. A flat with an owner and a tenant now reads
 * as one entry with two people under it, which is also the only way the
 * tenanted case is visible at all.
 *
 * Rendered as <details> rather than a modal: every other disclosure in this app
 * is a <details>, and one dialog for one screen is a second idiom to maintain.
 */
async function residentsPanel() {
  const status = el('div');
  const list = el('div');
  let showPast = false;
  let groups = [];

  const flat = el('input', { class: 'input', placeholder: '4D', id: 'r-flat' });
  const name = el('input', { class: 'input', placeholder: 'Name', id: 'r-name' });
  const mobile = mobileField('', { label: 'Mobile' });
  const email = el('input', { class: 'input', type: 'email', placeholder: 'none', id: 'r-email' });
  // Who is liable for the gas. The endpoint has always accepted this and the
  // form never sent it, so every tenant added from this console was recorded as
  // an owner — the one field the billing rules actually turn on.
  const relationship = el('select', { class: 'input', id: 'r-rel' },
    el('option', { value: 'owner' }, 'Owner'),
    el('option', { value: 'tenant' }, 'Tenant'));

  const heading = el('h2', {}, 'Residents');
  const past = el('input', { type: 'checkbox', id: 'r-past' });
  past.addEventListener('change', async () => {
    showPast = past.checked;
    await load();
  });

  // Filtered here rather than on the server: 94 flats is a small enough list to
  // hold, and a round-trip per keystroke would make the box feel slower than
  // scrolling — which is the thing it exists to replace.
  const search = el('input', {
    class: 'input', type: 'search', id: 'r-search',
    placeholder: 'Search flat, name, mobile or email',
    'aria-label': 'Search residents',
  });
  search.addEventListener('input', render);

  async function load() {
    list.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
    try {
      const res = await api.admin.residents({ past: showPast });
      mailConfigured = res.mailConfigured !== false;
      groups = groupByFlat(res.residents);
      render();
    } catch (err) { showError(list, err); }
  }

  function render() {
    const query = search.value.trim().toLowerCase();
    const shown = query ? groups.filter((g) => matchesFlat(g, query)) : groups;
    const people = shown.reduce((n, g) => n + g.people.length, 0);

    heading.textContent = query
      ? `Residents · ${people} in ${shown.length} flat${shown.length === 1 ? '' : 's'} matching “${search.value.trim()}”`
      : `Residents · ${people} in ${shown.length} flat${shown.length === 1 ? '' : 's'}`;

    if (!shown.length) {
      list.replaceChildren(el('p', { class: 'muted' }, 'Nobody matches that.'));
      return;
    }
    // Searching means looking for a person, and the answer is inside the flat.
    // Leaving the results closed would make every search a two-step. Cards are
    // rebuilt each keystroke, so clearing the box collapses the list again —
    // predictable, and the alternative is leaving it expanded on whatever was
    // last looked for.
    list.replaceChildren(...shown.map((group) => flatCard(group, status, Boolean(query))));
  }

  await load();

  return el('div', { class: 'panel stack' },
    heading,
    status,
    contactRequests(status),

    el('details', {},
      el('summary', { style: 'font-family:var(--font-ui);cursor:pointer' }, 'Add a resident'),
      el('div', { class: 'stack', style: 'margin-top:var(--s-3)' },
        el('div', { class: 'field' }, el('label', { for: 'r-flat' }, 'Flat'), flat),
        el('div', { class: 'field' }, el('label', { for: 'r-name' }, 'Name'), name),
        el('div', { class: 'field' }, el('label', {}, 'Mobile'), mobile.node),
        el('div', { class: 'field' }, el('label', { for: 'r-email' }, 'Email'), email),
        el('p', { class: 'small' },
          `Without an address they cannot reset their own password, and only `
          + `${ADMINISTRATOR.name} can do it for them.`),
        el('div', { class: 'field' }, el('label', { for: 'r-rel' }, 'Owner or tenant'), relationship),
        el('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            try {
              const r = await api.admin.addResident({
                flat: flat.value, name: name.value, mobile: mobile.value(),
                email: email.value || null, relationship: relationship.value });
              status.replaceChildren(otpPanel(r, name.value));
              flat.value = ''; name.value = ''; email.value = ''; mobile.clear();
              await load();
            } catch (err) { showError(status, err); }
          },
        }, 'Add and issue a password'))),

    el('div', { class: 'field', style: 'margin-top:var(--s-3)' },
      el('label', { for: 'r-search' }, 'Find a resident'), search),

    // Who used to live here is history, and history about people who have left
    // is not something every admin needs on screen to do the monthly job.
    me.role === 'superadmin'
      ? el('label', { class: 'small', style: 'display:flex;gap:var(--s-2);align-items:center' },
          past, 'Show past residents')
      : null,

    el('hr', { class: 'rule' }),
    list,

    el('hr', { class: 'rule' }),
    await billingPanel());
}

/**
 * Which flats are billed at all — a standing setting, not a monthly one.
 *
 * IT LIVES HERE BECAUSE IT IS SET ONCE. `flats.active` was always persistent:
 * a flat left out stays out of every month until somebody puts it back. But the
 * control first went on the Readings screen, which is a per-month screen, and
 * that made a standing decision look like a monthly chore. Sabarish caught it
 * on 2026-08-12. Nothing about the data changed; it was in the wrong room.
 *
 * It has to start from FLATS. The list above is built from `owners`, so a flat
 * nobody has bought has no row in it — 5 of the 99 today — and the one case
 * this exists for could not have been reached from the tab it belongs on.
 *
 * The two cases are named rather than merged, because they end differently:
 *
 *   Unsold — nobody on file. Ends when it is sold: add the resident, bill it.
 *   Vacant — somebody owns it, nobody is living there. Ends when they move in.
 *
 * Neither takes a meter reading and neither gets a bill, not even a zero one.
 * A zero bill is a different thing entirely: a flat somebody LIVES in that
 * happened to burn no gas, which still belongs on the roll.
 */
async function billingPanel() {
  const list = el('div');
  const status = el('div');

  const load = async () => {
    try {
      const { flats } = await api.admin.flats();
      render(flats);
    } catch (err) { showError(list, err); }
  };

  const set = async (f, billed) => {
    const reason = prompt(billed
      ? `Bill ${f.flat} again?\n\nReason (kept on the flat):`
      : `Stop billing ${f.flat}?\n\n`
        + 'It leaves the readings screen and every month can close without it, '
        + 'until you turn it back on here. This is set once, not monthly.\n\n'
        + (f.unsold
            ? 'Nobody is on file for this flat.'
            : `${f.flat} is listed to ${f.residents}. Use this only if nobody is `
              + 'living there. If somebody is, and simply burned no gas, enter the '
              + 'same reading as last month instead.')
        + '\n\nReason (kept on the flat):');
    if (reason == null) return;
    try {
      await api.admin.setFlatActive(f.flat, billed, reason);
      await load();
    } catch (err) { showError(status, err); }
  };

  const render = (flats) => {
    const off = flats.filter((f) => !f.billed);
    const unsold = flats.filter((f) => f.billed && f.unsold);

    list.replaceChildren(
      el('p', { class: 'muted small' },
        `${flats.length - off.length} of ${flats.length} flats are being billed. `
        + 'A flat left out stays out of every month until it is turned back on '
        + 'here — there is nothing to repeat each month.'),

      off.length
        ? el('div', { class: 'stack', style: 'gap:0' },
            el('p', { class: 'label' }, 'Not being billed'),
            ...off.map((f) => el('div', { class: 'rowitem' },
              el('div', { class: 'rowitem__main' },
                el('b', {}, f.flat),
                el('div', { class: 'small' },
                  f.unsold ? 'Unsold — nobody on file' : `Vacant — ${f.residents}`),
                f.reason
                  ? el('div', { class: 'small muted' },
                      `${f.reason}${f.since ? ` · since ${dayLabel(f.since)}` : ''}`)
                  : null),
              el('button', {
                class: 'btn btn--sm btn--quiet', type: 'button',
                onclick: () => set(f, true),
              }, 'Bill it'))))
        : el('p', { class: 'note note--good' }, 'Every flat is being billed.'),

      // Surfaced rather than left to be discovered on the readings screen at
      // the end of a meter walk: a flat with nobody on file is the one that
      // will hold a month open, and it is knowable now.
      unsold.length
        ? el('div', { class: 'stack', style: 'gap:0;margin-top:var(--s-4)' },
            el('p', { class: 'label' }, 'Billed, but nobody is on file'),
            el('p', { class: 'small muted' },
              'Each of these will need a reading before a month can close. If '
              + 'the flat is unsold, stop billing it.'),
            ...unsold.map((f) => el('div', { class: 'rowitem' },
              el('div', { class: 'rowitem__main' }, el('b', {}, f.flat)),
              el('button', {
                class: 'btn btn--sm btn--quiet', type: 'button',
                onclick: () => set(f, false),
              }, 'Stop billing'))))
        : null,

      el('details', { style: 'margin-top:var(--s-4)' },
        el('summary', { style: 'font-family:var(--font-ui);cursor:pointer' },
          'Every flat'),
        el('div', { class: 'stack', style: 'gap:0;margin-top:var(--s-3)' },
          ...flats.map((f) => el('div', { class: 'rowitem' },
            el('div', { class: 'rowitem__main' },
              el('b', {}, f.flat),
              el('div', { class: 'small muted' },
                f.residents ?? 'Nobody on file')),
            el('span', { class: `chip ${f.billed ? 'chip--paid' : 'chip--awaiting'}` },
              f.billed ? 'Billed' : 'Not billed'),
            el('button', {
              class: 'btn btn--sm btn--quiet', type: 'button',
              onclick: () => set(f, !f.billed),
            }, f.billed ? 'Stop billing' : 'Bill it'))))));
  };

  await load();

  return el('div', { class: 'stack' },
    el('h2', {}, 'Which flats are billed'),
    status,
    list);
}

/**
 * Does this flat answer the query?
 *
 * Digits are compared with the punctuation removed, so '9846' finds
 * '+91 98464 66511' — an admin reading a number off a phone screen types what
 * they see, not what the column stores.
 */
function matchesFlat(group, query) {
  const digits = query.replace(/\D/g, '');
  if (group.flat.toLowerCase().startsWith(query)) return true;
  return group.people.some((p) =>
    String(p.name ?? '').toLowerCase().includes(query)
    || String(p.email ?? '').toLowerCase().includes(query)
    || (digits.length >= 3 && String(p.mobile ?? '').replace(/\D/g, '').includes(digits)));
}

/** [{flat, floor, people}] in the order the server sent, flats not repeated. */
function groupByFlat(residents) {
  const byFlat = new Map();
  for (const r of residents) {
    if (!byFlat.has(r.flat)) byFlat.set(r.flat, { flat: r.flat, floor: r.floor, people: [] });
    byFlat.get(r.flat).people.push(r);
  }
  return [...byFlat.values()];
}

function flatCard(group, status, open = false) {
  const current = group.people.filter((p) => p.active !== 0);
  // Tenanted is derived, never stored — an active tenant in the flat means the
  // tenant is billed and the owner is absent (migration 0011).
  const tenanted = current.some((p) => p.relationship === 'tenant');
  const names = (current.length ? current : group.people).map((p) => p.name).join(', ');

  return el('details', { class: 'flat', open: open || null },
    el('summary', {},
      el('span', { class: 'flat__no' }, group.flat),
      el('span', { class: 'flat__who' }, names || 'No current resident'),
      tenanted ? el('span', { class: 'chip chip--neutral' }, 'Tenanted') : null,
      current.some((p) => p.must_change_pw)
        ? el('span', { class: 'chip chip--awaiting' }, 'Temp password') : null),
    ...group.people.map((p) => personCard(p, status)));
}

function personCard(p, status) {
  const inactive = p.active === 0;

  return el('div', { class: `person ${inactive ? 'person--past' : ''}` },
    el('div', { class: 'person__head' },
      el('b', {}, p.name),
      p.relationship === 'tenant' ? el('span', { class: 'chip chip--neutral' }, 'tenant') : null,
      p.role !== 'owner' ? el('span', { class: 'chip chip--neutral' }, p.role) : null,
      inactive
        ? el('span', { class: 'chip chip--neutral' },
            // With the year: a past resident can be years past, and "12 Mar"
            // alone would not say which one.
            p.moved_out_at
              ? `moved out ${dayLabel(p.moved_out_at)} ${new Date(p.moved_out_at).getUTCFullYear()}`
              : 'no longer resident')
        : null,
      !inactive && p.must_change_pw ? el('span', { class: 'chip chip--awaiting' }, 'Temp password') : null),

    el('div', { class: 'dirgrid' },
      el('div', { class: 'dircell' },
        el('span', { class: 'dircell__label' }, 'Flat'),
        el('span', { class: 'dircell__static' }, `${p.flat} · floor ${p.floor}`)),
      // A past resident is a record, not a person to contact. Editing their
      // number or handing them a password is never the right thing to do.
      inactive ? el('div', { class: 'dircell' },
                     el('span', { class: 'dircell__label' }, 'Mobile'),
                     el('span', { class: 'dircell__static' }, p.mobile))
               : editable(p, 'mobile', 'Mobile', status),
      inactive ? el('div', { class: 'dircell' },
                     el('span', { class: 'dircell__label' }, 'Email'),
                     el('span', { class: 'dircell__static' }, p.email || '—'))
               : editable(p, 'email', 'Email', status, { type: 'email', placeholder: 'none' })),

    // Resetting is the superadmin's alone as of 2026-08-12. An admin who could
    // reset 7B could log in AS 7B, so the button is not merely hidden — the
    // endpoint refuses them too (canResetPassword). What replaces it for an
    // admin is the sentence, because they are the one standing in front of the
    // resident and they need to know what to say.
    inactive ? null : el('div', { style: 'margin-top:var(--s-3)' },
      // Superadmin always; an admin only while there is no mailbox, which is
      // exactly when the sentence below would be a lie. Kept in step with
      // canResetPassword — if these two disagree the admin meets a button that
      // refuses them, or advice that cannot work.
      (me.role === 'superadmin' || (me.role === 'admin' && !mailConfigured))
        ? el('div', {},
            el('button', {
              class: 'btn btn--sm btn--quiet', type: 'button',
              onclick: async () => {
                try {
                  const result = await api.admin.resetPassword(p.id);
                  status.replaceChildren(otpPanel(result, p, status));
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                } catch (err) { showError(status, err); }
              },
            }, 'Reset password'),
            // Said plainly, because an admin holding this button should know it
            // is on loan. It disappears the day the mailbox is set up, and
            // nobody will deploy anything to make that happen.
            me.role === 'admin'
              ? el('p', { class: 'small muted' },
                  'You can do this only because password-reset email is not set up yet. '
                  + 'Once it is, residents reset themselves and this button goes away.')
              : null)
        : el('p', { class: 'small muted' },
            'Forgotten password? Ask them to tap "Forgotten your password?" on the '
            + 'login page — a code goes to their own email, so nobody else ever holds '
            + `their password. If their email is wrong, ask ${ADMINISTRATOR.name}.`)));
}

/** The two an admin must ask about rather than write. Mirrors REQUESTABLE_FIELDS. */
const REQUESTABLE = ['mobile', 'email'];

/**
 * Contact changes waiting to be approved (B22).
 *
 * Shown to admins as well as to the approver, and deliberately: an admin who
 * cannot see that their own request is still pending will either raise it again
 * or telephone about it, which are the two things this replaced. They see the
 * queue and no buttons.
 *
 * Absent entirely when nothing is waiting. A panel that says "no requests" on
 * every visit is a panel people stop reading, and this one has to be noticed on
 * the day it is not empty.
 */
function contactRequests(status) {
  const box = el('div');

  async function load() {
    let requests;
    try {
      ({ requests } = await api.admin.contactRequests());
    } catch {
      // A directory that will not render because a side panel failed is worse
      // than a directory with no side panel.
      return;
    }
    if (!requests.length) { box.replaceChildren(); return; }

    box.replaceChildren(el('div', { class: 'note' },
      el('p', { class: 'label' },
        `${requests.length} contact ${requests.length === 1 ? 'change' : 'changes'} waiting`),
      ...requests.map((r) => row(r))));
  }

  function row(r) {
    const line = el('div', { class: 'stack', style: 'margin-top:var(--s-3)' },
      el('p', {},
        el('strong', {}, `${r.flat} ${r.name}`),
        ` · ${r.field}: `,
        el('span', { class: 'muted' }, r.current || 'none'),
        ' → ',
        el('strong', {}, r.value || 'none')),
      el('p', { class: 'small muted' }, `“${r.reason}” — ${r.requestedBy}, ${r.at}`));

    if (me.role !== 'superadmin') return line;

    const decide = async (approve) => {
      buttons.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        await api.admin.decideContactRequest(r.id, approve);
        // Reloaded rather than patched in place: approving WRITES the resident's
        // row, so the directory beside this is now stale and the cheapest honest
        // fix is to fetch both again.
        location.reload();
      } catch (err) {
        buttons.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        showError(status, err);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    };

    const buttons = el('div', { class: 'row' },
      el('button', { class: 'btn btn--sm', type: 'button', onclick: () => decide(true) },
        'Approve and apply'),
      el('button', { class: 'btn btn--sm btn--quiet', type: 'button', onclick: () => decide(false) },
        'Reject'));

    line.append(buttons);
    return line;
  }

  load();
  return box;
}

/**
 * One field, read-only until somebody says otherwise.
 *
 * These two are a login identity and the address a reset code goes to, and the
 * directory is a screen people come to in order to LOOK something up. A live
 * input under every number means a stray scroll over a focused field or a paste
 * into the wrong box rewrites a credential nobody meant to touch. Edit is a
 * decision now, and it is saved by pressing Save — no commit-on-blur, because
 * clicking away from a field you opened by accident should cost nothing.
 */
function editable(p, field, label, status, { type = 'text', placeholder = '' } = {}) {
  const wrap = el('div', { class: 'dircell' });
  // Since B22 an admin may fix a name but only ask about a mobile or an address.
  // The button says which of the two this is, because "Edit" that turns out to
  // need a reason and somebody else's approval is a promise the screen breaks.
  const mustRequest = REQUESTABLE.includes(field) && me.role !== 'superadmin';

  function show() {
    wrap.classList.remove('dircell--dirty');
    wrap.replaceChildren(
      el('span', { class: 'dircell__label' }, label),
      el('span', { class: 'dircell__static' },
        el('span', { class: p[field] ? '' : 'dircell__none' }, p[field] || 'none'),
        el('button', {
          class: 'btn--pencil', type: 'button', onclick: edit,
          'aria-label': mustRequest
            ? `Request a change to ${label.toLowerCase()} for ${p.name}, ${p.flat}`
            : `Edit ${label.toLowerCase()} for ${p.name}, ${p.flat}`,
        }, mustRequest ? 'Request' : 'Edit')));
  }

  function edit() {
    // The mobile gets the country picker; the country is the half of a number
    // that cannot be guessed from the digits, and guessing it is the bug.
    const editor = field === 'mobile'
      ? mobileField(p.mobile ?? '', { label: `${label} for ${p.name}, ${p.flat}` })
      : plainEditor();

    const save = el('button', { class: 'btn btn--sm', type: 'button', onclick: commit },
                    mustRequest ? 'Send request' : 'Save');
    const cancel = el('button', { class: 'btn btn--sm btn--quiet', type: 'button', onclick: show }, 'Cancel');
    // Required, and required HERE rather than only server-side, because the
    // approval is reviewed against it: "7B says this is his new number, old one
    // disconnected" is reviewable and "typo" is not.
    const reason = mustRequest
      ? el('input', {
          type: 'text', placeholder: 'Why? e.g. "old number disconnected"',
          'aria-label': `Reason for changing ${label.toLowerCase()} for ${p.name}`,
        })
      : null;

    async function commit() {
      const next = editor.value();
      if (next === String(p[field] ?? '')) { show(); return; }
      save.disabled = true;
      try {
        if (mustRequest) {
          await api.admin.requestContactChange(p.id,
            { field, value: next || null, reason: reason.value.trim() });
          show();
          status.replaceChildren(el('div', { class: 'note note--good' },
            `Requested: ${label.toLowerCase()} for ${p.name} (${p.flat}). `
            + `${ADMINISTRATOR.name} has been notified and it will apply once approved. `
            + 'Until then the number on file is unchanged.'));
          window.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        }
        await api.admin.updateResident(p.id, { [field]: next || null });
        p[field] = next || null;
        show();
        status.replaceChildren(
          el('div', { class: 'note note--good' }, `${label} saved for ${p.name} (${p.flat}).`));
      } catch (err) {
        // The editor stays open with what they typed: a rejected value is
        // usually one keystroke away from a good one, and throwing it away
        // makes them retype a number they just read off a phone.
        save.disabled = false;
        showError(status, err);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }

    function plainEditor() {
      const input = el('input', {
        type, placeholder, value: p[field] ?? '',
        'aria-label': `${label} for ${p.name}, ${p.flat}`,
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') show();
      });
      return { node: input, value: () => input.value.trim(), focus: () => input.focus() };
    }

    wrap.classList.add('dircell--dirty');
    wrap.replaceChildren(
      el('span', { class: 'dircell__label' }, label),
      editor.node,
      reason,
      el('div', { class: 'dircell__actions' }, save, cancel));
    editor.focus();
  }

  show();
  return wrap;
}

/**
 * The reset panel: the password on screen, then a deliberate tap to send it.
 *
 * On screen FIRST, and not as a convenience. Email is the destination that keeps
 * the credential out of everybody else's hands, but it fails in ways this screen
 * cannot see — an address that is wrong, a mailbox that is full, mail not yet
 * configured at all. Showing the superadmin what was issued means a failed send
 * costs a different delivery rather than a resident who is now locked out with a
 * password nobody knows. The old password is already dead by this point; there
 * is no going back from a reset.
 *
 * WhatsApp stays for the residents with no address on file at all — B5's people,
 * for whom it is the only route that exists.
 */
function otpPanel(result, p, status) {
  const sent = el('div');
  const emailBtn = el('button', { class: 'btn btn--block', type: 'button' },
    `Email it to ${result.email}`);

  emailBtn.addEventListener('click', async () => {
    emailBtn.disabled = true;
    emailBtn.textContent = 'Sending…';
    try {
      const r = await api.admin.emailTempPassword(p.id, result.oneTimePassword);
      emailBtn.textContent = 'Emailed';
      emailBtn.classList.add('is-done');
      sent.replaceChildren(el('p', { class: 'small' }, `Sent to ${r.to}.`));
    } catch (err) {
      // The password on screen is still the live one, so this must not read as
      // "the reset failed" — it did not.
      showError(sent, err);
      emailBtn.disabled = false;
      emailBtn.textContent = `Try again — email to ${result.email}`;
    }
  });

  return el('div', { class: 'note note--good' },
    el('p', { class: 'label', style: 'color:var(--accent)' }, `Temporary password for ${p.name}`),
    el('p', { style: 'font-family:var(--font-ui);font-size:var(--text-xl);font-weight:600;margin:var(--s-2) 0' },
      result.oneTimePassword),
    el('p', { class: 'small' },
      `It expires in ${result.expiresInHours} hours. They must change it at first `
      + 'login, and all their other sessions have already ended.'),
    result.email
      ? emailBtn
      : el('a', { class: 'btn btn--block', href: result.whatsapp, target: '_blank', rel: 'noopener' },
          'Send on WhatsApp'),
    result.email
      ? null
      : el('p', { class: 'small muted', style: 'margin-top:var(--s-2)' },
          `${p.name} has no email address on file, so there is nowhere to email it. `
          + 'Adding one now means they can recover their own account next time.'),
    sent);
}

/* ── notices ───────────────────────────────────────────────────────────── */


async function noticesPanel() {
  const { notices } = await api.notices();
  const status = el('div');

  const title = el('input', { class: 'input', id: 'n-title' });
  const body = el('textarea', { class: 'input', id: 'n-body', style: 'min-height:100px' });
  const isEvent = el('input', { type: 'checkbox', id: 'n-event' });
  const allowComments = el('input', { type: 'checkbox', id: 'n-comments' });
  // A checkbox rather than a dropdown, and unticked by default: 'all' is the
  // right answer for nearly every notice, and the narrower option should be a
  // thing somebody chooses on purpose.
  const ownersOnly = el('input', { type: 'checkbox', id: 'n-owners' });
  const files = el('input', {
    type: 'file', class: 'input', id: 'n-files', multiple: true,
    accept: 'image/jpeg,image/png,image/webp,application/pdf',
  });

  return el('div', { class: 'panel stack' },
    el('h2', {}, 'Notices'),
    status,
    el('div', { class: 'field' }, el('label', { for: 'n-title' }, 'Title'), title),
    el('div', { class: 'field' }, el('label', { for: 'n-body' }, 'Body'), body),
    // Stated rather than hidden behind a toolbar: what is on offer is short
    // enough to write down, and a committee member typing on a phone should
    // not have to discover it by accident.
    el('p', { class: 'small muted' },
      'Blank lines start a new paragraph. **bold**, *italic*, '
      + '[link text](https://…), and lines beginning with - become a list.'),
    el('label', { class: 'row', style: 'gap:var(--s-2)' }, isEvent, 'This is an event'),
    el('label', { class: 'row', style: 'gap:var(--s-2)' }, allowComments, 'Allow replies'),
    el('p', { class: 'small muted' },
      'Replies carry each resident’s name and flat. Leave them off for announcements.'),
    el('label', { class: 'row', style: 'gap:var(--s-2)' }, ownersOnly, 'Owners only'),
    el('p', { class: 'small muted' },
      'For AGM papers and anything with a vote attached. Owners living elsewhere '
      + 'still see it; tenants do not, and cannot reply to it.'),
    el('div', { class: 'field' },
      el('label', { for: 'n-files' }, 'Attach files'),
      files,
      el('p', { class: 'small muted' },
        'Up to 5 photos or PDFs — the agenda, quotes, the accounts. '
        + 'Photos keep their full quality. 25MB each; anything over 20MB alerts Telegram.')),
    el('button', {
      class: 'btn', type: 'button',
      onclick: async (event) => {
        const publish = event.currentTarget;
        publish.disabled = true;
        try {
          // The notice is created first and the files are attached to it. If an
          // upload fails the committee is looking at a published notice missing
          // one document, which they can fix from here — better than a silent
          // half-write, and better than holding the notice back over a file.
          const { id } = await api.admin.addNotice({
            title: title.value, body: body.value,
            kind: isEvent.checked ? 'event' : 'notice',
            allowComments: allowComments.checked,
            scope: ownersOnly.checked ? 'owners' : 'all',
          });

          const chosen = [...files.files].slice(0, 5);
          for (const [i, file] of chosen.entries()) {
            status.replaceChildren(el('p', { class: 'small muted' },
              `Uploading ${i + 1} of ${chosen.length}…`));
            const ready = await prepareUpload(file);
            await api.attach('notice', id, ready, await makeThumbnail(ready));
          }
          await show('notices');
        } catch (err) {
          showError(status, err);
          publish.disabled = false;
        }
      },
    }, 'Publish'),

    el('hr', { class: 'rule' }),
    ...notices.map((n) =>
      el('div', { class: 'rowitem' },
        el('div', { class: 'rowitem__main' },
          el('b', {}, n.title),
          // Shown on the row, because a narrowed audience is invisible
          // otherwise and "why did nobody see this" is the question it causes.
          el('div', {}, `${stampLabel(n.postedAt)} · ${n.commentCount} replies`
            + (n.scope === 'owners' ? ' · owners only' : ''))),
        el('button', {
          class: 'btn btn--sm btn--quiet', type: 'button',
          onclick: async () => {
            await api.admin.updateNotice(n.id, { allowComments: !n.allowComments });
            await show('notices');
          },
        }, n.allowComments ? 'Replies on' : 'Replies off'),
        el('button', {
          class: 'btn btn--sm btn--quiet', type: 'button',
          onclick: async () => {
            await api.admin.updateNotice(n.id, { active: false });
            await show('notices');
          },
        }, 'Withdraw')))
  );
}

/* ── messages ──────────────────────────────────────────────────────────── */

/**
 * The committee owning a readable copy of its own records is the point — it is
 * exactly what the old site failed to provide. Available to admins, not just
 * the superadmin.
 */
function exportPanel() {
  const tables = ['bills', 'readings', 'owners', 'periods', 'payment_proofs', 'audit_log', 'messages'];
  return el('div', { class: 'panel stack' },
    el('h2', {}, 'Download the data'),
    // The old copy promised a nightly Drive copy flatly. That has never once
    // been true — the secrets have never been set, so runBackup returns early
    // every night. Whether it happens is now answered below, by the watermark,
    // rather than asserted here.
    el('p', { class: 'muted small' },
      'CSV, openable in Excel. Passwords are never included.'),
    el('a', { class: 'btn', href: '/api/admin/export', download: '' }, 'Download everything'),
    el('p', { class: 'label', style: 'margin-top:var(--s-4)' }, 'Single table'),
    el('div', { class: 'row', style: 'flex-wrap:wrap' },
      ...tables.map((t) =>
        el('a', { class: 'btn btn--sm btn--quiet', href: `/api/admin/export?table=${t}`, download: '' }, t))),
    el('hr', { class: 'rule' }),
    el('p', { class: 'label' }, 'Nightly backup'),
    backupHealthLine());
}

/**
 * Two different questions, and the second is the one that matters.
 *
 * "Is the token valid" is a live check and answers whether tonight's run could
 * work. "When did a file last land" is the watermark, and it is the only thing
 * that can tell a working backup from one that stopped weeks ago — which is
 * what actually happened here: written in phase 8, deployed, never run once,
 * and nothing said so.
 */
function backupHealthLine() {
  const line = el('p', { class: 'small muted' }, 'Checking…');
  api.admin.backupHealth().then((h) => {
    line.replaceChildren(
      h.ok
        ? 'Google Drive is reachable and the token is valid.'
        : h.reason === 'not-configured'
          ? 'Not set up yet. Add the Google secrets to enable nightly off-site copies.'
          : `Backup is BROKEN (${h.reason}). A refresh token issued in OAuth "Testing" mode expires after 7 days. Publish the consent screen.`,
      el('br'),
      lastBackupText(h));
    if (!h.ok && h.reason !== 'not-configured') line.className = 'small';
  }).catch(() => line.replaceChildren('Could not check.'));
  return line;
}

function lastBackupText(h) {
  if (!h.lastBackupAt) {
    return h.reason === 'not-configured'
      ? 'No copy has ever been written.'
      : 'No copy has been written yet — the first runs at 3am.';
  }
  const days = Math.floor((Date.now() - new Date(h.lastBackupAt)) / 86_400_000);
  const when = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  // Stated in days rather than a timestamp, because the only question anyone
  // asks of this line is "recently enough?".
  return `Last copy written ${when}.`;
}

async function messagesPanel() {
  const { messages } = await api.admin.messages();
  const open = messages.filter((m) => !m.handled_at);

  return el('div', { class: 'panel stack' },
    el('h2', {}, `Messages · ${open.length} unanswered`),
    ...(messages.length
      ? messages.map((m) =>
          el('div', { class: 'rowitem', style: m.handled_at ? 'opacity:.55' : '' },
            el('div', { class: 'rowitem__main' },
              // The subject leads, because it is what decides who deals with
              // this. A sender who skipped the dropdown gets no chip rather
              // than a guess — "Something else" is a choice they can make and
              // this is not the same thing.
              el('b', {}, m.subject ? `${m.subject} · ${m.name}` : m.name),
              el('div', {}, [m.email, m.phone].filter(Boolean).map(esc).join(' · ') || 'no contact given'),
              el('p', { style: 'margin-top:var(--s-2)' }, m.body)),
            m.handled_at
              ? el('span', { class: 'chip chip--paid' }, 'Done')
              : el('button', {
                  class: 'btn btn--sm', type: 'button',
                  onclick: async () => { await api.admin.markMessageHandled(m.id); await show('messages'); },
                }, 'Mark handled')))
      : [el('p', { class: 'muted' }, 'No messages.')])
  );
}

/* ── archive ───────────────────────────────────────────────────────────── */

async function archivePanel() {
  const [{ proofs, stored }, { notices }] = await Promise.all([
    api.admin.proofArchive(),
    api.admin.noticeArchive(),
  ]);

  return el('div', { class: 'stack' },
    withdrawnNotices(notices),
    proofArchive(proofs, stored));
}

/**
 * Withdrawn notices, kept rather than destroyed.
 *
 * Withdrawing used to hide a notice from everyone including the superadmin,
 * while its replies and uploaded files stayed in the database and in R2 —
 * retained, paid for, and readable by nobody. This is the other half of that
 * decision: the committee can still open what it took down.
 *
 * Restoring is an admin's call, because withdrawing already is and an action
 * whose undo needs a more senior person is a trap. Destroying is the
 * superadmin's alone.
 */
function withdrawnNotices(notices) {
  return el('div', { class: 'panel stack' },
    el('h2', {}, 'Withdrawn notices'),
    el('p', { class: 'muted small' },
      'Taken off the board but kept, with their replies and files. Restoring '
      + 'puts one back in front of residents.'
      + (me.role === 'superadmin'
        ? ' Deleting destroys it and its files for good.'
        : ` Only ${ADMINISTRATOR.name} can delete one permanently.`)),

    ...(notices.length
      ? notices.map((n) =>
          el('div', { class: 'rowitem' },
            el('div', { class: 'rowitem__main' },
              el('b', {}, n.title),
              el('div', {}, `${stampLabel(n.postedAt)} · ${n.commentCount} replies`
                + (n.attachmentCount ? ` · ${n.attachmentCount} files` : '')
                + (n.scope === 'owners' ? ' · owners only' : ''))),
            el('button', {
              class: 'btn btn--sm btn--quiet', type: 'button',
              onclick: async () => {
                await api.admin.updateNotice(n.id, { active: true });
                await show('archive');
              },
            }, 'Restore'),
            me.role === 'superadmin'
              ? el('button', {
                  class: 'btn btn--sm btn--danger', type: 'button',
                  onclick: async () => {
                    // Names what goes, and says it twice over: this is the one
                    // action on the notice board with nothing behind it.
                    const what = [`“${n.title}”`, `${n.commentCount} replies`]
                      .concat(n.attachmentCount ? [`${n.attachmentCount} files`] : []).join(', ');
                    if (!confirm(`Permanently delete ${what}?\n\nThis cannot be undone.`)) return;
                    await api.god.purgeNotice(n.id);
                    await show('archive');
                  },
                }, 'Delete for good')
              : null))
      : [el('p', { class: 'muted' }, 'Nothing withdrawn.')]));
}

function proofArchive(proofs, stored) {
  return el('div', { class: 'panel stack' },
    el('h2', {}, 'Payment proofs'),
    el('p', { class: 'muted small' },
      `${stored} stored. Images are deleted after 24 months; the reference and image `
      + 'fingerprint are kept, because deleting those would destroy the duplicate check.'),
    el('div', { class: 'thumbs' },
      ...proofs.map((p) =>
        el('div', { class: 'pcard' },
          p.deleted_at
            ? el('div', { class: 'gone' }, 'Image deleted')
            : el('img', { src: `/api/proof/${p.id}/image`, alt: `Proof from ${p.flat}`, loading: 'lazy' }),
          el('div', { class: 'b' },
            `${p.flat} · ${periodLabel(p.period)}`,
            el('div', { class: 'muted' },
              `${p.parsed_amount != null ? money(p.parsed_amount) : 'unread'} · ${p.status}`),
            p.deleted_at
              ? el('div', { class: 'muted' }, 'reference kept')
              : el('button', {
                  class: 'linkish', type: 'button', style: 'margin-top:var(--s-1)',
                  onclick: async () => {
                    if (!confirm(`Delete the image for ${p.flat}? The reference is kept.`)) return;
                    await api.admin.deleteProof(p.id);
                    await show('archive');
                  },
                }, 'Delete image')))))
  );
}

/* ── errors ────────────────────────────────────────────────────────────── */

async function errorsPanel() {
  const { errors } = await api.god.errors();

  return el('div', { class: 'panel stack' },
    el('h2', {}, 'Errors · last 7 days'),
    el('p', { class: 'muted small' },
      'Every code is documented in docs/ERROR_CODES.md, which is generated from the '
      + 'registry and drift-tested. Fatal and error push to Telegram immediately.'),
    ...(errors.length
      ? errors.map((e) =>
          el('div', { class: 'rowitem' },
            el('span', { class: `sev sev--${e.severity}` }, e.severity.toUpperCase()),
            el('div', { class: 'rowitem__main' },
              el('b', {}, e.code),
              el('div', {}, e.message ?? ''),
              el('div', { class: 'muted' }, `${e.count}× · last ${e.last_seen}`))))
      : [el('div', { class: 'note note--good' }, 'Nothing logged in the last week.')])
  );
}


/**
 * Late fees: who is being charged, and who has been let off.
 *
 * One panel because they are the same question asked twice. Splitting them is
 * how a standing exemption stops being noticed — the whole risk this feature
 * carries is an exemption granted during one dispute and still running two
 * years later, invisible to whoever inherited the treasurer's job.
 */
/**
 * Bill corrections waiting on the committee.
 *
 * The rule the building agreed: readings are checked before they are
 * submitted, so an edit afterwards means somebody already got it wrong, and
 * money must not move on one person's say-so. Two other admins agree — every
 * other admin when the bill belongs to one of them — and never the person who
 * raised it or the household it belongs to.
 *
 * The screen states WHY a button is unavailable rather than hiding it. "You
 * raised this" and "this is your flat's bill" are the safeguard working, and an
 * admin who cannot tell the difference between that and a broken page will ring
 * somebody about it.
 */
async function approvalsPanel() {
  const list = el('div', { class: 'stack' });
  const status = el('div');

  const load = async () => {
    try {
      const { requests } = await api.admin.billEdits();
      if (!requests.length) {
        list.replaceChildren(el('p', { class: 'muted' },
          'Nothing waiting. Bill corrections appear here for a second pair of eyes.'));
        return;
      }
      list.replaceChildren(...requests.map((r) => card(r)));
    } catch (err) { showError(list, err); }
  };

  const decide = async (id, how) => {
    status.replaceChildren();
    try {
      const res = how === 'approve'
        ? await api.admin.approveEdit(id)
        : await api.admin.rejectEdit(id);
      status.replaceChildren(el('div', { class: 'note note--good' },
        res.status === 'applied' ? 'Approved — the bill has been corrected.'
        : res.status === 'rejected' ? 'Rejected. The bill is unchanged.'
        : `Approved. Waiting for ${res.required - res.approvals} more.`));
      await load();
    } catch (err) { showError(status, err); }
  };

  // .rowitem, because that is what this page defines. .rec lives in
  // god-edit.html and would arrive here unstyled.
  const card = (r) => el('div', { class: 'rowitem' },
    el('div', { class: 'rowitem__main' },
      el('b', {}, `${r.flat} · ${periodLabel(r.period)}`),
      el('div', {},
        `${r.field}: `, money(r.total_before), ' → ', money(r.total_after),
        ` · ${r.approvals} of ${r.required} approved`),
      el('div', {}, `Asked by ${r.requested_by_name ?? 'an admin'} · ${r.reason}`)),
    r.canApprove
      ? el('div', { style: 'display:flex;gap:var(--s-3)' },
          el('button', { class: 'btn btn--sm', type: 'button',
            onclick: () => decide(r.id, 'approve') },
            r.substitute ? 'Approve (standing in)' : 'Approve'),
          el('button', { class: 'btn btn--sm btn--ghost', type: 'button',
            onclick: () => decide(r.id, 'reject') }, 'Reject'))
      : el('div', { class: 'small muted' },
          r.blockedBecause === 'requester' ? 'You raised this, so you cannot approve it.'
          : r.blockedBecause === 'too-soon'
            ? `Waiting on an admin — you can stand in in ${r.hoursLeft}h.`
            : 'Not yours to approve.'));

  await load();

  return el('div', { class: 'panel stack' },
    el('h2', {}, 'Bill corrections'),
    el('p', { class: 'small muted' },
      'A correction that moves a total needs two other admins. If the bill '
      + 'belongs to an admin, every other admin has to agree, and nobody ever '
      + 'approves a bill for their own flat. While a correction is waiting, the '
      + 'late fee on that bill is frozen.'),
    status,
    list);
}

async function lateFeesPanel() {
  const wrap = el('div', { class: 'stack' }, el('p', { class: 'muted' }, 'Loading…'));

  const draw = async () => {
    const d = await api.admin.lateFees();
    const rows = [];

    rows.push(el('div', { class: 'panel stack' },
      el('h2', {}, 'Fees charged'),
      el('p', { class: 'muted small' },
        'A fee is added once per bill, never repeated. Waiving removes it from the '
        + 'total and is recorded against your name.'),
      ...(d.charged.length
        ? d.charged.map((b) => {
            const waive = el('button', { class: 'btn btn--ghost', type: 'button' }, 'Waive');
            waive.addEventListener('click', async () => {
              waive.disabled = true;
              try { await api.admin.waiveLateFee(b.id); await draw(); }
              catch (err) { showError(wrap, err); waive.disabled = false; }
            });
            return el('div', { class: 'row row--between' },
              el('div', {},
                el('strong', {}, `${b.flat} · ${money(b.late_fee)}`),
                el('div', { class: 'muted small' },
                  `${b.period} · ${b.owner_name ?? 'unassigned'} · total ${money(b.total)}`)),
              b.status === 'paid' || b.status === 'waived'
                ? el('span', { class: 'muted small' }, b.status)
                : waive);
          })
        : [el('p', { class: 'muted small' }, 'No late fees have been charged.')])));

    rows.push(el('div', { class: 'panel stack' },
      el('h2', {}, 'Exemptions'),
      el('p', { class: 'muted small' },
        'Every exemption ends on a date. Renewing is a decision; forgetting is not.'),
      ...(d.exempt.length
        ? d.exempt.map((e) => {
            const clear = el('button', { class: 'btn btn--ghost', type: 'button' }, 'End now');
            clear.addEventListener('click', async () => {
              clear.disabled = true;
              try { await api.admin.setExemption(e.id, '', ''); await draw(); }
              catch (err) { showError(wrap, err); clear.disabled = false; }
            });
            return el('div', { class: 'row row--between' },
              el('div', {},
                el('strong', {}, `${e.flat} · ${e.name}`),
                el('div', { class: 'muted small' },
                  `${e.active ? 'Until' : 'Expired'} ${e.late_fee_exempt_until} — ${e.late_fee_exempt_reason ?? ''}`)),
              e.active ? clear : el('span', { class: 'muted small' }, 'expired'));
          })
        : [el('p', { class: 'muted small' }, 'Nobody is exempt.')])));

    // Granting them. Deliberately below the list, so the existing exemptions
    // are read before another is added.
    const flats = el('input', { class: 'input', placeholder: '4A 4B 5A   or   all' });
    const until = el('input', { class: 'input', type: 'date' });
    const why = el('input', { class: 'input', placeholder: 'Supply outage 12-18 August' });
    const status = el('div');
    const save = el('button', { class: 'btn', type: 'button', disabled: true }, 'Exempt');
    let checked = null;

    // Tick people instead of typing flat numbers. Picking six out of ninety-nine
    // by hand is where a typo becomes somebody billed who should not have been,
    // and the field and the list stay in step so either way of working is fine.
    const { residents } = await api.admin.residents();
    const picker = el('div', { class: 'picker' },
      ...residents.map((r) => {
        const box = el('input', { type: 'checkbox', value: r.flat });
        box.addEventListener('change', () => {
          const on = [...picker.querySelectorAll('input:checked')].map((b) => b.value);
          flats.value = on.join(' ');
          flats.dispatchEvent(new Event('input'));
        });
        return el('label', { class: 'picker__row' }, box,
          el('span', {}, el('strong', {}, r.flat), ` ${r.name}`));
      }));

    // Typing into the field is the other direction: keep the ticks honest so
    // the two never disagree about who is about to be exempted.
    const syncPicker = () => {
      const wanted = new Set(flats.value.toUpperCase().split(/[\s,;]+/).filter(Boolean));
      for (const box of picker.querySelectorAll('input')) box.checked = wanted.has(box.value);
    };

    rows.push(el('div', { class: 'panel stack' },
      el('h2', {}, 'Exempt residents'),
      el('p', { class: 'muted small' },
        'One flat or many. The exemption lands on whoever is billed — the tenant '
        + 'where there is one, the owner otherwise.'),
      status,
      el('div', { class: 'field' }, el('label', {}, 'Flats'), flats,
        el('span', { class: 'field__hint' },
          'Tick below, or type them. "all" covers the whole building.')),
      el('details', { class: 'panel-sub' },
        el('summary', {}, `Choose from ${residents.length} residents`),
        picker),
      el('div', { class: 'field' }, el('label', {}, 'Until'), until,
        el('span', { class: 'field__hint' }, 'Inclusive. They are charged again the day after.')),
      el('div', { class: 'field' }, el('label', {}, 'Reason'), why,
        el('span', { class: 'field__hint' },
          'Required, and shared by everyone in this batch. The committee changes.')),
      el('div', { class: 'row' }, check, save)));

    wrap.replaceChildren(...rows);
  };

  draw().catch((err) => showError(wrap, err));
  return wrap;
}
