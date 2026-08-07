-- Contact messages from the public site.
--
-- Stored in D1 rather than posted to a third-party form service: one less
-- dependency, one less thing to expire, and the committee can read them in
-- the same admin area as everything else. The nightly CSV backup carries them
-- off-site like every other table.

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT,
  phone      TEXT,
  subject    TEXT,
  body       TEXT NOT NULL,
  handled_by INTEGER REFERENCES owners(id),
  handled_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_messages_created ON messages(created_at);

-- Crude flood protection for an unauthenticated endpoint.
CREATE TABLE message_attempts (
  fingerprint TEXT NOT NULL,
  at          TEXT NOT NULL
);
CREATE INDEX ix_message_attempts ON message_attempts(fingerprint, at);
