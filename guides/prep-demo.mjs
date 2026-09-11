/**
 * Put the demo bill back into the state the resident guide documents.
 *
 *   node guides/prep-demo.mjs          # then take the captures
 *
 * WHY THIS EXISTS. The guide teaches the ordinary case: a bill that is Unpaid,
 * not yet late, with a late-fee warning still in the future. Demo data does not
 * stay there. Its due date is a fixed calendar date, the late fee is applied the
 * moment a page is read after that date, and tapping Pay during a capture writes
 * a payment intent and a claim. On 2026-09-11 all three had happened at once:
 * a fresh capture showed ₹362 OVERDUE while the rest of the guide showed ₹312
 * Unpaid, and a guide that contradicts its own screenshots teaches nothing.
 *
 * So the due date is set relative to TODAY, and everything a capture leaves
 * behind is cleared. Run it before a capture session, and again after one that
 * tapped Pay.
 *
 * LOCAL ONLY. There is no flag to point this at production, on purpose:
 * production carries real accounts, and "reset a bill to unpaid" is the kind of
 * write that must never be one typo away from the live database.
 */
import { execFileSync } from 'node:child_process';

/** The flat and month every bill capture in the guide is taken against. */
const FLAT = '2B';
const PERIOD = '2026-08';
/** How far ahead the due date sits. Far enough that a capture session does not cross it. */
const DAYS_AHEAD = 14;

const sql = (v) => `'${String(v).replace(/'/g, "''")}'`;
const d1 = (statement) => {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'dddp', '--local',
    '--command', statement, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.slice(out.indexOf('['))).flatMap((r) => r.results ?? []);
};

// The building's calendar, not the machine's: the portal dates bills in IST,
// and a capture taken from a laptop in another timezone would otherwise put the
// due date a day off.
const ist = new Date(Date.now() + 5.5 * 3600 * 1000 + DAYS_AHEAD * 86400 * 1000);
const due = ist.toISOString().slice(0, 10);

const [bill] = d1(`SELECT id, total, status, late_fee, claimed_at FROM bills
                    WHERE flat = ${sql(FLAT)} AND period = ${sql(PERIOD)}`);
if (!bill) {
  console.error(`No ${PERIOD} bill for flat ${FLAT} in the local database. Seed it first:`);
  console.error('  node scripts/seed-demo.mjs --local');
  process.exit(1);
}

console.log(`\n  before  bill ${bill.id}: ${bill.status}, total ₹${bill.total}, ` +
            `late fee ₹${bill.late_fee}, claimed ${bill.claimed_at ?? '—'}`);

d1(`UPDATE periods SET due_date = ${sql(due)} WHERE period = ${sql(PERIOD)};`);
// Everything a capture session can leave on the bill. The total is recomputed
// from its parts rather than set to a remembered figure, so this cannot drift
// from the arithmetic the guide's own page explains.
d1(`DELETE FROM payment_intents WHERE bill_id = ${bill.id};`);
d1(`UPDATE bills
       SET late_fee = 0, late_fee_at = NULL, late_fee_waived_by = NULL,
           claimed_at = NULL, paid_at = NULL, status = 'unpaid',
           total = gas_amount + other_charges + additional_charges
     WHERE id = ${bill.id};`);

const [after] = d1(`SELECT b.status, b.total, b.late_fee, p.due_date
                      FROM bills b JOIN periods p ON p.period = b.period
                     WHERE b.id = ${bill.id}`);
console.log(`  after   bill ${bill.id}: ${after.status}, total ₹${after.total}, ` +
            `late fee ₹${after.late_fee}, due ${after.due_date}`);

/* ── the demo poll ─────────────────────────────────────────────────────
   The guide's poll page needs an open poll on a notice, with no answer yet
   from flat 2B. Created once, then reopened relative to today on every run,
   so it never drifts closed the way the bill's due date drifted overdue.

   Validated with the portal's OWN rules (public/js/poll-rules.js) before it
   is written, so this can only create a poll the composer would accept. The
   options name no dates for the same reason the bill's due date is relative:
   a date in an option label goes stale. */
const { validatePoll } = await import('../public/js/poll-rules.js');

const NOTICE = 'Water tank cleaning — choose a time';
const POLL = {
  title: 'When should the water tank be cleaned?',
  body: 'The water supply is off for about four hours while the tanks are cleaned. '
      + 'Choose the time that suits your household best. One vote per flat.',
  options: ['A weekday morning', 'A Saturday morning', 'A Sunday morning'],
};
const now = new Date();
const closes = new Date(now.getTime() + 7 * 86400 * 1000);
const verdict = validatePoll({
  title: POLL.title, body: POLL.body, multi: false, maxChoices: null,
  options: POLL.options.map((label) => ({ label })),
  closesAt: closes.toISOString(), now: now.toISOString(),
});
if (!verdict.ok) { console.error(`  demo poll rejected by the portal's rules: ${verdict.message}`); process.exit(1); }

// Posted by the demo admin, never by 4A: that account is a real person.
const [admin] = d1(`SELECT id FROM owners WHERE mobile = '+919990000001' AND active = 1`);
if (!admin) { console.error('  no demo admin (+919990000001) to post the poll as'); process.exit(1); }

let [notice] = d1(`SELECT id FROM notices WHERE title = ${sql(NOTICE)}`);
if (!notice) {
  d1(`INSERT INTO notices (title, body, kind, allow_comments, active, posted_at, scope, posted_by)
      VALUES (${sql(NOTICE)}, ${sql('The committee is booking the tank cleaners for next week. '
        + 'Vote on the poll below so we can pick the time that suits most flats.')},
              'notice', 0, 1, ${sql(now.toISOString())}, 'all', ${admin.id})`);
  [notice] = d1(`SELECT id FROM notices WHERE title = ${sql(NOTICE)}`);
}
// Keep it at the top of the notice board, where a resident would meet it.
d1(`UPDATE notices SET posted_at = ${sql(now.toISOString())}, active = 1 WHERE id = ${notice.id}`);

let [poll] = d1(`SELECT id FROM polls WHERE notice_id = ${notice.id}`);
if (!poll) {
  d1(`INSERT INTO polls (title, body, multi, max_choices, show_tenants, opens_at, closes_at,
                         reminder_at, notice_id, created_by, created_at)
      VALUES (${sql(POLL.title)}, ${sql(POLL.body)}, 0, NULL, 1, ${sql(now.toISOString())},
              ${sql(closes.toISOString())}, NULL, ${notice.id}, ${admin.id}, ${sql(now.toISOString())})`);
  [poll] = d1(`SELECT id FROM polls WHERE notice_id = ${notice.id}`);
  d1(POLL.options.map((label, i) =>
    `INSERT INTO poll_options (poll_id, label, sort) VALUES (${poll.id}, ${sql(label)}, ${i});`).join('\n'));
}
// Reopen it: open now, closing in a week, results not yet published, and no
// answer from 2B, so the capture shows a ballot rather than a receipt.
d1(`UPDATE polls SET opens_at = ${sql(now.toISOString())}, closes_at = ${sql(closes.toISOString())},
                    closed_at = NULL, published_at = NULL, reminded_at = NULL
     WHERE id = ${poll.id}`);
d1(`DELETE FROM poll_votes WHERE poll_id = ${poll.id} AND flat = ${sql(FLAT)}`);
console.log(`  poll    ${poll.id} on notice ${notice.id}: open, closes ${closes.toISOString().slice(0, 10)}, ` +
            `no answer from ${FLAT}`);

/* ── who the signed-in resident is ─────────────────────────────────────
   The captures are taken as Anila Menon, the TENANT of 2B, and tenants do
   not vote. `--owner` makes her an owner so the ballot can be photographed;
   any run WITHOUT the flag puts her back. There is deliberately no way to
   leave her an owner by forgetting a step. */
const asOwner = process.argv.includes('--owner');
d1(`UPDATE owners SET relationship = ${sql(asOwner ? 'owner' : 'tenant')}
     WHERE mobile = '+919800900007'`);
console.log(`  2B resident is now: ${asOwner ? 'OWNER (for the ballot capture — rerun without --owner after)' : 'tenant'}`);
console.log('\n  Every capture of the bill must now be retaken in one session, so they agree.\n');
