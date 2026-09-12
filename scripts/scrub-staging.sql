-- Strip every resident's personal data out of a freshly imported staging copy.
--
-- Applied by scripts/staging-refresh.mjs immediately after the data load, and
-- kept as its own file rather than buried in that script because
-- staging-refresh said so itself: "if one is wanted it belongs after the
-- import, as its own SQL file, so it can be reviewed rather than buried in
-- this script." This is that file. What a scrub leaves behind is a privacy
-- decision, and a privacy decision belongs somewhere a person can read it.
--
-- WHY THIS IS NEEDED AT ALL. `npm run staging:refresh` copies production
-- wholesale: 99 residents' names, mobiles, emails, payment history, bank
-- statement references, and the ballots of every poll they have voted in. It
-- lands in a database whose entire purpose is that it is disposable — the one
-- everybody feels free to break, point a half-finished migration at, or hand
-- to a script they have not finished reading. Those two facts do not belong in
-- the same database.
--
-- WHAT IS DELIBERATELY *NOT* SCRUBBED, because staging exists for one job.
-- `bills`, `readings`, `periods`, `meter_changes` and the reminder and
-- announcement outboxes are untouched. Staging's stated purpose in
-- wrangler.toml is rehearsing the late-fee cron — the only cron that moves
-- money — and that wants real bill totals, real due dates, real statuses and a
-- real record of who has already been told. None of that needs anybody's name.
-- Identity is exactly the part no cron reads, which is why it can all go.
--
-- ONE JUDGMENT CALL, recorded rather than hidden: `notices` bodies survive.
-- They are committee-authored and posted to the whole building by design, so
-- they are not a resident's personal data in the way a comment is. A notice
-- naming a specific flat's arrears is the edge case; if that starts happening,
-- scrub them too and this comment is the reason to revisit.
--
-- MOBILE NUMBERS ARE REWRITTEN, NOT BLANKED, because `owners.mobile` is the
-- login id and carries a UNIQUE index. Derived from the row's own id so the
-- result is unique by construction. If a generated number ever collided with a
-- real one the UNIQUE index aborts the whole statement — which fails loudly and
-- leaves a database that is obviously unscrubbed, rather than half-scrubbed and
-- plausible. That is the right direction to fail in.
--
-- NOBODY CAN LOG IN TO STAGING AFTER THIS, on purpose. Password material is
-- overwritten with a value that is not valid base64, so verification refuses
-- every account rather than accepting a shared password that a copy of the real
-- building would make guessable. Cron rehearsal needs no login; UI work is done
-- locally against `npm run seed`. To get a real session here deliberately, give
-- an account a password on purpose — see the note in staging-refresh.mjs.

-- ── credentials: deleted outright, never rewritten ──────────────────────────
-- sessions.token IS the credential — the primary key is the live token, not a
-- hash of one — so a copy of this table is a copy of every current login. The
-- reset tables are the same call, and password_history is a table of nothing
-- but credentials.
DELETE FROM sessions;
DELETE FROM password_resets;
DELETE FROM password_history;

-- ── ballot secrecy ──────────────────────────────────────────────────────────
-- The one table this schema treats as more sensitive than payment data: it
-- records who voted for what. backup.js will not even export it while a poll
-- is open. A copy of it in a disposable database defeats all of that, and no
-- cron rehearsal needs it — poll closing and reminder sweeps work off `polls`.
DELETE FROM poll_votes;
DELETE FROM poll_mail;

-- ── volatile logs: no value here, and they carry the most incidental data ───
-- User agents, client error detail, per-page trails and the mobile numbers
-- typed at a login prompt. These are pruned on a retention clock in production
-- precisely because they are invasive; copying them into staging would park
-- them somewhere with no retention clock at all. They are also in
-- NEVER_BACKUP — but a D1 export is the whole database, not backup.js's table
-- list, so they arrive here regardless.
DELETE FROM activity;
DELETE FROM click_log;
DELETE FROM error_log;
DELETE FROM login_attempts;
DELETE FROM message_attempts;

-- The public contact form: a name, an email, a phone and free text from
-- somebody who may not even be a resident. Nothing rehearses against it.
DELETE FROM messages;

-- ── residents: rewritten in place, so every foreign key still resolves ──────
-- Rewritten rather than deleted because `bills`, `readings` and the outboxes
-- all point at these rows, and deleting them would take the very data staging
-- exists to exercise.
UPDATE owners SET
  name   = 'Resident ' || flat,
  mobile = '+919' || printf('%09d', id),
  email  = 'resident' || id || '@example.invalid',
  -- Not valid base64, so crypto.js refuses it rather than treating it as a
  -- hash it can compare against.
  pw_hash = 'scrubbed-not-a-hash',
  pw_salt = 'scrubbed-not-a-salt',
  -- Free text an admin typed, which is where a person's circumstances end up.
  late_fee_exempt_reason = CASE
    WHEN late_fee_exempt_reason IS NULL THEN NULL ELSE '[scrubbed]' END;

-- The committee page publishes the treasurer's real number. Harmless to read,
-- but a staging deploy that ever sends anything should not have a real phone
-- number within reach of it.
UPDATE committee SET phone = NULL WHERE phone IS NOT NULL;

-- ── resident-authored and bank-sourced text ─────────────────────────────────
-- Comments are written by residents about their building. The thread structure
-- is what any rehearsal cares about, not the words.
UPDATE comments SET body = '[scrubbed]';

-- The requested_value IS a mobile number or an email address — that is the
-- whole point of the table — and `reason` is free text about why it changed.
UPDATE contact_requests SET
  requested_value = '[scrubbed]',
  reason = CASE WHEN reason IS NULL THEN NULL ELSE '[scrubbed]' END;

-- Bank statement rows: `narration` and `reference` come straight off the
-- association's account and routinely carry payer names and UPI handles.
UPDATE statement_credits SET reference = '[scrubbed]', narration = '[scrubbed]';
UPDATE statement_sessions SET filename = 'scrubbed.csv';
UPDATE reconciliations SET reference = CASE
  WHEN reference IS NULL THEN NULL ELSE '[scrubbed]' END;

-- A UTR is a bank transaction reference tied to a named account. The r2_key is
-- nulled because staging binds the staging bucket, so these keys point at
-- objects it cannot read — a null says "no image" honestly, where a live-looking
-- key that 404s reads as a bug worth chasing.
UPDATE payment_proofs SET
  utr = CASE WHEN utr IS NULL THEN NULL ELSE 'SCRUBBED' || id END,
  r2_key = NULL;

-- Attachment filenames are chosen by whoever uploaded them, and the keys point
-- into the production bucket for the same reason as above.
UPDATE attachments SET
  filename = 'scrubbed-' || id,
  r2_key = NULL,
  thumb_key = NULL;

-- ── the audit trail ────────────────────────────────────────────────────────
-- Kept as rows, emptied of detail. `audit_log.detail` records the before and
-- after of god edits, which is exactly where old mobile numbers and previous
-- names live. The action and the timestamp are what makes the trail's SHAPE
-- testable; the payload is not needed to test it.
UPDATE audit_log SET detail = CASE
  WHEN detail IS NULL THEN NULL ELSE '[scrubbed]' END;

-- Watermarks copied from production would tell staging's own health checks
-- that a backup and a digest had just run here. They have not.
DELETE FROM settings WHERE key IN ('last_backup_at', 'last_digest_at', 'last_archive_at');
