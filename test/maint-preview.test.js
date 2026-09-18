/**
 * The letter preview: what the admin reads before committing the building to
 * four letters, and the one thing it must never do.
 *
 * Against a REAL SQLite with the real migrations, because the guarantee that
 * matters is a claim about `maint_mail` — UNIQUE (bill_id, kind) is what makes
 * the drain idempotent, and a preview that spent a key would cost a resident
 * the real letter without anything failing. Only a database can answer whether
 * a row was written.
 */

import { describe, it, expect } from 'vitest';
import { testEnv, seed, rows } from './support/d1.js';
import { previewLetter, scheduleQuarter, issueQuarter } from '../functions/lib/maint-cron.js';

const TODAY = '2026-09-24';

/** 4A owner-occupied, 4B let, 12F with nobody in it. */
function building() {
  const { db, env } = testEnv();
  seed(db, {
    flats: ['4A', '4B', '12F'],
    people: [
      { id: 1, flat: '4A', relationship: 'owner', email: 'owner4a@x.com' },
      { id: 2, flat: '4B', relationship: 'owner', email: 'owner4b@x.com' },
      { id: 3, flat: '4B', relationship: 'tenant', email: 'tenant4b@x.com',
        lease_ends_at: '2027-06-30' },
    ],
  });
  db.prepare(
    `INSERT INTO maint_quarters
       (quarter, owner_rate, tenant_rate, late_fee, issue_date, due_date, status, created_at)
     VALUES ('2026-Q4', 7500, 9000, 750, '2026-10-01', '2026-10-11', 'draft', '2026-09-24T00:00:00Z')`
  ).run();
  return { db, env };
}

describe('previewLetter', () => {
  it('renders the issued letter for a flat the quarter would bill, before any bill exists', async () => {
    const { env } = building();
    const p = await previewLetter(env, '2026-Q4', { flat: '4A', today: TODAY });

    expect(p.projected).toBe(true);
    expect(p.basis).toBe('owner');
    expect(p.subject).toMatch(/Q4 2026/);
    expect(p.text).toContain('7500');
    expect(p.text).toContain('4A');
  });

  it('uses the rented rate for a let flat, exactly as issuing would', async () => {
    // The whole point of the button: the admin reads the letter the tenant of
    // 4B will get, including the line explaining why it is ₹9000 and not ₹7500.
    const { env } = building();
    const p = await previewLetter(env, '2026-Q4', { flat: '4B', today: TODAY });

    expect(p.basis).toBe('tenant');
    expect(p.text).toContain('9000');
  });

  it('writes nothing to the outbox — not one row, not for any kind', async () => {
    // THE failure this test exists for. A queued row holds the (bill_id, kind)
    // key the drain skips on, so a preview that queued would silently replace
    // the real letter with nothing.
    const { db, env } = building();
    for (const kind of ['issued', 'due_soon', 'due', 'overdue']) {
      await previewLetter(env, '2026-Q4', { flat: '4B', kind, today: TODAY });
    }
    expect(rows(db, 'SELECT * FROM maint_mail')).toEqual([]);
    expect(rows(db, 'SELECT * FROM maint_bills')).toEqual([]);
  });

  it('reads the real bill once the quarter has issued, and says it is no longer a projection', async () => {
    const { env } = building();
    await scheduleQuarter(env, '2026-Q4', { issueDate: '2026-10-01', acknowledged: true, actorId: 1 });
    await issueQuarter(env, '2026-Q4', { today: '2026-10-01' });

    const p = await previewLetter(env, '2026-Q4', { flat: '4A', today: '2026-10-01' });
    expect(p.projected).toBe(false);
    expect(p.text).toContain('7500');
  });

  it('refuses a flat this quarter would not bill', async () => {
    // 12F has nobody in it. The honest answer is not "no such flat" — it is
    // that there is no letter, because there will be no bill.
    const { env } = building();
    await expect(previewLetter(env, '2026-Q4', { flat: '12F', today: TODAY }))
      .rejects.toThrow(/DDP-MAINT-010/);
    await expect(previewLetter(env, '2026-Q4', { flat: '9Z', today: TODAY }))
      .rejects.toThrow(/DDP-MAINT-010/);
  });

  it('refuses a letter kind that does not exist', async () => {
    const { env } = building();
    await expect(previewLetter(env, '2026-Q4', { flat: '4A', kind: 'shouty', today: TODAY }))
      .rejects.toThrow(/DDP-MAINT-009/);
  });

  it('refuses a quarter that does not exist', async () => {
    const { env } = building();
    await expect(previewLetter(env, '2027-Q1', { flat: '4A', today: TODAY }))
      .rejects.toThrow(/DDP-MAINT-007/);
  });

  it('names the voting consequence in the overdue letter only once the quarter has ended', async () => {
    // The conditional line in letter 4, read through the preview: the admin
    // should be able to see that it is conditional rather than take it on trust.
    const { env } = building();
    const during = await previewLetter(env, '2026-Q4', { flat: '4A', kind: 'overdue', today: '2026-11-15' });
    const after = await previewLetter(env, '2026-Q4', { flat: '4A', kind: 'overdue', today: '2027-01-15' });

    expect(during.text).not.toMatch(/cannot vote/);
    expect(after.text).toMatch(/cannot vote/);
  });
});
