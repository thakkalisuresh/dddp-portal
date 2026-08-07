/**
 * DD Diamond Park portal — Worker entry.
 * Phase 1 + 1b: auth, sessions, roles, audit, god mode, error reporting.
 * Billing, payments and proofs land in phases 3–6.
 */

import { json, problem, readJson, audit, rateLimit, clearRateLimit, guard } from './lib/http.js';
import { reportError, assertAlerting } from './lib/errors.js';
import { hashPassword, verifyPassword, generateOneTimePassword, sha256Hex } from './lib/crypto.js';
import { dashboardPayload } from './lib/dashboard.js';
import {
  readingGrid, saveReadings, generateBills, openPeriod, parseReadings,
  previousPeriod, jumpWarning,
} from './lib/admin.js';
import { previewGeneration } from './lib/billing.js';
import { validateUpload, assessProof, shapeQueue, r2Key } from './lib/proof.js';
import { readReceipt } from './lib/vision.js';
import { runScheduled, applyLateFees, staleIntents } from './lib/cron.js';
import { listNotices, getNotice, addComment, setCommentHidden } from './lib/notices.js';
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
      if (route === 'GET /api/me') return me(env, session, request);
      if (route === 'POST /api/password') return changePassword(request, env, session);
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
    await runScheduled(env, ctx);
    // Phase 8: nightly Drive backup.
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
    'SELECT id, flat, status, total FROM bills WHERE id = ? AND flat = ?'
  ).bind(billId, session.subject.flat).first();

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
    'SELECT id, flat, period, total, status FROM bills WHERE id = ? AND flat = ?'
  ).bind(billId, session.subject.flat).first();
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
    `INSERT INTO payment_proofs (bill_id, r2_key, image_sha256, utr, parsed_amount, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?) RETURNING id`
  ).bind(bill.id, key, hash, parsed.utr, parsed.amount, now).first();

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
    `SELECT p.r2_key, p.deleted_at, b.flat
       FROM payment_proofs p JOIN bills b ON b.id = p.bill_id
      WHERE p.id = ?`
  ).bind(proofId).first();

  if (!row) return problem(404, 'DDP-PROOF-005', 'That image could not be found.');

  const isOwner = row.flat === session.subject.flat;
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
    .map((f) => ({ flat: f.flat, reading: f.reading, previous: f.previous, paiseTag: f.paise_tag }));

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
