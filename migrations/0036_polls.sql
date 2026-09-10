-- Polls: a question the committee puts to the building, answered once per flat.
--
-- Design and the reasoning behind every choice: docs/POLLS-PLAN.md. What
-- follows is only what the schema itself has to justify.
--
-- WHY THREE TABLES AND NOT A THIRD NOTICE KIND. The cheap move was
-- `kind = 'poll'` on `notices`, which already carries scope, comments,
-- attachments, the unread badge and the nightly Drive document. It was rejected
-- twice over: `notices.kind` has CHECK (kind IN ('notice','event')), so
-- widening it means rebuilding the most-read table in the schema (see 0030 for
-- what that costs), and every poll would then carry `body` and `event_date`
-- columns that do not describe it. Three small tables cost less and keep
-- `notices` about text.
--
-- WHY A POLL IS ADVISORY. There is no quorum column and there will not be one.
-- A decision needing a quorum is an AGM resolution, which has its own rules and
-- its own minutes; a portal that can be mistaken for one is worse than a portal
-- that plainly is not.

CREATE TABLE polls (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,

  -- Single choice, or multi-select with a ceiling. An UNBOUNDED multi-select
  -- was rejected: a flat that ticks every option has abstained while appearing
  -- to participate, and the result flattens into nothing.
  multi         INTEGER NOT NULL DEFAULT 0,
  max_choices   INTEGER,

  -- WHO MAY WATCH, WHICH IS NOT WHO MAY VOTE. This is the one rule polls cannot
  -- borrow from the notice board. A notice asks one question and `scope`
  -- answers it. A poll asks two, and they come apart: voting is the owner's on
  -- every poll, always, while whether a tenant may READ this one is the
  -- committee's choice. One flag for both would make "let the tenants see it"
  -- silently mean "let the tenants vote", which is the thing being avoided.
  show_tenants  INTEGER NOT NULL DEFAULT 0,

  opens_at      TEXT NOT NULL,
  closes_at     TEXT NOT NULL,

  -- Set when the poll actually closed, which may be EARLIER than closes_at
  -- because the creator or an admin ended it. Closing is evaluated on read —
  -- the crons run three times a day and cannot express "closes at 6pm" — so
  -- this column is the record of the fact, not the mechanism that produces it.
  -- Nothing reopens a poll: revealing the count to the committee and then
  -- allowing more votes is the one action that would make this untrustworthy.
  closed_at     TEXT,

  -- Closing shows the count to the committee. Publishing shows it to residents.
  -- Two acts on purpose, so the committee can see a result before deciding
  -- whether announcing it helps.
  published_at  TEXT,

  -- The midpoint of the poll's own life: created + (closes - created) / 2. A
  -- 48-hour poll reminds at 24, a fortnight's poll reminds after a week. Stored
  -- rather than recomputed so that editing closes_at cannot silently move a
  -- reminder that has already gone out.
  reminder_at   TEXT,
  reminded_at   TEXT,

  created_by    INTEGER NOT NULL REFERENCES owners(id),
  created_at    TEXT NOT NULL,

  CHECK (multi IN (0,1)),
  CHECK (show_tenants IN (0,1)),
  -- A ceiling only means something on a multi-select, and a multi-select
  -- without one is the abstention-shaped result described above.
  CHECK ((multi = 0 AND max_choices IS NULL)
      OR (multi = 1 AND max_choices >= 1))
);

CREATE INDEX ix_polls_open ON polls(closed_at, closes_at);

-- The options are rows, not a JSON array on the poll.
--
-- A vote points at an option, and a pointer needs something stable to point at.
-- Stored as JSON, reordering the array would silently repoint every vote
-- already cast — the failure that looks like working code right up until
-- somebody edits the poll.
--
-- Options FREEZE once the first vote is cast; that rule lives in lib/polls.js
-- rather than here, because "has anybody voted yet" is a question about another
-- table and a CHECK cannot ask it.
CREATE TABLE poll_options (
  id       INTEGER PRIMARY KEY,
  poll_id  INTEGER NOT NULL REFERENCES polls(id),
  label    TEXT NOT NULL,
  sub      TEXT,
  sort     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX ix_poll_options ON poll_options(poll_id, sort);

-- THE SUBJECT IS THE FLAT, NOT THE PERSON, and that is the whole of "one vote
-- per flat" — enforced by the database rather than by whoever writes the
-- handler. Two owners of one flat share one vote; the last to cast holds the
-- flat's answer.
--
-- `cast_by` is kept because the flat is not who a disputed count asks about.
-- With two owners able to vote, "which of them cast it" is the question, and it
-- is the reason the superadmin's ballot is worth having at all. The
-- resident-facing screen speaks of the flat; the ballot speaks of the person;
-- both are true.
--
-- A FLAT SOLD MID-POLL keeps its vote, and the incoming owner sees it as their
-- flat's. They can change it, because the vote belongs to the flat. The ballot
-- still names whoever actually cast it.
--
-- UNIQUE (poll_id, flat, option_id) rather than (poll_id, flat), because a
-- multi-select flat legitimately holds several rows. The ceiling on how many is
-- counted in lib/polls.js, where max_choices can be read.
--
-- Changing a vote is delete-then-insert inside ONE D1 batch, so a flat is never
-- briefly holding two contradictory answers or none at all.
CREATE TABLE poll_votes (
  id         INTEGER PRIMARY KEY,
  poll_id    INTEGER NOT NULL REFERENCES polls(id),
  flat       TEXT NOT NULL,
  option_id  INTEGER NOT NULL REFERENCES poll_options(id),
  cast_by    INTEGER NOT NULL REFERENCES owners(id),
  cast_at    TEXT NOT NULL,
  UNIQUE (poll_id, flat, option_id)
);

CREATE INDEX ix_poll_votes_poll ON poll_votes(poll_id);

-- The outbox, exactly as 0033 does it for bills, and for the same arithmetic:
-- sendEmail refreshes an OAuth token per call, so a naive loop is two
-- subrequests per message against a 50-subrequest cap. Queue here, drain 20 at
-- a time with one token.
--
-- ONE ROW PER RECIPIENT PER KIND. `kind` distinguishes the three moments a poll
-- writes to somebody — it opened, it is halfway and you have not voted, the
-- result is out — and the PRIMARY KEY makes each of them once-only. A drain
-- that runs twice, or a cron landing on a poll an admin is already draining,
-- cannot mail the same owner about the same moment again.
--
-- OWNERS ONLY, decided with the rest: an email is a call to act, and a tenant
-- who may watch but not vote should not be asked to do anything.
CREATE TABLE poll_mail (
  poll_id    INTEGER NOT NULL REFERENCES polls(id),
  owner_id   INTEGER NOT NULL REFERENCES owners(id),
  kind       TEXT NOT NULL,     -- opened | reminder | result
  status     TEXT NOT NULL,     -- queued | sent | unreachable | failed
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  queued_at  TEXT NOT NULL,
  sent_at    TEXT,
  PRIMARY KEY (poll_id, owner_id, kind),
  CHECK (kind IN ('opened','reminder','result')),
  CHECK (status IN ('queued','sent','unreachable','failed'))
);

CREATE INDEX ix_poll_mail_queued ON poll_mail(status, poll_id);
