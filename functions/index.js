/**
 * DD Diamond Park portal — Worker entry.
 * Phase 1 + 1b: auth, sessions, roles, audit, god mode, error reporting.
 * Billing, payments and proofs land in phases 3–6.
 */

import { json, problem, readJson, audit, rateLimit, clearRateLimit, guard, withSecurityHeaders } from './lib/http.js';
import { reportError, assertAlerting } from './lib/errors.js';
import { hashPassword, verifyPassword, generateOneTimePassword, sha256Hex } from './lib/crypto.js';
import { dashboardPayload } from './lib/dashboard.js';
import {
  readingGrid, saveReadings, generateBills, openPeriod, parseReadings,
  previousPeriod, jumpWarning,
} from './lib/admin.js';
import { previewGeneration, computeBill } from './lib/billing.js';
import { validateUpload, assessProof, shapeQueue, r2Key } from './lib/proof.js';
import { readReceipt } from './lib/vision.js';
import { runScheduled, applyLateFees, staleIntents } from './lib/cron.js';
import { listNotices, getNotice, addComment, setCommentHidden } from './lib/notices.js';
import { publicNotices, submitMessage, fingerprintOf, AMENITIES } from './lib/public.js';
import { transferFlat, canChangeRole, planHandover, outstandingFor, mergeTimeline, toIST } from './lib/tenancy.js';
import {
  OWNER_FIELDS, BILL_FIELDS, validateOwnerField, validateBillField,
  lockoutCheck, applyBillEdit, computedTotal, isUnexplainedMismatch,
  diff, checkReason, normaliseMobile,
} from './lib/godedit.js';
import { isCaptureOn, captureWindow, validateBatch } from './lib/clicks.js';
import { runBackup, backupHealth, pruneOldRows, dumpTable, dumpAll, bundle, toCsv, TABLES } from './lib/backup.js';
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

    // Static assets get the same headers as the API — a CSP that only covers
    // JSON responses protects nothing.
    if (!path.startsWith('/api/')) {
      return withSecurityHeaders(await env.ASSETS.fetch(request));
    }

    return withSecurityHeaders(await guard(env, ctx, async () => {
      const session = await resolveSession(env, request);
      const route = `${request.method} ${path}`;

      // ── public ────────────────────────────────────────────────────────
      if (route === 'POST /api/login') return login(request, env, ctx);
      if (route === 'GET /api/health') return json({ ok: true });

      // ── public: no session required ───────────────────────────────────
      if (route === 'GET /api/public/notices') {
        const committee = await env.DB.prepare(
          'SELECT role, name, flat, phone FROM committee WHERE active = 1 ORDER BY sort'
        ).all();
        return json({
          notices: await publicNotices(env),
          committee: committee.results ?? [],
          amenities: AMENITIES,
        });
      }
      if (route === 'POST /api/public/contact') {
        const body = await readJson(request);
        const result = await submitMessage(env, body ?? {}, fingerprintOf(request));
        return json(result, { status: 201 });
      }

      // ── authenticated ─────────────────────────────────────────────────
      if (!session) return problem(401, 'DDP-AUTH-004', 'Please log in.');

      if (route === 'POST /api/logout') return logout(env, session);
      if (route === 'GET /api/me') return me(env, session, request);
      if (route === 'POST /api/password') return changePassword(request, env, session);
      if (route === 'POST /api/onboard') return onboard(request, env, session);
      if (route === 'PATCH /api/me') return patchProfile(request, env, session);
      if (route === 'POST /api/activity') return recordActivity(request, env, session);
      if (route === 'GET /api/capture')   return captureState(env);
      if (route === 'POST /api/clicks')   return recordClicks(request, env, session);
      if (request.method === 'POST' && /^\/api\/bills\/\d+\/intent$/.test(path)) {
        return logIntent(env, session, path);
      }
      if (request.method === 'POST' && /^\/api\/bills\/\d+\/proof$/.test(path)) {
        return uploadProof(request, env, session, ctx, path);
      }
      if (request.method === 'GET' && /^\/api\/proof\/\d+\/image$/.test(path)) {
        return proofImage(env, session, path);
      }

      // ── notices ───────────────────────────────────────────────────────
      if (route === 'GET /api/notices') return json({ notices: await listNotices(env) });
      if (request.method === 'GET' && /^\/api\/notices\/\d+$/.test(path)) {
        const notice = await getNotice(env, Number(path.split('/')[3]),
          { isAdmin: hasRole(session, 'admin') });
        return notice ? json(notice) : problem(404, 'DDP-NOTICE-001', 'That notice could not be found.');
      }
      if (request.method === 'POST' && /^\/api\/notices\/\d+\/comments$/.test(path)) {
        return postComment(request, env, session, path);
      }

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
        if (route === 'GET /api/admin/readings')  return getReadings(env, url);
        if (route === 'PUT /api/admin/readings')  return putReadings(request, env, session, url);
        if (route === 'POST /api/admin/readings/parse') return parseImport(request, env, url);
        if (route === 'GET /api/admin/preview')   return getPreview(env, url);
        if (route === 'POST /api/admin/periods')  return postPeriod(request, env, session);
        if (route.startsWith('POST /api/admin/periods/') && path.endsWith('/generate')) {
          return postGenerate(env, session, path);
        }
        if (route === 'GET /api/admin/proofs') return proofQueue(env);
        if (request.method === 'POST' && /^\/api\/admin\/proofs\/\d+\/approve$/.test(path)) {
          return reviewProof(env, session, path, true);
        }
        if (request.method === 'POST' && /^\/api\/admin\/proofs\/\d+\/reject$/.test(path)) {
          return reviewProof(env, session, path, false);
        }
        if (request.method === 'POST' && /^\/api\/admin\/bills\/\d+\/mark-paid$/.test(path)) {
          return markPaid(request, env, session, path);
        }
        if (request.method === 'POST' && /^\/api\/admin\/bills\/\d+\/waive-late-fee$/.test(path)) {
          return waiveLateFee(env, session, path);
        }
        if (request.method === 'POST' && /^\/api\/admin\/comments\/\d+\/(hide|unhide)$/.test(path)) {
          const hidden = path.endsWith('/hide');
          const result = await setCommentHidden(env, Number(path.split('/')[4]), session.actor.id, hidden);
          await audit(env, session, hidden ? 'comment.hide' : 'comment.unhide', result);
          return json(result);
        }
        if (route === 'GET /api/admin/late-fees') {
          return json({ preview: await applyLateFees(env, { today: '1970-01-01' }),
                        stale: await staleIntents(env) });
        }
        if (route === 'GET /api/admin/export') return exportData(env, session, url);
        if (route === 'GET /api/admin/backup-health') return json(await backupHealth(env));
        if (route === 'GET /api/admin/messages') {
          const rows = await env.DB.prepare(
            'SELECT * FROM messages ORDER BY handled_at IS NOT NULL, created_at DESC LIMIT 100'
          ).all();
          return json({ messages: rows.results ?? [] });
        }
        if (request.method === 'POST' && /^\/api\/admin\/messages\/\d+\/handled$/.test(path)) {
          const id = Number(path.split('/')[4]);
          await env.DB.prepare('UPDATE messages SET handled_by = ?, handled_at = ? WHERE id = ?')
            .bind(session.actor.id, new Date().toISOString(), id).run();
          await audit(env, session, 'message.handled', { id });
          return json({ id, handled: true });
        }
        if (route === 'POST /api/admin/transfer') return postTransfer(request, env, session);
        if (route === 'GET /api/admin/committee') {
          const rows = await env.DB.prepare('SELECT * FROM committee ORDER BY sort').all();
          return json({ committee: rows.results ?? [] });
        }
        if (route === 'PUT /api/admin/committee') return putCommittee(request, env, session);
        if (route === 'GET /api/admin/periods') {
          const rows = await env.DB.prepare('SELECT * FROM periods ORDER BY period DESC').all();
          return json({ periods: rows.results ?? [] });
        }
        if (route === 'POST /api/admin/notices')  return postNotice(request, env, session);
        if (request.method === 'PATCH' && /^\/api\/admin\/notices\/\d+$/.test(path)) {
          return patchNotice(request, env, session, path);
        }
        if (route === 'POST /api/admin/residents') return postResident(request, env, session);
        if (request.method === 'PATCH' && /^\/api\/admin\/residents\/\d+$/.test(path)) {
          return patchResident(request, env, session, path);
        }
        if (request.method === 'PATCH' && /^\/api\/admin\/bills\/\d+$/.test(path)) {
          return patchBill(request, env, session, path);
        }
        if (route === 'GET /api/admin/proofs/archive') return proofArchive(env, url);
        if (request.method === 'DELETE' && /^\/api\/admin\/proofs\/\d+$/.test(path)) {
          return deleteProof(env, session, path);
        }
        if (route === 'POST /api/admin/run-scheduled') {
          const result = await runScheduled(env, ctx);
          await audit(env, session, 'cron.manual', result);
          return json(result ?? { error: 'see error log' });
        }
      }

      // ── superadmin / god mode ─────────────────────────────────────────
      if (path.startsWith('/api/god/')) {
        if (!hasRole(session, 'superadmin')) {
          await reportError(env, 'DDP-ADMIN-004', { path, actor: session.actor.id });
          return problem(403, 'DDP-ADMIN-004', 'Superadmin only.');
        }
        if (route === 'GET /api/god/residents') {
          const r = await env.DB.prepare(
            `SELECT id, flat, name, role FROM owners WHERE active = 1 AND role = 'owner'
              ORDER BY flat`).all();
          return json({ residents: r.results ?? [] });
        }
        if (route.startsWith('GET /api/god/view-as/')) return viewAs(env, session, path);
        if (route.startsWith('POST /api/god/impersonate/')) return impersonate(request, env, session, path);
        if (route === 'POST /api/god/exit') return exitImpersonation(env, session);
        if (route === 'GET /api/god/errors') return errorLog(env);
        if (route === 'GET /api/god/timeline') return timeline(env, url);
        if (route === 'GET /api/god/clicks') return clickLog(env, url);
        if (route === 'GET /api/god/export') return exportLogs(env, session, url);
        if (route === 'POST /api/god/capture') return setCapture(request, env, session);
        if (route === 'POST /api/god/handover') return handover(request, env, session);
        if (route === 'GET /api/god/people') return godPeople(env);
        if (route === 'GET /api/god/bills')  return godBills(env, url);
        if (route === 'GET /api/god/edits')  return godEdits(env, url);
        if (route.startsWith('PATCH /api/god/owner/')) return editOwner(request, env, session, path);
        if (route.startsWith('PATCH /api/god/bill/'))  return editBill(request, env, session, path);
      }

      return problem(404, 'DDP-SYS-001', 'No such endpoint.');
    }));
  },

  async scheduled(event, env, ctx) {
    await assertAlerting(env);
    await runScheduled(env, ctx);
    await runBackup(env, ctx);
    await pruneOldRows(env);
  },
};

// ── handlers ────────────────────────────────────────────────────────────

async function login(request, env, ctx) {
  const body = await readJson(request);
  const password = String(body?.password ?? '');
  // Normalised to E.164 exactly as god edits and the roster import store it.
  // Before this, an owner whose number had been saved with a country code
  // could not log in at all: the lookup compared bare digits against '+91...'.
  // A resident still types the 10 digits they always have.
  let mobile;
  try {
    mobile = normaliseMobile(body?.mobile);
  } catch {
    return problem(400, 'DDP-AUTH-001', 'Enter a valid mobile number.');
  }
  if (!password) return problem(400, 'DDP-AUTH-001', 'Mobile number and password are required.');

  if (!(await rateLimit(env, mobile))) {
    await reportError(env, 'DDP-AUTH-003', { mobile }, ctx);
    return problem(429, 'DDP-AUTH-003', 'Too many attempts. Try again in 15 minutes.');
  }

  const owner = await env.DB.prepare(
    'SELECT id, name, flat, role, pw_hash, pw_salt, must_change_pw FROM owners WHERE mobile = ? AND active = 1'
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

async function me(env, session, request) {
  // Subject comes from the session, never from the client.
  const payload = await dashboardPayload(env, session.subject, request.headers.get('user-agent') ?? '');
  return json({
    ...payload,
    impersonation: session.impersonating
      ? { active: true, by: session.actor.name, canWrite: session.canWrite }
      : { active: false },
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

/**
 * The resident tapped Pay.
 *
 * This records an INTENT, not a payment. Nothing downstream may treat it as
 * proof: there is no callback from UPI, so all this says is "they opened their
 * app". Its value is that the treasurer gets a shortlist to check the bank
 * statement against, and that the late-fee cron holds rather than charges
 * (plan §4e).
 *
 * The bill is resolved through the SESSION's flat — a resident cannot log an
 * intent against someone else's bill by changing the id in the URL.
 */
async function logIntent(env, session, path) {
  const billId = Number(path.split('/')[3]);

  const bill = await env.DB.prepare(
    `SELECT id, flat, status, total FROM bills
      WHERE id = ? AND flat = ? AND (owner_id IS NULL OR owner_id = ?)`
  ).bind(billId, session.subject.flat, session.subject.id).first();

  if (!bill) return problem(404, 'DDP-PAY-001', 'That bill could not be found.');

  if (bill.status === 'paid' || bill.status === 'waived') {
    await reportError(env, 'DDP-PAY-003', { billId, status: bill.status });
    return problem(409, 'DDP-PAY-003', 'This bill is already settled.');
  }

  // Read-only impersonation must not leave footprints in a resident's record.
  if (session.impersonating && !session.canWrite) {
    return json({ recorded: false, reason: 'read-only session', status: bill.status });
  }

  await env.DB.batch([
    env.DB.prepare('INSERT INTO payment_intents (bill_id, created_at) VALUES (?, ?)')
      .bind(bill.id, new Date().toISOString()),
    // Only 'unpaid' advances. A bill already awaiting review must not regress
    // to 'initiated' because the resident tapped Pay a second time.
    env.DB.prepare("UPDATE bills SET status = 'initiated' WHERE id = ? AND status = 'unpaid'")
      .bind(bill.id),
  ]);

  await audit(env, session, 'payment.intent', { billId: bill.id, total: bill.total });
  return json({ recorded: true, status: bill.status === 'unpaid' ? 'initiated' : bill.status });
}

async function postComment(request, env, session, path) {
  // Impersonation must never post in a resident's name — a comment carries
  // their name and flat to everyone in the building.
  if (session.impersonating) {
    return problem(403, 'DDP-AUTH-007', 'Cannot post while viewing as another resident.');
  }
  const body = await readJson(request);
  const result = await addComment(env, {
    noticeId: Number(path.split('/')[3]),
    ownerId: session.actor.id,
    body: body?.body,
  });
  await audit(env, session, 'comment.post', { noticeId: Number(path.split('/')[3]) });
  return json(result, { status: 201 });
}

/**
 * Waiving is one click and records who did it. These are neighbours, not
 * customers — somebody will be in hospital (plan §4e).
 */
async function waiveLateFee(env, session, path) {
  const billId = Number(path.split('/')[4]);
  const bill = await env.DB.prepare(
    'SELECT id, total, late_fee FROM bills WHERE id = ?'
  ).bind(billId).first();
  if (!bill) return problem(404, 'DDP-PAY-001', 'That bill could not be found.');
  if (!bill.late_fee) return problem(409, 'DDP-BILL-009', 'No late fee to waive on this bill.');

  await env.DB.prepare(
    `UPDATE bills SET total = ?, late_fee = 0, late_fee_waived_by = ? WHERE id = ?`
  ).bind(Math.round((bill.total - bill.late_fee) * 100) / 100, session.actor.id, billId).run();

  await audit(env, session, 'late-fee.waive', { billId, amount: bill.late_fee });
  return json({ billId, waived: bill.late_fee });
}

/** Residents may edit their own name and email. Mobile is admin-only: it is
 *  the login id and the tie to the flat (plan §4b). */
/**
 * First login. A resident arrives with a temporary password and a name typed
 * by whoever imported the roster — often a spreadsheet abbreviation. This is
 * the one moment they will reliably correct it, so it collects name, email and
 * a password together rather than password alone.
 *
 * The mobile is shown but NOT editable: it is the login id and the tie to the
 * flat. If it is wrong they cannot have logged in, so a mismatch means the
 * roster is wrong and an admin has to fix it.
 */
async function onboard(request, env, session) {
  if (session.impersonating) {
    return problem(403, 'DDP-AUTH-007', 'Cannot complete setup while viewing as another resident.');
  }

  const b = await readJson(request);
  const name = String(b?.name ?? '').trim();
  const email = String(b?.email ?? '').trim() || null;
  const password = String(b?.password ?? '');

  if (!name) return problem(400, 'DDP-NOTICE-003', 'Please give your name.');
  if (password.length < 8) {
    return problem(400, 'DDP-AUTH-002', 'Choose a password of at least 8 characters.');
  }
  if (email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    return problem(400, 'DDP-NOTICE-003', 'That email address looks wrong. Check it, or leave it blank.');
  }

  const { hash, salt } = await hashPassword(password, ITER(env));
  await env.DB.prepare(
    `UPDATE owners SET name = ?, email = ?, pw_hash = ?, pw_salt = ?, must_change_pw = 0
      WHERE id = ?`
  ).bind(name, email, hash, salt, session.actor.id).run();

  await destroyAllSessionsFor(env, session.actor.id);
  await audit(env, session, 'onboard.complete', { name, email: Boolean(email) });
  return json({ ok: true }, { headers: { 'set-cookie': clearCookieHeader() } });
}

async function patchProfile(request, env, session) {
  if (session.impersonating) {
    return problem(403, 'DDP-AUTH-007', 'Cannot edit details while viewing as another resident.');
  }
  const body = await readJson(request);
  const name = String(body?.name ?? '').trim();
  const email = String(body?.email ?? '').trim() || null;
  if (!name) return problem(400, 'DDP-NOTICE-003', 'Your name cannot be blank.');

  await env.DB.prepare('UPDATE owners SET name = ?, email = ? WHERE id = ?')
    .bind(name, email, session.actor.id).run();
  await audit(env, session, 'profile.update', { name, email });
  return json({ name, email });
}

async function postNotice(request, env, session) {
  const b = await readJson(request);
  const title = String(b?.title ?? '').trim();
  const body = String(b?.body ?? '').trim();
  if (!title || !body) return problem(400, 'DDP-NOTICE-003', 'A notice needs a title and a body.');

  const row = await env.DB.prepare(
    `INSERT INTO notices (title, body, kind, event_date, allow_comments, active, posted_at)
     VALUES (?, ?, ?, ?, ?, 1, ?) RETURNING id`
  ).bind(title, body, b?.kind === 'event' ? 'event' : 'notice',
         b?.eventDate ?? null, b?.allowComments ? 1 : 0, new Date().toISOString()).first();

  await audit(env, session, 'notice.create', { id: row.id, title });
  return json({ id: row.id }, { status: 201 });
}

async function patchNotice(request, env, session, path) {
  const id = Number(path.split('/')[4]);
  const b = await readJson(request);
  const fields = [];
  const values = [];
  for (const [key, column] of [['title', 'title'], ['body', 'body'], ['eventDate', 'event_date']]) {
    if (b?.[key] !== undefined) { fields.push(`${column} = ?`); values.push(b[key]); }
  }
  for (const [key, column] of [['allowComments', 'allow_comments'], ['active', 'active']]) {
    if (b?.[key] !== undefined) { fields.push(`${column} = ?`); values.push(b[key] ? 1 : 0); }
  }
  if (!fields.length) return problem(400, 'DDP-NOTICE-003', 'Nothing to change.');

  await env.DB.prepare(`UPDATE notices SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values, id).run();
  await audit(env, session, 'notice.update', { id, changed: Object.keys(b ?? {}) });
  return json({ id });
}

async function postResident(request, env, session) {
  const b = await readJson(request);
  const flat = String(b?.flat ?? '').trim().toUpperCase();
  const name = String(b?.name ?? '').trim();
  const mobile = String(b?.mobile ?? '').replace(/\D/g, '');
  if (!flat || !name || mobile.length < 10) {
    return problem(400, 'DDP-ADMIN-003', 'A resident needs a flat, a name and a 10-digit mobile number.');
  }

  const known = await env.DB.prepare('SELECT flat FROM flats WHERE flat = ?').bind(flat).first();
  if (!known) {
    await reportError(env, 'DDP-ADMIN-001', { flat });
    return problem(400, 'DDP-ADMIN-001', `Flat ${flat} is not on the register.`);
  }

  // Issued, not chosen: the resident replaces it on first login.
  const otp = generateOneTimePassword();
  const { hash, salt } = await hashPassword(otp, ITER(env));
  const row = await env.DB.prepare(
    `INSERT INTO owners (flat, name, mobile, email, pw_hash, pw_salt, must_change_pw, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'owner', ?) RETURNING id`
  ).bind(flat, name, mobile, b?.email ?? null, hash, salt, new Date().toISOString()).first();

  await audit(env, session, 'resident.create', { id: row.id, flat });
  const text = encodeURIComponent(
    `Diamond Park portal — your temporary password is ${otp}\nLog in at https://dddp.pages.dev and choose your own.`);
  return json({ id: row.id, oneTimePassword: otp, whatsapp: `https://wa.me/91${mobile}?text=${text}` },
    { status: 201 });
}

async function patchResident(request, env, session, path) {
  const id = Number(path.split('/')[4]);
  const b = await readJson(request);
  const fields = [];
  const values = [];
  if (b?.name !== undefined)   { fields.push('name = ?');   values.push(String(b.name).trim()); }
  if (b?.email !== undefined)  { fields.push('email = ?');  values.push(b.email || null); }
  if (b?.mobile !== undefined) { fields.push('mobile = ?'); values.push(String(b.mobile).replace(/\D/g, '')); }
  // Only a superadmin may change roles — an admin must not promote themselves.
  if (b?.role !== undefined && hasRole(session, 'superadmin')) {
    const target = await env.DB.prepare('SELECT id, role FROM owners WHERE id = ?').bind(id).first();
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM owners WHERE role = 'superadmin' AND active = 1"
    ).first();
    const verdict = canChangeRole({ target, newRole: b.role, superadminCount: count?.n ?? 0 });
    if (!verdict.ok) {
      await reportError(env, 'DDP-ADMIN-006', { id, newRole: b.role, count: count?.n });
      return problem(409, 'DDP-ADMIN-006', verdict.message);
    }
    fields.push('role = ?'); values.push(b.role);
  }
  if (!fields.length) return problem(400, 'DDP-ADMIN-003', 'Nothing to change.');

  await env.DB.prepare(`UPDATE owners SET ${fields.join(', ')} WHERE id = ?`).bind(...values, id).run();
  await audit(env, session, 'resident.update', { id, changed: Object.keys(b ?? {}) });
  return json({ id });
}

/** Per-flat charges, before the period locks. */
async function patchBill(request, env, session, path) {
  const id = Number(path.split('/')[4]);
  const b = await readJson(request);
  const bill = await env.DB.prepare(
    `SELECT b.*, p.status AS period_status FROM bills b
       JOIN periods p ON p.period = b.period WHERE b.id = ?`
  ).bind(id).first();
  if (!bill) return problem(404, 'DDP-PAY-001', 'That bill could not be found.');
  if (bill.period_status === 'locked') {
    return problem(409, 'DDP-BILL-007', 'This month is locked. Charges can no longer be changed.');
  }

  const other = Number(b?.otherCharges ?? bill.other_charges);
  const additional = Number(b?.additionalCharges ?? bill.additional_charges);
  const { gasAmount, total } = computeBill({
    consumption: bill.consumption,
    ratePerKg: bill.rate_per_kg,
    otherCharges: other,
    additionalCharges: additional,
    lateFee: bill.late_fee,
  });

  await env.DB.prepare(
    'UPDATE bills SET other_charges = ?, additional_charges = ?, gas_amount = ?, total = ? WHERE id = ?'
  ).bind(other, additional, gasAmount, total, id).run();

  await audit(env, session, 'bill.charges', { id, other, additional, total });
  return json({ id, total, gasAmount });
}

async function proofArchive(env, url) {
  const period = url.searchParams.get('period');
  const flat = url.searchParams.get('flat');
  const rows = await env.DB.prepare(
    `SELECT p.id, p.parsed_amount, p.utr, p.status, p.created_at, p.deleted_at,
            b.flat, b.period, b.total
       FROM payment_proofs p JOIN bills b ON b.id = p.bill_id
      WHERE (? IS NULL OR b.period = ?) AND (? IS NULL OR b.flat = ?)
      ORDER BY p.created_at DESC LIMIT 200`
  ).bind(period, period, flat, flat).all();

  const size = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM payment_proofs WHERE deleted_at IS NULL'
  ).first();

  return json({ proofs: rows.results ?? [], stored: size?.n ?? 0 });
}

/**
 * Delete the image, keep the row. `image_sha256` and `utr` must survive, or
 * the duplicate detection that stops an old screenshot being resubmitted next
 * year dies with them (plan §4d).
 */
async function deleteProof(env, session, path) {
  const id = Number(path.split('/')[4]);
  const proof = await env.DB.prepare('SELECT r2_key FROM payment_proofs WHERE id = ?').bind(id).first();
  if (!proof) return problem(404, 'DDP-PROOF-005', 'That submission could not be found.');

  if (proof.r2_key) await env.PROOFS.delete(proof.r2_key).catch(() => {});
  await env.DB.prepare(
    'UPDATE payment_proofs SET r2_key = NULL, deleted_at = ? WHERE id = ?'
  ).bind(new Date().toISOString(), id).run();

  await audit(env, session, 'proof.delete', { id });
  return json({ id, deleted: true, hashRetained: true });
}

/**
 * Page views and client-side errors — the part of a resident's session the
 * server never sees. Deliberately NOT every click: see docs/PRIVACY.md.
 */
async function recordActivity(request, env, session) {
  const b = await readJson(request);
  const kind = ['page', 'action', 'client-error'].includes(b?.kind) ? b.kind : 'action';
  const name = String(b?.name ?? '').slice(0, 120);
  if (!name) return json({ recorded: false });

  await env.DB.prepare(
    `INSERT INTO activity (owner_id, actor_id, kind, name, detail, user_agent, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    session.subject.id, session.actor.id, kind, name,
    b?.detail == null ? null : String(JSON.stringify(b.detail)).slice(0, 500),
    (request.headers.get('user-agent') ?? '').slice(0, 200),
    new Date().toISOString()
  ).run();

  return json({ recorded: true });
}

/** The whole story, newest first: actions, page views and errors in one list. */
async function timeline(env, url) {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 500);
  const flat = url.searchParams.get('flat');
  const since = url.searchParams.get('since') ?? '1970-01-01';

  const [audits, activities, errors] = await Promise.all([
    env.DB.prepare(
      `SELECT a.at, a.action, a.detail, a.actor_id, a.subject_id,
              ao.name AS actor_name, so.name AS subject_name, so.flat AS subject_flat
         FROM audit_log a
         LEFT JOIN owners ao ON ao.id = a.actor_id
         LEFT JOIN owners so ON so.id = a.subject_id
        WHERE a.at > ? AND (? IS NULL OR so.flat = ?)
        ORDER BY a.at DESC LIMIT ?`
    ).bind(since, flat, flat, limit).all(),

    env.DB.prepare(
      `SELECT v.at, v.kind, v.name, v.detail, v.user_agent, v.owner_id, v.actor_id,
              o.name AS owner_name, ao.name AS actor_name, o.flat AS owner_flat
         FROM activity v
         LEFT JOIN owners o ON o.id = v.owner_id
         LEFT JOIN owners ao ON ao.id = v.actor_id
        WHERE v.at > ? AND (? IS NULL OR o.flat = ?)
        ORDER BY v.at DESC LIMIT ?`
    ).bind(since, flat, flat, limit).all(),

    // Errors are system-wide, so a flat filter excludes them rather than
    // pretending they belong to somebody.
    flat
      ? { results: [] }
      : env.DB.prepare(
          'SELECT at, code, severity, message, detail FROM error_log WHERE at > ? ORDER BY at DESC LIMIT ?'
        ).bind(since, limit).all(),
  ]);

  return json({
    timeline: mergeTimeline({
      audits: audits.results ?? [],
      activities: activities.results ?? [],
      errors: errors.results ?? [],
    }).slice(0, limit),
    generatedAt: toIST(new Date().toISOString()),
  });
}

/** Hand a flat to a new owner. */
async function postTransfer(request, env, session) {
  const b = await readJson(request);
  const flat = String(b?.flat ?? '').trim().toUpperCase();

  const { outgoing, outstanding } = await transferFlat(env, {
    flat, outgoingId: Number(b?.outgoingId), name: b?.name, mobile: b?.mobile,
    email: b?.email, actorId: session.actor.id, settleOutstanding: Boolean(b?.settleOutstanding),
  });

  const now = new Date().toISOString();
  const otp = generateOneTimePassword();
  const { hash, salt } = await hashPassword(otp, ITER(env));
  const mobile = String(b.mobile).replace(/\D/g, '');

  const incoming = await env.DB.prepare(
    `INSERT INTO owners (flat, name, mobile, email, pw_hash, pw_salt, must_change_pw,
                         role, active, moved_in_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'owner', 1, ?, ?) RETURNING id`
  ).bind(flat, String(b.name).trim(), mobile, b?.email ?? null, hash, salt, now, now).first();

  await env.DB.batch([
    // Deactivated, never deleted: their bills, payments and comments must stay
    // attributable for the audit trail to mean anything.
    env.DB.prepare(
      "UPDATE owners SET active = 0, moved_out_at = ?, role = 'owner' WHERE id = ?"
    ).bind(now, outgoing.id),
    // Ends their access immediately — the flat is not theirs any more.
    env.DB.prepare('DELETE FROM sessions WHERE actor_id = ? OR subject_id = ?')
      .bind(outgoing.id, outgoing.id),
  ]);

  await audit(env, session, 'flat.transfer', {
    flat, from: outgoing.id, to: incoming.id, outstandingAtTransfer: outstanding.total,
  });

  const text = encodeURIComponent(
    `Diamond Park portal — welcome. Your temporary password is ${otp}\nLog in at https://dddp.pages.dev and choose your own.`);

  return json({
    flat, outgoing: outgoing.name, incomingId: incoming.id,
    oneTimePassword: otp, whatsapp: `https://wa.me/91${mobile}?text=${text}`,
    outstandingAtTransfer: outstanding,
  }, { status: 201 });
}

async function putCommittee(request, env, session) {
  const b = await readJson(request);
  const rows = Array.isArray(b?.committee) ? b.committee : [];
  if (!rows.length) return problem(400, 'DDP-ADMIN-003', 'Send at least one committee member.');

  // Replaced wholesale: after an AGM the whole slate changes, and reconciling
  // row by row invites a half-updated committee on the public page.
  const statements = [env.DB.prepare('DELETE FROM committee')];
  rows.forEach((m, i) => statements.push(
    env.DB.prepare('INSERT INTO committee (role, name, flat, phone, sort, active) VALUES (?, ?, ?, ?, ?, 1)')
      .bind(String(m.role ?? '').trim(), String(m.name ?? '').trim(),
            m.flat ?? null, m.phone ?? null, i)
  ));

  await env.DB.batch(statements);
  await audit(env, session, 'committee.update', { members: rows.length });
  return json({ committee: rows.length });
}

/** Any signed-in page asks this before wiring up a click listener. */
async function captureState(env) {
  const row = await env.DB.prepare('SELECT * FROM settings WHERE key = ?').bind('click_capture').first();
  const on = isCaptureOn(row);
  return json({ on, expiresAt: on ? row.expires_at : null });
}

async function recordClicks(request, env, session) {
  const row = await env.DB.prepare('SELECT * FROM settings WHERE key = ?').bind('click_capture').first();
  // Re-checked server-side: a stale page must not keep sending after the
  // window closes, and a crafted request must not be able to start it.
  if (!isCaptureOn(row)) return json({ recorded: 0, capture: 'off' });

  const body = await readJson(request);
  const events = validateBatch(body?.clicks ?? []);
  if (!events.length) return json({ recorded: 0 });

  const now = new Date().toISOString();
  await env.DB.batch(events.map((e) =>
    env.DB.prepare(
      'INSERT INTO click_log (owner_id, actor_id, page, target, label, at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(session.subject.id, session.actor.id, e.page, e.target, e.label, now)
  ));

  return json({ recorded: events.length });
}

async function setCapture(request, env, session) {
  const body = await readJson(request);
  const turnOn = Boolean(body?.on);
  // No hours -> on indefinitely. A window is opt-in, not the default.
  const { hours, expiresAt } = captureWindow(body?.hours);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO settings (key, value, expires_at, set_by, set_at)
     VALUES ('click_capture', ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at,
                                     set_by = excluded.set_by, set_at = excluded.set_at`
  ).bind(turnOn ? 'on' : 'off', turnOn ? expiresAt : null, session.actor.id, now).run();

  await audit(env, session, turnOn ? 'capture.on' : 'capture.off', { hours: turnOn ? hours : null });
  return json({ on: turnOn, expiresAt: turnOn ? expiresAt : null, hours: turnOn ? hours : null });
}

async function clickLog(env, url) {
  const flat = url.searchParams.get('flat');
  const rows = await env.DB.prepare(
    `SELECT c.at, c.page, c.target, c.label, o.flat, o.name
       FROM click_log c LEFT JOIN owners o ON o.id = c.owner_id
      WHERE (? IS NULL OR o.flat = ?)
      ORDER BY c.at DESC LIMIT 500`
  ).bind(flat, flat).all();

  return json({
    clicks: (rows.results ?? []).map((r) => ({ ...r, atIST: toIST(r.at) })),
  });
}

/**
 * Download the activity trail. Separate from the admin CSV export because this
 * is behavioural data — superadmin only, and reading it is itself audited.
 */
async function exportLogs(env, session, url) {
  const what = url.searchParams.get('what') ?? 'timeline';
  const stamp = new Date().toISOString().slice(0, 10);

  let rows;
  let name;
  if (what === 'clicks') {
    const r = await env.DB.prepare(
      `SELECT c.at, o.flat, o.name, c.page, c.target, c.label
         FROM click_log c LEFT JOIN owners o ON o.id = c.owner_id
        ORDER BY c.at DESC LIMIT 20000`
    ).all();
    rows = (r.results ?? []).map((x) => ({ ...x, at_ist: toIST(x.at) }));
    name = `diamond-park-clicks-${stamp}.csv`;
  } else {
    const [audits, activities, errors] = await Promise.all([
      env.DB.prepare(
        `SELECT a.at, a.action, a.detail, ao.name AS actor_name, so.name AS subject_name, so.flat
           FROM audit_log a
           LEFT JOIN owners ao ON ao.id = a.actor_id
           LEFT JOIN owners so ON so.id = a.subject_id
          ORDER BY a.at DESC LIMIT 20000`).all(),
      env.DB.prepare(
        `SELECT v.at, v.kind, v.name, v.detail, o.name AS owner_name, o.flat
           FROM activity v LEFT JOIN owners o ON o.id = v.owner_id
          ORDER BY v.at DESC LIMIT 20000`).all(),
      env.DB.prepare(
        'SELECT at, code, severity, message, detail FROM error_log ORDER BY at DESC LIMIT 20000').all(),
    ]);
    rows = mergeTimeline({
      audits: audits.results ?? [],
      activities: activities.results ?? [],
      errors: errors.results ?? [],
    }).map((r) => ({
      at_ist: r.atIST, kind: r.kind, event: r.name,
      actor: r.actor ?? '', subject: r.subject ?? '', flat: r.flat ?? '',
      severity: r.severity ?? '', detail: r.detail ?? '',
    }));
    name = `diamond-park-activity-${stamp}.csv`;
  }

  await audit(env, session, 'god.export', { what, rows: rows.length });
  return new Response(toCsv(rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    },
  });
}

/** Move superadmin from one person to another, atomically. */
async function handover(request, env, session) {
  const body = await readJson(request);
  const to = await env.DB.prepare('SELECT id, name, flat, role, active FROM owners WHERE id = ?')
    .bind(Number(body?.toOwnerId)).first();
  const from = await env.DB.prepare('SELECT id, name, role FROM owners WHERE id = ?')
    .bind(session.actor.id).first();

  const plan = planHandover({ from, to });
  if (!plan.ok) return problem(409, 'DDP-ADMIN-006', plan.message);

  // One batch: a half-finished handover is how a building ends up locked out.
  await env.DB.batch(plan.steps.map((step) =>
    env.DB.prepare('UPDATE owners SET role = ? WHERE id = ?').bind(step.role, step.id)
  ));

  await audit(env, session, 'superadmin.handover', { from: from.id, to: to.id, toName: to.name });
  return json({ from: from.name, to: to.name, note: 'You are now an admin.' });
}

/**
 * Download the data. Deliberately available to admins, not just the
 * superadmin: the committee owning a readable copy of its own records is the
 * whole point, and is what the old site failed to provide.
 */
async function exportData(env, session, url) {
  const table = url.searchParams.get('table');
  const stamp = new Date().toISOString().slice(0, 10);

  if (table) {
    if (!TABLES.includes(table)) return problem(400, 'DDP-SYS-003', 'No such table.');
    await audit(env, session, 'export.table', { table });
    return new Response(await dumpTable(env, table), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="diamond-park-${table}-${stamp}.csv"`,
        'cache-control': 'no-store',
      },
    });
  }

  const files = await dumpAll(env);
  await audit(env, session, 'export.all', { tables: Object.keys(files).length });
  return new Response(bundle(files, { generatedAt: new Date().toISOString() }), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="diamond-park-${stamp}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

// ── payment proofs ──────────────────────────────────────────────────────

/**
 * A resident uploads a screenshot.
 *
 * Order matters: the D1 row is written FIRST, then the object is put to R2.
 * The reverse order is DDP-PROOF-004 — an object in the bucket with no row
 * pointing at it, invisible to everyone and never cleaned up. A row whose
 * object is missing is at least visible and recoverable.
 */
async function uploadProof(request, env, session, ctx, path) {
  const billId = Number(path.split('/')[3]);

  if (session.impersonating && !session.canWrite) {
    return problem(403, 'DDP-AUTH-007', 'Cannot upload while viewing as another resident.');
  }

  // Resolved through the session's flat — not from the URL.
  const bill = await env.DB.prepare(
    `SELECT id, flat, period, total, status FROM bills
      WHERE id = ? AND flat = ? AND (owner_id IS NULL OR owner_id = ?)`
  ).bind(billId, session.subject.flat, session.subject.id).first();
  if (!bill) return problem(404, 'DDP-PAY-001', 'That bill could not be found.');
  if (bill.status === 'paid' || bill.status === 'waived') {
    return problem(409, 'DDP-PAY-003', 'This bill is already settled.');
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get('image');
  if (!file || typeof file === 'string') {
    return problem(400, 'DDP-PROOF-003', 'Attach a screenshot of your payment.');
  }

  const check = validateUpload({ type: file.type, size: file.size });
  if (!check.ok) return problem(400, 'DDP-PROOF-003', check.message);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await sha256Hex(bytes);

  // Same image twice — usually an honest double-tap, sometimes last month's
  // screenshot sent again. Either way it is not new evidence.
  const dupe = await env.DB.prepare(
    'SELECT id, bill_id FROM payment_proofs WHERE image_sha256 = ?'
  ).bind(hash).first();
  if (dupe) {
    await reportError(env, 'DDP-PROOF-001', { hash, billId, existing: dupe.id });
    return problem(409, 'DDP-PROOF-001',
      dupe.bill_id === bill.id
        ? 'You have already uploaded this screenshot.'
        : 'This screenshot has already been used for another bill.');
  }

  const vision = await readReceipt(env, bytes, file.type);
  const parsed = vision.parsed;

  if (parsed.utr) {
    const utrTaken = await env.DB.prepare(
      'SELECT bill_id FROM payment_proofs WHERE utr = ?'
    ).bind(parsed.utr).first();
    if (utrTaken) {
      await reportError(env, 'DDP-PROOF-002', { utr: parsed.utr, billId });
      return problem(409, 'DDP-PROOF-002',
        'That payment reference has already been used for another bill.');
    }
  }

  const assessment = assessProof(parsed, bill);
  if (!assessment.matches && assessment.verdict !== 'unreadable') {
    await reportError(env, 'DDP-PROOF-006', { billId, claimed: parsed.amount, billed: bill.total });
  }

  const key = r2Key(bill.flat, bill.period, hash);
  const now = new Date().toISOString();

  const inserted = await env.DB.prepare(
    `INSERT INTO payment_proofs (bill_id, owner_id, r2_key, image_sha256, utr, parsed_amount, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING id`
  ).bind(bill.id, session.subject.id, key, hash, parsed.utr, parsed.amount, now).first();

  try {
    await env.PROOFS.put(key, bytes, { httpMetadata: { contentType: file.type } });
  } catch (err) {
    // Row exists, object doesn't: visible and recoverable, unlike the reverse.
    await reportError(env, 'DDP-PROOF-004', err, ctx);
    return problem(500, 'DDP-PROOF-004', 'We saved your submission but the image failed to store. The treasurer has been alerted.');
  }

  await env.DB.prepare(
    "UPDATE bills SET status = 'awaiting' WHERE id = ? AND status IN ('unpaid','initiated')"
  ).bind(bill.id).run();

  await audit(env, session, 'proof.upload', { billId: bill.id, proofId: inserted.id, verdict: assessment.verdict });

  return json({
    proofId: inserted.id,
    parsed,
    provider: vision.provider,
    assessment,
    status: 'awaiting',
  }, { status: 201 });
}

/**
 * Private image proxy. These are residents' financial documents — the bucket
 * has no public URLs, and every admin view is audited.
 */
async function proofImage(env, session, path) {
  const proofId = Number(path.split('/')[3]);
  const row = await env.DB.prepare(
    `SELECT p.r2_key, p.deleted_at, p.owner_id, b.flat, b.owner_id AS bill_owner_id
       FROM payment_proofs p JOIN bills b ON b.id = p.bill_id
      WHERE p.id = ?`
  ).bind(proofId).first();

  if (!row) return problem(404, 'DDP-PROOF-005', 'That image could not be found.');

  // Ownership is by PERSON. Matching on flat alone would hand the previous
  // owner's payment screenshots to whoever buys the flat next.
  const uploader = row.owner_id ?? row.bill_owner_id;
  const isOwner = uploader != null && uploader === session.subject.id;
  if (!isOwner && !hasRole(session, 'admin')) {
    await reportError(env, 'DDP-ADMIN-004', { proofId, actor: session.actor.id });
    return problem(403, 'DDP-ADMIN-004', 'Not yours to view.');
  }
  if (row.deleted_at || !row.r2_key) {
    return problem(410, 'DDP-PROOF-005', 'That image has been deleted.');
  }

  const object = await env.PROOFS.get(row.r2_key);
  if (!object) {
    await reportError(env, 'DDP-PROOF-005', { proofId, key: row.r2_key });
    return problem(404, 'DDP-PROOF-005', 'That image is missing from storage.');
  }

  if (!isOwner) await audit(env, session, 'proof.view', { proofId, flat: row.flat });

  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? 'image/jpeg',
      'cache-control': 'private, no-store',
    },
  });
}

async function proofQueue(env) {
  const [proofs, claimed] = await Promise.all([
    env.DB.prepare(
      `SELECT p.*, b.flat, b.period, b.total, o.name
         FROM payment_proofs p
         JOIN bills b ON b.id = p.bill_id
         LEFT JOIN owners o ON o.flat = b.flat
        WHERE p.status = 'pending' AND p.deleted_at IS NULL
        ORDER BY p.created_at`
    ).all(),
    env.DB.prepare(
      `SELECT b.id, b.flat, b.period, b.total, o.name, MAX(i.created_at) AS last_intent
         FROM bills b
         JOIN payment_intents i ON i.bill_id = b.id
         LEFT JOIN owners o ON o.flat = b.flat
        WHERE b.status = 'initiated'
        GROUP BY b.id ORDER BY last_intent`
    ).all(),
  ]);

  return json(shapeQueue({ proofs: proofs.results ?? [], claimed: claimed.results ?? [] }));
}

async function reviewProof(env, session, path, approve) {
  const proofId = Number(path.split('/')[4]);
  const proof = await env.DB.prepare(
    'SELECT id, bill_id, status FROM payment_proofs WHERE id = ?'
  ).bind(proofId).first();
  if (!proof) return problem(404, 'DDP-PROOF-005', 'That submission could not be found.');
  if (proof.status !== 'pending') {
    return problem(409, 'DDP-PROOF-005', 'That submission has already been reviewed.');
  }

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE payment_proofs SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?'
    ).bind(approve ? 'approved' : 'rejected', session.actor.id, now, proofId),
    approve
      ? env.DB.prepare("UPDATE bills SET status = 'paid', paid_at = ? WHERE id = ?").bind(now, proof.bill_id)
      // Rejection returns the bill to 'initiated', not 'unpaid': the resident
      // did claim to have paid, and the late-fee cron must keep holding.
      : env.DB.prepare("UPDATE bills SET status = 'initiated' WHERE id = ?").bind(proof.bill_id),
  ]);

  await audit(env, session, approve ? 'proof.approve' : 'proof.reject', { proofId, billId: proof.bill_id });
  return json({ proofId, status: approve ? 'approved' : 'rejected' });
}

/** Mark paid with no proof at all — the bank statement is the real evidence. */
async function markPaid(request, env, session, path) {
  const billId = Number(path.split('/')[4]);
  const body = await readJson(request);
  const bill = await env.DB.prepare('SELECT id, status FROM bills WHERE id = ?').bind(billId).first();
  if (!bill) return problem(404, 'DDP-PAY-001', 'That bill could not be found.');

  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE bills SET status = 'paid', paid_at = ? WHERE id = ?")
    .bind(now, billId).run();
  await audit(env, session, 'bill.mark-paid', { billId, note: body?.note ?? null });
  return json({ billId, status: 'paid' });
}

// ── admin billing ───────────────────────────────────────────────────────

/**
 * The period parameter is the USAGE month. The treasurer walks the building in
 * July and enters June's readings (plan §3a), so the grid reports readMonth
 * alongside it and the UI says so explicitly.
 */
function periodFrom(url) {
  const p = url.searchParams.get('period');
  return /^\d{4}-\d{2}$/.test(p ?? '') ? p : null;
}

async function getReadings(env, url) {
  const period = periodFrom(url);
  if (!period) return problem(400, 'DDP-BILL-005', 'Specify a period, e.g. ?period=2026-06.');

  const grid = await readingGrid(env, period);
  const history = await env.DB.prepare(
    `SELECT flat, consumption FROM bills WHERE period < ? ORDER BY period DESC LIMIT 400`
  ).bind(period).all();

  const byFlat = new Map();
  for (const row of history.results ?? []) {
    if (!byFlat.has(row.flat)) byFlat.set(row.flat, []);
    byFlat.get(row.flat).push(row.consumption);
  }

  // Send each flat's historical average unconditionally, NOT a verdict about
  // the stored reading. The grid must be able to warn about a value as it is
  // typed; deriving the warning server-side from an already-saved reading means
  // it can only ever fire after the fact, which is the wrong way round.
  grid.flats = grid.flats.map((f) => {
    const past = (byFlat.get(f.flat) ?? []).filter((n) => Number.isFinite(n) && n > 0);
    const average = past.length >= 2
      ? Math.round((past.reduce((a, b) => a + b, 0) / past.length) * 100) / 100
      : null;
    return {
      ...f,
      average,
      jump: f.consumption == null ? null : jumpWarning(f.consumption, past),
    };
  });

  return json(grid);
}

async function putReadings(request, env, session, url) {
  const period = periodFrom(url);
  if (!period) return problem(400, 'DDP-BILL-005', 'Specify a period.');
  const body = await readJson(request);
  const entries = Array.isArray(body?.readings) ? body.readings : [];

  const result = await saveReadings(env, period, entries, session.actor.id);
  await audit(env, session, 'readings.save', { period, ...result });
  return json(result);
}

/** Parse only — the draft goes back for review, nothing is written. */
async function parseImport(request, env, url) {
  const body = await readJson(request);
  const flats = await env.DB.prepare('SELECT flat FROM flats WHERE active = 1').all();
  const known = (flats.results ?? []).map((r) => r.flat);
  const parsed = parseReadings(body?.text ?? '', known);

  for (const e of parsed.errors) {
    if (e.reason === 'unknown-flat') await reportError(env, 'DDP-ADMIN-001', e);
    else await reportError(env, 'DDP-ADMIN-003', e);
  }
  return json({ ...parsed, known: known.length });
}

async function getPreview(env, url) {
  const period = periodFrom(url);
  if (!period) return problem(400, 'DDP-BILL-005', 'Specify a period.');

  const grid = await readingGrid(env, period);
  if (grid.rate == null) {
    return problem(409, 'DDP-BILL-005', 'Set this month\'s rate before generating.');
  }

  const prev = await env.DB.prepare('SELECT rate_per_kg FROM periods WHERE period = ?')
    .bind(previousPeriod(period)).first();

  const rows = grid.flats
    .filter((f) => f.reading != null && f.previous != null)
    .map((f) => ({ flat: f.flat, reading: f.reading, previous: f.previous }));

  return json({
    ...previewGeneration({
      rows,
      ratePerKg: grid.rate,
      conversionFactor: grid.conversionFactor,
      previousRate: prev?.rate_per_kg ?? null,
      expectedFlats: grid.total,
    }),
    period,
    readMonth: grid.readMonth,
    entered: grid.entered,
    expected: grid.total,
  });
}

async function postPeriod(request, env, session) {
  const body = await readJson(request);
  const result = await openPeriod(env, {
    period: body?.period,
    ratePerKg: Number(body?.ratePerKg),
    dueDate: body?.dueDate,
    lateFee: Number(body?.lateFee ?? 0),
  });
  if (result.sanity.level === 'warn') {
    await reportError(env, 'DDP-BILL-011', { period: result.period, ...result.sanity });
  }
  await audit(env, session, 'period.open', result);
  return json(result, { status: 201 });
}

async function postGenerate(env, session, path) {
  const period = path.split('/')[4];
  const result = await generateBills(env, period, session.actor.id);
  await audit(env, session, 'bills.generate', result);
  return json(result, { status: 201 });
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

/* ── god edits ────────────────────────────────────────────────────────────
   The superadmin can change anything. The only thing that is not optional is
   the record of having changed it — that is what lets a decision be defended
   to a resident six months later, and what keeps an altered bill from being
   indistinguishable from a wrong one.                                       */

/** Everyone, including admins and the superadmin — /api/god/residents omits those. */
async function godPeople(env) {
  const r = await env.DB.prepare(
    `SELECT id, flat, name, mobile, email, role, active, moved_in_at, moved_out_at
       FROM owners ORDER BY active DESC, flat, name`
  ).all();
  return json({ people: r.results ?? [] });
}

/** Every bill, newest first, with what the arithmetic would say for each. */
async function godBills(env, url) {
  const flat = url.searchParams.get('flat');
  const r = await env.DB.prepare(
    `SELECT b.id, b.flat, b.period, b.consumption, b.rate_per_kg, b.gas_amount,
            b.other_charges, b.additional_charges, b.late_fee, b.total, b.status,
            b.manual_total, b.adjusted_at, b.adjust_reason, o.name AS owner_name
       FROM bills b LEFT JOIN owners o ON o.id = b.owner_id
      ${flat ? 'WHERE b.flat = ?' : ''}
      ORDER BY b.period DESC, b.flat`
  ).bind(...(flat ? [flat] : [])).all();

  const bills = (r.results ?? []).map((b) => ({
    ...b,
    computed: computedTotal(b),
    // Surfaced rather than merely flagged: an override that does not say what
    // the arithmetic wanted is just an unexplained number.
    mismatch: isUnexplainedMismatch(b),
  }));
  return json({ bills });
}

/** The log of god edits alone, separated from ordinary audit traffic. */
async function godEdits(env, url) {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500);
  const r = await env.DB.prepare(
    `SELECT a.id, a.action, a.detail, a.at, o.name AS actor_name
       FROM audit_log a LEFT JOIN owners o ON o.id = a.actor_id
      WHERE a.action LIKE 'god.edit.%' ORDER BY a.at DESC LIMIT ?`
  ).bind(limit).all();

  return json({
    edits: (r.results ?? []).map((row) => {
      let detail = null;
      try { detail = row.detail ? JSON.parse(row.detail) : null; } catch { detail = null; }
      // toIST is the same helper the activity log uses, rather than a second
      // client-side formatter that would drift from it.
      return { id: row.id, at: row.at, atIST: toIST(row.at), actor: row.actor_name, ...detail };
    }),
  });
}

async function editOwner(request, env, session, path) {
  // Editing while viewing as someone else would make the audit trail ambiguous
  // about who decided what, which is the one thing it exists to be clear about.
  if (session.impersonating) {
    await reportError(env, 'DDP-AUTH-007', { actor: session.actor.id });
    return problem(403, 'DDP-AUTH-007', 'Leave view-as before editing anyone.');
  }

  const id = Number(path.split('/').pop());
  const target = await env.DB.prepare(
    'SELECT id, flat, name, mobile, email, role, active FROM owners WHERE id = ?'
  ).bind(id).first();
  if (!target) return problem(404, 'DDP-ADMIN-010', 'No such person.');

  const body = await readJson(request);
  const field = String(body?.field ?? '');
  if (!OWNER_FIELDS.includes(field)) {
    return problem(400, 'DDP-ADMIN-010', `Cannot edit "${field}".`);
  }

  const value = validateOwnerField(field, body?.value);
  const reason = checkReason(field, body?.reason);

  const { n: superadminCount } = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM owners WHERE role = 'superadmin' AND active = 1"
  ).first();

  const verdict = lockoutCheck({
    actor: session.actor, target, field, value, superadminCount,
  });
  if (!verdict.ok) {
    await reportError(env, 'DDP-ADMIN-012', { field, target: id, actor: session.actor.id });
    return problem(409, 'DDP-ADMIN-012', verdict.message);
  }

  // mobile is the login id and email will be the OTP address, so a duplicate
  // would quietly hand one person's account to another.
  if ((field === 'mobile' || field === 'email') && value != null) {
    // Compared in normalised form. A raw string comparison here let two
    // accounts share one number, because '9567791515' and '+919567791515' are
    // different strings and the UNIQUE index could not see through that
    // either. 0009 converted the stored rows; this keeps them that way.
    const clash = field === 'mobile'
      ? await env.DB.prepare(
          `SELECT id, name, flat FROM owners
            WHERE id <> ? AND (mobile = ? OR mobile = ? OR '+91' || mobile = ?)`
        ).bind(id, value, value.replace(/^\+91/, ''), value).first()
      : await env.DB.prepare(
          'SELECT id, name, flat FROM owners WHERE email = ? AND id <> ?'
        ).bind(value, id).first();
    if (clash) {
      return problem(409, 'DDP-ADMIN-013',
        `That ${field} already belongs to ${clash.name} (${clash.flat}).`);
    }
  }

  const change = diff({ entity: 'owner', id, field, before: target[field], after: value, reason });
  if (!change) return json({ ok: true, unchanged: true });

  await env.DB.prepare(`UPDATE owners SET ${field} = ? WHERE id = ?`).bind(value, id).run();
  await audit(env, session, `god.edit.owner.${field}`,
              { ...change, targetName: target.name, targetFlat: target.flat });

  return json({ ok: true, field, value, confirm: verdict.confirm ?? null });
}

async function editBill(request, env, session, path) {
  if (session.impersonating) {
    await reportError(env, 'DDP-AUTH-007', { actor: session.actor.id });
    return problem(403, 'DDP-AUTH-007', 'Leave view-as before editing a bill.');
  }

  const id = Number(path.split('/').pop());
  const bill = await env.DB.prepare('SELECT * FROM bills WHERE id = ?').bind(id).first();
  if (!bill) return problem(404, 'DDP-ADMIN-010', 'No such bill.');

  const body = await readJson(request);
  const field = String(body?.field ?? '');
  if (!BILL_FIELDS.includes(field)) {
    return problem(400, 'DDP-ADMIN-010', `Cannot edit "${field}".`);
  }

  const value = validateBillField(field, body?.value);
  const reason = checkReason(field, body?.reason);   // always required for money

  const change = diff({ entity: 'bill', id, field, before: bill[field], after: value, reason });
  if (!change) return json({ ok: true, unchanged: true });

  const { bill: next, derived, computed } = applyBillEdit(bill, field, value);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `UPDATE bills SET gas_amount = ?, other_charges = ?, additional_charges = ?,
            late_fee = ?, total = ?, status = ?, manual_total = ?,
            adjusted_by = ?, adjusted_at = ?, adjust_reason = ?
      WHERE id = ?`
  ).bind(
    next.gas_amount, next.other_charges, next.additional_charges, next.late_fee,
    next.total, next.status, next.manual_total,
    session.actor.id, now, reason, id
  ).run();

  await audit(env, session, `god.edit.bill.${field}`, {
    ...change, flat: bill.flat, period: bill.period,
    totalBefore: bill.total, totalAfter: next.total, derived, computed,
  });

  return json({
    ok: true, field, value,
    total: next.total,
    manualTotal: Boolean(next.manual_total),
    computed,
    // So the UI can say "the arithmetic gives 329, you set 200" rather than
    // letting an override look like an ordinary bill.
    note: derived ? 'Total recalculated from the components.'
        : field === 'total' && next.total !== computed
          ? `Manual override. The components add up to ₹${computed}.`
          : null,
  });
}
