/**
 * A real SQLite standing in for D1, for tests that have to exercise SQL.
 *
 * WHY THIS EXISTS. The suite's existing pattern is a hand-written router — a
 * regex per query, returning a canned object. That is right for a function with
 * two queries, and it stops working for the maintenance jobs, which lean on the
 * database to be correct: `ON CONFLICT (flat, quarter) DO NOTHING` is what makes
 * issuing idempotent, `late_fee_at IS NULL` is what makes the fee land once, and
 * `PRIMARY KEY (bill_id, kind)` is what stops a resident being told twice. A
 * router asserts that the string was sent. It cannot assert that any of those
 * rules held, because the rules live in SQLite rather than in our code — which
 * is precisely where we put them on purpose.
 *
 * So these tests run the REAL migrations against a real engine. A test that
 * issues a quarter twice and finds one bill has tested the constraint that will
 * be doing the work in production.
 *
 * `node:sqlite` rather than a dependency: it ships with Node 22+, and this is a
 * test helper on a project whose whole deployment story is "no build step we do
 * not need".
 *
 * WHAT IT IS NOT. Not D1. Notably it is synchronous underneath, so it cannot
 * catch a race, and D1's own batch semantics are its own. It models the surface
 * this codebase actually uses: prepare/bind/first/all/run and batch.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every migration, in the order wrangler would apply them. */
export function migrationFiles() {
  return readdirSync(join(root, 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * A fresh database with every migration applied.
 *
 * Foreign keys ON, which is not SQLite's default and IS how the rows behave in
 * practice — a test that passes only because a reference went unchecked is
 * worse than no test.
 */
export function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of migrationFiles()) {
    db.exec(readFileSync(join(root, 'migrations', file), 'utf8'));
  }
  return db;
}

/**
 * Wrap it in the shape `env.DB` has.
 *
 * `run()` reports `meta.changes`, because several guards in this codebase read
 * exactly that to tell "I applied the fee" from "the nightly run got there
 * first" — see applyLateFeeToMaintBill. A stand-in that did not report it would
 * make the raced path untestable.
 */
export function d1(db) {
  const statement = (sql, args) => ({
    sql,
    args,
    first() {
      const row = db.prepare(sql).get(...args);
      return Promise.resolve(row ?? null);
    },
    all() {
      return Promise.resolve({ results: db.prepare(sql).all(...args) });
    },
    run() {
      const r = db.prepare(sql).run(...args);
      return Promise.resolve({ meta: { changes: Number(r.changes ?? 0) } });
    },
  });

  return {
    prepare(sql) {
      return {
        bind: (...args) => statement(sql, args),
        // An unbound statement is still runnable — several queries here take no
        // parameters at all.
        first: () => statement(sql, []).first(),
        all: () => statement(sql, []).all(),
        run: () => statement(sql, []).run(),
      };
    },
    // In order, and the results in the same order, which is what the
    // INSERT…SELECT statements depend on: they select from rows written earlier
    // in the same batch.
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  };
}

/** A database and its env, ready to hand to a job. */
export function testEnv(extra = {}) {
  const db = freshDb();
  return { db, env: { DB: d1(db), ...extra } };
}

/* ── fixtures ─────────────────────────────────────────────────────────────  */

/** Straight SQL, for arranging a test's world without going through the app. */
export function seed(db, { flats = [], people = [] } = {}) {
  for (const f of flats) {
    db.prepare('INSERT INTO flats (flat, floor, active) VALUES (?, ?, 1)')
      .run(f, Number(String(f).match(/^\d+/)?.[0] ?? 1));
  }
  for (const p of people) {
    db.prepare(
      `INSERT INTO owners (id, flat, name, mobile, email, pw_hash, pw_salt, created_at,
                           active, relationship, role, moved_in_at, moved_out_at, lease_ends_at,
                           tenancy_confirmed_at)
       VALUES (?, ?, ?, ?, ?, 'h', 's', '2026-01-01T00:00:00Z', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      p.id, p.flat, p.name ?? `P${p.id}`,
      p.mobile ?? `90000000${String(p.id).padStart(2, '0')}`,
      p.email ?? null,
      p.active ?? 1, p.relationship ?? 'owner', p.role ?? 'owner',
      p.moved_in_at ?? null, p.moved_out_at ?? null, p.lease_ends_at ?? null,
      // Null by default, which is the honest starting state: a tenancy nobody
      // has confirmed. The admin tenancy check flags exactly that, so a fixture
      // that silently stamped one would hide the flag it is testing for.
      p.tenancy_confirmed_at ?? null,
    );
  }
}

/** Rows out, for asserting on. */
export function rows(db, sql, ...args) {
  return db.prepare(sql).all(...args);
}
