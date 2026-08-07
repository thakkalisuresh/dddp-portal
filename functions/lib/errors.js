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

async function sendTelegram(env, code, severity, message, detail, at) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return; // DDP-SYS-005 is raised by assertAlerting at boot

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

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: body, disable_web_page_preview: true }),
    });
  } catch {
    // Nothing useful to do; the row is already in error_log.
  }
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
