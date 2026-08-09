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

const TABS = [
  { id: 'roster',    label: 'Roster',    href: '/admin/roster.html' },
  { id: 'readings',  label: 'Readings',  href: '/admin/readings.html' },
  { id: 'proofs',    label: 'Proofs',    href: '/admin/proofs.html' },
  { id: 'periods',   label: 'Rates',     render: periodsPanel },
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
  const tab = TABS.find((t) => t.id === id && t.render) ?? TABS.find((t) => t.render);
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

async function periodsPanel() {
  const { periods } = await api.admin.periods();
  const status = el('div');

  const period = el('input', { class: 'input num', placeholder: '2026-08', id: 'p-period' });
  const rate = el('input', { class: 'input num', placeholder: '78.00', id: 'p-rate', inputmode: 'decimal' });
  const due = el('input', { class: 'input num', placeholder: '2026-09-10', id: 'p-due' });
  const fee = el('input', { class: 'input num', value: '50', id: 'p-fee', inputmode: 'numeric' });

  return el('div', { class: 'panel stack' },
    el('h2', {}, 'Rate per kg'),
    el('p', { class: 'muted small' },
      'Set the rate for every month, even when it has not changed. Nothing is '
      + 'carried forward: an inherited rate would produce 52 bills that look '
      + 'normal and are all wrong.'),

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
            period: period.value.trim(), ratePerKg: Number(rate.value),
            dueDate: due.value.trim(), lateFee: Number(fee.value),
          });
          status.replaceChildren(
            el('div', { class: r.sanity.level === 'warn' ? 'note note--warn' : 'note note--good' },
              r.sanity.level === 'warn' ? r.sanity.message : `Opened ${periodLabel(r.period)}.`));
          await show('periods');
        } catch (err) { showError(status, err); }
      },
    }, 'Open month'),

    el('hr', { class: 'rule' }),
    el('p', { class: 'label' }, 'Months'),
    ...periods.map((p) =>
      el('div', { class: 'rowitem' },
        el('div', { class: 'rowitem__main' },
          el('b', {}, periodLabel(p.period)),
          el('div', {}, `₹${p.rate_per_kg}/kg · ${p.conversion_factor} kg per unit · due ${p.due_date}`)),
        el('span', { class: `chip ${p.status === 'locked' ? 'chip--paid' : 'chip--awaiting'}` },
          p.status === 'locked' ? 'Locked' : 'Open')))
  );
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

  return el('div', { class: 'panel stack' },
    el('h2', {}, 'Notices'),
    status,
    el('div', { class: 'field' }, el('label', { for: 'n-title' }, 'Title'), title),
    el('div', { class: 'field' }, el('label', { for: 'n-body' }, 'Body'), body),
    el('label', { class: 'row', style: 'gap:var(--s-2)' }, isEvent, 'This is an event'),
    el('label', { class: 'row', style: 'gap:var(--s-2)' }, allowComments, 'Allow replies'),
    el('p', { class: 'small muted' },
      'Replies carry each resident’s name and flat. Leave them off for announcements.'),
    el('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        try {
          await api.admin.addNotice({
            title: title.value, body: body.value,
            kind: isEvent.checked ? 'event' : 'notice',
            allowComments: allowComments.checked,
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
          el('div', {}, `${dayLabel(n.postedAt)} · ${n.commentCount} replies`)),
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
              el('b', {}, m.name),
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
