/**
 * DD Diamond Park portal — Worker entry.
 * Phase 1 + 1b: auth, sessions, roles, audit, god mode, error reporting.
 * Billing, payments and proofs land in phases 3–6.
 */

import { json, problem, readJson, audit, rateLimit, clearRateLimit, guard, withSecurityHeaders } from './lib/http.js';
import { reportError, assertAlerting, postToTelegram, requestContextFor, describeDevice } from './lib/errors.js';
import { signedInPeople, loginsToday, tokensToRevoke, PRESENCE_KINDS, LEAVE_GRACE_MS } from './lib/presence.js';
import { hashPassword, verifyPassword, generateOneTimePassword, sha256Hex, derive,
         DEFAULT_ITERATIONS } from './lib/crypto.js';
import { billDetailPayload, paySheetPayload, resolveBill } from './lib/bill-view.js';
import {
  SETTLED_STATUSES, isQuarterLabel, dueDateFor, describeQuarter, flatVotingStatus,
} from './lib/maint.js';
import { maintAdminPayload, duesReport, adminHomeCard } from './lib/maint-admin.js';
import {
  ADVANCE_KIND, recordAdvanceRequest, applyAdvanceRequest,
  advanceRequestEmail, advanceDecisionEmail,
} from './lib/maint-approvals.js';
import { scheduleQuarter, previewLetter, revertBillsSettledByAdvance } from './lib/maint-cron.js';
import { dashboardPayload } from './lib/dashboard.js';
import { billPdf, istSlashDate } from './lib/bill-pdf.js';
// The Worker's own date label — the browser's lives in js/i18n.js.
import { dayAndMonth } from './lib/reminders.js';
import { ASSOCIATION, billFileName } from '../public/js/association.js';
import {
  readingGrid, saveReadings, generateBills, openPeriod, parseReadings,
  previousPeriod, jumpWarning, changeRate, planRateChange, normaliseFlat,
} from './lib/admin.js';
import { previewGeneration, computeBill, isExempt, DEFAULT_CONVERSION } from './lib/billing.js';
import {
  publishBills, drainAnnouncements, announcementCounts, unreachableFlats,
} from './lib/announce.js';
import {
  planReadingCorrection, priceCorrectionTotals, READING_FIELD, PRICE_FIELD,
} from './lib/corrections.js';
import { latestEndedPeriod, boardStage, daysOverdue, tallyByStatus } from './lib/summary.js';
import { istToday } from './lib/time.js';
import { reminderDecision, batchDecision, reminderEmail, periodLabel, MAX_REMINDERS }
  from './lib/reminders.js';
import {
  approvalPolicy, canApprove, isSatisfied, needsApproval, expiresAt, approvalMessage,
} from './lib/approvals.js';
import { validateUpload, assessProof, shapeQueue, r2Key, proofBucket } from './lib/proof.js';
import { validateStatement, parseStatement, reconcile, bucketReconciliation, sweepAbandonedStatements } from './lib/statement.js';
import { maintAccountHint } from './lib/upi.js';
import { describeDeparture, departureInputs } from './lib/tenancy-change.js';
import { votingBlockedFlats, votingStatusFor, votingStatuses } from './lib/voting.js';
import { readReceipt, visionAvailable } from './lib/vision.js';
import { runScheduled, runLateFees, isLateFeeCron, applyLateFees, staleIntents } from './lib/cron.js';
import { listPolls, getPoll, createPoll, castVote, closePoll, publishPoll, unpublishPoll,
         updatePoll, getBallot, queuePollMail, canManagePoll, canSeePoll } from './lib/polls.js';
import { listNotices, getNotice, addComment, setCommentHidden, markNoticesSeen, NOTICE_SCOPES,
         canSeeAttachment, listArchivedNotices, purgeNotice,
         isCommittee, canManageNotice } from './lib/notices.js';
// r2Key is aliased: lib/proof.js exports one of its own, and the two build
// different key shapes for different buckets' worth of rules.
import { validateAttachment, validateThumb, safeFilename, r2Key as attachmentKey, assertRoom,
         isLargeUpload, MAX_PER_NOTICE, MAX_PER_COMMENT } from './lib/attachments.js';
import { submitMessage, fingerprintOf, AMENITIES, OFFICE_HOURS, MESSAGE_SUBJECTS, CONTACT } from './lib/public.js';
import {
  transferFlat, canChangeRole, canResetPassword, canEditResident, canEditField, waLink,
  roleAsSeenBy,
  planHandover, outstandingFor,
  mergeTimeline, toIST, isRelationship, occupantOf, landlordOf, isTenanted,
  householdIds, roomFor, successorFor,
  billAccess, describeRelationship, ADMINISTRATOR,
  planOccupancy, contactClash,
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
  dayRange, windowStart, mergeDaily, weekHeat, deviceSplit, reachOf, topList,
  adoptionCurve, seriesByKey, funnelOf, summarise as summariseWindow,
} from './lib/analytics.js';
import {
  generateCode, normaliseCode, expiryFrom, canIssue, resetState, failureMessage,
  validateNewPassword, resetEmail, neutralReply,
  tempPasswordState, expiredPasswordMessage, tempPasswordExpiry, tempPasswordEmail,
  TEMP_PW_HOURS, INVITE_PW_HOURS, refuseCurrentPassword, refusePastPassword,
  HISTORY_DEPTH, generateLinkToken, linkHash, resetLinkUrl,
} from './lib/reset.js';
import { sendEmail, mailConfigured } from './lib/mailer.js';
import { parseRoster, previewRoster, resolveExemptionTargets } from './lib/roster.js';
import { floorSummary, whyNot } from './lib/building.js';
import { splitMobile, NATIONAL_LENGTHS } from '../public/js/countries.js';
import { addFlatStatement } from './lib/flats.js';
import { ERROR_CODES } from './lib/error-codes.js';
import { isCaptureOn, captureWindow, validateBatch } from './lib/clicks.js';
import { runBackup, backupHealth, driveConfigured, committeeFolderSeparate, isBackupCron, pruneOldRows, dumpTable, dumpAll, bundle, toCsv, TABLES } from './lib/backup.js';
import {
  createSession, resolveSession, destroySession, destroyAllSessionsFor,
  cookieHeader, clearCookieHeader, hasRole, committeeMayUse,
  forcedChangeRefuses, impersonationRefuses,
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

    // Who, from what, on which route — for any alert this request raises.
    //
    // A per-request child of env, not a module variable: one isolate serves
    // many requests at once, and a shared slot would print one resident's flat
    // on another resident's crash. Every reportError already receives this
    // env, so all of them carry it without a single call site changing, and
    // Object.create leaves each binding reachable through the prototype.
    const requestContext = requestContextFor(request);
    env = Object.create(env, { requestContext: { value: requestContext } });

    return withSecurityHeaders(await guard(env, ctx, async () => {
      const session = await resolveSession(env, request);
      requestContext.session = session;
      const route = `${request.method} ${path}`;

      // ── public ────────────────────────────────────────────────────────
      if (route === 'POST /api/login') return login(request, env, ctx);
      if (route === 'POST /api/forgot') return forgotPassword(request, env, ctx);
      if (route === 'POST /api/reset') return resetWithCode(request, env, ctx);
      // GET, and it spends nothing — see resetLinkState. A scanner that
      // fetches the link out of the inbox must not consume the reset.
      if (route === 'GET /api/reset/link') return resetLinkState(request, env, ctx);
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

      // Both before any route below, so no handler can forget them. See the
      // two functions in session.js for what each lets through and why.
      if (forcedChangeRefuses(session, request.method, path)) {
        return problem(403, 'DDP-AUTH-020', 'Choose your own password first.');
      }
      const refusal = impersonationRefuses(session, request.method, path);
      if (refusal) {
        await reportError(env, 'DDP-AUTH-021',
          { actor: session.actor.id, subject: session.subject.id, mode: session.mode, route });
        return problem(403, 'DDP-AUTH-021', refusal);
      }

      if (route === 'POST /api/logout') return logout(env, session);
      if (route === 'GET /api/me') return me(env, session, request);
      if (route === 'GET /api/me/bill.pdf') return myBillPdf(env, session, request);
      if (route === 'POST /api/password') return changePassword(request, env, session);
      if (route === 'POST /api/onboard') return onboard(request, env, session);
      if (route === 'PATCH /api/me') return patchProfile(request, env, session);
      if (route === 'POST /api/activity') return recordActivity(request, env, session);
      if (route === 'GET /api/capture')   return captureState(env);
      if (route === 'POST /api/clicks')   return recordClicks(request, env, session);
      // One handler for both kinds of bill, and one visibility rule. See
      // lib/bill-view.js for why the URL carries an id and never a kind.
      if (route === 'GET /api/bill') return billDetail(env, session, url);
      if (route === 'GET /api/pay')  return paySheet(env, session, request, url);
      if (request.method === 'POST' && /^\/api\/bills\/\d+\/intent$/.test(path)) {
        return logIntent(env, session, path);
      }
      if (request.method === 'POST' && /^\/api\/maint-bills\/\d+\/intent$/.test(path)) {
        return logMaintIntent(env, session, path);
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
        // The second half is the committee member: they read hidden comments,
        // and they are asked for on the VIEWER, which is the only role that
        // should ever decide a read. The actor-based half is left as it was —
        // narrowing an admin's own reads is a separate argument from adding a
        // role, and quietly settling it here would be the wrong place to.
        const notice = await getNotice(env, Number(path.split('/')[3]),
          { isAdmin: hasRole(session, 'admin') || isCommittee(session.subject),
            viewer: session.subject });
        if (!notice) return problem(404, 'DDP-NOTICE-001', 'That notice could not be found.');
        // Drives whether the page offers Edit and Withdraw. Decided here, from
        // the same function the PATCH route uses, so the buttons cannot appear
        // for somebody the server would then refuse — the client is told the
        // answer rather than working one out from a role it half understands.
        return json({
          ...notice,
          canManage: canManageNotice({ posted_by: notice.postedBy }, session.actor),
        });
      }
      if (request.method === 'POST' && /^\/api\/notices\/\d+\/comments$/.test(path)) {
        return postComment(request, env, session, path);
      }

      // ── polls ─────────────────────────────────────────────────────────
      // Beside the notices, because that is where a resident meets them. A
      // poll is its own object, though — see migrations/0036_polls.sql for why
      // it is not a third notice kind.
      if (route === 'GET /api/polls') {
        return json({ polls: await listPolls(env, session.subject) });
      }
      if (request.method === 'GET' && /^\/api\/polls\/\d+$/.test(path)) {
        const poll = await getPoll(env, Number(path.split('/')[3]), session.subject);
        // Same answer for "not yours to see" as for "does not exist". A tenant
        // probing ids should not be able to learn that an owners-only poll is
        // running from the shape of the refusal.
        if (!poll) return problem(404, 'DDP-POLL-001', 'That poll could not be found.');
        return json({
          ...poll,
          // Told to the client rather than inferred by it, so the manage bar
          // cannot appear for somebody the server would then refuse.
          canManage: canManagePoll({ created_by: poll.createdBy }, session.actor),
          // The ballot route is the superadmin's alone. Said here so the button
          // is never drawn for anybody it would refuse -- an admin used to be
          // offered it on every closed poll and told, on pressing, whose it was.
          canOpenBallot: session.actor.role === 'superadmin',
        });
      }
      if (request.method === 'POST' && /^\/api\/polls\/\d+\/vote$/.test(path)) {
        return castPollVote(request, env, session, path);
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
        // A committee member is not an admin and does not get past this on
        // rank. They get past it on a named route and no other — the list is
        // in session.js, where it can be read whole. Ownership of the notice
        // itself is checked again in the handlers that need the row.
        const committeeRoute =
          session.actor.role === 'committee' && committeeMayUse(request.method, path);
        if (!hasRole(session, 'admin') && !committeeRoute) {
          await reportError(env, 'DDP-ADMIN-004', { path, actor: session.actor.id });
          return problem(403, 'DDP-ADMIN-004', 'Admins only.');
        }
        // The landing screen. One request rather than the five the board would
        // otherwise make on every visit to /admin.
        // ── maintenance ────────────────────────────────────────────────
        if (route === 'GET /api/admin/maint') {
          return json(await maintAdminPayload(env, url.searchParams.get('quarter'), { session }));
        }
        if (route === 'PUT /api/admin/maint/rates') return putMaintRates(request, env, session);
        if (route === 'POST /api/admin/maint/schedule') return postMaintSchedule(request, env, session);
        if (route === 'POST /api/admin/maint/unschedule') return postMaintUnschedule(request, env, session);
        if (route === 'GET /api/admin/maint/voting') return votingOverview(env);
        // Read-only, and it writes nothing — see previewLetter. The flat must
        // be one the quarter would bill, so this exposes nothing the Bills
        // screen does not.
        if (route === 'GET /api/admin/maint/preview') {
          return json(await previewLetter(env, url.searchParams.get('quarter'), {
            flat: url.searchParams.get('flat'),
            kind: url.searchParams.get('kind') || 'issued',
            origin: url.origin,
          }));
        }
        if (route === 'POST /api/admin/maint/voting/exempt') {
          return grantVotingExemption(request, env, session);
        }
        if (request.method === 'POST' && /^\/api\/admin\/maint\/voting\/exempt\/\d+\/approve$/.test(path)) {
          return approveVotingExemption(env, session, path);
        }
        // ── advances ──────────────────────────────────────────────────
        // Recording an advance raises a request; a second admin approves it
        // from the queue below. Withdraw pulls back one's own pending request.
        if (route === 'POST /api/admin/maint/advances') {
          return recordAdvance(request, env, session, url.origin);
        }
        if (request.method === 'POST' && /^\/api\/admin\/maint\/advances\/\d+\/withdraw$/.test(path)) {
          return withdrawAdvance(env, session, path);
        }
        // Cancelling an APPROVED advance (Option B): one admin requests it, a
        // different admin approves, and the approval reopens the settled bill.
        if (request.method === 'POST' && /^\/api\/admin\/maint\/advances\/\d+\/cancel$/.test(path)) {
          return requestAdvanceCancel(request, env, session, path);
        }
        if (request.method === 'POST' && /^\/api\/admin\/maint\/advances\/\d+\/cancel\/(approve|reject)$/.test(path)) {
          return decideAdvanceCancel(env, session, path, path.endsWith('/approve') ? 'approve' : 'reject');
        }
        // The generic decision endpoint: it dispatches by the request's `kind`,
        // and this session implements the `advance` applier only.
        if (request.method === 'POST'
            && /^\/api\/admin\/maint\/approvals\/\d+\/(approve|reject)$/.test(path)) {
          return decideMaintApproval(env, session, path, path.endsWith('/approve') ? 'approve' : 'reject', url.origin);
        }
        if (route === 'POST /api/admin/tenancy/departure/preview') {
          return previewDeparture(request, env);
        }
        if (route === 'POST /api/admin/tenancy/departure') {
          return requestDeparture(request, env, session);
        }
        if (route === 'GET /api/admin/tenancy/departures') {
          return listDepartureRequests(env, session);
        }
        if (request.method === 'POST' && /^\/api\/admin\/tenancy\/departures\/\d+\/(approve|reject)$/.test(path)) {
          return decideDeparture(env, session, path, path.endsWith('/approve') ? 'approve' : 'reject');
        }
        if (route === 'POST /api/admin/maint/tenancy/confirm') {
          return postTenancyConfirm(request, env, session);
        }
        if (route === 'GET /api/admin/dues') return json(await duesReport(env));

        if (route === 'GET /api/admin/summary') return adminSummary(env, session);
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
        // THE ROSTER IS THE SUPERADMIN'S, unlike flat activation next door.
        // Both are "who lives here" knowledge that the admins walking the
        // building hold, and the flats call went the other way on 2026-08-12
        // for exactly that reason. The difference is blast radius: excluding
        // one flat is one reversible row, while an import rewrites the whole
        // directory in a single paste, and a bad one takes every resident's
        // login with it. Sabarish's call, 2026-08-19.
        if (path.startsWith('/api/admin/roster/')) {
          if (!hasRole(session, 'superadmin')) {
            await reportError(env, 'DDP-ADMIN-004', { path, actor: session.actor.id });
            return problem(403, 'DDP-ADMIN-004',
              `Only ${ADMINISTRATOR.name} can change the roster.`);
          }
          if (route === 'POST /api/admin/roster/preview') return rosterPreview(request, env);
          if (route === 'POST /api/admin/roster/import')  return rosterImport(request, env, session);
          if (route === 'GET /api/admin/roster/status')   return rosterStatus(env);
          if (route.startsWith('POST /api/admin/roster/sent/')) {
            return rosterMarkSent(request, env, session, path);
          }
        }
        if (route === 'GET /api/admin/flats') return listFlats(env);
        if (request.method === 'PATCH' && /^\/api\/admin\/flats\/[^/]+$/.test(path)) {
          return patchFlat(request, env, session, path);
        }
        if (request.method === 'PUT' && /^\/api\/admin\/flats\/[^/]+\/occupancy$/.test(path)) {
          return putOccupancy(request, env, session, path);
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
        // Publishing IS generating, plus an outbox — see publishBills. The
        // /generate route stays for the CLI and the tests; nothing in the
        // console calls it any more.
        if (route.startsWith('POST /api/admin/periods/') && path.endsWith('/publish')) {
          return postPublish(request, env, session, path);
        }
        if (route.startsWith('POST /api/admin/periods/') && path.endsWith('/announce')) {
          return postAnnounce(request, env, session, path);
        }
        if (route.startsWith('GET /api/admin/periods/') && path.endsWith('/announcements')) {
          return getAnnouncements(env, path);
        }
        // The month-wide half of the correction rule. A locked month refuses a
        // direct rate change (DDP-BILL-012) and always will; this is the route
        // that goes to two other admins instead.
        if (route.startsWith('POST /api/admin/periods/') && path.endsWith('/price-correction')) {
          return requestPriceCorrection(request, env, session, path);
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
        // ADMINS CORRECT BILLS, because admins are the ones in the building.
        // Editing lived under /api/god/ and so needed the superadmin — who is
        // frequently abroad — for every correction, while the treasurer who
        // generated the bills and takes the phone call could only watch. The
        // approval gate is what makes this safe to open: an admin raising an
        // edit still cannot approve it, and their own flat's bill needs
        // everyone else.
        if (route === 'GET /api/admin/bills') return godBills(env, url);
        if (route.startsWith('PATCH /api/admin/bill/')) {
          return editBill(request, env, session, path);
        }
        // The per-flat half of the correction rule: the corrected READING and
        // the total it produces, never a total somebody chose. Same approval
        // machinery, same two other admins.
        if (request.method === 'POST' && /^\/api\/admin\/bills\/\d+\/reading-correction$/.test(path)) {
          return requestReadingCorrection(request, env, session, path);
        }

        // Approving is an ADMIN action, not a god one — the whole point is that
        // the superadmin who raised the edit cannot also wave it through.
        if (route === 'GET /api/admin/bill-edits') return listBillEditRequests(env, session);
        if (request.method === 'POST' && /^\/api\/admin\/bill-edits\/\d+\/approve$/.test(path)) {
          return decideBillEdit(request, env, session, path, 'approve');
        }
        if (request.method === 'POST' && /^\/api\/admin\/bill-edits\/\d+\/reject$/.test(path)) {
          return decideBillEdit(request, env, session, path, 'reject');
        }
        if (route === 'GET /api/admin/late-fees') return lateFeePanel(env);
        if (route === 'POST /api/admin/late-fee-exemption/bulk') {
          return bulkLateFeeExemption(request, env, session);
        }
        if (request.method === 'POST' && /^\/api\/admin\/residents\/\d+\/late-fee-exemption$/.test(path)) {
          return setLateFeeExemption(request, env, session, path);
        }
        // Chasing. The cap lives in the handler and in the schema, never only
        // in the console — an admin with two tabs open must not be able to
        // send a fourth.
        if (request.method === 'POST' && /^\/api\/admin\/bills\/\d+\/remind$/.test(path)) {
          return remindOne(env, session, Number(path.split('/')[4]));
        }
        if (route === 'POST /api/admin/reminders/bulk') {
          return remindAll(request, env, session);
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
          // `demoData` is what lets the month picker offer months that have not
          // ENDED yet — see selectableMonths in admin-console.js. It is carried
          // here rather than being a setting or a build flag on purpose: the
          // demo rows must come out before the real roster goes in, and that
          // removal is already a command somebody runs and a check doctor
          // reports. Tying the affordance to it means it withdraws itself on
          // the day it stops being safe, instead of relying on anybody
          // remembering a switch.
          const [rows, demo] = await Promise.all([
            env.DB.prepare('SELECT * FROM periods ORDER BY period DESC').all(),
            env.DB.prepare("SELECT value FROM settings WHERE key = 'demo_seed_ids'").first(),
          ]);
          return json({ periods: rows.results ?? [], demoData: Boolean(demo?.value) });
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
        if (route === 'POST /api/admin/notices')  return postNotice(request, env, session, ctx);

        // ── polls ───────────────────────────────────────────────────────
        if (route === 'POST /api/admin/polls') return postPoll(request, env, session, ctx);
        if (request.method === 'PATCH' && /^\/api\/admin\/polls\/\d+$/.test(path)) {
          return patchPoll(request, env, session, path);
        }
        if (request.method === 'POST' && /^\/api\/admin\/polls\/\d+\/close$/.test(path)) {
          return managePoll(env, session, path, 'close');
        }
        if (request.method === 'POST' && /^\/api\/admin\/polls\/\d+\/publish$/.test(path)) {
          return managePoll(env, session, path, 'publish');
        }
        if (request.method === 'POST' && /^\/api\/admin\/polls\/\d+\/unpublish$/.test(path)) {
          return managePoll(env, session, path, 'unpublish');
        }
        // The ballot is the superadmin's alone, and reading it is recorded.
        // Gated here rather than in the handler because a missing check on
        // this one route hands the secret ballot to every admin.
        if (request.method === 'GET' && /^\/api\/admin\/polls\/\d+\/ballot$/.test(path)) {
          if (!hasRole(session, 'superadmin')) {
            await reportError(env, 'DDP-ADMIN-004', { path, actor: session.actor.id });
            return problem(403, 'DDP-ADMIN-004', 'Not yours to open.');
          }
          return pollBallot(env, session, path);
        }
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
        if (request.method === 'POST' && /^\/api\/admin\/residents\/\d+\/depart$/.test(path)) {
          return departResident(request, env, session, path);
        }
        if (request.method === 'PATCH' && /^\/api\/admin\/residents\/\d+$/.test(path)) {
          return patchResident(request, env, session, path);
        }
        if (request.method === 'PATCH' && /^\/api\/admin\/bills\/\d+$/.test(path)) {
          return patchBill(request, env, session, path);
        }
        if (route === 'GET /api/admin/statement') return statementLanding(env);
        if (route === 'POST /api/admin/statement') return uploadStatement(request, env, session, ctx);
        if (request.method === 'GET' && /^\/api\/admin\/statement\/\d+$/.test(path)) {
          return statementReport(env, path);
        }
        if (request.method === 'POST' && /^\/api\/admin\/statement\/\d+\/assign$/.test(path)) {
          return assignCredit(request, env, session, path);
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
          return problem(403, 'DDP-ADMIN-004', 'Not available.');
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
        if (route === 'GET /api/god/sessions') return godSessions(env, session);
        if (route === 'POST /api/god/sessions/signout') return godSignOut(request, env, session);
        if (request.method === 'DELETE' && /^\/api\/god\/notices\/\d+$/.test(path)) {
          return purgeNoticeRoute(env, session, Number(path.split('/')[4]), ctx);
        }
        if (route === 'GET /api/god/bills')  return godBills(env, url);
        if (route === 'GET /api/god/edits')  return godEdits(env, url);
        if (route === 'GET /api/god/diagnostics') return godDiagnostics(env, url);
        if (route === 'GET /api/god/stats') return godStats(env, url);
        if (route.startsWith('PATCH /api/god/owner/')) return editOwner(request, env, session, path);
        if (route.startsWith('PATCH /api/god/bill/'))  return editBill(request, env, session, path);
        // A replaced meter is a superadmin decision, not a monthly chore: it
        // restates what a month's consumption MEANS, and it is rare enough
        // (once in years) that putting it on the readings screen would only
        // teach the treasurer to ignore it.
        if (route === 'GET /api/god/meter-changes')  return listMeterChanges(env, url);
        if (route === 'POST /api/god/meter-change')  return postMeterChange(request, env, session);
        if (route === 'DELETE /api/god/meter-change') return deleteMeterChange(request, env, session);
      }

      return problem(404, 'DDP-SYS-001', 'No such endpoint.');
    }));
  },

  async scheduled(event, env, ctx) {
    await assertAlerting(env);

    // Three triggers, and which one fired decides the work. The backup runs at
    // 03:30 IST because that was asked for; the digest cannot follow it there,
    // because a Telegram message at 3:30am is a notification somebody mutes,
    // and muting it takes the 22 warnings only the digest reports with it.
    if (isBackupCron(event.cron)) {
      await runBackup(env, ctx);
      return;
    }

    // Midnight IST: fees only. The 08:30 run below still calls applyLateFees,
    // which is the backstop for anything this one missed — it is idempotent, so
    // the overlap costs nothing and the guarantee is worth more than the query.
    if (isLateFeeCron(event.cron)) {
      await runLateFees(env, ctx);
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
    // `email` is here for the expiry branch below, which has to know whether
    // /forgot could actually help this account before it points them at it.
    `SELECT id, name, flat, role, email, pw_hash, pw_salt, pw_iterations,
            must_change_pw, pw_expires_at
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
    // `hasEmail` is reported as well as read: an expired invite on an account
    // with no address is a resident who cannot help themselves, and that is a
    // different call on the committee's time from one who can.
    const hasEmail = Boolean(owner.email);
    await reportError(env, 'DDP-AUTH-012',
                      { flat: owner.flat, ownerId: owner.id, expiredAt: owner.pw_expires_at,
                        hasEmail }, ctx);
    return problem(401, 'DDP-AUTH-012', expiredPasswordMessage(hasEmail));
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
  const { token, maxAge } = await createSession(env, {
    actorId: owner.id, ttlSeconds: ttl, userAgent: request.headers.get('user-agent'),
  });
  await audit(env, { actor: { id: owner.id }, subject: { id: owner.id } }, 'login',
              { device: describeDevice(request.headers.get('user-agent')) });

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

/**
 * One bill in full — screen behind every card on Home.
 *
 * The bill's KIND comes from the record, not the request. A 404 covers both
 * "no such bill" and "not yours", because telling those apart lets somebody
 * walk the ids and learn which flats owe what.
 */
async function billDetail(env, session, url) {
  const payload = await billDetailPayload(env, session.subject, url.searchParams.get('id'));
  if (!payload) return problem(404, 'DDP-BILL-021', 'No such bill.');
  return json(payload);
}

/**
 * The payment sheet. Its own route rather than a sheet, so a poll's Pay button
 * can link into it and come back — see resolveReturn for why `from` is matched
 * against an allowlist instead of being trusted.
 */
async function paySheet(env, session, request, url) {
  const payload = await paySheetPayload(env, session.subject, url.searchParams.get('bill'), {
    userAgent: request.headers.get('user-agent') ?? '',
    origin: url.origin,
    from: url.searchParams.get('from') ?? '',
  });
  if (!payload) return problem(404, 'DDP-BILL-021', 'No such bill.');
  return json(payload);
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
    // Who to message when the portal itself misbehaves, sent HERE rather than
    // written into nav.js. A number baked into a static asset is a public
    // number: /js/nav.js is served to anybody who asks for it, logged in or
    // not, so hardcoding it there would publish a personal mobile to every
    // scraper that reads JavaScript — while looking, in the browser, as though
    // it only appeared behind the login.
    //
    // Read from the superadmin's own row, so it follows the role rather than
    // needing an edit here when the committee changes.
    support: await supportContact(env),
    // How many owners a poll would be emailed. Sent only to the people who can
    // post one, because it is the only number the poll composer cannot work out
    // for itself — and without it `deliveryWarnings` returns nothing at all,
    // which is a warning that silently never fires rather than one that says
    // there is nothing to warn about.
    //
    // Not the flat count: a flat whose owner has no address on file is a flat
    // the letter never reaches, and the warning is about delivery.
    ...(hasRole(session, 'committee')
      ? { mailableOwners: await mailableOwnerCount(env) }
      : {}),
    impersonation: session.impersonating
      ? { active: true, by: session.actor.name, canWrite: session.canWrite }
      : { active: false },
  });
}

/**
 * The resident's current bill, as a PDF file.
 *
 * WHY A ROUTE AND NOT THE PRINT DIALOG. `window.print()` cannot hand anybody a
 * file — it opens a dialog and hopes. A resident who taps "Download bill"
 * wants a .pdf: something their phone opens in a viewer, offers to a chooser,
 * and keeps. That has to be bytes over the wire, which means the Worker draws
 * it (lib/bill-pdf.js).
 *
 * ACCESS IS NOT REIMPLEMENTED HERE, and that is the whole reason this is built
 * on dashboardPayload rather than a query of its own. The rules about who may
 * read whose bill are genuinely intricate — bills follow the PERSON, an absent
 * owner reads their TENANT's amounts, a landlord never sees proofs — and they
 * are already written, tested and applied on the dashboard this file serves.
 * A second SELECT here would be a second place for them to be wrong, and the
 * failure would be a resident handed a neighbour's bill.
 *
 * `inline`, so it opens in the phone's PDF viewer rather than landing silently
 * in Downloads; the filename is still what every browser offers when saving
 * from that viewer.
 */
async function myBillPdf(env, session, request) {
  const payload = await dashboardPayload(
    env, session.subject,
    request.headers.get('user-agent') ?? '',
    new URL(request.url).origin
  );

  const bill = payload.bill;
  if (!bill) return problem(404, 'DDP-BILL-005', 'You have no bill to download yet.');

  // A landlord downloading this is downloading their TENANT's bill — the same
  // relaxation dashboardPayload already made in choosing which bill to show.
  // Naming the viewer on it would put the wrong person on the document.
  const name = payload.tenancy?.viewing === 'landlord'
    ? (payload.tenancy.occupantName ?? 'Occupant')
    : payload.name;

  const settled = bill.settled;
  const bytes = billPdf({
    association: ASSOCIATION,
    flat: payload.flat,
    name,
    period: periodName(bill.period),
    billDate: bill.createdAt ? istSlashDate(bill.createdAt) : null,
    consumption: bill.consumption,
    ratePerKg: bill.ratePerKg,
    gasAmount: bill.gasAmount,
    otherCharges: bill.otherCharges,
    additionalCharges: bill.additionalCharges,
    lateFee: bill.lateFee,
    total: bill.total,
    status: settled
      ? (bill.paidAt ? `Paid on ${dayAndMonth(bill.paidAt)}` : 'Settled')
      : (bill.dueDate ? `Payable before ${dayAndMonth(bill.dueDate)}` : null),
  });

  await audit(env, session, 'bill.download', { period: bill.period, flat: payload.flat });

  return new Response(bytes, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${billFileName(payload.flat, bill.period)}.pdf"`,
      // Somebody's bill, behind a login. A shared cache must never keep it.
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/** The superadmin, as a contact. Null if the row has no mobile to give. */
async function supportContact(env) {
  const row = await env.DB.prepare(
    `SELECT name, flat, mobile FROM owners
      WHERE role = 'superadmin' AND active = 1 ORDER BY id LIMIT 1`
  ).first();
  if (!row?.mobile) return null;
  const digits = String(row.mobile).replace(/[^0-9]/g, '');
  // +91 95677 91515 — the way it is written on a poster in the lobby. Falls
  // back to the stored string for any number that is not a 12-digit Indian one.
  const shown = /^91\d{10}$/.test(digits)
    ? `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`
    : String(row.mobile);
  return {
    name: String(row.name).split(' ')[0],   // "Sabarish", not the full name
    flat: row.flat,
    wa: digits,
    shown,
  };
}

/**
 * The whole reuse gate: what the account holds now, then what it used to.
 *
 * Ordered by cost. `refuseCurrentPassword` needs no query and one derive;
 * the history read is a round trip and up to HISTORY_DEPTH more. A password
 * that is simply the current one — by far the common case, since that is the
 * temporary-password mistake — never reaches the table at all.
 *
 * `owner` must carry the pw_* columns; `ownerId` is separate because two of
 * the three callers identify the account from the session rather than the row.
 */
async function refuseReusedPassword(env, ownerId, candidate, owner) {
  await refuseCurrentPassword(candidate, owner);

  const { results } = await env.DB.prepare(
    `SELECT pw_hash, pw_salt, pw_iterations FROM password_history
      WHERE owner_id = ? ORDER BY set_at DESC, id DESC LIMIT ?`
  ).bind(ownerId, HISTORY_DEPTH).all();

  await refusePastPassword(candidate, results ?? []);
}

/**
 * Archive the credential being replaced, and forget the ones past the depth.
 *
 * Called with the row's OLD hash, immediately before the UPDATE that
 * overwrites it — see migration 0034 for why the outgoing password is the one
 * recorded. An account being given its first password has nothing to archive
 * and passes through.
 *
 * The prune is in the same batch as the insert. Apart means a failure between
 * them grows the table without bound, and this is the one table whose size is
 * also its CPU cost.
 */
async function archivePassword(env, ownerId, old) {
  if (!old?.pw_hash || !old?.pw_salt) return;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO password_history (owner_id, pw_hash, pw_salt, pw_iterations, set_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(ownerId, old.pw_hash, old.pw_salt, old.pw_iterations ?? DEFAULT_ITERATIONS,
           new Date().toISOString()),
    // Keep the newest HISTORY_DEPTH. Anything older can never refuse anything
    // again, and is a password sitting in a database for no reason.
    env.DB.prepare(
      `DELETE FROM password_history
        WHERE owner_id = ?
          AND id NOT IN (SELECT id FROM password_history WHERE owner_id = ?
                          ORDER BY set_at DESC, id DESC LIMIT ?)`
    ).bind(ownerId, ownerId, HISTORY_DEPTH),
  ]);
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
  validateNewPassword(next, row);   // throws DDP-AUTH-008/013/014/015
  // The forced first-login change lands here having skipped the block above,
  // so this is the only thing standing between a temporary password and a
  // permanent one. DDP-AUTH-017, then DDP-AUTH-018 for the ones before it.
  await refuseReusedPassword(env, session.actor.id, next, row);

  await archivePassword(env, session.actor.id, row);
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
    return problem(403, 'DDP-ADMIN-004', 'Past residents are not available.');
  }

  const { results } = await env.DB.prepare(
    `SELECT o.id, o.flat, f.floor, o.name, o.mobile, o.email, o.role,
            o.relationship, o.active, o.moved_in_at, o.moved_out_at, o.must_change_pw,
            o.lease_ends_at, o.tenancy_confirmed_at,
            -- A COLUMN, not a second screen. What a resident row gains is their
            -- current-quarter maintenance status, any advance, and their voting
            -- state when it is blocked. Each is one fact about this person, so
            -- each is one column rather than a page of its own.
            (SELECT b.status FROM maint_bills b
              WHERE b.owner_id = o.id AND b.status NOT IN ('cancelled')
              ORDER BY b.quarter DESC LIMIT 1) AS maint_status,
            (SELECT b.quarter FROM maint_bills b
              WHERE b.owner_id = o.id AND b.status NOT IN ('cancelled')
              ORDER BY b.quarter DESC LIMIT 1) AS maint_quarter,
            -- Approved advances only. An unapproved one is one admin's
            -- assertion until a second agrees, and advanceCovers() refuses to
            -- count it — so showing it here would contradict the rule.
            (SELECT MAX(a.paid_through) FROM maint_advances a
              WHERE a.flat = o.flat AND a.approved_by IS NOT NULL
                AND a.cancelled_at IS NULL) AS advance_through
       FROM owners o JOIN flats f ON f.flat = o.flat
      ${wantsPast ? '' : 'WHERE o.active = 1'}
      ORDER BY f.floor, o.flat, o.active DESC, o.relationship`
  ).all();
  // The console has to draw the same conclusion the endpoint will reach, or an
  // admin is shown a button that refuses them — or, worse, told to send someone
  // to `/forgot` when nothing can be sent. It is the mailbox that decides, so
  // the mailbox is what gets reported.
  // The superadmin is listed to admins as an admin -- see roleAsSeenBy for why
  // this is masked here, in the data, and not only in the page.
  // THE REAL RULE, not a SQL approximation of it. Whether a flat's vote is
  // blocked depends on which quarters have ENDED, on approvals in flight and on
  // exemptions — flatVotingStatus knows all three, and a WHERE clause that got
  // any of them slightly wrong would put a "vote locked" line on a card while
  // the poll screen let that flat vote. Two answers to one question is worse
  // than one answer in one place.
  const blockedFlats = await votingBlockedFlats(env);

  const residents = results.map((r) => ({
    ...r,
    role: roleAsSeenBy(session.actor, r.role),
    // The vote is the flat's and the flat's vote is the owner's, so a tenant's
    // card never carries this even when their own arrears are what caused it.
    voting_blocked: r.relationship !== 'tenant' && blockedFlats.has(r.flat),
  }));
  return json({ residents, mailConfigured: mailConfigured(env) });
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
  // The password being displaced was chosen by the resident, and after this
  // they will be asked to choose again — archived, or the obvious thing to
  // type at that prompt is the password they had before the reset.
  await archivePassword(env, ownerId, target);
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
    // pw_iterations travels with the hash: the archive below is worthless if
    // the count that made it is guessed rather than recorded. See 0025.
    `SELECT id, name, flat, email, role, pw_hash, pw_salt, pw_iterations,
            must_change_pw, pw_expires_at
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

  // The link rides the same password_resets mechanism as a self-service reset.
  // It is NOT the temporary password in a URL: following it lands on the
  // choose-your-own step, and the credential below stays the typed fallback.
  // Its life is the code expiry, not the password's 24 hours — a link is
  // clicked in the minutes after it arrives or not at all.
  const linkToken = generateLinkToken();
  const issuedAt = new Date();
  const placeholder = await hashPassword(generateCode(), ITER(env));
  await env.DB.prepare(
    `INSERT INTO password_resets
       (owner_id, code_hash, code_salt, code_iterations, sent_to, expires_at,
        created_at, link_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(target.id, placeholder.hash, placeholder.salt, placeholder.iterations,
         target.email, expiryFrom(issuedAt), issuedAt.toISOString(),
         await linkHash(linkToken)).run();

  const { subject, text, html } = tempPasswordEmail({
    password: offered, name: target.name, flat: target.flat, hours: TEMP_PW_HOURS,
    link: resetLinkUrl(linkToken, new URL(request.url).origin),
  });
  const result = await sendEmail(env, { to: target.email, subject, text, html });

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
/**
 * One of this person's household's bills, or nothing.
 *
 * The flat comes from the SESSION and the readers from the household, never
 * from the URL: a bill id is a number anybody can type. Owners and tenants are
 * separate households on the same flat, so an absent owner resolves nothing
 * here and cannot pay their tenant's bill — which is the rule billAccess
 * states and this is the half that enforces it for writes.
 */
async function billForHousehold(env, billId, subject, columns) {
  const { results } = await env.DB.prepare(
    'SELECT id, name, flat, relationship, active FROM owners WHERE flat = ?'
  ).bind(subject.flat).all();
  const readers = householdIds(results ?? [], subject);
  if (!readers.length) return null;

  const holders = readers.map(() => '?').join(', ');
  return env.DB.prepare(
    `SELECT ${columns} FROM bills
      WHERE id = ? AND flat = ? AND (owner_id IS NULL OR owner_id IN (${holders}))`
  ).bind(billId, subject.flat, ...readers).first();
}

async function logIntent(env, session, path) {
  const billId = Number(path.split('/')[3]);

  const bill = await billForHousehold(env, billId, session.subject,
    'id, flat, status, total');

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

/**
 * The maintenance twin of logIntent — the resident opened their UPI app.
 *
 * NO `maint_payment_intents` TABLE, and that is deliberate rather than an
 * omission. Migration 0042 says of `maint_bills.claimed_at` that it is "the
 * only record of when a claim was made, and a dispute asks that question": the
 * gas side keeps a row per tap because its late-fee hold once needed the count,
 * and maintenance's fee does not hold on a claim at all. A table nobody reads
 * is a table that goes stale, so the stamp on the bill is the whole record.
 *
 * Everything else matches gas, including the two guards that matter: an already
 * settled bill is refused rather than re-claimed, and `claimed_at` is set only
 * when NULL so that tapping Pay every night cannot extend anything.
 */
async function logMaintIntent(env, session, path) {
  const billId = Number(path.split('/')[3]);

  // Resolved through the shared rule, not a query of its own. Visibility is the
  // one thing in this app that has already had a privacy bug.
  const found = await resolveBill(env, session.subject, billId);
  if (!found || found.kind !== 'maintenance') {
    return problem(404, 'DDP-BILL-021', 'That bill could not be found.');
  }

  const bill = found.row;
  if (SETTLED_STATUSES.includes(bill.status)) {
    return problem(409, 'DDP-PAY-003', 'This bill is already settled.');
  }

  // Read-only impersonation must not leave footprints in a resident's record.
  if (session.impersonating && !session.canWrite) {
    return json({ recorded: false, reason: 'read-only session', status: bill.status });
  }

  await env.DB.prepare(
    `UPDATE maint_bills SET status = 'initiated',
                            claimed_at = COALESCE(claimed_at, ?)
      WHERE id = ? AND status = 'unpaid'`
  ).bind(new Date().toISOString(), bill.id).run();

  await audit(env, session, 'maint.payment.intent', { billId: bill.id, total: bill.total });
  return json({ recorded: true, status: bill.status === 'unpaid' ? 'initiated' : bill.status });
}

/* ── maintenance admin ───────────────────────────────────────────────────── */

/**
 * Step 1 — the rates for the quarter.
 *
 * Creates the quarter row if it does not exist yet: an admin opening a quarter
 * nobody has drafted and typing the rates IS how a quarter starts, and making
 * them press "create" first would be a step that exists only because of how the
 * table is shaped.
 *
 * NO APPROVAL WHILE IT IS A DRAFT. Nothing has been promised to anybody, and an
 * approval queue on a number no resident has seen is ceremony. Once the quarter
 * is scheduled the rates are frozen and this refuses; after issuing, a rate
 * moves per bill through the rate-switch approval.
 */
async function putMaintRates(request, env, session) {
  const body = await readJson(request);
  const quarter = String(body?.quarter ?? '');
  if (!isQuarterLabel(quarter)) {
    return problem(400, 'DDP-MAINT-001', 'That is not a quarter.');
  }

  const rates = ['ownerRate', 'tenantRate', 'lateFee'].map((k) => Number(body?.[k]));
  if (rates.some((n) => !Number.isFinite(n) || n < 0 || Math.round(n * 100) % 100 !== 0)) {
    // Whole rupees, for the reason the schema CHECKs it: a fractional figure
    // passes the application and then dies at the database as a 500 rather than
    // as a message anybody can act on.
    return problem(400, 'DDP-MAINT-005', 'Rates and the late fee must be whole rupees.');
  }
  const [ownerRate, tenantRate, lateFee] = rates;
  if (ownerRate <= 0 || tenantRate <= 0) {
    return problem(400, 'DDP-MAINT-004', 'Both rates must be more than zero.');
  }

  const existing = await env.DB.prepare('SELECT status FROM maint_quarters WHERE quarter = ?')
    .bind(quarter).first();
  if (existing && existing.status !== 'draft') {
    return problem(409, 'DDP-MAINT-008',
      'This quarter is no longer a draft. Its rates are fixed.');
  }

  const issueDate = firstDayOf(quarter);
  await env.DB.prepare(
    `INSERT INTO maint_quarters
       (quarter, owner_rate, tenant_rate, late_fee, issue_date, due_date, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)
     ON CONFLICT (quarter) DO UPDATE
       SET owner_rate = excluded.owner_rate,
           tenant_rate = excluded.tenant_rate,
           late_fee = excluded.late_fee`
  ).bind(quarter, ownerRate, tenantRate, lateFee, issueDate, dueDateFor(issueDate),
         new Date().toISOString()).run();

  await audit(env, session, 'maint.rates', { quarter, ownerRate, tenantRate, lateFee });
  return json(await maintAdminPayload(env, quarter, { session }));
}

/** Why a quarter would not schedule, in words an admin can act on. */
function refusalSentence(result) {
  if (result?.reason === 'stale-tenancy') {
    return result.readiness?.message
      ?? 'Some tenancies on record have leases that ended before the issue date.';
  }
  if (result?.reason === 'undated-leases') {
    const flats = [...new Set((result.undated ?? []).map((u) => u.flat))].join(', ');
    return `${result.undated.length} tenanc${result.undated.length === 1 ? 'y has' : 'ies have'} `
      + `no lease end date (${flats}). Add the dates, or confirm you want to schedule `
      + 'without them.';
  }
  if (result?.reason === 'unresolved-flats') {
    const flats = (result.unresolved ?? []).map((u) => u.flat).join(', ');
    return `Somebody is living in ${flats} with no owner on record. `
      + 'Resolve that before scheduling — otherwise nobody is billed for it.';
  }
  return 'That quarter could not be scheduled.';
}

/** The first day of a quarter — '2026-Q4' → '2026-10-01'. */
function firstDayOf(quarter) {
  const [year, q] = String(quarter).split('-Q').map(Number);
  return `${year}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
}

/**
 * Step 3 — schedule.
 *
 * No typed confirmation and no second-admin approval: scheduling is reversible,
 * nothing has reached a resident, and an approval on a reversible act teaches
 * people to click through approvals.
 *
 * The tenancy refusals live in scheduleQuarter rather than here, so there is
 * one rule in one place: an ENDED lease refuses outright, and an UNDATED one
 * refuses unless the caller acknowledges it. The screen sets that flag only
 * after an admin has worked through the flagged rows, so an undated lease can
 * be scheduled past deliberately but never silently — and somebody calling this
 * endpoint directly gets a refusal naming what to acknowledge rather than a
 * warning they would never see.
 */
async function postMaintSchedule(request, env, session) {
  const body = await readJson(request);
  const quarter = String(body?.quarter ?? '');
  if (!isQuarterLabel(quarter)) {
    return problem(400, 'DDP-MAINT-001', 'That is not a quarter.');
  }

  try {
    const result = await scheduleQuarter(env, quarter, {
      actorId: session.actor.id,
      issueDate: body?.issueDate ?? null,
      acknowledgeUndated: body?.acknowledgeUndated === true,
    });

    // A refusal is a sentence the admin must read, not a silent no-op. Without
    // this the screen would reload unchanged and they would press the button
    // again, which is how "it does nothing" gets reported.
    if (!result?.scheduled) {
      return problem(409, 'DDP-MAINT-008', refusalSentence(result));
    }

    await audit(env, session, 'maint.schedule', {
      quarter, issueDate: result.issueDate,
      // Worth recording: whether this quarter went out with undated leases
      // knowingly left in it.
      acknowledgedUndated: result.acknowledgedUndated === true,
    });
    return json(await maintAdminPayload(env, quarter, { session }));
  } catch (err) {
    // A refusal here is a sentence the admin must read — a stale tenancy, a
    // quarter in the wrong state — not a 500.
    return problem(409, err?.code ?? 'DDP-MAINT-008',
      err?.message ?? 'That quarter could not be scheduled.');
  }
}

/**
 * Unschedule — back to draft, any time before the issue date.
 *
 * Possible BECAUSE nothing has reached a resident yet. Once the bills are
 * issued this refuses: withdrawing ninety-nine bills people have already been
 * emailed is a different act with a different name, and it is per bill.
 */
async function postMaintUnschedule(request, env, session) {
  const body = await readJson(request);
  const quarter = String(body?.quarter ?? '');

  const row = await env.DB.prepare('SELECT status, issue_date FROM maint_quarters WHERE quarter = ?')
    .bind(quarter).first();
  if (!row) return problem(404, 'DDP-MAINT-007', 'No such quarter.');
  if (row.status !== 'scheduled') {
    return problem(409, 'DDP-MAINT-008', 'Only a scheduled quarter can be unscheduled.');
  }

  await env.DB.prepare(
    `UPDATE maint_quarters SET status = 'draft', scheduled_by = NULL, scheduled_at = NULL
      WHERE quarter = ? AND status = 'scheduled'`
  ).bind(quarter).run();

  // WHO DID IT, recorded. An unschedule moves ninety-nine bills out of the post
  // and the next person to look should be able to see whose decision that was.
  await audit(env, session, 'maint.unschedule', { quarter, issueDate: row.issue_date });
  return json(await maintAdminPayload(env, quarter, { session }));
}

/**
 * "Still here" — an admin stamps a tenancy as checked.
 *
 * The cheapest of the three ways to clear a flag in step 2, and the only one
 * that changes nothing about the tenancy itself: it records that a human looked
 * at it on a date. That is exactly what the `unchecked` flag is asking for.
 */
async function postTenancyConfirm(request, env, session) {
  const body = await readJson(request);
  const id = Number(body?.id);
  if (!Number.isInteger(id) || id <= 0) {
    return problem(400, 'DDP-ADMIN-004', 'Which tenancy?');
  }

  const person = await env.DB.prepare(
    "SELECT id, flat, relationship FROM owners WHERE id = ? AND relationship = 'tenant'"
  ).bind(id).first();
  if (!person) return problem(404, 'DDP-ADMIN-004', 'No such tenancy.');

  const at = new Date().toISOString();
  // The lease end can be supplied at the same time, which is what clears a
  // `missing-date` row — otherwise confirming it would stamp a record that is
  // still missing the thing that made it a problem.
  const leaseEnd = body?.leaseEndsAt ? String(body.leaseEndsAt).slice(0, 10) : null;
  if (leaseEnd && !/^\d{4}-\d{2}-\d{2}$/.test(leaseEnd)) {
    return problem(400, 'DDP-MAINT-002', 'That is not a date.');
  }

  await env.DB.prepare(
    `UPDATE owners SET tenancy_confirmed_at = ?,
                       lease_ends_at = COALESCE(?, lease_ends_at)
      WHERE id = ?`
  ).bind(at, leaseEnd, id).run();

  await audit(env, session, 'maint.tenancy.confirm', { id, flat: person.flat, leaseEnd });
  return json({ confirmed: true, at, leaseEndsAt: leaseEnd });
}

/* ── the voting block, and the committee's exceptions ────────────────────
   The rule itself is `flatVotingStatus` and it is enforced at the ballot
   (lib/polls.js). What an admin needs is to SEE it — which flats it catches and
   why — and to excuse a flat the committee has decided about. 0042 gave the
   exemption two signatures at the schema, in the CHECK that the grantor and the
   approver differ, for the same reason every other maintenance decision has
   them: this one restores a vote.                                             */

async function votingOverview(env) {
  const [statuses, exemptions] = await Promise.all([
    votingStatuses(env),
    env.DB.prepare(
      `SELECT e.*, g.name AS granted_by_name, a.name AS approved_by_name
         FROM voting_exemptions e
         LEFT JOIN owners g ON g.id = e.granted_by
         LEFT JOIN owners a ON a.id = e.approved_by
        ORDER BY e.granted_at DESC`
    ).all(),
  ]);

  return json({
    // Only the flats the rule has something to say about. Ninety-nine rows
    // saying "clear" is a screen nobody reads to the bottom of.
    flats: [...statuses]
      .filter(([, v]) => !v.canVote || v.reason === 'exempt')
      // Described, through the same helper the resident card uses. An internal
      // key is defensible on an admin screen in isolation; two screens naming
      // the same blocked quarter two ways is how a shared phrasing quietly
      // stops being shared.
      .map(([flat, v]) => ({ ...v, flat, quarters: (v.quarters ?? []).map(describeQuarter) }))
      .sort((a, b) => String(a.flat).localeCompare(String(b.flat))),
    exemptions: exemptions.results ?? [],
    today: istToday(),
  });
}

/** One admin proposes an exemption. It does nothing until another agrees. */
async function grantVotingExemption(request, env, session) {
  const body = await readJson(request);
  const flat = String(body?.flat ?? '').trim().toUpperCase();
  const reason = String(body?.reason ?? '').trim();
  // NOT NULLABLE HERE even though the column allows it. 0042 left `ends_at`
  // open-ended on purpose — a flat in a long dispute is a deliberate committee
  // decision — but an open-ended exemption is the one an admin grants by
  // accident and nobody ever revisits, so it has to be asked for explicitly.
  const endsAt = body?.endsAt ? String(body.endsAt).slice(0, 10) : null;
  const openEnded = Boolean(body?.openEnded);

  if (!flat) return problem(400, 'DDP-ADMIN-004', 'Which flat?');
  if (!reason) return problem(400, 'DDP-ADMIN-004', 'Say why, for the record.');
  if (!endsAt && !openEnded) {
    return problem(400, 'DDP-MAINT-002',
      'Give an end date, or say plainly that this one is open-ended.');
  }
  if (endsAt && !/^\d{4}-\d{2}-\d{2}$/.test(endsAt)) {
    return problem(400, 'DDP-MAINT-002', 'That is not a date.');
  }

  const exists = await env.DB.prepare('SELECT flat FROM flats WHERE flat = ?').bind(flat).first();
  if (!exists) return problem(404, 'DDP-ADMIN-004', 'No such flat.');

  const now = new Date().toISOString();
  const created = await env.DB.prepare(
    `INSERT INTO voting_exemptions (flat, reason, ends_at, granted_by, granted_at)
     VALUES (?, ?, ?, ?, ?) RETURNING id`
  ).bind(flat, reason.slice(0, 300), openEnded ? null : endsAt, session.actor.id, now).first();

  await audit(env, session, 'maint.voting.exempt.grant',
    { id: created.id, flat, endsAt: openEnded ? null : endsAt });
  return json({ id: created.id, flat, approved: false }, { status: 201 });
}

/**
 * A second admin agrees, and only now does the vote come back.
 *
 * The rule is in the schema: 0042 CHECKs that granted_by and approved_by
 * differ, and `isVotingExemptOn` refuses an unapproved row outright. Both
 * belts are deliberate — an exemption restores a right, and one admin restoring
 * it for their own flat is exactly the shape this is guarding against.
 */
async function approveVotingExemption(env, session, path) {
  const id = Number(path.split('/')[6]);   // /api/admin/maint/voting/exempt/:id/approve
  const row = await env.DB.prepare('SELECT * FROM voting_exemptions WHERE id = ?').bind(id).first();
  if (!row) return problem(404, 'DDP-ADMIN-017', 'No such exemption.');
  if (row.approved_by) return problem(409, 'DDP-ADMIN-017', 'That exemption is already approved.');
  if (row.granted_by === session.actor.id) {
    return problem(403, 'DDP-ADMIN-017', 'You granted this one, so you cannot approve it.');
  }
  // An admin's own flat, for the reason approvalPolicy gives at length: an
  // admin has a flat like everybody else, and their own is precisely where a
  // quiet restoration looks worst.
  if (String(session.actor.flat) === String(row.flat)) {
    return problem(403, 'DDP-ADMIN-017', 'This is your own flat.');
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    'UPDATE voting_exemptions SET approved_by = ?, approved_at = ? WHERE id = ? AND approved_by IS NULL'
  ).bind(session.actor.id, now, id).run();

  await audit(env, session, 'maint.voting.exempt.approve', { id, flat: row.flat });
  return json({ id, flat: row.flat, approved: true });
}

/* ── recording an advance ────────────────────────────────────────────────
   A flat paying ahead. One admin records it, a second agrees, and only then
   does the `maint_advances` row exist — the same maker≠checker rule the gas
   bill-edit and tenancy-change queues run, and the shape 0042 built the advance
   table for (a single `approved_by`, one second admin, not two). approvalBench
   and approvalPolicy are the same helpers the gas bill-edit queue uses.        */

/**
 * Raise the request. Nothing about any advance changes here; the proposed
 * advance waits in the request's payload until a second admin approves. The
 * approver(s) are emailed at once, non-blocking — a send that fails or is off
 * never fails the recording, exactly as the bill-edit alert never does.
 */
async function recordAdvance(request, env, session, origin = '') {
  const body = await readJson(request);
  const flat = normaliseFlat(String(body?.flat ?? ''));
  const amount = Number(body?.amount);
  const paidThrough = String(body?.paidThrough ?? '').trim();
  const paidOn = String(body?.paidOn ?? '').slice(0, 10);
  const ownerId = body?.ownerId != null ? Number(body.ownerId) : null;
  const method = body?.method ? String(body.method).slice(0, 40) : null;
  const reference = body?.reference ? String(body.reference).slice(0, 120) : null;
  const reason = String(body?.reason ?? '').trim();

  if (!flat) return problem(400, 'DDP-ADMIN-004', 'Which flat?');
  const flatRow = await env.DB.prepare('SELECT flat FROM flats WHERE flat = ?').bind(flat).first();
  if (!flatRow) return problem(404, 'DDP-ADMIN-004', 'No such flat.');
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) % 100 !== 0) {
    return problem(400, 'DDP-MAINT-005', 'Give a whole-rupee amount.');
  }
  if (!isQuarterLabel(paidThrough)) {
    return problem(400, 'DDP-MAINT-001', 'Say which quarter the advance covers up to.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) {
    return problem(400, 'DDP-MAINT-002', 'Give the date the money was paid.');
  }
  if (!reason) return problem(400, 'DDP-ADMIN-004', 'Say why, for the approver.');

  // Enough admins to field one eligible approver? The advance needs exactly one
  // second admin, but there must BE one who is neither the requester nor the
  // flat's own household, or the request would sit unactionable forever.
  const policy = approvalPolicy({
    admins: await approvalBench(env), requesterId: session.actor.id, billFlat: flat,
  });
  if (!policy.approverIds.length) {
    await reportError(env, 'DDP-ADMIN-016', { flat, actor: session.actor.id });
    return problem(409, 'DDP-ADMIN-016',
      'There is no other admin free to approve this advance. Add an admin, or ask the committee.');
  }

  const now = new Date().toISOString();
  const { requestId } = await recordAdvanceRequest(env, {
    actorId: session.actor.id, flat, ownerId, amount, paidOn, paidThrough,
    method, reference, reason, now, expiresAt: expiresAt(now),
  });

  await audit(env, session, 'maint.advance.request',
    { requestId, flat, amount, paidThrough, paidOn, ownerId });

  // Tell the approvers, and report who was reached — an alert that went nowhere
  // looks identical to one nobody has answered yet. Never fails the record.
  const alerted = await alertAdvanceApprovers(env, {
    policy, flat, amount, paidThrough, paidOn, ownerId, reason,
    requestedBy: session.actor.name, origin,
  }).catch(() => ({ emailed: 0, missing: [], mail: false }));

  return json({ ok: true, pending: true, requestId, required: 1, alerted }, { status: 201 });
}

/** Email each eligible approver who has an address. Mirrors alertApprovers. */
async function alertAdvanceApprovers(env, {
  policy, flat, amount, paidThrough, paidOn, ownerId, reason, requestedBy, origin,
}) {
  if (!policy.approverIds.length) return { emailed: 0, missing: [], mail: false };
  const mail = mailConfigured(env);
  if (!mail) return { emailed: 0, missing: [], mail: false };

  const people = await env.DB.prepare(
    `SELECT id, name, email FROM owners WHERE id IN (${policy.approverIds.map(() => '?').join(',')})`
  ).bind(...policy.approverIds).all();

  // The payer's name for the email, when one was named. A missing owner_id is
  // fine — the message shows a dash rather than inventing a name.
  const payer = ownerId
    ? await env.DB.prepare('SELECT name FROM owners WHERE id = ?').bind(ownerId).first()
    : null;

  const { subject, text } = advanceRequestEmail({
    flat, amount, paidThrough, paidOn: istSlashDate(paidOn),
    paidByName: payer?.name ?? null, reason, requestedBy, origin,
  });

  let emailed = 0;
  const missing = [];
  for (const person of people.results ?? []) {
    if (!person.email) { missing.push(person.name); continue; }
    const sent = await sendEmail(env, { to: person.email, subject, text });
    if (sent.sent) emailed += 1;
    else missing.push(`${person.name} (${sent.reason})`);
  }
  if (!emailed && missing.length) await reportError(env, 'DDP-ADMIN-018', { flat, missing });
  return { emailed, missing, mail };
}

/**
 * Withdraw one's own pending advance request. No second admin: nothing was
 * recorded, so there is nothing to un-record — the request is simply cancelled.
 * Only the person who raised it, and only while it is still pending.
 */
async function withdrawAdvance(env, session, path) {
  const id = Number(path.split('/')[5]);   // /api/admin/maint/advances/:id/withdraw
  const req = await env.DB.prepare(
    "SELECT * FROM maint_approval_requests WHERE id = ? AND kind = 'advance'"
  ).bind(id).first();
  if (!req) return problem(404, 'DDP-ADMIN-017', 'No such request.');
  if (req.status !== 'pending') {
    return problem(409, 'DDP-ADMIN-017', `That request is already ${req.status}.`);
  }
  if (req.requested_by !== session.actor.id) {
    return problem(403, 'DDP-ADMIN-017', 'Only the admin who recorded it can withdraw it.');
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE maint_approval_requests SET status = 'cancelled', resolved_at = ? WHERE id = ? AND status = 'pending'"
  ).bind(now, id).run();
  await audit(env, session, 'maint.advance.withdraw', { requestId: id, flat: req.flat });
  return json({ ok: true, status: 'cancelled' });
}

/**
 * Approve or reject a maintenance approval request. GENERIC: it lapses,
 * gates on canApprove and records the approval the same way for any `kind`, then
 * dispatches the applier by kind. This session implements the `advance` applier
 * only; any other kind that reaches satisfaction is refused loudly rather than
 * applied by code that does not exist yet.
 *
 * ONE SECOND ADMIN for an advance: unlike a gas bill edit (two), the first
 * eligible approval satisfies it — the committee's decision, and the shape of
 * the single `approved_by` column. Eligibility is still lib/approvals.js's.
 */
async function decideMaintApproval(env, session, path, decision, origin = '') {
  const id = Number(path.split('/')[5]);   // /api/admin/maint/approvals/:id/(approve|reject)
  const req = await env.DB.prepare('SELECT * FROM maint_approval_requests WHERE id = ?')
    .bind(id).first();
  if (!req) return problem(404, 'DDP-ADMIN-017', 'No such request.');

  // Lapsed on read, as the other two queues do: the expiry only has to be true
  // at the moment somebody acts, and a cron for it would fail quietly.
  if (req.status === 'pending' && Date.parse(req.expires_at) < Date.now()) {
    await env.DB.prepare(
      "UPDATE maint_approval_requests SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'"
    ).bind(new Date().toISOString(), id).run();
    return problem(409, 'DDP-ADMIN-017', 'That request has lapsed. Raise it again if it still stands.');
  }
  if (req.status !== 'pending') {
    return problem(409, 'DDP-ADMIN-017', `That request is already ${req.status}.`);
  }
  if (req.kind !== ADVANCE_KIND) {
    // The other four kinds have no create UI and no applier this session. A
    // request of one could only exist by raw SQL, and applying it here would be
    // code pretending to a decision it cannot carry out.
    return problem(409, 'DDP-ADMIN-017', `Approving a ${req.kind} request is not built yet.`);
  }

  const policy = approvalPolicy({
    admins: await approvalBench(env), requesterId: req.requested_by, billFlat: req.flat,
  });
  const verdict = canApprove({ policy, approver: session.actor, request: req });
  if (!verdict.ok) {
    await reportError(env, verdict.code, { requestId: id, actor: session.actor.id, reason: verdict.reason });
    return problem(403, verdict.code,
      verdict.reason === 'requester' ? 'You recorded this, so you cannot approve it.'
      : verdict.reason === 'too-soon' ? `An admin still has ${verdict.hoursLeft}h to answer.`
      : 'This is not yours to approve.');
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO maint_approvals (request_id, approver_id, decision, substitute, at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (request_id, approver_id) DO UPDATE SET
       decision = excluded.decision, at = excluded.at, substitute = excluded.substitute`
  ).bind(id, session.actor.id, decision, verdict.substitute ? 1 : 0, now).run();

  if (decision === 'reject') {
    await env.DB.prepare(
      "UPDATE maint_approval_requests SET status = 'rejected', resolved_at = ? WHERE id = ?"
    ).bind(now, id).run();
    await audit(env, session, 'maint.advance.reject', { requestId: id, flat: req.flat });
    await notifyAdvanceDecision(env, { req, decision: 'reject', decidedBy: session.actor.name, origin });
    return json({ ok: true, status: 'rejected' });
  }

  // One approval satisfies an advance, so the applier runs now. The
  // recorded_by <> approved_by CHECK is the database's own backstop under
  // canApprove's requester guard.
  const { advanceId } = await applyAdvanceRequest(env, { req, actorId: session.actor.id, now });

  await audit(env, session, 'maint.advance.approve',
    { requestId: id, advanceId, flat: req.flat, approvedBy: session.actor.id });
  await notifyAdvanceDecision(env, { req, decision: 'approve', decidedBy: session.actor.name, origin });

  return json({ ok: true, status: 'applied', advanceId });
}

/** Email the requester the outcome. Non-blocking, gated, never fails the decision. */
async function notifyAdvanceDecision(env, { req, decision, decidedBy, origin }) {
  try {
    if (!mailConfigured(env)) return;
    const requester = await env.DB.prepare('SELECT name, email FROM owners WHERE id = ?')
      .bind(req.requested_by).first();
    if (!requester?.email) return;
    let payload = {};
    try { payload = req.payload ? JSON.parse(req.payload) : {}; } catch { payload = {}; }
    const { subject, text } = advanceDecisionEmail({
      decision, flat: req.flat, amount: payload.amount,
      paidThrough: payload.paid_through, decidedBy, origin,
    });
    await sendEmail(env, { to: requester.email, subject, text });
  } catch { /* a failed notification must never undo an approved advance */ }
}

/**
 * Request to cancel an APPROVED advance (Option B). Nothing reverses here — the
 * pending-cancel fields are set on the advance and a DIFFERENT admin must agree,
 * the same maker≠checker rule as everything else. The late fee is the admin's
 * choice, carried on the advance until the cancel is approved and the bill
 * reopens.
 */
async function requestAdvanceCancel(request, env, session, path) {
  const id = Number(path.split('/')[5]);   // /api/admin/maint/advances/:id/cancel
  const body = await readJson(request);
  const reason = String(body?.reason ?? '').trim();
  if (!reason) return problem(400, 'DDP-ADMIN-004', 'Say why, for the second admin.');

  const advance = await env.DB.prepare('SELECT * FROM maint_advances WHERE id = ?').bind(id).first();
  if (!advance) return problem(404, 'DDP-ADMIN-017', 'No such advance.');
  if (!advance.approved_by) return problem(409, 'DDP-ADMIN-017', 'That advance is not approved yet.');
  if (advance.cancelled_at) return problem(409, 'DDP-ADMIN-017', 'That advance is already cancelled.');
  if (advance.cancel_requested_at) {
    return problem(409, 'DDP-ADMIN-017', 'A cancel is already waiting for a second admin on this advance.');
  }

  // The late fee, when the admin turned it on: a whole-rupee amount from a date.
  let lateFee = null;
  let lateFeeFrom = null;
  if (body?.lateFee) {
    lateFee = Number(body.lateFee.amount);
    lateFeeFrom = String(body.lateFee.from ?? '').slice(0, 10);
    if (!Number.isFinite(lateFee) || lateFee <= 0 || Math.round(lateFee * 100) % 100 !== 0) {
      return problem(400, 'DDP-MAINT-005', 'Give the late fee as a whole-rupee amount.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(lateFeeFrom)) {
      return problem(400, 'DDP-MAINT-002', 'Give the date the late fee applies from.');
    }
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE maint_advances
        SET cancel_requested_by = ?, cancel_requested_at = ?, cancel_reason = ?,
            cancel_late_fee = ?, cancel_late_fee_from = ?
      WHERE id = ? AND cancelled_at IS NULL AND cancel_requested_at IS NULL`
  ).bind(session.actor.id, now, reason.slice(0, 300), lateFee, lateFeeFrom, id).run();

  await audit(env, session, 'maint.advance.cancel.request',
    { advanceId: id, flat: advance.flat, lateFee, lateFeeFrom });
  return json({ ok: true, status: 'cancel-pending' }, { status: 201 });
}

/**
 * A different admin decides the pending cancel. On approval the advance is
 * soft-cancelled and every bill it had settled reopens as unpaid, with the
 * admin's chosen late fee (if any). Maker≠checker: canApprove refuses the admin
 * who requested it, and the flat's own household, exactly as for the advance
 * itself.
 */
async function decideAdvanceCancel(env, session, path, decision) {
  const id = Number(path.split('/')[5]);   // /api/admin/maint/advances/:id/cancel/(approve|reject)
  const advance = await env.DB.prepare('SELECT * FROM maint_advances WHERE id = ?').bind(id).first();
  if (!advance) return problem(404, 'DDP-ADMIN-017', 'No such advance.');
  if (advance.cancelled_at) return problem(409, 'DDP-ADMIN-017', 'That advance is already cancelled.');
  if (!advance.cancel_requested_at) {
    return problem(409, 'DDP-ADMIN-017', 'No cancel is waiting on that advance.');
  }

  const policy = approvalPolicy({
    admins: await approvalBench(env), requesterId: advance.cancel_requested_by, billFlat: advance.flat,
  });
  const verdict = canApprove({
    policy, approver: session.actor,
    request: { status: 'pending', requested_by: advance.cancel_requested_by, requested_at: advance.cancel_requested_at },
  });
  if (!verdict.ok) {
    await reportError(env, verdict.code, { advanceId: id, actor: session.actor.id, reason: verdict.reason });
    return problem(403, verdict.code,
      verdict.reason === 'requester' ? 'You requested this cancel, so you cannot approve it.'
      : verdict.reason === 'too-soon' ? `An admin still has ${verdict.hoursLeft}h to answer.`
      : 'This is not yours to approve.');
  }

  const now = new Date().toISOString();

  if (decision === 'reject') {
    // Clear the pending-cancel fields; the advance stays approved and live.
    await env.DB.prepare(
      `UPDATE maint_advances
          SET cancel_requested_by = NULL, cancel_requested_at = NULL, cancel_reason = NULL,
              cancel_late_fee = NULL, cancel_late_fee_from = NULL
        WHERE id = ? AND cancelled_at IS NULL`
    ).bind(id).run();
    await audit(env, session, 'maint.advance.cancel.reject', { advanceId: id, flat: advance.flat });
    return json({ ok: true, status: 'cancel-rejected' });
  }

  // Apply: soft-cancel the advance, then reopen the bills it had settled.
  await env.DB.prepare(
    `UPDATE maint_advances SET cancelled_at = ?, cancelled_by = ?
      WHERE id = ? AND cancelled_at IS NULL AND cancel_requested_by <> ?`
  ).bind(now, session.actor.id, id, session.actor.id).run();

  const { reopened } = await revertBillsSettledByAdvance(env, { advance, now });

  await audit(env, session, 'maint.advance.cancel.approve',
    { advanceId: id, flat: advance.flat, cancelledBy: session.actor.id,
      reopened: reopened.map((b) => b.quarter),
      lateFee: advance.cancel_late_fee, lateFeeFrom: advance.cancel_late_fee_from });
  return json({ ok: true, status: 'cancelled', reopened });
}

/* ── a tenant moving out ─────────────────────────────────────────────────
   Recording a departure re-rates the quarter, moves an unpaid bill to somebody
   who did not incur it, switches who the letters go to, and takes away a
   login. 0045 holds it until a second admin agrees, for the reason 0029 held a
   bill edit: one person should not be able to do all of that from a card while
   nobody is looking.                                                          */

/** The consequences, recomputed for whatever the dialog currently says. */
async function previewDeparture(request, env) {
  const body = await readJson(request);
  const inputs = await departureInputs(env, Number(body?.personId));
  if (!inputs) return problem(404, 'DDP-ADMIN-004', 'No such resident.');
  if (inputs.person.relationship !== 'tenant') {
    return problem(400, 'DDP-ADMIN-004', 'That is not a tenancy.');
  }

  const movedOutOn = String(body?.movedOutOn ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(movedOutOn)) {
    return problem(400, 'DDP-MAINT-002', 'Pick the date they left.');
  }
  const becomes = ['owner', 'tenant', 'empty'].includes(body?.becomes) ? body.becomes : 'owner';

  // Computed on the server and rendered by the browser, never the other way
  // round: the dialog and the approval a week later must describe the same
  // consequences, and a second copy of this in admin-console.js would be a
  // dialog that quietly stopped agreeing with the request it produced.
  return json(describeDeparture({ ...inputs, becomes, movedOutOn }));
}

/** Raise the request. Nothing about the tenancy changes here. */
async function requestDeparture(request, env, session) {
  const body = await readJson(request);
  const personId = Number(body?.personId);
  const inputs = await departureInputs(env, personId);
  if (!inputs) return problem(404, 'DDP-ADMIN-004', 'No such resident.');
  if (inputs.person.relationship !== 'tenant' || !inputs.person.active) {
    return problem(400, 'DDP-ADMIN-004', 'That is not a tenancy that could end.');
  }

  const movedOutOn = String(body?.movedOutOn ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(movedOutOn)) {
    return problem(400, 'DDP-MAINT-002', 'Pick the date they left.');
  }
  const becomes = ['owner', 'tenant', 'empty'].includes(body?.becomes) ? body.becomes : null;
  if (!becomes) return problem(400, 'DDP-ADMIN-004', 'Say what the flat becomes.');
  const reason = String(body?.reason ?? '').trim();
  if (!reason) return problem(400, 'DDP-ADMIN-004', 'Say why, for the record.');

  const plan = describeDeparture({ ...inputs, becomes, movedOutOn });
  const now = new Date().toISOString();

  // The open-request index (0045) is a UNIQUE partial, so a second one raises a
  // constraint error rather than a duplicate. Answered here as a sentence,
  // because two admins filing different dates for the same departure is a
  // disagreement to resolve rather than a fault.
  const existing = await env.DB.prepare(
    "SELECT id FROM tenancy_change_requests WHERE person_id = ? AND status = 'pending'"
  ).bind(personId).first();
  if (existing) {
    return problem(409, 'DDP-ADMIN-017',
      'A departure is already waiting for approval for this person. Answer or withdraw that one first.');
  }

  const created = await env.DB.prepare(
    `INSERT INTO tenancy_change_requests
       (person_id, flat, kind, moved_out_on, becomes, reason, plan, requested_by, requested_at, expires_at)
     VALUES (?, ?, 'moved-out', ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(personId, inputs.person.flat, movedOutOn, becomes, reason.slice(0, 300),
    JSON.stringify(plan), session.actor.id, now, expiresAt(now)).first();

  await audit(env, session, 'tenancy.depart.request',
    { requestId: created.id, personId, flat: inputs.person.flat, movedOutOn, becomes });

  return json({ requestId: created.id, status: 'pending', ...plan }, { status: 201 });
}

/** Open departures, with everything an approver needs to judge one. */
async function listDepartureRequests(env, session) {
  const rows = await env.DB.prepare(
    `SELECT r.*, p.name AS person_name, o.name AS requested_by_name,
            (SELECT COUNT(*) FROM tenancy_change_approvals a
              WHERE a.request_id = r.id AND a.decision = 'approve') AS approvals
       FROM tenancy_change_requests r
       JOIN owners p ON p.id = r.person_id
       LEFT JOIN owners o ON o.id = r.requested_by
      WHERE r.status = 'pending'
      ORDER BY r.requested_at`
  ).all();

  const bench = await approvalBench(env);
  const out = (rows.results ?? []).map((r) => {
    const policy = approvalPolicy({ admins: bench, requesterId: r.requested_by, billFlat: r.flat });
    const verdict = canApprove({ policy, approver: session.actor, request: r });
    return {
      ...r,
      // The snapshot the requester was shown, so an approver agrees to the same
      // consequences rather than to a sentence summarising them.
      plan: safeJson(r.plan),
      required: policy.required,
      canApprove: verdict.ok,
      substitute: verdict.substitute ?? false,
      blockedBecause: verdict.ok ? null : verdict.reason,
      hoursLeft: verdict.hoursLeft ?? null,
    };
  });
  return json({ requests: out });
}

async function decideDeparture(env, session, path, decision) {
  const id = Number(path.split('/')[5]);
  const req = await env.DB.prepare('SELECT * FROM tenancy_change_requests WHERE id = ?')
    .bind(id).first();
  if (!req) return problem(404, 'DDP-ADMIN-017', 'No such request.');

  // Lapsed on read, as the bill-edit queue does: the expiry only has to be true
  // at the moment somebody acts on it, and a cron for it would be one more
  // thing to fail quietly.
  if (req.status === 'pending' && Date.parse(req.expires_at) < Date.now()) {
    await env.DB.prepare(
      "UPDATE tenancy_change_requests SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'"
    ).bind(new Date().toISOString(), id).run();
    return problem(409, 'DDP-ADMIN-017', 'That departure has lapsed. Raise it again if it still stands.');
  }
  if (req.status !== 'pending') {
    return problem(409, 'DDP-ADMIN-017', `That departure is already ${req.status}.`);
  }

  const policy = approvalPolicy({
    admins: await approvalBench(env), requesterId: req.requested_by, billFlat: req.flat,
  });
  const verdict = canApprove({ policy, approver: session.actor, request: req });
  if (!verdict.ok) {
    await reportError(env, verdict.code, { requestId: id, actor: session.actor.id, reason: verdict.reason });
    return problem(403, verdict.code,
      verdict.reason === 'requester' ? 'You raised this, so you cannot approve it.'
      : verdict.reason === 'too-soon' ? `An admin still has ${verdict.hoursLeft}h to answer.`
      : 'This is not yours to approve.');
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO tenancy_change_approvals (request_id, approver_id, decision, substitute, at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (request_id, approver_id) DO UPDATE SET
       decision = excluded.decision, at = excluded.at, substitute = excluded.substitute`
  ).bind(id, session.actor.id, decision, verdict.substitute ? 1 : 0, now).run();

  if (decision === 'reject') {
    await env.DB.prepare(
      "UPDATE tenancy_change_requests SET status = 'rejected', resolved_at = ? WHERE id = ?"
    ).bind(now, id).run();
    await audit(env, session, 'tenancy.depart.reject', { requestId: id, personId: req.person_id });
    return json({ ok: true, status: 'rejected' });
  }

  const approvals = await env.DB.prepare(
    'SELECT approver_id, decision FROM tenancy_change_approvals WHERE request_id = ?'
  ).bind(id).all();
  if (!isSatisfied(policy, approvals.results ?? [])) {
    const yes = (approvals.results ?? []).filter((a) => a.decision === 'approve').length;
    await audit(env, session, 'tenancy.depart.approve',
      { requestId: id, personId: req.person_id, yes });
    return json({ ok: true, status: 'pending', approvals: yes, required: policy.required });
  }

  return applyDeparture(env, session, { req, id, now });
}

/**
 * The last approval lands: now, and only now, the tenancy ends.
 *
 * RECOMPUTED, NOT REPLAYED. The snapshot in `plan` is what the approvers agreed
 * to and it is kept for that reason, but a week may have passed and a bill may
 * have been paid, waived or cancelled in it. Applying the snapshot would move
 * money that has since settled; applying a fresh plan and recording both is
 * what lets somebody afterwards see that the two differed and why.
 */
async function applyDeparture(env, session, { req, id, now }) {
  const inputs = await departureInputs(env, req.person_id);
  if (!inputs) return problem(404, 'DDP-ADMIN-004', 'That resident no longer exists.');

  const fresh = describeDeparture({
    ...inputs, becomes: req.becomes, movedOutOn: req.moved_out_on,
  });

  const writes = [];

  for (const plan of fresh.plans) {
    if (plan.action === 're-rate') {
      writes.push(env.DB.prepare(
        `UPDATE maint_bills
            SET basis = ?, rate_applied = ?, total = ?, owner_id = COALESCE(?, owner_id),
                reassigned_from_id = ?, reassigned_at = ?
          WHERE id = ?`
      ).bind(plan.basis, plan.rate, plan.total, plan.billedTo, plan.reassignedFrom, now, plan.billId));
    } else if (plan.action === 'reassign' && plan.billedTo) {
      // A reassignment with NO billedTo is the tenant-to-tenant case, which
      // planOccupancyChange deliberately refuses to decide: who carries a bill
      // raised against a departed tenant is not something arithmetic can
      // answer, and guessing it puts somebody else's debt on their screen. It
      // is left alone here and picked up on the Maintenance tab.
      writes.push(env.DB.prepare(
        `UPDATE maint_bills SET owner_id = ?, reassigned_from_id = ?, reassigned_at = ? WHERE id = ?`
      ).bind(plan.billedTo, plan.reassignedFrom, now, plan.billId));
    }
  }

  writes.push(env.DB.prepare(
    "UPDATE tenancy_change_requests SET status = 'applied', resolved_at = ? WHERE id = ?"
  ).bind(now, id));

  // The departure itself, spelled the one way this codebase has spelled it
  // since 0003: active = 0, with moved_out_at recording when. isResidentOn
  // reads exactly these two and nothing else.
  //
  // LAST IN THE BATCH, AND IMMEDIATELY BEFORE THE SESSIONS GO. On 2026-09-11
  // nine deactivated accounts on production still held thirty live sessions
  // because nothing ended them, and a departure that left somebody signed in
  // would be that bug with a dialog in front of it. The two statements are kept
  // within sight of each other so the guard in session-inactive.test.js can see
  // that they are — the test reads the source, and it is right to.
  writes.push(env.DB.prepare('UPDATE owners SET active = 0, moved_out_at = ? WHERE id = ?')
    .bind(req.moved_out_on, req.person_id));

  await env.DB.batch(writes);
  await destroyAllSessionsFor(env, req.person_id);

  await audit(env, session, 'tenancy.depart.apply', {
    requestId: id, personId: req.person_id, flat: req.flat,
    movedOutOn: req.moved_out_on, becomes: req.becomes,
    bills: fresh.plans.map((p) => ({ billId: p.billId, action: p.action })),
    // Said out loud when the world moved under the request, which is the thing
    // an auditor wants to find rather than to deduce.
    changedSinceRequest: JSON.stringify(safeJson(req.plan)?.plans ?? []) !== JSON.stringify(fresh.plans),
  });

  return json({ ok: true, status: 'applied', applied: fresh.plans, lines: fresh.lines });
}

/** A stored JSON column, read without letting one bad row take down a queue. */
function safeJson(text) {
  try { return JSON.parse(text ?? 'null'); } catch { return null; }
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
  //
  // The pw_* columns are not for the policy — they are for the reuse check
  // below, which is the one that stops the temporary password being kept.
  const account = await env.DB.prepare(
    `SELECT mobile, flat, role, pw_hash, pw_salt, pw_iterations, must_change_pw
       FROM owners WHERE id = ?`
  ).bind(session.actor.id).first();
  validateNewPassword(password, { ...account, name, email });
  await refuseReusedPassword(env, session.actor.id, password, account);

  await archivePassword(env, session.actor.id, account);
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
  const typed = String(body?.email ?? '').trim();
  if (!name) return problem(400, 'DDP-NOTICE-003', 'Your name cannot be blank.');
  // Onboarding validates the address and this used to write it raw. It ends up
  // in a To: header, so a line break in it is a Bcc: of the resident's choosing.
  const email = typed ? normaliseEmail(typed) : null;
  if (typed && !email) {
    return problem(400, 'DDP-NOTICE-003', 'That email address looks wrong. Check it, or leave it blank.');
  }

  await env.DB.prepare('UPDATE owners SET name = ?, email = ? WHERE id = ?')
    .bind(name, email, session.actor.id).run();
  await audit(env, session, 'profile.update', { name, email });
  return json({ name, email });
}

async function postNotice(request, env, session, ctx) {
  const b = await readJson(request);
  const title = String(b?.title ?? '').trim();
  const body = String(b?.body ?? '').trim();
  if (!title || !body) return problem(400, 'DDP-NOTICE-003', 'A notice needs a title and a body.');

  // Anything unrecognised becomes 'all'. Defaulting the other way would let a
  // typo quietly narrow the audience, and a notice nobody sees is a failure
  // that looks exactly like a notice nobody replied to.
  const scope = NOTICE_SCOPES.includes(b?.scope) ? b.scope : 'all';

  // The ACTOR, always — under view-as the author is the admin doing the
  // typing, not the resident whose screen they borrowed. Recording it the
  // other way would put a resident's name on a notice they never wrote.
  const row = await env.DB.prepare(
    `INSERT INTO notices (title, body, kind, event_date, allow_comments, scope, active, posted_at, posted_by)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING id`
  ).bind(title, body, b?.kind === 'event' ? 'event' : 'notice',
         b?.eventDate ?? null, b?.allowComments ? 1 : 0, scope,
         new Date().toISOString(), session.actor.id).first();

  await audit(env, session, 'notice.create', { id: row.id, title, scope });

  // Fire-and-forget, ALWAYS. A notice that reached 99 residents' boards has
  // succeeded whatever Telegram thinks; awaiting this would let a down bot or
  // a rotated token turn a working publish into a 500 the committee reads as
  // "it didn't post", and the retry would then post it twice.
  announceNotice(env, session, { id: row.id, title, scope, kind: b?.kind === 'event' ? 'event' : 'notice' }, ctx);

  return json({ id: row.id }, { status: 201 });
}


/**
 * Owners with an address, one per flat — the size of a poll's mailing.
 *
 * Deliberately the same shape as `mailableOwners` in lib/polls.js, which
 * builds the actual queue. If one changes, change both: a warning computed
 * from a different population than the send is a warning about nothing.
 */
async function mailableOwnerCount(env) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT o.flat FROM owners o
        WHERE o.active = 1 AND o.relationship != 'tenant'
          AND o.email IS NOT NULL AND TRIM(o.email) != ''
        GROUP BY o.flat)`
  ).first();
  return row?.n ?? 0;
}

/* ── polls ─────────────────────────────────────────────────────────────── */

/**
 * Cast or change a flat's vote.
 *
 * The subject, never the client, says which flat is voting — invariant 4. A
 * request carrying `flat` would be a request that can vote as somebody else.
 */
async function castPollVote(request, env, session, path) {
  const pollId = Number(path.split('/')[3]);
  const b = await readJson(request);
  const ids = Array.isArray(b?.options) ? b.options : [b?.option];

  try {
    const cast = await castVote(env, {
      pollId, optionIds: ids.filter((x) => x != null), viewer: session.subject,
    });
    // The flat, not the person: the flat is what voted, and an audit row
    // naming only the actor would lose which flat's answer changed.
    await audit(env, session, 'poll.vote', { pollId, flat: session.subject.flat });
    return json({ ok: true, options: cast });
  } catch (err) {
    // The maintenance block gets its own sentence. The card on the poll already
    // explains it, so reaching here means the screen and the rule disagreed —
    // a stale tab, or somebody calling the API by hand — and "that vote could
    // not be recorded" would leave a resident with no idea why. PLACEHOLDER
    // COPY, like the rest of this feature's resident-visible wording.
    if (err?.code === 'DDP-POLL-010') {
      return problem(409, 'DDP-POLL-010',
        'This flat has maintenance outstanding from a closed quarter, so it cannot vote yet. '
        + 'The vote unlocks as soon as the treasurer confirms payment.');
    }
    // The validation message is the useful half — it names what to change.
    return problem(400, err?.code ?? 'DDP-POLL-005',
      err?.detail?.message ?? 'That vote could not be recorded.');
  }
}

/**
 * Post a poll, and queue the letter that tells the owners it exists.
 *
 * A committee member may reach this (see committeeMayUse) and their own id is
 * stamped on the row, which is what later lets them manage this poll and no
 * other.
 */
async function postPoll(request, env, session, ctx) {
  const b = await readJson(request);
  let id;
  try {
    id = await createPoll(env, {
      title: b?.title, body: b?.body,
      multi: Boolean(b?.multi), maxChoices: b?.maxChoices ?? null,
      showTenants: Boolean(b?.showTenants),
      closesAt: b?.closesAt, options: b?.options ?? [],
      noticeId: b?.noticeId ?? null,
      createdBy: session.actor.id,
    });
  } catch (err) {
    return problem(400, err?.code ?? 'DDP-POLL-005',
      err?.detail?.message ?? 'That poll could not be posted.');
  }

  await audit(env, session, 'poll.create', { id, title: b?.title });
  // Fire-and-forget, like a notice announcement: 89 rows must not be written
  // inside the request that posted the poll, and a queue that failed to fill
  // is a poll nobody was told about rather than a poll that was not created.
  ctx?.waitUntil?.(queuePollMail(env, id, 'opened').catch(() => {}));
  return json({ id }, 201);
}

/**
 * Edit an open poll.
 *
 * The ownership check is the same one close and publish make, and it is made
 * here rather than inside updatePoll for the same reason it is in managePoll:
 * `canManagePoll` asks about the ACTOR, and lib/polls.js is handed a session's
 * subject nowhere else. Keeping the two apart is what stops a rule about who
 * may write drifting into a module about what a poll is.
 */
async function patchPoll(request, env, session, path) {
  const id = Number(path.split('/')[4]);
  const poll = await env.DB.prepare('SELECT id, created_by FROM polls WHERE id = ?')
    .bind(id).first();
  if (!poll) return problem(404, 'DDP-POLL-001', 'That poll could not be found.');

  if (!canManagePoll(poll, session.actor)) {
    await reportError(env, 'DDP-ADMIN-004', { pollId: id, actor: session.actor.id });
    return problem(403, 'DDP-ADMIN-004', 'You can only manage a poll you posted.');
  }

  const b = await readJson(request);
  // Only the keys actually sent are treated as edits. Spreading the whole body
  // would let an absent field read as "set this to undefined" and quietly wipe
  // a description the editor never touched.
  const patch = {};
  for (const key of ['title', 'body', 'closesAt', 'showTenants', 'multi', 'maxChoices',
                     'options', 'noticeId']) {
    if (b?.[key] !== undefined) patch[key] = b[key];
  }
  if (!Object.keys(patch).length) return json({ ok: true, changed: false });

  try {
    await updatePoll(env, id, patch);
  } catch (err) {
    const code = err?.code ?? 'DDP-POLL-005';
    const message = err?.detail?.message
      ?? (code === 'DDP-POLL-006'
        ? 'The options froze when the first vote was cast. You can still change the title and the description.'
        : code === 'DDP-POLL-008'
          ? 'This poll has closed. A closed poll is a record and cannot be edited.'
          : 'That change could not be saved.');
    return problem(code === 'DDP-POLL-005' ? 400 : 409, code, message);
  }

  // The keys, never the values: a poll's body can be two thousand characters
  // and the audit log is read by people, not machines.
  await audit(env, session, 'poll.edit', { id, fields: Object.keys(patch) });
  return json({ ok: true, changed: true });
}

/**
 * Close, publish, or withdraw a published result.
 *
 * One handler because the three share their whole preamble — find the poll,
 * check this actor may manage THIS poll, act, record it. Split into three,
 * the ownership check is three chances to forget it once.
 */
async function managePoll(env, session, path, action) {
  const id = Number(path.split('/')[4]);
  const poll = await env.DB.prepare('SELECT id, created_by FROM polls WHERE id = ?')
    .bind(id).first();
  if (!poll) return problem(404, 'DDP-POLL-001', 'That poll could not be found.');

  // An admin manages any poll; a committee member manages the ones they
  // posted. Asked of the ACTOR, because this decides a write.
  if (!canManagePoll(poll, session.actor)) {
    await reportError(env, 'DDP-ADMIN-004', { pollId: id, actor: session.actor.id });
    return problem(403, 'DDP-ADMIN-004', 'You can only manage a poll you posted.');
  }

  try {
    if (action === 'close') await closePoll(env, id);
    else if (action === 'publish') await publishPoll(env, id);
    else await unpublishPoll(env, id);
  } catch (err) {
    return problem(409, err?.code ?? 'DDP-POLL-002',
      action === 'close'
        ? 'That poll has already closed.'
        : 'A poll cannot be published until voting has closed.');
  }
  await audit(env, session, `poll.${action}`, { id });
  return json({ ok: true });
}

/**
 * The ballot — which flat voted for what, and which owner cast it.
 *
 * THE AUDIT ROW IS WRITTEN BEFORE THE ROWS ARE RETURNED, and that order is the
 * point. Invariant 7: unlimited power is only safe to hand somebody if the
 * record of using it is automatic. Written first so a read that fails midway
 * has still been recorded as an attempt to look.
 */
async function pollBallot(env, session, path) {
  const id = Number(path.split('/')[4]);
  await audit(env, session, 'poll.ballot.open', { pollId: id });
  try {
    return json({ ballot: await getBallot(env, id) });
  } catch (err) {
    return problem(409, err?.code ?? 'DDP-POLL-007',
      'The ballot opens once voting has closed.');
  }
}

/**
 * Tell the committee, as it happens, that a notice just went out.
 *
 * postToTelegram and NOT reportError, on the same reasoning as
 * announceLargeUpload above: publishing is the feature working, not failing.
 * Through the error path it would land in error_log with a severity on it, and
 * an alert channel carrying normal events stops being read.
 *
 * The id leads because it is the durable handle. audit() has just written the
 * same number against notice.create, and the manage bar prints it as
 * `Notice #N`, so a committee member reporting a problem, the log row and this
 * message all name one thing.
 *
 * SCOPE IS SPELLED OUT rather than passed through raw. It is the field most
 * likely to be wrong and the one whose mistake is invisible from the inside —
 * 'owners' reads as a successful post to everyone who can see it, and the
 * people who cannot are the ones who would have told you.
 */
function announceNotice(env, session, { id, title, scope, kind }, ctx) {
  const send = () => postToTelegram(env, [
    `NOTICE #${id} POSTED${kind === 'event' ? ' · EVENT' : ''}`,
    title,
    scope === 'owners' ? 'Owners only — hidden from tenants' : 'Everyone in the building',
    `by ${session.actor.name ?? 'someone'} · flat ${session.actor.flat ?? '?'}`,
    `\n${new Date().toISOString()}`,
  ].join('\n')).catch(() => {});

  if (ctx?.waitUntil) ctx.waitUntil(send());
  else send();
}

async function patchNotice(request, env, session, path) {
  const id = Number(path.split('/')[4]);

  // Yours to change? An admin's answer is always yes; a committee member's is
  // yes only for a notice they posted. Fetched before the body is parsed so a
  // refusal costs one query and says nothing about what was attempted.
  const owned = await env.DB.prepare('SELECT id, posted_by FROM notices WHERE id = ?')
    .bind(id).first();
  if (!owned) return problem(404, 'DDP-NOTICE-001', 'That notice could not be found.');
  if (!canManageNotice(owned, session.actor)) {
    await reportError(env, 'DDP-ADMIN-004', { noticeId: id, actor: session.actor.id });
    return problem(403, 'DDP-ADMIN-004', 'You can only change a notice you posted.');
  }

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
  const notice = await env.DB.prepare(
    'SELECT id, posted_by FROM notices WHERE id = ? AND active = 1'
  ).bind(noticeId).first();
  if (!notice) return problem(404, 'DDP-NOTICE-001', 'That notice could not be found.');
  // Same rule as editing the words. A file on a notice is part of the notice.
  if (!canManageNotice(notice, session.actor)) {
    await reportError(env, 'DDP-ADMIN-004', { noticeId, actor: session.actor.id });
    return problem(403, 'DDP-ADMIN-004', 'You can only add files to a notice you posted.');
  }
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

  // A committee member may take back a file they attached to their own notice.
  // They may NOT touch a file hanging off a comment: that is a resident's
  // photograph and removing it is a moderation act, which is an admin's job
  // and nothing to do with posting notices. `notice_id` being null is exactly
  // that case, and canManageNotice(null, …) refuses it for them.
  if (session.actor.role === 'committee') {
    const parent = row.notice_id
      ? await env.DB.prepare('SELECT id, posted_by FROM notices WHERE id = ?')
          .bind(row.notice_id).first()
      : null;
    if (!canManageNotice(parent, session.actor)) {
      await reportError(env, 'DDP-ADMIN-004', { attachmentId: id, actor: session.actor.id });
      return problem(403, 'DDP-ADMIN-004', 'You can only remove a file from a notice you posted.');
    }
  }

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

  // A flat holds three owner logins and two tenant ones — joint owners and a
  // couple renting, each with their own password rather than a shared one.
  // Past that the roster stops describing the building, so it is refused here
  // and again by a trigger in migration 0040.
  const { results: onFlat } = await env.DB.prepare(
    'SELECT id, flat, relationship, active, role FROM owners WHERE flat = ?'
  ).bind(flat).all();
  const room = roomFor(onFlat ?? [], relationship);
  if (!room.ok) {
    await reportError(env, 'DDP-ADMIN-021', { flat, relationship, used: room.used });
    return problem(409, 'DDP-ADMIN-021', room.message);
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

/**
 * One person leaves a flat that somebody else in their household still lives in.
 *
 * The occupancy dropdown answers "who lives in 5B" as a whole — owner, owner
 * and tenant, or nobody — and every one of its transitions empties a party at a
 * time. That was the only shape a flat could have when a party was one person.
 * With three owners on a flat, "one of them has moved out" is not a change of
 * occupancy at all: the flat is still owner-occupied, still billed, and the
 * dropdown has nothing to say about it.
 *
 * THE LAST OF A PARTY IS REFUSED HERE, deliberately. Removing them changes what
 * the flat IS, and that question carries others the dropdown asks and this
 * route does not: does the flat keep being billed, who is liable now, is this a
 * sale. A button that quietly emptied a flat would be answering them by
 * omission.
 */
async function departResident(request, env, session, path) {
  const id = Number(path.split('/')[4]);
  const b = await readJson(request);

  const target = await env.DB.prepare(
    'SELECT id, name, flat, role, relationship, active FROM owners WHERE id = ?'
  ).bind(id).first();
  if (!target) return problem(404, 'DDP-AUTH-006', 'No such resident.');
  if (!target.active) return problem(409, 'DDP-ADMIN-003', `${target.name} has already moved out.`);

  const allowed = canEditResident({ actor: session.actor, target });
  if (!allowed.ok) {
    await reportError(env, 'DDP-ADMIN-014',
                      { actor: session.actor.id, target: id, targetRole: target.role });
    return problem(403, 'DDP-ADMIN-014', allowed.message);
  }

  const { results: people } = await env.DB.prepare(
    'SELECT id, flat, name, relationship, active, role FROM owners WHERE flat = ?'
  ).bind(target.flat).all();

  const heir = successorFor(people ?? [], target);
  if (!heir) {
    return problem(409, 'DDP-ADMIN-003',
      `${target.name} is the only ${target.relationship} of ${target.flat}. `
      + 'Use the occupancy control on the flat instead — it asks what happens to the '
      + 'billing, which removing the last one of them decides either way.');
  }

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE owners SET active = 0, moved_out_at = ? WHERE id = ?').bind(now, id),
    // Their unsettled bills go to the oldest account left in the household: a
    // bill naming a deactivated row is invisible to the people who still owe
    // it. Settled ones stay — that is the record of who paid.
    env.DB.prepare(
      `UPDATE bills SET owner_id = ? WHERE owner_id = ? AND status NOT IN ('paid', 'waived')`
    ).bind(heir.id, id),
  ]);
  // Every session that account holds, gone with it.
  await destroyAllSessionsFor(env, id);

  await audit(env, session, 'resident.depart', {
    id, flat: target.flat, relationship: target.relationship,
    billsTo: heir.id, reason: String(b?.reason ?? '').slice(0, 200) || null,
  });

  return json({ departed: { id, name: target.name, flat: target.flat }, billsTo: heir.name });
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
  const proof = await env.DB.prepare(
    'SELECT r2_key, maint_bill_id FROM payment_proofs WHERE id = ?'
  ).bind(id).first();
  if (!proof) return problem(404, 'DDP-PROOF-005', 'That submission could not be found.');

  if (proof.r2_key) await proofBucket(env, proof).delete(proof.r2_key).catch(() => {});
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
  // An open page saying where it is — not an event, so nothing goes into
  // `activity`. See functions/lib/presence.js.
  if (Object.hasOwn(PRESENCE_KINDS, b?.kind)) {
    await reportPresence(env, session.token, PRESENCE_KINDS[b.kind]);
    return json({ recorded: true });
  }
  const kind = ['page', 'action', 'client-error'].includes(b?.kind) ? b.kind : 'action';
  const name = String(b?.name ?? '').slice(0, 120);
  if (!name) return json({ recorded: false });
  // A page view is also the page saying it is open, which saves it a request.
  if (kind === 'page') await reportPresence(env, session.token, 'online');

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

/**
 * One device's presence. A goodbye is ignored when the row was written in the
 * last few seconds: that is the next page announcing itself before the old
 * page's pagehide arrived, and the device is not gone. Never allowed to fail
 * the request — before migration 0041 the columns do not exist.
 */
async function reportPresence(env, token, state) {
  const now = new Date();
  try {
    if (state === 'gone') {
      const floor = new Date(now.getTime() - LEAVE_GRACE_MS).toISOString();
      await env.DB.prepare(
        `UPDATE sessions SET presence = 'gone'
          WHERE token = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`
      ).bind(token, floor).run();
    } else {
      await env.DB.prepare('UPDATE sessions SET presence = ?, last_seen_at = ? WHERE token = ?')
        .bind(state, now.toISOString(), token).run();
    }
  } catch { /* presence is a nicety */ }
}

/**
 * Who is signed in, who has the portal open, and today's logins.
 * Superadmin only, through the /api/god/ gate.
 */
async function godSessions(env, session) {
  const now = new Date();
  const [sessions, owners, logins] = await Promise.all([
    env.DB.prepare('SELECT * FROM sessions WHERE expires_at > ?').bind(now.toISOString()).all(),
    env.DB.prepare('SELECT id, flat, name, role, relationship FROM owners').all(),
    // A day and a half back covers IST midnight whichever side of UTC's it is.
    env.DB.prepare(
      "SELECT actor_id, detail, at FROM audit_log WHERE action = 'login' AND at >= ?"
    ).bind(new Date(now.getTime() - 36 * 3600_000).toISOString()).all(),
  ]);
  const byId = new Map((owners.results ?? []).map((o) => [o.id, o]));
  const who = await signedInPeople({
    sessions: sessions.results ?? [], owners: byId, currentToken: session.token, now,
  });
  return json({
    generatedAt: toIST(now.toISOString()),
    ...who,
    logins: loginsToday({ logins: logins.results ?? [], owners: byId, now }),
  });
}

/**
 * Sign a person out of one device (`sessionId`) or all of them. Their god-mode
 * views of somebody else go too, since those rows carry them as the actor.
 */
async function godSignOut(request, env, session) {
  const b = await readJson(request);
  const ownerId = Number(b?.ownerId);
  const sessionId = b?.sessionId ? String(b.sessionId) : null;
  if (!Number.isInteger(ownerId)) return problem(400, 'DDP-ADMIN-003', 'Choose someone to sign out.');

  const owner = await env.DB.prepare('SELECT id, flat, name FROM owners WHERE id = ?')
    .bind(ownerId).first();
  if (!owner) return problem(404, 'DDP-ADMIN-001', 'No such person.');

  const live = await env.DB.prepare(
    'SELECT token FROM sessions WHERE actor_id = ? AND expires_at > ?'
  ).bind(ownerId, new Date().toISOString()).all();
  const verdict = await tokensToRevoke({
    sessions: live.results ?? [], sessionId, currentToken: session.token,
  });
  if (verdict.error) return problem(409, 'DDP-ADMIN-003', verdict.error);

  for (const token of verdict.tokens) await destroySession(env, token);
  await audit(env, session, 'god.signout', {
    ownerId, flat: owner.flat, devices: verdict.tokens.length, scope: sessionId ? 'one' : 'all',
  });
  return json({ signedOut: verdict.tokens.length });
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
          'SELECT at, code, severity, message, detail, context FROM error_log WHERE at > ? ORDER BY at DESC LIMIT ?'
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

  // ONE batch, and the outgoing owner goes out FIRST.
  //
  // Two reasons it is not three statements any more. A flat holds three owner
  // logins, so on a jointly owned flat the incoming row is the fourth until
  // the outgoing one is gone — inserted first, it is refused by the cap.
  // And these were separate writes: a failure between them left the flat with
  // both owners active, or with none, and the readers pick by id from whatever
  // is there. Deactivate, end their sessions, then insert, all or nothing.
  const [, , inserted] = await env.DB.batch([
    // Deactivated, never deleted: their bills, payments and comments must stay
    // attributable for the audit trail to mean anything.
    env.DB.prepare(
      "UPDATE owners SET active = 0, moved_out_at = ?, role = 'owner' WHERE id = ?"
    ).bind(now, outgoing.id),
    // Ends their access immediately — the flat is not theirs any more.
    env.DB.prepare('DELETE FROM sessions WHERE actor_id = ? OR subject_id = ?')
      .bind(outgoing.id, outgoing.id),
    env.DB.prepare(
      `INSERT INTO owners (flat, name, mobile, email, pw_hash, pw_salt, pw_iterations,
                           must_change_pw, pw_expires_at, role, active, moved_in_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'owner', 1, ?, ?) RETURNING id`
    ).bind(flat, String(b.name).trim(), mobile, b?.email ?? null, hash, salt, iterations,
           tempPasswordExpiry(TEMP_PW_HOURS), now, now),
  ]);
  const incoming = inserted.results?.[0] ?? null;

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
        'SELECT at, code, severity, message, detail, context FROM error_log ORDER BY at DESC LIMIT 20000').all(),
    ]);
    rows = mergeTimeline({
      audits: audits.results ?? [],
      activities: activities.results ?? [],
      errors: errors.results ?? [],
    }).map((r) => ({
      at_ist: r.atIST, kind: r.kind, event: r.name,
      actor: r.actor ?? '', subject: r.subject ?? '', flat: r.flat ?? '',
      severity: r.severity ?? '', detail: r.detail ?? '', context: r.context ?? '',
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
    return new Response(await dumpTable(env, table, { viewer: session.actor }), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="diamond-park-${table}-${stamp}.csv"`,
        'cache-control': 'no-store',
      },
    });
  }

  const files = await dumpAll(env, { viewer: session.actor });
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

  // Resolved through the SHARED rule, which finds the bill of either kind and
  // derives which it is from the record. The URL carries an id and nothing
  // else — a `kind` in it would be a thing somebody has to remember to check,
  // and that is where the old privacy bug lived.
  const found = await resolveBill(env, session.subject, billId);
  if (!found) return problem(404, 'DDP-PAY-001', 'That bill could not be found.');

  const bill = found.row;
  const isMaint = found.kind === 'maintenance';
  // `period` is what names the stored object and what the queue displays. A
  // quarter label serves both, so it stands in for the month here.
  bill.period = isMaint ? bill.quarter : bill.period;

  if (SETTLED_STATUSES.includes(bill.status)) {
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
    'SELECT id, bill_id, maint_bill_id FROM payment_proofs WHERE image_sha256 = ?'
  ).bind(hash).first();
  if (dupe) {
    await reportError(env, 'DDP-PROOF-001', { hash, billId, kind: found.kind, existing: dupe.id });
    // ACROSS BOTH KINDS. The same screenshot sent for a gas bill and then a
    // maintenance one is one payment claimed twice, and the ids are separate
    // sequences — so "is this the same bill" has to compare the id AND the
    // column it came from.
    const sameBill = isMaint ? dupe.maint_bill_id === bill.id : dupe.bill_id === bill.id;
    return problem(409, 'DDP-PROOF-001',
      sameBill
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

  // EXACTLY ONE of the two columns, which 0042 CHECKs. Passing the id to both
  // would be a payment counted twice and the database refuses it outright.
  const inserted = await env.DB.prepare(
    `INSERT INTO payment_proofs
       (bill_id, maint_bill_id, owner_id, r2_key, image_sha256, utr, parsed_amount, note, payer_name, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING id`
  ).bind(isMaint ? null : bill.id, isMaint ? bill.id : null,
         session.subject.id, key, hash, parsed.utr, parsed.amount,
         parsed.note, parsed.payer_name, now).first();

  try {
    // Maintenance proofs go to their own bucket. isMaint here is what the proof
    // row records as maint_bill_id, so upload and every later read agree on
    // which bucket holds the object — see proofBucket().
    await proofBucket(env, { maint_bill_id: isMaint ? bill.id : null })
      .put(key, bytes, { httpMetadata: { contentType: file.type } });
  } catch (err) {
    // Row exists, object doesn't: visible and recoverable, unlike the reverse.
    await reportError(env, 'DDP-PROOF-004', err, ctx);
    return problem(500, 'DDP-PROOF-004', 'We saved your submission but the image failed to store. The treasurer has been alerted.');
  }

  // `awaiting` is what takes the Pay button off the screen — for BOTH parties
  // on a let flat, because the status lives on the bill rather than on whoever
  // is looking at it. That is what stops an owner and their tenant each paying
  // the same bill after one of them has already sent a screenshot.
  await env.DB.prepare(
    isMaint
      ? "UPDATE maint_bills SET status = 'awaiting' WHERE id = ? AND status IN ('unpaid','initiated')"
      : "UPDATE bills SET status = 'awaiting' WHERE id = ? AND status IN ('unpaid','initiated')"
  ).bind(bill.id).run();

  await audit(env, session, 'proof.upload',
    { billId: bill.id, kind: found.kind, proofId: inserted.id, verdict: assessment.verdict });

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
  // LEFT JOINs to both, because a proof carries exactly one of the two ids and
  // an inner join to `bills` alone makes every maintenance screenshot a 404 —
  // including for the resident who uploaded it.
  const row = await env.DB.prepare(
    `SELECT p.r2_key, p.deleted_at, p.owner_id, p.maint_bill_id,
            COALESCE(b.flat, mb.flat) AS flat,
            COALESCE(b.owner_id, mb.owner_id) AS bill_owner_id
       FROM payment_proofs p
       LEFT JOIN bills b ON b.id = p.bill_id
       LEFT JOIN maint_bills mb ON mb.id = p.maint_bill_id
      WHERE p.id = ?`
  ).bind(proofId).first();

  if (!row) return problem(404, 'DDP-PROOF-005', 'That image could not be found.');

  // Ownership is by HOUSEHOLD. Matching on flat alone would hand the previous
  // owner's payment screenshots to whoever buys the flat next; matching on one
  // person hides a shared bill's receipt from the people who share it. Owners
  // and tenants are separate households, so a landlord still sees none of
  // their tenant's screenshots — the rule billAccess spells out.
  const uploader = row.owner_id ?? row.bill_owner_id;
  const { results: people } = await env.DB.prepare(
    'SELECT id, name, flat, relationship, active FROM owners WHERE flat = ?'
  ).bind(session.subject.flat).all();
  const mine = row.flat === session.subject.flat
    && uploader != null
    && householdIds(people ?? [], session.subject).includes(uploader);
  if (!mine && !hasRole(session, 'admin')) {
    await reportError(env, 'DDP-ADMIN-004', { proofId, actor: session.actor.id });
    return problem(403, 'DDP-ADMIN-004', 'Not yours to view.');
  }
  if (row.deleted_at || !row.r2_key) {
    return problem(410, 'DDP-PROOF-005', 'That image has been deleted.');
  }

  const object = await proofBucket(env, row).get(row.r2_key);
  if (!object) {
    await reportError(env, 'DDP-PROOF-005', { proofId, key: row.r2_key });
    return problem(404, 'DDP-PROOF-005', 'That image is missing from storage.');
  }

  // An admin looking at somebody's bank screenshot is recorded; the household
  // looking at its own receipt is not, exactly as before — what counts as
  // "their own" is now the household rather than the one uploader.
  if (!mine) await audit(env, session, 'proof.view', { proofId, flat: row.flat });

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

/**
 * The admin console's landing screen, in one request.
 *
 * Every figure here was already reachable — but only by opening the section it
 * lived in, which is why a pending correction could sit for a fortnight while
 * three admins each looked at a screen that never mentioned it. Home now states
 * them all, and the cost of that is exactly one query fan-out on arrival rather
 * than five separate round trips from the browser.
 *
 * Counts, not rows, with one exception: the overdue list carries its flats,
 * because chasing is the one job on this screen that has nowhere else to
 * happen. Everything else links out to the screen that owns it.
 */
async function adminSummary(env, session) {
  const today = istToday();
  const nowIso = new Date().toISOString();
  const latestEnded = latestEndedPeriod(today);

  const period = await env.DB.prepare(
    'SELECT * FROM periods ORDER BY period DESC LIMIT 1'
  ).first();

  // The month the board is reporting on. With no period row at all this is the
  // month waiting to be opened, so the readings and bills queries below return
  // honest zeroes rather than being skipped — one shape of response, whatever
  // state the building is in.
  const reporting = period?.period ?? latestEnded;

  const [saved, expected, billRows, overdue, proofs, edits, messages, contacts, batches] =
    await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS n FROM readings WHERE period = ?')
        .bind(reporting).first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM flats WHERE active = 1').first(),
      env.DB.prepare(
        'SELECT status, COUNT(*) AS n FROM bills WHERE period = ? GROUP BY status'
      ).bind(reporting).all(),
      // Across every period, not just this one: a bill from three months ago
      // that nobody chased is the whole reason this row exists.
      env.DB.prepare(
        `SELECT b.id, b.flat, b.period, b.total, p.due_date, o.name, o.email,
                (SELECT COUNT(*) FROM bill_reminders r WHERE r.bill_id = b.id) AS reminders,
                (SELECT MAX(sent_at) FROM bill_reminders r WHERE r.bill_id = b.id) AS last_reminded
           FROM bills b
           JOIN periods p ON p.period = b.period
           ${ownerJoin('b.owner_id')}
          WHERE b.status IN ('unpaid', 'initiated', 'awaiting')
            AND p.due_date < ?
          ORDER BY p.due_date, b.flat
          LIMIT 40`
      ).bind(today).all(),
      env.DB.prepare(
        "SELECT COUNT(*) AS n FROM payment_proofs WHERE status = 'pending' AND deleted_at IS NULL"
      ).first(),
      env.DB.prepare(
        "SELECT COUNT(*) AS n FROM bill_edit_requests WHERE status = 'pending'"
      ).first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE handled_at IS NULL').first(),
      // Superadmin-only, because only the superadmin can decide one. Counting a
      // queue an admin cannot act on would be a number that never moves for
      // them, which reads as a broken screen rather than as somebody else's job.
      hasRole(session, 'superadmin')
        ? env.DB.prepare("SELECT COUNT(*) AS n FROM contact_requests WHERE state = 'pending'").first()
        : Promise.resolve(null),
      env.DB.prepare('SELECT sent_at FROM reminder_batches WHERE period = ? ORDER BY sent_at')
        .bind(reporting).all(),
    ]);

  const bills = tallyByStatus(billRows.results ?? []);
  const readings = { saved: saved?.n ?? 0, expected: expected?.n ?? 0 };

  return json({
    today,
    period: period ?? null,
    // What the board asks for when there is no period: the month that ended and
    // still has no rate.
    awaiting: period && period.period >= latestEnded ? null : latestEnded,
    stage: boardStage({ period, latestEnded, readings, bills }),
    readings,
    bills,
    overdue: (overdue.results ?? []).map((b) => {
      // The console greys its button with the same arithmetic the send uses, so
      // the two cannot disagree about whether a flat may be chased.
      const decision = reminderDecision(reminderStamps(b), nowIso);
      return {
        id: b.id,
        flat: b.flat,
        period: b.period,
        total: b.total,
        name: b.name ?? null,
        dueDate: b.due_date,
        daysOver: daysOverdue(b.due_date, today),
        reminders: b.reminders ?? 0,
        lastReminded: b.last_reminded ?? null,
        // Blocked for a reason of its own — settled, or no address — outranks
        // the cap, because the cap is not why the button is off.
        canRemind: !reminderBlock(b, today) && decision.ok,
        blockedBecause: reminderBlock(b, today)
          ?? (decision.ok ? null : refusalText(decision)),
      };
    }),
    reminders: {
      max: MAX_REMINDERS,
      mailConfigured: mailConfigured(env),
      bulk: batchDecision((batches.results ?? []).map((r) => r.sent_at), nowIso),
    },
    waiting: {
      proofs: proofs?.n ?? 0,
      edits: edits?.n ?? 0,
      messages: messages?.n ?? 0,
      // null, not 0 — the board hides the row entirely for an admin rather
      // than showing them a queue that is never theirs.
      contacts: contacts ? contacts.n : null,
    },
    // Null most of the time, and that is the point: the card exists for the
    // seven days before a quarter goes out and disappears once it has.
    maintenance: await maintenanceCard(env, today),
  });
}

/**
 * The maintenance card for Admin Home, or nothing.
 *
 * Built from the same payload the Maintenance page uses, so the count of
 * tenancies needing confirmation on the card is the count the page will show
 * when they follow it. Two queries answering that question separately is how
 * the card ends up saying 3 and the page saying 4.
 *
 * Never allowed to break Admin Home. The card is the least important thing on
 * that screen and the board is the treasurer's way into everything else — so a
 * failure here costs the card, not the page.
 */
async function maintenanceCard(env, today) {
  try {
    const payload = await maintAdminPayload(env, null, { today });
    if (!payload?.row) return null;
    return adminHomeCard({
      quarter: payload.row, blocked: payload.blocked, preview: payload.preview, today,
    });
  } catch {
    return null;
  }
}

/**
 * The stamps reminderDecision needs, from a summary row that only carries the
 * count and the latest date.
 *
 * Only the last one matters to the spacing rule and only the count matters to
 * the cap, so the earlier entries can be anything — they are placeholders, and
 * the send path reads the real rows before it writes.
 */
function reminderStamps(row) {
  const n = Number(row.reminders ?? 0);
  if (!n) return [];
  return [...Array(n - 1).fill(row.last_reminded), row.last_reminded];
}

/* ── payment reminders ────────────────────────────────────────────────────
   The first mail this portal has ever sent a resident about money. Everything
   else it sends is a credential, or an alert to an admin.

   Three per bill, spaced 24/48/72 hours, and Remind-all spends the same three
   — one budget, so no household can receive a fourth however the clicks are
   spread between the row button and the bulk one. lib/reminders.js decides;
   these functions only fetch the rows, send, and write what happened.       */

/** A bill with everything a reminder needs to be written and refused. */
async function reminderContext(env, billId) {
  const bill = await env.DB.prepare(
    `SELECT b.*, p.due_date, o.name, o.email, o.id AS owner_row
       FROM bills b
       JOIN periods p ON p.period = b.period
       ${ownerJoin('b.owner_id')}
      WHERE b.id = ?`
  ).bind(billId).first();
  if (!bill) return null;

  const rows = await env.DB.prepare(
    'SELECT ordinal, sent_at FROM bill_reminders WHERE bill_id = ? ORDER BY ordinal'
  ).bind(billId).all();

  return { bill, sent: (rows.results ?? []).map((r) => r.sent_at) };
}

/**
 * Why this bill cannot be chased, or null if it can.
 *
 * Paid and not-yet-due are refusals in their own right, ahead of the cap: the
 * worst reminder this portal could send is one to somebody who already paid,
 * and a proof waiting in the queue means they have.
 */
function reminderBlock(bill, today) {
  if (['paid', 'waived'].includes(bill.status)) return 'This bill is settled.';
  if (bill.status === 'awaiting') return 'A payment proof for this bill is waiting to be checked.';
  if (!(bill.due_date < today)) return 'This bill is not overdue yet.';
  if (!bill.email) return 'No email address on file for this flat.';
  return null;
}

/**
 * Send one reminder.
 *
 * THE ROW IS WRITTEN BEFORE THE SEND, and removed if the send fails. Written
 * first because UNIQUE (bill_id, ordinal) is the only thing that makes two
 * simultaneous clicks safe — two tabs both reading "none sent yet" would
 * otherwise both pass the decision and both send. Removed on failure so a
 * Gmail outage does not silently eat one of a resident's three.
 */
async function remindOne(env, session, billId, batchId = null) {
  const context = await reminderContext(env, billId);
  if (!context) return problem(404, 'DDP-SYS-003', 'No such bill.');

  const { bill, sent } = context;
  const today = istToday();
  const blocked = reminderBlock(bill, today);
  if (blocked) return problem(409, 'DDP-ADMIN-019', blocked);

  const now = new Date().toISOString();
  const decision = reminderDecision(sent, now);
  if (!decision.ok) {
    await reportError(env, 'DDP-ADMIN-019',
                      { billId, reason: decision.reason, actor: session.actor.id });
    return problem(409, 'DDP-ADMIN-019', refusalText(decision));
  }

  if (!mailConfigured(env)) {
    return problem(503, 'DDP-ADMIN-020',
      'Email is not set up yet, so nothing can be sent. Nothing has been recorded.');
  }

  try {
    await env.DB.prepare(
      `INSERT INTO bill_reminders (bill_id, ordinal, sent_at, sent_by, sent_to, batch_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(billId, decision.ordinal, now, session.actor.id, bill.email, batchId).run();
  } catch {
    // The UNIQUE constraint, which means somebody else got there first.
    return problem(409, 'DDP-ADMIN-019', 'That reminder has just been sent by somebody else.');
  }

  const { subject, text, html } = reminderEmail({
    ordinal: decision.ordinal,
    name: bill.name,
    flat: bill.flat,
    period: bill.period,
    periodLabel: periodLabel(bill.period),
    total: bill.total,
    dueDate: bill.due_date,
    daysOver: daysOverdue(bill.due_date, today),
    previous: sent,
  });

  const result = await sendEmail(env, { to: bill.email, subject, text, html });
  if (!result.sent) {
    await env.DB.prepare(
      'DELETE FROM bill_reminders WHERE bill_id = ? AND ordinal = ?'
    ).bind(billId, decision.ordinal).run();
    await reportError(env, 'DDP-ADMIN-020',
                      { billId, flat: bill.flat, reason: result.reason });
    return problem(502, 'DDP-ADMIN-020',
      'The reminder could not be sent. Nothing has been recorded, so it can be tried again.');
  }

  await audit(env, session, 'bill.remind',
              { billId, flat: bill.flat, period: bill.period, ordinal: decision.ordinal });

  return json({
    billId,
    flat: bill.flat,
    ordinal: decision.ordinal,
    remaining: MAX_REMINDERS - decision.ordinal,
    sentAt: now,
  });
}

/** 'Waiting 13 more hours', or 'All three have been sent'. */
function refusalText(decision) {
  if (decision.reason === 'spent') {
    return `All ${MAX_REMINDERS} reminders for this bill have been sent. There is no fourth.`;
  }
  if (decision.reason === 'cooling') {
    return `The last reminder was too recent. ${decision.hoursLeft} hours to wait.`;
  }
  return 'When the last reminder was sent cannot be read, so nothing will be sent.';
}

/**
 * Remind every overdue flat that still has one, in one press.
 *
 * Twice a month, a day apart. The run is recorded even when it sends nothing,
 * because a press that skipped everybody has still used one of the two — and
 * because "I pressed it and nothing happened" needs an answer.
 *
 * What it skips is RETURNED, not swallowed. A bulk send that quietly reached
 * three of eleven is worse than one that reached none, because nobody would
 * know to chase the rest.
 */
async function remindAll(request, env, session) {
  const body = await readJson(request);
  const period = String(body?.period ?? '').trim();
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return problem(400, 'DDP-SYS-003', 'Which month?');
  }

  const runs = await env.DB.prepare(
    'SELECT sent_at FROM reminder_batches WHERE period = ? ORDER BY sent_at'
  ).bind(period).all();

  const now = new Date().toISOString();
  const decision = batchDecision((runs.results ?? []).map((r) => r.sent_at), now);
  if (!decision.ok) {
    await reportError(env, 'DDP-ADMIN-019',
                      { period, reason: decision.reason, actor: session.actor.id, bulk: true });
    return problem(409, 'DDP-ADMIN-019', decision.reason === 'spent'
      ? 'Remind-all has been used twice for this month. There is no third.'
      : `The last run was too recent. ${decision.hoursLeft} hours to wait.`);
  }

  if (!mailConfigured(env)) {
    return problem(503, 'DDP-ADMIN-020',
      'Email is not set up yet, so nothing can be sent. Nothing has been recorded.');
  }

  const today = istToday();
  const overdue = await env.DB.prepare(
    `SELECT b.id FROM bills b
       JOIN periods p ON p.period = b.period
      WHERE b.period = ? AND b.status IN ('unpaid', 'initiated')
        AND p.due_date < ?
      ORDER BY b.flat`
  ).bind(period, today).all();

  // The row goes in first, so a second press landing mid-run meets the cap
  // rather than a queue that has not finished counting itself.
  const batch = await env.DB.prepare(
    'INSERT INTO reminder_batches (period, sent_at, sent_by) VALUES (?, ?, ?) RETURNING id'
  ).bind(period, now, session.actor.id).first();

  const sent = [];
  const skipped = [];
  for (const row of overdue.results ?? []) {
    const res = await remindOne(env, session, row.id, batch.id);
    if (res.status === 200) sent.push(row.id);
    else skipped.push(row.id);
  }

  await env.DB.prepare('UPDATE reminder_batches SET sent = ?, skipped = ? WHERE id = ?')
    .bind(sent.length, skipped.length, batch.id).run();

  await audit(env, session, 'bill.remind.bulk',
              { period, sent: sent.length, skipped: skipped.length, run: decision.run });

  return json({
    period,
    sent: sent.length,
    skipped: skipped.length,
    runsLeft: 2 - decision.run,
  });
}

/**
 * The proof queue — ONE QUEUE, BOTH KINDS.
 *
 * Not forked, and that is the point rather than a convenience: two queues means
 * two half-lists and no way to tell which is authoritative, and the treasurer
 * reviewing screenshots is doing one job whatever bill each one answers. Each
 * row NAMES the bill it belongs to, which is what the filter in the browser
 * works on.
 *
 * A proof carries exactly one of `bill_id` and `maint_bill_id` — 0042 CHECKs
 * it — so the LEFT JOINs below can never both match, and COALESCE picks out the
 * one that did.
 */
async function proofQueue(env) {
  // The columns every row has, whichever kind of bill it answers. `kind` is
  // derived from which id is present rather than stored, so it cannot disagree
  // with the row it describes.
  const billColumns = `
    COALESCE(b.flat, mb.flat) AS flat,
    COALESCE(b.period, mb.quarter) AS period,
    CASE WHEN mb.id IS NULL THEN 'gas' ELSE 'maintenance' END AS kind,
    COALESCE(b.total, mb.total) AS total`;

  const [proofs, claimed, maintClaimed, decided] = await Promise.all([
    env.DB.prepare(
      `SELECT p.*, ${billColumns}, o.name
         FROM payment_proofs p
         LEFT JOIN bills b ON b.id = p.bill_id
         LEFT JOIN maint_bills mb ON mb.id = p.maint_bill_id
         ${ownerJoin('p.owner_id')}
        WHERE p.status = 'pending' AND p.deleted_at IS NULL
        ORDER BY p.created_at`
    ).all(),

    env.DB.prepare(
      // GROUP BY already collapsed the duplicate to one row here, so the count
      // was right — but which of the two names it showed was arbitrary.
      `SELECT b.id, b.flat, b.period, b.total, 'gas' AS kind, o.name,
              MAX(i.created_at) AS last_intent
         FROM bills b
         JOIN payment_intents i ON i.bill_id = b.id
         ${ownerJoin('b.owner_id')}
        WHERE b.status = 'initiated'
        GROUP BY b.id ORDER BY last_intent`
    ).all(),

    // Maintenance has no intents table — 0042 made `claimed_at` on the bill the
    // whole record of a claim, because its late fee does not hold on one. So
    // the same "they tapped Pay and nothing arrived" list comes off the stamp.
    env.DB.prepare(
      `SELECT b.id, b.flat, b.quarter AS period, b.total, 'maintenance' AS kind, o.name,
              b.claimed_at AS last_intent
         FROM maint_bills b
         ${ownerJoin('b.owner_id')}
        WHERE b.status = 'initiated' AND b.claimed_at IS NOT NULL
        ORDER BY b.claimed_at`
    ).all(),

    // Approving used to be the last anyone saw of a proof: the queue filters on
    // 'pending', so a decision removed the row from every screen in the system.
    // For a financial record that is not a display detail — a mistaken reject
    // left no trail, and nobody could confirm afterwards what they approved.
    // Capped rather than paged: the queue is a working screen, and the full
    // history belongs in god mode's timeline.
    env.DB.prepare(
      `SELECT p.*, ${billColumns}, o.name, r.name AS reviewer
         FROM payment_proofs p
         LEFT JOIN bills b ON b.id = p.bill_id
         LEFT JOIN maint_bills mb ON mb.id = p.maint_bill_id
         ${ownerJoin('p.owner_id')}
         LEFT JOIN owners r ON r.id = p.reviewed_by
        WHERE p.status IN ('approved', 'rejected') AND p.deleted_at IS NULL
        ORDER BY COALESCE(p.reviewed_at, p.created_at) DESC
        LIMIT 50`
    ).all(),
  ]);

  // Interleaved by when the claim was made, so the oldest unanswered tap is at
  // the top whichever kind of bill it was against.
  const claimedRows = [...(claimed.results ?? []), ...(maintClaimed.results ?? [])]
    .sort((a, b) => String(a.last_intent ?? '').localeCompare(String(b.last_intent ?? '')));

  return json(shapeQueue({
    proofs: proofs.results ?? [],
    claimed: claimedRows,
    decided: decided.results ?? [],
  }));
}

// ── bank statement reconciliation ───────────────────────────────────────
//
// The statement is working material. It is parsed on arrival, only its credit
// rows are kept, and those rows are deleted the moment the treasurer finishes
// — or by the 3am sweep if they walk away. The original file is never written
// anywhere: not to R2, not to D1. See migration 0017 and lib/statement.js.

/**
 * The two accounts a statement can come from.
 *
 * 0042 put maintenance in a DIFFERENT bank account from gas, so "the
 * statement" stopped being a single thing. An upload says which account it is,
 * and everything downstream — which proofs are eligible, which bills can be
 * settled, whether an amount means anything at all — follows from that one
 * word. Nothing is ever matched across the two: a gas claim cannot be settled
 * by maintenance money, and the screens do not offer the option.
 */
export const STATEMENT_ACCOUNTS = ['gas', 'maintenance'];

/** Unknown, missing or misspelt all read as gas, which is what every statement was before 0044. */
function statementAccount(value) {
  return STATEMENT_ACCOUNTS.includes(value) ? value : 'gas';
}

/**
 * What the account picker shows, with the payee as a quiet second line.
 *
 * THE SECOND LINE IS BUILT AT RUNTIME AND NEVER STORED. This repository is
 * public; `maintAccountHint` returns four digits and never the IFSC, for the
 * same reason the account number is a Pages secret rather than a var. Enough to
 * tell a treasurer which of two statements they are holding, which is all this
 * line is for.
 */
function statementAccountList(env, { maintenanceIssued }) {
  return [
    { id: 'gas', label: 'Gas', hint: env.UPI_VPA ?? null, ready: true },
    {
      id: 'maintenance', label: 'Maintenance', hint: maintAccountHint(env),
      // Shown even when there is nothing to reconcile yet, with an empty state
      // rather than a missing control. A tab that is not there reads as broken;
      // one that is there and says "no quarter has issued yet" reads as early.
      ready: maintenanceIssued,
    },
  ];
}

/** Everything the matcher needs about the current state of the books, for one account. */
async function reconciliationInputs(env, account = 'gas') {
  if (account === 'maintenance') {
    const [proofs, openBills] = await Promise.all([
      env.DB.prepare(
        // `period` rather than `quarter` in the alias, because the matcher and
        // every verdict shape downstream speak one word for "the billing window
        // this is about". 0042 chose separate tables, not a separate vocabulary.
        `SELECT p.id AS proofId, p.maint_bill_id AS billId, p.utr, p.parsed_amount AS claimedAmount,
                p.created_at AS createdAt, b.flat, b.quarter AS period, b.total AS billed, o.name
           FROM payment_proofs p
           JOIN maint_bills b ON b.id = p.maint_bill_id
           ${ownerJoin('p.owner_id')}
          WHERE p.status = 'pending' AND p.deleted_at IS NULL
          ORDER BY p.created_at`
      ).all(),
      env.DB.prepare(
        // A cancelled bill is deliberately not here. 0042 made cancellation the
        // way a bill raised against the wrong party is withdrawn, so offering it
        // as somewhere to put money would undo the withdrawal by the back door.
        `SELECT b.id, b.flat, b.quarter AS period, b.total, o.name
           FROM maint_bills b
           ${ownerJoin('b.owner_id')}
          WHERE b.status IN ('unpaid', 'initiated', 'awaiting')
          ORDER BY b.quarter, b.flat`
      ).all(),
    ]);
    return { proofs: proofs.results ?? [], openBills: openBills.results ?? [] };
  }

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

async function reportFor(env, sessionId, account = null) {
  const acct = account ?? statementAccount(
    (await env.DB.prepare('SELECT account FROM statement_sessions WHERE id = ?').bind(sessionId).first())?.account
  );
  const rows = await env.DB.prepare(
    'SELECT txn_date AS date, amount, reference, narration FROM statement_credits WHERE session_id = ? ORDER BY txn_date, id'
  ).bind(sessionId).all();
  const { proofs, openBills } = await reconciliationInputs(env, acct);
  const result = reconcile({
    credits: rows.results ?? [], proofs, openBills,
    // The whole no-fingerprint rule, expressed once. See lib/statement.js.
    amountIdentifiesPayer: acct !== 'maintenance',
  });

  if (acct === 'maintenance') await foldInAssignments(env, sessionId, result);

  // Bucketed HERE rather than in the browser, so the rule for "is this probably
  // a resident" lives in exactly one place. A second copy in admin-statement.js
  // would be a weaker restatement of a rule reconcile() already answered.
  return {
    ...result,
    account: acct,
    // The full open list, once for the whole report rather than once per credit.
    // Every maintenance credit of a given amount has the same candidates — that
    // is the problem, not an optimisation — so the picker that lets an admin
    // reach past the ranked five reads from one list.
    assignableBills: acct === 'maintenance' ? openBills : [],
    buckets: bucketReconciliation(result),
  };
}

/**
 * Put the assignments already made in this review back onto their credits.
 *
 * WITHOUT THIS THE SCREEN GOES BACKWARDS. Assigning marks the bill paid, which
 * takes it out of the open list — so on the next refresh the credit that was
 * just assigned would show with its candidates gone and nothing in their place,
 * reading as money nobody can explain. The reconciliation row written at assign
 * time is the record, and this reads it back.
 *
 * Matched on the three statement facts the row keeps — reference, amount, date.
 * The narration is deliberately not among them: 0017 refuses to store it,
 * because it names other members.
 */
async function foldInAssignments(env, sessionId, result) {
  const rows = await env.DB.prepare(
    `SELECT r.maint_bill_id AS billId, r.reference, r.amount, r.txn_date AS txnDate,
            b.flat, b.quarter AS period, b.total, o.name, a.name AS assignedByName
       FROM reconciliations r
       JOIN maint_bills b ON b.id = r.maint_bill_id
       LEFT JOIN owners o ON o.id = b.owner_id
       LEFT JOIN owners a ON a.id = r.assigned_by
      WHERE r.session_id = ? AND r.assigned_by IS NOT NULL`
  ).bind(sessionId).all();

  const key = (r) => `${r.reference ?? ''}|${Math.round((r.amount ?? 0) * 100)}|${r.txnDate ?? ''}`;
  const byCredit = new Map((rows.results ?? []).map((r) => [key(r), r]));

  for (const d of result.discrepancies) {
    if (d.kind !== 'credit_no_proof') continue;
    const hit = byCredit.get(key({ reference: d.reference, amount: d.amount, txnDate: d.txnDate }));
    if (!hit) continue;
    d.assignedTo = {
      billId: hit.billId, flat: hit.flat, name: hit.name,
      period: hit.period, total: hit.total, by: hit.assignedByName,
    };
    d.candidates = [];
  }

  // The tallies have to move with the assignments, and cannot be computed
  // inside `reconcile` — it is pure and has never heard of this session's
  // reconciliation rows. Leaving them alone was the bug this paragraph exists
  // to explain: after assigning ₹7,000 the screen still read "Confirmed 0" and
  // "Unexplained money in ₹34,542", which is the opposite of what the treasurer
  // had just done and exactly the figure they would have carried to the
  // committee.
  const assigned = result.discrepancies.filter((d) => d.kind === 'credit_no_proof' && d.assignedTo);
  const sum = (list) => Math.round(list.reduce((t, d) => t + (d.amount ?? 0), 0) * 100) / 100;
  result.totals = {
    ...result.totals,
    assignedCount: assigned.length,
    assignedTotal: sum(assigned),
    unmatchedCreditTotal:
      Math.round((result.totals.unmatchedCreditTotal - sum(assigned)) * 100) / 100,
  };
}

async function uploadStatement(request, env, session, ctx) {
  const form = await request.formData().catch(() => null);
  const file = form?.get('statement');
  if (!file || typeof file === 'string') {
    return problem(400, 'DDP-RECON-001', 'Attach the bank statement as CSV or PDF.');
  }
  const account = statementAccount(form?.get('account'));

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
    `INSERT INTO statement_sessions (created_by, filename, row_count, credit_total, status, account, created_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?) RETURNING id`
  ).bind(session.actor.id, String(file.name ?? '').slice(0, 120), credits.length, total, account, now).first();

  // Chunked: a year's statement is a few hundred rows and D1 batches are finite.
  for (let i = 0; i < credits.length; i += 50) {
    await env.DB.batch(credits.slice(i, i + 50).map((c) =>
      env.DB.prepare(
        'INSERT INTO statement_credits (session_id, txn_date, amount, reference, narration) VALUES (?, ?, ?, ?, ?)'
      ).bind(created.id, c.date, c.amount, c.reference, String(c.narration ?? '').slice(0, 300))));
  }

  const report = await reportFor(env, created.id, account);
  await audit(env, session, 'statement.upload',
    { sessionId: created.id, account, rows: credits.length, discrepancies: report.discrepancies.length });

  return json({ sessionId: created.id, warnings: warnings ?? [], ...report }, { status: 201 });
}

async function statementReport(env, path) {
  const id = Number(path.split('/')[4]);
  const row = await env.DB.prepare('SELECT id, status, filename, account, created_at FROM statement_sessions WHERE id = ?')
    .bind(id).first();
  if (!row) return problem(404, 'DDP-RECON-001', 'That reconciliation could not be found.');
  if (row.status !== 'open') {
    return problem(409, 'DDP-RECON-001', 'That reconciliation is closed — the statement has been deleted.');
  }
  return json({
    sessionId: id, filename: row.filename,
    ...(await reportFor(env, id, statementAccount(row.account))),
  });
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
  const row = await env.DB.prepare('SELECT id, status, account FROM statement_sessions WHERE id = ?').bind(id).first();
  if (!row) return problem(404, 'DDP-RECON-001', 'That reconciliation could not be found.');
  if (row.status !== 'open') return problem(409, 'DDP-RECON-001', 'That reconciliation is already closed.');

  const account = statementAccount(row.account);
  const isMaint = account === 'maintenance';
  const report = await reportFor(env, id, account);
  const now = new Date().toISOString();

  // 0017 gave the verdict table one bill column, pointing at `bills`. 0044
  // added the maintenance twin rather than widening that key, so which column a
  // verdict lands in is decided by the account the statement came from — the
  // same discriminator payment_proofs uses, read off the session instead of the
  // row. Writing a maint_bills id into `bill_id` would either fail the key or,
  // worse, silently name an unrelated gas bill with the same number.
  const billColumn = (billId) => (isMaint
    ? { billId: null, maintBillId: billId ?? null }
    : { billId: billId ?? null, maintBillId: null });

  const rows = [
    ...report.confirmed.map((c) => ({
      proofId: c.proofId, ...billColumn(c.billId), verdict: 'confirmed',
      reference: c.reference, amount: c.amount, txnDate: c.txnDate, matchedBy: c.how,
    })),
    ...report.discrepancies
      // An assigned credit already has its row, written the moment the admin
      // assigned it. Writing a second one here would double-count the money on
      // every report that reads this table afterwards.
      .filter((d) => d.assignedTo == null)
      .map((d) => ({
        proofId: d.proofId ?? null, ...billColumn(d.billId), verdict: d.kind,
        // Narration is deliberately not carried across: it names other members.
        reference: d.reference ?? null,
        amount: d.bankAmount ?? d.amount ?? null,
        txnDate: d.txnDate ?? null, matchedBy: null,
      })),
  ];

  for (let i = 0; i < rows.length; i += 50) {
    await env.DB.batch(rows.slice(i, i + 50).map((r) =>
      env.DB.prepare(
        `INSERT INTO reconciliations (session_id, proof_id, bill_id, maint_bill_id, verdict, reference, amount, txn_date, matched_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, r.proofId, r.billId, r.maintBillId, r.verdict, r.reference, r.amount, r.txnDate, r.matchedBy, now)));
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
    { sessionId: id, account, saved: rows.length, deletedRows: report.totals.creditRows });

  return json({ sessionId: id, saved: rows.length, statementDeleted: true, totals: report.totals });
}

/**
 * Assign a statement credit to a maintenance bill.
 *
 * WHY THIS EXISTS AT ALL. Gas settles itself: a ₹310.40 credit belongs to
 * whoever was billed ₹310.40, and the matcher says so. Maintenance cannot —
 * 0042 spells it out, forty-one flats owe the same rupee — so the last step is
 * a person reading the evidence and saying which flat this money is. This is
 * that step.
 *
 * ONE ADMIN, DELIBERATELY. The credit is the bank's own record that the money
 * arrived; assigning it is reading that evidence, which is the same act as
 * approving a payment screenshot and carries the same one signature. Asserting
 * a payment with NO bank evidence is a different act and 0042 gave it two, on
 * the offline-payment path. Keeping the two doors apart is what stops either
 * becoming a way round the other — so this endpoint will only ever settle a
 * bill against a credit that is ON THE STATEMENT IN FRONT OF IT, checked below
 * rather than taken from the request.
 */
/**
 * What the reconciliation screen needs before any statement exists.
 *
 * The two accounts with their labels, and whichever review is still open. The
 * open one matters: a treasurer who reloads mid-review should come back to it
 * rather than to an upload box that looks like their work is gone, and the
 * screen defaults to gas — the monthly visit — only when nothing is open.
 */
async function statementLanding(env) {
  const [issued, open] = await Promise.all([
    env.DB.prepare("SELECT 1 AS n FROM maint_quarters WHERE status IN ('issued','locked') LIMIT 1").first(),
    env.DB.prepare(
      "SELECT id, account, filename FROM statement_sessions WHERE status = 'open' ORDER BY id DESC LIMIT 1"
    ).first(),
  ]);
  return json({
    accounts: statementAccountList(env, { maintenanceIssued: Boolean(issued) }),
    open: open ? { sessionId: open.id, account: statementAccount(open.account), filename: open.filename } : null,
  });
}

async function assignCredit(request, env, session, path) {
  const id = Number(path.split('/')[4]);
  const body = await readJson(request);
  const billId = Number(body?.billId);

  const row = await env.DB.prepare('SELECT id, status, account, filename FROM statement_sessions WHERE id = ?')
    .bind(id).first();
  if (!row) return problem(404, 'DDP-RECON-001', 'That reconciliation could not be found.');
  if (row.status !== 'open') {
    return problem(409, 'DDP-RECON-001', 'That reconciliation is closed — the statement has been deleted.');
  }
  if (statementAccount(row.account) !== 'maintenance') {
    return problem(400, 'DDP-RECON-009',
      'Credits are assigned by hand only on the maintenance account. A gas credit is matched by its amount.');
  }

  // THE CREDIT MUST BE ON THE STATEMENT. Not "the client says it is" — the
  // amount, the date and the reference are looked up in the rows parsed on
  // upload. Without this the endpoint would be a way for one admin to mark any
  // bill paid by describing a payment, which is precisely the second-admin door
  // next to it.
  const credit = await env.DB.prepare(
    `SELECT id, amount, txn_date AS txnDate, reference FROM statement_credits
      WHERE session_id = ? AND txn_date IS ? AND ROUND(amount * 100) = ROUND(? * 100)
        AND COALESCE(reference, '') = COALESCE(?, '')
      LIMIT 1`
  ).bind(id, body?.txnDate ?? null, Number(body?.amount), body?.reference ?? null).first();
  if (!credit) {
    return problem(404, 'DDP-RECON-009', 'That credit is not on the statement being reviewed.');
  }

  const bill = await env.DB.prepare(
    'SELECT id, flat, quarter, total, status FROM maint_bills WHERE id = ?'
  ).bind(billId).first();
  if (!bill) return problem(404, 'DDP-RECON-009', 'That maintenance bill could not be found.');
  if (!['unpaid', 'initiated', 'awaiting'].includes(bill.status)) {
    return problem(409, 'DDP-RECON-009',
      `That bill is already ${bill.status}. Nothing has been changed.`);
  }

  // A CREDIT SHORT OF THE BILL DOES NOT SETTLE IT. Assigning marks the bill
  // paid, so letting ₹6,500 clear a ₹7,000 bill would forgive ₹500 with nobody
  // deciding to — an outcome indistinguishable, a month later, from a waiver
  // that at least somebody signed. The part payment is real and the flat it
  // came from is often obvious, which is exactly why the screen still shows it
  // and says how short it is; what it does not do is close the debt on the
  // strength of it. An overpayment is allowed through: the surplus is an
  // advance, which 0042 gave its own table and its own two signatures.
  const shortfall = Math.round(((bill.total ?? 0) - credit.amount) * 100) / 100;
  if (shortfall > 0) {
    return problem(409, 'DDP-RECON-009',
      `That credit is ₹${shortfall} short of ${bill.flat}'s ₹${bill.total} bill, so it cannot settle it. `
      + 'Record it as a part payment on the maintenance screen instead.');
  }

  // One credit settles one bill. Re-tapping a slow button, or two admins
  // working the same list from two laptops, must not pay the same bill twice
  // or spend the same credit twice.
  const spent = await env.DB.prepare(
    `SELECT id FROM reconciliations
      WHERE session_id = ? AND assigned_by IS NOT NULL
        AND (maint_bill_id = ?
             OR (COALESCE(reference, '') = COALESCE(?, '') AND ROUND(amount * 100) = ROUND(? * 100)
                 AND txn_date IS ?))
      LIMIT 1`
  ).bind(id, billId, credit.reference ?? null, credit.amount, credit.txnDate ?? null).first();
  if (spent) {
    return problem(409, 'DDP-RECON-009', 'That credit has already been assigned in this review.');
  }

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE maint_bills SET status = 'paid', paid_at = ?, paid_method = 'bank-statement', paid_reference = ?
        WHERE id = ? AND status IN ('unpaid', 'initiated', 'awaiting')`
    ).bind(now, credit.reference ?? `statement ${credit.txnDate ?? ''}`.trim(), billId),
    env.DB.prepare(
      `INSERT INTO reconciliations
         (session_id, proof_id, bill_id, maint_bill_id, verdict, reference, amount, txn_date, matched_by, assigned_by, created_at)
       VALUES (?, NULL, NULL, ?, 'confirmed', ?, ?, ?, NULL, ?, ?)`
    ).bind(id, billId, credit.reference ?? null, credit.amount, credit.txnDate ?? null, session.actor.id, now),
  ]);

  await audit(env, session, 'statement.assign',
    { sessionId: id, billId, flat: bill.flat, quarter: bill.quarter, amount: credit.amount });

  return json({
    sessionId: id, filename: row.filename ?? null,
    ...(await reportFor(env, id, 'maintenance')),
  });
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
    'SELECT id, bill_id, maint_bill_id, status FROM payment_proofs WHERE id = ?'
  ).bind(proofId).first();
  if (!proof) return problem(404, 'DDP-PROOF-005', 'That submission could not be found.');
  if (proof.status !== 'pending') {
    return problem(409, 'DDP-PROOF-005', 'That submission has already been reviewed.');
  }

  // Exactly one of the two is set — 0042 CHECKs it — so the table to settle is
  // decided by which one the row carries rather than by anything the caller
  // says. The decision itself is identical for both kinds; only the UPDATE
  // target differs.
  const isMaint = proof.maint_bill_id != null;
  const billId = isMaint ? proof.maint_bill_id : proof.bill_id;
  const table = isMaint ? 'maint_bills' : 'bills';

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE payment_proofs SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?'
    ).bind(approve ? 'approved' : 'rejected', session.actor.id, now, proofId),
    approve
      ? env.DB.prepare(`UPDATE ${table} SET status = 'paid', paid_at = ? WHERE id = ?`)
          .bind(now, billId)
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
      : env.DB.prepare(`UPDATE ${table} SET status = 'unpaid' WHERE id = ?`).bind(billId),
  ]);

  await audit(env, session, approve ? 'proof.approve' : 'proof.reject',
    { proofId, billId, kind: isMaint ? 'maintenance' : 'gas' });
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
 * Every flat in the building, billed or not, with whoever lives there.
 *
 * FLATS, not residents, and that is the point. The Residents tab is built from
 * `owners`, so a flat nobody has bought has no row there and could never be
 * managed from it — 5 of the 99 are in exactly that state today. Billing is a
 * property of the FLAT, so the list that governs it has to start from flats and
 * join people on, not the other way round.
 *
 * `unsold` and `vacant` are derived here rather than stored, because a stored
 * copy would be a second truth to keep in step with the owners table: a flat
 * with nobody on file is unsold, one with somebody is not.
 */
async function listFlats(env) {
  const rows = await env.DB.prepare(
    `SELECT f.flat, f.floor, f.active, f.inactive_reason, f.inactive_since,
            GROUP_CONCAT(o.name, ', ') AS residents,
            COUNT(o.id) AS resident_count
       FROM flats f
       LEFT JOIN owners o ON o.flat = f.flat AND o.active = 1
      GROUP BY f.flat
      ORDER BY f.floor, f.flat`
  ).all();

  return json({
    flats: (rows.results ?? []).map((r) => ({
      flat: r.flat,
      floor: r.floor,
      billed: Boolean(r.active),
      residents: r.residents ?? null,
      unsold: r.resident_count === 0,
      reason: r.inactive_reason ?? null,
      since: r.inactive_since ?? null,
    })),
  });
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

  // The reason lives on the flat as well as in the audit log. The log records
  // what happened; the row is what a screen can show next to 12F a year later,
  // when the person asking is not the person who decided.
  await env.DB.prepare(
    'UPDATE flats SET active = ?, inactive_reason = ?, inactive_since = ? WHERE flat = ?'
  ).bind(active, active ? null : reason, active ? null : new Date().toISOString(), flat).run();
  await audit(env, session, 'flat.active', { flat, from: row.active, to: active, reason });

  return json({ flat, active: Boolean(active), reason });
}

/**
 * One control for the whole occupancy of a flat.
 *
 * WHAT IT REPLACES. The Residents tab asked this as two errands that nobody
 * thinks of as two: `relationship` was picked while adding a person, and
 * whether the flat is billed at all lived in a separate list further down the
 * same tab. "12F is unsold" is one fact, and the split is how a flat ends up
 * with nobody on file, still on the billing roll, refusing to let the month
 * close for the other 88.
 *
 * WHAT IT IS NOT. It adds no column. The three states are derived from which
 * `owners` rows are active — migration 0011's rule, and the reason is that a
 * stored copy drifts the first time a tenant leaves and nobody flips the owner
 * back. `planOccupancy` decides; this only writes what it decided.
 *
 * The steps go out as ONE D1 batch. A half-applied change — the old tenant
 * deactivated, the new one never inserted — is a flat with nobody billed and
 * no error anywhere.
 */
async function putOccupancy(request, env, session, path) {
  const flat = decodeURIComponent(path.split('/')[4] ?? '').toUpperCase();
  const b = await readJson(request);

  const row = await env.DB.prepare('SELECT flat, active FROM flats WHERE flat = ?')
    .bind(flat).first();
  if (!row) return problem(404, 'DDP-ADMIN-009', 'That flat is not part of this building.');

  const { results: people } = await env.DB.prepare(
    `SELECT id, flat, name, mobile, email, role, relationship, active, moved_in_at
       FROM owners WHERE flat = ?`
  ).bind(flat).all();

  // Whose rows these are to touch at all, asked per person and before anything
  // is planned. An admin may not deactivate another admin or the superadmin any
  // more than they may edit them — the flat is not a way round canEditResident.
  for (const p of (people ?? []).filter((x) => x.active)) {
    const allowed = canEditResident({ actor: session.actor, target: p });
    if (!allowed.ok) {
      await reportError(env, 'DDP-ADMIN-014',
                        { actor: session.actor.id, target: p.id, targetRole: p.role });
      return problem(403, 'DDP-ADMIN-014', allowed.message);
    }
  }

  const plan = planOccupancy({
    people: people ?? [],
    to: b?.to,
    owner: b?.owner ?? null,
    tenant: b?.tenant ?? null,
    tenancyStart: b?.tenancyStart ?? null,
    billed: Boolean(row.active),
    billing: b?.billing ?? null,
    reason: b?.reason ?? null,
  });
  if (!plan.ok) {
    return problem(400, 'DDP-ADMIN-003', plan.message, { field: plan.field ?? null });
  }

  // Normalised and checked before a single statement is prepared, because the
  // batch is all-or-nothing and a value the database would reject has to be
  // caught where the person who typed it is still looking at it.
  //
  // mobile is NOT NULL UNIQUE — it is the login id — so a duplicate is not a
  // constraint to let the database report. `contactClash` already caught the
  // two parties sharing a number inside this one form; this catches the number
  // already belonging to somebody in another flat, which the form cannot see.
  const adds = plan.steps.filter((s) => s.op === 'add');
  for (const add of adds) {
    try {
      add.mobile = normaliseMobile(add.mobile);
    } catch {
      return problem(400, 'DDP-ADMIN-009', explainField('mobile', add.mobile),
                     { field: add.relationship });
    }
    if (add.email) {
      const email = normaliseEmail(add.email);
      if (!email) {
        return problem(400, 'DDP-ADMIN-010', explainField('email', add.email),
                       { field: add.relationship });
      }
      add.email = email;
    }
    for (const [field, value] of [['mobile', add.mobile], ['email', add.email]]) {
      if (!value) continue;
      const clash = await duplicateContact(env, 0, field, value);
      if (clash) {
        return problem(409, 'DDP-ADMIN-013',
          `That ${field} already belongs to ${clash.name} (${clash.flat}).`,
          { field: add.relationship });
      }
    }
  }
  // Two people added in one submission cannot be checked against each other by
  // duplicateContact — neither is in the table yet.
  if (adds.length > 1) {
    const clash = contactClash({
      owner: adds.find((a) => a.relationship === 'owner'),
      tenant: adds.find((a) => a.relationship === 'tenant'),
    });
    if (clash) return problem(409, 'DDP-ADMIN-013', clash.message, { field: clash.field });
  }

  const now = new Date().toISOString();
  const statements = [];
  // Handed back so the console can show them once, the same way adding a
  // resident does. Never stored, never logged.
  const issued = [];

  for (const step of plan.steps) {
    if (step.op === 'deactivate') {
      statements.push(env.DB.prepare(
        'UPDATE owners SET active = 0, moved_out_at = ? WHERE id = ?'
      ).bind(step.moved_out_at, step.id));
      // Every session that account holds, gone with it. "Once they leave, no
      // access whatsoever" is not true of a row flipped to 0 while a phone in
      // somebody's pocket still holds a valid cookie.
      await destroyAllSessionsFor(env, step.id);

      // Their unsettled bills move to whoever is left of their household.
      // A bill names one person and their household reads it through that
      // name; deactivating the named one would leave the people who still owe
      // the money unable to see or pay it. Settled bills stay where they are —
      // that is the record of who actually paid, and the person who left keeps
      // it. Nobody left means the flat changed hands, and the incoming
      // household must not inherit the outgoing one's debt: those stay too,
      // for the committee to chase.
      // Against who is left AFTER the plan, not who is here now. A plan that
      // empties a flat deactivates every owner in one pass, and choosing from
      // the current rows would hand the bills to somebody on their way out —
      // or back to the first leaver, whose row this loop has already closed.
      const leaving = new Set(plan.steps.filter((s) => s.op === 'deactivate').map((s) => s.id));
      const staying = (people ?? []).filter((p) => !leaving.has(p.id));
      const leaver = (people ?? []).find((p) => p.id === step.id);
      const heir = leaver ? successorFor(staying, leaver) : null;
      if (heir) {
        statements.push(env.DB.prepare(
          `UPDATE bills SET owner_id = ?
            WHERE owner_id = ? AND status NOT IN ('paid', 'waived')`
        ).bind(heir.id, step.id));
      }
      continue;
    }

    if (step.op === 'update') {
      // name and moved_in_at only. mobile and email are behind approval since
      // B22 and planOccupancy never emits them — asserted here as well, because
      // this loop is what would actually write one.
      const fields = Object.keys(step.fields).filter((f) => ['name', 'moved_in_at'].includes(f));
      if (!fields.length) continue;
      statements.push(env.DB.prepare(
        `UPDATE owners SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`
      ).bind(...fields.map((f) => step.fields[f]), step.id));
      continue;
    }

    if (step.op === 'add') {
      const otp = generateOneTimePassword();
      const { hash, salt, iterations } = await hashPassword(otp, ITER(env));
      statements.push(env.DB.prepare(
        `INSERT INTO owners (flat, name, mobile, email, pw_hash, pw_salt, pw_iterations,
                             must_change_pw, pw_expires_at, role, relationship,
                             moved_in_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'owner', ?, ?, ?)`
      ).bind(flat, step.name, step.mobile, step.email, hash, salt, iterations,
             tempPasswordExpiry(TEMP_PW_HOURS), step.relationship, step.moved_in_at, now));
      issued.push({
        name: step.name, relationship: step.relationship, oneTimePassword: otp,
        whatsapp: waLink(step.mobile,
          'Diamond Park portal — your temporary password is ' + otp + '\n'
          + 'Log in at https://diamondpark.pages.dev and choose your own.'),
      });
      continue;
    }

    if (step.op === 'flat') {
      // The same rule patchFlat enforces, for the same reason: a reading and an
      // exclusion contradict each other and the grid stops showing that they do.
      if (!step.active) {
        const reading = await env.DB.prepare(
          `SELECT r.period FROM readings r JOIN periods p ON p.period = r.period
            WHERE r.flat = ? AND p.status = 'open' LIMIT 1`
        ).bind(flat).first();
        if (reading) {
          return problem(409, 'DDP-BILL-001',
            `${flat} has a reading entered for ${reading.period}. Clear it first, or `
            + 'leave the flat billed — the occupancy change itself is fine.',
            { field: 'billing' });
        }
      }
      statements.push(env.DB.prepare(
        'UPDATE flats SET active = ?, inactive_reason = ?, inactive_since = ? WHERE flat = ?'
      ).bind(step.active ? 1 : 0, step.active ? null : step.reason,
             step.active ? null : now, flat));
    }
  }

  await env.DB.batch(statements);

  // What it was and what it is, not merely that somebody touched it. A year
  // later "who decided 12F was unsold" has to be answerable, and `to` alone
  // does not answer it.
  await audit(env, session, 'flat.occupancy', {
    flat, from: plan.from, to: plan.to,
    steps: plan.steps.map((s) => s.op === 'add' ? `add ${s.relationship}` : s.op),
    reason: plan.steps.find((s) => s.op === 'flat')?.reason ?? null,
  });

  return json({ flat, from: plan.from, to: plan.to, warnings: plan.warnings, issued });
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
  // The bill each flat already has for THIS month, once there is one.
  //
  // Carried on the grid so the published state can offer a reading correction
  // without a second round trip that would have to re-answer "which bill is
  // 4A's August one" — a question this row already knows the answer to. Null
  // for every flat until the month is published, which is exactly when the
  // control appears.
  const raised = await env.DB.prepare(
    'SELECT id, flat FROM bills WHERE period = ?'
  ).bind(period).all();
  const billOf = new Map((raised.results ?? []).map((b) => [b.flat, b.id]));

  grid.flats = grid.flats.map((f) => {
    const past = (byFlat.get(f.flat) ?? []).filter((n) => Number.isFinite(n) && n > 0);
    const average = past.length >= 2
      ? Math.round((past.reduce((a, b) => a + b, 0) / past.length) * 100) / 100
      : null;
    return {
      ...f,
      average,
      billId: billOf.get(f.flat) ?? null,
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
  const flats = await env.DB.prepare(
    `SELECT f.flat,
            EXISTS (SELECT 1 FROM owners o WHERE o.flat = f.flat AND o.active = 1) AS occupied
       FROM flats f WHERE f.active = 1`
  ).all();
  const rowsIn = flats.results ?? [];
  const known = rowsIn.map((r) => r.flat);
  const nobodyOnFile = rowsIn.filter((r) => !r.occupied).map((r) => r.flat);
  const parsed = parseReadings(body?.text ?? '', known, { nobodyOnFile });

  for (const e of parsed.errors) {
    // Expected, and already explained on screen — not a fault worth an alert.
    if (e.reason === 'nobody-on-file') continue;
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

  // Each flat's own past months, so the preview can say which readings are
  // implausible. Same query the grid uses for its amber warnings — the two
  // screens must agree, or the confirmation contradicts the row above it.
  const history = await env.DB.prepare(
    `SELECT flat, consumption FROM bills WHERE period < ? ORDER BY period DESC LIMIT 400`
  ).bind(period).all();
  const byFlat = new Map();
  for (const row of history.results ?? []) {
    if (!byFlat.has(row.flat)) byFlat.set(row.flat, []);
    byFlat.get(row.flat).push(row.consumption);
  }

  const rows = grid.flats
    .filter((f) => f.reading != null && f.previous != null)
    .map((f) => ({
      flat: f.flat, reading: f.reading, previous: f.previous,
      meterChange: f.meterChange,
      history: byFlat.get(f.flat) ?? [],
    }));

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

  /**
   * The due date and the late fee, without the rate.
   *
   * Separated because neither moves a single amount: nothing recalculates, so
   * there is no impact to show and nothing for an approver to agree to. Step 1
   * of the Billing tab holds all three together, and before this there was no
   * way to change two of them once the month was open — the treasurer's only
   * route was to open the month again, which `periods` refuses.
   *
   * A locked month is still refused. The due date on a published month is
   * printed on 89 bills and quoted in 89 emails.
   */
  if (body?.ratePerKg == null) {
    const periodRow = await env.DB.prepare('SELECT status FROM periods WHERE period = ?')
      .bind(period).first();
    if (!periodRow) return problem(404, 'DDP-BILL-005', 'No such month.');
    if (periodRow.status === 'locked') {
      return problem(409, 'DDP-BILL-007',
        `${periodName(period)} is published, so its due date cannot be moved. `
        + 'Residents have already been told this one.');
    }

    const dueDate = String(body?.dueDate ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      return problem(400, 'DDP-SYS-003', 'That is not a date.');
    }
    const lateFee = Number(body?.lateFee ?? 0);
    // Whole rupees. `periods` carries CHECK (late_fee = CAST(late_fee AS
    // INTEGER)), so 50.50 would pass here and die at the database as a 500.
    if (!Number.isInteger(lateFee) || lateFee < 0) {
      return problem(400, 'DDP-BILL-008', 'The late fee is whole rupees. No paise.');
    }

    await env.DB.prepare('UPDATE periods SET due_date = ?, late_fee = ? WHERE period = ?')
      .bind(dueDate, lateFee, period).run();
    await audit(env, session, 'period.terms', { period, dueDate, lateFee });
    return json({ period, dueDate, lateFee });
  }

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

/**
 * Publish a month: generate the bills, and queue the telling of it.
 *
 * Any admin, alone — the same as generation has always been. What needs two
 * other admins is CORRECTING a published month, and that is the point of
 * publishing being a distinct act: most mistakes are now caught in the draft,
 * before anybody has seen a bill, so the two-admin rule guards genuine errors
 * rather than ordinary typos.
 *
 * Nothing is sent here. The outbox is drained separately, 20 at a time, for
 * the subrequest reasons set out in announce.js.
 */
async function postPublish(request, env, session, path) {
  const period = decodeURIComponent(path.split('/')[4] ?? '');

  let result;
  try {
    result = await publishBills(env, period, session.actor.id);
  } catch (err) {
    // The blocker the Billing tab has to draw as ITS OWN THING, not as a
    // missing reading. A flat being billed with nobody on file cannot produce
    // a bill however many readings are entered, and the treasurer who reads
    // this as "one more meter to walk" goes looking for a meter that is not
    // there. The flats come back named so the screen can link to each card.
    if (err?.code === 'DDP-BILL-015') {
      await reportError(env, 'DDP-BILL-015', { period, flats: err.details?.flats ?? [] });
      return problem(409, 'DDP-BILL-015',
        'Some flats are being billed with nobody on record, so their bills '
        + 'would have no one to go to. Put a resident on each, or stop billing '
        + 'the flat — both are on the Residents tab.',
        { flats: err.details?.flats ?? [] });
    }
    throw err;
  }

  await audit(env, session, 'bills.publish', result);
  return json(result, { status: 201 });
}

/**
 * Send the next slice of a month's announcements.
 *
 * Called in a loop by the console behind a progress bar, and by the 3am cron
 * for whatever is left. Both are the same operation — see drainAnnouncements —
 * so the treasurer closing the laptop mid-drain costs nothing.
 */
async function postAnnounce(request, env, session, path) {
  const period = decodeURIComponent(path.split('/')[4] ?? '');
  const result = await drainAnnouncements(env, period, {
    origin: new URL(request.url).origin,
  });

  // Recorded per drain rather than per row: 89 identical warn rows would bury
  // the digest, and what a human needs to know is that this month's telling is
  // not finishing on its own.
  if (result.failed) {
    await reportError(env, 'DDP-BILL-018', { period, failed: result.failed });
  }
  return json(result);
}

/**
 * How the month's telling stands, plus the flats nobody could email.
 *
 * The WhatsApp list is here rather than computed on the client because it needs
 * `owners.mobile`, and the mobile is the login id — it is not in any payload
 * the console already holds. Read off `bills.owner_id`, never re-derived: the
 * bill already knows whose it is (docs/RESIDENTS-OCCUPANCY.md).
 */
async function getAnnouncements(env, path) {
  const period = decodeURIComponent(path.split('/')[4] ?? '');
  const [counts, unreachable] = await Promise.all([
    announcementCounts(env, period),
    unreachableFlats(env, period),
  ]);
  return json({ period, counts, unreachable });
}

/**
 * Correct a published month's price of gas — every bill in it.
 *
 * ANY ADMIN MAY ASK, two others approve. That is a change from the rule this
 * replaces, where a locked month refused the rate outright and named the
 * superadmin (DDP-BILL-012). The refusal stays on the direct route; what is new
 * is that there is now a route with a committee at the end of it, because "the
 * supplier priced August wrong" is a real thing that happens after bills go
 * out, and the only alternative was 89 hand-typed amounts — the exact thing
 * this whole design removes.
 *
 * Held as ONE request rather than 89. The approver sees the month's totals move
 * because that is what they are agreeing to; agreeing to it flat by flat would
 * be 89 decisions about one decision.
 */
async function requestPriceCorrection(request, env, session, path) {
  const period = decodeURIComponent(path.split('/')[4] ?? '');
  const body = await readJson(request);
  const ratePerKg = Number(body?.ratePerKg);
  const reason = checkReason('rate_per_kg', body?.reason);

  const periodRow = await env.DB.prepare('SELECT * FROM periods WHERE period = ?')
    .bind(period).first();
  if (!periodRow) return problem(404, 'DDP-BILL-005', 'No such month.');
  if (!Number.isFinite(ratePerKg) || ratePerKg <= 0) {
    return problem(400, 'DDP-BILL-005', 'That is not a price.');
  }
  if (ratePerKg === periodRow.rate_per_kg) {
    // Equality is its own case. Falling through to the recalculation would tell
    // the committee that every bill in the month is about to move while both
    // sides of the sentence showed the same figure.
    return json({ ok: true, unchanged: true });
  }

  const rows = await env.DB.prepare(
    `SELECT id, flat, consumption, gas_amount, other_charges, additional_charges,
            late_fee, total, status, manual_total
       FROM bills WHERE period = ? ORDER BY id`
  ).bind(period).all();
  const bills = rows.results ?? [];
  if (!bills.length) {
    return problem(409, 'DDP-BILL-005',
      'No bills exist for that month yet, so there is nothing to correct. '
      + 'Change the rate on the Billing tab instead.');
  }

  const plan = planRateChange(bills, {
    ratePerKg, conversionFactor: periodRow.conversion_factor,
  });
  const totals = priceCorrectionTotals(plan, bills);

  if (body?.dryRun === true) {
    return json({ period, from: periodRow.rate_per_kg, to: ratePerKg, dryRun: true,
                  ...plan, totals });
  }

  /**
   * THE ANCHOR, said out loud because it is the one liberty this takes.
   *
   * `bill_edit_requests.bill_id` is NOT NULL, and this request is about the
   * month rather than about one bill. It is anchored to the month's first bill
   * — a real bill, really affected — and `field` names it as period-level so
   * nothing mistakes it for an edit to that flat.
   *
   * The consequence that has to be handled rather than inherited: the approval
   * policy excludes the bill's own HOUSEHOLD, which is right for one flat's
   * bill and wrong for a change to all of them. Passing no flat is what makes
   * every admin but the requester eligible, which is the rule the committee
   * actually agreed.
   */
  const anchor = bills[0];
  return requestBillEdit(env, session, {
    bill: { ...anchor, flat: null, period },
    field: PRICE_FIELD,
    value: ratePerKg,
    reason,
    totalBefore: totals.totalBefore,
    totalAfter: totals.totalAfter,
    origin: new URL(request.url).origin,
  });
}

/**
 * Correct one flat's meter reading on a published month.
 *
 * The request carries the corrected READING and the total it produces, rather
 * than a total somebody chose — which is the whole difference between this and
 * the path it replaces. Every rupee still traces to a meter reading and a rate.
 */
async function requestReadingCorrection(request, env, session, path) {
  const id = Number(path.split('/')[4]);
  const bill = await env.DB.prepare('SELECT * FROM bills WHERE id = ?').bind(id).first();
  if (!bill) return problem(404, 'DDP-ADMIN-010', 'No such bill.');

  const body = await readJson(request);
  const reason = checkReason('reading', body?.reason);

  const context = await readingContext(env, bill);
  if (!context) {
    return problem(409, 'DDP-BILL-005',
      'That month has no rate on record, so a corrected reading cannot be priced.');
  }

  let plan;
  try {
    plan = planReadingCorrection({ bill, reading: body?.reading, ...context });
  } catch (err) {
    if (err?.code === 'DDP-BILL-002') {
      return problem(400, 'DDP-BILL-002',
        `Meters don’t go down. Last month’s reading for ${bill.flat} was ${context.previous}.`);
    }
    if (err?.code === 'DDP-BILL-001') {
      return problem(400, 'DDP-BILL-001', 'That is not a meter reading.');
    }
    throw err;
  }

  if (plan.total === bill.total && plan.reading === context.currentReading) {
    return json({ ok: true, unchanged: true });
  }

  return requestBillEdit(env, session, {
    bill,
    field: READING_FIELD,
    value: plan.reading,
    reason,
    totalBefore: bill.total,
    totalAfter: plan.total,
    origin: new URL(request.url).origin,
  });
}

/**
 * Everything pricing a corrected reading needs: last month's figure, this
 * month's, the rate it was billed at, and any meter change.
 *
 * The rate comes from the BILL, not from the period. `bills.rate_per_kg` is a
 * snapshot — a bill keeps the rate it was generated with — so pricing a
 * corrected reading off the period row would silently apply a later price
 * change to one flat, which is precisely the per-flat rate the design rules
 * out.
 */
async function readingContext(env, bill) {
  const prev = previousPeriod(bill.period);
  const [current, previous, change] = await Promise.all([
    env.DB.prepare('SELECT reading FROM readings WHERE flat = ? AND period = ?')
      .bind(bill.flat, bill.period).first(),
    env.DB.prepare('SELECT reading FROM readings WHERE flat = ? AND period = ?')
      .bind(bill.flat, prev).first(),
    env.DB.prepare('SELECT old_final, new_start, changed_on FROM meter_changes WHERE flat = ? AND period = ?')
      .bind(bill.flat, bill.period).first(),
  ]);
  if (!Number.isFinite(bill.rate_per_kg) || bill.rate_per_kg <= 0) return null;

  return {
    currentReading: current?.reading ?? null,
    previous: previous?.reading ?? null,
    ratePerKg: bill.rate_per_kg,
    conversionFactor: bill.conversion_factor ?? DEFAULT_CONVERSION,
    meterChange: change ? { ...change, new_start: change.new_start ?? 0 } : null,
  };
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
    userAgent: request.headers.get('user-agent'),
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
/**
 * Every bill for a flat, BOTH KINDS, interleaved and sorted by due date.
 *
 * A quarter is a period whose label happens to be a quarter. Treating the two
 * as different species is what produces two half-screens, so they arrive as one
 * list with a `kind` on each row and the screen filters it — never a second
 * table and never a second page.
 *
 * The sort is by DUE DATE rather than by label, because '2026-Q4' and '2026-10'
 * do not sort against each other in any way a reader would recognise: as
 * strings the quarter sorts before every month of its own year.
 */
async function godBills(env, url) {
  const flat = url.searchParams.get('flat');
  // Filtered server-side when asked, so a building with years of history does
  // not send both kinds in full to filter them away in the browser.
  const kind = url.searchParams.get('kind');

  const [gas, maint] = await Promise.all([
    kind === 'maintenance' ? { results: [] } : env.DB.prepare(
      `SELECT b.id, b.flat, b.period, b.consumption, b.rate_per_kg, b.gas_amount,
              b.other_charges, b.additional_charges, b.late_fee, b.total, b.status,
              b.manual_total, b.adjusted_at, b.adjust_reason, o.name AS owner_name,
              p.due_date
         FROM bills b
         LEFT JOIN owners o ON o.id = b.owner_id
         LEFT JOIN periods p ON p.period = b.period
        ${flat ? 'WHERE b.flat = ?' : ''}
        ORDER BY b.period DESC, b.flat`
    ).bind(...(flat ? [flat] : [])).all(),

    kind === 'gas' ? { results: [] } : env.DB.prepare(
      `SELECT b.id, b.flat, b.quarter, b.rate_applied, b.basis, b.late_fee, b.total,
              b.status, b.manual_total, b.adjusted_at, b.adjust_reason,
              o.name AS owner_name, q.due_date
         FROM maint_bills b
         LEFT JOIN owners o ON o.id = b.owner_id
         LEFT JOIN maint_quarters q ON q.quarter = b.quarter
        ${flat ? 'WHERE b.flat = ?' : ''}
        ORDER BY b.quarter DESC, b.flat`
    ).bind(...(flat ? [flat] : [])).all(),
  ]);

  const gasBills = (gas.results ?? []).map((b) => ({
    ...b,
    kind: 'gas',
    // The label the column shows. Built here so one row carries one period
    // name, whichever kind it is, and the screen does not branch to read it.
    periodLabel: b.period,
    dueDate: b.due_date ?? null,
    computed: computedTotal(b),
    // Surfaced rather than merely flagged: an override that does not say what
    // the arithmetic wanted is just an unexplained number.
    mismatch: isUnexplainedMismatch(b),
  }));

  const maintBills = (maint.results ?? []).map((b) => ({
    ...b,
    kind: 'maintenance',
    period: b.quarter,
    periodLabel: describeQuarter(b.quarter),
    dueDate: b.due_date ?? null,
    // A maintenance bill is a rate plus a fee. There is no meter arithmetic to
    // disagree with, so `computed` is that sum and a mismatch means somebody
    // overrode the total by hand.
    computed: Number(b.rate_applied ?? 0) + Number(b.late_fee ?? 0),
    mismatch: Boolean(b.manual_total) && !b.adjust_reason,
  }));

  const bills = [...gasBills, ...maintBills].sort((a, b) => {
    const ad = a.dueDate ?? '';
    const bd = b.dueDate ?? '';
    if (ad !== bd) return ad < bd ? 1 : -1;   // newest first
    return String(a.flat).localeCompare(String(b.flat));
  });

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

/**
 * Meter changes for a period, with the readings either side so the superadmin
 * can see the arithmetic rather than trust it.
 */
async function listMeterChanges(env, url) {
  const period = periodFrom(url);
  if (!period) return problem(400, 'DDP-BILL-005', 'Specify a period, e.g. ?period=2026-07.');

  const rows = await env.DB.prepare(
    `SELECT mc.flat, mc.period, mc.changed_on, mc.old_final, mc.new_start, mc.note,
            mc.entered_at, o.name AS entered_by_name,
            prv.reading AS previous, cur.reading AS reading
       FROM meter_changes mc
       LEFT JOIN owners o ON o.id = mc.entered_by
       LEFT JOIN readings prv ON prv.flat = mc.flat AND prv.period = ?
       LEFT JOIN readings cur ON cur.flat = mc.flat AND cur.period = mc.period
      WHERE mc.period = ?
      ORDER BY mc.flat`
  ).bind(previousPeriod(period), period).all();

  return json({ period, changes: rows.results ?? [] });
}

async function postMeterChange(request, env, session) {
  if (session.impersonating) {
    await reportError(env, 'DDP-AUTH-007', { action: 'meter-change' });
    return problem(403, 'DDP-AUTH-007', 'Not while impersonating.');
  }

  const body = await readJson(request);
  const flat = normaliseFlat(String(body?.flat ?? ''));
  const period = String(body?.period ?? '');
  const oldFinal = Number(body?.oldFinal);
  const newStart = Number(body?.newStart ?? 0);
  // BACKDATED BY DESIGN. The caretaker reads the meters and mentions the swap
  // afterwards, sometimes weeks later, so this is a date somebody types.
  const changedOn = String(body?.changedOn ?? '').slice(0, 10);
  const note = body?.note ? String(body.note).slice(0, 500) : null;

  if (!flat || !/^\d{4}-\d{2}$/.test(period)) {
    return problem(400, 'DDP-BILL-014', 'Give a flat and a usage month.');
  }
  if (!Number.isFinite(oldFinal) || !Number.isFinite(newStart)) {
    return problem(400, 'DDP-BILL-014', 'The old meter\'s final reading is required.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(changedOn)) {
    return problem(400, 'DDP-BILL-014', 'Give the date the meter was changed.');
  }

  const periodRow = await env.DB.prepare('SELECT status FROM periods WHERE period = ?')
    .bind(period).first();
  if (!periodRow) return problem(404, 'DDP-BILL-005', 'That month does not exist yet.');
  // A locked month's bills are already written and already on residents'
  // dashboards; changing what its consumption means would leave the bills
  // saying one thing and the arithmetic another. Correct those bills directly.
  if (periodRow.status === 'locked') {
    return problem(409, 'DDP-BILL-007',
      'That month is already generated. Correct the bill itself instead.');
  }

  const prev = await env.DB.prepare(
    'SELECT reading FROM readings WHERE flat = ? AND period = ?'
  ).bind(flat, previousPeriod(period)).first();

  // Checked here as well as at generation, so the refusal arrives while the
  // superadmin is looking at the form rather than a fortnight later when the
  // month refuses to close.
  if (prev && oldFinal < prev.reading) {
    return problem(409, 'DDP-BILL-014',
      `The old meter's final reading (${oldFinal}) is below last month's (${prev.reading}).`);
  }

  await env.DB.prepare(
    `INSERT INTO meter_changes (flat, period, changed_on, old_final, new_start, note,
                                entered_by, entered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (flat, period) DO UPDATE SET
       changed_on = excluded.changed_on, old_final = excluded.old_final,
       new_start = excluded.new_start, note = excluded.note,
       entered_by = excluded.entered_by, entered_at = excluded.entered_at`
  ).bind(flat, period, changedOn, oldFinal, newStart, note,
         session.actor.id, new Date().toISOString()).run();

  await audit(env, session, 'meter.change', { flat, period, changedOn, oldFinal, newStart, note });
  return json({ ok: true, flat, period, changedOn, oldFinal, newStart });
}

async function deleteMeterChange(request, env, session) {
  const body = await readJson(request);
  const flat = normaliseFlat(String(body?.flat ?? ''));
  const period = String(body?.period ?? '');

  const periodRow = await env.DB.prepare('SELECT status FROM periods WHERE period = ?')
    .bind(period).first();
  if (periodRow?.status === 'locked') {
    return problem(409, 'DDP-BILL-007', 'That month is already generated.');
  }

  await env.DB.prepare('DELETE FROM meter_changes WHERE flat = ? AND period = ?')
    .bind(flat, period).run();
  await audit(env, session, 'meter.change.remove', { flat, period });
  return json({ ok: true, flat, period });
}

/** Everyone who could ever approve: the admins and the superadmin. */
async function approvalBench(env) {
  const rows = await env.DB.prepare(
    `SELECT id, role, flat FROM owners
      WHERE active = 1 AND role IN ('admin','superadmin') ORDER BY id`
  ).all();
  return rows.results ?? [];
}

async function policyFor(env, { bill, requesterId }) {
  return approvalPolicy({
    admins: await approvalBench(env),
    requesterId,
    billFlat: bill.flat,
  });
}

/** The single place a bill's money actually changes, however it was agreed. */
async function writeBillEdit(env, session, { bill, field, value, reason, actorId }) {
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
    actorId, now, reason, bill.id
  ).run();

  return { next, derived, computed };
}

/**
 * Hold the edit until the committee agrees. Nothing about the bill changes
 * here: the proposed value waits in its own row, because a bill that briefly
 * says something nobody approved is exactly what this is preventing.
 */
async function requestBillEdit(env, session, { bill, field, value, reason, totalAfter,
                                              totalBefore = null, origin = '' }) {
  const policy = await policyFor(env, { bill, requesterId: session.actor.id });
  // A month-wide price correction moves the MONTH's total, not the anchor
  // bill's, so the pair of figures an approver is shown has to come from the
  // caller. Everything else is about one bill and reads it off the bill.
  const before = totalBefore ?? bill.total;

  if (!policy.satisfiable) {
    await reportError(env, 'DDP-ADMIN-016', {
      billId: bill.id, eligible: policy.approverIds.length, required: policy.required,
    });
    return problem(409, 'DDP-ADMIN-016',
      'There are not enough admins available to approve this. Add an admin, or '
      + 'ask the committee before changing the bill.');
  }

  const now = new Date().toISOString();
  const numeric = typeof value === 'number' ? value : null;
  const text = typeof value === 'number' ? null : String(value);

  const res = await env.DB.prepare(
    `INSERT INTO bill_edit_requests
       (bill_id, field, value, value_text, reason, total_before, total_after,
        requested_by, requested_at, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(bill.id, field, numeric, text, reason, before, totalAfter,
         session.actor.id, now, expiresAt(now)).run();

  await audit(env, session, 'bill.edit.request', {
    billId: bill.id, flat: bill.flat, period: bill.period, field,
    totalBefore: before, totalAfter, required: policy.required,
  });

  // TELLING THEM IS THE POINT. Without this the request sits in a tab until an
  // admin happens to open the console, while the resident looks at a bill
  // everybody agrees is wrong. Never allowed to fail the request: the
  // correction is recorded either way, and an alert that throws must not undo
  // money work — the same rule the digest follows.
  const alerted = await alertApprovers(env, {
    policy, bill, totalAfter, totalBefore: before,
    reason, requestedBy: session.actor.name, origin,
  }).catch(() => ({ emailed: 0, missing: [], telegram: false }));

  return json({
    ok: true,
    pending: true,
    requestId: res?.meta?.last_row_id ?? null,
    required: policy.required,
    approvers: policy.approverIds,
    subjectIsAdmin: policy.subjectIsAdmin,
    totalBefore: before,
    totalAfter,
    note: policy.subjectIsAdmin
      ? 'This bill belongs to an admin, so every other eligible admin must approve.'
      : `Waiting for ${policy.required} other admins to approve.`,
    // Reported back so the screen can say who was actually reached. An alert
    // nobody received looks identical to one nobody has answered yet.
    alerted,
  });
}

/**
 * Tell the people who have to decide.
 *
 * Email to each eligible approver who has an address, and a Telegram message
 * to the committee channel regardless — the two have different failure modes
 * and the point is that somebody hears. Gmail is unconfigured on this
 * deployment today and admins mostly have no address on file, so Telegram is
 * the one that works; the email path is here because it is what was asked for
 * and because both of those are fixable without touching code again.
 *
 * WHO WAS NOT REACHED IS RETURNED, not swallowed. An approval queue whose
 * notifications quietly went nowhere is worse than one with no notifications
 * at all, because the second is at least known to need checking.
 */
async function alertApprovers(env, { policy, bill, totalAfter, totalBefore = null,
                                     reason, requestedBy, origin }) {
  if (!policy.approverIds.length) return { emailed: 0, missing: [], telegram: false };

  const people = await env.DB.prepare(
    `SELECT id, name, email FROM owners
      WHERE id IN (${policy.approverIds.map(() => '?').join(',')})`
  ).bind(...policy.approverIds).all();

  const { subject, text } = approvalMessage({
    // A month-wide price correction has no flat, and saying so is the point:
    // an approver who reads a flat number will look for one bill and agree to
    // a month. `bill.flat` is null on that path by construction.
    flat: bill.flat ?? 'every flat',
    period: bill.period,
    totalBefore: totalBefore ?? bill.total,
    totalAfter,
    reason, requestedBy, required: policy.required, origin,
  });

  // Email is not set up yet, and that is a decision rather than a fault: the
  // association's Gmail account waits on the committee reviewing the portal.
  // Attempting a send per approver would burn a token refresh each time and
  // return the same answer, so the whole path is skipped while it is off.
  const mail = mailConfigured(env);

  let emailed = 0;
  const missing = [];
  if (mail) {
    for (const person of people.results ?? []) {
      if (!person.email) { missing.push(person.name); continue; }
      const sent = await sendEmail(env, { to: person.email, subject, text });
      if (sent.sent) emailed += 1;
      else missing.push(`${person.name} (${sent.reason})`);
    }
  }

  const telegram = await postToTelegram(env,
    `Bill correction awaiting approval\n${bill.flat} ${bill.period}: `
    + `₹${bill.total} → ₹${totalAfter}\nAsked by ${requestedBy} — needs ${policy.required} `
    + `admin${policy.required === 1 ? '' : 's'}\nReason: ${reason}`);

  // Recorded, at warn, when email is SET UP and still reached nobody — an
  // address missing from an admin's record, or Gmail refusing. Not while the
  // account is deliberately absent: a warning that fires on every correction
  // for a state everyone already knows about is how the digest becomes
  // something people skim past, and the one that matters goes with it.
  if (mail && !emailed && missing.length) {
    await reportError(env, 'DDP-ADMIN-018', { billId: bill.id, missing });
  }

  return { emailed, missing, telegram, mail };
}

/** Open requests, with everything an approver needs to judge one. */
async function listBillEditRequests(env, session) {
  const rows = await env.DB.prepare(
    `SELECT r.*, b.flat, b.period, o.name AS requested_by_name,
            (SELECT COUNT(*) FROM bill_edit_approvals a
              WHERE a.request_id = r.id AND a.decision = 'approve') AS approvals
       FROM bill_edit_requests r
       JOIN bills b ON b.id = r.bill_id
       LEFT JOIN owners o ON o.id = r.requested_by
      WHERE r.status = 'pending'
      ORDER BY r.requested_at`
  ).all();

  const bench = await approvalBench(env);
  const out = [];
  for (const r of rows.results ?? []) {
    const policy = approvalPolicy({ admins: bench, requesterId: r.requested_by, billFlat: r.flat });
    const verdict = canApprove({ policy, approver: session.actor, request: r });
    out.push({
      ...r,
      required: policy.required,
      // So the screen can grey the button and say why, rather than offering an
      // action that will be refused.
      canApprove: verdict.ok,
      substitute: verdict.substitute ?? false,
      blockedBecause: verdict.ok ? null : verdict.reason,
      hoursLeft: verdict.hoursLeft ?? null,
    });
  }
  return json({ requests: out });
}

async function decideBillEdit(request, env, session, path, decision) {
  const id = Number(path.split('/')[4]);
  const req = await env.DB.prepare(
    `SELECT r.*, b.flat FROM bill_edit_requests r JOIN bills b ON b.id = r.bill_id
      WHERE r.id = ?`
  ).bind(id).first();
  if (!req) return problem(404, 'DDP-ADMIN-017', 'No such request.');

  // Lapsed on read rather than by a job: the expiry only has to be true at the
  // moment somebody acts on it, and a cron for it would be one more thing to
  // fail quietly.
  if (req.status === 'pending' && Date.parse(req.expires_at) < Date.now()) {
    await env.DB.prepare(
      "UPDATE bill_edit_requests SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'"
    ).bind(new Date().toISOString(), id).run();
    return problem(409, 'DDP-ADMIN-017', 'That request has lapsed. Raise it again if it still stands.');
  }

  const policy = await policyFor(env, { bill: req, requesterId: req.requested_by });
  const verdict = canApprove({ policy, approver: session.actor, request: req });
  if (!verdict.ok) {
    await reportError(env, verdict.code, { requestId: id, actor: session.actor.id, reason: verdict.reason });
    return problem(403, verdict.code,
      verdict.reason === 'requester' ? 'You raised this edit, so you cannot approve it.'
      : verdict.reason === 'too-soon' ? `An admin still has ${verdict.hoursLeft}h to answer.`
      : 'This is not yours to approve.');
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO bill_edit_approvals (request_id, approver_id, decision, substitute, at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (request_id, approver_id) DO UPDATE SET
       decision = excluded.decision, at = excluded.at, substitute = excluded.substitute`
  ).bind(id, session.actor.id, decision, verdict.substitute ? 1 : 0, now).run();

  if (decision === 'reject') {
    await env.DB.prepare(
      "UPDATE bill_edit_requests SET status = 'rejected', resolved_at = ? WHERE id = ?"
    ).bind(now, id).run();
    await audit(env, session, 'bill.edit.reject', { requestId: id, billId: req.bill_id });
    return json({ ok: true, status: 'rejected' });
  }

  const approvals = await env.DB.prepare(
    'SELECT approver_id, decision FROM bill_edit_approvals WHERE request_id = ?'
  ).bind(id).all();

  if (!isSatisfied(policy, approvals.results ?? [])) {
    const yes = (approvals.results ?? []).filter((a) => a.decision === 'approve').length;
    await audit(env, session, 'bill.edit.approve', { requestId: id, billId: req.bill_id, yes });
    return json({ ok: true, status: 'pending', approvals: yes, required: policy.required });
  }

  // The last approval lands: now, and only now, anything changes.
  const bill = await env.DB.prepare('SELECT * FROM bills WHERE id = ?').bind(req.bill_id).first();

  // The month-wide price correction is not an edit to this bill — the bill is
  // only the row the request is anchored to (see requestPriceCorrection). It
  // moves every bill in the month, so it is applied by the same code an open
  // month's rate change uses, and then it is done.
  if (req.field === PRICE_FIELD) {
    return applyPriceCorrection(env, session, { req, bill, id, now, approvals });
  }

  const value = req.value_text ?? req.value;
  // A corrected reading writes the READING as well as the bill, in one batch.
  // Writing only the bill would leave the archive saying one thing and the
  // amount another — and the reading is what a resident checks their own meter
  // against, so it is the half that must not be left stale.
  if (req.field === READING_FIELD) {
    return applyReadingCorrection(env, session, { req, bill, id, now, approvals, value });
  }

  const { next, derived, computed } = await writeBillEdit(env, session, {
    bill, field: req.field, value, reason: req.reason, actorId: req.requested_by,
  });

  await env.DB.prepare(
    "UPDATE bill_edit_requests SET status = 'applied', resolved_at = ? WHERE id = ?"
  ).bind(now, id).run();

  await audit(env, session, `god.edit.bill.${req.field}`, {
    requestId: id, billId: req.bill_id, flat: bill.flat, period: bill.period,
    field: req.field, before: bill[req.field], after: value,
    totalBefore: bill.total, totalAfter: next.total, reason: req.reason,
    approvedBy: (approvals.results ?? []).filter((a) => a.decision === 'approve').map((a) => a.approver_id),
    derived, computed,
  });

  return json({ ok: true, status: 'applied', total: next.total });
}

/**
 * A price correction the committee agreed, applied to the whole month.
 *
 * `changeRate` is the same code an OPEN month's rate change runs, and reusing
 * it is the point: a second implementation of "recalculate every bill" would
 * eventually disagree with the impact figures the approver was shown, and the
 * one nobody is looking at is the one that ran. What it will not do on its own
 * is touch a locked month (DDP-BILL-012) — `allowLocked` is what two other
 * admins buy, and it is the ONLY caller that passes it.
 *
 * A bill carrying `manual_total` is skipped by `planRateChange`, as it always
 * has been. Those are the 898 demo rows from the retired amount-editing path;
 * the doctor counts them so the number can go to zero.
 */
async function applyPriceCorrection(env, session, { req, bill, id, now, approvals }) {
  const result = await changeRate(env, {
    period: bill.period,
    ratePerKg: req.value,
    reason: req.reason,
    actorId: req.requested_by,
    allowLocked: true,
  });

  await env.DB.prepare(
    "UPDATE bill_edit_requests SET status = 'applied', resolved_at = ? WHERE id = ?"
  ).bind(now, id).run();

  // Not a fault, and loud on purpose. Every bill in a published month just
  // moved and some residents who had paid now owe again; that is the largest
  // single act available on this tab and it should never happen quietly.
  await reportError(env, 'DDP-BILL-017', {
    period: bill.period, from: result.from, to: result.to,
    affected: result.totals.billsAffected, owesAgain: result.totals.owesAgainCount,
    requestId: id,
  });

  await audit(env, session, 'period.rate-correction', {
    requestId: id, period: bill.period, from: result.from, to: result.to,
    reason: req.reason, totals: result.totals,
    approvedBy: (approvals.results ?? []).filter((a) => a.decision === 'approve').map((a) => a.approver_id),
  });

  return json({ ok: true, status: 'applied', period: bill.period, totals: result.totals });
}

/**
 * A corrected reading the committee agreed, applied to the reading AND the bill.
 *
 * One D1 batch, because a reading written without its bill (or the other way
 * round) is a flat whose amount no longer matches its own meter — the exact
 * condition DDP-BILL-003 exists to shout about, arrived at by our own hand.
 *
 * `manual_total` is cleared: this total IS derived now, which is the whole
 * point of correcting the reading rather than the amount.
 */
async function applyReadingCorrection(env, session, { req, bill, id, now, approvals, value }) {
  const context = await readingContext(env, bill);
  const plan = planReadingCorrection({ bill, reading: value, ...context });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO readings (flat, period, reading, read_on, entered_by, entered_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (flat, period) DO UPDATE SET
         reading = excluded.reading, entered_by = excluded.entered_by,
         entered_at = excluded.entered_at`
    ).bind(bill.flat, bill.period, plan.reading, `${bill.period}-02`, req.requested_by, now),
    env.DB.prepare(
      `UPDATE bills SET consumption = ?, meter_delta = ?, gas_amount = ?, total = ?,
              manual_total = 0, adjusted_by = ?, adjusted_at = ?, adjust_reason = ?
        WHERE id = ?`
    ).bind(plan.consumption, plan.delta, plan.gasAmount,
           plan.total, req.requested_by, now, req.reason, bill.id),
  ]);

  await env.DB.prepare(
    "UPDATE bill_edit_requests SET status = 'applied', resolved_at = ? WHERE id = ?"
  ).bind(now, id).run();

  await audit(env, session, 'bill.reading-correction', {
    requestId: id, billId: bill.id, flat: bill.flat, period: bill.period,
    readingFrom: context.currentReading, readingTo: plan.reading,
    totalBefore: bill.total, totalAfter: plan.total, reason: req.reason,
    approvedBy: (approvals.results ?? []).filter((a) => a.decision === 'approve').map((a) => a.approver_id),
  });

  return json({ ok: true, status: 'applied', total: plan.total, reading: plan.reading });
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

  // NAMED, not merely refused. "Cannot edit total" tells somebody holding a
  // bill they believe is wrong that the portal will not help them, and the
  // next thing they do is look for another way in. There are two, both real,
  // and both correct the thing that was actually wrong.
  if (field === 'total') {
    await reportError(env, 'DDP-BILL-016', { billId: id, actor: session.actor.id });
    return problem(400, 'DDP-BILL-016',
      'A bill’s amount is not editable. It is consumption times rate, so '
      + 'correct whichever of those was wrong: the flat’s meter reading, or '
      + 'the month’s price of gas. Both are on the Billing tab, and both go '
      + 'to two other admins.');
  }
  if (!BILL_FIELDS.includes(field)) {
    return problem(400, 'DDP-ADMIN-010', `Cannot edit "${field}".`);
  }

  const value = validateBillField(field, body?.value);
  const reason = checkReason(field, body?.reason);   // always required for money

  const change = diff({ entity: 'bill', id, field, before: bill[field], after: value, reason });
  if (!change) return json({ ok: true, unchanged: true });

  const { bill: next, derived, computed } = applyBillEdit(bill, field, value);

  // MONEY DOES NOT MOVE ON ONE PERSON'S SAY-SO. Readings are checked before
  // they are submitted, so an edit after generation means somebody already got
  // it wrong — and correcting it quietly is the thing the committee decided
  // must not be possible. An edit that leaves the total alone still applies at
  // once; there is nothing for a second pair of eyes to protect.
  if (needsApproval({ totalBefore: bill.total, totalAfter: next.total, field })) {
    return requestBillEdit(env, session, {
      bill, field, value, reason, totalAfter: next.total, computed, derived,
      // So the email can carry a link somebody can tap, rather than telling an
      // admin to go and find the console.
      origin: new URL(request.url).origin,
    });
  }

  await writeBillEdit(env, session, { bill, field, value, reason, actorId: session.actor.id });

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
      // Asked of the same function the upload path asks, so this cannot report
      // healthy while readReceipt is short-circuiting on the very next request.
      visionConfigured: visionAvailable(env),
      mailConfigured: mailConfigured(env),
      driveConfigured: driveConfigured(env),
      committeeShared: committeeFolderSeparate(env), remote: true,
    },
    // PRESENCE, NOT VALUES. checkMaintPayee reports only the NAMES of missing
    // settings — this report is written to be pasted into a chat window, and an
    // account number is exactly what must not survive that — so the values
    // never leave the environment, not even into this object.
    payee: {
      MAINT_PAYEE_MODE: env.MAINT_PAYEE_MODE ?? '',
      MAINT_PAYEE_NAME: env.MAINT_PAYEE_NAME ? 'set' : '',
      MAINT_ACCOUNT_NUMBER: env.MAINT_ACCOUNT_NUMBER ? 'set' : '',
      MAINT_IFSC: env.MAINT_IFSC ? 'set' : '',
      MAINT_UPI_VPA: env.MAINT_UPI_VPA ? 'set' : '',
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

/**
 * Usage analytics for god mode — see functions/lib/analytics.js for why.
 *
 * Every count is a GROUP BY over rows the portal already writes. Nothing new
 * is recorded to make this page work, and no query here reads a bill amount,
 * a mobile number or a proof: this screen is about traffic, not money.
 *
 * The grouping is done in SQL because it is indexed on `at` and the alternative
 * is dragging tens of thousands of rows into a Worker to count them. The IST
 * shift is applied inside each query for the reason set out in the module: the
 * building's busiest hours belong to the previous UTC day.
 */
async function godStats(env, url) {
  const days = Math.max(1, Math.min(Number(url.searchParams.get('days') ?? 14), 90));
  const now = new Date().toISOString();
  const range = dayRange(days, now);
  const since = windowStart(days, now);
  // The equal-length window before this one, so every headline number has
  // something to be compared against.
  const previousSince = windowStart(days * 2, now);
  const online = new Date(Date.now() - 15 * 60_000).toISOString();

  const IST = "'+5 hours', '+30 minutes'";

  const [
    daily, dailyLogins, dailyClientErrors, dailyServerErrors,
    weekHours, pageDays, pages, actions, errorCodes, agents,
    owners, firstLogins, lastLogins, activeIds, live, capture, funnel,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT date(at, ${IST}) AS day, COUNT(*) AS events,
              SUM(CASE WHEN kind = 'page' THEN 1 ELSE 0 END) AS pages,
              SUM(CASE WHEN kind = 'action' THEN 1 ELSE 0 END) AS actions,
              COUNT(DISTINCT actor_id) AS people
         FROM activity WHERE at >= ? GROUP BY day`
    ).bind(previousSince).all(),

    env.DB.prepare(
      `SELECT date(at, ${IST}) AS day, COUNT(*) AS logins,
              COUNT(DISTINCT actor_id) AS people
         FROM audit_log WHERE action = 'login' AND at >= ? GROUP BY day`
    ).bind(previousSince).all(),

    // A browser error and a server error are both "something broke for a
    // resident", so they are counted together rather than in two charts.
    env.DB.prepare(
      `SELECT date(at, ${IST}) AS day, COUNT(*) AS errors
         FROM activity WHERE kind = 'client-error' AND at >= ? GROUP BY day`
    ).bind(previousSince).all(),
    env.DB.prepare(
      `SELECT date(at, ${IST}) AS day, COUNT(*) AS errors
         FROM error_log WHERE at >= ? GROUP BY day`
    ).bind(previousSince).all(),

    // Split by weekday as well as hour, which is the difference between
    // "evenings are busy" and "Sunday evening is busy".
    env.DB.prepare(
      `SELECT CAST(strftime('%w', at, ${IST}) AS INTEGER) AS weekday,
              CAST(strftime('%H', at, ${IST}) AS INTEGER) AS hour,
              COUNT(*) AS events
         FROM activity WHERE at >= ? GROUP BY weekday, hour`
    ).bind(since).all(),

    // Per-page daily counts, for the sparkline in each row of the pages table.
    // Capped to the pages that could plausibly make that table.
    env.DB.prepare(
      `SELECT name, date(at, ${IST}) AS day, COUNT(*) AS count
         FROM activity
        WHERE kind = 'page' AND at >= ?
          AND name IN (SELECT name FROM activity WHERE kind = 'page' AND at >= ?
                        GROUP BY name ORDER BY COUNT(*) DESC LIMIT 12)
        GROUP BY name, day`
    ).bind(since, since).all(),

    env.DB.prepare(
      `SELECT name, COUNT(*) AS views, COUNT(DISTINCT actor_id) AS people
         FROM activity WHERE kind = 'page' AND at >= ?
        GROUP BY name ORDER BY views DESC LIMIT 12`
    ).bind(since).all(),

    env.DB.prepare(
      `SELECT action AS name, COUNT(*) AS count, COUNT(DISTINCT actor_id) AS people
         FROM audit_log WHERE at >= ?
        GROUP BY action ORDER BY count DESC LIMIT 12`
    ).bind(since).all(),

    env.DB.prepare(
      `SELECT code, COUNT(*) AS count, MAX(at) AS lastAt
         FROM error_log WHERE at >= ? GROUP BY code ORDER BY count DESC LIMIT 10`
    ).bind(since).all(),

    env.DB.prepare(
      `SELECT user_agent, COUNT(*) AS events, COUNT(DISTINCT actor_id) AS people
         FROM activity WHERE at >= ? AND user_agent IS NOT NULL GROUP BY user_agent`
    ).bind(since).all(),

    env.DB.prepare('SELECT id, flat, name, active FROM owners').all(),

    // FIRST login per resident, for the adoption curve. A flat joins that
    // curve once and never leaves it, so the earliest login is the only one
    // that matters and the window does not bound this query.
    env.DB.prepare(
      "SELECT actor_id, MIN(at) AS at FROM audit_log WHERE action = 'login' GROUP BY actor_id"
    ).all(),

    // Every login ever, not just this window — "has this flat ever used the
    // portal" is a rollout question and does not reset when the window does.
    env.DB.prepare(
      "SELECT actor_id, MAX(at) AS at FROM audit_log WHERE action = 'login' GROUP BY actor_id"
    ).all(),

    env.DB.prepare(
      'SELECT DISTINCT actor_id FROM activity WHERE at >= ? AND actor_id IS NOT NULL'
    ).bind(since).all(),

    env.DB.prepare(
      'SELECT COUNT(DISTINCT actor_id) AS people FROM activity WHERE at >= ?'
    ).bind(online).first(),

    env.DB.prepare("SELECT value, expires_at FROM settings WHERE key = 'click_capture'").first(),

    // The paying funnel, in distinct people per step. Opening the bill is a
    // page view; the other three are audit actions. See funnelOf() for why the
    // last step is not a payment rate.
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(DISTINCT actor_id) FROM activity
           WHERE kind = 'page' AND name = '/dashboard' AND at >= ?) AS opened,
         (SELECT COUNT(DISTINCT actor_id) FROM audit_log
           WHERE action = 'payment.intent' AND at >= ?) AS intents,
         (SELECT COUNT(DISTINCT actor_id) FROM audit_log
           WHERE action = 'proof.upload' AND at >= ?) AS proofs,
         (SELECT COUNT(DISTINCT subject_id) FROM audit_log
           WHERE action = 'proof.approve' AND at >= ?) AS approvals`
    ).bind(since, since, since, since).first(),
  ]);

  const rows = (r) => r?.results ?? [];

  // Errors from both sources land on the same day key before merging, so the
  // series carries one honest "things broke" count per day.
  const errorsByDay = new Map();
  for (const r of [...rows(dailyClientErrors), ...rows(dailyServerErrors)]) {
    errorsByDay.set(r.day, { day: r.day, errors: (errorsByDay.get(r.day)?.errors ?? 0) + Number(r.errors ?? 0) });
  }

  const raw = {
    activity: rows(daily),
    logins: rows(dailyLogins),
    errors: [...errorsByDay.values()],
  };
  const series = mergeDaily(raw, range);
  const previous = mergeDaily(raw, dayRange(days * 2, now).slice(0, days));

  const today = series[series.length - 1];

  return json({
    days,
    from: range[0],
    to: range[range.length - 1],
    generatedAt: toIST(now),
    online: Number(live?.people ?? 0),
    capture: { on: isCaptureOn(capture), expiresAt: toIST(capture?.expires_at) },
    today,
    daily: series,
    totals: summariseWindow(series, previous),
    week: weekHeat(rows(weekHours)),
    pages: topList(rows(pages), { count: 'views' }),
    pageTrends: seriesByKey(rows(pageDays), range),
    funnel: funnelOf(funnel ?? {}),
    adoption: adoptionCurve({
      firstLogins: rows(firstLogins),
      range,
      residents: rows(owners).filter((o) => Number(o.active) === 1).length,
    }),
    actions: topList(rows(actions)),
    errorCodes: rows(errorCodes).map((e) => ({
      ...e, atIST: toIST(e.lastAt), message: ERROR_CODES[e.code]?.message ?? '',
    })),
    devices: deviceSplit(rows(agents)),
    reach: reachOf({
      owners: rows(owners),
      lastLogins: rows(lastLogins),
      activeIds: rows(activeIds).map((r) => r.actor_id),
      now,
    }),
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
/**
 * "Is this link still good?" — the GET behind a reset link.
 *
 * READS AND SPENDS NOTHING, which is the entire point of splitting it from the
 * POST below. Mail scanners, link previewers and corporate proxies fetch URLs
 * out of inboxes automatically, and they issue GET. If following the link were
 * what completed the reset, the resident would arrive at a link something else
 * had already used. So this only reports what the token points at; the reset
 * happens when a person presses the button and the browser POSTs.
 *
 * Returns the flat so the page can say which account is being reset. That is
 * not a leak: whoever holds a 256-bit token that maps to a live row already
 * opened the mailbox it was sent to. Nothing here distinguishes a token that
 * never existed from one that expired or was spent — all three are `usable:
 * false` with the same reason vocabulary the code path uses.
 */
async function resetLinkState(request, env, ctx) {
  const token = new URL(request.url).searchParams.get('t');
  const hash = await linkHash(token);
  if (!hash) return json({ usable: false, reason: 'none' });

  const row = await env.DB.prepare(
    'SELECT * FROM password_resets WHERE link_hash = ?'
  ).bind(hash).first();

  const state = resetState(row);
  if (!state.usable) {
    await reportError(env, 'DDP-AUTH-006', { reason: `link-${state.reason}` }, ctx);
    return json({ usable: false, reason: state.reason });
  }

  const owner = await env.DB.prepare(
    'SELECT flat FROM owners WHERE id = ? AND active = 1'
  ).bind(row.owner_id).first();
  if (!owner) return json({ usable: false, reason: 'none' });

  return json({ usable: true, flat: owner.flat });
}

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

  // Two ways through one reset: the typed code, and an opaque link token. Only
  // the token's HASH is stored, so the row cannot hand back a working link —
  // the same reasoning as the code beside it, for the same reason.
  const token = generateLinkToken();
  await env.DB.prepare(
    `INSERT INTO password_resets
       (owner_id, code_hash, code_salt, code_iterations, sent_to, expires_at,
        created_at, link_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(owner.id, hash, salt, iterations, owner.email,
         expiryFrom(now), now.toISOString(), await linkHash(token)).run();

  const { subject, text, html } = resetEmail({
    code, name: owner.name, flat: owner.flat,
    link: resetLinkUrl(token, new URL(request.url).origin),
  });
  const result = await sendEmail(env, { to: owner.email, subject, text, html });

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
  const password = String(body?.password ?? '');

  // Two proofs, one reset. A `token` is the link's; anything else is the typed
  // code, which additionally needs the mobile the code was sent for.
  //
  // The token replaces BOTH the mobile and the code, and the enumeration
  // reasoning that shapes the code path below does not apply to it: there is
  // no supplied identity to confirm or deny, so a bad token is simply a bad
  // token. It is verified by lookup — holding a 256-bit secret that matches a
  // live row IS the proof, so there is nothing here to compare and no attempt
  // to count against a limit designed for six guessable digits.
  const linkToken = String(body?.token ?? '');
  let owner; let row;

  if (linkToken) {
    const hash = await linkHash(linkToken);
    row = hash && await env.DB.prepare(
      'SELECT * FROM password_resets WHERE link_hash = ?'
    ).bind(hash).first();

    const state = resetState(row);
    if (!state.usable) {
      await reportError(env, 'DDP-AUTH-009', { reason: `link-${state.reason}` }, ctx);
      // Not failureMessage(): that vocabulary is the code's, and every one of
      // its sentences talks about a number the resident typed and a code they
      // entered. Somebody who followed a link did neither.
      return problem(400, 'DDP-AUTH-009',
        'That link has expired or has already been used. Ask for a new code.');
    }
    owner = await env.DB.prepare(
      `SELECT id, flat, name, mobile, email, role,
              pw_hash, pw_salt, pw_iterations, must_change_pw
         FROM owners WHERE id = ? AND active = 1`
    ).bind(row.owner_id).first();
    if (!owner) {
      await reportError(env, 'DDP-AUTH-009', { reason: 'link-no-account' }, ctx);
      return problem(400, 'DDP-AUTH-009',
        'That link has expired or has already been used. Ask for a new code.');
    }
    return finishReset(env, ctx, owner, row, password);
  }

  try {
    mobile = normaliseMobile(body?.mobile);
  } catch {
    return problem(400, 'DDP-AUTH-009', 'That code is not right, or it has expired.');
  }
  const code = normaliseCode(body?.code);

  owner = await env.DB.prepare(
    // pw_* is read for the reuse check after the code verifies, not before:
    // nothing about this row may influence a reply until then.
    `SELECT id, flat, name, mobile, email, role,
            pw_hash, pw_salt, pw_iterations, must_change_pw
       FROM owners WHERE mobile = ? AND active = 1`
  ).bind(mobile).first();

  // Same reply as a wrong code. An unknown number must not be distinguishable
  // here either, or this endpoint becomes the directory the other one is not.
  if (!owner) {
    await reportError(env, 'DDP-AUTH-009', { mobile, reason: 'no-account' }, ctx);
    return problem(400, 'DDP-AUTH-009', failureMessage('none'));
  }

  row = await env.DB.prepare(
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
  return finishReset(env, ctx, owner, row, password);
}

/**
 * Everything a reset does once its proof has been accepted.
 *
 * Shared by the typed code and the link token deliberately, rather than
 * duplicated per path. The single-use marking, the killing of every other
 * outstanding reset, and the session teardown are the parts that must not
 * differ between the two ways in — a link that reset a password but left the
 * code live, or left old sessions running, would be a quieter bug than a
 * broken one, because it would work.
 *
 * `row` is the reset being spent; `owner` the account it belongs to. Both are
 * already verified by the time this is called, which is why nothing here is
 * neutral about failure: past the proof there is no identity left to protect.
 */
async function finishReset(env, ctx, owner, row, password) {
  validateNewPassword(password, owner);   // throws DDP-AUTH-008/013/014/015
  // Behind the verified proof, so this cannot be used to probe an account's
  // current password from outside. DDP-AUTH-017, and 018 for the ones before.
  // This is the path the history table was most wanted for: a forgotten
  // password is often forgotten because it was recently changed away from.
  await refuseReusedPassword(env, owner.id, password, owner);

  await archivePassword(env, owner.id, owner);
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
    // Any other code OR LINK outstanding for this account dies with it. One
    // resident asking twice leaves two rows; completing either must not leave
    // the other standing, whichever kind it is.
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
    env.DB.prepare('SELECT flat, name, mobile, relationship, active, role FROM owners').all(),
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
    env.DB.prepare('SELECT flat, name, mobile, relationship, active, role FROM owners').all(),
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

  // ONE TRANSACTION, BECAUSE THE FAILURE THIS GUARDS IS A HALF-BUILT BUILDING.
  //
  // This was a loop of awaits: create a flat, insert a person, repeat, ninety
  // times over. Anything that refused partway — a UNIQUE mobile the preview
  // did not catch, a request that ran out of time — left the flats before it
  // created, the people after it missing, and no record of where it stopped.
  // A superadmin's repair for that is to work out by hand which half landed.
  //
  // Password hashing is deliberately slow and cannot go inside a batch, so the
  // passwords are generated first and the writes are assembled as a list. The
  // batch then commits all of it or none of it.
  const now = new Date().toISOString();
  const statements = [];
  const pending = [];

  // Owner and tenant of a let flat are two rows naming one flat; the insert is
  // idempotent either way, but there is no reason to send it twice.
  for (const flat of new Set(preview.create.map((c) => c.flat))) {
    const row = preview.create.find((c) => c.flat === flat);
    statements.push(addFlatStatement(env, flat, row.floor));
  }

  for (const row of preview.create) {
    if (row.vacant) continue;

    const otp = generateOneTimePassword();
    const { hash, salt, iterations } = await hashPassword(otp, ITER(env));
    // Where in the batch this row's id will come back.
    pending.push({ row, otp, at: statements.length });
    statements.push(env.DB.prepare(
      `INSERT INTO owners (flat, name, mobile, email, pw_hash, pw_salt, pw_iterations,
                           must_change_pw, pw_expires_at, role, relationship, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'owner', ?, ?) RETURNING id`
    ).bind(row.flat, row.name, row.mobile, row.email, hash, salt, iterations,
           tempPasswordExpiry(INVITE_PW_HOURS), row.relationship, now));
  }

  const results = await env.DB.batch(statements);

  const created = pending.map(({ row, otp, at }) => {
    const text =
      `Diamond Park gas portal: your login for flat ${row.flat}\n` +
      `Mobile: ${row.mobile}\nTemporary password: ${otp}\n` +
      'Log in at https://diamondpark.pages.dev and choose your own password.';

    return {
      id: results[at]?.results?.[0]?.id,
      flat: row.flat, name: row.name, mobile: row.mobile,
      relationship: row.relationship, oneTimePassword: otp, whatsapp: waLink(row.mobile, text),
    };
  });

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
