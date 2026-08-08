import { reportError } from './errors.js';

/**
 * Applied to every response, including static assets.
 *
 * The CSP is strict-by-default and possible because the app has no bundler, no
 * CDN and no analytics: everything is same-origin. `frame-ancestors 'none'`
 * matters most — it stops the portal being framed by a lookalike that
 * harvests logins.
 */
export const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",   // inline <style> blocks in the pages
    "img-src 'self' data: blob:",         // blob: for the local upload preview
    "font-src 'self'",                    // fonts are self-hosted, no CDN
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(), microphone=(), payment=(), interest-cohort=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

export function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store', // resident data must never cache
      ...(init.headers ?? {}),
    },
  });
}

export function problem(status, code, message, extra = {}) {
  return json({ error: { code, message, ...extra } }, { status });
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Write an audit row. Always against the REAL actor, never the subject. */
export async function audit(env, session, action, detail) {
  await env.DB.prepare(
    'INSERT INTO audit_log (actor_id, subject_id, action, detail, at) VALUES (?, ?, ?, ?, ?)'
  ).bind(
    session?.actor?.id ?? null,
    session?.subject?.id ?? null,
    action,
    detail == null ? null : JSON.stringify(detail).slice(0, 2000),
    new Date().toISOString()
  ).run();
}

/** Rate limiter backed by D1 — no KV needed at this scale. */
export async function rateLimit(env, mobile, { max = 5, windowMinutes = 15 } = {}) {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM login_attempts WHERE mobile = ? AND at > ?'
  ).bind(mobile, since).first();

  if ((row?.n ?? 0) >= max) return false;

  await env.DB.prepare('INSERT INTO login_attempts (mobile, at) VALUES (?, ?)')
    .bind(mobile, new Date().toISOString()).run();
  return true;
}

export async function clearRateLimit(env, mobile) {
  await env.DB.prepare('DELETE FROM login_attempts WHERE mobile = ?').bind(mobile).run();
}

/**
 * Refusals a human can actually trigger deserve an explanation and a way
 * forward — "Something went wrong" to a treasurer who double-clicked Generate
 * is useless. Anything not listed here is a genuine bug and stays generic.
 */
const EXPECTED = {
  'DDP-BILL-005': [409, "Set this month's rate before generating bills."],
  'DDP-BILL-006': [409, 'Bills for this month have already been generated.'],
  'DDP-BILL-007': [409, 'This month is locked. Bills have already been generated for it.'],
  'DDP-BILL-010': [409, "This month has no rate of its own. Enter it — rates aren't carried forward."],
  'DDP-BILL-001': [409, 'Some readings are missing or need fixing. Check the grid before generating.'],
  'DDP-BILL-002': [409, 'A reading is lower than last month. Meters do not run backwards.'],
  'DDP-BILL-008': [409, 'A late fee must be a whole number of rupees.'],
  'DDP-AUTH-007': [403, 'Credentials cannot be changed while viewing as another resident.'],
  'DDP-ADMIN-001': [400, 'That flat or resident is not on the register.'],
  'DDP-ADMIN-003': [400, 'Some required details are missing or malformed.'],
  'DDP-ADMIN-005': [409, 'The outgoing owner has unpaid bills. Settle or write them off before transferring.'],
  'DDP-ADMIN-006': [409, 'That would leave no superadmin. Promote someone else first.'],
  'DDP-NOTICE-001': [404, 'That notice could not be found.'],
  'DDP-NOTICE-002': [403, 'Comments are switched off for this notice.'],
  'DDP-NOTICE-003': [400, 'Write something, and keep it under 1200 characters.'],
  'DDP-NOTICE-004': [429, "You've posted a few times just now. Try again in a little while."],
};

/** Wrap a handler so nothing escapes unreported. */
export async function guard(env, ctx, fn) {
  try {
    return await fn();
  } catch (err) {
    const code = err?.code && String(err.code).startsWith('DDP-') ? err.code : 'DDP-SYS-001';
    await reportError(env, code, err, ctx);
    const [status, message] = EXPECTED[code] ?? [500, 'Something went wrong. It has been logged.'];
    return problem(status, code, message);
  }
}
