import { describe, it, expect } from 'vitest';
import worker from '../functions/index.js';
import { createSession, resolveSession, COOKIE } from '../functions/lib/session.js';
import { dashboardPayload } from '../functions/lib/dashboard.js';
import { testEnv, seed, rows } from './support/d1.js';

/**
 * Per-login menu position (migration 0048), the invisible plumbing: the column
 * exists, the session carries it, /api/me serves it, and PATCH /api/me/nav is
 * the only way to write it — validated, and refused under impersonation.
 *
 * Real migrations against a real engine (see test/support/d1.js), so a test that
 * writes 'drawer' has exercised the actual ADD COLUMN and the actual UPDATE.
 */

const call = (env, method, path, token, body) =>
  worker.fetch(new Request(`https://x${path}`, {
    method,
    headers: { cookie: `${COOKIE}=${token}`, 'content-type': 'application/json' },
    body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined,
  }), env, { waitUntil() {} });

function world() {
  const { db, env } = testEnv();
  seed(db, {
    flats: ['101', '4A'],
    people: [
      { id: 1, flat: '101', name: 'Asha', role: 'owner' },
      { id: 2, flat: '4A', name: 'Super', role: 'superadmin' },
    ],
  });
  // Past onboarding: seed() leaves must_change_pw at its DEFAULT 1, which the
  // router's forced-change gate refuses every write behind. These residents have
  // long since chosen a password.
  db.prepare('UPDATE owners SET must_change_pw = 0').run();
  return { db, env };
}

describe('migration 0048', () => {
  it('adds nav_layout to owners, NULL for every existing row', () => {
    const { db } = world();
    const cols = rows(db, 'PRAGMA table_info(owners)').map((c) => c.name);
    expect(cols).toContain('nav_layout');
    expect(rows(db, 'SELECT nav_layout FROM owners').every((r) => r.nav_layout === null)).toBe(true);
  });
});

describe('the session carries the subject choice', () => {
  it('resolveSession reads nav_layout onto the subject', async () => {
    const { db, env } = world();
    db.prepare('UPDATE owners SET nav_layout = ? WHERE id = 1').run('bottom');
    const { token } = await createSession(env, { actorId: 1, ttlSeconds: 3600 });
    const resolved = await resolveSession(env,
      new Request('https://x/', { headers: { cookie: `${COOKIE}=${token}` } }));
    expect(resolved.subject.navLayout).toBe('bottom');
  });

  it('is null when the resident has never chosen', async () => {
    const { env } = world();
    const { token } = await createSession(env, { actorId: 1, ttlSeconds: 3600 });
    const resolved = await resolveSession(env,
      new Request('https://x/', { headers: { cookie: `${COOKIE}=${token}` } }));
    expect(resolved.subject.navLayout).toBe(null);
  });
});

describe('dashboardPayload / GET /api/me', () => {
  it('carries navLayout through the payload', async () => {
    const { db, env } = world();
    db.prepare('UPDATE owners SET nav_layout = ? WHERE id = 1').run('top');
    const { token } = await createSession(env, { actorId: 1, ttlSeconds: 3600 });
    const res = await call(env, 'GET', '/api/me', token);
    expect(res.status).toBe(200);
    expect((await res.json()).navLayout).toBe('top');
  });

  it('is null before any choice', async () => {
    const { subject } = { subject: { navLayout: null } };
    const { env } = world();
    const payload = await dashboardPayload(env, {
      id: 1, flat: '101', name: 'Asha', role: 'owner', relationship: 'owner',
      active: 1, navLayout: subject.navLayout,
    });
    expect(payload.navLayout).toBe(null);
  });
});

describe('PATCH /api/me/nav', () => {
  it('writes a legal value and returns it', async () => {
    const { db, env } = world();
    const { token } = await createSession(env, { actorId: 1, ttlSeconds: 3600 });
    const res = await call(env, 'PATCH', '/api/me/nav', token, { navLayout: 'drawer' });
    expect(res.status).toBe(200);
    expect((await res.json()).navLayout).toBe('drawer');
    expect(rows(db, 'SELECT nav_layout FROM owners WHERE id = 1')[0].nav_layout).toBe('drawer');
  });

  it('accepts default as a real stored value, distinct from NULL', async () => {
    const { db, env } = world();
    const { token } = await createSession(env, { actorId: 1, ttlSeconds: 3600 });
    const res = await call(env, 'PATCH', '/api/me/nav', token, { navLayout: 'default' });
    expect(res.status).toBe(200);
    expect(rows(db, 'SELECT nav_layout FROM owners WHERE id = 1')[0].nav_layout).toBe('default');
  });

  it('rejects an unknown value without writing', async () => {
    const { db, env } = world();
    const { token } = await createSession(env, { actorId: 1, ttlSeconds: 3600 });
    const res = await call(env, 'PATCH', '/api/me/nav', token, { navLayout: 'sideways' });
    expect(res.status).toBe(400);
    expect(rows(db, 'SELECT nav_layout FROM owners WHERE id = 1')[0].nav_layout).toBe(null);
  });

  it('rejects a missing value', async () => {
    const { env } = world();
    const { token } = await createSession(env, { actorId: 1, ttlSeconds: 3600 });
    const res = await call(env, 'PATCH', '/api/me/nav', token, {});
    expect(res.status).toBe(400);
  });

  it('refuses under impersonation and leaves the resident row untouched', async () => {
    const { db, env } = world();
    // Superadmin (2) viewing as resident (1) WITH write — so the router's
    // read-only gate lets it through and the refusal that fires is the
    // endpoint's own, not a coincidence of the banner being read-only.
    const { token } = await createSession(env,
      { actorId: 2, subjectId: 1, mode: 'impersonate_rw', ttlSeconds: 3600 });
    const res = await call(env, 'PATCH', '/api/me/nav', token, { navLayout: 'drawer' });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('DDP-AUTH-007');
    expect(rows(db, 'SELECT nav_layout FROM owners WHERE id = 1')[0].nav_layout).toBe(null);
  });
});

describe('independence from the profile form', () => {
  it('PATCH /api/me (name/email) never touches nav_layout', async () => {
    const { db, env } = world();
    db.prepare('UPDATE owners SET nav_layout = ? WHERE id = 1').run('drawer');
    const { token } = await createSession(env, { actorId: 1, ttlSeconds: 3600 });
    // The whole reason nav lives on its own route: a name/email save must not be
    // able to clobber the menu choice, and vice versa.
    const res = await call(env, 'PATCH', '/api/me', token,
      { name: 'Asha Updated', email: 'updated@example.com' });
    expect(res.status).toBe(200);
    expect(rows(db, 'SELECT nav_layout, name FROM owners WHERE id = 1')[0])
      .toMatchObject({ nav_layout: 'drawer', name: 'Asha Updated' });
  });
});
