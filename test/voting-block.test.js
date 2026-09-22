/**
 * The voting block, where it is actually enforced.
 *
 * `flatVotingStatus` has been tested since step 5 and was right the whole time.
 * What was missing was anybody asking it at the ballot: `castVote` checked that
 * the voter was not a tenant and that the poll was open, and nothing else — so
 * a flat in arrears was shown a live ballot and its vote was accepted. These
 * tests are about the CALLERS, and about the one thing that must stay true of
 * all of them: there is one rule and they all ask it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flatVotingStatus } from '../functions/lib/maint.js';
import { votingStatuses, votingStatusFor, votingBlockedFlats } from '../functions/lib/voting.js';
import { resolveReturn } from '../functions/lib/bill-view.js';
import { freshDb, d1 } from './support/d1.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ── one rule, and only one ─────────────────────────────────────────────── */

describe('nobody keeps a second opinion about who may vote', () => {
  it('decides eligibility in exactly one function', () => {
    // Several modules FETCH an exemption — the resident's own card, the admin
    // payload, lib/voting.js. That is fine. What must never exist is a SECOND
    // implementation of what an exemption or an unpaid quarter means, because
    // the two would disagree in front of a resident.
    const defined = [];
    for (const dir of ['functions', join('functions', 'lib')]) {
      for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith('.js'))) {
        if (/export function flatVotingStatus/.test(readFileSync(join(root, dir, file), 'utf8'))) {
          defined.push(file);
        }
      }
    }
    expect(defined).toEqual(['maint.js']);
  });

  it('has every screen that judges a flat go through that one function', () => {
    // The resident's home card and the shared database reader. The admin
    // directory and the ballot reach the same rule through lib/voting.js.
    for (const file of [join('lib', 'maint-home.js'), join('lib', 'voting.js')]) {
      expect(readFileSync(join(root, 'functions', file), 'utf8'), file)
        .toMatch(/flatVotingStatus/);
    }
  });

  it('enforces the block at the ballot, not only on the card', () => {
    const src = readFileSync(join(root, 'functions', 'lib', 'polls.js'), 'utf8');
    const cast = src.slice(src.indexOf('export async function castVote'));
    expect(cast).toContain('votingStatusFor');
    expect(cast).toContain('DDP-POLL-010');
  });
});

/* ── the rule, read from the database ───────────────────────────────────── */

const seed = (db) => db.exec(`
  INSERT INTO flats (flat, floor) VALUES ('2B', 2), ('4C', 4), ('9A', 9);
  INSERT INTO owners (id, flat, name, mobile, pw_hash, pw_salt, role, created_at) VALUES
    (1, '2B', 'Owed',   '9000000001', 'x', 'y', 'owner', '2026-01-01'),
    (2, '4C', 'Excused','9000000002', 'x', 'y', 'owner', '2026-01-01'),
    (3, '9A', 'Clear',  '9000000003', 'x', 'y', 'admin', '2026-01-01');
  INSERT INTO maint_quarters (quarter, owner_rate, tenant_rate, issue_date, due_date, status, created_at) VALUES
    ('2026-Q2', 7000, 8500, '2026-04-01', '2026-04-11', 'locked', '2026-03-24'),
    ('2026-Q4', 7500, 9000, '2026-10-01', '2026-10-11', 'issued', '2026-09-24');
  INSERT INTO maint_bills (id, flat, quarter, owner_id, rate_applied, basis, total, status, created_at) VALUES
    (1, '2B', '2026-Q2', 1, 7000, 'owner', 7000, 'unpaid', '2026-04-01'),
    (2, '4C', '2026-Q2', 2, 7000, 'owner', 7000, 'unpaid', '2026-04-01'),
    -- A quarter that has NOT ended. It must never block.
    (3, '9A', '2026-Q4', 3, 7500, 'owner', 7500, 'unpaid', '2026-10-01');
`);

const env = (db) => ({ DB: d1(db) });

describe('reading the block out of the database', () => {
  it('blocks a flat that owes an ended quarter, and names the money', async () => {
    const db = freshDb();
    seed(db);
    const s = await votingStatusFor(env(db), '2B', { today: '2026-09-18' });
    expect(s.canVote).toBe(false);
    expect(s.reason).toBe('arrears');
    expect(s.owed).toBe(7000);
    expect(s.quarters).toEqual(['2026-Q2']);
    // The bill itself, so the card's Pay button can be a button.
    expect(s.billIds).toEqual([1]);
  });

  it('does not block a quarter that has not ended yet', async () => {
    const db = freshDb();
    seed(db);
    // Q4 runs to 31 December. Owing it in October is not arrears — the ten days
    // have not even run — and blocking there would bar the whole building.
    expect((await votingStatusFor(env(db), '9A', { today: '2026-10-15' })).canVote).toBe(true);
  });

  it('answers a flat with nothing outstanding without being asked about it', async () => {
    const db = freshDb();
    seed(db);
    const s = await votingStatusFor(env(db), '7D', { today: '2026-09-18' });
    expect(s).toMatchObject({ canVote: true, reason: 'clear', owed: 0 });
  });

  it('needs two admins before an exemption restores a vote', async () => {
    const db = freshDb();
    seed(db);
    // Granted but unapproved is one admin's assertion, and `isVotingExemptOn`
    // refuses it. An exemption restores a right; one person restoring it is
    // exactly the shape this is guarding against.
    db.exec(`INSERT INTO voting_exemptions (flat, reason, ends_at, granted_by, granted_at)
             VALUES ('4C', 'In dispute', '2026-12-31', 3, '2026-09-18')`);
    expect((await votingStatusFor(env(db), '4C', { today: '2026-09-18' })).canVote).toBe(false);

    db.exec("UPDATE voting_exemptions SET approved_by = 1, approved_at = '2026-09-18' WHERE flat = '4C'");
    const s = await votingStatusFor(env(db), '4C', { today: '2026-09-18' });
    expect(s.canVote).toBe(true);
    expect(s.reason).toBe('exempt');
  });

  it('refuses an exemption granted and approved by one person', () => {
    // The rule is in the schema (0042), not only in the code.
    const db = freshDb();
    seed(db);
    expect(() => db.exec(
      `INSERT INTO voting_exemptions (flat, reason, ends_at, granted_by, granted_at, approved_by, approved_at)
       VALUES ('4C', 'In dispute', '2026-12-31', 3, '2026-09-18', 3, '2026-09-18')`)).toThrow();
  });

  it('lets an exemption lapse rather than run forever', async () => {
    const db = freshDb();
    seed(db);
    db.exec(`INSERT INTO voting_exemptions (flat, reason, ends_at, granted_by, granted_at, approved_by, approved_at)
             VALUES ('4C', 'In dispute', '2026-06-30', 3, '2026-04-01', 1, '2026-04-02')`);
    expect((await votingStatusFor(env(db), '4C', { today: '2026-06-30' })).canVote).toBe(true);
    expect((await votingStatusFor(env(db), '4C', { today: '2026-07-01' })).canVote).toBe(false);
  });

  it('asks the question as of the poll, so a quarter cannot start blocking mid-vote', async () => {
    const db = freshDb();
    seed(db);
    // A poll opened on 15 October, read on 2 January. Q4 ended on 31 December
    // in between, and 9A's unpaid Q4 bill must not bar them halfway through a
    // vote they were entitled to when it opened.
    const during = await votingStatusFor(env(db), '9A',
      { pollCreatedAt: '2026-10-15', today: '2027-01-02' });
    expect(during.canVote).toBe(true);
    // Asked about today instead, the same flat is blocked — which is what the
    // admin screen and the next poll will correctly say.
    expect((await votingStatusFor(env(db), '9A', { today: '2027-01-02' })).canVote).toBe(false);
  });

  it('reports only the flats it has something to say about', async () => {
    const db = freshDb();
    seed(db);
    const all = await votingStatuses(env(db), { today: '2026-09-18' });
    // 9A owes an unfinished quarter, so it is present and clear; a flat with no
    // bills at all is absent rather than listed as fine ninety-nine times.
    expect([...all.keys()].sort()).toEqual(['2B', '4C', '9A']);
    expect([...await votingBlockedFlats(env(db), { today: '2026-09-18' })].sort())
      .toEqual(['2B', '4C']);
  });
});

/* ── what the card is handed ────────────────────────────────────────────── */

describe('the locked card has somewhere to go', () => {
  const bill = (over = {}) =>
    ({ id: 11, quarter: '2026-Q2', total: 7000, status: 'unpaid', ...over });

  it('hands the card the oldest debt first', () => {
    const v = flatVotingStatus({
      bills: [bill({ id: 2, quarter: '2026-Q3' }), bill({ id: 1, quarter: '2026-Q2' })],
      pollCreatedAt: '2026-11-01',
    });
    expect(v.billIds).toEqual([1, 2]);
  });

  it('offers nothing to pay when the block is not about money', () => {
    for (const v of [
      flatVotingStatus({ bills: [], pollCreatedAt: '2026-11-01' }),
      flatVotingStatus({
        bills: [bill()], pollCreatedAt: '2026-11-01',
        exemption: { approved_by: 1, ends_at: '2026-12-31' },
      }),
    ]) {
      expect(v.billIds).toEqual([]);
    }
  });

  it('lets the payment sheet come back to the poll it was opened from', () => {
    // Without this the Pay button returned somebody to the dashboard, which is
    // the one place they were not trying to get back to.
    expect(resolveReturn('/polls?id=2')).toBe('/polls?id=2');
    expect(resolveReturn('/polls')).toBe('/polls');
    // Still an allowlist. Anything unrecognised goes Home rather than anywhere
    // it asked for.
    for (const junk of ['https://evil.example/polls?id=2', '/polls?id=2&x=1', '//evil', '/polls?id=abc']) {
      expect(resolveReturn(junk), junk).toBe('/dashboard');
    }
  });
});

/* ── what a published result tells whom ─────────────────────────────────── */

describe('a published result says different things to different people', () => {
  it('sends the committee’s figures to the committee alone', () => {
    // The user was asked directly and chose the narrow answer: a resident sees
    // the count per option and a plain turnout, and nothing about who was
    // barred. Not the names, and not the numbers either — a published "3 flats
    // could not vote" is a statement about the building's arrears posted to the
    // building, and on a small poll it is close to naming them.
    const src = readFileSync(join(root, 'functions', 'lib', 'polls.js'), 'utf8');
    const after = src.slice(src.indexOf('shaped.result = {'));
    const gate = after.indexOf('canManagePoll(poll, viewer)');
    expect(gate, 'the figures must sit behind a canManagePoll gate').toBeGreaterThan(-1);
    for (const field of ['blockedCount', 'exemptCount', 'blockedFlats', 'exemptFlats']) {
      expect(after.indexOf(field), field).toBeGreaterThan(gate);
    }
  });
});
