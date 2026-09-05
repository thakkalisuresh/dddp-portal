-- One-tap password reset: an opaque link token alongside the typed code.
--
-- The resident still gets the six digits and can still type them. This adds a
-- second way through the same reset: a link carrying a random token that maps
-- back to this row. Both end at the same place, both are spent by the same
-- `used_at`, and neither is usable once the other has been.
--
-- THE TOKEN IS NOT THE CODE, AND THE CODE IS NEVER IN A URL. A six-digit code
-- in a query string would sit in browser history, in the Referer header sent
-- to anything the landing page loads, and in every proxy log between the
-- resident and Cloudflare. This column exists so the convenient path and the
-- credential are different secrets.
--
-- Stored as a bare SHA-256 rather than PBKDF2 like `code_hash`. That is not an
-- oversight: the code is six digits and needs a slow hash because it is
-- brute-forceable by construction, whereas this token is 32 random bytes and
-- guessing it is not a threat anybody can mount. A fast hash is also what
-- makes it a usable lookup key -- a per-row salt would mean scanning the table
-- to find which row a link belongs to.
ALTER TABLE password_resets ADD COLUMN link_hash TEXT;

-- The lookup a link performs, and the uniqueness that stops two rows ever
-- claiming one token. Partial, because every row predating this migration --
-- and every code-only reset after it -- has NULL here, and SQLite would treat
-- those NULLs as distinct anyway; the partial index says so explicitly and
-- keeps the index to the rows that can actually be looked up.
CREATE UNIQUE INDEX ix_resets_link ON password_resets(link_hash)
  WHERE link_hash IS NOT NULL;
