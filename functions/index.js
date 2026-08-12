/**
 * DD Diamond Park portal — Worker entry.
 * Phase 1 + 1b: auth, sessions, roles, audit, god mode, error reporting.
 * Billing, payments and proofs land in phases 3–6.
 */

import { json, problem, readJson, audit, rateLimit, clearRateLimit, guard, withSecurityHeaders } from './lib/http.js';
import { reportError, assertAlerting, postToTelegram } from './lib/errors.js';
import { hashPassword, verifyPassword, generateOneTimePassword, sha256Hex, derive } from './lib/crypto.js';
import { dashboardPayload } from './lib/dashboard.js';
import {
  readingGrid, saveReadings, generateBills, openPeriod, parseReadings,
  previousPeriod, jumpWarning, changeRate,
} from './lib/admin.js';
import { previewGeneration, computeBill, isExempt } from './lib/billing.js';
import { validateUpload, assessProof, shapeQueue, r2Key } from './lib/proof.js';
import { validateStatement, parseStatement, reconcile, sweepAbandonedStatements } from './lib/statement.js';
import { readReceipt } from './lib/vision.js';
import { runScheduled, applyLateFees, staleIntents } from './lib/cron.js';
import { listNotices, getNotice, addComment, setCommentHidden, markNoticesSeen, NOTICE_SCOPES,
         canSeeAttachment, listArchivedNotices, purgeNotice } from './lib/notices.js';
// r2Key is aliased: lib/proof.js exports one of its own, and the two build
// different key shapes for different buckets' worth of rules.
import { validateAttachment, validateThumb, safeFilename, r2Key as attachmentKey, assertRoom,
         isLargeUpload, MAX_PER_NOTICE, MAX_PER_COMMENT } from './lib/attachments.js';
import { submitMessage, fingerprintOf, AMENITIES, OFFICE_HOURS, MESSAGE_SUBJECTS, CONTACT } from './lib/public.js';
import {
  transferFlat, canChangeRole, canResetPassword, canEditResident, canEditField, waLink,
  planHandover, outstandingFor,
  mergeTimeline, toIST, isRelationship, occupantOf, landlordOf, isTenanted,
  billAccess, describeRelationship, ADMINISTRATOR,
} from './lib/tenancy.js';
import {
  validateRequest, requestState, decisionFailure, isStillAChange, requestNotification,
} from './lib/contact-requests.js';
import {
  OWNER_FIELDS, BILL_FIELDS, validateOwnerField, validateBillField,
  lockoutCheck, applyBillEdit, computedTotal, isUnexplainedMismatch,
  diff, checkReason, normaliseMobile, normaliseEmail,
} from './lib/godedit.js';
import { runChecks, summarise, toMarkdown } from './lib/diagnostics.js';
import {
  generateCode, normaliseCode, expiryFrom, canIssue, resetState, failureMessage,
  validateNewPassword, resetEmail, neutralReply,
  tempPasswordState, expiredPasswordMessage, tempPasswordExpiry, tempPasswordEmail,
  TEMP_PW_HOURS, INVITE_PW_HOURS,
} from './lib/reset.js';
import { sendEmail, mailConfigured } from './lib/mailer.js';
import { parseRoster, previewRoster, resolveExemptionTargets } from './lib/roster.js';
import { floorSummary, whyNot } from './lib/building.js';
import { splitMobile, NATIONAL_LENGTHS } from '../public/js/countries.js';
import { addFlat } from './lib/flats.js';
import { ERROR_CODES } from './lib/error-codes.js';
import { isCaptureOn, captureWindow, validateBatch } from './lib/clicks.js';
import { runBackup, backupHealth, driveConfigured, committeeFolderSeparate, isBackupCron, pruneOldRows, dumpTable, dumpAll, bundle, toCsv, TABLES } from './lib/backup.js';
import {
  createSession, resolveSession, destroySession, destroyAllSessionsFor,
  cookieHeader, clearCookieHeader, hasRole,
  RESIDENT_TTL_DAYS, SHARED_DEVICE_TTL_DAYS, IMPERSONATE_TTL_MIN,
} from './lib/session.js';

const ITER = (env) => Number(env.PBKDF2_ITERATIONS ?? 100_000);

/**
 * Salt for the throwaway derive an unknown mobile pays for, so that failing to
 * exist costs the same as failing to guess. Fixed and public on purpose: it
 * never protects anything, it only burns the same CPU a real verify would.
 *
 * Honest limit — it is exact only once every row sits at the current target.
 * Mid-migration a stored hash may still be at 100000 while this derives at the
 * new number, so the gap inverts rather than closes until logins have carried
 * everyone across. Bounded and much smaller than the 27 ms it replaces, but it
 * is not zero, and pretending otherwise is how a mitigation stops being checked.
 */
const DUMMY_SALT = new Uint8Array([
  0x9c, 0x1e, 0x4b, 0x77, 0x2a, 0xd5, 0x68, 0x03,
  0xbf, 0x41, 0x96, 0xe7, 0x5a, 0x2c, 0xd0, 0x8e,
]);

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
      if (route === 'POST /api/forgot') return forgotPassword(request, env, ctx);
      if (route === 'POST /api/reset') return resetWithCode(request, env, ctx);
      if (route === 'GET /api/health') return json({ ok: true });

      // ── public: no session required ───────────────────────────────────
      if (route === 'GET /api/public/notices') {
        const committee = await env.DB.prepare(
          'SELECT role, name, flat, phone FROM committee WHERE active = 1 ORDER BY sort'
        ).all();
        // No notices. A notice is the association talking to the people who
        // live here, and some of what a committee posts — a meeting about a
        // defaulter, a security incident, a plumber's number — is nobody
        // else's business. Residents read them at /notices, behind a login.
        return json({
          committee: committee.results ?? [],
          amenities: AMENITIES,
          officeHours: OFFICE_HOURS,
          contact: CONTACT,
          subjects: MESSAGE_SUBJECTS,
          // Public by design — a Maps key lives in the page source and is
          // protected by an HTTP-referrer restriction, not by being hidden.
          // Absent is the supported state: the map falls back to the keyless
          // embed, so the site behaves identically whether or not this is set.
          mapsKey: env.GOOGLE_MAPS_KEY || null,
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
      if (route === 'GET /api/notices') {
        const notices = await listNotices(env, session.subject);
        // Stamped only for a resident reading their own board. An admin using
        // view-as would otherwise clear a badge for somebody who has not seen
        // anything — impersonation must not leave marks on the person being
        // impersonated. Also stamped after the list is built, so a read that
        // failed is not recorded as a read that happened.
        if (!session.impersonating) await markNoticesSeen(env, session.subject.id);
        return json({ notices });
      }
      if (request.method === 'GET' && /^\/api\/notices\/\d+$/.test(path)) {
        const notice = await getNotice(env, Number(path.split('/')[3]),
          { isAdmin: hasRole(session, 'admin'), viewer: session.subject });
        return notice ? json(notice) : problem(404, 'DDP-NOTICE-001', 'That notice could not be found.');
      }
      if (request.method === 'POST' && /^\/api\/notices\/\d+\/comments$/.test(path)) {
        return postComment(request, env, session, path);
      }

      // ── attachments ───────────────────────────────────────────────────
      // Residents attach to their OWN comment; the admin-only path for
      // notices lives under /api/admin below.
      if (request.method === 'POST' && /^\/api\/comments\/\d+\/attachments$/.test(path)) {
        return postCommentAttachment(request, env, session, path, ctx);
      }
      if (request.method === 'GET' && /^\/api\/attachments\/\d+(\/thumb)?$/.test(path)) {
        return serveAttachment(env, session, Number(path.split('/')[3]),
          { thumb: path.endsWith('/thumb') });
      }

      // ── admin ─────────────────────────────────────────────────────────
      if (path.startsWith('/api/admin/')) {
        if (!hasRole(session, 'admin')) {
          await reportError(env, 'DDP-ADMIN-004', { path, actor: session.actor.id });
          return problem(403, 'DDP-ADMIN-004', 'Admins only.');
        }
        if (route === 'GET /api/admin/residents') return listResidents(env, session, url);
        if (route.startsWith('POST /api/admin/residents/') && path.endsWith('/reset/email')) {
          return emailTempPassword(request, env, session, path);
        }
        // Raising a request is an admin's job; deciding one is not. The decide
        // routes are gated here rather than inside the handler because a missing
        // check on those two would hand back exactly the write B22 removed.
        if (route.startsWith('POST /api/admin/residents/')
            && path.endsWith('/contact-request')) {
          return requestContactChange(request, env, session, path);
        }
        if (route === 'GET /api/admin/contact-requests') return listContactRequests(env, url);
        if (request.method === 'POST'
            && /^\/api\/admin\/contact-requests\/\d+\/(approve|reject)$/.test(path)) {
          if (!hasRole(session, 'superadmin')) {
            await reportError(env, 'DDP-ADMIN-004',
                              { path, actor: session.actor.id });
            return problem(403, 'DDP-ADMIN-004',
              `Only ${ADMINISTRATOR.name} can approve a contact change.`);
          }
          return decideContactRequest(request, env, session, path, path.endsWith('/approve'));
        }
        if (route.startsWith('POST /api/admin/residents/') && path.endsWith('/reset')) {
          return resetPassword(request, env, session, path);
        }
        if (route === 'POST /api/admin/roster/preview') return rosterPreview(request, env);
        if (route === 'POST /api/admin/roster/import')  return rosterImport(request, env, session);
        if (route === 'GET /api/admin/roster/status')   return rosterStatus(env);
        if (route.startsWith('POST /api/admin/roster/sent/')) {
          return rosterMarkSent(request, env, session, path);
        }
        if (request.method === 'PATCH' && /^\/api\/admin\/flats\/[^/]+$/.test(path)) {
          return patchFlat(request, env, session, path);
        }
        if (route === 'GET /api/admin/readings')  return getReadings(env, url);
        if (route === 'PUT /api/admin/readings')  return putReadings(request, env, session, url);
        if (route === 'POST /api/admin/readings/parse') return parseImport(request, env, url);
        if (route === 'GET /api/admin/preview')   return getPreview(env, url);
        if (route === 'POST /api/admin/periods')  return postPeriod(request, env, session);
        if (request.method === 'PATCH' && /^\/api\/admin\/periods\/[\d-]+$/.test(path)) {
          return patchPeriodRate(request, env, session, path);
        }
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
        if (route === 'GET /api/admin/late-fees') return lateFeePanel(env);
        if (route === 'POST /api/admin/late-fee-exemption/bulk') {
          return bulkLateFeeExemption(request, env, session);
        }
        if (request.method === 'POST' && /^\/api\/admin\/residents\/\d+\/late-fee-exemption$/.test(path)) {
          return setLateFeeExemption(request, env, session, path);
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
        // Both admins and the superadmin read the archive; only the superadmin
        // can destroy anything in it, which is why the delete lives under /god.
        if (route === 'GET /api/admin/notices/archive') {
          return json({ notices: await listArchivedNotices(env) });
        }
        if (request.method === 'GET' && /^\/api\/admin\/notices\/\d+\/archived$/.test(path)) {
          const notice = await getNotice(env, Number(path.split('/')[4]),
            { isAdmin: true, viewer: session.subject, includeWithdrawn: true });
          return notice ? json(notice) : problem(404, 'DDP-NOTICE-001', 'That notice could not be found.');
        }
        if (route === 'POST /api/admin/notices')  return postNotice(request, env, session);
        if (request.method === 'POST' && /^\/api\/admin\/notices\/\d+\/attachments$/.test(path)) {
          return postNoticeAttachment(request, env, session, path, ctx);
        }
        // Removing a resident's photo is the same shape of act as hiding their
        // words, so it sits beside it: admin only, soft, and audited.
        if (request.method === 'DELETE' && /^\/api\/admin\/attachments\/\d+$/.test(path)) {
          return deleteAttachment(env, session, Number(path.split('/')[4]));
        }
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
        if (route === 'POST /api/admin/statement') return uploadStatement(request, env, session, ctx);
        if (request.method === 'GET' && /^\/api\/admin\/statement\/\d+$/.test(path)) {
          return statementReport(env, path);
        }
        if (request.method === 'POST' && /^\/api\/admin\/statement\/\d+\/finish$/.test(path)) {
          return finishStatement(env, session, path);
        }
        if (request.method === 'DELETE' && /^\/api\/admin\/statement\/\d+$/.test(path)) {
          return discardStatement(env, session, path);
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
        if (request.method === 'DELETE' && /^\/api\/god\/notices\/\d+$/.test(path)) {
          return purgeNoticeRoute(env, session, Number(path.split('/')[4]), ctx);
        }
        if (route === 'GET /api/god/bills')  return godBills(env, url);
        if (route === 'GET /api/god/edits')  return godEdits(env, url);
        if (route === 'GET /api/god/diagnostics') return godDiagnostics(env, url);
        if (route.startsWith('PATCH /api/god/owner/')) return editOwner(request, env, session, path);
        if (route.startsWith('PATCH /api/god/bill/'))  return editBill(request, env, session, path);
      }

      return problem(404, 'DDP-SYS-001', 'No such endpoint.');
    }));
  },

  async scheduled(event, env, ctx) {
    await assertAlerting(env);

    // Two triggers, and which one fired decides the work. The backup runs at
    // 03:30 IST because that was asked for; the digest cannot follow it there,
    // because a Telegram message at 3:30am is a notification somebody mutes,
    // and muting it takes the 22 warnings only the digest reports with it.
    if (isBackupCron(event.cron)) {
      await runBackup(env, ctx);
      return;
    }

    await runScheduled(env, ctx);
    await pruneOldRows(env);
    // An unfinished reconciliation is the one way a bank statement could sit in
    // the database indefinitely. Close it before the night is out.
    await sweepAbandonedStatements(env);
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
    `SELECT id, name, flat, role, pw_hash, pw_salt, pw_iterations, must_change_pw, pw_expires_at
       FROM owners WHERE mobile = ? AND active = 1`
  ).bind(mobile).first();

  // Same response either way — don't leak which mobiles are registered.
  //
  // The wording was never the whole story: the CLOCK was answering a question
  // the message refused. A registered number pays for a PBKDF2 derive, an
  // unregistered one used to return immediately, and that gap is measured at
  // 27 ms on the edge — a reliable "does this flat exist" oracle over the
  // network, against a building whose mobile numbers are a small guessable
  // range. Raising PBKDF2_ITERATIONS makes it WORSE, not better: at 300000 the
  // gap is ~81 ms, which is why this lands with that change rather than after.
  //
  // So an unknown mobile buys the same derive. Cost is one wasted hash on a
  // request that was going to fail anyway, already behind the login rate
  // limiter — and the result is deliberately discarded.
  if (!owner) {
    await derive(password, DUMMY_SALT, ITER(env));
    await reportError(env, 'DDP-AUTH-001', { mobile }, ctx);
    return problem(401, 'DDP-AUTH-002', 'Mobile number or password is incorrect.');
  }

  // At the count that MADE this hash, not the current target — otherwise
  // raising the target locks out everyone who has not logged in since.
  const ok = await verifyPassword(password, owner.pw_hash, owner.pw_salt, owner.pw_iterations);
  if (!ok) {
    await reportError(env, 'DDP-AUTH-002', { mobile }, ctx);
    return problem(401, 'DDP-AUTH-002', 'Mobile number or password is incorrect.');
  }

  // Checked AFTER the password verifies, deliberately. Answering "that has
  // expired" to a wrong password would tell an attacker holding a stale message
  // that the number is real and that the account exists — and the resident who
  // genuinely mistyped would be sent to /forgot instead of trying again.
  const temp = tempPasswordState(owner);
  if (temp.expired) {
    await reportError(env, 'DDP-AUTH-012',
                      { flat: owner.flat, ownerId: owner.id, expiredAt: owner.pw_expires_at }, ctx);
    return problem(401, 'DDP-AUTH-012', expiredPasswordMessage());
  }

  await clearRateLimit(env, mobile);

  // A correct login is the only moment the plaintext password is in hand AND
  // known to be right, so it is the only moment the stored hash can be moved
  // to a new cost. This is what turns raising PBKDF2_ITERATIONS from a
  // building-wide lockout into a migration that runs itself, one login at a
  // time, with nobody typing anything different.
  //
  // It costs a second derive on this request — only for accounts not yet
  // upgraded, and only once each. The try/catch is the point: someone who
  // typed their password correctly must be let in even if the upgrade fails,
  // and their next login will simply try again.
  if (owner.pw_iterations !== ITER(env)) {
    try {
      const upgraded = await hashPassword(password, ITER(env));
      await env.DB.prepare(
        'UPDATE owners SET pw_hash = ?, pw_salt = ?, pw_iterations = ? WHERE id = ?'
      ).bind(upgraded.hash, upgraded.salt, upgraded.iterations, owner.id).run();
    } catch (err) {
      await reportError(env, 'DDP-AUTH-016',
        { ownerId: owner.id, from: owner.pw_iterations, to: ITER(env), err: String(err) }, ctx);
    }
  }

  // Remember me, and what it actually changes. The session ROW is short-lived
  // either way when unticked; the cookie is what decides whether closing the
  // browser signs you out. Defaults to remembering, because most people are on
  // their own phone and being logged out monthly is the complaint we would get.
  const remember = body?.remember !== false;
  const ttl = (remember ? RESIDENT_TTL_DAYS : SHARED_DEVICE_TTL_DAYS) * 86_400;
  const { token, maxAge } = await createSession(env, { actorId: owner.id, ttlSeconds: ttl });
  await audit(env, { actor: { id: owner.id }, subject: { id: owner.id } }, 'login');

  return json(
    { flat: owner.flat, name: owner.name, role: owner.role, mustChangePassword: !!owner.must_change_pw },
    { headers: { 'set-cookie': cookieHeader(token, remember ? maxAge : null) } }
  );
}

async function logout(env, session) {
  await destroySession(env, session.token);
  await audit(env, session, 'logout');
  return json({ ok: true }, { headers: { 'set-cookie': clearCookieHeader() } });
}

async function me(env, session, request) {
  // Subject comes from the session, never from the client.
  const payload = await dashboardPayload(
    env, session.subject,
    request.headers.get('user-agent') ?? '',
    new URL(request.url).origin
  );
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

  // Name, mobile and email come back too: the policy refuses a password built
  // out of them, and it cannot check what it has not been given.
  const row = await env.DB.prepare(
    `SELECT pw_hash, pw_salt, pw_iterations, must_change_pw, name, mobile, email, flat, role
       FROM owners WHERE id = ?`
  ).bind(session.actor.id).first();

  // A forced first-login change doesn't re-ask for the temporary password.
  if (!row.must_change_pw) {
    const ok = await verifyPassword(current, row.pw_hash, row.pw_salt, row.pw_iterations);
    if (!ok) return problem(403, 'DDP-AUTH-002', 'Your current password is incorrect.');
  }

  // After the current-password check, so a stranger holding the session but
  // not the password learns nothing about the policy or the account.
  validateNewPassword(next, row);   // throws DDP-AUTH-008/012/013/014

  const { hash, salt, iterations } = await hashPassword(next, ITER(env));
  await env.DB.prepare(
    `UPDATE owners SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, must_change_pw = 0,
            pw_expires_at = NULL
      WHERE id = ?`
  ).bind(hash, salt, iterations, session.actor.id).run();

  await destroyAllSessionsFor(env, session.actor.id);
  await audit(env, session, 'password.change');
  return json({ ok: true, signedOutElsewhere: true }, { headers: { 'set-cookie': clearCookieHeader() } });
}

/**
 * The resident directory, keyed by flat once the client groups it.
 *
 * Active-only by default. Moved-out residents used to be listed here with
 * nothing to distinguish them, which is wrong in both directions: the
 * directory read as if they still lived here, and the late-fee exemption
 * picker (which shares this endpoint) offered them a waiver on bills nobody
 * was going to send. `?include=past` brings them back for history, and is
 * superadmin-only — an admin asking for it is refused rather than quietly
 * downgraded, so a stale client fails where somebody can see it.
 */
async function listResidents(env, session, url) {
  const wantsPast = url.searchParams.get('include') === 'past';
  if (wantsPast && !hasRole(session, 'superadmin')) {
    await reportError(env, 'DDP-ADMIN-004', { path: url.pathname, actor: session.actor.id });
    return problem(403, 'DDP-ADMIN-004', 'Past residents are superadmin-only.');
  }

  const { results } = await env.DB.prepare(
    `SELECT o.id, o.flat, f.floor, o.name, o.mobile, o.email, o.role,
            o.relationship, o.active, o.moved_out_at, o.must_change_pw
       FROM owners o JOIN flats f ON f.flat = o.flat
      ${wantsPast ? '' : 'WHERE o.active = 1'}
      ORDER BY f.floor, o.flat, o.active DESC, o.relationship`
  ).all();
  // The console has to draw the same conclusion the endpoint will reach, or an
  // admin is shown a button that refuses them — or, worse, told to send someone
  // to `/forgot` when nothing can be sent. It is the mailbox that decides, so
  // the mailbox is what gets reported.
  return json({ residents: results, mailConfigured: mailConfigured(env) });
}

async function resetPassword(request, env, session, path) {
  const ownerId = Number(path.split('/')[4]);
  const target = await env.DB.prepare(
    'SELECT id, name, flat, mobile, email, role FROM owners WHERE id = ?'
  ).bind(ownerId).first();
  if (!target) return problem(404, 'DDP-AUTH-006', 'No such resident.');

  // Superadmin only since 2026-08-12: a reset mints a working credential, so
  // whoever performs one can log in as that resident. See canResetPassword —
  // which holds the admin rung open for as long as there is no mailbox, because
  // the restriction only relocates the capability to the resident once `/forgot`
  // can actually reach them.
  const allowed = canResetPassword({
    actor: session.actor, target, mailConfigured: mailConfigured(env),
  });
  if (!allowed.ok) {
    await reportError(env, 'DDP-ADMIN-014',
                      { actor: session.actor.id, target: target.id, targetRole: target.role });
    return problem(403, 'DDP-ADMIN-014', allowed.message);
  }

  // Nobody reads an existing password — it is a hash and is gone. This mints one.
  //
  // A committee account gets the long form. Resetting one hands out a working
  // credential for an account that can impersonate residents and reach the god
  // console, over WhatsApp, and the stricter password policy it is subject to
  // does not apply to the password it is holding right now. The expiry below
  // bounds how long that matters; the extra entropy bounds how guessable it is
  // while it lasts.
  const otp = generateOneTimePassword({ strong: target.role !== 'owner' });
  const { hash, salt, iterations } = await hashPassword(otp, ITER(env));
  await env.DB.prepare(
    `UPDATE owners SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, must_change_pw = 1,
            pw_expires_at = ?
      WHERE id = ?`
  ).bind(hash, salt, iterations, tempPasswordExpiry(TEMP_PW_HOURS), ownerId).run();
  await destroyAllSessionsFor(env, ownerId);
  await audit(env, session, 'password.reset', { ownerId, flat: target.flat });

  // The expiry may be promised again, because it is now enforced — migration
  // 0023 and `tempPasswordState`. The wording was withdrawn once when
  // `expiresInHours: 24` was a decorative number nothing acted on, so the claim
  // and the column go back in together or not at all.
  const text =
    `Diamond Park portal: your temporary password is ${otp}\n` +
    `It expires in ${TEMP_PW_HOURS} hours.\n` +
    'Log in at https://diamondpark.pages.dev and choose your own password straight away.';
  // Shown to the superadmin on screen, then emailed on a second deliberate tap.
  // Showing it here is not the hole this feature closed: that hole was ADMINS
  // holding credentials for accounts that are not theirs. The superadmin can
  // already reset any account with the break-glass script, so the screen tells
  // them nothing their own database access would not — and it is what keeps the
  // flow working on a day when mail is down, or the address on file is wrong.
  return json({
    oneTimePassword: otp,
    expiresInHours: TEMP_PW_HOURS,
    email: target.email,
    whatsapp: waLink(target.mobile, text),
  });
}

/**
 * Email a temporary password that was just issued on screen.
 *
 * Takes the password back from the caller and CHECKS IT AGAINST THE STORED HASH
 * before sending. Two things follow from that, and both are the reason it works
 * this way rather than mailing whatever it is handed: the endpoint cannot be used
 * to send arbitrary text to a resident, and it stops working the moment the
 * password stops being current — a second reset, or the resident choosing their
 * own, makes a stale tab's Send button fail loudly instead of mailing a password
 * that no longer opens anything.
 *
 * Deliberately a second call rather than a flag on the reset. The superadmin sees
 * the password first and decides to send it; a reset that mailed automatically
 * would be one that cannot be performed quietly for somebody standing next to
 * you, which is the walk-in case this whole path exists for.
 */
async function emailTempPassword(request, env, session, path) {
  const ownerId = Number(path.split('/')[4]);
  const body = await readJson(request);
  const offered = String(body?.oneTimePassword ?? '');

  const target = await env.DB.prepare(
    `SELECT id, name, flat, email, role, pw_hash, pw_salt, must_change_pw, pw_expires_at
       FROM owners WHERE id = ?`
  ).bind(ownerId).first();
  if (!target) return problem(404, 'DDP-AUTH-006', 'No such resident.');

  // The same ladder as the reset itself. Without it this is a reset's payload
  // delivered by an endpoint that never asked who was allowed to cause one.
  const allowed = canResetPassword({
    actor: session.actor, target, mailConfigured: mailConfigured(env),
  });
  if (!allowed.ok) {
    await reportError(env, 'DDP-ADMIN-014',
                      { actor: session.actor.id, target: target.id, targetRole: target.role });
    return problem(403, 'DDP-ADMIN-014', allowed.message);
  }

  if (!target.email) {
    await reportError(env, 'DDP-AUTH-011', { flat: target.flat, ownerId: target.id });
    return problem(400, 'DDP-AUTH-011',
      `${target.name} has no email address on file, so there is nowhere to send it. `
      + 'Send the password another way, or add an address first.');
  }

  const current = offered
    && target.must_change_pw
    && await verifyPassword(offered, target.pw_hash, target.pw_salt, ITER(env));
  if (!current) {
    return problem(409, 'DDP-ADMIN-003',
      'That temporary password is no longer the current one for this account. '
      + 'Issue a fresh one and send that instead.');
  }

  const { subject, text } = tempPasswordEmail({
    password: offered, name: target.name, flat: target.flat, hours: TEMP_PW_HOURS,
  });
  const result = await sendEmail(env, { to: target.email, subject, text });

  if (!result.sent) {
    await reportError(env, 'DDP-MAIL-001', { flat: target.flat, reason: result.reason });
    // Said plainly rather than as a success. A screen that claims to have sent a
    // password nobody received is how a locked-out resident stays locked out
    // while everybody believes they were helped.
    return problem(502, 'DDP-MAIL-001',
      result.reason === 'not-configured'
        ? 'Email is not set up yet, so nothing was sent. The password on screen is '
          + 'still valid — pass it on another way.'
        : `The email could not be sent (${result.reason}). The password on screen is `
          + 'still valid — pass it on another way.');
  }

  await audit(env, session, 'password.reset.emailed',
              { ownerId, flat: target.flat, sentTo: target.email });
  return json({ sent: true, to: target.email });
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
    //
    // claimed_at is set ONLY when NULL, and that condition is the whole point:
    // it starts the late-fee hold, so refreshing it on every tap would let
    // anybody hold their own bill indefinitely by opening the app each night.
    // The first claim is the honest one and the clock runs from it.
    env.DB.prepare(
      `UPDATE bills SET status = 'initiated',
                        claimed_at = COALESCE(claimed_at, ?)
        WHERE id = ? AND status = 'unpaid'`
    ).bind(new Date().toISOString(), bill.id),
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
    // The SUBJECT, even though the comment is written by the actor.
    // Impersonation is refused above, so they are the same person — and only
    // subject carries `relationship`. Passing actor here leaves it undefined,
    // canSeeNotice reads that as "not a tenant", and a tenant may comment on an
    // owners-only notice. That is the leak this item exists to close.
    viewer: session.subject,
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
  if (email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    return problem(400, 'DDP-NOTICE-003', 'That email address looks wrong. Check it, or leave it blank.');
  }

  // The name and email being checked against are the ones arriving in THIS
  // request, not the roster's guesses — onboarding is the one place where the
  // account's own details are set in the same breath as the password, and
  // reading the stored row here would let someone type their name into both
  // fields and sail through.
  const account = await env.DB.prepare('SELECT mobile, flat, role FROM owners WHERE id = ?')
    .bind(session.actor.id).first();
  validateNewPassword(password, { ...account, name, email });

  const { hash, salt, iterations } = await hashPassword(password, ITER(env));
  await env.DB.prepare(
    `UPDATE owners SET name = ?, email = ?, pw_hash = ?, pw_salt = ?, pw_iterations = ?,
            must_change_pw = 0, pw_expires_at = NULL
      WHERE id = ?`
  ).bind(name, email, hash, salt, iterations, session.actor.id).run();

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

  // Anything unrecognised becomes 'all'. Defaulting the other way would let a
  // typo quietly narrow the audience, and a notice nobody sees is a failure
  // that looks exactly like a notice nobody replied to.
  const scope = NOTICE_SCOPES.includes(b?.scope) ? b.scope : 'all';

  const row = await env.DB.prepare(
    `INSERT INTO notices (title, body, kind, event_date, allow_comments, scope, active, posted_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?) RETURNING id`
  ).bind(title, body, b?.kind === 'event' ? 'event' : 'notice',
         b?.eventDate ?? null, b?.allowComments ? 1 : 0, scope,
         new Date().toISOString()).first();

  await audit(env, session, 'notice.create', { id: row.id, title, scope });
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
  // Validated on the way in, like the insert. Narrowing an existing notice is
  // allowed — the committee sometimes realises afterwards that something was
  // owner business — and widening it back is the same operation.
  if (b?.scope !== undefined && NOTICE_SCOPES.includes(b.scope)) {
    fields.push('scope = ?');
    values.push(b.scope);
  }
  if (!fields.length) return problem(400, 'DDP-NOTICE-003', 'Nothing to change.');

  await env.DB.prepare(`UPDATE notices SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values, id).run();
  await audit(env, session, 'notice.update', { id, changed: Object.keys(b ?? {}) });
  return json({ id });
}

/**
 * Destroy a withdrawn notice, its replies and its files. Superadmin only.
 *
 * The rows go first and the objects after. A key with no row is a byte nobody
 * can find; a row whose object is already gone is merely a broken link the
 * archive can show. If a delete fails the id is reported rather than retried —
 * an orphaned object in R2 is a cleanup job, not a reason to abandon a deletion
 * the superadmin has explicitly asked for and half-finished.
 */
async function purgeNoticeRoute(env, session, noticeId, ctx) {
  let result;
  try {
    result = await purgeNotice(env, noticeId);
  } catch (err) {
    if (err.code === 'DDP-NOTICE-005') {
      return problem(409, 'DDP-NOTICE-005',
        'Withdraw this notice before deleting it permanently.');
    }
    if (err.code === 'DDP-NOTICE-001') {
      return problem(404, 'DDP-NOTICE-001', 'That notice could not be found.');
    }
    throw err;
  }

  const failed = [];
  for (const key of result.keys) {
    try {
      await env.PROOFS.delete(key);
    } catch {
      failed.push(key);
    }
  }
  if (failed.length) await reportError(env, 'DDP-ATTACH-003', { noticeId, failed }, ctx);

  await audit(env, session, 'notice.purge',
    { id: noticeId, title: result.title, files: result.keys.length });
  return json({ id: noticeId, deleted: true, files: result.keys.length });
}

/* ── attachments ──────────────────────────────────────────────────────────
 *
 * Uploaded AFTER the notice or comment exists, one request per file. The
 * alternative — hold files somewhere and bind them when the parent is created —
 * needs an orphan sweep for every upload the author abandons, and buys nothing:
 * if the second request fails the author sees the error against a post that
 * already exists and can simply try the file again.
 */

/**
 * The one place bytes reach R2, whichever parent they belong to.
 *
 * The insert happens BEFORE the put, matching proofs (lib/proof.js): a row with
 * no object is a visible, fixable inconsistency, while an object with no row is
 * a byte nobody can find and nobody will ever delete.
 */
async function storeAttachment(request, env, session, parent, ctx) {
  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') {
    return problem(400, 'DDP-ATTACH-001', 'Choose a file to attach.');
  }

  const check = validateAttachment({ type: file.type, size: file.size });
  if (!check.ok) {
    await reportError(env, 'DDP-ATTACH-001', { type: file.type, size: file.size });
    return problem(400, 'DDP-ATTACH-001', check.message);
  }

  try {
    await assertRoom(env, parent);
  } catch {
    const cap = parent.noticeId ? MAX_PER_NOTICE : MAX_PER_COMMENT;
    return problem(409, 'DDP-ATTACH-002',
      `That already has ${cap} attachments, which is the limit.`);
  }

  const filename = safeFilename(file.name);
  const key = attachmentKey(parent, filename);

  // Optional, and never trusted: the browser makes it, so it is checked like
  // any other upload. A thumbnail that fails validation is simply dropped —
  // the board falls back to the full image, which is worse for mobile data but
  // not worth failing an otherwise good upload over.
  const thumbPart = form.get('thumb');
  const thumb = thumbPart && typeof thumbPart !== 'string'
    && validateThumb({ type: thumbPart.type, size: thumbPart.size })
    ? thumbPart : null;
  const thumbKey = thumb ? `${key}.thumb.jpg` : null;
  // Streamed to R2 rather than buffered. At the old 2MB ceiling reading the
  // whole file into a Uint8Array was harmless; at 25MB, against a Worker's
  // 128MB of memory, two concurrent uploads should not be competing for it.
  // Nothing here needs the bytes — unlike proofs, which hash them for dedupe.
  const body = file.stream();

  const row = await env.DB.prepare(
    `INSERT INTO attachments (notice_id, comment_id, r2_key, thumb_key, filename, content_type, bytes, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(parent.noticeId ?? null, parent.commentId ?? null, key, thumbKey, filename,
         file.type, file.size, session.actor.id, new Date().toISOString()).first();

  try {
    await env.PROOFS.put(key, body, { httpMetadata: { contentType: file.type } });
    if (thumb) {
      // After the original, and allowed to fail on its own: losing the
      // thumbnail costs mobile data, losing the original loses the evidence.
      try {
        await env.PROOFS.put(thumbKey, thumb.stream(), {
          httpMetadata: { contentType: thumb.type },
        });
      } catch {
        await env.DB.prepare('UPDATE attachments SET thumb_key = NULL WHERE id = ?')
          .bind(row.id).run();
      }
    }
  } catch (err) {
    await env.DB.prepare('UPDATE attachments SET deleted_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), row.id).run();
    await reportError(env, 'DDP-ATTACH-004', err, ctx);
    return problem(500, 'DDP-ATTACH-004', 'The file could not be stored. Try again.');
  }

  await audit(env, session, 'attachment.upload', { id: row.id, ...parent, bytes: file.size });

  // Told about AFTER it is stored, and off the critical path: the resident who
  // uploaded it should not wait on Telegram, and a Telegram outage must not
  // turn a successful upload into an error they see.
  if (isLargeUpload(file.size)) {
    const alert = () => announceLargeUpload(env, session, { filename, bytes: file.size, parent });
    if (ctx?.waitUntil) ctx.waitUntil(alert());
    else await alert();
  }

  return json({ id: row.id, filename, bytes: file.size }, { status: 201 });
}

/**
 * Tell the committee, as it happens, that something big just landed in R2.
 *
 * Sent through postToTelegram rather than reportError, because this is NOT an
 * error: the upload was accepted, is within the limit, and is doing exactly
 * what it should. Routing it through the error path would file it in error_log
 * and put a severity on it, and an alert channel that cries wolf about normal
 * events stops being read — which is the failure mode that matters here.
 *
 * It names the flat and the notice, because "someone uploaded 22MB" is not
 * something a committee can act on and "Sekharan, 5A, on the AGM notice" is.
 */
async function announceLargeUpload(env, session, { filename, bytes, parent }) {
  const mb = (bytes / (1024 * 1024)).toFixed(1);

  const where = parent.noticeId
    ? await env.DB.prepare('SELECT title FROM notices WHERE id = ?').bind(parent.noticeId).first()
    : await env.DB.prepare(
        `SELECT n.title FROM comments c JOIN notices n ON n.id = c.notice_id WHERE c.id = ?`
      ).bind(parent.commentId).first();

  await postToTelegram(env, [
    `LARGE UPLOAD · ${mb}MB`,
    `${filename}`,
    `${session.actor.name ?? 'Someone'} · flat ${session.actor.flat ?? '?'}`,
    parent.noticeId ? `on notice: ${where?.title ?? '?'}` : `on a reply to: ${where?.title ?? '?'}`,
    `\n${new Date().toISOString()}`,
  ].join('\n'));
}

async function postNoticeAttachment(request, env, session, path, ctx) {
  const noticeId = Number(path.split('/')[4]);
  const notice = await env.DB.prepare('SELECT id FROM notices WHERE id = ? AND active = 1')
    .bind(noticeId).first();
  if (!notice) return problem(404, 'DDP-NOTICE-001', 'That notice could not be found.');
  return storeAttachment(request, env, session, { noticeId }, ctx);
}

async function postCommentAttachment(request, env, session, path, ctx) {
  if (session.impersonating) {
    return problem(403, 'DDP-AUTH-007', 'Cannot upload while viewing as another resident.');
  }
  const commentId = Number(path.split('/')[3]);

  // Yours, and still visible. Attaching to somebody else's reply would put a
  // resident's name against a file they did not choose, and attaching to a
  // hidden one would walk straight past a moderation decision.
  const comment = await env.DB.prepare(
    'SELECT id, owner_id, hidden_at FROM comments WHERE id = ?'
  ).bind(commentId).first();
  if (!comment) return problem(404, 'DDP-NOTICE-001', 'That reply could not be found.');
  if (comment.owner_id !== session.actor.id || comment.hidden_at) {
    await reportError(env, 'DDP-ADMIN-004', { commentId, actor: session.actor.id });
    return problem(403, 'DDP-ADMIN-004', 'Not yours to add to.');
  }

  return storeAttachment(request, env, session, { commentId }, ctx);
}

/**
 * Serving a file is a notice-visibility question, not a file question.
 *
 * An attachment inherits its notice's scope — through the comment it hangs off,
 * if that is how it got here. Skip this and the AGM papers are readable by a
 * tenant who guesses a small integer, which is the leak the scope rule
 * (lib/notices.js canSeeNotice) exists to prevent, reopened through a side
 * door. Withdrawn notices stop serving their files for the same reason.
 */
async function serveAttachment(env, session, id, { thumb = false } = {}) {
  const row = await env.DB.prepare(
    `SELECT a.id, a.r2_key, a.thumb_key, a.filename, a.content_type, a.deleted_at,
            n.scope, n.active
       FROM attachments a
       LEFT JOIN comments c ON c.id = a.comment_id
       JOIN notices n ON n.id = COALESCE(a.notice_id, c.notice_id)
      WHERE a.id = ?`
  ).bind(id).first();

  if (!row) return problem(404, 'DDP-ATTACH-003', 'That file could not be found.');

  // Asked about the SUBJECT, never the actor — see canSeeAttachment, which
  // exists because getting this wrong here leaked the AGM papers to a tenant.
  if (!canSeeAttachment(row, session.subject)) {
    // Same answer as a missing file: declining to confirm it exists.
    return problem(404, 'DDP-ATTACH-003', 'That file could not be found.');
  }
  if (row.deleted_at || !row.r2_key) {
    return problem(410, 'DDP-ATTACH-003', 'That file has been removed.');
  }

  // Asking for a thumbnail that was never made gets the full image rather than
  // a 404 — the board asks for /thumb on every image, including ones uploaded
  // before 0019, and a broken picture is a worse answer than a large one.
  const wantThumb = thumb && row.thumb_key;
  const key = wantThumb ? row.thumb_key : row.r2_key;
  const contentType = wantThumb ? 'image/jpeg' : row.content_type;

  const object = await env.PROOFS.get(key);
  if (!object) {
    await reportError(env, 'DDP-ATTACH-003', { id, key });
    return problem(404, 'DDP-ATTACH-003', 'That file is missing from storage.');
  }

  return new Response(object.body, {
    headers: {
      'content-type': contentType,
      // inline so a photo opens in the tab and a PDF in the viewer, with the
      // uploader's filename kept for whoever saves it. safeFilename has already
      // stripped the quotes and control characters that would break this header.
      'content-disposition': `inline; filename="${row.filename}"`,
      // Attachments are behind a login and some are owners-only; a shared
      // cache must not keep them.
      'cache-control': 'private, no-store',
      // Belt and braces for a bucket that also holds resident-uploaded files:
      // never let a stored type be sniffed into something executable.
      'x-content-type-options': 'nosniff',
    },
  });
}

/** Soft delete, matching comment hiding: the row and its uploader survive. */
async function deleteAttachment(env, session, id) {
  const row = await env.DB.prepare(
    'SELECT id, r2_key, thumb_key, notice_id, comment_id FROM attachments WHERE id = ? AND deleted_at IS NULL'
  ).bind(id).first();
  if (!row) return problem(404, 'DDP-ATTACH-003', 'That file could not be found.');

  // Both objects go; the row stays. Keeping the bytes of something a committee
  // has decided to remove is the one outcome nobody wants — and a thumbnail is
  // a legible copy of the same photograph, so leaving it behind would make the
  // removal a gesture rather than a deletion.
  for (const key of [row.r2_key, row.thumb_key]) {
    if (key) await env.PROOFS.delete(key).catch(() => {});
  }

  await env.DB.prepare(
    'UPDATE attachments SET r2_key = NULL, thumb_key = NULL, deleted_by = ?, deleted_at = ? WHERE id = ?'
  ).bind(session.actor.id, new Date().toISOString(), id).run();

  await audit(env, session, 'attachment.delete', { id, noticeId: row.notice_id, commentId: row.comment_id });
  return json({ id, deleted: true });
}

async function postResident(request, env, session) {
  const b = await readJson(request);
  const flat = String(b?.flat ?? '').trim().toUpperCase();
  const name = String(b?.name ?? '').trim();
  // The committee records this, not the resident: it decides who is liable
  // for unpaid gas, and it is the one field somebody has an incentive to get
  // wrong about themselves. Defaults to owner, the common case.
  const relationship = b?.relationship ?? 'owner';
  if (!isRelationship(relationship)) {
    return problem(400, 'DDP-ADMIN-003', 'Relationship must be owner or tenant.');
  }
  // Normalised, not stripped. Storing bare digits here while login normalises
  // to E.164 meant a newly created resident could never log in — the same
  // mixed-format bug 0009 fixed, quietly reintroduced on the write path.
  let mobile;
  try {
    mobile = normaliseMobile(b?.mobile);
  } catch {
    return problem(400, 'DDP-ADMIN-009', explainField('mobile', b?.mobile));
  }
  if (!flat || !name) {
    return problem(400, 'DDP-ADMIN-003', 'A resident needs a flat, a name and a mobile number.');
  }

  // Validated on the way in, like every other write path. This one used to take
  // b.email raw, so the address a locked-out resident's reset code is sent to
  // was the one field nothing ever checked.
  let email = null;
  if (b?.email) {
    email = normaliseEmail(b.email);
    if (!email) return problem(400, 'DDP-ADMIN-010', explainField('email', b.email));
  }

  const known = await env.DB.prepare('SELECT flat FROM flats WHERE flat = ?').bind(flat).first();
  if (!known) {
    await reportError(env, 'DDP-ADMIN-001', { flat });
    // whyNot knows the building's actual shape — that floor 1 is parking, that
    // there is no I, that 10, 12 and 14 are duplexes. "Not on the register" is
    // true but says nothing about what to type instead.
    return problem(400, 'DDP-ADMIN-001', whyNot(flat) ?? `Flat ${flat} is not on the register.`);
  }

  // mobile is the login id and email is where a reset code goes; a duplicate of
  // either quietly hands one person's account to another.
  for (const [field, value] of [['mobile', mobile], ['email', email]]) {
    if (!value) continue;
    const clash = await duplicateContact(env, 0, field, value);
    if (clash) {
      return problem(409, 'DDP-ADMIN-013',
        `That ${field} already belongs to ${clash.name} (${clash.flat}).`);
    }
  }

  // Issued, not chosen: the resident replaces it on first login.
  const otp = generateOneTimePassword();
  const { hash, salt, iterations } = await hashPassword(otp, ITER(env));
  const row = await env.DB.prepare(
    `INSERT INTO owners (flat, name, mobile, email, pw_hash, pw_salt, pw_iterations,
                         must_change_pw, pw_expires_at, role, relationship, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'owner', ?, ?) RETURNING id`
  ).bind(flat, name, mobile, email, hash, salt, iterations,
         tempPasswordExpiry(TEMP_PW_HOURS), relationship,
         new Date().toISOString()).first();

  await audit(env, session, 'resident.create', { id: row.id, flat, relationship });
  const rawText =
    `Diamond Park portal — your temporary password is ${otp}\n` +
    `Log in at https://diamondpark.pages.dev and choose your own.`;
  return json({ id: row.id, oneTimePassword: otp, whatsapp: waLink(mobile, rawText) },
    { status: 201 });
}

async function patchResident(request, env, session, path) {
  const id = Number(path.split('/')[4]);
  const b = await readJson(request);

  // email and mobile are read for the audit trail as much as for the edit: the
  // log has to say what an admin changed a number FROM, or a resident locked
  // out by a corrected typo leaves no record of the number that used to work.
  const target = await env.DB.prepare(
    'SELECT id, name, flat, role, email, mobile FROM owners WHERE id = ?'
  ).bind(id).first();
  if (!target) return problem(404, 'DDP-AUTH-006', 'No such resident.');

  // Whether this row is theirs to touch at all. Which COLUMNS they may write is
  // a separate question, asked per field below — since B22 an admin may fix a
  // name but must raise a request for a mobile or an address.
  const allowed = canEditResident({ actor: session.actor, target });
  if (!allowed.ok) {
    await reportError(env, 'DDP-ADMIN-014',
                      { actor: session.actor.id, target: id, targetRole: target.role });
    return problem(403, 'DDP-ADMIN-014', allowed.message);
  }

  const fields = [];
  const values = [];
  // What the audit row will say. Keyed by field, each entry the value before
  // and after, so the log answers "what was it?" and not merely "it changed".
  const changes = {};
  // Validated by the same helper the god-edit page uses, which normalises the
  // mobile to E.164. This path used to store bare digits while login looked up
  // '+91…', so an admin fixing a typo could lock the resident out entirely.
  for (const field of ['name', 'email', 'mobile']) {
    if (b?.[field] === undefined) continue;
    // Per column, not per row. An admin submitting a mobile is refused here even
    // though the row itself is theirs to edit, and the refusal names the request
    // rather than just saying no.
    const perField = canEditField({ actor: session.actor, target, field });
    if (!perField.ok) {
      await reportError(env, 'DDP-ADMIN-014',
                        { actor: session.actor.id, target: id, field });
      return problem(403, 'DDP-ADMIN-014', perField.message, { requestInstead: true, field });
    }
    let value;
    try {
      value = validateOwnerField(field, b[field]);
    } catch (err) {
      return problem(400, err.code ?? 'DDP-ADMIN-010', explainField(field, b[field]));
    }
    if (value != null && (field === 'mobile' || field === 'email')) {
      const clash = await duplicateContact(env, id, field, value);
      if (clash) {
        return problem(409, 'DDP-ADMIN-013',
          `That ${field} already belongs to ${clash.name} (${clash.flat}).`);
      }
    }
    // The normalised value, not what was typed — that is what gets stored, and
    // an audit row showing the raw input would misreport the account's state.
    if (value !== (target[field] ?? null)) {
      changes[field] = { from: target[field] ?? null, to: value };
    }
    fields.push(`${field} = ?`);
    values.push(value);
  }

  // Only a superadmin may change roles — an admin must not promote themselves.
  if (b?.role !== undefined && hasRole(session, 'superadmin')) {
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM owners WHERE role = 'superadmin' AND active = 1"
    ).first();
    const verdict = canChangeRole({ target, newRole: b.role, superadminCount: count?.n ?? 0 });
    if (!verdict.ok) {
      await reportError(env, 'DDP-ADMIN-006', { id, newRole: b.role, count: count?.n });
      return problem(409, 'DDP-ADMIN-006', verdict.message);
    }
    if (b.role !== target.role) changes.role = { from: target.role, to: b.role };
    fields.push('role = ?'); values.push(b.role);
  }
  if (!fields.length) return problem(400, 'DDP-ADMIN-003', 'Nothing to change.');

  await env.DB.prepare(`UPDATE owners SET ${fields.join(', ')} WHERE id = ?`).bind(...values, id).run();
  // Only what actually moved, following the rule `diff()` already sets for the
  // god path: a field submitted with the value it already held records nothing.
  // The list of submitted keys used to be all this row carried; it is dropped
  // rather than kept beside `changes`, because the two together overflow the
  // 300 characters the activity log renders and `role` is what falls off the
  // end — the one change in here worth reading.
  await audit(env, session, 'resident.update', { id, flat: target.flat, changes });
  return json({ id });
}

/**
 * Why the value was refused, in the words of the person who typed it.
 *
 * The generic catalogue message ("That does not look like a mobile number.
 * Include the country code…") is advice the directory has already taken — the
 * country came from a picker. What is actually wrong is nearly always the
 * length, and saying so is the difference between a fix and a shrug.
 */
function explainField(field, value) {
  if (field === 'email') return 'That does not look like an email address.';
  if (field === 'name') return 'A name needs between 2 and 80 characters.';

  const parts = splitMobile(String(value ?? ''));
  const allowed = parts && NATIONAL_LENGTHS[Number(parts.dial)];
  if (allowed) {
    return `A +${parts.dial} number has ${allowed.join(' or ')} digits after the country code. `
         + `That one has ${parts.national.length}.`;
  }
  return 'That does not look like a mobile number. '
       + 'An Indian number is 10 digits; anything else needs its country code.';
}

/**
 * Would this mobile or email hand one person's account to another?
 *
 * Mobiles are compared in normalised form: the UNIQUE index cannot see that
 * '9567791515' and '+919567791515' are the same number, and neither can a
 * plain string comparison. Same query editOwner uses, lifted so both write
 * paths answer identically.
 */
/* ── contact-change requests (B22) ────────────────────────────────────────
   An admin notices a wrong number and raises a request; the superadmin
   approves, and approving is what applies it. Admins keep the job that needs
   somebody in the building and lose the write that would let them take an
   account — see canEditField for which field does that and how.            */

/** An admin raises one. */
async function requestContactChange(request, env, session, path) {
  const ownerId = Number(path.split('/')[4]);
  const b = await readJson(request);

  const target = await env.DB.prepare(
    'SELECT id, name, flat, role, mobile, email FROM owners WHERE id = ? AND active = 1'
  ).bind(ownerId).first();
  if (!target) return problem(404, 'DDP-AUTH-006', 'No such resident.');

  // The row ladder still applies: an admin may not raise a request against
  // another admin any more than they may edit one. Otherwise this endpoint is a
  // way to ask the superadmin to make the change they were refused.
  const allowed = canEditResident({ actor: session.actor, target });
  if (!allowed.ok) {
    await reportError(env, 'DDP-ADMIN-014',
                      { actor: session.actor.id, target: ownerId, targetRole: target.role });
    return problem(403, 'DDP-ADMIN-014', allowed.message);
  }

  let req;
  try {
    req = validateRequest({ field: b?.field, value: b?.value, reason: b?.reason });
  } catch (err) {
    return problem(400, err.code ?? 'DDP-ADMIN-010',
      err.code === 'DDP-ADMIN-011'
        ? 'Say why it needs changing — it is what the approval is reviewed against.'
        : explainField(b?.field, b?.value));
  }

  if (String(target[req.field] ?? '') === String(req.value ?? '')) {
    return problem(409, 'DDP-ADMIN-003',
      `That is already ${target.name}'s ${req.field}. Nothing to change.`);
  }

  // Checked when raised as well as at approval. Refusing a clash now happens
  // while the admin can still ask the resident; refusing it at approval lands in
  // front of somebody who cannot find out what the number should have been.
  if (req.value != null) {
    const clash = await duplicateContact(env, ownerId, req.field, req.value);
    if (clash) {
      return problem(409, 'DDP-ADMIN-013',
        `That ${req.field} already belongs to ${clash.name} (${clash.flat}).`);
    }
  }

  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO contact_requests
       (owner_id, field, requested_value, reason, requested_by, state, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?) RETURNING id`
  ).bind(ownerId, req.field, req.value, req.reason, session.actor.id, now).first();

  await audit(env, session, 'contact.request',
              { id: row.id, ownerId, flat: target.flat, field: req.field, reason: req.reason });

  // No value in the message — see requestNotification. Failure to notify must not
  // fail the request: it is recorded either way and the console is the queue.
  await postToTelegram(env, requestNotification({
    flat: target.flat, field: req.field, requestedBy: session.actor.name ?? 'an admin',
  })).catch(() => {});

  return json({ id: row.id, state: 'pending' }, { status: 201 });
}

/**
 * What is waiting. Every admin sees the queue, not only the superadmin: an admin
 * who cannot see that their own request is still pending will raise it again, or
 * phone about it, which is the two things this was built to stop.
 */
async function listContactRequests(env, url) {
  const wantsAll = url.searchParams.get('state') === 'all';
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.owner_id, r.field, r.requested_value, r.reason, r.state,
            r.created_at, r.decided_at,
            o.flat, o.name, o.mobile AS current_mobile, o.email AS current_email,
            rb.name AS requested_by_name, db.name AS decided_by_name
       FROM contact_requests r
       JOIN owners o  ON o.id  = r.owner_id
       JOIN owners rb ON rb.id = r.requested_by
       LEFT JOIN owners db ON db.id = r.decided_by
      ${wantsAll ? '' : "WHERE r.state = 'pending'"}
      ORDER BY r.state = 'pending' DESC, r.created_at`
  ).all();

  return json({
    requests: (results ?? []).map((r) => ({
      id: r.id, ownerId: r.owner_id, flat: r.flat, name: r.name,
      field: r.field, value: r.requested_value,
      current: r.field === 'mobile' ? r.current_mobile : r.current_email,
      reason: r.reason, state: r.state,
      requestedBy: r.requested_by_name, decidedBy: r.decided_by_name,
      at: toIST(r.created_at), decidedAt: r.decided_at ? toIST(r.decided_at) : null,
    })),
  });
}

/**
 * The superadmin decides. Approving APPLIES the change in the same call — two
 * steps would leave a queue of approved requests nobody had applied, with the
 * resident still unable to log in and everybody believing it was dealt with.
 */
async function decideContactRequest(request, env, session, path, approve) {
  const id = Number(path.split('/')[4]);
  const row = await env.DB.prepare('SELECT * FROM contact_requests WHERE id = ?')
    .bind(id).first();

  const state = requestState(row);
  if (!state.open) return problem(409, 'DDP-ADMIN-003', decisionFailure(state.reason));

  const owner = await env.DB.prepare(
    'SELECT id, name, flat, role, mobile, email FROM owners WHERE id = ?'
  ).bind(row.owner_id).first();
  if (!owner) return problem(404, 'DDP-AUTH-006', 'That resident no longer exists.');

  const now = new Date().toISOString();

  if (!approve) {
    await env.DB.prepare(
      "UPDATE contact_requests SET state = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?"
    ).bind(session.actor.id, now, id).run();
    await audit(env, session, 'contact.request.rejected',
                { id, ownerId: owner.id, flat: owner.flat, field: row.field });
    return json({ id, state: 'rejected' });
  }

  // Re-checked at approval, because approval can land days after the request and
  // another row may have taken the number in between. The clash check at request
  // time is for the admin's benefit; this one is what protects the login.
  if (row.requested_value != null) {
    const clash = await duplicateContact(env, owner.id, row.field, row.requested_value);
    if (clash) {
      return problem(409, 'DDP-ADMIN-013',
        `That ${row.field} now belongs to ${clash.name} (${clash.flat}), so this cannot `
        + 'be applied. Reject it and ask for a fresh one.');
    }
  }

  if (!isStillAChange(row, owner)) {
    // Approving would write what is already there and the audit row would claim a
    // change that did not happen. Say so instead of silently doing nothing.
    return problem(409, 'DDP-ADMIN-003',
      `${owner.name}'s ${row.field} is already that value — it was changed after this `
      + 'request was raised. Reject it; there is nothing left to apply.');
  }

  const before = owner[row.field] ?? null;
  await env.DB.batch([
    env.DB.prepare(`UPDATE owners SET ${row.field} = ? WHERE id = ?`)
      .bind(row.requested_value, owner.id),
    env.DB.prepare(
      "UPDATE contact_requests SET state = 'approved', decided_by = ?, decided_at = ? WHERE id = ?"
    ).bind(session.actor.id, now, id),
  ]);

  // Same shape as resident.update's `changes`, so one search of the log finds
  // every route by which a number has ever moved.
  await audit(env, session, 'contact.request.approved', {
    id, ownerId: owner.id, flat: owner.flat, reason: row.reason,
    changes: { [row.field]: { from: before, to: row.requested_value } },
  });

  return json({ id, state: 'approved', applied: { [row.field]: row.requested_value } });
}

async function duplicateContact(env, id, field, value) {
  if (field === 'mobile') {
    return env.DB.prepare(
      `SELECT id, name, flat FROM owners
        WHERE id <> ? AND (mobile = ? OR mobile = ? OR '+91' || mobile = ?)`
    ).bind(id, value, value.replace(/^\+91/, ''), value).first();
  }
  return env.DB.prepare('SELECT id, name, flat FROM owners WHERE email = ? AND id <> ?')
    .bind(value, id).first();
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
  const { hash, salt, iterations } = await hashPassword(otp, ITER(env));
  let mobile;
  try {
    mobile = normaliseMobile(b.mobile);   // see the note on resident creation
  } catch {
    return problem(400, 'DDP-ADMIN-009', 'That does not look like a mobile number.');
  }

  const incoming = await env.DB.prepare(
    `INSERT INTO owners (flat, name, mobile, email, pw_hash, pw_salt, pw_iterations,
                         must_change_pw, pw_expires_at, role, active, moved_in_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'owner', 1, ?, ?) RETURNING id`
  ).bind(flat, String(b.name).trim(), mobile, b?.email ?? null, hash, salt, iterations,
         tempPasswordExpiry(TEMP_PW_HOURS), now, now).first();

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

  const rawText =
    `Diamond Park portal — welcome. Your temporary password is ${otp}\n` +
    `Log in at https://diamondpark.pages.dev and choose your own.`;

  return json({
    flat, outgoing: outgoing.name, incomingId: incoming.id,
    oneTimePassword: otp, whatsapp: waLink(mobile, rawText),
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

/**
 * Naming the person behind a bill or a proof.
 *
 * Never join `owners ON o.flat = b.flat` on its own. A flat with both an owner
 * and a tenant on record matches TWICE, which silently duplicates every row it
 * touches — in the treasurer's queue that showed one screenshot as two, and in
 * reconciliation it read as one payment reference claimed against two bills and
 * accused honest residents of double-claiming.
 *
 * Prefer whoever the row actually belongs to. `owner_id` arrived in migration
 * 0003 and was backfilled from `bills.owner_id`, which is itself nullable, so
 * older rows still need the flat — but taken as one owner, not as a join.
 */
const ownerJoin = (idColumn) => `LEFT JOIN owners o
    ON o.id = COALESCE(${idColumn},
                       (SELECT id FROM owners WHERE flat = b.flat ORDER BY id LIMIT 1))`;

async function proofQueue(env) {
  const [proofs, claimed] = await Promise.all([
    env.DB.prepare(
      `SELECT p.*, b.flat, b.period, b.total, o.name
         FROM payment_proofs p
         JOIN bills b ON b.id = p.bill_id
         ${ownerJoin('p.owner_id')}
        WHERE p.status = 'pending' AND p.deleted_at IS NULL
        ORDER BY p.created_at`
    ).all(),
    env.DB.prepare(
      // GROUP BY already collapsed the duplicate to one row here, so the count
      // was right — but which of the two names it showed was arbitrary.
      `SELECT b.id, b.flat, b.period, b.total, o.name, MAX(i.created_at) AS last_intent
         FROM bills b
         JOIN payment_intents i ON i.bill_id = b.id
         ${ownerJoin('b.owner_id')}
        WHERE b.status = 'initiated'
        GROUP BY b.id ORDER BY last_intent`
    ).all(),
  ]);

  return json(shapeQueue({ proofs: proofs.results ?? [], claimed: claimed.results ?? [] }));
}

// ── bank statement reconciliation ───────────────────────────────────────
//
// The statement is working material. It is parsed on arrival, only its credit
// rows are kept, and those rows are deleted the moment the treasurer finishes
// — or by the 3am sweep if they walk away. The original file is never written
// anywhere: not to R2, not to D1. See migration 0017 and lib/statement.js.

/** Everything the matcher needs about the current state of the books. */
async function reconciliationInputs(env) {
  const [proofs, openBills] = await Promise.all([
    env.DB.prepare(
      // See ownerJoin: joining on the flat alone duplicates the proof, and a
      // duplicated proof reads as one reference claimed against two bills.
      `SELECT p.id AS proofId, p.bill_id AS billId, p.utr, p.parsed_amount AS claimedAmount,
              p.created_at AS createdAt, b.flat, b.period, b.total AS billed, o.name
         FROM payment_proofs p
         JOIN bills b ON b.id = p.bill_id
         ${ownerJoin('p.owner_id')}
        WHERE p.status = 'pending' AND p.deleted_at IS NULL
        ORDER BY p.created_at`
    ).all(),
    env.DB.prepare(
      // Same trap on the suggestion side, where it would offer one flat twice.
      `SELECT b.id, b.flat, b.period, b.total, o.name
         FROM bills b
         ${ownerJoin('b.owner_id')}
        WHERE b.status IN ('unpaid', 'initiated', 'awaiting')`
    ).all(),
  ]);
  return { proofs: proofs.results ?? [], openBills: openBills.results ?? [] };
}

async function reportFor(env, sessionId) {
  const rows = await env.DB.prepare(
    'SELECT txn_date AS date, amount, reference, narration FROM statement_credits WHERE session_id = ? ORDER BY txn_date, id'
  ).bind(sessionId).all();
  const { proofs, openBills } = await reconciliationInputs(env);
  return reconcile({ credits: rows.results ?? [], proofs, openBills });
}

async function uploadStatement(request, env, session, ctx) {
  const form = await request.formData().catch(() => null);
  const file = form?.get('statement');
  if (!file || typeof file === 'string') {
    return problem(400, 'DDP-RECON-001', 'Attach the bank statement as CSV or PDF.');
  }

  const check = validateStatement({ type: file.type, size: file.size, name: file.name });
  if (!check.ok) return problem(400, 'DDP-RECON-001', check.message);

  let parsed;
  try {
    parsed = await parseStatement({
      bytes: new Uint8Array(await file.arrayBuffer()), type: file.type, name: file.name,
    });
  } catch (err) {
    await reportError(env, err?.code ?? 'DDP-RECON-001', err, ctx);
    return problem(422, err?.code ?? 'DDP-RECON-001',
      err?.code === 'DDP-RECON-007'
        ? 'That PDF has no readable text — it is probably a scan. Download the statement as CSV instead.'
        : 'That statement could not be read. Download it as CSV and try again.');
  }

  const { credits, warnings } = parsed;
  const now = new Date().toISOString();
  const total = Math.round(credits.reduce((t, c) => t + c.amount, 0) * 100) / 100;

  const created = await env.DB.prepare(
    `INSERT INTO statement_sessions (created_by, filename, row_count, credit_total, status, created_at)
     VALUES (?, ?, ?, ?, 'open', ?) RETURNING id`
  ).bind(session.actor.id, String(file.name ?? '').slice(0, 120), credits.length, total, now).first();

  // Chunked: a year's statement is a few hundred rows and D1 batches are finite.
  for (let i = 0; i < credits.length; i += 50) {
    await env.DB.batch(credits.slice(i, i + 50).map((c) =>
      env.DB.prepare(
        'INSERT INTO statement_credits (session_id, txn_date, amount, reference, narration) VALUES (?, ?, ?, ?, ?)'
      ).bind(created.id, c.date, c.amount, c.reference, String(c.narration ?? '').slice(0, 300))));
  }

  const report = await reportFor(env, created.id);
  await audit(env, session, 'statement.upload',
    { sessionId: created.id, rows: credits.length, discrepancies: report.discrepancies.length });

  return json({ sessionId: created.id, warnings: warnings ?? [], ...report }, { status: 201 });
}

async function statementReport(env, path) {
  const id = Number(path.split('/')[4]);
  const row = await env.DB.prepare('SELECT id, status, filename, created_at FROM statement_sessions WHERE id = ?')
    .bind(id).first();
  if (!row) return problem(404, 'DDP-RECON-001', 'That reconciliation could not be found.');
  if (row.status !== 'open') {
    return problem(409, 'DDP-RECON-001', 'That reconciliation is closed — the statement has been deleted.');
  }
  return json({ sessionId: id, filename: row.filename, ...(await reportFor(env, id)) });
}

/**
 * Save the verdicts, then delete the statement.
 *
 * Order matters and is the opposite of the proof upload: there, the row is
 * written before the object so nothing is orphaned. Here the verdicts are
 * written before the credits are deleted, so that we never destroy the
 * statement and lose the conclusions drawn from it in the same breath.
 */
async function finishStatement(env, session, path) {
  const id = Number(path.split('/')[4]);
  const row = await env.DB.prepare('SELECT id, status FROM statement_sessions WHERE id = ?').bind(id).first();
  if (!row) return problem(404, 'DDP-RECON-001', 'That reconciliation could not be found.');
  if (row.status !== 'open') return problem(409, 'DDP-RECON-001', 'That reconciliation is already closed.');

  const report = await reportFor(env, id);
  const now = new Date().toISOString();

  const rows = [
    ...report.confirmed.map((c) => ({
      proofId: c.proofId, billId: c.billId, verdict: 'confirmed',
      reference: c.reference, amount: c.amount, txnDate: c.txnDate, matchedBy: c.how,
    })),
    ...report.discrepancies.map((d) => ({
      proofId: d.proofId ?? null, billId: d.billId ?? null, verdict: d.kind,
      // Narration is deliberately not carried across: it names other members.
      reference: d.reference ?? null,
      amount: d.bankAmount ?? d.amount ?? null,
      txnDate: d.txnDate ?? null, matchedBy: null,
    })),
  ];

  for (let i = 0; i < rows.length; i += 50) {
    await env.DB.batch(rows.slice(i, i + 50).map((r) =>
      env.DB.prepare(
        `INSERT INTO reconciliations (session_id, proof_id, bill_id, verdict, reference, amount, txn_date, matched_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, r.proofId, r.billId, r.verdict, r.reference, r.amount, r.txnDate, r.matchedBy, now)));
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM statement_credits WHERE session_id = ?').bind(id),
    env.DB.prepare("UPDATE statement_sessions SET status = 'finished', finished_at = ? WHERE id = ?").bind(now, id),
  ]);

  // The whole promise of this feature is that the statement goes away. Check it
  // actually did rather than trusting the DELETE, and shout if it did not.
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM statement_credits WHERE session_id = ?')
    .bind(id).first();
  if ((left?.n ?? 0) > 0) {
    await reportError(env, 'DDP-RECON-008', { sessionId: id, remaining: left.n });
    return problem(500, 'DDP-RECON-008', 'The verdicts were saved but the statement did not delete. The treasurer has been alerted.');
  }

  for (const [kind, code] of Object.entries({
    proof_no_credit: 'DDP-RECON-003',
    credit_no_proof: 'DDP-RECON-004',
    amount_mismatch: 'DDP-RECON-005',
  })) {
    const n = report.totals.byKind[kind];
    if (n) await reportError(env, code, { sessionId: id, count: n });
  }

  await audit(env, session, 'statement.finish',
    { sessionId: id, saved: rows.length, deletedRows: report.totals.creditRows });

  return json({ sessionId: id, saved: rows.length, statementDeleted: true, totals: report.totals });
}

async function discardStatement(env, session, path) {
  const id = Number(path.split('/')[4]);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM statement_credits WHERE session_id = ?').bind(id),
    env.DB.prepare("UPDATE statement_sessions SET status = 'discarded', finished_at = ? WHERE id = ? AND status = 'open'")
      .bind(now, id),
  ]);
  await audit(env, session, 'statement.discard', { sessionId: id });
  return json({ sessionId: id, statementDeleted: true, saved: 0 });
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
      // Rejection returns the bill to 'unpaid' (B13). It used to return it to
      // 'initiated', which the cron held rather than charged — so a resident
      // whose screenshot was rejected once became permanently immune to the
      // late fee, and the more clearly wrong the screenshot, the longer the
      // protection lasted.
      //
      // A rejected proof is the treasurer saying this payment was not found.
      // The bill is overdue and is charged like any other; where that is harsh
      // — a genuine payment with a bad screenshot — the treasurer has the
      // waive button that B14 put next to it.
      //
      // claimed_at is deliberately left alone. Their week of hold already ran;
      // clearing it would hand out a fresh one for each rejected attempt.
      : env.DB.prepare("UPDATE bills SET status = 'unpaid' WHERE id = ?").bind(proof.bill_id),
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

/**
 * Take a flat out of billing, or put it back.
 *
 * WHAT THIS IS FOR, and what it is not. `flats.active` has been in the schema
 * since 0001 and read by the reading grid all along, but nothing could ever
 * set it — so every flat was billable for ever, and a month could not close
 * until all 99 had a reading. That is wrong for the flats nobody has bought:
 * they consumed nothing because there is nobody there and, per the brochure,
 * possibly no gas connection at all.
 *
 * It is NOT for a flat that is merely empty this month. An owned flat that
 * burned nothing bills at zero — the meter genuinely did not move — and stays
 * on the roll where somebody is accountable for it. Excluding it would hide a
 * real home. The screen says so at the point of the decision rather than here,
 * because that is where somebody is choosing.
 *
 * ADMIN, not superadmin — Sabarish's call, 2026-08-12. The admins walk the
 * building and are the ones who know 12F is still unsold.
 *
 * A reason is required. An excluded flat is invisible by construction: it
 * vanishes from the grid AND lowers the count generation demands, so nothing
 * about a closed month hints that a flat was left out of it. "Why has 12F not
 * been billed since August" needs an answer that outlives the committee that
 * decided it — the same argument B14 makes for late-fee exemptions.
 */
async function patchFlat(request, env, session, path) {
  const flat = decodeURIComponent(path.split('/')[4] ?? '').toUpperCase();
  const body = await readJson(request);
  const active = body?.active ? 1 : 0;
  const reason = checkReason('flat.active', body?.reason);

  const row = await env.DB.prepare('SELECT flat, active FROM flats WHERE flat = ?')
    .bind(flat).first();
  if (!row) return problem(404, 'DDP-ADMIN-009', 'That flat is not part of this building.');
  if (row.active === active) {
    // Not an error worth logging, but not a silent success either: replying OK
    // to a no-op writes an audit row claiming a change that did not happen.
    return problem(409, 'DDP-ADMIN-010',
      active ? 'That flat is already being billed.' : 'That flat is already excluded.');
  }

  // Refused while the month is open and already has a reading for it, because
  // the reading and the exclusion contradict each other and the grid would
  // simply stop showing the disagreement.
  if (!active) {
    const reading = await env.DB.prepare(
      `SELECT r.period FROM readings r JOIN periods p ON p.period = r.period
        WHERE r.flat = ? AND p.status = 'open' LIMIT 1`
    ).bind(flat).first();
    if (reading) {
      return problem(409, 'DDP-BILL-001',
        `${flat} has a reading entered for ${reading.period}. Clear it first, or `
        + 'leave the flat billed and enter the same reading as last month, which '
        + 'bills it at zero.');
    }
  }

  await env.DB.prepare('UPDATE flats SET active = ? WHERE flat = ?').bind(active, flat).run();
  await audit(env, session, 'flat.active', { flat, from: row.active, to: active, reason });

  return json({ flat, active: Boolean(active), reason });
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
  // A rate that moved is not a fault. It used to raise DDP-BILL-011 into the
  // error log, which put an ordinary monthly business event in the same list
  // as genuine failures — and would have pushed a Telegram alert once the
  // digest exists. The rate still lands in the audit log via period.open,
  // which is where "what did the treasurer set, and when" belongs.
  await audit(env, session, 'period.open', result);
  return json(result, { status: 201 });
}

/**
 * Change the rate on a month that may already have bills in it.
 *
 * Two different refusals, and they mean different things. A locked month is not
 * "you may not" — it is "not from here": the message names who decides, because
 * the consequence (every bill recalculated, paid residents asked to pay again,
 * a reconciled month reopened) is not the treasurer's call to make alone.
 */
async function patchPeriodRate(request, env, session, path) {
  const period = decodeURIComponent(path.split('/')[4] ?? '');
  const body = await readJson(request);
  const dryRun = body?.dryRun === true;

  let result;
  try {
    result = await changeRate(env, {
      period, ratePerKg: Number(body?.ratePerKg), reason: body?.reason,
      actorId: session.actor.id, dryRun,
    });
  } catch (err) {
    if (err?.code === 'DDP-BILL-012') {
      await reportError(env, 'DDP-BILL-012', { period, actor: session.actor.id });
      return problem(409, 'DDP-BILL-012',
        `${periodName(period)} is locked, so the rate cannot be changed here. `
        + 'Reach out to Sabarish to make this change. Reopening a locked month recalculates '
        + 'every bill in it, means residents who have already paid will need to pay again, '
        + 'and the month has to be reconciled against the bank statement a second time.');
    }
    if (err?.code === 'DDP-ADMIN-011') {
      return problem(400, 'DDP-ADMIN-011', 'Give a reason for changing the rate.');
    }
    throw err;
  }

  if (dryRun) return json(result);

  // Not an error so much as a thing that must never happen quietly.
  if (result.totals.billsAffected > 0) {
    await reportError(env, 'DDP-BILL-013', {
      period, from: result.from, to: result.to,
      affected: result.totals.billsAffected, owesAgain: result.totals.owesAgainCount,
      actor: session.actor.id,
    });
  }
  await audit(env, session, 'period.rate-change', {
    period, from: result.from, to: result.to, reason: result.reason, totals: result.totals,
  });
  return json(result);
}

/** '2026-07' -> 'July 2026', for messages the treasurer reads. */
function periodName(period) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                  'August', 'September', 'October', 'November', 'December'];
  const [y, m] = String(period).split('-');
  return months[Number(m) - 1] ? `${months[Number(m) - 1]} ${y}` : period;
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
    const clash = await duplicateContact(env, id, field, value);
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

/**
 * The same self-checks the CLI runs, from inside god mode.
 *
 * Deliberately the same module: two implementations of "is this healthy"
 * eventually disagree, and the one nobody is looking at is the correct one.
 */
async function godDiagnostics(env, url) {
  const [owners, flats, bills, periods, readings, proofs, errors, digest, demo, backup] =
    await Promise.all([
    env.DB.prepare(`SELECT id, flat, name, mobile, email, role, active, relationship,
                           late_fee_exempt_until, late_fee_exempt_reason FROM owners`).all(),
    env.DB.prepare('SELECT flat, floor, active FROM flats').all(),
    env.DB.prepare(`SELECT id, flat, period, owner_id, gas_amount, other_charges,
                           additional_charges, late_fee, total, status, manual_total,
                           adjust_reason FROM bills`).all(),
    env.DB.prepare('SELECT period, rate_per_kg, conversion_factor, status FROM periods').all(),
    env.DB.prepare('SELECT flat, period, reading FROM readings').all(),
    env.DB.prepare('SELECT id, bill_id, owner_id FROM payment_proofs').all(),
    env.DB.prepare('SELECT code, severity, at FROM error_log ORDER BY id DESC LIMIT 25').all(),
    env.DB.prepare("SELECT value FROM settings WHERE key = 'last_digest_at'").first(),
    env.DB.prepare("SELECT value FROM settings WHERE key = 'demo_seed_ids'").first(),
    env.DB.prepare("SELECT value FROM settings WHERE key = 'last_backup_at'").first(),
  ]);

  const data = {
    owners: owners.results ?? [], flats: flats.results ?? [], bills: bills.results ?? [],
    periods: periods.results ?? [], readings: readings.results ?? [], proofs: proofs.results ?? [],
    lastDigestAt: digest?.value ?? null,
    demoMarker: demo?.value ?? null,
    lastBackupAt: backup?.value ?? null,
    config: {
      upiVpa: env.UPI_VPA, alertingConfigured: Boolean(env.TELEGRAM_BOT_TOKEN),
      mailConfigured: mailConfigured(env),
      driveConfigured: driveConfigured(env),
      committeeShared: committeeFolderSeparate(env), remote: true,
    },
  };

  const findings = runChecks(data);
  const recent = (errors.results ?? []).map((e) => ({
    ...e, atIST: toIST(e.at), message: ERROR_CODES[e.code]?.message ?? '',
  }));
  const meta = {
    environment: 'production',
    generatedAt: new Date().toISOString(),
    counts: {
      residents: data.owners.length, flats: data.flats.length, bills: data.bills.length,
      readings: data.readings.length, months: data.periods.length,
    },
  };

  // The markdown is built server-side so the page has nothing to assemble and
  // the CLI and the Copy button produce a byte-identical report.
  return json({
    findings, summary: summarise(findings), errors: recent, meta,
    markdown: url.searchParams.get('md') === '1'
      ? toMarkdown({ findings, errors: recent, meta })
      : undefined,
  });
}

/* ── self-service password reset ──────────────────────────────────────────
   The ONLY route for a resident since 2026-08-12, and the reason admins no
   longer reset passwords: a reset mints a credential, so whoever performs one
   can log in as that resident. Anybody with no address on file falls back to
   the superadmin, who is the one person for whom that is not an escalation. */

/**
 * "I forgot my password."
 *
 * Answers identically whether or not the account exists. Anything else turns
 * this into a directory: try a mobile number, and a different reply tells you
 * whether that person lives in the building.
 *
 * Every branch below therefore returns the SAME shape. The differences are
 * recorded in error_log, where only the committee can see them.
 */
async function forgotPassword(request, env, ctx) {
  const body = await readJson(request);

  let mobile;
  try {
    mobile = normaliseMobile(body?.mobile);
  } catch {
    return json(neutralReply());           // not even a hint that it parsed
  }

  const owner = await env.DB.prepare(
    'SELECT id, name, flat, email FROM owners WHERE mobile = ? AND active = 1'
  ).bind(mobile).first();

  if (!owner) {
    await reportError(env, 'DDP-AUTH-006', { mobile }, ctx);
    return json(neutralReply());
  }

  if (!owner.email) {
    // Worth an alert rather than a shrug: a resident is stuck and will phone
    // somebody, and the fix is for an admin to add their address.
    await reportError(env, 'DDP-AUTH-011', { flat: owner.flat, ownerId: owner.id }, ctx);
    return json(neutralReply());
  }

  const recent = await env.DB.prepare(
    'SELECT created_at FROM password_resets WHERE owner_id = ? ORDER BY created_at'
  ).bind(owner.id).all();

  const allowed = canIssue(recent.results ?? []);
  if (!allowed.ok) {
    await reportError(env, 'DDP-AUTH-010', { flat: owner.flat, ownerId: owner.id }, ctx);
    return json(neutralReply());
  }

  const code = generateCode();
  const { hash, salt, iterations } = await hashPassword(code, ITER(env));
  const now = new Date();

  await env.DB.prepare(
    `INSERT INTO password_resets
       (owner_id, code_hash, code_salt, code_iterations, sent_to, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(owner.id, hash, salt, iterations, owner.email,
         expiryFrom(now), now.toISOString()).run();

  const { subject, text } = resetEmail({ code, name: owner.name, flat: owner.flat });
  const result = await sendEmail(env, { to: owner.email, subject, text });

  if (!result.sent) {
    // The resident is told the same thing either way, so this row is the only
    // place the failure exists. Without it the whole feature could be dead and
    // look perfectly healthy from outside.
    await reportError(env, 'DDP-MAIL-001',
                      { flat: owner.flat, reason: result.reason }, ctx);
  }

  await audit(env, { actor: { id: owner.id }, subject: { id: owner.id } },
              'password.reset.requested', { flat: owner.flat, delivered: result.sent });

  return json(neutralReply());
}

/** "Here is the code, here is my new password." */
async function resetWithCode(request, env, ctx) {
  const body = await readJson(request);

  let mobile;
  try {
    mobile = normaliseMobile(body?.mobile);
  } catch {
    return problem(400, 'DDP-AUTH-009', 'That code is not right, or it has expired.');
  }
  const code = normaliseCode(body?.code);
  const password = String(body?.password ?? '');

  const owner = await env.DB.prepare(
    'SELECT id, flat, name, mobile, email, role FROM owners WHERE mobile = ? AND active = 1'
  ).bind(mobile).first();

  // Same reply as a wrong code. An unknown number must not be distinguishable
  // here either, or this endpoint becomes the directory the other one is not.
  if (!owner) {
    await reportError(env, 'DDP-AUTH-009', { mobile, reason: 'no-account' }, ctx);
    return problem(400, 'DDP-AUTH-009', failureMessage('none'));
  }

  const row = await env.DB.prepare(
    `SELECT * FROM password_resets WHERE owner_id = ?
      ORDER BY created_at DESC LIMIT 1`
  ).bind(owner.id).first();

  const state = resetState(row);
  if (!state.usable) {
    await reportError(env, 'DDP-AUTH-009', { flat: owner.flat, reason: state.reason }, ctx);
    return problem(400, 'DDP-AUTH-009', failureMessage(state.reason));
  }

  // The count this code was issued at: a deploy that raises the target must
  // not invalidate codes already sitting in residents' inboxes.
  const ok = await verifyPassword(code, row.code_hash, row.code_salt, row.code_iterations);
  if (!ok) {
    // Counted BEFORE replying, so a client that gives up mid-request still
    // spends the attempt. Otherwise the limit is bypassed by disconnecting.
    await env.DB.prepare('UPDATE password_resets SET attempts = attempts + 1 WHERE id = ?')
      .bind(row.id).run();
    await reportError(env, 'DDP-AUTH-009', { flat: owner.flat, reason: 'wrong' }, ctx);
    return problem(400, 'DDP-AUTH-009', failureMessage('wrong', state.remaining - 1));
  }

  // Checked HERE, not on the way in, and the ordering is the whole point.
  //
  // The policy needs the owner row to refuse a password built from their own
  // name — but the moment a policy refusal can be triggered before the code is
  // verified, this endpoint answers "does this mobile have an account?": a
  // known number would return DDP-AUTH-008 where an unknown one returns
  // DDP-AUTH-009. That is precisely the directory the neutral replies above
  // exist to deny. Behind a verified code there is nothing left to leak —
  // whoever got this far already holds the account.
  validateNewPassword(password, owner);   // throws DDP-AUTH-008/012/013/014

  const { hash, salt, iterations } = await hashPassword(password, ITER(env));
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE owners SET pw_hash = ?, pw_salt = ?, pw_iterations = ?, must_change_pw = 0,
              pw_expires_at = NULL
        WHERE id = ?`
    ).bind(hash, salt, iterations, owner.id),
    // Single use, marked in the same batch as the password change so the two
    // cannot come apart and leave a spent code still live.
    env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').bind(now, row.id),
    // Any other code outstanding for this account dies with it.
    env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE owner_id = ? AND used_at IS NULL')
      .bind(now, owner.id),
  ]);

  // A forgotten password and a stolen one look identical from here.
  await destroyAllSessionsFor(env, owner.id);
  await audit(env, { actor: { id: owner.id }, subject: { id: owner.id } },
              'password.reset.completed', { flat: owner.flat });

  return json({ ok: true, message: 'Password changed. You can log in now.' });
}

/* ── roster import ────────────────────────────────────────────────────────
   One paste for the whole building. Nothing is written until a preview has
   been read: a wrong mobile is a resident who can never log in, and a
   duplicated flat is somebody billed twice.                                */

async function rosterPreview(request, env) {
  const body = await readJson(request);
  const [flats, people] = await Promise.all([
    env.DB.prepare('SELECT flat FROM flats').all(),
    env.DB.prepare('SELECT flat, name, mobile, relationship, active FROM owners').all(),
  ]);

  const { rows, detectedHeader, columns } = parseRoster(body?.text ?? '');
  const preview = previewRoster(rows, {
    existingFlats: (flats.results ?? []).map((f) => f.flat),
    existingPeople: people.results ?? [],
  });

  return json({ ...preview, detectedHeader, columns, building: floorSummary() });
}

async function rosterImport(request, env, session) {
  const body = await readJson(request);
  const [flats, people] = await Promise.all([
    env.DB.prepare('SELECT flat FROM flats').all(),
    env.DB.prepare('SELECT flat, name, mobile, relationship, active FROM owners').all(),
  ]);

  // Re-run the preview server-side rather than trusting the client's copy.
  // The browser has already seen this, but "what was approved" and "what gets
  // written" must be decided by the same code reading the same database.
  const { rows } = parseRoster(body?.text ?? '');
  const preview = previewRoster(rows, {
    existingFlats: (flats.results ?? []).map((f) => f.flat),
    existingPeople: people.results ?? [],
  });

  if (!preview.canImport) {
    return problem(409, 'DDP-ADMIN-003',
      `${preview.blocked.length} rows cannot be imported. Fix them and paste again.`);
  }

  const created = [];
  const now = new Date().toISOString();

  for (const row of preview.create) {
    await addFlat(env, row.flat, row.floor);
    if (row.vacant) continue;

    const otp = generateOneTimePassword();
    const { hash, salt, iterations } = await hashPassword(otp, ITER(env));
    const inserted = await env.DB.prepare(
      `INSERT INTO owners (flat, name, mobile, email, pw_hash, pw_salt, pw_iterations,
                           must_change_pw, pw_expires_at, role, relationship, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'owner', ?, ?) RETURNING id`
    ).bind(row.flat, row.name, row.mobile, row.email, hash, salt, iterations,
           tempPasswordExpiry(INVITE_PW_HOURS), row.relationship, now).first();

    const text =
      `Diamond Park gas portal: your login for flat ${row.flat}\n` +
      `Mobile: ${row.mobile}\nTemporary password: ${otp}\n` +
      'Log in at https://diamondpark.pages.dev and choose your own password.';

    created.push({
      id: inserted.id, flat: row.flat, name: row.name, mobile: row.mobile,
      relationship: row.relationship, oneTimePassword: otp, whatsapp: waLink(row.mobile, text),
    });
  }

  await audit(env, session, 'roster.import', {
    flats: preview.counts.flats, people: created.length, vacant: preview.counts.vacant,
  });

  return json({ created, counts: preview.counts, warnings: preview.warnings }, { status: 201 });
}

/** Who has been sent their login, and who has actually used it. */
async function rosterStatus(env) {
  const r = await env.DB.prepare(
    `SELECT id, flat, name, mobile, relationship, invited_at, must_change_pw, active
       FROM owners WHERE active = 1 ORDER BY CAST(flat AS INTEGER), flat`
  ).all();

  const people = (r.results ?? []).map((p) => ({
    ...p,
    // Three states, and the middle one is why this exists: "sent and ignored"
    // is a different problem from "never contacted".
    state: !p.must_change_pw ? 'logged-in' : p.invited_at ? 'sent' : 'not-sent',
  }));

  return json({
    people,
    counts: {
      total: people.length,
      loggedIn: people.filter((p) => p.state === 'logged-in').length,
      sent: people.filter((p) => p.state === 'sent').length,
      notSent: people.filter((p) => p.state === 'not-sent').length,
    },
  });
}

/** Mark a login as sent. Called when the admin opens the WhatsApp link. */
async function rosterMarkSent(request, env, session, path) {
  const id = Number(path.split('/').pop());
  await env.DB.prepare('UPDATE owners SET invited_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), id).run();
  await audit(env, session, 'roster.invited', { ownerId: id });
  return json({ ok: true });
}

/* ── late fees: exemptions, and the bills that carry one ─────────────────── */

/**
 * Every bill with a late fee on it, plus every active exemption.
 *
 * One screen because they are the same question asked twice: who is being
 * charged, and who has been let off. Splitting them across two pages is how a
 * standing exemption stops being noticed.
 */
async function lateFeePanel(env) {
  const [charged, exempt] = await Promise.all([
    env.DB.prepare(
      `SELECT b.id, b.flat, b.period, b.total, b.late_fee, b.status, b.late_fee_at,
              o.name AS owner_name
         FROM bills b LEFT JOIN owners o ON o.id = b.owner_id
        WHERE b.late_fee > 0 ORDER BY b.period DESC, b.flat`
    ).all(),
    env.DB.prepare(
      `SELECT id, flat, name, relationship, late_fee_exempt_until, late_fee_exempt_reason
         FROM owners
        WHERE active = 1 AND late_fee_exempt_until IS NOT NULL
        ORDER BY late_fee_exempt_until`
    ).all(),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  return json({
    charged: charged.results ?? [],
    exempt: (exempt.results ?? []).map((e) => ({
      ...e,
      // An expired exemption is shown rather than hidden: it explains why
      // somebody was not charged last month and is charged this month.
      active: isExempt(e.late_fee_exempt_until, today),
    })),
    today,
  });
}

/** Grant, change or clear an exemption. */
async function setLateFeeExemption(request, env, session, path) {
  const id = Number(path.split('/')[4]);
  const body = await readJson(request);

  const target = await env.DB.prepare('SELECT id, flat, name FROM owners WHERE id = ?')
    .bind(id).first();
  if (!target) return problem(404, 'DDP-ADMIN-001', 'No such resident.');

  const until = String(body?.until ?? '').trim() || null;
  const reason = String(body?.reason ?? '').trim() || null;

  if (until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      return problem(400, 'DDP-ADMIN-003', 'Give the end date as YYYY-MM-DD.');
    }
    // A reason is required precisely because the committee changes. A date
    // with nothing against it is the same forgotten policy one step later.
    if (!reason || reason.length < 3) {
      return problem(400, 'DDP-ADMIN-003', 'Say why. Whoever inherits this will need to know.');
    }
    if (until < new Date().toISOString().slice(0, 10)) {
      return problem(400, 'DDP-ADMIN-003', 'That date has already passed.');
    }
  }

  await env.DB.prepare(
    'UPDATE owners SET late_fee_exempt_until = ?, late_fee_exempt_reason = ? WHERE id = ?'
  ).bind(until, until ? reason : null, id).run();

  await audit(env, session, until ? 'late-fee.exempt' : 'late-fee.exempt.clear',
              { ownerId: id, flat: target.flat, name: target.name, until, reason });

  return json({ ok: true, until, reason });
}

/**
 * Exempt a group of flats at once.
 *
 * Bulk exists because the reason is almost always about the building rather
 * than the person — a supply outage, a meter fault, a month billed late — and
 * doing that one resident at a time invites stopping halfway.
 *
 * `dryRun` first, always, from the UI. Applying an exemption to 99 people by
 * mistyping "all" is reversible but embarrassing, and the preview costs one
 * round trip.
 */
async function bulkLateFeeExemption(request, env, session) {
  const body = await readJson(request);
  const today = new Date().toISOString().slice(0, 10);

  const people = await env.DB.prepare(
    `SELECT id, flat, name, relationship, active,
            late_fee_exempt_until, late_fee_exempt_reason
       FROM owners`
  ).all();

  const resolved = resolveExemptionTargets(body?.flats ?? '', people.results ?? [], { today });

  if (body?.dryRun) return json({ ...resolved, dryRun: true });

  const until = String(body?.until ?? '').trim();
  const reason = String(body?.reason ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    return problem(400, 'DDP-ADMIN-003', 'Give the end date as YYYY-MM-DD.');
  }
  if (reason.length < 3) {
    return problem(400, 'DDP-ADMIN-003', 'Say why. Whoever inherits this will need to know.');
  }
  if (until < today) return problem(400, 'DDP-ADMIN-003', 'That date has already passed.');

  // An unresolvable flat stops the whole thing rather than exempting the rest:
  // a half-applied outage waiver is worse than none, because nobody can tell
  // which half it was.
  if (!resolved.ok) {
    return problem(409, 'DDP-ADMIN-003', resolved.unknown.length
      ? `${resolved.unknown[0].flat}: ${resolved.unknown[0].reason}`
      : 'Nothing to exempt.');
  }

  await env.DB.batch(resolved.targets.map((t) =>
    env.DB.prepare(
      'UPDATE owners SET late_fee_exempt_until = ?, late_fee_exempt_reason = ? WHERE id = ?'
    ).bind(until, reason, t.id)));

  await audit(env, session, 'late-fee.exempt.bulk', {
    flats: resolved.targets.map((t) => t.flat), count: resolved.targets.length,
    until, reason, everyone: resolved.everyone,
  });

  return json({ exempted: resolved.targets, count: resolved.targets.length, until, reason });
}
