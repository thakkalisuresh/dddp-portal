import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stateOf, shouldTouch, signedInPeople, loginsToday, tokensToRevoke, sessionIdOf,
  PRESENCE_KINDS, PING_EVERY_SEC, ONLINE_WINDOW_MIN,
} from '../functions/lib/presence.js';
import { createSession, resolveSession, COOKIE } from '../functions/lib/session.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-09-16T16:00:00.000Z');          // 21:30 IST
const ago = (min) => new Date(NOW.getTime() - min * 60_000).toISOString();
const ahead = (days) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

const owners = new Map([
  [1, { id: 1, flat: '4A', name: 'Priya', role: 'owner', relationship: 'owner' }],
  [2, { id: 2, flat: '6G', name: 'Super', role: 'superadmin', relationship: 'owner' }],
  [3, { id: 3, flat: '9C', name: 'Arun', role: 'owner', relationship: 'tenant' }],
]);

const row = (over) => ({
  token: 't', actor_id: 1, subject_id: 1, mode: 'normal',
  created_at: ago(60 * 24 * 4), expires_at: ahead(86), ...over,
});

describe('stateOf', () => {
  it('is online only while a page in front keeps reporting', () => {
    expect(stateOf({ presence: 'online', lastSeenAt: ago(1) }, NOW)).toBe('online');
    expect(stateOf({ presence: 'online', lastSeenAt: ago(ONLINE_WINDOW_MIN + 1) }, NOW)).toBe('away');
    expect(stateOf({ presence: 'online', lastSeenAt: ago(45) }, NOW)).toBe('idle');
  });

  it('a background tab is away, a closed one is signed in only', () => {
    expect(stateOf({ presence: 'away', lastSeenAt: ago(1) }, NOW)).toBe('away');
    expect(stateOf({ presence: 'gone', lastSeenAt: ago(1) }, NOW)).toBe('idle');
  });

  it('judges rows with no page report on last_seen_at alone', () => {
    expect(stateOf({ presence: null, lastSeenAt: ago(2) }, NOW)).toBe('online');
    expect(stateOf({ presence: null, lastSeenAt: null }, NOW)).toBe('idle');
  });

  it('a ping interval leaves room inside the online window', () => {
    expect(PING_EVERY_SEC * 2).toBeLessThanOrEqual(ONLINE_WINDOW_MIN * 60);
  });
});

describe('shouldTouch', () => {
  it('throttles ordinary requests to one write per five minutes', () => {
    expect(shouldTouch(null, NOW)).toBe(true);
    expect(shouldTouch(ago(2), NOW)).toBe(false);
    expect(shouldTouch(ago(5), NOW)).toBe(true);
  });
});

describe('signedInPeople', () => {
  it('groups devices per person, online first, and never returns a token', async () => {
    const r = await signedInPeople({
      now: NOW, owners, currentToken: 'mine',
      sessions: [
        row({ token: 'p-phone', presence: 'online', last_seen_at: ago(1),
              user_agent: 'Mozilla/5.0 (Linux; Android 14) Chrome/128.0 Mobile Safari/537.36' }),
        row({ token: 'p-laptop', presence: 'gone', last_seen_at: ago(300) }),
        row({ token: 'a-old', actor_id: 3, subject_id: 3, last_seen_at: ago(60 * 24 * 12) }),
        row({ token: 'mine', actor_id: 2, subject_id: 2, presence: 'away', last_seen_at: ago(4) }),
      ],
    });
    expect(r).toMatchObject({ online: 1, away: 1, signedIn: 3, devices: 4 });
    expect(r.people.map((p) => p.flat)).toEqual(['4A', '6G', '9C']);
    expect(r.people[0].sessions.map((s) => s.state)).toEqual(['online', 'idle']);
    expect(r.people[0].sessions[0].device).toMatch(/phone/);
    expect(r.people[0].sessions[1].device).toBeNull();
    expect(r.people[1].sessions[0].current).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/p-phone|p-laptop|a-old|"mine"/);
  });

  it('labels an impersonation by whom it is viewing, and a one-day login as shared', async () => {
    const r = await signedInPeople({
      now: NOW, owners, currentToken: 'x',
      sessions: [
        row({ token: 'view', actor_id: 2, subject_id: 1, mode: 'impersonate_ro',
              created_at: ago(5), expires_at: ahead(0.02) }),
        row({ token: 'shared', created_at: ago(5), expires_at: ahead(1) }),
      ],
    });
    const god = r.people.find((p) => p.id === 2).sessions[0];
    expect(god.viewing).toBe('4A · Priya');
    expect(god.sharedDevice).toBe(false);
    expect(r.people.find((p) => p.id === 1).sessions[0].sharedDevice).toBe(true);
  });
});

describe('loginsToday', () => {
  it('counts the IST day, not the UTC one', () => {
    const l = loginsToday({
      now: NOW, owners,
      logins: [
        { actor_id: 1, at: '2026-09-15T19:00:00.000Z', detail: '{"device":"phone · Android"}' }, // 00:30 IST today
        { actor_id: 1, at: '2026-09-16T10:00:00.000Z', detail: null },
        { actor_id: 3, at: '2026-09-15T18:00:00.000Z', detail: null },                          // 23:30 IST yesterday
      ],
    });
    expect(l).toMatchObject({ day: '2026-09-16', count: 2, people: 1 });
    expect(l.rows[1]).toMatchObject({ flat: '4A', device: 'phone · Android' });
  });
});

describe('tokensToRevoke', () => {
  const live = [{ token: 'a' }, { token: 'b' }, { token: 'mine' }];

  it('everywhere spares only the caller\'s own browser', async () => {
    expect(await tokensToRevoke({ sessions: live, currentToken: 'mine' })).toEqual({ tokens: ['a', 'b'] });
  });

  it('finds one device by its hashed id', async () => {
    const id = await sessionIdOf('b');
    expect(await tokensToRevoke({ sessions: live, sessionId: id, currentToken: 'mine' }))
      .toEqual({ tokens: ['b'] });
  });

  it('refuses the current browser and a device already gone', async () => {
    expect((await tokensToRevoke({ sessions: live, sessionId: await sessionIdOf('mine'), currentToken: 'mine' })).error)
      .toMatch(/this browser/);
    expect((await tokensToRevoke({ sessions: live, sessionId: 'nope', currentToken: 'mine' })).error)
      .toMatch(/already/);
  });
});

describe('sessions before migration 0041', () => {
  it('createSession still logs in when the new columns are missing', async () => {
    const sqls = [];
    const env = { DB: { prepare: (sql) => ({ bind: () => ({ run: async () => {
      sqls.push(sql);
      if (sql.includes('user_agent')) throw new Error('D1_ERROR: table sessions has no column named user_agent');
      return {};
    } }) }) } };
    const s = await createSession(env, { actorId: 1, ttlSeconds: 60, userAgent: 'x' });
    expect(s.token).toBeTruthy();
    expect(sqls).toHaveLength(2);
  });

  it('resolveSession writes no presence when the row has no last_seen_at column', async () => {
    const writes = [];
    const base = {
      token: 'tok', actor_id: 1, subject_id: 1, mode: 'normal', expires_at: ahead(1),
      actor_name: 'P', actor_role: 'owner', actor_flat: '4A', actor_active: 1,
      subject_name: 'P', subject_role: 'owner', subject_flat: '4A', subject_active: 1,
    };
    const envFor = (r) => ({ DB: { prepare: (sql) => ({ bind: () => ({
      first: async () => r, run: async () => { writes.push(sql); return {}; },
    }) }) } });
    const req = new Request('https://x/api/me', { headers: { cookie: `${COOKIE}=tok` } });

    expect(await resolveSession(envFor(base), req)).toBeTruthy();
    expect(writes).toHaveLength(0);
    expect(await resolveSession(envFor({ ...base, last_seen_at: null }), req)).toBeTruthy();
    expect(writes).toEqual(['UPDATE sessions SET last_seen_at = ? WHERE token = ?']);
  });
});

describe('wiring', () => {
  const index = readFileSync(join(root, 'functions', 'index.js'), 'utf8');
  const track = readFileSync(join(root, 'public', 'js', 'track.js'), 'utf8');

  it('the panel and sign-out sit behind the superadmin gate', () => {
    const gate = index.indexOf("if (path.startsWith('/api/god/'))");
    for (const route of ["'GET /api/god/sessions'", "'POST /api/god/sessions/signout'"]) {
      expect(index.indexOf(route), route).toBeGreaterThan(gate);
    }
  });

  it('the page reports exactly the presence kinds the server accepts, on its ping interval', () => {
    for (const kind of Object.keys(PRESENCE_KINDS)) expect(track).toContain(`'${kind}'`);
    expect(track).toContain(`PING_MS = ${PING_EVERY_SEC * 1000}`.replace('90000', '90_000'));
  });
});
