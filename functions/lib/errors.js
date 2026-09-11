/**
 * reportError is the ONLY sanctioned path for a failure to leave the system.
 *
 * The trap this guards against (learned the hard way elsewhere): a code marked
 * `fatal` whose throw sites all bypass the reporter, leaving it invisible to
 * alerts AND the digest — silently inert since deploy. test/error-codes.test.js
 * asserts every code in the registry is reachable from a reportError call.
 */

import { ERROR_CODES, isKnownCode } from './error-codes.js';
import { classifyDevice } from './analytics.js';

/**
 * The commit that is live, stamped in at build time (scripts/build-pages.mjs,
 * and `--define` on the cron deploy). "dev" under tests and `wrangler dev`.
 * The thing that separates "broke after Tuesday's deploy" from "always broken".
 */
// eslint-disable-next-line no-undef
const RELEASE = typeof __RELEASE__ === 'string' ? __RELEASE__ : 'dev';

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
  const context = alertContext(env.requestContext,
                               detail instanceof Error ? topFrames(detail.stack) : null);

  try {
    await env.DB.prepare(
      'INSERT INTO error_log (code, severity, message, detail, context, at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(code, severity, message, detailText, JSON.stringify(context), at).run();
  } catch {
    // The column arrives with migration 0039. Deployed ahead of it, the insert
    // above fails on every call — and this function swallows failures, so
    // error_log would go quietly empty. Lose the context, never the row.
    try {
      await env.DB.prepare(
        'INSERT INTO error_log (code, severity, message, detail, at) VALUES (?, ?, ?, ?, ?)'
      ).bind(code, severity, message, detailText, at).run();
    } catch {
      // Swallow: if D1 is the thing that's broken, the alert below still matters.
    }
  }

  if (severity === 'fatal' || severity === 'error') {
    const send = () => sendTelegram(env, code, severity, message, detailText, context, at);
    if (ctx?.waitUntil) ctx.waitUntil(send());
    else await send();
  }

  return { code, severity, message };
}

function serialise(detail) {
  if (detail == null) return null;
  if (typeof detail === 'string') return detail;
  if (detail instanceof Error) {
    // An AppError's detail is the part that says WHICH provider and WHAT
    // status. Dropping it left alerts reading "vision returned an error status"
    // with nothing to say which one, or why.
    const base = `${detail.name}: ${detail.message}`;
    return detail.detail == null ? base : `${base} ${serialise(detail.detail)}`;
  }
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

/**
 * The OS and its version, as far as the browser will admit it.
 *
 * Browsers now lie here on purpose, and each lie needs its own handling:
 *  - Chrome on Android reports "Android 10; K" whatever the phone runs. The
 *    real version and model come only as Client Hints, which the portal asks
 *    for with Accept-CH (lib/http.js) — so the first request of a visit lacks
 *    them and later ones carry them.
 *  - Safari 26 froze the iOS token at 18_6. Safari's own version tracks iOS on
 *    an iPhone, so from 26 on that is the better number.
 *  - macOS is frozen at 10_15_7 and Windows 11 still says NT 10.0; neither is
 *    worth printing without a hint.
 * A "~" would be a guess dressed as a fact; a missing version is honest.
 */
function osOf(s, hints) {
  const hinted = String(hints.platformVersion ?? '').replace(/"/g, '');
  const major = hinted ? Number(hinted.split('.')[0]) : null;
  const model = String(hints.model ?? '').replace(/"/g, '').trim();

  if (/iphone|ipad|ipod/i.test(s)) {
    const safari = s.match(/Version\/(\d+)(?:\.(\d+))?/);
    if (safari && Number(safari[1]) >= 26) return `iOS ${safari[1]}${safari[2] ? `.${safari[2]}` : ''}`;
    const m = s.match(/OS (\d+)[_.](\d+)/);
    return m ? `iOS ${m[1]}.${m[2]}` : 'iOS';
  }
  if (/android/i.test(s)) {
    const reduced = /Android 10; K\)/.test(s);
    const m = s.match(/Android (\d+(?:\.\d+)?)/);
    const version = major ? ` ${major}` : m && !reduced ? ` ${m[1]}` : '';
    return `Android${version}${model ? ` (${model})` : ''}`;
  }
  if (/windows/i.test(s)) return major == null ? 'Windows' : major >= 13 ? 'Windows 11' : 'Windows 10';
  if (/cros/i.test(s)) return 'ChromeOS';
  if (/macintosh|mac os x/i.test(s)) return major ? `macOS ${major}` : 'macOS';
  if (/linux/i.test(s)) return 'Linux';
  return null;
}

/**
 * Browser and major version. Order matters: Edge, Samsung and Chrome-on-iOS
 * all carry "Safari/" and "Chrome/" tokens that belong to somebody else.
 */
function browserOf(s) {
  const tests = [
    [/Edg(?:A|iOS)?\/(\d+)/, 'Edge'],
    [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
    [/(?:CriOS|Chrome)\/(\d+)/, 'Chrome'],
    [/(?:FxiOS|Firefox)\/(\d+)/, 'Firefox'],
    [/Version\/(\d+(?:\.\d+)?).*Safari\//, 'Safari'],
  ];
  for (const [re, name] of tests) {
    const m = s.match(re);
    if (m) return `${name} ${m[1]}`;
  }
  return null;
}

/**
 * Phone/tablet/desktop, OS with version, browser with version — and whether it
 * was opened inside WhatsApp or Instagram, which is how most residents arrive
 * from a forwarded link, and whose webviews break things real browsers do not.
 */
export function describeDevice(ua, hints = {}) {
  const s = String(ua ?? '');
  if (!s) return 'unknown device';
  const inApp = /WhatsApp/i.test(s) ? 'in WhatsApp'
    : /Instagram/i.test(s) ? 'in Instagram'
    : /FBAN|FBAV/.test(s) ? 'in Facebook'
    : /; wv\)/.test(s) ? 'in an app webview' : null;
  return [classifyDevice(s), osOf(s, hints), browserOf(s), inApp].filter(Boolean).join(' · ');
}

/** The page the request came from, same-origin only, never its query string. */
function pageOf(referer, origin) {
  try {
    const u = new URL(referer);
    // A query can hold a reset-link token (docs/PRIVACY.md), so never it.
    return u.origin === origin ? u.pathname : null;
  } catch {
    return null;
  }
}

/**
 * Everything about a request an alert should carry, taken once at the top of
 * fetch. `session` is filled in once it resolves.
 *
 * City and country, not the IP. A resident abroad shows as "Dubai, AE" — the
 * question the committee actually asks — without an address that identifies a
 * household's connection going into a chat nothing can be recalled from.
 */
export function requestContextFor(request) {
  const h = request.headers;
  const url = new URL(request.url);
  const cf = request.cf ?? {};
  return {
    route: `${request.method} ${url.pathname}`,   // pathname only: a query can carry a reset token
    page: pageOf(h.get('referer'), url.origin),
    device: describeDevice(h.get('user-agent'), {
      platformVersion: h.get('sec-ch-ua-platform-version'),
      model: h.get('sec-ch-ua-model'),
    }),
    location: [cf.city, cf.country].filter(Boolean).join(', ') || null,
    ray: h.get('cf-ray'),
    session: null,
  };
}

/** "Flat 5A · tenant · Priya (#42)", with the role only when it is above resident. */
function describePerson(p) {
  const first = String(p.name ?? '').trim().split(/\s+/)[0] || 'unnamed';
  const role = p.role && p.role !== 'owner' ? ` · ${p.role}` : '';
  return `Flat ${p.flat ?? '—'} · ${p.relationship ?? 'owner'}${role} · ${first} (#${p.id})`;
}

/** The first few frames — where it broke, not the whole path there. */
export function topFrames(stack, depth = 3) {
  const frames = String(stack ?? '').split('\n').map((l) => l.trim())
    .filter((l) => l.startsWith('at ')).slice(0, depth);
  return frames.length ? frames.join('\n') : null;
}

/**
 * What gets stored in error_log.context and printed in the alert.
 *
 * FIRST NAME AND ID, NEVER MOBILE, EMAIL OR IP. The chat is wider than the
 * console (docs/PRIVACY.md); the first name makes the alert readable at a
 * glance and the id is what finds the rest in Residents. With no request
 * behind it (the nightly cron) there is no `who`, so the alert does not claim
 * a person — only the release and, for a throw, the stack.
 */
export function alertContext(context, stack = null) {
  const s = context?.session;
  const record = {
    who: context ? (s ? describePerson(s.actor) : 'not signed in') : null,
    // An admin in god mode is the actor; the resident whose screen they are
    // looking at is where the bad data probably lives.
    viewingAs: s?.impersonating ? describePerson(s.subject) : null,
    device: context?.device, location: context?.location,
    page: context?.page, route: context?.route, ray: context?.ray,
    release: RELEASE, stack,
  };
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v != null));
}

/** The alert's middle block. The stack is printed separately, after the detail. */
export function describeContext(c) {
  if (!c) return null;
  return [
    c.who && `Who: ${c.who}`,
    c.viewingAs && `Viewing as: ${c.viewingAs}`,
    c.device && `Device: ${c.device}`,
    c.location && `From: ${c.location}`,
    c.route && `Route: ${c.route}${c.page ? ` (on ${c.page})` : ''}`,
    `Release: ${c.release}${c.ray ? ` · ray ${c.ray}` : ''}`,
  ].filter(Boolean).join('\n');
}

async function sendTelegram(env, code, severity, message, detail, context, at) {
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
    `\n${describeContext(context)}`,
    detail ? `\n${detail}` : '',
    context?.stack ? `\n${context.stack}` : '',
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
