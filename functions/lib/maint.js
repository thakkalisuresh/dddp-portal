/**
 * Quarterly maintenance charges. Pure arithmetic and pure decisions — no I/O,
 * so everything here is directly testable.
 *
 * THE RULE: maintenance is a FLAT RATE, not a measurement. Gas asks the meter
 * what a flat owes; maintenance asks only what kind of household lives there on
 * one particular day. Two numbers, one date, no readings.
 *
 * WHAT MAKES THIS DIFFERENT FROM lib/billing.js, and it is not a small thing:
 * every flat of the same kind is billed the SAME AMOUNT. Gas totals are
 * effectively unique per flat per month, and reconciliation leans on that — a
 * ₹329 credit on the bank statement belongs to whoever was billed ₹329.
 * Forty-one flats owing ₹9,000 have no such fingerprint. Nothing in this file
 * may assume an amount identifies a payer, and nothing downstream may either;
 * matching is on the screenshot reference and the payment narration.
 *
 * The other difference is WHO. A gas bill follows the meter, so it follows the
 * flat. A maintenance bill follows the occupant, and the occupant can change
 * in the middle of a quarter it has already been raised for. The rate is fixed
 * on the issue date and never recomputed; who carries the bill can move, and
 * moving it is a decision two admins make, not an arithmetic result.
 */

import { fail } from './errors.js';

/* ── the quarter ──────────────────────────────────────────────────────────
   Calendar quarters, always. Q1 is Jan–Mar, whatever the financial year does.
   The label is '2026-Q4' because it sorts correctly as a string, which is how
   every other period key in this schema earns its shape (see `periods.period`,
   '2026-06'). Residents never see that form — see describeQuarter.            */

export const QUARTER_MONTHS = { 1: [1, 3], 2: [4, 6], 3: [7, 9], 4: [10, 12] };

/** Month names as the building writes them, for the resident-facing label. */
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Split '2026-Q4' into { year: 2026, quarter: 4 }, or fail loudly. */
export function parseQuarter(label) {
  const m = /^(\d{4})-Q([1-4])$/.exec(String(label ?? ''));
  if (!m) fail('DDP-MAINT-001', { label });
  return { year: Number(m[1]), quarter: Number(m[2]) };
}

/** Is this a quarter label at all? For validating input without throwing. */
export function isQuarterLabel(label) {
  return /^\d{4}-Q[1-4]$/.test(String(label ?? ''));
}

const pad = (n) => String(n).padStart(2, '0');

/** The quarter a date falls in. '2026-11-14' -> '2026-Q4'. */
export function quarterOf(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  if (!m) fail('DDP-MAINT-002', { date });
  const month = Number(m[2]);
  if (month < 1 || month > 12) fail('DDP-MAINT-002', { date });
  return `${m[1]}-Q${Math.ceil(month / 3)}`;
}

/**
 * The first and last calendar day of a quarter, inclusive.
 *
 * The end date is computed as "day 0 of the month after the last month", which
 * is how JavaScript spells "the last day of that month" without a table of
 * month lengths and without a leap-year rule to get wrong.
 */
export function quarterRange(label) {
  const { year, quarter } = parseQuarter(label);
  const [first, last] = QUARTER_MONTHS[quarter];
  const end = new Date(Date.UTC(year, last, 0));   // day 0 = last day of `last`
  return {
    start: `${year}-${pad(first)}-01`,
    end: `${year}-${pad(last)}-${pad(end.getUTCDate())}`,
  };
}

/** The quarter before this one, crossing the year boundary. */
export function previousQuarter(label) {
  const { year, quarter } = parseQuarter(label);
  return quarter === 1 ? `${year - 1}-Q4` : `${year}-Q${quarter - 1}`;
}

/** The quarter after this one. */
export function nextQuarter(label) {
  const { year, quarter } = parseQuarter(label);
  return quarter === 4 ? `${year + 1}-Q1` : `${year}-Q${quarter + 1}`;
}

/**
 * "Q4 2026 (Oct–Dec)" — the only form a resident ever sees.
 *
 * An en dash, not a hyphen, because it is a range and the emails are HTML. The
 * label is built rather than stored so a quarter cannot end up described two
 * different ways in two different screens.
 */
export function describeQuarter(label) {
  const { year, quarter } = parseQuarter(label);
  const [first, last] = QUARTER_MONTHS[quarter];
  return `Q${quarter} ${year} (${MONTH_SHORT[first - 1]}–${MONTH_SHORT[last - 1]})`;
}

/**
 * Has this quarter finished?
 *
 * Load-bearing for the voting rule: only an ENDED quarter's unpaid bill blocks
 * a vote, so this is the line between "you are behind" and "you have not been
 * given your ten days yet". Compared as strings, which is safe because both
 * sides are ISO dates and ISO dates sort chronologically.
 */
export function quarterHasEnded(label, today) {
  return String(today) > quarterRange(label).end;
}

/* ── rates and who pays ───────────────────────────────────────────────────
   ₹7,500 owner-occupied, ₹9,000 rented, ₹750 late fee. Held here as the
   defaults a new quarter is BORN with — never as the figures a bill is
   computed from. Every bill snapshots the rate it was raised at, exactly as
   `bills.rate_per_kg` does, because a committee that revises the rate must not
   silently revise last year's bills too.                                     */

export const DEFAULT_OWNER_RATE = 7500;
export const DEFAULT_TENANT_RATE = 9000;
export const DEFAULT_LATE_FEE = 750;

/** Days from issue to due. The committee's figure, and the same for every quarter. */
export const DUE_DAYS = 10;

/**
 * Is this person in residence on `date`?
 *
 * LEASE_ENDS_AT IS DELIBERATELY NOT CONSULTED HERE, and a later reader will
 * want to "fix" that. Do not. The rate follows the ACTIVE TENANT ROW alone.
 *
 * An expired lease with the tenant still living there is the common case in
 * this building — leases lapse and roll on for months before anybody files
 * anything — so treating an expired date as "no tenant" would bill ₹7,500 for
 * a flat that is rented and lose the association ₹1,500 a quarter on every one
 * of them. The date is a data-quality signal, not an occupancy fact:
 * `tenancyReadiness` raises it for a human to resolve BEFORE the quarter is
 * scheduled, which is the right place for it, because a person can tell the
 * difference between a lapsed lease and a departed tenant and this function
 * cannot.
 *
 * Departure has exactly one spelling, and it is the one that has always
 * existed: `active = 0`, set by an admin, with `moved_out_at` recording when.
 */
export function isResidentOn(person, date) {
  if (!person?.active) return false;
  const on = String(date);
  if (person.moved_in_at && String(person.moved_in_at).slice(0, 10) > on) return false;
  if (person.moved_out_at && String(person.moved_out_at).slice(0, 10) <= on) return false;
  return true;
}

/** The tenant in residence on a date, lowest id first. Null if the flat is not let. */
export function tenantOn(people, date) {
  return (people ?? [])
    .filter((p) => p.relationship === 'tenant' && isResidentOn(p, date))
    .sort((a, b) => a.id - b.id)[0] ?? null;
}

/**
 * The owner on record on a date, lowest id first.
 *
 * Lowest id rather than "whichever the query returned", matching occupantOf in
 * lib/tenancy.js: with three owners on a jointly held flat this decides whose
 * name the bill carries, and an unordered SELECT would move it between
 * quarters. Their whole household sees it either way.
 *
 * An owner is on record whether or not they live here — a landlord has not
 * moved out of their own flat, they have let it — so `moved_out_at` is the only
 * thing that removes them, and a lease end date is not consulted for owners.
 */
export function ownerOn(people, date) {
  return (people ?? [])
    .filter((p) => p.relationship === 'owner' && isResidentOn(p, date))
    .sort((a, b) => a.id - b.id)[0] ?? null;
}

/**
 * Which rate a flat takes, and who carries the bill, ON THE ISSUE DATE.
 *
 * One date decides both, and it is the issue date rather than "today" or the
 * quarter's first day, because that is the moment the committee fixed when
 * they scheduled the quarter. A flat let on 3 October is rented for Q4 even
 * though the quarter began on the 1st; a tenant who leaves on 4 October does
 * not turn Q4 back into an owner quarter by arithmetic — that is a re-rate,
 * which two admins decide (see planOccupancyChange).
 *
 * NO REGISTERED OWNER MEANS NO BILL. The builder still holds unsold flats, and
 * a bill raised against nobody is a debt the association cannot collect and a
 * line on a dues report that never clears. `tenant-no-owner` is called out
 * separately from `none` because it is a data fault, not an empty flat: somebody
 * is living there and the association has no counterparty. diagnostics has
 * warned about exactly that state since the tenancy work landed.
 */
export function assessFlat({ flat, people, issueDate }) {
  const tenant = tenantOn(people, issueDate);
  const owner = ownerOn(people, issueDate);

  if (!owner) {
    return {
      flat,
      bill: false,
      basis: null,
      billedTo: null,
      owner: null,
      reason: tenant ? 'tenant-no-owner' : 'no-owner',
    };
  }

  return {
    flat,
    bill: true,
    // The BASIS is the kind of household, and it is what gets snapshotted on
    // the bill. Not "is there a tenant right now" — that question has a
    // different answer by December.
    basis: tenant ? 'tenant' : 'owner',
    // WHO IS BILLED is the tenant when there is one. The owner still sees the
    // bill and can pay it: they are liable for it, which is the whole reason
    // billAccess in lib/tenancy.js shows a landlord amounts without proofs.
    billedTo: tenant ?? owner,
    owner,
    reason: tenant ? 'tenanted' : 'owner-occupied',
  };
}

/**
 * The amount for a basis, read from the quarter rather than from the constants
 * above. Rates are editable per quarter and the quarter row is the record of
 * what the committee actually set.
 */
export function rateFor(basis, quarter) {
  const rate = basis === 'tenant' ? quarter?.tenant_rate : quarter?.owner_rate;
  if (basis !== 'tenant' && basis !== 'owner') fail('DDP-MAINT-003', { basis });
  if (!Number.isFinite(rate) || rate <= 0) fail('DDP-MAINT-004', { basis, quarter: quarter?.quarter });
  // Whole rupees, for the same reason `periods` and `bills` both CHECK it: a
  // fee carrying paise dies at the database as a 500 rather than a message.
  if (Math.round(rate * 100) % 100 !== 0) fail('DDP-MAINT-004', { basis, rate });
  return rate;
}

/**
 * What a quarter will actually bill, computed BEFORE anything is written —
 * the maintenance twin of previewGeneration in lib/billing.js, and it earns
 * its place for the same reason: the treasurer confirms one number they can
 * check, rather than discovering the mistake in ninety-nine emails.
 *
 * `rows` are { flat, people }.
 */
export function previewQuarter({ rows, quarter, issueDate }) {
  const bills = [];
  const skipped = [];

  for (const row of rows) {
    const assessment = assessFlat({ flat: row.flat, people: row.people, issueDate });
    if (!assessment.bill) {
      skipped.push({ flat: row.flat, reason: assessment.reason });
      continue;
    }
    bills.push({
      flat: row.flat,
      basis: assessment.basis,
      rate: rateFor(assessment.basis, quarter),
      billedTo: assessment.billedTo.id,
      ownerId: assessment.owner.id,
    });
  }

  const tenanted = bills.filter((b) => b.basis === 'tenant');

  return {
    quarter: quarter?.quarter ?? null,
    issueDate,
    dueDate: dueDateFor(issueDate),
    willBill: bills.length,
    bills,
    skipped,
    ownerCount: bills.length - tenanted.length,
    tenantCount: tenanted.length,
    total: bills.reduce((sum, b) => sum + b.rate, 0),
    // Surfaced on its own because it is the number the committee is least sure
    // of and the one that moves the total most: the rented count has never been
    // audited against the roster, and each flat in it is ₹1,500 more.
    tenantedFlats: tenanted.map((b) => b.flat),
    // A flat with somebody living in it and no owner on record is not a quiet
    // skip. It is the only kind of skip a human must resolve before issuing.
    unresolved: skipped.filter((s) => s.reason === 'tenant-no-owner'),
  };
}

/* ── dates ────────────────────────────────────────────────────────────────  */

/** Due ten days after issue. Issued 1 Oct, due the 11th. */
export function dueDateFor(issueDate, days = DUE_DAYS) {
  const d = new Date(`${String(issueDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) fail('DDP-MAINT-002', { issueDate });
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The day the late fee lands: the day AFTER the due date.
 *
 * Deliberately NOT the gas rule. lib/billing.js charges ON the due date at
 * 00:00, because the committee's gas rule is that payment must be complete
 * before the due date begins. The maintenance rule as stated is "the day after
 * the due date", which makes the due date itself a payable day. Two different
 * rules, stated differently by the same committee, and the safe thing is to
 * implement each as written rather than harmonise them here — so this is its
 * own function and its own decision below, not a call into lateFeeDecision.
 */
export function lateFeeDateFor(dueDate) {
  return dueDateFor(dueDate, 1);
}

/* ── settlement ───────────────────────────────────────────────────────────  */

/**
 * The statuses that mean the association has its money, or has agreed it never
 * will. Everything else is outstanding.
 *
 * `initiated` (tapped Pay) and `awaiting` (screenshot under review) are NOT
 * here, and that is the point: both are claims by the payer, and a claim the
 * treasurer has not confirmed cannot settle a bill. Gas learned this the hard
 * way — see CLAIM_HOLD_DAYS in lib/billing.js, where an unbounded hold on
 * `initiated` was an exemption anybody could grant themselves by tapping a
 * button.
 */
export const SETTLED_STATUSES = ['paid', 'waived', 'cancelled'];

export function isSettled(bill) {
  return SETTLED_STATUSES.includes(bill?.status);
}

/**
 * Should this bill be charged a late fee today?
 *
 * The same shape as lateFeeDecision in lib/billing.js, and the same
 * idempotency guard, because the cron that calls it runs nightly and
 * Cloudflare may invoke it twice. `late_fee_at IS NULL` is the guard.
 *
 * ONCE PER QUARTER, never compounding. There is no second fee in week three;
 * the committee asked for one ₹750 and this returns `already-applied` forever
 * after.
 */
export function maintLateFeeDecision(bill, { today, dueDate, exemptUntil = null }) {
  if (bill.late_fee_at) return { action: 'skip', reason: 'already-applied' };
  if (isSettled(bill)) return { action: 'skip', reason: 'settled' };

  // An approval in flight freezes the clock, exactly as a pending gas edit
  // does. A rate switch or a waiver needs two admins to agree and they are
  // allowed to take their time; the resident is not late because the committee
  // is deliberating, and a fee applied mid-deliberation needs its own waiver on
  // top to remove.
  if (bill.pending_approval) return { action: 'skip', reason: 'approval-pending' };

  // Nothing owed is not late. A cancelled or zero bill sailing past the guards
  // above would be charged ₹750 for owing nothing — the gas twin of this line
  // was added after exactly that happened to vacant flats.
  if (!(Number(bill.total) > 0)) return { action: 'skip', reason: 'nothing-owed' };

  // Checked before the due date so the recorded reason is the real one —
  // "exempt" rather than "not yet due". Inclusive of the end date.
  if (exemptUntil && String(today) <= String(exemptUntil)) {
    return { action: 'skip', reason: 'exempt' };
  }

  // THE DAY AFTER THE DUE DATE — see lateFeeDateFor for why this is `<` against
  // a cutoff one day later rather than the gas rule.
  if (String(today) < lateFeeDateFor(dueDate)) return { action: 'skip', reason: 'not-yet-due' };

  return { action: 'charge', reason: 'overdue' };
}

/** Add the fee to a total. Whole rupees in, whole rupees out. */
export function applyMaintLateFee(currentTotal, lateFee) {
  if (!Number.isFinite(lateFee) || lateFee < 0 || Math.round(lateFee * 100) % 100 !== 0) {
    fail('DDP-MAINT-005', { lateFee });
  }
  if (!Number.isFinite(currentTotal) || currentTotal < 0) {
    fail('DDP-MAINT-005', { currentTotal });
  }
  return currentTotal + lateFee;
}

/* ── advances ─────────────────────────────────────────────────────────────
   A resident who pays a year up front. Recorded by an admin, approved by a
   second one, and stored as the quarter it reaches rather than as an amount to
   be drawn down — because a balance that decrements is a second ledger that can
   disagree with the bills, and "paid up to 2027-Q3" cannot.                   */

/**
 * Does this advance cover that quarter?
 *
 * Inclusive of the named quarter: "paid up to 2027-Q2" means Q2 is covered,
 * which is how a resident writing the cheque understands it. String comparison
 * is exact here because the label sorts chronologically — '2026-Q4' < '2027-Q1'
 * — which is the reason the label has that shape.
 */
export function advanceCovers(advance, label) {
  if (!advance?.paid_through) return false;
  if (!isQuarterLabel(advance.paid_through) || !isQuarterLabel(label)) return false;
  // An advance that has not been approved has not been banked. It is one
  // admin's assertion until a second agrees, and treating it as payment would
  // make "record an advance" a way for one person to clear a flat's dues.
  if (!advance.approved_by) return false;
  return String(label) <= String(advance.paid_through);
}

/** The best advance on a flat — the one reaching furthest forward. */
export function furthestAdvance(advances) {
  return (advances ?? [])
    .filter((a) => a.approved_by && isQuarterLabel(a.paid_through))
    .sort((a, b) => String(b.paid_through).localeCompare(String(a.paid_through)))[0] ?? null;
}

/* ── voting ───────────────────────────────────────────────────────────────
   Arrears block a flat's vote. The rule is narrow on purpose and every edge of
   it was decided rather than defaulted, so each one is stated here.           */

/**
 * May this flat vote in a poll created on this date?
 *
 * ONE VOTE PER FLAT, AND IT IS THE OWNER'S. Tenants read polls and do not vote
 * (see show_tenants in migration 0036). The consequence is uncomfortable and
 * was accepted deliberately: a TENANT'S unpaid maintenance costs the OWNER
 * their vote. The owner is liable for the flat's maintenance, so the arrears
 * are theirs in the sense that matters — but the person who can fix it and the
 * person who loses the vote may be two different people, and the owner has no
 * way to see it coming except by watching their own dues screen.
 *
 * FOUR THINGS DO NOT BLOCK, and each was asked and answered:
 *   - the CURRENT quarter, ever. A bill issued on the 1st cannot cost anybody a
 *     vote on the 3rd, and even after its due date passes it is this quarter's
 *     business. Only a quarter that has ENDED counts.
 *   - GAS arrears. Different account, different cadence, and a monthly bill of
 *     a few hundred rupees is not the thing this rule is about.
 *   - a bill under an approval in flight, for the same reason it freezes the
 *     late-fee clock.
 *   - an exemption the committee granted, which overrides everything below.
 *
 * The block LIFTS MID-POLL, the moment the treasurer confirms payment, because
 * this is evaluated on read rather than stamped onto the poll. A flat that pays
 * on Tuesday votes on Tuesday.
 *
 * Blocked flats stay in the turnout denominator — they are entitled voters who
 * are barred, not absent ones — but that is the caller's sum, not this
 * function's.
 */
export function flatVotingStatus({ bills, pollCreatedAt, exemption = null, today = pollCreatedAt }) {
  // The exemption is checked first so the reason reported is the real one. An
  // exempt flat that also happens to owe nothing should still read as exempt to
  // an admin looking at why it can vote.
  if (exemption && isVotingExemptOn(exemption, today)) {
    return { canVote: true, reason: 'exempt', owed: 0, quarters: [] };
  }

  const blocking = (bills ?? []).filter((bill) => {
    if (isSettled(bill)) return false;
    if (bill.pending_approval) return false;
    if (!isQuarterLabel(bill.quarter)) return false;
    // ENDED before the poll was created. A poll created on 2 January is asked
    // about Q4, which ended on 31 December; Q1 has not ended and never counts.
    return quarterHasEnded(bill.quarter, pollCreatedAt);
  });

  if (!blocking.length) return { canVote: true, reason: 'clear', owed: 0, quarters: [] };

  // A CLAIM DOES NOT UNLOCK THE VOTE, BUT IT CHANGES WHAT THE CARD SAYS.
  //
  // `initiated` and `awaiting` still block — only the treasurer's confirmation
  // lifts it, and a screenshot anybody can upload must not be a key to the
  // ballot. But telling someone who has paid and uploaded proof that their
  // maintenance is unpaid is both wrong and inflammatory, and they are exactly
  // the resident most likely to be angry about it. So the block is the same and
  // the sentence is different.
  const claimed = blocking.some((b) => b.status === 'initiated' || b.status === 'awaiting');

  return {
    canVote: false,
    reason: claimed ? 'arrears-claimed' : 'arrears',
    // PLACEHOLDER. Every resident-visible string in this feature goes to the
    // committee in the wording pass before testing; these two are drafts so the
    // slot exists and the card can be built against it.
    message: claimed
      ? 'Your payment is with the treasurer. Your vote unlocks as soon as it is confirmed.'
      : 'This flat has maintenance outstanding from a closed quarter.',
    // Shown on the poll itself, beside a Pay button, because a block with no
    // number attached is a dead end rather than something a resident can act on.
    owed: blocking.reduce((sum, b) => sum + Number(b.total ?? 0), 0),
    quarters: blocking.map((b) => b.quarter).sort(),
  };
}

/**
 * A committee-granted exemption from the voting block, with an end date for the
 * same reason the late-fee exemption has one: a boolean set during a dispute is
 * invisible policy two years later, and an end date makes forgetting a no-op.
 * Inclusive of the end date.
 */
export function isVotingExemptOn(exemption, date) {
  if (!exemption) return false;
  // Ungranted or unapproved is not an exemption. Two admins agree, as with
  // every other maintenance decision that moves money or rights.
  if (!exemption.approved_by) return false;
  if (!exemption.ends_at) return true;   // open-ended, granted deliberately
  return String(date) <= String(exemption.ends_at);
}

/* ── mid-quarter occupancy changes ────────────────────────────────────────
   The bill is already raised and the household changes underneath it. Three
   cases, decided 2026-09-17, and none of them is an automatic write: each
   returns a PLAN for two admins to approve, in the same spirit as planDeparture
   in lib/tenancy.js — the debt is a conversation between people and a
   committee, not a database write made while nobody is looking.               */

/**
 * What happens to an outstanding maintenance bill when the occupancy changes.
 *
 * `change` is 'tenant-to-owner' (the tenant left, the owner moved in),
 * 'tenant-to-tenant' (one tenant replaced by another) or 'owner-to-tenant'.
 */
export function planOccupancyChange({ bill, change, quarter, owner, incomingTenant = null }) {
  // ALREADY PAID IS CLOSED. No refund, no re-rate, no proration — the quarter
  // was billed at the rate that was true on the issue date and the money is in
  // the account. Reopening a settled bill to hand back ₹1,500 is a new class of
  // work (refunds) that this system does not do and was not asked to.
  if (isSettled(bill)) {
    return { action: 'none', reason: 'settled', needsApproval: false, emailsTo: owner ? [owner.id] : [] };
  }

  if (change === 'tenant-to-owner') {
    const newRate = rateFor('owner', quarter);
    return {
      action: 're-rate',
      // Down from ₹9,000 to ₹7,500 and across to the owner, in one decision
      // rather than two: a bill that changes hands at the old rate, or changes
      // rate while still addressed to someone who has left, is a half-finished
      // state somebody has to notice and finish.
      basis: 'owner',
      rate: newRate,
      total: newRate,
      billedTo: owner?.id ?? null,
      // The bill's owner_id MOVES, and the old one is kept beside it.
      //
      // Moving it is not optional: owner_id is what scopes who can see a bill,
      // so a bill left pointing at the departed tenant simply does not appear on
      // the owner's screen — they would be liable for something invisible to
      // them. Keeping the old id is not optional either: a bill that silently
      // changes hands is one nobody can audit, and "why is this ₹7,500 when the
      // quarter was issued at ₹9,000" needs an answer with a name in it.
      reassignedFrom: bill?.owner_id ?? null,
      needsApproval: true,
      reason: 'tenant-left-owner-moved-in',
      emailsTo: owner ? [owner.id] : [],
    };
  }

  if (change === 'tenant-to-tenant') {
    return {
      // STAYS AT ₹9,000. The flat is still let; only the person changed. The
      // rate was fixed on the issue date and nothing about this change touches
      // the kind of household.
      action: 'reassign',
      basis: 'tenant',
      rate: Number(bill?.rate_applied ?? rateFor('tenant', quarter)),
      // Deliberately NULL. Who carries a bill raised against a tenant who has
      // left — the departing tenant, the incoming one, or the owner — is not
      // something arithmetic can answer, and guessing it puts somebody else's
      // debt on a person's screen. An admin picks, and a second approves.
      billedTo: null,
      choices: [owner?.id, incomingTenant?.id].filter(Boolean),
      reassignedFrom: bill?.owner_id ?? null,
      needsApproval: true,
      reason: 'tenant-replaced',
      emailsTo: owner ? [owner.id] : [],
    };
  }

  if (change === 'owner-to-tenant') {
    return {
      // NOT re-rated upward. A flat let in November was owner-occupied when the
      // quarter was issued, and the rate is fixed for that quarter — the same
      // rule that keeps a flat let on 3 October rented for all of Q4. The
      // ₹9,000 starts next quarter.
      action: 'none',
      reason: 'rate-fixed-for-quarter',
      needsApproval: false,
      emailsTo: owner ? [owner.id] : [],
    };
  }

  fail('DDP-MAINT-006', { change });
}

/**
 * Can this quarter be scheduled, or is the tenancy data too stale to trust?
 *
 * The rate a flat takes depends entirely on whether a tenant row is active, and
 * until now nothing in the portal could tell an active tenant from one who left
 * eight months ago without anybody flipping the flag. Scheduling a quarter is
 * the moment that stops being harmless: it fixes ninety-nine rates at once.
 *
 * A WARNING, NOT A REFUSAL, on missing dates. Most rows will have no lease end
 * date until the roster is filled in, and refusing to bill the building until
 * every one is entered would miss the quarter. An EXPIRED lease is different —
 * it is a positive statement that somebody has gone — and that one blocks.
 */
export function tenancyReadiness({ rows, issueDate }) {
  const expired = [];
  const undated = [];

  for (const row of rows ?? []) {
    for (const p of row.people ?? []) {
      if (p.relationship !== 'tenant' || !p.active) continue;
      if (p.lease_ends_at && String(p.lease_ends_at).slice(0, 10) < String(issueDate)) {
        expired.push({ flat: row.flat, id: p.id, name: p.name, lease_ends_at: p.lease_ends_at });
      } else if (!p.lease_ends_at) {
        undated.push({ flat: row.flat, id: p.id, name: p.name });
      }
    }
  }

  return {
    expired,
    undated,
    ok: expired.length === 0,
    // Separated so the admin screen can say the two different sentences. An
    // expired lease means "this flat is about to be billed ₹9,000 for a tenant
    // the record says has left"; an undated one means "nobody has told us when
    // this lease ends".
    message: expired.length
      ? `${expired.length} tenant${expired.length === 1 ? '' : 's'} on record with a lease that ended before the issue date. `
        + 'Confirm or close each one before scheduling — otherwise their flats are billed at the rented rate.'
      : null,
  };
}
