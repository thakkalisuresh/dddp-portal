/**
 * DD Diamond Park portal — Worker entry.
 * Phase 1 + 1b: auth, sessions, roles, audit, god mode, error reporting.
 * Billing, payments and proofs land in phases 3–6.
 */

import { json, problem, readJson, audit, rateLimit, clearRateLimit, guard } from './lib/http.js';
import { reportError, assertAlerting } from './lib/errors.js';
import { hashPassword, verifyPassword, generateOneTimePassword } from './lib/crypto.js';
import {
  createSession, resolveSession, destroySession, destroyAllSessionsFor,
  cookieHeader, clearCookieHeader, hasRole,
  RESIDENT_TTL_DAYS, IMPERSONATE_TTL_MIN,
} from './lib/session.js';

const ITER = (env) => Number(env.PBKDF2_ITERATIONS ?? 100_000);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

    return guard(env, ctx, async () => {
      const session = await resolveSession(env, request);
      const route = `${request.method} ${path}`;

      // ── public ────────────────────────────────────────────────────────
      if (route === 'POST /api/login') return login(request, env, ctx);
      if (route === 'GET /api/health') return json({ ok: true });

      // ── authenticated ─────────────────────────────────────────────────
      if (!session) return problem(401, 'DDP-AUTH-004', 'Please log in.');

      if (route === 'POST /api/logout') return logout(env, session);
      if (route === 'GET /api/me') return me(env, session);
      if (route === 'POST /api/password') return changePassword(request, env, session);

      // ── admin ─────────────────────────────────────────────────────────
      if (path.startsWith('/api/admin/')) {
        if (!hasRole(session, 'admin')) {
          await reportError(env, 'DDP-ADMIN-004', { path, actor: session.actor.id });
          return problem(403, 'DDP-ADMIN-004', 'Admins only.');
        }
        if (route === 'GET /api/admin/residents') return listResidents(env);
        if (route.startsWith('POST /api/admin/residents/') && path.endsWith('/reset')) {
          return resetPassword(request, env, session, path);
        }
      }

      // ── superadmin / god mode ─────────────────────────────────────────
      if (path.startsWith('/api/god/')) {
        if (!hasRole(session, 'superadmin')) {
          await reportError(env, 'DDP-ADMIN-004', { path, actor: session.actor.id });
          return problem(403, 'DDP-ADMIN-004', 'Superadmin only.');
        }
        if (route.startsWith('GET /api/god/view-as/')) return viewAs(env, session, path);
        if (route.startsWith('POST /api/god/impersonate/')) return impersonate(request, env, session, path);
        if (route === 'POST /api/god/exit') return exitImpersonation(env, session);
        if (route === 'GET /api/god/errors') return errorLog(env);
      }

      return problem(404, 'DDP-SYS-001', 'No such endpoint.');
    });
  },

  async scheduled(event, env, ctx) {
    await assertAlerting(env);
    // Phase 6b: late-fee application. Phase 8: nightly Drive backup.
  },
};

// ── handlers ────────────────────────────────────────────────────────────

async function login(request, env, ctx) {
  const body = await readJson(request);
  const mobile = String(body?.mobile ?? '').replace(/\D/g, '');
  const password = String(body?.password ?? '');
  if (!mobile || !password) return problem(400, 'DDP-AUTH-001', 'Mobile number and password are required.');

  if (!(await rateLimit(env, mobile))) {
    await reportError(env, 'DDP-AUTH-003', { mobile }, ctx);
    return problem(429, 'DDP-AUTH-003', 'Too many attempts. Try again in 15 minutes.');
  }

  const owner = await env.DB.prepare(
    'SELECT id, name, flat, role, pw_hash, pw_salt, must_change_pw FROM owners WHERE mobile = ?'
  ).bind(mobile).first();

  // Same response either way — don't leak which mobiles are registered.
  if (!owner) {
    await reportError(env, 'DDP-AUTH-001', { mobile }, ctx);
    return problem(401, 'DDP-AUTH-002', 'Mobile number or password is incorrect.');
  }

  const ok = await verifyPassword(password, owner.pw_hash, owner.pw_salt, ITER(env));
  if (!ok) {
    await reportError(env, 'DDP-AUTH-002', { mobile }, ctx);
    return problem(401, 'DDP-AUTH-002', 'Mobile number or password is incorrect.');
  }

  await clearRateLimit(env, mobile);
  const ttl = RESIDENT_TTL_DAYS * 86_400;
  const { token, maxAge } = await createSession(env, { actorId: owner.id, ttlSeconds: ttl });
  await audit(env, { actor: { id: owner.id }, subject: { id: owner.id } }, 'login');

  return json(
    { flat: owner.flat, name: owner.name, role: owner.role, mustChangePassword: !!owner.must_change_pw },
    { headers: { 'set-cookie': cookieHeader(token, maxAge) } }
  );
}

async function logout(env, session) {
  await destroySession(env, session.token);
  await audit(env, session, 'logout');
  return json({ ok: true }, { headers: { 'set-cookie': clearCookieHeader() } });
}

async function me(env, session) {
  // Subject comes from the session, never from the client.
  const { subject } = session;
  return json({
    flat: subject.flat,
    name: subject.name,
    mobile: subject.mobile,
    email: subject.email,
    role: subject.role,
    mustChangePassword: subject.mustChangePassword,
    impersonation: session.impersonating
      ? { active: true, by: session.actor.name, canWrite: session.canWrite }
      : { active: false },
    // bills, readings and history arrive in phase 3
  });
}

async function changePassword(request, env, session) {
  if (session.impersonating) {
    await reportError(env, 'DDP-AUTH-007', { actor: session.actor.id, subject: session.subject.id });
    return problem(403, 'DDP-AUTH-007', 'Credentials cannot be changed while viewing as another resident.');
  }

  const body = await readJson(request);
  const current = String(body?.currentPassword ?? '');
  const next = String(body?.newPassword ?? '');
  if (next.length < 8) return problem(400, 'DDP-AUTH-002', 'Choose a password of at least 8 characters.');

  const row = await env.DB.prepare('SELECT pw_hash, pw_salt, must_change_pw FROM owners WHERE id = ?')
    .bind(session.actor.id).first();

  // A forced first-login change doesn't re-ask for the temporary password.
  if (!row.must_change_pw) {
    const ok = await verifyPassword(current, row.pw_hash, row.pw_salt, ITER(env));
    if (!ok) return problem(403, 'DDP-AUTH-002', 'Your current password is incorrect.');
  }

  const { hash, salt } = await hashPassword(next, ITER(env));
  await env.DB.prepare(
    'UPDATE owners SET pw_hash = ?, pw_salt = ?, must_change_pw = 0 WHERE id = ?'
  ).bind(hash, salt, session.actor.id).run();

  await destroyAllSessionsFor(env, session.actor.id);
  await audit(env, session, 'password.change');
  return json({ ok: true, signedOutElsewhere: true }, { headers: { 'set-cookie': clearCookieHeader() } });
}

async function listResidents(env) {
  const { results } = await env.DB.prepare(
    `SELECT o.id, o.flat, f.floor, o.name, o.mobile, o.email, o.role, o.must_change_pw
       FROM owners o JOIN flats f ON f.flat = o.flat
      ORDER BY f.floor, o.flat`
  ).all();
  return json({ residents: results });
}

async function resetPassword(request, env, session, path) {
  const ownerId = Number(path.split('/')[4]);
  const target = await env.DB.prepare('SELECT id, name, flat, mobile, role FROM owners WHERE id = ?')
    .bind(ownerId).first();
  if (!target) return problem(404, 'DDP-AUTH-006', 'No such resident.');

  // Admins reset, they don't read — the old password is a hash and is gone.
  const otp = generateOneTimePassword();
  const { hash, salt } = await hashPassword(otp, ITER(env));
  await env.DB.prepare(
    'UPDATE owners SET pw_hash = ?, pw_salt = ?, must_change_pw = 1 WHERE id = ?'
  ).bind(hash, salt, ownerId).run();
  await destroyAllSessionsFor(env, ownerId);
  await audit(env, session, 'password.reset', { ownerId, flat: target.flat });

  const text = encodeURIComponent(
    `Diamond Park portal — your temporary password is ${otp}\n` +
    `Log in at https://dddp.pages.dev and choose your own password. It expires in 24 hours.`
  );
  return json({
    oneTimePassword: otp,
    expiresInHours: 24,
    whatsapp: `https://wa.me/91${target.mobile}?text=${text}`,
  });
}

// ── god mode ────────────────────────────────────────────────────────────

/** Read-only render of a resident's data. No token issued, no session swapped. */
async function viewAs(env, session, path) {
  const flat = decodeURIComponent(path.split('/')[4] ?? '');
  const owner = await env.DB.prepare(
    'SELECT id, flat, name, mobile, email, role FROM owners WHERE flat = ?'
  ).bind(flat).first();
  if (!owner) return problem(404, 'DDP-ADMIN-001', 'No such flat.');

  await audit(env, session, 'god.view-as', { flat });
  return json({ readOnly: true, subject: owner });
}

async function impersonate(request, env, session, path) {
  const ownerId = Number(path.split('/')[4]);
  const body = await readJson(request);
  const mode = body?.write ? 'impersonate_rw' : 'impersonate_ro';

  const target = await env.DB.prepare('SELECT id, name, flat, role FROM owners WHERE id = ?')
    .bind(ownerId).first();
  if (!target) return problem(404, 'DDP-ADMIN-001', 'No such resident.');
  if (target.role !== 'owner') {
    return problem(403, 'DDP-AUTH-007', 'Admins and superadmins cannot be impersonated.');
  }

  // actor stays the superadmin, so their own session is never overwritten
  const { token, maxAge } = await createSession(env, {
    actorId: session.actor.id,
    subjectId: target.id,
    mode,
    ttlSeconds: IMPERSONATE_TTL_MIN * 60,
  });
  await audit(env, session, 'impersonate.start', { subject: target.id, flat: target.flat, mode });

  return json(
    { impersonating: target.flat, mode, expiresInMinutes: IMPERSONATE_TTL_MIN },
    { headers: { 'set-cookie': cookieHeader(token, maxAge) } }
  );
}

async function exitImpersonation(env, session) {
  await destroySession(env, session.token);
  await audit(env, session, 'impersonate.end');
  const ttl = RESIDENT_TTL_DAYS * 86_400;
  const { token, maxAge } = await createSession(env, { actorId: session.actor.id, ttlSeconds: ttl });
  return json({ ok: true }, { headers: { 'set-cookie': cookieHeader(token, maxAge) } });
}

async function errorLog(env) {
  const { results } = await env.DB.prepare(
    `SELECT code, severity, message, COUNT(*) AS count, MAX(at) AS last_seen
       FROM error_log WHERE at > datetime('now', '-7 days')
      GROUP BY code ORDER BY last_seen DESC`
  ).all();
  return json({ errors: results });
}
