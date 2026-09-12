#!/usr/bin/env node
/**
 * Pull the database down as CSV so it can be queried with real SQL, offline.
 *
 *   node scripts/query.mjs                      # the local dev database
 *   node scripts/query.mjs --staging            # dddp-migtest (scrubbed)
 *   node scripts/query.mjs --remote --confirm   # PRODUCTION, real residents
 *
 * WHY THIS EXISTS INSTEAD OF A SECOND DATABASE. The question it answers is
 * "let me slice the data however I like without any chance of breaking it",
 * and the cheapest correct answer is a FILE. A file cannot be written to by
 * accident, cannot drift from production, cannot be fixed in the wrong place,
 * and needs no pipeline to keep in step. A downstream query database would
 * offer the same SQL and add three failure modes: staleness, a sync job, and
 * the standing temptation to correct data in the copy — where the fix is
 * silently destroyed by the next refresh.
 *
 * So: the system of record stays the one D1 database, and analysis happens on
 * a dated snapshot that is obviously a snapshot.
 *
 * THE CSV WRITER IS NOT REIMPLEMENTED HERE. toCsv and stripSecrets come from
 * functions/lib/backup.js — the same pair the nightly bundle uses, already
 * RFC 4180 correct and already refusing to write password material. A second
 * CSV writer in a script is how the two spellings of "quote a comma" drift
 * apart, and the one in a script is the one nobody tests.
 *
 * WHAT THIS PUTS ON YOUR LAPTOP, read this before using --remote. Every
 * resident's name, mobile, email, and complete payment history, unencrypted,
 * in a folder that no longer has retention rules, a privacy policy, or an
 * audit log attached to it. That is why production needs --confirm and the
 * local database does not, and why the default output folder is gitignored.
 * Delete it when you are done; `--out` exists so it can go somewhere
 * deliberate.
 *
 * Credentials never come down at all: TABLES excludes `sessions`,
 * `password_resets` and `password_history` (see NEVER_BACKUP), and
 * stripSecrets drops pw_hash and pw_salt from the rows that remain.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLES, toCsv, stripSecrets } from '../functions/lib/backup.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const at = argv.indexOf(flag);
  return at === -1 ? null : argv[at + 1];
};

const remote = has('--remote');
const staging = has('--staging');
const DB = staging ? 'dddp-migtest' : 'dddp';

// Production is the only target that needs a gate, and it needs one for the
// reason in the header: this is the command that copies 99 people's records
// onto a laptop. Staging is already scrubbed and local is already yours.
if (remote && !staging && !has('--confirm')) {
  console.error('\n  --remote copies every resident\'s real name, mobile, email and');
  console.error('  payment history to this machine, unencrypted.\n');
  console.error('  Re-run with --confirm if that is what you want, or use');
  console.error('  --staging for the scrubbed copy.\n');
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 10);
const outDir = valueOf('--out') ?? join(root, '.query', `${staging ? 'staging' : remote ? 'prod' : 'local'}-${stamp}`);

function rows(table) {
  // --json so the parse is a parse and not a scrape of a formatted table.
  // wrangler prints a banner before the JSON, hence the slice to the first
  // bracket -- the same trick the other scripts here use, for the same reason.
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', DB,
    remote || staging ? '--remote' : '--local',
    '--command', `SELECT * FROM ${table}`, '--json', '--yes'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(out.slice(out.indexOf('['))).flatMap((r) => r.results ?? []);
}

mkdirSync(outDir, { recursive: true });
console.log(`\n  ${DB} ${remote || staging ? '(remote)' : '(local)'} -> ${outDir}\n`);

let total = 0;
for (const table of TABLES) {
  // stripSecrets before toCsv, not after: toCsv already filters the same two
  // columns, and relying on one of them alone is how a future column gets
  // missed by whichever guard somebody forgot about.
  const data = stripSecrets(rows(table));
  writeFileSync(join(outDir, `${table}.csv`), toCsv(data));
  total += data.length;
  process.stdout.write(`\r  ${table.padEnd(22)} ${String(data.length).padStart(6)} rows`);
}
console.log(`\n\n  ${TABLES.length} tables, ${total} rows.\n`);

// A view per file rather than a single import step, so a stale CSV cannot be
// silently queried: read_csv_auto reads the file at query time.
console.log('  Query it:\n');
console.log(`    cd ${outDir} && duckdb`);
console.log("    D SELECT flat, period, total FROM 'bills.csv' WHERE status = 'unpaid';");
console.log("    D SELECT o.flat, count(*) FROM 'bills.csv' b");
console.log("        JOIN 'owners.csv' o ON o.id = b.owner_id GROUP BY 1 ORDER BY 2 DESC;\n");
console.log('  Nothing here writes back. Fix data in production, never in the snapshot.\n');
