-- Store every mobile number in E.164, with the country code.
--
-- Several owners are settled abroad, so a bare 10-digit Indian assumption is
-- wrong. But a MIXED store is worse than either format on its own, and that is
-- what god edits introduced: a number saved through the new path became
-- '+919567791515' while the seeded rows stayed '9567791515'.
--
-- Two things broke immediately, both found by exercising the endpoints rather
-- than by reading the code:
--
--   * The UNIQUE constraint on mobile stopped protecting anything, because the
--     two spellings of one number are different strings. Two accounts ended up
--     sharing a login number.
--   * Login compares a stripped-digits input against the stored value, so any
--     owner already converted to E.164 could not log in at all.
--
-- So the format has to be uniform, and login has to normalise the same way —
-- see normaliseMobile in lib/godedit.js, which login now uses.
--
-- 10 digits is read as Indian; anything already carrying '+' is left alone.
-- Nothing here invents a country code for a number that is neither, so if this
-- leaves a row unconverted that row was already unusable as a login.
UPDATE owners
   SET mobile = '+91' || mobile
 WHERE mobile NOT LIKE '+%'
   AND length(replace(replace(replace(mobile, ' ', ''), '-', ''), '.', '')) = 10;

UPDATE owners
   SET mobile = replace(replace(replace(mobile, ' ', ''), '-', ''), '.', '')
 WHERE mobile <> replace(replace(replace(mobile, ' ', ''), '-', ''), '.', '');
