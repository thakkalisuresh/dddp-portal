-- Ownership changes, an editable committee, and a full activity trail.
--
-- THE PRIVACY BUG THIS FIXES: bills and payment proofs were reachable by
-- whoever currently occupies the flat. When 4A is sold, the new owner would
-- have been able to read the previous owner's bills and open their payment
-- screenshots. Those are personal financial documents belonging to a PERSON,
-- not to a flat. Attaching owner_id to both closes it.

-- ── tenancy ──────────────────────────────────────────────────────────────
ALTER TABLE owners ADD COLUMN active       INTEGER NOT NULL DEFAULT 1;
ALTER TABLE owners ADD COLUMN moved_in_at  TEXT;
ALTER TABLE owners ADD COLUMN moved_out_at TEXT;

-- Who owned the flat when this bill was raised. Readings stay keyed to the
-- flat alone: a meter reading is a property fact, not a personal one.
ALTER TABLE bills ADD COLUMN owner_id INTEGER REFERENCES owners(id);
ALTER TABLE payment_proofs ADD COLUMN owner_id INTEGER REFERENCES owners(id);

CREATE INDEX ix_bills_owner  ON bills(owner_id);
CREATE INDEX ix_owners_active ON owners(active, flat);

-- Backfill: before any transfer existed, every bill belonged to the flat's
-- sole owner.
UPDATE bills
   SET owner_id = (SELECT id FROM owners o WHERE o.flat = bills.flat LIMIT 1)
 WHERE owner_id IS NULL;

UPDATE payment_proofs
   SET owner_id = (SELECT b.owner_id FROM bills b WHERE b.id = payment_proofs.bill_id)
 WHERE owner_id IS NULL;

-- ── committee ────────────────────────────────────────────────────────────
-- Published deliberately rather than derived from `owners`, so adding a
-- resident can never silently publish their name. Editable because an AGM
-- changes it — the previous hard-coded list would have gone stale the first
-- time the committee turned over.
CREATE TABLE committee (
  id       INTEGER PRIMARY KEY,
  role     TEXT NOT NULL,
  name     TEXT NOT NULL,
  flat     TEXT,
  phone    TEXT,             -- published on the public page; usually only the treasurer's
  sort     INTEGER NOT NULL DEFAULT 0,
  active   INTEGER NOT NULL DEFAULT 1
);

INSERT INTO committee (role, name, flat, phone, sort) VALUES
  ('President',     'Sekharan',            '5A',  NULL,               1),
  ('Secretary',     'Adv. Joy Vettiyadan', '10A', NULL,               2),
  ('Treasurer',     'Mukesh',              '13A', '+91 98466 86885',  3),
  ('Gas In-charge', 'Owner of 13E',        '13E', NULL,               4);

-- ── activity ─────────────────────────────────────────────────────────────
-- audit_log already records every server-side action. This adds the parts a
-- server never sees: which pages a resident opened, and errors that happened
-- in their browser.
CREATE TABLE activity (
  id         INTEGER PRIMARY KEY,
  owner_id   INTEGER REFERENCES owners(id),
  actor_id   INTEGER REFERENCES owners(id),  -- differs from owner_id under god mode
  kind       TEXT NOT NULL,                  -- page | action | client-error
  name       TEXT NOT NULL,
  detail     TEXT,
  user_agent TEXT,
  at         TEXT NOT NULL
);
CREATE INDEX ix_activity_at    ON activity(at);
CREATE INDEX ix_activity_owner ON activity(owner_id, at);

-- Query indexes for the god-mode log viewer.
CREATE INDEX ix_audit_actor ON audit_log(actor_id, at);
CREATE INDEX ix_audit_action ON audit_log(action, at);
