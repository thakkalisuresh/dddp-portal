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
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
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

const tmp = mkdtempSync(join(tmpdir(), 'dddp-staging-'));
const dumpPath = join(tmp, 'prod.sql');
const dropPath = join(tmp, 'drop.sql');

try {
  console.log(`exporting ${PROD} ...`);
  wrangler(['d1', 'export', PROD, '--remote', '--output', dumpPath]);
  console.log(`  ${(statSync(dumpPath).size / 1024).toFixed(0)} KB`);

  // Clear staging. The export replays CREATE TABLE, so anything left behind
  // collides. sqlite_* is SQLite's own bookkeeping and is not ours to drop.
  console.log(`clearing ${STAGING} ...`);
  const objects = query(
    STAGING,
    `SELECT type, name FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
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

  console.log(`importing into ${STAGING} ...`);
  wrangler(['d1', 'import', STAGING, '--remote', '--file', dumpPath]);

  const [{ tables, mig }] = query(
    STAGING,
    `SELECT (SELECT count(*) FROM sqlite_master WHERE type='table') AS tables,
            (SELECT max(name) FROM d1_migrations) AS mig`
  );
  console.log(`\n${STAGING} rebuilt: ${tables} tables, migration ledger at ${mig}`);
  console.log('staging now mirrors production. Test users you create here are wiped by the next refresh.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
