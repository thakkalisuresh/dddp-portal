/**
 * Who owes what — two accounts, two blocks, never one total.
 *
 * THE SHAPE IS THE RULE. Gas is monthly and maintenance is quarterly; they
 * settle into two different bank accounts, and a figure spanning both
 * reconciles against nothing. The user rejected a combined per-flat table with
 * a total column for exactly this reason, and the same reasoning keeps a single
 * "you owe" figure off the resident's home page.
 *
 * STACKED, NOT SIDE BY SIDE, and that is the layout doing the work: two columns
 * invite the eye to add across them. Stacking also means the screen works on a
 * phone, which side-by-side tables never do.
 *
 * TWO EXPORTS, NEVER A THIRD. If you are here to add a combined download, that
 * is the decision you are reversing — and test/maint-admin.test.js and
 * test/public-js.test.js will both stop you.
 */

import { api, ApiError } from './api.js';
import { renderNav } from './nav.js';
import { trackPage } from './track.js';
import { $, el, esc, statusChip, showError } from './ui.js';
import { money, periodLabel, dayLabel } from './i18n.js';

const main = $('#main');

trackPage('/admin/dues');
init();

async function init() {
  try {
    const [me, dues] = await Promise.all([api.me(), api.admin.dues()]);
    $('#who').innerHTML = `Admin <span>· ${esc(me.name)}</span>`;
    renderNav(me, '/admin/dues.html');
    render(dues);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login'; return; }
    showError(main, err);
  }
}

function render(dues) {
  main.replaceChildren(
    el('h1', { class: 'h2' }, 'Who owes what'),
    // Said out loud at the top, because the first thing anyone wants from a
    // dues screen is one number, and this screen will not give them one.
    el('p', { class: 'small muted' },
      'Gas and maintenance are kept apart because they are paid into different '
      + 'accounts on different cycles. There is no combined figure on purpose — '
      + 'a total across the two would not reconcile against either statement.'),

    block('Gas', dues.gas, 'gas'),
    el('hr', { class: 'rule' }),
    block('Maintenance', dues.maintenance, 'maintenance'),
  );
}

/**
 * One account's block: its own figures, its own table, its own export.
 *
 * `kind` names the export file so a treasurer who downloads both does not end
 * up with two files called dues.csv, one of which silently replaces the other.
 */
function block(title, data, kind) {
  return el('section', { class: 'stack', 'data-account': kind },
    el('div', { class: 'row row--between' },
      el('h2', {}, title),
      el('span', { class: 'small muted' },
        data.cadence === 'month' ? 'Monthly' : 'Quarterly')),

    el('div', { class: 'tiles' },
      tile('Bills outstanding', String(data.count)),
      tile('Overdue', String(data.overdueCount)),
      // The block's OWN total — correct within one account, and meaningless
      // across two, which is why it lives in here beside its own rows.
      tile(`Outstanding (${title.toLowerCase()})`, money(data.outstanding), true)),

    data.rows.length
      ? el('div', { class: 'scroll-x' },
          el('table', { class: 'table' },
            el('thead', {}, el('tr', {},
              el('th', {}, 'Flat'),
              el('th', {}, 'Period'),
              el('th', {}, 'Billed to'),
              el('th', { class: 'r' }, 'Amount'),
              el('th', {}, 'Due'),
              el('th', {}, 'Status'))),
            el('tbody', {}, ...data.rows.map((r) => el('tr', {
              class: r.overdue ? 'is-overdue' : '',
            },
              el('td', {}, r.flat),
              el('td', {}, r.period?.includes('Q') ? r.periodLabel : periodLabel(r.period)),
              el('td', {}, r.billedTo ?? '—'),
              el('td', { class: 'r' },
                money(r.total),
                r.lateFee
                  ? el('div', { class: 'small', style: 'color:var(--overdue)' },
                      `incl. ${money(r.lateFee)} late fee`)
                  : null),
              el('td', { class: 'small muted' }, r.dueDate ? dayLabel(r.dueDate) : '—'),
              el('td', {}, statusChip(r.status)))))))
      : el('p', { class: 'note note--good' }, `Nothing outstanding on ${title.toLowerCase()}.`),

    el('button', {
      class: 'btn btn--ghost btn--sm', type: 'button',
      'data-export': kind,
      onclick: () => downloadCsv(title, data, kind),
    }, `Download ${title.toLowerCase()} dues`));
}

/**
 * One account's rows as CSV, built in the browser.
 *
 * No endpoint, because there is nothing here the page does not already have,
 * and a second route returning the same numbers is a second place for them to
 * drift.
 */
function downloadCsv(title, data, kind) {
  const head = ['Flat', 'Period', 'Billed to', 'Amount', 'Late fee', 'Due', 'Status'];
  const rows = data.rows.map((r) => [
    r.flat, r.period, r.billedTo ?? '', r.total, r.lateFee ?? 0, r.dueDate ?? '', r.status,
  ]);
  const csv = [head, ...rows]
    .map((row) => row.map(cell).join(','))
    .join('\n');

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = el('a', { href: url, download: `dues-${kind}-${data.cadence}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Quote anything that could break a row, and double the quotes inside it. */
function cell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function tile(label, value, big = false) {
  return el('div', { class: 'tile' },
    el('span', { class: 'label' }, label),
    el('strong', { class: big ? 'tile__big' : '' }, value));
}
