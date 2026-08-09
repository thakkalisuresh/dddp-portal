/**
 * The daily digest.
 *
 * 22 of the 51 live codes are `warn`: duplicate UTRs, duplicate screenshots,
 * login rate limits, unusual readings. None of them justifies waking someone
 * at 02:00, and all of them are worth knowing by morning.
 *
 * Until now the routing comment in error-codes.js claimed these went to a
 * daily digest and no such thing existed — they landed in error_log and were
 * visible only to whoever thought to look. This is that digest.
 *
 * Two rules shape it:
 *
 *   Silence means nothing happened. A digest that arrives every morning
 *   saying "0 warnings" trains you to swipe it away, and the morning it says
 *   something real gets swiped too. Nothing is sent when there is nothing to
 *   report.
 *
 *   The window is [last digest, now], not a fixed 24 hours. If a run is
 *   missed — a deploy, an outage, a suspended Worker — the next one covers
 *   the gap instead of dropping it, and a double run reports nothing the
 *   second time because the window has closed behind it.
 */

import { ERROR_CODES } from './error-codes.js';

export const DIGEST_SETTING = 'last_digest_at';
export const DEFAULT_WINDOW_HOURS = 24;

/** The window to report on. Capped so a long outage cannot produce a wall of text. */
export function digestWindow(lastDigestAt, now = new Date(), maxHours = 72) {
  const end = now.toISOString();
  const earliest = new Date(now.getTime() - maxHours * 3600_000);
  const fallback = new Date(now.getTime() - DEFAULT_WINDOW_HOURS * 3600_000);

  let start = lastDigestAt ? new Date(lastDigestAt) : fallback;
  if (Number.isNaN(start.getTime())) start = fallback;
  if (start < earliest) start = earliest;   // truncated rather than unbounded

  return { start: start.toISOString(), end, truncated: start.getTime() === earliest.getTime() };
}

/**
 * Group rows by code. Counts matter more than individual rows here — "31 ×
 * wrong password" is a story, and 31 separate lines is a wall.
 */
export function summariseErrors(rows) {
  const byCode = new Map();
  for (const r of rows) {
    const e = byCode.get(r.code) ?? { code: r.code, count: 0, last: null, severity: r.severity };
    e.count += 1;
    if (!e.last || r.at > e.last) e.last = r.at;
    byCode.set(r.code, e);
  }
  return [...byCode.values()]
    .map((e) => ({ ...e, message: ERROR_CODES[e.code]?.message ?? e.code }))
    // Loudest first: a code that fired 40 times is the one to look at.
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/**
 * Build the message, or null when there is nothing worth sending.
 *
 * `alerts` (fatal/error) are included as a one-line recap rather than detail:
 * those already arrived instantly, and repeating them in full would make the
 * digest look like a second incident.
 */
export function buildDigest({ warns = [], alerts = [], window, counts = {} }) {
  if (!warns.length && !alerts.length) return null;

  const w = summariseErrors(warns);
  const lines = ['Diamond Park — overnight digest', ''];

  const from = window?.start ? window.start.slice(0, 16).replace('T', ' ') : '';
  const to = window?.end ? window.end.slice(0, 16).replace('T', ' ') : '';
  lines.push(`${from} to ${to} UTC`);
  if (window?.truncated) lines.push('(window truncated — an earlier run was missed)');
  lines.push('');

  if (alerts.length) {
    // Already sent instantly. Here only so the morning count reconciles.
    const a = summariseErrors(alerts);
    lines.push(`${alerts.length} alert${alerts.length === 1 ? '' : 's'} already sent:`);
    for (const e of a) lines.push(`  ${e.count}x ${e.code}`);
    lines.push('');
  }

  if (w.length) {
    lines.push(`${warns.length} warning${warns.length === 1 ? '' : 's'}:`);
    for (const e of w.slice(0, 15)) {
      lines.push(`  ${e.count}x ${e.code} — ${e.message}`);
    }
    if (w.length > 15) lines.push(`  ...and ${w.length - 15} more kinds`);
    lines.push('');
  }

  if (counts.unpaid != null) {
    lines.push(`${counts.unpaid} unpaid bill${counts.unpaid === 1 ? '' : 's'}`
             + (counts.awaiting ? `, ${counts.awaiting} awaiting review` : ''));
    lines.push('');
  }

  lines.push('Full detail in god mode, or: npm run doctor');
  return lines.join('\n');
}

/**
 * Read, build, send, and only then record the new watermark.
 *
 * The watermark moves ONLY after a delivery Telegram acknowledged. Writing it
 * first would mean a failed send silently consumed the window and those
 * warnings were never reported by anything.
 */
export async function runDigest(env, { send, now = new Date() } = {}) {
  const setting = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(DIGEST_SETTING).first().catch(() => null);

  const window = digestWindow(setting?.value ?? null, now);

  const rows = await env.DB.prepare(
    'SELECT code, severity, at FROM error_log WHERE at > ? AND at <= ? ORDER BY at'
  ).bind(window.start, window.end).all();

  const all = rows.results ?? [];
  const warns = all.filter((r) => r.severity === 'warn');
  const alerts = all.filter((r) => r.severity === 'fatal' || r.severity === 'error');

  const bills = await env.DB.prepare(
    `SELECT SUM(status = 'unpaid') AS unpaid, SUM(status = 'awaiting') AS awaiting FROM bills`
  ).first().catch(() => ({}));

  const text = buildDigest({
    warns, alerts, window,
    counts: { unpaid: bills?.unpaid ?? 0, awaiting: bills?.awaiting ?? 0 },
  });

  if (!text) {
    // Nothing to say. Still close the window, or a quiet night's rows would be
    // re-counted tomorrow and look like a fresh problem.
    await setWatermark(env, window.end);
    return { sent: false, reason: 'nothing to report', warns: 0 };
  }

  const ok = await send(text);
  if (ok) await setWatermark(env, window.end);

  return { sent: ok, warns: warns.length, alerts: alerts.length, text };
}

async function setWatermark(env, at) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(DIGEST_SETTING, at).run();
}
