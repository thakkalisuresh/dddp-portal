-- How many logins one flat can hold: three owners, two tenants.
--
-- A jointly owned flat is ordinary here, and a couple renting should not have
-- to share one password to see what they owe. So a flat is not one account per
-- party — it is a HOUSEHOLD of up to three owner logins, and separately up to
-- two tenant ones. Five accounts, at the most, on any flat.
--
-- WHY A TRIGGER AND NOT A UNIQUE INDEX. A partial unique index can say "one
-- active owner per flat" and nothing else; it cannot count to three. A CHECK
-- constraint sees only the row in front of it and cannot count at all. The
-- limit is a count over sibling rows, and in SQLite that is a trigger.
--
-- The application refuses this first, with a sentence an admin can act on (see
-- roomFor in functions/lib/tenancy.js and DDP-ADMIN-021). This is the backstop
-- for the paths that do not go through that check — the roster import, a
-- future endpoint, a hand-written UPDATE at 2am. A trigger aborts the whole
-- statement, so a batch that would overfill a flat writes nothing.
--
-- ADMINS DO NOT COUNT. A committee member is an owner living in a flat like
-- anybody else, and a jointly owned flat whose three owners include the
-- treasurer must still be able to register all three. The cap is about how
-- many households the building recognises, not about roles.
--
-- Nothing to backfill: production holds 99 empty flats and one account, and no
-- flat anywhere has ever had more than one active row per party. If that ever
-- stops being true, this migration will fail loudly on the row that breaks it,
-- which is the correct outcome for a rule about who lives where.

CREATE TRIGGER owners_household_limit_insert
BEFORE INSERT ON owners
WHEN NEW.active = 1 AND COALESCE(NEW.role, 'owner') = 'owner'
 AND (SELECT COUNT(*) FROM owners
       WHERE flat = NEW.flat
         AND relationship = NEW.relationship
         AND active = 1
         AND COALESCE(role, 'owner') = 'owner')
     >= CASE NEW.relationship WHEN 'tenant' THEN 2 ELSE 3 END
BEGIN
  SELECT RAISE(ABORT, 'flat already holds as many logins of that party as it can');
END;

-- The same limit on the way IN through an update: reactivating a departed
-- resident, moving somebody to another flat, or turning an owner into a
-- tenant. Without this the insert trigger is a formality — every one of those
-- is a way to arrive at a fourth owner without inserting a row.
CREATE TRIGGER owners_household_limit_update
BEFORE UPDATE OF active, flat, relationship, role ON owners
WHEN NEW.active = 1 AND COALESCE(NEW.role, 'owner') = 'owner'
 AND (OLD.active = 0 OR OLD.flat <> NEW.flat OR OLD.relationship <> NEW.relationship
      OR COALESCE(OLD.role, 'owner') <> 'owner')
 AND (SELECT COUNT(*) FROM owners
       WHERE flat = NEW.flat
         AND relationship = NEW.relationship
         AND active = 1
         AND COALESCE(role, 'owner') = 'owner'
         AND id <> NEW.id)
     >= CASE NEW.relationship WHEN 'tenant' THEN 2 ELSE 3 END
BEGIN
  SELECT RAISE(ABORT, 'flat already holds as many logins of that party as it can');
END;
