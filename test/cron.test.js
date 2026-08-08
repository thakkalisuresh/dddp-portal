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
    const plan = planLateFees([bill({ status: 'initiated' })], opts);
    expect(plan.charge).toHaveLength(0);
    expect(plan.hold).toHaveLength(1);
    expect(plan.hold[0].reason).toBe('payment-claimed');
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
    // A fee with paise is fine now (the ceiling absorbs it); a negative one
    // would quietly credit every overdue resident.
    expect(planLateFees([bill()], { ...opts, lateFee: 50.5 }).charge[0].newTotal).toBe(380);
    expect(() => planLateFees([bill()], { ...opts, lateFee: -50 })).toThrow(/DDP-BILL-008/);
  });

  it('splits a mixed month correctly', () => {
    const plan = planLateFees([
      bill({ id: 1, status: 'unpaid' }),
      bill({ id: 2, status: 'initiated' }),
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
