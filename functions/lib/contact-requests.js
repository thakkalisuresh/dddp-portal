/**
 * An admin asks for a resident's mobile or email to be changed; the superadmin
 * approves, and approving applies it. Backlog B22, migration 0024.
 *
 * Deliberately not a general approvals framework. Two fields, one approver, no
 * delegation, no partial approval, no expiry on a pending request. The moment a
 * third field needs this is the moment to generalise — not before, because the
 * generalised version of two cases is mostly guesses about the third.
 *
 * Pure. The decisions are all over rows, so they are all testable directly.
 */

import { fail } from './errors.js';
import { validateOwnerField } from './godedit.js';
import { REQUESTABLE_FIELDS } from './tenancy.js';

export const MAX_REASON = 300;
export const STATES = ['pending', 'approved', 'rejected'];

/**
 * Check a request at the moment it is RAISED, not only when it is approved.
 *
 * A malformed number refused here is refused while the admin is still standing
 * with the resident and can ask again. The same refusal at approval time lands
 * in front of the superadmin, who has no way to find out what the number should
 * have been and can only reject it.
 *
 * Returns the normalised value, so what is stored is what would be written —
 * `validateOwnerField` puts a mobile into E.164 and lowercases an address, and a
 * request holding the raw typing would approve into something different from what
 * was reviewed.
 */
export function validateRequest({ field, value, reason }) {
  if (!REQUESTABLE_FIELDS.includes(field)) {
    fail('DDP-ADMIN-010', { field });
  }

  // Throws DDP-ADMIN-009 / DDP-ADMIN-010 with the field's own message.
  const normalised = validateOwnerField(field, value);

  // A mobile is the login: clearing it would lock the resident out with no way
  // back, so unlike an address it cannot be emptied through a request.
  if (field === 'mobile' && normalised == null) {
    fail('DDP-ADMIN-009', { field, reason: 'empty-mobile' });
  }

  const text = String(reason ?? '').trim();
  if (text.length < 3) fail('DDP-ADMIN-011', { field });

  return { field, value: normalised, reason: text.slice(0, MAX_REASON) };
}

/**
 * Is this request still open, and may it be decided?
 *
 * A reason rather than a boolean, so an already-decided request can say which way
 * it went. Two admins looking at the same queue is the ordinary case, and
 * "approved by somebody else a minute ago" is a different message from "no such
 * request".
 */
export function requestState(row) {
  if (!row) return { open: false, reason: 'none' };
  if (row.state === 'approved') return { open: false, reason: 'approved' };
  if (row.state === 'rejected') return { open: false, reason: 'rejected' };
  if (row.state !== 'pending') return { open: false, reason: 'unknown' };
  return { open: true };
}

/** What to tell somebody whose approval or rejection did not land. */
export function decisionFailure(reason) {
  switch (reason) {
    case 'approved': return 'That request has already been approved.';
    case 'rejected': return 'That request has already been rejected.';
    case 'none':     return 'That request no longer exists.';
    default:         return 'That request is not in a state that can be decided.';
  }
}

/**
 * Would this request still be a change if approved now?
 *
 * Approval can land days after the request, by which time the resident may have
 * corrected it themselves through their profile. Applying it anyway would be
 * harmless but the audit row would claim a change that did not happen, and the
 * superadmin would have approved something that turned out to be a no-op without
 * being told.
 */
export function isStillAChange(row, owner) {
  return String(owner?.[row.field] ?? '') !== String(row.requested_value ?? '');
}

/**
 * The Telegram nudge.
 *
 * CARRIES NO VALUE, and that is the whole design of it. `TELEGRAM_CHAT_ID` is one
 * shared chat — the same one alerting and the morning digest use — so anything
 * put here is read by everybody with access to it, and a resident's new mobile
 * number or home address is not that. docs/PRIVACY.md accounts for error codes
 * and counts reaching Telegram, not personal contact details.
 *
 * The flat is included because it is what makes the message worth opening, and it
 * is already all over the digest. The point is a nudge to open the console, where
 * the value can be reviewed by the one person who is about to write it.
 */
export function requestNotification({ flat, field, requestedBy }) {
  return `Contact change requested for ${flat} — ${field}, by ${requestedBy}. `
       + 'Approve or reject it in Residents.';
}
