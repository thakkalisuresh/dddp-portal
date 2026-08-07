-- DD Diamond Park portal — initial schema
-- Every reading and bill is keyed on (flat, period) so historical data can be
-- backfilled later as a plain INSERT. See plan §3.

CREATE TABLE flats (
  flat      TEXT PRIMARY KEY,              -- '4A'
  floor     INTEGER NOT NULL,
  paise_tag INTEGER NOT NULL UNIQUE,       -- 1..99, permanent per flat
  active    INTEGER NOT NULL DEFAULT 1,
  CHECK (paise_tag BETWEEN 1 AND 99)
);

CREATE TABLE owners (
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
  CHECK (role IN ('owner','admin','superadmin'))
);
CREATE INDEX ix_owners_flat ON owners(flat);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  actor_id   INTEGER NOT NULL REFERENCES owners(id),  -- who really logged in
  subject_id INTEGER NOT NULL REFERENCES owners(id),  -- whose data is shown
  mode       TEXT NOT NULL DEFAULT 'normal',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (mode IN ('normal','impersonate_ro','impersonate_rw'))
);
CREATE INDEX ix_sessions_actor ON sessions(actor_id);

CREATE TABLE periods (
  period         TEXT PRIMARY KEY,         -- '2026-07'
  rate_per_kg    REAL NOT NULL,
  -- Meters count cubic metres; bills are priced per kilogram. Derived from the
  -- old portal's own history (a constant 2.60). Versioned per period because
  -- calorific value is revised occasionally and old bills must keep theirs.
  conversion_factor REAL NOT NULL DEFAULT 2.60,
  due_date       TEXT NOT NULL,            -- '2026-08-10'
  late_fee       REAL NOT NULL DEFAULT 0,  -- WHOLE RUPEES ONLY, see §4e
  late_fee_after INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'open',
  created_at     TEXT NOT NULL,
  CHECK (status IN ('open','locked')),
  -- the paise identify the flat; a fee carrying paise breaks reconciliation
  CHECK (late_fee = CAST(late_fee AS INTEGER))
);

CREATE TABLE readings (
  flat       TEXT NOT NULL REFERENCES flats(flat),
  period     TEXT NOT NULL REFERENCES periods(period),
  reading    REAL NOT NULL,                -- cumulative meter value
  entered_by INTEGER REFERENCES owners(id),
  entered_at TEXT NOT NULL,
  PRIMARY KEY (flat, period)
);

CREATE TABLE bills (
  id                 INTEGER PRIMARY KEY,
  flat               TEXT NOT NULL REFERENCES flats(flat),
  period             TEXT NOT NULL,
  meter_delta        REAL NOT NULL,        -- raw meter movement, cubic metres
  consumption        REAL NOT NULL,        -- billable kilograms
  conversion_factor  REAL NOT NULL,        -- snapshot
  rate_per_kg        REAL NOT NULL,        -- snapshot, deliberately not a join
  gas_amount         REAL NOT NULL,
  other_charges      REAL NOT NULL DEFAULT 0,
  additional_charges REAL NOT NULL DEFAULT 0,
  late_fee           REAL NOT NULL DEFAULT 0,
  late_fee_at        TEXT,                 -- NULL = never applied (idempotency guard)
  late_fee_waived_by INTEGER REFERENCES owners(id),
  total              REAL NOT NULL,        -- carries the unique paise
  status             TEXT NOT NULL DEFAULT 'unpaid',
  paid_at            TEXT,
  created_at         TEXT NOT NULL,
  UNIQUE (flat, period),
  CHECK (status IN ('unpaid','initiated','awaiting','paid','waived')),
  CHECK (late_fee = CAST(late_fee AS INTEGER))
);
CREATE INDEX ix_bills_status ON bills(status, period);

CREATE TABLE payment_intents (
  id         INTEGER PRIMARY KEY,
  bill_id    INTEGER NOT NULL REFERENCES bills(id),
  created_at TEXT NOT NULL
);

CREATE TABLE payment_proofs (
  id            INTEGER PRIMARY KEY,
  bill_id       INTEGER NOT NULL REFERENCES bills(id),
  r2_key        TEXT,                      -- nulled on delete, row retained
  image_sha256  TEXT NOT NULL UNIQUE,      -- survives deletion, powers dedupe
  utr           TEXT,
  parsed_amount REAL,
  status        TEXT NOT NULL DEFAULT 'pending',
  reviewed_by   INTEGER REFERENCES owners(id),
  reviewed_at   TEXT,
  deleted_at    TEXT,
  created_at    TEXT NOT NULL,
  CHECK (status IN ('pending','approved','rejected'))
);
CREATE UNIQUE INDEX ux_proof_utr ON payment_proofs(utr) WHERE utr IS NOT NULL;

CREATE TABLE notices (
  id             INTEGER PRIMARY KEY,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'notice',
  event_date     TEXT,
  allow_comments INTEGER NOT NULL DEFAULT 0,   -- per-notice opt-in
  active         INTEGER NOT NULL DEFAULT 1,
  posted_at      TEXT NOT NULL,
  CHECK (kind IN ('notice','event'))
);

CREATE TABLE comments (
  id         INTEGER PRIMARY KEY,
  notice_id  INTEGER NOT NULL REFERENCES notices(id),
  owner_id   INTEGER NOT NULL REFERENCES owners(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  hidden_by  INTEGER REFERENCES owners(id),    -- soft hide, row retained
  hidden_at  TEXT
);
CREATE INDEX ix_comments_notice ON comments(notice_id, created_at);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  actor_id   INTEGER REFERENCES owners(id),
  subject_id INTEGER REFERENCES owners(id),
  action     TEXT NOT NULL,
  detail     TEXT,
  at         TEXT NOT NULL
);
CREATE INDEX ix_audit_at ON audit_log(at);

CREATE TABLE error_log (
  id       INTEGER PRIMARY KEY,
  code     TEXT NOT NULL,
  severity TEXT NOT NULL,
  message  TEXT,
  detail   TEXT,
  at       TEXT NOT NULL
);
CREATE INDEX ix_error_code ON error_log(code, at);

CREATE TABLE login_attempts (
  mobile TEXT NOT NULL,
  at     TEXT NOT NULL
);
CREATE INDEX ix_login_attempts ON login_attempts(mobile, at);
