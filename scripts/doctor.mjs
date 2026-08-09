#!/usr/bin/env node
/**
 * Check the building's invariants and print what is broken.
 *
 *   npm run doctor              # production
 *   npm run doctor -- --local   # local dev database
 *   npm run doctor -- --md      # markdown, for pasting into a chat
 *
 * The checks live in functions/lib/diagnostics.js so that this and god mode
 * report identically — two implementations would eventually disagree, and the
 * one you were not looking at would be the correct one.
 *
 * Read-only. It runs SELECTs and nothing else, so it is safe against
 * production at any time.
 *
 * Exit code is 1 when something is failing, so this can gate a deploy later.
 */

import { execFileSync } from 'node:child_process';
import { runChecks, summarise, toMarkdown } from '../functions/lib/diagnostics.js';
import { ERROR_CODES } from '../functions/lib/error-codes.js';

const DB = 'dddp';
const local = process.argv.includes('--local');
const asMarkdown = process.argv.includes('--md');

const C = {
  fail: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m',
  dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m',
};

function q(statement) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', DB,
    local ? '--local' : '--remote', '--command', statement, '--json', '--yes'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out.slice(out.indexOf('['))).flatMap((r) => r.results ?? []);
}

/**
 * A table that cannot be read is recorded as unreadable, NOT as empty.
 *
 * Returning [] on failure once made this report "no active superadmin — god
 * mode is unreachable" because a single query blipped. The checks now skip
 * what they cannot see, and say they skipped it.
 */
const unavailable = [];

function safe(statement, label) {
  try {
    return q(statement);
  } catch (err) {
    console.error(`${C.dim}  (could not read ${label}: ${err.message.split('\n')[0]})${C.off}`);
    unavailable.push(label);
    return [];
  }
}

const main = () => {
  const env = local ? 'local' : 'production';
  if (!asMarkdown) console.error(`${C.dim}Reading ${env}…${C.off}`);

  const owners = safe(
    'SELECT id, flat, name, mobile, email, role, active FROM owners', 'owners');
  const flats = safe('SELECT flat, floor, active FROM flats', 'flats');
  const bills = safe(
    `SELECT id, flat, period, owner_id, gas_amount, other_charges, additional_charges,
            late_fee, total, status, manual_total, adjust_reason FROM bills`, 'bills');
  const periods = safe(
    'SELECT period, rate_per_kg, conversion_factor, status FROM periods', 'periods');
  const readings = safe('SELECT flat, period, reading FROM readings', 'readings');
  const proofs = safe('SELECT id, bill_id, owner_id FROM payment_proofs', 'payment_proofs');
  const errors = safe(
    'SELECT code, severity, at FROM error_log ORDER BY id DESC LIMIT 25', 'error_log');
  const [digest] = safe(
    "SELECT value FROM settings WHERE key = 'last_digest_at'", 'settings');

  const findings = runChecks({
    owners, flats, bills, periods, readings, proofs, unavailable,
    lastDigestAt: digest?.value ?? null,
    config: {
      // Read from wrangler config rather than guessed: an empty VPA is a real
      // production failure and a non-issue locally.
      upiVpa: process.env.UPI_VPA ?? 'qr.ddwelfare@sib',
      alertingConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      remote: !local,
    },
  });

  const meta = {
    environment: env,
    generatedAt: new Date().toISOString(),
    counts: {
      residents: owners.length, flats: flats.length,
      bills: bills.length, readings: readings.length, months: periods.length,
    },
  };

  const withMeanings = errors.map((e) => ({ ...e, message: ERROR_CODES[e.code]?.message ?? '' }));

  if (asMarkdown) {
    console.log(toMarkdown({ findings, errors: withMeanings, meta }));
  } else {
    const s = summarise(findings);
    console.log(`\n${C.bold}Diamond Park — ${env}${C.off}`);
    console.log(`${C.dim}${Object.entries(meta.counts).map(([k, v]) => `${v} ${k}`).join(' · ')}${C.off}\n`);

    if (s.healthy && !findings.length) {
      console.log(`${C.info}Every check passed.${C.off}\n`);
    } else {
      for (const f of findings) {
        console.log(`${C[f.severity]}${f.severity.toUpperCase().padEnd(4)}${C.off} ${C.bold}${f.id}${C.off} — ${f.title}`);
        console.log(`     ${C.dim}${f.detail}${C.off}`);
        for (const row of f.rows.slice(0, 8)) {
          console.log(`     ${C.dim}·${C.off} ${Object.entries(row).map(([k, v]) => `${k}=${v}`).join('  ')}`);
        }
        if (f.rows.length > 8) console.log(`     ${C.dim}…${f.rows.length - 8} more${C.off}`);
        console.log();
      }
      console.log(`${s.fail} failing · ${s.warn} warnings · ${s.info} notes`);
      console.log(`${C.dim}Paste-ready version: npm run doctor -- ${local ? '--local ' : ''}--md${C.off}\n`);
    }
  }

  process.exit(summarise(findings).fail > 0 ? 1 : 0);
};

main();
