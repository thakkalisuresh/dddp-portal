/**
 * The announcement outbox: telling the building its bills exist.
 *
 * PUBLISHING IS NOT SENDING, and the gap between them is the whole point of
 * this module. `generateBills` writes 89 bills in one D1 batch and locks the
 * month; mailing 89 people cannot happen in the same request and must not be
 * attempted there. So publishing queues a row per bill, and the sending is a
 * separate, resumable, idempotent drain.
 *
 * THE NUMBER THAT FORCES THIS. `sendEmail` refreshes an OAuth token on every
 * call and nothing caches it, so a month is ~178 outbound fetches against the
 * free plan's 50 subrequests per invocation (docs/COSTS.md). Two things fix it
 * and both are here: `mailToken()` is minted ONCE per drain and threaded
 * through every send, which halves the count, and the drain takes 20 rows at a
 * time, which caps it. Twenty sends plus one refresh is 21.
 *
 * D1 does not compete for that budget — it is counted against a separate
 * internal allowance of 1,000 — which is why every row's status is written the
 * moment its send returns rather than batched at the end. A drain that dies
 * halfway has still recorded every send it made, so resuming cannot mail
 * anybody twice. Cheap here, and the alternative is the one failure that
 * reaches a neighbour instead of a log file.
 */

import { mailToken, sendEmail, mailConfigured } from './mailer.js';
import { renderEmail, para, figure, details, action, aside, SITE } from './email-template.js';
import { billPdf, istSlashDate } from './bill-pdf.js';
// The letterhead, shared with the download route. See js/association.js.
import { ASSOCIATION, billFileName } from '../../public/js/association.js';
import { generateBills } from './admin.js';
// The Worker's own labels, not the browser's. `dayAndMonth` is the one that
// takes a due date, which is a calendar day rather than an instant — see its
// comment in reminders.js for why that distinction has bitten before.
import { periodLabel, dayAndMonth } from './reminders.js';

/** How many are sent per drain. See the subrequest arithmetic above. */
export const DRAIN_SIZE = 20;

/**
 * How many times a failed row is retried before it is left for a human.
 *
 * A 4xx never gets even one — see `permanentFailure`. This is for the timeouts
 * and the 5xx, where trying again later is the whole remedy.
 */
export const MAX_ATTEMPTS = 3;

/**
 * Is this failure worth trying again?
 *
 * NOT EVERY FAILURE IS, and treating them alike is how a safety net becomes a
 * hammer. The reminder path learned this on 2026-08-14: a reading typed after
 * July closed retried every two seconds, and each attempt logged an error and
 * pushed a Telegram alert — 56 in a minute. A 4xx from Gmail is a refusal, and
 * the same message will be refused identically forever.
 *
 * 408 and 429 are the exceptions, as they are everywhere else in this codebase:
 * a timeout and a rate limit are both "later", not "never".
 */
export function permanentFailure(reason) {
  const m = /^gmail-(\d{3})$/.exec(String(reason ?? ''));
  if (!m) return false;
  const status = Number(m[1]);
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

/**
 * The statement that queues a month's announcements.
 *
 * INSERT…SELECT rather than one insert per bill, because the bills are being
 * written in the same batch and their ids do not exist yet on this side of the
 * wire. SQLite runs a batch in order, so by the time this statement runs the
 * rows it selects from are there.
 *
 * A resident with no email is queued as `unreachable` rather than `queued`.
 * They are the WhatsApp list, and a drain must never spend a subrequest
 * discovering an address that was never there.
 *
 * `bills.owner_id` is the join, never a re-derivation of occupancy: a bill
 * belongs to a PERSON once it exists, and recomputing `occupantOf` would hand a
 * tenant who moved out on the 20th their bill to whoever moved in
 * (docs/RESIDENTS-OCCUPANCY.md).
 */
export function queueStatement(env, period, now) {
  return env.DB.prepare(
    `INSERT INTO bill_announcements (bill_id, period, status, attempts, queued_at)
     SELECT b.id, b.period,
            CASE WHEN o.email IS NULL OR trim(o.email) = ''
                 THEN 'unreachable' ELSE 'queued' END,
            0, ?
       FROM bills b
       LEFT JOIN owners o ON o.id = b.owner_id
      WHERE b.period = ?
     ON CONFLICT (bill_id) DO NOTHING`
  ).bind(now, period);
}

/**
 * Generate the month's bills and queue the telling of it, as one act.
 *
 * `generateBills` keeps every refusal it already had — a locked period, an
 * absent or inherited rate, a blocked row, a partial month, and any flat with
 * no `owner_id` (DDP-BILL-015). None of them are relaxed here; publishing is
 * generation plus an outbox, not a way round generation.
 *
 * The queue rides in the SAME batch as the inserts. A month that was generated
 * but not queued would look published on every screen and tell nobody, and
 * nothing downstream would ever notice: there is no second pass that reconciles
 * bills against announcements, and there should not be one.
 */
export async function publishBills(env, period, actorId) {
  const now = new Date().toISOString();
  const result = await generateBills(env, period, actorId, {
    extraStatements: [queueStatement(env, period, now)],
  });

  const counts = await announcementCounts(env, period);
  return { ...result, published: true, publishedAt: now, announcements: counts };
}

/** How the month's telling stands: one row of counts, cheap enough to poll. */
export async function announcementCounts(env, period) {
  const rows = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM bill_announcements
      WHERE period = ? GROUP BY status`
  ).bind(period).all();

  const out = { queued: 0, sent: 0, unreachable: 0, failed: 0 };
  for (const r of rows.results ?? []) out[r.status] = r.n;
  out.total = out.queued + out.sent + out.unreachable + out.failed;
  // What a progress bar is a fraction of. `unreachable` is deliberately not
  // "remaining": those rows are done, in the only sense the drain can finish
  // them, and counting them as outstanding would leave the bar permanently
  // short of the end in a building where 103 of 105 accounts have no address.
  out.remaining = out.queued + out.failed;
  return out;
}

/**
 * One month's announcement email.
 *
 * Kept here rather than in the drain so a test can read the words without a
 * database, and so the plain-text and HTML halves cannot drift: renderEmail
 * builds both from this one description (see email-template.js).
 *
 * No payment link, matching the WhatsApp message and for the same reason — an
 * unsolicited message asking for money is the shape of a fraud, and B19 found
 * that `upi://` links do not survive Gmail anyway. The portal, where the
 * working is, is the only thing to tap.
 */
export function announcementEmail({ flat, period, total, dueDate, consumption, ratePerKg,
                                   origin = '' }) {
  // A request's own origin when there is one — so a staging drain links to
  // staging — and the portal's address when there is not, which is the 3am
  // sweep. An email whose only link is `/dashboard` is an email nobody can act
  // on from their phone.
  const site = origin || SITE;
  return renderEmail({
    title: `Your ${periodLabel(period)} gas bill`,
    preview: `₹${total} for flat ${flat}, due ${dayAndMonth(dueDate)}.`,
    blocks: [
      para(`The gas bill for flat ${flat} is ready.`),
      figure(`₹${total}`, `due ${dayAndMonth(dueDate)}`),
      details([
        ['Flat', flat],
        ['Month', periodLabel(period)],
        ['Gas used', `${consumption} kg`],
        ['Rate', `₹${ratePerKg} per kg`],
      ]),
      para('The full working — your meter reading, last month’s, and what '
        + 'the difference came to — is on the portal.'),
      action('See the working', `${site}/dashboard`),
      aside('Paying is done on the portal too. Nobody from the association will '
        + 'ever send you a payment link in a message.'),
    ],
  });
}

/**
 * Send up to `limit` of a month's queued announcements.
 *
 * Resumable by construction: it asks for whatever is still outstanding, so
 * calling it in a loop from the console and having the 3am cron call it again
 * are the same operation. A `sent` row is never selected, which is what makes
 * the retry safe rather than merely unlikely.
 *
 * `failed` rows come back into the queue until MAX_ATTEMPTS, so a Gmail hiccup
 * heals overnight without anybody being told. A permanent refusal is parked at
 * MAX_ATTEMPTS immediately, with its reason on the row, because retrying it is
 * the bug rather than the remedy.
 */
export async function drainAnnouncements(env, period, { limit = DRAIN_SIZE, origin = '' } = {}) {
  if (!mailConfigured(env)) {
    // Not an error, and deliberately not a failure written to the rows. Gmail
    // is still unconfigured in production (W1); the month publishes, the bills
    // are live, and the WhatsApp list is how the building hears about it. Rows
    // stay queued for the day the credentials land.
    const counts = await announcementCounts(env, period);
    return { sent: 0, failed: 0, remaining: counts.remaining, reason: 'not-configured' };
  }

  const rows = await env.DB.prepare(
    // Everything a message needs, in one query. A second query per row would
    // be 20 more round trips for values the join already has.
    // The extra columns past `o.email` are the attached PDF's, and they are
    // free: the join was already being made, and a second query per row would
    // be 20 more round trips for values this one already has.
    `SELECT a.bill_id, a.attempts, b.flat, b.period, b.total, b.consumption,
            b.rate_per_kg, p.due_date, o.email, o.name,
            b.gas_amount, b.other_charges, b.additional_charges, b.late_fee,
            b.created_at, b.status, b.paid_at
       FROM bill_announcements a
       JOIN bills b ON b.id = a.bill_id
       JOIN periods p ON p.period = b.period
       LEFT JOIN owners o ON o.id = b.owner_id
      WHERE a.period = ?
        AND (a.status = 'queued' OR (a.status = 'failed' AND a.attempts < ?))
      ORDER BY b.flat
      LIMIT ?`
  ).bind(period, MAX_ATTEMPTS, limit).all();

  const queue = rows.results ?? [];
  if (!queue.length) {
    const counts = await announcementCounts(env, period);
    return { sent: 0, failed: 0, remaining: counts.remaining };
  }

  // ONCE. This line is the entire reason the outbox exists — see the module
  // comment. Minting per send is what put a month at ~178 subrequests.
  const auth = await mailToken(env);
  if (!auth.ok) {
    const counts = await announcementCounts(env, period);
    return { sent: 0, failed: 0, remaining: counts.remaining, reason: auth.reason };
  }

  let sent = 0;
  let failed = 0;

  for (const row of queue) {
    // Belt and braces: the query cannot return one of these, because a row
    // with no address was queued as `unreachable` and is never selected. If it
    // ever does, it is a bug worth not turning into a Gmail 400.
    if (!row.email) {
      await mark(env, row.bill_id, 'unreachable', row.attempts, null);
      continue;
    }

    const mail = announcementEmail({
      flat: row.flat, period: row.period, total: row.total, dueDate: row.due_date,
      consumption: row.consumption, ratePerKg: row.rate_per_kg, origin,
    });

    const res = await sendEmail(env, {
      to: row.email, subject: mail.subject, text: mail.text, html: mail.html,
      attachment: billAttachment(row),
    }, auth.token);

    if (res.sent) {
      await mark(env, row.bill_id, 'sent', row.attempts + 1, null);
      sent += 1;
      continue;
    }

    // A permanent refusal is parked at the ceiling rather than counted up to
    // it: three identical 400s three nights running tell nobody anything, and
    // each one costs a subrequest the next month's drain could have used.
    const attempts = permanentFailure(res.reason) ? MAX_ATTEMPTS : row.attempts + 1;
    await mark(env, row.bill_id, 'failed', attempts, res.reason ?? 'unknown');
    failed += 1;
  }

  const counts = await announcementCounts(env, period);
  return { sent, failed, remaining: counts.remaining };
}

/**
 * The bill as an attached PDF, or nothing at all.
 *
 * NEVER THROWS. A malformed name or an unexpected null must not cost a
 * resident their announcement: the email carries every figure in its own body,
 * so a missing attachment is a smaller failure than a bill nobody was told
 * about — and a deterministic throw here would burn all three attempts and
 * park the row as permanently failed.
 *
 * The rupee sign is deliberately absent. See lib/bill-pdf.js for what it would
 * have cost to keep it, and note that the email BODY still carries it: HTML
 * has no such limitation, and neither does the portal.
 */
function billAttachment(row) {
  try {
    const settled = row.status === 'paid' || row.status === 'waived';
    return {
      filename: `${billFileName(row.flat, row.period)}.pdf`,
      type: 'application/pdf',
      bytes: billPdf({
        association: ASSOCIATION,
        flat: row.flat,
        name: row.name ?? '',
        period: periodLabel(row.period),
        billDate: row.created_at ? istSlashDate(row.created_at) : null,
        consumption: row.consumption,
        ratePerKg: row.rate_per_kg,
        gasAmount: row.gas_amount,
        otherCharges: row.other_charges,
        additionalCharges: row.additional_charges,
        lateFee: row.late_fee,
        total: row.total,
        status: settled
          ? (row.paid_at ? `Paid on ${dayAndMonth(row.paid_at)}` : 'Settled')
          : (row.due_date ? `Payable before ${dayAndMonth(row.due_date)}` : null),
      }),
    };
  } catch {
    return null;
  }
}

function mark(env, billId, status, attempts, lastError) {
  return env.DB.prepare(
    `UPDATE bill_announcements
        SET status = ?, attempts = ?, last_error = ?,
            sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END
      WHERE bill_id = ?`
  ).bind(status, attempts, lastError, status, new Date().toISOString(), billId).run();
}

/**
 * Every month with announcements still outstanding — the cron's worklist.
 *
 * Bounded, because the sweep runs beside the late-fee job and money comes
 * first. A month that needs more than one night's sweep is a month where Gmail
 * was down, and it will be picked up again tomorrow.
 */
export async function pendingAnnouncementPeriods(env, { limit = 3 } = {}) {
  const rows = await env.DB.prepare(
    `SELECT period, COUNT(*) AS n FROM bill_announcements
      WHERE status = 'queued' OR (status = 'failed' AND attempts < ?)
      GROUP BY period ORDER BY period DESC LIMIT ?`
  ).bind(MAX_ATTEMPTS, limit).all();
  return (rows.results ?? []).map((r) => r.period);
}

/**
 * The 3am sweep. The treasurer must be free to close the laptop.
 *
 * Same drain, same idempotency, same token discipline — one refresh per month
 * swept rather than one per message. It never throws: an announcement that
 * cannot be sent must not cost the building its late-fee run, which is the
 * rule every other job in cron.js follows.
 */
export async function sweepAnnouncements(env, { origin = '' } = {}) {
  const periods = await pendingAnnouncementPeriods(env);
  const out = [];
  for (const period of periods) {
    try {
      const res = await drainAnnouncements(env, period, { origin });
      out.push({ period, ...res });
    } catch (err) {
      out.push({ period, sent: 0, failed: 0, reason: err?.code ?? 'threw' });
    }
  }
  return out;
}

/**
 * The flats nobody could email, with who to WhatsApp about it.
 *
 * Read off `bills.owner_id`, never recomputed: the bill exists, so it already
 * knows whose it is. Deliberately available only after publishing — before it
 * there is no bill to tell anyone about, and a message quoting a figure that
 * could still change is worse than no message.
 */
export async function unreachableFlats(env, period) {
  const rows = await env.DB.prepare(
    `SELECT b.flat, b.total, o.id AS owner_id, o.name, o.mobile, o.relationship
       FROM bill_announcements a
       JOIN bills b ON b.id = a.bill_id
       LEFT JOIN owners o ON o.id = b.owner_id
      WHERE a.period = ? AND a.status = 'unreachable'
      ORDER BY b.flat`
  ).bind(period).all();
  return rows.results ?? [];
}
