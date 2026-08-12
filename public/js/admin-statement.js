/**
 * Reconcile the bank statement against what residents claimed.
 *
 * The screen is built around one promise: the statement is here to answer a
 * question and then leave. Every state says where the file currently stands —
 * held, or gone — because "it gets deleted" is only trustworthy if the
 * treasurer can see it happen.
 *
 * The confirmations are not the interesting output. The four kinds of
 * disagreement are, and they are what the page leads with.
 */

import { api, ApiError } from './api.js';
import { renderNav } from './nav.js';
import { trackPage } from './track.js';
import { $, el, esc, renderViewBanner, showError, setChildren } from './ui.js';
import { money, periodLabel } from './i18n.js';

const main = $('#main');

/** The open review, if there is one. Never persisted client-side. */
let report = null;

trackPage('/admin/statement');
init();

async function init() {
  try {
    const me = await api.me();
    $('#who').innerHTML = `Admin <span>· ${esc(me.name)}</span>`;
    renderViewBanner(me, { onExit: async () => { await api.god.exit(); location.reload(); } });
    renderNav(me, '/admin/statement');
    renderUpload();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login'; return; }
    showError(main, err);
  }
}

/* ── upload ─────────────────────────────────────────────────────────────── */

function renderUpload(message = null) {
  const input = el('input', {
    type: 'file', accept: '.csv,.pdf,text/csv,application/pdf', hidden: true,
    onchange: (e) => e.target.files[0] && upload(e.target.files[0]),
  });

  const drop = el('div', { class: 'drop' },
    el('h2', {}, 'Reconcile the bank statement'),
    el('p', { class: 'small muted', style: 'margin:var(--s-2) 0 var(--s-4)' },
      'Upload the association statement as CSV or PDF. Credits are matched against the screenshots residents uploaded.'),
    el('button', { class: 'btn', type: 'button', onclick: () => input.click() }, 'Choose a statement'),
    input);

  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drop--over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drop--over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drop--over');
    const file = e.dataTransfer?.files?.[0];
    if (file) upload(file);
  });

  setChildren(main,
    message ? el('p', { class: 'note note--bad', style: 'margin:var(--s-4)' }, message) : null,
    drop,
    el('p', { class: 'privacy' },
      'The statement is read on arrival and never stored as a file. Its credit rows are held only ' +
      'until you finish this review, then deleted. Anything still open is deleted automatically at 3am. ' +
      'What survives is the verdict for each payment, with the reference and amount that justified it — never the narration.'));
}

async function upload(file) {
  setChildren(main, el('p', { class: 'muted', style: 'padding:var(--s-4)' }, `Reading ${esc(file.name)}…`));
  try {
    report = await api.admin.uploadStatement(file);
    render();
  } catch (err) {
    renderUpload(err instanceof ApiError ? err.message : 'That statement could not be read.');
  }
}

/* ── report ─────────────────────────────────────────────────────────────── */

const KINDS = [
  ['proof_no_credit',    'Claimed, but no money arrived',
                         'A resident uploaded a screenshot and no credit on the statement matches it.'],
  ['amount_mismatch',    'The bank disagrees with the screenshot',
                         'The payment arrived, but not for the amount the screenshot showed.'],
  ['duplicate_reference', 'One payment claimed twice',
                         'The same reference was uploaded against more than one bill.'],
  ['credit_no_proof',    'Money arrived with no screenshot',
                         'Almost always someone who paid by UPI and never opened the portal.'],
];

function render() {
  const t = report.totals;
  const groups = KINDS
    .map(([kind, title, blurb]) => [kind, title, blurb, report.discrepancies.filter((d) => d.kind === kind)])
    .filter(([, , , rows]) => rows.length);

  setChildren(main,
    el('div', { class: 'sect' },
      el('div', { class: 'stack', style: 'gap:var(--s-1)' },
        el('h2', {}, 'Reconciliation'),
        el('p', { class: 'small muted' },
          `${t.creditRows} credits read · ${t.discrepancyCount} need attention`)),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn btn--sm btn--quiet', type: 'button',
        onclick: async () => {
          if (!confirm('Discard this review? The statement is deleted and nothing is saved.')) return;
          await api.admin.discardStatement(report.sessionId).catch(() => {});
          report = null;
          renderUpload();
        },
      }, 'Discard'),
      el('button', {
        class: 'btn btn--sm', type: 'button',
        onclick: (e) => finish(e.target),
      }, 'Save verdicts and delete the statement')),

    ...(report.warnings ?? []).map((w) => el('p', { class: 'note', style: 'margin:var(--s-4)' }, w)),

    el('div', { class: 'tally' },
      tally(money(t.creditTotal), 'Credits on the statement'),
      tally(String(t.confirmedCount), 'Confirmed'),
      tally(money(t.confirmedTotal), 'Confirmed value'),
      tally(money(t.unmatchedCreditTotal), 'Unexplained money in')),

    ...(groups.length
      ? groups.flatMap(([kind, title, blurb, rows]) => [
          el('div', { class: 'sect' },
            el('div', { class: 'stack', style: 'gap:var(--s-1)' },
              el('h3', {}, `${title} · ${rows.length}`),
              el('p', { class: 'small muted' }, blurb))),
          ...rows.map((d) => discrepancyRow(kind, d)),
        ])
      : [el('p', { class: 'muted', style: 'padding:var(--s-4)' },
          'Everything on the statement matches what residents claimed.')]),

    report.confirmed.length
      ? el('details', { style: 'margin:var(--s-4)' },
          el('summary', { class: 'small muted' }, `${report.confirmed.length} confirmed`),
          ...report.confirmed.map(confirmedRow))
      : null);
}

function tally(value, label) {
  return el('div', {}, el('b', {}, value), el('span', {}, label));
}

function discrepancyRow(kind, d) {
  if (kind === 'credit_no_proof') {
    return el('div', { class: 'rrow' },
      el('div', { class: 'rmeta' },
        el('b', {}, `${money(d.amount)} on ${d.txnDate ?? 'an unknown date'}`),
        d.reference ? el('div', {}, `Reference ${d.reference}`) : null,
        el('div', {}, d.suggestions?.length
          ? `Unpaid bills matching this amount: ${d.suggestions.map((s) => `${s.flat} (${periodLabel(s.period)})`).join(', ')}`
          : 'No unpaid bill matches this amount.')),
      el('div', { class: 'qact' },
        ...(d.suggestions ?? []).map((s) => el('button', {
          class: 'btn btn--sm', type: 'button',
          onclick: async (e) => {
            e.target.disabled = true;
            await api.admin.markPaid(s.billId, `Reconciled against the bank statement${d.reference ? ` · ref ${d.reference}` : ''}`);
            await refresh();
          },
        }, `Mark ${s.flat} paid`))));
  }

  // Everything past the early return above disagrees with a resident's claim,
  // so it all carries the warning wash.
  return el('div', { class: 'rrow rrow--bad' },
    el('div', { class: 'rmeta' },
      el('b', {}, `Flat ${d.flat ?? '—'} · ${d.name ?? ''}`),
      el('div', { class: 'bad' }, d.detail),
      el('div', {},
        `${periodLabel(d.period)} · billed ${money(d.billed)}` +
        (d.claimed != null ? ` · claimed ${money(d.claimed)}` : '') +
        (d.bankAmount != null ? ` · bank ${money(d.bankAmount)}` : '')),
      d.reference ? el('div', {}, `Reference ${d.reference}`) : null),
    el('div', { class: 'qact' },
      d.proofId
        ? el('a', { class: 'btn btn--sm btn--quiet', href: `/api/proof/${d.proofId}/image`, target: '_blank' }, 'Screenshot')
        : null,
      d.proofId
        ? el('button', {
            class: 'btn btn--sm btn--quiet', type: 'button',
            onclick: async (e) => { e.target.disabled = true; await api.admin.rejectProof(d.proofId); await refresh(); },
          }, 'Reject')
        : null));
}

function confirmedRow(c) {
  return el('div', { class: 'rrow' },
    el('div', { class: 'rmeta' },
      el('b', {}, `Flat ${c.flat} · ${c.name ?? ''}`),
      el('div', {},
        `${money(c.amount)} on ${c.txnDate ?? '—'} · ${periodLabel(c.period)}` +
        (c.settles ? '' : ` · does not settle the ${money(c.billed)} bill`)),
      c.reference ? el('div', {}, `Reference ${c.reference}`) : null),
    el('span', { class: 'tag' }, c.how === 'reference' ? 'matched by reference' : 'matched by amount and date'));
}

async function refresh() {
  report = await api.admin.statementReport(report.sessionId);
  render();
}

async function finish(button) {
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const result = await api.admin.finishStatement(report.sessionId);
    const t = result.totals;
    report = null;
    setChildren(main,
      el('div', { class: 'sect' }, el('h2', {}, 'Done')),
      el('p', { class: 'privacy' },
        `${result.saved} verdicts saved. The statement has been deleted — ` +
        `${t.creditRows} credit rows removed. What remains is the verdict for each payment, ` +
        'with its reference and amount.'),
      el('div', { style: 'padding:0 var(--s-4) var(--s-4)' },
        el('button', { class: 'btn', type: 'button', onclick: () => renderUpload() },
          'Reconcile another statement')));
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Save verdicts and delete the statement';
    showError(main, err);
  }
}
