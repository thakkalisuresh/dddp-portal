-- A replaced meter, recorded rather than fought with.
--
-- THE PROBLEM. A new meter starts at zero, so the first reading off it is
-- legitimately LOWER than last month's. Meters do not run backwards, so the
-- grid refuses the value and generation refuses a partial month — which means
-- one flat's plumber froze billing for all 99, with no way out of it through
-- any screen the portal has. diagnostics.js has named this case since it was
-- written ("either a typo, or the meter was replaced and needs its own note");
-- the note is this table.
--
-- WHY NOT JUST EDIT THE READINGS. Because the archive is the point. `readings`
-- is what a resident checks their own meter against and what god mode shows a
-- committee three years later; rewriting history to make one month's
-- arithmetic work would silently restate every month before it. The readings
-- stay exactly as they were taken. The changeover sits beside them and is
-- consulted for one month only.
--
-- THE ARITHMETIC. For the month a meter is swapped, the gas used is the sum of
-- two segments — what the old meter counted before it came off, plus what the
-- new one has counted since:
--
--     (old_final - previous_reading) + (this_month_reading - new_start)
--
-- new_start is almost always 0 and is stored anyway, because "almost always"
-- is not a thing to hardcode into somebody's bill.
--
-- BACKDATED ON PURPOSE. The caretaker reads the meters and mentions the swap
-- afterwards, sometimes weeks afterwards. changed_on is therefore a date the
-- superadmin types, not the moment the row was created — which is why both
-- dates are kept.
CREATE TABLE meter_changes (
  flat        TEXT NOT NULL REFERENCES flats(flat),
  -- The USAGE month whose consumption spans the swap, matching readings.period.
  period      TEXT NOT NULL REFERENCES periods(period),
  changed_on  TEXT NOT NULL,              -- when the meter was actually swapped
  old_final   REAL NOT NULL,              -- last reading off the meter removed
  new_start   REAL NOT NULL DEFAULT 0,    -- what the replacement started at
  note        TEXT,
  entered_by  INTEGER REFERENCES owners(id),
  entered_at  TEXT NOT NULL,
  -- One swap per flat per month. A second meter in the same month is rare
  -- enough that it should be a conversation, not a silent second row that
  -- quietly changes what a bill means.
  PRIMARY KEY (flat, period)
);
