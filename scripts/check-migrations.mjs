#!/usr/bin/env node
/**
 * Apply every migration to an empty local D1 and prove the result is sound.
 *
 * The test suite reads migrations/ as text; nothing executed them before a
 * deploy did. This runs them through wrangler's own local D1, which is the same
 * engine `migrations apply --remote` hands them to, into a throwaway directory
 * so a developer's .wrangler/state is never touched.
 *
 * Then `PRAGMA foreign_key_check`, which must return nothing. A migration that
 * rebuilds a table (0030 does) can leave rows pointing at a parent that no
 * longer exists without failing, and this is the check that notices.
 *
 * What it does NOT prove: that a migration applies to a POPULATED database.
 * Production was rebuilt empty on 2026-09-12, so every migration to date has in
 * fact been applied that way, but the next one will meet real rows.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'dddp-migrations-'));
const wrangler = (args) => execFileSync('npx', ['wrangler', ...args, '--local', '--persist-to', dir],
  { encoding: 'utf8', env: { ...process.env, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });

try {
  wrangler(['d1', 'migrations', 'apply', 'dddp']);
  const out = JSON.parse(wrangler(['d1', 'execute', 'dddp', '--json', '--command', 'PRAGMA foreign_key_check']));
  const broken = out.flatMap((r) => r.results ?? []);
  if (broken.length) {
    console.error('foreign_key_check found orphaned rows after migrating:');
    console.error(broken);
    process.exit(1);
  }
  console.log('migrations apply cleanly to an empty database; foreign_key_check is empty');
} catch (err) {
  console.error(err.stderr || err.stdout || err.message);
  process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
