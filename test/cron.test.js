import { describe, it, expect } from 'vitest';
import { planLateFees } from '../functions/lib/cron.js';
import { validateComment, shapeComments, MAX_COMMENT } from '../functions/lib/notices.js';

const opts = { today: '2026-08-12', dueDate: '2026-08-10', lateFee: 50 };

const bill = (over = {}) => ({ id: 1, flat: '4A', status: 'unpaid', total: 329, late_fee_at: null, ...over });

describe('planning a month of late fees', () => {
  it('charges bills nobody has touched', () => {
    const plan = planLateFees([bill()], opts);
    expect(plan.charge).toHaveLength(1);
    expect(plan.charge[0].newTotal).toBe(379);
  });

  it('adds the same fee to every overdue bill and keeps them whole', () => {
    const plan = planLateFees(
      [bill({ total: 329 }), bill({ id: 2, flat: '4B', total: 195 }),
       bill({ id: 3, flat: '13A', total: 345 })],
      opts
    );
    expect(plan.charge.map((b) => b.newTotal)).toEqual([379, 245, 395]);
  });

  it('HOLDS a resident who tapped Pay — approval lag is not their fault', () => {
    // Claimed two days ago, well inside the week. This is the case the hold
    // exists for and it must keep working.
    const plan = planLateFees(
      [bill({ status: 'initiated', claimed_at: '2026-08-10T09:00:00Z' })], opts);
    expect(plan.charge).toHaveLength(0);
    expect(plan.hold).toHaveLength(1);
    expect(plan.hold[0].reason).toBe('payment-claimed');
  });

  it('stops holding once the claim has had its week (B13)', () => {
    // The hold used to have no end, which made `initiated` an exemption anybody
    // could grant themselves by tapping a button.
    const plan = planLateFees(
      [bill({ status: 'initiated', claimed_at: '2026-08-01T09:00:00Z' })],
      { ...opts, today: '2026-08-20' });
    expect(plan.hold).toHaveLength(0);
    expect(plan.charge).toHaveLength(1);
    expect(plan.charge[0].newTotal).toBe(379);
  });

  it('holds through the last day of the window, not part of it', () => {
    // claimed_at carries a time and `today` does not, so an instant comparison
    // would end the hold early or late depending on what o'clock they tapped.
    const claimed = { status: 'initiated', claimed_at: '2026-08-10T23:30:00Z' };
    const lastDay = planLateFees([bill(claimed)], { ...opts, today: '2026-08-17' });
    expect(lastDay.hold).toHaveLength(1);
    const dayAfter = planLateFees([bill(claimed)], { ...opts, today: '2026-08-18' });
    expect(dayAfter.charge).toHaveLength(1);
  });

  it('charges an initiated bill that has no claim time at all', () => {
    // An unknown is not a reason to hold forever — that was the bug. 0016
    // backfills existing rows so this should not occur, but the decision must
    // not depend on the migration having run.
    const plan = planLateFees([bill({ status: 'initiated' })], opts);
    expect(plan.hold).toHaveLength(0);
    expect(plan.charge[0].reason ?? 'charge').toBeDefined();
    expect(plan.charge).toHaveLength(1);
  });

  it('never charges a proof already under review', () => {
    const plan = planLateFees([bill({ status: 'awaiting' })], opts);
    expect(plan.charge).toHaveLength(0);
    expect(plan.skip[0].reason).toBe('proof-under-review');
  });

  it('is idempotent — a second run charges nothing', () => {
    // The guard that matters most: this runs nightly and may be invoked twice.
    const first = planLateFees([bill()], opts);
    const afterCharge = { ...bill(), late_fee_at: '2026-08-11T03:00:00Z', total: first.charge[0].newTotal };
    const second = planLateFees([afterCharge], opts);
    expect(second.charge).toHaveLength(0);
    expect(second.skip[0].reason).toBe('already-applied');
  });

  it('never compounds across repeated runs', () => {
    let current = bill();
    for (let run = 0; run < 5; run++) {
      const plan = planLateFees([current], opts);
      if (!plan.charge.length) break;
      current = { ...current, total: plan.charge[0].newTotal, late_fee_at: '2026-08-11T03:00:00Z' };
    }
    expect(current.total).toBe(379); // charged exactly once
  });

  it('does nothing before the due date', () => {
    const plan = planLateFees([bill()], { ...opts, today: '2026-08-09' });
    expect(plan.charge).toHaveLength(0);
    expect(plan.skip[0].reason).toBe('not-yet-due');
  });

  it('honours the grace window', () => {
    const graced = { ...opts, graceDays: 5 };
    expect(planLateFees([bill()], { ...graced, today: '2026-08-13' }).charge).toHaveLength(0);
    expect(planLateFees([bill()], { ...graced, today: '2026-08-16' }).charge).toHaveLength(1);
  });

  it('leaves settled bills alone', () => {
    const plan = planLateFees([bill({ status: 'paid' }), bill({ id: 2, status: 'waived' })], opts);
    expect(plan.charge).toHaveLength(0);
    expect(plan.skip).toHaveLength(2);
  });

  it('refuses a nonsense fee before touching a single bill', () => {
    // Both are refused, and refusing BEFORE any write is the point: the cron
    // charges a whole month at once, so a bad fee caught halfway through would
    // leave some residents charged and some not.
    //
    // The paise case previously asserted 380, on the belief that the ceiling
    // absorbed the fraction. The database disagrees — it still requires whole
    // rupees — so that would have been a 500 mid-run.
    expect(() => planLateFees([bill()], { ...opts, lateFee: 50.5 })).toThrow(/DDP-BILL-008/);
    expect(() => planLateFees([bill()], { ...opts, lateFee: -50 })).toThrow(/DDP-BILL-008/);
  });

  it('splits a mixed month correctly', () => {
    const plan = planLateFees([
      bill({ id: 1, status: 'unpaid' }),
      bill({ id: 2, status: 'initiated', claimed_at: '2026-08-11T09:00:00Z' }),
      bill({ id: 3, status: 'awaiting' }),
      bill({ id: 4, status: 'paid' }),
      bill({ id: 5, status: 'unpaid', late_fee_at: 'x' }),
    ], opts);
    expect([plan.charge.length, plan.hold.length, plan.skip.length]).toEqual([1, 1, 3]);
  });
});

describe('comments', () => {
  it('rejects empty and whitespace-only', () => {
    expect(validateComment('').ok).toBe(false);
    expect(validateComment('   ').ok).toBe(false);
  });

  it('trims and accepts real text', () => {
    expect(validateComment('  6 AM is too early  ')).toMatchObject({ ok: true, text: '6 AM is too early' });
  });

  it('caps length', () => {
    expect(validateComment('x'.repeat(MAX_COMMENT + 1)).ok).toBe(false);
    expect(validateComment('x'.repeat(MAX_COMMENT)).ok).toBe(true);
  });

  const rows = [
    { id: 1, body: 'Fine by me', name: 'Priya Menon', flat: '7C', created_at: 'a', hidden_at: null, hidden_by: null },
    { id: 2, body: 'Something unkind', name: 'Anon', flat: '2B', created_at: 'b', hidden_at: 'c', hidden_by: 3, hidden_by_name: 'Joy' },
  ];

  it('hides a moderated comment from residents entirely', () => {
    const out = shapeComments(rows, { isAdmin: false });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Priya Menon');
  });

  it('shows admins what was hidden and who hid it — moderation stays auditable', () => {
    const out = shapeComments(rows, { isAdmin: true });
    expect(out).toHaveLength(2);
    expect(out[1].hidden).toBe(true);
    expect(out[1].hiddenBy).toBe('Joy');
    expect(out[1].body).toBe('Something unkind');
  });

  it('always attaches a name and flat — there is no anonymity by design', () => {
    const out = shapeComments(rows, { isAdmin: false });
    expect(out[0].flat).toBe('7C');
  });
});

describe('late fee exemptions', () => {
  const opts = { today: '2026-08-20', dueDate: '2026-08-10', graceDays: 0, lateFee: 50 };
  const b = (o) => ({ id: 1, flat: '4B', status: 'unpaid', total: 329,
                      late_fee_at: null, late_fee_exempt_until: null, ...o });

  it('skips a resident the committee exempted', () => {
    const p = planLateFees([b({ late_fee_exempt_until: '2026-11-30' })], opts);
    expect(p.charge).toHaveLength(0);
    expect(p.skip[0].reason).toBe('exempt');
  });

  it('charges again once the exemption has run out', () => {
    // The whole point of the end date: forgetting must be the safe direction.
    const p = planLateFees([b({ late_fee_exempt_until: '2026-07-01' })], opts);
    expect(p.charge).toHaveLength(1);
  });

  it('treats the last day as still exempt', () => {
    // "Exempt until 30 November" plainly includes the 30th.
    const p = planLateFees([b({ late_fee_exempt_until: '2026-08-20' })], opts);
    expect(p.skip[0].reason).toBe('exempt');
  });

  it('reports exemptions separately from ordinary skips', () => {
    // An exemption is a decision somebody made. It belongs in the morning
    // digest, not buried among "already paid".
    const p = planLateFees([
      b({ id: 1, flat: '4A' }),
      b({ id: 2, flat: '4B', late_fee_exempt_until: '2026-11-30' }),
      b({ id: 3, flat: '5A', status: 'paid' }),
    ], opts);
    expect(p.charge.map((x) => x.flat)).toEqual(['4A']);
    expect(p.exempt.map((x) => x.flat)).toEqual(['4B']);
    expect(p.skip).toHaveLength(2);
  });

  it('says "exempt" rather than "not yet due" when both are true', () => {
    // The reason recorded should be the real one, or the digest misleads.
    const p = planLateFees([b({ late_fee_exempt_until: '2026-11-30' })],
      { ...opts, today: '2026-08-01' });
    expect(p.skip[0].reason).toBe('exempt');
  });

  it('still refuses to charge an already-charged bill, exempt or not', () => {
    const p = planLateFees([b({ late_fee_at: '2026-08-11T03:00:00Z' })], opts);
    expect(p.skip[0].reason).toBe('already-applied');
  });
});
