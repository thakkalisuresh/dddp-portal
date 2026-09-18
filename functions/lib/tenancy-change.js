/**
 * A tenant moving out — what it would do, and doing it.
 *
 * ONE ENGINE, TWO READERS. The dialog an admin fills in and the approval an
 * admin signs must describe the same consequences, and the approver is looking
 * at a snapshot taken minutes or days earlier. So the consequences are computed
 * HERE, on the server, and the browser renders what it is handed. A second copy
 * of this arithmetic in admin-console.js would be a dialog that quietly stopped
 * agreeing with the request it produced.
 *
 * The consequences themselves are `planOccupancyChange` in lib/maint.js — the
 * rule step 5 already wrote and the resident screens already obey. Nothing here
 * decides what a departure costs; it decides which bills to ask about and puts
 * the answers in the order a person reads them.
 */

import {
  planOccupancyChange, isSettled, describeQuarter,
  DEFAULT_OWNER_RATE, DEFAULT_TENANT_RATE,
} from './maint.js';
import { istToday } from './time.js';

/** How long a departure may sit unanswered. Matches the bill-edit queue (0029). */
export const REQUEST_TTL_DAYS = 7;

/**
 * What would happen if this tenant left on this date, with the flat becoming
 * this.
 *
 * Returns lines, not prose. The design brief was explicit that the consequences
 * are a LIST: a paragraph is the part of a dialog that gets skimmed, and this is
 * the part that must not be.
 *
 * @param person   the departing tenant row
 * @param becomes  'owner' | 'tenant' | 'empty'
 * @param bills    that flat's unsettled maintenance bills, newest quarter first
 * @param quarters the maint_quarters ROWS those bills belong to, keyed by label.
 *                 Rows, not labels: `rateFor` reads the rate off the row, because
 *                 a committee revises rates per quarter and last year's bill must
 *                 keep the figure it was actually raised at.
 * @param owner    the owner who would carry the flat afterwards
 * @param rates    the newest quarter row, for the "from next quarter" line. That
 *                 quarter does not exist yet, so its rates are the best statement
 *                 available; the 2026 defaults stand in before the first one.
 */
export function describeDeparture({
  person, becomes, movedOutOn, bills = [], quarters = {}, owner = null,
  rates = null, today = istToday(),
}) {
  const change = becomes === 'tenant' ? 'tenant-to-tenant'
    : becomes === 'empty' ? 'tenant-to-empty' : 'tenant-to-owner';

  const lines = [];
  const plans = [];

  for (const bill of bills) {
    if (isSettled(bill)) continue;
    const label = bill.quarter;
    const row = quarters[label] ?? null;
    // Without the quarter's own row there is no rate to re-rate TO, and
    // planOccupancyChange would fail rather than guess. A bill whose quarter has
    // gone missing is a broken record, not a departure to describe.
    if (!row) continue;
    const plan = planOccupancyChange({
      bill, change, quarter: row, owner,
      movedOutOn, issueDate: row.issue_date ?? null,
    });
    plans.push({ billId: bill.id, quarter: label, ...plan });
    if (plan.action === 're-rate') {
      lines.push({
        kind: 're-rate',
        text: `${describeQuarter(label)} re-rates from ${money(bill.total)} to ${money(plan.total)}`
          + `, because ${person?.name ?? 'the tenant'} had already left when the quarter was issued.`,
      });
      lines.push({
        kind: 'moves',
        text: `That bill moves to ${owner?.name ?? 'the owner'}, who can then see it and pay it.`,
      });
    } else if (plan.action === 'reassign' && plan.reason === 'left-after-issue-date') {
      lines.push({
        kind: 'moves',
        // The rule 0042 states and the one an admin will argue with, so it is
        // said in full rather than asserted.
        text: `${describeQuarter(label)} stays at ${money(bill.total)} — the flat was let on the day it was `
          + `issued, so the rate does not change — and moves to ${owner?.name ?? 'the owner'}.`,
      });
    } else if (plan.action === 'reassign') {
      lines.push({
        kind: 'choose',
        text: `${describeQuarter(label)} (${money(bill.total)}) has to be assigned to somebody: the owner, or the `
          + 'tenant moving in. Nothing decides that on its own, so an admin picks it afterwards.',
      });
    } else if (plan.reason === 'settled') {
      lines.push({ kind: 'none', text: `${describeQuarter(label)} is already paid and is not touched.` });
    }
  }

  if (!plans.length) {
    lines.push({ kind: 'none', text: 'There is no unpaid maintenance bill on this flat to move.' });
  }

  // The next quarter, which is the consequence an admin forgets and the one the
  // association feels: the rented rate stops applying and ₹1,500 a quarter goes
  // with it. Stated whatever the bills say, because it is true whatever they say.
  if (becomes !== 'tenant') {
    lines.push({
      kind: 'future',
      text: 'From the next quarter this flat is billed at the owner rate, '
        + `${money(rates?.owner_rate ?? DEFAULT_OWNER_RATE)} instead of `
        + `${money(rates?.tenant_rate ?? DEFAULT_TENANT_RATE)}.`,
    });
  }

  lines.push({
    kind: 'letters',
    text: `${person?.name ?? 'They'} stops receiving the maintenance letters and reminders; `
      + `they go to ${owner?.name ?? 'the owner'} instead.`,
  });

  lines.push({
    kind: 'login',
    // Said in the dialog rather than discovered afterwards. Taking somebody's
    // login is the part of this an admin does not picture when they tap.
    text: `${person?.name ?? 'They'} loses their login when this is approved — not now.`,
  });

  return {
    change,
    movedOutOn,
    becomes,
    plans,
    lines,
    expiresAt: new Date(Date.parse(`${today}T00:00:00Z`) + REQUEST_TTL_DAYS * 86400000)
      .toISOString().slice(0, 10),
  };
}

/** Whole rupees with the symbol, as every maintenance figure is written. */
function money(n) {
  return `₹${Math.round(Number(n ?? 0)).toLocaleString('en-IN')}`;
}

/**
 * Everything describeDeparture needs about one flat, in one round trip.
 *
 * Unsettled bills only: a paid quarter is closed (planOccupancyChange refuses to
 * reopen it) and loading it would only produce a line saying so on every dialog.
 */
export async function departureInputs(env, personId) {
  const person = await env.DB.prepare(
    `SELECT id, flat, name, relationship, active, moved_in_at, moved_out_at, lease_ends_at
       FROM owners WHERE id = ?`
  ).bind(personId).first();
  if (!person) return null;

  const [bills, owner] = await Promise.all([
    env.DB.prepare(
      // THE BILLS THIS PERSON CARRIES, not the flat's. `owner_id` is who a
      // maintenance bill is raised against (0042) and it is also what scopes
      // who can see it, so it is the only correct reading of "which bills does
      // this departure move".
      //
      // Scoping by flat instead said, on the first render of this dialog, that
      // the OWNER's own ₹7,000 bill would "move to Rajan Pillai" — who had been
      // holding it all along. An approver reading that has been handed a
      // consequence that is not one, on a screen whose whole purpose is to say
      // exactly what they are agreeing to.
      `SELECT id, flat, quarter, owner_id, rate_applied, basis, total, status
         FROM maint_bills
        WHERE flat = ? AND owner_id = ? AND status NOT IN ('paid','waived','cancelled')
        ORDER BY quarter DESC`
    ).bind(person.flat, person.id).all(),
    // The owner who would carry the flat: lowest id, matching ownerOn in
    // lib/maint.js and occupantOf in lib/tenancy.js. An unordered SELECT would
    // move a jointly owned flat's bill between people from one quarter to the
    // next, which is exactly the kind of drift nobody can explain afterwards.
    env.DB.prepare(
      `SELECT id, name, email FROM owners
        WHERE flat = ? AND relationship = 'owner' AND active = 1
        ORDER BY id LIMIT 1`
    ).bind(person.flat).first(),
  ]);

  const rows = bills.results ?? [];
  const labels = [...new Set(rows.map((b) => b.quarter))];
  const quarters = {};
  for (const label of labels) {
    const q = await env.DB.prepare(
      'SELECT quarter, issue_date, owner_rate, tenant_rate FROM maint_quarters WHERE quarter = ?'
    ).bind(label).first();
    if (q) quarters[label] = q;
  }

  // The newest quarter on record, whatever its status: the "from next quarter"
  // line is about a quarter that does not exist yet, and the committee's most
  // recent figures are the best statement anybody can make about it.
  const rates = await env.DB.prepare(
    'SELECT quarter, owner_rate, tenant_rate FROM maint_quarters ORDER BY quarter DESC LIMIT 1'
  ).first();

  return { person, bills: rows, quarters, owner: owner ?? null, rates: rates ?? null };
}
