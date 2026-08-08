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
