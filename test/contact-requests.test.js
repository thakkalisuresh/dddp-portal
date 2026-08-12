import { describe, it, expect } from 'vitest';
import {
  validateRequest, requestState, decisionFailure, isStillAChange, requestNotification,
  MAX_REASON,
} from '../functions/lib/contact-requests.js';
import { canEditField, canEditResident, REQUESTABLE_FIELDS } from '../functions/lib/tenancy.js';

const superadmin = { id: 1, role: 'superadmin' };
const admin      = { id: 2, role: 'admin' };
const otherAdmin = { id: 3, role: 'admin' };
const resident   = { id: 4, role: 'owner' };

/* ── who may write which column ──────────────────────────────────────────── */

describe('an admin may fix a name but must ask about a mobile or an address', () => {
  it('lets an admin write a name — the upkeep the directory exists for', () => {
    expect(canEditField({ actor: admin, target: resident, field: 'name' }).ok).toBe(true);
  });

  it('REFUSES an admin writing an email — the takeover vector', () => {
    // forgotPassword finds the account BY MOBILE and mails the code TO THE
    // EMAIL. An admin who can rewrite the address points it at an inbox they
    // hold, asks for a reset against the resident's own number, and receives the
    // code — which is exactly the reset B21 took away from them.
    const v = canEditField({ actor: admin, target: resident, field: 'email' });
    expect(v.ok).toBe(false);
    expect(v.requestInstead).toBe(true);
  });

  it('REFUSES an admin writing a mobile — the lockout vector', () => {
    // Not a takeover: the code still follows the address. But the mobile is the
    // login, so moving it silently stops the resident getting in at all.
    expect(canEditField({ actor: admin, target: resident, field: 'mobile' }).ok).toBe(false);
  });

  it('tells the admin what to do instead, and who decides', () => {
    const v = canEditField({ actor: admin, target: resident, field: 'mobile' });
    expect(v.message).toMatch(/request a change/i);
    expect(v.message).toMatch(/Sabarish/);
  });

  it('lets the superadmin write both', () => {
    for (const field of REQUESTABLE_FIELDS) {
      expect(canEditField({ actor: superadmin, target: resident, field }).ok, field).toBe(true);
    }
  });

  it('still refuses the row before it gets to the column', () => {
    // An admin editing another admin is refused whatever the field is — the row
    // ladder runs first, so a name is not a loophole into an admin's account.
    expect(canEditField({ actor: admin, target: otherAdmin, field: 'name' }).ok).toBe(false);
    expect(canEditResident({ actor: admin, target: otherAdmin }).ok).toBe(false);
  });

  it('covers every requestable field, so adding one cannot silently open it', () => {
    for (const field of REQUESTABLE_FIELDS) {
      expect(canEditField({ actor: admin, target: resident, field }).ok, field).toBe(false);
    }
  });
});

/* ── raising one ─────────────────────────────────────────────────────────── */

describe('raising a request', () => {
  it('normalises the value, so what is approved is what was reviewed', () => {
    // Storing the raw typing would approve into something different from what
    // appeared on the superadmin's screen.
    expect(validateRequest({ field: 'mobile', value: '9567791515', reason: 'new number' }).value)
      .toBe('+919567791515');
    expect(validateRequest({ field: 'email', value: ' Nair@Example.COM ', reason: 'bounced' }).value)
      .toBe('nair@example.com');
  });

  it('refuses a malformed value at request time, not at approval', () => {
    // The admin is still standing with the resident and can ask again. The same
    // refusal in front of the superadmin days later can only be a rejection.
    expect(() => validateRequest({ field: 'mobile', value: '987654321', reason: 'x y z' }))
      .toThrow(/DDP-ADMIN-009/);
    expect(() => validateRequest({ field: 'email', value: 'nope', reason: 'x y z' }))
      .toThrow(/DDP-ADMIN-010/);
  });

  it('requires a reason', () => {
    expect(() => validateRequest({ field: 'mobile', value: '9567791515', reason: '' }))
      .toThrow(/DDP-ADMIN-011/);
    expect(() => validateRequest({ field: 'mobile', value: '9567791515', reason: '  ' }))
      .toThrow(/DDP-ADMIN-011/);
  });

  it('caps the reason rather than rejecting a long one', () => {
    const r = validateRequest({ field: 'email', value: 'a@b.com', reason: 'x'.repeat(1000) });
    expect(r.reason.length).toBe(MAX_REASON);
  });

  it('allows clearing an email but NEVER a mobile', () => {
    // An address can legitimately be removed. The mobile is the login: emptying
    // it locks the resident out with no way back in.
    expect(validateRequest({ field: 'email', value: '', reason: 'bounces' }).value).toBe(null);
    expect(() => validateRequest({ field: 'mobile', value: '', reason: 'no phone' }))
      .toThrow(/DDP-ADMIN-009/);
  });

  it('refuses a field nobody may request', () => {
    // Without this the endpoint is a way to write any column on owners, which
    // includes pw_hash and role.
    for (const field of ['name', 'role', 'pw_hash', 'flat', '', null]) {
      expect(() => validateRequest({ field, value: 'x', reason: 'because' }), String(field))
        .toThrow();
    }
  });
});

/* ── deciding one ────────────────────────────────────────────────────────── */

describe('deciding a request', () => {
  it('is open while pending', () => {
    expect(requestState({ state: 'pending' }).open).toBe(true);
  });

  it('cannot be decided twice', () => {
    // Two admins on one queue is the ordinary case, so "already approved" has to
    // be distinguishable from "no such request".
    expect(requestState({ state: 'approved' })).toMatchObject({ open: false, reason: 'approved' });
    expect(requestState({ state: 'rejected' })).toMatchObject({ open: false, reason: 'rejected' });
    expect(requestState(null)).toMatchObject({ open: false, reason: 'none' });
    expect(decisionFailure('approved')).toMatch(/already been approved/i);
    expect(decisionFailure('none')).toMatch(/no longer exists/i);
  });

  it('notices when the change has already happened by other means', () => {
    // The resident may have fixed it themselves from their profile. Applying it
    // anyway would write an audit row claiming a change that did not occur.
    const row = { field: 'mobile', requested_value: '+919567791515' };
    expect(isStillAChange(row, { mobile: '+919567791515' })).toBe(false);
    expect(isStillAChange(row, { mobile: '+919846466511' })).toBe(true);
  });

  it('treats null and empty as the same absence', () => {
    const row = { field: 'email', requested_value: null };
    expect(isStillAChange(row, { email: null })).toBe(false);
    expect(isStillAChange(row, { email: '' })).toBe(false);
    expect(isStillAChange(row, { email: 'a@b.com' })).toBe(true);
  });
});

/* ── the notification ────────────────────────────────────────────────────── */

describe('the Telegram nudge', () => {
  const text = requestNotification({ flat: '7B', field: 'mobile', requestedBy: 'Mukesh' });

  it('says what is waiting and who asked', () => {
    expect(text).toContain('7B');
    expect(text).toContain('mobile');
    expect(text).toContain('Mukesh');
  });

  it('CARRIES NO VALUE', () => {
    // TELEGRAM_CHAT_ID is one shared chat — the same one alerting and the digest
    // use. A resident's new number or home address is not something to put where
    // everybody with access to that chat reads it; PRIVACY.md accounts for error
    // codes and counts going there, not personal contact details.
    const withValue = requestNotification({
      flat: '7B', field: 'mobile', requestedBy: 'Mukesh',
      value: '+919567791515', email: 'priya@example.com',
    });
    expect(withValue).not.toMatch(/9567791515|priya|example\.com/);
  });

  it('points at where the decision is made', () => {
    expect(text).toMatch(/residents/i);
  });
});
