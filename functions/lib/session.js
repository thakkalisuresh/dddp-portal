/**
 * Sessions carry actor_id (who really logged in) and subject_id (whose data is
 * shown) as separate columns, so god mode never overwrites the admin's own
 * session and "Exit" can't strand you (plan §5.5).
 *
 * THE RULE: the client never sends an identity. The subject is always derived
 * from the token server-side. Any handler taking a flat or owner id is
 * admin-only and re-checks the role.
 */

import { newSessionToken } from './crypto.js';
import { reportError } from './errors.js';

export const COOKIE = 'dddp_session';
export const RESIDENT_TTL_DAYS = 90;      // logging in monthly shouldn't mean resetting monthly
/** Unticked "remember me": the row still lives, but only until the browser closes. */
export const SHARED_DEVICE_TTL_DAYS = 1;
export const IMPERSONATE_TTL_MIN = 30;

/**
 * @param maxAgeSeconds  how long the cookie lives; null makes it a SESSION
 *                       cookie, which the browser drops when it closes.
 *
 * The null case is what "remember me" being unticked has to mean. Without it
 * the checkbox would be decoration: the session row already lasts 90 days
 * either way, so only the cookie's lifetime can make the two states differ.
 */
export function cookieHeader(token, maxAgeSeconds) {
  const parts = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    ...(maxAgeSeconds == null ? [] : [`Max-Age=${maxAgeSeconds}`]),
  ];
  return parts.join('; ');
}

export function clearCookieHeader() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(request) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

export async function createSession(env, { actorId, subjectId = actorId, mode = 'normal', ttlSeconds }) {
  const token = newSessionToken();
  const now = new Date();
  const expires = new Date(now.getTime() + ttlSeconds * 1000);
  await env.DB.prepare(
    `INSERT INTO sessions (token, actor_id, subject_id, mode, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(token, actorId, subjectId, mode, expires.toISOString(), now.toISOString()).run();
  return { token, expiresAt: expires, maxAge: ttlSeconds };
}

/** Resolve a request to { session, actor, subject } or null. */
export async function resolveSession(env, request) {
  const token = readCookie(request);
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT s.token, s.actor_id, s.subject_id, s.mode, s.expires_at,
            a.name  AS actor_name,  a.role AS actor_role, a.flat AS actor_flat,
            b.name  AS subject_name, b.role AS subject_role, b.flat AS subject_flat,
            b.mobile AS subject_mobile, b.email AS subject_email,
            b.must_change_pw AS subject_must_change_pw,
            -- Needed by the tenancy rules. Without them billAccess reads
            -- undefined as "departed" and locks everyone out of their own
            -- dashboard, which is exactly what happened.
            b.relationship AS subject_relationship, b.active AS subject_active
       FROM sessions s
       JOIN owners a ON a.id = s.actor_id
       JOIN owners b ON b.id = s.subject_id
      WHERE s.token = ?`
  ).bind(token).first();

  if (!row) {
    await reportError(env, 'DDP-AUTH-004', { tokenPrefix: token.slice(0, 6) });
    return null;
  }
  if (new Date(row.expires_at) < new Date()) {
    await destroySession(env, token);
    return null;
  }

  return {
    token,
    mode: row.mode,
    impersonating: row.mode !== 'normal',
    canWrite: row.mode !== 'impersonate_ro',
    actor: { id: row.actor_id, name: row.actor_name, role: row.actor_role, flat: row.actor_flat },
    subject: {
      id: row.subject_id,
      name: row.subject_name,
      role: row.subject_role,
      flat: row.subject_flat,
      mobile: row.subject_mobile,
      email: row.subject_email,
      mustChangePassword: !!row.subject_must_change_pw,
      relationship: row.subject_relationship ?? 'owner',
      active: row.subject_active ?? 1,
    },
  };
}

export async function destroySession(env, token) {
  await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

/** Used on password change — every other device is signed out. */
export async function destroyAllSessionsFor(env, ownerId) {
  await env.DB.prepare('DELETE FROM sessions WHERE actor_id = ? OR subject_id = ?')
    .bind(ownerId, ownerId).run();
}

/**
 * The ladder. `committee` was inserted at rung 1 rather than bolted on at the
 * top, and the insertion is the whole safety argument: every existing
 * `hasRole(session, 'admin')` in the router — residents, billing, roster,
 * readings, the lot — goes on refusing a committee member without one of those
 * call sites being edited or even read. A new role that defaults to "no" is a
 * role you can reason about; one that defaults to "yes" everywhere except
 * where somebody remembered to say no is not.
 *
 * The single thing a committee member may reach lives in `committeeMayUse`,
 * below, as an explicit list of routes.
 */
export const ROLE_RANK = { owner: 0, committee: 1, admin: 2, superadmin: 3 };

export function hasRole(session, minimum) {
  if (!session) return false;
  return ROLE_RANK[session.actor.role] >= ROLE_RANK[minimum];
}

/**
 * The committee member's exception to the admins-only gate on `/api/admin/*`.
 *
 * AN ALLOWLIST OF ROUTES, matched on method and path, and deliberately not a
 * flag consulted inside each handler. The gate in the router is one `if` that
 * every admin route sits behind; the way to let one role past it without
 * weakening it for the rest is to name the routes here, where they can be read
 * in one screen and tested without a database.
 *
 * Reaching a route is not the same as being allowed to change what is behind
 * it. These five let a committee member CREATE a notice, and read the archive
 * — the reads were asked for in full, so `listArchivedNotices` is shared with
 * admins as it stands. Editing, withdrawing and attaching are narrowed a
 * second time inside their handlers to notices this person actually posted;
 * that check needs the row, so it cannot happen out here.
 */
export function committeeMayUse(method, path) {
  if (method === 'POST' && path === '/api/admin/notices') return true;
  if (method === 'PATCH' && /^\/api\/admin\/notices\/\d+$/.test(path)) return true;
  if (method === 'POST' && /^\/api\/admin\/notices\/\d+\/attachments$/.test(path)) return true;
  if (method === 'GET' && path === '/api/admin/notices/archive') return true;
  if (method === 'GET' && /^\/api\/admin\/notices\/\d+\/archived$/.test(path)) return true;
  // Removing a file from a notice is the other half of attaching one. Narrowed
  // to the poster's own notice in the handler, which is also where a comment
  // attachment — a resident's photograph, and a moderation act — is refused.
  if (method === 'DELETE' && /^\/api\/admin\/attachments\/\d+$/.test(path)) return true;
  return false;
}

/**
 * Credential changes are blocked while impersonating, even in write mode —
 * they could lock the real resident out of their own account (plan §5.5).
 */
export const CREDENTIAL_ACTIONS = new Set([
  'password.change', 'mobile.change', 'email.change', 'owner.delete',
]);

export function isBlockedWhileImpersonating(action) {
  return CREDENTIAL_ACTIONS.has(action);
}
