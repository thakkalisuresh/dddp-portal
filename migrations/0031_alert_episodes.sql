-- Alert suppression, remembered somewhere that survives the request.
--
-- The cap it replaces lived in a module-level object in functions/lib/errors.js:
--
--   const alertWindow = { start: 0, count: 0, suppressed: false };
--
-- That is per Worker ISOLATE. Cloudflare starts and discards isolates whenever
-- it likes, so the counter reset at moments nobody could predict and the "8 per
-- minute" ceiling was never really eight — it was eight per isolate, per
-- minute, across however many isolates happened to be serving. A burst could
-- send far more than the cap or, on one long-lived isolate, silently swallow
-- alerts long after the incident that filled the window.
--
-- Keyed by CODE rather than counting globally. A global bucket lets one noisy
-- code exhaust the budget and hide a different, more serious one behind it —
-- which is the specific failure worth designing against here, given that a
-- blurry screenshot and a dead vision provider both pass through this path.
--
-- suppressed is carried so the next alert that does go out can say how many
-- occurrences it stands for, rather than the burst vanishing.
CREATE TABLE IF NOT EXISTS alert_episodes (
  code        TEXT PRIMARY KEY,
  -- Stamped ONLY when Telegram acknowledged the send. A failed delivery that
  -- recorded a notification would start a cooldown for a problem nobody has
  -- been told about — silence built on top of silence.
  notified_at TEXT,
  suppressed  INTEGER NOT NULL DEFAULT 0
);
