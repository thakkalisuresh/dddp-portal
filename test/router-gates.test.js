import { describe, it, expect } from 'vitest';
import worker from '../functions/index.js';
import { COOKIE, forcedChangeRefuses, impersonationRefuses } from '../functions/lib/session.js';

/**
 * Two rules that used to live in some handlers and not others, now enforced
 * once in the router. These go through the exported fetch handler rather than
 * the helpers alone, because "every route" is a claim about the router: a
 * helper test would pass while a route sat above the call and skipped it.
 */

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

function sessionRow(over = {}) {
  return {
    token: 'tok123456', actor_id: 1, subject_id: 1, mode: 'normal', expires_at: FUTURE,
    actor_name: 'Admin', actor_role: 'superadmin', actor_flat: '4A', actor_active: 1,
    subject_name: 'Admin', subject_role: 'superadmin', subject_flat: '4A',
    subject_mobile: '+919000000001', subject_email: null, subject_must_change_pw: 0,
    subject_relationship: 'owner', subject_active: 1,
    ...over,
  };
}

/** D1 that answers the session lookup and records every other statement. */
function fakeEnv(row) {
  const touched = [];
  const stmt = (sql) => ({
    bind: (...args) => stmt(sql, args),
    first: async () => (sql.includes('FROM sessions s') ? row : (touched.push(sql), null)),
    all: async () => { touched.push(sql); return { results: [] }; },
    run: async () => { touched.push(sql); return {}; },
  });
  return {
    touched,
    DB: { prepare: (sql) => stmt(sql), batch: async (s) => { touched.push('batch'); return s.map(() => ({})); } },
  };
}

const call = (env, method, path, body) => worker.fetch(new Request(`https://x${path}`, {
  method,
  headers: { cookie: `${COOKIE}=tok123456`, 'content-type': 'application/json' },
  body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
}), env, { waitUntil() {} });

/** Statements a handler would have run: anything but the refusal's own log row. */
const handlerRan = (env) => env.touched.some((sql) => !sql.includes('error_log'));

describe('an account still on its temporary password', () => {
  const temp = () => fakeEnv(sessionRow({
    actor_role: 'owner', subject_role: 'owner', subject_must_change_pw: 1,
  }));

  it('is refused everything but setting up, before any handler runs', async () => {
    for (const [method, path] of [
      ['GET', '/api/notices'], ['GET', '/api/polls'], ['PATCH', '/api/me'],
      ['POST', '/api/bills/7/intent'], ['GET', '/api/me/bill.pdf'],
    ]) {
      const env = temp();
      const res = await call(env, method, path, {});
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await res.json()).error.code).toBe('DDP-AUTH-020');
      expect(handlerRan(env), `${method} ${path}`).toBe(false);
    }
  });

  it('is not refused the routes that end the state', () => {
    const s = { subject: { mustChangePassword: true }, impersonating: false };
    for (const route of ['GET /api/me', 'POST /api/password', 'POST /api/onboard', 'POST /api/logout']) {
      const [method, path] = route.split(' ');
      expect(forcedChangeRefuses(s, method, path), route).toBe(false);
    }
  });

  it('does not stop an admin viewing as that resident', () => {
    const s = { subject: { mustChangePassword: true }, impersonating: true };
    expect(forcedChangeRefuses(s, 'GET', '/api/notices')).toBe(false);
  });
});

describe('viewing as a resident, read only', () => {
  const ro = () => fakeEnv(sessionRow({
    mode: 'impersonate_ro', subject_id: 50, subject_role: 'owner', subject_flat: '7C',
  }));

  it('cannot reach administration, although the actor outranks the gate', async () => {
    for (const [method, path] of [
      ['POST', '/api/admin/late-fee-exemption/bulk'], ['POST', '/api/god/handover'],
      ['POST', '/api/god/capture'], ['PATCH', '/api/me'], ['POST', '/api/bills/7/intent'],
    ]) {
      const env = ro();
      const res = await call(env, method, path, {});
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await res.json()).error.code).toBe('DDP-AUTH-021');
      expect(handlerRan(env), `${method} ${path}`).toBe(false);
    }
  });

  it('leaves a row saying who tried', async () => {
    const env = ro();
    await call(env, 'POST', '/api/god/handover', {});
    expect(env.touched.some((sql) => sql.includes('INSERT INTO error_log'))).toBe(true);
  });

  it('can still look, leave, and switch to writes', () => {
    const s = { impersonating: true, canWrite: false };
    expect(impersonationRefuses(s, 'GET', '/api/admin/summary')).toBeNull();
    expect(impersonationRefuses(s, 'POST', '/api/god/exit')).toBeNull();
    expect(impersonationRefuses(s, 'POST', '/api/logout')).toBeNull();
    expect(impersonationRefuses(s, 'POST', '/api/god/impersonate/50')).toBeNull();
  });
});

describe('viewing as a resident, writes enabled', () => {
  const rw = { impersonating: true, canWrite: true };

  it('acts as the resident', () => {
    expect(impersonationRefuses(rw, 'POST', '/api/bills/7/intent')).toBeNull();
    expect(impersonationRefuses(rw, 'POST', '/api/notices/3/comments')).toBeNull();
  });

  it('still does not administer the building', () => {
    expect(impersonationRefuses(rw, 'POST', '/api/admin/late-fee-exemption/bulk')).toMatch(/Exit/);
    expect(impersonationRefuses(rw, 'POST', '/api/god/handover')).toMatch(/Exit/);
  });
});

describe('an ordinary session', () => {
  it('is untouched by either rule', () => {
    const s = { impersonating: false, subject: { mustChangePassword: false } };
    expect(forcedChangeRefuses(s, 'POST', '/api/admin/late-fee-exemption/bulk')).toBe(false);
    expect(impersonationRefuses(s, 'POST', '/api/admin/late-fee-exemption/bulk')).toBeNull();
  });
});
