-- Two committee corrections.
--
-- 0003 is left alone on purpose: it has already been applied to the live
-- database, so editing it would only change what a fresh database gets and
-- silently leave production on the old values.
--
-- 1. The Gas In-charge has a name. '13E' was a placeholder because the old
--    portal never published one; it is Hari.
-- 2. Mukesh's number was carried over from the old site and is wrong. The
--    correct one is +91 98464 66511.
UPDATE committee
   SET name = 'Hari'
 WHERE role = 'Gas In-charge' AND flat = '13E';

UPDATE committee
   SET phone = '+91 98464 66511'
 WHERE role = 'Treasurer' AND flat = '13A';
