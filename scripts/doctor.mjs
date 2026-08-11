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
import { join } from 'node:path';
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

/**
 * Which deployments have the alerting secrets.
 *
 * Read from Cloudflare, not from process.env. The first version checked the
 * local shell, which knows nothing about Worker secrets — so it would have
 * reported "alerting not configured" to someone who had just configured it
 * correctly, and "configured" to anyone with a stray export in their profile.
 *
 * Only NAMES are listed; wrangler cannot read a secret's value back and
 * neither can this.
 */
function alertingSecrets() {
  const names = (args, cwd) => {
    try {
      return execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', cwd,
        stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return '';
    }
  };
  const worker = names(['secret', 'list'], process.cwd());
  const pages = names(['pages', 'secret', 'list'], join(process.cwd(), 'pages'));
  const has = (text) => text.includes('TELEGRAM_BOT_TOKEN') && text.includes('TELEGRAM_CHAT_ID');
  return { cron: has(worker), pages: has(pages) };
}

/** Are the four Google/mail secrets present on the Pages deployment? */
function mailSecrets() {
  try {
    const out = execFileSync('npx', ['wrangler', 'pages', 'secret', 'list'],
      { encoding: 'utf8', cwd: join(process.cwd(), 'pages'), stdio: ['ignore', 'pipe', 'pipe'] });
    return ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'MAIL_FROM']
      .every((n) => out.includes(n));
  } catch {
    return false;
  }
}

/**
 * The backup needs one secret the mail path does not — the folder to write
 * into — so this cannot just reuse mailSecrets(). Asked of Cloudflare rather
 * than of this shell, for the same reason as the others.
 *
 * Asked of BOTH deployments, unlike mail. Mail sends from the request path, so
 * Pages alone is the whole answer there; the backup runs from the 3am cron,
 * which lives on the Worker. Checking Pages only — which this did — would have
 * reported a healthy backup to someone who had configured the one deployment
 * that never runs it, and the Export tab would have agreed, because that check
 * also runs on Pages.
 */
function driveSecrets() {
  // Either credential set satisfies each of the three, because the backup runs
  // under its own Google account when GOOGLE_BACKUP_* is set and falls back to
  // the shared one when it is not. Requiring the shared names outright would
  // report "not configured" against a correctly split setup.
  const EITHER = [
    ['GOOGLE_BACKUP_CLIENT_ID', 'GOOGLE_CLIENT_ID'],
    ['GOOGLE_BACKUP_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET'],
    ['GOOGLE_BACKUP_REFRESH_TOKEN', 'GOOGLE_REFRESH_TOKEN'],
    ['GOOGLE_BACKUP_FOLDER_ID'],
  ];
  const has = (args, cwd) => {
    try {
      const out = execFileSync('npx', ['wrangler', ...args],
        { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      return EITHER.every((names) => names.some((n) => out.includes(n)));
    } catch {
      return false;
    }
  };
  return {
    cron: has(['secret', 'list'], process.cwd()),
    pages: has(['pages', 'secret', 'list'], join(process.cwd(), 'pages')),
  };
}

const main = () => {
  const env = local ? 'local' : 'production';
  if (!asMarkdown) console.error(`${C.dim}Reading ${env}…${C.off}`);

  const owners = safe(
    `SELECT id, flat, name, mobile, email, role, active, relationship,
            late_fee_exempt_until, late_fee_exempt_reason FROM owners`, 'owners');
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
  const [demo] = safe(
    "SELECT value FROM settings WHERE key = 'demo_seed_ids'", 'settings');
  const [backup] = safe(
    "SELECT value FROM settings WHERE key = 'last_backup_at'", 'settings');

  const findings = runChecks({
    owners, flats, bills, periods, readings, proofs, unavailable,
    lastDigestAt: digest?.value ?? null,
    demoMarker: demo?.value ?? null,
    lastBackupAt: backup?.value ?? null,
    config: {
      // Read from wrangler config rather than guessed: an empty VPA is a real
      // production failure and a non-issue locally.
      upiVpa: process.env.UPI_VPA ?? 'qr.ddwelfare@sib',
      // Both deployments need it: instant alerts fire from the request path
      // (Pages) and the digest from the cron Worker. One without the other is
      // half-working in a way nothing else would surface.
      alerting: local ? { cron: true, pages: true } : alertingSecrets(),
      // Same reasoning as alerting: ask Cloudflare, not this shell.
      mailConfigured: local ? true : mailSecrets(),
      driveConfigured: local ? { cron: true, pages: true } : driveSecrets(),
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
