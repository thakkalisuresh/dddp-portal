/**
 * The resident home payload — step 5.
 *
 * The dashboard used to be one gas bill, rendered as a hero. Maintenance makes
 * that shape wrong: a resident can now owe two different things on two
 * different cadences, and the one that matters is whichever is due soonest, not
 * whichever the page was built around.
 *
 * So the home page becomes four lists — what to pay, what is coming, what is
 * waiting on you, what you have just paid — and this module is the part that
 * decides what goes in them. Everything here that can be pure is pure, because
 * the ordering rules are the fiddly part and the ordering rules are exactly
 * what nobody can check by looking at a rendered page.
 *
 * WHAT THIS MODULE DOES NOT DO: it does not decide what a card SAYS. The copy
 * is placeholder until the committee's wording pass (PLACEHOLDER_COPY), and the
 * layout is the mockups' business, not this file's.
 */

import { istToday } from './time.js';
import {
  isSettled, describeQuarter, quarterRange, lateFeeDateFor, flatVotingStatus,
} from './maint.js';

/** How many settled bills "Recently paid" carries before it defers to history. */
export const RECENT_LIMIT = 3;

/**
 * How far back "Recently paid" looks.
 *
 * A window rather than a pure count, because a count alone means a flat that
 * has paid nothing for a year still shows four cheerful green cards from last
 * autumn under a heading that says "recently". Both apply: at most RECENT_LIMIT
 * bills, none older than this.
 */
export const RECENT_DAYS = 90;

/* ── one bill, whichever kind it is ───────────────────────────────────────
   The two bill tables are deliberately NOT merged in the database — they have
   different columns, different cadences and different money rules, and 0042
   says why at length. They are merged HERE, at the last possible moment, into
   the one shape a card needs. The `kind` field is what survives of the
   difference.                                                                */

/**
 * Derived presentation state for a maintenance bill.
 *
 * The twin of shapeBill() in lib/dashboard.js, kept separate rather than
 * generalised: the two share four fields and disagree about the rest, and a
 * function with a `kind` branch running through every line of it would be
 * harder to check than two functions that each say one thing.
 */
export function shapeMaintBill(bill, quarter, today = istToday()) {
  if (!bill) return null;

  const settled = isSettled(bill);
  const claimed = bill.status === 'initiated' || bill.status === 'awaiting';
  const dueDate = quarter?.due_date ?? bill.due_date ?? null;

  // `>=`, matching gas: the fee lands at 00:00 IST on the day AFTER the due
  // date (lateFeeDateFor), but the bill stops reading "due in n days" the
  // moment the due date itself arrives. See maintLateFeeDecision for why the
  // charge and the wording use different cutoffs.
  const pastDue = !settled && dueDate != null && String(today) >= String(dueDate);

  return {
    kind: 'maintenance',
    id: bill.id,
    // The sortable label ('2026-Q4') and the sentence a human reads, built from
    // it rather than stored — 0042 is emphatic that a quarter must not end up
    // described two different ways on two different screens.
    period: bill.quarter,
    periodLabel: describeQuarter(bill.quarter),
    basis: bill.basis,
    rateApplied: bill.rate_applied,
    lateFee: bill.late_fee,
    lateFeeAt: bill.late_fee_at,
    total: bill.total,
    status: bill.status,
    paidAt: bill.paid_at,
    dueDate,
    createdAt: bill.created_at,

    displayStatus: settled
      ? bill.status                      // paid | waived | cancelled
      : claimed ? bill.status
      : pastDue ? 'overdue' : 'unpaid',

    // Same rule as gas, for the same reason: a dead button is worse than no
    // button, and a bill whose screenshot is already with the treasurer must
    // not invite a second transfer.
    showPayButton: !settled && bill.status !== 'awaiting',
    showUploadLink: !settled,
    settled,

    // An approval in flight freezes the late-fee clock (maintLateFeeDecision),
    // so it must also silence the warning — otherwise the card threatens a fee
    // that the rules have already agreed cannot land.
    lateFeeWarning:
      !settled && !bill.late_fee && !bill.pending_approval
        && Number(quarter?.late_fee) > 0 && !pastDue
        ? { amount: quarter.late_fee, after: lateFeeDateFor(dueDate) }
        : null,

    // Surfaced rather than hidden: a resident whose bill is frozen pending two
    // admins' agreement should be told that, not left looking at an unchanged
    // amount and wondering whether anyone read their message.
    pendingApproval: Boolean(bill.pending_approval),
  };
}

/**
 * The same shape, for a gas bill already shaped by lib/dashboard.js.
 *
 * Gas bills arrive here through shapeBill(), which predates this page and is
 * used by the bill PDF and the old dashboard too. Rather than change it and
 * touch three callers, its output is adapted — one place, and the gas bill
 * keeps the exact shape everything else already expects.
 */
export function asGasCard(bill) {
  if (!bill) return null;
  return { ...bill, kind: 'gas', periodLabel: bill.period };
}

/* ── the four lists ───────────────────────────────────────────────────────  */

/**
 * What a resident owes, soonest due first.
 *
 * SORTED BY DUE DATE ACROSS BOTH KINDS, not grouped by kind. The question this
 * page answers is "what needs my money next", and a resident who owes gas on
 * the 15th and maintenance on the 11th is not helped by a layout that puts all
 * the gas together. Grouping would also mean deciding which group goes on top,
 * which is a decision about the building's priorities that nobody has made and
 * that this page should not smuggle in.
 *
 * TIES ARE BROKEN BY MAINTENANCE FIRST, and not because it is the bigger
 * number: missing it costs ₹750 where missing the gas bill costs a fraction of
 * that, so on a day when a resident can only deal with one of them, the
 * expensive one to miss should be the one they see first.
 *
 * A bill with no due date sorts last rather than first — an undated bill is a
 * data problem, and a data problem must not jump the queue in front of a real
 * deadline. Period and kind finish the comparison so the order is TOTAL rather
 * than merely mostly-decided; an unstable order on a page someone refreshes is
 * a page that looks broken.
 *
 * NO TOTAL IS COMPUTED HERE, and none may be added. A monthly gas bill and a
 * quarterly maintenance bill are never summed anywhere in this portal — the
 * user rejected a single "you owe" figure on this page, and the same reasoning
 * keeps the admin dues report split per bank account.
 */
export function toPay(cards, today = istToday()) {
  return (cards ?? [])
    .filter((c) => c && !c.settled && c.status !== 'cancelled')
    .sort((a, b) => {
      const ad = a.dueDate ?? '9999-12-31';
      const bd = b.dueDate ?? '9999-12-31';
      if (ad !== bd) return ad < bd ? -1 : 1;
      if (a.kind !== b.kind) return a.kind === 'maintenance' ? -1 : 1;
      if (a.period !== b.period) return String(a.period) < String(b.period) ? -1 : 1;
      return Number(b.total) - Number(a.total);
    })
    .map((c) => ({ ...c, overdue: c.dueDate != null && String(today) >= String(c.dueDate) }));
}

/**
 * What is coming but has not been raised yet.
 *
 * The point of the section is that maintenance is quarterly and therefore easy
 * to be ambushed by: ₹7,500 arriving unannounced is a different experience from
 * ₹7,500 you have known about for a week. Gas belongs here for the milder
 * version of the same reason — it is the answer to "is a bill about to land".
 *
 * NO AMOUNTS. NOT EVEN WHERE WE KNOW THEM.
 *
 * A scheduled quarter has frozen rates, so the figure would in fact be right,
 * and showing it was considered and REJECTED: rates are editable per quarter,
 * and a number a resident has read is a number the committee will be held to.
 * The section says what is coming and roughly when, and nothing else. If you
 * are here to add an "estimated amount", that is the decision you are
 * reversing.
 */
export function comingUp({
  quarters = [], billedQuarters = [], latestGasPeriod = null, gasPending = false,
} = {}) {
  const billed = new Set(billedQuarters);

  const maint = quarters
    .filter((q) => q && !billed.has(q.quarter))
    .filter((q) => q.status === 'draft' || q.status === 'scheduled')
    .sort((a, b) => String(a.quarter).localeCompare(String(b.quarter)))
    .map((q) => ({
      kind: 'maintenance',
      period: q.quarter,
      periodLabel: describeQuarter(q.quarter),
      range: quarterRange(q.quarter),
      // A draft quarter's issue date is a plan; a scheduled one's is a
      // commitment. The card should not read the same way for both, so the
      // status travels with it and the screen decides how to say so.
      status: q.status,
      issueDate: q.issue_date ?? null,
    }));

  // The gas month whose meter has not been read yet. A usage month is billed
  // early in the month AFTER it — a June bill comes out in July — so "arrives"
  // is that following month rather than the usage month itself.
  const gas = gasPending && latestGasPeriod
    ? [{
        kind: 'gas',
        period: nextMonth(latestGasPeriod),
        periodLabel: nextMonth(latestGasPeriod),
        arrivesIn: nextMonth(nextMonth(latestGasPeriod)),
      }]
    : [];

  return [...maint, ...gas];
}

/** '2026-10' → '2026-11'. */
function nextMonth(period) {
  const [y, m] = String(period).split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * What has been settled lately.
 *
 * Includes waived bills and excludes cancelled ones. A waiver is an outcome the
 * resident should see — somebody decided they did not have to pay and that is
 * worth knowing — whereas a cancelled bill is one that should never have
 * existed, and listing it under "paid" invites the question of what happened to
 * money that was never owed.
 */
export function recentlyPaid(cards, { today = istToday(), limit = RECENT_LIMIT } = {}) {
  const floor = daysBefore(today, RECENT_DAYS);
  return (cards ?? [])
    .filter((c) => c && c.settled && c.status !== 'cancelled')
    .filter((c) => !c.paidAt || String(c.paidAt).slice(0, 10) >= floor)
    .sort((a, b) => String(b.paidAt ?? '').localeCompare(String(a.paidAt ?? '')))
    .slice(0, limit);
}

/**
 * Things the building is waiting on this resident for.
 *
 * TWO LABELLED GROUPS, polls first, then notices — not one merged list. They
 * ask for different things: a poll wants a decision, a notice wants to be read.
 *
 * THIS IS NOT AN INBOX, and the approval it was given was narrower than the
 * heading sounds: polls and unread notices, and nothing else. A payment proof
 * under review belongs on the bill card, where it stops a resident paying
 * twice; a missing profile detail is not something the building is waiting for.
 * Each thing added here makes it a little more of a general to-do list and a
 * little less of the short, true list it was approved as.
 */
export function waitingForYou({ openPolls = [], unreadNotices = 0 } = {}) {
  const groups = [];

  if (openPolls.length) {
    groups.push({
      kind: 'polls',
      items: openPolls.map((poll) => ({
        id: poll.id,
        title: poll.title,
        closesAt: poll.closes_at ?? poll.closesAt ?? null,
        href: `/polls#poll-${poll.id}`,
      })),
    });
  }

  if (unreadNotices > 0) {
    groups.push({ kind: 'notices', count: unreadNotices, href: '/notices' });
  }

  return groups;
}

/**
 * The "Your vote" card.
 *
 * Its OWN card under the bills, not a row inside "Waiting for you": a locked
 * vote is a state the resident is in, not a task they can tick off, and filing
 * it among the tasks implies an action that may not exist for them.
 *
 * NOBODY IS BLAMED, ON EITHER SIDE. The flat's vote can be locked by a
 * TENANT's arrears while the OWNER is the one who loses it (see
 * flatVotingStatus), so the card names the debt and the quarter and never the
 * person. This matters most in exactly the case where it is most tempting to
 * name them.
 */
export function votingCard(status) {
  if (!status) return null;
  return {
    canVote: status.canVote,
    reason: status.reason,
    message: status.message ?? null,
    owed: status.owed ?? 0,
    quarters: status.quarters ?? [],
  };
}

/** ISO date n days before the given ISO date. Dates only — no clock, no zone. */
function daysBefore(iso, days) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/* ── the payload ──────────────────────────────────────────────────────────  */

/**
 * The maintenance half of the resident home payload.
 *
 * Deliberately a SEPARATE function from dashboardPayload() rather than more
 * lines inside it: that function is already long, it is read by the bill PDF
 * and the old hero, and maintenance has its own visibility question to answer.
 * The caller merges the two.
 *
 * VISIBILITY IS THE CALLER'S, NOT OURS. `readers` is the household id list that
 * billAccess() has already decided — a landlord reading their tenant's bills
 * arrives here with the tenant's ids, and this function never re-derives that.
 * The one rule bill visibility must obey lives in one place, because this is
 * the part of the app that has already had a privacy bug.
 */
export async function maintHomePayload(env, { flat, readers, subject, today = istToday() }) {
  const holders = readers.map(() => '?').join(', ');

  const [bills, quarters, advances, exemption] = await Promise.all([
    env.DB.prepare(
      `SELECT b.*, q.due_date AS quarter_due, q.late_fee AS quarter_late_fee,
              q.status AS quarter_status,
              EXISTS (SELECT 1 FROM maint_approval_requests r
                       WHERE r.bill_id = b.id AND r.status = 'pending') AS pending_approval
         FROM maint_bills b
         JOIN maint_quarters q ON q.quarter = b.quarter
        WHERE b.flat = ? AND b.owner_id IN (${holders})
        ORDER BY b.quarter DESC`
    ).bind(flat, ...readers).all(),

    // Everything not yet issued, for "Coming up". Bounded rather than open —
    // a committee that drafts four quarters ahead should not turn the home
    // page into a calendar.
    env.DB.prepare(
      `SELECT quarter, status, issue_date, due_date
         FROM maint_quarters
        WHERE status IN ('draft','scheduled')
        ORDER BY quarter LIMIT 2`
    ).all(),

    env.DB.prepare(
      `SELECT paid_through, amount, approved_by FROM maint_advances
        WHERE flat = ? ORDER BY paid_through DESC`
    ).bind(flat).all(),

    env.DB.prepare(
      `SELECT ends_at, approved_by FROM voting_exemptions
        WHERE flat = ? ORDER BY ends_at DESC LIMIT 1`
    ).bind(flat).first(),
  ]);

  const rows = bills.results ?? [];
  const cards = rows.map((b) => shapeMaintBill(b, {
    due_date: b.quarter_due, late_fee: b.quarter_late_fee,
  }, today));

  return {
    cards,
    quarters: quarters.results ?? [],
    billedQuarters: rows.map((b) => b.quarter),
    advances: advances.results ?? [],
    // The vote is the OWNER's and the flat casts one. A tenant is shown nothing
    // here rather than a card saying they cannot vote: they never could, it is
    // not news, and it reads as a penalty for a rule that is not about them.
    voting: subject?.relationship === 'tenant' ? null : votingCard(flatVotingStatus({
      bills: rows,
      // No poll is open on the home page, so the question is asked as of today:
      // "could this flat vote if a poll opened now". A real poll re-asks it
      // against its own creation date, because a quarter that had not ended
      // when the poll opened must not start blocking mid-poll.
      pollCreatedAt: today,
      exemption,
      today,
    })),
  };
}
