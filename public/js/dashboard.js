/**
 * Home — the first screen behind the login.
 *
 * This used to be one gas bill rendered as a hero. Maintenance made that shape
 * wrong: a resident can owe two different things on two different cadences, and
 * the one that matters is whichever is due soonest rather than whichever the
 * page was built around. So it is four lists now, in a fixed order:
 *
 *   To pay          what needs money, soonest first
 *   Coming up       what is about to arrive
 *   Waiting for you polls and unread notices
 *   Recently paid   did my payment land
 *
 * EMPTINESS IS NOT UNIFORM, and that is deliberate. "To pay" with nothing in it
 * renders ANYWAY, with a reassuring line, because it answers the question the
 * resident opened the app to ask and an absent section makes them hunt for the
 * answer. The other three are hidden when empty: a heading over nothing is
 * noise.
 *
 * THERE IS NO COMBINED TOTAL ON THIS PAGE, and none may be added. A monthly gas
 * bill and a quarterly maintenance bill are never summed anywhere in this
 * portal — the user rejected a single "you owe" figure here, and the same
 * reasoning is why the admin dues report is split per bank account. There are
 * no gas/maintenance tabs either; that was rejected too, so do not reintroduce
 * one as a filter.
 *
 * The bill hero that used to live here is now js/bill.js, behind these cards.
 */

import { api, ApiError } from './api.js';
import { renderNav } from './nav.js';
import { trackPage } from './track.js';
import { $, el, esc, statusChip, renderViewBanner, showError } from './ui.js';
import { money, periodLabel, dayLabel, closesIn } from './i18n.js';

const main = $('#main');

trackPage('/dashboard');
init();

async function init() {
  try {
    const me = await api.me();
    if (me.mustChangePassword) { location.href = '/password'; return; }
    render(me);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login'; return; }
    showError(main, err);
  }
}

function render(me) {
  $('#who').innerHTML = `Flat ${esc(me.flat)} <span>· ${esc(me.name)}</span>`;

  renderViewBanner(me, {
    onExit: async () => { await api.god.exit(); location.reload(); },
    onAllowWrites: async () => { /* phase 7b: re-issue the session with writes */ },
  });
  renderNav(me, '/dashboard');

  const home = me.home ?? {};

  main.replaceChildren(
    landlordNote(me),
    // Always rendered, empty or not. See the note at the top of this file.
    toPaySection(home.toPay ?? []),
    // A state, not a task — so its own card under the bills rather than a row
    // among the things being waited on.
    votingSection(home.voting),
    ...hideWhenEmpty(comingUpSection(home.comingUp ?? [])),
    ...hideWhenEmpty(waitingSection(home.waitingForYou ?? [])),
    ...hideWhenEmpty(recentSection(home.recentlyPaid ?? [], me)),
    helpSection(),
  );
}

/** Three of the four sections simply do not exist when they have nothing. */
function hideWhenEmpty(section) {
  return section ? [section] : [];
}

/**
 * A landlord whose flat is let is reading their TENANT's bills.
 *
 * The tenant is NAMED, and the owner is told they may pay on their behalf. An
 * amount with no name against it looks like a demand for money you owe, and an
 * owner who does not know whose bill this is either pays twice or not at all.
 */
function landlordNote(me) {
  const t = me.tenancy;
  if (t?.viewing !== 'landlord') return null;
  const who = t.occupantName ?? 'your tenant';
  return el('div', { class: 'note' },
    `You own ${me.flat} and it is let to ${who}. These are their bills. `
    + 'You can pay on their behalf, and you are liable if they go unpaid. '
    + 'Payment screenshots are not shown to owners.');
}

/* ── 1. To pay ────────────────────────────────────────────────────────── */

function toPaySection(cards) {
  return el('section', { class: 'stack' },
    el('h2', { class: 'label' }, 'To pay'),
    cards.length
      ? el('div', { class: 'cards' }, ...cards.map((c) => billCard(c)))
      // The reassuring line. This is the one empty state that is worth a
      // section of its own, because it is the answer most people came for.
      : el('div', { class: 'note note--good' }, 'Nothing to pay right now.'));
}

/**
 * One bill, as a card.
 *
 * THE WHOLE CARD IS TAPPABLE and Pay is the primary action on it. A resident
 * who wants to know what a number is made of should not have to find a link.
 *
 * A STATUS CHIP ONLY WHERE A STATE NEEDS EXPLAINING. A plainly unpaid bill in a
 * section headed "To pay" does not need a chip saying Unpaid. A bill whose
 * screenshot is with the treasurer does, because it is the one thing that stops
 * somebody paying the same bill twice.
 */
function billCard(card) {
  const isMaint = card.kind === 'maintenance';
  const href = `/bill?id=${encodeURIComponent(card.id)}`;
  const label = isMaint ? card.periodLabel : periodLabel(card.period);
  const explains = card.status === 'initiated' || card.status === 'awaiting';

  return el('article', { class: `card ${card.overdue ? 'card--overdue' : ''}` },
    el('a', { class: 'card__link', href },
      el('div', { class: 'card__top' },
        el('span', { class: 'card__kind' },
          kindIcon(card.kind),
          isMaint ? 'Maintenance' : 'Gas'),
        explains ? statusChip(card.displayStatus) : null),

      el('p', { class: 'card__period' }, label),

      el('p', { class: 'card__amount' }, money(card.total)),

      el('p', { class: 'small muted' },
        card.dueDate
          ? (card.overdue ? `Was due ${dayLabel(card.dueDate)}` : `Due ${dayLabel(card.dueDate)}`)
          : 'No due date set'),

      // NEVER FOLD AN UNEXPLAINED FEE INTO THE AMOUNT. Once the fee is charged
      // the figure above already includes it, and without this line the total
      // simply looks wrong.
      card.lateFee
        ? el('p', { class: 'small', style: 'color:var(--overdue)' },
            `Includes a late fee of ${money(card.lateFee)}`)
        : null,

      // Before it lands, name the date rather than the number of days — a day
      // count is wrong the moment the page is left open.
      card.lateFeeWarning
        ? el('p', { class: 'small', style: 'color:var(--awaiting)' },
            `${money(card.lateFeeWarning.amount)} late fee from ${dayLabel(card.lateFeeWarning.after)}`)
        : null,

      card.pendingApproval
        ? el('p', { class: 'small muted' },
            'The committee is reviewing a change to this bill.')
        : null),

    // PER CARD, decided by the server. A landlord may pay their tenant's
    // maintenance and not their gas, so one flag for the whole page would put a
    // button on a bill the rules refuse — see canPayBill in lib/bill-view.js.
    card.canPay
      ? el('a', {
          class: 'btn btn--block', href: `/pay?bill=${encodeURIComponent(card.id)}&from=/dashboard`,
        }, `Pay ${money(card.total)}`)
      : null);
}

/** A flame or a building, so the two kinds are told apart without reading. */
function kindIcon(kind) {
  const path = kind === 'maintenance'
    ? 'M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5'      // a building
    : 'M12 22a6 6 0 006-6c0-4-6-10-6-10S6 12 6 16a6 6 0 006 6z';   // a flame
  return el('svg', {
    width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round',
    'stroke-linejoin': 'round', 'aria-hidden': 'true',
    html: `<path d="${path}"/>`,
  });
}

/* ── the vote ─────────────────────────────────────────────────────────── */

/**
 * "Your vote" — its own card, under the bills.
 *
 * NOBODY IS NAMED HERE, on either side. A flat's vote can be locked by a
 * TENANT's arrears while the OWNER is the one who loses it, and the card names
 * the debt and the quarter instead of the person. That matters most in exactly
 * the case where naming somebody would be easiest.
 *
 * Absent when the flat can vote and nothing needed saying — a card confirming
 * that everything is normal is a card that trains people to ignore it.
 */
function votingSection(voting) {
  if (!voting || voting.canVote) return null;

  return el('section', { class: 'stack' },
    el('h2', { class: 'label' }, 'Your vote'),
    el('div', { class: 'note note--warn' },
      el('p', {}, voting.message ?? 'This flat cannot vote at the moment.'),
      voting.owed
        ? el('p', { class: 'small' },
            `${money(voting.owed)} outstanding`
            + (voting.quarters?.length ? ` · ${voting.quarters.join(', ')}` : ''))
        : null));
}

/* ── 2. Coming up ─────────────────────────────────────────────────────── */

/**
 * NO AMOUNTS HERE, not even where we know them.
 *
 * A scheduled quarter's rates are frozen, so a figure would in fact be right.
 * Showing it was considered and rejected: rates are editable per quarter and a
 * number a resident has read is a number the committee will be held to.
 */
function comingUpSection(items) {
  if (!items.length) return null;

  return el('section', { class: 'stack' },
    el('h2', { class: 'label' }, 'Coming up'),
    ...items.map((item) => el('div', { class: 'row' },
      el('span', { class: 'card__kind' },
        kindIcon(item.kind),
        item.kind === 'maintenance' ? 'Maintenance' : 'Gas'),
      el('span', {}, item.kind === 'maintenance'
        ? item.periodLabel
        : `${periodLabel(item.period)} bill`),
      el('span', { class: 'small muted' },
        item.kind === 'maintenance'
          ? (item.issueDate
              // A draft quarter's date is a plan and a scheduled one's is a
              // commitment. They must not read the same way.
              ? `${item.status === 'scheduled' ? 'Arrives' : 'Expected'} ${dayLabel(item.issueDate)}`
              : 'Date not set yet')
          : `Arrives early ${periodLabel(item.arrivesIn).split(' ')[0]}`))));
}

/* ── 3. Waiting for you ───────────────────────────────────────────────── */

/**
 * Polls and unread notices. TWO LABELLED GROUPS, polls first.
 *
 * THIS IS NOT AN INBOX. It was approved meaning these two things and nothing
 * else: a payment proof under review belongs on the bill card, where it stops a
 * resident paying twice, and a missing profile detail is not something the
 * building is waiting for. Each thing added here makes it a little more of a
 * general to-do list and a little less of the short, true list it was approved
 * as.
 */
function waitingSection(groups) {
  if (!groups.length) return null;

  const blocks = groups.map((group) => {
    if (group.kind === 'polls') {
      return el('div', { class: 'stack' },
        el('p', { class: 'small muted' }, 'Polls'),
        ...group.items.map((poll) => el('a', { class: 'row row--link', href: poll.href },
          el('span', {}, poll.title),
          el('span', { class: 'small muted' },
            poll.closesAt ? closesIn(poll.closesAt) : 'Open'))));
    }
    return el('div', { class: 'stack' },
      el('p', { class: 'small muted' }, 'Notices'),
      el('a', { class: 'row row--link', href: group.href },
        el('span', {}, group.count === 1 ? '1 unread notice' : `${group.count} unread notices`),
        el('span', { class: 'small muted' }, 'Read')));
  });

  return el('section', { class: 'stack' },
    el('h2', { class: 'label' }, 'Waiting for you'),
    ...blocks);
}

/* ── 4. Recently paid ─────────────────────────────────────────────────── */

/**
 * Did my payment land. Not a ledger — the last three, within ninety days.
 *
 * A waived bill appears here LABELLED AS WAIVED, because it is closed and a
 * resident who was forgiven something should see it. A cancelled bill does not:
 * it should never have existed, and listing it under paid invites the question
 * of what happened to money that was never owed.
 */
function recentSection(cards, me) {
  if (!cards.length) return null;

  return el('section', { class: 'stack' },
    el('h2', { class: 'label' }, 'Recently paid'),
    ...cards.map((card) => el('a', {
      class: 'row row--link', href: `/bill?id=${encodeURIComponent(card.id)}`,
    },
      el('span', { class: 'card__kind' },
        kindIcon(card.kind),
        card.kind === 'maintenance' ? card.periodLabel : periodLabel(card.period)),
      el('span', {}, money(card.total)),
      statusChip(card.displayStatus))),

    // Into the history that already exists, rather than a second one here.
    // It lives on the gas bill detail, so the link only exists when there is a
    // gas bill to hang it on — a link to an empty screen is worse than none.
    me.bill?.id && me.bills?.length
      ? el('p', { class: 'small' },
          el('a', {
            class: 'linkish', href: `/bill?id=${encodeURIComponent(me.bill.id)}#history`,
          }, 'See all bills'))
      : null);
}

function helpSection() {
  return el('section', { class: 'stack' },
    el('hr', { class: 'rule' }),
    el('p', { class: 'small muted' },
      'Questions about a bill? Reach out to the committee.'));
}
