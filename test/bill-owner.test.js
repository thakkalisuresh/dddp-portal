import { describe, it, expect } from 'vitest';
import { occupantsByFlat, readingGrid, generateBills } from '../functions/lib/admin.js';

/**
 * A bill belongs to a PERSON, not to a flat. Migration 0003 added
 * bills.owner_id for one reason: when a flat is sold the new owner must not be
 * able to read the previous owner's bills. dashboard.js filters on
 * `(owner_id IS NULL OR owner_id = ?)`, so a bill generated with a NULL
 * owner_id is visible to whoever occupies the flat next — the exact hole 0003
 * closed, reopened by every month generated through the admin console.
 */

/** Just enough D1 to run readingGrid and generateBills. No network, no D1. */
function fakeDb({ period: periodRow, readings = [], flats = [], people = [], bills = 0 }) {
  const batched = [];
  const route = (sql, args) => {
    if (/FROM periods WHERE period/.test(sql)) {
      return { first: async () => (args[0] === periodRow?.period ? periodRow : null) };
    }
    if (/COUNT\(\*\) AS n FROM bills/.test(sql)) return { first: async () => ({ n: bills }) };
    if (/FROM flats f/.test(sql) && /f\.active = 1/.test(sql)) {
      const [cur, prv] = args;
      return { all: async () => ({ results: flats.map((f) => ({
        flat: f.flat, floor: f.floor,
        reading: readings.find((r) => r.flat === f.flat && r.period === cur)?.reading ?? null,
        read_on: null,
        previous: readings.find((r) => r.flat === f.flat && r.period === prv)?.reading ?? null,
        mc_old_final: null, mc_new_start: null, mc_changed_on: null, mc_note: null,
      })) }) };
    }
    if (/FROM flats f/.test(sql)) return { all: async () => ({ results: [] }) };
    if (/FROM owners/.test(sql)) return { all: async () => ({ results: people }) };
    if (/INSERT INTO bills|UPDATE periods/.test(sql)) return { sql, args };
    throw new Error(`unrouted SQL: ${sql}`);
  };
  return {
    batched,
    DB: {
      prepare(sql) {
        return {
          bind: (...args) => route(sql, args),
          first: async () => route(sql, []).first(),
          all: async () => route(sql, []).all(),
        };
      },
      batch: async (statements) => { batched.push(...statements); },
    },
  };
}

const OPEN = {
  period: '2026-07', status: 'open', rate_per_kg: 100, conversion_factor: 2.1,
  due_date: '2026-08-10', late_fee: 0,
};

describe('who a flat is billed to', () => {
  it('picks the tenant over the absent owner', () => {
    // The old grid LEFT JOINed owners and took whichever row came back first,
    // which on a let flat is as likely to be the landlord as the tenant.
    const occupants = occupantsByFlat([
      { id: 1, flat: '4A', name: 'Landlord', relationship: 'owner', active: 1 },
      { id: 2, flat: '4A', name: 'Tenant', relationship: 'tenant', active: 1 },
    ]);
    expect(occupants.get('4A')).toMatchObject({ id: 2, name: 'Tenant' });
  });

  it('bills the owner of a flat with no tenant', () => {
    const occupants = occupantsByFlat([
      { id: 1, flat: '4B', name: 'Owner', relationship: 'owner', active: 1 },
    ]);
    expect(occupants.get('4B')).toMatchObject({ id: 1 });
  });

  it('ignores people who have moved out', () => {
    // Departure is active = 0, never a delete, so the departed rows are still
    // in the table and a naive join can still return one of them.
    const occupants = occupantsByFlat([
      { id: 1, flat: '4C', name: 'Sold up', relationship: 'owner', active: 0 },
      { id: 2, flat: '4C', name: 'Bought in', relationship: 'owner', active: 1 },
    ]);
    expect(occupants.get('4C')).toMatchObject({ id: 2, name: 'Bought in' });
  });

  it('has no entry for a flat with nobody on file', () => {
    expect(occupantsByFlat([]).get('4D')).toBeUndefined();
  });

  it('keeps each flat\'s people to itself', () => {
    const occupants = occupantsByFlat([
      { id: 1, flat: '4A', name: 'A', relationship: 'owner', active: 1 },
      { id: 2, flat: '4B', name: 'B', relationship: 'tenant', active: 1 },
    ]);
    expect(occupants.get('4A').id).toBe(1);
    expect(occupants.get('4B').id).toBe(2);
  });
});

describe('the reading grid names the occupant', () => {
  it('carries the occupant id, not merely a name', async () => {
    const env = fakeDb({
      period: OPEN,
      flats: [{ flat: '4A', floor: 4 }],
      readings: [
        { flat: '4A', period: '2026-06', reading: 100 },
        { flat: '4A', period: '2026-07', reading: 110 },
      ],
      people: [
        { id: 1, flat: '4A', name: 'Landlord', relationship: 'owner', active: 1 },
        { id: 2, flat: '4A', name: 'Tenant', relationship: 'tenant', active: 1 },
      ],
    });
    const grid = await readingGrid(env, '2026-07');
    expect(grid.flats[0]).toMatchObject({ resident: 'Tenant', residentId: 2 });
  });

  it('says nobody rather than guessing when the flat is unsold', async () => {
    const env = fakeDb({ period: OPEN, flats: [{ flat: '4A', floor: 4 }], people: [] });
    const grid = await readingGrid(env, '2026-07');
    expect(grid.flats[0]).toMatchObject({ resident: null, residentId: null });
  });
});

describe('generation attaches every bill to a person', () => {
  const twoFlats = {
    period: OPEN,
    flats: [{ flat: '4A', floor: 4 }, { flat: '4B', floor: 4 }],
    readings: [
      { flat: '4A', period: '2026-06', reading: 100 }, { flat: '4A', period: '2026-07', reading: 110 },
      { flat: '4B', period: '2026-06', reading: 200 }, { flat: '4B', period: '2026-07', reading: 205 },
    ],
  };

  it('binds the occupant as owner_id on every INSERT', async () => {
    const env = fakeDb({
      ...twoFlats,
      people: [
        { id: 1, flat: '4A', name: 'Landlord', relationship: 'owner', active: 1 },
        { id: 2, flat: '4A', name: 'Tenant', relationship: 'tenant', active: 1 },
        { id: 3, flat: '4B', name: 'Owner', relationship: 'owner', active: 1 },
      ],
    });
    await generateBills(env, '2026-07', 1);

    const inserts = env.batched.filter((s) => /INSERT INTO bills/.test(s.sql));
    expect(inserts).toHaveLength(2);
    for (const insert of inserts) {
      expect(insert.sql).toMatch(/owner_id/);
      // flat, period, owner_id, ... — a bill with a null third argument is the
      // privacy bug, not a tidiness one.
      const [flat, , ownerId] = insert.args;
      expect(ownerId, flat).not.toBeNull();
    }
    expect(inserts.map((i) => [i.args[0], i.args[2]])).toEqual([['4A', 2], ['4B', 3]]);
  });

  it('refuses the month when a billed flat has nobody to bill', async () => {
    // FLAT-BILLED-NO-OWNER. Normally the month is already blocked because such
    // a flat has no reading — but a reading entered anyway must not become a
    // bill belonging to no one.
    const env = fakeDb({
      ...twoFlats,
      people: [{ id: 1, flat: '4A', name: 'Owner', relationship: 'owner', active: 1 }],
    });
    await expect(generateBills(env, '2026-07', 1)).rejects.toThrow(/DDP-BILL-015/);
    expect(env.batched).toEqual([]);
  });

  it('names the flats it could not attach, so the fix is obvious', async () => {
    const env = fakeDb({ ...twoFlats, people: [] });
    const err = await generateBills(env, '2026-07', 1).catch((e) => e);
    expect(err.detail.flats).toEqual(['4A', '4B']);
  });
});
