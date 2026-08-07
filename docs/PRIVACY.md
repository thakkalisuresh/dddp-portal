# What the portal records, and what it deliberately does not

This is a residents' portal for 52 households. The people running it live in
the same building as the people it records. That asymmetry is worth being
explicit about.

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

**Individual clicks, scrolls, keystrokes and mouse movement.** Logging those
would mean recording residents' behaviour in fine detail, permanently,
readable by whoever currently holds the superadmin role. The debugging value
is low: "which pages did they open, which actions did they take, which errors
did they hit" answers essentially every real question, and all three of those
are recorded.

If click-level tracking is ever genuinely needed for a specific bug, add it
temporarily and behind a flag — not as a standing default.

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

## Retention

Payment screenshots are deleted after 24 months; the image hash and UTR are
kept, because losing those would destroy the duplicate detection that stops an
old screenshot being resubmitted.

`activity` rows are the highest-volume and lowest-value data here. Prune them
on a schedule; nothing depends on them beyond recent debugging.

## Ownership changes

Bills and payment proofs belong to the **person**, not the flat. When a flat is
sold, the incoming owner cannot see the previous owner's bills or open their
receipts, and the outgoing owner loses access immediately. Meter readings are
a property fact and do carry across.
