#!/usr/bin/env node
/**
 * Rebuild production as an empty database for launch, keeping exactly one
 * account: the superadmin at 4A.
 *
 *   node scripts/launch-rebuild.mjs capture --confirm   # BEFORE the delete
 *   node scripts/launch-rebuild.mjs migrate --confirm   # only if `apply` refuses
 *   node scripts/launch-rebuild.mjs seed    --confirm   # 99 flats, no accounts
 *   node scripts/launch-rebuild.mjs account --confirm   # the superadmin, when asked
 *   node scripts/launch-rebuild.mjs verify              # read-only, any time
 *
 * EVERY ACCOUNT GOES, INCLUDING THE SUPERADMIN'S. That is deliberate and it is
 * what makes this a rebuild rather than a prune with an exception in it: there
 * is no row carried across by hand, no hash smuggled from the old database, and
 * the state in between is the honest one -- a building with flats and nobody
 * enrolled. `account` puts the superadmin back afterwards, with no working
 * password, and `reset-my-password.mjs` sets one without it passing through
 * anybody's terminal or an assistant's context.
 *
 * Add --local to rehearse the whole sequence against the local dev database
 * first. That is worth doing once: every step below is cheap locally and the
 * remote ones include a step that cannot be undone.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO. It never calls `d1 delete` or
 * `d1 create`. Those two commands are the irreversible edge of this operation
 * and they belong in a human's shell history, typed deliberately, with
 * wrangler's own confirmation prompt in front of them -- not buried in a
 * script's control flow where a stray argument could reach them. This script
 * handles the parts that are fiddly and easy to get wrong by hand; it does not
 * handle the part that is easy to type and impossible to take back.
 *
 * THE ORDER, and why each step is where it is:
 *
 *   1. capture   Exports the whole database to a .sql archive AND lifts the 4A
 *                row out intact. Must run while the old database still exists,
 *                which is the entire reason it is a separate step.
 *   2. (you)     Upload the archive to R2, then delete and recreate the
 *                database. See docs/LAUNCH-REBUILD.md.
 *   3. migrate   Only if `wrangler d1 migrations apply` returns 7403, which on
 *                this account it does unpredictably.
 *   4. seed      99 flats, then the 4A row. Flats first: D1 refuses to defer
 *                foreign key checks (rebuild-flats.mjs proves it three ways),
 *                so the parent must exist before the child.
 *   5. verify    Answers "is this database actually ready" with counts rather
 *                than with an absence of error messages.
 *
 * THE CAPTURE FILE HOLDS PASSWORD MATERIAL. `pw_hash` and `pw_salt` are copied
 * verbatim so the account's existing password keeps working and nobody has to
 * handle, choose or transmit a new one. The file is written 0600 into a
 * gitignored folder, is never printed, and should be deleted once `verify`
 * passes. This is the one design choice here that trades a little exposure on
 * your own disk for not putting a password through a terminal.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allFlats, floorOfFlat } from '../functions/lib/building.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const step = argv[0];
const local = argv.includes('--local');
const confirmed = argv.includes('--confirm') || local;
const DB = 'dddp';
const KEEP_FLAT = '4A';
const OUT = join(root, '.launch');

/* ── plumbing ─────────────────────────────────────────────────────────────── */

function wrangler(args, { quiet = true } = {}) {
  try {
    return execFileSync('npx', ['wrangler', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'pipe' : 'inherit'],
        maxBuffer: 256 * 1024 * 1024 });
  } catch (err) {
    // wrangler puts the useful line on stderr; swallowing it turns every SQL
    // mistake into "Command failed", which says nothing. Same treatment as
    // seed-demo.mjs, for the same reason.
    const detail = `${err.stderr ?? ''}${err.stdout ?? ''}`.split('\n')
      .filter((l) => /error|ERROR|constraint|no such|7403/i.test(l)).slice(0, 4).join(' | ');
    throw new Error(detail || err.message);
  }
}

const target = () => (local ? '--local' : '--remote');

const q = (sql) => {
  const out = wrangler(['d1', 'execute', DB, target(), '--command', sql, '--json', '--yes']);
  return JSON.parse(out.slice(out.indexOf('['))).flatMap((r) => r.results ?? []);
};

function execFile(sqlText, name = 'step') {
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `${name}.sql`);
  writeFileSync(path, sqlText);
  wrangler(['d1', 'execute', DB, target(), '--file', path, '--yes']);
  return path;
}

const lit = (v) => (v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

function requireConfirm(what) {
  if (confirmed) return;
  console.error(`\n  ${what} against PRODUCTION. Re-run with --confirm.\n`);
  process.exit(1);
}

const migrationFiles = () =>
  readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort();

/** Synchronous pause. This script is deliberately sequential; no event loop to yield to. */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Retry, for 7403 only.
 *
 * `The given account is not valid or is not authorized to access this service
 * [code: 7403]` hits this account's D1 commands unpredictably -- which command
 * it lands on moves between invocations, sometimes within the hour, and a plain
 * retry has cleared it every time. It hit `d1 export` on the first real run of
 * this script and the retry produced a complete 1,008,234-byte file.
 *
 * Deliberately narrow: only 7403 is retried, and only three times. A retry loop
 * around a genuine authorisation failure or a malformed statement would turn a
 * clear error into a slow one.
 */
function retry7403(fn, { attempts = 3, label = 'command' } = {}) {
  for (let i = 1; ; i += 1) {
    try {
      return fn();
    } catch (err) {
      if (!/7403/.test(err.message) || i >= attempts) throw err;
      console.log(`  ${label} returned 7403 (attempt ${i}/${attempts}) — retrying`);
      pause(2000);
    }
  }
}

/* ── 1. capture ───────────────────────────────────────────────────────────── */

/**
 * Everything that must outlive the database, taken while it still exists.
 *
 * The .sql export is the rollback. It is taken FIRST and checked for size and
 * content before anything else happens, because "we have a backup" is a claim
 * that is only worth making after somebody has looked at the file.
 */
function capture() {
  requireConfirm('This reads production and writes an archive');
  mkdirSync(OUT, { recursive: true });

  const before = counts();
  if (before.owners === 0) {
    throw new Error(
      'this database has no owners -- capture is pointed at the NEW database, '
      + 'not the one being replaced');
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const archive = join(OUT, `pre-launch-${stamp}.sql`);
  console.log(`\n  exporting ${DB} ...`);
  retry7403(() => wrangler(['d1', 'export', DB, target(), '-y', '--output', archive]),
    { label: 'export' });

  // Checked, not trusted. An export that failed halfway still leaves a file,
  // and a file is exactly what makes people feel safe enough to run the delete.
  const bytes = statSync(archive).size;
  const text = readFileSync(archive, 'utf8');
  const hasSchema = text.includes('CREATE TABLE');
  const hasOwners = text.includes('INSERT INTO owners') || text.includes('INSERT INTO "owners"');
  if (bytes < 10_000 || !hasSchema || !hasOwners) {
    throw new Error(
      `archive at ${archive} looks wrong: ${bytes} bytes, `
      + `schema=${hasSchema}, owners=${hasOwners} -- refusing to call this a backup`);
  }

  // The one account that survives. Selected by flat AND role so a second
  // superadmin, or a 4A tenant, cannot be picked up by accident.
  const keep = q(`SELECT * FROM owners WHERE flat = ${lit(KEEP_FLAT)} AND role = 'superadmin'`);
  if (keep.length !== 1) {
    throw new Error(
      `expected exactly one superadmin at ${KEEP_FLAT}, found ${keep.length} -- `
      + 'refusing to guess which account to carry forward');
  }
  const row = keep[0];
  const cols = Object.keys(row);
  const ownerSql = `INSERT INTO owners (${cols.join(', ')})\nVALUES (${cols.map((c) => lit(row[c])).join(', ')});\n`;
  const ownerPath = join(OUT, 'keep-owner.sql');
  // 0600: this carries pw_hash and pw_salt. Never logged, never printed.
  writeFileSync(ownerPath, ownerSql, { mode: 0o600 });

  // R2 keys, because after the database is gone there is nothing left that
  // knows which objects belonged to it.
  const proofs = q('SELECT id, r2_key FROM payment_proofs WHERE r2_key IS NOT NULL');
  const attachments = q('SELECT id, r2_key, thumb_key FROM attachments WHERE r2_key IS NOT NULL');

  const manifest = {
    capturedAt: new Date().toISOString(),
    database: DB,
    archive: { path: archive, bytes },
    counts: before,
    keeping: { id: row.id, flat: row.flat, role: row.role, active: row.active },
    r2: {
      proofs: proofs.map((p) => p.r2_key),
      attachments: attachments.flatMap((a) => [a.r2_key, a.thumb_key].filter(Boolean)),
    },
  };
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`  archive   ${(bytes / 1024).toFixed(0)} KB  ${archive}`);
  console.log(`  keeping   owner id ${row.id}, ${row.flat}, ${row.role}`);
  console.log(`  r2 keys   ${manifest.r2.proofs.length} proofs, `
            + `${manifest.r2.attachments.length} attachment objects`);
  console.log(`  counts    ${before.owners} owners, ${before.bills} bills, `
            + `${before.periods} periods\n`);
  console.log('  keep-owner.sql holds password material. Delete .launch/ once verify passes.\n');
  console.log('  NEXT: upload the archive, then delete and recreate the database.');
  console.log('        See docs/LAUNCH-REBUILD.md — this script does neither.\n');
}

/* ── 2. migrate (the fallback path only) ──────────────────────────────────── */

/**
 * Apply every migration by hand, recording the ledger as it goes.
 *
 * `wrangler d1 migrations apply` IS the right command and should be tried
 * first. This exists because 7403 hits the migration commands on this account
 * unpredictably -- which command fails moves between deploys, sometimes within
 * a day -- and `d1 execute --remote` has worked every time. Across 39 files,
 * doing that by hand is where a missed ledger row comes from, and a missed
 * ledger row means a later `apply` re-runs a migration against tables that
 * already exist.
 *
 * Skips anything already in the ledger, so it is safe to re-run after a
 * partial failure.
 */
function migrate() {
  requireConfirm('This applies migrations');

  const applied = new Set(
    q("SELECT name FROM d1_migrations").map((r) => r.name).filter(Boolean));
  const files = migrationFiles();
  const todo = files.filter((f) => !applied.has(f));

  console.log(`\n  ${files.length} migrations, ${applied.size} already applied, `
            + `${todo.length} to go\n`);
  if (!todo.length) return console.log('  nothing to do.\n');

  for (const file of todo) {
    retry7403(
      () => wrangler(['d1', 'execute', DB, target(), '--yes', '--file', join(root, 'migrations', file)]),
      { label: file });
    // The ledger row is a SEPARATE statement on purpose: if the migration
    // itself fails, the run above throws and this never records a success.
    // Retried too: a migration applied without its ledger row means a later
    // `apply` re-runs it against tables that already exist.
    retry7403(
      () => wrangler(['d1', 'execute', DB, target(), '--yes', '--command',
        `INSERT INTO d1_migrations (name, applied_at) VALUES (${lit(file)}, CURRENT_TIMESTAMP)`]),
      { label: `${file} ledger` });
    console.log(`  ✓ ${file}`);
  }
  console.log(`\n  ledger now at ${q('SELECT max(name) m FROM d1_migrations')[0].m}\n`);
}

/* ── 3. seed ──────────────────────────────────────────────────────────────── */

/**
 * The two things a freshly migrated database does NOT get from migrations/:
 * the building, and the one account that survives the rebuild.
 *
 * Everything else it is born with -- the committee (migration 0003, corrected
 * by 0007) and click_capture=off (0004) -- which is why they are not here.
 */
function seed() {
  requireConfirm('This writes to a database');

  // The guard that matters. Run against the OLD database by mistake and this
  // would quietly add 99 flats to a live building; the new one is empty by
  // definition, so insisting on empty is what tells the two apart.
  const now = counts();
  const dirty = ['owners', 'bills', 'periods', 'readings', 'flats']
    .filter((t) => now[t] > 0);
  if (dirty.length) {
    throw new Error(
      `refusing to seed: ${dirty.map((t) => `${t}=${now[t]}`).join(', ')}. `
      + 'This is not a freshly migrated database.');
  }

  const flats = allFlats();
  const values = flats.map((f) => `(${lit(f)}, ${floorOfFlat(f)}, 1)`).join(',\n  ');
  execFile(`INSERT INTO flats (flat, floor, active) VALUES\n  ${values};\n`, 'seed-flats');
  console.log(`\n  ${flats.length} flats, no accounts.`);
  console.log('  NEXT: `account` when you are ready to be let back in.\n');
}

/* ── 3b. account ──────────────────────────────────────────────────────────── */

/**
 * Put the superadmin back, with NO working password.
 *
 * WHY THE ACCOUNT IS A SEPARATE STEP FROM THE FLATS. The rebuild deletes every
 * account including this one, so for a while the database has none at all --
 * which is the honest state of a building nobody has been enrolled in yet, and
 * it makes the purge uniform instead of carrying one row across it by hand.
 *
 * THIS IS THE ONLY WAY IN. Every route that creates a resident lives under
 * /api/admin/ and needs a session, and a session needs an account, so account
 * number one cannot come from the portal. It is a direct write by whoever holds
 * the database credentials, exactly as the roster import will be.
 *
 * IDENTITY IS REUSED, CREDENTIALS ARE NOT. Name, flat, mobile and email come
 * from the row `capture` lifted out, so nothing is retyped and the account is
 * recognisably the same person to the audit trail. `pw_hash` and `pw_salt` are
 * replaced with values that are not valid base64, so the account exists and
 * cannot be logged into.
 *
 * The password is then set by `scripts/reset-my-password.mjs`, which asks for it
 * with echo off, hashes it locally and sends only the hash. That is the whole
 * reason this step writes an unusable credential rather than a temporary one:
 * a password nobody has to invent, print or transmit is a password that cannot
 * leak, and the assistant running this never sees it.
 */
function account() {
  requireConfirm('This creates the superadmin account');

  const existing = q('SELECT id, flat, role FROM owners');
  if (existing.length) {
    throw new Error(
      `refusing: ${existing.length} account(s) already exist `
      + `(${existing.map((o) => `${o.flat}/${o.role}`).join(', ')})`);
  }
  if (counts().flats === 0) {
    // owners.flat REFERENCES flats(flat) and D1 will not defer the check.
    throw new Error('no flats yet -- run `seed` first, or the foreign key refuses this row');
  }

  const captured = join(OUT, 'keep-owner.sql');
  if (!existsSync(captured)) {
    throw new Error(
      `${captured} is missing -- it carries the name, mobile and email to reuse. `
      + 'Copy it back from the archive folder, or pass the details by hand.');
  }

  // Parsed rather than replayed: the captured row carries the OLD password
  // hash, and the point of this step is that it does not come back.
  const text = readFileSync(captured, 'utf8');
  const cols = text.match(/INSERT INTO owners \(([^)]+)\)/)?.[1].split(',').map((c) => c.trim());
  const vals = text.match(/VALUES \(([\s\S]+)\);/)?.[1];
  if (!cols || !vals) throw new Error(`cannot parse ${captured}`);
  const parsed = splitValues(vals);
  const row = Object.fromEntries(cols.map((c, i) => [c, parsed[i]]));

  const insert = `INSERT INTO owners
  (id, flat, name, mobile, email, pw_hash, pw_salt, must_change_pw, role,
   created_at, active, relationship, pw_iterations)
VALUES
  (1, ${row.flat}, ${row.name}, ${row.mobile}, ${row.email},
   'pending-reset-not-a-hash', 'pending-reset-not-a-salt', 0, 'superadmin',
   ${lit(new Date().toISOString())}, 1, 'owner', 100000);\n`;
  execFile(insert, 'seed-account');

  const [who] = q('SELECT id, flat, name, role, active FROM owners');
  console.log(`\n  account ${who.id}: ${who.flat}, ${who.role}, active=${who.active}`);
  console.log('  It has NO usable password by design. Set yours with:\n');
  console.log('    node scripts/reset-my-password.mjs\n');
}

/**
 * Split a VALUES list on top-level commas only, so a comma inside a quoted
 * name does not shift every later column. The values come from `lit()` two
 * steps earlier, so the only quoting in play is single quotes doubled.
 */
function splitValues(text) {
  const out = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (ch === "'" && text[i + 1] === "'") { cur += "''"; i += 1; continue; }
      if (ch === "'") { inStr = false; cur += ch; continue; }
      cur += ch;
      continue;
    }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/* ── 4. verify ────────────────────────────────────────────────────────────── */

function counts() {
  const [row] = q(`SELECT
    (SELECT COUNT(*) FROM flats) flats,
    (SELECT COUNT(*) FROM owners) owners,
    (SELECT COUNT(*) FROM periods) periods,
    (SELECT COUNT(*) FROM readings) readings,
    (SELECT COUNT(*) FROM bills) bills,
    (SELECT COUNT(*) FROM notices) notices,
    (SELECT COUNT(*) FROM committee) committee,
    (SELECT COUNT(*) FROM audit_log) audit_log,
    (SELECT COUNT(*) FROM sessions) sessions,
    (SELECT COUNT(*) FROM d1_migrations) migrations`);
  return row;
}

/**
 * Read-only, and deliberately a list of ASSERTIONS rather than a dump. "It
 * printed some numbers and none of them looked wrong" is how a half-finished
 * rebuild gets deployed.
 */
function verify() {
  const c = counts();
  const files = migrationFiles().length;
  const [su] = q("SELECT id, flat, role, active FROM owners WHERE role = 'superadmin'");
  const [cfg] = q("SELECT value FROM settings WHERE key = 'click_capture'");

  // The account is created in its own step, so BOTH of these are correct
  // states and verify has to tell them apart rather than picking one. Nothing
  // is wrong with a rebuilt database that nobody has been let into yet; what
  // would be wrong is a second account, or an account that is not this one.
  const enrolled = c.owners === 1;

  const checks = [
    ['99 flats', c.flats === 99, c.flats],
    ['at most one account', c.owners <= 1, c.owners],
    ...(enrolled ? [
      ['that account is the 4A superadmin', su?.flat === KEEP_FLAT && su?.role === 'superadmin', `${su?.flat}/${su?.role}`],
      ['it is active', su?.active === 1, su?.active],
    ] : []),
    ['no periods, so month one starts at the meter walk', c.periods === 0, c.periods],
    ['no bills', c.bills === 0, c.bills],
    ['no readings', c.readings === 0, c.readings],
    ['no notices', c.notices === 0, c.notices],
    ['no audit history', c.audit_log === 0, c.audit_log],
    ['no sessions', c.sessions === 0, c.sessions],
    ['committee published', c.committee === 4, c.committee],
    ['click capture off', cfg?.value === 'off', cfg?.value],
    [`ledger has all ${files} migrations`, c.migrations === files, c.migrations],
  ];

  console.log(`\n  ${DB} ${local ? '(local)' : '(remote)'}\n`);
  let failed = 0;
  for (const [label, ok, actual] of checks) {
    if (!ok) failed += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — got ${actual}`}`);
  }
  if (failed) {
    console.log(`\n  ${failed} check${failed === 1 ? '' : 's'} failed. Do not deploy.\n`);
    process.exitCode = 1;
    return;
  }
  console.log(enrolled
    ? '\n  Ready, and the superadmin is in place.\n'
    : '\n  Ready, with NO accounts — correct if you have not run `account` yet.\n'
      + '  `doctor` will report SUPERADMIN-NONE until you do, which is true.\n');
  console.log('  Swap database_id in both wrangler.toml files and in\n'
    + '  test/deploy-config.test.js, then deploy both from main.\n');
}

/* ── dispatch ─────────────────────────────────────────────────────────────── */

const steps = { capture, migrate, seed, account, verify };
if (!steps[step]) {
  console.error('\n  usage: launch-rebuild.mjs '
    + '<capture|migrate|seed|account|verify> [--confirm] [--local]\n');
  process.exit(1);
}

try {
  steps[step]();
} catch (err) {
  console.error(`\n  ${step} failed: ${err.message}\n`);
  process.exit(1);
}
