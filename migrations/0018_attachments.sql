-- Files hanging off a notice or a comment.
--
-- WHAT THIS IS FOR. The committee's real documents — the AGM agenda, three
-- waterproofing quotes, the audited accounts — currently reach residents as
-- WhatsApp forwards that are unfindable a week later. A notice that cannot
-- carry its own paperwork sends people back to WhatsApp, which is the thing
-- this portal exists to replace. Residents get the same on comments, because
-- "the pipe over my parking slot leaks" is a photo, not a paragraph.
--
-- ONE TABLE, TWO PARENTS. notice_id and comment_id, exactly one of which is
-- set. The alternative — a table each — duplicates the upload path, the R2
-- key rules, the delete path and the size caps, and those are precisely the
-- things that must not drift apart. The CHECK enforces the exclusivity that
-- the two nullable columns would otherwise leave to whoever writes the insert.
--
-- SOFT DELETE, AS WITH PROOFS (0001). r2_key is nulled and deleted_at is
-- stamped, and the row survives with its uploader. An admin hiding a
-- resident's photo must leave a trace: moderation that erases the evidence of
-- itself is indistinguishable from a bug, and the committee has to be able to
-- answer "what happened to my attachment" a month later.
--
-- BYTES IS RECORDED because R2 will not be asked. The board shows a size
-- against each file so a resident on mobile data can decide before tapping,
-- and a per-parent quota can be counted with SQL rather than a bucket listing.
CREATE TABLE attachments (
  id           INTEGER PRIMARY KEY,
  notice_id    INTEGER REFERENCES notices(id),
  comment_id   INTEGER REFERENCES comments(id),
  r2_key       TEXT,                          -- nulled on delete, row retained
  filename     TEXT NOT NULL,                 -- as the uploader named it
  content_type TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  uploaded_by  INTEGER NOT NULL REFERENCES owners(id),
  created_at   TEXT NOT NULL,
  deleted_by   INTEGER REFERENCES owners(id),
  deleted_at   TEXT,
  CHECK ((notice_id IS NULL) <> (comment_id IS NULL))
);

-- Both lookups are "everything hanging off this parent", which is how the
-- notice view and the thread view read them.
CREATE INDEX ix_attachments_notice ON attachments(notice_id) WHERE notice_id IS NOT NULL;
CREATE INDEX ix_attachments_comment ON attachments(comment_id) WHERE comment_id IS NOT NULL;
