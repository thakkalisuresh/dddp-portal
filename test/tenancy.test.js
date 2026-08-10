import { describe, it, expect } from 'vitest';
import {
  outstandingFor, canChangeRole, mergeTimeline, toIST, canResetPassword,
  canEditResident, waLink,
} from '../functions/lib/tenancy.js';

describe('what the outgoing owner leaves behind', () => {
  const bills = [
    { id: 1, period: '2026-05', total: 315.04, status: 'paid' },
    { id: 2, period: '2026-06', total: 329.04, status: 'unpaid' },
    { id: 3, period: '2026-07', total: 342.04, status: 'initiated' },
    { id: 4, period: '2026-04', total: 299.04, status: 'waived' },
  ];

  it('counts everything not actually settled', () => {
    // 'initiated' is a claim, not a payment — it still owes until approved.
    const o = outstandingFor(bills);
    expect(o.count).toBe(2);
    expect(o.total).toBe(671.08);
  });

  it('treats waived as settled', () => {
    expect(outstandingFor([{ id: 1, total: 100, status: 'waived' }]).count).toBe(0);
  });

  it('reports zero for a clean handover', () => {
    expect(outstandingFor([{ id: 1, total: 100, status: 'paid' }])).toMatchObject({ count: 0, total: 0 });
  });

  it('handles a flat with no history at all', () => {
    expect(outstandingFor([])).toMatchObject({ count: 0, total: 0 });
  });
});

describe('changing who administers the building', () => {
  const su = { id: 1, role: 'superadmin' };
  const admin = { id: 2, role: 'admin' };

  it('lets an AGM promote and demote ordinary admins', () => {
    expect(canChangeRole({ target: admin, newRole: 'owner', superadminCount: 1 }).ok).toBe(true);
    expect(canChangeRole({ target: { role: 'owner' }, newRole: 'admin', superadminCount: 1 }).ok).toBe(true);
  });

  it('refuses to demote the last superadmin', () => {
    // Nobody has database access to undo a full lockout — that is exactly the
    // situation the old site left everyone in.
    const r = canChangeRole({ target: su, newRole: 'admin', superadminCount: 1 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/only superadmin/i);
  });

  it('allows it once a second superadmin exists', () => {
    expect(canChangeRole({ target: su, newRole: 'admin', superadminCount: 2 }).ok).toBe(true);
  });

  it('still allows a superadmin to stay a superadmin', () => {
    expect(canChangeRole({ target: su, newRole: 'superadmin', superadminCount: 1 }).ok).toBe(true);
  });

  it('rejects a role that does not exist', () => {
    expect(canChangeRole({ target: admin, newRole: 'root', superadminCount: 2 }).ok).toBe(false);
  });
});

describe('timestamps the committee can read', () => {
  it('converts UTC to IST', () => {
    expect(toIST('2026-08-07T03:30:00.000Z')).toBe('2026-08-07 09:00:00 IST');
  });

  it('handles the half-hour offset across midnight', () => {
    expect(toIST('2026-08-06T19:00:00.000Z')).toBe('2026-08-07 00:30:00 IST');
  });

  it('passes through anything unparseable rather than inventing a date', () => {
    expect(toIST('not a date')).toBe('not a date');
    expect(toIST(null)).toBe(null);
  });
});

describe('one timeline from three tables', () => {
  const audits = [{ at: '2026-08-07T10:00:00Z', action: 'login', actor_id: 1, actor_name: 'Sabarish', detail: null }];
  const activities = [{ at: '2026-08-07T11:00:00Z', kind: 'page', name: '/dashboard.html', owner_id: 1, owner_name: 'Sabarish' }];
  const errors = [{ at: '2026-08-07T09:00:00Z', code: 'DDP-PAY-002', severity: 'error', message: 'bad amount' }];

  it('interleaves everything newest first', () => {
    const rows = mergeTimeline({ audits, activities, errors });
    expect(rows.map((r) => r.name)).toEqual(['/dashboard.html', 'login', 'DDP-PAY-002']);
  });

  it('labels where each row came from', () => {
    expect(mergeTimeline({ audits, activities, errors }).map((r) => r.source))
      .toEqual(['activity', 'audit', 'error']);
  });

  it('attaches a readable IST stamp to every row', () => {
    for (const row of mergeTimeline({ audits, activities, errors })) {
      expect(row.atIST).toMatch(/IST$/);
    }
  });

  it('keeps the actor distinct from the subject, which is what god mode needs', () => {
    const rows = mergeTimeline({
      audits: [{ at: 'z', action: 'impersonate.start', actor_id: 1, actor_name: 'Sabarish',
                 subject_id: 5, subject_name: 'Rajan' }],
    });
    expect(rows[0].actor).toBe('Sabarish');
    expect(rows[0].subject).toBe('Rajan');
  });

  it('copes with any table being empty', () => {
    expect(mergeTimeline({})).toEqual([]);
    expect(mergeTimeline({ errors })).toHaveLength(1);
  });
});

/* ── who may reset whose password ────────────────────────────────────────── */

describe('canResetPassword', () => {
  const superadmin = { id: 1, role: 'superadmin' };
  const admin      = { id: 2, role: 'admin' };
  const otherAdmin = { id: 3, role: 'admin' };
  const resident   = { id: 4, role: 'owner' };

  it('lets an admin reset a resident — the ordinary case', () => {
    expect(canResetPassword({ actor: admin, target: resident }).ok).toBe(true);
  });

  it('lets the superadmin reset a resident', () => {
    expect(canResetPassword({ actor: superadmin, target: resident }).ok).toBe(true);
  });

  it('REFUSES an admin resetting the superadmin', () => {
    // The hole. Any admin could reset this account, be handed the temporary
    // password, and log in with god mode — so the single-superadmin rule
    // stopped the role being granted while leaving it takeable.
    const v = canResetPassword({ actor: admin, target: superadmin });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/break-glass/i);
  });

  it('refuses even the superadmin resetting themselves through the API', () => {
    // An authenticated session does not need this, and it is the first thing
    // a stolen admin session would reach for.
    expect(canResetPassword({ actor: superadmin, target: superadmin }).ok).toBe(false);
  });

  it('refuses one admin resetting another', () => {
    const v = canResetPassword({ actor: admin, target: otherAdmin });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/only the superadmin/i);
  });

  it('lets the superadmin reset an admin', () => {
    expect(canResetPassword({ actor: superadmin, target: admin }).ok).toBe(true);
  });

  it('refuses a resident resetting anyone', () => {
    expect(canResetPassword({ actor: resident, target: resident }).ok).toBe(false);
  });
});

/* ── who may edit whose contact details ──────────────────────────────────── */

describe('canEditResident', () => {
  const superadmin = { id: 1, role: 'superadmin' };
  const admin      = { id: 2, role: 'admin' };
  const otherAdmin = { id: 3, role: 'admin' };
  const resident   = { id: 4, role: 'owner' };

  it('lets an admin edit a resident — the ordinary case', () => {
    expect(canEditResident({ actor: admin, target: resident }).ok).toBe(true);
  });

  it('REFUSES an admin editing the superadmin', () => {
    // mobile IS the login id. An admin who can move the superadmin's number to
    // a phone they hold takes the account through forgot-password — the reset
    // they were refused, arrived at sideways.
    const v = canEditResident({ actor: admin, target: superadmin });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/only the superadmin/i);
  });

  it('refuses one admin editing another', () => {
    expect(canEditResident({ actor: admin, target: otherAdmin }).ok).toBe(false);
  });

  it('refuses an admin editing their own row from the directory', () => {
    // Not a security boundary — a self-edit is fine — but the directory is the
    // wrong door for it, and letting it through here means an admin can change
    // their own login number in a screen built for other people's details.
    const v = canEditResident({ actor: admin, target: admin });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/profile/i);
  });

  it('lets the superadmin edit an admin, a resident, and themselves', () => {
    expect(canEditResident({ actor: superadmin, target: admin }).ok).toBe(true);
    expect(canEditResident({ actor: superadmin, target: resident }).ok).toBe(true);
    expect(canEditResident({ actor: superadmin, target: superadmin }).ok).toBe(true);
  });

  it('refuses a resident editing anyone, including themselves', () => {
    expect(canEditResident({ actor: resident, target: resident }).ok).toBe(false);
  });

  it('refuses when either side is missing', () => {
    expect(canEditResident({ actor: admin, target: null }).ok).toBe(false);
    expect(canEditResident({ actor: null, target: resident }).ok).toBe(false);
  });
});

describe('waLink', () => {
  it('builds a live link from an E.164 number', () => {
    // 0009 stored '+91…', and the old `wa.me/91${mobile}` then produced
    // 'wa.me/91+919846466511' — a dead link on every password reset.
    expect(waLink('+919846466511', 'hi')).toBe('https://wa.me/919846466511?text=hi');
  });

  it('still handles a bare 10-digit number as Indian', () => {
    expect(waLink('9846466511', 'hi')).toBe('https://wa.me/919846466511?text=hi');
  });

  it('does not prepend 91 to a number that already has a country code', () => {
    expect(waLink('+971501234567', 'hi')).toBe('https://wa.me/971501234567?text=hi');
  });

  it('encodes the message exactly once', () => {
    expect(waLink('+919846466511', 'a b&c')).toBe('https://wa.me/919846466511?text=a%20b%26c');
  });
});
