# Per-flat occupancy — one control on the Residents tab

Built 2026-08-20. This is the settled model: what the dropdown under every flat
means, what it writes, and what it deliberately does not store.

## The problem it closes

Occupancy was two errands on one tab, and nobody thinks of it as two.
`relationship` was picked while adding a person; whether the flat is billed at
all lived in a separate list further down the same screen. "12F is unsold" is a
single fact, and splitting it is exactly how a flat ends up with nobody on file,
still on the billing roll — where the meter reading it will never have refuses
generation for the entire building, while the readings screen only says
*88 of 89 entered*.

That is not hypothetical. `npm run doctor` against production on the day this
was built named **five** flats in that state: 8B, 9E, 11D, 14A, 16D.

## The model

Four states. Three are offered; the fourth is real and cannot be chosen.

| State | What is true of the `owners` rows | Billed to |
|---|---|---|
| `none` | no active rows for the flat | nobody — `occupantOf` returns `null` |
| `owner` | an active `relationship='owner'`, no active tenant | the owner |
| `owner+tenant` | an active tenant **and** an active owner | the tenant |
| `tenant-only` | an active tenant, **no** active owner | the tenant; nobody is liable |

**No column stores this.** Migration 0011 refused a stored three-state
occupancy and the argument has not changed: "absent" is not a fact about a
person, it is what being an owner means when somebody else occupies your flat.
A stored copy is a second truth, and the copies drift the first time a tenant
leaves and nobody flips the owner back. `occupancyOf(people)` reads the rows.
The dropdown is a **control** that writes `owners` rows and `flats.active`, and
then reads the state back out of them.

The consequence worth stating: **ending a tenancy writes exactly one row.** The
tenant is deactivated and nothing touches the owner, because there is nothing on
the owner to touch — `occupantOf` simply stops finding a tenant and falls
through. If a future change ever needs a second write there, it has reintroduced
the thing 0011 rejected.

### `tenant-only`, and why it is visible

A flat with a tenant and no owner on record is reachable without anybody
choosing it: deactivate the owner of a let flat and you are in it.
`diagnostics.js` has warned about it as `TENANT-NO-OWNER` all along — the tenant
is billed, and if they leave owing, the liability rule has nothing to point at
(`planDeparture` returns `tenant-left-owing-no-owner`).

Making it unrepresentable would have given the flats already in it a dropdown
that lies about them. So:

* it is shown in the dropdown, **disabled**, as what the flat *is*;
* the card carries a `No owner` chip;
* it can never be selected — the way out is to pick **Owner + tenant** and fill
  in the owner, with the tenant already prefilled. That is the repair, and it
  writes one `add` step.

## What the dropdown writes

`planOccupancy()` in `functions/lib/tenancy.js` is pure: it takes the flat's
rows and the answers, and returns the steps rather than performing them — the
same shape as `planDeparture` and `planHandover`, and for the same reason. The
endpoint `PUT /api/admin/flats/:flat/occupancy` applies them as **one D1 batch**,
so a half-applied change (old tenant deactivated, new one never inserted) cannot
exist.

| Step | Effect |
|---|---|
| `deactivate` | `owners.active = 0`, `moved_out_at = now`, all their sessions destroyed |
| `add` | a new `owners` row with a temporary password, `moved_in_at` set |
| `update` | `name` and `moved_in_at` **only** |
| `flat` | `flats.active`, `inactive_reason`, `inactive_since` |

Four rules the planner enforces and must keep enforcing:

1. **Nobody is ever deleted.** Departure is `active = 0`, so bills, proofs and
   comments stay attributable. That is the whole value of the audit trail.
2. **It never writes an existing person's `mobile` or `email`.** Those are
   behind approval since B22 — see `REQUESTABLE_FIELDS` and `canEditField`. An
   occupancy control that quietly rewrote them would be a way round the queue,
   which is worse than no queue. The screen shows them read-only with a pointer
   to the person's own row, which has the Request button. Creating a **new**
   person with a number is a different act and has always been an admin's to do.
   The endpoint also runs `canEditResident` against every active person in the
   flat before it plans anything, so the flat is not a way round that ladder.
3. **A new owner where one already sits is refused**, and the message points at
   the ownership handover — a sale has an outstanding balance to settle first
   (`transferFlat`, `DDP-ADMIN-005`), and this control must not become a way to
   skip it.
4. **Two active tenants never coexist.** Replacing a tenant deactivates the
   outgoing one in the same batch. Two would mean whichever row the query
   returns first is billed and the other is not (`TWO-TENANTS`).

## `owners.mobile` is the login id

`NOT NULL UNIQUE`, and there is no other identifier a resident types. A landlord
giving the committee their own number for their tenant is the ordinary way this
gets attempted, and the raw failure is a constraint violation and a 500.

Three checks, all answering in sentences:

* `contactClash()` catches the two parties in **this form** sharing a number,
  compared on digits so `+91 98464 66511` and `9846466511` are one number. The
  screen says it before anything is sent.
* `duplicateContact()` catches a number that already belongs to somebody in
  another flat — which the form cannot see — and names them:
  *"That mobile already belongs to Ravi Menon (5D)."* (409, `DDP-ADMIN-013`.)
* Two people added in one submission are checked against **each other** as well,
  because neither is in the table yet when `duplicateContact` runs.

Email is checked the same way and for the same reason: it is where a reset code
goes, so a shared address is a shared account.

## Dates

A tenancy start is asked for as a **month**, because that is what anybody
remembers, and stored as the first of that month in ISO: `2026-08` → `2026-08-01`
in `owners.moved_in_at`. Displayed as `08/26`.

Storing `'mm/yy'` would sort `01/27` before `08/26`, breaking every comparison
against `moved_out_at`, `inactive_since` and `bills.period`. `monthToISO`,
`isoToMonth` and `isoToMonthInput` are the only conversions; there is a test
that asserts the wrong order to make the reason unmissable.

## The decision: does "no owner" turn billing off?

**No — not automatically. It refuses to save until somebody answers.**

The two facts are related and not the same one:

* **occupancy** answers *who* — derived, never stored;
* **`flats.active`** answers *whether this flat gets a bill at all* — stored,
  because it is a decision rather than a consequence.

Inferring one from the other gets a real case wrong in each direction:

* A flat can be **owned and empty** and still billed to its owner. `occupantOf`
  falls back to the owner precisely so somebody answers for the meter. That is
  *vacant*, and it is not *unsold*. Auto-switching billing off on "no owner"
  would not touch this case, but auto-switching it off on "nobody living there"
  would — which is why the control asks about people, not about emptiness.
* A flat with **nobody on file** has no one to bill and no one to send a bill
  to, and yet stays on the reading grid. That is the jam.

So when the dropdown is set to **No owner** on a flat that is currently billed,
the form asks, and will not save without an answer:

* **Stop billing it** — writes `flats.active = 0` with a required reason, kept
  on the flat (0026: "why has 12F not been billed since August" must be
  answerable by looking at 12F). This is the default.
* **Keep it billed** — allowed, and returns a warning that says what it costs:
  a meter reading every month, and until it has one no month can be generated
  for any flat.

The reverse is offered, not done: setting a flat that is **not** being billed to
`owner` or `owner+tenant` proposes billing it again with a reason, defaulted on.
Declining returns the `occupied-but-not-billed` warning — somebody lives there
and will never be asked for their gas. It stays a warning because "owned, empty,
deliberately left off" is a state the committee is allowed to hold.

`unsold` and `vacant` remain **derived** and unstored, exactly as 0026 says.
Nothing here adds a category.

## The diagnostics check

`FLAT-BILLED-NO-OWNER`, severity **fail**, in `checkIntegrity` — so it is in
`npm run doctor` and in god mode's report, both of which already read
`flats.active`.

Severity `fail` rather than `warn` because a month is *already* unable to close,
today, not eventually: generation refuses a partial month by design (a missing
flat means somebody silently never gets billed), and one flat in this state
blocks billing for all 89. A departed owner counts as nobody on file — the row
is still there with `active = 0`, and a naive "does this flat appear in owners"
would miss it.

## Also fixed here

The billing toggle collected its reason with `prompt()`. This codebase bans
suppressible browser dialogs — `askFirst` in `public/js/ui.js` exists because a
browser that has suppressed them returns immediately, so the button does
nothing, says nothing and sends nothing; that reached production on the notice
board's Withdraw. `prompt()` fails the same way and worse: it returns `null`,
which read here as *cancelled*, so the control was silently dead. It now asks in
the page, in the same idiom — the question, a field, the destructive choice as a
real button and the way out as the quiet one — in a slot inside the row, on
screen, never inside anything collapsed.

---

# What the Billing tab consumes

Written for the work in [BILLING-TAB.md](BILLING-TAB.md). Take it literally.

## Who is billed for flat X

```js
import { occupantOf } from '../functions/lib/tenancy.js';

const occupant = occupantOf(people);   // an owners row, or null
```

`people` is **every** `owners` row for that flat — active and inactive both.
Do not pre-filter; `occupantOf` filters on `active` itself, and handing it only
the active rows is harmless but handing it a list you filtered on something else
is not. The tenant if there is one, otherwise the owner.

**This is the person who receives the bill email and who appears in the
WhatsApp chase list.** Do not re-derive it from `relationship` at the call site.

`SELECT id, flat, name, mobile, email, relationship, active FROM owners WHERE flat = ?`
is the query. `GET /api/admin/residents` already returns exactly these columns
for the whole building (plus `floor`, `role`, `moved_in_at`, `moved_out_at`,
`must_change_pw`); group by `flat` and hand each group to `occupantOf`.

## Who is liable for flat X

```js
import { landlordOf } from '../functions/lib/tenancy.js';

const liable = landlordOf(people);     // an owners row, or null
```

Always the active owner, occupied or not. This is who to talk to about an unpaid
bill; it is **not** who to send the bill to. Sending an absent owner their
tenant's bill is a privacy decision nobody made — `billAccess` gives a landlord
`amounts: true, proofs: false` for exactly that reason, and it is a *pull* on
their own dashboard, not a push into their inbox.

## Is this flat billed at all this month

`flats.active`. Read it, do not derive it.

* `GET /api/admin/flats` → `{ flats: [{ flat, floor, billed, residents, unsold,
  reason, since }] }`. `billed` is `Boolean(flats.active)`; `unsold` and
  `vacant` are derived there and are **not** columns.
* `readingGrid(env, period)` already filters to `f.active = 1`. Its `.flats` is
  the set being billed this month, `.excluded` is the rest with their reasons,
  and `.total` is the number generation compares against (`expectedFlats`).

There is no per-month billing flag and none should be added. `flats.active` is a
standing setting: a flat left out stays out of every month until somebody turns
it back on. `inactive_since` says when, `inactive_reason` says why.

## What can be null, and what to do

| Value | Null when | What the caller does |
|---|---|---|
| `occupantOf(people)` | no active people (`none`) | **Do not bill, do not email, do not list for WhatsApp.** If `flats.active` is also 1, this is `FLAT-BILLED-NO-OWNER` and the month cannot be generated — surface it as a blocker on the publish step with a link to the flat's Residents card, not as a missing reading. |
| `landlordOf(people)` | `tenant-only` | There is nobody liable. Chase the occupant; do not fall back to any other owner. Show the `TENANT-NO-OWNER` state and ask for the owner. |
| `occupant.email` | often — `owners.email` is nullable, and today 103 of 105 accounts have none | Not an error. Send nothing, and put the flat in the WhatsApp list: `waLink(occupant.mobile, text)` in `functions/lib/tenancy.js`. |
| `occupant.mobile` | **never** — `NOT NULL UNIQUE` | Every household is reachable by WhatsApp. That is what turns the B5 email gap into a short list of taps. |
| `bills.owner_id` | see below | Fall back to `occupantOf` and treat it as a finding, not a normal path. |

## Occupancy can change mid-month. What that means for a bill already generated

It can, and the control does not stop it — a tenancy really does start on the
14th, and refusing the edit would only make the record wrong.

The rule, and it has a seam in it:

* **Before generation**, there is no bill. Whoever `occupantOf` returns at the
  moment you publish is the person billed. Recompute it at publish; do not cache
  it from when the grid was opened.
* **After generation**, the bill belongs to a **person**, not to the flat. That
  is migration 0003's whole point: when 4A is sold, the new owner must not be
  able to read the previous owner's bills or open their payment screenshots.
  The column is `bills.owner_id`, and it is what "who owes this bill" means once
  the bill exists. **Do not recompute `occupantOf` for a bill that already
  exists** — a tenant who moved out on the 20th still owes the month they used
  the gas in, and re-deriving hands their bill, and their proofs, to whoever
  moved in.
* A reading is a fact about the **property** and carries across any of this.
  Readings stay keyed to the flat alone and are unaffected by an occupancy
  change.

**The seam that was here is closed.** This section previously said
`generateBills` does not write `owner_id`, and told the caller to fall back to
`occupantOf` when it is null. That was true when the brief was written and is
not true now: the same work that produced this document fixed it, and leaving
the warning here would have the Billing tab carry dead fallback code for a case
that cannot arise.

What generation does today (`functions/lib/admin.js`):

```js
// readingGrid
residentId: occupant?.id ?? null,   // occupantOf, off the full set of rows
// generateBills
INSERT INTO bills (flat, period, owner_id, ...) VALUES (?, ?, ?, ...)
```

So a bill raised through the console already carries the person it was raised
for. Read `bills.owner_id` and trust it. **Do not recompute `occupantOf` for a
bill that already exists** — a tenant who moved out on the 20th still owes the
month they used the gas in, and re-deriving hands their bill, and their payment
screenshots, to whoever moved in.

Worth knowing why this mattered: the grid used to pick the resident with a
`LEFT JOIN owners ... GROUP BY f.flat`, which returns whichever row SQLite
reaches first. For a tenanted flat that is a coin toss between the tenant and
their absent landlord. Harmless while it was only a name on a screen; wrong the
moment it became `bills.owner_id`.

## Signatures to call rather than re-derive

All pure, all in `functions/lib/tenancy.js`, all testable with no database.

```js
occupantOf(people)            // owners row | null   — who is billed
landlordOf(people)            // owners row | null   — who is liable
isTenanted(people)            // boolean             — is it let
occupancyOf(people)           // 'none' | 'owner' | 'owner+tenant' | 'tenant-only'
occupancyLabel(state)         // the committee's words for it
billAccess({ viewer, people}) // { amounts, proofs, canPay, reason }
describeRelationship({ viewer, people })
waLink(mobile, text)          // E.164-safe wa.me link
isoToMonth(iso)               // '2026-08-01' -> '08/26'
```

Endpoints:

```
GET  /api/admin/residents            every person, grouped by flat client-side
GET  /api/admin/flats                every flat + billed/reason/since
PUT  /api/admin/flats/:flat/occupancy  the control; the Billing tab links here,
                                       it does not reimplement it
PATCH /api/admin/flats/:flat         billing on/off alone, reason required
```

**The Billing tab should not write occupancy itself.** When it finds a flat it
cannot bill, link to that flat's card on the Residents tab. One control, one
place, one audit row (`flat.occupancy`, recording `from` and `to`).
