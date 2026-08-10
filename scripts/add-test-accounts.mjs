#!/usr/bin/env node
/**
 * Two throwaway accounts to test with — one resident, one admin.
 *
 *   node scripts/add-test-accounts.mjs --remote --confirm   # create
 *   node scripts/add-test-accounts.mjs --remote --remove    # undo
 *   node scripts/add-test-accounts.mjs --local              # same, locally
 *
 * WHY THIS EXISTS SEPARATELY FROM seed-demo. The seed builds a whole building
 * and prints its two logins once; lose that terminal and the only way back is
 * to rebuild all 99 flats and ~1000 bills, which throws away whatever state
 * the testing had built up. This adds two accounts to a building that is
 * already there, and nothing else.
 *
 * THE PASSWORDS ARE ONE-TIME, AND THAT IS THE POINT. Both accounts are created
 * with must_change_pw = 1, so the password printed here stops working the
 * moment it is used: login redirects to /password, which does not re-ask for
 * the old one (see changePassword in functions/index.js). A credential that
 * has passed through a terminal, a chat window or an assistant's context is
 * not a credential anyone should keep, and one of these two can edit every
 * bill in the building. Say-able words and digits 2–9 only, because these get
 * read down a phone.
 *
 * THE ARITHMETIC IS NOT REIMPLEMENTED HERE. Bills come from billing.js, the
 * same functions the portal bills with — a second copy of the conversion
 * factor and the round-up in a script is exactly how the two drift apart and
 * the demo data quietly stops meaning anything.
 *
 * REMOVAL. The new ids are appended to the demo seed's marker, so
 * `seed-demo.mjs --remove` takes these with it and the real roster import
 * still meets an empty building. --remove here undoes just these two.
 */

import { webcrypto as crypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeConsumption, computeBill } from '../functions/lib/billing.js';

const DB = 'dddp';
const local = process.argv.includes('--local');
const remove = process.argv.includes('--remove');
const confirmed = process.argv.includes('--confirm') || local || remove;
const MARKER = 'demo_seed_ids';

/** Must match functions/lib/crypto.js, or the account is locked, not created. */
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

const ACCOUNTS = [
  { name: 'Demo User [demo]',  mobile: '+919990000002', role: 'owner', label: 'Resident' },
  { name: 'Demo Admin [demo]', mobile: '+919990000003', role: 'admin', label: 'Admin' },
];

if (!confirmed) {
  console.error('\nThis writes to PRODUCTION. Re-run with --confirm.\n');
  process.exit(1);
}

/* ── plumbing ─────────────────────────────────────────────────────────────── */

function run(args) {
  try {
    return execFileSync('npx', ['wrangler', 'd1', 'execute', DB,
      local ? '--local' : '--remote', ...args, '--json', '--yes'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const detail = `${err.stderr ?? ''}${err.stdout ?? ''}`.split('\n')
      .filter((l) => /error|ERROR|constraint|no such/i.test(l)).slice(0, 3).join(' | ');
    throw new Error(detail || err.message);
  }
}

const q = (sql) => JSON.parse((() => {
  const o = run(['--command', sql]); return o.slice(o.indexOf('['));
})()).flatMap((r) => r.results ?? []);

/** Written as a file, not --command: a command line is world-readable in ps. */
function exec(sqlText) {
  const dir = mkdtempSync(join(tmpdir(), 'ddp-test-'));
  const file = join(dir, 'x.sql');
  writeFileSync(file, sqlText, { mode: 0o600 });
  try { return run(['--file', file]); } finally { unlinkSync(file); }
}

const lit = (v) => (v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

async function hash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password),
    'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, KEY_BITS);
  return {
    hash: Buffer.from(bits).toString('base64'),
    salt: Buffer.from(salt).toString('base64'),
  };
}

/** Say-able one-time password, mirroring generateOneTimePassword in crypto.js. */
const WORDS = ['pine', 'teak', 'mango', 'palm', 'reef', 'kite', 'dune', 'moss',
  'wave', 'fern', 'clay', 'jade', 'rain', 'sand', 'oak', 'lime'];
const DIGITS = '23456789';                 // no 0/1: misheard as O and I

function oneTimePassword() {
  const b = crypto.getRandomValues(new Uint32Array(6));
  let digits = '';
  for (let i = 2; i < 6; i += 1) digits += DIGITS[b[i] % DIGITS.length];
  return `${WORDS[b[0] % WORDS.length]}-${WORDS[b[1] % WORDS.length]}-${digits}`;
}

/* ── marker ───────────────────────────────────────────────────────────────── */

function readMarker() {
  const row = q(`SELECT value FROM settings WHERE key = ${lit(MARKER)}`)[0];
  if (!row?.value) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

/**
 * Keep the demo seed's removal exact. Without this the two accounts survive
 * `seed-demo --remove`, and the real roster import later meets flats that are
 * already occupied — the one failure the marker exists to prevent.
 */
function addToMarker(ids) {
  const m = readMarker();
  if (!m) {
    console.log('  No demo marker — these are not registered for bulk removal.');
    console.log('  Remove them with: node scripts/add-test-accounts.mjs '
              + `${local ? '--local' : '--remote'} --remove`);
    return;
  }
  m.owners = [...new Set([...(m.owners ?? []), ...ids])];
  exec(`UPDATE settings SET value = ${lit(JSON.stringify(m))} WHERE key = ${lit(MARKER)};`);
}

function dropFromMarker(ids) {
  const m = readMarker();
  if (!m) return;
  m.owners = (m.owners ?? []).filter((id) => !ids.includes(id));
  exec(`UPDATE settings SET value = ${lit(JSON.stringify(m))} WHERE key = ${lit(MARKER)};`);
}

/* ── removal ──────────────────────────────────────────────────────────────── */

function removeAll() {
  const mobiles = ACCOUNTS.map((a) => lit(a.mobile)).join(',');
  const rows = q(`SELECT id, flat, name FROM owners WHERE mobile IN (${mobiles})`);
  if (!rows.length) {
    console.log('\n  Neither account is here. Nothing to remove.\n');
    return;
  }
  const ids = rows.map((r) => r.id);
  const O = ids.join(',');

  exec([
    `DELETE FROM payment_proofs  WHERE owner_id IN (${O});`,
    `DELETE FROM payment_intents WHERE bill_id IN (SELECT id FROM bills WHERE owner_id IN (${O}));`,
    `DELETE FROM bills    WHERE owner_id IN (${O});`,
    `DELETE FROM password_resets WHERE owner_id IN (${O});`,
    `DELETE FROM click_log WHERE owner_id IN (${O}) OR actor_id IN (${O});`,
    `DELETE FROM activity  WHERE owner_id IN (${O}) OR actor_id IN (${O});`,
    `DELETE FROM comments  WHERE owner_id IN (${O});`,
    `DELETE FROM audit_log WHERE actor_id IN (${O}) OR subject_id IN (${O});`,
    `DELETE FROM sessions  WHERE actor_id IN (${O}) OR subject_id IN (${O});`,
    `UPDATE messages SET handled_by = NULL WHERE handled_by IN (${O});`,
    `DELETE FROM owners WHERE id IN (${O});`,
  ].join('\n'));

  dropFromMarker(ids);

  // Read back rather than trust the write: a zero-row DELETE reports nothing.
  const left = q(`SELECT id FROM owners WHERE mobile IN (${mobiles})`);
  if (left.length) throw new Error(`${left.length} of them are still here.`);
  console.log(`\n  Removed ${rows.map((r) => `${r.name} (${r.flat})`).join(' and ')}.`);
  console.log('  Readings were left alone — a meter reading is a fact about the flat.\n');
}

/* ── bills ────────────────────────────────────────────────────────────────── */

/**
 * Bills for a flat, derived from the readings already in the database.
 *
 * A brand-new account with no bills opens on an empty dashboard, which is
 * useless for testing the only two things a resident does — pay, and upload a
 * screenshot. The seed already wrote readings for every flat including the
 * vacant ones, so the history is there to be billed against; nothing invents a
 * meter here. The first period is skipped because a delta needs a previous
 * reading and there is none before the first.
 */
function billsFor(flat, ownerId, now) {
  const rows = q(`SELECT p.period, p.rate_per_kg, p.conversion_factor, p.late_fee,
                         r.reading
                    FROM periods p
                    JOIN readings r ON r.period = p.period AND r.flat = ${lit(flat)}
                   ORDER BY p.period`);
  if (rows.length < 2) return { stmts: [], count: 0 };

  const existing = new Set(
    q(`SELECT period FROM bills WHERE flat = ${lit(flat)}`).map((b) => b.period));

  const stmts = [];
  let count = 0;

  rows.forEach((row, i) => {
    if (i === 0) return;                                  // no previous reading
    if (existing.has(row.period)) return;                 // UNIQUE (flat, period)

    // A spread worth having: most settled, one overdue and carrying a late fee
    // so the late-fee display can be seen, and the newest unpaid so there is
    // something to pay and upload a screenshot against.
    const fromEnd = rows.length - 1 - i;
    const lateFee = fromEnd === 1 ? row.late_fee : 0;
    const status = fromEnd <= 1 ? 'unpaid' : 'paid';

    const consumption = computeConsumption(
      row.reading, rows[i - 1].reading, row.conversion_factor);
    const { gasAmount, total } = computeBill({
      consumption, ratePerKg: row.rate_per_kg, lateFee,
    });
    const delta = Math.round((row.reading - rows[i - 1].reading) * 1000) / 1000;

    stmts.push(`INSERT INTO bills (flat, period, meter_delta, consumption,
                  conversion_factor, rate_per_kg, gas_amount, late_fee, late_fee_at,
                  total, status, paid_at, owner_id, created_at)
                VALUES (${lit(flat)}, ${lit(row.period)}, ${delta}, ${consumption},
                  ${row.conversion_factor}, ${row.rate_per_kg}, ${gasAmount},
                  ${lateFee}, ${lateFee ? lit(now) : 'NULL'}, ${total}, ${lit(status)},
                  ${status === 'paid' ? lit(now) : 'NULL'}, ${ownerId}, ${lit(now)});`);
    count += 1;
  });

  return { stmts, count };
}

/* ── create ───────────────────────────────────────────────────────────────── */

const main = async () => {
  if (remove) return removeAll();

  console.log(`\n  Adding two test accounts to ${local ? 'LOCAL' : 'PRODUCTION'}.\n`);

  const taken = q(`SELECT mobile FROM owners WHERE mobile IN (${
    ACCOUNTS.map((a) => lit(a.mobile)).join(',')})`);
  if (taken.length) {
    console.error(`  ${taken.map((t) => t.mobile).join(' and ')} already in use.`);
    console.error('  Remove the old ones first: --remove\n');
    process.exit(1);
  }

  // An empty flat, always. Putting a test account on an occupied flat gives it
  // two owners, which is the state the doctor's TWO-OWNERS check exists to
  // catch — and it would be this script that caused it.
  const free = q(`SELECT f.flat FROM flats f
                   LEFT JOIN owners o ON o.flat = f.flat
                   WHERE o.id IS NULL ORDER BY f.floor, f.flat`).map((r) => r.flat);
  if (free.length < ACCOUNTS.length) {
    console.error(`  Only ${free.length} empty flats; need ${ACCOUNTS.length}.\n`);
    process.exit(1);
  }

  const now = new Date().toISOString();
  const made = [];

  for (const [i, acct] of ACCOUNTS.entries()) {
    const flat = free[i];
    const pw = oneTimePassword();
    const { hash: h, salt: s } = await hash(pw);

    exec(`INSERT INTO owners (flat, name, mobile, pw_hash, pw_salt, must_change_pw,
            role, relationship, active, created_at)
          VALUES (${lit(flat)}, ${lit(acct.name)}, ${lit(acct.mobile)}, ${lit(h)},
                  ${lit(s)}, 1, ${lit(acct.role)}, 'owner', 1, ${lit(now)});`);

    // Read the row back rather than trusting the insert, and confirm the hash
    // stored is the hash derived — a mismatch means an account nobody can open.
    const [row] = q(`SELECT id, pw_hash, must_change_pw FROM owners
                      WHERE mobile = ${lit(acct.mobile)}`);
    if (!row) throw new Error(`${acct.name} was not created.`);
    if (row.pw_hash !== h) throw new Error(`${acct.name} stored a different hash.`);
    if (row.must_change_pw !== 1) throw new Error(`${acct.name} is not forced to change.`);

    const { stmts, count } = billsFor(flat, row.id, now);
    if (stmts.length) exec(stmts.join('\n'));

    made.push({ ...acct, flat, pw, id: row.id, bills: count });
    console.log(`  ${acct.label.padEnd(9)}${acct.name} — flat ${flat}, ${count} bills`);
  }

  addToMarker(made.map((m) => m.id));

  const site = local ? 'http://localhost:8787' : 'https://diamondpark.pages.dev';
  console.log('\n  ─────────────────────────────────────────────');
  console.log('  ONE-TIME PASSWORDS — they stop working on use');
  console.log('  ─────────────────────────────────────────────');
  for (const m of made) {
    console.log(`  ${m.label.padEnd(9)}${m.mobile.replace('+91', '').padEnd(12)}${m.pw}`);
    console.log(`  ${' '.repeat(9)}flat ${m.flat}${m.role === 'admin' ? ', admin rights' : ''}`);
  }
  console.log(`\n  ${site}`);
  console.log('  First login lands on /password and asks for a new one.');
  console.log('  Remove: node scripts/add-test-accounts.mjs '
            + `${local ? '--local' : '--remote'} --remove\n`);
};

main().catch((err) => { console.error('\nFailed:', err.message); process.exit(1); });
