/**
 * Importing the building, and then chasing the people in it.
 *
 * Two jobs on one page, in the order they happen. The import is the quick
 * part — paste, read the preview, commit. The chasing is the long part, which
 * is why the status view is not an afterthought: 99 households will not all
 * log in because one message was sent, and the committee needs to see who has
 * not without keeping a separate list.
 *
 * The preview is the whole safety mechanism. Nothing is written until it has
 * been read, because a wrong mobile is a resident who cannot log in and will
 * not find out until they try.
 */

import { api, ApiError } from './api.js';
import { renderNav } from './nav.js';
import { $, el, esc, renderViewBanner, showError, setChildren } from './ui.js';
import { trackPage, trackAction } from './track.js';

const main = $('#main');
let view = 'import';
let preview = null;
let pasted = '';
let imported = null;
let status = null;

trackPage('/admin/roster');
init();

async function init() {
  try {
    const me = await api.me();
    if (me.role !== 'admin' && me.role !== 'superadmin') {
      main.replaceChildren(el('div', { class: 'note note--bad' }, 'Admins only.'));
      return;
    }
    $('#who').innerHTML = `Roster <span>· ${esc(me.name)}</span>`;
    renderViewBanner(me, { onExit: async () => { await api.god.exit(); location.reload(); } });
    // This page was the only one that never called it, so it had neither the
    // bottom bar nor a way back until it grew its own link in the header.
    renderNav(me, '/admin/roster');
    status = await api.admin.rosterStatus();
    render();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login'; return; }
    showError(main, err);
  }
}

function render() {
  setChildren(main,
    el('div', { class: 'tabs' },
      tab('import', 'Import'),
      tab('status', `Who has logged in (${status?.counts.loggedIn ?? 0}/${status?.counts.total ?? 0})`)),
    ...(view === 'import' ? importView() : statusView()));
}

function tab(id, label) {
  return el('button', {
    class: `tab ${view === id ? 'is-on' : ''}`, type: 'button',
    onclick: () => { view = id; render(); },
  }, label);
}

/* ── import ──────────────────────────────────────────────────────────────── */

function importView() {
  if (imported) return doneView();

  const box = el('textarea', {
    class: 'paste', id: 'paste', spellcheck: 'false',
    placeholder: '4A\tSabarish Nair\t9567791515\towner\n'
               + '4B\tRavi Nair\t9800000001\towner\n'
               + '4B\tPriya Menon\t9847011224\ttenant\n'
               + '5A',
  });
  box.value = pasted;

  const check = el('button', { class: 'btn', type: 'button' }, 'Check it');
  check.addEventListener('click', async () => {
    pasted = box.value;
    check.disabled = true; check.textContent = 'Checking…';
    try {
      preview = await api.admin.rosterPreview(pasted);
      render();
    } catch (err) { showError(main, err); }
    finally { check.disabled = false; check.textContent = 'Check it'; }
  });

  return [
    el('div', { class: 'panel stack' },
      el('h2', {}, 'Paste the roster'),
      el('p', { class: 'muted small' },
        'One line per person. Flat, name, mobile, then owner or tenant. '
        + 'Copy straight from a spreadsheet, or use commas. A line with only a '
        + 'flat number records it as vacant, which still gets a meter reading.'),
      el('p', { class: 'muted small' },
        'A let flat needs two lines: one for the owner, one for the tenant.'),
      box,
      el('div', { style: 'padding-top:var(--s-2)' }, check)),
    ...(preview ? previewPanels() : []),
  ];
}

function previewPanels() {
  const p = preview;
  const out = [];

  out.push(el('div', { class: 'panel' },
    el('div', { class: 'tally' },
      tally(p.counts.people, 'residents'),
      tally(p.counts.tenants, 'tenants'),
      tally(p.counts.vacant, 'vacant flats'),
      tally(p.blocked.length, 'blocked'),
      tally(p.counts.missing, 'flats not listed')),
    el('p', { class: 'small muted', style: 'padding:0 var(--s-4) var(--s-3)' },
      p.detectedHeader
        ? 'Read the column names from your first row.'
        : 'No header row, so columns were read as flat, name, mobile, owner/tenant. '
          + 'Check the first line below is right.')));

  if (p.blocked.length) {
    out.push(el('div', { class: 'panel' },
      el('h2', { style: 'padding:var(--s-3) var(--s-4) 0' },
        `${p.blocked.length} ${p.blocked.length === 1 ? 'line' : 'lines'} cannot be imported`),
      ...p.blocked.map((b) => el('div', { class: 'row row--bad' },
        el('span', { class: 'row__flat' }, b.flat),
        el('span', {}, b.name || '—'),
        el('span', { class: 'muted small' }, `line ${b.line}`),
        el('span', {}),
        el('span', { class: 'row__why' }, b.reason)))));
  }

  for (const w of p.warnings) {
    out.push(el('div', { class: 'note note--warn' }, w.message));
  }

  if (p.create.length) {
    out.push(el('div', { class: 'panel' },
      el('h2', { style: 'padding:var(--s-3) var(--s-4) 0' }, 'Would be created'),
      ...p.create.slice(0, 200).map((c) => el('div', { class: 'row' },
        el('span', { class: 'row__flat' }, c.flat),
        el('span', {}, c.vacant ? el('span', { class: 'muted' }, 'vacant') : c.name),
        el('span', { class: 'muted small' }, c.mobile ?? ''),
        el('span', { class: 'muted small' }, c.vacant ? '' : c.relationship)))));
  }

  if (p.missing.length) {
    out.push(el('details', { class: 'panel' },
      el('summary', { style: 'padding:var(--s-3) var(--s-4)' },
        `${p.missing.length} flats in the building are not on this list`),
      el('div', { class: 'grid' },
        ...p.missing.map((f) => el('span', { class: 'cell' }, f)))));
  }

  const go = el('button', {
    class: `btn btn--lg ${p.canImport ? '' : 'btn--ghost'}`, type: 'button',
    disabled: p.canImport ? null : true,
  }, p.canImport ? `Import ${p.counts.people} residents` : 'Fix the blocked lines first');

  go.addEventListener('click', async () => {
    go.disabled = true; go.textContent = 'Importing…';
    try {
      imported = await api.admin.rosterImport(pasted);
      trackAction('roster:import', { people: imported.created.length });
      status = await api.admin.rosterStatus();
      render();
    } catch (err) {
      showError(main, err);
      go.disabled = false;
    }
  });

  out.push(el('div', { class: 'panel', style: 'padding:var(--s-4)' }, go));
  return out;
}

function tally(n, label) {
  return el('div', {},
    el('div', { class: 'tally__n' }, String(n)),
    el('div', { class: 'tally__l' }, label));
}

function doneView() {
  return [
    el('div', { class: 'note note--good' },
      `${imported.created.length} residents created. Send each of them their login below. `
      + 'Nobody can log in until you do.'),
    ...sendList(imported.created),
  ];
}

/** One row per resident, with the message ready to go. */
function sendList(people) {
  return [el('div', { class: 'panel' },
    el('h2', { style: 'padding:var(--s-3) var(--s-4) 0' }, 'Send the logins'),
    el('p', { class: 'small muted', style: 'padding:0 var(--s-4)' },
      'Each opens WhatsApp with the message written. Tapping it marks them as sent, '
      + 'so you can tell who is still waiting from who is ignoring you.'),
    ...people.map((c) => {
      const send = el('a', {
        class: 'btn btn--ghost', href: c.whatsapp, target: '_blank', rel: 'noopener',
      }, 'Send');
      send.addEventListener('click', async () => {
        await api.admin.rosterMarkSent(c.id).catch(() => {});
        send.textContent = 'Sent';
        send.classList.add('is-done');
      });
      return el('div', { class: 'row' },
        el('span', { class: 'row__flat' }, c.flat),
        el('span', {}, c.name),
        el('span', { class: 'muted small' }, c.mobile),
        send);
    }))];
}

/* ── who has actually logged in ──────────────────────────────────────────── */

function statusView() {
  if (!status) return [el('p', { class: 'muted' }, 'Loading…')];
  const c = status.counts;

  const label = { 'logged-in': 'logged in', sent: 'sent', 'not-sent': 'not sent' };

  return [
    el('div', { class: 'panel' },
      el('div', { class: 'tally' },
        tally(c.loggedIn, 'logged in'),
        tally(c.sent, 'sent, not yet in'),
        tally(c.notSent, 'not contacted'),
        tally(c.total, 'residents')),
      el('p', { class: 'small muted', style: 'padding:0 var(--s-4) var(--s-3)' },
        c.notSent
          ? `${c.notSent} people have never been sent their login. Start there.`
          : c.sent
            ? `Everyone has been contacted. ${c.sent} have not logged in yet — worth a nudge.`
            : 'Everyone is in.')),
    el('div', { class: 'panel' },
      ...status.people.map((p) => el('div', { class: 'row' },
        el('span', { class: 'row__flat' }, p.flat),
        el('span', {}, p.name),
        el('span', { class: 'muted small' }, p.relationship),
        el('span', { class: `state state--${p.state}` }, label[p.state])))),
  ];
}
