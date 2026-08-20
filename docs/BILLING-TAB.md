# The Billing tab — one flow from the rate to the published bill

Proposed 2026-08-19. **Nothing here is built.** This is the design record for
merging the `Rates` tab and the `Readings` page into a single `Billing` tab, so
the decisions survive the session they were made in.

Clickable prototype: <https://claude.ai/code/artifact/844e31f7-125c-4056-8b17-f8e317962a50>
Source: `docs/billing-tab-prototype.html`. Sample readings that match its fixed
`previous` values: `docs/billing-tab-readings.tsv`.

## What it is

Three steps and a publish, in one tab, in the order the month actually happens.

1. **The price of gas** — rate per kg, payment due, late fee.
2. **This month's readings** — the existing grid, plus paste and file import.
3. **Review and publish** — every flat with what it used and what it owes.
   Readings stay editable here. **The amount never is.**

Publish generates the bills, locks the month, and emails every resident who has
an address.

## Decided

| | Decision | Why |
|---|---|---|
| Draft stage | **Yes** — generate is no longer the same act as publish | Most corrections become edits made before anyone sees a bill, so the two-admin rule guards genuine mistakes rather than ordinary typos |
| Rate entry | Rate per kg, typed, as today | `deriveRate(supplierTotal, totalKg)` stays unwired — it needs a total that does not exist until step 2, which would invert the flow |
| Step 1 holds | Rate, due date, late fee | All three are what `openPeriod` already needs |
| Who publishes | Any admin, alone | Same as generation today |
| Email on publish | Everyone with an address; the gap is reported on screen | Publishing must not be blocked by an incomplete roster (B5) |
| Post-publish corrections | In the same tab, published state | The two-admin rule is unchanged — it moves, it does not weaken |
| Meter walk | The same merged screen | Step 2 must inherit autosave, the offline queue, the retry banner and the progress count, or the corridor gets worse |
| Tab strip | `Rates` and `Readings` become **Billing** | Nine tabs become eight |

## Everything is decided

All three open choices were settled on 2026-08-20 and the prototype is built to
them, not switchable between them.

| Choice | Decision | Why |
|---|---|---|
| Corrections after publish | Edit the reading, or the month's price of gas. **Never the amount.** | Every rupee traces to a meter reading and a rate |
| Past months | Under `Bills`, not on this tab | The tab stays the same size in year three as in month one; a list under the month in hand grows without limit |
| Popups | Unfold in place | Matches every other disclosure in the portal; the WhatsApp list is about figures an overlay would cover |

What remains open is not a design question: whether `bills.manual_total` is
removed or kept as a superadmin escape hatch (see below), and the policy question
of who may correct a published month's price of gas — the rate editor refuses a
locked month today (DDP-BILL-012) and names the superadmin.

## Corrections after publish — decided 2026-08-20

**The amount is never editable. Only the inputs are.** A bill's total is
consumption times rate, and both of those come from somewhere real:

| Wrong thing | What you edit | Scope |
|---|---|---|
| A meter was misread | That flat's **reading** | One flat |
| The gas was priced wrong | The month's **price of gas** | Every bill in the month |

Nothing else. No rupee figure is ever typed against a bill.

**There is no goodwill adjustment, deliberately.** Every rupee traces to a meter
reading and a rate. If the committee wants to give somebody relief it happens
outside the bill — a late-fee waiver, or a debt simply not chased — and the bill
goes on saying what the gas cost. A bill that says something other than
consumption times rate is a bill nobody can check.

**A published month's price is corrected once, for the whole month.** It is not
a per-flat rate: one flat billed at a different rate than its neighbours would
mean the month no longer reconciles against a single supplier invoice. The
prototype shows the consequence before it happens — every bill recalculated,
already-paid bills going back to unpaid when the price rises — mirroring what
`changeRate` already computes for an open month.

**This retires a path that exists today.** The `Bills` tab's "Correct this bill"
takes a rupee figure and a reason and sets `bills.manual_total`; `changeRate`
then skips those rows on the grounds that "a manual total was somebody's
considered decision". That is precisely the thing now ruled out. Whoever builds
this must decide, explicitly, whether `manual_total` is removed or kept as a
superadmin escape hatch — leaving both paths live would mean the rule holds on
one screen and not on the other, which is worse than either answer.

The two-admin approval rule is unchanged. What goes for approval is now a
corrected reading and the total it produces, rather than a total somebody typed.

## Telling people by hand — decided 2026-08-20

Every resident has a mobile: `owners.mobile` is `NOT NULL UNIQUE`, because it is
the login id. Email is nullable. So the households that cannot be emailed can
always be WhatsApped, which turns the B5 gap from a dead end into a short list of
taps — and does more for that backlog entry than anything parked in it.

| | Decision |
|---|---|
| Who is listed | Whoever is billed — the tenant if there is one, otherwise the owner, which is what `occupantOf()` already decides |
| When it appears | **After publishing only.** Before, there is no bill to tell anyone about, and a message quoting a figure that could still change is worse than no message |
| Scope | The unreachable flats alone, not the building |
| Where it opens from | The published card, not inside step 3 — publishing collapses step 3, which would bury the five people who most need contacting |

The prefilled message:

> DD Diamond Park: your August gas bill is ₹1,261, due 10 September. The full
> working is on the portal: diamondpark.pages.dev

**No payment link, deliberately, and this should not be revisited casually.** An
unsolicited WhatsApp asking for money is the exact shape of a fraud, and a UPI
link in a chat teaches residents to pay from messages. The portal URL only. B19
independently found that `upi://` links do not survive Gmail or resolve reliably
anyway.

**One thing to check against a real number before this ships.** The message names
the association but not the sender, and it goes out from an admin's own WhatsApp
— so the resident sees a personal name in their chat list and an association in
the text. A sender line was offered and rejected; it may resolve itself in
practice, or it may read as a stranger asking for money. Worth one live test.

`waLink(mobile, text)` in `functions/lib/tenancy.js:377` already builds these
correctly, including the trap that mobiles are E.164 since migration 0009 and
the old `wa.me/91${mobile}` produced a dead link. Only the list is new work.

## What the occupancy work settled — 2026-08-20

`docs/RESIDENTS-OCCUPANCY.md` is the contract; its closing section is written
for this tab. Three things it changes here:

**The recipient rule is confirmed, and the prototype already matches it.**
`occupantOf(people)` — the tenant if there is one, otherwise the owner — decides
who gets the bill email and who appears in the WhatsApp chase list. Call it;
never re-derive from `relationship` at the call site. `landlordOf()` is who is
*liable*, and is deliberately not who the bill is sent to: pushing an absent
owner their tenant's bill is a privacy decision nobody made.

**A new blocker the prototype does not draw.** A flat that is being billed with
nobody on file is `FLAT-BILLED-NO-OWNER`, and the month cannot be generated.
The publish step has to surface that as its own blocker with a link to the
flat's Residents card — **not** as a missing reading, which is what the
treasurer would otherwise go hunting for. Same class of problem as the unsold
flat that jams the month, and the reason the diagnostics check now exists.

**Bills now carry their person.** `generateBills` binds `bills.owner_id` from
the same `occupantOf` answer, so a published bill records who it was raised for.
Read that column for anything about an existing bill; do not recompute occupancy
for a bill that already exists, or a tenant who left in the middle of the month
hands their bill and their payment screenshots to whoever moved in.

**This tab does not write occupancy.** When it finds a flat it cannot bill, it
links to that flat's card. One control, one place, one audit row.

## Several flats at once, and what a detour costs, 2026-08-20

**Plurals.** The blocker was written for one flat and read "7A, 9C has nobody on
record" for two, with a button label that grew with the list. It now names up to
six and counts the rest — *"9 flats have nobody on record: 1D, 3E, 5B, 7A, 8G,
9C and 3 more"* — and the button becomes "Put residents back on 9 flats". In the
built version that is one link to Residents, not nine.

**Nothing is lost by leaving.** The fix for this blocker is on another screen,
so the blocker now says so out loud: *"Nothing here is lost by going there. The
readings and the rate are already saved, and this draft will be as you left
it."* That sentence is only true because of the draft decision — the draft IS
the readings plus the rate, both already persisted — which is worth remembering
as a reason that decision was right. A treasurer who suspects a detour will cost
them 89 typed readings does not take the detour; they put the month off.

**One more off-by-one-set.** The Flats tile read 88 while Gas and Total still
summed all 89, because the totals ran over every flat rather than the billable
ones. Same family as the publish button counting from `TOTAL`. Both totals are
now scoped to flats that can actually produce a bill, so the tiles, the button
and the notes all describe the same set.

## Derived text must be repainted from one place, 2026-08-20

Correcting a reading on the review step left the screen contradicting itself:
the button read **"Publish 89 bills"** directly above a note reading **"makes 88
bills visible"**, and the outlier list still quoted a flat at 3.77 kg that had
just been set to 0.00 kg.

The cause was three hand-patched fragments inside the row handler — totals,
step subtitle, button label — each updating a different subset of what a changed
reading invalidates, and one of them recomputing the count from `TOTAL` (the
whole building) instead of the billable flats. The button also silently
overwrote its own blocked state, so it looked live while refusing to click.

Now one `repaintReview()` owns everything a corrected reading touches: outliers,
the blocker state, the button label and its disabled flag, the totals and the
subtitle. The row handler calls that and nothing else.

**Rule for the build: anything derived from the readings is repainted from a
single function.** The review step has at least six such surfaces, and a screen
that disagrees with itself about how many bills it is about to send is worse
than one that simply refuses.

## The refused row, regressed and re-fixed, 2026-08-20

A pasted reading that runs backwards is refused by the grid. The counter then
said "88 of 89 entered" and the button said "1 still to enter" — so you hunt 89
rows for an empty box that is not empty, because the offending one is full.

`admin-readings.js` already carries a comment about this from testing on
2026-08-13: *"A REFUSED ROW IS NOT AN EMPTY ONE... the footer sent the treasurer
hunting for empty boxes that were not empty."* The real screen appends
`· N need fixing`. The prototype dropped it, which is the **second** time this
prototype has reproduced a bug the real file had already fixed and documented —
the `null` children were the first.

**The lesson for the build: when a step of this flow is lifted from
`admin-readings.js`, lift the fixes with it.** Those comments are the record of
what testing already cost once.

Fixed here, and taken a step further than the real screen: the counter names the
refusals, and the button becomes **"Fix 2A"** and scrolls to the row. With 89
rows, a true statement you cannot act on is barely better than a false one. The
button is never dead now — complete, it moves on; incomplete, it takes you to
whatever is in the way.

Also fixed: pasting a correction below an existing block counted the flat twice
and reported "93 filled in" in a building of 89. It counts distinct flats now.

## A confusion found by clicking, 2026-08-20

The unbillable-flat blocker was met with the obvious wrong remedy: entering the
flat's reading as last month's figure, to bill it at zero.

It does not work, and it cannot — the blocker tests occupancy, not consumption.
A zero-rupee bill is still a bill: it gets a row, an `owner_id`, a due date and
an email, and with nobody on record there is no `owner_id` to write.

**The instinct is not a mistake; the portal taught it.** `PATCH /api/admin/flats/:flat`
refuses to stop billing a flat that already has a reading with the words
*"leave the flat billed and enter the same reading as last month, which bills it
at zero"* — the same remedy, for a different problem. Two nearby situations, one
shared phrase, opposite outcomes.

So the blocker names the wrong remedy explicitly rather than only listing the
right ones: **"Entering a reading will not clear this"**, then the two real ways
out.

**That was not enough, and the second attempt is the more useful finding.** The
reading was tried twice more after the copy fix, because the explanation sat at
the top of a very long step while the person was at the bottom, looking at a
disabled button that named a problem and offered no route out of it. Correct
copy in the wrong place is not copy anybody reads.

The blocker is now repeated immediately above the publish button, with the
resolution as a control rather than a sentence. Two rules for the build:

* **When an action is refused, the reason and the route belong AT the refusal**,
  not only at the top of the screen. A disabled button that names a problem
  without offering a way to it is a dead end wherever the explanation lives.
* When a plausible wrong move exists, say it is wrong. Listing the correct
  options does not stop anyone trying the other one.

## Two engineering findings that shape the build

**The draft needs no schema.** The draft *is* the readings plus the rate, and
both are already stored and already shared between admins. Step 3 computes
amounts live through `previewGeneration`. Storing draft rows in `bills` would
mean every resident-facing query needs a `published_at IS NOT NULL` filter, and
the one that gets forgotten is the one that shows somebody a bill nobody agreed
to. Durable, shared, and no way to leak — which is what "saved, visible to all
admins" was asking for.

**89 emails will not fit in one request.** `sendEmail` calls
`refreshAccessToken` on every send and neither is cached, so publishing a month
is ~178 outbound fetches. The Cloudflare free plan caps a request at 50
subrequests. `remindAll` (`functions/index.js:2603`) has the same latent bug and
has survived only because the overdue list is a handful, never the building.

The fix is an announcement outbox: publish queues one row per bill, the console
drains ~20 at a time behind a progress bar, and the 3am cron sweeps stragglers.
Two things come free — hoist the token refresh out of the loop, and let the
outbox row be the idempotency record so a retry cannot send twice.

**Depends on W1.** Gmail OAuth is still unconfigured in production, so the email
half is inert until it lands. HTML email itself now exists —
`functions/lib/email-template.js` and a `multipart/alternative` `buildRawMessage`.

## Fix list for the prototype — all done 2026-08-20

Raised 2026-08-19 from the first click-through, fixed and verified in the
browser the next day.

1. **Cut the rate-step preamble.** "What the supplier charged, before anything
   can be read or billed", and the paragraph beginning "Set this every month,
   even when it has not changed."
2. **Cut the rate-sanity tail.** "Worth a glance at the supplier bill before you
   carry on. Nothing stops you — the rate simply gets stated back to you first."
   The percentage comparison stays; the advice goes.
3. **`nullnullnullNothing skipped.`** Pressing *Fill the grid* with an empty box
   prints three `null`s. `replaceChildren` stringifies a null child where `el()`
   would skip it — the identical bug the real `importPanel` already carries a
   comment about, reproduced by copying its shape without its `.filter(Boolean)`.
   Fix in the prototype, and check `admin-readings.js` has not regrown it.
4. **Say which flats are not being billed, and why.** Built read-only: flat,
   reason, and since when, with a link to Residents. `unsold` and `vacant` are
   derived; anything else is the stored `inactive_reason`.

## The house voice, and what an AI-writing check flags

Checked against Wikipedia's *Signs of AI writing* on 2026-08-19.

Clean: no AI vocabulary (`delve`, `pivotal`, `underscore`, `tapestry`,
`vibrant`, `robust`), no puffery, no participle padding (`highlighting`,
`ensuring`, `fostering`), no copula avoidance (`serves as`, `boasts`), no
`Despite its X, faces several challenges` formula.

Three real hits, and one false one:

* **Em-dash density** is the strongest tell — roughly a dozen in a small screen's
  worth of copy. Some earn their place; most are commas or full stops.
* **Negative parallelism** (`not X, it's Y`) appears in the surrounding prose
  more than in the UI itself. Worth watching.
* **One rule-of-three** — "the meter still went up, the rate is fine, the month
  is complete". It is lifted verbatim from `admin-readings.js`, so it is this
  codebase's own sentence, not a generated one.
* **Curly apostrophes are flagged and should stay.** The tell is specific to
  Wikipedia, whose house style is straight quotes. This project's style is the
  opposite — `admin-readings.js` and `admin-console.js` use `’` throughout.
  Matching the codebase beats matching the wiki.

The lesson for the copy generally: this codebase's comments are unusually good
prose, and the prototype reads well where it echoes them and reads generated
where it does not.


## Two things fixed that nobody asked for

**Publishing ran through `window.confirm`.** This codebase bans it: `askFirst`
in `public/js/ui.js` exists because a browser that has suppressed dialogs
returns false immediately, so the button does nothing, says nothing and sends
nothing — which reached production on the notice board's Withdraw. Publishing 89
bills and emailing the building is a worse place for that bug. It asks in the
page now.

**An empty paste box reported a clean import.** Pressing *Fill the grid* with
nothing in it said "0 filled in as a draft. Nothing skipped", which reads as
success. It now says there is nothing to read.
