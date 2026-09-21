/**
 * Recording a maintenance advance, and approving it — the create/approve side.
 *
 * An advance is a flat paying ahead, stored as the QUARTER IT REACHES plus the
 * amount (see lib/maint.js). Nothing inserted into `maint_advances` before this:
 * the tables existed from 0042 but the only way to record a pre-payer was raw
 * SQL. This is the console path, and it mirrors the two approval flows already
 * proven on lib/approvals.js — the gas bill-edit queue and the tenancy-change
 * queue: one admin asks, a second agrees, and only then does the row exist.
 *
 * ONE SECOND ADMIN, not two. The committee's decision (2026-09-20), and it is
 * what the schema was built for: `maint_advances.approved_by` is a single column
 * with a `recorded_by <> approved_by` CHECK. So an advance is satisfied by the
 * FIRST eligible approval, unlike a gas bill edit which needs two. Eligibility
 * is still lib/approvals.js's, unchanged — the requester never approves their
 * own, nor does the flat's own household — but the COUNT is one.
 *
 * The pure parts are here and tested; the env-taking parts assemble them into
 * the two writes that matter (the request, and the advance the approval mints).
 */

import { parseQuarter, isQuarterLabel, describeQuarter } from './maint.js';

/** The one approval `kind` this session implements an applier for. */
export const ADVANCE_KIND = 'advance';

/**
 * How many quarters an advance reaches, inclusive of both ends.
 *
 * From the working quarter to "covers up to": Q4 2026 → Q4 2026 is one quarter,
 * Q4 2026 → Q1 2027 is two. Inclusive because "paid up to Q1" means Q1 itself is
 * covered, which is how the person writing the cheque understands it and how
 * advanceCovers() reads it. Null when either label is malformed — the caller
 * decides what an unknowable span means rather than this inventing a number.
 */
export function quarterSpan(fromQuarter, throughQuarter) {
  if (!isQuarterLabel(fromQuarter) || !isQuarterLabel(throughQuarter)) return null;
  if (String(throughQuarter) < String(fromQuarter)) return null;
  const a = parseQuarter(fromQuarter);
  const b = parseQuarter(throughQuarter);
  return (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter) + 1;
}

/**
 * Does the amount look right for the quarters it claims to cover?
 *
 * A SOFT check, and it stays soft on purpose: a resident may round, pay a part
 * quarter, or clear an odd balance, and the committee asked for a warning the
 * admin can overrule rather than a block. It compares the amount against
 * rate × quarters-covered and reports the expectation so the screen can say
 * exactly what looked off — "₹7,500 covers about 1 quarter, but you set 2".
 *
 * `consistent` is true when the span cannot be computed (nothing to warn about)
 * or the amount is within one quarter's rate of the expectation — a rounding or
 * part-payment tolerance, not an exact-match demand.
 */
export function advanceAmountCheck({ amount, rate, fromQuarter, throughQuarter }) {
  const quarters = quarterSpan(fromQuarter, throughQuarter);
  const rateNum = Number(rate);
  const amountNum = Number(amount);
  if (!quarters || !Number.isFinite(rateNum) || rateNum <= 0 || !Number.isFinite(amountNum)) {
    return { consistent: true, expected: null, quarters };
  }
  const expected = rateNum * quarters;
  // Within one quarter's rate either way is not worth a warning: it is the
  // rounding and part-payment slack a real building actually runs on.
  const consistent = Math.abs(amountNum - expected) < rateNum;
  return { consistent, expected, quarters };
}

/* ── the email both ways ────────────────────────────────────────────────────
   The committee chose email over the gas queue's Telegram for these. Sent at
   request time to the approver(s) and at decision time to the requester, direct
   rather than through the `maint_mail` outbox — that outbox is keyed
   UNIQUE(bill_id, kind) and an advance has no bill. Pure, so the wording is
   tested: an approval request is read once, on a phone, and has to carry the
   whole decision. Mirrors approvalMessage in lib/approvals.js.               */

const money = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

/**
 * What an approver is told when an advance is waiting for them.
 *
 * Every figure that decides the answer is on the face of it — amount, the
 * quarter it reaches, the date it was paid, who paid — so an approver can judge
 * it before opening anything, exactly as the bill-edit message names both
 * totals.
 */
export function advanceRequestEmail({
  flat, amount, paidThrough, paidOn, paidByName, reason, requestedBy, origin = '',
}) {
  const quarter = isQuarterLabel(paidThrough) ? describeQuarter(paidThrough) : paidThrough;
  const subject = `Approve an advance — ${flat} (${money(amount)})`;
  const lines = [
    `${requestedBy} has recorded an advance and needs one other admin to agree.`,
    '',
    `Flat:      ${flat}`,
    `Amount:    ${money(amount)}`,
    `Covers to: ${quarter}`,
    `Paid on:   ${paidOn ?? '—'}`,
    `Paid by:   ${paidByName ?? '—'}`,
    `Reason:    ${reason}`,
    '',
    'It needs one other admin to agree before the advance counts. Until then '
      + "the flat's bill is raised and chased as normal.",
    '',
    origin ? `Approve or reject: ${origin}/admin/#maintenance` : 'Open Admin → Maintenance to decide.',
    '',
    'You cannot approve an advance you recorded yourself, or one for your own flat.',
  ];
  return { subject, text: lines.join('\n') };
}

/**
 * What the requester is told once a second admin has decided.
 *
 * Both outcomes, one function, because the requester asked for the same thing
 * either way — to know it landed — and a rejected advance is exactly the one
 * they need to hear about so they can re-record it or chase the flat.
 */
export function advanceDecisionEmail({ decision, flat, amount, paidThrough, decidedBy, origin = '' }) {
  const quarter = isQuarterLabel(paidThrough) ? describeQuarter(paidThrough) : paidThrough;
  const approved = decision === 'approve';
  const subject = approved
    ? `Advance approved — ${flat} (${money(amount)})`
    : `Advance rejected — ${flat} (${money(amount)})`;
  const lines = approved
    ? [
        `The advance you recorded for ${flat} has been approved.`,
        '',
        `Amount:    ${money(amount)}`,
        `Covers to: ${quarter}`,
        decidedBy ? `Approved by: ${decidedBy}` : '',
        '',
        'It now counts: the flat\'s bills for the quarters it covers are settled '
          + 'from it as they are issued.',
      ].filter((l) => l !== '')
    : [
        `The advance you recorded for ${flat} was rejected by a second admin.`,
        '',
        `Amount:    ${money(amount)}`,
        `Covers to: ${quarter}`,
        decidedBy ? `Rejected by: ${decidedBy}` : '',
        '',
        'Nothing was recorded. If it was right, record it again with a note that '
          + 'answers the reason it was turned down.',
        '',
        origin ? `Maintenance: ${origin}/admin/#maintenance` : '',
      ].filter((l) => l !== '');
  return { subject, text: lines.join('\n') };
}

/* ── the unified advances view ──────────────────────────────────────────────
   The Advances panel shows three kinds of row in one table: an advance still
   awaiting its second admin (a pending request, no advance row yet), an approved
   one, and a cancelled one. They live in two tables — pending intents in
   `maint_approval_requests`, real advances in `maint_advances` — and this merges
   them into the one list the screen draws, newest-reaching quarter first.     */

/**
 * One list, three states, from the two tables that hold them.
 *
 * `advances` are `maint_advances` rows (always approved, since the row is only
 * minted at approval; cancelled ones carry `cancelled_at`). `pendingRequests`
 * are `maint_approval_requests` rows with kind='advance' and status='pending',
 * whose payload holds the proposed advance. Pure so the shape is tested; the
 * caller attaches the actor-dependent flags (who may withdraw or cancel).
 */
export function mergeAdvancesView({ advances = [], pendingRequests = [] }) {
  const out = [];

  for (const r of pendingRequests) {
    let p = {};
    try { p = r.payload ? JSON.parse(r.payload) : {}; } catch { p = {}; }
    out.push({
      state: 'awaiting',
      requestId: r.id,
      advanceId: null,
      flat: r.flat,
      amount: p.amount ?? null,
      paidThrough: p.paid_through ?? null,
      paidOn: p.paid_on ?? null,
      ownerId: p.owner_id ?? null,
      paidByName: r.paid_by_name ?? null,
      method: p.method ?? null,
      reference: p.reference ?? null,
      reason: r.reason ?? null,
      requestedBy: r.requested_by ?? null,
      recordedByName: r.requested_by_name ?? null,
      approvedByName: null,
    });
  }

  for (const a of advances) {
    out.push({
      state: a.cancelled_at ? 'cancelled' : 'approved',
      requestId: null,
      advanceId: a.id,
      flat: a.flat,
      amount: a.amount ?? null,
      paidThrough: a.paid_through ?? null,
      paidOn: a.paid_on ?? null,
      ownerId: a.owner_id ?? null,
      paidByName: a.resident ?? null,
      method: a.method ?? null,
      reference: a.reference ?? null,
      reason: a.note ?? null,
      requestedBy: a.recorded_by ?? null,
      recordedByName: a.recorded_by_name ?? null,
      approvedByName: a.approved_by_name ?? null,
      cancelledByName: a.cancelled_by_name ?? null,
      cancelReason: a.cancel_reason ?? null,
      cancelRequested: Boolean(a.cancel_requested_at && !a.cancelled_at),
      cancelRequestedBy: a.cancel_requested_by ?? null,
    });
  }

  // Furthest-reaching quarter first, then by flat, so the newest commitments —
  // the ones most likely to be wrong and needing a look — sit at the top.
  return out.sort((x, y) =>
    String(y.paidThrough ?? '').localeCompare(String(x.paidThrough ?? ''))
    || String(x.flat ?? '').localeCompare(String(y.flat ?? '')));
}

/* ── the writes ─────────────────────────────────────────────────────────────
   Two env-taking functions, thin over the SQL, so a test can drive them against
   the real-migration harness and assert on the constraint doing the work rather
   than on a string having been sent.                                          */

/**
 * Raise the request. Nothing about any advance changes here — the proposed
 * advance waits in the request's payload, and `maint_advances` is untouched
 * until a second admin approves. Returns the new request id.
 */
export async function recordAdvanceRequest(env, {
  actorId, flat, ownerId, amount, paidOn, paidThrough, method, reference, reason, now, expiresAt,
}) {
  const payload = JSON.stringify({
    owner_id: ownerId ?? null,
    amount,
    paid_on: paidOn ?? null,
    paid_through: paidThrough,
    method: method ?? null,
    reference: reference ?? null,
  });
  // `expiresAt` is passed in — computed by the caller from lib/approvals.js's
  // expiresAt(now) — so this file stays free of the TTL policy that lives there.
  const res = await env.DB.prepare(
    `INSERT INTO maint_approval_requests
       (kind, flat, payload, reason, requested_by, requested_at, expires_at, status)
     VALUES ('advance', ?, ?, ?, ?, ?, ?, 'pending')
     RETURNING id`
  ).bind(flat, payload, reason, actorId, now, expiresAt ?? now).first();
  return { requestId: res?.id ?? null };
}

/**
 * The applier the approve endpoint dispatches to when kind='advance' and the
 * request is satisfied. INSERTs the `maint_advances` row from the payload —
 * recorded_by is the original requester, approved_by this second admin — and
 * marks the request applied, in one batch so a half-written advance cannot
 * exist. The schema's `recorded_by <> approved_by` CHECK is the backstop under
 * canApprove's own requester guard.
 */
export async function applyAdvanceRequest(env, { req, actorId, now }) {
  let p = {};
  try { p = req.payload ? JSON.parse(req.payload) : {}; } catch { p = {}; }

  const inserted = await env.DB.prepare(
    `INSERT INTO maint_advances
       (flat, owner_id, paid_through, amount, method, reference, paid_on,
        recorded_by, recorded_at, approved_by, approved_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`
  ).bind(
    req.flat, p.owner_id ?? null, p.paid_through, p.amount,
    p.method ?? null, p.reference ?? null, p.paid_on ?? null,
    req.requested_by, req.requested_at, actorId, now, req.reason ?? null,
  ).first();

  await env.DB.prepare(
    "UPDATE maint_approval_requests SET status = 'applied', resolved_at = ? WHERE id = ?"
  ).bind(now, req.id).run();

  return { advanceId: inserted?.id ?? null };
}
