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
import { canChangeRole, ROLES } from './tenancy.js';
// Served to the browser as well, which is why it lives under public/. See the
// header there: one table, imported by both sides, rather than two that drift.
import { NATIONAL_LENGTHS, splitMobile } from '../../public/js/countries.js';

/* ── what may be edited ──────────────────────────────────────────────────── */

/** Person fields. Changing these is ordinary correction work. */
export const OWNER_FIELDS = ['name', 'email', 'mobile', 'role', 'flat', 'active', 'relationship'];

/**
 * Money fields. `total` is separated from the rest because editing it means
 * something different: the others are inputs the total is derived from, but
 * setting the total directly overrides the derivation.
 */
export const BILL_COMPONENTS = ['gas_amount', 'other_charges', 'additional_charges', 'late_fee'];

/**
 * What `editBill` will accept. NOT `total` — decided 2026-08-20.
 *
 * THE AMOUNT IS VISIBLE AND NEVER EDITABLE, for everyone, superadmin included.
 * A bill's total is consumption times rate, so the two things that can be wrong
 * with it are the reading and the price of gas, and both are corrected as
 * themselves on the Billing tab. A rupee figure typed against a bill is a bill
 * that no longer matches its own components, which is a bill nobody — not the
 * resident, not the auditor, not the next treasurer — can check.
 *
 * `total` is still listed in MONEY_FIELDS below, and `applyBillEdit` still
 * knows how to apply one. That is not a way back in: it is what keeps the 898
 * bills already carrying `manual_total` readable, and what `changeRate` needs
 * to go on skipping them. The doctor counts those rows (BILL-OVERRIDE) so the
 * number is visible and can go to zero, and when it does the column and its
 * guards can go in a follow-up that costs nothing.
 */
export const BILL_FIELDS = [...BILL_COMPONENTS, 'status'];

/**
 * Every field that has ever moved money on a bill, which is what "does this
 * need a reason on the record" asks about. Historical rows were written
 * through `total`, and a reason was required for them; that stays true of the
 * record even though the route is closed.
 */
export const MONEY_FIELDS = [...BILL_COMPONENTS, 'total', 'status'];

export const BILL_STATUSES = ['unpaid', 'initiated', 'awaiting', 'paid', 'waived'];

/**
 * Acts that need a reason on the record.
 *
 * Editing an amount or a payment status; fixing a typo does not.
 *
 * `flat.active` joins them because excluding a flat from billing is invisible
 * by construction — the flat leaves the reading grid AND the count generation
 * checks against, so a closed month looks complete either way. Nothing else in
 * the system would ever say why 12F stopped being billed.
 */
export function reasonRequired(field) {
  return MONEY_FIELDS.includes(field) || field === 'flat.active';
}

export const MAX_REASON = 300;

/* ── validation ──────────────────────────────────────────────────────────── */

const E164 = /^\+?[1-9]\d{7,14}$/;   // ITU-T E.164: up to 15 digits, no leading zero

/**
 * Mobile numbers are the login identity, and several owners live abroad, so a
 * bare 10-digit Indian assumption is wrong. Stored in E.164 with the country
 * code; a plain 10-digit entry is read as Indian because that is what everyone
 * standing in the building will type.
 *
 * WHAT A NUMBER WITHOUT A '+' MAY BE. Anything else used to be treated as an
 * international number already carrying its country code, which is how a
 * mistyped 9-digit Kerala mobile became '+987654321' — a number in no country
 * at all, stored without complaint, and the resident could then never log in.
 * A bare number is now Indian or refused; if it is foreign, say so with a '+'.
 */
export function normaliseMobile(input) {
  const raw = String(input ?? '').replace(/[\s()\-.]/g, '');
  const digits = raw.replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) fail('DDP-ADMIN-009', { mobile: input });

  let e164;
  if (raw.startsWith('+')) e164 = `+${digits}`;
  // 09846466511 and 919846466511 are both how Indian numbers get written down;
  // a spreadsheet column of them is where the roster import gets its data.
  else if (digits.length === 10) e164 = `+91${digits}`;
  else if (digits.length === 11 && digits.startsWith('0')) e164 = `+91${digits.slice(1)}`;
  else if (digits.length === 12 && digits.startsWith('91')) e164 = `+${digits}`;
  else fail('DDP-ADMIN-009', { mobile: input });

  if (!E164.test(e164)) fail('DDP-ADMIN-009', { mobile: input });
  assertNationalLength(e164, input);
  return e164;
}

/**
 * A country's numbers are a known length, and the wrong length is the failure
 * that hides: it looks like a phone number, it saves, and it is discovered when
 * somebody cannot log in or a password never arrives on WhatsApp.
 *
 * Only checked for the codes NATIONAL_LENGTHS knows. Refusing a real number
 * because our table is incomplete would be worse than the looseness it fixes.
 */
function assertNationalLength(e164, input) {
  const parts = splitMobile(e164);
  if (!parts) return;
  const allowed = NATIONAL_LENGTHS[Number(parts.dial)];
  if (allowed && !allowed.includes(parts.national.length)) {
    fail('DDP-ADMIN-009', {
      mobile: input,
      expected: `${allowed.join(' or ')} digits after +${parts.dial}`,
      got: parts.national.length,
    });
  }
}

/**
 * An address, or null if it is not one. Never throws — the caller decides
 * whether a bad address is a 400 or a row to skip.
 *
 * Still deliberately loose about what a mailbox may contain, because the only
 * test that means anything is whether a message arrives and the reset flow
 * performs that test for real. What it does catch is the shape that cannot
 * possibly deliver: no dot in the domain, a dot at either end of it, two dots
 * running, a one-letter TLD. Those are typing mistakes, and an address is
 * usually written down once and then relied on months later, at the moment
 * somebody is locked out.
 */
export function normaliseEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!email || email.length > 120) return null;

  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (/[\s@,;<>()[\]\\"]/.test(local) || local.startsWith('.') || local.endsWith('.')) return null;
  if (!/^[a-z0-9.-]+$/.test(domain)) return null;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.startsWith('-')) return null;
  if (email.includes('..')) return null;

  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  if (!domain.includes('.') || tld.length < 2 || !/^[a-z]+$/.test(tld)) return null;

  return email;
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
      const email = normaliseEmail(value);
      if (!email) fail('DDP-ADMIN-010', { field, value });
      return email;
    }
    case 'mobile':
      return normaliseMobile(value);
    case 'role': {
      const role = String(value ?? '').trim();
      // One list, in tenancy.js, so god-edit and canChangeRole cannot come to
      // different conclusions about what a role is.
      if (!ROLES.includes(role)) fail('DDP-ADMIN-010', { field, value });
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
