-- A fourth role: the committee member, who can post notices and nothing else.
--
-- WHY A ROLE AND NOT A FLAG. The obvious cheap move was a `can_post_notices`
-- column, which needs no rebuild of this table. It was rejected because the
-- portal already SHOWS a role — the chip beside a name in the console, the
-- select in god-edit, the audit trail — and a person whose chip says "owner"
-- while they post notices is a person nobody can explain. One name for one
-- standing, or the standing is invisible.
--
-- WHY THE ROLE SITS BELOW ADMIN. `ROLE_RANK` is a ladder and `hasRole` asks
-- "at least this rung". Committee goes in at rung 1 and pushes admin and
-- superadmin up, so every existing `hasRole(session, 'admin')` in the router
-- keeps refusing a committee member by default. The one thing they CAN do is
-- named explicitly in `committeeMayUse` — the exception is written down in a
-- single place instead of the gate being loosened for everybody.
--
-- ── the rebuild ─────────────────────────────────────────────────────────
-- SQLite cannot alter a CHECK constraint, so widening `role` means rebuilding
-- `owners` — the most-referenced table here, with fifteen foreign keys
-- pointing at it. The twelve-step rebuild is followed exactly:
--
--   * every column is carried over in the order the migrations added it
--     (0001, then 0003, 0011, 0012, 0013, 0014, 0023, 0025), so a later
--     `SELECT *` sees the same shape it saw yesterday
--   * ids are copied, not regenerated. Every one of those fifteen foreign
--     keys is an owner id, and a renumbered table would silently repoint
--     bills, comments and audit rows at the wrong people
--   * `defer_foreign_keys` holds enforcement to the end of the transaction,
--     which is what lets the old table be dropped while rows still reference
--     it. The constraints are checked again before the migration commits, so
--     this defers the check rather than skipping it
--   * the three indexes are recreated. Dropping the table drops them with it,
--     and losing ix_owners_flat_rel would quietly turn every bill and
--     dashboard lookup into a table scan
PRAGMA defer_foreign_keys = true;

CREATE TABLE owners_new (
  id             INTEGER PRIMARY KEY,
  flat           TEXT NOT NULL REFERENCES flats(flat),
  name           TEXT NOT NULL,
  mobile         TEXT NOT NULL UNIQUE,     -- login id
  email          TEXT,
  pw_hash        TEXT NOT NULL,            -- PBKDF2-SHA256, base64
  pw_salt        TEXT NOT NULL,            -- base64
  must_change_pw INTEGER NOT NULL DEFAULT 1,
  role           TEXT NOT NULL DEFAULT 'owner',
  created_at     TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  moved_in_at    TEXT,
  moved_out_at   TEXT,
  relationship   TEXT NOT NULL DEFAULT 'owner',
  invited_at     TEXT,
  late_fee_exempt_until  TEXT,
  late_fee_exempt_reason TEXT,
  notices_seen_at TEXT,
  pw_expires_at  TEXT,
  pw_iterations  INTEGER NOT NULL DEFAULT 100000,
  -- The whole point of the rebuild.
  CHECK (role IN ('owner','committee','admin','superadmin'))
);

INSERT INTO owners_new
  (id, flat, name, mobile, email, pw_hash, pw_salt, must_change_pw, role, created_at,
   active, moved_in_at, moved_out_at, relationship, invited_at,
   late_fee_exempt_until, late_fee_exempt_reason, notices_seen_at,
   pw_expires_at, pw_iterations)
SELECT
   id, flat, name, mobile, email, pw_hash, pw_salt, must_change_pw, role, created_at,
   active, moved_in_at, moved_out_at, relationship, invited_at,
   late_fee_exempt_until, late_fee_exempt_reason, notices_seen_at,
   pw_expires_at, pw_iterations
FROM owners;

DROP TABLE owners;
ALTER TABLE owners_new RENAME TO owners;

CREATE INDEX ix_owners_flat     ON owners(flat);
CREATE INDEX ix_owners_active   ON owners(active, flat);
CREATE INDEX ix_owners_flat_rel ON owners(flat, relationship, active);

-- ── who posted it ────────────────────────────────────────────────────────
-- Until now nobody asked, because everyone who could post a notice could also
-- edit every other notice, and the audit log was enough to answer "who wrote
-- this" after the fact. A committee member may edit and withdraw only their
-- OWN notices, so the answer has to be on the row where the check can reach it
-- — reconstructing authorship by scanning the audit log on every PATCH is a
-- rule nobody would trust and a query nobody should write.
--
-- NULLABLE, AND NOT BACKFILLED. Every notice that exists today was posted by
-- an admin, and NULL says exactly that: "posted before authorship was
-- recorded". Guessing an author from the audit log would write a fact into the
-- table that nobody verified. It costs nothing either way — the ownership test
-- only ever runs for committee members, and NULL fails it, so the pre-existing
-- notices stay editable by admins alone. Which is what they already were.
ALTER TABLE notices ADD COLUMN posted_by INTEGER REFERENCES owners(id);
