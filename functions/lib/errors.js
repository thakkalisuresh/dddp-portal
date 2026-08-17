/**
 * reportError is the ONLY sanctioned path for a failure to leave the system.
 *
 * The trap this guards against (learned the hard way elsewhere): a code marked
 * `fatal` whose throw sites all bypass the reporter, leaving it invisible to
 * alerts AND the digest — silently inert since deploy. test/error-codes.test.js
 * asserts every code in the registry is reachable from a reportError call.
 */

import { ERROR_CODES, isKnownCode } from './error-codes.js';

/**
 * How long one code stays quiet after it has alerted.
 *
 * Per code, not per minute across everything. The old global bucket let a
 * resident's blurry screenshot exhaust the budget and hide a dead vision
 * provider behind it — the two arrive on the same path, and only one is worth
 * waking anybody for.
 */
const EPISODE_COOLDOWN_MS = 10 * 60_000;

export class AppError extends Error {
  constructor(code, detail) {
    const entry = ERROR_CODES[code];
    // Code leads the message so stack traces and logs are self-identifying.
    super(entry ? `${code} ${entry.message}` : `${code} (unregistered code)`);
    this.name = 'AppError';
    this.code = code;
    this.severity = entry ? entry.severity : 'fatal';
    this.detail = detail ?? null;
  }
}

/** Throw a registered error. Prefer this over bare `throw new Error`. */
export function fail(code, detail) {
  throw new AppError(code, detail);
}

/**
 * Record a failure: always to error_log, and to Telegram when severity warrants.
 * Never throws — reporting must not become the thing that breaks the request.
 */
export async function reportError(env, code, detail, ctx) {
  const severity = isKnownCode(code) ? ERROR_CODES[code].severity : 'fatal';
  const message = isKnownCode(code) ? ERROR_CODES[code].message : `Unregistered code ${code}`;
  const at = new Date().toISOString();
  const detailText = serialise(detail);

  try {
    await env.DB.prepare(
      'INSERT INTO error_log (code, severity, message, detail, at) VALUES (?, ?, ?, ?, ?)'
    ).bind(code, severity, message, detailText, at).run();
  } catch {
    // Swallow: if D1 is the thing that's broken, the alert below still matters.
  }

  if (severity === 'fatal' || severity === 'error') {
    const send = () => sendTelegram(env, code, severity, message, detailText, at);
    if (ctx?.waitUntil) ctx.waitUntil(send());
    else await send();
  }

  return { code, severity, message };
}

function serialise(detail) {
  if (detail == null) return null;
  if (typeof detail === 'string') return detail;
  if (detail instanceof Error) return `${detail.name}: ${detail.message}`;
  try {
    return JSON.stringify(detail).slice(0, 2000);
  } catch {
    return String(detail);
  }
}

/**
 * The suppression policy, as a pure function of what the table remembers.
 *
 * Separated from the read and the write so the rule can be tested without a
 * database — the old version could only be tested by driving module-level
 * state, which is why its per-isolate behaviour was never noticed.
 */
export function episodeDecision(episode, now = Date.now(), cooldownMs = EPISODE_COOLDOWN_MS) {
  const suppressed = Number(episode?.suppressed ?? 0);
  if (!episode?.notified_at) return { send: true, suppressed: 0 };

  const since = now - Date.parse(episode.notified_at);
  // An unparseable timestamp sends. Every ambiguity here resolves towards
  // delivering: a duplicate alert is an annoyance, a swallowed one is the
  // failure this whole module exists to prevent.
  if (!Number.isFinite(since) || since >= cooldownMs) return { send: true, suppressed };
  return { send: false, suppressed: suppressed + 1 };
}

/** Read the episode and apply the policy. Never throws. */
export async function shouldAlert(env, code, now = Date.now()) {
  try {
    const row = await env.DB.prepare(
      'SELECT code, notified_at, suppressed FROM alert_episodes WHERE code = ?'
    ).bind(code).first();
    return episodeDecision(row, now);
  } catch {
    // The table is unreachable. Send anyway, for the reason above.
    return { send: true, suppressed: 0 };
  }
}

async function markNotified(env, code, at) {
  try {
    await env.DB.prepare(
      `INSERT INTO alert_episodes (code, notified_at, suppressed) VALUES (?, ?, 0)
       ON CONFLICT(code) DO UPDATE SET notified_at = excluded.notified_at, suppressed = 0`
    ).bind(code, at).run();
  } catch { /* Losing the stamp costs a duplicate alert, which is the safe side. */ }
}

async function markSuppressed(env, code) {
  try {
    await env.DB.prepare(
      `INSERT INTO alert_episodes (code, notified_at, suppressed) VALUES (?, NULL, 1)
       ON CONFLICT(code) DO UPDATE SET suppressed = suppressed + 1`
    ).bind(code).run();
  } catch { /* As above. */ }
}

/**
 * Write to error_log WITHOUT attempting to notify.
 *
 * This exists solely to break a loop: a failed Telegram send needs recording,
 * but recording it through reportError would try to send again, fail again,
 * and recurse until the request died.
 */
async function logOnly(env, code, detail) {
  const entry = ERROR_CODES[code];
  try {
    await env.DB.prepare(
      'INSERT INTO error_log (code, severity, message, detail, at) VALUES (?, ?, ?, ?, ?)'
    ).bind(code, entry?.severity ?? 'error', entry?.message ?? code,
           serialise(detail), new Date().toISOString()).run();
  } catch {
    // D1 is also gone. There is genuinely nowhere left to put this.
  }
}

/**
 * The one place anything is sent to Telegram. Alerts and the daily digest both
 * go through here so delivery behaves identically for both.
 *
 * Returns true only on a delivery Telegram acknowledged. A non-2xx reply is a
 * failure as much as a thrown fetch is: a revoked token answers 401 politely,
 * and treating that as success is exactly how alerting dies quietly.
 */
export async function postToTelegram(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false; // DDP-SYS-005 is raised by assertAlerting

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      // Deliberately not the response body: it can echo the bot token back.
      await logOnly(env, 'DDP-SYS-004', `Telegram replied ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    await logOnly(env, 'DDP-SYS-004', err);
    return false;
  }
}

async function sendTelegram(env, code, severity, message, detail, at) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const gate = await shouldAlert(env, code);
  if (!gate.send) {
    // Recorded, not sent. The suppression itself is part of the trail — the
    // digest can then say "this fired 300 times" rather than the burst simply
    // not existing.
    await markSuppressed(env, code);
    await logOnly(env, 'DDP-SYS-006', `${code} suppressed within its cooldown`);
    return;
  }

  const body = [
    `${severity.toUpperCase()} · ${code}`,
    message,
    detail ? `\n${detail}` : '',
    // What the burst amounted to, rather than losing it. Reads as "and 47 more
    // since the last one", which is the number that tells you whether this is a
    // recurring nuisance or something that just started.
    gate.suppressed ? `\n${gate.suppressed} more since the last alert for this code.` : '',
    `\n${at}`,
  ].join('\n');

  // ONLY AN ACKNOWLEDGED DELIVERY STARTS THE COOLDOWN. postToTelegram already
  // treats a polite 401 from a revoked token as the failure it is; stamping
  // notified_at regardless would then silence the next ten minutes of a problem
  // nobody has been told about — silence built on top of silence.
  const delivered = await postToTelegram(env, body);
  if (delivered) await markNotified(env, code, new Date().toISOString());
}

/**
 * Call once per request path that can alert. Surfaces the "wired but inert"
 * failure instead of letting it hide until an incident.
 */
export async function assertAlerting(env) {
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) return true;
  await reportError(env, 'DDP-SYS-005', 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID unbound');
  return false;
}
