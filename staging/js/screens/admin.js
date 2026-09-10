/**
 * The committee's side.
 *
 * One person — the treasurer — does one job once a month, standing in a
 * corridor with a phone in one hand. The old console answered that with
 * fourteen tabs. This answers it with a board that says what is waiting, and
 * one screen per errand.
 *
 * The rule throughout: never make the treasurer hold state in their head. The
 * screen says where the month is, what is left, and what happens next.
 */

import {
  el, icon, svg, I, money, kg, periodLabel, dayLabel, dayFull, ago,
  row, list, group, statusChip, banner, empty, field, kv, sheet, toast, segmented, skeleton,
} from '../ui.js';
import { BOARD, MONTH, RATE, readingGrid, PROOFS, CLAIMED_NO_PROOF, STATEMENT, RESIDENTS, ALL_FLATS, NOTICES } from '../data.js';

/* ═══ the board ══════════════════════════════════════════════════════════
   What is waiting on you, then where the month stands, then everything else.
   Ordered by whether it needs a decision, not by topic.                      */

export function adminHome(ctx) {
  const b = BOARD;
  const pct = Math.round((b.paid / b.billed) * 100);

  return [
    el('div', { class: 'stack stack--xs' },
      el('h1', { class: 'largetitle' }, periodLabel(b.period)),
      el('p', { class: 'largetitle__sub' }, 'The month is open. Bills are not published yet.')),

    // The one number a treasurer is actually asked for at a committee meeting.
    el('section', { class: 'card' },
      el('div', { class: 'row row--between' },
        el('span', { class: 'hero__label' }, 'Collected for August'),
        el('span', { class: 'chip chip--good' }, icon('checkCircle', { size: 15 }), `${pct}% paid`)),
      el('p', { class: 'hero__amount', style: 'font-size:var(--t-title1)' }, money(b.collected)),
      el('div', { class: 'progress' },
        el('div', { class: 'progress__track' },
          el('div', { class: 'progress__fill', style: `width:${pct}%` })),
        el('span', {}, `${b.paid} of ${b.billed}`)),
      el('p', { class: 'small muted' },
        `${b.overdue} flats are overdue, ${money(b.overdueValue)} between them.`)),

    group('Waiting on you', list(
      row({ title: 'Payment screenshots', sub: `${PROOFS.filter((p) => p.match === 'exact').length} match the bill exactly`,
            value: String(b.proofs), icon: 'camera', tint: 'var(--warn)', onClick: () => ctx.go('#/admin/proofs') }),
      row({ title: 'Tapped Pay, sent nothing', sub: 'Check these against the bank statement',
            value: String(b.claimed), icon: 'clock', tint: 'var(--info)', onClick: () => ctx.go('#/admin/reconcile') }),
      row({ title: 'Meter readings still to enter', sub: `${MONTH.entered} of ${MONTH.total} done`,
            value: String(b.readingsLeft), icon: 'meter', tint: 'var(--accent)', onClick: () => ctx.go('#/admin/month') }),
      row({ title: 'Bill corrections asked for', sub: 'Another admin has to agree',
            value: String(b.corrections), icon: 'alert', tint: 'var(--bad)', onClick: () => toast('Correction queue') }),
      row({ title: 'Unanswered messages', value: String(b.messages), icon: 'mail', tint: 'var(--label-2)', onClick: () => toast('Messages') }),
    )),

    group('This month’s job', list(
      row({ title: 'Rate, readings and publishing', sub: 'Step 2 of 4 — the meter walk',
            icon: 'flame', tint: 'var(--warn)', onClick: () => ctx.go('#/admin/month') }),
      row({ title: 'Bills', sub: '94 issued for August', icon: 'bill', tint: 'var(--accent)', onClick: () => ctx.go('#/admin/bills') }),
      row({ title: 'Reconcile the bank statement', sub: 'Last matched 6 September',
            icon: 'bank', tint: 'var(--info)', onClick: () => ctx.go('#/admin/reconcile') }),
    )),

    group('The building', list(
      row({ title: 'Residents', sub: '99 flats · 105 people', icon: 'users', tint: 'var(--accent)', onClick: () => ctx.go('#/admin/residents') }),
      row({ title: 'Never logged in', sub: 'Chase these before the next bill',
            value: String(b.neverLoggedIn), icon: 'person', tint: 'var(--warn)', onClick: () => ctx.go('#/admin/residents') }),
      row({ title: 'Notices', sub: `${NOTICES.length} posted`, icon: 'bell', tint: 'var(--info)', onClick: () => ctx.go('#/admin/notices') }),
      row({ title: 'Import the roster', sub: 'Superadmin only — rewrites the directory',
            icon: 'upload', tint: 'var(--bad)', onClick: () => ctx.go('#/admin/roster') }),
    )),

    group('Records', list(
      row({ title: 'Download everything as CSV', icon: 'download', tint: 'var(--label-2)', onClick: () => toast('CSV would download') }),
      row({ title: 'Errors, last 7 days', value: '3', icon: 'alert', tint: 'var(--label-3)', onClick: () => toast('Error log') }),
    )),
  ];
}

/* ═══ the month ══════════════════════════════════════════════════════════
   Rate, then the meter walk, then review, then publish — the order it
   actually happens in, with each step closed until the one before it is done.
   Two months were opened and abandoned on the old portal because nothing on
   the rate screen said a reading could not be entered until it existed.      */

export function adminMonth(ctx) {
  const open = ctx.state.step ?? 2;
  const setStep = (n) => { ctx.state.step = n; ctx.render(); };
  const entered = ctx.state.entered ?? MONTH.entered;

  const steps = [
    {
      n: 1, title: 'The price of gas', sub: `${money(RATE)} per kg · common charges ${money(MONTH.otherCharges)}`,
      state: 'done',
      body: () => el('div', { class: 'stack' },
        el('div', { class: 'row row--wrap', style: 'gap:var(--sp-4)' },
          field('Rate per kg', el('input', { class: 'input input--num', value: RATE, inputmode: 'decimal' })),
          field('Common charges', el('input', { class: 'input input--num', value: MONTH.otherCharges, inputmode: 'numeric' }))),
        banner('info', el('div', {},
          'Changing the rate now would move every bill in this month by about ',
          el('strong', {}, money(1180)), ' in total. Once the month is published the rate is locked and only a superadmin can reopen it.')),
        el('button', { class: 'btn', type: 'button', onclick: () => setStep(2) }, 'Saved — go to the readings')),
    },
    {
      n: 2, title: 'The meter walk', sub: `${entered} of ${MONTH.total} entered`,
      state: open === 2 ? 'open' : entered === MONTH.total ? 'done' : 'waiting',
      body: () => meterWalk(ctx, entered),
    },
    {
      n: 3, title: 'Check before you send', sub: entered === MONTH.total ? 'Ready' : `${MONTH.total - entered} readings still missing`,
      state: open === 3 ? 'open' : entered === MONTH.total ? 'done' : 'waiting',
      body: () => review(ctx),
    },
    {
      n: 4, title: 'Publish and tell everyone', sub: 'Emails 94 residents and opens the pay screen',
      state: open === 4 ? 'open' : 'waiting',
      body: () => publish(ctx),
    },
  ];

  return [
    el('div', { class: 'stack stack--xs' },
      el('h1', { class: 'largetitle' }, periodLabel(MONTH.period)),
      el('p', { class: 'largetitle__sub' }, 'Four steps. Each one opens when the one before it is done.')),

    el('div', { class: 'steps' }, ...steps.map((s) => el('section', { class: 'step', dataset: { state: s.state } },
      el('button', {
        class: 'step__head', type: 'button',
        disabled: s.state === 'waiting' && s.n > 2 && entered < MONTH.total,
        onclick: () => setStep(s.n),
      },
        el('span', { class: 'step__n' }, s.state === 'done' ? icon('check', { size: 16 }) : String(s.n)),
        el('span', { class: 'step__label' },
          el('span', { class: 'step__title' }, s.title),
          el('span', { class: 'step__sub' }, s.sub)),
        svg(I.chevron, { size: 15, width: 2.4 })),
      el('div', { class: 'step__body' }, s.state === 'open' ? s.body() : el('div'))))),
  ];
}

function meterWalk(ctx, entered) {
  const rows = readingGrid();
  const pct = Math.round((entered / MONTH.total) * 100);
  const remaining = rows.filter((r) => r.reading == null).slice(0, 6);
  const flagged = rows.filter((r) => r.flag);

  return el('div', { class: 'stack' },
    el('div', { class: 'progress' },
      el('div', { class: 'progress__track' }, el('div', { class: 'progress__fill', style: `width:${pct}%` })),
      el('span', {}, `${entered} of ${MONTH.total}`)),
    el('p', { class: 'tiny muted' }, 'Saved as you type. You can put the phone away and come back.'),

    // Two rows that need a human. Surfaced above the grid rather than left to
    // be found in it — a number that is merely unusual is invisible in 94 rows.
    flagged.length ? group('Look at these two', el('div', { class: 'list' },
      ...flagged.map((r) => row({
        title: `Flat ${r.flat}`,
        sub: r.flag === 'high'
          ? `${kg(r.consumption)} this month against ${kg(r.usual)} usual. Re-read the meter before you publish.`
          : `The reading you keyed is below last month's. Either a digit is wrong or the meter was changed.`,
        chip: el('span', { class: `chip chip--${r.flag === 'high' ? 'warn' : 'bad'}` },
          icon('alert', { size: 15 }), r.flag === 'high' ? 'High' : 'Check'),
        onClick: () => toast(`Would open ${r.flat}`),
      })))) : null,

    group('Still to enter', el('div', { class: 'list' },
      ...remaining.map((r) => {
        const input = el('input', {
          class: 'input input--num', inputmode: 'decimal', placeholder: r.prev.toFixed(3),
          'aria-label': `Reading for flat ${r.flat}`,
          style: 'max-width:140px;min-height:44px;padding:var(--sp-2) var(--sp-3)',
        });
        const out = el('span', { class: 'tiny muted', style: 'min-width:8ch' }, '—');
        input.addEventListener('input', () => {
          const v = Number(input.value);
          out.textContent = v > r.prev ? kg(v - r.prev) : v ? 'below last' : '—';
          out.style.color = v && v <= r.prev ? 'var(--bad)' : 'var(--label-2)';
        });
        return el('div', { class: 'list__row' },
          el('span', { class: 'list__body' },
            el('span', { class: 'list__title' }, `Flat ${r.flat}`),
            el('span', { class: 'list__sub' }, `Last ${r.prev.toFixed(3)} · ${r.name}`)),
          out, input);
      })),
      `${MONTH.total - entered - remaining.length} more below. The list is in walking order — floor 1 upward, A to E.`),

    el('div', { class: 'btnrow' },
      el('button', { class: 'btn btn--tinted', type: 'button', onclick: () => pasteSheet() },
        icon('upload', { size: 20 }), 'Paste a whole list'),
      el('button', {
        class: 'btn', type: 'button',
        onclick: () => { ctx.state.entered = MONTH.total; ctx.state.step = 3; ctx.render(); toast('All 94 readings in'); },
      }, 'Finish the walk')));
}

function pasteSheet() {
  sheet('Paste the readings',
    el('p', { class: 'small muted' },
      'One flat per line — the flat number, then the reading. Tabs, commas or spaces between them, whichever your notes use.'),
    el('textarea', { class: 'input mono', rows: 7, placeholder: '1A\t214.500\n1B, 331.200\n1C 402.100' }),
    banner('info', el('div', {}, 'Nothing is saved until you have seen the preview. Anything that does not match a flat is listed rather than skipped quietly.')),
    el('button', { class: 'btn btn--block', type: 'button', onclick: () => toast('Preview would open') }, 'Preview'));
}

function review(ctx) {
  return el('div', { class: 'stack' },
    el('div', { class: 'card card--tight' },
      kv('Flats billed', '94'),
      kv('Gas', money(107_412)),
      kv('Common charges', money(3760)),
      kv('Total to be issued', money(111_172), 'kv--total')),
    banner('warn', el('div', {},
      el('strong', {}, 'Flat 3C is 96% above their usual.'),
      ' Their meter was re-read on 5 September and it stands. Publishing includes them.')),
    group('Not being billed', el('div', { class: 'list' },
      ...['8B', '9E', '11D', '14A', '16D'].map((f) => row({
        title: `Flat ${f}`, sub: 'Nobody on file · excluded by the committee',
        chip: statusChip('exempt'), chev: false,
      })))),
    el('button', { class: 'btn btn--block', type: 'button', onclick: () => { ctx.state.step = 4; ctx.render(); } },
      'Everything looks right'));
}

function publish(ctx) {
  return el('div', { class: 'stack' },
    banner('bad', el('div', {},
      el('strong', {}, 'This cannot be undone from here.'),
      ' Publishing emails 94 residents, opens their pay screen, and locks the rate for September. A published month can only be reopened by a superadmin.')),
    el('div', { class: 'card card--tight' },
      kv('Bills', '94'),
      kv('Total', money(111_172)),
      kv('Due date', dayFull(MONTH.dueDate)),
      kv('Late fee after that', money(50))),
    field('Type PUBLISH to confirm', el('input', { class: 'input', placeholder: 'PUBLISH', autocapitalize: 'characters' }),
      { hint: 'Asked for twice, deliberately. This is the one action in the portal that reaches every resident at once.' }),
    el('button', {
      class: 'btn btn--lg btn--block', type: 'button',
      onclick: () => sheet('Publish September?',
        el('p', {}, '94 bills, ', el('strong', {}, money(111_172)), ' in total, due ', el('strong', {}, dayFull(MONTH.dueDate)), '.'),
        el('p', { class: 'small muted' }, 'Everyone gets an email within a few minutes.'),
        el('button', { class: 'btn btn--block', type: 'button', onclick: () => { toast('September published'); ctx.go('#/admin'); } },
          'Yes, publish and send')),
    }, 'Publish September'));
}

/* ═══ bills ══════════════════════════════════════════════════════════════ */

export function adminBills(ctx) {
  const filter = ctx.state.billFilter ?? 'unpaid';
  const rows = RESIDENTS.slice(0, 18).map((r, i) => ({
    flat: r.flat, name: r.people[0].name,
    total: 820 + ((i * 137) % 900),
    status: i % 9 === 2 ? 'overdue' : i % 5 === 1 ? 'awaiting' : i % 3 === 0 ? 'due' : 'paid',
  }));
  const shown = filter === 'all' ? rows
    : filter === 'unpaid' ? rows.filter((r) => r.status !== 'paid')
    : rows.filter((r) => r.status === filter);

  return [
    el('div', { class: 'stack stack--xs' },
      el('h1', { class: 'largetitle' }, 'Bills'),
      el('p', { class: 'largetitle__sub' }, 'August 2026 · 94 issued')),

    segmented([
      { value: 'unpaid', label: 'Unpaid' },
      { value: 'overdue', label: 'Overdue' },
      { value: 'paid', label: 'Paid' },
      { value: 'all', label: 'All' },
    ], filter, (v) => { ctx.state.billFilter = v; ctx.render(); }),

    shown.length ? group(null, el('div', { class: 'list' },
      ...shown.map((r) => row({
        title: `Flat ${r.flat}`, sub: r.name, value: money(r.total),
        onClick: () => billSheet(r),
      })))) : empty('checkCircle', 'Nothing here', 'Every bill in this filter is settled.'),

    filter === 'overdue' || filter === 'unpaid' ? el('button', {
      class: 'btn btn--tinted btn--block', type: 'button',
      onclick: () => sheet(`Remind ${shown.length} flats?`,
        el('p', { class: 'small muted' }, 'One email each, with the amount and the pay link. Nobody who has already paid is included.'),
        el('button', { class: 'btn btn--block', type: 'button', onclick: () => toast(`${shown.length} reminders sent`) }, 'Send the reminders')),
    }, icon('send', { size: 20 }), `Remind these ${shown.length} flats`) : null,
  ];
}

function billSheet(r) {
  sheet(`Flat ${r.flat}`,
    el('div', { class: 'row' }, el('span', { class: 'spacer' }, r.name), statusChip(r.status)),
    el('div', { class: 'card card--tight' },
      kv('Gas', money(r.total - 40)), kv('Common charges', money(40)), kv('Total', money(r.total), 'kv--total')),
    el('div', { class: 'btnrow' },
      el('button', { class: 'btn btn--tinted', type: 'button', onclick: () => toast('Reminder sent') }, 'Send a reminder'),
      el('button', { class: 'btn btn--outline', type: 'button', onclick: () => toast('Correction requested') }, 'Ask to correct')),
    el('p', { class: 'tiny muted' }, 'A correction needs a second admin to agree before it changes anything.'));
}

/* ═══ proofs ═════════════════════════════════════════════════════════════
   The exact matches are the bulk of a month and need no thought; the
   exceptions are the whole job. So the screen approves the first in one tap
   and spends its space on the second.                                       */

export function adminProofs(ctx) {
  const exact = PROOFS.filter((p) => p.match === 'exact');
  const odd = PROOFS.filter((p) => p.match !== 'exact');

  return [
    el('div', { class: 'stack stack--xs' },
      el('h1', { class: 'largetitle' }, 'Payment screenshots'),
      el('p', { class: 'largetitle__sub' }, `${PROOFS.length} waiting · ${exact.length} match the bill exactly`)),

    exact.length ? el('div', { class: 'stack stack--sm' },
      el('button', {
        class: 'btn btn--lg btn--block', type: 'button',
        onclick: () => sheet(`Approve ${exact.length} payments?`,
          el('p', { class: 'small muted' }, 'Each of these matches its bill to the rupee and carries a reference the portal has not seen before.'),
          el('div', { class: 'list' }, ...exact.map((p) => row({ title: `Flat ${p.flat}`, sub: p.name, value: money(p.amount), chev: false }))),
          el('button', { class: 'btn btn--block', type: 'button', onclick: () => toast(`${exact.length} approved`) }, 'Approve all of them')),
      }, icon('check', { size: 20 }), `Approve the ${exact.length} that match`),
      el('p', { class: 'tiny muted', style: 'text-align:center' }, 'You can still open each one first.')) : null,

    group('These need a decision', el('div', { class: 'stack stack--sm' },
      ...odd.map((p) => proofCard(p)))),

    group('Tapped Pay, sent no screenshot', el('div', { class: 'list' },
      ...CLAIMED_NO_PROOF.map((c) => row({
        title: `Flat ${c.flat}`, sub: `${c.name} · tapped ${ago(c.tappedAt)}`,
        value: money(c.amount), icon: 'clock', tint: 'var(--info)',
        onClick: () => toast('Would open the bank statement filtered to this amount'),
      }))),
      'Match the amount and the payer name against the bank statement before chasing anyone.'),

    group('Matching, one tap each', el('div', { class: 'list' },
      ...exact.map((p) => row({
        title: `Flat ${p.flat}`, sub: `${p.name} · ${p.app} · ${ago(p.at)}`,
        value: money(p.amount), chip: statusChip('paid', 'Matches'),
        onClick: () => proofSheet(p),
      })))),
  ];
}

function proofCard(p) {
  const short = p.match === 'short';
  return el('section', { class: 'card card--tight' },
    el('div', { class: 'row row--wrap' },
      el('strong', {}, `Flat ${p.flat}`),
      el('span', { class: 'small muted spacer' }, p.name),
      el('span', { class: `chip chip--${short ? 'bad' : 'warn'}` },
        icon('alert', { size: 15 }), short ? 'Short' : 'Over')),
    el('div', { class: 'row', style: 'gap:var(--sp-6)' },
      el('div', { class: 'stack stack--xs' },
        el('span', { class: 'tiny muted' }, 'They sent'),
        el('strong', { class: 'num', style: 'font-size:var(--t-title3)' }, money(p.amount))),
      el('div', { class: 'stack stack--xs' },
        el('span', { class: 'tiny muted' }, 'The bill says'),
        el('strong', { class: 'num', style: 'font-size:var(--t-title3)' }, money(p.expected)))),
    // The difference, said in words. A treasurer should not have to subtract.
    banner(short ? 'bad' : 'warn', el('div', {}, p.note)),
    el('p', { class: 'tiny muted mono' }, `${p.app} · ${p.ref} · ${dayLabel(p.at)}`),
    el('div', { class: 'btnrow' },
      el('button', { class: 'btn', type: 'button', onclick: () => toast(`Flat ${p.flat} approved`) }, 'Accept it'),
      el('button', { class: 'btn btn--outline', type: 'button', onclick: () => proofSheet(p) }, 'See the screenshot')),
    el('button', { class: 'btn btn--plain btn--sm', type: 'button', style: 'color:var(--bad)', onclick: () => rejectSheet(p) },
      'Reject and tell them why'));
}

function proofSheet(p) {
  sheet(`Flat ${p.flat}`,
    el('div', { class: 'card card--tight', style: 'align-items:center;gap:var(--sp-3)' },
      el('div', { class: 'empty__icon', style: 'width:64px;height:64px' }, icon('camera', { size: 30 })),
      el('p', { class: 'small muted', style: 'text-align:center' }, 'The screenshot would be shown here, full width, tappable to zoom.')),
    el('div', { class: 'card card--tight' },
      kv('Payer', p.name), kv('Amount', money(p.amount)), kv('Bill', money(p.expected)),
      kv('Reference', p.ref), kv('Sent', dayFull(p.at))),
    el('div', { class: 'btnrow' },
      el('button', { class: 'btn', type: 'button', onclick: () => toast('Approved') }, 'Approve'),
      el('button', { class: 'btn btn--outline', type: 'button', style: 'color:var(--bad)', onclick: () => rejectSheet(p) }, 'Reject')));
}

function rejectSheet(p) {
  const reasons = [
    'The amount does not match the bill',
    'This screenshot has already been sent for another month',
    'The image is unreadable',
    'This is not a payment to the association',
  ];
  sheet(`Reject flat ${p.flat}’s screenshot`,
    el('p', { class: 'small muted' }, 'Pick a reason. It is sent to them word for word, so they know what to do next rather than only that they were refused.'),
    el('div', { class: 'list' }, ...reasons.map((r) => row({ title: r, onClick: () => toast('Rejected, and they have been told why') }))));
}

/* ═══ reconcile ══════════════════════════════════════════════════════════ */

export function adminReconcile(ctx) {
  const matched = STATEMENT.filter((s) => s.matched);
  const unmatched = STATEMENT.filter((s) => !s.matched);

  return [
    el('div', { class: 'stack stack--xs' },
      el('h1', { class: 'largetitle' }, 'The bank statement'),
      el('p', { class: 'largetitle__sub' }, 'Match what arrived against what was billed')),

    el('section', { class: 'card', style: 'align-items:center;gap:var(--sp-3)' },
      el('div', { class: 'empty__icon' }, icon('bank', { size: 28 })),
      el('p', { class: 'small muted', style: 'text-align:center;max-width:34ch' },
        'Paste or upload the statement your bank exported. It is matched, then deleted — the portal never keeps it.'),
      el('button', { class: 'btn btn--block', type: 'button', onclick: () => toast('File picker would open') },
        icon('upload', { size: 20 }), 'Choose the statement file')),

    group(`${matched.length} matched automatically`, el('div', { class: 'list' },
      ...matched.map((s) => row({
        title: `Flat ${s.matched}`, sub: `${dayLabel(s.date)} · ${s.ref}`,
        value: money(s.amount), chip: statusChip('paid', 'Matched'), chev: false,
      })))),

    group(`${unmatched.length} the portal could not place`, el('div', { class: 'stack stack--sm' },
      ...unmatched.map((s) => el('div', { class: 'card card--tight' },
        el('div', { class: 'row' },
          el('strong', { class: 'num' }, money(s.amount)),
          el('span', { class: 'spacer small muted' }, dayLabel(s.date)),
          el('span', { class: 'chip chip--warn' }, icon('alert', { size: 15 }), 'No match')),
        el('p', { class: 'tiny mono muted' }, s.ref),
        banner('info', el('div', {}, s.hint)),
        el('div', { class: 'btnrow' },
          el('button', { class: 'btn btn--sm', type: 'button', onclick: () => toast('Assigned') }, 'Assign to a flat'),
          el('button', { class: 'btn btn--outline btn--sm', type: 'button', onclick: () => toast('Marked as not a gas payment') }, 'Not a gas payment'))))),
      'Anything left unmatched stays here until you decide. Nothing is written off on its own.'),

    el('button', { class: 'btn btn--outline btn--block', type: 'button', style: 'color:var(--bad)', onclick: () => sheet('Delete the statement?',
      el('p', { class: 'small muted' }, 'The matches you made are kept. The statement itself — every line, including the ones that are nothing to do with gas — is deleted for good.'),
      el('button', { class: 'btn btn--bad btn--block', type: 'button', onclick: () => toast('Statement deleted') }, 'Delete it')) },
      'Finish and delete the statement'),
  ];
}

/* ═══ residents ══════════════════════════════════════════════════════════
   Keyed by the flat, because "who is in 7B" is the question that gets asked.
   A flat with an owner and a tenant is one entry with two people under it —
   which is also the only way the tenanted case is visible at all.            */

export function adminResidents(ctx) {
  const q = (ctx.state.residentQuery ?? '').trim().toLowerCase();
  const filter = ctx.state.residentFilter ?? 'all';
  let shown = RESIDENTS;
  if (filter === 'tenanted') shown = shown.filter((r) => r.people.length > 1);
  if (filter === 'nologin') shown = shown.filter((r) => r.people.some((p) => !p.loggedIn));
  if (filter === 'notbilled') shown = shown.filter((r) => !r.billed);
  if (q) shown = shown.filter((r) => r.flat.toLowerCase().includes(q) || r.people.some((p) => p.name.toLowerCase().includes(q)));

  const search = el('input', {
    class: 'input', type: 'search', placeholder: 'Flat number or name', value: ctx.state.residentQuery ?? '',
    oninput: (e) => { ctx.state.residentQuery = e.target.value; ctx.state.keepFocus = 'search'; ctx.render(); },
    id: 'search',
  });

  return [
    el('div', { class: 'stack stack--xs' },
      el('h1', { class: 'largetitle' }, 'The building'),
      el('p', { class: 'largetitle__sub' }, '99 flats · 105 people on file')),

    search,
    segmented([
      { value: 'all', label: 'All' },
      { value: 'tenanted', label: 'Rented' },
      { value: 'nologin', label: 'Never in' },
      { value: 'notbilled', label: 'Not billed' },
    ], filter, (v) => { ctx.state.residentFilter = v; ctx.render(); }),

    shown.length ? group(`${shown.length} flats`, el('div', { class: 'list' },
      ...shown.map((r) => row({
        title: `Flat ${r.flat}`,
        sub: r.people.map((p) => p.name).join(' · '),
        chip: !r.billed ? statusChip('exempt')
          : r.people.length > 1 ? el('span', { class: 'chip chip--info' }, icon('users', { size: 15 }), 'Rented')
          : r.people.some((p) => !p.loggedIn) ? el('span', { class: 'chip chip--warn' }, icon('alert', { size: 15 }), 'Never in')
          : null,
        onClick: () => flatSheet(r),
      })))) : empty('search', 'No flat matches that', 'Try the number on its own — 7B, or just 7.'),
  ];
}

function flatSheet(r) {
  sheet(`Flat ${r.flat}`,
    !r.billed ? banner('info', el('div', {}, 'This flat is not billed. Nobody is on file for it, so no bill is generated and no reminder is sent.')) : null,
    ...r.people.map((p) => el('div', { class: 'card card--tight' },
      el('div', { class: 'row' },
        el('span', { class: 'avatar' }, p.name.split(' ').map((w) => w[0]).slice(0, 2).join('')),
        el('div', { class: 'stack stack--xs spacer' },
          el('strong', {}, p.name),
          el('span', { class: 'tiny muted' }, p.role === 'owner' ? 'Owner' : 'Tenant')),
        p.loggedIn ? el('span', { class: 'chip chip--good' }, icon('checkCircle', { size: 15 }), 'Logged in')
                   : el('span', { class: 'chip chip--warn' }, icon('alert', { size: 15 }), 'Never in')),
      kv('Mobile', p.mobile),
      kv('Pays the bill', p.pays ? 'Yes' : 'No'),
      kv('Liable if unpaid', p.liable ? 'Yes' : 'No'),
      el('div', { class: 'btnrow' },
        el('button', { class: 'btn btn--tinted btn--sm', type: 'button', onclick: () => toast('Details opened for editing') }, 'Edit'),
        !p.loggedIn ? el('button', { class: 'btn btn--outline btn--sm', type: 'button', onclick: () => toast('Temporary password sent') }, 'Send a login') : null))),
    r.people.length > 1 ? banner('info', el('div', {},
      el('strong', {}, 'The tenant pays, the owner is liable.'),
      ' The tenant sees the bill and the pay screen. The owner sees the amount but not the payment screenshots.')) : null);
}

/* ═══ roster import ══════════════════════════════════════════════════════ */

export function adminRoster(ctx) {
  const stage = ctx.state.rosterStage ?? 'paste';

  if (stage === 'preview') {
    return [
      el('h1', { class: 'largetitle' }, 'Check before it is written'),
      banner('warn', el('div', {},
        el('strong', {}, 'Nothing has changed yet.'),
        ' This is what the paste would do. Read it, then decide.')),
      group('3 flats would change hands', el('div', { class: 'list' },
        row({ title: 'Flat 12B', sub: 'Joseph Chacko → Meera Pillai', chip: el('span', { class: 'chip chip--warn' }, icon('alert', { size: 15 }), 'New owner'), chev: false }),
        row({ title: 'Flat 5D', sub: 'Owner-occupied → rented to Anil Kumar', chip: el('span', { class: 'chip chip--info' }, icon('users', { size: 15 }), 'Now rented'), chev: false }),
        row({ title: 'Flat 18A', sub: 'Latha Nair moves out, nobody replaces her', chip: statusChip('exempt'), chev: false }))),
      group('11 people would be created', el('div', { class: 'list' },
        row({ title: '11 new accounts', sub: 'Each gets a temporary password by SMS', icon: 'person', tint: 'var(--accent)', chev: false }))),
      group('2 lines could not be read', el('div', { class: 'list' },
        row({ title: 'Line 34', sub: '“7 B” — is that 7B? Flat numbers have no space.', chip: el('span', { class: 'chip chip--bad' }, icon('alert', { size: 15 }), 'Skipped'), chev: false }),
        row({ title: 'Line 51', sub: '“Menon, K. P.” — the comma made this two columns.', chip: el('span', { class: 'chip chip--bad' }, icon('alert', { size: 15 }), 'Skipped'), chev: false })),
        'Skipped lines are never guessed at. Fix them in your paste and try again, or import the rest and add these two by hand.'),
      el('div', { class: 'btnrow' },
        el('button', { class: 'btn', type: 'button', onclick: () => { ctx.state.rosterStage = 'paste'; toast('Roster imported'); ctx.render(); } }, 'Import it'),
        el('button', { class: 'btn btn--outline', type: 'button', onclick: () => { ctx.state.rosterStage = 'paste'; ctx.render(); } }, 'Go back')),
    ];
  }

  return [
    el('div', { class: 'stack stack--xs' },
      el('h1', { class: 'largetitle' }, 'Import the roster'),
      el('p', { class: 'largetitle__sub' }, 'Superadmin only')),
    banner('bad', el('div', {},
      el('strong', {}, 'This rewrites the whole directory in one go.'),
      ' You will see exactly what changes before anything is written, and nothing is deleted — a flat that disappears from the paste is marked as having nobody on it, not erased.')),
    field('Paste the building',
      el('textarea', { class: 'input mono', rows: 8, placeholder: 'Flat\tName\tMobile\tOwner or tenant\n1A\tRajan Menon\t9847021188\towner\n1B\tSusan Thomas\t9495033127\towner' }),
      { hint: 'One flat per line. Copy straight out of the spreadsheet — tabs are what you get and tabs are what this expects.' }),
    el('button', { class: 'btn btn--lg btn--block', type: 'button', onclick: () => { ctx.state.rosterStage = 'preview'; ctx.render(); } },
      'Show me what would change'),
  ];
}

/* ═══ notices, from the committee's side ═════════════════════════════════ */

export function adminNotices(ctx) {
  return [
    el('div', { class: 'stack stack--xs' },
      el('h1', { class: 'largetitle' }, 'Notices'),
      el('p', { class: 'largetitle__sub' }, 'What the building sees')),

    el('button', { class: 'btn btn--lg btn--block', type: 'button', onclick: () => composeSheet() },
      icon('plus', { size: 20 }), 'Write a notice'),

    group('Posted', el('div', { class: 'list' },
      ...NOTICES.map((n) => row({
        title: n.title, sub: `${dayLabel(n.postedAt)} · ${n.by}${n.comments.length ? ` · ${n.comments.length} replies` : ''}`,
        chip: n.pinned ? el('span', { class: 'chip chip--info' }, icon('info', { size: 15 }), 'Pinned') : null,
        onClick: () => manageSheet(n),
      })))),
  ];
}

function composeSheet() {
  sheet('Write a notice',
    field('Title', el('input', { class: 'input', placeholder: 'Water tank cleaning — Tuesday' }),
      { hint: 'This is all most people read. Put the what and the when in it.' }),
    field('Notice', el('textarea', { class: 'input', rows: 6 }),
      { hint: 'Blank lines become paragraphs. Lines starting with a hyphen become a list.' }),
    el('div', { class: 'stack stack--sm' },
      el('span', { class: 'field__label' }, 'Who can see this'),
      el('div', { class: 'list' },
        row({ title: 'Everyone in the building', sub: 'Owners and tenants', icon: 'users', tint: 'var(--accent)', chev: false }),
        row({ title: 'Owners only', sub: 'For anything about the property itself', icon: 'home', tint: 'var(--info)', chev: false }))),
    el('label', { class: 'checkline' },
      el('input', { type: 'checkbox' }),
      el('span', {}, 'Let residents reply',
        el('span', { class: 'checkline__hint' }, 'Replies are shown with the flat number and can be hidden later'))),
    el('button', { class: 'btn btn--block', type: 'button', onclick: () => toast('Notice posted') }, 'Post it'));
}

function manageSheet(n) {
  sheet(n.title,
    el('p', { class: 'small muted' }, `${dayFull(n.postedAt)} · ${n.by}`),
    el('div', { class: 'list' },
      row({ title: 'Edit', icon: 'doc', tint: 'var(--accent)', onClick: () => toast('Editor would open') }),
      row({ title: n.commentsOpen ? 'Turn replies off' : 'Turn replies on', icon: 'mail', tint: 'var(--info)', onClick: () => toast('Changed') }),
      row({ title: n.pinned ? 'Unpin' : 'Pin to the top', icon: 'bell', tint: 'var(--warn)', onClick: () => toast('Changed') })),
    el('button', { class: 'btn btn--outline btn--block', type: 'button', style: 'color:var(--bad)',
      onclick: () => toast('Withdrawn — residents no longer see it') }, 'Withdraw this notice'),
    el('p', { class: 'tiny muted' }, 'Withdrawing hides it from residents. It is kept, so a decision can be checked afterwards.'));
}
