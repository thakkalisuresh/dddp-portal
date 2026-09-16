import { describe, it, expect } from 'vitest';
import {
  validatePoll, isYesNoPair, isClosed, midpoint, deliveryWarnings,
  canSeePoll, canVote, canManagePoll, canSeeCount, validateBallot,
  optionsFrozen, tally, assertCanClose, assertCanVote, SENDS_PER_DAY, VOTING_FLATS_SQL,
} from '../functions/lib/polls.js';

const opts = (...labels) => labels.map((label) => ({ label }));
const NOW = '2026-09-09T12:00:00.000Z';

describe('validatePoll', () => {
  const base = { title: 'Which quote?', body: 'Three are on the board.',
                 options: opts('Shalimar', 'Deccan'), closesAt: '2026-09-20T12:00:00.000Z', now: NOW };

  it('accepts a well-formed single-choice poll', () => {
    expect(validatePoll(base).ok).toBe(true);
  });

  it('needs a title, a body and at least two options', () => {
    expect(validatePoll({ ...base, title: '  ' }).ok).toBe(false);
    expect(validatePoll({ ...base, body: '' }).ok).toBe(false);
    expect(validatePoll({ ...base, options: opts('Only one') }).ok).toBe(false);
  });

  it('refuses two options that say the same thing', () => {
    // The count would split between them and neither figure is the answer.
    const bad = validatePoll({ ...base, options: opts('Deccan', ' deccan ') });
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/same thing/i);
  });

  it('refuses a closing time that has already passed', () => {
    expect(validatePoll({ ...base, closesAt: '2026-09-01T00:00:00.000Z' }).ok).toBe(false);
  });

  it('has no minimum duration — a short poll is the creator’s call', () => {
    // Decided 2026-09-09: warn, never refuse. deliveryWarnings does the warning.
    expect(validatePoll({ ...base, closesAt: '2026-09-09T13:00:00.000Z' }).ok).toBe(true);
  });

  describe('multi-select', () => {
    const multi = { ...base, multi: true, options: opts('Pool', 'Gym', 'Garden', 'Lifts') };

    it('accepts a capped multi-select', () => {
      expect(validatePoll({ ...multi, maxChoices: 2 }).ok).toBe(true);
    });

    it('needs a cap', () => {
      expect(validatePoll({ ...multi, maxChoices: null }).ok).toBe(false);
    });

    it('refuses a cap of 1, which is single choice spelled a second way', () => {
      // Two representations of the same poll would both have to be understood
      // by the counting code for ever.
      const bad = validatePoll({ ...multi, maxChoices: 1 });
      expect(bad.ok).toBe(false);
      expect(bad.message).toMatch(/same as single choice/i);
    });

    it('refuses a cap that lets a flat pick everything', () => {
      // "Up to 4 of 4" is an abstention that looks like participation.
      const bad = validatePoll({ ...multi, maxChoices: 4 });
      expect(bad.ok).toBe(false);
      expect(bad.message).toMatch(/everything/i);
    });

    it('refuses a yes/no pair, and says why', () => {
      const bad = validatePoll({ ...base, multi: true, maxChoices: 1, options: opts('Yes', 'No') });
      expect(bad.ok).toBe(false);
      expect(bad.message).toMatch(/cannot pick\s+both|cannot be multi-select/i);
    });

    it('allows a yes/no pair as SINGLE choice', () => {
      expect(validatePoll({ ...base, options: opts('Yes', 'No') }).ok).toBe(true);
    });
  });

  it('refuses a pick limit on a single-choice poll', () => {
    expect(validatePoll({ ...base, maxChoices: 2 }).ok).toBe(false);
  });
});

describe('isYesNoPair', () => {
  it('catches the wordings the message promises', () => {
    for (const pair of [['Yes', 'No'], ['y', 'n'], ['Agree', 'Disagree'],
                        ['For', 'Against'], ['Approve', 'Reject']]) {
      expect(isYesNoPair(pair), pair.join('/')).toBe(true);
    }
  });

  it('is order-independent and case-insensitive', () => {
    expect(isYesNoPair(['NO', 'yes'])).toBe(true);
  });

  it('leaves real questions alone', () => {
    expect(isYesNoPair(['Shalimar', 'Deccan'])).toBe(false);
    expect(isYesNoPair(['Yes', 'No', 'Abstain'])).toBe(false);   // three options
    expect(isYesNoPair(['Yes', 'Definitely'])).toBe(false);      // two affirmatives
  });
});

describe('closing', () => {
  const poll = { id: 1, closes_at: '2026-09-20T12:00:00.000Z', closed_at: null };

  it('is open before its closing time and closed after', () => {
    expect(isClosed(poll, '2026-09-19T23:59:00.000Z')).toBe(false);
    expect(isClosed(poll, '2026-09-20T12:00:01.000Z')).toBe(true);
  });

  it('closes exactly ON the closing time', () => {
    expect(isClosed(poll, '2026-09-20T12:00:00.000Z')).toBe(true);
  });

  it('honours an early close even when closes_at is still ahead', () => {
    // An early close is a decision somebody made. A future closes_at must not
    // undo it — that would be a reopening, which nothing may do.
    const early = { ...poll, closed_at: '2026-09-12T09:00:00.000Z' };
    expect(isClosed(early, '2026-09-13T00:00:00.000Z')).toBe(true);
  });

  it('refuses to close a poll twice', () => {
    expect(() => assertCanClose(poll, '2026-09-10T00:00:00.000Z')).not.toThrow();
    expect(() => assertCanClose(poll, '2026-09-21T00:00:00.000Z')).toThrow();
  });
});

describe('midpoint', () => {
  it('puts a 48-hour poll’s reminder at 24 hours', () => {
    expect(midpoint('2026-09-09T00:00:00.000Z', '2026-09-11T00:00:00.000Z'))
      .toBe('2026-09-10T00:00:00.000Z');
  });

  it('scales to a fortnight without a second rule', () => {
    expect(midpoint('2026-09-01T00:00:00.000Z', '2026-09-15T00:00:00.000Z'))
      .toBe('2026-09-08T00:00:00.000Z');
  });

  it('returns null rather than a bogus instant when the dates make no sense', () => {
    expect(midpoint('2026-09-11T00:00:00.000Z', '2026-09-09T00:00:00.000Z')).toBeNull();
    expect(midpoint('not a date', '2026-09-09T00:00:00.000Z')).toBeNull();
  });
});

describe('deliveryWarnings', () => {
  const args = (hours, recipients = 89) => ({
    createdAt: '2026-09-09T00:00:00.000Z',
    closesAt: new Date(Date.parse('2026-09-09T00:00:00.000Z') + hours * 3600_000).toISOString(),
    recipients,
  });

  it('says nothing about a poll with room to send', () => {
    expect(deliveryWarnings(args(24 * 10))).toEqual([]);
  });

  it('warns when the poll closes before the announcement can finish', () => {
    // 89 owners at 60 sends a day is about a day and a half.
    const out = deliveryWarnings(args(6));
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toMatch(/after voting ends/);
  });

  it('warns separately that the midpoint reminder cannot land in time', () => {
    // Two days is enough for the announcement but not for a reminder that only
    // starts draining at the one-day mark.
    const out = deliveryWarnings(args(48));
    expect(out.join(' ')).toMatch(/halfway through/);
  });

  it('is silent when there is nobody to email', () => {
    expect(deliveryWarnings(args(1, 0))).toEqual([]);
  });

  it('states the send rate the rest of the arithmetic depends on', () => {
    expect(SENDS_PER_DAY).toBe(60);
  });
});

describe('who may do what', () => {
  const open = { id: 1, show_tenants: 0, closes_at: '2026-09-20T12:00:00.000Z',
                 closed_at: null, published_at: null, created_by: 7 };
  const tenant = { relationship: 'tenant', role: 'resident' };
  const owner = { relationship: 'owner', role: 'resident' };
  const committee = { role: 'committee', id: 7 };
  const otherCommittee = { role: 'committee', id: 8 };
  const admin = { role: 'admin', id: 2 };
  const god = { role: 'superadmin', id: 1 };

  it('hides an owners-only poll from a tenant and shows it to an owner', () => {
    expect(canSeePoll(open, tenant)).toBe(false);
    expect(canSeePoll(open, owner)).toBe(true);
  });

  it('shows it to a tenant once the committee switches it on', () => {
    expect(canSeePoll({ ...open, show_tenants: 1 }, tenant)).toBe(true);
  });

  it('still refuses that tenant a vote — seeing and voting are separate', () => {
    // The whole reason show_tenants is not a scope: visibility must never
    // become permission.
    expect(canSeePoll({ ...open, show_tenants: 1 }, tenant)).toBe(true);
    expect(canVote(tenant)).toBe(false);
    expect(canVote(owner)).toBe(true);
  });

  it('refuses a vote from a tenant even on a poll they can see', () => {
    expect(() => assertCanVote({ ...open, show_tenants: 1 }, tenant, NOW)).toThrow();
    expect(() => assertCanVote({ ...open, show_tenants: 1 }, owner, NOW)).not.toThrow();
  });

  it('refuses a vote after closing', () => {
    expect(() => assertCanVote(open, owner, '2026-09-21T00:00:00.000Z')).toThrow();
  });

  it('lets a committee member manage only their own poll', () => {
    expect(canManagePoll(open, committee)).toBe(true);
    expect(canManagePoll(open, otherCommittee)).toBe(false);
    expect(canManagePoll(open, admin)).toBe(true);
    expect(canManagePoll(open, owner)).toBe(false);
  });
});

describe('who may see the count', () => {
  const open = { id: 1, closes_at: '2026-09-20T12:00:00.000Z', closed_at: null, published_at: null };
  const closed = { ...open, closed_at: '2026-09-20T12:00:00.000Z' };
  const owner = { relationship: 'owner', role: 'resident' };
  const admin = { role: 'admin' };
  const god = { role: 'superadmin' };

  it('shows nothing to residents or admins while the poll is open', () => {
    expect(canSeeCount(open, owner, NOW)).toBe(false);
    expect(canSeeCount(open, admin, NOW)).toBe(false);
  });

  it('shows the superadmin the live count', () => {
    expect(canSeeCount(open, god, NOW)).toBe(true);
  });

  it('shows the committee the count on close, before publishing', () => {
    expect(canSeeCount(closed, admin, NOW)).toBe(true);
    expect(canSeeCount(closed, owner, NOW)).toBe(false);
  });

  it('shows residents the count only once it is published', () => {
    expect(canSeeCount({ ...closed, published_at: NOW }, owner, NOW)).toBe(true);
  });

  it('treats a poll past its closing time as closed without anyone closing it', () => {
    // Closing is evaluated on read: the crons cannot express "closes at 6pm".
    expect(canSeeCount(open, admin, '2026-09-21T00:00:00.000Z')).toBe(true);
  });
});

describe('validateBallot', () => {
  const single = { multi: 0 };
  const multi = { multi: 1, max_choices: 2 };
  const ids = [10, 11, 12];

  it('needs at least one option', () => {
    expect(validateBallot(single, [], ids).ok).toBe(false);
  });

  it('takes exactly one answer on a single-choice poll', () => {
    expect(validateBallot(single, [10], ids).ok).toBe(true);
    expect(validateBallot(single, [10, 11], ids).ok).toBe(false);
  });

  it('enforces the multi-select ceiling', () => {
    expect(validateBallot(multi, [10, 11], ids).ok).toBe(true);
    expect(validateBallot(multi, [10, 11, 12], ids).ok).toBe(false);
  });

  it('refuses an option that is not on this poll', () => {
    expect(validateBallot(single, [99], ids).ok).toBe(false);
  });

  it('collapses a repeated option rather than counting it twice', () => {
    const out = validateBallot(multi, [10, 10], ids);
    expect(out.ok).toBe(true);
    expect(out.ids).toEqual([10]);
  });
});

describe('options freeze once voting begins', () => {
  it('is open before the first vote and shut after it', () => {
    expect(optionsFrozen(0)).toBe(false);
    expect(optionsFrozen(1)).toBe(true);
  });
});

describe('tally', () => {
  const options = [{ id: 1, label: 'Shalimar' }, { id: 2, label: 'Deccan' }, { id: 3, label: 'KMC' }];

  it('counts votes per option', () => {
    const out = tally(options, [
      { option_id: 1, flat: '2B' }, { option_id: 2, flat: '4A' }, { option_id: 2, flat: '7C' },
    ]);
    expect(out.options.map((o) => o.votes)).toEqual([1, 2, 0]);
  });

  it('counts turnout in FLATS, not rows', () => {
    // A multi-select flat writes several rows. Counting rows would report a
    // turnout larger than the building.
    const out = tally(options, [
      { option_id: 1, flat: '2B' }, { option_id: 2, flat: '2B' }, { option_id: 3, flat: '4A' },
    ]);
    expect(out.flats).toBe(2);
  });

  it('reports a tie and never resolves it', () => {
    const out = tally(options, [{ option_id: 1, flat: '2B' }, { option_id: 2, flat: '4A' }]);
    expect(out.tied).toBe(true);
    expect(out.leaders).toEqual([1, 2]);
  });

  it('is not a tie when nobody has voted', () => {
    const out = tally(options, []);
    expect(out.tied).toBe(false);
    expect(out.flats).toBe(0);
  });

  it('ignores a vote pointing at an option from another poll', () => {
    const out = tally(options, [{ option_id: 99, flat: '2B' }]);
    expect(out.options.every((o) => o.votes === 0)).toBe(true);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   The database half.

   These cover the paths where a bug is a privacy failure rather than a
   glitch: a count reaching somebody who should not have it, a turnout leaking
   through a return value, a ballot opening on a live poll.
   ───────────────────────────────────────────────────────────────────────── */
import {
  getPoll, castVote, publishPoll, getBallot, queuePollReminder, pruneBallots, updatePoll,
  linkedNotice,
} from '../functions/lib/polls.js';

const OPEN_POLL = {
  id: 1, title: 'Which quote?', body: 'Three on the board.',
  multi: 0, max_choices: null, show_tenants: 0,
  closes_at: '2026-09-20T12:00:00.000Z', closed_at: null, published_at: null, created_by: 7,
};
const OPTIONS = [{ id: 10, label: 'Shalimar', sort: 0 },
                 { id: 11, label: 'Deccan', sort: 1 }];
const VOTES = [{ option_id: 10, flat: '2B' }, { option_id: 11, flat: '4A' },
               { option_id: 11, flat: '7C' }];

/** Routes by SQL substring, and records every statement a batch was given. */
function fakeDb({ poll = OPEN_POLL, options = OPTIONS, votes = VOTES, distinctFlats = [] } = {}) {
  const batches = [];
  const runs = [];
  const pick = (sql) => {
    // Not every statement takes a bind — the voting-flats COUNT is
    // prepared and read straight off, which is what D1 allows and what the
    // turnout denominator does.
    if (sql === VOTING_FLATS_SQL) return [{ n: 89 }];
    // Before the generic poll_votes branch: a COUNT reads a scalar, and
    // handing it the rows instead gives .n === undefined, which silently reads
    // as "nobody has voted".
    if (sql.includes('COUNT(*) AS n FROM poll_votes')) return [{ n: votes.length }];
    if (sql.includes('FROM poll_options')) return options;
    if (sql.includes('DISTINCT flat')) return distinctFlats;
    if (sql.includes('FROM poll_votes')) return votes;
    if (sql.includes('FROM owners')) {
      return [{ id: 21, flat: '2B' }, { id: 22, flat: '4A' }, { id: 23, flat: '7C' }];
    }
    if (sql.includes('FROM polls')) return poll ? [poll] : [];
    return [];
  };
  return {
    batches,
    runs,
    DB: {
      prepare(sql) {
        const stmt = {
          _sql: sql,
          // Mirrors D1: first()/all() are available with or without a bind.
          first: async () => pick(sql)[0] ?? null,
          bind: (...args) => ({
            _sql: sql,
            _args: args,
            first: async () => (sql.includes('FROM polls') ? poll : pick(sql)[0] ?? null),
            all: async () => ({ results: pick(sql) }),
            run: async () => { runs.push({ sql, args }); return { meta: { changes: 3 } }; },
          }),
          all: async () => ({ results: pick(sql) }),
        };
        return stmt;
      },
      batch: async (stmts) => { batches.push(stmts.map((s) => ({ sql: s._sql, args: s._args }))); },
    },
  };
}

const owner = { id: 21, flat: '2B', relationship: 'owner', role: 'resident' };
const tenant = { id: 24, flat: '4A', relationship: 'tenant', role: 'resident' };
const admin = { id: 2, flat: '9D', relationship: 'owner', role: 'admin' };
const god = { id: 1, flat: '1A', relationship: 'owner', role: 'superadmin' };

describe('getPoll never ships a count to someone who may not see it', () => {
  it('omits the result entirely for an owner while the poll is open', async () => {
    // Omitted from the PAYLOAD, not hidden in the template — a hidden element
    // is readable in devtools and this must not be.
    const poll = await getPoll(fakeDb(), 1, owner, { now: NOW });
    expect(poll.result).toBeUndefined();
  });

  it('omits it for an admin too', async () => {
    const poll = await getPoll(fakeDb(), 1, admin, { now: NOW });
    expect(poll.result).toBeUndefined();
  });

  it('includes it for the superadmin on an open poll', async () => {
    const poll = await getPoll(fakeDb(), 1, god, { now: NOW });
    expect(poll.result.flats).toBe(3);
    // The denominator comes from the server; the client cannot know it.
    expect(poll.result.flatsTotal).toBe(89);
  });

  it('still sends the options and the flat’s own answer on a closed, unpublished poll', async () => {
    const closed = { ...OPEN_POLL, closed_at: '2026-09-20T12:00:00.000Z' };
    const db = fakeDb({ poll: closed, votes: [{ option_id: 10, flat: '2B', cast_at: NOW }] });
    const poll = await getPoll(db, 1, owner, { now: '2026-09-21T00:00:00.000Z' });
    expect(poll.options).toHaveLength(2);
    expect(poll.myVotes).toEqual([10]);
    expect(poll.result).toBeUndefined();   // not published
  });

  it('returns nothing at all for a tenant on an owners-only poll', async () => {
    expect(await getPoll(fakeDb(), 1, tenant, { now: NOW })).toBeNull();
  });

  it('tells a manager the options are frozen WITHOUT telling them the count', async () => {
    // The vote count is the turnout. A `votesCast` on this payload would hand
    // every admin the number the whole feature hides.
    const poll = await getPoll(fakeDb(), 1, admin, { now: NOW });
    expect(poll.optionsFrozen).toBe(true);
    expect(poll.votesCast).toBeUndefined();
    expect(JSON.stringify(poll)).not.toMatch(/"(votesCast|voteCount|turnout)"/);
  });

  it('does not send even that boolean to somebody who cannot edit', async () => {
    const poll = await getPoll(fakeDb(), 1, owner, { now: NOW });
    expect(poll.optionsFrozen).toBeUndefined();
  });
});

describe('castVote', () => {
  it('replaces a flat’s vote inside ONE batch', async () => {
    // Two statements outside a batch leave a window where the flat holds no
    // vote, and a failure between them is a silent abstention.
    const db = fakeDb();
    await castVote(db, { pollId: 1, optionIds: [11], viewer: owner, now: NOW });
    expect(db.batches).toHaveLength(1);
    const [stmts] = db.batches;
    expect(stmts[0].sql).toMatch(/DELETE FROM poll_votes/);
    expect(stmts[1].sql).toMatch(/INSERT INTO poll_votes/);
  });

  it('records the flat and the owner who actually cast it', async () => {
    const db = fakeDb();
    await castVote(db, { pollId: 1, optionIds: [11], viewer: owner, now: NOW });
    expect(db.batches[0][1].args).toEqual([1, '2B', 11, 21, NOW]);
  });

  it('refuses a tenant', async () => {
    const db = fakeDb({ poll: { ...OPEN_POLL, show_tenants: 1 } });
    await expect(castVote(db, { pollId: 1, optionIds: [10], viewer: tenant, now: NOW }))
      .rejects.toThrow();
  });

  it('refuses a vote once the poll has closed, without anyone closing it', async () => {
    const db = fakeDb();
    await expect(castVote(db, {
      pollId: 1, optionIds: [10], viewer: owner, now: '2026-09-21T00:00:00.000Z',
    })).rejects.toThrow();
  });

  it('refuses an option belonging to another poll', async () => {
    const db = fakeDb();
    await expect(castVote(db, { pollId: 1, optionIds: [99], viewer: owner, now: NOW }))
      .rejects.toThrow();
  });
});

describe('the turnout must not leak through a return value', () => {
  it('queuePollReminder returns a boolean, never how many it queued', async () => {
    // An admin who presses "remind" must not learn the turnout from the answer.
    const db = fakeDb({ distinctFlats: [{ flat: '2B' }] });
    const out = await queuePollReminder(db, 1, { now: NOW });
    expect(out).toBe(true);
    expect(typeof out).not.toBe('number');
  });

  it('queues only the flats that have not voted', async () => {
    const db = fakeDb({ distinctFlats: [{ flat: '2B' }, { flat: '4A' }] });
    await queuePollReminder(db, 1, { now: NOW });
    const queued = db.batches[0].map((s) => s.args[1]);
    expect(queued).toEqual([23]);          // only 7C is outstanding
  });
});

describe('publishing and the ballot are refused on a live poll', () => {
  it('will not publish a count while voting is open', async () => {
    await expect(publishPoll(fakeDb(), 1, { now: NOW })).rejects.toThrow();
  });

  it('will not open the ballot while voting is open', async () => {
    await expect(getBallot(fakeDb(), 1, { now: NOW })).rejects.toThrow();
  });

  it('opens the ballot once the poll has closed', async () => {
    const closed = { ...OPEN_POLL, closed_at: '2026-09-20T12:00:00.000Z' };
    const rows = await getBallot(fakeDb({ poll: closed }), 1, { now: '2026-09-21T00:00:00.000Z' });
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe('pruneBallots', () => {
  it('deletes ballots for polls closed longer ago than the retention window', async () => {
    const db = fakeDb();
    await pruneBallots(db, { now: '2026-09-09T00:00:00.000Z' });
    const [{ sql, args }] = db.runs;
    expect(sql).toMatch(/DELETE FROM poll_votes/);
    expect(sql).toMatch(/closed_at IS NOT NULL/);
    // 183 days before the clock, so a poll closed last week survives.
    expect(args[0] < '2026-03-11').toBe(true);
  });
});

describe('editing a poll', () => {
  const OPEN = {
    id: 1, title: 'Which quote?', body: 'Three on the board.',
    multi: 0, max_choices: null, show_tenants: 0,
    created_at: '2026-09-01T00:00:00.000Z',
    closes_at: '2026-09-21T00:00:00.000Z',
    closed_at: null, published_at: null,
    reminder_at: '2026-09-11T00:00:00.000Z', reminded_at: null, created_by: 7,
  };

  /** Like the fake above, but the vote count is what freezes the options. */
  function editDb({ poll = OPEN, votes = 0, options = OPTIONS } = {}) {
    const batches = [];
    const pick = (sql) => {
      if (sql.includes('FROM poll_options')) return options;
      if (sql.includes('COUNT(*) AS n FROM poll_votes')) return [{ n: votes }];
      if (sql.includes('FROM polls')) return [poll];
      return [];
    };
    return {
      batches,
      DB: {
        prepare: (sql) => ({
          _sql: sql,
          first: async () => pick(sql)[0] ?? null,
          bind: (...args) => ({
            _sql: sql, _args: args,
            first: async () => pick(sql)[0] ?? null,
            all: async () => ({ results: pick(sql) }),
            run: async () => ({ meta: { changes: 1 } }),
          }),
          all: async () => ({ results: pick(sql) }),
        }),
        batch: async (stmts) => {
          batches.push(stmts.map((x) => ({ sql: x._sql, args: x._args })));
        },
      },
    };
  }

  const NOW = '2026-09-09T12:00:00.000Z';

  it('lets the title and description change after votes are cast', async () => {
    const db = editDb({ votes: 34 });
    await expect(updatePoll(db, 1, { title: 'Which quote? (corrected)' }, { now: NOW }))
      .resolves.toBe(true);
  });

  it('refuses to touch the options once the first vote lands', async () => {
    // Changing "Deccan ₹3,80,000" after 34 flats chose it rewrites what they
    // agreed to.
    const db = editDb({ votes: 1 });
    await expect(updatePoll(db, 1, { options: [{ label: 'A' }, { label: 'B' }] }, { now: NOW }))
      .rejects.toThrow();
  });

  it('refuses to flip single↔multi once voting has begun', async () => {
    const db = editDb({ votes: 1 });
    await expect(updatePoll(db, 1, { multi: true, maxChoices: 2 }, { now: NOW }))
      .rejects.toThrow();
  });

  it('allows an option rewrite while nobody has voted', async () => {
    const db = editDb({ votes: 0 });
    await updatePoll(db, 1, { options: [{ label: 'Shalimar' }, { label: 'KMC' }] }, { now: NOW });
    const sqls = db.batches[0].map((w) => w.sql).join(' ');
    expect(sqls).toMatch(/DELETE FROM poll_options/);
    expect(sqls).toMatch(/INSERT INTO poll_options/);
  });

  it('validates the MERGED poll, not just the field that changed', async () => {
    // Renaming one option onto another is only visible if the whole poll is
    // checked; the patch on its own looks fine.
    const db = editDb({ votes: 0 });
    await expect(updatePoll(db, 1, {
      options: [{ label: 'Deccan' }, { label: ' deccan ' }],
    }, { now: NOW })).rejects.toThrow();
  });

  it('refuses every edit once the poll has closed', async () => {
    const closed = { ...OPEN, closed_at: '2026-09-08T00:00:00.000Z' };
    await expect(updatePoll(editDb({ poll: closed }), 1, { title: 'x' }, { now: NOW }))
      .rejects.toThrow();
  });

  it('moves the reminder when the closing time moves and it has not gone out', async () => {
    const db = editDb({ votes: 0 });
    await updatePoll(db, 1, { closesAt: '2026-10-01T00:00:00.000Z' }, { now: NOW });
    // created 1 Sept, closes 1 Oct -> midpoint 16 Sept
    expect(db.batches[0][0].args[6]).toBe('2026-09-16T00:00:00.000Z');
  });

  it('leaves the reminder alone once it HAS gone out', async () => {
    // 0036 says so at the column: recomputing after the letter went would make
    // the row due again and chase every non-voter a second time.
    const reminded = { ...OPEN, reminded_at: '2026-09-11T03:00:00.000Z' };
    const db = editDb({ poll: reminded, votes: 0 });
    await updatePoll(db, 1, { closesAt: '2026-10-01T00:00:00.000Z' }, { now: NOW });
    expect(db.batches[0][0].args[6]).toBe(OPEN.reminder_at);
  });
});

describe('the notice behind a poll', () => {
  const row = (over = {}) => ({
    notice_id: 5, notice_title: 'Three quotes for terrace waterproofing',
    notice_scope: 'all', notice_active: 1, notice_files: 3, ...over,
  });
  const tenant = { relationship: 'tenant', role: 'resident' };
  const owner = { relationship: 'owner', role: 'resident' };

  it('names the notice and how many files it carries', () => {
    expect(linkedNotice(row(), owner))
      .toEqual({ id: 5, title: 'Three quotes for terrace waterproofing', attachmentCount: 3 });
  });

  it('is nothing at all for a poll that stands alone', () => {
    expect(linkedNotice(row({ notice_id: null }), owner)).toBeNull();
  });

  it('HIDES the link rather than breaking it when the reader may not open it', () => {
    // A poll a tenant may read can point at an owners-only notice. A link that
    // 404s for exactly the people the visibility switch was meant to include is
    // worse than no link.
    const owners = row({ notice_scope: 'owners' });
    expect(linkedNotice(owners, tenant)).toBeNull();
    expect(linkedNotice(owners, owner)).not.toBeNull();
  });

  it('drops the link when the notice has been withdrawn', () => {
    // The notice is off the board; a card pointing at it would be a dead end.
    expect(linkedNotice(row({ notice_active: 0 }), owner)).toBeNull();
  });

  it('uses the notice board’s own rule, so the two cannot disagree', () => {
    // canSeeNotice admits an absent owner, which is exactly who an AGM paper is
    // for. If this had its own copy, that would be the case it got wrong.
    const absentOwner = { relationship: 'owner', role: 'resident' };
    expect(linkedNotice(row({ notice_scope: 'owners' }), absentOwner)).not.toBeNull();
  });
});

describe('the turnout denominator', () => {
  /**
   * Flats someone can vote for, not flats being billed. `flats.active` is the
   * billing switch, and it counted a billed flat with nobody on file (or only a
   * tenant) while leaving out an owner-occupied flat taken off billing.
   */
  it('counts flats with a current, non-tenant resident — the same people canVote allows', () => {
    expect(VOTING_FLATS_SQL).toMatch(/COUNT\(DISTINCT flat\)/);
    expect(VOTING_FLATS_SQL).toMatch(/FROM owners/);
    expect(VOTING_FLATS_SQL).toMatch(/active = 1/);
    expect(VOTING_FLATS_SQL).toMatch(/relationship != 'tenant'/);
    expect(VOTING_FLATS_SQL).not.toMatch(/FROM flats/);
    expect(canVote({ relationship: 'tenant' })).toBe(false);
    expect(canVote({ relationship: 'owner' })).toBe(true);
  });
});
