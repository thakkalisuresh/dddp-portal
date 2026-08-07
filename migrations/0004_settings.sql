-- Runtime switches, and the single-superadmin rule.

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  expires_at TEXT,               -- switches that must not be left on forever
  set_by     INTEGER REFERENCES owners(id),
  set_at     TEXT
);

-- Click capture is off, and stays off unless someone deliberately turns it on
-- for a specific problem. It expires on its own; see docs/PRIVACY.md.
INSERT INTO settings (key, value) VALUES ('click_capture', 'off');

-- Raw click events live apart from `activity`. They are high-volume,
-- low-value, and short-lived — keeping them separate means they can be dropped
-- wholesale without touching the audit trail.
CREATE TABLE click_log (
  id       INTEGER PRIMARY KEY,
  owner_id INTEGER REFERENCES owners(id),
  actor_id INTEGER REFERENCES owners(id),
  page     TEXT NOT NULL,
  target   TEXT NOT NULL,        -- element identity: tag#id.class
  label    TEXT,                 -- visible text, truncated. NEVER a field value.
  at       TEXT NOT NULL
);
CREATE INDEX ix_click_owner ON click_log(owner_id, at);
CREATE INDEX ix_click_at ON click_log(at);
