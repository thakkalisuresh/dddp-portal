/**
 * The one control on the Residents tab: who is in a flat, and whether it is
 * billed at all.
 *
 * Everything here is pure. `planOccupancy` returns the writes to make rather
 * than making them, for the same reason planDeparture and planHandover do —
 * the decisions are the part worth testing, and they are only testable without
 * a database if they are separate from the writing.
 *
 * The invariant these tests exist to hold: NO STORED STATE. Migration 0011
 * rejected a three-state column because the copies drift, so every assertion
 * about "what state is this flat in" goes through occupancyOf reading rows.
 */

import { describe, it, expect } from 'vitest';
import {
  occupancyOf, occupancyLabel, OCCUPANCY_STATES, planOccupancy, contactClash,
  monthToISO, isoToMonth, isoToMonthInput, occupantOf, landlordOf,
} from '../functions/lib/tenancy.js';

const owner = (o = {}) => ({ id: 1, flat: '4B', name: 'Nair', mobile: '+919846466511',
                             relationship: 'owner', active: 1, ...o });
const tenant = (o = {}) => ({ id: 2, flat: '4B', name: 'Priya', mobile: '+919846400002',
                              relationship: 'tenant', active: 1, moved_in_at: '2026-08-01', ...o });

const NOW = '2026-08-20T06:00:00.000Z';

/* ── the state is read, never stored ─────────────────────────────────────── */

describe('what state a flat is in', () => {
  it('reads the three the dropdown offers off the rows', () => {
    expect(occupancyOf([])).toBe('none');
    expect(occupancyOf([owner()])).toBe('owner');
    expect(occupancyOf([owner(), tenant()])).toBe('owner+tenant');
  });

  it('calls a flat whose people have all left "none", not "owner"', () => {
    // Departure is active = 0 and never a delete, so the rows are still there.
    expect(occupancyOf([owner({ active: 0 }), tenant({ active: 0 })])).toBe('none');
  });

  it('names the fourth state instead of pretending it cannot happen', () => {
    // Deactivate the owner of a let flat and you are in it without choosing it.
    // diagnostics has warned about it as TENANT-NO-OWNER all along.
    expect(occupancyOf([owner({ active: 0 }), tenant()])).toBe('tenant-only');
    expect(occupancyOf([tenant()])).toBe('tenant-only');
  });

  it('never offers the fourth state as something to select', () => {
    expect(OCCUPANCY_STATES).toEqual(['none', 'owner', 'owner+tenant']);
    expect(OCCUPANCY_STATES).not.toContain('tenant-only');
    // But it can still be described, or the flats already in it get a label
    // that lies about them.
    expect(occupancyLabel('tenant-only')).toMatch(/no owner/i);
  });

  it('agrees with who is billed and who is liable', () => {
    const let_ = [owner(), tenant()];
    expect(occupancyOf(let_)).toBe('owner+tenant');
    expect(occupantOf(let_).id).toBe(2);
    expect(landlordOf(let_).id).toBe(1);

    const orphan = [tenant()];
    expect(occupancyOf(orphan)).toBe('tenant-only');
    expect(occupantOf(orphan).id).toBe(2);
    expect(landlordOf(orphan)).toBe(null);   // the gap the state names
  });
});

/* ── dates ───────────────────────────────────────────────────────────────── */

describe('when a tenancy started', () => {
  it('stores the month as the first of it, in ISO', () => {
    expect(monthToISO('2026-08')).toBe('2026-08-01');
    expect(monthToISO('2026-12')).toBe('2026-12-01');
  });

  it('refuses anything that is not a month', () => {
    for (const bad of ['08/26', '2026-13', '2026', '', null, 'August 2026']) {
      expect(monthToISO(bad)).toBe(null);
    }
  });

  it('sorts correctly, which mm/yy would not', () => {
    // The whole reason for the rule: '01/27' sorts before '08/26' as a string,
    // so every comparison against moved_out_at or a bill period is wrong.
    const iso = ['2027-01', '2026-08'].map(monthToISO).sort();
    expect(iso).toEqual(['2026-08-01', '2027-01-01']);
    expect(['01/27', '08/26'].sort()).toEqual(['01/27', '08/26']);   // wrong order, on purpose
  });

  it('shows the short form without storing it', () => {
    expect(isoToMonth('2026-08-01')).toBe('08/26');
    expect(isoToMonth('2026-08-01T00:00:00.000Z')).toBe('08/26');
    expect(isoToMonthInput('2026-08-01')).toBe('2026-08');
    expect(isoToMonth('nonsense')).toBe(null);
  });
});

/* ── the number is the login id ──────────────────────────────────────────── */

describe('the owner and the tenant cannot share a number', () => {
  it('catches it before the NOT NULL UNIQUE constraint does', () => {
    const clash = contactClash({
      owner: { mobile: '+919846466511' },
      tenant: { mobile: '9846466511' },   // same number, different spelling
    });
    expect(clash.field).toBe('mobile');
    expect(clash.message).toMatch(/login id/i);
  });

  it('catches a shared email too — that is where a reset code goes', () => {
    const clash = contactClash({
      owner: { mobile: '+919846466511', email: 'A@x.com' },
      tenant: { mobile: '+919846400002', email: 'a@x.com' },
    });
    expect(clash.field).toBe('email');
  });

  it('is happy when they are different, or when one is blank', () => {
    expect(contactClash({ owner: { mobile: '+919846466511' },
                          tenant: { mobile: '+919846400002' } })).toBe(null);
    expect(contactClash({ owner: { mobile: '+919846466511', email: 'a@x.com' },
                          tenant: { mobile: '+919846400002', email: null } })).toBe(null);
  });

  it('refuses the whole plan rather than emitting a doomed insert', () => {
    const r = planOccupancy({
      people: [], to: 'owner+tenant', tenancyStart: '2026-08', now: NOW,
      owner: { name: 'Nair', mobile: '+919846466511' },
      tenant: { name: 'Priya', mobile: '+919846466511' },
    });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('mobile');
  });
});

/* ── nobody on file ──────────────────────────────────────────────────────── */

describe('setting a flat to "no owner"', () => {
  it('deactivates everybody rather than deleting them', () => {
    const r = planOccupancy({
      people: [owner(), tenant()], to: 'none', billing: 'stop',
      reason: 'Sold, the buyer has not moved in', now: NOW,
    });
    expect(r.ok).toBe(true);
    const gone = r.steps.filter((s) => s.op === 'deactivate');
    expect(gone.map((s) => s.id).sort()).toEqual([1, 2]);
    expect(gone.every((s) => s.moved_out_at === NOW)).toBe(true);
    expect(JSON.stringify(r.steps)).not.toMatch(/delete/i);
  });

  it('will not proceed without an answer about the billing', () => {
    // The jam this control exists to close: nobody to bill, and the flat still
    // on the reading grid demanding a reading that will never be entered.
    const r = planOccupancy({ people: [owner()], to: 'none', billed: true, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('billing');
    expect(r.message).toMatch(/no month can close/i);
  });

  it('does NOT set flats.active = 0 by itself — it makes somebody choose', () => {
    // Owned-and-empty still bills its owner, which is a different thing from
    // unsold, so the mapping is asked for rather than inferred.
    const keep = planOccupancy({ people: [owner()], to: 'none', billed: true,
                                 billing: 'keep', now: NOW });
    expect(keep.ok).toBe(true);
    expect(keep.steps.some((s) => s.op === 'flat')).toBe(false);
    expect(keep.warnings[0].kind).toBe('billed-with-nobody-on-file');
  });

  it('writes flats.active = 0 with the reason when that is the answer', () => {
    const r = planOccupancy({ people: [owner()], to: 'none', billed: true,
                              billing: 'stop', reason: 'Unsold — nobody on file', now: NOW });
    expect(r.steps.find((s) => s.op === 'flat'))
      .toMatchObject({ active: 0, reason: 'Unsold — nobody on file' });
  });

  it('demands a reason, because an excluded flat is invisible by construction', () => {
    const r = planOccupancy({ people: [owner()], to: 'none', billed: true,
                              billing: 'stop', reason: '  ', now: NOW });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('reason');
  });

  it('asks nothing about billing when the flat is already off the roll', () => {
    const r = planOccupancy({ people: [owner()], to: 'none', billed: false, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.steps.some((s) => s.op === 'flat')).toBe(false);
  });
});

/* ── an owner ────────────────────────────────────────────────────────────── */

describe('setting a flat to "owner"', () => {
  it('adds the owner when nobody is on file', () => {
    const r = planOccupancy({
      people: [], to: 'owner', billed: true, now: NOW,
      owner: { name: 'Nair', mobile: '+919846466511', email: 'nair@x.com' },
    });
    expect(r.steps).toEqual([{
      op: 'add', relationship: 'owner', name: 'Nair', mobile: '+919846466511',
      email: 'nair@x.com', moved_in_at: '2026-08-20',
    }]);
  });

  it('needs a name and a number', () => {
    expect(planOccupancy({ people: [], to: 'owner', owner: { name: 'Nair' }, now: NOW }).ok)
      .toBe(false);
    expect(planOccupancy({ people: [], to: 'owner', now: NOW }).field).toBe('owner');
  });

  it('ends a tenancy by deactivating the tenant and writing nothing else', () => {
    // The owner does not get flipped back to "resident" — there is no such
    // column. occupantOf simply stops finding a tenant. That is 0011's whole
    // argument, and this test is what stops a second truth creeping back in.
    const r = planOccupancy({ people: [owner(), tenant()], to: 'owner', billed: true, now: NOW });
    expect(r.from).toBe('owner+tenant');
    expect(r.steps).toEqual([{ op: 'deactivate', id: 2, moved_out_at: NOW }]);
  });

  it('corrects the owner\'s name without touching their number or address', () => {
    // mobile and email are behind approval since B22. An occupancy control that
    // wrote them would be a way round the queue, which is worse than no queue.
    const r = planOccupancy({
      people: [owner()], to: 'owner', billed: true, now: NOW,
      owner: { id: 1, name: 'Nair K', mobile: '+910000000000', email: 'new@x.com' },
    });
    expect(r.steps).toEqual([{ op: 'update', id: 1, fields: { name: 'Nair K' } }]);
  });

  it('never emits a write to mobile or email, in any branch', () => {
    const plans = [
      planOccupancy({ people: [owner()], to: 'owner', billed: true, now: NOW,
                      owner: { id: 1, name: 'X', mobile: '+911111111111' } }),
      planOccupancy({ people: [owner(), tenant()], to: 'owner+tenant', billed: true,
                      tenancyStart: '2026-09', now: NOW,
                      owner: { id: 1, name: 'Nair' },
                      tenant: { id: 2, name: 'Priya', email: 'sneaky@x.com' } }),
    ];
    for (const p of plans) {
      for (const s of p.steps.filter((x) => x.op === 'update')) {
        expect(Object.keys(s.fields)).not.toContain('mobile');
        expect(Object.keys(s.fields)).not.toContain('email');
      }
    }
  });

  it('sends a sale to the handover, which settles what is owed first', () => {
    const r = planOccupancy({
      people: [owner()], to: 'owner', billed: true, now: NOW,
      owner: { name: 'Somebody Else', mobile: '+919846400009' },
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/handover/i);
  });
});

/* ── a tenancy ───────────────────────────────────────────────────────────── */

describe('setting a flat to "owner + tenant"', () => {
  it('takes both parties and the month the tenancy started', () => {
    const r = planOccupancy({
      people: [], to: 'owner+tenant', billed: true, tenancyStart: '2026-08', now: NOW,
      owner: { name: 'Nair', mobile: '+919846466511', email: 'nair@x.com' },
      tenant: { name: 'Priya', mobile: '+919846400002', email: null },
    });
    expect(r.ok).toBe(true);
    expect(r.steps).toEqual([
      { op: 'add', relationship: 'owner', name: 'Nair', mobile: '+919846466511',
        email: 'nair@x.com', moved_in_at: '2026-08-20' },
      { op: 'add', relationship: 'tenant', name: 'Priya', mobile: '+919846400002',
        email: null, moved_in_at: '2026-08-01' },
    ]);
  });

  it('insists on the start month', () => {
    const r = planOccupancy({
      people: [owner()], to: 'owner+tenant', billed: true, now: NOW,
      owner: { id: 1 }, tenant: { name: 'Priya', mobile: '+919846400002' },
    });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('tenancyStart');
  });

  it('edits an existing tenancy — the name and the start date', () => {
    const r = planOccupancy({
      people: [owner(), tenant()], to: 'owner+tenant', billed: true,
      tenancyStart: '2026-06', now: NOW,
      owner: { id: 1, name: 'Nair' }, tenant: { id: 2, name: 'Priya Menon' },
    });
    expect(r.steps).toEqual([
      { op: 'update', id: 2, fields: { name: 'Priya Menon', moved_in_at: '2026-06-01' } },
    ]);
  });

  it('replaces one tenant with another without ever holding two', () => {
    // One meter, one bill — two active tenants means whichever row the query
    // returns first is billed and the other is not (TWO-TENANTS).
    const r = planOccupancy({
      people: [owner(), tenant()], to: 'owner+tenant', billed: true,
      tenancyStart: '2026-09', now: NOW,
      owner: { id: 1 }, tenant: { name: 'Rahul', mobile: '+919846400003' },
    });
    expect(r.steps[0]).toEqual({ op: 'deactivate', id: 2, moved_out_at: NOW });
    expect(r.steps[1]).toMatchObject({ op: 'add', relationship: 'tenant', name: 'Rahul' });
  });

  it('is the repair for a flat with a tenant and no owner', () => {
    // The fourth state cannot be chosen, so this is the only way out of it,
    // and it must not need the tenant to be re-entered.
    const orphan = [owner({ active: 0 }), tenant()];
    expect(occupancyOf(orphan)).toBe('tenant-only');
    const r = planOccupancy({
      people: orphan, to: 'owner+tenant', billed: true, tenancyStart: '2026-08', now: NOW,
      owner: { name: 'Nair', mobile: '+919846466511' },
      tenant: { id: 2, name: 'Priya' },
    });
    expect(r.ok).toBe(true);
    expect(r.from).toBe('tenant-only');
    expect(r.steps).toEqual([
      { op: 'add', relationship: 'owner', name: 'Nair', mobile: '+919846466511',
        email: null, moved_in_at: '2026-08-20' },
    ]);
  });

  it('refuses a tenant with no name or no number of their own', () => {
    const r = planOccupancy({
      people: [owner()], to: 'owner+tenant', billed: true, tenancyStart: '2026-08', now: NOW,
      owner: { id: 1 }, tenant: { name: 'Priya' },
    });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('tenant');
  });
});

/* ── back onto the billing roll ──────────────────────────────────────────── */

describe('a flat that is not being billed, and somebody moves in', () => {
  it('offers to bill it again, with a reason', () => {
    const r = planOccupancy({
      people: [], to: 'owner', billed: false, billing: 'start',
      reason: 'Sold and occupied', now: NOW,
      owner: { name: 'Nair', mobile: '+919846466511' },
    });
    expect(r.steps.find((s) => s.op === 'flat'))
      .toMatchObject({ active: 1, reason: 'Sold and occupied' });
  });

  it('says plainly when somebody is on file and the flat is still off the roll', () => {
    // The same jam wearing the other face: they burn gas and are never asked
    // for it. A warning rather than a refusal — "owned, empty, deliberately
    // left off" is a state the committee is allowed to hold.
    const r = planOccupancy({
      people: [], to: 'owner', billed: false, now: NOW,
      owner: { name: 'Nair', mobile: '+919846466511' },
    });
    expect(r.ok).toBe(true);
    expect(r.warnings[0].kind).toBe('occupied-but-not-billed');
  });
});

describe('the plan itself', () => {
  it('refuses a state that does not exist', () => {
    expect(planOccupancy({ people: [], to: 'owner-absent', now: NOW }).ok).toBe(false);
    expect(planOccupancy({ people: [], to: 'tenant-only', now: NOW }).ok).toBe(false);
  });

  it('writes nothing when nothing changed', () => {
    const r = planOccupancy({ people: [owner()], to: 'owner', billed: true, now: NOW,
                              owner: { id: 1, name: 'Nair' } });
    expect(r.ok).toBe(false);
    expect(r.message).toBe('Nothing to change.');
  });

  it('reports where it came from as well as where it went', () => {
    const r = planOccupancy({ people: [owner()], to: 'owner+tenant', billed: true,
                              tenancyStart: '2026-08', now: NOW,
                              owner: { id: 1 },
                              tenant: { name: 'Priya', mobile: '+919846400002' } });
    expect(r).toMatchObject({ from: 'owner', to: 'owner+tenant' });
  });
});
