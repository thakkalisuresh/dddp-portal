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
export function shapeComments(rows, { isAdmin = false } = {}) {
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
    }));
}

export async function listNotices(env) {
  const rows = await env.DB.prepare(
    `SELECT n.id, n.title, n.body, n.kind, n.event_date, n.allow_comments, n.posted_at,
            COUNT(c.id) FILTER (WHERE c.hidden_at IS NULL) AS comment_count
       FROM notices n
       LEFT JOIN comments c ON c.notice_id = n.id
      WHERE n.active = 1
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
    commentCount: n.comment_count ?? 0,
  }));
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
export async function unreadNoticeCount(env, ownerId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM notices
      WHERE active = 1
        AND datetime(posted_at) >
            datetime(COALESCE((SELECT notices_seen_at FROM owners WHERE id = ?), '1970-01-01'))`
  ).bind(ownerId).first();
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

export async function getNotice(env, noticeId, { isAdmin = false } = {}) {
  const notice = await env.DB.prepare(
    'SELECT * FROM notices WHERE id = ? AND active = 1'
  ).bind(noticeId).first();
  if (!notice) return null;

  const rows = await env.DB.prepare(
    `SELECT c.id, c.body, c.created_at, c.hidden_at, c.hidden_by,
            o.name, o.flat, h.name AS hidden_by_name
       FROM comments c
       JOIN owners o ON o.id = c.owner_id
       LEFT JOIN owners h ON h.id = c.hidden_by
      WHERE c.notice_id = ?
      ORDER BY c.created_at`
  ).bind(noticeId).all();

  return {
    id: notice.id,
    title: notice.title,
    body: notice.body,
    kind: notice.kind,
    eventDate: notice.event_date,
    allowComments: Boolean(notice.allow_comments),
    postedAt: notice.posted_at,
    comments: shapeComments(rows.results ?? [], { isAdmin }),
  };
}

export async function addComment(env, { noticeId, ownerId, body }) {
  const notice = await env.DB.prepare(
    'SELECT id, allow_comments FROM notices WHERE id = ? AND active = 1'
  ).bind(noticeId).first();
  if (!notice) fail('DDP-NOTICE-001', { noticeId });
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
