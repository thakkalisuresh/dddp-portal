/**
 * Ownership changes: a flat is sold, or the builder hands one to a new buyer.
 *
 * THE DISTINCTION THAT MATTERS: a meter reading is a fact about the property,
 * so readings stay keyed to the flat alone and carry across a sale. A bill and
 * a payment screenshot are facts about a PERSON — the new owner must not be
 * able to read the previous owner's bills or open their receipts, and the
 * previous owner must not see the new one's.
 */

import { fail } from './errors.js';

export const ROLES = ['owner', 'admin', 'superadmin'];

/**
 * Outstanding balance a departing owner leaves behind. Usually settled at the
 * sale, but the committee needs to see the number to settle it — and needs to
 * decide explicitly rather than have it silently become the buyer's problem.
 */
export function outstandingFor(bills) {
  const open = bills.filter((b) => b.status !== 'paid' && b.status !== 'waived');
  return {
    count: open.length,
    total: Math.round(open.reduce((sum, b) => sum + b.total, 0) * 100) / 100,
    bills: open.map((b) => ({ id: b.id, period: b.period, total: b.total, status: b.status })),
  };
}

/**
 * There is exactly ONE superadmin, and it is the building's owner-operator.
 *
 * Two rules fall out of that, and they pull in opposite directions:
 *   - nobody else can be promoted into the role, and
 *   - the sole holder cannot be demoted, because that would leave the system
 *     with no one able to administer it and no in-app way back.
 *
 * Which means the role can only ever MOVE, never be created or destroyed —
 * see handoverSuperadmin. Admins are a separate, plural role and change freely
 * at an AGM.
 */
export const SUPERADMIN_LIMIT = 1;

export function canChangeRole({ target, newRole, superadminCount }) {
  if (!ROLES.includes(newRole)) {
    return { ok: false, message: `Role must be one of ${ROLES.join(', ')}.` };
  }

  // Promoting a second superadmin.
  if (newRole === 'superadmin' && target.role !== 'superadmin'
      && superadminCount >= SUPERADMIN_LIMIT) {
    return {
      ok: false,
      message: 'There can only be one superadmin. Use "Hand over superadmin" to move the role.',
    };
  }

  // Demoting the only one.
  if (target.role === 'superadmin' && newRole !== 'superadmin' && superadminCount <= 1) {
    return {
      ok: false,
      message: 'This is the only superadmin. Hand the role over instead — demoting it would leave nobody able to administer the portal.',
    };
  }

  return { ok: true };
}

/**
 * Move the role in one step: the outgoing holder becomes an admin and the
 * incoming one becomes superadmin. Doing it as two role edits is impossible by
 * design — either order trips a guard — and that is deliberate, because a
 * half-finished handover is how a building ends up locked out of its own
 * portal.
 */
export function planHandover({ from, to }) {
  if (!from || !to) return { ok: false, message: 'Both the current and the new superadmin are required.' };
  if (from.id === to.id) return { ok: false, message: 'That is already the superadmin.' };
  if (from.role !== 'superadmin') return { ok: false, message: 'Only the current superadmin can hand the role over.' };
  if (!to.active) return { ok: false, message: 'That resident is no longer active.' };

  return {
    ok: true,
    steps: [
      { id: to.id, role: 'superadmin' },
      { id: from.id, role: 'admin' },   // demoted, not removed — they keep operational access
    ],
  };
}

/**
 * Hand a flat over. The outgoing owner is deactivated rather than deleted:
 * their bills, payments and comments remain attributable, which is what makes
 * the audit trail worth having.
 */
export async function transferFlat(env, { flat, outgoingId, name, mobile, email, actorId,
                                          settleOutstanding = false }) {
  const cleanMobile = String(mobile ?? '').replace(/\D/g, '');
  if (!name?.trim() || cleanMobile.length < 10) {
    fail('DDP-ADMIN-003', { reason: 'new owner needs a name and a 10-digit mobile' });
  }

  const outgoing = await env.DB.prepare(
    'SELECT id, flat, name, role FROM owners WHERE id = ? AND flat = ? AND active = 1'
  ).bind(outgoingId, flat).first();
  if (!outgoing) fail('DDP-ADMIN-001', { flat, outgoingId });

  const bills = await env.DB.prepare(
    'SELECT id, period, total, status FROM bills WHERE owner_id = ?'
  ).bind(outgoingId).all();
  const outstanding = outstandingFor(bills.results ?? []);

  // Refuse silently carrying a debt across a sale. The committee must either
  // settle it or say explicitly that they are writing it off.
  if (outstanding.count > 0 && !settleOutstanding) {
    fail('DDP-ADMIN-005', { flat, outstanding });
  }

  return { outgoing, outstanding };
}

/** ISO in, IST out. The committee reads these, not a server operator. */
export function toIST(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const ist = new Date(date.getTime() + 5.5 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())} `
       + `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())} IST`;
}

/**
 * One timeline from three tables. Kept as a shaping function so the ordering
 * and labelling are testable without a database.
 */
export function mergeTimeline({ audits = [], activities = [], errors = [] }) {
  const rows = [
    ...audits.map((a) => ({
      at: a.at, kind: 'action', name: a.action,
      actor: a.actor_name, actorId: a.actor_id,
      subject: a.subject_name, subjectId: a.subject_id,
      detail: a.detail, source: 'audit',
    })),
    ...activities.map((a) => ({
      at: a.at, kind: a.kind, name: a.name,
      actor: a.actor_name, actorId: a.actor_id,
      subject: a.owner_name, subjectId: a.owner_id,
      detail: a.detail, userAgent: a.user_agent, source: 'activity',
    })),
    ...errors.map((e) => ({
      at: e.at, kind: 'error', name: e.code,
      severity: e.severity, detail: e.detail ?? e.message, source: 'error',
    })),
  ];

  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return rows.map((r) => ({ ...r, atIST: toIST(r.at) }));
}
