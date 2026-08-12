-- An admin asks for a resident's mobile or email to be changed; the superadmin
-- approves, and approving is what applies it.
--
-- Backlog B22. Admins lost the power to write these two columns on 2026-08-12,
-- and this is what they got instead. They keep the job that needs somebody in
-- the building — noticing that a number is wrong, and asking the resident — while
-- the write itself needs the one account that cannot use it to take somebody
-- else's login.
--
-- WHY EMAIL IS THE ONE THAT MATTERS. `forgotPassword` finds an account by MOBILE
-- and mails the reset code to the EMAIL on file. An admin who could rewrite the
-- address could point it at an inbox they hold, ask for a reset against the
-- resident's own number, and receive the code — which is exactly the reset that
-- was taken away from them in 0023's sibling change. Mobile is the lockout
-- rather than the takeover: the resident stops being able to log in, but the code
-- still follows the address.
--
-- ITS OWN TABLE, not columns on `owners`, for the reasons 0010 gives about
-- password resets: a request in flight is a separate short-lived fact, several
-- can be raised and abandoned, and who asked for what — with their reason — is
-- worth keeping long after the change itself has been applied. A pending value
-- living on `owners` would also be one careless SELECT away from being read as
-- the resident's actual number.
--
-- THE REASON IS NOT NULLABLE, following the late-fee exemptions in 0016: the
-- committee turns over at every AGM, and "why is 7B's number different" needs an
-- answer somebody can still find in two years. A request with no reason is a
-- request nobody can review, which makes approving it a rubber stamp.
CREATE TABLE contact_requests (
  owner_id        INTEGER NOT NULL REFERENCES owners(id),
  field           TEXT    NOT NULL,      -- 'mobile' | 'email'
  requested_value TEXT,                  -- NULL is legitimate: clearing an email
  reason          TEXT    NOT NULL,
  requested_by    INTEGER NOT NULL REFERENCES owners(id),
  state           TEXT    NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
  decided_by      INTEGER REFERENCES owners(id),
  decided_at      TEXT,
  created_at      TEXT    NOT NULL,
  id              INTEGER PRIMARY KEY
);

-- The console's only real query: what is still waiting, oldest first, because a
-- request that has been ignored for a week is the one worth seeing at the top.
CREATE INDEX ix_contact_requests_pending ON contact_requests(state, created_at);

-- "Has somebody already asked about this flat?" — asked when a request is raised,
-- so two admins chasing the same wrong number do not both file one.
CREATE INDEX ix_contact_requests_owner ON contact_requests(owner_id, state);
