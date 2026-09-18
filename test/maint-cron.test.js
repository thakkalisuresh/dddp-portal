import { describe, it, expect, vi } from 'vitest';
import { testEnv, seed, rows } from './support/d1.js';
import {
  ensureDraft, draftDateFor, scheduleQuarter, issueQuarter,
  applyMaintLateFees, applyLateFeeToMaintBill, queueDueLetters,
  confirmRecipients, flatsWithPeople, DRAFT_LEAD_DAYS,
} from '../functions/lib/maint-cron.js';
import { drainMaintMail } from '../functions/lib/maint-mail.js';

/**
 * These run against a REAL SQLite with the real migrations applied, not a
 * mocked query router — because the rules being tested live in the schema.
 * "Issuing twice raises one bill" is a claim about ON CONFLICT, and only a
 * database can answer it.
 */

/** A building: 4A owner-occupied, 4B let, 12F unsold. */
function building(extra = {}) {
  const { db, env } = testEnv(extra);
  seed(db, {
    flats: ['4A', '4B', '12F'],
    people: [
      { id: 1, flat: '4A', relationship: 'owner', email: 'owner4a@x.com' },
      { id: 2, flat: '4B', relationship: 'owner', email: 'owner4b@x.com' },
      // A lease END DATE, because the building's records being in order is the
      // normal case these tests are about. Scheduling refuses an undated lease
      // unless the caller acknowledges it — see scheduleQuarter — and a fixture
      // without one would make every test here a test of that refusal.
      { id: 3, flat: '4B', relationship: 'tenant', email: 'tenant4b@x.com',
        lease_ends_at: '2027-06-30' },
    ],
  });
  return { db, env };
}

function putQuarter(db, over = {}) {
  const q = {
    quarter: '2026-Q4', owner_rate: 7500, tenant_rate: 9000, late_fee: 750,
    issue_date: '2026-10-01', due_date: '2026-10-11', status: 'draft',
    created_at: '2026-09-24T00:00:00Z', ...over,
  };
  db.prepare(
    `INSERT INTO maint_quarters
       (quarter, owner_rate, tenant_rate, late_fee, issue_date, due_date, status,
        created_at, scheduled_by, scheduled_flats, scheduled_total)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(q.quarter, q.owner_rate, q.tenant_rate, q.late_fee, q.issue_date, q.due_date,
        q.status, q.created_at, q.scheduled_by ?? null,
        q.scheduled_flats ?? null, q.scheduled_total ?? null);
  return q;
}

/**
 * Record an advance on a flat. `approved_by` null leaves it unapproved — one
 * admin's assertion, which must NOT settle a bill. The CHECK forbids the
 * recorder approving their own, so the two ids differ.
 */
function putAdvance(db, { flat, paidThrough, amount = 30000, approvedBy = 2, reference = null } = {}) {
  db.prepare(
    `INSERT INTO maint_advances
       (flat, paid_through, amount, reference, recorded_by, recorded_at, approved_by, approved_at)
     VALUES (?, ?, ?, ?, 1, '2026-09-20T00:00:00Z', ?, ?)`
  ).run(flat, paidThrough, amount, reference,
        approvedBy, approvedBy == null ? null : '2026-09-21T00:00:00Z');
}

/* ── drafting ────────────────────────────────────────────────────────────── */

describe('a quarter drafts itself a week ahead', () => {
  it('appears exactly 7 days before the quarter starts', () => {
    expect(DRAFT_LEAD_DAYS).toBe(7);
    expect(draftDateFor('2026-Q4')).toBe('2026-09-24');
    expect(draftDateFor('2027-Q1')).toBe('2026-12-25');
  });

  it('does nothing before its day', async () => {
    const { env } = building();
    const r = await ensureDraft(env, { today: '2026-09-23' });
    expect(r.created).toBe(false);
    expect(r.reason).toBe('too-early');
  });

  it('creates the NEXT quarter, with the standing rates', async () => {
    const { db, env } = building();
    const r = await ensureDraft(env, { today: '2026-09-24' });
    expect(r.created).toBe(true);
    expect(r.quarter).toBe('2026-Q4');

    const [q] = rows(db, 'SELECT * FROM maint_quarters');
    expect(q.status).toBe('draft');
    expect(q.owner_rate).toBe(7500);
    expect(q.tenant_rate).toBe(9000);
    expect(q.issue_date).toBe('2026-10-01');
    expect(q.due_date).toBe('2026-10-11');
  });

  it('never inherits the previous quarter rates', async () => {
    // A rate carried forward silently is the worst failure a billing system
    // has: 99 bills go out looking normal and every one is wrong. An admin
    // confirms the figures on screen before anything is issued.
    const { db, env } = building();
    putQuarter(db, { quarter: '2026-Q3', owner_rate: 6000, tenant_rate: 8000, status: 'locked' });
    await ensureDraft(env, { today: '2026-09-24' });
    const [q4] = rows(db, "SELECT * FROM maint_quarters WHERE quarter = '2026-Q4'");
    expect(q4.owner_rate).toBe(7500);
  });

  it('is safe to run every night — the row is created once', async () => {
    const { db, env } = building();
    await ensureDraft(env, { today: '2026-09-24' });
    const second = await ensureDraft(env, { today: '2026-09-25' });
    expect(second.created).toBe(false);
    expect(second.reason).toBe('exists');
    expect(rows(db, 'SELECT * FROM maint_quarters')).toHaveLength(1);
  });
});

/* ── who is asked to confirm ─────────────────────────────────────────────── */

describe('the confirm reminder goes to the right admins', () => {
  const withAdmins = () => {
    const { db, env } = building();
    seed(db, { people: [
      { id: 10, flat: '4A', relationship: 'owner', role: 'admin', email: 'admin1@x.com' },
      { id: 11, flat: '4B', relationship: 'owner', role: 'admin', email: 'admin2@x.com' },
      { id: 12, flat: '12F', relationship: 'owner', role: 'superadmin', email: 'super@x.com' },
    ]});
    return { db, env };
  };

  it('excludes whoever scheduled the previous quarter', async () => {
    // Turn-taking, not suspicion: one member quietly doing it every quarter is
    // how a committee ends up with one person who understands the billing.
    const { db, env } = withAdmins();
    putQuarter(db, { quarter: '2026-Q3', status: 'locked', scheduled_by: 10 });
    const to = await confirmRecipients(env, '2026-Q4');
    expect(to.map((a) => a.id)).toEqual([11, 12]);
  });

  it('asks everybody when that would leave nobody', async () => {
    // A rule about sharing the work must not be able to stop the work.
    const { db, env } = building();
    seed(db, { people: [{ id: 10, flat: '4A', relationship: 'owner', role: 'admin', email: 'a@x.com' }] });
    putQuarter(db, { quarter: '2026-Q3', status: 'locked', scheduled_by: 10 });
    const to = await confirmRecipients(env, '2026-Q4');
    expect(to.map((a) => a.id)).toEqual([10]);
  });

  it('never writes to an admin with no address on file', async () => {
    const { db, env } = building();
    seed(db, { people: [
      { id: 10, flat: '4A', relationship: 'owner', role: 'admin', email: null },
      { id: 11, flat: '4B', relationship: 'owner', role: 'admin', email: 'a@x.com' },
    ]});
    expect((await confirmRecipients(env, '2026-Q4')).map((a) => a.id)).toEqual([11]);
  });

  it('ignores ordinary residents entirely', async () => {
    const { env } = withAdmins();
    const to = await confirmRecipients(env, '2026-Q4');
    expect(to.map((a) => a.id).sort()).toEqual([10, 11, 12]);
  });
});

/* ── scheduling ──────────────────────────────────────────────────────────── */

describe('scheduling a quarter', () => {
  it('records the issue date and what the admin was shown', async () => {
    const { db, env } = building();
    putQuarter(db);
    const r = await scheduleQuarter(env, '2026-Q4', { actorId: 1 });
    expect(r.scheduled).toBe(true);

    const [q] = rows(db, 'SELECT * FROM maint_quarters');
    expect(q.status).toBe('scheduled');
    expect(q.scheduled_by).toBe(1);
    // 4A owner-occupied 7,500 + 4B let 9,000. 12F is unsold and not billed.
    expect(q.scheduled_flats).toBe(2);
    expect(q.scheduled_total).toBe(16500);
  });

  it('tells nobody — nothing is queued at schedule time', async () => {
    const { db, env } = building();
    putQuarter(db);
    await scheduleQuarter(env, '2026-Q4', { actorId: 1 });
    expect(rows(db, 'SELECT * FROM maint_mail')).toHaveLength(0);
    expect(rows(db, 'SELECT * FROM maint_bills')).toHaveLength(0);
  });

  it('REFUSES on a lease that ended before the issue date', async () => {
    // Scheduling is the moment a stale tenancy stops being harmless: it fixes
    // ninety-nine rates at once.
    const { db, env } = building();
    db.prepare("UPDATE owners SET lease_ends_at = '2026-03-31' WHERE id = 3").run();
    putQuarter(db);
    const r = await scheduleQuarter(env, '2026-Q4', { actorId: 1 });
    expect(r.scheduled).toBe(false);
    expect(r.reason).toBe('stale-tenancy');
    expect(r.readiness.expired[0].flat).toBe('4B');
    expect(rows(db, "SELECT * FROM maint_quarters WHERE status = 'scheduled'")).toHaveLength(0);
  });

  it('refuses an undated lease until the caller acknowledges it', async () => {
    // CHANGED 17 September 2026. This used to proceed, on the grounds that most
    // rows have no end date until the roster is filled in and refusing to bill
    // until every one is entered would miss the quarter — which is still true,
    // and is why this is an acknowledgement rather than a hard refusal.
    //
    // What changed is that it may no longer happen SILENTLY. A warning nobody
    // reads is not a decision, and the admin screen only sets the flag once
    // somebody has worked through the flagged rows.
    const { db, env } = building();
    db.prepare('UPDATE owners SET lease_ends_at = NULL WHERE id = 3').run();
    putQuarter(db);

    const refused = await scheduleQuarter(env, '2026-Q4', { actorId: 1 });
    expect(refused.scheduled).toBe(false);
    expect(refused.reason).toBe('undated-leases');
    expect(refused.undated[0].flat).toBe('4B');
    expect(rows(db, "SELECT * FROM maint_quarters WHERE status = 'scheduled'")).toHaveLength(0);
  });

  it('proceeds on an undated lease once it is acknowledged', async () => {
    // The escape hatch the old behaviour existed for, still open — just no
    // longer open by default.
    const { db, env } = building();
    db.prepare('UPDATE owners SET lease_ends_at = NULL WHERE id = 3').run();
    putQuarter(db);

    const r = await scheduleQuarter(env, '2026-Q4', { actorId: 1, acknowledgeUndated: true });
    expect(r.scheduled).toBe(true);
    expect(r.readiness.undated).toHaveLength(1);
    // Recorded, so the audit entry can say the quarter went out with undated
    // leases knowingly left in it.
    expect(r.acknowledgedUndated).toBe(true);
  });

  it('schedules without ceremony when every lease is dated', async () => {
    const { db, env } = building();
    putQuarter(db);
    const r = await scheduleQuarter(env, '2026-Q4', { actorId: 1 });
    expect(r.scheduled).toBe(true);
    expect(r.acknowledgedUndated).toBe(false);
  });

  it('refuses while a flat has somebody living in it and no owner', async () => {
    const { db, env } = building();
    // Dated, so this reaches the unresolved-flats check rather than stopping at
    // the undated-lease one — the refusal being tested is the later of the two.
    seed(db, { people: [{ id: 9, flat: '12F', relationship: 'tenant', email: 't@x.com',
                         lease_ends_at: '2027-06-30' }] });
    putQuarter(db);
    const r = await scheduleQuarter(env, '2026-Q4', { actorId: 1 });
    expect(r.scheduled).toBe(false);
    expect(r.reason).toBe('unresolved-flats');
    expect(r.unresolved[0].flat).toBe('12F');
  });

  it('will not schedule the same quarter twice', async () => {
    const { db, env } = building();
    putQuarter(db);
    await scheduleQuarter(env, '2026-Q4', { actorId: 1 });
    await expect(scheduleQuarter(env, '2026-Q4', { actorId: 2 })).rejects.toThrow();
  });
});

/* ── issuing ─────────────────────────────────────────────────────────────── */

describe('issuing the quarter', () => {
  const scheduled = async () => {
    const { db, env } = building();
    putQuarter(db);
    await scheduleQuarter(env, '2026-Q4', { actorId: 1 });
    return { db, env };
  };

  it('raises a bill per billable flat, stamped with its own rate and basis', async () => {
    const { db, env } = await scheduled();
    const r = await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });
    expect(r.issued).toBe(true);
    expect(r.count).toBe(2);

    const bills = rows(db, 'SELECT * FROM maint_bills ORDER BY flat');
    expect(bills.map((b) => [b.flat, b.basis, b.rate_applied, b.total])).toEqual([
      ['4A', 'owner', 7500, 7500],
      ['4B', 'tenant', 9000, 9000],
    ]);
    // The tenant carries the let flat's bill, not the landlord.
    expect(bills.find((b) => b.flat === '4B').owner_id).toBe(3);
  });

  it('raises nothing for an unsold flat', async () => {
    const { db, env } = await scheduled();
    await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });
    expect(rows(db, "SELECT * FROM maint_bills WHERE flat = '12F'")).toHaveLength(0);
  });

  it('queues exactly one issued letter per bill', async () => {
    const { db, env } = await scheduled();
    await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });
    const mail = rows(db, 'SELECT * FROM maint_mail ORDER BY bill_id');
    expect(mail).toHaveLength(2);
    expect(mail.every((m) => m.kind === 'issued' && m.status === 'queued')).toBe(true);
  });

  it('queues a resident with no address as unreachable, never as queued', async () => {
    // A drain must never spend a subrequest discovering an address that was
    // never there.
    const { db, env } = building();
    db.prepare('UPDATE owners SET email = NULL WHERE id = 1').run();
    putQuarter(db);
    await scheduleQuarter(env, '2026-Q4', { actorId: 2 });
    await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });

    const mail = rows(db, `SELECT m.status, b.flat FROM maint_mail m
                             JOIN maint_bills b ON b.id = m.bill_id ORDER BY b.flat`);
    expect(mail).toEqual([
      { status: 'unreachable', flat: '4A' },
      { status: 'queued', flat: '4B' },
    ]);
  });

  it('IS IDEMPOTENT — running it twice raises one set of bills', async () => {
    // The constraint doing the work is UNIQUE (flat, quarter), which is why
    // this test runs against a real database rather than a mock.
    const { db, env } = await scheduled();
    await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });
    const again = await issueQuarter(env, '2026-Q4', { today: '2026-10-02' });

    expect(again.issued).toBe(false);          // the status has moved on
    expect(rows(db, 'SELECT * FROM maint_bills')).toHaveLength(2);
    expect(rows(db, 'SELECT * FROM maint_mail')).toHaveLength(2);
  });

  it('will not issue before the issue date', async () => {
    const { env } = await scheduled();
    const r = await issueQuarter(env, '2026-Q4', { today: '2026-09-30' });
    expect(r.issued).toBe(false);
    expect(r.reason).toBe('not-yet');
  });

  describe('a flat that paid ahead settles at issue, and gets no demand', () => {
    it('settles the bill from an APPROVED advance and queues NO issued letter', async () => {
      const { db, env } = await scheduled();
      // 4A paid up to Q4, approved. 4B has no advance.
      putAdvance(db, { flat: '4A', paidThrough: '2026-Q4', reference: 'CHQ-4471' });
      const r = await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });

      expect(r.issued).toBe(true);
      expect(r.count).toBe(2);              // both bills are RAISED
      expect(r.settledFromAdvance).toBe(1); // one of them already settled

      const settled = rows(db, "SELECT * FROM maint_bills WHERE flat = '4A'")[0];
      expect(settled.status).toBe('paid');
      expect(settled.total).toBe(7500);     // the full amount, never a silent zero
      expect(settled.paid_method).toBe('advance');
      expect(settled.paid_reference).toBe('CHQ-4471');
      expect(settled.paid_at).not.toBeNull();

      // The pre-payer gets NO letter; the ordinary flat gets exactly one.
      const mail = rows(db, `SELECT b.flat, m.kind FROM maint_mail m
                               JOIN maint_bills b ON b.id = m.bill_id ORDER BY b.flat`);
      expect(mail).toEqual([{ flat: '4B', kind: 'issued' }]);
    });

    it('falls back to advance#<id> when the advance has no reference', async () => {
      const { db, env } = await scheduled();
      putAdvance(db, { flat: '4A', paidThrough: '2026-Q4', reference: null });
      await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });
      const bill = rows(db, "SELECT * FROM maint_bills WHERE flat = '4A'")[0];
      const [adv] = rows(db, "SELECT id FROM maint_advances WHERE flat = '4A'");
      expect(bill.paid_reference).toBe(`advance#${adv.id}`);
    });

    it('an UNAPPROVED advance settles nothing — the bill is unpaid and letters go out', async () => {
      const { db, env } = await scheduled();
      // approvedBy null: one admin's assertion. Letting it settle would make
      // "record an advance" a way for one person to clear dues and, via the
      // voting rule, restore a vote.
      putAdvance(db, { flat: '4A', paidThrough: '2026-Q4', approvedBy: null });
      const r = await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });

      expect(r.settledFromAdvance).toBe(0);
      expect(rows(db, "SELECT status FROM maint_bills WHERE flat = '4A'")[0].status).toBe('unpaid');
      const mail = rows(db, `SELECT b.flat FROM maint_mail m
                               JOIN maint_bills b ON b.id = m.bill_id ORDER BY b.flat`);
      expect(mail.map((m) => m.flat)).toEqual(['4A', '4B']); // both billed as normal
    });

    it('an advance that does not reach this quarter leaves the bill untouched', async () => {
      const { db, env } = await scheduled();
      // Paid up to Q3 only; Q4 is not covered (advanceCovers is inclusive of the
      // named quarter and no further).
      putAdvance(db, { flat: '4A', paidThrough: '2026-Q3' });
      const r = await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });

      expect(r.settledFromAdvance).toBe(0);
      expect(rows(db, "SELECT status FROM maint_bills WHERE flat = '4A'")[0].status).toBe('unpaid');
      expect(rows(db, 'SELECT * FROM maint_mail')).toHaveLength(2);
    });

    it('a settled-by-advance bill attracts no run-up or overdue mail and no late fee', async () => {
      const { db, env } = await scheduled();
      putAdvance(db, { flat: '4A', paidThrough: '2026-Q4' });
      await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });

      // Walk the whole letter calendar past this bill: three-days-before, the
      // due date, and the day the fee would land.
      await queueDueLetters(env, { today: '2026-10-08' });   // due_soon
      await queueDueLetters(env, { today: '2026-10-11' });   // due
      await applyMaintLateFees(env, { today: '2026-10-12' }); // overdue + fee

      const settled = rows(db, "SELECT * FROM maint_bills WHERE flat = '4A'")[0];
      expect(settled.late_fee).toBe(0);
      expect(settled.late_fee_at).toBeNull();

      // Not one letter of any kind was queued against the pre-payer.
      const mine = rows(db, `SELECT m.kind FROM maint_mail m
                               JOIN maint_bills b ON b.id = m.bill_id WHERE b.flat = '4A'`);
      expect(mine).toHaveLength(0);
    });

    it('re-running the issue job never un-settles or re-letters a settled bill', async () => {
      const { db, env } = await scheduled();
      putAdvance(db, { flat: '4A', paidThrough: '2026-Q4', reference: 'CHQ-4471' });
      await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });
      const again = await issueQuarter(env, '2026-Q4', { today: '2026-10-02' });

      expect(again.issued).toBe(false); // status moved on; ON CONFLICT protects the rest
      const bill = rows(db, "SELECT * FROM maint_bills WHERE flat = '4A'")[0];
      expect(bill.status).toBe('paid');
      expect(bill.paid_reference).toBe('CHQ-4471');
      expect(rows(db, `SELECT 1 FROM maint_mail m JOIN maint_bills b ON b.id = m.bill_id
                        WHERE b.flat = '4A'`)).toHaveLength(0);
    });
  });

  it('will not issue a quarter nobody confirmed', async () => {
    const { db, env } = building();
    putQuarter(db);     // still draft
    const r = await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });
    expect(r.issued).toBe(false);
    expect(r.reason).toBe('status-draft');
  });

  it('reports the drift between what was confirmed and what went out', async () => {
    // A tenancy that changed in the week between is a line in the summary
    // rather than a surprise in the dues report.
    const { db, env } = await scheduled();
    // A flat sells in the meantime: 12F gets an owner, so it is billed too.
    seed(db, { people: [{ id: 7, flat: '12F', relationship: 'owner', email: 'new@x.com' }] });

    const r = await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });
    expect(r.count).toBe(3);
    expect(r.expected).toEqual({ flats: 2, total: 16500 });
    expect(r.drift).toEqual({ flats: 1, total: 7500 });
  });

  it('bills a flat let after scheduling at the LET rate — the issue date decides', async () => {
    const { db, env } = await scheduled();
    seed(db, { people: [{ id: 8, flat: '4A', relationship: 'tenant', email: 'newtenant@x.com' }] });
    await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });

    const bill = rows(db, "SELECT * FROM maint_bills WHERE flat = '4A'")[0];
    expect(bill.basis).toBe('tenant');
    expect(bill.rate_applied).toBe(9000);
  });
});

/* ── the late fee ────────────────────────────────────────────────────────── */

describe('the late fee lands once, the day after the due date', () => {
  const issued = async () => {
    const { db, env } = building();
    putQuarter(db);
    await scheduleQuarter(env, '2026-Q4', { actorId: 1 });
    await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });
    return { db, env };
  };

  it('charges nothing on the due date itself', async () => {
    const { db, env } = await issued();
    await applyMaintLateFees(env, { today: '2026-10-11' });
    expect(rows(db, 'SELECT * FROM maint_bills WHERE late_fee_at IS NOT NULL')).toHaveLength(0);
  });

  it('charges every unpaid bill the morning after', async () => {
    const { db, env } = await issued();
    const r = await applyMaintLateFees(env, { today: '2026-10-12' });
    expect(r[0].charged).toBe(2);

    const bills = rows(db, 'SELECT * FROM maint_bills ORDER BY flat');
    expect(bills.map((b) => b.total)).toEqual([8250, 9750]);
    expect(bills.every((b) => b.late_fee === 750 && b.late_fee_at)).toBe(true);
  });

  it('NEVER CHARGES TWICE, however often the job runs', async () => {
    // `late_fee_at IS NULL` is the guard, and it is the database's rather than
    // ours — which is the reason this test needs a real one.
    const { db, env } = await issued();
    await applyMaintLateFees(env, { today: '2026-10-12' });
    await applyMaintLateFees(env, { today: '2026-10-13' });
    await applyMaintLateFees(env, { today: '2026-11-01' });

    const bills = rows(db, 'SELECT * FROM maint_bills ORDER BY flat');
    expect(bills.map((b) => b.total)).toEqual([8250, 9750]);
  });

  it('queues the overdue letter with the fee, in the same act', async () => {
    // A bill can never be charged without the resident being told why.
    const { db, env } = await issued();
    await applyMaintLateFees(env, { today: '2026-10-12' });
    const overdue = rows(db, "SELECT * FROM maint_mail WHERE kind = 'overdue'");
    expect(overdue).toHaveLength(2);
  });

  it('leaves a paid bill alone', async () => {
    const { db, env } = await issued();
    db.prepare("UPDATE maint_bills SET status = 'paid', paid_at = '2026-10-05' WHERE flat = '4A'").run();
    await applyMaintLateFees(env, { today: '2026-10-12' });

    const paid = rows(db, "SELECT * FROM maint_bills WHERE flat = '4A'")[0];
    expect(paid.total).toBe(7500);
    expect(paid.late_fee_at).toBe(null);
  });

  it('CHARGES a bill that has only been claimed — tapping Pay is not paying', async () => {
    const { db, env } = await issued();
    db.prepare("UPDATE maint_bills SET status = 'awaiting' WHERE flat = '4A'").run();
    await applyMaintLateFees(env, { today: '2026-10-12' });
    expect(rows(db, "SELECT * FROM maint_bills WHERE flat = '4A'")[0].total).toBe(8250);
  });

  it('holds while two admins are deciding', async () => {
    const { db, env } = await issued();
    const bill = rows(db, "SELECT id FROM maint_bills WHERE flat = '4A'")[0];
    db.prepare(
      `INSERT INTO maint_approval_requests (kind, bill_id, reason, requested_by, requested_at, expires_at, status)
       VALUES ('late-fee-waiver', ?, 'disputed', 1, '2026-10-11T00:00:00Z', '2026-10-25T00:00:00Z', 'pending')`
    ).run(bill.id);

    await applyMaintLateFees(env, { today: '2026-10-12' });
    expect(rows(db, "SELECT * FROM maint_bills WHERE flat = '4A'")[0].late_fee_at).toBe(null);
  });

  it('honours an approved exemption, and ignores an unapproved one', async () => {
    const { db, env } = await issued();
    const exempt = (ownerId, approved) => db.prepare(
      `INSERT INTO maint_fee_exemptions (owner_id, reason, ends_at, granted_by, granted_at, approved_by)
       VALUES (?, 'hardship', '2026-12-31', 99, '2026-10-01T00:00:00Z', ?)`
    ).run(ownerId, approved);
    // Two admins, because the granter and the approver must be different people
    // — and because approved_by is a real foreign key, which is what caught the
    // first version of this test inventing an approver who did not exist.
    seed(db, { people: [
      { id: 98, flat: '4A', relationship: 'owner', role: 'admin', email: 'a1@x.com' },
      { id: 99, flat: '4B', relationship: 'owner', role: 'admin', email: 'a2@x.com' },
    ]});
    exempt(1, 98);      // 4A's owner, approved
    exempt(3, null);    // 4B's tenant, NOT approved

    await applyMaintLateFees(env, { today: '2026-10-12' });
    expect(rows(db, "SELECT * FROM maint_bills WHERE flat = '4A'")[0].late_fee_at).toBe(null);
    expect(rows(db, "SELECT * FROM maint_bills WHERE flat = '4B'")[0].total).toBe(9750);
  });
});

describe('the first-touch fee', () => {
  const issued = async () => {
    const { db, env } = building();
    putQuarter(db);
    await scheduleQuarter(env, '2026-Q4', { actorId: 1 });
    await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });
    const id = rows(db, "SELECT id FROM maint_bills WHERE flat = '4B'")[0].id;
    return { db, env, id };
  };

  it('applies the fee when a resident opens the page after midnight', async () => {
    // Cron triggers are scheduled, not punctual. Without this, somebody paying
    // at 00:05 is handed the pre-fee amount and lands ₹750 short.
    const { db, env, id } = await issued();
    const r = await applyLateFeeToMaintBill(env, id, { today: '2026-10-12' });
    expect(r).toMatchObject({ applied: true, lateFee: 750, total: 9750 });
    expect(rows(db, 'SELECT * FROM maint_bills WHERE id = ?', id)[0].total).toBe(9750);
  });

  it('reports `raced` rather than a fee it did not write', async () => {
    // On a page load this is the number the resident is about to pay, so
    // reporting off the decision instead of off meta.changes would display a
    // fee that was never applied.
    const { env, id } = await issued();
    await applyLateFeeToMaintBill(env, id, { today: '2026-10-12' });
    const second = await applyLateFeeToMaintBill(env, id, { today: '2026-10-12' });
    expect(second).toEqual({ applied: false, reason: 'already-applied' });
  });

  it('does nothing before the fee is due', async () => {
    const { env, id } = await issued();
    expect(await applyLateFeeToMaintBill(env, id, { today: '2026-10-11' }))
      .toEqual({ applied: false, reason: 'not-yet-due' });
  });
});

/* ── the run-up letters ──────────────────────────────────────────────────── */

describe('the two reminders between issuing and the due date', () => {
  const issued = async () => {
    const { db, env } = building();
    putQuarter(db);
    await scheduleQuarter(env, '2026-Q4', { actorId: 1 });
    await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });
    return { db, env };
  };

  it('queues due_soon three days out, and nothing else', async () => {
    const { db, env } = await issued();
    await queueDueLetters(env, { today: '2026-10-08' });
    const kinds = rows(db, 'SELECT DISTINCT kind FROM maint_mail ORDER BY kind').map((r) => r.kind);
    expect(kinds).toEqual(['due_soon', 'issued']);
  });

  it('queues due on the day itself', async () => {
    const { db, env } = await issued();
    await queueDueLetters(env, { today: '2026-10-11' });
    expect(rows(db, "SELECT * FROM maint_mail WHERE kind = 'due'")).toHaveLength(2);
  });

  it('queues nothing on an ordinary day', async () => {
    const { db, env } = await issued();
    await queueDueLetters(env, { today: '2026-10-06' });
    expect(rows(db, "SELECT * FROM maint_mail WHERE kind <> 'issued'")).toHaveLength(0);
  });

  it('does not chase a bill that has been paid', async () => {
    const { db, env } = await issued();
    db.prepare("UPDATE maint_bills SET status = 'paid' WHERE flat = '4A'").run();
    await queueDueLetters(env, { today: '2026-10-08' });

    const chased = rows(db, `SELECT b.flat FROM maint_mail m JOIN maint_bills b ON b.id = m.bill_id
                              WHERE m.kind = 'due_soon'`);
    expect(chased.map((r) => r.flat)).toEqual(['4B']);
  });

  it('queues each moment once, however often the job runs', async () => {
    // PRIMARY KEY (bill_id, kind). The reason a resident cannot be told twice.
    const { db, env } = await issued();
    await queueDueLetters(env, { today: '2026-10-08' });
    await queueDueLetters(env, { today: '2026-10-08' });
    expect(rows(db, "SELECT * FROM maint_mail WHERE kind = 'due_soon'")).toHaveLength(2);
  });

  it('never queues a moment late — a missed day stays missed', async () => {
    // A "three days to go" email arriving on the 12th is worse than none.
    const { db, env } = await issued();
    await queueDueLetters(env, { today: '2026-10-12' });
    expect(rows(db, "SELECT * FROM maint_mail WHERE kind = 'due_soon'")).toHaveLength(0);
  });
});

/* ── reading the building ────────────────────────────────────────────────── */

describe('flatsWithPeople', () => {
  it('returns every active flat, including the ones with nobody on them', async () => {
    const { env } = building();
    const list = await flatsWithPeople(env);
    expect(list.map((f) => f.flat)).toEqual(['12F', '4A', '4B']);
    expect(list.find((f) => f.flat === '12F').people).toEqual([]);
    expect(list.find((f) => f.flat === '4B').people).toHaveLength(2);
  });

  it('leaves out a flat the committee has taken off billing', async () => {
    const { db, env } = building();
    db.prepare("UPDATE flats SET active = 0 WHERE flat = '12F'").run();
    expect((await flatsWithPeople(env)).map((f) => f.flat)).toEqual(['4A', '4B']);
  });
});

/* ── the drain ───────────────────────────────────────────────────────────── */

describe('draining the outbox', () => {
  const MAIL_ENV = {
    GOOGLE_CLIENT_ID: 'i', GOOGLE_CLIENT_SECRET: 's',
    GOOGLE_REFRESH_TOKEN: 'r', MAIL_FROM: 'ddp@x.com',
  };

  /**
   * Gmail, faked at the network boundary rather than by stubbing sendEmail —
   * so the token refresh, the message build and the Cc header are all really
   * exercised. `calls` is what was actually sent.
   */
  function fakeGmail({ fail = false } = {}) {
    const calls = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('oauth2')) {
        return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      }
      calls.push(JSON.parse(init.body));
      return fail
        ? new Response('no', { status: 400 })
        : new Response(JSON.stringify({ id: 'm' }), { status: 200 });
    });
    return { calls, restore: () => spy.mockRestore() };
  }

  const decode = (raw) => atob(raw.replace(/-/g, '+').replace(/_/g, '/'));

  /**
   * The Subject header, readable.
   *
   * It arrives RFC 2047 encoded whenever it is not pure ASCII — and every
   * maintenance subject contains the en dash in "Q4 2026 (Oct–Dec)", so this is
   * the normal case rather than the exception. Worth decoding rather than
   * matching loosely: the encoding is exactly what stops a rupee sign or a
   * Malayalam character arriving as mojibake, so a test that side-stepped it
   * would side-step the thing being relied on.
   */
  const subjectOf = (raw) => {
    const line = decode(raw).match(/^Subject: (.*)$/m)[1];
    const enc = /^=\?UTF-8\?B\?(.*)\?=$/.exec(line);
    return enc ? new TextDecoder().decode(Uint8Array.from(atob(enc[1]), (c) => c.charCodeAt(0))) : line;
  };

  const issued = async () => {
    const { db, env } = building(MAIL_ENV);
    putQuarter(db);
    await scheduleQuarter(env, '2026-Q4', { actorId: 1 });
    await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });
    return { db, env };
  };

  it('sends one letter per queued row and marks them sent', async () => {
    const { db, env } = await issued();
    const gmail = fakeGmail();
    const r = await drainMaintMail(env, { today: '2026-10-01' });
    gmail.restore();

    expect(r).toEqual({ sent: 2, failed: 0 });
    expect(gmail.calls).toHaveLength(2);
    expect(rows(db, "SELECT * FROM maint_mail WHERE status = 'sent'")).toHaveLength(2);
  });

  it('NEVER SENDS THE SAME LETTER TWICE', async () => {
    // The claim the outbox exists for. A `sent` row is never selected, so the
    // nightly cron landing on a quarter an admin is already draining is the
    // same operation rather than a second email to a neighbour.
    const { env } = await issued();
    const gmail = fakeGmail();
    await drainMaintMail(env, { today: '2026-10-01' });
    const second = await drainMaintMail(env, { today: '2026-10-01' });
    gmail.restore();

    expect(second).toEqual({ sent: 0, failed: 0 });
    expect(gmail.calls).toHaveLength(2);
  });

  it('mints ONE token for the whole batch, not one per send', async () => {
    // One send is two subrequests if it refreshes its own token. A quarter at
    // two-per-send would exceed the 50-subrequest cap; this is the line that
    // makes a batch of N cost N+1.
    const { env } = await issued();
    const calls = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push(String(url));
      if (String(url).includes('oauth2')) {
        return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'm' }), { status: 200 });
    });
    await drainMaintMail(env, { today: '2026-10-01' });
    spy.mockRestore();

    expect(calls.filter((u) => u.includes('oauth2'))).toHaveLength(1);
    expect(calls).toHaveLength(3);        // 1 refresh + 2 sends
  });

  it('copies the landlord on a let flat, and nobody on an owner-occupied one', async () => {
    const { env } = await issued();
    const gmail = fakeGmail();
    await drainMaintMail(env, { today: '2026-10-01' });
    gmail.restore();

    const sent = gmail.calls.map((c) => decode(c.raw));
    const toTenant = sent.find((m) => /^To: tenant4b@x\.com$/m.test(m));
    expect(toTenant).toMatch(/^Cc: owner4b@x\.com$/m);

    const toOwner = sent.find((m) => /^To: owner4a@x\.com$/m.test(m));
    expect(toOwner).not.toMatch(/^Cc:/m);
  });

  it('never attempts a resident with no address', async () => {
    const { db, env } = building(MAIL_ENV);
    db.prepare('UPDATE owners SET email = NULL WHERE id = 1').run();
    putQuarter(db);
    await scheduleQuarter(env, '2026-Q4', { actorId: 2 });
    await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });

    const gmail = fakeGmail();
    const r = await drainMaintMail(env, { today: '2026-10-01' });
    gmail.restore();

    expect(r.sent).toBe(1);
    expect(gmail.calls).toHaveLength(1);
    expect(rows(db, "SELECT * FROM maint_mail WHERE status = 'unreachable'")).toHaveLength(1);
  });

  it('parks a permanent refusal immediately instead of retrying it nightly', async () => {
    // Three identical 400s on three nights tell nobody anything, and each costs
    // a subrequest the next drain could have used.
    const { db, env } = await issued();
    const gmail = fakeGmail({ fail: true });
    const r = await drainMaintMail(env, { today: '2026-10-01' });
    gmail.restore();

    expect(r.failed).toBe(2);
    const failed = rows(db, "SELECT * FROM maint_mail WHERE status = 'failed'");
    expect(failed.every((m) => m.attempts === 3 && m.last_error === 'gmail-400')).toBe(true);

    // And it is not picked up again.
    const gmail2 = fakeGmail();
    expect(await drainMaintMail(env, { today: '2026-10-01' })).toEqual({ sent: 0, failed: 0 });
    gmail2.restore();
  });

  it('does nothing at all when Gmail is not configured', async () => {
    // Still the case in production. The quarter issues, the bills are live, and
    // rows stay queued for the day the credentials land.
    const { db, env } = building();
    putQuarter(db);
    await scheduleQuarter(env, '2026-Q4', { actorId: 1 });
    await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });

    const r = await drainMaintMail(env, { today: '2026-10-01' });
    expect(r.reason).toBe('not-configured');
    expect(rows(db, "SELECT * FROM maint_mail WHERE status = 'queued'")).toHaveLength(2);
  });

  it('sends the letter the row asks for, not whichever is newest', async () => {
    const { db, env } = await issued();
    const gmail0 = fakeGmail();
    await drainMaintMail(env, { today: '2026-10-01' });   // clears the issued ones
    gmail0.restore();

    await queueDueLetters(env, { today: '2026-10-08' });
    const gmail = fakeGmail();
    await drainMaintMail(env, { today: '2026-10-08' });
    gmail.restore();

    const subjects = gmail.calls.map((c) => subjectOf(c.raw));
    // The three-days-early subject, not the issued one: the row's kind decides
    // the letter, and a drain that sent whichever letter was newest would tell
    // everybody the wrong thing at exactly the moment it matters.
    expect(subjects.every((s) => /due in 3 days/i.test(s))).toBe(true);
    expect(rows(db, "SELECT * FROM maint_mail WHERE kind = 'due_soon' AND status = 'sent'"))
      .toHaveLength(2);
  });
});
