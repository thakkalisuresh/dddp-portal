import { describe, it, expect } from 'vitest';
import {
  isCaptureOn, captureWindow, sanitiseClick, validateBatch,
  MAX_WINDOW_HOURS, DEFAULT_WINDOW_HOURS,
} from '../functions/lib/clicks.js';
import { canChangeRole, planHandover, SUPERADMIN_LIMIT } from '../functions/lib/tenancy.js';

const now = '2026-08-07T12:00:00.000Z';

describe('click capture is off unless deliberately on', () => {
  it('is off when unset', () => {
    expect(isCaptureOn(null, now)).toBe(false);
    expect(isCaptureOn({ value: 'off' }, now)).toBe(false);
  });

  it('stays on indefinitely when no window is set', () => {
    // A plain switch, as asked for: on until someone turns it off.
    expect(isCaptureOn({ value: 'on', expires_at: null }, now)).toBe(true);
  });

  it('is on inside its window', () => {
    expect(isCaptureOn({ value: 'on', expires_at: '2026-08-07T14:00:00.000Z' }, now)).toBe(true);
  });

  it('switches itself off when the window closes', () => {
    expect(isCaptureOn({ value: 'on', expires_at: '2026-08-07T11:00:00.000Z' }, now)).toBe(false);
  });

  it('takes no window by default, and caps one when asked for', () => {
    expect(captureWindow(undefined)).toEqual({ hours: null, expiresAt: null });
    expect(captureWindow(2).hours).toBe(2);
    expect(captureWindow(9999).hours).toBe(MAX_WINDOW_HOURS);
  });
});

describe('what a click records', () => {
  it('keeps element identity and the visible label', () => {
    expect(sanitiseClick({ tag: 'BUTTON', id: 'approve', classes: 'btn btn--sm', label: 'Approve', page: '/admin' }))
      .toEqual({ target: 'button#approve.btn.btn--sm', label: 'Approve', page: '/admin' });
  });

  it('NEVER records what someone typed', () => {
    // The label of an input is its value. Recording it would put mobile
    // numbers, and eventually a password, into the log.
    const r = sanitiseClick({ tag: 'input', id: 'mobile', label: '9567791515', page: '/login' });
    expect(r.label).toBe(null);
    expect(r.target).toBe('input#mobile');
  });

  it('drops a credential field entirely, not just its value', () => {
    for (const field of [{ id: 'password' }, { name: 'passwd' }, { type: 'password' },
                         { id: 'otp' }, { label: 'Enter your PIN' }, { id: 'api-token' }]) {
      expect(sanitiseClick({ tag: 'input', page: '/login', ...field }), JSON.stringify(field)).toBe(null);
    }
  });

  it('strips anything that is not a plain identifier', () => {
    const r = sanitiseClick({ tag: 'a"onerror=x', id: 'a<b>c', classes: 'x"y z', label: 'Pay ₹329.04', page: '/p' });
    expect(r.target).toMatch(/^[a-z0-9.#_-]+$/i);
  });

  it('truncates a long label rather than storing an essay', () => {
    const r = sanitiseClick({ tag: 'div', label: 'x'.repeat(500), page: '/p' });
    expect(r.label.length).toBeLessThanOrEqual(80);
  });

  it('collapses whitespace so the log stays readable', () => {
    expect(sanitiseClick({ tag: 'button', label: '  Mark   paid \n', page: '/p' }).label).toBe('Mark paid');
  });

  it('ignores an event with no element', () => {
    expect(sanitiseClick({ tag: '', page: '/p' })).toBe(null);
  });
});

describe('batches', () => {
  it('filters out everything unusable and keeps the rest', () => {
    const out = validateBatch([
      { tag: 'button', label: 'Approve', page: '/a' },
      { tag: 'input', id: 'password', page: '/a' },
      { tag: '', page: '/a' },
    ]);
    expect(out).toHaveLength(1);
  });

  it('refuses a batch large enough to be abuse', () => {
    expect(() => validateBatch(Array(101).fill({ tag: 'div', page: '/a' }))).toThrow(/DDP-NOTICE-004/);
  });

  it('refuses a non-array', () => {
    expect(() => validateBatch('clicks')).toThrow(/DDP-NOTICE-003/);
  });
});

describe('there is exactly one superadmin', () => {
  const su = { id: 1, role: 'superadmin', active: 1 };
  const admin = { id: 2, role: 'admin', active: 1 };

  it('caps the role at one', () => {
    expect(SUPERADMIN_LIMIT).toBe(1);
  });

  it('refuses to promote a second one', () => {
    const r = canChangeRole({ target: admin, newRole: 'superadmin', superadminCount: 1 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/only be one superadmin/i);
  });

  it('refuses to demote the only one', () => {
    expect(canChangeRole({ target: su, newRole: 'admin', superadminCount: 1 }).ok).toBe(false);
  });

  it('so the role can only ever MOVE, never be created or destroyed', () => {
    // Both edits are blocked in isolation; handover is the only route.
    expect(canChangeRole({ target: admin, newRole: 'superadmin', superadminCount: 1 }).ok).toBe(false);
    expect(canChangeRole({ target: su, newRole: 'admin', superadminCount: 1 }).ok).toBe(false);
    expect(planHandover({ from: su, to: admin }).ok).toBe(true);
  });

  it('leaves ordinary admin changes alone — an AGM turns those over freely', () => {
    expect(canChangeRole({ target: { role: 'owner' }, newRole: 'admin', superadminCount: 1 }).ok).toBe(true);
    expect(canChangeRole({ target: admin, newRole: 'owner', superadminCount: 1 }).ok).toBe(true);
  });
});

describe('handing the role over', () => {
  const su = { id: 1, name: 'Sabarish', role: 'superadmin', active: 1 };
  const admin = { id: 2, name: 'Mukesh', role: 'admin', active: 1 };

  it('promotes the incoming holder and demotes the outgoing one', () => {
    expect(planHandover({ from: su, to: admin }).steps).toEqual([
      { id: 2, role: 'superadmin' },
      { id: 1, role: 'admin' },
    ]);
  });

  it('leaves the outgoing holder as an admin, not locked out', () => {
    expect(planHandover({ from: su, to: admin }).steps[1].role).toBe('admin');
  });

  it('only the current superadmin may hand it over', () => {
    expect(planHandover({ from: admin, to: su }).ok).toBe(false);
  });

  it('refuses a handover to oneself', () => {
    expect(planHandover({ from: su, to: su }).ok).toBe(false);
  });

  it('refuses a handover to someone who has moved out', () => {
    expect(planHandover({ from: su, to: { ...admin, active: 0 } }).ok).toBe(false);
  });
});
