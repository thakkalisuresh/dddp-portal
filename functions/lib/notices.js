/**
 * Notices and their comments.
 *
 * The risk being managed here is social, not technical: a comment thread on a
 * residents' portal is where a community argument can end up living
 * permanently. Three choices keep that in check without a moderation queue
 * nobody will staff (plan §4f):
 *
 *   - comments are opt-in PER NOTICE — a bill announcement needs no thread
 *   - every comment carries a real name and flat; there is no anonymity
 *   - a flat list, no threading, no likes. A noticeboard, not a forum.
 */

import { fail } from './errors.js';
import { shapeAttachments } from './attachments.js';

export const MAX_COMMENT = 1200;
export const RATE_PER_HOUR = 6;

export function validateComment(body) {
  const text = String(body ?? '').trim();
  if (!text) return { ok: false, message: 'Write something first.' };
  if (text.length > MAX_COMMENT) {
    return { ok: false, message: `Keep it under ${MAX_COMMENT} characters.` };
  }
  return { ok: true, text };
}

/**
 * Hidden comments keep their row and their author, so moderation is auditable
 * rather than a silent disappearance. Only an admin sees what was hidden.
 */
export function shapeComments(rows, { isAdmin = false, attachments = [] } = {}) {
  const byComment = new Map();
  for (const a of attachments) {
    if (!byComment.has(a.comment_id)) byComment.set(a.comment_id, []);
    byComment.get(a.comment_id).push(a);
  }

  return rows
    .filter((r) => isAdmin || !r.hidden_at)
    .map((r) => ({
      id: r.id,
      body: r.hidden_at && !isAdmin ? null : r.body,
      name: r.hidden_at && !isAdmin ? null : r.name,
      flat: r.hidden_at && !isAdmin ? null : r.flat,
      createdAt: r.created_at,
      hidden: Boolean(r.hidden_at),
      hiddenBy: isAdmin ? r.hidden_by_name ?? null : undefined,
      // A hidden comment's files go with it. Hiding the words and leaving the
      // photograph would be a moderation action that did not moderate.
      attachments: r.hidden_at && !isAdmin ? [] : shapeAttachments(byComment.get(r.id) ?? []),
    }));
}

export const NOTICE_SCOPES = ['all', 'owners'];

/**
 * Can this viewer see a notice with this scope?
 *
 * The ONE place the rule lives. The list query, the single-notice fetch, the
 * comment endpoint and the unread badge all ask this function rather than
 * repeating the condition — four copies of a visibility rule is four chances
 * for one of them to be wrong, and the one that is wrong is the leak.
 *
 * Owners include ABSENT owners. A landlord living elsewhere is precisely the
 * audience for an AGM paper, and `relationship` says nothing about presence.
 *
 * Admins see everything, because the admin console lists notices through the
 * same endpoint residents do. An admin who happens to be a tenant would
 * otherwise be unable to see — or withdraw — a notice they had just posted.
 */
export function canSeeNotice(scope, viewer) {
  if (scope !== 'owners') return true;
  if (isCommittee(viewer)) return true;
  return viewer?.relationship !== 'tenant';
}

/**
 * May this viewer be served this attachment?
 *
 * A FUNCTION RATHER THAN THREE LINES IN THE ROUTE, because those three lines
 * were wrong the first time they were written: they let `hasRole(session,
 * 'admin')` short-circuit the scope check, and hasRole reads the ACTOR. An
 * admin using view-as therefore carried their own clearance into a tenant's
 * session and was served the AGM papers — canSeeNotice was being consulted and
 * then overruled. Out here it can be tested; in the route it could not.
 *
 * There is no admin bypass at all. canSeeNotice already admits a genuine admin
 * on their own role, which is the only form of admin access that should exist.
 * `active` is required of everyone, matching getNotice: a withdrawn notice
 * stops serving its files to the same people who can no longer read it.
 */
export function canSeeAttachment(row, viewer) {
  if (!row) return false;
  // A withdrawn notice keeps its files, and the committee keeps its access to
  // them — that is what the archive is. Decided on the VIEWER'S OWN role, so
  // an admin using view-as does not carry their clearance into a resident's
  // session; the same rule, and the same reason, as the scope check below.
  if (!row.active && !isCommittee(viewer)) return false;
  return canSeeNotice(row.scope, viewer);
}

/**
 * Committee by the viewer's own role — never the actor's.
 *
 * A committee member counts, and it is the ONE place where they get the same
 * answer as an admin. They write only their own notices, but they READ the
 * board the way the committee does: the whole archive, the owners-scoped
 * papers, and the text of a hidden comment along with who hid it. The
 * reasoning is that a person deciding what to post has to be able to see what
 * has already been said and what had to be taken down — a noticeboard you can
 * write to but not fully read is how the same argument gets started twice.
 *
 * Read access, and nothing else. Every write a committee member cannot do is
 * refused by the rank ladder in session.js, not by this function.
 */
export const isCommittee = (viewer) =>
  viewer?.role === 'committee'
  || viewer?.role === 'admin'
  || viewer?.role === 'superadmin';

/**
 * May this person edit, withdraw or attach to this notice?
 *
 * The asymmetry the committee role is made of: an admin manages the whole
 * board, a committee member manages the notices they posted. Asked of the
 * ACTOR and not the viewer, because this decides a write — the opposite of
 * every rule above it in this file, and the reason it says so in its name.
 *
 * A notice with no `posted_by` predates the column and belongs to nobody, so a
 * committee member fails this and an admin does not. That is the honest
 * outcome: those notices were posted by admins.
 */
export function canManageNotice(notice, actor) {
  if (!notice) return false;
  if (actor?.role === 'admin' || actor?.role === 'superadmin') return true;
  if (actor?.role !== 'committee') return false;
  return notice.posted_by != null && notice.posted_by === actor.id;
}

export async function listNotices(env, viewer) {
  // Built from the same predicate rather than a second copy of the rule.
  const scopeClause = canSeeNotice('owners', viewer) ? '' : " AND n.scope = 'all'";

  const rows = await env.DB.prepare(
    `SELECT n.id, n.title, n.body, n.kind, n.event_date, n.allow_comments, n.posted_at, n.scope,
            COUNT(c.id) FILTER (WHERE c.hidden_at IS NULL) AS comment_count,
            (SELECT COUNT(*) FROM attachments a
              WHERE a.notice_id = n.id AND a.deleted_at IS NULL) AS attachment_count
       FROM notices n
       LEFT JOIN comments c ON c.notice_id = n.id
      WHERE n.active = 1${scopeClause}
      GROUP BY n.id
      ORDER BY n.posted_at DESC`
  ).all();

  return (rows.results ?? []).map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    kind: n.kind,
    eventDate: n.event_date,
    allowComments: Boolean(n.allow_comments),
    postedAt: n.posted_at,
    scope: n.scope ?? 'all',
    commentCount: n.comment_count ?? 0,
    attachmentCount: n.attachment_count ?? 0,
  }));
}

/**
 * Withdrawn notices, for the committee's archive.
 *
 * WHY THIS EXISTS. Withdrawing a notice hid it from everybody, including the
 * superadmin, while its comments and its uploaded files stayed in the database
 * and in R2 — paid for, retained, and reachable by nobody but a hand-written
 * SQL query. Either the record is kept and somebody can read it, or it is
 * destroyed; storing it where no one can look at it is the one option with no
 * argument for it.
 *
 * Counts rather than contents: the archive is a list you scan, and a withdrawn
 * AGM notice with four replies and three attachments should say so without
 * loading all of it.
 */
export async function listArchivedNotices(env) {
  const rows = await env.DB.prepare(
    `SELECT n.id, n.title, n.kind, n.posted_at, n.scope,
            COUNT(DISTINCT c.id) AS comment_count,
            (SELECT COUNT(*) FROM attachments a
              WHERE a.notice_id = n.id AND a.deleted_at IS NULL) AS attachment_count
       FROM notices n
       LEFT JOIN comments c ON c.notice_id = n.id
      WHERE n.active = 0
      GROUP BY n.id
      ORDER BY n.posted_at DESC`
  ).all();

  return (rows.results ?? []).map((n) => ({
    id: n.id,
    title: n.title,
    kind: n.kind,
    postedAt: n.posted_at,
    scope: n.scope ?? 'all',
    commentCount: n.comment_count ?? 0,
    attachmentCount: n.attachment_count ?? 0,
  }));
}

/**
 * Destroy a withdrawn notice and everything hanging off it. Superadmin only.
 *
 * The R2 keys are returned rather than deleted here, because this module does
 * not know about buckets — the caller owns that side and can report a failure
 * to remove an object without leaving the rows half-deleted behind it.
 *
 * Refuses an ACTIVE notice outright. Permanent deletion is a decision about
 * something already withdrawn and considered; making it reachable in one step
 * from a live noticeboard is how a committee loses a thread it meant to keep.
 */
export async function purgeNotice(env, noticeId) {
  const notice = await env.DB.prepare(
    'SELECT id, title, active FROM notices WHERE id = ?'
  ).bind(noticeId).first();
  if (!notice) fail('DDP-NOTICE-001', { noticeId });
  if (notice.active) fail('DDP-NOTICE-005', { noticeId });

  const files = await env.DB.prepare(
    `SELECT a.id, a.r2_key, a.thumb_key FROM attachments a
      LEFT JOIN comments c ON c.id = a.comment_id
     WHERE a.notice_id = ? OR c.notice_id = ?`
  ).bind(noticeId, noticeId).all();

  // Children first: attachments reference comments, comments reference the
  // notice, and the foreign keys are declared in 0001 and 0018.
  await env.DB.prepare(
    `DELETE FROM attachments
      WHERE notice_id = ?
         OR comment_id IN (SELECT id FROM comments WHERE notice_id = ?)`
  ).bind(noticeId, noticeId).run();
  await env.DB.prepare('DELETE FROM comments WHERE notice_id = ?').bind(noticeId).run();
  await env.DB.prepare('DELETE FROM notices WHERE id = ?').bind(noticeId).run();

  return {
    id: noticeId,
    title: notice.title,
    // Thumbnails as well as originals. A thumbnail is a legible copy of the
    // same photograph, so a purge that left them behind would not be one.
    keys: (files.results ?? [])
      .flatMap((f) => [f.r2_key, f.thumb_key])
      .filter(Boolean),
  };
}

/**
 * How many active notices are newer than the last time this resident looked.
 *
 * BOTH SIDES GO THROUGH datetime(), and that is not decoration. This table
 * holds timestamps in two spellings: `postNotice` writes an ISO string from
 * JavaScript (`2026-08-09T19:19:00.000Z`) and anything written in SQL with
 * `datetime('now')` writes `2026-08-09 19:19:00`. Compared as raw strings the
 * space sorts BELOW the T, so a SQLite-spelled notice posted after an
 * ISO-spelled stamp reads as older and never counts — the badge simply stops
 * appearing, with nothing to see in a log. This is the same failure as mobiles
 * stored two ways, which cost this project a UNIQUE index.
 *
 * The fallback is 1970 rather than '', because datetime('') is NULL and the
 * whole comparison would go NULL with it — leaving a resident who has never
 * opened the board with no badge at all, which is precisely the person it
 * exists for.
 */
export async function unreadNoticeCount(env, viewer) {
  // Scope applies to the badge as much as to the list, and forgetting it here
  // would be worse than a leak: a tenant would carry a permanent "1" for a
  // notice the board never shows them, and opening the tab would not clear it.
  const scopeClause = canSeeNotice('owners', viewer) ? '' : " AND scope = 'all'";

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM notices
      WHERE active = 1${scopeClause}
        AND datetime(posted_at) >
            datetime(COALESCE((SELECT notices_seen_at FROM owners WHERE id = ?), '1970-01-01'))`
  ).bind(viewer.id).first();
  return row?.n ?? 0;
}

/**
 * Stamped when the resident opens the notice list, which is the only honest
 * definition of "seen" available without tracking scroll position. Deliberately
 * not stamped by the unread count itself — that runs on every page load and
 * would clear the badge from screens the notice board is not even on.
 */
export async function markNoticesSeen(env, ownerId, at = new Date().toISOString()) {
  await env.DB.prepare('UPDATE owners SET notices_seen_at = ? WHERE id = ?')
    .bind(at, ownerId).run();
  return at;
}

export async function getNotice(env, noticeId, { isAdmin = false, viewer = null, includeWithdrawn = false } = {}) {
  const notice = await env.DB.prepare(
    'SELECT * FROM notices WHERE id = ?'
  ).bind(noticeId).first();
  if (!notice) return null;

  // Withdrawn notices are readable only from the archive, and only by the
  // committee. Gated on the viewer's own role for the usual reason: view-as
  // must not let an admin's clearance leak into a resident's session.
  if (!notice.active && !(includeWithdrawn && isCommittee(viewer))) return null;

  // Checked here as well as in the list, because a notice id is a small
  // integer and the list is not the only way to reach one. Returning null
  // rather than a 403 also declines to confirm that the notice exists.
  if (!canSeeNotice(notice.scope, viewer)) return null;

  const rows = await env.DB.prepare(
    `SELECT c.id, c.body, c.created_at, c.hidden_at, c.hidden_by,
            o.name, o.flat, h.name AS hidden_by_name
       FROM comments c
       JOIN owners o ON o.id = c.owner_id
       LEFT JOIN owners h ON h.id = c.hidden_by
      WHERE c.notice_id = ?
      ORDER BY c.created_at`
  ).bind(noticeId).all();

  // Both sets of files in one query rather than one per comment: a thread with
  // twenty replies would otherwise be twenty round trips to D1.
  const files = await env.DB.prepare(
    `SELECT a.id, a.notice_id, a.comment_id, a.filename, a.content_type, a.bytes,
            a.thumb_key, a.deleted_at
       FROM attachments a
       LEFT JOIN comments c ON c.id = a.comment_id
      WHERE a.notice_id = ? OR c.notice_id = ?
      ORDER BY a.id`
  ).bind(noticeId, noticeId).all();
  const all = files.results ?? [];

  return {
    id: notice.id,
    title: notice.title,
    body: notice.body,
    kind: notice.kind,
    eventDate: notice.event_date,
    allowComments: Boolean(notice.allow_comments),
    postedAt: notice.posted_at,
    scope: notice.scope ?? 'all',
    // Who wrote it, so the caller can ask canManageNotice. Not a name and not
    // shown anywhere — an id the router compares against the actor. The board
    // still attributes notices to the association rather than to a person,
    // which is what a notice from the committee is.
    postedBy: notice.posted_by ?? null,
    attachments: shapeAttachments(all.filter((a) => a.notice_id === noticeId)),
    comments: shapeComments(rows.results ?? [], {
      isAdmin,
      attachments: all.filter((a) => a.comment_id != null),
    }),
  };
}

export async function addComment(env, { noticeId, ownerId, body, viewer = null }) {
  const notice = await env.DB.prepare(
    'SELECT id, allow_comments, scope FROM notices WHERE id = ? AND active = 1'
  ).bind(noticeId).first();
  if (!notice) fail('DDP-NOTICE-001', { noticeId });
  // Scoped before anything else. Without this the scope leaks through replies:
  // a tenant could post on an owners-only notice, and every owner reading the
  // thread would see them there — which tells them the notice exists and that
  // its audience is not what the committee chose.
  if (!canSeeNotice(notice.scope, viewer)) fail('DDP-NOTICE-001', { noticeId });
  if (!notice.allow_comments) fail('DDP-NOTICE-002', { noticeId });

  const check = validateComment(body);
  if (!check.ok) fail('DDP-NOTICE-003', { reason: check.message });

  const since = new Date(Date.now() - 3600_000).toISOString();
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM comments WHERE owner_id = ? AND created_at > ?'
  ).bind(ownerId, since).first();
  if ((recent?.n ?? 0) >= RATE_PER_HOUR) fail('DDP-NOTICE-004', { ownerId });

  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO comments (notice_id, owner_id, body, created_at)
     VALUES (?, ?, ?, ?) RETURNING id`
  ).bind(noticeId, ownerId, check.text, now).first();

  return { id: row.id, createdAt: now };
}

/** Soft hide — the row and its author survive, so moderation is auditable. */
export async function setCommentHidden(env, commentId, adminId, hidden) {
  const comment = await env.DB.prepare('SELECT id FROM comments WHERE id = ?').bind(commentId).first();
  if (!comment) fail('DDP-NOTICE-001', { commentId });

  await env.DB.prepare(
    'UPDATE comments SET hidden_by = ?, hidden_at = ? WHERE id = ?'
  ).bind(hidden ? adminId : null, hidden ? new Date().toISOString() : null, commentId).run();

  return { commentId, hidden };
}
