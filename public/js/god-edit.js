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
import { $, el, esc, renderGodBanner, showError, setChildren } from './ui.js';
import { money, periodLabel } from './i18n.js';

const main = $('#main');
let tab = 'people';
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
    renderGodBanner(me, { onExit: async () => { await api.god.exit(); location.reload(); } });
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
      tabButton('health', healthLabel())),
    el('div', { class: 'panel', style: 'padding:var(--s-3) var(--s-4)' },
      el('p', { class: 'small muted' }, blurb())),
    ...body()
  );
}

function blurb() {
  if (tab === 'people') {
    return 'Change any detail. Mobile is the login number and accepts a country code '
         + 'for owners abroad. Every change is recorded with what it was before.';
  }
  if (tab === 'bills') {
    return 'Editing a component recalculates the total. Editing the total directly '
         + 'overrides it and the bill is marked so — the components are left as metered. '
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
  if (tab === 'health') return healthBody();
  return data.edits.length
    ? data.edits.map(editRow)
    : [el('p', { class: 'muted', style: 'padding:var(--s-4)' }, 'Nothing has been edited yet.')];
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
      select(p, 'owner', 'role', 'Role', ['owner', 'admin', 'superadmin']),
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
      field(b, 'bill', 'total', 'Total', { num: true }),
      select(b, 'bill', 'status', 'Status',
             ['unpaid', 'initiated', 'awaiting', 'paid', 'waived'])),
    b.adjust_reason
      ? el('p', { class: 'rec__meta', style: 'margin-top:var(--s-2)' }, `Reason: ${b.adjust_reason}`)
      : null);
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
    reason = prompt(`Reason for changing ${name} (${original} → ${input.value}):`);
    if (reason == null || !reason.trim()) { input.value = original; wrap.classList.remove('cell--dirty'); return; }
  }

  try {
    const fn = entity === 'bill' ? api.god.editBill : api.god.editOwner;
    const res = await fn(row.id, name, input.value, reason);
    trackAction(`god:edit:${entity}.${name}`, { id: row.id });

    wrap.classList.remove('cell--dirty');
    if (res.confirm) alert(res.confirm);
    if (res.note) alert(res.note);
    // Reload rather than patch in place: a component edit changes the total
    // and the flags, and a half-updated row is how someone reads a stale
    // number and acts on it.
    await load();
  } catch (err) {
    input.value = original;
    wrap.classList.remove('cell--dirty');
    alert(err instanceof ApiError ? err.message : 'Could not save that.');
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
