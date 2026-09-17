-- Who is signed in, on what, and whether they are here now.
--
-- A session row lasts 90 days, so "has a live session" is nearly everyone who
-- has ever logged in, and says nothing about who is using the portal this
-- minute. The god-mode sign-in panel needs both, per device, so that signing
-- out one phone does not have to mean signing out all of them.
--
--   user_agent    written once, at login. Shown as "phone · Android 14 ·
--                 Chrome 128" so the superadmin can tell two devices apart.
--   last_seen_at  written by every presence report from an open page (about
--                 every 90 seconds while it is in front), and by ordinary API
--                 requests at most once every five minutes.
--   presence      'online' | 'away' | 'gone' — the last thing the page said:
--                 in front, in the background, or closed. See
--                 functions/lib/presence.js.
--
-- All three are nullable and the code reads them with s.*, so the Worker keeps
-- working whichever of this migration and the deploy lands first. Rows that
-- predate it show "device not recorded" until the person next logs in.
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
ALTER TABLE sessions ADD COLUMN presence TEXT
  CHECK (presence IS NULL OR presence IN ('online','away','gone'));
