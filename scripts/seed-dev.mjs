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
import { computeBill, computeConsumption, meterDelta, DEFAULT_CONVERSION } from '../functions/lib/billing.js';

const DEV_PASSWORD = 'diamond-park-dev';

const PEOPLE = [
  { flat: '4A',  name: 'Sabarish Nair',        mobile: '9567791515', email: 'nair.sabarish97@gmail.com', role: 'superadmin' },
  { flat: '13A', name: 'Mukesh',               mobile: '9846686885', email: null, role: 'admin' },
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

const PAISE = { '4A': 4, '4B': 5, '4C': 6, '5A': 7, '5B': 8, '13A': 21 };
const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

const sql = [];
sql.push('DELETE FROM sessions;', 'DELETE FROM bills;', 'DELETE FROM readings;',
         'DELETE FROM periods;', 'DELETE FROM owners;', 'DELETE FROM flats;');

for (const [flat, tag] of Object.entries(PAISE)) {
  sql.push(`INSERT INTO flats (flat, floor, paise_tag) VALUES (${q(flat)}, ${parseInt(flat, 10)}, ${tag});`);
}

for (const p of PEOPLE) {
  const { hash, salt } = await hashPassword(DEV_PASSWORD, 100_000);
  sql.push(
    `INSERT INTO owners (flat, name, mobile, email, pw_hash, pw_salt, must_change_pw, role, created_at)
     VALUES (${q(p.flat)}, ${q(p.name)}, ${q(p.mobile)}, ${q(p.email)}, ${q(hash)}, ${q(salt)}, 0, ${q(p.role)}, datetime('now'));`
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
    const { gasAmount, total } = computeBill({
      consumption, ratePerKg: conf.rate, paiseTag: PAISE[flat],
    });
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
