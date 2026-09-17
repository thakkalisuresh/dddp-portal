/**
 * The maintenance outbox: four letters per bill, and the drain that sends them.
 *
 * ISSUING IS NOT SENDING. The issue job writes up to 99 bills in one D1 batch;
 * mailing 99 people cannot happen in the same request and must not be attempted
 * there. So issuing queues a row per bill per moment, and sending is a separate,
 * resumable, idempotent drain — the same bargain `announce.js` makes for gas,
 * for the same arithmetic: one `sendEmail` is two outbound fetches against a cap
 * of 50, so a token is minted ONCE per drain and threaded through every send,
 * and the drain takes 20 rows at a time. Twenty sends plus one refresh is 21.
 *
 * WHY FOUR LETTERS AND NOT ONE. Gas sends once, because a gas bill is a few
 * hundred rupees and the month comes round again. Maintenance is ₹7,500 or
 * ₹9,000 with a ₹750 fee behind it, and the quarter does not come round for
 * three months — so the committee asked for a run-up rather than a single
 * announcement. The fourth letter is the one that matters most and is the one
 * nobody wants to send: the fee has landed, and on a flat with arrears from an
 * ended quarter, the vote is now blocked too.
 *
 * ALL RESIDENT-VISIBLE WORDING IN THIS FILE IS PLACEHOLDER. It is written to be
 * readable and approximately right so the screens and tests have something real
 * to work against, and it is marked so throughout. The committee approves the
 * final copy before testing; see PLACEHOLDER_COPY below.
 */

import { mailToken, sendEmail, mailConfigured } from './mailer.js';
import { renderEmail, para, figure, details, action, aside, SITE } from './email-template.js';
import { dayAndMonth } from './reminders.js';
import { describeQuarter, quarterHasEnded } from './maint.js';

/**
 * A flag, not a comment, so nothing ships by accident.
 *
 * The wording pass flips this to false once the committee has signed off, and
 * a test asserts it is false before the feature can be called done. A comment
 * saying "placeholder" is a note; this is a thing that can be checked.
 */
export const PLACEHOLDER_COPY = true;

/** How many are sent per drain. See the subrequest arithmetic above. */
export const DRAIN_SIZE = 20;

/** Retries before a row is left for a human. A 4xx never gets even one. */
export const MAX_ATTEMPTS = 3;

/** The four moments, in the order they happen. Internal strings — see 0043. */
export const MAIL_KINDS = ['issued', 'due_soon', 'due', 'overdue'];

/**
 * Is this failure worth trying again?
 *
 * Identical rule to `announce.js`, and deliberately a copy rather than an
 * import: it is four lines, and the alternative is one module reaching into
 * another's retry policy so that changing gas's quietly changes maintenance's.
 * A 4xx from Gmail is a refusal and will be refused identically forever; 408
 * and 429 are "later", not "never".
 */
export function permanentFailure(reason) {
  const m = /^gmail-(\d{3})$/.exec(String(reason ?? ''));
  if (!m) return false;
  const status = Number(m[1]);
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

/* ── the letters ──────────────────────────────────────────────────────────
   Kept here rather than in the drain so a test can read the words without a
   database, and so the plain-text and HTML halves cannot drift: renderEmail
   builds both from one description.

   NO PAYMENT LINK IN ANY OF THEM, matching gas and for the same two reasons:
   an unsolicited message asking for money is the shape of a fraud, and B19
   found that `upi://` links do not survive Gmail anyway. The portal, where the
   working and the Pay button are, is the only thing to tap.                  */

/** Common footer line. Disputes go to the committee, never to a named person. */
const DISPUTE_LINE = 'If something here looks wrong, raise it with the committee '
  + 'through the portal rather than replying to this message.';

const FRAUD_LINE = 'Nobody from the association will ever send you a payment link '
  + 'in a message.';

/**
 * Letter 1 — the bill exists.
 *
 * The basis is shown as a line rather than left implicit. A tenant paying
 * ₹9,000 where their neighbour pays ₹7,500 is entitled to see, on the bill
 * itself, that the difference is the rate for a let flat and not a mistake —
 * and the alternative is the committee fielding that question ninety times.
 */
export function issuedEmail({ flat, quarter, total, dueDate, basis, rate, origin = '' }) {
  const site = origin || SITE;
  return renderEmail({
    title: `Maintenance charges for ${describeQuarter(quarter)}`,
    preview: `₹${total} for flat ${flat}, due ${dayAndMonth(dueDate)}.`,
    blocks: [
      para(`The maintenance charge for flat ${flat} is ready.`),
      figure(`₹${total}`, `due ${dayAndMonth(dueDate)}`),
      details([
        ['Flat', flat],
        ['Quarter', describeQuarter(quarter)],
        ['Rate', basis === 'tenant' ? `₹${rate} — let flat` : `₹${rate} — owner-occupied`],
      ]),
      para('Maintenance is charged once a quarter and is separate from the gas '
        + 'bill, which is monthly and paid into a different account.'),
      action('Pay on the portal', `${site}/dashboard`),
      aside(`${FRAUD_LINE} ${DISPUTE_LINE}`),
    ],
  });
}

/** Letter 2 — three days out. The only one that exists purely to be helpful. */
export function dueSoonEmail({ flat, quarter, total, dueDate, lateFee, origin = '' }) {
  const site = origin || SITE;
  return renderEmail({
    title: `Maintenance for ${describeQuarter(quarter)} is due on ${dayAndMonth(dueDate)}`,
    preview: `₹${total} for flat ${flat}.`,
    blocks: [
      para(`A reminder that the maintenance charge for flat ${flat} is due on `
        + `${dayAndMonth(dueDate)}.`),
      figure(`₹${total}`, `due ${dayAndMonth(dueDate)}`),
      // The fee is named now rather than sprung later. A resident who is going
      // to be charged ₹750 should hear the number while they can still avoid
      // it, which is the entire point of sending anything three days early.
      para(`A late fee of ₹${lateFee} is added the day after the due date.`),
      action('Pay on the portal', `${site}/dashboard`),
      aside(`${FRAUD_LINE} ${DISPUTE_LINE}`),
    ],
  });
}

/** Letter 3 — the due date itself, which is still a payable day. */
export function dueEmail({ flat, quarter, total, lateFee, origin = '' }) {
  const site = origin || SITE;
  return renderEmail({
    title: `Maintenance for ${describeQuarter(quarter)} is due today`,
    preview: `₹${total} for flat ${flat}.`,
    blocks: [
      para(`The maintenance charge for flat ${flat} is due today.`),
      figure(`₹${total}`, 'due today'),
      // Stated because the rule is not the gas rule and residents have learned
      // the gas one. Gas is charged ON the due date at midnight; maintenance
      // leaves the due date payable and charges the morning after. Being vague
      // here would cost somebody ₹750.
      para(`Today is still payable. A late fee of ₹${lateFee} is added tomorrow.`),
      action('Pay on the portal', `${site}/dashboard`),
      aside(`${FRAUD_LINE} ${DISPUTE_LINE}`),
    ],
  });
}

/**
 * Letter 4 — the fee has landed, and possibly the vote with it.
 *
 * THE VOTING LINE IS CONDITIONAL, and only appears once the quarter has
 * actually ended. A bill that is overdue inside its own quarter does not block
 * anything, and telling someone their vote is at risk when it is not would be
 * both untrue and the most alarming sentence the portal sends.
 */
export function overdueEmail({ flat, quarter, total, lateFee, blocksVoting, origin = '' }) {
  const site = origin || SITE;
  return renderEmail({
    title: `Maintenance for ${describeQuarter(quarter)} is overdue`,
    preview: `₹${total} for flat ${flat}, including a ₹${lateFee} late fee.`,
    blocks: [
      para(`The maintenance charge for flat ${flat} was due yesterday, so a late `
        + `fee of ₹${lateFee} has been added.`),
      figure(`₹${total}`, 'now payable'),
      ...(blocksVoting
        ? [para('While maintenance from a closed quarter is unpaid, this flat '
            + 'cannot vote in polls. Voting is restored as soon as the treasurer '
            + 'confirms the payment.')]
        : []),
      action('Pay on the portal', `${site}/dashboard`),
      aside(`${FRAUD_LINE} ${DISPUTE_LINE}`),
    ],
  });
}

/** One letter, by kind. Throws for an unknown kind rather than sending nothing. */
export function letterFor(kind, row, { origin = '', today } = {}) {
  const base = {
    flat: row.flat, quarter: row.quarter, total: row.total,
    dueDate: row.due_date, lateFee: row.quarter_late_fee, origin,
  };
  if (kind === 'issued') {
    return issuedEmail({ ...base, basis: row.basis, rate: row.rate_applied });
  }
  if (kind === 'due_soon') return dueSoonEmail(base);
  if (kind === 'due') return dueEmail(base);
  if (kind === 'overdue') {
    return overdueEmail({
      ...base,
      // Asked of the quarter, not of the bill's status: the block is about a
      // quarter having ENDED, and on the day after a due date inside the
      // quarter it has not.
      blocksVoting: quarterHasEnded(row.quarter, today ?? row.due_date),
    });
  }
  throw Object.assign(new Error(`unknown maintenance mail kind: ${kind}`), { code: 'bad-kind' });
}

/* ── who else gets told ───────────────────────────────────────────────────  */

/**
 * The Cc list for one bill: the rest of the household.
 *
 * A flat's maintenance is ONE bill and a flat holds up to five logins — three
 * owners and two tenants (0040). The bill names one person in `owner_id`, but
 * everybody in that household is affected by it, and the ones not named were
 * previously told nothing.
 *
 * CC RATHER THAN SEPARATE COPIES, and rather than Bcc. The user chose it
 * knowingly: on a let flat the tenant and the owner then see each other's
 * addresses. That is the trade, and it is the honest one — both parties are
 * liable for the same bill and each is entitled to know the other was told.
 * Separate copies would hide that; Bcc would hide it and teach this codebase to
 * emit the one header its injection guard exists to prevent.
 *
 * Every active owner with an address, never just the one on the bill: they are
 * all liable, `billAccess` already shows them all the amount, and picking one
 * would be the portal deciding which co-owner gets told. The second tenant is
 * included for the same reason — a household that shares a bill should share
 * the letter about it.
 *
 * The billed person is excluded, because they are the To. Addresses are
 * de-duplicated: a couple sharing one address must not be Cc'd twice.
 */
export function ccFor({ people, billedToId }) {
  const seen = new Set();
  const out = [];
  for (const p of people ?? []) {
    if (!p.active || p.id === billedToId) continue;
    const email = String(p.email ?? '').trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

/* ── the drain ────────────────────────────────────────────────────────────  */

/** How the quarter's telling stands. Cheap enough to poll behind a progress bar. */
export async function mailCounts(env, quarter) {
  const rows = await env.DB.prepare(
    `SELECT m.status, COUNT(*) AS n
       FROM maint_mail m JOIN maint_bills b ON b.id = m.bill_id
      WHERE b.quarter = ? GROUP BY m.status`
  ).bind(quarter).all();

  const out = { queued: 0, sent: 0, unreachable: 0, failed: 0 };
  for (const r of rows.results ?? []) out[r.status] = r.n;
  out.total = out.queued + out.sent + out.unreachable + out.failed;
  // `unreachable` is deliberately not "remaining": those rows are done, in the
  // only sense a drain can finish them. Counting them as outstanding would
  // leave the bar permanently short of the end in a building where most
  // accounts have no address on file.
  out.remaining = out.queued + out.failed;
  return out;
}

/**
 * Send up to `limit` queued letters.
 *
 * Resumable by construction: it asks for whatever is outstanding, so an admin
 * draining from the console and the nightly cron are the same operation. A
 * `sent` row is never selected, which is what makes a retry safe rather than
 * merely unlikely.
 *
 * Each row's status is written the moment its send returns, rather than batched
 * at the end. D1 is counted against a separate internal allowance, so this is
 * cheap — and a drain that dies halfway has still recorded every send it made,
 * which is the difference between resuming and mailing somebody twice.
 */
export async function drainMaintMail(env, { limit = DRAIN_SIZE, origin = '', today } = {}) {
  if (!mailConfigured(env)) {
    return { sent: 0, failed: 0, reason: 'not-configured' };
  }

  const rows = await env.DB.prepare(
    `SELECT m.bill_id, m.kind, m.attempts,
            b.flat, b.quarter, b.total, b.basis, b.rate_applied, b.owner_id,
            q.due_date, q.late_fee AS quarter_late_fee,
            o.email, o.name
       FROM maint_mail m
       JOIN maint_bills b ON b.id = m.bill_id
       JOIN maint_quarters q ON q.quarter = b.quarter
       LEFT JOIN owners o ON o.id = b.owner_id
      WHERE m.status = 'queued' OR (m.status = 'failed' AND m.attempts < ?)
      ORDER BY b.quarter DESC, b.flat
      LIMIT ?`
  ).bind(MAX_ATTEMPTS, limit).all();

  const queue = rows.results ?? [];
  if (!queue.length) return { sent: 0, failed: 0 };

  // ONCE per drain. This line is the entire reason the outbox exists: minting
  // per send is what makes a quarter cost twice its subrequest budget.
  const auth = await mailToken(env);
  if (!auth.ok) return { sent: 0, failed: 0, reason: auth.reason };

  // The households, in one query rather than one per row. Twenty letters would
  // otherwise be twenty extra round trips for a Cc list.
  const flats = [...new Set(queue.map((r) => r.flat))];
  const people = await householdsFor(env, flats);

  let sent = 0;
  let failed = 0;

  for (const row of queue) {
    // Belt and braces: a row with no address was queued `unreachable` and is
    // never selected. If one ever is, it is a bug worth not turning into a
    // Gmail 400.
    if (!row.email) {
      await mark(env, row.bill_id, row.kind, 'unreachable', row.attempts, null);
      continue;
    }

    let mail;
    try {
      mail = letterFor(row.kind, row, { origin, today });
    } catch (err) {
      // An unknown kind is a bug in this file, not a delivery failure. Park it
      // rather than burning three attempts discovering the same thing.
      await mark(env, row.bill_id, row.kind, 'failed', MAX_ATTEMPTS, err?.code ?? 'bad-kind');
      failed += 1;
      continue;
    }

    const res = await sendEmail(env, {
      to: row.email,
      cc: ccFor({ people: people.get(row.flat) ?? [], billedToId: row.owner_id }),
      subject: mail.subject, text: mail.text, html: mail.html,
    }, auth.token);

    if (res.sent) {
      await mark(env, row.bill_id, row.kind, 'sent', row.attempts + 1, null);
      sent += 1;
      continue;
    }

    // A permanent refusal is parked at the ceiling rather than counted up to
    // it: three identical 400s three nights running tell nobody anything, and
    // each costs a subrequest the next drain could have used.
    const attempts = permanentFailure(res.reason) ? MAX_ATTEMPTS : row.attempts + 1;
    await mark(env, row.bill_id, row.kind, 'failed', attempts, res.reason ?? 'unknown');
    failed += 1;
  }

  return { sent, failed };
}

/** Every active person on these flats, keyed by flat. One query. */
async function householdsFor(env, flats) {
  if (!flats.length) return new Map();
  const marks = flats.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT flat, id, name, email, relationship, active
       FROM owners WHERE active = 1 AND flat IN (${marks}) ORDER BY flat, id`
  ).bind(...flats).all();

  const byFlat = new Map();
  for (const r of rows.results ?? []) {
    if (!byFlat.has(r.flat)) byFlat.set(r.flat, []);
    byFlat.get(r.flat).push(r);
  }
  return byFlat;
}

function mark(env, billId, kind, status, attempts, lastError) {
  return env.DB.prepare(
    `UPDATE maint_mail
        SET status = ?, attempts = ?, last_error = ?,
            sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END
      WHERE bill_id = ? AND kind = ?`
  ).bind(status, attempts, lastError, status, new Date().toISOString(), billId, kind).run();
}

/**
 * The nightly sweep. Never throws: a letter that cannot be sent must not cost
 * the building its late-fee run, which is the rule every job in cron.js follows.
 */
export async function sweepMaintMail(env, { origin = '', today } = {}) {
  try {
    return await drainMaintMail(env, { origin, today });
  } catch (err) {
    return { sent: 0, failed: 0, reason: err?.code ?? 'threw' };
  }
}
