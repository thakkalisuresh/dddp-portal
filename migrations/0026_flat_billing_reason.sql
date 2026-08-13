-- Why a flat stopped being billed, kept ON THE FLAT.
--
-- `flats.active` already carried the fact and the audit log already carried the
-- reason, but those are different places and only one of them is readable from
-- a screen. "Why has 12F not been billed since August" should be answerable by
-- looking at 12F, not by searching an audit trail — the committee turns over at
-- every AGM and the person asking will not be the person who decided.
--
-- Two categories are deliberately NOT stored here, because they are already
-- derivable and a stored copy would be a second truth to keep in step:
--
--   unsold  -> the flat has no active owner
--   vacant  -> the flat has an active owner, and nobody living there
--
-- Both bill nothing and neither takes a reading. The difference is who to talk
-- to, which the owners table already answers.
ALTER TABLE flats ADD COLUMN inactive_reason TEXT;
ALTER TABLE flats ADD COLUMN inactive_since  TEXT;
