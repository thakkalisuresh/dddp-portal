/**
 * The maintenance quarter's life, as scheduled work: draft, confirm, issue,
 * charge the fee.
 *
 * Hangs off the jobs that already run. Nothing here invents a schedule of its
 * own — the midnight run applies fees, the 08:30 run does everything else, and
 * this module supplies the maintenance half of each.
 *
 * IDEMPOTENCE IS THE PROPERTY THAT MATTERS, as it is in cron.js. Every one of
 * these runs nightly, Cloudflare may invoke a trigger more than once, and an
 * admin may set any of it going by hand. So: a quarter is drafted once because
 * its row is a PRIMARY KEY, bills are issued once because of UNIQUE (flat,
 * quarter), letters are queued once because of PRIMARY KEY (bill_id, kind), and
 * the fee is charged once because of `late_fee_at IS NULL`. Four different
 * mechanisms, all of them the database's rather than this file's, because a
 * guard in application code is one retry away from not being a guard.
 */

import {
  assessFlat, previewQuarter, rateFor, dueDateFor, quarterOf, nextQuarter,
  quarterRange, describeQuarter, maintLateFeeDecision, applyMaintLateFee,
  tenancyReadiness, DEFAULT_OWNER_RATE, DEFAULT_TENANT_RATE, DEFAULT_LATE_FEE, DUE_DAYS,
} from './maint.js';
import { mailToken, sendEmail, mailConfigured } from './mailer.js';
import { letterFor, MAIL_KINDS } from './maint-mail.js';
import { renderEmail, para, figure, details, action, aside, SITE } from './email-template.js';
import { istToday } from './time.js';
import { fail } from './errors.js';

/**
 * How far ahead a draft appears. Seven days, so the Q4 draft lands on
 * 24 September for a quarter starting on 1 October.
 *
 * Pinned as a number in one place rather than left as "about a week" in a
 * sentence, so that if the committee wants more warning it is an edit here
 * rather than an argument about what "about" meant.
 */
export const DRAFT_LEAD_DAYS = 7;

/* ── drafting ─────────────────────────────────────────────────────────────  */

/** The day a quarter's draft is due to appear. */
export function draftDateFor(quarter) {
  const { start } = quarterRange(quarter);
  return dueDateFor(start, -DRAFT_LEAD_DAYS);
}

/**
 * Create the draft for the next quarter, if it is time and it does not exist.
 *
 * Born with the DEFAULT rates rather than the previous quarter's. That is the
 * opposite of a convenience and it is deliberate: `assertRateSetForPeriod` in
 * lib/billing.js exists because a rate silently carried forward is the worst
 * failure a billing system can have — ninety-nine bills go out looking entirely
 * normal and every one is wrong. The defaults are the committee's standing
 * figures, and an admin confirms them on screen before anything is issued.
 *
 * Returns what it did, so the caller can report it. Never throws on an existing
 * row: a second run on the same night is an ordinary event, not a fault.
 */
export async function ensureDraft(env, { today = istToday() } = {}) {
  // The quarter after the one today falls in. A draft is always for the NEXT
  // quarter — drafting the current one would mean billing a quarter that is
  // already under way, which only happens when somebody adds a bill by hand.
  const quarter = nextQuarter(quarterOf(today));
  if (today < draftDateFor(quarter)) return { created: false, reason: 'too-early', quarter };

  const existing = await env.DB.prepare(
    'SELECT quarter, status FROM maint_quarters WHERE quarter = ?'
  ).bind(quarter).first();
  if (existing) return { created: false, reason: 'exists', quarter, status: existing.status };

  const { start } = quarterRange(quarter);
  await env.DB.prepare(
    `INSERT INTO maint_quarters
       (quarter, owner_rate, tenant_rate, late_fee, issue_date, due_date, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)
     ON CONFLICT (quarter) DO NOTHING`
  ).bind(
    quarter, DEFAULT_OWNER_RATE, DEFAULT_TENANT_RATE, DEFAULT_LATE_FEE,
    // Issued on the quarter's first day unless an admin moves it, which they
    // may do right up until they schedule.
    start, dueDateFor(start, DUE_DAYS), new Date().toISOString(),
  ).run();

  return { created: true, quarter, issueDate: start };
}

/* ── the confirm reminder ─────────────────────────────────────────────────  */

/**
 * Who gets asked to confirm the quarter: every admin EXCEPT whoever scheduled
 * the previous one.
 *
 * The exclusion is the committee's, and the reasoning is about turn-taking
 * rather than suspicion — the same person quietly doing it every quarter is how
 * a committee ends up with one member who knows how the billing works and four
 * who do not. If that leaves nobody, everybody is asked: a rule about sharing
 * the work must not be able to stop the work happening.
 */
export async function confirmRecipients(env, quarter) {
  const previous = await env.DB.prepare(
    `SELECT scheduled_by FROM maint_quarters
      WHERE quarter < ? AND scheduled_by IS NOT NULL
      ORDER BY quarter DESC LIMIT 1`
  ).bind(quarter).first();

  const rows = await env.DB.prepare(
    `SELECT id, name, email FROM owners
      WHERE active = 1 AND role IN ('admin','superadmin')
        AND email IS NOT NULL AND trim(email) <> ''
      ORDER BY id`
  ).all();

  const admins = rows.results ?? [];
  const last = previous?.scheduled_by ?? null;
  const eligible = admins.filter((a) => a.id !== last);
  return eligible.length ? eligible : admins;
}

/** PLACEHOLDER COPY — the committee approves wording before testing. */
export function confirmEmail({ quarter, issueDate, dueDate, preview, origin = '' }) {
  const site = origin || SITE;
  return renderEmail({
    title: `Confirm maintenance for ${describeQuarter(quarter)}`,
    preview: `${preview.willBill} flats, ₹${preview.total}. Nothing has been sent to residents.`,
    blocks: [
      para(`The draft for ${describeQuarter(quarter)} is ready and needs an admin to `
        + 'confirm it. Nothing reaches residents until somebody does.'),
      figure(`₹${preview.total}`, `${preview.willBill} flats`),
      details([
        ['Owner-occupied', `${preview.ownerCount} flats`],
        ['Let', `${preview.tenantCount} flats`],
        ['Issue date', issueDate],
        ['Due date', dueDate],
      ]),
      ...(preview.unresolved.length
        ? [para(`${preview.unresolved.length} flat(s) have somebody living there and no `
            + 'owner on record, so they cannot be billed. They need fixing first: '
            + preview.unresolved.map((u) => u.flat).join(', '))]
        : []),
      action('Review and schedule', `${site}/admin`),
      aside('Confirming records the issue date and fixes the rates. The bills '
        + 'themselves are worked out on the issue date itself.'),
    ],
  });
}

/**
 * Ask the admins to confirm, at most once a night, and only while it is still
 * a draft.
 *
 * `reminded_at` is stamped ONLY on a send that landed. A night where Gmail was
 * down must retry tomorrow rather than being silently spent — the marker exists
 * to stop seven identical emails, not to stop the one that matters.
 */
export async function remindToConfirm(env, { today = istToday(), origin = '' } = {}) {
  const quarter = await env.DB.prepare(
    `SELECT * FROM maint_quarters WHERE status = 'draft' ORDER BY quarter LIMIT 1`
  ).first();
  if (!quarter) return { sent: 0, reason: 'no-draft' };
  if (quarter.reminded_at && String(quarter.reminded_at).slice(0, 10) >= String(today)) {
    return { sent: 0, reason: 'already-today' };
  }
  if (!mailConfigured(env)) return { sent: 0, reason: 'not-configured' };

  const recipients = await confirmRecipients(env, quarter.quarter);
  if (!recipients.length) return { sent: 0, reason: 'no-admins' };

  const preview = await previewFor(env, quarter);
  const mail = confirmEmail({
    quarter: quarter.quarter, issueDate: quarter.issue_date,
    dueDate: quarter.due_date, preview, origin,
  });

  const auth = await mailToken(env);
  if (!auth.ok) return { sent: 0, reason: auth.reason };

  let sent = 0;
  for (const admin of recipients) {
    const res = await sendEmail(env, {
      to: admin.email, subject: mail.subject, text: mail.text, html: mail.html,
    }, auth.token);
    if (res.sent) sent += 1;
  }

  // Only on a send that actually happened. See the comment on the column.
  if (sent) {
    await env.DB.prepare('UPDATE maint_quarters SET reminded_at = ? WHERE quarter = ?')
      .bind(new Date().toISOString(), quarter.quarter).run();
  }
  return { sent, quarter: quarter.quarter, recipients: recipients.length };
}

/* ── scheduling ───────────────────────────────────────────────────────────  */

/** Everyone the billing cares about, one row per flat. */
export async function flatsWithPeople(env) {
  const rows = await env.DB.prepare(
    `SELECT f.flat,
            o.id, o.name, o.email, o.relationship, o.active,
            o.moved_in_at, o.moved_out_at, o.lease_ends_at, o.tenancy_confirmed_at
       FROM flats f
       LEFT JOIN owners o ON o.flat = f.flat
      WHERE f.active = 1
      ORDER BY f.flat, o.id`
  ).all();

  const byFlat = new Map();
  for (const r of rows.results ?? []) {
    if (!byFlat.has(r.flat)) byFlat.set(r.flat, { flat: r.flat, people: [] });
    if (r.id) byFlat.get(r.flat).people.push(r);
  }
  return [...byFlat.values()];
}

async function previewFor(env, quarter) {
  return previewQuarter({
    rows: await flatsWithPeople(env),
    quarter,
    issueDate: quarter.issue_date,
  });
}

/**
 * Confirm a quarter: record the issue date, fix the rates, and record what the
 * admin was looking at when they did.
 *
 * REFUSES ON STALE TENANCY. `tenancyReadiness` blocks on a lease that ended
 * before the issue date, because that is a positive statement that somebody has
 * gone — and scheduling is the moment a stale tenancy stops being harmless,
 * since it fixes ninety-nine rates at once. An undated lease only warns: most
 * rows have no end date until the roster is filled in, and refusing to bill the
 * building until every one is entered would miss the quarter entirely.
 *
 * Nothing reaches residents here. The schedule can still be moved or cancelled
 * right up until the issue date.
 */
export async function scheduleQuarter(env, quarterLabel, {
  actorId, issueDate = null, acknowledgeUndated = false,
} = {}) {
  const quarter = await env.DB.prepare('SELECT * FROM maint_quarters WHERE quarter = ?')
    .bind(quarterLabel).first();
  if (!quarter) fail('DDP-MAINT-007', { quarter: quarterLabel });
  if (quarter.status !== 'draft') {
    fail('DDP-MAINT-008', { quarter: quarterLabel, status: quarter.status });
  }

  const issue = issueDate ?? quarter.issue_date;
  const rows = await flatsWithPeople(env);

  const readiness = tenancyReadiness({ rows, issueDate: issue });
  if (!readiness.ok) {
    return { scheduled: false, reason: 'stale-tenancy', readiness };
  }

  // AN UNDATED LEASE IS SCHEDULED PAST DELIBERATELY OR NOT AT ALL.
  //
  // The rule above refuses an ENDED lease outright, because that is a positive
  // statement that somebody has gone. An undated one is different and used to
  // only warn, for a reason worth keeping: most rows have no end date until the
  // roster is filled in, and refusing to bill the building until every one is
  // entered would miss the quarter entirely.
  //
  // But a warning nobody reads is not a decision. So the refusal is now
  // conditional on an acknowledgement the caller has to send: the admin screen
  // sets it once they have worked through the flagged rows, and anybody calling
  // this endpoint directly gets a refusal naming what to acknowledge rather
  // than a warning that scrolls past. One rule, in one place, for the screen
  // and the cron alike — and the escape hatch that comment was protecting is
  // still there, just no longer silent.
  if (readiness.undated.length && !acknowledgeUndated) {
    return {
      scheduled: false,
      reason: 'undated-leases',
      undated: readiness.undated,
      readiness,
    };
  }

  const preview = previewQuarter({ rows, quarter: { ...quarter, issue_date: issue }, issueDate: issue });
  if (preview.unresolved.length) {
    // A flat with somebody living in it and no owner on record is the one skip
    // a human must resolve. Billing around it silently means that household is
    // never asked for maintenance and nobody notices for a year.
    return { scheduled: false, reason: 'unresolved-flats', unresolved: preview.unresolved };
  }

  await env.DB.prepare(
    `UPDATE maint_quarters
        SET status = 'scheduled', issue_date = ?, due_date = ?,
            scheduled_by = ?, scheduled_at = ?,
            scheduled_flats = ?, scheduled_total = ?
      WHERE quarter = ? AND status = 'draft'`
  ).bind(
    issue, dueDateFor(issue, DUE_DAYS), actorId, new Date().toISOString(),
    preview.willBill, preview.total, quarterLabel,
  ).run();

  return {
    scheduled: true, quarter: quarterLabel, issueDate: issue, preview, readiness,
    // Recorded in the result so the audit entry can say whether this quarter
    // was scheduled with undated leases knowingly left in it.
    acknowledgedUndated: readiness.undated.length > 0,
  };
}

/* ── issuing ──────────────────────────────────────────────────────────────  */

/**
 * Raise the quarter's bills and queue the telling of it, as one act.
 *
 * The queue rides in the SAME batch as the inserts, exactly as `publishBills`
 * does for gas: a quarter that was issued but not queued would look issued on
 * every screen and tell nobody, and nothing downstream reconciles bills against
 * letters. There is no second pass, and there should not be one.
 *
 * Every bill is computed FRESH, here, on the issue date. `scheduled_flats` and
 * `scheduled_total` are not inputs — they are only what the admin was shown, so
 * the summary below can name the difference.
 */
export async function issueQuarter(env, quarterLabel, { today = istToday() } = {}) {
  const quarter = await env.DB.prepare('SELECT * FROM maint_quarters WHERE quarter = ?')
    .bind(quarterLabel).first();
  if (!quarter) fail('DDP-MAINT-007', { quarter: quarterLabel });
  if (quarter.status !== 'scheduled') {
    return { issued: false, reason: `status-${quarter.status}` };
  }
  if (today < quarter.issue_date) return { issued: false, reason: 'not-yet' };

  const rows = await flatsWithPeople(env);
  const now = new Date().toISOString();
  const statements = [];
  const bills = [];

  for (const row of rows) {
    const a = assessFlat({ flat: row.flat, people: row.people, issueDate: quarter.issue_date });
    if (!a.bill) continue;
    const rate = rateFor(a.basis, quarter);
    bills.push({ flat: row.flat, basis: a.basis, rate, ownerId: a.billedTo.id });

    statements.push(env.DB.prepare(
      // ON CONFLICT DO NOTHING against UNIQUE (flat, quarter): re-running the
      // issue job cannot raise a second bill, which is what makes it safe for
      // the nightly sweep to attempt a quarter it may already have done.
      `INSERT INTO maint_bills
         (flat, quarter, owner_id, rate_applied, basis, total, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'unpaid', ?)
       ON CONFLICT (flat, quarter) DO NOTHING`
    ).bind(row.flat, quarterLabel, a.billedTo.id, rate, a.basis, rate, now));
  }

  // INSERT…SELECT, because the bills are being written in this same batch and
  // their ids do not exist on this side of the wire yet. SQLite runs a batch in
  // order, so by the time this runs the rows it selects from are there.
  //
  // A resident with no address is queued `unreachable` rather than `queued`: a
  // drain must never spend a subrequest discovering an address that was never
  // there.
  statements.push(env.DB.prepare(
    `INSERT INTO maint_mail (bill_id, kind, status, attempts, queued_at)
     SELECT b.id, 'issued',
            CASE WHEN o.email IS NULL OR trim(o.email) = ''
                 THEN 'unreachable' ELSE 'queued' END,
            0, ?
       FROM maint_bills b
       LEFT JOIN owners o ON o.id = b.owner_id
      WHERE b.quarter = ?
     ON CONFLICT (bill_id, kind) DO NOTHING`
  ).bind(now, quarterLabel));

  statements.push(env.DB.prepare(
    `UPDATE maint_quarters SET status = 'issued', issued_at = ? WHERE quarter = ? AND status = 'scheduled'`
  ).bind(now, quarterLabel));

  await env.DB.batch(statements);

  const total = bills.reduce((sum, b) => sum + b.rate, 0);
  return {
    issued: true,
    quarter: quarterLabel,
    count: bills.length,
    total,
    // What the admin confirmed, against what actually went out. A tenancy that
    // changed between scheduling and issuing shows up here as a line in the
    // summary rather than as a surprise in the next dues report.
    expected: { flats: quarter.scheduled_flats, total: quarter.scheduled_total },
    drift: quarter.scheduled_flats == null ? null : {
      flats: bills.length - quarter.scheduled_flats,
      total: total - quarter.scheduled_total,
    },
  };
}

/* ── the late fee ─────────────────────────────────────────────────────────  */

/**
 * Charge the quarter's late fees. The nightly backstop.
 *
 * Runs at 00:00 IST beside the gas fee run, not at 08:30, for the reason gas
 * learned: the pay link is built from `total`, so a resident paying at 00:05 on
 * a fee day would be handed the pre-fee amount, pay it, and land in
 * reconciliation short. At ₹750 against gas's ₹50 that is not an annoyance, it
 * is an argument at a committee meeting.
 */
export async function applyMaintLateFees(env, { today = istToday() } = {}) {
  const quarters = await env.DB.prepare(
    `SELECT quarter, due_date, late_fee FROM maint_quarters
      WHERE late_fee > 0 AND status IN ('issued','locked') AND date(due_date, '+1 day') <= ?`
  ).bind(today).all();

  const results = [];

  for (const q of quarters.results ?? []) {
    const bills = await env.DB.prepare(
      // Every column the decision reads must be in this SELECT. One left out
      // arrives as undefined, reads as "no exemption" or "no pending approval",
      // and charges a bill that should have been held — and unit tests would
      // not catch it, because they hand the decision a bill object directly.
      `SELECT b.id, b.flat, b.status, b.total, b.late_fee_at, b.owner_id,
              e.ends_at AS exempt_until,
              EXISTS (SELECT 1 FROM maint_approval_requests r
                       WHERE r.bill_id = b.id AND r.status = 'pending') AS pending_approval
         FROM maint_bills b
         LEFT JOIN maint_fee_exemptions e
                ON e.owner_id = b.owner_id AND e.approved_by IS NOT NULL AND e.ends_at >= ?
        WHERE b.quarter = ?`
    ).bind(today, q.quarter).all();

    const charge = [];
    for (const bill of bills.results ?? []) {
      const decision = maintLateFeeDecision(bill, {
        today, dueDate: q.due_date, exemptUntil: bill.exempt_until ?? null,
      });
      if (decision.action === 'charge') {
        charge.push({ ...bill, newTotal: applyMaintLateFee(bill.total, q.late_fee) });
      }
    }

    if (charge.length) {
      const at = new Date().toISOString();
      await env.DB.batch(charge.flatMap((b) => [
        env.DB.prepare(
          // The guard, and the whole reason two runs can race freely: whichever
          // arrives first wins and the second updates nothing.
          `UPDATE maint_bills SET late_fee = ?, late_fee_at = ?, total = ?
            WHERE id = ? AND late_fee_at IS NULL`
        ).bind(q.late_fee, at, b.newTotal, b.id),
        // The overdue letter rides with the fee, in the same batch, so a bill
        // can never be charged without the resident being told why.
        env.DB.prepare(
          `INSERT INTO maint_mail (bill_id, kind, status, attempts, queued_at)
           SELECT b.id, 'overdue',
                  CASE WHEN o.email IS NULL OR trim(o.email) = ''
                       THEN 'unreachable' ELSE 'queued' END,
                  0, ?
             FROM maint_bills b LEFT JOIN owners o ON o.id = b.owner_id
            WHERE b.id = ?
           ON CONFLICT (bill_id, kind) DO NOTHING`
        ).bind(at, b.id),
      ]));
    }

    results.push({ quarter: q.quarter, charged: charge.length });
  }

  return results;
}

/**
 * Charge ONE bill, now, if it is due one. The first-touch twin.
 *
 * Exists for the same reason `applyLateFeeToBill` does in cron.js: Cloudflare
 * cron triggers are scheduled, not punctual, so the nightly job delivers
 * "midnight, roughly". The pay link is built from `total`, so the gap is where
 * a resident is handed a stale amount. Applying on first touch — a dashboard
 * load, a tap on Pay — closes it, and `late_fee_at IS NULL` lets the two race.
 */
export async function applyLateFeeToMaintBill(env, billId, { today = istToday() } = {}) {
  const bill = await env.DB.prepare(
    `SELECT b.id, b.status, b.total, b.late_fee_at, b.owner_id,
            q.due_date, q.late_fee AS quarter_late_fee,
            e.ends_at AS exempt_until,
            EXISTS (SELECT 1 FROM maint_approval_requests r
                     WHERE r.bill_id = b.id AND r.status = 'pending') AS pending_approval
       FROM maint_bills b
       JOIN maint_quarters q ON q.quarter = b.quarter
       LEFT JOIN maint_fee_exemptions e
              ON e.owner_id = b.owner_id AND e.approved_by IS NOT NULL AND e.ends_at >= ?
      WHERE b.id = ?`
  ).bind(today, billId).first();

  if (!bill || !(Number(bill.quarter_late_fee) > 0)) return { applied: false };

  const decision = maintLateFeeDecision(bill, {
    today, dueDate: bill.due_date, exemptUntil: bill.exempt_until ?? null,
  });
  if (decision.action !== 'charge') return { applied: false, reason: decision.reason };

  const total = applyMaintLateFee(bill.total, bill.quarter_late_fee);
  const at = new Date().toISOString();
  const res = await env.DB.prepare(
    `UPDATE maint_bills SET late_fee = ?, late_fee_at = ?, total = ?
      WHERE id = ? AND late_fee_at IS NULL`
  ).bind(bill.quarter_late_fee, at, total, billId).run();

  // meta.changes is 0 when the nightly run got there first. Reporting `applied`
  // off the decision instead would tell the caller to display a fee it did not
  // write — and on a page load that is the number a resident is about to pay.
  if (!res?.meta?.changes) return { applied: false, reason: 'raced' };

  return { applied: true, lateFee: bill.quarter_late_fee, total, lateFeeAt: at };
}

/* ── the run-up letters ───────────────────────────────────────────────────  */

/**
 * Queue the two reminders that fall between issuing and the due date.
 *
 * Queued by DATE rather than sent directly, so they join the same drain, the
 * same retry policy and the same once-only key as everything else. A letter
 * whose moment has passed is never queued late: if the portal was down on the
 * 8th, the `due_soon` row simply never appears, which is better than a
 * "three days to go" email arriving on the 12th.
 */
export async function queueDueLetters(env, { today = istToday() } = {}) {
  const now = new Date().toISOString();
  const res = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO maint_mail (bill_id, kind, status, attempts, queued_at)
       SELECT b.id, 'due_soon',
              CASE WHEN o.email IS NULL OR trim(o.email) = '' THEN 'unreachable' ELSE 'queued' END,
              0, ?
         FROM maint_bills b
         JOIN maint_quarters q ON q.quarter = b.quarter
         LEFT JOIN owners o ON o.id = b.owner_id
        WHERE date(q.due_date, '-3 day') = ?
          AND b.status NOT IN ('paid','waived','cancelled')
       ON CONFLICT (bill_id, kind) DO NOTHING`
    ).bind(now, today),
    env.DB.prepare(
      `INSERT INTO maint_mail (bill_id, kind, status, attempts, queued_at)
       SELECT b.id, 'due',
              CASE WHEN o.email IS NULL OR trim(o.email) = '' THEN 'unreachable' ELSE 'queued' END,
              0, ?
         FROM maint_bills b
         JOIN maint_quarters q ON q.quarter = b.quarter
         LEFT JOIN owners o ON o.id = b.owner_id
        WHERE q.due_date = ?
          AND b.status NOT IN ('paid','waived','cancelled')
       ON CONFLICT (bill_id, kind) DO NOTHING`
    ).bind(now, today),
  ]);
  return { dueSoon: res?.[0]?.meta?.changes ?? 0, due: res?.[1]?.meta?.changes ?? 0 };
}

/**
 * The maintenance half of the 08:30 run: draft, remind, issue, queue.
 *
 * Every step swallows its own failure. The rule cron.js follows throughout is
 * that a convenience must never cost the building its money work, and the same
 * applies inside this module: a reminder that throws must not stop the quarter
 * being issued.
 */
export async function runMaintenance(env, { today = istToday(), origin = '' } = {}) {
  const draft = await ensureDraft(env, { today }).catch((e) => ({ created: false, reason: e?.code ?? 'threw' }));
  const reminded = await remindToConfirm(env, { today, origin }).catch((e) => ({ sent: 0, reason: e?.code ?? 'threw' }));

  const due = await env.DB.prepare(
    `SELECT quarter FROM maint_quarters WHERE status = 'scheduled' AND issue_date <= ? ORDER BY quarter`
  ).bind(today).all().catch(() => ({ results: [] }));

  const issued = [];
  for (const q of due.results ?? []) {
    issued.push(await issueQuarter(env, q.quarter, { today })
      .catch((e) => ({ issued: false, quarter: q.quarter, reason: e?.code ?? 'threw' })));
  }

  const letters = await queueDueLetters(env, { today }).catch(() => ({ dueSoon: 0, due: 0 }));

  return { draft, reminded, issued, letters };
}

/* ── the letter preview ───────────────────────────────────────────────────  */

/**
 * The letters a quarter WOULD send, rendered for one flat, sending nothing.
 *
 * This is the button above "Schedule this quarter": the admin commits the
 * building to four letters, and until now could not read one. It is also where
 * the committee reads the final copy in place once the wording pass lands.
 *
 * WRITES NOTHING, and the outbox is the reason it is worth saying twice. A row
 * in `maint_mail` is keyed UNIQUE (bill_id, kind), and the drain skips a key
 * that is already there — so a preview that queued its own row would silently
 * cost a resident the real letter. The worst possible failure for a button
 * whose entire job is reassurance. Nothing here touches `maint_mail`, and a
 * test asserts the table is untouched after a preview.
 *
 * READS ONLY THE QUARTER'S OWN DRAFTS. The flat must be one this quarter would
 * bill, so the preview cannot become a way to read a letter about a flat the
 * Bills screen would not already show.
 *
 * Before a quarter is issued there are no bills, so the row is PROJECTED with
 * exactly the rule that will issue it — `assessFlat` then `rateFor`, the same
 * two calls `issueQuarter` makes. A preview computed any other way would be a
 * letter nobody is going to receive.
 */
export async function previewLetter(env, quarterLabel, { flat, kind = 'issued', today = istToday(), origin = '' } = {}) {
  if (!MAIL_KINDS.includes(kind)) fail('DDP-MAINT-009', { kind });

  const quarter = await env.DB.prepare('SELECT * FROM maint_quarters WHERE quarter = ?')
    .bind(quarterLabel).first();
  if (!quarter) fail('DDP-MAINT-007', { quarter: quarterLabel });

  // An issued quarter has the real row, and the real row is what the resident
  // will be reading against — including a late fee that has already landed.
  const bill = await env.DB.prepare(
    'SELECT * FROM maint_bills WHERE quarter = ? AND flat = ?'
  ).bind(quarterLabel, flat).first();

  let row;
  if (bill) {
    row = {
      ...bill,
      due_date: quarter.due_date,
      quarter_late_fee: quarter.late_fee,
    };
  } else {
    const found = (await flatsWithPeople(env)).find((r) => r.flat === flat);
    const assessment = found
      ? assessFlat({ flat, people: found.people, issueDate: quarter.issue_date })
      : null;
    // Not "flat not found": the honest answer is that this quarter would not
    // bill it, which is also true of an empty flat and of one whose only
    // resident moved out before the issue date.
    if (!assessment?.bill) fail('DDP-MAINT-010', { quarter: quarterLabel, flat });
    const rate = rateFor(assessment.basis, quarter);
    row = {
      flat,
      quarter: quarterLabel,
      basis: assessment.basis,
      rate_applied: rate,
      // The projected total is the rate — except for the overdue letter, which
      // is by definition read after the fee has landed and whose figure breaks
      // itself down as charges plus fee. Previewing it against the bare rate
      // would show an admin arithmetic that does not add up, which is exactly
      // the kind of thing this button exists to catch before residents see it.
      total: kind === 'overdue' ? rate + quarter.late_fee : rate,
      due_date: quarter.due_date,
      quarter_late_fee: quarter.late_fee,
    };
  }

  const letter = letterFor(kind, row, { origin, today });
  return {
    quarter: quarterLabel,
    quarterLabel: describeQuarter(quarterLabel),
    flat,
    kind,
    basis: row.basis,
    // Whether the admin is reading a real bill or a projection of one. The
    // difference matters: before issuing, every figure here is still subject to
    // a tenancy change, and the screen says so rather than implying otherwise.
    projected: !bill,
    subject: letter.subject,
    text: letter.text,
    html: letter.html,
  };
}
