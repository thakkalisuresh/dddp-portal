#!/usr/bin/env node
/**
 * Prove migration 0042's payment_proofs rebuild against a POPULATED database.
 *
 * check-migrations.mjs applies everything to an empty D1, and says so in its
 * own header: it does not prove a migration survives real rows. 0042 is the
 * first one that rebuilds a table people have already written to, so the rows
 * that matter are the awkward ones — a deleted proof whose r2_key was nulled,
 * a proof with no UTR, several of those at once against the partial unique
 * index, and a reconciliation pointing at a proof id that must not move.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'dddp-rebuild-'));
const mig = join(repo, 'migrations', '0042_maintenance_billing.sql');
const parked = join(dir, '0042.parked.sql');

const wrangler = (args) => execFileSync('npx', ['wrangler', ...args, '--local', '--persist-to', dir],
  { encoding: 'utf8', cwd: repo, env: { ...process.env, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
const sql = (command) => JSON.parse(wrangler(['d1', 'execute', 'dddp', '--json', '--command', command]))
  .flatMap((r) => r.results ?? []);

let ok = true;
const check = (label, actual, expected) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) console.log(`      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`);
};

try {
  // ── everything BEFORE 0042 ────────────────────────────────────────────
  renameSync(mig, parked);
  wrangler(['d1', 'migrations', 'apply', 'dddp']);

  // ── rows the rebuild has to survive ───────────────────────────────────
  sql(`INSERT INTO flats (flat, floor) VALUES ('4A', 4), ('4B', 4)`);
  sql(`INSERT INTO owners (id, flat, name, mobile, email, pw_hash, pw_salt, created_at)
       VALUES (1, '4A', 'Owner A', '9000000001', 'a@x.com', 'h', 's', '2026-01-01T00:00:00Z'),
              (2, '4B', 'Owner B', '9000000002', 'b@x.com', 'h', 's', '2026-01-01T00:00:00Z')`);
  sql(`INSERT INTO periods (period, rate_per_kg, due_date, created_at)
       VALUES ('2026-08', 75, '2026-09-10', '2026-09-01T00:00:00Z')`);
  sql(`INSERT INTO bills (id, flat, period, meter_delta, consumption, conversion_factor,
                          rate_per_kg, gas_amount, total, created_at, owner_id)
       VALUES (10, '4A', '2026-08', 1.6, 4.16, 2.6, 75, 312, 312, '2026-09-01T00:00:00Z', 1),
              (11, '4B', '2026-08', 1.7, 4.42, 2.6, 75, 331.5, 332, '2026-09-01T00:00:00Z', 2)`);

  sql(`INSERT INTO payment_proofs (id, bill_id, owner_id, r2_key, image_sha256, utr,
                                   parsed_amount, status, reviewed_by, reviewed_at,
                                   deleted_at, backed_up_at, created_at)
       VALUES
         -- the ordinary case
         (100, 10, 1, 'proofs/100.jpg', 'sha-100', 'UTR100', 312, 'approved', 2,
          '2026-09-03T00:00:00Z', NULL, '2026-09-04T00:00:00Z', '2026-09-02T00:00:00Z'),
         -- DELETED: r2_key nulled, row retained, sha256 survives for dedupe
         (101, 11, 2, NULL, 'sha-101', 'UTR101', 332, 'rejected', 2,
          '2026-09-05T00:00:00Z', '2026-09-06T00:00:00Z', NULL, '2026-09-02T00:00:00Z'),
         -- no UTR at all, twice over: the partial unique index must tolerate
         -- several NULLs, which a plain UNIQUE would not
         (102, 10, 1, 'proofs/102.jpg', 'sha-102', NULL, NULL, 'pending', NULL, NULL,
          NULL, NULL, '2026-09-07T00:00:00Z'),
         (103, 11, 2, 'proofs/103.jpg', 'sha-103', NULL, NULL, 'pending', NULL, NULL,
          NULL, NULL, '2026-09-07T00:00:00Z')`);

  // 0017's statement_matches points at proof ids. Renumbering rows in the
  // rebuild would silently repoint every reconciliation ever recorded.
  const reconCols = sql(`PRAGMA table_info(reconciliations)`).map((c) => c.name);
  if (reconCols.includes('proof_id')) {
    sql(`INSERT INTO reconciliations (id, proof_id, bill_id, verdict, created_at)
         VALUES (900, 101, 11, 'proof_no_credit', '2026-09-08T00:00:00Z')`);
  }

  const before = sql(`SELECT id, bill_id, owner_id, r2_key, image_sha256, utr, parsed_amount,
                             status, reviewed_by, reviewed_at, deleted_at, backed_up_at, created_at
                        FROM payment_proofs ORDER BY id`);

  // ── apply 0042 ────────────────────────────────────────────────────────
  renameSync(parked, mig);
  wrangler(['d1', 'migrations', 'apply', 'dddp']);

  const after = sql(`SELECT id, bill_id, owner_id, r2_key, image_sha256, utr, parsed_amount,
                            status, reviewed_by, reviewed_at, deleted_at, backed_up_at, created_at
                       FROM payment_proofs ORDER BY id`);

  check('every proof row survives, byte for byte, with its id', after, before);
  check('ids are preserved so reconciliations still point at the right proof',
        after.map((r) => r.id), [100, 101, 102, 103]);
  check('the deleted proof keeps its null r2_key and its deleted_at',
        after.find((r) => r.id === 101).r2_key, null);
  check('maint_bill_id is null on every migrated gas proof',
        sql(`SELECT COUNT(*) n FROM payment_proofs WHERE maint_bill_id IS NOT NULL`)[0].n, 0);

  // ── the new constraints actually bite ─────────────────────────────────
  const refuses = (label, command) => {
    try { sql(command); check(label, 'accepted', 'refused'); }
    catch { check(label, 'refused', 'refused'); }
  };
  refuses('a proof pointing at BOTH kinds of bill is refused',
    `INSERT INTO payment_proofs (id, bill_id, maint_bill_id, image_sha256, status, created_at)
     VALUES (200, 10, 1, 'sha-200', 'pending', '2026-10-01T00:00:00Z')`);
  refuses('a proof pointing at NEITHER is refused',
    `INSERT INTO payment_proofs (id, image_sha256, status, created_at)
     VALUES (201, 'sha-201', 'pending', '2026-10-01T00:00:00Z')`);
  refuses('the same screenshot cannot be spent twice across bill kinds',
    `INSERT INTO payment_proofs (id, bill_id, image_sha256, status, created_at)
     VALUES (202, 11, 'sha-100', 'pending', '2026-10-01T00:00:00Z')`);

  // Several NULL UTRs must still coexist after the partial index is recreated.
  sql(`INSERT INTO payment_proofs (id, bill_id, image_sha256, utr, status, created_at)
       VALUES (203, 10, 'sha-203', NULL, 'pending', '2026-10-01T00:00:00Z')`);
  check('several proofs with no UTR coexist under the partial unique index',
        sql(`SELECT COUNT(*) n FROM payment_proofs WHERE utr IS NULL`)[0].n, 3);
  refuses('a duplicate non-null UTR is still refused',
    `INSERT INTO payment_proofs (id, bill_id, image_sha256, utr, status, created_at)
     VALUES (204, 10, 'sha-204', 'UTR100', 'pending', '2026-10-01T00:00:00Z')`);

  // ── a maintenance proof, end to end ───────────────────────────────────
  sql(`INSERT INTO maint_quarters (quarter, owner_rate, tenant_rate, issue_date, due_date, created_at)
       VALUES ('2026-Q4', 7500, 9000, '2026-10-01', '2026-10-11', '2026-09-20T00:00:00Z')`);
  sql(`INSERT INTO maint_bills (id, flat, quarter, owner_id, rate_applied, basis, total, created_at)
       VALUES (500, '4A', '2026-Q4', 1, 7500, 'owner', 7500, '2026-10-01T00:00:00Z')`);
  sql(`INSERT INTO payment_proofs (id, maint_bill_id, owner_id, image_sha256, utr, status, created_at)
       VALUES (300, 500, 1, 'sha-300', 'UTR300', 'pending', '2026-10-02T00:00:00Z')`);
  check('a maintenance proof sits in the same table and the same queue',
        sql(`SELECT COUNT(*) n FROM payment_proofs WHERE status = 'pending'`)[0].n, 4);

  // ── the other new constraints ─────────────────────────────────────────
  refuses('a second bill for the same flat and quarter is refused',
    `INSERT INTO maint_bills (id, flat, quarter, owner_id, rate_applied, basis, total, created_at)
     VALUES (501, '4A', '2026-Q4', 1, 7500, 'owner', 7500, '2026-10-01T00:00:00Z')`);
  refuses('a fractional rate is refused',
    `INSERT INTO maint_bills (id, flat, quarter, owner_id, rate_applied, basis, total, created_at)
     VALUES (502, '4B', '2026-Q4', 2, 7500.5, 'owner', 7500, '2026-10-01T00:00:00Z')`);
  refuses('a malformed quarter label is refused',
    `INSERT INTO maint_quarters (quarter, owner_rate, tenant_rate, issue_date, due_date, created_at)
     VALUES ('2026-10', 7500, 9000, '2026-10-01', '2026-10-11', '2026-09-20T00:00:00Z')`);
  refuses('an approval request about both a bill and a flat is refused',
    `INSERT INTO maint_approval_requests (kind, bill_id, flat, reason, requested_by, requested_at, expires_at)
     VALUES ('late-fee-waiver', 500, '4A', 'r', 1, '2026-10-01T00:00:00Z', '2026-10-08T00:00:00Z')`);
  refuses('an admin cannot approve their own advance',
    `INSERT INTO maint_advances (flat, paid_through, amount, recorded_by, recorded_at, approved_by)
     VALUES ('4A', '2027-Q2', 30000, 1, '2026-10-01T00:00:00Z', 1)`);

  // ── reconciliations survived being rebuilt twice ──────────────────────
  check('the reconciliation row survives, still pointing at proof 101',
        sql(`SELECT id, proof_id, bill_id, verdict, created_at FROM reconciliations ORDER BY id`),
        [{ id: 900, proof_id: 101, bill_id: 11, verdict: 'proof_no_credit', created_at: '2026-09-08T00:00:00Z' }]);
  refuses('the foreign key into payment_proofs is back, not quietly dropped',
    `INSERT INTO reconciliations (id, proof_id, bill_id, verdict, created_at)
     VALUES (901, 88888, 11, 'confirmed', '2026-10-01T00:00:00Z')`);
  check('both reconciliation indexes exist again',
        sql(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='reconciliations' AND name LIKE 'ix_%' ORDER BY name`)
          .map((r) => r.name),
        ['ix_reconciliations_bill', 'ix_reconciliations_proof']);

  // ── the whole database is still sound ─────────────────────────────────
  const orphans = sql(`PRAGMA foreign_key_check`);
  check('foreign_key_check is empty after the rebuild', orphans, []);

  console.log(ok ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  console.error(err.stderr || err.stdout || err.message);
  process.exitCode = 1;
} finally {
  try { renameSync(parked, mig); } catch { /* already back */ }
  rmSync(dir, { recursive: true, force: true });
}
