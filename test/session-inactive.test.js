import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSession, COOKIE } from '../functions/lib/session.js';

/**
 * Deactivating someone has to end their access. On 2026-09-11 nine deactivated
 * test accounts on production still held 30 live sessions, because
 * resolveSession joined owners for the actor and subject but never read
 * `active`. These pin the check that closes it.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

/** Enough D1 to answer the session SELECT and record every write. */
function fakeEnv(row) {
  const writes = [];
  return {
    writes,
    DB: {
      prepare(sql) {
        return {
          bind: (...args) => ({
            first: async () => (sql.includes('FROM sessions s') ? row : null),
            run: async () => { writes.push({ sql, args }); return {}; },
          }),
        };
      },
    },
  };
}

const request = (token = 'tok123456') =>
  new Request('https://x/api/me', { headers: { cookie: `${COOKIE}=${token}` } });

function sessionRow(over = {}) {
  return {
    token: 'tok123456', actor_id: 103, subject_id: 103, mode: 'normal', expires_at: FUTURE,
    actor_name: 'Test', actor_role: 'admin', actor_flat: '1A', actor_active: 1,
    subject_name: 'Test', subject_role: 'admin', subject_flat: '1A',
    subject_mobile: '+919990000001', subject_email: null, subject_must_change_pw: 0,
    subject_relationship: 'owner', subject_active: 1,
    ...over,
  };
}

const deletes = (env) => env.writes.filter((w) => w.sql.startsWith('DELETE FROM sessions'));

describe('resolveSession and deactivated accounts', () => {
  it('resolves an active account as before', async () => {
    const env = fakeEnv(sessionRow());
    const s = await resolveSession(env, request());
    expect(s.actor.id).toBe(103);
    expect(deletes(env)).toHaveLength(0);
  });

  it('treats an inactive actor as no session, and deletes that session row', async () => {
    const env = fakeEnv(sessionRow({ actor_active: 0, subject_active: 0 }));
    expect(await resolveSession(env, request())).toBeNull();

    const d = deletes(env);
    expect(d).toHaveLength(1);
    // Only the token presented — not every session touching this owner, which
    // would also end an admin's god-mode view of them.
    expect(d[0].sql).toContain('WHERE token = ?');
    expect(d[0].args).toEqual(['tok123456']);
  });

  it('logs the ended session so a deactivation path that skipped the delete shows up', async () => {
    const env = fakeEnv(sessionRow({ actor_active: 0 }));
    await resolveSession(env, request());
    const logged = env.writes.find((w) => w.sql.includes('INSERT INTO error_log'));
    expect(logged.args[0]).toBe('DDP-AUTH-019');
  });

  it('refuses an inactive admin impersonating an active resident', async () => {
    // The dangerous case: a departed admin's god-mode cookie. The subject being
    // active must not rescue it.
    const env = fakeEnv(sessionRow({
      actor_active: 0, subject_id: 200, subject_active: 1, mode: 'impersonate_rw',
    }));
    expect(await resolveSession(env, request())).toBeNull();
  });

  it('still lets an active admin view a departed resident in god mode', async () => {
    const env = fakeEnv(sessionRow({
      actor_id: 1, actor_role: 'superadmin', actor_active: 1,
      subject_id: 150, subject_role: 'owner', subject_active: 0, mode: 'impersonate_ro',
    }));
    const s = await resolveSession(env, request());
    expect(s).not.toBeNull();
    expect(s.impersonating).toBe(true);
    // Handed on unchanged, so billAccess can answer "departed" for the view.
    expect(s.subject.active).toBe(0);
    expect(deletes(env)).toHaveLength(0);
  });

  it('an expired session is still destroyed first, whatever the account state', async () => {
    const env = fakeEnv(sessionRow({ expires_at: '2020-01-01T00:00:00.000Z', actor_active: 0 }));
    expect(await resolveSession(env, request())).toBeNull();
    expect(deletes(env)).toHaveLength(1);
  });
});

describe('every deactivation in the router ends the account\'s sessions', () => {
  // resolveSession is the backstop; deleting at the point of deactivation is
  // still wanted, so the row count stays honest and DDP-AUTH-019 stays quiet.
  // A plain source scan, because these writes live inside large handlers.
  const src = readFileSync(join(root, 'functions', 'index.js'), 'utf8');

  it('finds the deactivation writes it is guarding', () => {
    expect(src.match(/UPDATE owners SET active = 0/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('follows each one with a session delete for the same owner', () => {
    const at = [...src.matchAll(/UPDATE owners SET active = 0/g)].map((m) => m.index);
    for (const i of at) {
      const window = src.slice(i, i + 800);
      expect(window, src.slice(i, i + 80)).toMatch(
        /destroyAllSessionsFor\(|DELETE FROM sessions WHERE actor_id = \? OR subject_id = \?/);
    }
  });

  it('login only finds active accounts', () => {
    // Inactive is answered exactly like an unknown mobile — same 401, same
    // timing — so the login form is not an oracle for who used to live here.
    expect(src).toMatch(/FROM owners WHERE mobile = \? AND active = 1/);
  });
});
