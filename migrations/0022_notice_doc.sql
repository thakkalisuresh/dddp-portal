-- The Drive document for this notice, and a fingerprint of what it says.
--
-- WHY A SIGNATURE RATHER THAN A TIMESTAMP. A notice gains comments for weeks
-- after it is posted, and the PATCH that edits a title or body writes no
-- updated_at — there is nothing on this table to compare against. Rewriting
-- every notice every night would churn a hundred Drive files to record that
-- nothing happened. Hashing what actually goes INTO the document answers the
-- right question, including the one a timestamp misses entirely: a comment
-- hidden by a moderator changes the document without changing any created_at.
--
-- WHY THE FILE ID IS KEPT. A notice's document is rewritten in place as its
-- thread grows. Uploading a fresh file each time would leave a folder holding
-- six versions of one notice with no way to tell which is current; Drive keeps
-- its own revision history, which is a better archive than six duplicates.
-- If the id stops resolving because somebody deleted the doc, the next run
-- creates a new one rather than failing.
ALTER TABLE notices ADD COLUMN backup_doc_id TEXT;
ALTER TABLE notices ADD COLUMN backup_sig TEXT;
