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
import { renderEmail, para, heading, figure, details, action, aside, SITE }
  from './email-template.js';
import { deadlineText, deadlineShort } from './poll-text.js';
// The same counting the portal does, so a letter and the screen can never
// disagree about a published result.
import { tally } from './polls.js';

/** Twenty sends plus one token refresh is twenty-one. See the header. */
export const DRAIN_SIZE = 20;
export const MAX_ATTEMPTS = 3;

/** A 4xx is the sender's fault and will be the sender's fault again. */
const permanentFailure = (reason = '') => /\b4\d\d\b/.test(String(reason));

/* ── the letters ───────────────────────────────────────────────────────── */

/**
 * NO COUNT LEAVES THE BUILDING BEFORE THE COMMITTEE PUBLISHES ONE.
 *
 * `opened` and `reminder` carry the question, the options and the deadline and
 * nothing else — no turnout, no split, no "38 flats have voted so far". An
 * email is the one surface the committee cannot take back, and a figure that
 * leaks here leaks to ninety inboxes at once.
 *
 * `result` is the exception and the whole point of that letter: by the time it
 * is queued, `publishPoll` has already made the count visible to every resident
 * who could vote. Withholding it in the email would mean sending somebody a
 * notification that a number exists.
 *
 * THE OPTIONS ARE IN THE LETTER because the alternative is asking a resident to
 * open a link to find out what the question even offers. A first version of
 * this sent the title and a button, which is a notification rather than a
 * letter. It cannot be a ballot — nobody votes from an inbox — but it can be
 * enough to decide with.
 */
export function pollEmail(kind, {
  title, body = '', closesAt, pollId, origin = SITE, options = [], result = null,
}) {
  const url = `${origin}/polls?id=${pollId}`;

  // Option label on the left, its note on the right. An option with no note
  // leaves that cell empty, which reads as a plain hairline-separated list
  // rather than as something missing.
  const optionRows = options.length
    ? [heading(options.length === 2 ? 'The two options' : `The ${options.length} options`),
       details(options.map((o) => [o.label, o.sub ?? '']))]
    : [];

  if (kind === 'opened') {
    return {
      subject: `Poll: ${title}`,
      preview: `Voting closes ${deadlineText(closesAt)}.`,
      blocks: [
        para('The committee has put a question to the building.'),
        ...(body ? [para(body)] : []),
        ...optionRows,
        figure(deadlineShort(closesAt), 'voting closes · IST'),
        action('Vote now', url),
        aside('One vote per flat, and it belongs to the flat’s owner. Results '
          + 'are not shown while voting is open.'),
      ],
    };
  }

  if (kind === 'reminder') {
    return {
      subject: `Your flat has not voted: ${title}`,
      preview: `Voting closes ${deadlineText(closesAt)}.`,
      blocks: [
        para('This poll is halfway through and your flat has not voted yet.'),
        ...optionRows,
        figure(deadlineShort(closesAt), 'voting closes · IST'),
        action('Vote now', url),
        // Said plainly, because a resident who has decided not to vote should
        // know this is the only chase they will get rather than bracing for
        // three more. reminders.js records the committee reaching the same
        // conclusion about unpaid bills.
        aside('This is the only reminder we will send about this poll.'),
      ],
    };
  }

  // ── the result ────────────────────────────────────────────────────────
  const counted = result?.options ?? [];
  const top = Math.max(0, ...counted.map((o) => o.votes ?? 0));
  const leaders = counted.filter((o) => (o.votes ?? 0) === top && top > 0);
  const flats = result?.flats ?? 0;
  const turnout = `${flats} of ${result?.flatsTotal ?? 0} flats voted`;

  return {
    subject: `Result: ${title}`,
    preview: turnout,
    blocks: [
      para('The committee has published the result of a poll you could vote in.'),
      // A tie is reported and never resolved — the portal does not invent a
      // casting vote it has no authority to give.
      ...(leaders.length === 1
        ? [figure(leaders[0].label, turnout)]
        : leaders.length > 1
          ? [para(`The vote is tied between ${leaders.map((o) => o.label).join(' and ')}. `
              + 'The committee will decide from here.'), para(turnout)]
          : [para('Nobody voted.')]),
      ...(counted.length
        ? [heading('Every option'),
           details(counted.map((o) => [o.label, `${o.votes} ${o.votes === 1 ? 'flat' : 'flats'}`]))]
        : []),
      action('See the result', url),
      aside('The result is the count only. How each flat voted is not shown — '
        + 'not to residents, and not to the committee.'),
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
    title: poll.title, body: poll.body, closesAt: poll.closes_at,
    pollId: poll.poll_id ?? poll.id, origin,
    options: poll.options ?? [], result: poll.result ?? null,
  });
  return renderEmail({ title: mail.subject, preview: mail.preview, blocks: mail.blocks });
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
            o.email, p.title, p.body, p.closes_at
       FROM poll_mail m
       JOIN owners o ON o.id = m.owner_id
       JOIN polls  p ON p.id = m.poll_id
      WHERE (m.status = 'queued' OR (m.status = 'failed' AND m.attempts < ?))
      ORDER BY m.queued_at, m.poll_id, m.owner_id
      LIMIT ?`
  ).bind(MAX_ATTEMPTS, limit).all();

  const queue = results ?? [];
  if (!queue.length) return { sent: 0, failed: 0 };

  // The letters name the options, so they have to be fetched — but ONCE per
  // poll, not once per recipient. A drain is twenty letters about one or two
  // polls, so this is two queries rather than twenty. D1 is counted against a
  // separate internal allowance and does not compete for the subrequest budget,
  // but twenty round trips for the same eight rows would still be silly.
  const content = await pollContent(env, [...new Set(queue.map((r) => r.poll_id))]);

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
    const mail = renderPollEmail(row.kind, { ...row, ...content.get(row.poll_id) }, origin);
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


/**
 * The options for each poll being mailed about, and the counts for the ones
 * whose result has been published.
 *
 * THE COUNT IS FETCHED ONLY FOR A PUBLISHED POLL. Reading it for every poll and
 * letting `pollEmail` decide what to print would put the running count of an
 * OPEN poll one careless template edit away from ninety inboxes. The safest
 * place for a secret is not in the letter's logic; it is out of the data the
 * letter is built from.
 */
async function pollContent(env, pollIds) {
  const out = new Map();
  if (!pollIds.length) return out;
  const marks = pollIds.map(() => '?').join(',');

  const [{ results: options }, { results: published }, flats] = await Promise.all([
    env.DB.prepare(
      `SELECT id, poll_id, label, sub FROM poll_options
        WHERE poll_id IN (${marks}) ORDER BY poll_id, sort`
    ).bind(...pollIds).all(),
    env.DB.prepare(
      `SELECT id FROM polls WHERE id IN (${marks}) AND published_at IS NOT NULL`
    ).bind(...pollIds).all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM flats WHERE active = 1').first(),
  ]);

  for (const id of pollIds) out.set(id, { options: [], result: null });
  for (const o of options ?? []) {
    out.get(o.poll_id)?.options.push({ label: o.label, sub: o.sub });
  }

  const live = (published ?? []).map((r) => r.id);
  if (!live.length) return out;

  const { results: votes } = await env.DB.prepare(
    `SELECT poll_id, option_id, flat FROM poll_votes
      WHERE poll_id IN (${live.map(() => '?').join(',')})`
  ).bind(...live).all();

  for (const id of live) {
    const mine = (votes ?? []).filter((v) => v.poll_id === id);
    const rows = (options ?? []).filter((o) => o.poll_id === id);
    const counted = tally(rows, mine);
    out.get(id).result = {
      options: counted.options,
      flats: counted.flats,
      flatsTotal: flats?.n ?? 0,
    };
  }
  return out;
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
