import { describe, it, expect } from 'vitest';
import worker from '../functions/index.js';
import { COOKIE } from '../functions/lib/session.js';

/**
 * One of several co-owners moves out while the others stay.
 *
 * The occupancy dropdown cannot express this — every one of its transitions
 * empties a party at a time, which was the only shape a flat could have when a
 * party was one person. These go through the real router because the rule that
 * matters is a refusal: the LAST owner or tenant is not removable here, since
 * that is a change of occupancy and carries the billing question with it.
 */

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

const session = {
  token: 'tok123456', actor_id: 1, subject_id: 1, mode: 'normal', expires_at: FUTURE,
  actor_name: 'Admin', actor_role: 'superadmin', actor_flat: '4A', actor_active: 1,
  subject_name: 'Admin', subject_role: 'superadmin', subject_flat: '4A',
  subject_mobile: '+919000000001', subject_email: null, subject_must_change_pw: 0,
  subject_relationship: 'owner', subject_active: 1,
};

const person = (id, relationship, over = {}) => ({
  id, flat: '5B', name: `P${id}`, relationship, active: 1, role: 'owner', ...over,
});

/** D1 that answers the session, the target and the flat, and records writes. */
function fakeEnv({ target, people }) {
  const writes = [];
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => {
      if (sql.includes('FROM sessions s')) return session;
      if (sql.includes('FROM owners WHERE id = ?')) return target;
      return null;
    },
    all: async () => {
      if (sql.includes('FROM owners WHERE flat = ?')) return { results: people };
      return { results: [] };
    },
    run: async () => { writes.push({ sql, args }); return {}; },
  });
  return {
    writes,
    DB: {
      prepare: (sql) => stmt(sql),
      batch: async (statements) => { writes.push(...statements.map((s) => s.__w ?? { sql: 'batch' })); return []; },
    },
  };
}

/** Batch statements record themselves through bind(), so read them off writes. */
function envWithBatch(fixture) {
  const env = fakeEnv(fixture);
  const prepare = env.DB.prepare;
  env.DB.prepare = (sql) => {
    const s = prepare(sql);
    const bind = s.bind;
    s.bind = (...args) => Object.assign(bind(...args), { __w: { sql, args } });
    return s;
  };
  return env;
}

const depart = (env, id = 50) => worker.fetch(new Request(`https://x/api/admin/residents/${id}/depart`, {
  method: 'POST',
  headers: { cookie: `${COOKIE}=tok123456`, 'content-type': 'application/json' },
  body: JSON.stringify({ reason: 'sold their share' }),
}), env, { waitUntil() {} });

describe('one of three owners moves out', () => {
  const fixture = {
    target: person(50, 'owner'),
    people: [person(49, 'owner'), person(50, 'owner'), person(51, 'owner')],
  };

  it('deactivates them and hands their unsettled bills to the oldest left', async () => {
    const env = envWithBatch(fixture);
    const res = await depart(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ billsTo: 'P49' });

    const sql = env.writes.map((w) => w.sql).join(' | ');
    expect(sql).toMatch(/UPDATE owners SET active = 0/);
    // Unsettled only: a paid bill is the record of who paid it.
    expect(sql).toMatch(/UPDATE bills SET owner_id = \?[\s\S]*NOT IN \('paid', 'waived'\)/);

    const repoint = env.writes.find((w) => w.sql.includes('UPDATE bills'));
    expect(repoint.args).toEqual([49, 50]);
  });

  it('ends their sessions, because the login goes with the flat', async () => {
    const env = envWithBatch(fixture);
    await depart(env);
    expect(env.writes.some((w) => /DELETE FROM sessions/.test(w.sql))).toBe(true);
  });
});

describe('the last one of a party', () => {
  it('is refused, and sent to the control that asks about the billing', async () => {
    const env = envWithBatch({
      target: person(50, 'owner'),
      people: [person(50, 'owner'), person(70, 'tenant')],
    });
    const res = await depart(env);
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toMatch(/occupancy control/i);
    expect(env.writes.some((w) => /UPDATE owners/.test(w.sql))).toBe(false);
  });

  it('does not treat a tenant as somebody who can inherit the owners\' debt', async () => {
    // Two people on the flat, one of each party: neither is removable here.
    const env = envWithBatch({
      target: person(70, 'tenant'),
      people: [person(50, 'owner'), person(70, 'tenant')],
    });
    const res = await depart(env, 70);
    expect(res.status).toBe(409);
  });
});

describe('somebody who has already gone', () => {
  it('is not deactivated twice', async () => {
    const env = envWithBatch({
      target: person(50, 'owner', { active: 0 }),
      people: [person(49, 'owner'), person(50, 'owner', { active: 0 })],
    });
    const res = await depart(env);
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toMatch(/already moved out/i);
  });
});
