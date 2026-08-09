/**
 * God edits — the superadmin changing anything.
 *
 * Pure. Everything here decides *what* a change means; index.js does the I/O.
 *
 * The design rule: maximum power, zero silence. There is no field the
 * superadmin cannot change, and no change that goes unrecorded. Those are the
 * same feature — unlimited power is only safe to hand someone if the record of
 * using it is automatic, because the log is what lets them defend a decision
 * to a resident six months later.
 *
 * Three things are refused outright, and none of them is a policy preference:
 * each one would lock the superadmin out of their own building, with no way
 * back that does not involve direct database access.
 */

import { fail } from './errors.js';
import { round2, toWholeRupees } from './billing.js';
import { canChangeRole } from './tenancy.js';

/* ── what may be edited ──────────────────────────────────────────────────── */

/** Person fields. Changing these is ordinary correction work. */
export const OWNER_FIELDS = ['name', 'email', 'mobile', 'role', 'flat', 'active', 'relationship'];

/**
 * Money fields. `total` is separated from the rest because editing it means
 * something different: the others are inputs the total is derived from, but
 * setting the total directly overrides the derivation.
 */
export const BILL_COMPONENTS = ['gas_amount', 'other_charges', 'additional_charges', 'late_fee'];
export const BILL_FIELDS = [...BILL_COMPONENTS, 'total', 'status'];

export const BILL_STATUSES = ['unpaid', 'initiated', 'awaiting', 'paid', 'waived'];

/** Editing an amount or a payment status needs a reason; fixing a typo does not. */
export function reasonRequired(field) {
  return BILL_FIELDS.includes(field);
}

export const MAX_REASON = 300;

/* ── validation ──────────────────────────────────────────────────────────── */

const E164 = /^\+?[1-9]\d{7,14}$/;   // ITU-T E.164: up to 15 digits, no leading zero

/**
 * Mobile numbers are the login identity, and several owners live abroad, so a
 * bare 10-digit Indian assumption is wrong. Stored in E.164 with the country
 * code; a plain 10-digit entry is read as Indian because that is what everyone
 * standing in the building will type.
 */
export function normaliseMobile(input) {
  const raw = String(input ?? '').replace(/[\s()\-.]/g, '');
  const digits = raw.replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) fail('DDP-ADMIN-009', { mobile: input });
  const e164 = raw.startsWith('+') ? `+${digits}`
             : digits.length === 10 ? `+91${digits}`
             : `+${digits}`;
  if (!E164.test(e164)) fail('DDP-ADMIN-009', { mobile: input });
  return e164;
}

export function validateOwnerField(field, value) {
  switch (field) {
    case 'name': {
      const name = String(value ?? '').trim();
      if (name.length < 2 || name.length > 80) fail('DDP-ADMIN-010', { field, value });
      return name;
    }
    case 'email': {
      if (value == null || value === '') return null;      // email is optional
      const email = String(value).trim().toLowerCase();
      // Deliberately loose. The only test that means anything is whether a
      // message arrives, and the OTP flow performs that test for real.
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 120) {
        fail('DDP-ADMIN-010', { field, value });
      }
      return email;
    }
    case 'mobile':
      return normaliseMobile(value);
    case 'role': {
      const role = String(value ?? '').trim();
      if (!['owner', 'admin', 'superadmin'].includes(role)) fail('DDP-ADMIN-010', { field, value });
      return role;
    }
    case 'flat':
      return String(value ?? '').trim().toUpperCase();
    case 'relationship': {
      const rel = String(value ?? '').trim();
      if (!['owner', 'tenant'].includes(rel)) fail('DDP-ADMIN-010', { field, value });
      return rel;
    }
    case 'active':
      return value ? 1 : 0;
    default:
      fail('DDP-ADMIN-010', { field });
  }
}

export function validateBillField(field, value) {
  if (field === 'status') {
    const status = String(value ?? '').trim();
    if (!BILL_STATUSES.includes(status)) fail('DDP-ADMIN-010', { field, value });
    return status;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) fail('DDP-ADMIN-010', { field, value });
  // Amounts are money, not floats with a tail.
  return round2(n);
}

/* ── the three refusals ──────────────────────────────────────────────────── */

/**
 * Every one of these is a lock-out, not a rule about what is proper.
 *
 * @param actor  the real superadmin making the change (never the impersonated subject)
 * @param target the owner row being edited
 */
export function lockoutCheck({ actor, target, field, value, superadminCount }) {
  const isSelf = actor.id === target.id;

  // 1. Demoting yourself out of the only superadmin seat. There is no in-app
  //    route back: the role can only be granted by a superadmin.
  if (field === 'role') {
    const verdict = canChangeRole({ target, newRole: value, superadminCount });
    if (!verdict.ok) return { ok: false, message: verdict.message };
  }

  // 2. Deactivating yourself. An inactive account cannot log in, and only an
  //    active superadmin can reactivate one.
  if (field === 'active' && isSelf && !value) {
    return {
      ok: false,
      message: 'You cannot deactivate your own account — nobody else could reactivate it.',
    };
  }

  // 3. Changing your OWN mobile is allowed, but it is the login identity, so
  //    it is worth being sure. This is a confirmation, not a refusal: an owner
  //    who genuinely changes number must be able to fix it themselves.
  if (field === 'mobile' && isSelf) {
    return {
      ok: true,
      confirm: 'This is the number you log in with. You will need the new one next time.',
    };
  }

  return { ok: true };
}

/* ── applying an edit ────────────────────────────────────────────────────── */

/**
 * What a bill looks like after an edit, and whether the total is now a manual
 * override.
 *
 * Editing a COMPONENT re-derives the total by the normal rule, so the
 * breakdown a resident sees continues to add up. Editing the TOTAL directly is
 * an override: the components are left exactly as they were, because they are
 * the honest record of what was metered, and `manual_total` marks the gap as
 * deliberate so DDP-BILL-003 does not fire on it.
 *
 * An override survives later component edits only until a component changes —
 * at that point the treasurer is back to deriving, and silently keeping a
 * stale override would be the surprising behaviour.
 */
export function applyBillEdit(bill, field, value) {
  const next = { ...bill, [field]: value };

  if (field === 'total') {
    return {
      bill: { ...next, manual_total: 1 },
      derived: false,
      // Surfaced so the UI can say what the arithmetic would otherwise give,
      // rather than letting an override look like a normal bill.
      computed: computedTotal(bill),
    };
  }

  if (BILL_COMPONENTS.includes(field)) {
    const computed = computedTotal(next);
    return {
      bill: { ...next, total: computed, manual_total: 0 },
      derived: true,
      computed,
    };
  }

  // status, and anything else that does not touch the arithmetic
  return { bill: next, derived: false, computed: computedTotal(next) };
}

/** The total the ordinary rule would produce for these components. */
export function computedTotal(bill) {
  return toWholeRupees(
    Number(bill.gas_amount ?? 0) +
    Number(bill.other_charges ?? 0) +
    Number(bill.additional_charges ?? 0) +
    Number(bill.late_fee ?? 0)
  );
}

/**
 * Is this bill's stored total inconsistent with its own components in a way
 * nobody authorised? That is the DDP-BILL-003 condition — and an acknowledged
 * override is precisely not it.
 */
export function isUnexplainedMismatch(bill) {
  if (bill.manual_total) return false;
  return Math.abs(Number(bill.total) - computedTotal(bill)) > 0.005;
}

/* ── the record ──────────────────────────────────────────────────────────── */

/**
 * The audit detail for one edit. Before and after both, always: "changed the
 * total" is not worth writing down, and "329 to 200" is the whole point.
 *
 * Returns null when nothing actually changed, so that opening an edit form and
 * saving it untouched does not litter the log with empty entries.
 */
export function diff({ entity, id, field, before, after, reason = null }) {
  if (String(before ?? '') === String(after ?? '')) return null;
  return { entity, id, field, before: before ?? null, after: after ?? null, reason };
}

/**
 * Reasons are required on money and optional elsewhere. Enforced here rather
 * than at the route so the rule is stated once and tested directly.
 */
export function checkReason(field, reason) {
  const text = String(reason ?? '').trim();
  if (!reasonRequired(field)) return text ? text.slice(0, MAX_REASON) : null;
  if (text.length < 3) fail('DDP-ADMIN-011', { field });
  return text.slice(0, MAX_REASON);
}
