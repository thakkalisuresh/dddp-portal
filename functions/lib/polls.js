/**
 * Polls — a question the committee puts to the building.
 *
 * Every decision here was taken on 2026-09-09 and written down in
 * docs/POLLS-PLAN.md before any of this existed. What follows is the half that
 * can be decided without a database: validation, visibility, the arithmetic of
 * closing and reminding, and counting. Everything in this file is pure and
 * tested against a clock, which is the point — the rules that decide whether a
 * vote counts should not need D1 to be exercised.
 *
 * The risk being managed is not technical. A vote is the one thing in this
 * portal that a resident can be told they did when they did not, or told they
 * cannot change when they can. So the rules are few and each is in exactly one
 * place:
 *
 *   - the flat votes, the owner casts, and the ballot records which owner
 *   - nothing about the count is visible while the poll is open
 *   - closing reveals it to the committee; publishing reveals it to residents
 *   - a poll never reopens
 */

import { fail } from './errors.js';
// The notice board's own visibility rule, borrowed rather than reimplemented.
import { canSeeNotice } from './notices.js';
// The shared rules. Re-exported below so every existing importer — and the
// tests — keep asking this module, which is where polls are reasoned about.
// Imported for USE. `export ... from` below re-exports the rest for callers,
// but a re-export binds nothing in this file's own scope — anything called
// here has to appear on this line too.
import { validatePoll, validateBallot, optionsFrozen } from '../../public/js/poll-rules.js';

export {
  MAX_TITLE, MAX_BODY, MAX_OPTION, MIN_OPTIONS, MAX_OPTIONS,
  isYesNoPair, validatePoll, validateBallot, optionsFrozen,
  DRAIN_SIZE, CRON_RUNS_PER_DAY, SENDS_PER_DAY, deliveryWarnings,
} from '../../public/js/poll-rules.js';

/* ── closing ──────────────────────────────────────────────────────────────── */

/**
 * Has this poll closed?
 *
 * CLOSING IS EVALUATED ON READ, and this function is why. The crons run three
 * times a day and cannot express "closes at 6pm" — a poll waiting for the next
 * sweep would sit visibly open past its own deadline, accepting votes it has
 * already promised not to. So every read path asks this, and the cron's job is
 * only to write the fact down and queue the result email.
 *
 * `closed_at` wins when it is set, because an early close is a decision
 * somebody made and must not be undone by a `closes_at` still in the future.
 */
export function isClosed(poll, now = new Date().toISOString()) {
  if (!poll) return false;
  if (poll.closed_at) return true;
  const closes = Date.parse(poll.closes_at);
  return Number.isFinite(closes) && Date.parse(now) >= closes;
}

/**
 * The midpoint of a poll's own life, which is when the reminder goes out.
 *
 * A 48-hour poll reminds at 24 hours; a fortnight's poll reminds after a week.
 * Self-scaling, so there is no second column of policy to keep in step with the
 * closing date.
 *
 * Stored on the row rather than recomputed on demand: if an admin later edits
 * the closing time, a reminder that has ALREADY gone out must not be silently
 * rescheduled into one that goes out twice.
 */
export function midpoint(createdAt, closesAt) {
  const from = Date.parse(createdAt);
  const to = Date.parse(closesAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  return new Date(from + Math.round((to - from) / 2)).toISOString();
}

/* ── who may do what ──────────────────────────────────────────────────────── */

/**
 * May this viewer see the poll at all?
 *
 * THE ONE PLACE THE RULE LIVES, for the same reason canSeeNotice is: the list,
 * the single fetch, the vote endpoint and the email recipients all ask this
 * function rather than repeating the condition. Four copies of a visibility
 * rule is four chances for one of them to be wrong, and the wrong one is the
 * leak. That is not hypothetical here — the notice board's version of this
 * comment records the time it happened.
 *
 * A poll is NOT scoped the way a notice is. `show_tenants` decides watching and
 * nothing else; voting is settled separately by canVote, which never consults
 * it. Folding them together is precisely how "let the tenants read it" would
 * become "let the tenants vote".
 */
export function canSeePoll(poll, viewer) {
  if (!poll) return false;
  if (isCommittee(viewer)) return true;
  if (viewer?.relationship === 'tenant') return Boolean(poll.show_tenants);
  return true;
}

/**
 * May this viewer cast their flat's vote?
 *
 * Owners only, on every poll, with no per-poll exception — decided 2026-09-09.
 * Asked of the SUBJECT, never the actor: an admin using view-as must not carry
 * their own standing into a resident's session, which is the mistake
 * canSeeAttachment exists to remember.
 */
export function canVote(viewer) {
  return Boolean(viewer) && viewer.relationship !== 'tenant';
}

/**
 * The notice behind a poll, as this viewer may see it — or nothing.
 *
 * HIDDEN RATHER THAN BROKEN. A poll and a notice scope differently: a notice is
 * owners-only or not, a poll carries its own `show_tenants`. They can disagree,
 * and a poll a tenant may read can point at a notice they may not. A link that
 * 404s for exactly the people the visibility switch was meant to include is
 * worse than no link, so this returns null for them and the screen shows
 * nothing at all.
 *
 * `canSeeNotice` decides it — the same function the notice board uses, not a
 * second copy. That function's own comment records the leak that followed from
 * having two.
 */
export function linkedNotice(row, viewer) {
  if (!row?.notice_id || !row.notice_active) return null;
  if (!canSeeNotice(row.notice_scope, viewer)) return null;
  return {
    id: row.notice_id,
    title: row.notice_title,
    attachmentCount: row.notice_files ?? 0,
  };
}

/** Committee by the viewer's own role — the same ladder the notice board uses. */
export const isCommittee = (viewer) =>
  viewer?.role === 'committee'
  || viewer?.role === 'admin'
  || viewer?.role === 'superadmin';

/**
 * May this person close, publish or edit this poll?
 *
 * The asymmetry 0030 established, applied to a second object: an admin manages
 * the whole board, a committee member manages what they posted. Asked of the
 * ACTOR because it decides a write — the opposite of everything above it here.
 */
export function canManagePoll(poll, actor) {
  if (!poll) return false;
  if (actor?.role === 'admin' || actor?.role === 'superadmin') return true;
  if (actor?.role !== 'committee') return false;
  return poll.created_by != null && poll.created_by === actor.id;
}

/**
 * May this viewer see the count right now?
 *
 * Residents and admins alike see nothing until the poll is closed AND
 * published. The superadmin sees it always, and NOTHING ANYWHERE SAYS SO —
 * there is no label, no "superadmin only" note, and no line in the admin view
 * admitting a count exists elsewhere. That silence is the feature; see
 * docs/POLLS-PLAN.md for why the resident copy had to be reworded because of
 * it, rather than being allowed to claim nobody can see the result.
 */
export function canSeeCount(poll, viewer, now = new Date().toISOString()) {
  if (!poll) return false;
  if (viewer?.role === 'superadmin') return true;
  if (!isClosed(poll, now)) return false;
  if (isCommittee(viewer)) return true;
  return Boolean(poll.published_at);
}

/* ── voting ───────────────────────────────────────────────────────────────── */

/* ── counting ─────────────────────────────────────────────────────────────── */

/**
 * The count, and the tie.
 *
 * `flats` is how many DISTINCT flats voted, which is the turnout — not the
 * number of rows, because a multi-select flat writes several. Getting that
 * wrong would report a turnout above the number of flats in the building.
 *
 * A tie is reported and never resolved. These polls are advisory by decision;
 * inventing a casting vote would be the portal claiming an authority nobody
 * gave it.
 */
export function tally(options = [], votes = []) {
  const counts = new Map(options.map((o) => [Number(o.id), 0]));
  const flats = new Set();
  for (const v of votes) {
    const id = Number(v.option_id);
    if (counts.has(id)) counts.set(id, counts.get(id) + 1);
    if (v.flat) flats.add(v.flat);
  }
  const rows = options.map((o) => ({
    id: Number(o.id),
    label: o.label,
    votes: counts.get(Number(o.id)) ?? 0,
  }));
  const top = Math.max(0, ...rows.map((r) => r.votes));
  const leaders = rows.filter((r) => r.votes === top && top > 0);
  return {
    options: rows,
    flats: flats.size,
    tied: leaders.length > 1,
    leaders: leaders.map((r) => r.id),
  };
}

/**
 * Reject a state change that must not happen, loudly.
 *
 * Reopening is the one the whole feature rests on: revealing the count to the
 * committee and then accepting more votes would make every result arguable
 * afterwards. It is refused here rather than merely omitted from the UI,
 * because "there is no button" is not the same promise as "the server says no".
 */
export function assertCanClose(poll, now = new Date().toISOString()) {
  if (!poll) fail('DDP-POLL-001', {});
  if (isClosed(poll, now)) fail('DDP-POLL-002', { id: poll.id });
}

export function assertCanVote(poll, viewer, now = new Date().toISOString()) {
  if (!poll) fail('DDP-POLL-001', {});
  if (isClosed(poll, now)) fail('DDP-POLL-003', { id: poll.id });
  if (!canVote(viewer)) fail('DDP-POLL-004', { id: poll.id });
}

/* ═════════════════════════════════════════════════════════════════════════
   The database half.

   Kept in this file rather than a second one, matching lib/notices.js: the
   rules and the queries that depend on them drift apart the moment they live
   in different places. Everything above is pure and tested against a clock;
   everything below needs D1.
   ═════════════════════════════════════════════════════════════════════════ */

/**
 * Who gets emailed about a poll: owners with an address, and nobody else.
 *
 * OWNERS ONLY, decided 2026-09-09 — an email is a call to act, and a tenant who
 * may watch but not vote should not be asked to do anything. `show_tenants`
 * deliberately does not appear in this query; it governs watching, and mail is
 * not watching.
 *
 * One row per FLAT, not per owner. A flat with two owners casts one vote, so
 * mailing both about it would send two letters asking for one answer; the
 * lowest owner id wins, which is stable across runs.
 */
async function mailableOwners(env) {
  const { results } = await env.DB.prepare(
    `SELECT MIN(o.id) AS id, o.flat
       FROM owners o
      WHERE o.active = 1
        AND o.relationship != 'tenant'
        AND o.email IS NOT NULL AND TRIM(o.email) != ''
      GROUP BY o.flat`
  ).all();
  return results ?? [];
}

/**
 * Queue one mailing. Idempotent by the primary key, which is the whole point.
 *
 * `INSERT OR IGNORE` rather than a check-then-insert: two admins pressing the
 * same button, or the cron landing on a poll somebody is already draining,
 * must not produce two letters. The database refuses the duplicate rather than
 * the handler remembering to.
 */
export async function queuePollMail(env, pollId, kind, { now = new Date().toISOString() } = {}) {
  const owners = await mailableOwners(env);
  if (!owners.length) return 0;
  await env.DB.batch(owners.map((o) => env.DB.prepare(
    `INSERT OR IGNORE INTO poll_mail (poll_id, owner_id, kind, status, queued_at)
     VALUES (?, ?, ?, 'queued', ?)`
  ).bind(pollId, o.id, kind, now)));
  return owners.length;
}

/**
 * The reminder goes only to flats that have NOT voted.
 *
 * Separate from queuePollMail because the recipient list is a different
 * question, and because of the rule this comment exists to protect: **the
 * number of rows this writes must never be reported to the caller in a way an
 * admin can see.** The system knows the turnout; the admin must not learn it
 * from having pressed a button. The return value is deliberately a boolean.
 */
export async function queuePollReminder(env, pollId, { now = new Date().toISOString() } = {}) {
  const owners = await mailableOwners(env);
  const { results } = await env.DB.prepare(
    'SELECT DISTINCT flat FROM poll_votes WHERE poll_id = ?'
  ).bind(pollId).all();
  const voted = new Set((results ?? []).map((r) => r.flat));

  const pending = owners.filter((o) => !voted.has(o.flat));
  if (pending.length) {
    await env.DB.batch(pending.map((o) => env.DB.prepare(
      `INSERT OR IGNORE INTO poll_mail (poll_id, owner_id, kind, status, queued_at)
       VALUES (?, ?, 'reminder', 'queued', ?)`
    ).bind(pollId, o.id, now)));
  }
  await env.DB.prepare('UPDATE polls SET reminded_at = ?, reminder_at = NULL WHERE id = ?')
    .bind(now, pollId).run();
  // Boolean, never a count. See above.
  return true;
}

/**
 * Refuse a notice that another poll has already claimed.
 *
 * The unique index would refuse it anyway, but as a constraint violation — an
 * opaque 500 rather than a sentence naming the poll already there. This runs
 * first so the committee gets told what happened; the index stays as the thing
 * that is actually true, because two people posting at once would race past
 * any check made here.
 */
async function assertNoticeFree(env, noticeId, exceptPollId = null) {
  if (!noticeId) return;
  const taken = await env.DB.prepare(
    'SELECT id, title FROM polls WHERE notice_id = ? AND id IS NOT ?'
  ).bind(noticeId, exceptPollId).first();
  if (taken) {
    fail('DDP-POLL-009', { noticeId, message:
      `That notice already has a poll on it — “${taken.title}”. A notice carries one poll.` });
  }
}

/** Create a poll and its options in one batch, and queue the opening letter. */
export async function createPoll(env, {
  title, body, multi = false, maxChoices = null, showTenants = false,
  closesAt, options = [], noticeId = null, createdBy, now = new Date().toISOString(),
}) {
  const check = validatePoll({ title, body, multi, maxChoices, options, closesAt, now });
  if (!check.ok) fail('DDP-POLL-005', { message: check.message });

  await assertNoticeFree(env, noticeId);

  const row = await env.DB.prepare(
    `INSERT INTO polls (title, body, multi, max_choices, show_tenants,
                        opens_at, closes_at, reminder_at, notice_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(
    String(title).trim(), String(body).trim(), multi ? 1 : 0,
    multi ? Number(maxChoices) : null, showTenants ? 1 : 0,
    now, closesAt, midpoint(now, closesAt), noticeId || null, createdBy, now,
  ).first();

  await env.DB.batch(options.map((o, i) => env.DB.prepare(
    'INSERT INTO poll_options (poll_id, label, sort) VALUES (?, ?, ?)'
  ).bind(row.id, String(o.label).trim(), i)));

  return row.id;
}

/**
 * Every poll this viewer may see, newest first, with their flat's answer.
 *
 * The count is NOT selected here for anybody but the superadmin. Leaving it out
 * of the payload rather than out of the template is the difference between a
 * secret and a hidden element somebody can read in devtools.
 */
export async function listPolls(env, viewer, { now = new Date().toISOString() } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT p.*,
            (SELECT COUNT(*) FROM poll_votes v
              WHERE v.poll_id = p.id AND v.flat = ?) AS my_votes
       FROM polls p
      ORDER BY p.created_at DESC`
  ).bind(viewer?.flat ?? '').all();

  return (results ?? [])
    .filter((p) => canSeePoll(p, viewer))
    .map((p) => ({
      id: p.id,
      title: p.title,
      showTenants: Boolean(p.show_tenants),
      closesAt: p.closes_at,
      closed: isClosed(p, now),
      published: Boolean(p.published_at),
      voted: p.my_votes > 0,
      hasNotice: Boolean(p.notice_id),
      // Whether this viewer has a vote to cast at all, so the board can say
      // "you can watch this" instead of offering a control that will refuse.
      canVote: canVote(viewer),
    }));
}

/**
 * One poll, with its options, this flat's answer, and the count if — and only
 * if — this viewer may see it.
 */
export async function getPoll(env, id, viewer, { now = new Date().toISOString() } = {}) {
  const poll = await env.DB.prepare(
    `SELECT p.*, n.title AS notice_title, n.scope AS notice_scope, n.active AS notice_active,
            (SELECT COUNT(*) FROM attachments a
              WHERE a.notice_id = n.id AND a.deleted_at IS NULL) AS notice_files
       FROM polls p
       LEFT JOIN notices n ON n.id = p.notice_id
      WHERE p.id = ?`
  ).bind(id).first();
  if (!poll || !canSeePoll(poll, viewer)) return null;

  const [{ results: options }, { results: mine }] = await Promise.all([
    env.DB.prepare('SELECT id, label, sort FROM poll_options WHERE poll_id = ? ORDER BY sort')
      .bind(id).all(),
    env.DB.prepare('SELECT option_id, cast_at FROM poll_votes WHERE poll_id = ? AND flat = ?')
      .bind(id, viewer?.flat ?? '').all(),
  ]);

  const closed = isClosed(poll, now);
  const shaped = {
    id: poll.id,
    title: poll.title,
    body: poll.body,
    createdBy: poll.created_by,
    multi: Boolean(poll.multi),
    maxChoices: poll.max_choices,
    showTenants: Boolean(poll.show_tenants),
    closesAt: poll.closes_at,
    closed,
    published: Boolean(poll.published_at),
    canVote: canVote(viewer) && !closed,
    // The options are always sent. A closed poll still shows a resident what
    // the question was and what their flat chose, whether or not the count was
    // ever published — see docs/POLLS-PLAN.md.
    options: (options ?? []).map((o) => ({ id: o.id, label: o.label })),
    myVotes: (mine ?? []).map((v) => v.option_id),
    votedAt: mine?.[0]?.cast_at ?? null,
    notice: linkedNotice(poll, viewer),
  };

  // WHETHER THE OPTIONS ARE FROZEN, WHICH IS NOT THE SAME AS HOW MANY VOTED.
  //
  // The edit form has to know it may not touch the options, and it has to say
  // why. But the vote count IS the turnout — the one number this whole feature
  // hides from admins — so a `votesCast` here would hand it to every committee
  // member through the network tab.
  //
  // A boolean leaks "at least one flat has voted", which is monotonic, arrives
  // the moment voting starts, and is unavoidable if the refusal is to be
  // explained at all. That is a far smaller thing to give away than the number,
  // and it is given only to people who can edit the poll.
  if (canManagePoll(poll, viewer)) {
    const cast = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id = ?'
    ).bind(id).first();
    shaped.optionsFrozen = optionsFrozen(cast?.n ?? 0);
  }

  if (canSeeCount(poll, viewer, now)) {
    const [{ results: votes }, total] = await Promise.all([
      env.DB.prepare('SELECT option_id, flat FROM poll_votes WHERE poll_id = ?').bind(id).all(),
      // The denominator of "51 of 89 flats voted". Active flats only: a
      // deactivated flat has nobody in it to vote, and counting it would make
      // every poll look worse attended than it was.
      env.DB.prepare('SELECT COUNT(*) AS n FROM flats WHERE active = 1').first(),
    ]);
    const counted = tally(options ?? [], votes ?? []);
    shaped.result = {
      options: counted.options, flats: counted.flats,
      flatsTotal: total?.n ?? 0,
      tied: counted.tied, leaders: counted.leaders,
    };
  }
  return shaped;
}

/**
 * Cast or change a flat's vote.
 *
 * DELETE THEN INSERT INSIDE ONE BATCH. Two statements outside a batch leave a
 * window where the flat holds no vote at all, and if the second fails the flat
 * has silently abstained. D1 batches are atomic, so the flat's answer goes
 * straight from the old one to the new one.
 */
export async function castVote(env, { pollId, optionIds, viewer, now = new Date().toISOString() }) {
  const poll = await env.DB.prepare('SELECT * FROM polls WHERE id = ?').bind(pollId).first();
  if (!poll || !canSeePoll(poll, viewer)) fail('DDP-POLL-001', { id: pollId });
  assertCanVote(poll, viewer, now);

  const { results: options } = await env.DB.prepare(
    'SELECT id FROM poll_options WHERE poll_id = ?'
  ).bind(pollId).all();

  const check = validateBallot(poll, optionIds, (options ?? []).map((o) => o.id));
  if (!check.ok) fail('DDP-POLL-005', { message: check.message });

  await env.DB.batch([
    env.DB.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND flat = ?')
      .bind(pollId, viewer.flat),
    ...check.ids.map((optionId) => env.DB.prepare(
      `INSERT INTO poll_votes (poll_id, flat, option_id, cast_by, cast_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(pollId, viewer.flat, optionId, viewer.id, now)),
  ]);
  return check.ids;
}

/**
 * Edit a poll that is still open.
 *
 * THREE THINGS FREEZE AND ONE DOES NOT, and the split is the whole of this
 * function:
 *
 *   - **Title, description and tenant visibility** stay editable. A typo in the
 *     preamble is not a change to what anybody voted for.
 *   - **Options, and whether the poll is single or multi-select**, freeze the
 *     moment the first vote lands. Changing "Deccan ₹3,80,000" after thirty-four
 *     flats chose it silently rewrites what they agreed to, and flipping
 *     multi→single would orphan every flat holding more than one row.
 *   - **A closed poll is a record.** No edits at all, for the same reason
 *     nothing reopens one: the committee has seen the count by then, and an
 *     edit after that is indistinguishable from an edit BECAUSE of that.
 *
 * The merged poll is validated whole rather than field by field, so an edit
 * cannot arrive at a state the create path would have refused — two options
 * renamed to the same thing, a pick limit that now exceeds the option count.
 */
export async function updatePoll(env, id, patch = {}, { now = new Date().toISOString() } = {}) {
  const poll = await env.DB.prepare('SELECT * FROM polls WHERE id = ?').bind(id).first();
  if (!poll) fail('DDP-POLL-001', { id });
  if (isClosed(poll, now)) fail('DDP-POLL-008', { id });

  const { results: options } = await env.DB.prepare(
    'SELECT id, label, sort FROM poll_options WHERE poll_id = ? ORDER BY sort'
  ).bind(id).all();
  const cast = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id = ?'
  ).bind(id).first();

  const touchesShape = patch.options !== undefined
    || patch.multi !== undefined
    || patch.maxChoices !== undefined;
  if (touchesShape && optionsFrozen(cast?.n ?? 0)) fail('DDP-POLL-006', { id, votes: cast?.n });

  // The link is not part of the shape: pointing a running poll at the notice
  // somebody has just posted is a correction, not a change to what anybody
  // voted for. Checked against every OTHER poll, so re-saving keeps its own.
  if (patch.noticeId !== undefined) await assertNoticeFree(env, patch.noticeId, id);

  // The poll as it WOULD be, checked by the same function the create path uses.
  const next = {
    title: patch.title ?? poll.title,
    body: patch.body ?? poll.body,
    multi: patch.multi ?? Boolean(poll.multi),
    maxChoices: patch.maxChoices !== undefined ? patch.maxChoices : poll.max_choices,
    closesAt: patch.closesAt ?? poll.closes_at,
    options: patch.options ?? (options ?? []).map((o) => ({ label: o.label })),
  };
  const check = validatePoll({ ...next, now });
  if (!check.ok) fail('DDP-POLL-005', { message: check.message });

  const showTenants = patch.showTenants === undefined
    ? poll.show_tenants
    : (patch.showTenants ? 1 : 0);

  // THE REMINDER MOVES ONLY IF IT HAS NOT GONE OUT. 0036 says so at the column
  // and this is the code it was written for: recomputing the midpoint after the
  // letter has been sent would make the row due again and chase every flat that
  // still has not voted a second time.
  const reminderAt = poll.reminded_at
    ? poll.reminder_at
    : midpoint(poll.created_at, next.closesAt);

  const noticeId = patch.noticeId === undefined
    ? poll.notice_id
    : (patch.noticeId || null);

  const writes = [
    env.DB.prepare(
      `UPDATE polls
          SET title = ?, body = ?, multi = ?, max_choices = ?, show_tenants = ?,
              closes_at = ?, reminder_at = ?, notice_id = ?
        WHERE id = ?`
    ).bind(
      next.title.trim(), next.body.trim(), next.multi ? 1 : 0,
      next.multi ? Number(next.maxChoices) : null, showTenants,
      next.closesAt, reminderAt, noticeId, id,
    ),
  ];

  // Options are replaced wholesale, which is safe ONLY because reaching here
  // means nothing has voted — no poll_votes row can point at the ids this
  // deletes. Guarded above, and stated here because the DELETE looks reckless
  // out of context.
  if (patch.options !== undefined) {
    writes.push(env.DB.prepare('DELETE FROM poll_options WHERE poll_id = ?').bind(id));
    patch.options.forEach((o, i) => writes.push(env.DB.prepare(
      'INSERT INTO poll_options (poll_id, label, sort) VALUES (?, ?, ?)'
    ).bind(id, String(o.label).trim(), i)));
  }

  await env.DB.batch(writes);
  return true;
}

/** Close a poll — early, or because the cron found its time had passed. */
export async function closePoll(env, id, { now = new Date().toISOString() } = {}) {
  const poll = await env.DB.prepare('SELECT * FROM polls WHERE id = ?').bind(id).first();
  assertCanClose(poll, now);
  await env.DB.prepare('UPDATE polls SET closed_at = ?, reminder_at = NULL WHERE id = ?')
    .bind(now, id).run();
  return true;
}

/**
 * Publish the count to residents. A separate act from closing, deliberately.
 *
 * Refused on an open poll: publishing a running count is the one thing the
 * whole design exists to prevent, and "there is no button for it" is a weaker
 * promise than the server saying no.
 */
export async function publishPoll(env, id, { now = new Date().toISOString() } = {}) {
  const poll = await env.DB.prepare('SELECT * FROM polls WHERE id = ?').bind(id).first();
  if (!poll) fail('DDP-POLL-001', { id });
  if (!isClosed(poll, now)) fail('DDP-POLL-007', { id });

  await env.DB.prepare('UPDATE polls SET published_at = ? WHERE id = ?').bind(now, id).run();
  await queuePollMail(env, id, 'result', { now });
  return true;
}

/** Withdraw a published result. The count goes back to being the committee's. */
export async function unpublishPoll(env, id) {
  await env.DB.prepare('UPDATE polls SET published_at = NULL WHERE id = ?').bind(id).run();
  return true;
}

/**
 * The ballot: which flat voted for what, and which owner cast it.
 *
 * SUPERADMIN ONLY, and the route that calls this writes an audit row before
 * returning — invariant 7, the same shape as every other god-mode power.
 * Reading it is not a neutral act and the record of reading it is automatic.
 *
 * Only on a closed poll. On an open one it would be the live ballot, which is
 * a different and much sharper thing than a historical record.
 */
export async function getBallot(env, id, { now = new Date().toISOString() } = {}) {
  const poll = await env.DB.prepare('SELECT * FROM polls WHERE id = ?').bind(id).first();
  if (!poll) fail('DDP-POLL-001', { id });
  if (!isClosed(poll, now)) fail('DDP-POLL-007', { id });

  const { results } = await env.DB.prepare(
    `SELECT v.flat, v.cast_at, o.label AS choice, w.name AS cast_by
       FROM poll_votes v
       JOIN poll_options o ON o.id = v.option_id
       JOIN owners w ON w.id = v.cast_by
      WHERE v.poll_id = ?
      ORDER BY v.flat, o.sort`
  ).bind(id).all();
  return results ?? [];
}

/**
 * Polls whose time has passed but whose row still says open.
 *
 * The cron's only job here. Closing is decided on read — see isClosed — so this
 * is not what makes a poll closed; it is what writes the fact down so the
 * result letter can be queued and the reminder stops being due.
 */
export async function sweepClosures(env, { now = new Date().toISOString() } = {}) {
  const { results } = await env.DB.prepare(
    'SELECT id FROM polls WHERE closed_at IS NULL AND closes_at <= ?'
  ).bind(now).all();
  for (const p of results ?? []) {
    await env.DB.prepare('UPDATE polls SET closed_at = ?, reminder_at = NULL WHERE id = ?')
      .bind(now, p.id).run();
  }
  return (results ?? []).length;
}

/** Polls that have reached their midpoint and not yet been reminded. */
export async function sweepReminders(env, { now = new Date().toISOString() } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT id FROM polls
      WHERE closed_at IS NULL AND reminded_at IS NULL
        AND reminder_at IS NOT NULL AND reminder_at <= ?`
  ).bind(now).all();
  for (const p of results ?? []) await queuePollReminder(env, p.id, { now });
  return (results ?? []).length;
}

/**
 * Ballots are pruned six months after the poll closed.
 *
 * The counts live on the poll row for ever; who voted what does not. This is
 * the same promise `activity` and `click_log` carry in PRIVACY.md — a retention
 * policy, not housekeeping, so it must not quietly stop running.
 *
 * Backups taken before the prune still hold the ballot. That is what a backup
 * is, and it is why `DUMP_QUERIES` waits for a poll to close before exporting
 * it at all.
 */
export const BALLOT_RETENTION_DAYS = 183;

export async function pruneBallots(env, { now = new Date().toISOString() } = {}) {
  const cutoff = new Date(Date.parse(now) - BALLOT_RETENTION_DAYS * 86_400_000).toISOString();
  const res = await env.DB.prepare(
    `DELETE FROM poll_votes
      WHERE poll_id IN (SELECT id FROM polls WHERE closed_at IS NOT NULL AND closed_at < ?)`
  ).bind(cutoff).run();
  return res?.meta?.changes ?? 0;
}
