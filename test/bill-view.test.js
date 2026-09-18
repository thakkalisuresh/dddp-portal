import { describe, it, expect } from 'vitest';
import { testEnv, seed } from './support/d1.js';
import {
  resolveBill, resolveReturn, billDetailPayload, paySheetPayload,
  ACCOUNT_MODE_APPS, UPI_MODE_APPS,
} from '../functions/lib/bill-view.js';

/**
 * Against a REAL SQLite with the real migrations, because what is being tested
 * here is who can read which bill — and that answer comes out of a WHERE clause
 * rather than out of a branch we could mock. Bill visibility is the one thing
 * in this app that has already had a privacy bug.
 */

/** 4A owner-occupied, 4B let by owner 2 to tenant 3, 5C a different household. */
function building(extra = {}) {
  const { db, env } = testEnv({
    MAINT_PAYEE_NAME: 'DD Diamond Park RWA',
    MAINT_ACCOUNT_NUMBER: '000000000000',
    MAINT_IFSC: 'XXXX0000000',
    UPI_VPA: 'someone@bank',
    UPI_PAYEE: 'DD Diamond Park RWA',
    ...extra,
  });
  seed(db, {
    flats: ['4A', '4B', '5C'],
    people: [
      { id: 1, flat: '4A', relationship: 'owner' },
      { id: 2, flat: '4B', relationship: 'owner' },
      { id: 3, flat: '4B', relationship: 'tenant' },
      { id: 4, flat: '5C', relationship: 'owner' },
    ],
  });
  db.prepare(
    `INSERT INTO maint_quarters
       (quarter, owner_rate, tenant_rate, late_fee, issue_date, due_date, status, created_at)
     VALUES ('2026-Q4', 7500, 9000, 750, '2026-10-01', '2026-10-11', 'issued', '2026-09-24T00:00:00Z')`
  ).run();
  return { db, env };
}

function putMaintBill(db, { id = 1, flat = '4B', ownerId = 3, total = 9000, status = 'unpaid' } = {}) {
  db.prepare(
    `INSERT INTO maint_bills
       (id, flat, quarter, owner_id, rate_applied, basis, late_fee, total, status, created_at)
     VALUES (?, ?, '2026-Q4', ?, ?, ?, 0, ?, ?, '2026-10-01T00:00:00Z')`
  ).run(id, flat, ownerId, total, total === 9000 ? 'tenant' : 'owner', total, status);
  return id;
}

// `active` matters: billAccess() refuses a departed viewer everything, so a
// fixture without it tests the departed path rather than the one intended.
function putGasBill(db, { id = 50, ownerId = 3, status = 'unpaid' } = {}) {
  db.prepare(
    `INSERT OR IGNORE INTO periods
       (period, rate_per_kg, conversion_factor, due_date, late_fee, status, created_at)
     VALUES ('2026-09', 60, 2.6, '2026-10-10', 50, 'open', '2026-09-01T00:00:00Z')`
  ).run();
  db.prepare(
    `INSERT INTO bills (id, flat, period, owner_id, consumption, meter_delta, rate_per_kg,
                        conversion_factor, gas_amount, other_charges, additional_charges,
                        late_fee, total, status, created_at)
     VALUES (?, '4B', '2026-09', ?, 4.0, 1.538, 60, 2.6, 240, 0, 0, 0, 240, ?,
             '2026-10-01T00:00:00Z')`
  ).run(id, ownerId, status);
  return id;
}

const viewer = (id, flat, relationship = 'owner') =>
  ({ id, flat, relationship, name: `P${id}`, role: 'owner', active: 1 });

describe('resolveReturn', () => {
  it('allows the three internal destinations a resident can arrive from', () => {
    expect(resolveReturn('/dashboard')).toBe('/dashboard');
    expect(resolveReturn('/polls')).toBe('/polls');
    expect(resolveReturn('/polls#poll-7')).toBe('/polls#poll-7');
    expect(resolveReturn('/bill?id=12')).toBe('/bill?id=12');
  });

  it('sends anything else Home rather than following it', () => {
    // AN ALLOWLIST, NOT A SANITISER. The value arrives off the query string, so
    // the rule that cannot be got wrong by accident is that anything
    // unrecognised goes Home instead of anywhere it asked for.
    for (const hostile of [
      'https://evil.example/pay',
      '//evil.example',
      '/dashboard@evil.example',
      'javascript:alert(1)',
      '/polls#poll-7" onclick="x',
      '/bill?id=12&next=//evil.example',
      '',
      null,
      undefined,
    ]) {
      expect(resolveReturn(hostile)).toBe('/dashboard');
    }
  });
});

describe('resolveBill', () => {
  it('finds a household’s own maintenance bill', async () => {
    const { db, env } = building();
    putMaintBill(db, { id: 1, flat: '4B', ownerId: 3 });
    const found = await resolveBill(env, viewer(3, '4B', 'tenant'), 1);
    expect(found.kind).toBe('maintenance');
    expect(found.card.total).toBe(9000);
  });

  it('refuses another flat’s bill', async () => {
    const { db, env } = building();
    putMaintBill(db, { id: 1, flat: '4B', ownerId: 3 });
    expect(await resolveBill(env, viewer(4, '5C'), 1)).toBeNull();
  });

  it('gives an absent bill and a forbidden one the same answer', async () => {
    // Indistinguishable on purpose: a "not yours" that differs from "no such
    // bill" lets somebody walk the ids and learn which flats owe what.
    const { db, env } = building();
    putMaintBill(db, { id: 1, flat: '4B', ownerId: 3 });
    expect(await resolveBill(env, viewer(4, '5C'), 1)).toBeNull();
    expect(await resolveBill(env, viewer(4, '5C'), 99999)).toBeNull();
  });

  it('refuses a non-numeric or negative id without touching the database', async () => {
    const { env } = building();
    for (const id of ['abc', '-1', '0', '1 OR 1=1', null, undefined, '1.5']) {
      expect(await resolveBill(env, viewer(1, '4A'), id)).toBeNull();
    }
  });

  it('lets the landlord of a let flat read the tenant’s bill', async () => {
    // The one place the bills-follow-the-person rule is relaxed, and only for
    // amounts — never for screenshots.
    const { db, env } = building();
    putMaintBill(db, { id: 1, flat: '4B', ownerId: 3 });
    const found = await resolveBill(env, viewer(2, '4B', 'owner'), 1);
    expect(found).not.toBeNull();
    expect(found.access.reason).toBe('landlord');
    expect(found.access.proofs).toBe(false);
  });
});

describe('billDetailPayload', () => {
  it('sends the maintenance parts and no gas parts', async () => {
    // Absent, not zeroed. A maintenance bill reporting 0.000 kg would be a
    // number somebody eventually tries to explain.
    const { db, env } = building();
    putMaintBill(db, { id: 1 });
    const payload = await billDetailPayload(env, viewer(3, '4B', 'tenant'), 1);
    expect(payload.kind).toBe('maintenance');
    expect(payload.gas).toBeUndefined();
    expect(payload.maintenance.quarterLabel).toContain('Oct');
    expect(payload.maintenance.basis).toBe('tenant');
  });

  it('is null for a bill this viewer may not read', async () => {
    const { db, env } = building();
    putMaintBill(db, { id: 1 });
    expect(await billDetailPayload(env, viewer(4, '5C'), 1)).toBeNull();
  });

  it('names the tenant for the landlord and hides their proofs', async () => {
    const { db, env } = building();
    putMaintBill(db, { id: 1 });
    const payload = await billDetailPayload(env, viewer(2, '4B'), 1);
    expect(payload.viewing).toBe('landlord');
    expect(payload.occupantName).toBe('P3');
    expect(payload.seesProofs).toBe(false);
  });
});

describe('paySheetPayload', () => {
  it('offers only the apps that accept a bank account in account mode', async () => {
    // PhonePe and Paytm refuse <account>@<IFSC>.ifsc.npci outright. Offering
    // them would be two dead buttons, and a resident whose payment app "does
    // not work" blames the portal.
    const { db, env } = building();
    putMaintBill(db, { id: 1 });
    const sheet = await paySheetPayload(env, viewer(3, '4B', 'tenant'), 1);
    expect(sheet.mode).toBe('account');
    expect(sheet.apps).toEqual(ACCOUNT_MODE_APPS);
    expect(sheet.apps).not.toContain('phonepe');
    expect(sheet.apps).not.toContain('paytm');
  });

  it('offers every app once the association has a UPI ID of its own', async () => {
    const { db, env } = building({ MAINT_PAYEE_MODE: 'upi', MAINT_UPI_VPA: 'rwa@bank' });
    putMaintBill(db, { id: 1 });
    const sheet = await paySheetPayload(env, viewer(3, '4B', 'tenant'), 1);
    expect(sheet.mode).toBe('upi');
    expect(sheet.apps).toEqual(UPI_MODE_APPS);
  });

  it('carries the note, which reconciliation depends on', async () => {
    // Maintenance amounts are identical across flats of the same kind, so the
    // unique-paise fingerprint gas relies on does not exist here — this string
    // and the flat are the only two things the treasurer has.
    const { db, env } = building();
    putMaintBill(db, { id: 1 });
    const sheet = await paySheetPayload(env, viewer(3, '4B', 'tenant'), 1);
    expect(sheet.note).toBe('(4B_MAINT_Q4_26)');
  });

  it('refuses to render a sheet for a settled bill', async () => {
    // Sending someone to a payment screen for a bill they have already paid is
    // how duplicate transfers happen, and a duplicate credit is far more work
    // for the treasurer than a missing one.
    const { db, env } = building();
    putMaintBill(db, { id: 1, status: 'paid' });
    const sheet = await paySheetPayload(env, viewer(3, '4B', 'tenant'), 1);
    expect(sheet.payable).toBe(false);
  });

  it('refuses a bill whose screenshot is already with the treasurer', async () => {
    const { db, env } = building();
    putMaintBill(db, { id: 1, status: 'awaiting' });
    const sheet = await paySheetPayload(env, viewer(3, '4B', 'tenant'), 1);
    expect(sheet.payable).toBe(false);
  });

  it('still offers the sheet after a handoff that went nowhere', async () => {
    // `initiated` means an app opened, which proves nothing. That resident
    // still needs the button.
    const { db, env } = building();
    putMaintBill(db, { id: 1, status: 'initiated' });
    const sheet = await paySheetPayload(env, viewer(3, '4B', 'tenant'), 1);
    expect(sheet.payable).toBe(true);
  });

  it('resolves the return destination server-side, never echoing the query', async () => {
    const { db, env } = building();
    putMaintBill(db, { id: 1 });
    const sheet = await paySheetPayload(env, viewer(3, '4B', 'tenant'), 1, {
      from: 'https://evil.example/steal',
    });
    expect(sheet.back).toBe('/dashboard');
  });

  it('lets a landlord pay the tenant’s MAINTENANCE on their behalf', async () => {
    const { db, env } = building();
    putMaintBill(db, { id: 1 });
    const sheet = await paySheetPayload(env, viewer(2, '4B'), 1);
    expect(sheet.payable).toBe(true);
  });

  it('lets a landlord pay their tenant’s GAS bill too', async () => {
    // ONE RULE, BOTH KINDS, decided 17 September 2026. The original rule gave
    // the landlord no Pay button on either; the user overturned it after being
    // shown that the approved mockup contradicted it.
    const { db, env } = building();
    putGasBill(db);

    const tenantSheet = await paySheetPayload(env, viewer(3, '4B', 'tenant'), 50);
    expect(tenantSheet.payable).toBe(true);

    const landlordSheet = await paySheetPayload(env, viewer(2, '4B'), 50);
    expect(landlordSheet.payable).toBe(true);

    const detail = await billDetailPayload(env, viewer(2, '4B'), 50);
    expect(detail.viewing).toBe('landlord');
    expect(detail.canPay).toBe(true);
    // The line the rule change did NOT move.
    expect(detail.seesProofs).toBe(false);
  });

  it('removes the button from BOTH parties once either uploads a proof', async () => {
    // THIS IS THE ASSERTION CARRYING THE RISK the old rule was protecting
    // against. Two people can pay one bill, so what stops the duplicate is that
    // an upload by either of them takes the button away from both — and it
    // works because the status lives on the BILL, not on the viewer.
    const { db, env } = building();
    putGasBill(db);
    putMaintBill(db, { id: 1 });

    // The tenant uploads a screenshot: the gas bill goes to `awaiting`.
    db.prepare("UPDATE bills SET status = 'awaiting' WHERE id = 50").run();
    expect((await paySheetPayload(env, viewer(3, '4B', 'tenant'), 50)).payable).toBe(false);
    expect((await paySheetPayload(env, viewer(2, '4B'), 50)).payable).toBe(false);

    // The landlord uploads for the maintenance bill: the same, both ways.
    db.prepare("UPDATE maint_bills SET status = 'awaiting' WHERE id = 1").run();
    expect((await paySheetPayload(env, viewer(2, '4B'), 1)).payable).toBe(false);
    expect((await paySheetPayload(env, viewer(3, '4B', 'tenant'), 1)).payable).toBe(false);
  });
});
