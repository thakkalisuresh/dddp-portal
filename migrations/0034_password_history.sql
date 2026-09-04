-- The passwords an account has already used, so it cannot go back to one.
--
-- WHAT WAS MISSING. `refuseCurrentPassword` (0d9a2cf) stopped the temporary
-- password being kept as the permanent one, but it only ever knew about the
-- credential sitting on the row right now. A resident could change away from a
-- password and straight back to it, and — the case that actually matters — a
-- /forgot reset could land on the very password the reset was requested
-- because of. The check had a memory one entry deep.
--
-- WHY A TABLE AND NOT COLUMNS ON owners. Five previous passwords is five
-- (hash, salt, iterations) triples, and 0025 is the reason the iterations
-- travel with each one: a hash is only reproducible at the count that made it,
-- and rows written before an iteration change must stay verifiable or the
-- check silently stops matching them. Fifteen columns on `owners` that shift
-- meaning by position is the version of this that gets a backfill wrong once
-- and never recovers.
--
-- WHY THE OUTGOING PASSWORD IS ARCHIVED, RATHER THAN THE INCOMING ONE. Every
-- write path already holds the old hash — it has to, to verify against it —
-- and archiving on the way out means the temporary passwords minted by an
-- admin reset are captured by exactly the same line of code as the ones
-- residents choose, with no path needing to know which kind it is handling.
-- It also keeps the invariant simple: history is what this account USED to
-- have, and `owners.pw_hash` is what it has, so the two never overlap and a
-- password is never checked twice.
--
-- WHY FIVE. Each entry costs one PBKDF2 derive to check — ~27 ms on the edge,
-- per 0025's measurement — and they cannot be batched, because every row has
-- its own salt. Five is therefore ~135 ms of CPU on top of the ~81 ms a
-- password change already spends. That is affordable ONLY because this runs
-- when somebody sets a password, a few times per resident per year, and never
-- on the login path, which is untouched. A depth of twenty would be twenty
-- derives and a policy nobody measured.
--
-- WHY COUNT AND NOT AGE. "No password used in the last year" is the better
-- rule and the one with unbounded storage: a resident who changes weekly
-- accumulates rows forever, and the derive cost grows with them. A fixed five
-- makes the worst case a number rather than a hope.
--
-- NOT BACKED UP, deliberately. `TABLES` in lib/backup.js omits this for the
-- same reason it omits password_resets — the export header promises passwords
-- are never exported, and a history table is the one place that promise would
-- be quietly broken in bulk.
CREATE TABLE password_history (
  id            INTEGER PRIMARY KEY,
  owner_id      INTEGER NOT NULL REFERENCES owners(id),
  pw_hash       TEXT NOT NULL,             -- PBKDF2-SHA256, base64
  pw_salt       TEXT NOT NULL,
  pw_iterations INTEGER NOT NULL,          -- the count that made THIS hash; see 0025
  set_at        TEXT NOT NULL              -- when it stopped being the current password
);

-- The only read this table has: the newest few for one owner.
CREATE INDEX idx_password_history_owner ON password_history(owner_id, set_at DESC);
