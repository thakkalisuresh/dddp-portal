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
import { $, el, esc, renderGodBanner, showError } from './ui.js';
import { money, kg, periodLabel, dayLabel } from './i18n.js';

const main = $('#main');
let me = null;

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
    renderGodBanner(me, { onExit: async () => { await api.god.exit(); location.reload(); } });
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

async function periodsPanel() {
  const { periods } = await api.admin.periods();
  const status = el('div');
  const months = selectableMonths(periods);

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
  }, ...months.map((p) => el('option', { value: p }, periodLabel(p))));

  if (months.length) due.value = defaultDue(months[0]);

  return el('div', { class: 'panel stack' },
    el('h2', {}, 'Rate per kg'),
    el('p', { class: 'muted small' },
      'Set the rate for every month, even when it has not changed. Nothing is '
      + 'carried forward: an inherited rate would produce 52 bills that look '
      + 'normal and are all wrong.'),

    ...(months.length
      ? [
          el('div', { class: 'field' }, el('label', { for: 'p-period' }, 'Usage month'), period,
            el('span', { class: 'field__hint' }, 'The month the gas was used. Meters are read the month after.')),
          el('div', { class: 'field' }, el('label', { for: 'p-rate' }, 'Rate per kg'), rate),
          el('div', { class: 'field' }, el('label', { for: 'p-due' }, 'Payment due'), due),
          el('div', { class: 'field' }, el('label', { for: 'p-fee' }, 'Late fee (whole rupees)'), fee,
            el('span', { class: 'field__hint' }, 'Whole rupees only. No paise.')),
          status,
          el('button', {
            class: 'btn', type: 'button',
            onclick: async () => {
              try {
                const r = await api.admin.openPeriod({
                  period: period.value, ratePerKg: Number(rate.value),
                  dueDate: due.value, lateFee: Number(fee.value),
                });
                status.replaceChildren(
                  el('div', { class: r.sanity.level === 'warn' ? 'note note--warn' : 'note note--good' },
                    r.sanity.level === 'warn' ? r.sanity.message : `Opened ${periodLabel(r.period)}.`));
                await show('periods');
              } catch (err) { showError(status, err); }
            },
          }, 'Open month'),
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

async function residentsPanel() {
  const { residents } = await api.admin.residents();
  const status = el('div');

  const flat = el('input', { class: 'input', placeholder: '4D', id: 'r-flat' });
  const name = el('input', { class: 'input', placeholder: 'Name', id: 'r-name' });
  const mobile = el('input', { class: 'input num', placeholder: '9XXXXXXXXX', id: 'r-mobile', inputmode: 'numeric' });

  return el('div', { class: 'panel stack' },
    el('h2', {}, `Residents · ${residents.length}`),
    status,

    el('details', {},
      el('summary', { style: 'font-family:var(--font-ui);cursor:pointer' }, 'Add a resident'),
      el('div', { class: 'stack', style: 'margin-top:var(--s-3)' },
        el('div', { class: 'field' }, el('label', { for: 'r-flat' }, 'Flat'), flat),
        el('div', { class: 'field' }, el('label', { for: 'r-name' }, 'Name'), name),
        el('div', { class: 'field' }, el('label', { for: 'r-mobile' }, 'Mobile'), mobile),
        el('button', {
          class: 'btn', type: 'button',
          onclick: async () => {
            try {
              const r = await api.admin.addResident({
                flat: flat.value, name: name.value, mobile: mobile.value });
              status.replaceChildren(otpPanel(r, name.value));
            } catch (err) { showError(status, err); }
          },
        }, 'Add and issue a password'))),

    el('hr', { class: 'rule' }),
    ...residents.map((r) =>
      el('div', { class: 'rowitem' },
        el('div', { class: 'rowitem__main' },
          el('b', {}, `${r.flat} · ${r.name}`),
          el('div', {}, `${r.mobile}${r.email ? ' · ' + r.email : ''}`)),
        r.role !== 'owner' ? el('span', { class: 'chip chip--neutral' }, r.role) : null,
        r.must_change_pw ? el('span', { class: 'chip chip--awaiting' }, 'Temp password') : null,
        el('button', {
          class: 'btn btn--sm btn--quiet', type: 'button',
          onclick: async () => {
            try {
              const result = await api.admin.resetPassword(r.id);
              status.replaceChildren(otpPanel(result, r.name));
              window.scrollTo({ top: 0, behavior: 'smooth' });
            } catch (err) { showError(status, err); }
          },
        }, 'Reset password')))
  );
}

/**
 * The reset panel is the whole point of the WhatsApp path: a say-able password
 * and a single tap to send it. No API, no cost, and the treasurer knowing the
 * resident by face is the identity check (plan §4b).
 */
function otpPanel(result, who) {
  return el('div', { class: 'note note--good' },
    el('p', { class: 'label', style: 'color:var(--accent)' }, `Temporary password for ${who}`),
    el('p', { style: 'font-family:var(--font-ui);font-size:var(--text-xl);font-weight:600;margin:var(--s-2) 0' },
      result.oneTimePassword),
    el('a', { class: 'btn btn--block', href: result.whatsapp, target: '_blank', rel: 'noopener' },
      'Send on WhatsApp'),
    el('p', { class: 'small', style: 'margin-top:var(--s-2)' },
      'They must change it at first login. All their other sessions have ended.'));
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

  return el('div', { class: 'panel stack' },
    el('h2', {}, 'Notices'),
    status,
    el('div', { class: 'field' }, el('label', { for: 'n-title' }, 'Title'), title),
    el('div', { class: 'field' }, el('label', { for: 'n-body' }, 'Body'), body),
    el('label', { class: 'row', style: 'gap:var(--s-2)' }, isEvent, 'This is an event'),
    el('label', { class: 'row', style: 'gap:var(--s-2)' }, allowComments, 'Allow replies'),
    el('p', { class: 'small muted' },
      'Replies carry each resident’s name and flat. Leave them off for announcements.'),
    el('label', { class: 'row', style: 'gap:var(--s-2)' }, ownersOnly, 'Owners only'),
    el('p', { class: 'small muted' },
      'For AGM papers and anything with a vote attached. Owners living elsewhere '
      + 'still see it; tenants do not, and cannot reply to it.'),
    el('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        try {
          await api.admin.addNotice({
            title: title.value, body: body.value,
            kind: isEvent.checked ? 'event' : 'notice',
            allowComments: allowComments.checked,
            scope: ownersOnly.checked ? 'owners' : 'all',
          });
          await show('notices');
        } catch (err) { showError(status, err); }
      },
    }, 'Publish'),

    el('hr', { class: 'rule' }),
    ...notices.map((n) =>
      el('div', { class: 'rowitem' },
        el('div', { class: 'rowitem__main' },
          el('b', {}, n.title),
          // Shown on the row, because a narrowed audience is invisible
          // otherwise and "why did nobody see this" is the question it causes.
          el('div', {}, `${dayLabel(n.postedAt)} · ${n.commentCount} replies`
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
    el('p', { class: 'muted small' },
      'CSV, openable in Excel. Passwords are never included. A copy is also sent '
      + 'to the committee Drive folder every night.'),
    el('a', { class: 'btn', href: '/api/admin/export', download: '' }, 'Download everything'),
    el('p', { class: 'label', style: 'margin-top:var(--s-4)' }, 'Single table'),
    el('div', { class: 'row', style: 'flex-wrap:wrap' },
      ...tables.map((t) =>
        el('a', { class: 'btn btn--sm btn--quiet', href: `/api/admin/export?table=${t}`, download: '' }, t))),
    el('hr', { class: 'rule' }),
    el('p', { class: 'label' }, 'Nightly backup'),
    backupHealthLine());
}

function backupHealthLine() {
  const line = el('p', { class: 'small muted' }, 'Checking…');
  api.admin.backupHealth().then((h) => {
    line.replaceChildren(
      h.ok
        ? 'Google Drive is reachable and the token is valid.'
        : h.reason === 'not-configured'
          ? 'Not set up yet. Add the Google secrets to enable nightly off-site copies.'
          : `Backup is BROKEN (${h.reason}). A refresh token issued in OAuth "Testing" mode expires after 7 days. Publish the consent screen.`);
    if (!h.ok && h.reason !== 'not-configured') line.className = 'small';
  }).catch(() => line.replaceChildren('Could not check.'));
  return line;
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
  const { proofs, stored } = await api.admin.proofArchive();

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
