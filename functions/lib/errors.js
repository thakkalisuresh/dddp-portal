/**
 * reportError is the ONLY sanctioned path for a failure to leave the system.
 *
 * The trap this guards against (learned the hard way elsewhere): a code marked
 * `fatal` whose throw sites all bypass the reporter, leaving it invisible to
 * alerts AND the digest — silently inert since deploy. test/error-codes.test.js
 * asserts every code in the registry is reachable from a reportError call.
 */

import { ERROR_CODES, isKnownCode } from './error-codes.js';

const ALERT_WINDOW_MS = 60_000;
const ALERT_MAX_PER_WINDOW = 8;

const alertWindow = { start: 0, count: 0, suppressed: false };

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

/** Token-bucket so one bad deploy cannot fire hundreds of messages. */
export function shouldAlert(now = Date.now()) {
  if (now - alertWindow.start > ALERT_WINDOW_MS) {
    alertWindow.start = now;
    alertWindow.count = 0;
    alertWindow.suppressed = false;
  }
  alertWindow.count += 1;
  if (alertWindow.count > ALERT_MAX_PER_WINDOW) {
    const first = !alertWindow.suppressed;
    alertWindow.suppressed = true;
    return first ? 'suppress-notice' : false;
  }
  return true;
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

  const gate = shouldAlert();
  if (gate === false) return;
  const body = gate === 'suppress-notice'
    ? `DDP-SYS-006 · alert rate limit reached, suppressing further alerts this minute`
    : [
        `${severity.toUpperCase()} · ${code}`,
        message,
        detail ? `\n${detail}` : '',
        `\n${at}`,
      ].join('\n');

  await postToTelegram(env, body);
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
