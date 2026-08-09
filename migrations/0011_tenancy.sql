-- Owners and tenants.
--
-- ONE column, not three. The obvious modelling is owner_resident /
-- owner_absent / tenant, but "absent" is not a fact about a person — it is
-- what you get when someone else occupies their flat. Storing it separately
-- means storing the same truth twice, and the two copies drift: a tenant moves
-- out, nobody flips the owner back to resident, and the owner silently stops
-- being billed.
--
-- So relationship is just owner or tenant, and everything else is derived:
--
--   flat has a tenant      -> the tenant occupies and is billed,
--                             the owner is absent and sees amounts only
--   flat has no tenant     -> the owner occupies and is billed
--
-- One query answers "who pays for 4B" and it cannot disagree with itself.
--
-- Liability does not need a column either. The owner of a flat is the active
-- row for that flat with relationship = 'owner', so a tenant who leaves owing
-- money resolves to their landlord without a foreign key that can go stale
-- when either party changes.
ALTER TABLE owners ADD COLUMN relationship TEXT NOT NULL DEFAULT 'owner';

-- Departure is already handled: `active = 0` and login refuses it, which is
-- the "no access whatsoever" rule. History stays for admin and god because
-- rows are deactivated, never deleted.

-- Finding the occupant, or the landlord, for a flat is the hot path for every
-- bill and every dashboard.
CREATE INDEX ix_owners_flat_rel ON owners(flat, relationship, active);
