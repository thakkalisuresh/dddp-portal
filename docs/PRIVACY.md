# What the portal records, and what it deliberately does not

This is a residents' portal for 99 flats. The people running it live in the
same building as the people it records. That asymmetry is worth being explicit
about.

(This said "52 households" until 2026-08-12, a figure that predates the
building model in `functions/lib/building.js` and had been copied into
`docs/COSTS.md` as well. 99 is what the `flats` table holds and what the roster
import validates against.)

## What is recorded

| Table | Contents |
|---|---|
| `audit_log` | Every server-side action: logins, logouts, password changes and resets, readings saved, bills generated, charges edited, payment intents, proof uploads, approvals and rejections, comments, moderation, notices, role changes, flat transfers, impersonation start and end. Records the **real actor** and the **subject** separately. |
| `activity` | Page views and browser errors — the part of a session the server cannot see. |
| `error_log` | Every failure, by code. |

All timestamps are stored in UTC and displayed in **IST**, because the people
reading them are in Kerala.

## What is deliberately not recorded

### Navigation is recorded; clicking is not

The distinction is between *where someone went* and *how they moved a mouse*.

Recorded: every page opened, every tab switched to inside the admin console,
every notice opened, every time the activity log itself is read. A superadmin
can reconstruct the shape of any session — which screens, in what order, at
what time, to the second.

Not recorded:

**Scrolls, keystrokes, mouse movement, dwell time.** Never recorded.

**Clicks — only while deliberately switched on.** Click capture exists because
"the button doesn't work for me" is otherwise unanswerable. It is a plain
on/off switch, on until someone turns it off:

- only the superadmin can switch it on, and only they can read the results
- the state is shown on the god page every time it is opened
- switching it on or off is written to the audit log
- the server re-checks the switch on every batch, so it stops the moment it is turned off
- click rows are pruned after 30 days regardless, and live in their own table

An optional expiry window is still supported by the API if a timed capture is
ever wanted, but the default is a plain switch.

**What a click records:** the element (`button#approve.btn`), its visible label
(`"Approve"`), and the page. **Never a field value.** An input contributes its
identity only, and a field that looks like a credential — password, PIN, OTP,
token — is dropped entirely, not merely blanked. Typed values are not even sent
from the browser.

**Anything about non-residents.** The public site records contact-form
submissions and nothing else. There is no analytics script, no third-party
tag, and no font CDN request.

## Who can read it

Reading the activity log is itself logged (`god:timeline`), including which
resident was being filtered for. Someone browsing residents' activity leaves
the same trail as anyone else.

The full timeline is **superadmin only**. Admins see the operational screens
they need — readings, proofs, residents, notices — but not a per-resident
activity trail.

Every admin view of a payment screenshot is itself written to `audit_log`, so
looking at a resident's financial documents is a recorded act.

## Where this data leaves Cloudflare

Added 2026-08-12. Until then this document described what is recorded and who
inside the portal can read it, and said nothing about the three routes by which
resident data leaves the account entirely — which is the half a resident would
actually ask about.

**Nightly, to a committee member's personal Google Drive.** The 3:30 IST backup
uploads the full CSV bundle plus payment screenshots and notice attachments.
That bundle carries every resident's **name, mobile, email and payment
history**. It never carries passwords or password hashes — `NEVER_EXPORT` in
`lib/backup.js` is what enforces that, and it is a list worth checking before
adding a column to `owners`.

The account is deliberately personal rather than the association's, because
Drive charges a file to whoever creates it and the association's 15 GB is wanted
for its own documents (B12). The consequence belongs here rather than only in
the backlog: **one named committee member is holding the association's records
in a personal account.** When they leave the committee that is an account to
replace, not a folder to hand over — re-run `npm run google:auth -- backup` as
the new holder, which re-points the upload without moving anything.

**To Telegram, on alerts and the morning digest.** One shared committee chat,
via `postToTelegram`. It carries error codes, counts and the fact that something
needs attention. It is deliberately kept clear of resident contact details: the
contact-change notification (B22) says a request is waiting and who raised it,
and does **not** carry the new number or address, because that chat is a wider
audience than the console and nothing in it can be recalled.

**To Gmail, when a resident recovers their account.** `/forgot` mails a
six-digit code to the address on file. A code rather than a link, because a link
in an inbox is a bearer token that outlives its use and mail scanners follow
links and consume them. This route is **not live yet** — it needs the
association Gmail (W1) — and the From line must be the association's, so
resident-facing mail deliberately does not use the personal backup account.

**And the one that is not a route at all:** the reconciliation statement. The
bank statement's PDF text layer is read inside the Worker and never posted to
the vision provider, because the alternative is mailing every member's payment
history to a third party. The file itself is deleted on finish and never
stored. Screenshot OCR (`GROQ_API_KEY` / `GEMINI_API_KEY`) is optional, applies
to payment screenshots only, and is never a gate on paying a bill.

There is still no analytics script, no third-party tag, and no font CDN
request.

## Retention

Payment screenshots are deleted after 24 months; the image hash and UTR are
kept, because losing those would destroy the duplicate detection that stops an
old screenshot being resubmitted.

`activity` rows are the highest-volume and lowest-value data here. Prune them
on a schedule; nothing depends on them beyond recent debugging.

## Who administers, and getting back in

There is exactly **one superadmin**. The role cannot be copied — a second one
cannot be promoted and the sole holder cannot be demoted, so it can only be
*moved*, in one atomic step, which makes the outgoing holder an admin.

Admins are a separate, plural role: appoint and remove them freely at an AGM.
They run the building — readings, bills, proofs, residents, notices — and
**cannot** see the activity log, click capture, view-as or impersonation.

**Break-glass.** With a single superadmin there is no in-app recovery if that
account is lost. The recovery path is direct database access from the
Cloudflare account that owns the deployment:

```bash
npx wrangler d1 execute dddp --remote \
  --command "UPDATE owners SET role='superadmin' WHERE mobile='<number>'"
```

Whoever controls the Cloudflare account controls the portal. Keep that account
recoverable — it is the real root credential, not any password in this system.

## Ownership changes

Bills and payment proofs belong to the **person**, not the flat. When a flat is
sold, the incoming owner cannot see the previous owner's bills or open their
receipts, and the outgoing owner loses access immediately. Meter readings are
a property fact and do carry across.

## Break-glass recovery

The superadmin has nobody above them, so a forgotten password is recovered by
whoever holds the Cloudflare credentials:

```
node scripts/reset-my-password.mjs
```

The password is typed with echo off, hashed on that machine, and only the
PBKDF2 hash reaches D1 — never an argument, never in shell history, never in a
file that outlives the run. The script refuses to proceed unless the number
matches an actual superadmin, and reads the hash back afterwards rather than
trusting the write. Every use writes a `password.breakglass` audit row and
signs out every existing session, because a forgotten password and a stolen one
look identical from here.
