/**
 * Who may approve a bill edit, and how many of them it takes.
 *
 * Pure, and deliberately so: this is a policy the committee agreed in words,
 * and every clause of it is a case that can be written down and tested. The
 * arithmetic is small and the consequences are not — the wrong answer here
 * either lets money move unwatched or jams a correction on a wrong bill.
 *
 * THE POLICY (2026-08-13):
 *   1. The requester never approves their own request.
 *   2. The bill's own household never approves it. Admins live in the building
 *      and have flats like everyone else; their own bill is precisely where a
 *      quiet edit looks worst.
 *   3. An ordinary resident's bill takes two other admins.
 *   4. An ADMIN's bill takes every other eligible admin — unanimity.
 *   5. The superadmin is not part of the pool, but joins when fewer than two
 *      admins are left, and may stand in for an admin who has not answered.
 *
 * WHY RULE 5 EXISTS AT ALL. This building has three admins. On an ordinary bill
 * the requester is one of them, so "two others" is already everyone else — and
 * on an ADMIN's bill, excluding the subject leaves two, one of whom raised the
 * request, so rule 4 would need a single approval and the STRICTEST case would
 * be the laxest. Topping the pool up keeps two pairs of eyes on every edit
 * regardless of how small the committee gets.
 */

/** How long a stand-in has to wait before the superadmin can act instead. */
export const SUBSTITUTE_AFTER_HOURS = 48;

/** How long a request stays open before it lapses. */
export const REQUEST_TTL_DAYS = 7;

/**
 * @param admins      [{ id, role, flat }] — active admins AND the superadmin
 * @param requesterId who raised the edit
 * @param billFlat    the flat the bill belongs to
 */
export function approvalPolicy({ admins, requesterId, billFlat }) {
  const ordinary = admins.filter((a) => a.role === 'admin');
  const superadmin = admins.find((a) => a.role === 'superadmin') ?? null;

  const isHousehold = (a) => String(a.flat) === String(billFlat);
  // Rule 4 keys off whether an ADMIN (or the superadmin) lives at the flat
  // being corrected, not off who raised it.
  const subjectIsAdmin = admins.some(isHousehold);

  const eligible = ordinary.filter((a) => a.id !== requesterId && !isHousehold(a));

  // Rule 5. The superadmin is a top-up, not a member: added only when the pool
  // cannot field two, and never when they are the requester or the subject.
  const superEligible = superadmin
    && superadmin.id !== requesterId
    && !isHousehold(superadmin);
  const pool = eligible.length < 2 && superEligible ? [...eligible, superadmin] : eligible;

  // Unanimity for an admin's bill, two for anyone else's — but never fewer than
  // two while two people exist to ask, which is what rule 5 is protecting.
  const required = subjectIsAdmin
    ? pool.length
    : Math.min(2, pool.length);

  return {
    subjectIsAdmin,
    approverIds: pool.map((a) => a.id),
    required,
    // Below two eligible people the policy cannot be honoured at all. Reported
    // rather than silently relaxed: an edit that applies itself because nobody
    // was available is the exact failure this exists to prevent.
    satisfiable: pool.length >= required && required >= 2,
    superadminId: superadmin?.id ?? null,
  };
}

/**
 * May this person approve this request, right now?
 *
 * `substitute` is not a second class of approval — it is the same decision,
 * recorded as having been made by the superadmin in place of an admin who did
 * not answer, so it can be read back as exactly that.
 */
export function canApprove({ policy, approver, request, now = new Date().toISOString() }) {
  if (!approver || request.status !== 'pending') {
    return { ok: false, code: 'DDP-ADMIN-017', reason: 'not-open' };
  }
  if (approver.id === request.requested_by) {
    return { ok: false, code: 'DDP-ADMIN-015', reason: 'requester' };
  }
  if (policy.approverIds.includes(approver.id)) return { ok: true, substitute: false };

  // The stand-in. Only the superadmin, only after the wait, and never when the
  // bill is theirs or they raised it — both already excluded from approverIds,
  // so they are re-checked here rather than assumed.
  if (approver.role === 'superadmin' && approver.id === policy.superadminId) {
    if (policy.subjectIsAdmin === undefined) return { ok: false, code: 'DDP-ADMIN-015', reason: 'ineligible' };
    const waited = Date.parse(now) - Date.parse(request.requested_at);
    if (waited >= SUBSTITUTE_AFTER_HOURS * 3600_000) return { ok: true, substitute: true };
    return {
      ok: false, code: 'DDP-ADMIN-015', reason: 'too-soon',
      hoursLeft: Math.ceil((SUBSTITUTE_AFTER_HOURS * 3600_000 - waited) / 3600_000),
    };
  }

  return { ok: false, code: 'DDP-ADMIN-015', reason: 'ineligible' };
}

/** Is the request satisfied by the approvals recorded against it? */
export function isSatisfied(policy, approvals) {
  const yes = approvals.filter((a) => a.decision === 'approve');
  return yes.length >= policy.required;
}

export function expiresAt(requestedAt, days = REQUEST_TTL_DAYS) {
  return new Date(Date.parse(requestedAt) + days * 86_400_000).toISOString();
}

/**
 * Does this edit need approval at all?
 *
 * Bill totals are whole rupees — the paise tag was retired and `toWholeRupees`
 * ceilings every total — so the smallest move any edit can make is ₹1. The
 * committee's "paise are free" carve-out therefore describes nothing that can
 * happen, and this reduces to: if the total moves, it needs two other admins.
 * An edit that leaves the total alone (a reason, a status correction that costs
 * nothing) applies immediately and is announced.
 */
export function needsApproval({ totalBefore, totalAfter, field }) {
  // STATUS MOVES NO MONEY AND SETTLES ALL OF IT. Marking a bill `paid` or
  // `waived` leaves the total untouched, so an amount-only rule would let one
  // admin write off a debt on their own — the exact thing two signatures are
  // for. It is the one field where the size of the change tells you nothing.
  if (field === 'status') return true;
  return Math.abs(Number(totalAfter) - Number(totalBefore)) >= 1;
}
