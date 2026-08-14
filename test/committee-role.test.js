import { describe, it, expect } from 'vitest';
import { ROLE_RANK, hasRole, committeeMayUse } from '../functions/lib/session.js';
import { isCommittee, canSeeNotice, canManageNotice } from '../functions/lib/notices.js';
import { ROLES, canChangeRole, canResetPassword } from '../functions/lib/tenancy.js';
import { validateOwnerField } from '../functions/lib/godedit.js';

/**
 * The committee member: a resident who can post notices and do nothing else.
 *
 * The role is the first one that is not simply "an admin with more" or "an
 * admin with less" — it sits below admin on the ladder and reaches past it for
 * exactly one thing. That shape is what these tests are about. Two failures
 * would matter and they fail in opposite directions:
 *
 *   - the role leaking UPWARDS, reaching billing, the roster or the resident
 *     directory because a gate was written as "not an owner" rather than "at
 *     least an admin"
 *   - the role leaking SIDEWAYS, editing a notice somebody else posted
 */

const session = (role, id = 7) => ({ actor: { id, role }, subject: { id, role } });

describe('the ladder', () => {
  it('puts committee between an owner and an admin', () => {
    expect(ROLE_RANK.owner).toBeLessThan(ROLE_RANK.committee);
    expect(ROLE_RANK.committee).toBeLessThan(ROLE_RANK.admin);
    expect(ROLE_RANK.admin).toBeLessThan(ROLE_RANK.superadmin);
  });

  it('refuses a committee member everything gated on admin', () => {
    // THE LOAD-BEARING ASSERTION. Every admin route in the router is guarded by
    // exactly this call, and none of them were edited to add the new role. If
    // this ever returns true, all of them open at once.
    expect(hasRole(session('committee'), 'admin')).toBe(false);
    expect(hasRole(session('committee'), 'superadmin')).toBe(false);
  });

  it('still counts a committee member as at least a resident', () => {
    expect(hasRole(session('committee'), 'owner')).toBe(true);
  });

  it('did not disturb the roles that already existed', () => {
    expect(hasRole(session('admin'), 'admin')).toBe(true);
    expect(hasRole(session('superadmin'), 'admin')).toBe(true);
    expect(hasRole(session('owner'), 'admin')).toBe(false);
    expect(hasRole(session('admin'), 'superadmin')).toBe(false);
  });

  it('lists the roles in the same order as the ladder', () => {
    // Two spellings of one fact — ROLES drives the god-edit select and
    // canChangeRole, ROLE_RANK drives every gate. They drifting apart is how a
    // role becomes selectable but meaningless, or ranked but unassignable.
    expect(ROLES).toEqual([...ROLES].sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]));
    expect(ROLES).toContain('committee');
    expect(Object.keys(ROLE_RANK).sort()).toEqual([...ROLES].sort());
  });
});

describe('the one gate a committee member gets past', () => {
  const allowed = [
    ['POST', '/api/admin/notices'],
    ['PATCH', '/api/admin/notices/12'],
    ['POST', '/api/admin/notices/12/attachments'],
    ['GET', '/api/admin/notices/archive'],
    ['GET', '/api/admin/notices/12/archived'],
    ['DELETE', '/api/admin/attachments/3'],
  ];

  for (const [method, path] of allowed) {
    it(`admits ${method} ${path}`, () => {
      expect(committeeMayUse(method, path)).toBe(true);
    });
  }

  const refused = [
    // The rest of the admin console. Not one of these is a notice.
    ['GET', '/api/admin/residents'],
    ['POST', '/api/admin/residents'],
    ['PATCH', '/api/admin/residents/4'],
    ['POST', '/api/admin/residents/4/reset/email'],
    ['GET', '/api/admin/contact-requests'],
    ['POST', '/api/admin/contact-requests/2/approve'],
    ['GET', '/api/admin/bills'],
    ['POST', '/api/admin/readings'],
    ['GET', '/api/admin/roster'],
    // Moderation. Hiding a reply is an admin's act, not a poster's.
    ['POST', '/api/admin/comments/9/hidden'],
    // The method matters as much as the path: reading the notice list is one
    // permission, destroying a notice is another and lives under /god anyway.
    ['DELETE', '/api/admin/notices/12'],
    ['PUT', '/api/admin/notices'],
  ];

  for (const [method, path] of refused) {
    it(`refuses ${method} ${path}`, () => {
      expect(committeeMayUse(method, path)).toBe(false);
    });
  }

  it('does not match a notice path with something appended to it', () => {
    // The patterns are anchored. Without the $ a path could carry a further
    // segment past the id and still match the edit route.
    expect(committeeMayUse('PATCH', '/api/admin/notices/12/purge')).toBe(false);
    expect(committeeMayUse('POST', '/api/admin/notices/12/attachments/5')).toBe(false);
    expect(committeeMayUse('POST', '/api/admin/noticesXX')).toBe(false);
  });

  it('does not match a non-numeric id', () => {
    expect(committeeMayUse('PATCH', '/api/admin/notices/me')).toBe(false);
  });
});

describe('what a committee member can read', () => {
  const committeeTenant = { id: 7, role: 'committee', relationship: 'tenant' };

  it('counts as committee', () => {
    expect(isCommittee({ role: 'committee' })).toBe(true);
    expect(isCommittee({ role: 'admin' })).toBe(true);
    expect(isCommittee({ role: 'superadmin' })).toBe(true);
    expect(isCommittee({ role: 'owner' })).toBe(false);
    expect(isCommittee(null)).toBe(false);
  });

  it('sees an owners-only notice even as a tenant', () => {
    // Same reasoning as the admin who is a tenant: they can post an owners-only
    // notice, so being unable to read it back would be incoherent.
    expect(canSeeNotice('owners', committeeTenant)).toBe(true);
  });

  it('does not widen anything for an ordinary tenant', () => {
    expect(canSeeNotice('owners', { role: 'owner', relationship: 'tenant' })).toBe(false);
  });
});

describe('what a committee member can change', () => {
  const committee = { id: 7, role: 'committee' };
  const otherCommittee = { id: 8, role: 'committee' };
  const admin = { id: 2, role: 'admin' };
  const resident = { id: 9, role: 'owner' };

  const theirs = { id: 1, posted_by: 7 };
  const somebodyElses = { id: 2, posted_by: 8 };
  const legacy = { id: 3, posted_by: null };

  it('lets them manage a notice they posted', () => {
    expect(canManageNotice(theirs, committee)).toBe(true);
  });

  it('refuses a notice somebody else posted', () => {
    // The sideways leak. A committee member with the edit route open to them
    // and no ownership test could rewrite the treasurer's bill announcement.
    expect(canManageNotice(somebodyElses, committee)).toBe(false);
    expect(canManageNotice(theirs, otherCommittee)).toBe(false);
  });

  it('refuses a notice posted before authorship was recorded', () => {
    // posted_by is NULL on every notice that predates the column. NULL must not
    // read as "unowned, therefore anybody's".
    expect(canManageNotice(legacy, committee)).toBe(false);
    expect(canManageNotice({ id: 4, posted_by: undefined }, committee)).toBe(false);
  });

  it('never lets an ordinary resident manage anything', () => {
    expect(canManageNotice(theirs, resident)).toBe(false);
    // Not even one they somehow appear against — the role is checked first.
    expect(canManageNotice({ id: 5, posted_by: 9 }, resident)).toBe(false);
  });

  it('lets an admin manage every notice, including the legacy ones', () => {
    for (const notice of [theirs, somebodyElses, legacy]) {
      expect(canManageNotice(notice, admin)).toBe(true);
      expect(canManageNotice(notice, { id: 1, role: 'superadmin' })).toBe(true);
    }
  });

  it('refuses a missing notice rather than throwing', () => {
    // The DELETE-attachment path passes null deliberately: an attachment on a
    // COMMENT has no parent notice, and that must read as a refusal.
    expect(canManageNotice(null, committee)).toBe(false);
    expect(canManageNotice(null, admin)).toBe(false);
  });
});

describe('granting the role', () => {
  it('is a role the superadmin can assign', () => {
    expect(canChangeRole({
      target: { role: 'owner' }, newRole: 'committee', superadminCount: 1,
    })).toEqual({ ok: true });
  });

  it('passes validation on the god-edit page', () => {
    expect(validateOwnerField('role', 'committee')).toBe('committee');
  });

  it('still refuses a role that does not exist', () => {
    expect(() => validateOwnerField('role', 'treasurer')).toThrow();
    expect(canChangeRole({
      target: { role: 'owner' }, newRole: 'treasurer', superadminCount: 1,
    }).ok).toBe(false);
  });

  it('does not let the superadmin seat be duplicated through the new role', () => {
    // Guarding that inserting a rung did not disturb the one-superadmin rule.
    expect(canChangeRole({
      target: { role: 'committee' }, newRole: 'superadmin', superadminCount: 1,
    }).ok).toBe(false);
  });
});

describe('a committee member is still an ordinary resident', () => {
  it('can have their password reset by an admin during a mail outage', () => {
    // The outage fallback keys on target.role === 'owner'. A new role that the
    // condition simply stops matching would lock exactly these residents out of
    // it, silently, and only while the mailbox was down — the worst time.
    expect(canResetPassword({
      actor: { id: 2, role: 'admin' },
      target: { id: 7, role: 'committee' },
      mailConfigured: false,
    })).toEqual({ ok: true, degraded: true });
  });

  it('cannot reset anybody else', () => {
    expect(canResetPassword({
      actor: { id: 7, role: 'committee' },
      target: { id: 9, role: 'owner' },
      mailConfigured: false,
    }).ok).toBe(false);
  });

  it('is not held open once the mailbox exists', () => {
    expect(canResetPassword({
      actor: { id: 2, role: 'admin' },
      target: { id: 7, role: 'committee' },
      mailConfigured: true,
    }).ok).toBe(false);
  });
});
