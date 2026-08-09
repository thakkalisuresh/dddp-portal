import { describe, it, expect } from 'vitest';
import {
  occupantOf, landlordOf, isTenanted, billAccess, describeRelationship,
  planDeparture, isRelationship,
} from '../functions/lib/tenancy.js';

const owner  = (o = {}) => ({ id: 1, flat: '4B', name: 'Nair',  relationship: 'owner',  active: 1, ...o });
const tenant = (o = {}) => ({ id: 2, flat: '4B', name: 'Priya', relationship: 'tenant', active: 1, ...o });

/* ── who pays, who is liable ─────────────────────────────────────────────── */

describe('who is billed for a flat', () => {
  it('bills the tenant when the flat is let', () => {
    expect(occupantOf([owner(), tenant()]).id).toBe(2);
  });

  it('bills the owner when they live there themselves', () => {
    expect(occupantOf([owner()]).id).toBe(1);
  });

  it('bills the owner of a VACANT flat — somebody answers for the meter', () => {
    // A tenant who has left is inactive, so the flat falls back to its owner
    // rather than becoming unbillable.
    expect(occupantOf([owner(), tenant({ active: 0 })]).id).toBe(1);
  });

  it('has nobody to bill when the flat has no active people at all', () => {
    expect(occupantOf([owner({ active: 0 })])).toBe(null);
    expect(occupantOf([])).toBe(null);
  });

  it('holds the owner liable whether or not they live there', () => {
    expect(landlordOf([owner(), tenant()]).id).toBe(1);
    expect(landlordOf([owner()]).id).toBe(1);
  });

  it('reports no landlord when none is on record — a real gap, not a default', () => {
    expect(landlordOf([tenant()])).toBe(null);
  });

  it('knows a let flat from an owner-occupied one', () => {
    expect(isTenanted([owner(), tenant()])).toBe(true);
    expect(isTenanted([owner()])).toBe(false);
    expect(isTenanted([owner(), tenant({ active: 0 })])).toBe(false);
  });
});

/* ── the visibility rules, exactly as specified ──────────────────────────── */

describe('what each person can see', () => {
  const people = [owner(), tenant()];

  it('gives the tenant their own bills in full', () => {
    expect(billAccess({ viewer: tenant(), people }))
      .toMatchObject({ amounts: true, proofs: true, canPay: true });
  });

  it('gives the absent owner AMOUNTS but never the screenshots', () => {
    // The amount is the owner's business because they are liable for it.
    // The screenshot is a bank record belonging to whoever uploaded it.
    expect(billAccess({ viewer: owner(), people }))
      .toMatchObject({ amounts: true, proofs: false, canPay: false, reason: 'landlord' });
  });

  it('gives an owner-occupier everything, since they are the occupant', () => {
    expect(billAccess({ viewer: owner(), people: [owner()] }))
      .toMatchObject({ amounts: true, proofs: true, canPay: true, reason: 'occupant' });
  });

  it('gives someone who has left NOTHING', () => {
    // "Once they leave, no access whatsoever" — history stays for admin/god.
    const gone = tenant({ active: 0 });
    expect(billAccess({ viewer: gone, people: [owner(), gone] }))
      .toMatchObject({ amounts: false, proofs: false, canPay: false, reason: 'departed' });
  });

  it('gives a departed OWNER nothing either — the rule is not role-specific', () => {
    const sold = owner({ active: 0 });
    expect(billAccess({ viewer: sold, people: [sold, tenant()] }).amounts).toBe(false);
  });

  it('gives an unrelated person nothing', () => {
    const other = { id: 9, flat: '5A', relationship: 'owner', active: 1 };
    expect(billAccess({ viewer: other, people }).reason).toBe('unrelated');
  });
});

describe('how a person is described to themselves', () => {
  it('names the relationship plainly', () => {
    expect(describeRelationship({ viewer: tenant(), people: [owner(), tenant()] }))
      .toBe('Tenant of 4B');
    expect(describeRelationship({ viewer: owner(), people: [owner()] }))
      .toBe('Owner of 4B');
  });

  it('tells an owner their flat is let, so a wrong record is visible', () => {
    // This is the whole error-catching mechanism: no confirmation step, just
    // the fact shown where the person will see it.
    expect(describeRelationship({ viewer: owner(), people: [owner(), tenant()] }))
      .toBe('Owner of 4B — let to a tenant');
  });
});

/* ── leaving ─────────────────────────────────────────────────────────────── */

describe('departure', () => {
  const paid = [{ id: 1, period: '2026-06', total: 329, status: 'paid' }];
  const owing = [{ id: 1, period: '2026-06', total: 329, status: 'unpaid' }];

  it('lets a settled tenant go without ceremony', () => {
    const p = planDeparture({ leaver: tenant(), people: [owner(), tenant()], bills: paid });
    expect(p.flag).toBe(null);
    expect(p.steps[0]).toMatchObject({ id: 2, active: 0 });
    expect(p.steps[0].moved_out_at).toBeTruthy();
  });

  it('flags the owner when a tenant leaves owing, without moving the debt', () => {
    // The owner IS liable, but that is a conversation, not a database write
    // that reassigns someone's bills while they are not looking.
    const p = planDeparture({ leaver: tenant(), people: [owner(), tenant()], bills: owing });
    expect(p.flag.kind).toBe('tenant-left-owing');
    expect(p.flag.ownerId).toBe(1);
    expect(p.flag.amount).toBe(329);
    expect(p.flag.message).toMatch(/Nair is liable/);
  });

  it('says plainly when a tenant leaves owing and NO owner is on record', () => {
    // Nobody is liable. Silence here would quietly write off real money.
    const p = planDeparture({ leaver: tenant(), people: [tenant()], bills: owing });
    expect(p.flag.kind).toBe('tenant-left-owing-no-owner');
    expect(p.flag.message).toMatch(/no owner is on record/i);
  });

  it('flags an owner leaving owing, before a sale completes', () => {
    const p = planDeparture({ leaver: owner(), people: [owner()], bills: owing });
    expect(p.flag.kind).toBe('owner-left-owing');
  });

  it('never deletes — departure is deactivation, so history survives', () => {
    const p = planDeparture({ leaver: tenant(), people: [owner(), tenant()], bills: owing });
    expect(p.steps.every((s) => 'active' in s)).toBe(true);
    expect(JSON.stringify(p.steps)).not.toMatch(/delete/i);
  });
});

describe('relationship values', () => {
  it('accepts only the two that exist', () => {
    expect(isRelationship('owner')).toBe(true);
    expect(isRelationship('tenant')).toBe(true);
    expect(isRelationship('occupant')).toBe(false);
    expect(isRelationship('')).toBe(false);
  });
});

describe('one owner cannot read another flat', () => {
  // A live bug: billAccess checked "is an owner" and "this flat is tenanted"
  // without checking the viewer owned THAT flat, so the owner of 5A could read
  // the bill amounts of every let flat in the building.
  it('refuses an owner of a different flat', () => {
    const theirs = [
      { id: 1, flat: '4B', relationship: 'owner', active: 1 },
      { id: 2, flat: '4B', relationship: 'tenant', active: 1 },
    ];
    const nosy = { id: 9, flat: '5A', relationship: 'owner', active: 1 };
    expect(billAccess({ viewer: nosy, people: theirs }))
      .toMatchObject({ amounts: false, proofs: false, reason: 'unrelated' });
  });

  it('still allows the flat\'s own landlord', () => {
    const people = [
      { id: 1, flat: '4B', relationship: 'owner', active: 1 },
      { id: 2, flat: '4B', relationship: 'tenant', active: 1 },
    ];
    expect(billAccess({ viewer: people[0], people }).reason).toBe('landlord');
  });
});
