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
