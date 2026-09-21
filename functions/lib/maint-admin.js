/**
 * The admin side of maintenance — step 6.
 *
 * Four steps down one page: the rates for the quarter, which flats are billed,
 * schedule, collect. NOT A WIZARD. Every step stays reachable and revisitable,
 * and a finished one shows its result rather than its form. The gas readings
 * screen learned that lesson already: a stepper that traps an admin in order is
 * a stepper they work around.
 *
 * The pure parts are here and tested; the queries assemble them. The flags in
 * step 2 are the part that matters most, because they are what stands between
 * the committee and ninety-nine bills at the wrong rate.
 */

import { istToday } from './time.js';
import {
  previewQuarter, tenancyReadiness, dueDateFor, lateFeeDateFor, describeQuarter,
  quarterOf, nextQuarter, isQuarterLabel, isSettled,
} from './maint.js';
import { flatsWithPeople, DRAFT_LEAD_DAYS } from './maint-cron.js';
import { approvalPolicy, canApprove } from './approvals.js';
import { ADVANCE_KIND, mergeAdvancesView } from './maint-approvals.js';

/**
 * How long a tenancy may go unchecked before it is flagged.
 *
 * Two years, which is one standard lease term in Kerala plus a renewal. The
 * point is not that a tenancy goes stale on a schedule; it is that a record
 * nobody has looked at since it was typed is a record nobody has checked, and
 * the flat is billed ₹1,500 a quarter more on the strength of it.
 */
export const UNCHECKED_DAYS = 730;

/* ── step 2 · the tenancy check ───────────────────────────────────────────  */

/**
 * Every tenancy on record, with the one thing wrong with it.
 *
 * ONE FLAG PER ROW, the most serious. A tenant whose lease ended AND who was
 * last confirmed three years ago has one problem from the admin's point of
 * view — this record is not trustworthy — and two badges on the row would make
 * them read it twice to learn the same thing.
 *
 * The flags, in the order they are chosen:
 *
 *   lease-ended    the lease ended before the issue date. This flat is about to
 *                  be billed at the rented rate for a tenant the record itself
 *                  says has left.
 *   missing-date   no lease end on record, so nothing will ever flag it again.
 *   unchecked      nobody has confirmed this tenancy in UNCHECKED_DAYS.
 *   current        confirmed, dated, and the date has not passed.
 *
 * ONLY `current` DOES NOT BLOCK. See schedulingBlocked.
 */
export function tenancyRows({ rows, issueDate, today = istToday() }) {
  const out = [];

  for (const row of rows ?? []) {
    for (const p of row.people ?? []) {
      if (p.relationship !== 'tenant' || !p.active) continue;

      const leaseEnd = p.lease_ends_at ? String(p.lease_ends_at).slice(0, 10) : null;
      const confirmed = p.tenancy_confirmed_at
        ? String(p.tenancy_confirmed_at).slice(0, 10) : null;

      let flag = 'current';
      if (leaseEnd && leaseEnd < String(issueDate)) flag = 'lease-ended';
      else if (!leaseEnd) flag = 'missing-date';
      else if (!confirmed || daysBetween(confirmed, today) > UNCHECKED_DAYS) flag = 'unchecked';

      out.push({
        flat: row.flat,
        id: p.id,
        name: p.name,
        since: p.moved_in_at ?? null,
        leaseEndsAt: leaseEnd,
        confirmedAt: confirmed,
        flag,
        // "Ended 94 days ago" rather than a date the admin has to subtract from
        // today. The number is the thing that makes it feel urgent or not.
        endedDaysAgo: flag === 'lease-ended' ? daysBetween(leaseEnd, today) : null,
        uncheckedDays: confirmed ? daysBetween(confirmed, today) : null,
      });
    }
  }

  // Worst first, then by flat, so the rows that block scheduling are the rows
  // at the top of the table rather than scattered through it.
  const rank = { 'lease-ended': 0, 'missing-date': 1, unchecked: 2, current: 3 };
  return out.sort((a, b) => (rank[a.flag] - rank[b.flag])
    || String(a.flat).localeCompare(String(b.flat)));
}

/**
 * The flags that stop a quarter being scheduled.
 *
 * FLAGGED ROWS BLOCK, and that is the whole point of step 2 rather than a
 * strictness anybody chose for its own sake: the user's instruction was that
 * the quarter cannot be scheduled without the flags being looked at, and
 * "looked at" means each one resolved or explicitly confirmed — not that a
 * warning was displayed and scrolled past.
 *
 * The way to clear a row is to fix the RECORD: confirm the tenancy, add the
 * lease end, or record that they moved out. There is deliberately no override
 * that says "bill at the owner rate anyway", because that produces a bill whose
 * reason lives nowhere.
 */
export function schedulingBlocked(rows) {
  const blocking = (rows ?? []).filter((r) => r.flag !== 'current');
  return {
    blocked: blocking.length > 0,
    count: blocking.length,
    flats: [...new Set(blocking.map((r) => r.flat))],
    byFlag: {
      'lease-ended': blocking.filter((r) => r.flag === 'lease-ended').length,
      'missing-date': blocking.filter((r) => r.flag === 'missing-date').length,
      unchecked: blocking.filter((r) => r.flag === 'unchecked').length,
    },
  };
}

/* ── step 3 · what scheduling will do ─────────────────────────────────────  */

/**
 * The consequences of an issue date, computed before anybody commits to one.
 *
 * The due date and the late-fee date are DERIVED and shown together, because
 * the gas screens have already taught residents to misread them as the same
 * day. The fee lands the day AFTER the due date (lateFeeDateFor), and saying
 * both here is what stops that confusion being inherited by a screen built
 * afterwards.
 */
export function scheduleConsequences({ issueDate, preview }) {
  const dueDate = dueDateFor(issueDate);
  return {
    issueDate,
    dueDate,
    lateFeeDate: lateFeeDateFor(dueDate),
    willBill: preview?.willBill ?? 0,
    total: preview?.total ?? 0,
    tenantCount: preview?.tenantCount ?? 0,
    ownerCount: preview?.ownerCount ?? 0,
  };
}

/* ── step 4 · collect ─────────────────────────────────────────────────────  */

/**
 * Where the quarter's money has got to.
 *
 * `lateFeeTonight` answers the question an admin asks on the due date, and it
 * is worded from when the job actually runs rather than from the due date
 * itself: the fee is charged after midnight, so on the due date the truthful
 * line is that it lands tonight. The count and the money are both here because
 * the next question after "tonight" is always "how much".
 */
export function collectFigures({ bills, quarter, today = istToday() }) {
  const live = (bills ?? []).filter((b) => b.status !== 'cancelled');

  const paid = live.filter((b) => b.status === 'paid' || b.status === 'waived');
  const checking = live.filter((b) => b.status === 'initiated' || b.status === 'awaiting');
  const unpaid = live.filter((b) => b.status === 'unpaid');

  // Tonight's sweep charges every unpaid bill that has passed its due date and
  // has not been charged already. `pending_approval` freezes the clock, exactly
  // as maintLateFeeDecision does, so a frozen bill must not be counted here or
  // the figure promises money that will not arrive.
  const dueTonight = live.filter((b) =>
    !isSettled(b) && !b.late_fee_at && !b.pending_approval
    && Number(b.total) > 0
    && String(today) >= String(quarter?.due_date ?? '9999-12-31'));

  const fee = Number(quarter?.late_fee ?? 0);

  return {
    paid: paid.length,
    paidAmount: sum(paid),
    checking: checking.length,
    checkingAmount: sum(checking),
    unpaid: unpaid.length,
    unpaidAmount: sum(unpaid),
    lateFeeTonight: dueTonight.length
      ? { bills: dueTonight.length, each: fee, total: dueTonight.length * fee }
      : null,
  };
}

/* ── the dues report ──────────────────────────────────────────────────────  */

/**
 * Who owes what — GAS AND MAINTENANCE, SEPARATELY AND NEVER ADDED.
 *
 * THIS SHAPE IS THE RULE. There is no combined figure in this return value and
 * none may be added: gas is monthly and maintenance is quarterly, they settle
 * into two different bank accounts, and a total across them is a number that
 * reconciles against nothing and misleads whoever reads it. The user rejected a
 * combined per-flat table with a total column, and rejected a single "you owe"
 * figure on the resident's home page, for the same reason.
 *
 * Two blocks, each with its own figures, its own rows and its own export. If
 * you are here to add `grandTotal`, that is the decision you are reversing, and
 * test/maint-admin.test.js will stop you.
 */
export async function duesReport(env, { today = istToday() } = {}) {
  const [gas, maint] = await Promise.all([
    env.DB.prepare(
      `SELECT b.id, b.flat, b.period, b.total, b.status, b.late_fee, p.due_date,
              o.name AS billed_to
         FROM bills b
         JOIN periods p ON p.period = b.period
         LEFT JOIN owners o ON o.id = b.owner_id
        WHERE b.status NOT IN ('paid','waived')
        ORDER BY p.due_date, b.flat`
    ).all(),

    env.DB.prepare(
      `SELECT b.id, b.flat, b.quarter, b.total, b.status, b.late_fee, b.basis,
              q.due_date, o.name AS billed_to
         FROM maint_bills b
         JOIN maint_quarters q ON q.quarter = b.quarter
         LEFT JOIN owners o ON o.id = b.owner_id
        WHERE b.status NOT IN ('paid','waived','cancelled')
        ORDER BY q.due_date, b.flat`
    ).all(),
  ]);

  return {
    today,
    // Named per block rather than per report, so neither block's figures can be
    // mistaken for the other's, and so a template cannot reach for a number
    // that spans both.
    gas: block(gas.results ?? [], today, 'month'),
    maintenance: block(maint.results ?? [], today, 'quarter'),
  };
}

function block(rows, today, cadence) {
  const overdue = rows.filter((r) => r.due_date && String(today) >= String(r.due_date));
  return {
    cadence,
    count: rows.length,
    // The block's OWN total. Correct within one account and meaningless across
    // two, which is why it lives in here rather than beside its twin.
    outstanding: sum(rows),
    overdueCount: overdue.length,
    overdueAmount: sum(overdue),
    rows: rows.map((r) => ({
      id: r.id,
      flat: r.flat,
      period: r.period ?? r.quarter,
      periodLabel: r.quarter ? describeQuarter(r.quarter) : r.period,
      billedTo: r.billed_to ?? null,
      basis: r.basis ?? null,
      total: r.total,
      lateFee: r.late_fee,
      status: r.status,
      dueDate: r.due_date ?? null,
      overdue: Boolean(r.due_date && String(today) >= String(r.due_date)),
    })),
  };
}

/* ── the page ─────────────────────────────────────────────────────────────  */

/**
 * Everything the Maintenance page needs, for one quarter.
 *
 * ONE ROUND TRIP. The page has four steps and three panels, and fetching them
 * separately would mean an admin watching a screen assemble itself in pieces
 * while deciding whether to bill ninety-nine flats.
 */
export async function maintAdminPayload(env, quarterLabel, { today = istToday(), session = null } = {}) {
  const label = isQuarterLabel(quarterLabel) ? quarterLabel : await workingQuarter(env, today);
  if (!label) return null;

  const quarter = await env.DB.prepare(
    // The scheduler's NAME, joined here rather than left as an id: the receipt
    // says who committed the building to this, and "scheduled by 4" is not an
    // answer to that question.
    `SELECT q.*, o.name AS scheduled_by_name
       FROM maint_quarters q
       LEFT JOIN owners o ON o.id = q.scheduled_by
      WHERE q.quarter = ?`
  ).bind(label).first();

  const previousLabel = previousOf(label);
  const previous = await env.DB.prepare(
    'SELECT quarter, owner_rate, tenant_rate, late_fee FROM maint_quarters WHERE quarter = ?'
  ).bind(previousLabel).first();

  const issueDate = quarter?.issue_date ?? defaultIssueDate(label);
  const rows = await flatsWithPeople(env);

  const tenancies = tenancyRows({ rows, issueDate, today });
  const blocked = schedulingBlocked(tenancies);

  // The preview needs rates. A quarter with none yet cannot be previewed, and
  // that is a state the page renders rather than an error it throws — step 1 is
  // where the admin fixes it and they have not been there yet.
  let preview = null;
  if (quarter?.owner_rate && quarter?.tenant_rate) {
    try {
      preview = previewQuarter({ rows, quarter, issueDate });
      // NAMES, not ids. previewQuarter answers in ids because that is what the
      // bills carry, but "Billed to #1" is not something an admin can check
      // against anything — and the whole purpose of step 2 is checking. The
      // names come from the rows we already have rather than a second query.
      const nameOf = new Map();
      for (const row of rows) {
        for (const person of row.people ?? []) nameOf.set(person.id, person.name);
      }
      preview.bills = preview.bills.map((bill) => ({
        ...bill,
        billedToName: nameOf.get(bill.billedTo) ?? null,
        ownerName: nameOf.get(bill.ownerId) ?? null,
      }));
    } catch {
      // A flat with a rate this quarter cannot price is a step 1 problem. The
      // page should still draw, with the preview absent and step 1 open.
      preview = null;
    }
  }

  const bills = quarter ? (await env.DB.prepare(
    `SELECT b.*, EXISTS (SELECT 1 FROM maint_approval_requests r
                          WHERE r.bill_id = b.id AND r.status = 'pending') AS pending_approval
       FROM maint_bills b WHERE b.quarter = ?`
  ).bind(label).all()).results ?? [] : [];

  const [advances, feeExemptions, voteExemptions, approvals, quarters] = await Promise.all([
    env.DB.prepare(
      `SELECT a.*, r.name AS recorded_by_name, p.name AS approved_by_name,
              o.name AS resident, c.name AS cancelled_by_name
         FROM maint_advances a
         LEFT JOIN owners r ON r.id = a.recorded_by
         LEFT JOIN owners p ON p.id = a.approved_by
         LEFT JOIN owners o ON o.id = a.owner_id
         LEFT JOIN owners c ON c.id = a.cancelled_by
        ORDER BY a.paid_through DESC, a.flat`
    ).all(),

    env.DB.prepare(
      `SELECT e.*, o.name AS resident, o.flat AS flat
         FROM maint_fee_exemptions e JOIN owners o ON o.id = e.owner_id
        ORDER BY e.ends_at DESC`
    ).all(),

    env.DB.prepare(
      'SELECT * FROM voting_exemptions ORDER BY COALESCE(ends_at, \'9999\') DESC'
    ).all(),

    env.DB.prepare(
      `SELECT r.*, o.name AS requested_by_name
         FROM maint_approval_requests r
         LEFT JOIN owners o ON o.id = r.requested_by
        WHERE r.status = 'pending'
        ORDER BY r.id`
    ).all(),

    env.DB.prepare(
      'SELECT quarter, status FROM maint_quarters ORDER BY quarter DESC LIMIT 12'
    ).all(),
  ]);

  // ── the advances panel and the approvals queue, enriched ────────────────
  // Names and people come off the rows already in hand — no extra query — so the
  // Flat and Paid-by pickers can show "2B — Suresh" and the merged advances
  // table can name the payer without a second round trip.
  const nameById = new Map();
  const flatPeople = [];
  for (const row of rows) {
    const active = (row.people ?? [])
      .filter((p) => p.active)
      .map((p) => ({ id: p.id, name: p.name, relationship: p.relationship }));
    for (const p of active) nameById.set(p.id, p.name);
    flatPeople.push({ flat: row.flat, people: active });
  }

  const allApprovals = approvals.results ?? [];
  const advanceRows = advances.results ?? [];

  // The pending advance intents live in the approvals table; give each the
  // payer's name so the merged view can show it before the advance row exists.
  const pendingAdvances = allApprovals
    .filter((r) => r.kind === ADVANCE_KIND)
    .map((r) => {
      let p = {};
      try { p = r.payload ? JSON.parse(r.payload) : {}; } catch { p = {}; }
      return { ...r, paid_by_name: p.owner_id ? nameById.get(p.owner_id) ?? null : null };
    });

  // Who could ever approve, once, so the buttons can be gated per row rather
  // than offering an action the server will refuse.
  const bench = session
    ? ((await env.DB.prepare(
        `SELECT id, role, flat FROM owners
          WHERE active = 1 AND role IN ('admin','superadmin') ORDER BY id`
      ).all()).results ?? [])
    : [];

  const advancesView = mergeAdvancesView({ advances: advanceRows, pendingRequests: pendingAdvances })
    .map((a) => ({
      ...a,
      // Withdraw is the requester's own, and only on a still-pending row.
      canWithdraw: Boolean(session && a.state === 'awaiting'
        && a.requestedBy === session.actor.id),
      // Request-cancel is offered on a live approved advance that has no cancel
      // already waiting. Any admin may ask; a DIFFERENT one approves.
      canRequestCancel: Boolean(session && a.state === 'approved' && !a.cancelRequested),
    }));

  // The queue an approver actually works: only the kinds with an applier, each
  // with the decoded effect and whether this viewer may act, and why not.
  const approvalsView = allApprovals
    .filter((r) => r.kind === ADVANCE_KIND)
    .map((r) => {
      let payload = {};
      try { payload = r.payload ? JSON.parse(r.payload) : {}; } catch { payload = {}; }
      const policy = approvalPolicy({ admins: bench, requesterId: r.requested_by, billFlat: r.flat });
      const verdict = session
        ? canApprove({ policy, approver: session.actor, request: r })
        : { ok: false, reason: 'not-open' };
      return {
        type: 'advance',
        id: r.id,
        kind: r.kind,
        flat: r.flat,
        reason: r.reason,
        requested_by_name: r.requested_by_name,
        // One second admin for an advance; named so the screen does not have to
        // know the count rule.
        required: 1,
        payload: {
          amount: payload.amount ?? null,
          paidThrough: payload.paid_through ?? null,
          paidOn: payload.paid_on ?? null,
          paidByName: payload.owner_id ? nameById.get(payload.owner_id) ?? null : null,
          method: payload.method ?? null,
          reference: payload.reference ?? null,
        },
        canApprove: verdict.ok,
        blockedBecause: verdict.ok ? null : verdict.reason,
        hoursLeft: verdict.hoursLeft ?? null,
      };
    });

  // Pending cancels of approved advances (Option B) surface in the SAME queue,
  // read from the advances themselves — a cancel is a fact on the advance row
  // (cancel_requested_at set, cancelled_at not), not a maint_approval_requests
  // row. A different admin approves; canApprove keys off who requested it.
  const cancelApprovals = advanceRows
    .filter((a) => a.cancel_requested_at && !a.cancelled_at)
    .map((a) => {
      const policy = approvalPolicy({ admins: bench, requesterId: a.cancel_requested_by, billFlat: a.flat });
      const verdict = session
        ? canApprove({ policy, approver: session.actor,
            request: { status: 'pending', requested_by: a.cancel_requested_by, requested_at: a.cancel_requested_at } })
        : { ok: false, reason: 'not-open' };
      return {
        type: 'cancel',
        id: a.id,
        flat: a.flat,
        reason: a.cancel_reason,
        requested_by_name: nameById.get(a.cancel_requested_by) ?? null,
        required: 1,
        payload: {
          amount: a.amount ?? null,
          paidThrough: a.paid_through ?? null,
          lateFee: a.cancel_late_fee ?? null,
          lateFeeFrom: a.cancel_late_fee_from ?? null,
        },
        canApprove: verdict.ok,
        blockedBecause: verdict.ok ? null : verdict.reason,
        hoursLeft: verdict.hoursLeft ?? null,
      };
    });

  return {
    quarter: label,
    quarterLabel: describeQuarter(label),
    // Absent is a real state: a quarter nobody has drafted yet. Step 1 opens on
    // it and creates the row when the rates are saved.
    row: quarter ?? null,
    status: quarter?.status ?? 'none',
    // Last quarter's figures are step 1's defaults AND its comparison, which is
    // why they travel with the payload rather than being fetched when needed.
    previous: previous ?? null,
    previousLabel,
    issueDate,
    consequences: scheduleConsequences({ issueDate, preview }),
    tenancies,
    blocked,
    preview,
    bills,
    collect: quarter ? collectFigures({ bills, quarter, today }) : null,
    // The merged advances list — approved, cancelled, and still-awaiting — that
    // the panel draws, newest-reaching quarter first.
    advances: advancesView,
    // The people on each flat, for the record-advance form's Flat and Paid-by
    // pickers. Active only; a moved-out owner cannot have paid this quarter.
    flatPeople,
    exemptions: {
      // Two labelled groups in one panel: an admin looking for "who is excused
      // what" should find both in one place, and the labels carry the
      // difference between a fee exemption (per person) and a voting one (per
      // flat).
      fee: feeExemptions.results ?? [],
      voting: voteExemptions.results ?? [],
    },
    // A QUEUE, not buttons on the row that asked for it. Approving is a second
    // person's deliberate act and it should not sit under the mouse of whoever
    // made the request. Each row carries the decoded effect and whether this
    // viewer may act on it. Advance requests and pending advance-cancels share
    // the queue — both are one second admin's decision.
    approvals: [...approvalsView, ...cancelApprovals],
    // For the picker. Earlier quarters open read-only.
    quarters: (quarters.results ?? []).map((q) => q.quarter),
    // Read-only when the quarter is behind us: the page is for working a
    // quarter, and an old one is a record.
    readOnly: quarter?.status === 'locked' || label < currentQuarter(today),
  };
}

/**
 * The quarter the page opens on: the one being drafted, or the current one.
 *
 * Not "the newest row", which would leave an admin looking at next year in
 * January because somebody drafted ahead.
 */
async function workingQuarter(env, today) {
  const drafting = await env.DB.prepare(
    "SELECT quarter FROM maint_quarters WHERE status IN ('draft','scheduled') ORDER BY quarter LIMIT 1"
  ).first();
  return drafting?.quarter ?? currentQuarter(today);
}

function currentQuarter(today) {
  return quarterOf(today);
}

/** '2026-Q4' → '2026-Q3'. */
function previousOf(label) {
  const [year, q] = String(label).split('-Q').map(Number);
  return q === 1 ? `${year - 1}-Q4` : `${year}-Q${q - 1}`;
}

/**
 * The first day of the quarter, which is when bills go out unless the committee
 * says otherwise. Q4 2026's bills reach residents on 1 October.
 */
function defaultIssueDate(label) {
  const [year, q] = String(label).split('-Q').map(Number);
  return `${year}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
}

/* ── the admin home card ──────────────────────────────────────────────────  */

/**
 * The card on Admin Home while a quarter needs attention.
 *
 * APPEARS AT THE DRAFT DATE, seven days out, and goes when the bills are
 * issued. Between scheduling and issue day it is a receipt line rather than a
 * call to act.
 *
 * THE URGENCY ESCALATES, and that is deliberate: a card that looks urgent for
 * seven days straight is wallpaper by day three. Two steps — two days out, and
 * again once the quarter has started with nothing scheduled, where it says how
 * many days overdue it is.
 */
export function adminHomeCard({ quarter, blocked, preview, today = istToday() }) {
  if (!quarter) return null;
  if (quarter.status === 'issued' || quarter.status === 'locked') return null;

  const issueDate = quarter.issue_date;
  const days = daysBetween(today, issueDate);
  const started = String(today) >= String(issueDate);

  // Before the draft window there is nothing to say. A card about a quarter
  // three weeks out is a card nobody can act on.
  if (!started && days > DRAFT_LEAD_DAYS) return null;

  if (quarter.status === 'scheduled') {
    return {
      state: 'scheduled',
      urgency: 'calm',
      quarter: quarter.quarter,
      quarterLabel: describeQuarter(quarter.quarter),
      issueDate,
      flats: quarter.scheduled_flats ?? preview?.willBill ?? 0,
      total: quarter.scheduled_total ?? preview?.total ?? 0,
    };
  }

  return {
    state: 'unscheduled',
    // `overdue` once the quarter has started with nothing scheduled — the bills
    // are late, not merely close.
    urgency: started ? 'overdue' : days <= 2 ? 'urgent' : 'soon',
    quarter: quarter.quarter,
    quarterLabel: describeQuarter(quarter.quarter),
    issueDate,
    daysRemaining: started ? 0 : days,
    daysOverdue: started ? days : 0,
    // The two things an admin has to do something about, on the card, because
    // "schedule the quarter" is not actionable until you know what is blocking
    // it.
    tenanciesToConfirm: blocked?.count ?? 0,
    flats: preview?.willBill ?? 0,
    total: preview?.total ?? 0,
  };
}

/* ── small things ─────────────────────────────────────────────────────────  */

function sum(rows) {
  return (rows ?? []).reduce((total, r) => total + Number(r.total ?? 0), 0);
}

/** Whole days between two ISO dates. Absolute — the caller knows the sign. */
function daysBetween(a, b) {
  const from = new Date(`${String(a).slice(0, 10)}T00:00:00Z`).getTime();
  const to = new Date(`${String(b).slice(0, 10)}T00:00:00Z`).getTime();
  return Math.abs(Math.round((to - from) / 86400000));
}
