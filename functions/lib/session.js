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
            a.active AS actor_active,
            a.relationship AS actor_relationship,
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

  // A deactivated ACTOR has no session, whatever the row says. Deactivation
  // sites also delete sessions, but that is a second write that can be missed
  // (nine accounts kept 30 live sessions on 2026-09-11); this is the check that
  // cannot be. Only this token goes — destroyAllSessionsFor would also end an
  // admin's god-mode session that happens to be viewing this person.
  //
  // An inactive SUBJECT is deliberately allowed. For a normal session subject
  // and actor are the same row, so the check above already covers it; the only
  // way to reach one is an active admin impersonating a departed resident,
  // which is how their history is read. billAccess and the tenancy rules act on
  // subject.active from there.
  if (Number(row.actor_active ?? 1) !== 1) {
    await reportError(env, 'DDP-AUTH-019', { actorId: row.actor_id, tokenPrefix: token.slice(0, 6) });
    await destroySession(env, token);
    return null;
  }

  return {
    token,
    mode: row.mode,
    impersonating: row.mode !== 'normal',
    canWrite: row.mode !== 'impersonate_ro',
    actor: {
      id: row.actor_id, name: row.actor_name, role: row.actor_role, flat: row.actor_flat,
      relationship: row.actor_relationship ?? 'owner',
    },
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

  // Polls, on the same terms as notices: a committee member may put a question
  // to the building, and may close or publish THE POLLS THEY POSTED. That
  // second narrowing needs the row, so it happens in managePoll rather than
  // here — reaching a route is not being allowed to change what is behind it.
  //
  // The ballot is deliberately absent. It is the superadmin's alone, and the
  // router checks that separately; a committee member must not reach it even
  // for a poll they created.
  if (method === 'POST' && path === '/api/admin/polls') return true;
  if (method === 'PATCH' && /^\/api\/admin\/polls\/\d+$/.test(path)) return true;
  if (method === 'POST' && /^\/api\/admin\/polls\/\d+\/(close|publish|unpublish)$/.test(path)) {
    return true;
  }
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

/**
 * What an account on a temporary password may do before choosing its own.
 *
 * The redirect to /password lived only in the browser, so the temporary
 * password — the one an admin read out, or emailed, or that sat in a message
 * thread — was a full login for anybody who called the API directly. The
 * account's first act has to be replacing it, and the server is the only place
 * that can insist.
 *
 * An ALLOWLIST, read on the method and path. `GET /api/me` is on it because the
 * password page needs the name and email to prefill; `/api/onboard` and
 * `/api/password` are how the state ends; the telemetry pair records nothing a
 * resident can use. Everything else, reads included, waits.
 *
 * Only for a session's own account. An admin impersonating somebody who has not
 * finished setting up is reading their screen, not holding their password.
 */
const FORCED_CHANGE_ROUTES = new Set([
  'GET /api/me', 'POST /api/password', 'POST /api/onboard', 'POST /api/logout',
  'POST /api/activity', 'GET /api/capture', 'POST /api/clicks',
]);

export function forcedChangeRefuses(session, method, path) {
  if (!session || session.impersonating) return false;
  if (!session.subject?.mustChangePassword) return false;
  return !FORCED_CHANGE_ROUTES.has(`${method} ${path}`);
}

/**
 * The one place impersonation's limits are enforced for every route.
 *
 * Rank is read off the ACTOR (see hasRole), so a superadmin viewing as a
 * resident still clears the /api/admin and /api/god gates. Before this, "read
 * only" meant the handful of resident handlers that remembered to ask — a
 * view-as session could publish bills, change roles and hand over the
 * superadmin, all attributed to a session whose subject was somebody else.
 *
 *  - Reads always pass. Looking is what impersonation is for.
 *  - Leaving always passes: logout, and /api/god/exit.
 *  - Read-only refuses every other write.
 *  - Write mode exists to act AS the resident, so it refuses administration:
 *    an admin who wants to change the building exits first, and the audit row
 *    then names the admin rather than the flat they happened to be looking at.
 *
 * Returns a refusal message, or null to let the request through.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const ALWAYS_WHILE_IMPERSONATING = new Set([
  'POST /api/logout', 'POST /api/god/exit', 'POST /api/activity', 'POST /api/clicks',
]);

export function impersonationRefuses(session, method, path) {
  if (!session?.impersonating) return null;
  if (SAFE_METHODS.has(method)) return null;
  if (ALWAYS_WHILE_IMPERSONATING.has(`${method} ${path}`)) return null;
  // The banner's "Allow writes" re-impersonates from inside the read-only
  // session. It changes which view the actor holds, never the building, and
  // the /api/god gate still insists on a superadmin behind it.
  if (method === 'POST' && /^\/api\/god\/impersonate\/\d+$/.test(path)) return null;
  if (!session.canWrite) return 'This is a read-only view. Exit it to make changes.';
  if (path.startsWith('/api/admin/') || path.startsWith('/api/god/')) {
    return 'Exit the resident view before changing anything for the building.';
  }
  return null;
}
