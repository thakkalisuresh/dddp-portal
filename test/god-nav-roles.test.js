import { describe, it, expect } from 'vitest';
import worker from '../functions/index.js';
import { COOKIE } from '../functions/lib/session.js';

/**
 * The superadmin's God-button switch, and roles set per login from the
 * Residents tab. Driven through the router, so the gates are part of the test.
 */

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

function sessionRow(over = {}) {
  return {
    token: 'tok123456', actor_id: 1, subject_id: 1, mode: 'normal', expires_at: FUTURE,
    actor_name: 'Sabarish', actor_role: 'superadmin', actor_flat: '4A', actor_active: 1,
    subject_name: 'Sabarish', subject_role: 'superadmin', subject_flat: '4A',
    subject_mobile: '+919000000001', subject_email: null, subject_must_change_pw: 0,
    subject_relationship: 'owner', subject_active: 1,
    ...over,
  };
}

/** D1 answering by SQL fragment; every statement run is recorded with its binds. */
function fakeEnv(row, { first = {}, all = {} } = {}) {
  const ran = [];
  const pick = (table, sql) => Object.entries(table).find(([k]) => sql.includes(k))?.[1];
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => (sql.includes('FROM sessions s') ? row : (ran.push({ sql, args }), pick(first, sql) ?? null)),
    all: async () => { ran.push({ sql, args }); return { results: pick(all, sql) ?? [] }; },
    run: async () => { ran.push({ sql, args }); return {}; },
  });
  return {
    ran,
    DB: { prepare: (sql) => stmt(sql), batch: async (s) => s.map(() => ({ results: [] })) },
  };
}

const call = (env, method, path, body) => worker.fetch(new Request(`https://x${path}`, {
  method,
  headers: { cookie: `${COOKIE}=tok123456`, 'content-type': 'application/json' },
  body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
}), env, { waitUntil() {} });

describe('POST /api/god/nav', () => {
  it('stores the switch for the superadmin', async () => {
    const env = fakeEnv(sessionRow());
    const res = await call(env, 'POST', '/api/god/nav', { on: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ godNav: false });
    const write = env.ran.find((r) => r.sql.includes("'god_nav'") && r.sql.includes('INSERT'));
    expect(write.args[0]).toBe('off');
  });

  it('is refused to an admin', async () => {
    const env = fakeEnv(sessionRow({ actor_role: 'admin', subject_role: 'admin' }));
    const res = await call(env, 'POST', '/api/god/nav', { on: false });
    expect(res.status).toBe(403);
    expect(env.ran.some((r) => r.sql.includes("'god_nav'"))).toBe(false);
  });

  it('is refused while viewing as a resident', async () => {
    const env = fakeEnv(sessionRow({ mode: 'impersonate_ro', subject_id: 50, subject_role: 'owner' }));
    const res = await call(env, 'POST', '/api/god/nav', { on: true });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/admin/residents/:id role', () => {
  const admin9 = { id: 9, name: 'Ravi', flat: '4B', role: 'admin', relationship: 'owner', active: 1 };
  const threeOwners = [1, 2, 3].map((id) => ({
    id: id + 20, flat: '4B', relationship: 'owner', active: 1, role: 'owner',
  }));

  it('refuses in words to demote an admin into a flat already holding three owners', async () => {
    const env = fakeEnv(sessionRow(), {
      first: { 'FROM owners WHERE id': admin9, "role = 'superadmin'": { n: 1 } },
      all: { 'FROM owners WHERE flat': [...threeOwners, admin9] },
    });
    const res = await call(env, 'PATCH', '/api/admin/residents/9', { role: 'owner' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('DDP-ADMIN-021');
    expect(body.error.message).toContain('Ravi');
    expect(env.ran.some((r) => r.sql.startsWith('UPDATE owners'))).toBe(false);
  });

  it('demotes when the flat has room', async () => {
    const env = fakeEnv(sessionRow(), {
      first: { 'FROM owners WHERE id': admin9, "role = 'superadmin'": { n: 1 } },
      all: { 'FROM owners WHERE flat': [threeOwners[0], admin9] },
    });
    const res = await call(env, 'PATCH', '/api/admin/residents/9', { role: 'owner' });
    expect(res.status).toBe(200);
    const update = env.ran.find((r) => r.sql.startsWith('UPDATE owners'));
    expect(update.args).toEqual(['owner', 9]);
  });

  it('promotes one login without touching the others on the flat', async () => {
    const owner21 = { ...threeOwners[0], name: 'Asha' };
    const env = fakeEnv(sessionRow(), {
      first: { 'FROM owners WHERE id': owner21, "role = 'superadmin'": { n: 1 } },
    });
    const res = await call(env, 'PATCH', '/api/admin/residents/21', { role: 'committee' });
    expect(res.status).toBe(200);
    const updates = env.ran.filter((r) => r.sql.startsWith('UPDATE owners'));
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain('WHERE id = ?');
    expect(updates[0].args).toEqual(['committee', 21]);
  });
});
