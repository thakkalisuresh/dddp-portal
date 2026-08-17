#!/usr/bin/env node
// Rebuild the staging D1 (dddp-migtest) from a fresh export of production.
//
// Data moves ONE WAY: prod -> staging. Nothing in staging is ever promoted
// back. Whatever test users, fake flats and junk bills you made in staging are
// destroyed by this script, and that is the point -- staging is disposable, so
// a botched migration costs a re-import instead of a Time Travel restore on
// live resident data.
//
// The export carries the d1_migrations ledger with it, so staging lands on
// exactly the migration prod is on. That is why staging is rebuilt rather than
// migrated up from where it is: migtest was originally created from a raw
// schema dump and has no ledger of its own.
//
// NOTE: this copies REAL resident data -- names, flat numbers, phone numbers,
// payment history. Same committee either way, but it is real. There is no
// scrubbing step here; if one is wanted it belongs after the import, as its own
// SQL file, so it can be reviewed rather than buried in this script.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROD = 'dddp';
const STAGING = 'dddp-migtest';

// Guard against the one catastrophic typo this script could contain. Every
// destructive statement below is aimed at STAGING; if that name ever reads as
// production, refuse rather than drop 99 residents' records.
if (STAGING === PROD || STAGING === 'dddp') {
  console.error('refusing to run: staging target resolves to production');
  process.exit(1);
}

const wrangler = (args) =>
  execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 256 * 1024 * 1024,
  });

const query = (db, sql) => {
  const out = wrangler(['d1', 'execute', db, '--remote', '--json', '--command', sql]);
  return JSON.parse(out)[0].results;
};

// Objects that are NOT ours to drop, and that D1 refuses with a bare
// "not authorized: SQLITE_AUTH" that names neither the statement nor the table:
//
//   sqlite_%  SQLite's own bookkeeping, including the sqlite_autoindex_* rows
//             it creates for every UNIQUE / PRIMARY KEY column.
//   _cf_%     D1's internal storage. `_cf_KV` sits in sqlite_master looking
//             exactly like an application table, and dropping it is refused.
//
// One rejected statement fails the whole batch, so a single stray name here
// means nothing gets dropped at all. The emptiness check below reuses this
// predicate for the same reason -- a check that counted _cf_KV would report
// staging as dirty forever.
const NOT_INTERNAL = `name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`;

const tmp = mkdtempSync(join(tmpdir(), 'dddp-staging-'));
const schemaPath = join(tmp, 'schema.sql');
const dataPath = join(tmp, 'data.sql');
const dropPath = join(tmp, 'drop.sql');

try {
  // Schema and data are exported SEPARATELY, and that is not tidiness.
  //
  // A single combined dump is written table-by-table -- CREATE TABLE, then that
  // table's INSERTs, then the next table -- so a table carrying
  // `REFERENCES owners(id)` is created before `owners` exists. The dump opens
  // with `PRAGMA defer_foreign_keys=TRUE` to cover exactly this, but the pragma
  // lasts one transaction and D1 ingests a file this size in several, so the
  // deferral is gone by the time it is needed. Replaying the combined dump dies
  // on `no such table: main.owners`.
  //
  // Loading every CREATE first means all tables exist before any row is
  // written, which removes the forward reference entirely.
  //
  // -y because export warns that the database is briefly unavailable and waits
  // for an answer. stdin is 'ignore' here so wrangler would fall back to yes on
  // its own, but relying on a fallback for a prompt about production going
  // unavailable is not something to leave implicit.
  console.log(`exporting ${PROD} ...`);
  wrangler(['d1', 'export', PROD, '--remote', '-y', '--no-data', '--output', schemaPath]);
  wrangler(['d1', 'export', PROD, '--remote', '-y', '--no-schema', '--output', dataPath]);
  const kb = (p) => (statSync(p).size / 1024).toFixed(0);
  console.log(`  schema ${kb(schemaPath)} KB, data ${kb(dataPath)} KB`);

  // Clear staging. The export replays CREATE TABLE, so anything left behind
  // collides. sqlite_* is SQLite's own bookkeeping and is not ours to drop.
  console.log(`clearing ${STAGING} ...`);
  const objects = query(
    STAGING,
    `SELECT type, name FROM sqlite_master
      WHERE ${NOT_INTERNAL}
        AND type IN ('table','view','index','trigger')
      ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'view' THEN 1
                         WHEN 'index' THEN 2 ELSE 3 END`
  );

  if (objects.length) {
    // Indexes and triggers owned by a table disappear with it, so DROP TABLE
    // may already have taken them -- IF EXISTS absorbs that.
    const drops = objects.map((o) => `DROP ${o.type.toUpperCase()} IF EXISTS "${o.name}";`);
    writeFileSync(dropPath, `PRAGMA defer_foreign_keys = true;\n${drops.join('\n')}\n`);
    wrangler(['d1', 'execute', STAGING, '--remote', '--file', dropPath, '--yes']);
    console.log(`  dropped ${objects.length} objects`);
  } else {
    console.log('  already empty');
  }

  // The drop MUST have emptied staging before the dump is replayed. D1 writes
  // its export with CREATE TABLE IF NOT EXISTS, so replaying onto surviving
  // tables does not fail -- it appends prod's rows to whatever was already
  // there and leaves a staging database that looks plausible and is doubled.
  // Check rather than trust, because the failure is silent.
  const [{ left }] = query(
    STAGING,
    `SELECT count(*) AS left FROM sqlite_master WHERE ${NOT_INTERNAL}`
  );
  if (left > 0) {
    throw new Error(
      `${STAGING} still holds ${left} objects after the drop; refusing to import onto them`
    );
  }

  // NOT `wrangler d1 import` -- no such subcommand in wrangler 4. Replaying
  // through `execute --file` is the supported path.
  console.log(`loading schema into ${STAGING} ...`);
  wrangler(['d1', 'execute', STAGING, '--remote', '--yes', '--file', schemaPath]);

  // Foreign keys OFF for the data load. Rows come out grouped by table, so a
  // child row is written before the parent it points at and D1 rolls the whole
  // ingest back with SQLITE_CONSTRAINT_FOREIGNKEY. Deferring does not help for
  // the reason above -- one pragma cannot span D1's several transactions --
  // and reordering the rows would mean topologically sorting the schema here.
  //
  // This is safe ONLY because production satisfies its own constraints, so a
  // faithful copy of it does too. That is not an assumption worth carrying
  // silently, so it is checked against prod first, and checked again on staging
  // after the load. Disabling enforcement while copying known-good data is
  // fine; disabling it while copying unknown data would just move the
  // corruption somewhere quieter.
  const prodViolations = query(PROD, 'PRAGMA foreign_key_check');
  if (prodViolations.length) {
    throw new Error(
      `${PROD} has ${prodViolations.length} foreign key violations; refusing to copy them with enforcement off`
    );
  }

  console.log(`loading data into ${STAGING} ...`);
  writeFileSync(dataPath, `PRAGMA foreign_keys=OFF;\n${readFileSync(dataPath, 'utf8')}`);
  wrangler(['d1', 'execute', STAGING, '--remote', '--yes', '--file', dataPath]);

  const stagingViolations = query(STAGING, 'PRAGMA foreign_key_check');
  if (stagingViolations.length) {
    throw new Error(
      `${STAGING} has ${stagingViolations.length} foreign key violations after the load`
    );
  }

  const [{ tables, mig, owners }] = query(
    STAGING,
    `SELECT (SELECT count(*) FROM sqlite_master WHERE type='table') AS tables,
            (SELECT max(name) FROM d1_migrations) AS mig,
            (SELECT count(*) FROM owners) AS owners`
  );
  console.log(`\n${STAGING} rebuilt: ${tables} tables, ${owners} owners, ledger at ${mig}`);
  console.log('staging now mirrors production. Test users you create here are wiped by the next refresh.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
