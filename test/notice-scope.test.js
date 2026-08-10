import { describe, it, expect } from 'vitest';
import { canSeeNotice, NOTICE_SCOPES, listNotices, unreadNoticeCount } from '../functions/lib/notices.js';

/**
 * B9. One predicate decides visibility, and the list, the single notice, the
 * comment endpoint and the unread badge all ask it — four copies of a rule is
 * four chances for one to be wrong, and the wrong one is the leak.
 */

const owner = { id: 1, relationship: 'owner', role: 'owner' };
const tenant = { id: 2, relationship: 'tenant', role: 'owner' };
const absentOwner = { id: 3, relationship: 'owner', role: 'owner' };
const tenantAdmin = { id: 4, relationship: 'tenant', role: 'admin' };

describe('who can see an owners-only notice', () => {
  it('shows everything scoped to all, to everyone', () => {
    for (const viewer of [owner, tenant, absentOwner, tenantAdmin]) {
      expect(canSeeNotice('all', viewer)).toBe(true);
    }
  });

  it('hides owners-only from a tenant', () => {
    expect(canSeeNotice('owners', tenant)).toBe(false);
  });

  it('shows owners-only to an owner, including one living elsewhere', () => {
    // An absent owner is the AUDIENCE for an AGM paper, not an edge case.
    // relationship says nothing about presence and must not be read as if it did.
    expect(canSeeNotice('owners', owner)).toBe(true);
    expect(canSeeNotice('owners', absentOwner)).toBe(true);
  });

  it('shows owners-only to an admin who is a tenant', () => {
    // The admin console lists notices through the resident endpoint. Without
    // this an admin could post a notice and then be unable to see or withdraw it.
    expect(canSeeNotice('owners', tenantAdmin)).toBe(true);
  });

  it('treats an unknown scope as public rather than hiding it', () => {
    // Failing the other way would let a typo silently narrow the audience, and
    // a notice nobody saw looks exactly like a notice nobody answered.
    expect(canSeeNotice('committee-only-typo', tenant)).toBe(true);
    expect(canSeeNotice(undefined, tenant)).toBe(true);
  });

  it('offers exactly the two scopes', () => {
    expect(NOTICE_SCOPES).toEqual(['all', 'owners']);
  });
});

/** Captures the SQL so the clause built from the predicate can be asserted. */
function spyDb(rows = []) {
  let sql = '';
  return {
    get sql() { return sql; },
    prepare(s) {
      sql = s;
      return {
        all: async () => ({ results: rows }),
        bind: () => ({ all: async () => ({ results: rows }), first: async () => ({ n: 0 }) }),
      };
    },
  };
}

describe('the scope reaches the queries, not just the predicate', () => {
  it('narrows the notice list for a tenant and leaves it open for an owner', async () => {
    const forTenant = spyDb();
    await listNotices({ DB: forTenant }, tenant);
    expect(forTenant.sql).toContain("n.scope = 'all'");

    const forOwner = spyDb();
    await listNotices({ DB: forOwner }, owner);
    expect(forOwner.sql).not.toContain("n.scope = 'all'");
  });

  it('narrows the unread badge too', async () => {
    // Missing this would be worse than a leak: a tenant would carry a
    // permanent count for a notice the board never shows them, and opening the
    // tab would not clear it.
    const forTenant = spyDb();
    await unreadNoticeCount({ DB: forTenant }, tenant);
    expect(forTenant.sql).toContain("scope = 'all'");

    const forOwner = spyDb();
    await unreadNoticeCount({ DB: forOwner }, owner);
    expect(forOwner.sql).not.toContain("scope = 'all'");
  });
});
