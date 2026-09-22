# Maintenance billing: the staging rehearsal

The last thing between this feature and 1 October. It runs on `dddp-migtest`,
never on production, and it must finish before any production migration.

## Why a person opens every screen

Nine defects in this feature were found by rendering it and none by the test
suite. The suite has been green throughout: 1,844 tests, and it was green while

- the admin Maintenance tab had never rendered at all since step 6;
- a tally kept its authoritative look after it stopped updating;
- a picker offered the bank's own interest to an arbitrary flat;
- a dialog named a consequence that was not one;
- `replaceChildren` stringified a nullish child and the word "null" appeared on
  screen;
- and three navigations in the Maintenance tab did nothing when clicked — the
  tenancy dialog's "Yes, they have left", "Bills for this quarter", and
  "Preview an email", which pointed at a tab deleted two steps earlier.

Every one of those is invisible to a passing assertion and obvious to an eye.
So the rehearsal is not a script. **A human opens each screen listed below and
looks at it.** A script may set up the state; it may not stand in for the
looking.

## Before anything

- [ ] The wording pass has landed: every resident-visible string is final,
      `PLACEHOLDER_COPY` is `false`, and its guard test asserts `false`. The
      rehearsal is also the last read-through of what residents receive, so
      running it on placeholder copy wastes the read-through.
- [ ] The UPI payee name is decided and configured.
- [ ] `npm test` and `npm run lint` clean on the branch being rehearsed.

## 1. Migrations, on a database with rows in it

`npm run check:rebuild` covers the proofs rebuild. This is the wider question:
do 0042–0045 apply where data already exists? `dddp-migtest` carries rows, which
is the whole point of rehearsing there.

- [ ] `npm run staging:migrate` — 0042, 0043, 0044, 0045, in order.
- [ ] `npx wrangler d1 migrations list dddp-migtest --remote` afterwards. Note
      the known 7403 quirk on this command; a 7403 is not a failed migration.
- [ ] Spot-check that `maint_approvals` and `tenancy_change_approvals` still
      hold their foreign keys, since neither migration rebuilds a table and
      0042's closing note asks that none be rebuilt casually.

## 2. A full quarter, opened by a human

Deploy the branch to staging (`npm run staging:deploy`, `npm run staging:cron`)
and walk the quarter. Each line is a screen someone opens.

- [ ] **Draft appears.** The quarter shows as a draft seven days ahead.
- [ ] **Admin Home card** — the maintenance card's counts match the Maintenance
      tab when you follow it.
- [ ] **Step 1, rates.** Owner rate, rented rate, late fee.
- [ ] **Step 2, which flats are billed.** Tenancy flags: current, lease-ended,
      missing-date, unchecked. Confirm one with "Still here".
- [ ] **Preview an email** — all four letters, for an owner flat and a let flat.
      This is where the committee reads the final copy in place. Check the
      rented-rate line explains why a let flat pays more, and that the
      overdue letter's voting sentence is **absent** while the quarter is still
      running.
- [ ] Confirm afterwards that the outbox is still empty. A preview must never
      queue: `SELECT count(*) FROM maint_mail` unchanged.
- [ ] **Schedule.** Then **unschedule**. Then **schedule again** — the undo path
      is the one an anxious treasurer will actually use.
- [ ] **Issue.** Bills raised; the drift line reports scheduled-versus-issued.
- [ ] **Letters queued and drained.** Four kinds, 20 per drain, one token per
      drain. Check a resident with no email is `unreachable`, not `queued`.
- [ ] **A resident pays** — from the resident dashboard, on a phone.
- [ ] **A resident uploads a screenshot**; the treasurer confirms it.
- [ ] **The late fee lands the following day** on what is still unpaid, and the
      resident's card and the letter agree on the figure.
- [ ] **A bill re-rates when a tenant leaves**: the tenancy dialog states the
      consequences, the approval agrees with the dialog, the bill moves to the
      owner and the letters follow.
- [ ] **A flat is blocked from voting**, sees the block on its home page and on
      a poll card in the same words, then is **unblocked by payment**.
- [ ] **Excuse a flat** from the block, and approve it as the second admin.
- [ ] **Reconcile** a statement against the second account, including a credit
      with no candidates. `amountIdentifiesPayer` stays **false** for
      maintenance — several flats owe the identical amount, so the amount can
      never name the payer.
- [ ] **Who owes what** — gas and maintenance kept apart, no combined figure.

## 3. The device tests

The only part that cannot be simulated, and the likeliest to fail.

- [ ] ₹1 from a real Android phone, through each UPI app.
- [ ] ₹1 from a real iPhone, through each UPI app.
- [ ] In whichever payee mode is configured — and in both modes if the bank
      answers about a non-merchant UPI ID in time.
- [ ] The payment sheet's BHIM tile currently shows a lettered tile. The brand
      mark is outstanding and is the user's to source.

## 4. The roster

The rosters do not exist yet: there is no rented-flat list and no lease dates.
That is not a blocker but it does decide which path 1 October uses.

- [ ] Rehearse on staging's own data.
- [ ] **Exercise the acknowledgement path deliberately** — schedule with undated
      leases acknowledged. On current evidence this is the path the real
      quarter will take, so it must be the rehearsed one, not the untried one.
- [ ] Check the treasurer's paid-and-owing spreadsheet against the roster, and
      enter the rented flats and lease dates if they arrive in time.

## 5. Launch

In this order. The deploy traps in this repo have bitten twice.

- [ ] **Migrations against production first**, then the deploy. Never the other
      way round: a deployed worker that expects a column the database lacks is
      an outage, and the ordering has already been the cause of one.
- [ ] Deploy from `main`, with the release stamp — `npm run deploy:pages` and
      `npm run deploy:cron`. A bare `wrangler deploy` loses the stamp.
- [ ] **Verify the deployed asset itself**, not the command's exit code. Fetch
      the live JS and confirm it is the build you meant. A Pages deploy can
      report success while production serves the previous bundle.
- [ ] Watch the first drain: queued, sent, and nothing stuck on attempts.

## Still open at the time of writing

- The UPI payee name, with the committee.
- Whether the bank will issue a non-merchant UPI ID.
- The BHIM brand mark for the payment sheet.
- The rented-flat count and the lease dates.
