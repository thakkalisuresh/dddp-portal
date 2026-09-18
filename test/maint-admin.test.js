import { describe, it, expect } from 'vitest';
import { testEnv, seed } from './support/d1.js';
import {
  tenancyRows, schedulingBlocked, scheduleConsequences, collectFigures,
  duesReport, adminHomeCard, maintAdminPayload, UNCHECKED_DAYS,
} from '../functions/lib/maint-admin.js';

const TODAY = '2026-09-24';
const ISSUE = '2026-10-01';

const tenant = (over = {}) => ({
  id: 3, name: 'T', relationship: 'tenant', active: 1,
  lease_ends_at: '2027-06-30', tenancy_confirmed_at: '2026-06-01', ...over,
});

describe('tenancyRows', () => {
  const rowsFor = (people) => tenancyRows({
    rows: [{ flat: '4B', people }], issueDate: ISSUE, today: TODAY,
  });

  it('flags a lease that ended before the issue date, and says how long ago', () => {
    // This flat is about to be billed at the rented rate for a tenant the
    // record itself says has left.
    const [row] = rowsFor([tenant({ lease_ends_at: '2026-06-30' })]);
    expect(row.flag).toBe('lease-ended');
    expect(row.endedDaysAgo).toBe(86);
  });

  it('flags a tenancy with no lease end at all', () => {
    // Nothing will ever flag it again if this is left.
    expect(rowsFor([tenant({ lease_ends_at: null })])[0].flag).toBe('missing-date');
  });

  it('flags a tenancy nobody has confirmed in two years', () => {
    expect(rowsFor([tenant({ tenancy_confirmed_at: '2024-01-01' })])[0].flag).toBe('unchecked');
    expect(rowsFor([tenant({ tenancy_confirmed_at: null })])[0].flag).toBe('unchecked');
    expect(UNCHECKED_DAYS).toBe(730);
  });

  it('leaves a confirmed, dated, current tenancy alone', () => {
    expect(rowsFor([tenant()])[0].flag).toBe('current');
  });

  it('gives one flag per row, the most serious', () => {
    // A tenant whose lease ended AND who was last confirmed three years ago has
    // ONE problem from the admin's point of view: this record is not
    // trustworthy. Two badges would make them read it twice to learn that.
    const [row] = rowsFor([tenant({ lease_ends_at: '2026-06-30', tenancy_confirmed_at: null })]);
    expect(row.flag).toBe('lease-ended');
  });

  it('ignores owners and departed tenants', () => {
    const rows = rowsFor([
      { id: 1, name: 'O', relationship: 'owner', active: 1 },
      tenant({ id: 9, active: 0, lease_ends_at: null }),
    ]);
    expect(rows).toEqual([]);
  });

  it('sorts the blocking rows to the top', () => {
    // The rows that stop the quarter should be the rows at the top of the
    // table, not scattered through ninety-nine of them.
    const rows = tenancyRows({
      rows: [
        { flat: '1A', people: [tenant({ id: 11 })] },                              // current
        { flat: '2B', people: [tenant({ id: 12, tenancy_confirmed_at: null })] },  // unchecked
        { flat: '3C', people: [tenant({ id: 13, lease_ends_at: '2026-01-01' })] }, // ended
      ],
      issueDate: ISSUE, today: TODAY,
    });
    expect(rows.map((r) => r.flag)).toEqual(['lease-ended', 'unchecked', 'current']);
  });
});

describe('schedulingBlocked', () => {
  it('blocks on any flag that is not current', () => {
    // The user's instruction was that the quarter cannot be scheduled without
    // the flags being looked at, and "looked at" means resolved or explicitly
    // confirmed — not that a warning was displayed and scrolled past.
    for (const flag of ['lease-ended', 'missing-date', 'unchecked']) {
      expect(schedulingBlocked([{ flat: '4B', flag }]).blocked).toBe(true);
    }
  });

  it('does not block when every tenancy is current', () => {
    const state = schedulingBlocked([{ flat: '4B', flag: 'current' }]);
    expect(state.blocked).toBe(false);
    expect(state.count).toBe(0);
  });

  it('counts each flag and names the flats once', () => {
    const state = schedulingBlocked([
      { flat: '4B', flag: 'lease-ended' },
      { flat: '4B', flag: 'missing-date' },
      { flat: '7A', flag: 'unchecked' },
    ]);
    expect(state.count).toBe(3);
    expect(state.flats).toEqual(['4B', '7A']);
    expect(state.byFlag).toEqual({ 'lease-ended': 1, 'missing-date': 1, unchecked: 1 });
  });
});

describe('scheduleConsequences', () => {
  it('separates the due date from the day the fee lands', () => {
    // The fee is charged the day AFTER the due date. The gas screens have
    // already taught residents to misread these as the same day, and a screen
    // built afterwards repeating the confusion would be careless.
    const c = scheduleConsequences({ issueDate: ISSUE, preview: { willBill: 39, total: 303000 } });
    expect(c.dueDate).toBe('2026-10-11');
    expect(c.lateFeeDate).toBe('2026-10-12');
    expect(c.lateFeeDate > c.dueDate).toBe(true);
  });
});

describe('collectFigures', () => {
  const quarter = { quarter: '2026-Q4', due_date: '2026-10-11', late_fee: 750 };
  const bill = (over = {}) => ({ status: 'unpaid', total: 7500, late_fee_at: null, ...over });

  it('counts paid, checking and unpaid separately', () => {
    const f = collectFigures({
      bills: [
        bill({ status: 'paid' }), bill({ status: 'waived' }),
        bill({ status: 'awaiting' }), bill({ status: 'unpaid' }),
      ],
      quarter, today: '2026-10-05',
    });
    expect(f.paid).toBe(2);
    expect(f.checking).toBe(1);
    expect(f.unpaid).toBe(1);
  });

  it('leaves cancelled bills out of every figure', () => {
    const f = collectFigures({ bills: [bill({ status: 'cancelled' })], quarter, today: '2026-10-05' });
    expect(f.paid + f.checking + f.unpaid).toBe(0);
  });

  it('says nothing about tonight before the due date', () => {
    expect(collectFigures({ bills: [bill()], quarter, today: '2026-10-05' }).lateFeeTonight).toBeNull();
  });

  it('says how many bills and how much on the due date itself', () => {
    // The admin's next question after "tonight" is always "how much".
    const f = collectFigures({ bills: [bill(), bill()], quarter, today: '2026-10-11' });
    expect(f.lateFeeTonight).toEqual({ bills: 2, each: 750, total: 1500 });
  });

  it('leaves out a bill whose approval has frozen the clock', () => {
    // maintLateFeeDecision refuses to charge it, so counting it would promise
    // money that will not arrive.
    const f = collectFigures({
      bills: [bill({ pending_approval: 1 }), bill()], quarter, today: '2026-10-11',
    });
    expect(f.lateFeeTonight.bills).toBe(1);
  });

  it('leaves out a bill that has already been charged', () => {
    const f = collectFigures({
      bills: [bill({ late_fee_at: '2026-10-12T00:00:00Z' })], quarter, today: '2026-10-13',
    });
    expect(f.lateFeeTonight).toBeNull();
  });
});

describe('adminHomeCard', () => {
  const draft = (over = {}) => ({
    quarter: '2026-Q4', status: 'draft', issue_date: '2026-10-01', ...over,
  });

  it('stays away until the draft window opens', () => {
    // A card about a quarter three weeks out is a card nobody can act on.
    expect(adminHomeCard({ quarter: draft(), today: '2026-09-01' })).toBeNull();
  });

  it('appears seven days out with the days remaining and what is blocking', () => {
    const card = adminHomeCard({
      quarter: draft(), blocked: { count: 3 }, preview: { willBill: 39, total: 303000 },
      today: '2026-09-24',
    });
    expect(card.state).toBe('unscheduled');
    expect(card.daysRemaining).toBe(7);
    expect(card.tenanciesToConfirm).toBe(3);
  });

  it('escalates at two days out and again once the quarter has started', () => {
    // A card that is urgent for seven days straight is wallpaper by day three.
    const at = (today) => adminHomeCard({ quarter: draft(), today }).urgency;
    expect(at('2026-09-26')).toBe('soon');
    expect(at('2026-09-29')).toBe('urgent');
    expect(at('2026-10-03')).toBe('overdue');
  });

  it('says how many days overdue once the quarter has started unscheduled', () => {
    const card = adminHomeCard({ quarter: draft(), today: '2026-10-04' });
    expect(card.daysOverdue).toBe(3);
    expect(card.daysRemaining).toBe(0);
  });

  it('becomes a calm receipt once scheduled', () => {
    const card = adminHomeCard({
      quarter: draft({ status: 'scheduled', scheduled_flats: 39, scheduled_total: 303000 }),
      today: '2026-09-28',
    });
    expect(card.state).toBe('scheduled');
    expect(card.urgency).toBe('calm');
    expect(card.flats).toBe(39);
  });

  it('goes once the bills are issued', () => {
    expect(adminHomeCard({ quarter: draft({ status: 'issued' }), today: '2026-10-02' })).toBeNull();
    expect(adminHomeCard({ quarter: draft({ status: 'locked' }), today: '2026-12-02' })).toBeNull();
  });
});

/* ── the rule that outlives the people who remember why ───────────────────  */

describe('the dues report is never totalled across the two accounts', () => {
  async function report() {
    const { db, env } = testEnv();
    seed(db, { flats: ['4A'], people: [{ id: 1, flat: '4A', relationship: 'owner' }] });
    db.prepare(
      `INSERT INTO periods (period, rate_per_kg, conversion_factor, due_date, late_fee, status, created_at)
       VALUES ('2026-09', 60, 2.6, '2026-10-10', 50, 'open', '2026-09-01T00:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO bills (id, flat, period, owner_id, consumption, meter_delta, rate_per_kg,
                          conversion_factor, gas_amount, other_charges, additional_charges,
                          late_fee, total, status, created_at)
       VALUES (1, '4A', '2026-09', 1, 4.0, 1.5, 60, 2.6, 240, 0, 0, 0, 240, 'unpaid', '2026-10-01')`
    ).run();
    db.prepare(
      `INSERT INTO maint_quarters (quarter, owner_rate, tenant_rate, late_fee, issue_date,
                                   due_date, status, created_at)
       VALUES ('2026-Q4', 7500, 9000, 750, '2026-10-01', '2026-10-11', 'issued', '2026-09-24')`
    ).run();
    db.prepare(
      `INSERT INTO maint_bills (id, flat, quarter, owner_id, rate_applied, basis, late_fee,
                                total, status, created_at)
       VALUES (1, '4A', '2026-Q4', 1, 7500, 'owner', 0, 7500, 'unpaid', '2026-10-01')`
    ).run();
    return duesReport(env, { today: '2026-10-12' });
  }

  it('reports the two accounts as two blocks with their own figures', () => {
    return report().then((r) => {
      expect(r.gas.outstanding).toBe(240);
      expect(r.maintenance.outstanding).toBe(7500);
      expect(r.gas.cadence).toBe('month');
      expect(r.maintenance.cadence).toBe('quarter');
    });
  });

  it('carries no field that sums across both kinds, at any depth', async () => {
    // THE ENFORCED RULE. Gas is monthly and maintenance is quarterly, they
    // settle into two different bank accounts, and a total across them
    // reconciles against nothing. The user rejected a combined per-flat table
    // with a total column and a single "you owe" figure on the resident's home
    // page, both for this reason.
    //
    // This walks the payload rather than naming the fields it knows about,
    // because the failure it is guarding against is a field that does not exist
    // yet — added in good faith by somebody who thinks a total would be handy.
    const r = await report();
    const combined = ['total', 'grandTotal', 'grand_total', 'combined', 'allDues',
      'all_dues', 'outstandingTotal', 'sum'];

    const walk = (node, path) => {
      if (!node || typeof node !== 'object') return;
      // Inside one block a total is correct — it is one account's own money.
      // Only a total ABOVE the blocks spans them, so the walk stops at the two.
      if (path === 'gas' || path === 'maintenance') return;
      for (const [key, value] of Object.entries(node)) {
        expect(combined, `${path}.${key} — gas is monthly and maintenance is quarterly, `
          + 'they settle into different bank accounts, and a figure spanning both '
          + 'reconciles against nothing. Keep the two blocks separate.')
          .not.toContain(key);
        walk(value, path ? `${path}.${key}` : key);
      }
    };
    walk(r, '');
  });

  it('keeps the two blocks’ rows apart', async () => {
    const r = await report();
    expect(r.gas.rows.every((row) => row.period === '2026-09')).toBe(true);
    expect(r.maintenance.rows.every((row) => row.period === '2026-Q4')).toBe(true);
  });

  it('leaves settled bills out of both blocks', async () => {
    const { db, env } = testEnv();
    // One bill per flat per quarter is a UNIQUE constraint, so the three
    // settled states need three flats.
    seed(db, {
      flats: ['4A', '4B', '4C'],
      people: [
        { id: 1, flat: '4A', relationship: 'owner' },
        { id: 2, flat: '4B', relationship: 'owner' },
        { id: 3, flat: '4C', relationship: 'owner' },
      ],
    });
    db.prepare(
      `INSERT INTO maint_quarters (quarter, owner_rate, tenant_rate, late_fee, issue_date,
                                   due_date, status, created_at)
       VALUES ('2026-Q4', 7500, 9000, 750, '2026-10-01', '2026-10-11', 'issued', '2026-09-24')`
    ).run();
    for (const [id, flat, status] of [[1, '4A', 'paid'], [2, '4B', 'waived'], [3, '4C', 'cancelled']]) {
      db.prepare(
        `INSERT INTO maint_bills (id, flat, quarter, owner_id, rate_applied, basis, late_fee,
                                  total, status, created_at)
         VALUES (?, ?, '2026-Q4', ?, 7500, 'owner', 0, 7500, ?, '2026-10-01')`
      ).run(id, flat, id, status);
    }
    const r = await duesReport(env, { today: '2026-10-12' });
    expect(r.maintenance.count).toBe(0);
  });
});

describe('maintAdminPayload', () => {
  function world() {
    const { db, env } = testEnv();
    seed(db, {
      flats: ['4A', '4B'],
      people: [
        { id: 1, flat: '4A', relationship: 'owner' },
        { id: 2, flat: '4B', relationship: 'owner' },
        { id: 3, flat: '4B', relationship: 'tenant',
          lease_ends_at: '2027-06-30', tenancy_confirmed_at: '2026-06-01' },
      ],
    });
    return { db, env };
  }

  it('draws a quarter that does not exist yet rather than failing', async () => {
    // A quarter nobody has drafted is a real state: step 1 is where an admin
    // creates it, and they have not been there yet.
    const { env } = world();
    const payload = await maintAdminPayload(env, '2026-Q4', { today: TODAY });
    expect(payload.status).toBe('none');
    expect(payload.row).toBeNull();
    expect(payload.preview).toBeNull();
  });

  it('carries last quarter’s figures as step 1’s defaults and comparison', async () => {
    const { db, env } = world();
    db.prepare(
      `INSERT INTO maint_quarters (quarter, owner_rate, tenant_rate, late_fee, issue_date,
                                   due_date, status, created_at)
       VALUES ('2026-Q3', 7000, 8500, 750, '2026-07-01', '2026-07-11', 'locked', '2026-06-24')`
    ).run();
    const payload = await maintAdminPayload(env, '2026-Q4', { today: TODAY });
    expect(payload.previousLabel).toBe('2026-Q3');
    expect(payload.previous.owner_rate).toBe(7000);
  });

  it('previews the quarter once it has rates', async () => {
    const { db, env } = world();
    db.prepare(
      `INSERT INTO maint_quarters (quarter, owner_rate, tenant_rate, late_fee, issue_date,
                                   due_date, status, created_at)
       VALUES ('2026-Q4', 7500, 9000, 750, '2026-10-01', '2026-10-11', 'draft', '2026-09-24')`
    ).run();
    const payload = await maintAdminPayload(env, '2026-Q4', { today: TODAY });
    expect(payload.preview.willBill).toBe(2);
    // 4B is let, so it is billed at the rented rate.
    expect(payload.preview.total).toBe(7500 + 9000);
    expect(payload.blocked.blocked).toBe(false);
  });

  it('blocks scheduling when a lease has ended', async () => {
    const { db, env } = world();
    db.prepare("UPDATE owners SET lease_ends_at = '2026-06-30' WHERE id = 3").run();
    db.prepare(
      `INSERT INTO maint_quarters (quarter, owner_rate, tenant_rate, late_fee, issue_date,
                                   due_date, status, created_at)
       VALUES ('2026-Q4', 7500, 9000, 750, '2026-10-01', '2026-10-11', 'draft', '2026-09-24')`
    ).run();
    const payload = await maintAdminPayload(env, '2026-Q4', { today: TODAY });
    expect(payload.blocked.blocked).toBe(true);
    expect(payload.blocked.flats).toEqual(['4B']);
  });
});
