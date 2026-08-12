#!/usr/bin/env node
/**
 * Local development seed. Generates real PBKDF2 hashes (the SQL migration
 * can't), then loads residents, bills and history into the local D1.
 *
 * Development only — real residents arrive via CSV import at cutover, and
 * nothing is migrated from the old site because no hosting access exists.
 */

import { execFileSync } from 'node:child_process';
import { hashPassword } from '../functions/lib/crypto.js';
import { normaliseMobile } from '../functions/lib/godedit.js';
import { computeBill, computeConsumption, meterDelta, DEFAULT_CONVERSION } from '../functions/lib/billing.js';

const DEV_PASSWORD = 'diamond-park-dev';

const PEOPLE = [
  { flat: '4A',  name: 'Sabarish Nair',        mobile: '9567791515', email: 'nair.sabarish97@gmail.com', role: 'superadmin' },
  { flat: '13A', name: 'Mukesh',               mobile: '9846466511', email: null, role: 'admin' },
  { flat: '5A',  name: 'Sekharan',             mobile: '9847011223', email: null, role: 'owner' },
  { flat: '4B',  name: 'Priya Menon',          mobile: '9847011224', email: null, role: 'owner' },
  { flat: '5B',  name: 'Rajan Pillai',         mobile: '9847011225', email: null, role: 'owner' },
  { flat: '4C',  name: 'Adv. Joy Vettiyadan',  mobile: '9847011226', email: null, role: 'admin' },
];

/**
 * 4A's real readings from the live portal. Keys are the USAGE month each
 * reading closes — the old portal displayed these one month later, under the
 * month the meter was read (its "July 2026" row is June's usage). Bills are
 * therefore labelled June, exactly as residents already see them.
 */
const READINGS = {
  '4A': { '2026-02': 0.218, '2026-03': 0.991, '2026-04': 2.522, '2026-05': 4.134, '2026-06': 5.817 },
  '4B': { '2026-04': 1.100, '2026-05': 2.020, '2026-06': 2.940 },
  '5B': { '2026-04': 1.007, '2026-05': 2.600, '2026-06': 4.221 },
};

/** The meter closing period N is read early in month N+1. */
const readOn = (period) => {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(m === 12 ? y + 1 : y, m % 12, 2));
  return d.toISOString().slice(0, 10);
};

const PERIODS = [
  // 2026-02 exists so the earliest reading has a period to hang off; it has no
  // predecessor, so it produces no bill.
  { period: '2026-02', rate: 75, due: '2026-03-10', status: 'locked' },
  { period: '2026-03', rate: 72, due: '2026-04-10', status: 'locked' },
  { period: '2026-04', rate: 75, due: '2026-05-10', status: 'locked' },
  { period: '2026-05', rate: 75, due: '2026-06-10', status: 'locked' },
  { period: '2026-06', rate: 75, due: '2026-07-10', status: 'open' },
];

const FLATS = ['4A', '4B', '4C', '5A', '5B', '13A'];
const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

/**
 * Every table that points at one being reseeded, children before parents.
 *
 * The short list this replaced ended at owners and flats, which was true when
 * six tables existed and has been wrong since the statement, attachment and
 * contact features landed: `DELETE FROM owners` hit FOREIGN KEY constraint
 * failed and the whole seed aborted, leaving whatever was already there.
 *
 * Order is the point. SQLite checks each statement as it runs, so a parent
 * deleted before its children fails even though the end state would be legal.
 * Anything added here that references another row goes ABOVE its parent.
 *
 * The log tables (error_log, login_attempts, message_attempts) are deliberately
 * absent: nothing constrains them, and they are the record of what the last run
 * did. Clear them by hand when a stale lockout gets in the way.
 */
const WIPE = [
  // statements → their credits and reconciliations
  'reconciliations', 'statement_credits', 'statement_sessions',
  // notices → comments → attachments (attachments point at both)
  'attachments', 'comments',
  // bills → the money attached to them
  'payment_intents', 'payment_proofs',
  // everything else hanging off owners
  'sessions', 'audit_log', 'messages', 'activity', 'settings', 'click_log',
  'password_resets', 'contact_requests',
  // the rows the seed actually rewrites
  'bills', 'readings', 'periods', 'notices', 'owners', 'flats',
];

const sql = [];
sql.push(...WIPE.map((t) => `DELETE FROM ${t};`));

for (const flat of FLATS) {
  // The paise tag is gone for real — 0005 explains why the migration is a
  // no-op and scripts/rebuild-flats.mjs is what actually dropped the column.
  sql.push(`INSERT INTO flats (flat, floor) VALUES (${q(flat)}, ${parseInt(flat, 10)});`);
}

for (const p of PEOPLE) {
  const { hash, salt } = await hashPassword(DEV_PASSWORD, 100_000);
  // Stored E.164, through the SAME function login uses.
  //
  // NOT cosmetic: `login` normalises what is typed and then looks the row up
  // with `WHERE mobile = ?`, so a bare 10-digit number here matched nothing
  // and EVERY dev account was unloggable — the seed printed a password that
  // could not be used, and said so confidently. It dated from before 0009
  // normalised the column and was never brought forward. Found on 2026-08-12
  // while trying to verify a fix locally.
  sql.push(
    `INSERT INTO owners (flat, name, mobile, email, pw_hash, pw_salt, must_change_pw, role, created_at)
     VALUES (${q(p.flat)}, ${q(p.name)}, ${q(normaliseMobile(p.mobile))}, ${q(p.email)}, ${q(hash)}, ${q(salt)}, 0, ${q(p.role)}, datetime('now'));`
  );
}

for (const p of PERIODS) {
  sql.push(
    `INSERT INTO periods (period, rate_per_kg, due_date, late_fee, late_fee_after, status, created_at)
     VALUES (${q(p.period)}, ${p.rate}, ${q(p.due)}, 50, 0, ${q(p.status)}, datetime('now'));`
  );
}

for (const [flat, byPeriod] of Object.entries(READINGS)) {
  const periods = Object.keys(byPeriod).sort();
  for (const period of periods) {
    sql.push(
      `INSERT INTO readings (flat, period, reading, read_on, entered_at)
       VALUES (${q(flat)}, ${q(period)}, ${byPeriod[period]}, ${q(readOn(period))}, datetime('now'));`
    );
  }
  // Bills need a previous reading to difference against, so skip the first.
  for (let i = 1; i < periods.length; i++) {
    const period = periods[i];
    const conf = PERIODS.find((p) => p.period === period);
    if (!conf) continue;
    const delta = meterDelta(byPeriod[period], byPeriod[periods[i - 1]]);
    const consumption = computeConsumption(byPeriod[period], byPeriod[periods[i - 1]]);
    const { gasAmount, total } = computeBill({ consumption, ratePerKg: conf.rate });
    const status = conf.status === 'locked' ? 'paid' : 'unpaid';
    sql.push(
      `INSERT INTO bills (flat, period, meter_delta, consumption, conversion_factor, rate_per_kg, gas_amount, total, status, paid_at, created_at)
       VALUES (${q(flat)}, ${q(period)}, ${delta}, ${consumption}, ${DEFAULT_CONVERSION}, ${conf.rate}, ${gasAmount}, ${total},
               ${q(status)}, ${status === 'paid' ? `datetime('now')` : 'NULL'}, datetime('now'));`
    );
  }
}

sql.push(
  `INSERT INTO notices (title, body, kind, allow_comments, active, posted_at) VALUES
   ('Gas bills generated', 'July bills are on your dashboard. Due by the 10th.', 'notice', 0, 1, datetime('now')),
   ('Pool timings — proposal', 'The committee proposes moving morning pool hours to 6–9 AM from September. Please share your views before Saturday''s meeting.', 'notice', 1, 1, datetime('now'));`
);

execFileSync('npx', ['wrangler', 'd1', 'execute', 'dddp', '--local', '--command', sql.join('\n')], {
  stdio: 'inherit',
  cwd: new URL('..', import.meta.url).pathname,
});

console.log(`\nSeeded ${PEOPLE.length} residents. Dev password for all: ${DEV_PASSWORD}`);
console.log('4A is superadmin (god mode), 13A and 4C are admins.');
