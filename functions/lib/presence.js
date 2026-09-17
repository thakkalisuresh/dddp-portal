/**
 * Who is signed in, and who has the portal open right now — the god-mode
 * panel's arithmetic, kept out of the router so it can be tested without a
 * database.
 *
 * HOW "OPEN RIGHT NOW" IS KNOWN. A server hears from a browser only when the
 * browser asks for something, so an open page says nothing by itself. Every
 * page that calls trackPage (js/track.js) therefore reports through the
 * existing /api/activity route:
 *
 *   visible   when the page opens or comes back to the front, then every
 *             PING_EVERY_SEC while it stays there
 *   hidden    when it goes to the background (another app, another tab)
 *   pagehide  when it is closed or navigated away from
 *
 * Each of those writes sessions.presence and sessions.last_seen_at for that
 * one device. Nothing about what the person is doing is sent — no input, no
 * position, no page content — only which of three states the tab is in. The
 * login page tells residents that the device and last use are noted.
 *
 * THE TOKEN NEVER LEAVES THE SERVER. A session token is the credential itself;
 * listing them would put every resident's login in the superadmin's browser.
 * Each session is named instead by a prefix of its token's SHA-256, which
 * identifies the row for "sign this device out" and cannot become a cookie.
 */

import { sha256Hex } from './crypto.js';
import { describeDevice } from './errors.js';
import { istDay } from './time.js';
import { toIST } from './tenancy.js';

/** How often a page in front says so. Kept in step with js/track.js. */
export const PING_EVERY_SEC = 90;
/** Silence longer than this and an "online" tab is no longer believed. */
export const ONLINE_WINDOW_MIN = 3;
/** A tab heard from within this long, but not online, reads as away. */
export const AWAY_WINDOW_MIN = 30;
/** How stale last_seen_at may get before an ordinary request refreshes it. */
export const TOUCH_EVERY_MIN = 5;
/**
 * A pagehide that lands this soon after another write is the page being
 * LEFT FOR the next one: the next page's "visible" can reach the server before
 * the old page's goodbye, and must not be overwritten by it.
 */
export const LEAVE_GRACE_MS = 5_000;
/** Anything shorter than this was a "keep me logged in" left unticked (1 day). */
const SHARED_DEVICE_MAX_MS = 2 * 86_400_000;

/** The kinds /api/activity accepts as presence, and the state each one writes. */
export const PRESENCE_KINDS = { visible: 'online', hidden: 'away', pagehide: 'gone' };

export async function sessionIdOf(token) {
  const hex = await sha256Hex(new TextEncoder().encode(String(token)));
  return hex.slice(0, 16);
}

/** Whether an ordinary request should write last_seen_at. Null means never written. */
export function shouldTouch(lastSeenAt, now = new Date()) {
  if (!lastSeenAt) return true;
  const t = new Date(lastSeenAt).getTime();
  return Number.isNaN(t) || now.getTime() - t >= TOUCH_EVERY_MIN * 60_000;
}

const ms = (iso) => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(t) ? null : t;
};

/**
 * One device's state: 'online', 'away' or 'idle' (signed in, not open).
 *
 * `presence` is null on rows no page has reported for — sessions from before
 * migration 0041, or a device that has only called the API. Those are judged
 * on last_seen_at alone.
 */
export function stateOf({ presence, lastSeenAt }, now = new Date()) {
  const seen = ms(lastSeenAt);
  if (seen == null || presence === 'gone') return 'idle';
  const age = now.getTime() - seen;
  if (age <= ONLINE_WINDOW_MIN * 60_000 && (presence == null || presence === 'online')) return 'online';
  if (age <= AWAY_WINDOW_MIN * 60_000) return 'away';
  return 'idle';
}

const RANK = { online: 2, away: 1, idle: 0 };

/**
 * Live sessions plus owners → one entry per person, online first, then most
 * recently seen.
 *
 * @param sessions      unexpired rows of `sessions` (s.*)
 * @param owners        Map id → { id, flat, name, role, relationship }
 * @param currentToken  the superadmin's own token, marked so it cannot be
 *                      signed out from the panel by accident
 */
export async function signedInPeople({ sessions, owners, currentToken, now = new Date() }) {
  const byActor = new Map();

  for (const s of sessions) {
    const owner = owners.get(s.actor_id);
    if (!owner) continue;
    const subject = s.subject_id !== s.actor_id ? owners.get(s.subject_id) : null;
    const created = ms(s.created_at);
    const expires = ms(s.expires_at);
    const seen = ms(s.last_seen_at) ?? created ?? 0;
    const state = stateOf({ presence: s.presence ?? null, lastSeenAt: s.last_seen_at ?? null }, now);

    const entry = byActor.get(s.actor_id) ?? {
      id: owner.id, flat: owner.flat, name: owner.name, role: owner.role,
      relationship: owner.relationship ?? 'owner', sessions: [],
    };
    entry.sessions.push({
      id: await sessionIdOf(s.token),
      current: s.token === currentToken,
      state,
      mode: s.mode,
      viewing: subject ? `${subject.flat} · ${subject.name}` : null,
      device: s.user_agent ? describeDevice(s.user_agent) : null,
      sharedDevice: s.mode === 'normal' && created != null && expires != null
        && expires - created < SHARED_DEVICE_MAX_MS,
      signedInAt: toIST(s.created_at),
      lastSeenAt: s.last_seen_at ? toIST(s.last_seen_at) : null,
      expiresAt: toIST(s.expires_at),
      seen,
    });
    byActor.set(s.actor_id, entry);
  }

  const people = [...byActor.values()].map((p) => {
    p.sessions.sort((a, b) => RANK[b.state] - RANK[a.state] || b.seen - a.seen);
    const top = p.sessions[0];
    const seen = Math.max(...p.sessions.map((s) => s.seen));
    return {
      id: p.id, flat: p.flat, name: p.name, role: p.role, relationship: p.relationship,
      state: top.state,
      lastSeenAt: seen ? toIST(new Date(seen).toISOString()) : null,
      seen,
      sessions: p.sessions.map(({ seen: _s, ...rest }) => rest),
    };
  });

  people.sort((a, b) => RANK[b.state] - RANK[a.state] || b.seen - a.seen
    || String(a.flat).localeCompare(String(b.flat)));

  const devices = people.reduce((n, p) => n + p.sessions.length, 0);
  return {
    online: people.filter((p) => p.state === 'online').length,
    away: people.filter((p) => p.state === 'away').length,
    signedIn: people.length,
    devices,
    people: people.map(({ seen: _s, ...rest }) => rest),
  };
}

/**
 * Today's logins (IST), newest first. `logins` are audit_log rows with
 * action = 'login' from about the last day and a half; the IST filter happens
 * here so the query need not know the offset.
 */
export function loginsToday({ logins, owners, now = new Date() }) {
  const today = istDay(now.toISOString());
  const rows = logins
    .filter((l) => istDay(l.at) === today)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .map((l) => {
      const o = owners.get(l.actor_id);
      let device = null;
      try { device = JSON.parse(l.detail ?? 'null')?.device ?? null; } catch { /* old row */ }
      return { at: toIST(l.at), flat: o?.flat ?? '—', name: o?.name ?? 'unknown', device };
    });
  return {
    day: today,
    count: rows.length,
    people: new Set(logins.filter((l) => istDay(l.at) === today).map((l) => l.actor_id)).size,
    rows,
  };
}

/**
 * What a sign-out may remove. Returns { tokens } or { error }.
 *
 * `sessions` are that person's live rows. The caller's own current session is
 * never on the list: signing yourself out from this panel would leave the page
 * answering 401 with no explanation, and the ordinary Sign out already exists.
 */
export async function tokensToRevoke({ sessions, sessionId, currentToken }) {
  if (!sessionId) {
    return { tokens: sessions.filter((s) => s.token !== currentToken).map((s) => s.token) };
  }
  for (const s of sessions) {
    if (await sessionIdOf(s.token) === sessionId) {
      if (s.token === currentToken) return { error: 'That is this browser. Use Sign out instead.' };
      return { tokens: [s.token] };
    }
  }
  return { error: 'That device is already signed out.' };
}
