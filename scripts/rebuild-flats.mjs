#!/usr/bin/env node
/**
 * Remove the dead legacy_paise_tag column from `flats`.
 *
 * WHY THIS IS A SCRIPT AND NOT A MIGRATION. The column is UNIQUE with a
 * CHECK, so it cannot be dropped in place — SQLite requires a table rebuild.
 * D1 refuses that rebuild three different ways, all verified rather than
 * assumed:
 *
 *   plain DROP + RENAME            FOREIGN KEY constraint failed
 *   PRAGMA defer_foreign_keys=ON   aborts at COMMIT instead
 *   PRAGMA legacy_alter_table=ON   FOREIGN KEY constraint failed
 *
 * The obstacle is always the same: rows in owners/readings/bills reference
 * flats, and D1 will not suspend that check. So the referencing rows are
 * lifted out, the table is rebuilt, and everything goes back with identical
 * ids — which is what keeps password hashes, audit history and bills intact.
 *
 * WHY IT MATTERS. CHECK (legacy_paise_tag BETWEEN 1 AND 99) is a hard ceiling
 * of 99 flats. DD Diamond Park has exactly 99. There is no headroom at all:
 * one servant's quarter, one split duplex, or one miscount and the roster
 * import dies partway through.
 *
 *   node scripts/rebuild-flats.mjs --local
 *   node scripts/rebuild-flats.mjs --remote --confirm
 *
 * Refuses to run against remote without --confirm. Writes a full JSON dump
 * before touching anything, and verifies every table's row count afterwards —
 * a restore that silently drops rows is the failure worth guarding against.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB = 'dddp';
const local = process.argv.includes('--local');
const confirmed = process.argv.includes('--confirm');

if (!local && !confirmed) {
  console.error('\nThis rewrites a table on PRODUCTION. Re-run with --confirm.\n');
  process.exit(1);
}

/** Every table holding a reference into owners or flats, children first. */
const DEPENDENTS = [
  'password_resets', 'click_log', 'activity', 'messages', 'comments',
  'payment_intents', 'payment_proofs', 'audit_log', 'sessions',
  'bills', 'readings',
];

function sql(statement, { file = false } = {}) {
  const args = ['wrangler', 'd1', 'execute', DB, local ? '--local' : '--remote',
    file ? '--file' : '--command', statement, '--json', '--yes'];
  const out = execFileSync('npx', args,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.slice(out.indexOf('['))).flatMap((r) => r.results ?? []);
}

function runFile(statements) {
  const dir = mkdtempSync(join(tmpdir(), 'ddp-rebuild-'));
  const f = join(dir, 'x.sql');
  writeFileSync(f, statements);
  return sql(f, { file: true });
}

const count = (t) => sql(`SELECT COUNT(*) AS n FROM ${t}`)[0]?.n ?? 0;
const lit = (v) => (v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? String(v)
  : `'${String(v).replace(/'/g, "''")}'`);

function insertsFor(table, rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  return rows.map((r) =>
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => lit(r[c])).join(',')});`
  ).join('\n');
}

const main = () => {
  console.log(`\nRebuilding flats on ${local ? 'LOCAL' : 'PRODUCTION'}.\n`);

  const already = sql(
    "SELECT COUNT(*) AS n FROM pragma_table_info('flats') WHERE name='legacy_paise_tag'")[0].n;
  if (!already) {
    console.log('  Already rebuilt. Nothing to do.\n');
    return;
  }

  // ── 1. read everything out ─────────────────────────────────────────────
  const before = {};
  const data = {};
  for (const t of ['flats', 'owners', ...DEPENDENTS]) {
    data[t] = sql(`SELECT * FROM ${t}`);
    before[t] = data[t].length;
  }
  console.log('  before: ' + Object.entries(before)
    .filter(([, n]) => n).map(([t, n]) => `${t}=${n}`).join(' '));

  const dir = mkdtempSync(join(tmpdir(), 'ddp-dump-'));
  const dump = join(dir, `flats-rebuild-${Date.now()}.json`);
  writeFileSync(dump, JSON.stringify(data, null, 2));
  console.log(`  dump:   ${dump}\n`);

  // ── 2. clear the references, children first ────────────────────────────
  // Order matters: payment_proofs before bills, everything before owners.
  runFile([...DEPENDENTS, 'owners'].map((t) => `DELETE FROM ${t};`).join('\n'));

  // ── 3. rebuild, now that nothing points at it ──────────────────────────
  runFile(`
    CREATE TABLE flats_rebuilt (
      flat   TEXT PRIMARY KEY,
      floor  INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    DROP TABLE flats;
    ALTER TABLE flats_rebuilt RENAME TO flats;
  `);

  // ── 4. put it all back, identical ids ──────────────────────────────────
  const flats = data.flats.map(({ flat, floor, active }) => ({ flat, floor, active }));
  const restore = [
    insertsFor('flats', flats),
    insertsFor('owners', data.owners),
    // Reverse order: parents before the children that reference them.
    ...[...DEPENDENTS].reverse().map((t) => insertsFor(t, data[t])),
  ].filter(Boolean).join('\n');
  if (restore) runFile(restore);

  // ── 5. prove nothing was lost ──────────────────────────────────────────
  const after = {};
  for (const t of ['flats', 'owners', ...DEPENDENTS]) after[t] = count(t);

  const lost = Object.keys(before).filter((t) => before[t] !== after[t]);
  console.log('  after:  ' + Object.entries(after)
    .filter(([, n]) => n).map(([t, n]) => `${t}=${n}`).join(' '));

  const col = sql(
    "SELECT COUNT(*) AS n FROM pragma_table_info('flats') WHERE name='legacy_paise_tag'")[0].n;

  if (lost.length || col) {
    console.error('\n  FAILED.');
    for (const t of lost) console.error(`    ${t}: ${before[t]} -> ${after[t]}`);
    if (col) console.error('    the column is still there');
    console.error(`\n  Everything read out is in ${dump}\n`);
    process.exit(1);
  }

  console.log('\n  Done. Column gone, every row back, no flat limit.\n');
  console.log('  Everyone has been signed out — sessions were restored, but log in again');
  console.log('  if anything looks odd.\n');
};

main();
