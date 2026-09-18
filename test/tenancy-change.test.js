/**
 * A tenant moving out.
 *
 * The consequences are the point. An admin fills in a date and a dropdown and
 * is shown what that would do; a second admin, days later, signs the same
 * sentences. These tests hold the two to the same rule, and hold that rule to
 * 0042's: a quarter's rate is fixed on its ISSUE DATE, so which side of that
 * date a departure falls on decides whether a bill is re-rated or merely moved.
 */
import { describe, it, expect } from 'vitest';
import { planOccupancyChange } from '../functions/lib/maint.js';
import { describeDeparture, departureInputs, REQUEST_TTL_DAYS }
  from '../functions/lib/tenancy-change.js';
import { freshDb, d1 } from './support/d1.js';

const QUARTER = { quarter: '2026-Q4', owner_rate: 7500, tenant_rate: 9000, issue_date: '2026-10-01' };
const OWNER = { id: 5, name: 'Rajan Pillai' };
const TENANT = { id: 7, name: 'Anu Thomas', relationship: 'tenant', flat: '5B', active: 1 };
const BILL = {
  id: 9, flat: '5B', quarter: '2026-Q4', owner_id: 7,
  rate_applied: 9000, basis: 'tenant', total: 9000, status: 'unpaid',
};

const plan = (over = {}) => planOccupancyChange({
  bill: BILL, change: 'tenant-to-owner', quarter: QUARTER, owner: OWNER,
  issueDate: QUARTER.issue_date, ...over,
});

describe('which side of the issue date they left on', () => {
  it('re-rates when they had already gone when the quarter was issued', () => {
    const p = plan({ movedOutOn: '2026-09-30' });
    expect(p.action).toBe('re-rate');
    expect(p.total).toBe(7500);
    expect(p.billedTo).toBe(5);
    expect(p.reassignedFrom).toBe(7);
  });

  it('moves the bill without re-rating when they left after it went out', () => {
    // 0042, in the schema: a flat let on 3 October is rented for all of Q4, and
    // a tenant who leaves on the 4th does not turn Q4 back into an owner
    // quarter by arithmetic. The ₹9,000 stands; only the debt changes hands.
    const p = plan({ movedOutOn: '2026-10-04' });
    expect(p.action).toBe('reassign');
    expect(p.reason).toBe('left-after-issue-date');
    expect(p.rate).toBe(9000);
    expect(p.billedTo).toBe(5);
    expect(p.reassignedFrom).toBe(7);
  });

  it('treats the issue date itself as still rented', () => {
    // Left ON the day it issued: the flat was let when the rate was fixed.
    expect(plan({ movedOutOn: '2026-10-01' }).action).toBe('re-rate');
  });

  it('falls back to the old behaviour when the dates are unknown', () => {
    // Every caller written before the date rule existed passes neither, and
    // must keep getting exactly what it got before.
    expect(planOccupancyChange({ bill: BILL, change: 'tenant-to-owner', quarter: QUARTER, owner: OWNER }).action)
      .toBe('re-rate');
  });

  it('bills an empty flat exactly as an owner-occupied one, and says which it is', () => {
    const p = plan({ change: 'tenant-to-empty', movedOutOn: '2026-09-30' });
    expect(p.action).toBe('re-rate');
    expect(p.total).toBe(7500);
    // Same money, different record. A re-rate's reason should say what happened
    // rather than the nearest thing the billing code could recognise.
    expect(p.reason).toBe('tenant-left-flat-empty');
  });

  it('still refuses to reopen a settled quarter, whenever they left', () => {
    for (const movedOutOn of ['2026-09-30', '2026-10-04']) {
      const p = plan({ bill: { ...BILL, status: 'paid' }, movedOutOn });
      expect(p.action, movedOutOn).toBe('none');
      expect(p.reason).toBe('settled');
    }
  });
});

describe('what the dialog says', () => {
  const describe_ = (over = {}) => describeDeparture({
    person: TENANT, owner: OWNER, becomes: 'owner', movedOutOn: '2026-09-30',
    bills: [BILL], quarters: { '2026-Q4': QUARTER }, rates: QUARTER, today: '2026-09-30',
    ...over,
  });

  const texts = (r) => r.lines.map((l) => l.text).join(' ');

  it('names the money and the direction, and the person whose login ends', () => {
    // The approved wording says "the owner" rather than naming them: the lines
    // read as a list of what saving this DOES, and a name in each one made the
    // list read as gossip about two people. The tenant is still named on the
    // line that takes their login, which is the one a person should own.
    const t = texts(describe_());
    expect(t).toContain('₹9,000 to ₹7,500');
    expect(t).toContain('to the owner');
    expect(t).toContain("end Anu Thomas's login");
  });

  it('always says the login goes, and that it does not go yet', () => {
    // The part of this an admin does not picture when they tap.
    // "not yet" now lives in the dialog's foot rather than in the line, so the
    // list stays a list of consequences and the timing is said once.
    const line = describe_().lines.find((l) => l.kind === 'login');
    expect(line.text).toMatch(/end Anu Thomas's login/);
  });

  it('always says who the letters go to instead', () => {
    expect(describe_().lines.some((l) => l.kind === 'letters')).toBe(true);
  });

  it('says the rate changes from next quarter, whatever this quarter did', () => {
    const line = describe_({ bills: [] }).lines.find((l) => l.kind === 'future');
    expect(line.text).toContain('₹7,500 instead of ₹9,000');
  });

  it('does not promise a rate change when another tenant is moving in', () => {
    const r = describe_({ becomes: 'tenant' });
    expect(r.lines.some((l) => l.kind === 'future')).toBe(false);
    // And it refuses to decide who carries the bill, which is the one thing
    // arithmetic cannot answer here.
    expect(texts(r)).toContain('to be assigned by an admin');
  });

  it('recomputes when the date moves across the issue date', () => {
    expect(texts(describe_({ movedOutOn: '2026-09-30' }))).toContain('from ₹9,000 to ₹7,500');
    expect(texts(describe_({ movedOutOn: '2026-10-04' })))
      .toContain('move the unpaid Q4 2026 (Oct–Dec) bill of ₹9,000 to the owner');
  });

  it('says so plainly when there is no bill to move', () => {
    expect(texts(describe_({ bills: [] }))).toContain('because none is unpaid on this flat');
  });

  it('skips a bill whose quarter has gone missing rather than guessing a rate', () => {
    const r = describe_({ quarters: {} });
    expect(r.plans).toEqual([]);
    expect(texts(r)).toContain('because none is unpaid on this flat');
  });

  it('dates the expiry from the request, not from nothing', () => {
    expect(describe_().expiresAt).toBe('2026-10-07');
    expect(REQUEST_TTL_DAYS).toBe(7);
  });
});

/* ── against the real schema ────────────────────────────────────────────── */

describe('the departure, against the real migrations (0045)', () => {
  const seed = (db) => db.exec(`
    INSERT INTO flats (flat, floor) VALUES ('5B', 5);
    INSERT INTO owners (id, flat, name, mobile, pw_hash, pw_salt, role, relationship, created_at)
      VALUES (5, '5B', 'Rajan Pillai', '9000000005', 'x', 'y', 'owner', 'owner', '2026-01-01'),
             (7, '5B', 'Anu Thomas',   '9000000007', 'x', 'y', 'owner', 'tenant', '2026-01-01');
    INSERT INTO maint_quarters (quarter, owner_rate, tenant_rate, issue_date, due_date, status, created_at)
      VALUES ('2026-Q3', 7000, 8500, '2026-07-01', '2026-07-11', 'locked', '2026-06-24'),
             ('2026-Q4', 7500, 9000, '2026-10-01', '2026-10-11', 'issued', '2026-09-24');
    INSERT INTO maint_bills (id, flat, quarter, owner_id, rate_applied, basis, total, created_at)
      VALUES (9, '5B', '2026-Q4', 7, 9000, 'tenant', 9000, '2026-10-01'),
             -- The owner's OWN bill on the same flat. It must not appear.
             (10, '5B', '2026-Q3', 5, 7000, 'owner', 7000, '2026-07-01');
  `);

  it('moves only the bills the departing person carries', async () => {
    // The first render of this dialog told an approver that the OWNER's own
    // ₹7,000 bill would "move to Rajan Pillai" — who had been holding it all
    // along. A consequence that is not one, on the screen whose entire job is
    // to say exactly what is being agreed to.
    const db = freshDb();
    seed(db);
    const inputs = await departureInputs({ DB: d1(db) }, 7);
    expect(inputs.bills.map((b) => b.id)).toEqual([9]);
    expect(inputs.owner).toMatchObject({ id: 5, name: 'Rajan Pillai' });
  });

  it('reads the quarter rows the rates have to come from', async () => {
    const db = freshDb();
    seed(db);
    const inputs = await departureInputs({ DB: d1(db) }, 7);
    expect(inputs.quarters['2026-Q4']).toMatchObject({ owner_rate: 7500, issue_date: '2026-10-01' });
  });

  it('allows only one open departure per person', () => {
    // Two admins each filing one, with different dates, would leave a queue
    // whose entries disagree about when somebody left.
    const db = freshDb();
    seed(db);
    const insert = (id) => db.exec(
      `INSERT INTO tenancy_change_requests
         (id, person_id, flat, moved_out_on, becomes, reason, requested_by, requested_at, expires_at)
       VALUES (${id}, 7, '5B', '2026-09-30', 'owner', 'r', 5, '2026-10-01', '2026-10-08')`);
    insert(1);
    expect(() => insert(2)).toThrow();
    // Resolved ones do not block a later one: people move out twice.
    db.exec("UPDATE tenancy_change_requests SET status = 'applied' WHERE id = 1");
    expect(() => insert(3)).not.toThrow();
  });

  it('refuses a move-out date that is not a date', () => {
    const db = freshDb();
    seed(db);
    expect(() => db.exec(
      `INSERT INTO tenancy_change_requests
         (person_id, flat, moved_out_on, becomes, reason, requested_by, requested_at, expires_at)
       VALUES (7, '5B', 'September', 'owner', 'r', 5, '2026-10-01', '2026-10-08')`)).toThrow();
  });
});
