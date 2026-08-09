#!/usr/bin/env node
/**
 * Fill the portal with a believable building for user testing, and remove it
 * again without trace.
 *
 *   node scripts/seed-demo.mjs --remote --confirm    # create
 *   node scripts/seed-demo.mjs --remote --remove     # undo, completely
 *   node scripts/seed-demo.mjs --local               # same, against local
 *
 * THE REMOVAL IS THE POINT. This writes 99 flats and ~1000 bills into the same
 * tables the real roster will use, so "we will clean it up later" has to be a
 * command rather than an intention. Every row created is recorded by id in a
 * settings row, and --remove deletes exactly those and nothing else — it does
 * not guess from a name prefix, because the real Priya Menon might one day
 * move in and the guess would take her with it.
 *
 * Demo accounts are also marked in the data itself: names carry a [demo] tag
 * and mobiles sit in one block, so anybody looking at the admin console can
 * tell at a glance that none of this is real.
 *
 * Passwords are shown ONCE, at the end. They are strong because this runs
 * against the live site, where a guessable admin password is a real door.
 */

import { webcrypto as crypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allFlats, unitsOn } from '../functions/lib/building.js';

const DB = 'dddp';
const local = process.argv.includes('--local');
const remove = process.argv.includes('--remove');
const confirmed = process.argv.includes('--confirm') || local || remove;
const MARKER = 'demo_seed_ids';
const MONTHS = 10;

if (!confirmed) {
  console.error('\nThis writes ~1100 rows to PRODUCTION. Re-run with --confirm.\n');
  process.exit(1);
}

/* ── plumbing ─────────────────────────────────────────────────────────────── */

function run(args) {
  try {
    return execFileSync('npx', ['wrangler', 'd1', 'execute', DB,
      local ? '--local' : '--remote', ...args, '--json', '--yes'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024 });
  } catch (err) {
    // wrangler puts the useful line on stderr; swallowing it turns every SQL
    // mistake into "Command failed", which says nothing.
    const detail = `${err.stderr ?? ''}${err.stdout ?? ''}`.split('\n')
      .filter((l) => /error|ERROR|constraint|no such/i.test(l)).slice(0, 3).join(' | ');
    throw new Error(detail || err.message);
  }
}
const q = (sql) => JSON.parse((() => { const o = run(['--command', sql]); return o.slice(o.indexOf('[')); })())
  .flatMap((r) => r.results ?? []);

function exec(sqlText) {
  const dir = mkdtempSync(join(tmpdir(), 'ddp-demo-'));
  const f = join(dir, 'x.sql');
  writeFileSync(f, sqlText);
  return run(['--file', f]);
}

const lit = (v) => (v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

async function hash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password),
    'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256);
  return { hash: Buffer.from(bits).toString('base64'), salt: Buffer.from(salt).toString('base64') };
}

/** Strong, because this runs against the live site. */
function strongPassword() {
  const words = ['harbour', 'lantern', 'copper', 'meadow', 'thicket', 'compass',
                 'granite', 'willow', 'ember', 'quarry', 'saffron', 'monsoon'];
  const b = crypto.getRandomValues(new Uint32Array(4));
  return `${words[b[0] % words.length]}-${words[b[1] % words.length]}-${b[2] % 9000 + 1000}`;
}

/* ── removal ──────────────────────────────────────────────────────────────── */

function readMarker() {
  const row = q(`SELECT value FROM settings WHERE key = '${MARKER}'`)[0];
  if (!row?.value) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function removeAll() {
  let m = readMarker();

  if (!m) {
    // A seed that failed part way never got to write the marker, so the rows
    // it did create would be invisible to a marker-only removal. Fall back to
    // the [demo] tag, which is exactly why the tag is in the data.
    const orphans = q("SELECT id, flat FROM owners WHERE name LIKE '%[demo]'");
    if (!orphans.length) {
      console.log('\n  No demo data found. Nothing to remove.\n');
      return;
    }
    console.log(`\n  No marker, but ${orphans.length} tagged rows are here — `
              + 'cleaning up a seed that did not finish.');
    // Deliberately no periods. Without a marker there is no way to tell a demo
    // month from a real one, and deleting every period would take the
    // building's actual bills with it. People go; bills stay for a human.
    m = {
      owners: orphans.map((o) => o.id),
      flats: [...new Set(orphans.map((o) => o.flat))],
      periods: [],
    };
  }

  const owners = m.owners ?? [];
  const flats = m.flats ?? [];
  const periods = m.periods ?? [];

  console.log(`\n  Removing ${owners.length} residents, ${flats.length} flats, `
            + `${periods.length} months.\n`);

  const inList = (a) => a.map(lit).join(',') || "''";
  const O = inList(owners);
  const P = inList(periods);

  // Column names taken from the schema rather than assumed. The first attempt
  // used owner_id everywhere and died on `messages`, which has handled_by and
  // no owner at all — and would have missed actor_id on click_log and activity.
  exec([
    `DELETE FROM payment_proofs  WHERE bill_id IN (SELECT id FROM bills WHERE period IN (${P}));`,
    `DELETE FROM payment_intents WHERE bill_id IN (SELECT id FROM bills WHERE period IN (${P}));`,
    `DELETE FROM bills    WHERE period IN (${P});`,
    `DELETE FROM readings WHERE period IN (${P});`,
    `DELETE FROM periods  WHERE period IN (${P});`,
    `DELETE FROM password_resets WHERE owner_id IN (${O});`,
    `DELETE FROM click_log WHERE owner_id IN (${O}) OR actor_id IN (${O});`,
    `DELETE FROM activity  WHERE owner_id IN (${O}) OR actor_id IN (${O});`,
    `DELETE FROM comments  WHERE owner_id IN (${O});`,
    `DELETE FROM audit_log WHERE actor_id IN (${O}) OR subject_id IN (${O});`,
    `DELETE FROM sessions  WHERE actor_id IN (${O}) OR subject_id IN (${O});`,
    // Messages belong to the public, not to a resident. A demo admin may have
    // handled one, so the reference is cleared rather than the message deleted.
    `UPDATE messages SET handled_by = NULL WHERE handled_by IN (${O});`,
    `DELETE FROM owners WHERE id IN (${O});`,
    // Only flats this seed created, and only if nobody real moved into one.
    `DELETE FROM flats WHERE flat IN (${inList(flats)})
       AND flat NOT IN (SELECT flat FROM owners);`,
    `DELETE FROM settings WHERE key = '${MARKER}';`,
  ].join('\n'));

  const left = q('SELECT COUNT(*) n FROM owners')[0].n;
  const bills = q('SELECT COUNT(*) n FROM bills')[0].n;
  console.log(`  Done. ${left} residents and ${bills} bills remain — these are yours.\n`);
}

/* ── the building ─────────────────────────────────────────────────────────── */

const FIRST = ['Anil', 'Meera', 'Rajesh', 'Latha', 'Suresh', 'Divya', 'Manoj', 'Anju',
  'Vinod', 'Reshma', 'Prakash', 'Sindhu', 'Jayan', 'Bindu', 'Ramesh', 'Deepa',
  'Sunil', 'Asha', 'Hari', 'Nisha', 'Biju', 'Remya', 'Shaji', 'Geetha'];
const LAST = ['Nair', 'Menon', 'Pillai', 'Kurup', 'Varma', 'Thomas', 'Joseph',
  'Iyer', 'Warrier', 'Panicker', 'Das', 'Mathew'];

/** 3 BHK flats burn more gas than 2 BHK. A is big, C and H are small. */
function baseUsage(flat) {
  const unit = flat.slice(-1);
  if (['C', 'F', 'G', 'H'].includes(unit)) return 1.1;
  return 1.7;
}

function periodsBack(n) {
  const out = [];
  const now = new Date();
  for (let i = n; i >= 1; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

const main = async () => {
  if (remove) return removeAll();

  if (readMarker()) {
    console.error('\n  Demo data is already loaded. Run with --remove first.\n');
    process.exit(1);
  }

  const env = local ? 'LOCAL' : 'PRODUCTION';
  console.log(`\n  Seeding ${env}.\n`);

  const existingFlats = new Set(q('SELECT flat FROM flats').map((r) => r.flat));
  const existingMobiles = new Set(q('SELECT mobile FROM owners').map((r) => r.mobile));
  // Flats that already have somebody real in them. The committee's own
  // accounts live in 4A, 10A, 13A and 13E, and dropping a demo owner alongside
  // them would shadow the real resident and read as two owners per flat.
  const occupied = new Set(
    q('SELECT DISTINCT flat FROM owners WHERE active = 1').map((r) => r.flat));

  const flats = allFlats();
  const periods = periodsBack(MONTHS);
  const rows = { flats: [], owners: [], periods, ownerIds: [] };

  /* people */
  const residentPw = strongPassword();
  const adminPw = strongPassword();
  const residentHash = await hash(residentPw);
  const adminHash = await hash(adminPw);

  const owners = [];
  let n = 0;
  for (const flat of flats) {
    n += 1;
    // Every 11th flat is left vacant, and every 7th is let — so the tester
    // meets an empty flat and a landlord view without being told where.
    if (n % 11 === 0) continue;
    if (occupied.has(flat)) continue;            // leave real residents alone
    const mobile = `+9199${String(900000 + n).padStart(8, '0')}`.slice(0, 13);
    if (existingMobiles.has(mobile)) continue;

    const name = `${FIRST[n % FIRST.length]} ${LAST[n % LAST.length]} [demo]`;
    owners.push({ flat, name, mobile, relationship: 'owner' });

    if (n % 7 === 0) {
      const tMobile = `+9198${String(900000 + n).padStart(8, '0')}`.slice(0, 13);
      owners.push({
        flat, relationship: 'tenant', mobile: tMobile,
        name: `${FIRST[(n + 5) % FIRST.length]} ${LAST[(n + 3) % LAST.length]} [demo]`,
      });
    }
  }

  // The two the tester actually logs in as. Placed in a let flat so the
  // resident account sees a tenant's dashboard, which is the richer view.
  const testResident = owners.find((o) => o.relationship === 'tenant');
  testResident.name = 'Test Resident [demo]';
  // Its own flat, so the admin account is not a second owner sitting on top of
  // somebody else — which is what the doctor's TWO-OWNERS check exists to spot.
  const adminFlat = flats.find((f) =>
    !occupied.has(f) && !owners.some((o) => o.flat === f));
  const testAdmin = {
    flat: adminFlat, name: 'Test Admin [demo]', mobile: '+919990000001',
    relationship: 'owner', role: 'admin',
  };
  owners.push(testAdmin);

  console.log(`  ${flats.length} flats · ${owners.length} residents · ${MONTHS} months`);

  // Written BEFORE anything is inserted. A seed that dies halfway used to
  // leave rows no marker described, and the tag-based fallback had to guess at
  // periods — which on production would take real bills with it. Recording the
  // plan first makes removal exact whatever happens next.
  rows.flats = flats.filter((f) => !existingFlats.has(f));
  exec(`INSERT INTO settings (key, value) VALUES (${lit(MARKER)}, ${lit(JSON.stringify(rows))})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;`);

  /* write flats + people */
  const flatSql = rows.flats
    .map((f) => `INSERT INTO flats (flat, floor) VALUES (${lit(f)}, ${parseInt(f, 10)});`);

  const now = new Date().toISOString();
  const ownerSql = owners.map((o) => {
    const h = o === testAdmin ? adminHash : o === testResident ? residentHash : residentHash;
    return `INSERT INTO owners (flat, name, mobile, pw_hash, pw_salt, must_change_pw, role,
              relationship, active, created_at)
            VALUES (${lit(o.flat)}, ${lit(o.name)}, ${lit(o.mobile)}, ${lit(h.hash)},
                    ${lit(h.salt)}, 0, ${lit(o.role ?? 'owner')}, ${lit(o.relationship)}, 1, ${lit(now)});`;
  });

  exec([...flatSql, ...ownerSql].join('\n'));

  const created = q(`SELECT id, flat, mobile, relationship FROM owners WHERE name LIKE '%[demo]'`);
  rows.owners = created.map((o) => o.id);
  const occupantOfFlat = new Map();
  for (const o of created) {
    const cur = occupantOfFlat.get(o.flat);
    if (!cur || o.relationship === 'tenant') occupantOfFlat.set(o.flat, o);
  }

  /* months, readings, bills */
  const meter = new Map(flats.map((f) => [f, 2 + Math.random() * 3]));
  const stmts = [];

  periods.forEach((period, i) => {
    const rate = 72 + Math.round(Math.random() * 6);
    const due = `${period}-10`;
    stmts.push(`INSERT INTO periods (period, rate_per_kg, conversion_factor, due_date,
                  late_fee, late_fee_after, status, created_at)
                VALUES (${lit(period)}, ${rate}, 2.60, ${lit(due)}, 50, 5, 'locked', ${lit(now)});`);

    for (const flat of flats) {
      const prev = meter.get(flat);
      const delta = Math.round((baseUsage(flat) * (0.7 + Math.random() * 0.6)) * 1000) / 1000;
      const reading = Math.round((prev + delta) * 1000) / 1000;
      meter.set(flat, reading);

      stmts.push(`INSERT INTO readings (flat, period, reading, read_on, entered_at)
                  VALUES (${lit(flat)}, ${lit(period)}, ${reading}, ${lit(due)}, ${lit(now)});`);

      const occupant = occupantOfFlat.get(flat);
      if (!occupant) continue;                       // vacant flat, no bill

      const consumption = Math.round(delta * 2.60 * 100) / 100;
      const gas = Math.round(consumption * rate * 100) / 100;

      // Older months settled, the last two live, one in review, a few overdue.
      const age = periods.length - i;
      let status = 'paid';
      let lateFee = 0;
      if (age === 1) status = ['unpaid', 'unpaid', 'initiated', 'awaiting'][i % 4];
      else if (age === 2) status = i % 5 === 0 ? 'unpaid' : 'paid';
      if (status === 'unpaid' && age === 2) lateFee = 50;

      const total = Math.ceil(gas + lateFee);
      stmts.push(`INSERT INTO bills (flat, period, meter_delta, consumption, conversion_factor,
                    rate_per_kg, gas_amount, late_fee, late_fee_at, total, status, paid_at,
                    owner_id, created_at)
                  VALUES (${lit(flat)}, ${lit(period)}, ${delta}, ${consumption}, 2.60, ${rate},
                    ${gas}, ${lateFee}, ${lateFee ? lit(now) : 'NULL'}, ${total}, ${lit(status)},
                    ${status === 'paid' ? lit(now) : 'NULL'}, ${occupant.id}, ${lit(now)});`);
    }
  });

  // Chunked: one statement per row across 10 months is a few thousand, and a
  // single file that large is refused.
  for (let i = 0; i < stmts.length; i += 400) {
    exec(stmts.slice(i, i + 400).join('\n'));
    process.stdout.write(`\r  writing… ${Math.min(i + 400, stmts.length)}/${stmts.length}`);
  }
  console.log();

  exec(`INSERT INTO settings (key, value) VALUES (${lit(MARKER)}, ${lit(JSON.stringify(rows))})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;`);

  const counts = q(`SELECT (SELECT COUNT(*) FROM flats) f, (SELECT COUNT(*) FROM owners) o,
                           (SELECT COUNT(*) FROM bills) b, (SELECT COUNT(*) FROM readings) r`)[0];
  console.log(`\n  ${counts.f} flats · ${counts.o} residents · ${counts.b} bills · ${counts.r} readings\n`);

  const site = local ? 'http://localhost:8787' : 'https://diamondpark.pages.dev';
  console.log('  ─────────────────────────────────────────────');
  console.log('  TEST LOGINS — shown once, not stored anywhere');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  Resident   ${testResident.mobile.replace('+91', '')}   ${residentPw}`);
  console.log(`             tenant of ${testResident.flat}`);
  console.log(`  Admin      ${testAdmin.mobile.replace('+91', '')}   ${adminPw}`);
  console.log(`             owner of ${testAdmin.flat}, admin rights`);
  console.log(`\n  ${site}\n`);
  console.log('  Every demo resident shares the resident password.');
  console.log('  Remove all of it with:  node scripts/seed-demo.mjs '
            + `${local ? '--local' : '--remote'} --remove\n`);
};

main().catch((err) => { console.error('\nFailed:', err.message); process.exit(1); });
