/**
 * The three letters a poll writes, and the drain that sends them.
 *
 * A near-copy of announce.js on purpose. That module's header explains the
 * arithmetic this one also obeys: `sendEmail` refreshes an OAuth token per
 * call, so a naive loop is two subrequests per message against the free plan's
 * fifty per invocation. `mailToken()` is minted ONCE per drain and threaded
 * through every send, and the drain takes twenty rows at a time — twenty sends
 * plus one refresh is twenty-one.
 *
 * WHAT IS DIFFERENT FROM A BILL ANNOUNCEMENT. Three kinds rather than one, and
 * a recipient list that is a decision rather than a fact: bills go to whoever
 * owes money, polls go to whoever may vote. `poll_mail` is keyed on
 * (poll, owner, kind) so each of the three moments reaches a person once,
 * whatever races to send it.
 *
 * THE REMINDER CARRIES A RULE THE OTHERS DO NOT. It goes only to flats that
 * have not voted, so the number of rows it writes IS the turnout — the one
 * figure this whole feature hides. Nothing here returns that number in a shape
 * an admin can read; see `drainPollMail`'s return value, which counts sends and
 * never recipients-by-kind.
 */

import { mailToken, sendEmail, mailConfigured } from './mailer.js';
import { renderEmail, para, action, aside, SITE } from './email-template.js';
import { deadlineText } from './poll-text.js';

/** Twenty sends plus one token refresh is twenty-one. See the header. */
export const DRAIN_SIZE = 20;
export const MAX_ATTEMPTS = 3;

/** A 4xx is the sender's fault and will be the sender's fault again. */
const permanentFailure = (reason = '') => /\b4\d\d\b/.test(String(reason));

/* ── the letters ───────────────────────────────────────────────────────── */

/**
 * NO COUNTS IN ANY OF THESE. Not the turnout, not the split, not "38 flats
 * have voted so far". An email is the one surface the committee cannot take
 * back, and a figure that leaks here leaks to ninety inboxes at once.
 */
export function pollEmail(kind, { title, closesAt, pollId, origin = SITE }) {
  const url = `${origin}/polls?id=${pollId}`;

  if (kind === 'opened') {
    return {
      subject: `Poll: ${title}`,
      blocks: [
        para('The committee has put a question to the building.'),
        para(title),
        para(`Voting closes ${deadlineText(closesAt)}.`),
        action('Vote now', url),
        aside('One vote per flat. Results are not shown while voting is open.'),
      ],
    };
  }

  if (kind === 'reminder') {
    return {
      subject: `Your flat has not voted: ${title}`,
      blocks: [
        para('This poll is halfway through and your flat has not voted yet.'),
        para(title),
        para(`Voting closes ${deadlineText(closesAt)}.`),
        action('Vote now', url),
        // Said plainly, because a resident who has decided not to vote should
        // know this is the only chase they will get rather than bracing for
        // three more. reminders.js records the committee reaching the same
        // conclusion about unpaid bills.
        aside('This is the only reminder we will send about this poll.'),
      ],
    };
  }

  return {
    subject: `Result: ${title}`,
    blocks: [
      para('The committee has published the result of a poll you could vote in.'),
      para(title),
      action('See the result', url),
      aside('The result is the count only. How each flat voted is not shown.'),
    ],
  };
}

/**
 * The subject comes back from renderEmail, not from here.
 *
 * `subjectFor` prefixes 'Diamond Park — ', and its comment says why the two are
 * derived from one string: a caller that writes its own subject is a caller
 * that can write one no longer describing the mail underneath it.
 */
const renderPollEmail = (kind, poll, origin) => {
  const mail = pollEmail(kind, {
    title: poll.title, closesAt: poll.closes_at, pollId: poll.id, origin,
  });
  return renderEmail({ title: mail.subject, preview: poll.title, blocks: mail.blocks });
};

/* ── the drain ─────────────────────────────────────────────────────────── */

/**
 * Send up to `limit` queued letters, for every poll that has any.
 *
 * Resumable and idempotent, like the bill drain: each row's status is written
 * the moment its send returns, rather than batched at the end, so a drain that
 * dies halfway has still recorded every send it made. D1 writes do not compete
 * for the subrequest budget — they are counted against a separate internal
 * allowance — which is what makes that affordable.
 */
export async function drainPollMail(env, { limit = DRAIN_SIZE, origin = SITE } = {}) {
  if (!mailConfigured(env)) return { sent: 0, failed: 0, reason: 'not-configured' };

  const { results } = await env.DB.prepare(
    `SELECT m.poll_id, m.owner_id, m.kind, m.attempts,
            o.email, p.title, p.closes_at
       FROM poll_mail m
       JOIN owners o ON o.id = m.owner_id
       JOIN polls  p ON p.id = m.poll_id
      WHERE (m.status = 'queued' OR (m.status = 'failed' AND m.attempts < ?))
      ORDER BY m.queued_at, m.poll_id, m.owner_id
      LIMIT ?`
  ).bind(MAX_ATTEMPTS, limit).all();

  const queue = results ?? [];
  if (!queue.length) return { sent: 0, failed: 0 };

  // ONCE per drain. This line is the whole reason the outbox exists.
  const auth = await mailToken(env);
  if (!auth.ok) return { sent: 0, failed: 0, reason: auth.reason };

  let sent = 0;
  let failed = 0;

  for (const row of queue) {
    if (!row.email) {
      await markMail(env, row, 'unreachable', row.attempts, null);
      continue;
    }
    const mail = renderPollEmail(row.kind, row, origin);
    const res = await sendEmail(env, {
      to: row.email, subject: mail.subject, text: mail.text, html: mail.html,
    }, auth.token);

    if (res.sent) {
      await markMail(env, row, 'sent', row.attempts + 1, null);
      sent += 1;
      continue;
    }
    // Parked at the ceiling rather than counted up to it: three identical 400s
    // on three nights tell nobody anything and cost three subrequests.
    const attempts = permanentFailure(res.reason) ? MAX_ATTEMPTS : row.attempts + 1;
    await markMail(env, row, 'failed', attempts, res.reason ?? 'unknown');
    failed += 1;
  }

  // Sends and failures, never a per-poll or per-kind breakdown. A reminder
  // drain reporting "18 reminders sent for poll 4" tells the reader that
  // eighteen flats had not voted, which is the turnout.
  return { sent, failed };
}

function markMail(env, row, status, attempts, error) {
  return env.DB.prepare(
    `UPDATE poll_mail
        SET status = ?, attempts = ?, last_error = ?,
            sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END
      WHERE poll_id = ? AND owner_id = ? AND kind = ?`
  ).bind(status, attempts, error, status, new Date().toISOString(),
         row.poll_id, row.owner_id, row.kind).run();
}

/** How much is waiting. A total only — see the note on drainPollMail. */
export async function pollMailPending(env) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM poll_mail
      WHERE status = 'queued' OR (status = 'failed' AND attempts < ?)`
  ).bind(MAX_ATTEMPTS).first();
  return row?.n ?? 0;
}
