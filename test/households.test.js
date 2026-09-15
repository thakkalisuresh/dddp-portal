import { describe, it, expect } from 'vitest';
import {
  householdOf, householdIds, roomFor, successorFor, occupantOf,
  billAccess, HOUSEHOLD_LIMITS,
} from '../functions/lib/tenancy.js';

/**
 * A flat holds three owner logins and two tenant ones, and they share one bill.
 *
 * The rule these pin down is the one that was wrong before: a bill names ONE
 * person, and every reader matched on that person's id, so the second and third
 * joint owner opened the portal to an empty dashboard. They now match on the
 * household — the accounts active on the flat in the same party — while the two
 * parties stay separate, which is what keeps a landlord out of their tenant's
 * screenshots.
 */

const p = (id, relationship, over = {}) => ({
  id, flat: '5B', name: `P${id}`, relationship, active: 1, role: 'owner', ...over,
});

const THREE_OWNERS = [p(1, 'owner'), p(2, 'owner'), p(3, 'owner')];
const LET = [p(1, 'owner'), p(2, 'owner'), p(7, 'tenant'), p(8, 'tenant')];

describe('who counts as one household', () => {
  it('is everyone active on the flat in the same party', () => {
    expect(householdIds(THREE_OWNERS, p(2, 'owner'))).toEqual([1, 2, 3]);
    expect(householdIds(LET, p(7, 'tenant'))).toEqual([7, 8]);
    expect(householdIds(LET, p(1, 'owner'))).toEqual([1, 2]);
  });

  it('leaves out whoever has moved on', () => {
    const people = [p(1, 'owner'), p(2, 'owner', { active: 0 }), p(3, 'owner')];
    expect(householdIds(people, p(1, 'owner'))).toEqual([1, 3]);
  });

  it('gives a departed viewer nothing — not even their own household', () => {
    expect(householdOf(THREE_OWNERS, p(9, 'owner', { active: 0 }))).toEqual([]);
  });
});

describe('what a bill is raised against', () => {
  it('is the first registered of the occupying party, whatever order rows arrive in', () => {
    expect(occupantOf([p(3, 'owner'), p(1, 'owner'), p(2, 'owner')]).id).toBe(1);
    expect(occupantOf([p(9, 'tenant'), p(7, 'tenant'), p(1, 'owner')]).id).toBe(7);
  });
});

describe('what each person may see of it', () => {
  it('shows the whole owning household the bill, not just the one it names', () => {
    for (const viewer of THREE_OWNERS) {
      const access = billAccess({ viewer, people: THREE_OWNERS });
      expect(access, `owner ${viewer.id}`).toMatchObject({ amounts: true, proofs: true, canPay: true });
    }
  });

  it('shows both tenants of a let flat the same bill and each other\'s receipts', () => {
    for (const viewer of [p(7, 'tenant'), p(8, 'tenant')]) {
      expect(billAccess({ viewer, people: LET }))
        .toMatchObject({ amounts: true, proofs: true, canPay: true, reason: 'occupant' });
    }
  });

  it('still keeps every landlord out of the tenants\' screenshots', () => {
    for (const viewer of [p(1, 'owner'), p(2, 'owner')]) {
      expect(billAccess({ viewer, people: LET }))
        .toMatchObject({ amounts: true, proofs: false, canPay: false, reason: 'landlord' });
    }
  });

  it('tells somebody from another flat nothing', () => {
    const outsider = { id: 99, flat: '9A', relationship: 'owner', active: 1 };
    expect(billAccess({ viewer: outsider, people: THREE_OWNERS }))
      .toMatchObject({ amounts: false, proofs: false, reason: 'unrelated' });
  });
});

describe('how many logins a flat holds', () => {
  it('is three owners and two tenants', () => {
    expect(HOUSEHOLD_LIMITS).toEqual({ owner: 3, tenant: 2 });
    expect(roomFor([p(1, 'owner'), p(2, 'owner')], 'owner').ok).toBe(true);
    expect(roomFor(THREE_OWNERS, 'owner').ok).toBe(false);
    expect(roomFor([p(7, 'tenant')], 'tenant').ok).toBe(true);
    expect(roomFor([p(7, 'tenant'), p(8, 'tenant')], 'tenant').ok).toBe(false);
  });

  it('counts the parties separately', () => {
    expect(roomFor(LET, 'owner').ok).toBe(true);
    expect(roomFor(LET, 'tenant').ok).toBe(false);
  });

  it('does not count a departed resident against the living', () => {
    const people = [...THREE_OWNERS, p(4, 'owner', { active: 0 })];
    expect(roomFor(people.filter((x) => x.id !== 3), 'owner').ok).toBe(true);
  });

  it('leaves the treasurer out of it', () => {
    // A committee member is an owner living in a flat like anybody else. Three
    // joint owners, one of them the treasurer, must all fit.
    const withAdmin = [p(1, 'owner', { role: 'admin' }), p(2, 'owner'), p(3, 'owner')];
    expect(roomFor(withAdmin, 'owner').ok).toBe(true);
  });

  it('says what to do, not just no', () => {
    expect(roomFor(THREE_OWNERS, 'owner').message).toMatch(/Remove one before adding another/);
  });
});

describe('when one of them leaves', () => {
  it('hands their unsettled bills to the oldest account left', () => {
    expect(successorFor(THREE_OWNERS, p(1, 'owner')).id).toBe(2);
    expect(successorFor(THREE_OWNERS, p(2, 'owner')).id).toBe(1);
  });

  it('keeps the parties apart — a tenant does not inherit the owners\' debt', () => {
    expect(successorFor(LET, p(7, 'tenant')).id).toBe(8);
    expect(successorFor(LET, p(8, 'tenant')).id).toBe(7);
  });

  it('hands them to nobody when the last of a household goes', () => {
    // The flat is changing hands, not losing a member. Those bills stay with
    // the person who owes them; the incoming household must not inherit them.
    expect(successorFor([p(1, 'owner'), p(7, 'tenant')], p(7, 'tenant'))).toBeNull();
  });
});
