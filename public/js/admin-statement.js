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
import { $, el, esc, renderViewBanner, showError, setChildren, askFirst } from './ui.js';
import { money, periodLabel } from './i18n.js';

const main = $('#main');

/** The open review, if there is one. Never persisted client-side. */
let report = null;

/** The two accounts and whichever review is already open, from the server. */
let landing = { accounts: [], open: null };

/**
 * Which account this screen is showing.
 *
 * IN THE URL, not in a variable and not in storage. An admin working through a
 * list of credits reloads, shares a link and presses Back; all three have to
 * land on the account they were looking at, and only the URL can do that.
 */
function currentAccount() {
  const asked = new URLSearchParams(location.search).get('account');
  if (asked === 'gas' || asked === 'maintenance') return asked;
  // Gas is the monthly visit and therefore the common one — unless a review is
  // already open on the other account, in which case that is plainly what the
  // person came back for.
  return landing.open?.account ?? 'gas';
}

function accountMeta(id = currentAccount()) {
  return landing.accounts.find((a) => a.id === id) ?? { id, label: id, hint: null, ready: true };
}

/** A gas period is a month that needs writing out; a quarter is already in its final form. */
function windowLabel(period) {
  return currentAccount() === 'maintenance' ? String(period ?? '—') : periodLabel(period);
}

trackPage('/admin/statement');
init();

async function init() {
  try {
    const [me, accounts] = await Promise.all([api.me(), api.admin.statementAccounts()]);
    $('#who').innerHTML = `Admin <span>· ${esc(me.name)}</span>`;
    renderViewBanner(me, { onExit: async () => { await api.god.exit(); location.reload(); } });
    renderNav(me, '/admin/statement');
    landing = accounts;
    addEventListener('popstate', () => { report = null; show(); });
    await show();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login'; return; }
    showError(main, err);
  }
}

/** Whatever the current account should be showing: its open review, or the upload box. */
async function show() {
  const account = currentAccount();
  if (landing.open?.account === account) {
    try {
      report = await api.admin.statementReport(landing.open.sessionId);
      render();
      return;
    } catch {
      // Swept at 3am, or finished in another tab. The upload box is the truth.
      landing = { ...landing, open: null };
    }
  }
  renderUpload();
}

function switchTo(account) {
  if (account === currentAccount()) return;
  const url = new URL(location.href);
  url.searchParams.set('account', account);
  history.pushState({}, '', url);
  report = null;
  show();
}

/**
 * The account picker.
 *
 * TWO GENUINELY SEPARATE RECONCILIATIONS, not one list with a filter. Gas and
 * maintenance are different bank accounts, so a combined list would invite an
 * admin to settle a gas claim with maintenance money — a false match with real
 * money behind it and, an hour later, no statement left to disprove it.
 *
 * The second line is the payee, built at runtime and never the whole of it: the
 * account number is a Pages secret because this repository is public, and four
 * digits are all a treasurer needs to tell which statement they are holding.
 */
function accountPicker(aside = null) {
  const current = currentAccount();
  return el('div', { class: 'sect' },
    el('div', { class: 'seg', role: 'tablist' },
      ...landing.accounts.map((a) => el('button', {
        class: `seg__btn${a.id === current ? ' seg__btn--on' : ''}`,
        type: 'button', role: 'tab', 'aria-selected': a.id === current ? 'true' : 'false',
        onclick: () => switchTo(a.id),
      },
      el('b', {}, a.label),
      a.hint ? el('span', { class: 'small muted' }, a.hint) : null))),
    aside ? el('span', { class: 'spacer' }) : null,
    aside);
}

/* ── upload ─────────────────────────────────────────────────────────────── */

function renderUpload(message = null) {
  const account = accountMeta();

  // The maintenance side EXISTS BEFORE IT IS USEFUL, on purpose. A control that
  // is simply absent until the first quarter issues reads as broken; one that is
  // present and says why it is empty reads as early.
  if (!account.ready) {
    setChildren(main,
      accountPicker(),
      el('p', { class: 'muted', style: 'padding:var(--s-4)' },
        'No maintenance quarter has been issued yet, so there is nothing on this account to reconcile. '
        + 'Come back once the first quarter’s bills have gone out.'));
    return;
  }

  const input = el('input', {
    type: 'file', accept: '.csv,.pdf,text/csv,application/pdf', hidden: true,
    onchange: (e) => e.target.files[0] && upload(e.target.files[0]),
  });

  const drop = el('div', { class: 'drop' },
    el('h2', {}, `Reconcile the ${account.label.toLowerCase()} statement`),
    el('p', { class: 'small muted', style: 'margin:var(--s-2) 0 var(--s-4)' },
      currentAccount() === 'maintenance'
        ? 'Upload the maintenance account statement as CSV or PDF. Every flat of the same kind owes the '
          + 'same amount, so a credit is matched on its reference and its narration — never on the amount alone.'
        : 'Upload the association statement as CSV or PDF. Credits are matched against the screenshots residents uploaded.'),
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
    accountPicker(),
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
    report = await api.admin.uploadStatement(file, currentAccount());
    landing = { ...landing, open: { sessionId: report.sessionId, account: currentAccount(), filename: file.name } };
    render();
  } catch (err) {
    renderUpload(err instanceof ApiError ? err.message : 'That statement could not be read.');
  }
}

/* ── report ─────────────────────────────────────────────────────────────── */

/**
 * B25. "Money arrived with no screenshot" used to be one heap, and in this
 * building it is the biggest one — the bank pays interest into the account,
 * refunds and reversals land in it, and no resident will ever upload a
 * screenshot for any of that. Seventeen residents paying perfectly still
 * produced a page headed "need attention", so the page stopped being read.
 *
 * It is now split by whether an unpaid bill matches the amount exactly, which
 * `reconcile` already worked out. The server does the splitting so this file
 * does not carry a second, weaker copy of the rule.
 *
 * `unmatched` is still SHOWN, and that is the whole point. It is where bank
 * interest lands, and it is also where a flat billed ₹310 that paid ₹300 lands
 * — the case the feature exists for. Filtering it away is the simplification
 * B25 rejected.
 */
const KINDS = [
  ['proof_no_credit',    'Claimed, but no money arrived',
                         'A resident uploaded a screenshot and no credit on the statement matches it.'],
  ['amount_mismatch',    'The bank disagrees with the screenshot',
                         'The payment arrived, but not for the amount the screenshot showed.'],
  ['duplicate_reference', 'One payment claimed twice',
                         'The same reference was uploaded against more than one bill.'],
];

const CREDIT_GROUPS = [
  ['likelyResident', 'Probably a resident who did not upload',
                     'An unpaid bill matches this amount exactly. Most of these settle with one tap.'],
  ['unmatched',      'Nothing matches this',
                     'Bank interest, a refund, a transfer between the association’s own accounts — '
                     + 'or a resident who paid the wrong amount. Worth a look, rarely an error.'],
];

/**
 * The same three-part shape, with the one change the missing fingerprint forces.
 *
 * There is no "probably a resident" bucket here and there cannot be one: every
 * flat of the same kind owes the same rupee, so "an unpaid bill matches this
 * amount" is true of forty of them and means nothing. What replaces it is a
 * shortlist and a person — the amount narrows, the reference and the narration
 * argue, and an admin says which flat it is.
 */
const MAINT_CREDIT_GROUPS = [
  ['assignable', 'Money in, waiting to be assigned',
                 'The amount alone cannot say whose this is. Pick the flat the evidence points at — '
                 + 'the reference and the narration are what argue, the amount only narrows the list.'],
  ['assigned',   'Assigned in this review',
                 'Already settled against a flat. Shown so you can see what you have done before the '
                 + 'statement is deleted.'],
  ['unmatched',  'Nothing matches this',
                 'Bank interest, a refund, a transfer between the association’s own accounts — '
                 + 'or a flat that paid an amount no open bill is for. Worth a look, rarely an error.'],
];

/** What justified a match, in the words an admin reads. Narration is maintenance-only. */
const MATCH_LABEL = {
  reference: 'matched by reference',
  narration: 'matched by the note in the narration',
  'amount-and-date': 'matched by amount and date',
};

/** How a candidate earned its place on the shortlist, in the words an admin reads. */
const CANDIDATE_REASON = {
  note:   'the narration carries this flat’s payment note',
  flat:   'the narration mentions this flat',
  name:   'the narration mentions this name',
  amount: 'only the amount agrees',
};

function render() {
  const t = report.totals;
  const buckets = report.buckets ?? {};
  const creditGroups = currentAccount() === 'maintenance' ? MAINT_CREDIT_GROUPS : CREDIT_GROUPS;
  const groups = [
    ...KINDS.map(([kind, title, blurb]) =>
      [kind, title, blurb, report.discrepancies.filter((d) => d.kind === kind)]),
    // All credit_no_proof rows; only the heading and the ordering differ, so
    // discrepancyRow still gets the kind it knows how to draw.
    ...creditGroups.map(([bucket, title, blurb]) =>
      ['credit_no_proof', title, blurb, buckets[bucket] ?? []]),
  ].filter(([, , , rows]) => rows.length);

  // Below the header row rather than inside it: that row is a flex line with a
  // spacer holding two buttons apart, and an ask dropped into it would be
  // squeezed between them.
  const ask = el('div', { style: 'margin:0 var(--s-4)' });

  setChildren(main,
    // The picker stays at the top of the review, with what is being reviewed
    // beside it: an admin deep in a list of credits should never have to guess
    // which account's money they are looking at.
    accountPicker(el('div', { class: 'stack', style: 'gap:var(--s-1);text-align:right' },
      el('b', {}, report.filename ? esc(report.filename) : 'Statement'),
      el('span', { class: 'small muted' },
        `${t.creditRows} credits read · ${t.discrepancyCount} need attention`))),

    el('div', { class: 'sect' },
      // The counts live beside the picker now and are not repeated here: one
      // number stated twice on one screen is one number to keep in agreement.
      el('h2', {}, 'Reconciliation'),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn btn--sm btn--quiet', type: 'button',
        onclick: async () => {
          if (!await askFirst(ask,
            'Discard this review? The statement is deleted and nothing is saved.',
            'Yes, discard')) return;
          await api.admin.discardStatement(report.sessionId).catch(() => {});
          report = null;
          landing = { ...landing, open: null };
          renderUpload();
        },
      }, 'Discard'),
      el('button', {
        class: 'btn btn--sm', type: 'button',
        onclick: (e) => finish(e.target),
      }, 'Save verdicts and delete the statement')),

    ask,

    ...(report.warnings ?? []).map((w) => el('p', { class: 'note', style: 'margin:var(--s-4)' }, w)),

    el('div', { class: 'tally' },
      tally(money(t.creditTotal), 'Credits on the statement'),
      tally(String(t.confirmedCount), 'Confirmed'),
      tally(money(t.confirmedTotal), 'Confirmed value'),
      // Only on the maintenance side, and only once something has been
      // assigned: a column reading "0 assigned" on every gas statement forever
      // is a column people learn to stop seeing.
      t.assignedCount ? tally(String(t.assignedCount), 'Assigned by hand') : null,
      t.assignedCount ? tally(money(t.assignedTotal), 'Assigned value') : null,
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
  if (kind === 'credit_no_proof' && currentAccount() === 'maintenance') return maintCreditRow(d);
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
        `${windowLabel(d.period)} · billed ${money(d.billed)}` +
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

/**
 * A maintenance credit, and the flats it could belong to.
 *
 * THE ROW ARGUES ITS CASE. Each candidate says why it is on the list, because
 * the reason is what the admin is agreeing with when they tap — a shortlist
 * that ranked silently would be a guess wearing an ordering. The one that ends
 * "only the amount agrees" is the weakest statement this screen can make and it
 * says so out loud, which is the whole difference from the gas side, where the
 * amount is enough on its own.
 *
 * Past the ranked five there is a picker over every open bill. Forty flats owe
 * the same rupee; five buttons cannot be the only way to reach the right one.
 */
function maintCreditRow(d) {
  const when = d.txnDate ?? 'an unknown date';

  if (d.assignedTo) {
    const a = d.assignedTo;
    return el('div', { class: 'rrow' },
      el('div', { class: 'rmeta' },
        el('b', {}, `${money(d.amount)} on ${when}`),
        el('div', {}, `Assigned to ${a.flat}${a.name ? ` · ${a.name}` : ''} · ${a.period}`),
        a.by ? el('div', { class: 'small muted' }, `Assigned by ${a.by}`) : null),
      el('span', { class: 'tag' }, 'assigned'));
  }

  const ask = el('div', {});
  const assign = async (billId, label, button) => {
    if (button) button.disabled = true;
    try {
      report = await api.admin.assignCredit(report.sessionId, {
        billId, amount: d.amount, txnDate: d.txnDate ?? null, reference: d.reference ?? null,
      });
      render();
    } catch (err) {
      if (button) button.disabled = false;
      setChildren(ask, el('p', { class: 'note note--bad' },
        err instanceof ApiError ? err.message : `${label} could not be assigned.`));
    }
  };

  // THE PICKER OFFERS ONLY THE FLATS OWING THIS AMOUNT. Assigning settles the
  // bill, so a list that also offered the ₹7,750 bills would be a way to clear
  // ₹750 of somebody's debt with a mis-tap. A part payment is assigned from the
  // ranked list above, where the row says how short it is — and the server
  // refuses it there too.
  const others = (report.assignableBills ?? [])
    .filter((b) => !(d.candidates ?? []).some((c) => c.billId === b.id))
    .filter((b) => Math.round((b.total ?? 0) * 100) === Math.round((d.amount ?? 0) * 100));

  // NO PICKER WHERE THERE IS NO CANDIDATE. A credit with an empty shortlist is
  // bank interest, a refund, or a transfer between the association's own
  // accounts — and offering to assign the interest to whichever flat an admin
  // happens to pick is not a shortcut, it is a way to post money to somebody
  // who never sent it. Money with no evidence tying it to a flat goes through
  // the offline-payment door instead, which 0042 gave two signatures.
  const picker = (d.candidates?.length ?? 0) && others.length
    ? el('select', {
        class: 'input', 'aria-label': 'Assign this credit to another flat',
        onchange: (e) => {
          const billId = Number(e.target.value);
          if (!billId) return;
          const bill = others.find((b) => b.id === billId);
          e.target.value = '';
          assign(billId, `Flat ${bill?.flat ?? billId}`, null);
        },
      },
      el('option', { value: '' }, 'Assign to another flat…'),
      ...others.map((b) => el('option', { value: String(b.id) },
        `${b.flat} · ${b.period} · ${money(b.total)}${b.name ? ` · ${b.name}` : ''}`)))
    : null;

  return el('div', { class: 'rrow' },
    el('div', { class: 'rmeta' },
      el('b', {}, `${money(d.amount)} on ${when}`),
      d.reference ? el('div', {}, `Reference ${d.reference}`) : null,
      // The group heading already says what a row with candidates is. Repeating
      // it on every row is the sentence a treasurer stops reading by the third
      // credit — so it is kept only where it says something the heading does
      // not: that this one has nothing to go on.
      d.candidates?.length ? null : el('div', { class: 'small muted' }, d.detail),
      ...(d.candidates ?? []).map((c) => el('div', { class: 'small muted' },
        `${c.flat} · ${c.period} · ${money(c.total)}${c.name ? ` · ${c.name}` : ''} — ${CANDIDATE_REASON[c.reason] ?? c.reason}`
        + (c.short ? ` · ${money(Math.abs(c.short))} ${c.short > 0 ? 'short of' : 'over'} the bill` : ''))),
      ask),
    el('div', { class: 'qact' },
      // No button for a candidate the credit cannot settle. It stays on the
      // list because knowing whose ₹6,500 this probably is has value; what has
      // none is a button that looks like it closes the debt and, if it worked,
      // would quietly forgive the difference.
      ...(d.candidates ?? []).filter((c) => c.short <= 0).map((c) => el('button', {
        class: 'btn btn--sm', type: 'button',
        onclick: (e) => assign(c.billId, `Flat ${c.flat}`, e.target),
      }, `Assign to ${c.flat}`)),
      picker));
}

function confirmedRow(c) {
  return el('div', { class: 'rrow' },
    el('div', { class: 'rmeta' },
      el('b', {}, `Flat ${c.flat} · ${c.name ?? ''}`),
      el('div', {},
        `${money(c.amount)} on ${c.txnDate ?? '—'} · ${windowLabel(c.period)}` +
        (c.settles ? '' : ` · does not settle the ${money(c.billed)} bill`)),
      c.reference ? el('div', {}, `Reference ${c.reference}`) : null),
    el('span', { class: 'tag' }, MATCH_LABEL[c.how] ?? 'matched'));
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
    landing = { ...landing, open: null };
    setChildren(main,
      el('div', { class: 'sect' }, el('h2', {}, 'Done')),
      el('p', { class: 'privacy' },
        `${result.saved} verdicts saved. The statement has been deleted — ` +
        `${t.creditRows} credit rows removed. What remains is the verdict for each payment, ` +
        'with its reference and amount.'),
      el('div', { style: 'padding:0 var(--s-4) var(--s-4)' },
        el('button', { class: 'btn', type: 'button', onclick: () => renderUpload() },
          'Reconcile another statement')));
    // The finished screen keeps the picker so the other account is one tap
    // away — in practice the treasurer does both in one sitting.
    main.prepend(accountPicker());
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Save verdicts and delete the statement';
    showError(main, err);
  }
}
