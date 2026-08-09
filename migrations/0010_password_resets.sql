-- Self-service password reset by emailed code.
--
-- Today a resident who forgets their password contacts Mukesh, who resets it
-- from the admin console and sends a temporary one over WhatsApp. That works,
-- but it makes one person the bottleneck for the whole building and means a
-- resident's access depends on someone else being awake.
--
-- The code is STORED AS A HASH, never in the clear. It is short-lived and
-- low-entropy by necessity — six digits is what someone will actually type
-- from a phone — so the compensating controls are all here rather than in the
-- code's length: a short expiry, a hard attempt limit, single use, and a rate
-- limit on issuing them at all.
--
-- Deliberately its own table rather than columns on `owners`. A reset in
-- flight is a separate short-lived fact, several can be requested and
-- abandoned, and the history of who asked and when is worth keeping after the
-- reset itself is spent.
CREATE TABLE password_resets (
  id         INTEGER PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES owners(id),
  code_hash  TEXT NOT NULL,             -- PBKDF2-SHA256, base64
  code_salt  TEXT NOT NULL,
  sent_to    TEXT NOT NULL,             -- the address it went to, for the audit trail
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used_at    TEXT,                      -- single use; set the moment it succeeds
  created_at TEXT NOT NULL
);

-- Finding the live reset for an account is the hot path on every attempt.
CREATE INDEX ix_resets_owner ON password_resets(owner_id, created_at);

-- Pruning spent and expired rows in the nightly job.
CREATE INDEX ix_resets_expiry ON password_resets(expires_at);
