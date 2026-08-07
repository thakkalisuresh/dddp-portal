-- Local development seed only. Real residents arrive via CSV import at cutover;
-- nothing is migrated from the old site (no hosting access exists).
-- Passwords here are placeholders and are overwritten by scripts/seed-dev.mjs.

INSERT INTO flats (flat, floor, paise_tag) VALUES
  ('4A', 4, 4), ('4B', 4, 5), ('4C', 4, 6),
  ('5A', 5, 7), ('5B', 5, 8), ('13A', 13, 21);

INSERT INTO periods (period, rate_per_kg, due_date, late_fee, late_fee_after, status, created_at)
VALUES ('2026-07', 75.00, '2026-08-10', 50, 0, 'open', datetime('now'));

INSERT INTO readings (flat, period, reading, entered_at) VALUES
  ('4A', '2026-07', 5.817, datetime('now')),
  ('4B', '2026-07', 2.940, datetime('now')),
  ('5B', '2026-07', 4.221, datetime('now'));
