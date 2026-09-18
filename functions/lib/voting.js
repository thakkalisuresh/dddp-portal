/**
 * Who may vote, read from the database.
 *
 * ONE RULE, `flatVotingStatus` in lib/maint.js, and this is the only place that
 * fetches what it needs. The resident's home page, the admin directory, the
 * poll card and the vote endpoint all arrive here, so none of them can drift
 * into a second opinion about who is barred — which would be visible to
 * residents as a portal that shows them a ballot and then refuses it.
 *
 * DELIBERATELY NOT CLEVER SQL. "The quarter has ended, unless an approval is in
 * flight, unless the committee granted an exemption" could be expressed in a
 * WHERE clause, and the moment that clause drifts from the pure function the
 * screens and the endpoint disagree. Two flat queries, then the rule applied in
 * JavaScript by the function that owns it.
 */

import { flatVotingStatus } from './maint.js';
import { istToday } from './time.js';

/** Every unsettled maintenance bill, with the approval flag the rule reads. */
const OPEN_BILLS_SQL =
  `SELECT b.id, b.flat, b.quarter, b.total, b.status,
          EXISTS (SELECT 1 FROM maint_approval_requests r
                   WHERE r.bill_id = b.id AND r.status = 'pending') AS pending_approval
     FROM maint_bills b
    WHERE b.status NOT IN ('paid','waived','cancelled')`;

/**
 * The voting status of every flat that has anything to say about it.
 *
 * @param pollCreatedAt the date the question is asked AS OF. A poll asks it
 *        against its own creation, because a quarter that had not ended when
 *        the poll opened must not start blocking halfway through the vote.
 */
export async function votingStatuses(env, { pollCreatedAt = null, today = istToday() } = {}) {
  const asOf = pollCreatedAt ? String(pollCreatedAt).slice(0, 10) : today;

  const [bills, exemptions] = await Promise.all([
    env.DB.prepare(OPEN_BILLS_SQL).all(),
    env.DB.prepare('SELECT flat, reason, ends_at, approved_by FROM voting_exemptions').all(),
  ]);

  const byFlat = new Map();
  for (const bill of bills.results ?? []) {
    if (!byFlat.has(bill.flat)) byFlat.set(bill.flat, []);
    byFlat.get(bill.flat).push(bill);
  }
  const exemptFor = new Map((exemptions.results ?? []).map((e) => [e.flat, e]));

  const out = new Map();
  // Every flat that owes something OR holds an exemption. A flat in neither set
  // is clear, and saying so for ninety-nine of them would be a map nobody reads.
  for (const flat of new Set([...byFlat.keys(), ...exemptFor.keys()])) {
    out.set(flat, flatVotingStatus({
      bills: byFlat.get(flat) ?? [],
      pollCreatedAt: asOf,
      exemption: exemptFor.get(flat) ?? null,
      today,
    }));
  }
  return out;
}

/** One flat's status. Clear unless the map says otherwise. */
export async function votingStatusFor(env, flat, opts = {}) {
  const all = await votingStatuses(env, opts);
  return all.get(flat) ?? { canVote: true, reason: 'clear', owed: 0, quarters: [], billIds: [] };
}

/** The flats that cannot vote, for the screens that only need the names. */
export async function votingBlockedFlats(env, opts = {}) {
  const all = await votingStatuses(env, opts);
  return new Set([...all].filter(([, s]) => !s.canVote).map(([flat]) => flat));
}
