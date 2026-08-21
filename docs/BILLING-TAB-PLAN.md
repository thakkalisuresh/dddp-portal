# Implementation plan — the Billing tab

> **Delivered in PR #50 and deployed on 2026-08-20**, migration
> `0033_bill_announcements.sql` applied first. Kept as the record of how it was
> built and what the build had to be careful about — not as outstanding work.
> "Before starting" below describes a working tree that no longer exists; all of
> it has landed.

Written 2026-08-20. The design and its reasoning are in
[BILLING-TAB.md](BILLING-TAB.md); this is how it got built.

**Shape: one change.** `Rates` and `Readings` are replaced together, in a single
PR. No deadline was set — the existing screens keep working until this merges,
so it lands when it is right rather than before October's billing.

## Before starting

Two pieces of work are sitting **uncommitted** in the working tree and this plan
assumes both land first:

* **HTML email** — `functions/lib/email-template.js` and a
  `multipart/alternative` `buildRawMessage`.
* **Per-flat occupancy** — `docs/RESIDENTS-OCCUPANCY.md`, the `occupancy`
  endpoint, `occupancyOf`, `FLAT-BILLED-NO-OWNER`, and the fix that makes
  `generateBills` bind `bills.owner_id` from `occupantOf`.

`npm test` is at **1153 passing**. That is the number to keep green.

Read `docs/RESIDENTS-OCCUPANCY.md` § *What the Billing tab consumes* first. It is
the contract for who is billed, who is liable, and which flats count.

## The one schema change

Migration `0033_bill_announcements.sql`. Everything else this needs already
exists.

```sql
CREATE TABLE bill_announcements (
  bill_id    INTEGER PRIMARY KEY REFERENCES bills(id),
  period     TEXT NOT NULL,
  status     TEXT NOT NULL,     -- queued | sent | unreachable | failed
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  queued_at  TEXT NOT NULL,
  sent_at    TEXT,
  CHECK (status IN ('queued','sent','unreachable','failed'))
);
CREATE INDEX ix_announce_period ON bill_announcements(period, status);
```

**Why a table and not a column on `bills`.** The row is the idempotency record.
One per bill, `PRIMARY KEY (bill_id)`, so a retried drain cannot send twice —
which is the failure that matters, because the second email arrives at a
neighbour, not at a log file.

**There is no draft table, deliberately.** The draft is the readings plus the
rate, both already stored. Step 3 computes amounts live through
`previewGeneration`. Storing draft bills would mean every resident-facing query
needs a `published_at IS NOT NULL` filter, and the one that gets forgotten shows
somebody a bill nobody agreed to.

## Server

### 1. Publishing

`publishBills(env, period, actorId)` in `functions/lib/admin.js`, wrapping the
existing `generateBills`:

* `generateBills` already refuses a locked period, an absent rate, a partial
  month, and — since the occupancy work — any flat with no `owner_id`
  (`DDP-BILL-015`). Keep all of it.
* Queue one `bill_announcements` row per generated bill **in the same D1 batch**
  as the inserts. A month that is generated but not queued would look published
  and tell nobody.
* Rows for residents with no email are queued as `unreachable`, not `queued` —
  they are the WhatsApp list, and they should never be attempted as sends.

Route: `POST /api/admin/periods/:period/publish`. Any admin, alone.

### 2. Draining the announcements — read this before writing it

**89 emails will not fit in one request.** `sendEmail` calls
`refreshAccessToken` on every send and neither is cached, so a month is ~178
outbound fetches against a **50-subrequest cap** on the Cloudflare free plan.
`remindAll` (`functions/index.js:2603`) has the same latent bug and has survived
only because the overdue list is a handful, never the building.

* `refreshAccessToken` **once** per drain; thread the token through. This needs
  `sendEmail` to accept an optional token — a small, additive change to
  `mailer.js`, and it halves the subrequest count on every bulk path including
  `remindAll`.
* `POST /api/admin/periods/:period/announce` drains **20 at a time** and returns
  `{ sent, failed, remaining }`. The console calls it in a loop with a progress
  bar. Twenty sends plus one token refresh is 21 subrequests, comfortably inside
  the cap with room for the D1 writes.
* The treasurer must be free to close the laptop. The 3am cron sweeps anything
  still `queued`, same drain function, same idempotency.
* A row that fails moves to `failed` with `last_error` and is retried by the
  cron up to three attempts, then left for a human. Never retry a 4xx — the
  reminder path learned this on 2026-08-14, when a locked month retried every
  two seconds and pushed 56 Telegram alerts in a minute.

### 3. Corrections after publish

Two kinds, and **no amount is ever typed**:

* **A reading**, one flat. Existing `bill_edit_requests` machinery, but the
  request carries the corrected reading and the total it produces rather than a
  total somebody chose. Two other admins; every other admin when the bill is an
  admin's own; late fee frozen while it waits.
* **The month's price of gas**, every bill. New request kind at period level.
  **Any admin, two others approve** — decided 2026-08-20, which is a change from
  today's rule where a locked month refuses the rate outright and names the
  superadmin (`DDP-BILL-012`). Reuse `changeRate`'s existing pure impact
  calculation so the approver sees what the requester saw: bills recalculated,
  already-paid bills going back to unpaid, the reconciliation that has to happen
  again.

### 4. Removing amount editing

The rule is **amount is visible, never editable** — for everyone, superadmin
included.

* Drop `'total'` from what `editBill` accepts. Any request for it is refused
  with an error naming the reading and the price as the two routes.
* Remove the amount field from the Bills tab.
* **Leave the `manual_total` column and the code that respects it.** Production
  holds 898 demo bills and dropping a column in SQLite is a table rebuild for no
  benefit. `changeRate` goes on skipping any row that has it.
* Add a doctor check counting rows with `manual_total = 1`, so the number is
  visible and can go to zero. When it does, the column and its guards can be
  removed in a follow-up that costs nothing.

## Client

One tab: `{ id: 'billing', label: 'Billing', render: billingPanel }` in
`TABS` (`public/js/admin-console.js`), replacing the `periods` entry and the
`readings` link. Nine tabs become eight.

**`public/js/admin-billing.js`**, built from
`docs/billing-tab-prototype.html` — which is a working implementation of every
decision, not a mockup, and should be read alongside this plan.

* **Step 1 — the price of gas.** Rate, due date, late fee. The sanity check
  against last month's rate stays; the advice around it does not.
* **Step 2 — readings.** This is `admin-readings.js` moved, **not rewritten.**
  Its autosave, offline queue, retry banner, `beforeunload` guard, progress
  count and per-row validation all come with it. **Lift its comments too** —
  they are the record of what testing already cost, and this prototype
  reproduced two of its fixed bugs by copying its shape without them (the `null`
  children, and the refused row counted as empty).
* **Step 3 — review and publish.** Readings editable, amount never. Outliers,
  the email-coverage gap, and the unbillable-flat blocker. Everything derived
  from the readings repaints from **one** function; three hand-patched fragments
  is how the prototype came to show a button saying 89 above a note saying 88.
* **Published state.** Per-flat reading corrections, the month-wide price
  correction, the announcement progress, and the WhatsApp list.
* **Popups unfold in place.** No overlay, matching `foldedSection`'s reasoning.
* **Ask in the page, never `window.confirm`.** Use `askFirst` from `ui.js`.
  Publishing 89 bills is the last place to repeat the notice-board bug where a
  suppressed dialog made Withdraw silently do nothing.

### The WhatsApp list

After publishing only — before it, there is no bill to tell anyone about.
Unreachable flats only. One tappable number per flat, from `occupantOf`, via the
existing `waLink()`. The message carries **no payment link**, deliberately:

> DD Diamond Park: your August gas bill is ₹1,261, due 10 September. The full
> working is on the portal: diamondpark.pages.dev

### Deletions

`public/admin/readings.html`, `public/js/admin-readings.js`, and the
`periodsPanel` half of `admin-console.js`. Redirect `/admin/readings.html` to
`/admin/#billing` for a release or two — it is bookmarked, and the meter walk is
the one screen somebody has open on a phone.

## Tests

`npm test`, no network and no D1. The existing 1153 stay green.

| Area | What to assert |
|---|---|
| Publish | Queues exactly one announcement per bill; refuses a locked month, a partial month, and a flat with no owner (`DDP-BILL-015`) |
| Outbox | A drain is idempotent; a partial drain resumes; `unreachable` is never attempted; a 4xx is not retried |
| Subrequests | One token refresh per drain, not one per send |
| Corrections | A reading correction produces the right total; a price correction recalculates every bill; **`editBill` refuses `total`** |
| Approvals | Unchanged — the requester never approves, the household never approves, an admin's own bill needs every other admin |
| Counts | Email and bill counts are computed from billable flats, never from the building |

## Verifying before merge

1. `npm test`
2. `npm run doctor -- --local --md`
3. Publish a month against local seed data end to end; confirm the outbox
   drains, resumes after being interrupted, and sends nothing twice.
4. Staging (`npm run staging:deploy`) with demo data, on a phone, walking the
   readings step in a corridor with the signal off.
5. **Deploy both** — `npm run deploy:all`. Shipping only Pages leaves the cron
   on old code; shipping only the Worker leaves the site stale.

## What could go wrong

* **The subrequest cap.** The single most likely failure, and it fails at scale
  only — 20 flats locally will never show it. Test the drain with 89.
* **Step 2 losing a fix in the move.** Mitigated by moving the file rather than
  rewriting it, and by keeping its comments.
* **Gmail is still unconfigured in production (W1).** Publishing must succeed
  with zero emails sent and say so plainly; the WhatsApp list is the fallback
  and every resident has a mobile.
* **Two write paths during the transition.** Avoided by replacing both screens
  in one change rather than running old and new together.

## Still open, and not blocking

* **When the announcement email is written**, it needs the HTML template and a
  plain-text part. Whoever writes it should run the copy past
  `BILLING-TAB.md` § *The house voice* — em dashes are this project's
  strongest AI-writing tell.
* **`manual_total`'s eventual removal**, once the doctor check reads zero.
