import { describe, it, expect } from 'vitest';
import {
  normaliseMobile, validateOwnerField, validateBillField, lockoutCheck,
  applyBillEdit, computedTotal, isUnexplainedMismatch, diff, checkReason,
  reasonRequired, BILL_COMPONENTS,
} from '../functions/lib/godedit.js';

const god  = { id: 1, flat: '4A', role: 'superadmin' };
const other = { id: 2, flat: '4B', role: 'owner' };

/* ── the arithmetic of an edit ───────────────────────────────────────────── */

describe('editing a bill component re-derives the total', () => {
  const bill = { gas_amount: 328.5, other_charges: 0, additional_charges: 0,
                 late_fee: 0, total: 329, manual_total: 0 };

  it('recomputes so the breakdown still adds up', () => {
    const r = applyBillEdit(bill, 'gas_amount', 250);
    expect(r.bill.total).toBe(250);
    expect(r.derived).toBe(true);
  });

  it('rounds the recomputed total up, like every other total', () => {
    // The god path must not become a second, subtly different billing rule.
    const r = applyBillEdit(bill, 'gas_amount', 250.01);
    expect(r.bill.total).toBe(251);
  });

  it('adds a late fee into the total rather than beside it', () => {
    const r = applyBillEdit(bill, 'late_fee', 50);
    expect(r.bill.total).toBe(379);
  });

  it('clears a previous override once a component moves', () => {
    // Keeping a stale override here would silently re-apply an old decision to
    // new numbers, which is the surprising behaviour.
    const overridden = { ...bill, total: 200, manual_total: 1 };
    const r = applyBillEdit(overridden, 'gas_amount', 100);
    expect(r.bill.total).toBe(100);
    expect(r.bill.manual_total).toBe(0);
  });
});

describe('editing the total directly is an override', () => {
  const bill = { gas_amount: 328.5, other_charges: 0, additional_charges: 0,
                 late_fee: 0, total: 329, manual_total: 0 };

  it('stores exactly what was typed', () => {
    const r = applyBillEdit(bill, 'total', 200);
    expect(r.bill.total).toBe(200);
    expect(r.bill.manual_total).toBe(1);
  });

  it('leaves the components alone — they are what was metered', () => {
    const r = applyBillEdit(bill, 'total', 200);
    expect(r.bill.gas_amount).toBe(328.5);
    expect(r.computed).toBe(329);
  });

  it('does not trip the fatal mismatch check', () => {
    // DDP-BILL-003 is fatal and means "this bill contradicts itself". An
    // acknowledged override is exactly not that, and if it alerted, every
    // goodwill adjustment would bury the real signal.
    const r = applyBillEdit(bill, 'total', 200);
    expect(isUnexplainedMismatch(r.bill)).toBe(false);
  });

  it('still catches a mismatch nobody authorised', () => {
    expect(isUnexplainedMismatch({ ...bill, total: 200 })).toBe(true);
  });

  it('tolerates float noise rather than reporting it as corruption', () => {
    expect(isUnexplainedMismatch({ ...bill, total: 329.0000001 })).toBe(false);
  });
});

describe('computedTotal', () => {
  it('sums every component and rounds up', () => {
    expect(computedTotal({ gas_amount: 100.2, other_charges: 10, additional_charges: 5.5, late_fee: 50 }))
      .toBe(166);
  });

  it('treats missing components as zero', () => {
    expect(computedTotal({ gas_amount: 100 })).toBe(100);
  });
});

/* ── the three lock-outs ─────────────────────────────────────────────────── */

describe('refusing edits that would lock the superadmin out', () => {
  it('refuses to demote the only superadmin', () => {
    const v = lockoutCheck({ actor: god, target: god, field: 'role',
                             value: 'owner', superadminCount: 1 });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/hand the role over/i);
  });

  it('refuses a second superadmin', () => {
    const v = lockoutCheck({ actor: god, target: other, field: 'role',
                             value: 'superadmin', superadminCount: 1 });
    expect(v.ok).toBe(false);
  });

  it('refuses self-deactivation', () => {
    const v = lockoutCheck({ actor: god, target: god, field: 'active',
                             value: 0, superadminCount: 1 });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/reactivate/i);
  });

  it('allows deactivating somebody else', () => {
    expect(lockoutCheck({ actor: god, target: other, field: 'active',
                          value: 0, superadminCount: 1 }).ok).toBe(true);
  });

  it('allows changing your own mobile, but says what it costs', () => {
    // A refusal here would be wrong: an owner who really changes number must
    // be able to fix it without database access.
    const v = lockoutCheck({ actor: god, target: god, field: 'mobile',
                             value: '+919000000000', superadminCount: 1 });
    expect(v.ok).toBe(true);
    expect(v.confirm).toMatch(/log in/i);
  });

  it('lets ordinary promotions through', () => {
    expect(lockoutCheck({ actor: god, target: other, field: 'role',
                          value: 'admin', superadminCount: 1 }).ok).toBe(true);
  });
});

/* ── international numbers ───────────────────────────────────────────────── */

describe('mobile numbers, including owners settled abroad', () => {
  it('reads a bare 10-digit number as Indian', () => {
    expect(normaliseMobile('9567791515')).toBe('+919567791515');
  });

  it('keeps an explicit country code', () => {
    expect(normaliseMobile('+971 50 123 4567')).toBe('+971501234567');
    expect(normaliseMobile('+1 (415) 555-0132')).toBe('+14155550132');
  });

  it('strips the punctuation people actually type', () => {
    expect(normaliseMobile(' +91 95677-91515 ')).toBe('+919567791515');
  });

  it('is idempotent, so re-saving a form does not corrupt the number', () => {
    expect(normaliseMobile(normaliseMobile('9567791515'))).toBe('+919567791515');
  });

  it('rejects what is not a phone number', () => {
    expect(() => normaliseMobile('not a number')).toThrow(/DDP-ADMIN-009/);
    expect(() => normaliseMobile('123')).toThrow(/DDP-ADMIN-009/);
    expect(() => normaliseMobile('')).toThrow(/DDP-ADMIN-009/);
  });
});

/* ── field validation ────────────────────────────────────────────────────── */

describe('validating what god types', () => {
  it('trims and keeps a name', () => {
    expect(validateOwnerField('name', '  Hari  ')).toBe('Hari');
  });

  it('lower-cases email and allows clearing it', () => {
    expect(validateOwnerField('email', ' Nair@Example.COM ')).toBe('nair@example.com');
    expect(validateOwnerField('email', '')).toBe(null);
  });

  it('rejects a malformed email', () => {
    expect(() => validateOwnerField('email', 'nope')).toThrow(/DDP-ADMIN-010/);
  });

  it('refuses a field that is not on the list', () => {
    // Without this an edit form could be used to write pw_hash directly.
    expect(() => validateOwnerField('pw_hash', 'x')).toThrow(/DDP-ADMIN-010/);
  });

  it('rejects a negative amount', () => {
    expect(() => validateBillField('gas_amount', -5)).toThrow(/DDP-ADMIN-010/);
  });

  it('rejects a status that is not real', () => {
    expect(() => validateBillField('status', 'sort-of-paid')).toThrow(/DDP-ADMIN-010/);
    expect(validateBillField('status', 'waived')).toBe('waived');
  });
});

/* ── the record ──────────────────────────────────────────────────────────── */

describe('every edit leaves a record', () => {
  it('records before AND after', () => {
    // "changed the total" is worthless; "329 to 200" is the entire point.
    expect(diff({ entity: 'bill', id: 7, field: 'total', before: 329, after: 200, reason: 'AGM' }))
      .toEqual({ entity: 'bill', id: 7, field: 'total', before: 329, after: 200, reason: 'AGM' });
  });

  it('writes nothing when nothing changed', () => {
    expect(diff({ entity: 'owner', id: 2, field: 'name', before: 'Hari', after: 'Hari' })).toBe(null);
  });

  it('requires a reason for money', () => {
    for (const f of [...BILL_COMPONENTS, 'total', 'status']) {
      expect(reasonRequired(f), f).toBe(true);
      expect(() => checkReason(f, '  ')).toThrow(/DDP-ADMIN-011/);
    }
    expect(checkReason('total', 'Goodwill — meter fault')).toBe('Goodwill — meter fault');
  });

  it('does not require one for a typo in a name', () => {
    expect(reasonRequired('name')).toBe(false);
    expect(checkReason('name', null)).toBe(null);
  });

  it('keeps an optional reason when one is given anyway', () => {
    expect(checkReason('email', 'bounced')).toBe('bounced');
  });
});

/* ── regressions ─────────────────────────────────────────────────────────── */

describe('one number has exactly one stored spelling', () => {
  // Both of these were live bugs, found by calling the endpoints rather than
  // by reading the code.
  //
  // 1. A god edit stored '+919567791515' while seeded rows held '9567791515'.
  //    The duplicate check compared raw strings, so two accounts ended up
  //    sharing a login number — and the UNIQUE index could not see it either,
  //    because the two spellings genuinely are different strings.
  // 2. Login stripped the input to bare digits and compared against the stored
  //    value, so anyone already converted to E.164 could not log in at all.
  //
  // Both reduce to the same invariant: every path that touches a mobile must
  // put it through normaliseMobile first.
  it('collapses every spelling of one number to a single value', () => {
    const spellings = [
      '9567791515', '+919567791515', '+91 95677 91515',
      '95677-91515', ' +91-9567791515 ', '(95677) 91515',
    ];
    expect(new Set(spellings.map(normaliseMobile)).size).toBe(1);
    expect(normaliseMobile(spellings[0])).toBe('+919567791515');
  });

  it('does not collapse two genuinely different numbers', () => {
    expect(normaliseMobile('9567791515')).not.toBe(normaliseMobile('9846466511'));
    // Same trailing digits, different country — must stay distinct.
    expect(normaliseMobile('+919567791515')).not.toBe(normaliseMobile('+19567791515'));
  });

  it('validateOwnerField normalises too, so no path can skip it', () => {
    expect(validateOwnerField('mobile', '9567791515')).toBe('+919567791515');
  });
});
