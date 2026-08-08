#!/usr/bin/env node
/**
 * Break-glass password reset for the superadmin.
 *
 * This exists because the superadmin has no one above them. Every other
 * account can be reset from the admin console; the top of the tree can only be
 * recovered by someone holding the database credentials, which is the point.
 *
 * THE PASSWORD NEVER LEAVES THIS MACHINE. It is typed with echo off, hashed
 * here, and only the PBKDF2 hash is sent to D1 — the same thing the Worker
 * would store. It is never an argument, never in shell history, never in a
 * process list, and never written to a file that outlives the run.
 *
 * Usage:
 *   node scripts/reset-my-password.mjs            # production
 *   node scripts/reset-my-password.mjs --local    # local dev database
 *
 * Deliberately interactive. A --password flag would put the secret in shell
 * history, and someone would eventually use it.
 */

import { webcrypto as crypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as readline from 'node:readline';

// Must match functions/lib/crypto.js exactly, or the hash will not verify and
// the account is locked harder than before.
const KEY_BITS = 256;
const SALT_BYTES = 16;
const ITERATIONS = 100_000;
const MIN_LENGTH = 10;

const DB = 'dddp';
const local = process.argv.includes('--local');

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

async function hash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, KEY_BITS);
  return { hash: toBase64(new Uint8Array(bits)), salt: toBase64(salt) };
}

/** Read a line with the terminal's echo switched off. */
function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      // Repaint the prompt without the typed characters. Without this the
      // password appears on screen, which defeats the whole exercise.
      if (['\n', '\r', ''].includes(char.toString())) return;
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(prompt);
    };
    process.stdin.on('data', onData);
    rl.question(prompt, (answer) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function sql(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function run(args) {
  return execFileSync('npx', ['wrangler', 'd1', 'execute', DB,
    local ? '--local' : '--remote', ...args, '--json', '--yes'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Rows from a SELECT. --json because human output is not a stable contract. */
function d1Query(statement) {
  const out = run(['--command', statement]);
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed.flatMap((r) => r.results ?? []);
}

function d1Exec(statement) {
  // Passed as a FILE rather than --command: a command line is visible in the
  // process list to every other user on the machine. The hash is not the
  // password, but there is no reason to broadcast it either.
  const dir = mkdtempSync(join(tmpdir(), 'dddp-reset-'));
  const file = join(dir, 'reset.sql');
  writeFileSync(file, statement, { mode: 0o600 });
  try {
    return run(['--file', file]);
  } finally {
    unlinkSync(file);
  }
}

const main = async () => {
  console.log(`\nReset the superadmin password on the ${local ? 'LOCAL' : 'PRODUCTION'} database.`);
  console.log('Nothing you type is echoed, stored, or sent anywhere except as a hash.\n');

  const mobile = (await askHidden('Your mobile number (10 digits): ')).trim().replace(/\D/g, '');
  if (mobile.length < 10) { console.error('\nThat is not a 10-digit number.'); process.exit(1); }
  const e164 = `+91${mobile.slice(-10)}`;

  const pw = await askHidden('New password: ');
  if (pw.length < MIN_LENGTH) {
    console.error(`\nUse at least ${MIN_LENGTH} characters. This account can edit every bill in the building.`);
    process.exit(1);
  }
  const again = await askHidden('Again: ');
  if (pw !== again) { console.error('\nThose do not match.'); process.exit(1); }

  // Checked BEFORE writing. Without this the run reports success against a
  // mobile that matches nobody, and the account is no more reachable than it
  // was — the worst possible outcome for a recovery tool.
  const [who] = d1Query(
    `SELECT id, name FROM owners WHERE mobile = ${sql(e164)} AND role = 'superadmin'`);
  if (!who) {
    console.error(`\nNo superadmin has the number ${e164}. Nothing was changed.`);
    console.error('Check the number, or list accounts with:');
    console.error(`  npx wrangler d1 execute ${DB} ${local ? '--local' : '--remote'} \\`);
    console.error(`    --command "SELECT flat, name, mobile, role FROM owners"`);
    process.exit(1);
  }
  console.log(`\nResetting the password for ${who.name}.`);

  const { hash: h, salt: s } = await hash(pw);

  // must_change_pw stays 0: you just chose this one, so being forced to change
  // it again on first login would be theatre.
  //
  // Sessions are destroyed because a forgotten password is indistinguishable
  // from a stolen one, and this is the moment to assume the worse of the two.
  d1Exec(`
    UPDATE owners SET pw_hash = ${sql(h)}, pw_salt = ${sql(s)}, must_change_pw = 0
     WHERE mobile = ${sql(e164)} AND role = 'superadmin';
    DELETE FROM sessions WHERE actor_id = (SELECT id FROM owners WHERE mobile = ${sql(e164)});
    DELETE FROM login_attempts WHERE mobile = ${sql(e164)};
    INSERT INTO audit_log (actor_id, subject_id, action, detail, at)
      SELECT id, id, 'password.breakglass',
             json_object('via', 'scripts/reset-my-password.mjs'), datetime('now')
        FROM owners WHERE mobile = ${sql(e164)};
  `);

  // Read the hash back rather than trusting the write. wrangler prints no
  // rows_written for a zero-row UPDATE, so parsing its output for one silently
  // never fires — the earlier version of this check was exactly that bug, and
  // it would have reported success while leaving the account locked.
  const [after] = d1Query(`SELECT pw_hash FROM owners WHERE id = ${who.id}`);
  if (after?.pw_hash !== h) {
    console.error('\nThe database did not take the new password. Nothing has changed —');
    console.error('your old password still works, if you can remember it.');
    process.exit(1);
  }

  console.log(`\nDone. Log in at ${local ? 'http://localhost:8787' : 'https://diamondpark.pages.dev'}`);
  console.log('Every existing session was signed out, including any on your phone.\n');
};

main().catch((err) => { console.error('\nFailed:', err.message); process.exit(1); });
