import { reportError } from './errors.js';

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
