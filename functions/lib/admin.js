/**
 * Admin billing: the reading grid, and generation.
 *
 * Remember the labelling (plan §3a): the treasurer walks the building in JULY
 * and enters JUNE's readings. Everything here is keyed by the usage month.
 */

import {
  computeBill, computeConsumption, previewGeneration, meterDeltaAcrossChange,
  assertRateSetForPeriod, rateSanity, DEFAULT_CONVERSION,
} from './billing.js';
import { fail } from './errors.js';
import { occupantOf } from './tenancy.js';

/** '2026-06' -> '2026-07' */
export function nextPeriod(period) {
  const [y, m] = period.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** '2026-06' -> '2026-05' */
export function previousPeriod(period) {
  const [y, m] = period.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** The month the meter is read in — one after the usage month it closes. */
export function readMonthFor(period) {
  return nextPeriod(period);
}

/**
 * Flat -> the person billed for it, decided ONCE for the whole grid.
 *
 * Pure, and separate from the query, because this is the decision that ends up
 * in `bills.owner_id`. Every row for a flat goes to `occupantOf`, which filters
 * on `active` itself and picks the tenant over the owner — never re-derived
 * from `relationship` at the call site (docs/RESIDENTS-OCCUPANCY.md).
 */
export function occupantsByFlat(people) {
  const byFlat = new Map();
  for (const p of people ?? []) {
    if (!byFlat.has(p.flat)) byFlat.set(p.flat, []);
    byFlat.get(p.flat).push(p);
  }
  const out = new Map();
  for (const [flat, rows] of byFlat) {
    const occupant = occupantOf(rows);
    if (occupant) out.set(flat, occupant);
  }
  return out;
}

/**
 * Every active flat, with last month's reading and this month's if entered.
 * Flats without a reading are still returned — a missing flat must be visible,
 * because a partial month silently never bills someone.
 */
export async function readingGrid(env, period) {
  const prev = previousPeriod(period);

  const [periodRow, rows, excludedRows, peopleRows] = await Promise.all([
    env.DB.prepare('SELECT * FROM periods WHERE period = ?').bind(period).first(),
    env.DB.prepare(
      // mc is joined here rather than fetched separately because every consumer
      // of this grid — the screen, the preview and generation — has to agree
      // about which flats had their meter swapped this month. A second query
      // somewhere else is how the grid shows one number and the bill says
      // another.
      // The resident is NOT joined here. A flat can have several rows in
      // `owners` — an absent owner and their tenant both — and a LEFT JOIN
      // with GROUP BY returns whichever one SQLite reaches first. That was
      // fine while the column was only a label on a screen; it is not fine now
      // that generation binds the same person as `bills.owner_id`, because the
      // wrong pick attaches the bill to the landlord instead of the tenant.
      // occupantOf decides, off the full set of rows — see occupantsByFlat.
      `SELECT f.flat, f.floor,
              cur.reading  AS reading,
              cur.read_on  AS read_on,
              prv.reading  AS previous,
              mc.old_final AS mc_old_final,
              mc.new_start AS mc_new_start,
              mc.changed_on AS mc_changed_on,
              mc.note      AS mc_note
         FROM flats f
         LEFT JOIN readings cur ON cur.flat = f.flat AND cur.period = ?
         LEFT JOIN readings prv ON prv.flat = f.flat AND prv.period = ?
         LEFT JOIN meter_changes mc ON mc.flat = f.flat AND mc.period = ?
        WHERE f.active = 1
        GROUP BY f.flat
        ORDER BY f.floor, f.flat`
    ).bind(period, prev, period).all(),
    // Excluded flats come back too, or they become invisible: the grid filters
    // them out, so without this list there is no screen anywhere that admits
    // they exist, and no way to put one back.
    env.DB.prepare(
      `SELECT f.flat, f.floor
         FROM flats f
        WHERE f.active = 0
        ORDER BY f.floor, f.flat`
    ).all(),
    // Every owners row, active and inactive both, because that is what
    // occupantOf expects to be handed (docs/RESIDENTS-OCCUPANCY.md).
    env.DB.prepare(
      'SELECT id, flat, name, relationship, active FROM owners'
    ).all(),
  ]);

  const occupants = occupantsByFlat(peopleRows.results ?? []);

  const factor = periodRow?.conversion_factor ?? DEFAULT_CONVERSION;

  const flats = (rows.results ?? []).map((r) => {
    // The changeover, if this flat had one this month. Reshaped off the mc_
    // columns so nothing downstream has to know how the join was spelled.
    const meterChange = r.mc_old_final == null ? null : {
      old_final: r.mc_old_final,
      new_start: r.mc_new_start ?? 0,
      changed_on: r.mc_changed_on,
      note: r.mc_note,
    };

    let consumption = null;
    let problem = null;
    if (r.reading != null && r.previous != null) {
      try {
        consumption = computeConsumption(r.reading, r.previous, factor, meterChange);
      } catch (err) {
        problem = err.code === 'DDP-BILL-002' ? 'below-previous'
                : err.code === 'DDP-BILL-014' ? 'meter-change-inconsistent'
                : 'invalid';
      }
    } else if (r.reading != null && r.previous == null) {
      problem = 'no-previous';
    }

    const { mc_old_final, mc_new_start, mc_changed_on, mc_note, ...rest } = r;
    // `resident` and `residentId` are the same decision, made once. Generation
    // binds residentId as the bill's owner_id, so a screen that named someone
    // else would be describing a bill that belongs to a different person.
    const occupant = occupants.get(r.flat) ?? null;
    return {
      ...rest,
      resident: occupant?.name ?? null,
      residentId: occupant?.id ?? null,
      meterChange,
      consumption,
      problem,
    };
  });

  return {
    period,
    readMonth: readMonthFor(period),
    rate: periodRow?.rate_per_kg ?? null,
    rateInherited: false,
    conversionFactor: factor,
    dueDate: periodRow?.due_date ?? null,
    lateFee: periodRow?.late_fee ?? 0,
    status: periodRow?.status ?? null,
    entered: flats.filter((f) => f.reading != null).length,
    // `total` is what generation compares against (expectedFlats), so excluding
    // a flat lowers the bar as well as hiding the row. That is the whole point:
    // "every flat or nothing" becomes "every flat still being billed, or
    // nothing", and a month with unsold flats in it can close.
    total: flats.length,
    flats,
    excluded: (excludedRows.results ?? []).map((f) => ({
      ...f, resident: occupants.get(f.flat)?.name ?? null,
    })),
  };
}

// jumpWarning moved to billing.js so previewGeneration can call it — the
// confirmation screen has to name the same outliers the grid flagged, and
// billing.js cannot import this module without a cycle. Re-exported because
// index.js and the tests already take it from here.
export { JUMP_MULTIPLE, jumpWarning, dropWarning } from './billing.js';

/**
 * Generation. Refuses on a locked period, an inherited or absent rate, any
 * blocked row, or a partial month — a missing flat means someone silently
 * never gets billed, which is worse than a loud failure.
 *
 * Writes as one D1 batch so a half-generated month cannot exist.
 *
 * `extraStatements` ride in THAT SAME BATCH, after the inserts and the lock.
 * It exists for the announcement outbox: a month that was generated but not
 * queued would look published on every screen and tell nobody, and there is no
 * second pass anywhere that would notice. Anything passed here must be able to
 * see the bills — they are inserted first, and SQLite runs a batch in order —
 * and must not need their ids on this side of the wire, because the ids do not
 * exist yet. See queueStatement in announce.js, which is INSERT…SELECT for
 * exactly that reason.
 */
export async function generateBills(env, period, actorId, { extraStatements = [] } = {}) {
  const periodRow = await env.DB.prepare('SELECT * FROM periods WHERE period = ?').bind(period).first();
  if (!periodRow) fail('DDP-BILL-005', { period });
  if (periodRow.status === 'locked') fail('DDP-BILL-007', { period });
  assertRateSetForPeriod(periodRow);

  const existing = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM bills WHERE period = ?'
  ).bind(period).first();
  if ((existing?.n ?? 0) > 0) fail('DDP-BILL-006', { period, existing: existing.n });

  const grid = await readingGrid(env, period);
  const rows = grid.flats
    .filter((f) => f.reading != null && f.previous != null)
    .map((f) => ({
      flat: f.flat, reading: f.reading, previous: f.previous, meterChange: f.meterChange,
      ownerId: f.residentId,
    }));

  /**
   * A flat with a reading and nobody to bill. Refused rather than written with
   * a NULL owner_id: dashboard.js matches `(owner_id IS NULL OR owner_id = ?)`,
   * so an unattached bill is readable by whoever occupies the flat next — the
   * privacy hole migration 0003 closed. This is the FLAT-BILLED-NO-OWNER state
   * diagnostics warns about, which normally blocks the month earlier (no owner
   * means no meter walk means no reading, and generation refuses a partial
   * month). Somebody entering the reading anyway is the case this catches.
   */
  const unattached = rows.filter((r) => r.ownerId == null).map((r) => r.flat);
  if (unattached.length) fail('DDP-BILL-015', { period, flats: unattached });

  const preview = previewGeneration({
    rows,
    ratePerKg: periodRow.rate_per_kg,
    conversionFactor: periodRow.conversion_factor,
    previousRate: (await env.DB.prepare('SELECT rate_per_kg FROM periods WHERE period = ?')
      .bind(previousPeriod(period)).first())?.rate_per_kg ?? null,
    expectedFlats: grid.total,
  });

  if (!preview.canGenerate) {
    fail('DDP-BILL-001', {
      period, blocked: preview.blocked, missing: preview.missing, rate: preview.rateSanity,
    });
  }

  const now = new Date().toISOString();
  const statements = rows.map((r) => {
    const consumption = computeConsumption(
      r.reading, r.previous, periodRow.conversion_factor, r.meterChange);
    const { gasAmount, total } = computeBill({
      consumption, ratePerKg: periodRow.rate_per_kg,
    });
    // meter_delta is the gas that moved, which across a swap is the sum of both
    // segments. Subtracting the raw readings would store a NEGATIVE delta beside
    // a positive consumption — the stored bill would contradict itself, and
    // DDP-BILL-003 exists to shout about exactly that kind of mismatch.
    const delta = r.meterChange
      ? meterDeltaAcrossChange(r.reading, r.previous, r.meterChange)
      : Math.round((r.reading - r.previous) * 1000) / 1000;
    return env.DB.prepare(
      `INSERT INTO bills (flat, period, owner_id, meter_delta, consumption, conversion_factor,
                          rate_per_kg, gas_amount, total, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?)`
    ).bind(r.flat, period, r.ownerId, delta, consumption, periodRow.conversion_factor,
           periodRow.rate_per_kg, gasAmount, total, now);
  });

  statements.push(
    env.DB.prepare("UPDATE periods SET status = 'locked' WHERE period = ?").bind(period)
  );
  statements.push(...extraStatements);

  await env.DB.batch(statements);

  return { period, generated: rows.length, totalAmount: preview.totalAmount, totalKg: preview.totalKg };
}

/**
 * Open a period. The rate is required here and never copied from last month
 * — see DDP-BILL-010; an inherited rate is the quietest catastrophe available.
 */
export async function openPeriod(env, { period, ratePerKg, dueDate, lateFee = 0,
                                        conversionFactor = DEFAULT_CONVERSION }) {
  const prev = await env.DB.prepare('SELECT rate_per_kg FROM periods WHERE period = ?')
    .bind(previousPeriod(period)).first();
  const sanity = rateSanity(ratePerKg, prev?.rate_per_kg ?? null);
  if (!sanity.ok) fail('DDP-BILL-005', { ratePerKg });

  await env.DB.prepare(
    `INSERT INTO periods (period, rate_per_kg, conversion_factor, due_date, late_fee,
                          late_fee_after, status, created_at)
     VALUES (?, ?, ?, ?, ?, 0, 'open', ?)`
  ).bind(period, ratePerKg, conversionFactor, dueDate, lateFee, new Date().toISOString()).run();

  return { period, ratePerKg, sanity };
}

/**
 * What changing a month's rate would do to the bills already in it.
 *
 * Pure, so the consequence can be shown before it happens and asserted in a
 * test. `bills.rate_per_kg` is a snapshot rather than a join — a bill keeps the
 * rate it was generated with — so nothing recalculates by itself. This is the
 * deliberate act that rewrites them.
 *
 * The uncomfortable part is stated plainly rather than hidden: a resident who
 * already paid, against a bill that just got dearer, now owes the difference.
 * That is the caveat the screen shows before anything is written.
 */
export function planRateChange(bills, { ratePerKg, conversionFactor = DEFAULT_CONVERSION }) {
  if (!Number.isFinite(ratePerKg) || ratePerKg <= 0) fail('DDP-BILL-005', { ratePerKg });

  const changes = [];
  const skipped = [];

  for (const bill of bills) {
    // A manual total was somebody's considered decision, usually a goodwill
    // figure with a written reason attached. Recomputing would discard it
    // silently, so it is listed instead of overwritten.
    if (bill.manual_total) {
      skipped.push({ flat: bill.flat, billId: bill.id, total: bill.total, why: 'manually adjusted' });
      continue;
    }

    const consumption = bill.consumption;
    const { gasAmount, total } = computeBill({
      consumption,
      ratePerKg,
      otherCharges: bill.other_charges ?? 0,
      additionalCharges: bill.additional_charges ?? 0,
      lateFee: bill.late_fee ?? 0,
    });
    if (total === bill.total && gasAmount === bill.gas_amount) continue;

    const settled = bill.status === 'paid' || bill.status === 'waived';
    changes.push({
      billId: bill.id, flat: bill.flat, status: bill.status,
      was: bill.total, now: total, gasAmount,
      difference: Math.round((total - bill.total) * 100) / 100,
      // Only a settled bill that got DEARER creates a new debt. One that got
      // cheaper leaves the resident in credit, which is not the same problem
      // and must not be dressed up as one.
      owesAgain: settled && total > bill.total,
      inCredit: settled && total < bill.total,
    });
  }

  const sum = (list, key) => Math.round(list.reduce((t, c) => t + c[key], 0) * 100) / 100;
  const owesAgain = changes.filter((c) => c.owesAgain);
  const inCredit = changes.filter((c) => c.inCredit);

  return {
    changes,
    skipped,
    totals: {
      billsAffected: changes.length,
      skipped: skipped.length,
      owesAgainCount: owesAgain.length,
      owesAgainTotal: sum(owesAgain, 'difference'),
      inCreditCount: inCredit.length,
      inCreditTotal: Math.abs(sum(inCredit, 'difference')),
      netDifference: sum(changes, 'difference'),
    },
  };
}

/**
 * Change the rate on a month, recalculating the bills already in it.
 *
 * A LOCKED month is refused here rather than in the interface, because the
 * interface is not the only caller. Reopening one means every bill recalculated,
 * residents who already paid asked to pay again, and a month that was reconciled
 * needing to be reconciled afresh — a decision that belongs to nobody holding
 * the treasurer's login alone.
 *
 * `allowLocked` is the door that two other admins buy, and it has exactly one
 * caller: applyPriceCorrection, on the last approval of a request the committee
 * agreed to. It is not a flag any route accepts and no request body can reach
 * it. Everything else meets DDP-BILL-012 as it always has — including the
 * treasurer, including the superadmin, including this function called by hand.
 */
export async function changeRate(env, { period, ratePerKg, reason, actorId,
                                        dryRun = false, allowLocked = false }) {
  const periodRow = await env.DB.prepare('SELECT * FROM periods WHERE period = ?').bind(period).first();
  if (!periodRow) fail('DDP-BILL-005', { period });
  if (periodRow.status === 'locked' && !allowLocked) fail('DDP-BILL-012', { period, ratePerKg });

  const text = String(reason ?? '').trim();
  if (text.length < 3) fail('DDP-ADMIN-011', { field: 'rate_per_kg' });

  const rows = await env.DB.prepare(
    `SELECT id, flat, consumption, gas_amount, other_charges, additional_charges,
            late_fee, total, status, manual_total
       FROM bills WHERE period = ?`
  ).bind(period).all();
  const bills = rows.results ?? [];

  const plan = planRateChange(bills, {
    ratePerKg, conversionFactor: periodRow.conversion_factor,
  });
  const sanity = rateSanity(ratePerKg, periodRow.rate_per_kg);

  if (dryRun) {
    return { period, from: periodRow.rate_per_kg, to: ratePerKg, sanity, dryRun: true, ...plan };
  }

  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare('UPDATE periods SET rate_per_kg = ? WHERE period = ?').bind(ratePerKg, period),
  ];
  for (const c of plan.changes) {
    statements.push(env.DB.prepare(
      // A settled bill that grew is returned to 'unpaid' so it is chased like
      // any other. `late_fee_at` is untouched on purpose: it is the late-fee
      // cron's idempotency guard, so a bill that has already been charged one
      // will not be charged a second time for a debt we created.
      c.owesAgain
        ? `UPDATE bills SET rate_per_kg = ?, gas_amount = ?, total = ?, status = 'unpaid', paid_at = NULL WHERE id = ?`
        : `UPDATE bills SET rate_per_kg = ?, gas_amount = ?, total = ? WHERE id = ?`
    ).bind(ratePerKg, c.gasAmount, c.now, c.billId));
  }
  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }

  return { period, from: periodRow.rate_per_kg, to: ratePerKg, sanity,
           reason: text, actorId, changedAt: now, dryRun: false, ...plan };
}

/** Draft saves from the grid or a bulk import. Never generates. */
export async function saveReadings(env, period, entries, actorId) {
  const periodRow = await env.DB.prepare('SELECT status FROM periods WHERE period = ?')
    .bind(period).first();
  if (!periodRow) fail('DDP-BILL-005', { period });
  if (periodRow.status === 'locked') fail('DDP-BILL-007', { period });

  const now = new Date().toISOString();
  const readOn = `${readMonthFor(period)}-02`;
  const valid = entries.filter((e) => e.flat && Number.isFinite(Number(e.reading)));

  if (!valid.length) return { saved: 0, skipped: entries.length };

  await env.DB.batch(valid.map((e) =>
    env.DB.prepare(
      `INSERT INTO readings (flat, period, reading, read_on, entered_by, entered_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (flat, period) DO UPDATE SET
         reading = excluded.reading, entered_by = excluded.entered_by, entered_at = excluded.entered_at`
    ).bind(e.flat, period, Number(e.reading), readOn, actorId, now)
  ));

  return { saved: valid.length, skipped: entries.length - valid.length };
}

/**
 * Which columns a header row names, or null when the first line is data.
 *
 * THE BUG THIS EXISTS FOR. `downloadTemplate` hands out
 * `flat,floor,previous,reading` and its docstring promises "column order is
 * guaranteed on the way back" — and the way back did not honour it. The
 * heuristic below reads everything before the last number as the flat, so a
 * filled-in template row `4A,4,5.817,6.900` asked for a flat called
 * "4A 4 5.817" and every single row failed as unknown-flat. The app's own
 * export could not be imported by the app. Found on 2026-08-12 while adding
 * file upload, by round-tripping the template rather than reading the code.
 *
 * Recognised only when the line names BOTH columns and carries no number of
 * its own, so a data row is never mistaken for a header.
 */
function headerColumns(line) {
  const cells = line.split(/[\t,;]/).map((c) => normaliseFlat(c));
  if (cells.some((c) => /^\d+(\.\d+)?$/.test(c))) return null;
  const flat = cells.indexOf('FLAT');
  const reading = cells.indexOf('READING');
  if (flat === -1 || reading === -1) return null;
  return { flat, reading };
}

/**
 * Parse pasted or uploaded readings. Returns a DRAFT — never writes.
 * Unrecognised flats surface as errors rather than being silently dropped.
 *
 * Two shapes, and the header decides which. With a header the columns are read
 * BY NAME, which is what makes the template round-trip and what lets a
 * spreadsheet carry extra columns in any order. Without one, the original
 * heuristic still applies, because "4A 5.817" pasted out of a WhatsApp message
 * has no header and is how this was always used.
 */
export function parseReadings(text, knownFlats) {
  const known = new Map(knownFlats.map((f) => [normaliseFlat(f), f]));
  const rows = [];
  const errors = [];
  const seen = new Set();

  const lines = String(text).split(/\r?\n/);
  const firstData = lines.findIndex((l) => l.trim() !== '');
  const columns = firstData === -1 ? null : headerColumns(lines[firstData].trim());

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    // The header itself is not an error. It used to be reported as
    // "not-a-number", so every template import opened with a failure the
    // treasurer had to decide to ignore.
    if (columns && index === firstData) continue;

    if (columns) {
      // Split WITHOUT collapsing, so an empty cell keeps its position and
      // column 3 is still column 3 on a row whose reading has not been taken.
      const cells = line.split(/[\t,;]/).map((c) => c.trim());
      const label = cells[columns.flat] ?? '';
      const value = cells[columns.reading] ?? '';
      // A blank reading is a flat not yet read, not a bad row. The grid shows
      // it as still empty, which is exactly what it is.
      if (value === '') continue;
      if (!/^\d+(\.\d+)?$/.test(value)) {
        errors.push({ line, flat: label, reason: 'not-a-number' });
        continue;
      }
      const key = normaliseFlat(label);
      if (!known.has(key)) { errors.push({ line, flat: label, reason: 'unknown-flat' }); continue; }
      if (seen.has(key)) { errors.push({ line, flat: label, reason: 'duplicate' }); continue; }
      seen.add(key);
      rows.push({ flat: known.get(key), reading: Number(value) });
      continue;
    }

    const parts = line.split(/[\t,;]+|\s+/).filter(Boolean);
    if (parts.length < 2) { errors.push({ line, reason: 'malformed' }); continue; }

    // Take the LAST purely-numeric token as the reading, not simply the last
    // token: "4A  5.817 m3" ends in a unit, and stripping non-digits from that
    // would turn "m3" into 3. Everything before it is the flat, so "4 A" and
    // "4-A" survive too.
    let idx = -1;
    for (let i = parts.length - 1; i >= 1; i--) {
      if (/^\d+(\.\d+)?$/.test(parts[i])) { idx = i; break; }
    }
    if (idx < 1) { errors.push({ line, flat: parts[0], reason: 'not-a-number' }); continue; }

    const reading = Number(parts[idx]);
    const label = parts.slice(0, idx).join(' ');
    const key = normaliseFlat(label);

    if (!known.has(key)) { errors.push({ line, flat: label, reason: 'unknown-flat' }); continue; }
    if (seen.has(key)) { errors.push({ line, flat: label, reason: 'duplicate' }); continue; }

    seen.add(key);
    rows.push({ flat: known.get(key), reading });
  }

  return { rows, errors };
}

export function normaliseFlat(value) {
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}
